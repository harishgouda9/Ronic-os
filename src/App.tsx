import { useEffect } from "react";
import { Screen } from "./screens/Screen";
import { useRonic } from "./store";
import { Shell } from "./ui/Shell";

export function App() {
  const boot = useRonic((s) => s.boot);
  const snap = useRonic((s) => s.snap);
  const loading = useRonic((s) => s.loading);
  const error = useRonic((s) => s.error);
  const recover = useRonic((s) => s.recover);
  const setPalette = useRonic((s) => s.setPalette);
  const setDebug = useRonic((s) => s.setDebug);
  const setBug = useRonic((s) => s.setBug);
  const toast = useRonic((s) => s.toast);
  const setToast = useRonic((s) => s.setToast);

  useEffect(() => {
    void boot();
  }, [boot]);

  useEffect(() => {
    if (!snap) return;
    document.documentElement.dataset.theme = snap.settings.theme;
    document.documentElement.dataset.density = snap.settings.density;
  }, [snap]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const meta = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (meta && key === "k") {
        event.preventDefault();
        setPalette(!useRonic.getState().palette);
      } else if (meta && event.shiftKey && key === "d") {
        event.preventDefault();
        setDebug(!useRonic.getState().debug);
      } else if (meta && event.shiftKey && key === "r") {
        event.preventDefault();
        void recover();
      } else if (meta && (event.key === "`" || event.code === "Backquote")) {
        event.preventDefault();
        useRonic.getState().toggleTerminal();
      } else if (event.key === "Escape") {
        setPalette(false);
        setDebug(false);
        setBug(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [recover, setBug, setDebug, setPalette]);

  useEffect(() => {
    document.title = "Ronic OS";
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4200);
    return () => window.clearTimeout(timer);
  }, [toast, setToast]);

  if (loading) {
    return (
      <div className="app boot" role="status" aria-live="polite">
        <div className="boot-card">
          <img className="boot-logo" src="/brand/logo.png" alt="" draggable={false} />
          <h1 className="boot-title">Ronic OS</h1>
          <p className="boot-sub">Opening the local workspace…</p>
          <div className="boot-bar" aria-hidden="true">
            <i />
          </div>
        </div>
      </div>
    );
  }

  if (!snap) {
    return (
      <div className="app">
        <div className="center-card stack">
          <h1 className="title">Workspace did not open</h1>
          <p className="muted">{error ?? "The kernel returned no snapshot."}</p>
          <button className="btn" onClick={() => void boot()}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <Shell>
      <Screen />
    </Shell>
  );
}
