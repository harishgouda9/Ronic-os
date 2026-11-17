//! Fires one due chat job or one due workflow while the app is open.
//! The window clock does not also fire them. Closing the app stops this thread.

use crate::util::now_ms;
use crate::AppState;
use rusqlite::{params, Connection};
use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::{AppHandle, Manager};

pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(5));
        loop {
            tick(&app);
            std::thread::sleep(Duration::from_secs(20));
        }
    });
}

fn tick(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    if !state.unlocked.load(Ordering::SeqCst) {
        return;
    }
    if crate::agent::turn_busy() {
        return;
    }
    let picked = {
        let conn = state.conn.lock().unwrap_or_else(|poison| poison.into_inner());
        pick_due(&conn)
    };
    let Some(picked) = picked else {
        return;
    };
    if crate::agent::turn_busy() {
        return;
    }
    match picked {
        Due::Routine(id) => run_routine(&state, &id),
        Due::Workflow(id) => run_workflow(&state, &id),
    }
}

enum Due {
    Routine(String),
    Workflow(String),
}

fn pick_due(conn: &Connection) -> Option<Due> {
    let now = now_ms();
    let mut routine_stmt = conn
        .prepare("SELECT id, routine_schedule, routine_armed_at, routine_fired_at, updated_at FROM chat_threads WHERE routine_schedule != '' AND status != 'paused' ORDER BY updated_at")
        .ok()?;
    let routines = routine_stmt
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?, row.get::<_, i64>(3)?, row.get::<_, i64>(4)?)))
        .ok()?
        .collect::<std::result::Result<Vec<_>, _>>()
        .ok()?;
    drop(routine_stmt);
    for (id, schedule, mut armed, fired, updated) in routines {
        if armed == 0 {
            armed = if updated > 0 { updated } else { now };
            let _ = conn.execute("UPDATE chat_threads SET routine_armed_at=?1 WHERE id=?2 AND routine_armed_at=0", params![armed, id]);
        }
        if crate::coworker::normalize_schedule(&schedule).is_some_and(|normalized| crate::coworker::due(&normalized, armed, fired, now)) {
            return Some(Due::Routine(id));
        }
    }
    let mut workflow_stmt = conn
        .prepare("SELECT id, triggers_json, armed_at, last_fired_at, updated_at, current_status FROM workflows WHERE schedule_enabled=1")
        .ok()?;
    let workflows = workflow_stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, String>(5)?,
            ))
        })
        .ok()?
        .collect::<std::result::Result<Vec<_>, _>>()
        .ok()?;
    drop(workflow_stmt);
    for (id, triggers_json, mut armed, fired, updated, status) in workflows {
        if status == "running" || status == "paused_editable" || status == "interrupted" {
            continue;
        }
        let triggers: Vec<String> = serde_json::from_str(&triggers_json).unwrap_or_default();
        if triggers.is_empty() {
            continue;
        }
        if armed == 0 {
            armed = if updated > 0 { updated } else { now };
            let _ = conn.execute("UPDATE workflows SET armed_at=?1 WHERE id=?2 AND armed_at=0", params![armed, id]);
        }
        if triggers.iter().any(|trigger| crate::coworker::normalize_schedule(trigger).is_some_and(|normalized| crate::coworker::due(&normalized, armed, fired, now))) {
            return Some(Due::Workflow(id));
        }
    }
    None
}

fn run_routine(state: &AppState, thread_id: &str) {
    let secrets = state.secrets.lock().unwrap_or_else(|poison| poison.into_inner()).clone();
    let (prompt, model) = {
        let conn = state.conn.lock().unwrap_or_else(|poison| poison.into_inner());
        let prompt = crate::bots::routine_prompt(&conn, thread_id).unwrap_or_default();
        let bot: String = conn.query_row("SELECT bot_profile_id FROM chat_threads WHERE id=?1", params![thread_id], |row| row.get(0)).unwrap_or_default();
        let model = crate::agent::claimed_model(&conn, &bot);
        (prompt, model)
    };
    if prompt.trim().is_empty() {
        mark_routine(&state, thread_id);
        return;
    }
    let model = if model.is_empty() { None } else { Some(model) };
    let _pin = crate::agent::pin_thread(thread_id);
    let result = crate::agent::dispatch(state, &prompt, &secrets, None, model.as_deref(), None, &[], None, None, None, None);
    drop(_pin);
    if result.as_ref().err().is_some_and(|error| error.0.to_ascii_lowercase().contains("still answering")) {
        return;
    }
    // Terminal failures advance the slot too; otherwise a broken routine runs
    // every 20 seconds forever. Busy-turn contention stays eligible.
    mark_routine(state, thread_id);
}

fn mark_routine(state: &AppState, thread_id: &str) {
    let conn = state.conn.lock().unwrap_or_else(|poison| poison.into_inner());
    let _ = conn.execute("UPDATE chat_threads SET routine_fired_at=?1 WHERE id=?2", params![now_ms(), thread_id]);
}

fn run_workflow(state: &AppState, id: &str) {
    let result = crate::commands::run_saved_workflow(state, id);
    if result.as_ref().err().is_some_and(|error| {
        let text = error.0.to_ascii_lowercase();
        text.contains("already in progress") || text.contains("still answering")
    }) {
        return;
    }
    let conn = state.conn.lock().unwrap_or_else(|poison| poison.into_inner());
    let _ = conn.execute("UPDATE workflows SET last_fired_at=?1 WHERE id=?2", params![now_ms(), id]);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paused_routines_and_disabled_workflows_do_not_fire() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate(&conn).unwrap();
        conn.execute(
            "INSERT INTO bot_profiles (id,handle,display_name,avatar,soul_markdown,primary_account_id,long_context_account_id,fallback_account_id,created_at) VALUES ('bot_1','@bot','Bot','','','prov_ollama','','',1)",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO chat_threads (id,bot_profile_id,title,status,updated_at,routine_schedule,routine_armed_at) VALUES ('thread_1','bot_1','Routine','paused',1,'every 1m',1)",
            [],
        ).unwrap();
        let nodes = "[{\"id\":\"node_1\",\"name\":\"Step\",\"kind\":\"llm_reasoning\",\"botProfile\":\"\",\"model\":\"\",\"prompt\":\"test\",\"status\":\"pending\",\"latencyMs\":0}]";
        conn.execute(
            "INSERT INTO workflows (id,name,yaml_source,nodes_json,triggers_json,current_status,checkpoint_json,updated_at,armed_at,schedule_enabled) VALUES ('wf_1','Workflow','',?1,'[\"every 1m\"]','idle','{}',1,1,0)",
            params![nodes],
        ).unwrap();
        assert!(pick_due(&conn).is_none());
        conn.execute("UPDATE workflows SET schedule_enabled=1 WHERE id='wf_1'", []).unwrap();
        assert!(matches!(pick_due(&conn), Some(Due::Workflow(id)) if id == "wf_1"));
        conn.execute("UPDATE chat_threads SET status='idle' WHERE id='thread_1'", []).unwrap();
        conn.execute("UPDATE workflows SET schedule_enabled=0 WHERE id='wf_1'", []).unwrap();
        assert!(matches!(pick_due(&conn), Some(Due::Routine(id)) if id == "thread_1"));
    }
}
