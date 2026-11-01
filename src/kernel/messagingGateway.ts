// Pure state-transition logic for the Remote Messaging Gateway screen.
// Kept separate from the React component so the security and UI flows can be
// simulated end-to-end under `node --test` (see scripts/messagingGateway.test.mjs).

export type GatewayChannelStatus = "connected" | "pid_conflict" | "error" | "disconnected";

// ── Real backend types (mirrors gateway_connections.rs) ──

export type LiveGatewayState =
  | "Disconnected"
  | "Validating"
  | "Connecting"
  | "AwaitingQrScan"
  | "Connected"
  | "Error";

export interface GatewayConnectionInfo {
  channel_id: string;
  state: LiveGatewayState;
  platform_user: string | null;
  platform_user_id: string | null;
  error: string | null;
  connected_at_ms: number | null;
  messages_received: number;
  messages_sent: number;
  qr_png_base64: string | null;
  qr_uri: string | null;
}

export interface IncomingGatewayMessage {
  channel_id: string;
  sender_id: string;
  sender_display: string;
  text: string;
  chat_id: string;
  timestamp_ms: number;
  platform_message_id: string | null;
}

/** Map the live backend state to the display status the UI already uses. */
export function liveStateToStatus(
  state: LiveGatewayState,
): GatewayChannelStatus {
  if (state === "Connected") return "connected";
  if (state === "Error") return "error";
  return "disconnected";
}

export interface ExtraCredential {
  id: string;
  label: string;
  value: string;
}

export interface GatewayChannel {
  id: string;
  name: string;
  enabled: boolean;
  status: GatewayChannelStatus;
  conflictPid?: number;
  conflictError?: string;
  botTokenMasked: string;
  ownerUserId: string;
  defaultBot: string;
  routableBots: string[];
  extraCredentials?: ExtraCredential[];
}

export interface CredentialDraft {
  token: string;
  ownerId: string;
  extras: ExtraCredential[];
}

export interface FleetMember {
  id: string;
  handle: string;
  displayName: string;
  kind: "bot" | "group";
  leadBotId: string;
}

export type RouteDecision =
  | { ok: true; handle: string; prompt: string; botId: string; kind: "bot" | "group" }
  | { ok: false; reason: string };

export type PushEventType = "wallet_approval_gate" | "sentinel_incident" | "task_completed" | string;

export interface PushButton {
  label: string;
  callbackActionId: string;
}

/** Resolves the inline action buttons attached to a push alert for an event type. */
export function pushButtonsForEvent(eventType: PushEventType): PushButton[] {
  if (eventType === "wallet_approval_gate") {
    return [
      { label: "✅ Approve ($5.00)", callbackActionId: "approve_tx_901" },
      { label: "❌ Reject", callbackActionId: "reject_tx_901" },
      { label: "📸 View Screen", callbackActionId: "view_pip_screenshot" },
    ];
  }
  if (eventType === "sentinel_incident") {
    return [
      { label: "📸 View Screen", callbackActionId: "view_pip_screenshot" },
      { label: "✅ Acknowledge", callbackActionId: "ack_sentinel_supabase" },
    ];
  }
  return [{ label: "📸 View Screen", callbackActionId: "view_pip_screenshot" }];
}

/** A push alert may only be dispatched to a connected + enabled channel. */
export function canSendPush(channel: Pick<GatewayChannel, "status" | "enabled">): boolean {
  return channel.status === "connected" && channel.enabled;
}

// Helpers are generic over the channel shape so callers (e.g. the React
// component) can keep extra presentational fields like badges and hints.

/**
 * Reclaims an orphaned gateway PID and connects the channel. Always returns a
 * new channel object with the conflict cleared and status "connected".
 */
export function applyReclaim<T extends GatewayChannel>(channel: T): T {
  return {
    ...channel,
    enabled: true,
    status: "connected",
    conflictPid: undefined,
    conflictError: undefined,
  };
}

/**
 * Toggles the gateway connection. Connecting fills any missing credentials from
 * the draft so the channel never connects with an empty token/owner when the
 * user already typed them.
 */
export function applyToggleConnect<T extends GatewayChannel>(
  channel: T,
  draft: CredentialDraft,
): T {
  const nextConnected = channel.status !== "connected";
  return {
    ...channel,
    enabled: nextConnected,
    status: nextConnected ? "connected" : "disconnected",
    conflictError: undefined,
    conflictPid: undefined,
    botTokenMasked: channel.botTokenMasked || draft.token,
    ownerUserId: channel.ownerUserId || draft.ownerId,
  };
}

