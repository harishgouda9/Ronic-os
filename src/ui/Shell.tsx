import {
  ArrowLeft,
  X,
  Blocks,
  Bot,
  Boxes,
  Brain,
  Bug,
  Cable,
  Code2,
  CreditCard,
  GitBranch,
  MessageSquare,
  Monitor,
  Network,
  Puzzle,
  Zap,
  ScrollText,
  Sparkles,
  Settings,
  Store,
  Wallet,
  Wrench,
  RefreshCw,
  Terminal as TerminalIcon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { RAIL, type ScreenId } from "../types";
import { useOmni } from "../store";
import { Pill } from "./bits";
import { isTauri } from "../api";
import TerminalPanel from "../components/TerminalPanel";
import { SuperchargeControl } from "../components/Harness2Studio";
import { JobClock } from "./JobClock";
import { useDesktopChrome, WindowControls } from "./WindowChrome";

const RAIL_KEY = "omni.railWidth";

function clampRail(width: number) {
  return Math.min(320, Math.max(56, Math.round(width)));
}

function readRail(): number {
  try {
    const raw = localStorage.getItem(RAIL_KEY);
    if (!raw) return 56;
    const parsed = JSON.parse(raw) as { width?: number };
    return clampRail(parsed.width ?? 56);
  } catch {
    return 56;
  }
}

function writeRail(width: number) {
  try {
    localStorage.setItem(RAIL_KEY, JSON.stringify({ width }));
  } catch {}
}

const ICONS: Record<string, LucideIcon> = {
  chat: MessageSquare,
  bots: Bot,
  providers: Cable,
  memory: Brain,
  skills: Sparkles,
  mesh: Network,
  harness2: Zap,
  capabilities: Sparkles,
  fleet: Boxes,
  ide: Code2,
  computer: Monitor,
  workflows: GitBranch,
  market: Store,
  wallet: Wallet,
  extensions: Blocks,
  repair: Wrench,
  billing: CreditCard,
  settings: Settings,
  profiles: Bot,
  vault: Settings,
};

const NAMES: Record<ScreenId, string> = {
  onboarding: "First run",
  chat: "Bots & groups",
  bots: "External bots",
  profiles: "Bot profiles",
  providers: "Apps & providers",
  memory: "Memory",
  skills: "Skills & Capabilities",
  mesh: "MCP & ACP mesh",
  harness2: "Harness²",
  capabilities: "Skills & Capabilities",
  fleet: "Bot fleet",
  ide: "Coding agents",
  computer: "Computer & browser",
  workflows: "Workflows",
  market: "Marketplace",
  wallet: "Wallet & trading",
  extensions: "Self-modify",
  repair: "Self-repair",
  billing: "Plan & act",
  settings: "Settings",
  vault: "Secret vault",
};

export function Shell({ children }: { children: ReactNode }) {
  const snap = useOmni((s) => s.snap)!;
  const screen = useOmni((s) => s.screen);
  const go = useOmni((s) => s.go);
  const palette = useOmni((s) => s.palette);
  const debug = useOmni((s) => s.debug);
  const bug = useOmni((s) => s.bug);
  const toast = useOmni((s) => s.toast);
  const setPalette = useOmni((s) => s.setPalette);
  const setDebug = useOmni((s) => s.setDebug);
  const setBug = useOmni((s) => s.setBug);
  const setToast = useOmni((s) => s.setToast);
  const recover = useOmni((s) => s.recover);
  const recovering = useOmni((s) => s.recovering);
  const terminal = useOmni((s) => s.terminal);
  const setTerminal = useOmni((s) => s.setTerminal);
  const [agentTerminalActive, setAgentTerminalActive] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    let unlisten: (() => void) | null = null;
    void import("@tauri-apps/api/event").then(({ listen }) => {
      if (!alive) return;
      listen("agent-terminal-active", () => {
        setAgentTerminalActive(true);
      }).then((unsub) => {
        if (!alive) {
          unsub();
          return;
        }
        unlisten = unsub;
      });
    });
    return () => {
      alive = false;
      if (unlisten) unlisten();
    };
  }, []);
  const [terminalHeight, setTerminalHeight] = useState(() => {
    try {
      const saved = localStorage.getItem("omni.terminalHeight");
      return saved ? Math.max(140, Math.min(window.innerHeight * 0.75, parseInt(saved, 10))) : 280;
    } catch {
      return 280;
    }
  });

  function beginTerminalResize(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const startY = event.clientY;
    const startH = terminalHeight;
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const move = (pointer: PointerEvent) => {
      const next = startH + (startY - pointer.clientY);
      if (next < 90) {
        setTerminal(false);
        return;
      }
      const height = Math.max(140, Math.min(window.innerHeight * 0.75, next));
      setTerminalHeight(height);
      try {
        localStorage.setItem("omni.terminalHeight", String(next));
      } catch {}
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
  }
  const bare = screen === "onboarding" || screen === "vault" || !snap.vaultUnlocked;
  const usdc = snap.balances.find((b) => b.rail === "crypto_x402");
  const inr = snap.balances.find((b) => b.rail === "razorpay_upi");
  const [railWidth, setRailWidth] = useState(readRail);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const railDragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    if (railWidth !== readRail()) writeRail(railWidth);
  }, [railWidth]);

  function beginRailDrag(event: React.PointerEvent<HTMLElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const wasShut = railCollapsed;
    const startWidth = wasShut ? 0 : railWidth;
    let moved = false;
    const previous = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    document.body.dataset.paneDrag = "1";
    railDragRef.current = { startX, startWidth };
    const move = (pointer: PointerEvent) => {
      if (Math.abs(pointer.clientX - startX) > 4) moved = true;
      const raw = startWidth + (pointer.clientX - startX);
      if (raw < 48) {
        setRailCollapsed(true);
        return;
      }
      setRailWidth(clampRail(raw));
      setRailCollapsed(false);
    };
    const end = () => {
      document.body.style.userSelect = previous;
      delete document.body.dataset.paneDrag;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      railDragRef.current = null;
      if (!moved && wasShut) setRailCollapsed(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
  }

  const [history, setHistory] = useState<ScreenId[]>([]);

  useEffect(() => {
    setHistory((prev) => {
      if (prev.length > 0 && prev[prev.length - 1] === screen) return prev;
      return [...prev, screen];
    });
  }, [screen]);

  function handleBack() {
    if (history.length > 1) {
      const nextHistory = [...history];
      nextHistory.pop(); // remove current screen
      const prevScreen = nextHistory[nextHistory.length - 1];
      setHistory(nextHistory);
      if (prevScreen) {
        go(prevScreen);
        return;
      }
    }
    go("chat");
  }

  function handleCloseScreen() {
    go("chat");
  }

  const chrome = useDesktopChrome();
  const drag = chrome ? { "data-tauri-drag-region": "" } : undefined;

  function navigate(id: ScreenId) {
    if (!snap.vaultUnlocked && id !== "vault") return;
    if (!snap.onboardingComplete && id !== "onboarding" && id !== "vault") return;
    go(id);
  }

  return (
    <div className="app">
      <JobClock />
      <header className={chrome ? "header desktop-chrome" : "header"}>
        <div className="brand" {...drag}>
          <img className="logo-lockup" src="/brand/logo.png" alt="Ronic OS" draggable={false} />
        </div>

        <div className="nav-controls">
          <button
            type="button"
            className="header-nav-btn back-btn"
            onClick={handleBack}
            disabled={screen === "chat" && history.length <= 1}
            title="Back to previous screen (Alt+Left)"
            aria-label="Back"
          >
            <ArrowLeft size={13} />
            <span>Back</span>
          </button>
          {screen !== "chat" && (
            <button
              type="button"
              className="header-nav-btn close-btn"
              onClick={handleCloseScreen}
              title="Close current screen and return to Chat (Esc)"
              aria-label="Close"
            >
              <X size={13} />
              <span>Close</span>
            </button>
          )}
        </div>

        <button className="cmdk" onClick={() => setPalette(true)}>
          <span>Jump to a screen</span>
          <span className="kbd">Ctrl K</span>
        </button>
        <div className="spacer" {...drag} />
        <div className="header-actions">
          <SuperchargeControl />
          {snap.plugins.filter((plugin) => plugin.desktopEnabled && plugin.trust === "trusted").flatMap((plugin) => plugin.desktop.filter((bit) => bit.kind === "status").map((bit) => (
            <span className="quote-chip" key={`${plugin.id}-${bit.label}`}>{bit.label}</span>
          )))}
          {snap.kernel === "browser" ? <Pill kind="warn">BROWSER PREVIEW</Pill> : null}
          <button className="wallet-pill" onClick={() => navigate("wallet")}>
            <span>{usdc?.nativeAmount ?? "—"}</span>
            <span className="faint">{inr?.nativeAmount ?? ""}</span>
            {snap.sandbox ? <span className="sandbox-tag">SANDBOX</span> : <span className="sandbox-tag">LIVE OFF</span>}
          </button>
          {snap.kernel === "browser" ? (
            <span className="quote-chip" title="The watchdog runs in the desktop shell">no watchdog</span>
          ) : (
            <span className="quote-chip" title="Watchdog heartbeat">
              <i className={`dot ${snap.heartbeatAgeMs < 4000 ? "" : "warn"}`} />
              {snap.heartbeatAgeMs} ms
            </span>
          )}
          <button type="button" className="btn small refresh-btn" disabled={recovering} aria-label="Refresh workspace" title="Clear stuck replies, reconnect models, and reload workspace (Ctrl+Shift+R)" onClick={() => void recover()}><RefreshCw size={13} className={recovering ? "spin" : ""} /><span>{recovering ? "Refreshing…" : "Refresh"}</span></button>
          <button
            type="button"
            className={`btn small terminal-topbar-btn ${terminal ? "active" : ""} ${agentTerminalActive && !terminal ? "agent-busy" : ""}`}
            onClick={() => {
              setAgentTerminalActive(false);
              setTerminal(!terminal);
            }}
            title={agentTerminalActive && !terminal ? "Agent is running terminal commands! Click to inspect (Ctrl+`)" : "Toggle Global Terminal (Ctrl+` or Cmd+`)"}
            aria-label="Toggle Global Terminal"
          >
            <TerminalIcon size={13} className={agentTerminalActive && !terminal ? "spin" : ""} />
            <span>Terminal</span>
            {terminal ? (
              <span className="terminal-active-dot" />
            ) : agentTerminalActive ? (
              <span className="terminal-active-dot agent-pulse" title="Agent active in terminal" />
            ) : null}
          </button>
          <button className="btn ghost small" onClick={() => setBug(true)}>
            <Bug size={14} />
          </button>
        </div>
        {chrome ? <WindowControls /> : null}
      </header>
      <div className="body">
        {bare ? null : (
          <>
            {railCollapsed ? <button type="button" className="pane-restore" aria-label="Show screens" onPointerDown={beginRailDrag}>Screens</button> : null}
            <nav className={`rail ${snap.settings.showRailLabels ? "labeled" : ""} ${railCollapsed ? "collapsed" : ""}`} style={{ width: railCollapsed ? 0 : (snap.settings.showRailLabels ? Math.max(railWidth, 196) : railWidth), flex: `0 0 ${railCollapsed ? 0 : (snap.settings.showRailLabels ? Math.max(railWidth, 196) : railWidth)}px` }} aria-label="Screens" hidden={railCollapsed}>
              {RAIL.filter((item) => item.group === "main").map((item) => (
                <RailButton key={item.id} id={item.id} label={item.label} active={screen === item.id || (item.id === "chat" && screen === "profiles") || (item.id === "skills" && screen === "capabilities")} onClick={() => navigate(item.id)} labeled={snap.settings.showRailLabels && !railCollapsed} />
              ))}
              <div className="grow" />
              {RAIL.filter((item) => item.group === "tail").map((item) => (
                <RailButton key={item.id} id={item.id} label={item.label} active={screen === item.id} onClick={() => navigate(item.id)} labeled={snap.settings.showRailLabels && !railCollapsed} />
              ))}
            </nav>
            <div className="resize-handle vertical rail-handle" onPointerDown={beginRailDrag} aria-label="Resize rail" role="separator" tabIndex={0} />
          </>
        )}
        <main className={`main ${screen === "chat" || screen === "ide" ? "main-flush" : ""}`}>{children}</main>
      </div>
      <div
        className="global-terminal-drawer"
        style={{
          height: terminalHeight,
          display: terminal ? "flex" : "none",
        }}
      >
        <div
          className="global-terminal-resizer"
          title="Drag to resize terminal"
          onPointerDown={beginTerminalResize}
        />
        <TerminalPanel
          sessionId="omni_global"
          onClose={() => setTerminal(false)}
          title="Ronic Shell"
        />
      </div>
      {toast ? (
        <button className="toast" onClick={() => setToast(null)}>
          {toast}
        </button>
      ) : null}
      {palette ? <Palette onClose={() => setPalette(false)} navigate={navigate} /> : null}
      {debug ? <DebugDrawer onClose={() => setDebug(false)} /> : null}
      {bug ? <BugModal onClose={() => setBug(false)} /> : null}
    </div>
  );
}

function RailButton({ id, label, active, onClick, labeled }: { id: string; label: string; active: boolean; onClick: () => void; labeled: boolean }) {
  const Icon = ICONS[id] ?? MessageSquare;
  return (
    <button className={active ? "active" : ""} title={label} aria-label={label} onClick={onClick}>
      <span className="glyph">
        <Icon size={14} />
      </span>
      {labeled ? <span className="name">{label}</span> : null}
    </button>
  );
}

function Palette({ onClose, navigate }: { onClose: () => void; navigate: (id: ScreenId) => void }) {
  const [query, setQuery] = useState("");
  const setDebug = useOmni((s) => s.setDebug);
  const setBug = useOmni((s) => s.setBug);
  const run = useOmni((s) => s.run);
  const recover = useOmni((s) => s.recover);
  const snap = useOmni((s) => s.snap);
  const toggleTerminal = useOmni((s) => s.toggleTerminal);
  const items = useMemo(() => {
    const screens = new Set(RAIL.map((item) => item.id));
    const pluginCommands = (snap?.plugins ?? []).filter((plugin) => plugin.desktopEnabled && plugin.trust === "trusted").flatMap((plugin) =>
      plugin.desktop.filter((bit) => bit.kind === "command" && screens.has(bit.target as ScreenId)).map((bit) => ({
        label: bit.label,
        hint: plugin.name,
        run: () => navigate(bit.target as ScreenId),
      })),
    );
    const base: { label: string; hint: string; run: () => void }[] = [
      ...RAIL.map((item) => ({ label: item.label, hint: "Screen", run: () => navigate(item.id) })),
      ...pluginCommands,
      { label: "Bot profiles", hint: "Screen", run: () => navigate("profiles") },
      { label: "Secret vault", hint: "Screen", run: () => navigate("vault") },
      { label: "Refresh workspace", hint: "Ctrl Shift R", run: () => void recover() },
      { label: "Terminal", hint: "Ctrl `", run: () => toggleTerminal() },
      { label: "Debug drawer", hint: "Ctrl Shift D", run: () => setDebug(true) },
      { label: "Report a bug", hint: "Redacted ticket", run: () => setBug(true) },
      { label: "Lock vault", hint: "Clears keys from memory", run: () => void run("lock_vault") },
    ];
    const q = query.trim().toLowerCase();
    return q ? base.filter((item) => item.label.toLowerCase().includes(q)) : base;
  }, [navigate, query, recover, run, setBug, setDebug, snap, toggleTerminal]);

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <div className="pane-h between" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span>Command palette</span>
          <button type="button" className="btn ghost small" onClick={onClose} title="Close (Esc)" aria-label="Close">
            <X size={14} />
          </button>
        </div>
        <div className="pane-b stack">
          <input className="input" autoFocus placeholder="Type a screen or action" value={query} onChange={(event) => setQuery(event.target.value)} />
          {items.map((item) => (
            <button
              key={item.label}
              className="list-btn"
              onClick={() => {
                item.run();
                onClose();
              }}
            >
              <strong>{item.label}</strong>
              <span className="muted">{item.hint}</span>
            </button>
          ))}
          {items.length === 0 ? <p className="muted">No match.</p> : null}
        </div>
      </div>
    </div>
  );
}

