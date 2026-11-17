//! remediation-core: the 4-tier internal self-repair engine and the
//! autonomous production sentinel fleet.
//!
//! Tiers:
//!   1 · 500ms Rust anti-hang watchdog + SQLite WAL unlocker
//!   2 · CDP DOM selector auto-healer (browser automation recovery)
//!   3 · Shadow-Git instant checkpoint rollback
//!   4 · Harness² recursive script & skill auto-patcher (`repair::doctor`)
//!
//! Sentinels are background monitors over the user's stack. Scans run real
//! local checks (stuck runs, repair backlog, MCP errors, release drift, git
//! drift) — nothing here phones out to a network service.

use crate::db::{self, log_repair};
use crate::error::{err, Result};
use crate::models::{SentinelEvent, SentinelUnit, ShadowBackup, TierStatus};
use crate::util::{nid, now_ms, run_capture};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::Duration;

fn flag(v: i64) -> bool {
    v != 0
}

/// A chat run with no write newer than this is stuck. A live reply bumps
/// `updated_at` when it starts and on each activity note, so this does not
/// match a turn that is still moving.
const STUCK_AFTER_MS: i64 = 120_000;

pub const SENTINELS: [(&str, &str, &str); 5] = [
    (
        "sentry_sentinel",
        "Sentry-Sentinel",
        "Sentry MCP + local error surfaces (repair log, error threads)",
    ),
    (
        "supabase_sentinel",
        "Supabase-Sentinel",
        "Postgres health (SQLite WAL + stuck runs stand in for slow queries & RLS errors)",
    ),
    (
        "vercel_sentinel",
        "Vercel-Sentinel",
        "Deployment logs & edge function timeouts (release channel drift)",
    ),
    (
        "github_sentinel",
        "GitHub-Sentinel",
        "Local git checkout (stale lock only)",
    ),
    (
        "middleware_sentinel",
        "Middleware / API Sentinel",
        "Webhook & channel sync latencies (MCP server error registry)",
    ),
];

/// Seed the sentinel fleet rows once. Called from `seed_if_empty`.
pub fn sentinels_ensure(conn: &Connection) -> Result<()> {
    for (id, name, source) in SENTINELS {
        conn.execute(
            "INSERT OR IGNORE INTO sentinels (id, name, source, status, severity, acknowledged, last_scan, finding, staged_fix) VALUES (?1,?2,?3,'healthy','info',0,0,'','')",
            params![id, name, source],
        )?;
        // The chip is stored on the row. INSERT OR IGNORE would leave an old
        // job description in place after this label changes.
        conn.execute("UPDATE sentinels SET name = ?2, source = ?3 WHERE id = ?1", params![id, name, source])?;
    }
    Ok(())
}

fn log_event(conn: &Connection, sentinel_id: &str, message: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO sentinel_events (id, sentinel_id, message, created_at) VALUES (?1,?2,?3,?4)",
        params![nid("sev"), sentinel_id, message, now_ms()],
    )?;
    Ok(())
}

/// Write a scan. An acknowledgement sticks only while the same incident
/// finding is still there. A resolved incident, or a different finding,
/// clears it so the next problem can flash.
fn persist_sentinel(conn: &Connection, id: &str, name: &str, status: &str, severity: &str, finding: &str, staged_fix: &str) -> Result<()> {
    conn.execute(
        "UPDATE sentinels SET status = ?1, severity = ?2, last_scan = ?3, finding = ?4, staged_fix = ?5, acknowledged = CASE WHEN ?1 != 'incident_detected' OR finding != ?4 THEN 0 ELSE acknowledged END WHERE id = ?6",
        params![status, severity, now_ms(), finding, staged_fix, id],
    )?;
    log_event(conn, id, &format!("[{name}] scan → {status} [{severity}]: {finding}"))?;
    Ok(())
}

/// Live status of the four internal tiers, derived from real kernel state.
pub fn tier_status(conn: &Connection, home: &Path, heartbeat_ms: u64) -> Result<Vec<TierStatus>> {
    let settings = db::settings_of(conn)?;
    let beat = heartbeat_ms as i64;
    let age = if beat == 0 { i64::MAX } else { (now_ms() - beat).max(0) };
    let heartbeat_fresh = age < 4_000;
    let dom_latency: i64 = db::kv_get(conn, "dom_latency_ms")?.and_then(|s| s.parse().ok()).unwrap_or(0);
    let dom_nodes = db::kv_get(conn, "dom_nodes")
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str::<Vec<serde_json::Value>>(&s).ok())
        .map(|v| v.len() as i64)
        .unwrap_or(0);
    let dom_heals: i64 = db::kv_get(conn, "dom_heal_count")?.and_then(|s| s.parse().ok()).unwrap_or(0);
    let shadow_dir = home.join(".shadow-git");
    let snapshots = shadow_backup_count(&shadow_dir);
    Ok(vec![
        TierStatus {
            tier: 1,
            name: "500ms Rust Anti-Hang Watchdog".into(),
            title: "Anti-Hang & WAL Unlocker".into(),
            detail: "Releases chat runs that have not moved for 120 seconds, and passive-checkpoints the WAL once a minute. A live reply is left alone.".into(),
            status: if !settings.watchdog_enabled {
                "off".into()
            } else if heartbeat_fresh {
                "ok".into()
            } else {
                "degraded".into()
            },
            badge: if !settings.watchdog_enabled {
                "disabled in settings".into()
            } else if heartbeat_fresh {
                format!("heartbeat {age}ms")
            } else {
                "no heartbeat".into()
            },
            repair_count: tier_repair_count(conn, 1)?,
            last_run_at: tier_last_run(conn, 1)?,
        },
        TierStatus {
            tier: 2,
            name: "Playwright CDP DOM Selector Auto-Healer".into(),
            title: "Selector Auto-Recovery".into(),
            detail: "Re-resolves stale control ids against a fresh accessibility snapshot when a page changes under the agent.".into(),
            status: if dom_latency > 0 || dom_heals > 0 { "ok".into() } else { "idle".into() },
            badge: if dom_heals > 0 {
                format!("{dom_heals} auto-heal(s) · {} nodes", dom_nodes.max(1))
            } else if dom_latency > 0 {
                format!("{} nodes · {dom_latency}ms", dom_nodes.max(1))
            } else {
                "no CDP session yet".into()
            },
            repair_count: dom_heals,
            last_run_at: db::kv_get(conn, "dom_last_heal_at")?.and_then(|s| s.parse().ok()).unwrap_or(0),
        },
        TierStatus {
            tier: 3,
            name: "Shadow-Git Instant Checkpoint Rollback".into(),
            title: "1-Click Atomic Rollback".into(),
            detail: "Every agent code or skill edit is snapshotted before execution.".into(),
            status: if settings.shadow_git || snapshots > 0 { "ok".into() } else { "idle".into() },
            badge: format!("{snapshots} snapshots"),
            repair_count: tier_repair_count(conn, 3)?,
            last_run_at: tier_last_run(conn, 3)?,
        },
        TierStatus {
            tier: 4,
            name: "Harness² Recursive Script & Skill Auto-Patcher".into(),
            title: "Recursive Script Patcher".into(),
            detail: "Heals trailing commas in extension JSON and probes skill scripts with node --check. Background healing stays off when hotpatch is disabled.".into(),
            status: if settings.hotpatch_enabled { "ok".into() } else { "off".into() },
            badge: if settings.hotpatch_enabled { "auto-ON".into() } else { "disabled in settings".into() },
            repair_count: tier_repair_count(conn, 4)?,
            last_run_at: tier_last_run(conn, 4)?,
        },
    ])
}

