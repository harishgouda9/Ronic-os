//! Offline licensing engine — blueprint §3.
//!
//! The desktop never calls the cloud on startup to decide entitlements. It
//! caches an Ed25519-signed 7-day lease in state.db and verifies it locally
//! in <0.1ms against the compile-time public key. Editing plan_tier in a
//! SQLite editor achieves nothing: the signature covers user_id, tier,
//! hardware_hash and exp_unix, and the kernel re-checks it on every load.
//!
//! When no `RONIC_ED25519_PUBLIC_KEY` is compiled in (local development),
//! the engine runs in **unsigned dev mode**: cached values load but the
//! snapshot reports `status: "unsigned_dev"` so the UI can label it.

use crate::db::{kv_get, kv_set};
use crate::error::{err, Result};
use crate::models::CommandResult;
use crate::snapshot::{self, Meta};
use crate::AppState;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::OnceLock;
use tauri::State;

/// Fixed lease field order — byte-identical to the Edge Function signer.
pub const LEASE_FIELDS: &[&str] = &["user_id", "tier", "hardware_hash", "max_devices", "iat_unix", "exp_unix"];

pub struct Lease {
    pub user_id: String,
    pub tier: String,
    pub hardware_hash: String,
    pub max_devices: i64,
    pub exp_unix: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseSnapshot {
    pub plan_tier: String,
    pub status: String, // active | expired | unsigned_dev | none
    pub founder_badge: Option<i64>,
    pub max_devices: i64,
    pub wallet_micro_usd: i64,
    pub lease_exp_unix: i64,
    pub hardware_hash: String,
}

fn public_key() -> Option<&'static VerifyingKey> {
    static KEY: OnceLock<Option<VerifyingKey>> = OnceLock::new();
    KEY.get_or_init(|| {
        let text = option_env!("RONIC_ED25519_PUBLIC_KEY").unwrap_or("").trim();
        if text.is_empty() {
            return None;
        }
        match B64.decode(text) {
            Ok(raw) if raw.len() == 32 => VerifyingKey::from_bytes(&raw.try_into().ok()?).ok(),
            _ => None,
        }
    })
    .as_ref()
}

