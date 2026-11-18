//! Local bridge so embedded web apps and CLI harnesses can use Ronic OS skills, plugins, and memory.
//!
//! The HTTP server speaks MCP on 127.0.0.1 and is registered for Claude Code, Gemini CLI, Cursor,
//! and VS Code when that profile exists. Webviews cannot fetch localhost through page CSP, so the
//! page script queues requests and this process executes the same whitelist.

use crate::capabilities::{self, in_index};
use crate::db;
use crate::memory::{self, MemoryInput};
use crate::redact::redact;
use crate::util::{ipc_push, now_ms, user_home};
use crate::AppState;
use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::{json, Value};
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

pub const PAGE_SCRIPT: &str = include_str!("bridge_page.js");
const PORT: u16 = 47331;
const MAX_BODY: usize = 1_000_000;
const PACK_LIMIT: usize = 7000;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeStatus {
    pub port: u16,
    pub endpoint: String,
    pub clients: Vec<String>,
    pub note: String,
}

struct Shared {
    port: u16,
    endpoint: String,
    clients: Vec<String>,
    note: String,
    saves: (u64, u32),
}

static SHARED: Mutex<Shared> = Mutex::new(Shared {
    port: 0,
    endpoint: String::new(),
    clients: Vec::new(),
    note: String::new(),
    saves: (0, 0),
});

static IN_FLIGHT: Mutex<Vec<(String, Instant)>> = Mutex::new(Vec::new());

pub fn status() -> BridgeStatus {
    let shared = SHARED.lock().unwrap_or_else(|poison| poison.into_inner());
    BridgeStatus {
        port: shared.port,
        endpoint: shared.endpoint.clone(),
        clients: shared.clients.clone(),
        note: shared.note.clone(),
    }
}

pub fn start(app: AppHandle) {
    let server = app.clone();
    std::thread::spawn(move || serve(server));
    std::thread::spawn(move || pump(app));
}

fn serve(app: AppHandle) {
    let token = load_token(&app);
    let listener = match TcpListener::bind(("127.0.0.1", PORT)).or_else(|_| TcpListener::bind(("127.0.0.1", 0))) {
        Ok(listener) => listener,
        Err(error) => {
            set_note(format!("Workspace bridge did not start: {error}"));
            return;
        }
    };
    let port = listener.local_addr().map(|addr| addr.port()).unwrap_or(PORT);
    let endpoint = format!("http://127.0.0.1:{port}/mcp");
    let (clients, note) = register_clients(port, &token);
    {
        let mut shared = SHARED.lock().unwrap_or_else(|poison| poison.into_inner());
        shared.port = port;
        shared.endpoint = endpoint.clone();
        shared.clients = clients;
        shared.note = note;
    }
    let _ = fs::write(bridge_home(&app).join("bridge.json"), serde_json::to_vec_pretty(&json!({"port": port, "endpoint": endpoint})).unwrap_or_default());
    if let Some(state) = app.try_state::<AppState>() {
        ipc_push(&state.ipc, &format!("workspace bridge on {port}"));
    }
    for incoming in listener.incoming() {
        let Ok(mut stream) = incoming else { continue };
        let _ = stream.set_read_timeout(Some(Duration::from_secs(8)));
        let _ = stream.set_write_timeout(Some(Duration::from_secs(8)));
        let app = app.clone();
        let token = token.clone();
        std::thread::spawn(move || session(&app, &token, &mut stream));
    }
}

fn session(app: &AppHandle, token: &str, stream: &mut TcpStream) {
    for _ in 0..16 {
        let Ok((head, headers, body)) = read_request(stream) else { return };
        let mut parts = head.split_whitespace();
        let method = parts.next().unwrap_or("");
        let target = parts.next().unwrap_or("/");
        if !target.starts_with("/mcp") && target != "/health" {
            let _ = write_response(stream, 404, "application/json", b"{\"error\":\"not found\"}");
            continue;
        }
        if method == "GET" || method == "DELETE" {
            let _ = write_response(stream, 405, "application/json", b"{\"error\":\"use POST\"}");
            continue;
        }
        if method == "OPTIONS" {
            let _ = write_response(stream, 204, "text/plain", b"");
            continue;
        }
        if method != "POST" {
            let _ = write_response(stream, 405, "application/json", b"{\"error\":\"use POST\"}");
            continue;
        }
        if !authorized(token, target, &headers) {
            let _ = write_response(stream, 401, "application/json", b"{\"error\":\"unauthorized\"}");
            continue;
        }
        let Some(reply) = mcp_json_rpc(app, &body) else {
            let _ = write_response(stream, 202, "application/json", b"");
            continue;
        };
        if write_response(stream, 200, "application/json", &reply).is_err() {
            return;
        }
    }
}

pub(crate) fn mcp_json_rpc(app: &AppHandle, body: &[u8]) -> Option<Vec<u8>> {
    let parsed: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
    if parsed.is_array() {
        let items = parsed.as_array().cloned().unwrap_or_default();
        let mut out = Vec::new();
        for item in items {
            if let Some(one) = rpc(app, &item) {
                out.push(one);
            }
        }
        if out.is_empty() {
            None
        } else {
            Some(serde_json::to_vec(&Value::Array(out)).unwrap_or_else(|_| b"[]".to_vec()))
        }
    } else {
        rpc(app, &parsed).map(|one| serde_json::to_vec(&one).unwrap_or_else(|_| b"{}".to_vec()))
    }
}

pub(crate) fn context_bundle(conn: &Connection, home: &Path, origin: &str) -> String {
    let origin = origin.trim();
    let body = context_block(conn, home, "");
    if origin.is_empty() {
        body
    } else {
        format!("Origin: {origin}\n{body}")
    }
}

/// The live workspace pack, for browser automation that writes a chat composer.
pub fn live_context_pack(app: &AppHandle) -> String {
    with_db(app, |conn, home| context_block(conn, home, "")).unwrap_or_default()
}

/// Hosts where typed text is a message to other people. The login is recorded.
/// The workspace pack is not written into that message.
pub(crate) fn channel_host(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    host == "slack.com"
        || host == "app.slack.com"
        || host.ends_with(".slack.com")
        || host == "discord.com"
        || host == "discordapp.com"
        || host.ends_with(".discord.com")
        || host.ends_with(".discordapp.com")
        || host == "teams.microsoft.com"
        || host == "teams.live.com"
        || host == "web.telegram.org"
        || host == "web.whatsapp.com"
        || host == "mail.google.com"
        || host == "outlook.office.com"
        || host == "outlook.live.com"
}

/// Any non-login site the bot or workspace browser is on. Sign-in is recorded
/// for file tools and browser tools, not only for Slack.
pub(crate) fn session_page_host(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    !host.is_empty() && !is_auth_host(&host)
}

/// Private composers (chat apps, the project site, a local tool) receive the
/// pack. Team-message hosts and account-login pages do not.
pub(crate) fn composer_injection_host(host: &str) -> bool {
    session_page_host(host) && !channel_host(host)
}

/// Append the workspace pack to a prompt the bot is about to type.
/// Works for every composer that is not a team-message site.
/// Short values with no spaces (passwords, emails, codes) are left alone.
pub fn inject_composer_text(host: &str, pack: &str, typed: &str) -> String {
    let typed = typed.trim();
    if typed.is_empty() || !composer_injection_host(host) || typed.contains("[Ronic OS connection]") {
        return typed.to_string();
    }
    let pack = pack.trim();
    if pack.is_empty() || !prompt_like(typed) {
        return typed.to_string();
    }
    format!("{typed}\n\n{pack}")
}

fn prompt_like(text: &str) -> bool {
    let text = text.trim();
    text.chars().count() >= 8 && (text.contains(' ') || text.contains('\n'))
}

pub(crate) fn session_page_url(url: &url::Url) -> bool {
    let scheme = url.scheme();
    if scheme != "https" && scheme != "http" {
        return false;
    }
    let host = url.host_str().unwrap_or("");
    !is_auth_host(host) && session_page_host(host)
}

/// Project folder plus signed-in browser hosts. This is the block a bot reads
/// before it decides the workspace is unreachable.
pub fn format_injection_brief(project_root: &str, home: &Path) -> String {
    let project = project_root.trim();
    let project = if project.is_empty() || project == "none" { "" } else { project };
    let project_line = if project.is_empty() {
        "Project folder: none. Set the project folder before reading project files.".to_string()
    } else {
        format!("Project folder: {project}")
    };
    let sessions = signed_in_hosts(home);
    let session_line = if sessions.is_empty() {
        "Browser sessions: none reported yet.".to_string()
    } else {
        format!("Browser sessions: {} signed in.", sessions.join(", "))
    };
    format!(
        "Context injection:\n{project_line}\nThis context is on every tool: file tools, browser tools, and workspace webapps. It is not limited to Slack.\nRead this folder with list_files and read_file. An empty list_files path is the project folder. A project-relative path such as supabase/schema.sql opens that file. The bot terminal stays inside that bot's own workspace and cannot open this folder. Do not ask the user to attach the project folder when it is named here.\n{session_line}\nA login on any site in the workspace browser or any bot browser is one shared page session. Use inspect_page, read_page, click_control, and type_text on it. Do not ask the user to sign in again when that site is listed. Team-message sites (Slack, Discord, Teams, Telegram, WhatsApp, and mail) keep the login here and do not receive this pack inside a message to other people."
    )
}

/// One line appended to a tool result so the same context is present on every
/// function, including ones that never open Slack.
pub fn injection_footer(project_root: &str, home: &Path) -> String {
    let project = project_root.trim();
    let project = if project.is_empty() || project == "none" {
        "none".to_string()
    } else {
        project.to_string()
    };
    let sessions = signed_in_hosts(home);
    let sessions = if sessions.is_empty() {
        "none reported".to_string()
    } else {
        sessions.join(", ")
    };
    format!("Context injection applies to every tool, not only Slack. Project folder: {project}. Browser sessions: {sessions}. list_files with an empty path, and read_file with a project-relative path such as supabase/schema.sql, read that folder. The terminal cannot. Team-message sites do not get this pack written into a message.")
}

pub fn signed_in_hosts(home: &Path) -> Vec<String> {
    let path = home.join("webapp-auth.json");
    let Ok(text) = fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(root) = serde_json::from_str::<Value>(&text) else {
        return Vec::new();
    };
    let Some(map) = root.as_object() else {
        return Vec::new();
    };
    let mut hosts = Vec::new();
    for entry in map.values() {
        if entry.get("signedIn").and_then(Value::as_bool) != Some(true) {
            continue;
        }
        let Some(host) = entry.get("host").and_then(Value::as_str) else {
            continue;
        };
        let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
        if host.is_empty() || hosts.iter().any(|item: &String| item == &host) {
            continue;
        }
        hosts.push(host);
    }
    hosts.sort();
    hosts
}

pub(crate) fn republish(app: &AppHandle) -> Result<(Vec<String>, String), String> {
    let token = load_token(app);
    let port = status().port;
    if port == 0 {
        return Err("The MCP bridge is not listening yet.".into());
    }
    Ok(register_clients(port, &token))
}

fn rpc(app: &AppHandle, body: &Value) -> Option<Value> {
    let id = body.get("id").cloned().filter(|value| !value.is_null())?;
    let method = body.get("method").and_then(|value| value.as_str()).unwrap_or("");
    let result = match method {
        "initialize" => Ok(json!({
            "protocolVersion": protocol_of(body),
            "capabilities": { "tools": { "listChanged": false } },
            "serverInfo": { "name": "ronic-os", "version": env!("CARGO_PKG_VERSION") },
            "instructions": instructions()
        })),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tool_defs() })),
        "tools/call" => {
            let name = body.pointer("/params/name").and_then(|value| value.as_str()).unwrap_or("");
            let args = body.pointer("/params/arguments").cloned().unwrap_or_else(|| json!({}));
            if name == "ronic_execute_codemode" {
                let script = crate::code_mode::script_arg(&args);
                let home = bridge_home(app);
                match crate::code_mode::execute_with(&home, &script, Some(app)) {
                    Ok(result) => Ok(json!({ "content": [{ "type": "text", "text": result.final_return_json }], "isError": !result.ok })),
                    Err(error) => Ok(json!({ "content": [{ "type": "text", "text": error }], "isError": true })),
                }
            } else if crate::dock_mcp::is_dock_tool(name) {
                // Dock apps touch webviews and client config. They stay outside
                // the database lock, and a missing action is an error.
                match crate::dock_mcp::drive(Some(app), None, name, &args) {
                    Ok(value) => {
                        let text = serde_json::to_string_pretty(&value).unwrap_or_else(|_| value.to_string());
                        Ok(json!({ "content": [{ "type": "text", "text": text }], "isError": false }))
                    }
                    Err(error) => Ok(json!({ "content": [{ "type": "text", "text": error }], "isError": true })),
                }
            } else {
                match with_db(app, |conn, home| call_tool(conn, home, name, &args)) {
                    Some(Ok(text)) => Ok(json!({ "content": [{ "type": "text", "text": text }], "isError": false })),
                    Some(Err(error)) => Ok(json!({ "content": [{ "type": "text", "text": error }], "isError": true })),
                    None => Err("workspace database is not open".to_string()),
                }
            }
        }
        _ => Err("method not found".into()),
    };
    Some(match result {
        Ok(value) => json!({ "jsonrpc": "2.0", "id": id, "result": value }),
        Err(message) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": message } }),
    })
}

fn with_db<T>(app: &AppHandle, work: impl FnOnce(&Connection, &Path) -> T) -> Option<T> {
    let state = app.try_state::<AppState>()?;
    let home = state.home.clone();
    let conn = state.conn.lock().unwrap_or_else(|poison| poison.into_inner());
    Some(work(&conn, &home))
}

pub fn page_request(app: &AppHandle, op: &str, text: &str) -> String {
    if op != "context" {
        return "Embedded pages cannot run Ronic OS tools. Use the Ronic OS chat or the signed MCP bridge.".into();
    }
    let Some(answer) = with_db(app, |conn, home| context_block(conn, home, text)) else {
        return "Workspace bridge is still starting.".into();
    };
    answer
}

pub(crate) fn run_chat_tool(conn: &Connection, name: &str, args: &Value) -> Result<String, String> {
    let home = crate::util::product_home();
    // No attachment context: absolute paths are not allowlisted. This entry
    // point is only reached by callers that have no user-picked files (MCP
    // bridge, code mode) — the strict gate applies.
    call_tool_with_attachments(conn, &home, name, args, &[])
}

/// Chat-turn entry point carrying this turn's user-picked attachment paths.
/// Absolute `read_file` / `list_files` targets are allowed only when they
/// canonical-match one of these paths (or sit inside an attached folder).
pub(crate) fn run_chat_tool_with_attachments(conn: &Connection, name: &str, args: &Value, attachments: &[String]) -> Result<String, String> {
    let home = crate::util::product_home();
    call_tool_with_attachments(conn, &home, name, args, attachments)
}

pub(crate) fn is_local_tool(name: &str) -> bool {
    allowed(name) && name != "ronic_execute_codemode" && !crate::dock_mcp::is_dock_tool(name)
}

