import { useEffect, useState, type ComponentType } from "react";
import { Activity, ArrowLeft, Bot, Database, Globe, LayoutGrid, Monitor, Sparkles, Terminal, UserRound, Wallet, X } from "lucide-react";
import { pickPaths } from "../api";
import type { Policy, Settings } from "../types";
import { useOmni } from "../store";
import { AccountPanel } from "../ui/AccountPanel";
import { money, Pill } from "../ui/bits";

type SectionId = "general" | "account" | "binaries" | "bots" | "memory" | "skills" | "computer" | "network" | "repair" | "wallet";

const SECTIONS: { id: SectionId; label: string; detail: string; group: string; icon: ComponentType<{ size?: number }> }[] = [
  { id: "general", label: "General", detail: "Theme, density, project", group: "Workspace", icon: LayoutGrid },
  { id: "account", label: "Account and vault", detail: "This machine only", group: "Workspace", icon: UserRound },
  { id: "memory", label: "Memory", detail: "Journal and vault", group: "Workspace", icon: Database },
  { id: "binaries", label: "Local binaries", detail: "CLI paths", group: "Agents and tools", icon: Terminal },
  { id: "bots", label: "External bots", detail: "Fleet runners", group: "Agents and tools", icon: Bot },
  { id: "skills", label: "Skills and plugins", detail: "Where those live", group: "Agents and tools", icon: Sparkles },
  { id: "computer", label: "Computer and browser", detail: "Per profile", group: "Agents and tools", icon: Monitor },
  { id: "network", label: "Network", detail: "Proxy and reports", group: "System", icon: Globe },
  { id: "repair", label: "Self-repair", detail: "Doctor and failover", group: "System", icon: Activity },
  { id: "wallet", label: "Wallet and updates", detail: "Spend rules", group: "System", icon: Wallet },
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

function amount(raw: string, fallback: number) {
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

export function SettingsScreen() {
  const snap = useOmni((s) => s.snap)!;
  const run = useOmni((s) => s.run);
  const recover = useOmni((s) => s.recover);
  const recovering = useOmni((s) => s.recovering);
  const go = useOmni((s) => s.go);
  const busy = useOmni((s) => s.busy);
  const [section, setSection] = useState<SectionId>("general");
  const [filter, setFilter] = useState("");
  const [draft, setDraft] = useState(snap.settings);
  const [policy, setPolicy] = useState(snap.policy);
  const [confirm, setConfirm] = useState("");
  const [copied, setCopied] = useState(false);
  const [profileId, setProfileId] = useState(snap.activeProfileId || snap.profiles[0]?.id || "");
  const [runners, setRunners] = useState(snap.settings.ghostRunners.join(", "));
  const settingsStamp = JSON.stringify(snap.settings);
  const policyStamp = JSON.stringify(snap.policy);
  useEffect(() => {
    setDraft(snap.settings);
    setRunners(snap.settings.ghostRunners.join(", "));
  }, [settingsStamp]);
  useEffect(() => setPolicy(snap.policy), [policyStamp]);
  useEffect(() => {
    document.documentElement.dataset.theme = draft.theme;
    document.documentElement.dataset.density = draft.density;
    return () => {
      const saved = useOmni.getState().snap?.settings;
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
    <div className="screen">
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
            <h1 className="title">Settings</h1>
            <p className="saved-line">
              {dirty ? <span className="pill warn">Unsaved</span> : <span className="pill ok"><i className="dot" />Saved</span>}
              <span className="mono">{snap.homeDir}</span>
            </p>
          </div>
        </div>
        {dirty ? <button className="btn" disabled={busy} onClick={() => void save()}>Save changes</button> : null}
      </div>
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
                  <button key={item.id} type="button" className={`set-nav ${section === item.id ? "on" : ""}`} aria-current={section === item.id ? "page" : undefined} onClick={() => setSection(item.id)}>
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
                  <input className="input" value={draft.projectRoot} onChange={(event) => set("projectRoot", event.target.value)} placeholder="Folder scanned for .omniworkspace/plugins" />
                </label>
                <p className="faint">Project plugins in that folder stay off until you trust them on Capabilities.</p>
              </>
            ) : null}

            {section === "account" ? (
              <>
                <h2 className="h2">Account and vault</h2>
                <p className="muted">Chats, provider keys, and memory stay on this machine. A Ronic account is separate and is used for the paid store.</p>
                <AccountPanel />
                <div className="grid-3">
                  <article className="card"><div className="muted">Plan</div><div className="kpi">{draft.plan || "Local"}</div></article>
                  <article className="card"><div className="muted">Installed</div><div className="kpi">{draft.version}</div></article>
                  <article className="card"><div className="muted">Vault</div><div>{snap.hasPassphrase ? (snap.vaultUnlocked ? "Unlocked" : "Locked") : "No passphrase"}</div></article>
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
                    <p className="faint">Profile wallet cap {money(profile.dailyWalletLimitUsd)}. The workspace spend gate is under Wallet and updates.</p>
                  </div>
                ) : <p className="muted">Create a profile before setting these permissions.</p>}
                <div className="row-actions">
                  <button className="btn ghost" onClick={() => go("profiles")}>Open profiles</button>
                  <button className="btn ghost" onClick={() => go("computer")}>Open computer use</button>
                </div>
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

            {section === "wallet" ? (
              <>
                <h2 className="h2">Wallet gate and updates</h2>
                <p className="muted">These amounts are the rules the wallet gate runs. Live rails refuse a charge in this build. Nothing here downloads or restarts a new binary.</p>
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
                <div className="grid-2">
                  <label className="field"><span>Update channel</span>
                    <select className="select" value={draft.updateChannel} onChange={(event) => set("updateChannel", event.target.value as Settings["updateChannel"])}>
                      <option value="stable">Stable</option>
                      <option value="nightly">Nightly</option>
                    </select>
                  </label>
                  <article className="card"><div className="muted">Listed version</div><div>{draft.availableVersion === draft.version ? "Same as installed" : draft.availableVersion}</div><div className="faint">Channel is stored. This build does not install it.</div></article>
                </div>
                <button className="btn ghost" onClick={() => go("wallet")}>Open wallet</button>
              </>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}
