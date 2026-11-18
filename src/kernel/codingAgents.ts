export interface ModifiedFile {
  path: string;
  additions: number;
  deletions: number;
  staged: boolean;
  diff: string;
}

export function filesFromPayload(payload: unknown): ModifiedFile[] | null {
  if (!payload || typeof payload !== "object") return null;
  const files = (payload as { files?: unknown }).files;
  if (!Array.isArray(files)) return null;
  return files.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Partial<ModifiedFile>;
    if (typeof row.path !== "string" || row.path.length === 0) return [];
    return [{
      path: row.path,
      additions: Number(row.additions) || 0,
      deletions: Number(row.deletions) || 0,
      staged: Boolean(row.staged),
      diff: typeof row.diff === "string" ? row.diff : "",
    }];
  });
}

function payloadFlag(payload: unknown, key: "opened"): boolean {
  return Boolean(payload && typeof payload === "object" && (payload as Record<string, unknown>)[key] === true);
}

function payloadExit(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") return null;
  const value = (payload as { exitCode?: unknown }).exitCode;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function dispatchOutput(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const output = (payload as { output?: unknown }).output;
  return typeof output === "string" ? output : "";
}

/**
 * A desktop build that only opens Cursor or VS Code used to return an empty
 * file list. Keep the tree already on screen in that case. A real status,
 * a finished program (exitCode), or an open that includes `opened` replaces it.
 */
export function filesAfterDispatch(previous: ModifiedFile[], payload: unknown): ModifiedFile[] {
  const next = filesFromPayload(payload);
  if (!next) return previous;
  if (next.length === 0 && payloadExit(payload) == null && !payloadFlag(payload, "opened")) return previous;
  return next;
}

export function clampFileIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  if (index < 0) return 0;
  if (index >= count) return count - 1;
  return index;
}

export function indexAfterRefresh(previous: ModifiedFile[], next: ModifiedFile[], current: number): number {
  const currentPath = previous[current]?.path;
  if (currentPath) {
    const found = next.findIndex((file) => file.path === currentPath);
    if (found >= 0) return found;
  }
  return clampFileIndex(current, next.length);
}

export function ideToOpen(active: string, ready: { cursor: boolean; vscode: boolean }): "cursor" | "vscode" {
  if (active === "vscode" && ready.vscode) return "vscode";
  if (active === "cursor" && ready.cursor) return "cursor";
  if (ready.cursor) return "cursor";
  if (ready.vscode) return "vscode";
  return active === "vscode" ? "vscode" : "cursor";
}

export interface ProjectTreeEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
}

export interface ProjectFileContent {
  path: string;
  content: string;
  size: number;
  lines: number;
  binary: boolean;
  truncated: boolean;
}

export interface GitMeta {
  isGit: boolean;
  branch: string;
  projectRoot: string;
}

export interface HarnessSyncReport {
  agent: string;
  bridgeOnline: boolean;
  bridgeEndpoint: string;
  contextFile: string;
  configTargets: string[];
  syncedServers: string[];
  skillsCount: number;
  pluginsCount: number;
  totalPluginsCount: number;
  mcpCount: number;
  memoryCount: number;
  warnings: string[];
  syncedAt: number;
}

export function treeFromPayload(payload: unknown): ProjectTreeEntry[] | null {
  if (!payload || typeof payload !== "object") return null;
  const entries = (payload as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return null;
  return entries.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Partial<ProjectTreeEntry>;
    if (typeof row.name !== "string" || typeof row.path !== "string" || !row.path) return [];
    return [{
      name: row.name,
      path: row.path,
      isDir: Boolean(row.isDir),
      size: Number(row.size) || 0,
    }];
  });
}

export function fileContentFromPayload(payload: unknown): ProjectFileContent | null {
  if (!payload || typeof payload !== "object") return null;
  const row = payload as Partial<ProjectFileContent>;
  if (typeof row.path !== "string" || typeof row.content !== "string") return null;
  return {
    path: row.path,
    content: row.content,
    size: Number(row.size) || 0,
    lines: Number(row.lines) || 0,
    binary: Boolean(row.binary),
    truncated: Boolean(row.truncated),
  };
}

