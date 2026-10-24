import { useEffect } from "react";
import { Screen } from "./screens/Screen";
import { useOmni } from "./store";
import { Shell } from "./ui/Shell";

export function App() {
  const boot = useOmni((s) => s.boot);
  const snap = useOmni((s) => s.snap);
  const loading = useOmni((s) => s.loading);
  const error = useOmni((s) => s.error);
  const recover = useOmni((s) => s.recover);
  const setPalette = useOmni((s) => s.setPalette);
  const setDebug = useOmni((s) => s.setDebug);
  const setBug = useOmni((s) => s.setBug);
  const toast = useOmni((s) => s.toast);
  const setToast = useOmni((s) => s.setToast);

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
        setPalette(!useOmni.getState().palette);
      } else if (meta && event.shiftKey && key === "d") {
        event.preventDefault();
        setDebug(!useOmni.getState().debug);
      } else if (meta && event.shiftKey && key === "r") {
        event.preventDefault();
        void recover();
      } else if (meta && (event.key === "`" || event.code === "Backquote")) {
        event.preventDefault();
        useOmni.getState().toggleTerminal();
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
      <div className="app">
        <div className="center-card">
          <img className="logo-lockup" src="/brand/logo.png" alt="Ronic OS" />
          <h1 className="title">Ronic OS</h1>
          <p className="muted">Opening the local workspace.</p>
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
