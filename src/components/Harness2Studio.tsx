import { useEffect, useState } from "react";
import { ArrowLeft, CheckCircle2, Search, Zap } from "lucide-react";
import type { Step } from "../types";
import { isTauri } from "../api";
import { useRonic } from "../store";
import { ChoiceSelect } from "../ui/ChoiceSelect";

async function harness<T>(cmd: string, args: Record<string, unknown> = {}, applySnapshot = false): Promise<T> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(cmd, args);
  }
  const { browserCall } = await import("../kernel/browser");
  const result = await browserCall(cmd, args);
  if (applySnapshot) useRonic.setState({ snap: result.snapshot, toast: result.toast });
  return result.payload as T;
}

const COMPONENTS: [string, string][] = [
  ["system_prompt", "System prompt (SOUL.md)"],
  ["guardrails", "Soft guardrails"],
  ["memory", "Memory"],
  ["tool_guidance", "Tool guidance (ronic.d.ts)"],
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

const FLAG_EVENT = "ronic-harness2-flags";

async function saveFlags(patch: Record<string, unknown>): Promise<HarnessStatus> {
  const status = await harness<HarnessStatus>("harness2_set_flags", { patch });
  window.dispatchEvent(new CustomEvent(FLAG_EVENT, { detail: status }));
  return status;
}

export function SuperchargeControl({ compact, menu }: { compact?: boolean; menu?: "up" | "down" } = {}) {
  const [status, setStatus] = useState<HarnessStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void harness<HarnessStatus>("harness2_status")
      .then((s) => {
        if (alive) setStatus(s);
      })
      .catch(() => {});
    const onFlags = (event: Event) => {
      const detail = (event as CustomEvent<HarnessStatus>).detail;
      if (detail && alive) setStatus(detail);
    };
    window.addEventListener(FLAG_EVENT, onFlags);
    return () => {
      alive = false;
      window.removeEventListener(FLAG_EVENT, onFlags);
    };
  }, []);

  const flags = status?.flags;
  const mode = flags?.mode === "auto" || flags?.mode === "force" ? flags.mode : "off";

  async function setMode(next: string) {
    if (busy) return;
    setBusy(true);
    try {
      const saved = await saveFlags({ mode: next });
      setStatus(saved);
    } finally {
      setBusy(false);
    }
  }

  return (
    <ChoiceSelect
      compact={compact}
      menu={menu}
      label="Supercharge"
      ariaLabel="Supercharge mode"
      title="Scores this message before the model answers. A complex task gets a local checklist in the same turn. A short question stays on the normal path."
      value={mode}
      tone={mode}
      disabled={busy || !status}
      options={[
        { value: "off", label: "Off", hint: "Every message stays on the normal chat path." },
        { value: "auto", label: "Auto", hint: "Complex tasks get a checklist in the same turn. Short questions do not." },
        { value: "force", label: "Force", hint: "The next message gets a checklist before the model answers." },
      ]}
      onChange={(next) => void setMode(next)}
    />
  );
}

