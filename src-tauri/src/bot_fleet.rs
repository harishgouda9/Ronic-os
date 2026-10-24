use crate::db;
use crate::error::{err, Result};
use crate::models::CommandResult;
use crate::snapshot::{self, Meta};
use crate::util::{nid, now_ms, run_capture};
use crate::AppState;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetDaemon {
    pub id: String,
    pub name: String,
    pub category: String, // "kernel" | "bot_daemon"
    pub pid: Option<i64>,
    pub status: String, // "alive" | "listening" | "running" | "ready" | "stopped" | "missing"
    pub ram_mb: i64,
    pub detail_path_or_url: String,
    pub ghost_runner_active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetRoutine {
    pub id: String,
    pub title: String,
    pub bot_handle: String,
    pub schedule: String,
    pub last_run: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetLogEntry {
    pub id: String,
    pub time: String,
    pub source: String,
    pub level: String, // "info" | "warn" | "error"
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetStatusPayload {
    pub daemons: Vec<FleetDaemon>,
    pub routines: Vec<FleetRoutine>,
    pub logs: Vec<FleetLogEntry>,
}

fn guard(state: &AppState) -> std::sync::MutexGuard<'_, Connection> {    state.conn.lock().unwrap_or_else(|e| e.into_inner())
}

fn finish_result(state: &AppState, toast: Option<String>) -> Result<CommandResult> {
    let meta = Meta {
        home: state.home.display().to_string(),
        heartbeat_ms: state.heartbeat.load(Ordering::Relaxed),
        proxy_port: state.proxy_port.load(Ordering::Relaxed),
        ipc: state.ipc.lock().unwrap_or_else(|e| e.into_inner()).iter().cloned().collect(),
        unlocked: state.unlocked.load(Ordering::Relaxed),
    };
    let conn = guard(state);
    Ok(CommandResult {
        snapshot: snapshot::load(&conn, &meta)?,
        toast,
        install_choice: None,
        payload: None,
    })
}

pub fn stop_pid_force(pid: i64) {
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

pub fn append_log(conn: &Connection, source: &str, message: &str, stream: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO fleet_logs (id, bot_name, stream, line, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![nid("flog"), source, stream, message, now_ms()],
    )?;
    Ok(())
}

fn format_time(ts_ms: i64) -> String {
    let secs = (ts_ms / 1000) % 86400;
    let hours = (secs / 3600) % 24;
    let mins = (secs % 3600) / 60;
    let s = secs % 60;
    format!("{hours:02}:{mins:02}:{s:02}")
}

pub fn get_fleet_daemons(conn: &Connection, proxy_port: u16) -> Result<Vec<FleetDaemon>> {
    let settings = db::settings_of(conn).unwrap_or_default();
    let port = if proxy_port == 0 { 4142 } else { proxy_port };

    let mut daemons = vec![
        FleetDaemon {
            id: "watchdog".into(),
            name: "watchdog".into(),
            category: "kernel".into(),
            pid: Some(std::process::id() as i64),
            status: "alive".into(),
            // Working set is not measured; 0 renders as "—" instead of a
            // made-up number.
            ram_mb: 0,
            detail_path_or_url: "500ms heartbeat & WAL guard".into(),
            ghost_runner_active: false,
        },
        FleetDaemon {
            id: "loopback_proxy".into(),
            name: "loopback-proxy".into(),
            category: "kernel".into(),
            pid: None,
            status: if proxy_port == 0 { "starting".into() } else { "listening".into() },
            ram_mb: 0,
            detail_path_or_url: format!("127.0.0.1:{port}/v1 (OpenAI-Compatible Multiplexer)"),
            ghost_runner_active: false,
        },
    ];

    // Query real linked_local_apps from database
    let mut stmt = conn.prepare(
        "SELECT id, app_name, active_pid, status, executable_path, detail FROM linked_local_apps WHERE category IN ('bot_daemon', 'bot', 'cli', 'acp_agent') AND app_name NOT IN ('Cursor', 'VS Code', 'VS Code Insiders', 'Obsidian') ORDER BY app_name"
    )?;
    let app_rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, Option<i64>>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, String>(5)?,
        ))
    })?;

    for row in app_rows {
        let (id, name, pid, status, path, detail) = row?;
        let ghost = settings.ghost_runners.iter().any(|g| g.eq_ignore_ascii_case(&id) || g.eq_ignore_ascii_case(&name));
        let exec_detail = if !path.is_empty() { path } else { detail };

        daemons.push(FleetDaemon {
            id,
            name,
            category: "bot_daemon".into(),
            pid,
            status,
            ram_mb: 0,
            detail_path_or_url: exec_detail,
            ghost_runner_active: ghost,
        });
    }

    Ok(daemons)
}

