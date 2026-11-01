import { useMemo, useState, type ReactNode } from "react";
import {
  Activity,
  AlertTriangle,
  ArchiveRestore,
  BellOff,
  BellRing,
  CheckCircle2,
  Clock3,
  Crosshair,
  Database,
  Eye,
  GitBranch,
  History,
  LockKeyhole,
  Network,
  RefreshCw,
  Rocket,
  ScanSearch,
  ShieldCheck,
  Sparkles,
  Wrench,
} from "lucide-react";
import { useRonic } from "../store";
import { when } from "../ui/bits";

const SENTINEL_ICONS: Record<string, typeof ShieldCheck> = {
  sentry_sentinel: ShieldCheck,
  supabase_sentinel: Database,
  vercel_sentinel: Rocket,
  github_sentinel: GitBranch,
  middleware_sentinel: Network,
};

function statusLabel(status: string) {
  if (status === "incident_detected") return "Incident";
  if (status === "healthy") return "Healthy";
  if (status === "watching") return "Watching";
  return status.replaceAll("_", " ");
}

function isManualOnly(id: string) {
  return id === "vercel_sentinel" || id === "middleware_sentinel";
}

function fmtBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/* ── Marketplace design-system atoms ─────────────────────────────── */

function Chip({ children, tone = "slate" }: { children: ReactNode; tone?: "slate" | "emerald" | "amber" | "rose" | "blue" | "purple" }) {
  const tones: Record<string, string> = {
    slate: "bg-slate-100 text-slate-700 border-slate-200",
    emerald: "bg-emerald-50 text-emerald-700 border-emerald-200/80",
    amber: "bg-amber-50 text-amber-700 border-amber-200/80",
    rose: "bg-rose-50 text-rose-700 border-rose-200/80",
    blue: "bg-blue-50 text-blue-700 border-blue-200/80",
    purple: "bg-purple-50 text-purple-700 border-purple-200/80",
  };
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full border shrink-0 ${tones[tone]}`}>
      {children}
    </span>
  );
}

function tierChip(status: string): "emerald" | "amber" | "rose" | "slate" {
  if (status === "ok") return "emerald";
  if (status === "degraded") return "amber";
  if (status === "off") return "rose";
  return "slate";
}

function severityChip(severity: string): "slate" | "amber" | "rose" {
  if (severity === "error") return "rose";
  if (severity === "warn") return "amber";
  return "slate";
}

export default function RonicSelfRepairAndSentinels() {
  const snap = useRonic((s) => s.snap)!;
  const run = useRonic((s) => s.run);
  const busy = useRonic((s) => s.busy);
  const recovering = useRonic((s) => s.recovering);
  const recover = useRonic((s) => s.recover);
  const setBug = useRonic((s) => s.setBug);
  const [filter, setFilter] = useState<"all" | "incident" | "watching" | "healthy">("all");
  const [showBackups, setShowBackups] = useState(false);

  const incidents = snap.sentinels.filter((s) => s.status === "incident_detected" && !s.acknowledged).length;
  const watching = snap.sentinels.filter((s) => s.status === "watching").length;
  const scanned = snap.sentinels.filter((s) => s.lastScan > 0).length;
  const heartbeatHealthy = snap.heartbeatAgeMs < 4000;
  const repairsDone = snap.remediation.filter((r) => r.status === "repaired").length;
  const lastSweep = snap.sentinels.reduce((max, s) => Math.max(max, s.lastScan), 0);

  const filteredSentinels = useMemo(() => {
    if (filter === "all") return snap.sentinels;
    if (filter === "incident") return snap.sentinels.filter((s) => s.status === "incident_detected");
    if (filter === "watching") return snap.sentinels.filter((s) => s.status === "watching");
    return snap.sentinels.filter((s) => s.status === "healthy");
  }, [snap.sentinels, filter]);

  const stream = useMemo(() => {
    const events = [
      ...snap.sentinelEvents.map((e) => ({ at: e.createdAt, line: e.message })),
      ...snap.remediation.map((r) => ({
        at: r.createdAt,
        line: `T${r.tier} · ${r.faultType} on ${r.targetComponent} — ${r.actionTaken} (${r.recoveryDurationMs}ms, ${r.status})`,
      })),
    ];
    return events.sort((a, b) => b.at - a.at).slice(0, 40);
  }, [snap.sentinelEvents, snap.remediation]);

  return (
    <div className="flex-1 h-full bg-[#eceef2] p-3 sm:p-5 lg:p-6 overflow-y-auto select-none flex flex-col">
      <div className="w-full max-w-[1560px] flex-1 min-h-[660px] bg-white rounded-3xl shadow-[0_12px_40px_-8px_rgba(0,0,0,0.06),0_2px_8px_-1px_rgba(0,0,0,0.03)] border border-slate-200/70 flex flex-col mx-auto overflow-hidden transition-all duration-300">

        {/* ─── HEADER ─── */}
        <div className="p-5 sm:p-7 pb-3.5 space-y-4 border-b border-slate-100">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="min-w-0">
              <div className="flex items-center gap-2.5 flex-wrap">
                <h1 className="text-lg sm:text-xl font-bold text-slate-900 tracking-tight">Self-Repair &amp; Autonomous Sentinel Center</h1>
                <Chip tone={heartbeatHealthy ? "emerald" : "amber"}>
                  <Activity size={10} />
                  {heartbeatHealthy ? "WATCHDOG ONLINE" : "WATCHDOG STALE"}
                </Chip>
              </div>
              <p className="text-xs text-slate-500 mt-1.5 max-w-2xl leading-relaxed">
                Remediation core — local health checks run automatically while Ronic is open. Repairs stay explicit, scoped, and verified after every action.
              </p>
              <div className="flex items-center gap-2 mt-2 text-[11px] font-mono text-slate-400 flex-wrap" aria-live="polite">
                <span className="flex items-center gap-1.5">
                  <span className={`w-1.5 h-1.5 rounded-full ${heartbeatHealthy ? "bg-emerald-500" : "bg-amber-500"}`} />
                  IPC heartbeat {snap.heartbeatAgeMs}ms
                </span>
                <span>•</span>
                <span>{snap.sentinels.length} sentinels armed</span>
                <span>•</span>
                <span>{lastSweep ? `last sweep ${when(lastSweep)}` : "first sweep starting"}</span>
              </div>
            </div>
            <div className="shrink-0 flex items-center gap-2 flex-wrap">
              <button
                type="button"
                disabled={recovering}
                onClick={() => void recover()}
                className="text-xs font-semibold px-3.5 py-2 rounded-full border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 hover:text-slate-900 transition-all cursor-pointer active:scale-95 disabled:opacity-40 flex items-center gap-1.5"
              >
                <RefreshCw size={12} className={recovering ? "animate-spin" : ""} />
                {recovering ? "Refreshing…" : "Refresh workspace"}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setBug(true)}
                className="text-xs font-semibold px-3.5 py-2 rounded-full border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 hover:text-slate-900 transition-all cursor-pointer active:scale-95 disabled:opacity-40"
              >
                Report a bug
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void run("self_heal_drill", { tier: 0 })}
                className="text-xs font-semibold px-3.5 py-2 rounded-full bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700/50 shadow-xs transition-all cursor-pointer active:scale-95 disabled:opacity-40 flex items-center gap-1.5"
              >
                <Sparkles size={12} /> Run 4-tier drill
              </button>
            </div>
          </div>
        </div>

        {/* ─── BODY ─── */}
        <div className="flex-1 overflow-y-auto px-5 sm:px-7 py-5 space-y-7">

          {/* Summary metrics */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <article className="bg-white border border-slate-200/80 rounded-2xl p-4 shadow-xs flex items-center gap-3">
              <span className={`w-10 h-10 rounded-xl border flex items-center justify-center shrink-0 ${
                incidents ? "bg-amber-50 text-amber-600 border-amber-100" : "bg-emerald-50 text-emerald-600 border-emerald-100"
              }`}>
                {incidents ? <AlertTriangle size={16} /> : <ShieldCheck size={16} />}
              </span>
              <div className="min-w-0">
                <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Fleet status</p>
                <p className="text-sm font-bold text-slate-900 truncate">{incidents ? `${incidents} need${incidents === 1 ? "s" : ""} attention` : "All clear"}</p>
              </div>
            </article>
            <article className="bg-white border border-slate-200/80 rounded-2xl p-4 shadow-xs flex items-center gap-3">
              <span className="w-10 h-10 rounded-xl border flex items-center justify-center shrink-0 bg-blue-50 text-blue-600 border-blue-100">
                <ScanSearch size={16} />
              </span>
              <div className="min-w-0">
                <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Checks completed</p>
                <p className="text-sm font-bold text-slate-900 truncate">{scanned} / {snap.sentinels.length}{watching ? ` · ${watching} watching` : ""}</p>
              </div>
            </article>
            <article className="bg-white border border-slate-200/80 rounded-2xl p-4 shadow-xs flex items-center gap-3">
              <span className="w-10 h-10 rounded-xl border flex items-center justify-center shrink-0 bg-purple-50 text-purple-600 border-purple-100">
                <Clock3 size={16} />
              </span>
              <div className="min-w-0">
                <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Monitor cadence</p>
                <p className="text-sm font-bold text-slate-900 truncate">Every 30 seconds</p>
              </div>
            </article>
            <article className="bg-white border border-slate-200/80 rounded-2xl p-4 shadow-xs flex items-center gap-3">
              <span className="w-10 h-10 rounded-xl border flex items-center justify-center shrink-0 bg-emerald-50 text-emerald-600 border-emerald-100">
                <Crosshair size={16} />
              </span>
              <div className="min-w-0">
                <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Verified repairs</p>
                <p className="text-sm font-bold text-slate-900 truncate">{repairsDone} on record</p>
              </div>
            </article>
          </div>

          {/* Repair tiers */}
          <div className="space-y-2">
            <div className="flex items-center justify-between px-2">
              <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400">Repair tiers</h2>
              <span className="text-[11px] font-mono text-slate-400">{snap.tierStatus.length} tiers</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
              {snap.tierStatus.map((tier) => (
                <article key={tier.tier} className="bg-white border border-slate-200/80 rounded-2xl p-4 shadow-xs hover:shadow-md hover:border-slate-300 transition-all flex flex-col gap-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] font-mono text-slate-400">TIER {tier.tier}</span>
                    <Chip tone={tierChip(tier.status)}>{tier.badge}</Chip>
                  </div>
                  <div className="flex items-center gap-2.5">
                    <span className="w-8 h-8 rounded-xl bg-slate-900 text-white flex items-center justify-center text-sm font-bold shrink-0 shadow-xs">
                      {tier.tier}
                    </span>
                    <h3 className="text-sm font-bold text-slate-900 leading-tight">{tier.title}</h3>
                  </div>
                  <p className="text-[11px] text-slate-500 leading-relaxed flex-1">{tier.detail}</p>
                  <div className="flex items-center gap-1.5 text-[10px] font-mono text-slate-400">
                    <span>repairs</span>
                    <strong className="text-slate-700">{tier.repairCount}</strong>
                    <span>·</span>
                    <span>last run</span>
                    <strong className="text-slate-700">{tier.lastRunAt ? when(tier.lastRunAt) : "—"}</strong>
                  </div>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void run("self_heal_drill", { tier: tier.tier })}
                    className="self-start text-xs font-semibold px-3.5 py-1.5 rounded-full border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 transition-all cursor-pointer active:scale-95 disabled:opacity-40 flex items-center gap-1.5"
                  >
                    <Wrench size={11} /> Trigger drill
                  </button>
                </article>
              ))}
            </div>
          </div>

          {/* Sentinel fleet */}
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3 px-2 flex-wrap">
              <div>
                <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400">Autonomous sentinel fleet · live monitoring</h2>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  Five local monitors inspect error surfaces, stuck runs, release drift, Git state, and MCP channel errors. Every remediation is audited and re-scanned.
                </p>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <div className="flex items-center gap-1 bg-slate-100 rounded-full p-1" role="tablist" aria-label="Sentinel filter">
                  {(["all", "incident", "watching", "healthy"] as const).map((value) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setFilter(value)}
                      className={`px-3 py-1 text-[11px] font-semibold rounded-full transition-all cursor-pointer ${
                        filter === value ? "bg-zinc-800 text-white shadow-xs" : "text-slate-600 hover:text-slate-900"
                      }`}
                    >
                      {value === "all" ? "All" : value === "incident" ? "Incidents" : value === "watching" ? "Watching" : "Healthy"}
                    </button>
                  ))}
                </div>
                <Chip tone={incidents ? "amber" : "emerald"}>{incidents ? `${incidents} open incident${incidents === 1 ? "" : "s"}` : "No open incidents"}</Chip>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void run("sentinel_scan_all")}
                  className="text-xs font-semibold px-3.5 py-1.5 rounded-full bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700/50 shadow-xs transition-all cursor-pointer active:scale-95 disabled:opacity-40 flex items-center gap-1.5"
                >
                  <ScanSearch size={11} /> Scan all now
                </button>
              </div>
            </div>

            <div className="bg-slate-50/50 rounded-3xl p-1.5 border border-slate-100/80 divide-y divide-slate-100/60" aria-live="polite">
              {snap.sentinels.length === 0 ? (
                <div className="py-14 text-center space-y-2">
                  <p className="text-sm font-semibold text-slate-700">Sentinel fleet is initializing…</p>
                </div>
              ) : null}
              {filteredSentinels.length === 0 && snap.sentinels.length > 0 ? (
                <div className="py-14 text-center space-y-2">
                  <p className="text-sm font-semibold text-slate-700">No sentinels match this filter</p>
                </div>
              ) : null}
              {filteredSentinels.map((sentinel) => {
                const incident = sentinel.status === "incident_detected";
                const openIncident = incident && !sentinel.acknowledged;
                const watchingState = sentinel.status === "watching";
                const manual = isManualOnly(sentinel.id);
                const Icon = SENTINEL_ICONS[sentinel.id] ?? ScanSearch;
                return (
                  <div key={sentinel.id} className={`flex items-start justify-between gap-3 px-4 py-3 rounded-2xl transition-all duration-150 ${
                    openIncident ? "bg-amber-50/60 hover:bg-amber-50" : "hover:bg-slate-100/80"
                  }`}>
                    <div className="flex items-start gap-4 min-w-0 pr-3">
                      <span className={`w-10 h-10 rounded-xl shrink-0 shadow-xs flex items-center justify-center border ${
                        openIncident
                          ? "bg-amber-50 text-amber-600 border-amber-100"
                          : watchingState
                            ? "bg-slate-50 text-slate-500 border-slate-100"
                            : "bg-emerald-50 text-emerald-600 border-emerald-100"
                      }`}>
                        <Icon size={16} />
                      </span>
                      <div className="min-w-0 space-y-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${openIncident ? "bg-amber-500" : "bg-emerald-500"}`} />
                          <span className="text-sm font-semibold text-slate-800">{sentinel.name}</span>
                          <Chip tone={severityChip(sentinel.severity)}>{sentinel.severity}</Chip>
                          <Chip tone="slate">{sentinel.source}</Chip>
                          {sentinel.acknowledged ? <Chip tone="blue">acknowledged</Chip> : null}
                          <span className="text-[10px] text-slate-400 font-mono">{sentinel.lastScan ? `checked ${when(sentinel.lastScan)}` : "not checked yet"}</span>
                        </div>
                        <div className="flex items-start gap-1.5 text-[11px] text-slate-500">
                          <span className={`mt-0.5 shrink-0 ${openIncident ? "text-amber-500" : "text-emerald-500"}`}>
                            {openIncident ? <AlertTriangle size={12} /> : watchingState ? <Eye size={12} /> : <CheckCircle2 size={12} />}
                          </span>
                          <span>{sentinel.finding || "No scan recorded yet — run a scan to collect the first finding."}</span>
                        </div>
                        {incident && sentinel.stagedFix ? (
                          <div className="flex items-center gap-1.5 text-[10.5px] font-mono text-slate-600 bg-white/80 border border-slate-200/70 rounded-lg px-2 py-1 w-fit">
                            <Wrench size={11} className="text-slate-400" />
                            <span><strong>Proposed action:</strong> {sentinel.stagedFix}</span>
                          </div>
                        ) : null}
                      </div>
                    </div>
                    <div className="shrink-0 flex items-center gap-2 flex-wrap justify-end">
                      <Chip tone={openIncident ? "amber" : watchingState ? "slate" : "emerald"}>{statusLabel(sentinel.status)}</Chip>
                      {incident && !sentinel.acknowledged ? (
                        <button
                          type="button"
                          disabled={busy}
                          title="Acknowledge this incident so it stops flashing until the next scan re-verifies it"
                          onClick={() => void run("acknowledge_sentinel", { sentinelId: sentinel.id })}
                          className="text-xs font-semibold px-3 py-1.5 rounded-full border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 transition-all cursor-pointer active:scale-95 disabled:opacity-40 flex items-center gap-1"
                        >
                          <BellOff size={11} /> Acknowledge
                        </button>
                      ) : sentinel.acknowledged ? (
                        <button
                          type="button"
                          disabled={busy}
                          title="Clear the acknowledgement so this sentinel can flag again"
                          onClick={() => void run("reset_sentinel_ack", { sentinelId: sentinel.id })}
                          className="text-xs font-semibold px-3 py-1.5 rounded-full border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 transition-all cursor-pointer active:scale-95 disabled:opacity-40 flex items-center gap-1"
                        >
                          <BellRing size={11} /> Un-acknowledge
                        </button>
                      ) : null}
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void run("sentinel_scan", { sentinelId: sentinel.id })}
                        className="text-xs font-semibold px-3 py-1.5 rounded-full border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 transition-all cursor-pointer active:scale-95 disabled:opacity-40 flex items-center gap-1"
                      >
                        <ScanSearch size={11} /> Scan
                      </button>
                      <button
                        type="button"
                        disabled={busy || !incident || manual}
                        title={!incident ? "A fresh incident scan is required" : manual ? "This issue requires manual review" : "Apply the staged fix and verify it"}
                        onClick={() => void run("sentinel_remediate", { sentinelId: sentinel.id })}
                        className={`text-xs font-semibold px-3 py-1.5 rounded-full transition-all cursor-pointer active:scale-95 disabled:opacity-40 flex items-center gap-1 ${
                          incident && !manual
                            ? "bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700/50 shadow-xs"
                            : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                        }`}
                      >
                        {manual ? <LockKeyhole size={11} /> : <Wrench size={11} />}
                        {manual ? "Manual review" : "Remediate"}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Audit stream */}
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3 px-2 flex-wrap">
              <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                <Activity size={12} /> Audit stream
              </h2>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setShowBackups((v) => !v)}
                  className="text-xs font-semibold px-3.5 py-1.5 rounded-full border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 transition-all cursor-pointer active:scale-95 disabled:opacity-40 flex items-center gap-1.5"
                >
                  <History size={11} /> {showBackups ? "Hide backups" : `Rollback checkpoints (${snap.shadowBackups.length})`}
                </button>
                <span className="text-[11px] font-mono text-slate-400">local · newest first</span>
              </div>
            </div>
            <div className="bg-slate-50/50 rounded-3xl p-1.5 border border-slate-100/80 divide-y divide-slate-100/60">
              {showBackups ? (
                snap.shadowBackups.length === 0 ? (
                  <div className="py-10 text-center space-y-1.5">
                    <p className="text-sm font-semibold text-slate-700">No rollback checkpoints yet</p>
                    <p className="text-xs text-slate-400 max-w-sm mx-auto">Doctor and extension edits write shadow copies before they change a file.</p>
                  </div>
                ) : (
                  snap.shadowBackups.map((backup) => (
                    <div key={backup.name} className="flex items-center justify-between gap-3 px-4 py-2.5 rounded-2xl hover:bg-slate-100/80 transition-all duration-150">
                      <div className="flex items-center gap-3 min-w-0">
                        <ArchiveRestore size={14} className="text-slate-400 shrink-0" />
                        <span className="text-xs font-mono text-slate-700 truncate">{backup.name}</span>
                        <span className="text-[10px] text-slate-400 shrink-0">{fmtBytes(backup.bytes)}</span>
                        <span className="text-[10px] text-slate-400 shrink-0">{when(backup.mtime)}</span>
                      </div>
                      <button
                        type="button"
                        disabled={busy || backup.restorable === false}
                        title={backup.restorable === false ? "This checkpoint does not carry its original path, so it cannot be auto-restored" : "Restore this checkpoint over its original file"}
                        onClick={() => void run("restore_shadow_backup", { backupName: backup.name })}
                        className="text-xs font-semibold px-3 py-1.5 rounded-full border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 transition-all cursor-pointer active:scale-95 disabled:opacity-40 flex items-center gap-1 shrink-0"
                      >
                        <Wrench size={11} /> {backup.restorable === false ? "Not restorable" : "Restore"}
                      </button>
                    </div>
                  ))
                )
              ) : (
                <div className="px-4 py-3 font-mono text-[11px] text-slate-600 space-y-1" aria-live="polite">
                  {stream.length === 0 ? (
                    <div className="py-8 text-center font-sans space-y-1.5">
                      <p className="text-sm font-semibold text-slate-700">No remediation activity yet</p>
                      <p className="text-xs text-slate-400">Run a scan or drill to create the first audit event.</p>
                    </div>
                  ) : null}
                  {stream.map((row, index) => (
                    <div key={`${row.at}-${index}`} className="leading-relaxed">
                      <span className="text-slate-400 mr-2">{when(row.at)}</span>
                      {row.line}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ─── FOOTER STATUS BAR ─── */}
        <div className="px-6 py-3 bg-slate-50 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500">
          <div className="flex items-center gap-2 truncate pr-4">
            <span className={`w-2 h-2 rounded-full shrink-0 ${heartbeatHealthy ? "bg-emerald-500" : "bg-amber-500"}`} />
            <span className="truncate">
              {heartbeatHealthy ? "Watchdog online — local monitors sweep every 30 seconds" : "Watchdog heartbeat is stale — refresh the workspace to re-arm it"}
            </span>
          </div>
          <div className="shrink-0 flex items-center gap-3 text-[11px] font-medium text-slate-400">
            <span className="font-mono">{repairsDone} verified repairs</span>
            <span>·</span>
            <span className="font-mono">{incidents} open incidents</span>
          </div>
        </div>
      </div>
    </div>
  );
}
