import { useState } from "react";
import type { ChatProviderLink } from "../kernel/liveChat";
import { Pill } from "./bits";

export function providerState(link: ChatProviderLink): { label: string; kind: string } {
  if (link.local) return link.ready ? { label: "Running", kind: "ok" } : { label: "Not running", kind: "warn" };
  if (link.siteOnly) return { label: "Site only", kind: "info" };
  return link.ready ? { label: "Ready", kind: "ok" } : { label: "Needs key", kind: "warn" };
}

export function ProviderState({ link }: { link: ChatProviderLink }) {
  const state = providerState(link);
  return <Pill kind={state.kind}>{state.label}</Pill>;
}

export function ProviderAuth({ link, onSignIn, onOpenKeys, onContinueChatGpt, onSaveKey }: { link: ChatProviderLink; onSignIn: (siteId: string) => void; onOpenKeys: (url: string) => void; onContinueChatGpt: () => void; onSaveKey: (id: string, secret: string) => void }) {
  const [secret, setSecret] = useState("");
  const [sent, setSent] = useState(false);
  function save() {
    const value = secret.trim();
    if (!link.id || !value) return;
    onSaveKey(link.id, value);
    setSecret("");
    setSent(true);
  }
  return (
    <div className="provider-auth">
      <p className="muted">{link.detail}</p>
      {link.connect === "chatgpt" ? <button type="button" className="btn small" onClick={onContinueChatGpt}>Continue with ChatGPT</button> : null}
      {link.id && !link.local ? (
        <label className="field">
          <span>{link.connect === "chatgpt" ? "Or paste an API key" : "API key for this chat"}</span>
          <input
            className="input"
            type="password"
            value={secret}
            placeholder="Paste a key"
            autoComplete="off"
            onChange={(event) => { setSecret(event.target.value); setSent(false); }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                save();
              }
            }}
          />
        </label>
      ) : null}
      <div className="row-actions">
        {link.connect === "site" && link.siteId ? <button type="button" className="btn ghost small" onClick={() => onSignIn(link.siteId)}>Open the site</button> : null}
        {link.connect === "key" && link.keyUrl ? <button type="button" className="btn ghost small" onClick={() => onOpenKeys(link.keyUrl)}>Open API keys</button> : null}
        {link.id && !link.local ? <button type="button" className="btn small" disabled={secret.trim().length === 0} onClick={save}>Save key</button> : null}
      </div>
      {sent ? <p className="muted">Key saved. Its models load into this chat — open Select a model to use one.</p> : null}
    </div>
  );
}
