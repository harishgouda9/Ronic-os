//! Live wallet reads. Balances come from a chain RPC or the user's own provider API.
//! This module does not sign transactions and does not invent deposits.

use crate::db;
use crate::error::{err, Result};
use crate::models::ConnectedWallet;
use crate::util::now_ms;
use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::time::Duration;

pub struct BalanceProof {
    pub balance_native: String,
    pub balance_usd: f64,
    pub detail: String,
}

pub fn validate_address(chain: &str, address: &str) -> Result<()> {
    let address = address.trim();
    if address.is_empty() {
        return Err(err("Enter the public address or account id."));
    }
    if address.len() == 66 && address.starts_with("0x") {
        return Err(err("That looks like a private key. Paste the public address. The key stays optional and is never used to sign."));
    }
    match chain {
        "base" | "ethereum" | "arbitrum" | "polygon" | "hyperliquid" => {
            if !is_evm(address) {
                return Err(err("An EVM address is 0x followed by 40 hex characters."));
            }
        }
        "solana" => {
            if !is_solana(address) {
                return Err(err("That Solana address is not valid base58."));
            }
        }
        "razorpay" => {
            if !address.contains('@') && !address.starts_with("acc_") {
                return Err(err("Razorpay needs a UPI id such as name@bank, or an account id."));
            }
        }
        "stripe" => {}
        _ => return Err(err("Unknown wallet network.")),
    }
    Ok(())
}

pub fn fetch_balance(chain: &str, address: &str, secret: &str, connection_type: &str) -> Result<BalanceProof> {
    match chain {
        "base" | "ethereum" | "arbitrum" | "polygon" => fetch_evm(chain, address),
        "solana" => fetch_solana(address),
        "hyperliquid" => fetch_hyperliquid(address),
        "stripe" => fetch_stripe(secret, connection_type),
        "razorpay" => fetch_razorpay(address, secret, connection_type),
        _ => Err(err("Unknown wallet network.")),
    }
}

pub fn insert_wallet(
    conn: &Connection,
    id: &str,
    chain: &str,
    label: &str,
    address: &str,
    connection_type: &str,
    daily_limit_usd: f64,
    key_mask: &str,
    proof: &BalanceProof,
) -> Result<()> {
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM connected_wallets", [], |row| row.get(0))?;
    let explorer = explorer_url(chain, address);
    conn.execute(
        "INSERT INTO connected_wallets (id, chain, label, address, connection_type, status, balance_native, balance_usd, daily_limit_usd, is_default, added_at, key_mask, explorer_url, verified_at)
         VALUES (?1,?2,?3,?4,?5,'active',?6,?7,?8,?9,?10,?11,?12,?10)",
        params![
            id,
            chain,
            if label.trim().is_empty() { chain } else { label.trim() },
            address.trim(),
            connection_type,
            proof.balance_native,
            proof.balance_usd,
            daily_limit_usd.max(0.0),
            if count == 0 { 1 } else { 0 },
            now_ms(),
            key_mask,
            explorer,
        ],
    )?;
    mirror_proven_rails(conn)
}

pub fn update_balance(conn: &Connection, id: &str, proof: &BalanceProof) -> Result<()> {
    let changed = conn.execute(
        "UPDATE connected_wallets SET balance_native = ?1, balance_usd = ?2, verified_at = ?3 WHERE id = ?4",
        params![proof.balance_native, proof.balance_usd, now_ms(), id],
    )?;
    if changed == 0 {
        return Err(err("wallet not found"));
    }
    mirror_proven_rails(conn)
}

pub fn list(conn: &Connection) -> Result<Vec<ConnectedWallet>> {
    let mut stmt = conn.prepare(
        "SELECT id, chain, label, address, connection_type, status, balance_native, balance_usd, daily_limit_usd, is_default, added_at, key_mask, explorer_url, verified_at FROM connected_wallets ORDER BY added_at DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(ConnectedWallet {
            id: row.get(0)?,
            chain: row.get(1)?,
            label: row.get(2)?,
            address: row.get(3)?,
            connection_type: row.get(4)?,
            status: row.get(5)?,
            balance_native: row.get(6)?,
            balance_usd: row.get(7)?,
            daily_limit_usd: row.get(8)?,
            is_default: row.get::<_, i64>(9)? != 0,
            added_at: row.get(10)?,
            key_mask: row.get(11)?,
            explorer_url: row.get(12)?,
            verified_at: row.get(13)?,
        })
    })?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

