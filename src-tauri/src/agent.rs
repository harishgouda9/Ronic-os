use crate::db::{self, insert_step_in};
use crate::error::{err, Result};
use crate::redact::redact;
use crate::util::{now_ms, run_capture, truncate_utf8};
use crate::wallet;
use crate::AppState;
use tauri::{Emitter, Manager};
use regex::Regex;
use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const HISTORY_BUDGET: usize = 12_000;
const TOOL_ROUNDS: usize = 16;
static NEXT_TICKET: AtomicU64 = AtomicU64::new(1);
static TURN_OWNER: AtomicU64 = AtomicU64::new(0);

struct TurnGuard {
    ticket: u64,
}
impl Drop for TurnGuard {
    fn drop(&mut self) {
        let _ = TURN_OWNER.compare_exchange(self.ticket, 0, Ordering::SeqCst, Ordering::SeqCst);
    }
}

static TURN_EPOCH: AtomicU64 = AtomicU64::new(1);
static CLIENT_EPOCH: AtomicU64 = AtomicU64::new(1);

pub fn release_turn() {
    TURN_OWNER.store(0, Ordering::SeqCst);
    TURN_EPOCH.fetch_add(1, Ordering::SeqCst);
    CLIENT_EPOCH.fetch_add(1, Ordering::SeqCst);
}

fn turn_epoch() -> u64 {
    TURN_EPOCH.load(Ordering::SeqCst)
}

fn reply_was_cleared(error: &str) -> bool {
    error.contains("reply was cleared")
}

#[derive(Clone)]
struct ToolCall {
    id: String,
    name: String,
    arguments: String,
}

#[derive(Clone)]
struct ChatMsg {
    role: String,
    content: String,
    name: String,
    tool_call_id: String,
    tool_calls: Vec<ToolCall>,
}

impl ChatMsg {
    fn new(role: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            role: role.into(),
            content: content.into(),
            name: String::new(),
            tool_call_id: String::new(),
            tool_calls: Vec::new(),
        }
    }

    fn assistant_tools(content: impl Into<String>, tool_calls: Vec<ToolCall>) -> Self {
        Self {
            role: "assistant".into(),
            content: content.into(),
            name: String::new(),
            tool_call_id: String::new(),
            tool_calls,
        }
    }

    fn tool_result(id: impl Into<String>, name: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            role: "tool".into(),
            content: content.into(),
            name: name.into(),
            tool_call_id: id.into(),
            tool_calls: Vec::new(),
        }
    }
}

struct Completion {
    text: String,
    thinking: String,
    tool_calls: Vec<ToolCall>,
}

enum AfterPrep {
    Done(String),
    Audit { thread_id: String, turn_id: String, root: String },
    Talk {
        thread_id: String,
        turn_id: String,
        bot_id: String,
        composed: String,
        settings: crate::models::Settings,
        effort: String,
        pinned: bool,
        speaker_handle: String,
    },
}

enum BotTurn {
    Spoke(String),
    Paused(String),
}

fn with_db<T>(state: &AppState, f: impl FnOnce(&Connection) -> T) -> T {
    let conn = state.conn.lock().unwrap_or_else(|poison| poison.into_inner());
    f(&conn)
}

pub fn strip_directives(text: &str) -> String {
    let mut s = text.to_string();
    while let Some(start) = s.find("[APPROVAL MODE:") {
        if let Some(end) = s[start..].find(']') {
            s.replace_range(start..start + end + 1, "");
        } else {
            break;
        }
    }
    while let Some(start) = s.find("[FORMATTING DIRECTIVE:") {
        if let Some(end) = s[start..].find(']') {
            s.replace_range(start..start + end + 1, "");
        } else {
            break;
        }
    }
    s.trim().to_string()
}

pub fn dispatch(state: &AppState, prompt: &str, secrets: &HashMap<String, String>, provider_override: Option<&str>, model: Option<&str>, effort: Option<&str>, attachments: &[String]) -> Result<String> {
    let clean = strip_directives(prompt);
    let prompt = clean.trim();
    if prompt.is_empty() && attachments.is_empty() {
        return Err(err("write a task first"));
    }
    let mut ticket = NEXT_TICKET.fetch_add(1, Ordering::SeqCst);
    if ticket == 0 {
        ticket = NEXT_TICKET.fetch_add(1, Ordering::SeqCst);
    }
    if TURN_OWNER.compare_exchange(0, ticket, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        return Err(err("Still answering the previous message."));
    }
    let _turn = TurnGuard { ticket };
    let title_source = if prompt.is_empty() { "Read the attached files." } else { prompt };
    let prepared = with_db(state, |conn| prepare_turn(conn, title_source, prompt, provider_override, effort, attachments))?;
    match prepared {
        AfterPrep::Done(note) => Ok(note),
        AfterPrep::Audit { thread_id, turn_id, root } => {
            let started = Instant::now();
            let report = audit(Path::new(&root));
            let ms = started.elapsed().as_millis() as i64;
            with_db(state, |conn| {
                insert_step_in(conn, &thread_id, &turn_id, "tool", "local-operator", "Scanned the project root for secrets and private keys.", "pty_terminal", &json!({"command": "security-audit", "exitCode": 0, "output": report}), ms)?;
                finish(conn, &thread_id)?;
                Ok(format!("Security scan finished in {ms}ms"))
            })
        }
        AfterPrep::Talk { thread_id, turn_id, bot_id, composed, settings, effort, pinned, speaker_handle } => {
            let home = state.home.clone();
            with_db(state, |conn| crate::harness2_engine::arm_chat(conn, &home, prompt, attachments));
            let name = match answer_bot(state, &thread_id, &turn_id, &bot_id, secrets, model, &effort, &composed, &settings, true, pinned, attachments)? {
                BotTurn::Paused(note) => {
                    with_db(state, |conn| finish(conn, &thread_id))?;
                    return Ok(note);
                }
                BotTurn::Spoke(name) => name,
            };
            let mut current = bot_id;
            let mut already = vec![current.clone()];
            for _ in 0..2 {
                let Some(next) = with_db(state, |conn| crate::bots::next_member(conn, &thread_id, &current, &already))? else { break };
                let handle = next.handle.clone();
                let mode = next.mode.clone();
                let id = next.id.clone();
                with_db(state, |conn| -> Result<()> {
                    insert_step_in(
                        conn,
                        &thread_id,
                        &turn_id,
                        "system",
                        &speaker_handle,
                        &format!("Passing this on to {handle}."),
                        "bot_handoff",
                        &json!({"from": current, "to": handle, "mode": mode}),
                        0,
                    )?;
                    Ok(())
                })?;
                already.push(id.clone());
                match answer_bot(state, &thread_id, &turn_id, &id, secrets, None, &effort, &composed, &settings, false, false, attachments) {
                    Ok(BotTurn::Spoke(_)) => current = id,
                    Ok(BotTurn::Paused(_)) => break,
                    Err(error) => {
                        with_db(state, |conn| -> Result<()> {
                            insert_step_in(conn, &thread_id, &turn_id, "assistant", &handle, &error.0, "message", &json!({}), 0)?;
                            Ok(())
                        })?;
                        break;
                    }
                }
            }
            let home = state.home.clone();
            with_db(state, |conn| {
                crate::harness2_engine::note_mid_run(conn, &home, &thread_id, &turn_id);
                finish(conn, &thread_id)
            })?;
            Ok(name)
        }
    }
}

fn prepare_turn(conn: &Connection, title_source: &str, prompt: &str, provider_override: Option<&str>, effort: Option<&str>, attachments: &[String]) -> Result<AfterPrep> {
    ensure_thread(conn, title_source, provider_override)?;
    let thread_id = db::kv_get(conn, "active_thread")?.ok_or_else(|| err("no active thread"))?;
    db::require_thread(conn, &thread_id)?;
    let owner_id: String = conn.query_row("SELECT bot_profile_id FROM chat_threads WHERE id = ?1", params![thread_id], |r| r.get(0))?;
    // Wipe any live-activity markers left by an earlier turn so the pill
    // never shows a stale "working on X" line from before this send.
    conn.execute("DELETE FROM execution_steps WHERE action_type = 'turn_activity' AND thread_id = ?1", params![thread_id])?;
    let bot_id = crate::bots::mentioned(conn, &thread_id, prompt, &owner_id)?;
    let speaker = crate::bots::flags(conn, &bot_id)?;
    let turn_id = crate::util::nid("turn");
    // The user-visible bubble shows a clean summary — the prompt plus compact
    // attachment chips — not the multi-thousand-character inlined file dump the
    // model receives. `composed` still goes to the model unchanged, but it is
    // built only after the short-circuit gates below so a gated turn (wallet
    // hold, takeover pause) never pays to read and inline the attachments.
    let display = display_user_text(prompt, attachments);
    let skip_key = format!("skip_gate:{thread_id}");
    let skip = db::kv_get(conn, &skip_key)?.as_deref() == Some("1");
    if skip {
        db::kv_set(conn, &skip_key, "")?;
    }
    let last_user: String = conn.query_row(
        "SELECT content_markdown FROM execution_steps WHERE thread_id=?1 AND role='user' ORDER BY created_at DESC LIMIT 1",
        params![thread_id],
        |row| row.get(0),
    ).unwrap_or_default();
    // Match the stored step against the display text actually persisted (and
    // the bare prompt for the no-attachment case) so a gateway-retry with an
    // attachment never double-inserts the user bubble.
    let replay = skip && (last_user.trim() == prompt || last_user.trim() == display.trim());
    if !replay {
        insert_step_in(conn, &thread_id, &turn_id, "user", "", &display, "message", &json!({}), 0)?;
    }
    conn.execute("UPDATE chat_threads SET status = 'running' WHERE id = ?1", params![thread_id])?;

    if !replay {
        if let Some(note) = crate::bots::apply_setup(conn, &bot_id, prompt)? {
            insert_step_in(conn, &thread_id, &turn_id, "assistant", &speaker.handle, &note, "message", &json!({}), 0)?;
            finish(conn, &thread_id)?;
            return Ok(AfterPrep::Done(note));
        }
    }
    if speaker.takeover {
        let note = format!("{} is paused while you have control of its computer. Hand it back in the dock to continue.", speaker.handle);
        insert_step_in(conn, &thread_id, &turn_id, "assistant", &speaker.handle, &note, "message", &json!({}), 0)?;
        finish(conn, &thread_id)?;
        return Ok(AfterPrep::Done("Bot is paused while you have control.".into()));
    }

    let settings = db::settings_of(conn)?;
    if !skip {
        if let Some(amount) = payment_amount(prompt) {
            let target = format!("${amount:.2}");
            if crate::bots::is_denied(conn, &bot_id, "wallet.x402", &target)? {
                crate::bots::audit(conn, &bot_id, &thread_id, "wallet.x402", &target, "denied_by_rule", "user_deny")?;
                let note = format!("Denied. {} already has a deny rule for {target}.", speaker.handle);
                insert_step_in(conn, &thread_id, &turn_id, "assistant", &speaker.handle, &note, "message", &json!({}), 0)?;
                finish(conn, &thread_id)?;
                return Ok(AfterPrep::Done(note));
            }
            if speaker.require_wallet && speaker.approval_mode != "auto" {
                crate::bots::hold(conn, &thread_id, &turn_id, &speaker, "wallet", prompt, Some(amount), "wallet.x402", &target)?;
                finish(conn, &thread_id)?;
                return Ok(AfterPrep::Done("Held for your approval.".into()));
            }
            let native = format!("${amount:.4}");
            let note = match wallet::settle(conn, &bot_id, "crypto_x402", amount, &native, "agent-request", prompt, "agent", "x402", None, "spend") {
                Ok(note) => note,
                Err(e) => e.0,
            };
            let decision = if note.contains("pending_approval") { "held_for_approval" } else if note.contains("blocked") || note.contains("rejected") || note.contains("too low") { "denied_by_rule" } else { "allowed" };
            crate::bots::audit(conn, &bot_id, &thread_id, "wallet.x402", &target, decision, "wallet_policy")?;
            insert_step_in(conn, &thread_id, &turn_id, "tool", "policy-gate", "Wallet request passed through the Rust policy gate.", "wallet_tx", &json!({"note": note, "amountUsd": amount, "rail": "crypto_x402"}), 1)?;
            finish(conn, &thread_id)?;
            return Ok(AfterPrep::Done(note));
        }
        if speaker.require_external && speaker.approval_mode != "auto" && crate::bots::external_action(prompt) {
            let target = crate::bots::clip_target(prompt);
            if crate::bots::is_denied(conn, &bot_id, "external.send", &target)? {
                crate::bots::audit(conn, &bot_id, &thread_id, "external.send", &target, "denied_by_rule", "user_deny")?;
                let note = format!("Denied. {} already has a deny rule for this action.", speaker.handle);
                insert_step_in(conn, &thread_id, &turn_id, "assistant", &speaker.handle, &note, "message", &json!({}), 0)?;
                finish(conn, &thread_id)?;
                return Ok(AfterPrep::Done(note));
            }
            crate::bots::hold(conn, &thread_id, &turn_id, &speaker, "external", prompt, None, "external.send", &target)?;
            finish(conn, &thread_id)?;
            return Ok(AfterPrep::Done("Held for your approval.".into()));
        }
    }

    if prompt.starts_with("/security-audit") || prompt.to_ascii_lowercase().contains("security audit") {
        let root = if settings.project_root.is_empty() { ".".into() } else { settings.project_root.clone() };
        return Ok(AfterPrep::Audit { thread_id, turn_id, root });
    }

    // Build the model-facing text (read + inline the attachments) only now that
    // every short-circuit gate has passed and the turn will reach the model.
    let composed = compose_user_text(conn, prompt, attachments);

    Ok(AfterPrep::Talk {
        thread_id,
        turn_id,
        bot_id,
        composed,
        effort: normalize_effort(effort),
        pinned: provider_override.map(str::trim).filter(|value| !value.is_empty()).is_some(),
        speaker_handle: speaker.handle,
        settings,
    })
}

fn answer_bot(state: &AppState, thread_id: &str, turn_id: &str, bot_id: &str, secrets: &HashMap<String, String>, model: Option<&str>, effort: &str, composed: &str, settings: &crate::models::Settings, use_composer: bool, pinned: bool, attachments: &[String]) -> Result<BotTurn> {
    let ready = with_db(state, |conn| -> Result<std::result::Result<(crate::bots::BotFlags, String, String, Vec<Value>), String>> {
        let speaker = crate::bots::flags(conn, bot_id)?;
        if speaker.takeover {
            let note = format!("{} is paused while you have control of its computer.", speaker.handle);
            insert_step_in(conn, thread_id, turn_id, "assistant", &speaker.handle, &note, "message", &json!({}), 0)?;
            return Ok(Err(note));
        }
        let override_model: Option<String> = if use_composer {
            conn.query_row("SELECT active_model_override_id FROM chat_threads WHERE id=?1", params![thread_id], |row| row.get(0)).ok().flatten()
        } else {
            None
        };
        // A bound bot (cloud API or original subscription) speaks only through
        // its own linked engine: the thread's model override and provider
        // failover would answer as some other model while the UI still says
        // @grokbot, so both are bypassed here.
        let bound = matches!(speaker.engine_kind.as_str(), "openai_api" | "subscription");
        let mut provider_id = if bound {
            speaker.primary.clone()
        } else {
            override_model.filter(|value| !value.is_empty()).unwrap_or(speaker.primary.clone())
        };
        // Failover is the Pro entitlement: <50ms handoff when a subscription
        // cap hits mid-task. Starter gets the honest error instead of a silent
        // provider switch; dev builds are entitled.
        if !pinned && !bound && crate::licensing::pro_entitled(conn) {
            let (next, capsule) = failover(conn, &provider_id, &settings.auto_failover)?;
            provider_id = next;
            if let Some(capsule) = capsule {
                insert_step_in(conn, thread_id, turn_id, "system", &provider_id, "Quota handoff capsule", "handoff_capsule", &json!({"capsule": capsule}), 8)?;
            }
        }
        let memory = crate::memory::prompt_context(conn, composed, Some(bot_id));
        let home = crate::util::product_home();
        // The role is the user's own words for what this bot is for. It has to
        // reach the model or it only ever lives in the UI.
        let charter = if speaker.role.trim().is_empty() {
            speaker.soul.clone()
        } else if speaker.soul.trim().is_empty() {
            format!("You are: {}", speaker.role.trim())
        } else {
            format!("You are: {}\n\n{}", speaker.role.trim(), speaker.soul)
        };
        let system = crate::capabilities::system_for(conn, &home, bot_id, &charter, composed, &memory)?;
        let tools = tool_specs(speaker.allow_code, speaker.allow_computer, speaker.allow_browser, speaker.allow_file);
        Ok(Ok((speaker, provider_id, system, tools)))
    })?;
    let (speaker, mut provider_id, system, tools) = match ready {
        Err(note) => return Ok(BotTurn::Paused(note)),
        Ok(ready) => ready,
    };
    // Bound bots default to the model they were linked with; the composer can
    // still pick a different model from that same engine's list.
    let model = model
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            if matches!(speaker.engine_kind.as_str(), "openai_api" | "subscription") {
                let own = speaker.api_model.trim().to_string();
                if own.is_empty() { None } else { Some(own) }
            } else {
                None
            }
        });
    let started = Instant::now();
    let epoch = turn_epoch();
    // Definition of done for this turn, read once from the user's own words.
    let contract = crate::coworker::compile_contract(composed);
    let (reply, failed) = match run_turn(state, thread_id, turn_id, bot_id, &provider_id, &system, secrets, model.as_deref(), effort, &tools, speaker.allow_code, speaker.allow_computer, speaker.allow_browser, speaker.allow_file, &contract, composed, attachments) {
        Err(first) if reply_was_cleared(&first) => {
            let _ = with_db(state, |conn| finish(conn, thread_id));
            return Ok(BotTurn::Paused(first));
        }
        Ok(text) => (text, false),
        Err(first) => {
            let timed_out = first.contains("did not answer in time") || first.contains("model call stopped");
            let next = if timed_out {
                None
            } else {
                with_db(state, |conn| -> Result<Option<String>> {
                    let tools_ran: i64 = conn.query_row("SELECT COUNT(*) FROM execution_steps WHERE thread_id=?1 AND turn_id=?2 AND role='tool' AND action_type != 'turn_activity'", params![thread_id, turn_id], |row| row.get(0)).unwrap_or(0);
                    // Bound bots do not silently fail over to another provider:
                    // @grokbot answering through Gemini would be a fake reply.
                    if pinned || tools_ran > 0 || matches!(speaker.engine_kind.as_str(), "openai_api" | "subscription") {
                        return Ok(None);
                    }
                    fallback_of(conn, &provider_id)
                })?
            };
            if let Some(next) = next {
                let capsule = capsule_for(composed, &first);
                with_db(state, |conn| -> Result<()> {
                    insert_step_in(conn, thread_id, turn_id, "system", &next, "Provider failed over", "handoff_capsule", &json!({"capsule": capsule, "error": first}), 12)?;
                    Ok(())
                })?;
                provider_id = next;
                // The retry keeps the bot's own tool permissions. Overriding
                // them here would let a fenced tool call run on failover even
                // when the bot was configured with every tool disabled.
                let text = match run_turn(state, thread_id, turn_id, bot_id, &provider_id, &system, secrets, model.as_deref(), effort, &tools, speaker.allow_code, speaker.allow_computer, speaker.allow_browser, speaker.allow_file, &contract, composed, attachments) {
                    Err(error) if reply_was_cleared(&error) => {
                        let _ = with_db(state, |conn| finish(conn, thread_id));
                        return Ok(BotTurn::Paused(error));
                    }
                    Ok(text) => text,
                    Err(error) => format!("{first}\n\n{error}"),
                };
                (text, true)
            } else {
                (first, true)
            }
        }
    };
    if turn_epoch() != epoch || reply_was_cleared(&reply) {
        let _ = with_db(state, |conn| finish(conn, thread_id));
        return Ok(BotTurn::Paused("The reply was cleared. Send the question again.".into()));
    }
    let ms = started.elapsed().as_millis() as i64;
    let label = with_db(state, |conn| -> Result<String> {
        if failed && ms >= speaker.stall_ms {
            crate::bots::note_stall(conn, bot_id, thread_id, ms)?;
        }
        let _ = provider_name(conn, &provider_id);
        let label = speaker.handle.clone();
        insert_step_in(conn, thread_id, turn_id, "assistant", &label, &reply, "message", &json!({}), ms)?;
        crate::bots::touch_status(conn, bot_id, &reply)?;
        Ok(format!("{label} replied in {ms}ms"))
    })?;
    Ok(BotTurn::Spoke(label))
}

