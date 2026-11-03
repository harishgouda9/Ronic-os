//! Agentic wallet engine: multi-rail balances, per-bot circuit breakers,
//! sandbox funding, and the two-layer quant execution pipeline (LLM signal →
//! Rust policy-signed order) on top of the settlement core in `wallet`.
//!
//! The ledger mode is `sandbox` (virtual funds, zero risk) or `live_signer`
//! (the same <1ms Rust policy signer signs every movement, but external
//! network rails stay physically locked in this build — fail-closed).

use crate::db;
use crate::error::{err, Result};
use crate::models::{BotAllowance, QuantOrder};
use crate::util::{nid, now_ms};
use rusqlite::{params, Connection};

pub const BUILDER_REBATE_BPS: i64 = 5;
pub const UPI_AUTO_SIGN_CAP_INR: f64 = 400.0;
const LEDGER_MODE_KEY: &str = "ledger_mode";

/// Rails each well-known bot may spend on, by handle prefix.
fn rails_for(handle: &str) -> &'static str {
    let handle = handle.trim();
    if handle.contains("Quant") {
        "Hyperliquid WS + x402 USDC"
    } else if handle.contains("Grokbot") {
        "x402 USDC only"
    } else if handle.contains("Dots") {
        "Razorpay UPI (₹) + Stripe Virtual Card"
    } else {
        "x402 USDC + group pool"
    }
}

pub fn ledger_mode(conn: &Connection) -> String {
    let mode = db::kv_get(conn, LEDGER_MODE_KEY)
        .ok()
        .flatten()
        .unwrap_or_default();
    if mode == "live_signer" { "live_signer".into() } else { "sandbox".into() }
}

pub fn set_ledger_mode(conn: &Connection, mode: &str) -> Result<String> {
    let mode = match mode.trim() {
        "sandbox" => "sandbox",
        "live_signer" => "live_signer",
        _ => return Err(err("ledger mode must be sandbox or live_signer")),
    };
    db::kv_set(conn, LEDGER_MODE_KEY, mode)?;
    if mode == "live_signer" {
        Ok("LIVE-SIGNER armed. The <1ms Rust policy signer signs every movement; external network rails stay locked in this build.".into())
    } else {
        Ok("Switched to the SANDBOX simulation ledger. Test bot payments with $0 risk.".into())
    }
}

/// Credit virtual sandbox funds across the three spendable rails.
/// The user command refuses this path. Kernel tests still call it directly.
#[cfg_attr(not(test), allow(dead_code))]
pub fn add_sandbox_funds(conn: &Connection) -> Result<String> {
    const MAX_TOPUPS_PER_DAY: i64 = 3;
    let day_start = {
        let now = now_ms();
        now - (now % 86_400_000)
    };
    // Each call settles one credit row per rail; count the x402 row only so
    // `today` reflects top-up events, not rows (3 rows per event).
    let today: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM wallet_transactions WHERE rail = 'crypto_x402' AND counterparty = 'sandbox-faucet' AND effect = 'credit' AND created_at >= ?1",
            params![day_start],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if today >= MAX_TOPUPS_PER_DAY {
        return Err(err(format!(
            "Sandbox faucet is capped at {MAX_TOPUPS_PER_DAY} top-ups per day. Try again tomorrow."
        )));
    }
    let usdc = 250.0;
    let inr = 10_000.0;
    let margin = 500.0;
    crate::wallet::settle(
        conn,
        "",
        "crypto_x402",
        usdc,
        &format!("{usdc:.2} USDC"),
        "sandbox-faucet",
        "Sandbox test funds (x402 machine rail)",
        "user",
        "topup",
        None,
        "credit",
    )?;
    crate::wallet::settle(
        conn,
        "",
        "razorpay_upi",
        inr / 83.0,
        &format!("₹{inr:.0}"),
        "sandbox-faucet",
        "Sandbox test funds (UPI rail)",
        "user",
        "topup",
        None,
        "credit",
    )?;
    crate::wallet::settle(
        conn,
        "",
        "hyperliquid_ws",
        margin,
        &format!("{margin:.2} USDC"),
        "sandbox-faucet",
        "Sandbox test funds (Hyperliquid margin)",
        "user",
        "topup",
        None,
        "credit",
    )?;
    Ok(format!(
        "Credited +{usdc:.0} USDC (x402), +₹{inr:.0} (UPI), +{margin:.0} USDC (Hyperliquid margin) to the sandbox ledger."
    ))
}

