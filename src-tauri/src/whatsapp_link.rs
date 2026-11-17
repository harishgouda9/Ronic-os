//! WhatsApp linked-device session.
//!
//! The QR payload is the string WhatsApp's own "Link a device" scanner
//! accepts (`reference,noise key,identity key,adv secret`). It is issued by
//! WhatsApp after the Noise handshake. A locally minted web link is not a
//! WhatsApp code, and the phone reports "no valid QR code is detected".

use super::{generate_qr_png, now_ms, GatewayConnectionInfo, GatewayManager, GatewayState, IncomingGatewayMessage};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use whatsapp_rust::bot::Bot;
use whatsapp_rust::prelude::MessageExt;
use whatsapp_rust::store::SqliteStore;

pub(super) struct Session {
    handle: whatsapp_rust::bot::BotHandle,
}

const CHANNEL: &str = "whatsapp";

/// True when `code` is a WhatsApp companion payload, not a URL or a short token.
///
/// WhatsApp Web now issues five fields: reference, noise key, identity key,
/// adv secret, and a one-character client type. The older four-field form is
/// still accepted. A `wa.me` camera prefix and a FAQ suffix are stripped first.
pub(super) fn is_companion_code(code: &str) -> bool {
    let code = code.trim();
    if code.chars().any(char::is_whitespace) {
        return false;
    }
    let code = code
        .find("wa.me/settings/linked_devices#")
        .map(|at| &code[at + "wa.me/settings/linked_devices#".len()..])
        .unwrap_or(code);
    let mut parts: Vec<&str> = code.split(',').collect();
    if parts.last().is_some_and(|part| part.starts_with("https://faq.whatsapp.com/") || part.starts_with("http://faq.whatsapp.com/")) {
        parts.pop();
    }
    if parts.iter().any(|part| part.contains("://")) {
        return false;
    }
    if parts.len() != 4 && parts.len() != 5 {
        return false;
    }
    let reference = parts[0];
    if reference.len() < 4 || reference.len() > 400 || !reference.is_ascii() {
        return false;
    }
    for part in &parts[1..4] {
        let base64 = part.bytes().all(|byte| {
            matches!(byte, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'+' | b'/' | b'=')
        });
        if !base64 || part.len() < 20 || part.len() > 400 {
            return false;
        }
    }
    parts.len() == 4 || (parts[4].len() == 1 && parts[4].chars().all(|ch| ch.is_ascii_alphanumeric()))
}

pub(super) fn session_file_exists() -> bool {
    std::fs::metadata(crate::util::product_home().join("gateway").join("whatsapp.db"))
        .map(|meta| meta.is_file() && meta.len() > 0)
        .unwrap_or(false)
}

pub(super) fn stop(mgr: &GatewayManager) {
    let _ = mgr.whatsapp_generation.fetch_add(1, Ordering::AcqRel);
    let previous = mgr
        .whatsapp_session
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .take();
    if let Some(session) = previous {
        session.handle.abort();
    }
}

pub(super) async fn begin(mgr: &Arc<GatewayManager>, force: bool) -> Result<GatewayConnectionInfo, String> {
    if mgr.get_token(CHANNEL).is_some() && mgr.is_connected(CHANNEL) {
        let mut info = mgr.export_public(CHANNEL);
        info.qr_png_base64 = None;
        info.qr_uri = None;
        return Ok(info);
    }
    if mgr.is_connected(CHANNEL) {
        return Ok(mgr.export_public(CHANNEL));
    }
    if !force {
        let state = mgr.export_public(CHANNEL).state;
        let running = mgr
            .whatsapp_session
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .is_some();
        if running && matches!(state, GatewayState::Connecting | GatewayState::AwaitingQrScan) {
            return Ok(mgr.export_public(CHANNEL));
        }
    }

    stop(mgr);
    let generation = mgr.whatsapp_generation.fetch_add(1, Ordering::AcqRel) + 1;
    mgr.set_state(CHANNEL, GatewayState::Connecting, None);
    mgr.set_qr(CHANNEL, None, None);
    mgr.emit_status(CHANNEL);

    let mgr_task = Arc::clone(mgr);
    tokio::spawn(async move {
        if let Err(error) = run_session(mgr_task.clone(), generation).await {
            if current(&mgr_task, generation) && !mgr_task.is_connected(CHANNEL) {
                mgr_task.set_state(CHANNEL, GatewayState::Error, Some(error));
                mgr_task.emit_status(CHANNEL);
            }
        }
    });

    Ok(mgr.export_public(CHANNEL))
}

