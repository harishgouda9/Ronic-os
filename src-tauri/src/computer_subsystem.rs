//! The 3-pillar computer-use subsystem.
//!
//! Pillar 1 — per-bot separate mini windows: every bot gets its own floating
//! PiP `WebviewWindow` with an isolated on-disk browser profile, a virtual
//! cursor HUD, and synthetic DOM driving inside that window only. The user's
//! physical mouse and keyboard are never touched.
//!
//! Pillar 2 — native OS UIAutomation driver: walks the Windows control-view
//! tree and triggers buttons (`InvokePattern`) / fills inputs
//! (`ValuePattern`) in the background. Nothing here moves the OS cursor;
//! the coordinate fallback posts `WM_LBUTTONDOWN` straight to the target
//! window instead of synthesizing global input.
//!
//! Pillar 3 — Set-of-Marks vision overlay: captures the target window buffer,
//! fuses UIA bounding rectangles onto it, stamps high-contrast numbered badges
//! in Rust, and keeps an exact `mark_id -> pixel center` registry so a vision
//! model can ground a click by number.

use crate::error::{err, Result};
use crate::util::safe_id_component;
use crate::workspace_apps::WebAppBounds;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Webview, WebviewBuilder, WebviewUrl, WebviewWindowBuilder};

// ---------------------------------------------------------------------------
// Shared state — plain statics so both Tauri commands and Code Mode (which
// only receives a DB connection) can reach the same registries.
// ---------------------------------------------------------------------------

static SOM_MARKS: OnceLock<Mutex<HashMap<u32, UIAControlNode>>> = OnceLock::new();
static MINI_WINDOWS: OnceLock<Mutex<HashMap<String, BotMiniWindowInstance>>> = OnceLock::new();
static SHELL_STATES: OnceLock<Mutex<HashMap<String, ShellState>>> = OnceLock::new();
static EXPANDED_MINI_WINDOWS: OnceLock<Mutex<HashMap<String, bool>>> = OnceLock::new();
static LAST_UIA_FILTER: Mutex<String> = Mutex::new(String::new());
static EMERGENCY_HALT: AtomicBool = AtomicBool::new(false);

fn som_marks() -> MutexGuard<'static, HashMap<u32, UIAControlNode>> {
    SOM_MARKS.get_or_init(|| Mutex::new(HashMap::new())).lock().unwrap_or_else(|poison| poison.into_inner())
}

fn mini_windows() -> MutexGuard<'static, HashMap<String, BotMiniWindowInstance>> {
    MINI_WINDOWS.get_or_init(|| Mutex::new(HashMap::new())).lock().unwrap_or_else(|poison| poison.into_inner())
}

fn shell_states() -> MutexGuard<'static, HashMap<String, ShellState>> {
    SHELL_STATES.get_or_init(|| Mutex::new(HashMap::new())).lock().unwrap_or_else(|poison| poison.into_inner())
}

pub fn mini_is_expanded(app: &AppHandle, bot_id: &str) -> bool {
    app.get_window(&mini_label(bot_id).unwrap_or_default()).is_some()
        && EXPANDED_MINI_WINDOWS.get_or_init(|| Mutex::new(HashMap::new())).lock().unwrap_or_else(|poison| poison.into_inner()).get(bot_id.trim()).copied().unwrap_or(true)
}

fn mark_mini_expanded(bot_id: &str, expanded: bool) {
    EXPANDED_MINI_WINDOWS.get_or_init(|| Mutex::new(HashMap::new())).lock().unwrap_or_else(|poison| poison.into_inner()).insert(bot_id.trim().to_string(), expanded);
}

#[cfg(windows)]
fn reparent_chrome(app: &AppHandle, bot_id: &str, expanded: bool) -> Result<()> {
    let Some(chrome) = app.get_webview(&chrome_label(bot_id)?) else { return Ok(()) };
    let parent_label = if expanded { mini_label(bot_id)? } else { "main".to_string() };
    let app_clone = app.clone();
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    chrome.with_webview(move |view: tauri::webview::PlatformWebview| {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{SetParent, SetWindowPos, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOZORDER};
        // Re-fetch the parent window inside the closure to avoid capturing HWND (not Send)
        let parent = match app_clone.get_window(&parent_label) {
            Some(p) => p,
            None => { let _ = tx.send(Err(err("parent window not found"))); return; }
        };
        let parent_hwnd = match parent.hwnd() {
            Ok(h) => h,
            Err(e) => { let _ = tx.send(Err(err(e.to_string()))); return; }
        };
        let result = unsafe {
            let mut container = HWND::default();
            view.controller().ParentWindow(&mut container).map_err(|error| err(error.to_string())).and_then(|_| {
                SetParent(container, Some(parent_hwnd)).map_err(|error| err(error.to_string()))?;
                view.controller().SetParentWindow(parent_hwnd).map_err(|error| err(error.to_string()))?;
                SetWindowPos(container, None, 0, 0, 0, 0, SWP_FRAMECHANGED | SWP_NOACTIVATE | SWP_NOZORDER).map_err(|error| err(error.to_string()))
            })
        };
        let _ = tx.send(result);
    }).map_err(|error| err(error.to_string()))?;
    rx.recv().map_err(|_| err("the browser could not change screens"))?.map_err(|e| err(e.0))?;
    mark_mini_expanded(bot_id, expanded);
    Ok(())
}

#[cfg(not(windows))]
fn reparent_chrome(_app: &AppHandle, _bot_id: &str, _expanded: bool) -> Result<()> {
    Err(err("moving a bot computer between screens is currently supported on Windows"))
}

fn last_uia_filter() -> MutexGuard<'static, String> {
    LAST_UIA_FILTER.lock().unwrap_or_else(|poison| poison.into_inner())
}

fn clip80(text: &str) -> String {
    text.chars().take(80).collect()
}

fn fold_name(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

/// Exact name, or the clipped 80-character prefix the registry stored.
fn uia_value_matches(actual: &str, requested: &str) -> bool {
    actual.replace("\r\n", "\n") == requested.replace("\r\n", "\n")
}

fn names_match(stored: &str, live: &str) -> bool {
    let stored_folded = fold_name(stored);
    let live_folded = fold_name(live);
    if stored_folded.is_empty() || live_folded.is_empty() {
        return false;
    }
    if stored_folded == live_folded {
        return true;
    }
    // clip80 keeps the first 80 characters, so that stored name is a prefix of the live one.
    stored.chars().count() >= 80 && live_folded.starts_with(&stored_folded)
}

fn pick_mark(nodes: &[UIAControlNode], query: &str) -> std::result::Result<u32, String> {
    let wanted = fold_name(query);
    if wanted.is_empty() {
        return Err("name the desktop control to use".into());
    }
    let mut best: Vec<(u32, String)> = Vec::new();
    let mut top = 0i32;
    for node in nodes {
        if node.origin == "simulated" {
            continue;
        }
        let name = fold_name(&node.name);
        if name.is_empty() {
            continue;
        }
        let score = if name == wanted {
            100
        } else if name.split(' ').any(|word| word == wanted) {
            80
        } else if name.contains(&wanted) {
            50
        } else {
            0
        };
        if score == 0 {
            continue;
        }
        if score > top {
            top = score;
            best.clear();
        }
        if score == top {
            best.push((node.mark_id, node.name.clone()));
        }
    }
    if best.is_empty() {
        return Err(format!("no desktop control matching '{query}'. Inspect the window first."));
    }
    if best.len() > 1 {
        let names = best.iter().map(|(id, name)| format!("#{id} {name}")).collect::<Vec<_>>().join(", ");
        return Err(format!("more than one control matches '{query}': {names}. Pass its mark id."));
    }
    Ok(best[0].0)
}

fn json_u32(value: &serde_json::Value) -> Option<u32> {
    value.as_u64().and_then(|n| u32::try_from(n).ok()).or_else(|| value.as_str().and_then(|text| text.trim().parse().ok()))
}

/// Mark number, or the cached live control named by match / name / query.
/// Never guesses mark 1.
pub fn resolve_desktop_mark(args: &serde_json::Value) -> std::result::Result<u32, String> {
    const ID_KEYS: [&str; 4] = ["mark_id", "markId", "mark", "id"];
    for key in ID_KEYS {
        if let Some(id) = args.get(key).and_then(json_u32) {
            if id == 0 {
                return Err("mark id 0 is not a control. Inspect the window and use the mark number it returned.".into());
            }
            return Ok(id);
        }
    }
    let mut query = String::new();
    for key in ["match", "name", "query"] {
        if let Some(text) = args.get(key).and_then(|value| value.as_str()) {
            let text = text.trim();
            if !text.is_empty() {
                query = text.to_string();
                break;
            }
        }
    }
    if query.is_empty() {
        for key in ID_KEYS {
            if let Some(text) = args.get(key).and_then(|value| value.as_str()) {
                let text = text.trim();
                if !text.is_empty() {
                    query = text.to_string();
                    break;
                }
            }
        }
    }
    if query.is_empty() {
        return Err("pass a mark id from the last inspect, or match the control's name".into());
    }
    let nodes: Vec<UIAControlNode> = som_marks().values().cloned().collect();
    pick_mark(&nodes, &query)
}

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UIAControlNode {
    pub mark_id: u32,
    /// "Button" | "Edit" | "ComboBox" | "CheckBox" | "MenuItem" | "TabItem" | "Hyperlink" | "CanvasRegion"
    pub control_type: String,
    pub name: String,
    pub automation_id: String,
    pub class_name: String,
    /// [x, y, width, height] in the annotated snapshot's pixel space.
    pub bounds: [i32; 4],
    /// Exact pixel center the SoM engine resolves a mark to.
    pub center_xy: [i32; 2],
    pub supports_background_invoke: bool,
    pub supports_background_value: bool,
    /// "uia" for live OS accessibility nodes, "simulated" for the offline fallback set.
    pub origin: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SoMAnnotatedSnapshot {
    pub window_title: String,
    pub capture_source: String,
    pub capture_ms: u32,
    pub total_marks: usize,
    pub annotated_image_base64: String,
    pub mark_registry: Vec<UIAControlNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BotMiniWindowInstance {
    pub bot_id: String,
    pub bot_handle: String,
    pub window_label: String,
    pub current_url_or_app: String,
    /// "pip_isolated" | "human_takeover" | "closed"
    pub mode: String,
    pub virtual_cursor_xy: [i32; 2],
    pub active_driver: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiniWindowNode {
    pub id: i64,
    pub tag: String,
    pub label: String,
    pub x: i32,
    pub y: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MiniWindowMedia {
    pub playing: bool,
    pub paused: bool,
    pub current_time: f64,
    pub duration: f64,
    pub muted: bool,
    /// "" | "skipped" | "waiting" | "unskippable". An ad is not the video.
    #[serde(default)]
    pub ad: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MiniWindowHit {
    pub window_label: String,
    pub url: String,
    pub title: String,
    pub text: String,
    pub nodes: Vec<MiniWindowNode>,
    #[serde(default)]
    pub media: Option<MiniWindowMedia>,
    #[serde(default)]
    pub ready: String,
    /// What a smart action picked, e.g. "clicked [12] button Add to cart".
    #[serde(default)]
    pub note: Option<String>,
    /// "sign-in" | "no-composer" | "composer-ready" | "" — why a prompt cannot be written yet.
    #[serde(default)]
    pub blocker: String,
    pub ms: i64,
}

// ---------------------------------------------------------------------------
// Mini computer shell — the per-bot desktop (Files / Chrome / Terminal).
// The shell webview owns the UI; the Rust registry below is the single
// source of truth the agent reads, so both sides always agree.
// ---------------------------------------------------------------------------

/// One Chrome tab in the bot's mini computer.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellTab {
    pub id: String,
    pub url: String,
    pub title: String,
}

/// Shell desktop state for one bot's mini computer.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellState {
    /// "desktop" | "chrome" | "files" | "terminal"
    pub app: String,
    pub tabs: Vec<ShellTab>,
    pub active_tab: String,
    pub chrome_visible: bool,
    /// [x, y, w, h] in CSS px — the Chrome content area the shell reports.
    pub content: [f64; 4],
    /// The shell's real devicePixelRatio (window.scale_factor() can lie for
    /// freshly created windows on Windows — trust the page's own value).
    pub dpr: f64,
    /// True only while the chat dock reports a visible Chrome content slot.
    pub embedded_host_visible: bool,
    /// Recent page navigations (newest first, capped) — the Chrome app's
    /// history button reads this.
    pub history: Vec<String>,
}

impl Default for ShellState {
    fn default() -> Self {
        Self {
            app: "desktop".into(),
            tabs: Vec::new(),
            active_tab: String::new(),
            chrome_visible: false,
            content: [0.0, 111.0, 980.0, 505.0],
            dpr: 1.0,
            embedded_host_visible: false,
            history: Vec::new(),
        }
    }
}

pub fn shell_state(bot_id: &str) -> ShellState {
    shell_states()
        .get(bot_id.trim())
        .cloned()
        .unwrap_or_default()
}

/// Applies `f` to the bot's shell state (inserting a default when missing).
pub fn update_shell_state<R>(bot_id: &str, f: impl FnOnce(&mut ShellState) -> R) -> R {
    let mut states = shell_states();
    let state = states.entry(bot_id.trim().to_string()).or_default();
    f(state)
}

/// Returns the bot's display handle from the mini window registry,
/// falling back to "@bot" when no entry exists yet.
pub fn bot_handle_of(_app: &AppHandle, bot_id: &str) -> String {
    mini_windows()
        .get(bot_id.trim())
        .map(|entry| entry.bot_handle.clone())
        .unwrap_or_else(|| "@bot".into())
}

/// Keeps the existing Browser tab as a second view of this same live Chrome,
/// without creating the legacy botscreen browser or opening a floating window.
pub fn show_embedded_chrome(app: &AppHandle, bot_id: &str, url: &str, bounds: WebAppBounds, focus: bool) -> Result<()> {
    let id = safe_id_component(bot_id)?.to_string();
    let parsed = agent_url_allowed(url)?;
    let home = crate::util::product_home();
    let handle = bot_handle_of(app, &id);
    open_chrome_tab(app, &home, &id, &handle, parsed, true)?;
    let scale = app.get_window("main").ok_or_else(|| err("main window is not open"))?.scale_factor().unwrap_or(1.0);
    update_shell_state(&id, |s| {
        s.content = [bounds.x, bounds.y, bounds.width, bounds.height];
        s.embedded_host_visible = true;
        s.dpr = scale;
    });
    apply_chrome_visibility(app, &id);
    if focus {
        if let Some(view) = app.get_webview(&chrome_label(&id)?) {
            let _ = view.set_focus();
        }
    }
    broadcast_shell(app, &id, "embedded_browser");
    Ok(())
}

pub fn hide_embedded_chrome(app: &AppHandle, bot_id: &str) {
    update_shell_state(bot_id, |state| state.embedded_host_visible = false);
    if let Some(view) = app.get_webview(&chrome_label(bot_id).unwrap_or_default()) {
        let _ = view.hide();
        let _ = view.set_bounds(tauri::Rect {
            position: tauri::Position::Physical(tauri::PhysicalPosition::new(-10000, -10000)),
            size: tauri::Size::Physical(tauri::PhysicalSize::new(1, 1)),
        });
    }
}

/// Pushes the full shell + instance snapshot to every window listening on
/// `ronic://mini-computer` (the shell webview syncs its UI from this).
pub fn broadcast_shell(app: &AppHandle, bot_id: &str, action: &str) {
    let shell = shell_state(bot_id);
    let instance = mini_windows().get(bot_id.trim()).cloned();
    let _ = app.emit(
        "ronic://mini-computer",
        serde_json::json!({
            "action": action,
            "botId": bot_id.trim(),
            "shell": serde_json::to_value(&shell).unwrap_or_default(),
            "instance": instance,
        }),
    );
}

// ---------------------------------------------------------------------------
// Pillar 1 — per-bot mini windows
// ---------------------------------------------------------------------------

/// Injected into every bot mini/squad window. Renders the green virtual bot
/// cursor (the visual trace of synthetic actions), a status strip, and a
/// best-effort Ctrl+Space halt inside the page. Pure DOM — no Tauri IPC is
/// needed for remote pages, which never receive Tauri internals.
pub const BOT_MINI_WINDOW_HUD_SCRIPT: &str = r#"(function(){
  if (window.__RONIC_MINI_COMPUTER_HUD__) return;
  window.__RONIC_MINI_COMPUTER_HUD__ = true;
  function mount() {
    if (!document.body) return;
    var cursor = document.createElement('div');
    cursor.id = 'ronic-virtual-bot-cursor';
    cursor.style.cssText = 'position:fixed;left:-40px;top:-40px;width:16px;height:16px;border-radius:999px;background:rgba(16,185,129,0.85);border:2px solid #111111;z-index:2147483646;pointer-events:none;display:none;transition:left 140ms cubic-bezier(0.22,1,0.36,1),top 140ms cubic-bezier(0.22,1,0.36,1);box-shadow:0 0 0 4px rgba(16,185,129,0.25);transform:translate(-50%,-50%);';
    document.body.appendChild(cursor);
    var label = document.createElement('div');
    label.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;background:#111111;color:#10B981;font:600 9px/1 monospace;padding:3px 5px;border-radius:4px;transform:translate(10px,-4px);display:none;';
    document.body.appendChild(label);
    document.addEventListener('ronic-virtual-cursor', function (e) {
      var d = e.detail || {};
      cursor.style.display = 'block';
      cursor.style.left = d.x + 'px';
      cursor.style.top = d.y + 'px';
      label.style.left = d.x + 'px';
      label.style.top = d.y + 'px';
      label.textContent = d.tag || 'bot';
      label.style.display = 'block';
    });
    var strip = document.createElement('div');
    strip.style.cssText = 'position:fixed;bottom:8px;left:8px;right:8px;z-index:2147483647;background:rgba(17,17,17,0.92);color:#FFFFFF;padding:5px 10px;border-radius:6px;font:500 10px/1.2 monospace;display:flex;align-items:center;justify-content:space-between;backdrop-filter:blur(6px);pointer-events:none;';
    strip.innerHTML = '<span>🤖 Isolated bot viewport — zero OS mouse theft</span><span style="color:#10B981;">[Ctrl+Space = halt]</span>';
    document.body.appendChild(strip);
  }
  if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', mount); } else { mount(); }
  window.addEventListener('keydown', function (e) {
    if (e.code === 'Space' && e.ctrlKey) {
      e.preventDefault();
      var overlay = document.getElementById('ronic-mini-halt');
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'ronic-mini-halt';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(17,17,17,0.82);color:#F8FAFC;display:flex;align-items:center;justify-content:center;font:700 14px monospace;';
        overlay.textContent = '🛑 HALT REQUESTED — drivers paused from the studio';
        document.body && document.body.appendChild(overlay);
        try { window.stop(); } catch (_) {}
        try { location.href = 'ronic-halt:engage'; } catch (_) {}
      } else {
        overlay.remove();
      }
    }
  });
})()"#;

pub fn mini_label(bot_id: &str) -> Result<String> {
    let id = safe_id_component(bot_id)?;
    Ok(format!("ronic_mini_comp_{id}"))
}

/// The mini computer's desktop shell webview — it IS the window's own
/// webview, so its label equals the window label (`ronic_mini_comp_<id>`).
pub fn shell_label(bot_id: &str) -> Result<String> {
    mini_label(bot_id)
}

/// The mini computer's browser page webview (isolated profile). The agent's
/// browser tools eval into this one.
pub fn chrome_label(bot_id: &str) -> Result<String> {
    Ok(format!("{}_chrome", mini_label(bot_id)?))
}

fn squad_label(bot_id: &str) -> Result<String> {
    let id = safe_id_component(bot_id)?;
    Ok(format!("ronic_squad_comp_{id}"))
}

/// Per-bot browser profile for the mini windows. Separate from the main bot
/// screen's `browser` folder so both can be open at once without fighting
/// over the WebView2 user-data-folder lock.
pub fn mini_browser_dir(home: &std::path::Path, bot_id: &str) -> Result<std::path::PathBuf> {
    let id = safe_id_component(bot_id)?;
    Ok(home.join("bots").join(id).join("browser-mini"))
}

fn cascade_position(app: &AppHandle, idx: usize, width: f64, height: f64) -> (f64, f64) {
    let mut right = 1460.0;
    let mut bottom = 620.0;
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let scale = monitor.scale_factor();
        right = monitor.size().width as f64 / scale - width - 16.0;
        bottom = monitor.size().height as f64 / scale - height - 48.0;
    }
    let offset = (idx as f64) * 36.0;
    ((right - offset).max(8.0), (bottom - offset).max(8.0))
}

