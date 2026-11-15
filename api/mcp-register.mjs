import { allowedUpstream, doorEnv, sameSecret } from "./_lib/edge.mjs";

export default async function handler(request) {
  if (request.method !== "POST") return json(405, { error: "use POST" });
  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "rejected" });
  }
  const env = doorEnv();
  if (!env) return json(503, { error: "door is not configured" });
  const upstream = typeof body?.upstream === "string" ? body.upstream.replace(/\/$/, "") : "";
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  const secret = typeof body?.secret === "string" ? body.secret : "";
  if (!sameSecret(env.secret, secret)) return json(401, { error: "rejected" });
  if (!allowedUpstream(upstream) || !/^[0-9a-fA-F]{64}$/.test(token)) return json(400, { error: "rejected" });
  const res = await fetch(`${env.url}/rest/v1/rpc/set_mcp_edge`, {
    method: "POST",
    headers: { apikey: env.key, authorization: `Bearer ${env.key}`, "content-type": "application/json" },
    body: JSON.stringify({ p_upstream: upstream, p_token: token }),
  });
  if (!res.ok) return json(503, { error: "door rejected the tunnel" });
  return json(200, { ok: true });
}

function json(status, body) {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}
