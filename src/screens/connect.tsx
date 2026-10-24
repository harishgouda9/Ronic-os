import { useEffect, useState } from "react";
import {
  AppWindow,
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  FolderOpen,
  Layers,
  Play,
  Plus,
  Search,
  Sparkles,
  Square,
  Terminal,
} from "lucide-react";
import { isTauri, pickPaths } from "../api";
import type { LinkedApp, MemoryEngine, MemoryItem, Provider, ProviderType } from "../types";
import { useOmni } from "../store";
import { Pill, when } from "../ui/bits";
import { AppLogo } from "../ui/appLogos";

const INSTALLS: Record<string, string> = {
  prov_claude: "https://docs.anthropic.com/en/docs/claude-code/setup",
  prov_gemini: "https://github.com/google-gemini/gemini-cli",
  prov_ollama: "https://ollama.com/download",
  app_aider: "https://aider.chat/docs/install.html",
  app_codex: "https://github.com/openai/codex",
};

export function isProviderConnected(provider: Provider): boolean {
  if (!provider.isActive) return false;
  if (provider.hasSecret) return true;
  const detail = (provider.healthDetail || "").toLowerCase();
  if (detail.includes("not signed in") || detail.includes("needs an api key") || detail.includes("not reachable")) {
    return false;
  }
  if (
    detail.includes("key stored") ||
    detail.includes("accepted the key") ||
    detail.includes("ollama responded") ||
    /\bis signed in\b/.test(detail) ||
    detail.startsWith("signed in")
  ) {
    return true;
  }
  const path = provider.binaryOrEndpoint.trim();
  if (path.startsWith("wsl:")) return true;
  if (path && !path.startsWith("http") && (detail.includes("detected") || path.endsWith(".exe") || path.includes("/") || path.includes("\\"))) {
    return true;
  }
  return false;
}

export function isAppInstalled(app: LinkedApp): boolean {
  return Boolean(app.executablePath && app.executablePath.trim().length > 0);
}

function getProviderTypeLabel(type: ProviderType): string {
  switch (type) {
    case "byok_api":
      return "External API";
    case "cli_subprocess":
      return "CLI & Local";
    case "official_oauth":
      return "Web (OAuth)";
    case "isolated_webview":
      return "Web App";
    case "local_ollama":
      return "Local Ollama";
    default:
      return "Provider";
  }
}

const PRESETS = [
  {
    name: "Groq",
    type: "byok_api" as ProviderType,
    endpoint: "https://api.groq.com/openai/v1",
    hint: "Super-fast Llama 3 & Mixtral inference",
  },
  {
    name: "Together AI",
    type: "byok_api" as ProviderType,
    endpoint: "https://api.together.xyz/v1",
    hint: "Open-source models & fine-tunes",
  },
  {
    name: "Mistral AI",
    type: "byok_api" as ProviderType,
    endpoint: "https://api.mistral.ai/v1",
    hint: "Mistral Large, Codestral & Pixtral",
  },
  {
    name: "Perplexity",
    type: "byok_api" as ProviderType,
    endpoint: "https://api.perplexity.ai",
    hint: "Web-search connected LLMs",
  },
  {
    name: "DeepSeek",
    type: "byok_api" as ProviderType,
    endpoint: "https://api.deepseek.com/v1",
    hint: "DeepSeek V3 & R1 reasoning models",
  },
  {
    name: "xAI (Grok)",
    type: "byok_api" as ProviderType,
    endpoint: "https://api.x.ai/v1",
    hint: "Grok 2 and Grok Vision APIs",
  },
  {
    name: "Local vLLM / LM Studio",
    type: "byok_api" as ProviderType,
    endpoint: "http://localhost:1234/v1",
    hint: "Local inference in OpenAI schema",
  },
  {
    name: "Custom OpenAI Compatible",
    type: "byok_api" as ProviderType,
    endpoint: "https://api.example.com/v1",
    hint: "Any OpenAI-compatible REST server",
  },
];

