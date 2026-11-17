import { useState, type ReactNode } from "react";
import { X, Check, ExternalLink, KeyRound, Globe, Sparkles, Loader2, AlertCircle } from "lucide-react";
import { ProviderLogo } from "./providerLogos";

export type ProviderAuthMethod = "oauth" | "api_key" | "local" | "cli" | "web";

export type ProviderConnectConfig = {
  id: string;
  name: string;
  tagline: string;
  /** Methods supported, in display order. First one is the default tab. */
  methods: ProviderAuthMethod[];
  /** OAuth / site sign-in URL or handler id */
  oauthLabel?: string;
  oauthHint?: string;
  /** API key helpers */
  keyUrl?: string;
  keyPlaceholder?: string;
  keyHint?: string;
  /** If true the provider supports ChatGPT-style subscription reuse via OAuth */
  subscriptionOAuth?: boolean;
};

export const PROVIDER_CONFIGS: ProviderConnectConfig[] = [
  {
    id: "prov_chatgpt",
    name: "ChatGPT",
    tagline: "Use your ChatGPT Plus, Pro, Team, or Enterprise plan",
    methods: ["oauth", "api_key"],
    oauthLabel: "Continue with ChatGPT",
    oauthHint: "Sign in with your OpenAI account. Your existing subscription is used — no extra API charges.",
    subscriptionOAuth: true,
    keyUrl: "https://platform.openai.com/api-keys",
    keyPlaceholder: "sk-...",
    keyHint: "For pay-as-you-go API access instead of your subscription.",
  },
  {
    id: "prov_anthropic",
    name: "Claude",
    tagline: "Use Claude with an Anthropic API key",
    methods: ["api_key", "web"],
    keyUrl: "https://console.anthropic.com/settings/keys",
    keyPlaceholder: "sk-ant-...",
    keyHint: "Create a key in the Anthropic Console. Pro & Max subscribers can generate keys from the same console.",
  },
  {
    id: "prov_gemini",
    name: "Gemini",
    tagline: "Use Google's Gemini models",
    methods: ["api_key", "web"],
    keyUrl: "https://aistudio.google.com/apikey",
    keyPlaceholder: "AIza...",
    keyHint: "Get a free key from Google AI Studio. Works with Gemini Advanced subscriptions via the same Google account.",
  },
  {
    id: "prov_grok",
    name: "Grok",
    tagline: "Use xAI's Grok models",
    methods: ["api_key", "web"],
    keyUrl: "https://console.x.ai",
    keyPlaceholder: "xai-...",
    keyHint: "Sign in to console.x.ai with your X account to create an API key.",
  },
  {
    id: "prov_mistral",
    name: "Mistral",
    tagline: "Mistral Large, Codestral & open weights",
    methods: ["api_key"],
    keyUrl: "https://console.mistral.ai/api-keys",
    keyPlaceholder: "...",
    keyHint: "Free tier available. Create a key in the Mistral console.",
  },
  {
    id: "prov_deepseek",
    name: "DeepSeek",
    tagline: "DeepSeek V3 & R1 reasoning",
    methods: ["api_key"],
    keyUrl: "https://platform.deepseek.com/api_keys",
    keyPlaceholder: "sk-...",
    keyHint: "Top up at platform.deepseek.com, then create a key.",
  },
  {
    id: "prov_perplexity",
    name: "Perplexity",
    tagline: "Web-search connected Sonar models",
    methods: ["api_key"],
    keyUrl: "https://www.perplexity.ai/settings/api",
    keyPlaceholder: "pplx-...",
    keyHint: "Pro subscribers get monthly API credits in their account settings.",
  },
  {
    id: "prov_groq",
    name: "Groq",
    tagline: "Ultra-fast Llama & Mixtral inference",
    methods: ["api_key"],
    keyUrl: "https://console.groq.com/keys",
    keyPlaceholder: "gsk_...",
    keyHint: "Free tier available at console.groq.com.",
  },
  {
    id: "prov_together",
    name: "Together",
    tagline: "Open-source models & fine-tunes",
    methods: ["api_key"],
    keyUrl: "https://api.together.ai/settings/api-keys",
    keyPlaceholder: "...",
    keyHint: "Sign up at together.ai for a free starting credit.",
  },
  {
    id: "prov_openrouter",
    name: "OpenRouter",
    tagline: "One key for 200+ models",
    methods: ["api_key"],
    keyUrl: "https://openrouter.ai/keys",
    keyPlaceholder: "sk-or-...",
    keyHint: "A single OpenRouter key unlocks models from every major provider.",
  },
  {
    id: "prov_cohere",
    name: "Cohere",
    tagline: "Command R+ and Embed models",
    methods: ["api_key"],
    keyUrl: "https://dashboard.cohere.com/api-keys",
    keyPlaceholder: "...",
    keyHint: "Trial keys are free for prototyping.",
  },
  {
    id: "prov_qwen",
    name: "Qwen",
    tagline: "Alibaba Qwen via DashScope",
    methods: ["api_key"],
    keyUrl: "https://dashscope.console.aliyun.com/apiKey",
    keyPlaceholder: "sk-...",
    keyHint: "Create a key in the DashScope console.",
  },
  {
    id: "prov_ollama",
    name: "Ollama",
    tagline: "Run open models locally, fully offline",
    methods: ["local"],
    keyHint: "Install Ollama and pull a model — no key required.",
  },
];

