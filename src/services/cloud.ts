import * as Sentry from "@sentry/react";
import posthog from "posthog-js";
import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import { classifySignup, parseAuthCallback, type SignUpResult } from "./accountAuth";

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
let passwordRecovery = false;
let authNotice = "";
let authSeq = 0;
let completedAuthSeq = 0;
let completedAuthMessage = "";
let memoryVerifier = "";
let ensuredFor = "";
let ensurePromise: Promise<void> | null = null;
const seenAuth = new Set<string>();
let pendingAuth: { resolve: (message: string) => void; timer: number } | null = null;
let authHooksStarted = false;
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

export function passwordRecoveryPending() {
  return passwordRecovery;
}

export function cloudAuthNotice() {
  return authNotice;
}

export function supabase() {
  if (!cloudConfig.supabase) return null;
  if (!client) {
    client = createClient(url, anon, {
      auth: { persistSession: true, storageKey: "ronic.supabase.auth" },
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
  startAuthHooks();
  void restoreFromKeychain().finally(() => {
    void db.auth.getSession().then(({ data }) => {
      session = data.session;
      emit();
      void pullPendingAuth();
    });
  });
  db.auth.onAuthStateChange((event, next) => {
    session = next;
    if (next?.user && posthogKey) posthog.identify(next.user.id);
    // Mirror the refresh token into the OS keychain (Windows Credential
    // Manager / macOS Keychain). Fire-and-forget: a failed mirror must not
    // break the in-app session.
    if (next?.refresh_token) void invoke("cloud_keychain_store", { refreshToken: next.refresh_token }).catch(() => {});
    if (!next) {
      passwordRecovery = false;
      void invoke("cloud_keychain_clear").catch(() => {});
    }
    if (next?.user && (event === "SIGNED_IN" || event === "INITIAL_SESSION" || event === "PASSWORD_RECOVERY")) {
      if (event === "PASSWORD_RECOVERY") passwordRecovery = true;
      void ensureAccountRows(next.user.id);
    }
    emit();
  });
}

function ensureAccountRows(userId: string): Promise<void> {
  if (ensuredFor === userId) return Promise.resolve();
  if (ensurePromise) return ensurePromise;
  ensurePromise = (async () => {
    const db = supabase();
    if (!db) return;
    const { error } = await db.rpc("ensure_user_rows", { p_user_id: userId });
    if (!error) ensuredFor = userId;
  })().finally(() => {
    ensurePromise = null;
  });
  return ensurePromise;
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
  // The keychain holds the refresh token only. setSession would treat it as
  // an access token, fail, and wipe a still-valid login.
  const { data: restored, error } = await db.auth.refreshSession({ refresh_token: token });
  if (error || !restored.session) {
    void invoke("cloud_keychain_clear").catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Desktop OAuth PKCE (blueprint §3): system browser -> Supabase -> Vercel
// bounce -> ronic://auth/callback -> this webview completes the exchange.
// ---------------------------------------------------------------------------

const PKCE_VERIFIER_KEY = "ronic.pkce.verifier";

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

function settleAuthWait(message: string) {
  const pending = pendingAuth;
  if (!pending) return;
  pendingAuth = null;
  window.clearTimeout(pending.timer);
  pending.resolve(message);
}

function clearCustomVerifier() {
  memoryVerifier = "";
  try {
    localStorage.removeItem(PKCE_VERIFIER_KEY);
  } catch {
    /* ignore */
  }
}

function takeCustomVerifier(): string {
  const fromMemory = memoryVerifier;
  clearCustomVerifier();
  return fromMemory;
}

function startAuthHooks() {
  if (authHooksStarted || typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
  authHooksStarted = true;
  void import("@tauri-apps/api/event").then(({ listen }) => {
    void listen<string>("ronic://auth-code", (event) => {
      void acceptAuthQuery(String(event.payload ?? ""));
    });
  });
}

async function pullPendingAuth() {
  const query = await invoke<string | null>("take_auth_callback").catch(() => null);
  if (query) void acceptAuthQuery(query);
}

async function exchangeCustomCode(code: string, verifier: string): Promise<string> {
  const db = supabase();
  if (!db) return "Supabase is not configured.";
  const tokenRes = await fetch(`${url}/auth/v1/token?grant_type=pkce`, {
    method: "POST",
    headers: { apikey: anon, "content-type": "application/json" },
    body: JSON.stringify({ auth_code: code, code_verifier: verifier }),
  });
  if (!tokenRes.ok) {
    const detail = (await tokenRes.json().catch(() => ({}))) as { error_description?: string; msg?: string };
    return detail.error_description || detail.msg || "The sign-in code could not be exchanged.";
  }
  const tokens = (await tokenRes.json()) as { access_token: string; refresh_token: string };
  const { error } = await db.auth.setSession({ access_token: tokens.access_token, refresh_token: tokens.refresh_token });
  return error ? error.message : "";
}

async function completeAuthCallback(raw: string): Promise<string> {
  const db = supabase();
  if (!db) return "Supabase is not configured.";
  const parsed = parseAuthCallback(raw);
  if (parsed.kind === "empty") return "The sign-in was canceled.";
  if (parsed.kind === "error") return parsed.message;
  if (parsed.kind === "session") {
    if (parsed.recovery) passwordRecovery = true;
    const { error } = await db.auth.setSession({ access_token: parsed.accessToken, refresh_token: parsed.refreshToken });
    return error ? error.message : "";
  }
  // Browser OAuth stores its own verifier. Email confirm and password reset
  // use the verifier supabase-js stored for this webview.
  if (memoryVerifier) return exchangeCustomCode(parsed.code, takeCustomVerifier());
  // A recovery code emits PASSWORD_RECOVERY before this promise resolves.
  const exchanged = await db.auth.exchangeCodeForSession(parsed.code);
  return exchanged.error ? exchanged.error.message : "";
}

async function acceptAuthQuery(raw: string) {
  const key = raw.trim();
  if (!key) {
    authNotice = "The sign-in was canceled.";
    emit();
    settleAuthWait(authNotice);
    return;
  }
  if (seenAuth.has(key)) return;
  seenAuth.add(key);
  const message = await completeAuthCallback(key);
  completedAuthSeq = authSeq;
  completedAuthMessage = message;
  authNotice = message;
  emit();
  settleAuthWait(message);
}

export async function signInWithBrowser(provider: "github" | "google"): Promise<string> {
  const db = supabase();
  if (!db) return "Supabase is not configured.";
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    return "Browser sign-in needs the desktop app.";
  }
  const { verifier, challenge } = await makePkcePair();
  memoryVerifier = verifier;
  try {
    localStorage.setItem(PKCE_VERIFIER_KEY, verifier);
  } catch {
    /* private mode — the exchange below still uses memoryVerifier */
  }
  const attempt = ++authSeq;
  const authorize = new URL(`${url}/auth/v1/authorize`);
  authorize.searchParams.set("provider", provider);
  authorize.searchParams.set("redirect_to", bounceUrl);
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "s256");
  try {
    await invoke<void>("open_system_url", { url: authorize.toString() });
  } catch (error) {
    clearCustomVerifier();
    return error instanceof Error ? error.message : String(error);
  }
  if (completedAuthSeq === attempt) return completedAuthMessage;
  return new Promise<string>((resolve) => {
    const timer = window.setTimeout(() => {
      if (pendingAuth?.resolve !== resolve) return;
      pendingAuth = null;
      clearCustomVerifier();
      resolve("The browser sign-in did not come back in time. Open Ronic OS and try again.");
    }, 5 * 60_000);
    pendingAuth = { resolve, timer };
  });
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
  authNotice = "";
  const { error } = await db.auth.signInWithPassword({ email: email.trim(), password });
  return error ? error.message : "";
}

export async function signUp(email: string, password: string, displayName: string): Promise<SignUpResult> {
  const db = supabase();
  if (!db) return { status: "error", message: "Supabase is not configured." };
  const name = displayName.trim();
  authNotice = "";
  const { data, error } = await db.auth.signUp({
    email: email.trim(),
    password,
    options: {
      data: { display_name: name, full_name: name },
      emailRedirectTo: bounceUrl,
    },
  });
  return classifySignup({
    errorMessage: error?.message,
    hasSession: Boolean(data.session),
    identityCount: data.user?.identities ? data.user.identities.length : null,
  });
}

export async function signOut() {
  const db = supabase();
  passwordRecovery = false;
  if (!db) return;
  await db.auth.signOut();
  void invoke("cloud_keychain_clear").catch(() => {});
  if (posthogKey) posthog.reset();
}

export async function loadAccountProfile(): Promise<{ email: string; displayName: string } | null> {
  const db = supabase();
  const user = session?.user;
  if (!db || !user) return null;
  const { data, error } = await db.from("profiles").select("email, full_name").eq("id", user.id).maybeSingle();
  if (error || !data) return null;
  const row = data as { email?: string; full_name?: string };
  return {
    email: String(row.email || user.email || ""),
    displayName: String(row.full_name || ""),
  };
}

export async function saveDisplayName(displayName: string) {
  const db = supabase();
  const user = session?.user;
  if (!db || !user) return "Sign in first.";
  const name = displayName.trim();
  if (!name) return "Enter a name.";
  await ensureAccountRows(user.id);
  let { data, error } = await db.from("profiles").update({ full_name: name }).eq("id", user.id).select("id");
  if (!error && (!data || data.length === 0)) {
    ensuredFor = "";
    await ensureAccountRows(user.id);
    ({ data, error } = await db.from("profiles").update({ full_name: name }).eq("id", user.id).select("id"));
  }
  if (error) return error.message;
  if (!data || data.length === 0) return "The profile row is missing. Re-run supabase/schema.sql in the Supabase SQL editor, then try again.";
  const updated = await db.auth.updateUser({ data: { display_name: name, full_name: name } });
  return updated.error ? updated.error.message : "";
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


// ---------------------------------------------------------------------------
// Ronic OS Profile & Cloud VPS Management
// ---------------------------------------------------------------------------

export interface RonicUserProfile {
  id: string;
  email: string;
  displayName: string;
  role: string;
  avatarUrl?: string;
  tier: "Free Community" | "Pro Studio" | "Enterprise VPS";
  createdAt: number;
  lastLoginAt: number;
  cloudSyncEnabled: boolean;
  cloudProvider: "supabase" | "self_hosted_vps" | "local_only";
  vpsNodeUrl?: string;
  vpsNodeToken?: string;
  vpsConnected?: boolean;
}

const PROFILE_KEY = "ronic.profile.user";
const VPS_KEY = "ronic.vps.node";

function blankProfile(id?: string): RonicUserProfile {
  return {
    id: id || "usr_" + Math.random().toString(36).slice(2, 10),
    email: "",
    displayName: "Workspace Operator",
    role: "Local Developer",
    tier: "Free Community",
    createdAt: Date.now(),
    lastLoginAt: Date.now(),
    cloudSyncEnabled: false,
    cloudProvider: "local_only",
  };
}

export function getLocalProfile(): RonicUserProfile {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<RonicUserProfile> | null;
      if (parsed && typeof parsed === "object") {
        const id = typeof parsed.id === "string" && parsed.id ? parsed.id : blankProfile().id;
        const base = blankProfile(id);
        const profile = { ...base, ...parsed, id, tier: parsed.tier || base.tier };
        if (parsed.id !== id) {
          try {
            localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
          } catch {}
        }
        return profile;
      }
    }
  } catch {}
  const created = blankProfile();
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(created));
  } catch {}
  return created;
}

export function saveLocalProfile(patch: Partial<RonicUserProfile>): RonicUserProfile {
  const current = getLocalProfile();
  const updated: RonicUserProfile = { ...current, ...patch };
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(updated));
  } catch {}
  emit();
  return updated;
}

