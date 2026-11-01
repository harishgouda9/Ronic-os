use crate::db;
use crate::error::{err, Result};
use crate::policy::{self, Decision, PolicyInput};
use crate::util::{nid, now_ms};
use rusqlite::{params, Connection};

pub fn settle(
    conn: &Connection,
    bot_id: &str,
    rail: &str,
    amount_usd: f64,
    native_amount: &str,
    counterparty: &str,
    purpose: &str,
    actor: &str,
    kind: &str,
    slippage_bps: Option<i64>,
    effect: &str,
) -> Result<String> {
    settle_ext(conn, bot_id, rail, amount_usd, native_amount, counterparty, purpose, actor, kind, slippage_bps, effect, None)
}

/// Settlement core with an optional quant-order id. When an order id is
/// supplied, its row is transitioned with the settlement outcome in the same
/// transaction, so a held order leaves `WORKING` exactly when its wallet tx
/// is decided — never before, never silently.
pub fn settle_ext(
    conn: &Connection,
    bot_id: &str,
    rail: &str,
    amount_usd: f64,
    native_amount: &str,
    counterparty: &str,
    purpose: &str,
    actor: &str,
    kind: &str,
    slippage_bps: Option<i64>,
    effect: &str,
    order_id: Option<&str>,
) -> Result<String> {
    let tx = conn.unchecked_transaction()?;
    let policy_row = db::load_policy(&tx)?;
    let spent = db::spent_today(&tx)?;
    let mut decision = policy::evaluate(
        &PolicyInput {
            max_per_tx_usd: policy_row.max_per_tx_usd,
            daily_cap_usd: policy_row.daily_cap_usd,
            require_human_approval_above_usd: policy_row.require_human_approval_above_usd,
            max_slippage_bps: policy_row.max_slippage_bps,
            killswitch_engaged: policy_row.killswitch_engaged,
        },
        amount_usd,
        spent,
        slippage_bps,
        actor,
        kind,
    );
    let agent_spend = actor != "user" && effect != "credit";
    // The advertised ₹400 UPI auto-sign cap: agent spend on the UPI rail above
    // the cap is held for human review even when the USD approval line allows it.
    if agent_spend
        && rail == "razorpay_upi"
        && decision == Decision::AutoSigned
        && amount_usd * 83.0 > crate::wallet_engine::UPI_AUTO_SIGN_CAP_INR + 1e-9
    {
        decision = Decision::Pending;
    }
    if agent_spend && decision != Decision::Rejected && decision != Decision::Kill && crate::wallet_engine::is_bot_frozen(conn, bot_id)? {
        insert_tx(&tx, bot_id, rail, amount_usd, native_amount, counterparty, purpose, "rejected_circuit_breaker", actor, "", effect)?;
        if let Some(order_id) = order_id {
            tx.execute("UPDATE quant_orders SET status = 'REJECTED' WHERE id = ?1", params![order_id])?;
        }
        tx.commit()?;
        return Ok("rejected_circuit_breaker: this bot's wallet is frozen by the operator".into());
    }
    if agent_spend && decision != Decision::Rejected && decision != Decision::Kill {
        match bot_daily_limit(&tx, bot_id) {
            Ok(None) => {}
            Ok(Some(limit)) => {
                let bot_spent = db::spent_today_for_bot(&tx, bot_id)?;
                if bot_spent + amount_usd > limit + 1e-9 {
                    decision = Decision::Rejected;
                }
            }
            Err(_) => {
                insert_tx(&tx, bot_id, rail, amount_usd, native_amount, counterparty, purpose, Decision::Rejected.as_str(), actor, "", effect)?;
                if let Some(order_id) = order_id {
                    tx.execute("UPDATE quant_orders SET status = 'REJECTED' WHERE id = ?1", params![order_id])?;
                }
                tx.commit()?;
                return Ok("rejected_by_policy: unknown bot".into());
            }
        }
    }
    if decision == Decision::Rejected || decision == Decision::Kill {
        let label = decision.as_str();
        insert_tx(&tx, bot_id, rail, amount_usd, native_amount, counterparty, purpose, label, actor, "", effect)?;
        if let Some(order_id) = order_id {
            tx.execute("UPDATE quant_orders SET status = 'REJECTED' WHERE id = ?1", params![order_id])?;
        }
        tx.commit()?;
        return Ok(format!("{label}: no funds moved"));
    }
    if decision == Decision::Pending {
        let tx_id = nid("tx");
        insert_tx_with_id(&tx, &tx_id, bot_id, rail, amount_usd, native_amount, counterparty, purpose, decision.as_str(), actor, "", effect)?;
        if let Some(order_id) = order_id {
            // Record the exact wallet tx on the held order so review can flip
            // exactly this order — never a sibling's.
            tx.execute("UPDATE quant_orders SET wallet_tx_id = ?1, status = 'WORKING' WHERE id = ?2", params![tx_id, order_id])?;
        }
        tx.commit()?;
        return Ok("pending_approval: waiting for one-click review".into());
    }
    apply_effect(&tx, rail, amount_usd, effect)?;
    let reference = nid("sandbox");
    insert_tx(&tx, bot_id, rail, amount_usd, native_amount, counterparty, purpose, decision.as_str(), actor, &reference, effect)?;
    if let Some(order_id) = order_id {
        let mode = crate::wallet_engine::ledger_mode(&tx);
        let status = if mode == "live_signer" { "FILLED" } else { "SIMULATED" };
        tx.execute("UPDATE quant_orders SET status = ?1 WHERE id = ?2", params![status, order_id])?;
    }
    tx.commit()?;
    Ok(format!("auto_signed_by_rust · {reference}"))
}