pub(crate) fn call_tool(conn: &Connection, home: &Path, name: &str, args: &Value) -> Result<String, String> {
    // No attachment context (MCP bridge, code mode worker): the strict
    // absolute-path gate applies — only the sensitive-path denylist protects
    // these callers, and there are no user-picked files to allow.
    call_tool_with_attachments(conn, home, name, args, &[])
}

pub(crate) fn call_tool_with_attachments(conn: &Connection, home: &Path, name: &str, args: &Value, attachments: &[String]) -> Result<String, String> {
    let name = name.trim();
    if crate::dock_mcp::is_dock_tool(name) {
        return Err("workspace_webapp and desktop_app run on the desktop session, outside the database lock. Call them from MCP tools/call or Code Mode ronic.apps.".into());
    }
    if !allowed(name) {
        return Err("That tool is not on the Ronic OS bridge. Use list_skills, load_skill, load_skill_file, list_plugins, list_memory, search_memory, save_memory, curate_memory, update_memory_graph, list_files, read_file, list_mcp, list_providers, list_threads, skill_manage, workspace_manifest, ronic_search_capabilities, ronic_execute_codemode, or ronic_ask_peer_app.".into());
    }
    let profile = active_profile(conn);
    match name {
        "workspace_manifest" => Ok(context_block(conn, home, arg(args, "text"))),
        "list_skills" => Ok(list_skills(conn, home, &profile)),
        "load_skill" => load_skill(conn, home, &profile, arg(args, "slug")),
        "load_skill_file" => load_skill_file(conn, home, &profile, arg(args, "slug"), arg(args, "path")),
        "list_plugins" => Ok(list_plugins(conn, home, &profile)),
        "list_memory" => Ok(list_memory(conn)),
        "search_memory" => Ok(search_memory(conn, arg(args, "query"))),
        "save_memory" => save_memory(conn, &profile, arg(args, "title"), first_arg(args, &["content", "contentMarkdown"]), arg(args, "id")),
        "curate_memory" => curate_memory(conn, &profile, args),
        "update_memory_graph" => update_memory_graph(conn, &profile, args),
        "list_providers" => Ok(list_providers(conn)),
        "list_threads" => Ok(list_threads(conn, &profile)),
        "list_files" => list_files(conn, arg(args, "path"), attachments),
        // read_file: a project-relative path stays confined to the project
        // folder; an absolute path is read directly ONLY when it matches a
        // file/folder the user attached this turn (model-built absolute paths
        // are untrusted), with the same secret-name and redact safeguards as
        // an attachment.
        "read_file" => {
            let target = first_arg(args, &["path", "file"]);
            if is_absolute_path(target) {
                if let Some(inside) = rel_inside_project(conn, target) {
                    if inside.is_empty() {
                        Err("That path is the project folder. Use list_files with an empty path to see what is inside.".into())
                    } else {
                        read_project_file(conn, &inside)
                    }
                } else {
                    read_absolute_file(target, attachments)
                }
            } else {
                read_project_file(conn, target)
            }
        }
        "list_mcp" => Ok(list_mcp_text(conn, home, &profile)),
        "skill_manage" => skill_manage(conn, home, &profile, arg(args, "slug"), arg(args, "description"), first_arg(args, &["body", "content"])),
        "install_skill" => {
            let source = first_arg(args, &["source", "url", "link", "slug"]);
            let slug = arg(args, "slug");
            let slug_opt = if slug.is_empty() { None } else { Some(slug) };
            crate::capabilities::install_skill_from_source(conn, home, &profile, source, slug_opt).map_err(|e| e.0)
        }
        "install_plugin" => {
            let source = first_arg(args, &["source", "url", "repo"]);
            let slug = arg(args, "slug");
            let slug_opt = if slug.is_empty() { None } else { Some(slug) };
            crate::capabilities::install_plugin_from_source(conn, home, &profile, source, slug_opt).map_err(|e| e.0)
        }
        "connect_mcp" => {
            let secret = first_arg(args, &["secret", "apiKey", "api_key", "token"]);
            if !secret.is_empty() {
                return Err("The public bridge does not store MCP keys. Connect the server from the desktop app.".into());
            }
            let name = first_arg(args, &["name", "server"]);
            let transport = arg(args, "transport");
            let trans_opt = if transport.is_empty() { None } else { Some(transport) };
            let command = first_arg(args, &["command", "cmd"]);
            let cmd_opt = if command.is_empty() { None } else { Some(command) };
            let url = first_arg(args, &["url", "endpoint"]);
            let url_opt = if url.is_empty() { None } else { Some(url) };
            let args_list: Vec<String> = if let Some(arr) = args.get("args").and_then(|v| v.as_array()) {
                arr.iter().filter_map(|s| s.as_str().map(str::to_string)).collect()
            } else if let Some(s) = args.get("args").and_then(|v| v.as_str()) {
                crate::util::split_args(s)
            } else {
                Vec::new()
            };
            crate::capabilities::connect_mcp_server(conn, home, &profile, name, trans_opt, cmd_opt, &args_list, url_opt, None).map(|done| done.note).map_err(|e| e.0)
        }
        "ronic_search_capabilities" => Ok(crate::code_mode::search_capabilities(conn, home, first_arg(args, &["query", "query_js"])).to_string()),
        "ronic_ask_peer_app" => {
            let value = crate::mcp_acp_automesh::ask_peer(conn, home, "mcp", first_arg(args, &["target", "target_app_id"]), first_arg(args, &["task", "task_prompt", "prompt"]))?;
            Ok(value.to_string())
        }
        "ronic_execute_codemode" => Err("Code Mode runs outside the database lock. Call execute_code_mode_script.".into()),
        _ => Err("That tool is not on the Ronic OS bridge.".into()),
    }
}

fn allowed(name: &str) -> bool {
    matches!(
        name,
        "workspace_manifest"
            | "list_skills"
            | "load_skill"
            | "load_skill_file"
            | "list_plugins"
            | "list_memory"
            | "search_memory"
            | "save_memory"
            | "curate_memory"
            | "update_memory_graph"
            | "list_providers"
            | "list_threads"
            | "list_files"
            | "read_file"
            | "list_mcp"
            | "skill_manage"
            | "install_skill"
            | "install_plugin"
            | "connect_mcp"
            | "workspace_webapp"
            | "desktop_app"
            | "ronic_search_capabilities"
            | "ronic_ask_peer_app"
            | "ronic_execute_codemode"
    )
}

fn context_block(conn: &Connection, home: &Path, user_text: &str) -> String {
    let user_text = user_text.trim();
    if user_text.starts_with("[Ronic tool result]") {
        return String::new();
    }
    let profile = active_profile(conn);
    let label = profile_label(conn, &profile);
    let view = match capabilities::view(conn, home, &profile) {
        Ok(view) => view,
        Err(error) => {
            return format!("[Ronic OS connection]\nThis chat is connected to Ronic OS on this computer. The skill index could not be read: {error}");
        }
    };
    let skills: Vec<_> = view.skills.iter().filter(|skill| in_index(skill, &profile, capabilities::plugin_agent_on(&view.plugins, &skill.plugin_id, &profile))).collect();
    let project = db::settings_of(conn).map(|settings| settings.project_root).unwrap_or_default();
    let mut lines = vec![
        "[Ronic OS connection]".into(),
        "This chat is running inside Ronic OS on the user's computer. You are connected to the local workspace and can use its skills, plugins, and memory. The lists below are live. Do not say you cannot access the workspace, its skills, its plugins, or its memory.".into(),
        format_injection_brief(&project, home),
        format!("Profile: {label}"),
        format!("Counts: {} skills, {} plugins, {} memories.", skills.len(), view.plugins.len(), memory_count(conn)),
        "Skill index:".into(),
    ];
    if skills.is_empty() {
        lines.push("none".into());
    } else {
        for skill in skills.iter().take(40) {
            lines.push(skill.index_line.clone());
        }
    }
    lines.push("Plugins:".into());
    if view.plugins.is_empty() {
        lines.push("none".into());
    } else {
        for plugin in view.plugins.iter().take(30) {
            let tools = plugin.tools.iter().map(|tool| tool.name.as_str()).collect::<Vec<_>>().join(", ");
            let agent = plugin.agent_enables.iter().any(|flag| flag.profile_id == profile && flag.enabled);
            lines.push(format!("- {} {} ({}, agent {}){}", plugin.name, plugin.version, plugin.trust, if agent { "on" } else { "off" }, if tools.is_empty() { String::new() } else { format!(" tools: {tools}") }));
        }
    }
    lines.push("Memory:".into());
    let memory_query: String = user_text.chars().take(80).collect();
    lines.push(if memory_query.is_empty() { latest_memory(conn) } else { search_memory(conn, &memory_query) });
    lines.push("Tasks:".into());
    lines.push(list_threads(conn, &profile));
    lines.push("MCP servers:".into());
    lines.push(list_mcp_text(conn, home, &profile));
    lines.push("Project files stay inside the project folder. Use list_files and read_file. Shell, wallet, and API keys are not on this connection. A website cannot open the local MCP port. This attached block is the connection. Local CLIs use the Ronic OS MCP server.".into());
    lines.push("This attached block is the connection. A website cannot run Ronic OS tools from the page, and it cannot open the local MCP port. Use the Ronic OS chat or the signed local MCP server for tools. Tools on that server: load_skill (slug), load_skill_file (slug, path), list_skills, list_plugins, list_memory, search_memory (query), save_memory (title, content, id?), curate_memory (target, action, content?, oldText?), update_memory_graph (title, target, relation?, remove?), list_files (path), read_file (path), list_mcp, skill_manage (slug, description, body), list_providers, list_threads, workspace_manifest, ronic_search_capabilities (query), ronic_ask_peer_app (target, task). save_memory updates a note with the same title instead of adding a copy and rewrites its structured markdown sheet. Do not edit that file. curate_memory writes a short always-on fact and refuses a write over its cap. update_memory_graph changes one link and does not rewrite the note. skill_manage waits for approval and does not write the file. ronic_ask_peer_app stores a ticket and does not launch the other app.".into());
    if let Some(body) = crate::capabilities::playbook(user_text, &skills, &view.plugins, &profile) {
        lines.push(format!("Skill playbook for this turn. Follow it:\n{}", clip(&body, 2500)));
    }
    if let Some(note) = crate::capabilities::mcp_turn(user_text, &view.mcp_servers, &profile) {
        lines.push(note);
    }
    clip(&lines.join("\n"), PACK_LIMIT)
}

fn list_skills(conn: &Connection, home: &Path, profile: &str) -> String {
    let Ok(view) = capabilities::view(conn, home, profile) else {
        return "The skill index could not be read.".into();
    };
    let lines: Vec<_> = view
        .skills
        .iter()
        .filter(|skill| in_index(skill, profile, capabilities::plugin_agent_on(&view.plugins, &skill.plugin_id, profile)))
        .take(80)
        .map(|skill| skill.index_line.clone())
        .collect();
    if lines.is_empty() { "No skills are in this profile's index.".into() } else { lines.join("\n") }
}

fn load_skill(conn: &Connection, home: &Path, profile: &str, slug: &str) -> Result<String, String> {
    if slug.is_empty() {
        return Err("load_skill needs a slug.".into());
    }
    capabilities::load_skill_text(conn, home, profile, slug).map(|body| clip(&body, 12000)).map_err(|error| error.0)
}

fn load_skill_file(conn: &Connection, home: &Path, profile: &str, slug: &str, path: &str) -> Result<String, String> {
    if slug.is_empty() || path.is_empty() {
        return Err("load_skill_file needs a slug and a path.".into());
    }
    let view = capabilities::view(conn, home, profile).map_err(|error| error.0)?;
    let token = if slug.starts_with('/') { slug.to_string() } else { format!("/{slug}") };
    let skill = view.skills.iter().find(|skill| {
        in_index(skill, profile, capabilities::plugin_agent_on(&view.plugins, &skill.plugin_id, profile))
            && (skill.slash_command == token || skill.slug == slug.trim_start_matches('/'))
    });
    let Some(skill) = skill else { return Err("That skill is not in this profile's index.".into()) };
    let wanted = path.replace('\\', "/");
    skill.files.iter().find(|file| file.path.replace('\\', "/") == wanted).map(|file| clip(&file.content, 12000)).ok_or_else(|| "That supporting file is not on the skill.".into())
}

