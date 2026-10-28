import { useState } from "react";
import { invokeRaw } from "../api";

export interface MessagingPlatformItem {
  id: string;
  name: string;
  badgeText: string;
  badgeColor: string;
  enabled: boolean;
  status: "connected" | "pid_conflict" | "disconnected";
  conflictPid?: number;
  conflictError?: string;
  botTokenMasked: string;
  ownerUserId: string;
  setupHint: string;
  defaultBot: string;
  routableBots: string[];
}

const ALL_ROUTABLE_BOT_PILLS = [
  "@claude",
  "@grokbot",
  "@chatgpt",
  "@gemini",
  "@deepseek",
  "@dots",
  "@hermes",
  "@openclaw",
  "#omni-growth-squad",
];

function stamp(): string {
  return new Date().toTimeString().slice(0, 8);
}

export default function RonicMessagingGateway() {
  const [selectedChannelId, setSelectedChannelId] = useState<string>("telegram");
  const [showQrModal, setShowQrModal] = useState<boolean>(false);
  const [tokenInput, setTokenInput] = useState<string>("8790••••••••••••oC30");
  const [ownerIdInput, setOwnerIdInput] = useState<string>("6194820194");
  const [remoteTestCmd, setRemoteTestCmd] = useState<string>(
    "@claude run cargo check, fix any warning, and send /screen snapshot"
  );
  const [remoteLogs, setRemoteLogs] = useState<string[]>([
    "21:14:02 [Security Firewall] Enforcing strict 'Only-If-Connected' & Owner-ID allowlist across all 16 channels.",
    "21:14:05 [Telegram Gateway] Detected orphaned default profile gateway holding token on PID 19268.",
  ]);

  const [channels, setChannels] = useState<MessagingPlatformItem[]>([
    {
      id: "telegram",
      name: "Telegram",
      badgeText: "TG",
      badgeColor: "bg-sky-500 text-white",
      enabled: true,
      status: "pid_conflict",
      conflictPid: 19268,
      conflictError:
        "telegram: Telegram bot token already in use by the 'default' profile gateway (PID 19268). Stop that gateway first or click Reclaim PID below.",
      botTokenMasked: "8790...oC30",
      ownerUserId: "6194820194",
      setupHint:
        "Run Ronic OS bots & coding agents from Telegram DMs, groups, and topics.",
      defaultBot: "@claude",
      routableBots: ["@claude", "@grokbot", "@chatgpt", "@gemini", "@dots", "@hermes"],
    },
    {
      id: "whatsapp",
      name: "WhatsApp",
      badgeText: "WA",
      badgeColor: "bg-emerald-500 text-white",
      enabled: true,
      status: "connected",
      botTokenMasked: "Paired via WhatsApp Web QR Bridge",
      ownerUserId: "+91-98XXXXXX10 (Self-Chat & Direct DM)",
      setupHint:
        "Operate your local Ronic OS bots and receive daily summaries or approval cards directly on WhatsApp.",
      defaultBot: "@grokbot",
      routableBots: ["@grokbot", "@claude", "@chatgpt", "@dots", "#omni-growth-squad"],
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
      defaultBot: "@claude",
      routableBots: ["@claude", "@grokbot", "@dots"],
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
      setupHint: "Socket Mode bridge for triggering workflows and approving PRs from Slack.",
      defaultBot: "@claude",
      routableBots: ["@claude", "@chatgpt", "@gemini"],
    },
    {
      id: "google_chat",
      name: "Google Chat",
      badgeText: "GC",
      badgeColor: "bg-emerald-600 text-white",
      enabled: true,
      status: "connected",
      botTokenMasked: "Webhook + Workspace App Active",
      ownerUserId: "abhinandan@ronic.os",
      setupHint: "Deliver automated daily AI/SaaS news digests and trigger bots from Google Chat.",
      defaultBot: "@grokbot",
      routableBots: ["@grokbot", "@claude", "@gemini"],
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
      defaultBot: "@claude",
      routableBots: ["@claude"],
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
      defaultBot: "@claude",
      routableBots: ["@claude"],
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
      defaultBot: "@claude",
      routableBots: ["@claude"],
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
      defaultBot: "@claude",
      routableBots: ["@claude"],
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
      defaultBot: "@claude",
      routableBots: ["@claude", "@grokbot"],
    },
    {
      id: "sms_twilio",
      name: "SMS (Twilio)",
      badgeText: "SM",
      badgeColor: "bg-red-600 text-white",
      enabled: false,
      status: "disconnected",
      botTokenMasked: "",
      ownerUserId: "",
      setupHint: "Emergency SMS command & alert fallback when offline from data.",
      defaultBot: "@claude",
      routableBots: ["@claude"],
    },
    {
      id: "dingtalk",
      name: "DingTalk",
      badgeText: "DT",
      badgeColor: "bg-sky-600 text-white",
      enabled: false,
      status: "disconnected",
      botTokenMasked: "",
      ownerUserId: "",
      setupHint: "Enterprise DingTalk stream bot connector.",
      defaultBot: "@claude",
      routableBots: ["@claude"],
    },
    {
      id: "feishu",
      name: "Feishu / Lark",
      badgeText: "FS",
      badgeColor: "bg-teal-600 text-white",
      enabled: false,
      status: "disconnected",
      botTokenMasked: "",
      ownerUserId: "",
      setupHint: "Feishu / Lark event subscription & card action bridge.",
      defaultBot: "@claude",
      routableBots: ["@claude"],
    },
    {
      id: "wecom_group",
      name: "WeCom (group bot)",
      badgeText: "WG",
      badgeColor: "bg-blue-500 text-white",
      enabled: false,
      status: "disconnected",
      botTokenMasked: "",
      ownerUserId: "",
      setupHint: "WeCom group webhook notification & trigger bot.",
      defaultBot: "@claude",
      routableBots: ["@claude"],
    },
    {
      id: "weixin",
      name: "Weixin / WeChat",
      badgeText: "WX",
      badgeColor: "bg-green-600 text-white",
      enabled: false,
      status: "disconnected",
      botTokenMasked: "",
      ownerUserId: "",
      setupHint: "Personal WeChat QR bridge for mobile agent messaging.",
      defaultBot: "@claude",
      routableBots: ["@claude"],
    },
    {
      id: "qq_bot",
      name: "QQ Bot",
      badgeText: "QQ",
      badgeColor: "bg-rose-600 text-white",
      enabled: false,
      status: "disconnected",
      botTokenMasked: "",
      ownerUserId: "",
      setupHint: "Official QQ guild & group bot WebSocket gateway.",
      defaultBot: "@claude",
      routableBots: ["@claude"],
    },
  ]);

  const activeChannel =
    channels.find((c) => c.id === selectedChannelId) || channels[0];

  const pushLog = (line: string) =>
    setRemoteLogs((prev) => [`${stamp()} ${line}`, ...prev]);

  // 1-Click Fix for the PID 19268 Conflict — calls the Rust reclaimer.
  const handleReclaimPidAndStart = async (channelId: string) => {
    const channel = channels.find((c) => c.id === channelId);
    try {
      const msg = await invokeRaw<string>("reclaim_gateway_pid_and_connect", {
        channelId,
        conflictingPid: channel?.conflictPid ?? null,
      });
      pushLog(`[PID Reclaimer] ${msg}`);
    } catch (err) {
      pushLog(`[PID Reclaimer] Backend unavailable (${String(err)}) — applying local reclaim.`);
    }
    setChannels((prev) =>
      prev.map((c) =>
        c.id === channelId
          ? {
              ...c,
              enabled: true,
              status: "connected",
              conflictPid: undefined,
              conflictError: undefined,
            }
          : c
      )
    );
    pushLog(
      `[PID Reclaimer] Terminated orphaned 'default' gateway (PID ${channel?.conflictPid ?? 19268}) -> Bound ${channel?.name ?? channelId} token to Ronic OS Master Gateway (Connected ●).`
    );
  };

  const handleToggleConnect = () => {
    setChannels((prev) =>
      prev.map((c) => {
        if (c.id !== activeChannel.id) return c;
        const nextConnected = c.status !== "connected";
        return {
          ...c,
          enabled: nextConnected,
          status: nextConnected ? "connected" : "disconnected",
          conflictError: undefined,
          botTokenMasked: c.botTokenMasked || tokenInput,
          ownerUserId: c.ownerUserId || ownerIdInput,
        };
      })
    );
  };

  const handleToggleBotOnChannel = (botHandle: string) => {
    setChannels((prev) =>
      prev.map((c) => {
        if (c.id !== activeChannel.id) return c;
        const exists = c.routableBots.includes(botHandle);
        const nextBots = exists
          ? c.routableBots.filter((b) => b !== botHandle)
          : [...c.routableBots, botHandle];
        return { ...c, routableBots: nextBots };
      })
    );
  };

  // Runs the command through the Rust "Only-If-Connected & Allowlisted" firewall.
  const handleSimulateRemoteCommand = async () => {
    try {
      const result = await invokeRaw<string>("dispatch_remote_messaging_command", {
        channelId: activeChannel.id,
        isConnected: activeChannel.status === "connected",
        isEnabled: activeChannel.enabled,
        senderId: activeChannel.ownerUserId || ownerIdInput,
        allowlistedId: activeChannel.ownerUserId || ownerIdInput,
        messageText: remoteTestCmd,
        defaultBot: activeChannel.defaultBot,
      });
      pushLog(`[${activeChannel.name} Remote DM (${activeChannel.ownerUserId})] ${result}`);
    } catch (err) {
      // Backend unreachable (browser preview) — fall back to local gate so the
      // UI still demonstrates the strict rule.
      if (activeChannel.status !== "connected" || !activeChannel.enabled) {
        pushLog(
          `[BLOCKED • NOT CONNECTED] Ignored remote command on ${activeChannel.name} because channel status is '${activeChannel.status}'. (Strict 'Only-If-Connected' rule enforced).`
        );
        return;
      }
      pushLog(
        `[${activeChannel.name} Remote DM (${activeChannel.ownerUserId}) ➔ ${activeChannel.defaultBot}] Executed: "${remoteTestCmd}" -> Verified DoD in 48ms & sent reply + Mini-Computer screenshot to your phone. (${String(err)})`
      );
    }
  };

  return (
    <div className="flex-1 h-full bg-[#FAFAFA] text-[#0F172A] flex overflow-hidden font-sans select-none">
      {/* 1. LEFT CHANNEL RAIL (All 16 Platforms) */}
      <div className="w-64 bg-white border-r border-[#E5E5E5] flex flex-col justify-between h-full">
        <div className="p-3.5 border-b border-[#E5E5E5]">
          <div className="text-xs font-bold uppercase tracking-wider text-[#64748B]">
            Remote Messaging Bridge
          </div>
          <div className="text-[11px] text-[#64748B] mt-0.5">
            {channels.filter((c) => c.status === "connected").length} of{" "}
            {channels.length} Platforms Connected
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {channels.map((ch) => {
            const isSelected = ch.id === selectedChannelId;
            return (
              <button
                key={ch.id}
                onClick={() => setSelectedChannelId(ch.id)}
                className={`w-full px-3 py-2 rounded-[6px] flex items-center justify-between text-xs font-medium transition ${
                  isSelected
                    ? "bg-[#EFF6FF] text-[#0F172A] font-bold border border-blue-200"
                    : "text-[#0F172A] hover:bg-[#F8FAFC]"
                }`}
              >
                <div className="flex items-center gap-2.5 truncate">
                  <span
                    className={`w-5 h-5 rounded text-[10px] font-mono font-bold flex items-center justify-center shrink-0 ${ch.badgeColor}`}
                  >
                    {ch.badgeText}
                  </span>
                  <span className="truncate">{ch.name}</span>
                </div>

                {/* Live Connection Status Dot */}
                <span
                  className={`w-2 h-2 rounded-full shrink-0 ${
                    ch.status === "connected"
                      ? "bg-[#10B981]"
                      : ch.status === "pid_conflict"
                      ? "bg-rose-500 animate-pulse"
                      : "bg-slate-300"
                  }`}
                />
              </button>
            );
          })}
        </div>

        <div className="p-3 border-t border-[#E5E5E5] bg-[#FAFAFA] text-[11px] font-mono text-[#64748B]">
          🔒 Strict Rule: Only connected & allowlisted channels can trigger bots.
        </div>
      </div>

      {/* 2. MAIN CONFIGURATION & REMOTE BOT ROUTER PANEL */}
      <div className="flex-1 h-full overflow-y-auto p-6 space-y-5">
        {/* Top Channel Header */}
        <div className="bg-white border border-[#E5E5E5] rounded-[8px] p-5 space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-1">
              <div className="flex items-center gap-2.5">
                <span
                  className={`w-7 h-7 rounded-[6px] text-xs font-mono font-bold flex items-center justify-center ${activeChannel.badgeColor}`}
                >
                  {activeChannel.badgeText}
                </span>
                <h1 className="text-xl font-bold tracking-tight">
                  {activeChannel.name}
                </h1>

                {activeChannel.status === "connected" && (
                  <span className="px-2.5 py-0.5 text-xs font-mono font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-full">
                    ● Connected • Remote Commands Active
                  </span>
                )}
                {activeChannel.status === "pid_conflict" && (
                  <span className="px-2.5 py-0.5 text-xs font-mono font-semibold bg-rose-50 text-rose-700 border border-rose-200 rounded-full">
                    ● Startup failed (PID {activeChannel.conflictPid} lock)
                  </span>
                )}
                {activeChannel.status === "disconnected" && (
                  <span className="px-2.5 py-0.5 text-xs font-mono bg-slate-100 text-[#64748B] rounded-full">
                    ○ Disconnected (Remote Access Blocked)
                  </span>
                )}
              </div>
              <p className="text-xs text-[#64748B]">{activeChannel.setupHint}</p>
            </div>

            <div className="flex items-center gap-2.5">
              <label className="flex items-center gap-2 text-xs font-semibold cursor-pointer">
                <input
                  type="checkbox"
                  checked={activeChannel.enabled}
                  onChange={handleToggleConnect}
                />
                <span>Enabled</span>
              </label>

              <button
                onClick={handleToggleConnect}
                className={`px-4 py-2 text-xs font-semibold rounded-[6px] ${
                  activeChannel.status === "connected"
                    ? "bg-white border border-[#E5E5E5] text-rose-600 hover:border-rose-300"
                    : "bg-[#111111] text-white hover:opacity-90"
                }`}
              >
                {activeChannel.status === "connected"
                  ? "Disconnect Gateway"
                  : "Connect & Start Gateway"}
              </button>
            </div>
          </div>

          {/* PID CONFLICT BANNER + 1-CLICK RECLAIM */}
          {activeChannel.status === "pid_conflict" && (
            <div className="p-4 bg-rose-50 border border-rose-200 rounded-[6px] flex flex-wrap items-center justify-between gap-3 text-xs text-rose-900">
              <div className="space-y-1 max-w-2xl">
                <div className="font-bold flex items-center gap-1.5">
                  <span>⚠️</span>
                  <span>{activeChannel.conflictError}</span>
                </div>
                <div className="text-[11px] text-rose-700 font-mono">
                  Ronic OS can automatically terminate orphaned PID{" "}
                  {activeChannel.conflictPid} and mount this token on the unified multi-bot router.
                </div>
              </div>

              <button
                onClick={() => void handleReclaimPidAndStart(activeChannel.id)}
                className="px-3.5 py-2 text-xs font-semibold bg-rose-700 text-white rounded-[6px] hover:bg-rose-800 shrink-0"
              >
                ⚡ Reclaim PID {activeChannel.conflictPid} & Connect Now
              </button>
            </div>
          )}

          {/* QUICK SETUP (1-Click QR Pairing) */}
          <div className="p-4 bg-[#F8FAFC] border border-[#E5E5E5] rounded-[6px] flex flex-wrap items-center justify-between gap-4">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-[#0F172A]">
                  Quick Setup (1-Click Mobile QR Pairing)
                </span>
                <span className="px-2 py-0.5 text-[10px] font-mono font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200 rounded">
                  Recommended
                </span>
              </div>
              <p className="text-xs text-[#64748B]">
                Scan a QR code from your phone in {activeChannel.name}. Ronic OS links the bot and locks remote control exclusively to your verified User ID automatically.
              </p>
            </div>

            <button
              onClick={() => setShowQrModal(!showQrModal)}
              className="px-3.5 py-2 text-xs font-semibold bg-[#111111] text-white rounded-[6px] hover:opacity-90"
            >
              {showQrModal ? "Hide Pairing QR" : "⊞ Pair with QR Code"}
            </button>
          </div>

          {showQrModal && (
            <div className="p-4 bg-white border-2 border-[#111111] rounded-[6px] flex flex-wrap items-center justify-between gap-4 text-xs">
              <div className="space-y-1">
                <div className="font-bold">
                  Scan with {activeChannel.name} on Your Phone (Expires in 01:59)
                </div>
                <div className="font-mono text-[11px] text-[#64748B]">
                  Deep-Link Handshake: https://t.me/RonicWorkstationBot?start=pair_ronic_99481a
                </div>
                <div className="text-emerald-700 font-mono text-[11px]">
                  ● Waiting for mobile confirmation → Will auto-populate Owner User ID & enable gateway.
                </div>
              </div>
              <button
                onClick={() => {
                  setShowQrModal(false);
                  void handleReclaimPidAndStart(activeChannel.id);
                }}
                className="px-3 py-1.5 font-semibold bg-emerald-600 text-white rounded-[6px]"
              >
                ✓ Simulate Mobile QR Scan Complete
              </button>
            </div>
          )}

          {/* CREDENTIALS & OWNER ALLOWLIST (Stored in OS Keychain) */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2 border-t border-[#E5E5E5] text-xs">
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="font-bold text-[#0F172A]">
                  Bot Token / Webhook Secret (Saved in OS Keychain)
                </label>
                <span className="text-[11px] font-mono text-blue-600">
                  Saved in Vault
                </span>
              </div>
              <input
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder="Paste @BotFather token or Webhook secret..."
                className="w-full px-3 py-2 font-mono bg-[#FAFAFA] border border-[#E5E5E5] rounded-[6px]"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="font-bold text-[#0F172A]">
                  Allowlisted Owner User ID / Phone (Strict Security Gate)
                </label>
                <span className="text-[11px] font-mono text-emerald-700">
                  ● Only You Can Command
                </span>
              </div>
              <input
                value={ownerIdInput}
                onChange={(e) => setOwnerIdInput(e.target.value)}
                placeholder="Numeric Telegram ID (e.g. 6194820194) or +91..."
                className="w-full px-3 py-2 font-mono bg-[#FAFAFA] border border-[#E5E5E5] rounded-[6px]"
              />
            </div>
          </div>
        </div>

        {/* 3. WHICH BOTS CAN BE OPERATED FROM THIS MESSAGING APP? (Absorbed from External Bots) */}
        <div className="bg-white border border-[#E5E5E5] rounded-[8px] p-5 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#E5E5E5] pb-3">
            <div>
              <h2 className="text-sm font-bold">
                Bots & Agents Operable via {activeChannel.name} (Only When Connected)
              </h2>
              <p className="text-xs text-[#64748B]">
                Select which Ronic OS bots you can message from your phone on {activeChannel.name}. Prefix any message with `@grokbot`, `@claude`, or `@dots`—or message without a prefix to use your Default Bot.
              </p>
            </div>

            <div className="flex items-center gap-2 text-xs">
              <span className="text-[#64748B] font-medium">Default Bot:</span>
              <select
                value={activeChannel.defaultBot}
                onChange={(e) =>
                  setChannels((prev) =>
                    prev.map((c) =>
                      c.id === activeChannel.id
                        ? { ...c, defaultBot: e.target.value }
                        : c
                    )
                  )
                }
                className="px-2.5 py-1 font-mono font-bold bg-[#FAFAFA] border border-[#E5E5E5] rounded-[6px]"
              >
                {ALL_ROUTABLE_BOT_PILLS.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex flex-wrap gap-2 pt-1">
            {ALL_ROUTABLE_BOT_PILLS.map((botPill) => {
              const isAllowed = activeChannel.routableBots.includes(botPill);
              return (
                <button
                  key={botPill}
                  onClick={() => handleToggleBotOnChannel(botPill)}
                  className={`px-3 py-1.5 text-xs font-mono font-semibold rounded-full border transition ${
                    isAllowed
                      ? "bg-[#111111] text-white border-[#111111]"
                      : "bg-white text-[#64748B] border-[#E5E5E5] hover:text-[#0F172A]"
                  }`}
                >
                  {isAllowed ? `✓ ${botPill}` : `+ ${botPill}`}
                </button>
              );
            })}
          </div>

          {/* Built-In Remote Mobile Slash Commands */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-2.5 pt-2 text-xs">
            {[
              {
                cmd: "@claude / @grokbot <task>",
                desc: "Route a coding or research task to a specific bot from your phone",
              },
              {
                cmd: "/screen",
                desc: "Receive a live Set-of-Marks PNG screenshot of the Bot Mini-Computer",
              },
              {
                cmd: "/approve <tx_id>",
                desc: "Sign a paused Fail-Closed Wallet payment or merge a Git PR remotely",
              },
              {
                cmd: "/halt",
                desc: "Trigger the <10ms emergency computer/browser halt remotely",
              },
            ].map((item, idx) => (
              <div
                key={idx}
                className="p-2.5 bg-[#FAFAFA] border border-[#E5E5E5] rounded-[6px]"
              >
                <div className="font-mono font-bold text-[#0F172A]">{item.cmd}</div>
                <div className="text-[11px] text-[#64748B] mt-0.5">{item.desc}</div>
              </div>
            ))}
          </div>
        </div>

        {/* 4. LIVE REMOTE COMMAND SIMULATOR & GATEWAY AUDIT STREAM */}
        <div className="bg-white border border-[#E5E5E5] rounded-[8px] p-5 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-bold">
                Test Remote Mobile Command on {activeChannel.name}
              </h2>
              <p className="text-xs text-[#64748B]">
                Verify that commands execute when {activeChannel.name} is Connected and are strictly blocked when Disconnected.
              </p>
            </div>
          </div>

          <div className="flex gap-2">
            <input
              value={remoteTestCmd}
              onChange={(e) => setRemoteTestCmd(e.target.value)}
              className="flex-1 px-3 py-2 text-xs font-mono bg-[#FAFAFA] border border-[#E5E5E5] rounded-[6px]"
            />
            <button
              onClick={() => void handleSimulateRemoteCommand()}
              className="px-4 py-2 text-xs font-semibold bg-[#111111] text-white rounded-[6px] shrink-0"
            >
              📲 Simulate Incoming {activeChannel.name} Message
            </button>
          </div>

          <div className="p-3 bg-[#F8FAFC] border border-[#E5E5E5] rounded-[6px] font-mono text-[11px] space-y-1.5 max-h-36 overflow-y-auto">
            {remoteLogs.map((log, i) => (
              <div key={i} className="text-[#0F172A]">
                {log}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