/// Salted SHA-256 hardware fingerprint (COMPUTERNAME + OS + ARCH). The salt
/// keeps the hash from being a trivially replayable dictionary of hostnames.
pub fn hardware_hash() -> String {
    let computer = std::env::var("COMPUTERNAME").unwrap_or_else(|_| "unknown-host".into());
    let raw = format!("ronic-workstation|{computer}|{}|{}", std::env::consts::OS, std::env::consts::ARCH);
    let digest = Sha256::digest(raw.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

fn device_name() -> String {
    std::env::var("COMPUTERNAME").unwrap_or_else(|_| "Ronic workstation".into())
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Verify the raw lease string + base64 signature and return the lease.
pub fn verify_lease(lease_text: &str, sig_b64: &str) -> Result<Lease> {
    let key = public_key().ok_or_else(|| err("no license public key is compiled into this build"))?;
    let sig_bytes = B64.decode(sig_b64.trim()).map_err(|e| err(format!("lease signature is not base64: {e}")))?;
    let signature = Signature::from_slice(&sig_bytes).map_err(|_| err("lease signature has the wrong length"))?;
    key.verify(lease_text.as_bytes(), &signature).map_err(|_| err("lease signature check failed — the lease was not signed by Ronic OS"))?;
    let parsed: LeaseJson = serde_json::from_str(lease_text).map_err(|e| err(format!("lease is not valid JSON: {e}")))?;
    if parsed.exp_unix <= now_unix() {
        return Err(err("lease expired — sign in to refresh it"));
    }
    if parsed.hardware_hash != hardware_hash() {
        return Err(err("lease was signed for a different machine"));
    }
    Ok(Lease {
        user_id: parsed.user_id,
        tier: parsed.tier,
        hardware_hash: parsed.hardware_hash,
        max_devices: parsed.max_devices,
        exp_unix: parsed.exp_unix,
    })
}

#[derive(Deserialize)]
struct LeaseJson {
    user_id: String,
    tier: String,
    hardware_hash: String,
    max_devices: i64,
    // iat_unix stays unparsed: serde ignores it and the signature already
    // covers the exact bytes the signer produced.
    exp_unix: i64,
}

/// Assemble the license block for the snapshot from the local cache.
pub fn load_snapshot(conn: &Connection) -> LicenseSnapshot {
    let tier = kv_get(conn, "license_tier").ok().flatten().unwrap_or_default();
    let exp: i64 = kv_get(conn, "license_exp").ok().flatten().and_then(|v| v.parse().ok()).unwrap_or(0);
    let badge: Option<i64> = kv_get(conn, "license_badge").ok().flatten().and_then(|v| v.parse().ok());
    let max_devices: i64 = kv_get(conn, "license_max_devices").ok().flatten().and_then(|v| v.parse().ok()).unwrap_or(1);
    let wallet: i64 = kv_get(conn, "license_wallet").ok().flatten().and_then(|v| v.parse().ok()).unwrap_or(0);
    let lease = kv_get(conn, "license_lease").ok().flatten().unwrap_or_default();
    let sig = kv_get(conn, "license_sig").ok().flatten().unwrap_or_default();
    let hash = hardware_hash();

    if public_key().is_none() {
        // Dev build: cache is displayed but never treated as verified.
        return LicenseSnapshot {
            plan_tier: if tier.is_empty() { "free".into() } else { tier },
            status: if lease.is_empty() { "none".into() } else { "unsigned_dev".into() },
            founder_badge: badge,
            max_devices,
            wallet_micro_usd: wallet,
            lease_exp_unix: exp,
            hardware_hash: hash,
        };
    }
    if lease.is_empty() || sig.is_empty() {
        return LicenseSnapshot { plan_tier: "free".into(), status: "none".into(), founder_badge: None, max_devices: 1, wallet_micro_usd: 0, lease_exp_unix: 0, hardware_hash: hash };
    }
    match verify_lease(&lease, &sig) {
        Ok(parsed) => LicenseSnapshot {
            plan_tier: parsed.tier,
            status: "active".into(),
            founder_badge: badge,
            max_devices: parsed.max_devices,
            wallet_micro_usd: wallet,
            lease_exp_unix: parsed.exp_unix,
            hardware_hash: hash,
        },
        Err(_) => LicenseSnapshot {
            plan_tier: "free".into(),
            status: if exp <= now_unix() { "expired".into() } else { "invalid".into() },
            founder_badge: None,
            max_devices: 1,
            wallet_micro_usd: 0,
            lease_exp_unix: exp,
            hardware_hash: hash,
        },
    }
}

fn finish_result(state: &AppState, toast: Option<String>) -> Result<CommandResult> {
    let meta = Meta {
        home: state.home.display().to_string(),
        heartbeat_ms: state.heartbeat.load(std::sync::atomic::Ordering::Relaxed),
        proxy_port: state.proxy_port.load(std::sync::atomic::Ordering::Relaxed),
        ipc: state.ipc.lock().unwrap_or_else(|e| e.into_inner()).iter().cloned().collect(),
        unlocked: state.unlocked.load(std::sync::atomic::Ordering::Relaxed),
    };
    let conn = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    Ok(CommandResult {
        snapshot: snapshot::load(&conn, &meta)?,
        toast,
        install_choice: None,
        payload: None,
    })
}

#[tauri::command]
pub async fn license_status(state: State<'_, AppState>) -> Result<CommandResult> {
    finish_result(&state, None)
}

/// Fetch a fresh 7-day lease from the Edge Function and cache it. The token
/// is the caller's Supabase access token; it is used once and never stored.
#[tauri::command]
pub async fn refresh_license(state: State<'_, AppState>, lease_url: String, token: String) -> Result<CommandResult> {
    let url = lease_url.trim().to_string();
    if url.is_empty() {
        return Err(err("no lease endpoint is configured (VITE_LEASE_URL)"));
    }
    let hash = hardware_hash();
    let full = if url.contains('?') { format!("{url}&hardware_hash={hash}") } else { format!("{url}?hardware_hash={hash}") };

    let fetch = tauri::async_runtime::spawn_blocking(move || {
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .map_err(|e| err(e.to_string()))?;
        let res = client
            .get(&full)
            .header("authorization", format!("Bearer {token}"))
            .send()
            .map_err(|e| err(format!("lease endpoint unreachable: {e}")))?;
        let status = res.status();
        let body: serde_json::Value = res.json().map_err(|e| err(format!("lease endpoint answered with invalid JSON: {e}")))?;
        if !status.is_success() {
            let message = body.get("error").and_then(|v| v.as_str()).unwrap_or("lease endpoint refused the request");
            return Err(err(message.to_string()));
        }
        Ok(body)
    })
    .await
    .map_err(|e| err(e.to_string()))??;

    let lease = fetch.get("lease").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let sig = fetch.get("leaseSig").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if lease.is_empty() || sig.is_empty() {
        return Err(err("lease endpoint returned no lease"));
    }

    // Verify before storing. In an unsigned dev build the signature cannot be
    // checked, so the values are cached but flagged as unsigned_dev.
    let (tier, max_devices, exp) = if public_key().is_some() {
        let parsed = verify_lease(&lease, &sig)?;
        (parsed.tier, parsed.max_devices, parsed.exp_unix)
    } else {
        let parsed: LeaseJson = serde_json::from_str(&lease).map_err(|e| err(format!("lease JSON is malformed: {e}")))?;
        (parsed.tier, parsed.max_devices, parsed.exp_unix)
    };

    let badge = fetch.get("founderBadge").and_then(|v| v.as_i64());
    let wallet = fetch.get("walletMicroUsd").and_then(|v| v.as_i64()).unwrap_or(0);
    {
        let conn = state.conn.lock().unwrap_or_else(|e| e.into_inner());
        kv_set(&conn, "license_lease", &lease)?;
        kv_set(&conn, "license_sig", &sig)?;
        kv_set(&conn, "license_tier", &tier)?;
        kv_set(&conn, "license_max_devices", &max_devices.to_string())?;
        kv_set(&conn, "license_exp", &exp.to_string())?;
        kv_set(&conn, "license_wallet", &wallet.to_string())?;
        if let Some(badge) = badge {
            kv_set(&conn, "license_badge", &badge.to_string())?;
        }
        crate::util::ipc_push(&state.ipc, &format!("license/lease_refreshed tier={tier}"));
    }
    let label = if tier == "founder_lifetime" && badge.is_some() {
        format!("Founder Pass #{} verified. License good for 7 days.", badge.unwrap_or(0))
    } else {
        format!("{tier} license verified. Good for 7 days.")
    };
    finish_result(&state, Some(label))
}

/// Where this machine sits in the device activation list (shown before the
/// first registration so the UI can register it deliberately).
#[tauri::command]
pub async fn device_fingerprint() -> std::result::Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "hardwareHash": hardware_hash(),
        "deviceName": device_name(),
        "osPlatform": format!("{} {}", std::env::consts::OS, std::env::consts::ARCH),
    }))
}

