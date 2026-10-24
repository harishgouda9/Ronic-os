import { useState } from "react";
import { useOmni } from "../store";
import { Pill } from "../ui/bits";

export function Onboarding() {
  const snap = useOmni((s) => s.snap)!;
  const run = useOmni((s) => s.run);
  const busy = useOmni((s) => s.busy);
  return (
    <div className="screen">
      <div className="center-card stack" style={{ width: "min(640px, 100%)" }}>
        <h1 className="title">A workstation that stays on this machine</h1>
        <p className="muted">
          Ronic OS keeps chats, keys, memory, and the wallet ledger in {snap.homeDir}. Provider sign-in opens a local window. The ledger on screen is a sandbox until you wire a live rail, and this build will not send a real charge.
        </p>
        <div className="row-actions">
          <button className="btn" disabled={busy} onClick={() => void run("scan_environment")}>Scan this computer</button>
          <button className="btn ghost" disabled={busy || !snap.scan} onClick={() => void run("link_apps")}>Link what was found</button>
        </div>
        {snap.scan ? (
          <div className="stack">
            <p className="muted">Scan took {snap.scan.durationMs} ms.</p>
            {snap.scan.found.map((hit) => (
              <div key={hit.path + hit.name} className="between">
                <span>{hit.name}</span>
                <span className="mono">{hit.path}</span>
              </div>
            ))}
            {snap.scan.missing.map((name) => (
              <div key={name} className="between">
                <span>{name}</span>
                <Pill kind="warn">not on PATH</Pill>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted">The scan looks for Claude Code, Codex, Gemini, Aider, OpenCode, Cursor, VS Code, Ollama, uv, and bun. Missing tools stay missing. Nothing is downloaded for you.</p>
        )}
        <button className="btn" disabled={busy} onClick={() => void run("complete_onboarding")}>Enter the workspace</button>
      </div>
    </div>
  );
}

export function Vault() {
  const snap = useOmni((s) => s.snap)!;
  const run = useOmni((s) => s.run);
  const busy = useOmni((s) => s.busy);
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const mismatch = again.length > 0 && password !== again;
  return (
    <div className="screen">
      <div className="center-card stack">
        <h1 className="title">{snap.hasPassphrase ? "Unlock the vault" : "Set a vault passphrase"}</h1>
        <p className="muted">
          {snap.kernel === "rust"
            ? "The desktop shell derives an Argon2id key and seals provider secrets with AES-256-GCM. The key stays in memory until you lock the vault."
            : "This browser preview only remembers that a passphrase was set. Encryption runs in the desktop shell."}
        </p>
        {snap.hasPassphrase && snap.vaultUnlocked ? (
          <button className="btn" disabled={busy} onClick={() => void run("lock_vault")}>Lock vault</button>
        ) : (
          <>
            <label className="field">
              <span>Passphrase</span>
              <input className="input" type="password" autoFocus value={password} onChange={(event) => setPassword(event.target.value)} />
            </label>
            {snap.hasPassphrase ? null : (
              <label className="field">
                <span>Repeat passphrase</span>
                <input className="input" type="password" value={again} onChange={(event) => setAgain(event.target.value)} />
              </label>
            )}
            {mismatch ? <p className="muted">The two passphrases differ.</p> : null}
            <button
              className="btn"
              disabled={busy || password.length < 8 || (!snap.hasPassphrase && password !== again)}
              onClick={() => void run(snap.hasPassphrase ? "unlock_vault" : "set_vault_passphrase", { password })}
            >
              {snap.hasPassphrase ? "Unlock" : "Create vault"}
            </button>
            <p className="faint">At least 8 characters. There is no recovery if you forget it.</p>
          </>
        )}
      </div>
    </div>
  );
}