pub fn load_row(conn: &Connection, id: &str) -> Result<(String, String, String, String)> {
    conn.query_row(
        "SELECT chain, address, connection_type, status FROM connected_wallets WHERE id = ?1",
        params![id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    )
    .map_err(|_| err("wallet not found"))
}

pub fn set_status(conn: &Connection, id: &str, status: &str) -> Result<()> {
    if status != "active" && status != "frozen" {
        return Err(err("wallet status must be active or frozen"));
    }
    let changed = conn.execute("UPDATE connected_wallets SET status = ?1 WHERE id = ?2", params![status, id])?;
    if changed == 0 {
        return Err(err("wallet not found"));
    }
    Ok(())
}

pub fn set_default(conn: &Connection, id: &str) -> Result<()> {
    let exists: i64 = conn.query_row("SELECT COUNT(*) FROM connected_wallets WHERE id = ?1", params![id], |row| row.get(0))?;
    if exists == 0 {
        return Err(err("wallet not found"));
    }
    conn.execute("UPDATE connected_wallets SET is_default = CASE WHEN id = ?1 THEN 1 ELSE 0 END", params![id])?;
    Ok(())
}

pub fn delete_wallet(conn: &Connection, id: &str) -> Result<()> {
    let changed = conn.execute("DELETE FROM connected_wallets WHERE id = ?1", params![id])?;
    if changed == 0 {
        return Err(err("wallet not found"));
    }
    mirror_proven_rails(conn)
}

pub fn assign_bot_spend(conn: &Connection, bot_id: &str, limit_usd: f64) -> Result<String> {
    if !limit_usd.is_finite() || limit_usd < 0.0 {
        return Err(err("The bot budget has to be a positive amount, or zero."));
    }
    let verified: f64 = conn
        .query_row(
            "SELECT COALESCE(SUM(balance_usd), 0) FROM connected_wallets WHERE status = 'active' AND verified_at > 0",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0.0);
    if limit_usd > verified + 0.009 {
        return Err(err(format!(
            "That budget is ${limit_usd:.2}. Verified wallets currently show ${verified:.2}. Refresh a wallet before assigning more than that."
        )));
    }
    let changed = conn.execute(
        "UPDATE bot_profiles SET daily_wallet_limit_usd = ?1 WHERE id = ?2",
        params![limit_usd, bot_id],
    )?;
    if changed == 0 {
        return Err(err("bot not found"));
    }
    let handle: String = conn
        .query_row("SELECT handle FROM bot_profiles WHERE id = ?1", params![bot_id], |row| row.get(0))
        .unwrap_or_else(|_| bot_id.to_string());
    Ok(format!("{handle} can spend up to ${limit_usd:.2} per day from the verified balance."))
}

pub fn set_pin(conn: &Connection, pin: &str, current: &str) -> Result<String> {
    if pin.len() < 4 || pin.len() > 8 || !pin.chars().all(|ch| ch.is_ascii_digit()) {
        return Err(err("Use a 4 to 8 digit PIN. There is no default PIN."));
    }
    if let Some(stored) = db::kv_get(conn, "wallet_pin")? {
        if !stored.is_empty() && !pin_matches(current, &stored) {
            return Err(err("The current PIN does not match."));
        }
    }
    db::kv_set(conn, "wallet_pin", &hash_pin(pin)?)?;
    Ok("Wallet PIN saved. There is no default PIN.".into())
}

pub fn check_pin(conn: &Connection, pin: &str) -> Result<()> {
    let stored = db::kv_get(conn, "wallet_pin")?.unwrap_or_default();
    if stored.is_empty() {
        return Err(err("Set a wallet PIN on the security tab before this action. There is no default PIN."));
    }
    if !pin_matches(pin, &stored) {
        return Err(err("Incorrect wallet PIN."));
    }
    Ok(())
}

pub fn pin_is_set(conn: &Connection) -> bool {
    db::kv_get(conn, "wallet_pin").ok().flatten().map(|value| !value.is_empty()).unwrap_or(false)
}

fn mirror_proven_rails(conn: &Connection) -> Result<()> {
    let wallets = list(conn)?;
    for (rail, label, native_zero) in [
        ("crypto_x402", "Crypto & x402", "0.00 USDC"),
        ("hyperliquid_ws", "Hyperliquid L1 margin", "0.00 USDC"),
        ("stripe_card", "Stripe virtual card", "$0.00"),
        ("razorpay_upi", "Razorpay India", "₹0"),
    ] {
        let matching: Vec<&ConnectedWallet> = wallets.iter().filter(|wallet| rail_for(&wallet.chain) == rail && wallet.verified_at > 0).collect();
        if matching.is_empty() {
            continue;
        }
        let usd: f64 = matching.iter().map(|wallet| wallet.balance_usd).sum();
        let native = if rail == "razorpay_upi" {
            format!("₹{:.0}", usd * 83.0)
        } else {
            format!("{usd:.2} verified")
        };
        let native_value = if rail == "razorpay_upi" { usd * 83.0 } else { usd };
        conn.execute(
            "INSERT OR IGNORE INTO wallet_balances (rail, label, amount_usd, native_amount, native_value, detail) VALUES (?1,?2,0,?3,0,'')",
            params![rail, label, native_zero],
        )?;
        conn.execute(
            "UPDATE wallet_balances SET amount_usd = ?1, native_value = ?2, native_amount = ?3, detail = ?4 WHERE rail = ?5",
            params![usd, native_value, native, "Last successful chain or provider read. This is not a typed deposit.", rail],
        )?;
    }
    Ok(())
}

fn rail_for(chain: &str) -> &'static str {
    match chain {
        "hyperliquid" => "hyperliquid_ws",
        "stripe" => "stripe_card",
        "razorpay" => "razorpay_upi",
        _ => "crypto_x402",
    }
}

