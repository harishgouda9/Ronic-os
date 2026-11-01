import type { AdvancedAuthConfig, MarketplaceCatalogItem } from "./marketplaceCatalog";
import { isPlaceholderCredential } from "./marketplaceCatalog";

export interface McpVerifyInput {
  identity?: string;
  secret?: string;
  config?: Record<string, string>;
  advanced?: AdvancedAuthConfig;
}

export interface McpVerifyResult {
  identity: string;
  detail: string;
}

type Run = (cmd: string, args: Record<string, unknown>) => Promise<unknown>;

const GOOGLE_IDS = new Set([
  "mcp-google-docs",
  "mcp-google-sheets",
  "mcp-google-slides",
  "mcp-google-calendar",
  "mcp-gmail",
]);

const MICROSOFT_IDS = new Set(["mcp-outlook", "mcp-onedrive", "mcp-email"]);

/**
 * Check a credential with the provider, or a local daemon/path with the desktop app.
 * A typed value, a placeholder, or a catalog URL that does not answer is not a connection.
 */
export async function verifyMcpCredentials(
  item: MarketplaceCatalogItem,
  input: McpVerifyInput,
  run?: Run,
): Promise<McpVerifyResult> {
  const method = item.authConfig?.method || (item.requiresAuth || item.requiresKey ? "api_key" : "none");
  if (method === "none") {
    return { identity: item.name, detail: "This item does not use a credential." };
  }
  if (method === "local_daemon") {
    return probeLocal(item, run, { kind: "docker" });
  }
  if (method === "local_path") {
    const path = input.config?.rootPath || input.identity || "";
    if (!path.trim() || isPlaceholderCredential(path)) {
      throw new Error("Choose a folder on this computer. An empty path is not a connection.");
    }
    return probeLocal(item, run, { kind: "path", path: path.trim() });
  }

  const secret = (input.secret || "").trim();
  const serviceJson = (input.advanced?.serviceAccountJson || "").trim();
  const config = input.config || {};

  if (GOOGLE_IDS.has(item.id) || item.slug.includes("google") || item.id === "mcp-gmail") {
    return verifyGoogle(item, secret, serviceJson, input.advanced?.customScopes);
  }
  if (item.id === "mcp-supabase") return verifySupabase(config);
  if (item.id === "mcp-github") return verifyBearer("https://api.github.com/user", secret || config.apiKey || "", "GitHub", githubIdentity);
  if (item.id === "mcp-notion") return verifyNotion(secret || config.accessToken || config.apiKey || "");
  if (item.id === "mcp-linear") return verifyLinear(secret || config.apiKey || config.accessToken || "");
  if (item.id === "mcp-slack") return verifySlack(secret || config.accessToken || config.apiKey || "");
  if (item.id === "mcp-sentry") return verifyBearer("https://sentry.io/api/0/", secret || config.apiKey || "", "Sentry", jsonIdentity);
  if (item.id === "mcp-shopify") return verifyShopify(config);
  if (item.id === "mcp-stripe" || item.slug.includes("stripe")) return verifyStripe(secret || config.apiKey || config.secretKey || "");
  if (item.id === "mcp-firecrawl") return verifyBearer("https://api.firecrawl.dev/v1/team", secret || config.apiKey || "", "Firecrawl", jsonIdentity);
  if (item.id === "mcp-posthog") return verifyBearer("https://us.posthog.com/api/users/@me/", secret || config.apiKey || "", "PostHog", jsonIdentity);
  if (item.id === "mcp-datadog") return verifyDatadog(secret || config.apiKey || "", input.advanced?.endpointUrl);
  if (item.id === "mcp-apify") return verifyBearer("https://api.apify.com/v2/users/me", secret || config.apiKey || "", "Apify", jsonIdentity);
  if (item.id === "mcp-razorpay") return verifyRazorpay(secret || config.apiKey || "", config.keySecret || config.password || "");
  if (MICROSOFT_IDS.has(item.id)) return verifyBearer("https://graph.microsoft.com/v1.0/me", secret, "Microsoft", jsonIdentity);
  if (item.id === "mcp-composio") {
    return verifyHeader(
      "https://backend.composio.dev/api/v1/client/auth/session",
      "x-api-key",
      secret || config.apiKey || "",
      "Composio",
      jsonIdentity,
    );
  }

  throw new Error(
    `${item.name} has no live credential check in this build, so it stays unauthenticated. A saved form is not a connection.`,
  );
}

async function probeLocal(item: MarketplaceCatalogItem, run: Run | undefined, args: Record<string, unknown>): Promise<McpVerifyResult> {
  if (!run) throw new Error("This check runs in the desktop app.");
  const res = await run("probe_local_tool", args);
  if (!res) throw new Error(`${item.name} did not pass the local check.`);
  const toast = typeof res === "object" && res && "toast" in res ? String((res as { toast?: string }).toast || "") : "";
  return { identity: toast || item.name, detail: toast || `${item.name} answered on this computer.` };
}

