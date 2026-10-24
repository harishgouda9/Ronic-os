//! In-workspace web apps and the desktop apps launched from the chat dock.
//!
//! Web apps are child webviews of the main window. Each one keeps its own
//! WebView2 profile under ~/.omniworkspace/webapps/browser so a login survives
//! and a second site does not share cookies. On Windows a webview that sets
//! its own user agent is blank unless that profile directory is unique.
//! Google and Apple sign-in closes that panel and opens Chrome or Edge on
//! the same EBWebView folder. OpenAI sign-in stays in the panel.

use crate::db;
use crate::error::{err, Result};
use crate::util::{now_ms, run_capture, truncate_utf8, which};
use crate::AppState;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;
use std::sync::OnceLock;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Runtime, WebviewUrl};
use tauri::webview::{Color, NewWindowResponse, PageLoadEvent, WebviewBuilder};

const INSTALLED_KEY: &str = "installed_webapps";

static WEB_LOCK: Mutex<()> = Mutex::new(());
fn bounds_map() -> std::sync::MutexGuard<'static, HashMap<String, WebAppBounds>> {
    static MAP: OnceLock<Mutex<HashMap<String, WebAppBounds>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new())).lock().unwrap_or_else(|poison| poison.into_inner())
}

fn wanted_set() -> std::sync::MutexGuard<'static, HashSet<String>> {
    static MAP: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashSet::new())).lock().unwrap_or_else(|poison| poison.into_inner())
}

#[derive(Clone, Copy)]
struct WebSpec {
    id: &'static str,
    name: &'static str,
    url: &'static str,
}

#[derive(Clone, Copy)]
struct DeskSpec {
    id: &'static str,
    name: &'static str,
    row_id: &'static str,
    winget: &'static str,
    console: bool,
    commands: &'static [&'static str],
}

#[derive(Clone, Copy, Debug, Deserialize)]
pub struct WebAppBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl WebAppBounds {
    pub(crate) fn clamped(self) -> Self {
        Self {
            x: self.x.clamp(-50.0, 8000.0),
            y: self.y.clamp(-50.0, 8000.0),
            width: self.width.clamp(1.0, 8000.0),
            height: self.height.clamp(1.0, 8000.0),
        }
    }
}

#[derive(Serialize)]
pub struct WebAppStatus {
    pub note: String,
    pub installed: Vec<String>,
    pub signing_in: Option<String>,
}

pub struct ShownWebApp {
    pub name: String,
    pub signing_in: Option<String>,
}

fn remember_bounds(label: &str, bounds: WebAppBounds) {
    bounds_map().insert(label.to_string(), bounds);
    wanted_set().insert(label.to_string());
}

pub fn stored_bounds(label: &str) -> Option<WebAppBounds> {
    bounds_map().get(label).copied()
}

pub fn panel_wanted(label: &str) -> bool {
    wanted_set().contains(label)
}

fn clear_wanted() {
    wanted_set().clear();
}

fn web_spec(id: &str) -> Option<WebSpec> {
    Some(match id {
        "chatgpt" => WebSpec { id: "chatgpt", name: "ChatGPT", url: "https://chatgpt.com" },
        "claude" => WebSpec { id: "claude", name: "Claude", url: "https://claude.ai" },
        "gemini" => WebSpec { id: "gemini", name: "Gemini", url: "https://gemini.google.com" },
        "grok" => WebSpec { id: "grok", name: "Grok", url: "https://grok.com" },
        "openrouter" => WebSpec { id: "openrouter", name: "OpenRouter", url: "https://openrouter.ai/keys" },
        "deepseek" => WebSpec { id: "deepseek", name: "DeepSeek", url: "https://chat.deepseek.com" },
        "qwen" => WebSpec { id: "qwen", name: "Qwen", url: "https://chat.qwen.ai" },
        "tokenrouter" => WebSpec { id: "tokenrouter", name: "TokenRouter", url: "https://tokenrouter.io" },
        "bedrock" => WebSpec { id: "bedrock", name: "Bedrock", url: "https://console.aws.amazon.com/bedrock" },
        "nvidia" => WebSpec { id: "nvidia", name: "NVIDIA", url: "https://build.nvidia.com" },
        "meta" => WebSpec { id: "meta", name: "Meta AI", url: "https://meta.ai" },
        "mistral" => WebSpec { id: "mistral", name: "Mistral", url: "https://chat.mistral.ai" },
        "perplexity" => WebSpec { id: "perplexity", name: "Perplexity", url: "https://www.perplexity.ai" },
        "groq" => WebSpec { id: "groq", name: "Groq", url: "https://console.groq.com/keys" },
        "together" => WebSpec { id: "together", name: "Together", url: "https://api.together.ai/settings/api-keys" },
        "cohere" => WebSpec { id: "cohere", name: "Cohere", url: "https://dashboard.cohere.com/api-keys" },
        "copilot" => WebSpec { id: "copilot", name: "Copilot", url: "https://copilot.microsoft.com" },
        _ => return None,
    })
}

fn desk_spec(id: &str) -> Option<DeskSpec> {
    Some(match id {
        "ollama" => DeskSpec { id: "ollama", name: "Ollama", row_id: "app_ollama", winget: "Ollama.Ollama", console: false, commands: &["ollama"] },
        "claude-code" => DeskSpec { id: "claude-code", name: "Claude Code", row_id: "app_claude", winget: "Anthropic.ClaudeCode", console: true, commands: &["claude"] },
        "cursor" => DeskSpec { id: "cursor", name: "Cursor", row_id: "app_cursor", winget: "Anysphere.Cursor", console: false, commands: &["cursor"] },
        "vscode" => DeskSpec { id: "vscode", name: "VS Code", row_id: "app_vscode", winget: "Microsoft.VisualStudioCode", console: false, commands: &["code"] },
        "obsidian" => DeskSpec { id: "obsidian", name: "Obsidian", row_id: "app_obsidian", winget: "Obsidian.Obsidian", console: false, commands: &[] },
        _ => return None,
    })
}

pub fn installed_ids(conn: &Connection) -> Vec<String> {
    let raw = db::kv_get(conn, INSTALLED_KEY).ok().flatten().unwrap_or_else(|| "[]".into());
    let ids: Vec<String> = serde_json::from_str(&raw).unwrap_or_default();
    ids.into_iter().filter(|id| web_spec(id).is_some() || is_custom_id(id)).collect()
}

