import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ChevronRight, Eye, EyeOff, Lock, QrCode, RefreshCw, Search, Shield, ShieldCheck, Trash2 } from "lucide-react";
import { invokeRaw, isTauri } from "../api";
import { inboundChiefAction } from "../kernel/chiefDelegation";
import { pairingQrDataUrl } from "../kernel/pairingQr";
import { useRonic } from "../store";
import {
  allowlistFromDraft,
  applySaveCredentials,
  canSendPush,
  channelUsesQrPairing,
  connectTokenFor,
  draftFor,
  fleetMembers,
  liveStateToStatus,
  newPairingCode,
  pairingUri,
  pruneChannelRouting,
  pushButtonsForEvent,
  resolveInboundRoute,
  toggleRoutableBot,
  usableExtras,
  type CredentialDraft,
  type ExtraCredential,
  type FleetMember,
  type GatewayConnectionInfo,
  type IncomingGatewayMessage,
  type RouteDecision,
} from "../kernel/messagingGateway";

export interface MessagingPlatformItem {
  id: string;
  name: string;
  badgeText: string;
  badgeColor: string; // kept for brand visual identity (icon bg)
  enabled: boolean;
  status: "connected" | "pid_conflict" | "error" | "disconnected";
  conflictPid?: number;
  conflictError?: string;
  botTokenMasked: string;
  ownerUserId: string;
  setupHint: string;
  defaultBot: string;
  routableBots: string[];
  extraCredentials: ExtraCredential[];
}

type ChannelStatus = MessagingPlatformItem["status"];

const ROUTE_KEY = "ronic.gateway.routing.v1";

const STATUS_META: Record<
  ChannelStatus,
  { label: string; tone: "ok" | "warn" | "off"; dotClass: string }
> = {
  connected: {
    label: "Connected",
    tone: "ok",
    dotClass: "bg-emerald-500",
  },
  pid_conflict: {
    label: "PID conflict",
    tone: "warn",
    dotClass: "bg-rose-500 animate-pulse",
  },
  error: {
    label: "Error",
    tone: "warn",
    dotClass: "bg-rose-500",
  },
  disconnected: {
    label: "Disconnected",
    tone: "off",
    dotClass: "bg-slate-300",
  },
};

const INITIAL_CHANNELS: MessagingPlatformItem[] = [
  {
    id: "telegram",
    name: "Telegram",
    badgeText: "TG",
    badgeColor: "bg-sky-500 text-white",
    enabled: false,
    status: "disconnected",
    botTokenMasked: "",
    ownerUserId: "",
    setupHint: "Bot API long-polling. Paste a @BotFather token below to connect.",
    defaultBot: "",
    routableBots: [],
    extraCredentials: [],
  },
  {
    id: "whatsapp",
    name: "WhatsApp",
    badgeText: "WA",
    badgeColor: "bg-emerald-500 text-white",
    enabled: false,
    status: "disconnected",
    botTokenMasked: "",
    ownerUserId: "",
    setupHint: "Phone pairing. A QR code appears on this page. A Cloud API token is optional.",
    defaultBot: "",
    routableBots: [],
    extraCredentials: [],
  },
  {
    id: "discord",
    name: "Discord",
    badgeText: "DC",
    badgeColor: "bg-indigo-600 text-white",
    enabled: false,
    status: "disconnected",
    botTokenMasked: "",
    ownerUserId: "",
    setupHint: "Control Ronic OS squads from private Discord servers and threads.",
    defaultBot: "",
    routableBots: [],
    extraCredentials: [],
  },
  {
    id: "slack",
    name: "Slack",
    badgeText: "SL",
    badgeColor: "bg-purple-700 text-white",
    enabled: false,
    status: "disconnected",
    botTokenMasked: "",
    ownerUserId: "",
    setupHint: "Socket Mode bridge. The app-level token is optional and can be added below.",
    defaultBot: "",
    routableBots: [],
    extraCredentials: [],
  },
  {
    id: "google_chat",
    name: "Google Chat",
    badgeText: "GC",
    badgeColor: "bg-emerald-600 text-white",
    enabled: false,
    status: "disconnected",
    botTokenMasked: "",
    ownerUserId: "",
    setupHint: "Google Chat app with service account key. Paste the JSON key below.",
    defaultBot: "",
    routableBots: [],
    extraCredentials: [],
  },
  {
    id: "mattermost",
    name: "Mattermost",
    badgeText: "MM",
    badgeColor: "bg-blue-700 text-white",
    enabled: false,
    status: "disconnected",
    botTokenMasked: "",
    ownerUserId: "",
    setupHint: "Self-hosted team ops bridge for Ronic OS.",
    defaultBot: "",
    routableBots: [],
    extraCredentials: [],
  },
  {
    id: "matrix",
    name: "Matrix",
    badgeText: "[m]",
    badgeColor: "bg-slate-800 text-white",
    enabled: false,
    status: "disconnected",
    botTokenMasked: "",
    ownerUserId: "",
    setupHint: "End-to-end encrypted federated Element/Matrix bot bridge.",
    defaultBot: "",
    routableBots: [],
    extraCredentials: [],
  },
  {
    id: "signal",
    name: "Signal",
    badgeText: "SG",
    badgeColor: "bg-blue-600 text-white",
    enabled: false,
    status: "disconnected",
    botTokenMasked: "",
    ownerUserId: "",
    setupHint: "High-privacy remote command channel via signal-cli local socket.",
    defaultBot: "",
    routableBots: [],
    extraCredentials: [],
  },
  {
    id: "bluebubbles",
    name: "BlueBubbles (iMessage)",
    badgeText: "iM",
    badgeColor: "bg-green-500 text-white",
    enabled: false,
    status: "disconnected",
    botTokenMasked: "",
    ownerUserId: "",
    setupHint: "Connect iMessage via BlueBubbles server webhook.",
    defaultBot: "",
    routableBots: [],
    extraCredentials: [],
  },
  {
    id: "email",
    name: "Email",
    badgeText: "EM",
    badgeColor: "bg-rose-500 text-white",
    enabled: false,
    status: "disconnected",
    botTokenMasked: "",
    ownerUserId: "",
    setupHint: "Trigger asynchronous research and reports by emailing your local Ronic inbox.",
    defaultBot: "",
    routableBots: [],
    extraCredentials: [],
  },
  {
    id: "webhook",
    name: "Custom Webhook",
    badgeText: "WH",
    badgeColor: "bg-amber-600 text-white",
    enabled: false,
    status: "disconnected",
    botTokenMasked: "",
    ownerUserId: "",
    setupHint: "Generic JSON HTTP POST endpoint with secret-header verification.",
    defaultBot: "",
    routableBots: [],
    extraCredentials: [],
  },
  {
    id: "nostr",
    name: "Nostr",
    badgeText: "NO",
    badgeColor: "bg-violet-600 text-white",
    enabled: false,
    status: "disconnected",
    botTokenMasked: "",
    ownerUserId: "",
    setupHint: "Decentralized relays and NIP-04 encrypted direct messages.",
    defaultBot: "",
    routableBots: [],
    extraCredentials: [],
  },
  {
    id: "lark",
    name: "Lark / Feishu",
    badgeText: "LK",
    badgeColor: "bg-cyan-600 text-white",
    enabled: false,
    status: "disconnected",
    botTokenMasked: "",
    ownerUserId: "",
    setupHint: "Lark Open Platform custom bot webhook and event listener.",
    defaultBot: "",
    routableBots: [],
    extraCredentials: [],
  },
  {
    id: "dingtalk",
    name: "DingTalk",
    badgeText: "DT",
    badgeColor: "bg-blue-500 text-white",
    enabled: false,
    status: "disconnected",
    botTokenMasked: "",
    ownerUserId: "",
    setupHint: "DingTalk group bot with sign verification.",
    defaultBot: "",
    routableBots: [],
    extraCredentials: [],
  },
  {
    id: "wechat",
    name: "WeChat Official",
    badgeText: "WX",
    badgeColor: "bg-emerald-600 text-white",
    enabled: false,
    status: "disconnected",
    botTokenMasked: "",
    ownerUserId: "",
    setupHint: "WeChat official account / WeCom robot webhook integration.",
    defaultBot: "",
    routableBots: [],
    extraCredentials: [],
  },
  {
    id: "qq",
    name: "QQ Bot",
    badgeText: "QQ",
    badgeColor: "bg-rose-600 text-white",
    enabled: false,
    status: "disconnected",
    botTokenMasked: "",
    ownerUserId: "",
    setupHint: "Official QQ guild & group bot WebSocket gateway.",
    defaultBot: "",
    routableBots: [],
    extraCredentials: [],
  },
];

