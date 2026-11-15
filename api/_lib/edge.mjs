import { timingSafeEqual } from "node:crypto";

const UPSTREAM = /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/;

const PATHS = new Set([
  "/mcp",
  "/authorize",
  "/token",
  "/register",
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-authorization-server/mcp",
  "/.well-known/openid-configuration",
]);

export function allowedUpstream(value) {
  return typeof value === "string" && UPSTREAM.test(value);
}

export function doorEnv() {
  const url = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "").replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!url || !key) return null;
  return { url, key, secret: process.env.MCP_DOOR_SECRET || "" };
}

/** The register call must present the Vercel secret. The bridge token is not that secret. */
export function sameSecret(expected, presented) {
  if (typeof expected !== "string" || typeof presented !== "string") return false;
  if (expected.length < 16 || expected.length > 200 || expected.length !== presented.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(presented));
}

export function targetUrl(upstream, requestUrl) {
  if (!allowedUpstream(upstream)) return null;
  let url;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  const path = url.searchParams.get("ronic_path") || "";
  if (!PATHS.has(path) || path.includes("..") || path.includes("\\")) return null;
  url.searchParams.delete("ronic_path");
  const query = url.searchParams.toString();
  return query ? `${upstream}${path}?${query}` : `${upstream}${path}`;
}