fn normalize_effort(effort: Option<&str>) -> String {
    match effort.unwrap_or("").trim() {
        "high" => "high".into(),
        "max" => "max".into(),
        "xhigh" => "xhigh".into(),
        _ => "default".into(),
    }
}

/// The clean, user-visible version of a sent message: the prompt plus one
/// compact chip per attachment. The full file contents go to the model via
/// `compose_user_text`; this is what renders in the chat bubble, so a large
/// attached file never floods the transcript.
fn display_user_text(prompt: &str, attachments: &[String]) -> String {
    let clean = strip_directives(prompt);
    let mut text = clean.trim().to_string();
    if text.is_empty() {
        text = "Read the attached files.".into();
    }
    if attachments.is_empty() {
        return text;
    }
    let names: Vec<String> = attachments
        .iter()
        .map(|path| {
            let name = std::path::Path::new(path.trim())
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| path.trim().to_string());
            format!("📎 `{name}`")
        })
        .collect();
    text.push_str(&format!("\n\n{}", names.join("  ")));
    text
}

fn compose_user_text(conn: &Connection, prompt: &str, attachments: &[String]) -> String {
    let clean = strip_directives(prompt);
    let mut text = clean.trim().to_string();
    if text.is_empty() {
        text = "Read the attached files.".into();
    }
    if attachments.is_empty() {
        return text;
    }
    text.push_str("\n\nAttached files:");
    let mut any_failed = false;
    for path in attachments {
        match crate::workspace_bridge::read_attachment(conn, path) {
            Ok(body) => {
                // Images come back as "[Image: name]\ndata:mime;base64,..." — pass through
                // without code fences so vision models can read the data URL directly.
                if body.starts_with("[Image:") {
                    text.push_str(&format!("\n- {path}\n{body}"));
                } else {
                    text.push_str(&format!("\n- {path}\n```\n{body}\n```"));
                }
            }
            Err(error) => {
                any_failed = true;
                text.push_str(&format!("\n- {path} — could not be read ({error})"));
            }
        }
    }
    // When a file genuinely failed, tell the model to retry it with read_file
    // on the absolute path, and only if that also fails to report the specific
    // reason — never to claim it has "no files in memory" or "no access".
    if any_failed {
        text.push_str("\n\n[ATTACHMENT NOTE] One or more attached files could not be inlined (reason is inline above). First retry by calling read_file with the full absolute path shown next to the failed file — read_file opens attached and Desktop files directly. If read_file also fails, tell the user the specific file and the exact reason in one sentence, then continue answering from the rest of the request. Never say you have no files in memory or no access.");
    }
    text
}

/// Persist the turn's recovery story to the bot's EXPERIENCE.md so the next
/// similar task starts smarter. Idempotent per turn via take() on the first
/// failure; turns without tool failures leave nothing behind.
fn note_coworker_lesson(state: &AppState, bot_id: &str, first_failure: &mut Option<String>, ended_in_failure: bool) {
    let Some(desc) = first_failure.take() else { return };
    let lesson = if ended_in_failure {
        format!("'{desc}' failed and the turn ended reporting the blocker. On similar tasks, try a different surface first (a script, browser or desktop automation, or fix the missing dependency) before the approach that broke.")
    } else {
        format!("'{desc}' failed mid-task; recovered by pivoting approaches and finished. Prefer the working alternative on similar tasks.")
    };
    crate::coworker::record_lesson(&state.home, bot_id, &lesson);
}

fn run_turn(state: &AppState, thread_id: &str, turn_id: &str, bot_id: &str, provider_id: &str, system: &str, secrets: &HashMap<String, String>, model: Option<&str>, effort: &str, tools: &[Value], allow_code: bool, allow_computer: bool, allow_browser: bool, allow_file: bool, contract: &crate::coworker::Contract, current_user_text: &str, attachments: &[String]) -> std::result::Result<String, String> {
    let epoch = turn_epoch();
    let mut messages = with_db(state, |conn| history_messages(conn, thread_id, system))?;
    // The transcript stores the clean display text (prompt + attachment chips),
    // but the model still needs the full current-turn content — including the
    // inlined attached-file bodies. Swap the trailing user message (this turn's)
    // for the composed text so attachments reach the model without flooding the
    // visible bubble or the replayed history of later turns.
    if !current_user_text.trim().is_empty() {
        if let Some(last_user) = messages.iter_mut().rev().find(|message| message.role == "user") {
            last_user.content = current_user_text.to_string();
        }
    }
    let is_task_history = messages.iter().any(|m| m.role == "tool" || !m.tool_calls.is_empty()) || messages.len() > 3;
    let quick = !is_task_history && messages.iter().rev().find(|message| message.role == "user").is_some_and(|message| quick_question(&message.content));
    if quick {
        let mut system_text = messages.iter().find(|message| message.role == "system").map(|message| message.content.clone()).unwrap_or_default();
        system_text.push_str("\n\nFor simple greetings or identity questions, answer concisely in a few sentences.");
        let mut kept: Vec<ChatMsg> = messages.iter().rev().filter(|message| message.role != "system").take(4).cloned().collect();
        kept.reverse();
        messages = vec![ChatMsg::new("system", system_text)];
        messages.extend(kept);
    }
    bind_selected_model(&mut messages, model);
    let active: &[Value] = if quick { &[] } else { tools };
    let mut last_text = String::new();
    let mut tools_executed_total = 0usize;
    // Co-worker dead-loop guard: (tool, args) signatures that already failed
    // this turn. Two identical failures block a third identical retry and the
    // model is forced to pivot. `last_failure` powers the verification gate
    // that stops the bot from signing off while its last action failed.
    let mut failed_sigs: std::collections::HashMap<String, u32> = std::collections::HashMap::new();
    let mut last_failure: Option<(String, String)> = None;
    let mut first_failure: Option<String> = None;
    let mut gates_injected = 0u8;
    // Pivot ladder needs to know which surfaces this bot may actually use, and
    // the definition of done collects real tool proofs as the turn runs.
    let surfaces = crate::coworker::Surfaces { computer: allow_computer, browser: allow_browser, files: allow_code && allow_file };
    let mut dod_proofs: Vec<crate::coworker::Proof> = Vec::new();
    // Live-activity writes are deduped: the pill only re-renders when the
    // detail actually changes, so identical consecutive markers skip the DB.
    let mut last_activity = String::new();
    let mut note_activity = |conn: &rusqlite::Connection, detail: &str| {
        if detail != last_activity {
            last_activity.clear();
            last_activity.push_str(detail);
            let _ = db::record_turn_activity(conn, thread_id, turn_id, detail);
        }
    };
    with_db(state, |conn| note_activity(conn, "analyzing request and checking tools..."));
    for _round in 0..TOOL_ROUNDS {
        if turn_epoch() != epoch {
            return Err("The reply was cleared. Send the question again.".into());
        }
        if _round > 0 {
            with_db(state, |conn| note_activity(conn, "evaluating tool results and planning next step..."));
        } else {
            with_db(state, |conn| note_activity(conn, "consulting model for next action..."));
        }
        let round_effort = if quick { "fast" } else { effort };
        let mut completion = match answer(state, provider_id, &messages, secrets, model, round_effort, active) {
            Ok(c) => c,
            Err(err) => {
                if turn_epoch() != epoch || reply_was_cleared(&err) {
                    return Err("The reply was cleared. Send the question again.".into());
                }
                if tools_executed_total > 0 {
                    messages.push(ChatMsg::new(
                        "user",
                        format!("Note: A tool/model issue occurred: {err}. Please provide your final response to the user based on the tool steps executed so far."),
                    ));
                    break;
                }
                return Err(err);
            }
        };
        if quick {
            let mut text = completion.text.trim().to_string();
            if text.is_empty() && !completion.thinking.is_empty() {
                messages.push(ChatMsg::new("user", "Please provide your answer based on your thought process above."));
                if let Ok(c2) = answer(state, provider_id, &messages, secrets, model, "fast", &[]) {
                    let t2 = c2.text.trim().to_string();
                    if !t2.is_empty() {
                        text = t2;
                    }
                }
            }
            if text.is_empty() {
                return Ok("The model returned an empty reply.".into());
            }
            return Ok(text);
        }
        let thinking = completion.thinking.trim().to_string();
        let (clean_text, fence_calls) = extract_all_tool_calls(&completion.text);
        let mut calls = if completion.tool_calls.is_empty() {
            fence_calls
        } else {
            completion.tool_calls
        };
        completion.text = clean_text;
        if calls.is_empty() {
            // Verification gate: refuse to let the turn end on a failed action.
            // Injected at most twice per turn so a genuinely blocked task can
            // still be reported honestly instead of looping forever.
            if gates_injected < 2 {
                if let Some((tool, failure)) = &last_failure {
                    gates_injected += 1;
                    let failure = failure.clone();
                    let tool = tool.clone();
                    messages.push(ChatMsg::new(
                        "user",
                        format!(
                            "[VERIFICATION GATE] Your last action (`{tool}`) failed: {failure}\nDo not report success. Either fix the problem with a different approach and verify it, or state plainly what failed, what you already tried, and what remains. Identical retries of a failed action are blocked."
                        ),
                    ));
                    last_failure = None;
                    continue;
                }
                if let Some(missing) = contract.unmet(&dod_proofs) {
                    gates_injected += 1;
                    let required = contract.requirement_line().unwrap_or_default();
                    messages.push(ChatMsg::new(
                        "user",
                        format!(
                            "[DEFINITION-OF-DONE GATE] The task is not verified yet. Still missing: {missing}.\nRequired proof:\n{required}\nProduce the missing proof with your tools now. If one check is genuinely impossible, say plainly which and why; do not claim it passed."
                        ),
                    ));
                    continue;
                }
            }
            let mut text = completion.text.trim().to_string();
            if !thinking.is_empty() {
                with_db(state, |conn| insert_step_in(conn, thread_id, turn_id, "assistant", provider_id, &thinking, "thinking", &json!({}), 0).map_err(|error| error.0))?;
            }
            // If tools ran and text is empty, or if text is empty after thinking:
            if text.is_empty() {
                let prompt_msg = if tools_executed_total > 0 {
                    "Please provide your complete, final response to the user based on the tool results above. Explain clearly what you did, what was found, and any next steps."
                } else if !thinking.is_empty() {
                    "Please proceed with your planned action or provide your final response to the user. Call the relevant tool now if action or inspection is needed."
                } else {
                    "Please provide your response to the user. Do not return an empty reply."
                };
                messages.push(ChatMsg::new("user", prompt_msg));
                let tool_set: &[Value] = if tools_executed_total > 0 { &[] } else { active };
                if let Ok(mut synthesis) = answer(state, provider_id, &messages, secrets, model, effort, tool_set) {
                    let (clean_syn, syn_calls) = extract_all_tool_calls(&synthesis.text);
                    if synthesis.tool_calls.is_empty() && !syn_calls.is_empty() {
                        synthesis.tool_calls = syn_calls;
                    }
                    if !synthesis.tool_calls.is_empty() {
                        calls = synthesis.tool_calls;
                        completion.text = clean_syn;
                    } else {
                        let syn_text = clean_syn.trim().to_string();
                        if !syn_text.is_empty() {
                            text = syn_text;
                        }
                    }
                }
            }
            if calls.is_empty() {
                note_coworker_lesson(state, bot_id, &mut first_failure, last_failure.is_some());
                if !text.is_empty() {
                    return Ok(text);
                }
                if tools_executed_total > 0 && !last_text.trim().is_empty() {
                    return Ok(format!("{}\n\n(Finished executing tools. See details above.)", last_text));
                }
                if !last_text.trim().is_empty() {
                    return Ok(last_text);
                }
                if tools_executed_total > 0 {
                    return Ok("Finished executing the requested tools. Please check the steps above.".into());
                }
                return Ok("I have processed your request. Please let me know if you would like me to proceed or need more information.".into());
            }
        }
        if !completion.text.trim().is_empty() {
            last_text = completion.text.trim().to_string();
        }
        if !thinking.is_empty() {
            with_db(state, |conn| note_activity(conn, "thinking through the next step…"));
        }
        let assistant_text = if completion.text.trim().is_empty() {
            let tool_names = calls.iter().map(|c| c.name.as_str()).collect::<Vec<_>>().join(", ");
            format!("Calling tools: {tool_names}")
        } else {
            completion.text
        };
        with_db(state, |conn| -> std::result::Result<(), String> {
            if !thinking.is_empty() {
                insert_step_in(conn, thread_id, turn_id, "assistant", provider_id, &thinking, "thinking", &json!({}), 0).map_err(|error| error.0)?;
            }
            Ok(())
        })?;
        let mut calls = calls;
        for (index, call) in calls.iter_mut().enumerate() {
            if call.id.trim().is_empty() {
                call.id = format!("call_{index}_{}", crate::util::nid("tc"));
            }
        }
        messages.push(ChatMsg::assistant_tools(assistant_text, calls.clone()));
        for call in calls {
            let detail = match call.name.as_str() {
                "workspace_webapp" => {
                    let action = serde_json::from_str::<Value>(&call.arguments).ok().and_then(|v| v.get("action").and_then(|a| a.as_str()).map(str::to_string)).unwrap_or_else(|| "running".into());
                    let target = serde_json::from_str::<Value>(&call.arguments).ok().and_then(|v| v.get("app").and_then(|a| a.as_str()).map(str::to_string)).unwrap_or_else(|| "webapp".into());
                    format!("workspace webapp: {action} ({target})")
                }
                "desktop_app" => {
                    let action = serde_json::from_str::<Value>(&call.arguments).ok().and_then(|v| v.get("action").and_then(|a| a.as_str()).map(str::to_string)).unwrap_or_else(|| "running".into());
                    let target = serde_json::from_str::<Value>(&call.arguments).ok().and_then(|v| v.get("app").and_then(|a| a.as_str()).map(str::to_string)).unwrap_or_else(|| "app".into());
                    format!("desktop app: {action} ({target})")
                }
                "install_skill" => "installing skill from source...".into(),
                "install_plugin" => "installing plugin from source...".into(),
                "connect_mcp" => "connecting MCP server...".into(),
                _ => {
                    let args_preview = serde_json::from_str::<Value>(&call.arguments).unwrap_or_else(|_| json!({}));
                    let bit = args_preview
                        .as_object()
                        .and_then(|obj| obj.values().find_map(|value| value.as_str().map(str::to_owned)))
                        .unwrap_or_default();
                    let bit: String = bit.chars().take(56).collect();
                    if bit.is_empty() { call.name.clone() } else { format!("{} · {}", call.name, bit) }
                }
            };
            with_db(state, |conn| note_activity(conn, &detail));
            if turn_epoch() != epoch {
                return Err("The reply was cleared. Send the question again.".into());
            }
            tools_executed_total += 1;
            let args = serde_json::from_str::<Value>(&call.arguments).unwrap_or_else(|_| json!({}));
            let started = Instant::now();
            // Dead-loop guard: a third identical attempt at an action that
            // already failed twice never reaches the tool layer. The model
            // receives the block as the tool result and must pivot.
            let sig = crate::coworker::action_signature(&call.name, &args);
            let already_failed = failed_sigs.get(&sig).copied().unwrap_or(0);
            let blocked = already_failed >= 2;
            let (action, payload, mut output) = if blocked {
                (
                    "handoff_capsule".to_string(),
                    json!({"guard": "dead_loop", "tool": call.name}),
                    "[BLOCKED BY DEAD-LOOP GUARD] This exact action already failed twice in this turn, so the identical retry is disabled. Change the approach: different tool or arguments, fix the underlying cause, write a script, use browser or desktop automation, or report precisely what is blocked and why.".to_string(),
                )
            } else {
                execute_tool(state, thread_id, bot_id, call.name.as_str(), &args, allow_code, allow_computer, allow_browser, allow_file, attachments)
            };
            let ms = started.elapsed().as_millis() as i64;
            let name = call.name.clone();
            let failed = !blocked && crate::coworker::tool_failed(&action, &payload, &output);
            if failed {
                let entry = failed_sigs.entry(sig).or_insert(0);
                *entry += 1;
                if *entry == 1 {
                    let args_short = serde_json::to_string(&args).unwrap_or_default().chars().take(120).collect::<String>();
                    first_failure = Some(format!("{name} {args_short}"));
                }
                last_failure = Some((name.clone(), output.chars().take(180).collect::<String>()));
                // Pivot ladder: the next approach rides along in the tool result
                // so a failure always arrives with a direction, never a dead end.
                let pivot = crate::coworker::pivot_for(&name, &output, *entry, failed_sigs.len() as u32, surfaces);
                output.push_str(&format!("\n\n[SYSTEM PIVOT DIRECTIVE] {}", pivot.directive));
            } else if !blocked {
                last_failure = None;
                if let Some(proof) = crate::coworker::proof_of(&name, &payload, false) {
                    if !dod_proofs.contains(&proof) {
                        dod_proofs.push(proof);
                    }
                }
            }
            with_db(state, |conn| -> std::result::Result<(), String> {
                if !blocked {
                    record_tool(conn, bot_id, thread_id, &name, &args, &output);
                }
                if blocked {
                    insert_step_in(conn, thread_id, turn_id, "system", "dead-loop-guard", &output, "handoff_capsule", &payload, ms).map_err(|error| error.0)?;
                } else {
                    insert_step_in(conn, thread_id, turn_id, "tool", &name, &output, &action, &payload, ms).map_err(|error| error.0)?;
                }
                Ok(())
            })?;
            messages.push(ChatMsg::tool_result(&call.id, &name, output));
        }
    }

    if turn_epoch() != epoch {
        return Err("The reply was cleared. Send the question again.".into());
    }

    // Final synthesis: if tools ran, ask the model to produce its final answer explaining findings and results
    note_coworker_lesson(state, bot_id, &mut first_failure, last_failure.is_some());
    if tools_executed_total > 0 {
        messages.push(ChatMsg::new(
            "user",
            "Please provide your complete, final response to the user based on the tool results above. Explain clearly what you did, what was found, and any next steps.",
        ));
        if let Ok(synthesis) = answer(state, provider_id, &messages, secrets, model, effort, &[]) {
            let syn_text = synthesis.text.trim().to_string();
            if !syn_text.is_empty() {
                return Ok(syn_text);
            }
        }
    }

    Ok(if last_text.trim().is_empty() {
        "Finished tool execution. See the tool cards above for what ran.".into()
    } else {
        last_text
    })
}