#[tauri::command]
pub async fn spawn_bot_mini_computer_window(
    app: AppHandle,
    state: tauri::State<'_, crate::AppState>,
    bot_id: String,
    bot_handle: String,
    initial_url: String,
    always_on_top: bool,
) -> Result<BotMiniWindowInstance> {
    // MUST stay off the main thread: creating windows/webviews from a sync
    // command deadlocks WebView2's async controller init (wry#583) — the
    // webview appears but never loads its URL and the whole UI freezes.
    let home = state.home.clone();
    tauri::async_runtime::spawn_blocking(move || {
        spawn_bot_mini_computer_window_inner(&app, &home, bot_id, bot_handle, initial_url, always_on_top)
    })
    .await
    .map_err(|e| err(format!("the spawn did not run: {e}")))?
}

fn spawn_bot_mini_computer_window_inner(
    app: &AppHandle,
    home: &std::path::Path,
    bot_id: String,
    bot_handle: String,
    initial_url: String,
    always_on_top: bool,
) -> Result<BotMiniWindowInstance> {
    let bot_id = bot_id.trim().to_string();
    if bot_id.is_empty() {
        return Err(err("give the bot an id"));
    }
    let parsed = match initial_url.trim() {
        "" => None,
        trimmed => {
            let parsed = url::Url::parse(trimmed).map_err(|_| err("use an http or https URL"))?;
            if parsed.scheme() != "http" && parsed.scheme() != "https" {
                return Err(err("use an http or https URL"));
            }
            Some(parsed)
        }
    };
    let instance = spawn_mini_window(&app, home, &bot_id, &bot_handle, parsed, always_on_top)?;
    if let Some(win) = app.get_window(&instance.window_label) {
        let _ = win.set_focus();
    }
    Ok(instance)
}

/// Creates the bot's mini computer window (a real desktop: shell webview +
/// tabbed Chrome child webview + Files + Terminal) when missing, and upserts
/// the registry entry. Shared by the studio command and the agent driver.
///
/// The SHELL is the window's own webview (built with WebviewWindowBuilder so
/// it gets the full URL + IPC treatment). The Chrome page is a child webview
/// created later and navigated EXPLICITLY — the add_child path drops builder
/// URLs on Windows (webviews stay stranded on about:blank).
fn spawn_mini_window(
    app: &AppHandle,
    home: &std::path::Path,
    bot_id: &str,
    bot_handle: &str,
    parsed: Option<url::Url>,
    always_on_top: bool,
) -> Result<BotMiniWindowInstance> {
    let label = mini_label(bot_id)?;
    let existing_count = mini_windows().len();
    if app.get_window(&label).is_none() {
        let was_embedded = app.get_webview(&chrome_label(bot_id)?).is_some();
        let dir = mini_browser_dir(home, bot_id)?;
        let _ = std::fs::create_dir_all(&dir);
        let (x, y) = cascade_position(app, existing_count, 980.0, 660.0);
        // Pre-insert the registry so the shell's mini_shell_boot (which can
        // fire while this function is still opening Chrome) sees the handle.
        mini_windows().insert(
            bot_id.to_string(),
            BotMiniWindowInstance {
                bot_id: bot_id.to_string(),
                bot_handle: bot_handle.to_string(),
                window_label: label.clone(),
                current_url_or_app: String::new(),
                mode: "pip_isolated".into(),
                virtual_cursor_xy: [24, 24],
                active_driver: "Synthetic DOM (<15ms)".into(),
                status: "running_isolated".into(),
            },
        );
        // NOTE: no `.position()` here — on Windows the builder's position
        // leaks into the WEBVIEW's client bounds (webview lands at the
        // window's screen offset, mostly clipped out → white window). The
        // window is moved with set_position after creation instead, exactly
        // how the centered main window avoids it.
        let mut builder = WebviewWindowBuilder::new(app, label.clone(), WebviewUrl::App("mini-shell.html".into()))
            .title(format!("{bot_handle} — Ronic Mini Computer"))
            .inner_size(980.0, 660.0)
            .min_inner_size(680.0, 500.0)
            .resizable(true);
        if always_on_top {
            builder = builder.always_on_top(true);
        }
        let win = builder
            .build()
            .map_err(|e| err(format!("failed to spawn the mini computer window: {e}")))?;
        let _ = win.set_position(tauri::LogicalPosition::new(x, y));
        if !was_embedded {
            update_shell_state(bot_id, |s| *s = ShellState::default());
        }
        let close_app = app.clone();
        let close_id = bot_id.to_string();
        win.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                if close_app.get_webview(&chrome_label(&close_id).unwrap_or_default()).is_some() {
                    let _ = reparent_chrome(&close_app, &close_id, false);
                }
                mini_windows().remove(&close_id);
                mark_mini_expanded(&close_id, false);
                broadcast_shell(&close_app, &close_id, "embedded");
            }
        });
        // Observed on this WebView2 build: a freshly created webview can sit
        // on about:blank even when the builder carried an App URL — navigate
        // it explicitly if it hasn't loaded the shell page.
        if let Some(win) = app.get_webview_window(&label) {
            if let Some(shell_url) = shell_page_url(app) {
                let _ = win.navigate(shell_url);
            }
        }
    } else if let Some(win) = app.get_window(&label) {
        let _ = win.unminimize();
        let _ = win.show();
    }
    mark_mini_expanded(bot_id, true);
    reparent_chrome(app, bot_id, true)?;

    if let Some(target) = parsed {
        open_chrome_tab(app, home, bot_id, bot_handle, target, true)?;
    }

    let shell = shell_state(bot_id);
    let current = shell
        .tabs
        .iter()
        .find(|tab| tab.id == shell.active_tab)
        .map(|tab| tab.url.clone())
        .unwrap_or_else(|| match shell.app.as_str() {
            "files" => "files".into(),
            "terminal" => "terminal".into(),
            "desktop" => "desktop".into(),
            _ => String::new(),
        });
    let instance = BotMiniWindowInstance {
        bot_id: bot_id.to_string(),
        bot_handle: bot_handle.to_string(),
        window_label: label,
        current_url_or_app: current,
        mode: "pip_isolated".into(),
        virtual_cursor_xy: [24, 24],
        active_driver: "Synthetic DOM (<15ms)".into(),
        status: "running_isolated".into(),
    };
    mini_windows().insert(bot_id.to_string(), instance.clone());
    sync_window_title(app, bot_id);
    broadcast_shell(app, bot_id, "spawned");
    Ok(instance)
}

/// The mini shell page URL, derived from the main window's LIVE url so it is
/// right in dev (vite) and production (tauri protocol) alike.
fn shell_page_url(app: &AppHandle) -> Option<url::Url> {
    if let Some(w) = app.get_webview_window("main") {
        if let Ok(mut url) = w.url() {
            if url.as_str() != "about:blank" && !url.as_str().is_empty() {
                url.set_path("mini-shell.html");
                url.set_query(None);
                url.set_fragment(None);
                return Some(url);
            }
        }
    }
    if let Some(w) = app.get_webview("main") {
        if let Ok(mut url) = w.url() {
            if url.as_str() != "about:blank" && !url.as_str().is_empty() {
                url.set_path("mini-shell.html");
                url.set_query(None);
                url.set_fragment(None);
                return Some(url);
            }
        }
    }
    url::Url::parse("http://127.0.0.1:1420/mini-shell.html").ok()
}

/// Makes sure the Chrome child webview exists inside the bot's mini computer
/// window (isolated profile, HUD script), navigating to `url` when given.
/// The URL is applied EXPLICITLY after creation — the add_child path drops
/// builder URLs on Windows (webviews stay stranded on about:blank).
pub fn ensure_chrome(app: &AppHandle, home: &std::path::Path, bot_id: &str, url: Option<url::Url>) -> Result<String> {
    let label = chrome_label(bot_id)?;
    let win_label = mini_label(bot_id)?;
    let expanded = mini_is_expanded(app, bot_id);
    if app.get_webview(&label).is_none() {
        let window = app
            .get_window(if expanded { &win_label } else { "main" })
            .ok_or_else(|| err("that bot's computer screen is not open"))?;
        let dir = mini_browser_dir(home, bot_id)?;
        let _ = std::fs::create_dir_all(&dir);
        let blank = url::Url::parse("about:blank").expect("static url");
        let nav_bot = bot_id.trim().to_string();
        let nav_app = app.clone();
        let export_label = label.clone();
        let export_app = app.clone();
        let builder = WebviewBuilder::new(label.clone(), WebviewUrl::External(url.clone().unwrap_or(blank)))
            .initialization_script(BOT_MINI_WINDOW_HUD_SCRIPT)
            .initialization_script(crate::workspace_bridge::PAGE_SCRIPT)
            .data_directory(dir)
            .on_navigation(move |nav_url| {
                if nav_url.scheme() == "ronic-halt" {
                    EMERGENCY_HALT.store(true, Ordering::Relaxed);
                    return false;
                }
                // The webview IS the active tab's surface — keep the tab strip,
                // the title bar, and the agent's status in step with every
                // navigation the page makes (link clicks, redirects).
                let next = nav_url.to_string();
                let changed = update_shell_state(&nav_bot, |s| {
                    if next != "about:blank" && s.history.first().map(|first| first != &next).unwrap_or(true) {
                        s.history.insert(0, next.clone());
                        s.history.truncate(50);
                    }
                    if let Some(active) = s.tabs.iter_mut().find(|tab| tab.id == s.active_tab) {
                        if active.url != next {
                            active.url = next.clone();
                            active.title = host_of(&next);
                            return true;
                        }
                    }
                    false
                });
                if changed {
                    sync_window_title(&nav_app, &nav_bot);
                    sync_instance_summary(&nav_app, &nav_bot);
                    broadcast_shell(&nav_app, &nav_bot, "chrome");
                }
                if crate::site_session::worth_sharing(nav_url.as_str()) {
                    crate::site_session::schedule_export(&export_app, &export_label);
                }
                true
            });
        let state = shell_state(bot_id);
        let scale = if state.dpr > 0.0 { state.dpr } else { 1.0 };
        let content = state.content;
        let inner = window.inner_size().unwrap_or(tauri::PhysicalSize::new(980, 660));
        let px = (content[0] * scale).round() as i32;
        let py = (content[1] * scale).round() as i32;
        let pw = ((content[2] * scale).round() as u32).clamp(1, inner.width.saturating_sub(px.max(0) as u32).max(1));
        let ph = ((content[3] * scale).round() as u32).clamp(1, inner.height.saturating_sub(py.max(0) as u32).max(1));
        let webview = window
            .add_child(builder, tauri::PhysicalPosition::new(px, py), tauri::PhysicalSize::new(pw, ph))
            .map_err(|e| err(format!("failed to open the mini computer browser: {e}")))?;
        let _ = webview.eval(crate::workspace_bridge::PAGE_SCRIPT);
        apply_chrome_visibility(app, bot_id);
        // Sign-in from any other bot is applied before the first request.
        crate::site_session::import_shared(&webview);
        if let Some(target) = url {
            let _ = webview.navigate(target);
        }
    } else if let Some(target) = url {
        let webview = app.get_webview(&label).ok_or_else(|| err("the mini computer browser vanished"))?;
        // The page script no-ops once this document already has bridge v5.
        let _ = webview.eval(crate::workspace_bridge::PAGE_SCRIPT);
        crate::site_session::import_shared(&webview);
        let needs_nav = webview.url().ok().map(|current| current.as_str() != target.as_str()).unwrap_or(false);
        if needs_nav {
            let _ = webview.navigate(target);
        } else if crate::site_session::should_reload_for_session(&label, target.as_str()) {
            let _ = webview.reload();
        }
    }
    Ok(label)
}

/// Shows/hides and repositions the Chrome child webview from the shell state.
pub fn apply_chrome_visibility(app: &AppHandle, bot_id: &str) {
    let label = match chrome_label(bot_id) {
        Ok(label) => label,
        Err(_) => return,
    };
    let Some(webview) = app.get_webview(&label) else { return };
    let state = shell_state(bot_id);
    let visible = state.chrome_visible && (mini_is_expanded(app, bot_id) || state.embedded_host_visible);
    if visible {
        let _ = webview.show();
        reposition_chrome(app, bot_id);
    } else {
        let _ = webview.hide();
        // Move child webview HWND off-screen on Windows WebView2 so it never paints over or intercepts clicks from the desktop shell
        let _ = webview.set_bounds(tauri::Rect {
            position: tauri::Position::Physical(tauri::PhysicalPosition::new(-10000, -10000)),
            size: tauri::Size::Physical(tauri::PhysicalSize::new(1, 1)),
        });
    }
}

pub fn reposition_chrome(app: &AppHandle, bot_id: &str) {
    let state = shell_state(bot_id);
    let expanded = mini_is_expanded(app, bot_id);
    if !state.chrome_visible || (!expanded && !state.embedded_host_visible) {
        // Child webview HWND must stay parked off-screen when Chrome tab is not active,
        // so it never renders over or occludes the desktop view on Windows.
        let label = match chrome_label(bot_id) {
            Ok(label) => label,
            Err(_) => return,
        };
        if let Some(webview) = app.get_webview(&label) {
            let _ = webview.hide();
            let _ = webview.set_bounds(tauri::Rect {
                position: tauri::Position::Physical(tauri::PhysicalPosition::new(-10000, -10000)),
                size: tauri::Size::Physical(tauri::PhysicalSize::new(1, 1)),
            });
        }
        return;
    }
    let label = match chrome_label(bot_id) {
        Ok(label) => label,
        Err(_) => return,
    };
    let Some(webview) = app.get_webview(&label) else { return };
    let expanded = mini_is_expanded(app, bot_id);
    let Some(window) = (if expanded { app.get_window(&mini_label(bot_id).unwrap_or_default()) } else { app.get_window("main") }) else { return };
    // The shell reports its content rect in CSS px; the page's real
    // devicePixelRatio (stored by mini_shell_layout — window.scale_factor()
    // can report 1.0 for freshly created windows) converts it to physical.
    let scale = if state.dpr > 0.0 { state.dpr } else { 1.0 };
    let content = state.content;
    let inner = window.inner_size().unwrap_or(tauri::PhysicalSize::new(980, 660));
    let px = (content[0] * scale).round() as i32;
    let py = (content[1] * scale).round() as i32;
    let pw = ((content[2] * scale).round() as u32).clamp(1, inner.width.saturating_sub(px.max(0) as u32).max(1));
    let ph = ((content[3] * scale).round() as u32).clamp(1, inner.height.saturating_sub(py.max(0) as u32).max(1));
    let _ = webview.set_bounds(tauri::Rect {
        position: tauri::Position::Physical(tauri::PhysicalPosition::new(px, py)),
        size: tauri::Size::Physical(tauri::PhysicalSize::new(pw, ph)),
    });
}

fn host_of(raw: &str) -> String {
    url::Url::parse(raw)
        .ok()
        .and_then(|parsed| parsed.host_str().map(str::to_string))
        .unwrap_or_else(|| raw.chars().take(40).collect())
}

