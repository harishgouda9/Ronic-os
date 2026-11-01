const SEEN_KEY = "ronic.threadSeen.v1";
const FIRED_KEY = "ronic.jobFired.v1";
const SAVED_KEY = "ronic.jobSaved.v1";
const META_KEY = "ronic.selectedModel.meta";
const TABS_KEY = "ronic.openTabs.v1";

export type ModelMeta = { id: string; providerId: string; upstreamModel: string };

export type ParsedSchedule =
  | { kind: "every"; ms: number; label: string }
  | { kind: "daily"; minutes: number; label: string };

export const SCHEDULES = [
  { id: "15m", label: "Every 15 minutes", value: "every 15m" },
  { id: "1h", label: "Every hour", value: "every 1h" },
  { id: "daily", label: "Every day at 8:00 AM", value: "daily 08:00" },
] as const;

function readMap(key: string): Record<string, number> {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    const out: Record<string, number> = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (typeof value === "number" && Number.isFinite(value)) out[id] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function writeMap(key: string, value: Record<string, number>) {
  localStorage.setItem(key, JSON.stringify(value));
}

export function ago(ms: number, now = Date.now()) {
  if (!ms) return "";
  const minutes = Math.floor(Math.max(0, now - ms) / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d`;
  return new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });
}

export function oneLine(text: string) {
  return text.replace(/[#>*_`]/g, "").replace(/\s+/g, " ").trim();
}

type LineStep = { threadId: string; role: string; actionType: string; contentMarkdown: string; createdAt: number };

export function lastLine(steps: readonly LineStep[], threadIds: Iterable<string>) {
  const ids = threadIds instanceof Set ? threadIds : new Set(threadIds);
  let best: LineStep | null = null;
  for (const step of steps) {
    if (!ids.has(step.threadId)) continue;
    if (step.role !== "user" && step.role !== "assistant") continue;
    if (step.actionType === "thinking") continue;
    if (!oneLine(step.contentMarkdown)) continue;
    if (!best || step.createdAt >= best.createdAt) best = step;
  }
  if (!best) return { text: "", at: 0 };
  return { text: oneLine(best.contentMarkdown), at: best.createdAt };
}

export function readSeen() {
  return readMap(SEEN_KEY);
}

export function markSeen(threadId: string, at: number) {
  if (!threadId || !at) return;
  const seen = readSeen();
  if ((seen[threadId] ?? 0) >= at) return;
  seen[threadId] = at;
  writeMap(SEEN_KEY, seen);
  window.dispatchEvent(new Event("ronic-seen"));
}

export function isUnread(threadId: string, updatedAt: number, active: boolean) {
  if (active || !updatedAt) return false;
  const seen = readSeen()[threadId];
  if (seen == null) return false;
  return updatedAt > seen;
}

export function readFired() {
  return readMap(FIRED_KEY);
}

export function markFired(threadId: string, at: number) {
  const fired = readFired();
  fired[threadId] = at;
  writeMap(FIRED_KEY, fired);
}

type SavedRow = { schedule: string; savedAt: number };

function readSaved(): Record<string, SavedRow> {
  try {
    const raw = localStorage.getItem(SAVED_KEY);
    const parsed = raw ? JSON.parse(raw) as Record<string, SavedRow> : {};
    const out: Record<string, SavedRow> = {};
    for (const [id, row] of Object.entries(parsed)) {
      if (row && typeof row.schedule === "string" && typeof row.savedAt === "number") out[id] = row;
    }
    return out;
  } catch {
    return {};
  }
}

export function rememberSchedule(threadId: string, schedule: string, now = Date.now()) {
  const all = readSaved();
  const prev = all[threadId];
  if (prev && prev.schedule === schedule) return prev.savedAt;
  all[threadId] = { schedule, savedAt: now };
  localStorage.setItem(SAVED_KEY, JSON.stringify(all));
  return now;
}

export function anchorFor(threadId: string, schedule: string, now = Date.now()) {
  return rememberSchedule(threadId, schedule, now);
}

export function forgetSchedule(threadId: string) {
  const all = readSaved();
  delete all[threadId];
  localStorage.setItem(SAVED_KEY, JSON.stringify(all));
  const fired = readFired();
  delete fired[threadId];
  writeMap(FIRED_KEY, fired);
}

function clockLabel(hour: number, minute: number) {
  const suffix = hour >= 12 ? "PM" : "AM";
  const h = hour % 12 || 12;
  return `${h}:${String(minute).padStart(2, "0")} ${suffix}`;
}

