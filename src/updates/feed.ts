import type { Settings } from "../types";

/** Keep this aligned with package.json, src-tauri/tauri.conf.json, and the Cargo package version. */
export const PRODUCT_VERSION = "2.2.0";

export const UPDATE_NOTICE_KEY = "ronic.update.notice";

export type UpdateChannel = "stable" | "nightly";
export type UpdateMode = "auto" | "manual";
export type ReleaseChannel = UpdateChannel | "any";
export type ChangeKind = "feature" | "fix" | "change";

export type ReleaseChange = {
  kind: ChangeKind;
  title: string;
  detail: string;
};

export type ProductRelease = {
  version: string;
  channel: ReleaseChannel;
  published: string;
  summary: string;
  downloadUrl: string;
  changes: ReleaseChange[];
  source: string;
};

export type UpdateStatus = {
  installed: string;
  available: ProductRelease | null;
  current: ProductRelease | null;
  history: ProductRelease[];
  errors: string[];
};

const MAX_PARSED = 30;
const MAX_HISTORY = 8;
const MAX_CHANGES = 20;

export function compareVersions(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  if (!a || !b) return 0;
  const count = Math.max(a.length, b.length);
  for (let index = 0; index < count; index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta > 0 ? 1 : -1;
  }
  return 0;
}

export function parseFeed(text: string, source: string): ProductRelease[] | null {
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
  const root = isRecord(data) ? data : null;
  const fallbackChannel = root && typeof root.channel === "string" ? root.channel : "";
  const list = releaseList(data);
  if (!list) return null;
  const releases: ProductRelease[] = [];
  for (const item of list) {
    const release = normalizeRelease(item, source, fallbackChannel);
    if (release) releases.push(release);
    if (releases.length >= MAX_PARSED) break;
  }
  return releases;
}

export function pickUpdate(installed: string, channel: UpdateChannel, sources: { name: string; text: string | null }[]): UpdateStatus {
  const errors: string[] = [];
  const matching: ProductRelease[] = [];
  for (const source of sources) {
    if (source.text == null || source.text.trim() === "") continue;
    const releases = parseFeed(source.text, source.name);
    if (!releases) {
      errors.push(`${source.name} is not a release file.`);
      continue;
    }
    for (const release of releases) {
      if (release.channel === "any" || release.channel === channel) matching.push(release);
    }
  }
  const sorted = [...matching].sort((left, right) => compareVersions(right.version, left.version));
  const seen = new Set<string>();
  const history: ProductRelease[] = [];
  for (const release of sorted) {
    if (seen.has(release.version)) continue;
    seen.add(release.version);
    history.push(release);
    if (history.length >= MAX_HISTORY) break;
  }
  return {
    installed,
    available: history.find((release) => compareVersions(release.version, installed) > 0) ?? null,
    current: history.find((release) => compareVersions(release.version, installed) === 0) ?? null,
    history,
    errors,
  };
}

export function shouldNotify(status: Pick<UpdateStatus, "available" | "current">, dismissed: string[], explicit: boolean): boolean {
  const blocked = (version: string) => dismissed.some((item) => item === version);
  if (status.available) {
    if (explicit) return true;
    return !blocked(status.available.version);
  }
  if (!status.current || status.current.changes.length === 0) return false;
  return !blocked(status.current.version);
}

