import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

type Pane = { width: number; open: boolean };

export function usePane(key: string, fallback: number) {
  const [state, setState] = useState<Pane>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(key) || "") as Pane;
      if (raw && typeof raw.width === "number" && raw.width >= 120) return { width: raw.width, open: raw.open !== false };
    } catch { /* keep the default width */ }
    return { width: fallback, open: true };
  });
  const last = useRef(state.width || fallback);

  useEffect(() => {
    if (state.open && state.width >= 120) last.current = state.width;
    localStorage.setItem(key, JSON.stringify(state));
  }, [key, state]);

  function apply(width: number, max = Math.round(window.innerWidth * 0.72)) {
    if (width < 72) {
      setState((prev) => ({ width: prev.width >= 120 ? prev.width : last.current, open: false }));
      return;
    }
    const cap = Math.max(160, max);
    setState({ width: Math.min(Math.max(160, Math.round(width)), cap), open: true });
  }

  function drag(event: ReactPointerEvent, sign: 1 | -1 = 1, source = "1") {
    event.preventDefault();
    event.stopPropagation();
    const start = event.clientX;
    const origin = state.open ? state.width : 0;
    const previous = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    document.body.dataset.paneDrag = source;
    const move = (pointer: PointerEvent) => {
      apply(origin + (pointer.clientX - start) * sign);
    };
    const end = () => {
      document.body.style.userSelect = previous;
      delete document.body.dataset.paneDrag;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
  }

  function restore() {
    setState({ width: Math.max(160, last.current || fallback), open: true });
  }

  function collapse() {
    setState((prev) => ({ width: prev.width >= 120 ? prev.width : last.current, open: false }));
  }

  function resize(width: number, max?: number) {
    apply(width, max);
  }

  return { width: state.width, open: state.open, drag, restore, collapse, resize };
}

export function PaneEdge({ label, onDrag }: { label: string; onDrag: (event: ReactPointerEvent) => void }) {
  return <div className="resize-handle vertical" role="separator" aria-label={`Resize ${label}`} tabIndex={0} onPointerDown={onDrag} />;
}

export function PaneButton({ label, onOpen, onDrag }: { label: string; onOpen: () => void; onDrag: (event: ReactPointerEvent) => void }) {
  const moved = useRef(false);
  return (
    <button
      type="button"
      className="pane-restore"
      aria-label={`Show ${label}`}
      onPointerDown={(event) => {
        moved.current = false;
        const start = event.clientX;
        const watch = (pointer: PointerEvent) => {
          if (Math.abs(pointer.clientX - start) > 4) moved.current = true;
        };
        const stop = () => {
          window.removeEventListener("pointermove", watch);
          window.removeEventListener("pointerup", stop);
          if (!moved.current) onOpen();
        };
        window.addEventListener("pointermove", watch);
        window.addEventListener("pointerup", stop);
        onDrag(event);
      }}
    >
      {label}
    </button>
  );
}
