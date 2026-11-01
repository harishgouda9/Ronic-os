import { useEffect, useState, type PointerEvent as ReactPointerEvent } from "react";
import { X } from "lucide-react";
import { anchorFor, dueLabel, forgetSchedule, nextRun, parseSchedule, readFired, rememberSchedule, SCHEDULES, scheduleLabel } from "../kernel/workspaceChrome";
import { useRonic } from "../store";
import { botName } from "./BotCoworkers";

const JOBS_KEY = "ronic.pane.jobs";

function readJobsWidth() {
  try {
    const width = Number(localStorage.getItem(JOBS_KEY));
    if (width >= 220 && width <= 640) return width;
  } catch { /* keep the default */ }
  return 360;
}

export function ScheduledJobs({ open, canRun, onClose, onRun, nudge = 0 }: { open: boolean; canRun: boolean; onClose: () => void; onRun: (threadId: string) => void; nudge?: number }) {
  const snap = useRonic((s) => s.snap)!;
  const run = useRonic((s) => s.run);
  const busy = useRonic((s) => s.busy);
  const [now, setNow] = useState(() => Date.now());
  const [pick, setPick] = useState<string>(SCHEDULES[0].value);
  const [width, setWidth] = useState(readJobsWidth);
  const thread = snap.threads.find((item) => item.id === snap.activeThreadId);

  useEffect(() => {
    if (open) setWidth(readJobsWidth());
  }, [open, nudge]);

  function beginDrag(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const startW = width;
    let shut = false;
    const previous = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    const move = (pointer: PointerEvent) => {
      const next = Math.round(startW + (startX - pointer.clientX));
      if (next < 140) {
        shut = true;
        return;
      }
      shut = false;
      const clamped = Math.min(640, Math.max(220, next));
      setWidth(clamped);
      localStorage.setItem(JOBS_KEY, String(clamped));
    };
    const end = () => {
      document.body.style.userSelect = previous;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      if (shut) onClose();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
  }

  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => setNow(Date.now()), 15000);
    return () => window.clearInterval(timer);
  }, [open]);

  if (!open) return null;

  const jobs = snap.threads.filter((item) => item.routineSchedule.trim());

  return (
    <aside className="jobs-panel" data-jobs-panel style={{ width }}>
      <div className="jobs-handle" role="separator" aria-label="Resize scheduled jobs" onPointerDown={beginDrag} />
      <div className="pane-h">
        <strong>Scheduled jobs</strong>
        <button type="button" className="screen-x" aria-label="Close scheduled jobs" onClick={onClose}><X size={16} /></button>
      </div>
      <div className="pane-b stack">
        <p className="muted">These run while Ronic OS is open. Closing the app pauses them.</p>
        {!canRun ? <p className="muted">Choose a model in the chat. A job uses that model.</p> : null}
        <div className="stack">
          <span>On this chat</span>
          <select className="select" aria-label="Schedule" value={pick} onChange={(event) => setPick(event.target.value)}>
            {SCHEDULES.map((item) => <option key={item.id} value={item.value}>{item.label}</option>)}
          </select>
          <button
            type="button"
            className="btn small"
            disabled={busy || !thread}
            onClick={() => {
              if (!thread) return;
              const stamp = Date.now();
              setNow(stamp);
              rememberSchedule(thread.id, pick, stamp);
              void run("set_routine", { threadId: thread.id, schedule: pick });
            }}
          >
            {thread?.routineSchedule ? "Update this chat" : "Schedule this chat"}
          </button>
          {!thread ? <p className="muted">Open a chat before scheduling it.</p> : null}
        </div>
        {jobs.length === 0 ? <p className="muted">No scheduled jobs yet.</p> : jobs.map((item) => {
          const bot = snap.profiles.find((profile) => profile.id === item.botProfileId);
          const parsed = parseSchedule(item.routineSchedule);
          const when = parsed ? dueLabel(nextRun(parsed, anchorFor(item.id, item.routineSchedule, now), readFired()[item.id] ?? 0, now), now) : "Not a timer";
          return (
            <article key={item.id} className="tool-card stack">
              <div className="between">
                <strong>{item.title || "Chat"}</strong>
                <span className="muted">{when}</span>
              </div>
              <span className="muted">{bot ? botName(bot) : "Bot"} · {scheduleLabel(item.routineSchedule)}</span>
              <div className="row-actions">
                <button type="button" className="btn ghost small" disabled={busy || !canRun || !parsed} onClick={() => onRun(item.id)}>Run now</button>
                <button type="button" className="btn ghost small" disabled={busy} onClick={() => { forgetSchedule(item.id); void run("set_routine", { threadId: item.id, schedule: "" }); }}>Remove</button>
              </div>
            </article>
          );
        })}
      </div>
    </aside>
  );
}