fn task_title(prompt: &str) -> String {
    let line = prompt.lines().next().unwrap_or("").trim();
    let title: String = line.chars().take(36).collect();
    let title = title.trim().to_string();
    if title.is_empty() { "New task".to_string() } else { title }
}

fn ensure_thread(conn: &Connection, prompt: &str, provider_override: Option<&str>) -> Result<()> {
    let override_id = provider_override.map(str::trim).filter(|value| !value.is_empty());
    if let Some(id) = db::kv_get(conn, "active_thread")? {
        let live: i64 = conn.query_row("SELECT COUNT(*) FROM chat_threads WHERE id = ?1", params![id], |row| row.get(0))?;
        if live == 1 {
            if let Some(provider) = override_id {
                conn.execute("UPDATE chat_threads SET active_model_override_id = ?1 WHERE id = ?2", params![provider, id])?;
            }
            return Ok(());
        }
    }
    let profile = ensure_profile(conn)?;
    let id = crate::util::nid("thread");
    let title = task_title(prompt);
    conn.execute(
        "INSERT INTO chat_threads (id, bot_profile_id, title, active_model_override_id, status, compacted_context_capsule, is_pinned, updated_at) VALUES (?1,?2,?3,?4,'idle','',0,?5)",
        params![id, profile, title, override_id, now_ms()],
    )?;
    db::kv_set(conn, "active_thread", &id)?;
    Ok(())
}

pub(crate) fn ensure_profile(conn: &Connection) -> Result<String> {
    if let Some(id) = db::kv_get(conn, "active_profile")? {
        let live: i64 = conn.query_row("SELECT COUNT(*) FROM bot_profiles WHERE id = ?1", params![id], |row| row.get(0))?;
        if live == 1 {
            return Ok(id);
        }
    }
    if let Ok(id) = conn.query_row("SELECT id FROM bot_profiles ORDER BY created_at LIMIT 1", [], |row| row.get::<_, String>(0)) {
        db::kv_set(conn, "active_profile", &id)?;
        return Ok(id);
    }
    if let Ok(id) = conn.query_row("SELECT id FROM bot_profiles WHERE handle = '@local'", [], |row| row.get::<_, String>(0)) {
        db::kv_set(conn, "active_profile", &id)?;
        return Ok(id);
    }
    let id = crate::util::nid("bot");
    conn.execute(
        "INSERT INTO bot_profiles (id, handle, display_name, avatar, soul_markdown, primary_account_id, long_context_account_id, fallback_account_id, allow_computer_use, allow_browser_use, allow_code_exec, scoped_obsidian_folder, daily_wallet_limit_usd, is_pinned, role, created_at) VALUES (?1,'@local','Local operator','NW','Local operator. Created when a message was sent with no bot selected.','prov_ollama','prov_gemini','prov_openrouter',1,1,1,'',5,1,'Local operator',?2)",
        params![id, now_ms()],
    )?;
    db::kv_set(conn, "active_profile", &id)?;
    Ok(id)
}

fn finish(conn: &Connection, thread_id: &str) -> Result<()> {
    conn.execute("DELETE FROM execution_steps WHERE action_type = 'turn_activity' AND thread_id = ?1", params![thread_id])?;
    let capsule = thread_capsule(conn, thread_id)?;
    conn.execute(
        "UPDATE chat_threads SET status = 'completed', compacted_context_capsule = ?1, updated_at = ?2 WHERE id = ?3",
        params![capsule, now_ms(), thread_id],
    )?;
    Ok(())
}

fn thread_capsule(conn: &Connection, thread_id: &str) -> Result<String> {
    let mut stmt = conn.prepare("SELECT role, content_markdown FROM execution_steps WHERE thread_id = ?1 AND action_type != 'turn_activity' ORDER BY created_at ASC")?;
    let rows = stmt.query_map(params![thread_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
    let rows = rows.collect::<std::result::Result<Vec<_>, _>>()?;
    let goal = rows.iter().find(|(role, _)| role == "user").map(|(_, content)| clip(content, 400)).unwrap_or_default();
    let mut done: Vec<String> = rows.iter().rev().filter(|(role, _)| role == "assistant" || role == "tool").take(4).map(|(_, content)| clip(content, 180)).collect();
    done.reverse();
    Ok(format!("original_goal: {goal}\ncompleted_actions: {}\npending_next_steps: continue from the last accepted card", clip(&done.join(" | "), 800)))
}

fn capsule_for(prompt: &str, reply: &str) -> String {
    let goal = clip(prompt, 400);
    let done = clip(&redact(reply), 800);
    format!("original_goal: {goal}\ncompleted_actions: {done}\npending_next_steps: continue from the last accepted card")
}

fn clip(s: &str, n: usize) -> String {
    let mut t = s.replace('\n', " ");
    if t.len() > n {
        truncate_utf8(&mut t, n);
        t.push('…');
    }
    t
}

fn failover(conn: &Connection, provider_id: &str, auto: &bool) -> Result<(String, Option<String>)> {
    if !auto {
        return Ok((provider_id.to_string(), None));
    }
    let quota: f64 = conn.query_row("SELECT quota_used_percent FROM provider_accounts WHERE id = ?1", params![provider_id], |r| r.get(0)).unwrap_or(0.0);
    if quota < 100.0 {
        return Ok((provider_id.to_string(), None));
    }
    match fallback_of(conn, provider_id)? {
        Some(next) => Ok((next.clone(), Some(capsule_for("continue the active task", "previous provider quota is marked full")))),
        None => Ok((provider_id.to_string(), None)),
    }
}

fn fallback_of(conn: &Connection, provider_id: &str) -> Result<Option<String>> {
    let id: Option<String> = conn.query_row("SELECT fallback_account_id FROM provider_accounts WHERE id = ?1", params![provider_id], |r| r.get(0)).unwrap_or(None);
    let Some(id) = id.filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let ready: Option<(String, i64)> = conn
        .query_row(
            "SELECT provider_type, has_secret FROM provider_accounts WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .ok();
    let Some((kind, has_secret)) = ready else {
        return Ok(None);
    };
    if kind == "local_ollama" || has_secret != 0 {
        Ok(Some(id))
    } else {
        Ok(None)
    }
}

fn provider_name(conn: &Connection, id: &str) -> Result<String> {
    let name: String = conn.query_row("SELECT name FROM provider_accounts WHERE id = ?1", params![id], |r| r.get(0)).unwrap_or_else(|_| id.to_string());
    Ok(name)
}

fn history_messages(conn: &Connection, thread_id: &str, system: &str) -> std::result::Result<Vec<ChatMsg>, String> {
    let capsule: String = conn.query_row("SELECT compacted_context_capsule FROM chat_threads WHERE id = ?1", params![thread_id], |row| row.get(0)).unwrap_or_default();
    let mut stmt = conn.prepare("SELECT role, model_used, content_markdown, action_type FROM execution_steps WHERE thread_id = ?1 AND action_type != 'turn_activity' ORDER BY created_at ASC").map_err(|error| error.to_string())?;
    let rows = stmt.query_map(params![thread_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?))).map_err(|error| error.to_string())?;
    let steps = rows.collect::<std::result::Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
    Ok(fold_history(&steps, system, &capsule, HISTORY_BUDGET))
}

fn fold_history(steps: &[(String, String, String, String)], system: &str, capsule: &str, budget: usize) -> Vec<ChatMsg> {
    let mut folded = Vec::new();
    let mut tools = Vec::new();
    for (role, model, content, action) in steps {
        if action == "thinking" {
            continue;
        }
        if role == "user" {
            if !tools.is_empty() {
                folded.push(ChatMsg::new("assistant", tools.join("\n\n")));
                tools.clear();
            }
            folded.push(ChatMsg::new("user", content.clone()));
        } else if role == "tool" {
            tools.push(format!("Tool {model}:\n{}", clip(content, 1500)));
        } else if role == "assistant" && !content.trim().is_empty() {
            let text = if tools.is_empty() { content.clone() } else { format!("{}\n\n{content}", tools.join("\n\n")) };
            tools.clear();
            folded.push(ChatMsg::new("assistant", text));
        }
    }
    if !tools.is_empty() {
        folded.push(ChatMsg::new("assistant", tools.join("\n\n")));
    }
    let mut total: usize = folded.iter().map(|message| message.content.len()).sum();
    let mut dropped = false;
    while folded.len() > 1 && total > budget {
        let removed = folded.remove(0);
        total = total.saturating_sub(removed.content.len());
        dropped = true;
    }
    let mut system_text = system.to_string();
    if dropped && !capsule.trim().is_empty() {
        system_text.push_str("\n\nEarlier in this thread:\n");
        system_text.push_str(capsule.trim());
    }
    let mut out = vec![ChatMsg::new("system", system_text)];
    out.extend(folded);
    out
}

fn record_tool(conn: &Connection, bot_id: &str, thread_id: &str, name: &str, args: &Value, output: &str) {
    let surface = match name {
        "inspect_page" | "read_page" | "click_control" | "type_text" => "browser.inspect",
        "sandbox_command" | "terminal_command" | "run_command" | "execute_command" | "terminal_write" | "terminal_input" => "shell.sandbox",
        "propose_diff" => "fs.propose_diff",
        "read_file" | "list_files" => "fs.read",
        _ => "",
    };
    if surface.is_empty() {
        return;
    }
    let denied = output.starts_with("That tool is off") || output.starts_with("File write is off");
    let target = args.get("path").or_else(|| args.get("url")).or_else(|| args.get("command")).or_else(|| args.get("data")).or_else(|| args.get("text")).and_then(|value| value.as_str()).unwrap_or(name);
    let _ = crate::bots::audit(conn, bot_id, thread_id, surface, target, if denied { "denied_by_rule" } else { "allowed" }, if denied { "tool_off" } else { "" });
}

fn tool_specs(allow_code: bool, allow_computer: bool, allow_browser: bool, allow_file: bool) -> Vec<Value> {
    let mut tools = vec![
        tool_spec("list_memory", "List workspace memories.", &[]),
        tool_spec("search_memory", "Search memory titles and body text.", &["query"]),
        tool_spec("save_memory", "Save a memory onto the Memory screen.", &["title", "content"]),
        tool_spec("list_skills", "List the skill index for this profile.", &[]),
        tool_spec("load_skill", "Load one skill playbook.", &["slug"]),
        tool_spec("load_skill_file", "Load one supporting skill file.", &["slug", "path"]),
        tool_spec("skill_manage", "Propose a skill. A person approves the write.", &["slug", "body"]),
        tool_spec("list_providers", "List providers and their status.", &[]),
        tool_spec("list_threads", "List chat tasks.", &[]),
        tool_spec("list_mcp", "List MCP servers saved in this workspace. This does not start them.", &[]),
        tool_spec("list_plugins", "List plugins and whether each one is on for this bot.", &[]),
        tool_spec("install_skill", "Download and install any skill or playbook (from a GitHub repository URL, raw file link, web URL, or marketplace catalog slug) and enable it for this bot immediately. Call this whenever the user asks to add, download, or install a skill.", &["source"]),
        tool_spec("install_plugin", "Download and install any plugin (from a GitHub repository URL, git clone link, or package source), trust it, and enable it for this bot immediately. Call this whenever the user asks to add, download, or install a plugin.", &["source"]),
        tool_spec("connect_mcp", "Connect, trust, and enable an MCP server for this bot so it is immediately active. Give name, transport ('stdio' or 'sse'), command (for stdio, e.g. 'npx -y @modelcontextprotocol/server-filesystem'), args, or url (for sse). Call this whenever the user asks to connect or set up an MCP server.", &["name"]),
        tool_spec("save_workflow", "Save a task as a workflow on the Workflows screen. steps is one step per line: 'Title | instruction'. schedule is \"\" for an idle workflow a person starts by hand, or daily HH:MM, every 15m, every 1h, or a daily cron like 0 8 * * *.", &["name", "steps", "schedule"]),
        tool_spec("schedule_routine", "Repeat this chat on a timer while Ronic OS is open. schedule is daily HH:MM, every 15m, every 1h, or a daily cron like 0 8 * * *.", &["schedule"]),
    ];
    if allow_code {
        tools.push(tool_spec("read_file", "Read a text file. Give a project-relative path inside the project folder, or the absolute path of a file the user attached in this chat. Absolute paths outside the attached files are refused.", &["path"]));
        tools.push(tool_spec("list_files", "List a folder. Give a project-relative path, or the absolute path of a folder the user attached in this chat.", &["path"]));
        if allow_file {
            tools.push(tool_spec("propose_diff", "Propose a file write. It is not saved until a person accepts the diff.", &["path", "body"]));
        }
    }
    if allow_computer {
        tools.push(tool_spec("terminal_command", "Run an allowlisted command in this bot's own workspace folder. It cannot read another bot's files or the user's profile.", &["command"]));
        tools.push(tool_spec("sandbox_command", "Run an allowlisted command in this bot's own workspace folder. Output stays on this bot's computer.", &["command"]));
        tools.push(tool_spec("terminal_write", "Send raw keystrokes to the workspace terminal session.", &["data"]));
        tools.push(tool_spec("desktop_app", "Control and launch desktop applications on this computer (VS Code, Cursor, Claude Code, Obsidian, Ollama, or any local desktop app). Actions: 'list' (list desktop apps and status), 'open' (launch/open the desktop app), 'inspect' (read UI controls and windows using Windows UIAutomation), 'click' (click an interface control), 'type' (type text into a desktop window), 'status'.", &["action"]));
    }
    if allow_browser {
        tools.push(tool_spec("workspace_webapp", "Access, inspect, and auto-control the webapps running inside this workspace right beside your chat (like ChatGPT, Claude, Gemini, Perplexity, or custom webapps). Use this to control the user's workspace session. Actions: 'list' (list available & open webapps), 'open' (open/switch a webapp beside you on the right side), 'read' (read the current page text, title, url, and numbered interactive controls), 'click' (click a button or control by id or match text), 'type' (type text into an input by id), 'submit' (submit/press enter on an input), 'scroll' (scroll up/down), 'eval' (evaluate JavaScript), 'close'.", &["action"]));
        tools.push(tool_spec("inspect_page", "Open an https page, or http on localhost, as a tab in this bot's own mini computer's Chrome (a visible window with its own isolated browser profile and desktop) and read its text and controls. The user sees this window.", &["url"]));
        tools.push(tool_spec("read_page", "Read the page already open in this bot's mini computer window: text, numbered visible controls, and (when a video is present) whether it is actually playing. Usually not needed right after inspect_page, click_control, or type_text: those already return the fresh page state.", &[]));
        tools.push(tool_spec("click_control", "Click in this bot's mini computer window. Give id (the number from the last read) OR match (text to look for, like \"add to cart\" — the window picks and clicks the best visible match itself and reports what it clicked). Clicks are synthetic; the user's mouse never moves. Returns the fresh page state.", &["id"]));
        tools.push(tool_spec("type_text", "Type into a text field in this bot's mini computer window. id is the control. text is what to type. Returns the fresh page state.", &["id", "text"]));
        tools.push(tool_spec("scroll_page", "Scroll the page in this bot's mini computer window one viewport down (or up) and return the fresh state. Use it to reach buttons and fields below the fold.", &["direction"]));
        tools.push(tool_spec("find_control", "Search the page for visible controls matching the query, ranked best-first, like find \"checkout\". Returns numbered ids you can click or type into immediately.", &["query"]));
        tools.push(tool_spec("wait_for", "Wait efficiently instead of re-reading: pause until a control matching query appears on the page, or — with media: \"playing\" — until the page's video is actually playing. ms caps the wait (default 6000). Use after a click that opens or loads something.", &["query"]));
        tools.push(tool_spec("computer_shell", "Drive your mini computer's DESKTOP itself: action open_app (app: chrome | files | terminal | desktop), open_tab (url), focus_tab (tabId), close_tab (tabId), list_tabs, back, forward, reload, or status. Use it to work across your whole computer — read files, run something in the terminal, then return to the browser — instead of living in one page.", &["action"]));
    }
    tools
}

fn tool_spec(name: &str, description: &str, required: &[&str]) -> Value {
    let mut properties = serde_json::Map::new();
    for key in required {
        properties.insert((*key).to_string(), json!({"type": "string"}));
    }
    json!({
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": { "type": "object", "properties": properties, "required": required }
        }
    })
}

fn find_json_object(s: &str) -> Option<(usize, usize)> {
    let start = s.find('{')?;
    let mut depth = 0;
    let mut in_str = false;
    let mut escaped = false;
    for (i, c) in s[start..].char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if c == '\\' && in_str {
            escaped = true;
            continue;
        }
        if c == '"' {
            in_str = !in_str;
            continue;
        }
        if !in_str {
            if c == '{' {
                depth += 1;
            } else if c == '}' {
                depth -= 1;
                if depth == 0 {
                    return Some((start, start + i + 1));
                }
            }
        }
    }
    None
}

