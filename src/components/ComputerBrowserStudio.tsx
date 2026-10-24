import React, { useState, useEffect } from "react";
import { ArrowLeft } from "lucide-react";
import { useOmni } from "../store";

export default function ComputerBrowserStudio() {
  const snap = useOmni((s) => s.snap);
  const run = useOmni((s) => s.run);
  const busy = useOmni((s) => s.busy);
  const go = useOmni((s) => s.go);

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
      `${stamp()} ${res ? `HTTP inspect finished in ${elapsed}ms` : `failed: ${useOmni.getState().toast ?? "no snapshot"}`}`,
      ...prev,
    ]);
  };

  const handleRunCommand = async (cmdToRun?: string) => {
    const target = cmdToRun || command;
    if (!target.trim()) return;
    await run("run_sandbox", { command: target });
  };

  return (
    <div className="flex-1 h-full bg-[#FAFAFA] text-[#0F172A] p-6 overflow-y-auto space-y-4 font-sans select-none">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => go("chat")}
            className="px-2.5 py-1.5 text-xs font-semibold bg-white border border-[#E5E5E5] text-[#0F172A] hover:border-[#111111] rounded-[6px] flex items-center gap-1.5 transition cursor-pointer shadow-xs"
            title="Back to Chat (Alt+Left)"
            aria-label="Back to Chat"
          >
            <ArrowLeft size={13} />
            <span>Back</span>
          </button>
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="text-xl font-bold tracking-tight">Computer & browser</h1>
              <span className={`px-2.5 py-0.5 text-xs font-mono font-semibold rounded-full border ${inspectConnected ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-white text-[#64748B] border-[#E5E5E5]"}`}>
                {inspectConnected ? "● Inspect connected" : "○ No inspect session"}
              </span>
            </div>
            <p className="text-xs text-[#64748B] mt-0.5">
              HTTP inspect of a page (interactive tags) and an allowlisted sandbox terminal. This is not a live CDP or OS accessibility session.
            </p>
          </div>
        </div>
      </div>

      <div className="bg-white border border-[#E5E5E5] p-3 rounded-[6px] flex flex-wrap items-center justify-between gap-3 shadow-xs">
        <div className="flex-1 min-w-[280px] flex items-center gap-2">
          <span className="text-xs font-mono text-[#64748B] font-semibold">URL:</span>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleInspectUrl();
            }}
            placeholder="https://example.com"
            className="flex-1 px-3 py-1.5 text-xs font-mono border border-[#E5E5E5] rounded-[6px] outline-none focus:border-[#111111] bg-white text-[#0F172A]"
          />
          <button
            onClick={() => void handleInspectUrl()}
            disabled={busy}
            className="px-4 py-1.5 text-xs font-semibold bg-[#111111] text-white rounded-[6px] hover:opacity-90 cursor-pointer disabled:opacity-50"
          >
            {busy ? "Inspecting..." : "Inspect URL"}
          </button>
        </div>
        {latencyMs > 0 ? <span className="text-[11px] font-mono text-emerald-700">Last inspect {latencyMs}ms</span> : null}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        <div className="lg:col-span-6 bg-white border border-[#E5E5E5] rounded-[6px] p-4 space-y-3 shadow-xs">
          <div className="flex items-center justify-between border-b border-[#E5E5E5] pb-2.5">
            <h2 className="text-xs font-semibold">Interactive tags ({nodes.length})</h2>
          </div>
          {nodes.length === 0 ? (
            <p className="text-xs text-[#64748B]">Inspect a URL to list buttons, links, and inputs from the HTTP snapshot.</p>
          ) : (
            <div className="space-y-2 max-h-[460px] overflow-y-auto pr-1">
              {nodes.map((item) => (
                <div key={item.id} className="p-2.5 bg-[#F8FAFC] border border-[#E5E5E5] rounded-[6px] text-xs">
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono font-bold text-[#0F172A]">[{item.id}]</span>
                    <span className="font-mono text-[#64748B] text-[11px]">&lt;{item.tag}&gt;</span>
                    <span className="font-semibold text-[#0F172A]">{item.label}</span>
                  </div>
                  <div className="text-[10.5px] font-mono text-[#94A3B8] mt-0.5">{item.kind}</div>
                </div>
              ))}
            </div>
          )}
          {logs.length > 0 ? (
            <pre className="p-3 bg-[#0F172A] text-slate-100 rounded-[6px] font-mono text-[11px] max-h-[160px] overflow-y-auto">
              {logs.join("\n")}
            </pre>
          ) : null}
        </div>

        <div className="lg:col-span-6 bg-white border border-[#E5E5E5] rounded-[6px] p-4 space-y-3 shadow-xs">
          <div className="flex items-center justify-between border-b border-[#E5E5E5] pb-2.5">
            <h2 className="text-xs font-semibold">Sandboxed terminal</h2>
            <span className="text-[11px] font-mono text-[#64748B] truncate max-w-[200px]" title={sandboxCwd}>
              {sandboxCwd.split("\\").pop()}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-mono text-[#64748B] mr-1">Presets:</span>
            {["git status", "cargo check", "npm run typecheck", "bun test", "uv tree", "node -v"].map((preset) => (
              <button
                key={preset}
                onClick={() => {
                  setCommand(preset);
                  void handleRunCommand(preset);
                }}
                className="px-2 py-0.5 text-[10.5px] font-mono bg-[#F8FAFC] border border-[#E5E5E5] rounded hover:border-[#111111] cursor-pointer"
              >
                {preset}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleRunCommand();
              }}
              placeholder="Enter allowlisted sandbox command (git, npm, cargo, uv...)"
              className="flex-1 px-3 py-1.5 text-xs font-mono border border-[#E5E5E5] rounded-[6px] outline-none focus:border-[#111111] bg-white text-[#0F172A]"
            />
            <button
              onClick={() => void handleRunCommand()}
              disabled={busy}
              className="px-3.5 py-1.5 text-xs font-semibold bg-[#111111] text-white rounded-[6px] hover:opacity-90 cursor-pointer disabled:opacity-50"
            >
              Run
            </button>
          </div>
          <pre className="p-3 bg-[#0F172A] text-emerald-400 border border-slate-800 rounded-[6px] font-mono text-[11px] max-h-[380px] overflow-y-auto whitespace-pre-wrap">
            {terminalOutput || "Output from allowlisted commands appears here."}
          </pre>
        </div>
      </div>
    </div>
  );
}

function stamp() {
  return new Date().toTimeString().slice(0, 8);
}