pub fn get_fleet_routines(conn: &Connection) -> Result<Vec<FleetRoutine>> {
    let mut routines = Vec::new();

    // Query real routines from chat_threads, joined to the owning bot profile
    // so the handle and last-activity time are real instead of placeholders.
    let mut stmt = conn.prepare(
        "SELECT t.id, t.title, t.routine_schedule, COALESCE(NULLIF(b.handle, ''), 'thread'), t.updated_at \
         FROM chat_threads t LEFT JOIN bot_profiles b ON b.id = t.bot_profile_id \
         WHERE t.routine_schedule IS NOT NULL AND t.routine_schedule != ''",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, i64>(4)?,
        ))
    })?;

    for row in rows.flatten() {
        let (id, title, sched, handle, updated_at) = row;
        routines.push(FleetRoutine {
            id: id.clone(),
            title: if title.trim().is_empty() { "Untitled Routine".into() } else { title },
            bot_handle: handle,
            schedule: sched,
            last_run: format!("last activity {ts}", ts = format_time(updated_at)),
            enabled: true,
        });
    }

    Ok(routines)
}

pub fn get_fleet_logs(conn: &Connection) -> Result<Vec<FleetLogEntry>> {
    let mut stmt = conn.prepare(
        "SELECT id, bot_name, stream, line, created_at FROM fleet_logs ORDER BY created_at DESC LIMIT 60"
    )?;
    let rows = stmt.query_map([], |r| {
        let id: String = r.get(0)?;
        let bot_name: String = r.get(1)?;
        let stream: String = r.get(2)?;
        let line: String = r.get(3)?;
        let created_at: i64 = r.get(4)?;

        let level = if stream == "stderr" || line.to_lowercase().contains("error") || line.to_lowercase().contains("fatal") {
            "error".to_string()
        } else if stream == "warn" || line.to_lowercase().contains("warn") || line.to_lowercase().contains("stopped") {
            "warn".to_string()
        } else {
            "info".to_string()
        };

        Ok(FleetLogEntry {
            id,
            time: format_time(created_at),
            source: bot_name,
            level,
            message: line,
        })
    })?;

    let logs: Vec<FleetLogEntry> = rows.collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(logs)
}

#[tauri::command]
pub async fn get_fleet_status(state: State<'_, AppState>) -> Result<FleetStatusPayload> {
    let port = state.proxy_port.load(Ordering::Relaxed);
    let conn = guard(&state);
    let daemons = get_fleet_daemons(&conn, port)?;
    let routines = get_fleet_routines(&conn)?;
    let logs = get_fleet_logs(&conn)?;

    Ok(FleetStatusPayload {
        daemons,
        routines,
        logs,
    })
}

