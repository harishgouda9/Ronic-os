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
            "serverInfo": { "name": "omni-workspace", "version": "2.1.4" },
            "instructions": instructions()
        })),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tool_defs() })),
        "tools/call" => {
            let name = body.pointer("/params/name").and_then(|value| value.as_str()).unwrap_or("");
            let args = body.pointer("/params/arguments").cloned().unwrap_or_else(|| json!({}));
            if name == "omni_execute_codemode" {
                let script = crate::code_mode::script_arg(&args);
                let home = bridge_home(app);
                match crate::code_mode::execute(&home, &script) {
                    Ok(result) => Ok(json!({ "content": [{ "type": "text", "text": result.final_return_json }], "isError": !result.ok })),
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
    call_tool(conn, &home, name, args)
}

pub(crate) fn is_local_tool(name: &str) -> bool {
    allowed(name) && name != "omni_execute_codemode"
}

pub(crate) fn call_tool(conn: &Connection, home: &Path, name: &str, args: &Value) -> Result<String, String> {
    let name = name.trim();
    if !allowed(name) {
        return Err("That tool is not on the Ronic OS bridge. Use list_skills, load_skill, load_skill_file, list_plugins, list_memory, search_memory, save_memory, list_files, read_file, list_mcp, list_providers, list_threads, skill_manage, workspace_manifest, omni_search_capabilities, omni_execute_codemode, or omni_ask_peer_app.".into());
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
        "save_memory" => save_memory(conn, &profile, arg(args, "title"), first_arg(args, &["content", "contentMarkdown"])),
        "list_providers" => Ok(list_providers(conn)),
        "list_threads" => Ok(list_threads(conn, &profile)),
        "list_files" => list_files(conn, arg(args, "path")),
        "read_file" => read_project_file(conn, first_arg(args, &["path", "file"])),
        "list_mcp" => Ok(list_mcp_text(conn, home, &profile)),
        "skill_manage" => skill_manage(conn, home, &profile, arg(args, "slug"), arg(args, "description"), first_arg(args, &["body", "content"])),
        "omni_search_capabilities" => Ok(crate::code_mode::search_capabilities(conn, home, first_arg(args, &["query", "query_js"])).to_string()),
        "omni_ask_peer_app" => {
            let value = crate::mcp_acp_automesh::ask_peer(conn, home, "mcp", first_arg(args, &["target", "target_app_id"]), first_arg(args, &["task", "task_prompt", "prompt"]))?;
            Ok(value.to_string())
        }
        "omni_execute_codemode" => Err("Code Mode runs outside the database lock. Call execute_code_mode_script.".into()),
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
            | "list_providers"
            | "list_threads"
            | "list_files"
            | "read_file"
            | "list_mcp"
            | "skill_manage"
            | "omni_search_capabilities"
            | "omni_ask_peer_app"
            | "omni_execute_codemode"
    )
}

fn context_block(conn: &Connection, home: &Path, user_text: &str) -> String {
    let user_text = user_text.trim();
    if user_text.starts_with("[Omni tool result]") {
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
    let mut lines = vec![
        "[Ronic OS connection]".into(),
        "This chat is running inside Ronic OS on the user's computer. You are connected to the local workspace and can use its skills, plugins, and memory. The lists below are live. Do not say you cannot access the workspace, its skills, its plugins, or its memory.".into(),
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
    lines.push("This attached block is the connection. A website cannot run Ronic OS tools from the page, and it cannot open the local MCP port. Use the Ronic OS chat or the signed local MCP server for tools. Tools on that server: load_skill (slug), load_skill_file (slug, path), list_skills, list_plugins, list_memory, search_memory (query), save_memory (title, content), list_files (path), read_file (path), list_mcp, skill_manage (slug, description, body), list_providers, list_threads, workspace_manifest, omni_search_capabilities (query), omni_ask_peer_app (target, task). save_memory writes the Memory screen. skill_manage waits for approval and does not write the file. omni_ask_peer_app stores a ticket and does not launch the other app.".into());
    if let Some(skill) = mentioned(&skills, user_text) {
        lines.push(format!("Skill playbook for this turn:\n{}", clip(&skill.body, 2500)));
    }
    clip(&lines.join("\n"), PACK_LIMIT)
}

fn mentioned<'a>(skills: &[&'a crate::models::Skill], text: &str) -> Option<&'a crate::models::Skill> {
    let lower = text.to_lowercase();
    if lower.is_empty() {
        return None;
    }
    let token = lower.split_whitespace().next().unwrap_or("");
    skills.iter().copied().find(|skill| {
        let slash = skill.slash_command.to_lowercase();
        if !slash.is_empty() && (token == slash || lower.contains(&slash)) {
            return true;
        }
        let slug = skill.slug.to_lowercase();
        slug.len() >= 4 && lower.contains("skill") && lower.contains(&slug)
    })
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
    let rows = memory_rows(conn, "SELECT title, content_markdown FROM memory_items ORDER BY updated_at DESC LIMIT 30", params![]);
    if rows.is_empty() { "No memories saved yet.".into() } else { rows.into_iter().map(|(title, body)| format!("# {title}\n{}", clip(&body, 500))).collect::<Vec<_>>().join("\n\n") }
}

fn search_memory(conn: &Connection, query: &str) -> String {
    let query = query.trim();
    if query.is_empty() {
        return latest_memory(conn);
    }
    let like = format!("%{}%", query.to_lowercase().replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
    let rows = memory_rows(conn, "SELECT title, content_markdown FROM memory_items WHERE lower(title) LIKE ?1 ESCAPE '\\' OR lower(content_markdown) LIKE ?1 ESCAPE '\\' ORDER BY updated_at DESC LIMIT 12", params![like]);
    if rows.is_empty() {
        latest_memory(conn)
    } else {
        rows.into_iter().map(|(title, body)| format!("- {title}: {}", clip(&redact(&body), 180))).collect::<Vec<_>>().join("\n")
    }
}

fn latest_memory(conn: &Connection) -> String {
    let rows = memory_rows(conn, "SELECT title, content_markdown FROM memory_items ORDER BY updated_at DESC LIMIT 4", params![]);
    if rows.is_empty() { "None saved.".into() } else { rows.into_iter().map(|(title, body)| format!("- {title}: {}", clip(&redact(&body), 180))).collect::<Vec<_>>().join("\n") }
}

fn memory_rows(conn: &Connection, sql: &str, args: impl rusqlite::Params) -> Vec<(String, String)> {
    let Ok(mut stmt) = conn.prepare(sql) else { return Vec::new() };
    stmt.query_map(args, |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))).map(|rows| rows.flatten().collect()).unwrap_or_default()
}

