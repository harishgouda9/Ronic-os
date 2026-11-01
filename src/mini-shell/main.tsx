import { useEffect, useState } from "react";
import { ipc, errorMessage } from "./ipc";
import type { ShellBoot, ShellState } from "./types";
import { ShellBody, useMiniTheme, useShellEvents } from "./apps/ShellBody";
import { MiniShellErrorBoundary } from "./ErrorBoundary";
import { createRoot } from "react-dom/client";
import "./shell.css";

/** The standalone mini computer window (its own WebView). */
export function App() {
  const [boot, setBoot] = useState<ShellBoot | null>(null);
  const [shell, setShell] = useState<ShellState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [theme, toggleTheme] = useMiniTheme();

  useEffect(() => {
    document.documentElement.classList.add("msh-window");
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-msh-theme", theme);
  }, [theme]);

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
    return () => {
      alive = false;
    };
  }, []);

  useShellEvents(boot?.botId, setShell);

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
  if (!boot) {
    return (
      <div className="msh-root msh-center">
        <div className="msh-boot-hint">Starting the mini computer…</div>
      </div>
    );
  }

  const switchApp = (app: ShellState["app"]) => {
    setShell((prev) => (prev ? { ...prev, app } : prev));
    void ipc.setApp(app).catch((e) => setError(errorMessage(e)));
  };

  return (
    <div className={`msh-root ${theme === "dark" ? "msh-dark" : ""}`}>
      <MiniShellErrorBoundary fallbackTitle="Mini computer desktop view stopped working">
        <ShellBody
          boot={boot}
          shell={shell}
          setShell={setShell}
          onSwitchApp={switchApp}
          theme={theme}
          onToggleTheme={toggleTheme}
        />
      </MiniShellErrorBoundary>
      {error ? (
        <div className="msh-toast" role="status" onClick={() => setError(null)}>
          {error}
        </div>
      ) : null}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <MiniShellErrorBoundary fallbackTitle="Mini computer could not start">
    <App />
  </MiniShellErrorBoundary>
);
