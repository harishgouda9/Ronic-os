import { useEffect, useRef, useState } from "react";
import type { BotProfile, Provider, Step } from "../types";
import { useOmni } from "../store";
import { effortFor } from "../kernel/modelPrefs";
import type { ChatModel, ChatProviderLink } from "../kernel/liveChat";
import { ago, forgetSchedule, isUnread, lastLine, rememberSchedule, safePageUrl } from "../kernel/workspaceChrome";
import { hideBotScreens, isTauriRuntime, placeBotScreen, revealBotScreen, type WebAppBounds } from "../lib/tauriBridge";
import { ProviderAuth, ProviderState } from "./ProviderAuth";

const HARNESSES = [
  ["claude_cli", "Claude Code CLI"],
  ["agy_cli", "Gemini / Antigravity agy"],
  ["codex_cli", "Codex CLI"],
  ["aider_acp", "Aider"],
  ["opencode", "OpenCode"],
  ["grok_web", "Grok web session"],
  ["ag_ui_url", "AG-UI / OpenBot endpoint"],
] as const;

const MODES = [
  ["autonomous_handoff", "Autonomous handoff"],
  ["parallel_swarm", "Parallel swarm"],
  ["lead_delegated", "Lead delegates"],
] as const;

export function harnessLabel(bot: BotProfile) {
  return HARNESSES.find((item) => item[0] === bot.harnessLaneId)?.[1] || bot.engine || bot.harnessLaneId || "In-app model";
}

export function botName(bot?: { displayName?: string; handle?: string }) {
  const raw = bot?.displayName?.trim() || bot?.handle?.replace(/^@/, "") || "";
  return raw || "Bot";
}

export const BOT_MARKS = [
  { id: "orb", label: "Blob" },
  { id: "pebble", label: "Pebble" },
  { id: "bun", label: "Bunny" },
  { id: "kitty", label: "Kitty" },
  { id: "bear", label: "Bear" },
  { id: "chick", label: "Chick" },
  { id: "mochi", label: "Mochi" },
  { id: "cloud", label: "Cloud" },
  { id: "sprout", label: "Sprout" },
  { id: "pearl", label: "Pearl" },
] as const;

export function botMark(avatar?: string) {
  const id = avatar?.trim().startsWith("mark:") ? avatar.trim().slice(5) : "";
  if (!id) return "orb";
  // Older bots were saved with geometric shapes. They map onto the closest
  // cute face so no bot is ever left without a valid mark.
  const legacy: Record<string, string> = {
    round: "orb",
    cloud: "cloud",
    block: "mochi",
    hex: "kitty",
    hexagon: "kitty",
    shield: "bear",
    crest: "bear",
    star: "chick",
    spark: "chick",
    triangle: "bun",
    bolt: "bun",
    drop: "pebble",
    gem: "pearl",
    crystal: "pearl",
    ring: "pearl",
    wave: "cloud",
    capsule: "mochi",
  };
  return BOT_MARKS.some((item) => item.id === id) ? id : (legacy[id] ?? "orb");
}

export function markFromName(name: string) {
  let hash = 0;
  const text = name.trim() || "bot";
  for (const ch of text) hash = (hash * 33 + ch.charCodeAt(0)) >>> 0;
  return BOT_MARKS[hash % BOT_MARKS.length].id;
}

export function BotFace({ seed, mark, size = 36, state = "", color }: { seed: string; mark?: string; size?: number; state?: "" | "work" | "wait"; color?: string }) {
  let hash = 0;
  for (const ch of seed) hash = (hash * 33 + ch.charCodeAt(0)) >>> 0;
  const hue = hash % 360;
  const chosen = botMark(mark);
  const start = color ? shadeColor(color, 15) : `hsl(${hue} 85% 68%)`;
  const end = color ? shadeColor(color, -15) : `hsl(${hue} 68% 38%)`;
  const ring = color || `hsl(${hue} 70% 48%)`;
  return (
    <span className={`bot-face mark-${chosen} ${state}`} style={{ width: size, height: size, ["--face-h" as string]: String(hue), ["--face-color-start" as string]: start, ["--face-color-end" as string]: end, ["--face-ring" as string]: ring }} aria-hidden>
      <span className="face-body">
        <span className="shine" />
        <span className="eye left" />
        <span className="eye right" />
        <span className="cheek left" />
        <span className="cheek right" />
      </span>
    </span>
  );
}

const FACE_COLORS = [
  "#000000", "#8b5a2b", "#dc2626", "#ea580c", "#d97706", "#ca8a04", "#16a34a",
  "#0891b2", "#2563eb", "#7c3aed", "#db2777", "#6b7280",
];

function shadeColor(color: string, percent: number) {
  const num = parseInt(color.replace("#", ""), 16);
  const amt = Math.round(2.55 * percent);
  const R = Math.max(0, Math.min(255, (num >> 16) + amt));
  const G = Math.max(0, Math.min(255, ((num >> 8) & 0x00FF) + amt));
  const B = Math.max(0, Math.min(255, (num & 0x0000FF) + amt));
  return `#${(R << 16 | G << 8 | B).toString(16).padStart(6, "0")}`;
}

export function FacePicker({ name, mark, color, onChange, onColorChange }: { name: string; mark: string; color?: string; onChange: (mark: string) => void; onColorChange?: (color: string) => void }) {
  const locked = mark.startsWith("mark:");
  const shown = locked ? mark : `mark:${markFromName(name)}`;
  return (
    <div className="stack face-pick">
      <div className="face-stage">
        <BotFace seed={name || shown} mark={shown} size={76} color={color} />
      </div>
      <div className="mark-row">
        {BOT_MARKS.map((item) => {
          const on = shown === `mark:${item.id}`;
          return (
            <button key={item.id} type="button" className={`face-btn ${on ? "on" : ""}`} aria-label={item.label} aria-pressed={on} onClick={() => onChange(`mark:${item.id}`)}>
              <BotFace seed={name || item.id} mark={`mark:${item.id}`} size={40} color={color} />
              <span className="mark-label">{item.label}</span>
            </button>
          );
        })}
      </div>
      <div className="color-row">
        {FACE_COLORS.map((c) => {
          // No saved color means the face is on its name-hash hue. Nothing is
          // marked selected then, or the row would claim a color the face
          // is not showing.
          const active = Boolean(color) && color === c;
          return (
            <button key={c} type="button" className={`color-swatch ${active ? "active" : ""}`} style={{ backgroundColor: c }} aria-label={c} onClick={() => onColorChange?.(c)} />
          );
        })}
      </div>
      <button type="button" className="text-btn" onClick={() => onChange(`mark:${BOT_MARKS[Math.floor(Math.random() * BOT_MARKS.length)].id}`)}>Randomize</button>
      <p className="muted">{locked ? "Face is locked to this shape." : "Face follows the name until you pick a shape."}{color ? "" : " No color picked yet — the face uses its name color."}</p>
    </div>
  );
}