export function gitMetaFromPayload(payload: unknown): GitMeta | null {
  if (!payload || typeof payload !== "object") return null;
  const row = payload as { isGit?: unknown; branch?: unknown; projectRoot?: unknown };
  if (typeof row.isGit !== "boolean" && typeof row.branch !== "string") return null;
  return {
    isGit: typeof row.isGit === "boolean" ? row.isGit : true,
    branch: typeof row.branch === "string" ? row.branch : "",
    projectRoot: typeof row.projectRoot === "string" ? row.projectRoot : "",
  };
}

export function syncReportFromPayload(payload: unknown): HarnessSyncReport | null {
  if (!payload || typeof payload !== "object") return null;
  const raw = (payload as { sync?: unknown }).sync ?? payload;
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Partial<HarnessSyncReport>;
  if (typeof row.agent !== "string") return null;
  const strArr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return {
    agent: row.agent,
    bridgeOnline: Boolean(row.bridgeOnline),
    bridgeEndpoint: typeof row.bridgeEndpoint === "string" ? row.bridgeEndpoint : "",
    contextFile: typeof row.contextFile === "string" ? row.contextFile : "",
    configTargets: strArr(row.configTargets),
    syncedServers: strArr(row.syncedServers),
    skillsCount: Number(row.skillsCount) || 0,
    pluginsCount: Number(row.pluginsCount) || 0,
    totalPluginsCount: Number(row.totalPluginsCount) || 0,
    mcpCount: Number(row.mcpCount) || 0,
    memoryCount: Number(row.memoryCount) || 0,
    warnings: strArr(row.warnings),
    syncedAt: Number(row.syncedAt) || Date.now(),
  };
}

export interface ProjectEntry {
  path: string;
  name: string;
  pinned: boolean;
  lastOpenedAt: number;
}

const PROJECTS_KEY = "ronic.coding.projects.v1";
const SESSIONS_KEY = "ronic.coding.sessions.v1";
const LAYOUT_KEY = "ronic.coding.layout.v1";
const HARNESS_MODELS_KEY = "ronic.coding.models.v1";
const CUSTOM_MODELS_KEY = "ronic.coding.customModels.v1";
const HARNESS_EFFORT_KEY = "ronic.coding.effort.v1";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function getStorage(): StorageLike | null {
  const g = globalThis as { localStorage?: StorageLike };
  return g.localStorage ?? null;
}

export function projectLabel(folderPath: string): string {
  const cleaned = folderPath.trim().replace(/[\\/]+$/, "");
  if (!cleaned) return "Untitled Project";
  const parts = cleaned.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || cleaned;
}

export function normalizeProjectKey(folderPath: string): string {
  return folderPath.trim().replace(/[\\/]+$/, "").toLowerCase();
}

export function upsertProject(list: ProjectEntry[], folderPath: string, now = Date.now()): ProjectEntry[] {
  const trimmed = folderPath.trim();
  if (!trimmed) return list;
  const key = normalizeProjectKey(trimmed);
  const existing = list.find((p) => normalizeProjectKey(p.path) === key);
  const entry: ProjectEntry = {
    path: trimmed,
    name: existing?.name || projectLabel(trimmed),
    pinned: existing?.pinned ?? false,
    lastOpenedAt: now,
  };
  const rest = list.filter((p) => normalizeProjectKey(p.path) !== key);
  const next = [entry, ...rest].slice(0, 24);
  return sortProjects(next);
}

export function togglePinProject(list: ProjectEntry[], folderPath: string): ProjectEntry[] {
  const key = normalizeProjectKey(folderPath);
  return sortProjects(
    list.map((p) => (normalizeProjectKey(p.path) === key ? { ...p, pinned: !p.pinned } : p)),
  );
}

export function removeProject(list: ProjectEntry[], folderPath: string): ProjectEntry[] {
  const key = normalizeProjectKey(folderPath);
  return list.filter((p) => normalizeProjectKey(p.path) !== key);
}

function sortProjects(list: ProjectEntry[]): ProjectEntry[] {
  return [...list].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.lastOpenedAt - a.lastOpenedAt;
  });
}

