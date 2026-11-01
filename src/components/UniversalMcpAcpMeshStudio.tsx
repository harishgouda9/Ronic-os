import { useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  Check,
  Copy,
  ExternalLink,
  Globe,
  Laptop,
  Play,
  RefreshCw,
  Terminal,
  Zap,
} from "lucide-react";
import { isTauri } from "../api";

type MeshKind = "webapp" | "desktop_ide" | "coding_cli" | "external_bot";

interface MeshApp {
  id: string;
  name: string;
  kind: MeshKind;
  protocol: string;
  authStatus: string;
  endpoint: string;
  installed: boolean;
  autoConnected: boolean;
  shareMemory: boolean;
  shareSkills: boolean;
  sharePlugins: boolean;
  allowPeerCalls: boolean;
}

interface TunnelInfo {
  binaryPresent: boolean;
  downloading: boolean;
  running: boolean;
  publicUrl: string;
  publicMcpUrl: string;
  sinceMs: number;
  lastMcpCallMs: number;
  note: string;
}

interface MeshStatus {
  autoConnectOnAuth: boolean;
  codeModeOn: boolean;
  mcpEndpoint: string;
  acpEndpoint: string;
  mcpAlias: string;
  note: string;
  dtsTokens: number;
  rawSchemaTokens: number;
  apps: MeshApp[];
  tunnel: TunnelInfo;
}

interface CodeModeBundle {
  tokenCountEstimate: number;
  rawMcpSchemaTokens: number;
  typescriptDts: string;
  skillCount: number;
  serverCount: number;
}

interface CodeModeRun {
  ok: boolean;
  executionMs: number;
  rpcCalls: string[];
  finalReturnJson: string;
  dtsTokens: number;
  rawSchemaTokens: number;
  worker: string;
}

const KIND_LABEL: Record<MeshKind, string> = {
  webapp: "WebApp",
  desktop_ide: "Desktop IDE",
  coding_cli: "Coding CLI",
  external_bot: "External bot",
};

const KIND_ICON: Record<MeshKind, typeof Globe> = {
  webapp: Globe,
  desktop_ide: Laptop,
  coding_cli: Terminal,
  external_bot: Zap,
};

const KIND_ICON_CLASS: Record<MeshKind, string> = {
  webapp: "bg-blue-50 text-blue-600 border-blue-100",
  desktop_ide: "bg-purple-50 text-purple-600 border-purple-100",
  coding_cli: "bg-emerald-50 text-emerald-600 border-emerald-100",
  external_bot: "bg-amber-50 text-amber-600 border-amber-100",
};

const SAMPLE = `const skills = await ronic.skills.listIndex();
const facts = await ronic.mem0.search("workspace");
return { skillCount: skills.length, factCount: facts.length, first: skills[0] || null };`;

function savedPercent(dts: number, raw: number) {
  if (raw <= dts || raw === 0) return 0;
  return Math.round((1 - dts / raw) * 100);
}

