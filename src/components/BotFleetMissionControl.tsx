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
import { isTauri, pickPaths } from "../api";
import { useRonic } from "../store";

export interface FleetDaemon {
  id: string;
  name: string;
  category: "kernel" | "bot_daemon";
  pid: number | null;
  status: "alive" | "listening" | "running" | "ready" | "stopped" | "missing";
  detailPathOrUrl: string;
  ghostRunnerActive: boolean;
  source: "kernel" | "app" | "profile";
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
  const snap = useRonic((s) => s.snap);
  const run = useRonic((s) => s.run);
  const go = useRonic((s) => s.go);

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
      status: watchdogProc ? "alive" : "stopped",
      detailPathOrUrl: watchdogProc?.detail || "500ms Rust anti-hang heartbeat & SQLite WAL guard",
      ghostRunnerActive: false,
      source: "kernel",
    });

    // Kernel loopback proxy. The snapshot names this process "loopback-proxy".
    const loopbackProc = snap?.processes?.find((p) => p.name === "loopback_proxy" || p.name === "loopback-proxy");
    list.push({
      id: "loopback_proxy",
      name: "openai_multiplexer",
      category: "kernel",
      pid: loopbackProc?.pid ?? null,
      status: loopbackProc?.health === "listening" ? "listening" : loopbackProc ? "ready" : "stopped",
      detailPathOrUrl: loopbackProc?.detail || snap?.proxyUrl || "127.0.0.1:4142 loopback endpoint router",
      ghostRunnerActive: false,
      source: "kernel",
    });

    // External Bot Daemons & Linked Executables from snap.apps
    const ghostList = snap?.settings?.ghostRunners ?? [];
    const isGhost = (id: string, name: string) =>
      ghostList.some((g: string) => g.toLowerCase() === id.toLowerCase() || g.toLowerCase() === name.toLowerCase());

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
        source: "app",
      });
    }

    // Bot Profiles from snap.profiles
    if (snap?.profiles) {
      for (const bot of snap.profiles) {
        if (!list.some((d) => d.id === bot.id || d.name.toLowerCase() === bot.handle.toLowerCase())) {
          list.push({
            id: bot.id,
            name: bot.displayName || bot.handle,
            category: "bot_daemon",
            pid: bot.activePid ?? null,
            status: bot.runStatus === "running" ? "running" : "ready",
            detailPathOrUrl: bot.commandOrUrl || `${bot.engine} (${bot.harnessLaneId || "lane"})`,
            ghostRunnerActive: isGhost(bot.id, bot.handle) || isGhost(bot.id, bot.displayName || ""),
            source: "profile",
          });
        }
      }
    }

    return list;
  }, [snap?.processes, snap?.apps, snap?.profiles, snap?.settings?.ghostRunners, snap?.proxyUrl]);

  // 2. Scheduled Bot Routines from real cron tasks / workflows
  const routines: FleetRoutine[] = useMemo(() => {
    if (!snap?.workflows) return [];
    return snap.workflows.map((wf) => ({
      id: wf.id,
      title: wf.name || "Unattended Routine",
      botHandle: "workflow",
      schedule: wf.triggers?.[0] || "Manual",
      lastRun: wf.updatedAt ? new Date(wf.updatedAt).toLocaleTimeString() : "Never",
      enabled: wf.currentStatus !== "paused",
    }));
  }, [snap?.workflows]);

  // 3. Real Fleet Logs & Telemetry
  const logs: FleetLogEntry[] = useMemo(() => {
    return (snap?.fleetLogs ?? []).map((entry) => ({
      id: entry.id,
      time: new Date(entry.createdAt).toLocaleTimeString(),
      source: entry.botName || "Fleet",
      level: entry.stream === "stderr" ? "error" : "info",
      message: entry.line,
    }));
  }, [snap?.fleetLogs]);

  const dynamicSources = useMemo(() => {
    const s = new Set<string>(["All", "Errors Only"]);
    logs.forEach((l) => s.add(l.source));
    return Array.from(s);
  }, [logs]);

  // 4. Real Actions wired to store `run` commands
  const handleToggleDaemon = async (d: FleetDaemon) => {
    const running = d.status === "running" || d.status === "alive";
    if (d.source === "profile") {
      await run("set_bot_run", { id: d.id, action: running ? "stop" : "start" });
      return;
    }
    if (running) await run("stop_fleet_daemon", { id: d.id });
    else await run("start_fleet_daemon", { id: d.id });
  };

  const handleRestartDaemon = async (d: FleetDaemon) => {
    if (d.source === "profile") {
      await run("set_bot_run", { id: d.id, action: "stop" });
      await run("set_bot_run", { id: d.id, action: "start" });
      return;
    }
    await run("restart_fleet_daemon", { id: d.id });
  };

  const handleToggleGhostRunner = async (d: FleetDaemon) => {
    await run("toggle_fleet_ghost_runner", { id: d.id, enabled: !d.ghostRunnerActive });
  };

  const handleRestartAll = async () => {
    const bots = daemons.filter((d) => d.category === "bot_daemon" && d.status !== "missing");
    for (const bot of bots) {
      await handleRestartDaemon(bot);
    }
  };

  const handleHaltAll = async () => {
    const runningBots = daemons.filter(
      (d) => d.category === "bot_daemon" && (d.pid || d.status === "running")
    );
    for (const bot of runningBots) {
      if (bot.source === "profile") await run("set_bot_run", { id: bot.id, action: "stop" });
      else await run("stop_fleet_daemon", { id: bot.id });
    }
  };

  const handleRunRoutine = async (rt: FleetRoutine) => {
    await run("run_workflow", { id: rt.id });
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
    const targetId = activeBot ? activeBot.id : "";
    setQuickSignalInput("");
    await run("send_fleet_daemon_input", { id: targetId, input: trimmed });
  };

  const handlePickExecutable = async () => {
    try {
      if (!isTauri()) {
        setAddError("The file picker runs in the desktop app.");
        return;
      }
      const paths = await pickPaths("program");
      if (paths[0]) {
        setNewBotPath(paths[0]);
        if (!newBotName) {
          const parts = paths[0].split(/[/\\]/);
          const fileName = parts[parts.length - 1]?.replace(/\.(exe|cmd|bat)$/i, "") || "";
          if (fileName) setNewBotName(fileName);
        }
      }
    } catch (error) {
      setAddError(error instanceof Error ? error.message : "Could not open the file picker.");
    }
  };

  const handleAddBot = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newBotName.trim()) {
      setAddError("Bot name is required.");
      return;
    }
    setAddError("");
    const saved = await run("add_app", {
      name: newBotName.trim(),
      category: "bot_daemon",
      executablePath: newBotPath.trim() || undefined,
    });
    if (!saved) return;
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
    <div className="flex-1 h-full bg-[#eceef2] p-3 sm:p-5 lg:p-6 overflow-y-auto select-none flex flex-col">
      {/* ─── MODAL CONTAINER (MARKETPLACE DESIGN SYSTEM) ─── */}
      <div className="w-full max-w-[1560px] flex-1 min-h-[660px] bg-white rounded-3xl shadow-[0_12px_40px_-8px_rgba(0,0,0,0.06),0_2px_8px_-1px_rgba(0,0,0,0.03)] border border-slate-200/70 flex flex-col mx-auto overflow-hidden transition-all duration-300">
        
        {/* ─── TOP HEADER ─── */}
        <div className="p-5 sm:p-7 pb-4 space-y-4 border-b border-slate-100 bg-white">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => go("chat")}
                className="text-slate-500 hover:text-slate-800 hover:bg-slate-100 px-3 py-1.5 rounded-xl transition-colors cursor-pointer flex items-center gap-1.5 text-xs font-semibold"
                title="Back to Chat (Alt+Left)"
              >
                <ArrowLeft size={15} />
                <span>Back</span>
              </button>
              <div>
                <div className="flex items-center gap-2.5 flex-wrap">
                  <h1 className="text-lg sm:text-xl font-bold text-slate-900 tracking-tight">Bot fleet &amp; mission control</h1>
                  <span className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-semibold rounded-full border bg-emerald-50 text-emerald-800 border-emerald-300 shadow-xs">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                    {activeCount}/{daemons.length} Daemons Active
                  </span>
                  <span className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-mono rounded-full border bg-slate-100 text-slate-700 border-slate-200">
                    ☁️ {ghostCount} Ghost Runner
                  </span>
                  <span className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-mono rounded-full border bg-slate-100 text-slate-700 border-slate-200">
                    Port: {snap?.proxyUrl?.match(/:(\d+)/)?.[1] || "4142"}
                  </span>
                </div>
                <p className="text-xs text-slate-500 mt-1 max-w-2xl leading-relaxed">
                  Supervise background bot processes, kernel watchdog, OpenAI multiplexer, and unattended cron routines with real process isolation.
                </p>
              </div>
            </div>

            {/* Quick Actions with Matte Black & Secondary Buttons */}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowAddModal(true)}
                className="px-4 py-2 text-xs font-semibold bg-zinc-800 hover:bg-zinc-700 text-white rounded-full transition-all cursor-pointer shadow-xs active:scale-95 flex items-center gap-1.5 border border-zinc-700/50"
              >
                <Plus size={13} />
                <span>Link Bot / App</span>
              </button>
              <button
                type="button"
                onClick={handleRestartAll}
                className="px-4 py-2 text-xs font-semibold bg-slate-100 hover:bg-slate-200 text-slate-700 hover:text-slate-900 rounded-full transition-all cursor-pointer border border-slate-200/80 flex items-center gap-1.5 active:scale-95"
                title="Restart all configured bot daemons"
              >
                <RefreshCw size={13} />
                <span>Restart Daemons</span>
              </button>
              <button
                type="button"
                onClick={handleHaltAll}
                className="px-4 py-2 text-xs font-semibold bg-rose-50 text-rose-700 border border-rose-200/90 hover:bg-rose-100 rounded-full transition-all cursor-pointer flex items-center gap-1.5 active:scale-95"
                title="Stop all currently active bot processes"
              >
                <Square size={13} />
                <span>Halt All Bots</span>
              </button>
            </div>
          </div>
        </div>

        {/* ─── BODY (SPLIT GRID: PROCESSES + TELEMETRY LOGS) ─── */}
        <div className="flex-1 overflow-y-auto p-5 sm:p-7 bg-white">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            
            {/* Left 7 Columns: Daemons Table & Routines */}
            <div className="lg:col-span-7 space-y-6">
              
              {/* Card A: Active Processes & Bot Daemons */}
              <div className="rounded-2xl border border-slate-200/90 bg-white p-5 sm:p-6 shadow-xs space-y-4">
                <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                  <div className="flex items-center gap-2">
                    <Cpu size={16} className="text-slate-800" />
                    <h3 className="text-sm font-bold text-slate-900">Kernel Daemons &amp; Bot Processes</h3>
                  </div>
                  <span className="text-[11px] font-mono text-slate-500 bg-slate-50 px-2.5 py-0.5 rounded-full border border-slate-200">
                    Live OS PIDs
                  </span>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-slate-100 text-[11px] text-slate-400 font-semibold uppercase tracking-wider">
                        <th className="py-2.5 pr-2">Daemon / Process</th>
                        <th className="py-2.5 px-2">PID</th>
                        <th className="py-2.5 px-2">Status</th>
                        <th className="py-2.5 px-2">Target / Endpoint</th>
                        <th className="py-2.5 pl-2 text-right">Controls</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {daemons.map((d) => {
                        const isRunning = d.status === "running" || d.status === "alive" || d.status === "listening";
                        const isStopped = d.status === "stopped";
                        const isMissing = d.status === "missing";

                        return (
                          <tr key={d.id} className="hover:bg-slate-50/80 transition-colors">
                            <td className="py-3 pr-2 font-semibold text-slate-900">
                              <div className="flex items-center gap-2">
                                <span
                                  className={`w-2 h-2 rounded-full ${
                                    isRunning
                                      ? "bg-emerald-500"
                                      : isMissing
                                      ? "bg-amber-400"
                                      : "bg-slate-300"
                                  }`}
                                />
                                <span>{d.name}</span>
                                {d.category === "kernel" && (
                                  <span className="px-1.5 py-0.5 text-[9px] font-mono font-bold uppercase bg-slate-100 text-slate-600 rounded-md">
                                    Kernel
                                  </span>
                                )}
                              </div>
                            </td>

                            <td className="py-3 px-2 font-mono text-xs text-slate-600">
                              {d.pid !== null && d.pid !== undefined ? d.pid : "—"}
                            </td>

                            <td className="py-3 px-2">
                              <span
                                className={`px-2 py-0.5 text-[11px] font-mono font-semibold rounded-full border ${
                                  isRunning
                                    ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                                    : isMissing
                                    ? "bg-amber-50 text-amber-700 border-amber-200"
                                    : "bg-slate-100 text-slate-600 border-slate-200"
                                }`}
                              >
                                {d.status}
                              </span>
                            </td>

                            <td
                              className="py-3 px-2 font-mono text-[11px] text-slate-500 max-w-[210px] truncate"
                              title={d.detailPathOrUrl}
                            >
                              {d.detailPathOrUrl}
                            </td>

                            <td className="py-3 pl-2 text-right">
                              <div className="flex items-center justify-end gap-1.5">
                                {d.category === "bot_daemon" ? (
                                  <>
                                    <button
                                      type="button"
                                      onClick={() => handleToggleGhostRunner(d)}
                                      title="Toggle 24/7 Cloud Ghost Runner"
                                      className={`px-2.5 py-1 text-[11px] font-mono font-semibold rounded-full border cursor-pointer transition-all active:scale-95 ${
                                        d.ghostRunnerActive
                                          ? "bg-zinc-800 text-white border-zinc-700 shadow-xs"
                                          : "bg-slate-100 text-slate-600 border-slate-200 hover:bg-slate-200/80"
                                      }`}
                                    >
                                      {d.ghostRunnerActive ? "☁️ Ghost ON" : "☁️ Ghost"}
                                    </button>

                                    <button
                                      type="button"
                                      onClick={() => go("chat")}
                                      title="Open in Chat"
                                      className="px-2.5 py-1 text-[11px] font-semibold bg-slate-100 text-slate-700 border border-slate-200 rounded-full hover:bg-slate-200/80 transition cursor-pointer"
                                    >
                                      💬 Chat
                                    </button>

                                    <button
                                      type="button"
                                      onClick={() => handleToggleDaemon(d)}
                                      className={`px-3 py-1 text-[11px] font-semibold rounded-full border cursor-pointer transition-all active:scale-95 ${
                                        isRunning
                                          ? "bg-rose-50 text-rose-700 border-rose-200 hover:bg-rose-100"
                                          : "bg-zinc-800 hover:bg-zinc-700 text-white border-zinc-700/50 shadow-xs"
                                      }`}
                                    >
                                      {isRunning ? "Stop" : "Start"}
                                    </button>

                                    <button
                                      type="button"
                                      onClick={() => handleRestartDaemon(d)}
                                      className="p-1.5 text-slate-500 bg-slate-100 border border-slate-200 rounded-full hover:bg-slate-200 hover:text-slate-800 cursor-pointer transition"
                                      title="Restart Process"
                                    >
                                      <RotateCw size={12} />
                                    </button>
                                  </>
                                ) : (
                                  <span className="text-[11px] font-mono text-slate-400 px-2 py-0.5">
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
                  <div className="p-6 bg-slate-50/70 border border-dashed border-slate-200 rounded-2xl text-center space-y-2 my-2">
                    <p className="text-xs font-bold text-slate-900">No External Bot Daemons Linked</p>
                    <p className="text-[11px] text-slate-500 max-w-sm mx-auto">
                      Only core kernel services are running. Link external bot processes (e.g., Grokbot, Hermes, Claude CLI) to supervise them here.
                    </p>
                    <button
                      type="button"
                      onClick={() => setShowAddModal(true)}
                      className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold bg-zinc-800 hover:bg-zinc-700 text-white rounded-full transition-all cursor-pointer shadow-xs active:scale-95 border border-zinc-700/50"
                    >
                      <Plus size={13} />
                      <span>Link Bot Executable</span>
                    </button>
                  </div>
                )}
              </div>

              {/* Card B: Scheduled Bot Routines (Unattended Cron) */}
              <div className="rounded-2xl border border-slate-200/90 bg-white p-5 sm:p-6 shadow-xs space-y-4">
                <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                  <div>
                    <h3 className="text-sm font-bold text-slate-900">Scheduled Bot Routines (Unattended Cron)</h3>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Automated tasks executed by your Bot Fleet on cron or interval schedules.
                    </p>
                  </div>
                  <span className="text-[11px] font-mono font-semibold px-2.5 py-1 bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-full">
                    ● Scheduler Active
                  </span>
                </div>

                {routines.length === 0 ? (
                  <div className="p-6 bg-slate-50/70 border border-dashed border-slate-200 rounded-2xl text-center space-y-2">
                    <p className="text-xs font-bold text-slate-900">No Unattended Routines Configured</p>
                    <p className="text-[11px] text-slate-500 max-w-md mx-auto">
                      Routines execute unattended on automated schedules even when you are away. You can schedule any chat thread or workflow from the Chat workspace.
                    </p>
                    <button
                      type="button"
                      onClick={() => go("chat")}
                      className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold bg-zinc-800 hover:bg-zinc-700 text-white rounded-full transition-all cursor-pointer shadow-xs active:scale-95 border border-zinc-700/50"
                    >
                      <MessageSquare size={13} />
                      <span>Open Chat to Schedule Routine</span>
                    </button>
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    {routines.map((rt) => (
                      <div
                        key={rt.id}
                        className="p-3.5 bg-slate-50 rounded-2xl border border-slate-200/80 flex flex-wrap items-center justify-between gap-3 text-xs"
                      >
                        <div className="space-y-1">
                          <div className="font-bold text-slate-900">{rt.title}</div>
                          <div className="text-[11px] font-mono text-slate-500">
                            Bot: {rt.botHandle} • Schedule: {rt.schedule} • Updated: {rt.lastRun}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => handleRunRoutine(rt)}
                            className="px-3 py-1.5 text-xs font-semibold bg-zinc-800 hover:bg-zinc-700 text-white rounded-full transition-all cursor-pointer flex items-center gap-1 shadow-xs border border-zinc-700/50"
                          >
                            <Play size={11} />
                            <span>Run Now</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => handleToggleRoutinePause(rt)}
                            className={`px-3 py-1 text-xs font-mono font-semibold rounded-full border cursor-pointer transition ${
                              rt.enabled
                                ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                                : "bg-white text-slate-500 border-slate-200"
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

            {/* Right 5 Columns: Interactive Live Logs */}
            <div className="lg:col-span-5 rounded-2xl border border-slate-200/90 bg-white p-5 sm:p-6 shadow-xs flex flex-col justify-between space-y-4">
              <div className="space-y-4">
                <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                  <div className="flex items-center gap-2">
                    <Terminal size={16} className="text-slate-800" />
                    <h3 className="text-sm font-bold text-slate-900">Live Fleet Logs (stdout / IPC)</h3>
                  </div>
                  {logs.length > 0 && (
                    <button
                      type="button"
                      onClick={handleClearLogs}
                      className="px-2.5 py-1 text-xs font-semibold rounded-full border border-slate-200 text-slate-500 hover:bg-slate-50 hover:text-slate-900 cursor-pointer transition"
                    >
                      Clear Logs
                    </button>
                  )}
                </div>

                {/* Source Filter Pills */}
                <div className="flex flex-wrap gap-1.5">
                  {dynamicSources.map((src) => (
                    <button
                      key={src}
                      type="button"
                      onClick={() => setLogFilter(src)}
                      className={`px-3 py-1 text-[11px] font-mono font-semibold rounded-full border cursor-pointer transition-all ${
                        logFilter === src
                          ? "bg-zinc-800 text-white border-zinc-700 shadow-xs"
                          : "bg-slate-100 text-slate-600 border-slate-200 hover:bg-slate-200/70"
                      }`}
                    >
                      {src}
                    </button>
                  ))}
                </div>

                {/* Monospace Log Stream */}
                <div className="p-4 bg-[#1e2025] border border-slate-800 rounded-2xl font-mono text-[11px] space-y-2 max-h-[460px] min-h-[280px] overflow-y-auto text-slate-200 shadow-inner">
                  {filteredLogs.length === 0 ? (
                    <div className="py-12 text-center text-slate-500 space-y-1">
                      <p className="font-semibold text-xs text-slate-400">No Fleet Logs Recorded Yet</p>
                      <p className="text-[11px] max-w-xs mx-auto">
                        Live process logs, daemon stdout/stderr, and multiplexer events will stream here automatically.
                      </p>
                    </div>
                  ) : (
                    filteredLogs.map((l) => (
                      <div
                        key={l.id}
                        className="border-b border-slate-800/80 pb-1.5 last:border-none flex items-start justify-between gap-2"
                      >
                        <div className="min-w-0">
                          <span className="text-slate-400 mr-2">{l.time}</span>
                          <span className="font-bold text-slate-200 mr-2">[{l.source}]</span>
                          <span
                            className={
                              l.level === "warn"
                                ? "text-amber-400"
                                : l.level === "error"
                                ? "text-rose-400 font-semibold"
                                : "text-slate-300"
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

              {/* Quick Operator Note */}
              <div className="pt-3 border-t border-slate-100 flex gap-2">
                <input
                  type="text"
                  value={quickSignalInput}
                  onChange={(e) => setQuickSignalInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      void handleSendSignal();
                    }
                  }}
                  placeholder="Post an operator note to the fleet log..."
                  className="flex-1 px-3.5 py-2 text-xs font-mono border border-slate-200 rounded-full outline-none focus:ring-2 focus:ring-slate-200 bg-slate-50 text-slate-900"
                />
                <button
                  type="button"
                  onClick={() => void handleSendSignal()}
                  title="Saves note to fleet log"
                  className="px-4 py-2 text-xs font-semibold bg-zinc-800 hover:bg-zinc-700 text-white rounded-full cursor-pointer flex items-center gap-1.5 shadow-xs border border-zinc-700/50"
                >
                  <Send size={12} />
                  <span>Post</span>
                </button>
              </div>
            </div>

          </div>
        </div>

      </div>

      {/* Modal: Link a Real Bot / App */}
      {showAddModal && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl border border-slate-200 shadow-2xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <h3 className="text-sm font-bold text-slate-900">Link Local Bot Daemon</h3>
              <button
                type="button"
                onClick={() => {
                  setShowAddModal(false);
                  setAddError("");
                }}
                className="p-1 text-slate-400 hover:text-slate-700 rounded-full cursor-pointer"
              >
                <X size={16} />
              </button>
            </div>

            <form onSubmit={handleAddBot} className="space-y-4 text-xs">
              {addError && (
                <div className="p-3 bg-rose-50 border border-rose-200 text-rose-700 rounded-2xl text-xs flex items-center gap-2">
                  <AlertTriangle size={14} />
                  <span>{addError}</span>
                </div>
              )}

              <div>
                <label className="block font-semibold text-slate-800 mb-1.5">Bot Name</label>
                <input
                  type="text"
                  value={newBotName}
                  onChange={(e) => setNewBotName(e.target.value)}
                  placeholder="e.g. Grok Bot, Hermes Agent, Claude CLI"
                  className="w-full px-3.5 py-2 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-slate-200 text-xs"
                  autoFocus
                />
              </div>

              <div>
                <label className="block font-semibold text-slate-800 mb-1.5">
                  Executable Path (Windows .exe, .bat, or CLI binary)
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newBotPath}
                    onChange={(e) => setNewBotPath(e.target.value)}
                    placeholder="C:\Program Files\...\app.exe"
                    className="flex-1 px-3.5 py-2 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-slate-200 font-mono text-[11px]"
                  />
                  <button
                    type="button"
                    onClick={handlePickExecutable}
                    className="px-3.5 py-2 border border-slate-200 bg-slate-50 text-slate-700 rounded-xl hover:bg-slate-100 flex items-center gap-1.5 cursor-pointer font-semibold"
                    title="Browse disk for executable"
                  >
                    <FolderOpen size={14} />
                    <span>Browse</span>
                  </button>
                </div>
              </div>

              <div className="pt-2 flex justify-end gap-2.5">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="px-4 py-2 border border-slate-200 rounded-full text-slate-600 hover:text-slate-900 cursor-pointer font-semibold"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 bg-zinc-800 hover:bg-zinc-700 text-white font-semibold rounded-full cursor-pointer shadow-xs border border-zinc-700/50"
                >
                  Save &amp; Link Bot
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
