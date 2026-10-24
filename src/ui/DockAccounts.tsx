import { useState } from "react";
import { WEB_APPS, type ChatModel, type WebApp } from "../kernel/liveChat";
import { addCustom } from "../kernel/modelPrefs";
import type { Provider } from "../types";
import { useOmni } from "../store";
import { Pill } from "./bits";

const CHAT_IDS = ["prov_chatgpt", "prov_anthropic", "prov_gemini", "prov_grok", "prov_mistral", "prov_perplexity", "prov_groq", "prov_together", "prov_cohere", "prov_nvidia", "prov_openrouter", "prov_deepseek", "prov_qwen", "prov_tokenrouter", "prov_bedrock", "prov_ollama"];

const SITES: { id: string; providerId: string; title: string; detail: string }[] = [
  { id: "chatgpt", providerId: "prov_chatgpt", title: "ChatGPT", detail: "GPT subscription. Sign in on the site." },
  { id: "claude", providerId: "prov_anthropic", title: "Claude", detail: "Claude subscription. Sign in on the site." },
  { id: "grok", providerId: "prov_grok", title: "Grok", detail: "Grok subscription. Sign in on the site." },
  { id: "gemini", providerId: "prov_gemini", title: "Gemini", detail: "Gemini subscription. Sign in on the site." },
  { id: "meta", providerId: "", title: "Meta AI", detail: "Meta subscription. Sign in on the site. Llama replies in this chat use an NVIDIA, Groq, or Together key." },
  { id: "mistral", providerId: "prov_mistral", title: "Mistral", detail: "Le Chat subscription. Sign in on the site." },
  { id: "perplexity", providerId: "prov_perplexity", title: "Perplexity", detail: "Perplexity subscription. Sign in on the site." },
  { id: "copilot", providerId: "", title: "Copilot", detail: "Microsoft Copilot subscription. Sign in on the site." },
];

export function DockAccounts({ models, selectedId, ollamaReady, onOpenSite, onSelectModel, onModelsChanged }: { models: ChatModel[]; selectedId: string; ollamaReady: boolean; onOpenSite: (app: WebApp) => void; onSelectModel: (id: string) => void; onModelsChanged: (id?: string) => void }) {
  const snap = useOmni((s) => s.snap)!;
  const run = useOmni((s) => s.run);
  const busy = useOmni((s) => s.busy);
  const [openId, setOpenId] = useState("");
  const providers = CHAT_IDS.map((id) => snap.providers.find((item) => item.id === id)).filter((item): item is Provider => Boolean(item));

  return (
    <div className="stack">
      <p className="muted">A subscription stays on the provider's site. An API key is what a reply in this chat uses. A selected model is not sent to another provider.</p>
      <div className="pane-h dock-sub">Subscriptions</div>
      {SITES.map((site) => {
        const app = WEB_APPS.find((item) => item.id === site.id);
        return (
          <article key={site.id} className="dock-card stack">
            <div className="between">
              <strong className="provider-name">{site.title}</strong>
              <Pill>Site</Pill>
            </div>
            <p className="muted">{site.detail}</p>
            <button type="button" className="btn ghost small" disabled={!app} onClick={() => app && onOpenSite(app)}>Sign in on the site</button>
          </article>
        );
      })}
      <div className="pane-h dock-sub">API accounts and models</div>
      {providers.map((provider) => (
        <AccountCard
          key={provider.id}
          provider={provider}
          open={openId === provider.id}
          models={models.filter((item) => item.providerId === provider.id)}
          selectedId={selectedId}
          ollamaReady={ollamaReady}
          onSelect={onSelectModel}
          busy={busy}
          onToggle={() => setOpenId((current) => current === provider.id ? "" : provider.id)}
          onSaveKey={(secret) => void run("set_provider_secret", { id: provider.id, secret })}
          onTest={() => void run("test_provider", { id: provider.id })}
          onAdd={(draft) => {
            const created = addCustom(draft);
            onModelsChanged(created.id);
          }}
        />
      ))}
    </div>
  );
}

function AccountCard({ provider, open, models, selectedId, ollamaReady, busy, onToggle, onSaveKey, onTest, onSelect, onAdd }: { provider: Provider; open: boolean; models: ChatModel[]; selectedId: string; ollamaReady: boolean; busy: boolean; onToggle: () => void; onSaveKey: (secret: string) => void; onTest: () => void; onSelect: (id: string) => void; onAdd: (draft: { label: string; upstreamModel: string; providerId: string }) => void }) {
  const [secret, setSecret] = useState("");
  const [label, setLabel] = useState("");
  const [upstream, setUpstream] = useState("");
  const local = provider.providerType === "local_ollama";
  const ready = local ? ollamaReady : provider.hasSecret;
  return (
    <article className="dock-card stack">
      <button type="button" className="between" onClick={onToggle}>
        <strong className="provider-name">{provider.name}</strong>
        <Pill kind={ready ? "info" : "warn"}>{local ? (ollamaReady ? "Running" : "Not running") : provider.hasSecret ? "Key stored" : "No key"}</Pill>
      </button>
      {open ? (
        <>
          <p className="muted">{provider.healthDetail}</p>
          {local ? <p className="muted">Ollama uses this computer. Models appear when it is running.</p> : (
            <>
              <label className="field">
                <span>{provider.hasSecret ? "Replace key" : "API key"}</span>
                <input className="input" type="password" value={secret} placeholder={provider.hasSecret ? "Stored locally" : "Paste a key"} onChange={(event) => setSecret(event.target.value)} />
              </label>
              <div className="row-actions">
                <button type="button" className="btn small" disabled={busy || secret.trim().length === 0} onClick={() => { onSaveKey(secret.trim()); setSecret(""); }}>Save key</button>
                <button type="button" className="btn ghost small" disabled={busy} onClick={onTest}>Test ping</button>
              </div>
            </>
          )}
          <p className="muted">{models.length === 0 ? "No models for this account yet." : `${models.length} models in this chat.`}</p>
          {models.slice(0, 8).map((model) => (
            <button type="button" key={model.id} className={`dock-model ${model.id === selectedId ? "on" : ""}`} onClick={() => onSelect(model.id)}>
              <span>{model.label}</span>
              <span className="mono">{model.upstreamModel}</span>
            </button>
          ))}
          {models.length > 8 ? <p className="muted">{models.length - 8} more are in the model menu.</p> : null}
          <label className="field"><span>Custom model name</span><input className="input" value={label} onChange={(event) => setLabel(event.target.value)} /></label>
          <label className="field"><span>Model id</span><input className="input mono" value={upstream} placeholder="the provider's model id" onChange={(event) => setUpstream(event.target.value)} /></label>
          <button
            type="button"
            className="btn ghost small"
            disabled={!label.trim() || !upstream.trim() || upstream.trim().includes(" ")}
            onClick={() => {
              onAdd({ label: label.trim(), upstreamModel: upstream.trim(), providerId: provider.id });
              setLabel("");
              setUpstream("");
            }}
          >
            Add model
          </button>
          {!local && !provider.hasSecret ? <p className="muted">A custom model stays saved. It shows in the menu after a key is stored.</p> : null}
        </>
      ) : null}
    </article>
  );
}
