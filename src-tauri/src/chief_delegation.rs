//! Chief Officer delegation.
//!
//! A chief can assign work to any other bot. A group manager can assign work
//! only to members of that group. Contracts stay in progress until the owner
//! attests them. The stored commitment is a SHA-256 of the scoped sub-goal.

use crate::db::{kv_get, kv_set};
use crate::error::{err, Result};
use crate::models::{CommandResult, DelegationContract, DelegationReport};
use crate::util::{nid, now_ms};
use crate::AppState;
use rusqlite::{params, Connection};
use serde_json::json;
use sha2::{Digest, Sha256};
use tauri::State;

const CHIEF_KEY: &str = "chief_bot_id";
const VERIFIER: &str = "The owner attests this sub-goal is done. It stays in progress until then.";
const HEAVY: &[&str] = &["refactor", "audit", "security", "payroll", "architecture", "migrate", "concurrency", "race", "ledger", "invariant"];
const MEDIUM: &[&str] = &["test", "verify", "patch", "fix", "bug", "implement", "review"];
const LIGHT: &[&str] = &["format", "csv", "json", "rename", "summary", "summarize", "list", "reformat"];
const OR_VERBS: &[&str] = &["lock", "convert", "send", "pay", "patch", "skip", "approve", "reject", "delete", "transfer", "withdraw", "rebalance", "merge"];

#[derive(Clone)]
pub struct BotRef {
    pub id: String,
    pub handle: String,
    pub role: String,
    pub soul: String,
    pub allow_computer_use: bool,
    pub allow_browser_use: bool,
    pub allow_code_exec: bool,
    pub allow_file_write: bool,
    pub primary_account_id: String,
    pub long_context_account_id: String,
    pub fallback_account_id: String,
}

