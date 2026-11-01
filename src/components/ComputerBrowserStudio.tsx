import React, { useState, useEffect } from "react";
import { ArrowLeft, Globe, Terminal, Play, CheckCircle2, Search, ExternalLink } from "lucide-react";
import { useRonic } from "../store";

export default function ComputerBrowserStudio() {
  const snap = useRonic((s) => s.snap);
  const run = useRonic((s) => s.run);
  const busy = useRonic((s) => s.busy);
  const go = useRonic((s) => s.go);

  const [url, setUrl] = useState<string>(snap?.computerUrl || "https://example.com");
  const [command, setCommand] = useState<string>("git status");
  const [logs, setLogs] = useState<string[]>([]);

  const nodes = snap?.domNodes ?? [];
  const terminalOutput = snap?.sandboxOutput || "";
  const sandboxCwd = snap?.settings?.projectRoot || "";
  const inspectConnected = Boolean(snap?.computerUrl);
  const latencyMs = snap?.domLatencyMs ?? 0;

  useEffect(() => {
    if (snap?.computerUrl) setUrl(snap.computerUrl);
  }, [snap?.computerUrl]);

  const handleInspectUrl = async () => {
    const start = performance.now();
    setLogs((prev) => [`${stamp()} Inspecting ${url}…`, ...prev]);
    const res = await run("inspect_url", { url });
    const elapsed = Math.round(performance.now() - start);
    setLogs((prev) => [
      `${stamp()} ${res ? `HTTP inspect finished in ${elapsed}ms` : `failed: ${useRonic.getState().toast ?? "no snapshot"}`}`,
      ...prev,
    ]);
  };

  const handleRunCommand = async (cmdToRun?: string) => {
    const target = cmdToRun || command;
    if (!target.trim()) return;
    await run("run_sandbox", { command: target });
  };

  return (
    <div className="space-y-6">
      {/* URL Inspection Card */}
      <div className="rounded-2xl border border-slate-200/90 bg-white p-5 sm:p-6 shadow-xs space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3">
          <div>
            <h3 className="text-sm font-bold text-slate-900">HTTP DOM Inspector</h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Inspect interactive DOM tags and accessible elements without hijacking your OS cursor.
            </p>
          </div>
          <span className={`inline-flex items-center gap-1.5 px-3 py-1 text-xs font-semibold rounded-full border ${
            inspectConnected
              ? "bg-emerald-50 text-emerald-800 border-emerald-300 shadow-xs"
              : "bg-slate-100 text-slate-600 border-slate-200"
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full ${inspectConnected ? "bg-emerald-500" : "bg-slate-400"}`} />
            {inspectConnected ? "Inspect connected" : "No active session"}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex-1 min-w-[280px] relative">
            <Globe className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" size={14} />
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleInspectUrl();
              }}
              placeholder="https://example.com"
              className="w-full pl-9 pr-4 py-2 text-xs font-mono border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-slate-200 bg-slate-50 text-slate-900 transition-all"
            />
          </div>
          <button
            type="button"
            onClick={() => void handleInspectUrl()}
            disabled={busy}
            className="px-5 py-2 text-xs font-semibold bg-zinc-800 hover:bg-zinc-700 text-white rounded-full transition-all cursor-pointer shadow-xs active:scale-95 disabled:opacity-50 border border-zinc-700/50"
          >
            {busy ? "Inspecting…" : "Inspect URL"}
          </button>
          {latencyMs > 0 && (
            <span className="text-[11px] font-mono text-emerald-700 bg-emerald-50 px-2.5 py-1 rounded-full border border-emerald-200">
              Latency: {latencyMs}ms
            </span>
          )}
        </div>
      </div>

      {/* Grid: Interactive Tags (Left) vs Sandboxed Terminal (Right) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        
        {/* Left Column: Interactive Tags List */}
        <div className="lg:col-span-6 rounded-2xl border border-slate-200/90 bg-white p-5 sm:p-6 shadow-xs space-y-4">
          <div className="flex items-center justify-between border-b border-slate-100 pb-3">
            <h3 className="text-sm font-bold text-slate-900">Interactive Tags ({nodes.length})</h3>
            <span className="text-[11px] font-mono text-slate-500 bg-slate-50 px-2.5 py-0.5 rounded-full border border-slate-200">
              Snapshot DOM
            </span>
          </div>

          {nodes.length === 0 ? (
            <div className="py-12 text-center text-slate-400 text-xs">
              Inspect a URL above to list buttons, links, and inputs from the HTTP snapshot.
            </div>
          ) : (
            <div className="space-y-2 max-h-[460px] overflow-y-auto pr-1">
              {nodes.map((item) => (
                <div key={item.id} className="p-3 bg-slate-50 border border-slate-200/80 rounded-xl text-xs hover:bg-slate-100/70 transition">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-bold text-slate-800 bg-white px-2 py-0.5 rounded border border-slate-200 text-[11px]">
                      #{item.id}
                    </span>
                    <span className="font-mono text-slate-500 text-[11px]">&lt;{item.tag}&gt;</span>
                    <span className="font-semibold text-slate-900">{item.label}</span>
                  </div>
                  <div className="text-[11px] font-mono text-slate-400 mt-1">{item.kind}</div>
                </div>
              ))}
            </div>
          )}

          {logs.length > 0 && (
            <div className="pt-2 border-t border-slate-100">
              <div className="text-[11px] font-semibold text-slate-500 mb-1.5">Inspection Events:</div>
              <pre className="p-3 bg-[#1e2025] text-slate-200 rounded-xl font-mono text-[11px] max-h-[140px] overflow-y-auto shadow-inner">
                {logs.join("\n")}
              </pre>
            </div>
          )}
        </div>

        {/* Right Column: Sandboxed Terminal */}
        <div className="lg:col-span-6 rounded-2xl border border-slate-200/90 bg-white p-5 sm:p-6 shadow-xs space-y-4 flex flex-col justify-between">
          <div className="space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div className="flex items-center gap-2">
                <Terminal size={16} className="text-slate-800" />
                <h3 className="text-sm font-bold text-slate-900">Sandboxed Terminal</h3>
              </div>
              <span className="text-[11px] font-mono text-slate-500 truncate max-w-[200px]" title={sandboxCwd}>
                {sandboxCwd.split("\\").pop() || "project"}
              </span>
            </div>

            {/* Presets */}
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs font-semibold text-slate-500 mr-1">Presets:</span>
              {["git status", "cargo check", "npm run typecheck", "bun test", "uv tree", "node -v"].map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => {
                    setCommand(preset);
                    void handleRunCommand(preset);
                  }}
                  className="px-2.5 py-1 text-[11px] font-mono font-medium bg-slate-100 border border-slate-200 rounded-full hover:bg-slate-200 text-slate-700 cursor-pointer transition active:scale-95"
                >
                  {preset}
                </button>
              ))}
            </div>

            {/* Command Input Bar */}
            <div className="flex gap-2">
              <input
                type="text"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleRunCommand();
                }}
                placeholder="Enter allowlisted sandbox command (git, npm, cargo, uv...)"
                className="flex-1 px-3.5 py-2 text-xs font-mono border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-slate-200 bg-slate-50 text-slate-900"
              />
              <button
                type="button"
                onClick={() => void handleRunCommand()}
                disabled={busy}
                className="px-4 py-2 text-xs font-semibold bg-zinc-800 hover:bg-zinc-700 text-white rounded-full transition-all cursor-pointer shadow-xs active:scale-95 disabled:opacity-50 border border-zinc-700/50"
              >
                Run
              </button>
            </div>

            {/* Output Display */}
            <pre className="p-4 bg-[#1e2025] text-emerald-400 border border-slate-800 rounded-2xl font-mono text-[11px] max-h-[380px] min-h-[220px] overflow-y-auto whitespace-pre-wrap shadow-inner">
              {terminalOutput || "Output from allowlisted commands appears here."}
            </pre>
          </div>
        </div>

      </div>
    </div>
  );
}

function stamp() {
  return new Date().toTimeString().slice(0, 8);
}