fn list_plugins(conn: &Connection, home: &Path, profile: &str) -> String {
    let Ok(view) = capabilities::view(conn, home, profile) else {
        return "The plugin list could not be read.".into();
    };
    if view.plugins.is_empty() {
        return "No plugins are installed.".into();
    }
    view.plugins
        .iter()
        .take(40)
        .map(|plugin| {
            let tools = plugin.tools.iter().map(|tool| tool.name.as_str()).collect::<Vec<_>>().join(", ");
            let skills = plugin.bundled_skills.join(", ");
            format!("- {} {} ({}) skills: {skills} tools: {tools}", plugin.name, plugin.version, plugin.trust)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn list_memory(conn: &Connection) -> String {
    let rows = memory_rows(conn, "SELECT id, title, content_markdown, COALESCE(scoped_bot_id, '') FROM memory_items ORDER BY updated_at DESC LIMIT 30", params![]);
    if rows.is_empty() { "No memories saved yet.".into() } else { memory_cards(rows) }
}

fn search_memory(conn: &Connection, query: &str) -> String {
    let query = query.trim();
    if query.is_empty() {
        return latest_memory(conn);
    }
    let like = format!("%{}%", query.to_lowercase().replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
    let rows = memory_rows(conn, "SELECT id, title, content_markdown, COALESCE(scoped_bot_id, '') FROM memory_items WHERE lower(title) LIKE ?1 ESCAPE '\\' OR lower(content_markdown) LIKE ?1 ESCAPE '\\' ORDER BY updated_at DESC LIMIT 12", params![like]);
    if rows.is_empty() { latest_memory(conn) } else { memory_cards(rows) }
}

fn latest_memory(conn: &Connection) -> String {
    let rows = memory_rows(conn, "SELECT id, title, content_markdown, COALESCE(scoped_bot_id, '') FROM memory_items ORDER BY updated_at DESC LIMIT 4", params![]);
    if rows.is_empty() { "None saved.".into() } else { memory_cards(rows) }
}

fn memory_cards(rows: Vec<(String, String, String, String)>) -> String {
    rows.into_iter().map(|(id, title, body, scope)| memory::card(&id, &title, &scope, &clip(&redact(&body), 180))).collect::<Vec<_>>().join("\n\n")
}

fn memory_rows(conn: &Connection, sql: &str, args: impl rusqlite::Params) -> Vec<(String, String, String, String)> {
    let Ok(mut stmt) = conn.prepare(sql) else { return Vec::new() };
    stmt.query_map(args, |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))).map(|rows| rows.flatten().collect()).unwrap_or_default()
}

fn memory_count(conn: &Connection) -> i64 {
    conn.query_row("SELECT COUNT(*) FROM memory_items", [], |row| row.get(0)).unwrap_or(0)
}

fn save_memory(conn: &Connection, profile: &str, title: &str, content: &str, id: &str) -> Result<String, String> {
    let title = title.trim();
    let content = content.trim();
    if title.is_empty() || content.is_empty() {
        return Err("save_memory needs a title and content.".into());
    }
    if title.chars().count() > 200 || content.chars().count() > 8000 {
        return Err("That memory is too long.".into());
    }
    note_rate_limit()?;
    let id = id.trim();
    let saved = memory::remember(conn, &MemoryInput {
        id: if id.is_empty() { None } else { Some(id.to_string()) },
        title: title.into(),
        content_markdown: content.into(),
        source_type: "harness".into(),
        scoped_bot_id: if profile.is_empty() { None } else { Some(profile.to_string()) },
        file_path_or_uri: String::new(),
        engine_id: None,
        keep_identity: true,
    }).map_err(|error| error.0)?;
    Ok(format!("{}. It is on the Memory screen.", saved.note))
}

fn note_rate_limit() -> Result<(), String> {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|time| time.as_secs()).unwrap_or(0);
    let mut shared = SHARED.lock().unwrap_or_else(|poison| poison.into_inner());
    if now.saturating_sub(shared.saves.0) > 60 {
        shared.saves = (now, 0);
    }
    if shared.saves.1 >= 30 {
        return Err("Too many memories were saved in the last minute.".into());
    }
    shared.saves.1 += 1;
    Ok(())
}

fn curate_memory(conn: &Connection, profile: &str, args: &Value) -> Result<String, String> {
    note_rate_limit()?;
    let bot = if profile.is_empty() { None } else { Some(profile) };
    memory::curate(
        conn,
        first_arg(args, &["target", "store"]),
        first_arg(args, &["action", "op"]),
        first_arg(args, &["oldText", "old_text"]),
        first_arg(args, &["content", "fact"]),
        bot,
    )
    .map_err(|error| error.0)
}

fn update_memory_graph(conn: &Connection, profile: &str, args: &Value) -> Result<String, String> {
    let key = {
        let id = arg(args, "id");
        if id.is_empty() { first_arg(args, &["title", "memory"]) } else { id }
    };
    let remove = match args.get("remove") {
        Some(Value::Bool(value)) => *value,
        Some(Value::String(value)) => matches!(value.trim(), "true" | "1" | "yes"),
        _ => false,
    };
    let caller = if profile.is_empty() { None } else { Some(profile) };
    memory::link_graph(conn, key, first_arg(args, &["target", "to"]), arg(args, "relation"), remove, caller).map_err(|error| error.0)
}

fn blocked_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower == ".git"
        || lower == ".env"
        || lower.starts_with(".env.")
        || lower == "secrets.json"
        || lower == "secrets.vault"
        || lower == "node_modules"
        || lower == "id_rsa"
        || lower == "id_ed25519"
        || lower.ends_with(".pem")
        || lower.ends_with(".key")
}

fn project_dir(conn: &Connection) -> Result<PathBuf, String> {
    let settings = db::settings_of(conn).map_err(|error| error.0)?;
    let root = settings.project_root.trim();
    if root.is_empty() {
        return Err("No project folder is set.".into());
    }
    let path = PathBuf::from(root);
    if !path.is_dir() {
        return Err("The project folder is not on this computer.".into());
    }
    path.canonicalize().map_err(|_| "The project folder is not on this computer.".into())
}

fn clean_rel_path(rel: &str) -> String {
    let mut cleaned = rel.trim().replace('\\', "/");
    while cleaned.starts_with("./") {
        cleaned = cleaned[2..].trim().to_string();
    }
    while cleaned.starts_with('/') {
        cleaned = cleaned[1..].trim().to_string();
    }
    while cleaned.ends_with('/') {
        cleaned.pop();
    }
    cleaned
}

fn project_file(conn: &Connection, rel: &str) -> Result<PathBuf, String> {
    let root = project_dir(conn)?;
    let clean = clean_rel_path(rel);
    if clean.is_empty() || clean == "." {
        return Ok(root);
    }
    if clean.contains("..") {
        return Err("That path stays inside the project folder.".into());
    }
    let mut full = root.clone();
    for part in clean.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." || blocked_name(part) {
            return Err(format!("Access to '{part}' is not allowed on this connection."));
        }
        full.push(part);
    }
    let canon = full.canonicalize().map_err(|_| format!("Path '{clean}' does not exist inside the project."))?;
    if !canon.starts_with(&root) {
        return Err("That path stays inside the project folder.".into());
    }
    Ok(canon)
}

/// True when the tool argument is an absolute filesystem path (Windows drive
/// `C:\...` / `C:/...` or a `\\server\share` UNC). Absolute paths the *model*
/// builds are untrusted — they are only read when they canonical-match a file
/// the user attached this turn (`attachments_allow`).
fn is_absolute_path(raw: &str) -> bool {
    let raw = raw.trim();
    // Reject Windows device namespaces outright — `\\.\PhysicalDrive0`,
    // `\\?\C:\...`, named pipes never reach the read path.
    if raw.starts_with("\\\\.\\") || raw.starts_with("\\\\?\\") {
        return false;
    }
    // Reject alternate data streams (`file.txt:stream`): a colon anywhere after
    // the drive-letter position (index 1) is not a valid plain file path.
    if raw.len() > 2 && raw[2..].contains(':') {
        return false;
    }
    if raw.len() >= 3 {
        let bytes = raw.as_bytes();
        if bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && (bytes[2] == b'\\' || bytes[2] == b'/') {
            return true;
        }
    }
    // UNC must be a well-formed `\\server\share` (at least two non-empty parts).
    if let Some(rest) = raw.strip_prefix("\\\\") {
        return rest.split(&['\\', '/'][..]).filter(|s| !s.is_empty()).count() >= 2;
    }
    false
}

/// Allowlist gate for model-built absolute paths: a canonicalized target is
/// reachable only when it equals a user-attached path, or sits inside an
/// attached folder. Matching is done on canonical paths so `..`, symlinks,
/// and 8.3 short names cannot bypass the check. An empty attachment list
/// means no absolute path is reachable (MCP bridge / code mode / turns
/// without attachments).
/// Product memory sheets are a render beside the database. A bot may open that
/// folder without an attachment. The folder must be a real directory: a symlink
/// root would follow out of the product home. Secret-name and sensitive-path
/// checks still run before this.
fn in_memory_sheets(canon: &Path) -> bool {
    under_memory_root(canon, &crate::util::product_home().join("memories"))
}

fn under_memory_root(canon: &Path, root: &Path) -> bool {
    let Ok(meta) = root.symlink_metadata() else { return false };
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return false;
    }
    let Ok(root) = root.canonicalize() else { return false };
    canon.starts_with(&root)
}

fn attachments_allow(canon: &Path, attachments: &[String]) -> bool {
    if attachments.is_empty() {
        return false;
    }
    attachments.iter().any(|raw| {
        let picked = PathBuf::from(raw.trim());
        let picked_canon = picked.canonicalize().unwrap_or(picked);
        canon == picked_canon || canon.starts_with(&picked_canon)
    })
}

/// Absolute path that canonicalizes inside the project root, as a
/// project-relative path. Empty means the project folder itself.
fn rel_inside_root(root: &Path, raw: &str) -> Option<String> {
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let canon = PathBuf::from(raw.trim()).canonicalize().ok()?;
    if !canon.starts_with(&root) {
        return None;
    }
    if canon.components().any(|part| blocked_name(&part.as_os_str().to_string_lossy())) {
        return None;
    }
    let rel = canon.strip_prefix(&root).ok()?;
    Some(rel.to_string_lossy().replace('\\', "/"))
}

fn rel_inside_project(conn: &Connection, raw: &str) -> Option<String> {
    rel_inside_root(&project_dir(conn).ok()?, raw)
}

fn list_files(conn: &Connection, rel: &str, attachments: &[String]) -> Result<String, String> {
    // An absolute path inside the project folder is the same read as a
    // relative one. Anything else is listed only when the user attached it.
    if is_absolute_path(rel) {
        if let Some(inside) = rel_inside_project(conn, rel) {
            return list_files(conn, &inside, attachments);
        }
        let dir = PathBuf::from(rel.trim());
        return list_absolute_dir(&dir, rel.trim(), attachments);
    }
    let clean = clean_rel_path(rel);
    let dir = if clean.is_empty() || clean == "." {
        project_dir(conn)?
    } else {
        project_file(conn, &clean)?
    };
    if !dir.is_dir() {
        return Err(format!("'{clean}' is a file, not a folder. Use read_file to inspect its contents."));
    }
    let mut names = Vec::new();
    let entries = fs::read_dir(&dir).map_err(|e| format!("Folder '{clean}' could not be read: {e}"))?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if blocked_name(&name) {
            continue;
        }
        let kind = if entry.path().is_dir() { "dir" } else { "file" };
        names.push(format!("{kind}\t{name}"));
        if names.len() >= 80 {
            break;
        }
    }
    names.sort();
    if names.is_empty() { Ok("That folder has no listed files.".into()) } else { Ok(names.join("\n")) }
}

/// List an absolute folder path (outside the project root), skipping
/// secret-named entries, with the same 80-row cap as project listings.
/// Reachable only when the folder was user-attached this turn.
fn list_absolute_dir(dir: &Path, display: &str, attachments: &[String]) -> Result<String, String> {
    // Resolve before the guard so symlinks and `..` are normalized, then apply
    // the same sensitive-path denylist as reads — directory listing must not
    // leak the structure of credential/config folders to the model either.
    let canon = dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf());
    if sensitive_path(&canon) {
        return Err("That folder is not available on this connection.".into());
    }
    if !in_memory_sheets(&canon) && !attachments_allow(&canon, attachments) {
        return Err("That folder is outside the project folder and was not attached in this chat. list_files with an empty path reads the project folder from Context injection. The bot terminal cannot open it.".into());
    }
    if !dir.is_dir() {
        return Err(format!("'{display}' is not a folder on this computer."));
    }
    let mut names = Vec::new();
    let entries = fs::read_dir(dir).map_err(|e| format!("Folder '{display}' could not be read: {e}"))?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if blocked_name(&name) {
            continue;
        }
        let kind = if entry.path().is_dir() { "dir" } else { "file" };
        names.push(format!("{kind}\t{name}"));
        if names.len() >= 80 {
            break;
        }
    }
    names.sort();
    if names.is_empty() { Ok("That folder has no listed files.".into()) } else { Ok(names.join("\n")) }
}

/// Directories and path segments that hold credentials, keys, or system
/// secrets. The model builds the `read_file` path itself, so an absolute path
/// is NOT trusted the way a user-picked attachment is — this denylist blocks
/// the sensitive locations a prompt-injected model would target, on top of the
/// filename blocklist. Checked against the canonicalized path so symlinks and
/// `..` segments are already resolved.
fn sensitive_path(path: &Path) -> bool {
    let lower = path.to_string_lossy().to_ascii_lowercase().replace('/', "\\");
    const DENY: &[&str] = &[
        "\\.aws\\", "\\.ssh\\", "\\.gnupg\\", "\\.azure\\", "\\.kube\\", "\\.docker\\config.json",
        "\\.config\\gcloud\\", "\\.config\\hub", "\\.git-credentials", "\\.netrc", "\\.npmrc",
        "\\.pypirc", "\\.gem\\credentials", "\\.cargo\\credentials", "\\.m2\\settings.xml",
        "\\appdata\\roaming\\microsoft\\credentials", "\\appdata\\local\\microsoft\\credentials",
        "\\appdata\\roaming\\microsoft\\protect", "\\appdata\\roaming\\microsoft\\crypto",
        "\\windows\\system32\\config\\", "\\windows\\system32\\drivers\\etc\\",
        "\\ntds.dit", "\\sam", "\\security\\", "\\.ethereum\\", "\\.bitcoin\\", "\\wallet",
        "\\keystore\\", "\\id_dsa", "\\id_ecdsa", "\\cookies", "\\login data", "\\web data",
    ];
    DENY.iter().any(|d| lower.contains(d))
}

/// Read an absolute file path (outside the project root) with the same
/// safeguards as an attachment: secret-name blocklist, redact, size cap,
/// binary detection, and OneDrive-placeholder hydration — plus a sensitive-path
/// denylist and a per-turn attachment allowlist, because the model constructs
/// this path itself (untrusted).
fn read_absolute_file(raw: &str, attachments: &[String]) -> Result<String, String> {
    let path = PathBuf::from(raw.trim());
    let canon = match path.canonicalize() {
        Ok(p) => p,
        Err(_) if path.is_file() => {
            // Reject unresolved traversal on the fallback branch: a legitimately
            // user-picked path never contains `..` segments.
            if path.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
                return Err("That file is not available on this connection.".into());
            }
            path.clone()
        }
        Err(_) => return Err(format!("the file was not found at '{raw}'. If it lives in OneDrive, make sure it is synced to this device (right-click → 'Always keep on this device').")),
    };
    if canon.components().any(|part| blocked_name(&part.as_os_str().to_string_lossy())) || sensitive_path(&canon) {
        return Err("That file is not available on this connection.".into());
    }
    if !in_memory_sheets(&canon) && !attachments_allow(&canon, attachments) {
        return Err("That file is outside the project folder and was not attached in this chat. Use a project-relative path, or list_files with an empty path. The bot terminal cannot open the project folder.".into());
    }
    if canon.is_dir() {
        return list_absolute_dir(&canon, raw.trim(), attachments);
    }
    let file_name = canon.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| raw.trim().to_string());
    let meta = fs::metadata(&canon).map_err(|e| format!("File '{file_name}' could not be read: {e}"))?;
    if meta.len() > 200_000 {
        return Err(format!("File '{file_name}' is too large for this chat ({} bytes, max 200KB).", meta.len()));
    }
    let bytes = read_hydrated(&canon).map_err(|e| format!("File '{file_name}' could not be read: {e}"))?;
    if bytes.contains(&0) {
        return Err(format!("File '{file_name}' is a binary file, not text."));
    }
    let text = String::from_utf8_lossy(&bytes);
    Ok(clip(&redact(&text), 8000))
}

fn read_project_file(conn: &Connection, rel: &str) -> Result<String, String> {
    let clean = clean_rel_path(rel);
    if clean.is_empty() {
        return Err("read_file needs a relative path inside the project folder (e.g. src/index.ts).".into());
    }
    let path = project_file(conn, &clean)?;
    if path.is_dir() {
        return Err(format!("'{clean}' is a folder, not a file. Use list_files to see what is inside."));
    }
    let meta = fs::metadata(&path).map_err(|e| format!("File '{clean}' could not be read: {e}"))?;
    if meta.len() > 200_000 {
        return Err(format!("File '{clean}' is too large for this chat ({} bytes, max 200KB).", meta.len()));
    }
    let bytes = fs::read(&path).map_err(|e| format!("File '{clean}' could not be read: {e}"))?;
    if bytes.contains(&0) {
        return Err(format!("File '{clean}' is a binary file, not text."));
    }
    let text = String::from_utf8_lossy(&bytes);
    Ok(clip(&redact(&text), 8000))
}

