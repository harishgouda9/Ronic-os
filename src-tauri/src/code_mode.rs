//! Cloudflare-style Code Mode on top of the local MCP bridge.
//!
//! The model sees a compact `ronic.d.ts` and writes one TypeScript block.
//! Host v2 interprets that block in-process: `await ronic.*`, if/else,
//! comparisons, `??`, bounded for-of, template strings, and array callbacks.
//! User JavaScript is never evaluated in Node or Bun. Remote MCP keys stay in the vault.

mod interp;

use crate::capabilities::{self, in_index};
use crate::db;
use crate::mcp_acp_automesh;
use crate::redact::redact;

use crate::workspace_bridge;
use crate::AppState;
use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::{json, Value};
use std::path::Path;
use std::time::{Duration, Instant};
use tauri::{AppHandle, State};

const MAX_SCRIPT: usize = 12_000;
const MAX_RPC: usize = 24;
const MAX_RETURN: usize = 12_000;
const WORKER: &str = "host-v2";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeModeSpecBundle {
    pub token_count_estimate: u32,
    pub raw_mcp_schema_tokens: u32,
    pub typescript_dts: String,
    pub skill_count: u32,
    pub server_count: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeModeExecutionResult {
    pub ok: bool,
    pub execution_ms: u32,
    pub rpc_calls: Vec<String>,
    pub final_return_json: String,
    pub dts_tokens: u32,
    pub raw_schema_tokens: u32,
    pub worker: String,
}

#[derive(Clone)]
struct SurfaceServer {
    ident: String,
    name: String,
    tools: Vec<String>,
}

struct Surface {
    dts: String,
    dts_tokens: u32,
    raw_tokens: u32,
    skill_count: u32,
    server_count: u32,
    servers: Vec<SurfaceServer>,
}

pub fn compile(conn: &Connection, home: &Path) -> CodeModeSpecBundle {
    let surface = surface(conn, home);
    CodeModeSpecBundle {
        token_count_estimate: surface.dts_tokens,
        raw_mcp_schema_tokens: surface.raw_tokens,
        typescript_dts: surface.dts,
        skill_count: surface.skill_count,
        server_count: surface.server_count,
    }
}

pub fn execute(home: &Path, ts_code: &str) -> Result<CodeModeExecutionResult, String> {
    execute_with(home, ts_code, None)
}

pub fn execute_with(home: &Path, ts_code: &str, app: Option<&AppHandle>) -> Result<CodeModeExecutionResult, String> {
    let script = ts_code.trim();
    if script.is_empty() {
        return Err("Code Mode needs a TypeScript block.".into());
    }
    if script.chars().count() > MAX_SCRIPT {
        return Err("That Code Mode script is too long.".into());
    }
    if let Some(reason) = script_blocked(script) {
        return Err(format!("Code Mode refused this script: {reason}"));
    }
    if !mcp_acp_automesh::code_mode_enabled(home) {
        return Err("Code Mode is off. Turn it on in the Dock or the mesh studio.".into());
    }
    let started = Instant::now();
    let conn = db::open(&home.join("state.db")).map_err(|error| error.0)?;
    let surface = surface(&conn, home);
    let servers: Vec<(String, String)> = surface.servers.iter().map(|server| (server.ident.clone(), server.name.clone())).collect();
    let mut calls = Vec::new();
    let mut dispatch_fn = |method: &str, args: &Value| {
        if calls.len() >= MAX_RPC {
            return Err("too many ronic calls".into());
        }
        calls.push(method.to_string());
        dispatch(&conn, home, app, method, args)
    };
    let value = match interp::eval(script, &mut dispatch_fn, &servers) {
        Ok(value) => value,
        Err(error) => {
            return Ok(CodeModeExecutionResult {
                ok: false,
                execution_ms: started.elapsed().as_millis().min(u128::from(u32::MAX)) as u32,
                rpc_calls: calls,
                final_return_json: clip(&error, MAX_RETURN),
                dts_tokens: surface.dts_tokens,
                raw_schema_tokens: surface.raw_tokens,
                worker: WORKER.into(),
            });
        }
    };
    let final_json = match serde_json::to_string_pretty(&value) {
        Ok(formatted) => clip(&formatted, MAX_RETURN),
        Err(_) => clip(&value.to_string(), MAX_RETURN),
    };
    Ok(CodeModeExecutionResult {
        ok: true,
        execution_ms: started.elapsed().as_millis().min(u128::from(u32::MAX)) as u32,
        rpc_calls: calls,
        final_return_json: final_json,
        dts_tokens: surface.dts_tokens,
        raw_schema_tokens: surface.raw_tokens,
        worker: WORKER.into(),
    })
}

pub fn search_capabilities(conn: &Connection, home: &Path, query: &str) -> Value {
    let needle = query_needle(query);
    let mut rows = Vec::new();
    for (server, tool, signature) in capability_rows(conn, home) {
        if needle.is_empty() || server.to_lowercase().contains(&needle) || tool.to_lowercase().contains(&needle) || signature.to_lowercase().contains(&needle) {
            rows.push(json!({ "server": server, "tool": tool, "signature": signature }));
        }
        if rows.len() >= 40 {
            break;
        }
    }
    Value::Array(rows)
}

#[tauri::command]
pub async fn compile_mcp_acp_to_typescript_dts(state: State<'_, AppState>) -> Result<CodeModeSpecBundle, String> {
    let conn = state.conn.lock().unwrap_or_else(|poison| poison.into_inner());
    Ok(compile(&conn, &state.home))
}

#[tauri::command]
pub async fn execute_code_mode_script(app: AppHandle, state: State<'_, AppState>, ts_script: String) -> Result<CodeModeExecutionResult, String> {
    let home = state.home.clone();
    match tauri::async_runtime::spawn_blocking(move || execute_with(&home, &ts_script, Some(&app))).await {
        Ok(result) => result,
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
pub async fn ronic_search_capabilities(state: State<'_, AppState>, query: String) -> Result<Value, String> {
    let conn = state.conn.lock().unwrap_or_else(|poison| poison.into_inner());
    Ok(search_capabilities(&conn, &state.home, &query))
}

pub fn script_arg(args: &Value) -> String {
    for key in ["script", "ts", "code", "ts_script", "tsScript"] {
        if let Some(text) = args.get(key).and_then(|value| value.as_str()) {
            if !text.trim().is_empty() {
                return text.to_string();
            }
        }
    }
    String::new()
}

pub fn script_blocked(script: &str) -> Option<&'static str> {
    let masked = mask_strings_and_comments(script);
    if masked.contains("node:fs") {
        return Some("filesystem access");
    }
    if masked.contains("node:child_process") {
        return Some("process spawn");
    }
    let chars: Vec<char> = masked.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c.is_ascii_alphabetic() || c == '_' || c == '$' {
            let start = i;
            i += 1;
            while i < chars.len() && (chars[i].is_ascii_alphanumeric() || chars[i] == '_' || chars[i] == '$') {
                i += 1;
            }
            let word: String = chars[start..i].iter().collect();
            if let Some(reason) = blocked_ident(&word) {
                return Some(reason);
            }
            continue;
        }
        i += 1;
    }
    None
}

fn blocked_ident(word: &str) -> Option<&'static str> {
    match word {
        "process" | "globalThis" | "global" => Some("process access"),
        "Bun" => Some("Bun runtime access"),
        "Deno" => Some("Deno runtime access"),
        "child_process" => Some("process spawn"),
        "require" | "import" | "importScripts" => Some("module load"),
        "fetch" | "XMLHttpRequest" | "WebSocket" => Some("network access"),
        "eval" => Some("eval"),
        "Function" | "AsyncFunction" => Some("dynamic code"),
        _ => None,
    }
}