function ageOf(ms: number): string {
  if (!ms) return "never";
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the textarea path
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

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

export default function UniversalMcpAcpMeshStudio() {
  const desktop = isTauri();
  const [tab, setTab] = useState<"mesh" | "code">("mesh");
  const [status, setStatus] = useState<MeshStatus | null>(null);
  const [filter, setFilter] = useState<string>("all");
  const [banner, setBanner] = useState(desktop ? "Loading the mesh." : "Config patching, the MCP bridge, and Code Mode run in the desktop app.");
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState("chatgpt_web");
  const [scenario, setScenario] = useState("mem0-skill-cli");
  const [trace, setTrace] = useState<string[]>([]);
  const [bundle, setBundle] = useState<CodeModeBundle | null>(null);
  const [script, setScript] = useState(SAMPLE);
  const [runOut, setRunOut] = useState("");
  const [copied, setCopied] = useState(false);

  async function refresh() {
    if (!desktop) return;
    const next = await invoke<MeshStatus>("mesh_status");
    setStatus(next);
    setBanner(next.note || next.mcpEndpoint);
  }

  async function refreshTunnel() {
    if (!desktop) return;
    try {
      const next = await invoke<TunnelInfo>("mesh_tunnel_status");
      setStatus((current) => (current ? { ...current, tunnel: next } : current));
    } catch {
      // the mesh_status view still carries the last known tunnel state
    }
  }

  useEffect(() => {
    if (!desktop) return;
    refresh().catch((error: unknown) => setBanner(error instanceof Error ? error.message : String(error)));
    const unlistenPromise = listen("ronic://webapp-auth-changed", () => {
      refresh().catch(() => {});
    });
    const ticker = window.setInterval(() => {
      // Backoff: no IPC while the window is hidden, same as the main snapshot poll.
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void refreshTunnel();
    }, 5000);
    return () => {
      window.clearInterval(ticker);
      unlistenPromise.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [desktop]);

  async function tunnelAction(op: "mesh_tunnel_start" | "mesh_tunnel_stop" | "mesh_tunnel_download") {
    if (!desktop) return;
    setBusy(true);
    try {
      const next = await invoke<TunnelInfo>(op);
      setStatus((current) => (current ? { ...current, tunnel: next } : current));
      setBanner(next.note || "Tunnel updated.");
    } catch (error) {
      setBanner(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function openSetup(appId: string) {
    if (!desktop) return;
    setBusy(true);
    try {
      const note = await invoke<string>("open_harness_mcp_setup", { appId });
      setBanner(note);
    } catch (error) {
      setBanner(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function loadDts() {
    if (!desktop) return;
    const next = await invoke<CodeModeBundle>("compile_mcp_acp_to_typescript_dts");
    setBundle(next);
  }

  useEffect(() => {
    if (tab === "code") {
      loadDts().catch((error: unknown) => setRunOut(error instanceof Error ? error.message : String(error)));
    }
  }, [tab, desktop]);

  const apps = status?.apps ?? [];
  const tunnel = status?.tunnel ?? null;
  const visible = apps.filter((app) => filter === "all" || app.kind === filter);
  const bridged = apps.filter((app) => app.autoConnected).length;
  const dtsTokens = status?.dtsTokens ?? bundle?.tokenCountEstimate ?? 0;
  const rawTokens = status?.rawSchemaTokens ?? bundle?.rawMcpSchemaTokens ?? 0;
  const saved = savedPercent(dtsTokens, rawTokens);
  const codeOn = status?.codeModeOn ?? true;

  async function setFlag(patch: { autoConnectOnAuth?: boolean; codeModeOn?: boolean; appId?: string; field?: string; value?: boolean }) {
    if (!desktop) return;
    setBusy(true);
    try {
      const next = await invoke<MeshStatus>("mesh_set_flags", patch);
      setStatus(next);
      setBanner(next.note || "Mesh flags saved.");
    } catch (error) {
      setBanner(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function connectAll() {
    if (!desktop) return;
    setBusy(true);
    try {
      const next = await invoke<MeshStatus>("mesh_connect_all");
      setStatus(next);
      setBanner(next.note);
      setTrace((prev) => [next.note, ...prev].slice(0, 12));
    } catch (error) {
      setBanner(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function openWeb(app: MeshApp) {
    if (!desktop || app.kind !== "webapp") return;
    setBusy(true);
    try {
      const note = await invoke<string>("open_mcp_connected_webapp", { appId: app.id });
      setBanner(note);
    } catch (error) {
      setBanner(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function runRelay() {
    if (!desktop) return;
    setBusy(true);
    try {
      const lines = await invoke<string[]>("mesh_relay", { source, scenario });
      setTrace((prev) => [...lines, ...prev].slice(0, 16));
    } catch (error) {
      setTrace((prev) => [error instanceof Error ? error.message : String(error), ...prev].slice(0, 16));
    } finally {
      setBusy(false);
    }
  }

  async function runScript() {
    if (!desktop) return;
    setBusy(true);
    setRunOut("");
    try {
      const result = await invoke<CodeModeRun>("execute_code_mode_script", { tsScript: script });
      const calls = result.rpcCalls.length ? result.rpcCalls.join(", ") : "no ronic calls";
      setRunOut(`${result.ok ? "ok" : "failed"} in ${result.executionMs}ms via ${result.worker}\ncalls: ${calls}\n${result.finalReturnJson}`);
    } catch (error) {
      setRunOut(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex-1 h-full bg-[#eceef2] p-3 sm:p-5 lg:p-6 overflow-y-auto select-none flex flex-col">
      <div className="w-full max-w-[1560px] flex-1 min-h-[660px] bg-white rounded-3xl shadow-[0_12px_40px_-8px_rgba(0,0,0,0.06),0_2px_8px_-1px_rgba(0,0,0,0.03)] border border-slate-200/70 flex flex-col mx-auto overflow-hidden transition-all duration-300">

        {/* ─── HEADER ─── */}
        <div className="p-5 sm:p-7 pb-3.5 space-y-4 border-b border-slate-100">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="min-w-0">
              <div className="flex items-center gap-2.5 flex-wrap">
                <h1 className="text-lg sm:text-xl font-bold text-slate-900 tracking-tight">Universal MCP &amp; ACP mesh</h1>
                <Chip tone={bridged > 0 ? "emerald" : "slate"}>
                  <span className={`w-1.5 h-1.5 rounded-full ${bridged > 0 ? "bg-emerald-500" : "bg-slate-400"}`} />
                  {bridged}/{apps.length || 0} MARKED CONNECTED
                </Chip>
              </div>
              <p className="text-xs text-slate-500 mt-1.5 max-w-2xl leading-relaxed">
                Desktop apps and CLIs on this computer are auto-connected to the local MCP hub at launch (the button re-runs the same idempotent write). Signing into ChatGPT or Claude here is a normal site chat — the workspace context is attached to messages, but the site itself never speaks MCP. Real MCP for web harnesses goes through the public tunnel, which also starts automatically: register the URL in the harness's own connector settings and watch the handshake evidence. Peer calls are stored as tickets. Code Mode interprets <span className="font-mono">await ronic.*</span> TypeScript in the host. It does not evaluate JavaScript in Node or Bun.
              </p>
              <p className="text-[11px] font-mono text-emerald-700 mt-2">{banner}</p>
            </div>
            <div className="shrink-0 flex items-center gap-2 flex-wrap">
              <label className="flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 cursor-pointer hover:bg-slate-50 transition-all">
                <input
                  type="checkbox"
                  checked={status?.autoConnectOnAuth ?? false}
                  disabled={!desktop || busy}
                  onChange={(event) => void setFlag({ autoConnectOnAuth: event.target.checked })}
                  className="accent-slate-900"
                />
                Auto-connect on auth
              </label>
              <button
                type="button"
                disabled={!desktop || busy}
                onClick={() => void setFlag({ codeModeOn: !codeOn })}
                className="text-xs font-semibold px-3.5 py-2 rounded-full bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700/50 shadow-xs transition-all cursor-pointer active:scale-95 disabled:opacity-40"
              >
                Code Mode: {codeOn ? "ON" : "OFF"}{saved ? ` (−${saved}% tokens)` : ""}
              </button>
              <button
                type="button"
                disabled={!desktop || busy}
                onClick={() => void connectAll()}
                className="text-xs font-semibold px-3.5 py-2 rounded-full bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700/50 shadow-xs transition-all cursor-pointer active:scale-95 disabled:opacity-40"
              >
                Connect apps on this computer
              </button>
            </div>
          </div>

          {/* ─── TABS ─── */}
          <div className="flex items-center gap-2 overflow-x-auto pb-1 no-scrollbar pt-1">
            {(
              [
                ["mesh", "Mesh"],
                ["code", "Code Mode TypeScript SDK & host interpreter"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                onClick={() => setTab(id)}
                className={`shrink-0 px-3.5 py-1.5 text-xs font-semibold rounded-full transition-all cursor-pointer ${
                  tab === id
                    ? "bg-zinc-800 text-white shadow-xs"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200/70 hover:text-slate-800"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* ─── BODY ─── */}
        <div className="flex-1 overflow-y-auto px-5 sm:px-7 py-5 space-y-7">
          {tab === "mesh" ? (
            <>
              {/* Web harness tunnel */}
              <div className="space-y-2">
                <div className="flex items-center justify-between px-2">
                  <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400">Web harness MCP — the real connection</h2>
                  <Chip tone={tunnel?.running ? "emerald" : "slate"}>{tunnel?.running ? "Tunnel live" : "Tunnel off"}</Chip>
                </div>
                <div className="bg-slate-50/50 rounded-3xl p-4 border border-slate-100/80 space-y-3">
                  <p className="text-[11px] text-slate-500 leading-relaxed max-w-3xl">
                    ChatGPT apps and Claude connectors fetch their MCP server from OpenAI's or Anthropic's cloud, so a 127.0.0.1 URL can never reach this computer. This tunnel puts the token-gated local MCP server on a public HTTPS URL. Register that URL inside the harness's own settings — that registration, not the sign-in, is what makes it speak MCP.
                  </p>

                  {tunnel && !tunnel.binaryPresent ? (
                    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-[11px] text-amber-800">
                      {tunnel.downloading ? (
                        <span>cloudflared is downloading in the background — it came pre-installed with this launch and will be ready in a moment.</span>
                      ) : (
                        <>
                          <span>cloudflared (Cloudflare's free tunnel client) is not installed yet.</span>
                          <button
                            type="button"
                            disabled={!desktop || busy}
                            onClick={() => void tunnelAction("mesh_tunnel_download")}
                            className="text-xs font-semibold px-3.5 py-1.5 rounded-full bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700/50 shadow-xs transition-all cursor-pointer active:scale-95 disabled:opacity-40"
                          >
                            Download cloudflared
                          </button>
                          <span className="text-amber-700">~40 MB from Cloudflare's official release, stored in this app's own folder.</span>
                        </>
                      )}
                    </div>
                  ) : null}

                  {tunnel?.running ? (
                    <div className="space-y-2.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <code
                          className="min-w-0 flex-1 truncate rounded-xl border border-slate-200 bg-white px-3 py-2 font-mono text-[11px] text-slate-700"
                          title={tunnel.publicMcpUrl}
                        >
                          {tunnel.publicMcpUrl}
                        </code>
                        <button
                          type="button"
                          disabled={!desktop || busy}
                          onClick={() => {
                            void copyText(tunnel.publicMcpUrl).then((ok) => {
                              setCopied(ok);
                              if (ok) window.setTimeout(() => setCopied(false), 2500);
                            });
                          }}
                          className="text-xs font-semibold px-3.5 py-2 rounded-full bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700/50 shadow-xs transition-all cursor-pointer active:scale-95 disabled:opacity-40 flex items-center gap-1.5"
                        >
                          {copied ? <Check size={11} /> : <Copy size={11} />}
                          {copied ? "Copied" : "Copy MCP URL"}
                        </button>
                        <button
                          type="button"
                          disabled={!desktop || busy}
                          onClick={() => void tunnelAction("mesh_tunnel_stop")}
                          className="text-xs font-semibold px-3.5 py-2 rounded-full border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 transition-all cursor-pointer active:scale-95 disabled:opacity-40"
                        >
                          Stop tunnel
                        </button>
                      </div>
                      <p className={`font-mono text-[11px] ${tunnel.lastMcpCallMs >= tunnel.sinceMs ? "text-emerald-700 font-semibold" : "text-slate-400"}`}>
                        Last MCP call through the public URL: {ageOf(tunnel.lastMcpCallMs)} — {tunnel.lastMcpCallMs >= tunnel.sinceMs ? "a harness reached this computer over MCP" : "none since the tunnel started; register the URL in a harness and it will appear here"}
                      </p>
                      <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-2.5">
                        <button
                          type="button"
                          disabled={!desktop || busy}
                          onClick={() => void openSetup("chatgpt_web")}
                          className="text-xs font-semibold px-3.5 py-1.5 rounded-full border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 transition-all cursor-pointer active:scale-95 disabled:opacity-40 flex items-center gap-1"
                        >
                          <ExternalLink size={10} /> Open ChatGPT connector settings
                        </button>
                        <button
                          type="button"
                          disabled={!desktop || busy}
                          onClick={() => void openSetup("claude_web")}
                          className="text-xs font-semibold px-3.5 py-1.5 rounded-full border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 transition-all cursor-pointer active:scale-95 disabled:opacity-40 flex items-center gap-1"
                        >
                          <ExternalLink size={10} /> Open Claude connectors
                        </button>
                        <button
                          type="button"
                          disabled={!desktop || busy}
                          onClick={() => void openSetup("grok_web")}
                          className="text-xs font-semibold px-3.5 py-1.5 rounded-full border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 transition-all cursor-pointer active:scale-95 disabled:opacity-40 flex items-center gap-1"
                        >
                          <ExternalLink size={10} /> Open Grok settings
                        </button>
                        <span className="self-center text-[11px] text-slate-400">Paste the copied URL there. When the harness saves it, the line above turns green.</span>
                      </div>
                    </div>
                  ) : tunnel?.binaryPresent ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        disabled={!desktop || busy}
                        onClick={() => void tunnelAction("mesh_tunnel_start")}
                        className="text-xs font-semibold px-3.5 py-2 rounded-full bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700/50 shadow-xs transition-all cursor-pointer active:scale-95 disabled:opacity-40"
                      >
                        Start public tunnel
                      </button>
                      <span className="text-[11px] text-slate-400">Creates a temporary trycloudflare.com URL in front of the local MCP alias (port 8765). Anyone with the URL still needs the token inside it.</span>
                    </div>
                  ) : (
                    <p className="text-[11px] text-slate-400">Install cloudflared above to give ChatGPT and Claude a real MCP path to this computer.</p>
                  )}
                </div>
              </div>

              {/* App filter tabs */}
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3 px-2 flex-wrap">
                  <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400">Mesh apps</h2>
                  <span className="text-[11px] font-mono text-slate-400">
                    MCP {status?.mcpEndpoint || "—"} · alias {status?.mcpAlias || "—"} · ACP {status?.acpEndpoint || "—"}
                  </span>
                </div>
                <div className="flex items-center gap-2 overflow-x-auto pb-1 no-scrollbar px-2 flex-wrap">
                  {(
                    [
                      ["all", `All (${apps.length})`],
                      ["webapp", "Webapps"],
                      ["desktop_ide", "Desktop IDEs"],
                      ["coding_cli", "Coding CLIs"],
                      ["external_bot", "External bots"],
                    ] as const
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setFilter(id)}
                      className={`shrink-0 px-3.5 py-1.5 text-xs font-semibold rounded-full transition-all cursor-pointer ${
                        filter === id
                          ? "bg-zinc-800 text-white shadow-xs"
                          : "bg-slate-100 text-slate-600 hover:bg-slate-200/70 hover:text-slate-800"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                  {visible.map((app) => (
                    <MeshAppCard key={app.id} app={app} busy={busy} desktop={desktop} onFlag={setFlag} onOpenWeb={openWeb} />
                  ))}
                </div>
              </div>

              {/* Cross-app relay */}
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3 px-2 flex-wrap">
                  <div>
                    <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400">Cross-app relay</h2>
                    <p className="text-[11px] text-slate-500 mt-0.5">Reads Mem0 and a real skill, then writes a peer ticket. It does not launch Claude, Cursor, or a web session.</p>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <select
                      value={source}
                      onChange={(event) => setSource(event.target.value)}
                      className="text-[11px] font-mono bg-slate-50/70 hover:bg-white focus:bg-white border border-slate-200 rounded-xl px-3 py-2 text-slate-800 outline-none focus:border-slate-400 transition-all"
                    >
                      {apps.map((app) => (
                        <option key={app.id} value={app.id}>
                          {app.name}
                        </option>
                      ))}
                    </select>
                    <select
                      value={scenario}
                      onChange={(event) => setScenario(event.target.value)}
                      className="text-[11px] font-mono bg-slate-50/70 hover:bg-white focus:bg-white border border-slate-200 rounded-xl px-3 py-2 text-slate-800 outline-none focus:border-slate-400 transition-all"
                    >
                      <option value="mem0-skill-cli">Mem0 count + skill, queue Claude Code</option>
                      <option value="skill-cursor">Load a skill, queue Cursor</option>
                      <option value="store-mem0">Store a relay note in Mem0</option>
                    </select>
                    <button
                      type="button"
                      disabled={!desktop || busy}
                      onClick={() => void runRelay()}
                      className="text-xs font-semibold px-3.5 py-2 rounded-full bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700/50 shadow-xs transition-all cursor-pointer active:scale-95 disabled:opacity-40 flex items-center gap-1.5"
                    >
                      <Play size={11} /> Run relay
                    </button>
                  </div>
                </div>
                <div className="bg-slate-50/50 rounded-3xl p-1.5 border border-slate-100/80">
                  <div className="max-h-36 overflow-y-auto px-4 py-3 font-mono text-[11px] text-slate-600 space-y-1">
                    {trace.length === 0 ? (
                      <div className="py-6 text-center font-sans space-y-1.5">
                        <p className="text-sm font-semibold text-slate-700">No relay has run in this session</p>
                      </div>
                    ) : (
                      trace.map((line, index) => <div key={`${index}-${line.slice(0, 24)}`} className="leading-relaxed">{line}</div>)
                    )}
                  </div>
                </div>
              </div>
            </>
          ) : (
            /* Code Mode tab */
            <div className="grid min-h-[420px] grid-cols-1 gap-3 lg:grid-cols-2">
              <div className="bg-slate-50/50 rounded-3xl border border-slate-100/80 overflow-hidden flex flex-col">
                <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
                  <span className="text-xs font-bold text-slate-800">ronic.d.ts · {bundle?.skillCount ?? 0} skills · {bundle?.serverCount ?? 0} MCP servers</span>
                  <button
                    type="button"
                    disabled={!desktop || busy}
                    onClick={() => void loadDts()}
                    className="text-[11px] font-semibold px-3 py-1.5 rounded-full border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 transition-all cursor-pointer active:scale-95 disabled:opacity-40 flex items-center gap-1"
                  >
                    <RefreshCw size={10} /> Refresh
                  </button>
                </div>
                <pre className="m-0 flex-1 overflow-auto p-4 font-mono text-[11px] leading-relaxed text-slate-700">
                  {bundle?.typescriptDts || (desktop ? "Loading the declaration." : "Open the desktop app to compile the live declaration.")}
                </pre>
              </div>
              <div className="bg-slate-50/50 rounded-3xl border border-slate-100/80 p-4 space-y-3 flex flex-col">
                <span className="text-xs font-bold text-slate-800">Live sandbox</span>
                <textarea
                  value={script}
                  onChange={(event) => setScript(event.target.value)}
                  spellCheck={false}
                  className="min-h-48 flex-1 rounded-xl border border-slate-200 bg-white p-3 font-mono text-[11px] text-slate-800 outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-900/5 transition-all resize-none"
                />
                <button
                  type="button"
                  disabled={!desktop || busy || !codeOn}
                  onClick={() => void runScript()}
                  className="self-start text-xs font-semibold px-3.5 py-2 rounded-full bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700/50 shadow-xs transition-all cursor-pointer active:scale-95 disabled:opacity-40 flex items-center gap-1.5"
                >
                  <Zap size={11} /> Run Code Mode
                </button>
                <pre className="max-h-48 overflow-auto rounded-xl border border-slate-200 bg-white p-3 font-mono text-[11px] text-slate-600">
                  {runOut || "The worker returns the script's value. Remote MCP servers are named here and are not called."}
                </pre>
              </div>
            </div>
          )}
        </div>

        {/* ─── FOOTER STATUS BAR ─── */}
        <div className="px-6 py-3 bg-slate-50 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500">
          <div className="flex items-center gap-2 truncate pr-4">
            <span className={`w-2 h-2 rounded-full shrink-0 ${bridged > 0 ? "bg-emerald-500" : "bg-slate-300"}`} />
            <span className="truncate">
              {bridged > 0 ? `${bridged} of ${apps.length} apps bridged to the local MCP hub` : "Connect apps on this computer to bridge them into the mesh"}
            </span>
          </div>
          <div className="shrink-0 flex items-center gap-3 text-[11px] font-medium text-slate-400">
            <span className="font-mono">{dtsTokens} dts vs {rawTokens} raw tokens</span>
            {saved > 0 ? (
              <>
                <span>·</span>
                <span className="font-mono text-emerald-600">−{saved}%</span>
              </>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

// -------------------------------------------------------------
// Mesh App Card
// -------------------------------------------------------------
function MeshAppCard({
  app,
  busy,
  desktop,
  onFlag,
  onOpenWeb,
}: {
  app: MeshApp;
  busy: boolean;
  desktop: boolean;
  onFlag: (patch: { appId?: string; field?: string; value?: boolean }) => Promise<void>;
  onOpenWeb: (app: MeshApp) => Promise<void>;
}) {
  const Icon = KIND_ICON[app.kind];
  return (
    <article className="bg-white border border-slate-200/80 rounded-2xl p-4 shadow-xs hover:shadow-md hover:border-slate-300 transition-all space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-3 min-w-0">
          <span className={`w-10 h-10 rounded-xl border flex items-center justify-center shrink-0 ${KIND_ICON_CLASS[app.kind]}`}>
            <Icon size={16} />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${app.installed ? "bg-emerald-500" : "bg-slate-300"}`} />
              <span className="text-sm font-bold text-slate-900 truncate">{app.name}</span>
            </div>
            <p className="text-[11px] text-slate-500 mt-0.5">{KIND_LABEL[app.kind]}</p>
          </div>
        </div>
        <span className="text-[9.5px] font-bold px-1.5 py-0.5 rounded-md bg-slate-100 text-slate-600 border border-slate-200 font-mono shrink-0">
          {app.protocol}
        </span>
      </div>

      <div className="flex items-center gap-1.5 bg-slate-50/70 border border-slate-100 rounded-xl px-2.5 py-1.5" title={app.endpoint}>
        <span className="text-[10px] font-mono text-slate-600 truncate flex-1">{app.endpoint}</span>
      </div>

      <div className="grid grid-cols-2 gap-1.5">
        {(
          [
            ["shareMemory", "Mem0", app.shareMemory],
            ["shareSkills", "Skills", app.shareSkills],
            ["sharePlugins", "Plugins", app.sharePlugins],
            ["allowPeerCalls", "Peer inbox", app.allowPeerCalls],
          ] as const
        ).map(([field, label, checked]) => (
          <label
            key={field}
            className="flex items-center gap-1.5 rounded-xl border border-slate-100 bg-slate-50/70 px-2.5 py-1.5 cursor-pointer hover:bg-white transition-all"
          >
            <input
              type="checkbox"
              checked={checked}
              disabled={!desktop || busy}
              onChange={() => void onFlag({ appId: app.id, field, value: !checked })}
              className="accent-slate-900"
            />
            <span className="text-[11px] font-medium text-slate-700">{label}</span>
          </label>
        ))}
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-slate-100 pt-2.5">
        <span className={`font-mono text-[10px] truncate ${app.autoConnected ? "text-emerald-700 font-semibold" : "text-amber-600"}`}>
          {app.authStatus}
        </span>
        <div className="flex items-center gap-1.5 shrink-0">
          {app.kind === "webapp" ? (
            <button
              type="button"
              disabled={!desktop || busy}
              onClick={() => void onOpenWeb(app)}
              className="text-[11px] font-semibold px-3 py-1.5 rounded-full border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 transition-all cursor-pointer active:scale-95 disabled:opacity-40"
            >
              Open
            </button>
          ) : null}
          <button
            type="button"
            disabled={!desktop || busy}
            onClick={() => void onFlag({ appId: app.id, field: "autoConnected", value: !app.autoConnected })}
            className={`text-[11px] font-semibold px-3 py-1.5 rounded-full transition-all cursor-pointer active:scale-95 disabled:opacity-40 ${
              app.autoConnected
                ? "bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700/50 shadow-xs"
                : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
            }`}
          >
            {app.autoConnected ? "Connected" : "Mark connected"}
          </button>
        </div>
      </div>
    </article>
  );
}