export function botPresence(bot: BotProfile): "" | "work" | "wait" {
  if (bot.takeover) return "wait";
  if (bot.runStatus === "running") return "work";
  return "";
}

export function CoworkerSidebar({ onInspect, onEditProfile }: { onInspect: (id: string) => void; onEditProfile: (id: string) => void }) {
  const snap = useOmni((s) => s.snap)!;
  const run = useOmni((s) => s.run);
  const go = useOmni((s) => s.go);
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState(false);
  const [botOpen, setBotOpen] = useState(false);
  const [groupOpen, setGroupOpen] = useState(false);
  const [lane, setLane] = useState<"sessions" | "bots" | "harness">("bots");
  const [seenTick, setSeenTick] = useState(0);
  const thread = snap.threads.find((item) => item.id === snap.activeThreadId);
  const activeGroup = thread?.targetType === "bot_group" ? snap.botGroups.find((item) => item.id === thread.groupId) : undefined;
  const needle = query.trim().toLowerCase();

  useEffect(() => {
    const onSeen = () => setSeenTick((value) => value + 1);
    window.addEventListener("omni-seen", onSeen);
    return () => window.removeEventListener("omni-seen", onSeen);
  }, []);

  const threadIdsFor = (match: (id: string) => boolean) => snap.threads.filter((item) => match(item.id) || match(item.botProfileId) || match(item.groupId)).map((item) => item.id);
  const previewFor = (ids: string[], fallback: string) => {
    const line = lastLine(snap.steps, ids);
    return { preview: line.text || fallback, when: line.at };
  };

  const rows = [
    ...snap.botGroups.map((group) => {
      const names = group.memberBotIds.map((id) => snap.profiles.find((bot) => bot.id === id)).filter((bot): bot is BotProfile => Boolean(bot));
      const ids = threadIdsFor((id) => id === group.id);
      const line = previewFor(ids, group.purpose || names.map((bot) => botName(bot)).join(", ") || "Shared chat");
      const when = Math.max(line.when, ...snap.threads.filter((item) => item.groupId === group.id).map((item) => item.updatedAt || 0));
      return {
        id: group.id,
        kind: "group" as const,
        title: group.title.replace(/^#/, "") || group.groupHandle.replace(/^#/, ""),
        preview: line.preview,
        when,
        unread: snap.threads.some((item) => item.groupId === group.id && isUnread(item.id, item.updatedAt, item.id === snap.activeThreadId)),
        on: activeGroup?.id === group.id,
        pinned: false,
        seed: group.id,
        members: names,
      };
    }),
    ...snap.profiles.map((bot) => {
      const ids = threadIdsFor((id) => id === bot.id);
      const line = previewFor(ids, bot.statusLine || bot.role || "Ready for tasks");
      const when = Math.max(line.when, ...snap.threads.filter((item) => item.botProfileId === bot.id).map((item) => item.updatedAt || 0));
      return {
        id: bot.id,
        kind: "bot" as const,
        title: botName(bot),
        preview: line.preview,
        when,
        unread: snap.threads.some((item) => item.botProfileId === bot.id && item.targetType !== "bot_group" && isUnread(item.id, item.updatedAt, item.id === snap.activeThreadId)),
        on: !activeGroup && bot.id === snap.activeProfileId,
        pinned: bot.isPinned,
        seed: bot.id,
        members: [bot],
      };
    }),
  ]
    .filter((row) => !needle || `${row.title} ${row.preview}`.toLowerCase().includes(needle))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.when - a.when);

  const sessions = snap.threads
    .map((item) => {
      const bot = snap.profiles.find((profile) => profile.id === item.botProfileId);
      const line = lastLine(snap.steps, [item.id]);
      return {
        id: item.id,
        title: item.title || botName(bot),
        preview: line.text || "No messages yet",
        when: Math.max(line.at, item.updatedAt || 0),
        unread: isUnread(item.id, item.updatedAt, item.id === snap.activeThreadId),
        on: item.id === snap.activeThreadId,
        bot,
      };
    })
    .filter((row) => !needle || `${row.title} ${row.preview}`.toLowerCase().includes(needle))
    .sort((a, b) => b.when - a.when);

  const programs = snap.apps.filter((app) => app.executablePath.trim().length > 0 || (app.status !== "missing" && app.status !== ""));
  const harnessBots = snap.profiles.filter((bot) => !needle || `${botName(bot)} ${harnessLabel(bot)}`.toLowerCase().includes(needle));

  const placeholder = lane === "sessions" ? "Search sessions" : lane === "harness" ? "Search harnesses" : "Search bots and group chats";

  return (
    <section className="pane roster" data-seen={seenTick}>
      <div className="roster-lanes" role="tablist" aria-label="Roster">
        <button type="button" role="tab" aria-selected={lane === "bots"} className={lane === "bots" ? "on" : ""} onClick={() => setLane("bots")}>Bots</button>
        <button type="button" role="tab" aria-selected={lane === "sessions"} className={lane === "sessions" ? "on" : ""} onClick={() => setLane("sessions")}>Sessions</button>
        <button type="button" role="tab" aria-selected={lane === "harness"} className={lane === "harness" ? "on" : ""} onClick={() => setLane("harness")}>Harness</button>
      </div>
      <div className="roster-bar">
        <input className="roster-search" value={query} placeholder={placeholder} onChange={(event) => setQuery(event.target.value)} />
        <button type="button" className="roster-plus" aria-label="New bot or group" aria-expanded={menu} onClick={() => setMenu((open) => !open)}>+</button>
      </div>
      {menu ? (
        <div className="roster-menu">
          <button type="button" onClick={() => { setMenu(false); setBotOpen(true); }}>New bot</button>
          <button type="button" onClick={() => { setMenu(false); setGroupOpen(true); }}>New group</button>
        </div>
      ) : null}
      <div className="roster-list">
        {lane === "bots" ? (
          <>
            {rows.length === 0 ? <p className="roster-empty">{needle ? "No match." : "No bots yet. Add one and tell it the job."}</p> : null}
            {rows.map((row) => (
              <div key={`${row.kind}-${row.id}`} className={`roster-row ${row.on ? "on" : ""}`}>
                {row.kind === "group" && row.members.length > 1 ? (
                  <span className="face-stack">
                    {row.members.slice(0, 2).map((bot) => (
                      <button key={bot.id} type="button" className="face-btn" aria-label={`Edit ${botName(bot)}`} onClick={() => onEditProfile(bot.id)}>
                        <BotFace seed={bot.id} mark={bot.avatar} size={26} state={botPresence(bot)} color={bot.avatarColor} />
                      </button>
                    ))}
                  </span>
                ) : (
                  <button type="button" className="face-btn" aria-label={`Edit ${row.title}`} onClick={() => onEditProfile(row.members[0]?.id || row.id)}>
                    <BotFace seed={row.seed} mark={row.members[0]?.avatar} state={row.members[0] ? botPresence(row.members[0]) : ""} color={row.members[0]?.avatarColor} />
                  </button>
                )}
                <button
                  type="button"
                  className="roster-hit"
                  onClick={() => {
                    if (row.kind === "group") {
                      const lead = snap.botGroups.find((group) => group.id === row.id);
                      const id = lead?.leadBotId || lead?.memberBotIds[0];
                      if (id) onInspect(id);
                      void run("open_group", { groupId: row.id });
                    } else {
                      onInspect(row.id);
                      void run("switch_profile", { profileId: row.id });
                    }
                  }}
                >
                  <span className="roster-copy">
                    <span className="roster-top">
                      <strong>{row.unread ? <i className="unread-dot" /> : null}{row.title}</strong>
                      {row.when ? <time>{ago(row.when)}</time> : null}
                    </span>
                    <span className="preview">{row.preview}</span>
                  </span>
                </button>
              </div>
            ))}
          </>
        ) : null}
        {lane === "sessions" ? (
          <>
            {sessions.length === 0 ? <p className="roster-empty">{needle ? "No match." : "No chats yet. Send a bot the work."}</p> : null}
            {sessions.map((row) => (
              <div key={row.id} className={`roster-row ${row.on ? "on" : ""}`}>
                <button type="button" className="face-btn" aria-label={`Edit ${botName(row.bot)}`} onClick={() => row.bot && onEditProfile(row.bot.id)}>
                  <BotFace seed={row.bot?.id || row.id} mark={row.bot?.avatar} state={row.bot ? botPresence(row.bot) : ""} color={row.bot?.avatarColor} />
                </button>
                <button type="button" className="roster-hit" onClick={() => { if (row.bot) onInspect(row.bot.id); void run("select_thread", { threadId: row.id }); }}>
                  <span className="roster-copy">
                    <span className="roster-top">
                      <strong>{row.unread ? <i className="unread-dot" /> : null}{row.title}</strong>
                      {row.when ? <time>{ago(row.when)}</time> : null}
                    </span>
                    <span className="preview">{row.preview}</span>
                  </span>
                </button>
              </div>
            ))}
          </>
        ) : null}
        {lane === "harness" ? (
          <>
            {programs.length === 0 && harnessBots.length === 0 ? <p className="roster-empty">{needle ? "No match." : "No harness is on this computer yet."}</p> : null}
            {programs.filter((app) => !needle || `${app.appName} ${app.detail}`.toLowerCase().includes(needle)).map((app) => (
              <button
                key={app.id}
                type="button"
                className="roster-row harness-row"
                onClick={() => {
                  if (!app.executablePath.trim()) {
                    go("providers");
                    return;
                  }
                  void run("launch_local_app", { executablePath: app.executablePath });
                }}
              >
                <span className="roster-copy">
                  <span className="roster-top"><strong>{app.appName}</strong><time>{app.status}</time></span>
                  <span className="preview">{app.detail || app.executablePath || "Not found yet"}</span>
                </span>
              </button>
            ))}
            {harnessBots.map((bot) => (
              <div key={bot.id} className={`roster-row ${bot.id === snap.activeProfileId ? "on" : ""}`}>
                <button type="button" className="face-btn" aria-label={`Edit ${botName(bot)}`} onClick={() => onEditProfile(bot.id)}>
                  <BotFace seed={bot.id} mark={bot.avatar} state={botPresence(bot)} color={bot.avatarColor} />
                </button>
                <button type="button" className="roster-hit" onClick={() => { onInspect(bot.id); void run("switch_profile", { profileId: bot.id }); setLane("bots"); }}>
                  <span className="roster-copy">
                    <span className="roster-top"><strong>{botName(bot)}</strong></span>
                    <span className="preview">{harnessLabel(bot)}</span>
                  </span>
                </button>
              </div>
            ))}
            <button type="button" className="btn ghost small" onClick={() => void run("scan_environment")}>Scan this computer</button>
          </>
        ) : null}
      </div>
      <div className="roster-foot">
        <button type="button" onClick={() => go("capabilities")}>Plugins</button>
        <button type="button" onClick={() => go("bots")}>Import</button>
        <button type="button" onClick={() => go("profiles")}>Profiles</button>
      </div>
      {botOpen ? <NewBot onClose={() => setBotOpen(false)} onInspect={onInspect} /> : null}
      {groupOpen ? <NewGroup onClose={() => setGroupOpen(false)} onInspect={onInspect} /> : null}
    </section>
  );
}

