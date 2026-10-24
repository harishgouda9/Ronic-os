import * as Sentry from "@sentry/react";
import posthog from "posthog-js";
import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";

export type StoreListing = {
  id: string;
  seller_id: string;
  kind: "skill" | "plugin" | "tool";
  title: string;
  blurb: string;
  price_cents: number;
  currency: string;
  status: string;
};

const url = String(import.meta.env.VITE_SUPABASE_URL ?? "").trim();
const anon = String(import.meta.env.VITE_SUPABASE_ANON_KEY ?? "").trim();
const sentryDsn = String(import.meta.env.VITE_SENTRY_DSN ?? "").trim();
const posthogKey = String(import.meta.env.VITE_POSTHOG_KEY ?? "").trim();
const posthogHost = String(import.meta.env.VITE_POSTHOG_HOST ?? "").trim() || "https://us.i.posthog.com";
const checkoutUrl = String(import.meta.env.VITE_STORE_CHECKOUT_URL ?? "").trim();
const leaseUrl = String(import.meta.env.VITE_LEASE_URL ?? "").trim();
const bounceUrl = String(import.meta.env.VITE_AUTH_BOUNCE_URL ?? "").trim() || "https://ronic.os/auth/bounce";
const checkoutApi = String(import.meta.env.VITE_CHECKOUT_API ?? "").trim();

export const cloudConfig = {
  supabase: Boolean(url && anon),
  sentry: Boolean(sentryDsn),
  posthog: Boolean(posthogKey),
  checkout: Boolean(checkoutUrl),
  lease: Boolean(leaseUrl),
  checkoutApi: Boolean(checkoutApi),
};

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return null;
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return await tauriInvoke<T>(cmd, args);
}

let client: SupabaseClient | null = null;
let session: Session | null = null;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((listener) => listener());
}

export function subscribeCloud(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function cloudSession() {
  return session;
}

export function supabase() {
  if (!cloudConfig.supabase) return null;
  if (!client) {
    client = createClient(url, anon, {
      auth: { persistSession: true, storageKey: "omni.supabase.auth" },
    });
  }
  return client;
}

export function startCloud() {
  if (sentryDsn) {
    Sentry.init({ dsn: sentryDsn, tracesSampleRate: 0 });
  }
  if (posthogKey) {
    posthog.init(posthogKey, { api_host: posthogHost, capture_pageview: false, persistence: "localStorage" });
  }
  const db = supabase();
  if (!db) return;
  void restoreFromKeychain().finally(() => {
    void db.auth.getSession().then(({ data }) => {
      session = data.session;
      emit();
    });
  });
  db.auth.onAuthStateChange((_event, next) => {
    session = next;
    if (next?.user && posthogKey) posthog.identify(next.user.id);
    // Mirror the refresh token into the OS keychain (Windows Credential
    // Manager / macOS Keychain). Fire-and-forget: a failed mirror must not
    // break the in-app session.
    if (next?.refresh_token) void invoke("cloud_keychain_store", { refreshToken: next.refresh_token }).catch(() => {});
    if (!next) void invoke("cloud_keychain_clear").catch(() => {});
    emit();
  });
}

// If the WebView lost its local session (cleared storage, new install), the
// refresh token in the OS keychain signs the user back in silently.
async function restoreFromKeychain() {
  const db = supabase();
  if (!db) return;
  const { data } = await db.auth.getSession();
  if (data.session) return;
  const token = await invoke<string>("cloud_keychain_restore").catch(() => null);
  if (!token) return;
  const { data: restored } = await db.auth.setSession({ access_token: token, refresh_token: token });
  if (!restored.session) {
    // Expired/revoked — drop the stale entry.
    void invoke("cloud_keychain_clear").catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Desktop OAuth PKCE (blueprint §3): system browser -> Supabase -> Vercel
// bounce -> ronic://auth/callback -> this webview completes the exchange.
// ---------------------------------------------------------------------------

const PKCE_VERIFIER_KEY = "omni.pkce.verifier";

function b64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function makePkcePair(): Promise<{ verifier: string; challenge: string }> {
  const raw = new Uint8Array(48);
  crypto.getRandomValues(raw);
  const verifier = b64url(raw);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(new Uint8Array(digest)) };
}

async function waitForAuthCode(timeoutMs: number): Promise<string> {
  const { listen } = await import("@tauri-apps/api/event");
  return new Promise<string>((resolve, reject) => {
    let done = false;
    let unlisten: (() => void) | null = null;
    const stop = () => {
      if (unlisten) unlisten();
    };
    const timer = window.setTimeout(() => {
      if (!done) {
        done = true;
        reject(new Error("The browser sign-in did not come back in time. Open Ronic OS and try again."));
        stop();
      }
    }, timeoutMs);
    void listen<string>("omni://auth-code", (event) => {
      if (done) return;
      const params = new URLSearchParams(event.payload ?? "");
      const code = params.get("code");
      const oauthError = params.get("error_description") ?? params.get("error");
      if (!code) {
        done = true;
        window.clearTimeout(timer);
        reject(new Error(oauthError || "The sign-in was canceled."));
        stop();
        return;
      }
      done = true;
      window.clearTimeout(timer);
      resolve(code);
      stop();
    }).then((fn) => {
      // If the wait already ended before the subscription landed, close it now.
      if (done) fn();
      else unlisten = fn;
    });
  });
}

export async function signInWithBrowser(provider: "github" | "google"): Promise<string> {
  const db = supabase();
  if (!db) return "Supabase is not configured.";
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    return "Browser sign-in needs the desktop app.";
  }
  const { verifier, challenge } = await makePkcePair();
  try {
    localStorage.setItem(PKCE_VERIFIER_KEY, verifier);
  } catch {
    /* private mode — the exchange below still works within this session */
  }

  const authorize = new URL(`${url}/auth/v1/authorize`);
  authorize.searchParams.set("provider", provider);
  authorize.searchParams.set("redirect_to", bounceUrl);
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "s256");

  await invoke<void>("open_system_url", { url: authorize.toString() });
  const code = await waitForAuthCode(5 * 60_000);

  // Raw PKCE exchange against GoTrue; supabase-js never sees the browser
  // window, so its stored verifier cannot exist — ours is the real one.
  const tokenRes = await fetch(`${url}/auth/v1/token?grant_type=pkce`, {
    method: "POST",
    headers: { apikey: anon, "content-type": "application/json" },
    body: JSON.stringify({ auth_code: code, code_verifier: verifier }),
  });
  try {
    localStorage.removeItem(PKCE_VERIFIER_KEY);
  } catch {
    /* ignore */
  }
  if (!tokenRes.ok) {
    const detail = (await tokenRes.json().catch(() => ({}))) as { error_description?: string; msg?: string };
    return detail.error_description || detail.msg || "The sign-in code could not be exchanged.";
  }
  const tokens = (await tokenRes.json()) as { access_token: string; refresh_token: string };
  const { error } = await db.auth.setSession({ access_token: tokens.access_token, refresh_token: tokens.refresh_token });
  return error ? error.message : "";
}