async function verifyGoogle(
  item: MarketplaceCatalogItem,
  secret: string,
  serviceJson: string,
  customScopes?: string[],
): Promise<McpVerifyResult> {
  const jsonText = serviceJson || (secret.startsWith("{") ? secret : "");
  if (jsonText) {
    const account = parseServiceAccount(jsonText);
    const scopes = (customScopes && customScopes.length > 0 ? customScopes : item.authConfig?.scopes || []).join(" ");
    const assertion = await signServiceAccountJwt(account.clientEmail, account.privateKey, scopes || "https://www.googleapis.com/auth/userinfo.email");
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    });
    const exchanged = await requestJson("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const access = String(exchanged.access_token || "");
    if (!access) throw new Error("Google did not return an access token for that service account.");
    await googleTokenInfo(access);
    return { identity: account.clientEmail, detail: `Google accepted the service account ${account.clientEmail}.` };
  }
  if (!secret || isPlaceholderCredential(secret)) {
    throw new Error("Paste a Google access token or a service-account JSON key. A blank field is not a connection.");
  }
  const info = await googleTokenInfo(secret);
  const email = String(info.email || info.sub || "").trim();
  if (!email || isPlaceholderCredential(email)) {
    const scope = String(info.scope || info.azp || "token");
    return { identity: scope.slice(0, 80), detail: "Google accepted the access token." };
  }
  return { identity: email, detail: `Google accepted the token for ${email}.` };
}

async function googleTokenInfo(token: string): Promise<Record<string, unknown>> {
  const url = new URL("https://www.googleapis.com/oauth2/v3/tokeninfo");
  url.searchParams.set("access_token", token);
  const info = await requestJson(url.toString(), { method: "GET" });
  if (info.error || info.error_description) {
    throw new Error("Google rejected that token. It was not marked connected.");
  }
  return info;
}

function parseServiceAccount(raw: string): { clientEmail: string; privateKey: string } {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error("That service-account value is not JSON.");
  }
  if (parsed.type !== "service_account") throw new Error("That JSON is not a Google service-account key.");
  const clientEmail = String(parsed.client_email || "").trim();
  const privateKey = String(parsed.private_key || "");
  if (!clientEmail || !privateKey.includes("BEGIN PRIVATE KEY")) {
    throw new Error("The service-account key needs a client_email and a PKCS#8 private key.");
  }
  return { clientEmail, privateKey };
}

async function signServiceAccountJwt(email: string, pem: string, scopes: string): Promise<string> {
  const enc = (value: object) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({
    iss: email,
    scope: scopes,
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  })}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToBytes(pem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const bytes = new Uint8Array(signature);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const tail = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return `${unsigned}.${tail}`;
}

function pemToBytes(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----BEGIN PRIVATE KEY-----/g, "").replace(/-----END PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function verifySupabase(config: Record<string, string>): Promise<McpVerifyResult> {
  const projectUrl = (config.projectUrl || "").trim().replace(/\/+$/, "");
  const key = (config.serviceKey || config.apiKey || config.anonKey || "").trim();
  let parsed: URL;
  try {
    parsed = new URL(projectUrl);
  } catch {
    throw new Error("Supabase needs a project URL such as https://your-project.supabase.co.");
  }
  if (parsed.protocol !== "https:") throw new Error("Supabase project URLs must start with https://.");
  if (!key || isPlaceholderCredential(key)) throw new Error("Supabase needs the anon or service-role key. It was not marked connected.");
  const health = `${parsed.origin}/auth/v1/health`;
  const response = await fetch(health, {
    method: "GET",
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15000),
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error("Supabase rejected that key. It was not marked connected.");
  }
  if (!response.ok) {
    throw new Error(`Supabase returned ${response.status} for ${parsed.host}. It was not marked connected.`);
  }
  return { identity: parsed.host, detail: `Supabase accepted the key for ${parsed.host}.` };
}

async function verifyNotion(secret: string): Promise<McpVerifyResult> {
  const token = requireSecret(secret, "Notion");
  const body = await requestJson("https://api.notion.com/v1/users/me", {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, "Notion-Version": "2022-06-28" },
  });
  const name = String(body.name || body.id || "Notion user");
  return { identity: name, detail: `Notion accepted the integration for ${name}.` };
}