function NewBot({ onClose, onInspect }: { onClose: () => void; onInspect: (id: string) => void }) {
  const run = useOmni((s) => s.run);
  const busy = useOmni((s) => s.busy);
  const [name, setName] = useState("");
  const [mark, setMark] = useState("");
  const [color, setColor] = useState("");
  const [role, setRole] = useState("");
  const [harness, setHarness] = useState("claude_cli");
  const [endpoint, setEndpoint] = useState("");
  const [soul, setSoul] = useState("");
  const [skills, setSkills] = useState("");
  const [plugins, setPlugins] = useState("");
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);

  async function create() {
    setError("");
    setCreating(true);
    try {
      const avatar = mark || `mark:${markFromName(name)}`;
      const res = await run("create_profile", { draft: { handle: name.trim(), displayName: name.trim(), role: role.trim(), soulMarkdown: soul, harnessLaneId: harness, agUiEndpointUrl: endpoint, skills, plugins, avatar, avatarColor: color } });
      if (!res) {
        setError("The bot was not created. Check the message at the top of the app, then try again.");
        return;
      }
      onClose();
      const created = useOmni.getState().snap?.activeProfileId;
      if (created) onInspect(created);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <div className="pane-h">New coworker <button type="button" className="btn ghost small" onClick={onClose}>Close</button></div>
        <div className="pane-b stack">
          <p className="muted">You can also create a bot and then type “You are my …” or “Rename to …” in the thread.</p>
          <FacePicker name={name} mark={mark} color={color} onChange={setMark} onColorChange={setColor} />
          <label className="field"><span>Name</span><input className="input" value={name} placeholder="A name you'll recognize" onChange={(event) => setName(event.target.value)} /></label>
          <label className="field">
            <span>Role — what this bot does</span>
            <input className="input" value={role} placeholder="e.g. You find bugs in my React app and fix them" onChange={(event) => setRole(event.target.value)} />
          </label>
          <label className="field">
            <span>Harness</span>
            <select className="select" value={harness} onChange={(event) => setHarness(event.target.value)}>
              {HARNESSES.map((item) => <option key={item[0]} value={item[0]}>{item[1]}</option>)}
            </select>
          </label>
          {harness === "ag_ui_url" ? <label className="field"><span>AG-UI endpoint</span><input className="input" value={endpoint} placeholder="https:// or http://127.0.0.1" onChange={(event) => setEndpoint(event.target.value)} /></label> : null}
          <label className="field"><span>Skills already in the workspace</span><input className="input" value={skills} placeholder="/security-audit, /code-review" onChange={(event) => setSkills(event.target.value)} /></label>
          <label className="field"><span>Plugins already installed</span><input className="input" value={plugins} placeholder="plugin slug, comma separated" onChange={(event) => setPlugins(event.target.value)} /></label>
          <label className="field"><span>Job</span><textarea className="area" rows={3} value={soul} placeholder="What finished work looks like, and which actions need approval" onChange={(event) => setSoul(event.target.value)} /></label>
          {error ? <p className="muted" role="alert" style={{ color: "#dc2626" }}>{error}</p> : null}
          <button
            type="button"
            className="btn"
            disabled={creating || name.trim().length === 0}
            onClick={() => void create()}
          >
            {creating ? "Creating…" : "Create bot"}
          </button>
        </div>
      </div>
    </div>
  );
}

