import assert from "node:assert/strict";
import test from "node:test";
import { allowedUpstream, sameSecret, targetUrl } from "../api/_lib/edge.mjs";

test("oauth query is preserved and dot-dot is rejected", () => {
  const upstream = "https://example-words.trycloudflare.com";
  assert.equal(allowedUpstream(upstream), true);
  assert.equal(allowedUpstream("https://evil.example"), false);
  assert.equal(allowedUpstream("http://example-words.trycloudflare.com"), false);
  assert.equal(allowedUpstream("https://example-words.trycloudflare.com/mcp"), false);
  const raw = "https://ronicos.vercel.app/api/mcp?ronic_path=%2Fauthorize&response_type=code&redirect_uri=https%3A%2F%2Fchatgpt.com%2Fconnector_platform_oauth_redirect&code_challenge=abc-DEF_0&resource=https%3A%2F%2Fronicos.vercel.app%2Fmcp";
  const next = new URL(targetUrl(upstream, raw));
  assert.equal(next.origin, upstream);
  assert.equal(next.pathname, "/authorize");
  assert.equal(next.searchParams.get("response_type"), "code");
  assert.equal(next.searchParams.get("redirect_uri"), "https://chatgpt.com/connector_platform_oauth_redirect");
  assert.equal(next.searchParams.get("code_challenge"), "abc-DEF_0");
  assert.equal(next.searchParams.get("resource"), "https://ronicos.vercel.app/mcp");
  assert.equal(next.searchParams.get("ronic_path"), null);
  assert.equal(targetUrl(upstream, "https://ronicos.vercel.app/api/mcp?ronic_path=%2F..%2Ftoken"), null);
  assert.equal(targetUrl(upstream, "https://ronicos.vercel.app/api/mcp?ronic_path=%2Fauthorize%5Ctoken"), null);
  assert.equal(targetUrl(upstream, "https://ronicos.vercel.app/api/mcp?ronic_path=%2Fsecret"), null);
  assert.equal(targetUrl("https://evil.example", raw), null);
});

test("the door secret is not the bridge token a caller invents", () => {
  const secret = "desktop-and-vercel-1";
  assert.equal(sameSecret(secret, secret), true);
  assert.equal(sameSecret(secret, "a".repeat(64)), false);
  assert.equal(sameSecret("", secret), false);
  assert.equal(sameSecret("short", "short"), false);
});
