import type { Snapshot } from "../types";
import { gatewayAssistantReply } from "./messagingGateway";
import { composerModelFor, effortFor } from "./modelPrefs";

type Runner = (cmd: string, payload?: Record<string, unknown>) => Promise<{ snapshot: Snapshot } | null>;

/**
 * Asks the routed bot and returns only the assistant text from this turn.
 * The chat the person was looking at is restored afterwards.
 */
export async function runGatewayTurn(
  run: Runner,
  readSnap: () => Snapshot | null,
  bot: { id: string; engineKind: string },
  channelName: string,
  prompt: string,
): Promise<string> {
  const current = readSnap();
  if (!current) return "";
  const prevThread = current.activeThreadId;
  const prevProfile = current.activeProfileId;
  const title = `Gateway · ${channelName}`;
  let reply = "";
  try {
    await run("switch_profile", { profileId: bot.id });
    const after = readSnap();
    const existing = after?.threads.find((thread) =>
      thread.botProfileId === bot.id && thread.title === title && thread.targetType !== "bot_group",
    );
    let threadId = existing?.id ?? "";
    if (existing) await run("select_thread", { threadId: existing.id });
    else {
      await run("create_thread", { title });
      threadId = readSnap()?.activeThreadId ?? "";
    }
    const before = new Set(
      (readSnap()?.steps ?? []).filter((step) => step.threadId === threadId).map((step) => step.id),
    );
    const bound = bot.engineKind === "openai_api" || bot.engineKind === "subscription";
    const selected = bound ? null : composerModelFor(bot.id);
    const sent = await run("send_message", selected
      ? { prompt, providerId: selected.providerId, model: selected.upstreamModel, modelId: selected.id, effort: effortFor(selected.id) }
      : { prompt });
    const steps = sent?.snapshot?.steps ?? readSnap()?.steps ?? [];
    reply = gatewayAssistantReply(steps, threadId, before);
  } finally {
    const latest = readSnap();
    if (prevThread && latest?.threads.some((thread) => thread.id === prevThread)) {
      await run("select_thread", { threadId: prevThread });
    } else if (prevProfile && prevProfile !== bot.id) {
      await run("switch_profile", { profileId: prevProfile });
    }
  }
  return reply;
}
