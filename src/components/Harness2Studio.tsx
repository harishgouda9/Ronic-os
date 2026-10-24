import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Step } from "../types";
import { isTauri } from "../api";
import { useOmni } from "../store";

const COMPONENTS: [string, string][] = [
  ["system_prompt", "System prompt (SOUL.md)"],
  ["guardrails", "Soft guardrails"],
  ["memory", "Memory"],
  ["tool_guidance", "Tool guidance (omni.d.ts)"],
  ["subagents", "Subagents (#squad)"],
  ["skills", "Skills (SKILL.md)"],
  ["scripts", "Scripts"],
  ["plugins", "Plugins"],
];

type Flags = {
  mode: "off" | "auto" | "force" | string;
  recursion: "parallel" | "sequential" | string;
  budgetK: number;
  threshold: number;
  escalate: boolean;
  editorLabel: string;
  substrate: string;
  components: string[];
};

type HarnessStatus = {
  flags: Flags;
  uvPath: string;
  repoDir: string;
  repoPresent: boolean;
  venvPresent: boolean;
  demoPresent: boolean;
  version: string;
  note: string;
  lastCheck: string;
  runCount: number;
  libraryCount: number;
};

type RunCard = {
  runId: string;
  botId: string;
  trigger: string;
  score: number;
  reasons: string[];
  recursion: string;
  budgetK: number;
  editor: string;
  executor: string;
  components: string[];
  probesExecuted: boolean;
  probeNote: string;
  proposal: string;
  adopted: boolean;
  promoted: boolean;
  soulUntouched: boolean;
  backupPath: string;
  log: string;
  outputFiles: string[];
};

type Score = { value: number; reasons: string[]; armed: boolean; threshold: number };
type InstallReport = { ok: boolean; already: boolean; uvPath: string; log: string };
type LibraryEntry = {
  id: string;
  botId: string;
  domainTag: string;
  componentType: string;
  title: string;
  whenToApplyRule: string;
  behavioralEvidence: string;
  artifactPathOrContent: string;
  sourceRunId: string;
};

const FLAG_EVENT = "omni-harness2-flags";

function publish(status: HarnessStatus) {
  window.dispatchEvent(new CustomEvent(FLAG_EVENT, { detail: status }));
}

async function saveFlags(patch: Record<string, unknown>): Promise<HarnessStatus> {
  const next = await invoke<HarnessStatus>("harness2_set_flags", { patch });
  publish(next);
  return next;
}