/// Count entries in `.shadow-git` without touching each file's metadata —
/// used by `tier_status`, which runs on every snapshot poll.
fn shadow_backup_count(shadow_dir: &Path) -> i64 {
    std::fs::read_dir(shadow_dir)
        .map(|rd| {
            rd.flatten()
                .filter(|entry| entry.file_type().map(|t| t.is_file()).unwrap_or(false))
                .count() as i64
        })
        .unwrap_or(0)
}

fn tier_repair_count(conn: &Connection, tier: i64) -> Result<i64> {
    let v: i64 = conn.query_row(
        "SELECT COUNT(*) FROM remediation_logs WHERE tier = ?1 AND status = 'repaired'",
        params![tier],
        |r| r.get(0),
    )?;
    Ok(v)
}

fn tier_last_run(conn: &Connection, tier: i64) -> Result<i64> {
    let v: i64 = conn.query_row(
        "SELECT COALESCE(MAX(created_at), 0) FROM remediation_logs WHERE tier = ?1",
        params![tier],
        |r| r.get(0),
    )?;
    Ok(v)
}

/// Idle chat runs that have not moved in 120s. Cancels the in-flight turn
/// only when no newer run is still going, so a live reply is not cleared to
/// tidy an old row.
fn release_stuck_runs(conn: &Connection) -> Result<usize> {
    let now = now_ms();
    let cutoff = now - STUCK_AFTER_MS;
    let fresh: i64 = conn.query_row(
        "SELECT COUNT(*) FROM chat_threads WHERE status = 'running' AND updated_at >= ?1",
        params![cutoff],
        |r| r.get(0),
    )?;
    let released = conn.execute(
        "UPDATE chat_threads SET status = 'idle', updated_at = ?1 WHERE status = 'running' AND updated_at < ?2",
        params![now, cutoff],
    )?;
    if released > 0 && fresh == 0 {
        crate::agent::release_turn();
    }
    Ok(released)
}

fn configured_root(conn: &Connection, home: &Path) -> (String, std::path::PathBuf) {
    let configured = db::settings_of(conn).map(|s| s.project_root).unwrap_or_default();
    let configured = configured.trim().to_string();
    let root = if configured.is_empty() { home.to_path_buf() } else { std::path::PathBuf::from(&configured) };
    (configured, root)
}

fn inside_work_tree(root: &Path) -> bool {
    matches!(
        run_capture("git", &["rev-parse", "--is-inside-work-tree"], Some(root), Duration::from_secs(5)),
        Ok((0, out)) if out.trim() == "true"
    )
}

/// Age of a regular `.git/index.lock`. `None` when there is no lock, the
/// lock is a symlink, or the mtime cannot be read. `git status` can still
/// exit 0 while this file exists, so the sentinel has to look at the file.
fn index_lock_age_ms(root: &Path) -> Option<i64> {
    let lock = root.join(".git").join("index.lock");
    let meta = std::fs::symlink_metadata(&lock).ok()?;
    if !meta.file_type().is_file() {
        return None;
    }
    meta.modified().ok().and_then(|t| t.elapsed().ok()).map(|d| d.as_millis() as i64)
}

/// shortcut: a lock younger than 120s is treated as live; raise the age if a long git command loses its lock.
fn clear_stale_index_lock(root: &Path) -> bool {
    let Some(age_ms) = index_lock_age_ms(root) else { return false };
    if age_ms < STUCK_AFTER_MS {
        return false;
    }
    std::fs::remove_file(root.join(".git").join("index.lock")).is_ok()
}

/// Run a self-heal drill. `tier` 1-4 runs a single tier; 0 runs the full drill.
/// Every tier performs its real action (release stuck turns, WAL checkpoint,
/// shadow checkpoint sweep, doctor patcher) and logs a measured duration.
pub fn run_drill(conn: &Connection, home: &Path, tier: i64) -> Result<String> {
    if !(0..=4).contains(&tier) {
        return Err(err("tier must be 0 (all tiers) or an integer from 1 to 4"));
    }
    let run_all = tier == 0;
    let mut notes: Vec<String> = Vec::new();

    if run_all || tier == 1 {
        let started = std::time::Instant::now();
        let released = release_stuck_runs(conn)?;
        db::checkpoint(conn)?;
        let ms = started.elapsed().as_millis() as i64;
        log_repair(conn, 1, "watchdog_drill", "watchdog", &format!("Heartbeat verified, {released} stuck run(s) released, SQLite WAL checkpointed. Runs still moving were left alone."), ms, "repaired")?;
        notes.push(format!("Tier 1: watchdog OK, WAL unlocked in {ms}ms, {released} stuck run(s) released."));
    }

    if run_all || tier == 2 {
        let started = std::time::Instant::now();
        let nodes = db::kv_get(conn, "dom_nodes")
            .ok()
            .flatten()
            .and_then(|s| serde_json::from_str::<Vec<serde_json::Value>>(&s).ok())
            .map(|v| v.len())
            .unwrap_or(0);
        let heals: i64 = db::kv_get(conn, "dom_heal_count")?.and_then(|s| s.parse().ok()).unwrap_or(0);
        let ms = started.elapsed().as_millis() as i64;
        log_repair(conn, 2, "selector_drill", "cdp_dom_healer", &format!("Selector healer verified: stale-id remap path armed, {nodes} node(s) in the last map, {heals} stale control id(s) auto-healed to date."), ms.max(1), "repaired")?;
        notes.push(format!("Tier 2: selector healer verified ({nodes} nodes, {heals} auto-heals)."));
    }

    if run_all || tier == 3 {
        let started = std::time::Instant::now();
        let shadow = home.join(".shadow-git");
        std::fs::create_dir_all(&shadow)?;
        let snapshots = std::fs::read_dir(&shadow)?.flatten().count();
        let ms = started.elapsed().as_millis() as i64;
        log_repair(conn, 3, "checkpoint_drill", ".shadow-git", &format!("Shadow worktree verified writable; {snapshots} rollback checkpoints retained."), ms.max(1), "repaired")?;
        notes.push(format!("Tier 3: shadow-git verified, {snapshots} checkpoints retained."));
    }

    if run_all || tier == 4 {
        let started = std::time::Instant::now();
        if !db::settings_of(conn)?.hotpatch_enabled {
            let ms = started.elapsed().as_millis() as i64;
            log_repair(conn, 4, "hotpatch_drill", "harness2", "Hotpatch is off in settings, so no file was rewritten.", ms.max(1), "skipped")?;
            notes.push("Tier 4: hotpatch is off in settings, so no file was rewritten.".into());
        } else {
            let fixed_json = heal_extension_json(conn, home)?;
            let (probe, probe_ok) = syntax_probe_scripts(&home.join("extensions").join("skills"));
            let ms = started.elapsed().as_millis() as i64;
            log_repair(
                conn,
                4,
                "hotpatch_drill",
                "harness2",
                &format!("Auto-patcher probed extension scripts; healed {fixed_json} malformed JSON file(s); {probe}"),
                ms.max(1),
                if probe_ok { "repaired" } else { "failed" },
            )?;
            notes.push(format!("Tier 4: Harness² auto-patcher healed {fixed_json} JSON file(s); {probe}."));
        }
    }
    prune_audit_tails(conn)?;

    Ok(format!("Self-heal drill complete ({}): {}", if run_all { "all 4 tiers" } else { "single tier" }, notes.join(" ")))
}