#[derive(Clone)]
pub struct GroupRef {
    pub id: String,
    pub handle: String,
    pub name: String,
    pub manager_id: String,
    pub member_ids: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct PlannedContract {
    pub assignee_id: String,
    pub sub_goal: String,
    pub complexity: i64,
    pub routed_endpoint: String,
    pub cost_tier: String,
    pub scopes: Vec<String>,
    pub verifier_rule: String,
    pub requires_human: bool,
    pub status: String,
    pub friction_reason: String,
}

#[derive(Debug)]
pub struct PlanOutcome {
    pub scope_label: String,
    pub plans: Vec<PlannedContract>,
}

pub struct DispatchOutcome {
    pub toast: String,
    pub card: String,
    pub contract_ids: Vec<String>,
}

#[derive(Clone)]
pub struct CardRow {
    pub issuer_handle: String,
    pub assignee_handle: String,
    pub sub_goal: String,
    pub status: String,
    pub cost_tier: String,
    pub routed_endpoint: String,
    pub commitment: String,
    pub friction_reason: String,
    pub scopes: Vec<String>,
}

#[derive(Debug)]
pub struct MobileRoute {
    pub issuer_id: String,
    pub group_id: String,
    pub objective: String,
    pub scope_label: String,
}

#[derive(Debug)]
pub enum PhoneCallback {
    Attest(String),
    Resolve { id: String, note: String },
}

pub fn score_complexity(text: &str) -> i64 {
    let lower = text.to_lowercase();
    let heavy_hits = HEAVY.iter().filter(|word| lower.contains(*word)).count();
    let medium = MEDIUM.iter().any(|word| lower.contains(*word));
    let light = LIGHT.iter().any(|word| lower.contains(*word));
    let mut score: i64 = 20;
    if heavy_hits > 0 {
        score += 30;
    }
    if heavy_hits >= 2 {
        score += 20;
    }
    if medium {
        score += 15;
    }
    if light && heavy_hits == 0 {
        score -= 15;
    }
    if text.chars().count() > 180 {
        score += 8;
    }
    score.clamp(1, 100)
}

pub fn friction_reason(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.chars().count() < 12 {
        return Some("Objective is too short to grade. Say what finished work looks like.".into());
    }
    let lower = trimmed.to_lowercase();
    if has_or_choice(&lower) {
        return Some("The objective offers two actions. Name one before a bot runs it.".into());
    }
    if currency_kinds(&lower) >= 2 && !has_rate_instruction(&lower) {
        return Some("Two currencies are named and no rate or lock is specified.".into());
    }
    if asks_to_move_money(&lower) {
        return Some("This asks a bot to move money. Confirm the amount in the workspace before it runs.".into());
    }
    None
}

pub fn split_clauses(text: &str) -> Vec<String> {
    let mut clauses = Vec::new();
    for line in text.split(['\n', '\r', ';']) {
        for part in split_and(line) {
            let part = part.trim();
            if !part.is_empty() {
                clauses.push(part.to_string());
            }
        }
    }
    clauses.truncate(8);
    clauses
}

pub fn verify_delegation_authority(issuer_id: &str, is_chief: bool, assignee_id: &str, group: Option<&GroupRef>) -> std::result::Result<(), String> {
    if assignee_id.trim().is_empty() {
        return Err("Missing assignee.".into());
    }
    if is_chief {
        return Ok(());
    }
    let group = group.ok_or_else(|| format!("AUTHORITY DENIED: {issuer_id} is not the chief officer and no group was given."))?;
    if group.manager_id != issuer_id {
        return Err(format!("AUTHORITY DENIED: this bot is not the manager of {}.", group.name));
    }
    if !group.member_ids.iter().any(|id| id == assignee_id) {
        return Err(format!("SCOPE VIOLATION: the manager of {} can only assign bots in that group.", group.name));
    }
    Ok(())
}

pub fn route_account(score: i64, bot: &BotRef) -> (String, String) {
    if score < 35 {
        (nonempty(&bot.fallback_account_id, &bot.primary_account_id), "lightweight".into())
    } else if score < 70 {
        (nonempty(&bot.primary_account_id, &bot.fallback_account_id), "balanced".into())
    } else {
        (nonempty(&bot.long_context_account_id, &bot.primary_account_id), "heavy".into())
    }
}

pub fn scopes_for(bot: &BotRef) -> Vec<String> {
    let mut scopes = vec!["read:assigned_subgoal".into(), "deny:vault_secrets".into(), "deny:wallet_spend".into()];
    if bot.allow_code_exec {
        scopes.push("exec:code".into());
    }
    if bot.allow_browser_use {
        scopes.push("use:browser".into());
    }
    if bot.allow_computer_use {
        scopes.push("use:computer".into());
    }
    if bot.allow_file_write {
        scopes.push("write:bot_workspace".into());
    }
    scopes
}

pub fn execution_commitment(contract_id: &str, sub_goal: &str, scopes: &[String]) -> String {
    let mut payload = String::new();
    payload.push_str("ronic-delegation-v1\n");
    payload.push_str(contract_id);
    payload.push('\n');
    payload.push_str(sub_goal);
    payload.push('\n');
    for scope in scopes {
        payload.push_str(scope);
        payload.push('\n');
    }
    let digest = Sha256::digest(payload.as_bytes());
    format!("commit_sha256:{digest:x}")
}

pub fn plan_delegation(objective: &str, issuer_id: &str, chief_id: &str, group: Option<&GroupRef>, bots: &[BotRef]) -> std::result::Result<PlanOutcome, String> {
    let text = objective.trim();
    if text.is_empty() {
        return Err("Write an objective first.".into());
    }
    if text.chars().count() > 4000 {
        return Err("That objective is too long.".into());
    }
    let scoped = group.is_some();
    if !scoped && chief_id.is_empty() {
        return Err("Appoint a chief officer first.".into());
    }
    if !scoped && issuer_id != chief_id {
        return Err("Only the chief officer can delegate across the workspace.".into());
    }
    if let Some(group) = group {
        if group.manager_id != issuer_id {
            return Err(format!("AUTHORITY DENIED: this bot is not the manager of {}.", group.name));
        }
    }
    if !bots.iter().any(|bot| bot.id == issuer_id) {
        return Err("That bot does not exist.".into());
    }

    let candidates: Vec<&BotRef> = if let Some(group) = group {
        bots.iter().filter(|bot| group.member_ids.iter().any(|id| id == &bot.id)).collect()
    } else {
        bots.iter().filter(|bot| bot.id != issuer_id).collect()
    };
    if candidates.is_empty() {
        return Err(if scoped { "This group has no member bots.".into() } else { "The chief needs at least one other bot to delegate to.".into() });
    }
    for bot in &candidates {
        verify_delegation_authority(issuer_id, !scoped, &bot.id, group)?;
    }

    let whole = friction_reason(text);
    let clauses = if whole.is_some() { vec![text.to_string()] } else { split_clauses(text) };
    if clauses.is_empty() {
        return Err("Write an objective first.".into());
    }
    let assigned = assign_clauses(&clauses, &candidates);
    let scope_label = group.map(|item| format!("GROUP: {}", item.name)).unwrap_or_else(|| "GLOBAL".into());
    let plans = assigned
        .into_iter()
        .map(|(clause, bot)| {
            let reason = friction_reason(&clause);
            let complexity = score_complexity(&clause);
            let (endpoint, tier) = route_account(complexity, bot);
            PlannedContract {
                assignee_id: bot.id.clone(),
                sub_goal: clause.clone(),
                complexity,
                routed_endpoint: if endpoint.is_empty() { "unassigned".into() } else { endpoint },
                cost_tier: tier,
                scopes: scopes_for(bot),
                verifier_rule: VERIFIER.into(),
                requires_human: reason.is_some() || needs_human(&clause),
                status: if reason.is_some() { "friction_challenged".into() } else { "in_progress".into() },
                friction_reason: reason.unwrap_or_default(),
            }
        })
        .collect::<Vec<_>>();
    Ok(PlanOutcome { scope_label, plans })
}

pub fn delegation_toast(plans: &[PlannedContract]) -> String {
    let noun = if plans.len() == 1 { "contract" } else { "contracts" };
    let waiting = plans.iter().filter(|plan| plan.status == "friction_challenged").count();
    if waiting > 0 {
        format!("Delegated {} {noun}. {waiting} need a decision before they run.", plans.len())
    } else {
        format!("Delegated {} {noun}. They stay in progress until you attest them.", plans.len())
    }
}

pub fn route_mobile(text: &str, chief_id: &str, groups: &[GroupRef], bots: &[BotRef]) -> std::result::Result<MobileRoute, String> {
    let trimmed = text.trim();
    let trimmed = trimmed.strip_prefix("/chief").map(str::trim).unwrap_or(trimmed);
    if trimmed.is_empty() {
        return Err("Write an objective first.".into());
    }
    let first = trimmed.split_whitespace().next().unwrap_or("");
    let rest = trimmed[first.len()..].trim();
    if first.starts_with('#') {
        let group = find_group(first, groups).ok_or_else(|| format!("No group matches {first}."))?;
        let objective = if rest.is_empty() { trimmed.to_string() } else { rest.to_string() };
        return Ok(MobileRoute { issuer_id: group.manager_id.clone(), group_id: group.id.clone(), objective, scope_label: format!("GROUP: {}", group.name) });
    }
    if first.starts_with('@') {
        let bot = bots.iter().find(|item| same_handle(&item.handle, first)).ok_or_else(|| format!("No bot matches {first}."))?;
        let led: Vec<&GroupRef> = groups.iter().filter(|group| group.manager_id == bot.id).collect();
        if let Some(group) = led.first() {
            return Ok(MobileRoute {
                issuer_id: bot.id.clone(),
                group_id: group.id.clone(),
                objective: if rest.is_empty() { trimmed.to_string() } else { rest.to_string() },
                scope_label: format!("GROUP: {}", group.name),
            });
        }
        if bot.id == chief_id {
            return Ok(MobileRoute { issuer_id: chief_id.to_string(), group_id: String::new(), objective: if rest.is_empty() { trimmed.to_string() } else { rest.to_string() }, scope_label: "GLOBAL".into() });
        }
        return Err("That bot is not the chief officer or a group manager.".into());
    }
    if chief_id.is_empty() {
        return Err("Appoint a chief officer before sending a workspace command.".into());
    }
    Ok(MobileRoute { issuer_id: chief_id.to_string(), group_id: String::new(), objective: trimmed.to_string(), scope_label: "GLOBAL".into() })
}

pub fn authorize_mobile(connected: bool, channel_id: &str, stored_owner: &str, sender_id: &str) -> std::result::Result<(), String> {
    if !connected {
        return Err(format!("BLOCKED: Messaging channel '{channel_id}' is not connected. Connect it first."));
    }
    if stored_owner.trim().is_empty() {
        return Err("BLOCKED: This channel has no allowlisted owner. Connect it again and set an owner id.".into());
    }
    if sender_id.trim() != stored_owner.trim() {
        return Err("UNAUTHORIZED: Sender ID does not match the allowlisted owner.".into());
    }
    Ok(())
}

pub fn parse_callback(callback: &str) -> std::result::Result<PhoneCallback, String> {
    let raw = callback.trim();
    if let Some(rest) = raw.strip_prefix("attest:") {
        let id = rest.trim();
        if id.is_empty() {
            return Err("Missing contract id.".into());
        }
        return Ok(PhoneCallback::Attest(id.to_string()));
    }
    if let Some(rest) = raw.strip_prefix("resolve:") {
        let (id, note) = rest.split_once(':').unwrap_or((rest, ""));
        let id = id.trim();
        let note = note.trim();
        if id.is_empty() || note.chars().count() < 8 {
            return Err("A resolve callback needs a contract id and a clarification.".into());
        }
        return Ok(PhoneCallback::Resolve { id: id.to_string(), note: note.to_string() });
    }
    Err("That phone button is not a delegation action.".into())
}

pub fn executive_card(commander: &str, scope: &str, objective: &str, rows: &[CardRow]) -> String {
    let mut lines = vec![
        "RONIC OS — Executive report".to_string(),
        format!("Commander: {commander}"),
        format!("Scope: {scope}"),
        format!("Objective: {objective}"),
        String::new(),
    ];
    for (index, row) in rows.iter().enumerate() {
        lines.push(format!("{}. {} → {}", index + 1, row.issuer_handle, row.assignee_handle));
        lines.push(format!("   {}", row.sub_goal));
        lines.push(format!("   Status: {} · {} · {}", row.status, row.cost_tier, row.routed_endpoint));
        lines.push(format!("   Commitment: {}", row.commitment));
        lines.push(format!("   Permissions: {}", row.scopes.join(", ")));
        if !row.friction_reason.is_empty() {
            lines.push(format!("   Needs a decision: {}", row.friction_reason));
        }
    }
    let waiting = rows.iter().filter(|row| row.status == "friction_challenged").count();
    let open = rows.iter().filter(|row| row.status == "in_progress").count();
    lines.push(String::new());
    lines.push(format!("{open} in progress, {waiting} waiting on you. Nothing is marked done until you attest it."));
    let card = lines.join("\n");
    if card.chars().count() > 3500 {
        let mut cut = String::new();
        for ch in card.chars().take(3400) {
            cut.push(ch);
        }
        cut.push_str("\n…");
        cut
    } else {
        card
    }
}

pub fn load_view(conn: &Connection) -> Result<(String, Vec<DelegationContract>, Vec<DelegationReport>)> {
    let chief = kv_get(conn, CHIEF_KEY)?.unwrap_or_default();
    let contracts = load_contracts(conn)?;
    let reports = load_reports(conn)?;
    Ok((chief, contracts, reports))
}

pub fn appoint_chief(conn: &Connection, bot_id: &str) -> Result<String> {
    let bot_id = bot_id.trim();
    if bot_id.is_empty() {
        kv_set(conn, CHIEF_KEY, "")?;
        return Ok("Chief officer cleared.".into());
    }
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM bot_profiles WHERE id=?1", params![bot_id], |row| row.get(0))?;
    if count == 0 {
        return Err(err("That bot does not exist."));
    }
    kv_set(conn, CHIEF_KEY, bot_id)?;
    Ok("Chief officer saved.".into())
}

pub fn dispatch(conn: &Connection, issuer_id: &str, group_id: &str, objective: &str) -> Result<DispatchOutcome> {
    let bots = load_bots(conn)?;
    let groups = load_groups(conn)?;
    let chief_id = kv_get(conn, CHIEF_KEY)?.unwrap_or_default();
    let group = if group_id.trim().is_empty() {
        None
    } else {
        Some(groups.iter().find(|group| group.id == group_id).cloned().ok_or_else(|| err("Group not found."))?)
    };
    let planned = plan_delegation(objective, issuer_id, &chief_id, group.as_ref(), &bots).map_err(err)?;
    let issuer_handle = handle_of(&bots, issuer_id);
    let now = now_ms();
    let tx = conn.unchecked_transaction()?;
    let mut ids = Vec::new();
    let mut rows = Vec::new();
    for plan in &planned.plans {
        let id = nid("ctr");
        let commitment = execution_commitment(&id, &plan.sub_goal, &plan.scopes);
        let scopes_json = serde_json::to_string(&plan.scopes)?;
        let group_key = group.as_ref().map(|item| item.id.as_str()).unwrap_or("");
        tx.execute(
            "INSERT INTO delegation_contracts (id, issuer_bot_id, assignee_bot_id, group_id, scope_label, sub_goal, complexity_score, routed_endpoint, cost_tier, scopes_json, verifier_rule, requires_human, status, commitment, friction_reason, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?16)",
            params![id, issuer_id, plan.assignee_id, group_key, planned.scope_label, plan.sub_goal, plan.complexity, plan.routed_endpoint, plan.cost_tier, scopes_json, plan.verifier_rule, if plan.requires_human { 1 } else { 0 }, plan.status, commitment, plan.friction_reason, now],
        )?;
        let summary = if plan.status == "friction_challenged" {
            plan.friction_reason.clone()
        } else {
            format!("Assigned to {}. Status: in progress. Route: {} via {}.", handle_of(&bots, &plan.assignee_id), plan.cost_tier, plan.routed_endpoint)
        };
        let report_type = if plan.status == "friction_challenged" { "cognitive_friction_challenge" } else { "delegated" };
        let (from_bot, to_bot) = if plan.status == "friction_challenged" { (plan.assignee_id.as_str(), issuer_id) } else { (issuer_id, plan.assignee_id.as_str()) };
        insert_report(&tx, &id, from_bot, to_bot, report_type, &summary, &commitment, now)?;
        ids.push(id);
        rows.push(CardRow {
            issuer_handle: issuer_handle.clone(),
            assignee_handle: handle_of(&bots, &plan.assignee_id),
            sub_goal: plan.sub_goal.clone(),
            status: plan.status.clone(),
            cost_tier: plan.cost_tier.clone(),
            routed_endpoint: plan.routed_endpoint.clone(),
            commitment,
            friction_reason: plan.friction_reason.clone(),
            scopes: plan.scopes.clone(),
        });
    }
    tx.commit()?;
    let card = executive_card(&issuer_handle, &planned.scope_label, objective.trim(), &rows);
    Ok(DispatchOutcome { toast: delegation_toast(&planned.plans), card, contract_ids: ids })
}

pub fn resolve_friction(conn: &Connection, contract_id: &str, note: &str) -> Result<String> {
    let note = note.trim();
    if note.chars().count() < 8 {
        return Err(err("Add a clarification of at least 8 characters."));
    }
    let current = load_contract(conn, contract_id)?;
    if current.status != "friction_challenged" {
        return Err(err("That contract is not waiting on a decision."));
    }
    let now = now_ms();
    if let Some(reason) = friction_reason(note) {
        conn.execute("UPDATE delegation_contracts SET friction_reason=?1, updated_at=?2 WHERE id=?3", params![reason, now, contract_id])?;
        insert_report(conn, contract_id, &current.assignee_bot_id, &current.issuer_bot_id, "cognitive_friction_challenge", &reason, &current.commitment, now)?;
        return Ok(format!("Still waiting on a decision: {reason}"));
    }
    let sub_goal = format!("{} Clarification: {note}", current.sub_goal);
    let commitment = execution_commitment(contract_id, &sub_goal, &current.scopes);
    let human = needs_human(note);
    conn.execute(
        "UPDATE delegation_contracts SET sub_goal=?1, status='in_progress', friction_reason='', commitment=?2, requires_human=?3, updated_at=?4 WHERE id=?5",
        params![sub_goal, commitment, if human { 1 } else { 0 }, now, contract_id],
    )?;
    insert_report(conn, contract_id, &current.issuer_bot_id, &current.assignee_bot_id, "friction_resolved", note, &commitment, now)?;
    Ok("Clarification saved. The contract is in progress.".into())
}

pub fn attest_contract(conn: &Connection, contract_id: &str, note: &str) -> Result<String> {
    let note = note.trim();
    if note.chars().count() < 8 {
        return Err(err("Add a note of at least 8 characters."));
    }
    let current = load_contract(conn, contract_id)?;
    if current.status != "in_progress" {
        return Err(err("Attest a contract only after it is in progress."));
    }
    let now = now_ms();
    conn.execute("UPDATE delegation_contracts SET status='verified_complete', updated_at=?1 WHERE id=?2", params![now, contract_id])?;
    insert_report(conn, contract_id, &current.issuer_bot_id, &current.assignee_bot_id, "owner_attestation", note, &current.commitment, now)?;
    Ok("Attested. The contract is marked done by you.".into())
}

pub fn contract_card(conn: &Connection, contract_id: &str) -> Result<String> {
    let contract = load_contract(conn, contract_id)?;
    let bots = load_bots(conn)?;
    let row = CardRow {
        issuer_handle: handle_of(&bots, &contract.issuer_bot_id),
        assignee_handle: handle_of(&bots, &contract.assignee_bot_id),
        sub_goal: contract.sub_goal.clone(),
        status: contract.status.clone(),
        cost_tier: contract.cost_tier.clone(),
        routed_endpoint: contract.routed_endpoint.clone(),
        commitment: contract.commitment.clone(),
        friction_reason: contract.friction_reason.clone(),
        scopes: contract.scopes.clone(),
    };
    let commander = row.issuer_handle.clone();
    Ok(executive_card(&commander, &contract.scope_label, &contract.sub_goal, &[row]))
}

#[tauri::command]
pub async fn appoint_chief_officer(state: State<'_, AppState>, bot_id: String) -> Result<CommandResult> {
    let toast = {
        let conn = crate::commands::guard(&state);
        appoint_chief(&conn, &bot_id)?
    };
    crate::commands::finish(&state, Some(toast))
}

#[tauri::command]
pub async fn dispatch_delegation(state: State<'_, AppState>, issuer_bot_id: String, group_id: String, objective: String) -> Result<CommandResult> {
    let outcome = {
        let conn = crate::commands::guard(&state);
        dispatch(&conn, &issuer_bot_id, &group_id, &objective)?
    };
    crate::commands::finish_payload(&state, Some(outcome.toast), Some(json!({ "card": outcome.card, "contractIds": outcome.contract_ids })))
}

#[tauri::command]
pub async fn resolve_delegation_friction(state: State<'_, AppState>, contract_id: String, note: String) -> Result<CommandResult> {
    let toast = {
        let conn = crate::commands::guard(&state);
        resolve_friction(&conn, &contract_id, &note)?
    };
    crate::commands::finish(&state, Some(toast))
}

#[tauri::command]
pub async fn attest_delegation_contract(state: State<'_, AppState>, contract_id: String, note: String) -> Result<CommandResult> {
    let toast = {
        let conn = crate::commands::guard(&state);
        attest_contract(&conn, &contract_id, &note)?
    };
    crate::commands::finish(&state, Some(toast))
}

#[tauri::command]
pub async fn handle_mobile_chief_command(
    state: State<'_, AppState>,
    gateway: State<'_, std::sync::Arc<crate::gateway_connections::GatewayManager>>,
    channel_id: String,
    sender_id: String,
    chat_id: String,
    text: String,
    callback: String,
) -> Result<CommandResult> {
    let mgr = gateway.inner();
    let connected = mgr.is_connected(&channel_id);
    let owner = mgr.stored_owner(&channel_id);
    authorize_mobile(connected, &channel_id, &owner, &sender_id).map_err(err)?;
    let chat = if chat_id.trim().is_empty() { sender_id.trim().to_string() } else { chat_id.trim().to_string() };

    let (toast, card, ids) = if callback.trim().is_empty() {
        let outcome = {
            let conn = crate::commands::guard(&state);
            let bots = load_bots(&conn)?;
            let groups = load_groups(&conn)?;
            let chief_id = kv_get(&conn, CHIEF_KEY)?.unwrap_or_default();
            let route = route_mobile(&text, &chief_id, &groups, &bots).map_err(err)?;
            dispatch(&conn, &route.issuer_id, &route.group_id, &route.objective)?
        };
        (outcome.toast, outcome.card, outcome.contract_ids)
    } else {
        let parsed = parse_callback(&callback).map_err(err)?;
        let (toast, id) = {
            let conn = crate::commands::guard(&state);
            match parsed {
                PhoneCallback::Attest(id) => {
                    let toast = attest_contract(&conn, &id, "Confirmed from the connected phone by the allowlisted owner.")?;
                    (toast, id)
                }
                PhoneCallback::Resolve { id, note } => {
                    let toast = resolve_friction(&conn, &id, &note)?;
                    (toast, id)
                }
            }
        };
        let card = {
            let conn = crate::commands::guard(&state);
            contract_card(&conn, &id).unwrap_or_else(|_| toast.clone())
        };
        (toast, card, vec![id])
    };

    let mut delivered = false;
    let mut delivery_error = String::new();
    match crate::gateway_connections::deliver_plain_text(mgr, &channel_id, &chat, &card).await {
        Ok(_) => delivered = true,
        Err(error) => delivery_error = error,
    }
    if delivered && channel_id == "telegram" {
        let buttons = telegram_attest_buttons(&ids, state.inner());
        if !buttons.is_empty() {
            if let Err(error) = crate::gateway_connections::deliver_telegram_buttons(mgr, &chat, "Confirm a contract only after the work is done.", buttons).await {
                if delivery_error.is_empty() {
                    delivery_error = error;
                }
            }
        }
    }
    let payload = json!({
        "card": card,
        "delivered": delivered,
        "deliveryError": if delivery_error.is_empty() { serde_json::Value::Null } else { json!(delivery_error) },
        "contractIds": ids,
    });
    crate::commands::finish_payload(&state, Some(toast), Some(payload))
}

fn telegram_attest_buttons(ids: &[String], state: &AppState) -> Vec<(String, String)> {
    let conn = state.conn.lock().unwrap_or_else(|error| error.into_inner());
    ids.iter()
        .filter_map(|id| load_contract(&conn, id).ok())
        .filter(|contract| contract.status == "in_progress")
        .take(4)
        .map(|contract| {
            let suffix: String = contract.id.chars().skip(4).take(6).collect();
            (format!("Confirm done {suffix}"), format!("attest:{}", contract.id))
        })
        .collect()
}

fn load_contracts(conn: &Connection) -> Result<Vec<DelegationContract>> {
    let mut stmt = conn.prepare("SELECT id, issuer_bot_id, assignee_bot_id, group_id, scope_label, sub_goal, complexity_score, routed_endpoint, cost_tier, scopes_json, verifier_rule, requires_human, status, commitment, friction_reason, created_at, updated_at FROM delegation_contracts ORDER BY created_at DESC LIMIT 40")?;
    let rows = stmt.query_map([], |row| {
        let scopes_raw: String = row.get(9)?;
        Ok(DelegationContract {
            id: row.get(0)?,
            issuer_bot_id: row.get(1)?,
            assignee_bot_id: row.get(2)?,
            group_id: row.get(3)?,
            scope_label: row.get(4)?,
            sub_goal: row.get(5)?,
            complexity_score: row.get(6)?,
            routed_endpoint: row.get(7)?,
            cost_tier: row.get(8)?,
            scopes: serde_json::from_str(&scopes_raw).unwrap_or_default(),
            verifier_rule: row.get(10)?,
            requires_human: row.get::<_, i64>(11)? != 0,
            status: row.get(12)?,
            commitment: row.get(13)?,
            friction_reason: row.get(14)?,
            created_at: row.get(15)?,
            updated_at: row.get(16)?,
        })
    })?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

fn load_reports(conn: &Connection) -> Result<Vec<DelegationReport>> {
    let mut stmt = conn.prepare("SELECT id, contract_id, from_bot_id, to_bot_id, report_type, summary, commitment, created_at FROM delegation_reports ORDER BY created_at DESC LIMIT 40")?;
    let rows = stmt.query_map([], |row| {
        Ok(DelegationReport {
            id: row.get(0)?,
            contract_id: row.get(1)?,
            from_bot_id: row.get(2)?,
            to_bot_id: row.get(3)?,
            report_type: row.get(4)?,
            summary: row.get(5)?,
            commitment: row.get(6)?,
            created_at: row.get(7)?,
        })
    })?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

struct StoredContract {
    id: String,
    issuer_bot_id: String,
    assignee_bot_id: String,
    scope_label: String,
    sub_goal: String,
    routed_endpoint: String,
    cost_tier: String,
    scopes: Vec<String>,
    status: String,
    commitment: String,
    friction_reason: String,
}

fn load_contract(conn: &Connection, contract_id: &str) -> Result<StoredContract> {
    conn.query_row(
        "SELECT id, issuer_bot_id, assignee_bot_id, scope_label, sub_goal, routed_endpoint, cost_tier, scopes_json, status, commitment, friction_reason FROM delegation_contracts WHERE id=?1",
        params![contract_id],
        |row| {
            let scopes_raw: String = row.get(7)?;
            Ok(StoredContract {
                id: row.get(0)?,
                issuer_bot_id: row.get(1)?,
                assignee_bot_id: row.get(2)?,
                scope_label: row.get(3)?,
                sub_goal: row.get(4)?,
                routed_endpoint: row.get(5)?,
                cost_tier: row.get(6)?,
                scopes: serde_json::from_str(&scopes_raw).unwrap_or_default(),
                status: row.get(8)?,
                commitment: row.get(9)?,
                friction_reason: row.get(10)?,
            })
        },
    )
    .map_err(|_| err("Contract not found."))
}

fn load_bots(conn: &Connection) -> Result<Vec<BotRef>> {
    let mut stmt = conn.prepare("SELECT id, handle, role, soul_markdown, allow_computer_use, allow_browser_use, allow_code_exec, allow_file_write, primary_account_id, long_context_account_id, fallback_account_id FROM bot_profiles")?;
    let rows = stmt.query_map([], |row| {
        Ok(BotRef {
            id: row.get(0)?,
            handle: row.get(1)?,
            role: row.get(2)?,
            soul: row.get(3)?,
            allow_computer_use: row.get::<_, i64>(4)? != 0,
            allow_browser_use: row.get::<_, i64>(5)? != 0,
            allow_code_exec: row.get::<_, i64>(6)? != 0,
            allow_file_write: row.get::<_, i64>(7)? != 0,
            primary_account_id: row.get(8)?,
            long_context_account_id: row.get(9)?,
            fallback_account_id: row.get(10)?,
        })
    })?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

fn load_groups(conn: &Connection) -> Result<Vec<GroupRef>> {
    let mut stmt = conn.prepare("SELECT id, group_handle, title, lead_bot_id, member_bot_ids_json FROM bot_groups")?;
    let rows = stmt.query_map([], |row| {
        let raw: String = row.get(4)?;
        Ok(GroupRef {
            id: row.get(0)?,
            handle: row.get(1)?,
            name: row.get(2)?,
            manager_id: row.get(3)?,
            member_ids: serde_json::from_str(&raw).unwrap_or_default(),
        })
    })?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

fn insert_report(conn: &Connection, contract_id: &str, from_bot: &str, to_bot: &str, report_type: &str, summary: &str, commitment: &str, created_at: i64) -> Result<()> {
    let summary = summary.chars().take(500).collect::<String>();
    conn.execute(
        "INSERT INTO delegation_reports (id, contract_id, from_bot_id, to_bot_id, report_type, summary, commitment, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        params![nid("rep"), contract_id, from_bot, to_bot, report_type, summary, commitment, created_at],
    )?;
    Ok(())
}

fn handle_of(bots: &[BotRef], id: &str) -> String {
    bots.iter().find(|bot| bot.id == id).map(|bot| bot.handle.clone()).unwrap_or_else(|| id.to_string())
}

fn nonempty(preferred: &str, fallback: &str) -> String {
    if !preferred.trim().is_empty() { preferred.trim().to_string() } else { fallback.trim().to_string() }
}

fn needs_human(text: &str) -> bool {
    let lower = text.to_lowercase();
    ["which ", "prefer", "should we", "looks better"].iter().any(|word| lower.contains(word))
}

fn has_or_choice(lower: &str) -> bool {
    let Some((left, right)) = lower.split_once(" or ") else { return false };
    let hit = |side: &str| OR_VERBS.iter().any(|verb| side.contains(verb));
    hit(left) && hit(right)
}

fn currency_kinds(lower: &str) -> usize {
    let mut count = 0;
    if lower.contains('$') || lower.contains("usd") || lower.contains("usdc") { count += 1; }
    if lower.contains('₹') || lower.contains("inr") || lower.contains("rupee") { count += 1; }
    if lower.contains("eur") || lower.contains('€') { count += 1; }
    if lower.contains("gbp") || lower.contains('£') { count += 1; }
    count
}

fn has_rate_instruction(lower: &str) -> bool {
    ["spot", "lock rate", "locked rate", "fixed rate", "exchange rate", "at rate"].iter().any(|word| lower.contains(word))
}

fn asks_to_move_money(lower: &str) -> bool {
    let verb = ["pay ", "pay the", "send ", "transfer ", "withdraw ", "approve payment"].iter().any(|word| lower.contains(word));
    let money = lower.contains('$') || lower.contains('₹') || lower.contains("usd") || lower.contains("inr") || lower.contains("usdc") || lower.contains("payment");
    verb && money && !lower.contains("do not pay") && !lower.contains("don't pay") && !lower.contains("do not send")
}

fn split_and(input: &str) -> Vec<String> {
    let lower = input.to_lowercase();
    let mut parts = Vec::new();
    let mut start = 0usize;
    let mut index = 0usize;
    while index < lower.len() {
        if lower[index..].starts_with(" and ") {
            let left = input[start..index].trim();
            let right = input[index + 5..].trim();
            if left.chars().count() >= 8 && right.chars().count() >= 8 {
                parts.push(left.to_string());
                start = index + 5;
                index = start;
                continue;
            }
        }
        let step = lower[index..].chars().next().map(|ch| ch.len_utf8()).unwrap_or(1);
        index += step;
    }
    let tail = input[start..].trim();
    if !tail.is_empty() {
        parts.push(tail.to_string());
    }
    parts
}

fn fit_words(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|ch: char| !ch.is_ascii_alphanumeric())
        .filter(|word| word.len() >= 3 && !is_stop(word))
        .map(|word| word.to_string())
        .collect()
}

fn is_stop(word: &str) -> bool {
    matches!(word, "the" | "and" | "for" | "with" | "this" | "that" | "from" | "into" | "your" | "you" | "are" | "was" | "were" | "have" | "has" | "will" | "then" | "than" | "not" | "but" | "all" | "any" | "our" | "its" | "per")
}

fn fit_score(clause: &str, bot: &BotRef) -> i32 {
    let hay = format!("{} {} {}", bot.handle, bot.role, bot.soul).to_lowercase();
    fit_words(clause).into_iter().filter(|word| hay.contains(word)).count() as i32
}

fn assign_clauses<'a>(clauses: &[String], candidates: &[&'a BotRef]) -> Vec<(String, &'a BotRef)> {
    let mut used = vec![0i32; candidates.len()];
    clauses
        .iter()
        .map(|clause| {
            let mut best = 0usize;
            let mut best_score = i32::MIN;
            for (index, bot) in candidates.iter().enumerate() {
                let score = fit_score(clause, bot) * 100 - used[index];
                if score > best_score {
                    best_score = score;
                    best = index;
                }
            }
            used[best] += 1;
            (clause.clone(), candidates[best])
        })
        .collect()
}

fn find_group<'a>(token: &str, groups: &'a [GroupRef]) -> Option<&'a GroupRef> {
    let bare = token.trim_start_matches('#');
    groups.iter().find(|group| {
        let handle_bare = group.handle.trim_start_matches('#');
        group.handle.eq_ignore_ascii_case(token) || handle_bare.eq_ignore_ascii_case(bare) || group.name.eq_ignore_ascii_case(bare) || group.name.eq_ignore_ascii_case(token)
    })
}

