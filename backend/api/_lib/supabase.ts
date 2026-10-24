// Service-role Supabase access over REST. The desktop never holds these
// keys — only this server does.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

export function serviceConfigured(): boolean {
  return Boolean(SUPABASE_URL && SERVICE_KEY);
}

function headers(): Record<string, string> {
  return {
    apikey: SERVICE_KEY,
    authorization: `Bearer ${SERVICE_KEY}`,
    "content-type": "application/json",
  };
}

export async function rpc<T>(name: string, params: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(params),
  });
  const text = await res.text();
  if (!res.ok) {
    // PostgRAISE exceptions land here as {code, message}; surface the code so
    // callers can branch on FOUNDER_POOL_EXHAUSTED / DEVICE_LIMIT / WALLET_*.
    let code = "RPC_FAILED";
    let message = text;
    try {
      const parsed = JSON.parse(text) as { code?: string; message?: string };
      code = parsed.code ?? code;
      message = parsed.message ?? message;
    } catch {
      /* non-JSON error body */
    }
    const error = new Error(message) as Error & { pgCode?: string };
    error.pgCode = code;
    throw error;
  }
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

export async function selectOne<T>(table: string, query: string): Promise<T | null> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    headers: { ...headers(), accept: "application/json" },
  });
  if (!res.ok) return null;
  const rows = (await res.json()) as T[];
  return rows.length > 0 ? rows[0] : null;
}

// Verify a caller's Supabase JWT and return the user id. Uses GoTrue with the
// caller's own token — the service key never leaves the server.
export async function userIdFromToken(token: string): Promise<string | null> {
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY ?? "";
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: anonKey, authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const user = (await res.json()) as { id?: string };
  return user.id ?? null;
}

// Idempotency gate: returns true when this provider event is new work.
export async function claimBillingEvent(provider: string, eventId: string): Promise<boolean> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/billing_events`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ provider, event_id: eventId }),
  });
  if (res.ok) return true;
  // 409/23505 means the row exists — already processed.
  if (res.status === 409) return false;
  const text = await res.text();
  if (/23505|unique/i.test(text)) return false;
  throw new Error(`billing_events insert failed: ${res.status} ${text}`);
}