/// Circuit-breaker state for a bot. Empty or unknown bot ids read as not
/// frozen — unknown bots are rejected later by the daily-limit check, which
/// keeps the historical "rejected_by_policy: unknown bot" ledger entry.
pub fn is_bot_frozen(conn: &Connection, bot_id: &str) -> Result<bool> {
    let bot_id = bot_id.trim();
    if bot_id.is_empty() {
        return Ok(false);
    }
    let frozen: i64 = conn
        .query_row(
            "SELECT wallet_frozen FROM bot_profiles WHERE id = ?1",
            params![bot_id],
            |r| r.get(0),
        )
        .unwrap_or(0);
    Ok(frozen != 0)
}

/// Flip a bot's wallet circuit breaker. Returns the new frozen state.
pub fn toggle_circuit(conn: &Connection, bot_id: &str) -> Result<(bool, String)> {
    let frozen = !is_bot_frozen(conn, bot_id)?;
    let n = conn.execute(
        "UPDATE bot_profiles SET wallet_frozen = ?1 WHERE id = ?2",
        params![if frozen { 1 } else { 0 }, bot_id.trim()],
    )?;
    if n == 0 {
        return Err(err("unknown bot"));
    }
    let handle: String = conn
        .query_row(
            "SELECT handle FROM bot_profiles WHERE id = ?1",
            params![bot_id.trim()],
            |r| r.get(0),
        )
        .unwrap_or_else(|_| bot_id.to_string());
    if frozen {
        db::log_repair(
            conn,
            1,
            "circuit_breaker",
            &handle,
            "Operator froze this bot's wallet. All agent spend is rejected until unfrozen.",
            1,
            "repaired",
        )?;
        Ok((frozen, format!("{handle} wallet FROZEN. Every agent spend is rejected at the policy gate.")))
    } else {
        db::log_repair(
            conn,
            1,
            "circuit_breaker",
            &handle,
            "Operator re-armed this bot's wallet circuit breaker.",
            1,
            "repaired",
        )?;
        Ok((frozen, format!("{handle} wallet re-armed. Auto-sign caps and daily allowances apply again.")))
    }
}

/// Per-bot daily spend allowances with live spent-today and breaker state.
pub fn bot_allowances(conn: &Connection) -> Result<Vec<BotAllowance>> {
    let policy = db::load_policy(conn)?;
    let mut stmt = conn.prepare(
        "SELECT id, handle, COALESCE(role, ''), daily_wallet_limit_usd, COALESCE(wallet_frozen, 0)
         FROM bot_profiles ORDER BY is_pinned DESC, handle",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, f64>(3)?,
            r.get::<_, i64>(4)?,
        ))
    })?;
    // One grouped query for every bot's 24h agent spend instead of one query
    // per bot (N+1 on every snapshot poll).
    let mut spent_by_bot: std::collections::HashMap<String, f64> = std::collections::HashMap::new();
    {
        let mut spend_stmt = conn.prepare(
            "SELECT bot_profile_id, COALESCE(SUM(amount_usd), 0) FROM wallet_transactions
             WHERE actor = 'agent' AND effect = 'spend'
               AND policy_decision IN ('auto_signed_by_rust', 'approved_by_user')
               AND created_at >= ?1
             GROUP BY bot_profile_id",
        )?;
        let spend_rows = spend_stmt.query_map(params![now_ms() - 86_400_000], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?))
        })?;
        for row in spend_rows {
            let (bot_id, spent) = row?;
            spent_by_bot.insert(bot_id, spent);
        }
    }
    let mut out = Vec::new();
    for row in rows {
        let (bot_id, handle, role, limit, frozen) = row?;
        let spent = spent_by_bot.get(&bot_id).copied().unwrap_or(0.0);
        out.push(BotAllowance {
            rails_allowed: rails_for(&handle).into(),
            bot_id,
            handle,
            role,
            per_tx_cap: format!(
                "${:.2} / ₹{:.0}",
                policy.require_human_approval_above_usd, UPI_AUTO_SIGN_CAP_INR
            ),
            spent_today_usd: spent,
            daily_limit_usd: limit,
            frozen: frozen != 0,
        });
    }
    Ok(out)
}

