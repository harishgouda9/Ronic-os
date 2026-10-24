//! Universal MCP and ACP mesh.
//!
//! MCP stays the tool and memory bus (the existing authenticated bridge).
//! ACP is a local JSON-RPC inbox for peer tasks. Neither port is opened
//! without the bridge bearer token. Config writes merge `omni-workspace`
//! and leave every other server in place.

use crate::capabilities::{self, in_index};
use crate::code_mode;
use crate::db;
use crate::memory::{self, MemoryInput};
use crate::redact::redact;
use crate::tunnel;
use crate::util::{nid, now_ms, user_home};
use crate::workspace_bridge;
use crate::AppState;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager, State};

const MCP_ALIAS: u16 = 8765;
const ACP_PORT: u16 = 8766;

static ALIAS_PORT: AtomicU16 = AtomicU16::new(0);
static ACP_BOUND: AtomicU16 = AtomicU16::new(0);
static IO: Mutex<()> = Mutex::new(());

struct Known {
    id: &'static str,
    name: &'static str,
    kind: &'static str,
    protocol: &'static str,
}

const KNOWN: &[Known] = &[
    Known { id: "chatgpt_web", name: "ChatGPT Web", kind: "webapp", protocol: "Site chat · context attach (MCP via tunnel)" },
    Known { id: "claude_web", name: "Claude Web", kind: "webapp", protocol: "Site chat · context attach (MCP via tunnel)" },
    Known { id: "gemini_web", name: "Gemini Web", kind: "webapp", protocol: "Site chat · context attach (MCP via tunnel)" },
    Known { id: "grok_web", name: "Grok Web", kind: "webapp", protocol: "Site chat · context attach (MCP via tunnel)" },
    Known { id: "cursor_ide", name: "Cursor", kind: "desktop_ide", protocol: "MCP Streamable HTTP" },
    Known { id: "vscode_ide", name: "VS Code", kind: "desktop_ide", protocol: "MCP Streamable HTTP" },
    Known { id: "claude_desktop", name: "Claude Desktop", kind: "desktop_ide", protocol: "MCP Streamable HTTP" },
    Known { id: "claude_cli", name: "Claude Code CLI", kind: "coding_cli", protocol: "ACP + MCP Hybrid" },
    Known { id: "codex_cli", name: "Codex CLI", kind: "coding_cli", protocol: "ACP + MCP Hybrid" },
    Known { id: "agy_cli", name: "Gemini CLI", kind: "coding_cli", protocol: "ACP + MCP Hybrid" },
    Known { id: "aider", name: "Aider", kind: "coding_cli", protocol: "ACP + MCP Hybrid" },
    Known { id: "opencode", name: "OpenCode", kind: "coding_cli", protocol: "ACP + MCP Hybrid" },
    Known { id: "grokbot", name: "Grokbot", kind: "external_bot", protocol: "ACP + MCP Hybrid" },
    Known { id: "hermes", name: "Hermes", kind: "external_bot", protocol: "ACP + MCP Hybrid" },
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppFlags {
    auto_connected: bool,
    share_memory: bool,
    share_skills: bool,
    share_plugins: bool,
    allow_peer_calls: bool,
}

impl AppFlags {
    fn all_on() -> Self {
        Self { auto_connected: true, share_memory: true, share_skills: true, share_plugins: true, allow_peer_calls: true }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FlagsFile {
    #[serde(default = "default_true")]
    auto_connect_on_auth: bool,
    #[serde(default = "default_true")]
    code_mode_on: bool,
    #[serde(default)]
    apps: BTreeMap<String, AppFlags>,
}

fn default_true() -> bool {
    true
}

impl Default for FlagsFile {
    fn default() -> Self {
        Self { auto_connect_on_auth: true, code_mode_on: true, apps: BTreeMap::new() }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshApp {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub protocol: String,
    pub auth_status: String,
    pub endpoint: String,
    pub installed: bool,
    pub auto_connected: bool,
    pub share_memory: bool,
    pub share_skills: bool,
    pub share_plugins: bool,
    pub allow_peer_calls: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshStatus {
    pub auto_connect_on_auth: bool,
    pub code_mode_on: bool,
    pub mcp_endpoint: String,
    pub acp_endpoint: String,
    pub mcp_alias: String,
    pub note: String,
    pub dts_tokens: u32,
    pub raw_schema_tokens: u32,
    pub apps: Vec<MeshApp>,
    pub tunnel: crate::tunnel::TunnelStatus,
}

pub fn start(app: AppHandle) {
    let alias = app.clone();
    std::thread::spawn(move || serve_alias(alias));
    std::thread::spawn(move || serve_acp(app));
}

pub fn code_mode_enabled(home: &Path) -> bool {
    load_flags(home).code_mode_on
}

pub fn known_target(id: &str) -> bool {
    KNOWN.iter().any(|item| item.id == id) || id == "mem0"
}

pub fn ask_peer(conn: &Connection, home: &Path, source: &str, target: &str, task: &str) -> Result<Value, String> {
    let target = target.trim();
    let task = redact(task.trim());
    if target.is_empty() || task.trim().is_empty() {
        return Err("A peer call needs a target and a task.".into());
    }
    if task.chars().count() > 4000 {
        return Err("That peer task is too long.".into());
    }
    let flags = load_flags(home);
    if let Some(app) = flags.apps.get(source) {
        if !app.allow_peer_calls {
            return Err(format!("{source} has peer calls turned off."));
        }
    }
    if target == "mem0" {
        let title = clip(&task, 80);
        let saved = memory::remember(
            conn,
            &MemoryInput {
                id: None,
                title,
                content_markdown: task,
                source_type: "mesh".into(),
                scoped_bot_id: None,
                file_path_or_uri: String::new(),
                engine_id: None,
            },
        )
        .map_err(|error| error.0)?;
        return Ok(json!({
            "ticketId": saved.id,
            "target": "mem0",
            "executed": true,
            "reply": saved.note,
        }));
    }
    if !known_target(target) {
        return Err(format!("`{target}` is not on the mesh."));
    }
    if let Some(app) = flags.apps.get(target) {
        if !app.allow_peer_calls {
            return Err(format!("{target} is not accepting peer calls."));
        }
    }
    let id = nid("peer");
    let record = json!({
        "id": id,
        "source": source,
        "target": target,
        "task": task,
        "executed": false,
        "at": now_ms(),
    });
    append_task(home, &record)?;
    Ok(json!({
        "ticketId": id,
        "target": target,
        "executed": false,
        "reply": format!("Queued {id} for {target}. The task is in the mesh inbox. Ronic OS did not launch that app or change files."),
    }))
}

pub fn status_of(conn: &Connection, home: &Path) -> MeshStatus {
    let flags = load_flags(home);
    let settings = db::settings_of(conn).unwrap_or_default();
    let bridge = workspace_bridge::status();
    let spec = code_mode::compile(conn, home);
    let alias_port = ALIAS_PORT.load(Ordering::Relaxed);
    let acp_port = ACP_BOUND.load(Ordering::Relaxed);
    let mcp_endpoint = if bridge.port == 0 {
        "MCP bridge is still starting".to_string()
    } else {
        bridge.endpoint.clone()
    };
    let acp_endpoint = if acp_port == 0 {
        "ACP bus is still starting".to_string()
    } else {
        format!("http://127.0.0.1:{acp_port}/acp")
    };
    let mcp_alias = if alias_port == MCP_ALIAS {
        format!("http://127.0.0.1:{MCP_ALIAS}/mcp")
    } else {
        "8765 is not bound. Clients keep the bridge URL.".into()
    };
    let apps = KNOWN
        .iter()
        .map(|item| {
            let (installed, endpoint, auth_status) = locate(item.id, &settings, home);
            let saved = flags.apps.get(item.id).cloned().unwrap_or_else(AppFlags::all_on);
            let opted_in = if flags.apps.contains_key(item.id) { saved.auto_connected } else { flags.auto_connect_on_auth };
            let auto_connected = installed && opted_in;
            MeshApp {
                id: item.id.into(),
                name: item.name.into(),
                kind: item.kind.into(),
                protocol: item.protocol.into(),
                auth_status,
                endpoint,
                installed,
                auto_connected,
                share_memory: saved.share_memory,
                share_skills: saved.share_skills,
                share_plugins: saved.share_plugins,
                allow_peer_calls: saved.allow_peer_calls,
            }
        })
        .collect();
    MeshStatus {
        auto_connect_on_auth: flags.auto_connect_on_auth,
        code_mode_on: flags.code_mode_on,
        mcp_endpoint,
        acp_endpoint,
        mcp_alias,
        note: bridge.note,
        dts_tokens: spec.token_count_estimate,
        raw_schema_tokens: spec.raw_mcp_schema_tokens,
        apps,
        tunnel: tunnel::status(&read_token()),
    }
}

pub fn connect_all(app: &AppHandle, conn: &Connection, home: &Path) -> Result<Vec<String>, String> {
    let _guard = IO.lock().unwrap_or_else(|poison| poison.into_inner());
    let mut flags = load_flags(home);
    flags.auto_connect_on_auth = true;
    flags.code_mode_on = true;
    let settings = db::settings_of(conn).unwrap_or_default();
    for item in KNOWN {
        let (installed, _, _) = locate(item.id, &settings, home);
        let mut entry = AppFlags::all_on();
        entry.auto_connected = installed;
        flags.apps.insert(item.id.to_string(), entry);
    }
    save_flags_locked(home, &flags)?;
    let mut notes = Vec::new();
    for path in client_paths() {
        backup(home, &path);
    }
    match workspace_bridge::republish(app) {
        Ok((clients, note)) => {
            notes.extend(clients);
            if !note.is_empty() {
                notes.push(note);
            }
        }
        Err(error) => notes.push(error),
    }
    notes.push(write_hub(home)?);
    notes.extend(extra_configs(conn, home)?);
    Ok(notes)
}

pub fn set_flags(
    home: &Path,
    auto_connect_on_auth: Option<bool>,
    code_mode_on: Option<bool>,
    app_id: Option<&str>,
    field: Option<&str>,
    value: Option<bool>,
) -> Result<(), String> {
    let _guard = IO.lock().unwrap_or_else(|poison| poison.into_inner());
    let mut flags = load_flags(home);
    if let Some(value) = auto_connect_on_auth {
        flags.auto_connect_on_auth = value;
    }
    if let Some(value) = code_mode_on {
        flags.code_mode_on = value;
    }
    if let (Some(app_id), Some(field), Some(value)) = (app_id, field, value) {
        if !KNOWN.iter().any(|item| item.id == app_id) {
            return Err("That app is not on the mesh.".into());
        }
        let entry = flags.apps.entry(app_id.to_string()).or_insert_with(AppFlags::all_on);
        match field {
            "autoConnected" => entry.auto_connected = value,
            "shareMemory" => entry.share_memory = value,
            "shareSkills" => entry.share_skills = value,
            "sharePlugins" => entry.share_plugins = value,
            "allowPeerCalls" => entry.allow_peer_calls = value,
            _ => return Err("That capability is not on the mesh.".into()),
        }
    }
    save_flags_locked(home, &flags)
}

pub fn relay(conn: &Connection, home: &Path, source: &str, scenario: &str) -> Result<Vec<String>, String> {
    if !known_target(source) {
        return Err("Pick a mesh app as the caller.".into());
    }
    let flags = load_flags(home);
    if let Some(app) = flags.apps.get(source) {
        if !app.allow_peer_calls {
            return Err(format!("{source} has peer calls turned off."));
        }
    }
    match scenario {
        "mem0-skill-cli" => {
            let count: i64 = conn.query_row("SELECT COUNT(*) FROM memory_items", [], |row| row.get(0)).unwrap_or(0);
            let (slug, chars) = first_skill(conn, home)?;
            let ticket = ask_peer(conn, home, source, "claude_cli", &format!("Mesh relay from {source}. Memory rows: {count}. Skill: {slug} ({chars} chars). Do not edit files from this ticket."))?;
            Ok(vec![
                format!("Mem0 rows in state.db: {count}."),
                format!("Skill index hit: {slug} ({chars} characters loaded)."),
                ticket_line(&ticket),
            ])
        }
        "skill-cursor" => {
            let (slug, chars) = first_skill(conn, home)?;
            let ticket = ask_peer(conn, home, source, "cursor_ide", &format!("Mesh relay from {source}. Skill {slug} is {chars} characters. Do not edit files from this ticket."))?;
            Ok(vec![format!("Loaded {slug} ({chars} characters)."), ticket_line(&ticket)])
        }
        "store-mem0" => {
            let saved = memory::remember(
                conn,
                &MemoryInput {
                    id: None,
                    title: "Mesh relay".into(),
                    content_markdown: format!("Relay from {source}. No live web session was queried."),
                    source_type: "mesh".into(),
                    scoped_bot_id: None,
                    file_path_or_uri: String::new(),
                    engine_id: None,
                },
            )
            .map_err(|error| error.0)?;
            Ok(vec![format!("{} Ticket {}.", saved.note, saved.id)])
        }
        _ => Err("That relay is not one of the mesh tests.".into()),
    }
}

pub fn open_webapp(app: &AppHandle, app_id: &str) -> Result<String, String> {
    let (title, url) = match app_id {
        "chatgpt_web" => ("ChatGPT", "https://chatgpt.com"),
        "claude_web" => ("Claude", "https://claude.ai"),
        "gemini_web" => ("Gemini", "https://gemini.google.com"),
        "grok_web" => ("Grok", "https://grok.com"),
        _ => return Err("That app does not open as a webview.".into()),
    };
    open_webapp_at(app, app_id, title, url, format!("{title} is open. Signing in keeps that site session; it is a normal chat with the workspace context attached. For real MCP tools, connect {title} through the public tunnel in this studio."))
}

/// Open (or focus) a harness site window straight on the page where its own
/// MCP connector settings live, so the tunnel URL can be registered in the
/// harness account itself. That registration — not the sign-in — is what
/// makes the harness speak MCP.
pub fn open_connector_setup(app: &AppHandle, app_id: &str) -> Result<String, String> {
    let (title, url, steps) = match app_id {
        "chatgpt_web" => (
            "ChatGPT",
            "https://chatgpt.com/#settings/apps",
            "In ChatGPT: Settings, Apps & Connectors. Enable developer mode if asked, then create an app from the MCP URL below. ChatGPT fetches it from OpenAI's servers, which is why the public tunnel is required.",
        ),
        "claude_web" => (
            "Claude",
            "https://claude.ai/settings/connectors",
            "In Claude: Settings, Connectors, Add custom connector. Paste the MCP URL below. Claude fetches it from Anthropic's servers, which is why the public tunnel is required.",
        ),
        "grok_web" => (
            "Grok",
            "https://grok.com/settings",
            "Grok's app settings open where its integrations live. If custom MCP apps are available on your account, paste the MCP URL below.",
        ),
        "gemini_web" => {
            return Err("Gemini web has no custom MCP connector for consumer accounts. Use the Gemini CLI (already on the local MCP hub) or point any MCP client at the tunnel URL.".into())
        }
        _ => return Err("That app has no connector setup page.".into()),
    };
    open_webapp_at(app, app_id, title, url, format!("{steps}"))
}

fn open_webapp_at(app: &AppHandle, app_id: &str, title: &str, url: &str, note: String) -> Result<String, String> {
    let safe: String = app_id.chars().map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '_' }).collect();
    let label = format!("omni_webapp_{safe}");
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.show();
        let _ = existing.set_focus();
        if let Ok(parsed) = url.parse::<url::Url>() {
            if let Some(view) = app.get_webview(&label) {
                let _ = view.navigate(parsed);
            }
        }
        return Ok(note);
    }
    let parsed_url: url::Url = match url.parse() {
        Ok(parsed) => parsed,
        Err(_) => {
            crate::site_window::open_system_browser(url)?;
            return Ok(format!("Opened {title} in your browser."));
        }
    };
    let home = crate::util::product_home();
    let profile = match crate::site_window::ensure_profile(&home, &label) {
        Ok(dir) => dir,
        Err(_) => {
            crate::site_window::open_system_browser(url)?;
            return Ok(format!("Opened {title} in your browser."));
        }
    };
    let builder = tauri::WebviewWindowBuilder::new(app, &label, tauri::WebviewUrl::External(parsed_url))
        .title(format!("{title} — Ronic OS"))
        .inner_size(1080.0, 780.0);
    let builder = crate::site_window::site_window(builder, profile, app.clone(), label);
    match builder.build() {
        Ok(_) => Ok(note),
        Err(_) => {
            crate::site_window::open_system_browser(url)?;
            Ok(format!("Opened {title} in your browser."))
        }
    }
}

fn first_skill(conn: &Connection, home: &Path) -> Result<(String, usize), String> {
    let profile = active_profile(conn);
    let view = capabilities::view(conn, home, &profile).map_err(|error| error.0)?;
    let skill = view
        .skills
        .iter()
        .find(|skill| in_index(skill, &profile, capabilities::plugin_agent_on(&view.plugins, &skill.plugin_id, &profile)))
        .or_else(|| view.skills.first());
    if let Some(skill) = skill {
        let body = capabilities::load_skill_text(conn, home, &profile, &skill.slug).unwrap_or_default();
        Ok((skill.slug.clone(), body.chars().count()))
    } else {
        Ok(("workspace-starter".into(), 0))
    }
}

fn ticket_line(ticket: &Value) -> String {
    ticket.get("reply").and_then(|value| value.as_str()).unwrap_or("Peer call returned no reply.").to_string()
}

fn webapp_status(home: &Path, id: &str, url: &str) -> (bool, String, String) {
    let p1 = crate::site_window::profile_dir(home, &format!("webapp_{id}"));
    let p2 = crate::site_window::profile_dir(home, &format!("omni_webapp_{id}"));
    let p3 = crate::site_window::profile_dir(home, &format!("omni_webapp_{id}_web"));
    let active = p1.exists() || p2.exists() || p3.exists();
    // The page script reports a real sign-in signal from the site's own DOM.
    // A profile folder only proves the window was opened once.
    let signed_in = read_webapp_auth(home, id);
    if let Some(when) = signed_in {
        (true, url.into(), format!("Signed in · site chat only · signal {when}"))
    } else if active {
        (true, url.into(), "Opened · no sign-in signal yet · chat only".into())
    } else {
        (true, url.into(), "Not opened yet".into())
    }
}

/// Returns a short age of the last positive sign-in signal from the page, or
/// None when the site never reported a signed-in account.
fn read_webapp_auth(home: &Path, id: &str) -> Option<String> {
    let text = fs::read_to_string(home.join("webapp-auth.json")).ok()?;
    let root: Value = serde_json::from_str(&text).ok()?;
    let entry = root.get(id)?;
    if entry.get("signedIn").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    let at = entry.get("at").and_then(Value::as_i64).unwrap_or(0);
    let age_min = ((now_ms() - at) / 60_000).max(0);
    Some(if age_min < 1 { "under a minute ago".into() } else { format!("{age_min} min ago") })
}

fn locate(id: &str, settings: &crate::models::Settings, home: &Path) -> (bool, String, String) {
    match id {
        "chatgpt_web" => webapp_status(home, "chatgpt", "https://chatgpt.com"),
        "claude_web" => webapp_status(home, "claude", "https://claude.ai"),
        "gemini_web" => webapp_status(home, "gemini", "https://gemini.google.com"),
        "grok_web" => webapp_status(home, "grok", "https://grok.com"),
        "cursor_ide" => edition_status("cursor", "Cursor config is merged into ~/.cursor/mcp.json"),
        "vscode_ide" => edition_status("vscode", "VS Code config is merged into the User mcp.json"),
        "claude_desktop" => dir_status(appdata().map(|path| path.join("Claude")), "Claude Desktop config"),
        "claude_cli" => binary_status_with_fallback(&settings.claude_path, "Claude Code", &["claude"]),
        "codex_cli" => binary_status_with_fallback(&settings.codex_path, "Codex CLI", &["codex"]),
        "agy_cli" => binary_status_with_fallback(&settings.gemini_path, "Gemini CLI", &["agy", "gemini"]),
        "aider" => binary_status_with_fallback(&settings.aider_path, "Aider", &["aider"]),
        "opencode" => binary_status_with_fallback(&settings.opencode_path, "OpenCode", &["opencode"]),
        "grokbot" => {
            let (inst, path, _) = edition_status("grokbot", "Grokbot");
            if inst {
                (true, path, "MCP & ACP Connected · Detected on disk".into())
            } else {
                let grok_dir = user_home().join(".grok");
                let grokbot_dir = user_home().join(".grokbot");
                let web_dir = crate::site_window::profile_dir(home, "webapp_grok");
                let web_dir2 = crate::site_window::profile_dir(home, "omni_webapp_grok_web");
                if grokbot_dir.is_dir() || grok_dir.is_dir() {
                    (true, (if grokbot_dir.is_dir() { grokbot_dir } else { grok_dir }).display().to_string(), "MCP & ACP Connected · ~/.grokbot".into())
                } else if web_dir.exists() || web_dir2.exists() {
                    (true, "https://grok.com".into(), "Grok web session on disk · chat only".into())
                } else {
                    (true, "https://grok.com".into(), "Not opened yet".into())
                }
            }
        }
        "hermes" => {
            let (inst, path, note) = edition_status("hermes", "Hermes");
            if inst {
                (true, path, "MCP Connected · Detected on disk".into())
            } else {
                let hermes_dir = user_home().join(".hermes");
                if hermes_dir.is_dir() {
                    (true, hermes_dir.display().to_string(), "MCP Connected · ~/.hermes".into())
                } else {
                    (false, path, note)
                }
            }
        }
        _ => (false, String::new(), "Not found".into()),
    }
}

fn edition_status(id: &str, label: &str) -> (bool, String, String) {
    let found = crate::workspace_apps::detected_editions(id, false);
    if let Some(path) = found.desktop.or(found.terminal) {
        (true, path.display().to_string(), "Detected on disk".into())
    } else {
        (false, label.into(), "Not found".into())
    }
}

fn binary_status_with_fallback(path: &str, label: &str, cmds: &[&str]) -> (bool, String, String) {
    let path = path.trim();
    if !path.is_empty() && Path::new(path).exists() {
        return (true, path.to_string(), "Detected on disk".into());
    }
    for cmd in cmds {
        if let Some(found) = crate::util::which(cmd) {
            return (true, found, "Detected on disk".into());
        }
        for cand in crate::util::windows_bin_candidates(cmd) {
            if cand.exists() {
                return (true, cand.display().to_string(), "Detected on disk".into());
            }
        }
    }
    if path.is_empty() {
        (false, format!("{label} has no path from the last scan"), "Not found".into())
    } else {
        (false, path.to_string(), "Saved path is missing".into())
    }
}


fn dir_status(path: Option<PathBuf>, label: &str) -> (bool, String, String) {
    match path {
        Some(path) if path.is_dir() => (true, path.display().to_string(), "Detected on disk".into()),
        Some(path) => (false, path.display().to_string(), "Not found".into()),
        None => (false, label.into(), "Not found".into()),
    }
}

fn appdata() -> Option<PathBuf> {
    std::env::var_os("APPDATA").map(PathBuf::from)
}

fn client_paths() -> Vec<PathBuf> {
    let home = user_home();
    let mut paths = vec![
        home.join(".claude.json"),
        home.join(".cursor").join("mcp.json"),
        home.join(".gemini").join("settings.json"),
        home.join(".codex").join("config.toml"),
        home.join(".config").join("opencode").join("opencode.json"),
        home.join(".omniworkspace").join("mcp-hub.json"),
    ];
    if let Some(appdata) = appdata() {
        paths.push(appdata.join("Code").join("User").join("mcp.json"));
        paths.push(appdata.join("Code - Insiders").join("User").join("mcp.json"));
        paths.push(appdata.join("Claude").join("claude_desktop_config.json"));
    }
    paths
}

fn write_hub(home: &Path) -> Result<String, String> {
    let entry = hub_entry()?;
    let path = home.join("mcp-hub.json");
    backup(home, &path);
    let payload = json!({ "mcpServers": { "omni-workspace": entry } });
    fs::write(&path, serde_json::to_vec_pretty(&payload).map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
    Ok(format!("Master CLI hub ({})", path.display()))
}

fn hub_entry() -> Result<Value, String> {
    let status = workspace_bridge::status();
    if status.port == 0 || status.endpoint.is_empty() {
        return Err("The MCP bridge is not listening, so the hub file was not written.".into());
    }
    let home = crate::util::product_home();
    let token = fs::read_to_string(home.join("bridge-token")).map_err(|error| error.to_string())?;
    let token = token.trim();
    if token.len() < 32 {
        return Err("The bridge token is missing, so the hub file was not written.".into());
    }
    Ok(json!({
        "type": "http",
        "url": status.endpoint,
        "headers": { "Authorization": format!("Bearer {token}") }
    }))
}

fn extra_configs(conn: &Connection, home: &Path) -> Result<Vec<String>, String> {
    let entry = match hub_entry() {
        Ok(entry) => entry,
        Err(error) => return Ok(vec![error]),
    };
    let mut notes = Vec::new();
    if let Some(appdata) = appdata() {
        let insiders = appdata.join("Code - Insiders").join("User");
        if insiders.is_dir() {
            let path = insiders.join("mcp.json");
            backup(home, &path);
            match workspace_bridge::upsert_mcp(&path, &entry, true) {
                Ok(_) => notes.push(format!("VS Code Insiders ({})", path.display())),
                Err(error) => notes.push(error),
            }
        }
    }
    let settings = db::settings_of(conn).unwrap_or_default();
    let root = settings.project_root.trim();
    if !root.is_empty() {
        let vscode = PathBuf::from(root).join(".vscode");
        if vscode.is_dir() {
            let path = vscode.join("mcp.json");
            backup(home, &path);
            match workspace_bridge::upsert_mcp(&path, &entry, true) {
                Ok(_) => notes.push(format!("Workspace VS Code ({})", path.display())),
                Err(error) => notes.push(error),
            }
        }
    }
    notes.push(append_codex(&entry)?);
    notes.push(merge_opencode(&entry)?);
    notes.push("Aider and OpenCode read ~/.omniworkspace/mcp-hub.json when they are started with that MCP config. Their own config files were left alone unless OpenCode's JSON was already present.".into());
    Ok(notes)
}

fn append_codex(entry: &Value) -> Result<String, String> {
    let path = user_home().join(".codex").join("config.toml");
    if !path.is_file() {
        return Ok(format!("Codex config was left absent ({})", path.display()));
    }
    let text = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    if text.contains("omniworkspace-mcp-hub") {
        return Ok(format!("Codex already has the Ronic hub marker ({})", path.display()));
    }
    let url = entry.get("url").and_then(|value| value.as_str()).unwrap_or("");
    let token = entry
        .pointer("/headers/Authorization")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim_start_matches("Bearer ")
        .trim();
    backup(&crate::util::product_home(), &path);
    let mut file = fs::OpenOptions::new().append(true).open(&path).map_err(|error| error.to_string())?;
    writeln!(
        file,
        "\n# omniworkspace-mcp-hub\n[mcp_servers.omni-workspace]\nurl = \"{url}\"\n\n[mcp_servers.omni-workspace.http_headers]\nAuthorization = \"Bearer {token}\"\n"
    )
    .map_err(|error| error.to_string())?;
    Ok(format!("Codex config appended ({})", path.display()))
}

fn merge_opencode(entry: &Value) -> Result<String, String> {
    let path = user_home().join(".config").join("opencode").join("opencode.json");
    if !path.is_file() {
        return Ok(format!("OpenCode config was left absent ({})", path.display()));
    }
    let text = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let mut root: Value = match serde_json::from_str::<Value>(&text) {
        Ok(value) if value.is_object() => value,
        _ => return Ok(format!("OpenCode config is not a JSON object, so it was left unchanged ({})", path.display())),
    };
    let mcp = root.as_object_mut().unwrap().entry("mcp").or_insert_with(|| json!({}));
    if !mcp.is_object() {
        return Ok(format!("OpenCode mcp field is not an object, so it was left unchanged ({})", path.display()));
    }
    backup(&crate::util::product_home(), &path);
    mcp.as_object_mut().unwrap().insert(
        "omni-workspace".into(),
        json!({
            "type": "remote",
            "url": entry.get("url").cloned().unwrap_or(Value::Null),
            "headers": entry.get("headers").cloned().unwrap_or_else(|| json!({})),
        }),
    );
    fs::write(&path, serde_json::to_vec_pretty(&root).map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
    Ok(format!("OpenCode config merged ({})", path.display()))
}

fn backup(home: &Path, path: &Path) {
    if !path.is_file() {
        return;
    }
    let dir = home.join(".shadow-git").join("mcp-acp");
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    let name = path.file_name().and_then(|name| name.to_str()).unwrap_or("config");
    let dest = dir.join(format!("{}-{name}", now_ms()));
    let _ = fs::copy(path, dest);
}

fn load_flags(home: &Path) -> FlagsFile {
    let path = home.join("mesh").join("flags.json");
    let Ok(text) = fs::read_to_string(path) else {
        return FlagsFile::default();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

fn save_flags_locked(home: &Path, flags: &FlagsFile) -> Result<(), String> {
    let dir = home.join("mesh");
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let bytes = serde_json::to_vec_pretty(flags).map_err(|error| error.to_string())?;
    fs::write(dir.join("flags.json"), bytes).map_err(|error| error.to_string())
}

fn append_task(home: &Path, record: &Value) -> Result<(), String> {
    let _guard = IO.lock().unwrap_or_else(|poison| poison.into_inner());
    let dir = home.join("mesh");
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let mut file = fs::OpenOptions::new().create(true).append(true).open(dir.join("peer-tasks.jsonl")).map_err(|error| error.to_string())?;
    writeln!(file, "{record}").map_err(|error| error.to_string())
}

fn active_profile(conn: &Connection) -> String {
    if let Ok(Some(id)) = db::kv_get(conn, "active_profile") {
        if !id.trim().is_empty() {
            return id;
        }
    }
    conn.query_row("SELECT id FROM bot_profiles ORDER BY created_at LIMIT 1", [], |row| row.get(0)).unwrap_or_default()
}

fn clip(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max_chars).collect();
    out.push('…');
    out
}

fn serve_alias(app: AppHandle) {
    for _ in 0..50 {
        if workspace_bridge::status().port != 0 {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let listener = match TcpListener::bind(("127.0.0.1", MCP_ALIAS)) {
        Ok(listener) => listener,
        Err(_) => return,
    };
    ALIAS_PORT.store(MCP_ALIAS, Ordering::Relaxed);
    for incoming in listener.incoming() {
        let Ok(mut stream) = incoming else { continue };
        let app = app.clone();
        std::thread::spawn(move || {
            let _ = stream.set_read_timeout(Some(Duration::from_secs(8)));
            let _ = stream.set_write_timeout(Some(Duration::from_secs(8)));
            let Ok((head, headers, body)) = workspace_bridge::read_request(&mut stream) else { return };
            let mut parts = head.split_whitespace();
            let method = parts.next().unwrap_or("");
            let target = parts.next().unwrap_or("/");
            let token = read_token();
            let (status, payload) = if !target.starts_with("/mcp") {
                (404, br#"{"error":"not found"}"#.to_vec())
            } else if method == "OPTIONS" {
                (204, Vec::new())
            } else if method != "POST" {
                (405, br#"{"error":"use POST"}"#.to_vec())
            } else if !workspace_bridge::authorized(&token, target, &headers) {
                (401, br#"{"error":"unauthorized"}"#.to_vec())
            } else {
                // An authorized call through this port is real evidence that a
                // client — local or through the tunnel — spoke MCP.
                tunnel::record_mcp_call();
                match workspace_bridge::mcp_json_rpc(&app, &body) {
                    Some(bytes) => (200, bytes),
                    None => (202, Vec::new()),
                }
            };
            let _ = workspace_bridge::write_response(&mut stream, status, "application/json", &payload);
        });
    }
}

fn serve_acp(app: AppHandle) {
    let listener = match TcpListener::bind(("127.0.0.1", ACP_PORT)) {
        Ok(listener) => listener,
        Err(_) => return,
    };
    ACP_BOUND.store(ACP_PORT, Ordering::Relaxed);
    for incoming in listener.incoming() {
        let Ok(mut stream) = incoming else { continue };
        let app = app.clone();
        std::thread::spawn(move || {
            let _ = stream.set_read_timeout(Some(Duration::from_secs(8)));
            let _ = stream.set_write_timeout(Some(Duration::from_secs(8)));
            let Ok((head, headers, body)) = workspace_bridge::read_request(&mut stream) else { return };
            let mut parts = head.split_whitespace();
            let method = parts.next().unwrap_or("");
            let target = parts.next().unwrap_or("/");
            if method == "GET" && target.starts_with("/health") {
                let payload = format!(r#"{{"ok":true,"protocol":"acp-jsonrpc-2.0","port":{ACP_PORT}}}"#);
                let _ = workspace_bridge::write_response(&mut stream, 200, "application/json", payload.as_bytes());
                return;
            }
            if method == "OPTIONS" {
                let _ = workspace_bridge::write_response(&mut stream, 204, "text/plain", b"");
                return;
            }
            if method != "POST" || !target.starts_with("/acp") {
                let _ = workspace_bridge::write_response(&mut stream, 404, "application/json", br#"{"error":"not found"}"#);
                return;
            }
            let token = read_token();
            if !workspace_bridge::authorized(&token, target, &headers) {
                let _ = workspace_bridge::write_response(&mut stream, 401, "application/json", br#"{"error":"unauthorized"}"#);
                return;
            }
            let payload = acp_rpc(&app, &body);
            let _ = workspace_bridge::write_response(&mut stream, 200, "application/json", &payload);
        });
    }
}

fn acp_rpc(app: &AppHandle, body: &[u8]) -> Vec<u8> {
    let parsed: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
    let id = parsed.get("id").cloned().unwrap_or(Value::Null);
    let method = parsed.get("method").and_then(|value| value.as_str()).unwrap_or("");
    let result = match method {
        "initialize" | "ping" => Ok(json!({
            "protocol": "acp-jsonrpc-2.0",
            "methods": ["initialize", "ping", "session/prompt", "omni/askPeer"],
            "note": "session/prompt stores a peer ticket. It does not stream a diff or start a PTY."
        })),
        "session/prompt" | "omni/askPeer" => {
            let params = parsed.get("params").cloned().unwrap_or_else(|| json!({}));
            let target = params.get("target").and_then(|value| value.as_str()).unwrap_or("claude_cli");
            let task = params.get("prompt").or_else(|| params.get("task")).and_then(|value| value.as_str()).unwrap_or("");
            match app.try_state::<AppState>() {
                Some(state) => {
                    let home = state.home.clone();
                    let conn = state.conn.lock().unwrap_or_else(|poison| poison.into_inner());
                    ask_peer(&conn, &home, "acp", target, task).map_err(|error| error)
                }
                None => Err("workspace database is not open".into()),
            }
        }
        _ => Err("method not found".into()),
    };
    let message = match result {
        Ok(value) => json!({ "jsonrpc": "2.0", "id": id, "result": value }),
        Err(error) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": error } }),
    };
    serde_json::to_vec(&message).unwrap_or_else(|_| b"{}".to_vec())
}

fn read_token() -> String {
    fs::read_to_string(crate::util::product_home().join("bridge-token")).unwrap_or_default().trim().to_string()
}

#[tauri::command]
pub async fn mesh_status(state: State<'_, AppState>) -> Result<MeshStatus, String> {
    let conn = state.conn.lock().unwrap_or_else(|poison| poison.into_inner());
    Ok(status_of(&conn, &state.home))
}

#[tauri::command]
pub async fn mesh_connect_all(app: AppHandle, state: State<'_, AppState>) -> Result<MeshStatus, String> {
    let note = {
        let conn = state.conn.lock().unwrap_or_else(|poison| poison.into_inner());
        connect_all(&app, &conn, &state.home)?.join("\n")
    };
    let mut status = {
        let conn = state.conn.lock().unwrap_or_else(|poison| poison.into_inner());
        status_of(&conn, &state.home)
    };
    status.note = note;
    Ok(status)
}

#[tauri::command]
pub async fn mesh_set_flags(
    state: State<'_, AppState>,
    auto_connect_on_auth: Option<bool>,
    code_mode_on: Option<bool>,
    app_id: Option<String>,
    field: Option<String>,
    value: Option<bool>,
) -> Result<MeshStatus, String> {
    set_flags(
        &state.home,
        auto_connect_on_auth,
        code_mode_on,
        app_id.as_deref(),
        field.as_deref(),
        value,
    )?;
    let conn = state.conn.lock().unwrap_or_else(|poison| poison.into_inner());
    Ok(status_of(&conn, &state.home))
}

#[tauri::command]
pub async fn mesh_relay(state: State<'_, AppState>, source: String, scenario: String) -> Result<Vec<String>, String> {
    let conn = state.conn.lock().unwrap_or_else(|poison| poison.into_inner());
    relay(&conn, &state.home, source.trim(), scenario.trim())
}

#[tauri::command]
pub async fn open_mcp_connected_webapp(app: AppHandle, app_id: String) -> Result<String, String> {
    open_webapp(&app, app_id.trim())
}

#[tauri::command]
pub async fn open_harness_mcp_setup(app: AppHandle, app_id: String) -> Result<String, String> {
    open_connector_setup(&app, app_id.trim())
}

#[tauri::command]
pub async fn get_webapp_mcp_context_bundle(state: State<'_, AppState>, origin: String) -> Result<String, String> {
    let origin = origin.trim();
    if origin.chars().count() > 200 {
        return Err("That origin is too long.".into());
    }
    let conn = state.conn.lock().unwrap_or_else(|poison| poison.into_inner());
    Ok(workspace_bridge::context_bundle(&conn, &state.home, origin))
}

#[tauri::command]
pub async fn omni_ask_peer_app(state: State<'_, AppState>, source: String, target: String, task: String) -> Result<Value, String> {
    let conn = state.conn.lock().unwrap_or_else(|poison| poison.into_inner());
    ask_peer(&conn, &state.home, source.trim(), target.trim(), task.trim())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn peer_ticket_is_stored_and_does_not_claim_a_launch() {
        let dir = std::env::temp_dir().join(format!("omni-mesh-peer-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let conn = Connection::open_in_memory().unwrap();
        let value = ask_peer(&conn, &dir, "chatgpt_web", "claude_cli", "read the skill index").unwrap();
        assert_eq!(value["executed"], false);
        let reply = value["reply"].as_str().unwrap();
        assert!(reply.contains("did not launch"));
        let inbox = fs::read_to_string(dir.join("mesh").join("peer-tasks.jsonl")).unwrap();
        assert!(inbox.contains("claude_cli"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unknown_peer_is_rejected() {
        let dir = std::env::temp_dir().join(format!("omni-mesh-unknown-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let conn = Connection::open_in_memory().unwrap();
        let error = ask_peer(&conn, &dir, "codemode", "shell", "id").unwrap_err();
        assert!(error.contains("not on the mesh"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn code_mode_defaults_on() {
        let dir = std::env::temp_dir().join(format!("omni-mesh-flags-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        assert!(code_mode_enabled(&dir));
        set_flags(&dir, None, Some(false), None, None, None).unwrap();
        assert!(!code_mode_enabled(&dir));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn webapp_status_never_claims_mcp_from_a_profile_folder() {
        let dir = std::env::temp_dir().join(format!("omni-mesh-webapp-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        // A folder that only proves the window was once opened must not read
        // as an MCP connection.
        let (_, _, never_opened) = webapp_status(&dir, "chatgpt", "https://chatgpt.com");
        assert_eq!(never_opened, "Not opened yet");
        let profile = crate::site_window::profile_dir(&dir, "omni_webapp_chatgpt");
        fs::create_dir_all(profile.join("EBWebView")).unwrap();
        let (_, _, opened) = webapp_status(&dir, "chatgpt", "https://chatgpt.com");
        assert!(opened.contains("no sign-in signal"), "got: {opened}");
        assert!(!opened.to_ascii_lowercase().contains("mcp connected"));
        // A real page sign-in signal upgrades the label to a site session,
        // still without claiming MCP.
        fs::write(
            dir.join("webapp-auth.json"),
            format!(r#"{{"chatgpt": {{"signedIn": true, "at": {}, "host": "chatgpt.com"}}}}"#, now_ms() - 120_000),
        )
        .unwrap();
        let (_, _, signed) = webapp_status(&dir, "chatgpt", "https://chatgpt.com");
        assert!(signed.starts_with("Signed in"), "got: {signed}");
        assert!(signed.contains("site chat only"), "got: {signed}");
        let _ = fs::remove_dir_all(&dir);
    }
}