pub fn review(conn: &Connection, tx_id: &str, approve: bool) -> Result<String> {
    let tx = conn.unchecked_transaction()?;
    let row: (String, f64, String, String, String) = tx
        .query_row(
            "SELECT policy_decision, amount_usd, rail, COALESCE(effect, 'spend'), COALESCE(bot_profile_id, '') FROM wallet_transactions WHERE id = ?1",
            params![tx_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .map_err(|_| err("transaction not found"))?;
    if row.0 != "pending_approval" {
        return Err(err("only a pending transaction can be reviewed"));
    }
    if !approve {
        let n = tx.execute(
            "UPDATE wallet_transactions SET policy_decision = 'rejected_by_user' WHERE id = ?1 AND policy_decision = 'pending_approval'",
            params![tx_id],
        )?;
        if n == 0 {
            return Err(err("only a pending transaction can be reviewed"));
        }
        tx.execute("UPDATE quant_orders SET status = 'REJECTED' WHERE wallet_tx_id = ?1", params![tx_id])?;
        tx.commit()?;
        return Ok("rejected_by_user".into());
    }
    let policy_row = db::load_policy(&tx)?;
    if policy_row.killswitch_engaged {
        return Err(err("kill switch is on"));
    }
    let effect = if row.3 == "credit" { "credit" } else { "spend" };
    // A frozen bot's already-pending transactions must die with the breaker:
    // approving one would execute agent spend the freeze was meant to stop.
    if effect == "spend" && !row.4.trim().is_empty() && crate::wallet_engine::is_bot_frozen(&tx, &row.4)? {
        return Err(err("this bot's wallet is frozen by the operator; unfreeze it before approving"));
    }
    if effect == "spend" {
        let spent = db::spent_today(&tx)?;
        if spent + row.1 > policy_row.daily_cap_usd + 1e-9 {
            return Err(err("this approval would exceed the daily cap"));
        }
        if !row.4.trim().is_empty() {
            match bot_daily_limit(&tx, &row.4) {
                Ok(None) => {}
                Ok(Some(limit)) => {
                    let bot_spent = db::spent_today_for_bot(&tx, &row.4)?;
                    if bot_spent + row.1 > limit + 1e-9 {
                        return Err(err("this approval would exceed the bot daily wallet limit"));
                    }
                }
                Err(_) => return Err(err("this approval would exceed the bot daily wallet limit")),
            }
        }
    }
    apply_effect(&tx, &row.2, row.1, effect)?;
    let reference = nid("sandbox");
    let n = tx.execute(
        "UPDATE wallet_transactions SET policy_decision = 'approved_by_user', tx_hash_or_ref = ?1 WHERE id = ?2 AND policy_decision = 'pending_approval'",
        params![reference, tx_id],
    )?;
    if n == 0 {
        return Err(err("only a pending transaction can be reviewed"));
    }
    let order_status = if crate::wallet_engine::ledger_mode(&tx) == "live_signer" { "FILLED" } else { "SIMULATED" };
    tx.execute("UPDATE quant_orders SET status = ?1 WHERE wallet_tx_id = ?2", params![order_status, tx_id])?;
    tx.commit()?;
    Ok(format!("approved_by_user · {reference}"))
}

fn bot_daily_limit(conn: &Connection, bot_id: &str) -> Result<Option<f64>> {
    let bot_id = bot_id.trim();
    if bot_id.is_empty() {
        return Ok(None);
    }
    let limit: f64 = conn
        .query_row("SELECT daily_wallet_limit_usd FROM bot_profiles WHERE id = ?1", params![bot_id], |r| r.get(0))
        .map_err(|_| err("unknown bot"))?;
    Ok(Some(limit))
}

fn apply_effect(conn: &Connection, rail: &str, amount_usd: f64, effect: &str) -> Result<()> {
    if effect == "credit" {
        if rail == "razorpay_upi" {
            let have: f64 = conn.query_row("SELECT native_value FROM wallet_balances WHERE rail = 'razorpay_upi'", [], |r| r.get(0))?;
            let next = have + amount_usd * 83.0;
            conn.execute(
                "UPDATE wallet_balances SET native_value = ?1, amount_usd = ?2, native_amount = ?3 WHERE rail = 'razorpay_upi'",
                params![next, next / 83.0, format!("₹{next:.0}")],
            )?;
        } else if rail != "burst" {
            let have: f64 = conn.query_row("SELECT native_value FROM wallet_balances WHERE rail = ?1", params![rail], |r| r.get(0))?;
            let next = have + amount_usd;
            let label = if rail == "stripe_card" { format!("${next:.2}") } else { format!("{next:.2} USDC") };
            conn.execute(
                "UPDATE wallet_balances SET native_value = ?1, amount_usd = ?1, native_amount = ?2 WHERE rail = ?3",
                params![next, label, rail],
            )?;
        }
        return Ok(());
    }
    if effect != "spend" {
        return Err(err("Unknown ledger effect."));
    }
    if rail == "razorpay_upi" {
        let have: f64 = conn.query_row("SELECT native_value FROM wallet_balances WHERE rail = ?1", params![rail], |r| r.get(0))?;
        let cost = amount_usd * 83.0;
        if have + 1e-6 < cost {
            return Err(err("sandbox INR balance is too low"));
        }
        let next = have - cost;
        conn.execute(
            "UPDATE wallet_balances SET native_value = ?1, amount_usd = ?2, native_amount = ?3 WHERE rail = ?4",
            params![next, next / 83.0, format!("₹{next:.0}"), rail],
        )?;
        return Ok(());
    }
    if rail == "crypto_x402" || rail == "stripe_card" || rail == "hyperliquid_ws" {
        let have: f64 = conn.query_row("SELECT native_value FROM wallet_balances WHERE rail = ?1", params![rail], |r| r.get(0))?;
        if have + 1e-9 < amount_usd {
            return Err(err(match rail {
                "stripe_card" => "sandbox card balance is too low",
                "hyperliquid_ws" => "sandbox Hyperliquid margin is too low",
                _ => "sandbox USDC balance is too low",
            }));
        }
        let next = have - amount_usd;
        let label = if rail == "stripe_card" { format!("${next:.2}") } else { format!("{next:.2} USDC") };
        conn.execute(
            "UPDATE wallet_balances SET native_value = ?1, amount_usd = ?1, native_amount = ?2 WHERE rail = ?3",
            params![next, label, rail],
        )?;
        return Ok(());
    }
    Err(err("That rail cannot move funds on this ledger."))
}

fn insert_tx(
    conn: &Connection,
    bot_id: &str,
    rail: &str,
    amount_usd: f64,
    native_amount: &str,
    counterparty: &str,
    purpose: &str,
    decision: &str,
    actor: &str,
    reference: &str,
    effect: &str,
) -> Result<()> {
    let tx_id = nid("tx");
    insert_tx_with_id(conn, &tx_id, bot_id, rail, amount_usd, native_amount, counterparty, purpose, decision, actor, reference, effect)
}

fn insert_tx_with_id(
    conn: &Connection,
    tx_id: &str,
    bot_id: &str,
    rail: &str,
    amount_usd: f64,
    native_amount: &str,
    counterparty: &str,
    purpose: &str,
    decision: &str,
    actor: &str,
    reference: &str,
    effect: &str,
) -> Result<()> {
    let handle: String = conn
        .query_row("SELECT handle FROM bot_profiles WHERE id = ?1", params![bot_id], |r| r.get(0))
        .unwrap_or_else(|_| "you".into());
    let stored = if effect == "credit" { "credit" } else { "spend" };
    conn.execute(
        "INSERT INTO wallet_transactions (id, bot_profile_id, bot_handle, rail, amount_usd, native_amount, counterparty, purpose, policy_decision, tx_hash_or_ref, actor, effect, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
        params![tx_id, bot_id, handle, rail, amount_usd, native_amount, counterparty, purpose, decision, reference, actor, stored, now_ms()],
    )?;
    Ok(())
}

pub fn set_policy(conn: &Connection, max_tx: f64, daily: f64, approval: f64, slippage: i64, kill: bool) -> Result<()> {
    if max_tx < 0.0 || daily < 0.0 || approval < 0.0 || slippage < 0 {
        return Err(err("policy numbers cannot be negative"));
    }
    conn.execute(
        "UPDATE wallet_policies SET max_per_tx_usd=?1, daily_cap_usd=?2, require_human_approval_above_usd=?3, max_slippage_bps=?4, killswitch_engaged=?5 WHERE id=1",
        params![max_tx, daily, approval, slippage, if kill { 1 } else { 0 }],
    )?;
    Ok(())
}

