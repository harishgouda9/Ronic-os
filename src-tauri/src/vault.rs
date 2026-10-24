use crate::db;
use crate::error::{err, Result};
use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::Connection;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::Path;

fn derive(password: &str, salt: &[u8]) -> Result<[u8; 32]> {
    let params = Params::new(19_456, 2, 1, Some(32)).map_err(|e| err(e.to_string()))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut out = [0u8; 32];
    argon.hash_password_into(password.as_bytes(), salt, &mut out).map_err(|e| err(e.to_string()))?;
    Ok(out)
}

fn verifier(key: &[u8; 32]) -> String {
    STANDARD.encode(Sha256::digest(key))
}

fn random_bytes<const N: usize>() -> Result<[u8; N]> {
    let mut buf = [0u8; N];
    getrandom::getrandom(&mut buf).map_err(|e| err(e.to_string()))?;
    Ok(buf)
}

fn nonce() -> Result<[u8; 12]> {
    random_bytes()
}

pub fn load_plaintext(home: &Path) -> HashMap<String, String> {
    let path = home.join("secrets.json");
    let Ok(text) = std::fs::read_to_string(path) else {
        return HashMap::new();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

pub fn set_passphrase(conn: &Connection, home: &Path, password: &str, secrets: &HashMap<String, String>) -> Result<[u8; 32]> {
    if password.len() < 8 {
        return Err(err("use at least 8 characters"));
    }
    let salt = random_bytes::<16>()?;
    let key = derive(password, &salt)?;
    db::kv_set(conn, "vault_salt", &STANDARD.encode(salt))?;
    db::kv_set(conn, "vault_verifier", &verifier(&key))?;
    write_encrypted(home, &key, secrets)?;
    let _ = std::fs::remove_file(home.join("secrets.json"));
    Ok(key)
}

pub fn unlock(conn: &Connection, home: &Path, password: &str) -> Result<(Vec<u8>, HashMap<String, String>)> {
    let salt_b64 = db::kv_get(conn, "vault_salt")?.ok_or_else(|| err("no passphrase is set"))?;
    let expect = db::kv_get(conn, "vault_verifier")?.ok_or_else(|| err("no passphrase is set"))?;
    let salt = STANDARD.decode(salt_b64).map_err(|e| err(e.to_string()))?;
    let key = derive(password, &salt)?;
    if verifier(&key) != expect {
        return Err(err("passphrase does not match"));
    }
    let secrets = read_encrypted(home, &key)?;
    Ok((key.to_vec(), secrets))
}

pub fn persist(home: &Path, conn: &Connection, key: Option<&[u8; 32]>, secrets: &HashMap<String, String>) -> Result<()> {
    if let Some(key) = key {
        write_encrypted(home, key, secrets)?;
        let _ = std::fs::remove_file(home.join("secrets.json"));
    } else if db::kv_get(conn, "vault_verifier")?.is_none() {
        std::fs::write(home.join("secrets.json"), serde_json::to_string_pretty(secrets)?)?;
    } else {
        return Err(err("unlock the vault before saving a key"));
    }
    Ok(())
}

fn write_encrypted(home: &Path, key: &[u8; 32], secrets: &HashMap<String, String>) -> Result<()> {
    let plain = serde_json::to_string(secrets)?;
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| err(e.to_string()))?;
    let n = nonce()?;
    let ct = cipher.encrypt(Nonce::from_slice(&n), plain.as_bytes()).map_err(|e| err(e.to_string()))?;
    let mut blob = n.to_vec();
    blob.extend(ct);
    std::fs::write(home.join("secrets.vault"), blob)?;
    Ok(())
}

fn read_encrypted(home: &Path, key: &[u8; 32]) -> Result<HashMap<String, String>> {
    let path = home.join("secrets.vault");
    let blob = match std::fs::read(&path) {
        Ok(blob) => blob,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(HashMap::new()),
        Err(error) => return Err(err(format!("could not read the vault: {error}"))),
    };
    if blob.is_empty() {
        return Ok(HashMap::new());
    }
    if blob.len() < 13 {
        return Err(err("vault file is truncated"));
    }
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| err(e.to_string()))?;
    let (n, ct) = blob.split_at(12);
    let plain = cipher.decrypt(Nonce::from_slice(n), ct).map_err(|_| err("could not decrypt the vault"))?;
    let text = String::from_utf8(plain).map_err(|e| err(e.to_string()))?;
    serde_json::from_str(&text).map_err(|e| err(e.to_string()))
}