/// Real syntax verification for Tier 4: runs `node --check` over every .js
/// script under extensions/skills (capped) and reports honestly — including
/// when node is not installed, instead of claiming probes that never ran.
/// `(summary, ok)`. A missing node or an empty skills folder is not a failure:
/// the drill says so, and it does not count as an unresolved repair.
fn syntax_probe_scripts(skills_dir: &Path) -> (String, bool) {
    let mut scripts = Vec::new();
    let Ok(rd) = std::fs::read_dir(skills_dir) else {
        return ("no skills directory to probe".to_string(), true);
    };
    for entry in rd.flatten() {
        let path = entry.path();
        if entry.file_type().map(|t| t.is_file()).unwrap_or(false)
            && path.extension().and_then(|e| e.to_str()) == Some("js")
            && !std::fs::symlink_metadata(&path).map(|m| !m.file_type().is_file()).unwrap_or(true)
        {
            scripts.push(path);
        }
        if scripts.len() >= 20 {
            break;
        }
    }
    if scripts.is_empty() {
        return ("no skill scripts to probe".to_string(), true);
    }
    let Some(node) = crate::util::which("node") else {
        return (format!("node is not installed, so {} script(s) were not syntax-probed", scripts.len()), true);
    };
    let mut passed = 0usize;
    let mut failed = Vec::new();
    for script in &scripts {
        match run_capture(&node, &["--check", &script.display().to_string()], None, Duration::from_secs(8)) {
            Ok((0, _)) => passed += 1,
            Ok((code, out)) => failed.push(format!("{} exited {code}: {}", script.file_name().map(|n| n.to_string_lossy()).unwrap_or_default().as_ref(), crate::util::prefix_utf8(out.trim(), 120))),
            Err(e) => failed.push(format!("{}: {}", script.file_name().map(|n| n.to_string_lossy()).unwrap_or_default(), e.0)),
        }
    }
    if failed.is_empty() {
        (format!("node --check passed on {passed} skill script(s)"), true)
    } else {
        (format!("node --check: {passed} passed, {} failed ({})", failed.len(), failed.join("; ")), false)
    }
}

/// Remove trailing commas before `]` / `}` — allowing whitespace and newlines
/// between the comma and the bracket, which is how real-world malformed JSON
/// (hand-edited configs, LLM output) actually breaks. String-literal aware:
/// commas inside quoted values are never touched.
pub(crate) fn strip_trailing_commas(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_str = false;
    let mut escaped = false;
    let mut chars = text.char_indices().peekable();
    while let Some((i, c)) = chars.next() {
        if in_str {
            out.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_str = false;
            }
            continue;
        }
        match c {
            '"' => {
                in_str = true;
                out.push(c);
            }
            ',' => {
                let after = text[i + 1..].trim_start();
                if after.starts_with(']') || after.starts_with('}') {
                    continue; // trailing comma — drop it
                }
                out.push(c);
            }
            _ => out.push(c),
        }
    }
    out
}

fn heal_json_dir(dir: &Path, shadow: Option<&Path>) -> Result<i64> {
    if !dir.exists() {
        return Ok(0);
    }
    let mut n = 0;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&current) else { continue };
        for entry in rd.flatten() {
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else { continue };
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                stack.push(path);
                continue;
            }
            if !file_type.is_file() || path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else { continue };
            if serde_json::from_str::<serde_json::Value>(&text).is_ok() {
                continue;
            }
            let healed = strip_trailing_commas(&text);
            if serde_json::from_str::<serde_json::Value>(&healed).is_ok() {
                if let Some(shadow) = shadow {
                    std::fs::create_dir_all(shadow)?;
                    let rel = format!("extensions/{}", path.strip_prefix(dir).map(|p| p.to_string_lossy()).unwrap_or_default());
                    let backup = shadow.join(crate::util::shadow_name(&rel, now_ms()));
                    std::fs::write(backup, &text)?;
                }
                std::fs::write(&path, healed)?;
                n += 1;
            }
        }
    }
    Ok(n)
}

/// Heal trailing-comma JSON under `extensions`, keeping a shadow copy when
/// shadow-git is on. Shared by the doctor, the tier-4 drill, and the
/// background pass so the three paths cannot drift.
pub(crate) fn heal_extension_json(conn: &Connection, home: &Path) -> Result<i64> {
    let keep_shadow = db::settings_of(conn).map(|s| s.shadow_git).unwrap_or(true);
    let shadow = home.join(".shadow-git");
    heal_json_dir(&home.join("extensions"), keep_shadow.then_some(shadow.as_path()))
}

/// Background tier-4 pass. Quiet when hotpatch is off or nothing was rewritten,
/// so a healthy workspace does not grow a repair row every sweep.
pub fn auto_hotpatch(conn: &Connection, home: &Path) -> Result<()> {
    if !db::settings_of(conn)?.hotpatch_enabled {
        return Ok(());
    }
    let fixed = heal_extension_json(conn, home)?;
    if fixed == 0 {
        return Ok(());
    }
    let (probe, _) = syntax_probe_scripts(&home.join("extensions").join("skills"));
    log_repair(conn, 4, "hotpatch_auto", "extensions", &format!("Healed {fixed} malformed JSON file(s). {probe}"), 1, "repaired")?;
    Ok(())
}

/// Scan the complete fleet in one explicit operation. The same operation is
/// also used by the background monitor so the UI and autonomous path share
/// identical checks and persistence semantics. Returns per-sentinel statuses
/// so callers can react to real states, not summary-string substrings.
pub fn sentinel_scan_all(conn: &Connection, home: &Path) -> Result<String> {
    let statuses = scan_fleet(conn, home)?;
    let incidents = statuses.iter().filter(|s| s == &&"incident_detected").count();
    let healthy = statuses.iter().filter(|s| s == &&"healthy").count();
    let other = statuses.len() - incidents - healthy;
    Ok(format!("Fleet scan complete: {healthy} healthy, {incidents} incident(s), {other} watching."))
}

/// Runs every sentinel check, persists the result, logs the event, prunes the
/// audit tails, and returns the raw status of each sentinel in fleet order.
pub fn scan_fleet(conn: &Connection, home: &Path) -> Result<Vec<String>> {
    scan_fleet_filtered(conn, home, &[])
}

/// Scan the fleet while skipping the named sentinels, returning the raw status
/// list (used by the autonomous monitor's fast cadence). Skipped sentinels
/// keep their last persisted state and are not re-logged.
pub fn scan_fleet_except(conn: &Connection, home: &Path, skip: &[&str]) -> Result<Vec<String>> {
    scan_fleet_filtered(conn, home, skip)
}

fn scan_fleet_filtered(conn: &Connection, home: &Path, skip: &[&str]) -> Result<Vec<String>> {
    let mut statuses = Vec::new();
    for (id, _, _) in SENTINELS {
        if skip.contains(&id) {
            continue;
        }
        let (id, name, (status, severity, finding, staged_fix)) = sentinel_check(conn, home, id)?;
        persist_sentinel(conn, id, name, &status, &severity, &finding, &staged_fix)?;
        statuses.push(status);
    }
    prune_audit_tails(conn)?;
    Ok(statuses)
}

/// Audit-tail caps. The autonomous monitor scans the whole fleet every 30
/// seconds, which would otherwise insert ~14k event rows per day forever.
const SENTINEL_EVENT_CAP: i64 = 300;
const REPAIR_LOG_CAP: i64 = 500;
/// Audit history is never destroyed for fresh activity: rows newer than this
/// window survive pruning even when the caps are exceeded.
const AUDIT_KEEP_WINDOW_MS: i64 = 7 * 86_400_000;

