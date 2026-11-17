//! Real messaging gateway connection manager.
//!
//! Each channel connects to its platform's live API:
//! - Telegram: Bot API long-polling (getMe → getUpdates loop)
//! - Discord: Gateway WebSocket (IDENTIFY → event stream)
//! - Slack: Socket Mode WebSocket (apps.connections.open → event stream)
//! - WhatsApp: a real linked-device QR. The phone scans it from WhatsApp →
//!   Linked devices → Link a device. A Cloud API token still uses Graph.
//! - Signal, WeChat, and iMessage: a same-Wi-Fi confirm page encoded in a QR.
//!   The phone opens the page and confirms. This does not log into those apps.
//! Telegram, Discord, and Slack use their bot tokens.
//!
//! Credentials are validated against the live platform API before a connection
//! is marked "connected". The frontend polls `gateway_connection_status` for
//! real-time state.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[path = "whatsapp_link.rs"]
mod whatsapp_link;

// ─────────────────────────────────────────────────────────────
// Public types exposed to the frontend
// ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GatewayConnectionInfo {
    pub channel_id: String,
    pub state: GatewayState,
    pub platform_user: Option<String>,   // e.g. "@ronicos_bot" for Telegram
    pub platform_user_id: Option<String>, // numeric ID
    pub error: Option<String>,
    pub connected_at_ms: Option<u64>,
    pub messages_received: u64,
    pub messages_sent: u64,
    /// QR code data (base64 PNG) for channels that pair via QR.
    pub qr_png_base64: Option<String>,
    /// Deep-link URI encoded in the QR.
    pub qr_uri: Option<String>,
    /// Allowlisted owner captured for this channel. Empty until one is set.
    #[serde(default)]
    pub owner_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum GatewayState {
    Disconnected,
    Validating,
    Connecting,
    AwaitingQrScan,
    Connected,
    Error,
}

impl std::fmt::Display for GatewayState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Disconnected => write!(f, "disconnected"),
            Self::Validating => write!(f, "validating"),
            Self::Connecting => write!(f, "connecting"),
            Self::AwaitingQrScan => write!(f, "awaiting_qr_scan"),
            Self::Connected => write!(f, "connected"),
            Self::Error => write!(f, "error"),
        }
    }
}

/// Incoming message from any connected channel, normalized for routing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IncomingGatewayMessage {
    pub channel_id: String,
    pub sender_id: String,
    pub sender_display: String,
    pub text: String,
    pub chat_id: String,
    pub timestamp_ms: u64,
    /// Platform-specific message ID for threading/replies.
    pub platform_message_id: Option<String>,
}

// ─────────────────────────────────────────────────────────────
// Global connection registry
// ─────────────────────────────────────────────────────────────

/// Holds all active gateway connections. Managed as Tauri state.
pub struct GatewayManager {
    pub connections: Mutex<HashMap<String, GatewayConnectionInfo>>,
    pub cancel_flags: Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// Validated tokens stored server-side after connect — never sent to frontend.
    pub tokens: Mutex<HashMap<String, String>>,
    /// Per-channel atomic message counters to avoid per-message mutex contention.
    pub msg_counters: Mutex<HashMap<String, Arc<AtomicU64>>>,
    /// Incoming messages that the frontend hasn't consumed yet.
    pub inbox: Mutex<Vec<IncomingGatewayMessage>>,
    /// App handle for emitting events to the frontend.
    pub app_handle: Mutex<Option<tauri::AppHandle>>,
    /// Allowlisted owner id captured when a channel connects.
    owners: Mutex<HashMap<String, String>>,
    /// One-time QR confirm codes. The phone page must present the matching code.
    pending_pairs: Mutex<HashMap<String, PendingPair>>,
    /// LAN listener that serves the confirm page. Started on the first QR.
    pair_listener: Mutex<Option<PairListener>>,
    /// Bumps when a WhatsApp link session is replaced, so a stale QR is ignored.
    whatsapp_generation: AtomicU64,
    /// Live WhatsApp linked-device session. Dropping it stops the client.
    whatsapp_session: Mutex<Option<whatsapp_link::Session>>,
    /// One restore per process, so a saved token does not start two listeners.
    restore_started: AtomicBool,
}

struct PendingPair {
    code: String,
    expires_ms: u64,
}

struct PairListener {
    host: String,
    port: u16,
}

impl GatewayManager {
    pub fn new() -> Self {
        Self {
            connections: Mutex::new(HashMap::new()),
            cancel_flags: Mutex::new(HashMap::new()),
            tokens: Mutex::new(HashMap::new()),
            msg_counters: Mutex::new(HashMap::new()),
            inbox: Mutex::new(Vec::new()),
            app_handle: Mutex::new(None),
            owners: Mutex::new(HashMap::new()),
            pending_pairs: Mutex::new(HashMap::new()),
            pair_listener: Mutex::new(None),
            whatsapp_generation: AtomicU64::new(0),
            whatsapp_session: Mutex::new(None),
            restore_started: AtomicBool::new(false),
        }
    }

    pub fn remember_owner(&self, channel_id: &str, owner_id: &str) {
        let mut owners = self.owners.lock().unwrap_or_else(|error| error.into_inner());
        owners.insert(channel_id.to_string(), owner_id.trim().to_string());
    }

    /// Saves the first owner. A later, different id does not replace it.
    pub fn remember_owner_if_unset(&self, channel_id: &str, owner_id: &str) -> Result<String, String> {
        let owner = owner_id.trim();
        if owner.is_empty() {
            return Err("Owner id is empty.".into());
        }
        let existing = self.stored_owner(channel_id);
        if !existing.trim().is_empty() && existing.trim() != owner {
            return Ok(existing);
        }
        self.remember_owner(channel_id, owner);
        Ok(owner.to_string())
    }

    pub fn stored_owner(&self, channel_id: &str) -> String {
        let owners = self.owners.lock().unwrap_or_else(|error| error.into_inner());
        owners.get(channel_id).cloned().unwrap_or_default()
    }

    pub fn is_connected(&self, channel_id: &str) -> bool {
        let conns = self.lock_connections();
        conns.get(channel_id).map(|info| info.state == GatewayState::Connected).unwrap_or(false)
    }