pub fn mark_installed(conn: &Connection, id: &str) -> Result<Vec<String>> {
    if web_spec(id).is_none() && !is_custom_id(id) {
        return Err(err("unknown web app"));
    }
    let mut ids = installed_ids(conn);
    if !ids.iter().any(|item| item == id) {
        ids.push(id.to_string());
    }
    db::kv_set(conn, INSTALLED_KEY, &serde_json::to_string(&ids)?)?;
    Ok(ids)
}

fn label_for(id: &str) -> String {
    format!("webapp_{id}")
}

fn is_custom_id(id: &str) -> bool {
    let Some(rest) = id.strip_prefix("custom_") else {
        return false;
    };
    (1..=40).contains(&rest.len()) && rest.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn clip_name(name: Option<&str>, fallback: &str) -> String {
    let mut out = String::new();
    for ch in name.unwrap_or("").chars() {
        if ch.is_control() {
            continue;
        }
        if out.chars().count() >= 32 {
            break;
        }
        out.push(ch);
    }
    let trimmed = out.trim();
    if trimmed.is_empty() { fallback.to_string() } else { trimmed.to_string() }
}

fn with_web_scheme(trimmed: &str) -> String {
    if trimmed.contains("://") {
        return trimmed.to_string();
    }
    if let Some(idx) = trimmed.find(':') {
        if let Some(ch) = trimmed[idx + 1..].chars().next() {
            if ch != '/' && !ch.is_ascii_digit() {
                return trimmed.to_string();
            }
        }
    }
    let bare = trimmed.trim_start_matches('/');
    let local = url::Url::parse(&format!("http://{bare}"))
        .ok()
        .and_then(|parsed| parsed.host_str().map(|host| {
            host.eq_ignore_ascii_case("localhost") || host == "127.0.0.1" || host == "::1" || host == "[::1]"
        }))
        .unwrap_or(false);
    if local { format!("http://{bare}") } else { format!("https://{bare}") }
}

fn allowed_web_url(raw: &str) -> Result<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.len() > 2000 || trimmed.chars().any(|ch| ch.is_control() || ch.is_whitespace()) {
        return Err(err("web app address must be an https URL"));
    }
    let parsed = url::Url::parse(&with_web_scheme(trimmed)).map_err(|_| err("web app address must be an https URL"))?;
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(err("web app address must be an https URL"));
    }
    let host = parsed.host_str().unwrap_or("");
    let local = host.eq_ignore_ascii_case("localhost") || host == "127.0.0.1" || host == "::1" || host == "[::1]";
    let ok = match parsed.scheme() {
        "https" => !host.is_empty(),
        "http" => local,
        _ => false,
    };
    if !ok {
        return Err(err("web app address must be an https URL"));
    }
    Ok(parsed.to_string())
}

fn resolve_web(id: &str, url: Option<&str>, name: Option<&str>) -> Result<(String, String, String)> {
    if let Some(spec) = web_spec(id) {
        return Ok((spec.id.to_string(), spec.name.to_string(), spec.url.to_string()));
    }
    if !is_custom_id(id) {
        return Err(err("unknown web app"));
    }
    let address = allowed_web_url(url.unwrap_or(""))?;
    Ok((id.to_string(), clip_name(name, "Web app"), address))
}

pub fn show<R: Runtime>(app: &AppHandle<R>, home: &Path, id: &str, bounds: WebAppBounds, focus: bool, url: Option<&str>, name: Option<&str>) -> Result<ShownWebApp> {
    let _guard = WEB_LOCK.lock().unwrap_or_else(|poison| poison.into_inner());
    let (app_id, app_name, app_url) = resolve_web(id, url, name)?;
    let bounds = bounds.clamped();
    let label = label_for(&app_id);
    remember_bounds(&label, bounds);
    if let Some(message) = crate::site_window::browser_sign_in_message(&label) {
        return Ok(ShownWebApp { name: app_name, signing_in: Some(message) });
    }
    let window = app.get_window("main").ok_or_else(|| err("main window is not open"))?;
    for view in window.webviews() {
        if view.label().starts_with("webapp_") && view.label() != label {
            let _ = view.hide();
        }
    }
    let dir = crate::site_window::profile_dir(home, &label);
    if let Some(existing) = app.get_webview(&label) {
        if let Some(current) = existing.url().ok() {
            if crate::site_window::handoff_if_blocked(app, &label, &dir, &current, &app_url, &app_name) {
                let message = crate::site_window::browser_sign_in_message(&label);
                return Ok(ShownWebApp { name: app_name, signing_in: message });
            }
            if crate::site_window::embedded_auth_blocked(&current) {
                if let Ok(home_url) = app_url.parse() {
                    let _ = existing.navigate(home_url);
                }
            }
        }
        move_view(&existing, bounds)?;
        if existing.url().ok().is_some_and(|url| crate::workspace_bridge::chat_page_url(&url)) {
            let _ = existing.eval(crate::workspace_bridge::PAGE_SCRIPT);
        }
        crate::site_window::prepare_sign_in(&existing, false);
        existing.show().map_err(|error| err(error.to_string()))?;
        if focus {
            let _ = existing.set_focus();
        }
        return Ok(ShownWebApp { name: app_name, signing_in: None });
    }
    if crate::site_window::profile_in_use(&dir) {
        return Err(err(format!("Close the browser sign-in window, then open {app_name} again.")));
    }
    let dir = crate::site_window::ensure_profile(home, &label)?;
    let parsed: url::Url = app_url.parse().map_err(|error: url::ParseError| err(error.to_string()))?;
    let builder = crate::site_window::site_child(
        WebviewBuilder::new(&label, WebviewUrl::External(parsed)),
        dir.clone(),
        app.clone(),
        label.clone(),
        app_url.clone(),
    )
    .background_color(Color(255, 255, 255, 255));
    let created = window
        .add_child(builder, LogicalPosition::new(bounds.x, bounds.y), LogicalSize::new(bounds.width, bounds.height))
        .map_err(|error| err(error.to_string()))?;
    crate::site_window::prepare_sign_in(&created, false);
    crate::site_window::watch_panel(app.clone(), label, dir, app_url, app_name.clone());
    if focus {
        let _ = created.set_focus();
    }
    Ok(ShownWebApp { name: app_name, signing_in: None })
}