/// Blank string and comment text so the denylist sees code tokens only.
/// Template interpolations stay visible. An unclosed string stops masking so the rest stays code.
fn mask_strings_and_comments(script: &str) -> String {
    let chars: Vec<char> = script.chars().collect();
    let mut out = chars.clone();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '/' && i + 1 < chars.len() && chars[i + 1] == '/' {
            i += 2;
            while i < chars.len() && chars[i] != '\n' {
                out[i] = ' ';
                i += 1;
            }
            continue;
        }
        if chars[i] == '/' && i + 1 < chars.len() && chars[i + 1] == '*' {
            out[i] = ' ';
            out[i + 1] = ' ';
            i += 2;
            while i + 1 < chars.len() && !(chars[i] == '*' && chars[i + 1] == '/') {
                out[i] = ' ';
                i += 1;
            }
            if i + 1 < chars.len() {
                out[i] = ' ';
                out[i + 1] = ' ';
                i += 2;
            }
            continue;
        }
        if chars[i] == '"' || chars[i] == '\'' {
            i = mask_quoted(&mut out, &chars, i);
            continue;
        }
        if chars[i] == '`' {
            i = mask_template(&mut out, &chars, i);
            continue;
        }
        i += 1;
    }
    out.into_iter().collect()
}

fn mask_quoted(out: &mut [char], chars: &[char], start: usize) -> usize {
    let quote = chars[start];
    let mut i = start + 1;
    while i < chars.len() {
        if chars[i] == '\\' && i + 1 < chars.len() {
            out[i] = ' ';
            out[i + 1] = ' ';
            i += 2;
            continue;
        }
        if chars[i] == quote {
            return i + 1;
        }
        if chars[i] == '\n' {
            return i;
        }
        out[i] = ' ';
        i += 1;
    }
    i
}