// ---------------------------------------------------------------------------
// Licensing, devices, wallet, checkout
// ---------------------------------------------------------------------------

export async function registerThisDevice(): Promise<string> {
  const db = supabase();
  const user = session?.user;
  if (!db || !user) return "Sign in first.";
  const print = await invoke<{ hardwareHash: string; deviceName: string; osPlatform: string }>("device_fingerprint");
  if (!print) return "Device registration needs the desktop app.";
  await db.rpc("ensure_user_rows", { p_user_id: user.id });
  const { error } = await db.rpc("register_device", {
    p_user_id: user.id,
    p_hardware_hash: print.hardwareHash,
    p_device_name: print.deviceName,
    p_os_platform: print.osPlatform,
  });
  if (error) {
    if (error.message.includes("DEVICE_LIMIT")) {
      const cap = error.message.split(":")[1] ?? "?";
      return `This plan allows ${cap} machine${cap === "1" ? "" : "s"}. Revoke an old device first.`;
    }
    return error.message;
  }
  return "";
}

export type DeviceRow = { id: string; hardware_hash: string; device_name: string; os_platform: string; last_seen_at: string };

export async function listDevices(): Promise<DeviceRow[]> {
  const db = supabase();
  const user = session?.user;
  if (!db || !user) return [];
  const { data } = await db.from("device_activations").select("id, hardware_hash, device_name, os_platform, last_seen_at").order("created_at", { ascending: true });
  return (data as DeviceRow[]) ?? [];
}

export async function revokeDevice(deviceId: string): Promise<string> {
  const db = supabase();
  const user = session?.user;
  if (!db || !user) return "Sign in first.";
  const { error } = await db.rpc("revoke_device", { p_user_id: user.id, p_device_id: deviceId });
  return error ? error.message : "";
}

