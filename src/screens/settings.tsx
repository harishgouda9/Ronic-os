import { useEffect, useState, type ComponentType } from "react";
import { Activity, ArrowLeft, Bot, Database, Globe, LayoutGrid, Monitor, RefreshCw, Sparkles, Terminal, UserRound, Wallet, X } from "lucide-react";
import { UpdateSettings } from "./UpdateSettings";
import { normalizeUpdateSettings, rememberUpdatePrefs } from "../updates/feed";
import { pickPaths } from "../api";
import type { Policy, Settings } from "../types";
import { useRonic } from "../store";
import { money, Pill } from "../ui/bits";
import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "../lib/tauriBridge";
import { cloudConfig } from "../services/cloud";
import { ApprovalModeSelector } from "../ui/ApprovalModeSelector";

type SectionId = "general" | "account" | "binaries" | "bots" | "memory" | "skills" | "computer" | "approvals" | "network" | "storage" | "repair" | "wallet" | "update";

const SECTIONS: { id: SectionId; label: string; detail: string; group: string; icon: ComponentType<{ size?: number }> }[] = [
  { id: "general", label: "General", detail: "Theme, density, project", group: "Workspace", icon: LayoutGrid },
  { id: "account", label: "Data and vault", detail: "Local workspace data", group: "Workspace", icon: UserRound },
  { id: "memory", label: "Memory", detail: "Journal and vault", group: "Workspace", icon: Database },
  { id: "binaries", label: "Local binaries", detail: "CLI paths", group: "Agents and tools", icon: Terminal },
  { id: "bots", label: "External bots", detail: "Fleet runners", group: "Agents and tools", icon: Bot },
  { id: "skills", label: "Skills and plugins", detail: "Where those live", group: "Agents and tools", icon: Sparkles },
  { id: "computer", label: "Computer and browser", detail: "Per profile", group: "Agents and tools", icon: Monitor },
  { id: "approvals", label: "Approvals", detail: "Auto-approve, ask, or manual", group: "Agents and tools", icon: Bot },
  { id: "network", label: "Network", detail: "Proxy and reports", group: "System", icon: Globe },
  { id: "storage", label: "Storage and backups", detail: "state.db, WAL, shadow-git", group: "System", icon: Database },
  { id: "repair", label: "Self-repair", detail: "Doctor and failover", group: "System", icon: Activity },
  { id: "wallet", label: "Wallet", detail: "Spend rules", group: "System", icon: Wallet },
  { id: "update", label: "Update", detail: "Releases and notices", group: "System", icon: RefreshCw },
];

function Switch({ on, warn = false }: { on: boolean; warn?: boolean }) {
  return <span className={on ? `switch on${warn ? " warn" : ""}` : "switch"} aria-hidden="true" />;
}

const BINARIES = [
  ["claudePath", "Claude Code"],
  ["codexPath", "Codex"],
  ["geminiPath", "Gemini"],
  ["aiderPath", "Aider"],
  ["opencodePath", "OpenCode"],
  ["uvPath", "uv"],
  ["bunPath", "bun"],
] as const;

