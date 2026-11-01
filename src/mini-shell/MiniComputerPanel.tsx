import { useEffect, useState } from "react";
import { ExternalLink, Power, RefreshCw } from "lucide-react";
import { ipc, errorMessage, isTauri } from "../mini-shell/ipc";
import type { ShellBoot, ShellState } from "../mini-shell/types";
import { ShellBody, useMiniTheme, useShellEvents } from "../mini-shell/apps/ShellBody";
import { MiniShellErrorBoundary } from "./ErrorBoundary";

/**
 * The bot's mini computer, embedded in the chat dock. Runs inside the MAIN
 * webview and addresses the inspected bot explicitly (botId), so it controls
 * exactly that bot's isolated computer — Files, Terminal, and the Chrome
 * toolbar/tab strip. The live web page itself still renders only in the bot's
 * own mini computer window (a native webview cannot be embedded here), so the
 * panel's Chrome view shows the tab strip + toolbar and a launcher card for
 * the page; "Open window" brings the bot's window to the front.
 */
export function MiniComputerPanel({ botId, botHandle }: { botId: string; botHandle: string }) {
  const [boot, setBoot] = useState<ShellBoot | null>(null);
  const [shell, setShell] = useState<ShellState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [theme, toggleTheme] = useMiniTheme();

  const refresh = () => {
    setBusy(true);
    ipc
      .boot(botId)
      .then((info) => {
        setBoot({ ...info, botHandle });
        setShell(info.shell);
        setError(null);
      })
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setBusy(false));
  };

  useEffect(() => {
    setBoot(null);
    setShell(null);
    setError(null);
    ipc
      .boot(botId)
      .then((info) => {
        setBoot({ ...info, botHandle });
        setShell(info.shell);
      })
      .catch((e) => setError(errorMessage(e)));
  }, [botId, botHandle]);

  useShellEvents(botId, setShell);

  const spawnWindow = async () => {
    setBusy(true);
    try {
      if (isTauri()) {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("spawn_bot_mini_computer_window", {
          botId,
          botHandle,
          initialUrl: "",
          alwaysOnTop: false,
        });
      } else {
        window.open("/mini-shell.html", `ronic_mini_comp_${botId}`, "width=980,height=660,resizable=yes");
      }
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const switchApp = (app: ShellState["app"]) => {
    setShell((prev) => (prev ? { ...prev, app } : prev));
    void ipc.setApp(app, botId).catch((e) => setError(errorMessage(e)));
  };

  if (error && !boot) {
    return (
      <div className="stack" style={{ padding: 12 }}>
        <p className="muted">This mini computer could not start.</p>
        <p className="msh-error">{error}</p>
        <button type="button" className="btn small" onClick={refresh}>Try again</button>
      </div>
    );
  }
  if (!boot || !shell) {
    return (
      <div className="stack" style={{ padding: 12 }}>
        <p className="muted">Starting {botHandle}&rsquo;s mini computer…</p>
      </div>
    );
  }

  const windowOpen = shell.windowOpen !== false;

  return (
    <div className={`msh-root ${theme === "dark" ? "msh-dark" : ""} msh-compact`} style={{ minHeight: 0 }}>
      <div className="msh-panel-head">
        <span className="msh-panel-title">
          {botHandle}&rsquo;s computer — {shell.tabs.length} tab{shell.tabs.length === 1 ? "" : "s"}
        </span>
        <button type="button" className="msh-tool" title="Refresh" aria-label="Refresh" onClick={refresh}>
          <RefreshCw size={12} aria-hidden className={busy ? "msh-spin" : ""} />
        </button>
        {windowOpen ? (
          <button
            type="button"
            className="msh-tool"
            title="Bring the bot's mini computer window to the front (the live page renders there)"
            aria-label="Open window"
            onClick={() => void spawnWindow()}
          >
            <ExternalLink size={12} aria-hidden />
          </button>
        ) : (
          <button
            type="button"
            className="msh-tool"
            title="Start this bot's mini computer window"
            aria-label="Start window"
            onClick={() => void spawnWindow()}
          >
            <Power size={12} aria-hidden />
          </button>
        )}
      </div>
      <MiniShellErrorBoundary fallbackTitle={`${botHandle}’s desktop view could not render`}>
        <ShellBody
          boot={boot}
          shell={shell}
          setShell={setShell}
          onSwitchApp={switchApp}
          compact
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