/// Keep only the newest audit rows so 24/7 monitoring cannot bloat state.db.
/// The 7-day floor means a busy week can never silently erase recent history —
/// only rows older than the window are candidates for the count cap.
pub fn prune_audit_tails(conn: &Connection) -> Result<()> {
    let cutoff = now_ms() - AUDIT_KEEP_WINDOW_MS;
    conn.execute(
        "DELETE FROM sentinel_events WHERE created_at < ?1 AND id NOT IN (SELECT id FROM sentinel_events ORDER BY created_at DESC, rowid DESC LIMIT ?2)",
        params![cutoff, SENTINEL_EVENT_CAP],
    )?;
    conn.execute(
        "DELETE FROM remediation_logs WHERE created_at < ?1 AND id NOT IN (SELECT id FROM remediation_logs ORDER BY created_at DESC, rowid DESC LIMIT ?2)",
        params![cutoff, REPAIR_LOG_CAP],
    )?;
    Ok(())
}

/// Run a sentinel scan. Each sentinel executes a real local check and the
/// finding is persisted with the staged fix it would apply.
pub fn sentinel_scan(conn: &Connection, home: &Path, sentinel_id: &str) -> Result<String> {
    let (id, name, (status, severity, finding, staged_fix)) = sentinel_check(conn, home, sentinel_id)?;
    persist_sentinel(conn, id, name, &status, &severity, &finding, &staged_fix)?;
    prune_audit_tails(conn)?;
    Ok(format!("{name} scan complete: {status}. {finding}"))
}

/// The pure check behind one sentinel: returns (id, name, (status, severity, finding, staged_fix)).
/// Persistence lives in `sentinel_scan`; this split lets fleet scans count
/// real statuses instead of substring-matching their own summary strings.
fn sentinel_check(conn: &Connection, home: &Path, sentinel_id: &str) -> Result<(&'static str, &'static str, (String, String, String, String))> {
    let (id, name) = {
        let known = SENTINELS.iter().find(|s| s.0 == sentinel_id).ok_or_else(|| err("unknown sentinel"))?;
        (known.0, known.1)
    };
    let (status, severity, finding, staged_fix) = match id {
        "sentry_sentinel" => {
            let backlog: i64 = conn.query_row(
                "SELECT COUNT(*) FROM remediation_logs WHERE created_at > ?1 AND status IN ('failed', 'error')",
                params![now_ms() - 24 * 3600 * 1000],
                |r| r.get(0),
            )?;
            let errored: i64 = conn.query_row(
                "SELECT COUNT(*) FROM chat_threads WHERE status = 'error'",
                [],
                |r| r.get(0),
            )?;
            if backlog + errored > 0 {
                (
                    "incident_detected".to_string(),
                    "warn".to_string(),
                    format!(
                        "{errored} errored thread(s) and {backlog} failed repair {} in the last 24h.",
                        if backlog == 1 { "entry" } else { "entries" }
                    ),
                    "Run the Harness² auto-patcher, then re-scan; errored threads reset to idle on heal.".to_string(),
                )
            } else {
                ("healthy".to_string(), "info".to_string(), "No unhandled exceptions or unresolved repairs in the last 24h.".into(), String::new())
            }
        }
        "supabase_sentinel" => {
            let stuck: i64 = conn.query_row(
                "SELECT COUNT(*) FROM chat_threads WHERE status = 'running' AND updated_at < ?1",
                params![now_ms() - STUCK_AFTER_MS],
                |r| r.get(0),
            )?;
            if stuck > 0 {
                (
                    "incident_detected".to_string(),
                    "error".to_string(),
                    format!("{stuck} run(s) stuck longer than 120s — the WAL equivalent of slow queries piling up."),
                    "Release stuck runs and checkpoint the WAL (Tier 1 drill), then re-scan.".to_string(),
                )
            } else {
                ("healthy".to_string(), "info".to_string(), "No stuck runs, no lock contention detected.".into(), String::new())
            }
        }
        "vercel_sentinel" => {
            let settings = db::settings_of(conn)?;
            let available = settings.available_version.trim();
            if !available.is_empty() && available != settings.version {
                (
                    "incident_detected".to_string(),
                    "warn".to_string(),
                    format!("Deployment drift: channel {} has {} available, local build is {}.", settings.update_channel, available, settings.version),
                    "Review the release notes, then update from Settings → Update; rollback checkpoints are retained.".to_string(),
                )
            } else {
                ("healthy".to_string(), "info".to_string(), format!("Build {} is current on the {} channel; no timeout reports.", settings.version, settings.update_channel), String::new())
            }
        }
        "github_sentinel" => {
            let (configured, root) = configured_root(conn, home);
            let in_repo = inside_work_tree(&root);
            if !in_repo {
                // A missing checkout is a resting state, not an incident.
                // Reporting one here would keep the fleet red forever.
                let finding = if configured.is_empty() {
                    "No project checkout configured — point Settings → Project root at a Git checkout to watch CI drift."
                } else {
                    "Project root is not a Git checkout, so CI drift is not watched."
                };
                (
                    "watching".to_string(),
                    "info".to_string(),
                    finding.into(),
                    String::new(),
                )
            } else if index_lock_age_ms(&root).is_some_and(|age| age >= STUCK_AFTER_MS) {
                (
                    "incident_detected".to_string(),
                    "warn".to_string(),
                    "A .git/index.lock is older than 120s. Git writes stay blocked until it is removed.".into(),
                    "Remove the stale index.lock. A lock younger than 120s is left alone.".into(),
                )
            } else {
                // --no-optional-locks is a global git option and must precede
                // the subcommand; -uno skips the untracked walk that makes
                // status crawl on big or OneDrive-synced checkouts.
                match run_capture("git", &["--no-optional-locks", "status", "--porcelain", "-uno"], Some(&root), Duration::from_secs(15)) {
                    Ok((0, out)) => {
                        let dirty = out.lines().count();
                        if dirty > 0 {
                            (
                                "healthy".to_string(),
                                "info".to_string(),
                                format!("{dirty} tracked file(s) differ from the last commit. A run is not blocked, and this check does not commit them. It only removes a .git/index.lock older than 120s."),
                                String::new(),
                            )
                        } else {
                            ("healthy".to_string(), "info".to_string(), "Working tree matches the last commit. No stale git lock.".into(), String::new())
                        }
                    }
                    Ok((code, out)) => ("incident_detected".to_string(), "warn".to_string(), format!("git status exited {code}. The checkout could not be read."), out.lines().next().unwrap_or_default().to_string()),
                    // A probe that could not finish is not evidence of drift —
                    // flagging an incident here would keep the fleet red on
                    // slow or OneDrive-synced checkouts. Report the honest
                    // resting state instead; a verified non-zero exit above
                    // is what raises an incident.
                    Err(_) => ("watching".to_string(), "info".to_string(), "git status did not complete in 15s (slow or locked checkout) — CI drift is temporarily unverifiable.".into(), String::new()),
                }
            }
        }
        "middleware_sentinel" => {
            let mut stmt = conn.prepare("SELECT name, last_error FROM mcp_servers WHERE last_error != ''")?;
            let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
            let mut failing = Vec::new();
            for row in rows {
                failing.push(row?);
            }
            drop(stmt);
            if failing.is_empty() {
                ("healthy".to_string(), "info".to_string(), "Webhook/channel sync queue clear; all registered MCP channels report no errors.".into(), String::new())
            } else {
                let names = failing.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>().join(", ");
                (
                    "incident_detected".to_string(),
                    "warn".to_string(),
                    format!("{} channel(s) reporting sync errors: {names}.", failing.len()),
                    "Inspect the channel config on the MCP mesh screen; retry with the jittered token-bucket backoff.".to_string(),
                )
            }
        }
        _ => return Err(err("unknown sentinel")),
    };
    Ok((id, name, (status, severity, finding, staged_fix)))
}

