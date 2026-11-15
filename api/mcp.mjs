import { allowedUpstream, doorEnv, targetUrl } from "./_lib/edge.mjs";

const DOOR = "ronicos.vercel.app";
const HOP = new Set([
  "host", "connection", "content-length", "transfer-encoding", "keep-alive",
  "upgrade", "te", "trailer", "expect", "x-forwarded-host", "x-forwarded-proto", "x-ronic-door",
]);
const PASS = ["content-type", "www-authenticate", "location", "cache-control", "access-control-expose-headers", "mcp-session-id", "allow"];

// shortcut: duration is the plan default, raise maxDuration when a tool call is cut off.
export default async function handler(req, res) {
  try {
    await proxy(req, res);
  } catch {
    if (!res.headersSent) send(res, 500, { error: "door failed" });
  }
}

async function proxy(req, res) {
  const env = doorEnv();
  if (!env) return send(res, 503, { error: "door is not configured" });
  const looked = await fetch(`${env.url}/rest/v1/rpc/mcp_edge_upstream`, {
    method: "POST",
    headers: { apikey: env.key, authorization: `Bearer ${env.key}`, "content-type": "application/json" },
    body: "{}",
  });
  if (!looked.ok) return send(res, 503, { error: "door rejected the tunnel" });
  const upstream = await looked.json();
  if (!allowedUpstream(upstream)) return send(res, 503, { error: "this computer is not connected" });
  const target = targetUrl(upstream, absoluteUrl(req));
  if (!target) return send(res, 400, { error: "bad path" });
  const method = req.method || "GET";
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const name = key.toLowerCase();
    if (HOP.has(name) || name.startsWith("x-vercel-")) continue;
    if (typeof value === "string") headers[key] = value;
  }
  headers["x-forwarded-host"] = DOOR;
  headers["x-forwarded-proto"] = "https";
  headers["x-ronic-door"] = DOOR;
  let body;
  if (method !== "GET" && method !== "HEAD") {
    body = await readRaw(req, 1_000_000);
    if (body === null) return send(res, 413, { error: "body too large" });
  }
  let upstreamRes;
  try {
    upstreamRes = await fetch(target, { method, headers, body, redirect: "manual" });
  } catch {
    return send(res, 502, { error: "the computer tunnel did not answer" });
  }
  res.statusCode = upstreamRes.status;
  for (const name of PASS) {
    const value = upstreamRes.headers.get(name) || "";
    if (value && value.length < 8000 && !/[\r\n]/.test(value)) res.setHeader(name, value);
  }
  res.setHeader("cache-control", "no-store");
  const raw = await readFetch(upstreamRes, 4_000_000);
  if (raw === null) return send(res, 502, { error: "upstream response is too large" });
  res.end(raw);
}

function absoluteUrl(req) {
  const host = header(req, "x-forwarded-host") || header(req, "host") || DOOR;
  const proto = header(req, "x-forwarded-proto") || "https";
  return `${proto}://${host}${req.url || "/"}`;
}

function header(req, name) {
  const value = req.headers[name];
  return typeof value === "string" ? value : "";
}

async function readRaw(req, limit) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > limit) return null;
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

async function readFetch(response, limit) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks);
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(Buffer.from(value));
  }
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}