/** Saves the credential draft onto the channel. Blank extra rows are dropped. */
export function applySaveCredentials<T extends GatewayChannel>(
  channel: T,
  draft: CredentialDraft,
): T {
  return {
    ...channel,
    botTokenMasked: draft.token,
    ownerUserId: draft.ownerId,
    extraCredentials: usableExtras(draft.extras),
  };
}

/** Toggles a bot handle in the channel's routable set. */
export function toggleRoutableBot<T extends GatewayChannel>(channel: T, botHandle: string): T {
  const exists = channel.routableBots.includes(botHandle);
  return {
    ...channel,
    routableBots: exists
      ? channel.routableBots.filter((b) => b !== botHandle)
      : [...channel.routableBots, botHandle],
  };
}

/** Returns the credential draft for a channel, seeding from saved values. */
export function draftFor(
  drafts: Record<string, Partial<CredentialDraft>>,
  channel: Pick<GatewayChannel, "id" | "botTokenMasked" | "ownerUserId" | "extraCredentials">,
): CredentialDraft {
  const saved = drafts[channel.id];
  if (saved) return normalizeDraft(saved);
  return normalizeDraft(undefined, {
    token: channel.botTokenMasked,
    ownerId: channel.ownerUserId,
    extras: channel.extraCredentials ?? [],
  });
}

export function normalizeDraft(
  draft: Partial<CredentialDraft> | undefined,
  fallback?: Partial<CredentialDraft>,
): CredentialDraft {
  const extras = Array.isArray(draft?.extras) ? draft.extras : (fallback?.extras ?? []);
  return {
    token: draft?.token ?? fallback?.token ?? "",
    ownerId: draft?.ownerId ?? fallback?.ownerId ?? "",
    extras: extras
      .filter((item) => item && typeof item.label === "string" && typeof item.value === "string")
      .map((item, index) => ({
        id: item.id || `extra_${index}_${item.label}`,
        label: item.label,
        value: item.value,
      })),
  };
}

/** Extra rows count only when both the name and the value are filled in. */
export function usableExtras(extras: ExtraCredential[] | undefined): ExtraCredential[] {
  return (extras ?? []).filter((item) => item.label.trim() && item.value.trim());
}