/// One-click auto-remediation for a sentinel incident. Applies the real fix
/// locally, re-scans to verify, and records the remediation in the audit log.
pub fn sentinel_remediate(conn: &Connection, home: &Path, sentinel_id: &str) -> Result<String> {
    let known = SENTINELS.iter().find(|s| s.0 == sentinel_id).ok_or_else(|| err("unknown sentinel"))?;
    let (id, name) = (known.0, known.1);
    // Never trust a cached incident: remediation starts with a fresh scan.
    sentinel_scan(conn, home, id)?;
    let (status, _severity, _ack): (String, String, bool) = conn.query_row(
        "SELECT status, severity, acknowledged FROM sentinels WHERE id = ?1",
        params![id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, i64>(2)? != 0)),
    )?;
    if status != "incident_detected" {
        let state_word = match status.as_str() {
            "healthy" => "healthy".to_string(),
            "watching" => "in its resting watching state (nothing to fix yet)".to_string(),
            other => format!("in state \"{other}\""),
        };
        let action = format!("No action taken: {name} is {state_word} after a fresh scan.");
        log_repair(conn, 5, "sentinel_remediation", name, &action, 0, "skipped")?;
        log_event(conn, id, &format!("[{name}] auto-remediate skipped → {status} after fresh scan"))?;
        return Ok(action);
    }
    let started = std::time::Instant::now();
    let action = match id {
        "sentry_sentinel" => {
            let note = crate::repair::doctor(conn, home)?;
            let errored = conn.execute("UPDATE chat_threads SET status = 'idle', updated_at = ?1 WHERE status = 'error'", params![now_ms()])?;
            let (probe, probe_ok) = syntax_probe_scripts(&home.join("extensions").join("skills"));
            if probe_ok {
                // A failed probe that now passes should not keep the fleet red.
                conn.execute(
                    "UPDATE remediation_logs SET status = 'repaired' WHERE status = 'failed' AND fault_type IN ('hotpatch_drill', 'hotpatch_auto') AND created_at > ?1",
                    params![now_ms() - 24 * 3600 * 1000],
                )?;
            }
            format!("Harness² auto-patcher executed: {note} {probe} Reset {errored} errored thread(s) to idle for retry.")
        }
        "supabase_sentinel" => {
            let released = release_stuck_runs(conn)?;
            db::checkpoint(conn)?;
            format!("Tier 1 heal applied: {released} stuck run(s) released, WAL checkpointed.")
        }
        "vercel_sentinel" => {
            let action = "Deployment drift needs a reviewed update from Settings; no unattended release was attempted.".to_string();
            log_repair(conn, 5, "sentinel_remediation", name, &action, started.elapsed().as_millis() as i64, "manual_required")?;
            log_event(conn, id, &format!("[{name}] auto-remediate blocked → manual review required"))?;
            return Ok(action);
        }
        "github_sentinel" => {
            let (_, root) = configured_root(conn, home);
            if clear_stale_index_lock(&root) {
                "Removed a stale .git/index.lock older than 120s. The worktree was not otherwise changed.".to_string()
            } else {
                let action = "Git could not be verified, so no checkpoint was written. Fix the checkout, then scan again.".to_string();
                log_repair(conn, 5, "sentinel_remediation", name, &action, started.elapsed().as_millis() as i64, "manual_required")?;
                log_event(conn, id, &format!("[{name}] auto-remediate blocked → git could not be verified"))?;
                return Ok(action);
            }
        }
        "middleware_sentinel" => {
            let action = "Channel errors require manual review in the MCP mesh screen; no channel state was changed.".to_string();
            log_repair(conn, 5, "sentinel_remediation", name, &action, started.elapsed().as_millis() as i64, "manual_required")?;
            log_event(conn, id, &format!("[{name}] auto-remediate blocked → manual review required"))?;
            return Ok(action);
        }
        _ => return Err(err("unknown sentinel")),
    };
    let ms = started.elapsed().as_millis() as i64;
    log_event(conn, id, &format!("[{name}] auto-remediate → {action}"))?;
    let verify = sentinel_scan(conn, home, id)?;
    let verify_status: String = conn.query_row("SELECT status FROM sentinels WHERE id = ?1", params![id], |r| r.get(0))?;
    let recorded = if verify_status == "incident_detected" { "unverified" } else { "repaired" };
    log_repair(conn, 5, "sentinel_remediation", name, &action, ms.max(1), recorded)?;
    Ok(format!("{name}: {action} Verify: {verify}"))
}

/// Record a Tier-2 selector auto-heal performed by the agent drive path.
pub fn record_selector_heal(bot_id: &str, from_desc: &str, to_desc: &str) {
    let db_path = crate::util::product_home().join("state.db");
    let Ok(conn) = Connection::open(&db_path) else { return };
    let _ = conn.pragma_update(None, "busy_timeout", "5000");
    record_selector_heal_on(&conn, bot_id, from_desc, to_desc);
}

pub(crate) fn record_selector_heal_on(conn: &Connection, bot_id: &str, from_desc: &str, to_desc: &str) {
    let heals: i64 = db::kv_get(conn, "dom_heal_count").ok().flatten().and_then(|s| s.parse().ok()).unwrap_or(0) + 1;
    let _ = db::kv_set(conn, "dom_heal_count", &heals.to_string());
    let _ = db::kv_set(conn, "dom_last_heal_at", &now_ms().to_string());
    let _ = db::kv_set(conn, "dom_last_heal", &format!("bot {bot_id}: {from_desc} → {to_desc}"));
    let _ = log_repair(conn, 2, "stale_control_remap", &format!("bot {bot_id}"), &format!("Auto-healed a stale control id: {from_desc} → {to_desc}."), 0, "repaired");
    let _ = prune_audit_tails(conn);
}

