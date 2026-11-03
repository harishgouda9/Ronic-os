//! Local kernel maintenance — the "Storage, WAL & backups" tab of Settings.
//! Everything here runs against the real workspace on disk: state.db, its WAL,
//! the .shadow-git snapshot store, and folder copies for backups.

use crate::AppState;
use crate::util::documents_dir;
use serde_json::{json, Value};
use tauri::State;

fn file_len(path: &std::path::Path) -> u64 {
    std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

fn walk_files(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk_files(&path, out);
        } else if path.is_file() {
            out.push(path);
        }
    }
}

fn copy_tree(from: &std::path::Path, to: &std::path::Path) -> std::result::Result<u64, String> {
    std::fs::create_dir_all(to).map_err(|e| e.to_string())?;
    let mut total = 0u64;
    for entry in std::fs::read_dir(from).map_err(|e| e.to_string())?.flatten() {
        let target = to.join(entry.file_name());
        let path = entry.path();
        if path.is_dir() {
            total += copy_tree(&path, &target)?;
        } else if path.is_file() {
            let bytes = file_len(&path);
            std::fs::copy(&path, &target).map_err(|e| e.to_string())?;
            total += bytes;
        }
    }
    Ok(total)
}

fn count_i64(conn: &rusqlite::Connection, sql: &str) -> i64 {
    conn.query_row(sql, [], |row| row.get::<_, i64>(0)).unwrap_or(0)
}

#[tauri::command]
pub async fn kernel_diagnostics(state: State<'_, AppState>) -> std::result::Result<Value, String> {
    let inner = state.inner();
    let value = {
        let conn = inner.conn.lock().unwrap_or_else(|e| e.into_inner());
        let page_size: i64 = conn.query_row("PRAGMA page_size", [], |r| r.get(0)).unwrap_or(0);
        let page_count: i64 = conn.query_row("PRAGMA page_count", [], |r| r.get(0)).unwrap_or(0);
        let freelist: i64 = conn.query_row("PRAGMA freelist_count", [], |r| r.get(0)).unwrap_or(0);
        let journal: String = conn.query_row("PRAGMA journal_mode", [], |r| r.get::<_, String>(0)).unwrap_or_default();
        json!({
            "dbBytes": (page_size.max(0) as u64) * (page_count.max(0) as u64),
            "walBytes": file_len(&inner.home.join("state.db-wal")),
            "journalMode": journal,
            "freelistBytes": (page_size.max(0) as u64) * (freelist.max(0) as u64),
            "memories": count_i64(&conn, "SELECT COUNT(*) FROM memory_items"),
            "threads": count_i64(&conn, "SELECT COUNT(*) FROM chat_threads"),
            "steps": count_i64(&conn, "SELECT COUNT(*) FROM execution_steps"),
            "profiles": count_i64(&conn, "SELECT COUNT(*) FROM bot_profiles"),
            "heartbeatMs": inner.heartbeat.load(std::sync::atomic::Ordering::Relaxed) as i64,
        })
    };
    let mut shadow = Vec::new();
    walk_files(&inner.home.join(".shadow-git"), &mut shadow);
    let shadow_bytes: u64 = shadow.iter().map(|p| file_len(p)).sum();
    let mut backups = Vec::new();
    walk_files(&inner.home.join("backups"), &mut backups);
    Ok(json!({
        "db": value,
        "shadowFiles": shadow.len(),
        "shadowBytes": shadow_bytes,
        "backupCount": backups.len(),
        "homeDir": inner.home.display().to_string(),
    }))
}