    /// Lock helper that recovers from mutex poisoning instead of panicking.
    fn lock_connections(&self) -> std::sync::MutexGuard<'_, HashMap<String, GatewayConnectionInfo>> {
        self.connections.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn lock_tokens(&self) -> std::sync::MutexGuard<'_, HashMap<String, String>> {
        self.tokens.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn lock_cancel_flags(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<AtomicBool>>> {
        self.cancel_flags.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn lock_msg_counters(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<AtomicU64>>> {
        self.msg_counters.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn lock_inbox(&self) -> std::sync::MutexGuard<'_, Vec<IncomingGatewayMessage>> {
        self.inbox.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn lock_app_handle(&self) -> std::sync::MutexGuard<'_, Option<tauri::AppHandle>> {
        self.app_handle.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn lock_pairs(&self) -> std::sync::MutexGuard<'_, HashMap<String, PendingPair>> {
        self.pending_pairs.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn set_state(&self, channel_id: &str, state: GatewayState, error: Option<String>) {
        let mut conns = self.lock_connections();
        let entry = conns.entry(channel_id.to_string()).or_insert_with(|| blank_connection(channel_id));
        entry.state = state;
        entry.error = error;
    }

    fn set_platform_user(&self, channel_id: &str, user: Option<String>, user_id: Option<String>) {
        let mut conns = self.lock_connections();
        if let Some(entry) = conns.get_mut(channel_id) {
            entry.platform_user = user;
            entry.platform_user_id = user_id;
        }
    }

    fn set_qr(&self, channel_id: &str, png_base64: Option<String>, uri: Option<String>) {
        let mut conns = self.lock_connections();
        if let Some(entry) = conns.get_mut(channel_id) {
            entry.qr_png_base64 = png_base64;
            entry.qr_uri = uri;
        }
    }

    fn mark_connected(&self, channel_id: &str) {
        let mut conns = self.lock_connections();
        let entry = conns.entry(channel_id.to_string()).or_insert_with(|| blank_connection(channel_id));
        entry.state = GatewayState::Connected;
        entry.connected_at_ms = Some(now_ms());
        entry.error = None;
    }

    fn export_public(&self, channel_id: &str) -> GatewayConnectionInfo {
        let info = self.lock_connections().get(channel_id).cloned();
        let mut info = info.unwrap_or_else(|| blank_connection(channel_id));
        info.owner_id = self.stored_owner(channel_id);
        info
    }

    fn arm_pairing(&self, channel_id: &str, code: &str, expires_ms: u64) {
        let mut pairs = self.lock_pairs();
        pairs.insert(channel_id.to_string(), PendingPair { code: code.to_string(), expires_ms });
    }

    fn store_token(&self, channel_id: &str, token: &str) {
        let mut tokens = self.lock_tokens();
        tokens.insert(channel_id.to_string(), token.to_string());
    }

    fn get_token(&self, channel_id: &str) -> Option<String> {
        let tokens = self.lock_tokens();
        tokens.get(channel_id).cloned()
    }

    fn remove_token(&self, channel_id: &str) {
        let mut tokens = self.lock_tokens();
        tokens.remove(channel_id);
    }

    fn msg_counter(&self, channel_id: &str) -> Arc<AtomicU64> {
        let mut counters = self.lock_msg_counters();
        counters
            .entry(channel_id.to_string())
            .or_insert_with(|| Arc::new(AtomicU64::new(0)))
            .clone()
    }

    fn sync_msg_counter(&self, channel_id: &str) {
        let counter = self.msg_counter(channel_id);
        let count = counter.load(Ordering::Relaxed);
        let mut conns = self.lock_connections();
        if let Some(entry) = conns.get_mut(channel_id) {
            entry.messages_received = count;
        }
    }

    fn push_inbox(&self, msg: IncomingGatewayMessage) {
        let mut inbox = self.lock_inbox();
        inbox.push(msg);
        // Cap at 500 unprocessed messages
        if inbox.len() > 500 {
            let excess = inbox.len() - 500;
            inbox.drain(..excess);
        }
    }

    fn cancel_flag(&self, channel_id: &str) -> Arc<AtomicBool> {
        let mut flags = self.lock_cancel_flags();
        flags
            .entry(channel_id.to_string())
            .or_insert_with(|| Arc::new(AtomicBool::new(false)))
            .clone()
    }

    fn signal_cancel(&self, channel_id: &str) {
        let flags = self.lock_cancel_flags();
        if let Some(flag) = flags.get(channel_id) {
            flag.store(true, Ordering::Relaxed);
        }
    }

    fn clear_cancel(&self, channel_id: &str) {
        let flags = self.lock_cancel_flags();
        if let Some(flag) = flags.get(channel_id) {
            flag.store(false, Ordering::Relaxed);
        }
    }

    fn emit_status(&self, channel_id: &str) {
        let conns = self.lock_connections();
        if let Some(info) = conns.get(channel_id) {
            // Sync the atomic counter into the struct before emitting
            let mut info = info.clone();
            let counter = self.msg_counter(channel_id);
            info.messages_received = counter.load(Ordering::Relaxed);
            info.owner_id = self.stored_owner(channel_id);
            // Skip QR payload in emitted events — it's large and only needed for the QR panel
            info.qr_png_base64 = None;
            if let Some(handle) = self.lock_app_handle().as_ref() {
                use tauri::Emitter;
                let _ = handle.emit("gateway-connection-changed", info);
            }
        }
    }
}

fn blank_connection(channel_id: &str) -> GatewayConnectionInfo {
    GatewayConnectionInfo {
        channel_id: channel_id.to_string(),
        state: GatewayState::Disconnected,
        platform_user: None,
        platform_user_id: None,
        error: None,
        connected_at_ms: None,
        messages_received: 0,
        messages_sent: 0,
        qr_png_base64: None,
        qr_uri: None,
        owner_id: String::new(),
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Sanitize a reqwest error to remove any URL that might contain a bot token.
/// reqwest::Error's Display impl includes the request URL for many error kinds,
/// which would leak the token embedded in Telegram URLs.
fn sanitize_reqwest_error(e: &reqwest::Error) -> String {
    if e.is_connect() {
        "connection failed".to_string()
    } else if e.is_timeout() {
        "request timed out".to_string()
    } else if e.is_decode() {
        "failed to decode response".to_string()
    } else if e.is_request() {
        "request error".to_string()
    } else if e.is_redirect() {
        "redirect error".to_string()
    } else if e.is_status() {
        format!("HTTP {}", e.status().map(|s| s.as_u16()).unwrap_or(0))
    } else {
        "unknown network error".to_string()
    }
}

/// Sanitize an HTTP error body to remove potential token leakage and limit size.
fn sanitize_error_body(body: &str, max_len: usize) -> String {
    // Remove anything that looks like a bot token
    let token_patterns = [
        // Telegram: digits:alphanumeric
        regex::Regex::new(r"\d{8,10}:[A-Za-z0-9_-]{35}").unwrap(),
        // Discord: starts with MT, 3 parts
        regex::Regex::new(r"MT[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{20,}").unwrap(),
        // Slack: xoxb-, xapp-
        regex::Regex::new(r"xox[baprs]-[A-Za-z0-9-]{10,}").unwrap(),
        regex::Regex::new(r"xapp-[A-Za-z0-9-]{10,}").unwrap(),
    ];
    let mut sanitized = body.to_string();
    for pattern in &token_patterns {
        sanitized = pattern.replace_all(&sanitized, "[REDACTED]").to_string();
    }
    if sanitized.len() > max_len {
        sanitized.truncate(max_len);
        sanitized.push_str("…");
    }
    sanitized
}

// ─────────────────────────────────────────────────────────────
// Saved credentials — vault, not the React session
// ─────────────────────────────────────────────────────────────

const GATEWAY_CRED_KEY: &str = "gateway.credentials.v1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GatewayCredentialRecord {
    #[serde(default)]
    token: String,
    #[serde(default)]
    owner_id: String,
    #[serde(default)]
    extras: Vec<GatewayCredentialExtra>,
    #[serde(default)]
    reconnect: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GatewayCredentialExtra {
    #[serde(default)]
    id: String,
    #[serde(default)]
    label: String,
    #[serde(default)]
    value: String,
}

fn valid_channel_id(channel_id: &str) -> bool {
    let channel_id = channel_id.trim();
    !channel_id.is_empty()
        && channel_id.len() <= 32
        && channel_id.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
}

fn clean_extra(extra: GatewayCredentialExtra) -> Option<GatewayCredentialExtra> {
    let label = extra.label.trim();
    let value = extra.value.trim();
    if label.is_empty() || value.is_empty() || label.len() > 80 || value.len() > 4_000 {
        return None;
    }
    let id = if extra.id.trim().is_empty() { format!("extra_{label}") } else { extra.id.trim().to_string() };
    Some(GatewayCredentialExtra { id, label: label.to_string(), value: value.to_string() })
}

fn parse_gateway_credentials(raw: &str) -> std::collections::BTreeMap<String, GatewayCredentialRecord> {
    serde_json::from_str(raw).unwrap_or_default()
}

fn upsert_gateway_credential(
    mut file: std::collections::BTreeMap<String, GatewayCredentialRecord>,
    channel_id: &str,
    token: &str,
    owner_id: &str,
    extras: Vec<GatewayCredentialExtra>,
    reconnect: Option<bool>,
) -> Result<std::collections::BTreeMap<String, GatewayCredentialRecord>, String> {
    if !valid_channel_id(channel_id) {
        return Err("Unknown channel.".into());
    }
    let channel_id = channel_id.trim();
    let token = token.trim();
    let owner_id = owner_id.trim();
    if token.len() > 4_000 || owner_id.len() > 200 {
        return Err("That credential is too long to save.".into());
    }
    let extras: Vec<GatewayCredentialExtra> = extras.into_iter().filter_map(clean_extra).take(8).collect();
    let previous = file.get(channel_id).map(|row| row.reconnect).unwrap_or(false);
    let reconnect = reconnect.unwrap_or(previous);
    if token.is_empty() && owner_id.is_empty() && extras.is_empty() && !(channel_id == "whatsapp" && reconnect) {
        file.remove(channel_id);
        return Ok(file);
    }
    file.insert(
        channel_id.to_string(),
        GatewayCredentialRecord {
            token: token.to_string(),
            owner_id: owner_id.to_string(),
            extras,
            reconnect,
        },
    );
    Ok(file)
}

fn vault_is_locked(app: &crate::AppState) -> bool {
    let has_pass = {
        let conn = crate::commands::guard(app);
        crate::db::kv_get(&conn, "vault_verifier").ok().flatten().is_some()
    };
    if !has_pass {
        return false;
    }
    app.vault_key.lock().unwrap_or_else(|error| error.into_inner()).is_none()
}

fn load_gateway_file(app: &crate::AppState) -> Result<std::collections::BTreeMap<String, GatewayCredentialRecord>, String> {
    if vault_is_locked(app) {
        return Err("Unlock the vault before loading gateway credentials.".into());
    }
    let secrets = app.secrets.lock().unwrap_or_else(|error| error.into_inner());
    let raw = secrets.get(GATEWAY_CRED_KEY).cloned().unwrap_or_else(|| "{}".into());
    Ok(parse_gateway_credentials(&raw))
}

fn store_gateway_file(app: &crate::AppState, file: &std::collections::BTreeMap<String, GatewayCredentialRecord>) -> Result<(), String> {
    if vault_is_locked(app) {
        return Err("Unlock the vault before saving gateway credentials.".into());
    }
    let json = serde_json::to_string(file).map_err(|error| error.to_string())?;
    if json.len() > 48_000 {
        return Err("Gateway credentials are too large to save.".into());
    }
    let conn = crate::commands::guard(app);
    let key_guard = app.vault_key.lock().unwrap_or_else(|error| error.into_inner());
    let mut secrets = app.secrets.lock().unwrap_or_else(|error| error.into_inner());
    if json == "{}" {
        secrets.remove(GATEWAY_CRED_KEY);
    } else {
        secrets.insert(GATEWAY_CRED_KEY.to_string(), json);
    }
    crate::vault::persist(&app.home, &conn, key_guard.as_ref(), &secrets).map_err(|error| error.to_string())
}

// ─────────────────────────────────────────────────────────────
// Tauri commands — frontend calls these
// ─────────────────────────────────────────────────────────────

/// Connect a messaging channel with real credential validation.
/// Validates the token against the platform API, then starts a background
/// listener for incoming messages.
#[tauri::command]
pub async fn gateway_connect(
    channel_id: String,
    token: String,
    owner_id: String,
    state: tauri::State<'_, Arc<GatewayManager>>,
) -> Result<GatewayConnectionInfo, String> {
    let mgr = state.inner().clone();
    let owner_mgr = mgr.clone();
    let channel_key = channel_id.clone();
    let owner_key = owner_id.trim().to_string();
    mgr.clear_cancel(&channel_id);
    mgr.set_state(&channel_id, GatewayState::Validating, None);
    mgr.emit_status(&channel_id);

    let result = match channel_id.as_str() {
        "telegram" => connect_telegram(mgr, channel_id, token, owner_id).await,
        "discord" => connect_discord(mgr, channel_id, token, owner_id).await,
        "slack" => connect_slack(mgr, channel_id, token, owner_id).await,
        "whatsapp" => connect_whatsapp(mgr, channel_id, token, owner_id).await,
        other => {
            let info = GatewayConnectionInfo {
                channel_id: other.to_string(),
                state: GatewayState::Error,
                platform_user: None,
                platform_user_id: None,
                error: Some(format!("Channel '{other}' is not yet implemented. Currently supported: telegram, discord, slack, whatsapp.")),
                connected_at_ms: None,
                messages_received: 0,
                messages_sent: 0,
                qr_png_base64: None,
                qr_uri: None,
                owner_id: String::new(),
            };
            mgr.set_state(other, GatewayState::Error, info.error.clone());
            mgr.emit_status(other);
            Err(info.error.unwrap())
        }
    };
    match result {
        Ok(mut info) => {
            // An empty owner must not wipe a sender adopted after the last connect.
            if !owner_key.is_empty() {
                owner_mgr.remember_owner(&channel_key, &owner_key);
            }
            info.owner_id = owner_mgr.stored_owner(&channel_key);
            Ok(info)
        }
        Err(error) => Err(error),
    }
}

/// Build a scannable pairing QR for a channel without requiring a bot token.
/// The code is an http page on this computer's LAN address. The phone opens
/// it and confirms. `force` replaces a code on a channel that is already paired.
/// A channel connected with an API token is left alone.
#[tauri::command]
pub async fn gateway_pairing_qr(
    channel_id: String,
    force: Option<bool>,
    state: tauri::State<'_, Arc<GatewayManager>>,
) -> Result<GatewayConnectionInfo, String> {
    let mgr = state.inner().clone();
    if channel_id == "whatsapp" {
        return whatsapp_link::begin(&mgr, force.unwrap_or(false)).await;
    }
    begin_scan_pairing(&mgr, &channel_id, force.unwrap_or(false))
}

/// Remember the first person who messaged a connected bot. Does not replace an owner.
#[tauri::command]
pub async fn gateway_remember_owner(
    channel_id: String,
    owner_id: String,
    state: tauri::State<'_, Arc<GatewayManager>>,
) -> Result<String, String> {
    state.remember_owner_if_unset(&channel_id, &owner_id)
}

/// Disconnect a channel, stopping its background listener and removing the stored token.
/// The saved credential stays. The next launch does not connect it again.
#[tauri::command]
pub async fn gateway_disconnect(
    channel_id: String,
    state: tauri::State<'_, Arc<GatewayManager>>,
    app: tauri::State<'_, crate::AppState>,
) -> Result<String, String> {
    let mgr = state.inner();
    if channel_id == "whatsapp" {
        whatsapp_link::stop(mgr);
    }
    mgr.signal_cancel(&channel_id);
    mgr.remove_token(&channel_id);
    mgr.set_state(&channel_id, GatewayState::Disconnected, None);
    mgr.set_platform_user(&channel_id, None, None);
    mgr.set_qr(&channel_id, None, None);
    mgr.emit_status(&channel_id);
    // The disconnect only counts once the saved reconnect flag is cleared on disk.
    // Otherwise a locked vault or a write failure would reconnect on the next launch.
    let mut file = load_gateway_file(app.inner())?;
    if let Some(record) = file.get_mut(channel_id.trim()) {
        record.reconnect = false;
        store_gateway_file(app.inner(), &file)?;
    }
    Ok(format!("Disconnected {channel_id}"))
}

/// Saves one channel's token, owner, and extra fields in the vault.
#[tauri::command]
pub async fn gateway_save_credentials(
    channel_id: String,
    token: String,
    owner_id: String,
    extras: Option<Vec<GatewayCredentialExtra>>,
    reconnect: Option<bool>,
    app: tauri::State<'_, crate::AppState>,
) -> Result<String, String> {
    let file = load_gateway_file(app.inner())?;
    let file = upsert_gateway_credential(file, &channel_id, &token, &owner_id, extras.unwrap_or_default(), reconnect)?;
    store_gateway_file(app.inner(), &file)?;
    Ok("Credentials saved on this computer.".into())
}

/// Returns saved gateway credentials so the form can be filled after a restart.
#[tauri::command]
pub async fn gateway_load_credentials(
    app: tauri::State<'_, crate::AppState>,
) -> Result<std::collections::BTreeMap<String, GatewayCredentialRecord>, String> {
    load_gateway_file(app.inner())
}

/// Connects channels that were connected last time, using the saved vault tokens.
#[tauri::command]
pub async fn gateway_restore_saved(
    app: tauri::State<'_, crate::AppState>,
    state: tauri::State<'_, Arc<GatewayManager>>,
) -> Result<Vec<String>, String> {
    let file = load_gateway_file(app.inner())?;
    let mgr = state.inner().clone();
    if mgr.restore_started.swap(true, Ordering::AcqRel) {
        return Ok(Vec::new());
    }
    let mut started = Vec::new();
    for (channel_id, record) in file {
        if !record.reconnect || mgr.is_connected(&channel_id) {
            continue;
        }
        if !record.owner_id.trim().is_empty() {
            let _ = mgr.remember_owner_if_unset(&channel_id, &record.owner_id);
        }
        let token = record.token.trim().to_string();
        match channel_id.as_str() {
            "telegram" | "discord" | "slack" if !token.is_empty() => {
                let listener = mgr.clone();
                let id = channel_id.clone();
                let secret = token;
                mgr.clear_cancel(&id);
                tokio::spawn(async move {
                    let result = if id == "telegram" {
                        connect_telegram(listener, id, secret, String::new()).await
                    } else if id == "discord" {
                        connect_discord(listener, id, secret, String::new()).await
                    } else {
                        connect_slack(listener, id, secret, String::new()).await
                    };
                    let _ = result;
                });
                started.push(channel_id);
            }
            "whatsapp" if !whatsapp_token_is_pairing(&token) => {
                let listener = mgr.clone();
                let secret = token.clone();
                tokio::spawn(async move {
                    let _ = connect_whatsapp_cloud(listener, "whatsapp".into(), secret).await;
                });
                started.push(channel_id);
            }
            "whatsapp" if whatsapp_link::session_file_exists() => {
                let _ = whatsapp_link::begin(&mgr, false).await;
                started.push(channel_id);
            }
            _ => {}
        }
    }
    Ok(started)
}

/// Get the current connection status for one or all channels.
#[tauri::command]
pub async fn gateway_connection_status(
    channel_id: Option<String>,
    state: tauri::State<'_, Arc<GatewayManager>>,
) -> Result<Vec<GatewayConnectionInfo>, String> {
    let mgr = state.inner();
    let infos: Vec<GatewayConnectionInfo> = {
        let conns = mgr.lock_connections();
        match channel_id {
            Some(id) => conns.get(&id).cloned().into_iter().collect(),
            None => conns.values().cloned().collect(),
        }
    };
    Ok(infos
        .into_iter()
        .map(|mut info| {
            info.owner_id = mgr.stored_owner(&info.channel_id);
            info
        })
        .collect())
}

/// Drain pending incoming messages (frontend polls this).
#[tauri::command]
pub async fn gateway_poll_messages(
    channel_id: Option<String>,
    state: tauri::State<'_, Arc<GatewayManager>>,
) -> Result<Vec<IncomingGatewayMessage>, String> {
    let mgr = state.inner();
    let mut inbox = mgr.inbox.lock().unwrap();
    match channel_id {
        Some(id) => {
            let (matching, rest): (Vec<_>, Vec<_>) = inbox.drain(..).partition(|m| m.channel_id == id);
            *inbox = rest;
            Ok(matching)
        }
        None => Ok(inbox.drain(..).collect()),
    }
}

/// Send a message through a connected channel. Uses the token stored server-side
/// during `gateway_connect` — the frontend never sends tokens for send operations.
#[tauri::command]
pub async fn gateway_send_message(
    channel_id: String,
    chat_id: String,
    text: String,
    state: tauri::State<'_, Arc<GatewayManager>>,
) -> Result<String, String> {
    let mgr = state.inner();
    let is_connected = {
        let conns = mgr.lock_connections();
        conns.get(&channel_id).map(|i| i.state == GatewayState::Connected).unwrap_or(false)
    };
    if !is_connected {
        return Err(format!("Channel '{channel_id}' is not connected"));
    }

    let token = mgr.get_token(&channel_id).ok_or("No token stored for this channel — reconnect first")?;

    match channel_id.as_str() {
        "telegram" => telegram_send_message(&token, &chat_id, &text).await,
        "discord" => discord_send_message(&token, &chat_id, &text).await,
        "slack" => slack_send_message(&token, &chat_id, &text).await,
        other => Err(format!("Send not implemented for '{other}'")),
    }
}

// ─────────────────────────────────────────────────────────────
// Telegram Bot API — real implementation
// ─────────────────────────────────────────────────────────────

async fn connect_telegram(
    mgr: Arc<GatewayManager>,
    channel_id: String,
    token: String,
    _owner_id: String,
) -> Result<GatewayConnectionInfo, String> {
    if token.trim().is_empty() {
        mgr.set_state(&channel_id, GatewayState::Error, Some("Bot token is required. Get one from @BotFather on Telegram.".into()));
        mgr.emit_status(&channel_id);
        return Err("Bot token is required".into());
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;

    // Step 1: Validate the token via getMe
    mgr.set_state(&channel_id, GatewayState::Validating, None);
    mgr.emit_status(&channel_id);

    let me_resp = client
        .get(format!("https://api.telegram.org/bot{token}/getMe"))
        .send()
        .await
        .map_err(|e| {
            let msg = format!("Network error reaching Telegram API: {}", sanitize_reqwest_error(&e));
            mgr.set_state(&channel_id, GatewayState::Error, Some(msg.clone()));
            mgr.emit_status(&channel_id);
            msg
        })?;

    let me_body: serde_json::Value = me_resp.json().await.map_err(|e| {
        let msg = format!("Invalid response from Telegram: {}", sanitize_reqwest_error(&e));
        mgr.set_state(&channel_id, GatewayState::Error, Some(msg.clone()));
        mgr.emit_status(&channel_id);
        msg
    })?;

    if !me_body.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
        let desc = me_body.get("description").and_then(|v| v.as_str()).unwrap_or("Unknown error");
        let msg = format!("Telegram API rejected the token: {desc}");
        mgr.set_state(&channel_id, GatewayState::Error, Some(msg.clone()));
        mgr.emit_status(&channel_id);
        return Err(msg);
    }

    let bot_info = me_body.get("result").cloned().unwrap_or_default();
    let bot_username = bot_info.get("username").and_then(|v| v.as_str()).unwrap_or("unknown");
    let bot_id = bot_info.get("id").and_then(|v| v.as_i64()).unwrap_or(0);
    let bot_first_name = bot_info.get("first_name").and_then(|v| v.as_str()).unwrap_or("");

    mgr.set_platform_user(
        &channel_id,
        Some(format!("@{bot_username} ({bot_first_name})")),
        Some(bot_id.to_string()),
    );
    mgr.set_state(&channel_id, GatewayState::Connecting, None);
    mgr.emit_status(&channel_id);

    // Step 2: Delete any existing webhook (we use long-polling)
    let _ = client
        .post(format!("https://api.telegram.org/bot{token}/deleteWebhook"))
        .send()
        .await;

    mgr.mark_connected(&channel_id);
    mgr.store_token(&channel_id, &token);
    mgr.emit_status(&channel_id);

    // Step 3: Start long-polling in a background task
    let cancel = mgr.cancel_flag(&channel_id);
    let mgr_clone = mgr.clone();
    let ch_id = channel_id.clone();
    let poll_token = token.clone();

    tokio::spawn(async move {
        telegram_poll_loop(mgr_clone, ch_id, poll_token, cancel).await;
    });

    let info = mgr.lock_connections().get(&channel_id).cloned().unwrap_or(GatewayConnectionInfo {
        channel_id,
        state: GatewayState::Connected,
        platform_user: Some(format!("@{bot_username}")),
        platform_user_id: Some(bot_id.to_string()),
        error: None,
        connected_at_ms: Some(now_ms()),
        messages_received: 0,
        messages_sent: 0,
        qr_png_base64: None,
        qr_uri: None,
        owner_id: String::new(),
    });
    Ok(info)
}

fn telegram_identity(from: Option<&serde_json::Value>) -> (String, String) {
    let sender_id = from
        .and_then(|item| item.get("id"))
        .and_then(|value| value.as_i64())
        .map(|value| value.to_string())
        .unwrap_or_default();
    let sender_name = from
        .and_then(|item| item.get("first_name"))
        .and_then(|value| value.as_str())
        .unwrap_or("Unknown");
    let sender_username = from
        .and_then(|item| item.get("username"))
        .and_then(|value| value.as_str())
        .unwrap_or("");
    let display = if sender_username.is_empty() {
        sender_name.to_string()
    } else {
        format!("{sender_name} (@{sender_username})")
    };
    (sender_id, display)
}

/// Long-polling loop for Telegram getUpdates. Runs until cancelled.
async fn telegram_poll_loop(
    mgr: Arc<GatewayManager>,
    channel_id: String,
    token: String,
    cancel: Arc<AtomicBool>,
) {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(35)) // Telegram long-poll timeout is 30s
        .build()
        .unwrap_or_default();

    let mut offset: i64 = 0;
    let counter = mgr.msg_counter(&channel_id);

    loop {
        if cancel.load(Ordering::Relaxed) {
            break;
        }

        let url = format!(
            "https://api.telegram.org/bot{token}/getUpdates?offset={offset}&timeout=30&limit=10"
        );

        let resp = match client.get(&url).send().await {
            Ok(r) => r,
            Err(_) => {
                // Network hiccup — retry after a short delay
                tokio::time::sleep(Duration::from_secs(2)).await;
                continue;
            }
        };

        let body: serde_json::Value = match resp.json().await {
            Ok(v) => v,
            Err(_) => {
                tokio::time::sleep(Duration::from_secs(2)).await;
                continue;
            }
        };

        if !body.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
            // Token revoked or API error — disconnect
            let desc = body.get("description").and_then(|v| v.as_str()).unwrap_or("API error");
            mgr.set_state(&channel_id, GatewayState::Error, Some(format!("Telegram: {desc}")));
            mgr.sync_msg_counter(&channel_id);
            mgr.emit_status(&channel_id);
            break;
        }

        let updates = body.get("result").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        let mut new_messages = 0u64;

        for update in updates {
            let update_id = update.get("update_id").and_then(|v| v.as_i64()).unwrap_or(0);
            if update_id >= offset {
                offset = update_id + 1;
            }

            // Extract message
            if let Some(message) = update.get("message").or_else(|| update.get("edited_message")) {
                let text = message.get("text").and_then(|v| v.as_str()).unwrap_or("");
                if text.is_empty() {
                    continue;
                }

                let (sender_id, display) = telegram_identity(message.get("from"));

                let chat_id = message
                    .get("chat")
                    .and_then(|c| c.get("id"))
                    .and_then(|v| v.as_i64())
                    .map(|v| v.to_string())
                    .unwrap_or_default();

                let msg_id = message.get("message_id").and_then(|v| v.as_i64()).map(|v| v.to_string());
                let date = message.get("date").and_then(|v| v.as_i64()).unwrap_or(0) as u64;

                let incoming = IncomingGatewayMessage {
                    channel_id: channel_id.clone(),
                    sender_id,
                    sender_display: display,
                    text: text.to_string(),
                    chat_id,
                    timestamp_ms: date * 1000,
                    platform_message_id: msg_id,
                };

                counter.fetch_add(1, Ordering::Relaxed);
                new_messages += 1;
                mgr.push_inbox(incoming);
            }

            // Handle callback queries (inline keyboard button taps)
            if let Some(callback) = update.get("callback_query") {
                let data = callback.get("data").and_then(|v| v.as_str()).unwrap_or("");
                let (sender_id, display) = telegram_identity(callback.get("from"));

                let incoming = IncomingGatewayMessage {
                    channel_id: channel_id.clone(),
                    sender_id,
                    sender_display: display,
                    text: format!("[button_tap:{data}]"),
                    chat_id: callback
                        .get("message")
                        .and_then(|m| m.get("chat"))
                        .and_then(|c| c.get("id"))
                        .and_then(|v| v.as_i64())
                        .map(|v| v.to_string())
                        .unwrap_or_default(),
                    timestamp_ms: now_ms(),
                    platform_message_id: callback.get("id").and_then(|v| v.as_str()).map(String::from),
                };

                counter.fetch_add(1, Ordering::Relaxed);
                new_messages += 1;
                mgr.push_inbox(incoming);
            }
        }

        // Batch emit once per poll cycle instead of per message
        if new_messages > 0 {
            mgr.sync_msg_counter(&channel_id);
            mgr.emit_status(&channel_id);
        }
    }
}

/// Send a message via Telegram Bot API.
async fn telegram_send_message(token: &str, chat_id: &str, text: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;

    let resp = client
        .post(format!("https://api.telegram.org/bot{token}/sendMessage"))
        .json(&serde_json::json!({
            "chat_id": chat_id,
            "text": text,
            "parse_mode": "Markdown",
        }))
        .send()
        .await
        .map_err(|e| format!("Failed to send Telegram message: {}", sanitize_reqwest_error(&e)))?;

    let body: serde_json::Value = resp.json().await.map_err(|e| format!("Invalid response: {}", sanitize_reqwest_error(&e)))?;

    if body.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
        Ok(format!("Message sent to Telegram chat {chat_id}"))
    } else {
        let desc = body.get("description").and_then(|v| v.as_str()).unwrap_or("Unknown error");
        Err(format!("Telegram send failed: {}", sanitize_error_body(desc, 200)))
    }
}

/// Send plain text. Chief reports use this so handles and hashes are not parsed as Markdown.
async fn telegram_send_plain(token: &str, chat_id: &str, text: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;
    let resp = client
        .post(format!("https://api.telegram.org/bot{token}/sendMessage"))
        .json(&serde_json::json!({ "chat_id": chat_id, "text": text }))
        .send()
        .await
        .map_err(|e| format!("Failed to send Telegram message: {}", sanitize_reqwest_error(&e)))?;
    let body: serde_json::Value = resp.json().await.map_err(|e| format!("Invalid response: {}", sanitize_reqwest_error(&e)))?;
    if body.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
        Ok(format!("Message sent to Telegram chat {chat_id}"))
    } else {
        let desc = body.get("description").and_then(|v| v.as_str()).unwrap_or("Unknown error");
        Err(format!("Telegram send failed: {}", sanitize_error_body(desc, 200)))
    }
}

pub async fn deliver_plain_text(mgr: &GatewayManager, channel_id: &str, chat_id: &str, text: &str) -> Result<String, String> {
    if !mgr.is_connected(channel_id) {
        return Err(format!("Channel '{channel_id}' is not connected"));
    }
    let token = mgr.get_token(channel_id).ok_or("No token stored for this channel — reconnect first")?;
    match channel_id {
        "telegram" => telegram_send_plain(&token, chat_id, text).await,
        "discord" => discord_send_message(&token, chat_id, text).await,
        "slack" => slack_send_message(&token, chat_id, text).await,
        other => Err(format!("Send not implemented for '{other}'")),
    }
}

pub async fn deliver_telegram_buttons(mgr: &GatewayManager, chat_id: &str, text: &str, buttons: Vec<(String, String)>) -> Result<String, String> {
    if !mgr.is_connected("telegram") {
        return Err("Channel 'telegram' is not connected".into());
    }
    let token = mgr.get_token("telegram").ok_or("No token stored for this channel — reconnect first")?;
    telegram_send_inline_keyboard(&token, chat_id, text, buttons).await
}

/// Send an interactive push alert with inline keyboard buttons via Telegram.
#[tauri::command]
pub async fn gateway_send_push_alert(
    channel_id: String,
    chat_id: String,
    text: String,
    buttons: Vec<(String, String)>, // (label, callback_data)
    state: tauri::State<'_, Arc<GatewayManager>>,
) -> Result<String, String> {
    let mgr = state.inner();
    let is_connected = {
        let conns = mgr.lock_connections();
        conns.get(&channel_id).map(|i| i.state == GatewayState::Connected).unwrap_or(false)
    };
    if !is_connected {
        return Err(format!("Channel '{channel_id}' is not connected"));
    }

    let token = mgr.get_token(&channel_id).ok_or("No token stored for this channel — reconnect first")?;

    match channel_id.as_str() {
        "telegram" => telegram_send_inline_keyboard(&token, &chat_id, &text, buttons).await,
        other => Err(format!("Push alerts not implemented for '{other}'")),
    }
}

/// Send an interactive push alert with inline keyboard buttons via Telegram.
async fn telegram_send_inline_keyboard(
    token: &str,
    chat_id: &str,
    text: &str,
    buttons: Vec<(String, String)>, // (label, callback_data)
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;

    let keyboard: Vec<Vec<serde_json::Value>> = buttons
        .iter()
        .map(|(label, data)| {
            vec![serde_json::json!({
                "text": label,
                "callback_data": data,
            })]
        })
        .collect();

    let resp = client
        .post(format!("https://api.telegram.org/bot{token}/sendMessage"))
        .json(&serde_json::json!({
            "chat_id": chat_id,
            "text": text,
            "parse_mode": "Markdown",
            "reply_markup": {
                "inline_keyboard": keyboard,
            },
        }))
        .send()
        .await
        .map_err(|e| format!("Failed to send Telegram inline keyboard: {}", sanitize_reqwest_error(&e)))?;

    let body: serde_json::Value = resp.json().await.map_err(|e| format!("Invalid response: {}", sanitize_reqwest_error(&e)))?;

    if body.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
        Ok(format!("Interactive alert sent to Telegram chat {chat_id}"))
    } else {
        let desc = body.get("description").and_then(|v| v.as_str()).unwrap_or("Unknown error");
        Err(format!("Telegram inline keyboard send failed: {}", sanitize_error_body(desc, 200)))
    }
}

// ─────────────────────────────────────────────────────────────
// Discord Bot Gateway — real implementation
// ─────────────────────────────────────────────────────────────

async fn connect_discord(
    mgr: Arc<GatewayManager>,
    channel_id: String,
    token: String,
    _owner_id: String,
) -> Result<GatewayConnectionInfo, String> {
    if token.trim().is_empty() {
        mgr.set_state(&channel_id, GatewayState::Error, Some("Bot token is required. Create a bot at discord.com/developers.".into()));
        mgr.emit_status(&channel_id);
        return Err("Bot token is required".into());
    }

    mgr.set_state(&channel_id, GatewayState::Validating, None);
    mgr.emit_status(&channel_id);

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;

    // Validate token via /users/@me
    let me_resp = client
        .get("https://discord.com/api/v10/users/@me")
        .header("Authorization", format!("Bot {token}"))
        .send()
        .await
        .map_err(|e| {
            let msg = format!("Network error reaching Discord API: {}", sanitize_reqwest_error(&e));
            mgr.set_state(&channel_id, GatewayState::Error, Some(msg.clone()));
            mgr.emit_status(&channel_id);
            msg
        })?;

    if !me_resp.status().is_success() {
        let status = me_resp.status();
        let body = me_resp.text().await.unwrap_or_default();
        let msg = format!("Discord API rejected the token (HTTP {status}): {}", sanitize_error_body(&body, 200));
        mgr.set_state(&channel_id, GatewayState::Error, Some(msg.clone()));
        mgr.emit_status(&channel_id);
        return Err(msg);
    }

    let me_body: serde_json::Value = me_resp.json().await.map_err(|e| {
        let msg = format!("Invalid response from Discord: {}", sanitize_reqwest_error(&e));
        mgr.set_state(&channel_id, GatewayState::Error, Some(msg.clone()));
        mgr.emit_status(&channel_id);
        msg
    })?;

    let bot_username = me_body.get("username").and_then(|v| v.as_str()).unwrap_or("unknown");
    let bot_discriminator = me_body.get("discriminator").and_then(|v| v.as_str()).unwrap_or("0000");
    let bot_id = me_body.get("id").and_then(|v| v.as_str()).unwrap_or("");

    mgr.set_platform_user(
        &channel_id,
        Some(format!("{bot_username}#{bot_discriminator}")),
        Some(bot_id.to_string()),
    );
    mgr.set_state(&channel_id, GatewayState::Connecting, None);
    mgr.emit_status(&channel_id);

    // Get the gateway URL
    let gw_resp = client
        .get("https://discord.com/api/v10/gateway/bot")
        .header("Authorization", format!("Bot {token}"))
        .send()
        .await
        .map_err(|e| format!("Failed to get Discord gateway URL: {}", sanitize_reqwest_error(&e)))?;

    let gw_body: serde_json::Value = gw_resp.json().await.map_err(|e| format!("Invalid gateway response: {}", sanitize_reqwest_error(&e)))?;
    let gateway_url = gw_body.get("url").and_then(|v| v.as_str()).unwrap_or("wss://gateway.discord.gg");

    mgr.mark_connected(&channel_id);
    mgr.store_token(&channel_id, &token);
    mgr.emit_status(&channel_id);

    // Start WebSocket listener in background
    let cancel = mgr.cancel_flag(&channel_id);
    let mgr_clone = mgr.clone();
    let ch_id = channel_id.clone();
    let ws_token = token.clone();
    let ws_url = format!("{gateway_url}/?v=10&encoding=json");

    tokio::spawn(async move {
        discord_gateway_loop(mgr_clone, ch_id, ws_token, ws_url, cancel).await;
    });

    let info = mgr.lock_connections().get(&channel_id).cloned().unwrap_or(GatewayConnectionInfo {
        channel_id,
        state: GatewayState::Connected,
        platform_user: Some(format!("{bot_username}#{bot_discriminator}")),
        platform_user_id: Some(bot_id.to_string()),
        error: None,
        connected_at_ms: Some(now_ms()),
        messages_received: 0,
        messages_sent: 0,
        qr_png_base64: None,
        qr_uri: None,
        owner_id: String::new(),
    });
    Ok(info)
}

/// Discord Gateway WebSocket event loop.
async fn discord_gateway_loop(
    mgr: Arc<GatewayManager>,
    channel_id: String,
    token: String,
    gateway_url: String,
    cancel: Arc<AtomicBool>,
) {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;

    let counter = mgr.msg_counter(&channel_id);
    let mut reconnect_url = gateway_url.clone();
    let mut session_id: Option<String> = None;
    let mut sequence: Option<i64> = None;

    // Outer reconnect loop — handles Discord Reconnect (op 7) and Invalid Session (op 9)
    loop {
        if cancel.load(Ordering::Relaxed) {
            break;
        }

        let ws_stream = match tokio_tungstenite::connect_async(&reconnect_url).await {
            Ok((stream, _)) => stream,
            Err(e) => {
                mgr.set_state(&channel_id, GatewayState::Error, Some(format!("Discord WebSocket connect failed: {e}")));
                mgr.emit_status(&channel_id);
                return;
            }
        };

        let (mut write, mut read) = ws_stream.split();
        let mut heartbeat_interval_ms: u64 = 41250;
        let mut identified = false;
        let mut should_resume = false;
        let mut new_messages = 0u64;

        loop {
            if cancel.load(Ordering::Relaxed) {
                let _ = write.send(Message::Close(None)).await;
                break;
            }

            let msg = match tokio::time::timeout(Duration::from_millis(heartbeat_interval_ms + 5000), read.next()).await {
                Ok(Some(Ok(m))) => m,
                Ok(Some(Err(_))) => break,
                Ok(None) => break,
                Err(_) => {
                    // Timeout — send heartbeat
                    let hb = serde_json::json!({"op": 1, "d": sequence});
                    if write.send(Message::Text(hb.to_string())).await.is_err() {
                        break;
                    }
                    continue;
                }
            };

            let text = match msg {
                Message::Text(t) => t,
                Message::Close(_) => break,
                _ => continue,
            };

            let payload: serde_json::Value = match serde_json::from_str(&text) {
                Ok(v) => v,
                Err(_) => continue,
            };

            let op = payload.get("op").and_then(|v| v.as_i64()).unwrap_or(-1);

            if let Some(s) = payload.get("s").and_then(|v| v.as_i64()) {
                sequence = Some(s);
            }

            match op {
                // Hello — send IDENTIFY (or Resume), then first heartbeat immediately
                10 => {
                    if let Some(d) = payload.get("d") {
                        heartbeat_interval_ms = d.get("heartbeat_interval").and_then(|v| v.as_u64()).unwrap_or(41250);
                    }

                    if should_resume {
                        if let Some(sid) = &session_id {
                            let resume = serde_json::json!({
                                "op": 6,
                                "d": {
                                    "token": token,
                                    "session_id": sid,
                                    "seq": sequence,
                                },
                            });
                            if write.send(Message::Text(resume.to_string())).await.is_err() {
                                break;
                            }
                        }
                    } else {
                        let identify = serde_json::json!({
                            "op": 2,
                            "d": {
                                "token": token,
                                "intents": 1 | 512 | 4096 | 32768, // GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT
                                "properties": {
                                    "os": "windows",
                                    "browser": "ronic-os",
                                    "device": "ronic-os",
                                },
                            },
                        });
                        if write.send(Message::Text(identify.to_string())).await.is_err() {
                            break;
                        }
                    }

                    // Send the first heartbeat immediately after IDENTIFY/Resume
                    let hb = serde_json::json!({"op": 1, "d": sequence});
                    if write.send(Message::Text(hb.to_string())).await.is_err() {
                        break;
                    }
                }
                11 => {} // Heartbeat ACK
                0 => {
                    let event_type = payload.get("t").and_then(|v| v.as_str()).unwrap_or("");
                    match event_type {
                        "READY" => {
                            session_id = payload
                                .get("d")
                                .and_then(|d| d.get("session_id"))
                                .and_then(|v| v.as_str())
                                .map(String::from);
                            identified = true;
                            mgr.mark_connected(&channel_id);
                            mgr.emit_status(&channel_id);
                        }
                        "MESSAGE_CREATE" => {
                            if let Some(d) = payload.get("d") {
                                let content = d.get("content").and_then(|v| v.as_str()).unwrap_or("");
                                if content.is_empty() {
                                    continue;
                                }
                                let author = d.get("author");
                                let is_bot = author
                                    .and_then(|a| a.get("bot"))
                                    .and_then(|v| v.as_bool())
                                    .unwrap_or(false);
                                if is_bot {
                                    continue;
                                }

                                let sender_id = author
                                    .and_then(|a| a.get("id"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                let sender_name = author
                                    .and_then(|a| a.get("username"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("Unknown");
                                let ch_id = d.get("channel_id").and_then(|v| v.as_str()).unwrap_or("");
                                let msg_id = d.get("id").and_then(|v| v.as_str()).unwrap_or("");

                                let incoming = IncomingGatewayMessage {
                                    channel_id: channel_id.clone(),
                                    sender_id,
                                    sender_display: sender_name.to_string(),
                                    text: content.to_string(),
                                    chat_id: ch_id.to_string(),
                                    timestamp_ms: now_ms(),
                                    platform_message_id: Some(msg_id.to_string()),
                                };

                                counter.fetch_add(1, Ordering::Relaxed);
                                new_messages += 1;
                                mgr.push_inbox(incoming);
                            }
                        }
                        _ => {}
                    }
                }
                // Reconnect requested by Discord
                7 => {
                    break; // Break inner loop → outer loop reconnects
                }
                // Invalid session
                9 => {
                    let can_resume = payload.get("d").and_then(|v| v.as_bool()).unwrap_or(false);
                    if can_resume && session_id.is_some() {
                        should_resume = true;
                        // Break inner loop → outer loop reconnects and sends Resume
                        break;
                    } else {
                        // Can't resume — full re-identify needed
                        session_id = None;
                        sequence = None;
                        should_resume = false;
                        break;
                    }
                }
                _ => {}
            }
        }

        // Batch emit once per connection cycle
        if new_messages > 0 {
            mgr.sync_msg_counter(&channel_id);
            mgr.emit_status(&channel_id);
        }

        if !should_resume && identified {
            // Clean disconnect (op 7 or cancel) — mark disconnected
            mgr.set_state(&channel_id, GatewayState::Disconnected, None);
            mgr.emit_status(&channel_id);
            break;
        }

        if cancel.load(Ordering::Relaxed) {
            break;
        }

        // Brief pause before reconnect
        tokio::time::sleep(Duration::from_secs(1)).await;
    }

    mgr.set_state(&channel_id, GatewayState::Disconnected, None);
    mgr.emit_status(&channel_id);
}

/// Send a message via Discord REST API.
async fn discord_send_message(token: &str, channel_id: &str, text: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;

    let resp = client
        .post(format!("https://discord.com/api/v10/channels/{channel_id}/messages"))
        .header("Authorization", format!("Bot {token}"))
        .json(&serde_json::json!({ "content": text }))
        .send()
        .await
        .map_err(|e| format!("Failed to send Discord message: {}", sanitize_reqwest_error(&e)))?;

    if resp.status().is_success() {
        Ok(format!("Message sent to Discord channel {channel_id}"))
    } else {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        Err(format!("Discord send failed (HTTP {status}): {}", sanitize_error_body(&body, 200)))
    }
}

// ─────────────────────────────────────────────────────────────
// Slack Socket Mode — real implementation
// ─────────────────────────────────────────────────────────────

async fn connect_slack(
    mgr: Arc<GatewayManager>,
    channel_id: String,
    token: String,
    _owner_id: String,
) -> Result<GatewayConnectionInfo, String> {
    // Slack needs two tokens: bot token (xoxb-) and app-level token (xapp-)
    let (bot_token, app_token) = if token.contains('/') {
        let mut parts = token.splitn(2, '/');
        (parts.next().unwrap_or("").to_string(), parts.next().unwrap_or("").to_string())
    } else {
        (token.clone(), String::new())
    };

    if bot_token.trim().is_empty() {
        mgr.set_state(&channel_id, GatewayState::Error, Some(
            "Bot token (xoxb-...) is required. For Socket Mode also provide the app-level token (xapp-...) as 'xoxb-token/xapp-token'.".into()
        ));
        mgr.emit_status(&channel_id);
        return Err("Bot token is required".into());
    }

    mgr.set_state(&channel_id, GatewayState::Validating, None);
    mgr.emit_status(&channel_id);

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;

    // Validate via auth.test
    let auth_resp = client
        .post("https://slack.com/api/auth.test")
        .header("Authorization", format!("Bearer {bot_token}"))
        .send()
        .await
        .map_err(|e| {
            let msg = format!("Network error reaching Slack API: {}", sanitize_reqwest_error(&e));
            mgr.set_state(&channel_id, GatewayState::Error, Some(msg.clone()));
            mgr.emit_status(&channel_id);
            msg
        })?;

    let auth_body: serde_json::Value = auth_resp.json().await.map_err(|e| {
        let msg = format!("Invalid response from Slack: {}", sanitize_reqwest_error(&e));
        mgr.set_state(&channel_id, GatewayState::Error, Some(msg.clone()));
        mgr.emit_status(&channel_id);
        msg
    })?;

    if !auth_body.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
        let err = auth_body.get("error").and_then(|v| v.as_str()).unwrap_or("Unknown error");
        let msg = format!("Slack API rejected the token: {}", sanitize_error_body(err, 200));
        mgr.set_state(&channel_id, GatewayState::Error, Some(msg.clone()));
        mgr.emit_status(&channel_id);
        return Err(msg);
    }

    let bot_user = auth_body.get("user").and_then(|v| v.as_str()).unwrap_or("unknown");
    let bot_user_id = auth_body.get("user_id").and_then(|v| v.as_str()).unwrap_or("");
    let team = auth_body.get("team").and_then(|v| v.as_str()).unwrap_or("");

    mgr.set_platform_user(
        &channel_id,
        Some(format!("{bot_user} ({team})")),
        Some(bot_user_id.to_string()),
    );

    if app_token.is_empty() {
        // Without the app-level token we can't use Socket Mode — mark as connected
        // but note that real-time events are unavailable
        mgr.set_state(&channel_id, GatewayState::Connected, Some(
            "Connected (REST only). For real-time events, provide 'xoxb-token/xapp-token'.".into()
        ));
        mgr.store_token(&channel_id, &bot_token);
        mgr.emit_status(&channel_id);
    } else {
        mgr.set_state(&channel_id, GatewayState::Connecting, None);
        mgr.emit_status(&channel_id);

        // Get Socket Mode WebSocket URL
        let ws_resp = client
            .post("https://slack.com/api/apps.connections.open")
            .header("Authorization", format!("Bearer {app_token}"))
            .send()
            .await
            .map_err(|e| format!("Failed to open Slack Socket Mode connection: {}", sanitize_reqwest_error(&e)))?;

        let ws_body: serde_json::Value = ws_resp.json().await.map_err(|e| format!("Invalid Socket Mode response: {}", sanitize_reqwest_error(&e)))?;

        if !ws_body.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
            let err = ws_body.get("error").and_then(|v| v.as_str()).unwrap_or("Unknown error");
            let msg = format!("Slack Socket Mode failed: {}", sanitize_error_body(err, 200));
            mgr.set_state(&channel_id, GatewayState::Error, Some(msg.clone()));
            mgr.emit_status(&channel_id);
            return Err(msg);
        }

        let ws_url = ws_body.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string();

        mgr.mark_connected(&channel_id);
        mgr.store_token(&channel_id, &bot_token);
        mgr.emit_status(&channel_id);

        // Start Socket Mode listener
        let cancel = mgr.cancel_flag(&channel_id);
        let mgr_clone = mgr.clone();
        let ch_id = channel_id.clone();

        tokio::spawn(async move {
            slack_socket_mode_loop(mgr_clone, ch_id, ws_url, cancel).await;
        });
    }

    let info = mgr.lock_connections().get(&channel_id).cloned().unwrap_or(GatewayConnectionInfo {
        channel_id,
        state: GatewayState::Connected,
        platform_user: Some(format!("{bot_user} ({team})")),
        platform_user_id: Some(bot_user_id.to_string()),
        error: None,
        connected_at_ms: Some(now_ms()),
        messages_received: 0,
        messages_sent: 0,
        qr_png_base64: None,
        qr_uri: None,
        owner_id: String::new(),
    });
    Ok(info)
}

/// Slack Socket Mode WebSocket event loop.
async fn slack_socket_mode_loop(
    mgr: Arc<GatewayManager>,
    channel_id: String,
    ws_url: String,
    cancel: Arc<AtomicBool>,
) {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;

    let counter = mgr.msg_counter(&channel_id);

    let ws_stream = match tokio_tungstenite::connect_async(&ws_url).await {
        Ok((stream, _)) => stream,
        Err(e) => {
            mgr.set_state(&channel_id, GatewayState::Error, Some(format!("Slack WebSocket connect failed: {e}")));
            mgr.emit_status(&channel_id);
            return;
        }
    };

    let (mut write, mut read) = ws_stream.split();
    let mut new_messages = 0u64;

    loop {
        if cancel.load(Ordering::Relaxed) {
            let _ = write.send(Message::Close(None)).await;
            break;
        }

        let msg = match tokio::time::timeout(Duration::from_secs(30), read.next()).await {
            Ok(Some(Ok(m))) => m,
            Ok(Some(Err(_))) => break,
            Ok(None) => break,
            Err(_) => continue, // Ping timeout — Slack handles keepalive
        };

        let text = match msg {
            Message::Text(t) => t,
            Message::Close(_) => break,
            _ => continue,
        };

        let envelope: serde_json::Value = match serde_json::from_str(&text) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let envelope_type = envelope.get("type").and_then(|v| v.as_str()).unwrap_or("");

        match envelope_type {
            "hello" => {
                mgr.mark_connected(&channel_id);
                mgr.emit_status(&channel_id);
            }
            "events_api" => {
                // Acknowledge the envelope immediately (before processing)
                if let Some(eid) = envelope.get("envelope_id").and_then(|v| v.as_str()) {
                    let ack = serde_json::json!({"envelope_id": eid});
                    let _ = write.send(Message::Text(ack.to_string())).await;
                }

                // Extract the event
                if let Some(event) = envelope.get("payload").and_then(|p| p.get("event")) {
                    let event_type = event.get("type").and_then(|v| v.as_str()).unwrap_or("");
                    if event_type == "message" {
                        let subtype = event.get("subtype").and_then(|v| v.as_str());
                        if subtype.is_some() {
                            continue; // Skip bot messages, edits, etc.
                        }

                        let text_content = event.get("text").and_then(|v| v.as_str()).unwrap_or("");
                        if text_content.is_empty() {
                            continue;
                        }

                        let sender_id = event.get("user").and_then(|v| v.as_str()).unwrap_or("");
                        let channel = event.get("channel").and_then(|v| v.as_str()).unwrap_or("");
                        let ts = event.get("ts").and_then(|v| v.as_str()).unwrap_or("");

                        let incoming = IncomingGatewayMessage {
                            channel_id: channel_id.clone(),
                            sender_id: sender_id.to_string(),
                            sender_display: sender_id.to_string(),
                            text: text_content.to_string(),
                            chat_id: channel.to_string(),
                            timestamp_ms: now_ms(),
                            platform_message_id: Some(ts.to_string()),
                        };

                        counter.fetch_add(1, Ordering::Relaxed);
                        new_messages += 1;
                        mgr.push_inbox(incoming);
                    }
                }
            }
            "disconnect" => {
                break;
            }
            _ => {}
        }
    }

    // Batch emit once per connection cycle
    if new_messages > 0 {
        mgr.sync_msg_counter(&channel_id);
    }
    mgr.set_state(&channel_id, GatewayState::Disconnected, None);
    mgr.emit_status(&channel_id);
}

/// Send a message via Slack Web API.
async fn slack_send_message(token: &str, channel: &str, text: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;

    let resp = client
        .post("https://slack.com/api/chat.postMessage")
        .header("Authorization", format!("Bearer {token}"))
        .json(&serde_json::json!({
            "channel": channel,
            "text": text,
        }))
        .send()
        .await
        .map_err(|e| format!("Failed to send Slack message: {}", sanitize_reqwest_error(&e)))?;

    let body: serde_json::Value = resp.json().await.map_err(|e| format!("Invalid response: {}", sanitize_reqwest_error(&e)))?;

    if body.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
        Ok(format!("Message sent to Slack channel {channel}"))
    } else {
        let err = body.get("error").and_then(|v| v.as_str()).unwrap_or("Unknown error");
        Err(format!("Slack send failed: {}", sanitize_error_body(err, 200)))
    }
}

// ─────────────────────────────────────────────────────────────
// WhatsApp — QR pairing bridge
// ─────────────────────────────────────────────────────────────

fn whatsapp_token_is_pairing(token: &str) -> bool {
    let trimmed = token.trim();
    trimmed.is_empty() || trimmed == "pair"
}

async fn connect_whatsapp(
    mgr: Arc<GatewayManager>,
    channel_id: String,
    token: String,
    _owner_id: String,
) -> Result<GatewayConnectionInfo, String> {
    // An optional Cloud API token authenticates against Graph. With no token,
    // the channel waits on a scannable pairing QR. The PNG is on the returned
    // info — status events strip it.
    if !whatsapp_token_is_pairing(&token) {
        whatsapp_link::stop(&mgr);
        return connect_whatsapp_cloud(mgr, channel_id, token.trim().to_string()).await;
    }

    whatsapp_link::begin(&mgr, true).await
}

async fn connect_whatsapp_cloud(
    mgr: Arc<GatewayManager>,
    channel_id: String,
    token: String,
) -> Result<GatewayConnectionInfo, String> {
    mgr.set_state(&channel_id, GatewayState::Validating, None);
    mgr.emit_status(&channel_id);

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;

    let resp = client
        .get("https://graph.facebook.com/v21.0/me")
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| {
            let msg = format!("Network error reaching WhatsApp Cloud API: {}", sanitize_reqwest_error(&e));
            mgr.set_state(&channel_id, GatewayState::Error, Some(msg.clone()));
            mgr.emit_status(&channel_id);
            msg
        })?;

    let status = resp.status();
    let body: serde_json::Value = resp.json().await.map_err(|e| {
        let msg = format!("Invalid response from WhatsApp Cloud API: {}", sanitize_reqwest_error(&e));
        mgr.set_state(&channel_id, GatewayState::Error, Some(msg.clone()));
        mgr.emit_status(&channel_id);
        msg
    })?;

    if !status.is_success() {
        let desc = body.get("error").and_then(|v| v.get("message")).and_then(|v| v.as_str()).unwrap_or("rejected");
        let msg = format!("WhatsApp Cloud API rejected the token: {}", sanitize_error_body(desc, 200));
        mgr.set_state(&channel_id, GatewayState::Error, Some(msg.clone()));
        mgr.emit_status(&channel_id);
        return Err(msg);
    }

    let name = body.get("name").and_then(|v| v.as_str()).unwrap_or("WhatsApp Cloud");
    let id = body.get("id").and_then(|v| v.as_str()).unwrap_or("");
    mgr.set_platform_user(&channel_id, Some(format!("Cloud API · {name}")), Some(id.to_string()));
    mgr.mark_connected(&channel_id);
    mgr.store_token(&channel_id, &token);
    mgr.set_qr(&channel_id, None, None);
    mgr.emit_status(&channel_id);

    let info = mgr.lock_connections().get(&channel_id).cloned().unwrap_or(GatewayConnectionInfo {
        channel_id,
        state: GatewayState::Connected,
        platform_user: Some(format!("Cloud API · {name}")),
        platform_user_id: Some(id.to_string()),
        error: None,
        connected_at_ms: Some(now_ms()),
        messages_received: 0,
        messages_sent: 0,
        qr_png_base64: None,
        qr_uri: None,
        owner_id: String::new(),
    });
    Ok(info)
}

// ─────────────────────────────────────────────────────────────
// QR pairing — same-Wi-Fi confirm page
// ─────────────────────────────────────────────────────────────

const PAIR_TTL_MS: u64 = 10 * 60 * 1000;

fn channel_pairs_by_scan(channel_id: &str) -> bool {
    // WhatsApp is a linked-device session, not this confirm page.
    matches!(channel_id, "signal" | "wechat" | "bluebubbles")
}

fn channel_label(channel_id: &str) -> &str {
    match channel_id {
        "whatsapp" => "WhatsApp",
        "signal" => "Signal",
        "wechat" => "WeChat",
        "bluebubbles" => "iMessage",
        "telegram" => "Telegram",
        other => other,
    }
}

fn pairing_http_uri(host: &str, port: u16, channel_id: &str, code: &str) -> String {
    format!("http://{host}:{port}/pair?channel={channel_id}&code={code}")
}

fn lan_ipv4() -> String {
    let Ok(socket) = std::net::UdpSocket::bind("0.0.0.0:0") else {
        return "127.0.0.1".into();
    };
    if socket.connect("8.8.8.8:80").is_err() {
        return "127.0.0.1".into();
    }
    match socket.local_addr() {
        Ok(addr) => match addr.ip() {
            std::net::IpAddr::V4(ip) if !ip.is_loopback() && !ip.is_unspecified() => ip.to_string(),
            _ => "127.0.0.1".into(),
        },
        Err(_) => "127.0.0.1".into(),
    }
}

fn codes_match(expected: &str, given: &str) -> bool {
    let left = expected.as_bytes();
    let right = given.as_bytes();
    if left.len() != right.len() {
        return false;
    }
    let mut diff = 0u8;
    for (a, b) in left.iter().zip(right.iter()) {
        diff |= a ^ b;
    }
    diff == 0
}

fn ensure_pair_listener(mgr: &Arc<GatewayManager>) -> Result<(String, u16), String> {
    let mut slot = mgr.pair_listener.lock().unwrap_or_else(|error| error.into_inner());
    if let Some(listener) = slot.as_ref() {
        return Ok((listener.host.clone(), listener.port));
    }
    let listener = std::net::TcpListener::bind("0.0.0.0:0")
        .map_err(|error| format!("Pairing listener failed: {error}"))?;
    let port = listener.local_addr().map_err(|error| format!("Pairing listener failed: {error}"))?.port();
    let host = lan_ipv4();
    let mgr_thread = Arc::clone(mgr);
    std::thread::spawn(move || pair_http_loop(mgr_thread, listener));
    *slot = Some(PairListener { host: host.clone(), port });
    Ok((host, port))
}

fn begin_scan_pairing(mgr: &Arc<GatewayManager>, channel_id: &str, force: bool) -> Result<GatewayConnectionInfo, String> {
    if channel_id == "whatsapp" {
        return Err("WhatsApp links from the phone: WhatsApp, then Linked devices, then Link a device.".into());
    }
    if !channel_pairs_by_scan(channel_id) {
        return Err(format!("{channel_id} connects with a bot token, not a QR code."));
    }
    let token_connected = mgr.is_connected(channel_id) && mgr.get_token(channel_id).is_some();
    if token_connected || (mgr.is_connected(channel_id) && !force) {
        let mut info = mgr.export_public(channel_id);
        info.qr_png_base64 = None;
        info.qr_uri = None;
        return Ok(info);
    }
    let (host, port) = ensure_pair_listener(mgr)?;
    let code = generate_pairing_id();
    mgr.arm_pairing(channel_id, &code, now_ms().saturating_add(PAIR_TTL_MS));
    let uri = pairing_http_uri(&host, port, channel_id, &code);
    let png = generate_qr_png(&uri)?;
    {
        let mut conns = mgr.lock_connections();
        let entry = conns.entry(channel_id.to_string()).or_insert_with(|| blank_connection(channel_id));
        if !matches!(entry.state, GatewayState::Connected | GatewayState::Connecting | GatewayState::Validating) {
            entry.state = GatewayState::AwaitingQrScan;
            entry.error = None;
        }
        entry.qr_png_base64 = Some(png.clone());
        entry.qr_uri = Some(uri.clone());
    }
    mgr.emit_status(channel_id);
    let mut info = mgr.export_public(channel_id);
    info.qr_png_base64 = Some(png);
    info.qr_uri = Some(uri);
    Ok(info)
}

impl GatewayManager {
    /// Marks a scan channel connected when the phone opens the matching confirm page.
    pub fn complete_pairing(&self, channel_id: &str, code: &str) -> Result<(), String> {
        if channel_id == "whatsapp" {
            return Err("WhatsApp links from the phone: WhatsApp, then Linked devices, then Link a device. This page is not a WhatsApp code.".into());
        }
        if !channel_pairs_by_scan(channel_id) {
            return Err("This channel connects with a bot token. A QR scan cannot connect it.".into());
        }
        if self.get_token(channel_id).is_some() && self.is_connected(channel_id) {
            return Err("This channel is already connected with an API token.".into());
        }
        let code = code.trim();
        let pending = {
            let pairs = self.lock_pairs();
            pairs.get(channel_id).map(|item| (item.code.clone(), item.expires_ms))
        };
        let Some((expected, expires_ms)) = pending else {
            if self.is_connected(channel_id) {
                return Err("This channel is already connected.".into());
            }
            return Err("No pairing code is waiting. On the computer, open the channel and refresh the QR.".into());
        };
        if now_ms() >= expires_ms {
            self.lock_pairs().remove(channel_id);
            return Err("That pairing code expired. Refresh the QR on the computer.".into());
        }
        if !codes_match(&expected, code) {
            return Err("That pairing code does not match the one on screen.".into());
        }
        self.lock_pairs().remove(channel_id);
        self.set_platform_user(channel_id, Some("Paired phone".into()), None);
        self.mark_connected(channel_id);
        self.set_qr(channel_id, None, None);
        if self.stored_owner(channel_id).trim().is_empty() {
            self.remember_owner(channel_id, "paired-phone");
        }
        self.emit_status(channel_id);
        Ok(())
    }
}

fn pair_http_loop(mgr: Arc<GatewayManager>, listener: std::net::TcpListener) {
    for stream in listener.incoming() {
        let Ok(mut stream) = stream else { continue };
        let _ = stream.set_read_timeout(Some(Duration::from_secs(4)));
        let _ = stream.set_write_timeout(Some(Duration::from_secs(4)));
        let mut buf = [0u8; 2048];
        let Ok(n) = std::io::Read::read(&mut stream, &mut buf) else { continue };
        if n == 0 {
            continue;
        }
        let request = String::from_utf8_lossy(&buf[..n]);
        let response = handle_pair_http(&mgr, &request);
        let _ = std::io::Write::write_all(&mut stream, &response);
    }
}

fn handle_pair_http(mgr: &GatewayManager, request: &str) -> Vec<u8> {
    let Some(target) = request_target(request) else {
        return http_html(400, "Bad Request", "This page only accepts the pairing link from the QR code.");
    };
    let path = target.split('?').next().unwrap_or(target);
    let channel = query_param(target, "channel").unwrap_or_default();
    let code = query_param(target, "code").unwrap_or_default();
    if !channel_pairs_by_scan(&channel) || !valid_pair_code(&code) {
        return http_html(404, "Not Found", "This pairing link is not valid. Refresh the QR on the computer.");
    }
    let label = channel_label(&channel);
    if path == "/pair/confirm" {
        return match mgr.complete_pairing(&channel, &code) {
            Ok(()) => http_html(200, "OK", &format!(
                "<h1>Phone paired</h1><p>This phone is paired. Ronic OS on your computer now shows {label} as connected. You can close this page.</p>"
            )),
            Err(error) => http_html(400, "Bad Request", &format!("<h1>Not paired</h1><p>{}</p>", html_escape(&error))),
        };
    }
    if path == "/pair" {
        let ready = {
            let pairs = mgr.lock_pairs();
            matches!(pairs.get(&channel), Some(pending) if now_ms() < pending.expires_ms && codes_match(&pending.code, &code))
        };
        if !ready {
            if mgr.is_connected(&channel) {
                return http_html(200, "OK", &format!("<h1>Already paired</h1><p>{label} is already connected on this computer.</p>"));
            }
            return http_html(400, "Bad Request", "<h1>Code expired</h1><p>Refresh the QR on the computer and scan the new code.</p>");
        }
        let body = format!(
            "<h1>Pair this phone</h1><p>This connects the {label} channel in Ronic OS on the computer that showed the QR. It does not log in to WhatsApp, Signal, WeChat, or iMessage.</p><p><a href=\"/pair/confirm?channel={channel}&amp;code={code}\">Confirm pairing</a></p>"
        );
        return http_html(200, "OK", &body);
    }
    http_html(404, "Not Found", "This pairing link is not valid. Refresh the QR on the computer.")
}

fn request_target(request: &str) -> Option<&str> {
    let line = request.lines().next()?.trim();
    let mut parts = line.split_whitespace();
    if parts.next()? != "GET" {
        return None;
    }
    parts.next()
}

fn query_param(target: &str, key: &str) -> Option<String> {
    let query = target.split_once('?')?.1;
    for pair in query.split('&') {
        let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
        if name == key {
            return Some(percent_decode(value));
        }
    }
    None
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex_val(bytes[index + 1]), hex_val(bytes[index + 2])) {
                out.push((hi << 4) | lo);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_val(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn valid_pair_code(code: &str) -> bool {
    code.len() == 32 && code.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn html_escape(value: &str) -> String {
    value.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

fn http_html(status: u16, reason: &str, body_inner: &str) -> Vec<u8> {
    let page = format!(
        "<!doctype html><html><head><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>Ronic OS pairing</title></head><body style=\"font-family:sans-serif;padding:24px;max-width:28rem;line-height:1.45\">{body_inner}</body></html>"
    );
    let header = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n",
        page.len()
    );
    let mut out = header.into_bytes();
    out.extend_from_slice(page.as_bytes());
    out
}

// ─────────────────────────────────────────────────────────────
// QR code generation
// ─────────────────────────────────────────────────────────────

fn generate_qr_png(data: &str) -> Result<String, String> {
    use qrcode::QrCode;

    let code = QrCode::new(data.as_bytes())
        .map_err(|e| format!("QR generation failed: {e}"))?;

    // Render to a simple bitmap, then encode as PNG
    let width = code.width();
    let scale = 8; // 8x scale for readability
    let quiet_zone = 4;
    let total = (width + quiet_zone * 2) * scale;

    let mut img = image::GrayImage::new(total as u32, total as u32);
    // Fill white background
    for pixel in img.pixels_mut() {
        *pixel = image::Luma([255u8]);
    }

    // Draw QR modules
    for y in 0..width {
        for x in 0..width {
            let color = code[(x, y)];
            if color == qrcode::Color::Dark {
                let px = ((x + quiet_zone) * scale) as u32;
                let py = ((y + quiet_zone) * scale) as u32;
                for dy in 0..scale as u32 {
                    for dx in 0..scale as u32 {
                        img.put_pixel(px + dx, py + dy, image::Luma([0u8]));
                    }
                }
            }
        }
    }

    let mut png_bytes = Vec::new();
    let encoder = image::codecs::png::PngEncoder::new(&mut png_bytes);
    use image::ImageEncoder;
    encoder
        .write_image(&img, total as u32, total as u32, image::ExtendedColorType::L8)
        .map_err(|e| format!("PNG encoding failed: {e}"))?;

    Ok(base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &png_bytes))
}

fn generate_pairing_id() -> String {
    let mut bytes = [0u8; 16]; // 128 bits for secure unguessable pairing IDs
    getrandom::getrandom(&mut bytes).unwrap_or_default();
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// ─────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn whatsapp_pairing_token_is_not_a_cloud_credential() {
        assert!(whatsapp_token_is_pairing(""));
        assert!(whatsapp_token_is_pairing("pair"));
        assert!(whatsapp_token_is_pairing("  pair  "));
        assert!(!whatsapp_token_is_pairing("EAA-real-token"));
    }

    #[test]
    fn gateway_state_display() {
        assert_eq!(GatewayState::Disconnected.to_string(), "disconnected");
        assert_eq!(GatewayState::Connected.to_string(), "connected");
        assert_eq!(GatewayState::AwaitingQrScan.to_string(), "awaiting_qr_scan");
        assert_eq!(GatewayState::Error.to_string(), "error");
    }

    #[test]
    fn qr_generation_produces_valid_png() {
        let png_b64 = generate_qr_png("https://example.com/pair/test123").unwrap();
        assert!(!png_b64.is_empty());
        // Verify it's valid base64
        let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &png_b64).unwrap();
        // PNG magic bytes
        assert_eq!(&bytes[..4], &[0x89, 0x50, 0x4E, 0x47]);
    }

    #[test]
    fn pairing_id_is_unique_hex() {
        let id1 = generate_pairing_id();
        let id2 = generate_pairing_id();
        assert_eq!(id1.len(), 32); // 128 bits = 32 hex chars
        assert_ne!(id1, id2);
        assert!(id1.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn manager_tracks_connections() {
        let mgr = GatewayManager::new();
        mgr.set_state("telegram", GatewayState::Validating, None);
        {
            let conns = mgr.connections.lock().unwrap();
            assert_eq!(conns.get("telegram").unwrap().state, GatewayState::Validating);
        }
        mgr.mark_connected("telegram");
        {
            let conns = mgr.connections.lock().unwrap();
            let info = conns.get("telegram").unwrap();
            assert_eq!(info.state, GatewayState::Connected);
            assert!(info.connected_at_ms.is_some());
        }
        mgr.set_state("telegram", GatewayState::Disconnected, None);
        {
            let conns = mgr.connections.lock().unwrap();
            assert_eq!(conns.get("telegram").unwrap().state, GatewayState::Disconnected);
        }
    }

    #[test]
    fn inbox_push_and_drain() {
        let mgr = GatewayManager::new();
        let msg = IncomingGatewayMessage {
            channel_id: "telegram".into(),
            sender_id: "123".into(),
            sender_display: "Test".into(),
            text: "hello".into(),
            chat_id: "456".into(),
            timestamp_ms: 1000,
            platform_message_id: None,
        };
        mgr.push_inbox(msg.clone());
        mgr.push_inbox(msg);
        {
            let inbox = mgr.inbox.lock().unwrap();
            assert_eq!(inbox.len(), 2);
        }
    }

    #[test]
    fn qr_confirm_connects_the_channel_once() {
        let mgr = GatewayManager::new();
        let code = "ab".repeat(16);
        mgr.arm_pairing("signal", &code, now_ms() + 60_000);
        let page = String::from_utf8(handle_pair_http(&mgr, &format!("GET /pair?channel=signal&code={code} HTTP/1.1\r\n"))).unwrap();
        assert!(page.contains("Confirm pairing"));
        assert!(page.contains("does not log in"));
        let confirmed = String::from_utf8(handle_pair_http(&mgr, &format!("GET /pair/confirm?channel=signal&code={code} HTTP/1.1\r\n"))).unwrap();
        assert!(confirmed.contains("Phone paired"));
        assert!(mgr.is_connected("signal"));
        assert_eq!(mgr.stored_owner("signal"), "paired-phone");
        let again = mgr.complete_pairing("signal", &code).unwrap_err();
        assert!(again.contains("already connected"));
    }

    #[test]
    fn whatsapp_qr_is_a_linked_device_code_not_a_web_link() {
        let four = "2@AbCdEf,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=,BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=,CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=";
        let five = format!("{four},1");
        assert!(whatsapp_link::is_companion_code(four));
        assert!(whatsapp_link::is_companion_code(&five));
        assert!(whatsapp_link::is_companion_code(&format!("https://wa.me/settings/linked_devices#{five}")));
        assert!(whatsapp_link::is_companion_code(&format!("{five},https://faq.whatsapp.com/r/ld")));
        assert!(!whatsapp_link::is_companion_code("http://192.168.1.20:47321/pair?channel=whatsapp&code=abcd"));
        assert!(!whatsapp_link::is_companion_code("a,b,c,d"));
        let mgr = GatewayManager::new();
        let err = mgr.complete_pairing("whatsapp", &"ab".repeat(16)).unwrap_err();
        assert!(err.contains("Linked devices"));
        let refused = begin_scan_pairing(&Arc::new(mgr), "whatsapp", true).unwrap_err();
        assert!(refused.contains("Linked devices"));
    }

    #[test]
    fn qr_confirm_rejects_the_wrong_code_and_telegram() {
        let mgr = GatewayManager::new();
        let code = "cd".repeat(16);
        mgr.arm_pairing("signal", &code, now_ms() + 60_000);
        let wrong = String::from_utf8(handle_pair_http(&mgr, "GET /pair/confirm?channel=signal&code=00112233445566778899aabbccddeeff HTTP/1.1\r\n")).unwrap();
        assert!(wrong.contains("does not match"));
        assert!(!mgr.is_connected("signal"));
        let telegram = mgr.complete_pairing("telegram", &code).unwrap_err();
        assert!(telegram.contains("bot token"));
        assert!(!pairing_http_uri("192.168.1.20", 47321, "whatsapp", &code).contains("ronic://"));
    }

    #[test]
    fn expired_qr_and_token_connection_do_not_pair() {
        let mgr = GatewayManager::new();
        mgr.arm_pairing("wechat", &"ef".repeat(16), 0);
        let expired = mgr.complete_pairing("wechat", &"ef".repeat(16)).unwrap_err();
        assert!(expired.contains("expired"));
        mgr.mark_connected("bluebubbles");
        mgr.store_token("bluebubbles", "cloud-token");
        mgr.arm_pairing("bluebubbles", &"aa".repeat(16), now_ms() + 60_000);
        let kept = mgr.complete_pairing("bluebubbles", &"aa".repeat(16)).unwrap_err();
        assert!(kept.contains("API token"));
        assert_eq!(mgr.remember_owner_if_unset("telegram", "8512444167").unwrap(), "8512444167");
        assert_eq!(mgr.remember_owner_if_unset("telegram", "999").unwrap(), "8512444167");
    }

    #[test]
    fn saved_credentials_round_trip_and_a_blank_form_clears_the_channel() {
        let file = upsert_gateway_credential(
            std::collections::BTreeMap::new(),
            "telegram",
            "123456789:AAH-token-token-token-token",
            "8512444167",
            vec![GatewayCredentialExtra { id: "e1".into(), label: "Allowlisted sender".into(), value: "999".into() }],
            Some(true),
        )
        .unwrap();
        let raw = serde_json::to_string(&file).unwrap();
        let parsed = parse_gateway_credentials(&raw);
        assert_eq!(parsed["telegram"].token, "123456789:AAH-token-token-token-token");
        assert_eq!(parsed["telegram"].owner_id, "8512444167");
        assert!(parsed["telegram"].reconnect);
        assert_eq!(parsed["telegram"].extras[0].value, "999");
        let cleared = upsert_gateway_credential(parsed, "telegram", "", "", vec![], None).unwrap();
        assert!(cleared.get("telegram").is_none());
        let kept = upsert_gateway_credential(std::collections::BTreeMap::new(), "whatsapp", "", "", vec![], Some(true)).unwrap();
        assert!(kept["whatsapp"].reconnect);
        assert!(kept["whatsapp"].token.is_empty());
    }

    #[test]
    fn cancel_flag_controls_loop() {
        let mgr = GatewayManager::new();
        let flag = mgr.cancel_flag("test");
        assert!(!flag.load(Ordering::Relaxed));
        mgr.signal_cancel("test");
        assert!(flag.load(Ordering::Relaxed));
        mgr.clear_cancel("test");
        assert!(!flag.load(Ordering::Relaxed));
    }
}