export function readDismissedNotice(): string {
  try {
    return localStorage.getItem(UPDATE_NOTICE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function dismissNotice(version: string) {
  try {
    localStorage.setItem(UPDATE_NOTICE_KEY, version);
  } catch {
    /* The notice still closes for this session when storage is blocked. */
  }
}

function storedUpdateValue(key: string): string | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function normalizeUpdateSettings(settings: Settings): Settings {
  const rawMode = (settings as { updateMode?: unknown }).updateMode;
  const rawFeed = (settings as { updateFeedUrl?: unknown }).updateFeedUrl;
  const storedMode = storedUpdateValue("ronic.update.mode");
  const storedFeed = storedUpdateValue("ronic.update.feed");
  const channel: UpdateChannel = settings.updateChannel === "nightly" ? "nightly" : "stable";
  const mode: UpdateMode = rawMode === "manual" || rawMode === "auto" ? rawMode : storedMode === "manual" ? "manual" : "auto";
  return {
    ...settings,
    updateChannel: channel,
    updateMode: mode,
    updateFeedUrl: typeof rawFeed === "string" ? rawFeed : storedFeed ?? "",
    updateNoticeVersion: typeof settings.updateNoticeVersion === "string" ? settings.updateNoticeVersion : "",
    version: settings.version || PRODUCT_VERSION,
    availableVersion: settings.availableVersion || settings.version || PRODUCT_VERSION,
  };
}

export function rememberUpdatePrefs(settings: Settings) {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem("ronic.update.mode", settings.updateMode === "manual" ? "manual" : "auto");
    localStorage.setItem("ronic.update.feed", settings.updateFeedUrl ?? "");
  } catch {
    /* The kernel copy is still saved when storage is blocked. */
  }
}

export function feedAddress(raw: string): { url: string; error: string | null } {
  const url = raw.trim();
  if (!url) return { url: "", error: null };
  if (!url.startsWith("https://") || url.length > 500 || /\s/.test(url)) {
    return { url: "", error: "The feed address has to start with https://." };
  }
  return { url, error: null };
}

function cleanVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const version = value.trim().replace(/^v/i, "");
  return versionParts(version) ? version : null;
}

function versionParts(version: string): number[] | null {
  const cleaned = version.trim().replace(/^v/i, "");
  if (!/^\d+(\.\d+){0,3}$/.test(cleaned)) return null;
  return cleaned.split(".").map((part) => Number(part));
}

function releaseList(data: unknown): unknown[] | null {
  if (Array.isArray(data)) return data;
  if (!isRecord(data)) return null;
  if (Array.isArray(data.releases)) return data.releases;
  if (typeof data.version === "string") return [data];
  return null;
}

function normalizeRelease(item: unknown, source: string, fallbackChannel: string): ProductRelease | null {
  if (!isRecord(item)) return null;
  const version = cleanVersion(item.version);
  if (!version) return null;
  const channel = releaseChannel(typeof item.channel === "string" ? item.channel : fallbackChannel);
  if (!channel) return null;
  const notes = clip(item.notes, 800);
  const summary = clip(item.summary, 280) || clip(notes, 280);
  const changes = normalizeChanges(item.changes, notes, summary);
  const published = clip(item.published, 40) || clip(item.pub_date, 40);
  return {
    version,
    channel,
    published,
    summary,
    downloadUrl: httpsUrl(item.downloadUrl) || httpsUrl(item.url),
    changes,
    source,
  };
}

function normalizeChanges(value: unknown, notes: string, summary: string): ReleaseChange[] {
  const changes: ReleaseChange[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!isRecord(item)) continue;
      const title = clip(item.title, 140);
      const detail = clip(item.detail, 800);
      if (!title && !detail) continue;
      changes.push({ kind: changeKind(item.kind), title: title || detail, detail: title ? detail : "" });
      if (changes.length >= MAX_CHANGES) break;
    }
  }
  if (changes.length === 0 && notes) {
    changes.push({ kind: "change", title: summary || "Release notes", detail: notes });
  }
  return changes;
}

function releaseChannel(value: string): ReleaseChannel | null {
  const raw = value.trim().toLowerCase();
  if (!raw || raw === "any" || raw === "all") return "any";
  if (raw === "stable" || raw === "nightly") return raw;
  return null;
}

function changeKind(value: unknown): ChangeKind {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (raw === "feature" || raw === "new") return "feature";
  if (raw === "fix" || raw === "fixed" || raw === "bug") return "fix";
  return "change";
}

function httpsUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  const url = value.trim();
  if (!url.startsWith("https://") || url.length > 500 || /\s/.test(url)) return "";
  return url;
}

function clip(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const text = value.trim().replace(/\s+/g, " ");
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