/// Image file extensions that can be sent as base64 data URLs for vision models.
const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico"];

/// Maximum image size to include as base64 (512KB).
const MAX_IMAGE_BYTES: u64 = 512_000;

/// Maximum text file size to include inline (200KB).
const MAX_TEXT_BYTES: u64 = 200_000;

/// Maximum total output for a single attachment.
const MAX_OUTPUT_CHARS: usize = 12_000;

fn is_image_path(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| IMAGE_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn mime_for_image(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        Some("svg") => "image/svg+xml",
        Some("ico") => "image/x-icon",
        _ => "application/octet-stream",
    }
}

/// Read a file's bytes, forcing a hydrate first when it is a OneDrive /
/// cloud-files placeholder. A placeholder shows up in the picker (`.exists()`
/// is true) but `fs::read` fails until Windows downloads it, which is the
/// "unable to access the attached file" bug users hit on Desktop. Touching the
/// file metadata triggers a recall on most providers; we then retry the read.
fn read_hydrated(path: &Path) -> std::io::Result<Vec<u8>> {
    match fs::read(path) {
        Ok(bytes) => Ok(bytes),
        Err(first) => {
            // Nudge the cloud provider to hydrate, then retry once. A short
            // settle gives a fast local provider time to materialize the file.
            let _ = fs::metadata(path);
            let _ = std::fs::File::open(path);
            std::thread::sleep(Duration::from_millis(250));
            fs::read(path).map_err(|_| first)
        }
    }
}

/// Minimal base64 encoder (no external crate needed for this size).
fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        if chunk.len() > 1 {
            out.push(ALPHABET[(n >> 6) as usize & 63] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(ALPHABET[n as usize & 63] as char);
        } else {
            out.push('=');
        }
    }
    out
}

pub(crate) fn read_attachment(conn: &Connection, raw: &str) -> Result<String, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("No file was attached.".into());
    }
    let path = PathBuf::from(raw);
    // An absolute path the user picked in the file dialog is trusted: read it
    // directly. project_file() confines to the project root, which is correct
    // for paths the *model* builds but wrong for a user-picked Desktop file —
    // that is the attachment-access bug this fixes.
    let canon = if path.is_absolute() {
        match path.canonicalize() {
            Ok(p) => p,
            Err(_) if path.is_file() => path.clone(),
            Err(_) => return Err(format!("the file was not found at '{raw}'. If it lives in OneDrive, make sure it is synced to this device (right-click → 'Always keep on this device'), then attach it again.")),
        }
    } else {
        // Try project-relative first, then treat as absolute
        match project_file(conn, raw) {
            Ok(p) => p,
            Err(_) => path.canonicalize().map_err(|_| format!("the file was not found at '{raw}'"))?,
        }
    };
    if canon.components().any(|part| blocked_name(&part.as_os_str().to_string_lossy())) {
        return Err("That file is not available on this connection.".into());
    }

    // ── FOLDER: recursively list contents ──
    if canon.is_dir() {
        return read_folder_attachment(&canon, raw);
    }

    let meta = fs::metadata(&canon).map_err(|e| format!("Could not read file metadata: {e}"))?;
    let file_name = canon.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| raw.to_string());

    // ── IMAGE: encode as base64 data URL for vision models ──
    if is_image_path(&canon) {
        if meta.len() > MAX_IMAGE_BYTES {
            return Err(format!("Image '{file_name}' is too large ({}KB, max {}KB).", meta.len() / 1024, MAX_IMAGE_BYTES / 1024));
        }
        let bytes = read_hydrated(&canon).map_err(|e| format!("could not read image '{file_name}': {e}"))?;
        let b64 = base64_encode(&bytes);
        let mime = mime_for_image(&canon);
        return Ok(format!("[Image: {file_name}]\ndata:{mime};base64,{b64}"));
    }

    // ── TEXT FILE: read and include content ──
    if meta.len() > MAX_TEXT_BYTES {
        return Err(format!("File '{file_name}' is too large ({}KB, max {}KB).", meta.len() / 1024, MAX_TEXT_BYTES / 1024));
    }
    let bytes = read_hydrated(&canon).map_err(|e| format!("could not read '{file_name}': {e}"))?;
    if bytes.contains(&0) {
        // Binary file that's not an image — provide metadata
        return Ok(format!(
            "[Binary file: {file_name}] ({} bytes, type: {}). Content not displayed inline.",
            meta.len(),
            canon.extension().and_then(|e| e.to_str()).unwrap_or("unknown")
        ));
    }
    let text = String::from_utf8_lossy(&bytes);
    Ok(clip(&redact(&text), MAX_OUTPUT_CHARS))
}

/// Recursively list a folder's contents as an attachment.
fn read_folder_attachment(dir: &Path, display_path: &str) -> Result<String, String> {
    let mut output = format!("[Folder: {display_path}]\n");
    let mut file_count = 0u32;
    let mut dir_count = 0u32;
    let max_entries = 100;

    fn walk(dir: &Path, prefix: &str, output: &mut String, file_count: &mut u32, dir_count: &mut u32, max: usize) {
        let entries = match fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };
        let mut items: Vec<_> = entries.flatten().collect();
        items.sort_by_key(|e| e.file_name());
        for entry in items {
            if output.len() > MAX_OUTPUT_CHARS {
                output.push_str("... (truncated)\n");
                return;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if blocked_name(&name) {
                continue;
            }
            let path = entry.path();
            if path.is_dir() {
                *dir_count += 1;
                output.push_str(&format!("{prefix}[dir] {name}/\n"));
                if *dir_count + *file_count < max as u32 {
                    walk(&path, &format!("{prefix}  "), output, file_count, dir_count, max);
                }
            } else {
                *file_count += 1;
                let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                let size_str = if size > 1024 * 1024 {
                    format!("{:.1}MB", size as f64 / 1_048_576.0)
                } else if size > 1024 {
                    format!("{:.1}KB", size as f64 / 1024.0)
                } else {
                    format!("{size}B")
                };
                output.push_str(&format!("{prefix}{name} ({size_str})\n"));
            }
        }
    }

    walk(dir, "", &mut output, &mut file_count, &mut dir_count, max_entries);
    output.push_str(&format!("\nTotal: {file_count} files, {dir_count} folders"));
    Ok(clip(&output, MAX_OUTPUT_CHARS))
}

fn list_mcp_text(conn: &Connection, home: &Path, profile: &str) -> String {
    let Ok(view) = capabilities::view(conn, home, profile) else {
        return "MCP servers could not be read.".into();
    };
    if view.mcp_servers.is_empty() {
        return "No extra MCP servers are configured. Local CLIs use the Ronic OS MCP server. This website uses the attached workspace connection.".into();
    }
    view.mcp_servers
        .iter()
        .take(20)
        .map(|server| {
            let on = server.enables.iter().any(|flag| flag.profile_id == profile && flag.enabled);
            let tools = server.declared_tools.iter().map(|tool| tool.name.as_str()).collect::<Vec<_>>().join(", ");
            format!("- {} {} ({}, {}){}", server.name, server.transport, server.trust, if on { "on" } else { "off" }, if tools.is_empty() { String::new() } else { format!(" tools: {tools}") })
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn list_providers(conn: &Connection) -> String {
    let Ok(mut stmt) = conn.prepare("SELECT name, health_detail FROM provider_accounts ORDER BY created_at LIMIT 20") else {
        return "No providers are configured.".into();
    };
    let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))).ok();
    let Some(rows) = rows else { return "No providers are configured.".into() };
    let lines: Vec<_> = rows.flatten().map(|(name, detail)| format!("- {name}: {}", clip(&redact(&detail), 160))).collect();
    if lines.is_empty() { "No providers are configured.".into() } else { lines.join("\n") }
}

fn list_threads(conn: &Connection, profile: &str) -> String {
    let Ok(mut stmt) = conn.prepare("SELECT title FROM chat_threads WHERE bot_profile_id = ?1 ORDER BY updated_at DESC LIMIT 15") else {
        return "No tasks yet.".into();
    };
    let rows = stmt.query_map(params![profile], |row| row.get::<_, String>(0)).ok();
    let Some(rows) = rows else { return "No tasks yet.".into() };
    let lines: Vec<_> = rows.flatten().collect();
    if lines.is_empty() { "No tasks yet.".into() } else { lines.join("\n") }
}

fn skill_manage(conn: &Connection, _home: &Path, profile: &str, slug: &str, description: &str, body: &str) -> Result<String, String> {
    if profile.is_empty() {
        return Err("Create a bot profile before proposing a skill.".into());
    }
    capabilities::propose_skill(conn, profile, "", slug, description, body).map_err(|error| error.0)
}

fn active_profile(conn: &Connection) -> String {
    if let Ok(Some(id)) = db::kv_get(conn, "active_profile") {
        if !id.trim().is_empty() {
            return id;
        }
    }
    conn.query_row("SELECT id FROM bot_profiles ORDER BY created_at LIMIT 1", [], |row| row.get(0)).unwrap_or_default()
}

fn profile_label(conn: &Connection, id: &str) -> String {
    if id.is_empty() {
        return "none".into();
    }
    conn.query_row("SELECT display_name FROM bot_profiles WHERE id = ?1", params![id], |row| row.get::<_, String>(0)).unwrap_or_else(|_| id.to_string())
}

fn arg<'a>(args: &'a Value, key: &str) -> &'a str {
    args.get(key).and_then(|value| value.as_str()).unwrap_or("").trim()
}

fn first_arg<'a>(args: &'a Value, keys: &[&str]) -> &'a str {
    keys.iter().find_map(|key| args.get(*key).and_then(|value| value.as_str()).map(str::trim).filter(|value| !value.is_empty())).unwrap_or("")
}

fn instructions() -> &'static str {
    "You are connected to Ronic OS on this computer. Use these tools for its skills, plugins, memory, and files. Do not say you cannot access the workspace or a file the user attached or referenced. save_memory writes the Memory screen and rewrites its structured markdown sheet. The same title, or an id from list_memory, updates that note and keeps its vault, file, scope, and graph links. Edit that sheet with save_memory or curate_memory. Do not rewrite the file. curate_memory writes one short always-on fact (target user, memory, or bot). A write over the cap is refused. update_memory_graph adds, changes, or removes one link and does not rewrite the note. skill_manage proposes a skill and waits for approval. read_file opens a project-relative path inside the project folder, a memory sheet under the product memories folder, or an absolute path (e.g. a file the user attached or named) anywhere on this computer — secret files are blocked and text is redacted. list_files lists a folder the same way. Shell, wallet, and API keys are not available. ronic_search_capabilities and ronic_execute_codemode are the Code Mode surface. ronic_ask_peer_app stores a ticket for another app and does not launch it. workspace_webapp and desktop_app control the Dock. connect writes the local MCP server into Cursor, VS Code, or Claude Code, or opens a web app's connector page in the Dock. A site login is not an MCP connection. eval is not on this bridge."
}

fn tool_defs() -> Value {
    json!([
        { "name": "workspace_manifest", "description": "Live Ronic OS skill index, plugins, memory, and tasks.", "inputSchema": { "type": "object", "properties": { "text": { "type": "string" } } } },
        { "name": "list_skills", "description": "List the skill index for the active Ronic OS profile.", "inputSchema": { "type": "object", "properties": {} } },
        { "name": "load_skill", "description": "Load one SKILL.md playbook from the active profile.", "inputSchema": { "type": "object", "properties": { "slug": { "type": "string" } }, "required": ["slug"] } },
        { "name": "load_skill_file", "description": "Load one supporting reference or script from a skill.", "inputSchema": { "type": "object", "properties": { "slug": { "type": "string" }, "path": { "type": "string" } }, "required": ["slug", "path"] } },
        { "name": "list_plugins", "description": "List installed Ronic OS plugins.", "inputSchema": { "type": "object", "properties": {} } },
        { "name": "list_memory", "description": "List workspace memories as short structured markdown cards.", "inputSchema": { "type": "object", "properties": {} } },
        { "name": "search_memory", "description": "Search memory titles and body text. Each hit is a short structured markdown card.", "inputSchema": { "type": "object", "properties": { "query": { "type": "string" } }, "required": ["query"] } },
        { "name": "save_memory", "description": "Save or update a memory on the Memory screen. The same title, or an id from list_memory, updates that note in place. The update keeps its vault, file, scope, and graph links. The save rewrites a structured markdown sheet. Edit with this tool, not by rewriting the file.", "inputSchema": { "type": "object", "properties": { "title": { "type": "string" }, "content": { "type": "string" }, "id": { "type": "string" } }, "required": ["title", "content"] } },
        { "name": "curate_memory", "description": "Add, replace, or remove one short always-on fact. target is user (1375 chars), memory (2200 chars), or bot (1800 chars, this bot only). action is add, replace, or remove. replace and remove need oldText, a unique piece of one fact. A write over the cap is refused and the vault notes are not changed.", "inputSchema": { "type": "object", "properties": { "target": { "type": "string" }, "action": { "type": "string" }, "content": { "type": "string" }, "oldText": { "type": "string" } }, "required": ["target", "action"] } },
        { "name": "update_memory_graph", "description": "Add, change, or remove one graph link on an existing memory. This does not rewrite the note. title or id picks the note. target is the other entity. relation defaults to RELATES. remove=true deletes that one link.", "inputSchema": { "type": "object", "properties": { "title": { "type": "string" }, "id": { "type": "string" }, "target": { "type": "string" }, "relation": { "type": "string" }, "remove": { "type": "boolean" } }, "required": ["target"] } },
        { "name": "list_files", "description": "List files and folders. Pass a project-relative path (or empty for the project root), or an absolute path to any folder on this computer.", "inputSchema": { "type": "object", "properties": { "path": { "type": "string" } } } },
        { "name": "read_file", "description": "Read a text file. Pass a project-relative path inside the project folder, a memory sheet under the product memories folder, or an absolute path (e.g. an attached file the user referenced) anywhere on this computer. Secret files are blocked and secrets in the text are redacted.", "inputSchema": { "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"] } },
        { "name": "list_mcp", "description": "List MCP servers configured in Ronic OS. This does not start them.", "inputSchema": { "type": "object", "properties": {} } },
        { "name": "list_providers", "description": "List provider names and health. Secrets are not included.", "inputSchema": { "type": "object", "properties": {} } },
        { "name": "list_threads", "description": "List task titles for the active profile.", "inputSchema": { "type": "object", "properties": {} } },
        { "name": "skill_manage", "description": "Propose a skill. It waits for approval and does not write the file.", "inputSchema": { "type": "object", "properties": { "slug": { "type": "string" }, "description": { "type": "string" }, "body": { "type": "string" } }, "required": ["slug", "body"] } },
        { "name": "ronic_search_capabilities", "description": "Filter saved MCP tools, skills, and local bridge tools by a short query.", "inputSchema": { "type": "object", "properties": { "query": { "type": "string" } }, "required": ["query"] } },
        { "name": "ronic_execute_codemode", "description": "Run one TypeScript block whose await ronic.* calls go through the local gateway.", "inputSchema": { "type": "object", "properties": { "script": { "type": "string" } }, "required": ["script"] } },
        { "name": "ronic_ask_peer_app", "description": "Queue a task for another mesh app. This does not launch that app or edit files.", "inputSchema": { "type": "object", "properties": { "target": { "type": "string" }, "task": { "type": "string" } }, "required": ["target", "task"] } },
        { "name": "workspace_webapp", "description": "Control a Dock web app. action is list, open, read, click, type, scroll, close, connect, or status. connect opens ChatGPT, Claude, or Grok connector settings in the Dock. A site login is not an MCP connection. Gemini web has no custom connector. eval is not available.", "inputSchema": { "type": "object", "properties": { "action": { "type": "string" }, "app": { "type": "string" }, "url": { "type": "string" }, "id": { "type": "number" }, "match": { "type": "string" }, "text": { "type": "string" }, "direction": { "type": "string" } }, "required": ["action"] } },
        { "name": "desktop_app", "description": "Control a desktop app on this computer. action is list, open, inspect, click, type, status, or connect. inspect returns live controls for window (or the foreground window) and does not invent buttons. click and type take markId or match. type also needs text. connect writes the local Ronic OS MCP server into Cursor, VS Code, or Claude Code. Obsidian and Ollama do not speak MCP.", "inputSchema": { "type": "object", "properties": { "action": { "type": "string" }, "app": { "type": "string" }, "path": { "type": "string" }, "kind": { "type": "string" }, "window": { "type": "string" }, "markId": { "type": "number" }, "match": { "type": "string" }, "text": { "type": "string" } }, "required": ["action"] } }
    ])
}

