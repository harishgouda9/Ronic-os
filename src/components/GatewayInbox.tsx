import { useEffect, useRef } from "react";
import { invokeRaw, isTauri } from "../api";
import { inboundChiefAction } from "../kernel/chiefDelegation";
import { runGatewayTurn } from "../kernel/gatewayTurn";
import {
  allowOwner,
  channelAcceptsReply,
  fleetMembers,
  type GatewayConnectionInfo,
  inboundAccess,
  type IncomingGatewayMessage,
  outboundChannelChunks,
  ownerAllowlistRefusal,
  rememberBlockedSender,
  resolveInboundRoute,
  storedGatewayRoute,
} from "../kernel/messagingGateway";
import { useRonic } from "../store";

const NAMES: Record<string, string> = {
  telegram: "Telegram",
  whatsapp: "WhatsApp",
  discord: "Discord",
  slack: "Slack",
  google_chat: "Google Chat",
  signal: "Signal",
  wechat: "WeChat",
  bluebubbles: "iMessage",
};

function channelName(id: string) {
  return NAMES[id] ?? id;
}

function note(line: string) {
  window.dispatchEvent(new CustomEvent("ronic-gateway-log", { detail: line }));
}

async function sendReply(channelId: string, chatId: string, text: string) {
  const chat = chatId.trim();
  const body = text.trim();
  if (!chat || !body || !channelAcceptsReply(channelId)) return;
  for (const chunk of outboundChannelChunks(channelId, body)) {
    await invokeRaw<string>("gateway_send_message", { channelId, chatId: chat, text: chunk });
  }
}

/**
 * Drains gateway messages on every screen, including while the window is in
 * the background. The messaging screen used to be the only poller, so a
 * Telegram chat went quiet as soon as that screen was closed, and the answer
 * never left the desktop chat.
 */
export function GatewayInbox() {
  const run = useRonic((s) => s.run);
  const snap = useRonic((s) => s.snap);
  const fleetRef = useRef(fleetMembers(snap?.profiles ?? [], snap?.botGroups ?? []));
  fleetRef.current = fleetMembers(snap?.profiles ?? [], snap?.botGroups ?? []);
  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    if (!isTauri()) return;
    let stopped = false;
    let restored = false;
    const restore = async () => {
      if (stopped || restored) return;
      try {
        await invokeRaw<string[]>("gateway_restore_saved", {});
        restored = true;
      } catch (error) {
        const message = String(error);
        if (!/unlock the vault/i.test(message)) restored = true;
      }
    };
    void restore();
    const retry = window.setInterval(() => void restore(), 5000);
    return () => {
      stopped = true;
      window.clearInterval(retry);
    };
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let stopped = false;
    let busy = false;

    const tick = async () => {
      if (stopped || busy) return;
      busy = true;
      try {
        const infos = await invokeRaw<GatewayConnectionInfo[]>("gateway_connection_status", {});
        if (stopped) return;
        if (!infos.some((info) => info.state === "Connected")) return;
        const messages = await invokeRaw<IncomingGatewayMessage[]>("gateway_poll_messages", {});
        if (stopped || messages.length === 0) return;
        const owners = new Map<string, string>();
        for (const info of infos) {
          const stored = (info.owner_id || "").trim();
          if (stored) owners.set(info.channel_id, stored);
        }
        for (const msg of messages) {
          if (stopped) return;
          const name = channelName(msg.channel_id);
          note(`[${name} ← ${msg.sender_display || msg.sender_id}] ${msg.text}`);
          const access = inboundAccess(msg.channel_id, owners.get(msg.channel_id) ?? "", msg.sender_id, msg.sender_display || "");
          if (access.ok && access.adoptedOwnerId) {
            owners.set(msg.channel_id, access.adoptedOwnerId);
            allowOwner(msg.channel_id, "", access.adoptedOwnerId);
            void invokeRaw<string>("gateway_remember_owner", { channelId: msg.channel_id, ownerId: access.adoptedOwnerId }).catch(() => undefined);
            note(`[${name}] Owner allowlist was empty. Adopted ${msg.sender_display || access.adoptedOwnerId} as the owner.`);
            window.dispatchEvent(new CustomEvent("ronic-gateway-allowlist", { detail: msg.channel_id }));
          }
          if (!access.ok) {
            rememberBlockedSender(msg.channel_id, msg.sender_id, msg.sender_display || "");
            window.dispatchEvent(new CustomEvent("ronic-gateway-allowlist", { detail: msg.channel_id }));
            note(`[BLOCKED] ${name} ${access.reason}. Open Owner allowlist and press Allow.`);
            try {
              await sendReply(msg.channel_id, msg.chat_id, ownerAllowlistRefusal(access.reason));
            } catch (error) {
              note(`[${name}] Could not send the block notice: ${error instanceof Error ? error.message : String(error)}`);
            }
            continue;
          }
          const trimmed = msg.text.trim();
          const action = inboundChiefAction(trimmed);
          // #group and @manager are chief routes, same as /chief. Dropping them sent the text to a normal chat turn.
          if (action) {
            const res = await runRef.current("handle_mobile_chief_command", {
              channelId: msg.channel_id,
              senderId: msg.sender_id,
              senderDisplay: msg.sender_display,
              chatId: msg.chat_id,
              text: action.text,
              callback: action.callback,
            });
            const payload = res?.payload as { card?: string; delivered?: boolean; deliveryError?: string | null } | undefined;
            if (payload?.card) note(payload.card);
            else note(res?.toast || useRonic.getState().toast || "Chief delegation did not run.");
            if (payload && payload.delivered === false && payload.deliveryError) note(`Phone delivery: ${payload.deliveryError}`);
            continue;
          }
          const route = storedGatewayRoute(msg.channel_id);
          const decision = resolveInboundRoute(trimmed, route, fleetRef.current);
          if (!decision.ok) {
            note(`[${name}] ${decision.reason}`);
            try {
              await sendReply(msg.channel_id, msg.chat_id, decision.reason);
            } catch (error) {
              note(`[${name}] Could not send that notice: ${error instanceof Error ? error.message : String(error)}`);
            }
            continue;
          }
          const bot = useRonic.getState().snap?.profiles.find((profile) => profile.id === decision.botId);
          if (!bot) {
            const missing = `${decision.handle} has no profile to receive this message.`;
            note(missing);
            try { await sendReply(msg.channel_id, msg.chat_id, missing); } catch { /* the log is enough */ }
            continue;
          }
          try {
            const reply = await runGatewayTurn(
              runRef.current,
              () => useRonic.getState().snap,
              bot,
              name,
              decision.kind === "group"
                ? `[${name} → ${decision.handle}] ${decision.prompt}`
                : `[${name}] ${decision.prompt}`,
            );
            const text = reply.trim() || "I received that, but no reply was produced. Choose a model in the Ronic OS chat and send it again.";
            await sendReply(msg.channel_id, msg.chat_id, text);
            note(`Replied to ${msg.sender_display || msg.sender_id} on ${name}.`);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            note(`[${name}] Reply failed: ${message}`);
            try { await sendReply(msg.channel_id, msg.chat_id, message); } catch { /* already logged */ }
          }
        }
      } catch {
        // Backend not ready yet.
      } finally {
        busy = false;
      }
    };

    void tick();
    const timer = window.setInterval(() => void tick(), 3000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, []);

  return null;
}