/// Opens `target` as a Chrome tab in the bot's mini computer: ensures the
/// window + browser webview, adds (or refocuses) the tab, shows Chrome, and
/// broadcasts. `focus_matching` reuses a tab already on that site.
pub fn open_chrome_tab(
    app: &AppHandle,
    home: &std::path::Path,
    bot_id: &str,
    bot_handle: &str,
    target: url::Url,
    focus_matching: bool,
) -> Result<ShellTab> {
    // Bot navigation stays in the chat's Computer panel; only the user's
    // expand action creates a separate native window.
    let expanded = mini_is_expanded(app, bot_id);
    ensure_chrome(app, home, bot_id, Some(target.clone()))?;
    let target_str = target.to_string();
    let tab = update_shell_state(bot_id, |state| {
        if focus_matching {
            if let Some(existing) = state
                .tabs
                .iter_mut()
                .find(|tab| tab.url == target_str || same_host_path(&tab.url, &target_str))
            {
                existing.url = target_str.clone();
                state.active_tab = existing.id.clone();
                return existing.clone();
            }
        }
        let id = format!("t{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos());
        let fresh = ShellTab { id: id.clone(), url: target_str.clone(), title: host_of(&target_str) };
        state.tabs.push(fresh.clone());
        state.active_tab = id;
        fresh
    });
    update_shell_state(bot_id, |state| {
        state.app = "chrome".into();
        state.chrome_visible = true;
    });
    if expanded {
        if let Some(window) = app.get_window(&mini_label(bot_id).unwrap_or_default()) {
            let _ = window.show();
            let _ = window.unminimize();
        }
    } else if let Some(main) = app.get_webview_window("main") {
        let detail = serde_json::json!({ "botId": bot_id, "botHandle": bot_handle, "url": target.to_string() });
        let _ = main.eval(format!("window.dispatchEvent(new CustomEvent('ronic-mini-computer-open', {{ detail: {detail} }}))"));
    }
    apply_chrome_visibility(app, bot_id);
    sync_window_title(app, bot_id);
    sync_instance_summary(app, bot_id);
    broadcast_shell(app, bot_id, "chrome");
    Ok(tab)
}

/// Keeps the studio panel's summary (url or app name) in step with the shell.
pub fn sync_instance_summary(app: &AppHandle, bot_id: &str) {
    let shell = shell_state(bot_id);
    let current = shell
        .tabs
        .iter()
        .find(|tab| tab.id == shell.active_tab)
        .map(|tab| tab.url.clone())
        .unwrap_or_else(|| shell.app.clone());
    if let Some(entry) = mini_windows().get_mut(bot_id.trim()) {
        entry.current_url_or_app = current;
    }
    let _ = app;
}

/// Native title bar mirrors the active Chrome tab so the user always sees
/// where the bot is.
pub fn sync_window_title(app: &AppHandle, bot_id: &str) {
    let Some(window) = app.get_window(&mini_label(bot_id).unwrap_or_default()) else { return };
    let handle = mini_windows().get(bot_id.trim()).map(|entry| entry.bot_handle.clone()).unwrap_or_default();
    let shell = shell_state(bot_id);
    let title = match shell.tabs.iter().find(|tab| tab.id == shell.active_tab) {
        Some(tab) if !tab.title.is_empty() => format!("{handle} — {} — Ronic Mini Computer", tab.title),
        _ => format!("{handle} — Ronic Mini Computer"),
    };
    let _ = window.set_title(&title);
}

#[tauri::command]
pub fn list_bot_mini_computer_windows(app: AppHandle) -> Vec<BotMiniWindowInstance> {
    let mut map = mini_windows();
    let ids: Vec<String> = map.keys().cloned().collect();
    for id in ids {
        let label = map.get(&id).map(|w| w.window_label.clone()).unwrap_or_default();
        let alive = app.get_window(&label).is_some();
        if !alive {
            if let Some(win) = map.get_mut(&id) {
                win.status = "closed".into();
            }
        }
    }
    map.values().cloned().collect()
}

#[tauri::command]
pub fn close_bot_mini_computer_window(app: AppHandle, bot_id: String) -> Result<String> {
    let label = mini_label(&bot_id)?;
    if let Some(win) = app.get_window(&label) {
        let _ = reparent_chrome(&app, &bot_id, false);
        let _ = win.close();
    }
    mini_windows().remove(bot_id.trim());
    mark_mini_expanded(&bot_id, false);
    let _ = app.emit("ronic://mini-computer", serde_json::json!({ "action": "closed", "botId": bot_id }));
    Ok(format!("Closed {label}."))
}

/// Human takeover: focus the real window so the user can drive it with their
/// own mouse/keyboard; the bot driver refuses actions until resumed.
#[tauri::command]
pub fn set_bot_mini_window_takeover(app: AppHandle, bot_id: String, take_over: bool) -> Result<BotMiniWindowInstance> {
    let label = mini_label(&bot_id)?;
    if take_over {
        if let Some(win) = app.get_window(&label) {
            let _ = win.set_focus();
        }
    }
    let mut map = mini_windows();
    let instance = map
        .get_mut(&bot_id.trim().to_string())
        .ok_or_else(|| err("no mini window for that bot"))?;
    instance.mode = if take_over { "human_takeover".into() } else { "pip_isolated".into() };
    instance.status = if take_over { "human_controlling".into() } else { "running_isolated".into() };
    let snapshot = instance.clone();
    drop(map);
    let _ = app.emit("ronic://mini-computer", serde_json::json!({ "action": if take_over { "takeover" } else { "resumed" }, "instance": snapshot }));
    Ok(snapshot)
}

/// Pillar 1 driver — synthetic DOM actions strictly inside a bot's own
/// window. `kind` is "read" | "click" | "type". Click/type target the
/// `control_index`-th interactive control and move the window's virtual
/// cursor; nothing is sent to the OS input stack.
#[tauri::command]
pub async fn drive_bot_computer_window(
    app: AppHandle,
    bot_id: String,
    kind: String,
    control_index: Option<i64>,
    text: Option<String>,
    squad: bool,
    extra: Option<String>,
) -> Result<MiniWindowHit> {
    // Async + blocking pool: the eval waits on the WebView2 completion
    // handler, which the MAIN thread's message pump must deliver — a sync
    // command would block that pump and deadlock every drive for 8s.
    tauri::async_runtime::spawn_blocking(move || {
        if EMERGENCY_HALT.load(Ordering::Relaxed) {
            return Err(err("emergency halt is engaged — resume the computer drivers first"));
        }
        {
            let map = mini_windows();
            if let Some(instance) = map.get(&bot_id.trim().to_string()) {
                if instance.mode == "human_takeover" {
                    return Err(err("the human has taken this window over"));
                }
            }
        }
        let label = if squad { squad_label(&bot_id)? } else { chrome_label(&bot_id)? };
        let hit = drive_labeled_window(&app, &label, &kind, control_index, text.as_deref(), None, extra.as_deref())?;
        let _ = app.emit("ronic://mini-computer", serde_json::json!({ "action": "driven", "botId": bot_id, "kind": kind }));
        Ok(hit)
    })
    .await
    .map_err(|e| err(format!("the drive did not run: {e}")))?
}

/// What a drive script evals into: the mini computer's Chrome child webview,
/// or a squad's whole webview window (squads keep their single-page window).
enum DriveSurface {
    Chrome(Webview<tauri::Wry>),
    Squad(tauri::WebviewWindow<tauri::Wry>),
}

impl DriveSurface {
    fn eval_with_callback(&self, script: String, cb: impl Fn(String) + Send + 'static) -> Result<()> {
        match self {
            DriveSurface::Chrome(webview) => webview.eval_with_callback(script, cb),
            DriveSurface::Squad(window) => window.eval_with_callback(script, cb),
        }
        .map_err(|e| err(e.to_string()))
    }

    fn url(&self) -> Option<url::Url> {
        match self {
            DriveSurface::Chrome(webview) => webview.url().ok(),
            DriveSurface::Squad(window) => window.url().ok(),
        }
    }

    fn navigate(&self, url: url::Url) {
        let _ = match self {
            DriveSurface::Chrome(webview) => webview.navigate(url),
            DriveSurface::Squad(window) => window.navigate(url),
        };
    }
}

fn get_drive_surface(app: &AppHandle, label: &str) -> Result<DriveSurface> {
    if label.ends_with("_chrome") || label.starts_with("webapp_") {
        let webview = app.get_webview(label).ok_or_else(|| err("that bot's computer window or workspace webapp is not open"))?;
        Ok(DriveSurface::Chrome(webview))
    } else {
        let window = app.get_webview_window(label).ok_or_else(|| err("that bot's computer window is not open"))?;
        Ok(DriveSurface::Squad(window))
    }
}

fn drive_labeled_window(
    app: &AppHandle,
    label: &str,
    kind: &str,
    control_index: Option<i64>,
    text: Option<&str>,
    expected_url: Option<&str>,
    extra: Option<&str>,
) -> Result<MiniWindowHit> {
    // Only our own computer-use windows and workspace webapps may be driven — never the main shell.
    if !label.starts_with("ronic_mini_comp_") && !label.starts_with("ronic_squad_comp_") && !label.starts_with("webapp_") {
        return Err(err("that window is not a bot computer window or workspace webapp"));
    }
    let win = get_drive_surface(app, label)?;
    let started = std::time::Instant::now();
    // Actions run exactly once (no retry — a repeat click would double-fire);
    // reads poll until the page answers. A wedged read gets one reload.
    match kind {
        "read" => {
            let attempts = 2;
            let mut last = err("the page did not answer");
            for attempt in 0..attempts {
                match poll_read_hit(&win, label, started, expected_url, Duration::from_millis(2400)) {
                    Ok(hit) => return Ok(hit),
                    Err(error) => {
                        last = error;
                        if attempt + 1 < attempts {
                            if let Some(current) = win.url() {
                                win.navigate(current);
                            }
                            thread::sleep(Duration::from_millis(250));
                        }
                    }
                }
            }
            if expected_url.is_none() {
                collect_once(&win, label, started, None, std::time::Instant::now() + Duration::from_secs(3)).ok_or(last)
            } else {
                Err(last)
            }
        }
        "click" | "type" => {
            let script = match kind {
                "click" => {
                    let id = control_index.ok_or_else(|| err("pick a control to click"))?;
                    mini_click_js(id)
                }
                _ => {
                    let id = control_index.ok_or_else(|| err("pick an input to type into"))?;
                    let text = text.unwrap_or_default();
                    if text.is_empty() {
                        return Err(err("Stuck: there is no prompt text to write. This chat turn is still running. It is not a background job."));
                    }
                    let host = win.url().and_then(|page| page.host_str().map(|item| item.to_string())).unwrap_or_default();
                    let pack = if crate::workspace_bridge::composer_injection_host(&host) {
                        crate::workspace_bridge::live_context_pack(app)
                    } else {
                        String::new()
                    };
                    let injected = crate::workspace_bridge::inject_composer_text(&host, &pack, text);
                    // A normal keystroke stays short. A context pack is appended for a
                    // real prompt on any composer that is not a team-message site.
                    let limit = if injected.contains("[Ronic OS connection]") { 12_000 } else { 2000 };
                    mini_type_js(id, &crate::util::prefix_utf8(&injected, limit))
                }
            };
            let acted = act_eval(&win, &script)?;
            let goto = acted.get("goto").and_then(|value| value.as_str()).filter(|url| !url.is_empty());
            follow_link(&win, goto);
            let mut hit = poll_read_hit(&win, label, started, goto, Duration::from_millis(if goto.is_some() { 2400 } else { 1200 }))?;
            if let Some(note) = acted.get("note").and_then(|value| value.as_str()).filter(|note| !note.is_empty()) {
                hit.note = Some(note.to_string());
            }
            Ok(hit)
        }
        "scroll" => {
            act_eval(&win, &mini_scroll_js(extra.unwrap_or("down")))?;
            poll_read_hit(&win, label, started, None, Duration::from_millis(1500))
        }
        "find" => {
            let query = extra.unwrap_or_default();
            if query.trim().is_empty() {
                return Err(err("say what to look for, like find \"add to cart\""));
            }
            let script = mini_find_js(&crate::util::prefix_utf8(query, 120));
            let raw = eval_window_json(&win, &script, Duration::from_secs(3))?;
            hit_from_json(&raw, label, started)
        }
        "submit" => {
            let id = control_index.ok_or_else(|| err("pick the input to submit; read the page again for a fresh id"))?;
            let acted = act_eval(&win, &mini_submit_js(id))?;
            let mut hit = poll_read_hit(&win, label, started, None, Duration::from_millis(1800))?;
            if let Some(note) = acted.get("note").and_then(|value| value.as_str()).filter(|note| !note.is_empty()) {
                hit.note = Some(note.to_string());
            }
            Ok(hit)
        }
        _ => Err(err("kind must be read, click, type, submit, scroll, or find")),
    }
}

/// A synthetic click does not follow `<a href>`. Open the address the page
/// returned, under the same http/https rule as inspect_page.
fn follow_link(win: &DriveSurface, goto: Option<&str>) {
    let Some(raw) = goto else { return };
    if let Ok(url) = agent_url_allowed(raw) {
        win.navigate(url);
    }
}

/// One action eval: surface the in-page error message, never retry.
/// The returned object carries a `note` when the action has something to say.
fn act_eval(win: &DriveSurface, script: &str) -> Result<serde_json::Value> {
    let raw = eval_window_json(win, script, Duration::from_secs(3)).map_err(|error| explain_stuck(&error.0))?;
    let value: serde_json::Value = serde_json::from_str(&raw).map_err(|_| explain_stuck("the page did not answer with usable JSON"))?;
    if value.get("ok").and_then(|v| v.as_bool()) == Some(false) {
        return Err(err(explain_from_value(&value)));
    }
    Ok(value)
}

/// Wraps a successful drive JSON (already carrying url/title/text/nodes) into
/// a MiniWindowHit with the window label and latency attached.
fn hit_from_json(raw: &str, label: &str, started: std::time::Instant) -> Result<MiniWindowHit> {
    let mut value: serde_json::Value = serde_json::from_str(raw).map_err(|_| explain_stuck("the page did not answer with usable JSON"))?;
    if value.get("ok").and_then(|v| v.as_bool()) == Some(false) {
        return Err(err(explain_from_value(&value)));
    }
    if let Some(object) = value.as_object_mut() {
        object.insert("windowLabel".into(), serde_json::json!(label));
        object.insert("ms".into(), serde_json::json!(started.elapsed().as_millis() as i64));
    }
    serde_json::from_value(value).map_err(|e| err(e.to_string()))
}

/// ExecuteScript with callback, normalizing the WebView2 string-wrapping.
/// The completed handler drops the HRESULT (wry limitation), so any script
/// error arrives as an empty string — the caller retries rather than stalling.
fn eval_window_json(win: &DriveSurface, script: &str, timeout: std::time::Duration) -> Result<String> {
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    win.eval_with_callback(script.to_string(), move |result| {
        let _ = tx.send(result);
    })?;
    let raw = rx.recv_timeout(timeout).map_err(|_| err("the page did not answer"))?;
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "null" {
        return Err(err("the page did not answer"));
    }
    let mut value = trimmed.to_string();
    // WebView2 may hand back a JSON string containing JSON; unwrap one layer.
    if let Ok(inner) = serde_json::from_str::<serde_json::Value>(trimmed) {
        if let serde_json::Value::String(nested) = &inner {
            if nested.trim_start().starts_with('{') {
                value = nested.clone();
            }
        }
    }
    Ok(value)
}

/// Shared page intelligence for the mini-window drive scripts: a visibility
/// filter over interactive controls (drops hidden, disabled, file inputs and
/// zero-size elements — the junk that once made the bot type into YouTube's
/// hidden file input), a rich label extractor, a relevance score, and the
/// page collector (text, numbered controls, readyState, media state).
const MINI_COLLECT_FN: &str = r#"function __ronicIsEditor(el){
  if (!el) return false;
  var tag = String(el.tagName || "").toLowerCase();
  if (tag === "textarea" || el.id === "PINHOLE_TEXT_AREA_ELEMENT_ID") return true;
  if (el.getAttribute("data-slate-editor") === "true") return true;
  if (el.isContentEditable || el.getAttribute("contenteditable") === "true") return true;
  if (String(el.getAttribute("role") || "") === "textbox") return true;
  if (tag === "input") {
    var type = String(el.getAttribute("type") || "text").toLowerCase();
    return type === "text" || type === "search" || type === "email" || type === "url" || type === "tel" || type === "password" || type === "";
  }
  return false;
}
function __ronicLabel(el){
  var label = el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("aria-placeholder") || el.getAttribute("data-placeholder") || el.innerText || el.getAttribute("title") || el.getAttribute("name") || el.value || "";
  label = String(label).replace(/\s+/g, " ").trim().slice(0, 80);
  if (!label && __ronicIsEditor(el)) label = "prompt";
  return label;
}
function __ronicPushControl(out, el){
  if (!el || out.length > 400) return;
  var tag = String(el.tagName || "").toLowerCase();
  var type = String(el.getAttribute("type") || "").toLowerCase();
  if (tag === "input" && (type === "hidden" || type === "file")) return;
  if (el.disabled) return;
  if (!el.getClientRects().length) return;
  var r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return;
  if (__ronicIsEditor(el)) tag = "input";
  out.push({ i: out.length + 1, el: el, tag: tag, label: __ronicLabel(el), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
}
function __ronicWalk(root, out, depth){
  if (!root || depth > 6 || out.length > 400) return;
  var list;
  try { list = root.querySelectorAll("a,button,input,select,textarea,[role=button],[role=textbox],[role=searchbox],[role=combobox],[role=tab],[contenteditable=true],[data-slate-editor=true]"); }
  catch (e) { return; }
  for (var i = 0; i < list.length; i++) __ronicPushControl(out, list[i]);
  var hosts;
  try { hosts = root.querySelectorAll("*"); } catch (e2) { return; }
  var cap = hosts.length < 1500 ? hosts.length : 1500;
  for (var j = 0; j < cap; j++) {
    if (hosts[j].shadowRoot) __ronicWalk(hosts[j].shadowRoot, out, depth + 1);
  }
}
function __ronicControls(){
  var out = [];
  __ronicWalk(document, out, 0);
  return out;
}
function __ronicIsFlow(){
  var href = String(location.href || "");
  return href.indexOf("labs.google") !== -1 && href.indexOf("/flow") !== -1;
}
function __ronicComposerScore(el){
  if (!__ronicIsEditor(el)) return 0;
  if (el.id === "PINHOLE_TEXT_AREA_ELEMENT_ID") return 100;
  if (el.getAttribute("data-slate-editor") === "true") return 90;
  var hint = String((el.getAttribute("placeholder") || "") + " " + (el.getAttribute("aria-label") || "") + " " + (el.getAttribute("aria-placeholder") || "")).toLowerCase();
  if (hint.indexOf("video") !== -1 || hint.indexOf("generate") !== -1 || hint.indexOf("prompt") !== -1 || hint.indexOf("describe") !== -1) return 80;
  if (String(el.getAttribute("role") || "") === "textbox") return 50;
  if (String(el.tagName || "").toLowerCase() === "textarea") return 40;
  return 10;
}
function __ronicBestComposer(list){
  var best = null, score = 0;
  for (var i = 0; i < list.length; i++) {
    var s = __ronicComposerScore(list[i].el);
    if (s > score) { score = s; best = list[i].el; }
  }
  return best ? { el: best, score: score } : null;
}
function __ronicBlocker(list){
  var host = String(location.hostname || "");
  if (host === "accounts.google.com" || host.indexOf(".accounts.google.com") !== -1) return "sign-in";
  var best = __ronicBestComposer(list);
  var score = best ? best.score : 0;
  if (__ronicIsFlow() && score < 40) return "no-composer";
  if (score >= 40) return "composer-ready";
  for (var i = 0; i < list.length; i++) {
    var label = String(list[i].label || "").toLowerCase();
    if (label === "sign in" || label === "sign in with google") return "sign-in";
  }
  return "";
}
function __ronicFailCode(code){
  return { ok: false, error: String(code), url: String(location.href || ""), title: String(document.title || "") };
}
function __ronicTypeTarget(list, index){
  var direct = list[index];
  if (direct && __ronicIsEditor(direct.el)) return { el: direct.el, via: "control" };
  var best = __ronicBestComposer(list);
  if (best && best.score >= 80) return { el: best.el, via: "composer" };
  return null;
}
function __ronicHolds(got, wanted){
  var have = String(got || "").replace(/\s+/g, " ").trim();
  var need = String(wanted || "").replace(/\s+/g, " ").trim();
  if (!need) return false;
  var slice = need.slice(0, need.length < 48 ? need.length : 48);
  return have.indexOf(slice) !== -1;
}
function __ronicWrite(el, value){
  try { el.scrollIntoView({ block: "nearest", inline: "nearest" }); } catch (_) {}
  var rect = el.getBoundingClientRect();
  document.dispatchEvent(new CustomEvent("ronic-virtual-cursor", { detail: { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), tag: "input" } }));
  el.focus();
  var tag = String(el.tagName || "").toLowerCase();
  var editable = el.isContentEditable || el.getAttribute("contenteditable") === "true" || el.getAttribute("data-slate-editor") === "true";
  if ((tag === "textarea" || tag === "input") && !editable) {
    var proto = tag === "textarea" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, value); else el.value = value;
    try { el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value })); }
    catch (e) { el.dispatchEvent(new Event("input", { bubbles: true })); }
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return String(el.value || "");
  }
  var sel = window.getSelection();
  if (sel) {
    var range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
  }
  try { document.execCommand("insertText", false, value); } catch (e2) {}
  var live = String(el.innerText || el.textContent || "");
  if (!__ronicHolds(live, value)) {
    try { el.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: value })); } catch (e3) {}
    try { document.execCommand("insertText", false, value); } catch (e4) {}
    live = String(el.innerText || el.textContent || "");
  }
  return live;
}
function __ronicScore(q, label, tag){
  var l = String(label).toLowerCase(), t = String(tag).toLowerCase();
  if (!q) return 0;
  if (l === q) return 100;
  if (l.split(" ").indexOf(q) !== -1) return 80;
  if (l.indexOf(q) === 0) return 70;
  if (l.indexOf(q) !== -1) return 50;
  if ((t + " " + l).indexOf(q) !== -1) return 30;
  return 0;
}
function __ronicAdDecision(inAd, label, disabled) {
  if (!inAd) return "";
  var text = String(label || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!text || disabled || text.indexOf("skip in") !== -1) return "waiting";
  if (text === "skip" || text === "skip ad" || text === "skip ads" || text.indexOf("skip ad") === 0) return "skip";
  return "waiting";
}
function __ronicFindSkip() {
  var direct = document.querySelector(".ytp-ad-skip-button-modern, .ytp-ad-skip-button, .ytp-skip-ad-button, .videoAdUiSkipButton");
  if (direct) return direct;
  var root = document.querySelector(".html5-video-player.ad-showing, .ad-showing, .ima-ad-container, .videoAdUi, .ytp-ad-player-overlay");
  if (!root) return null;
  var list = root.querySelectorAll("button, [role=button]");
  for (var i = 0; i < list.length; i++) {
    var label = __ronicLabel(list[i]).toLowerCase();
    if (label === "skip" || label === "skip ad" || label === "skip ads" || label.indexOf("skip ad") === 0 || label.indexOf("skip in") === 0) return list[i];
  }
  return null;
}
function __ronicFire(el, x, y) {
  if (!el) return;
  var rect = el.getBoundingClientRect();
  if (x == null) {
    x = Math.round(rect.left + rect.width / 2);
    y = Math.round(rect.top + rect.height / 2);
  }
  document.dispatchEvent(new CustomEvent("ronic-virtual-cursor", { detail: { x: x, y: y, tag: String(el.tagName || "bot").toLowerCase() } }));
  var common = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 };
  var types = ["pointerover", "pointerdown", "mousedown", "pointerup", "mouseup"];
  for (var i = 0; i < types.length; i++) {
    var type = types[i];
    try { el.dispatchEvent(type.indexOf("pointer") === 0 ? new PointerEvent(type, common) : new MouseEvent(type, common)); } catch (e) {}
  }
  try { el.click(); } catch (e2) {}
}
function __ronicShown(el) {
  if (!el || !el.getClientRects().length) return false;
  var r = el.getBoundingClientRect();
  return r.width > 2 && r.height > 2;
}
function __ronicInAd() {
  if (document.querySelector(".html5-video-player.ad-showing")) return true;
  var overlay = document.querySelector(".ytp-ad-player-overlay, .videoAdUi");
  if (overlay && __ronicShown(overlay)) return true;
  var skip = document.querySelector(".ytp-ad-skip-button-modern, .ytp-ad-skip-button, .ytp-skip-ad-button, .videoAdUiSkipButton");
  return !!(skip && __ronicShown(skip));
}
function __ronicAdState() {
  if (!__ronicInAd()) { window.__ronicAdSeen = 0; return ""; }
  if (!window.__ronicAdSeen) window.__ronicAdSeen = Date.now();
  var skip = __ronicFindSkip();
  var disabled = !!(skip && (skip.disabled || skip.getAttribute("aria-disabled") === "true" || !skip.getClientRects().length));
  if (__ronicAdDecision(true, skip ? __ronicLabel(skip) : "", disabled) === "skip" && skip) {
    __ronicFire(skip);
    window.__ronicAdSeen = 0;
    return "skipped";
  }
  if (!skip && (Date.now() - window.__ronicAdSeen) > 5000) return "unskippable";
  return "waiting";
}
function __ronicArmAdWatch() {
  if (window.__ronicAdWatch) return;
  window.__ronicAdWatch = setInterval(function () { try { __ronicAdState(); } catch (e) {} }, 400);
}
function __ronicCanScroll(el) {
  if (!el || el === document.body || el === document.documentElement) return false;
  var style;
  try { style = getComputedStyle(el); } catch (e) { return false; }
  var oy = style.overflowY;
  if (oy !== "auto" && oy !== "scroll" && oy !== "overlay") return false;
  return el.scrollHeight > el.clientHeight + 8;
}
function __ronicScroll(sign) {
  var dy = sign * Math.max(320, Math.round((window.innerHeight || 800) * 0.75));
  var x = Math.round((window.innerWidth || 800) / 2);
  var y = Math.round((window.innerHeight || 600) / 2);
  var el = document.elementFromPoint(x, y);
  var guard = 0;
  while (el && guard < 25) {
    if (__ronicCanScroll(el)) {
      var before = el.scrollTop;
      el.scrollTop = before + dy;
      if (el.scrollTop !== before) return;
    }
    el = el.parentElement;
    guard++;
  }
  var root = document.scrollingElement || document.documentElement;
  if (root) root.scrollTop = (root.scrollTop || 0) + dy;
}
function __ronicPageMoves() {
  var root = document.scrollingElement || document.documentElement;
  if (root && root.scrollHeight > (window.innerHeight || 800) + 160) return true;
  var x = Math.round((window.innerWidth || 800) / 2);
  var y = Math.round((window.innerHeight || 600) / 2);
  var el = document.elementFromPoint(x, y);
  var guard = 0;
  while (el && guard < 25) {
    if (__ronicCanScroll(el)) return true;
    el = el.parentElement;
    guard++;
  }
  return false;
}
function __ronicPlace(el) {
  try { el.scrollIntoView({ block: "nearest", inline: "nearest" }); } catch (_) {}
  var r = el.getBoundingClientRect();
  var x = Math.round(r.left + r.width / 2);
  var y = Math.round(r.top + Math.min(r.height / 2, 20));
  var maxX = Math.max(1, (window.innerWidth || 1) - 2);
  var maxY = Math.max(1, (window.innerHeight || 1) - 2);
  if (x < 1) x = 1;
  if (y < 1) y = 1;
  if (x > maxX) x = maxX;
  if (y > maxY) y = maxY;
  var skip = __ronicFindSkip();
  for (var step = 0; step < 5; step++) {
    var top = document.elementFromPoint(x, y);
    if (!top || top === el || (el.contains && el.contains(top)) || (top.contains && top.contains(el))) break;
    if (skip && (skip === top || (skip.contains && skip.contains(top)))) break;
    y = Math.min(maxY, y + 24);
  }
  return { x: x, y: y };
}
function __ronicSameTabLink(el) {
  if (!el || !el.closest) return null;
  var tag = String(el.tagName || "").toLowerCase();
  if (tag === "button" || tag === "input" || tag === "textarea" || tag === "select") return null;
  if (el.closest("button, input, textarea, select")) return null;
  var anchor = el.closest("a[href]");
  if (!anchor) return null;
  if (String(anchor.getAttribute("target") || "").toLowerCase() === "_blank") return null;
  var href = String(anchor.href || "");
  if (!/^https?:/i.test(href) || href === String(location.href)) return null;
  return anchor;
}
function __ronicPress(el) {
  var ad = __ronicAdState();
  if (ad === "skipped") return { note: "skipped the ad", goto: "" };
  var place = __ronicPlace(el);
  var top = document.elementFromPoint(place.x, place.y);
  var skip = __ronicFindSkip();
  if (top && skip && el !== top && !(el.contains && el.contains(top)) && (skip === top || (skip.contains && skip.contains(top)))) {
    __ronicFire(top, place.x, place.y);
    return { note: "skipped the ad covering that control", goto: "" };
  }
  var anchor = __ronicSameTabLink(el);
  if (anchor) {
    var href = String(anchor.href || "");
    document.dispatchEvent(new CustomEvent("ronic-virtual-cursor", { detail: { x: place.x, y: place.y, tag: "a" } }));
    // shortcut: a synthetic click does not follow the link. Rust opens `goto`. Upgrade when element.click() navigates on its own.
    return { note: "opened " + href.slice(0, 180), goto: href };
  }
  __ronicFire(el, place.x, place.y);
  return { note: "", goto: "" };
}
function __ronicCollect(){
  try {
    __ronicArmAdWatch();
    var ad = __ronicAdState();
    var nodes = [];
    var controls = __ronicControls();
    var editors = [];
    var rest = [];
    for (var i = 0; i < controls.length; i++) {
      if (__ronicIsEditor(controls[i].el)) editors.push(controls[i]); else rest.push(controls[i]);
    }
    var picked = editors.concat(rest);
    for (var n = 0; n < picked.length && nodes.length < 40; n++) {
      nodes.push({ id: picked[n].i, tag: picked[n].tag, label: picked[n].label, x: picked[n].x, y: picked[n].y });
    }
    var text = document.body && document.body.innerText ? String(document.body.innerText) : "";
    text = text.replace(/\s+/g, " ").trim();
    if (text.length > 1200) text = text.slice(0, 1200);
    var media = null;
    var video = document.querySelector("video");
    if (video || ad) {
      media = { playing: !ad && !!video && video.paused === false && video.currentTime > 0, paused: !!video && video.paused === true && !ad, currentTime: video ? Math.round((video.currentTime || 0) * 10) / 10 : 0, duration: video ? Math.round((video.duration || 0) * 10) / 10 : 0, muted: !!(video && video.muted === true), ad: ad };
    }
    return { url: String(location.href || ""), title: String(document.title || ""), text: text, nodes: nodes, ready: String(document.readyState || ""), media: media, blocker: __ronicBlocker(controls) };
  } catch (error) {
    return { url: "", title: "", text: "", nodes: [], ready: "error", media: null, error: String(error) };
  }
}"#;