function DebugDrawer({ onClose }: { onClose: () => void }) {
  const snap = useOmni((s) => s.snap)!;
  return (
    <aside className="drawer">
      <div className="pane-h between" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span>Debug</span>
        <button type="button" className="btn ghost small" onClick={onClose} title="Close drawer" aria-label="Close">
          <X size={14} />
          <span>Close</span>
        </button>
      </div>
      <div className="pane-b stack">
        <p className="muted">Kernel {snap.kernel} · proxy {snap.proxyUrl}</p>
        <p className="muted">Home {snap.homeDir}</p>
        <p className="muted">Heartbeat age {snap.heartbeatAgeMs} ms · vault {snap.vaultUnlocked ? "unlocked" : "locked"}</p>
        {snap.processes.map((row) => (
          <div key={row.name} className="between">
            <span>{row.name}</span>
            <span className="mono">{row.health}</span>
          </div>
        ))}
        <pre className="pre">{snap.ipcLog.slice(0, 40).join("\n") || "No IPC lines yet."}</pre>
      </div>
    </aside>
  );
}

function BugModal({ onClose }: { onClose: () => void }) {
  const snap = useOmni((s) => s.snap)!;
  const run = useOmni((s) => s.run);
  const busy = useOmni((s) => s.busy);
  const [category, setCategory] = useState("agent");
  const [notes, setNotes] = useState("");
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <div className="pane-h between" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span>Bug report · secrets are stripped before save</span>
          <button type="button" className="btn ghost small" onClick={onClose} title="Close modal" aria-label="Close">
            <X size={14} />
          </button>
        </div>
        <div className="pane-b stack">
          <label className="field">
            <span>Category</span>
            <select className="select" value={category} onChange={(event) => setCategory(event.target.value)}>
              {["agent", "wallet", "provider", "workflow", "repair", "other"].map((item) => (
                <option key={item}>{item}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>What happened</span>
            <textarea className="area" value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Paste the symptom. Keys in the text are redacted." />
          </label>
          <div className="row-actions">
            <button className="btn ghost" disabled={busy} onClick={() => void run("preview_bug", { category, notes })}>Preview</button>
            <button className="btn" disabled={busy || notes.trim().length < 4} onClick={() => void run("submit_bug", { category, notes })}>Save ticket</button>
          </div>
          {snap.bugPreview ? <pre className="pre">{snap.bugPreview}</pre> : <p className="muted">Nothing leaves this machine unless you set an https triage URL in Settings.</p>}
        </div>
      </div>
    </div>
  );
}