fn fetch_evm(chain: &str, address: &str) -> Result<BalanceProof> {
    let rpc = match chain {
        "base" => "https://mainnet.base.org",
        "ethereum" => "https://cloudflare-eth.com",
        "arbitrum" => "https://arb1.arbitrum.io/rpc",
        "polygon" => "https://polygon-rpc.com",
        _ => return Err(err("No RPC is configured for that chain.")),
    };
    let native_hex = rpc_result(rpc, "eth_getBalance", json!([address, "latest"]))?;
    let native = hex_to_units(&native_hex, 18)?;
    let symbol = if chain == "polygon" { "POL" } else { "ETH" };
    let (usdc, usdc_text) = if let Some(contract) = usdc_contract(chain) {
        let data = format!("0x70a08231{:0>64}", address.trim_start_matches("0x").to_ascii_lowercase());
        match rpc_result(rpc, "eth_call", json!([{"to": contract, "data": data}, "latest"])) {
            Ok(hex) => {
                let amount = hex_to_units(&hex, 6).unwrap_or(0.0);
                (amount, format!("{amount:.2} USDC"))
            }
            Err(_) => (0.0, "USDC unread".into()),
        }
    } else {
        (0.0, String::new())
    };
    let priced = if usdc > 0.0 {
        usdc
    } else if let Some(price) = spot_price(if chain == "polygon" { "POL-USD" } else { "ETH-USD" }) {
        native * price
    } else {
        0.0
    };
    Ok(BalanceProof {
        balance_native: if usdc_text.is_empty() { format!("{native:.6} {symbol}") } else { format!("{usdc_text} · {native:.6} {symbol}") },
        balance_usd: priced,
        detail: format!("Read from {rpc}."),
    })
}

