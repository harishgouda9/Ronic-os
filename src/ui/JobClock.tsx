import { useEffect, useRef } from "react";
import { anchorFor, isDue, markFired, parseSchedule, readFired, readModelMeta } from "../kernel/workspaceChrome";
import { effortFor } from "../kernel/modelPrefs";
import { useOmni } from "../store";

export function JobClock() {
  const ready = useOmni((s) => Boolean(s.snap?.vaultUnlocked && s.snap.onboardingComplete));
  const run = useOmni((s) => s.run);
  const inflight = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!ready) return;
    let dead = false;

    const tick = () => {
      if (dead || inflight.current.size > 0) return;
      const state = useOmni.getState();
      if (state.busy || state.pending) return;
      const meta = readModelMeta();
      if (!meta) return;
      const threads = state.snap?.threads ?? [];
      const now = Date.now();
      const fired = readFired();
      const job = threads.find((thread) => {
        const schedule = parseSchedule(thread.routineSchedule);
        if (!schedule || inflight.current.has(thread.id)) return false;
        return isDue(schedule, anchorFor(thread.id, thread.routineSchedule, now), fired[thread.id] ?? 0, now);
      });
      if (!job) return;
      inflight.current.add(job.id);
      markFired(job.id, now);
      void run("run_routine", {
        threadId: job.id,
        providerId: meta.providerId,
        model: meta.upstreamModel,
        modelId: meta.id,
        effort: effortFor(meta.id),
      }).finally(() => {
        inflight.current.delete(job.id);
      });
    };

    const start = window.setTimeout(tick, 5000);
    const timer = window.setInterval(tick, 20000);
    return () => {
      dead = true;
      window.clearTimeout(start);
      window.clearInterval(timer);
    };
  }, [ready, run]);

  return null;
}
