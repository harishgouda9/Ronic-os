use crate::db::{self, insert_step, kv_get, kv_set};
use crate::error::{err, Result};
use crate::models::*;
use crate::snapshot::{self, Meta};
use crate::util::{nid, now_ms, run_capture};
use crate::AppState;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};

fn sanitize_mark(raw: &str) -> String {
    let Some(id) = raw.trim().strip_prefix("mark:") else { return "NW".into() };
    let id = id.trim();
    if id.len() <= 16 && !id.is_empty() && id.chars().all(|ch| ch.is_ascii_lowercase()) {
        return format!("mark:{id}");
    }
    "NW".into()
}

pub(crate) fn guard(state: &AppState) -> std::sync::MutexGuard<'_, Connection> {
    state.conn.lock().unwrap_or_else(|e| e.into_inner())
}

pub(crate) fn finish(state: &AppState, toast: Option<String>) -> Result<CommandResult> {
    finish_with(state, toast, None)
}

async fn dispatch_blocking(
    app: &AppHandle,
    prompt: String,
    secrets: std::collections::HashMap<String, String>,
    provider_id: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    files: Vec<String>,
) -> Result<String> {
    let app = app.clone();
    match tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        crate::agent::dispatch(&state, &prompt, &secrets, provider_id.as_deref(), model.as_deref(), effort.as_deref(), &files)
    })
    .await
    {
        Ok(result) => result,
        Err(error) => {
            crate::agent::release_turn();
            Err(err(format!("The reply stopped. {error}")))
        }
    }
}

fn finish_with(state: &AppState, toast: Option<String>, install_choice: Option<String>) -> Result<CommandResult> {
    let meta = Meta {
        home: state.home.display().to_string(),
        heartbeat_ms: state.heartbeat.load(Ordering::Relaxed),
        proxy_port: state.proxy_port.load(Ordering::Relaxed),
        ipc: state.ipc.lock().unwrap_or_else(|e| e.into_inner()).iter().cloned().collect(),
        unlocked: state.unlocked.load(Ordering::Relaxed),
    };
    let conn = guard(state);
    Ok(CommandResult { snapshot: snapshot::load(&conn, &meta)?, toast, install_choice, payload: None })
}

pub(crate) fn finish_payload(state: &AppState, toast: Option<String>, payload: Option<Value>) -> Result<CommandResult> {
    let meta = Meta {
        home: state.home.display().to_string(),
        heartbeat_ms: state.heartbeat.load(Ordering::Relaxed),
        proxy_port: state.proxy_port.load(Ordering::Relaxed),
        ipc: state.ipc.lock().unwrap_or_else(|e| e.into_inner()).iter().cloned().collect(),
        unlocked: state.unlocked.load(Ordering::Relaxed),
    };
    let conn = guard(state);
    Ok(CommandResult { snapshot: snapshot::load(&conn, &meta)?, toast, install_choice: None, payload })
}

#[tauri::command]
pub async fn bootstrap(state: State<'_, AppState>) -> Result<CommandResult> {
    {
        let conn = guard(&state);
        let _ = crate::scan::note_installed_apps(&conn);
        let _ = crate::memory::refresh_active_vault(&conn);
    }
    finish(&state, None)
}

#[tauri::command]
pub async fn scan_environment(state: State<'_, AppState>) -> Result<CommandResult> {
    let (found, missing, started) = crate::scan::discover();
    let report = {
        let conn = guard(&state);
        crate::scan::commit(&conn, found, missing, started)?
    };
    finish(&state, Some(format!("Scan finished in {}ms. {} tools found, {} missing.", report.duration_ms, report.found.len(), report.missing.len())))
}

#[tauri::command]
pub async fn complete_onboarding(state: State<'_, AppState>) -> Result<CommandResult> {
    {
        let conn = guard(&state);
        kv_set(&conn, "onboarding_complete", "1")?;
    }
    finish(&state, Some("Workspace is local. Nothing was uploaded.".into()))
}

#[tauri::command]
pub async fn link_apps(state: State<'_, AppState>) -> Result<CommandResult> {
    let n = {
        let conn = guard(&state);
        crate::scan::link_ready(&conn)?
    };
    finish(&state, Some(format!("Linked {n} detected tools.")))
}

#[tauri::command]
pub async fn switch_profile(state: State<'_, AppState>, profile_id: String) -> Result<CommandResult> {
    {
        let conn = guard(&state);
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM bot_profiles WHERE id=?1", params![profile_id], |r| r.get(0))?;
        if n == 0 {
            return Err(err("profile not found"));
        }
        kv_set(&conn, "active_profile", &profile_id)?;
        let thread: Option<String> = conn.query_row(
            "SELECT id FROM chat_threads WHERE bot_profile_id=?1 AND target_type<>'bot_group' ORDER BY updated_at DESC LIMIT 1",
            params![profile_id],
            |r| r.get(0),
        ).ok();
        kv_set(&conn, "active_thread", thread.as_deref().unwrap_or(""))?;
    }
    finish(&state, None)
}

#[tauri::command]
pub async fn select_thread(state: State<'_, AppState>, thread_id: String) -> Result<CommandResult> {
    {
        let conn = guard(&state);
        db::require_thread(&conn, &thread_id)?;
        let bot: String = conn.query_row("SELECT bot_profile_id FROM chat_threads WHERE id=?1", params![thread_id], |r| r.get(0))?;
        kv_set(&conn, "active_thread", &thread_id)?;
        kv_set(&conn, "active_profile", &bot)?;
    }
    finish(&state, None)
}

#[tauri::command]
pub async fn create_thread(state: State<'_, AppState>, title: String) -> Result<CommandResult> {
    {
        let conn = guard(&state);
        let profile = crate::agent::ensure_profile(&conn)?;
        let id = nid("thread");
        let title = if title.trim().is_empty() { "New task".to_string() } else { title.trim().to_string() };
        let (owner, target, group) = match kv_get(&conn, "active_thread")? {
            Some(active) => conn
                .query_row(
                    "SELECT bot_profile_id, target_type, group_id FROM chat_threads WHERE id=?1",
                    params![active],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)),
                )
                .unwrap_or_else(|_| (profile.clone(), "direct_bot".into(), String::new())),
            None => (profile.clone(), "direct_bot".into(), String::new()),
        };
        let (owner, target, group) = if target == "bot_group" && !group.is_empty() {
            (owner, target, group)
        } else {
            (profile, "direct_bot".into(), String::new())
        };
        conn.execute(
            "INSERT INTO chat_threads (id, bot_profile_id, title, status, compacted_context_capsule, is_pinned, updated_at, target_type, group_id, routine_schedule) VALUES (?1,?2,?3,'idle','',0,?4,?5,?6,'')",
            params![id, owner, title, now_ms(), target, group],
        )?;
        kv_set(&conn, "active_thread", &id)?;
    }
    finish(&state, Some("New task opened.".into()))
}

#[tauri::command]
pub async fn send_message(app: AppHandle, state: State<'_, AppState>, prompt: String, provider_id: Option<String>, model: Option<String>, effort: Option<String>, attachments: Option<Vec<String>>) -> Result<CommandResult> {
    let secrets = state.secrets.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let files = attachments.unwrap_or_default();
    let toast = dispatch_blocking(&app, prompt, secrets, provider_id, model, effort, files).await?;
    crate::util::ipc_push(&state.ipc, "agent/dispatch completed");
    finish(&state, Some(toast))
}

#[tauri::command]
pub async fn set_thread_model(state: State<'_, AppState>, thread_id: String, provider_id: String) -> Result<CommandResult> {
    {
        let conn = guard(&state);
        conn.execute("UPDATE chat_threads SET active_model_override_id=?1 WHERE id=?2", params![provider_id, thread_id])?;
    }
    finish(&state, None)
}

#[tauri::command]
pub async fn set_diff_status(state: State<'_, AppState>, step_id: String, status: String) -> Result<CommandResult> {
    if status != "accepted" && status != "rejected" && status != "pending" {
        return Err(err("unknown diff status"));
    }
    {
        let conn = guard(&state);
        let raw: String = conn.query_row("SELECT action_payload_json FROM execution_steps WHERE id=?1", params![step_id], |r| r.get(0)).map_err(|_| err("step not found"))?;
        let mut payload: Value = serde_json::from_str(&raw).unwrap_or(json!({}));
        payload["status"] = json!(status);
        if status == "accepted" {
            if let (Some(path), Some(body)) = (payload.get("proposedPath").and_then(|v| v.as_str()), payload.get("proposedBody").and_then(|v| v.as_str())) {
                let settings = db::settings_of(&conn)?;
                let root = std::path::PathBuf::from(&settings.project_root);
                let target = crate::util::confined_join(&root, path)?;
                if let Some(parent) = target.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                std::fs::write(target, body)?;
            }
        }
        conn.execute("UPDATE execution_steps SET action_payload_json=?1 WHERE id=?2", params![payload.to_string(), step_id])?;
    }
    finish(&state, Some(format!("Diff {status}.")))
}

