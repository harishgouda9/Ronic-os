// POST /api/v1/checkout — create a Stripe or Razorpay checkout for
// founder_pass / pro_monthly / pro_yearly. The caller's Supabase JWT becomes
// metadata on the payment so the webhook can fulfill it without guessing.

import { bad, json } from "../_lib/http";
import { rpc, selectOne, serviceConfigured, userIdFromToken } from "../_lib/supabase";

type Body = { product?: string; rail?: string };

const PRODUCTS: Record<string, { usd_cents: number; inr_paise: number; name: string }> = {
  founder_pass: { usd_cents: 14900, inr_paise: 1199900, name: "Ronic OS Founder Pass (Lifetime)" },
  pro_monthly: { usd_cents: 1400, inr_paise: 99900, name: "Ronic OS Pro (Monthly)" },
  pro_yearly: { usd_cents: 12000, inr_paise: 999000, name: "Ronic OS Pro (Yearly)" },
};

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "POST") return bad("POST only", 405);
  if (!serviceConfigured()) return bad("supabase service role not configured", 503);

  const token = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const userId = token ? await userIdFromToken(token) : null;
  if (!userId) return bad("sign in first", 401);

  const body = (await request.json().catch(() => ({}))) as Body;
  const product = body.product ?? "";
  const rail = body.rail === "razorpay" ? "razorpay" : "stripe";
  const item = PRODUCTS[product];
  if (!item) return bad("unknown product");

  if (product === "founder_pass") {
    // Sold-out passes must stop at the checkout, not at the webhook.
    const pool = await selectOne<{ claimed_count: number; max_supply: number }>(
      "founder_pass_pool",
      "select=claimed_count,max_supply",
    );
    if (pool && pool.claimed_count >= pool.max_supply) return bad("All 500 Founder Passes are claimed.", 410);
  }

  const origin = process.env.APP_ORIGIN ?? "https://ronic.os";

  if (rail === "stripe") {
    const key = process.env.STRIPE_SECRET_KEY ?? "";
    if (!key) return bad("Stripe is not configured on this deployment.", 503);

    const form = new URLSearchParams({
      mode: product === "founder_pass" ? "payment" : "subscription",
      success_url: `${origin}/founders?paid=1`,
      cancel_url: `${origin}/founders?canceled=1`,
      "line_items[0][quantity]": "1",
      "metadata[user_id]": userId,
      "metadata[product]": product,
      client_reference_id: userId,
    });
    if (product === "founder_pass") {
      form.set("line_items[0][price_data][currency]", "usd");
      form.set("line_items[0][price_data][unit_amount]", String(item.usd_cents));
      form.set("line_items[0][price_data][product_data][name]", item.name);
    } else {
      form.set("line_items[0][price_data][currency]", "usd");
      form.set("line_items[0][price_data][unit_amount]", String(item.usd_cents));
      form.set("line_items[0][price_data][recurring][interval]", product === "pro_yearly" ? "year" : "month");
      form.set("line_items[0][price_data][product_data][name]", item.name);
      form.set("subscription_data[metadata][user_id]", userId);
      form.set("subscription_data[metadata][product]", product);
    }

    const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });
    const payload = (await res.json()) as { url?: string; id?: string; error?: { message?: string } };
    if (!res.ok || !payload.url) {
      return bad(payload.error?.message ?? "Stripe checkout did not start.", 502);
    }
    return json(200, { url: payload.url, sessionId: payload.id, rail });
  }

  // Razorpay (India: UPI/RuPay/cards). Orders carry the fulfillment receipt;
  // capture is confirmed by the webhook, never by this response.
  const keyId = process.env.RAZORPAY_KEY_ID ?? "";
  const keySecret = process.env.RAZORPAY_KEY_SECRET ?? "";
  if (!keyId || !keySecret) return bad("Razorpay is not configured on this deployment.", 503);

  const res = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      amount: item.inr_paise,
      currency: "INR",
      receipt: `ronic:${userId}:${product}`,
      notes: { user_id: userId, product },
    }),
  });
  const payload = (await res.json()) as { id?: string; error?: { description?: string } };
  if (!res.ok || !payload.id) {
    return bad(payload.error?.description ?? "Razorpay order did not start.", 502);
  }
  return json(200, { orderId: payload.id, keyId, amountPaise: item.inr_paise, currency: "INR", rail });
}