fn mask_template(out: &mut [char], chars: &[char], start: usize) -> usize {
    let mut i = start + 1;
    while i < chars.len() {
        if chars[i] == '\\' && i + 1 < chars.len() {
            out[i] = ' ';
            out[i + 1] = ' ';
            i += 2;
            continue;
        }
        if chars[i] == '`' {
            return i + 1;
        }
        if chars[i] == '$' && i + 1 < chars.len() && chars[i + 1] == '{' {
            i += 2;
            let mut depth = 1;
            while i < chars.len() && depth > 0 {
                if chars[i] == '"' || chars[i] == '\'' {
                    i = mask_quoted(out, chars, i);
                    continue;
                }
                if chars[i] == '`' {
                    i = mask_template(out, chars, i);
                    continue;
                }
                if chars[i] == '{' {
                    depth += 1;
                    i += 1;
                    continue;
                }
                if chars[i] == '}' {
                    depth -= 1;
                    i += 1;
                    continue;
                }
                i += 1;
            }
            continue;
        }
        out[i] = ' ';
        i += 1;
    }
    i
}

fn dispatch(conn: &Connection, home: &Path, app: Option<&AppHandle>, method: &str, args: &Value) -> Result<Value, String> {
    match method {
        "mem0.search" => Ok(search_memory(conn, arg(args, "query"))),
        "mem0.add" => add_memory(conn, arg(args, "fact"), arg(args, "title")),
        "mem0.curate" => curate_note(conn, arg(args, "target"), arg(args, "action"), arg(args, "content"), arg(args, "oldText")),
        "mem0.link" => link_memory(conn, arg(args, "title"), arg(args, "target"), arg(args, "relation"), false),
        "mem0.unlink" => link_memory(conn, arg(args, "title"), arg(args, "target"), "", true),
        "mem0.graphNeighbors" => Ok(crate::memory::graph_neighbors(conn, arg(args, "entity"))),
        "skills.listIndex" => Ok(skill_index(conn, home)),
        "skills.loadPlaybook" => load_playbook(conn, home, arg(args, "slug")),
        "mcp.searchCapabilities" => Ok(search_capabilities(conn, home, arg(args, "query"))),
        "apps.web" => crate::dock_mcp::drive(app, Some(conn), "workspace_webapp", args),
        "apps.desktop" => crate::dock_mcp::drive(app, Some(conn), "desktop_app", args),
        "mcp.call" => {
            let tool = arg(args, "tool");
            if crate::dock_mcp::is_dock_tool(tool) {
                let params = args.get("params").cloned().unwrap_or_else(|| json!({}));
                crate::dock_mcp::drive(app, Some(conn), tool, &params)
            } else {
                mcp_call(conn, home, &active_profile(conn), arg(args, "server"), tool, args.get("params").cloned().unwrap_or_else(|| json!({})))
            }
        }
        "acp.askPeer" => mcp_acp_automesh::ask_peer(conn, home, "codemode", arg(args, "target"), first_present(args, &["prompt", "task"])),
        "computer.somClick" => match crate::computer_subsystem::som_click_sync(mark_id_arg(args)) {
            Ok(message) => Ok(json!({ "ok": true, "message": message })),
            Err(error) => Err(error),
        },
        "computer.somType" => match crate::computer_subsystem::som_type_sync(mark_id_arg(args), arg(args, "text")) {
            Ok(message) => Ok(json!({ "ok": true, "message": message })),
            Err(error) => Err(error),
        },
        "computer.inspectNative" => {
            let nodes = crate::computer_subsystem::inspect_and_cache(arg(args, "windowFilter")).map_err(|error| error.0)?;
            Ok(json!({ "marks": nodes }))
        }
        "computer.haltStatus" => Ok(json!({ "halted": crate::computer_subsystem::halt_engaged() })),
        "contextCopy.pullLatest" => {
            let text = std::fs::read_to_string(home.join("context_copy").join("latest.md")).unwrap_or_default();
            let text = text.trim();
            if text.is_empty() {
                Err("No Context Copy has been saved yet.".into())
            } else {
                Ok(json!({ "markdown": redact(text) }))
            }
        }
        _ => Err(format!("`{method}` is not an Ronic Code Mode binding.")),
    }
}

