import { allowedUpstream, doorEnv, sameSecret } from "./_lib/edge.mjs";

export default async function handler(req, res) {
  try {
    await register(req, res);
  } catch {
    if (!res.headersSent) send(res, 500, { error: "door failed" });
  }
}

async function register(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "use POST" });
  let body;
  try {
    const raw = await readRaw(req);
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return send(res, 400, { error: "rejected" });
  }
  const env = doorEnv();
  if (!env) return send(res, 503, { error: "door is not configured" });
  const upstream = typeof body?.upstream === "string" ? body.upstream.replace(/\/$/, "") : "";
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  const secret = typeof body?.secret === "string" ? body.secret : "";
  if (!sameSecret(env.secret, secret)) return send(res, 401, { error: "rejected" });
  if (!allowedUpstream(upstream) || !/^[0-9a-fA-F]{64}$/.test(token)) return send(res, 400, { error: "rejected" });
  const looked = await fetch(`${env.url}/rest/v1/rpc/set_mcp_edge`, {
    method: "POST",
    headers: { apikey: env.key, authorization: `Bearer ${env.key}`, "content-type": "application/json" },
    body: JSON.stringify({ p_upstream: upstream, p_token: token }),
  });
  if (!looked.ok) return send(res, 503, { error: "door rejected the tunnel" });
  return send(res, 200, { ok: true });
}

async function readRaw(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}
