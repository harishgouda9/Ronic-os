//! Dock web apps and desktop apps on the MCP bridge and in Code Mode.
//!
//! `list` can run without a window. Opening, reading, clicking, and writing a
//! client config happen here, outside the database lock. A missing action is
//! an error. This module does not report a success it did not perform.

use crate::computer_subsystem::{self, MiniWindowHit};
use crate::util::product_home;
use crate::workspace_apps;
use crate::AppState;
use rusqlite::Connection;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

const DOCK_BOT: &str = "dock";

pub fn is_dock_tool(name: &str) -> bool {
    matches!(name, "workspace_webapp" | "desktop_app")
}

pub fn drive(app: Option<&AppHandle>, conn: Option<&Connection>, tool: &str, args: &Value) -> Result<Value, String> {
    let action = arg_text(args, &["action", "op"]).to_ascii_lowercase();
    if action.is_empty() {
        return Err("Name an action. Web actions: list, open, read, click, type, scroll, close, connect, status. Desktop actions: list, open, inspect, click, type, status, connect.".into());
    }
    match tool {
        "workspace_webapp" => drive_web(app, conn, &action, args),
        "desktop_app" => drive_desktop(app, &action, args),
        _ => Err("That tool is not a Dock app tool.".into()),
    }
}

fn drive_web(app: Option<&AppHandle>, conn: Option<&Connection>, action: &str, args: &Value) -> Result<Value, String> {
    let id = app_id(args);
    match action {
        "list" => {
            let (apps, active) = with_conn(app, conn, |db| (workspace_apps::list_available_webapps(db), workspace_apps::active_webapp()));
            Ok(json!({ "active": active, "webapps": apps }))
        }
        "status" => Ok(json!({
            "app": id,
            "active": workspace_apps::active_webapp().as_deref() == Some(id.as_str()) && !id.is_empty(),
            "open": web_open(app, &id),
        })),
        "connect" => connect_web(app, &id),
        "open" | "switch" => {
            let app = need_app(app)?;
            let target = if id.is_empty() { app_from_url(&arg_text(args, &["url"])) } else { id };
            if target.is_empty() {
                return Err("Name the Dock web app to open.".into());
            }
            let url = arg_text(args, &["url"]);
            let url = if url.is_empty() { None } else { Some(url.as_str()) };
            let note = workspace_apps::open_workspace_webapp_by_bot(app, &target, url, None).map_err(|error| error.0)?;
            Ok(json!({ "ok": true, "action": "open", "app": target, "note": note }))
        }
        "close" => {
            let app = need_app(app)?;
            workspace_apps::hide_all(app);
            let _ = app.emit("ronic://close-workspace-webapp", ());
            Ok(json!({ "ok": true, "action": "close", "note": "Closed the Dock web app stage." }))
        }
        "read" | "inspect" => {
            let app = need_app(app)?;
            let hit = computer_subsystem::agent_drive_workspace_webapp(app, DOCK_BOT, opt_id(&id), "read", None, None, None).map_err(|error| error.0)?;
            Ok(hit_value(&hit))
        }
        "click" => click_web(app, &id, args),
        "type" => type_web(app, &id, args),
        "submit" | "enter" => {
            let app = need_app(app)?;
            let hit = computer_subsystem::agent_drive_workspace_webapp(app, DOCK_BOT, opt_id(&id), "find", None, None, Some("send")).map_err(|error| error.0)?;
            let Some(node) = hit.nodes.first() else {
                return Err("No send control is on the page. Read the page and click a control id.".into());
            };
            let fresh = computer_subsystem::agent_drive_workspace_webapp(app, DOCK_BOT, opt_id(&id), "click", Some(node.id), None, None).map_err(|error| error.0)?;
            Ok(hit_value(&fresh))
        }
        "scroll" => {
            let app = need_app(app)?;
            let direction = arg_text(args, &["direction", "dir"]);
            let direction = match direction.as_str() {
                "" | "down" => "down",
                "up" => "up",
                other => return Err(format!("Scroll direction is up or down, not {other}.")),
            };
            let hit = computer_subsystem::agent_drive_workspace_webapp(app, DOCK_BOT, opt_id(&id), "scroll", None, None, Some(direction)).map_err(|error| error.0)?;
            Ok(hit_value(&hit))
        }
        "eval" => Err("eval is not on the MCP bridge or in Code Mode. Use read, click, and type.".into()),
        other => Err(format!("Unknown web app action '{other}'. Use list, open, read, click, type, scroll, close, connect, or status.")),
    }
}

