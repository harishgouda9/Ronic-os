import { request as upstreamRequest } from "node:undici";
import { allowedUpstream, doorEnv, targetUrl } from "./_lib/edge.mjs";

const DOOR = "ronicos.vercel.app";
const HOP = new Set([
  "host", "connection", "content-length", "transfer-encoding", "keep-alive",
  "upgrade", "te", "trailer", "expect", "x-forwarded-host", "x-forwarded-proto", "x-ronic-door",
]);
const PASS = ["content-type", "www-authenticate", "location", "cache-control", "access-control-expose-headers", "mcp-session-id", "allow"];

// shortcut: duration is the plan default, raise maxDuration when a tool call is cut off.
export default async function handler(request) {
  const env = doorEnv();
  if (!env) return json(503, { error: "door is not configured" });
  const looked = await fetch(`${env.url}/rest/v1/rpc/mcp_edge_upstream`, {
    method: "POST",
    headers: { apikey: env.key, authorization: `Bearer ${env.key}`, "content-type": "application/json" },
    body: "{}",
  });
  if (!looked.ok) return json(503, { error: "door rejected the tunnel" });
  const upstream = await looked.json();
  if (!allowedUpstream(upstream)) return json(503, { error: "this computer is not connected" });
  const target = targetUrl(upstream, request.url);
  if (!target) return json(400, { error: "bad path" });
  const method = request.method || "GET";
  const headers = {};
  for (const [key, value] of request.headers) {
    const name = key.toLowerCase();
    if (HOP.has(name) || name.startsWith("x-vercel-")) continue;
    headers[key] = value;
  }
  headers["x-forwarded-host"] = DOOR;
  headers["x-forwarded-proto"] = "https";
  headers["x-ronic-door"] = DOOR;
  let body;
  if (method !== "GET" && method !== "HEAD") {
    body = Buffer.from(await request.arrayBuffer());
    if (body.length > 1_000_000) return json(413, { error: "body too large" });
  }
  let upstreamRes;
  try {
    upstreamRes = await upstreamRequest(target, { method, headers, body, maxRedirections: 0 });
  } catch {
    return json(502, { error: "the computer tunnel did not answer" });
  }
  const out = new Headers();
  for (const name of PASS) {
    const value = oneHeader(upstreamRes.headers[name]);
    if (value && value.length < 8000 && !/[\r\n]/.test(value)) out.set(name, value);
  }
  out.set("cache-control", "no-store");
  const chunks = [];
  let total = 0;
  for await (const chunk of upstreamRes.body) {
    total += chunk.length;
    if (total > 4_000_000) return json(502, { error: "upstream response is too large" });
    chunks.push(chunk);
  }
  return new Response(Buffer.concat(chunks), { status: upstreamRes.statusCode, headers: out });
}

function oneHeader(value) {
  if (Array.isArray(value)) return value[0] || "";
  return typeof value === "string" ? value : "";
}

function json(status, body) {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}
