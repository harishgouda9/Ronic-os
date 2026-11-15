import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";

const env = import.meta.env ?? {};
const envUrl = String(env.VITE_SUPABASE_URL ?? "").trim();
const envAnon = String(env.VITE_SUPABASE_ANON_KEY ?? "").trim();
// Public site builds have no .env.local. This is the anon key, not the service role.
const url = envUrl || "https://rodayupwqttjbzwuytxl.supabase.co";
const anon = envAnon || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJvZGF5dXB3cXR0amJ6d3V5dHhsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM0NjAxNTIsImV4cCI6MjEwOTAzNjE1Mn0.Y1mPUssa6QEvIpJpwAvo8NKswOPdm7sebrFD4F7dfZA";

let client: SupabaseClient | null = null;
let session: Session | null = null;
let recovery = false;
let started = false;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((listener) => listener());
}

export function subscribeSiteAccount(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function siteSession() {
  return session;
}

export function siteRecovery() {
  return recovery;
}

/** A return address stays on this website. Any other address is dropped. */
export function siteRedirect(preferred: string, origin: string): string {
  try {
    const next = new URL(preferred);
    if (next.origin === origin) return `${next.origin}${next.pathname}`;
  } catch {
    return origin;
  }
  return origin;
}

function account(): SupabaseClient {
  if (!client) {
    client = createClient(url, anon, {
      auth: { persistSession: true, storageKey: "ronic.site.auth" },
    });
  }
  return client;
}

export function startSiteAccount() {
  if (started || typeof window === "undefined") return;
  started = true;
  const db = account();
  db.auth.onAuthStateChange((event, next) => {
    session = next;
    if (event === "PASSWORD_RECOVERY") recovery = true;
    if (!next) recovery = false;
    if (next?.user && (event === "SIGNED_IN" || event === "INITIAL_SESSION" || event === "PASSWORD_RECOVERY")) {
      void db.rpc("ensure_user_rows", { p_user_id: next.user.id });
    }
    emit();
  });
  void db.auth.getSession().then(({ data }) => {
    session = data.session ?? session;
    emit();
    const clean = new URL(window.location.href);
    if (!clean.searchParams.has("code")) return;
    clean.searchParams.delete("code");
    window.history.replaceState({}, "", `${clean.pathname}${clean.search}${clean.hash}`);
  });
}

export async function siteSignIn(email: string, password: string): Promise<string> {
  const { error } = await account().auth.signInWithPassword({ email: email.trim(), password });
  return error ? error.message : "";
}

export async function siteSignUp(email: string, password: string, origin: string): Promise<string> {
  const { data, error } = await account().auth.signUp({
    email: email.trim(),
    password,
    options: { emailRedirectTo: siteRedirect(origin, origin) },
  });
  if (error?.message) return error.message;
  if (data.user?.identities && data.user.identities.length === 0) return "An account with this email already exists. Sign in, or reset the password.";
  if (!data.session) return "Account created. Open the confirmation link in this browser, then it brings you back here.";
  return "";
}

export async function siteSignOut(): Promise<void> {
  recovery = false;
  await account().auth.signOut();
}

export async function siteResetPassword(email: string, origin: string): Promise<string> {
  if (!email.trim().includes("@")) return "Enter a valid email address.";
  const { error } = await account().auth.resetPasswordForEmail(email.trim(), { redirectTo: siteRedirect(origin, origin) });
  return error ? error.message : "";
}

export async function siteUpdatePassword(password: string): Promise<string> {
  if (password.length < 8) return "Password must be at least 8 characters.";
  if (!session?.user) return "Sign in before changing the password.";
  const { error } = await account().auth.updateUser({ password });
  if (error) return error.message;
  recovery = false;
  emit();
  return "";
}
