import { useCallback, useEffect, useRef, useState } from "react";
import { Folder, Globe, Monitor, Moon, SquareTerminal, Sun } from "lucide-react";
import { ipc, errorMessage, isTauri } from "../ipc";
import type { MiniComputerEvent, ShellBoot, ShellState } from "../types";
import { DesktopView } from "./DesktopView";
import { FilesApp } from "./FilesApp";
import { ChromeApp } from "./ChromeApp";
import { TerminalApp } from "./TerminalApp";
import { MiniShellErrorBoundary } from "../ErrorBoundary";
import { miniComputerBounds } from "../../ui/BotCoworkers";

const APPS: { id: ShellState["app"]; label: string; icon: typeof Globe }[] = [
  { id: "desktop", label: "Desktop", icon: Monitor },
  { id: "files", label: "Files", icon: Folder },
  { id: "chrome", label: "Chrome", icon: Globe },
  { id: "terminal", label: "Terminal", icon: SquareTerminal },
];

const THEME_KEY = "ronic-mini-theme";

export type MiniTheme = "light" | "dark";

export function readStoredTheme(): MiniTheme {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return stored === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

function storeTheme(theme: MiniTheme) {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* ignore */
  }
}

/**
 * The mini computer's body — desktop, app views, and taskbar. Rendered by the
 * standalone mini computer window (mode "window") and, compacted, inside the
 * chat dock's embedded panel (mode "panel"). Rust stays the source of truth
 * for tabs/app state; both surfaces stay in sync through ronic://mini-computer
 * events.
 */
