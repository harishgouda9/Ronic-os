import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Camera, ChevronRight, Eye, EyeOff, Lock, QrCode, RefreshCw, Search, Shield, ShieldCheck, Trash2, Upload } from "lucide-react";
import { invokeRaw, isTauri } from "../api";
import { runGatewayTurn } from "../kernel/gatewayTurn";
import { pairingQrDataUrl } from "../kernel/pairingQr";
import { useRonic } from "../store";
import {
  allowlistFromDraft,
  allowOwner,
  applySaveCredentials,
  applyStoredCredentials,
  clearBlockedSender,
  draftsFromSaved,
  GATEWAY_CREDENTIALS_KEY,
  GATEWAY_ROUTE_KEY,
  canSendPush,
  channelUsesQrPairing,
  connectTokenFor,
  draftFor,
  fleetMembers,
  inboundAllowlist,
  lastBlockedSender,
  liveStateToStatus,
  pruneChannelRouting,
  pushBlockReason,
  pushButtonsForEvent,
  removeAllowedOwner,
  resolveInboundRoute,
  interpretScannedGatewayQr,
  parseSavedCredentials,
  syncChannelFromLive,
  toggleRoutableBot,
  upsertSavedCredential,
  usableExtras,
  whatsappLinkInstructions,
  type CredentialDraft,
  type ExtraCredential,
  type FleetMember,
  type GatewayConnectionInfo,
  type RouteDecision,
  type SavedGatewayCredential,
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

const ROUTE_KEY = GATEWAY_ROUTE_KEY;

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
    setupHint: "Bot API long-polling. Paste a @BotFather token, or scan a QR that contains it.",
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
    setupHint: "Open WhatsApp, then Linked devices, then Link a device, and scan the code. A Cloud API token is optional.",
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
    setupHint: "Scan the QR this gateway shows, or paste its token. Save keeps it on this computer.",
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
    setupHint: "Scan the QR this gateway shows, or paste its token. Save keeps it on this computer.",
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
    setupHint: "Scan the QR this gateway shows, or paste its token. Save keeps it on this computer.",
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

function readPreviewCredentials(): Record<string, SavedGatewayCredential> {
  try {
    return parseSavedCredentials(JSON.parse(localStorage.getItem(GATEWAY_CREDENTIALS_KEY) ?? "null"));
  } catch {
    return {};
  }
}

async function persistGatewayCredentials(channelId: string, draft: CredentialDraft, reconnect?: boolean): Promise<void> {
  const extras = usableExtras(draft.extras);
  const stored = { ...draft, token: draft.token.trim(), ownerId: draft.ownerId.trim(), extras };
  if (isTauri()) {
    await invokeRaw<string>("gateway_save_credentials", {
      channelId,
      token: stored.token,
      ownerId: stored.ownerId,
      extras,
      reconnect: reconnect ?? null,
    });
    return;
  }
  const next = upsertSavedCredential(readPreviewCredentials(), channelId, stored, reconnect);
  localStorage.setItem(GATEWAY_CREDENTIALS_KEY, JSON.stringify(next));
}

type BarcodeHit = { rawValue?: string };
type BarcodeReader = { detect: (source: CanvasImageSource) => Promise<BarcodeHit[]> };

function barcodeReader(): BarcodeReader | null {
  const ctor = (window as unknown as { BarcodeDetector?: new (options: { formats: string[] }) => BarcodeReader }).BarcodeDetector;
  if (!ctor) return null;
  try {
    return new ctor({ formats: ["qr_code"] });
  } catch {
    return null;
  }
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

  const [channels, setChannels] = useState<MessagingPlatformItem[]>(() => {
    const routed = withStoredRoutes(INITIAL_CHANNELS);
    if (typeof window === "undefined" || isTauri()) return routed;
    return applyStoredCredentials(routed, readPreviewCredentials());
  });
  const [selectedChannelId, setSelectedChannelId] = useState<string>("telegram");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<"all" | "connected" | "attention">("all");

  // Per-channel draft credentials. Desktop values load from the vault.
  const [credentialDrafts, setCredentialDrafts] = useState<Record<string, CredentialDraft>>(() => {
    if (typeof window === "undefined" || isTauri()) return {};
    return draftsFromSaved(readPreviewCredentials());
  });

  // Live backend connection state — polled from gateway_connections.rs
  const [liveConnections, setLiveConnections] = useState<Record<string, GatewayConnectionInfo>>({});

  // UI state
  const [showQrPanel, setShowQrPanel] = useState<boolean>(false);
  const [showAdvanced, setShowAdvanced] = useState<boolean>(false);
  const [localQr, setLocalQr] = useState<Record<string, { uri: string; dataUrl: string }>>({});
  const [qrError, setQrError] = useState<string>("");
  const [showSecretToken, setShowSecretToken] = useState<boolean>(false);
  const [savingCredentials, setSavingCredentials] = useState<boolean>(false);
  const [scanning, setScanning] = useState(false);
  const [scanNote, setScanNote] = useState("");
  const [scanPaste, setScanPaste] = useState("");
  const scanVideoRef = useRef<HTMLVideoElement>(null);
  const scanStreamRef = useRef<MediaStream | null>(null);
  const credentialsReady = useRef(!isTauri());
  const reconnectSaved = useRef<Set<string>>(new Set());
  const reconnectPending = useRef<Set<string>>(new Set());
  const [connecting, setConnecting] = useState<boolean>(false);
  const [sendingPush, setSendingPush] = useState<boolean>(false);
  const [simulating, setSimulating] = useState<boolean>(false);
  const [delegating, setDelegating] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [allowDraft, setAllowDraft] = useState("");
  const [allowlistVersion, setAllowlistVersion] = useState(0);
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
  const draftsRef = useRef(credentialDrafts);
  draftsRef.current = credentialDrafts;
  const selectedIdRef = useRef(selectedChannelId);
  selectedIdRef.current = selectedChannelId;
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
      if (credentialsReady.current) {
        for (const info of infos) {
          if (info.state !== "Connected") continue;
          if (reconnectSaved.current.has(info.channel_id) || reconnectPending.current.has(info.channel_id)) continue;
          const channel = channelsRef.current.find((item) => item.id === info.channel_id);
          if (!channel) continue;
          const draft = draftFor(draftsRef.current, channel);
          const token = (draft.token.trim() || channel.botTokenMasked.trim()).replace(/^pair$/, "");
          if (!token && info.channel_id !== "whatsapp") continue;
          reconnectPending.current.add(info.channel_id);
          const saved = { ...draft, token };
          void persistGatewayCredentials(info.channel_id, saved, true)
            .then(() => {
              reconnectSaved.current.add(info.channel_id);
            })
            .finally(() => {
              reconnectPending.current.delete(info.channel_id);
            });
        }
      }

      // The listener can already be Connected when this screen mounts.
      // Copy that into `enabled`, or every route is refused as if it were off.
      setChannels((prev) =>
        prev.map((ch) => {
          const live = map[ch.id];
          if (!live) return ch;
          const synced = syncChannelFromLive(ch, live);
          const ownerUserId = ch.ownerUserId.trim() || (live.owner_id || "").trim();
          if (
            synced.status === ch.status
            && synced.enabled === ch.enabled
            && ownerUserId === ch.ownerUserId
            && (synced.conflictError ?? "") === (ch.conflictError ?? "")
          ) return ch;
          return { ...synced, ownerUserId };
        })
      );
      const ownerPatch: Record<string, CredentialDraft> = {};
      for (const info of infos) {
        const stored = (info.owner_id || "").trim();
        if (!stored) continue;
        const channel = channelsRef.current.find((item) => item.id === info.channel_id);
        if (!channel) continue;
        const draft = draftFor(draftsRef.current, channel);
        if (draft.ownerId.trim()) continue;
        ownerPatch[info.channel_id] = { ...draft, ownerId: stored };
      }
      if (Object.keys(ownerPatch).length) {
        draftsRef.current = { ...draftsRef.current, ...ownerPatch };
        setCredentialDrafts((prev) => {
          let changed = false;
          const next = { ...prev };
          for (const [id, draft] of Object.entries(ownerPatch)) {
            if (prev[id]?.ownerId.trim()) continue;
            next[id] = { ...(prev[id] ?? draft), ownerId: draft.ownerId };
            changed = true;
          }
          return changed ? next : prev;
        });
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

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    void (async () => {
      try {
        const saved = await invokeRaw<Record<string, SavedGatewayCredential>>("gateway_load_credentials", {});
        if (cancelled || !saved) return;
        const file = parseSavedCredentials(saved);
        setCredentialDrafts((prev) => {
          const next = { ...prev };
          for (const [id, draft] of Object.entries(draftsFromSaved(file))) {
            const existing = prev[id];
            if (existing && (existing.token.trim() || existing.ownerId.trim() || existing.extras.length > 0)) continue;
            next[id] = draft;
          }
          return next;
        });
        setChannels((prev) => applyStoredCredentials(prev, file));
        credentialsReady.current = true;
      } catch (error) {
        if (!cancelled) pushLog(`Saved credentials did not load: ${String(error)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pushLog]);

  useEffect(() => {
    return () => {
      scanStreamRef.current?.getTracks().forEach((track) => track.stop());
      scanStreamRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!scanning) return;
    const video = scanVideoRef.current;
    const stream = scanStreamRef.current;
    const reader = barcodeReader();
    if (!video || !stream || !reader) return;
    video.srcObject = stream;
    void video.play().catch(() => undefined);
    const watch = window.setInterval(() => {
      void reader.detect(video).then((codes) => {
        const value = codes[0]?.rawValue?.trim() ?? "";
        if (!value) return;
        window.clearInterval(watch);
        scanStreamRef.current?.getTracks().forEach((track) => track.stop());
        scanStreamRef.current = null;
        setScanning(false);
        void applyScannedText(value);
      }).catch(() => undefined);
    }, 400);
    return () => window.clearInterval(watch);
  }, [scanning]);

  useEffect(() => {
    const onLog = (event: Event) => {
      const detail = (event as CustomEvent<string>).detail;
      if (typeof detail === "string" && detail.trim()) pushLog(detail);
    };
    window.addEventListener("ronic-gateway-log", onLog);
    return () => window.removeEventListener("ronic-gateway-log", onLog);
  }, [pushLog]);

  useEffect(() => {
    const bump = () => setAllowlistVersion((version) => version + 1);
    window.addEventListener("ronic-gateway-allowlist", bump);
    return () => window.removeEventListener("ronic-gateway-allowlist", bump);
  }, []);

  // ── Derived state ───────────────────────────────────────────

  const activeChannel = useMemo(
    () => channels.find((c) => c.id === selectedChannelId) || channels[0],
    [channels, selectedChannelId]
  );

  const activeLive = liveConnections[activeChannel.id];
  const activeDraft = draftFor(credentialDrafts, activeChannel);
  const liveOwnerId = (activeLive?.owner_id || activeChannel.ownerUserId || "").trim();
  const allowedOwners = useMemo(
    () => inboundAllowlist(activeChannel.id, liveOwnerId),
    [activeChannel.id, liveOwnerId, allowlistVersion],
  );
  const blockedSender = useMemo(
    () => lastBlockedSender(activeChannel.id),
    [activeChannel.id, allowlistVersion],
  );
  const blockedStillOut = Boolean(
    blockedSender
    && !allowedOwners.some((id) => id.toLowerCase() === blockedSender.senderId.toLowerCase()),
  );
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

  const openPairingQr = useCallback(async (channelId: string, force = false) => {
    setShowQrPanel(true);
    setQrError("");
    if (!isTauri()) {
      setQrError(
        channelId === "whatsapp"
          ? "WhatsApp linking runs in the desktop app. Open this channel there, then scan from WhatsApp → Linked devices → Link a device."
          : "Pairing runs in the desktop app. Open this channel there, then scan from a phone on the same Wi-Fi.",
      );
      return;
    }
    try {
      const info = await invokeRaw<GatewayConnectionInfo>("gateway_pairing_qr", { channelId, force });
      setLiveConnections((prev) => ({ ...prev, [channelId]: info }));
      if (info.qr_png_base64) {
        setLocalQr((prev) => ({
          ...prev,
          [channelId]: {
            uri: info.qr_uri || "",
            dataUrl: `data:image/png;base64,${info.qr_png_base64}`,
          },
        }));
        return;
      }
      if (info.qr_uri) {
        const dataUrl = await pairingQrDataUrl(info.qr_uri);
        setLocalQr((prev) => ({ ...prev, [channelId]: { uri: info.qr_uri || "", dataUrl } }));
        return;
      }
      setLocalQr((prev) => {
        if (!prev[channelId]) return prev;
        const next = { ...prev };
        delete next[channelId];
        return next;
      });
    } catch (error) {
      setQrError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const pairingStarted = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (selectedChannelId !== "whatsapp") return;
    if (pairingStarted.current.has("whatsapp")) return;
    pairingStarted.current.add("whatsapp");
    void openPairingQr("whatsapp");
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
    const title = `Gateway · ${channelName}`;
    try {
      const prompt = decision.kind === "group"
        ? `[${channelName} → ${decision.handle}] ${decision.prompt}`
        : `[${channelName}] ${decision.prompt}`;
      await runGatewayTurn(run, () => useRonic.getState().snap, bot, channelName, prompt);
      pushLog(`Routed to ${decision.handle}. The reply is in that bot's "${title}" task.`);
    } catch (error) {
      pushLog(`Route to ${decision.handle} failed: ${String(error)}`);
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

          if (ownerId.trim()) allowOwner(ch.id, ownerId, ownerId);
          const savedToken = token === "pair" ? "" : token;
          try {
            await persistGatewayCredentials(ch.id, { token: savedToken, ownerId, extras }, info.state === "Connected");
          } catch (saveError) {
            pushLog(`[${ch.name}] Connected, but the credentials were not saved: ${String(saveError)}`);
          }
          if (info.state === "Connected") {
            reconnectSaved.current.add(ch.id);
            pushLog(
              `[${ch.name}] ✓ Connected as ${info.platform_user ?? "unknown"} — real-time message listener active.`
            );
            showToast(`${ch.name} connected`);
          } else if (info.state === "AwaitingQrScan" || (ch.id === "whatsapp" && info.state === "Connecting")) {
            pushLog(
              ch.id === "whatsapp"
                ? `[${ch.name}] Linked-device QR is starting. On the phone: WhatsApp → Linked devices → Link a device.`
                : `[${ch.name}] QR pairing is ready — scan the code with your phone.`,
            );
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

  const handleAllowOwner = (raw: string) => {
    const id = raw.trim();
    if (!id) {
      showToast("Enter the sender id to allow");
      return;
    }
    const live = (liveConnections[activeChannel.id]?.owner_id || activeChannel.ownerUserId || "").trim();
    const next = allowOwner(activeChannel.id, live, id);
    clearBlockedSender(activeChannel.id, id);
    if (!activeDraft.ownerId.trim()) updateDraft(activeChannel.id, { ownerId: id });
    setAllowDraft("");
    setAllowlistVersion((version) => version + 1);
    pushLog(`[${activeChannel.name}] Owner allowlist now includes ${next.join(", ")}. Send a new message from ${id}.`);
    showToast(`${id} is on the owner allowlist`);
  };

  const handleRemoveOwner = (id: string) => {
    const live = (liveConnections[activeChannel.id]?.owner_id || activeChannel.ownerUserId || "").trim();
    const next = removeAllowedOwner(activeChannel.id, live, id);
    setAllowlistVersion((version) => version + 1);
    pushLog(
      next.length
        ? `[${activeChannel.name}] Removed ${id} from the owner allowlist.`
        : `[${activeChannel.name}] Owner allowlist is empty. The next person who messages the bot is allowed.`,
    );
    showToast(`Removed ${id}`);
  };

  const handleSaveCredentials = async () => {
    setSavingCredentials(true);
    try {
      const reconnect = activeDraft.token.trim() || activeChannel.id === "whatsapp" ? undefined : false;
      await persistGatewayCredentials(activeChannel.id, activeDraft, reconnect);
      setChannels((prev) =>
        prev.map((c) => (c.id === activeChannel.id ? applySaveCredentials(c, activeDraft) : c))
      );
      const live = (liveConnections[activeChannel.id]?.owner_id || "").trim();
      for (const id of allowlistFromDraft(activeDraft)) allowOwner(activeChannel.id, live, id);
      setAllowlistVersion((version) => version + 1);
      const extraCount = usableExtras(activeDraft.extras).length;
      pushLog(`[${activeChannel.name}] Credentials saved on this computer.${extraCount ? ` ${extraCount} optional extra${extraCount === 1 ? "" : "s"} included.` : ""}`);
      showToast("Credentials saved");
    } catch (error) {
      pushLog(`[${activeChannel.name}] Credentials were not saved: ${String(error)}`);
      showToast("Credentials were not saved");
    } finally {
      setSavingCredentials(false);
    }
  };

  const stopScanner = () => {
    scanStreamRef.current?.getTracks().forEach((track) => track.stop());
    scanStreamRef.current = null;
    setScanning(false);
  };

  const applyScannedText = async (text: string) => {
    const result = interpretScannedGatewayQr(text, selectedIdRef.current);
    if (!result.ok) {
      setScanNote(result.reason);
      return;
    }
    if (result.kind === "whatsapp_link") {
      try {
        const dataUrl = await pairingQrDataUrl(result.token);
        setSelectedChannelId("whatsapp");
        setLocalQr((prev) => ({ ...prev, whatsapp: { uri: "", dataUrl } }));
        setShowQrPanel(true);
        setScanNote(result.note);
        showToast("Scan this code from WhatsApp");
      } catch (error) {
        setScanNote(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    const channel = channelsRef.current.find((item) => item.id === result.channelId);
    const current = channel
      ? draftFor(draftsRef.current, channel)
      : { token: "", ownerId: "", extras: [] as ExtraCredential[] };
    const draft = { ...current, token: result.token };
    updateDraft(result.channelId, { token: result.token });
    setSelectedChannelId(result.channelId);
    try {
      await persistGatewayCredentials(result.channelId, draft);
      setChannels((prev) => prev.map((item) => (item.id === result.channelId ? applySaveCredentials(item, draft) : item)));
      setScanNote(result.note);
      showToast("QR saved");
    } catch (error) {
      setScanNote(`The QR was read, but it was not saved: ${String(error)}`);
      return;
    }
    if (!isTauri() || !["telegram", "discord", "slack", "whatsapp"].includes(result.channelId)) return;
    if (channel?.status === "connected") return;
    try {
      const info = await invokeRaw<GatewayConnectionInfo>("gateway_connect", {
        channelId: result.channelId,
        token: result.token,
        ownerId: draft.ownerId,
      });
      setLiveConnections((prev) => ({ ...prev, [result.channelId]: info }));
      setChannels((prev) => prev.map((item) => (
        item.id === result.channelId
          ? { ...item, status: liveStateToStatus(info.state), enabled: info.state === "Connected", conflictError: info.error ?? undefined }
          : item
      )));
      if (info.state === "Connected") {
        await persistGatewayCredentials(result.channelId, draft, true);
        reconnectSaved.current.add(result.channelId);
        showToast("Gateway connected");
      } else if (info.error) {
        setScanNote(info.error);
      }
    } catch (error) {
      setScanNote(error instanceof Error ? error.message : String(error));
    }
  };

  const startScanner = async () => {
    const reader = barcodeReader();
    if (!reader) {
      setScanNote("This view cannot open a camera decoder. Paste the text from the QR below, or choose an image.");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setScanNote("This view has no camera. Paste the text from the QR, or choose an image.");
      return;
    }
    try {
      stopScanner();
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      scanStreamRef.current = stream;
      setScanning(true);
      setScanNote("Point the camera at the QR code.");
    } catch (error) {
      stopScanner();
      setScanNote(error instanceof Error ? error.message : String(error));
    }
  };

  const scanImageFile = async (file: File | undefined) => {
    if (!file) return;
    const reader = barcodeReader();
    if (!reader) {
      setScanNote("This view cannot read a QR image. Paste the text from the QR below.");
      return;
    }
    try {
      const bitmap = await createImageBitmap(file);
      const codes = await reader.detect(bitmap);
      bitmap.close();
      const value = codes[0]?.rawValue?.trim() ?? "";
      if (!value) {
        setScanNote("No QR code was found in that image.");
        return;
      }
      await applyScannedText(value);
    } catch (error) {
      setScanNote(error instanceof Error ? error.message : String(error));
    }
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
        `[BLOCKED] Push alert to ${activeChannel.name} dropped — ${pushBlockReason(activeChannel)}.`
      );
      showToast(`${activeChannel.name} is not ready`);
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
        `[BLOCKED] ${decision.handle} is routable, but ${activeChannel.name}: ${pushBlockReason(activeChannel)}.`
      );
      showToast(`${activeChannel.name} is not ready`);
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
        senderDisplay: "",
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
                      void openPairingQr(activeChannel.id, true);
                      return;
                    }
                    setShowQrPanel((open) => !open);
                  }}
                  className="px-4 py-2 text-xs font-semibold bg-white border border-slate-200 text-slate-700 rounded-full hover:bg-slate-50 hover:text-slate-900 transition-all cursor-pointer shadow-xs active:scale-95 flex items-center gap-1.5"
                >
                  {channelUsesQrPairing(activeChannel.id) ? <RefreshCw size={13} /> : <QrCode size={13} />}
                  <span>
                    {channelUsesQrPairing(activeChannel.id)
                      ? "Refresh QR"
                      : showQrPanel
                      ? "Hide"
                      : "How to connect"}
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

            {showQrPanel && !channelUsesQrPairing(activeChannel.id) && (
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5 space-y-2">
                <div className="text-sm font-bold text-slate-900">
                  Connect {activeChannel.name}
                </div>
                <p className="text-xs text-slate-600 leading-relaxed">
                  Paste the bot token or scan a QR that contains it. Save stores it on this computer.
                  Then choose Connect gateway and turn on one bot. If the owner field is empty, the first person who messages the bot is saved as the owner.
                </p>
              </div>
            )}

            {/* QR Pairing Panel */}
            {channelUsesQrPairing(activeChannel.id) && (
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
                        {activeLive?.state === "Connected"
                          ? "This channel is connected."
                          : activeLive?.state === "Error" && activeLive.error
                          ? activeLive.error
                          : qrError
                          || (activeChannel.id === "whatsapp"
                            ? "Asking WhatsApp for a link code…"
                            : "Press New code for a same-Wi-Fi page, or scan the gateway QR below.")}
                      </span>
                    </div>
                  )}
                  <div className="flex-1 min-w-0 space-y-2">
                    <div className="text-sm font-bold text-slate-900">
                      Pairing QR for {activeChannel.name}
                    </div>
                    <p className="text-xs text-slate-600 leading-relaxed">
                      {activeChannel.id === "whatsapp"
                        ? whatsappLinkInstructions()
                        : "Open the camera on a phone that is on the same Wi-Fi as this computer and tap the link. Confirm on the page that opens. This channel connects when that page says the phone is paired. The code pairs Ronic OS. It does not log in to Signal, WeChat, or iMessage."}
                    </p>
                    {activeChannel.id !== "whatsapp" && activeQr?.uri?.includes("127.0.0.1") && (
                      <p className="text-xs text-amber-800 leading-relaxed">
                        This computer has no network address a phone can reach. Join Wi-Fi and press Refresh QR.
                      </p>
                    )}
                    {activeChannel.id !== "whatsapp" && (
                      <p className="text-xs text-slate-500 leading-relaxed">
                        If the phone cannot open the page, allow Ronic OS on private networks when Windows asks.
                      </p>
                    )}
                    {activeChannel.id !== "whatsapp" && activeQr?.uri && (
                      <p className="text-xs text-slate-500 break-all font-mono bg-white p-2 rounded-xl border border-slate-200">
                        {activeQr.uri}
                      </p>
                    )}
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void openPairingQr(activeChannel.id, true)}
                        className="px-3.5 py-1.5 text-xs font-semibold bg-white border border-slate-200 text-slate-700 rounded-full hover:bg-slate-50 cursor-pointer"
                      >
                        New code
                      </button>
                      <p className="text-xs text-emerald-700 font-semibold flex items-center gap-1.5">
                        <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                        {activeLive?.state === "AwaitingQrScan"
                          ? activeChannel.id === "whatsapp"
                            ? "Waiting for WhatsApp to accept the scan."
                            : "Waiting for the phone to confirm."
                          : activeLive?.state === "Connecting" && activeChannel.id === "whatsapp"
                          ? "Asking WhatsApp for a link code…"
                          : activeLive?.state === "Connected"
                          ? "This channel is already connected."
                          : activeQr?.dataUrl
                          ? "The code is ready to scan."
                          : "No code on screen yet."}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            )}

            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5 space-y-3">
              <div>
                <h3 className="text-sm font-bold text-slate-900">Scan a gateway QR</h3>
                <p className="text-xs text-slate-600 mt-1 leading-relaxed">
                  Point the camera at the QR that Telegram, WhatsApp, or the other gateway shows. A bot token is saved and used to connect. A WhatsApp linked-device code is shown here so the phone can scan it from Linked devices.
                </p>
              </div>
              {scanning && (
                <video
                  ref={scanVideoRef}
                  className="w-full max-w-xs rounded-2xl border border-slate-300 bg-black"
                  muted
                  playsInline
                />
              )}
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => { if (scanning) stopScanner(); else void startScanner(); }}
                  className="px-3.5 py-1.5 text-xs font-semibold bg-zinc-800 text-white rounded-full cursor-pointer inline-flex items-center gap-1.5"
                >
                  <Camera size={13} />
                  {scanning ? "Stop camera" : "Use camera"}
                </button>
                <label className="px-3.5 py-1.5 text-xs font-semibold bg-white border border-slate-200 text-slate-700 rounded-full cursor-pointer inline-flex items-center gap-1.5">
                  <Upload size={13} />
                  Choose image
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = "";
                      void scanImageFile(file);
                    }}
                  />
                </label>
              </div>
              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  type="text"
                  value={scanPaste}
                  onChange={(event) => setScanPaste(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void applyScannedText(scanPaste);
                    }
                  }}
                  placeholder="Or paste the QR text"
                  className="flex-1 px-3.5 py-2 text-xs font-mono bg-white border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-slate-200"
                />
                <button
                  type="button"
                  onClick={() => void applyScannedText(scanPaste)}
                  className="px-4 py-2 text-xs font-semibold bg-white border border-slate-200 text-slate-700 rounded-full cursor-pointer"
                >
                  Use text
                </button>
              </div>
              {scanNote && <p className="text-xs text-slate-600 leading-relaxed">{scanNote}</p>}
            </div>

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
                  <Lock size={10} /> Saved on this computer
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
                    placeholder="e.g. 6194820194 or @username"
                    className="w-full px-3.5 py-2 text-xs font-mono bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-slate-200 transition-all"
                  />
                  <span className="block text-[11px] text-slate-400 mt-1">
                    Used when you connect. To let a blocked sender through now, use Owner allowlist below.
                  </span>
                </div>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4 space-y-3">
                <div>
                  <h4 className="text-xs font-bold text-slate-900">Owner allowlist</h4>
                  <p className="text-[11px] text-slate-500 mt-0.5 leading-relaxed">
                    People on this list can message the bot. Allowing someone takes effect on the next message. You do not need to reconnect.
                  </p>
                </div>
                {blockedStillOut && blockedSender && (
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2">
                    <p className="text-xs text-amber-950">
                      <span className="font-mono font-semibold">{blockedSender.senderId}</span>
                      {blockedSender.senderDisplay ? ` · ${blockedSender.senderDisplay}` : ""} is blocked.
                    </p>
                    <button
                      type="button"
                      onClick={() => handleAllowOwner(blockedSender.senderId)}
                      className="px-3.5 py-1.5 text-xs font-semibold bg-zinc-800 hover:bg-zinc-700 text-white rounded-full cursor-pointer"
                    >
                      Allow
                    </button>
                  </div>
                )}
                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    type="text"
                    value={allowDraft}
                    onChange={(event) => setAllowDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        handleAllowOwner(allowDraft.trim() || (blockedStillOut ? blockedSender?.senderId ?? "" : ""));
                      }
                    }}
                    placeholder={blockedStillOut && blockedSender ? blockedSender.senderId : "Numeric id or @username"}
                    className="flex-1 px-3.5 py-2 text-xs font-mono bg-white border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-slate-200"
                  />
                  <button
                    type="button"
                    onClick={() => handleAllowOwner(allowDraft.trim() || (blockedStillOut ? blockedSender?.senderId ?? "" : ""))}
                    className="px-5 py-2 text-xs font-semibold bg-zinc-800 hover:bg-zinc-700 text-white rounded-full cursor-pointer shadow-xs active:scale-95"
                  >
                    Owner allowlist
                  </button>
                </div>
                <div className="flex flex-wrap gap-2">
                  {allowedOwners.length === 0 ? (
                    <p className="text-[11px] text-slate-500">
                      No owner yet. The next person who messages the bot is allowed, or type an id and press Owner allowlist.
                    </p>
                  ) : (
                    allowedOwners.map((id) => (
                      <span
                        key={id}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white border border-slate-200 text-xs font-mono text-slate-800"
                      >
                        {id}
                        <button
                          type="button"
                          onClick={() => handleRemoveOwner(id)}
                          className="text-slate-400 hover:text-rose-600 cursor-pointer"
                          aria-label={`Remove ${id} from the owner allowlist`}
                        >
                          <Trash2 size={12} />
                        </button>
                      </span>
                    ))
                  )}
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
                      Name a Slack row “App token” to include it in Socket Mode. Name a row “Allowlisted sender” or “Chat ID” to let that id through the owner firewall. Name a WhatsApp row “Cloud API token” to use it when the bot token is empty. Save keeps every row on this computer.
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
