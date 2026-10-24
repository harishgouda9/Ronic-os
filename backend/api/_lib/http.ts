// Shared HTTP helpers for the Ronic OS control plane. Zero runtime deps.

import { timingSafeEqual } from "node:crypto";

export function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function bad(message: string, status = 400): Response {
  return json(status, { error: message });
}

export async function readRawBody(request: Request): Promise<string> {
  // Webhook signature verification needs the exact bytes the provider signed.
  return await request.text();
}

// Timing-safe comparison for hex HMAC digests.
export function safeEqualHex(a: string, b: string): boolean {
  if (!/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b) || a.length !== b.length) return false;
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}