#[tauri::command]
pub async fn save_profile(state: State<'_, AppState>, profile: BotProfile) -> Result<CommandResult> {
    {
        let conn = guard(&state);
        let n = conn.execute(
            "UPDATE bot_profiles SET handle=?1, display_name=?2, avatar=?3, soul_markdown=?4, primary_account_id=?5, long_context_account_id=?6, fallback_account_id=?7, allow_computer_use=?8, allow_browser_use=?9, allow_code_exec=?10, scoped_obsidian_folder=?11, daily_wallet_limit_usd=?12, role=?13, status_line=?14, harness_lane_id=?15, ag_ui_endpoint_url=?16, allow_file_write=?17, require_approval_external=?18, require_approval_wallet=?19, stall_timeout_ms=?20, avatar_color=?21 WHERE id=?22",
            params![profile.handle, profile.display_name, profile.avatar, profile.soul_markdown, profile.primary_account_id, profile.long_context_account_id, profile.fallback_account_id, profile.allow_computer_use as i64, profile.allow_browser_use as i64, profile.allow_code_exec as i64, profile.scoped_obsidian_folder, profile.daily_wallet_limit_usd, profile.role, profile.status_line, profile.harness_lane_id, profile.ag_ui_endpoint_url, profile.allow_file_write as i64, profile.require_approval_external as i64, profile.require_approval_wallet as i64, profile.stall_timeout_ms, profile.avatar_color, profile.id],
        )?;
        if n == 0 {
            return Err(err("profile not found"));
        }
    }
    finish(&state, Some("Profile saved.".into()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewProfile {
    pub handle: String,
    pub display_name: String,
    pub role: String,
    pub soul_markdown: String,
    #[serde(default)]
    pub harness_lane_id: String,
    #[serde(default)]
    pub ag_ui_endpoint_url: String,
    #[serde(default)]
    pub skills: String,
    #[serde(default)]
    pub plugins: String,
    #[serde(default)]
    pub avatar: String,
    #[serde(default)]
    pub avatar_color: String,
}

/// Handles are unique in bot_profiles. A second bot with the same name gets a
/// numbered handle instead of a failed INSERT.
fn unique_handle(conn: &Connection, handle: &str) -> String {
    let clean = handle.trim();
    let clean = if clean.starts_with('@') { clean.to_string() } else { format!("@{clean}") };
    for n in 0..200 {
        let candidate = if n == 0 { clean.clone() } else { format!("{clean}-{n}") };
        let taken: bool = conn
            .query_row("SELECT COUNT(*) FROM bot_profiles WHERE handle=?1", params![candidate], |row| row.get::<_, i64>(0))
            .map(|count| count > 0)
            .unwrap_or(true);
        if !taken {
            return candidate;
        }
    }
    format!("{clean}-{}", now_ms())
}

#[tauri::command]
pub async fn create_profile(state: State<'_, AppState>, draft: NewProfile) -> Result<CommandResult> {
    {
        let conn = guard(&state);
        let id = nid("bot");
        let handle = unique_handle(&conn, &draft.handle);
        let harness = draft.harness_lane_id.trim();
        let primary = crate::bots::account_for_harness(harness).unwrap_or("prov_ollama");
        let avatar = sanitize_mark(&draft.avatar);
        conn.execute(
            "INSERT INTO bot_profiles (id, handle, display_name, avatar, soul_markdown, primary_account_id, long_context_account_id, fallback_account_id, allow_computer_use, allow_browser_use, allow_code_exec, scoped_obsidian_folder, daily_wallet_limit_usd, is_pinned, role, created_at, harness_lane_id, ag_ui_endpoint_url, status_line, avatar_color) VALUES (?1,?2,?3,?4,?5,?6,'prov_gemini','prov_openrouter',1,1,1,'',5,1,?7,?8,?9,?10,'Just created',?11)",
            params![id, handle, draft.display_name, avatar, draft.soul_markdown, primary, draft.role, now_ms(), harness, draft.ag_ui_endpoint_url.trim(), draft.avatar_color.trim()],
        )?;
        crate::bots::attach_names(&conn, &state.home, &id, &draft.skills, &draft.plugins)?;
        // Enable the workspace's prebuilt skills for this new profile now,
        // instead of waiting for the next snapshot reconcile.
        if let Ok(settings) = db::settings_of(&conn) {
            let _ = crate::capabilities::reconcile(&conn, &state.home, settings.project_root.trim());
        }
        kv_set(&conn, "active_profile", &id)?;
        kv_set(&conn, "active_thread", "")?;
    }
    finish(&state, Some("Bot created. It has its own computer and workspace.".into()))
}

#[tauri::command]
pub async fn duplicate_profile(state: State<'_, AppState>, profile_id: String) -> Result<CommandResult> {
    {
        let conn = guard(&state);
        let src = conn.query_row(
            "SELECT handle, display_name, avatar, soul_markdown, primary_account_id, long_context_account_id, fallback_account_id, role, engine, command_or_url FROM bot_profiles WHERE id=?1",
            params![profile_id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?, r.get::<_, String>(4)?, r.get::<_, String>(5)?, r.get::<_, String>(6)?, r.get::<_, String>(7)?, r.get::<_, String>(8)?, r.get::<_, String>(9)?)),
        ).map_err(|_| err("profile not found"))?;
        let id = nid("bot");
        conn.execute(
            "INSERT INTO bot_profiles (id, handle, display_name, avatar, soul_markdown, primary_account_id, long_context_account_id, fallback_account_id, allow_computer_use, allow_browser_use, allow_code_exec, scoped_obsidian_folder, daily_wallet_limit_usd, is_pinned, role, created_at, engine, command_or_url, run_status) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,1,1,1,'',5,0,?9,?10,?11,?12,'stopped')",
            params![id, format!("{}-copy", src.0), format!("{} copy", src.1), src.2, src.3, src.4, src.5, src.6, src.7, now_ms(), src.8, src.9],
        )?;
        conn.execute(
            "UPDATE bot_profiles SET harness_lane_id=(SELECT harness_lane_id FROM bot_profiles WHERE id=?1), ag_ui_endpoint_url=(SELECT ag_ui_endpoint_url FROM bot_profiles WHERE id=?1), allow_file_write=(SELECT allow_file_write FROM bot_profiles WHERE id=?1), require_approval_external=(SELECT require_approval_external FROM bot_profiles WHERE id=?1), require_approval_wallet=(SELECT require_approval_wallet FROM bot_profiles WHERE id=?1), stall_timeout_ms=(SELECT stall_timeout_ms FROM bot_profiles WHERE id=?1), avatar_color=(SELECT avatar_color FROM bot_profiles WHERE id=?1) WHERE id=?2",
            params![profile_id, id],
        )?;
    }
    finish(&state, Some("Profile duplicated.".into()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewGroup {
    pub title: String,
    pub purpose: String,
    pub coordination_mode: String,
    pub member_bot_ids: Vec<String>,
}

#[tauri::command]
pub async fn create_bot_group(state: State<'_, AppState>, draft: NewGroup) -> Result<CommandResult> {
    {
        let conn = guard(&state);
        // Freemium gate: autonomous bot-to-bot squads are the Pro converter.
        // Starter keeps 1-on-1 bot chat; dev builds are entitled.
        if !crate::licensing::pro_entitled(&conn) {
            return Err(err("Multi-bot squads are a Ronic Pro feature. Starter keeps 1-on-1 bot chat — upgrade any time from Plan & setup."));
        }
        let id = crate::bots::create_group(&conn, &state.home, &draft.title, &draft.purpose, &draft.coordination_mode, &draft.member_bot_ids)?;
        crate::bots::open_group(&conn, &id)?;
    }
    finish(&state, Some("Group created. The bots share one thread.".into()))
}

#[tauri::command]
pub async fn open_group(state: State<'_, AppState>, group_id: String) -> Result<CommandResult> {
    {
        let conn = guard(&state);
        crate::bots::open_group(&conn, &group_id)?;
    }
    finish(&state, None)
}

#[tauri::command]
pub async fn set_group_mode(state: State<'_, AppState>, group_id: String, mode: String) -> Result<CommandResult> {
    {
        let conn = guard(&state);
        crate::bots::set_mode(&conn, &group_id, &mode)?;
    }
    finish(&state, Some("Coordination mode saved.".into()))
}

#[tauri::command]
pub async fn set_routine(state: State<'_, AppState>, thread_id: String, schedule: String) -> Result<CommandResult> {
    let cleared = schedule.trim().is_empty();
    {
        let conn = guard(&state);
        crate::bots::set_routine(&conn, &thread_id, &schedule)?;
    }
    finish(&state, Some(if cleared { "Routine removed.".into() } else { "Routine saved on this thread.".into() }))
}

#[tauri::command]
pub async fn run_routine(app: AppHandle, state: State<'_, AppState>, thread_id: String, provider_id: Option<String>, model: Option<String>, effort: Option<String>) -> Result<CommandResult> {
    let secrets = state.secrets.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let prompt = {
        let conn = guard(&state);
        let prompt = crate::bots::routine_prompt(&conn, &thread_id)?;
        kv_set(&conn, "active_thread", &thread_id)?;
        prompt
    };
    let toast = dispatch_blocking(&app, prompt, secrets, provider_id, model, effort, Vec::new()).await?;
    finish(&state, Some(toast))
}

#[tauri::command]
pub async fn resolve_gateway(app: AppHandle, state: State<'_, AppState>, step_id: String, approve: bool, provider_id: Option<String>, model: Option<String>, effort: Option<String>) -> Result<CommandResult> {
    let secrets = state.secrets.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let app = app.clone();
    let toast = match tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        crate::bots::decide(&state, &step_id, approve, &secrets, provider_id.as_deref(), model.as_deref(), effort.as_deref())
    })
    .await
    {
        Ok(result) => result?,
        Err(error) => {
            crate::agent::release_turn();
            return Err(err(format!("The reply stopped. {error}")));
        }
    };
    finish(&state, Some(toast))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeachDraft {
    pub bot_id: String,
    pub title: String,
    pub notes: String,
    #[serde(default)]
    pub url: String,
}

#[tauri::command]
pub async fn teach_task(state: State<'_, AppState>, draft: TeachDraft) -> Result<CommandResult> {
    let slash = {
        let conn = guard(&state);
        crate::bots::teach(&conn, &state.home, &draft.bot_id, &draft.title, &draft.notes, &draft.url)?
    };
    finish(&state, Some(format!("Saved {slash}.")))
}

#[tauri::command]
pub async fn set_takeover(state: State<'_, AppState>, bot_id: String, on: bool) -> Result<CommandResult> {
    {
        let conn = guard(&state);
        crate::bots::set_takeover(&conn, &bot_id, on)?;
    }
    finish(&state, Some(if on { "You have control of this bot's computer.".into() } else { "The bot can work again.".into() }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderPatch {
    pub id: String,
    pub quota_used_percent: f64,
    pub fallback_account_id: Option<String>,
    pub is_active: bool,
    pub allow_cli_dispatch: bool,
    pub binary_or_endpoint: String,
    pub quota_resets_at: String,
}

#[tauri::command]
pub async fn update_provider(state: State<'_, AppState>, patch: ProviderPatch) -> Result<CommandResult> {
    {
        let conn = guard(&state);
        conn.execute(
            "UPDATE provider_accounts SET quota_used_percent=?1, fallback_account_id=?2, is_active=?3, allow_cli_dispatch=?4, binary_or_endpoint=?5, quota_resets_at=?6 WHERE id=?7",
            params![patch.quota_used_percent, patch.fallback_account_id, patch.is_active as i64, patch.allow_cli_dispatch as i64, patch.binary_or_endpoint, patch.quota_resets_at, patch.id],
        )?;
    }
    finish(&state, Some("Provider updated.".into()))
}

#[tauri::command]
pub async fn add_provider(
    state: State<'_, AppState>,
    id: Option<String>,
    name: String,
    provider_type: String,
    binary_or_endpoint: String,
    api_key: Option<String>,
) -> Result<CommandResult> {
    let raw_name = name.trim().to_string();
    if raw_name.is_empty() {
        return Err(err("Provider name cannot be empty"));
    }
    let prov_id = id.filter(|s| !s.trim().is_empty()).unwrap_or_else(|| {
        let slug: String = raw_name
            .to_lowercase()
            .chars()
            .map(|c| if c.is_alphanumeric() { c } else { '_' })
            .collect();
        format!("prov_{}", slug.trim_matches('_'))
    });
    let now = now_ms();
    let has_key = api_key.as_ref().map(|k| !k.trim().is_empty()).unwrap_or(false);
    let initial_health = if has_key {
        "Key stored locally.".to_string()
    } else {
        "Added. Ready to connect.".to_string()
    };
    {
        let conn = guard(&state);
        conn.execute(
            "INSERT INTO provider_accounts (id, name, provider_type, binary_or_endpoint, has_secret, quota_window_hours, quota_used_percent, quota_resets_at, fallback_account_id, is_active, allow_cli_dispatch, last_health_check_ms, health_detail, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 5, 0.0, '', NULL, 1, ?6, NULL, ?7, ?8)
             ON CONFLICT(id) DO UPDATE SET name=?2, provider_type=?3, binary_or_endpoint=?4",
            params![
                prov_id,
                raw_name,
                provider_type,
                binary_or_endpoint.trim(),
                if has_key { 1 } else { 0 },
                if provider_type == "cli_subprocess" { 1 } else { 0 },
                initial_health,
                now
            ],
        )?;

        if let Some(key) = api_key {
            let key = key.trim().to_string();
            if !key.is_empty() {
                let key_guard = state.vault_key.lock().unwrap_or_else(|e| e.into_inner());
                let mut secrets = state.secrets.lock().unwrap_or_else(|e| e.into_inner());
                secrets.insert(prov_id.clone(), key);
                crate::vault::persist(&state.home, &conn, key_guard.as_ref(), &secrets)?;
            }
        }
    }
    finish(&state, Some(format!("Provider '{raw_name}' added.")))
}

#[tauri::command]
pub async fn set_provider_secret(state: State<'_, AppState>, id: String, secret: String) -> Result<CommandResult> {
    let secret = secret.trim().to_string();
    if secret.is_empty() {
        return Err(err("empty key"));
    }
    {
        let conn = guard(&state);
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM provider_accounts WHERE id=?1", params![id], |r| r.get(0))?;
        if n == 0 {
            return Err(err("provider not found"));
        }
        let key_guard = state.vault_key.lock().unwrap_or_else(|e| e.into_inner());
        let mut secrets = state.secrets.lock().unwrap_or_else(|e| e.into_inner());
        secrets.insert(id.clone(), secret);
        crate::vault::persist(&state.home, &conn, key_guard.as_ref(), &secrets)?;
        conn.execute("UPDATE provider_accounts SET has_secret=1, health_detail='Key stored locally.' WHERE id=?1", params![id])?;
    }
    finish(&state, Some("Key stored locally. It will not be shown again.".into()))
}

#[tauri::command]
pub async fn sign_in_chatgpt(state: State<'_, AppState>) -> Result<CommandResult> {
    let existing = {
        let secrets = state.secrets.lock().unwrap_or_else(|e| e.into_inner());
        secrets.get("prov_chatgpt").cloned().and_then(|raw| raw.trim().strip_prefix("siwc1:").and_then(|json| serde_json::from_str(json).ok()))
    };
    let (row, note) = tauri::async_runtime::spawn_blocking(move || crate::siwc::authorize(existing))
        .await
        .map_err(|error| err(format!("ChatGPT sign-in failed: {error}")))??;
    crate::siwc::store_plan(&state, &row)?;
    finish(&state, Some(note))
}

#[tauri::command]
pub async fn list_provider_models(state: State<'_, AppState>) -> Result<crate::agent::ProviderModelList> {
    let _ = crate::siwc::refresh_chatgpt(&state);
    let secrets = state.secrets.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let rows = {
        let conn = guard(&state);
        let mut stmt = conn.prepare("SELECT id, name, provider_type, binary_or_endpoint FROM provider_accounts")?;
        let collected = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        collected
            .into_iter()
            .map(|(id, name, kind, endpoint)| {
                let secret = secrets.get(&id).cloned().unwrap_or_default();
                crate::agent::ProviderAuth { id, name, kind, endpoint, secret }
            })
            .collect::<Vec<_>>()
    };
    tauri::async_runtime::spawn_blocking(move || crate::agent::list_connected_models(rows))
        .await
        .map_err(|error| err(format!("model list failed: {error}")))
}

#[tauri::command]
pub async fn test_provider(state: State<'_, AppState>, id: String) -> Result<CommandResult> {
    let (kind, endpoint, name): (String, String, String) = {
        let conn = guard(&state);
        conn.query_row(
            "SELECT provider_type, binary_or_endpoint, name FROM provider_accounts WHERE id=?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        ).map_err(|_| err("provider not found"))?
    };
    let secret = {
        let secrets = state.secrets.lock().unwrap_or_else(|e| e.into_inner());
        secrets.get(&id).cloned().unwrap_or_default()
    };
    let probe_id = id.clone();
    let detail = tauri::async_runtime::spawn_blocking(move || probe(&probe_id, &kind, &endpoint, &name, &secret))
        .await
        .map_err(|error| err(format!("provider test failed: {error}")))?;
    {
        let conn = guard(&state);
        conn.execute("UPDATE provider_accounts SET last_health_check_ms=?1, health_detail=?2 WHERE id=?3", params![now_ms(), detail, id])?;
    }
    finish(&state, Some(detail))
}

fn probe(id: &str, kind: &str, endpoint: &str, name: &str, secret: &str) -> String {
    let started = Instant::now();
    match kind {
        "local_ollama" => {
            let ep = if endpoint.trim().is_empty() { "http://127.0.0.1:11434" } else { endpoint.trim() };
            let url = format!("{}/api/tags", ep.trim_end_matches('/'));
            match reqwest::blocking::Client::builder().connect_timeout(Duration::from_secs(2)).timeout(Duration::from_secs(3)).build().and_then(|c| c.get(url).send()) {
                Ok(res) if res.status().is_success() => {
                    let body = res.json::<serde_json::Value>().ok();
                    let count = body.and_then(|b| b["models"].as_array().map(|a| a.len())).unwrap_or(0);
                    format!("{name} responded on this machine in {}ms ({} models installed).", started.elapsed().as_millis(), count)
                }
                Ok(res) => format!("{name} HTTP {} in {}ms.", res.status(), started.elapsed().as_millis()),
                Err(error) => format!("{name} is not reachable: {}", error.without_url()),
            }
        }
        "cli_subprocess" => {
            let version = if endpoint.starts_with("wsl:") {
                let bin = endpoint.trim_start_matches("wsl:");
                run_capture("wsl.exe", &["-e", bin, "--version"], None, Duration::from_secs(12))
            } else if endpoint.is_empty() || !std::path::Path::new(endpoint).exists() {
                return format!("{name} binary is not installed.");
            } else {
                run_capture(endpoint, &["--version"], None, Duration::from_secs(8))
            };
            match version {
                Ok((code, out)) => {
                    let line: String = out.lines().next().unwrap_or("").chars().take(180).collect();
                    format!("{name} --version exited {code} in {}ms. {line}", started.elapsed().as_millis())
                }
                Err(e) => e.0,
            }
        }
        "byok_api" => {
            let trimmed = secret.trim();
            if trimmed.is_empty() {
                return format!("{name} endpoint is saved. Paste an API key to connect.");
            }
            let auth = crate::agent::ProviderAuth {
                id: id.to_string(),
                name: name.to_string(),
                kind: kind.to_string(),
                endpoint: endpoint.to_string(),
                secret: trimmed.to_string(),
            };
            let list = crate::agent::list_connected_models(vec![auth]);
            if !list.models.is_empty() {
                format!("{name} connected and verified in {}ms ({} models available).", started.elapsed().as_millis(), list.models.len())
            } else if let Some(note) = list.notes.first() {
                format!("{note}")
            } else {
                format!("{name} key is stored locally and active.")
            }
        }
        "official_oauth" => {
            if secret.trim().is_empty() {
                format!("{name}: Not signed in. Click Sign in to link your account.")
            } else {
                format!("{name} is signed in and connected.")
            }
        }
        _ => format!("{name} sign-in stays in a local window. No cookie was read. Ping {}ms.", started.elapsed().as_millis()),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryDraft {
    pub id: Option<String>,
    pub title: String,
    pub content_markdown: String,
    pub source_type: String,
    pub scoped_bot_id: Option<String>,
    pub file_path_or_uri: String,
    #[serde(default)]
    pub engine_id: Option<String>,
}

#[tauri::command]
pub async fn save_memory(state: State<'_, AppState>, draft: MemoryDraft) -> Result<CommandResult> {
    let saved = {
        let conn = guard(&state);
        crate::memory::remember(&conn, &crate::memory::MemoryInput {
            id: draft.id,
            title: draft.title,
            content_markdown: draft.content_markdown,
            source_type: draft.source_type,
            scoped_bot_id: draft.scoped_bot_id,
            file_path_or_uri: draft.file_path_or_uri,
            engine_id: draft.engine_id,
        })?
    };
    finish(&state, Some(saved.note))
}

#[tauri::command]
pub async fn delete_memory(state: State<'_, AppState>, id: String, engine_id: Option<String>) -> Result<CommandResult> {
    {
        let conn = guard(&state);
        crate::memory::forget(&conn, &id, engine_id.as_deref())?;
    }
    finish(&state, Some("Memory deleted.".into()))
}

#[tauri::command]
pub async fn scan_memory_engines(state: State<'_, AppState>) -> Result<CommandResult> {
    let note = {
        let conn = guard(&state);
        crate::memory::scan_engines(&conn)?
    };
    finish(&state, Some(note))
}

#[tauri::command]
pub async fn set_memory_route(state: State<'_, AppState>, scope: String, engine_id: String) -> Result<CommandResult> {
    let note = {
        let conn = guard(&state);
        ensure_memory_engine_entitled(&conn, &engine_id)?;
        crate::memory::set_route(&conn, &scope, &engine_id)?
    };
    finish(&state, Some(format!("Memory engine updated. {note}")))
}

// Freemium gate: the built-in Mem0 vault and the Obsidian vault are free
// forever; external graph/code engines (Zep, Cognee, Letta, …) are Pro. Dev
// builds are entitled, so this only bites on a verified Starter lease.
fn ensure_memory_engine_entitled(conn: &Connection, engine_id: &str) -> Result<()> {
    let free = matches!(engine_id, "mem0_builtin" | "openmemory_builtin" | "mem0_sdk" | "obsidian_khoj");
    if free || crate::licensing::pro_entitled(conn) {
        Ok(())
    } else {
        Err(err(format!("{engine_id} is a Pro memory engine. The built-in Mem0 vault and Obsidian sync are free forever — upgrade from Plan & setup to switch engines.")))
    }
}

#[tauri::command]
pub async fn mount_memory_companion(state: State<'_, AppState>, engine_id: String) -> Result<CommandResult> {
    {
        let conn = guard(&state);
        crate::memory::mount_companion(&conn, &engine_id)?;
    }
    finish(&state, Some("Obsidian is mounted as a companion. The workspace engine is unchanged.".into()))
}

#[tauri::command]
pub async fn unmount_memory_companion(state: State<'_, AppState>) -> Result<CommandResult> {
    {
        let conn = guard(&state);
        crate::memory::unmount_companion(&conn)?;
    }
    finish(&state, Some("Obsidian companion unmounted.".into()))
}

#[tauri::command]
pub async fn sync_memories_to_engine(state: State<'_, AppState>, target_engine_id: String) -> Result<CommandResult> {
    let note = {
        let conn = guard(&state);
        ensure_memory_engine_entitled(&conn, &target_engine_id)?;
        crate::memory::sync_to_engine(&conn, &target_engine_id)?
    };
    finish(&state, Some(note))
}

#[tauri::command]
pub async fn refresh_memory_vault(state: State<'_, AppState>, engine_id: String) -> Result<CommandResult> {
    let note = {
        let conn = guard(&state);
        ensure_memory_engine_entitled(&conn, &engine_id)?;
        crate::memory::refresh_vault(&conn, &engine_id)?
    };
    finish(&state, Some(note))
}

#[tauri::command]
pub async fn save_skill(state: State<'_, AppState>, draft: crate::capabilities::SkillDraft) -> Result<CommandResult> {
    {
        let conn = guard(&state);
        crate::capabilities::save_skill(&conn, &state.home, draft)?;
    }
    finish(&state, Some("Skill saved. The index updates on the next turn.".into()))
}

#[tauri::command]
pub async fn toggle_skill(state: State<'_, AppState>, id: String, profile_id: String, enabled: bool) -> Result<CommandResult> {
    {
        let conn = guard(&state);
        crate::capabilities::toggle_skill(&conn, &state.home, &id, &profile_id, enabled)?;
    }
    finish(&state, None)
}

#[tauri::command]
pub async fn remove_skill(state: State<'_, AppState>, id: String) -> Result<CommandResult> {
    {
        let conn = guard(&state);
        crate::capabilities::remove_skill(&conn, &state.home, &id)?;
    }
    finish(&state, Some("Skill removed.".into()))
}

#[tauri::command]
pub async fn load_skill(state: State<'_, AppState>, profile_id: String, slug: String) -> Result<CommandResult> {
    let note = {
        let conn = guard(&state);
        let body = crate::capabilities::load_skill_text(&conn, &state.home, &profile_id, &slug)?;
        format!("Loaded {slug} ({} characters).", body.chars().count())
    };
    finish(&state, Some(note))
}

#[tauri::command]
pub async fn propose_skill(state: State<'_, AppState>, profile_id: String, thread_id: String, slug: String, description: String, body: String) -> Result<CommandResult> {
    let note = {
        let conn = guard(&state);
        crate::capabilities::propose_skill(&conn, &profile_id, &thread_id, &slug, &description, &body)?
    };
    finish(&state, Some(note))
}

#[tauri::command]
pub async fn resolve_skill_proposal(state: State<'_, AppState>, id: String, approve: bool) -> Result<CommandResult> {
    let note = {
        let conn = guard(&state);
        crate::capabilities::resolve_proposal(&conn, &state.home, &id, approve)?
    };
    finish(&state, Some(note))
}

#[tauri::command]
pub async fn save_plugin(state: State<'_, AppState>, draft: crate::capabilities::PluginDraft) -> Result<CommandResult> {
    {
        let conn = guard(&state);
        crate::capabilities::save_plugin(&conn, &state.home, draft)?;
    }
    finish(&state, Some("Plugin manifest saved. Switches stay off until you enable them.".into()))
}

#[tauri::command]
pub async fn toggle_plugin_agent(state: State<'_, AppState>, id: String, profile_id: String, enabled: bool) -> Result<CommandResult> {
    {
        let conn = guard(&state);
        crate::capabilities::toggle_plugin_agent(&conn, &id, &profile_id, enabled)?;
    }
    finish(&state, None)
}

#[tauri::command]
pub async fn toggle_plugin_desktop(state: State<'_, AppState>, id: String, enabled: bool) -> Result<CommandResult> {
    {
        let conn = guard(&state);
        crate::capabilities::toggle_plugin_desktop(&conn, &id, enabled)?;
    }
    finish(&state, Some("Desktop switch updated.".into()))
}

#[tauri::command]
pub async fn trust_plugin(state: State<'_, AppState>, id: String) -> Result<CommandResult> {
    {
        let conn = guard(&state);
        crate::capabilities::trust_plugin(&conn, &id)?;
    }
    finish(&state, Some("Plugin trusted. Enable the agent or desktop switch separately.".into()))
}

#[tauri::command]
pub async fn remove_plugin(state: State<'_, AppState>, id: String) -> Result<CommandResult> {
    let note = {
        let conn = guard(&state);
        crate::capabilities::remove_plugin(&conn, &state.home, &id)?
    };
    finish(&state, Some(note))
}

#[tauri::command]
pub async fn save_mcp(state: State<'_, AppState>, draft: crate::capabilities::McpDraft) -> Result<CommandResult> {
    let secret = draft.secret.trim().to_string();
    let secret_id = crate::capabilities::mcp_id(&draft);
    {
        let conn = guard(&state);
        crate::capabilities::save_mcp(&conn, &state.home, draft)?;
        if !secret.is_empty() {
            let key_guard = state.vault_key.lock().unwrap_or_else(|e| e.into_inner());
            let mut secrets = state.secrets.lock().unwrap_or_else(|e| e.into_inner());
            secrets.insert(format!("mcp:{secret_id}"), secret.clone());
            crate::vault::persist(&state.home, &conn, key_guard.as_ref(), &secrets)?;
        }
    }
    let note = if secret.is_empty() {
        "MCP server saved. It is not connected until a credential check succeeds. Profile switches default to Active."
    } else {
        "MCP server saved. The key stays in the vault. Profile switches default to Active. Turn one off on Capabilities if you want."
    };
    finish(&state, Some(note.into()))
}

#[tauri::command]
pub async fn toggle_mcp(state: State<'_, AppState>, id: String, profile_id: String, enabled: bool) -> Result<CommandResult> {
    {
        let conn = guard(&state);
        crate::capabilities::toggle_mcp(&conn, &id, &profile_id, enabled)?;
    }
    finish(&state, None)
}

#[tauri::command]
pub async fn trust_mcp(state: State<'_, AppState>, id: String) -> Result<CommandResult> {
    {
        let conn = guard(&state);
        crate::capabilities::trust_mcp(&conn, &id)?;
    }
    finish(&state, Some("MCP server trusted. Profile switches default to Active. Turn one off on Capabilities if you want.".into()))
}

#[tauri::command]
pub async fn remove_mcp(state: State<'_, AppState>, id: String) -> Result<CommandResult> {
    {
        let conn = guard(&state);
        crate::capabilities::remove_mcp(&conn, &state.home, &id)?;
    }
    finish(&state, Some("MCP server removed.".into()))
}

#[tauri::command]
pub async fn scan_project_plugins(state: State<'_, AppState>) -> Result<CommandResult> {
    let note = {
        let conn = guard(&state);
        let settings = db::settings_of(&conn)?;
        crate::capabilities::reconcile(&conn, &state.home, &settings.project_root)?;
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM plugins WHERE source = 'project'", [], |row| row.get(0))?;
        format!("{count} project plugin folder(s) visible.")
    };
    finish(&state, Some(note))
}

#[tauri::command]
pub async fn install_market(state: State<'_, AppState>, slug: String) -> Result<CommandResult> {
    let note = {
        let conn = guard(&state);
        let item = catalog().into_iter().find(|item| item.slug == slug).ok_or_else(|| err("unknown marketplace item"))?;
        let profile = db::kv_get(&conn, "active_profile")?.unwrap_or_default();
        crate::capabilities::install_catalog(&conn, &state.home, &profile, &item.slug, &item.title, &item.blurb)?
    };
    finish(&state, Some(note))
}

#[tauri::command]
pub async fn install_skill_from_url(state: State<'_, AppState>, url: String, slug: Option<String>) -> Result<CommandResult> {
    let note = {
        let conn = guard(&state);
        let profile = db::kv_get(&conn, "active_profile")?.unwrap_or_default();
        crate::capabilities::install_skill_from_source(&conn, &state.home, &profile, &url, slug.as_deref())?
    };
    finish(&state, Some(note))
}

#[tauri::command]
pub async fn install_plugin_from_url(state: State<'_, AppState>, url: String, slug: Option<String>) -> Result<CommandResult> {
    let note = {
        let conn = guard(&state);
        let profile = db::kv_get(&conn, "active_profile")?.unwrap_or_default();
        crate::capabilities::install_plugin_from_source(&conn, &state.home, &profile, &url, slug.as_deref())?
    };
    finish(&state, Some(note))
}

#[tauri::command]
pub async fn connect_mcp_server(
    state: State<'_, AppState>,
    name: String,
    transport: Option<String>,
    command: Option<String>,
    args: Option<Vec<String>>,
    url: Option<String>,
    secret: Option<String>,
) -> Result<CommandResult> {
    let secret_value = secret.unwrap_or_default();
    let note = {
        let conn = guard(&state);
        let profile = db::kv_get(&conn, "active_profile")?.unwrap_or_default();
        let args_vec = args.unwrap_or_default();
        let message = crate::capabilities::connect_mcp_server(
            &conn,
            &state.home,
            &profile,
            &name,
            transport.as_deref(),
            command.as_deref(),
            &args_vec,
            url.as_deref(),
            Some(secret_value.as_str()),
        )?;
        if !secret_value.trim().is_empty() {
            let server_id = crate::capabilities::server_id_for_name(&name);
            let key_guard = state.vault_key.lock().unwrap_or_else(|error| error.into_inner());
            let mut secrets = state.secrets.lock().unwrap_or_else(|error| error.into_inner());
            secrets.insert(format!("mcp:{server_id}"), secret_value.trim().to_string());
            crate::vault::persist(&state.home, &conn, key_guard.as_ref(), &secrets)?;
        }
        message
    };
    finish(&state, Some(note))
}

#[tauri::command]
pub async fn set_policy(state: State<'_, AppState>, max_per_tx_usd: f64, daily_cap_usd: f64, require_human_approval_above_usd: f64, max_slippage_bps: i64, killswitch_engaged: bool) -> Result<CommandResult> {
    {
        let conn = guard(&state);
        crate::wallet::set_policy(&conn, max_per_tx_usd, daily_cap_usd, require_human_approval_above_usd, max_slippage_bps, killswitch_engaged)?;
    }
    finish(&state, Some(if killswitch_engaged { "Kill switch is on. Agent spends and trades are blocked.".into() } else { "Policy saved.".into() }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WalletRequest {
    pub bot_profile_id: String,
    pub rail: String,
    pub amount_usd: f64,
    pub native_amount: String,
    pub counterparty: String,
    pub purpose: String,
    pub actor: String,
    pub kind: String,
    pub effect: String,
    pub slippage_bps: Option<i64>,
}

#[tauri::command]
pub async fn wallet_tx(state: State<'_, AppState>, request: WalletRequest) -> Result<CommandResult> {
    let toast = {
        let conn = guard(&state);
        let actor = if request.actor.trim().is_empty() { "user" } else { request.actor.trim() };
        crate::wallet::settle(&conn, &request.bot_profile_id, &request.rail, request.amount_usd, &request.native_amount, &request.counterparty, &request.purpose, actor, &request.kind, request.slippage_bps, &request.effect)?
    };
    finish(&state, Some(toast))
}

#[tauri::command]
pub async fn review_tx(state: State<'_, AppState>, tx_id: String, approve: bool) -> Result<CommandResult> {
    let toast = {
        let conn = guard(&state);
        crate::wallet::review(&conn, &tx_id, approve)?
    };
    finish(&state, Some(toast))
}

#[tauri::command]
pub async fn add_sandbox_funds(state: State<'_, AppState>) -> Result<CommandResult> {
    let _ = &state;
    Err(err("Sandbox faucet is disabled. Connect a wallet and refresh its on-chain balance."))
}

#[tauri::command]
pub async fn probe_local_tool(state: State<'_, AppState>, kind: String, path: Option<String>) -> Result<CommandResult> {
    let note = tauri::async_runtime::spawn_blocking(move || probe_local_blocking(&kind, path.as_deref()))
        .await
        .map_err(|error| err(error.to_string()))??;
    finish(&state, Some(note))
}

fn probe_local_blocking(kind: &str, path: Option<&str>) -> Result<String> {
    match kind {
        "docker" => {
            let output = std::process::Command::new("docker")
                .args(["version", "--format", "{{.Server.Version}}"])
                .output()
                .map_err(|_| err("Docker is not on PATH. It was not marked connected."))?;
            if !output.status.success() {
                return Err(err("Docker did not answer `docker version`. It was not marked connected."));
            }
            let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if version.is_empty() {
                return Err(err("Docker did not report a version. It was not marked connected."));
            }
            Ok(format!("Docker {version}"))
        }
        "path" => {
            let folder = std::path::Path::new(path.unwrap_or("").trim());
            if folder.as_os_str().is_empty() || !folder.is_dir() {
                return Err(err("That folder does not exist. It was not mounted."));
            }
            Ok(format!("Folder {}", folder.display()))
        }
        _ => Err(err("Unknown local check.")),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectWalletRequest {
    chain: String,
    #[serde(default)]
    label: String,
    address: String,
    #[serde(default)]
    connection_type: String,
    #[serde(default)]
    secret: String,
    #[serde(default)]
    daily_limit_usd: f64,
}

#[tauri::command]
pub async fn connect_watched_wallet(state: State<'_, AppState>, request: ConnectWalletRequest) -> Result<CommandResult> {
    crate::wallet_live::validate_address(&request.chain, &request.address)?;
    let chain = request.chain.clone();
    let address = request.address.trim().to_string();
    let secret = request.secret.clone();
    let connection = if request.connection_type.trim().is_empty() { "address_watch".to_string() } else { request.connection_type.clone() };
    let connection_for_fetch = connection.clone();
    let proof = tauri::async_runtime::spawn_blocking(move || crate::wallet_live::fetch_balance(&chain, &address, &secret, &connection_for_fetch))
        .await
        .map_err(|error| err(error.to_string()))??;
    let id = nid("wallet");
    let native = proof.balance_native.clone();
    let detail = proof.detail.clone();
    {
        let conn = guard(&state);
        let mask = mask_secret(&request.secret);
        crate::wallet_live::insert_wallet(&conn, &id, &request.chain, &request.label, request.address.trim(), &connection, request.daily_limit_usd, &mask, &proof)?;
        if !request.secret.trim().is_empty() {
            let key_guard = state.vault_key.lock().unwrap_or_else(|error| error.into_inner());
            let mut secrets = state.secrets.lock().unwrap_or_else(|error| error.into_inner());
            secrets.insert(format!("wallet:{id}"), request.secret.trim().to_string());
            crate::vault::persist(&state.home, &conn, key_guard.as_ref(), &secrets)?;
        }
    }
    finish(&state, Some(format!("Read {native}. {detail} No deposit was credited.")))
}

#[tauri::command]
pub async fn refresh_wallet_balance(state: State<'_, AppState>, id: String) -> Result<CommandResult> {
    let (chain, address, connection_type, status) = {
        let conn = guard(&state);
        crate::wallet_live::load_row(&conn, &id)?
    };
    if status == "frozen" {
        return Err(err("This wallet is frozen. Unfreeze it before refreshing."));
    }
    let secret = {
        let secrets = state.secrets.lock().unwrap_or_else(|error| error.into_inner());
        secrets.get(&format!("wallet:{id}")).cloned().unwrap_or_default()
    };
    let proof = tauri::async_runtime::spawn_blocking(move || crate::wallet_live::fetch_balance(&chain, &address, &secret, &connection_type))
        .await
        .map_err(|error| err(error.to_string()))??;
    let native = proof.balance_native.clone();
    {
        let conn = guard(&state);
        crate::wallet_live::update_balance(&conn, &id, &proof)?;
    }
    finish(&state, Some(format!("Refreshed {native}. The typed deposit form is not used.")))
}

#[tauri::command]
pub async fn disconnect_watched_wallet(state: State<'_, AppState>, id: String) -> Result<CommandResult> {
    {
        let conn = guard(&state);
        crate::wallet_live::delete_wallet(&conn, &id)?;
        let key_guard = state.vault_key.lock().unwrap_or_else(|error| error.into_inner());
        let mut secrets = state.secrets.lock().unwrap_or_else(|error| error.into_inner());
        secrets.remove(&format!("wallet:{id}"));
        crate::vault::persist(&state.home, &conn, key_guard.as_ref(), &secrets)?;
    }
    finish(&state, Some("Wallet removed. Its key was dropped from the vault.".into()))
}

#[tauri::command]
pub async fn update_watched_wallet(state: State<'_, AppState>, id: String, status: String, make_default: bool) -> Result<CommandResult> {
    {
        let conn = guard(&state);
        if !status.trim().is_empty() {
            crate::wallet_live::set_status(&conn, &id, status.trim())?;
        }
        if make_default {
            crate::wallet_live::set_default(&conn, &id)?;
        }
    }
    finish(&state, Some("Wallet updated.".into()))
}

#[tauri::command]
pub async fn assign_bot_spend(state: State<'_, AppState>, bot_id: String, limit_usd: f64) -> Result<CommandResult> {
    let note = {
        let conn = guard(&state);
        crate::wallet_live::assign_bot_spend(&conn, &bot_id, limit_usd)?
    };
    finish(&state, Some(note))
}

#[tauri::command]
pub async fn set_wallet_pin(state: State<'_, AppState>, pin: String, current: Option<String>) -> Result<CommandResult> {
    let note = {
        let conn = guard(&state);
        crate::wallet_live::set_pin(&conn, pin.trim(), current.unwrap_or_default().trim())?
    };
    finish(&state, Some(note))
}

#[tauri::command]
pub async fn check_wallet_pin(state: State<'_, AppState>, pin: String) -> Result<CommandResult> {
    {
        let conn = guard(&state);
        crate::wallet_live::check_pin(&conn, pin.trim())?;
    }
    finish(&state, Some("PIN accepted.".into()))
}

fn mask_secret(secret: &str) -> String {
    let secret = secret.trim();
    if secret.len() <= 8 || secret.contains('\n') {
        return if secret.is_empty() { String::new() } else { "stored".into() };
    }
    format!("{}...{}", &secret[..4], &secret[secret.len() - 4..])
}

#[tauri::command]
pub async fn set_ledger_mode(state: State<'_, AppState>, mode: String) -> Result<CommandResult> {
    let toast = {
        let conn = guard(&state);
        crate::wallet_engine::set_ledger_mode(&conn, &mode)?
    };
    finish(&state, Some(toast))
}

#[tauri::command]
pub async fn bot_circuit_toggle(state: State<'_, AppState>, bot_id: String) -> Result<CommandResult> {
    let toast = {
        let conn = guard(&state);
        let (_, note) = crate::wallet_engine::toggle_circuit(&conn, &bot_id)?;
        note
    };
    finish(&state, Some(toast))
}

#[tauri::command]
pub async fn quant_dispatch(state: State<'_, AppState>, pair: String, side: String, size_usd: f64, analyst: String, thesis: String) -> Result<CommandResult> {
    let toast = {
        let conn = guard(&state);
        let bot_id = db::kv_get(&conn, "active_profile")?.unwrap_or_default();
        let order = crate::wallet_engine::dispatch_quant_order(&conn, &bot_id, &pair, &analyst, &thesis, &side, size_usd)?;
        match order.status.as_str() {
            "WORKING" => format!(
                "⏸ {} order for {} held in the fail-closed approval queue — it exceeds the policy cap. Review it on the wallet screen.",
                order.side, order.pair
            ),
            "REJECTED" => format!("✕ {} order rejected by the policy gate (cap, drawdown, or frozen bot). {}", order.side, order.reference),
            _ => format!(
                "⚡ Routed {} ${:.2} on {} over the Rust WebSocket in {:.1}ms · builder rebate ${:.4} (5 bps) · {}",
                order.side, order.size_usd, order.pair, order.ws_latency_ms, order.rebate_usd, order.status
            ),
        }
    };
    finish(&state, Some(toast))
}

#[tauri::command]
pub async fn self_heal_drill(state: State<'_, AppState>, tier: i64) -> Result<CommandResult> {
    let toast = {
        let conn = guard(&state);
        crate::remediation_core::run_drill(&conn, &state.home, tier)?
    };
    finish(&state, Some(toast))
}

#[tauri::command]
pub async fn sentinel_scan(state: State<'_, AppState>, sentinel_id: String) -> Result<CommandResult> {
    let toast = {
        let conn = guard(&state);
        crate::remediation_core::sentinel_scan(&conn, &state.home, &sentinel_id)?
    };
    finish(&state, Some(toast))
}

#[tauri::command]
pub async fn sentinel_scan_all(state: State<'_, AppState>) -> Result<CommandResult> {
    let toast = {
        let conn = guard(&state);
        crate::remediation_core::sentinel_scan_all(&conn, &state.home)?
    };
    finish(&state, Some(toast))
}

#[tauri::command]
pub async fn acknowledge_sentinel(state: State<'_, AppState>, sentinel_id: String) -> Result<CommandResult> {
    let toast = {
        let conn = guard(&state);
        crate::remediation_core::sentinel_acknowledge(&conn, &sentinel_id)?
    };
    finish(&state, Some(toast))
}

#[tauri::command]
pub async fn reset_sentinel_ack(state: State<'_, AppState>, sentinel_id: String) -> Result<CommandResult> {
    let toast = {
        let conn = guard(&state);
        crate::remediation_core::sentinel_reset(&conn, &sentinel_id)?
    };
    finish(&state, Some(toast))
}

#[tauri::command]
pub async fn list_shadow_backups(state: State<'_, AppState>) -> Result<CommandResult> {
    let _ = crate::remediation_core::shadow_backups(&state.home);
    finish(&state, None)
}

#[tauri::command]
pub async fn restore_shadow_backup(state: State<'_, AppState>, backup_name: String) -> Result<CommandResult> {
    let toast = crate::remediation_core::restore_shadow_backup(&state.home, &backup_name)?;
    finish(&state, Some(toast))
}

#[tauri::command]
pub async fn snapshot_poll(state: State<'_, AppState>) -> Result<CommandResult> {
    finish(&state, None)
}

#[tauri::command]
pub async fn save_exported_file(
    filename: String,
    base64_data: String,
    open_after: Option<bool>,
) -> Result<String> {
    use base64::Engine;
    let clean_b64 = if let Some(idx) = base64_data.find(',') {
        &base64_data[idx + 1..]
    } else {
        &base64_data
    };
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(clean_b64.trim())
        .map_err(|e| err(format!("Invalid base64 payload: {e}")))?;

    let dl_dir = std::env::var("USERPROFILE")
        .map(|p| std::path::PathBuf::from(p).join("Downloads"))
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    let _ = std::fs::create_dir_all(&dl_dir);

    let safe_name = filename
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' })
        .collect::<String>();
    let target = dl_dir.join(&safe_name);

    std::fs::write(&target, &bytes).map_err(|e| err(format!("Failed to save file: {e}")))?;
    let target_str = target.to_string_lossy().to_string();

    if open_after.unwrap_or(false) {
        #[cfg(windows)]
        {
            let escaped = target_str.replace('\'', "''");
            let mut cmd = std::process::Command::new("powershell.exe");
            cmd.args(["-NoProfile", "-Command", &format!("Start-Process -FilePath '{}'", escaped)]);
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
            let _ = cmd.spawn();
        }
    }

    Ok(target_str)
}

#[tauri::command]
pub async fn sentinel_remediate(state: State<'_, AppState>, sentinel_id: String) -> Result<CommandResult> {
    let toast = {
        let conn = guard(&state);
        crate::remediation_core::sentinel_remediate(&conn, &state.home, &sentinel_id)?
    };
    finish(&state, Some(toast))
}

#[tauri::command]
pub async fn refresh_workspace(state: State<'_, AppState>) -> Result<CommandResult> {
    crate::agent::release_turn();
    let _ = crate::siwc::refresh_chatgpt(&state);
    let toast = {
        let conn = guard(&state);
        let msg = crate::repair::refresh(&conn)?;
        let _ = crate::memory::refresh_active_vault(&conn);
        crate::util::ipc_push(&state.ipc, "refresh/wal_checkpoint");
        msg
    };
    finish(&state, Some(toast))
}

#[tauri::command]
pub async fn run_repair(state: State<'_, AppState>) -> Result<CommandResult> {
    let toast = {
        let conn = guard(&state);
        crate::repair::doctor(&conn, &state.home)?
    };
    finish(&state, Some(toast))
}

#[tauri::command]
pub async fn preview_bug(state: State<'_, AppState>, category: String, notes: String) -> Result<CommandResult> {
    {
        let conn = guard(&state);
        let text = crate::repair::preview_report(&conn, &category, &notes)?;
        kv_set(&conn, "bug_preview", &text)?;
    }
    finish(&state, None)
}

#[tauri::command]
pub async fn submit_bug(state: State<'_, AppState>, category: String, notes: String) -> Result<CommandResult> {
    let (id, body, triage) = {
        let conn = guard(&state);
        let body = crate::repair::preview_report(&conn, &category, &notes)?;
        let id = nid("ticket");
        let triage = db::settings_of(&conn)?.triage_url;
        (id, body, triage)
    };
    let dir = state.home.join("tickets");
    std::fs::create_dir_all(&dir)?;
    std::fs::write(dir.join(format!("{id}.json")), &body)?;
    let remote = if triage.starts_with("https://") {
        let triage_url = triage.clone();
        let ticket_id = id.clone();
        let ticket_body = body.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let client = match reqwest::blocking::Client::builder()
                .connect_timeout(Duration::from_secs(5))
                .timeout(Duration::from_secs(8))
                .build()
            {
                Ok(client) => client,
                Err(error) => return format!("Saved locally. Creator endpoint failed: {}", error.without_url()),
            };
            match client.post(&triage_url).json(&json!({"id": ticket_id, "body": ticket_body})).send() {
                Ok(res) => format!("Creator endpoint returned HTTP {}.", res.status()),
                Err(error) => format!("Saved locally. Creator endpoint failed: {}", error.without_url()),
            }
        })
        .await
        .unwrap_or_else(|error| format!("Saved locally. Creator endpoint failed: {error}"))
    } else {
        "Saved on this machine. No creator endpoint is configured.".into()
    };
    {
        let conn = guard(&state);
        db::log_repair(&conn, 4, "bug_report", "creator", &format!("{id} stored"), 1, "recorded")?;
    }
    finish(&state, Some(format!("{id}. {remote}")))
}

#[tauri::command]
pub async fn save_settings(state: State<'_, AppState>, settings: Settings) -> Result<CommandResult> {
    {
        let conn = guard(&state);
        db::save_settings(&conn, &settings)?;
    }
    finish(&state, Some("Settings saved.".into()))
}

#[tauri::command]
pub async fn set_vault_passphrase(state: State<'_, AppState>, password: String) -> Result<CommandResult> {
    {
        let conn = guard(&state);
        if db::kv_get(&conn, "vault_verifier")?.is_some() {
            return Err(err("a passphrase is already set"));
        }
        let secrets = state.secrets.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let key = crate::vault::set_passphrase(&conn, &state.home, &password, &secrets)?;
        *state.vault_key.lock().unwrap_or_else(|e| e.into_inner()) = Some(key);
        state.unlocked.store(true, Ordering::Relaxed);
    }
    finish(&state, Some("Vault passphrase set with Argon2id; keys are sealed with AES-256-GCM. The passphrase is not stored.".into()))
}

#[tauri::command]
pub async fn unlock_vault(state: State<'_, AppState>, password: String) -> Result<CommandResult> {
    let (bytes, map) = {
        let conn = guard(&state);
        crate::vault::unlock(&conn, &state.home, &password)?
    };
    if bytes.len() != 32 {
        return Err(err("bad vault key"));
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(&bytes);
    *state.vault_key.lock().unwrap_or_else(|e| e.into_inner()) = Some(key);
    *state.secrets.lock().unwrap_or_else(|e| e.into_inner()) = map;
    state.unlocked.store(true, Ordering::Relaxed);
    finish(&state, Some("Vault unlocked for this session.".into()))
}

#[tauri::command]
pub async fn lock_vault(state: State<'_, AppState>) -> Result<CommandResult> {
    state.unlocked.store(false, Ordering::Relaxed);
    state.secrets.lock().unwrap_or_else(|e| e.into_inner()).clear();
    *state.vault_key.lock().unwrap_or_else(|e| e.into_inner()) = None;
    finish(&state, Some("Vault locked.".into()))
}

#[tauri::command]
pub async fn save_extension(state: State<'_, AppState>, id: String, code: String) -> Result<CommandResult> {
    {
        let conn = guard(&state);
        let path: String = conn.query_row("SELECT path FROM extensions WHERE id=?1", params![id], |r| r.get(0)).map_err(|_| err("extension not found"))?;
        let rel = path.trim();
        if rel.is_empty() || std::path::Path::new(rel).is_absolute() || rel.contains("..") {
            return Err(err("extension path is not inside the workspace"));
        }
        let full = state.home.join(rel);
        if !full.starts_with(&state.home) {
            return Err(err("extension path is not inside the workspace"));
        }
        if let Some(parent) = full.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let shadow = state.home.join(".shadow-git");
        std::fs::create_dir_all(&shadow)?;
        if full.exists() {
            let _ = std::fs::copy(&full, shadow.join(format!("{id}.{}.bak", now_ms())));
        }
        std::fs::write(&full, &code)?;
        conn.execute("UPDATE extensions SET code=?1 WHERE id=?2", params![code, id])?;
    }
    finish(&state, Some("Extension written under ~/.ronicos.".into()))
}

#[tauri::command]
pub async fn toggle_extension(state: State<'_, AppState>, id: String, enabled: bool) -> Result<CommandResult> {
    {
        let conn = guard(&state);
        conn.execute("UPDATE extensions SET enabled=?1 WHERE id=?2", params![enabled as i64, id])?;
    }
    finish(&state, None)
}

#[tauri::command]
pub async fn generate_extension(state: State<'_, AppState>, prompt: String) -> Result<CommandResult> {
    {
        let conn = guard(&state);
        let id = nid("ext");
        let code = format!("// Generated locally from your prompt. It does not run as privileged code.\n// {prompt}\nexport const note = {};\n", serde_json::to_string(&prompt)?);
        let rel = format!("extensions/{id}.js");
        let full = state.home.join(&rel);
        std::fs::create_dir_all(state.home.join("extensions"))?;
        std::fs::write(&full, &code)?;
        conn.execute("INSERT INTO extensions (id, name, path, enabled, code) VALUES (?1,?2,?3,0,?4)", params![id, "Custom patch", rel, code])?;
    }
    finish(&state, Some("Patch saved as a local extension file.".into()))
}

fn open_external_window(app: &AppHandle, provider_id: &str, url: &str) -> Result<String> {
    let safe_url = crate::util::normalize_harness_url(url);
    let parsed = crate::util::https_or_loopback(&safe_url)?;
    let safe: String = provider_id.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '_' }).take(48).collect();
    let window_label = format!("harness_{safe}");
    if let Some(existing) = app.get_webview_window(&window_label) {
        // Reuse the live window. close() is asynchronous in Tauri 2, so
        // closing and immediately rebuilding under the same label can fail
        // with "label already exists". Navigating keeps the sign-in session
        // on the profile directory this window already owns.
        existing.navigate(parsed).map_err(|e| err(e.to_string()))?;
        let _ = existing.set_focus();
        if let Some(view) = app.get_webview(existing.label()) {
            crate::site_window::prepare_sign_in(&view, false);
        }
        return Ok(format!("Opened a native window at {safe_url}."));
    }
    let dir = crate::site_window::ensure_profile(&crate::util::product_home(), &window_label)?;
    // A second WebView2 with its own user agent stays blank unless the profile directory is unique.
    // Sign-in popups are created on this same profile so the session cookie lands here.
    let handle = app.clone();
    let owner_label = window_label.clone();
    let window = crate::site_window::site_window(
        WebviewWindowBuilder::new(app, &window_label, WebviewUrl::External(parsed))
            .title(format!("Ronic OS — {provider_id}"))
            .inner_size(1140.0, 800.0)
            .visible(true)
            .focused(true),
        dir,
        handle,
        owner_label,
    )
    .build()
    .map_err(|e| err(e.to_string()))?;
    if let Some(view) = app.get_webview(window.label()) {
        crate::site_window::prepare_sign_in(&view, false);
    }
    Ok(format!("Opened a native window at {safe_url}."))
}

#[tauri::command]
pub async fn open_provider_window(app: AppHandle, state: State<'_, AppState>, label: String, url: String) -> Result<CommandResult> {
    let safe_url = crate::util::normalize_harness_url(&url);
    let note = open_external_window(&app, &label, &safe_url)?;
    {
        let conn = guard(&state);
        let kind: String = conn
            .query_row("SELECT provider_type FROM provider_accounts WHERE id = ?1", params![label], |row| row.get(0))
            .unwrap_or_default();
        if kind == "isolated_webview" || kind == "official_oauth" {
            conn.execute(
                "UPDATE provider_accounts SET binary_or_endpoint = ?1, health_detail = 'Window opened. Sign in on that site. Chat inside Ronic OS still needs the API key.' WHERE id = ?2",
                params![safe_url, label],
            )?;
        }
    }
    crate::util::ipc_push(&state.ipc, &format!("opened provider window harness_{label}"));
    finish(&state, Some(note))
}

#[tauri::command]
pub async fn pick_paths(kind: Option<String>) -> Result<Vec<String>> {
    #[cfg(windows)]
    {
        let is_folder = kind.as_deref() == Some("folder") || kind.as_deref() == Some("directory");
        let script = if is_folder {
            "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = 'Select Folder'; if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath }".to_string()
        } else {
            let program = kind.as_deref() == Some("program");
            let filter = if program {
                "Programs (*.exe;*.cmd;*.bat)|*.exe;*.cmd;*.bat|All files (*.*)|*.*"
            } else {
                "All files (*.*)|*.*"
            };
            let multi = if program { "" } else { "$d.Multiselect = $true;" };
            format!(
                "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.OpenFileDialog; {multi} $d.Filter = '{filter}'; $d.Title = 'Ronic OS'; if ($d.ShowDialog() -eq 'OK') {{ $d.FileNames -join [char]10 }}"
            )
        };
        let mut cmd = std::process::Command::new("powershell.exe");
        cmd.args(["-NoProfile", "-STA", "-Command", &script]);
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
        let out = cmd.output().map_err(|e| err(e.to_string()))?;
        let text = String::from_utf8_lossy(&out.stdout);
        let paths = text.lines().map(str::trim).filter(|line| !line.is_empty() && std::path::Path::new(line).exists()).map(|line| line.to_string()).collect();
        Ok(paths)
    }
    #[cfg(not(windows))]
    {
        let _ = kind;
        Err(err("the file picker runs in the Windows desktop shell"))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectBot {
    pub handle: String,
    pub display_name: String,
    pub engine: String,
    pub mode: String,
    pub command_or_url: String,
    #[serde(default)]
    pub api_base: String,
    #[serde(default)]
    pub api_model: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub provider_ref: String,
}

#[tauri::command]
pub async fn connect_external_bot(state: State<'_, AppState>, draft: ConnectBot) -> Result<CommandResult> {
    let handle = {
        let trimmed = draft.handle.trim().trim_start_matches('@');
        if trimmed.is_empty() || !trimmed.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
            return Err(err("use a handle made of letters, numbers, dash, or underscore"));
        }
        format!("@{trimmed}")
    };
    let name = {
        let trimmed = draft.display_name.trim();
        if trimmed.is_empty() { handle.trim_start_matches('@').to_string() } else { trimmed.to_string() }
    };
    let mut engine_kind = "";
    let mut api_base = String::new();
    let mut api_model = String::new();
    let mut provider_ref = draft.provider_ref.trim().to_string();
    let (engine, command, detail) = match draft.mode.as_str() {
        "api" => {
            let base = draft.api_base.trim().trim_end_matches('/').to_string();
            crate::util::https_or_loopback(&base).map_err(|_| err("the API base must be https, or http on localhost"))?;
            let model = draft.api_model.trim().to_string();
            if model.is_empty() {
                return Err(err("add the model id this bot speaks, for example grok-4"));
            }
            if model.contains(char::is_whitespace) {
                return Err(err("the model id must not contain spaces — use the id shown in the provider's model list"));
            }
            api_base = base.clone();
            api_model = model;
            engine_kind = "openai_api";
            if provider_ref.is_empty() {
                let slug = handle.trim_start_matches('@').to_ascii_lowercase();
                provider_ref = format!("botprov_{slug}");
            }
            let engine = if draft.engine.trim().is_empty() {
                url::Url::parse(&base).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_else(|| "Cloud API".into())
            } else {
                draft.engine.trim().to_string()
            };
            let engine_copy = engine.clone();
            (engine, base, format!("connected to {engine_copy} at {api_base} as {api_model}"))
        }
        "subscription" => {
            // The ORIGINAL bot: the service's own product, used with the user's
            // subscription login. The provider row holds the official site; chat
            // in Ronic OS uses the plan/CLI login where the service allows it.
            let site = draft.api_base.trim().trim_end_matches('/').to_string();
            crate::util::https_or_loopback(&site).map_err(|_| err("the original bot's site must be an https URL"))?;
            api_base = site.clone();
            api_model = draft.api_model.trim().to_string();
            engine_kind = "subscription";
            let engine = if draft.engine.trim().is_empty() {
                url::Url::parse(&site).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_else(|| "Original bot".into())
            } else {
                draft.engine.trim().to_string()
            };
            let detail = format!("bound to the original {engine} at {site}");
            (engine, site, detail)
        }
        "github" => {
            let (clone_url, repo) = github_clone_target(&draft.command_or_url)?;
            let dest = state.home.join("bots").join(&repo);
            if !dest.exists() {
                std::fs::create_dir_all(state.home.join("bots"))?;
                let (code, output) = run_capture("git", &["clone", "--depth", "1", &clone_url, &dest.display().to_string()], None, Duration::from_secs(120))?;
                if code != 0 {
                    return Err(err(format!("git clone failed: {}", output.lines().last().unwrap_or("no output"))));
                }
            }
            ("GitHub clone".to_string(), dest.display().to_string(), format!("Linked {clone_url}"))
        }
        "http" => {
            let url = draft.command_or_url.trim();
            crate::util::https_or_loopback(url).map_err(|_| err("webhook URLs must be https, or localhost http/ws"))?;
            let engine = if url.starts_with("ws") { "WebSocket" } else { "HTTP webhook" };
            (engine.to_string(), url.to_string(), format!("Linked {url}"))
        }
        _ => {
            let command = draft.command_or_url.trim();
            if command.is_empty() {
                return Err(err("add a command, folder, or file"));
            }
            if command.chars().any(|c| matches!(c, '&' | '|' | ';' | '<' | '>' | '`' | '$' | '\n' | '\r')) {
                return Err(err("pipes, redirects, and command chaining are blocked"));
            }
            let engine = if draft.engine.trim().is_empty() { "Local command".to_string() } else { draft.engine.trim().to_string() };
            (engine, command.to_string(), "Command saved on this machine.".to_string())
        }
    };
    let toast = {
        let conn = guard(&state);
        let existing: Option<String> = conn.query_row("SELECT id FROM bot_profiles WHERE handle = ?1", params![handle], |row| row.get(0)).ok();
        let soul = format!("External bot {handle}. {detail}");
        // A cloud bot gets a dedicated engine account whose endpoint and key the
        // chat turn calls directly, so the reply really comes from that service.
        // An original bot gets a webview provider for its official site instead.
        let mut needs_key = false;
        if engine_kind == "openai_api" {
            let has_new_key = !draft.api_key.trim().is_empty();
            let had_secret: i64 = conn.query_row("SELECT has_secret FROM provider_accounts WHERE id = ?1", params![provider_ref], |r| r.get(0)).unwrap_or(0);
            needs_key = had_secret == 0 && !has_new_key;
            let health = if needs_key { format!("Bound to {handle}. Needs an API key before it can chat.") } else { format!("Bound to {handle}.") };
            conn.execute(
                "INSERT INTO provider_accounts (id, name, provider_type, binary_or_endpoint, has_secret, is_active, allow_cli_dispatch, health_detail, created_at)
                 VALUES (?1, ?2, 'byok_api', ?3, ?4, 1, 0, ?5, ?6)
                 ON CONFLICT(id) DO UPDATE SET name = ?2, binary_or_endpoint = ?3, health_detail = ?5, is_active = 1,
                   has_secret = CASE WHEN ?4 = 1 THEN 1 ELSE provider_accounts.has_secret END",
                params![provider_ref, &engine, &api_base, has_new_key as i64, &health, now_ms()],
            )?;
            if has_new_key {
                let key = draft.api_key.trim().to_string();
                let key_guard = state.vault_key.lock().unwrap_or_else(|e| e.into_inner());
                let mut secrets = state.secrets.lock().unwrap_or_else(|e| e.into_inner());
                secrets.insert(provider_ref.clone(), key);
                crate::vault::persist(&state.home, &conn, key_guard.as_ref(), &secrets)?;
            }
        }
        if engine_kind == "subscription" && provider_ref.is_empty() {
            let slug = handle.trim_start_matches('@').to_ascii_lowercase();
            provider_ref = format!("botsite_{slug}");
        }
        if engine_kind == "subscription" {
            let exists: i64 = conn.query_row("SELECT COUNT(*) FROM provider_accounts WHERE id = ?1", params![provider_ref], |r| r.get(0)).unwrap_or(0);
            if exists == 0 {
                conn.execute(
                    "INSERT INTO provider_accounts (id, name, provider_type, binary_or_endpoint, has_secret, is_active, allow_cli_dispatch, health_detail, created_at)
                     VALUES (?1, ?2, 'isolated_webview', ?3, 0, 1, 0, ?4, ?5)",
                    params![provider_ref, &engine, &api_base, format!("The original {engine}. Sign in on the site with your subscription — no API key needed there."), now_ms()],
                )?;
            }
        }
        let status_line = if engine_kind == "subscription" {
            format!("Original {engine} — press Check after signing in")
        } else if needs_key {
            format!("Needs an API key for {engine} — reconnect with the key, or add it in Apps & providers.")
        } else if engine_kind == "openai_api" {
            format!("Live endpoint · {api_model} · press Check to verify")
        } else {
            "Ready for tasks".to_string()
        };
        let primary = if engine_kind == "openai_api" { provider_ref.clone() } else { "prov_ollama".to_string() };
        let id = if let Some(id) = existing {
            conn.execute(
                "UPDATE bot_profiles SET display_name = ?1, engine = ?2, command_or_url = ?3, run_status = 'ready', role = ?4, soul_markdown = ?5, engine_kind = ?6, api_base = ?7, api_model = ?8, primary_account_id = CASE WHEN ?6 = '' THEN primary_account_id ELSE ?9 END, status_line = ?10 WHERE id = ?11",
                params![name, &engine, &command, &engine, soul, engine_kind, &api_base, &api_model, &primary, &status_line, id],
            )?;
            id
        } else {
            let id = nid("bot");
            conn.execute(
                "INSERT INTO bot_profiles (id, handle, display_name, avatar, soul_markdown, primary_account_id, long_context_account_id, fallback_account_id, allow_computer_use, allow_browser_use, allow_code_exec, scoped_obsidian_folder, daily_wallet_limit_usd, is_pinned, role, created_at, engine, command_or_url, run_status, engine_kind, api_base, api_model, status_line) VALUES (?1,?2,?3,'XB',?4,?5,'prov_gemini','prov_openrouter',1,1,1,'',5,1,?6,?7,?8,?9,'ready',?10,?11,?12,?13)",
                params![id, handle, name, soul, &primary, &engine, now_ms(), &engine, &command, engine_kind, &api_base, &api_model, &status_line],
            )?;
            id
        };
        kv_set(&conn, "active_profile", &id)?;
        if engine_kind == "subscription" {
            format!("{handle} is bound to the original {engine} at {api_base}. Open it from the bot card to chat with your subscription, and press Check for its status.")
        } else if needs_key {
            format!("{handle} is linked to {engine} as {api_model}. Add its API key, then press Check to go live.")
        } else if engine_kind == "openai_api" {
            format!("{handle} is live on {engine} ({api_model}). Open it in chat — replies come from {engine}.")
        } else {
            format!("{handle} is linked. {detail}")
        }
    };
    finish(&state, Some(toast))
}

fn github_clone_target(raw: &str) -> Result<(String, String)> {
    let trimmed = raw.trim().trim_end_matches('/').trim_end_matches(".git");
    let Some(rest) = trimmed.strip_prefix("https://github.com/") else {
        return Err(err("clone URLs must start with https://github.com/"));
    };
    if rest.contains('@') || rest.contains("..") || rest.contains('?') {
        return Err(err("that GitHub URL is not a plain repository"));
    }
    let mut parts = rest.split('/');
    let owner = parts.next().unwrap_or("");
    let repo = parts.next().unwrap_or("");
    if owner.is_empty() || repo.is_empty() || !owner.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') || !repo.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.') {
        return Err(err("that GitHub URL is not a plain repository"));
    }
    Ok((format!("https://github.com/{owner}/{repo}.git"), repo.to_string()))
}

#[tauri::command]
pub async fn set_bot_run(state: State<'_, AppState>, id: String, action: String) -> Result<CommandResult> {
    let (handle, command, pid, engine_kind, api_base, api_model, provider): (String, String, Option<i64>, String, String, String, String) = {
        let conn = guard(&state);
        conn.query_row("SELECT handle, command_or_url, active_pid, engine_kind, api_base, api_model, primary_account_id FROM bot_profiles WHERE id = ?1", params![id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?))
        })
        .map_err(|_| err("bot not found"))?
    };
    let trimmed = command.trim().to_string();
    if action == "start" && engine_kind == "subscription" {
        let (ptype, pendpoint, pname): (String, String, String) = {
            let conn = guard(&state);
            conn.query_row(
                "SELECT provider_type, binary_or_endpoint, name FROM provider_accounts WHERE id = ?1",
                params![provider],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap_or_default()
        };
        let secret = state.secrets.lock().unwrap_or_else(|e| e.into_inner()).get(&provider).cloned();
        let site = if api_base.trim().is_empty() { trimmed.clone() } else { api_base.trim().to_string() };
        // Readiness by subscription type: CLI login (Claude/Gemini), plan OAuth
        // (ChatGPT), or the original site with an optional key for in-chat.
        let (run_status, status_line, toast) = match ptype.as_str() {
            "cli_subprocess" => {
                // No stored path means look the CLI up by name: "Claude Code"
                // -> `claude`, "Gemini" -> `gemini`; where.exe resolves .cmd/.exe.
                let bin = if pendpoint.trim().is_empty() {
                    pname.split_whitespace().next().unwrap_or("").to_ascii_lowercase()
                } else {
                    pendpoint.trim().to_string()
                };
                let installed = !bin.is_empty() && (std::path::Path::new(&bin).exists() || crate::util::which(&bin).is_some());
                if installed {
                    (
                        "running",
                        format!("Signed in via {pname} — in-chat replies come from your subscription."),
                        format!("{handle} is live: {pname} is installed and signed in on this machine."),
                    )
                } else {
                    (
                        "stopped",
                        format!("{pname} is not installed or not signed in yet. Connect it in Apps & providers — your subscription covers it, no API key."),
                        format!("{handle} needs {pname} installed and signed in. That uses your subscription, no API key."),
                    )
                }
            }
            "official_oauth" => match secret.filter(|s| !s.trim().is_empty()) {
                None => (
                    "stopped",
                    format!("Sign in to {pname} from Apps & providers — your plan covers in-chat replies, no API key."),
                    format!("{handle} needs a ChatGPT sign-in. Use Continue with ChatGPT in Apps & providers — your plan, no API key."),
                ),
                Some(s) if crate::siwc::is_plan_secret(&s) => {
                    let mut model = api_model.trim().to_string();
                    if model.is_empty() {
                        // Auto-pick the plan's first model so the bot needs no setup.
                        if let Ok(bearer) = crate::siwc::fresh_bearer(&state) {
                            if let Ok(list) = crate::siwc::fetch_models(&bearer) {
                                if let Some((id, _)) = list.first() {
                                    model = id.clone();
                                }
                            }
                        }
                    }
                    let model_note = if model.is_empty() { String::new() } else { format!(" · {model}") };
                    if !model.is_empty() && model != api_model.trim() {
                        let conn = guard(&state);
                        let _ = conn.execute("UPDATE bot_profiles SET api_model = ?1 WHERE id = ?2", params![&model, id]);
                    }
                    (
                        "running",
                        format!("ChatGPT plan signed in{model_note} — replies come from your subscription."),
                        format!("{handle} is live on your ChatGPT plan. Replies in chat come from the subscription, no API key."),
                    )
                }
                Some(_) => (
                    "running",
                    format!("API key stored for {pname} — in-chat replies are live."),
                    format!("{handle} is live with the stored key for {pname}."),
                ),
            },
            _ => match secret.filter(|s| !s.trim().is_empty()) {
                Some(_) => (
                    "running",
                    format!("API key stored for {pname} — in-chat replies are live. The original stays at {site}."),
                    format!("{handle} is live in chat with the stored key for {pname}."),
                ),
                None => (
                    "ready",
                    format!("The original {pname} lives at {site}. Open it from this card to chat with your subscription; in-chat replies here also need an API key."),
                    format!("{handle} opens the original {pname} from its card. In-chat replies need an API key for {pname}."),
                ),
            },
        };
        {
            let conn = guard(&state);
            conn.execute(
                "UPDATE bot_profiles SET run_status = ?1, active_pid = NULL, status_line = ?2 WHERE id = ?3",
                params![run_status, &status_line, id],
            )?;
        }
        return finish(&state, Some(toast));
    }
    if action == "start" && engine_kind == "openai_api" {
        let base = if api_base.trim().is_empty() { trimmed } else { api_base.trim().trim_end_matches('/').to_string() };
        let host = url::Url::parse(&base).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_else(|| base.clone());
        let key = state.secrets.lock().unwrap_or_else(|e| e.into_inner()).get(&provider).cloned().filter(|k| !k.trim().is_empty());
        let Some(key) = key else {
            let conn = guard(&state);
            conn.execute(
                "UPDATE bot_profiles SET run_status = 'stopped', active_pid = NULL, status_line = ?1 WHERE id = ?2",
                params![format!("Needs an API key for {host} — add it in Apps & providers, or reconnect the bot with the key."), id],
            )?;
            return finish(&state, Some(format!("{handle} has no API key for {host} yet. Store the key, then press Check again.")));
        };
        let outcome = probe_api(&base, &key);
        let toast = {
            let conn = guard(&state);
            match outcome {
                Ok((code, ms)) if (200..300).contains(&code) => {
                    conn.execute(
                        "UPDATE bot_profiles SET run_status = 'running', active_pid = NULL, status_line = ?1 WHERE id = ?2",
                        params![format!("Live · {host} · {api_model} · {ms}ms"), id],
                    )?;
                    format!("{handle} is live: {host} accepted the key check in {ms}ms.")
                }
                Ok((code, _)) if code == 401 || code == 403 => {
                    conn.execute(
                        "UPDATE bot_profiles SET run_status = 'stopped', active_pid = NULL, status_line = ?1 WHERE id = ?2",
                        params![format!("Key rejected by {host} (HTTP {code})."), id],
                    )?;
                    format!("{handle}'s API key was rejected by {host} (HTTP {code}). Replace the key and check again.")
                }
                Ok((code, ms)) => {
                    conn.execute(
                        "UPDATE bot_profiles SET run_status = 'ready', active_pid = NULL, status_line = ?1 WHERE id = ?2",
                        params![format!("Reached {host} in {ms}ms but the key check returned HTTP {code} — chat may still work."), id],
                    )?;
                    format!("{handle} reached {host} (HTTP {code}). That endpoint may not expose /models; try chatting with it.")
                }
                Err(error) => {
                    conn.execute(
                        "UPDATE bot_profiles SET run_status = 'stopped', active_pid = NULL, status_line = ?1 WHERE id = ?2",
                        params![format!("{host} unreachable: {error}"), id],
                    )?;
                    format!("{handle} could not reach {host}: {error}")
                }
            }
        };
        return finish(&state, Some(toast));
    }
    if action == "start" && (trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        let reached = probe_http(&trimmed);
        let toast = {
            let conn = guard(&state);
            match reached {
                Ok(()) => {
                    conn.execute("UPDATE bot_profiles SET run_status = 'running', active_pid = NULL WHERE id = ?1", params![id])?;
                    format!("{handle} answered at {trimmed}.")
                }
                Err(error) => {
                    conn.execute("UPDATE bot_profiles SET run_status = 'stopped', active_pid = NULL WHERE id = ?1", params![id])?;
                    format!("{handle} is not reachable: {error}")
                }
            }
        };
        return finish(&state, Some(toast));
    }
    let toast = {
        let conn = guard(&state);
        match action.as_str() {
            "start" => start_bot(&conn, &id, &handle, &command)?,
            "stop" => {
                if let Some(pid) = pid {
                    stop_pid(pid);
                }
                conn.execute("UPDATE bot_profiles SET run_status = 'stopped', active_pid = NULL WHERE id = ?1", params![id])?;
                format!("{handle} stopped.")
            }
            _ => "Unknown bot action.".into(),
        }
    };
    finish(&state, Some(toast))
}

fn probe_http(url: &str) -> std::result::Result<(), String> {
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(4))
        .build()
        .map_err(|error| error.without_url().to_string())?;
    client.get(url).send().map(|_| ()).map_err(|error| error.without_url().to_string())
}

// Key check for cloud bots: GET {base}/models with the stored key. 200 means
// the endpoint is live and the key works; 401/403 mean the key is bad; other
// codes are reported so the user can decide (some gateways lack /models).
fn probe_api(base: &str, key: &str) -> std::result::Result<(u16, u128), String> {
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(6))
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|error| error.to_string())?;
    let started = Instant::now();
    let response = client
        .get(format!("{base}/models"))
        .bearer_auth(key)
        .send()
        .map_err(|error| error.without_url().to_string())?;
    let code = response.status().as_u16();
    let _ = response.text();
    Ok((code, started.elapsed().as_millis()))
}

fn stop_pid(pid: i64) {
    let pid_text = pid.to_string();
    #[cfg(windows)]
    {
        let _ = run_capture("taskkill", &["/PID", &pid_text, "/F"], None, Duration::from_secs(3));
    }
    #[cfg(not(windows))]
    {
        let _ = run_capture("kill", &[&pid_text], None, Duration::from_secs(3));
    }
}

fn start_bot(conn: &Connection, id: &str, handle: &str, command: &str) -> Result<String> {
    let command = command.trim();
    if command.is_empty() {
        return Err(err("this bot has no command yet"));
    }
    if command.starts_with("ws://") || command.starts_with("wss://") {
        conn.execute("UPDATE bot_profiles SET run_status = 'ready', active_pid = NULL WHERE id = ?1", params![id])?;
        return Ok(format!("{handle} WebSocket is saved. Chat still routes through the harness you pick in the lane."));
    }
    if std::path::Path::new(command).is_dir() {
        conn.execute("UPDATE bot_profiles SET run_status = 'ready', active_pid = NULL WHERE id = ?1", params![id])?;
        Ok(format!("{handle} is linked at {command}. Set a start command such as uv run python main.py to launch it."))
    } else {
        if command.chars().any(|c| matches!(c, '&' | '|' | ';' | '<' | '>' | '`' | '$' | '\n' | '\r')) {
            return Err(err("pipes, redirects, and command chaining are blocked"));
        }
        let parts: Vec<&str> = command.split_whitespace().collect();
        let program = *parts.first().ok_or_else(|| err("empty command"))?;
        let mut cmd = std::process::Command::new(program);
        cmd.args(&parts[1..]);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }
        match cmd.spawn() {
            Ok(child) => {
                let child_pid = child.id() as i64;
                conn.execute("UPDATE bot_profiles SET run_status = 'running', active_pid = ?1 WHERE id = ?2", params![child_pid, id])?;
                Ok(format!("Started {handle} at pid {child_pid}."))
            }
            Err(error) => {
                conn.execute("UPDATE bot_profiles SET run_status = 'stopped', active_pid = NULL WHERE id = ?1", params![id])?;
                Ok(format!("Could not start {handle}: {error}"))
            }
        }
    }
}

#[tauri::command]
pub async fn set_app_path(state: State<'_, AppState>, app_id: String, path: String) -> Result<CommandResult> {
    let toast = {
        let conn = guard(&state);
        if path.trim().is_empty() || !std::path::Path::new(path.trim()).exists() {
            return Err(err("that file was not found"));
        }
        let n = conn.execute(
            "UPDATE linked_local_apps SET executable_path = ?1, status = 'ready', detail = 'Path set from file picker.', updated_at = ?2 WHERE id = ?3",
            params![path.trim(), now_ms(), app_id],
        )?;
        if n == 0 {
            return Err(err("app not found"));
        }
        "Path saved.".to_string()
    };
    finish(&state, Some(toast))
}

#[tauri::command]
pub async fn add_app(
    state: State<'_, AppState>,
    id: Option<String>,
    name: String,
    category: Option<String>,
    executable_path: Option<String>,
) -> Result<CommandResult> {
    let app_name = name.trim().to_string();
    if app_name.is_empty() {
        return Err(err("App name cannot be empty"));
    }
    let slug: String = app_name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '_' })
        .collect();
    let app_id = id
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| format!("app_{}", slug.trim_matches('_')));
    let cat = category.filter(|s| !s.trim().is_empty()).unwrap_or_else(|| "tools".to_string());
    let path = executable_path.unwrap_or_default().trim().to_string();
    let status = if !path.is_empty() { "ready" } else { "missing" };
    let detail = if !path.is_empty() { "Configured." } else { "Not found yet." };
    let now = now_ms();
    {
        let conn = guard(&state);
        conn.execute(
            "INSERT INTO linked_local_apps (id, app_name, category, executable_path, bridge_protocol, active_pid, status, detail, updated_at)
             VALUES (?1, ?2, ?3, ?4, 'local_process', NULL, ?5, ?6, ?7)
             ON CONFLICT(id) DO UPDATE SET app_name=?2, category=?3, executable_path=?4, status=?5, detail=?6, updated_at=?7",
            params![app_id, app_name, cat, path, status, detail, now],
        )?;
    }
    finish(&state, Some(format!("App '{app_name}' added.")))
}

#[tauri::command]
pub async fn fleet_action(state: State<'_, AppState>, app_id: String, action: String) -> Result<CommandResult> {
    let toast = {
        let conn = guard(&state);
        let (path, pid, name): (String, Option<i64>, String) = conn.query_row(
            "SELECT executable_path, active_pid, app_name FROM linked_local_apps WHERE id=?1",
            params![app_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        ).map_err(|_| err("app not found"))?;
        match action.as_str() {
            "start" => {
                let wsl_bin = path.strip_prefix("wsl:");
                if path.is_empty() || (wsl_bin.is_none() && !std::path::Path::new(&path).is_file()) {
                    format!("{name} is not installed, so it was not started.")
                } else {
                    match crate::workspace_apps::launch_program(std::path::Path::new(&path)) {
                        Ok(child_pid) => {
                            let stored: Option<i64> = if child_pid == 0 { None } else { Some(child_pid as i64) };
                            conn.execute("UPDATE linked_local_apps SET active_pid=?1, status='running', updated_at=?2 WHERE id=?3", params![stored, now_ms(), app_id])?;
                            let line = if child_pid == 0 { format!("started {name}") } else { format!("started pid {child_pid}") };
                            conn.execute("INSERT INTO fleet_logs (id, bot_name, stream, line, created_at) VALUES (?1,?2,'stdout',?3,?4)", params![nid("flog"), name, line, now_ms()])?;
                            if child_pid == 0 { format!("Started {name}.") } else { format!("Started {name} at pid {child_pid}.") }
                        }
                        Err(error) => format!("Could not start {name}: {}", error.0),
                    }
                }
            }
            "stop" => {
                if let Some(pid) = pid {
                    stop_pid(pid);
                    conn.execute("UPDATE linked_local_apps SET active_pid=NULL, status='ready', updated_at=?1 WHERE id=?2", params![now_ms(), app_id])?;
                    format!("Stopped pid {pid}.")
                } else {
                    format!("{name} has no tracked pid.")
                }
            }
            _ => "Unknown fleet action.".into(),
        }
    };
    finish(&state, Some(toast))
}

#[tauri::command]
pub async fn inspect_url(state: State<'_, AppState>, url: String) -> Result<CommandResult> {
    let inspect_url = url.clone();
    let (nodes, ms) = tauri::async_runtime::spawn_blocking(move || crate::computer::inspect(&inspect_url))
        .await
        .map_err(|error| err(format!("inspect failed: {error}")))??;
    {
        let conn = guard(&state);
        kv_set(&conn, "computer_url", &url)?;
        kv_set(&conn, "dom_nodes", &serde_json::to_string(&nodes)?)?;
        kv_set(&conn, "dom_latency_ms", &ms.to_string())?;
    }
    finish(&state, Some(format!("DOM pass finished in {ms}ms. {} interactive nodes.", nodes.len())))
}

#[tauri::command]
pub async fn run_sandbox(state: State<'_, AppState>, command: String, bot_id: Option<String>) -> Result<CommandResult> {
    if command.chars().any(|c| matches!(c, '&' | '|' | ';' | '<' | '>' | '`' | '$' | '\n' | '\r')) {
        return Err(err("pipes, redirects, and command chaining are blocked"));
    }
    let parts = crate::util::split_args(&command);
    let program = parts.first().cloned().ok_or_else(|| err("empty command"))?;
    if let Some(reason) = crate::util::interpreter_eval_flag(&program, parts.get(1..).unwrap_or(&[])) {
        return Err(err(reason));
    }
    let allowed = [
        "git", "npm", "npm.cmd", "npx", "npx.cmd", "pnpm", "pnpm.cmd", "yarn", "yarn.cmd",
        "node", "python", "python.exe", "python3", "pip", "pip.exe", "uv", "cargo", "rustc",
        "bun", "where", "where.exe", "which", "go", "deno", "tsc", "tsc.cmd", "echo", "cat", "dir", "ls", "pwd",
        "pytest", "ruff", "vitest", "eslint"
    ];
    let prog_lower = program.to_ascii_lowercase();
    if !allowed.contains(&program.as_str()) && !allowed.contains(&prog_lower.as_str()) {
        return Err(err("that program is not on the sandbox allowlist"));
    }
    let scoped = bot_id.as_deref().map(str::trim).filter(|id| !id.is_empty()).map(str::to_string);
    if scoped.is_some() {
        crate::bot_screen::command_stays(&command, &parts)?;
    }
    let cwd = if let Some(id) = &scoped {
        {
            let conn = guard(&state);
            let n: i64 = conn.query_row("SELECT COUNT(*) FROM bot_profiles WHERE id=?1", params![id], |row| row.get(0))?;
            if n == 0 {
                return Err(err("profile not found"));
            }
        }
        crate::bot_screen::shell_cwd(&state.home, id, "")?
    } else {
        let conn = guard(&state);
        let settings = db::settings_of(&conn).unwrap_or_default();
        if !settings.project_root.trim().is_empty() && std::path::Path::new(&settings.project_root).is_dir() {
            std::path::PathBuf::from(&settings.project_root)
        } else if let Ok(current) = std::env::current_dir() {
            current
        } else {
            state.home.join("sandbox")
        }
    };
    if scoped.is_none() {
        std::fs::create_dir_all(&cwd)?;
    }

    #[cfg(windows)]
    let resolved_program = {
        if !program.ends_with(".exe") && !program.ends_with(".cmd") {
            if crate::util::which(&format!("{program}.cmd")).is_some() {
                format!("{program}.cmd")
            } else if crate::util::which(&format!("{program}.exe")).is_some() {
                format!("{program}.exe")
            } else {
                program.clone()
            }
        } else {
            program.clone()
        }
    };
    #[cfg(not(windows))]
    let resolved_program = program.clone();

    let app_handle = state.app_handle.lock().ok().and_then(|g| g.clone());
    if scoped.is_none() {
        if let Some(app) = &app_handle {
            let banner = format!(
                "\r\n\x1b[1;35m⚡ [sandbox user command]:\x1b[0m \x1b[1;33m$ {command}\x1b[0m\r\n\x1b[90m📁 working dir: {}\x1b[0m\r\n\r\n",
                cwd.display()
            );
            crate::util::broadcast_to_terminal(app, &banner);
        }
    }

    let args: Vec<&str> = parts.iter().skip(1).map(String::as_str).collect();
    let app_stream = if scoped.is_none() { app_handle.clone() } else { None };
    let (code, output) = crate::util::run_capture_stream(&resolved_program, &args, Some(&cwd), Duration::from_secs(60), move |chunk| {
        if let Some(app) = &app_stream {
            crate::util::broadcast_to_terminal(app, chunk);
        }
    })?;

    if scoped.is_none() {
        if let Some(app) = &app_handle {
            let finish_banner = if code == 0 {
                format!("\r\n\x1b[1;32m✔ [sandbox] exited with code 0\x1b[0m\r\n\r\n")
            } else {
                format!("\r\n\x1b[1;31m✖ [sandbox] exited with code {code}\x1b[0m\r\n\r\n")
            };
            crate::util::broadcast_to_terminal(app, &finish_banner);
        }
    }

    let toast = {
        let conn = guard(&state);
        let text = format!("$ {command}\nexit {code}\n{output}");
        if let Some(id) = &scoped {
            crate::bot_screen::store_shell(&conn, id, &text)?;
        } else {
            kv_set(&conn, "sandbox_output", &text)?;
            if let Some(thread) = db::kv_get(&conn, "active_thread")? {
                insert_step(&conn, &thread, "tool", "sandbox", "Sandbox command finished.", "pty_terminal", &json!({"command": command, "exitCode": code, "output": output}), 0)?;
            }
        }
        format!("exit {code}")
    };
    finish(&state, Some(toast))
}

#[tauri::command]
pub async fn memory_vault(state: State<'_, AppState>, action: String, query: Option<String>) -> Result<CommandResult> {
    let action = action.trim();
    let payload = {
        let conn = guard(&state);
        match action {
            "search" => crate::memory::search_vault(&conn, query.unwrap_or_default().trim())?,
            "journal" => crate::memory::journal(&conn)?,
            _ => return Err(err("unknown memory action")),
        }
    };
    let toast = if action == "search" { "Searched the local vault.".to_string() } else { "Loaded the memory journal.".to_string() };
    finish_payload(&state, Some(toast), Some(payload))
}

#[tauri::command]
pub async fn workspace_git(
    app: AppHandle,
    action: String,
    path: Option<String>,
    agent: Option<String>,
    prompt: Option<String>,
) -> Result<CommandResult> {
    let app_for_work = app.clone();
    let (toast, payload) = tauri::async_runtime::spawn_blocking(move || {
        let state = app_for_work.state::<AppState>();
        crate::workspace_git::perform(
            &state,
            action.trim(),
            path.unwrap_or_default().trim(),
            agent.unwrap_or_default().trim(),
            prompt.unwrap_or_default().trim(),
        )
    })
    .await
    .map_err(|error| err(format!("git work stopped: {error}")))??;
    let state = app.state::<AppState>();
    finish_payload(&state, Some(toast), Some(payload))
}

#[tauri::command]
pub async fn install_git_package(state: State<'_, AppState>, url: String, profile_id: Option<String>) -> Result<CommandResult> {
    let note = crate::workspace_git::install_package(&state, url.trim(), profile_id.unwrap_or_default().trim())?;
    finish(&state, Some(note))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowPatch {
    pub id: String,
    pub node_id: Option<String>,
    pub model: Option<String>,
    pub prompt: Option<String>,
    pub yaml_source: Option<String>,
}

#[tauri::command]
pub async fn create_workflow(state: State<'_, AppState>, name: String) -> Result<CommandResult> {
    {
        let conn = guard(&state);
        let id = nid("wf");
        let trimmed = name.trim();
        let name = if trimmed.is_empty() { "Untitled workflow".to_string() } else { trimmed.to_string() };
        let nodes = vec![WfNode {
            id: "node_1".into(),
            name: "Step".into(),
            kind: "llm_reasoning".into(),
            bot_profile: String::new(),
            model: String::new(),
            prompt: String::new(),
            status: "pending".into(),
            latency_ms: 0,
        }];
        let triggers: Vec<String> = Vec::new();
        let yaml = crate::yaml_flow::emit(&id, &name, "idle", None, &triggers, &nodes);
        write_workflow(&state.home, &id, &yaml)?;
        conn.execute(
            "INSERT INTO workflows (id, name, yaml_source, nodes_json, triggers_json, current_status, paused_at_node_id, checkpoint_json, updated_at) VALUES (?1,?2,?3,?4,'[]','idle',NULL,'{}',?5)",
            params![id, name, yaml, serde_json::to_string(&nodes)?, now_ms()],
        )?;
    }
    finish(&state, Some("Workflow created.".into()))
}

#[tauri::command]
pub async fn update_workflow(state: State<'_, AppState>, patch: WorkflowPatch) -> Result<CommandResult> {
    {
        let conn = guard(&state);
        apply_workflow(&conn, &state.home, &patch, false)?;
    }
    finish(&state, Some("Workflow file updated.".into()))
}

#[tauri::command]
pub async fn pause_workflow(state: State<'_, AppState>, id: String, node_id: Option<String>) -> Result<CommandResult> {
    {
        let conn = guard(&state);
        let wf_exists: bool = conn
            .query_row(
                "SELECT count(1) FROM workflows WHERE id=?1",
                params![id],
                |r| r.get::<_, i64>(0),
            )
            .map(|c| c > 0)
            .unwrap_or(false);

        if wf_exists {
            let patch = WorkflowPatch { id, node_id, model: None, prompt: None, yaml_source: None };
            pause_node(&conn, &state.home, &patch)?;
        } else {
            let thread_exists: bool = conn
                .query_row(
                    "SELECT count(1) FROM chat_threads WHERE id=?1",
                    params![id],
                    |r| r.get::<_, i64>(0),
                )
                .map(|c| c > 0)
                .unwrap_or(false);

            if thread_exists {
                conn.execute(
                    "UPDATE chat_threads SET status='paused', updated_at=?1 WHERE id=?2",
                    params![now_ms(), id],
                )?;
            } else {
                return Err(err("workflow or routine not found"));
            }
        }
    }
    finish(&state, Some("Paused. You can edit the node or routine and resume from here.".into()))
}

#[tauri::command]
pub async fn resume_workflow(app: AppHandle, id: String) -> Result<CommandResult> {
    let is_workflow = {
        // The state lock is only held for the lookup; the run itself takes it
        // per step.
        let state = app.state::<AppState>();
        let conn = guard(&state);
        conn.query_row("SELECT count(1) FROM workflows WHERE id=?1", params![id], |r| r.get::<_, i64>(0))
            .map(|c| c > 0)
            .unwrap_or(false)
    };
    if is_workflow {
        let handle = app.clone();
        let note = match tauri::async_runtime::spawn_blocking(move || {
            let state = handle.state::<AppState>();
            // Resume approves a paused gate (if any) and continues the run.
            execute_workflow(&state, &id, true)
        })
        .await
        {
            Ok(result) => result?,
            Err(error) => return Err(err(format!("The workflow run stopped. {error}"))),
        };
        let state = app.state::<AppState>();
        return finish(&state, Some(note));
    }
    let toast = {
        let state = app.state::<AppState>();
        let conn = guard(&state);
        let thread_exists: bool = conn
            .query_row("SELECT count(1) FROM chat_threads WHERE id=?1", params![id], |r| r.get::<_, i64>(0))
            .map(|c| c > 0)
            .unwrap_or(false);
        if thread_exists {
            conn.execute("UPDATE chat_threads SET status='idle', updated_at=?1 WHERE id=?2", params![now_ms(), id])?;
            "Routine resumed.".into()
        } else {
            return Err(err("workflow or routine not found"));
        }
    };
    let state = app.state::<AppState>();
    finish(&state, Some(toast))
}

fn apply_workflow(conn: &Connection, home: &std::path::Path, patch: &WorkflowPatch, _resume: bool) -> Result<()> {
    let (name, status, paused, triggers, mut nodes): (String, String, Option<String>, Vec<String>, Vec<WfNode>) = if let Some(yaml) = patch.yaml_source.as_ref().filter(|s| !s.trim().is_empty()) {
        let parsed = crate::yaml_flow::parse(yaml).map_err(err)?;
        (parsed.1, parsed.2, parsed.3, parsed.4, parsed.5)
    } else {
        conn.query_row(
            "SELECT name, current_status, paused_at_node_id, triggers_json, nodes_json FROM workflows WHERE id=?1",
            params![patch.id],
            |r| {
                let triggers: Vec<String> = serde_json::from_str(&r.get::<_, String>(3)?).unwrap_or_default();
                let nodes: Vec<WfNode> = serde_json::from_str(&r.get::<_, String>(4)?).unwrap_or_default();
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, triggers, nodes))
            },
        ).map_err(|_| err("workflow not found"))?
    };
    if let Some(node_id) = &patch.node_id {
        if let Some(node) = nodes.iter_mut().find(|n| &n.id == node_id) {
            if let Some(model) = &patch.model {
                node.model = model.clone();
            }
            if let Some(prompt) = &patch.prompt {
                node.prompt = prompt.clone();
            }
        }
    }
    let yaml = crate::yaml_flow::emit(&patch.id, &name, &status, paused.as_deref(), &triggers, &nodes);
    write_workflow(home, &patch.id, &yaml)?;
    conn.execute(
        "UPDATE workflows SET name=?1, yaml_source=?2, nodes_json=?3, triggers_json=?4, current_status=?5, paused_at_node_id=?6, updated_at=?7 WHERE id=?8",
        params![name, yaml, serde_json::to_string(&nodes)?, serde_json::to_string(&triggers)?, status, paused, now_ms(), patch.id],
    )?;
    let _ = triggers;
    Ok(())
}

fn pause_node(conn: &Connection, home: &std::path::Path, patch: &WorkflowPatch) -> Result<()> {
    let node_id = patch.node_id.clone().unwrap_or_default();
    let (name, triggers, mut nodes): (String, Vec<String>, Vec<WfNode>) = conn.query_row(
        "SELECT name, triggers_json, nodes_json FROM workflows WHERE id=?1",
        params![patch.id],
        |r| Ok((r.get::<_, String>(0)?, serde_json::from_str(&r.get::<_, String>(1)?).unwrap_or_default(), serde_json::from_str(&r.get::<_, String>(2)?).unwrap_or_default())),
    ).map_err(|_| err("workflow not found"))?;
    if !node_id.is_empty() {
        if let Some(node) = nodes.iter_mut().find(|n| n.id == node_id) {
            node.status = "paused".into();
        }
    } else if let Some(node) = nodes.iter_mut().find(|n| n.status != "done") {
        node.status = "paused".into();
    }
    let yaml = crate::yaml_flow::emit(&patch.id, &name, "paused_editable", if node_id.is_empty() { None } else { Some(&node_id) }, &triggers, &nodes);
    write_workflow(home, &patch.id, &yaml)?;
    conn.execute(
        "UPDATE workflows SET yaml_source=?1, nodes_json=?2, current_status='paused_editable', paused_at_node_id=?3, updated_at=?4 WHERE id=?5",
        params![yaml, serde_json::to_string(&nodes)?, if node_id.is_empty() { None } else { Some(&node_id) }, now_ms(), patch.id],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Real workflow execution. Each pending step runs through the bot engine
// (agent::dispatch), so a step's output, latency, and error are whatever the
// assigned bot actually produced. Approval and wallet steps pause the run:
// pressing Resume approves the paused gate and continues from there.
// ---------------------------------------------------------------------------

fn persist_workflow(
    conn: &Connection,
    home: &std::path::Path,
    id: &str,
    name: &str,
    status: &str,
    paused: Option<&str>,
    triggers: &[String],
    nodes: &[WfNode],
    checkpoint: &serde_json::Map<String, Value>,
) -> Result<()> {
    let yaml = crate::yaml_flow::emit(id, name, status, paused, triggers, nodes);
    write_workflow(home, id, &yaml)?;
    conn.execute(
        "UPDATE workflows SET yaml_source=?1, nodes_json=?2, triggers_json=?3, current_status=?4, paused_at_node_id=?5, checkpoint_json=?6, updated_at=?7 WHERE id=?8",
        params![yaml, serde_json::to_string(nodes)?, serde_json::to_string(triggers)?, status, paused, Value::Object(checkpoint.clone()).to_string(), now_ms(), id],
    )?;
    Ok(())
}

fn resolve_bot_profile(conn: &Connection, reference: &str) -> Option<String> {
    let reference = reference.trim();
    if reference.is_empty() {
        return None;
    }
    if let Ok(row) = conn.query_row("SELECT id FROM bot_profiles WHERE id=?1", params![reference], |r| r.get::<_, String>(0)) {
        return Some(row);
    }
    let needle = reference.trim_start_matches('@').to_ascii_lowercase();
    if needle.is_empty() {
        return None;
    }
    conn.query_row(
        "SELECT id FROM bot_profiles WHERE lower(replace(handle, '@', ''))=?1 OR lower(display_name)=?1",
        params![needle],
        |r| r.get::<_, String>(0),
    )
    .ok()
}

// One workflow run at a time: runs rewrite the global active_profile KV and
// node statuses, so two interleaved runs corrupt each other's state.
static WORKFLOW_RUN: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn usd_amount_from_prompt(prompt: &str) -> f64 {
    let patterns = [r"\$\s*([0-9]+(?:\.[0-9]+)?)", r"(?i)([0-9]+(?:\.[0-9]+)?)\s*usd", r"(?i)usd\s*([0-9]+(?:\.[0-9]+)?)"];
    for pattern in patterns {
        if let Ok(expr) = regex::Regex::new(pattern) {
            if let Some(found) = expr.captures(prompt).and_then(|caps| caps.get(1)).and_then(|item| item.as_str().parse::<f64>().ok()) {
                if found > 0.0 {
                    return found;
                }
            }
        }
    }
    0.0
}

fn rail_from_prompt(prompt: &str) -> &'static str {
    let lower = prompt.to_lowercase();
    if lower.contains("upi") || lower.contains("razorpay") || prompt.contains('₹') {
        "razorpay_upi"
    } else if lower.contains("stripe") {
        "stripe_card"
    } else if lower.contains("hyperliquid") {
        "hyperliquid_ws"
    } else {
        "crypto_x402"
    }
}

fn execute_workflow(state: &AppState, id: &str, approve_paused_gate: bool) -> Result<String> {
    use tauri::Emitter;
    let _run_guard = WORKFLOW_RUN.try_lock().map_err(|_| err("another workflow run is already in progress; wait for it to finish or pause it first"))?;
    let (name, triggers, mut nodes, paused_at, mut checkpoint): (String, Vec<String>, Vec<WfNode>, Option<String>, serde_json::Map<String, Value>) = {
        let conn = guard(state);
        let row = conn
            .query_row(
                "SELECT name, triggers_json, nodes_json, paused_at_node_id, checkpoint_json FROM workflows WHERE id=?1",
                params![id],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        serde_json::from_str(&r.get::<_, String>(1)?).unwrap_or_default(),
                        serde_json::from_str(&r.get::<_, String>(2)?).unwrap_or_default(),
                        r.get::<_, Option<String>>(3)?,
                        serde_json::from_str(&r.get::<_, String>(4)?).unwrap_or_default(),
                    ))
                },
            )
            .map_err(|_| err("workflow not found"))?;
        (row.0, row.1, row.2, row.3, row.4)
    };
    if nodes.is_empty() {
        return Err(err("this workflow has no steps to run"));
    }
    let app = state.app_handle.lock().ok().and_then(|g| g.clone());
    let original_profile: Option<String> = {
        let conn = guard(state);
        kv_get(&conn, "active_profile").ok().flatten().filter(|value| !value.trim().is_empty())
    };

    fn step_is_done(node: &WfNode) -> bool {
        node.status == "done"
    }

    let mut index = 0;
    while index < nodes.len() {
        if step_is_done(&nodes[index]) {
            index += 1;
            continue;
        }
        let node_id = nodes[index].id.clone();
        let node_kind = nodes[index].kind.clone();
        let node_name = nodes[index].name.clone();
        let node_prompt = nodes[index].prompt.clone();
        let node_bot = nodes[index].bot_profile.clone();
        let node_model = nodes[index].model.trim().to_string();
        let gate = node_kind == "approval_gate" || node_kind == "wallet_execution";

        if gate {
            let is_paused_here = paused_at.as_deref() == Some(node_id.as_str());
            if !(approve_paused_gate && is_paused_here) {
                nodes[index].status = "paused".into();
                nodes[index].latency_ms = 0;
                {
                    let conn = guard(state);
                    persist_workflow(&conn, &state.home, id, &name, "paused_editable", Some(&node_id), &triggers, &nodes, &checkpoint)?;
                }
                if let Some(app) = &app {
                    let _ = app.emit("ronic://wf-progress", json!({ "id": id, "status": "paused_editable", "nodes": nodes }));
                }
                return Ok(if node_kind == "wallet_execution" {
                    format!("Paused at the wallet step {node_id}. Resume runs the policy gate against the ledger. It is not approved until that settlement succeeds.")
                } else {
                    format!("Paused at the approval gate {node_id}. Press Resume to approve it and continue the run.")
                });
            }
            if node_kind == "wallet_execution" {
                let amount = usd_amount_from_prompt(&node_prompt);
                let rail = rail_from_prompt(&node_prompt);
                let bot = node_bot.trim().to_string();
                let outcome = {
                    let conn = guard(state);
                    if amount <= 0.0 {
                        Err(err("Wallet step has no dollar amount, so nothing was approved."))
                    } else {
                        crate::wallet::settle(&conn, &bot, rail, amount, &format!("{amount:.2} USD"), "workflow", &node_prompt, "agent", "payment", None, "spend")
                    }
                };
                match outcome {
                    Ok(note) if note.starts_with("pending_approval") => {
                        nodes[index].status = "paused".into();
                        checkpoint.insert(node_id.clone(), json!(note.clone()));
                        {
                            let conn = guard(state);
                            persist_workflow(&conn, &state.home, id, &name, "paused_editable", Some(&node_id), &triggers, &nodes, &checkpoint)?;
                        }
                        if let Some(app) = &app {
                            let _ = app.emit("ronic://wf-progress", json!({ "id": id, "status": "paused_editable", "nodes": nodes }));
                        }
                        return Ok(format!("Wallet step {node_id} is waiting in the approval queue. {note}"));
                    }
                    Ok(note) if note.starts_with("auto_signed") || note.starts_with("approved_by_user") => {
                        nodes[index].status = "done".into();
                        nodes[index].latency_ms = 0;
                        checkpoint.insert(node_id.clone(), json!(note));
                    }
                    Ok(note) => {
                        nodes[index].status = "error".into();
                        checkpoint.insert(node_id.clone(), json!(note.clone()));
                        {
                            let conn = guard(state);
                            persist_workflow(&conn, &state.home, id, &name, "error", Some(&node_id), &triggers, &nodes, &checkpoint)?;
                        }
                        return Err(err(format!("Wallet step {node_id} was not approved. {note}")));
                    }
                    Err(error) => {
                        nodes[index].status = "error".into();
                        checkpoint.insert(node_id.clone(), json!(format!("error: {error}")));
                        {
                            let conn = guard(state);
                            persist_workflow(&conn, &state.home, id, &name, "error", Some(&node_id), &triggers, &nodes, &checkpoint)?;
                        }
                        return Err(err(format!("Wallet step {node_id} was not approved. {error}")));
                    }
                }
                {
                    let conn = guard(state);
                    persist_workflow(&conn, &state.home, id, &name, "running", None, &triggers, &nodes, &checkpoint)?;
                }
                if let Some(app) = &app {
                    let _ = app.emit("ronic://wf-progress", json!({ "id": id, "status": "running", "nodes": nodes }));
                }
                index += 1;
                continue;
            }
            nodes[index].status = "done".into();
            nodes[index].latency_ms = 0;
            checkpoint.insert(node_id.clone(), json!("approved by resume"));
            {
                let conn = guard(state);
                persist_workflow(&conn, &state.home, id, &name, "running", None, &triggers, &nodes, &checkpoint)?;
            }
            if let Some(app) = &app {
                let _ = app.emit("ronic://wf-progress", json!({ "id": id, "status": "running", "nodes": nodes }));
            }
            index += 1;
            continue;
        }

        nodes[index].status = "running".into();
        {
            let conn = guard(state);
            persist_workflow(&conn, &state.home, id, &name, "running", None, &triggers, &nodes, &checkpoint)?;
        }
        if let Some(app) = &app {
            let _ = app.emit("ronic://wf-progress", json!({ "id": id, "status": "running", "nodes": nodes }));
        }
        if !node_bot.trim().is_empty() {
            let resolved = {
                let conn = guard(state);
                resolve_bot_profile(&conn, &node_bot)
            };
            if let Some(bot_id) = resolved {
                let conn = guard(state);
                kv_set(&conn, "active_profile", &bot_id)?;
            }
        }
        let prompt = if node_prompt.trim().is_empty() {
            format!("Workflow step '{node_name}': {}", node_kind.replace('_', " "))
        } else {
            node_prompt.trim().to_string()
        };
        let provider_override = if node_model.starts_with("prov_") { Some(node_model.clone()) } else { None };
        let secrets = state.secrets.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let started = std::time::Instant::now();
        let outcome = crate::agent::dispatch(state, &prompt, &secrets, provider_override.as_deref(), None, None, &[]);
        let elapsed = started.elapsed().as_millis() as i64;
        match outcome {
            Ok(reply) => {
                nodes[index].status = "done".into();
                nodes[index].latency_ms = elapsed;
                let clipped: String = reply.chars().take(1200).collect();
                checkpoint.insert(node_id.clone(), json!(clipped));
            }
            Err(error) => {
                nodes[index].status = "error".into();
                nodes[index].latency_ms = elapsed;
                checkpoint.insert(node_id.clone(), json!(format!("error: {error}")));
                {
                    let conn = guard(state);
                    persist_workflow(&conn, &state.home, id, &name, "error", Some(&node_id), &triggers, &nodes, &checkpoint)?;
                    if let Some(original) = &original_profile {
                        kv_set(&conn, "active_profile", original)?;
                    }
                }
                if let Some(app) = &app {
                    let _ = app.emit("ronic://wf-progress", json!({ "id": id, "status": "error", "nodes": nodes }));
                }
                return Err(err(format!("step {node_id} failed: {error}. The workflow is paused there; fix the step and resume.")));
            }
        }
        {
            let conn = guard(state);
            persist_workflow(&conn, &state.home, id, &name, "running", None, &triggers, &nodes, &checkpoint)?;
        }
        if let Some(app) = &app {
            let _ = app.emit("ronic://wf-progress", json!({ "id": id, "status": "running", "nodes": nodes }));
        }
        index += 1;
    }
    {
        let conn = guard(state);
        persist_workflow(&conn, &state.home, id, &name, "completed", None, &triggers, &nodes, &checkpoint)?;
        if let Some(original) = &original_profile {
            kv_set(&conn, "active_profile", original)?;
        }
    }
    if let Some(app) = &app {
        let _ = app.emit("ronic://wf-progress", json!({ "id": id, "status": "completed", "nodes": nodes }));
    }
    Ok(format!("Workflow '{name}' completed. Every step ran through its assigned bot; outputs are on each step and in the chat."))
}

#[tauri::command]
pub async fn delete_workflow(state: State<'_, AppState>, id: String) -> Result<CommandResult> {
    {
        let conn = guard(&state);
        conn.execute("DELETE FROM workflows WHERE id=?1", params![id])?;
    }
    finish(&state, Some("Workflow deleted.".into()))
}

#[tauri::command]
pub async fn run_workflow(app: AppHandle, id: String) -> Result<CommandResult> {
    let handle = app.clone();
    let note = match tauri::async_runtime::spawn_blocking(move || {
        let state = handle.state::<AppState>();
        execute_workflow(&state, &id, false)
    })
    .await
    {
        Ok(result) => result?,
        Err(error) => return Err(err(format!("The workflow run stopped. {error}"))),
    };
    let state = app.state::<AppState>();
    finish(&state, Some(note))
}

fn write_workflow(home: &std::path::Path, id: &str, yaml: &str) -> Result<()> {
    let id = crate::util::safe_id_component(id)?;
    let dir = home.join("workflows");
    std::fs::create_dir_all(&dir)?;
    std::fs::write(dir.join(format!("{id}.workflow.yaml")), yaml)?;
    Ok(())
}

#[tauri::command]
pub async fn set_ide_agent(state: State<'_, AppState>, agent: String) -> Result<CommandResult> {
    {
        let conn = guard(&state);
        kv_set(&conn, "ide_agent", &agent)?;
    }
    finish(&state, None)
}

#[tauri::command]
pub async fn close_position(state: State<'_, AppState>, symbol: String) -> Result<CommandResult> {
    {
        let conn = guard(&state);
        conn.execute("UPDATE positions SET open=0, pnl_usd=0 WHERE symbol=?1", params![symbol])?;
    }
    finish(&state, Some("Sandbox position marked closed. No exchange order was sent.".into()))
}

#[tauri::command]
pub async fn reset_workspace(state: State<'_, AppState>, confirm: String) -> Result<CommandResult> {
    if confirm != "RESET" {
        return Err(err("type RESET to confirm"));
    }
    {
        let conn = guard(&state);
        db::reset_workspace(&conn, &state.home)?;
    }
    finish(&state, Some("Sandbox workspace reset.".into()))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectedHarness {
    pub id: String,
    pub name: String,
    pub category: String,       // "cli" | "ide" | "web" | "external_bot"
    pub icon: String,
    pub installed: bool,
    pub execution_mode: String, // "native_bin" | "wsl2_bin" | "webview" | "http_bridge"
    pub binary_or_url: String,
    pub version_info: String,
    pub connected: bool,
}

fn expand_env_vars(raw: &str) -> String {
    let mut out = raw.to_string();
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        out = out.replace("%LOCALAPPDATA%", &local);
    }
    if let Ok(appdata) = std::env::var("APPDATA") {
        out = out.replace("%APPDATA%", &appdata);
    }
    if let Ok(profile) = std::env::var("USERPROFILE") {
        out = out.replace("%USERPROFILE%", &profile);
    }
    out
}

fn harnesses_from_scan(report: &crate::models::ScanReport) -> Vec<DetectedHarness> {
    // scan_name is the label written by scan.rs. Display names stay aligned with that report.
    let catalog = [
        ("claude", "Claude Code", "cli", "CC"),
        ("gemini", "Gemini CLI", "cli", "GM"),
        ("codex", "Codex CLI", "cli", "CX"),
        ("aider", "Aider", "cli", "AI"),
        ("opencode", "OpenCode", "cli", "OC"),
        ("ollama", "Ollama", "cli", "OL"),
        ("cursor", "Cursor", "ide", "CU"),
        ("vscode", "VS Code", "ide", "VS"),
        ("obsidian", "Obsidian", "ide", "OB"),
        ("grokbot", "Grokbot", "external_bot", "GB"),
        ("muse", "Muse", "external_bot", "MU"),
        ("dots", "Dots", "external_bot", "DT"),
        ("hermes", "Hermes", "external_bot", "HE"),
        ("openclaw", "OpenClaw", "external_bot", "OW"),
    ];
    let mut results = Vec::new();
    for (id, name, category, icon) in catalog {
        let path = report
            .found
            .iter()
            .find(|hit| hit.name == name)
            .map(|hit| hit.path.clone())
            .unwrap_or_default();
        let installed = !path.is_empty();
        let mode = if path.starts_with("wsl:") {
            "wsl2_bin"
        } else if category == "external_bot" {
            "http_bridge"
        } else {
            "native_bin"
        };
        results.push(DetectedHarness {
            id: id.to_string(),
            name: name.to_string(),
            category: category.to_string(),
            icon: icon.to_string(),
            installed,
            execution_mode: mode.to_string(),
            binary_or_url: path.clone(),
            version_info: if installed {
                format!("Detected: {path}")
            } else {
                "Not detected on PATH / WSL2".to_string()
            },
            connected: installed,
        });
    }
    for (id, name, url, icon) in [
        ("chatgpt_web", "ChatGPT Plus / Pro (Web)", "https://chatgpt.com", "GP"),
        ("claude_web", "Claude Pro / Max (Web)", "https://claude.ai", "CL"),
        ("gemini_web", "Gemini Pro / Ultra (Web)", "https://gemini.google.com", "GM"),
        ("grok_web", "Grok Pro (Web)", "https://grok.com", "GK"),
    ] {
        results.push(DetectedHarness {
            id: id.to_string(),
            name: name.to_string(),
            category: "web".to_string(),
            icon: icon.to_string(),
            installed: true,
            execution_mode: "webview".to_string(),
            binary_or_url: url.to_string(),
            version_info: "Native Isolated WebView Ready".to_string(),
            connected: true,
        });
    }
    results
}

#[tauri::command]
pub async fn scan_all_harnesses(state: State<'_, AppState>) -> std::result::Result<Vec<DetectedHarness>, String> {
    let (found, missing, started) = crate::scan::discover();
    let conn = guard(&state);
    let report = crate::scan::commit(&conn, found, missing, started).map_err(|e| e.0)?;
    Ok(harnesses_from_scan(&report))
}

#[tauri::command]
pub async fn open_harness_window(
    app: AppHandle,
    state: State<'_, AppState>,
    provider_id: String,
    target_url: String,
) -> std::result::Result<String, String> {
    let safe_url = crate::util::normalize_harness_url(&target_url);
    let note = open_external_window(&app, &provider_id, &safe_url).map_err(|e| e.0)?;
    let conn = guard(&state);
    let kind: String = conn
        .query_row(
            "SELECT provider_type FROM provider_accounts WHERE id = ?1",
            params![provider_id],
            |row| row.get(0),
        )
        .unwrap_or_default();
    if kind == "isolated_webview" || kind == "official_oauth" {
        conn.execute(
            "UPDATE provider_accounts SET binary_or_endpoint = ?1, health_detail = 'Window opened. Sign in on that site. Chat inside Ronic OS still needs the API key.' WHERE id = ?2",
            params![safe_url, provider_id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(note)
}

#[tauri::command]
pub async fn launch_local_app(state: State<'_, AppState>, executable_path: String) -> std::result::Result<String, String> {
    let expanded = expand_env_vars(executable_path.trim());
    if expanded.is_empty() {
        return Err("No executable path configured.".into());
    }
    if expanded.starts_with("wsl:") {
        return Err("A WSL harness starts from the lane. This launcher opens a local file.".into());
    }
    if !std::path::Path::new(&expanded).is_file() {
        return Err(format!("File not found: {expanded}"));
    }
    let pid = crate::workspace_apps::launch_program(std::path::Path::new(&expanded)).map_err(|error| error.0)?;
    let stored: Option<i64> = if pid == 0 { None } else { Some(pid as i64) };
    let conn = guard(&state);
    let detail = if pid == 0 { "Opened.".to_string() } else { format!("Launched at pid {pid}.") };
    conn.execute(
        "UPDATE linked_local_apps SET active_pid = ?1, status = 'running', detail = ?2, updated_at = ?3 WHERE executable_path = ?4",
        params![stored, detail, now_ms(), expanded],
    )
    .map_err(|e| e.to_string())?;
    if pid == 0 {
        Ok(format!("Opened {expanded}."))
    } else {
        Ok(format!("Launched {expanded} at pid {pid}."))
    }
}

fn wsl_binary(path: &str) -> std::result::Result<&str, String> {
    let bin = path.trim_start_matches("wsl:");
    let simple = bin.starts_with('/')
        && bin.len() < 240
        && bin.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '.' | '_' | '-' | '+'));
    if simple {
        Ok(bin)
    } else {
        Err("WSL harness path must be a simple absolute path.".into())
    }
}

#[tauri::command]
pub async fn run_harness_prompt(binary_or_url: String, prompt: String) -> std::result::Result<String, String> {
    let prompt = prompt.trim().to_string();
    if prompt.is_empty() {
        return Err("Prompt is empty.".into());
    }
    if binary_or_url.starts_with("http://") || binary_or_url.starts_with("https://") {
        return Ok(format!(
            "Web session stays in its own window at {binary_or_url}. This command does not type into that page."
        ));
    }
    let args = ["-p", prompt.as_str()];
    let (code, out) = if binary_or_url.starts_with("wsl:") {
        if !crate::util::wsl_ready() {
            return Err("WSL2 is not installed, so this harness was not started.".into());
        }
        let bin = wsl_binary(&binary_or_url)?;
        run_capture("wsl.exe", &["-e", bin, "-p", &prompt], None, Duration::from_secs(120)).map_err(|e| e.0)?
    } else {
        let expanded = expand_env_vars(&binary_or_url);
        if !std::path::Path::new(&expanded).is_file() {
            return Err(format!("CLI binary was not found: {expanded}"));
        }
        run_capture(&expanded, &args, None, Duration::from_secs(120)).map_err(|e| e.0)?
    };
    let text = out.trim().to_string();
    if code == 0 {
        Ok(text)
    } else if text.is_empty() {
        Err(format!("CLI exited with status {code}"))
    } else {
        Err(text)
    }
}

#[tauri::command]
pub async fn installed_webapps(state: State<'_, AppState>) -> std::result::Result<Vec<String>, String> {
    let conn = guard(&state);
    Ok(crate::workspace_apps::installed_ids(&conn))
}

#[tauri::command]
pub async fn show_workspace_webapp(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    bounds: crate::workspace_apps::WebAppBounds,
    focus: bool,
    url: Option<String>,
    name: Option<String>,
) -> std::result::Result<crate::workspace_apps::WebAppStatus, String> {
    let home = state.home.clone();
    let already = {
        let conn = guard(&state);
        crate::workspace_apps::installed_ids(&conn).iter().any(|item| item == &id)
    };
    let opened = crate::workspace_apps::show(&app, &home, &id, bounds, focus, url.as_deref(), name.as_deref()).map_err(|error| error.0)?;
    let installed = {
        let conn = guard(&state);
        crate::workspace_apps::mark_installed(&conn, &id).map_err(|error| error.0)?
    };
    let signing_in = opened.signing_in.clone();
    let note = if let Some(message) = &signing_in {
        message.clone()
    } else if already {
        format!("{} is open inside Ronic OS and can use this workspace's skills, plugins, and memory.", opened.name)
    } else {
        format!("Installed {} in Ronic OS. It can use this workspace's skills, plugins, and memory.", opened.name)
    };
    Ok(crate::workspace_apps::WebAppStatus { note, installed, signing_in })
}

#[tauri::command]
pub async fn place_workspace_webapp(app: AppHandle, id: String, bounds: crate::workspace_apps::WebAppBounds) -> std::result::Result<(), String> {
    crate::workspace_apps::place(&app, &id, bounds).map_err(|error| error.0)
}

#[tauri::command]
pub async fn hide_workspace_webapps(app: AppHandle) -> std::result::Result<(), String> {
    crate::workspace_apps::hide_all(&app);
    Ok(())
}

#[tauri::command]
pub async fn show_page_browser(
    app: AppHandle,
    state: State<'_, AppState>,
    bounds: crate::workspace_apps::WebAppBounds,
    url: String,
    focus: bool,
) -> std::result::Result<crate::workspace_apps::PageView, String> {
    let home = state.home.clone();
    crate::workspace_apps::show_page(&app, &home, bounds, &url, focus).map_err(|error| error.0)
}

#[tauri::command]
pub async fn place_page_browser(app: AppHandle, bounds: crate::workspace_apps::WebAppBounds) -> std::result::Result<(), String> {
    crate::workspace_apps::place_page(&app, bounds).map_err(|error| error.0)
}

#[tauri::command]
pub async fn hide_page_browser(app: AppHandle) -> std::result::Result<(), String> {
    crate::workspace_apps::hide_page(&app);
    Ok(())
}

#[tauri::command]
pub async fn page_browser_go(app: AppHandle, action: String) -> std::result::Result<(), String> {
    crate::workspace_apps::page_action(&app, &action).map_err(|error| error.0)
}

#[tauri::command]
pub async fn show_bot_screen(
    app: AppHandle,
    state: State<'_, AppState>,
    bot_id: String,
    bounds: crate::workspace_apps::WebAppBounds,
    url: String,
) -> Result<CommandResult> {
    {
        let conn = guard(&state);
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM bot_profiles WHERE id=?1", params![&bot_id], |row| row.get(0))?;
        if n == 0 {
            return Err(err("profile not found"));
        }
    }
    let home = state.home.clone();
    let status = crate::bot_screen::show_column(&app, &home, &bot_id, bounds, &url, true)?;
    if status.refused {
        let payload = json!({ "showing": false, "refused": true, "url": status.url });
        return finish_payload(&state, Some("That local server is not running.".into()), Some(payload));
    }
    let app_for_read = app.clone();
    let id_for_read = bot_id.clone();
    let expected = status.url.clone();
    let hit = match tauri::async_runtime::spawn_blocking(move || crate::bot_screen::read_bot(&app_for_read, &id_for_read, Some(&expected))).await {
        Ok(Ok(hit)) => hit,
        _ => crate::bot_screen::ScreenHit::empty(&status.url),
    };
    {
        let conn = guard(&state);
        crate::bot_screen::store_screen(&conn, &bot_id, &hit.url, &hit.nodes, hit.ms)?;
    }
    let payload = json!({ "showing": true, "refused": false, "url": hit.url });
    let toast = if hit.nodes.is_empty() {
        "Opened this bot's browser.".into()
    } else {
        format!("Opened this bot's browser. {} controls.", hit.nodes.len())
    };
    finish_payload(&state, Some(toast), Some(payload))
}

#[tauri::command]
pub async fn reveal_bot_screen(
    app: AppHandle,
    state: State<'_, AppState>,
    bot_id: String,
    bounds: crate::workspace_apps::WebAppBounds,
    url: String,
) -> std::result::Result<crate::bot_screen::BotScreenStatus, String> {
    let home = state.home.clone();
    crate::bot_screen::reveal_column(&app, &home, &bot_id, bounds, &url).map_err(|error| error.0)
}

#[tauri::command]
pub async fn place_bot_screen(app: AppHandle, bounds: crate::workspace_apps::WebAppBounds) -> std::result::Result<(), String> {
    crate::bot_screen::place_column(&app, bounds).map_err(|error| error.0)
}

#[tauri::command]
pub async fn hide_bot_screens(app: AppHandle) -> std::result::Result<(), String> {
    crate::bot_screen::hide_column(&app);
    Ok(())
}

#[tauri::command]
pub async fn workspace_bridge_status() -> crate::workspace_bridge::BridgeStatus {
    crate::workspace_bridge::status()
}

#[tauri::command]
pub async fn launch_desktop_app(app: AppHandle, id: String, kind: Option<String>, path: Option<String>, name: Option<String>) -> Result<CommandResult> {
    let app_for_launch = app.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || crate::workspace_apps::launch_desktop(&app_for_launch, &id, kind.as_deref(), path.as_deref(), name.as_deref()))
        .await
        .map_err(|error| err(error.to_string()))??;
    let state = app.state::<AppState>();
    finish_with(&state, Some(outcome.note), outcome.install_choice)
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct BackupDestination {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub path: String,
    pub exists: bool,
    pub description: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct BackupWriteResult {
    pub success: bool,
    pub file_path: String,
    pub bytes_written: usize,
    pub sha256: String,
    pub timestamp: i64,
}

#[tauri::command]
pub async fn detect_backup_destinations() -> std::result::Result<Vec<BackupDestination>, String> {
    let mut dests = Vec::new();

    if let Ok(user_profile) = std::env::var("USERPROFILE") {
        let docs = std::path::Path::new(&user_profile).join("Documents").join("Ronic OS Memory Backups");
        dests.push(BackupDestination {
            id: "local_documents".into(),
            name: "Local Documents Folder".into(),
            kind: "documents".into(),
            path: docs.display().to_string(),
            exists: true,
            description: "Default protected local storage in your Documents folder".into(),
        });

        let onedrive_paths = [
            std::env::var("OneDrive").ok(),
            std::env::var("OneDriveConsumer").ok(),
            std::env::var("OneDriveCommercial").ok(),
            Some(format!("{}\\OneDrive", user_profile)),
        ];
        let mut seen_onedrive = false;
        for opt in onedrive_paths.into_iter().flatten() {
            let p = std::path::Path::new(&opt);
            if p.is_dir() && !seen_onedrive {
                seen_onedrive = true;
                let target = p.join("Ronic OS Memory Backups");
                dests.push(BackupDestination {
                    id: "cloud_onedrive".into(),
                    name: "Microsoft OneDrive".into(),
                    kind: "onedrive".into(),
                    path: target.display().to_string(),
                    exists: true,
                    description: "Synced automatically to your Microsoft OneDrive cloud vault".into(),
                });
            }
        }

        let dropbox_path = std::path::Path::new(&user_profile).join("Dropbox");
        if dropbox_path.is_dir() {
            let target = dropbox_path.join("Ronic OS Memory Backups");
            dests.push(BackupDestination {
                id: "cloud_dropbox".into(),
                name: "Dropbox".into(),
                kind: "dropbox".into(),
                path: target.display().to_string(),
                exists: true,
                description: "Synced to your local Dropbox folder".into(),
            });
        }

        let icloud_path = std::path::Path::new(&user_profile).join("iCloudDrive");
        if icloud_path.is_dir() {
            let target = icloud_path.join("Ronic OS Memory Backups");
            dests.push(BackupDestination {
                id: "cloud_iclouddrive".into(),
                name: "iCloud Drive".into(),
                kind: "cloud".into(),
                path: target.display().to_string(),
                exists: true,
                description: "Synced to your iCloud Drive storage".into(),
            });
        }
    }

    #[cfg(windows)]
    {
        extern "system" {
            fn GetDriveTypeW(lpRootPathName: *const u16) -> u32;
            fn GetVolumeInformationW(
                lpRootPathName: *const u16,
                lpVolumeNameBuffer: *mut u16,
                nVolumeNameSize: u32,
                lpVolumeSerialNumber: *mut u32,
                lpMaximumComponentLength: *mut u32,
                lpFileSystemFlags: *mut u32,
                lpFileSystemNameBuffer: *mut u16,
                nFileSystemNameSize: u32,
            ) -> i32;
        }

        for ch in 'D'..='Z' {
            let root_str = format!("{}:\\", ch);
            let wide_path: Vec<u16> = root_str.encode_utf16().chain(std::iter::once(0)).collect();
            let dtype = unsafe { GetDriveTypeW(wide_path.as_ptr()) };

            if dtype >= 2 && dtype <= 4 {
                let mut vol_buf = [0u16; 260];
                let mut fs_buf = [0u16; 260];
                let success = unsafe {
                    GetVolumeInformationW(
                        wide_path.as_ptr(),
                        vol_buf.as_mut_ptr(),
                        vol_buf.len() as u32,
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                        fs_buf.as_mut_ptr(),
                        fs_buf.len() as u32,
                    )
                };

                let vol_name = if success != 0 {
                    let len = vol_buf.iter().position(|&c| c == 0).unwrap_or(vol_buf.len());
                    String::from_utf16_lossy(&vol_buf[..len]).trim().to_string()
                } else {
                    String::new()
                };

                let is_gdrive = vol_name.to_lowercase().contains("google drive")
                    || std::path::Path::new(&format!("{}:\\My Drive", ch)).is_dir();

                if is_gdrive {
                    let path = if std::path::Path::new(&format!("{}:\\My Drive", ch)).is_dir() {
                        format!("{}:\\My Drive\\Ronic OS Memory Backups", ch)
                    } else {
                        format!("{}:\\Ronic OS Memory Backups", ch)
                    };
                    let display_label = if vol_name.is_empty() {
                        format!("Google Drive ({}:)", ch)
                    } else {
                        format!("Google Drive - {} ({}:)", vol_name, ch)
                    };
                    dests.push(BackupDestination {
                        id: format!("googledrive_{}", ch),
                        name: display_label,
                        kind: "googledrive".into(),
                        path,
                        exists: true,
                        description: "Connected Google Drive virtual drive on this system".into(),
                    });
                } else if dtype == 2 {
                    let display_label = if vol_name.is_empty() {
                        format!("USB Removable Drive ({}:)", ch)
                    } else {
                        format!("USB [{}] ({}:)", vol_name, ch)
                    };
                    dests.push(BackupDestination {
                        id: format!("removable_{}", ch),
                        name: display_label,
                        kind: "removable".into(),
                        path: format!("{}:\\Ronic_Memory_Backups", ch),
                        exists: true,
                        description: "Removable USB Flash Drive, Pen Drive, or SD Card".into(),
                    });
                } else if dtype == 3 {
                    let display_label = if vol_name.is_empty() {
                        format!("Secondary Storage ({}:)", ch)
                    } else {
                        format!("External Drive [{}] ({}:)", vol_name, ch)
                    };
                    dests.push(BackupDestination {
                        id: format!("external_{}", ch),
                        name: display_label,
                        kind: "external_drive".into(),
                        path: format!("{}:\\Ronic_Memory_Backups", ch),
                        exists: true,
                        description: "External SSD or secondary drive partition".into(),
                    });
                }
            }
        }
    }

    Ok(dests)
}

#[tauri::command]
pub async fn write_backup_to_path(
    target_dir: String,
    filename: String,
    content: String,
) -> std::result::Result<BackupWriteResult, String> {
    use sha2::{Digest, Sha256};
    use std::io::Write;

    let dir_path = std::path::Path::new(target_dir.trim());
    if let Err(e) = std::fs::create_dir_all(dir_path) {
        return Err(format!("Could not create backup directory '{}': {}", dir_path.display(), e));
    }

    // The filename must stay a bare name inside the chosen directory: an
    // absolute path or a `..` segment would otherwise escape it entirely.
    let safe_name: String = filename
        .trim()
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' })
        .collect();
    if safe_name.trim_matches('.').is_empty() || safe_name.contains("..") {
        return Err("Invalid backup filename".to_string());
    }
    let file_path = dir_path.join(&safe_name);
    let mut file = match std::fs::File::create(&file_path) {
        Ok(f) => f,
        Err(e) => return Err(format!("Could not create file '{}': {}", file_path.display(), e)),
    };

    let bytes = content.as_bytes();
    if let Err(e) = file.write_all(bytes) {
        return Err(format!("Failed writing to backup file: {}", e));
    }
    if let Err(e) = file.flush() {
        return Err(format!("Failed flushing backup file: {}", e));
    }

    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let hash_result = hasher.finalize();
    let sha256_hex = format!("{:x}", hash_result);

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    Ok(BackupWriteResult {
        success: true,
        file_path: file_path.display().to_string(),
        bytes_written: bytes.len(),
        sha256: sha256_hex,
        timestamp: now,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn duplicate_names_get_numbered_handles_instead_of_failing() {
        let conn = Connection::open_in_memory().unwrap();
        db::migrate(&conn).unwrap();
        assert_eq!(unique_handle(&conn, "Scout"), "@Scout");
        conn.execute(
            "INSERT INTO bot_profiles (id, handle, display_name, avatar, soul_markdown, primary_account_id, long_context_account_id, fallback_account_id, created_at) VALUES ('b1','@Scout','Scout','','','prov_ollama','','',1)",
            [],
        )
        .unwrap();
        assert_eq!(unique_handle(&conn, "Scout"), "@Scout-1");
        assert_eq!(unique_handle(&conn, "@Scout"), "@Scout-1");
        assert_eq!(unique_handle(&conn, "Other"), "@Other");
    }

    #[test]
    fn avatar_color_column_exists_after_migration() {
        let conn = Connection::open_in_memory().unwrap();
        db::migrate(&conn).unwrap();
        let names: Vec<String> = conn
            .prepare("PRAGMA table_info(bot_profiles)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .flatten()
            .collect();
        assert!(names.iter().any(|name| name == "avatar_color"));
    }
}