type Props = {
  open: boolean;
  /** Currently-highlighted provider id (optional — user can pick) */
  initialId?: string;
  /** Filter the catalog (e.g. only unconnected) */
  only?: string[];
  onClose: () => void;
  /** Fired when the user clicks the OAuth button for a provider */
  onOAuth: (providerId: string) => void;
  /** Fired when the user saves an API key */
  onSaveKey: (providerId: string, secret: string) => Promise<void> | void;
  /** Fired to open the embedded web site (sign-in that stays in browser) */
  onOpenSite?: (providerId: string) => void;
  /** Local provider check (Ollama) */
  onTestLocal?: (providerId: string) => void;
  /** Set of provider ids already connected */
  connectedIds?: Set<string>;
  /** Show inline busy indicator per provider */
  busyId?: string;
  /** Status / error text shown at the bottom */
  status?: string;
};

export function ProviderConnectModal({
  open,
  initialId,
  only,
  onClose,
  onOAuth,
  onSaveKey,
  onOpenSite,
  onTestLocal,
  connectedIds,
  busyId,
  status,
}: Props) {
  const [selectedId, setSelectedId] = useState<string>(initialId ?? PROVIDER_CONFIGS[0].id);
  const [method, setMethod] = useState<ProviderAuthMethod | null>(null);
  const [secret, setSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");

  if (!open) return null;

  const configs = PROVIDER_CONFIGS.filter((c) => !only || only.includes(c.id));
  const filtered = configs.filter(
    (c) =>
      !query.trim() ||
      c.name.toLowerCase().includes(query.trim().toLowerCase()) ||
      c.tagline.toLowerCase().includes(query.trim().toLowerCase())
  );

  const selected = configs.find((c) => c.id === selectedId) ?? configs[0];
  const activeMethod: ProviderAuthMethod = method && selected.methods.includes(method) ? method : selected.methods[0];
  const isConnected = connectedIds?.has(selected.id);
  const busy = busyId === selected.id || saving;

  async function handleSaveKey() {
    const value = secret.trim();
    if (!value) return;
    setSaving(true);
    setError("");
    try {
      await onSaveKey(selected.id, value);
      setSecret("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save that key. Try again.");
    } finally {
      setSaving(false);
    }
  }

  function pick(id: string) {
    setSelectedId(id);
    setMethod(null);
    setSecret("");
    setError("");
  }

  return (
    <div className="pcm-backdrop" onClick={onClose} role="presentation">
      <div
        className="pcm"
        role="dialog"
        aria-modal="true"
        aria-label="Connect a model provider"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="pcm-head">
          <div className="pcm-head-text">
            <h2>Connect a model provider</h2>
            <p>Sign in with your existing subscription or paste an API key.</p>
          </div>
          <button type="button" className="pcm-close" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </header>

        <div className="pcm-body">
          {/* Left: provider grid */}
          <div className="pcm-list" role="listbox" aria-label="Providers">
            <div className="pcm-search">
              <input
                type="text"
                placeholder="Search providers…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Search providers"
              />
            </div>
            <div className="pcm-grid">
              {filtered.map((c) => {
                const connected = connectedIds?.has(c.id);
                const active = c.id === selectedId;
                return (
                  <button
                    key={c.id}
                    type="button"
                    role="option"
                    aria-selected={active}
                    className={`pcm-tile ${active ? "active" : ""} ${connected ? "connected" : ""}`}
                    onClick={() => pick(c.id)}
                  >
                    <ProviderLogo id={c.id} name={c.name} size={36} />
                    <span className="pcm-tile-name">{c.name}</span>
                    {connected ? (
                      <span className="pcm-tile-badge" aria-label="Connected">
                        <Check size={11} />
                      </span>
                    ) : null}
                    {c.subscriptionOAuth ? (
                      <span className="pcm-tile-tag">
                        <Sparkles size={9} /> Subscription
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Right: connection pane */}
          <div className="pcm-detail">
            <div className="pcm-detail-head">
              <ProviderLogo id={selected.id} name={selected.name} size={48} />
              <div>
                <h3>{selected.name}</h3>
                <p>{selected.tagline}</p>
              </div>
              {isConnected ? (
                <span className="pcm-connected-pill">
                  <Check size={12} /> Connected
                </span>
              ) : null}
            </div>

            {/* Method tabs */}
            {selected.methods.length > 1 ? (
              <div className="pcm-tabs" role="tablist" aria-label="Connection method">
                {selected.methods.map((m) => (
                  <button
                    key={m}
                    type="button"
                    role="tab"
                    aria-selected={activeMethod === m}
                    className={`pcm-tab ${activeMethod === m ? "active" : ""}`}
                    onClick={() => setMethod(m)}
                  >
                    {m === "oauth" ? (
                      <>
                        <Sparkles size={12} /> Sign in
                      </>
                    ) : m === "api_key" ? (
                      <>
                        <KeyRound size={12} /> API key
                      </>
                    ) : m === "web" ? (
                      <>
                        <Globe size={12} /> Web session
                      </>
                    ) : m === "local" ? (
                      "Local"
                    ) : (
                      m
                    )}
                  </button>
                ))}
              </div>
            ) : null}

            <div className="pcm-pane">
              {activeMethod === "oauth" ? (
                <OAuthPane
                  config={selected}
                  busy={busy}
                  onConnect={() => onOAuth(selected.id)}
                />
              ) : activeMethod === "api_key" ? (
                <ApiKeyPane
                  config={selected}
                  secret={secret}
                  setSecret={(v) => {
                    setSecret(v);
                    setError("");
                  }}
                  onSave={handleSaveKey}
                  busy={busy}
                  isConnected={!!isConnected}
                />
              ) : activeMethod === "web" ? (
                <WebPane config={selected} onOpen={() => onOpenSite?.(selected.id)} />
              ) : activeMethod === "local" ? (
                <LocalPane config={selected} onTest={() => onTestLocal?.(selected.id)} busy={busy} />
              ) : null}
            </div>

            {error ? (
              <p className="pcm-error" role="alert">
                <AlertCircle size={13} /> {error}
              </p>
            ) : null}
          </div>
        </div>

        {status ? <footer className="pcm-foot">{status}</footer> : null}
      </div>
    </div>
  );
}

/* ── Panes ─────────────────────────────────────────────────────── */

function OAuthPane({
  config,
  busy,
  onConnect,
}: {
  config: ProviderConnectConfig;
  busy: boolean;
  onConnect: () => void;
}) {
  return (
    <div className="pcm-oauth">
      {config.subscriptionOAuth ? (
        <div className="pcm-note pcm-note-good">
          <Sparkles size={14} />
          <div>
            <strong>Use your existing subscription.</strong> Sign in with the account that already pays for{" "}
            {config.name}. No new charges — Ronic OS will use your plan's included access.
          </div>
        </div>
      ) : null}
      <button type="button" className="pcm-primary" onClick={onConnect} disabled={busy}>
        {busy ? <Loader2 size={15} className="spin" /> : <ProviderLogo id={config.id} name={config.name} size={18} radius={5} />}
        {busy ? "Waiting for sign-in…" : config.oauthLabel ?? `Continue with ${config.name}`}
      </button>
      {config.oauthHint ? <p className="pcm-hint">{config.oauthHint}</p> : null}
      <p className="pcm-hint pcm-hint-dim">
        A browser window opens for sign-in. Your password is never seen or stored by Ronic OS.
      </p>
    </div>
  );
}

function ApiKeyPane({
  config,
  secret,
  setSecret,
  onSave,
  busy,
  isConnected,
}: {
  config: ProviderConnectConfig;
  secret: string;
  setSecret: (v: string) => void;
  onSave: () => void;
  busy: boolean;
  isConnected: boolean;
}) {
  return (
    <div className="pcm-keypane">
      <label className="pcm-label">
        {isConnected ? "Replace API key" : "Paste API key"}
        <input
          type="password"
          className="pcm-input"
          placeholder={config.keyPlaceholder ?? "sk-..."}
          value={secret}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setSecret(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onSave();
            }
          }}
        />
      </label>
      {config.keyHint ? <p className="pcm-hint">{config.keyHint}</p> : null}
      <div className="pcm-row">
        <button type="button" className="pcm-primary" onClick={onSave} disabled={busy || !secret.trim()}>
          {busy ? <Loader2 size={14} className="spin" /> : <KeyRound size={14} />}
          {busy ? "Saving…" : isConnected ? "Replace key" : "Save & connect"}
        </button>
        {config.keyUrl ? (
          <a className="pcm-secondary" href={config.keyUrl} target="_blank" rel="noreferrer">
            Get a key <ExternalLink size={11} />
          </a>
        ) : null}
      </div>
      <p className="pcm-hint pcm-hint-dim">Stored encrypted in your local vault. Never sent to Ronic servers.</p>
    </div>
  );
}

function WebPane({ config, onOpen }: { config: ProviderConnectConfig; onOpen: () => void }) {
  return (
    <div className="pcm-webpane">
      <p className="pcm-hint">
        Opens {config.name} in an embedded window. Sign in there to chat on the website — that session stays in the
        browser tab and isn't shared with Ronic OS's API chat.
      </p>
      <button type="button" className="pcm-secondary" onClick={onOpen}>
        <Globe size={13} /> Open {config.name} site
      </button>
    </div>
  );
}

function LocalPane({ config, onTest, busy }: { config: ProviderConnectConfig; onTest: () => void; busy: boolean }) {
  return (
    <div className="pcm-localpane">
      <p className="pcm-hint">{config.keyHint}</p>
      <div className="pcm-row">
        <a className="pcm-secondary" href="https://ollama.com/download" target="_blank" rel="noreferrer">
          Download Ollama <ExternalLink size={11} />
        </a>
        <button type="button" className="pcm-primary" onClick={onTest} disabled={busy}>
          {busy ? <Loader2 size={14} className="spin" /> : null}
          {busy ? "Checking…" : "Check if running"}
        </button>
      </div>
    </div>
  );
}

/* ── Compact trigger button (used inline on screens) ──────────── */

export function ConnectProviderButton({
  onClick,
  children = "Connect provider",
}: {
  onClick: () => void;
  children?: ReactNode;
}) {
  return (
    <button type="button" className="pcm-primary" onClick={onClick}>
      {children}
    </button>
  );
}
