//! Context Copy: a scrubbed snapshot of the live workspace, written three ways
//! (webapp block, CLI file pointer, Cursor rule) so another agent can resume.

use crate::db;
use crate::redact::redact;
use crate::util::{nid, now_ms, run_capture};
use crate::AppState;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

const AUTO_KEY: &str = "context_copy_auto";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextSliceSelection {
    pub include_goal_and_dod: bool,
    pub include_git_ast_diff: bool,
    pub include_pty_terminal_trace: bool,
    pub include_browser_dom_som: bool,
    pub include_mem0_facts: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextCopyPackage {
    pub copy_id: String,
    pub created_at: String,
    pub source_surface: String,
    pub trigger_mode: String,
    pub slices: ContextSliceSelection,
    pub raw_tokens_before: u32,
    pub compressed_tokens: u32,
    pub secrets_scrubbed: u32,
    pub integrity_hash: String,
    pub webapp_xml_markdown: String,
    pub cli_command_pointer: String,
    pub cursor_ide_mdc_rule: String,
    pub latest_path: String,
}

struct Gathered {
    source: String,
    trigger: String,
    slices: ContextSliceSelection,
    goal: String,
    git: String,
    pty: String,
    browser: String,
    facts: String,
    redactions: u32,
}

pub fn armed(conn: &Connection) -> bool {
    !matches!(db::kv_get(conn, AUTO_KEY), Ok(Some(value)) if value == "0")
}

/// Quota and provider failover already switch lanes. When this is armed, that
/// handoff carries a Context Copy instead of the one-line capsule.
pub fn handoff(conn: &Connection, home: &Path, trigger: &str, note: &str) -> String {
    if !armed(conn) {
        return note.to_string();
    }
    let slices = ContextSliceSelection {
        include_goal_and_dod: true,
        include_git_ast_diff: true,
        include_pty_terminal_trace: false,
        include_browser_dom_som: false,
        include_mem0_facts: true,
    };
    // shortcut: this path has no PTY tail or mini-window, those need the live terminal and webview
    build(conn, home, "quota", trigger, note, None, None, None, None, slices)
        .map(|pkg| pkg.webapp_xml_markdown)
        .unwrap_or_else(|_| note.to_string())
}

#[tauri::command]
pub fn context_copy_auto(state: State<'_, AppState>, enabled: Option<bool>) -> Result<bool, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    if let Some(enabled) = enabled {
        db::kv_set(&conn, AUTO_KEY, if enabled { "1" } else { "0" }).map_err(|e| e.to_string())?;
        return Ok(enabled);
    }
    Ok(armed(&conn))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextCopyRecord {
    pub copy_id: String,
    pub title: String,
    pub source_surface: String,
    pub created_at: i64,
    pub compressed_tokens: i64,
    pub secrets_scrubbed: i64,
    pub webapp_xml_markdown: String,
}

#[tauri::command]
pub fn list_context_copies(state: State<'_, AppState>) -> Result<Vec<ContextCopyRecord>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT copy_id, title, source_surface, created_at, compressed_token_count, secrets_redacted_count, payload_xml_md FROM context_copies ORDER BY created_at DESC LIMIT 40")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(ContextCopyRecord {
                copy_id: row.get(0)?,
                title: row.get(1)?,
                source_surface: row.get(2)?,
                created_at: row.get(3)?,
                compressed_tokens: row.get(4)?,
                secrets_scrubbed: row.get(5)?,
                webapp_xml_markdown: row.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_context_copy(
    app: AppHandle,
    state: State<'_, AppState>,
    source_kind: String,
    source_id: String,
    source_label: String,
    goal_note: String,
) -> Result<ContextCopyPackage, String> {
    let kind = source_kind.trim();
    let id = source_id.trim();
    if id.is_empty() {
        return Err("Choose a chat or a connected app.".into());
    }
    // Reading a page can wait on the webview. Do that before taking the database lock.
    let body = if kind == "app" {
        let page = page_excerpt(&app, id, source_label.trim());
        join_note(&page, &goal_note)
    } else {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        join_note(&thread_excerpt(&conn, id), &goal_note)
    };
    let label = source_label.trim();
    let source = if label.is_empty() { id } else { label };
    let trigger = if kind == "app" { "from_app" } else { "from_chat" };
    let slices = ContextSliceSelection {
        include_goal_and_dod: true,
        include_git_ast_diff: false,
        include_pty_terminal_trace: false,
        include_browser_dom_som: false,
        include_mem0_facts: false,
    };
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    build(&conn, &state.home, source, trigger, "", Some(body), None, None, None, slices)
}

#[tauri::command]
pub fn paste_context_copy_to_targets(
    app: AppHandle,
    state: State<'_, AppState>,
    terminals: State<'_, crate::terminal_pty::TerminalManager>,
    package: ContextCopyPackage,
    target_ids: Vec<String>,
    auto_submit_on_paste: bool,
) -> Result<Vec<String>, String> {
    if target_ids.is_empty() {
        return Err("Select at least one target.".into());
    }
    let project = {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        db::settings_of(&conn).map(|settings| settings.project_root).unwrap_or_default()
    };
    let mut receipts = Vec::new();
    for target in target_ids {
        let target = target.trim();
        if let Some(app_id) = web_app_id(target) {
            let label = format!("webapp_{app_id}");
            if let Some(view) = app.get_webview(&label) {
                let script = inject_js(&package.webapp_xml_markdown, auto_submit_on_paste);
                match view.eval(&script) {
                    Ok(()) => receipts.push(format!("{app_id} composer filled")),
                    Err(error) => receipts.push(format!("{app_id} is open but the fill failed: {error}")),
                }
            } else {
                receipts.push(format!("{app_id} is not open. The block is on the clipboard."));
            }
        } else if target == "cursor_ide" || target == "vscode_ide" {
            match write_cursor_rule(&project, &package.cursor_ide_mdc_rule) {
                Ok(path) => receipts.push(format!("wrote {path}")),
                Err(error) => receipts.push(error),
            }
        } else if target.ends_with("_cli") {
            let line = cli_line(target, &package);
            match terminals.write_session("ronic_global", &line) {
                Ok(()) => receipts.push(format!("sent to the terminal: {}", line.trim())),
                Err(_) => receipts.push("terminal is closed. The command is in the copy.".into()),
            }
        } else {
            let _ = app.emit(
                "ronic-bot-context-copy",
                json!({
                    "copyId": package.copy_id,
                    "target": target,
                    "payload": package.webapp_xml_markdown,
                    "integrity": package.integrity_hash,
                }),
            );
            receipts.push(format!("handed to {target}"));
        }
    }
    Ok(receipts)
}

fn build(
    conn: &Connection,
    home: &Path,
    source: &str,
    trigger: &str,
    note: &str,
    goal_ready: Option<String>,
    pty: Option<&str>,
    browser: Option<&str>,
    git_ready: Option<String>,
    slices: ContextSliceSelection,
) -> Result<ContextCopyPackage, String> {
    let mut redactions = 0u32;
    let goal = if slices.include_goal_and_dod {
        let text = match goal_ready {
            Some(text) => text,
            None => goal_text(conn, note),
        };
        scrub(&text, &mut redactions)
    } else {
        String::new()
    };
    let git = if slices.include_git_ast_diff {
        let text = match git_ready {
            Some(text) => text,
            None => {
                let root = db::settings_of(conn).map(|settings| settings.project_root).unwrap_or_default();
                live_git(&root)
            }
        };
        scrub(&text, &mut redactions)
    } else {
        String::new()
    };
    let pty_text = if slices.include_pty_terminal_trace {
        scrub(&pty_text(pty.unwrap_or("")), &mut redactions)
    } else {
        String::new()
    };
    let browser_text = if slices.include_browser_dom_som {
        scrub(&browser_text(browser.unwrap_or("")), &mut redactions)
    } else {
        String::new()
    };
    let facts = if slices.include_mem0_facts {
        scrub(&facts_text(conn), &mut redactions)
    } else {
        String::new()
    };
    let gathered = Gathered {
        source: if source.is_empty() { "Ronic OS".into() } else { source.into() },
        trigger: if trigger.is_empty() { "manual_1shot".into() } else { trigger.into() },
        slices,
        goal,
        git,
        pty: pty_text,
        browser: browser_text,
        facts,
        redactions,
    };
    let dir = home.join("context_copy");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let latest = dir.join("latest.md");
    let pkg = compile(&gathered, &latest);
    std::fs::write(&latest, &pkg.webapp_xml_markdown).map_err(|e| e.to_string())?;
    let _ = insert_row(conn, &pkg);
    Ok(pkg)
}

fn compile(g: &Gathered, latest: &Path) -> ContextCopyPackage {
    let mut sections = Vec::new();
    let mut raw_body = String::new();
    if g.slices.include_goal_and_dod {
        push_section(&mut sections, &mut raw_body, "1. Objective and hand-off", &g.goal);
    }
    if g.slices.include_git_ast_diff {
        push_section(&mut sections, &mut raw_body, "2. Git status", &g.git);
    }
    if g.slices.include_pty_terminal_trace {
        push_section(&mut sections, &mut raw_body, "3. Terminal", &g.pty);
    }
    if g.slices.include_browser_dom_som {
        push_section(&mut sections, &mut raw_body, "4. Mini-computer", &g.browser);
    }
    if g.slices.include_mem0_facts {
        push_section(&mut sections, &mut raw_body, "5. Memory", &g.facts);
    }
    let copy_id = nid("cc");
    let body = sections.join("\n\n");
    let webapp = format!(
        "<ronic_context_copy id=\"{copy_id}\" from=\"{}\">\n{body}\n\nResume from this checkpoint. Do not repeat steps already listed as done.\n</ronic_context_copy>",
        g.source
    );
    let cli = format!(
        "claude \"Resume task from Ronic Context Copy #{copy_id}\" --add-file \"{}\"",
        latest.display()
    );
    let mdc = format!(
        "---\ndescription: Ronic OS Context Copy {copy_id} from {}\nglobs: [\"**/*\"]\nalwaysApply: true\n---\n\n{webapp}\n",
        g.source
    );
    let mut hasher = Sha256::new();
    hasher.update(webapp.as_bytes());
    let digest = format!("{:x}", hasher.finalize());
    ContextCopyPackage {
        copy_id,
        created_at: now_ms().to_string(),
        source_surface: g.source.clone(),
        trigger_mode: g.trigger.clone(),
        slices: g.slices.clone(),
        raw_tokens_before: tokens(&raw_body),
        compressed_tokens: tokens(&webapp),
        secrets_scrubbed: g.redactions,
        integrity_hash: format!("sha256:{}", &digest[..16]),
        webapp_xml_markdown: webapp,
        cli_command_pointer: cli,
        cursor_ide_mdc_rule: mdc,
        latest_path: latest.display().to_string(),
    }
}

fn push_section(sections: &mut Vec<String>, raw: &mut String, title: &str, body: &str) {
    raw.push_str(body);
    raw.push('\n');
    sections.push(format!("## {title}\n{body}"));
}

fn scrub(raw: &str, count: &mut u32) -> String {
    let clean = redact(raw);
    *count += clean.matches("***REDACTED***").count() as u32;
    clean
}

fn tokens(text: &str) -> u32 {
    text.chars().count().div_ceil(4) as u32
}

fn clip(text: &str, max: usize) -> String {
    let mut out: String = text.chars().take(max).collect();
    if text.chars().count() > max {
        out.push('…');
    }
    out
}

fn goal_text(conn: &Connection, note: &str) -> String {
    let mut parts = Vec::new();
    let note = note.trim();
    if !note.is_empty() {
        parts.push(clip(note, 800));
    }
    let thread = db::kv_get(conn, "active_thread").ok().flatten().unwrap_or_default();
    if !thread.is_empty() {
        let title: String = conn
            .query_row("SELECT title FROM chat_threads WHERE id = ?1", params![thread], |row| row.get(0))
            .unwrap_or_default();
        if !title.trim().is_empty() {
            parts.push(format!("Thread: {}", title.trim()));
        }
        let last: String = conn
            .query_row(
                "SELECT content_markdown FROM execution_steps WHERE thread_id = ?1 AND role = 'user' AND action_type != 'turn_activity' ORDER BY created_at DESC LIMIT 1",
                params![thread],
                |row| row.get(0),
            )
            .unwrap_or_default();
        if !last.trim().is_empty() {
            parts.push(format!("Last request: {}", clip(&last.replace('\n', " "), 400)));
        }
        if let Ok(mut stmt) = conn.prepare(
            "SELECT content_markdown FROM execution_steps WHERE thread_id = ?1 AND role = 'assistant' AND action_type != 'turn_activity' ORDER BY created_at DESC LIMIT 3",
        ) {
            let done: Vec<String> = stmt
                .query_map(params![thread], |row| row.get::<_, String>(0))
                .ok()
                .map(|rows| {
                    rows.filter_map(Result::ok)
                        .map(|line| clip(&line.replace('\n', " "), 160))
                        .filter(|line| !line.trim().is_empty())
                        .collect()
                })
                .unwrap_or_default();
            if !done.is_empty() {
                parts.push(format!("Done: {}", done.into_iter().rev().collect::<Vec<_>>().join(" | ")));
            }
        }
    }
    if parts.is_empty() {
        "No goal note and no active thread.".into()
    } else {
        parts.join("\n")
    }
}

fn live_git(root: &str) -> String {
    let root = root.trim();
    if root.is_empty() || !Path::new(root).is_dir() {
        return "No project folder is set.".into();
    }
    match run_capture("git", &["status", "--porcelain"], Some(Path::new(root)), Duration::from_millis(1500)) {
        Ok((0, out)) => {
            let lines = git_slice(&out);
            if lines.is_empty() { "Working tree is clean.".into() } else { lines }
        }
        Ok((code, out)) => format!("git status exited {code}: {}", clip(&out.replace('\n', " "), 180)),
        Err(error) => format!("git status unavailable: {error}"),
    }
}

fn git_slice(raw: &str) -> String {
    raw.lines()
        .filter(|line| !line.trim().is_empty())
        .filter(|line| !secret_git_line(line))
        .take(8)
        .collect::<Vec<_>>()
        .join("\n")
}

fn secret_git_line(line: &str) -> bool {
    let path = line.split_whitespace().last().unwrap_or("");
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path).to_ascii_lowercase();
    name == ".env" || name.starts_with(".env.") || name == "secrets.json" || name == "secrets.vault" || name.ends_with(".pem") || name.ends_with(".key")
}

fn pty_text(raw: &str) -> String {
    let raw = raw.trim();
    if raw.is_empty() {
        "No terminal output yet.".into()
    } else {
        clip(raw, 2000)
    }
}

fn browser_text(raw: &str) -> String {
    let raw = raw.trim();
    if raw.is_empty() {
        "No mini-computer window is open.".into()
    } else {
        clip(raw, 800)
    }
}

fn facts_text(conn: &Connection) -> String {
    let Ok(mut stmt) = conn.prepare(
        "SELECT title, content_markdown FROM memory_items WHERE invalid_at IS NULL ORDER BY updated_at DESC LIMIT 3",
    ) else {
        return "Memory could not be read.".into();
    };
    let rows = stmt
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .ok();
    let Some(rows) = rows else {
        return "Memory could not be read.".into();
    };
    let lines: Vec<String> = rows
        .filter_map(Result::ok)
        .map(|(title, body)| format!("- {}: {}", title.trim(), clip(&body.replace('\n', " "), 180)))
        .filter(|line| line.len() > 2)
        .collect();
    if lines.is_empty() {
        "No scoped facts.".into()
    } else {
        lines.join("\n")
    }
}

fn insert_row(conn: &Connection, pkg: &ContextCopyPackage) -> Result<(), String> {
    let slices = serde_json::to_string(&pkg.slices).unwrap_or_else(|_| "[]".into());
    conn.execute(
        "INSERT INTO context_copies (copy_id, title, source_surface, trigger_reason, included_slices_json, raw_token_estimate, compressed_token_count, secrets_redacted_count, payload_xml_md, payload_cli_flags, payload_cursor_mdc, integrity_sha256, pinned, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,0,?13)",
        params![
            pkg.copy_id,
            clip(&pkg.source_surface, 80),
            pkg.source_surface,
            pkg.trigger_mode,
            slices,
            pkg.raw_tokens_before,
            pkg.compressed_tokens,
            pkg.secrets_scrubbed,
            pkg.webapp_xml_markdown,
            pkg.cli_command_pointer,
            pkg.cursor_ide_mdc_rule,
            pkg.integrity_hash,
            now_ms(),
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn web_app_id(target: &str) -> Option<&str> {
    match target {
        "grok_web" => Some("grok"),
        "chatgpt_web" => Some("chatgpt"),
        "claude_web" => Some("claude"),
        "gemini_web" => Some("gemini"),
        _ if target.starts_with("app:") && target.len() > 4 => Some(&target[4..]),
        _ => None,
    }
}

fn join_note(body: &str, note: &str) -> String {
    let note = note.trim();
    if note.is_empty() {
        body.to_string()
    } else {
        format!("{body}\nNote: {note}")
    }
}

fn format_turns(bot: &str, title: &str, turns: &[(String, String)], note: &str) -> String {
    let mut lines = Vec::new();
    if !bot.is_empty() {
        lines.push(format!("Bot: {bot}"));
    }
    if !title.is_empty() {
        lines.push(format!("Chat: {title}"));
    }
    if turns.is_empty() {
        lines.push("This chat has no messages yet.".into());
    } else {
        for (role, body) in turns {
            let who = if role == "user" { "You" } else if bot.is_empty() { "Bot" } else { bot };
            lines.push(format!("{who}: {body}"));
        }
    }
    join_note(&lines.join("\n"), note)
}

fn thread_excerpt(conn: &Connection, thread_id: &str) -> String {
    let title: String = conn
        .query_row("SELECT title FROM chat_threads WHERE id = ?1", params![thread_id], |row| row.get(0))
        .unwrap_or_else(|_| "Chat".into());
    let bot: String = conn
        .query_row(
            "SELECT COALESCE(NULLIF(p.display_name, ''), p.handle, '') FROM chat_threads t LEFT JOIN bot_profiles p ON p.id = t.bot_profile_id WHERE t.id = ?1",
            params![thread_id],
            |row| row.get(0),
        )
        .unwrap_or_default();
    let turns = conn
        .prepare("SELECT role, content_markdown FROM execution_steps WHERE thread_id = ?1 AND role IN ('user', 'assistant') AND action_type NOT IN ('turn_activity', 'handoff_capsule', 'thinking') ORDER BY created_at DESC LIMIT 8")
        .ok()
        .and_then(|mut stmt| {
            stmt.query_map(params![thread_id], |row| {
                Ok((row.get::<_, String>(0)?, clip(&row.get::<_, String>(1)?.replace('\n', " "), 400)))
            })
            .ok()
            .map(|rows| rows.filter_map(Result::ok).filter(|(_, body)| !body.trim().is_empty()).collect::<Vec<_>>())
        })
        .unwrap_or_default();
    let turns: Vec<_> = turns.into_iter().rev().collect();
    format_turns(bot.trim(), title.trim(), &turns, "")
}

fn page_excerpt(app: &AppHandle, app_id: &str, name: &str) -> String {
    let shown = if name.is_empty() { app_id } else { name };
    let label = format!("webapp_{app_id}");
    let Some(view) = app.get_webview(&label) else {
        return format!("{shown} is not open in the dock. Open it, then copy again.");
    };
    let script = r#"(function(){var text=document.body&&document.body.innerText?String(document.body.innerText):"";text=text.replace(/[ \t]+\n/g,"\n").replace(/\n{3,}/g,"\n\n").trim();if(text.length>1800)text=text.slice(0,1800);return JSON.stringify({title:document.title||"",url:location.href||"",text:text});})()"#;
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    if view.eval_with_callback(script.to_string(), move |raw| { let _ = tx.send(raw); }).is_err() {
        return format!("{shown} is open, but the page could not be read.");
    }
    match rx.recv_timeout(Duration::from_millis(1500)) {
        Ok(raw) => page_text(&raw),
        Err(_) => format!("{shown} is open, but the page did not answer."),
    }
}

fn page_text(raw: &str) -> String {
    let trimmed = raw.trim();
    let json = if let Ok(serde_json::Value::String(inner)) = serde_json::from_str::<serde_json::Value>(trimmed) {
        inner
    } else {
        trimmed.to_string()
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&json) else {
        return "The page answered, but the text could not be read.".into();
    };
    let title = value.get("title").and_then(|item| item.as_str()).unwrap_or("").trim();
    let url = value.get("url").and_then(|item| item.as_str()).unwrap_or("").trim();
    let text = value.get("text").and_then(|item| item.as_str()).unwrap_or("").trim();
    let mut lines = Vec::new();
    if !title.is_empty() {
        lines.push(format!("Title: {title}"));
    }
    if !url.is_empty() {
        lines.push(format!("Page: {url}"));
    }
    if text.is_empty() {
        lines.push("The page is open but has no readable text yet.".into());
    } else {
        lines.push(text.to_string());
    }
    lines.join("\n")
}

fn cli_line(target: &str, pkg: &ContextCopyPackage) -> String {
    let path = &pkg.latest_path;
    let line = match target {
        "aider_cli" => format!("aider --file \"{path}\""),
        "opencode_cli" => format!("opencode \"Resume task from Ronic Context Copy #{}\" --file \"{path}\"", pkg.copy_id),
        _ => pkg.cli_command_pointer.clone(),
    };
    format!("{line}\r\n")
}

fn write_cursor_rule(project: &str, rule: &str) -> Result<String, String> {
    let project = project.trim();
    if project.is_empty() || !Path::new(project).is_dir() {
        return Err("Set the project folder before writing the Cursor rule.".into());
    }
    let path = PathBuf::from(project).join(".cursor").join("rules").join("ronic-context-copy.mdc");
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, rule).map_err(|e| e.to_string())?;
    Ok(path.display().to_string())
}

fn inject_js(payload: &str, submit: bool) -> String {
    let literal = serde_json::to_string(payload).unwrap_or_else(|_| "\"\"".into());
    let submit = if submit { "true" } else { "false" };
    format!(
        r#"(function(){{const payload={literal};const el=document.querySelector('textarea, [contenteditable="true"]');if(!el)return;el.focus();if('value' in el){{el.value=payload;el.dispatchEvent(new Event('input',{{bubbles:true}}));}}else{{el.textContent=payload;}}if({submit}){{const btn=document.querySelector('button[type="submit"], button[aria-label*="Send" i]');if(btn)btn.click();}}}})();"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slices(goal: bool, git: bool) -> ContextSliceSelection {
        ContextSliceSelection {
            include_goal_and_dod: goal,
            include_git_ast_diff: git,
            include_pty_terminal_trace: false,
            include_browser_dom_som: false,
            include_mem0_facts: false,
        }
    }

    #[test]
    fn git_slice_drops_secret_files_and_stays_empty() {
        assert_eq!(git_slice(""), "");
        let kept = git_slice(" M src/a.rs\n?? .env\n?? secrets.json\n?? readme.md\n?? id_rsa.pem\n");
        assert!(kept.contains("src/a.rs"));
        assert!(kept.contains("readme.md"));
        assert!(!kept.contains(".env"));
        assert!(!kept.contains("secrets.json"));
        assert!(!kept.contains(".pem"));
    }

    #[test]
    fn compile_keeps_selected_slices_and_scrubs_the_key() {
        let mut redactions = 0;
        let goal = scrub("finish the checkout sk-ant-api03-abcdefghijklmnopqrstuvwxyz", &mut redactions);
        let gathered = Gathered {
            source: "@claude".into(),
            trigger: "manual_1shot".into(),
            slices: slices(true, false),
            goal,
            git: "M src/a.rs".into(),
            pty: String::new(),
            browser: String::new(),
            facts: String::new(),
            redactions,
        };
        let pkg = compile(&gathered, Path::new("C:/latest.md"));
        assert!(pkg.webapp_xml_markdown.contains("Objective and hand-off"));
        assert!(pkg.webapp_xml_markdown.contains("***REDACTED***"));
        assert!(!pkg.webapp_xml_markdown.contains("abcdefghijklmnopqrstuvwxyz"));
        assert!(!pkg.webapp_xml_markdown.contains("src/a.rs"));
        assert!(pkg.secrets_scrubbed >= 1);
        assert!(pkg.compressed_tokens > 0);
        assert!(pkg.compressed_tokens < 500);
        assert!(pkg.cli_command_pointer.contains("latest.md"));
        assert!(pkg.cursor_ide_mdc_rule.contains(&pkg.copy_id));
    }

    #[test]
    fn a_chat_copy_keeps_the_turns_and_a_page_copy_reads_the_text() {
        let chat = format_turns("Ada", "Checkout", &[("user".into(), "ship the cart".into()), ("assistant".into(), "done".into())], "keep the note");
        assert!(chat.contains("Bot: Ada"));
        assert!(chat.contains("You: ship the cart"));
        assert!(chat.contains("Ada: done"));
        assert!(chat.contains("Note: keep the note"));
        assert_eq!(format_turns("", "Empty", &[], ""), "Chat: Empty\nThis chat has no messages yet.");
        let page = page_text(r#""{\"title\":\"Grok\",\"url\":\"https://grok.com\",\"text\":\"hello there\"}""#);
        assert!(page.contains("Title: Grok"));
        assert!(page.contains("hello there"));
        assert!(!page.contains("sk-"));
    }
}