export function loadProjects(initialRoot?: string): ProjectEntry[] {
  let saved: ProjectEntry[] = [];
  const storage = getStorage();
  if (storage) {
    try {
      const raw = storage.getItem(PROJECTS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          saved = parsed.filter(
            (p): p is ProjectEntry =>
              Boolean(p && typeof p === "object" && typeof p.path === "string" && p.path.trim().length > 0),
          );
        }
      }
    } catch {}
  }
  return initialRoot ? upsertProject(saved, initialRoot) : sortProjects(saved);
}

export function saveProjects(list: ProjectEntry[]): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(PROJECTS_KEY, JSON.stringify(list.slice(0, 24)));
  } catch {}
}

export interface CodingTurn {
  id: string;
  prompt: string;
  output: string;
  agent: string;
  model?: string;
  exitCode: number | null;
  createdAt: number;
  durationMs: number;
  attachedFiles: string[];
  selectedSkills: string[];
  changedFiles: string[];
}

export interface CodingSession {
  id: string;
  title: string;
  projectRoot: string;
  agent: string;
  createdAt: number;
  updatedAt: number;
  turns: CodingTurn[];
}

export function createSession(projectRoot: string, agent: string, title?: string, now = Date.now()): CodingSession {
  const suffix = Math.random().toString(36).slice(2, 7);
  return {
    id: `cs_${now}_${suffix}`,
    title: title?.trim() || "New coding session",
    projectRoot: projectRoot.trim(),
    agent,
    createdAt: now,
    updatedAt: now,
    turns: [],
  };
}

export function appendTurn(
  sessions: CodingSession[],
  sessionId: string,
  turn: CodingTurn,
  now = Date.now(),
): CodingSession[] {
  return sessions
    .map((session) => {
      if (session.id !== sessionId) return session;
      const isDefaultTitle = session.turns.length === 0 && session.title === "New coding session";
      const derivedTitle = turn.prompt.trim().replace(/\s+/g, " ").slice(0, 48) || session.title;
      return {
        ...session,
        title: isDefaultTitle ? derivedTitle : session.title,
        agent: turn.agent || session.agent,
        updatedAt: now,
        turns: [...session.turns, turn].slice(-40),
      };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function renameSession(sessions: CodingSession[], sessionId: string, title: string): CodingSession[] {
  const clean = title.trim();
  if (!clean) return sessions;
  return sessions.map((s) => (s.id === sessionId ? { ...s, title: clean } : s));
}

export function deleteSession(sessions: CodingSession[], sessionId: string): CodingSession[] {
  return sessions.filter((s) => s.id !== sessionId);
}

export function buildHistorySummary(session: CodingSession | undefined, maxTurns = 3): string {
  if (!session || session.turns.length === 0) return "";
  return session.turns
    .slice(-maxTurns)
    .map((t, idx) => {
      const out = t.output.trim().slice(0, 260);
      return `Turn ${idx + 1} (${t.agent}):\nUser: ${t.prompt.trim().slice(0, 240)}\nResult: ${out || "(no output)"}`;
    })
    .join("\n---\n");
}

export function loadSessions(): CodingSession[] {
  const storage = getStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(SESSIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (s): s is CodingSession =>
        Boolean(s && typeof s === "object" && typeof s.id === "string" && Array.isArray(s.turns)),
    );
  } catch {
    return [];
  }
}

export function saveSessions(sessions: CodingSession[]): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(SESSIONS_KEY, JSON.stringify(sessions.slice(0, 50)));
  } catch {}
}

export type PaneId = "explorer" | "workspace" | "capabilities";

export interface CodingLayout {
  leftWidth: number;
  rightWidth: number;
  terminalHeight: number;
  leftTopRatio: number;
  centerSplitRatio: number;
  showLeft: boolean;
  showRight: boolean;
  showTerminal: boolean;
  centerMode: "chat" | "code" | "split";
  paneOrder: PaneId[];
}