function NewGroup({ onClose, onInspect }: { onClose: () => void; onInspect: (id: string) => void }) {
  const snap = useOmni((s) => s.snap)!;
  const run = useOmni((s) => s.run);
  const busy = useOmni((s) => s.busy);
  const [title, setTitle] = useState("");
  const [purpose, setPurpose] = useState("");
  const [mode, setMode] = useState<(typeof MODES)[number][0]>("autonomous_handoff");
  const [members, setMembers] = useState<string[]>([]);

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <div className="pane-h">New group <button type="button" className="btn ghost small" onClick={onClose}>Close</button></div>
        <div className="pane-b stack">
          <label className="field"><span>Name</span><input className="input" value={title} placeholder="product-launch" onChange={(event) => setTitle(event.target.value)} /></label>
          <label className="field"><span>Purpose</span><input className="input" value={purpose} placeholder="What this squad finishes together" onChange={(event) => setPurpose(event.target.value)} /></label>
          <label className="field">
            <span>Coordination</span>
            <select className="select" value={mode} onChange={(event) => setMode(event.target.value as (typeof MODES)[number][0])}>
              {MODES.map((item) => <option key={item[0]} value={item[0]}>{item[1]}</option>)}
            </select>
          </label>
          <div className="stack">
            <span>Bots in this thread</span>
            {snap.profiles.map((bot) => (
              <label key={bot.id} className="between">
                <span className="mono">{bot.handle}</span>
                <input
                  type="checkbox"
                  checked={members.includes(bot.id)}
                  onChange={(event) => setMembers((prev) => event.target.checked ? [...prev, bot.id] : prev.filter((id) => id !== bot.id))}
                />
              </label>
            ))}
          </div>
          <button
            type="button"
            className="btn"
            disabled={busy || title.trim().length === 0 || members.length < 2}
            onClick={() => {
              onClose();
              void run("create_bot_group", { draft: { title, purpose, coordinationMode: mode, memberBotIds: members } }).then(() => {
                if (members[0]) onInspect(members[0]);
              });
            }}
          >
            Create group
          </button>
        </div>
      </div>
    </div>
  );
}