function mb(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type KernelDiag = {
  db: { dbBytes: number; walBytes: number; journalMode: string; freelistBytes: number; memories: number; threads: number; steps: number; profiles: number; heartbeatMs: number };
  shadowFiles: number;
  shadowBytes: number;
  backupCount: number;
  homeDir: string;
};

function amount(raw: string, fallback: number) {
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

export function SettingsScreen() {
  const snap = useRonic((s) => s.snap)!;
  const run = useRonic((s) => s.run);
  const recover = useRonic((s) => s.recover);
  const recovering = useRonic((s) => s.recovering);
  const go = useRonic((s) => s.go);
  const busy = useRonic((s) => s.busy);
  const [section, setSection] = useState<SectionId>(() => (sessionStorage.getItem("ronic.settings.section") === "update" ? "update" : "general"));
  const [filter, setFilter] = useState("");
  const [draft, setDraft] = useState(() => normalizeUpdateSettings(snap.settings));
  const [policy, setPolicy] = useState(snap.policy);
  const [confirm, setConfirm] = useState("");
  const [copied, setCopied] = useState(false);
  const [profileId, setProfileId] = useState(snap.activeProfileId || snap.profiles[0]?.id || "");
  const desktop = isTauriRuntime();
  const [diag, setDiag] = useState<KernelDiag | null>(null);
  const [maintBusy, setMaintBusy] = useState(false);
  const [maintNote, setMaintNote] = useState("");
  const [tunnelNote, setTunnelNote] = useState("");

  function loadDiag() {
    if (!desktop) return;
    setMaintBusy(true);
    void invoke<KernelDiag>("kernel_diagnostics").then((next) => {
      setDiag(next);
      setMaintBusy(false);
    }).catch((error) => {
      setMaintNote(error instanceof Error ? error.message : String(error));
      setMaintBusy(false);
    });
    void invoke<{ running: boolean; publicUrl: string; note: string }>("mesh_tunnel_status").then((tunnel) => {
      if (tunnel) setTunnelNote(tunnel.running ? `A public relay is active (${tunnel.publicUrl || "tunnel up"}). Consumer web sessions do not route through it.` : "No public relay is active — all traffic stays on this machine's own connection.");
    }).catch(() => setTunnelNote(""));
  }

  useEffect(() => {
    if (section === "storage" || section === "network") loadDiag();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section, desktop]);

  async function maintenance(kind: "vacuum" | "prune" | "backup") {
    if (!desktop) return;
    setMaintBusy(true);
    setMaintNote(kind === "vacuum" ? "Running WAL checkpoint and VACUUM…" : kind === "prune" ? "Pruning old shadow-git snapshots…" : "Copying the workspace to Documents…");
    try {
      if (kind === "vacuum") {
        const res = await invoke<{ dbBytes: number; walBytes: number; freedBytes: number }>("db_maintenance");
        setMaintNote(`Checkpoint and VACUUM finished. Database ${mb(res.dbBytes)}, WAL ${mb(res.walBytes)}, freed about ${mb(res.freedBytes)}.`);
      } else if (kind === "prune") {
        const res = await invoke<{ removed: number; freedBytes: number; keptDays: number }>("shadow_git_prune", { days: 14 });
        setMaintNote(res.removed > 0 ? `Removed ${res.removed} snapshot file${res.removed === 1 ? "" : "s"} older than ${res.keptDays} days (about ${mb(res.freedBytes)}).` : `Nothing older than ${res.keptDays} days to prune.`);
      } else {
        const res = await invoke<{ path: string; bytes: number }>("workspace_backup");
        setMaintNote(`Backup written to ${res.path} (${mb(res.bytes)}).`);
      }
      const next = await invoke<KernelDiag>("kernel_diagnostics");
      setDiag(next);
    } catch (error) {
      setMaintNote(error instanceof Error ? error.message : String(error));
    } finally {
      setMaintBusy(false);
    }
  }
  const savedSettings = normalizeUpdateSettings(snap.settings);
  const [runners, setRunners] = useState(savedSettings.ghostRunners.join(", "));
  const settingsStamp = JSON.stringify(savedSettings);
  const policyStamp = JSON.stringify(snap.policy);
  useEffect(() => {
    const openUpdate = () => {
      sessionStorage.removeItem("ronic.settings.section");
      setSection("update");
    };
    window.addEventListener("ronic-open-update", openUpdate);
    if (sessionStorage.getItem("ronic.settings.section") === "update") openUpdate();
    return () => window.removeEventListener("ronic-open-update", openUpdate);
  }, []);
  useEffect(() => {
    const next = normalizeUpdateSettings(useRonic.getState().snap?.settings ?? snap.settings);
    setDraft(next);
    setRunners(next.ghostRunners.join(", "));
  }, [settingsStamp]);
  useEffect(() => setPolicy(snap.policy), [policyStamp]);
  useEffect(() => {
    document.documentElement.dataset.theme = draft.theme;
    document.documentElement.dataset.density = draft.density;
    return () => {
      const saved = useRonic.getState().snap?.settings;
      if (!saved) return;
      document.documentElement.dataset.theme = saved.theme;
      document.documentElement.dataset.density = saved.density;
    };
  }, [draft.theme, draft.density]);

  const settingsDirty = JSON.stringify(draft) !== settingsStamp;
  const policyDirty = JSON.stringify(policy) !== policyStamp;
  const query = filter.trim().toLowerCase();
  const visible = SECTIONS.filter((item) => !query || `${item.label} ${item.detail}`.toLowerCase().includes(query));
  const groups = [...new Set(visible.map((item) => item.group))];
  const dirty = settingsDirty || policyDirty;
  const profile = snap.profiles.find((item) => item.id === profileId) ?? snap.profiles[0];
  const engine = snap.memoryEngines.find((item) => item.id === snap.memoryRoute.engineId);
  const bots = snap.scan?.found.filter((hit) => hit.category === "bot") ?? [];
  const linked = BINARIES.filter(([, label]) => snap.scan?.found.some((hit) => hit.name === label)).length;

  function set<K extends keyof Settings>(key: K, value: Settings[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function setGate<K extends keyof Policy>(key: K, value: Policy[K]) {
    setPolicy((current) => ({ ...current, [key]: value }));
  }

  async function save() {
    if (settingsDirty) {
      rememberUpdatePrefs(draft);
      const saved = await run("save_settings", { settings: draft });
      if (!saved) return;
    }
    if (policyDirty) {
      await run("set_policy", {
        maxPerTxUsd: policy.maxPerTxUsd,
        dailyCapUsd: policy.dailyCapUsd,
        requireHumanApprovalAboveUsd: policy.requireHumanApprovalAboveUsd,
        maxSlippageBps: Math.round(policy.maxSlippageBps),
        killswitchEngaged: policy.killswitchEngaged,
      });
    }
  }

  async function browse(key: (typeof BINARIES)[number][0]) {
    const paths = await pickPaths("program");
    if (paths[0]) set(key, paths[0]);
  }

  return (
    <div className="flex-1 h-full bg-[#eceef2] p-3 sm:p-5 lg:p-6 overflow-y-auto select-none flex flex-col">
      <div className="w-full max-w-[1560px] flex-1 min-h-[660px] bg-white rounded-3xl shadow-[0_12px_40px_-8px_rgba(0,0,0,0.06),0_2px_8px_-1px_rgba(0,0,0,0.03)] border border-slate-200/70 flex flex-col mx-auto overflow-hidden transition-all duration-300">
        <div className="p-5 sm:p-7 pb-4 border-b border-slate-100 bg-white">
          <div className="between">
            <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
              <div className="row-actions" style={{ gap: "4px" }}>
                <button
                  type="button"
                  className="btn ghost small"
                  onClick={() => go("chat")}
                  title="Back to Chat (Alt+Left)"
                  style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}
                >
                  <ArrowLeft size={13} />
                  <span>Back</span>
                </button>
                <button
                  type="button"
                  className="btn ghost small"
                  onClick={() => go("chat")}
                  title="Close Settings (Esc)"
                  aria-label="Close"
                  style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", padding: "6px" }}
                >
                  <X size={14} />
                </button>
              </div>
              <div>
                <h1 className="title text-slate-900">Settings</h1>
                <p className="saved-line">
                  {dirty ? <span className="pill warn">Unsaved</span> : <span className="pill ok"><i className="dot" />Saved</span>}
                  <span className="mono">{snap.homeDir}</span>
                </p>
              </div>
            </div>
            {dirty ? <button className="btn" disabled={busy} onClick={() => void save()}>Save changes</button> : null}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-5 sm:p-7">
          <div className="settings-layout">
        <aside className="settings-nav">
          <label className="field">
            <span className="sr">Filter sections</span>
            <input className="input" placeholder="Filter sections" value={filter} onChange={(event) => setFilter(event.target.value)} aria-label="Filter sections" />
          </label>
          {visible.length === 0 ? <p className="muted">No section matches.</p> : null}
          {groups.map((group) => (
            <div key={group}>
              <div className="set-group">{group}</div>
              {visible.filter((item) => item.group === group).map((item) => {
                const Icon = item.icon;
                return (
                  <button key={item.id} type="button" className={`set-nav ${section === item.id ? "on" : ""}`} aria-label={item.label} aria-current={section === item.id ? "page" : undefined} onClick={() => setSection(item.id)}>
                    <span className="set-ico"><Icon size={16} /></span>
                    <span><span className="set-name">{item.label}</span><span className="set-detail">{item.detail}</span></span>
                  </button>
                );
              })}
            </div>
          ))}
        </aside>
        <section className="pane">
          <div className="pane-b stack">
            {section === "general" ? (
              <>
                <h2 className="h2">General and appearance</h2>
                <p className="muted">Theme and density apply to this window.</p>
                <div className="grid-2">
                  <label className="field"><span>Theme</span>
                    <select className="select" value={draft.theme} onChange={(event) => set("theme", event.target.value as Settings["theme"])}>
                      <option value="light">Minimalist light</option>
                      <option value="contrast">High contrast</option>
                      <option value="dark">Slate dark</option>
                    </select>
                  </label>
                  <label className="field"><span>Density</span>
                    <select className="select" value={draft.density} onChange={(event) => set("density", event.target.value as Settings["density"])}>
                      <option value="minimal">Minimal</option>
                      <option value="standard">Standard</option>
                      <option value="dense">Dense</option>
                    </select>
                  </label>
                </div>
                <button type="button" className="toggle" aria-pressed={draft.showRailLabels} onClick={() => set("showRailLabels", !draft.showRailLabels)}>
                  <span>Show names on the left rail</span>
                  <Switch on={draft.showRailLabels} />
                </button>
                <label className="field"><span>Project root</span>
                  <input className="input" value={draft.projectRoot} onChange={(event) => set("projectRoot", event.target.value)} placeholder="Folder scanned for .ronicos/plugins" />
                </label>
                <p className="faint">Project plugins in that folder stay off until you trust them on Capabilities.</p>
              </>
            ) : null}

            {section === "account" ? (
              <>
                <h2 className="h2">Data and vault</h2>
                <p className="muted">Chats, memory, and the vault live on this machine. Account, plan, API keys, and 1-click MCP live on Plan & setup.</p>
                <article className="card stack">
                  <div className="between">
                    <div>
                      <div className="muted">License</div>
                      <strong>{snap.license?.status === "active" ? "Cloud lease verified" : snap.license?.status === "local" ? "Registered locally (Starter)" : snap.license?.status === "unsigned_dev" ? "Development build — nothing enforced" : "Not registered (Starter)"}</strong>
                    </div>
                    <Pill kind={snap.license?.proEntitled ? "ok" : ""}>{snap.license?.proEntitled ? "Pro features open" : "Starter"}</Pill>
                  </div>
                  <button type="button" className="btn ghost small" onClick={() => go("billing")}>Open Plan & setup — plans, keys, 1-click MCP</button>
                </article>
                <div className="grid-3">
                  <article className="card"><div className="muted">Installed</div><div className="kpi">{draft.version}</div></article>
                  <article className="card"><div className="muted">Vault</div><div>{snap.hasPassphrase ? (snap.vaultUnlocked ? "Unlocked" : "Locked") : "No passphrase"}</div></article>
                  <article className="card"><div className="muted">Workspace</div><div className="mono" style={{ fontSize: 11 }}>{snap.homeDir}</div></article>
                </div>
                <div className="row-actions">
                  <button className="btn ghost" onClick={() => go("vault")}>{snap.hasPassphrase ? "Open vault" : "Set a passphrase"}</button>
                  <button className="btn ghost" disabled={!snap.hasPassphrase || busy} onClick={() => void run("lock_vault")}>Lock now</button>
                </div>
                <p className="muted">Reset deletes bots, chats, memories, workflows, skills, plugins, and the sandbox ledger on this machine. The vault passphrase is kept.</p>
                <label className="field"><span>Type RESET</span><input className="input" value={confirm} onChange={(event) => setConfirm(event.target.value)} /></label>
                <button className="btn danger" disabled={busy || confirm !== "RESET"} onClick={() => void run("reset_workspace", { confirm })}>Reset workspace</button>
              </>
            ) : null}

            {section === "binaries" ? (
              <>
                <div className="between">
                  <div>
                    <h2 className="h2">Local binaries</h2>
                    <p className="muted">{snap.scan ? `Last scan took ${snap.scan.durationMs} ms. ${snap.scan.found.length} found, ${snap.scan.missing.length} missing.` : "No scan yet."} A filled path that still exists is left alone.</p>
                  </div>
                  <button className="btn" disabled={busy} onClick={() => void run("scan_environment")}>Scan this computer</button>
                </div>
                <div className="stack">
                  {BINARIES.map(([key, label]) => (
                    <label key={key} className="field">
                      <span>{label}{String(draft[key]).startsWith("wsl:") ? " · found through WSL" : ""}</span>
                      <span className="row-actions" style={{ width: "100%" }}>
                        <input className="input" style={{ flex: 1, minWidth: 0 }} value={draft[key]} onChange={(event) => set(key, event.target.value)} />
                        <button type="button" className="btn ghost" disabled={busy} title="The file picker runs in the desktop shell." onClick={() => void browse(key)}>Browse</button>
                      </span>
                    </label>
                  ))}
                </div>
                {snap.scan && snap.scan.missing.length > 0 ? <p className="faint">Not found: {snap.scan.missing.join(", ")}.</p> : null}
                <p className="faint">{linked} of these tools were named in the last scan. Ollama, Cursor, and VS Code are recorded on Providers and the IDE screen, not as path overrides here.</p>
              </>
            ) : null}

            {section === "bots" ? (
              <>
                <h2 className="h2">External bots</h2>
                <p className="muted">The fleet starts a process only when the scan already found its folder. Tokens for Telegram or Discord are not stored here.</p>
                <label className="field"><span>Ghost runner names</span>
                  <input className="input" value={runners} onChange={(event) => { setRunners(event.target.value); set("ghostRunners", event.target.value.split(",").map((item) => item.trim()).filter(Boolean)); }} placeholder="Names shown on the fleet" />
                </label>
                {bots.length === 0 ? <p className="muted">No bot folders in the last scan. Scan from Local binaries, then open the fleet.</p> : (
                  <div className="stack">
                    {bots.map((hit) => (
                      <div key={hit.path} className="between">
                        <span>{hit.name}</span>
                        <span className="mono">{hit.path}</span>
                      </div>
                    ))}
                  </div>
                )}
                <button className="btn ghost" onClick={() => go("fleet")}>Open fleet</button>
              </>
            ) : null}

            {section === "memory" ? (
              <>
                <h2 className="h2">Memory</h2>
                <p className="muted">Mem0 is the built-in vault. Open Memory to read, add, and edit notes. Other engines appear after a desktop scan.</p>
                <article className="card">
                  <div className="muted">Active engine</div>
                  <strong>{engine?.label ?? snap.memoryRoute.engineId}</strong>
                  <div className="faint">{engine?.detail || engine?.availability || "Not scanned"}</div>
                </article>
                <div className="stack">
                  {snap.memoryEngines.map((item) => (
                    <div key={item.id} className="between">
                      <span>{item.label}</span>
                      <Pill kind={item.availability === "builtin" || item.availability === "ready" || item.availability === "detected" ? "ok" : ""}>{item.availability}</Pill>
                    </div>
                  ))}
                </div>
                <label className="field"><span>Obsidian vault folder</span>
                  <input className="input" value={draft.obsidianVault} onChange={(event) => set("obsidianVault", event.target.value)} placeholder="Folder the desktop scan can see" />
                </label>
                <div className="row-actions">
                  <button className="btn ghost" disabled={busy} onClick={() => void run("scan_memory_engines")}>Scan memory engines</button>
                  <button className="btn ghost" disabled={recovering} onClick={() => void recover()}>{recovering ? "Refreshing…" : "Refresh"}</button>
                  <button className="btn ghost" onClick={() => go("memory")}>Open Memory</button>
                </div>
              </>
            ) : null}

            {section === "skills" ? (
              <>
                <h2 className="h2">Skills and plugins</h2>
                <p className="muted">Skills are instructions. Plugins and MCP servers declare tools. Executable packages stay on Capabilities.</p>
                <div className="grid-3">
                  <article className="card"><div className="muted">Skills</div><div className="kpi">{snap.skills.length}</div><div className="faint">{snap.skills.length === 0 ? "Nothing added yet" : "In this workspace"}</div></article>
                  <article className="card"><div className="muted">Plugins</div><div className="kpi">{snap.plugins.length}</div><div className="faint">{snap.plugins.length === 0 ? "Nothing installed yet" : "In this workspace"}</div></article>
                  <article className="card"><div className="muted">MCP servers</div><div className="kpi">{snap.mcpServers.length}</div><div className="faint">{snap.mcpServers.length === 0 ? "No servers connected" : "In this workspace"}</div></article>
                </div>
                <h2 className="h2">How loading works</h2>
                <div className="guide">
                  <article><b>1</b><div><strong>Standing prompt</strong><div className="muted">Carries the one-line index.</div></div></article>
                  <article><b>2</b><div><strong>Slash command</strong><div className="muted">Loads that playbook for the turn.</div></div></article>
                  <article><b>3</b><div><strong>Agent writes</strong><div className="muted">An approval card appears before a file is created.</div></div></article>
                  <article><b>4</b><div><strong>Project plugins</strong><div className="muted">Trust comes first. Trust does not turn the switches on.</div></div></article>
                </div>
                <div className="row-actions">
                  <button className="btn" onClick={() => go("skills")}>Open Skills</button>
                  <button className="btn ghost" onClick={() => go("capabilities")}>Open Capabilities</button>
                </div>
              </>
            ) : null}

            {section === "computer" ? (
              <>
                <h2 className="h2">Computer and browser</h2>
                <p className="muted">Chat from every bot can read files, run the sandbox, and open a page. Each bot still keeps its own model. These switches do not take that shared desk away.</p>
                <label className="field"><span>Profile</span>
                  <select className="select" value={profile?.id ?? ""} onChange={(event) => setProfileId(event.target.value)}>
                    {snap.profiles.length === 0 ? <option value="">No profile yet</option> : null}
                    {snap.profiles.map((item) => <option key={item.id} value={item.id}>{item.handle}</option>)}
                  </select>
                </label>
                {profile ? (
                  <div className="stack">
                    <button type="button" className="toggle" disabled={busy} aria-pressed={profile.allowComputerUse} onClick={() => void run("save_profile", { profile: { ...profile, allowComputerUse: !profile.allowComputerUse } })}>
                      <span>Computer use</span>
                      <Switch on={profile.allowComputerUse} />
                    </button>
                    <button type="button" className="toggle" disabled={busy} aria-pressed={profile.allowBrowserUse} onClick={() => void run("save_profile", { profile: { ...profile, allowBrowserUse: !profile.allowBrowserUse } })}>
                      <span>Browser use</span>
                      <Switch on={profile.allowBrowserUse} />
                    </button>
                    <button type="button" className="toggle" disabled={busy} aria-pressed={profile.allowCodeExec} onClick={() => void run("save_profile", { profile: { ...profile, allowCodeExec: !profile.allowCodeExec } })}>
                      <span>Code execution</span>
                      <Switch on={profile.allowCodeExec} />
                    </button>
                    <p className="faint">Profile wallet cap {money(profile.dailyWalletLimitUsd)}. The workspace spend gate is under Wallet.</p>
                  </div>
                ) : <p className="muted">Create a profile before setting these permissions.</p>}
                <div className="row-actions">
                  <button className="btn ghost" onClick={() => go("profiles")}>Open profiles</button>
                  <button className="btn ghost" onClick={() => go("computer")}>Open computer use</button>
                </div>
              </>
            ) : null}

            {section === "approvals" ? (
              <>
                <h2 className="h2">Approval mode</h2>
                <p className="muted">Choose how much autonomy each bot has. Auto approve lets the bot research, plan, and execute on its own — it only pauses for critical decisions or credentials. Ask mode holds external actions and wallet spend for your approval. Manual mode holds every action.</p>
                <label className="field"><span>Profile</span>
                  <select className="select" value={profile?.id ?? ""} onChange={(event) => setProfileId(event.target.value)}>
                    {snap.profiles.length === 0 ? <option value="">No profile yet</option> : null}
                    {snap.profiles.map((item) => <option key={item.id} value={item.id}>{item.handle}</option>)}
                  </select>
                </label>
                {profile ? (
                  <ApprovalModeSelector profile={profile} />
                ) : <p className="muted">Create a profile before setting an approval mode.</p>}
              </>
            ) : null}

            {section === "network" ? (
              <>
                <h2 className="h2">Network</h2>
                <p className="muted">The desktop shell binds the local OpenAI-compatible endpoint. This screen does not move the port, reset site cookies, or change a browser user agent.</p>
                <article className="card between">
                  <span className="mono">{snap.proxyUrl}</span>
                  <button className="btn ghost small" onClick={() => void navigator.clipboard.writeText(snap.proxyUrl).then(() => setCopied(true)).catch(() => setCopied(false))}>{copied ? "Copied" : "Copy"}</button>
                </article>
                <label className="field"><span>Bug report endpoint</span>
                  <input className="input" value={draft.triageUrl} onChange={(event) => set("triageUrl", event.target.value)} placeholder="https://… optional" />
                </label>
                <p className="faint">{draft.triageUrl.trim() && !draft.triageUrl.startsWith("https://") ? "Only an https address is used. Anything else stays local." : "Reports are scrubbed, then saved under the workspace tickets folder. An https address also receives a copy."}</p>
                <h2 className="h2">Privacy and telemetry</h2>
                <div className="stack">
                  <div className="between">
                    <span>Sentry crash reports</span>
                    <Pill kind={cloudConfig.sentry ? "" : "ok"}>{cloudConfig.sentry ? "key configured" : "off — no key on this build"}</Pill>
                  </div>
                  <div className="between">
                    <span>PostHog product telemetry</span>
                    <Pill kind={cloudConfig.posthog ? "" : "ok"}>{cloudConfig.posthog ? "key configured" : "off — no key on this build"}</Pill>
                  </div>
                  <div className="between">
                    <span>Prompt and secret scrubbing before any report leaves</span>
                    <Pill kind="ok">always on</Pill>
                  </div>
                  <div className="between">
                    <span>Public relay (residential guard)</span>
                    <Pill kind={tunnelNote.startsWith("A public relay") ? "warn" : "ok"}>{tunnelNote ? (tunnelNote.startsWith("A public relay") ? "relay active" : "no relay") : desktop ? "checking…" : "desktop only"}</Pill>
                  </div>
                </div>
                <p className="faint">{tunnelNote || "Consumer web sessions (chatgpt.com, claude.ai, grok.com) always run from this machine's own connection. A relay, when you start one, exposes only the local MCP bus."}</p>
              </>
            ) : null}

            {section === "storage" ? (
              <>
                <h2 className="h2">Storage and backups</h2>
                <p className="muted">Live numbers from the real workspace on disk. Nothing here leaves the machine.</p>
                {!desktop ? <p className="muted">Storage maintenance runs in the desktop app.</p> : null}
                <div className="grid-3">
                  <article className="card">
                    <div className="muted">SQLite database</div>
                    <div className="kpi">{diag ? mb(diag.db.dbBytes) : "—"}</div>
                    <div className="faint mono">journal_mode={diag?.db.journalMode || "wal"} · WAL {diag ? mb(diag.db.walBytes) : "—"}</div>
                  </article>
                  <article className="card">
                    <div className="muted">Shadow-git snapshots</div>
                    <div className="kpi">{diag ? diag.shadowFiles : "—"}</div>
                    <div className="faint">{diag ? `${mb(diag.shadowBytes)} of rollback points` : "File count and size"}</div>
                  </article>
                  <article className="card">
                    <div className="muted">Workspace rows</div>
                    <div className="kpi">{diag ? diag.db.memories : "—"}</div>
                    <div className="faint">{diag ? `memories · ${diag.db.threads} threads · ${diag.db.steps} steps` : "Memories, threads, steps"}</div>
                  </article>
                </div>
                <div className="row-actions">
                  <button type="button" className="btn" disabled={!desktop || maintBusy} onClick={() => void maintenance("vacuum")}>{maintBusy ? "Working…" : "Run WAL checkpoint & VACUUM"}</button>
                  <button type="button" className="btn ghost" disabled={!desktop || maintBusy} onClick={() => void maintenance("prune")}>Prune shadow-git older than 14 days</button>
                  <button type="button" className="btn ghost" disabled={!desktop || maintBusy} onClick={() => void maintenance("backup")}>Export workspace backup</button>
                </div>
                <p className="faint">The backup copies state.db plus bots, skills, profiles, mcp, workflows, extensions, and tickets into Documents/Ronic OS backups. {diag && diag.backupCount > 0 ? `${diag.backupCount} backup file${diag.backupCount === 1 ? "" : "s"} on disk so far.` : "No backups taken from this screen yet."}</p>
                {maintNote ? <p className="muted">{maintNote}</p> : null}
              </>
            ) : null}

            {section === "repair" ? (
              <>
                <h2 className="h2">Self-repair</h2>
                <p className="muted">The desktop heartbeat runs for the life of the shell. Last age {snap.kernel === "browser" ? "is not measured in the preview" : `${snap.heartbeatAgeMs} ms`}.</p>
                <button type="button" className="toggle" aria-pressed={draft.autoFailover} onClick={() => set("autoFailover", !draft.autoFailover)}>
                  <span>Fail over to the profile fallback provider</span>
                  <Switch on={draft.autoFailover} />
                </button>
                <p className="muted">Run doctor checkpoints SQLite, repairs broken JSON under extensions, and can patch one known scraper error. A copy of that file is kept in the workspace .shadow-git folder. The doctor runs when you press the button.</p>
                <div className="row-actions">
                  <button className="btn ghost" disabled={recovering} onClick={() => void recover()}>{recovering ? "Refreshing…" : "Refresh"}</button>
                  <button className="btn" disabled={busy} onClick={() => void run("run_repair")}>Run doctor</button>
                  <button className="btn ghost" onClick={() => go("repair")}>Open repair log</button>
                </div>
              </>
            ) : null}

            {section === "update" ? <UpdateSettings draft={draft} set={set} homeDir={snap.homeDir} /> : null}

            {section === "wallet" ? (
              <>
                <h2 className="h2">Wallet gate</h2>
                <p className="muted">These amounts are the rules the wallet gate runs. Live rails refuse a charge in this build.</p>
                <div className="grid-2">
                  <label className="field"><span>Max per transaction (USD)</span>
                    <input className="input" type="number" min={0} step="0.01" value={policy.maxPerTxUsd} onChange={(event) => setGate("maxPerTxUsd", amount(event.target.value, policy.maxPerTxUsd))} />
                  </label>
                  <label className="field"><span>Daily cap (USD)</span>
                    <input className="input" type="number" min={0} step="0.01" value={policy.dailyCapUsd} onChange={(event) => setGate("dailyCapUsd", amount(event.target.value, policy.dailyCapUsd))} />
                  </label>
                  <label className="field"><span>Ask before spending above (USD)</span>
                    <input className="input" type="number" min={0} step="0.01" value={policy.requireHumanApprovalAboveUsd} onChange={(event) => setGate("requireHumanApprovalAboveUsd", amount(event.target.value, policy.requireHumanApprovalAboveUsd))} />
                  </label>
                  <label className="field"><span>Max slippage (basis points)</span>
                    <input className="input" type="number" min={0} step="1" value={policy.maxSlippageBps} onChange={(event) => setGate("maxSlippageBps", Math.round(amount(event.target.value, policy.maxSlippageBps)))} />
                  </label>
                </div>
                <p className="faint">{policy.maxSlippageBps} bps is {(policy.maxSlippageBps / 100).toFixed(2)}%. Plan and act also shows a stored burst figure of {money(draft.autoActUnderUsd)}. The gate uses the four fields above.</p>
                <label className="field"><span>Burst figure shown on Plan and act (USD)</span>
                  <input className="input" type="number" min={0} step="0.01" value={draft.autoActUnderUsd} onChange={(event) => set("autoActUnderUsd", amount(event.target.value, draft.autoActUnderUsd))} />
                </label>
                <button type="button" className="toggle" aria-pressed={policy.killswitchEngaged} onClick={() => setGate("killswitchEngaged", !policy.killswitchEngaged)}>
                  <span>Kill switch for agent spends and trades</span>
                  <Switch on={policy.killswitchEngaged} warn />
                </button>
                <button type="button" className="toggle" aria-pressed={draft.liveRails} onClick={() => set("liveRails", !draft.liveRails)}>
                  <span>{draft.liveRails ? "Live rails — a charge is still refused" : "Live rails — sandbox ledger"}</span>
                  <Switch on={draft.liveRails} warn={draft.liveRails} />
                </button>
                <p className="faint">Releases, auto update, and manual update are under Update.</p>
                <div className="row-actions">
                  <button type="button" className="btn ghost" onClick={() => setSection("update")}>Open Update</button>
                  <button className="btn ghost" onClick={() => go("wallet")}>Open wallet</button>
                </div>
              </>
            ) : null}
          </div>
        </section>
          </div>
        </div>
      </div>
    </div>
  );
}