/// Plain sync collect. ExecuteScript in this WebView2 runtime does NOT await
/// returned promises (it hands back `{}`), so every drive script must return
/// a plain object; waiting happens in Rust (poll_read_hit).
fn mini_collect_js() -> String {
    format!("(function(){{\n{MINI_COLLECT_FN}\nreturn __ronicCollect();\n}})()")
}

/// `id` is the 1-based control id from a `read`; the query index is 0-based.
/// Clicks run synchronously and return plain objects; the control is scrolled
/// into view first so an off-screen id still lands, and the fresh page state
/// is gathered by poll_read_hit right after.
fn mini_click_js(id: i64) -> String {
    let index = id.saturating_sub(1).max(0);
    format!(
        r#"(function(){{
  {MINI_COLLECT_FN}
  try {{
    var list = __ronicControls();
    var c = list[{index}];
    if (!c) return {{ ok: false, error: "no control at that index — read the page again for fresh ids" }};
    var pressed = __ronicPress(c.el);
    return {{ ok: true, note: (pressed && pressed.note) || "", goto: (pressed && pressed.goto) || "" }};
  }} catch (error) {{
    return {{ ok: false, error: String(error) }};
  }}
}})()"#
    )
}

fn mini_type_js(id: i64, text: &str) -> String {
    let index = id.saturating_sub(1).max(0);
    let encoded = serde_json::to_string(text).unwrap_or_else(|_| "\"\"".into());
    format!(
        r#"(function(){{
  {MINI_COLLECT_FN}
  try {{
    var list = __ronicControls();
    var chosen = __ronicTypeTarget(list, {index});
    if (!chosen) {{
      var blocker = __ronicBlocker(list);
      if (blocker === "sign-in" || blocker === "no-composer") return __ronicFailCode(blocker);
      if (!list[{index}]) return __ronicFailCode("no control at that index — read the page again for fresh ids");
      return __ronicFailCode("not a text field");
    }}
    var value = {encoded};
    var wrote = __ronicWrite(chosen.el, value);
    if (!__ronicHolds(wrote, value)) return __ronicFailCode("prompt-rejected");
    var note = chosen.via === "composer"
      ? "Wrote the prompt into the page composer. The numbered control was not a text field."
      : "Wrote the prompt into the text field.";
    if (__ronicIsFlow()) note += " Click Create to start generation.";
    return {{ ok: true, note: note }};
  }} catch (error) {{
    return __ronicFailCode(String(error));
  }}
}})()"#
    )
}

/// Smart click: scores every visible control against the query, picks the
/// best match itself, scrolls it into view, and clicks — one tool call
/// instead of read → find → click. Falls back with a helpful error.
fn mini_smart_click_js(query: &str) -> String {
    let encoded = serde_json::to_string(&query.to_lowercase()).unwrap_or_else(|_| "\"\"".into());
    format!(
        r#"(function(){{
  {MINI_COLLECT_FN}
  var q = {encoded};
  try {{
    var best = null, bestScore = 0;
    var controls = __ronicControls();
    for (var i = 0; i < controls.length; i++) {{
      var s = __ronicScore(q, controls[i].label, controls[i].tag);
      if (s > bestScore || (s === bestScore && best && controls[i].y < best.y)) {{ best = controls[i]; bestScore = s; }}
    }}
    if (!best || bestScore < 30) return {{ ok: false, error: "no visible control matching \"" + q + "\" — read the page and click by id instead" }};
    var pressed = __ronicPress(best.el);
    return {{ ok: true, note: (pressed && pressed.note) || "", goto: (pressed && pressed.goto) || "", chosen: {{ id: best.i, tag: best.tag, label: best.label }} }};
  }} catch (error) {{
    return {{ ok: false, error: String(error) }};
  }}
}})()"#
    )
}

/// Scrolls the page by a viewport step. direction is "down" or "up".
fn mini_scroll_js(direction: &str) -> String {
    let sign = if direction == "up" { -1 } else { 1 };
    format!(
        r#"(function(){{
  {MINI_COLLECT_FN}
  try {{
    __ronicScroll({sign});
    return {{ ok: true }};
  }} catch (error) {{
    return {{ ok: false, error: String(error) }};
  }}
}})()"#
    )
}

/// Finds visible controls whose label or tag matches the query, ranked by
/// relevance (exact > whole word > prefix > substring) — lets the agent reach
/// controls beyond the 40 the read caps at (forms, shops).
fn mini_find_js(query: &str) -> String {
    let encoded = serde_json::to_string(&query.to_lowercase()).unwrap_or_else(|_| "\"\"".into());
    format!(
        r#"(function(){{
  {MINI_COLLECT_FN}
  var q = {encoded};
  try {{
    var scored = [];
    var controls = __ronicControls();
    for (var i = 0; i < controls.length; i++) {{
      var s = __ronicScore(q, controls[i].label, controls[i].tag);
      if (s >= 30) scored.push({{ s: s, c: controls[i] }});
    }}
    scored.sort(function (a, b) {{ return b.s - a.s || a.c.y - b.c.y; }});
    var hits = [];
    for (var j = 0; j < scored.length && hits.length < 15; j++) {{
      hits.push({{ id: scored[j].c.i, tag: scored[j].c.tag, label: scored[j].c.label, x: scored[j].c.x, y: scored[j].c.y }});
    }}
    if (hits.length === 0) {{
      var scrollable = __ronicPageMoves();
      return {{ ok: false, error: "no visible control matching \"" + q + "\"" + (scrollable ? " — the page scrolls; try scroll_page then find_control again, or click_control with match" : " — try a shorter word") }};
    }}
    var page = __ronicCollect();
    return {{ ok: true, url: page.url, title: page.title, text: page.text, nodes: hits, media: page.media }};
  }} catch (error) {{
    return {{ ok: false, error: String(error) }};
  }}
}})()"#
    )
}