async function verifyLinear(secret: string): Promise<McpVerifyResult> {
  const token = requireSecret(secret, "Linear");
  const body = await requestJson("https://api.linear.app/graphql", {
    method: "POST",
    headers: { Authorization: token.startsWith("lin_") ? token : `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: "{ viewer { id email name } }" }),
  });
  const viewer = (body.data as { viewer?: { email?: string; name?: string; id?: string } } | undefined)?.viewer;
  if (!viewer?.id) throw new Error("Linear did not return the signed-in user. It was not marked connected.");
  const identity = viewer.email || viewer.name || viewer.id;
  return { identity, detail: `Linear accepted the key for ${identity}.` };
}

async function verifySlack(secret: string): Promise<McpVerifyResult> {
  const token = requireSecret(secret, "Slack");
  const body = await requestJson("https://slack.com/api/auth.test", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
  });
  if (body.ok !== true) throw new Error("Slack rejected that token. It was not marked connected.");
  const identity = String(body.user || body.team || "Slack workspace");
  return { identity, detail: `Slack accepted the token for ${identity}.` };
}

async function verifyShopify(config: Record<string, string>): Promise<McpVerifyResult> {
  const store = (config.storeUrl || config.shop || "").trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const token = (config.accessToken || config.adminToken || config.apiKey || "").trim();
  if (!store || !store.includes(".")) throw new Error("Shopify needs the store domain, such as example.myshopify.com.");
  const key = requireSecret(token, "Shopify");
  const body = await requestJson(`https://${store}/admin/api/2024-10/shop.json`, {
    method: "GET",
    headers: { "X-Shopify-Access-Token": key },
  });
  const shop = (body.shop as { name?: string; domain?: string } | undefined)?.name || store;
  return { identity: String(shop), detail: `Shopify accepted the token for ${shop}.` };
}

async function verifyStripe(secret: string): Promise<McpVerifyResult> {
  const key = requireSecret(secret, "Stripe");
  const body = await requestJson("https://api.stripe.com/v1/balance", {
    method: "GET",
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!body.object && !body.available) throw new Error("Stripe did not return a balance. It was not marked connected.");
  return { identity: "Stripe account", detail: "Stripe accepted the secret key and returned a balance." };
}

async function verifyDatadog(secret: string, site?: string): Promise<McpVerifyResult> {
  const key = requireSecret(secret, "Datadog");
  const host = (site || "https://api.datadoghq.com").replace(/\/+$/, "");
  const endpoint = host.startsWith("http") ? host : `https://${host}`;
  const body = await requestJson(`${endpoint.replace(/\/api\/v1\/validate$/, "")}/api/v1/validate`, {
    method: "GET",
    headers: { "DD-API-KEY": key },
  });
  if (body.valid !== true) throw new Error("Datadog did not accept that API key.");
  return { identity: "Datadog", detail: "Datadog accepted the API key." };
}

async function verifyRazorpay(keyId: string, keySecret: string): Promise<McpVerifyResult> {
  const id = requireSecret(keyId, "Razorpay");
  const secret = keySecret.trim();
  const token = secret ? btoa(`${id}:${secret}`) : "";
  if (!token) throw new Error("Razorpay needs the key id and the key secret.");
  await requestJson("https://api.razorpay.com/v1/payments?count=1", {
    method: "GET",
    headers: { Authorization: `Basic ${token}` },
  });
  return { identity: id.slice(0, 8), detail: "Razorpay accepted the key pair." };
}

async function verifyBearer(
  url: string,
  secret: string,
  provider: string,
  identityOf: (body: Record<string, unknown>) => string,
): Promise<McpVerifyResult> {
  const token = requireSecret(secret, provider);
  const body = await requestJson(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json, application/json",
      "User-Agent": "Ronic-OS",
    },
  });
  const identity = identityOf(body);
  if (!identity || isPlaceholderCredential(identity)) {
    throw new Error(`${provider} answered without an account identity. It was not marked connected.`);
  }
  return { identity, detail: `${provider} accepted the credential for ${identity}.` };
}

async function verifyHeader(
  url: string,
  header: string,
  secret: string,
  provider: string,
  identityOf: (body: Record<string, unknown>) => string,
): Promise<McpVerifyResult> {
  const token = requireSecret(secret, provider);
  const body = await requestJson(url, { method: "GET", headers: { [header]: token, Accept: "application/json" } });
  const identity = identityOf(body) || provider;
  return { identity, detail: `${provider} accepted the credential.` };
}

function githubIdentity(body: Record<string, unknown>): string {
  return String(body.login || body.email || body.id || "");
}

function jsonIdentity(body: Record<string, unknown>): string {
  const user = body.user as { email?: string; name?: string } | undefined;
  return String(body.email || body.login || body.name || body.id || user?.email || user?.name || body.team || "");
}

function requireSecret(secret: string, provider: string): string {
  const token = secret.trim();
  if (!token || isPlaceholderCredential(token)) {
    throw new Error(`${provider} needs a real credential. It was not marked connected.`);
  }
  return token;
}

async function requestJson(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) });
  } catch {
    throw new Error("The provider could not be reached. It was not marked connected.");
  }
  const text = await response.text();
  if (response.status === 401 || response.status === 403) {
    throw new Error("The provider rejected that credential. It was not marked connected.");
  }
  if (response.status === 404) {
    throw new Error("The provider address was not found. It was not marked connected.");
  }
  if (!response.ok) {
    throw new Error(`The provider returned ${response.status}. It was not marked connected.`);
  }
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    if (Array.isArray(parsed)) return { items: parsed.length };
    return {};
  } catch {
    throw new Error("The provider answer was not JSON. It was not marked connected.");
  }
}