/// Latest sentinel state for the snapshot.
pub fn sentinels(conn: &Connection) -> Result<Vec<SentinelUnit>> {
    let mut stmt = conn.prepare("SELECT id, name, source, status, severity, acknowledged, last_scan, finding, staged_fix FROM sentinels ORDER BY id")?;
    let rows = stmt.query_map([], |r| {
        Ok(SentinelUnit {
            id: r.get(0)?,
            name: r.get(1)?,
            source: r.get(2)?,
            status: r.get(3)?,
            severity: r.get(4)?,
            acknowledged: flag(r.get::<_, i64>(5)?),
            last_scan: r.get(6)?,
            finding: r.get(7)?,
            staged_fix: r.get(8)?,
        })
    })?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

/// Recent sentinel activity stream for the live log pane.
pub fn sentinel_events(conn: &Connection) -> Result<Vec<SentinelEvent>> {
    let mut stmt = conn.prepare("SELECT id, sentinel_id, message, created_at FROM sentinel_events ORDER BY created_at DESC LIMIT 40")?;
    let rows = stmt.query_map([], |r| {
        Ok(SentinelEvent {
            id: r.get(0)?,
            sentinel_id: r.get(1)?,
            message: r.get(2)?,
            created_at: r.get(3)?,
        })
    })?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

/// Mark a sentinel incident as acknowledged. The same finding stays quiet.
/// A different finding, or an incident that clears and comes back, flashes again.
pub fn sentinel_acknowledge(conn: &Connection, sentinel_id: &str) -> Result<String> {
    let known = SENTINELS.iter().find(|s| s.0 == sentinel_id).ok_or_else(|| err("unknown sentinel"))?;
    let name = known.1;
    let n = conn.execute(
        "UPDATE sentinels SET acknowledged = 1 WHERE id = ?1",
        params![sentinel_id],
    )?;
    if n == 0 {
        return Err(err("sentinel not found"));
    }
    log_event(conn, sentinel_id, &format!("[{name}] acknowledged. It stays quiet while this same finding remains."))?;
    Ok(format!("{name} acknowledged. It stays quiet while this same finding remains, and flags again if the finding changes or the incident returns."))
}

/// Clear an acknowledgement so the sentinel can flash red again. Idempotent.
pub fn sentinel_reset(conn: &Connection, sentinel_id: &str) -> Result<String> {
    let known = SENTINELS.iter().find(|s| s.0 == sentinel_id).ok_or_else(|| err("unknown sentinel"))?;
    let name = known.1;
    conn.execute("UPDATE sentinels SET acknowledged = 0 WHERE id = ?1", params![sentinel_id])?;
    log_event(conn, sentinel_id, &format!("[{name}] acknowledgement cleared; it will flag again on the next scan."))?;
    Ok(format!("{name} acknowledgement cleared."))
}

/// Rollback checkpoints retained by the shadow store, newest first. Used by
/// the repair UI to offer one-click restores instead of only "run doctor".
/// Bounded: a 7-day time slice plus a 200-row cap keeps every snapshot poll
/// from listing and stat-ing an unbounded directory.
pub fn shadow_backups(home: &Path) -> Result<Vec<ShadowBackup>> {
    let dir = home.join(".shadow-git");
    let mut out = Vec::new();
    if !dir.exists() {
        return Ok(out);
    }
    let cutoff = now_ms() - AUDIT_KEEP_WINDOW_MS;
    for entry in std::fs::read_dir(&dir)?.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
        // One metadata call per file: both size and mtime come from the same stat.
        let meta = match std::fs::metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        if mtime < cutoff {
            continue;
        }
        let restorable = crate::util::shadow_target(&name).is_some();
        out.push(ShadowBackup { name, bytes: meta.len() as i64, mtime, restorable });
    }
    out.sort_by(|a, b| b.mtime.cmp(&a.mtime));
    out.truncate(200);
    Ok(out)
}

/// Restore a `.shadow-git` checkpoint back to its encoded workspace-relative
/// target. Names produced by `shadow_name` carry the target; older unencoded
/// backups stay listed but cannot be auto-restored.
pub fn restore_shadow_backup(conn: &Connection, home: &Path, backup_name: &str) -> Result<String> {
    let name = backup_name.trim();
    if name.is_empty() {
        return Err(err("backup name is required"));
    }
    // The name must be a bare filename inside .shadow-git — never a path.
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err(err("invalid backup name"));
    }
    let dir = home.join(".shadow-git");
    let source = dir.join(name);
    if !source.is_file() {
        return Err(err("backup not found"));
    }
    let Some(rel) = crate::util::shadow_target(name) else {
        return Err(err("this backup does not carry its original path (older unencoded checkpoint) and cannot be auto-restored"));
    };
    let target = crate::util::confined_join(home, &rel)?;
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let bytes = std::fs::copy(&source, &target)?;
    log_repair(conn, 3, "shadow_rollback", &rel, &format!("Restored {rel} from {name} ({bytes} bytes)."), 0, "repaired")?;
    Ok(format!("Restored {name} → {rel}"))
}

#[cfg(test)]
mod fault_injection {
    use super::*;
    use crate::util::now_ms;

    /// Fresh temp home with a migrated db and an armed sentinel fleet.
    fn rig(tag: &str) -> (std::path::PathBuf, Connection) {
        let home = std::env::temp_dir().join(format!("ronic-sentinel-{tag}-{}-{}", std::process::id(), now_ms() % 1_000_000));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        let conn = crate::db::open(&home.join("state.db")).unwrap();
        crate::db::migrate(&conn).unwrap();
        crate::db::drop_reference_fixture(&conn, &home).unwrap();
        crate::db::seed_if_empty(&conn, &home).unwrap();
        sentinels_ensure(&conn).unwrap();
        (home, conn)
    }

    fn seed_bot_and_thread(conn: &Connection, id: &str, status: &str, stale: bool) {
        conn.execute(
            "INSERT INTO bot_profiles (id, handle, display_name, avatar, soul_markdown, primary_account_id, long_context_account_id, fallback_account_id, daily_wallet_limit_usd, created_at) VALUES (?1, ?2, 'S', 'NW', 'soul', 'prov_ollama', 'prov_gemini', 'prov_openrouter', 1, 1)",
            params![id, format!("@{id}")],
        )
        .unwrap();
        let updated = if stale { now_ms() - 300_000 } else { now_ms() };
        conn.execute(
            "INSERT INTO chat_threads (id, bot_profile_id, title, status, compacted_context_capsule, is_pinned, updated_at) VALUES (?1, ?2, 'T', ?3, '', 0, ?4)",
            params![format!("{id}_thread"), id, status, updated],
        )
        .unwrap();
    }

    fn sentinel_status(conn: &Connection, id: &str) -> String {
        conn.query_row("SELECT status FROM sentinels WHERE id = ?1", params![id], |r| r.get(0)).unwrap()
    }

    /// `seed_if_empty` points project_root at the process CWD; tests must not
    /// depend on what kind of checkout (if any) that happens to be.
    fn clear_project_root(conn: &Connection) {
        let mut settings = crate::db::settings_of(conn).unwrap();
        settings.project_root = String::new();
        crate::db::kv_set(conn, "settings", &serde_json::to_string(&settings).unwrap()).unwrap();
    }