#[tauri::command]
pub async fn db_maintenance(state: State<'_, AppState>) -> std::result::Result<Value, String> {
    let inner = state.inner();
    let wal_before = file_len(&inner.home.join("state.db-wal"));
    let result = {
        let conn = inner.conn.lock().unwrap_or_else(|e| e.into_inner());
        // Fold the WAL back into the main file, then compact. The mutex makes
        // this exclusive to the app, so no other statement interleaves.
        let _: i64 = conn
            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        conn.execute_batch("VACUUM").map_err(|e| e.to_string())?;
        let page_size: i64 = conn.query_row("PRAGMA page_size", [], |r| r.get(0)).unwrap_or(0);
        let page_count: i64 = conn.query_row("PRAGMA page_count", [], |r| r.get(0)).unwrap_or(0);
        let freelist: i64 = conn.query_row("PRAGMA freelist_count", [], |r| r.get(0)).unwrap_or(0);
        (page_size, page_count, freelist)
    };
    let (page_size, page_count, freelist) = result;
    let db_bytes = (page_size.max(0) as u64) * (page_count.max(0) as u64);
    let freed = wal_before + (page_size.max(0) as u64) * (freelist.max(0) as u64);
    Ok(json!({
        "dbBytes": db_bytes,
        "walBytes": file_len(&inner.home.join("state.db-wal")),
        "freedBytes": freed,
    }))
}

#[tauri::command]
pub async fn shadow_git_prune(state: State<'_, AppState>, days: Option<i64>) -> std::result::Result<Value, String> {
    let inner = state.inner();
    let keep_days = days.unwrap_or(14).clamp(1, 365);
    let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs((keep_days * 86_400) as u64);
    let mut files = Vec::new();
    walk_files(&inner.home.join(".shadow-git"), &mut files);
    let mut removed = 0usize;
    let mut freed = 0u64;
    for path in files {
        let old = std::fs::metadata(&path)
            .and_then(|m| m.modified())
            .map(|modified| modified < cutoff)
            .unwrap_or(false);
        if old {
            let bytes = file_len(&path);
            if std::fs::remove_file(&path).is_ok() {
                removed += 1;
                freed += bytes;
            }
        }
    }
    Ok(json!({ "removed": removed as u64, "freedBytes": freed, "keptDays": keep_days }))
}

#[tauri::command]
pub async fn workspace_backup(state: State<'_, AppState>) -> std::result::Result<Value, String> {
    let inner = state.inner();
    // Fold the WAL first so the copied state.db is complete.
    {
        let conn = inner.conn.lock().unwrap_or_else(|e| e.into_inner());
        let _: i64 = conn
            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
    }
    let stamp = chrono_like_stamp();
    let documents = documents_dir();
    let dest = documents.join("Ronic OS backups").join(format!("ronic-backup-{stamp}"));
    std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
    let mut copied = 0u64;
    copied += std::fs::copy(inner.home.join("state.db"), dest.join("state.db")).map_err(|e| e.to_string())?;
    for dir in ["bots", "skills", "profiles", "mcp", "workflows", "extensions", "tickets", "engines"] {
        let from = inner.home.join(dir);
        if from.is_dir() {
            copied += copy_tree(&from, &dest.join(dir))?;
        }
    }
    let manifest = json!({
        "createdAt": stamp,
        "app": "Ronic OS",
        "homeDir": inner.home.display().to_string(),
        "contents": "state.db + bots + skills + profiles + mcp + workflows + extensions + tickets + engines",
    });
    std::fs::write(dest.join("manifest.json"), serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    Ok(json!({ "path": dest.display().to_string(), "bytes": copied }))
}

fn chrono_like_stamp() -> String {
    let now = now_unix();
    let secs_per_day = 86_400;
    let days = now.div_euclid(secs_per_day);
    let secs = now.rem_euclid(secs_per_day);
    // Civil-from-days (Howard Hinnant's algorithm) — no chrono dependency.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    let hour = secs / 3600;
    let minute = (secs % 3600) / 60;
    let second = secs % 60;
    format!("{y:04}{m:02}{d:02}-{hour:02}{minute:02}{second:02}")
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    #[test]
    fn stamp_shape() {
        let stamp = super::chrono_like_stamp();
        assert_eq!(stamp.len(), 15, "{stamp}"); // YYYYMMDD-HHMMSS
        assert!(stamp.as_bytes()[8] == b'-');
    }
}
