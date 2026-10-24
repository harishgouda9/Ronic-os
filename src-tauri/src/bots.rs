use crate::db::{self, insert_step_in, kv_get, kv_set};
use crate::error::{err, Result};
use crate::models::BotProfile;
use crate::util::{nid, now_ms};
use regex::Regex;
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

#[allow(dead_code)]
pub struct BotFlags {
    pub id: String,
    pub handle: String,
    pub soul: String,
    pub role: String,
    pub primary: String,
    pub allow_code: bool,
    pub allow_computer: bool,
    pub allow_browser: bool,
    pub allow_file: bool,
    pub require_external: bool,
    pub require_wallet: bool,
    pub stall_ms: i64,
    pub takeover: bool,
}

pub struct NextBot {
    pub id: String,
    pub handle: String,
    pub mode: String,
}

pub fn ensure_computer(conn: &Connection, home: &Path, profile: &mut BotProfile) -> Result<()> {
    let partition = if profile.browser_partition.trim().is_empty() {
        format!("persist:bot_{}", profile.id)
    } else {
        profile.browser_partition.clone()
    };
    let dir = match crate::bot_screen::shell_cwd(home, &profile.id, &profile.workspace_dir) {
        Ok(dir) => dir,
        Err(_) => {
            profile.workspace_files.clear();
            fill_screen(conn, profile);
            return Ok(());
        }
    };
    let dir_text = dir.display().to_string();
    let stall = if profile.stall_timeout_ms <= 0 { 45_000 } else { profile.stall_timeout_ms };
    let status = if profile.status_line.trim().is_empty() { "Ready for tasks".to_string() } else { profile.status_line.clone() };
    let same = profile.browser_partition == partition && profile.workspace_dir == dir_text && profile.stall_timeout_ms == stall && profile.status_line == status;
    if !same || !dir.is_dir() {
        fs::create_dir_all(&dir)?;
        conn.execute(
            "UPDATE bot_profiles SET browser_partition=?1, workspace_dir=?2, stall_timeout_ms=?3, status_line=?4 WHERE id=?5",
            params![partition, dir_text, stall, status, profile.id],
        )?;
        profile.browser_partition = partition;
        profile.workspace_dir = dir_text;
        profile.stall_timeout_ms = stall;
        profile.status_line = status;
    }
    profile.workspace_files = list_workspace(&dir);
    fill_screen(conn, profile);
    Ok(())
}

fn fill_screen(conn: &Connection, profile: &mut BotProfile) {
    let (url, nodes, ms, shell) = crate::bot_screen::load_screen(conn, &profile.id);
    profile.screen_url = url;
    profile.screen_nodes = nodes;
    profile.screen_ms = ms;
    profile.shell_output = shell;
    profile.takeover = kv_get(conn, &takeover_key(&profile.id)).ok().flatten().as_deref() == Some("1");
}

pub fn flags(conn: &Connection, id: &str) -> Result<BotFlags> {
    let row = conn.query_row(
        "SELECT handle, soul_markdown, primary_account_id, allow_code_exec, allow_computer_use, allow_browser_use, allow_file_write, require_approval_external, require_approval_wallet, stall_timeout_ms, role FROM bot_profiles WHERE id=?1",
        params![id],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, i64>(7)?,
                row.get::<_, i64>(8)?,
                row.get::<_, i64>(9)?,
                row.get::<_, String>(10)?,
            ))
        },
    ).map_err(|_| err("profile not found"))?;
    Ok(BotFlags {
        id: id.to_string(),
        handle: row.0,
        soul: row.1,
        primary: row.2,
        allow_code: row.3 != 0,
        allow_computer: row.4 != 0,
        allow_browser: row.5 != 0,
        allow_file: row.6 != 0,
        require_external: row.7 != 0,
        require_wallet: row.8 != 0,
        stall_ms: if row.9 <= 0 { 45_000 } else { row.9 },
        takeover: kv_get(conn, &takeover_key(id))?.as_deref() == Some("1"),
        role: row.10,
    })
}

