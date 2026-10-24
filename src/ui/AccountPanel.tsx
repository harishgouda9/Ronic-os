import { useState, useSyncExternalStore } from "react";
import { cloudConfig, cloudSession, saveDisplayName, signIn, signOut, signUp, subscribeCloud } from "../services/cloud";

export function AccountPanel() {
  const session = useSyncExternalStore(subscribeCloud, cloudSession, () => null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

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
  return (
    <section className="card stack">
      <div className="between">
        <strong>{current || "Signed in"}</strong>
        <button type="button" className="btn ghost small" disabled={busy} onClick={() => void signOut()}>Sign out</button>
      </div>
      <p className="muted">{session.user.email}</p>
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
