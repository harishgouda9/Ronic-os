import React, { useState, useMemo } from "react";
import {
  ArrowLeft,
  X,
  Play,
  Square,
  RotateCw,
  Cloud,
  MessageSquare,
  Plus,
  Trash2,
  Terminal,
  Cpu,
  RefreshCw,
  Send,
  AlertTriangle,
  CheckCircle2,
  FolderOpen,
} from "lucide-react";
import { useOmni } from "../store";

export interface FleetDaemon {
  id: string;
  name: string;
  category: "kernel" | "bot_daemon";
  pid: number | null;
  status: "alive" | "listening" | "running" | "ready" | "stopped" | "missing";
  detailPathOrUrl: string;
  ghostRunnerActive: boolean;
}

export interface FleetRoutine {
  id: string;
  title: string;
  botHandle: string;
  schedule: string;
  lastRun: string;
  enabled: boolean;
}

export interface FleetLogEntry {
  id: string;
  time: string;
  source: string;
  level: "info" | "warn" | "error";
  message: string;
}

export default function BotFleetMissionControl() {
  const snap = useOmni((s) => s.snap);
  const run = useOmni((s) => s.run);
  const go = useOmni((s) => s.go);

  // Modal / Form state for linking a real bot executable
  const [showAddModal, setShowAddModal] = useState(false);
  const [newBotName, setNewBotName] = useState("");
  const [newBotPath, setNewBotPath] = useState("");
  const [addError, setAddError] = useState("");

  // Filter state for live logs
  const [logFilter, setLogFilter] = useState<string>("All");
  const [quickSignalInput, setQuickSignalInput] = useState<string>("");

  // 1. Compute Authentic Daemons directly from real kernel processes and linked apps
  const daemons: FleetDaemon[] = useMemo(() => {
    const list: FleetDaemon[] = [];

    // Kernel watchdog
    const watchdogProc = snap?.processes?.find((p) => p.name === "watchdog");
    list.push({
      id: "watchdog",
      name: "watchdog",
      category: "kernel",
      pid: watchdogProc?.pid ?? null,
      status: "alive",
      detailPathOrUrl: watchdogProc?.detail || "500ms Rust anti-hang heartbeat & SQLite WAL guard",
      ghostRunnerActive: false,
    });

    // Kernel loopback proxy
    const proxyProc = snap?.processes?.find((p) => p.name === "loopback-proxy");
    const portMatch = snap?.proxyUrl?.match(/:(\d+)/);
    const proxyPort = portMatch ? portMatch[1] : "4142";
    list.push({
      id: "loopback_proxy",
      name: "loopback-proxy",
      category: "kernel",
      pid: proxyProc?.pid ?? null,
      status: snap?.proxyUrl || proxyProc ? "listening" : "ready",
      detailPathOrUrl: snap?.proxyUrl || `http://127.0.0.1:${proxyPort}/v1 (OpenAI-Compatible Multiplexer)`,
      ghostRunnerActive: false,
    });

    // Linked local apps (excluding passive IDE bridges like Cursor/VS Code/Obsidian)
    const ghostList = snap?.settings?.ghostRunners ?? [];
    const isGhost = (id: string, name: string) =>
      ghostList.some((g) => g.toLowerCase() === id.toLowerCase() || g.toLowerCase() === name.toLowerCase());

    const passiveIdes = new Set(["cursor", "vs code", "vs code insiders", "obsidian"]);
    const botApps = (snap?.apps ?? []).filter(
      (app) => app.category !== "ide_bridge" && !passiveIdes.has(app.appName.toLowerCase().trim())
    );

    for (const app of botApps) {
      const isRunning = Boolean(app.activePid) || app.status === "running";
      let statusLabel: FleetDaemon["status"] = "stopped";
      if (isRunning) {
        statusLabel = "running";
      } else if (app.status === "missing") {
        statusLabel = "missing";
      } else {
        statusLabel = "ready";
      }

      list.push({
        id: app.id,
        name: app.appName,
        category: "bot_daemon",
        pid: app.activePid ?? null,
        status: statusLabel,
        detailPathOrUrl: app.executablePath || app.detail || "Executable path not configured",
        ghostRunnerActive: isGhost(app.id, app.appName),
      });
    }

    return list;
  }, [snap?.processes, snap?.apps, snap?.settings?.ghostRunners, snap?.proxyUrl]);

  // 2. Compute Authentic Scheduled Routines from threads that actually have routine schedules
  const routines: FleetRoutine[] = useMemo(() => {
    const list: FleetRoutine[] = [];
    const threadsWithSchedule = (snap?.threads ?? []).filter(
      (t) => t.routineSchedule && t.routineSchedule.trim() !== ""
    );

    for (const t of threadsWithSchedule) {
      const bot = snap?.profiles?.find((b) => b.id === t.botProfileId);
      list.push({
        id: t.id,
        title: t.title || "Untitled Routine",
        botHandle: bot ? (bot.handle.startsWith("@") ? bot.handle : `@${bot.handle}`) : "Agent",
        schedule: t.routineSchedule,
        lastRun: t.updatedAt ? new Date(t.updatedAt).toLocaleTimeString() : "Scheduled",
        enabled: t.status !== "paused",
      });
    }

    return list;
  }, [snap?.threads, snap?.profiles]);

  // 3. Compute Authentic Live Logs directly from snap.fleetLogs
  const logs: FleetLogEntry[] = useMemo(() => {
    if (!snap?.fleetLogs || snap.fleetLogs.length === 0) {
      return [];
    }
    return snap.fleetLogs.map((l) => ({
      id: l.id,
      time: new Date(l.createdAt).toLocaleTimeString(),
      source: l.botName || "Kernel",
      level:
        l.stream === "stderr" || l.line.toLowerCase().includes("error") || l.line.toLowerCase().includes("fatal")
          ? ("error" as const)
          : l.stream === "warn" || l.line.toLowerCase().includes("stopped") || l.line.toLowerCase().includes("warn")
          ? ("warn" as const)
          : ("info" as const),
      message: l.line,
    }));
  }, [snap?.fleetLogs]);

  // Dynamic log filter options based on real sources present in logs
  const dynamicSources = useMemo(() => {
    const set = new Set<string>();
    for (const l of logs) {
      if (l.source) set.add(l.source);
    }
    return ["All", ...Array.from(set), "Errors Only"];
  }, [logs]);

  // Action handlers
  const handleToggleDaemon = async (daemon: FleetDaemon) => {
    if (daemon.category === "kernel") return;
    const isRunning = Boolean(daemon.pid) || daemon.status === "running";
    if (isRunning) {
      await run("stop_fleet_daemon", { id: daemon.id });
    } else {
      await run("start_fleet_daemon", { id: daemon.id });
    }
  };

  const handleRestartDaemon = async (daemon: FleetDaemon) => {
    if (daemon.category === "kernel") return;
    await run("restart_fleet_daemon", { id: daemon.id });
  };

  const handleToggleGhostRunner = async (daemon: FleetDaemon) => {
    await run("toggle_fleet_ghost_runner", {
      id: daemon.id,
      enabled: !daemon.ghostRunnerActive,
    });
  };

  const handleRestartAll = async () => {
    const bots = daemons.filter((d) => d.category === "bot_daemon" && d.status !== "missing");
    for (const bot of bots) {
      await run("restart_fleet_daemon", { id: bot.id });
    }
  };

  const handleHaltAll = async () => {
    const runningBots = daemons.filter(
      (d) => d.category === "bot_daemon" && (d.pid || d.status === "running")
    );
    for (const bot of runningBots) {
      await run("stop_fleet_daemon", { id: bot.id });
    }
  };

  const handleRunRoutine = async (rt: FleetRoutine) => {
    await run("run_fleet_routine", { id: rt.id });
  };

  const handleToggleRoutinePause = async (rt: FleetRoutine) => {
    if (rt.enabled) {
      await run("pause_workflow", { id: rt.id });
    } else {
      await run("resume_workflow", { id: rt.id });
    }
  };

  const handleClearLogs = async () => {
    await run("clear_fleet_logs");
  };

  const handleSendSignal = async () => {
    const trimmed = quickSignalInput.trim();
    if (!trimmed) return;
    const activeBot = daemons.find((d) => d.category === "bot_daemon" && (d.pid || d.status === "running"));
    const targetId = activeBot ? activeBot.name : "Fleet";
    setQuickSignalInput("");
    await run("send_fleet_daemon_input", { id: targetId, input: trimmed });
  };

  const handlePickExecutable = async () => {
    try {
      const paths = await (window as unknown as { __TAURI__?: { core?: { invoke: (cmd: string, args?: unknown) => Promise<string[]> } } })
        ?.__TAURI__?.core?.invoke("pick_paths", { kind: "program" });
      if (Array.isArray(paths) && paths.length > 0 && paths[0]) {
        setNewBotPath(paths[0]);
        if (!newBotName) {
          const parts = paths[0].split(/[/\\]/);
          const fileName = parts[parts.length - 1]?.replace(/\.(exe|cmd|bat)$/i, "") || "";
          if (fileName) setNewBotName(fileName);
        }
      }
    } catch {
      // Handled silently or path entered manually
    }
  };

  const handleAddBot = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newBotName.trim()) {
      setAddError("Bot name is required.");
      return;
    }
    setAddError("");
    await run("add_app", {
      name: newBotName.trim(),
      category: "bot_daemon",
      executablePath: newBotPath.trim() || undefined,
      executable_path: newBotPath.trim() || undefined,
    });
    setNewBotName("");
    setNewBotPath("");
    setShowAddModal(false);
  };

  const activeCount = daemons.filter((d) => d.status === "running" || d.status === "alive" || d.status === "listening").length;
  const ghostCount = daemons.filter((d) => d.ghostRunnerActive).length;

  const filteredLogs = logs.filter((l) => {
    if (logFilter === "All") return true;
    if (logFilter === "Errors Only") return l.level === "error";
    return l.source.toLowerCase().includes(logFilter.toLowerCase());
  });

  return (
    <div className="flex-1 h-full bg-[#FAFAFA] text-[#0F172A] p-6 overflow-y-auto space-y-5 font-sans select-none">
      {/* 1. TOP FLEET MISSION CONTROL HEADER & VITALS */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 shrink-0">
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
          </div>

          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="text-xl font-bold tracking-tight">Bot fleet</h1>
              <span className="px-2 py-0.5 text-[11px] font-mono font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-full">
                ● {activeCount}/{daemons.length} Daemons Active
              </span>
              <span className="px-2 py-0.5 text-[11px] font-mono bg-white border border-[#E5E5E5] text-[#334155] rounded-full">
                ☁️ {ghostCount} Cloud Ghost Runner Active
              </span>
              <span className="px-2 py-0.5 text-[11px] font-mono bg-white border border-[#E5E5E5] text-[#334155] rounded-full">
                Port: {snap?.proxyUrl?.match(/:(\d+)/)?.[1] || "4142"}
              </span>
            </div>
            <p className="text-xs text-[#64748B] mt-1">
              Supervise real background bot processes, kernel watchdog, OpenAI multiplexer, and scheduled unattended routines.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowAddModal(true)}
            className="px-3 py-1.5 text-xs font-semibold bg-white text-[#0F172A] border border-[#E5E5E5] rounded-[6px] hover:border-[#111111] transition-colors cursor-pointer flex items-center gap-1.5"
          >
            <Plus size={13} />
            <span>Link Bot / App</span>
          </button>
          <button
            onClick={handleRestartAll}
            className="px-3 py-1.5 text-xs font-semibold bg-white text-[#0F172A] border border-[#E5E5E5] rounded-[6px] hover:border-[#111111] transition-colors cursor-pointer flex items-center gap-1.5"
            title="Restart all configured bot daemons"
          >
            <RefreshCw size={13} />
            <span>Restart Daemons</span>
          </button>
          <button
            onClick={handleHaltAll}
            className="px-3 py-1.5 text-xs font-semibold bg-rose-600 text-white rounded-[6px] hover:opacity-90 transition-opacity cursor-pointer flex items-center gap-1.5"
            title="Stop all currently active bot processes"
          >
            <Square size={13} />
            <span>Halt All Bots</span>
          </button>
        </div>
      </div>

      {/* 2. MAIN SPLIT GRID: PROCESSES + ROUTINES (LEFT 7 COLS) vs LIVE LOGS (RIGHT 5 COLS) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* LEFT COLUMN: ACTIVE DAEMONS TABLE + SCHEDULED CRON ROUTINES */}
        <div className="lg:col-span-7 space-y-5">
          {/* Card A: Active Processes & Bot Daemons */}
          <div className="bg-white border border-[#E5E5E5] rounded-[6px] p-4 space-y-3 shadow-xs">
            <div className="flex items-center justify-between border-b border-[#E5E5E5] pb-2.5">
              <div className="flex items-center gap-2">
                <Cpu size={15} className="text-[#0F172A]" />
                <h2 className="text-sm font-bold text-[#0F172A]">Kernel Daemons & Bot Processes</h2>
              </div>
              <span className="text-[11px] font-mono text-[#64748B]">
                Live OS execution • Real PIDs
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-[#E5E5E5] text-[11px] text-[#64748B] font-semibold">
                    <th className="py-2 pr-2">Name</th>
                    <th className="py-2 px-2">PID</th>
                    <th className="py-2 px-2">Status</th>
                    <th className="py-2 px-2">Executable / Endpoint</th>
                    <th className="py-2 pl-2 text-right">Controls</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#F1F5F9]">
                  {daemons.map((d) => {
                    const isRunning = d.status === "running" || d.status === "alive" || d.status === "listening";
                    const isStopped = d.status === "stopped";
                    const isMissing = d.status === "missing";

                    return (
                      <tr key={d.id} className="hover:bg-slate-50/80 transition-colors">
                        <td className="py-2.5 pr-2 font-semibold text-[#0F172A]">
                          <div className="flex items-center gap-1.5">
                            <span
                              className={`w-2 h-2 rounded-full ${
                                isRunning
                                  ? "bg-[#10B981]"
                                  : isMissing
                                  ? "bg-amber-400"
                                  : "bg-slate-300"
                              }`}
                            />
                            <span>{d.name}</span>
                            {d.category === "kernel" && (
                              <span className="px-1.5 py-0.2 text-[9px] font-mono uppercase bg-slate-100 text-slate-600 rounded">
                                Kernel
                              </span>
                            )}
                          </div>
                        </td>

                        <td className="py-2.5 px-2 font-mono text-[11px] text-[#334155]">
                          {d.pid !== null && d.pid !== undefined ? d.pid : "—"}
                        </td>

                        <td className="py-2.5 px-2">
                          <span
                            className={`px-1.5 py-0.5 text-[10px] font-mono rounded ${
                              isRunning
                                ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                                : isMissing
                                ? "bg-amber-50 text-amber-700 border border-amber-200"
                                : "bg-slate-100 text-slate-600 border border-slate-200"
                            }`}
                          >
                            {d.status}
                          </span>
                        </td>

                        <td
                          className="py-2.5 px-2 font-mono text-[11px] text-[#64748B] max-w-[210px] truncate"
                          title={d.detailPathOrUrl}
                        >
                          {d.detailPathOrUrl}
                        </td>

                        <td className="py-2.5 pl-2 text-right">
                          <div className="flex items-center justify-end gap-1">
                            {d.category === "bot_daemon" ? (
                              <>
                                <button
                                  type="button"
                                  onClick={() => handleToggleGhostRunner(d)}
                                  title="Toggle 24/7 Cloud Ghost Runner (maintains execution state)"
                                  className={`px-2 py-1 text-[10px] font-mono font-semibold rounded border cursor-pointer transition-colors ${
                                    d.ghostRunnerActive
                                      ? "bg-[#111111] text-white border-[#111111]"
                                      : "bg-white text-[#64748B] border-[#E5E5E5] hover:border-[#111111]"
                                  }`}
                                >
                                  {d.ghostRunnerActive ? "☁️ Ghost ON" : "☁️ Ghost"}
                                </button>

                                <button
                                  type="button"
                                  onClick={() => go("chat")}
                                  title="Open in Chat"
                                  className="px-2 py-1 text-[10px] font-semibold bg-white text-[#64748B] border border-[#E5E5E5] rounded hover:border-[#111111] hover:text-[#0F172A] cursor-pointer"
                                >
                                  💬 Chat
                                </button>

                                <button
                                  type="button"
                                  onClick={() => handleToggleDaemon(d)}
                                  className={`px-2 py-1 text-[11px] font-semibold rounded border cursor-pointer transition-colors ${
                                    isRunning
                                      ? "bg-white text-rose-600 border-rose-200 hover:border-rose-400"
                                      : "bg-[#111111] text-white border-[#111111] hover:opacity-90"
                                  }`}
                                >
                                  {isRunning ? "Stop" : "Start"}
                                </button>

                                <button
                                  type="button"
                                  onClick={() => handleRestartDaemon(d)}
                                  className="px-2 py-1 text-[11px] font-semibold bg-white text-[#0F172A] border border-[#E5E5E5] rounded hover:border-[#111111] cursor-pointer"
                                  title="Restart Process"
                                >
                                  <RotateCw size={11} />
                                </button>
                              </>
                            ) : (
                              <span className="text-[10px] font-mono text-[#64748B] px-2 py-1">
                                System Managed
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {daemons.filter((d) => d.category === "bot_daemon").length === 0 && (
              <div className="p-4 bg-[#F8FAFC] border border-dashed border-[#E5E5E5] rounded-[6px] text-center space-y-2 my-2">
                <p className="text-xs font-semibold text-[#0F172A]">No External Bot Daemons Linked</p>
                <p className="text-[11px] text-[#64748B] max-w-sm mx-auto">
                  Only core kernel services are running. Link external bot processes (e.g., Grokbot, Hermes, Claude CLI) to supervise them here.
                </p>
                <button
                  type="button"
                  onClick={() => setShowAddModal(true)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-[#111111] text-white rounded-[6px] hover:opacity-90 cursor-pointer shadow-xs"
                >
                  <Plus size={13} />
                  <span>Link Bot Executable</span>
                </button>
              </div>
            )}
          </div>

          {/* Card B: Scheduled Bot Routines (Unattended Cron) */}
          <div className="bg-white border border-[#E5E5E5] rounded-[6px] p-4 space-y-3 shadow-xs">
            <div className="flex items-center justify-between border-b border-[#E5E5E5] pb-2.5">
              <div>
                <h2 className="text-sm font-bold text-[#0F172A]">Scheduled Bot Routines (Unattended Cron)</h2>
                <p className="text-[11px] text-[#64748B]">
                  Real automated tasks executed by your Bot Fleet and agent threads on cron schedules
                </p>
              </div>
              <span className="text-[11px] font-mono text-emerald-700 font-semibold">
                ● Scheduler Active
              </span>
            </div>

            {routines.length === 0 ? (
              <div className="p-6 bg-[#F8FAFC] border border-dashed border-[#E5E5E5] rounded-[6px] text-center space-y-2">
                <p className="text-xs font-semibold text-[#0F172A]">No Unattended Routines Configured</p>
                <p className="text-[11px] text-[#64748B] max-w-md mx-auto">
                  Routines execute unattended on automated schedules (cron or interval) even when you are away. You can schedule any chat thread or workflow from the Chat workspace.
                </p>
                <button
                  type="button"
                  onClick={() => go("chat")}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-[#111111] text-white rounded-[6px] hover:opacity-90 cursor-pointer shadow-xs"
                >
                  <MessageSquare size={13} />
                  <span>Open Chat to Schedule Routine</span>
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                {routines.map((rt) => (
                  <div
                    key={rt.id}
                    className="p-3 bg-[#F8FAFC] border border-[#E5E5E5] rounded-[6px] flex flex-wrap items-center justify-between gap-2 text-xs"
                  >
                    <div className="space-y-0.5">
                      <div className="font-bold text-[#0F172A]">{rt.title}</div>
                      <div className="text-[11px] font-mono text-[#64748B]">
                        Bot: {rt.botHandle} • Schedule: {rt.schedule} • Updated: {rt.lastRun}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => handleRunRoutine(rt)}
                        className="px-2.5 py-1 text-[11px] font-semibold bg-[#111111] text-white rounded-[4px] hover:opacity-90 cursor-pointer flex items-center gap-1"
                      >
                        <Play size={10} />
                        <span>Run Now</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleToggleRoutinePause(rt)}
                        className={`px-2 py-1 text-[11px] font-mono font-semibold rounded border cursor-pointer ${
                          rt.enabled
                            ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                            : "bg-white text-[#64748B] border-[#E5E5E5]"
                        }`}
                      >
                        {rt.enabled ? "Active" : "Paused"}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* RIGHT COLUMN (5 COLS): INTERACTIVE LIVE STDOUT / STDERR & PROXY STREAM */}
        <div className="lg:col-span-5 bg-white border border-[#E5E5E5] rounded-[6px] p-4 flex flex-col justify-between space-y-3 shadow-xs">
          <div className="space-y-3">
            <div className="flex items-center justify-between border-b border-[#E5E5E5] pb-2.5">
              <div className="flex items-center gap-2">
                <Terminal size={15} className="text-[#0F172A]" />
                <h2 className="text-sm font-bold text-[#0F172A]">Live Fleet Logs (stdout / IPC)</h2>
              </div>
              {logs.length > 0 && (
                <button
                  type="button"
                  onClick={handleClearLogs}
                  className="px-2 py-0.5 text-[11px] border border-[#E5E5E5] rounded hover:bg-slate-50 cursor-pointer text-[#64748B] hover:text-[#0F172A]"
                >
                  Clear Logs
                </button>
              )}
            </div>

            {/* Dynamic Source Filter Pills */}
            <div className="flex flex-wrap gap-1">
              {dynamicSources.map((src) => (
                <button
                  key={src}
                  type="button"
                  onClick={() => setLogFilter(src)}
                  className={`px-2 py-0.5 text-[11px] font-mono rounded border cursor-pointer transition-colors ${
                    logFilter === src
                      ? "bg-[#111111] text-white border-[#111111]"
                      : "bg-[#F8FAFC] text-[#64748B] border-[#E5E5E5] hover:border-[#111111]"
                  }`}
                >
                  {src}
                </button>
              ))}
            </div>

            {/* Real-Time Monospace Log Stream */}
            <div className="p-3 bg-[#F8FAFC] border border-[#E5E5E5] rounded-[6px] font-mono text-[11px] space-y-2 max-h-[420px] min-h-[240px] overflow-y-auto">
              {filteredLogs.length === 0 ? (
                <div className="py-12 text-center text-[#64748B] space-y-1">
                  <p className="font-semibold text-xs text-[#334155]">No Fleet Logs Recorded Yet</p>
                  <p className="text-[11px] max-w-xs mx-auto">
                    Live process logs, daemon stdout/stderr, and multiplexer events will stream here automatically.
                  </p>
                </div>
              ) : (
                filteredLogs.map((l) => (
                  <div
                    key={l.id}
                    className="border-b border-[#E5E5E5]/60 pb-1.5 last:border-none flex items-start justify-between gap-2"
                  >
                    <div className="min-w-0">
                      <span className="text-[#64748B] mr-1.5">{l.time}</span>
                      <span className="font-bold text-[#0F172A] mr-1.5">[{l.source}]</span>
                      <span
                        className={
                          l.level === "warn"
                            ? "text-amber-700"
                            : l.level === "error"
                            ? "text-rose-600 font-semibold"
                            : "text-[#0F172A]"
                        }
                      >
                        {l.message}
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Quick Daemon Command Dispatch Input */}
          <div className="pt-2 border-t border-[#E5E5E5] flex gap-1.5">
            <input
              value={quickSignalInput}
              onChange={(e) => setQuickSignalInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  void handleSendSignal();
                }
              }}
              placeholder="Send stdin signal or ping to active daemon..."
              className="flex-1 px-2.5 py-1.5 text-xs font-mono border border-[#E5E5E5] rounded-[6px] outline-none focus:border-[#111111] bg-white text-[#0F172A]"
            />
            <button
              type="button"
              onClick={() => void handleSendSignal()}
              className="px-3 py-1.5 text-xs font-semibold bg-[#111111] text-white rounded-[6px] hover:opacity-90 cursor-pointer flex items-center gap-1"
            >
              <Send size={12} />
              <span>Send</span>
            </button>
          </div>
        </div>
      </div>

      {/* Modal: Link a Real Bot / App */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-[8px] border border-[#E5E5E5] shadow-xl w-full max-w-md p-5 space-y-4">
            <div className="flex items-center justify-between border-b border-[#E5E5E5] pb-2.5">
              <h3 className="text-sm font-bold text-[#0F172A]">Link Local Bot Daemon</h3>
              <button
                type="button"
                onClick={() => {
                  setShowAddModal(false);
                  setAddError("");
                }}
                className="p-1 text-[#64748B] hover:text-[#0F172A] rounded cursor-pointer"
              >
                <X size={15} />
              </button>
            </div>

            <form onSubmit={handleAddBot} className="space-y-3 text-xs">
              {addError && (
                <div className="p-2 bg-rose-50 border border-rose-200 text-rose-700 rounded text-xs flex items-center gap-1.5">
                  <AlertTriangle size={13} />
                  <span>{addError}</span>
                </div>
              )}

              <div>
                <label className="block font-semibold text-[#0F172A] mb-1">Bot Name</label>
                <input
                  type="text"
                  value={newBotName}
                  onChange={(e) => setNewBotName(e.target.value)}
                  placeholder="e.g. Grok Bot, Hermes Agent, Claude CLI"
                  className="w-full px-2.5 py-1.5 border border-[#E5E5E5] rounded-[6px] outline-none focus:border-[#111111]"
                  autoFocus
                />
              </div>

              <div>
                <label className="block font-semibold text-[#0F172A] mb-1">
                  Executable Path (Windows .exe, .bat, or path)
                </label>
                <div className="flex gap-1.5">
                  <input
                    type="text"
                    value={newBotPath}
                    onChange={(e) => setNewBotPath(e.target.value)}
                    placeholder="C:\Program Files\...\app.exe"
                    className="flex-1 px-2.5 py-1.5 border border-[#E5E5E5] rounded-[6px] outline-none focus:border-[#111111] font-mono text-[11px]"
                  />
                  <button
                    type="button"
                    onClick={handlePickExecutable}
                    className="px-2.5 py-1.5 border border-[#E5E5E5] rounded-[6px] hover:border-[#111111] flex items-center gap-1 cursor-pointer"
                    title="Browse disk for executable"
                  >
                    <FolderOpen size={13} />
                    <span>Browse</span>
                  </button>
                </div>
              </div>

              <div className="pt-2 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="px-3 py-1.5 border border-[#E5E5E5] rounded-[6px] text-[#64748B] hover:text-[#0F172A] cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-3 py-1.5 bg-[#111111] text-white font-semibold rounded-[6px] hover:opacity-90 cursor-pointer"
                >
                  Save & Link Bot
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
