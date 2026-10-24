//! Each bot's private browser and workspace.
//!
//! The browser profile is ~/.omniworkspace/bots/<id>/browser.
//! The shell cwd is ~/.omniworkspace/bots/<id>/workspace.
//! One webview is shown. The others stay hidden and keep their own pages.

use crate::db::kv_set;
use crate::error::{err, Result};
use crate::models::DomNode;
use crate::util::{prefix_utf8, safe_id_component};
use crate::workspace_apps::{local_port_open, page_url, WebAppBounds};
use crate::AppState;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use tauri::webview::{Color, NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl};

const READ_JS: &str = r#"(function(){
  try {
    var nodes = [];
    var list = document.querySelectorAll("a,button,input,select,textarea");
    for (var i = 0; i < list.length && nodes.length < 40; i++) {
      var el = list[i];
      var tag = String(el.tagName || "").toLowerCase();
      var label = el.getAttribute("aria-label") || el.innerText || el.getAttribute("placeholder") || el.getAttribute("name") || el.value || "";
      label = String(label).replace(/\s+/g, " ").trim();
      if (label.length > 80) label = label.slice(0, 80);
      nodes.push({ id: nodes.length + 1, tag: tag, label: label });
    }
    var text = document.body && document.body.innerText ? String(document.body.innerText) : "";
    text = text.replace(/\s+/g, " ").trim();
    if (text.length > 1200) text = text.slice(0, 1200);
    return { url: String(location.href || ""), title: String(document.title || ""), text: text, nodes: nodes, ready: String(document.readyState || "") };
  } catch (error) {
    return { url: "", title: "", text: "", nodes: [], ready: "error", error: String(error) };
  }
})()"#;

fn screen_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|poison| poison.into_inner())
}

fn eval_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|poison| poison.into_inner())
}

fn shown_id() -> std::sync::MutexGuard<'static, String> {
    static SHOWN: Mutex<String> = Mutex::new(String::new());
    SHOWN.lock().unwrap_or_else(|poison| poison.into_inner())
}

