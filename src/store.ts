import { create } from "zustand";
import { call, isTauri } from "./api";
import { RAIL } from "./types";
import type { CommandResult, ScreenId, Snapshot } from "./types";

// sessionStorage can hold a screen id from an older build; anything unknown
// falls back to chat instead of flowing into typed lookups.
const KNOWN_SCREENS: readonly ScreenId[] = [
  ...RAIL.map((item) => item.id),
  "onboarding",
  "vault",
  "profiles",
  "capabilities",
];

type QueuedMessage = {
  id: string;
  text: string;
  files: string[];
  queuedAt: number;
};

export type ApprovalMode = "auto" | "ask" | "manual";

type State = {
  snap: Snapshot | null;
  screen: ScreenId;
  loading: boolean;
  error: string | null;
  toast: string | null;
  palette: boolean;
  debug: boolean;
  bug: boolean;
  busy: boolean;
  recovering: boolean;
  pending: string | null;
  generation: number;
  messageQueue: QueuedMessage[];
  approvalMode: ApprovalMode;
  setApprovalMode: (mode: ApprovalMode) => void;
  boot: () => Promise<void>;
  go: (screen: ScreenId) => void;
  run: (cmd: string, args?: Record<string, unknown>) => Promise<CommandResult | null>;
  recover: () => Promise<void>;
  setToast: (toast: string | null) => void;
  setPalette: (open: boolean) => void;
  setDebug: (open: boolean) => void;
  setBug: (open: boolean) => void;
  terminal: boolean;
  setTerminal: (open: boolean) => void;
  toggleTerminal: () => void;
  queueMessage: (text: string, files: string[]) => void;
  dequeueMessage: () => QueuedMessage | null;
  removeFromQueue: (id: string) => void;
  clearQueue: () => void;
};

