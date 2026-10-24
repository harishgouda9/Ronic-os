import { useEffect, useState } from "react";
import { Copy, Minus, Square, X } from "lucide-react";
import { isTauri } from "../api";

type DesktopWindow = {
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<void>;
  close: () => Promise<void>;
  isMaximized: () => Promise<boolean>;
  setDecorations: (decorated: boolean) => Promise<void>;
  setTitle: (title: string) => Promise<void>;
  onResized: (handler: () => void) => Promise<() => void>;
};

async function desktopWindow() {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow() as unknown as DesktopWindow;
}

export function useDesktopChrome() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!isTauri()) return;
    let dead = false;
    void (async () => {
      try {
        const win = await desktopWindow();
        await win.setTitle("Ronic OS");
        await win.setDecorations(false);
        if (!dead) setOn(true);
      } catch {
        if (!dead) setOn(false);
      }
    })();
    return () => {
      dead = true;
    };
  }, []);
  return on;
}

export function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let dead = false;
    void (async () => {
      try {
        const win = await desktopWindow();
        const now = await win.isMaximized();
        if (!dead) setMaximized(now);
        unlisten = await win.onResized(() => {
          void win.isMaximized().then((value) => {
            if (!dead) setMaximized(value);
          });
        });
      } catch {
        /* this window cannot report its size */
      }
    })();
    return () => {
      dead = true;
      unlisten?.();
    };
  }, []);

  async function act(kind: "min" | "max" | "close") {
    const win = await desktopWindow();
    if (kind === "min") await win.minimize();
    else if (kind === "max") {
      await win.toggleMaximize();
      setMaximized(await win.isMaximized());
    } else await win.close();
  }

  return (
    <div className="win-controls">
      <button type="button" aria-label="Minimize" onClick={() => void act("min")}><Minus size={14} /></button>
      <button type="button" aria-label={maximized ? "Restore" : "Maximize"} onClick={() => void act("max")}>
        {maximized ? <Copy size={12} /> : <Square size={12} />}
      </button>
      <button type="button" className="close" aria-label="Close window" onClick={() => void act("close")}><X size={14} /></button>
    </div>
  );
}