pub fn place(app: &AppHandle, id: &str, bounds: WebAppBounds) -> Result<()> {
    if web_spec(id).is_none() && !is_custom_id(id) {
        return Err(err("unknown web app"));
    }
    let bounds = bounds.clamped();
    let label = label_for(id);
    remember_bounds(&label, bounds);
    let Some(existing) = app.get_webview(&label) else {
        return Ok(());
    };
    move_view(&existing, bounds)
}

fn move_view<R: Runtime>(view: &tauri::Webview<R>, bounds: WebAppBounds) -> Result<()> {
    view.set_position(LogicalPosition::new(bounds.x, bounds.y)).map_err(|error| err(error.to_string()))?;
    view.set_size(LogicalSize::new(bounds.width, bounds.height)).map_err(|error| err(error.to_string()))?;
    Ok(())
}

pub fn hide_all(app: &AppHandle) {
    clear_wanted();
    let Some(window) = app.get_window("main") else { return };
    for view in window.webviews() {
        if view.label().starts_with("webapp_") {
            let _ = view.hide();
        }
    }
}

pub fn close_harness_windows(app: &AppHandle) {
    for (label, window) in app.webview_windows() {
        if label.starts_with("harness_") {
            let _ = window.close();
        }
    }
}

pub struct LaunchOutcome {
    pub note: String,
    pub install_choice: Option<String>,
}

fn route_added_desktop(id: &str, path: Option<&str>, name: Option<&str>) -> Result<Option<LaunchOutcome>> {
    if desk_spec(id).is_some() {
        return Ok(None);
    }
    if is_custom_id(id) {
        return Ok(Some(launch_added_program(path.unwrap_or(""), name.unwrap_or(""))?));
    }
    Err(err("unknown desktop app"))
}

pub fn launch_desktop(app: &AppHandle, id: &str, kind: Option<&str>, path: Option<&str>, name: Option<&str>) -> Result<LaunchOutcome> {
    if let Some(outcome) = route_added_desktop(id, path, name)? {
        return Ok(outcome);
    }
    let spec = desk_spec(id).ok_or_else(|| err("unknown desktop app"))?;
    // Built-in apps keep their own executable. A caller-supplied path cannot redirect them.
    let _ = (path, name);
    let kind = match kind {
        None => None,
        Some("desktop") | Some("terminal") => kind,
        Some(other) => return Err(err(format!("unknown install choice: {other}"))),
    };
    if kind == Some("terminal") && spec.id == "obsidian" {
        return Err(err("Obsidian has no terminal app. Install the desktop app instead."));
    }
    // The flag records the historical single edition. A click now detects both.
    let _edition_hint = spec.console;
    let mut editions = detected_editions(spec.id, false);
    absorb_saved(&mut editions, saved_path(app, spec.row_id));
    if editions.desktop.is_none() && editions.terminal.is_none() {
        editions = detected_editions(spec.id, true);
        absorb_saved(&mut editions, saved_path(app, spec.row_id));
    }
    match kind {
        None => {
            if let Some(path) = editions.desktop.clone().or(editions.terminal.clone()) {
                let console = editions.desktop.is_none();
                return open_outcome(app, &spec, &path, console, false);
            }
            Ok(ask_choice(&spec))
        }
        Some(wanted) => {
            let requested = if wanted == "desktop" { editions.desktop.clone() } else { editions.terminal.clone() };
            if let Some(path) = requested {
                return open_outcome(app, &spec, &path, wanted == "terminal", false);
            }
            if let Some(path) = editions.desktop.clone().or(editions.terminal.clone()) {
                let console = editions.desktop.is_none();
                return open_outcome(app, &spec, &path, console, false);
            }
            install_and_open(app, &spec, wanted)
        }
    }
}

fn ask_choice(spec: &DeskSpec) -> LaunchOutcome {
    let note = if spec.id == "obsidian" {
        format!("{} is not installed. It is a desktop app. Install the desktop app?", spec.name)
    } else {
        format!("{} is not installed. Choose a desktop app or a terminal app before anything is installed.", spec.name)
    };
    LaunchOutcome { note, install_choice: Some(spec.id.to_string()) }
}

fn open_outcome(app: &AppHandle, spec: &DeskSpec, path: &Path, console: bool, fresh: bool) -> Result<LaunchOutcome> {
    close_harness_windows(app);
    let pid = launch_file(path, console)?;
    remember(app, spec, path, pid)?;
    let file_name = path.file_name().and_then(|name| name.to_str()).unwrap_or("").to_ascii_lowercase();
    if spec.id == "ollama" && file_name == "ollama.exe" {
        return Ok(LaunchOutcome { note: "Started Ollama on this computer.".into(), install_choice: None });
    }
    let mut note = if fresh {
        format!("Installed {} and opened it.", spec.name)
    } else if console {
        format!("Opened {} in a terminal window.", spec.name)
    } else if file_name.contains("insiders") {
        "Opened VS Code Insiders.".to_string()
    } else {
        format!("Opened {}.", spec.name)
    };
    if fresh && matches!(spec.id, "cursor" | "vscode" | "ollama") {
        note = format!("{note} The terminal command comes with the desktop app.");
    }
    if matches!(spec.id, "claude-code" | "cursor" | "vscode") {
        note = format!("{note} It can use Ronic OS skills, plugins, and memory through the local MCP server. Restart it if it was already open.");
    }
    Ok(LaunchOutcome { note, install_choice: None })
}

fn install_and_open(app: &AppHandle, spec: &DeskSpec, kind: &str) -> Result<LaunchOutcome> {
    let mut why = Vec::new();
    if spec.id == "claude-code" && kind == "desktop" {
        if let Err(error) = try_winget("Anthropic.Claude") {
            return Err(err(format!("Claude's desktop app could not be installed. {}", error.0)));
        }
        if let Some(path) = detected_editions(spec.id, true).desktop {
            return open_outcome(app, spec, &path, false, true);
        }
        return Err(err("Claude's desktop app installer finished, but Claude.exe was not found. The terminal app was not installed."));
    }
    if spec.id == "claude-code" {
        if let Err(error) = try_winget(spec.winget) {
            why.push(error.0);
        }
        let mut editions = detected_editions(spec.id, true);
        if editions.terminal.is_none() {
            if let Err(error) = try_claude_script() {
                why.push(error.0);
            }
            editions = detected_editions(spec.id, true);
        }
        if let Some(path) = editions.terminal {
            return open_outcome(app, spec, &path, true, true);
        }
        let detail = why.into_iter().find(|line| !line.is_empty()).unwrap_or_else(|| "no installer ran".into());
        return Err(err(format!("Claude Code could not be installed. {detail}")));
    }
    if let Err(error) = try_winget(spec.winget) {
        why.push(error.0);
    }
    let editions = detected_editions(spec.id, true);
    let chosen = if kind == "desktop" {
        editions.desktop.clone().or(editions.terminal.clone())
    } else {
        editions.terminal.clone().or(editions.desktop.clone())
    };
    if let Some(path) = chosen {
        let console = edition_of(&path) == "terminal";
        return open_outcome(app, spec, &path, console, true);
    }
    if let Some(url) = installer_url(spec)? {
        let dest = installer_file(app, spec)?;
        let ready = dest.is_file() && dest.metadata().map(|meta| meta.len() > 1_000_000).unwrap_or(false);
        if !ready {
            download_file(&url, &dest)?;
        }
        launch_file(&dest, false)?;
        return Ok(LaunchOutcome {
            note: format!("Downloaded the {} installer and started it. Click {} again after the installer finishes.", spec.name, spec.name),
            install_choice: None,
        });
    }
    let detail = why.into_iter().find(|line| !line.is_empty()).unwrap_or_else(|| "no installer ran".into());
    Err(err(format!("{} could not be installed. {detail}", spec.name)))
}

