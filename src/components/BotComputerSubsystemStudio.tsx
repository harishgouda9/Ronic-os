import React, { useEffect, useState } from "react";
import { ArrowLeft, Monitor, Eye, Key, Play, Square, RefreshCw, Plus, X, Search, Terminal } from "lucide-react";
import { invokeRaw, isTauri } from "../api";
import { useRonic } from "../store";
import type { BotProfile } from "../types";
import ComputerBrowserStudio from "./ComputerBrowserStudio";
import MultiBotSquadComputerGrid from "./MultiBotSquadComputerGrid";

type Tab = "mini_windows" | "som_vision" | "os_uia" | "squad" | "classic";

interface BotMiniWindowInstance {
  botId: string;
  botHandle: string;
  windowLabel: string;
  currentUrlOrApp: string;
  mode: string;
  virtualCursorXy: number[];
  activeDriver: string;
  status: string;
}

interface MiniWindowNode {
  id: number;
  tag: string;
  label: string;
  x: number;
  y: number;
}

interface MiniWindowHit {
  windowLabel: string;
  url: string;
  title: string;
  text: string;
  nodes: MiniWindowNode[];
  ms: number;
}

interface UIAControlNode {
  markId: number;
  controlType: string;
  name: string;
  automationId: string;
  className: string;
  bounds: number[];
  centerXy: number[];
  supportsBackgroundInvoke: boolean;
  supportsBackgroundValue: boolean;
  origin: string;
}

interface SoMAnnotatedSnapshot {
  windowTitle: string;
  captureSource: string;
  annotatedImageBase64: string;
  totalMarks: number;
  captureMs: number;
  markRegistry: UIAControlNode[];
}

const TABS: [Tab, string][] = [
  ["mini_windows", "1. Per-Bot Mini Windows"],
  ["squad", "2. Multi-Bot Squad Grid"],
  ["som_vision", "3. Set-of-Marks Vision"],
  ["os_uia", "4. Windows OS UIAutomation"],
  ["classic", "5. Classic Browser & Terminal"],
];