fn memory_count(conn: &Connection) -> i64 {
    conn.query_row("SELECT COUNT(*) FROM memory_items", [], |row| row.get(0)).unwrap_or(0)
}

fn save_memory(conn: &Connection, profile: &str, title: &str, content: &str) -> Result<String, String> {
    let title = title.trim();
    let content = content.trim();
    if title.is_empty() || content.is_empty() {
        return Err("save_memory needs a title and content.".into());
    }
    if title.chars().count() > 200 || content.chars().count() > 8000 {
        return Err("That memory is too long.".into());
    }
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|time| time.as_secs()).unwrap_or(0);
    {
        let mut shared = SHARED.lock().unwrap_or_else(|poison| poison.into_inner());
        if now.saturating_sub(shared.saves.0) > 60 {
            shared.saves = (now, 0);
        }
        if shared.saves.1 >= 30 {
            return Err("Too many memories were saved in the last minute.".into());
        }
        shared.saves.1 += 1;
    }
    let saved = memory::remember(conn, &MemoryInput {
        id: None,
        title: title.into(),
        content_markdown: content.into(),
        source_type: "harness".into(),
        scoped_bot_id: if profile.is_empty() { None } else { Some(profile.to_string()) },
        file_path_or_uri: String::new(),
        engine_id: None,
    }).map_err(|error| error.0)?;
    Ok(format!("{}. It is on the Memory screen.", saved.note))
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