fn drive_desktop(app: Option<&AppHandle>, action: &str, args: &Value) -> Result<Value, String> {
    let id = app_id(args);
    match action {
        "list" => Ok(json!({ "desktopApps": workspace_apps::list_available_desktop_apps() })),
        "status" => {
            let apps = workspace_apps::list_available_desktop_apps();
            let found = apps.iter().find(|item| item.get("id").and_then(|value| value.as_str()) == Some(id.as_str()));
            match found {
                Some(item) => Ok(item.clone()),
                None if id.is_empty() => Err("Name the desktop app.".into()),
                None => Err(format!("{id} is not one of the Dock desktop apps.")),
            }
        }
        "connect" => connect_desktop(&id),
        "open" | "launch" => {
            let app = need_app(app)?;
            if id.is_empty() {
                return Err("Name the Dock desktop app to open.".into());
            }
            let kind = arg_text(args, &["kind"]);
            let kind = match kind.as_str() {
                "" => None,
                "desktop" | "terminal" => Some(kind.as_str()),
                other => return Err(format!("Install choice is desktop or terminal, not {other}.")),
            };
            let path = arg_text(args, &["path"]);
            let path = if path.is_empty() { None } else { Some(path.as_str()) };
            let outcome = workspace_apps::launch_desktop(app, &id, kind, path, None).map_err(|error| error.0)?;
            Ok(json!({
                "ok": true,
                "action": "open",
                "app": id,
                "note": outcome.note,
                "installChoice": outcome.install_choice,
            }))
        }
        "inspect" => {
            let _ = need_app(app)?;
            let filter = arg_text(args, &["window", "filter", "app", "name"]);
            if filter.is_empty() {
                return Err("Name the window to inspect.".into());
            }
            let nodes = computer_subsystem::inspect_and_cache(&filter).map_err(|error| error.0)?;
            let summary: Vec<Value> = nodes.iter().take(30).map(|node| {
                json!({
                    "mark": node.mark_id,
                    "name": node.name,
                    "type": node.control_type,
                    "rect": node.bounds,
                    "center": node.center_xy,
                    "origin": node.origin,
                })
            }).collect();
            Ok(json!({ "window": computer_subsystem::last_desktop_window(), "nodes": summary }))
        }
        "click" => {
            let _ = need_app(app)?;
            let mark = computer_subsystem::resolve_desktop_mark(args)?;
            let message = computer_subsystem::som_click_sync(mark)?;
            Ok(json!({ "ok": true, "action": "click", "markId": mark, "note": message }))
        }
        "type" => {
            let _ = need_app(app)?;
            let text = arg_text(args, &["text", "value"]);
            if text.is_empty() {
                return Err("Type needs the text to write.".into());
            }
            let mark = computer_subsystem::resolve_desktop_mark(args)?;
            let message = computer_subsystem::som_type_sync(mark, &text)?;
            Ok(json!({ "ok": true, "action": "type", "markId": mark, "note": message }))
        }
        other => Err(format!("Unknown desktop app action '{other}'. Use list, open, inspect, click, type, status, or connect.")),
    }
}

fn connect_web(app: Option<&AppHandle>, id: &str) -> Result<Value, String> {
    let page = web_connector(id)?;
    let app = match app {
        Some(app) => app,
        None => return Err(format!("Opening the {} connector at {} runs in the desktop app.", page.title, page.url)),
    };
    let note = workspace_apps::open_workspace_webapp_at(app, page.dock_id, None, None, Some(page.url)).map_err(|error| error.0)?;
    let code = code_mode_line();
    Ok(json!({
        "ok": true,
        "action": "connect",
        "app": page.dock_id,
        "url": page.url,
        "note": format!("{note} {} {} {}", page.note, tunnel_line(), code),
    }))
}

