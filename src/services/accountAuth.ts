// Pure account-auth decisions. The Supabase client lives in cloud.ts.

export type AuthCallback =
  | { kind: "empty" }
  | { kind: "error"; message: string }
  | { kind: "code"; code: string }
  | { kind: "session"; accessToken: string; refreshToken: string; recovery: boolean };

export type SignUpResult =
  | { status: "signed_in" }
  | { status: "confirm_email" }
  | { status: "error"; message: string };

/** Query or hash from ronic://auth/callback, after the bounce page. */
export function parseAuthCallback(raw: string): AuthCallback {
  const text = raw.trim().replace(/^[?#]/, "");
  if (!text) return { kind: "empty" };
  const params = new URLSearchParams(text);
  const code = params.get("code")?.trim() ?? "";
  const accessToken = params.get("access_token")?.trim() ?? "";
  const refreshToken = params.get("refresh_token")?.trim() ?? "";
  if (code) return { kind: "code", code };
  if (accessToken && refreshToken) {
    return { kind: "session", accessToken, refreshToken, recovery: params.get("type") === "recovery" };
  }
  const message = params.get("error_description")?.trim() || params.get("error")?.trim() || "";
  if (message) return { kind: "error", message };
  return { kind: "empty" };
}

/** Supabase hides "email already registered" as a user with zero identities. */
export function classifySignup(input: {
  errorMessage?: string | null;
  hasSession: boolean;
  identityCount: number | null;
}): SignUpResult {
  const errorMessage = input.errorMessage?.trim() ?? "";
  if (errorMessage) return { status: "error", message: errorMessage };
  if (input.identityCount === 0) {
    return { status: "error", message: "An account with this email already exists. Sign in, or reset the password." };
  }
  if (!input.hasSession) return { status: "confirm_email" };
  return { status: "signed_in" };
}
