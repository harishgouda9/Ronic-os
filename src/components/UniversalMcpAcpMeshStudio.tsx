import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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

const SAMPLE = `const skills = await omni.skills.listIndex();
const facts = await omni.mem0.search("workspace");
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
    const unlistenPromise = listen("omni://webapp-auth-changed", () => {
      refresh().catch(() => {});
    });
    const ticker = window.setInterval(() => void refreshTunnel(), 5000);
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
      const calls = result.rpcCalls.length ? result.rpcCalls.join(", ") : "no omni calls";
      setRunOut(`${result.ok ? "ok" : "failed"} in ${result.executionMs}ms via ${result.worker}\ncalls: ${calls}\n${result.finalReturnJson}`);
    } catch (error) {
      setRunOut(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto bg-[#FAFAFA] p-6 text-[#0F172A]">
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-[6px] border border-[#E5E5E5] bg-white p-4">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-lg font-bold tracking-tight">Universal MCP & ACP mesh</h1>
            <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 font-mono text-[11px] font-semibold text-emerald-700">
              {bridged}/{apps.length || 0} marked connected
            </span>
          </div>
          <p className="max-w-3xl text-xs text-[#64748B]">
            Desktop apps and CLIs on this computer are auto-connected to the local MCP hub at launch (the button re-runs the same idempotent write). Signing into ChatGPT or Claude here is a normal site chat — the workspace context is attached to messages, but the site itself never speaks MCP. Real MCP for web harnesses goes through the public tunnel, which also starts automatically: register the URL in the harness's own connector settings and watch the handshake evidence. Peer calls are stored as tickets. Code Mode interprets <span className="font-mono">await omni.*</span> TypeScript in the host. It does not evaluate JavaScript in Node or Bun.
          </p>
          <p className="font-mono text-xs text-emerald-800">{banner}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 rounded-[6px] border border-[#E5E5E5] bg-[#F8FAFC] px-3 py-1.5 text-xs font-semibold">
            <input
              type="checkbox"
              checked={status?.autoConnectOnAuth ?? false}
              disabled={!desktop || busy}
              onChange={(event) => void setFlag({ autoConnectOnAuth: event.target.checked })}
            />
            Auto-connect on auth
          </label>
          <button
            type="button"
            disabled={!desktop || busy}
            onClick={() => void setFlag({ codeModeOn: !codeOn })}
            className="rounded-[6px] border border-[#111111] bg-[#111111] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
          >
            Cloudflare Code Mode: {codeOn ? "ON" : "OFF"} ({dtsTokens} dts tokens vs {rawTokens} stored schema tokens{saved ? ` — ${saved}% smaller` : ""})
          </button>
          <button type="button" disabled={!desktop || busy} onClick={() => void connectAll()} className="rounded-[6px] bg-[#111111] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40">
            Connect apps on this computer
          </button>
        </div>
      </div>

      <div className="flex gap-2">
        {([
          ["mesh", "Mesh"],
          ["code", "Code Mode TypeScript SDK & host interpreter"],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`rounded-[6px] border px-3 py-1 text-xs font-semibold ${tab === id ? "border-[#111111] bg-[#111111] text-white" : "border-[#E5E5E5] bg-white text-[#64748B]"}`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "mesh" ? (
        <>
          <section className="space-y-3 rounded-[6px] border border-[#111111] bg-white p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h2 className="text-sm font-bold">Web harness MCP — the real connection</h2>
                <p className="max-w-2xl text-[11px] leading-relaxed text-[#64748B]">
                  ChatGPT apps and Claude connectors fetch their MCP server from OpenAI's or Anthropic's cloud, so a 127.0.0.1 URL can never reach this computer. This tunnel puts the token-gated local MCP server on a public HTTPS URL. Register that URL inside the harness's own settings — that registration, not the sign-in, is what makes it speak MCP.
                </p>
              </div>
              <span className={`rounded-full border px-2 py-0.5 font-mono text-[11px] font-semibold ${tunnel?.running ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-slate-200 bg-slate-50 text-slate-500"}`}>
                {tunnel?.running ? "Tunnel live" : "Tunnel off"}
              </span>
            </div>
            {tunnel && !tunnel.binaryPresent ? (
              <div className="flex flex-wrap items-center gap-2 rounded border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-800">
                {tunnel.downloading ? (
                  <span>cloudflared is downloading in the background — it came pre-installed with this launch and will be ready in a moment.</span>
                ) : (
                  <>
                    <span>cloudflared (Cloudflare's free tunnel client) is not installed yet.</span>
                    <button type="button" disabled={!desktop || busy} onClick={() => void tunnelAction("mesh_tunnel_download")} className="rounded-[6px] bg-[#111111] px-3 py-1 text-xs font-semibold text-white disabled:opacity-40">
                      Download cloudflared
                    </button>
                    <span className="text-amber-700">~40 MB from Cloudflare's official release, stored in this app's own folder.</span>
                  </>
                )}
              </div>
            ) : null}
            {tunnel?.running ? (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded border border-[#E5E5E5] bg-[#F8FAFC] px-2 py-1 font-mono text-[11px]" title={tunnel.publicMcpUrl}>{tunnel.publicMcpUrl}</code>
                  <button
                    type="button"
                    disabled={!desktop || busy}
                    onClick={() => {
                      void copyText(tunnel.publicMcpUrl).then((ok) => {
                        setCopied(ok);
                        if (ok) window.setTimeout(() => setCopied(false), 2500);
                      });
                    }}
                    className="rounded-[6px] bg-[#111111] px-3 py-1 text-xs font-semibold text-white disabled:opacity-40"
                  >
                    {copied ? "Copied" : "Copy MCP URL"}
                  </button>
                  <button type="button" disabled={!desktop || busy} onClick={() => void tunnelAction("mesh_tunnel_stop")} className="rounded-[6px] border border-[#111111] px-3 py-1 text-xs font-semibold disabled:opacity-40">
                    Stop tunnel
                  </button>
                </div>
                <p className={`font-mono text-[11px] ${tunnel.lastMcpCallMs >= tunnel.sinceMs ? "text-emerald-700 font-semibold" : "text-slate-500"}`}>
                  Last MCP call through the public URL: {ageOf(tunnel.lastMcpCallMs)} — {tunnel.lastMcpCallMs >= tunnel.sinceMs ? "a harness reached this computer over MCP" : "none since the tunnel started; register the URL in a harness and it will appear here"}
                </p>
                <div className="flex flex-wrap gap-2 border-t border-[#F1F5F9] pt-2">
                  <button type="button" disabled={!desktop || busy} onClick={() => void openSetup("chatgpt_web")} className="rounded-[6px] border border-[#111111] px-3 py-1 text-xs font-semibold hover:bg-slate-50">
                    Open ChatGPT connector settings
                  </button>
                  <button type="button" disabled={!desktop || busy} onClick={() => void openSetup("claude_web")} className="rounded-[6px] border border-[#111111] px-3 py-1 text-xs font-semibold hover:bg-slate-50">
                    Open Claude connectors
                  </button>
                  <span className="self-center text-[11px] text-[#64748B]">Paste the copied URL there. When the harness saves it, the line above turns green.</span>
                </div>
              </div>
            ) : tunnel?.binaryPresent ? (
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" disabled={!desktop || busy} onClick={() => void tunnelAction("mesh_tunnel_start")} className="rounded-[6px] bg-[#111111] px-3 py-1 text-xs font-semibold text-white disabled:opacity-40">
                  Start public tunnel
                </button>
                <span className="text-[11px] text-[#64748B]">Creates a temporary trycloudflare.com URL in front of the local MCP alias (port 8765). Anyone with the URL still needs the token inside it.</span>
              </div>
            ) : (
              <p className="text-[11px] text-[#64748B]">Install cloudflared above to give ChatGPT and Claude a real MCP path to this computer.</p>
            )}
          </section>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-1.5">
              {([
                ["all", `All (${apps.length})`],
                ["webapp", "Webapps"],
                ["desktop_ide", "Desktop IDEs"],
                ["coding_cli", "Coding CLIs"],
                ["external_bot", "External bots"],
              ] as const).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setFilter(id)}
                  className={`rounded-[6px] border px-3 py-1 text-xs font-semibold ${filter === id ? "border-[#111111] bg-[#111111] text-white" : "border-[#E5E5E5] bg-white text-[#64748B]"}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <span className="font-mono text-[11px] text-[#64748B]">
              MCP {status?.mcpEndpoint || "—"} · alias {status?.mcpAlias || "—"} · ACP {status?.acpEndpoint || "—"}
            </span>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {visible.map((app) => (
              <article key={app.id} className={`flex flex-col gap-3 rounded-[6px] border bg-white p-4 ${app.autoConnected ? "border-[#111111]" : "border-[#E5E5E5]"}`}>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2 text-sm font-bold">
                      <span className={`h-2 w-2 rounded-full ${app.installed ? "bg-emerald-500" : "bg-slate-300"}`} />
                      {app.name}
                    </div>
                    <div className="text-[11px] text-[#64748B]">{KIND_LABEL[app.kind]}</div>
                  </div>
                  <span className="rounded border border-[#E5E5E5] bg-[#F8FAFC] px-2 py-0.5 font-mono text-[10px] font-bold">{app.protocol}</span>
                </div>
                <div className="truncate rounded border border-[#E5E5E5] bg-[#F8FAFC] px-2 py-1 font-mono text-[10px]" title={app.endpoint}>
                  {app.endpoint}
                </div>
                <div className="grid grid-cols-2 gap-1.5 text-[11px]">
                  {(
                    [
                      ["shareMemory", "Mem0", app.shareMemory],
                      ["shareSkills", "Skills", app.shareSkills],
                      ["sharePlugins", "Plugins", app.sharePlugins],
                      ["allowPeerCalls", "Peer inbox", app.allowPeerCalls],
                    ] as const
                  ).map(([field, label, checked]) => (
                    <label key={field} className="flex items-center gap-1.5 rounded border border-[#E5E5E5] bg-[#F8FAFC] px-2 py-1">
                      <input type="checkbox" checked={checked} disabled={!desktop || busy} onChange={() => void setFlag({ appId: app.id, field, value: !checked })} />
                      {label}
                    </label>
                  ))}
                </div>
                <div className="flex items-center justify-between border-t border-[#F1F5F9] pt-2 text-xs">
                  <span className={`font-mono text-[11px] ${app.autoConnected ? "text-emerald-700 font-medium" : "text-amber-700"}`}>{app.authStatus}</span>
                  <div className="flex gap-1.5">
                    {app.kind === "webapp" ? (
                      <button type="button" disabled={!desktop || busy} onClick={() => void openWeb(app)} className="rounded-[6px] border border-[#111111] px-2 py-1 text-xs font-semibold hover:bg-slate-50">
                        Open
                      </button>
                    ) : null}
                    <button
                      type="button"
                      disabled={!desktop || busy}
                      onClick={() => void setFlag({ appId: app.id, field: "autoConnected", value: !app.autoConnected })}
                      className={`rounded-[6px] px-2 py-1 text-xs font-semibold ${app.autoConnected ? "bg-[#111111] text-white" : "border border-[#111111]"}`}
                    >
                      {app.autoConnected ? "Connected" : "Mark connected"}
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>

          <section className="space-y-3 rounded-[6px] border border-[#E5E5E5] bg-white p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-bold">Cross-app relay</h2>
                <p className="text-[11px] text-[#64748B]">Reads Mem0 and a real skill, then writes a peer ticket. It does not launch Claude, Cursor, or a web session.</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <select value={source} onChange={(event) => setSource(event.target.value)} className="rounded-[6px] border border-[#E5E5E5] bg-[#F8FAFC] px-2 py-1 font-mono text-xs">
                  {apps.map((app) => (
                    <option key={app.id} value={app.id}>
                      {app.name}
                    </option>
                  ))}
                </select>
                <select value={scenario} onChange={(event) => setScenario(event.target.value)} className="rounded-[6px] border border-[#E5E5E5] bg-[#F8FAFC] px-2 py-1 font-mono text-xs">
                  <option value="mem0-skill-cli">Mem0 count + skill, queue Claude Code</option>
                  <option value="skill-cursor">Load a skill, queue Cursor</option>
                  <option value="store-mem0">Store a relay note in Mem0</option>
                </select>
                <button type="button" disabled={!desktop || busy} onClick={() => void runRelay()} className="rounded-[6px] bg-[#111111] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40">
                  Run relay
                </button>
              </div>
            </div>
            <div className="max-h-36 space-y-1 overflow-y-auto rounded-[6px] border border-[#E5E5E5] bg-[#F8FAFC] p-3 font-mono text-[11px]">
              {trace.length === 0 ? <div className="text-[#64748B]">No relay has run in this session.</div> : trace.map((line, index) => <div key={`${index}-${line.slice(0, 24)}`}>{line}</div>)}
            </div>
          </section>
        </>
      ) : (
        <div className="grid min-h-[420px] grid-cols-1 gap-3 lg:grid-cols-2">
          <section className="flex min-h-0 flex-col rounded-[6px] border border-[#E5E5E5] bg-white">
            <header className="flex items-center justify-between border-b border-[#E5E5E5] px-3 py-2 text-xs font-semibold">
              <span>omni.d.ts · {bundle?.skillCount ?? 0} skills · {bundle?.serverCount ?? 0} MCP servers</span>
              <button type="button" disabled={!desktop || busy} onClick={() => void loadDts()} className="rounded border border-[#E5E5E5] px-2 py-1">
                Refresh
              </button>
            </header>
            <pre className="m-0 flex-1 overflow-auto p-3 font-mono text-[11px] leading-relaxed">{bundle?.typescriptDts || (desktop ? "Loading the declaration." : "Open the desktop app to compile the live declaration.")}</pre>
          </section>
          <section className="flex min-h-0 flex-col gap-2 rounded-[6px] border border-[#E5E5E5] bg-white p-3">
            <header className="text-xs font-semibold">Live sandbox</header>
            <textarea value={script} onChange={(event) => setScript(event.target.value)} spellCheck={false} className="min-h-48 flex-1 rounded-[6px] border border-[#E5E5E5] bg-[#F8FAFC] p-3 font-mono text-[11px]" />
            <button type="button" disabled={!desktop || busy || !codeOn} onClick={() => void runScript()} className="self-start rounded-[6px] bg-[#111111] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40">
              Run Code Mode
            </button>
            <pre className="max-h-48 overflow-auto rounded-[6px] border border-[#E5E5E5] bg-[#F8FAFC] p-3 font-mono text-[11px]">{runOut || "The worker returns the script's value. Remote MCP servers are named here and are not called."}</pre>
          </section>
        </div>
      )}
    </div>
  );
}