pub fn mentioned(conn: &Connection, thread_id: &str, prompt: &str, fallback: &str) -> Result<String> {
    let members = member_ids(conn, thread_id)?;
    if members.is_empty() {
        return Ok(fallback.to_string());
    }
    let mut best: Option<(usize, String)> = None;
    let lower = prompt.to_ascii_lowercase();
    for id in members {
        let handle: String = conn.query_row("SELECT handle FROM bot_profiles WHERE id=?1", params![id], |row| row.get(0)).unwrap_or_default();
        let needle = handle.to_ascii_lowercase();
        if needle.len() < 2 {
            continue;
        }
        if lower.contains(&needle) && best.as_ref().map(|(len, _)| needle.len() > *len).unwrap_or(true) {
            best = Some((needle.len(), id));
        }
    }
    Ok(best.map(|(_, id)| id).unwrap_or_else(|| fallback.to_string()))
}

pub fn next_member(conn: &Connection, thread_id: &str, current: &str, already: &[String]) -> Result<Option<NextBot>> {
    let Some((mode, lead, members)) = group_of_thread(conn, thread_id)? else {
        return Ok(None);
    };
    if members.len() < 2 {
        return Ok(None);
    }
    let next_id = match mode.as_str() {
        "parallel_swarm" => members.into_iter().find(|id| id != current && !already.contains(id)),
        "lead_delegated" => {
            let lead = if lead.is_empty() { String::new() } else { lead };
            if !lead.is_empty() && current == lead {
                members.into_iter().find(|id| id != &lead && !already.contains(id))
            } else {
                None
            }
        }
        _ => {
            let idx = members.iter().position(|id| id == current).unwrap_or(0);
            members.get(idx + 1).filter(|id| !already.contains(id)).cloned()
        }
    };
    let Some(id) = next_id else {
        return Ok(None);
    };
    let handle: String = conn.query_row("SELECT handle FROM bot_profiles WHERE id=?1", params![id], |row| row.get(0)).unwrap_or_else(|_| id.clone());
    Ok(Some(NextBot { id, handle, mode }))
}

pub fn apply_setup(conn: &Connection, bot_id: &str, prompt: &str) -> Result<Option<String>> {
    let trimmed = prompt.trim();
    let lower = trimmed.to_ascii_lowercase();
    if let Some(rest) = lower.strip_prefix("rename to ").map(|_| &trimmed["rename to ".len()..]) {
        let name = rest.trim();
        if name.is_empty() {
            return Ok(Some("Say rename to, then the new name.".into()));
        }
        let handle = if name.starts_with('@') {
            name.to_string()
        } else {
            format!("@{}", name.replace(' ', "-"))
        };
        let clash: i64 = conn.query_row(
            "SELECT COUNT(*) FROM bot_profiles WHERE handle=?1 AND id<>?2",
            params![handle, bot_id],
            |row| row.get(0),
        )?;
        if clash > 0 {
            return Ok(Some(format!("{handle} is already used by another bot.")));
        }
        conn.execute(
            "UPDATE bot_profiles SET handle=?1, display_name=?2, status_line='Renamed from chat' WHERE id=?3",
            params![handle, name.trim_start_matches('@'), bot_id],
        )?;
        return Ok(Some(format!("Renamed this bot to {handle}.")));
    }
    let status: String = conn.query_row("SELECT status_line FROM bot_profiles WHERE id=?1", params![bot_id], |row| row.get(0)).unwrap_or_default();
    let fresh = status == "Ready for tasks" || status.starts_with("Just created");
    let job = lower.starts_with("you are my ") || lower.starts_with("you're my ") || lower.starts_with("your job is ") || (fresh && (lower.starts_with("you are ") || lower.starts_with("you're ")));
    if job {
        let line = clip_target(trimmed);
        conn.execute("UPDATE bot_profiles SET soul_markdown=?1, status_line=?2 WHERE id=?3", params![trimmed, line, bot_id])?;
        return Ok(Some("Saved that as this bot's job. Send the first task when you want it to start.".into()));
    }
    Ok(None)
}

pub fn external_action(prompt: &str) -> bool {
    let lower = prompt.to_ascii_lowercase();
    if lower.contains("send to ") || lower.contains("send an email") || lower.contains("send the email") || lower.contains("post to ") || lower.contains("wire transfer") {
        return true;
    }
    Regex::new(r"\b(email|e-mail|slack|merge|submit|charge|publish|tweet)\b")
        .map(|re| re.is_match(&lower))
        .unwrap_or(false)
}