fn mark_id_arg(args: &Value) -> u32 {
    args.get("markId")
        .or_else(|| args.get("mark_id"))
        .and_then(|value| value.as_u64())
        .unwrap_or(0) as u32
}

pub(crate) fn mcp_call(conn: &Connection, home: &Path, profile: &str, server: &str, tool: &str, params: Value) -> Result<Value, String> {
    let tool = tool.trim();
    if tool.is_empty() {
        return Err("mcp.call needs a tool name.".into());
    }
    if tool == "ronic_execute_codemode" || tool == "execute_code_mode_script" {
        return Err("Code Mode does not start another Code Mode worker.".into());
    }
    let local = server.is_empty() || server.eq_ignore_ascii_case("ronic-os") || server.eq_ignore_ascii_case("workspace");
    if local && workspace_bridge::is_local_tool(tool) {
        let text = workspace_bridge::call_tool(conn, home, tool, &params)?;
        return Ok(json!({ "text": text }));
    }
    let Some(found) = find_mcp_server(conn, server) else {
        return Err(format!("MCP server `{server}` is not connected."));
    };
    if mcp_switch_off(conn, &found.id, profile) {
        return Err(format!("The profile switch is Off for {}.", found.name));
    }
    if found.trust != "trusted" {
        return Err(format!("{} is saved, and the profile switch defaults to Active, but the server is not trusted.", found.name));
    }
    if !(found.url.starts_with("http://") || found.url.starts_with("https://")) {
        return Err(format!("{} is a local command. Code Mode does not spawn it.", found.name));
    }
    if found.url.contains("mcp.google.com") {
        return Err("This catalog URL is not a live Google MCP host. A Google token can be checked at connect time, but tool calls need the provider's real endpoint.".into());
    }
    let secret = mcp_secret(home, &found.id)?;
    if secret.trim().is_empty() {
        return Err(format!("No credential is stored for {}. The profile switch can still be Active.", found.name));
    }
    call_remote_mcp(&found.url, &secret, tool, &params)
}

struct SavedMcp {
    id: String,
    name: String,
    url: String,
    trust: String,
}

fn find_mcp_server(conn: &Connection, server: &str) -> Option<SavedMcp> {
    let mut stmt = conn.prepare("SELECT id, name, url, trust FROM mcp_servers").ok()?;
    let rows = stmt.query_map([], |row| {
        Ok(SavedMcp { id: row.get(0)?, name: row.get(1)?, url: row.get(2)?, trust: row.get(3)? })
    }).ok()?;
    let needle = server.trim();
    for row in rows.flatten() {
        if row.id.eq_ignore_ascii_case(needle) || row.name.eq_ignore_ascii_case(needle) || ident(&row.name).eq_ignore_ascii_case(needle) {
            return Some(row);
        }
    }
    None
}

fn mcp_switch_off(conn: &Connection, id: &str, profile: &str) -> bool {
    if profile.trim().is_empty() {
        return false;
    }
    let enabled: Option<i64> = conn
        .query_row("SELECT enabled FROM mcp_enables WHERE server_id = ?1 AND profile_id = ?2", params![id, profile], |row| row.get(0))
        .ok();
    enabled == Some(0)
}

fn mcp_secret(home: &Path, id: &str) -> Result<String, String> {
    if home.join("secrets.vault").exists() {
        return Err("The vault is locked for Code Mode. Unlock it in Settings, then try the MCP call again.".into());
    }
    let secrets = crate::vault::load_plaintext(home);
    secrets.get(&format!("mcp:{id}")).cloned().ok_or_else(|| "No credential is stored for this server.".to_string())
}

fn call_remote_mcp(url: &str, secret: &str, tool: &str, params: &Value) -> Result<Value, String> {
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|_| "The MCP client could not start.".to_string())?;
    let body = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": { "name": tool, "arguments": params }
    });
    let response = client
        .post(url)
        .header("Authorization", format!("Bearer {secret}"))
        .header("Accept", "application/json, text/event-stream")
        .json(&body)
        .send()
        .map_err(|_| format!("MCP server {url} did not answer."))?;
    let status = response.status();
    let text = response.text().unwrap_or_default();
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err("The MCP server rejected the stored credential.".into());
    }
    if !status.is_success() {
        return Err(format!("The MCP server returned {}. The tool call did not succeed.", status.as_u16()));
    }
    let clipped: String = text.chars().take(4000).collect();
    Ok(json!({ "status": status.as_u16(), "body": clipped }))
}