export default function BotComputerSubsystemStudio() {
  const snap = useRonic((s) => s.snap);
  const go = useRonic((s) => s.go);
  const setToast = useRonic((s) => s.setToast);

  const [tab, setTab] = useState<Tab>("mini_windows");
  const [halted, setHalted] = useState(false);
  const [banner, setBanner] = useState(
    "Zero-cursor-theft computer subsystems ready. Mini-computer windows, live SoM vision, and native OS UIA drivers active."
  );

  const profiles = snap?.profiles ?? [];

  const setBoth = (message: string) => {
    setBanner(message);
    setToast(message);
  };

  // Spacebar = global emergency halt while this screen is open
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase() ?? "";
      if (tag === "input" || tag === "textarea" || tag === "select" || target?.isContentEditable) return;
      if (event.code !== "Space") return;
      event.preventDefault();
      void toggleHalt();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const toggleHalt = async () => {
    if (!isTauri()) return;
    try {
      const message = await invokeRaw<string>("trigger_emergency_computer_halt");
      setHalted(await invokeRaw<boolean>("computer_halt_status"));
      setBoth(message);
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error));
    }
  };

  useEffect(() => {
    void (async () => {
      if (!isTauri()) return;
      try {
        setHalted(await invokeRaw<boolean>("computer_halt_status"));
      } catch {
        /* kernel not ready yet */
      }
    })();
  }, []);

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
                  <h1 className="text-lg sm:text-xl font-bold text-slate-900 tracking-tight">Computer &amp; browser subsystems</h1>
                  <span className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-semibold rounded-full border bg-emerald-50 text-emerald-800 border-emerald-300 shadow-xs">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                    Zero cursor theft
                  </span>
                  <span className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-mono rounded-full border bg-slate-100 text-slate-700 border-slate-200">
                    UIA &lt;20ms • SoM &lt;15ms
                  </span>
                </div>
                <p className="text-xs text-slate-500 mt-1 max-w-2xl leading-relaxed">{banner}</p>
              </div>
            </div>

            {/* Emergency Halt Button */}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void toggleHalt()}
                className={`px-4 py-2 text-xs font-semibold rounded-full transition-all cursor-pointer shadow-xs active:scale-95 flex items-center gap-1.5 ${
                  halted
                    ? "bg-emerald-600 text-white hover:bg-emerald-700"
                    : "bg-rose-50 text-rose-700 border border-rose-200/90 hover:bg-rose-100"
                }`}
              >
                <Square size={12} />
                <span>{halted ? "▶ Resume bot computers" : "🛑 [Spacebar] Emergency halt all"}</span>
              </button>
            </div>
          </div>

          {/* Tab Navigation Chips */}
          <div className="flex items-center gap-2 overflow-x-auto pb-1 no-scrollbar pt-1 flex-wrap">
            {TABS.map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={`shrink-0 px-4 py-2 text-xs font-semibold rounded-full transition-all cursor-pointer ${
                  tab === id
                    ? "bg-zinc-800 text-white shadow-xs border border-zinc-700/50"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200/70 hover:text-slate-800 border border-slate-200/60"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* ─── BODY (TAB CONTENT) ─── */}
        <div className="flex-1 overflow-y-auto p-5 sm:p-7 bg-white">
          {tab === "mini_windows" ? <MiniWindowsTab profiles={profiles} setBoth={setBoth} setToast={setToast} /> : null}
          {tab === "squad" ? <MultiBotSquadComputerGrid /> : null}
          {tab === "som_vision" ? <SomVisionTab setBoth={setBoth} setToast={setToast} /> : null}
          {tab === "os_uia" ? <OsUiaTab setBoth={setBoth} setToast={setToast} /> : null}
          {tab === "classic" ? <ComputerBrowserStudio /> : null}
        </div>

      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subsystem 1 — per-bot mini windows
// ---------------------------------------------------------------------------

function MiniWindowsTab({
  profiles,
  setBoth,
  setToast,
}: {
  profiles: BotProfile[];
  setBoth: (message: string) => void;
  setToast: (toast: string | null) => void;
}) {
  const [windows, setWindows] = useState<BotMiniWindowInstance[]>([]);
  const [busy, setBusy] = useState(false);
  const [reads, setReads] = useState<Record<string, MiniWindowHit>>({});
  const [typeText, setTypeText] = useState<Record<string, string>>({});
  const [form, setForm] = useState({
    botId: "",
    botHandle: "@claude",
    url: "https://example.com",
    alwaysOnTop: false,
  });

  const refresh = async () => {
    if (!isTauri()) return;
    try {
      setWindows(await invokeRaw<BotMiniWindowInstance[]>("list_bot_mini_computer_windows"));
    } catch {
      /* kernel not ready */
    }
  };

  useEffect(() => {
    void refresh();
    if (!isTauri()) return;
    let alive = true;
    let unlisten: (() => void) | undefined;
    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const off = await listen("ronic://mini-computer", () => void refresh());
      if (!alive) {
        off();
        return;
      }
      unlisten = off;
    })();
    const timer = window.setInterval(() => void refresh(), 4000);
    return () => {
      alive = false;
      unlisten?.();
      window.clearInterval(timer);
    };
  }, []);

  // Default the form to the first bot
  useEffect(() => {
    if (!form.botId && profiles.length > 0) {
      setForm((prev) => ({ ...prev, botId: profiles[0].id, botHandle: profiles[0].handle }));
    }
  }, [profiles, form.botId]);

  const spawn = async () => {
    setBusy(true);
    try {
      const botId = form.botId.trim() || form.botHandle.trim().replace(/^@/, "");
      if (!botId) {
        setToast("Pick a bot or type a handle for the mini window.");
        return;
      }
      const handle = form.botHandle.trim() || `@${botId}`;
      const instance = await invokeRaw<BotMiniWindowInstance>("spawn_bot_mini_computer_window", {
        botId,
        botHandle: handle,
        initialUrl: form.url,
        alwaysOnTop: form.alwaysOnTop,
      });
      setBoth(`🖥️ Spawned the mini computer desktop for ${instance.botHandle} (${instance.windowLabel}) — Files, tabbed Chrome with its own profile, and its own terminal.`);
      void refresh();
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const drive = async (instance: BotMiniWindowInstance, kind: "read" | "click" | "type", controlIndex?: number) => {
    setBusy(true);
    try {
      const hit = await invokeRaw<MiniWindowHit>("drive_bot_computer_window", {
        botId: instance.botId,
        kind,
        controlIndex: controlIndex ?? null,
        text: kind === "type" ? typeText[instance.botId] ?? "" : null,
        squad: false,
      });
      setReads((prev) => ({ ...prev, [instance.botId]: hit }));
      setBoth(`${instance.botHandle} ${kind} finished inside ${hit.windowLabel} in ${hit.ms}ms — synthetic input only.`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const takeover = async (instance: BotMiniWindowInstance, takeOver: boolean) => {
    try {
      await invokeRaw("set_bot_mini_window_takeover", { botId: instance.botId, takeOver });
      setBoth(takeOver ? `🖐️ You have ${instance.windowLabel} — the bot driver is paused until you resume.` : `▶ ${instance.botHandle} resumed autonomous driving.`);
      void refresh();
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error));
    }
  };

  const close = async (instance: BotMiniWindowInstance) => {
    try {
      await invokeRaw<string>("close_bot_mini_computer_window", { botId: instance.botId });
      setBoth(`Closed ${instance.windowLabel}.`);
      void refresh();
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="space-y-6">
      {/* Spawn Mini Computer Form Card */}
      <div className="rounded-2xl border border-slate-200/90 bg-white p-5 sm:p-6 shadow-xs space-y-4">
        <div>
          <h3 className="text-sm font-bold text-slate-900">Spawn Isolated Bot Desktop</h3>
          <p className="text-xs text-slate-500 mt-0.5">
            Each bot gets its own 980x660 mini computer desktop: file explorer, tabbed Chrome with isolated profile, and live terminal. Synthetic input only — OS cursor stays 100% free.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <select
            value={form.botId}
            onChange={(e) => {
              const profile = profiles.find((p) => p.id === e.target.value);
              setForm({ ...form, botId: e.target.value, botHandle: profile?.handle ?? form.botHandle });
            }}
            className="px-3.5 py-2 text-xs font-mono border border-slate-200 rounded-xl bg-slate-50 min-w-[180px] outline-none focus:ring-2 focus:ring-slate-200"
          >
            {profiles.length === 0 ? <option value="">No bots configured</option> : null}
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>{profile.handle}</option>
            ))}
          </select>
          <input
            type="text"
            value={form.botHandle}
            onChange={(e) => setForm({ ...form, botHandle: e.target.value })}
            placeholder="@Handle (or custom)"
            className="px-3.5 py-2 text-xs font-mono border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-slate-200 bg-slate-50 w-44"
          />
          <input
            type="text"
            value={form.url}
            onChange={(e) => setForm({ ...form, url: e.target.value })}
            placeholder="https://… (blank = HUD only)"
            className="flex-1 min-w-[220px] px-3.5 py-2 text-xs font-mono border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-slate-200 bg-slate-50"
          />
          <label className="flex items-center gap-2 text-xs font-medium text-slate-600 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={form.alwaysOnTop}
              onChange={(e) => setForm({ ...form, alwaysOnTop: e.target.checked })}
              className="rounded"
            />
            Always on top
          </label>
          <button
            type="button"
            onClick={() => void spawn()}
            disabled={busy}
            className="px-5 py-2 text-xs font-semibold bg-zinc-800 hover:bg-zinc-700 text-white rounded-full transition-all cursor-pointer shadow-xs active:scale-95 disabled:opacity-50 border border-zinc-700/50"
          >
            + Spawn bot mini window
          </button>
        </div>
      </div>

      {windows.length === 0 ? (
        <div className="py-16 text-center text-slate-400 text-xs rounded-2xl border border-dashed border-slate-200 bg-slate-50/50">
          No mini windows open yet. Spawn one above — every bot can drive its own isolated desktop at the same time.
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {windows.map((instance) => {
            const read = reads[instance.botId];
            const isTakeover = instance.mode === "human_takeover";
            return (
              <div key={instance.botId} className="rounded-2xl border border-slate-200/90 bg-white overflow-hidden shadow-xs">
                <div className={`px-4 py-3 flex items-center justify-between text-xs ${isTakeover ? "bg-amber-500 text-white" : "bg-zinc-800 text-white"}`}>
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${instance.status === "closed" ? "bg-slate-400" : isTakeover ? "bg-white" : "bg-emerald-400 animate-pulse"}`} />
                    <span className="font-mono font-bold">{instance.botHandle}</span>
                    <span className="text-[11px] font-mono opacity-80">({instance.activeDriver})</span>
                  </div>
                  <span className="text-[11px] font-mono opacity-80">{instance.windowLabel}</span>
                </div>
                
                <div className="relative h-36 bg-slate-50 border-b border-slate-100 p-4 font-mono text-xs overflow-hidden">
                  <div className="text-[11px] text-slate-500 truncate border-b border-slate-200 pb-1 mb-2">
                    {instance.currentUrlOrApp || "about:blank"}
                  </div>
                  {read ? (
                    <div className="space-y-0.5">
                      <div className="font-sans font-bold text-slate-900 truncate">{read.title || read.url}</div>
                      <div className="text-[11px] text-slate-500">{read.nodes.length} interactive controls • read in {read.ms}ms</div>
                    </div>
                  ) : (
                    <div className="text-xs font-sans text-slate-600">Press “Read page” to scan this window's interactive elements.</div>
                  )}
                  <div
                    style={{ left: `${instance.virtualCursorXy[0] ?? 230}px`, top: `${Math.min(instance.virtualCursorXy[1] ?? 90, 100)}px` }}
                    className="absolute flex items-center gap-1.5 pointer-events-none transition-all duration-300"
                  >
                    <span className="w-3.5 h-3.5 rounded-full bg-emerald-500 border-2 border-zinc-900 shadow-md" />
                    <span className="px-1.5 py-0.5 text-[9px] bg-zinc-800 text-white rounded font-mono shadow">{instance.botHandle}</span>
                  </div>
                </div>

                <div className="p-4 space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void drive(instance, "read")}
                      disabled={busy}
                      className="px-3.5 py-1.5 text-xs font-semibold bg-slate-100 border border-slate-200 rounded-full hover:bg-slate-200 text-slate-700 cursor-pointer disabled:opacity-50 transition"
                    >
                      👁 Read page
                    </button>
                    <button
                      type="button"
                      onClick={() => void takeover(instance, !isTakeover)}
                      className={`px-3.5 py-1.5 text-xs font-semibold rounded-full border cursor-pointer transition ${
                        isTakeover
                          ? "bg-amber-500 text-white border-amber-500"
                          : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50"
                      }`}
                    >
                      {isTakeover ? "✓ Resume bot" : "🖐️ Take over window"}
                    </button>
                    <button
                      type="button"
                      onClick={() => void close(instance)}
                      className="px-3.5 py-1.5 text-xs font-semibold bg-rose-50 text-rose-700 border border-rose-200/90 rounded-full hover:bg-rose-100 cursor-pointer transition"
                    >
                      ✕ Close
                    </button>
                  </div>

                  {read && read.nodes.length > 0 && (
                    <div className="max-h-48 overflow-y-auto space-y-1.5 pr-1">
                      {read.nodes.map((node) => (
                        <div key={node.id} className="flex items-center gap-2 text-xs bg-slate-50 border border-slate-200/80 rounded-xl px-3 py-1.5">
                          <span className="px-1.5 py-0.5 bg-zinc-800 text-white font-mono font-bold rounded text-[10px]">#{node.id}</span>
                          <span className="font-mono text-slate-400 text-[11px]">&lt;{node.tag}&gt;</span>
                          <span className="flex-1 truncate text-slate-800">{node.label || "(no label)"}</span>
                          <button
                            type="button"
                            onClick={() => void drive(instance, "click", node.id)}
                            disabled={busy}
                            className="px-2.5 py-1 text-[11px] font-semibold bg-zinc-800 hover:bg-zinc-700 text-white rounded-full cursor-pointer disabled:opacity-50 transition shadow-xs border border-zinc-700/50"
                          >
                            Click
                          </button>
                          {(node.tag === "input" || node.tag === "textarea") && (
                            <span className="flex items-center gap-1.5">
                              <input
                                value={typeText[instance.botId] ?? ""}
                                onChange={(e) => setTypeText((prev) => ({ ...prev, [instance.botId]: e.target.value }))}
                                placeholder="text…"
                                className="w-28 px-2 py-1 text-[11px] font-mono border border-slate-200 rounded-lg outline-none focus:ring-1 focus:ring-slate-300 bg-white"
                              />
                              <button
                                type="button"
                                onClick={() => void drive(instance, "type", node.id)}
                                disabled={busy}
                                className="px-2.5 py-1 text-[11px] font-semibold bg-zinc-800 hover:bg-zinc-700 text-white rounded-full cursor-pointer disabled:opacity-50 transition shadow-xs border border-zinc-700/50"
                              >
                                Type
                              </button>
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subsystem 3 — Set-of-Marks vision overlay
// ---------------------------------------------------------------------------

function SomVisionTab({ setBoth, setToast }: { setBoth: (message: string) => void; setToast: (toast: string | null) => void }) {
  const [filter, setFilter] = useState("");
  const [snapshot, setSnapshot] = useState<SoMAnnotatedSnapshot | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [typeText, setTypeText] = useState("ronic-release-v2.1.4");
  const [busy, setBusy] = useState(false);

  const capture = async () => {
    setBusy(true);
    try {
      const result = await invokeRaw<SoMAnnotatedSnapshot>("generate_som_annotated_snapshot", { windowTitle: filter });
      setSnapshot(result);
      setSelected(result.markRegistry[0]?.markId ?? null);
      setBoth(`🎯 Captured "${result.windowTitle}" (${result.captureSource}) and stamped ${result.totalMarks} marks in ${result.captureMs}ms.`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const execute = async (markId: number, action: "invoke_click" | "set_value") => {
    setBusy(true);
    try {
      const message = await invokeRaw<string>("execute_som_or_uia_action", { markId, action, textPayload: action === "set_value" ? typeText : null });
      setBoth(message);
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const active = snapshot?.markRegistry.find((mark) => mark.markId === selected) ?? null;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
      <div className="lg:col-span-7 rounded-2xl border border-slate-200/90 bg-white p-5 sm:p-6 space-y-4 shadow-xs">
        <div className="flex flex-wrap items-end gap-3 border-b border-slate-100 pb-3">
          <div className="flex-1 min-w-[220px]">
            <h3 className="text-sm font-bold text-slate-900">Set-of-Marks Visual Grounding Canvas</h3>
            <p className="text-xs text-slate-500 mt-0.5">Captures window buffer, fuses UIA rects, and stamps numbered badges in Rust. Vision models pick mark numbers directly.</p>
          </div>
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void capture();
            }}
            placeholder="Window title filter (blank = foreground)"
            className="flex-1 min-w-[200px] px-3.5 py-2 text-xs font-mono border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-slate-200 bg-slate-50"
          />
          <button
            type="button"
            onClick={() => void capture()}
            disabled={busy}
            className="px-5 py-2 text-xs font-semibold bg-zinc-800 hover:bg-zinc-700 text-white rounded-full transition-all cursor-pointer shadow-xs active:scale-95 disabled:opacity-50 border border-zinc-700/50"
          >
            🎯 Capture &amp; annotate
          </button>
        </div>

        {snapshot ? (
          <div className="space-y-2">
            <img src={snapshot.annotatedImageBase64} alt="Set-of-Marks annotated snapshot" className="w-full rounded-2xl border border-slate-200 shadow-md" />
            <div className="text-xs font-mono text-slate-500">
              source: {snapshot.captureSource} • {snapshot.totalMarks} marks • rendered in {snapshot.captureMs}ms
            </div>
          </div>
        ) : (
          <div className="h-64 flex items-center justify-center bg-slate-50 border border-dashed border-slate-200 rounded-2xl text-xs text-slate-400">
            Capture a window above to inspect its numbered visual marks.
          </div>
        )}
      </div>

      <div className="lg:col-span-5 rounded-2xl border border-slate-200/90 bg-white p-5 sm:p-6 space-y-4 text-xs shadow-xs">
        <h3 className="text-sm font-bold text-slate-900 border-b border-slate-100 pb-3">{active ? `Mark Inspector (#${active.markId})` : "Mark Inspector"}</h3>
        
        {active ? (
          <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl font-mono text-xs space-y-1.5 text-slate-800">
            <div><strong>Mark:</strong> #{active.markId} ({active.controlType}, {active.origin})</div>
            <div><strong>Label:</strong> {active.name}</div>
            <div><strong>AutomationId:</strong> {active.automationId || "—"}</div>
            <div><strong>Rect:</strong> [{active.bounds.join(", ")}]</div>
            <div><strong>Center:</strong> ({active.centerXy[0]}, {active.centerXy[1]})</div>
            <div className="text-emerald-700 font-semibold pt-1">
              Mode: {active.supportsBackgroundInvoke || active.supportsBackgroundValue ? "Background UIA Pattern (0px mouse move)" : "Posted Pixel Click (Cursor untouched)"}
            </div>
          </div>
        ) : (
          <p className="text-slate-400 text-xs">Select a numbered mark from the list below to inspect.</p>
        )}

        <input
          type="text"
          value={typeText}
          onChange={(e) => setTypeText(e.target.value)}
          placeholder="Value for somType…"
          className="w-full px-3.5 py-2 font-mono text-xs border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-slate-200 bg-slate-50"
        />

        <div className="space-y-2 pt-1">
          <button
            type="button"
            onClick={() => active && void execute(active.markId, "invoke_click")}
            disabled={!active || busy}
            className="w-full py-2.5 font-semibold text-xs bg-zinc-800 hover:bg-zinc-700 text-white rounded-full transition-all cursor-pointer disabled:opacity-50 shadow-xs border border-zinc-700/50"
          >
            🎯 som_click(#{active?.markId ?? "?"}) at ({active?.centerXy[0] ?? "?"}, {active?.centerXy[1] ?? "?"})
          </button>
          <button
            type="button"
            onClick={() => active && void execute(active.markId, "set_value")}
            disabled={!active || busy}
            className="w-full py-2.5 font-semibold text-xs bg-slate-100 border border-slate-200 text-slate-700 rounded-full hover:bg-slate-200 cursor-pointer disabled:opacity-50 transition"
          >
            ✎ som_type(#{active?.markId ?? "?"}, "{typeText}")
          </button>
        </div>

        {snapshot && snapshot.markRegistry.length > 0 && (
          <div className="max-h-52 overflow-y-auto space-y-1.5 pr-1 pt-2 border-t border-slate-100">
            {snapshot.markRegistry.map((mark) => (
              <button
                key={mark.markId}
                type="button"
                onClick={() => setSelected(mark.markId)}
                className={`w-full text-left px-3 py-2 rounded-xl border font-mono text-xs cursor-pointer transition ${
                  mark.markId === selected
                    ? "border-zinc-800 bg-slate-50 shadow-xs"
                    : "border-slate-200 hover:border-slate-300 bg-white"
                }`}
              >
                <span className="px-1.5 py-0.5 bg-zinc-800 text-emerald-300 font-bold rounded text-[10px] mr-1.5">#{mark.markId}</span>{" "}
                <span className="font-semibold text-slate-800">{mark.controlType}</span> — {mark.name}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subsystem 2 — native OS UIAutomation driver
// ---------------------------------------------------------------------------

function OsUiaTab({ setBoth, setToast }: { setBoth: (message: string) => void; setToast: (toast: string | null) => void }) {
  const [filter, setFilter] = useState("");
  const [nodes, setNodes] = useState<UIAControlNode[]>([]);
  const [typeText, setTypeText] = useState("ronic-release-v2.1.4");
  const [busy, setBusy] = useState(false);

  const inspect = async () => {
    setBusy(true);
    try {
      const result = await invokeRaw<UIAControlNode[]>("inspect_native_os_uia_tree", { windowTitleFilter: filter });
      setNodes(result);
      setBoth(`🌲 Extracted ${result.length} native Windows UIAutomation control nodes.`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const act = async (markId: number, action: "invoke_click" | "set_value") => {
    setBusy(true);
    try {
      const message = await invokeRaw<string>("execute_som_or_uia_action", { markId, action, textPayload: action === "set_value" ? typeText : null });
      setBoth(message);
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-2xl border border-slate-200/90 bg-white p-5 sm:p-6 space-y-4 text-xs shadow-xs">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-slate-100 pb-3">
        <div>
          <h3 className="text-sm font-bold text-slate-900">Native OS UIAutomation Control Tree (Windows IUIAutomation)</h3>
          <p className="text-slate-500 mt-0.5 text-xs">Triggers desktop buttons via InvokePattern and fills native inputs via ValuePattern in the background — OS mouse cursor never moves.</p>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void inspect();
            }}
            placeholder="Window title filter (blank = foreground)"
            className="px-3.5 py-2 font-mono text-xs border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-slate-200 w-64 bg-slate-50"
          />
          <button
            type="button"
            onClick={() => void inspect()}
            disabled={busy}
            className="px-5 py-2 font-semibold text-xs bg-zinc-800 hover:bg-zinc-700 text-white rounded-full transition-all cursor-pointer disabled:opacity-50 shadow-xs border border-zinc-700/50"
          >
            🌲 Inspect tree
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2 pt-1">
        <span className="text-xs font-mono font-semibold text-slate-500">Value for SetValue():</span>
        <input
          type="text"
          value={typeText}
          onChange={(e) => setTypeText(e.target.value)}
          className="px-3.5 py-1.5 font-mono text-xs border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-slate-200 w-72 bg-slate-50"
        />
      </div>

      {nodes.length === 0 ? (
        <div className="py-16 text-center text-slate-400 text-xs">
          Inspect a window to list its buttons, edits, menus, tabs, and checkboxes with their AutomationIds.
        </div>
      ) : (
        <div className="space-y-2.5 max-h-[500px] overflow-y-auto pr-1">
          {nodes.map((node) => (
            <div key={node.markId} className="p-3.5 bg-slate-50 border border-slate-200/80 rounded-2xl flex flex-wrap items-center justify-between gap-3 hover:bg-slate-100/70 transition">
              <div className="space-y-1 font-mono min-w-0">
                <div className="font-bold text-slate-900 text-xs">
                  <span className="px-2 py-0.5 bg-zinc-800 text-emerald-300 font-bold rounded text-[10px] mr-2">#{node.markId}</span>
                  {node.controlType} — "{node.name}"
                  <span className={`ml-2 px-2 py-0.5 text-[10px] rounded-full font-semibold ${node.origin === "uia" ? "bg-emerald-50 text-emerald-700 border border-emerald-200" : "bg-amber-50 text-amber-700 border border-amber-200"}`}>
                    {node.origin === "uia" ? "live UIA" : "simulated"}
                  </span>
                </div>
                <div className="text-[11px] text-slate-500 truncate">
                  AutomationId: {node.automationId || "—"} • class: {node.className} • rect: [{node.bounds.join(", ")}] • center: ({node.centerXy[0]}, {node.centerXy[1]})
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void act(node.markId, "invoke_click")}
                  disabled={busy || !node.supportsBackgroundInvoke}
                  title={node.supportsBackgroundInvoke ? "InvokePattern::Invoke in the background" : "this control exposes no Invoke pattern"}
                  className="px-3.5 py-1.5 font-semibold text-xs bg-zinc-800 hover:bg-zinc-700 text-white rounded-full transition-all cursor-pointer disabled:opacity-40 shadow-xs border border-zinc-700/50"
                >
                  ⚡ UIA Invoke()
                </button>
                <button
                  type="button"
                  onClick={() => void act(node.markId, "set_value")}
                  disabled={busy || !node.supportsBackgroundValue}
                  title={node.supportsBackgroundValue ? "ValuePattern::SetValue in the background" : "this control exposes no Value pattern"}
                  className="px-3.5 py-1.5 font-semibold text-xs bg-white border border-slate-200 rounded-full hover:bg-slate-100 cursor-pointer disabled:opacity-40 transition"
                >
                  ✎ UIA SetValue()
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
