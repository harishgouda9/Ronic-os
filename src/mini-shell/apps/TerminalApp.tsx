import { useEffect, useRef, useState } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import "xterm/css/xterm.css";
import { RotateCw, Trash } from "lucide-react";
import { errorMessage, ipc, isTauri } from "../ipc";
import type { ShellBoot } from "../types";

/**
 * The bot's own terminal: a real PTY rooted at the bot's workspace, the SAME
 * session the agent's terminal_write reaches (session "mini-<botId>") —
 * so what the user sees here is exactly what the bot types.
 */
export function TerminalApp({ boot, active }: { boot: ShellBoot; active: boolean }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [started, setStarted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasBeenActive, setHasBeenActive] = useState(active);

  useEffect(() => {
    if (active && !hasBeenActive) {
      setHasBeenActive(true);
    }
  }, [active, hasBeenActive]);

  const fit = () => {
    const term = termRef.current;
    const fit = fitRef.current;
    const host = hostRef.current;
    if (!term || !fit || !host) return;
    if (host.clientWidth <= 10 || host.clientHeight <= 10) return;
    try {
      fit.fit();
      void ipc.resizeTerminal(boot.sessionId, term.cols, term.rows).catch(() => {});
    } catch {
      /* host not sized yet */
    }
  };

  useEffect(() => {
    if (!hasBeenActive) return;
    let alive = true;
    let unlistenOutput: (() => void) | null = null;
    const term = new Terminal({
      fontSize: 12,
      fontFamily: '"Cascadia Mono", Consolas, monospace',
      cursorBlink: true,
      convertEol: false,
      theme: { background: "#0d0d14", foreground: "#e6e6f0", cursor: "#a78bfa", selectionBackground: "#4c1d95" },
      scrollback: 4000,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    termRef.current = term;
    fitRef.current = fitAddon;
    if (hostRef.current) term.open(hostRef.current);

    const start = async () => {
      try {
        if (isTauri()) {
          await ipc.spawnTerminal(boot.sessionId, term.cols || 100, term.rows || 28, boot.workspacePath);
          if (!alive) return;
          setStarted(true);
          const { listen } = await import("@tauri-apps/api/event");
          if (!alive) return;
          unlistenOutput = await listen<number[] | Uint8Array>(`pty-output-${boot.sessionId}`, (event) => {
            const payload = event.payload;
            term.write(typeof Uint8Array !== "undefined" && payload instanceof Uint8Array ? payload : new Uint8Array(payload));
          });
          term.onData((data) => {
            void ipc.writeTerminal(boot.sessionId, data).catch(() => {});
          });
          term.onResize(({ cols, rows }) => {
            void ipc.resizeTerminal(boot.sessionId, cols, rows).catch(() => {});
          });
        } else {
          setStarted(true);
          term.writeln("\x1b[1;36m●\x1b[0m Ronic Mini Computer Terminal (Browser Sandbox)");
          term.writeln(`Rooted at ${boot.workspacePath}`);
          term.writeln("Type commands below. In desktop mode, this connects to a live OS PTY.\n");
          term.write("$ ");
          let line = "";
          term.onData((data) => {
            if (data === "\r") {
              term.writeln("");
              const cmd = line.trim();
              if (cmd === "clear") {
                term.clear();
              } else if (cmd === "ls") {
                term.writeln("README.md  src  workspace.config.json  task_plan.md");
              } else if (cmd === "pwd") {
                term.writeln(boot.workspacePath);
              } else if (cmd.length > 0) {
                term.writeln(`${cmd}: command simulated in browser preview`);
              }
              line = "";
              term.write("$ ");
            } else if (data === "\u007F") {
              if (line.length > 0) {
                line = line.slice(0, -1);
                term.write("\b \b");
              }
            } else if (data >= " ") {
              line += data;
              term.write(data);
            }
          });
        }
        if (active) {
          fit();
        }
      } catch (e) {
        if (alive) setError(errorMessage(e));
      }
    };
    void start();

    return () => {
      alive = false;
      unlistenOutput?.();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [hasBeenActive, boot.sessionId, boot.workspacePath]);

  // Re-fit when the app becomes visible (hidden containers have no size).
  useEffect(() => {
    if (active) requestAnimationFrame(fit);
  }, [active]);

  useEffect(() => {
    const onResize = () => {
      if (active) fit();
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [active]);

  const restart = async () => {
    try {
      await ipc.closeTerminal(boot.sessionId);
    } catch {
      /* session may already be gone */
    }
    await ipc.spawnTerminal(boot.sessionId, termRef.current?.cols || 100, termRef.current?.rows || 28, boot.workspacePath);
  };

  return (
    <div className="msh-terminal">
      <div className="msh-terminal-bar">
        <span className="msh-terminal-title">
          {boot.sessionId} · powershell at {boot.workspacePath}
        </span>
        <span className="msh-terminal-note">Shared with the bot&rsquo;s terminal_write — what it types lands here live.</span>
        <button className="msh-tool" aria-label="Clear terminal" onClick={() => termRef.current?.clear()}>
          <Trash size={12} aria-hidden />
        </button>
        <button className="msh-tool" aria-label="Restart shell" onClick={() => void restart()}>
          <RotateCw size={12} aria-hidden />
        </button>
      </div>
      <div className="msh-terminal-host" ref={hostRef} />
      {!started && !error ? <p className="msh-empty">Opening shell…</p> : null}
      {error ? <p className="msh-error">{error}</p> : null}
    </div>
  );
}