const KEYCHAIN_SERVICE: &str = "os.ronic.workstation";
const KEYCHAIN_USER: &str = "supabase_refresh_token";

fn keychain_entry() -> std::result::Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_USER).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cloud_keychain_store(refresh_token: String) -> std::result::Result<(), String> {
    if refresh_token.is_empty() {
        return Err("no token to store".into());
    }
    keychain_entry()?.set_password(&refresh_token).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cloud_keychain_restore() -> std::result::Result<Option<String>, String> {
    match keychain_entry()?.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn cloud_keychain_clear() -> std::result::Result<(), String> {
    match keychain_entry()?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Open a URL in the user's default system browser (the PKCE sign-in flow
/// must leave the WebView so the session cookie belongs to the OS browser).
#[tauri::command]
pub async fn open_system_url(url: String) -> std::result::Result<(), String> {
    let parsed = url::Url::parse(&url).map_err(|_| "not a valid URL".to_string())?;
    if parsed.scheme() != "https" && parsed.host_str() != Some("127.0.0.1") && parsed.host_str() != Some("localhost") {
        return Err("only https or loopback URLs can be opened".into());
    }
    #[cfg(windows)]
    {
        std::process::Command::new("explorer.exe")
            .arg(parsed.to_string())
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("xdg-open")
            .arg(parsed.to_string())
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hardware_hash_is_stable_and_salted() {
        let a = hardware_hash();
        let b = hardware_hash();
        assert_eq!(a, b);
        assert_eq!(a.len(), 64);
        // Not a plain sha256 of any obvious single input.
        let computer = std::env::var("COMPUTERNAME").unwrap_or_else(|_| "unknown-host".into());
        let plain = Sha256::digest(computer.as_bytes());
        assert_ne!(a, digest_hex(&plain));
    }

    fn digest_hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    #[test]
    fn unsigned_build_reports_dev_status() {
        if public_key().is_some() {
            return; // release builds: covered by lease verification instead
        }
        let conn = Connection::open_in_memory().expect("memory db");
        crate::db::migrate(&conn).expect("schema");
        let snap = load_snapshot(&conn);
        assert_eq!(snap.status, "none");
        assert_eq!(snap.plan_tier, "free");
    }
}