fn bridge_label(label: &str) -> bool {
    label.starts_with("webapp_")
        || label.starts_with("ronic_webapp_")
        || label.starts_with("harness_")
        || (label.starts_with("ronic_mini_comp_") && label.ends_with("_chrome"))
        || label.starts_with("ronic_squad_comp_")
}

fn watched_views(app: &AppHandle) -> Vec<tauri::Webview> {
    let mut views = Vec::new();
    for (label, view) in app.webviews() {
        if bridge_label(&label) {
            views.push(view);
        }
    }
    if views.is_empty() {
        if let Some(window) = app.get_window("main") {
            for view in window.webviews() {
                if view.label().starts_with("webapp_") {
                    views.push(view);
                }
            }
        }
        for (label, window) in app.webview_windows() {
            if label.starts_with("harness_") || label.starts_with("ronic_webapp_") {
                for (_, view) in window.webviews() {
                    views.push(view);
                }
            }
        }
    }
    views
}

fn pump(app: AppHandle) {
    let mut tick = 0u32;
    loop {
        std::thread::sleep(Duration::from_millis(150));
        tick = tick.wrapping_add(1);
        if tick % 20 == 0 {
            crate::site_window::recover_blank_webapps(&app);
        }
        let views = watched_views(&app);
        if views.is_empty() {
            continue;
        }
        let views: Vec<_> = views.into_iter().filter(session_page_view).collect();
        if views.is_empty() {
            continue;
        }
        if tick % 16 == 0 {
            if let Some(pack) = with_db(&app, |conn, home| context_block(conn, home, "")) {
                let literal = serde_json::to_string(&pack).unwrap_or_else(|_| "\"\"".into());
                let script = format!("window.__RONIC_CACHE={literal}");
                for view in &views {
                    if cache_page_view(view) {
                        let _ = view.eval(&script);
                    }
                }
            }
        }
        for view in views {
            let label = view.label().to_string();
            if !mark_flight(&label) {
                continue;
            }
            let app = app.clone();
            let watched = label.clone();
            if view.eval_with_callback(DRAIN, move |raw: String| {
                deliver(&app, &watched, &raw);
                clear_flight(&watched);
            }).is_err() {
                clear_flight(&label);
            }
        }
    }
}

const DRAIN: &str = "(function(){var box=window.__RONIC_OUTBOX||[];window.__RONIC_OUTBOX=[];return box;})()";

fn mark_flight(label: &str) -> bool {
    let mut flights = IN_FLIGHT.lock().unwrap_or_else(|poison| poison.into_inner());
    flights.retain(|(_, at)| at.elapsed() < Duration::from_secs(3));
    if flights.iter().any(|(name, _)| name == label) {
        return false;
    }
    flights.push((label.to_string(), Instant::now()));
    true
}

fn clear_flight(label: &str) {
    let mut flights = IN_FLIGHT.lock().unwrap_or_else(|poison| poison.into_inner());
    flights.retain(|(name, _)| name != label);
}

/// Pages that may hold the workspace pack in the page itself: chat composers
/// and a custom workspace webapp. Other sites only report sign-in.
fn cache_page_view(view: &tauri::Webview) -> bool {
    let Ok(url) = view.url() else { return false };
    if chat_page_url(&url) {
        return true;
    }
    let label = view.label();
    if label.starts_with("webapp_custom_") || label.starts_with("ronic_webapp_custom_") {
        let host = url.host_str().unwrap_or("");
        return !is_auth_host(host);
    }
    false
}

/// Any open bridge page except an account-login host. Sign-in on GitHub,
/// Supabase, Notion, or Slack is recorded the same way.
fn session_page_view(view: &tauri::Webview) -> bool {
    let Ok(url) = view.url() else { return false };
    if session_page_url(&url) {
        return true;
    }
    cache_page_view(view)
}

pub(crate) fn chat_page_url(url: &url::Url) -> bool {
    let scheme = url.scheme();
    if scheme != "https" && scheme != "http" {
        return false;
    }
    chat_page_host(url.host_str().unwrap_or(""))
}

pub(crate) fn is_auth_host(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    matches!(
        host.as_str(),
        "accounts.google.com"
            | "accounts.youtube.com"
            | "appleid.apple.com"
            | "login.live.com"
            | "login.microsoftonline.com"
            | "auth.openai.com"
            | "auth0.com"
            | "okta.com"
    ) || host.ends_with(".accounts.google.com")
        || host.ends_with(".login.microsoftonline.com")
        || host.ends_with(".auth.openai.com")
        || host.ends_with(".auth0.com")
        || host.ends_with(".okta.com")
}

pub(crate) fn chat_page_host(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    matches!(
        host.as_str(),
        "chatgpt.com"
            | "www.chatgpt.com"
            | "chat.openai.com"
            | "claude.ai"
            | "www.claude.ai"
            | "gemini.google.com"
            | "grok.com"
            | "www.grok.com"
            | "x.com"
            | "www.x.com"
            | "twitter.com"
            | "www.twitter.com"
            | "perplexity.ai"
            | "www.perplexity.ai"
            | "deepseek.com"
            | "chat.deepseek.com"
            | "mistral.ai"
            | "chat.mistral.ai"
            | "meta.ai"
            | "www.meta.ai"
            | "copilot.microsoft.com"
            | "openrouter.ai"
            | "chat.qwen.ai"
    ) || host.ends_with(".chatgpt.com")
        || host.ends_with(".claude.ai")
        || host.ends_with(".grok.com")
        || host.ends_with(".x.com")
        || host.ends_with(".twitter.com")
        || host.ends_with(".perplexity.ai")
        || host.ends_with(".deepseek.com")
        || host.ends_with(".mistral.ai")
        || host.ends_with(".meta.ai")
        || host.ends_with(".openrouter.ai")
        || host.ends_with(".qwen.ai")
}

fn deliver(app: &AppHandle, label: &str, raw: &str) {
    let items = parse_box(raw);
    if items.is_empty() {
        return;
    }
    let mut calls = String::new();
    for item in items {
        let id = item.get("id").and_then(|value| value.as_u64()).unwrap_or(0);
        let op = item.get("op").and_then(|value| value.as_str()).unwrap_or("");
        let text = item.get("text").and_then(|value| value.as_str()).unwrap_or("");
        if op == "auth_status" {
            let signed_in = item.get("signedIn").and_then(|v| v.as_bool()).unwrap_or(false);
            let host = item.get("host").and_then(|v| v.as_str()).unwrap_or("");
            let _ = app.emit("ronic://webapp-auth-changed", serde_json::json!({
                "label": label,
                "host": host,
                "signedIn": signed_in
            }));
            save_webapp_auth(&bridge_home(app), label, host, signed_in);
            continue;
        }
        if op == "mcp-url" {
            let url = crate::tunnel::public_mcp_base();
            let literal = serde_json::to_string(&url).unwrap_or_else(|_| "\"\"".into());
            calls.push_str(&format!("window.__RONIC_DELIVER&&window.__RONIC_DELIVER({id},{literal});"));
            continue;
        }
        if op != "context" {
            let refusal = "Embedded pages cannot run Ronic OS tools. Use the Ronic OS chat or the signed MCP bridge.";
            let literal = serde_json::to_string(refusal).unwrap_or_else(|_| "\"\"".into());
            calls.push_str(&format!("window.__RONIC_DELIVER&&window.__RONIC_DELIVER({id},{literal});"));
            continue;
        }
        let answer = page_request(app, op, text);
        let literal = serde_json::to_string(&answer).unwrap_or_else(|_| "\"\"".into());
        calls.push_str(&format!("window.__RONIC_DELIVER&&window.__RONIC_DELIVER({id},{literal});"));
    }
    if let Some(view) = app.get_webview(label) {
        let _ = view.eval(calls);
    }
}

fn protocol_of(body: &Value) -> &'static str {
    match body.pointer("/params/protocolVersion").and_then(|value| value.as_str()) {
        Some("2024-11-05") => "2024-11-05",
        Some("2025-06-18") => "2025-06-18",
        _ => "2025-03-26",
    }
}

fn parse_box(raw: &str) -> Vec<Value> {
    if let Ok(items) = serde_json::from_str::<Vec<Value>>(raw) {
        return items;
    }
    if let Ok(text) = serde_json::from_str::<String>(raw) {
        if let Ok(items) = serde_json::from_str::<Vec<Value>>(&text) {
            return items;
        }
    }
    Vec::new()
}

/// Keep the last sign-in signal each webapp page reported, so the mesh can
/// show an honest "signed in" state without pretending a profile folder is an
/// MCP connection. Writes only when the stored state changes.
fn auth_record_id(label: &str) -> Option<String> {
    if let Some(id) = label.strip_prefix("ronic_webapp_").or_else(|| label.strip_prefix("webapp_")) {
        let id = id.trim_end_matches("_web").trim();
        if id.is_empty() { None } else { Some(id.to_string()) }
    } else if let Some(rest) = label.strip_prefix("ronic_mini_comp_") {
        let id = rest.strip_suffix("_chrome").unwrap_or(rest).trim();
        if id.is_empty() { None } else { Some(format!("bot-{id}")) }
    } else if let Some(rest) = label.strip_prefix("ronic_squad_comp_") {
        let id = rest.strip_suffix("_chrome").unwrap_or(rest).trim();
        if id.is_empty() { None } else { Some(format!("squad-{id}")) }
    } else if let Some(rest) = label.strip_prefix("harness_") {
        let id = rest.trim();
        if id.is_empty() { None } else { Some(format!("harness-{id}")) }
    } else {
        None
    }
}

fn save_webapp_auth(home: &Path, label: &str, host: &str, signed_in: bool) {
    let Some(id) = auth_record_id(label) else {
        return;
    };
    let path = home.join("webapp-auth.json");
    let mut root: Value = fs::read_to_string(&path).ok().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_else(|| json!({}));
    if !root.is_object() {
        root = json!({});
    }
    let existing = root.get(&id).cloned().unwrap_or(Value::Null);
    if existing.get("signedIn").and_then(Value::as_bool) == Some(signed_in) && !host.is_empty() {
        return;
    }
    let entry = json!({ "signedIn": signed_in, "at": now_ms(), "host": host });
    root.as_object_mut().unwrap().insert(id.to_string(), entry);
    let _ = fs::write(&path, serde_json::to_vec(&root).unwrap_or_default());
}

pub(crate) fn authorized(token: &str, target: &str, headers: &[(String, String)]) -> bool {
    if token.is_empty() {
        return false;
    }
    if let Some(query) = target.split_once('?').map(|(_, query)| query) {
        for pair in query.split('&') {
            if let Some((key, value)) = pair.split_once('=') {
                if key == "token" && value == token {
                    return true;
                }
            }
        }
    }
    headers.iter().any(|(name, value)| name.eq_ignore_ascii_case("authorization") && bearer(value, token))
}

fn bearer(value: &str, token: &str) -> bool {
    let mut parts = value.trim().splitn(2, char::is_whitespace);
    let scheme = parts.next().unwrap_or("");
    let rest = parts.next().unwrap_or("").trim();
    scheme.eq_ignore_ascii_case("bearer") && rest == token
}

pub(crate) fn read_request(stream: &mut TcpStream) -> std::io::Result<(String, Vec<(String, String)>, Vec<u8>)> {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 4096];
    let header_end = loop {
        if buf.len() > 65_536 {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "headers too large"));
        }
        let read = stream.read(&mut tmp)?;
        if read == 0 {
            return Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "closed"));
        }
        buf.extend_from_slice(&tmp[..read]);
        if let Some(pos) = buf.windows(4).position(|window| window == b"\r\n\r\n") {
            break pos;
        }
    };
    let head_bytes = buf[..header_end].to_vec();
    let head = String::from_utf8_lossy(&head_bytes);
    let mut lines = head.split("\r\n");
    let request = lines.next().unwrap_or("").to_string();
    let mut headers = Vec::new();
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            headers.push((name.trim().to_string(), value.trim().to_string()));
        }
    }
    let length = headers.iter().find(|(name, _)| name.eq_ignore_ascii_case("content-length")).and_then(|(_, value)| value.parse::<usize>().ok()).unwrap_or(0);
    if length > MAX_BODY {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "body too large"));
    }
    let mut body = buf[header_end + 4..].to_vec();
    while body.len() < length {
        let read = stream.read(&mut tmp)?;
        if read == 0 {
            break;
        }
        body.extend_from_slice(&tmp[..read]);
        if body.len() > MAX_BODY {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "body too large"));
        }
    }
    body.truncate(length);
    Ok((request, headers, body))
}

pub(crate) fn write_response(stream: &mut TcpStream, status: u16, content_type: &str, body: &[u8]) -> std::io::Result<()> {
    let extra: &[(String, String)] = &[];
    write_response_extra(stream, status, content_type, body, extra)
}

pub(crate) fn write_response_extra(stream: &mut TcpStream, status: u16, content_type: &str, body: &[u8], extra: &[(String, String)]) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        201 => "Created",
        202 => "Accepted",
        204 => "No Content",
        302 => "Found",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        405 => "Method Not Allowed",
        500 => "Internal Server Error",
        _ => "Error",
    };
    let mut header = format!("HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: *\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\n", body.len());
    for (name, value) in extra {
        if name.bytes().any(|byte| byte == b'\r' || byte == b'\n') || value.bytes().any(|byte| byte == b'\r' || byte == b'\n') {
            continue;
        }
        header.push_str(name);
        header.push_str(": ");
        header.push_str(value);
        header.push_str("\r\n");
    }
    header.push_str("\r\n");
    stream.write_all(header.as_bytes())?;
    if !body.is_empty() {
        stream.write_all(body)?;
    }
    let _ = stream.flush();
    Ok(())
}