export const DEFAULT_LAYOUT: CodingLayout = {
  leftWidth: 300,
  rightWidth: 310,
  terminalHeight: 220,
  leftTopRatio: 0.42,
  centerSplitRatio: 0.52,
  showLeft: true,
  showRight: true,
  showTerminal: true,
  centerMode: "split",
  paneOrder: ["explorer", "workspace", "capabilities"],
};

function clampNum(val: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(val)) return fallback;
  return Math.min(max, Math.max(min, val));
}

export function normalizePaneOrder(raw: unknown): PaneId[] {
  const valid: PaneId[] = ["explorer", "workspace", "capabilities"];
  if (!Array.isArray(raw)) return [...valid];
  const seen: PaneId[] = [];
  for (const item of raw) {
    if ((item === "explorer" || item === "workspace" || item === "capabilities") && !seen.includes(item)) {
      seen.push(item);
    }
  }
  for (const item of valid) {
    if (!seen.includes(item)) seen.push(item);
  }
  return seen;
}

export function reorderPanes(order: PaneId[], from: PaneId, to: PaneId): PaneId[] {
  if (from === to) return order;
  const next = normalizePaneOrder(order);
  const fromIdx = next.indexOf(from);
  const toIdx = next.indexOf(to);
  if (fromIdx < 0 || toIdx < 0) return next;
  next.splice(fromIdx, 1);
  next.splice(toIdx, 0, from);
  return next;
}

export function clampLayout(raw: Partial<CodingLayout> | null | undefined): CodingLayout {
  const base = raw || {};
  const centerMode =
    base.centerMode === "chat" || base.centerMode === "code" || base.centerMode === "split"
      ? base.centerMode
      : DEFAULT_LAYOUT.centerMode;
  return {
    leftWidth: clampNum(Number(base.leftWidth), 210, 520, DEFAULT_LAYOUT.leftWidth),
    rightWidth: clampNum(Number(base.rightWidth), 230, 520, DEFAULT_LAYOUT.rightWidth),
    terminalHeight: clampNum(Number(base.terminalHeight), 110, 540, DEFAULT_LAYOUT.terminalHeight),
    leftTopRatio: clampNum(Number(base.leftTopRatio), 0.2, 0.8, DEFAULT_LAYOUT.leftTopRatio),
    centerSplitRatio: clampNum(Number(base.centerSplitRatio), 0.25, 0.75, DEFAULT_LAYOUT.centerSplitRatio),
    showLeft: typeof base.showLeft === "boolean" ? base.showLeft : DEFAULT_LAYOUT.showLeft,
    showRight: typeof base.showRight === "boolean" ? base.showRight : DEFAULT_LAYOUT.showRight,
    showTerminal: typeof base.showTerminal === "boolean" ? base.showTerminal : DEFAULT_LAYOUT.showTerminal,
    centerMode,
    paneOrder: normalizePaneOrder(base.paneOrder),
  };
}

export function loadLayout(): CodingLayout {
  const storage = getStorage();
  if (!storage) return { ...DEFAULT_LAYOUT };
  try {
    const raw = storage.getItem(LAYOUT_KEY);
    if (!raw) return { ...DEFAULT_LAYOUT };
    return clampLayout(JSON.parse(raw) as Partial<CodingLayout>);
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}

export function saveLayout(layout: CodingLayout): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(LAYOUT_KEY, JSON.stringify(clampLayout(layout)));
  } catch {}
}

export type CodingEffort = "auto" | "low" | "medium" | "high";

export interface HarnessModelOption {
  id: string;
  label: string;
  tier: "fast" | "balanced" | "deep";
  source: "cli" | "preset" | "connected" | "custom";
}

export function modelsFromPayload(payload: unknown): HarnessModelOption[] | null {
  if (!payload || typeof payload !== "object") return null;
  const rows = (payload as { models?: unknown }).models;
  if (!Array.isArray(rows)) return null;
  return rows.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Partial<HarnessModelOption>;
    const id = typeof row.id === "string" ? row.id.trim() : "";
    if (!id) return [];
    const tier = row.tier === "fast" || row.tier === "deep" ? row.tier : "balanced";
    const source =
      row.source === "cli" || row.source === "connected" || row.source === "custom" ? row.source : "preset";
    return [{
      id,
      label: typeof row.label === "string" && row.label.trim() ? row.label.trim() : id,
      tier,
      source,
    }];
  });
}