export function canonicalBotHandle(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const body = trimmed.replace(/^[@#]/, "");
  return body ? `@${body}` : "";
}

export function canonicalGroupHandle(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const body = trimmed.replace(/^[@#]/, "");
  return body ? `#${body}` : "";
}

/** Bots and groups that actually exist in the workspace. Preset names are not included. */
export function fleetMembers(
  profiles: { id: string; handle: string; displayName: string }[],
  groups: { id: string; groupHandle: string; title: string; leadBotId: string }[],
): FleetMember[] {
  const bots: FleetMember[] = [];
  for (const profile of profiles) {
    const handle = canonicalBotHandle(profile.handle || profile.displayName);
    if (!handle) continue;
    bots.push({
      id: profile.id,
      handle,
      displayName: profile.displayName || handle,
      kind: "bot",
      leadBotId: profile.id,
    });
  }
  const squads: FleetMember[] = [];
  for (const group of groups) {
    const handle = canonicalGroupHandle(group.groupHandle || group.title);
    if (!handle) continue;
    squads.push({
      id: group.id,
      handle,
      displayName: group.title || handle,
      kind: "group",
      leadBotId: group.leadBotId,
    });
  }
  const seen = new Set<string>();
  const fleet: FleetMember[] = [];
  for (const member of [...bots, ...squads]) {
    const key = member.handle.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    fleet.push(member);
  }
  return fleet;
}

/** Drops routable handles that are not in the live fleet and keeps the default inside that set. */
export function pruneChannelRouting<T extends { routableBots: string[]; defaultBot: string }>(
  channel: T,
  fleet: FleetMember[],
): { routableBots: string[]; defaultBot: string } {
  const known = new Map(fleet.map((member) => [member.handle.toLowerCase(), member.handle]));
  const routableBots: string[] = [];
  for (const raw of channel.routableBots) {
    const handle = known.get(raw.toLowerCase());
    if (!handle) continue;
    if (routableBots.some((item) => item.toLowerCase() === handle.toLowerCase())) continue;
    routableBots.push(handle);
  }
  if (!channel.defaultBot.trim()) return { routableBots, defaultBot: "" };
  const named = known.get(channel.defaultBot.toLowerCase()) ?? "";
  const defaultBot = named && routableBots.some((item) => item.toLowerCase() === named.toLowerCase())
    ? named
    : (routableBots[0] ?? "");
  return { routableBots, defaultBot };
}

const MENTION = /^([@#][A-Za-z0-9_][A-Za-z0-9_-]*)\s*([\s\S]*)$/;

/**
 * Picks the real bot or group a remote message should reach.
 * A mentioned handle that was never created is refused. The default is used
 * only when it is both real and switched on for this channel.
 */
export function resolveInboundRoute(
  text: string,
  channel: { routableBots: string[]; defaultBot: string },
  fleet: FleetMember[],
): RouteDecision {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, reason: "Empty message was not routed." };
  const byHandle = new Map(fleet.map((member) => [member.handle.toLowerCase(), member]));
  const routable = new Set(channel.routableBots.map((handle) => handle.toLowerCase()));

  const mention = trimmed.match(MENTION);
  const chosen = mention ? byHandle.get(mention[1].toLowerCase()) : byHandle.get(channel.defaultBot.trim().toLowerCase());
  if (mention && !chosen) {
    return { ok: false, reason: `${mention[1]} is not a bot in this workspace.` };
  }
  if (!chosen) {
    return { ok: false, reason: "No default bot is set. Turn on a bot created in this workspace." };
  }
  if (!routable.has(chosen.handle.toLowerCase())) {
    return { ok: false, reason: `${chosen.handle} is not routable on this channel. Turn it on under Bots routable.` };
  }
  if (chosen.kind === "group" && !chosen.leadBotId.trim()) {
    return { ok: false, reason: `${chosen.handle} has no lead bot.` };
  }
  const prompt = mention ? mention[2].trim() : trimmed;
  if (!prompt) return { ok: false, reason: `Write a task after ${chosen.handle}.` };
  return {
    ok: true,
    handle: chosen.handle,
    prompt,
    botId: chosen.kind === "group" ? chosen.leadBotId : chosen.id,
    kind: chosen.kind,
  };
}

/** Slack's optional app-level token is appended the way the desktop connector already reads it. */
export function composeConnectToken(channelId: string, draft: CredentialDraft): string {
  const token = draft.token.trim();
  if (channelId !== "slack" || !token || token.includes("/")) return token;
  const appToken = usableExtras(draft.extras).find((item) => /app[ -]?token|xapp|socket/i.test(item.label))?.value.trim() ?? "";
  if (!appToken) return token;
  return `${token}/${appToken}`;
}

/** Primary token, or a WhatsApp Cloud token supplied only in the optional extras. */
export function connectTokenFor(channelId: string, draft: CredentialDraft): string {
  const primary = composeConnectToken(channelId, draft);
  if (primary || channelId !== "whatsapp") return primary;
  return usableExtras(draft.extras).find((item) => /cloud|graph|whatsapp api/i.test(item.label))?.value.trim() ?? "";
}

/** Owner id plus any optional extra sender ids. Values are never invented. */
export function allowlistFromDraft(draft: CredentialDraft): string[] {
  const ids = [draft.ownerId.trim()];
  for (const extra of usableExtras(draft.extras)) {
    if (/sender|owner|allowlist|chat id|user id/i.test(extra.label)) ids.push(extra.value.trim());
  }
  return [...new Set(ids.filter(Boolean))];
}

/** Channels whose connect path is a phone scan rather than a bot token. */
export function channelUsesQrPairing(channelId: string): boolean {
  return channelId === "whatsapp" || channelId === "signal" || channelId === "wechat" || channelId === "bluebubbles";
}

export function pairingUri(channelId: string, code: string): string {
  return `ronic://gateway/pair?channel=${encodeURIComponent(channelId)}&code=${encodeURIComponent(code)}`;
}

export function newPairingCode(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Browser-preview fallback for the command simulator: mirrors the Rust
 * `dispatch_command` firewall when the Tauri backend is unreachable, so the
 * strict "only-if-connected" rule still demonstrates correctly.
 * Returns null when the command should be treated as executed.
 */
export function localCommandVerdict(
  channel: Pick<GatewayChannel, "status" | "enabled">,
): "blocked" | "executed" {
  return canSendPush(channel) ? "executed" : "blocked";
}
