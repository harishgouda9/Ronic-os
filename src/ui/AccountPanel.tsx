import { useEffect, useState, useSyncExternalStore } from "react";
import { useRonic } from "../store";
import {
  cloudConfig,
  cloudSession,
  listDevices,
  refreshLicense,
  registerThisDevice,
  revokeDevice,
  saveDisplayName,
  signIn,
  signInWithBrowser,
  signOut,
  signUp,
  startProductCheckout,
  subscribeCloud,
  type DeviceRow,
} from "../services/cloud";
import { invoke as tauriInvokeRaw } from "@tauri-apps/api/core";

async function openCheckout(product: "founder_pass" | "pro_monthly" | "pro_yearly", rail: "stripe" | "razorpay", setNote: (s: string) => void) {
  const { error, checkout } = await startProductCheckout(product, rail);
  if (error || !checkout) {
    setNote(error ?? "Checkout did not start.");
    return;
  }
  if (checkout.kind === "stripe") {
    try {
      await tauriInvokeRaw("open_system_url", { url: checkout.url });
      setNote("Checkout opened in your browser. The pass lands on your account after payment.");
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    }
    return;
  }
  // Razorpay INR/UPI: the order is live; the payment page opens from the
  // India billing screen (Plan & act) which loads the Razorpay checkout.
  setNote(`Razorpay order ${checkout.orderId} created for ₹${(checkout.amountPaise / 100).toFixed(0)}. Finish it from Plan & act.`);
}