/// Same host + path (query ignored) — a navigation to the wanted page counts
/// as committed once this matches.
fn same_host_path(live: &str, expected: &str) -> bool {
    let Ok(live) = url::Url::parse(live) else { return false };
    let Ok(expected) = url::Url::parse(expected) else { return false };
    live.host_str() == expected.host_str()
        && live.path().trim_end_matches('/') == expected.path().trim_end_matches('/')
}

/// One collect eval turned into a hit, or None while the page is not usable
/// yet (loading, blank, or still on the previous document).
fn collect_once(win: &DriveSurface, label: &str, started: std::time::Instant, expected: Option<&str>, deadline: std::time::Instant) -> Option<MiniWindowHit> {
    let remaining = deadline.saturating_duration_since(std::time::Instant::now()).min(std::time::Duration::from_secs(3));
    let raw = eval_window_json(win, &mini_collect_js(), remaining).ok()?;
    let mut value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    if value.get("ok").and_then(|v| v.as_bool()) == Some(false) {
        return None;
    }
    if let Some(object) = value.as_object_mut() {
        object.insert("windowLabel".into(), serde_json::json!(label));
        object.insert("ms".into(), serde_json::json!(started.elapsed().as_millis() as i64));
    }
    let hit: MiniWindowHit = serde_json::from_value(value).ok()?;
    let usable = hit.ready == "complete" || hit.ready == "interactive" || !hit.text.is_empty() || !hit.nodes.is_empty();
    let on_page = expected.map(|want| same_host_path(&hit.url, want)).unwrap_or(true);
    if usable && on_page {
        Some(hit)
    } else {
        None
    }
}

/// Polls sync collect evals (each a fast round trip) until the page is usable
/// and — when an expected url is given — that page has committed.
fn mini_submit_js(id: i64) -> String {
    let index = id.saturating_sub(1).max(0);
    format!(r#"(function(){{
  {MINI_COLLECT_FN}
  try {{
    var list = __ronicControls();
    var chosen = __ronicTypeTarget(list, {index});
    if (!chosen || !chosen.el) return {{ ok: false, error: "that control is not an available editor — read the page again" }};
    chosen.el.focus();
    var root = chosen.el.getRootNode ? chosen.el.getRootNode() : document;
    var active = root.activeElement || document.activeElement;
    if (active && active !== chosen.el && __ronicIsEditor(active)) chosen.el = active;
    chosen.el.dispatchEvent(new KeyboardEvent("keydown", {{ key: "Enter", code: "Enter", bubbles: true, cancelable: true }}));
    if (chosen.el.form) chosen.el.form.requestSubmit();
    return {{ ok: true, note: "Submitted from the same editor that received the prompt." }};
  }} catch (error) {{ return {{ ok: false, error: String(error) }}; }}
}})()"#)
}

fn poll_read_hit(win: &DriveSurface, label: &str, started: std::time::Instant, expected: Option<&str>, cap: std::time::Duration) -> Result<MiniWindowHit> {
    let deadline = std::time::Instant::now() + cap;
    loop {
        if EMERGENCY_HALT.load(Ordering::Relaxed) {
            return Err(err("emergency halt is engaged — the human paused all bot computers"));
        }
        if let Some(hit) = collect_once(win, label, started, expected, deadline) {
            return Ok(hit);
        }
        if std::time::Instant::now() >= deadline {
            let live = win.url().map(|url| url.to_string()).unwrap_or_default();
            let where_now = if live.is_empty() { String::new() } else { format!(" ({live})") };
            return Err(err(format!(
                "Stuck: the page did not answer{where_now}. {STILL_IN_CHAT}"
            )));
        }
        thread::sleep(Duration::from_millis(70));
    }
}

// ---------------------------------------------------------------------------
// Agent driver — the chat tools (inspect_page / read_page / click_control /
// type_text) land here so a bot's computer work visibly opens in its own mini
// window instead of a hidden helper webview.
// ---------------------------------------------------------------------------

/// Refuses when the human halted the drivers or took the window over.
fn agent_gate(bot_id: &str) -> Result<()> {
    if EMERGENCY_HALT.load(Ordering::Relaxed) {
        return Err(err("emergency halt is engaged — the human paused all bot computers"));
    }
    let map = mini_windows();
    if let Some(instance) = map.get(bot_id.trim()) {
        if instance.mode == "human_takeover" {
            return Err(err("the human has taken this bot's window over"));
        }
    }
    Ok(())
}

/// Agent URL policy: https anywhere, http only for local servers — the same
/// rule the bot screen always applied.
pub fn agent_url_allowed(raw: &str) -> Result<url::Url> {
    let parsed = crate::workspace_apps::page_url(raw)?;
    if parsed.scheme() == "http" && !crate::workspace_apps::local_port_open(&parsed) {
        return Err(err("that local server is not running"));
    }
    Ok(parsed)
}

/// Makes sure the bot's mini computer (shell window + Chrome webview) is open
/// and, when a url is given, on that page in a Chrome tab. Never steals focus
/// from the user's foreground app — the window simply appears.
pub fn agent_ensure_mini_window(
    app: &AppHandle,
    home: &std::path::Path,
    bot_id: &str,
    bot_handle: &str,
    url: Option<&str>,
) -> Result<String> {
    let bot_id = bot_id.trim().to_string();
    if bot_id.is_empty() {
        return Err(err("that bot has no computer of its own"));
    }
    let parsed = match url.map(str::trim).filter(|value| !value.is_empty()) {
        Some(target) => Some(agent_url_allowed(target)?),
        None => None,
    };
    if let Some(target) = parsed {
        open_chrome_tab(app, home, &bot_id, bot_handle, target, true)?;
    }
    Ok(mini_label(&bot_id)?)
}

/// Last control snapshot per bot — the raw material for Tier-2 stale-control
/// healing. `note_agent_drive` refreshes it on every successful drive action.
fn last_controls() -> &'static Mutex<HashMap<String, Vec<MiniWindowNode>>> {
    static LAST: OnceLock<Mutex<HashMap<String, Vec<MiniWindowNode>>>> = OnceLock::new();
    LAST.get_or_init(|| Mutex::new(HashMap::new()))
}

fn describe_node(node: Option<&MiniWindowNode>) -> String {
    match node {
        Some(n) if n.label.trim().is_empty() => format!("{} control", n.tag),
        Some(n) => format!("{} \"{}\"", n.tag, clip80(&n.label)),
        None => "unknown control".into(),
    }
}

/// Re-find an old control in a fresh snapshot by tag + normalized label, with
/// a small proximity bonus. Requires a unique best match — an ambiguous page
/// must not be guessed at; the agent gets a clear error instead of a wrong click.
fn rematch_control(fresh: &[MiniWindowNode], old: &MiniWindowNode) -> Option<i64> {
    let norm = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase();
    let old_label = norm(&old.label);
    let mut best: Option<(i64, i64)> = None;
    let mut runner_up = 0i64;
    for node in fresh {
        let label = norm(&node.label);
        let mut score = 0i64;
        if node.tag == old.tag {
            score += 2;
        }
        if !old_label.is_empty() {
            if label == old_label {
                score += 4;
            } else if label.contains(&old_label) || old_label.contains(&label) {
                score += 2;
            }
        }
        if (node.y - old.y).abs() <= 140 {
            score += 1;
        }
        if score <= 2 {
            continue;
        }
        match best {
            Some((top, _)) if score > top => {
                runner_up = top;
                best = Some((score, node.id));
            }
            Some((top, _)) if score == top => runner_up = score,
            None => best = Some((score, node.id)),
            _ => {}
        }
    }
    match best {
        Some((score, id)) if score > runner_up => Some(id),
        _ => None,
    }
}

/// Tier-2 selector auto-heal: a control id from a previous read goes stale
/// when the page navigates or re-renders under the agent. Re-snapshot the
/// page, re-resolve the same control from the last snapshot, and act on the
/// fresh id. Returns the hit plus the id actually acted on.
fn heal_stale_control(app: &AppHandle, label: &str, bot_id: &str, kind: &str, id: i64, text: Option<&str>) -> Result<(MiniWindowHit, i64)> {
    let stale = last_controls()
        .lock()
        .ok()
        .and_then(|map| map.get(bot_id.trim()).cloned())
        .and_then(|nodes| nodes.into_iter().find(|node| node.id == id));
    let Some(old) = stale else {
        return Err(err("no control at that index — read the page again for fresh ids"));
    };
    for attempt in 0..3 {
        let fresh = drive_labeled_window(app, label, "read", None, None, None, None)?;
        match rematch_control(&fresh.nodes, &old) {
            Some(new_id) => {
                let hit = drive_labeled_window(app, label, kind, Some(new_id), text, None, None)?;
                let to_desc = describe_node(hit.nodes.iter().find(|node| node.id == new_id));
                let from_desc = describe_node(Some(&old));
                crate::remediation_core::record_selector_heal(bot_id, &format!("[{id}] {from_desc}"), &format!("[{new_id}] {to_desc}"));
                let mut hit = hit;
                hit.note = Some(format!(
                    "auto-healed: [{}] {} → [{}] {} — the page changed under us, so the control was remapped from the last snapshot",
                    id, from_desc, new_id, to_desc
                ));
                return Ok((hit, new_id));
            }
            None if attempt < 2 => thread::sleep(Duration::from_millis(450)),
            None => {
                return Err(err(format!(
                    "control [{}] {} is gone from the fresh page snapshot — read the page and pick a new control",
                    id, describe_node(Some(&old))
                )))
            }
        }
    }
    unreachable!("heal loop returns on every branch")
}

fn note_agent_drive(app: &AppHandle, bot_id: &str, hit: &MiniWindowHit, cursor_at: Option<[i32; 2]>) {
    if !hit.nodes.is_empty() {
        if let Ok(mut map) = last_controls().lock() {
            map.insert(bot_id.trim().to_string(), hit.nodes.iter().take(120).cloned().collect());
        }
    }
    {
        let mut map = mini_windows();
        if let Some(entry) = map.get_mut(bot_id.trim()) {
            entry.current_url_or_app = hit.url.clone();
            entry.status = "bot_driving".into();
            if let Some(at) = cursor_at {
                entry.virtual_cursor_xy = at;
            }
        }
    }
    // The page the agent just read IS the active tab — keep its title/url in
    // the tab strip and the native title bar in sync.
    if !hit.title.is_empty() {
        update_shell_state(bot_id, |state| {
            let target_id = state.active_tab.clone();
            if let Some(tab) = state.tabs.iter_mut().find(|tab| tab.id == target_id) {
                tab.title = clip80(&hit.title);
                tab.url = hit.url.clone();
            }
        });
        sync_window_title(app, bot_id);
    }
    broadcast_shell(app, bot_id, "driven");
    if let Ok(label) = chrome_label(bot_id) {
        if app.get_webview(&label).is_some() {
            crate::site_session::schedule_export(app, &label);
        }
    }
}

const STILL_IN_CHAT: &str = "This chat turn is still running. It is not a background job.";

fn explain_stuck(message: &str) -> crate::error::RonicError {
    if message.starts_with("Stuck:") {
        err(message)
    } else {
        let message: String = message.chars().take(240).collect();
        err(format!("Stuck: {message}. {STILL_IN_CHAT}"))
    }
}

/// Plain status for the chat pill while a browser tool is in flight.
pub fn live_browser_status(tool: &str, detail: &str) -> String {
    let what = match tool {
        "inspect_page" => "Opening the page",
        "read_page" => "Reading the page",
        "type_text" => "Writing the prompt into the page",
        "click_control" => "Clicking a control",
        "wait_for" => "Waiting for the page",
        "scroll_page" => "Scrolling the page",
        "find_control" => "Looking for a control",
        "computer_shell" => "Driving the mini computer",
        _ => "Working in the browser",
    };
    let detail: String = detail.trim().chars().take(80).collect();
    if detail.is_empty() {
        format!("{what}. {STILL_IN_CHAT}")
    } else {
        format!("{what} ({detail}). {STILL_IN_CHAT}")
    }
}

/// The first line that tells the user why the browser step is stuck.
pub fn stuck_line(output: &str) -> Option<String> {
    output.lines().map(str::trim).find(|line| line.starts_with("Stuck:")).map(|line| line.chars().take(280).collect())
}

/// User-facing reason for a page that cannot take a prompt yet.
pub fn page_status_line(url: &str, blocker: &str, title: &str) -> Option<String> {
    let url = url.trim();
    let title = title.trim();
    let titled = if title.is_empty() { String::new() } else { format!(" ({title})") };
    let located = if url.is_empty() { String::new() } else { format!(" at {url}") };
    match blocker {
        "sign-in" => Some(format!(
            "Stuck: Google sign-in is on screen{titled}{located}. The prompt was not written because the composer is not available until sign-in finishes. Finish signing in in this bot's browser. {STILL_IN_CHAT}"
        )),
        "no-composer" => Some(format!(
            "Stuck: the page is open{titled}{located}, but the prompt box is not on this screen. On Google Flow the composer is inside a project, not on the project gallery. Open a project, then the prompt can be written. {STILL_IN_CHAT}"
        )),
        "prompt-rejected" => Some(format!(
            "Stuck: the prompt was sent to the composer and the page did not keep it{titled}{located}. {STILL_IN_CHAT}"
        )),
        _ => None,
    }
}

pub fn explain_from_value(value: &serde_json::Value) -> String {
    let code = value.get("error").and_then(|item| item.as_str()).unwrap_or("the action failed");
    let url = value.get("url").and_then(|item| item.as_str()).unwrap_or("");
    let title = value.get("title").and_then(|item| item.as_str()).unwrap_or("");
    page_status_line(url, code, title).unwrap_or_else(|| {
        if code.starts_with("Stuck:") {
            code.to_string()
        } else {
            let code: String = code.chars().take(240).collect();
            format!("Stuck: {code}. {STILL_IN_CHAT}")
        }
    })
}

pub fn agent_drive_open(app: &AppHandle, state: &crate::AppState, bot_id: &str, bot_handle: &str, url: &str) -> Result<MiniWindowHit> {
    agent_gate(bot_id)?;
    let target = agent_url_allowed(url)?;
    agent_ensure_mini_window(app, &state.home, bot_id, bot_handle, Some(target.as_str()))?;
    // The bot just opened a page on purpose — bring its Chrome to the front of
    // the mini computer so the human sees the work happen.
    {
        let shell = shell_state(bot_id);
        if !shell.tabs.is_empty() && (shell.app != "chrome" || !shell.chrome_visible) {
            update_shell_state(bot_id, |s| {
                s.app = "chrome".into();
                s.chrome_visible = true;
            });
            if let Some(window) = app.get_window(&mini_label(bot_id).unwrap_or_default()) {
                let _ = window.show();
                let _ = window.unminimize();
            }
            apply_chrome_visibility(app, bot_id);
            sync_instance_summary(app, bot_id);
            broadcast_shell(app, bot_id, "chrome");
        }
    }
    // The read script waits in-page for this exact page to commit and become
    // usable, so no fixed sleep is needed here.
    let label = chrome_label(bot_id)?;
    let hit = drive_labeled_window(app, &label, "read", None, None, Some(target.as_str()), None)?;
    let cursor = hit.nodes.first().map(|node| [node.x, node.y]);
    note_agent_drive(app, bot_id, &hit, cursor);
    Ok(hit)
}

/// Resolves the bot's Chrome webview for a drive call, opening the browser
/// (about:blank) when the shell is up but Chrome was never used.
/// If an in-workspace webapp is open beside the chat and no mini computer is active,
/// drive that in-workspace webapp so the bot can seamlessly access and control it.
fn agent_chrome_surface(app: &AppHandle, bot_id: &str) -> Result<String> {
    let label = chrome_label(bot_id)?;
    if app.get_webview(&label).is_some() {
        return Ok(label);
    }
    if let Some(active) = crate::workspace_apps::active_webapp() {
        let web_label = format!("webapp_{active}");
        if app.get_webview(&web_label).is_some() {
            return Ok(web_label);
        }
    }
    let home = crate::util::product_home();
    ensure_chrome(app, &home, bot_id, None)?;
    Ok(label)
}

pub fn agent_drive_workspace_webapp(
    app: &AppHandle,
    bot_id: &str,
    app_id_opt: Option<&str>,
    action: &str,
    control_id: Option<i64>,
    text: Option<&str>,
    query: Option<&str>,
) -> Result<MiniWindowHit> {
    agent_gate(bot_id)?;
    let target_id = if let Some(id) = app_id_opt.filter(|s| !s.trim().is_empty()) {
        id.trim().trim_start_matches("webapp_").to_string()
    } else if let Some(active) = crate::workspace_apps::active_webapp() {
        active
    } else {
        return Err(err("No workspace webapp is currently open on the right side. Open one first with workspace_webapp (action: 'open', app: 'chatgpt')."));
    };
    let label = format!("webapp_{target_id}");
    if app.get_webview(&label).is_none() {
        let _ = crate::workspace_apps::open_workspace_webapp_by_bot(app, &target_id, None, None);
    }
    if app.get_webview(&label).is_none() {
        return Err(err(format!("Workspace webapp '{target_id}' is not open.")));
    }
    let hit = drive_labeled_window(app, &label, action, control_id, text, None, query)?;
    note_agent_drive(app, bot_id, &hit, None);
    Ok(hit)
}

pub fn agent_drive_read(app: &AppHandle, bot_id: &str) -> Result<MiniWindowHit> {
    agent_gate(bot_id)?;
    let label = agent_chrome_surface(app, bot_id)?;
    let hit = drive_labeled_window(app, &label, "read", None, None, None, None)?;
    note_agent_drive(app, bot_id, &hit, None);
    Ok(hit)
}

pub fn agent_drive_click(app: &AppHandle, bot_id: &str, id: i64) -> Result<MiniWindowHit> {
    agent_gate(bot_id)?;
    let label = agent_chrome_surface(app, bot_id)?;
    let wanted = id.max(1);
    let (hit, used) = match drive_labeled_window(app, &label, "click", Some(wanted), None, None, None) {
        Ok(hit) => (hit, wanted),
        // Tier 2: the id went stale (page navigated/re-rendered) — re-resolve.
        Err(error) if error.0.contains("no control at that index") => heal_stale_control(app, &label, bot_id, "click", wanted, None)?,
        Err(error) => return Err(error),
    };
    let cursor = hit.nodes.iter().find(|node| node.id == used).map(|node| [node.x, node.y]);
    note_agent_drive(app, bot_id, &hit, cursor);
    Ok(hit)
}