fn list_files(conn: &Connection, rel: &str) -> Result<String, String> {
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

pub(crate) fn read_attachment(conn: &Connection, raw: &str) -> Result<String, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("No file was attached.".into());
    }
    let root = project_dir(conn)?;
    let path = PathBuf::from(raw);
    let canon = if path.is_absolute() {
        path.canonicalize().map_err(|_| "That file is not in the project.".to_string())?
    } else {
        project_file(conn, raw)?
    };
    if !canon.starts_with(&root) {
        return Err("That path stays inside the project folder.".into());
    }
    if canon.components().any(|part| blocked_name(&part.as_os_str().to_string_lossy())) {
        return Err("That file is not available on this connection.".into());
    }
    if canon.is_dir() {
        return Err("That path is a folder.".into());
    }
    let meta = fs::metadata(&canon).map_err(|_| "That file could not be read.".to_string())?;
    if meta.len() > 200_000 {
        return Err("That file is too large for this chat.".into());
    }
    let bytes = fs::read(&canon).map_err(|_| "That file could not be read.".to_string())?;
    if bytes.contains(&0) {
        return Err("That file is not text.".into());
    }
    let text = String::from_utf8_lossy(&bytes);
    Ok(clip(&redact(&text), 8000))
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
    "You are connected to Ronic OS on this computer. Use these tools for its skills, plugins, memory, and project files. Do not say you cannot access the workspace. save_memory writes the Memory screen. skill_manage proposes a skill and waits for approval. read_file stays inside the project folder. Shell, wallet, and API keys are not available. omni_search_capabilities and omni_execute_codemode are the Code Mode surface. omni_ask_peer_app stores a ticket for another app and does not launch it."
}

fn tool_defs() -> Value {
    json!([
        { "name": "workspace_manifest", "description": "Live Ronic OS skill index, plugins, memory, and tasks.", "inputSchema": { "type": "object", "properties": { "text": { "type": "string" } } } },
        { "name": "list_skills", "description": "List the skill index for the active Ronic OS profile.", "inputSchema": { "type": "object", "properties": {} } },
        { "name": "load_skill", "description": "Load one SKILL.md playbook from the active profile.", "inputSchema": { "type": "object", "properties": { "slug": { "type": "string" } }, "required": ["slug"] } },
        { "name": "load_skill_file", "description": "Load one supporting reference or script from a skill.", "inputSchema": { "type": "object", "properties": { "slug": { "type": "string" }, "path": { "type": "string" } }, "required": ["slug", "path"] } },
        { "name": "list_plugins", "description": "List installed Ronic OS plugins.", "inputSchema": { "type": "object", "properties": {} } },
        { "name": "list_memory", "description": "List workspace memories.", "inputSchema": { "type": "object", "properties": {} } },
        { "name": "search_memory", "description": "Search memory titles and body text.", "inputSchema": { "type": "object", "properties": { "query": { "type": "string" } }, "required": ["query"] } },
        { "name": "save_memory", "description": "Save a memory onto the Ronic OS Memory screen.", "inputSchema": { "type": "object", "properties": { "title": { "type": "string" }, "content": { "type": "string" } }, "required": ["title", "content"] } },
        { "name": "list_files", "description": "List files and folders inside the Ronic OS project folder. Pass path as empty for the project root.", "inputSchema": { "type": "object", "properties": { "path": { "type": "string" } } } },
        { "name": "read_file", "description": "Read a text file inside the Ronic OS project folder. Secrets in the text are redacted.", "inputSchema": { "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"] } },
        { "name": "list_mcp", "description": "List MCP servers configured in Ronic OS. This does not start them.", "inputSchema": { "type": "object", "properties": {} } },
        { "name": "list_providers", "description": "List provider names and health. Secrets are not included.", "inputSchema": { "type": "object", "properties": {} } },
        { "name": "list_threads", "description": "List task titles for the active profile.", "inputSchema": { "type": "object", "properties": {} } },
        { "name": "skill_manage", "description": "Propose a skill. It waits for approval and does not write the file.", "inputSchema": { "type": "object", "properties": { "slug": { "type": "string" }, "description": { "type": "string" }, "body": { "type": "string" } }, "required": ["slug", "body"] } },
        { "name": "omni_search_capabilities", "description": "Filter saved MCP tools, skills, and local bridge tools by a short query.", "inputSchema": { "type": "object", "properties": { "query": { "type": "string" } }, "required": ["query"] } },
        { "name": "omni_execute_codemode", "description": "Run one TypeScript block whose await omni.* calls go through the local gateway.", "inputSchema": { "type": "object", "properties": { "script": { "type": "string" } }, "required": ["script"] } },
        { "name": "omni_ask_peer_app", "description": "Queue a task for another mesh app. This does not launch that app or edit files.", "inputSchema": { "type": "object", "properties": { "target": { "type": "string" }, "task": { "type": "string" } }, "required": ["target", "task"] } }
    ])
}

