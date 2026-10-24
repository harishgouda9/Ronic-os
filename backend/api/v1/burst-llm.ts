// POST /api/v1/burst-llm — wallet-gated wholesale model routing.
//
// When every personal subscription is at its 5-hour cap, the desktop falls
// back to Burst Compute: this proxy calls OpenRouter with the wholesale key
// and debits compute_wallets at cost + 20% (blueprint stream 5).

import { bad, json } from "../_lib/http";
import { rpc, selectOne, serviceConfigured, userIdFromToken } from "../_lib/supabase";

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

type Body = {
  model?: string;
  messages?: ChatMessage[];
  maxTokens?: number;
};

// USD per 1M tokens (prompt/completion), matching OpenRouter's published
// rates for the wholesale models the blueprint names. Update these when a
// provider changes list prices; reconcile against the OpenRouter dashboard.
const MODEL_RATES_USD_PER_MTOK: Record<string, [number, number]> = {
  "deepseek/deepseek-chat": [0.14, 0.28],
  "deepseek/deepseek-reasoner": [0.55, 2.21],
  "qwen/qwen-2.5-72b-instruct": [0.35, 0.4],
  "amazon/nova-pro-v1": [0.8, 3.2],
  "meta-llama/llama-3.3-70b-instruct": [0.12, 0.3],
};

const FALLBACK_RATE: [number, number] = [0.5, 1.5];
const MARKUP_NUM = 6; // +20% markup => price * 6/5
const MARKUP_DEN = 5;
const MIN_BALANCE_MICRO_USD = 100_000; // refuse calls that would leave < $0.10

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "POST") return bad("POST only", 405);
  if (!serviceConfigured()) return bad("supabase service role not configured", 503);

  const key = process.env.OPENROUTER_WHOLESALE_KEY ?? "";
  if (!key) return bad("burst compute is not configured on this deployment.", 503);

  const token = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const userId = token ? await userIdFromToken(token) : null;
  if (!userId) return bad("sign in first", 401);

  const body = (await request.json().catch(() => ({}))) as Body;
  const model = (body.model ?? "").trim();
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!model || messages.length === 0) return bad("model and messages are required");

  const wallet = await selectOne<{ balance_micro_usd: number }>(
    "compute_wallets",
    `user_id=eq.${userId}&select=balance_micro_usd`,
  );
  const balance = wallet?.balance_micro_usd ?? 0;
  if (balance < MIN_BALANCE_MICRO_USD) {
    return json(402, { error: "BURST_WALLET_LOW", balanceMicroUsd: balance, minMicroUsd: MIN_BALANCE_MICRO_USD });
  }

  const upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      "http-referer": process.env.APP_ORIGIN ?? "https://ronic.os",
      "x-title": "Ronic OS Burst Compute",
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: Math.min(Math.max(body.maxTokens ?? 1024, 1), 8192),
    }),
  });
  const payload = (await upstream.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    error?: { message?: string };
  };
  if (!upstream.ok || payload.error) {
    return bad(payload.error?.message ?? `upstream model call failed (${upstream.status})`, 502);
  }
  const reply = payload.choices?.[0]?.message?.content ?? "";
  if (!reply) return bad("upstream returned an empty completion", 502);

  // Cost accounting in whole micro-USD. Estimates use the rate table; the
  // 20% margin covers provider drift and is reconciled from the dashboard.
  const [inRate, outRate] = MODEL_RATES_USD_PER_MTOK[model] ?? FALLBACK_RATE;
  const promptTokens = payload.usage?.prompt_tokens ?? 0;
  const completionTokens = payload.usage?.completion_tokens ?? 0;
  const costMicro =
    Math.ceil(((promptTokens * inRate + completionTokens * outRate) / 1_000_000) * 1_000_000);
  const chargeMicro = Math.ceil((costMicro * MARKUP_NUM) / MARKUP_DEN);

  let remaining = balance;
  try {
    remaining = await rpc<number>("debit_wallet", {
      p_user_id: userId,
      p_micro_usd: chargeMicro,
      p_min_balance: 0,
    });
  } catch (error) {
    // The completion was already produced; log loudly so the ledger can be
    // reconciled even if the debit raced a concurrent call to zero.
    console.error("burst debit failed after completion:", error, { userId, model, chargeMicro });
    return json(200, {
      reply,
      chargedMicroUsd: 0,
      balanceMicroUsd: balance,
      ledgerWarning: "debit failed — reconcile manually",
    });
  }

  return json(200, {
    reply,
    usage: { promptTokens, completionTokens },
    chargedMicroUsd: chargeMicro,
    balanceMicroUsd: remaining,
  });
}