pub fn agent_drive_type(app: &AppHandle, bot_id: &str, id: i64, text: &str) -> Result<MiniWindowHit> {
    agent_gate(bot_id)?;
    let label = agent_chrome_surface(app, bot_id)?;
    let wanted = id.max(1);
    let (hit, used) = match drive_labeled_window(app, &label, "type", Some(wanted), Some(text), None, None) {
        Ok(hit) => (hit, wanted),
        Err(error) if error.0.contains("no control at that index") => heal_stale_control(app, &label, bot_id, "type", wanted, Some(text))?,
        Err(error) => return Err(error),
    };
    let cursor = hit.nodes.iter().find(|node| node.id == used).map(|node| [node.x, node.y]);
    note_agent_drive(app, bot_id, &hit, cursor);
    Ok(hit)
}

pub fn agent_drive_scroll(app: &AppHandle, bot_id: &str, direction: &str) -> Result<MiniWindowHit> {
    agent_gate(bot_id)?;
    let label = agent_chrome_surface(app, bot_id)?;
    let hit = drive_labeled_window(app, &label, "scroll", None, None, None, Some(direction))?;
    note_agent_drive(app, bot_id, &hit, None);
    Ok(hit)
}

pub fn agent_drive_find(app: &AppHandle, bot_id: &str, query: &str) -> Result<MiniWindowHit> {
    agent_gate(bot_id)?;
    let label = agent_chrome_surface(app, bot_id)?;
    let hit = drive_labeled_window(app, &label, "find", None, None, None, Some(query))?;
    note_agent_drive(app, bot_id, &hit, None);
    Ok(hit)
}

/// Smart click: the page picks the best visible match for the query itself,
/// scrolls it into view, clicks, and the fresh state is read back — one tool
/// call instead of read → find → click. The chosen control rides back in the
/// hit's note so the agent can confirm what it clicked.
pub fn agent_drive_smart_click(app: &AppHandle, bot_id: &str, query: &str) -> Result<MiniWindowHit> {
    agent_gate(bot_id)?;
    let label = agent_chrome_surface(app, bot_id)?;
    let win = get_drive_surface(app, &label)?;
    let started = std::time::Instant::now();
    let raw = eval_window_json(&win, &mini_smart_click_js(&crate::util::prefix_utf8(query, 120)), Duration::from_secs(3)).map_err(|error| explain_stuck(&error.0))?;
    let value: serde_json::Value = serde_json::from_str(&raw).map_err(|_| explain_stuck("the page did not answer with usable JSON"))?;
    if value.get("ok").and_then(|v| v.as_bool()) == Some(false) {
        return Err(err(explain_from_value(&value)));
    }
    let chosen = value
        .get("chosen")
        .map(|c| {
            let id = c.get("id").and_then(|v| v.as_i64()).unwrap_or(0);
            let tag = c.get("tag").and_then(|v| v.as_str()).unwrap_or("control");
            let text = c.get("label").and_then(|v| v.as_str()).unwrap_or("");
            format!("clicked [{id}] {tag} {text}")
        })
        .unwrap_or_else(|| format!("clicked best match for \"{query}\""));
    let press_note = value.get("note").and_then(|item| item.as_str()).unwrap_or("").trim().to_string();
    let goto = value.get("goto").and_then(|item| item.as_str()).filter(|url| !url.is_empty());
    follow_link(&win, goto);
    let mut hit = poll_read_hit(&win, &label, started, goto, Duration::from_millis(if goto.is_some() { 2400 } else { 1200 }))?;
    hit.note = Some(if press_note.is_empty() { chosen } else { format!("{press_note} ({chosen})") });
    note_agent_drive(app, bot_id, &hit, None);
    Ok(hit)
}

/// Waits until a matching control appears (`query`) or the video is actually
/// playing (`media: "playing"`) — either condition satisfies. Polls fast evals
/// under a caller cap. This is the readiness prediction primitive: after a
/// click that loads a page, wait_for once instead of re-reading in a loop.
pub fn agent_drive_wait(app: &AppHandle, bot_id: &str, query: Option<&str>, media: Option<&str>, cap_ms: u64) -> Result<MiniWindowHit> {
    agent_gate(bot_id)?;
    let label = agent_chrome_surface(app, bot_id)?;
    let started = std::time::Instant::now();
    let want_playing = media.map(|m| m.eq_ignore_ascii_case("playing")).unwrap_or(false);
    let wanted = query.map(str::trim).filter(|q| !q.is_empty());
    // A skippable ad shows its button a few seconds in. Give that button time,
    // then press it, instead of treating the ad as the video.
    let cap_ms = if want_playing { cap_ms.max(8_000) } else { cap_ms };
    let deadline = started + Duration::from_millis(cap_ms.clamp(500, 12_000));
    if !want_playing && wanted.is_none() {
        return Err(err("wait_for needs a query like \"add to cart\", or media: \"playing\"."));
    }
    loop {
        agent_gate(bot_id)?;
        if let Some(win) = app.get_webview(&label) {
            let win = DriveSurface::Chrome(win);
            if let Some(hit) = collect_once(&win, &label, started, None, deadline) {
                let ad = hit.media.as_ref().map(|item| item.ad.clone()).unwrap_or_default();
                let playing = hit.media.as_ref().is_some_and(|item| item.playing);
                if want_playing && playing && ad.is_empty() {
                    note_agent_drive(app, bot_id, &hit, None);
                    return Ok(hit);
                }
                if want_playing && ad == "unskippable" {
                    let mut hit = hit;
                    hit.note = Some("an ad is playing and it has no Skip button. Leave this page instead of watching it.".into());
                    note_agent_drive(app, bot_id, &hit, None);
                    return Ok(hit);
                }
            }
        }
        if let Some(q) = wanted {
            if let Ok(hit) = drive_labeled_window(app, &label, "find", None, None, None, Some(q)) {
                note_agent_drive(app, bot_id, &hit, None);
                return Ok(hit);
            }
        }
        if std::time::Instant::now() >= deadline {
            let seen = app.get_webview(&label).and_then(|win| {
                let win = DriveSurface::Chrome(win);
                collect_once(&win, &label, started, None, deadline)
            });
            let where_now = match &seen {
                Some(hit) => format!(" — the page is \"{}\" at {}", hit.title, hit.url),
                None => String::new(),
            };
            let what = match (want_playing, wanted.is_some()) {
                (true, true) => "the video to play or that control to appear",
                (true, false) => "the video to start playing",
                _ => "that control to appear",
            };
            let flow = seen.as_ref().is_some_and(|hit| hit.url.contains("labs.google") && hit.url.contains("/flow"));
            let extra = if flow && want_playing {
                " Video generation keeps running on the page and can take several minutes, so wait again if a clip is rendering."
            } else {
                ""
            };
            return Err(err(format!("Stuck: timed out waiting for {what}{where_now}.{extra} {STILL_IN_CHAT}")));
        }
        thread::sleep(Duration::from_millis(120));
    }
}

/// One-shot snapshot for the agent: which app is open, which Chrome tabs
/// exist, where the active page is.
pub fn shell_summary(app: &AppHandle, bot_id: &str) -> serde_json::Value {
    let shell = shell_state(bot_id);
    let window_open = mini_windows()
        .get(bot_id.trim())
        .is_some_and(|entry| app.get_window(&entry.window_label).is_some());
    serde_json::json!({
        "windowOpen": window_open,
        "app": shell.app,
        "tabs": shell.tabs,
        "activeTab": shell.active_tab,
        "chromeVisible": shell.chrome_visible,
    })
}

