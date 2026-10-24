// POST /api/webhooks/billing — dual-gateway fulfillment (Stripe USD + Razorpay INR/UPI).
//
// Rails (blueprint §5):
//   A. Stripe:      $14/mo + $120/yr Pro subs, $149 one-time Founder Pass
//   B. Razorpay:    ₹999/mo Pro, ₹11,999 Founder Pass, UPI/RuPay/cards
//
// Every request is signature-verified against the raw body before anything
// mutates, and every event id is claimed in billing_events so provider
// retries are no-ops.

import { createHmac } from "node:crypto";
import { bad, json, readRawBody, safeEqualHex } from "../_lib/http";
import { claimBillingEvent, rpc, serviceConfigured } from "../_lib/supabase";

type StripeEvent = {
  id?: string;
  type?: string;
  data?: {
    object?: {
      id?: string;
      customer?: string;
      subscription?: string;
      status?: string;
      metadata?: Record<string, string>;
      payment_status?: string;
    };
  };
};

type RazorpayEvent = {
  event?: string;
  payload?: {
    payment?: { entity?: { id?: string; order_id?: string; status?: string } };
    subscription?: { entity?: { id?: string; status?: string; notes?: Record<string, string> } };
  };
};

const PRO_TIERS: Record<string, { tier: string; devices: number }> = {
  pro_monthly: { tier: "pro", devices: 3 },
  pro_yearly: { tier: "pro", devices: 3 },
};

function verifyStripe(raw: string, header: string | null): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(
    header.split(",").map((piece) => piece.split("=").map((s) => s.trim()) as [string, string]),
  );
  if (!parts.t || !parts.v1) return false;
  const age = Math.abs(Date.now() / 1000 - Number(parts.t));
  if (!Number.isFinite(age) || age > 300) return false; // 5-minute replay window
  const secret = process.env.STRIPE_WEBHOOK_SECRET ?? "";
  if (!secret) return false;
  const digest = createHmac("sha256", secret).update(`${parts.t}.${raw}`).digest("hex");
  return safeEqualHex(digest, parts.v1);
}

function verifyRazorpay(raw: string, header: string | null): boolean {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET ?? "";
  if (!header || !secret) return false;
  const digest = createHmac("sha256", secret).update(raw).digest("hex");
  return safeEqualHex(digest, header);
}

async function fulfillStripe(event: StripeEvent): Promise<string> {
  const object = event.data?.object ?? {};
  const userId = object.metadata?.user_id ?? "";
  const product = object.metadata?.product ?? "";
  if (!userId) return "no user_id in metadata — session created outside Ronic checkout";

  if (event.type === "checkout.session.completed" && product === "founder_pass") {
    const badge = await rpc<number>("claim_founder_pass", { p_user_id: userId }).catch((error: Error & { pgCode?: string }) => {
      if (error.pgCode === "P0001" && /FOUNDER_POOL_EXHAUSTED/.test(error.message)) {
        throw new Error("FOUNDER_POOL_EXHAUSTED — refund path required");
      }
      throw error;
    });
    return `founder pass claimed, badge #${badge}`;
  }

  if (event.type === "checkout.session.completed" && PRO_TIERS[product]) {
    await rpc("activate_subscription", { p_user_id: userId, p_tier: PRO_TIERS[product].tier, p_max_devices: PRO_TIERS[product].devices, p_status: "active" });
    return `${product} activated`;
  }

  if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
    const status = event.type === "customer.subscription.deleted" ? "canceled"
      : object.status === "active" ? "active"
      : object.status === "past_due" ? "past_due"
      : "canceled";
    const tier = product && PRO_TIERS[product] ? PRO_TIERS[product].tier : "free";
    const devices = tier === "pro" ? 3 : 1;
    await rpc("activate_subscription", { p_user_id: userId, p_tier: tier, p_max_devices: devices, p_status: status });
    return `subscription ${status}`;
  }

  return `ignored ${event.type ?? "unknown"}`;
}

async function fulfillRazorpay(event: RazorpayEvent): Promise<string> {
  const kind = event.event ?? "";

  if (kind === "payment.captured") {
    const payment = event.payload?.payment?.entity;
    if (!payment?.order_id) return "payment without order id";
    // The checkout endpoint encodes fulfillment data in the order receipt:
    //   receipt = "ronic:<user_id>:<product>"
    const res = await fetch(`https://api.razorpay.com/v1/orders/${payment.order_id}`, {
      headers: {
        authorization: `Basic ${Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString("base64")}`,
      },
    });
    if (!res.ok) return `order lookup failed (${res.status})`;
    const order = (await res.json()) as { receipt?: string; status?: string };
    const receipt = order.receipt ?? "";
    const parts = receipt.split(":");
    if (parts[0] !== "ronic" || parts.length < 3) return "order receipt is not a Ronic order";
    const [, userId, product] = parts;

    if (product === "founder_pass") {
      const badge = await rpc<number>("claim_founder_pass", { p_user_id: userId });
      return `founder pass claimed, badge #${badge}`;
    }
    if (PRO_TIERS[product]) {
      await rpc("activate_subscription", { p_user_id: userId, p_tier: "pro", p_max_devices: 3, p_status: "active" });
      return `${product} activated`;
    }
    return `unknown product ${product}`;
  }

  if (kind === "subscription.charged") {
    const sub = event.payload?.subscription?.entity;
    const userId = sub?.notes?.user_id ?? "";
    if (!userId) return "subscription without user_id note";
    await rpc("activate_subscription", { p_user_id: userId, p_tier: "pro", p_max_devices: 3, p_status: "active" });
    return "pro subscription charged";
  }

  return `ignored ${kind}`;
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "POST") return bad("POST only", 405);
  if (!serviceConfigured()) return bad("supabase service role not configured", 503);

  const raw = await readRawBody(request);

  let stripeSignature = null;
  let razorpaySignature = null;
  try {
    stripeSignature = request.headers.get("stripe-signature");
    razorpaySignature = request.headers.get("x-razorpay-signature");
  } catch {
    return bad("unreadable headers");
  }

  try {
    if (stripeSignature !== null && stripeSignature) {
      if (!verifyStripe(raw, stripeSignature)) return bad("invalid stripe signature", 400);
      const event = JSON.parse(raw) as StripeEvent;
      if (!event.id) return bad("stripe event without id");
      if (!(await claimBillingEvent("stripe", event.id))) return json(200, { replayed: true });
      const note = await fulfillStripe(event);
      return json(200, { handled: true, note });
    }

    if (razorpaySignature !== null && razorpaySignature) {
      if (!verifyRazorpay(raw, razorpaySignature)) return bad("invalid razorpay signature", 400);
      const event = JSON.parse(raw) as RazorpayEvent;
      const eventId = event.payload?.payment?.entity?.id ?? event.payload?.subscription?.entity?.id;
      if (!eventId) return bad("razorpay event without id");
      if (!(await claimBillingEvent("razorpay", eventId))) return json(200, { replayed: true });
      const note = await fulfillRazorpay(event);
      return json(200, { handled: true, note });
    }

    return bad("no recognized gateway signature header", 400);
  } catch (error) {
    // Log loud, answer 500 so the provider retries after the fix.
    console.error("billing webhook failed:", error);
    return bad(error instanceof Error ? error.message : "webhook failed", 500);
  }
}
