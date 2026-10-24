// Ghost runner orchestration surface (blueprint §6.3).
//
// GET  — list this user's cloud runners (Supabase rows).
// POST — queue a runner. The Firecracker/Hetzner worker cluster is a separate
//        deployment; until GHOST_CLUSTER_URL is configured this answers 501
//        honestly instead of queueing work nothing will execute.

import { bad, json } from "../_lib/http";
import { serviceConfigured, userIdFromToken } from "../_lib/supabase";

export default async function handler(request: Request): Promise<Response> {
  if (!serviceConfigured()) return bad("supabase service role not configured", 503);

  const token = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const userId = token ? await userIdFromToken(token) : null;
  if (!userId) return bad("sign in first", 401);

  if (request.method === "GET") {
    const url = `${process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL}/rest/v1/ghost_runners?user_id=eq.${userId}&select=*`;
    const res = await fetch(url, {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
        authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY ?? ""}`,
        accept: "application/json",
      },
    });
    const rows = res.ok ? await res.json() : [];
    return json(200, { runners: rows });
  }

  if (request.method === "POST") {
    const cluster = process.env.GHOST_CLUSTER_URL ?? "";
    if (!cluster) {
      return json(501, {
        error: "GHOST_CLUSTER_NOT_CONFIGURED",
        message: "The 24/7 cloud runner cluster is not deployed yet. Billing tables and this API are ready; the Firecracker worker deployment is a launch step.",
      });
    }
    const body = (await request.json().catch(() => ({}))) as { botHandle?: string; region?: string };
    if (!body.botHandle?.trim()) return bad("botHandle is required");
    // Dispatch contract with the worker cluster (signed job envelope) — the
    // worker inserts the ghost_runners row and streams logs via Realtime.
    const res = await fetch(`${cluster.replace(/\/$/, "")}/runners`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cluster-secret": process.env.GHOST_CLUSTER_SECRET ?? "",
      },
      body: JSON.stringify({ userId, botHandle: body.botHandle.trim(), region: body.region ?? "eu-central" }),
    });
    if (!res.ok) return bad(`cluster refused the job (${res.status})`, 502);
    const created = (await res.json()) as Record<string, unknown>;
    return json(200, created);
  }

  return bad("GET or POST only", 405);
}