pub fn clip_target(prompt: &str) -> String {
    let line = prompt.lines().next().unwrap_or("").trim();
    let mut text = line.to_string();
    if text.chars().count() > 120 {
        text = text.chars().take(120).collect();
        text.push('…');
    }
    text
}

pub fn is_denied(conn: &Connection, bot_id: &str, surface: &str, target: &str) -> Result<bool> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM bot_gateway_audit_logs WHERE bot_id=?1 AND tool_or_surface=?2 AND target_resource=?3 AND gateway_decision='denied_by_rule'",
        params![bot_id, surface, target],
        |row| row.get(0),
    )?;
    Ok(n > 0)
}

pub fn audit(conn: &Connection, bot_id: &str, conversation_id: &str, surface: &str, target: &str, decision: &str, rule: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO bot_gateway_audit_logs (id, bot_id, conversation_id, tool_or_surface, target_resource, gateway_decision, rule_matched, recorded_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        params![nid("aud"), bot_id, conversation_id, surface, target, decision, rule, now_ms()],
    )?;
    Ok(())
}

pub fn hold(conn: &Connection, thread_id: &str, turn_id: &str, bot: &BotFlags, kind: &str, prompt: &str, amount: Option<f64>, surface: &str, target: &str) -> Result<()> {
    let sentence = if kind == "wallet" {
        format!("{} wants to spend {target} on the sandbox wallet. Nothing moves until you approve.", bot.handle)
    } else {
        format!("{} wants to take an external action. Nothing is sent until you approve.", bot.handle)
    };
    let payload = json!({
        "approvalState": "pending",
        "botId": bot.id,
        "botHandle": bot.handle,
        "kind": kind,
        "prompt": prompt,
        "amountUsd": amount,
        "surface": surface,
        "target": target,
    });
    insert_step_in(conn, thread_id, turn_id, "system", &bot.handle, &sentence, "gateway_approval", &payload, 0)?;
    audit(conn, &bot.id, thread_id, surface, target, "held_for_approval", "fail_closed")?;
    Ok(())
}

pub fn note_stall(conn: &Connection, bot_id: &str, thread_id: &str, ms: i64) -> Result<()> {
    audit(conn, bot_id, thread_id, "agent.stream_stalled", &format!("{ms}ms"), "stalled", "AGENT_STALL_TIMEOUT_MS")?;
    Ok(())
}

pub fn touch_status(conn: &Connection, bot_id: &str, reply: &str) -> Result<()> {
    let line = clip_target(reply);
    if line.is_empty() {
        return Ok(());
    }
    conn.execute("UPDATE bot_profiles SET status_line=?1 WHERE id=?2", params![line, bot_id])?;
    Ok(())
}

pub fn set_takeover(conn: &Connection, bot_id: &str, on: bool) -> Result<()> {
    let n: i64 = conn.query_row("SELECT COUNT(*) FROM bot_profiles WHERE id=?1", params![bot_id], |row| row.get(0))?;
    if n == 0 {
        return Err(err("profile not found"));
    }
    kv_set(conn, &takeover_key(bot_id), if on { "1" } else { "0" })?;
    let line = if on { "You have control of this computer" } else { "Ready for tasks" };
    conn.execute("UPDATE bot_profiles SET status_line=?1 WHERE id=?2", params![line, bot_id])?;
    Ok(())
}

pub fn create_group(conn: &Connection, home: &Path, title: &str, purpose: &str, mode: &str, members: &[String]) -> Result<String> {
    let mode = match mode {
        "parallel_swarm" | "lead_delegated" | "autonomous_handoff" => mode,
        _ => return Err(err("unknown coordination mode")),
    };
    let unique = unique_members(conn, members)?;
    if unique.len() < 2 || unique.len() > 8 {
        return Err(err("a group needs 2 to 8 bots"));
    }
    let handle = group_handle(title)?;
    let clash: i64 = conn.query_row("SELECT COUNT(*) FROM bot_groups WHERE group_handle=?1", params![handle], |row| row.get(0))?;
    if clash > 0 {
        return Err(err("that group name is already used"));
    }
    let id = nid("grp");
    let dir = home.join("bots").join("groups").join(&id).join("workspace");
    fs::create_dir_all(&dir)?;
    let lead = unique[0].clone();
    conn.execute(
        "INSERT INTO bot_groups (id, group_handle, title, purpose, coordination_mode, lead_bot_id, member_bot_ids_json, shared_workspace_dir, routine_schedule, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'',?9)",
        params![id, handle, title.trim(), purpose.trim(), mode, lead, json!(unique).to_string(), dir.display().to_string(), now_ms()],
    )?;
    Ok(id)
}