export function Harness2PipelineCard({ step }: { step: Step }) {
  const payload = step.actionPayload as Partial<RunCard>;
  const [card, setCard] = useState<Partial<RunCard>>(payload);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setCard(step.actionPayload as Partial<RunCard>);
  }, [step.id, step.actionPayload]);

  async function act(command: "harness2_keep" | "harness2_promote" | "harness2_revert") {
    if (!card.runId) return;
    setBusy(true);
    setNote("");
    try {
      setCard(await harness<RunCard>(command, { runId: card.runId }, true));
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  const components = card.components ?? [];
  return (
    <article className="rounded-2xl border border-slate-200/90 bg-white p-5 shadow-xs space-y-3">
      <div className="flex items-center justify-between border-b border-slate-100 pb-2.5">
        <div className="flex items-center gap-2">
          <Zap size={15} className="text-violet-600" />
          <strong className="text-slate-900 font-bold text-xs">Supercharge (Harness²)</strong>
        </div>
        <span className="text-[11px] font-mono text-slate-400">{card.trigger || "plan"}</span>
      </div>
      <p className="text-xs text-slate-600 leading-relaxed">
        {card.trigger === "auto_mid_run_error"
          ? "A command failed. Supercharge recorded one note. No second model was started."
          : `This plan was attached to the same turn, so the model reads the checklist before it replies. Local score ${card.score ?? 0}/100. ${card.recursion || "parallel"} · k=${card.budgetK ?? 1}.`}
        {" "}Editor: {card.editor || "Local plan only"}. Executor: {card.executor || "not started"}.
      </p>
      <div className="grid gap-2.5 md:grid-cols-3">
        <section className="rounded-xl border border-slate-200 bg-slate-50 p-3">
          <h4 className="text-xs font-bold text-slate-800">1. Propose</h4>
          <p className="mt-1 text-[11px] text-slate-500">{components.length ? components.join(", ") : "No components recorded."}</p>
        </section>
        <section className="rounded-xl border border-slate-200 bg-slate-50 p-3">
          <h4 className="text-xs font-bold text-slate-800">2. Contrastive probe</h4>
          <p className="mt-1 text-[11px] text-slate-500">{card.probesExecuted ? "A local process exited 0." : "Probes were not executed."}</p>
        </section>
        <section className="rounded-xl border border-slate-200 bg-slate-50 p-3">
          <h4 className="text-xs font-bold text-slate-800">3. Compose &amp; reflect</h4>
          <p className="mt-1 text-[11px] text-slate-500">{card.soulUntouched === false ? "The plan was appended to the base soul." : "Base soul was not modified."} {card.adopted ? "Library updated." : "Library not updated yet."}</p>
        </section>
      </div>
      {card.probeNote ? <p className="mt-2 text-xs text-slate-500">{card.probeNote}</p> : null}
      <div className="mt-3 flex flex-wrap gap-2 pt-2 border-t border-slate-100">
        <button
          type="button"
          disabled={busy || !card.runId || card.adopted}
          onClick={() => void act("harness2_keep")}
          className="px-3.5 py-1.5 text-xs font-semibold bg-zinc-800 hover:bg-zinc-700 text-white rounded-full transition-all cursor-pointer shadow-xs disabled:opacity-40 border border-zinc-700/50"
        >
          {card.adopted ? "In the library" : "Keep in library"}
        </button>
        <button
          type="button"
          disabled={busy || !card.runId || card.promoted}
          onClick={() => void act("harness2_promote")}
          className="px-3.5 py-1.5 text-xs font-semibold bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-full transition-all cursor-pointer border border-slate-200 disabled:opacity-40"
        >
          {card.promoted ? "On the base soul" : "Promote plan to base soul"}
        </button>
        <button
          type="button"
          disabled={busy || !card.runId || card.soulUntouched !== false}
          onClick={() => void act("harness2_revert")}
          className="px-3.5 py-1.5 text-xs font-semibold bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-full transition-all cursor-pointer border border-slate-200 disabled:opacity-40"
        >
          Restore base soul
        </button>
      </div>
      {note ? <p className="mt-2 text-xs text-rose-600">{note}</p> : null}
    </article>
  );
}

export default function Harness2Studio() {
  const go = useRonic((s) => s.go);
  const desktop = isTauri();
  const [status, setStatus] = useState<HarnessStatus | null>(null);
  const [banner, setBanner] = useState("Loading Harness².");
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState("");
  const [demo, setDemo] = useState<RunCard | null>(null);
  const [library, setLibrary] = useState<LibraryEntry[]>([]);
  const [query, setQuery] = useState("");
  const [sample, setSample] = useState("Reverse engineer the auth module, refactor our Rust middleware, and verify with tests");
  const [score, setScore] = useState<Score | null>(null);

  async function refresh() {
    const next = await harness<HarnessStatus>("harness2_status");
    setStatus(next);
    setBanner(next.note);
    const entries = await harness<LibraryEntry[]>("harness2_library", { query });
    setLibrary(entries);
  }

  useEffect(() => {
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
    ? "Live in this preview"
    : status?.demoPresent
      ? `harness2-demo installed${status.version ? ` ${status.version}` : ""}`
      : status?.repoPresent
        ? "Checkout present, demo command missing"
        : "Not installed";

  async function patch(next: Record<string, unknown>) {
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
      const report = await harness<InstallReport>("harness2_install");
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
      const text = await harness<string>("harness2_check");
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
      const card = await harness<RunCard>("harness2_demo", { budgetK: 2 });
      setDemo(card);
      setLog(card.log);
      setBanner(card.probesExecuted ? "harness2-demo exited 0." : "harness2-demo did not report success.");
    } catch (error) {
      setLog(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    let alive = true;
    const handle = window.setTimeout(() => {
      void harness<Score>("harness2_score", { prompt: sample, attachmentCount: 0 })
        .then((next) => {
          if (alive) setScore(next);
        })
        .catch((error: unknown) => {
          if (alive) setBanner(error instanceof Error ? error.message : String(error));
        });
    }, 280);
    return () => {
      alive = false;
      window.clearTimeout(handle);
    };
  }, [sample, status?.flags.mode, status?.flags.threshold]);

  const visible = library.filter((entry) => {
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return `${entry.title} ${entry.domainTag} ${entry.componentType}`.toLowerCase().includes(needle);
  });

  return (
    <div className="flex-1 h-full bg-[#eceef2] p-3 sm:p-5 lg:p-6 overflow-y-auto select-none flex flex-col">
      {/* ─── MODAL CONTAINER (MARKETPLACE DESIGN SYSTEM) ─── */}
      <div className="w-full max-w-[1560px] flex-1 min-h-[660px] bg-white rounded-3xl shadow-[0_12px_40px_-8px_rgba(0,0,0,0.06),0_2px_8px_-1px_rgba(0,0,0,0.03)] border border-slate-200/70 flex flex-col mx-auto overflow-hidden transition-all duration-300">
        
        {/* ─── TOP HEADER ─── */}
        <div className="p-5 sm:p-7 pb-4 space-y-4 border-b border-slate-100 bg-white">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => go("chat")}
                className="text-slate-500 hover:text-slate-800 hover:bg-slate-100 px-3 py-1.5 rounded-xl transition-colors cursor-pointer flex items-center gap-1.5 text-xs font-semibold"
                title="Back to Chat (Alt+Left)"
              >
                <ArrowLeft size={15} />
                <span>Back</span>
              </button>
              <div>
                <div className="flex items-center gap-2.5 flex-wrap">
                  <h1 className="text-lg sm:text-xl font-bold text-slate-900 tracking-tight">Harness² self-supervision studio</h1>
                  <span className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-semibold rounded-full border bg-emerald-50 text-emerald-800 border-emerald-300 shadow-xs">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                    {badge}
                  </span>
                  {banner && (
                    <span className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-mono rounded-full border bg-slate-100 text-slate-700 border-slate-200 truncate max-w-md">
                      {banner}
                    </span>
                  )}
                </div>
                <p className="text-xs text-slate-500 mt-1 max-w-2xl leading-relaxed">
                  Supercharge scores the message on this machine before the model answers. A short question stays on the normal chat path. A complex task gets a local checklist in the same turn, so the reply follows a plan. The plan stays in a sandbox. OpenCode, Codex, and Claude are not started. The bot's base soul changes only when you promote a plan.
                </p>
                <ul className="text-xs text-slate-600 mt-2 max-w-2xl leading-relaxed list-disc pl-4 space-y-0.5">
                  <li>Same-turn plan: the model reads the checklist before it replies.</li>
                  <li>Simple chat stays on the normal path. Greetings and plain questions score 0 and do not arm.</li>
                  <li>Keep saves the lesson. Promote appends the plan to the base soul. Restore puts the previous soul back.</li>
                  <li>A failed terminal command records one note and does not start a second model. Probes are not executed.</li>
                </ul>
              </div>
            </div>

            {/* Quick Actions (Matte Black & Secondary) */}
            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                disabled={!desktop || busy}
                title={desktop ? "Clone and verify the upstream engine" : "Install runs in the desktop app"}
                onClick={() => void install()}
                className="px-4 py-2 text-xs font-semibold bg-zinc-800 hover:bg-zinc-700 text-white rounded-full transition-all cursor-pointer shadow-xs active:scale-95 disabled:opacity-40 border border-zinc-700/50"
              >
                Install / Verify engine
              </button>
              <button
                type="button"
                disabled={!desktop || busy || !status?.demoPresent}
                onClick={() => void check()}
                className="px-4 py-2 text-xs font-semibold bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-full transition-all cursor-pointer border border-slate-200/80 disabled:opacity-40"
              >
                Benchmark readiness
              </button>
              <button
                type="button"
                disabled={!desktop || busy || !status?.demoPresent}
                onClick={() => void runDemo()}
                className="px-4 py-2 text-xs font-semibold bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-full transition-all cursor-pointer border border-slate-200/80 disabled:opacity-40"
              >
                Run demo (--k 2)
              </button>
            </div>
          </div>
        </div>

        {/* ─── BODY (MULTI-SECTION CARDS) ─── */}
        <div className="flex-1 overflow-y-auto p-5 sm:p-7 space-y-6 bg-white">
          
          {/* Card 1: Engine Execution & Logs */}
          <div className="rounded-2xl border border-slate-200/90 bg-white p-5 sm:p-6 shadow-xs space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div>
                <h3 className="text-sm font-bold text-slate-900">Engine Environment &amp; Diagnostics</h3>
                <p className="text-xs text-slate-500 mt-0.5 font-mono">
                  {status?.repoDir || "Checkout location managed in local OS workspace."}
                </p>
              </div>
              <span className="text-xs font-mono text-slate-500 bg-slate-50 px-2.5 py-0.5 rounded-full border border-slate-200">
                uv sandbox
              </span>
            </div>

            {log && (
              <div className="space-y-1">
                <div className="text-xs font-semibold text-slate-500">Output Stream:</div>
                <pre className="p-4 bg-[#1e2025] text-slate-200 rounded-2xl font-mono text-xs max-h-64 overflow-auto whitespace-pre-wrap shadow-inner">
                  {log}
                </pre>
              </div>
            )}

            {demo && (
              <div className="p-4 bg-slate-50 border border-slate-200/90 rounded-2xl text-xs space-y-1.5">
                <div className="font-bold text-slate-900 flex items-center gap-1.5">
                  <CheckCircle2 size={14} className={demo.probesExecuted ? "text-emerald-600" : "text-amber-500"} />
                  <span>Exit evidence: {demo.probesExecuted ? "Process exited 0 (Success)" : "Process exited with non-zero exit code"}</span>
                </div>
                <p className="text-slate-600">{demo.probeNote}</p>
                {demo.outputFiles.length ? (
                  <p className="font-mono text-[11px] text-slate-500">Output files: {demo.outputFiles.join(", ")}</p>
                ) : (
                  <p className="text-slate-400">No output files listed.</p>
                )}
              </div>
            )}
          </div>

          {/* Card 2: Arming Triggers & Evaluator */}
          <div className="rounded-2xl border border-slate-200/90 bg-white p-5 sm:p-6 shadow-xs space-y-5">
            <div className="border-b border-slate-100 pb-3">
              <h3 className="text-sm font-bold text-slate-900">Trigger Conditions &amp; Live Evaluator</h3>
              <p className="text-xs text-slate-500 mt-0.5">
                The score updates as you type. Auto arms at the threshold. Force arms every message. Off leaves chat alone. The substrate name is a label. This screen does not start that process.
              </p>
            </div>

            {/* Controls Bar */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4 text-xs">
              <div className="space-y-1">
                <label className="font-semibold text-slate-700">Recursion</label>
                <select
                  aria-label="Recursion mode"
                  disabled={busy || !status}
                  value={flags?.recursion ?? "parallel"}
                  onChange={(event) => void patch({ recursion: event.target.value })}
                  className="w-full px-3 py-2 text-xs border border-slate-200 rounded-xl bg-slate-50 outline-none focus:ring-2 focus:ring-slate-200"
                >
                  <option value="parallel">Parallel</option>
                  <option value="sequential">Sequential</option>
                </select>
              </div>

              <div className="space-y-1">
                <label className="font-semibold text-slate-700">Budget (k)</label>
                <select
                  aria-label="Budget k"
                  disabled={busy || !status}
                  value={String(flags?.budgetK ?? 1)}
                  onChange={(event) => void patch({ budgetK: Number(event.target.value) })}
                  className="w-full px-3 py-2 text-xs border border-slate-200 rounded-xl bg-slate-50 outline-none focus:ring-2 focus:ring-slate-200"
                >
                  <option value="1">k=1</option>
                  <option value="2">k=2</option>
                </select>
              </div>

              <div className="space-y-1">
                <div className="flex justify-between font-semibold text-slate-700">
                  <span>Threshold</span>
                  <span className="font-mono">{flags?.threshold ?? 65}/100</span>
                </div>
                <input
                  aria-label="Complexity threshold"
                  type="range"
                  min={0}
                  max={100}
                  disabled={busy || !status}
                  value={flags?.threshold ?? 65}
                  onChange={(event) => void patch({ threshold: Number(event.target.value) })}
                  className="w-full mt-2"
                />
              </div>

              <div className="space-y-1">
                <label className="font-semibold text-slate-700">Substrate</label>
                <select
                  aria-label="Executor substrate"
                  disabled={busy || !status}
                  value={flags?.substrate ?? "opencode"}
                  onChange={(event) => void patch({ substrate: event.target.value })}
                  className="w-full px-3 py-2 text-xs border border-slate-200 rounded-xl bg-slate-50 outline-none focus:ring-2 focus:ring-slate-200"
                >
                  <option value="opencode">OpenCode (Local Plan)</option>
                  <option value="codex_cx">Codex (CLI)</option>
                  <option value="claude_acp">Claude ACP (Local)</option>
                </select>
              </div>
            </div>

            {/* Prompt Tester */}
            <div className="space-y-2 pt-2 border-t border-slate-100">
              <label className="block text-xs font-semibold text-slate-700">
                Live score, updates as you type
              </label>
              <textarea
                className="min-h-20 w-full rounded-2xl border border-slate-200 bg-slate-50 p-3 font-mono text-xs outline-none focus:bg-white focus:ring-2 focus:ring-slate-200 transition"
                value={sample}
                onChange={(event) => setSample(event.target.value)}
                placeholder="Type a task. The score updates on its own."
              />
              {score ? (
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl text-xs flex items-center gap-2">
                  <span className={`px-2.5 py-0.5 rounded-full font-mono font-bold text-xs ${score.armed ? "bg-emerald-50 text-emerald-800 border border-emerald-300" : "bg-slate-200 text-slate-700"}`}>
                    Score {score.value}/100
                  </span>
                  <span className="text-slate-700">
                    {score.armed
                      ? "The next message gets a checklist before the model replies. The plan stays in a sandbox, and the base soul stays as it is until you promote it."
                      : "The next message stays on the normal chat path. Short questions and greetings do not arm."}{" "}
                    {score.reasons.join(" ")}
                  </span>
                </div>
              ) : null}
            </div>
          </div>

          {/* Card 3: Scoped Components */}
          <div className="rounded-2xl border border-slate-200/90 bg-white p-5 sm:p-6 shadow-xs space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div>
                <h3 className="text-sm font-bold text-slate-900">Scoped Evolutionary Components</h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Layers named on the plan. Nothing here is rewritten until you promote a plan.
                </p>
              </div>
              <span className="text-xs font-mono text-slate-500 bg-slate-50 px-2.5 py-0.5 rounded-full border border-slate-200">
                8 Subsystems
              </span>
            </div>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {COMPONENTS.map(([id, label]) => {
                const active = flags?.components?.includes(id) ?? true;
                return (
                  <label
                    key={id}
                    className={`flex items-center gap-3 rounded-2xl border p-3 text-xs cursor-pointer transition select-none ${
                      active
                        ? "bg-slate-50/80 border-slate-300 text-slate-900 shadow-xs"
                        : "bg-white border-slate-200 text-slate-500 hover:bg-slate-50"
                    }`}
                  >
                    <input
                      type="checkbox"
                      disabled={busy || !status}
                      checked={active}
                      onChange={() => toggleComponent(id)}
                      className="rounded"
                    />
                    <span className="font-semibold">{label}</span>
                  </label>
                );
              })}
            </div>
          </div>

          {/* Card 4: Experience Library */}
          <div className="rounded-2xl border border-slate-200/90 bg-white p-5 sm:p-6 shadow-xs space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3">
              <div>
                <h3 className="text-sm font-bold text-slate-900">Experience Library ({status?.libraryCount ?? 0})</h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Lessons you chose to keep. A plan is not saved here until you press Keep.
                </p>
              </div>
              <div className="relative min-w-[220px]">
                <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" size={13} />
                <input
                  type="text"
                  aria-label="Search library"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search lessons…"
                  className="w-full bg-slate-50 border border-slate-200 rounded-full pl-9 pr-3.5 py-1.5 text-xs text-slate-800 placeholder-slate-400 outline-none focus:bg-white focus:ring-2 focus:ring-slate-200 transition"
                />
              </div>
            </div>

            {visible.length === 0 ? (
              <div className="py-12 text-center text-slate-400 text-xs">
                No library entries found. Keep a plan to append EXPERIENCE.md and persistent memory notes.
              </div>
            ) : (
              <div className="space-y-3">
                {visible.map((entry) => (
                  <div key={entry.id} className="rounded-2xl border border-slate-200/80 bg-slate-50/60 p-4 text-xs space-y-1.5 hover:bg-slate-50 transition">
                    <div className="flex items-center justify-between">
                      <strong className="text-slate-900 font-bold">{entry.title}</strong>
                      <span className="text-[11px] font-mono text-slate-500 bg-white px-2 py-0.5 rounded-full border border-slate-200">
                        {entry.componentType} · {entry.domainTag}
                      </span>
                    </div>
                    <p className="text-slate-700">{entry.whenToApplyRule}</p>
                    <p className="text-slate-500">{entry.behavioralEvidence}</p>
                    <p className="font-mono text-[11px] text-slate-400 truncate">{entry.artifactPathOrContent}</p>
                  </div>
                ))}
              </div>
            )}
          </div>

        </div>

      </div>
    </div>
  );
}