fn search_memory(conn: &Connection, query: &str) -> Value {
    let query = query.trim();
    let rows = if query.is_empty() {
        memory_rows(conn, "SELECT title, content_markdown FROM memory_items ORDER BY updated_at DESC LIMIT 8", params![])
    } else {
        let like = format!("%{}%", query.to_lowercase().replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
        memory_rows(
            conn,
            "SELECT title, content_markdown FROM memory_items WHERE lower(title) LIKE ?1 ESCAPE '\\' OR lower(content_markdown) LIKE ?1 ESCAPE '\\' ORDER BY updated_at DESC LIMIT 12",
            params![like],
        )
    };
    Value::Array(rows.into_iter().map(|(title, body)| json!({ "title": title, "excerpt": clip(&redact(&body), 180) })).collect())
}

fn add_memory(conn: &Connection, fact: &str, title: &str) -> Result<Value, String> {
    let fact = fact.trim();
    if fact.is_empty() {
        return Err("mem0.add needs a fact.".into());
    }
    let title = {
        let given = title.trim();
        if given.is_empty() {
            clip(fact, 80)
        } else {
            clip(given, 200)
        }
    };
    let saved = crate::memory::remember(
        conn,
        &crate::memory::MemoryInput {
            id: None,
            title,
            content_markdown: clip(fact, 4000),
            source_type: "codemode".into(),
            scoped_bot_id: None,
            file_path_or_uri: String::new(),
            engine_id: None,
            keep_identity: true,
        },
    )
    .map_err(|error| error.0)?;
    let status = if saved.replaced { "updated" } else { "added" };
    Ok(json!({ "id": saved.id, "status": status, "note": saved.note }))
}

fn curate_note(conn: &Connection, target: &str, action: &str, content: &str, old_text: &str) -> Result<Value, String> {
    let profile = active_profile(conn);
    let bot = if profile.is_empty() { None } else { Some(profile.as_str()) };
    let note = crate::memory::curate(conn, target, action, old_text, content, bot).map_err(|error| error.0)?;
    Ok(json!({ "note": note }))
}

fn link_memory(conn: &Connection, title: &str, target: &str, relation: &str, remove: bool) -> Result<Value, String> {
    let note = crate::memory::link_graph(conn, title, target, relation, remove, None).map_err(|error| error.0)?;
    Ok(json!({ "status": if remove { "removed" } else { "linked" }, "note": note }))
}

fn skill_index(conn: &Connection, home: &Path) -> Value {
    let profile = active_profile(conn);
    let Ok(view) = capabilities::view(conn, home, &profile) else {
        return json!([]);
    };
    let rows = view
        .skills
        .iter()
        .filter(|skill| in_index(skill, &profile, capabilities::plugin_agent_on(&view.plugins, &skill.plugin_id, &profile)))
        .take(60)
        .map(|skill| {
            json!({
                "slug": skill.slug,
                "slash": skill.slash_command,
                "summary": clip(&redact(&skill.description), 160),
            })
        })
        .collect();
    Value::Array(rows)
}

fn load_playbook(conn: &Connection, home: &Path, slug: &str) -> Result<Value, String> {
    let profile = active_profile(conn);
    let body = capabilities::load_skill_text(conn, home, &profile, slug.trim()).map_err(|error| error.0)?;
    Ok(json!({ "instructions": clip(&redact(&body), 6000) }))
}

fn capability_rows(conn: &Connection, home: &Path) -> Vec<(String, String, String)> {
    let mut rows = vec![
        ("ronic-os".into(), "search_memory".into(), "search_memory(query: string)".into()),
        ("ronic-os".into(), "save_memory".into(), "save_memory(title: string, content: string, id?: string)".into()),
        ("ronic-os".into(), "curate_memory".into(), "curate_memory(target: string, action: string, content?: string, oldText?: string)".into()),
        ("ronic-os".into(), "update_memory_graph".into(), "update_memory_graph(title: string, target: string, relation?: string, remove?: boolean)".into()),
        ("ronic-os".into(), "list_skills".into(), "list_skills()".into()),
        ("ronic-os".into(), "load_skill".into(), "load_skill(slug: string)".into()),
        ("ronic-os".into(), "list_plugins".into(), "list_plugins()".into()),
        ("ronic-os".into(), "list_mcp".into(), "list_mcp()".into()),
        ("ronic-os".into(), "ronic_ask_peer_app".into(), "ronic_ask_peer_app(target: string, task: string)".into()),
        ("ronic-os".into(), "workspace_webapp".into(), "workspace_webapp(action: string, app?: string)".into()),
        ("ronic-os".into(), "desktop_app".into(), "desktop_app(action: string, app?: string, window?: string, markId?: number, match?: string, text?: string)".into()),
        ("ronic-os".into(), "som_click".into(), "som_click(mark_id: number)".into()),
        ("ronic-os".into(), "som_type".into(), "som_type(mark_id: number, text: string)".into()),
        ("ronic-os".into(), "inspect_native_os".into(), "inspect_native_os(window_filter: string)".into()),
    ];
    let profile = active_profile(conn);
    if let Ok(view) = capabilities::view(conn, home, &profile) {
        for server in view.mcp_servers {
            for tool in server.declared_tools {
                rows.push((server.name.clone(), tool.name.clone(), format!("{}(args)", tool.name)));
            }
        }
    }
    rows
}

fn saved_servers(conn: &Connection, home: &Path) -> Vec<String> {
    let profile = active_profile(conn);
    let Ok(view) = capabilities::view(conn, home, &profile) else {
        return Vec::new();
    };
    view.mcp_servers
        .iter()
        .flat_map(|server| [server.id.clone(), server.name.clone(), ident(&server.name)])
        .collect()
}

fn surface(conn: &Connection, home: &Path) -> Surface {
    let profile = active_profile(conn);
    let view = capabilities::view(conn, home, &profile).ok();
    let mut skills: Vec<(String, String, String)> = Vec::new();
    let mut servers = Vec::new();
    let mut raw_chars = 0usize;
    if let Some(view) = view {
        for skill in view.skills.iter().filter(|skill| in_index(skill, &profile, capabilities::plugin_agent_on(&view.plugins, &skill.plugin_id, &profile))).take(60) {
            skills.push((skill.slug.clone(), skill.slash_command.clone(), clip(&redact(&skill.description), 120)));
        }
        for server in view.mcp_servers.iter().take(24) {
            let tools: Vec<String> = server.declared_tools.iter().take(12).map(|tool| tool.name.clone()).collect();
            for tool in &server.declared_tools {
                raw_chars += tool.name.len() + tool.description.len() + 80;
            }
            servers.push(SurfaceServer { ident: ident(&server.name), name: server.name.clone(), tools });
        }
    }
    let dts = render_dts(&skills, &servers);
    Surface {
        dts_tokens: token_estimate(&dts),
        raw_tokens: token_estimate_len(raw_chars),
        skill_count: skills.len() as u32,
        server_count: servers.len() as u32,
        dts,
        servers,
    }
}

fn render_dts(skills: &[(String, String, String)], servers: &[SurfaceServer]) -> String {
    let mut out = String::from(
        "// Ronic OS Code Mode host v2. The host runs await ronic.* calls, if/else, comparisons, ??, for-of (64 items), template strings, object shorthand, Object.keys/values/entries (64 fields), push and concat (64 items), indexOf, and array callbacks (filter, map, find, findIndex, some, every, forEach). It refuses eval, import, process, fetch, while, and Node or Bun.\n\
// Generated from the live skill index, Mem0 vault, and saved MCP servers.\n\
declare namespace ronic {\n\
  namespace mem0 {\n\
    function search(query: string): Promise<Array<{ title: string; excerpt: string }>>;\n\
    function add(fact: string, opts?: { title?: string }): Promise<{ id: string; status: string }>;\n\
    function curate(target: string, action: string, content?: string, oldText?: string): Promise<{ note: string }>;\n\
    function link(title: string, target: string, relation?: string): Promise<{ status: string; note: string }>;\n\
    function unlink(title: string, target: string): Promise<{ status: string; note: string }>;\n\
    function graphNeighbors(entity: string): Promise<Array<{ source: string; relation: string; target: string; excerpt: string }>>;\n\
  }\n\
  namespace skills {\n\
    function listIndex(): Promise<Array<{ slug: string; slash: string; summary: string }>>;\n\
    function loadPlaybook(slug: string): Promise<{ instructions: string }>;\n\
  }\n\
  namespace mcp {\n\
    function searchCapabilities(query: string): Promise<Array<{ server: string; tool: string; signature: string }>>;\n\
    function call(server: string, tool: string, params?: Record<string, unknown>): Promise<unknown>;\n\
    namespace workspace {\n\
      function searchMemory(query: string): Promise<{ text: string }>;\n\
      function listSkills(): Promise<{ text: string }>;\n\
      function loadSkill(slug: string): Promise<{ text: string }>;\n\
      function listPlugins(): Promise<{ text: string }>;\n\
    }\n",
    );
    for server in servers {
        out.push_str(&format!("    namespace {} {{\n", server.ident));
        if server.tools.is_empty() {
            out.push_str("      // No tool list is stored for this server.\n");
        }
        for tool in &server.tools {
            out.push_str(&format!(
                "      function {}(params?: Record<string, unknown>): Promise<unknown>;\n",
                ident(tool)
            ));
        }
        out.push_str("    }\n");
    }
    out.push_str(
        "  }\n\
  namespace apps {\n\
    function web(action: { action: string; app?: string; url?: string; id?: number; match?: string; text?: string; direction?: string }): Promise<unknown>;\n\
    function desktop(action: { action: string; app?: string; path?: string; kind?: string; window?: string; markId?: number; match?: string; text?: string }): Promise<unknown>;\n\
  }\n\
  namespace computer {\n\
    function somClick(markId: number): Promise<{ ok: boolean; message: string }>;\n\
    function somType(markId: number, text: string): Promise<{ ok: boolean; message: string }>;\n\
    function inspectNative(windowFilter: string): Promise<{ marks: Array<{ markId: number; controlType: string; name: string; automationId: string; bounds: number[]; centerXY: number[]; backgroundReady: boolean; origin: string }> }>;\n\
    function haltStatus(): Promise<{ halted: boolean }>;\n\
  }\n\
  namespace acp {\n\
    function askPeer(target: string, prompt: string): Promise<{ ticketId: string; executed: boolean; reply: string }>;\n\
  }\n\
  namespace contextCopy {\n\
    function pullLatest(): Promise<{ markdown: string }>;\n\
  }\n\
}\n",
    );
    if !skills.is_empty() {
        out.push_str("\n// Skill index slugs:\n");
        for (slug, slash, summary) in skills {
            out.push_str(&format!("// - {slash} {slug}: {summary}\n"));
        }
    }
    out
}

fn memory_rows(conn: &Connection, sql: &str, args: impl rusqlite::Params) -> Vec<(String, String)> {
    let Ok(mut stmt) = conn.prepare(sql) else { return Vec::new() };
    stmt.query_map(args, |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map(|rows| rows.flatten().collect())
        .unwrap_or_default()
}

fn active_profile(conn: &Connection) -> String {
    if let Ok(Some(id)) = db::kv_get(conn, "active_profile") {
        if !id.trim().is_empty() {
            return id;
        }
    }
    conn.query_row("SELECT id FROM bot_profiles ORDER BY created_at LIMIT 1", [], |row| row.get(0)).unwrap_or_default()
}

fn arg<'a>(args: &'a Value, key: &str) -> &'a str {
    args.get(key).and_then(|value| value.as_str()).unwrap_or("").trim()
}