export const useRonic = create<State>((set, get) => ({
  snap: null,
  screen: "onboarding",
  loading: true,
  error: null,
  toast: null,
  palette: false,
  debug: false,
  bug: false,
  terminal: false,
  setTerminal: (open) => set({ terminal: open }),
  toggleTerminal: () => set((state) => ({ terminal: !state.terminal })),
  busy: false,
  recovering: false,
  pending: null,
  generation: 0,
  messageQueue: [],
  approvalMode: (typeof window !== "undefined" && (localStorage.getItem("ronic.approvalMode") as ApprovalMode)) || "auto",
  setApprovalMode: (mode) => {
    try {
      localStorage.setItem("ronic.approvalMode", mode);
    } catch {}
    set({ approvalMode: mode });
  },
  queueMessage: (text, files) => {
    const msg: QueuedMessage = {
      id: `queued_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      text,
      files,
      queuedAt: Date.now(),
    };
    set((state) => ({ messageQueue: [...state.messageQueue, msg] }));
  },
  dequeueMessage: () => {
    const queue = get().messageQueue;
    if (queue.length === 0) return null;
    const [first, ...rest] = queue;
    set({ messageQueue: rest });
    return first;
  },
  removeFromQueue: (id) => set((state) => ({ messageQueue: state.messageQueue.filter((m) => m.id !== id) })),
  clearQueue: () => set({ messageQueue: [] }),
  boot: () => {
    generation += 1;
    const ticket = generation;
    set({ generation: ticket, loading: true, error: null });
    return enqueue(async () => {
      try {
        const res = await call("bootstrap");
        if (ticket !== generation) return false;
        const saved = sessionStorage.getItem("ronic.screen") as ScreenId | null;
        const known = new Set<string>(KNOWN_SCREENS);
        const stored = saved && known.has(saved) ? saved : null;
        const screen = res.snapshot.onboardingComplete ? stored || "chat" : "onboarding";
        if (!res.snapshot.vaultUnlocked) {
          set({ snap: res.snapshot, loading: false, error: null, screen: "vault" });
          return false;
        }
        set({ snap: res.snapshot, loading: false, error: null, screen, toast: res.toast });
        return res.snapshot.onboardingComplete;
      } catch (error) {
        if (ticket !== generation) return false;
        set({ loading: false, error: error instanceof Error ? error.message : String(error) });
        return false;
      }
    }).then((ready) => {
      if (ready && ticket === generation) scanMachine();
      startSnapshotPolling();
    });
  },
  go: (screen) => {
    sessionStorage.setItem("ronic.screen", screen);
    set({ screen, palette: false });
  },
  run: async (cmd, args) => {
    const ticket = generation;
    depth += 1;
    const modelWait = cmd === "send_message" || cmd === "run_routine" || cmd === "resolve_gateway";
    set({ busy: true, error: null, ...(modelWait ? { pending: cmd } : {}) });
    try {
      const res = await enqueue(async () => {
        const res = await call(cmd, args);
        if (ticket !== generation) return res;
        const screen = !res.snapshot.vaultUnlocked
          ? "vault"
          : get().screen === "onboarding" && res.snapshot.onboardingComplete
            ? "chat"
            : get().screen;
        set({ snap: res.snapshot, toast: res.toast, screen });
        return res;
      });
      if (ticket !== generation) return res;
      if (res && (cmd === "unlock_vault" || cmd === "complete_onboarding") && res.snapshot.vaultUnlocked && res.snapshot.onboardingComplete) {
        scanMachine();
      }
      return res;
    } catch (error) {
      if (ticket !== generation) return null;
      const message = error instanceof Error ? error.message : String(error);
      set({ toast: message });
      return null;
    } finally {
      // Every in-flight run must release its slot even when a boot or recover
      // bumped the generation under it, or busy sticks true and every button
      // gated on it (Create bot, Save profile) stays disabled forever.
      depth = Math.max(0, depth - 1);
      if (depth === 0) set({ busy: false, pending: null });
    }
  },
  recover: async () => {
    generation += 1;
    const ticket = generation;
    depth = 0;
    set({ generation: ticket, loading: false, busy: false, recovering: true, pending: null, error: null, toast: "Refreshing workspace and reconnecting models…" });
    try {
      const res = await call("refresh_workspace");
      if (ticket !== generation) return;
      const screen = !res.snapshot.vaultUnlocked
        ? "vault"
        : get().screen === "onboarding" && res.snapshot.onboardingComplete
          ? "chat"
          : get().screen;
      set({ snap: res.snapshot, toast: res.toast, screen, loading: false, busy: false, recovering: false, pending: null });
    } catch (error) {
      if (ticket !== generation) return;
      const message = error instanceof Error ? error.message : String(error);
      set({ toast: message, loading: false, busy: false, recovering: false, pending: null });
    }
  },
  setToast: (toast) => set({ toast }),
  setPalette: (palette) => set({ palette }),
  setDebug: (debug) => set({ debug }),
  setBug: (bug) => set({ bug }),
}));

let tail: Promise<void> = Promise.resolve();
let depth = 0;
let generation = 0;

function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const run = tail.then(work, work);
  tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function scanMachine() {
  if (!isTauri()) return;
  const ticket = generation;
  void enqueue(async () => {
    if (ticket !== generation) return;
    const baseline = useRonic.getState().snap;
    if (!baseline) return;
    try {
      const scanned = await call("scan_environment");
      if (ticket !== generation) return;
      const current = useRonic.getState().snap;
      if (current !== baseline) {
        const fresh = await call("refresh_workspace");
        if (ticket !== generation) return;
        useRonic.setState({ snap: fresh.snapshot, toast: scanned.toast });
        return;
      }
      useRonic.setState({ snap: scanned.snapshot, toast: scanned.toast });
    } catch {
      /* a missed scan leaves the last snapshot in place */
    }
  });
}

// Live snapshot poll: the sentinel fleet rescans every 30s in the background
// and run states move without user input, so the UI refreshes on a slow tick
// instead of only when a button is pressed. While a model turn is in flight
// (pending is set) the poll keeps running so the live "bot is working on X"
// indicator updates in real time — the kernel is read-only between commands,
// so snapshot_poll cannot race the model call. A missed poll is a no-op.
let pollTimer: ReturnType<typeof setInterval> | null = null;
const POLL_MS = 4000;
const POLL_BUSY_MS = 1500;

export function startSnapshotPolling() {
  if (pollTimer || !isTauri()) return;
  const tick = () => {
    const { snap, busy, recovering, loading, pending } = useRonic.getState();
    const modelTurnInFlight = pending === "send_message" || pending === "run_routine" || pending === "resolve_gateway";
    const nextDelay = modelTurnInFlight ? POLL_BUSY_MS : POLL_MS;
    pollTimer = setTimeout(tick, nextDelay);
    void (async () => {
      if (!snap || !snap.vaultUnlocked || recovering || loading) return;
      // During a model turn the snapshot poll stays live so turnActivity
      // updates stream through; otherwise a busy app skips to avoid racing
      // mutating commands.
      if (!modelTurnInFlight && (busy || depth > 0)) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      try {
        const res = await call("snapshot_poll");
        if (!modelTurnInFlight && depth > 0) return;
        const latestPending = useRonic.getState().pending;
        const stillBusy = latestPending === "send_message" || latestPending === "run_routine" || latestPending === "resolve_gateway";
        if (!stillBusy && useRonic.getState().busy) return;
        // Merge by stable key, not length: always take the server's persisted
        // step list (so finished turns drop their turn_activity markers) and
        // only re-attach the client's own optimistic bubbles on top.
        const prevSnap = useRonic.getState().snap;
        const nextSnap = prevSnap
          ? { ...res.snapshot, steps: [...res.snapshot.steps, ...prevSnap.steps.filter((s) => s.id.startsWith("optimistic_"))] }
          : res.snapshot;
        useRonic.setState({ snap: nextSnap });
      } catch {
        /* a missed poll leaves the last snapshot in place */
      }
    })();
  };
  pollTimer = setTimeout(tick, POLL_MS);
}