fn clear_shown_if(id: &str, showing: bool) {
    if !showing {
        return;
    }
    let mut shown = shown_id();
    if shown.as_str() == id {
        shown.clear();
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BotScreenStatus {
    pub showing: bool,
    pub refused: bool,
    pub url: String,
}

pub struct ScreenHit {
    pub url: String,
    pub text: String,
    pub nodes: Vec<DomNode>,
    pub ms: i64,
}

impl ScreenHit {
    pub fn empty(url: &str) -> Self {
        Self {
            url: url.to_string(),
            text: String::new(),
            nodes: Vec::new(),
            ms: 0,
        }
    }
}

#[derive(Deserialize)]
struct RawRead {
    #[serde(default)]
    url: String,
    #[serde(default)]
    text: String,
    #[serde(default)]
    nodes: Vec<RawNode>,
    #[serde(default)]
    ready: String,
}

#[derive(Deserialize)]
struct RawNode {
    #[serde(default)]
    id: i64,
    #[serde(default)]
    tag: String,
    #[serde(default)]
    label: String,
}

enum Present {
    Show { bounds: WebAppBounds, focus: bool },
    Drive,
}

pub fn browser_dir(home: &Path, id: &str) -> Result<PathBuf> {
    let id = safe_id_component(id)?;
    Ok(home.join("bots").join(id).join("browser"))
}

/// The only directory this bot's shell may use. A stored path outside it is replaced.
pub fn shell_cwd(home: &Path, id: &str, stored: &str) -> Result<PathBuf> {
    let id = safe_id_component(id)?;
    let owned = home.join("bots").join(id).join("workspace");
    std::fs::create_dir_all(&owned)?;
    let _ = stored;
    Ok(owned)
}

pub fn command_stays(command: &str, args: &[String]) -> Result<()> {
    if command.contains("..") || command.contains(":\\") || command.contains(":/") {
        return Err(err("that path stays inside this bot's workspace"));
    }
    for arg in args {
        if arg.contains("..")
            || arg.contains(":\\")
            || arg.contains(":/")
            || arg.starts_with('/')
            || arg.starts_with('\\')
            || Path::new(arg).is_absolute()
        {
            return Err(err("that path stays inside this bot's workspace"));
        }
    }
    Ok(())
}

pub fn store_screen(conn: &Connection, id: &str, url: &str, nodes: &[DomNode], ms: i64) -> Result<()> {
    let id = safe_id_component(id)?;
    kv_set(conn, &format!("screen_url:{id}"), url)?;
    kv_set(conn, &format!("screen_nodes:{id}"), &serde_json::to_string(nodes)?)?;
    kv_set(conn, &format!("screen_ms:{id}"), &ms.to_string())?;
    Ok(())
}

pub fn store_shell(conn: &Connection, id: &str, output: &str) -> Result<()> {
    let id = safe_id_component(id)?;
    kv_set(conn, &format!("shell_out:{id}"), prefix_utf8(output, 8000))?;
    Ok(())
}

pub fn load_screen(conn: &Connection, id: &str) -> (String, Vec<DomNode>, i64, String) {
    let url = crate::db::kv_get(conn, &format!("screen_url:{id}")).ok().flatten().unwrap_or_default();
    let nodes = crate::db::kv_get(conn, &format!("screen_nodes:{id}"))
        .ok()
        .flatten()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default();
    let ms = crate::db::kv_get(conn, &format!("screen_ms:{id}"))
        .ok()
        .flatten()
        .and_then(|text| text.parse().ok())
        .unwrap_or(0);
    let shell = crate::db::kv_get(conn, &format!("shell_out:{id}")).ok().flatten().unwrap_or_default();
    (url, nodes, ms, shell)
}

pub fn show_column(app: &AppHandle, home: &Path, id: &str, bounds: WebAppBounds, url: &str, focus: bool) -> Result<BotScreenStatus> {
    prepare(app, home, id, url, Present::Show { bounds, focus })
}

pub fn reveal_column(app: &AppHandle, home: &Path, id: &str, bounds: WebAppBounds, url: &str) -> Result<BotScreenStatus> {
    prepare(app, home, id, url, Present::Show { bounds, focus: false })
}

pub fn place_column(app: &AppHandle, bounds: WebAppBounds) -> Result<()> {
    let _guard = screen_lock();
    let id = shown_id().clone();
    if id.is_empty() {
        return Ok(());
    }
    let Some(view) = app.get_webview(&label_for(&id)) else {
        return Ok(());
    };
    move_view(&view, bounds.clamped())?;
    view.show().map_err(|error| err(error.to_string()))?;
    Ok(())
}

pub fn hide_column(app: &AppHandle) {
    let _guard = screen_lock();
    *shown_id() = String::new();
    hide_labels(app, "");
}

pub fn open_and_read(app: &AppHandle, home: &Path, id: &str, url: &str) -> Result<ScreenHit> {
    let status = prepare(app, home, id, url, Present::Drive)?;
    if status.refused {
        return Err(err("That local server is not running."));
    }
    read_bot(app, id, Some(&status.url))
}

pub fn read_bot(app: &AppHandle, id: &str, expected: Option<&str>) -> Result<ScreenHit> {
    let view = view_for(app, id)?;
    let started = Instant::now();
    let page = wait_read(&view, expected)?;
    finish_hit(page, expected.unwrap_or(""), started)
}

pub fn click_bot(app: &AppHandle, id: &str, node: i64) -> Result<ScreenHit> {
    if !(1..=40).contains(&node) {
        return Err(err("that control is not on this page"));
    }
    let view = view_for(app, id)?;
    let value = eval_value(&view, &click_js(node))?;
    if !value.get("ok").and_then(|item| item.as_bool()).unwrap_or(false) {
        let message = value.get("error").and_then(|item| item.as_str()).unwrap_or("could not click");
        return Err(err(message));
    }
    thread::sleep(Duration::from_millis(300));
    let started = Instant::now();
    let page = wait_read(&view, None)?;
    finish_hit(page, "", started)
}

pub fn type_bot(app: &AppHandle, id: &str, node: i64, text: &str) -> Result<ScreenHit> {
    if !(1..=40).contains(&node) {
        return Err(err("that control is not on this page"));
    }
    let text = prefix_utf8(text, 2000);
    if text.is_empty() {
        return Err(err("type the text to enter"));
    }
    let view = view_for(app, id)?;
    let value = eval_value(&view, &type_js(node, text))?;
    if !value.get("ok").and_then(|item| item.as_bool()).unwrap_or(false) {
        let message = value.get("error").and_then(|item| item.as_str()).unwrap_or("could not type");
        return Err(err(message));
    }
    thread::sleep(Duration::from_millis(300));
    let started = Instant::now();
    let page = wait_read(&view, None)?;
    finish_hit(page, "", started)
}

fn finish_hit(page: RawRead, expected: &str, started: Instant) -> Result<ScreenHit> {
    let url = if page_url(&page.url).is_ok() { page.url } else { expected.to_string() };
    Ok(ScreenHit {
        url,
        text: prefix_utf8(&page.text, 1200).to_string(),
        nodes: nodes_of(&page.nodes),
        ms: started.elapsed().as_millis() as i64,
    })
}

fn prepare(app: &AppHandle, home: &Path, id: &str, url: &str, present: Present) -> Result<BotScreenStatus> {
    let id = safe_id_component(id)?.to_string();
    let label = label_for(&id);
    let trimmed = url.trim();
    if trimmed.is_empty() {
        let _guard = screen_lock();
        if let Some(view) = app.get_webview(&label) {
            let _ = view.hide();
        }
        clear_shown_if(&id, matches!(present, Present::Show { .. }));
        return Ok(BotScreenStatus { showing: false, refused: false, url: String::new() });
    }
    let parsed = page_url(trimmed)?;
    if parsed.scheme() == "http" && !local_port_open(&parsed) {
        let _guard = screen_lock();
        if let Some(view) = app.get_webview(&label) {
            let _ = view.hide();
        }
        clear_shown_if(&id, matches!(present, Present::Show { .. }));
        return Ok(BotScreenStatus { showing: false, refused: true, url: parsed.to_string() });
    }
    let _guard = screen_lock();
    let window = app.get_window("main").ok_or_else(|| err("main window is not open"))?;
    let bounds = match present {
        Present::Show { bounds, .. } => Some(bounds.clamped()),
        Present::Drive => None,
    };
    if app.get_webview(&label).is_none() {
        create_view(app, &window, home, &id, &label, parsed.clone(), bounds)?;
    }
    let view = app.get_webview(&label).ok_or_else(|| err("this bot's browser did not open"))?;
    let same = view.url().ok().is_some_and(|current| current.as_str() == parsed.as_str());
    if !same {
        view.navigate(parsed.clone()).map_err(|error| err(error.to_string()))?;
    }
    match present {
        Present::Show { bounds, focus } => {
            *shown_id() = id;
            hide_labels(app, &label);
            move_view(&view, bounds.clamped())?;
            view.show().map_err(|error| err(error.to_string()))?;
            if focus {
                let _ = view.set_focus();
            }
            Ok(BotScreenStatus { showing: true, refused: false, url: parsed.to_string() })
        }
        Present::Drive => {
            let visible = shown_id().as_str() == id;
            if visible {
                view.show().map_err(|error| err(error.to_string()))?;
            } else {
                let _ = view.hide();
            }
            Ok(BotScreenStatus { showing: visible, refused: false, url: parsed.to_string() })
        }
    }
}

fn create_view(app: &AppHandle, window: &tauri::Window<tauri::Wry>, home: &Path, id: &str, label: &str, target: url::Url, bounds: Option<WebAppBounds>) -> Result<()> {
    let dir = browser_dir(home, id)?;
    std::fs::create_dir_all(&dir)?;
    let notify = app.clone();
    let watch_id = id.to_string();
    let popup = app.clone();
    let popup_label = label.to_string();
    let builder = WebviewBuilder::new(label, WebviewUrl::External(target.clone()))
        .data_directory(dir)
        .background_color(Color(255, 255, 255, 255))
        .on_navigation(|next| page_url(next.as_str()).is_ok())
        .on_page_load(move |_view, payload| {
            if payload.event() == PageLoadEvent::Finished {
                note_page(&notify, &watch_id, payload.url().as_str());
            }
        })
        .on_new_window(move |next, _features| {
            if page_url(next.as_str()).is_ok() {
                if let Some(view) = popup.get_webview(&popup_label) {
                    let _ = view.navigate(next);
                }
            }
            NewWindowResponse::Deny
        });
    let (x, y, width, height) = match bounds {
        Some(bounds) => (bounds.x, bounds.y, bounds.width, bounds.height),
        None => (0.0, 0.0, 1.0, 1.0),
    };
    let created = window
        .add_child(builder, LogicalPosition::new(x, y), LogicalSize::new(width, height))
        .map_err(|error| err(error.to_string()))?;
    if bounds.is_none() {
        let _ = created.hide();
    }
    Ok(())
}

fn note_page(app: &AppHandle, id: &str, url: &str) {
    if page_url(url).is_err() {
        return;
    }
    if let Some(window) = app.get_webview_window("main") {
        let detail = serde_json::json!({ "id": id, "url": url });
        let _ = window.eval(format!("window.dispatchEvent(new CustomEvent('omni-bot-screen', {{ detail: {detail} }}))"));
    }
    let state = app.state::<AppState>();
    let conn = state.conn.lock().unwrap_or_else(|poison| poison.into_inner());
    let _ = kv_set(&conn, &format!("screen_url:{id}"), url);
}

fn view_for(app: &AppHandle, id: &str) -> Result<tauri::Webview> {
    let id = safe_id_component(id)?;
    let _guard = screen_lock();
    app.get_webview(&label_for(id)).ok_or_else(|| err("This computer is off until a page is open."))
}

fn hide_labels(app: &AppHandle, keep: &str) {
    let Some(window) = app.get_window("main") else { return };
    for view in window.webviews() {
        let label = view.label();
        if label.starts_with("botscreen_") && label != keep {
            let _ = view.hide();
        }
    }
}

fn move_view(view: &tauri::Webview, bounds: WebAppBounds) -> Result<()> {
    view.set_position(LogicalPosition::new(bounds.x, bounds.y)).map_err(|error| err(error.to_string()))?;
    view.set_size(LogicalSize::new(bounds.width, bounds.height)).map_err(|error| err(error.to_string()))?;
    Ok(())
}

fn label_for(id: &str) -> String {
    format!("botscreen_{id}")
}

fn nodes_of(raw: &[RawNode]) -> Vec<DomNode> {
    raw.iter()
        .take(40)
        .filter(|node| node.id > 0 && !node.tag.is_empty())
        .map(|node| DomNode {
            id: node.id,
            tag: node.tag.clone(),
            label: node.label.clone(),
            kind: "control".into(),
        })
        .collect()
}

fn wait_read(view: &tauri::Webview, expected: Option<&str>) -> Result<RawRead> {
    let started = Instant::now();
    let mut last = None;
    while started.elapsed() < Duration::from_secs(8) {
        if let Ok(page) = eval_read(view) {
            let matched = expected.map(|url| same_page(&page.url, url)).unwrap_or(true);
            let useful = page.ready == "complete" || page.ready == "interactive" || !page.text.is_empty() || !page.nodes.is_empty();
            let done = matched && useful;
            last = Some(page);
            if done {
                break;
            }
        }
        if started.elapsed() >= Duration::from_secs(8) {
            break;
        }
        thread::sleep(Duration::from_millis(250));
    }
    last.ok_or_else(|| err("the page did not answer"))
}

fn same_page(live: &str, expected: &str) -> bool {
    let Ok(live) = url::Url::parse(live) else { return false };
    let Ok(expected) = url::Url::parse(expected) else { return false };
    live.host_str() == expected.host_str() && live.path().trim_end_matches('/') == expected.path().trim_end_matches('/')
}

fn eval_read(view: &tauri::Webview) -> Result<RawRead> {
    let value = eval_value(view, READ_JS)?;
    serde_json::from_value(value).map_err(|error| err(error.to_string()))
}

fn eval_value(view: &tauri::Webview, script: &str) -> Result<Value> {
    let _guard = eval_lock();
    let (tx, rx) = mpsc::sync_channel(1);
    view.eval_with_callback(script, move |raw| {
        let _ = tx.send(raw);
    })
    .map_err(|error| err(error.to_string()))?;
    let raw = rx.recv_timeout(Duration::from_secs(8)).map_err(|_| err("the page did not answer"))?;
    parse_eval(&raw)
}

fn parse_eval(raw: &str) -> Result<Value> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "null" {
        return Err(err("the page did not answer"));
    }
    let value: Value = serde_json::from_str(trimmed).map_err(|_| err("the page did not answer"))?;
    if let Value::String(inner) = &value {
        if let Ok(nested) = serde_json::from_str::<Value>(inner) {
            return Ok(nested);
        }
    }
    Ok(value)
}

fn click_js(id: i64) -> String {
    let index = id - 1;
    format!(
        r#"(function(){{
  try {{
    var list = document.querySelectorAll("a,button,input,select,textarea");
    var el = list[{index}];
    if (!el) return {{ ok: false, error: "no control" }};
    el.click();
    return {{ ok: true, error: "" }};
  }} catch (error) {{
    return {{ ok: false, error: String(error) }};
  }}
}})()"#
    )
}

