import { create } from "zustand";
import { call, isTauri } from "./api";
import type { CommandResult, ScreenId, Snapshot } from "./types";

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
};

export const useOmni = create<State>((set, get) => ({
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
  boot: () => {
    generation += 1;
    const ticket = generation;
    set({ generation: ticket, loading: true, error: null });
    return enqueue(async () => {
      try {
        const res = await call("bootstrap");
        if (ticket !== generation) return false;
        const saved = sessionStorage.getItem("omni.screen") as ScreenId | null;
        const screen = res.snapshot.onboardingComplete ? saved || "chat" : "onboarding";
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
    });
  },
  go: (screen) => {
    sessionStorage.setItem("omni.screen", screen);
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
    const baseline = useOmni.getState().snap;
    if (!baseline) return;
    try {
      const scanned = await call("scan_environment");
      if (ticket !== generation) return;
      const current = useOmni.getState().snap;
      if (current !== baseline) {
        const fresh = await call("refresh_workspace");
        if (ticket !== generation) return;
        useOmni.setState({ snap: fresh.snapshot, toast: scanned.toast });
        return;
      }
      useOmni.setState({ snap: scanned.snapshot, toast: scanned.toast });
    } catch {
      /* a missed scan leaves the last snapshot in place */
    }
  });
}