export function Providers() {
  const snap = useOmni((s) => s.snap)!;
  const run = useOmni((s) => s.run);
  const busy = useOmni((s) => s.busy);

  const [modalOpen, setModalOpen] = useState(false);
  const [modalTab, setModalTab] = useState<"provider" | "app">("provider");
  const [connectedFilter, setConnectedFilter] = useState<"all" | "providers" | "apps">("all");
  const [catalogFilter, setCatalogFilter] = useState<"all" | "api" | "cli" | "web" | "apps">("all");
  const [searchQuery, setSearchQuery] = useState("");

  const connectedProviders = snap.providers.filter(isProviderConnected);
  const connectedApps = snap.apps.filter(isAppInstalled);
  const waitingProviders = snap.providers.filter((p) => !isProviderConnected(p));
  const missingApps = snap.apps.filter((a) => !isAppInstalled(a));

  const totalConnected = connectedProviders.length + connectedApps.length;
  const totalWaiting = waitingProviders.length + missingApps.length;

  function openAdd(tab: "provider" | "app" = "provider") {
    setModalTab(tab);
    setModalOpen(true);
  }

  function browseForApp(appId: string) {
    void pickPaths("program").then((paths) => {
      if (paths[0]) void run("set_app_path", { appId, path: paths[0] });
    });
  }

  const query = searchQuery.trim().toLowerCase();

  // Filter connected items
  const filteredConnectedProviders = connectedProviders.filter((p) =>
    !query || p.name.toLowerCase().includes(query) || p.binaryOrEndpoint.toLowerCase().includes(query)
  );
  const filteredConnectedApps = connectedApps.filter((a) =>
    !query || a.appName.toLowerCase().includes(query) || a.executablePath.toLowerCase().includes(query)
  );

  // Filter catalog items
  const filteredWaitingProviders = waitingProviders.filter((p) => {
    if (catalogFilter === "api" && p.providerType !== "byok_api") return false;
    if (catalogFilter === "cli" && p.providerType !== "cli_subprocess" && p.providerType !== "local_ollama") return false;
    if (catalogFilter === "web" && p.providerType !== "official_oauth" && p.providerType !== "isolated_webview") return false;
    if (catalogFilter === "apps") return false;
    if (query && !p.name.toLowerCase().includes(query) && !p.binaryOrEndpoint.toLowerCase().includes(query)) return false;
    return true;
  });

  const filteredMissingApps = missingApps.filter((a) => {
    if (catalogFilter === "api" || catalogFilter === "cli" || catalogFilter === "web") return false;
    if (query && !a.appName.toLowerCase().includes(query) && !(a.detail || "").toLowerCase().includes(query)) return false;
    return true;
  });

  return (
    <div className="screen providers-screen">
      {/* Top Header */}
      <div className="providers-top-head between">
        <div>
          <h1 className="title">Apps & providers</h1>
          <p className="muted">
            Manage active AI models, APIs, and computer apps. Connect new providers and desktop executables to equip your bot team.
          </p>
        </div>
        <div className="row-actions">
          <button className="btn ghost" disabled={busy} onClick={() => void run("scan_environment")} title="Scan system PATH for local CLI tools">
            Scan PATH
          </button>
          <button className="btn ghost" disabled={busy} onClick={() => void run("link_apps")} title="Auto-link detected apps">
            Link detected
          </button>
          <button className="btn primary-highlight" onClick={() => openAdd("provider")}>
            <Plus size={16} /> Connect new
          </button>
        </div>
      </div>

      {/* Metrics & Fast Add Strip */}
      <div className="providers-stats-strip" role="status">
        <div className="stats-badges">
          <span className="stats-pill connected">
            <i className="status-dot ok" />
            <strong>{totalConnected}</strong> Connected & Ready
          </span>
          <span className="stats-pill waiting">
            <i className="status-dot warn" />
            <strong>{totalWaiting}</strong> Waiting to Connect
          </span>
        </div>
        <button type="button" className="btn-add-shortcut" onClick={() => openAdd("provider")}>
          <Plus size={14} /> Add new provider or app
        </button>
      </div>

      {/* SECTION 1: CONNECTED APPS & PROVIDERS (Active Dashboard Layout) */}
      <section className="section-block connected-block" aria-label="Connected apps and providers">
        <div className="section-bar between">
          <div className="section-title-wrap">
            <div className="title-row">
              <span className="badge-bubble ok">{totalConnected}</span>
              <h2 className="section-heading">Connected</h2>
              <span className="pill ok live-pill">Active & Ready</span>
            </div>
            <p className="muted section-lead">
              Ready now. These services and installed local applications are active and available across your workspace.
            </p>
          </div>
          <div className="segment-pills">
            <button
              type="button"
              className={`pill-tab ${connectedFilter === "all" ? "active" : ""}`}
              onClick={() => setConnectedFilter("all")}
            >
              All ({totalConnected})
            </button>
            <button
              type="button"
              className={`pill-tab ${connectedFilter === "providers" ? "active" : ""}`}
              onClick={() => setConnectedFilter("providers")}
            >
              AI Providers ({connectedProviders.length})
            </button>
            <button
              type="button"
              className={`pill-tab ${connectedFilter === "apps" ? "active" : ""}`}
              onClick={() => setConnectedFilter("apps")}
            >
              Desktop Apps ({connectedApps.length})
            </button>
          </div>
        </div>

        {totalConnected > 0 ? (
          <div className="connected-dashboard-grid">
            {(connectedFilter === "all" || connectedFilter === "providers") &&
              filteredConnectedProviders.map((provider) => (
                <ConnectedProviderCard key={provider.id} provider={provider} options={snap.providers} />
              ))}
            {(connectedFilter === "all" || connectedFilter === "apps") &&
              filteredConnectedApps.map((app) => (
                <ConnectedAppCard key={app.id} app={app} onBrowse={() => browseForApp(app.id)} />
              ))}
          </div>
        ) : (
          <div className="empty-connected-panel">
            <div className="empty-icon-wrap">
              <Layers size={28} />
            </div>
            <strong>Nothing is connected yet</strong>
            <p className="muted">Connect an AI provider using an API key below, or scan this computer for installed CLI tools.</p>
            <div className="row-actions">
              <button type="button" className="btn" onClick={() => openAdd("provider")}>
                <Plus size={14} /> Connect new provider
              </button>
              <button type="button" className="btn ghost" disabled={busy} onClick={() => void run("scan_environment")}>
                Scan computer
              </button>
            </div>
          </div>
        )}
      </section>

      {/* SECTION 2: NOT CONNECTED (Integration Directory / Setup Catalog Layout) */}
      <section className="section-block not-connected-block" aria-label="Not connected providers and apps">
        <div className="section-bar between">
          <div className="section-title-wrap">
            <div className="title-row">
              <span className="badge-bubble warn">{totalWaiting}</span>
              <h2 className="section-heading">Not connected</h2>
              <span className="pill warn live-pill">Available to Connect</span>
            </div>
            <p className="muted section-lead">
              Paste an API key, sign in, or browse to a program to link these tools into Ronic OS.
            </p>
          </div>

          <div className="catalog-toolbar">
            <div className="catalog-search">
              <Search size={14} className="search-icon" />
              <input
                className="search-input"
                placeholder="Filter available..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              {searchQuery ? (
                <button type="button" className="search-clear" onClick={() => setSearchQuery("")}>
                  ×
                </button>
              ) : null}
            </div>
          </div>
        </div>

        {/* Filter Categories Bar */}
        <div className="catalog-tabs-bar">
          <button
            type="button"
            className={`catalog-tab ${catalogFilter === "all" ? "active" : ""}`}
            onClick={() => setCatalogFilter("all")}
          >
            All Available ({totalWaiting})
          </button>
          <button
            type="button"
            className={`catalog-tab ${catalogFilter === "api" ? "active" : ""}`}
            onClick={() => setCatalogFilter("api")}
          >
            AI Models & APIs ({waitingProviders.filter((p) => p.providerType === "byok_api").length})
          </button>
          <button
            type="button"
            className={`catalog-tab ${catalogFilter === "cli" ? "active" : ""}`}
            onClick={() => setCatalogFilter("cli")}
          >
            CLI & Local ({waitingProviders.filter((p) => p.providerType === "cli_subprocess" || p.providerType === "local_ollama").length})
          </button>
          <button
            type="button"
            className={`catalog-tab ${catalogFilter === "web" ? "active" : ""}`}
            onClick={() => setCatalogFilter("web")}
          >
            Web Apps ({waitingProviders.filter((p) => p.providerType === "official_oauth" || p.providerType === "isolated_webview").length})
          </button>
          <button
            type="button"
            className={`catalog-tab ${catalogFilter === "apps" ? "active" : ""}`}
            onClick={() => setCatalogFilter("apps")}
          >
            Desktop Apps ({missingApps.length})
          </button>
        </div>

        {/* Directory Catalog Grid */}
        <div className="catalog-directory-grid">
          {filteredWaitingProviders.map((provider) => (
            <WaitingProviderCard key={provider.id} provider={provider} options={snap.providers} />
          ))}

          {filteredMissingApps.map((app) => (
            <MissingAppCard key={app.id} app={app} onBrowse={() => browseForApp(app.id)} />
          ))}

          {/* Connect New Custom Card */}
          <button type="button" className="card-add-custom" onClick={() => openAdd("provider")}>
            <div className="add-icon-ring">
              <Plus size={24} />
            </div>
            <strong>Connect New Provider or App</strong>
            <p className="muted">
              Add any custom OpenAI-compatible API endpoint, local model server, or desktop application.
            </p>
            <span className="btn small">+ Add Custom</span>
          </button>
        </div>

        {filteredWaitingProviders.length === 0 && filteredMissingApps.length === 0 && (
          <div className="empty-catalog-note">
            <p className="muted">No matching tools found for “{searchQuery}”. Try clearing your search.</p>
          </div>
        )}
      </section>

      {/* Connect New App or Provider Modal */}
      {modalOpen && (
        <ConnectNewModal
          initialTab={modalTab}
          onClose={() => setModalOpen(false)}
        />
      )}
    </div>
  );
}