fn saved_path(app: &AppHandle, row_id: &str) -> Option<PathBuf> {
    let state = app.state::<AppState>();
    let conn = state.conn.lock().unwrap_or_else(|poison| poison.into_inner());
    let path: String = conn
        .query_row("SELECT executable_path FROM linked_local_apps WHERE id=?1", params![row_id], |row| row.get(0))
        .unwrap_or_default();
    usable_path(&path)
}

fn remember(app: &AppHandle, spec: &DeskSpec, path: &Path, pid: u32) -> Result<()> {
    let state = app.state::<AppState>();
    let conn = state.conn.lock().unwrap_or_else(|poison| poison.into_inner());
    let text = path.display().to_string();
    let stored: Option<i64> = if pid == 0 { None } else { Some(pid as i64) };
    let detail = if pid == 0 { "Opened.".to_string() } else { format!("Launched at pid {pid}.") };
    conn.execute(
        "INSERT INTO linked_local_apps (id, app_name, category, executable_path, bridge_protocol, active_pid, status, detail, updated_at)
         VALUES (?1, ?2, 'desktop', ?3, 'native', ?4, 'running', ?5, ?6)
         ON CONFLICT(id) DO UPDATE SET executable_path = excluded.executable_path, active_pid = excluded.active_pid, status = 'running', detail = excluded.detail, updated_at = excluded.updated_at",
        params![spec.row_id, spec.name, text, stored, detail, now_ms()],
    )?;
    Ok(())
}

#[derive(Clone)]
pub(crate) struct Editions {
    pub desktop: Option<PathBuf>,
    pub terminal: Option<PathBuf>,
}

pub(crate) fn detected_editions(id: &str, thorough: bool) -> Editions {
    let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    let profile = std::env::var_os("USERPROFILE").map(PathBuf::from);
    let programs = std::env::var_os("ProgramFiles").map(PathBuf::from);
    let appdata = std::env::var_os("APPDATA").map(PathBuf::from);
    match id {
        "hermes" => hermes_editions(local.as_deref()),
        "grokbot" => grok_editions(programs.as_deref(), local.as_deref()),
        "muse" => muse_editions(local.as_deref()),
        _ => {
            let Some(spec) = desk_spec(id) else {
                return Editions { desktop: None, terminal: None };
            };
            desk_editions(&spec, local.as_deref(), profile.as_deref(), programs.as_deref(), appdata.as_deref(), thorough)
        }
    }
}

fn desk_editions(spec: &DeskSpec, local: Option<&Path>, profile: Option<&Path>, programs: Option<&Path>, appdata: Option<&Path>, thorough: bool) -> Editions {
    let mut desktop = Vec::new();
    let mut terminal = Vec::new();
    match spec.id {
        "cursor" => {
            push_under(&mut desktop, local, &["Programs", "cursor", "Cursor.exe"]);
            push_under(&mut desktop, local, &["Programs", "Cursor", "Cursor.exe"]);
            push_under(&mut desktop, local, &["cursor", "Cursor.exe"]);
            push_under(&mut desktop, programs, &["Cursor", "Cursor.exe"]);
            push_under(&mut terminal, local, &["Programs", "cursor", "resources", "app", "bin", "cursor.cmd"]);
            push_under(&mut terminal, local, &["Programs", "Cursor", "resources", "app", "bin", "cursor.cmd"]);
        }
        "vscode" => {
            push_under(&mut desktop, local, &["Programs", "Microsoft VS Code", "Code.exe"]);
            push_under(&mut desktop, programs, &["Microsoft VS Code", "Code.exe"]);
            push_under(&mut desktop, local, &["Programs", "Microsoft VS Code Insiders", "Code - Insiders.exe"]);
            push_under(&mut desktop, programs, &["Microsoft VS Code Insiders", "Code - Insiders.exe"]);
        }
        "claude-code" => {
            push_under(&mut desktop, local, &["Programs", "Claude", "Claude.exe"]);
            push_under(&mut desktop, local, &["Programs", "AnthropicClaude", "Claude.exe"]);
            push_under(&mut desktop, local, &["AnthropicClaude", "claude.exe"]);
            push_under(&mut desktop, programs, &["Claude", "Claude.exe"]);
            push_under(&mut terminal, profile, &[".local", "bin", "claude.exe"]);
            push_under(&mut terminal, profile, &[".claude", "local", "claude.exe"]);
            push_under(&mut terminal, profile, &[".claude", "bin", "claude.exe"]);
            push_under(&mut terminal, appdata, &["npm", "claude.cmd"]);
        }
        "ollama" => {
            push_under(&mut desktop, local, &["Programs", "Ollama", "ollama app.exe"]);
            push_under(&mut terminal, local, &["Programs", "Ollama", "ollama.exe"]);
            push_under(&mut terminal, local, &["Ollama", "ollama.exe"]);
        }
        "obsidian" => {
            push_under(&mut desktop, local, &["Programs", "Obsidian", "Obsidian.exe"]);
            push_under(&mut desktop, local, &["Obsidian", "Obsidian.exe"]);
            push_under(&mut desktop, programs, &["Obsidian", "Obsidian.exe"]);
        }
        _ => {}
    }
    let mut editions = Editions { desktop: first_file(desktop), terminal: first_file(terminal) };
    if editions.terminal.is_none() {
        if let Some(path) = editions.desktop.as_ref().and_then(|path| sibling_terminal(path)) {
            editions.terminal = Some(path);
        }
    }
    if thorough && editions.terminal.is_none() {
        let mut names: Vec<&str> = spec.commands.to_vec();
        if spec.id == "vscode" {
            names.push("code-insiders");
        }
        editions.terminal = which_terminal(&names);
    }
    editions
}