fn bridge_home(app: &AppHandle) -> PathBuf {
    app.try_state::<AppState>().map(|state| state.home.clone()).unwrap_or_else(|| user_home().join(".ronicos"))
}

fn load_token(app: &AppHandle) -> String {
    let home = bridge_home(app);
    let _ = fs::create_dir_all(&home);
    let path = home.join("bridge-token");
    if let Ok(existing) = fs::read_to_string(&path) {
        let token = existing.trim().to_string();
        if token.len() == 64 && token.chars().all(|ch| ch.is_ascii_hexdigit()) {
            return token;
        }
    }
    let token = random_token();
    let _ = fs::write(path, &token);
    token
}

fn random_token() -> String {
    let mut bytes = [0u8; 32];
    fill_random(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn fill_random(buf: &mut [u8]) {
    // getrandom is the same CSPRNG the vault uses. The old time+pid LCG
    // fallback produced predictable tokens for the bridge and tunnel.
    if getrandom::getrandom(buf).is_err() {
        fallback_random(buf);
    }
}

fn fallback_random(buf: &mut [u8]) {
    let mut state = SystemTime::now().duration_since(UNIX_EPOCH).map(|time| time.as_nanos()).unwrap_or(1) ^ (std::process::id() as u128) << 32;
    for byte in buf {
        state = state.wrapping_mul(0x6a09_e667_f3bc_c909).wrapping_add(0xbb67_ae85_84ca_a73b);
        *byte = (state >> 56) as u8;
    }
}

fn set_note(note: String) {
    let mut shared = SHARED.lock().unwrap_or_else(|poison| poison.into_inner());
    shared.note = note;
}

struct ClientFile {
    label: &'static str,
    path: PathBuf,
    create: bool,
    entry: Value,
    /// Claude, Cursor, Copilot, and Gemini use `mcpServers`. VS Code's own
    /// `mcp.json` uses `servers`.
    map_key: &'static str,
}

fn register_clients(port: u16, token: &str) -> (Vec<String>, String) {
    let url = format!("http://127.0.0.1:{port}/mcp");
    let headers = json!({ "Authorization": format!("Bearer {token}") });
    let claude = json!({ "type": "http", "url": &url, "headers": &headers });
    let gemini = gemini_http_entry(&url, &headers);
    let cursor = json!({ "url": &url, "headers": &headers });
    let home = user_home();
    let mut files = vec![
        ClientFile { label: "Claude Code", path: home.join(".claude.json"), create: true, entry: claude.clone(), map_key: "mcpServers" },
        ClientFile { label: "Gemini CLI", path: home.join(".gemini").join("settings.json"), create: true, entry: gemini, map_key: "mcpServers" },
        ClientFile { label: "Cursor", path: home.join(".cursor").join("mcp.json"), create: true, entry: cursor, map_key: "mcpServers" },
        ClientFile { label: "Copilot", path: home.join(".copilot").join("mcp-config.json"), create: true, entry: claude.clone(), map_key: "mcpServers" },
    ];
    if let Some(appdata) = std::env::var_os("APPDATA") {
        let code = PathBuf::from(&appdata).join("Code").join("User");
        if code.is_dir() {
            files.push(ClientFile { label: "VS Code", path: code.join("mcp.json"), create: true, entry: claude.clone(), map_key: "servers" });
        }
        let desktop = PathBuf::from(appdata).join("Claude");
        if desktop.is_dir() {
            files.push(ClientFile { label: "Claude Desktop", path: desktop.join("claude_desktop_config.json"), create: true, entry: claude.clone(), map_key: "mcpServers" });
        }
    }
    let mut clients = Vec::new();
    let mut problems = Vec::new();
    for file in files {
        match upsert_mcp_map(&file.path, file.map_key, &file.entry, file.create) {
            Ok(_) => clients.push(format!("{} ({})", file.label, file.path.display())),
            Err(error) => problems.push(format!("{}: {error}", file.label)),
        }
    }
    let note = if problems.is_empty() {
        "CLI harnesses use the local Ronic OS MCP server. Restart a CLI that was already open.".into()
    } else {
        format!("Some CLI configs were left unchanged. {}", problems.join(" "))
    };
    (clients, note)
}

pub(crate) fn upsert_mcp(path: &Path, entry: &Value, create: bool) -> Result<bool, String> {
    upsert_mcp_map(path, "mcpServers", entry, create)
}

/// Merge `ronic-os` under `map_key` and leave every other server in place.
/// `mcpServers` is the Claude, Cursor, Copilot, and Gemini key. `servers` is
/// the key in a VS Code user or workspace `mcp.json`.
pub(crate) fn upsert_mcp_map(path: &Path, map_key: &str, entry: &Value, create: bool) -> Result<bool, String> {
    if !create && !path.is_file() {
        return Ok(false);
    }
    let mut root = if path.is_file() {
        let text = fs::read_to_string(path).map_err(|error| error.to_string())?;
        if text.trim().is_empty() {
            json!({})
        } else {
            serde_json::from_str::<Value>(&text).map_err(|_| format!("{} is not JSON, so it was left unchanged", path.display()))?
        }
    } else {
        json!({})
    };
    if !root.is_object() {
        return Err(format!("{} is not a JSON object, so it was left unchanged", path.display()));
    }
    let servers = root.as_object_mut().unwrap().entry(map_key).or_insert_with(|| json!({}));
    if !servers.is_object() {
        return Err(format!("{map_key} in {} is not an object, so it was left unchanged", path.display()));
    }
    let current = servers.get("ronic-os");
    if current == Some(entry) {
        return Ok(false);
    }
    servers.as_object_mut().unwrap().insert("ronic-os".into(), entry.clone());
    write_json(path, &root)
}

fn write_json(path: &Path, value: &Value) -> Result<bool, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    let tmp = path.with_extension("ronic-tmp");
    fs::write(&tmp, &bytes).map_err(|error| error.to_string())?;
    if fs::rename(&tmp, path).is_err() {
        let _ = fs::remove_file(path);
        if fs::rename(&tmp, path).is_err() {
            fs::write(path, &bytes).map_err(|error| error.to_string())?;
            let _ = fs::remove_file(&tmp);
        }
    }
    Ok(true)
}

/// Write the local MCP server into one Dock desktop client's config.
/// Cursor, VS Code, Claude Code, and the Gemini CLI each keep their own file shape.
pub(crate) fn connect_named_client(which: &str) -> Result<String, String> {
    let current = status();
    if current.port == 0 || current.endpoint.is_empty() {
        return Err("The MCP bridge is not listening, so the client config was not written.".into());
    }
    let token = fs::read_to_string(crate::util::product_home().join("bridge-token")).unwrap_or_default();
    let token = token.trim();
    if token.len() < 32 {
        return Err("The bridge token is missing, so the client config was not written.".into());
    }
    let url = current.endpoint.clone();
    let headers = json!({ "Authorization": format!("Bearer {token}") });
    let claude = json!({ "type": "http", "url": &url, "headers": &headers });
    let cursor = json!({ "url": &url, "headers": &headers });
    let gemini = gemini_http_entry(&url, &headers);
    let home = user_home();
    let mut notes = Vec::new();
    match which {
        "cursor" => notes.push(write_client("Cursor", &home.join(".cursor").join("mcp.json"), &cursor, true)?),
        "vscode" => {
            let mut wrote = false;
            if let Some(appdata) = std::env::var_os("APPDATA") {
                let dir = PathBuf::from(appdata).join("Code").join("User");
                if dir.is_dir() {
                    match write_client_map("VS Code", &dir.join("mcp.json"), "servers", &claude, true) {
                        Ok(note) => {
                            wrote = true;
                            notes.push(note);
                        }
                        Err(error) => notes.push(error),
                    }
                } else {
                    notes.push("VS Code's User folder is not on this account, so User/mcp.json was not written.".into());
                }
            } else {
                notes.push("APPDATA is not set, so VS Code's User/mcp.json was not written.".into());
            }
            match write_client_map("Copilot", &home.join(".copilot").join("mcp-config.json"), "mcpServers", &claude, true) {
                Ok(note) => {
                    wrote = true;
                    notes.push(note);
                }
                Err(error) => notes.push(error),
            }
            if !wrote {
                return Err(notes.join(" "));
            }
        }
        "claude-code" => {
            notes.push(write_client("Claude Code", &home.join(".claude.json"), &claude, true)?);
            if let Some(appdata) = std::env::var_os("APPDATA") {
                let dir = PathBuf::from(appdata).join("Claude");
                if dir.is_dir() {
                    notes.push(write_client("Claude Desktop", &dir.join("claude_desktop_config.json"), &claude, true)?);
                }
            }
        }
        "gemini-cli" => notes.push(write_client("Gemini CLI", &home.join(".gemini").join("settings.json"), &gemini, true)?),
        _ => return Err(format!("{which} does not take a local MCP config.")),
    }
    Ok(notes.join(" "))
}

/// Gemini CLI treats `url` as SSE and rejects a `type` field on a remote server.
/// Streamable HTTP is `httpUrl` plus headers, and nothing else.
pub(crate) fn gemini_http_entry(url: &str, headers: &Value) -> Value {
    json!({ "httpUrl": url, "headers": headers })
}

fn write_client(label: &str, path: &Path, entry: &Value, create: bool) -> Result<String, String> {
    write_client_map(label, path, "mcpServers", entry, create)
}

fn write_client_map(label: &str, path: &Path, map_key: &str, entry: &Value, create: bool) -> Result<String, String> {
    if upsert_mcp_map(path, map_key, entry, create)? {
        Ok(format!("{label} now includes the Ronic OS MCP server ({}). Restart it if it was already open.", path.display()))
    } else {
        Ok(format!("{label} already has the Ronic OS MCP server ({}).", path.display()))
    }
}

fn sanitize_mcp_key(raw: &str) -> String {
    let mut out = String::new();
    for ch in raw.trim().chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
        } else if (ch == '-' || ch == '_' || ch == ' ') && !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
        if out.len() >= 48 {
            break;
        }
    }
    out.trim_matches('-').to_string()
}

fn external_mcp_entry(server: &crate::models::McpServer, style: &str) -> Option<Value> {
    let transport = server.transport.trim().to_ascii_lowercase();
    let url = server.url.trim();
    let command = server.command.trim();
    if !url.is_empty() && (transport == "http" || transport == "sse" || transport == "remote" || command.is_empty()) {
        return Some(match style {
            "gemini" => json!({ "httpUrl": url }),
            "cursor" => json!({ "url": url }),
            "opencode" => json!({ "type": "remote", "url": url }),
            _ => json!({ "type": "http", "url": url }),
        });
    }
    if !command.is_empty() {
        return Some(match style {
            "opencode" => {
                let mut cmd = vec![command.to_string()];
                cmd.extend(server.args.iter().cloned());
                json!({ "type": "local", "command": cmd })
            }
            "vscode" => json!({ "type": "stdio", "command": command, "args": server.args }),
            _ => json!({ "command": command, "args": server.args }),
        });
    }
    None
}

/// Merge `ronic-os` (always refreshed) plus enabled Ronic OS MCP servers (only
/// inserted when that server key is absent so user overrides stay intact).
pub(crate) fn upsert_harness_mcp_json(
    path: &Path,
    map_key: &str,
    ronic_entry: &Value,
    extras: &[(String, Value)],
    create: bool,
) -> Result<Vec<String>, String> {
    if !create && !path.is_file() {
        return Ok(Vec::new());
    }
    let mut root = if path.is_file() {
        let text = fs::read_to_string(path).map_err(|error| error.to_string())?;
        if text.trim().is_empty() {
            json!({})
        } else {
            serde_json::from_str::<Value>(&text)
                .map_err(|_| format!("{} is not JSON, so it was left unchanged", path.display()))?
        }
    } else {
        json!({})
    };
    if !root.is_object() {
        return Err(format!("{} is not a JSON object, so it was left unchanged", path.display()));
    }
    let servers = root.as_object_mut().unwrap().entry(map_key).or_insert_with(|| json!({}));
    if !servers.is_object() {
        return Err(format!("{map_key} in {} is not an object, so it was left unchanged", path.display()));
    }
    let map = servers.as_object_mut().unwrap();
    let mut changed = false;
    let mut synced = vec!["ronic-os".to_string()];
    if map.get("ronic-os") != Some(ronic_entry) {
        map.insert("ronic-os".into(), ronic_entry.clone());
        changed = true;
    }
    for (key, entry) in extras {
        if key.is_empty() || key == "ronic-os" {
            continue;
        }
        if !map.contains_key(key) {
            map.insert(key.clone(), entry.clone());
            changed = true;
        }
        synced.push(key.clone());
    }
    if changed {
        write_json(path, &root)?;
    }
    Ok(synced)
}

pub(crate) fn upsert_codex_mcp_toml(path: &Path, url: &str, token: &str) -> Result<bool, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let existing = if path.is_file() {
        fs::read_to_string(path).map_err(|error| error.to_string())?
    } else {
        String::new()
    };
    let start_marker = "# ronicos-mcp-hub-start";
    let end_marker = "# ronicos-mcp-hub-end";
    let block = format!(
        "{start_marker}\n[mcp_servers.ronic-os]\nurl = \"{url}\"\n\n[mcp_servers.ronic-os.http_headers]\nAuthorization = \"Bearer {token}\"\n{end_marker}\n"
    );
    let updated = if let (Some(s), Some(e)) = (existing.find(start_marker), existing.find(end_marker)) {
        if e > s {
            let after = e + end_marker.len();
            let tail = existing[after..].trim_start_matches('\r').trim_start_matches('\n');
            format!("{}{block}{tail}", &existing[..s])
        } else {
            format!("{}\n{block}", existing.trim_end())
        }
    } else if existing.contains("[mcp_servers.ronic-os]") {
        // Legacy manual or automesh block present — leave user edits alone.
        return Ok(false);
    } else if existing.trim().is_empty() {
        block
    } else {
        format!("{}\n\n{block}", existing.trim_end())
    };
    if updated == existing {
        return Ok(false);
    }
    fs::write(path, updated).map_err(|error| error.to_string())?;
    Ok(true)
}