fn extract_all_tool_calls(text: &str) -> (String, Vec<ToolCall>) {
    let mut calls = Vec::new();
    let mut cleaned = text.to_string();

    // 1. Parse <|tool_call|> and <tool_call> tags
    let tool_tags = ["<|tool_call|>", "<tool_call>"];
    let mut iteration = 0;
    while iteration < 20 {
        iteration += 1;
        let mut found = false;
        for tag in &tool_tags {
            if let Some(tag_pos) = cleaned.find(tag) {
                found = true;
                let after_tag = &cleaned[tag_pos + tag.len()..];
                let trimmed_after = after_tag.trim_start();
                let mut consumed_len = 0;
                let mut matched_call = None;

                // Pattern A: name={...}
                if let Some(eq_pos) = trimmed_after.find('=') {
                    let candidate_name = trimmed_after[..eq_pos].trim();
                    let rest = &trimmed_after[eq_pos + 1..];
                    if !candidate_name.is_empty() && candidate_name.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '-') {
                        if let Some((json_start, json_end)) = find_json_object(rest) {
                            let json_str = &rest[json_start..json_end];
                            if let Ok(val) = serde_json::from_str::<Value>(json_str) {
                                matched_call = Some(ToolCall {
                                    id: format!("call_txt_{}", crate::util::nid("tc")),
                                    name: candidate_name.to_string(),
                                    arguments: val.to_string(),
                                });
                                let whitespace_len = after_tag.len() - trimmed_after.len();
                                consumed_len = tag.len() + whitespace_len + eq_pos + 1 + json_end;
                            }
                        }
                    }
                }

                // Pattern B: {"name": "...", "arguments": ...} or {"tool": "..."}
                if matched_call.is_none() {
                    if let Some((json_start, json_end)) = find_json_object(after_tag) {
                        let json_str = &after_tag[json_start..json_end];
                        if let Ok(val) = serde_json::from_str::<Value>(json_str) {
                            if let Some(name) = val.get("name").or_else(|| val.get("tool")).and_then(|v| v.as_str()) {
                                let name = name.trim().to_string();
                                if !name.is_empty() {
                                    let args = val.get("arguments").or_else(|| val.get("parameters")).cloned().unwrap_or_else(|| val.clone());
                                    matched_call = Some(ToolCall {
                                        id: format!("call_txt_{}", crate::util::nid("tc")),
                                        name,
                                        arguments: args.to_string(),
                                    });
                                    let whitespace_len = after_tag.len() - trimmed_after.len();
                                    consumed_len = tag.len() + whitespace_len + json_end;
                                }
                            }
                        }
                    }
                }

                if let Some(call) = matched_call {
                    calls.push(call);
                    let mut cut_end = tag_pos + consumed_len;
                    let remainder = &cleaned[cut_end..];
                    if remainder.starts_with('>') {
                        cut_end += 1;
                    }
                    if cleaned[cut_end..].starts_with("<|tool_call|>") {
                        cut_end += "<|tool_call|>".len();
                    } else if cleaned[cut_end..].starts_with("</tool_call>") {
                        cut_end += "</tool_call>".len();
                    }
                    cleaned.replace_range(tag_pos..cut_end, "");
                    break;
                } else {
                    cleaned.replace_range(tag_pos..tag_pos + tag.len(), "");
                    break;
                }
            }
        }
        if !found {
            break;
        }
    }

    // 2. Parse Markdown fences: ```ronic-tool, ```tool, ```json, ```
    for tag in &["```ronic-tool", "```tool", "```json", "```"] {
        let mut fence_iter = 0;
        while fence_iter < 10 {
            fence_iter += 1;
            if let Some(start) = cleaned.find(tag) {
                let rest = &cleaned[start + tag.len()..];
                if let Some(end_rel) = rest.find("```") {
                    let block = rest[..end_rel].trim();
                    let full_fence_end = start + tag.len() + end_rel + 3;
                    if let Ok(value) = serde_json::from_str::<Value>(block) {
                        if let Some(name) = value.get("tool").or_else(|| value.get("name")).and_then(|item| item.as_str()) {
                            let name = name.trim().to_string();
                            if !name.is_empty() {
                                let args = value.get("arguments").or_else(|| value.get("parameters")).cloned().unwrap_or_else(|| value.clone());
                                calls.push(ToolCall {
                                    id: format!("call_fence_{}", crate::util::nid("tc")),
                                    name,
                                    arguments: args.to_string(),
                                });
                                cleaned.replace_range(start..full_fence_end, "");
                                continue;
                            }
                        }
                    }
                }
            }
            break;
        }
    }

    // 3. Raw full JSON if nothing else matched
    if calls.is_empty() {
        let trimmed = cleaned.trim();
        if trimmed.starts_with('{') && trimmed.ends_with('}') {
            if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
                if let Some(name) = value.get("tool").or_else(|| value.get("name")).and_then(|item| item.as_str()) {
                    let name = name.trim().to_string();
                    if !name.is_empty() {
                        let args = value.get("arguments").or_else(|| value.get("parameters")).cloned().unwrap_or_else(|| value.clone());
                        calls.push(ToolCall {
                            id: format!("call_raw_{}", crate::util::nid("tc")),
                            name,
                            arguments: args.to_string(),
                        });
                        cleaned = String::new();
                    }
                }
            }
        }
    }

    // Final sweep of stray tags
    cleaned = cleaned
        .replace("<|tool_call|>", "")
        .replace("</tool_call>", "")
        .replace("<tool_call>", "")
        .replace("<|im_end|>", "")
        .replace("<ant-thinking>", "")
        .replace("</ant-thinking>", "")
        .replace("<thinking>", "")
        .replace("</thinking>", "")
        .replace("<think>", "")
        .replace("</think>", "")
        .replace("<thought>", "")
        .replace("</thought>", "")
        .replace("<reasoning>", "")
        .replace("</reasoning>", "")
        .trim()
        .to_string();

    (cleaned, calls)
}

fn fence_call(text: &str) -> Option<ToolCall> {
    let (_, calls) = extract_all_tool_calls(text);
    calls.into_iter().next()
}