fn connect_desktop(id: &str) -> Result<Value, String> {
    if id.trim().is_empty() {
        return Err("Name the Dock desktop app to connect. Cursor, VS Code, and Claude Code take the local MCP server.".into());
    }
    let key = desktop_key(id);
    match key {
        "ollama" => return Err("Ollama does not speak MCP. Code Mode can still open it with ronic.apps.desktop.".into()),
        "obsidian" => return Err("Obsidian does not speak MCP. Code Mode can still open it with ronic.apps.desktop.".into()),
        "" => return Err(format!("{id} is not a Dock desktop app that accepts the local MCP server. Cursor, VS Code, and Claude Code do.")),
        _ => {}
    }
    let written = crate::workspace_bridge::connect_named_client(key)?;
    let code = code_mode_line();
    Ok(json!({
        "ok": true,
        "action": "connect",
        "app": key,
        "note": format!("{written} {code}"),
    }))
}

struct Connector {
    dock_id: &'static str,
    title: &'static str,
    url: &'static str,
    note: &'static str,
}

fn web_connector(id: &str) -> Result<Connector, String> {
    let key = web_key(id);
    match key {
        "chatgpt" => Ok(Connector {
            dock_id: "chatgpt",
            title: "ChatGPT",
            url: "https://chatgpt.com/#settings/apps",
            note: "A site login is not an MCP connection. Create a connector from the public MCP URL on this Apps page. ChatGPT fetches that URL from OpenAI's servers.",
        }),
        "claude" => Ok(Connector {
            dock_id: "claude",
            title: "Claude",
            url: "https://claude.ai/settings/connectors",
            note: "A site login is not an MCP connection. Add a custom connector with the public MCP URL on this page. Claude fetches that URL from Anthropic's servers.",
        }),
        "grok" => Ok(Connector {
            dock_id: "grok",
            title: "Grok",
            url: "https://grok.com/settings",
            note: "A site login is not an MCP connection. If custom MCP apps are on this account, paste the public MCP URL on this settings page.",
        }),
        "gemini" => Err("Gemini web has no custom MCP connector for consumer accounts. Use the Gemini CLI, or point any MCP client at the tunnel URL. Code Mode can still open and read the Gemini page with ronic.apps.web.".into()),
        _ if id.trim().is_empty() => Err("Name the Dock web app to connect.".into()),
        _ => Err(format!("{id} does not speak MCP. Open it in the Dock for a normal site session. Code Mode can read it with ronic.apps.web after it is open.")),
    }
}

fn web_key(id: &str) -> &'static str {
    match norm(id).as_str() {
        "chatgpt" | "chatgpt-web" => "chatgpt",
        "claude" | "claude-web" => "claude",
        "gemini" | "gemini-web" => "gemini",
        "grok" | "grok-web" => "grok",
        _ => "",
    }
}

fn desktop_key(id: &str) -> &'static str {
    match norm(id).as_str() {
        "cursor" | "cursor-ide" => "cursor",
        "vscode" | "vs-code" | "vscode-ide" | "code" => "vscode",
        "claude-code" | "claude-cli" | "claudecode" | "claude-desktop" => "claude-code",
        "gemini-cli" | "agy" | "agy-cli" => "gemini-cli",
        "ollama" => "ollama",
        "obsidian" => "obsidian",
        _ => "",
    }
}

fn click_web(app: Option<&AppHandle>, id: &str, args: &Value) -> Result<Value, String> {
    let app = need_app(app)?;
    let query = arg_text(args, &["match", "text", "query"]);
    if !query.is_empty() {
        let hit = computer_subsystem::agent_drive_workspace_webapp(app, DOCK_BOT, opt_id(id), "find", None, None, Some(&query)).map_err(|error| error.0)?;
        let Some(node) = hit.nodes.first() else {
            return Err(format!("No control matching '{query}' is on the page."));
        };
        let fresh = computer_subsystem::agent_drive_workspace_webapp(app, DOCK_BOT, opt_id(id), "click", Some(node.id), None, None).map_err(|error| error.0)?;
        return Ok(hit_value(&fresh));
    }
    let control = arg_i64(args, &["id", "node"]).filter(|value| (1..=240).contains(value));
    let Some(control) = control else {
        return Err("Pick a control id from a read, or pass match text.".into());
    };
    let hit = computer_subsystem::agent_drive_workspace_webapp(app, DOCK_BOT, opt_id(id), "click", Some(control), None, None).map_err(|error| error.0)?;
    Ok(hit_value(&hit))
}