fn same_handle(handle: &str, token: &str) -> bool {
    let left = handle.trim().trim_start_matches('@');
    let right = token.trim().trim_start_matches('@');
    !left.is_empty() && left.eq_ignore_ascii_case(right)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bot(id: &str, handle: &str, role: &str, soul: &str) -> BotRef {
        BotRef {
            id: id.into(),
            handle: handle.into(),
            role: role.into(),
            soul: soul.into(),
            allow_computer_use: false,
            allow_browser_use: true,
            allow_code_exec: true,
            allow_file_write: false,
            primary_account_id: "prov_main".into(),
            long_context_account_id: "prov_long".into(),
            fallback_account_id: "prov_fast".into(),
        }
    }

    fn sample_bots() -> Vec<BotRef> {
        vec![
            bot("chief", "@chief", "Coordinates the workspace", ""),
            bot("writer", "@writer", "formats csv reports", ""),
            bot("auditor", "@auditor", "security reviews", "reviews webhook bugs and security audits"),
        ]
    }

    #[test]
    fn complexity_matches_the_cost_tiers() {
        assert_eq!(score_complexity("Reformat the csv export"), 5);
        assert_eq!(score_complexity("Patch the webhook bug"), 35);
        // audit, payroll, and ledger are each heavy, so the two-or-more bonus applies.
        assert_eq!(score_complexity("Audit the payroll ledger"), 70);
        assert_eq!(score_complexity("Refactor the security architecture and migrate the ledger"), 70);
        let light = route_account(5, &sample_bots()[1]);
        assert_eq!(light, ("prov_fast".into(), "lightweight".into()));
        let heavy = route_account(70, &sample_bots()[1]);
        assert_eq!(heavy.1, "heavy");
        assert_eq!(heavy.0, "prov_long");
    }

    #[test]
    fn friction_catches_short_choice_currency_and_payment() {
        assert!(friction_reason("do it").unwrap().contains("too short"));
        assert!(friction_reason("lock the reserve or convert the balance").unwrap().contains("two actions"));
        assert!(friction_reason("compare usd and inr totals").unwrap().contains("Two currencies"));
        assert!(friction_reason("pay the $20 invoice now").unwrap().contains("move money"));
        assert!(friction_reason("Patch the 429 webhook retry").is_none());
        assert!(friction_reason("compare usd and inr totals at the spot rate").is_none());
    }

    #[test]
    fn manager_cannot_assign_outside_the_group() {
        let group = GroupRef { id: "grp".into(), handle: "#ops".into(), name: "ops".into(), manager_id: "writer".into(), member_ids: vec!["writer".into(), "auditor".into()] };
        assert!(verify_delegation_authority("writer", false, "outsider", Some(&group)).unwrap_err().contains("SCOPE VIOLATION"));
        assert!(verify_delegation_authority("writer", false, "auditor", Some(&group)).is_ok());
        assert!(verify_delegation_authority("chief", true, "outsider", None).is_ok());
        assert!(verify_delegation_authority("writer", false, "auditor", None).unwrap_err().contains("AUTHORITY DENIED"));
    }

    #[test]
    fn split_keeps_a_short_side_intact() {
        let clauses = split_clauses("Patch the webhook bug and reformat the csv export");
        assert_eq!(clauses, vec!["Patch the webhook bug".to_string(), "reformat the csv export".to_string()]);
        assert_eq!(split_clauses("Fix it and go"), vec!["Fix it and go".to_string()]);
    }

    #[test]
    fn plan_assigns_real_bots_and_does_not_mark_them_done() {
        let bots = sample_bots();
        let group = GroupRef { id: "grp".into(), handle: "#ops".into(), name: "ops".into(), manager_id: "writer".into(), member_ids: vec!["writer".into(), "auditor".into()] };
        let planned = plan_delegation("Patch the webhook bug and reformat the csv export", "writer", "chief", Some(&group), &bots).unwrap();
        assert_eq!(planned.plans.len(), 2);
        assert_eq!(planned.plans[0].assignee_id, "auditor");
        assert_eq!(planned.plans[1].assignee_id, "writer");
        assert!(planned.plans.iter().all(|plan| plan.status == "in_progress"));
        assert!(planned.plans.iter().all(|plan| plan.scopes.contains(&"deny:wallet_spend".to_string())));
        assert!(planned.plans.iter().all(|plan| plan.scopes.contains(&"deny:vault_secrets".to_string())));
        let blocked = plan_delegation("Patch the webhook bug", "auditor", "chief", None, &bots).unwrap_err();
        assert!(blocked.contains("Only the chief"));
        let friction = plan_delegation("pay the $20 invoice and reformat the csv export", "chief", "chief", None, &bots).unwrap();
        assert_eq!(friction.plans.len(), 1);
        assert_eq!(friction.plans[0].status, "friction_challenged");
    }

    #[test]
    fn phone_route_and_callback_stay_closed() {
        let bots = sample_bots();
        let groups = vec![GroupRef { id: "grp".into(), handle: "#ops".into(), name: "ops".into(), manager_id: "writer".into(), member_ids: vec!["writer".into(), "auditor".into()] }];
        let scoped = route_mobile("#ops Patch the webhook bug", "chief", &groups, &bots).unwrap();
        assert_eq!(scoped.issuer_id, "writer");
        assert_eq!(scoped.group_id, "grp");
        assert_eq!(scoped.objective, "Patch the webhook bug");
        let global = route_mobile("/chief Audit the payroll ledger", "chief", &groups, &bots).unwrap();
        assert_eq!(global.issuer_id, "chief");
        assert!(global.group_id.is_empty());
        assert!(route_mobile("Audit the payroll ledger", "", &groups, &bots).is_err());
        assert!(authorize_mobile(false, "telegram", "owner", "owner").unwrap_err().contains("BLOCKED"));
        assert!(authorize_mobile(true, "telegram", "owner", "intruder").unwrap_err().contains("UNAUTHORIZED"));
        assert!(authorize_mobile(true, "telegram", " owner ", "owner").is_ok());
        assert!(matches!(parse_callback("attest:ctr_1").unwrap(), PhoneCallback::Attest(_)));
        assert!(parse_callback("approve_tx_901").unwrap_err().contains("not a delegation"));
        let card = executive_card(" @chief", "GLOBAL", "Patch the webhook bug", &[]);
        assert!(!card.contains("tests passed"));
        assert!(!card.contains("zkp"));
    }

    #[test]
    fn persisted_contracts_require_attestation() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate(&conn).unwrap();
        for (id, handle, role, soul) in [
            ("chief", "@chief", "Coordinates the workspace", ""),
            ("writer", "@writer", "formats csv reports", ""),
            ("auditor", "@auditor", "security reviews", "reviews webhook bugs and security audits"),
        ] {
            conn.execute(
                "INSERT INTO bot_profiles (id, handle, display_name, avatar, soul_markdown, primary_account_id, long_context_account_id, fallback_account_id, role, created_at, allow_computer_use, allow_browser_use, allow_code_exec, allow_file_write) VALUES (?1,?2,?2,'NW',?3,'prov_main','prov_long','prov_fast',?4,1,0,1,1,0)",
                params![id, handle, soul, role],
            ).unwrap();
        }
        conn.execute(
            "INSERT INTO bot_groups (id, group_handle, title, purpose, coordination_mode, lead_bot_id, member_bot_ids_json, shared_workspace_dir, routine_schedule, created_at) VALUES ('grp','#ops','ops','', 'lead_delegated','writer','[\"writer\",\"auditor\"]','', '',1)",
            [],
        ).unwrap();
        appoint_chief(&conn, "chief").unwrap();
        let outcome = dispatch(&conn, "writer", "grp", "Patch the webhook bug and reformat the csv export").unwrap();
        assert_eq!(outcome.contract_ids.len(), 2);
        assert!(outcome.card.contains("in_progress"));
        assert!(!outcome.card.contains("verified_complete"));
        let (chief, contracts, reports) = load_view(&conn).unwrap();
        assert_eq!(chief, "chief");
        assert_eq!(contracts.len(), 2);
        assert_eq!(reports.len(), 2);
        let err = attest_contract(&conn, &outcome.contract_ids[0], "no").unwrap_err();
        assert!(err.to_string().contains("8 characters"));
        attest_contract(&conn, &outcome.contract_ids[0], "Webhook patch is in the branch.").unwrap();
        let again = attest_contract(&conn, &outcome.contract_ids[0], "Webhook patch is in the branch.").unwrap_err();
        assert!(again.to_string().contains("in progress"));
        let money = dispatch(&conn, "chief", "", "pay the $20 invoice today").unwrap();
        assert_eq!(money.contract_ids.len(), 1);
        let blocked = attest_contract(&conn, &money.contract_ids[0], "I confirm this payment.").unwrap_err();
        assert!(blocked.to_string().contains("in progress"));
        resolve_friction(&conn, &money.contract_ids[0], "Do not pay. Leave the invoice.").unwrap();
        attest_contract(&conn, &money.contract_ids[0], "Invoice left unpaid on purpose.").unwrap();
    }
}
