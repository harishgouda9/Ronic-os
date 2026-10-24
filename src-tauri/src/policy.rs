#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    AutoSigned,
    Pending,
    Rejected,
    Kill,
}

impl Decision {
    pub fn as_str(self) -> &'static str {
        match self {
            Decision::AutoSigned => "auto_signed_by_rust",
            Decision::Pending => "pending_approval",
            Decision::Rejected => "rejected_by_policy",
            Decision::Kill => "blocked_killswitch",
        }
    }
}

#[derive(Debug, Clone)]
pub struct PolicyInput {
    pub max_per_tx_usd: f64,
    pub daily_cap_usd: f64,
    pub require_human_approval_above_usd: f64,
    pub max_slippage_bps: i64,
    pub killswitch_engaged: bool,
}

/// Deterministic guardrail. The model never bypasses this.
/// User-initiated top-ups are bookkeeping, not agent spend, and skip the caps.
/// The kill switch still blocks agent and trade actions.
pub fn evaluate(
    policy: &PolicyInput,
    amount_usd: f64,
    spent_today_usd: f64,
    slippage_bps: Option<i64>,
    actor: &str,
    kind: &str,
) -> Decision {
    let agent = actor != "user";
    let trade = kind == "trade" || kind == "order";
    if policy.killswitch_engaged && (agent || trade) {
        return Decision::Kill;
    }
    if !amount_usd.is_finite() || amount_usd <= 0.0 {
        return Decision::Rejected;
    }
    if !agent {
        return Decision::AutoSigned;
    }
    if spent_today_usd + amount_usd > policy.daily_cap_usd + 1e-9 {
        return Decision::Rejected;
    }
    if let Some(slip) = slippage_bps {
        if slip > policy.max_slippage_bps {
            return Decision::Rejected;
        }
    }
    // Over the autonomous ceiling, or over the review threshold: pause for a person.
    // Daily cap, slippage, and the kill switch stay hard rejects.
    if amount_usd > policy.max_per_tx_usd + 1e-9
        || amount_usd > policy.require_human_approval_above_usd + 1e-9
    {
        return Decision::Pending;
    }
    Decision::AutoSigned
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy() -> PolicyInput {
        PolicyInput {
            max_per_tx_usd: 5.0,
            daily_cap_usd: 50.0,
            require_human_approval_above_usd: 10.0,
            max_slippage_bps: 35,
            killswitch_engaged: false,
        }
    }

    #[test]
    fn auto_signs_small_agent_spend() {
        let d = evaluate(&policy(), 0.005, 0.0, Some(10), "agent", "x402");
        assert_eq!(d, Decision::AutoSigned);
    }

    #[test]
    fn pauses_over_autonomous_max() {
        let d = evaluate(&policy(), 6.0, 0.0, None, "agent", "x402");
        assert_eq!(d, Decision::Pending);
    }

    #[test]
    fn rejects_over_daily_cap() {
        let d = evaluate(&policy(), 4.0, 47.0, None, "agent", "x402");
        assert_eq!(d, Decision::Rejected);
    }

    #[test]
    fn pending_over_review_threshold() {
        let mut p = policy();
        p.max_per_tx_usd = 25.0;
        let d = evaluate(&p, 12.0, 0.0, None, "agent", "x402");
        assert_eq!(d, Decision::Pending);
    }

    #[test]
    fn rejects_slippage() {
        let d = evaluate(&policy(), 1.0, 0.0, Some(80), "agent", "trade");
        assert_eq!(d, Decision::Rejected);
    }

    #[test]
    fn killswitch_blocks_agents_not_user_topup() {
        let mut p = policy();
        p.killswitch_engaged = true;
        assert_eq!(evaluate(&p, 1.0, 0.0, None, "agent", "x402"), Decision::Kill);
        assert_eq!(evaluate(&p, 20.0, 0.0, None, "user", "topup"), Decision::AutoSigned);
    }

    #[test]
    fn rejects_non_positive() {
        assert_eq!(evaluate(&policy(), 0.0, 0.0, None, "agent", "x402"), Decision::Rejected);
        assert_eq!(evaluate(&policy(), -2.0, 0.0, None, "user", "topup"), Decision::Rejected);
    }
}