fn watched_views(app: &AppHandle) -> Vec<tauri::Webview> {
    let mut views = Vec::new();
    for (label, view) in app.webviews() {
        if label.starts_with("webapp_")
            || label.starts_with("omni_webapp_")
            || label.starts_with("harness_")
        {
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
            if label.starts_with("harness_") || label.starts_with("omni_webapp_") {
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
        let views: Vec<_> = views.into_iter().filter(chat_page_view).collect();
        if views.is_empty() {
            continue;
        }
        if tick % 16 == 0 {
            if let Some(pack) = with_db(&app, |conn, home| context_block(conn, home, "")) {
                let literal = serde_json::to_string(&pack).unwrap_or_else(|_| "\"\"".into());
                let script = format!("window.__OMNI_CACHE={literal}");
                for view in &views {
                    let _ = view.eval(&script);
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

const DRAIN: &str = "(function(){var box=window.__OMNI_OUTBOX||[];window.__OMNI_OUTBOX=[];return box;})()";

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

fn chat_page_view(view: &tauri::Webview) -> bool {
    let Ok(url) = view.url() else { return false };
    if chat_page_url(&url) {
        return true;
    }
    let label = view.label();
    if label.starts_with("webapp_custom_") || label.starts_with("omni_webapp_custom_") {
        let host = url.host_str().unwrap_or("");
        return !is_auth_host(host);
    }
    false
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
            let _ = app.emit("omni://webapp-auth-changed", serde_json::json!({
                "label": label,
                "host": host,
                "signedIn": signed_in
            }));
            save_webapp_auth(&bridge_home(app), label, host, signed_in);
            continue;
        }
        if op != "context" {
            let refusal = "Embedded pages cannot run Ronic OS tools. Use the Ronic OS chat or the signed MCP bridge.";
            let literal = serde_json::to_string(refusal).unwrap_or_else(|_| "\"\"".into());
            calls.push_str(&format!("window.__OMNI_DELIVER&&window.__OMNI_DELIVER({id},{literal});"));
            continue;
        }
        let answer = page_request(app, op, text);
        let literal = serde_json::to_string(&answer).unwrap_or_else(|_| "\"\"".into());
        calls.push_str(&format!("window.__OMNI_DELIVER&&window.__OMNI_DELIVER({id},{literal});"));
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
fn save_webapp_auth(home: &Path, label: &str, host: &str, signed_in: bool) {
    let Some(id) = label.strip_prefix("omni_webapp_").or_else(|| label.strip_prefix("webapp_")) else {
        return;
    };
    let id = id.trim_end_matches("_web");
    if id.is_empty() {
        return;
    }
    let path = home.join("webapp-auth.json");
    let mut root: Value = fs::read_to_string(&path).ok().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_else(|| json!({}));
    if !root.is_object() {
        root = json!({});
    }
    let existing = root.get(id).cloned().unwrap_or(Value::Null);
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
    let reason = match status {
        200 => "OK",
        202 => "Accepted",
        204 => "No Content",
        401 => "Unauthorized",
        404 => "Not Found",
        405 => "Method Not Allowed",
        _ => "Error",
    };
    let header = format!("HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: *\r\n\r\n", body.len());
    stream.write_all(header.as_bytes())?;
    if !body.is_empty() {
        stream.write_all(body)?;
    }
    let _ = stream.flush();
    Ok(())
}

fn bridge_home(app: &AppHandle) -> PathBuf {
    app.try_state::<AppState>().map(|state| state.home.clone()).unwrap_or_else(|| user_home().join(".omniworkspace"))
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
}

fn register_clients(port: u16, token: &str) -> (Vec<String>, String) {
    let url = format!("http://127.0.0.1:{port}/mcp");
    let headers = json!({ "Authorization": format!("Bearer {token}") });
    let claude = json!({ "type": "http", "url": &url, "headers": &headers });
    let gemini = json!({ "type": "http", "url": &url, "httpUrl": &url, "headers": &headers });
    let cursor = json!({ "url": &url, "headers": &headers });
    let home = user_home();
    let mut files = vec![
        ClientFile { label: "Claude Code", path: home.join(".claude.json"), create: true, entry: claude.clone() },
        ClientFile { label: "Gemini CLI", path: home.join(".gemini").join("settings.json"), create: true, entry: gemini },
        ClientFile { label: "Cursor", path: home.join(".cursor").join("mcp.json"), create: true, entry: cursor },
    ];
    if let Some(appdata) = std::env::var_os("APPDATA") {
        let code = PathBuf::from(&appdata).join("Code").join("User");
        if code.is_dir() {
            files.push(ClientFile { label: "VS Code", path: code.join("mcp.json"), create: true, entry: claude.clone() });
        }
        let desktop = PathBuf::from(appdata).join("Claude");
        if desktop.is_dir() {
            files.push(ClientFile { label: "Claude Desktop", path: desktop.join("claude_desktop_config.json"), create: true, entry: claude.clone() });
        }
    }
    let mut clients = Vec::new();
    let mut problems = Vec::new();
    for file in files {
        match upsert_mcp(&file.path, &file.entry, file.create) {
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
    let servers = root.as_object_mut().unwrap().entry("mcpServers").or_insert_with(|| json!({}));
    if !servers.is_object() {
        return Err(format!("mcpServers in {} is not an object, so it was left unchanged", path.display()));
    }
    let current = servers.get("omni-workspace");
    if current == Some(entry) {
        return Ok(false);
    }
    servers.as_object_mut().unwrap().insert("omni-workspace".into(), entry.clone());
    write_json(path, &root)
}

fn write_json(path: &Path, value: &Value) -> Result<bool, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    let tmp = path.with_extension("omni-tmp");
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
    }

    #[test]
    fn upsert_keeps_other_servers() {
        let dir = std::env::temp_dir().join(format!("omni-bridge-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("mcp.json");
        fs::write(&path, r#"{"mcpServers":{"other":{"url":"http://example"}},"keep":true}"#).unwrap();
        let entry = json!({"type":"http","url":"http://127.0.0.1:1/mcp"});
        assert_eq!(upsert_mcp(&path, &entry, true).unwrap(), true);
        let saved: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(saved["keep"], true);
        assert_eq!(saved["mcpServers"]["other"]["url"], "http://example");
        assert_eq!(saved["mcpServers"]["omni-workspace"]["url"], "http://127.0.0.1:1/mcp");
        assert_eq!(upsert_mcp(&path, &entry, true).unwrap(), false);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn invalid_json_is_not_replaced() {
        let dir = std::env::temp_dir().join(format!("omni-bridge-bad-{}", std::process::id()));
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
}