fn type_js(id: i64, text: &str) -> String {
    let index = id - 1;
    let encoded = serde_json::to_string(text).unwrap_or_else(|_| "\"\"".into());
    format!(
        r#"(function(){{
  try {{
    var list = document.querySelectorAll("a,button,input,select,textarea");
    var el = list[{index}];
    if (!el) return {{ ok: false, error: "no control" }};
    var tag = String(el.tagName || "").toLowerCase();
    if (tag !== "input" && tag !== "textarea") return {{ ok: false, error: "not a text field" }};
    var text = {encoded};
    el.focus();
    el.value = text;
    el.dispatchEvent(new Event("input", {{ bubbles: true }}));
    el.dispatchEvent(new Event("change", {{ bubbles: true }}));
    return {{ ok: true, error: "" }};
  }} catch (error) {{
    return {{ ok: false, error: String(error) }};
  }}
}})()"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("omni-bot-screen-{}-{}", std::process::id(), crate::util::now_ms()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn bots_keep_separate_folders_and_shell_paths() {
        let home = home();
        let alpha = browser_dir(&home, "bot_alpha").unwrap();
        let beta = browser_dir(&home, "bot_beta").unwrap();
        assert_ne!(alpha, beta);
        assert!(alpha.ends_with(Path::new("bots").join("bot_alpha").join("browser")));
        assert!(beta.ends_with(Path::new("bots").join("bot_beta").join("browser")));
        assert!(browser_dir(&home, "../evil").is_err());
        assert!(browser_dir(&home, "bot/evil").is_err());

        let owned = shell_cwd(&home, "bot_alpha", r"C:\Windows\System32").unwrap();
        assert!(owned.ends_with(Path::new("bots").join("bot_alpha").join("workspace")));
        assert!(owned.is_dir());
        assert_ne!(owned, PathBuf::from(r"C:\Windows\System32"));
        let again = shell_cwd(&home, "bot_alpha", "").unwrap();
        assert_eq!(owned, again);
        assert!(shell_cwd(&home, "../evil", "").is_err());

        assert!(command_stays("echo hello", &["echo".into(), "hello".into()]).is_ok());
        assert!(command_stays("dir", &["dir".into()]).is_ok());
        assert!(command_stays(r"dir ..\..", &crate::util::split_args(r"dir ..\..")).is_err());
        assert!(command_stays(r"echo C:\Windows", &[r"echo".into(), r"C:\Windows".into()]).is_err());
        assert!(command_stays("echo https://example.com", &["echo".into(), "https://example.com".into()]).is_err());
        assert!(command_stays("cat /etc/passwd", &["cat".into(), "/etc/passwd".into()]).is_err());
        let _ = std::fs::remove_dir_all(&home);
    }
}
