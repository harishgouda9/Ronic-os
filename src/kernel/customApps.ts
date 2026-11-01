import type { WebApp } from "./liveChat";

const KEY = "ronic.customApps.v1";
const CAP = 24;
const ID_RE = /^custom_[A-Za-z0-9_-]{1,40}$/;

export type CustomApp = {
  id: string;
  name: string;
  kind: "web" | "desktop";
  url: string;
  path: string;
};

export function clipName(name: string) {
  const cleaned = name.replace(/[\u0000-\u001f]/g, "").trim();
  return Array.from(cleaned).slice(0, 32).join("");
}

function withWebScheme(raw: string) {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) return raw;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:[^0-9/]/.test(raw)) return raw;
  const bare = raw.replace(/^\/+/, "");
  let host = "";
  try {
    host = new URL(`http://${bare}`).hostname.toLowerCase();
  } catch {
    return `https://${bare}`;
  }
  const local = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  return `${local ? "http" : "https"}://${bare}`;
}

export function validWebUrl(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2000 || /[\s\u0000-\u001f]/.test(trimmed)) return "";
  let url: URL;
  try {
    url = new URL(withWebScheme(trimmed));
  } catch {
    return "";
  }
  if (url.username || url.password || !url.hostname) return "";
  const host = url.hostname.toLowerCase();
  const local = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  if (url.protocol === "https:") return url.toString();
  if (url.protocol === "http:" && local) return url.toString();
  return "";
}

export function newCustomId(kind: "web" | "desktop") {
  const stamp = Date.now().toString(16);
  const rand = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0");
  const body = `${kind === "web" ? "w" : "d"}${stamp}${rand}`.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
  return `custom_${body}`;
}

export function customAsWebApp(app: CustomApp): WebApp {
  const letters = Array.from(app.name.replace(/[^A-Za-z0-9]/g, "")).slice(0, 2).join("").toUpperCase() || "AP";
  return {
    id: app.id,
    name: app.name,
    url: app.kind === "web" ? app.url : "",
    mark: letters,
    providerId: "",
    path: app.path,
    custom: true,
  };
}

export function readCustomApps(): CustomApp[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    const apps: CustomApp[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const row = item as Partial<CustomApp>;
      if (typeof row.id !== "string" || !ID_RE.test(row.id)) continue;
      if (row.kind !== "web" && row.kind !== "desktop") continue;
      const name = clipName(typeof row.name === "string" ? row.name : "");
      if (!name) continue;
      if (row.kind === "web") {
        const url = typeof row.url === "string" ? validWebUrl(row.url) : "";
        if (!url) continue;
        apps.push({ id: row.id, name, kind: "web", url, path: "" });
      } else {
        const path = typeof row.path === "string" ? row.path.trim() : "";
        if (!path || path.length > 1024 || /[\u0000-\u001f]/.test(path)) continue;
        apps.push({ id: row.id, name, kind: "desktop", url: "", path });
      }
      if (apps.length >= CAP) break;
    }
    return apps;
  } catch {
    return [];
  }
}

export function writeCustomApps(apps: CustomApp[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(apps.slice(0, CAP)));
  } catch {
    /* the in-memory list still shows for this visit */
  }
}

const HIDDEN_KEY = "ronic.hiddenApps.v1";

export function readHiddenApps(): string[] {
  try {
    const raw = localStorage.getItem(HIDDEN_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string" && id.length > 0);
  } catch {
    return [];
  }
}

export function writeHiddenApps(ids: string[]) {
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify(ids));
  } catch {
    /* the in-memory list still shows for this visit */
  }
}
