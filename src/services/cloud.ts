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

export const cloudConfig = {
  supabase: Boolean(url && anon),
  sentry: Boolean(sentryDsn),
  posthog: Boolean(posthogKey),
  checkout: Boolean(checkoutUrl),
};

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
  void db.auth.getSession().then(({ data }) => {
    session = data.session;
    emit();
  });
  db.auth.onAuthStateChange((_event, next) => {
    session = next;
    if (next?.user && posthogKey) posthog.identify(next.user.id);
    emit();
  });
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