fn execute_tool(state: &AppState, thread_id: &str, bot_id: &str, name: &str, args: &Value, allow_code: bool, allow_computer: bool, allow_browser: bool, allow_file: bool, attachments: &[String]) -> (String, Value, String) {
    let refused = ("message".into(), json!({}), "That tool is off for this bot.".into());
    let file_off = ("message".into(), json!({}), "File write is off for this bot.".into());
    match name {
        "read_file" | "list_files" | "propose_diff" if !allow_code => refused,
        "propose_diff" if !allow_file => file_off,
        "sandbox_command" | "terminal_command" | "run_command" | "execute_command" | "terminal_write" | "terminal_input" | "desktop_app" if !allow_computer => refused,
        "inspect_page" | "read_page" | "click_control" | "type_text" | "scroll_page" | "find_control" | "wait_for" | "computer_shell" | "workspace_webapp" if !allow_browser => refused,
        "inspect_page" | "read_page" | "click_control" | "type_text" | "scroll_page" | "find_control" | "wait_for" | "computer_shell" | "sandbox_command" | "terminal_command" | "run_command" | "execute_command" if other_computer(bot_id, args) => {
            ("message".into(), json!({}), "That computer belongs to another bot.".into())
        }
        "propose_diff" => {
            let root = with_db(state, |conn| db::settings_of(conn).map(|settings| settings.project_root).unwrap_or_default());
            propose_diff(&root, args)
        }
        "sandbox_command" | "terminal_command" | "run_command" | "execute_command" => sandbox_tool(state, bot_id, args),
        "terminal_write" | "terminal_input" => {
            let data = args.get("data").or_else(|| args.get("input")).and_then(|v| v.as_str()).unwrap_or("");
            if data.is_empty() {
                ("message".into(), json!({}), "No input data provided".into())
            } else {
                let app = state.app_handle.lock().ok().and_then(|g| g.clone());
                if let Some(app) = app {
                    use tauri::Manager;
                    // Default to the bot's OWN mini-computer terminal (a live
                    // PTY rooted at its workspace, the same session the shell
                    // Terminal app shows); session: "global" reaches the
                    // user's shared terminal instead.
                    let which = args.get("session").and_then(|v| v.as_str()).unwrap_or("own");
                    let session_id = if which == "global" { "ronic_global".to_string() } else { format!("mini-{}", bot_id.trim()) };
                    let mgr = app.state::<crate::terminal_pty::TerminalManager>();
                    let sent = if which == "global" {
                        mgr.write_session(&session_id, data)
                    } else {
                        let cwd = crate::bot_screen::shell_cwd(&state.home, bot_id, "").ok();
                        mgr.ensure_session(&app, &session_id, 100, 30, cwd.as_deref()).and_then(|_| mgr.write_session(&session_id, data))
                    };
                    match sent {
                        Ok(()) => ("message".into(), json!({"sent": data, "session": session_id}), format!("Sent {} bytes to the {} terminal", data.len(), if which == "global" { "global" } else { "bot's own mini-computer" })),
                        Err(e) => ("message".into(), json!({}), format!("Terminal write failed: {e}")),
                    }
                } else {
                    ("message".into(), json!({}), "App handle unavailable".into())
                }
            }
        }
        "inspect_page" => {
            let url = args.get("url").and_then(|item| item.as_str()).unwrap_or("").trim();
            let target = args.get("target").or_else(|| args.get("mode")).and_then(|item| item.as_str()).unwrap_or("").trim().to_lowercase();
            let app_id = args.get("app").and_then(|item| item.as_str()).map(str::trim);
            if url.is_empty() && app_id.is_none() {
                ("message".into(), json!({}), "inspect_page needs an https address, or http://localhost.".into())
            } else if target == "workspace" || target == "stage" || app_id.is_some() {
                let app = match desktop_handle(state) {
                    Ok(app) => app,
                    Err(message) => return ("message".into(), json!({}), message),
                };
                let id = app_id.unwrap_or_else(|| if url.contains("chatgpt") { "chatgpt" } else if url.contains("claude") { "claude" } else { "custom" });
                let _ = crate::workspace_apps::open_workspace_webapp_by_bot(&app, id, if url.is_empty() { None } else { Some(url) }, None);
                match crate::computer_subsystem::agent_drive_workspace_webapp(&app, bot_id, Some(id), "read", None, None, None) {
                    Ok(hit) => remember_mini_window(state, bot_id, hit),
                    Err(error) => ("message".into(), json!({}), error.0),
                }
            } else {
                drive_open(state, bot_id, url)
            }
        }
        "read_page" => {
            let target = args.get("target").or_else(|| args.get("mode")).and_then(|item| item.as_str()).unwrap_or("").trim().to_lowercase();
            let app_id = args.get("app").and_then(|item| item.as_str()).map(str::trim);
            if target == "workspace" || target == "stage" || app_id.is_some() {
                let app = match desktop_handle(state) {
                    Ok(app) => app,
                    Err(message) => return ("message".into(), json!({}), message),
                };
                match crate::computer_subsystem::agent_drive_workspace_webapp(&app, bot_id, app_id, "read", None, None, None) {
                    Ok(hit) => remember_mini_window(state, bot_id, hit),
                    Err(error) => ("message".into(), json!({}), error.0),
                }
            } else {
                drive_read(state, bot_id)
            }
        }
        "click_control" => {
            let app = match desktop_handle(state) {
                Ok(app) => app,
                Err(message) => return ("message".into(), json!({}), message),
            };
            // match mode: the window picks the best visible control itself.
            let wanted = args.get("match").and_then(|item| item.as_str()).map(str::trim).filter(|item| !item.is_empty());
            if let Some(query) = wanted {
                match crate::computer_subsystem::agent_drive_smart_click(&app, bot_id, query) {
                    Ok(hit) => remember_mini_window(state, bot_id, hit),
                    Err(error) => ("message".into(), json!({}), error.0),
                }
            } else {
                match control_id(args) {
                    Ok(id) => drive_click(state, bot_id, id),
                    Err(message) => ("message".into(), json!({}), format!("{message} — or call click_control with match: \"button text\".")),
                }
            }
        }
        "type_text" => {
            let text = args.get("text").and_then(|item| item.as_str()).unwrap_or("");
            match control_id(args) {
                Ok(id) => drive_type(state, bot_id, id, text),
                Err(message) => ("message".into(), json!({}), message),
            }
        }
        "scroll_page" => {
            let direction = args.get("direction").and_then(|item| item.as_str()).unwrap_or("down");
            let app = match desktop_handle(state) {
                Ok(app) => app,
                Err(message) => return ("message".into(), json!({}), message),
            };
            match crate::computer_subsystem::agent_drive_scroll(&app, bot_id, direction) {
                Ok(hit) => remember_mini_window(state, bot_id, hit),
                Err(error) => ("message".into(), json!({}), error.0),
            }
        }
        "find_control" => {
            let query = args.get("query").and_then(|item| item.as_str()).unwrap_or("").trim();
            if query.is_empty() {
                ("message".into(), json!({}), "find_control needs a query, like \"add to cart\" or \"email\".".into())
            } else {
                let app = match desktop_handle(state) {
                    Ok(app) => app,
                    Err(message) => return ("message".into(), json!({}), message),
                };
                match crate::computer_subsystem::agent_drive_find(&app, bot_id, query) {
                    Ok(hit) => remember_mini_window(state, bot_id, hit),
                    Err(error) => ("message".into(), json!({}), error.0),
                }
            }
        }
        "wait_for" => {
            let query = args.get("query").and_then(|item| item.as_str()).map(str::trim).filter(|item| !item.is_empty());
            let media = args.get("media").and_then(|item| item.as_str()).map(str::trim).filter(|item| !item.is_empty());
            let ms = args.get("ms").and_then(|item| item.as_u64()).unwrap_or(6000);
            let app = match desktop_handle(state) {
                Ok(app) => app,
                Err(message) => return ("message".into(), json!({}), message),
            };
            match crate::computer_subsystem::agent_drive_wait(&app, bot_id, query, media, ms) {
                Ok(hit) => remember_mini_window(state, bot_id, hit),
                Err(error) => ("message".into(), json!({}), error.0),
            }
        }
        "computer_shell" => {
            let app = match desktop_handle(state) {
                Ok(app) => app,
                Err(message) => return ("message".into(), json!({}), message),
            };
            crate::computer_subsystem::shell_control(&app, state, bot_id, args)
        }
        "workspace_webapp" => {
            let app = match desktop_handle(state) {
                Ok(app) => app,
                Err(message) => return ("message".into(), json!({}), message),
            };
            let action = args.get("action").or_else(|| args.get("op")).and_then(|v| v.as_str()).unwrap_or("read").trim().to_lowercase();
            let target_app = args.get("app").or_else(|| args.get("id")).or_else(|| args.get("name")).and_then(|v| v.as_str()).map(str::trim);
            let url = args.get("url").and_then(|v| v.as_str()).map(str::trim);

            match action.as_str() {
                "list" => {
                    let list = with_db(state, |conn| crate::workspace_apps::list_available_webapps(Some(conn)));
                    let active = crate::workspace_apps::active_webapp();
                    let summary = json!({
                        "active": active,
                        "webapps": list
                    });
                    ("workspace_webapp".into(), summary.clone(), format!("Workspace Webapps:\n{}", serde_json::to_string_pretty(&summary).unwrap_or_default()))
                }
                "open" | "switch" => {
                    let target = target_app.unwrap_or_else(|| if let Some(u) = url { if u.contains("chatgpt") { "chatgpt" } else if u.contains("claude") { "claude" } else { "custom" } } else { "chatgpt" });
                    match crate::workspace_apps::open_workspace_webapp_by_bot(&app, target, url, None) {
                        Ok(msg) => ("workspace_webapp".into(), json!({"action": "open", "app": target, "status": "opened"}), msg),
                        Err(err) => ("message".into(), json!({}), err.0),
                    }
                }
                "close" => {
                    crate::workspace_apps::hide_all(&app);
                    let _ = app.emit("ronic://close-workspace-webapp", ());
                    ("workspace_webapp".into(), json!({"action": "close"}), "Closed workspace webapp stage.".into())
                }
                "read" | "inspect" => {
                    match crate::computer_subsystem::agent_drive_workspace_webapp(&app, bot_id, target_app, "read", None, None, None) {
                        Ok(hit) => remember_mini_window(state, bot_id, hit),
                        Err(err) => ("message".into(), json!({}), err.0),
                    }
                }
                "click" => {
                    let wanted_match = args.get("match").or_else(|| args.get("text")).and_then(|v| v.as_str()).map(str::trim);
                    if let Some(query) = wanted_match.filter(|q| !q.is_empty()) {
                        match crate::computer_subsystem::agent_drive_workspace_webapp(&app, bot_id, target_app, "find", None, None, Some(query)) {
                            Ok(hit) => {
                                if let Some(first_node) = hit.nodes.first() {
                                    match crate::computer_subsystem::agent_drive_workspace_webapp(&app, bot_id, target_app, "click", Some(first_node.id), None, None) {
                                        Ok(fresh) => remember_mini_window(state, bot_id, fresh),
                                        Err(e) => ("message".into(), json!({}), e.0),
                                    }
                                } else {
                                    ("message".into(), json!({}), format!("No control matching '{query}' found on the webapp page."))
                                }
                            }
                            Err(e) => ("message".into(), json!({}), e.0),
                        }
                    } else {
                        let id = control_id(args).unwrap_or(1);
                        match crate::computer_subsystem::agent_drive_workspace_webapp(&app, bot_id, target_app, "click", Some(id), None, None) {
                            Ok(hit) => remember_mini_window(state, bot_id, hit),
                            Err(e) => ("message".into(), json!({}), e.0),
                        }
                    }
                }
                "type" => {
                    let text = args.get("text").or_else(|| args.get("value")).and_then(|v| v.as_str()).unwrap_or("");
                    let id = control_id(args).unwrap_or(1);
                    let submit = args.get("submit").or_else(|| args.get("press_enter")).and_then(|v| v.as_bool()).unwrap_or(false);
                    match crate::computer_subsystem::agent_drive_workspace_webapp(&app, bot_id, target_app, "type", Some(id), Some(text), None) {
                        Ok(hit) => {
                            if submit {
                                let active_id = target_app.map(str::to_string).or_else(crate::workspace_apps::active_webapp).unwrap_or_else(|| "chatgpt".into());
                                let label = format!("webapp_{active_id}");
                                if let Some(view) = app.get_webview(&label) {
                                    let script = format!(
                                        r#"(function(){{
                                            var list = document.querySelectorAll("a,button,input,select,textarea,[role=button],[role=textbox],[role=searchbox],[role=combobox],[role=tab],[contenteditable=true]");
                                            var el = list[{index}];
                                            if (el) {{
                                                el.dispatchEvent(new KeyboardEvent("keydown", {{ bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13, which: 13 }}));
                                                el.dispatchEvent(new KeyboardEvent("keypress", {{ bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13, which: 13 }}));
                                                el.dispatchEvent(new KeyboardEvent("keyup", {{ bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13, which: 13 }}));
                                                try {{ if (el.closest("form")) el.closest("form").requestSubmit(); }} catch(_) {{}}
                                            }}
                                        }})()"#,
                                        index = id.saturating_sub(1).max(0)
                                    );
                                    let _ = view.eval(&script);
                                }
                            }
                            remember_mini_window(state, bot_id, hit)
                        }
                        Err(e) => ("message".into(), json!({}), e.0),
                    }
                }
                "submit" | "enter" => {
                    let id = control_id(args).unwrap_or(1);
                    let active_id = target_app.map(str::to_string).or_else(crate::workspace_apps::active_webapp).unwrap_or_else(|| "chatgpt".into());
                    let label = format!("webapp_{active_id}");
                    if let Some(view) = app.get_webview(&label) {
                        let script = format!(
                            r#"(function(){{
                                var list = document.querySelectorAll("a,button,input,select,textarea,[role=button],[role=textbox],[role=searchbox],[role=combobox],[role=tab],[contenteditable=true]");
                                var el = list[{index}];
                                if (el) {{
                                    el.dispatchEvent(new KeyboardEvent("keydown", {{ bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13, which: 13 }}));
                                    el.dispatchEvent(new KeyboardEvent("keypress", {{ bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13, which: 13 }}));
                                    el.dispatchEvent(new KeyboardEvent("keyup", {{ bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13, which: 13 }}));
                                    try {{ if (el.closest("form")) el.closest("form").requestSubmit(); }} catch(_) {{}}
                                }}
                            }})()"#,
                            index = id.saturating_sub(1).max(0)
                        );
                        let _ = view.eval(&script);
                    }
                    match crate::computer_subsystem::agent_drive_workspace_webapp(&app, bot_id, target_app, "read", None, None, None) {
                        Ok(hit) => remember_mini_window(state, bot_id, hit),
                        Err(e) => ("message".into(), json!({}), e.0),
                    }
                }
                "scroll" => {
                    let dir = args.get("direction").and_then(|v| v.as_str()).unwrap_or("down");
                    match crate::computer_subsystem::agent_drive_workspace_webapp(&app, bot_id, target_app, "scroll", None, None, Some(dir)) {
                        Ok(hit) => remember_mini_window(state, bot_id, hit),
                        Err(e) => ("message".into(), json!({}), e.0),
                    }
                }
                "eval" => {
                    let script = args.get("script").or_else(|| args.get("js")).and_then(|v| v.as_str()).unwrap_or("");
                    let active_id = target_app.map(str::to_string).or_else(crate::workspace_apps::active_webapp).unwrap_or_else(|| "chatgpt".into());
                    let label = format!("webapp_{active_id}");
                    if let Some(view) = app.get_webview(&label) {
                        match view.eval(script) {
                            Ok(()) => ("workspace_webapp".into(), json!({"action": "eval", "status": "executed"}), format!("Script evaluated in {active_id}.")),
                            Err(err) => ("message".into(), json!({}), format!("Script eval failed: {err}")),
                        }
                    } else {
                        ("message".into(), json!({}), format!("Webapp '{active_id}' is not currently loaded."))
                    }
                }
                other => ("message".into(), json!({}), format!("Unknown workspace_webapp action '{other}'. Use list, open, read, click, type, scroll, eval, or close.")),
            }
        }
        "desktop_app" => {
            let app = match desktop_handle(state) {
                Ok(app) => app,
                Err(message) => return ("message".into(), json!({}), message),
            };
            let action = args.get("action").or_else(|| args.get("op")).and_then(|v| v.as_str()).unwrap_or("list").trim().to_lowercase();
            let target_app = args.get("app").or_else(|| args.get("id")).or_else(|| args.get("name")).and_then(|v| v.as_str()).map(str::trim).unwrap_or("");

            match action.as_str() {
                "list" => {
                    let list = crate::workspace_apps::list_available_desktop_apps();
                    let summary = json!({ "desktop_apps": list });
                    ("desktop_app".into(), summary.clone(), format!("Available Desktop Apps:\n{}", serde_json::to_string_pretty(&summary).unwrap_or_default()))
                }
                "open" | "launch" => {
                    let path = args.get("path").and_then(|v| v.as_str());
                    match crate::workspace_apps::launch_desktop(&app, target_app, None, path, None) {
                        Ok(outcome) => ("desktop_app".into(), json!({"action": "launch", "app": target_app, "status": "launched"}), outcome.note),
                        Err(err) => ("message".into(), json!({}), format!("Failed to launch desktop app '{target_app}': {}", err.0)),
                    }
                }
                "inspect" => {
                    let filter = args.get("window").or_else(|| args.get("filter")).and_then(|v| v.as_str()).unwrap_or(target_app);
                    match crate::computer_subsystem::inspect_and_cache(filter) {
                        Ok(nodes) => {
                            let summary: Vec<Value> = nodes.iter().take(30).map(|n| json!({
                                "mark": n.mark_id,
                                "name": n.name,
                                "type": n.control_type,
                                "rect": n.bounds,
                                "center": n.center_xy
                            })).collect();
                            ("desktop_app".into(), json!({"nodes": summary}), format!("Inspected window controls for '{}':\n{}", filter, serde_json::to_string_pretty(&json!(summary)).unwrap_or_default()))
                        }
                        Err(err) => ("message".into(), json!({}), format!("Failed to inspect desktop window: {}", err.0)),
                    }
                }
                "click" => {
                    let mark_id = args.get("mark_id").or_else(|| args.get("id")).and_then(|v| v.as_u64()).map(|n| n as u32).unwrap_or(1);
                    match crate::computer_subsystem::som_click_sync(mark_id) {
                        Ok(msg) => ("desktop_app".into(), json!({"mark_id": mark_id, "action": "click"}), msg),
                        Err(err) => ("message".into(), json!({}), format!("Click failed: {err}")),
                    }
                }
                "type" => {
                    let mark_id = args.get("mark_id").or_else(|| args.get("id")).and_then(|v| v.as_u64()).map(|n| n as u32).unwrap_or(1);
                    let text = args.get("text").and_then(|v| v.as_str()).unwrap_or("");
                    match crate::computer_subsystem::som_type_sync(mark_id, text) {
                        Ok(msg) => ("desktop_app".into(), json!({"mark_id": mark_id, "action": "type"}), msg),
                        Err(err) => ("message".into(), json!({}), format!("Type failed: {err}")),
                    }
                }
                "status" => {
                    let found = crate::util::which(target_app).is_some();
                    ("desktop_app".into(), json!({"app": target_app, "installed": found}), format!("Desktop app '{target_app}' installed: {found}"))
                }
                other => ("message".into(), json!({}), format!("Unknown desktop_app action '{other}'. Use list, open, inspect, click, type, or status.")),
            }
        }
        "install_skill" => {
            let source = args.get("source").or_else(|| args.get("url")).or_else(|| args.get("link")).or_else(|| args.get("slug")).and_then(|v| v.as_str()).unwrap_or("").trim();
            let slug = args.get("slug").or_else(|| args.get("name")).and_then(|v| v.as_str()).map(str::trim);
            let home = state.home.clone();
            with_db(state, |conn| match crate::capabilities::install_skill_from_source(conn, &home, bot_id, source, slug) {
                Ok(msg) => ("skill_install".into(), json!({"source": source, "status": "installed"}), msg),
                Err(error) => ("message".into(), json!({}), error.0),
            })
        }
        "install_plugin" => {
            let source = args.get("source").or_else(|| args.get("url")).or_else(|| args.get("repo")).and_then(|v| v.as_str()).unwrap_or("").trim();
            let slug = args.get("slug").or_else(|| args.get("name")).and_then(|v| v.as_str()).map(str::trim);
            let home = state.home.clone();
            with_db(state, |conn| match crate::capabilities::install_plugin_from_source(conn, &home, bot_id, source, slug) {
                Ok(msg) => ("plugin_install".into(), json!({"source": source, "status": "installed"}), msg),
                Err(error) => ("message".into(), json!({}), error.0),
            })
        }
        "connect_mcp" => {
            let name = args.get("name").or_else(|| args.get("server")).and_then(|v| v.as_str()).unwrap_or("").trim();
            let transport = args.get("transport").and_then(|v| v.as_str());
            let command = args.get("command").or_else(|| args.get("cmd")).and_then(|v| v.as_str());
            let url = args.get("url").or_else(|| args.get("endpoint")).and_then(|v| v.as_str());
            let secret = args.get("secret").or_else(|| args.get("apiKey")).and_then(|v| v.as_str());
            let args_list: Vec<String> = if let Some(arr) = args.get("args").and_then(|v| v.as_array()) {
                arr.iter().filter_map(|s| s.as_str().map(str::to_string)).collect()
            } else if let Some(s) = args.get("args").and_then(|v| v.as_str()) {
                crate::util::split_args(s)
            } else {
                Vec::new()
            };
            let home = state.home.clone();
            with_db(state, |conn| match crate::capabilities::connect_mcp_server(conn, &home, bot_id, name, transport, command, &args_list, url, secret) {
                Ok(msg) => ("mcp_connect".into(), json!({"name": name, "status": "connected"}), msg),
                Err(error) => ("message".into(), json!({}), error.0),
            })
        }
        "list_memory" | "search_memory" | "save_memory" | "list_skills" | "load_skill" | "load_skill_file" | "skill_manage" | "list_providers" | "list_threads" | "list_mcp" | "list_plugins" | "read_file" | "list_files" => {
            with_db(state, |conn| match crate::workspace_bridge::run_chat_tool_with_attachments(conn, name, args, attachments) {
                Ok(text) => ("message".into(), json!({}), text),
                Err(error) => ("message".into(), json!({}), error),
            })
        }
        "save_workflow" => {
            let name = args.get("name").and_then(|item| item.as_str()).unwrap_or("").trim().to_string();
            let steps = args.get("steps").or_else(|| args.get("steps_text")).and_then(|item| item.as_str()).unwrap_or("").to_string();
            let schedule = args.get("schedule").and_then(|item| item.as_str()).unwrap_or("").trim().to_string();
            let home = state.home.clone();
            with_db(state, |conn| match crate::coworker::save_workflow(conn, &home, &name, &steps, &schedule) {
                Ok(note) => ("workflow".into(), json!({"name": name, "schedule": schedule}), note),
                Err(error) => ("message".into(), json!({}), error),
            })
        }
        "schedule_routine" => {
            let raw = args.get("schedule").and_then(|item| item.as_str()).unwrap_or("");
            match crate::coworker::normalize_schedule(raw) {
                Some(schedule) => with_db(state, |conn| match crate::bots::set_routine(conn, thread_id, &schedule) {
                    Ok(()) => (
                        "routine".into(),
                        json!({"threadId": thread_id, "schedule": schedule}),
                        format!("This chat now runs {schedule} while Ronic OS is open. Change or clear it any time from the chat header."),
                    ),
                    Err(error) => ("message".into(), json!({}), error.0),
                }),
                None => ("message".into(), json!({}), "That schedule is not one this app can store. Use daily HH:MM, every 15m, every 1h, or a daily cron like 0 8 * * *.".into()),
            }
        }
        _ => refused,
    }
}

fn propose_diff(project_root: &str, args: &Value) -> (String, Value, String) {
    let path = args.get("path").and_then(|item| item.as_str()).unwrap_or("").trim();
    let body = args.get("body").or_else(|| args.get("content")).and_then(|item| item.as_str()).unwrap_or("");
    if path.is_empty() || body.is_empty() {
        return ("message".into(), json!({}), "propose_diff needs a path and a body.".into());
    }
    let target = match crate::util::confined_join(Path::new(project_root.trim()), path) {
        Ok(path) => path,
        Err(_) => return ("message".into(), json!({}), "That path stays inside the project folder.".into()),
    };
    let old = std::fs::read_to_string(&target).unwrap_or_default();
    if old.contains('\0') {
        return ("message".into(), json!({}), "That file is not text.".into());
    }
    let (added, removed, hunks) = line_hunks(&old, body);
    let payload = json!({
        "status": "pending",
        "file": path,
        "proposedPath": path,
        "proposedBody": body,
        "added": added,
        "removed": removed,
        "hunks": hunks,
        "note": "Not written until Accept."
    });
    ("code_diff".into(), payload, format!("Proposed a diff for {path}. It is not written until Accept."))
}

fn line_hunks(old: &str, new: &str) -> (i64, i64, Value) {
    let old_lines: Vec<&str> = if old.is_empty() { Vec::new() } else { old.lines().collect() };
    let new_lines: Vec<&str> = new.lines().collect();
    let mut hunks = Vec::new();
    let mut added = 0i64;
    let mut removed = 0i64;
    let mut i = 0usize;
    let mut j = 0usize;
    while (i < old_lines.len() || j < new_lines.len()) && hunks.len() < 40 {
        if i < old_lines.len() && j < new_lines.len() && old_lines[i] == new_lines[j] {
            i += 1;
            j += 1;
            continue;
        }
        if i < old_lines.len() && (j >= new_lines.len() || !new_lines[j..].contains(&old_lines[i])) {
            hunks.push(json!({"kind": "del", "text": old_lines[i]}));
            removed += 1;
            i += 1;
            continue;
        }
        if j < new_lines.len() {
            hunks.push(json!({"kind": "ins", "text": new_lines[j]}));
            added += 1;
            j += 1;
        }
    }
    (added, removed, json!(hunks))
}

fn other_computer(bot_id: &str, args: &Value) -> bool {
    args.get("botId")
        .or_else(|| args.get("bot_id"))
        .and_then(|value| value.as_str())
        .is_some_and(|asked| !asked.trim().is_empty() && asked.trim() != bot_id)
}

fn control_id(args: &Value) -> std::result::Result<i64, String> {
    let value = args.get("id").or_else(|| args.get("node"));
    let id = value
        .and_then(|item| item.as_i64().or_else(|| item.as_str().and_then(|text| text.trim().parse().ok())))
        .unwrap_or(0);
    if (1..=40).contains(&id) {
        Ok(id)
    } else {
        Err("that control is not on this page".into())
    }
}

fn desktop_handle(state: &AppState) -> std::result::Result<tauri::AppHandle, String> {
    state.app_handle.lock().ok().and_then(|guard| guard.clone()).ok_or_else(|| "This computer is not open in the desktop app.".into())
}

fn remember_screen(state: &AppState, bot_id: &str, hit: crate::bot_screen::ScreenHit) -> (String, Value, String) {
    with_db(state, |conn| {
        let _ = crate::bot_screen::store_screen(conn, bot_id, &hit.url, &hit.nodes, hit.ms);
    });
    let lines: Vec<String> = hit.nodes.iter().map(|node| format!("[{}] {} {}", node.id, node.tag, node.label)).collect();
    let mut text = format!("{}\n{}", hit.url, hit.text.trim());
    if !lines.is_empty() {
        text.push('\n');
        text.push_str(&lines.join("\n"));
    }
    ("browser_inspect".into(), json!({ "url": hit.url, "log": lines, "latencyMs": hit.ms }), text)
}

/// Keeps the karl's-screen panel fed from mini-window drives too, and adds
/// the two signals the model cannot get from DOM text alone: what a smart
/// action picked, and whether the page's video is actually playing.
fn remember_mini_window(state: &AppState, bot_id: &str, hit: crate::computer_subsystem::MiniWindowHit) -> (String, Value, String) {
    let screen = crate::bot_screen::ScreenHit {
        url: hit.url.clone(),
        text: hit.text.clone(),
        nodes: hit
            .nodes
            .iter()
            .map(|node| crate::models::DomNode { id: node.id, tag: node.tag.clone(), label: node.label.clone(), kind: "control".into() })
            .collect(),
        ms: hit.ms,
    };
    let (kind, payload, mut text) = remember_screen(state, bot_id, screen);
    if let Some(note) = &hit.note {
        text.insert_str(0, format!("{note}\n").as_str());
    }
    if let Some(media) = &hit.media {
        let state_text = if media.playing {
            format!("playing at {}s of {}s{}", media.current_time, media.duration, if media.muted { " (muted)" } else { "" })
        } else if media.paused {
            format!("paused at {}s of {}s", media.current_time, media.duration)
        } else {
            "not started".into()
        };
        text.push_str(&format!("\nmedia: {state_text}"));
    }
    (kind, payload, text)
}