fn hermes_editions(local: Option<&Path>) -> Editions {
    let Some(local) = local else {
        return Editions { desktop: None, terminal: None };
    };
    Editions {
        desktop: hermes_desktop(local),
        terminal: first_file([local.join("hermes").join("bin").join("hermes.cmd"), local.join("hermes").join("bin").join("hermes.exe")]),
    }
}

fn hermes_desktop(local: &Path) -> Option<PathBuf> {
    let direct = local.join("hermes").join("hermes-agent").join("apps").join("desktop").join("release").join("win-unpacked").join("Hermes.exe");
    if direct.is_file() {
        return Some(direct);
    }
    let release = local.join("hermes").join("hermes-agent").join("apps").join("desktop").join("release");
    if let Ok(entries) = std::fs::read_dir(release) {
        for entry in entries.flatten() {
            let nested = entry.path().join("win-unpacked").join("Hermes.exe");
            if nested.is_file() {
                return Some(nested);
            }
            let flat = entry.path().join("Hermes.exe");
            if flat.is_file() {
                return Some(flat);
            }
        }
    }
    let programs = local.join("Programs").join("Hermes").join("Hermes.exe");
    if programs.is_file() {
        Some(programs)
    } else {
        None
    }
}

fn grok_editions(programs: Option<&Path>, local: Option<&Path>) -> Editions {
    let mut paths = Vec::new();
    if let Some(programs) = programs {
        paths.push(programs.join("Grok Bot").join("Grok Bot.exe"));
    }
    if let Some(local) = local {
        paths.push(local.join("Programs").join("Grok Bot").join("Grok Bot.exe"));
    }
    Editions { desktop: first_file(paths), terminal: None }
}

fn muse_editions(local: Option<&Path>) -> Editions {
    let Some(local) = local else {
        return Editions { desktop: None, terminal: None };
    };
    let dir = local.join("Programs").join("muse");
    let cmd = dir.join("muse.cmd");
    if cmd.is_file() {
        return Editions { desktop: Some(cmd), terminal: None };
    }
    let mut bins = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            if name.starts_with("muse-bin-") && name.ends_with(".exe") {
                bins.push(entry.path());
            }
        }
    }
    bins.sort();
    Editions { desktop: bins.pop(), terminal: None }
}

fn sibling_terminal(desktop: &Path) -> Option<PathBuf> {
    let parent = desktop.parent()?;
    let name = desktop.file_name()?.to_string_lossy().to_ascii_lowercase();
    let candidates = if name == "cursor.exe" {
        vec![parent.join("resources").join("app").join("bin").join("cursor.cmd")]
    } else if name.contains("insiders") {
        vec![parent.join("bin").join("code-insiders.cmd")]
    } else if name == "code.exe" {
        vec![parent.join("bin").join("code.cmd")]
    } else if name == "ollama app.exe" {
        vec![parent.join("ollama.exe")]
    } else {
        Vec::new()
    };
    first_file(candidates)
}

fn which_terminal(commands: &[&str]) -> Option<PathBuf> {
    for command in commands {
        for candidate in [(*command).to_string(), format!("{command}.cmd"), format!("{command}.exe")] {
            let Some(found) = which(&candidate) else { continue };
            let path = PathBuf::from(found);
            if path.is_file() && edition_of(&path) == "terminal" {
                return Some(path);
            }
        }
    }
    None
}

fn push_under(paths: &mut Vec<PathBuf>, base: Option<&Path>, parts: &[&str]) {
    let Some(base) = base else { return };
    let mut path = base.to_path_buf();
    for part in parts {
        path.push(part);
    }
    paths.push(path);
}

fn first_file(paths: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    paths.into_iter().find(|path| path.is_file())
}

fn absorb_saved(editions: &mut Editions, saved: Option<PathBuf>) {
    let Some(saved) = saved else { return };
    if edition_of(&saved) == "desktop" {
        if editions.desktop.is_none() {
            editions.desktop = Some(saved);
        }
    } else if editions.terminal.is_none() {
        editions.terminal = Some(saved);
    }
}

fn edition_of(path: &Path) -> &'static str {
    let text = path.display().to_string().replace('/', "\\").to_ascii_lowercase();
    let name = path.file_name().and_then(|item| item.to_str()).unwrap_or("").to_ascii_lowercase();
    if name.ends_with(".cmd") || name.ends_with(".bat") || name == "cursor" || name == "code" || name == "code-insiders" || name == "ollama.exe" {
        return "terminal";
    }
    if text.contains("\\resources\\app\\bin\\") {
        return "terminal";
    }
    if name == "claude.exe" {
        if text.contains("\\programs\\") || text.contains("program files") {
            return "desktop";
        }
        return "terminal";
    }
    "desktop"
}

fn wants_console(path: &Path) -> bool {
    let text = path.display().to_string().replace('/', "\\").to_ascii_lowercase();
    if text.starts_with("wsl:") {
        return true;
    }
    if text.contains("\\programs\\muse\\") {
        return false;
    }
    edition_of(path) == "terminal"
}

fn usable_path(path: &str) -> Option<PathBuf> {
    if path.is_empty() {
        return None;
    }
    if path.starts_with("wsl:") || Path::new(path).is_file() {
        Some(PathBuf::from(path))
    } else {
        None
    }
}

fn try_winget(package: &str) -> Result<()> {
    if which("winget").is_none() {
        return Err(err("winget is not on PATH"));
    }
    let (code, out) = run_capture(
        "winget",
        &[
            "install",
            "--id",
            package,
            "-e",
            "--scope",
            "user",
            "--accept-package-agreements",
            "--accept-source-agreements",
            "--disable-interactivity",
        ],
        None,
        Duration::from_secs(180),
    )?;
    let lower = out.to_lowercase();
    let ok = code == 0 || lower.contains("already installed") || lower.contains("no available upgrade") || lower.contains("successfully installed");
    if ok {
        Ok(())
    } else {
        Err(err(last_line(&out)))
    }
}