export function clearLocalProfile(): void {
  try {
    localStorage.removeItem(PROFILE_KEY);
  } catch {}
  emit();
}

export function getStoredVpsNode(): { url: string; token: string; label: string; connected: boolean; lastPing?: number } | null {
  try {
    const raw = localStorage.getItem(VPS_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return null;
}

export function saveStoredVpsNode(node: { url: string; token: string; label: string; connected: boolean; lastPing?: number } | null): void {
  try {
    if (node) {
      localStorage.setItem(VPS_KEY, JSON.stringify(node));
    } else {
      localStorage.removeItem(VPS_KEY);
    }
  } catch {}
  emit();
}

export async function resetPassword(email: string): Promise<string> {
  const db = supabase();
  if (!db) return "Password recovery needs the account cloud (Supabase).";
  if (!email.trim().includes("@")) return "Enter a valid email address.";
  const { error } = await db.auth.resetPasswordForEmail(email.trim(), { redirectTo: bounceUrl });
  return error ? error.message : "";
}

export async function updatePassword(password: string, currentPassword = ""): Promise<string> {
  if (password.length < 6) return "Password must be at least 6 characters.";
  const db = supabase();
  const user = session?.user;
  if (!db || !user) return cloudConfig.supabase ? "Sign in before changing the password." : "Password changes need the account cloud (Supabase).";
  const providers = user.app_metadata?.providers;
  const hasEmailPassword = Array.isArray(providers) ? providers.includes("email") : user.app_metadata?.provider === "email";
  if (hasEmailPassword && !passwordRecovery) {
    if (!currentPassword) return "Enter your current password.";
    const email = user.email?.trim();
    if (!email) return "This account has no email to check the current password against.";
    const check = await db.auth.signInWithPassword({ email, password: currentPassword });
    if (check.error) return "Current password is wrong.";
  }
  const { error } = await db.auth.updateUser({ password });
  if (error) return error.message;
  passwordRecovery = false;
  emit();
  return "";
}

export async function deleteUserAccount(): Promise<string> {
  const db = supabase();
  if (db && session) {
    const { error } = await db.rpc("delete_user");
    if (error) return error.message || "The account could not be deleted.";
    passwordRecovery = false;
    await db.auth.signOut().catch(() => {});
  } else if (cloudConfig.supabase) {
    return "Sign in before deleting the cloud account.";
  }
  clearLocalProfile();
  saveStoredVpsNode(null);
  void invoke("cloud_keychain_clear").catch(() => {});
  return "";
}