export function parseSchedule(raw: string): ParsedSchedule | null {
  const text = raw.trim();
  const every = /^every\s+(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/i.exec(text);
  if (every) {
    const count = Number(every[1]);
    if (!Number.isInteger(count) || count < 1 || count > 24 * 14) return null;
    const hours = every[2].toLowerCase().startsWith("h");
    const ms = hours ? count * 3_600_000 : count * 60_000;
    const label = hours
      ? `Every ${count} hour${count === 1 ? "" : "s"}`
      : `Every ${count} minute${count === 1 ? "" : "s"}`;
    return { kind: "every", ms, label };
  }
  const daily = /^daily\s+(\d{1,2}):(\d{2})$/i.exec(text);
  if (daily) {
    const hour = Number(daily[1]);
    const minute = Number(daily[2]);
    if (hour > 23 || minute > 59) return null;
    return { kind: "daily", minutes: hour * 60 + minute, label: `Every day at ${clockLabel(hour, minute)}` };
  }
  const legacy = /^every day at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i.exec(text);
  if (legacy) {
    let hour = Number(legacy[1]);
    const minute = Number(legacy[2] ?? "0");
    const suffix = legacy[3].toLowerCase();
    if (hour < 1 || hour > 12 || minute > 59) return null;
    if (suffix === "pm" && hour < 12) hour += 12;
    if (suffix === "am" && hour === 12) hour = 0;
    return { kind: "daily", minutes: hour * 60 + minute, label: `Every day at ${clockLabel(hour, minute)}` };
  }
  return null;
}

export function scheduleLabel(raw: string) {
  return parseSchedule(raw)?.label ?? raw.trim();
}

export function nextRun(schedule: ParsedSchedule, savedAt: number, lastFired: number, now: number) {
  if (schedule.kind === "every") {
    return Math.max(savedAt, lastFired) + schedule.ms;
  }
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const today = start.getTime() + schedule.minutes * 60_000;
  if (lastFired >= today) return today + 86_400_000;
  if (now >= today && savedAt < today) return today;
  if (now >= today) return today + 86_400_000;
  return today;
}

export function isDue(schedule: ParsedSchedule, savedAt: number, lastFired: number, now: number) {
  return nextRun(schedule, savedAt, lastFired, now) <= now;
}

export function dueLabel(ms: number, now = Date.now()) {
  if (ms <= now) return "Due";
  const minutes = Math.max(1, Math.round((ms - now) / 60000));
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 36) return `in ${hours}h`;
  return `in ${Math.ceil(hours / 24)}d`;
}

export function readTabs() {
  try {
    const raw = localStorage.getItem(TABS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string").slice(0, 12) : [];
  } catch {
    return [];
  }
}

export function writeTabs(ids: string[]) {
  localStorage.setItem(TABS_KEY, JSON.stringify(ids.slice(0, 12)));
}

export function rememberModel(meta: ModelMeta | null) {
  if (!meta?.id || !meta.providerId || !meta.upstreamModel) {
    localStorage.removeItem(META_KEY);
    return;
  }
  localStorage.setItem(META_KEY, JSON.stringify(meta));
}

export function readModelMeta(): ModelMeta | null {
  try {
    const raw = localStorage.getItem(META_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ModelMeta;
    if (!parsed.id || !parsed.providerId || !parsed.upstreamModel) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function safePageUrl(raw: string) {
  const text = raw.trim();
  if (!text || text.length > 2000 || /[\s\u0000-\u001f]/.test(text)) return null;
  let withScheme = text;
  if (!text.includes("://")) {
    const hostish = text.split(/[/?#]/)[0] ?? text;
    const name = hostish.replace(/^\[|\]$/g, "").split(":")[0] ?? "";
    const local = name.toLowerCase() === "localhost" || name === "127.0.0.1" || name === "::1";
    withScheme = `${local ? "http" : "https"}://${text}`;
  }
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const local = host.toLowerCase() === "localhost" || host === "127.0.0.1" || host === "::1";
  if (url.protocol === "https:" && host) return url.toString();
  if (url.protocol === "http:" && local) return url.toString();
  return null;
}

export function pageHost(url: string) {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    return `${parsed.host}${path}`.slice(0, 48);
  } catch {
    return url.slice(0, 48);
  }
}

export function restartAsk(url: string) {
  return `The page at ${url} refused the connection (ERR_CONNECTION_REFUSED). Restart the server for that page, then tell me when it is back.`;
}

export function speechAvailable() {
  if (typeof window === "undefined") return false;
  const host = window as Window & { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
  return (
    typeof host.SpeechRecognition === "function" ||
    typeof host.webkitSpeechRecognition === "function" ||
    Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
  );
}
