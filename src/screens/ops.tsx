import { useEffect, useState } from "react";
import type { Settings } from "../types";
import { useOmni } from "../store";
import { cloudConfig, startProductCheckout } from "../services/cloud";
import { money, Pill, tone, when } from "../ui/bits";

export function Wallet() {
  const snap = useOmni((s) => s.snap)!;
  const run = useOmni((s) => s.run);
  const busy = useOmni((s) => s.busy);
  const policy = snap.policy;
  const [amount, setAmount] = useState("");
  const [rail, setRail] = useState("crypto_x402");
  const [effect, setEffect] = useState("spend");
  const [purpose, setPurpose] = useState("");
  const [slippage, setSlippage] = useState(String(policy.maxSlippageBps));
  const pending = snap.transactions.filter((tx) => tx.policyDecision === "pending_approval");

  // The policy can change on other screens (or from a bot's wallet review);
  // keep the field in view so a submit never sends a stale bps.
  useEffect(() => {
    setSlippage(String(policy.maxSlippageBps));
  }, [policy.maxSlippageBps]);

  function savePolicy(next: Partial<typeof policy>) {
    const merged = { ...policy, ...next };
    void run("set_policy", {
      maxPerTxUsd: merged.maxPerTxUsd,
      dailyCapUsd: merged.dailyCapUsd,
      requireHumanApprovalAboveUsd: merged.requireHumanApprovalAboveUsd,
      maxSlippageBps: Math.round(merged.maxSlippageBps),
      killswitchEngaged: merged.killswitchEngaged,
    });
  }

  return (
    <div className="screen">
      <div className="between">
        <div>
          <h1 className="title">Wallet & trading</h1>
          <p className="muted">Balances are a local sandbox ledger. Policy checks run here. Live Stripe, Razorpay, x402, and exchange signing stay off.</p>
        </div>
        <Pill kind={snap.sandbox ? "warn" : "bad"}>{snap.sandbox ? "SANDBOX" : "LIVE RAILS BLOCKED"}</Pill>
      </div>
      <div className="grid-4">
        {snap.balances.map((row) => (
          <article key={row.rail} className="card">
            <div className="muted">{row.label}</div>
            <div className="kpi">{row.nativeAmount}</div>
            <div className="faint">{row.detail} · book {money(row.amountUsd)}</div>
          </article>
        ))}
        <article className="card">
          <div className="muted">Spent today by agents</div>
          <div className="kpi">{money(snap.spentTodayUsd)}</div>
          <div className="faint">Daily cap {money(policy.dailyCapUsd)}</div>
        </article>
      </div>
      <div className="grid-2">
        <section className="card stack">
          <div className="between">
            <h2 className="h2">Policy gate</h2>
            <button className={policy.killswitchEngaged ? "btn danger" : "btn ghost"} onClick={() => savePolicy({ killswitchEngaged: !policy.killswitchEngaged })}>
              {policy.killswitchEngaged ? "Kill switch on" : "Kill switch off"}
            </button>
          </div>
          <NumberField label="Max per transaction USD" value={policy.maxPerTxUsd} onCommit={(maxPerTxUsd) => savePolicy({ maxPerTxUsd })} />
          <NumberField label="Daily cap USD" value={policy.dailyCapUsd} onCommit={(dailyCapUsd) => savePolicy({ dailyCapUsd })} />
          <NumberField label="Human approval above USD" value={policy.requireHumanApprovalAboveUsd} onCommit={(requireHumanApprovalAboveUsd) => savePolicy({ requireHumanApprovalAboveUsd })} />
          <NumberField label="Max slippage bps" value={policy.maxSlippageBps} onCommit={(maxSlippageBps) => savePolicy({ maxSlippageBps })} />
          <p className="faint">Over the per-transaction max, or over the approval line, waits for you. Over the daily cap, a bot daily wallet limit, or slippage cap is rejected. The kill switch blocks agents and still allows a user top-up. Submit on this screen is a user action. Agent spends come from chat.</p>
        </section>
        <section className="card stack">
          <h2 className="h2">Sandbox movement</h2>
          <div className="grid-2">
            <label className="field"><span>Effect</span>
              <select className="select" value={effect} onChange={(event) => setEffect(event.target.value)}>
                <option value="spend">Spend</option>
                <option value="credit">Top up</option>
              </select>
            </label>
            <label className="field"><span>Rail</span>
              <select className="select" value={rail} onChange={(event) => setRail(event.target.value)}>
                <option value="crypto_x402">Crypto & x402</option>
                <option value="razorpay_upi">Razorpay UPI</option>
                <option value="stripe_card">Stripe card</option>
              </select>
            </label>
            <label className="field"><span>Amount USD</span><input className="input" inputMode="decimal" placeholder="0.00" value={amount} onChange={(event) => setAmount(event.target.value)} /></label>
            <label className="field"><span>Slippage bps</span><input className="input" value={slippage} onChange={(event) => setSlippage(event.target.value)} /></label>
            <label className="field"><span>Purpose</span><input className="input" placeholder="What this movement is for" value={purpose} onChange={(event) => setPurpose(event.target.value)} /></label>
          </div>
          <button
            className="btn"
            disabled={busy || !(Number(amount) > 0) || purpose.trim().length === 0}
            onClick={() => {
              const amountUsd = Number(amount);
              if (!(amountUsd > 0) || purpose.trim().length === 0) return;
              void run("wallet_tx", {
                request: {
                  botProfileId: snap.activeProfileId,
                  rail,
                  amountUsd,
                  nativeAmount: rail === "razorpay_upi" ? `₹${Math.round(amountUsd * 83)}` : `$${amountUsd}`,
                  counterparty: "sandbox",
                  purpose,
                  actor: "user",
                  kind: effect === "credit" ? "topup" : "payment",
                  effect,
                  slippageBps: Number(slippage),
                },
              });
            }}
          >
            Submit to policy
          </button>
          {snap.settings.liveRails ? <p className="muted">Live rails are on. This build will refuse the charge and ask you to turn them off.</p> : null}
        </section>
      </div>
      {pending.length > 0 ? (
        <section className="card stack">
          <h2 className="h2">Waiting for you</h2>
          {pending.map((tx) => (
            <div key={tx.id} className="between">
              <span>{tx.purpose} · {money(tx.amountUsd)} · {tx.botHandle}</span>
              <div className="row-actions">
                <button className="btn small" disabled={busy} onClick={() => void run("review_tx", { txId: tx.id, approve: true })}>Approve</button>
                <button className="btn ghost small" disabled={busy} onClick={() => void run("review_tx", { txId: tx.id, approve: false })}>Reject</button>
              </div>
            </div>
          ))}
        </section>
      ) : null}
      <div className="grid-2">
        <section className="pane">
          <div className="pane-h">Sandbox positions</div>
          <div className="pane-b stack">
            {snap.positions.length === 0 ? <p className="muted">No positions.</p> : null}
            {snap.positions.map((position) => (
              <div key={position.symbol} className="between">
                <div>
                  <strong>{position.symbol}</strong>
                  <div className="muted">{position.venue} · {position.side} · {position.open ? money(position.pnlUsd) : "closed"}</div>
                </div>
                <button className="btn ghost small" disabled={!position.open || busy} onClick={() => void run("close_position", { symbol: position.symbol })}>Mark closed</button>
              </div>
            ))}
            <p className="faint">Closing a row updates the ledger only. No exchange order is sent.</p>
          </div>
        </section>
        <section className="pane">
          <div className="pane-h">Ledger</div>
          <div className="pane-b">
            <table className="data">
              <thead><tr><th>When</th><th>Who</th><th>Amount</th><th>Decision</th></tr></thead>
              <tbody>
                {snap.transactions.length === 0 ? <tr><td colSpan={4}>No ledger entries.</td></tr> : null}
                {snap.transactions.slice(0, 12).map((tx) => (
                  <tr key={tx.id}>
                    <td>{when(tx.createdAt)}</td>
                    <td>{tx.botHandle}<div className="faint">{tx.purpose}</div></td>
                    <td className="mono">{tx.nativeAmount}</td>
                    <td><Pill kind={tone(tx.policyDecision)}>{tx.policyDecision}</Pill></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}

function NumberField({ label, value, onCommit }: { label: string; value: number; onCommit: (value: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <label className="field">
      <span>{label}</span>
      <input
        className="input"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => {
          const next = Number(text);
          if (text.trim() === "" || !Number.isFinite(next)) {
            setText(String(value));
            return;
          }
          onCommit(next);
        }}
      />
    </label>
  );
}

export function Extensions() {
  const snap = useOmni((s) => s.snap)!;
  const run = useOmni((s) => s.run);
  const busy = useOmni((s) => s.busy);
  const [selected, setSelected] = useState(snap.extensions[0]?.id ?? "");
  const [prompt, setPrompt] = useState("");
  const ext = snap.extensions.find((item) => item.id === selected) ?? snap.extensions[0];
  const [code, setCode] = useState(ext?.code ?? "");
  useEffect(() => setCode(ext?.code ?? ""), [ext?.id, ext?.code]);
  return (
    <div className="screen">
      <div>
        <h1 className="title">Self-modify</h1>
        <p className="muted">Generated files land in the local extensions folder. They are not executed as privileged code.</p>
      </div>
      <div className="split" style={{ gridTemplateColumns: "240px 1fr" }}>
        <section className="pane">
          <div className="pane-b" style={{ padding: 0 }}>
            {snap.extensions.length === 0 ? <p className="muted" style={{ padding: 12 }}>No extension files yet.</p> : null}
            {snap.extensions.map((item) => (
              <button key={item.id} className={`list-btn ${item.id === ext?.id ? "active" : ""}`} onClick={() => setSelected(item.id)}>
                <strong>{item.name}</strong>
                <span className="muted">{item.enabled ? "enabled" : "off"}</span>
              </button>
            ))}
          </div>
        </section>
        <section className="card stack">
          {ext ? (
            <>
              <div className="between">
                <span className="mono">{ext.path}</span>
                <button className="btn ghost small" onClick={() => void run("toggle_extension", { id: ext.id, enabled: !ext.enabled })}>{ext.enabled ? "Disable" : "Enable"}</button>
              </div>
              <textarea className="area" style={{ minHeight: 220 }} value={code} onChange={(event) => setCode(event.target.value)} />
              <button className="btn" disabled={busy} onClick={() => void run("save_extension", { id: ext.id, code })}>Save file</button>
            </>
          ) : <p className="muted">No extension files yet.</p>}
          <label className="field"><span>Generate from a prompt</span><input className="input" placeholder="Describe the local file to write" value={prompt} onChange={(event) => setPrompt(event.target.value)} /></label>
          <button className="btn ghost" disabled={busy || prompt.trim().length < 3} onClick={() => void run("generate_extension", { prompt })}>Write local patch</button>
        </section>
      </div>
    </div>
  );
}

export function Repair() {
  const snap = useOmni((s) => s.snap)!;
  const run = useOmni((s) => s.run);
  const recover = useOmni((s) => s.recover);
  const recovering = useOmni((s) => s.recovering);
  const busy = useOmni((s) => s.busy);
  return (
    <div className="screen">
      <div className="between">
        <div>
          <h1 className="title">Self-repair</h1>
          <p className="muted">Refresh releases a stuck reply and checkpoints SQLite. No messages are deleted. The doctor records the heartbeat and patches a local file only when that file contains a known crash. Heartbeat age {snap.heartbeatAgeMs} ms.</p>
        </div>
        <div className="row-actions">
          <button className="btn ghost" disabled={recovering} onClick={() => void recover()}>{recovering ? "Refreshing…" : "Refresh"}</button>
          <button className="btn" disabled={busy} onClick={() => void run("run_repair")}>Run doctor</button>
        </div>
      </div>
      <section className="pane">
        <div className="pane-b">
          <table className="data">
            <thead><tr><th>Tier</th><th>Fault</th><th>Target</th><th>Action</th><th>Status</th></tr></thead>
            <tbody>
              {snap.remediation.length === 0 ? <tr><td colSpan={5}>No repair log yet.</td></tr> : null}
              {snap.remediation.map((row) => (
                <tr key={row.id}>
                  <td>{row.tier}</td>
                  <td>{row.faultType}</td>
                  <td>{row.targetComponent}</td>
                  <td>{row.actionTaken}<div className="faint">{when(row.createdAt)} · {row.recoveryDurationMs} ms</div></td>
                  <td><Pill kind={row.status === "repaired" ? "ok" : "warn"}>{row.status}</Pill></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

export function Billing() {
  const snap = useOmni((s) => s.snap)!;
  const run = useOmni((s) => s.run);
  const settings = snap.settings;
  const license = snap.license;
  const [billingNote, setBillingNote] = useState("");
  function save(next: Settings) {
    void run("save_settings", { settings: next });
  }
  const walletUsd = (license?.walletMicroUsd ?? 0) / 1_000_000;
  return (
    <div className="screen">
      <div>
        <h1 className="title">Plan & act</h1>
        <p className="muted">{settings.plan} · installed {settings.version}. {settings.availableVersion === settings.version ? "No update is listed." : `Listed update ${settings.availableVersion}.`} This screen does not download a signed binary.</p>
      </div>
      <div className="grid-3">
        <article className="card">
          <div className="muted">Cloud plan</div>
          <div className="kpi">{license ? tierLabel(license.planTier, license.founderBadge) : "—"}</div>
          <p className="faint">{license ? licenseStatusLabel(license.status) : "Sign in from Settings to see the cloud license."}</p>
        </article>
        <article className="card"><div className="muted">Burst credits (local)</div><div className="kpi">{money(settings.burstCreditsUsd)}</div><p className="faint">Cloud wallet: {money(walletUsd)}</p></article>
        <article className="card"><div className="muted">Ghost runners</div><div>{settings.ghostRunners.join(", ") || "None"}</div></article>
      </div>

      <section className="card stack">
        <strong>Revenue streams</strong>
        <div className="grid-3">
          <article className="card">
            <strong>Ronic Pro</strong>
            <p className="muted">$14/mo or $120/yr · ₹999/mo UPI</p>
            <p className="faint">Unlimited 4-lane multiplexer, &lt;50ms failover, squads, auto Supercharge, 6 memory engines, 3 machines.</p>
            <div className="row-actions">
              <button type="button" className="btn small" disabled={!cloudConfig.checkoutApi} title={cloudConfig.checkoutApi ? undefined : "VITE_CHECKOUT_API is not set on this build."} onClick={() => void checkout("pro_monthly", "stripe")}>$14/mo card</button>
              <button type="button" className="btn ghost small" disabled={!cloudConfig.checkoutApi} onClick={() => void checkout("pro_monthly", "razorpay")}>₹999 UPI</button>
            </div>
          </article>
          <article className="card">
            <strong>Founder Pass</strong>
            <p className="muted">$149 once · ₹11,999 · 500 total</p>
            <p className="faint">Lifetime Pro, 3 machines, ★ badge. When the pool empties it is gone for good.</p>
            <div className="row-actions">
              <button type="button" className="btn small" disabled={license?.planTier === "founder_lifetime" || !cloudConfig.checkoutApi} onClick={() => void checkout("founder_pass", "stripe")}>
                {license?.planTier === "founder_lifetime" ? "★ Yours" : "Claim — $149"}
              </button>
              <button type="button" className="btn ghost small" disabled={license?.planTier === "founder_lifetime" || !cloudConfig.checkoutApi} onClick={() => void checkout("founder_pass", "razorpay")}>₹11,999</button>
            </div>
          </article>
          <article className="card">
            <strong>24/7 Ghost Runners</strong>
            <p className="muted">$19/mo per runner or $0.008/hr</p>
            <p className="faint">Cloud Firecracker microVMs keep bots and cron routines alive with the lid closed. Orchestrator deploys separately; billing tables are live.</p>
          </article>
        </div>
        {billingNote ? <p className="muted">{billingNote}</p> : null}
      </section>

      <section className="card stack">
        <label className="field">
          <span>Update channel</span>
          <select className="select" value={settings.updateChannel} onChange={(event) => save({ ...settings, updateChannel: event.target.value as Settings["updateChannel"] })}>
            <option value="stable">stable</option>
            <option value="nightly">nightly</option>
          </select>
        </label>
        <button type="button" className="toggle" onClick={() => save({ ...settings, liveRails: !settings.liveRails })}>
          <span>Live rails</span>
          <Pill kind={settings.liveRails ? "bad" : "ok"}>{settings.liveRails ? "on — charges refused" : "off — sandbox ledger"}</Pill>
        </button>
        <p className="faint">Turning live rails on does not connect a processor. Wallet actions then fail closed.</p>
      </section>
    </div>
  );

  async function checkout(product: "founder_pass" | "pro_monthly" | "pro_yearly", rail: "stripe" | "razorpay") {
    setBillingNote("Starting checkout…");
    const { error, checkout: started } = await startProductCheckout(product, rail);
    if (error || !started) {
      setBillingNote(error ?? "Checkout did not start.");
      return;
    }
    if (started.kind === "stripe") {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("open_system_url", { url: started.url });
        setBillingNote("Checkout opened in your browser. The plan lands on your account after payment.");
      } catch (error) {
        setBillingNote(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    setBillingNote(`Razorpay order ${started.orderId} created (₹${(started.amountPaise / 100).toFixed(0)}). Finish it from the Razorpay page with key ${started.keyId}.`);
  }
}

function tierLabel(tier: string, badge: number | null): string {
  if (tier === "founder_lifetime") return badge ? `Founder #${badge}` : "Founder Pass";
  if (tier === "pro") return "Ronic Pro";
  if (tier === "team") return "Team";
  return "Starter";
}

function licenseStatusLabel(status: string): string {
  if (status === "active") return "Ed25519 lease verified locally. Works offline for 7 days.";
  if (status === "unsigned_dev") return "Unsigned dev build — entitlements are shown, not enforced.";
  if (status === "expired") return "Lease expired. Sign in from Settings to refresh it.";
  if (status === "invalid") return "Lease failed the signature check. Sign in to refresh.";
  return "No cloud lease yet. Register this machine from Settings.";
}