export function mergeModelOptions(
  primary: HarnessModelOption[],
  connected: HarnessModelOption[],
  customIds: string[],
): HarnessModelOption[] {
  const seen = new Set<string>();
  const out: HarnessModelOption[] = [];
  const push = (m: HarnessModelOption) => {
    const id = m.id.trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push({ ...m, id });
  };
  for (const m of primary) push(m);
  for (const id of customIds) {
    const clean = id.trim();
    if (clean) push({ id: clean, label: clean, tier: "balanced", source: "custom" });
  }
  for (const m of connected) push(m);
  return out;
}

export function loadStringMap(key: string): Record<string, string> {
  const storage = getStorage();
  if (!storage) return {};
  try {
    const raw = storage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveStringMap(key: string, map: Record<string, string>): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify(map));
  } catch {}
}

export function loadSelectedModels(): Record<string, string> {
  return loadStringMap(HARNESS_MODELS_KEY);
}

export function saveSelectedModels(map: Record<string, string>): void {
  saveStringMap(HARNESS_MODELS_KEY, map);
}

export function loadEffortMap(): Record<string, CodingEffort> {
  const raw = loadStringMap(HARNESS_EFFORT_KEY);
  const out: Record<string, CodingEffort> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === "auto" || v === "low" || v === "medium" || v === "high") out[k] = v;
  }
  return out;
}

export function saveEffortMap(map: Record<string, CodingEffort>): void {
  saveStringMap(HARNESS_EFFORT_KEY, map);
}

export function loadCustomModels(): Record<string, string[]> {
  const storage = getStorage();
  if (!storage) return {};
  try {
    const raw = storage.getItem(CUSTOM_MODELS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(v)) out[k] = v.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
    }
    return out;
  } catch {
    return {};
  }
}

export function saveCustomModels(map: Record<string, string[]>): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(CUSTOM_MODELS_KEY, JSON.stringify(map));
  } catch {}
}

export function buildDispatchEnvelope(opts: {
  text: string;
  injectContext: boolean;
  autoApprove: boolean;
  fastContext?: boolean;
  model?: string;
  effort?: CodingEffort;
  historySummary: string;
  attachedFiles: string[];
  selectedSkills: string[];
}): string {
  return JSON.stringify({
    __ronicDispatch: true,
    text: opts.text.trim(),
    injectContext: opts.injectContext,
    autoApprove: opts.autoApprove,
    fastContext: opts.fastContext ?? true,
    model: (opts.model || "").trim(),
    effort: opts.effort && opts.effort !== "auto" ? opts.effort : "",
    historySummary: opts.historySummary,
    attachedFiles: opts.attachedFiles,
    selectedSkills: opts.selectedSkills,
  });
}

export function interactiveCliCommand(opts: {
  agent: string;
  agentPath: string;
  projectRoot: string;
  model?: string;
  effort?: CodingEffort;
  isWin: boolean;
}): string {
  const quoted = opts.agentPath.includes(" ") ? `& "${opts.agentPath}"` : opts.agentPath;
  const args: string[] = [];
  const model = (opts.model || "").trim();
  if (model && model !== "auto" && !/[\s"'&|;]/.test(model)) {
    if (opts.agent === "codex" || opts.agent === "opencode") args.push("-m", model);
    else args.push("--model", model);
  }
  const effort = opts.effort;
  if (effort && effort !== "auto") {
    const isAgy = /(?:^|[\\/])agy(?:\.exe|\.cmd)?$/i.test(opts.agentPath.trim());
    if (opts.agent === "claude" || (opts.agent === "gemini" && isAgy)) {
      args.push("--effort", effort);
    }
  }
  const safeRoot = opts.projectRoot.replace(/"/g, "");
  const cdPrefix = safeRoot
    ? opts.isWin
      ? `Set-Location -LiteralPath "${safeRoot}"; `
      : `cd "${safeRoot}" && `
    : "";
  return `${cdPrefix}${quoted}${args.length ? " " + args.join(" ") : ""}`;
}