fn try_claude_script() -> Result<()> {
    let (code, out) = run_capture(
        "powershell.exe",
        &["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "irm https://claude.ai/install.ps1 | iex"],
        None,
        Duration::from_secs(180),
    )?;
    if code == 0 {
        Ok(())
    } else {
        Err(err(last_line(&out)))
    }
}

fn installer_url(spec: &DeskSpec) -> Result<Option<String>> {
    match spec.id {
        "ollama" => Ok(Some("https://ollama.com/download/OllamaSetup.exe".into())),
        "cursor" => Ok(Some("https://cursor.com/api/download?platform=win32-x64-user&releaseTrack=stable".into())),
        "vscode" => Ok(Some("https://code.visualstudio.com/sha/download?build=stable&os=win32-x64-user".into())),
        "obsidian" => latest_obsidian_exe().map(Some),
        _ => Ok(None),
    }
}

fn latest_obsidian_exe() -> Result<String> {
    let client = http_client()?;
    let body = client
        .get("https://api.github.com/repos/obsidianmd/obsidian-releases/releases/latest")
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "Ronic OS")
        .send()
        .map_err(|error| err(format!("could not look up the Obsidian installer: {error}")))?
        .error_for_status()
        .map_err(|error| err(format!("could not look up the Obsidian installer: {error}")))?
        .text()
        .map_err(|error| err(error.to_string()))?;
    let value: serde_json::Value = serde_json::from_str(&body)?;
    let url = value["assets"]
        .as_array()
        .and_then(|assets| {
            assets.iter().find_map(|asset| {
                let name = asset["name"].as_str()?;
                let lower = name.to_ascii_lowercase();
                if lower.ends_with(".exe") && lower.contains("obsidian") && !lower.contains("arm") {
                    asset["browser_download_url"].as_str().map(str::to_string)
                } else {
                    None
                }
            })
        })
        .ok_or_else(|| err("the latest Obsidian release has no Windows installer"))?;
    Ok(url)
}

fn installer_file(app: &AppHandle, spec: &DeskSpec) -> Result<PathBuf> {
    let state = app.state::<AppState>();
    let dir = state.home.join("downloads");
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join(format!("{}.exe", spec.id)))
}

fn download_file(url: &str, dest: &Path) -> Result<()> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let partial = dest.with_extension("part");
    let client = http_client()?;
    let mut response = client.get(url).send().map_err(|error| err(format!("download failed: {error}")))?;
    if !response.status().is_success() {
        return Err(err(format!("download failed ({})", response.status())));
    }
    let mut file = std::fs::File::create(&partial)?;
    std::io::copy(&mut response, &mut file).map_err(|error| err(format!("download failed: {error}")))?;
    drop(file);
    if partial.metadata().map(|meta| meta.len() < 1_000_000).unwrap_or(true) {
        let _ = std::fs::remove_file(&partial);
        return Err(err("the downloaded installer was incomplete"));
    }
    if dest.exists() {
        let _ = std::fs::remove_file(dest);
    }
    std::fs::rename(&partial, dest)?;
    Ok(())
}

fn http_client() -> Result<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .timeout(Duration::from_secs(300))
        .user_agent("Ronic OS")
        .build()
        .map_err(|error| err(error.to_string()))
}

pub fn launch_program(path: &Path) -> Result<u32> {
    launch_file(path, wants_console(path))
}

fn launch_added_program(path: &str, name: &str) -> Result<LaunchOutcome> {
    let trimmed = path.trim();
    if trimmed.is_empty() || trimmed.len() > 1024 || trimmed.chars().any(|ch| ch.is_control()) || trimmed.starts_with("wsl:") {
        return Err(err("choose a program file on this computer"));
    }
    let file = Path::new(trimmed);
    if !file.is_file() {
        return Err(err("that program file was not found"));
    }
    let label = clip_name(Some(name), "Desktop app");
    launch_program(file)?;
    Ok(LaunchOutcome { note: format!("Opened {label}."), install_choice: None })
}

fn launch_file(path: &Path, console: bool) -> Result<u32> {
    let text = path.display().to_string();
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_CONSOLE: u32 = 0x00000010;
        if let Some(bin) = text.strip_prefix("wsl:") {
            let mut cmd = Command::new("wsl.exe");
            cmd.args(["-e", bin]).creation_flags(CREATE_NEW_CONSOLE);
            return Ok(cmd.spawn().map_err(|error| err(error.to_string()))?.id());
        }
        let lower = text.to_ascii_lowercase();
        if lower.ends_with(".cmd") || lower.ends_with(".bat") {
            if !console {
                return open_gui(path);
            }
            let mut cmd = Command::new("cmd.exe");
            cmd.args(["/k", &text]).creation_flags(CREATE_NEW_CONSOLE);
            return Ok(cmd.spawn().map_err(|error| err(error.to_string()))?.id());
        }
        if console {
            let mut cmd = Command::new(&text);
            cmd.creation_flags(CREATE_NEW_CONSOLE);
            return Ok(cmd.spawn().map_err(|error| err(error.to_string()))?.id());
        }
        open_gui(path)
    }
    #[cfg(not(windows))]
    {
        let _ = console;
        Ok(Command::new(text).spawn().map_err(|error| err(error.to_string()))?.id())
    }
}

/// CreateProcess and ShellExecute keep the new program in this process's job.
/// Electron apps such as Cursor.exe then exit immediately. explorer.exe starts
/// them outside the job, the same way a desktop shortcut does.
#[cfg(windows)]
fn open_gui(path: &Path) -> Result<u32> {
    let mut cmd = Command::new("explorer.exe");
    cmd.arg(path);
    cmd.spawn().map_err(|error| err(format!("could not open {}: {error}", path.display())))?;
    Ok(0)
}

const PAGE_LABEL: &str = "page_browser";

#[derive(Serialize)]
pub struct PageView {
    pub showing: bool,
    pub refused: bool,
}