pub fn open_group(conn: &Connection, group_id: &str) -> Result<()> {
    let (handle, lead, members_json): (String, String, String) = conn.query_row(
        "SELECT group_handle, lead_bot_id, member_bot_ids_json FROM bot_groups WHERE id=?1",
        params![group_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).map_err(|_| err("group not found"))?;
    let existing: Option<String> = conn.query_row(
        "SELECT id FROM chat_threads WHERE group_id=?1 ORDER BY updated_at DESC LIMIT 1",
        params![group_id],
        |row| row.get(0),
    ).ok();
    let thread_id = if let Some(id) = existing {
        id
    } else {
        let members: Vec<String> = serde_json::from_str(&members_json).unwrap_or_default();
        let owner = if lead.is_empty() { members.first().cloned().unwrap_or_default() } else { lead };
        if owner.is_empty() {
            return Err(err("group has no bots"));
        }
        let id = nid("thread");
        conn.execute(
            "INSERT INTO chat_threads (id, bot_profile_id, title, status, compacted_context_capsule, is_pinned, updated_at, target_type, group_id, routine_schedule) VALUES (?1,?2,?3,'idle','',0,?4,'bot_group',?5,'')",
            params![id, owner, handle, now_ms(), group_id],
        )?;
        id
    };
    kv_set(conn, "active_thread", &thread_id)?;
    let owner: String = conn.query_row("SELECT bot_profile_id FROM chat_threads WHERE id=?1", params![thread_id], |row| row.get(0))?;
    kv_set(conn, "active_profile", &owner)?;
    Ok(())
}

pub fn set_mode(conn: &Connection, group_id: &str, mode: &str) -> Result<()> {
    let mode = match mode {
        "parallel_swarm" | "lead_delegated" | "autonomous_handoff" => mode,
        _ => return Err(err("unknown coordination mode")),
    };
    let n = conn.execute("UPDATE bot_groups SET coordination_mode=?1 WHERE id=?2", params![mode, group_id])?;
    if n == 0 {
        return Err(err("group not found"));
    }
    Ok(())
}

pub fn set_routine(conn: &Connection, thread_id: &str, schedule: &str) -> Result<()> {
    db::require_thread(conn, thread_id)?;
    let schedule = schedule.trim();
    conn.execute("UPDATE chat_threads SET routine_schedule=?1, updated_at=?2 WHERE id=?3", params![schedule, now_ms(), thread_id])?;
    let group_id: String = conn.query_row("SELECT group_id FROM chat_threads WHERE id=?1", params![thread_id], |row| row.get(0)).unwrap_or_default();
    if !group_id.is_empty() {
        conn.execute("UPDATE bot_groups SET routine_schedule=?1 WHERE id=?2", params![schedule, group_id])?;
    }
    Ok(())
}

pub fn routine_prompt(conn: &Connection, thread_id: &str) -> Result<String> {
    db::require_thread(conn, thread_id)?;
    let saved: Option<String> = conn.query_row(
        "SELECT content_markdown FROM execution_steps WHERE thread_id=?1 AND role='user' ORDER BY created_at DESC LIMIT 1",
        params![thread_id],
        |row| row.get(0),
    ).ok();
    if let Some(text) = saved.filter(|text| !text.trim().is_empty()) {
        return Ok(text);
    }
    let group_id: String = conn.query_row("SELECT group_id FROM chat_threads WHERE id=?1", params![thread_id], |row| row.get(0)).unwrap_or_default();
    if !group_id.is_empty() {
        let purpose: String = conn.query_row("SELECT purpose FROM bot_groups WHERE id=?1", params![group_id], |row| row.get(0)).unwrap_or_default();
        if !purpose.trim().is_empty() {
            return Ok(purpose);
        }
    }
    let title: String = conn.query_row("SELECT title FROM chat_threads WHERE id=?1", params![thread_id], |row| row.get(0))?;
    Ok(title)
}

pub fn teach(conn: &Connection, home: &Path, bot_id: &str, title: &str, notes: &str, url: &str) -> Result<String> {
    let n: i64 = conn.query_row("SELECT COUNT(*) FROM bot_profiles WHERE id=?1", params![bot_id], |row| row.get(0))?;
    if n == 0 {
        return Err(err("profile not found"));
    }
    let title = if title.trim().is_empty() { "Taught workflow".to_string() } else { title.trim().to_string() };
    let slug = {
        let raw = slugify(&title);
        if raw.is_empty() { "taught-workflow".to_string() } else { raw }
    };
    let body = format!("---\nname: {slug}\ndescription: Taught from a demonstration on this bot's computer.\n---\n\n# {title}\n\nURL: {url}\n\n{}\n", if notes.trim().is_empty() { "The person demonstrated this workflow and asked to save it." } else { notes.trim() });
    crate::capabilities::save_skill(conn, home, crate::capabilities::SkillDraft {
        id: String::new(),
        profile_id: bot_id.to_string(),
        slug: slug.clone(),
        title: title.clone(),
        description: clip_target(notes),
        slash_command: format!("/{slug}"),
        requires_tools: Vec::new(),
        platforms: vec!["windows".into(), "macos".into(), "linux".into()],
        body: body.clone(),
        files: Vec::new(),
    })?;
    let workspace: String = conn.query_row("SELECT workspace_dir FROM bot_profiles WHERE id=?1", params![bot_id], |row| row.get(0)).unwrap_or_default();
    if !workspace.trim().is_empty() {
        let path = Path::new(workspace.trim()).join("skills").join(&slug).join("SKILL.md");
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(path, &body)?;
    }
    if let Some(thread_id) = kv_get(conn, "active_thread")? {
        if db::require_thread(conn, &thread_id).is_ok() {
            let handle: String = conn.query_row("SELECT handle FROM bot_profiles WHERE id=?1", params![bot_id], |row| row.get(0)).unwrap_or_default();
            insert_step_in(
                conn,
                &thread_id,
                &nid("turn"),
                "assistant",
                &handle,
                &format!("Saved this demonstration as /{slug}. It is on this bot's skill list."),
                "message",
                &json!({"kind": "taught_skill", "slug": format!("/{slug}"), "url": url}),
                0,
            )?;
        }
    }
    Ok(format!("/{slug}"))
}

pub fn attach_names(conn: &Connection, home: &Path, bot_id: &str, skills: &str, plugins: &str) -> Result<()> {
    for token in split_list(skills) {
        let needle = token.trim_start_matches('/').to_ascii_lowercase();
        if needle.is_empty() {
            continue;
        }
        let view = crate::capabilities::view(conn, home, bot_id)?;
        if let Some(skill) = view.skills.iter().find(|skill| skill.slug.trim_start_matches('/').eq_ignore_ascii_case(&needle) || skill.slash_command.trim_start_matches('/').eq_ignore_ascii_case(&needle)) {
            let _ = crate::capabilities::toggle_skill(conn, home, &skill.id, bot_id, true);
        }
    }
    for token in split_list(plugins) {
        let needle = token.to_ascii_lowercase();
        let view = crate::capabilities::view(conn, home, bot_id)?;
        if let Some(plugin) = view.plugins.iter().find(|plugin| plugin.slug.eq_ignore_ascii_case(&needle) || plugin.name.eq_ignore_ascii_case(token)) {
            let _ = crate::capabilities::toggle_plugin_agent(conn, &plugin.id, bot_id, true);
        }
    }
    Ok(())
}

enum DecideNext {
    Done(String),
    Run { prompt: String, thread_id: String },
}

fn decide_locked(conn: &Connection, step_id: &str, approve: bool) -> Result<DecideNext> {
    let (thread_id, raw): (String, String) = conn.query_row(
        "SELECT thread_id, action_payload_json FROM execution_steps WHERE id=?1 AND action_type='gateway_approval'",
        params![step_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).map_err(|_| err("approval not found"))?;
    let mut payload: Value = serde_json::from_str(&raw).unwrap_or_else(|_| json!({}));
    if payload.get("approvalState").and_then(|value| value.as_str()) != Some("pending") {
        return Err(err("that approval is already decided"));
    }
    let bot_id = payload.get("botId").and_then(|value| value.as_str()).unwrap_or("").to_string();
    let surface = payload.get("surface").and_then(|value| value.as_str()).unwrap_or("gateway").to_string();
    let target = payload.get("target").and_then(|value| value.as_str()).unwrap_or("").to_string();
    let kind = payload.get("kind").and_then(|value| value.as_str()).unwrap_or("external").to_string();
    let prompt = payload.get("prompt").and_then(|value| value.as_str()).unwrap_or("").to_string();
    let amount = payload.get("amountUsd").and_then(|value| value.as_f64());
    if !approve {
        payload["approvalState"] = json!("declined");
        conn.execute("UPDATE execution_steps SET action_payload_json=?1 WHERE id=?2", params![payload.to_string(), step_id])?;
        audit(conn, &bot_id, &thread_id, &surface, &target, "denied_by_rule", "user_deny")?;
        insert_step_in(conn, &thread_id, &nid("turn"), "assistant", "gateway", "Declined. A deny rule was saved for this action.", "message", &json!({}), 0)?;
        return Ok(DecideNext::Done("Declined. A deny rule was saved.".into()));
    }
    payload["approvalState"] = json!("approved");
    conn.execute("UPDATE execution_steps SET action_payload_json=?1 WHERE id=?2", params![payload.to_string(), step_id])?;
    audit(conn, &bot_id, &thread_id, &surface, &target, "allowed", "user_approve")?;
    kv_set(conn, "active_thread", &thread_id)?;
    if kind == "wallet" {
        let Some(amount) = amount else {
            return Err(err("the held spend has no amount"));
        };
        let native = format!("${amount:.2}");
        let note = match crate::wallet::settle(conn, &bot_id, "crypto_x402", amount, &native, "agent-request", &prompt, "agent", "x402", None, "spend") {
            Ok(note) => note,
            Err(error) => error.0,
        };
        insert_step_in(conn, &thread_id, &nid("turn"), "tool", "policy-gate", &note, "wallet_tx", &json!({"note": note, "amountUsd": amount, "rail": "crypto_x402"}), 1)?;
        return Ok(DecideNext::Done(note));
    }
    kv_set(conn, &format!("skip_gate:{thread_id}"), "1")?;
    Ok(DecideNext::Run { prompt, thread_id })
}

pub fn decide(state: &crate::AppState, step_id: &str, approve: bool, secrets: &std::collections::HashMap<String, String>, provider: Option<&str>, model: Option<&str>, effort: Option<&str>) -> Result<String> {
    let next = {
        let conn = state.conn.lock().unwrap_or_else(|poison| poison.into_inner());
        decide_locked(&conn, step_id, approve)?
    };
    match next {
        DecideNext::Done(note) => Ok(note),
        DecideNext::Run { prompt, thread_id } => {
            let result = crate::agent::dispatch(state, &prompt, secrets, provider, model, effort, &[]);
            if result.is_err() {
                let conn = state.conn.lock().unwrap_or_else(|poison| poison.into_inner());
                let _ = crate::db::kv_set(&conn, &format!("skip_gate:{thread_id}"), "");
            }
            result
        }
    }
}

pub fn account_for_harness(harness: &str) -> Option<&'static str> {
    match harness {
        "claude_cli" => Some("prov_claude"),
        "agy_cli" => Some("prov_gemini"),
        "codex_cli" => Some("prov_chatgpt"),
        "grok_web" => Some("prov_grok"),
        _ => None,
    }
}

fn takeover_key(id: &str) -> String {
    format!("takeover:{id}")
}

fn member_ids(conn: &Connection, thread_id: &str) -> Result<Vec<String>> {
    Ok(group_of_thread(conn, thread_id)?.map(|(_, _, members)| members).unwrap_or_default())
}

fn group_of_thread(conn: &Connection, thread_id: &str) -> Result<Option<(String, String, Vec<String>)>> {
    let row: Option<(String, String)> = conn.query_row(
        "SELECT target_type, group_id FROM chat_threads WHERE id=?1",
        params![thread_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).ok();
    let Some((target, group_id)) = row else {
        return Ok(None);
    };
    if target != "bot_group" || group_id.is_empty() {
        return Ok(None);
    }
    let found: Option<(String, String, String)> = conn.query_row(
        "SELECT coordination_mode, lead_bot_id, member_bot_ids_json FROM bot_groups WHERE id=?1",
        params![group_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).ok();
    let Some((mode, lead, raw)) = found else {
        return Ok(None);
    };
    let members = serde_json::from_str(&raw).unwrap_or_default();
    Ok(Some((mode, lead, members)))
}

fn unique_members(conn: &Connection, members: &[String]) -> Result<Vec<String>> {
    let mut out = Vec::new();
    for id in members {
        let id = id.trim();
        if id.is_empty() || out.iter().any(|seen: &String| seen == id) {
            continue;
        }
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM bot_profiles WHERE id=?1", params![id], |row| row.get(0))?;
        if n == 0 {
            return Err(err("a selected bot no longer exists"));
        }
        out.push(id.to_string());
    }
    Ok(out)
}

fn group_handle(title: &str) -> Result<String> {
    let raw = title.trim().trim_start_matches('#').trim();
    let slug = slugify(raw);
    if slug.is_empty() {
        return Err(err("a group needs a name"));
    }
    Ok(format!("#{slug}"))
}

fn slugify(value: &str) -> String {
    let mut out = String::new();
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    out.trim_matches('-').chars().take(40).collect()
}

fn split_list(value: &str) -> Vec<&str> {
    value.split([',', '\n']).map(str::trim).filter(|token| !token.is_empty()).collect()
}

fn list_workspace(dir: &Path) -> Vec<String> {
    let mut names = Vec::new();
    let Ok(read) = fs::read_dir(dir) else {
        return names;
    };
    for entry in read.flatten() {
        if names.len() >= 24 {
            break;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        names.push(name);
    }
    names.sort();
    names
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn temp_db() -> (std::path::PathBuf, Connection) {
        let home = std::env::temp_dir().join(format!("omni-bots-{}-{}", std::process::id(), now_ms()));
        let _ = fs::remove_dir_all(&home);
        fs::create_dir_all(&home).unwrap();
        let conn = db::open(&home.join("state.db")).unwrap();
        db::migrate(&conn).unwrap();
        db::seed_if_empty(&conn, &home).unwrap();
        (home, conn)
    }

    fn bot(conn: &Connection, id: &str, handle: &str) {
        conn.execute(
            "INSERT INTO bot_profiles (id, handle, display_name, avatar, soul_markdown, primary_account_id, long_context_account_id, fallback_account_id, created_at) VALUES (?1,?2,?2,'NW','soul','prov_ollama','prov_gemini','prov_openrouter',1)",
            params![id, handle],
        ).unwrap();
    }

    #[test]
    fn group_handoff_and_wallet_hold() {
        let (home, conn) = temp_db();
        bot(&conn, "bot_a", "@alpha");
        bot(&conn, "bot_b", "@beta");
        let id = create_group(&conn, &home, "Launch squad", "Ship the patch", "autonomous_handoff", &["bot_a".into(), "bot_b".into()]).unwrap();
        open_group(&conn, &id).unwrap();
        let thread: String = kv_get(&conn, "active_thread").unwrap().unwrap();
        let flags = flags(&conn, "bot_a").unwrap();
        assert!(flags.require_wallet);
        hold(&conn, &thread, "turn", &flags, "wallet", "pay $12", Some(12.0), "wallet.x402", "$12.00").unwrap();
        let pending: String = conn.query_row("SELECT action_payload_json FROM execution_steps WHERE action_type='gateway_approval'", [], |row| row.get(0)).unwrap();
        assert!(pending.contains("pending"));
        let step_id: String = conn.query_row("SELECT id FROM execution_steps WHERE action_type='gateway_approval'", [], |row| row.get(0)).unwrap();
        let note = decide_locked(&conn, &step_id, false).unwrap();
        let DecideNext::Done(note) = note else {
            panic!("a decline must not start a model turn");
        };
        assert!(note.contains("deny"));
        assert!(is_denied(&conn, "bot_a", "wallet.x402", "$12.00").unwrap());
        let next = next_member(&conn, &thread, "bot_a", &["bot_a".into()]).unwrap().unwrap();
        assert_eq!(next.handle, "@beta");
        assert!(external_action("submit the checkout form"));
        assert!(!external_action("summarize the docs"));
        let _ = fs::remove_dir_all(&home);
    }
}