export function ShellBody({
  boot,
  shell,
  setShell,
  onSwitchApp,
  compact = false,
  theme,
  onToggleTheme,
}: {
  boot: ShellBoot;
  shell: ShellState | null;
  setShell: (next: ShellState) => void;
  onSwitchApp: (app: ShellState["app"]) => void;
  compact?: boolean;
  theme: MiniTheme;
  onToggleTheme: () => void;
}) {
  const pageAreaRef = useRef<HTMLDivElement | null>(null);

  const reportLayout = useCallback(() => {
    const el = pageAreaRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const bounds = compact
      ? miniComputerBounds(el)
      : rect.width > 1 && rect.height > 1
        ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
        : null;
    void ipc.layout(bounds?.x ?? 0, bounds?.y ?? 0, bounds?.width ?? 0, bounds?.height ?? 0, compact ? boot.botId : undefined, Boolean(bounds)).catch(() => {});
  }, [boot.botId, compact]);

  useEffect(() => {
    if (!compact) return;
    return () => {
      void ipc.layout(0, 0, 0, 0, boot.botId, false).catch(() => {});
    };
  }, [boot.botId, compact]);

  useEffect(() => {
    const el = pageAreaRef.current;
    const frame = requestAnimationFrame(reportLayout);
    window.addEventListener("resize", reportLayout);
    const observer = el && typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => reportLayout()) : null;
    if (el && observer) observer.observe(el);
    const parent = el?.closest(".chat-layout, .chat-grid");
    if (parent && observer) observer.observe(parent);
    const scroller = el?.closest(".computer-dock")?.querySelector(".computer-dock-scroll");
    scroller?.addEventListener("scroll", reportLayout, { passive: true });
    document.addEventListener("scroll", reportLayout, true);
    window.addEventListener("blur", reportLayout);
    window.addEventListener("focus", reportLayout);
    document.addEventListener("visibilitychange", reportLayout);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", reportLayout);
      scroller?.removeEventListener("scroll", reportLayout);
      document.removeEventListener("scroll", reportLayout, true);
      window.removeEventListener("blur", reportLayout);
      window.removeEventListener("focus", reportLayout);
      document.removeEventListener("visibilitychange", reportLayout);
      observer?.disconnect();
    };
  }, [boot.botId, compact, shell?.app, shell?.tabs.length, reportLayout]);

  useEffect(() => {
    if (compact) return; // embedded in chat: no global keyboard takeover
    const onKey = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey || event.metaKey) return;
      const index = ["1", "2", "3", "4"].indexOf(event.key);
      if (index >= 0) {
        event.preventDefault();
        onSwitchApp(APPS[index].id);
        return;
      }
      if (event.key.toLowerCase() === "t" && shell?.app === "chrome") {
        event.preventDefault();
        void ipc.openTab("https://www.google.com", boot.botId).catch(() => {});
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [compact, onSwitchApp, shell?.app, boot.botId]);

  if (!shell) {
    return (
      <div className="msh-root msh-center">
        <div className="msh-boot-hint">Starting the mini computer…</div>
      </div>
    );
  }

  const tabs = shell.tabs ?? [];
  const currentApp = shell.app || "desktop";

  return (
    <>
      <main className="msh-stage">
        <MiniShellErrorBoundary fallbackTitle="Desktop view failed to load">
          <div className={`msh-appview ${currentApp === "desktop" ? "on" : ""}`}>
            <DesktopView boot={boot} onOpen={onSwitchApp} />
          </div>
          <div className={`msh-appview ${currentApp === "files" ? "on" : ""}`}>
            <FilesApp boot={boot} active={currentApp === "files"} compact={compact} />
          </div>
          <div className={`msh-appview ${currentApp === "chrome" ? "on" : ""}`}>
            <ChromeApp boot={boot} shell={shell} pageAreaRef={pageAreaRef} compact={compact} />
          </div>
          <div className={`msh-appview ${currentApp === "terminal" ? "on" : ""}`}>
            <TerminalApp boot={boot} active={currentApp === "terminal"} />
          </div>
        </MiniShellErrorBoundary>
      </main>
      <nav className="msh-taskbar" aria-label="Mini computer taskbar">
        <span className="msh-taskbar-bot" title={boot.workspacePath}>
          <span className="msh-dot" aria-hidden />
          {boot.botHandle}
        </span>
        <div className="msh-taskbar-apps" role="tablist" aria-label="Apps">
          {APPS.map((app) => (
            <button
              key={app.id}
              role="tab"
              aria-selected={currentApp === app.id}
              className={`msh-taskbar-app ${currentApp === app.id ? "on" : ""}`}
              onClick={() => onSwitchApp(app.id)}
              title={`${app.label} (Ctrl+${APPS.indexOf(app) + 1})`}
            >
              <app.icon size={14} aria-hidden />
              {app.label}
              {app.id === "chrome" && tabs.length > 0 ? <span className="msh-tabcount">{tabs.length}</span> : null}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="msh-tool theme-btn"
          onClick={onToggleTheme}
          title={theme === "light" ? "Switch to dark" : "Switch to light"}
          aria-label={theme === "light" ? "Switch to dark theme" : "Switch to light theme"}
        >
          {theme === "light" ? <Moon size={12} aria-hidden /> : <Sun size={12} aria-hidden />}
          {theme === "light" ? "Dark" : "Light"}
        </button>
        <span className="msh-taskbar-pill" title="The bot drives this window with synthetic DOM events — your mouse is never touched">
          Isolated · zero OS mouse theft
        </span>
      </nav>
    </>
  );
}

/** Subscribes to the bot's mini computer state events; returns a cleanup fn. */
export function useShellEvents(botId: string | undefined, setShell: (next: ShellState) => void) {
  useEffect(() => {
    if (!botId) return;
    let alive = true;
    if (isTauri()) {
      let unlistenFn: (() => void) | null = null;
      void import("@tauri-apps/api/event").then(({ listen }) => {
        if (!alive) return;
        void listen<MiniComputerEvent>("ronic://mini-computer", (event) => {
          if (!alive) return;
          const payload = event.payload;
          if (!payload || payload.botId !== botId) return;
          if (payload.shell) setShell(payload.shell);
        }).then((fn) => {
          if (alive) unlistenFn = fn;
          else fn();
        });
      });
      return () => {
        alive = false;
        unlistenFn?.();
      };
    } else {
      const onCustom = (event: Event) => {
        if (!alive) return;
        const custom = event as CustomEvent<{ botId: string; shell: ShellState }>;
        if (custom.detail?.botId === botId && custom.detail.shell) {
          setShell(custom.detail.shell);
        }
      };
      window.addEventListener("ronic-mini-computer", onCustom);
      return () => {
        alive = false;
        window.removeEventListener("ronic-mini-computer", onCustom);
      };
    }
  }, [botId, setShell]);
}

export function useMiniTheme(): [MiniTheme, () => void] {
  const [theme, setTheme] = useState<MiniTheme>(() => readStoredTheme());
  const toggle = useCallback(() => {
    setTheme((current) => {
      const next: MiniTheme = current === "light" ? "dark" : "light";
      storeTheme(next);
      return next;
    });
  }, []);
  return [theme, toggle];
}

export { errorMessage };