fn fetch_solana(address: &str) -> Result<BalanceProof> {
    let body = post_json(
        "https://api.mainnet-beta.solana.com",
        json!({"jsonrpc":"2.0","id":1,"method":"getBalance","params":[address]}),
        &[],
    )?;
    let lamports = body["result"]["value"].as_f64().or_else(|| body["result"]["value"].as_i64().map(|n| n as f64)).ok_or_else(|| err("Solana did not return a balance."))?;
    let sol = lamports / 1_000_000_000.0;
    let usd = spot_price("SOL-USD").map(|price| sol * price).unwrap_or(0.0);
    Ok(BalanceProof {
        balance_native: format!("{sol:.6} SOL"),
        balance_usd: usd,
        detail: "Read from the Solana mainnet RPC.".into(),
    })
}

fn fetch_hyperliquid(address: &str) -> Result<BalanceProof> {
    let body = post_json(
        "https://api.hyperliquid.xyz/info",
        json!({"type":"clearinghouseState","user": address}),
        &[],
    )?;
    let account = body["marginSummary"]["accountValue"].as_str().unwrap_or("0");
    let usd: f64 = account.parse().unwrap_or(0.0);
    Ok(BalanceProof {
        balance_native: format!("{usd:.2} USDC"),
        balance_usd: usd,
        detail: "Read from the Hyperliquid info API.".into(),
    })
}

fn fetch_stripe(secret: &str, connection_type: &str) -> Result<BalanceProof> {
    if connection_type == "address_watch" || secret.trim().is_empty() {
        return Err(err("Stripe needs your secret key to read a balance. A typed amount is not a balance."));
    }
    let body = get_auth("https://api.stripe.com/v1/balance", &[("Authorization", format!("Bearer {}", secret.trim()))])?;
    let available = body["available"].as_array().cloned().unwrap_or_default();
    let mut cents = 0.0;
    for row in available {
        if row["currency"].as_str() == Some("usd") {
            cents += row["amount"].as_f64().unwrap_or(0.0);
        }
    }
    let usd = cents / 100.0;
    Ok(BalanceProof {
        balance_native: format!("${usd:.2}"),
        balance_usd: usd,
        detail: "Read from the Stripe balance API. No charge was created.".into(),
    })
}

fn fetch_razorpay(address: &str, secret: &str, connection_type: &str) -> Result<BalanceProof> {
    if connection_type == "address_watch" || secret.trim().is_empty() {
        return Err(err("Razorpay needs your key id and key secret. A typed amount is not a balance."));
    }
    let pair = if secret.contains(':') { secret.trim().to_string() } else { format!("{}:{}", address.trim(), secret.trim()) };
    let token = STANDARD.encode(pair.as_bytes());
    let body = get_auth("https://api.razorpay.com/v1/payments?count=1", &[("Authorization", format!("Basic {token}"))])?;
    if body.get("error").is_some() {
        return Err(err("Razorpay rejected that key. No balance was recorded."));
    }
    Ok(BalanceProof {
        balance_native: "key verified".into(),
        balance_usd: 0.0,
        detail: "Razorpay accepted the key. This endpoint does not publish a spendable balance, so the budget stays at $0 until a balance field is returned.".into(),
    })
}