async fn run_session(mgr: Arc<GatewayManager>, generation: u64) -> Result<(), String> {
    let db_path = session_db_path()?;
    let store = SqliteStore::new(&db_path)
        .await
        .map_err(|error| format!("WhatsApp session store failed: {error}"))?;

    let qr_mgr = Arc::clone(&mgr);
    let connected_mgr = Arc::clone(&mgr);
    let logout_mgr = Arc::clone(&mgr);
    let message_mgr = Arc::clone(&mgr);

    let bot = Bot::builder()
        .with_backend(store)
        .on_qr_code(move |code, timeout| {
            let mgr = Arc::clone(&qr_mgr);
            async move {
                publish_qr(&mgr, generation, &code, timeout);
            }
        })
        .on_connected(move |client| {
            let mgr = Arc::clone(&connected_mgr);
            async move {
                mark_linked(&mgr, generation, &client);
            }
        })
        .on_logged_out(move |_event| {
            let mgr = Arc::clone(&logout_mgr);
            async move {
                if !current(&mgr, generation) {
                    return;
                }
                mgr.set_platform_user(CHANNEL, None, None);
                mgr.set_qr(CHANNEL, None, None);
                mgr.set_state(
                    CHANNEL,
                    GatewayState::Disconnected,
                    Some("WhatsApp unlinked this computer. Scan a new code from Linked devices.".into()),
                );
                mgr.emit_status(CHANNEL);
            }
        })
        .on_message(move |ctx| {
            let mgr = Arc::clone(&message_mgr);
            let text = ctx.message.text_content().map(str::to_string);
            let from_me = ctx.info.source.is_from_me;
            let offline = ctx.info.is_offline;
            let sender = ctx.info.source.sender.to_string();
            let chat = ctx.info.source.chat.to_string();
            let push_name = ctx.info.push_name.clone();
            let message_id = ctx.info.id.clone();
            let sent_at = ctx.info.timestamp.timestamp();
            async move {
                accept_message(&mgr, generation, text, from_me, offline, sender, chat, push_name, message_id, sent_at);
            }
        })
        .build()
        .await
        .map_err(|error| format!("WhatsApp link failed: {error}"))?;

    if !current(&mgr, generation) {
        return Ok(());
    }
    let handle = bot.spawn();
    if !current(&mgr, generation) {
        handle.abort();
        return Ok(());
    }
    let mut slot = mgr.whatsapp_session.lock().unwrap_or_else(|error| error.into_inner());
    if !current(&mgr, generation) {
        handle.abort();
        return Ok(());
    }
    *slot = Some(Session { handle });
    Ok(())
}

fn publish_qr(mgr: &GatewayManager, generation: u64, code: &str, _timeout: Duration) {
    if !current(mgr, generation) || mgr.is_connected(CHANNEL) {
        return;
    }
    if !is_companion_code(code) {
        mgr.set_state(
            CHANNEL,
            GatewayState::Error,
            Some("WhatsApp did not issue a linked-device code. Refresh the QR.".into()),
        );
        mgr.emit_status(CHANNEL);
        return;
    }
    match generate_qr_png(code) {
        Ok(png) => {
            mgr.set_state(CHANNEL, GatewayState::AwaitingQrScan, None);
            mgr.set_qr(CHANNEL, Some(png), None);
            mgr.emit_status(CHANNEL);
        }
        Err(error) => {
            mgr.set_state(CHANNEL, GatewayState::Error, Some(error));
            mgr.emit_status(CHANNEL);
        }
    }
}

fn mark_linked(mgr: &GatewayManager, generation: u64, client: &whatsapp_rust::client::Client) {
    if !current(mgr, generation) {
        return;
    }
    let phone = client.pn().map(|jid| jid_user(&jid.to_string())).unwrap_or_default();
    let name = client.push_name();
    let name = name.trim();
    let label = match (name.is_empty(), phone.is_empty()) {
        (false, false) => format!("{name} ({phone})"),
        (false, true) => name.to_string(),
        (true, false) => format!("WhatsApp ({phone})"),
        (true, true) => "WhatsApp".to_string(),
    };
    let user_id = if phone.is_empty() { None } else { Some(phone) };
    mgr.set_platform_user(CHANNEL, Some(label), user_id);
    mgr.mark_connected(CHANNEL);
    mgr.set_qr(CHANNEL, None, None);
    mgr.emit_status(CHANNEL);
}

fn accept_message(
    mgr: &GatewayManager,
    generation: u64,
    text: Option<String>,
    from_me: bool,
    offline: bool,
    sender: String,
    chat: String,
    push_name: String,
    message_id: String,
    sent_at: i64,
) {
    if !current(mgr, generation) || !mgr.is_connected(CHANNEL) {
        return;
    }
    if from_me || offline || chat.contains("status@broadcast") {
        return;
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    if sent_at > 0 && now.saturating_sub(sent_at) > 120 {
        return;
    }
    let Some(text) = text.filter(|value| !value.trim().is_empty()) else {
        return;
    };
    let sender_id = jid_user(&sender);
    if sender_id.is_empty() {
        return;
    }
    let push_name = push_name.trim();
    let sender_display = if push_name.is_empty() {
        sender_id.clone()
    } else {
        format!("{push_name} ({sender_id})")
    };
    mgr.msg_counter(CHANNEL).fetch_add(1, Ordering::Relaxed);
    mgr.push_inbox(IncomingGatewayMessage {
        channel_id: CHANNEL.to_string(),
        sender_id,
        sender_display,
        text,
        chat_id: chat,
        timestamp_ms: if sent_at > 0 { (sent_at as u64).saturating_mul(1000) } else { now_ms() },
        platform_message_id: Some(message_id),
    });
    mgr.sync_msg_counter(CHANNEL);
    mgr.emit_status(CHANNEL);
}

fn current(mgr: &GatewayManager, generation: u64) -> bool {
    mgr.whatsapp_generation.load(Ordering::Acquire) == generation
}

fn jid_user(jid: &str) -> String {
    let user = jid.split('@').next().unwrap_or(jid);
    user.split(':').next().unwrap_or(user).trim().to_string()
}

fn session_db_path() -> Result<String, String> {
    let dir = crate::util::product_home().join("gateway");
    std::fs::create_dir_all(&dir).map_err(|error| format!("WhatsApp session folder failed: {error}"))?;
    Ok(dir.join("whatsapp.db").to_string_lossy().replace('\\', "/"))
}
