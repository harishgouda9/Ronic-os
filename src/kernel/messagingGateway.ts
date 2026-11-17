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
  /** Owner saved by the desktop listener. Empty until one is set or adopted. */
  owner_id?: string | null;
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

/**
 * A channel the backend reports as Connected is enabled. The screen remounts
 * with `enabled: false` while the listener is still running, and the push /
 * route checks require both. Awaiting a QR scan stays disabled.
 */
export function syncChannelFromLive<T extends { status: GatewayChannelStatus; enabled: boolean; conflictError?: string }>(
  channel: T,
  live: { state: LiveGatewayState; error: string | null },
): T {
  return {
    ...channel,
    status: liveStateToStatus(live.state),
    enabled: live.state === "Connected",
    conflictError: live.error ?? undefined,
  };
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

/** Why a push or routed command was refused. Never calls a connected channel "not connected". */
export function pushBlockReason(channel: Pick<GatewayChannel, "status" | "enabled">): string {
  if (channel.status === "connected" && channel.enabled) return "";
  if (channel.status === "connected") {
    return "the listener is connected, but this screen has not enabled the channel yet";
  }
  return `the channel is '${channel.status}'`;
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
  const namedDefault = channel.defaultBot.trim().toLowerCase();
  let chosen = mention ? byHandle.get(mention[1].toLowerCase()) : byHandle.get(namedDefault);
  // One bot switched on for this channel is the default. A second switch is
  // not required before a message with no @mention can be delivered.
  if (!mention && !chosen && channel.routableBots.length === 1) {
    chosen = byHandle.get(channel.routableBots[0].trim().toLowerCase());
  }
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

/** Numeric id plus the @username carried in a platform display string. */
export function senderAliases(senderId: string, senderDisplay: string): string[] {
  const found: string[] = [];
  const add = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (found.some((item) => item.toLowerCase() === trimmed.toLowerCase())) return;
    found.push(trimmed);
  };
  add(senderId);
  const named = senderDisplay.match(/@([A-Za-z0-9_]{4,})/);
  if (named) {
    add(`@${named[1]}`);
    add(named[1]);
  }
  return found;
}

/** True when the sender's numeric id or @username is on the allowlist. */
export function senderOnAllowlist(allow: string[], senderId: string, senderDisplay: string): boolean {
  const aliases = senderAliases(senderId, senderDisplay);
  return allow.some((entry) => {
    const raw = entry.trim();
    if (!raw) return false;
    return aliases.some((alias) => alias.toLowerCase() === raw.toLowerCase());
  });
}

export type InboundAccess =
  | { ok: true; allow: string[]; adoptedOwnerId: string | null }
  | { ok: false; reason: string };

/**
 * Empty allowlist adopts the first real sender and keeps them.
 * A saved owner still blocks everyone else. Matching accepts the numeric id
 * or the @username shown by the platform.
 */
export function decideInboundAccess(
  allow: string[],
  senderId: string,
  senderDisplay: string,
): InboundAccess {
  const sender = senderId.trim();
  let next = allow.map((item) => item.trim()).filter(Boolean);
  let adoptedOwnerId: string | null = null;
  if (!next.length) {
    if (!sender) {
      return { ok: false, reason: "message from unknown is not on the owner allowlist" };
    }
    next = [sender];
    adoptedOwnerId = sender;
  }
  if (!senderOnAllowlist(next, sender, senderDisplay)) {
    return { ok: false, reason: `message from ${sender || "unknown"} is not on the owner allowlist` };
  }
  return { ok: true, allow: next, adoptedOwnerId };
}

export const GATEWAY_ALLOWLIST_KEY = "ronic.gateway.allowlist.v1";

export type BlockedSender = { senderId: string; senderDisplay: string };

type AllowlistFile = {
  lists?: Record<string, unknown>;
  blocked?: Record<string, { senderId?: unknown; senderDisplay?: unknown }>;
};

/** Drops blanks and repeated ids. Comparison ignores case, so @Name and @name are one entry. */
export function normalizeOwnerIds(ids: string[]): string[] {
  const out: string[] = [];
  for (const id of ids) {
    const trimmed = id.trim();
    if (!trimmed) continue;
    if (out.some((item) => item.toLowerCase() === trimmed.toLowerCase())) continue;
    out.push(trimmed);
  }
  return out;
}

/**
 * A saved list is the list the inbox uses, including an explicit empty list.
 * No saved list falls back to the owner remembered by the connected gateway.
 */
export function effectiveOwnerAllowlist(saved: string[] | null, liveOwnerId: string): string[] {
  if (saved) return normalizeOwnerIds(saved);
  const live = liveOwnerId.trim();
  return live ? [live] : [];
}

/** Adds one id. An empty current list keeps the live owner so Allow does not lock them out. */
export function withAllowedOwner(current: string[], liveOwnerId: string, nextId: string): string[] {
  const live = liveOwnerId.trim();
  const base = current.length ? current : (live ? [live] : []);
  return normalizeOwnerIds([...base, nextId]);
}

export function withoutAllowedOwner(current: string[], ownerId: string): string[] {
  const drop = ownerId.trim().toLowerCase();
  if (!drop) return normalizeOwnerIds(current);
  return normalizeOwnerIds(current).filter((item) => item.toLowerCase() !== drop);
}

/** Told to the person who was refused, so they know which control unlocks the bot. */
export function ownerAllowlistRefusal(reason: string): string {
  return `${reason}. Open Owner allowlist in the message gateway and press Allow, then send this again.`;
}

function readAllowlistFile(): AllowlistFile {
  try {
    const raw = localStorage.getItem(GATEWAY_ALLOWLIST_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as AllowlistFile;
  } catch {
    return {};
  }
}

function writeAllowlistFile(file: AllowlistFile) {
  try {
    localStorage.setItem(GATEWAY_ALLOWLIST_KEY, JSON.stringify(file));
  } catch {
    // The in-memory gateway still has this turn. The button can be pressed again.
  }
}

function idsFromUnknown(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return normalizeOwnerIds(value.filter((item): item is string => typeof item === "string"));
}

/** `null` means this channel has never saved a list. An array, even empty, is explicit. */
export function savedOwnerAllowlist(channelId: string): string[] | null {
  const lists = readAllowlistFile().lists;
  if (!lists || !Object.prototype.hasOwnProperty.call(lists, channelId)) return null;
  return idsFromUnknown(lists[channelId]);
}

/** The ids the inbox checks for this channel. */
export function inboundAllowlist(channelId: string, liveOwnerId: string): string[] {
  return effectiveOwnerAllowlist(savedOwnerAllowlist(channelId), liveOwnerId);
}

/**
 * Adopt only when this channel has never saved a list and the live owner is empty.
 * A saved empty list means nobody is allowed.
 */
export function inboundAccess(channelId: string, liveOwnerId: string, senderId: string, senderDisplay: string): InboundAccess {
  const saved = savedOwnerAllowlist(channelId);
  if (saved && normalizeOwnerIds(saved).length === 0) {
    const sender = senderId.trim() || "unknown";
    return { ok: false, reason: `message from ${sender} is not on the owner allowlist` };
  }
  return decideInboundAccess(effectiveOwnerAllowlist(saved, liveOwnerId), senderId, senderDisplay);
}

export function writeOwnerAllowlist(channelId: string, ids: string[]): string[] {
  const next = normalizeOwnerIds(ids);
  const file = readAllowlistFile();
  writeAllowlistFile({ ...file, lists: { ...(file.lists ?? {}), [channelId]: next } });
  return next;
}

export function allowOwner(channelId: string, liveOwnerId: string, ownerId: string): string[] {
  const saved = savedOwnerAllowlist(channelId);
  return writeOwnerAllowlist(channelId, withAllowedOwner(saved ?? [], liveOwnerId, ownerId));
}

export function removeAllowedOwner(channelId: string, liveOwnerId: string, ownerId: string): string[] {
  const saved = savedOwnerAllowlist(channelId);
  const base = saved ?? effectiveOwnerAllowlist(null, liveOwnerId);
  return writeOwnerAllowlist(channelId, withoutAllowedOwner(base, ownerId));
}

export function rememberBlockedSender(channelId: string, senderId: string, senderDisplay: string) {
  const sender = senderId.trim();
  if (!sender) return;
  const file = readAllowlistFile();
  writeAllowlistFile({
    ...file,
    blocked: {
      ...(file.blocked ?? {}),
      [channelId]: { senderId: sender, senderDisplay: senderDisplay.trim() },
    },
  });
}

export function lastBlockedSender(channelId: string): BlockedSender | null {
  const row = readAllowlistFile().blocked?.[channelId];
  const senderId = typeof row?.senderId === "string" ? row.senderId.trim() : "";
  if (!senderId) return null;
  const senderDisplay = typeof row?.senderDisplay === "string" ? row.senderDisplay.trim() : "";
  return { senderId, senderDisplay };
}

export function clearBlockedSender(channelId: string, senderId: string) {
  const file = readAllowlistFile();
  const row = file.blocked?.[channelId];
  const stored = typeof row?.senderId === "string" ? row.senderId.trim().toLowerCase() : "";
  if (!stored || stored !== senderId.trim().toLowerCase()) return;
  const blocked = { ...(file.blocked ?? {}) };
  delete blocked[channelId];
  writeAllowlistFile({ ...file, blocked });
}

export const GATEWAY_ROUTE_KEY = "ronic.gateway.routing.v1";

/** Routing saved by the messaging screen. The inbox listener reads this on every screen. */
export function storedGatewayRoute(channelId: string): { defaultBot: string; routableBots: string[] } {
  try {
    const raw = localStorage.getItem(GATEWAY_ROUTE_KEY);
    if (!raw) return { defaultBot: "", routableBots: [] };
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return { defaultBot: "", routableBots: [] };
    const saved = (parsed as Record<string, { defaultBot?: unknown; routableBots?: unknown }>)[channelId];
    if (!saved) return { defaultBot: "", routableBots: [] };
    const routableBots = Array.isArray(saved.routableBots)
      ? saved.routableBots.filter((item): item is string => typeof item === "string")
      : [];
    return {
      defaultBot: typeof saved.defaultBot === "string" ? saved.defaultBot : "",
      routableBots,
    };
  } catch {
    return { defaultBot: "", routableBots: [] };
  }
}

/** Assistant text produced by this gateway turn. Older bubbles and thinking steps stay out. */
export function gatewayAssistantReply(
  steps: { id: string; threadId: string; role: string; actionType: string; contentMarkdown: string }[],
  threadId: string,
  beforeIds: ReadonlySet<string>,
): string {
  if (!threadId) return "";
  return steps
    .filter((step) =>
      step.threadId === threadId
      && !beforeIds.has(step.id)
      && step.role === "assistant"
      && step.actionType === "message"
      && step.contentMarkdown.trim())
    .map((step) => step.contentMarkdown.trim())
    .join("\n\n");
}

export function channelAcceptsReply(channelId: string): boolean {
  return channelId === "telegram" || channelId === "discord" || channelId === "slack";
}

/** Telegram's sender parses Markdown. A model reply with `_` or `*` is rejected unless these are escaped. */
export function telegramMarkdownSafe(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/([_*`[])/g, "\\$1");
}

function splitOutbound(text: string, limit: number): string[] {
  const clean = text.trim();
  if (!clean) return [];
  const parts: string[] = [];
  let rest = clean;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < Math.floor(limit / 2)) cut = limit;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

/** Pieces that fit a channel send. Telegram text is escaped for the desktop sender's Markdown mode. */
export function outboundChannelChunks(channelId: string, text: string): string[] {
  const limit = channelId === "discord" ? 1800 : 2000;
  const parts = splitOutbound(text, limit);
  if (channelId !== "telegram") return parts;
  return parts.map(telegramMarkdownSafe).filter((part) => part.trim().length > 0);
}

/** Copy shown next to the WhatsApp QR. The phone must scan it from Linked devices. */
export function whatsappLinkInstructions(): string {
  return "On your phone open WhatsApp, then Linked devices, then Link a device, and scan this code. WhatsApp's scanner rejects a web link as not a valid QR code. The code refreshes on its own. This links this computer as a companion device, and WhatsApp can restrict unofficial linked devices.";
}

/** Channels whose connect path is a phone scan rather than a bot token. */
export function channelUsesQrPairing(channelId: string): boolean {
  return channelId === "whatsapp" || channelId === "signal" || channelId === "wechat" || channelId === "bluebubbles";
}

/** Browser-preview copy of the vault file. The desktop app stores this in the vault. */
export const GATEWAY_CREDENTIALS_KEY = "ronic.gateway.credentials.v1";

export interface SavedGatewayCredential {
  token: string;
  ownerId: string;
  extras: ExtraCredential[];
  reconnect: boolean;
}

const TELEGRAM_BOT_TOKEN = /(\d{6,12}:[A-Za-z0-9_-]{30,})/;
const SLACK_TOKEN = /(xox[baprs]-[A-Za-z0-9-]{10,})/;
const DISCORD_TOKEN = /([A-Za-z0-9_-]{24,32}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,})/;

function cleanExtras(extras: ExtraCredential[] | undefined): ExtraCredential[] {
  return usableExtras(extras).slice(0, 8).map((item) => ({
    id: item.id || `extra_${item.label}`,
    label: item.label.trim().slice(0, 80),
    value: item.value.trim().slice(0, 4000),
  }));
}

/** Reads a saved credential file. Unknown shapes become an empty file. */
export function parseSavedCredentials(raw: unknown): Record<string, SavedGatewayCredential> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const file: Record<string, SavedGatewayCredential> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[a-z0-9_]{1,32}$/.test(id) || !value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as { token?: unknown; ownerId?: unknown; extras?: unknown; reconnect?: unknown };
    const extras = Array.isArray(row.extras) ? cleanExtras(row.extras as ExtraCredential[]) : [];
    file[id] = {
      token: typeof row.token === "string" ? row.token.trim().slice(0, 4000) : "",
      ownerId: typeof row.ownerId === "string" ? row.ownerId.trim().slice(0, 200) : "",
      extras,
      reconnect: row.reconnect === true,
    };
  }
  return file;
}

/**
 * Writes one channel into the saved file. An empty draft removes that channel
 * unless WhatsApp is only remembering a linked-device session.
 */
export function upsertSavedCredential(
  file: Record<string, SavedGatewayCredential>,
  channelId: string,
  draft: CredentialDraft,
  reconnect?: boolean,
): Record<string, SavedGatewayCredential> {
  if (!/^[a-z0-9_]{1,32}$/.test(channelId)) return file;
  const previous = file[channelId];
  const token = draft.token.trim().slice(0, 4000);
  const ownerId = draft.ownerId.trim().slice(0, 200);
  const extras = cleanExtras(draft.extras);
  const nextReconnect = reconnect ?? previous?.reconnect ?? false;
  const next = { ...file };
  if (!token && !ownerId && extras.length === 0 && !(channelId === "whatsapp" && nextReconnect)) {
    delete next[channelId];
    return next;
  }
  next[channelId] = { token, ownerId, extras, reconnect: nextReconnect };
  return next;
}

/** Fills empty channel fields from the saved file. A typed token is left alone. */
export function applyStoredCredentials<T extends { id: string; botTokenMasked: string; ownerUserId: string; extraCredentials?: ExtraCredential[] }>(
  channels: T[],
  saved: Record<string, SavedGatewayCredential>,
): T[] {
  return channels.map((channel) => {
    const row = saved[channel.id];
    if (!row) return channel;
    if (channel.botTokenMasked.trim() || channel.ownerUserId.trim() || (channel.extraCredentials ?? []).length > 0) return channel;
    return {
      ...channel,
      botTokenMasked: row.token,
      ownerUserId: row.ownerId,
      extraCredentials: row.extras,
    };
  });
}

export function draftsFromSaved(saved: Record<string, SavedGatewayCredential>): Record<string, CredentialDraft> {
  const drafts: Record<string, CredentialDraft> = {};
  for (const [id, row] of Object.entries(saved)) {
    if (!row.token && !row.ownerId && row.extras.length === 0) continue;
    drafts[id] = { token: row.token, ownerId: row.ownerId, extras: row.extras };
  }
  return drafts;
}

/** WhatsApp's linked-device payload. Current codes have five fields; older ones have four. */
export function isWhatsAppCompanionCode(raw: string): boolean {
  let code = raw.trim();
  const marker = "wa.me/settings/linked_devices#";
  const at = code.indexOf(marker);
  if (at >= 0) code = code.slice(at + marker.length);
  let parts = code.split(",");
  const last = parts[parts.length - 1] ?? "";
  if (last.startsWith("https://faq.whatsapp.com/") || last.startsWith("http://faq.whatsapp.com/")) {
    parts = parts.slice(0, -1);
  }
  if (parts.some((part) => part.includes("://"))) return false;
  if (parts.length !== 4 && parts.length !== 5) return false;
  const reference = parts[0] ?? "";
  if (reference.length < 4 || reference.length > 400 || !/^[\x21-\x7E]+$/.test(reference)) return false;
  const base64 = /^[A-Za-z0-9+/=]+$/;
  for (const part of parts.slice(1, 4)) {
    if (!base64.test(part) || part.length < 20 || part.length > 400) return false;
  }
  return parts.length === 4 || /^[A-Za-z0-9]$/.test(parts[4] ?? "");
}

export type ScannedGatewayCode =
  | { ok: true; channelId: string; token: string; kind: "bot_token" | "whatsapp_link"; note: string }
  | { ok: false; reason: string };

/**
 * Reads a QR payload from Telegram, WhatsApp, or another gateway.
 * A bot token is saved for that channel. A WhatsApp link code is shown for the phone to scan.
 */
export function interpretScannedGatewayQr(text: string, preferredChannelId = ""): ScannedGatewayCode {
  const raw = text.trim();
  if (!raw) return { ok: false, reason: "That QR code is empty." };
  if (isWhatsAppCompanionCode(raw)) {
    return {
      ok: true,
      channelId: "whatsapp",
      token: raw,
      kind: "whatsapp_link",
      note: "This is a WhatsApp linked-device code. On the phone open WhatsApp, then Linked devices, then Link a device, and scan the code now on screen.",
    };
  }
  if (/\/pair\?/.test(raw) && /channel=/.test(raw)) {
    return { ok: false, reason: "That QR opens a page on this computer. It is not a Telegram or WhatsApp login code." };
  }
  const telegram = raw.match(TELEGRAM_BOT_TOKEN);
  if (telegram) {
    return {
      ok: true,
      channelId: "telegram",
      token: telegram[1],
      kind: "bot_token",
      note: "Telegram bot token read from the QR. It is saved on this computer.",
    };
  }
  if (/^tg:\/\/login/i.test(raw) || /web\.telegram\.org/i.test(raw)) {
    return { ok: false, reason: "That QR logs in a Telegram user. Ronic OS connects a bot. Open @BotFather and scan the QR that contains the bot token." };
  }
  const slack = raw.match(SLACK_TOKEN);
  if (slack) {
    return { ok: true, channelId: "slack", token: slack[1], kind: "bot_token", note: "Slack token read from the QR. It is saved on this computer." };
  }
  const discord = raw.match(DISCORD_TOKEN);
  if (discord) {
    return { ok: true, channelId: "discord", token: discord[1], kind: "bot_token", note: "Discord token read from the QR. It is saved on this computer." };
  }
  const preferred = preferredChannelId.trim().toLowerCase();
  const oneLine = !raw.includes("\n") && !raw.includes(" ") && raw.length >= 8 && raw.length <= 4000;
  if (preferred && /^[a-z0-9_]{1,32}$/.test(preferred) && oneLine && !raw.includes("://")) {
    return {
      ok: true,
      channelId: preferred,
      token: raw,
      kind: "bot_token",
      note: "Token read from the QR. It is saved on this computer.",
    };
  }
  return { ok: false, reason: "That QR is not a bot token or a WhatsApp link code. Paste the token, or scan the code the gateway itself shows." };
}

/**
 * Same-network confirm page. A phone camera opens http(s) links. A custom
 * ronic:// code does not complete pairing.
 */
export function pairingUri(channelId: string, code: string, host = "127.0.0.1:9"): string {
  return `http://${host}/pair?channel=${encodeURIComponent(channelId)}&code=${encodeURIComponent(code)}`;
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