/// Address for the page column. Public sites are https. Local sites stay http.
pub fn page_url(raw: &str) -> Result<url::Url> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.len() > 2000 || trimmed.chars().any(|ch| ch.is_control() || ch.is_whitespace()) {
        return Err(err("Use an https address, or http://localhost."));
    }
    let text = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        let hostish = trimmed.split(['/', '?', '#']).next().unwrap_or(trimmed);
        let name = hostish.trim_matches(['[', ']']).split(':').next().unwrap_or(hostish);
        let local = name.eq_ignore_ascii_case("localhost") || name == "127.0.0.1" || name == "::1";
        if local { format!("http://{trimmed}") } else { format!("https://{trimmed}") }
    };
    let parsed = url::Url::parse(&text).map_err(|_| err("Use an https address, or http://localhost."))?;
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(err("Use an https address, or http://localhost."));
    }
    let host = parsed.host_str().unwrap_or("");
    let local = host.eq_ignore_ascii_case("localhost") || host == "127.0.0.1" || host == "::1" || host == "[::1]";
    let ok = match parsed.scheme() {
        "https" => !host.is_empty(),
        "http" => local,
        _ => false,
    };
    if !ok {
        return Err(err("Use an https address, or http://localhost."));
    }
    Ok(parsed)
}

pub(crate) fn local_port_open(url: &url::Url) -> bool {
    let Some(host) = url.host_str() else { return false };
    let port = url.port_or_known_default().unwrap_or(80);
    if host.eq_ignore_ascii_case("localhost") {
        TcpStream::connect_timeout(&SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port), Duration::from_millis(500)).is_ok()
            || TcpStream::connect_timeout(&SocketAddr::new(IpAddr::V6(Ipv6Addr::LOCALHOST), port), Duration::from_millis(500)).is_ok()
    } else if host == "::1" || host == "[::1]" {
        TcpStream::connect_timeout(&SocketAddr::new(IpAddr::V6(Ipv6Addr::LOCALHOST), port), Duration::from_millis(1000)).is_ok()
    } else {
        TcpStream::connect_timeout(&SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port), Duration::from_millis(1000)).is_ok()
    }
}

fn tell_page(app: &AppHandle, url: &str) {
    let Some(window) = app.get_webview_window("main") else { return };
    let text = serde_json::to_string(url).unwrap_or_else(|_| "\"\"".into());
    let _ = window.eval(format!("window.dispatchEvent(new CustomEvent('omni-page', {{ detail: {{ url: {text} }} }}))"));
}

pub fn show_page(app: &AppHandle, home: &Path, bounds: WebAppBounds, url: &str, focus: bool) -> Result<PageView> {
    let bounds = bounds.clamped();
    let parsed = page_url(url)?;
    if parsed.scheme() == "http" && !local_port_open(&parsed) {
        let _guard = WEB_LOCK.lock().unwrap_or_else(|poison| poison.into_inner());
        if let Some(view) = app.get_webview(PAGE_LABEL) {
            let _ = view.hide();
        }
        return Ok(PageView { showing: false, refused: true });
    }
    let _guard = WEB_LOCK.lock().unwrap_or_else(|poison| poison.into_inner());
    let window = app.get_window("main").ok_or_else(|| err("main window is not open"))?;
    if let Some(existing) = app.get_webview(PAGE_LABEL) {
        move_view(&existing, bounds)?;
        let same = existing.url().ok().is_some_and(|current| current.as_str() == parsed.as_str());
        if !same {
            existing.navigate(parsed).map_err(|error| err(error.to_string()))?;
        }
        existing.show().map_err(|error| err(error.to_string()))?;
        if focus {
            let _ = existing.set_focus();
        }
        return Ok(PageView { showing: true, refused: false });
    }
    let dir = crate::site_window::ensure_profile(home, PAGE_LABEL)?;
    let notify = app.clone();
    let popup = app.clone();
    let target = parsed.clone();
    let builder = WebviewBuilder::new(PAGE_LABEL, WebviewUrl::External(target))
        .data_directory(dir)
        .background_color(Color(255, 255, 255, 255))
        .on_navigation(|next| page_url(next.as_str()).is_ok())
        .on_page_load(move |_view, payload| {
            if payload.event() == PageLoadEvent::Finished {
                tell_page(&notify, payload.url().as_str());
            }
        })
        .on_new_window(move |next, _features| {
            if page_url(next.as_str()).is_ok() {
                if let Some(view) = popup.get_webview(PAGE_LABEL) {
                    let _ = view.navigate(next);
                }
            }
            NewWindowResponse::Deny
        });
    let created = window
        .add_child(builder, LogicalPosition::new(bounds.x, bounds.y), LogicalSize::new(bounds.width, bounds.height))
        .map_err(|error| err(error.to_string()))?;
    if focus {
        let _ = created.set_focus();
    }
    Ok(PageView { showing: true, refused: false })
}

pub fn place_page(app: &AppHandle, bounds: WebAppBounds) -> Result<()> {
    let Some(existing) = app.get_webview(PAGE_LABEL) else { return Ok(()) };
    move_view(&existing, bounds.clamped())
}

pub fn hide_page(app: &AppHandle) {
    if let Some(existing) = app.get_webview(PAGE_LABEL) {
        let _ = existing.hide();
    }
}

pub fn page_action(app: &AppHandle, action: &str) -> Result<()> {
    let Some(view) = app.get_webview(PAGE_LABEL) else { return Ok(()) };
    match action {
        "back" => view.eval("history.back()").map_err(|error| err(error.to_string()))?,
        "forward" => view.eval("history.forward()").map_err(|error| err(error.to_string()))?,
        "reload" => view.reload().map_err(|error| err(error.to_string()))?,
        _ => return Err(err("unknown page action")),
    }
    Ok(())
}