fn type_web(app: Option<&AppHandle>, id: &str, args: &Value) -> Result<Value, String> {
    let app = need_app(app)?;
    let control = arg_i64(args, &["id", "node"]).filter(|value| (1..=240).contains(value));
    let Some(control) = control else {
        return Err("Pick an input id from a read.".into());
    };
    let text = arg_text(args, &["text", "value"]);
    if text.is_empty() {
        return Err("Type needs the text to write.".into());
    }
    let hit = computer_subsystem::agent_drive_workspace_webapp(app, DOCK_BOT, opt_id(id), "type", Some(control), Some(&text), None).map_err(|error| error.0)?;
    Ok(hit_value(&hit))
}

fn hit_value(hit: &MiniWindowHit) -> Value {
    let nodes: Vec<Value> = hit.nodes.iter().take(40).map(|node| {
        json!({
            "id": node.id,
            "tag": node.tag,
            "label": clip(&node.label, 160),
        })
    }).collect();
    json!({
        "ok": true,
        "url": hit.url,
        "title": hit.title,
        "text": clip(hit.text.trim(), 4000),
        "note": hit.note,
        "nodes": nodes,
    })
}

fn web_open(app: Option<&AppHandle>, id: &str) -> bool {
    if id.is_empty() {
        return false;
    }
    app.and_then(|app| app.get_webview(&format!("webapp_{id}"))).is_some()
}

fn with_conn<T>(app: Option<&AppHandle>, conn: Option<&Connection>, work: impl FnOnce(Option<&Connection>) -> T) -> T {
    if let Some(conn) = conn {
        return work(Some(conn));
    }
    let Some(app) = app else {
        return work(None);
    };
    let Some(state) = app.try_state::<AppState>() else {
        return work(None);
    };
    let guard = state.conn.lock().unwrap_or_else(|poison| poison.into_inner());
    work(Some(&guard))
}

fn need_app(app: Option<&AppHandle>) -> Result<&AppHandle, String> {
    app.ok_or_else(|| "That Dock action runs in the desktop app.".to_string())
}

fn opt_id(id: &str) -> Option<&str> {
    if id.is_empty() { None } else { Some(id) }
}

fn app_id(args: &Value) -> String {
    let raw = arg_text(args, &["app", "id", "name"]);
    if raw.chars().all(|ch| ch.is_ascii_digit()) && args.get("app").is_none() && args.get("name").is_none() {
        return String::new();
    }
    raw
}

fn app_from_url(url: &str) -> String {
    let url = url.to_ascii_lowercase();
    if url.contains("chatgpt") {
        "chatgpt".into()
    } else if url.contains("claude") {
        "claude".into()
    } else if url.contains("gemini") {
        "gemini".into()
    } else if url.contains("grok") {
        "grok".into()
    } else {
        String::new()
    }
}

fn code_mode_line() -> String {
    let home = product_home();
    if crate::mcp_acp_automesh::code_mode_enabled(&home) {
        return "Code Mode is on. ronic.apps.web and ronic.apps.desktop call this same Dock path.".into();
    }
    match crate::mcp_acp_automesh::set_flags(&home, None, Some(true), None, None, None) {
        Ok(()) => "Code Mode is on. ronic.apps.web and ronic.apps.desktop call this same Dock path.".into(),
        Err(error) => format!("Code Mode stayed off: {error}"),
    }
}

fn tunnel_line() -> String {
    let token = std::fs::read_to_string(product_home().join("bridge-token")).unwrap_or_default();
    let status = crate::tunnel::status(token.trim());
    if status.public_mcp_url.trim().is_empty() {
        "The public tunnel is not running, so this site cannot fetch MCP from the internet yet. Start the tunnel, then paste its MCP URL into the connector page.".into()
    } else {
        format!("Paste this MCP URL into the connector: {}", status.public_mcp_url)
    }
}

fn arg_text(args: &Value, keys: &[&str]) -> String {
    for key in keys {
        let Some(value) = args.get(*key) else { continue };
        if let Some(text) = value.as_str() {
            let text = text.trim();
            if !text.is_empty() {
                return text.to_string();
            }
        }
    }
    String::new()
}

fn arg_i64(args: &Value, keys: &[&str]) -> Option<i64> {
    for key in keys {
        let Some(value) = args.get(*key) else { continue };
        if let Some(number) = value.as_i64() {
            return Some(number);
        }
        if let Some(text) = value.as_str() {
            if let Ok(number) = text.trim().parse::<i64>() {
                return Some(number);
            }
        }
    }
    None
}