export function ProfileSlide({ bot, providers, links, onClose, onSignIn, onOpenKeys, onContinueChatGpt, onSaveKey }: { bot: BotProfile; providers: Provider[]; links: ChatProviderLink[]; onClose: () => void; onSignIn: (siteId: string) => void; onOpenKeys: (url: string) => void; onContinueChatGpt: () => void; onSaveKey: (id: string, secret: string) => void }) {
  const run = useOmni((s) => s.run);
  const busy = useOmni((s) => s.busy);
  const [draft, setDraft] = useState(bot);
  const [openGroup, setOpenGroup] = useState("");
  const [note, setNote] = useState("");
  const [confirmClose, setConfirmClose] = useState(false);
  useEffect(() => {
    setDraft(bot);
    setOpenGroup("");
    setNote("");
    setConfirmClose(false);
  }, [bot.id]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(bot);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  function requestClose() {
    if (dirtyRef.current) setConfirmClose(true);
    else onClose();
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // requestClose reads the latest dirty flag through dirtyRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose]);

  function edit(next: BotProfile) {
    setDraft(next);
    setNote("");
    setConfirmClose(false);
  }

  return (
    <aside className="profile-pane" aria-label={`Edit ${botName(draft)}`}>
      <div className="screen-h">
        <BotFace seed={draft.id} mark={draft.avatar} size={36} state={botPresence(draft)} color={draft.avatarColor} />
        <div className="screen-who">
          <strong>{botName(draft)}</strong>
          <span>{dirty ? "Profile · unsaved changes" : "Profile"}</span>
        </div>
        <button type="button" className="screen-x" onClick={requestClose} aria-label="Close profile">×</button>
      </div>
      <div className="profile-body">
        {confirmClose ? (
          <div className="notice stack" role="alert">
            <strong>Discard unsaved changes?</strong>
            <p className="muted">The edits in this panel have not been saved.</p>
            <div className="row-actions">
              <button type="button" className="btn small" onClick={onClose}>Discard</button>
              <button type="button" className="btn ghost small" onClick={() => setConfirmClose(false)}>Keep editing</button>
            </div>
          </div>
        ) : null}
        <FacePicker name={botName(draft)} mark={`mark:${botMark(draft.avatar)}`} color={draft.avatarColor} onChange={(avatar) => edit({ ...draft, avatar })} onColorChange={(color) => edit({ ...draft, avatarColor: color })} />
        <label className="field"><span>Display name</span><input className="input" value={draft.displayName} onChange={(event) => edit({ ...draft, displayName: event.target.value })} /></label>
        <label className="field"><span>Handle</span><input className="input" value={draft.handle} onChange={(event) => edit({ ...draft, handle: event.target.value })} /></label>
        <label className="field"><span>Role</span><input className="input" value={draft.role} onChange={(event) => edit({ ...draft, role: event.target.value })} /></label>
        <label className="field"><span>Status</span><input className="input" value={draft.statusLine} onChange={(event) => edit({ ...draft, statusLine: event.target.value })} /></label>
        <label className="field"><span>Job</span><textarea className="area" rows={4} value={draft.soulMarkdown} onChange={(event) => edit({ ...draft, soulMarkdown: event.target.value })} /></label>
        <label className="field"><span>Daily wallet limit USD</span><input className="input" type="number" value={draft.dailyWalletLimitUsd} onChange={(event) => edit({ ...draft, dailyWalletLimitUsd: Number(event.target.value) })} /></label>
        <label className="field"><span>Obsidian folder</span><input className="input" value={draft.scopedObsidianFolder} placeholder="Vault folder for this bot" onChange={(event) => edit({ ...draft, scopedObsidianFolder: event.target.value })} /></label>
        <div className="stack">
          <p className="muted">Every bot shares the desk: files, the sandbox, and the browser. This bot keeps its own model.</p>
          <Toggle label="Computer use" on={draft.allowComputerUse} onClick={() => edit({ ...draft, allowComputerUse: !draft.allowComputerUse })} />
          <Toggle label="Browser use" on={draft.allowBrowserUse} onClick={() => edit({ ...draft, allowBrowserUse: !draft.allowBrowserUse })} />
          <Toggle label="Code exec" on={draft.allowCodeExec} onClick={() => edit({ ...draft, allowCodeExec: !draft.allowCodeExec })} />
        </div>
        <AccountPick label="Primary" value={draft.primaryAccountId} providers={providers} onChange={(primaryAccountId) => edit({ ...draft, primaryAccountId })} />
        <AccountPick label="Long context" value={draft.longContextAccountId} providers={providers} onChange={(longContextAccountId) => edit({ ...draft, longContextAccountId })} />
        <AccountPick label="Fallback" value={draft.fallbackAccountId} providers={providers} onChange={(fallbackAccountId) => edit({ ...draft, fallbackAccountId })} />
        <button type="button" className="btn" disabled={busy || !dirty || draft.displayName.trim().length === 0 || draft.handle.trim().length === 0} onClick={() => { void run("save_profile", { profile: draft }).then((res) => setNote(res ? "Profile saved." : "Could not save. Check the message at the top of the app.")); }}>{dirty ? "Save profile" : "Saved"}</button>
        {note ? <p className="muted" role="status">{note}</p> : null}
        {dirty ? <p className="muted">You have unsaved changes.</p> : null}
        <div className="pane-h dock-sub">Model providers</div>
        <p className="muted">Continue with ChatGPT uses that plan in this chat. Other providers need an API key. A site window does not connect the bot.</p>
        {links.map((link) => (
          <section key={link.group}>
            <button type="button" className="model-group" onClick={() => setOpenGroup((current) => current === link.group ? "" : link.group)}>
              <span className="provider-name">{link.name}</span>
              <ProviderState link={link} />
              <span>{openGroup === link.group ? "▾" : "▸"}</span>
            </button>
            {openGroup === link.group ? <ProviderAuth link={link} onSignIn={onSignIn} onOpenKeys={onOpenKeys} onContinueChatGpt={onContinueChatGpt} onSaveKey={onSaveKey} /> : null}
          </section>
        ))}
      </div>
    </aside>
  );
}

function AccountPick({ label, value, providers, onChange }: { label: string; value: string; providers: Provider[]; onChange: (id: string) => void }) {
  return (
    <label className="field">
      <span>{label}</span>
      <select className="select" value={value} onChange={(event) => onChange(event.target.value)}>
        {providers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
    </label>
  );
}

function screenBounds(el: HTMLElement): WebAppBounds | null {
  const rect = el.getBoundingClientRect();
  let x = Math.max(0, rect.left);
  let y = Math.max(0, rect.top);
  let right = Math.min(rect.right, window.innerWidth);
  let bottom = Math.min(rect.bottom, window.innerHeight);
  if (!el.closest("[data-pane=thread]")) {
    const thread = document.querySelector("[data-pane=thread]");
    if (thread) {
      const edge = thread.getBoundingClientRect().right + 8;
      if (x < edge) x = edge;
    }
  }
  for (const selector of [".page-col", "[data-edge-rail]", "[data-jobs-panel]", ".chat-side", ".preview-col"]) {
    const neighbor = document.querySelector(selector);
    if (!neighbor || neighbor.contains(el)) continue;
    const edge = neighbor.getBoundingClientRect().left;
    if (edge > x + 8 && right > edge) right = edge;
  }
  const width = right - x;
  const height = bottom - y;
  if (width < 8 || height < 8) return null;
  return { x, y, width, height };
}

function boundsKey(bounds: WebAppBounds) {
  return `${Math.round(bounds.x)}|${Math.round(bounds.y)}|${Math.round(bounds.width)}|${Math.round(bounds.height)}`;
}

export function ComputerDock({ inspectedId, onInspect, onClose, onCover, onRunRoutine }: { inspectedId: string; onInspect: (id: string) => void; onClose?: () => void; onCover?: (on: boolean) => void; onRunRoutine?: () => void }) {
  const snap = useOmni((s) => s.snap)!;
  const run = useOmni((s) => s.run);
  const busy = useOmni((s) => s.busy);
  const bot = snap.profiles.find((item) => item.id === inspectedId) ?? snap.profiles.find((item) => item.id === snap.activeProfileId) ?? snap.profiles[0];
  const [tab, setTab] = useState<"browser" | "shell" | "access" | "audit">("browser");
  const [teaching, setTeaching] = useState(false);
  const [notes, setNotes] = useState("");
  const [draft, setDraft] = useState(bot?.screenUrl ?? "");
  const [url, setUrl] = useState(bot?.screenUrl ?? "");
  const [note, setNote] = useState("");
  const [refused, setRefused] = useState("");
  const [shell, setShell] = useState("");
  const frameRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const opening = useRef(false);
  const openingFor = useRef("");
  const shown = useRef("");
  const placed = useRef("");
  const liveUrl = useRef(bot?.screenUrl ?? "");
  const botIdRef = useRef(bot?.id ?? "");
  if (!opening.current) liveUrl.current = url;
  botIdRef.current = bot?.id ?? "";

  useEffect(() => {
    const next = bot?.screenUrl ?? "";
    liveUrl.current = next;
    shown.current = "";
    setDraft(next);
    setUrl(next);
    setRefused("");
    setNote("");
    setTeaching(false);
    setNotes("");
    setShell("");
    if (opening.current && openingFor.current && openingFor.current !== bot?.id) {
      shown.current = "";
      placed.current = "";
      void hideBotScreens();
    }
  }, [bot?.id]);

  useEffect(() => {
    const onScreen = (event: Event) => {
      const detail = (event as CustomEvent<{ id?: string; url?: string }>).detail;
      if (!detail?.id || detail.id !== botIdRef.current || opening.current) return;
      const next = detail.url ? safePageUrl(detail.url) : null;
      if (!next) return;
      liveUrl.current = next;
      setUrl((current) => current === next ? current : next);
      if (document.activeElement !== inputRef.current) setDraft(next);
    };
    window.addEventListener("omni-bot-screen", onScreen);
    return () => window.removeEventListener("omni-bot-screen", onScreen);
  }, []);

  useEffect(() => () => { void hideBotScreens(); }, []);

  useEffect(() => {
    if (!bot || tab !== "browser") {
      shown.current = "";
      placed.current = "";
      void hideBotScreens();
      return;
    }
    if (!isTauriRuntime()) return;
    let alive = true;
    const tick = () => {
      if (!alive) return;
      const slot = frameRef.current;
      if (!slot) return;
      const bounds = screenBounds(slot);
      if (!bounds) return;
      if (opening.current) {
        if (openingFor.current !== bot.id) return;
        const key = boundsKey(bounds);
        if (placed.current !== key) {
          placed.current = key;
          void placeBotScreen(bounds);
        }
        return;
      }
      const wanted = refused ? "" : liveUrl.current.trim();
      if (!wanted) {
        shown.current = "";
        placed.current = "";
        void hideBotScreens();
        return;
      }
      const key = `${bot.id}|${wanted}`;
      const placeKey = boundsKey(bounds);
      if (shown.current === key) {
        if (placed.current !== placeKey) {
          placed.current = placeKey;
          void placeBotScreen(bounds);
        }
        return;
      }
      shown.current = key;
      placed.current = placeKey;
      void revealBotScreen(bot.id, bounds, wanted).then((status) => {
        if (!alive || opening.current) return;
        if (status.refused) {
          shown.current = "";
          setRefused(wanted);
          liveUrl.current = "";
          setUrl("");
        }
      }).catch(() => {
        if (alive) setNote("Could not open this bot's browser.");
      });
    };
    tick();
    const observer = new ResizeObserver(tick);
    if (frameRef.current) observer.observe(frameRef.current);
    const parent = frameRef.current?.closest(".chat-layout, .chat-grid");
    if (parent) observer.observe(parent);
    for (const selector of ["[data-pane=thread]", "[data-edge-rail]", "[data-jobs-panel]", ".chat-side", ".preview-col", ".page-col"]) {
      const node = document.querySelector(selector);
      if (node) observer.observe(node);
    }
    const frame = requestAnimationFrame(tick);
    const later = window.setTimeout(tick, 120);
    window.addEventListener("resize", tick);
    const scroller = frameRef.current?.closest(".pane-b");
    scroller?.addEventListener("scroll", tick);
    return () => {
      alive = false;
      cancelAnimationFrame(frame);
      window.clearTimeout(later);
      observer.disconnect();
      window.removeEventListener("resize", tick);
      scroller?.removeEventListener("scroll", tick);
    };
  }, [bot?.id, tab, url, refused]);

  if (!bot) {
    return (
      <aside className="pane computer-dock bot-screen">
        <div className="screen-h"><strong>Screen</strong>{onClose ? <button type="button" className="screen-x" onClick={onClose} aria-label="Close">×</button> : null}</div>
        <div className="pane-b"><p className="muted">Create a bot to give it a screen of its own.</p></div>
      </aside>
    );
  }

  function save(next: BotProfile) {
    void run("save_profile", { profile: next });
  }

  async function openPage(raw: string) {
    const next = safePageUrl(raw);
    if (!next) {
      setNote("Use an https address, or http://localhost.");
      return;
    }
    setNote("");
    if (!isTauriRuntime()) {
      setNote("This preview cannot open the bot's computer. Use the desktop app.");
      return;
    }
    const bounds = frameRef.current ? screenBounds(frameRef.current) : null;
    if (!bounds) return;
    const requested = bot.id;
    const previous = liveUrl.current;
    liveUrl.current = next;
    opening.current = true;
    openingFor.current = requested;
    shown.current = `${requested}|${next}`;
    try {
      const res = await run("show_bot_screen", { botId: requested, bounds, url: next });
      if (botIdRef.current !== requested) {
        const stay = useOmni.getState().snap?.profiles.find((item) => item.id === botIdRef.current)?.screenUrl?.trim() ?? "";
        liveUrl.current = stay;
        shown.current = "";
        placed.current = "";
        setRefused("");
        setNote("");
        setDraft(stay);
        setUrl(stay);
        if (!stay) void hideBotScreens();
        return;
      }
      const payload = res?.payload as { showing?: boolean; refused?: boolean; url?: string } | undefined;
      if (!res || payload?.refused) {
        liveUrl.current = payload?.refused ? "" : previous;
        shown.current = "";
        if (payload?.refused) setRefused(next);
        else setNote("Could not open this page.");
        setUrl(liveUrl.current);
        return;
      }
      const opened = payload?.url || next;
      liveUrl.current = opened;
      shown.current = `${requested}|${opened}`;
      setRefused("");
      setUrl(opened);
      setDraft(opened);
    } finally {
      opening.current = false;
      openingFor.current = "";
    }
  }

  const audits = snap.gatewayAudits.filter((row) => row.botId === bot.id);
  const skills = snap.skills.filter((skill) => skill.ownerProfileId === bot.id || skill.enables.some((flag) => flag.profileId === bot.id) || skill.origin === "plugin");
  const thread = snap.threads.find((item) => item.id === snap.activeThreadId);

  return (
    <aside className="pane computer-dock bot-screen">
      <div className="screen-h">
        <BotFace seed={bot.id} mark={bot.avatar} size={28} state={botPresence(bot)} color={bot.avatarColor} />
        <div className="screen-who">
          <strong>{botName(bot)}&apos;s screen</strong>
          <span>{bot.takeover ? "You have control" : "Their computer"}</span>
        </div>
        {onClose ? <button type="button" className="screen-x" onClick={onClose} aria-label="Close screen">×</button> : null}
      </div>
      <div className="pane-b screen-live">
        <label className="field">
          <span>Viewing</span>
          <select className="select" value={bot.id} onChange={(event) => onInspect(event.target.value)}>
            {snap.profiles.map((item) => <option key={item.id} value={item.id}>{botName(item)}</option>)}
          </select>
        </label>
        <div className="dock-tabs" role="tablist">
          {(["browser", "shell", "access", "audit"] as const).map((item) => (
            <button key={item} type="button" className={tab === item ? "btn small" : "btn ghost small"} onClick={() => setTab(item)}>
              {item === "browser" ? "Browser" : item === "shell" ? "Shell" : item === "access" ? "Access" : "Audit"}
            </button>
          ))}
        </div>
        {tab === "browser" ? (
          <div className="screen-body">
            <span className="muted">This browser is only {botName(bot)}&apos;s.</span>
            <div className="row-actions">
              <button type="button" className={`btn small ${teaching ? "" : "ghost"}`} onClick={() => setTeaching((on) => !on)}>{teaching ? "Recording" : "Teach a task"}</button>
              <button type="button" className={`btn small ${bot.takeover ? "" : "ghost"}`} disabled={busy} onClick={() => { const next = !bot.takeover; void run("set_takeover", { botId: bot.id, on: next }); onCover?.(next); }}>{bot.takeover ? "Hand back" : "Take over"}</button>
            </div>
            {teaching ? (
              <div className="stack">
                <label className="field"><span>What you just did</span><textarea className="area" rows={3} value={notes} placeholder="Clicked login, then opened the invoice" onChange={(event) => setNotes(event.target.value)} /></label>
                <button
                  type="button"
                  className="btn small"
                  disabled={busy || notes.trim().length === 0}
                  onClick={() => {
                    void run("teach_task", { draft: { botId: bot.id, title: notes.split("\n")[0].slice(0, 48), notes, url: url || bot.screenUrl } });
                    setTeaching(false);
                    setNotes("");
                  }}
                >
                  Save skill
                </button>
              </div>
            ) : <p className="muted">Teach a task writes a SKILL.md from the steps you describe and the page on this computer.</p>}
            <form className="bot-address" onSubmit={(event) => { event.preventDefault(); void openPage(draft); }}>
              <input ref={inputRef} className="input" value={draft} placeholder="https:// or http://127.0.0.1" onChange={(event) => setDraft(event.target.value)} />
              <button type="submit" className="btn small" disabled={busy || draft.trim().length === 0}>Open</button>
            </form>
            {note ? <p className="muted">{note}</p> : null}
            <div className="bot-screen-frame" ref={frameRef}>
              {!isTauriRuntime() ? <div className="page-start"><span>This preview cannot open the bot&apos;s computer. Use the desktop app.</span></div> : refused ? (
                <div className="page-error">
                  <strong>Server not found</strong>
                  <span className="mono">{refused}</span>
                  <button type="button" className="btn small" onClick={() => void openPage(refused)}>Try again</button>
                  <span>Ask {botName(bot)} to restart the server.</span>
                </div>
              ) : url ? null : <div className="page-start"><span>This computer is off until you or the bot open a page.</span></div>}
            </div>
            {bot.screenNodes.length > 0 ? <div className="bot-screen-nodes">{bot.screenNodes.slice(0, 8).map((node) => <span key={node.id} className="mono">[{node.id}] {node.tag} {node.label}</span>)}</div> : null}
            {bot.harnessLaneId === "ag_ui_url" ? <p className="muted">Endpoint saved: {bot.agUiEndpointUrl || "none yet"}. Turns in this thread still use the model you select. The gate still checks wallet, browser, and file tools.</p> : null}
          </div>
        ) : null}
        {tab === "shell" ? (
          <div className="screen-body scroll">
            <span className="muted">Workspace</span>
            <span className="mono">{bot.workspaceDir}</span>
            {bot.workspaceFiles.length === 0 ? <p className="muted">This folder is empty.</p> : bot.workspaceFiles.map((name) => <span key={name} className="mono">{name}</span>)}
            <form className="bot-address" onSubmit={(event) => { event.preventDefault(); const command = shell.trim(); if (!command || busy) return; void run("run_sandbox", { command, botId: bot.id }); setShell(""); }}>
              <input className="input" value={shell} placeholder="echo hello" onChange={(event) => setShell(event.target.value)} />
              <button type="submit" className="btn small" disabled={busy || shell.trim().length === 0}>Run</button>
            </form>
            {bot.shellOutput ? <pre className="pre">{bot.shellOutput}</pre> : <p className="muted">Commands from this bot stay in this folder. The allowlist still applies.</p>}
          </div>
        ) : null}
        {tab === "access" ? (
          <div className="screen-body scroll">
            <p className="muted">Each bot has its own browser and its own workspace folder. These switches turn those tools on or off for this bot.</p>
            <Toggle label="Browser" on={bot.allowBrowserUse} onClick={() => save({ ...bot, allowBrowserUse: !bot.allowBrowserUse })} />
            <Toggle label="Shell" on={bot.allowComputerUse} onClick={() => save({ ...bot, allowComputerUse: !bot.allowComputerUse })} />
            <Toggle label="Read files" on={bot.allowCodeExec} onClick={() => save({ ...bot, allowCodeExec: !bot.allowCodeExec })} />
            <Toggle label="File write" on={bot.allowFileWrite} onClick={() => save({ ...bot, allowFileWrite: !bot.allowFileWrite })} />
            <Toggle label="Approve external actions" on={bot.requireApprovalExternal} onClick={() => save({ ...bot, requireApprovalExternal: !bot.requireApprovalExternal })} />
            <Toggle label="Approve wallet spends" on={bot.requireApprovalWallet} onClick={() => save({ ...bot, requireApprovalWallet: !bot.requireApprovalWallet })} />
            <span className="muted">Skills</span>
            {skills.length === 0 ? <p className="muted">No skills for this bot yet.</p> : skills.map((skill) => {
              const on = skill.enables.some((flag) => flag.profileId === bot.id && flag.enabled);
              return <Toggle key={skill.id} label={skill.slashCommand || `/${skill.slug}`} on={on} onClick={() => void run("toggle_skill", { id: skill.id, profileId: bot.id, enabled: !on })} />;
            })}
            <span className="muted">Plugins</span>
            {snap.plugins.map((plugin) => {
              const on = plugin.agentEnables.some((flag) => flag.profileId === bot.id && flag.enabled);
              return <Toggle key={plugin.id} label={plugin.name} on={on} onClick={() => void run("toggle_plugin_agent", { id: plugin.id, profileId: bot.id, enabled: !on })} />;
            })}
            <span className="muted">MCP</span>
            {snap.mcpServers.map((server) => {
              const on = server.enables.some((flag) => flag.profileId === bot.id && flag.enabled);
              return <Toggle key={server.id} label={server.name} on={on} onClick={() => void run("toggle_mcp", { id: server.id, profileId: bot.id, enabled: !on })} />;
            })}
          </div>
        ) : null}
        {tab === "audit" ? (
          <div className="screen-body scroll">
            <p className="muted">Stall watchdog {Math.round(bot.stallTimeoutMs / 1000)}s. A turn that fails after that is recorded as stalled.</p>
            {audits.length === 0 ? <p className="muted">No gated actions for {bot.handle} yet.</p> : audits.map((row) => (
              <div key={row.id} className="tool-card">
                <div className="between">
                  <strong className="mono">{row.toolOrSurface}</strong>
                  <span className="muted">{row.gatewayDecision}</span>
                </div>
                <span className="mono">{row.targetResource}</span>
              </div>
            ))}
          </div>
        ) : null}
        <div className="routine-block">
          <strong>Routines</strong>
          {thread?.routineSchedule ? <p>{thread.routineSchedule}</p> : <p className="muted">None on this chat.</p>}
          <div className="row-actions">
            {thread?.routineSchedule ? <button type="button" className="btn ghost small" disabled={busy} onClick={() => { if (!thread) return; forgetSchedule(thread.id); void run("set_routine", { threadId: thread.id, schedule: "" }); }}>Remove</button> : <button type="button" className="btn ghost small" disabled={busy || !thread} onClick={() => { if (!thread) return; rememberSchedule(thread.id, "daily 08:00"); void run("set_routine", { threadId: thread.id, schedule: "daily 08:00" }); }}>Every day at 8:00 AM</button>}
            {thread?.routineSchedule && onRunRoutine ? <button type="button" className="btn ghost small" disabled={busy} onClick={onRunRoutine}>Run now</button> : null}
          </div>
          <p className="muted">Runs while Ronic OS is open. It pauses when you close the app. The Scheduled jobs tab lists every chat.</p>
        </div>
        <span className="muted">{harnessLabel(bot)}</span>
      </div>
    </aside>
  );
}

function Toggle({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button type="button" className="toggle" onClick={onClick}>
      <span>{label}</span>
      <span className="muted">{on ? "on" : "off"}</span>
    </button>
  );
}

export function GatewayCard({ step, model }: { step: Step; model: ChatModel | null }) {
  const run = useOmni((s) => s.run);
  const busy = useOmni((s) => s.busy);
  const state = String(step.actionPayload.approvalState ?? "pending");
  return (
    <article className="notice stack">
      <div className="between">
        <strong>{String(step.actionPayload.botHandle ?? "This bot")} needs your ok</strong>
        <span className="muted">{state}</span>
      </div>
      <p>{step.contentMarkdown}</p>
      {state === "pending" ? (
        <div className="row-actions">
          <button type="button" className="btn small" disabled={busy} onClick={() => void run("resolve_gateway", { stepId: step.id, approve: true, providerId: model?.providerId, model: model?.upstreamModel, modelId: model?.id, effort: model ? effortFor(model.id) : "default" })}>Approve & continue</button>
          <button type="button" className="btn ghost small" disabled={busy} onClick={() => void run("resolve_gateway", { stepId: step.id, approve: false })}>Decline & add deny rule</button>
        </div>
      ) : null}
    </article>
  );
}

export function HandoffLine({ step }: { step: Step }) {
  return (
    <article className="step capsule">
      <p className="mono">{step.contentMarkdown}</p>
    </article>
  );
}

export function modeLabel(mode: string) {
  return MODES.find((item) => item[0] === mode)?.[1] ?? mode;
}

export { MODES };