fn usdc_contract(chain: &str) -> Option<&'static str> {
    match chain {
        "base" => Some("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
        "ethereum" => Some("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
        "arbitrum" => Some("0xaf88d065e77c8cC2239327C5EDb3A432268e5831"),
        "polygon" => Some("0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"),
        _ => None,
    }
}

fn rpc_result(rpc: &str, method: &str, params: Value) -> Result<String> {
    let body = post_json(rpc, json!({"jsonrpc":"2.0","id":1,"method": method, "params": params}), &[])?;
    if body.get("error").is_some() {
        return Err(err(format!("The {method} call was rejected. No balance was recorded.")));
    }
    body["result"].as_str().map(|value| value.to_string()).ok_or_else(|| err("The chain did not return a balance."))
}

fn post_json(url: &str, body: Value, headers: &[(&str, String)]) -> Result<Value> {
    let client = http_client()?;
    let mut request = client.post(url).json(&body);
    for (name, value) in headers {
        request = request.header(*name, value);
    }
    read_json(request)
}

fn get_auth(url: &str, headers: &[(&str, String)]) -> Result<Value> {
    let client = http_client()?;
    let mut request = client.get(url);
    for (name, value) in headers {
        request = request.header(*name, value);
    }
    read_json(request)
}

fn read_json(request: reqwest::blocking::RequestBuilder) -> Result<Value> {
    let response = request.send().map_err(|_| err("The provider could not be reached. No balance was recorded."))?;
    let status = response.status();
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err(err("The provider rejected that credential. No balance was recorded."));
    }
    if !status.is_success() {
        return Err(err(format!("The provider returned {}. No balance was recorded.", status.as_u16())));
    }
    let text = response.text().map_err(|_| err("The provider answer could not be read."))?;
    serde_json::from_str(&text).map_err(|_| err("The provider answer was not JSON. No balance was recorded."))
}

fn http_client() -> Result<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|_| err("The balance client could not start."))
}

fn spot_price(pair: &str) -> Option<f64> {
    let url = format!("https://api.coinbase.com/v2/prices/{pair}/spot");
    let body = get_auth(&url, &[]).ok()?;
    body["data"]["amount"].as_str()?.parse().ok()
}

fn hex_to_units(hex: &str, decimals: u32) -> Result<f64> {
    let digits = hex.trim().trim_start_matches("0x");
    if digits.is_empty() || digits.chars().all(|ch| ch == '0') {
        return Ok(0.0);
    }
    let value = u128::from_str_radix(digits, 16).map_err(|_| err("The chain returned a balance this build could not read."))?;
    let scale = 10f64.powi(decimals as i32);
    Ok(value as f64 / scale)
}

fn explorer_url(chain: &str, address: &str) -> String {
    match chain {
        "base" => format!("https://basescan.org/address/{address}"),
        "ethereum" => format!("https://etherscan.io/address/{address}"),
        "arbitrum" => format!("https://arbiscan.io/address/{address}"),
        "polygon" => format!("https://polygonscan.com/address/{address}"),
        "solana" => format!("https://solscan.io/account/{address}"),
        "hyperliquid" => format!("https://app.hyperliquid.xyz/explorer/address/{address}"),
        "stripe" => "https://dashboard.stripe.com/balance".into(),
        "razorpay" => "https://dashboard.razorpay.com/".into(),
        _ => String::new(),
    }
}

fn is_evm(address: &str) -> bool {
    address.len() == 42 && address.starts_with("0x") && address[2..].chars().all(|ch| ch.is_ascii_hexdigit())
}

fn is_solana(address: &str) -> bool {
    (32..=44).contains(&address.len())
        && address.chars().all(|ch| "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz".contains(ch))
}

fn hash_pin(pin: &str) -> Result<String> {
    let mut salt = [0u8; 16];
    getrandom::getrandom(&mut salt).map_err(|error| err(error.to_string()))?;
    let params = Params::new(19_456, 2, 1, Some(32)).map_err(|error| err(error.to_string()))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut out = [0u8; 32];
    argon.hash_password_into(pin.as_bytes(), &salt, &mut out).map_err(|error| err(error.to_string()))?;
    Ok(format!("{}:{}", STANDARD.encode(salt), STANDARD.encode(out)))
}

fn pin_matches(pin: &str, stored: &str) -> bool {
    let Some((salt_b64, hash_b64)) = stored.split_once(':') else { return false };
    let Ok(salt) = STANDARD.decode(salt_b64) else { return false };
    let Ok(expect) = STANDARD.decode(hash_b64) else { return false };
    let Ok(params) = Params::new(19_456, 2, 1, Some(32)) else { return false };
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut out = [0u8; 32];
    if argon.hash_password_into(pin.as_bytes(), &salt, &mut out).is_err() {
        return false;
    }
    out.as_slice() == expect.as_slice()
}