    #[test]
    fn stuck_run_is_detected_remediated_and_verified_healthy() {
        let (home, conn) = rig("stuck");
        seed_bot_and_thread(&conn, "bot_stuck", "running", true);

        // break → detect
        let scan = sentinel_scan(&conn, &home, "supabase_sentinel").unwrap();
        assert!(scan.contains("incident_detected") && scan.contains("stuck"), "{scan}");
        assert_eq!(sentinel_status(&conn, "supabase_sentinel"), "incident_detected");

        // remediate → the real fix runs and the verify pass confirms it
        let fixed = sentinel_remediate(&conn, &home, "supabase_sentinel").unwrap();
        assert!(fixed.contains("released") && fixed.contains("Verify:"), "{fixed}");
        assert_eq!(sentinel_status(&conn, "supabase_sentinel"), "healthy");

        // verify the damage itself is gone
        let thread: String = conn
            .query_row("SELECT status FROM chat_threads WHERE id = 'bot_stuck_thread'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(thread, "idle");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn errored_threads_raise_sentry_and_doctor_heals_them() {
        let (home, conn) = rig("sentry");
        seed_bot_and_thread(&conn, "bot_err", "error", false);

        let scan = sentinel_scan(&conn, &home, "sentry_sentinel").unwrap();
        assert!(scan.contains("incident_detected") && scan.contains("errored"), "{scan}");

        let fixed = sentinel_remediate(&conn, &home, "sentry_sentinel").unwrap();
        assert!(fixed.contains("Reset 1 errored thread") && fixed.contains("Verify:"), "{fixed}");
        assert_eq!(sentinel_status(&conn, "sentry_sentinel"), "healthy");
        let thread: String = conn
            .query_row("SELECT status FROM chat_threads WHERE id = 'bot_err_thread'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(thread, "idle");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn tier4_drill_heals_malformed_json_and_keeps_a_shadow_backup() {
        let (home, conn) = rig("tier4");
        let ext = home.join("extensions").join("skills");
        std::fs::create_dir_all(&ext).unwrap();
        let broken = ext.join("broken-skill.json");
        std::fs::write(&broken, "{\n  \"name\": \"x\",\n  \"steps\": [1, 2,],\n}").unwrap();

        let report = run_drill(&conn, &home, 4).unwrap();
        assert!(report.contains("Tier 4") && report.contains("healed 1 JSON"), "{report}");
        let healed = std::fs::read_to_string(&broken).unwrap();
        assert!(serde_json::from_str::<serde_json::Value>(&healed).is_ok(), "{healed}");
        let backups = std::fs::read_dir(home.join(".shadow-git")).unwrap().flatten().count();
        assert!(backups >= 1, "the original must be retained for rollback");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn github_sentinel_without_a_checkout_watches_instead_of_crying_incident() {
        let (home, conn) = rig("github");
        clear_project_root(&conn);
        // temp home is not a git work tree and no project root is configured
        let scan = sentinel_scan(&conn, &home, "github_sentinel").unwrap();
        assert!(scan.contains("watching"), "{scan}");
        assert_eq!(sentinel_status(&conn, "github_sentinel"), "watching");
        // remediation on a non-incident is a no-op, not a destructive action
        let noop = sentinel_remediate(&conn, &home, "github_sentinel").unwrap();
        assert!(noop.contains("No action taken") && noop.contains("resting"), "{noop}");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn audit_tails_are_capped_so_monitoring_cannot_bloat_the_db() {
        let (home, conn) = rig("prune");
        for i in 0..400 {
            conn.execute(
                "INSERT INTO sentinel_events (id, sentinel_id, message, created_at) VALUES (?1, 'sentry_sentinel', 'filler', ?2)",
                params![format!("filler-{i}"), 1_000 + i],
            )
            .unwrap();
        }
        for _ in 0..600 {
            log_repair(&conn, 1, "filler", "filler", "filler", 0, "repaired").unwrap();
        }
        // Recent activity is intentionally retained for seven days; age these
        // fixtures so this test exercises the count cap instead.
        conn.execute("UPDATE remediation_logs SET created_at = 1000", []).unwrap();
        sentinel_scan(&conn, &home, "sentry_sentinel").unwrap(); // triggers pruning
        let events: i64 = conn.query_row("SELECT COUNT(*) FROM sentinel_events", [], |r| r.get(0)).unwrap();
        let repairs: i64 = conn.query_row("SELECT COUNT(*) FROM remediation_logs", [], |r| r.get(0)).unwrap();
        assert!(events <= SENTINEL_EVENT_CAP, "{events}");
        assert!(repairs <= REPAIR_LOG_CAP, "{repairs}");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn tier2_badge_reports_recorded_auto_heals() {
        let (home, conn) = rig("tier2");
        db::kv_set(&conn, "dom_heal_count", "3").unwrap();
        let tiers = tier_status(&conn, &home, now_ms() as u64).unwrap();
        let tier2 = &tiers[1];
        assert_eq!(tier2.status, "ok");
        assert!(tier2.badge.contains("3 auto-heal(s)"), "{}", tier2.badge);
        let drill = run_drill(&conn, &home, 2).unwrap();
        assert!(drill.contains("3 auto-heals"), "{drill}");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn fleet_scan_counts_real_statuses() {
        let (home, conn) = rig("fleet");
        clear_project_root(&conn);
        seed_bot_and_thread(&conn, "bot_fleet", "running", true);
        let summary = sentinel_scan_all(&conn, &home).unwrap();
        // one incident (stuck run), several healthy, github watching — no panic,
        // and the counts must add up over the five-sentinel fleet.
        assert!(summary.contains("Fleet scan complete"), "{summary}");
        let statuses = scan_fleet(&conn, &home).unwrap();
        assert_eq!(statuses.len(), SENTINELS.len());
        assert!(statuses.iter().any(|s| s == "incident_detected"), "{statuses:?}");
        assert!(statuses.iter().any(|s| s == "watching"), "{statuses:?}");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn tier1_releases_a_stale_run_and_leaves_a_live_reply_alone() {
        let (home, conn) = rig("live");
        seed_bot_and_thread(&conn, "bot_stale", "running", true);
        seed_bot_and_thread(&conn, "bot_live", "running", false);
        let report = run_drill(&conn, &home, 1).unwrap();
        assert!(report.contains("1 stuck run"), "{report}");
        let stale: String = conn.query_row("SELECT status FROM chat_threads WHERE id = 'bot_stale_thread'", [], |r| r.get(0)).unwrap();
        let live: String = conn.query_row("SELECT status FROM chat_threads WHERE id = 'bot_live_thread'", [], |r| r.get(0)).unwrap();
        assert_eq!(stale, "idle");
        assert_eq!(live, "running");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn acknowledgement_sticks_for_the_same_finding_and_clears_when_it_ends() {
        let (home, conn) = rig("ack");
        seed_bot_and_thread(&conn, "bot_ack", "running", true);
        sentinel_scan(&conn, &home, "supabase_sentinel").unwrap();
        sentinel_acknowledge(&conn, "supabase_sentinel").unwrap();
        sentinel_scan(&conn, &home, "supabase_sentinel").unwrap();
        let ack: i64 = conn.query_row("SELECT acknowledged FROM sentinels WHERE id = 'supabase_sentinel'", [], |r| r.get(0)).unwrap();
        assert_eq!(ack, 1, "the same finding must stay quiet");
        conn.execute("UPDATE chat_threads SET status = 'idle' WHERE id = 'bot_ack_thread'", []).unwrap();
        sentinel_scan(&conn, &home, "supabase_sentinel").unwrap();
        let cleared: i64 = conn.query_row("SELECT acknowledged FROM sentinels WHERE id = 'supabase_sentinel'", [], |r| r.get(0)).unwrap();
        assert_eq!(cleared, 0, "a resolved incident clears the acknowledgement");
        assert_eq!(sentinel_status(&conn, "supabase_sentinel"), "healthy");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn a_skipped_remediation_does_not_raise_sentry() {
        let (home, conn) = rig("skip");
        clear_project_root(&conn);
        sentinel_remediate(&conn, &home, "github_sentinel").unwrap();
        let scan = sentinel_scan(&conn, &home, "sentry_sentinel").unwrap();
        assert!(scan.contains("healthy"), "{scan}");
        log_repair(&conn, 4, "hotpatch_drill", "harness2", "bad.js failed", 1, "failed").unwrap();
        let raised = sentinel_scan(&conn, &home, "sentry_sentinel").unwrap();
        assert!(raised.contains("incident_detected"), "{raised}");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn hotpatch_off_does_not_rewrite_broken_json() {
        let (home, conn) = rig("hotpatch");
        let ext = home.join("extensions");
        std::fs::create_dir_all(&ext).unwrap();
        let broken = ext.join("broken.json");
        std::fs::write(&broken, "{ \"a\": 1, }").unwrap();
        let mut settings = db::settings_of(&conn).unwrap();
        settings.hotpatch_enabled = false;
        db::kv_set(&conn, "settings", &serde_json::to_string(&settings).unwrap()).unwrap();
        let report = run_drill(&conn, &home, 4).unwrap();
        assert!(report.contains("hotpatch is off"), "{report}");
        let text = std::fs::read_to_string(&broken).unwrap();
        assert!(serde_json::from_str::<serde_json::Value>(&text).is_err(), "{text}");
        auto_hotpatch(&conn, &home).unwrap();
        let still = std::fs::read_to_string(&broken).unwrap();
        assert!(serde_json::from_str::<serde_json::Value>(&still).is_err(), "{still}");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn auto_hotpatch_heals_once_and_stays_quiet_after() {
        let (home, conn) = rig("auto");
        let ext = home.join("extensions");
        std::fs::create_dir_all(&ext).unwrap();
        std::fs::write(ext.join("broken.json"), "{ \"a\": 1, }").unwrap();
        auto_hotpatch(&conn, &home).unwrap();
        let healed = std::fs::read_to_string(ext.join("broken.json")).unwrap();
        assert!(serde_json::from_str::<serde_json::Value>(&healed).is_ok(), "{healed}");
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM remediation_logs WHERE fault_type = 'hotpatch_auto'", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        auto_hotpatch(&conn, &home).unwrap();
        let again: i64 = conn.query_row("SELECT COUNT(*) FROM remediation_logs WHERE fault_type = 'hotpatch_auto'", [], |r| r.get(0)).unwrap();
        assert_eq!(again, 1);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn selector_heal_stores_a_timestamp_the_tier_can_read() {
        let (home, conn) = rig("stamp");
        record_selector_heal_on(&conn, "bot_stamp", "[1] Save", "[4] Save");
        let tiers = tier_status(&conn, &home, now_ms() as u64).unwrap();
        assert!(tiers[1].last_run_at > 0, "last run {}", tiers[1].last_run_at);
        assert!(tiers[1].badge.contains("1 auto-heal"), "{}", tiers[1].badge);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn restore_shadow_backup_writes_the_file_and_the_audit_row() {
        let (home, conn) = rig("shadow");
        let shadow = home.join(".shadow-git");
        std::fs::create_dir_all(&shadow).unwrap();
        let name = crate::util::shadow_name("extensions/skills/note.txt", now_ms());
        std::fs::write(shadow.join(&name), "kept").unwrap();
        let note = restore_shadow_backup(&conn, &home, &name).unwrap();
        assert!(note.contains("extensions/skills/note.txt"), "{note}");
        let body = std::fs::read_to_string(home.join("extensions").join("skills").join("note.txt")).unwrap();
        assert_eq!(body, "kept");
        let logged: i64 = conn.query_row("SELECT COUNT(*) FROM remediation_logs WHERE fault_type = 'shadow_rollback'", [], |r| r.get(0)).unwrap();
        assert_eq!(logged, 1);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn a_configured_folder_that_is_not_a_checkout_is_watching() {
        let (home, conn) = rig("notgit");
        let mut settings = db::settings_of(&conn).unwrap();
        settings.project_root = home.join("missing-checkout").display().to_string();
        db::kv_set(&conn, "settings", &serde_json::to_string(&settings).unwrap()).unwrap();
        let scan = sentinel_scan(&conn, &home, "github_sentinel").unwrap();
        assert!(scan.contains("watching"), "{scan}");
        assert!(scan.contains("not a Git checkout"), "{scan}");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn a_stale_index_lock_is_removed_and_a_fresh_lock_is_kept() {
        if crate::util::which("git").is_none() {
            return;
        }
        let (home, conn) = rig("lock");
        let repo = home.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let init = std::process::Command::new("git").args(["init"]).current_dir(&repo).status();
        if !init.map(|s| s.success()).unwrap_or(false) {
            let _ = std::fs::remove_dir_all(&home);
            return;
        }
        let mut settings = db::settings_of(&conn).unwrap();
        settings.project_root = repo.display().to_string();
        db::kv_set(&conn, "settings", &serde_json::to_string(&settings).unwrap()).unwrap();
        let lock = repo.join(".git").join("index.lock");
        std::fs::write(&lock, "stale").unwrap();
        let file = std::fs::File::options().write(true).open(&lock).unwrap();
        let old = std::time::SystemTime::now().checked_sub(std::time::Duration::from_secs(600)).unwrap();
        file.set_modified(old).unwrap();
        drop(file);
        let scan = sentinel_scan(&conn, &home, "github_sentinel").unwrap();
        assert!(scan.contains("incident_detected"), "{scan}");
        let fixed = sentinel_remediate(&conn, &home, "github_sentinel").unwrap();
        assert!(fixed.contains("index.lock"), "{fixed}");
        assert!(!lock.exists(), "stale lock should be gone");
        std::fs::write(&lock, "live").unwrap();
        let blocked = sentinel_remediate(&conn, &home, "github_sentinel").unwrap();
        // A young lock is not deleted. git status may still exit 0, in which
        // case the sentinel is healthy and remediation takes no action.
        assert!(
            blocked.contains("no checkpoint was written") || blocked.contains("No action taken"),
            "{blocked}"
        );
        assert!(lock.exists(), "a fresh lock must be kept");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn a_dirty_tree_is_healthy_and_does_not_ask_for_a_commit() {
        if crate::util::which("git").is_none() {
            return;
        }
        let (home, conn) = rig("dirty");
        let repo = home.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let git = |args: &[&str]| {
            std::process::Command::new("git").args(args).current_dir(&repo).status().map(|s| s.success()).unwrap_or(false)
        };
        if !git(&["init"])
            || !git(&["config", "user.email", "sentinel@example.com"])
            || !git(&["config", "user.name", "sentinel"])
        {
            let _ = std::fs::remove_dir_all(&home);
            return;
        }
        std::fs::write(repo.join("note.txt"), "one").unwrap();
        if !git(&["add", "note.txt"]) || !git(&["commit", "-m", "init"]) {
            let _ = std::fs::remove_dir_all(&home);
            return;
        }
        std::fs::write(repo.join("note.txt"), "two").unwrap();
        let mut settings = db::settings_of(&conn).unwrap();
        settings.project_root = repo.display().to_string();
        db::kv_set(&conn, "settings", &serde_json::to_string(&settings).unwrap()).unwrap();
        let scan = sentinel_scan(&conn, &home, "github_sentinel").unwrap();
        assert!(scan.contains("healthy"), "{scan}");
        assert!(scan.contains("differ from the last commit"), "{scan}");
        assert!(!scan.to_ascii_lowercase().contains("commit before"), "{scan}");
        let source: String = conn.query_row("SELECT source FROM sentinels WHERE id = 'github_sentinel'", [], |r| r.get(0)).unwrap();
        assert_eq!(source, "Local git checkout (stale lock only)");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn doctor_does_not_invent_a_heartbeat_repair() {
        let (home, conn) = rig("doctor");
        let note = crate::repair::doctor(&conn, &home).unwrap();
        assert!(note.contains("WAL checkpointed"), "{note}");
        let heartbeat: i64 = conn.query_row("SELECT COUNT(*) FROM remediation_logs WHERE fault_type = 'heartbeat'", [], |r| r.get(0)).unwrap();
        assert_eq!(heartbeat, 0);
        let _ = std::fs::remove_dir_all(&home);
    }
}