/// The mini window titlebar shows the bot's handle; fall back to @id when the
/// profile row is gone.
fn bot_handle_of(state: &AppState, bot_id: &str) -> String {
    with_db(state, |conn| {
        conn.query_row("SELECT handle FROM bot_profiles WHERE id = ?1", params![bot_id], |row| row.get::<_, String>(0))
            .unwrap_or_else(|_| format!("@{bot_id}"))
    })
}

fn drive_open(state: &AppState, bot_id: &str, url: &str) -> (String, Value, String) {
    let app = match desktop_handle(state) {
        Ok(app) => app,
        Err(message) => return ("message".into(), json!({}), message),
    };
    let handle = bot_handle_of(state, bot_id);
    match crate::computer_subsystem::agent_drive_open(&app, state, bot_id, &handle, url) {
        Ok(hit) => remember_mini_window(state, bot_id, hit),
        Err(error) => ("message".into(), json!({}), error.0),
    }
}

fn drive_read(state: &AppState, bot_id: &str) -> (String, Value, String) {
    let app = match desktop_handle(state) {
        Ok(app) => app,
        Err(message) => return ("message".into(), json!({}), message),
    };
    match crate::computer_subsystem::agent_drive_read(&app, bot_id) {
        Ok(hit) => remember_mini_window(state, bot_id, hit),
        Err(error) => ("message".into(), json!({}), error.0),
    }
}

fn drive_click(state: &AppState, bot_id: &str, id: i64) -> (String, Value, String) {
    let app = match desktop_handle(state) {
        Ok(app) => app,
        Err(message) => return ("message".into(), json!({}), message),
    };
    match crate::computer_subsystem::agent_drive_click(&app, bot_id, id) {
        Ok(hit) => remember_mini_window(state, bot_id, hit),
        Err(error) => ("message".into(), json!({}), error.0),
    }
}

fn drive_type(state: &AppState, bot_id: &str, id: i64, text: &str) -> (String, Value, String) {
    let app = match desktop_handle(state) {
        Ok(app) => app,
        Err(message) => return ("message".into(), json!({}), message),
    };
    match crate::computer_subsystem::agent_drive_type(&app, bot_id, id, text) {
        Ok(hit) => remember_mini_window(state, bot_id, hit),
        Err(error) => ("message".into(), json!({}), error.0),
    }
}

fn sandbox_tool(state: &AppState, bot_id: &str, args: &Value) -> (String, Value, String) {
    let command = args.get("command")
        .or_else(|| args.get("cmd"))
        .or_else(|| args.get("script"))
        .and_then(|item| item.as_str())
        .unwrap_or("")
        .trim();
    if command.chars().any(|c| matches!(c, '&' | '|' | ';' | '<' | '>' | '`' | '$' | '\n' | '\r')) {
        return ("message".into(), json!({}), "pipes, redirects, and command chaining are blocked".into());
    }
    let parts = crate::util::split_args(command);
    let Some(program) = parts.first().map(String::as_str) else {
        return ("message".into(), json!({}), "empty command".into());
    };
    if let Some(reason) = crate::util::interpreter_eval_flag(program, parts.get(1..).unwrap_or(&[])) {
        return ("message".into(), json!({}), reason.into());
    }
    let allowed = [
        "git", "npm", "npm.cmd", "npx", "npx.cmd", "pnpm", "pnpm.cmd", "yarn", "yarn.cmd",
        "node", "python", "python.exe", "python3", "pip", "pip.exe", "uv", "cargo", "rustc",
        "bun", "where", "where.exe", "which", "go", "deno", "tsc", "tsc.cmd", "echo", "cat", "dir", "ls", "pwd",
        "pytest", "ruff", "vitest", "eslint"
    ];
    let prog_lower = program.to_ascii_lowercase();
    if !allowed.contains(&program) && !allowed.contains(&prog_lower.as_str()) {
        return ("message".into(), json!({}), format!("'{program}' is not on the allowed terminal tools list"));
    }
    if let Err(error) = crate::bot_screen::command_stays(command, &parts) {
        return ("message".into(), json!({}), error.0);
    }
    let cwd = match crate::bot_screen::shell_cwd(&state.home, bot_id, "") {
        Ok(dir) => dir,
        Err(error) => return ("message".into(), json!({}), error.0),
    };

    #[cfg(windows)]
    let resolved_program = {
        if !program.ends_with(".exe") && !program.ends_with(".cmd") {
            if crate::util::which(&format!("{program}.cmd")).is_some() {
                format!("{program}.cmd")
            } else if crate::util::which(&format!("{program}.exe")).is_some() {
                format!("{program}.exe")
            } else {
                program.to_string()
            }
        } else {
            program.to_string()
        }
    };
    #[cfg(not(windows))]
    let resolved_program = program.to_string();

    let arg_refs: Vec<&str> = parts.iter().skip(1).map(String::as_str).collect();
    match crate::util::run_capture_stream(&resolved_program, &arg_refs, Some(&cwd), Duration::from_secs(60), |_| {}) {
        Ok((code, output)) => {
            let text = format!("$ {command}\nexit {code}\n{output}");
            with_db(state, |conn| {
                let _ = crate::bot_screen::store_shell(conn, bot_id, &text);
            });
            ("pty_terminal".into(), json!({"command": command, "exitCode": code, "output": output}), text)
        }
        Err(error) => ("message".into(), json!({}), error.0),
    }
}

fn answer(state: &AppState, provider_id: &str, messages: &[ChatMsg], secrets: &HashMap<String, String>, requested_model: Option<&str>, effort: &str, tools: &[Value]) -> std::result::Result<Completion, String> {
    let (kind, endpoint, allow_cli, name): (String, String, i64, String) = with_db(state, |conn| {
        conn.query_row(
            "SELECT provider_type, binary_or_endpoint, allow_cli_dispatch, name FROM provider_accounts WHERE id = ?1",
            params![provider_id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?, r.get::<_, String>(3)?)),
        )
        .map_err(|e| e.to_string())
    })?;
    let key = secrets.get(provider_id).cloned().filter(|k| !k.is_empty());
    let task = messages.iter().map(|message| format!("{}:\n{}", message.role, message.content)).collect::<Vec<_>>().join("\n\n");
    match kind.as_str() {
        "local_ollama" => {
            let requested = requested_model.map(upstream_model).unwrap_or_default();
            if requested.is_empty() {
                return Err("No Ollama model is selected. Refresh the model list after Ollama is running.".into());
            }
            ollama(&endpoint, &requested, messages, effort, tools)
        }
        "cli_subprocess" if allow_cli != 0 && (endpoint.starts_with("wsl:") || (!endpoint.is_empty() && Path::new(&endpoint).exists())) => {
            let output = if endpoint.starts_with("wsl:") {
                let bin = endpoint.trim_start_matches("wsl:");
                run_capture("wsl.exe", &["-e", bin, "-p", &task], None, Duration::from_secs(50)).map_err(|e| e.0)?.1
            } else {
                run_capture(&endpoint, &["-p", &task], None, Duration::from_secs(50)).map_err(|e| e.0)?.1
            };
            if output.trim().is_empty() { Err(format!("{name} exited without text")) } else { Ok(plain_completion(output)) }
        }
        "byok_api" | "official_oauth" | "isolated_webview" | "cli_subprocess" => {
            let plan = key.as_deref().is_some_and(crate::siwc::is_plan_secret);
            let key = if plan {
                match crate::siwc::fresh_bearer(state) {
                    Ok(token) => token,
                    Err(error) => return Err(error.0),
                }
            } else {
                match key {
                    Some(key) => key,
                    None => return Err(format!("{name} has no API key. Continue with ChatGPT, or paste a key, to get a reply in this chat.")),
                }
            };
            let model_owned = match requested_model.map(str::trim).filter(|value| !value.is_empty()) {
                Some(value) => upstream_model(value),
                None => String::new(),
            };
            if model_owned.is_empty() {
                return Err(format!("{name} has a key, but no model is selected."));
            }
            if model_owned.contains(' ') {
                return Err(format!("{name} needs a model id. \"{model_owned}\" is a display name. Refresh the list and pick the model again."));
            }
            let model = model_owned.as_str();
            if plan {
                let mut instructions = String::new();
                let mut input = Vec::new();
                for message in messages {
                    if message.role == "system" {
                        if !instructions.is_empty() {
                            instructions.push_str("\n\n");
                        }
                        instructions.push_str(&message.content);
                    } else {
                        let role = if message.role == "assistant" { "assistant" } else { "user" };
                        input.push((role.to_string(), message.content.clone()));
                    }
                }
                let text = crate::siwc::complete_text(&key, model, &crate::siwc::PlanTurn { instructions, input }, token_budget(effort), request_limit(effort))?;
                return Ok(plain_completion(text));
            }
            let (protocol, base) = api_route(provider_id, &endpoint);
            let with_tools = !tools.is_empty();
            let first = complete_http(protocol, &base, &key, model, messages, effort, if with_tools { tools } else { &[] }, true);
            match first {
                Err(error) if with_tools && tools_rejected(&error) => complete_http(protocol, &base, &key, model, messages, effort, &[], true),
                other => other,
            }
        }
        other => Err(format!("unknown provider lane {other}")),
    }
}

fn plain_completion(text: String) -> Completion {
    Completion { text, thinking: String::new(), tool_calls: Vec::new() }
}

fn tools_rejected(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    if lower.contains("not found for model") || lower.contains("function id") {
        return false;
    }
    lower.contains("tool") || lower.contains("function")
}

fn short_model(id: &str) -> String {
    let tail = id.rsplit(['/', ':']).next().unwrap_or(id).trim();
    tail.chars().take(48).collect()
}

fn bind_selected_model(messages: &mut [ChatMsg], model: Option<&str>) {
    let Some(model) = model.map(str::trim).filter(|value| !value.is_empty()) else { return };
    let note = format!("\n\nThis turn is answered only by model id `{model}`. Earlier assistant text in this chat may be from a different model. Do not adopt that model's name. If asked which model you are, answer with `{model}`.");
    if let Some(system) = messages.iter_mut().find(|message| message.role == "system") {
        system.content.push_str(&note);
    }
    for message in messages.iter_mut() {
        if message.role == "assistant" && message.tool_calls.is_empty() && !message.content.starts_with("[Earlier reply") {
            message.content = format!("[Earlier reply, not from {model}]\n{}", message.content);
        }
    }
}

fn quick_question(text: &str) -> bool {
    let text = text.trim();
    if text.is_empty() || text.len() > 240 || text.starts_with('/') {
        return false;
    }
    let lower = text.to_ascii_lowercase();
    let task = [
        "mcp", "composio", "skill", "plugin", "file", "folder", "command", "run", "check", "list",
        "connect", "install", "open", "read", "write", "remember", "search", "wallet", "browser", "page",
        "diff", "git", "npm", "cargo", "access", "webapp", "web app", "desktop", "chatgpt", "claude",
        "gemini", "grok", "deepseek", "qwen", "nvidia", "perplexity", "copilot", "app", "window",
        "control", "auto", "inspect", "click", "type", "submit", "enter", "scroll", "working", "work",
        "status", "test", "start", "proceed", "continue", "go ahead", "show", "look", "see", "find",
        "help", "yes", "do it", "can you", "try", "please", "again"
    ];
    if task.iter().any(|word| lower.contains(word)) {
        return false;
    }
    let is_greeting_or_id = lower.contains("model")
        || lower.contains("who are you")
        || lower.contains("what is your name")
        || lower.starts_with("hi")
        || lower.starts_with("hello")
        || lower.starts_with("hey");
    is_greeting_or_id
}

fn token_budget(effort: &str) -> u32 {
    match effort {
        "fast" => 2048,
        "high" => 8192,
        "max" => 16384,
        "xhigh" => 32768,
        _ => 4096,
    }
}

fn request_limit(effort: &str) -> Duration {
    match effort {
        "fast" => Duration::from_secs(60),
        "max" | "xhigh" => Duration::from_secs(180),
        _ => Duration::from_secs(90),
    }
}

fn complete_http(protocol: &str, base: &str, key: &str, model: &str, messages: &[ChatMsg], effort: &str, tools: &[Value], reasoning: bool) -> std::result::Result<Completion, String> {
    let result = match protocol {
        "anthropic" => anthropic(base, key, model, messages, effort, tools),
        "gemini" => gemini(base, key, model, messages, effort, tools),
        "bedrock" => bedrock(base, key, model, messages, effort),
        _ => openai(base, key, model, messages, effort, tools, reasoning),
    };
    if reasoning {
        if let Err(error) = &result {
            if error.to_ascii_lowercase().contains("reasoning") {
                return complete_http(protocol, base, key, model, messages, effort, tools, false);
            }
        }
    }
    result
}

fn api_route(id: &str, endpoint: &str) -> (&'static str, String) {
    match id {
        "prov_chatgpt" => ("openai", "https://api.openai.com/v1".into()),
        "prov_grok" => ("openai", "https://api.x.ai/v1".into()),
        "prov_gemini" => ("gemini", "https://generativelanguage.googleapis.com/v1beta".into()),
        "prov_claude" | "prov_anthropic" => ("anthropic", "https://api.anthropic.com".into()),
        "prov_bedrock" => ("bedrock", if endpoint.contains("bedrock") { endpoint.trim_end_matches('/').into() } else { "https://bedrock-runtime.us-east-1.amazonaws.com".into() }),
        "prov_nvidia" => ("openai", "https://integrate.api.nvidia.com/v1".into()),
        "prov_mistral" => ("openai", "https://api.mistral.ai/v1".into()),
        "prov_groq" => ("openai", "https://api.groq.com/openai/v1".into()),
        "prov_perplexity" => ("openai", "https://api.perplexity.ai".into()),
        "prov_together" => ("openai", "https://api.together.xyz/v1".into()),
        "prov_cohere" => ("openai", "https://api.cohere.com/compatibility/v1".into()),
        "prov_tokenrouter" => ("openai", if endpoint.contains("tokenrouter") { endpoint.trim_end_matches('/').into() } else { "https://api.tokenrouter.io/v1".into() }),
        _ => ("openai", endpoint.trim_end_matches('/').to_string()),
    }
}

fn upstream_model(id: &str) -> String {
    if let Some(name) = id.strip_prefix("ollama:") {
        return name.to_string();
    }
    if let Some((provider, rest)) = id.split_once(':') {
        if provider.starts_with("prov_") && !rest.is_empty() {
            return rest.to_string();
        }
    }
    match id {
        "or-gpt-4o-mini" | "tr-gpt-4o-mini" => "openai/gpt-4o-mini".into(),
        "or-claude" => "anthropic/claude-sonnet-4.5".into(),
        "or-grok" => "x-ai/grok-4".into(),
        "tr-auto" => "auto".into(),
        "bedrock-claude" => "anthropic.claude-3-5-sonnet-20241022-v2:0".into(),
        "nim-llama-70b" => "nvidia/llama-3.1-nemotron-70b-instruct".into(),
        "nim-nemotron" => "nvidia/llama-3.1-nemotron-70b-instruct".into(),
        "ollama-llama" => String::new(),
        other => other.to_string(),
    }
}

struct HeldClient {
    epoch: u64,
    client: Option<reqwest::blocking::Client>,
}

fn build_chat_client() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(120))
        .build()
        .unwrap_or_else(|_| reqwest::blocking::Client::new())
}

pub(crate) fn chat_client() -> reqwest::blocking::Client {
    static SLOT: OnceLock<Mutex<HeldClient>> = OnceLock::new();
    let slot = SLOT.get_or_init(|| Mutex::new(HeldClient { epoch: 0, client: None }));
    let mut held = slot.lock().unwrap_or_else(|poison| poison.into_inner());
    let epoch = CLIENT_EPOCH.load(Ordering::SeqCst);
    if held.client.is_none() || held.epoch != epoch {
        held.client = Some(build_chat_client());
        held.epoch = epoch;
    }
    held.client.as_ref().expect("chat client").clone()
}

pub(crate) struct HttpJob {
    pub method: &'static str,
    pub url: String,
    pub bearer: Option<String>,
    pub headers: Vec<(String, String)>,
    pub json_body: Option<Value>,
    pub form: Option<Vec<(String, String)>>,
    pub limit: Duration,
    pub cancel_on_refresh: bool,
}

pub(crate) fn run_off_runtime<T: Send + 'static>(limit: Duration, cancel_on_refresh: bool, work: impl FnOnce() -> T + Send + 'static) -> std::result::Result<T, String> {
    let epoch = turn_epoch();
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    if let Err(error) = std::thread::Builder::new().name("ronic-model".into()).spawn(move || {
        let _ = tx.send(work());
    }) {
        return Err(error.to_string());
    }
    let started = Instant::now();
    loop {
        if cancel_on_refresh && turn_epoch() != epoch {
            return Err("The reply was cleared. Send the question again.".into());
        }
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(value) => return Ok(value),
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return Err("The model call stopped.".into()),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                if started.elapsed() >= limit {
                    return Err("The model host did not answer in time. Try the send again.".into());
                }
            }
        }
    }
}

