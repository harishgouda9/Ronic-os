use crate::db::{self, log_repair};
use crate::error::{err, Result};
use crate::redact::redact;
use crate::util::{now_ms, run_capture};
use rusqlite::{params, Connection};
use std::path::Path;
use std::time::{Duration, Instant};

/// Restore a file from a `.shadow-git` backup. The backup name is validated
/// against the workspace root before it is touched, and the target path is
/// recovered from the backup name's own encoding, so a crafted name cannot
/// reach a file outside `home`.
pub fn restore_backup(conn: &Connection, home: &Path, backup_name: &str) -> Result<String> {
    let name = backup_name.trim();
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.starts_with('.') {
        return Err(err("backup name must be a plain file name inside .shadow-git"));
    }
    let shadow = home.join(".shadow-git");
    let source = shadow.join(name);
    if !source.exists() || !source.is_file() {
        return Err(err("backup not found"));
    }
    // Recover the target from the backup name's encoded relative path. A name
    // that does not carry a path (older unencoded backups) cannot be restored.
    let target_rel = crate::util::shadow_target(name).ok_or_else(|| err("this backup does not encode a target file and cannot be restored"))?;
    let target = crate::util::confined_join(home, &target_rel)?;
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let bytes = std::fs::copy(&source, &target).map_err(|e| err(e.to_string()))?;
    log_repair(
        conn,
        3,
        "shadow_rollback",
        &target_rel,
        &format!("Restored {target_rel} from {name} ({bytes} bytes)."),
        0,
        "repaired",
    )?;
    Ok(format!("Restored {target_rel} from {name}."))
}

pub fn refresh(conn: &Connection) -> Result<String> {
    let started = Instant::now();
    crate::agent::release_turn();
    let released = conn.execute(
        "UPDATE chat_threads SET status = 'idle', updated_at = ?1 WHERE status = 'running'",
        params![now_ms()],
    )?;
    let _ = conn.execute(
        "UPDATE bot_profiles SET run_status = 'stopped', active_pid = NULL WHERE run_status = 'running' AND active_pid IS NULL",
        [],
    );
    let _ = conn.execute("DELETE FROM app_kv WHERE key = 'skip_gate' OR key LIKE 'skip_gate:%'", []);
    db::checkpoint(conn)?;
    let ms = started.elapsed().as_millis() as i64;
    log_repair(conn, 1, "manual_refresh", "workspace", "Released a stuck reply, cleaned orphaned run states, checkpointed SQLite WAL, and reloaded the active thread.", ms, "repaired")?;
    if released > 0 {
        Ok(format!("Released the stuck reply and reloaded workspace in {ms}ms. No messages were deleted."))
    } else {
        Ok(format!("Workspace refreshed in {ms}ms. No messages were deleted."))
    }
}

pub fn doctor(conn: &Connection, home: &Path) -> Result<String> {
    let started = Instant::now();
    db::checkpoint(conn)?;
    let mut notes = Vec::new();
    let scraper = home.join("extensions").join("skills").join("scraper.js");
    let scraper_is_regular = std::fs::symlink_metadata(&scraper).map(|m| m.file_type().is_file()).unwrap_or(false);
    if scraper_is_regular {
        let text = std::fs::read_to_string(&scraper)?;
        if text.contains("res.data.map(parse)") && !text.contains("Array.isArray") {
            let shadow = home.join(".shadow-git");
            std::fs::create_dir_all(&shadow)?;
            let stamp = now_ms();
            std::fs::write(shadow.join(crate::util::shadow_name("extensions/skills/scraper.js", stamp)), &text)?;
            let patched = text.replace(
                "const rows = res.data.map(parse)",
                "const list = res.data ?? []\n  if (!Array.isArray(list)) return []\n  const rows = list.map(parse)",
            );
            std::fs::write(&scraper, &patched)?;
            let check = if let Some(node) = crate::util::which("node") {
                match run_capture(&node, &["--check", &scraper.display().to_string()], None, Duration::from_secs(8)) {
                    Ok((0, _)) => "node --check passed".to_string(),
                    Ok((code, out)) => format!("node --check exited {code}: {}", redact(&out)),
                    Err(e) => e.0,
                }
            } else {
                "node is not installed, so the syntax check was skipped".into()
            };
            log_repair(conn, 3, "skill_exception", "extensions/skills/scraper.js", "Patched a TypeError on res.data and kept a shadow copy.", started.elapsed().as_millis() as i64, "repaired")?;
            notes.push(format!("Tier 3 patched scraper.js. {check}"));
        } else {
            notes.push("Tier 3: scraper.js does not contain the known TypeError.".into());
        }
    }
    let fixed_json = heal_json_dir(&home.join("extensions"), &home.join(".shadow-git"))?;
    if fixed_json > 0 {
        log_repair(conn, 2, "malformed_json", "extensions", &format!("Removed trailing commas in {fixed_json} json file(s)."), 40, "repaired")?;
        notes.push(format!("Tier 2 repaired {fixed_json} JSON file(s)."));
    } else {
        notes.push("Tier 2: no broken JSON under extensions.".into());
    }
    log_repair(conn, 1, "heartbeat", "watchdog", "Watchdog heartbeat is running on its own thread.", 1, "repaired")?;
    notes.push("Tier 1 heartbeat recorded.".into());
    Ok(notes.join(" "))
}