fn last_line(text: &str) -> String {
    let line = text.lines().rev().map(str::trim).find(|line| !line.is_empty()).unwrap_or("install failed");
    let mut short = line.to_string();
    truncate_utf8(&mut short, 240);
    short
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn web_apps_point_at_https_sites() {
        assert_eq!(web_spec("claude").unwrap().url, "https://claude.ai");
        assert_eq!(web_spec("chatgpt").unwrap().url, "https://chatgpt.com");
        assert_eq!(web_spec("grok").unwrap().url, "https://grok.com");
        assert_eq!(web_spec("nvidia").unwrap().url, "https://build.nvidia.com");
        assert!(web_spec("cursor").is_none());
    }

    #[test]
    fn desktop_apps_use_known_winget_ids() {
        assert_eq!(desk_spec("cursor").unwrap().winget, "Anysphere.Cursor");
        assert_eq!(desk_spec("claude-code").unwrap().winget, "Anthropic.ClaudeCode");
        assert_eq!(desk_spec("vscode").unwrap().winget, "Microsoft.VisualStudioCode");
        assert_eq!(desk_spec("obsidian").unwrap().winget, "Obsidian.Obsidian");
        assert_eq!(desk_spec("ollama").unwrap().winget, "Ollama.Ollama");
        assert!(desk_spec("claude-code").unwrap().console);
        assert!(!desk_spec("cursor").unwrap().console);
        assert!(desk_spec("nope").is_none());
    }

    #[test]
    fn gui_names_are_desktop_and_cli_names_are_terminal() {
        assert_eq!(edition_of(Path::new(r"C:\Users\haris\AppData\Local\Programs\cursor\Cursor.exe")), "desktop");
        assert_eq!(edition_of(Path::new(r"C:\Users\haris\AppData\Local\Programs\cursor\resources\app\bin\cursor.cmd")), "terminal");
        assert_eq!(edition_of(Path::new(r"C:\Users\haris\AppData\Local\Programs\cursor\resources\app\bin\cursor")), "terminal");
        assert_eq!(edition_of(Path::new(r"C:\Users\haris\AppData\Local\Programs\Microsoft VS Code Insiders\Code - Insiders.exe")), "desktop");
        assert_eq!(edition_of(Path::new(r"C:\Users\haris\.local\bin\claude.exe")), "terminal");
        assert_eq!(edition_of(Path::new(r"C:\Users\haris\AppData\Local\Programs\Claude\Claude.exe")), "desktop");
        assert_eq!(edition_of(Path::new(r"C:\Users\haris\AppData\Local\Programs\Ollama\ollama.exe")), "terminal");
        assert_eq!(edition_of(Path::new(r"C:\Users\haris\AppData\Local\Programs\Ollama\ollama app.exe")), "desktop");
        assert_eq!(edition_of(Path::new(r"C:\Program Files\Grok Bot\Grok Bot.exe")), "desktop");
    }

    #[test]
    fn page_addresses_are_https_or_local_http() {
        assert_eq!(page_url("https://example.com/docs").unwrap().as_str(), "https://example.com/docs");
        assert_eq!(page_url("example.com").unwrap().scheme(), "https");
        assert!(page_url("localhost:3000/app").unwrap().as_str().starts_with("http://localhost:3000/app"));
        assert!(page_url("http://127.0.0.1:3000/").is_ok());
        assert!(page_url("http://example.com").is_err());
        assert!(page_url("file:///C:/Windows").is_err());
        assert!(page_url("javascript:alert(1)").is_err());
        assert!(page_url("https://user:pass@example.com").is_err());
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(local_port_open(&page_url(&format!("http://127.0.0.1:{port}/")).unwrap()));
        drop(listener);
        assert!(!local_port_open(&page_url("http://127.0.0.1:1/").unwrap()));
    }

    #[test]
    fn bounds_stay_on_the_window() {
        let bounds = WebAppBounds { x: -9999.0, y: 12.0, width: 0.0, height: 90000.0 }.clamped();
        assert_eq!(bounds.x, -50.0);
        assert_eq!(bounds.y, 12.0);
        assert_eq!(bounds.width, 1.0);
        assert_eq!(bounds.height, 8000.0);
    }

    #[test]
    fn custom_web_url_must_be_https() {
        assert!(allowed_web_url("https://example.com/app").is_ok());
        assert!(allowed_web_url("http://127.0.0.1:3000").is_ok());
        assert!(allowed_web_url("http://localhost:1420/x").is_ok());
        assert!(allowed_web_url("http://[::1]:9/").is_ok());
        assert!(allowed_web_url("http://example.com").is_err());
        assert!(allowed_web_url("javascript:alert(1)").is_err());
        assert!(allowed_web_url("file:///C:/Windows/notepad.exe").is_err());
        assert!(allowed_web_url("https://user:pass@example.com").is_err());
        assert!(allowed_web_url("data:text/html,hi").is_err());
        assert!(is_custom_id("custom_web1a2b"));
        assert!(!is_custom_id("chatgpt"));
        assert!(!is_custom_id("custom_../x"));
        assert!(!is_custom_id("custom_"));
        assert!(!is_custom_id("custom_has space"));
        let (id, name, url) = resolve_web("chatgpt", Some("https://evil.example"), Some("Nope")).unwrap();
        assert_eq!(id, "chatgpt");
        assert_eq!(name, "ChatGPT");
        assert_eq!(url, "https://chatgpt.com");
        let (custom_id, custom_name, custom_url) = resolve_web("custom_w1", Some("https://notes.example/app"), Some(" Notes ")).unwrap();
        assert_eq!(custom_id, "custom_w1");
        assert_eq!(custom_name, "Notes");
        assert!(custom_url.starts_with("https://notes.example"));
        assert!(resolve_web("custom_w1", Some("http://example.com"), None).is_err());
        assert!(resolve_web("../evil", Some("https://example.com"), None).is_err());
        assert!(allowed_web_url("muse.ai").unwrap().starts_with("https://muse.ai"));
        assert!(allowed_web_url("muse.ai/").unwrap().starts_with("https://muse.ai"));
        assert!(allowed_web_url("127.0.0.1:3000/app").unwrap().starts_with("http://127.0.0.1:3000"));
        assert!(allowed_web_url("localhost:1420").unwrap().starts_with("http://localhost:1420"));
        assert!(allowed_web_url("javascript:alert(1)").is_err());
    }

    fn failure<T>(result: Result<T>) -> String {
        match result {
            Err(error) => error.0,
            Ok(_) => panic!("expected an error"),
        }
    }

    #[test]
    fn added_program_rejects_missing_and_unsafe_paths() {
        assert_eq!(failure(launch_added_program("", "Notes")), "choose a program file on this computer");
        assert_eq!(failure(launch_added_program("wsl:notepad", "Notes")), "choose a program file on this computer");
        assert_eq!(failure(launch_added_program("C:\\\u{1}bad.exe", "Notes")), "choose a program file on this computer");
        assert_eq!(failure(launch_added_program(r"C:\no\such\omni-missing.exe", "Notes")), "that program file was not found");
        assert_eq!(failure(launch_added_program(r"C:\Windows", "Win")), "that program file was not found");
        assert_eq!(failure(route_added_desktop("custom_d1", Some(r"C:\no\such\omni-missing.exe"), Some("Notes"))), "that program file was not found");
        assert_eq!(failure(route_added_desktop("chatgpt", None, None)), "unknown desktop app");
        match route_added_desktop("cursor", Some(r"C:\no\such\omni-missing.exe"), Some("Nope")) {
            Ok(None) => {}
            Ok(Some(_)) => panic!("a built-in desktop app must ignore a caller path"),
            Err(error) => panic!("{}", error.0),
        }
    }
}