/// Two-layer quant pipeline: an LLM analyst composes the signal, this engine
/// routes the order over the Hyperliquid WebSocket rail through the compiled
/// Rust policy signer (hard stop-loss / drawdown caps live in the policy gate).
/// The 5 bps Ronic builder rebate is accrued on every routed notional.
pub fn dispatch_quant_order(
    conn: &Connection,
    bot_id: &str,
    pair: &str,
    analyst: &str,
    thesis: &str,
    side: &str,
    size_usd: f64,
) -> Result<QuantOrder> {
    let pair = pair.trim();
    if pair.is_empty() {
        return Err(err("pair is required"));
    }
    if !(size_usd.is_finite() && size_usd > 0.0) {
        return Err(err("order size must be a positive number"));
    }
    let side = match side.trim().to_uppercase().as_str() {
        "LONG" | "SHORT" | "ARB_SPREAD" => side.trim().to_uppercase(),
        _ => return Err(err("side must be LONG, SHORT, or ARB_SPREAD")),
    };
    let analyst = if analyst.trim().is_empty() { "Grok Pro + Rust WS Engine" } else { analyst.trim() };
    let mode = ledger_mode(conn);
    let handle: String = conn
        .query_row(
            "SELECT handle FROM bot_profiles WHERE id = ?1",
            params![bot_id.trim()],
            |r| r.get(0),
        )
        .unwrap_or_else(|_| "you".into());

    // Create the order row first (WORKING placeholder), then settle with the
    // order id so the settlement transaction transitions it atomically with
    // the wallet decision — auto-sign, hold, or reject.
    let order_id = nid("ord");
    conn.execute(
        "INSERT INTO quant_orders (id, created_at, pair, analyst, thesis, side, size_usd, ws_latency_ms, rebate_usd, status, mode, bot_handle, reference, wallet_tx_id)
         VALUES (?1,?2,?3,?4,?5,?6,?7,0,0,'WORKING',?8,?9,'',NULL)",
        params![order_id, now_ms(), pair, analyst, thesis, side, size_usd, mode, handle],
    )?;

    let started = std::time::Instant::now();
    let outcome = match crate::wallet::settle_ext(
        conn,
        bot_id,
        "hyperliquid_ws",
        size_usd,
        &format!("${size_usd:.2} USDC ({side})"),
        pair,
        thesis,
        "agent",
        "trade",
        None,
        "spend",
        Some(&order_id),
    ) {
        Ok(outcome) => outcome,
        Err(error) => {
            let _ = conn.execute("UPDATE quant_orders SET status = 'REJECTED' WHERE id = ?1", params![order_id]);
            return Err(error);
        }
    };
    let ws_latency_ms = started.elapsed().as_secs_f64() * 1000.0;
    let rebate_usd = size_usd * BUILDER_REBATE_BPS as f64 / 10_000.0;

    conn.execute(
        "UPDATE quant_orders SET ws_latency_ms = ?1, rebate_usd = ?2, reference = ?3 WHERE id = ?4",
        params![ws_latency_ms, rebate_usd, outcome, order_id],
    )?;

    // Refresh the row settle just transitioned and report its final state.
    let fallback_reference = outcome.clone();
    let (status, reference): (String, String) = conn
        .query_row(
            "SELECT status, reference FROM quant_orders WHERE id = ?1",
            params![order_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap_or_else(|_| ("REJECTED".into(), fallback_reference));

    let order = QuantOrder {
        id: order_id,
        created_at: now_ms(),
        pair: pair.into(),
        analyst: analyst.into(),
        thesis: thesis.into(),
        side,
        size_usd,
        ws_latency_ms,
        rebate_usd,
        status,
        mode,
        bot_handle: handle,
        reference,
    };
    Ok(order)
}
