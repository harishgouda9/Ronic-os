import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
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
} from "lucide-react";
import { pickPaths } from "../api";
import type { LinkedApp, Provider, ProviderType } from "../types";
import { useRonic } from "../store";
import { Pill } from "../ui/bits";
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

/* ── Marketplace design-system atoms ─────────────────────────────── */

function Chip({ children, tone = "slate" }: { children: ReactNode; tone?: "slate" | "emerald" | "amber" | "rose" | "blue" | "purple" }) {
  const tones: Record<string, string> = {
    slate: "bg-slate-100 text-slate-700 border-slate-200",
    emerald: "bg-emerald-50 text-emerald-700 border-emerald-200/80",
    amber: "bg-amber-50 text-amber-700 border-amber-200/80",
    rose: "bg-rose-50 text-rose-700 border-rose-200/80",
    blue: "bg-blue-50 text-blue-700 border-blue-200/80",
    purple: "bg-purple-50 text-purple-700 border-purple-200/80",
  };
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full border shrink-0 ${tones[tone]}`}>
      {children}
    </span>
  );
}

const inputCls =
  "w-full px-3.5 py-2.5 text-xs bg-slate-50/70 hover:bg-white focus:bg-white border border-slate-200 rounded-xl text-slate-800 outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-900/5 transition-all";

export function Providers() {
  const snap = useRonic((s) => s.snap)!;
  const run = useRonic((s) => s.run);
  const busy = useRonic((s) => s.busy);

  const [modalOpen, setModalOpen] = useState(false);
  const [modalTab, setModalTab] = useState<"provider" | "app">("provider");
  const [connectedFilter, setConnectedFilter] = useState<"all" | "providers" | "apps">("all");
  const [catalogFilter, setCatalogFilter] = useState<"all" | "api" | "cli" | "web" | "apps">("all");
  const [searchQuery, setSearchQuery] = useState("");

  const connectedProviders = useMemo(() => snap.providers.filter(isProviderConnected), [snap.providers]);
  const connectedApps = useMemo(() => snap.apps.filter(isAppInstalled), [snap.apps]);
  const waitingProviders = useMemo(() => snap.providers.filter((p) => !isProviderConnected(p)), [snap.providers]);
  const missingApps = useMemo(() => snap.apps.filter((a) => !isAppInstalled(a)), [snap.apps]);

  const totalConnected = connectedProviders.length + connectedApps.length;
  const totalWaiting = waitingProviders.length + missingApps.length;

  function openAdd(tab: "provider" | "app" = "provider") {
    setModalTab(tab);
    setModalOpen(true);
  }

  const browseForApp = useCallback(
    (appId: string) => {
      void pickPaths("program").then((paths) => {
        if (paths[0]) void run("set_app_path", { appId, path: paths[0] });
      });
    },
    [run]
  );

  const query = searchQuery.trim().toLowerCase();

  const filteredConnectedProviders = useMemo(
    () =>
      connectedProviders.filter(
        (p) => !query || p.name.toLowerCase().includes(query) || p.binaryOrEndpoint.toLowerCase().includes(query)
      ),
    [connectedProviders, query]
  );
  const filteredConnectedApps = useMemo(
    () =>
      connectedApps.filter(
        (a) => !query || a.appName.toLowerCase().includes(query) || a.executablePath.toLowerCase().includes(query)
      ),
    [connectedApps, query]
  );

  const filteredWaitingProviders = useMemo(
    () =>
      waitingProviders.filter((p) => {
        if (catalogFilter === "api" && p.providerType !== "byok_api") return false;
        if (catalogFilter === "cli" && p.providerType !== "cli_subprocess" && p.providerType !== "local_ollama") return false;
        if (catalogFilter === "web" && p.providerType !== "official_oauth" && p.providerType !== "isolated_webview") return false;
        if (catalogFilter === "apps") return false;
        if (query && !p.name.toLowerCase().includes(query) && !p.binaryOrEndpoint.toLowerCase().includes(query)) return false;
        return true;
      }),
    [waitingProviders, catalogFilter, query]
  );

  const filteredMissingApps = useMemo(
    () =>
      missingApps.filter((a) => {
        if (catalogFilter === "api" || catalogFilter === "cli" || catalogFilter === "web") return false;
        if (query && !a.appName.toLowerCase().includes(query) && !(a.detail || "").toLowerCase().includes(query)) return false;
        return true;
      }),
    [missingApps, catalogFilter, query]
  );

  return (
    <div className="flex-1 h-full bg-[#eceef2] p-3 sm:p-5 lg:p-6 overflow-y-auto select-none flex flex-col">
      <div className="w-full max-w-[1560px] flex-1 min-h-[660px] bg-white rounded-3xl shadow-[0_12px_40px_-8px_rgba(0,0,0,0.06),0_2px_8px_-1px_rgba(0,0,0,0.03)] border border-slate-200/70 flex flex-col mx-auto overflow-hidden transition-all duration-300">

        {/* ─── HEADER ─── */}
        <div className="p-5 sm:p-7 pb-3.5 space-y-4 border-b border-slate-100">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="min-w-0">
              <div className="flex items-center gap-2.5 flex-wrap">
                <h1 className="text-lg sm:text-xl font-bold text-slate-900 tracking-tight">Apps &amp; providers</h1>
                <Chip tone={totalConnected > 0 ? "emerald" : "amber"}>
                  <span className={`w-1.5 h-1.5 rounded-full ${totalConnected > 0 ? "bg-emerald-500" : "bg-amber-500"}`} />
                  {totalConnected} CONNECTED
                </Chip>
                <Chip tone={totalWaiting > 0 ? "amber" : "slate"}>{totalWaiting} WAITING</Chip>
              </div>
              <p className="text-xs text-slate-500 mt-1.5 max-w-2xl leading-relaxed">
                Manage active AI models, APIs, and computer apps. Connect new providers and desktop executables to equip your bot team.
              </p>
            </div>
            <div className="shrink-0 flex items-center gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void run("scan_environment")}
                title="Scan system PATH for local CLI tools"
                className="text-xs font-semibold px-3.5 py-2 rounded-full border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 hover:text-slate-900 transition-all cursor-pointer active:scale-95 disabled:opacity-40"
              >
                Scan PATH
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void run("link_apps")}
                title="Auto-link detected apps"
                className="text-xs font-semibold px-3.5 py-2 rounded-full border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 hover:text-slate-900 transition-all cursor-pointer active:scale-95 disabled:opacity-40"
              >
                Link detected
              </button>
              <button
                type="button"
                onClick={() => openAdd("provider")}
                className="text-xs font-semibold px-3.5 py-2 rounded-full bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700/50 shadow-xs transition-all cursor-pointer active:scale-95 disabled:opacity-40 flex items-center gap-1.5"
              >
                <Plus size={12} /> Connect new
              </button>
            </div>
          </div>

          {/* ─── CONNECTED FILTER TABS ─── */}
          <div className="flex items-center gap-2 overflow-x-auto pb-1 no-scrollbar pt-1 flex-wrap">
            <button
              type="button"
              role="tab"
              aria-selected={connectedFilter === "all"}
              onClick={() => setConnectedFilter("all")}
              className={`shrink-0 px-3.5 py-1.5 text-xs font-semibold rounded-full transition-all cursor-pointer ${
                connectedFilter === "all"
                  ? "bg-zinc-800 text-white shadow-xs"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200/70 hover:text-slate-800"
              }`}
            >
              All ({totalConnected})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={connectedFilter === "providers"}
              onClick={() => setConnectedFilter("providers")}
              className={`shrink-0 px-3.5 py-1.5 text-xs font-semibold rounded-full transition-all cursor-pointer ${
                connectedFilter === "providers"
                  ? "bg-zinc-800 text-white shadow-xs"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200/70 hover:text-slate-800"
              }`}
            >
              AI Providers ({connectedProviders.length})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={connectedFilter === "apps"}
              onClick={() => setConnectedFilter("apps")}
              className={`shrink-0 px-3.5 py-1.5 text-xs font-semibold rounded-full transition-all cursor-pointer ${
                connectedFilter === "apps"
                  ? "bg-zinc-800 text-white shadow-xs"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200/70 hover:text-slate-800"
              }`}
            >
              Desktop Apps ({connectedApps.length})
            </button>
          </div>
        </div>

        {/* ─── BODY ─── */}
        <div className="flex-1 overflow-y-auto px-5 sm:px-7 py-5 space-y-7">

          {/* CONNECTED */}
          <div className="space-y-2">
            <div className="flex items-center justify-between px-2">
              <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400">Connected</h2>
              <Chip tone={totalConnected > 0 ? "emerald" : "slate"}>{totalConnected} ready</Chip>
            </div>
            {totalConnected > 0 ? (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
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
              <div className="bg-slate-50/50 rounded-3xl p-1.5 border border-slate-100/80">
                <div className="py-14 text-center space-y-3">
                  <div className="w-12 h-12 mx-auto rounded-2xl bg-slate-100 border border-slate-200 flex items-center justify-center text-slate-400">
                    <Layers size={20} />
                  </div>
                  <p className="text-sm font-semibold text-slate-700">Nothing is connected yet</p>
                  <p className="text-xs text-slate-400 max-w-sm mx-auto">Connect an AI provider using an API key below, or scan this computer for installed CLI tools.</p>
                  <div className="flex items-center justify-center gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => openAdd("provider")}
                      className="text-xs font-semibold px-3.5 py-1.5 rounded-full bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700/50 shadow-xs transition-all cursor-pointer active:scale-95 flex items-center gap-1.5"
                    >
                      <Plus size={11} /> Connect new provider
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void run("scan_environment")}
                      className="text-xs font-semibold px-3.5 py-1.5 rounded-full border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 transition-all cursor-pointer active:scale-95 disabled:opacity-40"
                    >
                      Scan computer
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* NOT CONNECTED */}
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3 px-2 flex-wrap">
              <div>
                <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400">Not connected</h2>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  Paste an API key, sign in, or browse to a program to link these tools into Ronic OS.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Chip tone={totalWaiting > 0 ? "amber" : "slate"}>{totalWaiting} available</Chip>
                <div className="relative">
                  <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Filter available…"
                    className="pl-8 pr-8 py-1.5 text-xs bg-slate-50/70 hover:bg-white focus:bg-white border border-slate-200 rounded-full text-slate-800 placeholder:text-slate-400 outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-900/5 transition-all w-44"
                  />
                  {searchQuery ? (
                    <button
                      type="button"
                      onClick={() => setSearchQuery("")}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 transition-colors"
                    >
                      ×
                    </button>
                  ) : null}
                </div>
              </div>
            </div>

            {/* catalog filter tabs */}
            <div className="flex items-center gap-2 overflow-x-auto pb-1 no-scrollbar px-2 flex-wrap">
              {(
                [
                  ["all", `All Available (${totalWaiting})`],
                  ["api", `AI Models & APIs (${waitingProviders.filter((p) => p.providerType === "byok_api").length})`],
                  ["cli", `CLI & Local (${waitingProviders.filter((p) => p.providerType === "cli_subprocess" || p.providerType === "local_ollama").length})`],
                  ["web", `Web Apps (${waitingProviders.filter((p) => p.providerType === "official_oauth" || p.providerType === "isolated_webview").length})`],
                  ["apps", `Desktop Apps (${missingApps.length})`],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setCatalogFilter(id)}
                  className={`shrink-0 px-3.5 py-1.5 text-xs font-semibold rounded-full transition-all cursor-pointer ${
                    catalogFilter === id
                      ? "bg-zinc-800 text-white shadow-xs"
                      : "bg-slate-100 text-slate-600 hover:bg-slate-200/70 hover:text-slate-800"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {filteredWaitingProviders.map((provider) => (
                <WaitingProviderCard key={provider.id} provider={provider} options={snap.providers} />
              ))}
              {filteredMissingApps.map((app) => (
                <MissingAppCard key={app.id} app={app} onBrowse={() => browseForApp(app.id)} />
              ))}
              {/* add custom */}
              <button
                type="button"
                onClick={() => openAdd("provider")}
                className="bg-white border-2 border-dashed border-slate-200 rounded-2xl p-5 shadow-xs hover:border-slate-400 hover:shadow-md transition-all flex flex-col items-center justify-center gap-2.5 text-center min-h-[180px] group"
              >
                <span className="w-10 h-10 rounded-full bg-slate-100 border border-slate-200 flex items-center justify-center text-slate-500 group-hover:bg-zinc-800 group-hover:text-white group-hover:border-zinc-700 transition-all">
                  <Plus size={18} />
                </span>
                <span className="text-sm font-bold text-slate-800">Connect New Provider or App</span>
                <span className="text-[11px] text-slate-400 max-w-xs leading-relaxed">
                  Add any custom OpenAI-compatible API endpoint, local model server, or desktop application.
                </span>
                <span className="text-xs font-semibold px-3.5 py-1.5 rounded-full border border-slate-200 bg-white text-slate-700 group-hover:bg-zinc-800 group-hover:text-white transition-all">
                  + Add Custom
                </span>
              </button>
            </div>

            {filteredWaitingProviders.length === 0 && filteredMissingApps.length === 0 && (
              <div className="bg-slate-50/50 rounded-3xl p-1.5 border border-slate-100/80">
                <div className="py-10 text-center space-y-1.5">
                  <p className="text-sm font-semibold text-slate-700">No matching tools found</p>
                  <p className="text-xs text-slate-400">Try clearing your search for “{searchQuery}”.</p>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ─── FOOTER STATUS BAR ─── */}
        <div className="px-6 py-3 bg-slate-50 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500">
          <div className="flex items-center gap-2 truncate pr-4">
            <span className={`w-2 h-2 rounded-full shrink-0 ${totalConnected > 0 ? "bg-emerald-500" : "bg-slate-300"}`} />
            <span className="truncate">
              {totalConnected > 0
                ? `${totalConnected} connected · keys live in the encrypted local vault`
                : "Connect a provider or scan this computer to get started"}
            </span>
          </div>
          <div className="shrink-0 flex items-center gap-3 text-[11px] font-medium text-slate-400">
            <span className="font-mono">{totalWaiting} waiting</span>
          </div>
        </div>
      </div>

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
// Component: Connected Provider Card
// -------------------------------------------------------------
function ConnectedProviderCard({ provider, options }: { provider: Provider; options: Provider[] }) {
  const run = useRonic((s) => s.run);
  const go = useRonic((s) => s.go);
  const busy = useRonic((s) => s.busy);

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
    <article className="bg-white border border-slate-200/80 rounded-2xl p-4 shadow-xs hover:shadow-md hover:border-slate-300 transition-all space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-3 min-w-0">
          <AppLogo id={provider.id} name={provider.name} url={provider.binaryOrEndpoint} size={40} />
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-bold text-slate-900 truncate">{provider.name}</span>
              <span className="text-[9.5px] font-bold px-1.5 py-0.5 rounded-md bg-slate-100 text-slate-600 border border-slate-200 shrink-0">
                {getProviderTypeLabel(provider.providerType)}
              </span>
            </div>
            <p className="text-[11px] text-slate-500 mt-0.5 flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
              {provider.hasSecret ? "Key stored" : provider.healthDetail || "Ready"}
            </p>
          </div>
        </div>
        <Pill kind={provider.isActive ? "ok" : "warn"}>{provider.isActive ? "Ready" : "Paused"}</Pill>
      </div>

      {endpoint ? (
        <div className="flex items-center gap-1.5 bg-slate-50/70 border border-slate-100 rounded-xl px-2.5 py-1.5" title={endpoint}>
          <span className="text-[11px] font-mono text-slate-600 truncate flex-1">{endpoint}</span>
          <button
            type="button"
            onClick={copyPath}
            title={copied ? "Copied!" : "Copy endpoint"}
            className="shrink-0 w-6 h-6 rounded-lg flex items-center justify-center text-slate-400 hover:text-slate-700 hover:bg-white transition-all"
          >
            {copied ? <Check size={11} className="text-emerald-600" /> : <Copy size={11} />}
          </button>
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            disabled={busy}
            onClick={() => void run("test_provider", { id: provider.id })}
            title="Send a quick ping to test latency and validity"
            className="text-[11px] font-semibold px-3 py-1.5 rounded-full border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 transition-all cursor-pointer active:scale-95 disabled:opacity-40"
          >
            Test ping
          </button>
          {isWeb ? (
            <button
              type="button"
              onClick={() => {
                sessionStorage.setItem("ronic.focusHarness", provider.id);
                go("chat");
              }}
              className="text-[11px] font-semibold px-3 py-1.5 rounded-full border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 transition-all cursor-pointer active:scale-95"
            >
              Open in workspace
            </button>
          ) : null}
        </div>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((prev) => !prev)}
          className="text-[11px] font-semibold px-3 py-1.5 rounded-full border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 transition-all cursor-pointer active:scale-95 flex items-center gap-1"
        >
          {open ? "Hide" : "Manage"} <ChevronDown size={12} className={open ? "rotate-180 transition-transform" : "transition-transform"} />
        </button>
      </div>

      {open && (
        <div className="border-t border-slate-100 pt-3 space-y-3">
          <label className="space-y-1 block">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Endpoint or Binary</span>
            <div className="flex items-center gap-1.5">
              <input
                className={inputCls}
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
                placeholder="https://... or path/to/binary"
              />
              <button
                type="button"
                disabled={busy || endpoint === provider.binaryOrEndpoint}
                onClick={() => save({ binaryOrEndpoint: endpoint })}
                className="shrink-0 text-[11px] font-semibold px-3 py-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700/50 shadow-xs transition-all cursor-pointer active:scale-95 disabled:opacity-40"
              >
                Save
              </button>
            </div>
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1">
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Fallback Provider</span>
              <select
                className={inputCls}
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

            <label className="space-y-1">
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">CLI Dispatch</span>
              <button
                type="button"
                onClick={() => save({ allowCliDispatch: !provider.allowCliDispatch })}
                className={`w-full text-[11px] font-semibold px-3 py-2.5 rounded-xl border transition-all cursor-pointer active:scale-95 ${
                  provider.allowCliDispatch
                    ? "bg-emerald-50 text-emerald-700 border-emerald-200/80"
                    : "bg-slate-50/70 text-slate-600 border-slate-200 hover:bg-white"
                }`}
              >
                {provider.allowCliDispatch ? "Enabled" : "Disabled"}
              </button>
            </label>
          </div>

          <label className="space-y-1 block">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{provider.hasSecret ? "Update API Key" : "Set API Key"}</span>
            <div className="flex items-center gap-1.5">
              <div className="relative flex-1">
                <input
                  className={inputCls + " pr-9"}
                  type={showSecret ? "text" : "password"}
                  value={secret}
                  placeholder={provider.hasSecret ? "Key stored locally. Enter new key to replace." : "Paste API key"}
                  onChange={(e) => setSecret(e.target.value)}
                />
                <button
                  type="button"
                  onClick={() => setShowSecret((s) => !s)}
                  title={showSecret ? "Hide" : "Show"}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 transition-colors"
                >
                  {showSecret ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
              </div>
              <button
                type="button"
                disabled={busy || !secret.trim()}
                onClick={() => {
                  void run("set_provider_secret", { id: provider.id, secret });
                  setSecret("");
                }}
                className="shrink-0 text-[11px] font-semibold px-3 py-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700/50 shadow-xs transition-all cursor-pointer active:scale-95 disabled:opacity-40"
              >
                Save key
              </button>
            </div>
          </label>

          <div className="flex items-center justify-between gap-2 pt-1">
            <span className="text-[11px] text-slate-400">Status: {provider.isActive ? "Active in workspace" : "Paused"}</span>
            <button
              type="button"
              onClick={() => save({ isActive: !provider.isActive })}
              className="text-[11px] font-semibold px-3 py-1.5 rounded-full border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 transition-all cursor-pointer active:scale-95"
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
// Component: Connected App Card
// -------------------------------------------------------------
function ConnectedAppCard({ app, onBrowse }: { app: LinkedApp; onBrowse: () => void }) {
  const run = useRonic((s) => s.run);
  const busy = useRonic((s) => s.busy);
  const isRunning = Boolean(app.activePid);

  return (
    <article className="bg-white border border-slate-200/80 rounded-2xl p-4 shadow-xs hover:shadow-md hover:border-slate-300 transition-all space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-3 min-w-0">
          <AppLogo id={app.id} name={app.appName} url={app.executablePath} size={40} />
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-bold text-slate-900 truncate">{app.appName}</span>
              <span className="text-[9.5px] font-bold px-1.5 py-0.5 rounded-md bg-slate-100 text-slate-600 border border-slate-200 shrink-0">
                {app.category || "Desktop App"}
              </span>
            </div>
            <p className="text-[11px] text-slate-500 mt-0.5 flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
              {isRunning ? `Running (pid ${app.activePid})` : "Found on computer"}
            </p>
          </div>
        </div>
        <Pill kind="ok">{isRunning ? "Running" : "Installed"}</Pill>
      </div>

      <div className="flex items-center gap-1.5 bg-slate-50/70 border border-slate-100 rounded-xl px-2.5 py-1.5" title={app.executablePath}>
        <span className="text-[11px] font-mono text-slate-600 truncate flex-1">{app.executablePath}</span>
      </div>

      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          {isRunning ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void run("fleet_action", { appId: app.id, action: "stop" })}
              className="text-[11px] font-semibold px-3 py-1.5 rounded-full border border-rose-200 bg-rose-50 text-rose-600 hover:bg-rose-100 transition-all cursor-pointer active:scale-95 disabled:opacity-40 flex items-center gap-1"
            >
              <Square size={10} /> Stop process
            </button>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => void run("fleet_action", { appId: app.id, action: "start" })}
              className="text-[11px] font-semibold px-3 py-1.5 rounded-full bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700/50 shadow-xs transition-all cursor-pointer active:scale-95 disabled:opacity-40 flex items-center gap-1"
            >
              <Play size={10} /> Launch
            </button>
          )}
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={onBrowse}
          className="text-[11px] font-semibold px-3 py-1.5 rounded-full border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 transition-all cursor-pointer active:scale-95 disabled:opacity-40 flex items-center gap-1"
        >
          <FolderOpen size={11} /> Change path
        </button>
      </div>
    </article>
  );
}

// -------------------------------------------------------------
// Component: Waiting Provider Card
// -------------------------------------------------------------
function WaitingProviderCard({ provider, options }: { provider: Provider; options: Provider[] }) {
  const run = useRonic((s) => s.run);
  const go = useRonic((s) => s.go);
  const busy = useRonic((s) => s.busy);

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
    <article className="bg-white border border-slate-200/80 rounded-2xl p-4 shadow-xs hover:shadow-md hover:border-slate-300 transition-all space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-3 min-w-0">
          <AppLogo id={provider.id} name={provider.name} url={provider.binaryOrEndpoint} size={40} />
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-bold text-slate-900 truncate">{provider.name}</span>
              <span className="text-[9.5px] font-bold px-1.5 py-0.5 rounded-md bg-slate-100 text-slate-600 border border-slate-200 shrink-0">
                {getProviderTypeLabel(provider.providerType)}
              </span>
            </div>
            <p className="text-[11px] text-slate-500 mt-0.5">{provider.healthDetail || "Needs setup to connect"}</p>
          </div>
        </div>
        <Pill kind="warn">
          {isApi ? "Needs API Key" : isOllama ? "Not Running" : isWeb ? "Not Signed In" : "Not Installed"}
        </Pill>
      </div>

      <p className="text-[11px] text-slate-500 leading-relaxed">
        {isApi
          ? `Provide your ${provider.name} API key to enable fast completion, chat models, and reasoning.`
          : isOllama
          ? "Start Ollama on your system to run local open-weights models offline with full privacy."
          : isWeb
          ? `Sign in with your ${provider.name} account to inspect and dispatch through workspace browser tabs.`
          : `Link or install the ${provider.name} executable on your computer to dispatch via terminal.`}
      </p>

      <div className="bg-slate-50/70 border border-slate-100 rounded-xl p-3 space-y-2.5">
        {isApi ? (
          <>
            <div className="relative">
              <input
                className={inputCls + " pr-9"}
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
                onClick={() => setShowSecret((s) => !s)}
                title={showSecret ? "Hide" : "Show"}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 transition-colors"
              >
                {showSecret ? <EyeOff size={13} /> : <Eye size={13} />}
              </button>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                disabled={busy || !secret.trim()}
                onClick={() => void handleConnectKey()}
                className="text-[11px] font-semibold px-3 py-1.5 rounded-full bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700/50 shadow-xs transition-all cursor-pointer active:scale-95 disabled:opacity-40"
              >
                Save &amp; Connect
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void run("test_provider", { id: provider.id })}
                className="text-[11px] font-semibold px-3 py-1.5 rounded-full border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 transition-all cursor-pointer active:scale-95 disabled:opacity-40"
              >
                Test ping
              </button>
            </div>
          </>
        ) : isWeb ? (
          <button
            type="button"
            onClick={() => {
              sessionStorage.setItem("ronic.focusHarness", provider.id);
              go("chat");
            }}
            className="text-[11px] font-semibold px-3 py-1.5 rounded-full border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 transition-all cursor-pointer active:scale-95"
          >
            Sign in / Open in workspace
          </button>
        ) : isOllama ? (
          <div className="flex items-center gap-1.5 flex-wrap">
            {installUrl ? (
              <a
                href={installUrl}
                target="_blank"
                rel="noreferrer"
                className="text-[11px] font-semibold px-3 py-1.5 rounded-full border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 transition-all cursor-pointer active:scale-95 flex items-center gap-1"
              >
                Download Ollama <ExternalLink size={10} />
              </a>
            ) : null}
            <button
              type="button"
              disabled={busy}
              onClick={() => void run("test_provider", { id: provider.id })}
              className="text-[11px] font-semibold px-3 py-1.5 rounded-full bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700/50 shadow-xs transition-all cursor-pointer active:scale-95 disabled:opacity-40"
            >
              Check if running
            </button>
          </div>
        ) : isCli ? (
          <div className="flex items-center gap-1.5 flex-wrap">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                void pickPaths("program").then((paths) => {
                  const path = paths[0];
                  if (!path) return;
                  setEndpoint(path);
                  save({ binaryOrEndpoint: path, allowCliDispatch: true });
                });
              }}
              className="text-[11px] font-semibold px-3 py-1.5 rounded-full bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700/50 shadow-xs transition-all cursor-pointer active:scale-95 disabled:opacity-40 flex items-center gap-1"
            >
              <FolderOpen size={11} /> Browse binary (.exe)
            </button>
            {installUrl ? (
              <a
                href={installUrl}
                target="_blank"
                rel="noreferrer"
                className="text-[11px] font-semibold px-3 py-1.5 rounded-full border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 transition-all cursor-pointer active:scale-95 flex items-center gap-1"
              >
                Install Guide <ExternalLink size={10} />
              </a>
            ) : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}

// -------------------------------------------------------------
// Component: Missing App Card
// -------------------------------------------------------------
function MissingAppCard({ app, onBrowse }: { app: LinkedApp; onBrowse: () => void }) {
  const installUrl = INSTALLS[app.id];

  return (
    <article className="bg-white border border-slate-200/80 rounded-2xl p-4 shadow-xs hover:shadow-md hover:border-slate-300 transition-all space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-3 min-w-0">
          <AppLogo id={app.id} name={app.appName} url={app.executablePath} size={40} />
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-bold text-slate-900 truncate">{app.appName}</span>
              <span className="text-[9.5px] font-bold px-1.5 py-0.5 rounded-md bg-slate-100 text-slate-600 border border-slate-200 shrink-0">
                {app.category || "Desktop App"}
              </span>
            </div>
            <p className="text-[11px] text-slate-500 mt-0.5">{app.detail || "Not found on system"}</p>
          </div>
        </div>
        <Pill kind="warn">Not Installed</Pill>
      </div>

      <p className="text-[11px] text-slate-500 leading-relaxed">
        Link the executable location for {app.appName} so your bots can launch and orchestrate this tool.
      </p>

      <div className="flex items-center gap-1.5 flex-wrap">
        <button
          type="button"
          onClick={onBrowse}
          className="text-[11px] font-semibold px-3 py-1.5 rounded-full bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700/50 shadow-xs transition-all cursor-pointer active:scale-95 flex items-center gap-1"
        >
          <FolderOpen size={11} /> Browse for program (.exe)
        </button>
        {installUrl ? (
          <a
            href={installUrl}
            target="_blank"
            rel="noreferrer"
            className="text-[11px] font-semibold px-3 py-1.5 rounded-full border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 transition-all cursor-pointer active:scale-95 flex items-center gap-1"
          >
            Download <ExternalLink size={10} />
          </a>
        ) : null}
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
  const run = useRonic((s) => s.run);
  const busy = useRonic((s) => s.busy);

  const [activeTab, setActiveTab] = useState<"provider" | "app">(initialTab);

  const [provName, setProvName] = useState("");
  const [provType, setProvType] = useState<ProviderType>("byok_api");
  const [provEndpoint, setProvEndpoint] = useState("");
  const [provKey, setProvKey] = useState("");
  const [showKey, setShowKey] = useState(false);

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
    <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="w-full max-w-lg bg-[#f1f3f6] rounded-3xl overflow-hidden flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5 border-b border-slate-100 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-bold text-slate-900">Connect new app or provider</h2>
            <p className="text-xs text-slate-500 mt-1">
              Add a custom LLM provider endpoint or link an installed desktop application.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 w-8 h-8 rounded-full border border-slate-200 bg-white text-slate-500 hover:text-slate-900 hover:bg-slate-50 transition-all flex items-center justify-center"
          >
            ×
          </button>
        </div>

        <div className="px-5 pt-4 flex items-center gap-2">
          <button
            type="button"
            onClick={() => setActiveTab("provider")}
            className={`flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-full transition-all cursor-pointer ${
              activeTab === "provider"
                ? "bg-zinc-800 text-white shadow-xs"
                : "bg-slate-100 text-slate-600 hover:bg-slate-200/70 hover:text-slate-800"
            }`}
          >
            <Sparkles size={12} /> AI Provider / API
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("app")}
            className={`flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-full transition-all cursor-pointer ${
              activeTab === "app"
                ? "bg-zinc-800 text-white shadow-xs"
                : "bg-slate-100 text-slate-600 hover:bg-slate-200/70 hover:text-slate-800"
            }`}
          >
            <AppWindow size={12} /> Desktop / CLI App
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {activeTab === "provider" ? (
            <>
              <div className="space-y-1.5">
                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Popular Presets</span>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {PRESETS.map((preset) => (
                    <button
                      key={preset.name}
                      type="button"
                      onClick={() => applyPreset(preset)}
                      title={preset.hint}
                      className="text-[11px] font-semibold px-3 py-1.5 rounded-full border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 transition-all cursor-pointer active:scale-95"
                    >
                      {preset.name}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex items-center gap-3 p-3 rounded-xl bg-slate-50/70 border border-slate-100">
                <AppLogo id={provName} name={provName} url={provEndpoint} size={36} />
                <div>
                  <p className="text-xs font-semibold text-slate-800">{provName.trim() ? provName : "Provider Preview"}</p>
                  <p className="text-[10px] text-slate-400">
                    {provEndpoint.trim() && provEndpoint.startsWith("http")
                      ? `Auto-resolves website favicon from ${provEndpoint}`
                      : "Official vector logo, CLI icon, or monogram"}
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <label className="space-y-1">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Provider name</span>
                  <input
                    className={inputCls}
                    placeholder="e.g. Groq, LM Studio, vLLM"
                    value={provName}
                    onChange={(e) => setProvName(e.target.value)}
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Kind / Protocol</span>
                  <select
                    className={inputCls}
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

              <label className="space-y-1 block">
                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Base URL or binary path</span>
                <input
                  className={inputCls}
                  placeholder="https://api.groq.com/openai/v1 or https://api.together.xyz/v1"
                  value={provEndpoint}
                  onChange={(e) => setProvEndpoint(e.target.value)}
                />
              </label>

              {provType === "byok_api" && (
                <label className="space-y-1 block">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">API Key (optional — can paste later)</span>
                  <div className="relative">
                    <input
                      className={inputCls + " pr-9"}
                      type={showKey ? "text" : "password"}
                      placeholder="sk-..."
                      value={provKey}
                      onChange={(e) => setProvKey(e.target.value)}
                    />
                    <button
                      type="button"
                      onClick={() => setShowKey((s) => !s)}
                      title={showKey ? "Hide" : "Show"}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 transition-colors"
                    >
                      {showKey ? <EyeOff size={13} /> : <Eye size={13} />}
                    </button>
                  </div>
                </label>
              )}

              <p className="text-[11px] text-slate-400 leading-relaxed">
                Ronic OS supports any OpenAI-compatible API endpoint. After connecting, run Test ping to verify.
              </p>
            </>
          ) : (
            <>
              <div className="flex items-center gap-3 p-3 rounded-xl bg-slate-50/70 border border-slate-100">
                <AppLogo id={appName} name={appName} url={appPath} size={36} />
                <div>
                  <p className="text-xs font-semibold text-slate-800">{appName.trim() ? appName : "App Logo Preview"}</p>
                  <p className="text-[10px] text-slate-400">{appCat ? `${appCat} application` : "Desktop or CLI tool icon"}</p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <label className="space-y-1">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">App Name</span>
                  <input
                    className={inputCls}
                    placeholder="e.g. VS Code Insiders, Postman, Warp"
                    value={appName}
                    onChange={(e) => setAppName(e.target.value)}
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Category</span>
                  <select
                    className={inputCls}
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

              <label className="space-y-1 block">
                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Executable Path (.exe or binary)</span>
                <div className="flex items-center gap-1.5">
                  <input
                    className={inputCls}
                    placeholder="C:\Users\...\app.exe"
                    value={appPath}
                    onChange={(e) => setAppPath(e.target.value)}
                  />
                  <button
                    type="button"
                    onClick={browseForExecutable}
                    className="shrink-0 text-[11px] font-semibold px-3 py-2.5 rounded-xl border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 transition-all cursor-pointer active:scale-95 flex items-center gap-1"
                  >
                    <FolderOpen size={12} /> Browse
                  </button>
                </div>
              </label>

              <p className="text-[11px] text-slate-400 leading-relaxed">
                Browse to any application executable on this machine to make it launchable and inspectable by bot coworkers.
              </p>
            </>
          )}
        </div>

        <div className="p-4 border-t border-slate-100 bg-slate-50/50 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="text-xs font-semibold px-3.5 py-2 rounded-full border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 transition-all cursor-pointer active:scale-95"
          >
            Cancel
          </button>
          {activeTab === "provider" ? (
            <button
              type="button"
              disabled={busy || !provName.trim()}
              onClick={handleAddProvider}
              className="text-xs font-semibold px-3.5 py-2 rounded-full bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700/50 shadow-xs transition-all cursor-pointer active:scale-95 disabled:opacity-40"
            >
              Connect Provider
            </button>
          ) : (
            <button
              type="button"
              disabled={busy || !appName.trim()}
              onClick={handleAddApp}
              className="text-xs font-semibold px-3.5 py-2 rounded-full bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700/50 shadow-xs transition-all cursor-pointer active:scale-95 disabled:opacity-40"
            >
              Add App &amp; Link
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// =============================================================
// Memory Vault & Fleet (Preserved from original implementation)
// =============================================================
import BotFleetMissionControl from "../components/BotFleetMissionControl";

export { BotFleetMissionControl as Fleet };