pub(crate) fn http_call(job: HttpJob) -> std::result::Result<(u16, String), String> {
    let limit = job.limit;
    let cancel = job.cancel_on_refresh;
    match run_off_runtime(limit, cancel, move || {
        let client = chat_client();
        let mut request = if job.method == "GET" { client.get(&job.url) } else { client.post(&job.url) };
        request = request.timeout(limit);
        if let Some(token) = &job.bearer {
            request = request.bearer_auth(token);
        }
        for (name, value) in &job.headers {
            request = request.header(name.as_str(), value.as_str());
        }
        let sent = if let Some(body) = &job.json_body {
            request.json(body).send()
        } else if let Some(form) = &job.form {
            let pairs: Vec<(&str, &str)> = form.iter().map(|(key, value)| (key.as_str(), value.as_str())).collect();
            request.form(&pairs).send()
        } else {
            request.send()
        };
        let response = sent.map_err(transport_error)?;
        let status = response.status().as_u16();
        let text = response.text().map_err(transport_error)?;
        Ok((status, text))
    }) {
        Ok(result) => result,
        Err(error) => Err(error),
    }
}

fn transport_error(error: reqwest::Error) -> String {
    let timed_out = error.is_timeout();
    let connect = error.is_connect();
    let bare = error.without_url().to_string();
    if timed_out {
        "The model host did not answer in time. Try the send again.".into()
    } else if connect || bare.contains("error sending request") {
        "Could not reach the model host. Check the network, then try again.".into()
    } else {
        format!("The model host did not answer. {bare}")
    }
}

fn ollama(endpoint: &str, requested: &str, messages: &[ChatMsg], effort: &str, tools: &[Value]) -> std::result::Result<Completion, String> {
    if requested.is_empty() {
        return Err("No Ollama model is selected.".into());
    }
    let base = endpoint.trim_end_matches('/');
    let limit = request_limit(effort);
    let (tag_status, _) = http_call(HttpJob {
        method: "GET",
        url: format!("{base}/api/tags"),
        bearer: None,
        headers: Vec::new(),
        json_body: None,
        form: None,
        limit,
        cancel_on_refresh: true,
    }).map_err(|error| format!("Ollama is not reachable at {base}: {error}"))?;
    if !(200..300).contains(&tag_status) {
        return Err(format!("Ollama HTTP {tag_status}"));
    }
    let mut body = json!({"model": requested, "stream": false, "messages": wire_messages(messages), "options": {"num_predict": token_budget(effort)}});
    if !tools.is_empty() {
        body["tools"] = json!(tools);
    }
    let (status, text) = http_call(HttpJob {
        method: "POST",
        url: format!("{base}/api/chat"),
        bearer: None,
        headers: Vec::new(),
        json_body: Some(body),
        form: None,
        limit,
        cancel_on_refresh: true,
    })?;
    if !(200..300).contains(&status) {
        let v: Value = serde_json::from_str(&text).unwrap_or(json!({}));
        let detail = v["error"].as_str().unwrap_or("request failed");
        let error = format!("Ollama HTTP {status}. {detail}");
        if !tools.is_empty() && tools_rejected(&error) {
            return ollama(endpoint, requested, messages, effort, &[]);
        }
        return Err(error);
    }
    let v: serde_json::Value = serde_json::from_str(&text).unwrap_or(json!({}));
    completion_from_message(&v["message"])
}

fn provider_rejection(model: &str, status: reqwest::StatusCode, body: &Value) -> String {
    let msg = body["error"]["message"]
        .as_str()
        .or_else(|| body["detail"].as_str())
        .or_else(|| body["message"].as_str())
        .or_else(|| body["title"].as_str())
        .unwrap_or("request failed");
    let text = format!("HTTP {status} for model {model}: {msg}");
    let lower = text.to_ascii_lowercase();
    if lower.contains("not found for model") || lower.contains("function id") {
        return format!("{text} That model is not on this account. Refresh the provider and pick a model from its list.");
    }
    text
}

fn wire_messages(messages: &[ChatMsg]) -> Value {
    json!(messages.iter().map(|message| {
        if message.role == "tool" {
            json!({
                "role": "tool",
                "tool_call_id": message.tool_call_id,
                "name": message.name,
                "content": message.content
            })
        } else if message.role == "assistant" && !message.tool_calls.is_empty() {
            json!({
                "role": "assistant",
                "content": if message.content.is_empty() { Value::Null } else { json!(message.content) },
                "tool_calls": message.tool_calls.iter().map(|call| json!({
                    "id": call.id,
                    "type": "function",
                    "function": { "name": call.name, "arguments": call.arguments }
                })).collect::<Vec<_>>()
            })
        } else {
            let role = if message.role == "system" || message.role == "assistant" { message.role.as_str() } else { "user" };
            json!({"role": role, "content": message.content})
        }
    }).collect::<Vec<_>>())
}

fn anthropic_messages(messages: &[ChatMsg]) -> (String, Value) {
    let system = messages.iter().filter(|message| message.role == "system").map(|message| message.content.as_str()).collect::<Vec<_>>().join("\n\n");
    let mut out: Vec<Value> = Vec::new();
    for message in messages {
        if message.role == "system" {
            continue;
        }
        if message.role == "tool" {
            let block = json!({
                "type": "tool_result",
                "tool_use_id": message.tool_call_id,
                "content": message.content
            });
            if let Some(last) = out.last_mut() {
                if last["role"] == "user" && last["content"].is_array() {
                    if let Some(parts) = last["content"].as_array_mut() {
                        parts.push(block);
                        continue;
                    }
                }
            }
            out.push(json!({ "role": "user", "content": [block] }));
            continue;
        }
        if message.role == "assistant" && !message.tool_calls.is_empty() {
            let mut content = Vec::new();
            if !message.content.is_empty() {
                content.push(json!({ "type": "text", "text": message.content }));
            }
            for call in &message.tool_calls {
                let input: Value = serde_json::from_str(&call.arguments).unwrap_or_else(|_| json!({}));
                content.push(json!({
                    "type": "tool_use",
                    "id": call.id,
                    "name": call.name,
                    "input": input
                }));
            }
            out.push(json!({ "role": "assistant", "content": content }));
            continue;
        }
        let role = if message.role == "assistant" { "assistant" } else { "user" };
        if let Some(last) = out.last_mut() {
            if last["role"] == role && last["content"].is_string() {
                let joined = format!("{}\n\n{}", last["content"].as_str().unwrap_or(""), message.content);
                last["content"] = json!(joined);
                continue;
            }
        }
        out.push(json!({"role": role, "content": message.content}));
    }
    if out.is_empty() {
        out.push(json!({"role": "user", "content": "Continue."}));
    }
    (system, json!(out))
}

fn text_of(value: &Value) -> String {
    if let Some(text) = value.as_str() {
        return text.trim().to_string();
    }
    value.as_array().map(|parts| parts.iter().filter_map(|part| part["text"].as_str().or_else(|| part.as_str())).collect::<Vec<_>>().join("")).unwrap_or_default().trim().to_string()
}

fn tool_calls_of(value: &Value) -> Vec<ToolCall> {
    let Some(calls) = value.as_array() else { return Vec::new() };
    calls.iter().filter_map(|call| {
        let name = call["function"]["name"].as_str().or_else(|| call["name"].as_str()).unwrap_or("").trim().to_string();
        if name.is_empty() {
            return None;
        }
        let arguments = if let Some(text) = call["function"]["arguments"].as_str() {
            text.to_string()
        } else if call["function"]["arguments"].is_object() {
            call["function"]["arguments"].to_string()
        } else if call["arguments"].is_object() || call["arguments"].is_string() {
            call["arguments"].to_string()
        } else {
            "{}".into()
        };
        let id = call["id"].as_str().unwrap_or("").trim().to_string();
        Some(ToolCall { id, name, arguments })
    }).collect()
}

fn parse_think_tags(raw: &str) -> (String, String) {
    let mut thinking_chunks = Vec::new();
    let mut text = raw.to_string();

    let tag_pairs = [
        ("<ant-thinking>", "</ant-thinking>"),
        ("<thinking>", "</thinking>"),
        ("<think>", "</think>"),
        ("<thought>", "</thought>"),
        ("<reasoning>", "</reasoning>"),
        ("[THINK]", "[/THINK]"),
    ];

    // 1. Extract closed tag pairs
    let mut iteration = 0;
    while iteration < 20 {
        iteration += 1;
        let mut matched = false;
        for (open_tag, close_tag) in &tag_pairs {
            if let Some(start) = text.find(open_tag) {
                if let Some(end_rel) = text[start + open_tag.len()..].find(close_tag) {
                    let end = start + open_tag.len() + end_rel;
                    let thought = text[start + open_tag.len()..end].trim().to_string();
                    if !thought.is_empty() {
                        thinking_chunks.push(thought);
                    }
                    text.replace_range(start..end + close_tag.len(), "");
                    matched = true;
                    break;
                }
            }
        }
        if !matched {
            break;
        }
    }

    // 2. Handle orphan closing tags where thinking started at token 0 without an open tag
    // e.g. "Let me check if I can reach ChatGPT... </ant-thinking>Here is the result."
    let close_tags = ["</ant-thinking>", "</thinking>", "</think>", "</thought>", "</reasoning>", "[/THINK]"];
    for close_tag in &close_tags {
        if let Some(end) = text.find(close_tag) {
            let thought = text[..end].trim().to_string();
            if !thought.is_empty() {
                thinking_chunks.push(thought);
            }
            text = text[end + close_tag.len()..].to_string();
        }
    }

    // 3. Handle unclosed opening tags at the end of the completion
    let open_tags = ["<ant-thinking>", "<thinking>", "<think>", "<thought>", "<reasoning>", "[THINK]"];
    for open_tag in &open_tags {
        if let Some(start) = text.find(open_tag) {
            let thought = text[start + open_tag.len()..].trim().to_string();
            if !thought.is_empty() {
                thinking_chunks.push(thought);
            }
            text = text[..start].to_string();
        }
    }

    // 4. Final sweep of any remaining stray thinking tags
    for (open_tag, close_tag) in &tag_pairs {
        text = text.replace(open_tag, "").replace(close_tag, "");
    }

    (thinking_chunks.join("\n\n").trim().to_string(), text.trim().to_string())
}

fn completion_from_message(message: &Value) -> std::result::Result<Completion, String> {
    let raw_text = text_of(&message["content"]);
    let mut thinking = message["reasoning_content"].as_str().or_else(|| message["reasoning"].as_str()).unwrap_or("").trim().to_string();
    let (tag_thinking, clean_text) = parse_think_tags(&raw_text);
    if thinking.is_empty() && !tag_thinking.is_empty() {
        thinking = tag_thinking.clone();
    }
    let text = if !tag_thinking.is_empty() { clean_text } else { raw_text };
    let mut tool_calls = tool_calls_of(&message["tool_calls"]);
    let (sanitized_text, extracted_calls) = extract_all_tool_calls(&text);
    if tool_calls.is_empty() && !extracted_calls.is_empty() {
        tool_calls = extracted_calls;
    }
    let text = if !tool_calls.is_empty() { sanitized_text } else { text };
    if text.is_empty() && thinking.is_empty() && tool_calls.is_empty() {
        return Err("empty completion".into());
    }
    Ok(Completion { text, thinking, tool_calls })
}

fn openai(endpoint: &str, key: &str, model: &str, messages: &[ChatMsg], effort: &str, tools: &[Value], reasoning: bool) -> std::result::Result<Completion, String> {
    let base = endpoint.trim_end_matches('/');
    let url = if base.ends_with("/chat/completions") { base.to_string() } else { format!("{base}/chat/completions") };
    let mut body = json!({"model": model, "messages": wire_messages(messages), "max_tokens": token_budget(effort)});
    if reasoning && matches!(effort, "max" | "xhigh") {
        body["reasoning_effort"] = json!(if effort == "xhigh" { "high" } else { "medium" });
    }
    if !tools.is_empty() {
        body["tools"] = json!(tools);
    }
    let (status, text) = http_call(HttpJob {
        method: "POST",
        url,
        bearer: Some(key.to_string()),
        headers: Vec::new(),
        json_body: Some(body),
        form: None,
        limit: request_limit(effort),
        cancel_on_refresh: true,
    })?;
    let v: serde_json::Value = serde_json::from_str(&text).unwrap_or(json!({}));
    let code = reqwest::StatusCode::from_u16(status).unwrap_or(reqwest::StatusCode::INTERNAL_SERVER_ERROR);
    if !code.is_success() {
        return Err(provider_rejection(model, code, &v));
    }
    completion_from_message(&v["choices"][0]["message"])
}

fn anthropic(endpoint: &str, key: &str, model: &str, messages: &[ChatMsg], effort: &str, tools: &[Value]) -> std::result::Result<Completion, String> {
    let base = endpoint.trim_end_matches('/');
    let (system, wire) = anthropic_messages(messages);
    let mut body = json!({"model": model, "max_tokens": token_budget(effort), "system": system, "messages": wire});
    if !tools.is_empty() {
        let spec = tools.iter().map(|tool| json!({
            "name": tool["function"]["name"],
            "description": tool["function"]["description"],
            "input_schema": tool["function"]["parameters"],
        })).collect::<Vec<_>>();
        body["tools"] = json!(spec);
    }
    let (status, text) = http_call(HttpJob {
        method: "POST",
        url: format!("{base}/v1/messages"),
        bearer: None,
        headers: vec![("x-api-key".into(), key.to_string()), ("anthropic-version".into(), "2023-06-01".into())],
        json_body: Some(body),
        form: None,
        limit: request_limit(effort),
        cancel_on_refresh: true,
    })?;
    let v: serde_json::Value = serde_json::from_str(&text).unwrap_or(json!({}));
    if !(200..300).contains(&status) {
        return Err(format!("HTTP {status}: {}", v["error"]["message"].as_str().unwrap_or("request failed")));
    }
    let parts = v["content"].as_array().cloned().unwrap_or_default();
    let text = parts.iter().filter(|part| part["type"] == "text").filter_map(|part| part["text"].as_str()).collect::<Vec<_>>().join("").trim().to_string();
    let thinking = parts.iter().filter(|part| part["type"] == "thinking").filter_map(|part| part["thinking"].as_str()).collect::<Vec<_>>().join("\n").trim().to_string();
    let tool_calls = parts.iter().filter(|part| part["type"] == "tool_use").filter_map(|part| {
        let name = part["name"].as_str().unwrap_or("").trim().to_string();
        if name.is_empty() { return None; }
        Some(ToolCall { id: part["id"].as_str().unwrap_or("").trim().to_string(), name, arguments: part["input"].to_string() })
    }).collect::<Vec<_>>();
    if text.is_empty() && thinking.is_empty() && tool_calls.is_empty() {
        return Err("empty completion".into());
    }
    Ok(Completion { text, thinking, tool_calls })
}

fn gemini(endpoint: &str, key: &str, model: &str, messages: &[ChatMsg], effort: &str, tools: &[Value]) -> std::result::Result<Completion, String> {
    let base = endpoint.trim_end_matches('/');
    let (system, contents) = gemini_contents(messages);
    let mut body = json!({
        "contents": contents,
        "generationConfig": { "maxOutputTokens": token_budget(effort) }
    });
    if !system.is_empty() {
        body["systemInstruction"] = json!({ "parts": [{ "text": system }] });
    }
    let decls = gemini_tool_decls(tools);
    if !decls.is_empty() {
        body["tools"] = json!([{ "functionDeclarations": decls }]);
    }
    let (status, raw) = http_call(HttpJob {
        method: "POST",
        url: format!("{base}/models/{model}:generateContent"),
        bearer: None,
        headers: vec![("x-goog-api-key".into(), key.to_string())],
        json_body: Some(body),
        form: None,
        limit: request_limit(effort),
        cancel_on_refresh: true,
    })?;
    let v: serde_json::Value = serde_json::from_str(&raw).unwrap_or(json!({}));
    if !(200..300).contains(&status) {
        return Err(format!("HTTP {status}: {}", v["error"]["message"].as_str().unwrap_or("request failed")));
    }
    let parts = v["candidates"][0]["content"]["parts"].as_array().cloned().unwrap_or_default();
    let mut text = String::new();
    let mut thinking = String::new();
    let mut tool_calls = Vec::new();
    for (index, part) in parts.iter().enumerate() {
        if part["thought"].as_bool() == Some(true) {
            if let Some(chunk) = part["text"].as_str() {
                if !thinking.is_empty() {
                    thinking.push('\n');
                }
                thinking.push_str(chunk.trim());
            }
            continue;
        }
        if let Some(chunk) = part["text"].as_str() {
            text.push_str(chunk);
        }
        if let Some(name) = part["functionCall"]["name"].as_str().map(str::trim).filter(|name| !name.is_empty()) {
            let args = part["functionCall"]["args"].clone();
            let arguments = if args.is_null() { "{}".into() } else { args.to_string() };
            tool_calls.push(ToolCall {
                id: format!("call_{index}_{name}"),
                name: name.to_string(),
                arguments,
            });
        }
    }
    let text = text.trim().to_string();
    if text.is_empty() && thinking.is_empty() && tool_calls.is_empty() {
        return Err("empty completion".into());
    }
    Ok(Completion { text, thinking, tool_calls })
}

fn gemini_tool_decls(tools: &[Value]) -> Vec<Value> {
    tools
        .iter()
        .filter_map(|tool| {
            let name = tool["function"]["name"].as_str()?;
            Some(json!({
                "name": name,
                "description": tool["function"]["description"],
                "parameters": tool["function"]["parameters"]
            }))
        })
        .collect()
}

fn gemini_contents(messages: &[ChatMsg]) -> (String, Vec<Value>) {
    let system = messages.iter().filter(|message| message.role == "system").map(|message| message.content.as_str()).collect::<Vec<_>>().join("\n\n");
    let mut contents: Vec<Value> = Vec::new();
    for message in messages {
        if message.role == "system" {
            continue;
        }
        if message.role == "tool" {
            let name = if message.name.is_empty() { "tool" } else { message.name.as_str() };
            let part = json!({ "functionResponse": { "name": name, "response": { "result": message.content } } });
            if let Some(last) = contents.last_mut() {
                if last["role"] == "user" {
                    if let Some(parts) = last["parts"].as_array_mut() {
                        parts.push(part);
                        continue;
                    }
                }
            }
            contents.push(json!({ "role": "user", "parts": [part] }));
            continue;
        }
        if message.role == "assistant" {
            let mut parts = Vec::new();
            if !message.content.is_empty() {
                parts.push(json!({ "text": message.content }));
            }
            for call in &message.tool_calls {
                let args: Value = serde_json::from_str(&call.arguments).unwrap_or_else(|_| json!({}));
                parts.push(json!({ "functionCall": { "name": call.name, "args": args } }));
            }
            if parts.is_empty() {
                parts.push(json!({ "text": "" }));
            }
            contents.push(json!({ "role": "model", "parts": parts }));
            continue;
        }
        contents.push(json!({ "role": "user", "parts": [{ "text": message.content }] }));
    }
    let mut merged: Vec<Value> = Vec::new();
    for item in contents {
        if let Some(last) = merged.last_mut() {
            if last["role"] == item["role"] {
                if let (Some(left), Some(right)) = (last["parts"].as_array_mut(), item["parts"].as_array()) {
                    left.extend(right.iter().cloned());
                    continue;
                }
            }
        }
        merged.push(item);
    }
    if merged.first().is_some_and(|item| item["role"] != "user") {
        merged.insert(0, json!({ "role": "user", "parts": [{ "text": "." }] }));
    }
    if merged.is_empty() {
        merged.push(json!({ "role": "user", "parts": [{ "text": "Continue." }] }));
    }
    (system, merged)
}