export function SuperchargeControl({ compact = false }: { compact?: boolean }) {
  const desktop = isTauri();
  const steps = useOmni((s) => s.snap?.steps ?? []);
  const [status, setStatus] = useState<HarnessStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const latest = [...steps].reverse().find((step) => step.actionType === "harness2_pipeline");
  const card = latest ? (latest.actionPayload as Partial<RunCard>) : null;

  useEffect(() => {
    if (!desktop) return;
    let alive = true;
    invoke<HarnessStatus>("harness2_status")
      .then((next) => { if (alive) setStatus(next); })
      .catch(() => { if (alive) setStatus(null); });
    const onFlags = (event: Event) => {
      const detail = (event as CustomEvent<HarnessStatus>).detail;
      if (detail) setStatus(detail);
    };
    window.addEventListener(FLAG_EVENT, onFlags);
    return () => {
      alive = false;
      window.removeEventListener(FLAG_EVENT, onFlags);
    };
  }, [desktop]);

  const mode = status?.flags.mode ?? "auto";
  const label = mode === "force" ? "Force ON" : mode === "off" ? "Off" : "Auto";
  const live = card && mode !== "off" ? `Score ${card.score ?? 0}/100 · k=${card.budgetK ?? status?.flags.budgetK ?? 1}` : "";

  async function setMode(next: string) {
    if (!desktop) return;
    setBusy(true);
    try {
      setStatus(await saveFlags({ mode: next }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <label className={`flex items-center gap-1 rounded-[6px] border border-[#E5E5E5] bg-white px-2 py-1 text-[11px] font-semibold text-[#111111] ${compact ? "" : ""}`} title={desktop ? "Supercharge records a local plan. It does not start a model probe." : "Supercharge runs in the desktop app."}>
      <span>Supercharge</span>
      <select
        aria-label="Supercharge mode"
        className="bg-transparent text-[11px] font-semibold"
        value={mode}
        disabled={!desktop || busy}
        onChange={(event) => void setMode(event.target.value)}
      >
        <option value="auto">Auto</option>
        <option value="force">Force ON</option>
        <option value="off">Off</option>
      </select>
      {compact ? null : <span className="font-normal text-[#64748B]">{label}{live ? ` · ${live}` : ""}</span>}
    </label>
  );
}

export function Harness2PipelineCard({ step }: { step: Step }) {
  const desktop = isTauri();
  const payload = step.actionPayload as Partial<RunCard>;
  const [card, setCard] = useState<Partial<RunCard>>(payload);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setCard(step.actionPayload as Partial<RunCard>);
  }, [step.id, step.actionPayload]);

  async function act(command: "harness2_keep" | "harness2_promote" | "harness2_revert") {
    if (!desktop || !card.runId) return;
    setBusy(true);
    setNote("");
    try {
      setCard(await invoke<RunCard>(command, { runId: card.runId }));
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  const components = card.components ?? [];
  return (
    <article className="step tool-card">
      <div className="between">
        <strong>Supercharge (Harness²)</strong>
        <span className="faint">{card.trigger || "plan"}</span>
      </div>
      <p className="step-copy">
        {card.trigger === "auto_mid_run_error"
          ? "Mid-run error recorded. No second model was started."
          : `Local score ${card.score ?? 0}/100. ${card.recursion || "parallel"} · k=${card.budgetK ?? 1}.`}
        {" "}Editor: {card.editor || "Local plan only"}. Executor: {card.executor || "not started"}.
      </p>
      <div className="grid gap-2 md:grid-cols-3">
        <section className="rounded-[6px] border border-[#E5E5E5] bg-[#FAFAFA] p-2">
          <h3 className="text-xs font-semibold">1. Propose</h3>
          <p className="mt-1 text-xs text-[#64748B]">{components.length ? components.join(", ") : "No components recorded."}</p>
        </section>
        <section className="rounded-[6px] border border-[#E5E5E5] bg-[#FAFAFA] p-2">
          <h3 className="text-xs font-semibold">2. Contrastive probe</h3>
          <p className="mt-1 text-xs text-[#64748B]">{card.probesExecuted ? "A local process exited 0." : "Probes were not executed."}</p>
        </section>
        <section className="rounded-[6px] border border-[#E5E5E5] bg-[#FAFAFA] p-2">
          <h3 className="text-xs font-semibold">3. Compose and reflect</h3>
          <p className="mt-1 text-xs text-[#64748B]">{card.soulUntouched === false ? "The plan was appended to the base soul." : "Base soul was not modified."} {card.adopted ? "Library updated." : "Library not updated yet."}</p>
        </section>
      </div>
      {card.probeNote ? <p className="mt-2 text-xs text-[#64748B]">{card.probeNote}</p> : null}
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" className="btn small" disabled={!desktop || busy || !card.runId || card.adopted} onClick={() => void act("harness2_keep")}>{card.adopted ? "In the library" : "Keep in library"}</button>
        <button type="button" className="btn ghost small" disabled={!desktop || busy || !card.runId || card.promoted} onClick={() => void act("harness2_promote")}>{card.promoted ? "On the base soul" : "Promote plan to base soul"}</button>
        <button type="button" className="btn ghost small" disabled={!desktop || busy || !card.runId || card.soulUntouched !== false} onClick={() => void act("harness2_revert")}>Restore base soul</button>
      </div>
      {note ? <p className="mt-2 text-xs text-red-700">{note}</p> : null}
    </article>
  );
}

export default function Harness2Studio() {
  const desktop = isTauri();
  const [status, setStatus] = useState<HarnessStatus | null>(null);
  const [banner, setBanner] = useState(desktop ? "Loading Harness²." : "Install, the demo, and chat plans run in the desktop app.");
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState("");
  const [demo, setDemo] = useState<RunCard | null>(null);
  const [library, setLibrary] = useState<LibraryEntry[]>([]);
  const [query, setQuery] = useState("");
  const [sample, setSample] = useState("Reverse engineer the auth module, refactor our Rust middleware, and verify with tests");
  const [score, setScore] = useState<Score | null>(null);

  async function refresh() {
    if (!desktop) return;
    const next = await invoke<HarnessStatus>("harness2_status");
    setStatus(next);
    setBanner(next.note);
    const entries = await invoke<LibraryEntry[]>("harness2_library", { query });
    setLibrary(entries);
  }

  useEffect(() => {
    if (!desktop) return;
    refresh().catch((error: unknown) => setBanner(error instanceof Error ? error.message : String(error)));
    const onFlags = (event: Event) => {
      const detail = (event as CustomEvent<HarnessStatus>).detail;
      if (detail) setStatus(detail);
    };
    window.addEventListener(FLAG_EVENT, onFlags);
    return () => window.removeEventListener(FLAG_EVENT, onFlags);
  }, [desktop]);

  const flags = status?.flags;
  const badge = !desktop
    ? "Desktop app"
    : status?.demoPresent
      ? `harness2-demo installed${status.version ? ` ${status.version}` : ""}`
      : status?.repoPresent
        ? "Checkout present, demo command missing"
        : "Not installed";

  async function patch(next: Record<string, unknown>) {
    if (!desktop) return;
    setBusy(true);
    try {
      const saved = await saveFlags(next);
      setStatus(saved);
      setBanner(saved.note);
    } catch (error) {
      setBanner(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  function toggleComponent(id: string) {
    const current = new Set(flags?.components ?? COMPONENTS.map(([key]) => key));
    if (current.has(id)) current.delete(id);
    else current.add(id);
    const components = COMPONENTS.map(([key]) => key).filter((key) => current.has(key));
    if (!components.length) {
      setBanner("At least one component stays in scope.");
      return;
    }
    void patch({ components });
  }

  async function install() {
    if (!desktop) return;
    setBusy(true);
    setLog("");
    try {
      const report = await invoke<InstallReport>("harness2_install");
      setLog(report.log);
      setBanner(report.ok ? (report.already ? "Already installed." : "Install finished.") : "Install did not finish.");
      await refresh();
    } catch (error) {
      setBanner(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function check() {
    if (!desktop) return;
    setBusy(true);
    try {
      const text = await invoke<string>("harness2_check");
      setLog(text);
      setBanner("Readiness check finished. FAIL lines list optional external pieces (judge URL, document tools) — the engine itself is verified by the demo.");
      await refresh();
    } catch (error) {
      setLog(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function runDemo() {
    if (!desktop) return;
    setBusy(true);
    setDemo(null);
    try {
      const card = await invoke<RunCard>("harness2_demo", { budgetK: 2 });
      setDemo(card);
      setLog(card.log);
      setBanner(card.probesExecuted ? "harness2-demo exited 0." : "harness2-demo did not report success.");
    } catch (error) {
      setLog(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function scoreSample() {
    if (!desktop) return;
    setBusy(true);
    try {
      setScore(await invoke<Score>("harness2_score", { prompt: sample, attachmentCount: 0 }));
    } catch (error) {
      setBanner(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  const visible = library.filter((entry) => {
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return `${entry.title} ${entry.domainTag} ${entry.componentType}`.toLowerCase().includes(needle);
  });

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto bg-[#FAFAFA] p-6 font-sans text-[#0F172A]">
      <div className="rounded-[6px] border border-[#E5E5E5] bg-white p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-bold tracking-tight">Harness²</h1>
          <span className="rounded-full border border-[#E5E5E5] bg-[#F8FAFC] px-2 py-0.5 font-mono text-[11px] font-semibold">{badge}</span>
        </div>
        <p className="mt-2 max-w-3xl text-xs text-[#64748B]">
          Supercharge scores a task on this machine and writes a plan into an empty sandbox. It does not start OpenCode, Codex, or Claude, and it does not copy the open project. The base soul changes only after Promote.
        </p>
        <p className="mt-2 font-mono text-xs text-emerald-800">{banner}</p>
      </div>

      <section className="rounded-[6px] border border-[#E5E5E5] bg-white p-4">
        <h2 className="text-sm font-semibold">Engine</h2>
        <p className="mt-1 text-xs text-[#64748B]">{status?.repoDir || "The checkout is created under the Ronic OS home when you install."}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className="rounded-[6px] bg-[#111111] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40" disabled={!desktop || busy} onClick={() => void install()}>Install or verify harness2</button>
          <button type="button" className="rounded-[6px] border border-[#E5E5E5] px-3 py-1.5 text-xs font-semibold disabled:opacity-40" disabled={!desktop || busy || !status?.demoPresent} onClick={() => void check()}>Benchmark readiness (jb)</button>
          <button type="button" className="rounded-[6px] border border-[#E5E5E5] px-3 py-1.5 text-xs font-semibold disabled:opacity-40" disabled={!desktop || busy || !status?.demoPresent} onClick={() => void runDemo()}>Run harness2-demo (--k 2)</button>
        </div>
        <p className="mt-2 text-xs text-[#64748B]">The demo button runs the upstream local demo only after install. It does not call a model API from Ronic OS.</p>
        {log ? <pre className="pre mt-3 max-h-64 overflow-auto whitespace-pre-wrap">{log}</pre> : null}
        {demo ? (
          <div className="mt-3 rounded-[6px] border border-[#E5E5E5] bg-[#FAFAFA] p-3 text-xs">
            <p>Exit evidence: {demo.probesExecuted ? "process exited 0" : "process did not exit 0"}.</p>
            <p className="mt-1">{demo.probeNote}</p>
            {demo.outputFiles.length ? <p className="mt-1 font-mono">Files: {demo.outputFiles.join(", ")}</p> : <p className="mt-1">No output files were listed.</p>}
          </div>
        ) : null}
      </section>

      <section className="rounded-[6px] border border-[#E5E5E5] bg-white p-4">
        <h2 className="text-sm font-semibold">When it arms</h2>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
          <label className="flex items-center gap-2">Recursion
            <select aria-label="Recursion mode" disabled={!desktop || busy} value={flags?.recursion ?? "parallel"} onChange={(event) => void patch({ recursion: event.target.value })}>
              <option value="parallel">Parallel</option>
              <option value="sequential">Sequential</option>
            </select>
          </label>
          <label className="flex items-center gap-2">Budget
            <select aria-label="Budget k" disabled={!desktop || busy} value={String(flags?.budgetK ?? 1)} onChange={(event) => void patch({ budgetK: Number(event.target.value) })}>
              <option value="1">k=1</option>
              <option value="2">k=2</option>
            </select>
          </label>
          <label className="flex items-center gap-2">Threshold {flags?.threshold ?? 65}
            <input aria-label="Complexity threshold" type="range" min={0} max={100} disabled={!desktop || busy} value={flags?.threshold ?? 65} onChange={(event) => void patch({ threshold: Number(event.target.value) })} />
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" disabled={!desktop || busy} checked={flags?.escalate ?? true} onChange={(event) => void patch({ escalate: event.target.checked })} />
            Note a failed terminal command
          </label>
        </div>
        <div className="mt-3 flex flex-wrap gap-3 text-xs">
          <label>Editor label
            <input className="ml-2 rounded-[6px] border border-[#E5E5E5] px-2 py-1" disabled={!desktop || busy} value={flags?.editorLabel ?? "Local plan only"} onChange={(event) => void patch({ editorLabel: event.target.value })} />
          </label>
          <label>Substrate label
            <select className="ml-2" aria-label="Executor substrate" disabled={!desktop || busy} value={flags?.substrate ?? "opencode"} onChange={(event) => void patch({ substrate: event.target.value })}>
              <option value="opencode">OpenCode (not started)</option>
              <option value="codex_cx">Codex (not started)</option>
              <option value="claude_acp">Claude ACP (not started)</option>
            </select>
          </label>
        </div>
        <div className="mt-4 flex gap-2">
          <textarea className="min-h-20 flex-1 rounded-[6px] border border-[#E5E5E5] p-2 font-mono text-xs" value={sample} onChange={(event) => setSample(event.target.value)} />
          <button type="button" className="rounded-[6px] border border-[#111111] px-3 py-1.5 text-xs font-semibold disabled:opacity-40" disabled={!desktop || busy} onClick={() => void scoreSample()}>Score</button>
        </div>
        {score ? (
          <p className="mt-2 text-xs">Score {score.value}/100. Auto would {score.armed ? "arm a plan" : "leave this in normal chat"}. {score.reasons.join(" ")}</p>
        ) : null}
      </section>

      <section className="rounded-[6px] border border-[#E5E5E5] bg-white p-4">
        <h2 className="text-sm font-semibold">Eight editable fields</h2>
        <p className="mt-1 rounded-[6px] border border-[#E5E5E5] bg-[#F8FAFC] px-3 py-2 text-xs">Wallet caps and fail-closed gateway rules stay in the compiled kernel. This screen cannot change them.</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {COMPONENTS.map(([id, label]) => (
            <label key={id} className="flex items-center gap-2 rounded-[6px] border border-[#E5E5E5] px-3 py-2 text-xs">
              <input type="checkbox" disabled={!desktop || busy} checked={flags?.components?.includes(id) ?? true} onChange={() => toggleComponent(id)} />
              {label}
            </label>
          ))}
        </div>
      </section>

      <section className="rounded-[6px] border border-[#E5E5E5] bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">Experience library ({status?.libraryCount ?? 0})</h2>
          <input aria-label="Search library" className="rounded-[6px] border border-[#E5E5E5] px-2 py-1 text-xs" placeholder="Search lessons" value={query} onChange={(event) => setQuery(event.target.value)} />
        </div>
        {visible.length === 0 ? <p className="mt-3 text-xs text-[#64748B]">No library entries yet. Keep a plan to append EXPERIENCE.md and a Mem0 note.</p> : (
          <ul className="mt-3 space-y-2">
            {visible.map((entry) => (
              <li key={entry.id} className="rounded-[6px] border border-[#E5E5E5] p-3 text-xs">
                <strong>{entry.title}</strong>
                <p className="text-[#64748B]">{entry.componentType} · {entry.domainTag}</p>
                <p>{entry.whenToApplyRule}</p>
                <p className="text-[#64748B]">{entry.behavioralEvidence}</p>
                <p className="font-mono">{entry.artifactPathOrContent}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