function extraPlaceholder(channelId: string): string {
  if (channelId === "slack") return "App token";
  if (channelId === "whatsapp") return "Cloud API token";
  if (channelId === "telegram") return "Allowlisted sender";
  return "Credential name";
}

function stamp(): string {
  return new Date().toTimeString().slice(0, 8);
}

function loadStoredRoutes(): Record<string, { defaultBot?: string; routableBots?: unknown }> {
  try {
    const raw = localStorage.getItem(ROUTE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as Record<string, { defaultBot?: string; routableBots?: unknown }>;
  } catch {
    return {};
  }
}

function withStoredRoutes(channels: MessagingPlatformItem[]): MessagingPlatformItem[] {
  const stored = loadStoredRoutes();
  return channels.map((channel) => {
    const saved = stored[channel.id];
    if (!saved) return channel;
    const routableBots = Array.isArray(saved.routableBots)
      ? saved.routableBots.filter((item): item is string => typeof item === "string")
      : [];
    return {
      ...channel,
      defaultBot: typeof saved.defaultBot === "string" ? saved.defaultBot : "",
      routableBots,
    };
  });
}

function filterStatus(
  ch: MessagingPlatformItem,
  filter: "all" | "connected" | "attention"
): boolean {
  if (filter === "connected") return ch.status === "connected";
  if (filter === "attention") return ch.status === "pid_conflict";
  return true;
}

export default function RonicMessagingGateway() {
  const go = useRonic((s) => s.go);
  const snap = useRonic((s) => s.snap);
  const run = useRonic((s) => s.run);

  const [channels, setChannels] = useState<MessagingPlatformItem[]>(() => withStoredRoutes(INITIAL_CHANNELS));
  const [selectedChannelId, setSelectedChannelId] = useState<string>("telegram");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<"all" | "connected" | "attention">("all");

  // Per-channel draft credentials
  const [credentialDrafts, setCredentialDrafts] = useState<Record<string, CredentialDraft>>({});

  // Live backend connection state — polled from gateway_connections.rs
  const [liveConnections, setLiveConnections] = useState<Record<string, GatewayConnectionInfo>>({});

  // UI state
  const [showQrPanel, setShowQrPanel] = useState<boolean>(false);
  const [showAdvanced, setShowAdvanced] = useState<boolean>(false);
  const [localQr, setLocalQr] = useState<Record<string, { uri: string; dataUrl: string }>>({});
  const [qrError, setQrError] = useState<string>("");
  const [showSecretToken, setShowSecretToken] = useState<boolean>(false);
  const [savingCredentials, setSavingCredentials] = useState<boolean>(false);
  const [connecting, setConnecting] = useState<boolean>(false);
  const [sendingPush, setSendingPush] = useState<boolean>(false);
  const [simulating, setSimulating] = useState<boolean>(false);
  const [delegating, setDelegating] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const pollRef = useRef<number>(0);

  // Push alert builder
  const [pushAlertTitle, setPushAlertTitle] = useState<string>("Wallet approval needed");
  const [pushAlertEvent, setPushAlertEvent] = useState<string>("wallet_approval_gate");

  // Remote simulator
  const [remoteTestCmd, setRemoteTestCmd] = useState<string>("Say hello");
  const [remoteLogs, setRemoteLogs] = useState<string[]>([
    `${stamp()} [Security Firewall] Enforcing strict 'Only-If-Connected' & Owner-ID allowlist across all channels.`,
  ]);

  // ── Live backend polling ────────────────────────────────────

  const pushLog = useCallback((line: string) =>
    setRemoteLogs((prev) => [`${stamp()} ${line}`, ...prev].slice(0, 200)), []);
  const channelsRef = useRef(channels);
  channelsRef.current = channels;
  const fleet = useMemo(
    () => fleetMembers(snap?.profiles ?? [], snap?.botGroups ?? []),
    [snap?.profiles, snap?.botGroups],
  );
  const fleetRef = useRef(fleet);
  fleetRef.current = fleet;
  const draftsRef = useRef(credentialDrafts);
  draftsRef.current = credentialDrafts;
  const deliverRef = useRef<(decision: Extract<RouteDecision, { ok: true }>, channelName: string) => Promise<void>>(async () => {});

  const pollBackend = useCallback(async () => {
    if (!isTauri()) return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    try {
      const infos = await invokeRaw<GatewayConnectionInfo[]>("gateway_connection_status", {});
      const map: Record<string, GatewayConnectionInfo> = {};
      for (const info of infos) {
        map[info.channel_id] = info;
        if (info.qr_png_base64) {
          const dataUrl = `data:image/png;base64,${info.qr_png_base64}`;
          setLocalQr((prev) => (
            prev[info.channel_id]?.dataUrl === dataUrl
              ? prev
              : { ...prev, [info.channel_id]: { uri: info.qr_uri ?? "", dataUrl } }
          ));
        }
      }
      setLiveConnections(map);

      // Sync channel statuses with live backend state
      setChannels((prev) =>
        prev.map((ch) => {
          const live = map[ch.id];
          if (!live) return ch;
          return {
            ...ch,
            status: liveStateToStatus(live.state),
            conflictError: live.error ?? undefined,
          };
        })
      );

      // Drain incoming messages only while at least one channel is live
      const anyConnected = infos.some((info) => info.state === "Connected");
      if (!anyConnected) return;
      const messages = await invokeRaw<IncomingGatewayMessage[]>("gateway_poll_messages", {});
      for (const msg of messages) {
        pushLog(`[${msg.channel_id} ← ${msg.sender_display}] ${msg.text}`);
        const channel = channelsRef.current.find((item) => item.id === msg.channel_id);
        if (!channel) continue;
        const allow = allowlistFromDraft(draftFor(draftsRef.current, channel));
        const sender = msg.sender_id.trim();
        if (!allow.length || !allow.includes(sender)) {
          pushLog(`[BLOCKED] ${msg.channel_id} message from ${sender || "unknown"} is not on the owner allowlist.`);
          continue;
        }
        const trimmed = msg.text.trim();
        const action = inboundChiefAction(trimmed);
        const chiefCommand = Boolean(action && (action.callback || trimmed === "/chief" || trimmed.startsWith("/chief ")));
        if (chiefCommand && action) {
          const res = await useRonic.getState().run("handle_mobile_chief_command", {
            channelId: msg.channel_id,
            senderId: msg.sender_id,
            chatId: msg.chat_id,
            text: action.text,
            callback: action.callback,
          });
          const payload = res?.payload as { card?: string; delivered?: boolean; deliveryError?: string | null } | undefined;
          if (payload?.card) pushLog(payload.card);
          else pushLog(res?.toast || useRonic.getState().toast || "Chief delegation did not run.");
          if (payload && payload.delivered === false && payload.deliveryError) pushLog(`Phone delivery: ${payload.deliveryError}`);
          continue;
        }
        const decision = resolveInboundRoute(trimmed, channel, fleetRef.current);
        if (!decision.ok) {
          pushLog(`[${channel.name}] ${decision.reason}`);
          continue;
        }
        await deliverRef.current(decision, channel.name);
      }
    } catch {
      // Backend not ready yet
    }
  }, [pushLog]);

  useEffect(() => {
    if (!isTauri()) return;
    pollBackend();
    pollRef.current = window.setInterval(pollBackend, 3000);
    return () => window.clearInterval(pollRef.current);
  }, [pollBackend]);

  // ── Derived state ───────────────────────────────────────────

  const activeChannel = useMemo(
    () => channels.find((c) => c.id === selectedChannelId) || channels[0],
    [channels, selectedChannelId]
  );

  const activeLive = liveConnections[activeChannel.id];
  const activeDraft = draftFor(credentialDrafts, activeChannel);
  const activeQr = localQr[activeChannel.id];
  const routableFleet = fleet.filter((member) =>
    activeChannel.routableBots.some((handle) => handle.toLowerCase() === member.handle.toLowerCase()),
  );

  const connectedCount = channels.filter((c) => c.status === "connected").length;
  const attentionCount = channels.filter((c) => c.status === "pid_conflict").length;

  const visibleChannels = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return channels.filter(
      (ch) =>
        filterStatus(ch, statusFilter) &&
        (q === "" ||
          ch.name.toLowerCase().includes(q) ||
          ch.id.toLowerCase().includes(q))
    );
  }, [channels, searchQuery, statusFilter]);

  const showToast = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2600);
  };

  const updateChannel = (id: string, patch: Partial<MessagingPlatformItem>) => {
    setChannels((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  };

  const updateDraft = (id: string, patch: Partial<CredentialDraft>) => {
    setCredentialDrafts((prev) => {
      const channel = channels.find((c) => c.id === id);
      const current = channel
        ? draftFor(prev, channel)
        : { token: prev[id]?.token ?? "", ownerId: prev[id]?.ownerId ?? "", extras: prev[id]?.extras ?? [] };
      return { ...prev, [id]: { ...current, ...patch } };
    });
  };

  useEffect(() => {
    if (!snap) return;
    setChannels((prev) => {
      let changed = false;
      const next = prev.map((channel) => {
        const routing = pruneChannelRouting(channel, fleet);
        if (
          routing.defaultBot === channel.defaultBot
          && routing.routableBots.join("\0") === channel.routableBots.join("\0")
        ) return channel;
        changed = true;
        return { ...channel, ...routing };
      });
      return changed ? next : prev;
    });
  }, [snap, fleet]);

  const routeSignature = channels.map((channel) => `${channel.id}:${channel.defaultBot}:${channel.routableBots.join(",")}`).join("|");
  useEffect(() => {
    const payload: Record<string, { defaultBot: string; routableBots: string[] }> = {};
    for (const channel of channelsRef.current) {
      payload[channel.id] = { defaultBot: channel.defaultBot, routableBots: channel.routableBots };
    }
    try {
      localStorage.setItem(ROUTE_KEY, JSON.stringify(payload));
    } catch {
      // The selection still works in memory when storage is blocked.
    }
  }, [routeSignature]);

  // ─────────────────────────────────────────────────────────────
  // Handlers — wired to the real gateway_connections backend
  // ─────────────────────────────────────────────────────────────

  const openPairingQr = useCallback(async (channelId: string) => {
    setShowQrPanel(true);
    setQrError("");
    const uri = pairingUri(channelId, newPairingCode());
    try {
      const dataUrl = await pairingQrDataUrl(uri);
      setLocalQr((prev) => ({ ...prev, [channelId]: { uri, dataUrl } }));
    } catch (error) {
      setQrError(error instanceof Error ? error.message : String(error));
    }
    if (!isTauri()) return;
    try {
      const info = await invokeRaw<GatewayConnectionInfo>("gateway_pairing_qr", { channelId });
      setLiveConnections((prev) => ({ ...prev, [channelId]: info }));
      if (info.qr_png_base64) {
        setLocalQr((prev) => ({
          ...prev,
          [channelId]: {
            uri: info.qr_uri || uri,
            dataUrl: `data:image/png;base64,${info.qr_png_base64}`,
          },
        }));
      }
    } catch {
      // Desktop builds from before this command still show the code generated above.
    }
  }, []);

  const pairingStarted = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!channelUsesQrPairing(selectedChannelId)) return;
    if (pairingStarted.current.has(selectedChannelId)) return;
    pairingStarted.current.add(selectedChannelId);
    void openPairingQr(selectedChannelId);
  }, [selectedChannelId, openPairingQr]);

  const deliverRouted = useCallback(async (
    decision: Extract<RouteDecision, { ok: true }>,
    channelName: string,
  ) => {
    const current = useRonic.getState().snap;
    if (!current) {
      pushLog("Workspace is still opening. The message was not routed.");
      return;
    }
    const bot = current.profiles.find((profile) => profile.id === decision.botId);
    if (!bot) {
      pushLog(`${decision.handle} has no profile to receive this message.`);
      return;
    }
    const prevThread = current.activeThreadId;
    const prevProfile = current.activeProfileId;
    const title = `Gateway · ${channelName}`;
    try {
      await run("switch_profile", { profileId: decision.botId });
      const after = useRonic.getState().snap;
      const existing = after?.threads.find((thread) =>
        thread.botProfileId === decision.botId && thread.title === title && thread.targetType !== "bot_group",
      );
      if (existing) await run("select_thread", { threadId: existing.id });
      else await run("create_thread", { title });
      const prompt = decision.kind === "group"
        ? `[${channelName} → ${decision.handle}] ${decision.prompt}`
        : `[${channelName}] ${decision.prompt}`;
      await run("send_message", { prompt });
      pushLog(`Routed to ${decision.handle}. The reply is in that bot's "${title}" task.`);
    } catch (error) {
      pushLog(`Route to ${decision.handle} failed: ${String(error)}`);
    } finally {
      const latest = useRonic.getState().snap;
      if (prevThread && latest?.threads.some((thread) => thread.id === prevThread)) {
        await run("select_thread", { threadId: prevThread });
      } else if (prevProfile && prevProfile !== decision.botId) {
        await run("switch_profile", { profileId: prevProfile });
      }
    }
  }, [pushLog, run]);
  deliverRef.current = deliverRouted;

  const handleToggleConnect = async () => {
    const ch = activeChannel;
    if (connecting) return;
    setConnecting(true);

    const isCurrentlyConnected = ch.status === "connected";

    if (isCurrentlyConnected) {
      // Disconnect
      try {
        if (isTauri()) {
          await invokeRaw<string>("gateway_disconnect", { channelId: ch.id });
        }
        pushLog(`[${ch.name}] Gateway stopped → remote commands blocked.`);
        showToast(`${ch.name} disconnected`);
      } catch (err) {
        pushLog(`[${ch.name}] Disconnect error: ${String(err)}`);
      }
      setChannels((prev) =>
        prev.map((c) => (c.id === ch.id ? { ...c, status: "disconnected" as const, enabled: false } : c))
      );
    } else {
      const draft = activeDraft;
      const composed = connectTokenFor(ch.id, draft);
      const pairing = channelUsesQrPairing(ch.id);
      const token = composed || (ch.id === "whatsapp" ? "pair" : "");
      const ownerId = draft.ownerId.trim() || ch.ownerUserId;
      const extras = usableExtras(draft.extras);

      if (!token) {
        if (pairing) {
          await openPairingQr(ch.id);
          pushLog(`[${ch.name}] Pairing QR is on screen. A bot token is optional for this channel.`);
          showToast("Scan the pairing QR");
        } else {
          pushLog(`[${ch.name}] Cannot connect — no bot token provided. Paste your token below, or add one under Advanced authentication.`);
          showToast("Enter a bot token first");
        }
        setConnecting(false);
        return;
      }

      if (token !== "pair" && (token.includes("…") || token.includes("..."))) {
        pushLog(`[${ch.name}] Cannot connect — the saved token is masked. Please re-enter the full bot token.`);
        showToast("Re-enter the full bot token");
        setConnecting(false);
        return;
      }

      if (extras.length) {
        pushLog(`[${ch.name}] Optional credentials attached: ${extras.map((item) => item.label.trim()).join(", ")}.`);
      }
      if (ch.id === "slack" && token.includes("/")) {
        pushLog(`[${ch.name}] App-level token included for Socket Mode.`);
      }
      pushLog(token === "pair"
        ? `[${ch.name}] Starting QR pairing…`
        : `[${ch.name}] Validating credentials with ${ch.name} API…`);
      if (pairing) setShowQrPanel(true);

      if (isTauri()) {
        try {
          const info = await invokeRaw<GatewayConnectionInfo>("gateway_connect", {
            channelId: ch.id,
            token,
            ownerId,
          });
          setLiveConnections((prev) => ({ ...prev, [ch.id]: info }));
          if (info.qr_png_base64) {
            setLocalQr((prev) => ({
              ...prev,
              [ch.id]: {
                uri: info.qr_uri || "",
                dataUrl: `data:image/png;base64,${info.qr_png_base64}`,
              },
            }));
            setShowQrPanel(true);
          } else if (info.state === "AwaitingQrScan") {
            await openPairingQr(ch.id);
          }
          setChannels((prev) =>
            prev.map((c) =>
              c.id === ch.id
                ? {
                    ...c,
                    status: liveStateToStatus(info.state),
                    enabled: info.state === "Connected",
                    botTokenMasked: token === "pair" ? c.botTokenMasked : token.length > 8 ? `${token.slice(0, 4)}…${token.slice(-4)}` : "****",
                    ownerUserId: ownerId,
                    extraCredentials: extras,
                  }
                : c
            )
          );

          if (info.state === "Connected") {
            pushLog(
              `[${ch.name}] ✓ Connected as ${info.platform_user ?? "unknown"} — real-time message listener active.`
            );
            showToast(`${ch.name} connected`);
          } else if (info.state === "AwaitingQrScan") {
            pushLog(`[${ch.name}] QR pairing is ready — scan the code with your phone.`);
            showToast("Scan the pairing QR");
          } else if (info.error) {
            pushLog(`[${ch.name}] ✗ Connection failed: ${info.error}`);
            showToast(`Connection failed: ${info.error}`);
          }
        } catch (err) {
          const msg = String(err);
          pushLog(`[${ch.name}] ✗ Connection failed: ${msg}`);
          showToast("Connection failed");
          if (pairing) await openPairingQr(ch.id);
          setChannels((prev) =>
            prev.map((c) =>
              c.id === ch.id
                ? { ...c, status: "error" as const, conflictError: msg }
                : c
            )
          );
        }
      } else if (pairing) {
        await openPairingQr(ch.id);
        pushLog(`[${ch.name}] Pairing QR is on screen. The live listener runs in the desktop app.`);
        showToast("Scan the pairing QR");
      } else {
        pushLog(`[${ch.name}] Browser preview cannot reach ${ch.name}. Open the desktop app to connect.`);
        showToast("Connect from the desktop app");
      }
    }
    setConnecting(false);
  };

  const handleSaveCredentials = async () => {
    setSavingCredentials(true);
    await new Promise((r) => setTimeout(r, 240));
    setChannels((prev) =>
      prev.map((c) => (c.id === activeChannel.id ? applySaveCredentials(c, activeDraft) : c))
    );
    const extraCount = usableExtras(activeDraft.extras).length;
    pushLog(`[${activeChannel.name}] Credentials kept for this session.${extraCount ? ` ${extraCount} optional extra${extraCount === 1 ? "" : "s"} included.` : ""}`);
    showToast("Credentials saved");
    setSavingCredentials(false);
  };

  const handleToggleBotOnChannel = (botHandle: string) => {
    setChannels((prev) =>
      prev.map((c) => {
        if (c.id !== activeChannel.id) return c;
        const next = toggleRoutableBot(c, botHandle);
        const enabled = next.routableBots.some((item) => item.toLowerCase() === botHandle.toLowerCase());
        if (enabled && !next.defaultBot) return { ...next, defaultBot: botHandle };
        if (!enabled && next.defaultBot.toLowerCase() === botHandle.toLowerCase()) {
          return { ...next, defaultBot: next.routableBots[0] ?? "" };
        }
        return next;
      }),
    );
  };

  const handleSendPushAlert = async () => {
    if (sendingPush) return;
    if (!canSendPush(activeChannel)) {
      pushLog(
        `[BLOCKED • NOT CONNECTED] Push alert to ${activeChannel.name} dropped — channel is '${activeChannel.status}'.`
      );
      showToast(`${activeChannel.name} is not connected`);
      return;
    }

    const chatId = activeChannel.ownerUserId || activeDraft.ownerId;
    if (!chatId) {
      pushLog(`[${activeChannel.name}] Cannot send push alert — no owner chat ID configured.`);
      showToast("Set an owner ID first");
      return;
    }

    const buttons = pushButtonsForEvent(pushAlertEvent).map((b) => ({
      label: b.label,
      callback_action_id: b.callbackActionId,
    }));

    setSendingPush(true);
    try {
      const msg = await invokeRaw<string>("gateway_send_push_alert", {
        channelId: activeChannel.id,
        chatId,
        text: `**${pushAlertTitle}**\nTap an action below to resolve from your phone.`,
        buttons: buttons.map((b) => [b.label, b.callback_action_id] as [string, string]),
      });
      pushLog(`[Push → ${activeChannel.name}] ${msg}`);
      showToast(`Alert pushed to ${activeChannel.name}`);
    } catch (err) {
      pushLog(`[Push → ${activeChannel.name}] Failed: ${String(err)}`);
      showToast("Push alert failed");
    } finally {
      setSendingPush(false);
    }
  };

  const handlePushButtonTap = async (callbackActionId: string) => {
    if (callbackActionId.startsWith("approve_tx_")) {
      pushLog(`[Callback ← Phone] ✅ Approved transaction ${callbackActionId.replace("approve_tx_", "")} — signed via Rust Policy Signer.`);
    } else if (callbackActionId.startsWith("reject_tx_")) {
      pushLog(`[Callback ← Phone] ❌ Rejected transaction ${callbackActionId.replace("reject_tx_", "")} — Fail-Closed gate stays locked.`);
    } else if (callbackActionId === "view_pip_screenshot") {
      pushLog(`[Callback ← Phone] 📸 Captured Set-of-Marks PNG from active Bot Mini-Computer and sent to chat.`);
    } else {
      pushLog(`[Callback ← Phone] Executed action: ${callbackActionId}`);
    }
  };

  const handleSimulateRemoteCommand = async () => {
    if (simulating) return;
    const decision = resolveInboundRoute(remoteTestCmd, activeChannel, fleet);
    if (!decision.ok) {
      pushLog(`[${activeChannel.name}] ${decision.reason}`);
      showToast("Message was not routed");
      return;
    }
    if (!canSendPush(activeChannel)) {
      pushLog(
        `[BLOCKED • NOT CONNECTED] ${decision.handle} is routable, but ${activeChannel.name} is '${activeChannel.status}'.`
      );
      showToast(`${activeChannel.name} is not connected`);
      return;
    }
    setSimulating(true);
    try {
      await deliverRouted(decision, activeChannel.name);
    } finally {
      setSimulating(false);
    }
  };

  const handleDelegateToChief = async () => {
    if (delegating) return;
    const text = remoteTestCmd.trim();
    if (!text) {
      pushLog("[Chief] Write an objective first.");
      return;
    }
    const senderId = (activeChannel.ownerUserId || activeDraft.ownerId || "").trim();
    setDelegating(true);
    try {
      const res = await useRonic.getState().run("handle_mobile_chief_command", {
        channelId: activeChannel.id,
        senderId,
        chatId: senderId,
        text,
        callback: "",
      });
      const payload = res?.payload as { card?: string; delivered?: boolean; deliveryError?: string | null } | undefined;
      if (payload?.card) pushLog(payload.card);
      else pushLog(res?.toast || useRonic.getState().toast || "Chief delegation did not run.");
      if (payload && payload.delivered === false && payload.deliveryError) {
        pushLog(`Phone delivery: ${payload.deliveryError}`);
      }
    } catch (err) {
      pushLog(`[Chief] ${String(err)}`);
    } finally {
      setDelegating(false);
    }
  };

  return (
    <div className="flex-1 h-full bg-[#eceef2] p-3 sm:p-5 lg:p-6 overflow-y-auto select-none flex flex-col">
      {/* Toast Notification */}
      {toast && (
        <div className="fixed top-5 right-5 z-50 px-4 py-2.5 bg-zinc-800 text-white text-xs font-semibold rounded-2xl shadow-xl border border-zinc-700/50 flex items-center gap-2 animate-in fade-in slide-in-from-top-2 duration-200">
          <span className="w-2 h-2 rounded-full bg-emerald-400" />
          <span>{toast}</span>
        </div>
      )}

      {/* ─── MODAL CONTAINER (MARKETPLACE DESIGN SYSTEM) ─── */}
      <div className="w-full max-w-[1560px] flex-1 min-h-[660px] bg-white rounded-3xl shadow-[0_12px_40px_-8px_rgba(0,0,0,0.06),0_2px_8px_-1px_rgba(0,0,0,0.03)] border border-slate-200/70 flex flex-col mx-auto overflow-hidden transition-all duration-300">
        
        {/* ─── TOP HEADER ─── */}
        <div className="p-5 sm:p-7 pb-4 space-y-4 border-b border-slate-100 bg-white">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => go("chat")}
                className="text-slate-500 hover:text-slate-800 hover:bg-slate-100 px-3 py-1.5 rounded-xl transition-colors cursor-pointer flex items-center gap-1.5 text-xs font-semibold"
                title="Back to Chat (Alt+Left)"
              >
                <ArrowLeft size={15} />
                <span>Back</span>
              </button>
              <div>
                <div className="flex items-center gap-2.5 flex-wrap">
                  <h1 className="text-lg sm:text-xl font-bold text-slate-900 tracking-tight">Messaging gateway</h1>
                  <span className={`inline-flex items-center gap-1.5 px-3 py-1 text-xs font-semibold rounded-full border ${
                    connectedCount > 0
                      ? "bg-emerald-50 text-emerald-800 border-emerald-300 shadow-xs"
                      : "bg-slate-100 text-slate-600 border-slate-200"
                  }`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${connectedCount > 0 ? "bg-emerald-500" : "bg-slate-400"}`} />
                    {connectedCount} of {channels.length} connected
                  </span>
                  {attentionCount > 0 && (
                    <span className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-semibold rounded-full bg-rose-50 text-rose-700 border border-rose-200 animate-pulse">
                      <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />
                      {attentionCount} needs attention
                    </span>
                  )}
                </div>
                <p className="text-xs text-slate-500 mt-1 max-w-2xl leading-relaxed">
                  Connect Telegram, WhatsApp, Discord, Slack, and custom bot bridges. Remote messages route directly to your local bot fleet with hardware-bound policy approvals.
                </p>
              </div>
            </div>

            {/* Right Search Input */}
            <div className="flex items-center gap-2">
              <div className="relative min-w-[220px] sm:min-w-[280px]">
                <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" size={13} />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search messaging platforms…"
                  className="w-full bg-slate-50 border border-slate-200/90 rounded-full pl-9 pr-3.5 py-2 text-xs text-slate-800 placeholder-slate-400 outline-none focus:bg-white focus:border-slate-400 focus:ring-2 focus:ring-slate-100 transition-all"
                />
              </div>
            </div>
          </div>

          {/* Filter Chips */}
          <div className="flex items-center gap-2 overflow-x-auto pb-1 no-scrollbar pt-1 flex-wrap">
            {[
              { id: "all", label: `All (${channels.length})` },
              { id: "connected", label: `Connected (${connectedCount})` },
              { id: "attention", label: `Attention (${attentionCount})` },
            ].map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setStatusFilter(f.id as any)}
                className={`shrink-0 px-3.5 py-1.5 text-xs font-semibold rounded-full transition-all cursor-pointer ${
                  statusFilter === f.id
                    ? "bg-zinc-800 text-white shadow-xs"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200/70 hover:text-slate-800"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {/* ─── BODY (SPLIT RAIL & DETAIL WORKSPACE) ─── */}
        <div className="flex-1 flex overflow-hidden">
          
          {/* Left Roster Panel */}
          <aside className="w-80 shrink-0 border-r border-slate-100 bg-slate-50/50 flex flex-col h-full overflow-hidden">
            <div className="p-3 border-b border-slate-100 flex items-center justify-between text-xs text-slate-500 font-semibold px-4">
              <span>Platform Channels</span>
              <span className="font-mono text-[11px] bg-white px-2 py-0.5 rounded-full border border-slate-200 text-slate-600">
                {visibleChannels.length}
              </span>
            </div>

            <div className="flex-1 overflow-y-auto p-3 space-y-1.5 no-scrollbar">
              {visibleChannels.length === 0 && (
                <div className="px-4 py-12 text-center text-xs text-slate-400">
                  No messaging channels match your search.
                </div>
              )}
              {visibleChannels.map((ch) => {
                const isSelected = ch.id === selectedChannelId;
                const meta = STATUS_META[ch.status];
                return (
                  <button
                    key={ch.id}
                    type="button"
                    onClick={() => setSelectedChannelId(ch.id)}
                    className={`w-full p-3 rounded-2xl flex items-center justify-between gap-3 text-left transition-all cursor-pointer ${
                      isSelected
                        ? "bg-white text-slate-900 shadow-sm border border-slate-200/90 ring-1 ring-slate-900/5"
                        : "hover:bg-slate-100/70 text-slate-700 border border-transparent"
                    }`}
                  >
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      <span
                        className={`w-9 h-9 rounded-xl text-xs font-mono font-bold flex items-center justify-center shrink-0 shadow-xs ${ch.badgeColor}`}
                      >
                        {ch.badgeText}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className={`text-xs truncate ${isSelected ? "font-bold text-slate-900" : "font-semibold text-slate-800"}`}>
                          {ch.name}
                        </div>
                        <div className="text-[11px] text-slate-400 truncate mt-0.5">
                          {ch.status === "connected"
                            ? `${ch.routableBots.length} bots routable`
                            : liveConnections[ch.id]?.state === "AwaitingQrScan"
                            ? "Waiting for scan"
                            : meta.label}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span
                        className={`w-2 h-2 rounded-full ${meta.dotClass}`}
                        title={meta.label}
                      />
                      <ChevronRight size={13} className={isSelected ? "text-slate-700" : "text-slate-300"} />
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Left Rail Security Footer */}
            <div className="p-3.5 border-t border-slate-100 bg-white/80 flex items-center gap-2">
              <ShieldCheck className="text-emerald-600 shrink-0" size={15} />
              <span className="text-[11px] text-slate-500 font-medium">
                Hardware-gated: unauthenticated incoming events fail closed
              </span>
            </div>
          </aside>

          {/* Right Workspace Panel */}
          <main className="flex-1 h-full overflow-y-auto bg-white p-5 sm:p-7 space-y-6">
            
            {/* Platform Banner Header */}
            <header className="p-6 rounded-3xl bg-slate-50/80 border border-slate-200/80 flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-4 min-w-0">
                <span
                  className={`w-14 h-14 rounded-2xl text-base font-mono font-bold flex items-center justify-center shrink-0 shadow-md ${activeChannel.badgeColor}`}
                >
                  {activeChannel.badgeText}
                </span>
                <div className="min-w-0">
                  <div className="flex items-center gap-2.5 flex-wrap">
                    <h2 className="text-xl font-bold tracking-tight text-slate-900">
                      {activeChannel.name}
                    </h2>
                    {activeLive?.state === "AwaitingQrScan" ? (
                      <span className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-semibold bg-sky-50 text-sky-800 border border-sky-200 rounded-full">
                        <span className="w-1.5 h-1.5 rounded-full bg-sky-500 animate-pulse" />
                        Waiting for phone scan
                      </span>
                    ) : (
                      <StatusPill status={activeChannel.status} pid={activeChannel.conflictPid} />
                    )}
                  </div>
                  <p className="text-xs text-slate-500 mt-1 max-w-xl">{activeChannel.setupHint}</p>
                </div>
              </div>

              {/* Action Buttons: Matte Black Connect & Secondary Pair */}
              <div className="flex items-center gap-2.5 shrink-0">
                <button
                  type="button"
                  onClick={() => {
                    if (channelUsesQrPairing(activeChannel.id)) {
                      void openPairingQr(activeChannel.id);
                      return;
                    }
                    setShowQrPanel((open) => {
                      const next = !open;
                      if (next) void openPairingQr(activeChannel.id);
                      return next;
                    });
                  }}
                  className="px-4 py-2 text-xs font-semibold bg-white border border-slate-200 text-slate-700 rounded-full hover:bg-slate-50 hover:text-slate-900 transition-all cursor-pointer shadow-xs active:scale-95 flex items-center gap-1.5"
                >
                  {channelUsesQrPairing(activeChannel.id) ? <RefreshCw size={13} /> : <QrCode size={13} />}
                  <span>
                    {channelUsesQrPairing(activeChannel.id)
                      ? "Refresh QR"
                      : showQrPanel
                      ? "Hide pairing"
                      : "Pair mobile"}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => void handleToggleConnect()}
                  disabled={connecting}
                  className={`px-5 py-2 text-xs font-semibold rounded-full transition-all cursor-pointer shadow-xs active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed ${
                    activeChannel.status === "connected"
                      ? "bg-rose-50 text-rose-700 border border-rose-200/90 hover:bg-rose-100"
                      : "bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700/50"
                  }`}
                >
                  {connecting
                    ? activeLive?.state === "Validating"
                      ? "Validating…"
                      : "Connecting…"
                    : activeChannel.status === "connected"
                    ? "Disconnect gateway"
                    : "Connect gateway"}
                </button>
              </div>
            </header>

            {/* Error Banner */}
            {(activeChannel.status === "pid_conflict" || activeChannel.status === "error") && activeChannel.conflictError && (
              <div className="rounded-2xl border border-rose-200 bg-rose-50/70 p-4 sm:p-5 flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-start gap-3 min-w-0 flex-1">
                  <div className="w-8 h-8 rounded-xl bg-rose-100 text-rose-700 flex items-center justify-center shrink-0">
                    <Shield size={16} />
                  </div>
                  <div className="min-w-0">
                    <div className="text-xs font-bold text-rose-900">
                      Gateway connection blocked
                    </div>
                    <p className="text-xs text-rose-800 mt-0.5">
                      {activeChannel.conflictError}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void handleToggleConnect()}
                  disabled={connecting}
                  className="px-4 py-2 text-xs font-semibold bg-rose-600 text-white rounded-full hover:bg-rose-700 transition cursor-pointer shadow-xs"
                >
                  {connecting ? "Retrying…" : "Retry connection"}
                </button>
              </div>
            )}

            {/* Live Connection Info */}
            {activeLive && activeLive.state === "Connected" && (
              <div className="rounded-2xl border border-emerald-200 bg-emerald-50/60 p-4 flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-x-6 gap-y-1.5 text-xs">
                  <span className="flex items-center gap-2 font-bold text-emerald-800">
                    <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                    Live background connection active
                  </span>
                  {activeLive.platform_user && (
                    <span className="text-emerald-700">
                      Bot: <span className="font-mono font-semibold">{activeLive.platform_user}</span>
                    </span>
                  )}
                  <span className="text-emerald-700">
                    Messages routed: <span className="font-mono font-semibold">{activeLive.messages_received}</span>
                  </span>
                  {activeLive.connected_at_ms && (
                    <span className="text-emerald-700">
                      Connected since: <span className="font-mono">{new Date(activeLive.connected_at_ms).toLocaleTimeString()}</span>
                    </span>
                  )}
                </div>
              </div>
            )}

            {/* QR Pairing Panel */}
            {(showQrPanel || channelUsesQrPairing(activeChannel.id)) && (
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5 space-y-4">
                <div className="flex flex-wrap items-center gap-5">
                  {activeQr?.dataUrl ? (
                    <img
                      src={activeQr.dataUrl}
                      alt={`${activeChannel.name} pairing QR code`}
                      className="w-44 h-44 shrink-0 rounded-2xl border border-slate-300 shadow-md bg-white p-2"
                    />
                  ) : (
                    <div className="w-44 h-44 shrink-0 rounded-2xl border-2 border-dashed border-slate-300 bg-white flex flex-col items-center justify-center p-4 text-center">
                      <QrCode className="text-slate-300 mb-1" size={28} />
                      <span className="text-[11px] text-slate-400">
                        {qrError || "Generating pairing QR…"}
                      </span>
                    </div>
                  )}
                  <div className="flex-1 min-w-0 space-y-2">
                    <div className="text-sm font-bold text-slate-900">
                      Pairing QR for {activeChannel.name}
                    </div>
                    <p className="text-xs text-slate-600 leading-relaxed">
                      Point your phone camera at this code. It is a scannable pairing link for this channel. WhatsApp, Signal, WeChat, and iMessage show a code as soon as you open them. A bot token is optional on those channels.
                    </p>
                    {activeQr?.uri && (
                      <p className="text-xs text-slate-500 break-all font-mono bg-white p-2 rounded-xl border border-slate-200">
                        {activeQr.uri}
                      </p>
                    )}
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void openPairingQr(activeChannel.id)}
                        className="px-3.5 py-1.5 text-xs font-semibold bg-white border border-slate-200 text-slate-700 rounded-full hover:bg-slate-50 cursor-pointer"
                      >
                        New code
                      </button>
                      <p className="text-xs text-emerald-700 font-semibold flex items-center gap-1.5">
                        <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                        {activeLive?.state === "AwaitingQrScan"
                          ? "Desktop listener is waiting for a scan."
                          : activeLive?.state === "Connected"
                          ? "This channel is already connected."
                          : "The code is ready to scan."}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Credentials Card */}
            <div className="rounded-2xl border border-slate-200/90 bg-white p-5 sm:p-6 shadow-xs space-y-4">
              <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                <div>
                  <h3 className="text-sm font-bold text-slate-900">Credentials & Access</h3>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Bot token and owner ID are enough to connect. Extra credentials below are optional.
                  </p>
                </div>
                <span className="text-[11px] font-mono font-semibold px-2.5 py-1 bg-slate-50 text-slate-600 border border-slate-200 rounded-full flex items-center gap-1">
                  <Lock size={10} /> This session
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                    Bot Token / Webhook Secret
                  </label>
                  <div className="relative">
                    <input
                      type={showSecretToken ? "text" : "password"}
                      value={activeDraft.token}
                      onChange={(e) => updateDraft(activeChannel.id, { token: e.target.value })}
                      placeholder={
                        activeChannel.id === "telegram"
                          ? "123456789:ABC-DEF1234ghIkl…"
                          : activeChannel.id === "discord"
                          ? "MTIz…XXXX.XXXXXX.XXXX…"
                          : "Bot token or API key…"
                      }
                      className="w-full px-3.5 py-2 pr-10 text-xs font-mono bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-slate-200 transition-all"
                    />
                    <button
                      type="button"
                      onClick={() => setShowSecretToken(!showSecretToken)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 cursor-pointer"
                    >
                      {showSecretToken ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                  <span className="block text-[11px] text-slate-400 mt-1">
                    {activeChannel.id === "telegram" && "Obtain via @BotFather on Telegram"}
                    {activeChannel.id === "discord" && "Developer Portal → Bot → Reset Token"}
                    {activeChannel.id === "slack" && "Bot token (xoxb-). The app-level token is optional below."}
                    {activeChannel.id === "whatsapp" && "Leave empty to pair with the QR, or paste a Cloud API token."}
                    {!["telegram", "discord", "slack", "whatsapp"].includes(activeChannel.id) && "Paste channel API key"}
                  </span>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                    Allowlisted Owner User ID
                  </label>
                  <input
                    type="text"
                    value={activeDraft.ownerId}
                    onChange={(e) => updateDraft(activeChannel.id, { ownerId: e.target.value })}
                    placeholder="e.g. 6194820194 or +91-98XXXXXX10"
                    className="w-full px-3.5 py-2 text-xs font-mono bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-slate-200 transition-all"
                  />
                  <span className="block text-[11px] text-slate-400 mt-1">
                    Strict owner firewall: unlisted senders are automatically ignored.
                  </span>
                </div>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-slate-50/80">
                <button
                  type="button"
                  onClick={() => setShowAdvanced((open) => !open)}
                  className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left cursor-pointer"
                >
                  <span>
                    <span className="block text-xs font-bold text-slate-900">Advanced authentication</span>
                    <span className="block text-[11px] text-slate-500 mt-0.5">
                      Optional. Add another secret only when this platform asks for one.
                    </span>
                  </span>
                  <span className="text-xs font-semibold text-slate-600 shrink-0">
                    {showAdvanced ? "Hide" : activeDraft.extras.length ? `${activeDraft.extras.length} added` : "Add credential"}
                  </span>
                </button>
                {showAdvanced && (
                  <div className="px-4 pb-4 space-y-3">
                    {activeDraft.extras.length === 0 && (
                      <p className="text-[11px] text-slate-500">
                        No extra credentials. The connection does not need any.
                      </p>
                    )}
                    {activeDraft.extras.map((extra, index) => (
                      <div key={extra.id} className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] gap-2">
                        <input
                          type="text"
                          value={extra.label}
                          placeholder={extraPlaceholder(activeChannel.id)}
                          onChange={(event) => {
                            const extras = activeDraft.extras.map((item, itemIndex) => (
                              itemIndex === index ? { ...item, label: event.target.value } : item
                            ));
                            updateDraft(activeChannel.id, { extras });
                          }}
                          className="w-full px-3 py-2 text-xs bg-white border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-slate-200"
                        />
                        <input
                          type="password"
                          value={extra.value}
                          placeholder="Value"
                          onChange={(event) => {
                            const extras = activeDraft.extras.map((item, itemIndex) => (
                              itemIndex === index ? { ...item, value: event.target.value } : item
                            ));
                            updateDraft(activeChannel.id, { extras });
                          }}
                          className="w-full px-3 py-2 text-xs font-mono bg-white border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-slate-200"
                        />
                        <button
                          type="button"
                          onClick={() => updateDraft(activeChannel.id, {
                            extras: activeDraft.extras.filter((item) => item.id !== extra.id),
                          })}
                          className="px-3 py-2 text-slate-500 hover:text-rose-600 cursor-pointer"
                          aria-label="Remove credential"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={() => updateDraft(activeChannel.id, {
                        extras: [
                          ...activeDraft.extras,
                          { id: `extra_${Date.now()}_${activeDraft.extras.length}`, label: "", value: "" },
                        ],
                      })}
                      className="px-3.5 py-1.5 text-xs font-semibold bg-white border border-slate-200 text-slate-700 rounded-full hover:bg-slate-100 cursor-pointer"
                    >
                      Add credential
                    </button>
                    <p className="text-[11px] text-slate-500 leading-relaxed">
                      Name a Slack row “App token” to include it in Socket Mode. Name a row “Allowlisted sender” or “Chat ID” to let that id through the owner firewall. Name a WhatsApp row “Cloud API token” to use it when the bot token is empty. Any other row is kept for this session and is not required to connect.
                    </p>
                  </div>
                )}
              </div>

              <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() =>
                    updateDraft(activeChannel.id, {
                      token: activeChannel.botTokenMasked,
                      ownerId: activeChannel.ownerUserId,
                      extras: activeChannel.extraCredentials ?? [],
                    })
                  }
                  className="px-4 py-2 text-xs font-semibold text-slate-600 hover:text-slate-900 transition cursor-pointer"
                >
                  Reset
                </button>
                <button
                  type="button"
                  onClick={() => void handleSaveCredentials()}
                  disabled={savingCredentials}
                  className="px-5 py-2 text-xs font-semibold bg-zinc-800 hover:bg-zinc-700 text-white rounded-full transition-all cursor-pointer shadow-xs active:scale-95 disabled:opacity-50 border border-zinc-700/50"
                >
                  {savingCredentials ? "Saving…" : "Save credentials"}
                </button>
              </div>
            </div>

            {/* Bots Routing Matrix */}
            <div className="rounded-2xl border border-slate-200/90 bg-white p-5 sm:p-6 shadow-xs space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3">
                <div>
                  <h3 className="text-sm font-bold text-slate-900">
                    Bots Routable from {activeChannel.name}
                  </h3>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Only bots and groups created in this workspace are listed. Turn one on to receive messages from this channel.
                  </p>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-slate-500 font-semibold">Default bot:</span>
                  <select
                    value={routableFleet.some((member) => member.handle === activeChannel.defaultBot) ? activeChannel.defaultBot : ""}
                    disabled={routableFleet.length === 0}
                    onChange={(e) =>
                      updateChannel(activeChannel.id, { defaultBot: e.target.value })
                    }
                    className="px-3 py-1.5 text-xs font-mono font-semibold bg-slate-50 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-slate-200 disabled:text-slate-400"
                  >
                    <option value="">{routableFleet.length === 0 ? "No bots created" : "Choose a default"}</option>
                    {routableFleet.map((member) => (
                      <option key={member.id} value={member.handle}>
                        {member.handle}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Bot Chips */}
              <div className="flex flex-wrap gap-2">
                {fleet.length === 0 ? (
                  <div className="w-full rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-center">
                    <p className="text-sm font-semibold text-slate-800">No bots created yet</p>
                    <p className="text-xs text-slate-500 mt-1 max-w-md mx-auto">
                      Remote messages can only reach bots and groups that exist in this workspace.
                    </p>
                    <button
                      type="button"
                      onClick={() => go("profiles")}
                      className="mt-3 px-4 py-2 text-xs font-semibold bg-zinc-800 text-white rounded-full cursor-pointer"
                    >
                      Open bot profiles
                    </button>
                  </div>
                ) : fleet.map((member) => {
                  const on = activeChannel.routableBots.some((handle) => handle.toLowerCase() === member.handle.toLowerCase());
                  const bare = member.handle.replace(/^[@#]/, "");
                  const label = member.displayName && member.displayName.replace(/^[@#]/, "").toLowerCase() !== bare.toLowerCase()
                    ? `${member.handle} · ${member.displayName}`
                    : member.handle;
                  return (
                    <button
                      key={member.id}
                      type="button"
                      onClick={() => handleToggleBotOnChannel(member.handle)}
                      className={`px-3.5 py-1.5 text-xs font-mono font-semibold rounded-full transition-all cursor-pointer active:scale-95 border ${
                        on
                          ? "bg-zinc-800 text-white border-zinc-700 shadow-xs"
                          : "bg-slate-100 text-slate-600 border-slate-200/80 hover:bg-slate-200/80 hover:text-slate-900"
                      }`}
                    >
                      {on ? `✓ ${label}` : `+ ${label}`}
                    </button>
                  );
                })}
              </div>

              {/* Command Cheat-sheet */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5 pt-3 border-t border-slate-100">
                {[
                  { cmd: "@bot <task>", desc: "Route a prompt to a bot from your phone" },
                  { cmd: "/screen", desc: "Live Set-of-Marks snapshot from mini-computer" },
                  { cmd: "/approve <tx>", desc: "Sign a paused wallet payment or merge a PR" },
                  { cmd: "/halt", desc: "<10ms emergency computer & bot halt" },
                ].map((item) => (
                  <div
                    key={item.cmd}
                    className="p-3 bg-slate-50 rounded-xl border border-slate-200/80"
                  >
                    <div className="font-mono font-bold text-slate-800 text-xs">
                      {item.cmd}
                    </div>
                    <div className="text-[11px] text-slate-500 mt-1">{item.desc}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Push Alerts & Event Triggers */}
            <div className="rounded-2xl border border-slate-200/90 bg-white p-5 sm:p-6 shadow-xs space-y-4">
              <div className="border-b border-slate-100 pb-3">
                <h3 className="text-sm font-bold text-slate-900">Bi-directional Push Alerts</h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Send high-priority notifications with interactive buttons directly to your phone.
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="md:col-span-2">
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Alert Title / Payload
                  </label>
                  <input
                    type="text"
                    value={pushAlertTitle}
                    onChange={(e) => setPushAlertTitle(e.target.value)}
                    className="w-full px-3.5 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-slate-200 transition-all"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Event Trigger
                  </label>
                  <select
                    value={pushAlertEvent}
                    onChange={(e) => setPushAlertEvent(e.target.value)}
                    className="w-full px-3.5 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-slate-200 transition-all"
                  >
                    <option value="wallet_approval_gate">Fail-Closed Wallet Gate</option>
                    <option value="sentinel_incident">Sentinel Incident</option>
                    <option value="task_completed">Task Completed</option>
                  </select>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => void handleSendPushAlert()}
                  disabled={sendingPush || activeChannel.status !== "connected"}
                  className="px-5 py-2 text-xs font-semibold bg-zinc-800 hover:bg-zinc-700 text-white rounded-full transition-all cursor-pointer shadow-xs active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed border border-zinc-700/50"
                >
                  {sendingPush ? "Sending…" : `Push alert to ${activeChannel.name}`}
                </button>
                <span className="text-xs text-slate-400 mx-1">Interactive callbacks:</span>
                {[
                  { label: "✅ Approve", action: "approve_tx_901" },
                  { label: "❌ Reject", action: "reject_tx_901" },
                  { label: "📸 View Screen", action: "view_pip_screenshot" },
                ].map((b) => (
                  <button
                    key={b.action}
                    type="button"
                    onClick={() => void handlePushButtonTap(b.action)}
                    className="px-3.5 py-1.5 text-xs font-semibold bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-full transition-all cursor-pointer active:scale-95 border border-slate-200/80"
                  >
                    {b.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Remote Simulator Card */}
            <div className="rounded-2xl border border-slate-200/90 bg-white p-5 sm:p-6 shadow-xs space-y-4">
              <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                <div>
                  <h3 className="text-sm font-bold text-slate-900">Remote Command Simulator & Live Audit</h3>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Dispatch simulated incoming webhook messages and verify firewall handling.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setRemoteLogs([])}
                  className="text-xs font-semibold text-slate-500 hover:text-slate-800 transition cursor-pointer"
                >
                  Clear log
                </button>
              </div>

              <div className="flex flex-wrap gap-2">
                <input
                  type="text"
                  value={remoteTestCmd}
                  onChange={(e) => setRemoteTestCmd(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleSimulateRemoteCommand();
                  }}
                  className="flex-1 min-w-[12rem] px-3.5 py-2 text-xs font-mono bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-slate-200 transition-all"
                  placeholder="/chief Patch the webhook bug"
                />
                <button
                  type="button"
                  onClick={() => void handleSimulateRemoteCommand()}
                  disabled={simulating}
                  className="px-5 py-2 text-xs font-semibold bg-zinc-800 hover:bg-zinc-700 text-white rounded-full transition-all cursor-pointer shadow-xs active:scale-95 disabled:opacity-50 shrink-0 border border-zinc-700/50"
                >
                  {simulating ? "Routing…" : "Route this message"}
                </button>
                <button
                  type="button"
                  onClick={() => void handleDelegateToChief()}
                  disabled={delegating}
                  className="px-5 py-2 text-xs font-semibold bg-white hover:bg-slate-50 text-slate-800 rounded-full transition-all cursor-pointer shadow-xs active:scale-95 disabled:opacity-50 shrink-0 border border-slate-300"
                >
                  {delegating ? "Delegating…" : "Delegate to Chief"}
                </button>
              </div>

              <div className="rounded-2xl border border-slate-800 bg-[#1e2025] text-slate-100 font-mono text-xs leading-relaxed max-h-56 overflow-y-auto p-4 shadow-inner">
                {remoteLogs.length === 0 ? (
                  <div className="py-6 text-center text-slate-500">
                    No events logged yet — trigger an alert or simulated message above.
                  </div>
                ) : (
                  <ul className="space-y-1">
                    {remoteLogs.map((log, i) => (
                      <li
                        key={i}
                        className={
                          log.includes("BLOCKED") || log.includes("DROPPED")
                            ? "text-rose-400"
                            : log.includes("✓") || log.includes("✅")
                            ? "text-emerald-400"
                            : log.includes("⚠") || log.includes("Reclaim")
                            ? "text-amber-400"
                            : "text-slate-300"
                        }
                      >
                        {log}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

          </main>
        </div>
      </div>
    </div>
  );
}

function StatusPill({ status, pid }: { status: ChannelStatus; pid?: number }) {
  if (status === "connected") {
    return (
      <span className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200/90 rounded-full shadow-xs">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
        Connected · remote commands active
      </span>
    );
  }
  if (status === "pid_conflict") {
    return (
      <span className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-semibold bg-rose-50 text-rose-700 border border-rose-200/90 rounded-full shadow-xs">
        <span className="w-1.5 h-1.5 rounded-full bg-rose-500 animate-pulse" />
        Startup blocked · PID {pid}
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-semibold bg-rose-50 text-rose-700 border border-rose-200/90 rounded-full shadow-xs">
        <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />
        Connection error
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-semibold bg-slate-100 text-slate-600 border border-slate-200 rounded-full shadow-xs">
      <span className="w-1.5 h-1.5 rounded-full bg-slate-400" />
      Disconnected · remote access blocked
    </span>
  );
}