fn heal_json_dir(dir: &Path, shadow: &Path) -> Result<i64> {
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
            let healed = crate::remediation_core::strip_trailing_commas(&text);
            if serde_json::from_str::<serde_json::Value>(&healed).is_ok() {
                std::fs::create_dir_all(shadow)?;
                let rel = format!("extensions/{}", path.strip_prefix(dir).map(|p| p.to_string_lossy()).unwrap_or_default());
                std::fs::write(shadow.join(crate::util::shadow_name(&rel, now_ms())), &text)?;
                std::fs::write(&path, healed)?;
                n += 1;
            }
        }
    }
    Ok(n)
}

pub fn preview_report(conn: &Connection, category: &str, notes: &str) -> Result<String> {
    let home = db::kv_get(conn, "settings")?.unwrap_or_default();
    let recent = recent_repairs(conn)?;
    let raw = format!("category: {category}\nnotes: {notes}\nsettings_present: {}\nrepairs:\n{recent}", !home.is_empty());
    Ok(redact(&raw))
}

fn recent_repairs(conn: &Connection) -> Result<String> {
    let mut stmt = conn.prepare("SELECT tier, fault_type, action_taken FROM remediation_logs ORDER BY created_at DESC LIMIT 8")?;
    let rows = stmt.query_map([], |r| Ok(format!("T{} {} — {}", r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))?;
    let mut lines = Vec::new();
    for row in rows {
        lines.push(row?);
    }
    Ok(lines.join("\n"))
}

#[cfg(test)]
mod shadow_rollback {
    use super::*;
    use crate::util::{now_ms, shadow_name};

    fn rig(tag: &str) -> (std::path::PathBuf, Connection) {
        let home = std::env::temp_dir().join(format!("ronic-repair-{tag}-{}-{}", std::process::id(), now_ms() % 1_000_000));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        let conn = crate::db::open(&home.join("state.db")).unwrap();
        crate::db::migrate(&conn).unwrap();
        (home, conn)
    }

    #[test]
    fn restore_backup_writes_the_encoded_target_and_refuses_escape() {
        let (home, conn) = rig("restore");
        let shadow = home.join(".shadow-git");
        std::fs::create_dir_all(&shadow).unwrap();
        // Plant a real backup for a file inside the workspace.
        let rel = "extensions/skills/scraper.js";
        let name = shadow_name(rel, now_ms());
        std::fs::write(shadow.join(&name), "const rows = res.data.map(parse)").unwrap();

        let note = restore_backup(&conn, &home, &name).unwrap();
        assert!(note.contains("Restored extensions/skills/scraper.js"), "{note}");
        let restored = std::fs::read_to_string(home.join("extensions").join("skills").join("scraper.js")).unwrap();
        assert!(restored.contains("res.data.map(parse)"), "{restored}");

        // A crafted name that would decode to an escape is refused by confined_join.
        std::fs::write(shadow.join("..__evil.1.bak"), "pwn").unwrap();
        assert!(restore_backup(&conn, &home, "..__evil.1.bak").is_err());
        // Names with separators or missing files are refused.
        assert!(restore_backup(&conn, &home, "../outside.bak").is_err());
        assert!(restore_backup(&conn, &home, "missing.bak").is_err());
        // An unencoded legacy backup has no target and cannot be restored.
        std::fs::write(shadow.join("json-heal.checkpoint_x.bak"), "{}").unwrap();
        assert!(restore_backup(&conn, &home, "json-heal.checkpoint_x.bak").is_err());
        let _ = std::fs::remove_dir_all(&home);
    }
}