#[tauri::command]
pub async fn start_fleet_daemon(state: State<'_, AppState>, id: String) -> Result<CommandResult> {
    let toast = {
        let conn = guard(&state);
        let app_info: Option<(String, String)> = conn
            .query_row(
                "SELECT app_name, executable_path FROM linked_local_apps WHERE id=?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .ok();

        let (daemon_name, path) = match app_info {
            Some((name, p)) => (name, p),
            None => return Err(err("App not found in database")),
        };

        let path_obj = Path::new(&path);
        let wsl_bin = path.strip_prefix("wsl:");
        if path.is_empty() || (wsl_bin.is_none() && !path_obj.is_file()) {
            return Err(err(format!("{daemon_name} is not installed or executable not found on disk at '{path}'.")));
        }

        match crate::workspace_apps::launch_program(path_obj) {
            Ok(child_pid) => {
                let stored_pid: Option<i64> = if child_pid == 0 { None } else { Some(child_pid as i64) };
                conn.execute(
                    "UPDATE linked_local_apps SET active_pid=?1, status='running', updated_at=?2 WHERE id=?3",
                    params![stored_pid, now_ms(), id],
                )?;
                let log_msg = if child_pid == 0 {
                    format!("started {daemon_name}")
                } else {
                    format!("started pid {child_pid}")
                };
                let _ = append_log(&conn, &daemon_name, &log_msg, "stdout");
                if child_pid == 0 {
                    format!("Started {daemon_name}.")
                } else {
                    format!("Started {daemon_name} at PID {child_pid}.")
                }
            }
            Err(e) => return Err(err(format!("Failed to start {daemon_name}: {}", e.0))),
        }
    };

    finish_result(&state, Some(toast))
}

#[tauri::command]
pub async fn stop_fleet_daemon(state: State<'_, AppState>, id: String) -> Result<CommandResult> {
    let toast = {
        let conn = guard(&state);
        let pid_opt: Option<(Option<i64>, String)> = conn
            .query_row(
                "SELECT active_pid, app_name FROM linked_local_apps WHERE id=?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .ok();

        match pid_opt {
            Some((Some(pid), name)) => {
                stop_pid_force(pid);
                conn.execute(
                    "UPDATE linked_local_apps SET active_pid=NULL, status='ready', updated_at=?1 WHERE id=?2",
                    params![now_ms(), id],
                )?;
                let _ = append_log(&conn, &name, &format!("stopped pid {pid}"), "stdout");
                format!("Stopped {name} (PID {pid}).")
            }
            Some((None, name)) => {
                conn.execute(
                    "UPDATE linked_local_apps SET active_pid=NULL, status='ready', updated_at=?1 WHERE id=?2",
                    params![now_ms(), id],
                )?;
                format!("{name} was not running.")
            }
            None => return Err(err("App not found")),
        }
    };

    finish_result(&state, Some(toast))
}

#[tauri::command]
pub async fn restart_fleet_daemon(state: State<'_, AppState>, id: String) -> Result<CommandResult> {
    let _ = stop_fleet_daemon(state.clone(), id.clone()).await;
    start_fleet_daemon(state, id).await
}

#[tauri::command]
pub async fn toggle_fleet_ghost_runner(
    state: State<'_, AppState>,
    id: String,
    enabled: bool,
) -> Result<CommandResult> {
    let daemon_name = id.clone();
    {
        let conn = guard(&state);
        let mut settings = db::settings_of(&conn).unwrap_or_default();
        if enabled {
            if !settings.ghost_runners.iter().any(|g| g.eq_ignore_ascii_case(&id)) {
                settings.ghost_runners.push(id.clone());
            }
        } else {
            settings.ghost_runners.retain(|g| !g.eq_ignore_ascii_case(&id));
        }
        db::save_settings(&conn, &settings)?;

        let state_label = if enabled { "enabled" } else { "disabled" };
        let log_line = format!("Ghost runner {state_label} for {daemon_name}");
        let _ = append_log(&conn, &daemon_name, &log_line, "stdout");
    }

    finish_result(&state, Some(format!("Ghost runner updated for {daemon_name}.")))
}

#[tauri::command]
pub async fn run_fleet_routine(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<CommandResult> {
    // If thread id exists, run the real thread routine
    let res = crate::commands::run_routine(app, state, id, None, None, None).await;
    res
}

#[tauri::command]
pub async fn send_fleet_daemon_input(
    state: State<'_, AppState>,
    id: String,
    input: String,
) -> Result<CommandResult> {
    // Daemons run in their own console, so their stdin is not reachable from
    // here. This is a note in the shared fleet log that every daemon screen
    // shows — an operator ping, not a keystroke to a process.
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return finish_result(&state, None);
    }
    let name = {
        let conn = guard(&state);
        let name: Option<String> = conn
            .query_row("SELECT app_name FROM linked_local_apps WHERE id=?1", params![id], |r| r.get(0))
            .ok();
        let source = name.as_deref().or(if id.is_empty() { Some("Fleet") } else { None }).unwrap_or(&id);
        let _ = append_log(&conn, source, &format!("operator note: {trimmed}"), "stdout");
        source.to_string()
    };
    finish_result(&state, Some(format!("Note saved to the {name} fleet log. The daemon's own stdin is not reachable from Ronic OS.")))
}

#[tauri::command]
pub async fn clear_fleet_logs(state: State<'_, AppState>) -> Result<CommandResult> {
    {
        let conn = guard(&state);
        let _ = conn.execute("DELETE FROM fleet_logs", []);
    }
    finish_result(&state, Some("Fleet logs cleared.".into()))
}
