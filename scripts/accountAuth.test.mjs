import assert from "node:assert/strict";
import test from "node:test";
import { classifySignup, parseAuthCallback } from "../src/services/accountAuth.ts";

test("auth callback prefers a code, then tokens, then the provider error", () => {
  assert.deepEqual(parseAuthCallback("code=abc&sb_flow_id=flow1"), { kind: "code", code: "abc" });
  assert.deepEqual(parseAuthCallback("#access_token=a&refresh_token=r&type=recovery"), {
    kind: "session",
    accessToken: "a",
    refreshToken: "r",
    recovery: true,
  });
  assert.deepEqual(parseAuthCallback("error_description=The+sign-in+was+canceled"), {
    kind: "error",
    message: "The sign-in was canceled",
  });
  assert.deepEqual(parseAuthCallback(""), { kind: "empty" });
  assert.equal(parseAuthCallback("code=abc&error=access_denied").kind, "code");
});

test("signup tells a new user to confirm, and an existing email to sign in", () => {
  assert.deepEqual(classifySignup({ hasSession: false, identityCount: 1 }), { status: "confirm_email" });
  assert.deepEqual(classifySignup({ hasSession: true, identityCount: 1 }), { status: "signed_in" });
  assert.equal(classifySignup({ hasSession: false, identityCount: 0 }).status, "error");
  assert.equal(classifySignup({ errorMessage: "Password should be at least 6 characters", hasSession: false, identityCount: null }).status, "error");
});
