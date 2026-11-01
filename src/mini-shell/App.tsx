import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Folder, Globe, Monitor, SquareTerminal } from "lucide-react";
import { ipc, errorMessage } from "./ipc";
import type { MiniComputerEvent, ShellBoot, ShellState } from "./types";
import { DesktopView } from "./apps/DesktopView";
import { FilesApp } from "./apps/FilesApp";
import { ChromeApp } from "./apps/ChromeApp";
import { TerminalApp } from "./apps/TerminalApp";

const APPS: { id: ShellState["app"]; label: string; icon: typeof Globe }[] = [
  { id: "desktop", label: "Desktop", icon: Monitor },
  { id: "files", label: "Files", icon: Folder },
  { id: "chrome", label: "Chrome", icon: Globe },
  { id: "terminal", label: "Terminal", icon: SquareTerminal },
];

export function App() {
  const [boot, setBoot] = useState<ShellBoot | null>(null);
  const [shell, setShell] = useState<ShellState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pageAreaRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let alive = true;
    ipc
      .boot()
      .then((info) => {
        if (!alive) return;
        setBoot(info);
        setShell(info.shell);
      })
      .catch((e) => alive && setError(errorMessage(e)));
    const unlisten = listen<MiniComputerEvent>("ronic://mini-computer", (event) => {
      if (!alive) return;
      const payload = event.payload;
      if (!boot?.botId || payload.botId !== boot.botId) {
        // Events arrive before boot resolves for this shell too — apply any
        // state that carries the label we will boot as (Rust is the source
        // of truth; a mismatched pre-boot event is ignored).
        return;
      }
      if (payload.shell) setShell(payload.shell);
    });
    return () => {
      alive = false;
      void unlisten.then((off) => off());
    };
  }, [boot?.botId]);

  const reportLayout = useCallback(() => {
    const el = pageAreaRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width > 1 && rect.height > 1) {
      void ipc.layout(rect.left, rect.top, rect.width, rect.height).catch(() => {});
    }
  }, []);

  // Report the real page area + devicePixelRatio once on mount too, so the
  // Rust side has correct Chrome bounds before the first app switch, and
  // keep them in step while Chrome is the active app (resizes, tab strip).
  useEffect(() => {
    const frame = requestAnimationFrame(reportLayout);
    return () => cancelAnimationFrame(frame);
  }, [boot?.botId, reportLayout]);

  useEffect(() => {
    if (shell?.app !== "chrome") return;
    const frame = requestAnimationFrame(reportLayout);
    window.addEventListener("resize", reportLayout);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", reportLayout);
    };
  }, [shell?.app, shell?.tabs.length, reportLayout]);

  const switchApp = useCallback(
    (target: ShellState["app"]) => {
      void ipc.setApp(target).catch((e) => setError(errorMessage(e)));
    },
    [],
  );

  // Whole-desktop keyboard shortcuts: Ctrl+1..4 switch apps, Ctrl+T new tab.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey || event.metaKey) return;
      const index = ["1", "2", "3", "4"].indexOf(event.key);
      if (index >= 0) {
        event.preventDefault();
        switchApp(APPS[index].id);
        return;
      }
      if (event.key.toLowerCase() === "t" && shell?.app === "chrome") {
        event.preventDefault();
        void ipc.openTab("https://www.google.com").catch((e) => setError(errorMessage(e)));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [switchApp, shell?.app]);

  if (error && !boot) {
    return (
      <div className="msh-root msh-center">
        <div className="msh-welcome-card">
          <h1>Mini computer could not start</h1>
          <p className="msh-error">{error}</p>
        </div>
      </div>
    );
  }
  if (!boot || !shell) {
    return (
      <div className="msh-root msh-center">
        <div className="msh-boot-hint">Starting the mini computer…</div>
      </div>
    );
  }

  return (
    <div className="msh-root">
      <main className="msh-stage">
        <div className={`msh-appview ${shell.app === "desktop" ? "on" : ""}`}>
          <DesktopView boot={boot} onOpen={switchApp} />
        </div>
        <div className={`msh-appview ${shell.app === "files" ? "on" : ""}`}>
          <FilesApp boot={boot} active={shell.app === "files"} />
        </div>
        <div className={`msh-appview ${shell.app === "chrome" ? "on" : ""}`}>
          <ChromeApp boot={boot} shell={shell} pageAreaRef={pageAreaRef} />
        </div>
        <div className={`msh-appview ${shell.app === "terminal" ? "on" : ""}`}>
          <TerminalApp boot={boot} active={shell.app === "terminal"} />
        </div>
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
              aria-selected={shell.app === app.id}
              className={`msh-taskbar-app ${shell.app === app.id ? "on" : ""}`}
              onClick={() => switchApp(app.id)}
              title={`${app.label} (Ctrl+${APPS.indexOf(app) + 1})`}
            >
              <app.icon size={14} aria-hidden />
              {app.label}
              {app.id === "chrome" && shell.tabs.length > 0 ? <span className="msh-tabcount">{shell.tabs.length}</span> : null}
            </button>
          ))}
        </div>
        <span className="msh-taskbar-pill" title="The bot drives this window with synthetic DOM events — your mouse is never touched">
          Isolated · zero OS mouse theft
        </span>
      </nav>
      {error ? (
        <div className="msh-toast" role="status" onClick={() => setError(null)}>
          {error}
        </div>
      ) : null}
    </div>
  );
}