fn norm(id: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for ch in id.trim().chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            dash = false;
        } else if !dash && !out.is_empty() {
            out.push('-');
            dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    out
}

fn clip(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max_chars).collect();
    out.push('…');
    out
}

#[tauri::command]
pub async fn connect_dock_app(app: AppHandle, id: String, kind: String) -> Result<String, String> {
    let tool = match kind.trim().to_ascii_lowercase().as_str() {
        "desktop" => "desktop_app",
        "web" | "" => "workspace_webapp",
        _ => return Err("Dock connect takes kind web or desktop.".into()),
    };
    // Web harnesses fetch MCP from the public internet. Start the tunnel
    // before the connector page opens so the note can include its URL.
    let tunnel_error = if tool == "workspace_webapp" {
        crate::mcp_oauth::arm_consent();
        match tauri::async_runtime::spawn_blocking(crate::tunnel::start).await {
            Ok(Ok(_)) => String::new(),
            Ok(Err(error)) => error,
            Err(error) => error.to_string(),
        }
    } else {
        String::new()
    };
    let value = drive(Some(&app), None, tool, &json!({ "action": "connect", "app": id.trim() }))?;
    let note = value.get("note").and_then(|item| item.as_str()).unwrap_or("The Dock app did not connect.").to_string();
    if tunnel_error.is_empty() || note.contains("Paste this MCP URL") {
        return Ok(note);
    }
    Ok(format!("{note} {tunnel_error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_actions_are_errors_and_do_not_claim_success() {
        let web = drive(None, None, "workspace_webapp", &json!({ "action": "frob" })).unwrap_err();
        assert!(!web.to_ascii_lowercase().contains("completed"), "{web}");
        assert!(web.contains("Unknown web app action"));
        let desk = drive(None, None, "desktop_app", &json!({ "action": "frob" })).unwrap_err();
        assert!(!desk.to_ascii_lowercase().contains("completed"), "{desk}");
        let missing = drive(None, None, "workspace_webapp", &json!({})).unwrap_err();
        assert!(missing.contains("Name an action"));
    }

    #[test]
    fn desktop_list_runs_without_a_window() {
        let value = drive(None, None, "desktop_app", &json!({ "action": "list" })).unwrap();
        let text = value.to_string();
        assert!(text.contains("cursor"), "{text}");
        assert!(text.contains("claude-code"), "{text}");
    }

    #[test]
    fn web_list_runs_without_a_window() {
        let value = drive(None, None, "workspace_webapp", &json!({ "action": "list" })).unwrap();
        let text = value.to_string();
        assert!(text.contains("chatgpt"), "{text}");
        assert!(text.contains("claude"), "{text}");
    }

    #[test]
    fn gemini_web_has_no_mcp_connector() {
        let error = drive(None, None, "workspace_webapp", &json!({ "action": "connect", "app": "gemini" })).unwrap_err();
        assert!(error.contains("Gemini"), "{error}");
        assert!(!error.to_ascii_lowercase().contains("completed"), "{error}");
    }

    #[test]
    fn obsidian_and_ollama_do_not_pretend_to_speak_mcp() {
        let obsidian = drive(None, None, "desktop_app", &json!({ "action": "connect", "app": "obsidian" })).unwrap_err();
        assert!(obsidian.contains("does not speak MCP"), "{obsidian}");
        let ollama = drive(None, None, "desktop_app", &json!({ "action": "connect", "app": "ollama" })).unwrap_err();
        assert!(ollama.contains("does not speak MCP"), "{ollama}");
    }

    #[test]
    fn opening_a_web_app_without_the_desktop_session_is_an_error() {
        let error = drive(None, None, "workspace_webapp", &json!({ "action": "open", "app": "chatgpt" })).unwrap_err();
        assert!(error.contains("desktop app"), "{error}");
        assert!(!error.to_ascii_lowercase().contains("completed"), "{error}");
        let connector = drive(None, None, "workspace_webapp", &json!({ "action": "connect", "app": "chatgpt" })).unwrap_err();
        assert!(connector.contains("https://chatgpt.com/#settings/apps"), "{connector}");
    }

    #[test]
    fn eval_stays_off_the_bridge() {
        let error = drive(None, None, "workspace_webapp", &json!({ "action": "eval", "app": "chatgpt", "script": "1" })).unwrap_err();
        assert!(error.contains("eval is not"), "{error}");
    }
}
