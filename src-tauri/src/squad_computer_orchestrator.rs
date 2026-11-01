//! Squad computer orchestrator: 2–4 bot mini windows tiled side by side,
//! connected by a shared blackboard bus so a producer bot can stream
//! structured packets straight into consumer bots without ever touching the
//! OS clipboard.
//!
//! The bus is `tokio::sync::broadcast` (in-process, sub-millisecond) backed
//! by the `squad_shared_blackboard` SQLite table (WAL, survives restarts and
//! feeds the studio history on load).

use crate::error::{err, Result};
use crate::util::{nid, safe_id_component};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::broadcast;

const SQUAD_WIDTH: f64 = 440.0;
const SQUAD_HEIGHT: f64 = 310.0;
const SQUAD_GAP: f64 = 14.0;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SquadBotSpec {
    pub bot_id: String,
    pub bot_handle: String,
    pub url: String,
    /// "Fast-CDP (<15ms)" | "Set-of-Marks Vision" | "Native OS UIAutomation (<5ms)"
    pub driver_mode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SquadWindowSlot {
    pub slot_index: usize,
    pub bot_id: String,
    pub bot_handle: String,
    pub window_label: String,
    pub url_or_target: String,
    pub driver_mode: String,
    /// [x, y, width, height] in logical pixels.
    pub screen_rect: [i32; 4],
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SquadBlackboardPacket {
    pub packet_id: String,
    pub from_bot: String,
    pub to_bot: String,
    /// "extracted_row" | "dom_verified" | "schema_fix_ready" | ... (free-form)
    pub topic: String,
    pub payload_json: String,
    pub latency_ms: u32,
    pub created_at: i64,
}

fn blackboard_sender() -> &'static broadcast::Sender<SquadBlackboardPacket> {
    static SENDER: OnceLock<broadcast::Sender<SquadBlackboardPacket>> = OnceLock::new();
    SENDER.get_or_init(|| broadcast::channel(256).0)
}

/// Subscribe from any Rust-side consumer (agent runtime, scheduler, ...).
/// Reserved for in-process consumers; the studio listens via the Tauri event.
#[allow(dead_code)]
pub fn subscribe_blackboard() -> broadcast::Receiver<SquadBlackboardPacket> {
    blackboard_sender().subscribe()
}

/// Right-edge vertical stack or 2x2 quadrant grid, non-overlapping, pinned to
/// the right edge so the user's main workspace stays visible. The stack wraps
/// into a second column when 4 windows would run off the screen bottom.
fn slot_origin(layout: &str, idx: usize, monitor_logical: Option<(f64, f64)>) -> (f64, f64) {
    let (screen_w, screen_h) = monitor_logical.unwrap_or((1920.0, 1080.0));
    let right = screen_w - SQUAD_WIDTH - 16.0;
    let rows_fit = (((screen_h - 48.0 - SQUAD_HEIGHT) / (SQUAD_HEIGHT + SQUAD_GAP)).floor() as usize).max(1) + 1;
    match layout {
        "quad_grid" => {
            let col = (idx % 2) as f64;
            let row = (idx / 2) as f64;
            let left_col = right - SQUAD_WIDTH - 12.0;
            let x = if col == 0.0 { left_col } else { right };
            let y = 32.0 + row * (SQUAD_HEIGHT + 12.0);
            (x.max(8.0), y.max(8.0).min((screen_h - SQUAD_HEIGHT - 16.0).max(8.0)))
        }
        _ => {
            let row = idx % rows_fit;
            let column = idx / rows_fit;
            let y = 32.0 + row as f64 * (SQUAD_HEIGHT + SQUAD_GAP);
            let x = right - column as f64 * (SQUAD_WIDTH + 12.0);
            (x.max(8.0), y.max(8.0).min((screen_h - SQUAD_HEIGHT - 16.0).max(8.0)))
        }
    }
}

fn monitor_logical_size(app: &AppHandle) -> Option<(f64, f64)> {
    let monitor = app.primary_monitor().ok().flatten()?;
    let scale = monitor.scale_factor();
    Some((monitor.size().width as f64 / scale, monitor.size().height as f64 / scale))
}

pub fn squad_browser_dir(home: &std::path::Path, bot_id: &str) -> Result<std::path::PathBuf> {
    let id = safe_id_component(bot_id)?;
    Ok(home.join("bots").join(id).join("browser-squad"))
}

#[tauri::command]
pub fn launch_tiling_squad_mini_windows(
    app: AppHandle,
    state: tauri::State<'_, crate::AppState>,
    bots: Vec<SquadBotSpec>,
    layout: String,
) -> Result<Vec<SquadWindowSlot>> {
    if bots.is_empty() {
        return Err(err("pick at least one bot for the squad"));
    }
    if bots.len() > 4 {
        return Err(err("squads run 2–4 bot windows at once"));
    }
    let monitor = monitor_logical_size(&app);
    let layout = if layout == "quad_grid" { "quad_grid" } else { "right_stack" };
    let mut slots: Vec<SquadWindowSlot> = Vec::new();

    for (idx, spec) in bots.into_iter().enumerate() {
        let bot_id = spec.bot_id.trim().to_string();
        if bot_id.is_empty() {
            return Err(err("every squad bot needs an id"));
        }
        let label = format!("ronic_squad_comp_{}", safe_id_component(&bot_id)?);
        let (x, y) = slot_origin(layout, idx, monitor);

        let parsed = if spec.url.trim().is_empty() {
            url::Url::parse("about:blank").map_err(|e| err(e.to_string()))?
        } else {
            let parsed = url::Url::parse(spec.url.trim()).map_err(|_| err("use an http or https URL"))?;
            if parsed.scheme() != "http" && parsed.scheme() != "https" {
                return Err(err("use an http or https URL"));
            }
            parsed
        };

        if app.get_webview_window(&label).is_none() {
            let dir = squad_browser_dir(&state.home, &bot_id)?;
            let _ = std::fs::create_dir_all(&dir);
            let mut builder = WebviewWindowBuilder::new(&app, label.clone(), WebviewUrl::External(parsed.clone()))
                .title(format!("{} • Squad Mini-Computer #{}", spec.bot_handle, idx + 1))
                .inner_size(SQUAD_WIDTH, SQUAD_HEIGHT)
                .position(x, y)
                .always_on_top(true)
                .resizable(true)
                .initialization_script(crate::computer_subsystem::BOT_MINI_WINDOW_HUD_SCRIPT);
            builder = builder.data_directory(dir);
            builder
                .build()
                .map_err(|e| err(format!("failed to spawn the squad window for {bot_id}: {e}")))?;
        } else if let Some(win) = app.get_webview_window(&label) {
            let _ = win.set_focus();
        }

        slots.push(SquadWindowSlot {
            slot_index: idx + 1,
            bot_id,
            bot_handle: spec.bot_handle,
            window_label: label,
            url_or_target: spec.url.trim().to_string(),
            driver_mode: if spec.driver_mode.trim().is_empty() { "Fast-CDP (<15ms)".into() } else { spec.driver_mode },
            screen_rect: [x as i32, y as i32, SQUAD_WIDTH as i32, SQUAD_HEIGHT as i32],
            status: "running_parallel".into(),
        });
    }

    let _ = app.emit("ronic://squad-layout", serde_json::json!({ "layout": layout, "slots": slots }));
    Ok(slots)
}

#[tauri::command]
pub fn squad_window_status(app: AppHandle) -> Vec<SquadWindowSlot> {
    let mut slots: Vec<SquadWindowSlot> = Vec::new();
    for window in app.webview_windows().values() {
        let label = window.label();
        if let Some(bot_id) = label.strip_prefix("ronic_squad_comp_") {
            slots.push(SquadWindowSlot {
                slot_index: slots.len() + 1,
                bot_id: bot_id.to_string(),
                bot_handle: format!("@{bot_id}"),
                window_label: label.to_string(),
                url_or_target: window.url().map(|u| u.to_string()).unwrap_or_default(),
                driver_mode: "Fast-CDP (<15ms)".into(),
                screen_rect: [0, 0, SQUAD_WIDTH as i32, SQUAD_HEIGHT as i32],
                status: if window.is_visible().unwrap_or(false) { "running_parallel".into() } else { "hidden".into() },
            });
        }
    }
    slots.sort_by(|a, b| a.window_label.cmp(&b.window_label));
    slots
}

#[tauri::command]
pub fn dismiss_squad_windows(app: AppHandle) -> Result<String> {
    let labels: Vec<String> = app
        .webview_windows()
        .keys()
        .filter(|label| label.starts_with("ronic_squad_comp_"))
        .cloned()
        .collect();
    for label in &labels {
        if let Some(win) = app.get_webview_window(label) {
            let _ = win.close();
        }
    }
    let _ = app.emit("ronic://squad-layout", serde_json::json!({ "layout": "dismissed", "slots": [] }));
    Ok(format!("Dismissed {} squad windows.", labels.len()))
}

/// Publishes a structured packet from one bot to another: persisted to
/// SQLite (WAL) and fanned out over the broadcast channel + a Tauri event so
/// every studio surface and Rust consumer receives it within milliseconds.
#[tauri::command]
pub fn publish_squad_blackboard_packet(
    app: AppHandle,
    state: tauri::State<'_, crate::AppState>,
    from_bot: String,
    to_bot: String,
    topic: String,
    payload_json: String,
) -> Result<SquadBlackboardPacket> {
    let from_bot = from_bot.trim().to_string();
    let to_bot = to_bot.trim().to_string();
    let topic = topic.trim().to_string();
    if from_bot.is_empty() || to_bot.is_empty() {
        return Err(err("packets need a producer and a consumer bot"));
    }
    let payload = crate::util::prefix_utf8(payload_json.trim(), 8000);
    // Malformed JSON would poison downstream consumers; reject it here.
    if !payload.is_empty() {
        serde_json::from_str::<serde_json::Value>(payload).map_err(|_| err("payload must be valid JSON"))?;
    }

    let started = std::time::Instant::now();
    let packet = SquadBlackboardPacket {
        packet_id: nid("pkt"),
        from_bot,
        to_bot,
        topic: if topic.is_empty() { "streamed_item".into() } else { topic },
        payload_json: payload.to_string(),
        latency_ms: 0,
        created_at: crate::util::now_ms(),
    };
    {
        let conn = state.conn.lock().unwrap_or_else(|poison| poison.into_inner());
        store_packet(&conn, &packet)?;
    }
    let latency = started.elapsed().as_millis().min(u128::from(u32::MAX)) as u32;
    let packet = SquadBlackboardPacket { latency_ms: latency, ..packet };

    let _ = blackboard_sender().send(packet.clone());
    let _ = app.emit("squad-blackboard-packet", &packet);
    Ok(packet)
}

fn store_packet(conn: &Connection, packet: &SquadBlackboardPacket) -> Result<()> {
    conn.execute(
        "INSERT INTO squad_shared_blackboard (id, from_bot, to_bot, topic, payload_json, latency_ms, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![packet.packet_id, packet.from_bot, packet.to_bot, packet.topic, packet.payload_json, packet.latency_ms, packet.created_at],
    )?;
    Ok(())
}

#[tauri::command]
pub fn list_squad_blackboard_packets(state: tauri::State<'_, crate::AppState>, limit: Option<u32>) -> Result<Vec<SquadBlackboardPacket>> {
    let limit = limit.unwrap_or(50).clamp(1, 200);
    let conn = state.conn.lock().unwrap_or_else(|poison| poison.into_inner());
    load_packets(&conn, limit)
}

fn load_packets(conn: &Connection, limit: u32) -> Result<Vec<SquadBlackboardPacket>> {
    let mut stmt = conn
        .prepare("SELECT id, from_bot, to_bot, topic, payload_json, latency_ms, created_at FROM squad_shared_blackboard ORDER BY created_at DESC, rowid DESC LIMIT ?1")
        .map_err(|e| err(e.to_string()))?;
    let rows = stmt
        .query_map(params![limit], |row| {
            Ok(SquadBlackboardPacket {
                packet_id: row.get(0)?,
                from_bot: row.get(1)?,
                to_bot: row.get(2)?,
                topic: row.get(3)?,
                payload_json: row.get(4)?,
                latency_ms: row.get::<_, i64>(5)?.max(0) as u32,
                created_at: row.get(6)?,
            })
        })
        .map_err(|e| err(e.to_string()))?;
    let mut packets = Vec::new();
    for row in rows {
        packets.push(row.map_err(|e| err(e.to_string()))?);
    }
    Ok(packets)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slots_tile_without_overlap() {
        for layout in ["right_stack", "quad_grid"] {
            let mut previous: Vec<[i32; 4]> = Vec::new();
            for idx in 0..4 {
                let (x, y) = slot_origin(layout, idx, Some((1920.0, 1080.0)));
                let rect = [x as i32, y as i32, SQUAD_WIDTH as i32, SQUAD_HEIGHT as i32];
                for old in &previous {
                    let x_overlap = rect[0] < old[0] + old[2] && old[0] < rect[0] + rect[2];
                    let y_overlap = rect[1] < old[1] + old[3] && old[1] < rect[1] + rect[3];
                    assert!(!(x_overlap && y_overlap), "{layout} slot {idx} overlaps a previous slot");
                }
                previous.push(rect);
                assert!(rect[0] >= 0 && rect[1] >= 0);
            }
        }
    }

    #[test]
    fn right_stack_stays_on_the_right_edge() {
        // The first column hugs the right edge in both layouts.
        let (x, _) = slot_origin("right_stack", 0, Some((1920.0, 1080.0)));
        assert!(x > 1400.0, "stack must hug the right edge, got {x}");
        let (_, qy) = slot_origin("quad_grid", 1, Some((1920.0, 1080.0)));
        assert_eq!(qy, 32.0);
        let (qx, _) = slot_origin("quad_grid", 1, Some((1920.0, 1080.0)));
        assert!(qx > 1400.0, "right quad column must hug the edge, got {qx}");
    }

    #[test]
    fn packets_survive_a_json_roundtrip() {
        let packet = SquadBlackboardPacket {
            packet_id: "pkt_1".into(),
            from_bot: "@Grokbot-Scout".into(),
            to_bot: "@Dots-Browser".into(),
            topic: "extracted_row".into(),
            payload_json: r#"{ "price": 129 }"#.into(),
            latency_ms: 1,
            created_at: 1,
        };
        let text = serde_json::to_string(&packet).unwrap();
        let back: SquadBlackboardPacket = serde_json::from_str(&text).unwrap();
        assert_eq!(back.topic, "extracted_row");
        assert_eq!(back.latency_ms, 1);
    }

    #[test]
    fn squad_dirs_are_per_bot_and_safe() {
        let home = std::path::Path::new("/tmp");
        assert_ne!(squad_browser_dir(home, "a").unwrap(), squad_browser_dir(home, "b").unwrap());
        assert!(squad_browser_dir(home, "..").is_err());
        // The bus hands out independent receivers without disturbing the sender.
        let rx = subscribe_blackboard();
        assert!(blackboard_sender().receiver_count() >= 1);
        drop(rx);
    }
}