pub(crate) fn is_agy_binary(binary_path: &str) -> bool {
    let name = Path::new(binary_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    name == "agy" || name == "agy.exe" || name == "agy.cmd"
}

fn write_coding_context_file(conn: &Connection, home: &Path, project_root: &str) -> PathBuf {
    let _ = fs::create_dir_all(home);
    let path = home.join("coding-context.md");
    let mut body = context_block(conn, home, "");
    let project = project_root.trim();
    if !project.is_empty() {
        body = format!("# Ronic OS Coding Agent Context\nActive project root: {project}\n\n{body}\n");
    }
    let _ = fs::write(&path, body);
    path
}

static AGY_REGISTERED_KEYS: Mutex<Vec<String>> = Mutex::new(Vec::new());
static HARNESS_SYNC_CACHE: Mutex<Vec<(String, Instant, Value)>> = Mutex::new(Vec::new());

/// Run `agy mcp add` once per `(binary, endpoint, token)` in a background thread
/// so harness selection and dispatch never stall waiting on a child process.
fn register_agy_mcp_async(binary_path: &str, url: &str, token: &str) {
    if !is_agy_binary(binary_path) || !Path::new(binary_path).is_file() {
        return;
    }
    let key = format!("{binary_path}|{url}|{token}");
    {
        let mut seen = AGY_REGISTERED_KEYS.lock().unwrap_or_else(|e| e.into_inner());
        if seen.iter().any(|k| k == &key) {
            return;
        }
        seen.push(key);
    }
    let bin = binary_path.to_string();
    let endpoint = url.to_string();
    let auth_header = format!("Authorization: Bearer {token}");
    std::thread::spawn(move || {
        let _ = crate::util::run_capture(
            &bin,
            &["mcp", "add", "--type", "http", "--header", &auth_header, "ronic-os", &endpoint],
            None,
            Duration::from_secs(6),
        );
    });
}

/// Fast path for dispatch: reuse a recent sync report (within 45s) for the same
/// `(agent, project_root)` instead of rewriting config files on every prompt.
pub(crate) fn sync_harness_capabilities_fast(
    conn: &Connection,
    home: &Path,
    agent: &str,
    binary_path: &str,
    project_root: &str,
) -> Result<Value, String> {
    let cache_key = format!("{agent}|{}|{}", binary_path.trim(), project_root.trim());
    {
        let cache = HARNESS_SYNC_CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((_, at, val)) = cache.iter().find(|(k, _, _)| k == &cache_key) {
            if at.elapsed() < Duration::from_secs(45) {
                return Ok(val.clone());
            }
        }
    }
    sync_harness_capabilities(conn, home, agent, binary_path, project_root)
}

/// Automatically wire Ronic OS skills, plugins, MCP servers, and workspace
/// context for whichever coding agent/harness the user selects or dispatches.
pub(crate) fn sync_harness_capabilities(
    conn: &Connection,
    home: &Path,
    agent: &str,
    binary_path: &str,
    project_root: &str,
) -> Result<Value, String> {
    let profile = active_profile(conn);
    let view = capabilities::view(conn, home, &profile).map_err(|e| e.0)?;
    let enabled_skills: Vec<_> = view
        .skills
        .iter()
        .filter(|skill| in_index(skill, &profile, capabilities::plugin_agent_on(&view.plugins, &skill.plugin_id, &profile)))
        .collect();
    let enabled_plugins: Vec<_> = view
        .plugins
        .iter()
        .filter(|plugin| plugin.agent_enables.iter().any(|f| f.profile_id == profile && f.enabled))
        .collect();
    let enabled_mcps: Vec<_> = view
        .mcp_servers
        .iter()
        .filter(|srv| srv.enables.iter().any(|f| f.profile_id == profile && f.enabled))
        .collect();
    let memories = memory_count(conn);

    let context_file = write_coding_context_file(conn, home, project_root);
    let bridge = status();
    let token = fs::read_to_string(home.join("bridge-token")).unwrap_or_default();
    let token = token.trim().to_string();
    let bridge_online = bridge.port != 0 && !bridge.endpoint.is_empty() && token.len() >= 32;

    let mut config_targets: Vec<String> = Vec::new();
    let mut synced_servers: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();

    if bridge_online {
        let url = bridge.endpoint.clone();
        let headers = json!({ "Authorization": format!("Bearer {token}") });
        let claude_entry = json!({ "type": "http", "url": &url, "headers": &headers });
        let cursor_entry = json!({ "url": &url, "headers": &headers });
        let gemini_entry = gemini_http_entry(&url, &headers);
        let opencode_entry = json!({ "type": "remote", "url": &url, "headers": &headers });

        let build_extras = |style: &str| -> Vec<(String, Value)> {
            enabled_mcps
                .iter()
                .filter_map(|srv| {
                    let key = sanitize_mcp_key(&srv.name);
                    if key.is_empty() {
                        return None;
                    }
                    external_mcp_entry(srv, style).map(|val| (key, val))
                })
                .collect()
        };

        // Always keep ~/.ronicos/mcp-hub.json current with ronic-os + enabled MCP servers.
        let hub_path = home.join("mcp-hub.json");
        if let Ok(list) = upsert_harness_mcp_json(&hub_path, "mcpServers", &claude_entry, &build_extras("claude"), true) {
            synced_servers = list;
        }

        let user = user_home();
        match agent {
            "claude" => {
                let p = user.join(".claude.json");
                match upsert_harness_mcp_json(&p, "mcpServers", &claude_entry, &build_extras("claude"), true) {
                    Ok(list) => {
                        synced_servers = list;
                        config_targets.push(format!("Claude Code ({})", p.display()));
                    }
                    Err(e) => warnings.push(e),
                }
                if let Some(appdata) = std::env::var_os("APPDATA") {
                    let dir = PathBuf::from(appdata).join("Claude");
                    if dir.is_dir() {
                        let cp = dir.join("claude_desktop_config.json");
                        if upsert_harness_mcp_json(&cp, "mcpServers", &claude_entry, &build_extras("claude"), true).is_ok() {
                            config_targets.push(format!("Claude Desktop ({})", cp.display()));
                        }
                    }
                }
            }
            "gemini" => {
                let p = user.join(".gemini").join("settings.json");
                match upsert_harness_mcp_json(&p, "mcpServers", &gemini_entry, &build_extras("gemini"), true) {
                    Ok(list) => {
                        synced_servers = list;
                        config_targets.push(format!("Gemini CLI ({})", p.display()));
                    }
                    Err(e) => warnings.push(e),
                }
                let agy_cfg = user.join(".gemini").join("antigravity").join("mcp_config.json");
                if is_agy_binary(binary_path) || agy_cfg.parent().is_some_and(|d| d.is_dir()) {
                    match upsert_harness_mcp_json(&agy_cfg, "mcpServers", &claude_entry, &build_extras("claude"), true) {
                        Ok(list) => {
                            synced_servers = list;
                            config_targets.push(format!("Antigravity MCP ({})", agy_cfg.display()));
                        }
                        Err(e) => warnings.push(e),
                    }
                }
                register_agy_mcp_async(binary_path, &url, &token);
            }
            "cursor" => {
                let p = user.join(".cursor").join("mcp.json");
                match upsert_harness_mcp_json(&p, "mcpServers", &cursor_entry, &build_extras("cursor"), true) {
                    Ok(list) => {
                        synced_servers = list;
                        config_targets.push(format!("Cursor ({})", p.display()));
                    }
                    Err(e) => warnings.push(e),
                }
            }
            "vscode" => {
                if let Some(appdata) = std::env::var_os("APPDATA") {
                    let dir = PathBuf::from(appdata).join("Code").join("User");
                    if dir.is_dir() {
                        let p = dir.join("mcp.json");
                        match upsert_harness_mcp_json(&p, "servers", &claude_entry, &build_extras("vscode"), true) {
                            Ok(list) => {
                                synced_servers = list;
                                config_targets.push(format!("VS Code ({})", p.display()));
                            }
                            Err(e) => warnings.push(e),
                        }
                    }
                }
                let copilot = user.join(".copilot").join("mcp-config.json");
                if upsert_harness_mcp_json(&copilot, "mcpServers", &claude_entry, &build_extras("claude"), true).is_ok() {
                    config_targets.push(format!("Copilot ({})", copilot.display()));
                }
                if !project_root.trim().is_empty() {
                    let ws_vscode = PathBuf::from(project_root.trim()).join(".vscode");
                    if ws_vscode.is_dir() {
                        let p = ws_vscode.join("mcp.json");
                        if upsert_harness_mcp_json(&p, "servers", &claude_entry, &build_extras("vscode"), true).is_ok() {
                            config_targets.push(format!("Workspace .vscode ({})", p.display()));
                        }
                    }
                }
            }
            "codex" => {
                let p = user.join(".codex").join("config.toml");
                match upsert_codex_mcp_toml(&p, &url, &token) {
                    Ok(_) => config_targets.push(format!("Codex CLI ({})", p.display())),
                    Err(e) => warnings.push(e),
                }
            }
            "opencode" => {
                let p = user.join(".config").join("opencode").join("opencode.json");
                match upsert_harness_mcp_json(&p, "mcp", &opencode_entry, &build_extras("opencode"), true) {
                    Ok(list) => {
                        synced_servers = list;
                        config_targets.push(format!("OpenCode CLI ({})", p.display()));
                    }
                    Err(e) => warnings.push(e),
                }
            }
            "aider" => {
                config_targets.push(format!("Context Pack ({})", context_file.display()));
                config_targets.push(format!("MCP Hub ({})", hub_path.display()));
            }
            _ => {
                config_targets.push(format!("MCP Hub ({})", hub_path.display()));
            }
        }
    } else {
        warnings.push("Local Ronic OS MCP bridge is still starting; skills/plugins/MCPs will still be injected via context.".into());
    }

    let report = json!({
        "agent": agent,
        "bridgeOnline": bridge_online,
        "bridgeEndpoint": bridge.endpoint,
        "contextFile": context_file.display().to_string(),
        "configTargets": config_targets,
        "syncedServers": synced_servers,
        "skillsCount": enabled_skills.len(),
        "pluginsCount": enabled_plugins.len(),
        "totalPluginsCount": view.plugins.len(),
        "mcpCount": enabled_mcps.len() + usize::from(bridge_online),
        "memoryCount": memories,
        "warnings": warnings,
        "syncedAt": now_ms(),
    });
    {
        let cache_key = format!("{agent}|{}|{}", binary_path.trim(), project_root.trim());
        let mut cache = HARNESS_SYNC_CACHE.lock().unwrap_or_else(|e| e.into_inner());
        cache.retain(|(k, _, _)| k != &cache_key);
        cache.push((cache_key, Instant::now(), report.clone()));
        if cache.len() > 16 {
            cache.remove(0);
        }
    }
    Ok(report)
}

/// Build the live Ronic OS context preamble injected into CLI coding agent dispatches.
/// `fast_mode = true` keeps the preamble ultra-compact (~400 chars) for fast TTFT
/// while still pointing MCP-capable harnesses at `ronic-os` and attaching any
/// explicitly selected/matched skill playbooks.
pub(crate) fn build_coding_dispatch_prompt(
    conn: &Connection,
    home: &Path,
    project_root: &str,
    user_prompt: &str,
    history_summary: &str,
    attached_files: &[String],
    selected_skills: &[String],
    fast_mode: bool,
) -> String {
    let profile = active_profile(conn);
    let view = capabilities::view(conn, home, &profile).ok();
    let bridge = status();
    let context_file = home.join("coding-context.md");
    let mut parts: Vec<String> = Vec::new();

    if fast_mode {
        let mcp_hint = if bridge.port != 0 && !bridge.endpoint.is_empty() {
            format!("Ronic OS MCP `ronic-os` is active at {} (list_skills/load_skill/list_plugins/list_mcp/search_memory).", bridge.endpoint)
        } else {
            format!("Ronic OS context: {}.", context_file.display())
        };
        parts.push(format!("[Ronic OS | Project: {}] {mcp_hint}", project_root.trim()));
        if let Some(view) = &view {
            let skills: Vec<_> = view
                .skills
                .iter()
                .filter(|s| in_index(s, &profile, capabilities::plugin_agent_on(&view.plugins, &s.plugin_id, &profile)))
                .collect();
            let mut attached_playbooks = Vec::new();
            for slug in selected_skills.iter().take(2) {
                if let Ok(body) = capabilities::load_skill_text(conn, home, &profile, slug) {
                    attached_playbooks.push(format!("--- Skill /{slug} ---\n{}", clip(&body, 1400)));
                }
            }
            if attached_playbooks.is_empty() && user_prompt.contains('/') {
                if let Some(body) = capabilities::playbook(user_prompt, &skills, &view.plugins, &profile) {
                    attached_playbooks.push(format!("--- Skill Playbook ---\n{}", clip(&body, 1400)));
                }
            }
            if !attached_playbooks.is_empty() {
                parts.push(attached_playbooks.join("\n\n"));
            }
        }
        if !attached_files.is_empty() {
            parts.push(format!("Focus files: {}", attached_files.join(", ")));
        }
        if !history_summary.trim().is_empty() {
            parts.push(format!("Prior context:\n{}", clip(history_summary.trim(), 500)));
        }
        parts.push(user_prompt.trim().to_string());
        return clip(&parts.join("\n\n"), 3600);
    }

    parts.push("[Ronic OS Workspace Bridge — Active]".into());
    if !project_root.trim().is_empty() {
        parts.push(format!("Project root: {}", project_root.trim()));
    }
    if bridge.port != 0 && !bridge.endpoint.is_empty() {
        parts.push(format!(
            "Local MCP server `ronic-os` is online at {} (tools: list_skills, load_skill, load_skill_file, list_plugins, list_mcp, list_memory, search_memory, save_memory, curate_memory, list_files, read_file, workspace_manifest, ronic_search_capabilities).",
            bridge.endpoint
        ));
    }
    parts.push(format!("Full workspace context file: {}", context_file.display()));

    if let Some(view) = view {
        let skills: Vec<_> = view
            .skills
            .iter()
            .filter(|s| in_index(s, &profile, capabilities::plugin_agent_on(&view.plugins, &s.plugin_id, &profile)))
            .collect();
        if !skills.is_empty() {
            let names: Vec<String> = skills.iter().take(25).map(|s| format!("{} ({})", s.slash_command, clip(&s.description, 60))).collect();
            parts.push(format!("Enabled Skills ({}): {}", skills.len(), names.join("; ")));
        }
        let plugins: Vec<_> = view
            .plugins
            .iter()
            .filter(|p| p.agent_enables.iter().any(|f| f.profile_id == profile && f.enabled))
            .collect();
        if !plugins.is_empty() {
            let names: Vec<String> = plugins.iter().take(15).map(|p| format!("{} v{}", p.name, p.version)).collect();
            parts.push(format!("Enabled Plugins ({}): {}", plugins.len(), names.join(", ")));
        }
        let mcps: Vec<_> = view
            .mcp_servers
            .iter()
            .filter(|m| m.enables.iter().any(|f| f.profile_id == profile && f.enabled))
            .collect();
        if !mcps.is_empty() {
            let names: Vec<String> = mcps.iter().take(15).map(|m| format!("{} ({})", m.name, m.transport)).collect();
            parts.push(format!("Enabled MCP Servers ({}): {}", mcps.len(), names.join(", ")));
        }
        let mut attached_playbooks = Vec::new();
        for slug in selected_skills.iter().take(3) {
            if let Ok(body) = capabilities::load_skill_text(conn, home, &profile, slug) {
                attached_playbooks.push(format!("--- Skill /{slug} ---\n{}", clip(&body, 1800)));
            }
        }
        if attached_playbooks.is_empty() {
            if let Some(body) = capabilities::playbook(user_prompt, &skills, &view.plugins, &profile) {
                attached_playbooks.push(format!("--- Matched Skill Playbook ---\n{}", clip(&body, 1800)));
            }
        }
        if !attached_playbooks.is_empty() {
            parts.push(attached_playbooks.join("\n\n"));
        }
    }

    if !attached_files.is_empty() {
        parts.push(format!("Focused project files: {}", attached_files.join(", ")));
    }
    if !history_summary.trim().is_empty() {
        parts.push(format!("Recent session context:\n{}", clip(history_summary.trim(), 1200)));
    }
    parts.push(format!("User task:\n{}", user_prompt.trim()));
    clip(&parts.join("\n\n"), 7500)
}

fn clip(text: &str, max_chars: usize) -> String {
    let count = text.chars().count();
    if count <= max_chars {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max_chars).collect();
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_tool_is_rejected_by_name() {
        assert!(!allowed("wallet_tx"));
        assert!(!allowed("run_sandbox"));
        assert!(allowed("list_skills"));
        assert!(allowed("save_memory"));
        assert!(allowed("workspace_webapp"));
        assert!(allowed("desktop_app"));
        assert!(!is_local_tool("workspace_webapp"));
        assert!(!is_local_tool("desktop_app"));
    }

    #[test]
    fn connector_form_is_not_the_chat_composer() {
        assert!(PAGE_SCRIPT.contains("op !== \"context\" && op !== \"mcp-url\""));
        assert!(PAGE_SCRIPT.contains("example.com/mcp"));
        assert!(PAGE_SCRIPT.contains("function connectorDialog"));
        assert!(PAGE_SCRIPT.contains("function connectorSurface"));
        assert!(PAGE_SCRIPT.contains("Fill MCP connector"));
        assert!(!PAGE_SCRIPT.contains("authHost(location.hostname || \"\") || pluginPage()"));
        assert!(PAGE_SCRIPT.contains("function stripPackFromComposer"));
        assert!(!PAGE_SCRIPT.contains("text + \"\\n\\n\" + pack"));
        assert!(!PAGE_SCRIPT.contains("composerBox() || document.querySelector(\"textarea"));
    }

    #[test]
    fn dock_tools_are_advertised_and_are_not_faked_inside_the_lock() {
        let defs = tool_defs();
        let names: Vec<&str> = defs
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|item| item.get("name").and_then(|name| name.as_str()))
            .collect();
        assert!(names.contains(&"workspace_webapp"));
        assert!(names.contains(&"desktop_app"));
        let conn = Connection::open_in_memory().unwrap();
        let web = call_tool(&conn, Path::new("."), "workspace_webapp", &json!({ "action": "open", "app": "chatgpt" })).unwrap_err();
        assert!(!web.to_ascii_lowercase().contains("completed"), "{web}");
        let desk = call_tool(&conn, Path::new("."), "desktop_app", &json!({ "action": "open", "app": "cursor" })).unwrap_err();
        assert!(!desk.to_ascii_lowercase().contains("completed"), "{desk}");
    }

    #[test]
    fn page_outbox_hosts_are_chat_sites() {
        assert!(chat_page_host("chatgpt.com"));
        assert!(chat_page_host("claude.ai"));
        assert!(chat_page_host("gemini.google.com"));
        assert!(chat_page_host("grok.com"));
        assert!(chat_page_host("x.com"));
        assert!(chat_page_host("twitter.com"));
        assert!(chat_page_host("perplexity.ai"));
        assert!(chat_page_host("deepseek.com"));
        assert!(!chat_page_host("example.com"));
        assert!(!chat_page_host("localhost"));
        assert!(!chat_page_host("amazonaws.com"));
        assert!(!chat_page_host("app.slack.com"));
    }

    #[test]
    fn slack_login_is_a_session_and_not_a_composer_injection() {
        assert!(channel_host("app.slack.com"));
        assert!(channel_host("acme.slack.com"));
        assert!(channel_host("discord.com"));
        assert!(channel_host("teams.microsoft.com"));
        assert!(channel_host("mail.google.com"));
        assert!(session_page_host("app.slack.com"));
        assert!(session_page_host("github.com"));
        assert!(session_page_host("supabase.com"));
        assert!(!session_page_host("accounts.google.com"));
        assert!(!chat_page_host("app.slack.com"));
        let pack = "[Ronic OS connection]\nProject folder: C:\\work\\Omni";
        let prompt = "connect the gateway to this slack workspace";
        assert_eq!(inject_composer_text("app.slack.com", pack, prompt), prompt);
        assert_eq!(inject_composer_text("discord.com", pack, prompt), prompt);
        assert_eq!(inject_composer_text("outlook.office.com", pack, prompt), prompt);
        let injected = inject_composer_text("chatgpt.com", pack, prompt);
        assert!(injected.starts_with(prompt));
        assert!(injected.contains("[Ronic OS connection]"));
        let site = inject_composer_text("supabase.com", pack, "read the listings policies in schema.sql");
        assert!(site.contains("[Ronic OS connection]"), "{site}");
        let github = inject_composer_text("github.com", pack, prompt);
        assert!(github.contains("[Ronic OS connection]"), "{github}");
        assert_eq!(inject_composer_text("chatgpt.com", pack, &injected), injected.trim());
        assert_eq!(inject_composer_text("chatgpt.com", pack, "hunter2"), "hunter2");
        assert_eq!(inject_composer_text("supabase.com", pack, "user@example.com"), "user@example.com");
    }

    #[test]
    fn injection_brief_names_the_project_and_signed_in_hosts() {
        let dir = std::env::temp_dir().join(format!("ronic-inject-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("webapp-auth.json"),
            r#"{"slack":{"signedIn":true,"host":"app.slack.com"},"chatgpt":{"signedIn":true,"host":"chatgpt.com"},"off":{"signedIn":false,"host":"claude.ai"}}"#,
        )
        .unwrap();
        let brief = format_injection_brief(r"C:\Users\haris\OneDrive\Desktop\Omni Workspace OS", &dir);
        assert!(brief.contains(r"C:\Users\haris\OneDrive\Desktop\Omni Workspace OS"));
        assert!(brief.contains("app.slack.com"));
        assert!(brief.contains("chatgpt.com"));
        assert!(!brief.contains("claude.ai"));
        assert!(brief.contains("list_files"));
        assert!(brief.contains("supabase/schema.sql"));
        assert!(brief.contains("not limited to Slack"));
        assert!(brief.contains("Do not ask the user to attach the project folder"));
        let footer = injection_footer(r"C:\Users\haris\OneDrive\Desktop\Omni Workspace OS", &dir);
        assert!(footer.contains("every tool, not only Slack"));
        assert!(footer.contains("supabase/schema.sql"));
        let hosts = signed_in_hosts(&dir);
        assert_eq!(hosts, vec!["app.slack.com".to_string(), "chatgpt.com".to_string()]);
        let empty = format_injection_brief("", &dir);
        assert!(empty.contains("Project folder: none"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn absolute_project_path_is_a_relative_read() {
        let dir = std::env::temp_dir().join(format!("ronic-proj-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::write(dir.join("src").join("gateway.rs"), "fn gateway() {}").unwrap();
        let root = dir.canonicalize().unwrap();
        let file = root.join("src").join("gateway.rs");
        assert_eq!(rel_inside_root(&root, &file.to_string_lossy()), Some("src/gateway.rs".into()));
        assert_eq!(rel_inside_root(&root, &root.to_string_lossy()), Some("".into()));
        let outside = std::env::temp_dir().join(format!("ronic-out-{}", std::process::id()));
        fs::create_dir_all(&outside).unwrap();
        assert!(rel_inside_root(&root, &outside.canonicalize().unwrap().to_string_lossy()).is_none());
        let secret = root.join(".env");
        fs::write(&secret, "TOKEN=1").unwrap();
        assert!(rel_inside_root(&root, &secret.canonicalize().unwrap().to_string_lossy()).is_none());
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&outside);
    }

    #[test]
    fn bot_browser_labels_record_a_login() {
        assert_eq!(auth_record_id("webapp_slack").as_deref(), Some("slack"));
        assert_eq!(auth_record_id("ronic_mini_comp_bot_spidy_chrome").as_deref(), Some("bot-bot_spidy"));
        assert_eq!(auth_record_id("ronic_squad_comp_bot_spidy").as_deref(), Some("squad-bot_spidy"));
        assert!(auth_record_id("main").is_none());
    }

    #[test]
    fn upsert_keeps_other_servers() {
        let dir = std::env::temp_dir().join(format!("ronic-bridge-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("mcp.json");
        fs::write(&path, r#"{"mcpServers":{"other":{"url":"http://example"}},"keep":true}"#).unwrap();
        let entry = json!({"type":"http","url":"http://127.0.0.1:1/mcp"});
        assert_eq!(upsert_mcp(&path, &entry, true).unwrap(), true);
        let saved: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(saved["keep"], true);
        assert_eq!(saved["mcpServers"]["other"]["url"], "http://example");
        assert_eq!(saved["mcpServers"]["ronic-os"]["url"], "http://127.0.0.1:1/mcp");
        assert_eq!(upsert_mcp(&path, &entry, true).unwrap(), false);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn client_config_shapes_match_each_app() {
        let headers = json!({ "Authorization": "Bearer secret" });
        let gemini = gemini_http_entry("http://127.0.0.1:9/mcp", &headers);
        assert_eq!(gemini["httpUrl"], "http://127.0.0.1:9/mcp");
        assert!(gemini.get("url").is_none(), "{gemini}");
        assert!(gemini.get("type").is_none(), "{gemini}");
        assert_eq!(gemini["headers"]["Authorization"], "Bearer secret");

        let dir = std::env::temp_dir().join(format!("ronic-vscode-shape-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("mcp.json");
        fs::write(
            &path,
            r#"{"mcpServers":{"other":{"url":"http://example"}},"servers":{"keep":{"type":"stdio","command":"code"}}}"#,
        )
        .unwrap();
        let entry = json!({"type":"http","url":"http://127.0.0.1:9/mcp","headers":{"Authorization":"Bearer secret"}});
        assert!(upsert_mcp_map(&path, "servers", &entry, true).unwrap());
        let saved: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(saved["mcpServers"]["other"]["url"], "http://example");
        assert!(saved["mcpServers"].get("ronic-os").is_none(), "{saved}");
        assert_eq!(saved["servers"]["keep"]["command"], "code");
        assert_eq!(saved["servers"]["ronic-os"]["type"], "http");
        assert_eq!(saved["servers"]["ronic-os"]["url"], "http://127.0.0.1:9/mcp");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn invalid_json_is_not_replaced() {
        let dir = std::env::temp_dir().join(format!("ronic-bridge-bad-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("claude.json");
        fs::write(&path, "not json").unwrap();
        let error = upsert_mcp(&path, &json!({"type":"http"}), true).unwrap_err();
        assert!(error.contains("left unchanged"));
        assert_eq!(fs::read_to_string(&path).unwrap(), "not json");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn bearer_check_matches_the_token_only() {
        let headers = vec![("Authorization".into(), "Bearer secret".into())];
        assert!(authorized("secret", "/mcp", &headers));
        assert!(!authorized("other", "/mcp", &headers));
        assert!(authorized("secret", "/mcp?token=secret", &[]));
        assert!(!authorized("secret", "/mcp", &[]));
    }

    #[test]
    fn attachment_allowlist_blocks_everything_when_empty() {
        // No attachments this turn -> no absolute path is reachable, whatever
        // it is. MCP bridge and code mode always run with an empty list.
        let target = PathBuf::from("C:\\Users\\haris\\Desktop\\notes.txt");
        assert!(!attachments_allow(&target, &[]));
    }

    #[test]
    fn attachment_allowlist_matches_attached_file_and_folder() {
        let dir = std::env::temp_dir().join(format!("ronic-attach-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("spec.txt");
        fs::write(&file, "reference").unwrap();
        let canon = file.canonicalize().unwrap();
        let attached = vec![file.to_string_lossy().to_string()];
        // Exact attached file is reachable.
        assert!(attachments_allow(&canon, &attached));
        // A sibling the user did not attach is not.
        let sibling = dir.join("other.txt");
        fs::write(&sibling, "nope").unwrap();
        assert!(!attachments_allow(&sibling.canonicalize().unwrap(), &attached));
        // When the *folder* was attached, files inside it are reachable.
        let folder_attached = vec![dir.to_string_lossy().to_string()];
        assert!(attachments_allow(&sibling.canonicalize().unwrap(), &folder_attached));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn memory_sheets_stay_inside_their_folder() {
        let dir = std::env::temp_dir().join(format!("ronic-sheets-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("memories").join("notes")).unwrap();
        let note = dir.join("memories").join("notes").join("a.md");
        fs::write(&note, "fact").unwrap();
        let root = dir.join("memories");
        assert!(under_memory_root(&note.canonicalize().unwrap(), &root));
        let db = dir.join("state.db");
        fs::write(&db, "x").unwrap();
        assert!(!under_memory_root(&db.canonicalize().unwrap(), &root));
        let link = dir.join("linked-memories");
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_dir(&root, &link);
        #[cfg(not(windows))]
        let linked = std::os::unix::fs::symlink(&root, &link);
        if linked.is_ok() {
            assert!(!under_memory_root(&note.canonicalize().unwrap(), &link));
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn harness_mcp_sync_preserves_user_servers_and_adds_enabled_ronics() {
        let dir = std::env::temp_dir().join(format!("ronic-harness-sync-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        fs::write(&path, r#"{"mcpServers":{"custom":{"httpUrl":"http://keep.local"},"ronic-os":{"httpUrl":"http://old"}}}"#).unwrap();
        let ronic = json!({"httpUrl":"http://127.0.0.1:47331/mcp","headers":{"Authorization":"Bearer tok"}});
        let extras = vec![
            ("custom".into(), json!({"httpUrl":"http://should-not-overwrite"})),
            ("github".into(), json!({"command":"npx","args":["-y","@modelcontextprotocol/server-github"]})),
        ];
        let synced = upsert_harness_mcp_json(&path, "mcpServers", &ronic, &extras, true).unwrap();
        assert!(synced.contains(&"ronic-os".to_string()));
        assert!(synced.contains(&"github".to_string()));
        let saved: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(saved["mcpServers"]["ronic-os"]["httpUrl"], "http://127.0.0.1:47331/mcp");
        assert_eq!(saved["mcpServers"]["custom"]["httpUrl"], "http://keep.local");
        assert_eq!(saved["mcpServers"]["github"]["command"], "npx");

        let codex = dir.join("config.toml");
        assert!(upsert_codex_mcp_toml(&codex, "http://127.0.0.1:47331/mcp", "tok1").unwrap());
        let first = fs::read_to_string(&codex).unwrap();
        assert!(first.contains("tok1"));
        assert!(upsert_codex_mcp_toml(&codex, "http://127.0.0.1:47331/mcp", "tok2").unwrap());
        let second = fs::read_to_string(&codex).unwrap();
        assert!(second.contains("tok2") && !second.contains("tok1"));

        assert!(is_agy_binary(r"C:\Users\haris\.gemini\bin\agy.exe"));
        assert!(!is_agy_binary(r"C:\Users\haris\AppData\Roaming\npm\gemini.cmd"));
        let _ = fs::remove_dir_all(&dir);
    }
}