fn first_present<'a>(args: &'a Value, keys: &[&str]) -> &'a str {
    keys.iter().find_map(|key| args.get(*key).and_then(|value| value.as_str()).map(str::trim).filter(|value| !value.is_empty())).unwrap_or("")
}

fn query_needle(query: &str) -> String {
    let query = query.trim();
    if let Some(start) = query.find('\'').or_else(|| query.find('"')) {
        let quote = query.as_bytes()[start] as char;
        let rest = &query[start + 1..];
        if let Some(end) = rest.find(quote) {
            return rest[..end].to_lowercase();
        }
    }
    query.to_lowercase()
}

fn ident(name: &str) -> String {
    let mut out = String::new();
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
        } else if !out.ends_with('_') && !out.is_empty() {
            out.push('_');
        }
    }
    while out.ends_with('_') {
        out.pop();
    }
    if out.is_empty() || out.chars().next().is_some_and(|ch| ch.is_ascii_digit()) {
        out.insert_str(0, "srv_");
    }
    out
}

fn token_estimate(text: &str) -> u32 {
    token_estimate_len(text.chars().count())
}

fn token_estimate_len(chars: usize) -> u32 {
    ((chars + 3) / 4).min(u32::MAX as usize) as u32
}

fn clip(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
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
    fn blocks_process_and_network() {
        assert!(script_blocked("await ronic.mem0.search('x')").is_none());
        assert_eq!(script_blocked("process.env.KEY"), Some("process access"));
        assert_eq!(script_blocked("fetch('https://example.com')"), Some("network access"));
        assert!(script_blocked("await ronic.mem0.search('how to import a module')").is_none());
        assert!(script_blocked("await ronic.mem0.search('fetch(1)')").is_none());
        assert!(script_blocked("// process.env\nreturn 1;").is_none());
        assert_eq!(script_blocked("import fs from 'node:fs'"), Some("module load"));
        assert_eq!(script_blocked("const x = node:fs"), Some("filesystem access"));
    }

    #[test]
    fn query_needle_reads_a_string_literal() {
        assert_eq!(query_needle("tool.includes('issue')"), "issue");
        assert_eq!(query_needle("linear"), "linear");
    }

    #[test]
    fn ident_is_a_typescript_name() {
        assert_eq!(ident("Linear App"), "Linear_App");
        assert_eq!(ident("123"), "srv_123");
    }

    #[test]
    fn token_estimate_uses_four_chars() {
        assert_eq!(token_estimate("abcd"), 1);
        assert_eq!(token_estimate("abcde"), 2);
    }

    #[test]
    fn host_interpreter_runs_ronic_calls() {
        let home = std::env::temp_dir().join(format!("ronic-cm-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        let conn = crate::db::open(&home.join("state.db")).unwrap();
        crate::db::migrate(&conn).unwrap();
        crate::db::seed_if_empty(&conn, &home).unwrap();
        drop(conn);
        let result = execute(
            &home,
            r#"
            const skills = await ronic.skills.listIndex();
            const facts = await ronic.mem0.search("workspace");
            return { skillCount: skills.length, factCount: facts.length, first: skills[0] || null };
            "#,
        )
        .unwrap();
        assert!(result.ok, "{}", result.final_return_json);
        assert_eq!(result.worker, "host-v2");
        assert!(result.rpc_calls.iter().any(|call| call == "skills.listIndex"));
        assert!(result.rpc_calls.iter().any(|call| call == "mem0.search"));
        let quoted = execute(&home, r#"return await ronic.mem0.search("how to import a module");"#).unwrap();
        assert!(quoted.ok, "{}", quoted.final_return_json);
        let halt = execute(&home, "return await ronic.computer.haltStatus();").unwrap();
        assert!(halt.ok, "{}", halt.final_return_json);
        assert!(halt.rpc_calls.iter().any(|call| call == "computer.haltStatus"));
        let spec = compile(&crate::db::open(&home.join("state.db")).unwrap(), &home);
        assert!(spec.typescript_dts.contains("Code Mode host v2"));
        assert!(spec.typescript_dts.contains("namespace apps"));
        let listed = execute(&home, r#"return await ronic.apps.desktop({ action: "list" });"#).unwrap();
        assert!(listed.ok, "{}", listed.final_return_json);
        assert!(listed.final_return_json.contains("cursor"), "{}", listed.final_return_json);
        assert!(listed.rpc_calls.iter().any(|call| call == "apps.desktop"));
        let blocked = execute(&home, r#"return await ronic.apps.web({ action: "open", app: "chatgpt" });"#).unwrap();
        assert!(!blocked.ok, "{}", blocked.final_return_json);
        assert!(blocked.final_return_json.contains("desktop app"), "{}", blocked.final_return_json);
        assert!(!blocked.final_return_json.to_ascii_lowercase().contains("completed"), "{}", blocked.final_return_json);
        let gemini = execute(&home, r#"return await ronic.apps.web("connect", "gemini");"#).unwrap();
        assert!(!gemini.ok, "{}", gemini.final_return_json);
        assert!(gemini.final_return_json.contains("Gemini"), "{}", gemini.final_return_json);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn generated_mcp_methods_return_unknown() {
        let dts = render_dts(
            &[],
            &[SurfaceServer {
                ident: "Linear".into(),
                name: "Linear".into(),
                tools: vec!["create_issue".into()],
            }],
        );
        assert!(dts.contains("function create_issue(params?: Record<string, unknown>): Promise<unknown>;"));
        assert!(!dts.contains("executed: false"));
    }

    #[test]
    fn host_interpreter_does_not_eval_javascript() {
        let home = std::env::temp_dir().join(format!("ronic-cm-deny-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        let conn = crate::db::open(&home.join("state.db")).unwrap();
        crate::db::migrate(&conn).unwrap();
        drop(conn);
        let eval_denied = execute(&home, "return eval('1')").unwrap_err();
        assert!(eval_denied.contains("eval"), "{eval_denied}");
        let process_denied = execute(&home, "return process.env").unwrap_err();
        assert!(process_denied.contains("process"), "{process_denied}");
        let host_denied = execute(&home, "return await ronic.shell.exec('dir')").unwrap();
        assert!(!host_denied.ok, "{}", host_denied.final_return_json);
        let _ = std::fs::remove_dir_all(&home);
    }
}