function money(micro: number): string {
  return (micro / 1_000_000).toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function tierLabel(tier: string, badge: number | null): string {
  if (tier === "founder_lifetime") return badge ? `Founder Pass #${badge}` : "Founder Pass";
  if (tier === "pro") return "Ronic Pro";
  if (tier === "team") return "Team";
  return "Ronic Starter";
}

export function AccountPanel() {
  const session = useSyncExternalStore(subscribeCloud, cloudSession, () => null);
  const snap = useRonic((s) => s.snap);
  const run = useRonic((s) => s.run);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [devices, setDevices] = useState<DeviceRow[] | null>(null);
  const license = snap?.license;

  useEffect(() => {
    if (!session) {
      setDevices(null);
      return;
    }
    let alive = true;
    void listDevices().then((rows) => {
      if (alive) setDevices(rows);
    });
    return () => {
      alive = false;
    };
  }, [session]);

  if (!cloudConfig.supabase) {
    return (
      <section className="card stack">
        <strong>Ronic account</strong>
        <p className="muted">Sign-in, the profile, and the paid store use Supabase. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY, then restart. Sentry and PostHog stay off until their keys are set. Keys on this machine stay in the local vault.</p>
      </section>
    );
  }

  if (!session) {
    return (
      <form
        className="card stack"
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          void signIn(email, password).then((message) => {
            setNote(message || "Signed in.");
            setBusy(false);
          }).catch((error) => {
            setNote(error instanceof Error ? error.message : String(error));
            setBusy(false);
          });
        }}
      >
        <strong>Sign in</strong>
        <p className="muted">This account is for Ronic OS services. It does not replace a provider API key.</p>
        <div className="row-actions">
          <button type="button" className="btn" disabled={busy} onClick={() => {
            setBusy(true);
            void signInWithBrowser("github").then((message) => {
              setNote(message || "Signed in with GitHub.");
              setBusy(false);
            }).catch((error) => {
              setNote(error instanceof Error ? error.message : String(error));
              setBusy(false);
            });
          }}>Continue with GitHub</button>
          <button type="button" className="btn ghost" disabled={busy} onClick={() => {
            setBusy(true);
            void signInWithBrowser("google").then((message) => {
              setNote(message || "Signed in with Google.");
              setBusy(false);
            }).catch((error) => {
              setNote(error instanceof Error ? error.message : String(error));
              setBusy(false);
            });
          }}>Continue with Google</button>
        </div>
        <p className="faint">Browser sign-in opens your default browser and comes back through ronic:// — the refresh token lands in the OS keychain, not a cookie jar.</p>
        <label className="field"><span>Email</span><input className="input" type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
        <label className="field"><span>Password</span><input className="input" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        <label className="field"><span>Name for a new account</span><input className="input" value={name} onChange={(event) => setName(event.target.value)} /></label>
        <div className="row-actions">
          <button className="btn" disabled={busy || email.trim().length === 0 || password.length < 8}>Sign in</button>
          <button
            type="button"
            className="btn ghost"
            disabled={busy || email.trim().length === 0 || password.length < 8}
            onClick={() => {
              setBusy(true);
              void signUp(email, password, name).then((message) => {
                setNote(message || "Account created. Confirm the email if Supabase asks, then sign in.");
                setBusy(false);
              }).catch((error) => {
                setNote(error instanceof Error ? error.message : String(error));
                setBusy(false);
              });
            }}
          >Create account</button>
        </div>
        {note ? <p className="muted">{note}</p> : null}
      </form>
    );
  }

  const current = String(session.user.user_metadata?.display_name ?? session.user.email ?? "");
  const founderLeft = license?.planTier !== "founder_lifetime";
  return (
    <section className="card stack">
      <div className="between">
        <strong>{license ? tierLabel(license.planTier, license.founderBadge) : "Signed in"}</strong>
        <button type="button" className="btn ghost small" disabled={busy} onClick={() => void signOut()}>Sign out</button>
      </div>
      <p className="muted">{session.user.email}</p>

      {license ? (
        <div className="between">
          <span className="muted">License</span>
          <span className="mono">
            {license.status === "active"
              ? `verified · ${license.maxDevices} machines · renews ${new Date(license.leaseExpUnix * 1000).toLocaleDateString()}`
              : license.status === "unsigned_dev"
                ? "unsigned dev build — keys not enforced"
                : license.status === "expired"
                  ? "expired — sign in to refresh"
                  : license.status}
          </span>
        </div>
      ) : null}
      {license && license.walletMicroUsd > 0 ? (
        <div className="between">
          <span className="muted">Burst compute wallet</span>
          <span className="mono">{money(license.walletMicroUsd)}</span>
        </div>
      ) : null}

      <div className="row-actions">
        <button
          type="button"
          className="btn small"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void registerThisDevice().then(async (message) => {
              if (message) {
                setNote(message);
                setBusy(false);
                return;
              }
              const leaseNote = await refreshLicense();
              setDevices(await listDevices());
              setNote(leaseNote || "This machine is registered and the license lease is refreshed.");
              setBusy(false);
              void run("license_status");
            });
          }}
        >Register this machine &amp; refresh license</button>
        {founderLeft ? (
          <button
            type="button"
            className="btn small"
            disabled={busy || !cloudConfig.checkoutApi}
            title={cloudConfig.checkoutApi ? "One-time $149 — 500 passes, then they are gone." : "Checkout is not configured on this build (VITE_CHECKOUT_API)."}
            onClick={() => {
              setBusy(true);
              void openCheckout("founder_pass", "stripe", (message) => {
                setNote(message);
                setBusy(false);
              });
            }}
          >Claim Founder Pass — $149 lifetime</button>
        ) : (
          <span className="quote-chip">★ FOUNDER {license?.founderBadge ? `#${license.founderBadge}` : ""}</span>
        )}
      </div>

      {devices ? (
        <div className="stack">
          <span className="muted">Machines ({devices.length}{license ? ` of ${license.maxDevices}` : ""})</span>
          {devices.map((device) => (
            <div className="between" key={device.id}>
              <span className="mono">{device.device_name || device.hardware_hash.slice(0, 12)} <span className="faint">{device.os_platform}</span></span>
              <button
                type="button"
                className="btn ghost small"
                onClick={() => {
                  void revokeDevice(device.id).then(async (message) => {
                    if (message) setNote(message);
                    setDevices(await listDevices());
                  });
                }}
              >Revoke</button>
            </div>
          ))}
        </div>
      ) : null}

      <label className="field"><span>Display name</span><input className="input" value={name} placeholder={current} onChange={(event) => setName(event.target.value)} /></label>
      <button
        type="button"
        className="btn"
        disabled={busy || name.trim().length === 0}
        onClick={() => {
          setBusy(true);
          void saveDisplayName(name).then((message) => {
            setNote(message || "Profile saved.");
            setBusy(false);
          }).catch((error) => {
            setNote(error instanceof Error ? error.message : String(error));
            setBusy(false);
          });
        }}
      >Save profile</button>
      {note ? <p className="muted">{note}</p> : null}
      <p className="faint">Sentry {cloudConfig.sentry ? "is on" : "is off"}. PostHog {cloudConfig.posthog ? "is on" : "is off"}. Checkout {cloudConfig.checkout ? "is configured" : "is not configured"}.</p>
    </section>
  );
}