/// The agent's `computer_shell` tool — drive the mini computer DESKTOP itself:
/// switch apps, manage Chrome tabs, browser history, or ask for status. This
/// is how the bot makes whole-computer decisions (run a terminal build, check
/// its files, come back to the browser) instead of living in one page.
pub fn shell_control(app: &AppHandle, state: &crate::AppState, bot_id: &str, args: &serde_json::Value) -> (String, serde_json::Value, String) {
    // Models fuse arguments ("open_app terminal") or put the target in app/url —
    // normalize every reasonable shape before matching.
    let mut action = args.get("action").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let mut target_arg = args
        .get("app")
        .or_else(|| args.get("url"))
        .or_else(|| args.get("tab_id"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if let Some(space) = action.find(' ') {
        let (head, rest) = action.split_at(space);
        let rest = rest.trim();
        if matches!(head, "open_app" | "open_tab" | "focus_tab" | "close_tab") && !rest.is_empty() && target_arg.is_empty() {
            target_arg = rest.to_string();
            action = head.to_string();
        }
    }
    if action == "open_app" && target_arg.is_empty() {
        // "terminal" passed as the action itself
        if matches!(args.get("action").and_then(|v| v.as_str()).unwrap_or(""), "chrome" | "files" | "terminal" | "desktop") {
            target_arg = action.clone();
            action = "open_app".into();
        }
    }
    let action = action.as_str();
    let app_for_open = target_arg.as_str();
    let ensure_open = |app: &AppHandle| -> Result<()> {
        ensure_chrome(app, &state.home, bot_id, None).map(|_| ())
    };
    let summary = || shell_summary(app, bot_id);
    let result: Result<String> = (|| {
        match action {
            "status" | "list_tabs" => Ok(serde_json::to_string_pretty(&summary()).unwrap_or_default()),
            "open_app" => {
                let target = app_for_open;
                match target {
                    "chrome" | "browser" => {
                        ensure_open(app)?;
                        if shell_state(bot_id).tabs.is_empty() {
                            return Err(err("chrome has no tabs yet — call computer_shell with action \"open_tab\" and a url"));
                        }
                        update_shell_state(bot_id, |s| {
                            s.app = "chrome".into();
                            s.chrome_visible = true;
                        });
                        apply_chrome_visibility(app, bot_id);
                    }
                    "files" | "explorer" => {
                        ensure_open(app)?;
                        update_shell_state(bot_id, |s| {
                            s.app = "files".into();
                            s.chrome_visible = false;
                        });
                        apply_chrome_visibility(app, bot_id);
                    }
                    "terminal" | "shell" => {
                        ensure_open(app)?;
                        update_shell_state(bot_id, |s| {
                            s.app = "terminal".into();
                            s.chrome_visible = false;
                        });
                        apply_chrome_visibility(app, bot_id);
                    }
                    "desktop" | "home" => {
                        ensure_open(app)?;
                        update_shell_state(bot_id, |s| {
                            s.app = "desktop".into();
                            s.chrome_visible = false;
                        });
                        apply_chrome_visibility(app, bot_id);
                    }
                    other => return Err(err(format!("unknown app \"{other}\" — call computer_shell with action \"open_app\" and app \"terminal\" (or \"chrome\" / \"files\" / \"desktop\")"))),
                }
                sync_instance_summary(app, bot_id);
                broadcast_shell(app, bot_id, "shell");
                Ok(format!("Mini computer app switched to {target}."))
            }
            "open_tab" => {
                let raw = if target_arg.is_empty() { args.get("url").and_then(|v| v.as_str()).unwrap_or("").trim() } else { target_arg.as_str() };
                if raw.is_empty() {
                    return Err(err("open_tab needs a url"));
                }
                let target = agent_url_allowed(raw)?;
                let tab = open_chrome_tab(app, &state.home, bot_id.trim(), "@bot", target, false)?;
                Ok(format!("Opened tab \"{}\" in the mini computer's Chrome.", tab.url))
            }
            "focus_tab" => {
                let id = if target_arg.is_empty() { args.get("tab_id").and_then(|v| v.as_str()).unwrap_or("").trim() } else { target_arg.as_str() };
                let target_url = update_shell_state(bot_id, |s| {
                    s.tabs.iter().find(|tab| tab.id == id).map(|tab| tab.url.clone())
                });
                let Some(target_url) = target_url else {
                    return Err(err(format!("no tab with id \"{id}\" — call list_tabs first")));
                };
                ensure_open(app)?;
                update_shell_state(bot_id, |s| {
                    s.active_tab = id.to_string();
                    s.app = "chrome".into();
                    s.chrome_visible = true;
                });
                ensure_chrome(app, &state.home, bot_id, Some(url::Url::parse(&target_url).map_err(|e| err(e.to_string()))?))?;
                apply_chrome_visibility(app, bot_id);
                broadcast_shell(app, bot_id, "chrome");
                Ok(format!("Focused tab {id} → {target_url}"))
            }
            "close_tab" => {
                let id = if target_arg.is_empty() { args.get("tab_id").and_then(|v| v.as_str()).unwrap_or("").trim() } else { target_arg.as_str() };
                let closed = update_shell_state(bot_id, |s| {
                    let before = s.tabs.len();
                    s.tabs.retain(|tab| tab.id != id);
                    if s.tabs.len() != before {
                        if s.active_tab == id {
                            s.active_tab = s.tabs.last().map(|tab| tab.id.clone()).unwrap_or_default();
                        }
                        true
                    } else {
                        false
                    }
                });
                if !closed {
                    return Err(err(format!("no tab with id \"{id}\"")));
                }
                let shell = shell_state(bot_id);
                if let Some(active) = shell.tabs.iter().find(|tab| tab.id == shell.active_tab) {
                    ensure_chrome(app, &state.home, bot_id, Some(url::Url::parse(&active.url).map_err(|e| err(e.to_string()))?))?;
                } else {
                    ensure_chrome(app, &state.home, bot_id, None)?;
                    update_shell_state(bot_id, |s| s.chrome_visible = false);
                    apply_chrome_visibility(app, bot_id);
                }
                broadcast_shell(app, bot_id, "shell");
                Ok(format!("Closed tab {id}. {} tab(s) remain.", shell_state(bot_id).tabs.len()))
            }
            "back" | "forward" | "reload" => {
                ensure_open(app)?;
                let label = ensure_chrome(app, &state.home, bot_id, None)?;
                let webview = app.get_webview(&label).ok_or_else(|| err("the mini computer browser vanished"))?;
                match action {
                    "back" => {
                        let _ = webview.eval("history.back()");
                    }
                    "forward" => {
                        let _ = webview.eval("history.forward()");
                    }
                    _ => {
                        let current = webview.url().ok();
                        if let Some(current) = current {
                            let _ = webview.navigate(current);
                        }
                    }
                }
                Ok(format!("Browser {} done.", action))
            }
            _other => Err(err("action must be one of: status, list_tabs, open_app, open_tab, focus_tab, close_tab, back, forward, reload")),
        }
    })();
    match result {
        Ok(text) => ("message".into(), summary(), text),
        Err(error) => ("message".into(), summary(), error.0),
    }
}

// ---------------------------------------------------------------------------
// Pillar 2 — native OS UIAutomation driver
// ---------------------------------------------------------------------------

const INTERACTIVE_TYPES: [&str; 8] = ["Button", "Edit", "ComboBox", "CheckBox", "MenuItem", "TabItem", "Hyperlink", "RadioButton"];
const MAX_UIA_NODES: usize = 45;

#[tauri::command]
pub fn inspect_native_os_uia_tree(window_title_filter: String) -> Result<Vec<UIAControlNode>> {
    inspect_and_cache(&window_title_filter)
}

/// Shared walk-and-cache used by the Tauri command and by Code Mode.
pub fn inspect_and_cache(window_title_filter: &str) -> Result<Vec<UIAControlNode>> {
    load_desktop_nodes(window_title_filter)
}

pub fn last_desktop_window() -> String {
    last_uia_filter().clone()
}

fn load_desktop_nodes(window_title_filter: &str) -> Result<Vec<UIAControlNode>> {
    match inspect_uia_nodes(window_title_filter) {
        Ok(nodes) => {
            store_marks(&nodes);
            // An empty request means the foreground window. Clicks re-find that title.
            *last_uia_filter() = resolve_window_filter(window_title_filter);
            Ok(nodes)
        }
        Err(error) => {
            // A failed inspect must not leave the previous window's marks clickable.
            som_marks().clear();
            Err(error)
        }
    }
}

fn store_marks(nodes: &[UIAControlNode]) {
    let mut map = som_marks();
    map.clear();
    for node in nodes {
        map.insert(node.mark_id, node.clone());
    }
}

#[cfg(windows)]
fn resolve_window_filter(filter: &str) -> String {
    let trimmed = filter.trim();
    if trimmed.is_empty() {
        foreground_window_title()
    } else {
        trimmed.to_string()
    }
}

#[cfg(not(windows))]
fn resolve_window_filter(filter: &str) -> String {
    filter.trim().to_string()
}

fn inspect_uia_nodes(window_title_filter: &str) -> Result<Vec<UIAControlNode>> {
    #[cfg(windows)]
    {
        let filter = resolve_window_filter(window_title_filter);
        if filter.is_empty() {
            return Err(err("no window is in front — name the window to inspect"));
        }
        return match uia_walk(&filter) {
            Ok(nodes) if !nodes.is_empty() => Ok(nodes),
            Ok(_) => Err(err(format!("no buttons or text fields in '{filter}'"))),
            Err(message) => Err(err(message)),
        };
    }
    #[cfg(not(windows))]
    {
        let _ = window_title_filter;
        Ok(fallback_nodes())
    }
}

#[cfg(windows)]
fn uia_walk(window_title_filter: &str) -> std::result::Result<Vec<UIAControlNode>, String> {
    use uiautomation::controls::ControlType;
    use uiautomation::patterns::{UIInvokePattern, UIValuePattern};
    use uiautomation::UIAutomation;

    let automation = UIAutomation::new().map_err(|e| e.to_string())?;
    let root = automation.get_root_element().map_err(|e| e.to_string())?;
    let walker = automation.get_control_view_walker().map_err(|e| e.to_string())?;
    let window = matching_top_window(&walker, &root, window_title_filter)
        .ok_or_else(|| format!("no window matching '{window_title_filter}'"))?;
    // Depth-limited BFS from that top-level window. The window itself is not a control.
    let mut frontier = vec![window];

    let mut nodes: Vec<UIAControlNode> = Vec::new();
    let mut depth = 0usize;
    'walk: while depth < 6 {
        let mut next_frontier: Vec<uiautomation::UIElement> = Vec::new();
        for element in &frontier {
            let mut child = match walker.get_first_child(element) {
                Ok(child) => child,
                Err(_) => continue,
            };
            loop {
                let control_type = child.get_control_type().unwrap_or(ControlType::Custom);
                let type_name = format!("{control_type:?}");
                if INTERACTIVE_TYPES.contains(&type_name.as_str()) && nodes.len() < MAX_UIA_NODES {
                    let name = child.get_name().unwrap_or_default();
                    if !name.trim().is_empty() {
                        let rect = child.get_bounding_rectangle().ok();
                        let (x, y, w, h) = rect
                            .map(|r| {
                                let left = r.get_left() as i32;
                                let top = r.get_top() as i32;
                                (left, top, ((r.get_right() as i32) - left).max(16), ((r.get_bottom() as i32) - top).max(16))
                            })
                            .unwrap_or((100, 100, 120, 34));
                        let supports_invoke = child.get_pattern::<UIInvokePattern>().is_ok();
                        let supports_value = child.get_pattern::<UIValuePattern>().is_ok();
                        nodes.push(UIAControlNode {
                            mark_id: (nodes.len() + 1) as u32,
                            control_type: type_name,
                            name: clip80(&name),
                            automation_id: child.get_automation_id().unwrap_or_default(),
                            class_name: child.get_classname().unwrap_or_default(),
                            bounds: [x, y, w, h],
                            center_xy: [x + w / 2, y + h / 2],
                            supports_background_invoke: supports_invoke,
                            supports_background_value: supports_value,
                            origin: "uia".into(),
                        });
                    }
                }
                if nodes.len() >= MAX_UIA_NODES {
                    break 'walk;
                }
                if next_frontier.len() < 200 {
                    next_frontier.push(child.clone());
                }
                match walker.get_next_sibling(&child) {
                    Ok(next) => child = next,
                    Err(_) => break,
                }
            }
            if nodes.len() >= MAX_UIA_NODES {
                break 'walk;
            }
        }
        if next_frontier.is_empty() {
            break;
        }
        frontier = next_frontier;
        depth += 1;
    }
    Ok(nodes)
}

/// Deterministic offline set so the studio, tests, and Code Mode stay usable
/// when no live accessibility tree is reachable (headless runs, non-Windows).
fn fallback_nodes() -> Vec<UIAControlNode> {
    vec![
        UIAControlNode {
            mark_id: 1,
            control_type: "Button".into(),
            name: "Run Build Task".into(),
            automation_id: "workbench.action.tasks.build".into(),
            class_name: "monaco-button".into(),
            bounds: [84, 112, 132, 32],
            center_xy: [150, 128],
            supports_background_invoke: true,
            supports_background_value: false,
            origin: "simulated".into(),
        },
        UIAControlNode {
            mark_id: 2,
            control_type: "Edit".into(),
            name: "Search or Command Input".into(),
            automation_id: "quickInputBox".into(),
            class_name: "input".into(),
            bounds: [260, 48, 420, 34],
            center_xy: [470, 65],
            supports_background_invoke: false,
            supports_background_value: true,
            origin: "simulated".into(),
        },
        UIAControlNode {
            mark_id: 3,
            control_type: "CanvasRegion".into(),
            name: "Unlabelled Chart / WebGL Export Button".into(),
            automation_id: "som_contour_region_3".into(),
            class_name: "canvas-widget".into(),
            bounds: [610, 210, 96, 36],
            center_xy: [658, 228],
            supports_background_invoke: false,
            supports_background_value: false,
            origin: "simulated".into(),
        },
    ]
}

// ---------------------------------------------------------------------------
// Mark execution — background UIA patterns first, WM click fallback second.
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn execute_som_or_uia_action(mark_id: u32, action: String, text_payload: Option<String>) -> Result<String> {
    execute_mark(mark_id, &action, text_payload.as_deref())
}

/// Code Mode entry point (sync — runs on a blocking worker thread).
pub fn som_click_sync(mark_id: u32) -> std::result::Result<String, String> {
    execute_mark(mark_id, "invoke_click", None).map_err(|e| e.0)
}

/// Code Mode entry point (sync).
pub fn som_type_sync(mark_id: u32, text: &str) -> std::result::Result<String, String> {
    execute_mark(mark_id, "set_value", Some(text)).map_err(|e| e.0)
}

fn execute_mark(mark_id: u32, action: &str, text_payload: Option<&str>) -> Result<String> {
    if EMERGENCY_HALT.load(Ordering::Relaxed) {
        return Err(err("emergency halt is engaged — resume the computer drivers first"));
    }
    if action == "set_value" && text_payload.unwrap_or("").is_empty() {
        return Err(err("type needs the text to write"));
    }
    let node = {
        let map = som_marks();
        map.get(&mark_id).cloned().ok_or_else(|| err(format!("mark #{mark_id} is not in the active Set-of-Marks registry — inspect a window first")))?
    };
    let started = std::time::Instant::now();
    let window_title = last_uia_filter().clone();

    #[cfg(windows)]
    {
        if node.origin != "uia" {
            return Err(err(format!("mark #{} is not a live desktop control — inspect the window first", node.mark_id)));
        }
        // Priority 1: real background patterns on a freshly re-resolved element.
        if let Some(message) = try_uia_patterns(&node, action, text_payload, &window_title, &started) {
            return Ok(message);
        }
        // Typing that missed the value pattern must not become a click.
        if action == "set_value" {
            return Err(err(format!("mark #{} ({}) did not accept the text", node.mark_id, node.name)));
        }
        // Priority 2: posted click into the window's client area — never SendInput,
        // so the physical cursor stays wherever the human left it.
        if let Some(message) = try_posted_click(&node, &window_title, &started) {
            return Ok(message);
        }
        Err(err(format!(
            "mark #{} ({}) could not be driven: no live UIA element and no target window",
            node.mark_id, node.name
        )))
    }
    #[cfg(not(windows))]
    {
        let _ = started;
        let _ = window_title;
        describe_simulated_action(&node, action, text_payload)
    }
}

#[cfg(windows)]
fn try_uia_patterns(
    node: &UIAControlNode,
    action: &str,
    text_payload: Option<&str>,
    window_title: &str,
    started: &std::time::Instant,
) -> Option<String> {
    use uiautomation::patterns::{UIInvokePattern, UIValuePattern};
    use uiautomation::UIAutomation;

    let filter = if window_title.trim().is_empty() { return None } else { window_title.to_string() };
    let automation = UIAutomation::new().ok()?;
    let root = automation.get_root_element().ok()?;
    let walker = automation.get_control_view_walker().ok()?;

    let root_element = matching_top_window(&walker, &root, &filter)?;
    let mut stack = vec![root_element];
    let mut visited = 0usize;
    while let Some(element) = stack.pop() {
        visited += 1;
        if visited > 400 {
            break;
        }
        let name = element.get_name().unwrap_or_default();
        let automation_id = element.get_automation_id().unwrap_or_default();
        let same = names_match(&node.name, &name) && (node.automation_id.is_empty() || automation_id == node.automation_id);
        if same {
            let ms = started.elapsed().as_millis();
            return match action {
                "set_value" => {
                    let pattern = element.get_pattern::<UIValuePattern>().ok()?;
                    let text = text_payload.unwrap_or_default();
                    pattern.set_value(text).ok()?;
                    if !pattern.get_value().ok().is_some_and(|actual| uia_value_matches(&actual, text)) {
                        return None;
                    }
                    Some(format!(
                        "✓ [OS UIAutomation ValuePattern] set \"{text}\" on #{} {} ({}) in {ms}ms — physical OS mouse untouched.",
                        node.mark_id, node.name, node.automation_id
                    ))
                }
                _ => {
                    let pattern = element.get_pattern::<UIInvokePattern>().ok()?;
                    pattern.invoke().ok()?;
                    Some(format!(
                        "✓ [OS UIAutomation InvokePattern] triggered #{} {} ({}) in {ms}ms — physical OS mouse untouched.",
                        node.mark_id, node.name, node.automation_id
                    ))
                }
            };
        }
        if let Ok(child) = walker.get_first_child(&element) {
            let mut current = child;
            loop {
                stack.push(current.clone());
                match walker.get_next_sibling(&current) {
                    Ok(next) => current = next,
                    Err(_) => break,
                }
            }
        }
    }
    None
}

#[cfg(windows)]
fn try_posted_click(node: &UIAControlNode, window_title: &str, started: &std::time::Instant) -> Option<String> {
    use windows::Win32::Foundation::{LPARAM, WPARAM};
    use windows::Win32::Graphics::Gdi::ScreenToClient;
    use windows::Win32::UI::WindowsAndMessaging::{PostMessageW, WM_LBUTTONDOWN, WM_LBUTTONUP};

    let filter = if window_title.trim().is_empty() { return None } else { window_title.to_string() };
    let hwnd = find_window_by_title(&filter)?;
    let mut point = windows::Win32::Foundation::POINT { x: node.center_xy[0], y: node.center_xy[1] };
    unsafe {
        if !ScreenToClient(hwnd, &mut point).as_bool() {
            return None;
        }
        let lparam = LPARAM((((point.y as i16 as i32) << 16) | (point.x as i16 as i32)) as isize);
        // MK_LBUTTON is 0x0001; posting straight to the window leaves the
        // physical cursor exactly where the human left it.
        if PostMessageW(Some(hwnd), WM_LBUTTONDOWN, WPARAM(1usize), lparam).is_err() {
            return None;
        }
        if PostMessageW(Some(hwnd), WM_LBUTTONUP, WPARAM(0usize), lparam).is_err() {
            return None;
        }
    }
    let ms = started.elapsed().as_millis();
    Some(format!(
        "✓ [SoM posted click] Mark #{} ({}) delivered WM_LBUTTONDOWN/UP at client ({}, {}) in {ms}ms — cursor never moved.",
        node.mark_id, node.name, point.x, point.y
    ))
}

#[cfg(not(windows))]
fn describe_simulated_action(node: &UIAControlNode, action: &str, text_payload: Option<&str>) -> Result<String> {
    let ms = 3;
    if action == "set_value" && node.supports_background_value {
        return Ok(format!(
            "✓ [simulated UIAutomation ValuePattern] set \"{}\" on #{} {} in {ms}ms (offline host — no live accessibility tree).",
            text_payload.unwrap_or_default(),
            node.mark_id,
            node.automation_id
        ));
    }
    if node.supports_background_invoke {
        return Ok(format!(
            "✓ [simulated UIAutomation InvokePattern] triggered #{} {} in {ms}ms (offline host).",
            node.mark_id, node.name
        ));
    }
    Ok(format!(
        "✓ [simulated SoM click] mark #{} resolved to pixel ({}, {}) on the offline canvas.",
        node.mark_id, node.center_xy[0], node.center_xy[1]
    ))
}

// ---------------------------------------------------------------------------
// Pillar 3 — Set-of-Marks annotated snapshot
// ---------------------------------------------------------------------------

const SOM_WIDTH: u32 = 960;
const SOM_HEIGHT: u32 = 540;

#[tauri::command]
pub fn generate_som_annotated_snapshot(window_title: String) -> Result<SoMAnnotatedSnapshot> {
    let started = std::time::Instant::now();
    let nodes = load_desktop_nodes(&window_title)?;

    let mut capture_source = "simulated_canvas".to_string();
    let mut canvas = image::RgbaImage::from_pixel(SOM_WIDTH, SOM_HEIGHT, image::Rgba([248, 250, 252, 255]));

    #[cfg(windows)]
    {
        let filter = resolve_window_filter(&window_title);
        if !filter.is_empty() {
            if let Some((captured, hwnd)) = capture_window_buffer(&filter) {
                capture_source = format!("printwindow:{filter}");
                // Map UIA screen rects into the captured client space, then
                // into the downscaled snapshot.
                let mut rects: Vec<(i32, i32, i32, i32, &UIAControlNode)> = Vec::new();
                for node in &nodes {
                    let mut point = windows::Win32::Foundation::POINT { x: node.bounds[0], y: node.bounds[1] };
                    unsafe {
                        let _ = windows::Win32::Graphics::Gdi::ScreenToClient(hwnd, &mut point);
                    }
                    rects.push((point.x, point.y, node.bounds[2], node.bounds[3], node));
                }
                let (img_w, img_h) = (captured.width(), captured.height());
                let scale_x = SOM_WIDTH as f32 / img_w.max(1) as f32;
                let scale_y = SOM_HEIGHT as f32 / img_h.max(1) as f32;
                let mut canvas = image::imageops::resize(&captured, SOM_WIDTH, SOM_HEIGHT, image::imageops::FilterType::Triangle);
                for (x, y, w, h, node) in rects {
                    let sx = (x as f32 * scale_x) as i32;
                    let sy = (y as f32 * scale_y) as i32;
                    let sw = ((w as f32 * scale_x) as u32).clamp(20, SOM_WIDTH.saturating_sub(sx.max(0) as u32)).max(20);
                    let sh = ((h as f32 * scale_y) as u32).clamp(14, SOM_HEIGHT.saturating_sub(sy.max(0) as u32)).max(14);
                    if sx < SOM_WIDTH as i32 && sy < SOM_HEIGHT as i32 {
                        draw_mark(&mut canvas, sx.max(2), sy.max(2), sw, sh, node.mark_id, mark_is_background_capable(node));
                    }
                }
                return Ok(finish_snapshot(canvas, &filter, capture_source, started, nodes));
            }
        }
    }

    // No live buffer: lay the marks out on the neutral canvas at their own
    // coordinates so the registry still matches what is drawn.
    for node in &nodes {
        let [x, y, w, h] = node.bounds;
        let cx = x.clamp(4, 900);
        let cy = y.clamp(24, 490);
        let cw = (w as u32).clamp(24, (SOM_WIDTH - 10).saturating_sub(cx as u32)).max(24);
        let ch = (h as u32).clamp(20, (SOM_HEIGHT - 10).saturating_sub(cy as u32)).max(20);
        draw_mark(&mut canvas, cx, cy, cw, ch, node.mark_id, mark_is_background_capable(node));
    }
    Ok(finish_snapshot(canvas, &resolve_window_filter(&window_title), capture_source, started, nodes))
}

fn mark_is_background_capable(node: &UIAControlNode) -> bool {
    node.supports_background_invoke || node.supports_background_value
}

fn finish_snapshot(
    canvas: image::RgbaImage,
    window_title: &str,
    capture_source: String,
    started: std::time::Instant,
    nodes: Vec<UIAControlNode>,
) -> SoMAnnotatedSnapshot {
    let mut png: Vec<u8> = Vec::new();
    canvas
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .expect("encoding an in-memory PNG cannot fail");
    let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &png);
    SoMAnnotatedSnapshot {
        window_title: window_title.to_string(),
        capture_source,
        capture_ms: started.elapsed().as_millis().min(u128::from(u32::MAX)) as u32,
        total_marks: nodes.len(),
        annotated_image_base64: format!("data:image/png;base64,{b64}"),
        mark_registry: nodes,
    }
}

const EMERALD: image::Rgba<u8> = image::Rgba([16, 185, 129, 255]);
const AMBER: image::Rgba<u8> = image::Rgba([245, 158, 11, 255]);
const INK: image::Rgba<u8> = image::Rgba([17, 17, 17, 255]);
const PAPER: image::Rgba<u8> = image::Rgba([255, 255, 255, 255]);

/// Draws the bounding box plus the solid `#111111` badge with the mark number
/// in a 3x5 bitmap digit font — no font files, fully deterministic.
fn draw_mark(canvas: &mut image::RgbaImage, x: i32, y: i32, w: u32, h: u32, mark_id: u32, background_capable: bool) {
    use imageproc::drawing::{draw_filled_rect_mut, draw_hollow_rect_mut};
    use imageproc::rect::Rect;

    let box_color = if background_capable { EMERALD } else { AMBER };
    let width = w.min(canvas.width().saturating_sub(x.max(0) as u32)).max(20);
    let height = h.min(canvas.height().saturating_sub(y.max(0) as u32)).max(14);
    if width == 0 || height == 0 {
        return;
    }
    draw_hollow_rect_mut(canvas, Rect::at(x, y).of_size(width, height), box_color);

    let digits = format!("#{mark_id}");
    let glyph_w = 4i32; // 3px glyph + 1px spacing
    let badge_w = digits.len() as i32 * glyph_w + 4;
    let badge_h = 9;
    let badge_x = x;
    let badge_y = (y - badge_h).max(0);
    draw_filled_rect_mut(
        canvas,
        Rect::at(badge_x, badge_y).of_size(badge_w.max(10) as u32, badge_h as u32),
        INK,
    );
    let mut pen_x = badge_x + 2;
    for ch in digits.chars() {
        if let Some(glyph) = glyph_pixels(ch) {
            for (gx, gy) in glyph {
                let px = pen_x + gx;
                let py = badge_y + 2 + gy;
                if px >= 0 && py >= 0 && (px as u32) < canvas.width() && (py as u32) < canvas.height() {
                    canvas.put_pixel(px as u32, py as u32, PAPER);
                }
            }
        }
        pen_x += glyph_w;
    }
}

