// Supabase Edge Function: license-lease
//
// Signs the 7-day offline license lease described in the Ronic OS blueprint:
//   lease = {"user_id","tier","hardware_hash","max_devices","iat_unix","exp_unix"}
//   sig   = Ed25519(lease UTF-8 bytes) with RONIC_ED25519_PRIVATE_KEY
//
// The desktop embeds only the PUBLIC key and verifies this locally, so paying
// users keep full access for 7 days with no cloud call on startup.
//
// Env (supabase secrets):
//   RONIC_ED25519_PRIVATE_KEY  JWK JSON: {"kty":"OKP","crv":"Ed25519","d":...,"x":...}
//   SUPABASE_URL               auto-provided by the platform
//   SUPABASE_ANON_KEY          auto-provided
//   SUPABASE_SERVICE_ROLE_KEY  auto-provided
//
// Request:
//   GET /functions/v1/license-lease?hardware_hash=<sha256>
//   Authorization: Bearer <user access token>
//
// Response: { lease, leaseSig, tier, founderBadge, walletMicroUsd }
// Errors: 401 unauthenticated, 403 device not registered.

const SERVICE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const LEASE_DAYS = 7;

function b64encode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function json(req: unknown, status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...((req as Request).method === "OPTIONS" ? { "access-control-allow-headers": "authorization, content-type" } : {}),
    },
  });
}

async function rest<T>(path: string): Promise<T | null> {
  const res = await fetch(`${SERVICE_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}`, accept: "application/json" },
  });
  if (!res.ok) return null;
  const rows = (await res.json()) as T[];
  return rows.length > 0 ? rows[0] : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "access-control-allow-headers": "authorization, content-type" } });
  if (req.method !== "GET") return json(req, 405, { error: "GET only" });

  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token || !SERVICE_KEY) return json(req, 401, { error: "missing token" });

  // 1. Who is calling (GoTrue verifies the JWT).
  const me = await fetch(`${SERVICE_URL}/auth/v1/user`, {
    headers: { apikey: ANON_KEY, authorization: `Bearer ${token}` },
  });
  if (!me.ok) return json(req, 401, { error: "invalid session" });
  const user = (await me.json()) as { id: string };

  const hardwareHash = new URL(req.url).searchParams.get("hardware_hash") ?? "";
  if (!/^[0-9a-f]{64}$/.test(hardwareHash)) return json(req, 400, { error: "bad hardware_hash" });

  // 2. License row + this machine's seat + badge + wallet.
  const license = await rest<{ plan_tier: string; max_devices: number; status: string }>(
    `licenses?user_id=eq.${user.id}&select=plan_tier,max_devices,status`,
  );
  if (!license) return json(req, 404, { error: "no license row" });

  const seat = await rest<{ id: string }>(
    `device_activations?user_id=eq.${user.id}&hardware_hash=eq.${hardwareHash}&select=id`,
  );
  if (!seat) return json(req, 403, { error: "device_not_registered" });

  const profile = await rest<{ founder_badge_number: number | null }>(
    `profiles?id=eq.${user.id}&select=founder_badge_number`,
  );
  const wallet = await rest<{ balance_micro_usd: number }>(
    `compute_wallets?user_id=eq.${user.id}&select=balance_micro_usd`,
  );

  // 3. Sign the lease. Field order is fixed and must match the Rust verifier
  // byte-for-byte; build the string explicitly instead of JSON.stringify.
  const tier = license.status === "active" ? license.plan_tier : "free";
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + LEASE_DAYS * 86_400;
  const lease = `{"user_id":"${user.id}","tier":"${tier}","hardware_hash":"${hardwareHash}","max_devices":${license.max_devices},"iat_unix":${iat},"exp_unix":${exp}}`;

  const jwkText = Deno.env.get("RONIC_ED25519_PRIVATE_KEY") ?? "";
  if (!jwkText) return json(req, 500, { error: "signing key not configured" });
  let privateKey: CryptoKey;
  try {
    privateKey = await crypto.subtle.importKey("jwk", JSON.parse(jwkText), { name: "Ed25519" }, false, ["sign"]);
  } catch {
    return json(req, 500, { error: "signing key is not a valid Ed25519 JWK" });
  }
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, privateKey, new TextEncoder().encode(lease));

  return json(req, 200, {
    lease,
    leaseSig: b64encode(new Uint8Array(sig)),
    tier,
    founderBadge: profile?.founder_badge_number ?? null,
    walletMicroUsd: wallet?.balance_micro_usd ?? 0,
    expUnix: exp,
  });
});