/** Fetch and locally verify a fresh 7-day lease. Returns "" on success. */
export async function refreshLicense(): Promise<string> {
  if (!leaseUrl) return "The lease endpoint is not configured (VITE_LEASE_URL).";
  const token = session?.access_token;
  if (!token) return "Sign in first.";
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  try {
    await tauriInvoke("refresh_license", { leaseUrl, token });
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export type CheckoutStart =
  | { kind: "stripe"; url: string }
  | { kind: "razorpay"; orderId: string; keyId: string; amountPaise: number };

export async function startProductCheckout(product: "founder_pass" | "pro_monthly" | "pro_yearly", rail: "stripe" | "razorpay"): Promise<{ error?: string; checkout?: CheckoutStart }> {
  const token = session?.access_token;
  if (!token) return { error: "Sign in first." };
  if (!checkoutApi) return { error: "Checkout is not configured on this build (VITE_CHECKOUT_API)." };
  try {
    const res = await fetch(checkoutApi, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ product, rail }),
    });
    const payload = (await res.json()) as { url?: string; orderId?: string; keyId?: string; amountPaise?: number; error?: string };
    if (!res.ok) return { error: payload.error ?? "Checkout did not start." };
    if (payload.url) return { checkout: { kind: "stripe", url: payload.url } };
    if (payload.orderId && payload.keyId) {
      return { checkout: { kind: "razorpay", orderId: payload.orderId, keyId: payload.keyId, amountPaise: payload.amountPaise ?? 0 } };
    }
    return { error: "Checkout returned no payment page." };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export async function signIn(email: string, password: string) {
  const db = supabase();
  if (!db) return "Supabase is not configured.";
  const { error } = await db.auth.signInWithPassword({ email: email.trim(), password });
  return error ? error.message : "";
}

export async function signUp(email: string, password: string, displayName: string) {
  const db = supabase();
  if (!db) return "Supabase is not configured.";
  const { error } = await db.auth.signUp({
    email: email.trim(),
    password,
    options: { data: { display_name: displayName.trim() } },
  });
  return error ? error.message : "";
}

export async function signOut() {
  const db = supabase();
  if (!db) return;
  await db.auth.signOut();
  void invoke("cloud_keychain_clear").catch(() => {});
  if (posthogKey) posthog.reset();
}

export async function saveDisplayName(displayName: string) {
  const db = supabase();
  const user = session?.user;
  if (!db || !user) return "Sign in first.";
  const name = displayName.trim();
  if (!name) return "Enter a name.";
  const { error } = await db.from("profiles").update({ display_name: name }).eq("id", user.id);
  if (error) return error.message;
  await db.auth.updateUser({ data: { display_name: name } });
  return "";
}

export async function listListings(): Promise<StoreListing[]> {
  const db = supabase();
  if (!db) return [];
  const { data, error } = await db
    .from("listings")
    .select("id, seller_id, kind, title, blurb, price_cents, currency, status")
    .eq("status", "listed")
    .order("created_at", { ascending: false })
    .limit(60);
  if (error || !data) return [];
  return data as StoreListing[];
}

export async function listMyListings(): Promise<StoreListing[]> {
  const db = supabase();
  const user = session?.user;
  if (!db || !user) return [];
  const { data, error } = await db
    .from("listings")
    .select("id, seller_id, kind, title, blurb, price_cents, currency, status")
    .eq("seller_id", user.id)
    .order("created_at", { ascending: false })
    .limit(40);
  if (error || !data) return [];
  return data as StoreListing[];
}

export async function createListing(input: { kind: StoreListing["kind"]; title: string; blurb: string; priceCents: number; body: string }) {
  const db = supabase();
  const user = session?.user;
  if (!db || !user) return "Sign in before listing a pack.";
  const { data, error } = await db
    .from("listings")
    .insert({
      seller_id: user.id,
      kind: input.kind,
      title: input.title.trim(),
      blurb: input.blurb.trim(),
      price_cents: input.priceCents,
      currency: "usd",
      status: "review",
    })
    .select("id")
    .single();
  if (error || !data) return error?.message || "The listing was not saved.";
  const body = input.body.trim();
  if (body) {
    const pack = await db.from("listing_packs").insert({ listing_id: data.id, body });
    if (pack.error) return pack.error.message;
  }
  return "";
}

export async function startCheckout(listingId: string) {
  const db = supabase();
  if (!db || !session) return "Sign in before buying.";
  if (!checkoutUrl) return "Checkout is not configured. No charge was made.";
  const response = await fetch(checkoutUrl, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify({ listingId }),
  });
  if (!response.ok) return "Checkout did not start. No charge was made.";
  const payload = (await response.json()) as { url?: string };
  if (!payload.url) return "Checkout did not return a payment page. No charge was made.";
  window.open(payload.url, "_blank", "noopener");
  return "";
}

export async function paidPack(listingId: string) {
  const db = supabase();
  if (!db || !session) return "";
  const { data, error } = await db.rpc("listing_body", { listing: listingId });
  if (error || typeof data !== "string") return "";
  return data;
}