/// 3x5 glyphs as (x, y) pixel offsets, drawn top-down.
fn glyph_pixels(ch: char) -> Option<Vec<(i32, i32)>> {
    const D0: &[(i32, i32)] = &[(0,0),(1,0),(2,0),(0,1),(2,1),(0,2),(2,2),(0,3),(2,3),(0,4),(1,4),(2,4)];
    const D1: &[(i32, i32)] = &[(1,0),(1,1),(1,2),(1,3),(1,4)];
    const D2: &[(i32, i32)] = &[(0,0),(1,0),(2,0),(2,1),(0,2),(1,2),(2,2),(0,3),(0,4),(1,4),(2,4)];
    const D3: &[(i32, i32)] = &[(0,0),(1,0),(2,0),(2,1),(0,2),(1,2),(2,2),(2,3),(0,4),(1,4),(2,4)];
    const D4: &[(i32, i32)] = &[(0,0),(2,0),(0,1),(2,1),(0,2),(1,2),(2,2),(2,3),(2,4)];
    const D5: &[(i32, i32)] = &[(0,0),(1,0),(2,0),(0,1),(0,2),(1,2),(2,2),(2,3),(0,4),(1,4),(2,4)];
    const D6: &[(i32, i32)] = &[(0,0),(1,0),(2,0),(0,1),(0,2),(1,2),(2,2),(0,3),(2,3),(0,4),(1,4),(2,4)];
    const D7: &[(i32, i32)] = &[(0,0),(1,0),(2,0),(2,1),(2,2),(2,3),(2,4)];
    const D8: &[(i32, i32)] = &[(0,0),(1,0),(2,0),(0,1),(2,1),(0,2),(1,2),(2,2),(0,3),(2,3),(0,4),(1,4),(2,4)];
    const D9: &[(i32, i32)] = &[(0,0),(1,0),(2,0),(0,1),(2,1),(0,2),(1,2),(2,2),(2,3),(0,4),(1,4),(2,4)];
    const HASH: &[(i32, i32)] = &[(1,0),(1,1),(1,2),(1,3),(1,4),(0,1),(2,1),(0,3),(2,3)];
    match ch {
        '#' => Some(HASH.to_vec()),
        '0' => Some(D0.to_vec()),
        '1' => Some(D1.to_vec()),
        '2' => Some(D2.to_vec()),
        '3' => Some(D3.to_vec()),
        '4' => Some(D4.to_vec()),
        '5' => Some(D5.to_vec()),
        '6' => Some(D6.to_vec()),
        '7' => Some(D7.to_vec()),
        '8' => Some(D8.to_vec()),
        '9' => Some(D9.to_vec()),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Emergency halt — flips a process-wide gate every driver checks.
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn trigger_emergency_computer_halt(app: AppHandle) -> Result<String> {
    let previous = EMERGENCY_HALT.fetch_xor(true, Ordering::SeqCst);
    let engaged = !previous;
    let message = if engaged {
        "🛑 EMERGENCY HALT ENGAGED. All bot computer drivers are paused (<10ms)."
    } else {
        "▶ Resumed autonomous bot computer drivers."
    };
    let _ = app.emit("ronic://computer-halt", serde_json::json!({ "engaged": engaged, "message": message }));
    Ok(message.to_string())
}

#[tauri::command]
pub fn computer_halt_status() -> bool {
    EMERGENCY_HALT.load(Ordering::Relaxed)
}

/// Plain sync accessor for Code Mode.
pub fn halt_engaged() -> bool {
    EMERGENCY_HALT.load(Ordering::Relaxed)
}

// ---------------------------------------------------------------------------
// Windows helpers
// ---------------------------------------------------------------------------

#[cfg(windows)]
fn hwnd_title(hwnd: windows::Win32::Foundation::HWND) -> String {
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowTextLengthW, GetWindowTextW};
    unsafe {
        let len = GetWindowTextLengthW(hwnd);
        if len <= 0 {
            return String::new();
        }
        let mut buf = vec![0u16; len as usize + 1];
        let _ = GetWindowTextW(hwnd, &mut buf);
        String::from_utf16_lossy(&buf)
    }
}

#[cfg(windows)]
fn foreground_window_title() -> String {
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            String::new()
        } else {
            hwnd_title(hwnd)
        }
    }
}

/// shortcut: the walker has no z-order, so the foreground title wins when it matches. Upgrade when the tree exposes z-order.
#[cfg(windows)]
fn matching_top_window(
    walker: &uiautomation::UITreeWalker,
    root: &uiautomation::UIElement,
    needle: &str,
) -> Option<uiautomation::UIElement> {
    let needle = fold_name(needle);
    if needle.is_empty() {
        return None;
    }
    let foreground = fold_name(&foreground_window_title());
    let mut cursor = walker.get_first_child(root).ok()?;
    let mut first_contains: Option<uiautomation::UIElement> = None;
    loop {
        let name = fold_name(&cursor.get_name().unwrap_or_default());
        let class = cursor.get_classname().unwrap_or_default().to_lowercase();
        let contains = name.contains(&needle) || class.contains(&needle);
        if contains && !foreground.is_empty() && name == foreground {
            return Some(cursor);
        }
        if contains && first_contains.is_none() {
            first_contains = Some(cursor.clone());
        }
        match walker.get_next_sibling(&cursor) {
            Ok(next) => cursor = next,
            Err(_) => break,
        }
    }
    first_contains
}

#[cfg(windows)]
fn find_window_by_title(filter: &str) -> Option<windows::Win32::Foundation::HWND> {
    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, GetForegroundWindow, IsWindowVisible};

    let needle = fold_name(filter);
    if needle.is_empty() {
        return None;
    }
    unsafe {
        let foreground = GetForegroundWindow();
        if !foreground.0.is_null() && fold_name(&hwnd_title(foreground)).contains(&needle) {
            return Some(foreground);
        }
    }
    let mut found: Option<isize> = None;
    let mut collected: Vec<isize> = Vec::new();
    unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> windows::core::BOOL {
        let sink = unsafe { &mut *(lparam.0 as *mut Vec<isize>) };
        sink.push(hwnd.0 as isize);
        true.into()
    }
    let sink_ptr = LPARAM(&mut collected as *mut Vec<isize> as isize);
    unsafe {
        let _ = EnumWindows(Some(collect), sink_ptr);
    }
    for raw in collected {
        let hwnd = HWND(raw as *mut _);
        unsafe {
            if !IsWindowVisible(hwnd).as_bool() {
                continue;
            }
        }
        if fold_name(&hwnd_title(hwnd)).contains(&needle) {
            found = Some(raw);
            break;
        }
    }
    found.map(|raw| HWND(raw as *mut _))
}

/// Captures the target window's client buffer via PrintWindow at native
/// resolution. Returns the RGBA image plus the HWND so rects can be mapped
/// from screen space into client space.
#[cfg(windows)]
fn capture_window_buffer(title_filter: &str) -> Option<(image::RgbaImage, windows::Win32::Foundation::HWND)> {
    use windows::Win32::Foundation::RECT;
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetWindowDC, ReleaseDC, SelectObject,
        BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS,
    };
    use windows::Win32::Storage::Xps::PrintWindow;
    use windows::Win32::UI::WindowsAndMessaging::GetClientRect;

    let hwnd = find_window_by_title(title_filter)?;
    let mut rect = RECT::default();
    unsafe {
        GetClientRect(hwnd, &mut rect).ok()?;
    }
    let width = (rect.right - rect.left).max(1) as u32;
    let height = (rect.bottom - rect.top).max(1) as u32;
    if width > 4000 || height > 4000 {
        return None;
    }

    unsafe {
        let window_dc = GetWindowDC(Some(hwnd));
        if window_dc.is_invalid() {
            return None;
        }
        let memory_dc = CreateCompatibleDC(Some(window_dc));
        let bitmap = CreateCompatibleBitmap(window_dc, width as i32, height as i32);
        let old = SelectObject(memory_dc, bitmap.into());

        let mut info = BITMAPINFO::default();
        info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        info.bmiHeader.biWidth = width as i32;
        info.bmiHeader.biHeight = -(height as i32); // top-down rows
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        info.bmiHeader.biCompression = windows::Win32::Graphics::Gdi::BI_RGB.0;

        let mut buffer = vec![0u8; (width * height * 4) as usize];

        // PW_CLIENTONLY | PW_RENDERFULLCONTENT: render the live client content
        // (DWM-composited, works for hardware-accelerated windows) into our bitmap.
        let rendered = PrintWindow(hwnd, memory_dc, windows::Win32::Storage::Xps::PRINT_WINDOW_FLAGS(3));
        let copied = GetDIBits(
            window_dc,
            bitmap,
            0,
            height,
            Some(buffer.as_mut_ptr() as *mut std::ffi::c_void),
            &mut info,
            DIB_RGB_COLORS,
        );

        SelectObject(memory_dc, old);
        let _ = DeleteObject(bitmap.into());
        let _ = DeleteDC(memory_dc);
        let _ = ReleaseDC(Some(hwnd), window_dc);

        if copied <= 0 || !rendered.as_bool() {
            return None;
        }
        // GDI hands back BGRA; flip into RGBA.
        for px in buffer.chunks_exact_mut(4) {
            px.swap(0, 2);
        }
        image::RgbaImage::from_raw(width, height, buffer).map(|img| (img, hwnd))
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_text_must_be_retained_and_halt_is_real() {
        assert!(uia_value_matches("line 1\r\nline 2", "line 1\nline 2"));
        assert!(!uia_value_matches("truncated", "the full prompt"));
        assert!(BOT_MINI_WINDOW_HUD_SCRIPT.contains("ronic-halt:engage"));
        assert!(mini_submit_js(2).contains("__ronicTypeTarget(list, 1)"));
        assert!(!mini_submit_js(2).contains("var list = document.querySelectorAll"));
    }

    #[test]
    fn fallback_registry_roundtrips_through_marks() {
        let nodes = fallback_nodes();
        assert_eq!(nodes.len(), 3);
        let mut map = HashMap::new();
        for node in &nodes {
            map.insert(node.mark_id, node.clone());
        }
        assert_eq!(map.get(&2).unwrap().control_type, "Edit");
        assert!(mark_is_background_capable(&nodes[0]));
        assert!(!mark_is_background_capable(&nodes[2]));
    }

    fn sample(id: u32, name: &str, origin: &str) -> UIAControlNode {
        UIAControlNode {
            mark_id: id,
            control_type: "Button".into(),
            name: name.into(),
            automation_id: String::new(),
            class_name: String::new(),
            bounds: [0, 0, 10, 10],
            center_xy: [5, 5],
            supports_background_invoke: true,
            supports_background_value: false,
            origin: origin.into(),
        }
    }

    #[test]
    fn pick_mark_prefers_the_live_exact_name_and_refuses_ties() {
        let nodes = vec![
            sample(1, "Run Build Task", "simulated"),
            sample(2, "Save", "uia"),
            sample(3, "Save as", "uia"),
            sample(4, "Open file", "uia"),
        ];
        assert_eq!(pick_mark(&nodes, "Save").unwrap(), 2);
        assert_eq!(pick_mark(&nodes, "file").unwrap(), 4);
        assert_eq!(pick_mark(&nodes, "open").unwrap(), 4);
        assert!(pick_mark(&nodes, "Run Build Task").unwrap_err().contains("no desktop control"));
        let tied = vec![sample(1, "Close tab", "uia"), sample(2, "Close window", "uia")];
        let err = pick_mark(&tied, "Close").unwrap_err();
        assert!(err.contains("more than one"), "{err}");
        assert!(names_match("Save", "save"));
        assert!(names_match("Save   file", "save file"));
        assert!(!names_match("Save", "Save as"));
        let clipped = "a".repeat(80);
        assert!(names_match(&clipped, &format!("{clipped} and more")));
        assert_eq!(resolve_desktop_mark(&serde_json::json!({"mark_id": "4"})).unwrap(), 4);
        assert_eq!(resolve_desktop_mark(&serde_json::json!({"id": 7})).unwrap(), 7);
        assert!(resolve_desktop_mark(&serde_json::json!({"mark_id": 0})).is_err());
        assert!(resolve_desktop_mark(&serde_json::json!({})).unwrap_err().contains("mark id"));
    }

    #[test]
    fn labels_reject_path_components() {
        assert_eq!(mini_label("dots").unwrap(), "ronic_mini_comp_dots");
        assert!(mini_label("../evil").is_err());
        assert!(mini_label("bot/evil").is_err());
        assert!(squad_label("grok-bot").unwrap().starts_with("ronic_squad_comp_"));
        assert!(mini_browser_dir(std::path::Path::new("/tmp"), "dots").is_ok());
        assert!(mini_browser_dir(std::path::Path::new("/tmp"), "..").is_err());
    }

    #[test]
    fn glyphs_cover_all_ten_digits_and_hash() {
        for ch in "0123456789#".chars() {
            let glyph = glyph_pixels(ch).unwrap_or_else(|| panic!("missing glyph {ch}"));
            assert!(!glyph.is_empty());
            for (x, y) in glyph {
                assert!((0..3).contains(&x));
                assert!((0..5).contains(&y));
            }
        }
        assert!(glyph_pixels('z').is_none());
    }

    #[test]
    fn badges_render_on_canvas_without_panicking() {
        let mut canvas = image::RgbaImage::from_pixel(SOM_WIDTH, SOM_HEIGHT, image::Rgba([255, 255, 255, 255]));
        draw_mark(&mut canvas, 10, 40, 120, 40, 7, true);
        draw_mark(&mut canvas, 400, 300, 90, 30, 12, false);
        // Badge ink is present somewhere near the box origin.
        let pixel = canvas.get_pixel(11, 33);
        assert_eq!(*pixel, INK);
    }

    #[test]
    fn driver_scripts_embed_index_and_payload() {
        // Control ids are 1-based; the injected selector index is 0-based.
        let click = mini_click_js(3);
        assert!(click.contains("list[2]"));
        let typed = mini_type_js(5, "ronic-release");
        assert!(typed.contains("list[4]"));
        assert!(typed.contains("ronic-release"));
        let collect = mini_collect_js();
        assert!(collect.contains("[role=button]"));
        // The smart layer: visibility filter, scoring, scroll-into-view.
        let smart = mini_smart_click_js("add to cart");
        assert!(smart.contains("__ronicScore"));
        assert!(smart.contains("__ronicPress"));
        assert!(click.contains("__ronicPress"));
        assert!(typed.contains("nearest"));
        assert!(!click.contains("block: \"center\""));
        assert!(collect.contains("__ronicAdDecision"));
        assert!(collect.contains("__ronicArmAdWatch"));
        assert!(collect.contains("__ronicScroll"));
        assert!(!BOT_MINI_WINDOW_HUD_SCRIPT.contains("left:50%"));
        assert!(mini_find_js("cart").contains("__ronicScore"));
        // Google Flow's composer is a React textarea or a Slate editor. Setting
        // .value / textContent does not reach either, so the writer must use
        // the native value setter and execCommand('insertText'), then check
        // that the text actually stayed.
        assert!(typed.contains("HTMLTextAreaElement"));
        assert!(typed.contains("execCommand"));
        assert!(typed.contains("insertText"));
        assert!(typed.contains("PINHOLE_TEXT_AREA_ELEMENT_ID"));
        assert!(typed.contains("data-slate-editor"));
        assert!(typed.contains("shadowRoot"));
        assert!(typed.contains("prompt-rejected"));
        assert!(!typed.contains("textContent = value"));
        // ExecuteScript in this WebView2 does not await promises — a returned
        // Promise serialized as {} and every read died with "missing field
        // url". Drive scripts must stay plain sync objects, never promises.
        for script in [&click, &typed, &smart, &mini_scroll_js("down"), &mini_find_js("cart"), &collect] {
            assert!(!script.contains("new Promise"), "drive script must not return a promise");
            assert!(script.trim_end().ends_with("})()"), "drive script must close its IIFE");
        }
    }

    #[test]
    fn halt_gate_defaults_open() {
        assert!(!EMERGENCY_HALT.load(Ordering::Relaxed));
        assert!(!computer_halt_status());
    }

    fn node(id: i64, tag: &str, label: &str, y: i32) -> MiniWindowNode {
        MiniWindowNode { id, tag: tag.into(), label: label.into(), x: 10, y }
    }

    #[test]
    fn tier2_rematch_finds_the_same_control_after_a_reshuffle() {
        // The page re-rendered: ids shifted, but the same button exists.
        let old = node(4, "button", "Add to cart", 300);
        let fresh = vec![
            node(1, "input", "Search products", 60),
            node(2, "a", "Home", 120),
            node(3, "button", "Add to cart", 310),
            node(4, "button", "Buy now", 380),
        ];
        assert_eq!(rematch_control(&fresh, &old), Some(3));
    }

    #[test]
    fn tier2_rematch_survives_label_whitespace_and_case_changes() {
        let old = node(2, "button", "  Sign   In ", 200);
        let fresh = vec![node(7, "button", "sign in", 205)];
        assert_eq!(rematch_control(&fresh, &old), Some(7));
    }

    #[test]
    fn tier2_rematch_refuses_ambiguous_pages() {
        // Two equally plausible matches must not be guessed between.
        let old = node(5, "button", "Remove", 400);
        let fresh = vec![
            node(1, "button", "Remove", 410),
            node(2, "button", "Remove", 430),
        ];
        assert_eq!(rematch_control(&fresh, &old), None);
    }

    #[test]
    fn tier2_rematch_rejects_unrelated_controls() {
        let old = node(3, "button", "Checkout", 500);
        let fresh = vec![node(1, "input", "Search", 80), node(2, "a", "Docs", 140)];
        assert_eq!(rematch_control(&fresh, &old), None);
    }

    #[test]
    fn flow_status_says_why_it_is_stuck_and_that_the_turn_is_live() {
        let sign_in = page_status_line("https://accounts.google.com/signin", "sign-in", "Sign in").unwrap();
        assert!(sign_in.starts_with("Stuck:"));
        assert!(sign_in.contains("Finish signing in"));
        assert!(sign_in.contains("not a background job"));
        let gallery = page_status_line("https://labs.google/fx/tools/flow", "no-composer", "Flow").unwrap();
        assert!(gallery.contains("project"));
        assert!(page_status_line("https://labs.google/fx/tools/flow", "composer-ready", "Flow").is_none());
        let rejected = explain_from_value(&serde_json::json!({"error": "prompt-rejected", "url": "https://labs.google/fx/tools/flow", "title": "Flow"}));
        assert!(rejected.contains("did not keep it"));
        let stale = explain_from_value(&serde_json::json!({"error": "no control at that index — read the page again for fresh ids"}));
        assert!(stale.contains("no control at that index"));
        assert!(stale.starts_with("Stuck:"));
        assert!(stale.contains("not a background job"));
        let live = live_browser_status("type_text", "a cat walking through rain");
        assert!(live.contains("Writing the prompt"));
        assert!(live.contains("not a background job"));
        assert_eq!(
            stuck_line("Wrote nothing\nStuck: the prompt was sent to the composer and the page did not keep it."),
            Some("Stuck: the prompt was sent to the composer and the page did not keep it.".into())
        );
    }

    #[test]
    fn tier2_rematch_lets_an_exact_label_outweigh_a_tag_change() {
        // SPA re-render turned the anchor into a real button, label intact.
        let old = node(6, "a", "Open settings", 220);
        let fresh = vec![node(9, "button", "Open settings", 225)];
        assert_eq!(rematch_control(&fresh, &old), Some(9));
    }
}