// -------------------------------------------------------------
// Component: Connected Provider Card (Active Dashboard Style)
// -------------------------------------------------------------
function ConnectedProviderCard({ provider, options }: { provider: Provider; options: Provider[] }) {
  const run = useOmni((s) => s.run);
  const go = useOmni((s) => s.go);
  const busy = useOmni((s) => s.busy);

  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [secret, setSecret] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [endpoint, setEndpoint] = useState(provider.binaryOrEndpoint);

  useEffect(() => {
    setEndpoint(provider.binaryOrEndpoint);
  }, [provider.binaryOrEndpoint]);

  const isWeb = provider.providerType === "isolated_webview" || provider.providerType === "official_oauth";

  function copyPath() {
    if (!endpoint) return;
    void navigator.clipboard.writeText(endpoint);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function save(patch: Partial<Provider>) {
    void run("update_provider", {
      patch: {
        id: provider.id,
        quotaUsedPercent: provider.quotaUsedPercent,
        fallbackAccountId: provider.fallbackAccountId,
        isActive: provider.isActive,
        allowCliDispatch: provider.allowCliDispatch,
        binaryOrEndpoint: endpoint,
        quotaResetsAt: provider.quotaResetsAt,
        ...patch,
      },
    });
  }

  return (
    <article className="connected-card stack">
      <div className="card-top between">
        <div className="brand-badge-group">
          <AppLogo id={provider.id} name={provider.name} url={provider.binaryOrEndpoint} size={38} />
          <div>
            <div className="brand-name-row">
              <strong>{provider.name}</strong>
              <span className="type-badge">{getProviderTypeLabel(provider.providerType)}</span>
            </div>
            <div className="health-line">
              <i className="status-dot ok" />
              <span>{provider.hasSecret ? "Key stored" : provider.healthDetail || "Ready"}</span>
            </div>
          </div>
        </div>
        <Pill kind="ok">{provider.isActive ? "Ready" : "Paused"}</Pill>
      </div>

      {endpoint ? (
        <div className="endpoint-bar" title={endpoint}>
          <span className="endpoint-text mono">{endpoint}</span>
          <button
            type="button"
            className="copy-mini-btn"
            onClick={copyPath}
            title={copied ? "Copied!" : "Copy endpoint"}
          >
            {copied ? <Check size={12} className="text-emerald" /> : <Copy size={12} />}
          </button>
        </div>
      ) : null}

      <div className="card-actions-row between">
        <div className="left-actions">
          <button
            type="button"
            className="btn ghost small"
            disabled={busy}
            onClick={() => void run("test_provider", { id: provider.id })}
            title="Send a quick ping to test latency and validity"
          >
            Test ping
          </button>
          {isWeb ? (
            <button
              type="button"
              className="btn small"
              onClick={() => {
                sessionStorage.setItem("omni.focusHarness", provider.id);
                go("chat");
              }}
            >
              Open in workspace
            </button>
          ) : null}
        </div>
        <button
          type="button"
          className="btn ghost small manage-toggle-btn"
          aria-expanded={open}
          onClick={() => setOpen((prev) => !prev)}
        >
          {open ? "Hide" : "Manage"} <ChevronDown size={14} className={open ? "rotate-open" : ""} />
        </button>
      </div>

      {/* Collapsible Manage Panel */}
      {open && (
        <div className="manage-drawer stack">
          <label className="field">
            <span>Endpoint or Binary</span>
            <div className="input-btn-row">
              <input
                className="input"
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
                placeholder="https://... or path/to/binary"
              />
              <button
                type="button"
                className="btn small"
                disabled={busy || endpoint === provider.binaryOrEndpoint}
                onClick={() => save({ binaryOrEndpoint: endpoint })}
              >
                Save
              </button>
            </div>
          </label>

          <div className="grid-2" style={{ gap: 8 }}>
            <label className="field">
              <span>Fallback Provider</span>
              <select
                className="select"
                value={provider.fallbackAccountId ?? ""}
                onChange={(e) => save({ fallbackAccountId: e.target.value || null })}
              >
                <option value="">None</option>
                {options
                  .filter((item) => item.id !== provider.id)
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
              </select>
            </label>

            <div className="field">
              <span>CLI Dispatch</span>
              <button
                type="button"
                className={`btn ghost small toggle-state-btn ${provider.allowCliDispatch ? "on" : ""}`}
                onClick={() => save({ allowCliDispatch: !provider.allowCliDispatch })}
              >
                {provider.allowCliDispatch ? "Enabled (On)" : "Disabled (Off)"}
              </button>
            </div>
          </div>

          <label className="field">
            <span>{provider.hasSecret ? "Update API Key" : "Set API Key"}</span>
            <div className="input-btn-row">
              <div className="password-wrap">
                <input
                  className="input"
                  type={showSecret ? "text" : "password"}
                  value={secret}
                  placeholder={provider.hasSecret ? "Key stored locally. Enter new key to replace." : "Paste API key"}
                  onChange={(e) => setSecret(e.target.value)}
                />
                <button
                  type="button"
                  className="eye-btn"
                  onClick={() => setShowSecret((s) => !s)}
                  title={showSecret ? "Hide" : "Show"}
                >
                  {showSecret ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
              <button
                type="button"
                className="btn small"
                disabled={busy || !secret.trim()}
                onClick={() => {
                  void run("set_provider_secret", { id: provider.id, secret });
                  setSecret("");
                }}
              >
                Save key
              </button>
            </div>
          </label>

          <div className="drawer-foot between">
            <span className="muted faint-text">Status: {provider.isActive ? "Active in workspace" : "Paused"}</span>
            <button
              type="button"
              className="btn ghost small"
              onClick={() => save({ isActive: !provider.isActive })}
            >
              {provider.isActive ? "Pause provider" : "Activate provider"}
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

// -------------------------------------------------------------
// Component: Connected App Card (Active Installed App)
// -------------------------------------------------------------
function ConnectedAppCard({ app, onBrowse }: { app: LinkedApp; onBrowse: () => void }) {
  const run = useOmni((s) => s.run);
  const busy = useOmni((s) => s.busy);
  const isRunning = Boolean(app.activePid);

  return (
    <article className="connected-card stack app-card">
      <div className="card-top between">
        <div className="brand-badge-group">
          <AppLogo id={app.id} name={app.appName} url={app.executablePath} size={38} />
          <div>
            <div className="brand-name-row">
              <strong>{app.appName}</strong>
              <span className="type-badge">{app.category || "Desktop App"}</span>
            </div>
            <div className="health-line">
              <i className="status-dot ok" />
              <span>{isRunning ? `Running (pid ${app.activePid})` : "Found on computer"}</span>
            </div>
          </div>
        </div>
        <Pill kind="ok">{isRunning ? "Running" : "Installed"}</Pill>
      </div>

      <div className="endpoint-bar" title={app.executablePath}>
        <span className="endpoint-text mono">{app.executablePath}</span>
      </div>

      <div className="card-actions-row between">
        <div className="left-actions">
          {isRunning ? (
            <button
              type="button"
              className="btn ghost small danger-text"
              disabled={busy}
              onClick={() => void run("fleet_action", { appId: app.id, action: "stop" })}
            >
              <Square size={12} /> Stop process
            </button>
          ) : (
            <button
              type="button"
              className="btn small"
              disabled={busy}
              onClick={() => void run("fleet_action", { appId: app.id, action: "start" })}
            >
              <Play size={12} /> Launch
            </button>
          )}
        </div>
        <button type="button" className="btn ghost small" disabled={busy} onClick={onBrowse}>
          <FolderOpen size={13} /> Change path
        </button>
      </div>
    </article>
  );
}

// -------------------------------------------------------------
// Component: Waiting Provider Card (Setup Catalog Style)
// -------------------------------------------------------------
function WaitingProviderCard({ provider, options }: { provider: Provider; options: Provider[] }) {
  const run = useOmni((s) => s.run);
  const go = useOmni((s) => s.go);
  const busy = useOmni((s) => s.busy);

  const [secret, setSecret] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [endpoint, setEndpoint] = useState(provider.binaryOrEndpoint);

  const isWeb = provider.providerType === "official_oauth" || provider.providerType === "isolated_webview";
  const isOllama = provider.providerType === "local_ollama";
  const isCli = provider.providerType === "cli_subprocess";
  const isApi = provider.providerType === "byok_api";

  const installUrl = INSTALLS[provider.id];

  function save(patch: Partial<Provider>) {
    void run("update_provider", {
      patch: {
        id: provider.id,
        quotaUsedPercent: provider.quotaUsedPercent,
        fallbackAccountId: provider.fallbackAccountId,
        isActive: provider.isActive,
        allowCliDispatch: provider.allowCliDispatch,
        binaryOrEndpoint: endpoint,
        quotaResetsAt: provider.quotaResetsAt,
        ...patch,
      },
    });
  }

  async function handleConnectKey() {
    if (!secret.trim()) return;
    await run("set_provider_secret", { id: provider.id, secret });
    setSecret("");
    void run("test_provider", { id: provider.id });
  }

  return (
    <article className="catalog-card stack">
      <div className="catalog-top between">
        <div className="brand-badge-group">
          <AppLogo id={provider.id} name={provider.name} url={provider.binaryOrEndpoint} size={38} />
          <div>
            <div className="brand-name-row">
              <strong>{provider.name}</strong>
              <span className="type-badge">{getProviderTypeLabel(provider.providerType)}</span>
            </div>
            <span className="catalog-sub">{provider.healthDetail || "Needs setup to connect"}</span>
          </div>
        </div>
        <Pill kind="warn">
          {isApi ? "Needs API Key" : isOllama ? "Not Running" : isWeb ? "Not Signed In" : "Not Installed"}
        </Pill>
      </div>

      <p className="catalog-desc muted">
        {isApi
          ? `Provide your ${provider.name} API key to enable fast completion, chat models, and reasoning.`
          : isOllama
          ? "Start Ollama on your system to run local open-weights models offline with full privacy."
          : isWeb
          ? `Sign in with your ${provider.name} account to inspect and dispatch through workspace browser tabs.`
          : `Link or install the ${provider.name} executable on your computer to dispatch via terminal.`}
      </p>

      {/* Action Zone */}
      <div className="catalog-action-box">
        {isApi ? (
          <div className="api-connect-form">
            <div className="password-wrap">
              <input
                className="input small-input"
                type={showSecret ? "text" : "password"}
                placeholder={`Paste ${provider.name} API key (sk-...)`}
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleConnectKey();
                }}
              />
              <button
                type="button"
                className="eye-btn"
                onClick={() => setShowSecret((s) => !s)}
                title={showSecret ? "Hide" : "Show"}
              >
                {showSecret ? <EyeOff size={13} /> : <Eye size={13} />}
              </button>
            </div>
            <div className="row-actions" style={{ marginTop: 8 }}>
              <button
                type="button"
                className="btn small primary-highlight"
                disabled={busy || !secret.trim()}
                onClick={() => void handleConnectKey()}
              >
                Save & Connect
              </button>
              <button
                type="button"
                className="btn ghost small"
                disabled={busy}
                onClick={() => void run("test_provider", { id: provider.id })}
              >
                Test ping
              </button>
            </div>
          </div>
        ) : isWeb ? (
          <div className="row-actions">
            <button
              type="button"
              className="btn small"
              onClick={() => {
                sessionStorage.setItem("omni.focusHarness", provider.id);
                go("chat");
              }}
            >
              Sign in / Open in workspace
            </button>
          </div>
        ) : isOllama ? (
          <div className="row-actions">
            {installUrl ? (
              <a href={installUrl} target="_blank" rel="noreferrer" className="btn ghost small link-btn">
                Download Ollama <ExternalLink size={12} />
              </a>
            ) : null}
            <button
              type="button"
              className="btn small"
              disabled={busy}
              onClick={() => void run("test_provider", { id: provider.id })}
            >
              Check if running
            </button>
          </div>
        ) : isCli ? (
          <div className="row-actions">
            <button
              type="button"
              className="btn small"
              disabled={busy}
              onClick={() => {
                void pickPaths("program").then((paths) => {
                  const path = paths[0];
                  if (!path) return;
                  setEndpoint(path);
                  save({ binaryOrEndpoint: path, allowCliDispatch: true });
                });
              }}
            >
              <FolderOpen size={13} /> Browse binary (.exe)
            </button>
            {installUrl ? (
              <a href={installUrl} target="_blank" rel="noreferrer" className="btn ghost small link-btn">
                Install Guide <ExternalLink size={12} />
              </a>
            ) : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}

// -------------------------------------------------------------
// Component: Missing App Card (Catalog Style)
// -------------------------------------------------------------
function MissingAppCard({ app, onBrowse }: { app: LinkedApp; onBrowse: () => void }) {
  const installUrl = INSTALLS[app.id];

  return (
    <article className="catalog-card stack">
      <div className="catalog-top between">
        <div className="brand-badge-group">
          <AppLogo id={app.id} name={app.appName} url={app.executablePath} size={38} />
          <div>
            <div className="brand-name-row">
              <strong>{app.appName}</strong>
              <span className="type-badge">{app.category || "Desktop App"}</span>
            </div>
            <span className="catalog-sub">{app.detail || "Not found on system"}</span>
          </div>
        </div>
        <Pill kind="warn">Not Installed</Pill>
      </div>

      <p className="catalog-desc muted">
        Link the executable location for {app.appName} so your bots can launch and orchestrate this tool.
      </p>

      <div className="catalog-action-box">
        <div className="row-actions">
          <button type="button" className="btn small" onClick={onBrowse}>
            <FolderOpen size={13} /> Browse for program (.exe)
          </button>
          {installUrl ? (
            <a href={installUrl} target="_blank" rel="noreferrer" className="btn ghost small link-btn">
              Download <ExternalLink size={12} />
            </a>
          ) : null}
        </div>
      </div>
    </article>
  );
}

// -------------------------------------------------------------
// Component: Connect New Provider or App Modal
// -------------------------------------------------------------
function ConnectNewModal({
  initialTab,
  onClose,
}: {
  initialTab: "provider" | "app";
  onClose: () => void;
}) {
  const run = useOmni((s) => s.run);
  const busy = useOmni((s) => s.busy);

  const [activeTab, setActiveTab] = useState<"provider" | "app">(initialTab);

  // Provider Form State
  const [provName, setProvName] = useState("");
  const [provType, setProvType] = useState<ProviderType>("byok_api");
  const [provEndpoint, setProvEndpoint] = useState("");
  const [provKey, setProvKey] = useState("");
  const [showKey, setShowKey] = useState(false);

  // App Form State
  const [appName, setAppName] = useState("");
  const [appCat, setAppCat] = useState("editor");
  const [appPath, setAppPath] = useState("");

  const types: { value: ProviderType; label: string }[] = [
    { value: "byok_api", label: "External API (OpenAI-compatible / BYOK)" },
    { value: "local_ollama", label: "Local Ollama" },
    { value: "cli_subprocess", label: "CLI / Local Binary" },
    { value: "isolated_webview", label: "Web App (Site window)" },
    { value: "official_oauth", label: "Official OAuth" },
  ];

  const appCategories = [
    { value: "editor", label: "Code Editor / IDE" },
    { value: "terminal", label: "Terminal / Shell" },
    { value: "browser", label: "Web Browser" },
    { value: "notes", label: "Notes & Docs" },
    { value: "tools", label: "Developer Tools" },
  ];

  function applyPreset(preset: typeof PRESETS[0]) {
    setProvName(preset.name);
    setProvType(preset.type);
    setProvEndpoint(preset.endpoint);
  }

  function handleAddProvider() {
    const name = provName.trim();
    if (!name) return;
    const rawId = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    const id = `prov_${rawId || Date.now()}`;
    void run("add_provider", {
      id,
      name,
      providerType: provType,
      binaryOrEndpoint: provEndpoint.trim(),
      apiKey: provKey.trim() || undefined,
    });
    onClose();
  }

  function handleAddApp() {
    const name = appName.trim();
    if (!name) return;
    const rawId = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    const id = `app_${rawId || Date.now()}`;
    void run("add_app", {
      id,
      name,
      category: appCat,
      executablePath: appPath.trim(),
    });
    onClose();
  }

  function browseForExecutable() {
    void pickPaths("program").then((paths) => {
      if (paths[0]) setAppPath(paths[0]);
    });
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="add-provider-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head between">
          <div>
            <strong>Connect new app or provider</strong>
            <p className="muted" style={{ margin: "2px 0 0", fontSize: "12.5px" }}>
              Add a custom LLM provider endpoint or link an installed desktop application.
            </p>
          </div>
          <button type="button" className="screen-x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        {/* Modal Tabs */}
        <div className="modal-tabs">
          <button
            type="button"
            className={`modal-tab-btn ${activeTab === "provider" ? "active" : ""}`}
            onClick={() => setActiveTab("provider")}
          >
            <Sparkles size={15} /> AI Provider / API
          </button>
          <button
            type="button"
            className={`modal-tab-btn ${activeTab === "app" ? "active" : ""}`}
            onClick={() => setActiveTab("app")}
          >
            <AppWindow size={15} /> Desktop / CLI App
          </button>
        </div>

        <div className="modal-body stack">
          {activeTab === "provider" ? (
            <>
              {/* Presets Row */}
              <div className="presets-box">
                <span className="presets-label">Popular Presets:</span>
                <div className="presets-wrap">
                  {PRESETS.map((preset) => (
                    <button
                      key={preset.name}
                      type="button"
                      className="preset-chip"
                      onClick={() => applyPreset(preset)}
                      title={preset.hint}
                    >
                      {preset.name}
                    </button>
                  ))}
                </div>
              </div>

              {/* Live Provider Logo / Favicon Preview */}
              <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", background: "rgba(0,0,0,0.03)", borderRadius: 8, border: "1px solid rgba(0,0,0,0.08)" }}>
                <AppLogo id={provName} name={provName} url={provEndpoint} size={36} />
                <div style={{ fontSize: 12 }}>
                  <div style={{ fontWeight: 600, color: "#1e293b" }}>{provName.trim() ? provName : "Provider Preview"}</div>
                  <div style={{ fontSize: 11, color: "#64748b" }}>
                    {provEndpoint.trim() && provEndpoint.startsWith("http")
                      ? `Auto-resolves website favicon from ${provEndpoint}`
                      : "Official vector logo, CLI icon, or monogram"}
                  </div>
                </div>
              </div>

              <div className="grid-2" style={{ gap: 12 }}>
                <label className="field">
                  <span>Provider name</span>
                  <input
                    className="input"
                    placeholder="e.g. Groq, LM Studio, vLLM"
                    value={provName}
                    onChange={(e) => setProvName(e.target.value)}
                  />
                </label>
                <label className="field">
                  <span>Kind / Protocol</span>
                  <select
                    className="select"
                    value={provType}
                    onChange={(e) => setProvType(e.target.value as ProviderType)}
                  >
                    {types.map((item) => (
                      <option key={item.value} value={item.value}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <label className="field">
                <span>Base URL or binary path</span>
                <input
                  className="input"
                  placeholder="https://api.groq.com/openai/v1 or https://api.together.xyz/v1"
                  value={provEndpoint}
                  onChange={(e) => setProvEndpoint(e.target.value)}
                />
              </label>

              {provType === "byok_api" && (
                <label className="field">
                  <span>API Key (Optional — can paste later)</span>
                  <div className="password-wrap">
                    <input
                      className="input"
                      type={showKey ? "text" : "password"}
                      placeholder="sk-..."
                      value={provKey}
                      onChange={(e) => setProvKey(e.target.value)}
                    />
                    <button
                      type="button"
                      className="eye-btn"
                      onClick={() => setShowKey((s) => !s)}
                      title={showKey ? "Hide" : "Show"}
                    >
                      {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                </label>
              )}

              <p className="muted faint-text">
                Ronic OS supports any OpenAI-compatible API endpoint. After connecting, run Test ping to verify.
              </p>

              <div className="modal-foot row-actions">
                <button type="button" className="btn ghost small" onClick={onClose}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn small primary-highlight"
                  disabled={busy || !provName.trim()}
                  onClick={handleAddProvider}
                >
                  Connect Provider
                </button>
              </div>
            </>
          ) : (
            <>
              {/* Live App Logo Preview */}
              <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", background: "rgba(0,0,0,0.03)", borderRadius: 8, border: "1px solid rgba(0,0,0,0.08)" }}>
                <AppLogo id={appName} name={appName} url={appPath} size={36} />
                <div style={{ fontSize: 12 }}>
                  <div style={{ fontWeight: 600, color: "#1e293b" }}>{appName.trim() ? appName : "App Logo Preview"}</div>
                  <div style={{ fontSize: 11, color: "#64748b" }}>
                    {appCat ? `${appCat} application` : "Desktop or CLI tool icon"}
                  </div>
                </div>
              </div>

              <div className="grid-2" style={{ gap: 12 }}>
                <label className="field">
                  <span>App Name</span>
                  <input
                    className="input"
                    placeholder="e.g. VS Code Insiders, Postman, Warp"
                    value={appName}
                    onChange={(e) => setAppName(e.target.value)}
                  />
                </label>
                <label className="field">
                  <span>Category</span>
                  <select
                    className="select"
                    value={appCat}
                    onChange={(e) => setAppCat(e.target.value)}
                  >
                    {appCategories.map((item) => (
                      <option key={item.value} value={item.value}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <label className="field">
                <span>Executable Path (.exe or binary)</span>
                <div className="input-btn-row">
                  <input
                    className="input"
                    placeholder="C:\Users\...\app.exe"
                    value={appPath}
                    onChange={(e) => setAppPath(e.target.value)}
                  />
                  <button type="button" className="btn small" onClick={browseForExecutable}>
                    <FolderOpen size={14} /> Browse...
                  </button>
                </div>
              </label>

              <p className="muted faint-text">
                Browse to any application executable on this machine to make it launchable and inspectable by bot coworkers.
              </p>

              <div className="modal-foot row-actions">
                <button type="button" className="btn ghost small" onClick={onClose}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn small primary-highlight"
                  disabled={busy || !appName.trim()}
                  onClick={handleAddApp}
                >
                  Add App & Link
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// =============================================================
// Memory Vault & Fleet (Preserved from original implementation)
// =============================================================
const ENGINE_ORDER = ["mem0_builtin", "zep_graphiti", "cognee", "letta", "obsidian_khoj"];

import BotFleetMissionControl from "../components/BotFleetMissionControl";

export { BotFleetMissionControl as Fleet };