fn bedrock(endpoint: &str, key: &str, model: &str, messages: &[ChatMsg], effort: &str) -> std::result::Result<Completion, String> {
    let base = endpoint.trim_end_matches('/');
    let (system, wire) = anthropic_messages(messages);
    let talk = wire.as_array().cloned().unwrap_or_default();
    let packed: Vec<Value> = talk.iter().map(|message| json!({"role": message["role"], "content": [{"text": message["content"]}]})).collect();
    let body = json!({"system": [{"text": system}], "inferenceConfig": {"maxTokens": token_budget(effort)}, "messages": packed});
    let url = format!("{base}/model/{}/converse", urlencoding(model));
    let (status, raw) = http_call(HttpJob {
        method: "POST",
        url,
        bearer: Some(key.to_string()),
        headers: Vec::new(),
        json_body: Some(body),
        form: None,
        limit: request_limit(effort),
        cancel_on_refresh: true,
    })?;
    let v: serde_json::Value = serde_json::from_str(&raw).unwrap_or(json!({}));
    if !(200..300).contains(&status) {
        return Err(format!("HTTP {status}: {}", v["message"].as_str().unwrap_or("request failed")));
    }
    let parts = v["output"]["message"]["content"].as_array().cloned().unwrap_or_default();
    let reply = parts.iter().filter_map(|part| part["text"].as_str()).collect::<Vec<_>>().join("").trim().to_string();
    if reply.is_empty() {
        return Err("empty completion".into());
    }
    Ok(plain_completion(reply))
}

fn urlencoding(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn payment_amount(prompt: &str) -> Option<f64> {
    let lower = prompt.to_ascii_lowercase();
    let intent = Regex::new(r"(?i)\b(pay|micropay|x402)\b|send\s+\$").ok()?;
    if !intent.is_match(&lower) {
        return None;
    }
    let re = Regex::new(r"\$([0-9]+(?:\.[0-9]+)?)").ok()?;
    let caps = re.captures(prompt)?;
    caps.get(1)?.as_str().parse().ok()
}

fn audit(root: &Path) -> String {
    if !root.exists() {
        return format!("Project root does not exist: {}", root.display());
    }
    let mut hits = Vec::new();
    let mut files = 0usize;
    let mut stack = vec![root.to_path_buf()];
    let skip = ["node_modules", "target", "dist", ".git"];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for entry in rd.flatten() {
            if hits.len() >= 30 || files >= 2500 {
                break;
            }
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if path.is_dir() {
                if !skip.contains(&name.as_str()) {
                    stack.push(path);
                }
                continue;
            }
            files += 1;
            if name == ".env" || name.ends_with(".pem") || name == "id_rsa" {
                hits.push(format!("{} — sensitive filename", path.display()));
                continue;
            }
            if let Some(text) = crate::util::read_to_string_limited(&path, 200_000) {
                for (i, line) in text.lines().enumerate() {
                    let kind = if line.contains("BEGIN PRIVATE KEY") || line.contains("BEGIN OPENSSH PRIVATE KEY") {
                        "private key"
                    } else if line.contains("sk-ant-") || line.contains("sk-proj-") || line.contains("AKIA") {
                        "token"
                    } else {
                        continue;
                    };
                    hits.push(format!("{}:{} — {kind} redacted", path.display(), i + 1));
                    if hits.len() >= 30 {
                        break;
                    }
                }
            }
        }
    }
    if hits.is_empty() {
        format!("No token-shaped lines in {files} files under {}", root.display())
    } else {
        format!("Checked {files} files under {}\n{}", root.display(), hits.join("\n"))
    }
}

#[derive(Clone)]
pub struct ProviderAuth {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub endpoint: String,
    pub secret: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListedModel {
    pub id: String,
    pub label: String,
    pub provider_id: String,
    pub kind: String,
    pub preview_base: String,
    pub upstream_model: String,
    pub group: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelList {
    pub models: Vec<ListedModel>,
    pub notes: Vec<String>,
}

pub fn list_connected_models(rows: Vec<ProviderAuth>) -> ProviderModelList {
    let mut models = Vec::new();
    let mut notes = Vec::new();
    let mut keyed = 0u32;
    for row in &rows {
        if row.kind == "local_ollama" || row.id == "prov_ollama" {
            match ollama_models(row) {
                Ok(found) => {
                    if found.is_empty() {
                        notes.push("Ollama is running and has no models installed.".into());
                    } else {
                        notes.push(format!("Ollama: {} models.", found.len()));
                        models.extend(found);
                    }
                }
                Err(error) => notes.push(format!("Ollama {error}.")),
            }
            continue;
        }
        if let Some(token) = crate::siwc::plan_bearer(&row.secret) {
            keyed += 1;
            match crate::siwc::fetch_models(&token) {
                Ok(found) => {
                    notes.push(format!("{}: {} models.", row.name, found.len()));
                    for (slug, display) in found {
                        push_model(&mut models, row, "openai", &slug, Some(display.as_str()));
                    }
                }
                Err(error) => notes.push(format!("{} {error}.", row.name)),
            }
            continue;
        }
        if row.secret.trim().is_empty() {
            continue;
        }
        keyed += 1;
        match remote_models(row) {
            Ok(found) => {
                notes.push(format!("{}: {} models.", row.name, found.len()));
                models.extend(found);
            }
            Err(error) => notes.push(format!("{} {error}.", row.name)),
        }
    }
    if keyed == 0 {
        notes.insert(0, "No API keys are stored. Continue with ChatGPT, or open a provider and paste a key. Ollama models appear when it is running.".into());
    }
    ProviderModelList { models, notes }
}

fn ollama_models(row: &ProviderAuth) -> std::result::Result<Vec<ListedModel>, String> {
    let endpoint = row.endpoint.trim().trim_end_matches('/');
    let base = if endpoint.starts_with("http") { endpoint.to_string() } else { "http://127.0.0.1:11434".into() };
    let body = get_json(&format!("{base}/api/tags"), &[])?;
    let mut out = Vec::new();
    let Some(rows) = body["models"].as_array() else {
        return Ok(out);
    };
    for item in rows {
        let Some(name) = item["name"].as_str().map(str::trim).filter(|name| !name.is_empty()) else { continue };
        push_model(&mut out, row, "ollama", name, None);
    }
    Ok(out)
}

fn remote_models(row: &ProviderAuth) -> std::result::Result<Vec<ListedModel>, String> {
    let (protocol, base) = api_route(&row.id, &row.endpoint);
    if protocol == "bedrock" {
        return Err("does not publish a model list here. Add the model id with Add custom model".into());
    }
    let secret = row.secret.trim();
    let bearer = format!("Bearer {secret}");
    let (url, headers): (String, Vec<(&str, &str)>) = match protocol {
        "anthropic" => (format!("{base}/v1/models"), vec![("x-api-key", secret), ("anthropic-version", "2023-06-01")]),
        "gemini" => (format!("{base}/models"), vec![("x-goog-api-key", secret)]),
        _ => (format!("{base}/models"), vec![("Authorization", bearer.as_str())]),
    };
    let body = get_json(&url, &headers)?;
    let mut out = Vec::new();
    if protocol == "gemini" {
        let Some(rows) = body["models"].as_array() else { return Ok(out) };
        for item in rows {
            let methods = item["supportedGenerationMethods"].as_array();
            if let Some(methods) = methods {
                let generates = methods.iter().any(|method| method.as_str() == Some("generateContent"));
                if !methods.is_empty() && !generates {
                    continue;
                }
            }
            let raw = item["name"].as_str().unwrap_or("").trim();
            let upstream = raw.strip_prefix("models/").unwrap_or(raw);
            let display = item["displayName"].as_str();
            push_model(&mut out, row, protocol, upstream, display);
        }
        return Ok(out);
    }
    let Some(rows) = body["data"].as_array() else { return Ok(out) };
    for item in rows {
        let upstream = item["id"].as_str().unwrap_or("").trim();
        let display = item["display_name"].as_str().or_else(|| item["name"].as_str());
        push_model(&mut out, row, protocol, upstream, display);
    }
    Ok(out)
}

fn push_model(out: &mut Vec<ListedModel>, row: &ProviderAuth, protocol: &str, upstream: &str, display: Option<&str>) {
    if upstream.is_empty() || out.len() >= 200 || skip_model(upstream) {
        return;
    }
    if out.iter().any(|item| item.upstream_model == upstream) {
        return;
    }
    let label = display.unwrap_or("").trim();
    out.push(ListedModel {
        id: format!("{}:{upstream}", row.id),
        label: if label.is_empty() { upstream.to_string() } else { label.to_string() },
        provider_id: row.id.clone(),
        kind: match protocol {
            "anthropic" => "anthropic",
            "gemini" => "gemini",
            "bedrock" => "bedrock",
            "ollama" => "ollama",
            _ => "openai",
        }.into(),
        preview_base: preview_base(&row.id).into(),
        upstream_model: upstream.to_string(),
        group: group_name(&row.id).into(),
    });
}

fn skip_model(id: &str) -> bool {
    let id = id.to_ascii_lowercase();
    ["embed", "whisper", "tts", "audio", "image", "moderation", "rerank", "realtime", "transcribe", "dall-e", "clip", "bge-", "voyage"]
        .iter()
        .any(|needle| id.contains(needle))
}

fn preview_base(id: &str) -> &'static str {
    match id {
        "prov_chatgpt" => "/proxy/openai/v1",
        "prov_grok" => "/proxy/xai/v1",
        "prov_gemini" => "/proxy/gemini/v1beta",
        "prov_claude" | "prov_anthropic" => "/proxy/anthropic",
        "prov_bedrock" => "/proxy/bedrock",
        "prov_nvidia" => "/proxy/nvidia/v1",
        "prov_mistral" => "/proxy/mistral/v1",
        "prov_groq" => "/proxy/groq/openai/v1",
        "prov_perplexity" => "/proxy/perplexity",
        "prov_together" => "/proxy/together/v1",
        "prov_cohere" => "/proxy/cohere/compatibility/v1",
        "prov_tokenrouter" => "/proxy/tokenrouter/v1",
        "prov_openrouter" => "/proxy/openrouter/api/v1",
        "prov_deepseek" => "/proxy/deepseek/v1",
        "prov_qwen" => "/proxy/qwen/compatible-mode/v1",
        "prov_ollama" => "/proxy/ollama",
        _ => "",
    }
}

fn group_name(id: &str) -> &'static str {
    match id {
        "prov_chatgpt" => "ChatGPT",
        "prov_claude" | "prov_anthropic" => "Claude",
        "prov_gemini" => "Gemini",
        "prov_grok" => "Grok",
        "prov_openrouter" => "OpenRouter",
        "prov_deepseek" => "DeepSeek",
        "prov_qwen" => "Qwen",
        "prov_tokenrouter" => "TokenRouter",
        "prov_bedrock" => "Bedrock",
        "prov_nvidia" => "NVIDIA NIM",
        "prov_mistral" => "Mistral",
        "prov_groq" => "Groq",
        "prov_perplexity" => "Perplexity",
        "prov_together" => "Together",
        "prov_cohere" => "Cohere",
        "prov_ollama" => "Ollama",
        _ => "Custom",
    }
}

#[cfg(test)]
mod tests {
    use super::{fold_history, gemini_contents, quick_question, wire_messages, ChatMsg, ToolCall};
    use serde_json::json;

    fn row(role: &str, model: &str, content: &str, action: &str) -> (String, String, String, String) {
        (role.into(), model.into(), content.into(), action.into())
    }

    #[test]
    fn fold_history_keeps_tools_with_the_reply_and_skips_thinking() {
        let folded = fold_history(
            &[
                row("user", "", "hello", "message"),
                row("tool", "search_memory", "hit", "message"),
                row("assistant", "Bot", "answer", "message"),
                row("assistant", "Bot", "secret thought", "thinking"),
            ],
            "system",
            "capsule",
            12_000,
        );
        assert_eq!(folded[0].role, "system");
        assert!(!folded[0].content.contains("Earlier in this thread"));
        assert_eq!(folded[1].role, "user");
        assert_eq!(folded[1].content, "hello");
        assert!(folded[2].content.contains("Tool search_memory:"));
        assert!(folded[2].content.contains("hit"));
        assert!(folded[2].content.contains("answer"));
        assert!(folded.iter().all(|message| !message.content.contains("secret thought")));
        assert!(folded.iter().all(|message| message.role != "tool"));
    }

    #[test]
    fn fold_history_drops_the_oldest_message_and_keeps_the_capsule() {
        let long = "x".repeat(8_000);
        let folded = fold_history(
            &[
                row("user", "", &long, "message"),
                row("assistant", "Bot", &long, "message"),
                row("user", "", "latest question", "message"),
            ],
            "system",
            "capsule text",
            12_000,
        );
        assert!(folded[0].content.contains("Earlier in this thread:\ncapsule text"));
        assert!(folded.iter().any(|message| message.content == "latest question"));
        assert!(!folded.iter().any(|message| message.role == "user" && message.content == long));
        assert!(folded.len() > 1);
    }

    #[test]
    fn a_short_question_skips_the_tool_path() {
        assert!(quick_question("hi which model are you"));
        assert!(quick_question("which model are you"));
        assert!(!quick_question("check for mcp servers configs or connect one ( composio.io )"));
        assert!(!quick_question("/find-skills"));
        assert!(!quick_question("yes, can you do it"));
        assert!(!quick_question("now can you access desktop webapp"));
        assert!(!quick_question("hey are you working or not"));
        assert!(!quick_question("open chatgpt"));
    }

    #[test]
    fn parse_think_tags_handles_ant_thinking_and_orphans() {
        use super::parse_think_tags;

        let raw = "Let me check if I can reach ChatGPT as a webapp or visible window right now. </ant-thinking>";
        let (thought, text) = parse_think_tags(raw);
        assert_eq!(thought, "Let me check if I can reach ChatGPT as a webapp or visible window right now.");
        assert_eq!(text, "");

        let raw_paired = "<ant-thinking>Analyzing user environment...</ant-thinking>I am ready to access the webapp.";
        let (thought2, text2) = parse_think_tags(raw_paired);
        assert_eq!(thought2, "Analyzing user environment...");
        assert_eq!(text2, "I am ready to access the webapp.");

        let raw_standard = "<thinking>Step 1</thinking>Result";
        let (thought3, text3) = parse_think_tags(raw_standard);
        assert_eq!(thought3, "Step 1");
        assert_eq!(text3, "Result");
    }

    #[test]
    fn wire_messages_keeps_native_tool_calls() {
        let messages = vec![
            ChatMsg::new("system", "sys"),
            ChatMsg::new("user", "hi"),
            ChatMsg::assistant_tools(
                "calling",
                vec![ToolCall {
                    id: "c1".into(),
                    name: "search_memory".into(),
                    arguments: "{\"query\":\"x\"}".into(),
                }],
            ),
            ChatMsg::tool_result("c1", "search_memory", "hit"),
        ];
        let wire = wire_messages(&messages);
        assert_eq!(wire[2]["role"], "assistant");
        assert_eq!(wire[2]["tool_calls"][0]["id"], "c1");
        assert_eq!(wire[2]["tool_calls"][0]["function"]["name"], "search_memory");
        assert_eq!(wire[3]["role"], "tool");
        assert_eq!(wire[3]["tool_call_id"], "c1");
        assert_eq!(wire[3]["content"], "hit");
    }

    #[test]
    fn gemini_contents_uses_function_response() {
        let messages = vec![
            ChatMsg::new("system", "sys"),
            ChatMsg::new("user", "hi"),
            ChatMsg::assistant_tools(
                "",
                vec![ToolCall {
                    id: "c1".into(),
                    name: "list_skills".into(),
                    arguments: "{}".into(),
                }],
            ),
            ChatMsg::tool_result("c1", "list_skills", "none"),
        ];
        let (system, contents) = gemini_contents(&messages);
        assert_eq!(system, "sys");
        assert_eq!(contents[0]["role"], "user");
        let blob = json!(contents).to_string();
        assert!(blob.contains("functionCall"));
        assert!(blob.contains("functionResponse"));
        assert!(blob.contains("list_skills"));
        assert!(!blob.contains("tool:\n"));
    }
}

fn get_json(url: &str, headers: &[(&str, &str)]) -> std::result::Result<Value, String> {
    static CLIENT: OnceLock<reqwest::blocking::Client> = OnceLock::new();
    let client = CLIENT.get_or_init(|| {
        reqwest::blocking::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(8))
            .build()
            .unwrap_or_else(|_| reqwest::blocking::Client::new())
    });
    let mut req = client.get(url);
    for (key, value) in headers {
        req = req.header(*key, *value);
    }
    let res = match req.send() {
        Ok(res) => res,
        Err(error) => {
            let _ = error.without_url();
            return Err("did not answer".into());
        }
    };
    let status = res.status();
    let body: Value = res.json().unwrap_or(json!({}));
    if !status.is_success() {
        let msg = body["error"]["message"].as_str().or_else(|| body["message"].as_str()).unwrap_or("request failed");
        return Err(format!("HTTP {status}: {msg}"));
    }
    Ok(body)
}
