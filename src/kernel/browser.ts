import type {
  BotProfile,
  ChatThread,
  CommandResult,
  MemoryEngine,
  MemoryItem,
  MemoryRoute,
  Policy,
  ProviderType,
  Snapshot,
  Step,
  WalletTx,
  WfNode,
} from "../types";
import { completeChat, hasStoredSecret, openSite, pingProvider, probeModel, rememberSecret, type ChatMessage, type Effort } from "./liveChat";
import { modelById } from "./modelPrefs";
import { installCatalog, installMcp, installPlugin, installSkillFromMarket, installSkillFromUrl, connectMcp, proposeSkill, removeMcp, removePlugin, removeSkill, resolveProposal, saveMcp, savePlugin, saveSkill, toggleMcp, togglePluginAgent, togglePluginDesktop, toggleSkill, trustMcp, trustPlugin } from "./capabilityState";
import { ensurePrebuilt } from "./prebuiltSkills";
import { inIndex, rebuildRegistry } from "./skillIndex";
import { MARKETPLACE_CATALOG } from "./marketplaceCatalog";
import { applyWorkspaceTool, parseToolFence, workspaceSystem, type ToolBag } from "./workspaceTools";

function quickQuestion(text: string) {
  const value = text.trim();
  if (!value || value.length > 240 || value.startsWith("/")) return false;
  return !/mcp|composio|skill|plugin|file|folder|command|run |check |list |connect|install|open |read |write |remember|search|wallet|browser|page|diff|git |npm|cargo/.test(value.toLowerCase());
}

const DEMO_MEMORY_IDS = new Set(["mem_101", "mem_102", "mem_103", "mem_104"]);
const DEMO_MEMORY_TITLES = new Set([
  "Core Desktop & Database Stack",
  "Supercharge (Harness²) Auto-Trigger Rule",
  "Wallet Policy & Hyperliquid Builder Rebate",
  "UI Design System Preference",
]);

const KEY = "omniworkspace.browser.v6";
let skipGate = false;
let state: Snapshot = load();

function referenceFixture(snap: Snapshot): boolean {
  const balances = JSON.stringify(snap.balances ?? []);
  if (/1,240\.50|1240\.5|18,500|18500|4821|SOL-PERP/.test(balances)) return true;
  const crypto = (snap.balances ?? []).find((row) => row.rail === "crypto_x402");
  const inr = (snap.balances ?? []).find((row) => row.rail === "razorpay_upi");
  if (crypto && Math.abs(Number(crypto.nativeValue) - 1240.5) < 0.02) return true;
  if (inr && Math.abs(Number(inr.nativeValue) - 18500) < 1) return true;
  const ids = new Set([
    ...(snap.profiles ?? []).map((item) => item.id),
    ...(snap.threads ?? []).map((item) => item.id),
    ...(snap.workflows ?? []).map((item) => item.id),
    ...(snap.positions ?? []).map((item) => item.symbol),
  ]);
  for (const id of ["bot_fullstack", "bot_quant", "bot_grok", "bot_muse", "bot_dots", "thread_auth", "wf_market", "SOL-PERP"]) {
    if (ids.has(id)) return true;
  }
  if (snap.settings?.plan === "Pro Workstation") return true;
  return (snap.settings?.ghostRunners ?? []).some((name) => /Quant-Trader|Grokbot-Scout/.test(name));
}

function load(): Snapshot {
  try {
    localStorage.removeItem("omniworkspace.browser.v1");
    localStorage.removeItem("omniworkspace.browser.v2");
    localStorage.removeItem("omniworkspace.browser.v3");
    localStorage.removeItem("omniworkspace.browser.v4");
    localStorage.removeItem("omniworkspace.browser.v5");
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Snapshot;
      if (!referenceFixture(parsed)) return repair(parsed);
      localStorage.removeItem(KEY);
    }
  } catch {
    localStorage.removeItem(KEY);
  }
  const snap = seed();
  ensurePrebuilt(snap);
  return snap;
}

function repair(snap: Snapshot): Snapshot {
  const fresh = seed();
  if (!Array.isArray(snap.memoryEngines) || snap.memoryEngines.length === 0) snap.memoryEngines = fresh.memoryEngines;
  if (!snap.memoryRoute) snap.memoryRoute = fresh.memoryRoute;
  if (!Array.isArray(snap.memoryRoutes) || snap.memoryRoutes.length === 0) snap.memoryRoutes = fresh.memoryRoutes;
  if (!Array.isArray(snap.botGroups)) snap.botGroups = [];
  if (!Array.isArray(snap.gatewayAudits)) snap.gatewayAudits = [];
  if (!Array.isArray(snap.profiles) || snap.profiles.length === 0) {
    snap.profiles = fresh.profiles;
    snap.activeProfileId = fresh.activeProfileId;
  }
  if (!Array.isArray(snap.threads) || snap.threads.length === 0) {
    snap.threads = fresh.threads;
    snap.activeThreadId = fresh.activeThreadId;
  }
  if (!Array.isArray(snap.memories)) snap.memories = [];
  snap.memories = snap.memories.filter((memory) => !(DEMO_MEMORY_IDS.has(memory.id) && DEMO_MEMORY_TITLES.has(memory.title)));
  for (const memory of snap.memories) {
    if (!Array.isArray(memory.syncedEngines)) memory.syncedEngines = [];
  }
  snap.profiles = snap.profiles.map((profile) => makeProfile(profile));
  snap.threads = snap.threads.map((thread) => makeThread(thread));
  if (!Array.isArray(snap.plugins)) snap.plugins = [];
  if (!Array.isArray(snap.mcpServers)) snap.mcpServers = [];
  if (!Array.isArray(snap.skillProposals)) snap.skillProposals = [];
  if (!Array.isArray(snap.skills) || snap.skills.some((skill) => !skill.origin)) snap.skills = [];
  if (!Array.isArray(snap.registry) || snap.registry.length === 0) snap.registry = rebuildRegistry(snap.plugins, snap.mcpServers);
  if (typeof snap.skillIndexDelta !== "string") snap.skillIndexDelta = "";
  if (!Array.isArray(snap.providers)) snap.providers = [];
  for (const provider of fresh.providers) {
    if (!snap.providers.some((item) => item.id === provider.id)) snap.providers.push(provider);
  }
  for (const provider of snap.providers) {
    const kept = hasStoredSecret(provider.id);
    if (provider.hasSecret && !kept) {
      provider.hasSecret = false;
      provider.healthDetail = "Needs an API key. Paste it again. The previous preview did not keep the key.";
      continue;
    }
    if (!kept && (provider.healthDetail.startsWith("Connected") || provider.healthDetail.startsWith("Web Session"))) {
      provider.healthDetail = provider.providerType === "byok_api"
        ? "Needs an API key."
        : "Not signed in. Open the site from the icon dock, or paste an API key to chat here.";
    }
  }
  ensurePrebuilt(snap);
  adoptMem0(snap);
  return snap;
}

function save() {
  localStorage.setItem(KEY, JSON.stringify(state));
}

function ok(toast: string | null = null): CommandResult {
  ensurePrebuilt(state);
  adoptMem0(state);
  save();
  return { snapshot: structuredClone(state), toast };
}

function nid(prefix: string) {
  return `${prefix}_${Date.now().toString(16)}${Math.floor(Math.random() * 9999).toString(16)}`;
}

function makeProfile(partial: Partial<BotProfile> & Pick<BotProfile, "id" | "handle" | "displayName">): BotProfile {
  return {
    avatar: "NW",
    avatarColor: "#8b5a2b",
    soulMarkdown: "",
    primaryAccountId: "prov_ollama",
    longContextAccountId: "prov_gemini",
    fallbackAccountId: "prov_openrouter",
    allowComputerUse: true,
    allowBrowserUse: true,
    allowCodeExec: true,
    scopedObsidianFolder: "",
    dailyWalletLimitUsd: 5,
    isPinned: true,
    role: "",
    engine: "",
    commandOrUrl: "",
    runStatus: "stopped",
    activePid: null,
    harnessLaneId: "",
    agUiEndpointUrl: "",
    allowFileWrite: true,
    requireApprovalExternal: true,
    requireApprovalWallet: true,
    takeover: false,
    ...partial,
    browserPartition: partial.browserPartition || `persist:bot_${partial.id}`,
    workspaceDir: partial.workspaceDir || `~/.omniworkspace/bots/${partial.id}/workspace`,
    statusLine: partial.statusLine || "Ready for tasks",
    stallTimeoutMs: partial.stallTimeoutMs || 45000,
    workspaceFiles: partial.workspaceFiles ?? [],
    screenUrl: partial.screenUrl ?? "",
    screenNodes: partial.screenNodes ?? [],
    screenMs: partial.screenMs ?? 0,
    shellOutput: partial.shellOutput ?? "",
  };
}

function makeThread(partial: Partial<ChatThread> & Pick<ChatThread, "id" | "botProfileId" | "title">): ChatThread {
  return {
    activeModelOverrideId: null,
    status: "idle",
    compactedContextCapsule: "",
    isPinned: false,
    updatedAt: Date.now(),
    ...partial,
    targetType: partial.targetType === "bot_group" ? "bot_group" : "direct_bot",
    groupId: partial.groupId || "",
    routineSchedule: partial.routineSchedule || "",
  };
}

function externalAction(prompt: string) {
  return /\b(email|e-mail|slack|merge|submit|charge|publish|tweet)\b/i.test(prompt) || /send to |send an email|send the email|post to |wire transfer/i.test(prompt);
}

function clipTarget(prompt: string) {
  const line = prompt.split("\n")[0]?.trim() ?? "";
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}

function pushAudit(botId: string, botHandle: string, conversationId: string, surface: string, target: string, decision: string) {
  state.gatewayAudits.unshift({
    id: nid("aud"),
    botId,
    botHandle,
    conversationId,
    toolOrSurface: surface,
    targetResource: target,
    gatewayDecision: decision,
    ruleMatched: decision === "denied_by_rule" ? "user_deny" : "fail_closed",
    recordedAt: Date.now(),
  });
}

function denied(botId: string, surface: string, target: string) {
  return state.gatewayAudits.some((row) => row.botId === botId && row.toolOrSurface === surface && row.targetResource === target && row.gatewayDecision === "denied_by_rule");
}

function mentionedBot(thread: ChatThread, prompt: string) {
  if (thread.targetType !== "bot_group") return undefined;
  const group = state.botGroups.find((item) => item.id === thread.groupId);
  if (!group) return undefined;
  const lower = prompt.toLowerCase();
  let best: BotProfile | undefined;
  for (const id of group.memberBotIds) {
    const bot = state.profiles.find((item) => item.id === id);
    if (!bot) continue;
    const needle = bot.handle.toLowerCase();
    if (needle.length > 1 && lower.includes(needle) && (!best || needle.length > best.handle.length)) best = bot;
  }
  return best;
}

function applySetup(bot: BotProfile, prompt: string) {
  const trimmed = prompt.trim();
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("rename to ")) {
    const name = trimmed.slice("rename to ".length).trim();
    if (!name) return "Say rename to, then the new name.";
    const handle = name.startsWith("@") ? name : `@${name.replace(/\s+/g, "-")}`;
    if (state.profiles.some((item) => item.handle === handle && item.id !== bot.id)) return `${handle} is already used by another bot.`;
    bot.handle = handle;
    bot.displayName = name.replace(/^@/, "");
    bot.statusLine = "Renamed from chat";
    return `Renamed this bot to ${handle}.`;
  }
  const fresh = bot.statusLine === "Ready for tasks" || bot.statusLine.startsWith("Just created");
  const job = lower.startsWith("you are my ") || lower.startsWith("you're my ") || lower.startsWith("your job is ") || (fresh && (lower.startsWith("you are ") || lower.startsWith("you're ")));
  if (!job) return "";
  bot.soulMarkdown = trimmed;
  bot.statusLine = clipTarget(trimmed) || "Job saved from chat";
  return "Saved that as this bot's job. Send the first task when you want it to start.";
}

function nextMember(thread: ChatThread, currentId: string, already: string[]) {
  if (thread.targetType !== "bot_group") return undefined;
  const group = state.botGroups.find((item) => item.id === thread.groupId);
  if (!group || group.memberBotIds.length < 2) return undefined;
  const members = group.memberBotIds.map((id) => state.profiles.find((item) => item.id === id)).filter((item): item is BotProfile => Boolean(item));
  if (group.coordinationMode === "parallel_swarm") return members.find((item) => item.id !== currentId && !already.includes(item.id));
  if (group.coordinationMode === "lead_delegated") {
    const lead = group.leadBotId || members[0]?.id;
    if (currentId !== lead) return undefined;
    return members.find((item) => item.id !== lead && !already.includes(item.id));
  }
  const index = members.findIndex((item) => item.id === currentId);
  const next = members[index + 1];
  return next && !already.includes(next.id) ? next : undefined;
}

function policyOf(amount: number, actor: string, slippage?: number): string {
  const p = state.policy;
  if (p.killswitchEngaged && actor !== "user") return "blocked_killswitch";
  if (!(amount > 0)) return "rejected_by_policy";
  if (actor === "user") return "auto_signed_by_rust";
  if (state.spentTodayUsd + amount > p.dailyCapUsd) return "rejected_by_policy";
  if (slippage != null && slippage > p.maxSlippageBps) return "rejected_by_policy";
  if (amount > p.maxPerTxUsd || amount > p.requireHumanApprovalAboveUsd) return "pending_approval";
  return "auto_signed_by_rust";
}

function applyMoney(rail: string, amount: number, effect: string, decision: string): string | null {
  if (decision !== "auto_signed_by_rust" && decision !== "approved_by_user") return null;
  const row = state.balances.find((b) => b.rail === rail);
  if (!row) return "That rail is not on this ledger.";
  if (effect !== "credit" && effect !== "spend") return "Unknown ledger effect.";
  if (effect === "credit" && rail === "razorpay_upi") {
    row.nativeValue += amount * 83;
    row.amountUsd = row.nativeValue / 83;
    row.nativeAmount = `₹${Math.round(row.nativeValue)}`;
    return null;
  }
  if (effect === "credit" && rail !== "burst") {
    row.nativeValue += amount;
    row.amountUsd = row.nativeValue;
    row.nativeAmount = rail === "stripe_card" ? `$${row.nativeValue.toFixed(2)}` : `${row.nativeValue.toFixed(2)} USDC`;
    return null;
  }
  if (effect === "credit") return null;
  if (rail === "razorpay_upi") {
    const cost = amount * 83;
    if (row.nativeValue + 1e-6 < cost) return "sandbox INR balance is too low";
    row.nativeValue -= cost;
    row.amountUsd = row.nativeValue / 83;
    row.nativeAmount = `₹${Math.round(row.nativeValue)}`;
    state.spentTodayUsd += amount;
    return null;
  }
  if (rail === "crypto_x402" || rail === "stripe_card") {
    if (row.nativeValue + 1e-9 < amount) return rail === "stripe_card" ? "sandbox card balance is too low" : "sandbox USDC balance is too low";
    row.nativeValue -= amount;
    row.amountUsd = row.nativeValue;
    row.nativeAmount = rail === "stripe_card" ? `$${row.nativeValue.toFixed(2)}` : `${row.nativeValue.toFixed(2)} USDC`;
    state.spentTodayUsd += amount;
    return null;
  }
  return "That rail cannot move funds on this ledger.";
}

function pushTx(partial: Omit<WalletTx, "id" | "createdAt" | "txHashOrRef" | "botHandle"> & { botHandle?: string }): WalletTx {
  const handle = state.profiles.find((p) => p.id === partial.botProfileId)?.handle ?? "you";
  const tx: WalletTx = {
    id: nid("tx"),
    createdAt: Date.now(),
    txHashOrRef: partial.policyDecision.startsWith("auto") || partial.policyDecision === "approved_by_user" ? nid("sandbox") : "",
    botHandle: handle,
    ...partial,
  };
  state.transactions.unshift(tx);
  return tx;
}

function activeThread() {
  return state.threads.find((t) => t.id === state.activeThreadId) ?? null;
}

function redact(text: string) {
  return text
    .replace(/sk-[a-z0-9_\-]{8,}/gi, "sk-***REDACTED***")
    .replace(/\b(rk_(?:live|test)_|gh[pousr]_|xai-|AIza|whsec_|Bearer\s+eyJ)[A-Za-z0-9_\-\.]{8,}/gi, "***REDACTED***")
    .replace(/(api[_-]?key|secret|token|password)\s*[:=]\s*\S+/gi, "$1=***REDACTED***");
}

const HISTORY_BUDGET = 12_000;

function clipText(text: string, limit: number) {
  const flat = text.replace(/\n/g, " ");
  if (flat.length <= limit) return flat;
  return `${flat.slice(0, limit)}…`;
}

function browserUserText(prompt: string, attachments: string[]) {
  const text = prompt.trim() || "Read the attached files.";
  if (!attachments.length) return text;
  const names = attachments.map((path) => `- ${path.split(/[\\/]/).pop() || path}`).join("\n");
  return `${text}\n\nAttached files:\n${names}\nThis preview cannot read files on disk. Open the desktop app to include their contents.`;
}

function threadCapsule(steps: Step[]) {
  const goal = steps.find((step) => step.role === "user")?.contentMarkdown ?? "";
  const done = steps.filter((step) => step.role === "assistant" || step.role === "tool").slice(-4);
  const actions = done.map((step) => clipText(step.contentMarkdown, 180)).join(" | ");
  return `original_goal: ${clipText(goal, 400)}\ncompleted_actions: ${clipText(actions, 800)}\npending_next_steps: continue from the last accepted card`;
}

function foldThread(steps: Step[], system: string, capsule: string): ChatMessage[] {
  const folded: ChatMessage[] = [];
  let tools: string[] = [];
  const flushTools = () => {
    if (!tools.length) return;
    folded.push({ role: "assistant", content: tools.join("\n\n") });
    tools = [];
  };
  for (const step of steps) {
    if (step.actionType === "thinking") continue;
    if (step.role === "user") {
      flushTools();
      folded.push({ role: "user", content: step.contentMarkdown });
    } else if (step.role === "tool") {
      tools.push(`Tool ${step.modelUsed}:\n${clipText(step.contentMarkdown, 1500)}`);
    } else if (step.role === "assistant" && step.contentMarkdown.trim()) {
      const prefix = tools.join("\n\n");
      tools = [];
      folded.push({ role: "assistant", content: prefix ? `${prefix}\n\n${step.contentMarkdown}` : step.contentMarkdown });
    }
  }
  flushTools();
  let total = folded.reduce((sum, message) => sum + message.content.length, 0);
  let dropped = false;
  while (folded.length > 1 && total > HISTORY_BUDGET) {
    const removed = folded.shift();
    total -= removed?.content.length ?? 0;
    dropped = true;
  }
  let systemText = system;
  if (dropped && capsule.trim()) systemText += `\n\nEarlier in this thread:\n${capsule.trim()}`;
  return [{ role: "system", content: systemText }, ...folded];
}

export async function browserCall(cmd: string, args: Record<string, unknown>): Promise<CommandResult> {
  const a = args as Record<string, any>;
  switch (cmd) {
    case "bootstrap":
      return ok(null);
    case "scan_environment":
      state.scan = { durationMs: 0, found: [], missing: [] };
      return ok("Browser preview cannot see PATH. The desktop shell scans this machine.");
    case "complete_onboarding":
      state.onboardingComplete = true;
      return ok("Workspace is local. Nothing was uploaded.");
    case "link_apps":
      return ok("Linking runs in the desktop shell after a real scan.");
    case "switch_profile": {
      state.activeProfileId = a.profileId;
      const thread = state.threads.find((item) => item.botProfileId === a.profileId && item.targetType !== "bot_group");
      state.activeThreadId = thread ? thread.id : null;
      return ok(null);
    }
    case "select_thread": {
      const thread = state.threads.find((t) => t.id === a.threadId);
      if (!thread) return ok("Thread not found.");
      state.activeThreadId = thread.id;
      state.activeProfileId = thread.botProfileId;
      return ok(null);
    }
    case "create_thread": {
      if (!state.profiles.length) {
        const botId = nid("bot");
        state.profiles.push(makeProfile({
          id: botId,
          handle: "@local",
          displayName: "Local operator",
          soulMarkdown: "Local operator.",
          role: "Local operator",
        }));
        state.activeProfileId = botId;
      }
      if (!state.profiles.some((p) => p.id === state.activeProfileId)) state.activeProfileId = state.profiles[0].id;
      const id = nid("thread");
      const current = activeThread();
      const grouped = current?.targetType === "bot_group" && current.groupId;
      state.threads.unshift(makeThread({
        id,
        botProfileId: grouped ? current.botProfileId : state.activeProfileId,
        title: a.title || "New task",
        targetType: grouped ? "bot_group" : "direct_bot",
        groupId: grouped ? current.groupId : "",
      }));
      state.activeThreadId = id;
      return ok("New task opened.");
    }
    case "send_message": {
      const attachments = Array.isArray(a.attachments) ? a.attachments.map((item: unknown) => String(item)).filter(Boolean) : [];
      const prompt = String(a.prompt ?? "").trim();
      if (!prompt && attachments.length === 0) return ok("Write a message first.");
      if (!state.profiles.length) {
        const id = nid("bot");
        state.profiles.push(makeProfile({
          id,
          handle: "@local",
          displayName: "Local operator",
          soulMarkdown: "Local operator. Created when a message was sent with no bot selected.",
          role: "Local operator",
        }));
        state.activeProfileId = id;
      }
      if (!state.profiles.some((p) => p.id === state.activeProfileId)) state.activeProfileId = state.profiles[0].id;
      let thread = activeThread();
      if (!thread) {
        const id = nid("thread");
        const title = (prompt || "Read the attached files.").split("\n")[0].slice(0, 36) || "New task";
        state.threads.unshift(makeThread({
          id,
          botProfileId: state.activeProfileId,
          title,
          activeModelOverrideId: a.providerId || null,
        }));
        state.activeThreadId = id;
        thread = state.threads[0];
      } else if (a.providerId) {
        thread.activeModelOverrideId = a.providerId;
      }
      if (!thread) return ok("Could not open a task.");
      const turnId = nid("turn");
      const composed = browserUserText(prompt, attachments);
      const step = (partial: Partial<Step> & Pick<Step, "role" | "contentMarkdown" | "actionType">) => {
        state.steps.push({
          id: nid("step"),
          threadId: thread.id,
          turnId,
          modelUsed: "",
          actionPayload: {},
          executionLatencyMs: 1,
          createdAt: Date.now(),
          ...partial,
        });
      };
      const finishThread = () => {
        thread.compactedContextCapsule = threadCapsule(state.steps.filter((item) => item.threadId === thread.id));
        thread.updatedAt = Date.now();
        thread.status = "completed";
      };
      const owner = state.profiles.find((item) => item.id === thread.botProfileId) ?? state.profiles[0];
      const addressed = mentionedBot(thread, prompt) ?? owner;
      const replay = skipGate && state.steps.some((item) => item.threadId === thread.id && item.role === "user" && item.contentMarkdown.trim() === composed.trim());
      skipGate = false;
      if (!replay) step({ role: "user", contentMarkdown: composed, actionType: "message" });
      if (!addressed) return ok("Pick a bot first.");
      if (!replay) {
        const setup = applySetup(addressed, prompt);
        if (setup) {
          step({ role: "assistant", modelUsed: addressed.handle, contentMarkdown: setup, actionType: "message" });
          finishThread();
          return ok(setup);
        }
      }
      if (addressed.takeover) {
        step({ role: "assistant", modelUsed: addressed.handle, contentMarkdown: `${addressed.handle} is paused while you have control of its computer. Hand it back in the dock to continue.`, actionType: "message" });
        finishThread();
        return ok("Bot is paused while you have control.");
      }
      if (!replay && /pay|x402|send \$/i.test(prompt)) {
        const match = prompt.match(/\$([0-9]+(?:\.[0-9]+)?)/);
        if (!match) {
          step({ role: "assistant", modelUsed: "policy-gate", contentMarkdown: "No amount was in that message, so no funds moved.", actionType: "message" });
          finishThread();
          return ok("Message recorded.");
        }
        const amount = Number(match[1]);
        const target = `$${amount.toFixed(2)}`;
        if (denied(addressed.id, "wallet.x402", target)) {
          pushAudit(addressed.id, addressed.handle, thread.id, "wallet.x402", target, "denied_by_rule");
          step({ role: "assistant", modelUsed: addressed.handle, contentMarkdown: `Denied. ${addressed.handle} already has a deny rule for ${target}.`, actionType: "message" });
          finishThread();
          return ok("Denied by a saved rule.");
        }
        if (addressed.requireApprovalWallet) {
          step({
            role: "system",
            modelUsed: addressed.handle,
            contentMarkdown: `${addressed.handle} wants to spend ${target} on the sandbox wallet. Nothing moves until you approve.`,
            actionType: "gateway_approval",
            actionPayload: { approvalState: "pending", botId: addressed.id, botHandle: addressed.handle, kind: "wallet", prompt, amountUsd: amount, surface: "wallet.x402", target },
          });
          pushAudit(addressed.id, addressed.handle, thread.id, "wallet.x402", target, "held_for_approval");
          finishThread();
          return ok("Held for your approval.");
        }
        const decision = policyOf(amount, "agent");
        const blocked = applyMoney("crypto_x402", amount, "spend", decision);
        const note = blocked ?? decision;
        if (!blocked) {
          pushTx({
            botProfileId: addressed.id,
            rail: "crypto_x402",
            amountUsd: amount,
            nativeAmount: `$${amount}`,
            counterparty: "agent-request",
            purpose: prompt || composed,
            policyDecision: decision,
            actor: "agent",
          });
        }
        pushAudit(addressed.id, addressed.handle, thread.id, "wallet.x402", target, note.includes("pending") ? "held_for_approval" : blocked ? "denied_by_rule" : "allowed");
        step({ role: "tool", modelUsed: "policy-gate", contentMarkdown: note, actionType: "wallet_tx", actionPayload: { note, amountUsd: amount } });
        finishThread();
        return ok("Message recorded.");
      }
      if (!replay && addressed.requireApprovalExternal && externalAction(prompt)) {
        const target = clipTarget(prompt);
        if (denied(addressed.id, "external.send", target)) {
          pushAudit(addressed.id, addressed.handle, thread.id, "external.send", target, "denied_by_rule");
          step({ role: "assistant", modelUsed: addressed.handle, contentMarkdown: `Denied. ${addressed.handle} already has a deny rule for this action.`, actionType: "message" });
          finishThread();
          return ok("Denied by a saved rule.");
        }
        step({
          role: "system",
          modelUsed: addressed.handle,
          contentMarkdown: `${addressed.handle} wants to take an external action. Nothing is sent until you approve.`,
          actionType: "gateway_approval",
          actionPayload: { approvalState: "pending", botId: addressed.id, botHandle: addressed.handle, kind: "external", prompt, surface: "external.send", target },
        });
        pushAudit(addressed.id, addressed.handle, thread.id, "external.send", target, "held_for_approval");
        finishThread();
        return ok("Held for your approval.");
      }
      if (prompt.toLowerCase().includes("security")) {
        step({
          role: "tool",
          modelUsed: "local-operator",
          contentMarkdown: "Browser preview cannot walk the disk. Open the desktop shell for a real scan.",
          actionType: "pty_terminal",
          actionPayload: { command: "security-audit", exitCode: 0, output: "Desktop shell required for a filesystem scan." },
        });
        finishThread();
        return ok("Message recorded.");
      }
      const model = modelById(String(a.modelId ?? "")) ?? modelById(String(a.model ?? ""));
      if (!model) {
        step({
          role: "assistant",
          modelUsed: "",
          contentMarkdown: "No connected model. Add an API key on a provider card, or start Ollama.",
          actionType: "message",
        });
        finishThread();
        return ok("No connected model.");
      }
      const rawEffort = String(a.effort ?? "default");
      const effort: Effort = rawEffort === "high" || rawEffort === "max" || rawEffort === "xhigh" ? rawEffort : "default";
      const quick = quickQuestion(composed);
      const bag = bagFromState();
      const messages = foldThread(
        state.steps.filter((item) => item.threadId === thread.id),
        workspaceSystem(bag, prompt),
        thread.compactedContextCapsule,
      );
      state.skillIndexDelta = "";
      if (quick) {
        const system = messages.find((item) => item.role === "system");
        if (system) system.content += "\n\nThis is a short question. Answer in a few sentences. Do not call a tool.";
        const recent = messages.filter((item) => item.role !== "system").slice(-4);
        messages.splice(0, messages.length, ...(system ? [system, ...recent] : recent));
      }
      const selected = model.upstreamModel || model.label;
      const system = messages.find((item) => item.role === "system");
      if (system) system.content += `\n\nThis turn is answered only by model id \`${selected}\`. Earlier assistant text in this chat may be from a different model. Do not adopt that model's name. If asked which model you are, answer with \`${selected}\`.`;
      for (const item of messages) {
        if (item.role === "assistant" && !item.content.startsWith("[Earlier reply")) item.content = `[Earlier reply, not from ${selected}]\n${item.content}`;
      }
      try {
        let result = await completeChat(model, messages, quick ? "default" : effort, !quick);
        let lastText = "";
        let toolsRan = false;
        for (let round = 0; round < (quick ? 1 : 16); round += 1) {
          if (result.thinking.trim()) {
            step({ role: "assistant", modelUsed: model.label, contentMarkdown: result.thinking.trim(), actionType: "thinking" });
          }
          if (quick) {
            lastText = result.text.trim();
            break;
          }
          const fence = result.toolCalls.length ? null : parseToolFence(result.text);
          const calls = result.toolCalls.length
            ? result.toolCalls
            : fence
              ? [{ id: nid("tool"), name: fence.name, arguments: JSON.stringify(fence.arguments) }]
              : [];
          if (!calls.length) {
            let text = result.text.trim();
            if (!text && toolsRan) {
              messages.push({ role: "user", content: "Please provide your complete, final response to the user based on the tool results above. Explain clearly what you did, what was found, and any next steps." });
              try {
                const syn = await completeChat(model, messages, effort, false);
                if (syn.text.trim()) text = syn.text.trim();
              } catch {
                /* ignore error on fallback synthesis */
              }
            } else if (!text && result.thinking.trim()) {
              messages.push({ role: "user", content: "Please provide your complete response to the user based on your thought process above." });
              try {
                const syn = await completeChat(model, messages, effort, false);
                if (syn.text.trim()) text = syn.text.trim();
              } catch {
                /* ignore error on fallback synthesis */
              }
            }
            if (text) {
              lastText = text;
            } else if (toolsRan && lastText) {
              lastText = `${lastText}\n\n(Finished executing tools. See details above.)`;
            } else if (toolsRan) {
              lastText = "Finished executing the requested tools. Please check the steps above.";
            } else if (result.thinking.trim()) {
              lastText = "I have processed your request. Please let me know if you would like me to proceed or need more information.";
            }
            break;
          }
          toolsRan = true;
          if (result.text.trim()) lastText = result.text.trim();
          const assistantContent = result.text.trim() || `Calling tools: ${calls.map((c) => c.name).join(", ")}`;
          messages.push({ role: "assistant", content: assistantContent, toolCalls: calls });
          for (const call of calls) {
            let args: Record<string, unknown> = {};
            try { args = JSON.parse(call.arguments || "{}") as Record<string, unknown>; } catch { args = {}; }
            const output = applyWorkspaceTool(bag, call.name, args, () => nid("mem"));
            writeBag(bag);
            step({
              role: "tool",
              modelUsed: call.name,
              contentMarkdown: output,
              actionType: "message",
              actionPayload: { name: call.name, arguments: args },
            });
            messages.push({ role: "tool", content: output, toolCallId: call.id, name: call.name });
          }
          if (round === 15) {
            messages.push({ role: "user", content: "Please provide your final response to the user based on the tool results above. Explain clearly what you did, what was found, and any next steps." });
            const syn = await completeChat(model, messages, effort, false);
            if (syn.text.trim()) lastText = syn.text.trim();
            break;
          }
          result = await completeChat(model, messages, effort);
        }
        const spoken = lastText || "The model returned an empty reply.";
        step({
          role: "assistant",
          modelUsed: `${addressed.handle} · ${model.label}`,
          contentMarkdown: spoken,
          actionType: "message",
          executionLatencyMs: result.ms,
        });
        addressed.statusLine = clipTarget(spoken) || addressed.statusLine;
        const provider = state.providers.find((item) => item.id === (result.providerId || model.providerId));
        if (provider) provider.healthDetail = `Reachable. ${model.label} replied in ${result.ms}ms.`;
        const already = [addressed.id];
        let current = addressed;
        for (let hop = 0; hop < 2; hop += 1) {
          const next = nextMember(thread, current.id, already);
          if (!next || next.takeover) break;
          already.push(next.id);
          step({
            role: "system",
            modelUsed: current.handle,
            contentMarkdown: `Passing this on to ${next.handle}.`,
            actionType: "bot_handoff",
            actionPayload: { from: current.handle, to: next.handle, mode: state.botGroups.find((item) => item.id === thread.groupId)?.coordinationMode ?? "" },
          });
          const follow = await completeChat(model, [
            { role: "system", content: `You are ${next.handle}, ${next.role || "a coworker"}. Continue the shared thread. ${next.soulMarkdown}` },
            { role: "user", content: composed },
            { role: "assistant", content: spoken },
            { role: "user", content: `Continue as ${next.handle}.` },
          ], effort);
          const followText = follow.text.trim() || "Continued the shared thread.";
          step({ role: "assistant", modelUsed: `${next.handle} · ${model.label}`, contentMarkdown: followText, actionType: "message", executionLatencyMs: follow.ms });
          next.statusLine = clipTarget(followText) || next.statusLine;
          current = next;
        }
        finishThread();
        return ok(`${addressed.handle} · ${model.label} replied in ${result.ms}ms.`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        step({
          role: "assistant",
          modelUsed: model.label,
          contentMarkdown: message,
          actionType: "message",
        });
        finishThread();
        return ok(message);
      }
    }
    case "set_thread_model": {
      const thread = state.threads.find((t) => t.id === a.threadId);
      if (thread) thread.activeModelOverrideId = a.providerId;
      return ok(null);
    }
    case "set_diff_status": {
      const step = state.steps.find((s) => s.id === a.stepId);
      if (step) step.actionPayload = { ...step.actionPayload, status: a.status };
      return ok(`Diff ${a.status}.`);
    }
    case "save_profile": {
      const idx = state.profiles.findIndex((p) => p.id === a.profile.id);
      if (idx >= 0) state.profiles[idx] = a.profile;
      return ok("Profile saved.");
    }
    case "create_profile": {
      const id = nid("bot");
      const harness = String(a.draft.harnessLaneId ?? "");
      const primary = harness === "claude_cli" ? "prov_claude" : harness === "agy_cli" ? "prov_gemini" : harness === "codex_cli" ? "prov_chatgpt" : harness === "grok_web" ? "prov_grok" : "prov_ollama";
      const avatar = String(a.draft.avatar ?? "");
      state.profiles.unshift(makeProfile({
        id,
        handle: a.draft.handle.startsWith("@") ? a.draft.handle : `@${String(a.draft.handle).trim().replace(/\s+/g, "-")}`,
        displayName: a.draft.displayName,
        avatar: /^mark:[a-z]{1,16}$/.test(avatar) ? avatar : "NW",
        soulMarkdown: a.draft.soulMarkdown,
        role: a.draft.role,
        primaryAccountId: primary,
        harnessLaneId: harness,
        agUiEndpointUrl: String(a.draft.agUiEndpointUrl ?? ""),
        statusLine: "Just created",
      }));
      state.activeProfileId = id;
      state.activeThreadId = null;
      for (const token of String(a.draft.skills ?? "").split(",")) {
        const name = token.trim().replace(/^\//, "").toLowerCase();
        const skill = state.skills.find((item) => item.slug.toLowerCase() === name || item.slashCommand.replace(/^\//, "").toLowerCase() === name);
        if (name && skill) toggleSkill(state, skill.id, id, true);
      }
      for (const token of String(a.draft.plugins ?? "").split(",")) {
        const name = token.trim().toLowerCase();
        const plugin = state.plugins.find((item) => item.slug.toLowerCase() === name || item.name.toLowerCase() === name);
        if (name && plugin) togglePluginAgent(state, plugin.id, id, true);
      }
      return ok("Bot created. It has its own computer and workspace.");
    }
    case "duplicate_profile": {
      const src = state.profiles.find((p) => p.id === a.profileId);
      if (src) state.profiles.push({ ...src, id: nid("bot"), handle: `${src.handle}-copy`, displayName: `${src.displayName} copy` });
      return ok("Profile duplicated.");
    }
    case "update_provider": {
      const patch = a.patch ?? a;
      const targetId = patch.id ?? a.id;
      const p = state.providers.find((x) => x.id === targetId);
      if (p) Object.assign(p, patch);
      return ok("Provider updated.");
    }
    case "add_provider": {
      const rawId = String(a.id ?? String(a.name ?? "provider")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/_+$/, "")) || "provider";
      const id = rawId.replace(/[^a-z0-9_]/g, "_") || nid("prov");
      if (state.providers.some((p) => p.id === id)) return ok("A provider with that id already exists.");
      const providerType = (["cli_subprocess", "official_oauth", "isolated_webview", "byok_api", "local_ollama"].includes(String(a.providerType ?? ""))
        ? String(a.providerType)
        : "byok_api") as ProviderType;
      const apiKey = String(a.apiKey ?? a.secret ?? "").trim();
      const hasSecret = Boolean(apiKey);
      if (hasSecret) {
        rememberSecret(id, apiKey);
      }
      state.providers.push({
        id,
        name: String(a.name ?? "Provider"),
        providerType,
        binaryOrEndpoint: String(a.binaryOrEndpoint ?? ""),
        hasSecret,
        quotaWindowHours: 5,
        quotaUsedPercent: 0,
        quotaResetsAt: "",
        fallbackAccountId: null,
        isActive: true,
        allowCliDispatch: providerType === "cli_subprocess",
        lastHealthCheckMs: null,
        healthDetail: hasSecret ? "Key stored for this browser session." : "Added. Ready to connect.",
      });
      return ok("Provider added.");
    }
    case "sign_in_chatgpt":
      return ok("Continue with ChatGPT opens the official sign-in from the desktop app. This preview cannot connect a ChatGPT plan. Paste an API key to list models here.");
    case "set_provider_secret": {
      const p = state.providers.find((x) => x.id === a.id);
      const secret = String(a.secret ?? "").trim();
      if (!secret) return ok("Paste a key first.");
      rememberSecret(String(a.id ?? ""), secret);
      if (p) {
        p.hasSecret = true;
        p.healthDetail = "Key stored for this browser session. Test ping checks it with the provider.";
      }
      return ok("Key stored for this browser session.");
    }
    case "test_provider": {
      const p = state.providers.find((x) => x.id === a.id);
      if (!p) return ok("Missing provider.");
      const model = probeModel(p.id, p.name);
      if (!model) {
        p.healthDetail = "This CLI is probed in the desktop shell. Use Download on the chat dock to get the installer.";
        return ok(p.healthDetail);
      }
      try {
        const note = await pingProvider(model);
        p.healthDetail = note;
        p.lastHealthCheckMs = Date.now();
        return ok(note);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        p.healthDetail = message;
        return ok(message);
      }
    }
    case "save_memory": {
      const draft = a.draft;
      const links = [...String(draft.contentMarkdown).matchAll(/\[\[(.+?)\]\]/g)].map((m) => m[1]);
      const previous = state.memories.find((item) => item.id === draft.id);
      const scopedBotId = draft.scopedBotId ? String(draft.scopedBotId) : null;
      const route = state.memoryRoutes.find((item) => item.id === (scopedBotId ?? "global"));
      const engineId = route?.engineId ?? state.memoryRoute.engineId ?? "mem0_builtin";
      if (draft.engineId && String(draft.engineId) !== engineId) return ok("The selected memory engine does not match this scope. Refresh the vault and try again.");
      if (engineId !== "mem0_builtin" && engineId !== "obsidian_khoj") return ok("Attach this memory driver in the desktop app first.");
      const synced = new Set(previous?.syncedEngines ?? []);
      if (engineId === "obsidian_khoj" || state.memoryRoute.companionEngineId === "obsidian_khoj") synced.add("obsidian_khoj");
      const item: MemoryItem = {
        id: draft.id ?? nid("mem"),
        title: draft.title,
        contentMarkdown: draft.contentMarkdown,
        sourceType: draft.sourceType,
        scopedBotId,
        filePathOrUri: draft.filePathOrUri,
        wikilinks: links,
        updatedAt: Date.now(),
        engineOrigin: previous?.engineOrigin ?? engineId,
        syncedEngines: [...synced],
        validFrom: previous?.validFrom ?? Date.now(),
        invalidAt: null,
      };
      const idx = state.memories.findIndex((m) => m.id === item.id);
      if (idx >= 0) state.memories[idx] = item;
      else state.memories.unshift(item);
      return ok(`Memory saved in the ${engineId === "obsidian_khoj" ? "Obsidian" : "Mem0"} preview vault.`);
    }
    case "delete_memory": {
      const memory = state.memories.find((item) => item.id === a.id);
      const engineId = String(a.engineId ?? "");
      if (memory && engineId && memory.engineOrigin !== engineId && !memory.syncedEngines.includes(engineId)) return ok("Memory belongs to a different vault.");
      state.memories = state.memories.filter((m) => m.id !== a.id);
      return ok("Memory deleted.");
    }
    case "scan_memory_engines": {
      const vault = state.settings.obsidianVault.trim();
      state.memoryEngines = state.memoryEngines.map((engine) => {
        if (engine.id === "mem0_builtin") return { ...engine, scannedAt: Date.now() };
        if (engine.id === "obsidian_khoj" && vault) {
          return { ...engine, availability: "detected", endpoint: vault, detail: `Vault folder ${vault}. Port checks run in the desktop app.`, scannedAt: Date.now() };
        }
        return { ...engine, availability: "missing", endpoint: "", scannedAt: Date.now() };
      });
      return ok("Preview scan updated the Obsidian card from the vault path. Port checks run in the desktop app.");
    }
    case "set_memory_route": {
      const engineId = String(a.engineId ?? "");
      const scope = String(a.scope ?? "global");
      const engine = state.memoryEngines.find((item) => item.id === engineId);
      if (!engine || engine.availability === "missing") return ok("That engine is not installed.");
      if (engineId !== "mem0_builtin" && engineId !== "obsidian_khoj") return ok("Attach in a later update. Detection only for now.");
      if (engineId === "obsidian_khoj" && !state.settings.obsidianVault.trim()) return ok("Obsidian needs a vault folder before it can be the active engine.");
      const route: MemoryRoute = { id: scope === "global" ? "global" : scope, scope: scope === "global" ? "global" : "bot", engineId, companionEngineId: scope === "global" ? state.memoryRoute.companionEngineId : null, updatedAt: Date.now() };
      const index = state.memoryRoutes.findIndex((item) => item.id === route.id);
      if (index >= 0) state.memoryRoutes[index] = { ...state.memoryRoutes[index], ...route, companionEngineId: scope === "global" ? state.memoryRoutes[index].companionEngineId : null };
      else state.memoryRoutes.push(route);
      if (scope === "global") state.memoryRoute = { ...state.memoryRoute, engineId, updatedAt: Date.now() };
      return ok(`Memory engine updated in the browser preview. ${engineId === "obsidian_khoj" ? "Obsidian notes are available in this preview journal." : "Mem0 stays local to this preview."}`);
    }
    case "mount_memory_companion": {
      if (!state.settings.obsidianVault.trim()) return ok("Obsidian needs a vault folder before it can be mounted.");
      state.memoryRoute = { ...state.memoryRoute, companionEngineId: "obsidian_khoj", updatedAt: Date.now() };
      const global = state.memoryRoutes.find((item) => item.id === "global");
      if (global) global.companionEngineId = "obsidian_khoj";
      return ok("Obsidian is mounted as a companion in this preview. The desktop app writes the vault files.");
    }
    case "unmount_memory_companion":
      state.memoryRoute = { ...state.memoryRoute, companionEngineId: null, updatedAt: Date.now() };
      {
        const global = state.memoryRoutes.find((item) => item.id === "global");
        if (global) global.companionEngineId = null;
      }
      return ok("Obsidian companion unmounted.");
    case "sync_memories_to_engine":
      if (a.targetEngineId !== "obsidian_khoj") return ok("driver not attached");
      for (const memory of state.memories) {
        if (!memory.syncedEngines.includes("obsidian_khoj")) memory.syncedEngines.push("obsidian_khoj");
      }
      return ok("Copied the preview journal into the simulated Obsidian vault. The desktop app writes actual Markdown files.");
    case "refresh_memory_vault": {
      const engineId = String(a.engineId ?? state.memoryRoute.engineId);
      if (engineId === "mem0_builtin") {
        const count = state.memories.filter((item) => item.engineOrigin === engineId).length;
        return ok(`Mem0 preview vault is ready with ${count} note${count === 1 ? "" : "s"}.`);
      }
      if (engineId === "obsidian_khoj") return ok("Browser preview cannot read desktop files. Open the desktop app to refresh the Obsidian vault.");
      return ok("driver not attached");
    }
    case "save_skill":
      return ok(saveSkill(state, a.draft ?? a.skill ?? {}));
    case "toggle_skill":
      return ok(toggleSkill(state, String(a.id ?? ""), String(a.profileId ?? state.activeProfileId), Boolean(a.enabled)));
    case "remove_skill":
      return ok(removeSkill(state, String(a.id ?? "")));
    case "load_skill":
      return ok("Loaded from the skill index.");
    case "propose_skill":
      return ok(proposeSkill(state, String(a.profileId ?? state.activeProfileId), String(a.threadId ?? ""), String(a.slug ?? ""), String(a.description ?? ""), String(a.body ?? "")));
    case "resolve_skill_proposal":
      return ok(resolveProposal(state, String(a.id ?? ""), Boolean(a.approve)));
    case "save_plugin":
      return ok(savePlugin(state, a.draft ?? {}));
    case "toggle_plugin_agent":
      return ok(togglePluginAgent(state, String(a.id ?? ""), String(a.profileId ?? state.activeProfileId), Boolean(a.enabled)));
    case "toggle_plugin_desktop":
      return ok(togglePluginDesktop(state, String(a.id ?? ""), Boolean(a.enabled)));
    case "trust_plugin":
      return ok(trustPlugin(state, String(a.id ?? "")));
    case "remove_plugin":
      return ok(removePlugin(state, String(a.id ?? "")));
    case "save_mcp":
      return ok(saveMcp(state, a.draft ?? {}));
    case "toggle_mcp":
      return ok(toggleMcp(state, String(a.id ?? ""), String(a.profileId ?? state.activeProfileId), Boolean(a.enabled)));
    case "trust_mcp":
      return ok(trustMcp(state, String(a.id ?? "")));
    case "remove_mcp":
      return ok(removeMcp(state, String(a.id ?? "")));
    case "scan_project_plugins":
      return ok("Project folders are scanned by the desktop shell.");
    case "install_market":
      return ok(installCatalog(state, String(a.slug ?? "")));
    case "install_skill_from_url":
      return ok(await installSkillFromUrl(state, String(a.url ?? "")));
    case "install_skill":
      return ok(installSkillFromMarket(state, String(a.slug ?? "")));
    case "install_plugin":
      return ok(installPlugin(state, String(a.source ?? "")));
    case "install_mcp":
      return ok(installMcp(state, String(a.name ?? "")));
    case "connect_mcp":
      return ok(connectMcp(state, String(a.name ?? "")));
    case "set_policy":
      state.policy = {
        maxPerTxUsd: a.maxPerTxUsd,
        dailyCapUsd: a.dailyCapUsd,
        requireHumanApprovalAboveUsd: a.requireHumanApprovalAboveUsd,
        maxSlippageBps: a.maxSlippageBps,
        killswitchEngaged: a.killswitchEngaged,
        whitelisted: state.policy.whitelisted,
      };
      return ok(a.killswitchEngaged ? "Kill switch is on." : "Policy saved.");
    case "wallet_tx": {
      if (state.settings.liveRails) return ok("Turn live rails off. This preview will not send a real charge.");
      const r = a.request;
      const decision = policyOf(r.amountUsd, r.actor, r.slippageBps);
      const blocked = applyMoney(r.rail, r.amountUsd, r.effect, decision);
      if (blocked) return ok(blocked);
      pushTx({ ...r, policyDecision: decision });
      return ok(decision);
    }
    case "review_tx": {
      const tx = state.transactions.find((t) => t.id === a.txId);
      if (!tx || tx.policyDecision !== "pending_approval") return ok("Nothing pending.");
      if (!a.approve) {
        tx.policyDecision = "rejected_by_user";
        return ok("rejected_by_user");
      }
      const blocked = applyMoney(tx.rail, tx.amountUsd, tx.effect === "credit" ? "credit" : "spend", "approved_by_user");
      if (blocked) return ok(blocked);
      tx.policyDecision = "approved_by_user";
      tx.txHashOrRef = nid("sandbox");
      return ok("approved_by_user");
    }
    case "refresh_workspace": {
      let released = 0;
      for (const thread of state.threads) {
        if (thread.status === "running") {
          thread.status = "idle";
          thread.updatedAt = Date.now();
          released += 1;
        }
      }
      for (const bot of state.profiles) {
        if (bot.runStatus === "running") {
          bot.runStatus = "stopped";
          bot.activePid = null;
        }
      }
      state.heartbeatAgeMs = 0;
      state.ipcLog.unshift(`${Date.now()} refresh/released`);
      return ok(released > 0
        ? "Released the stuck reply and reloaded workspace. No messages were deleted."
        : "Workspace refreshed. No messages were deleted.");
    }
    case "run_repair":
      state.remediation.unshift({
        id: nid("rem"),
        tier: 1,
        faultType: "manual",
        targetComponent: "preview",
        actionTaken: "The desktop shell runs the doctor. This preview did not patch a file.",
        recoveryDurationMs: 0,
        status: "noted",
        createdAt: Date.now(),
      });
      return ok("Repair pass recorded.");
    case "preview_bug":
      state.bugPreview = redact(`category: ${a.category}\nnotes: ${a.notes}`);
      return ok(null);
    case "submit_bug":
      state.bugPreview = redact(`category: ${a.category}\nnotes: ${a.notes}`);
      return ok("Saved in this browser. The desktop shell writes ~/.omniworkspace/tickets.");
    case "save_settings":
      state.settings = a.settings;
      return ok("Settings saved.");
    case "set_vault_passphrase":
      state.hasPassphrase = true;
      state.vaultUnlocked = true;
      return ok("Passphrase remembered only for this browser preview. The desktop shell uses Argon2id.");
    case "unlock_vault":
      state.vaultUnlocked = true;
      return ok("Unlocked.");
    case "lock_vault":
      if (state.hasPassphrase) state.vaultUnlocked = false;
      return ok("Vault locked.");
    case "save_extension": {
      const ext = state.extensions.find((e) => e.id === a.id);
      if (ext) ext.code = a.code;
      return ok("Extension saved in the preview.");
    }
    case "toggle_extension": {
      const ext = state.extensions.find((e) => e.id === a.id);
      if (ext) ext.enabled = a.enabled;
      return ok(null);
    }
    case "generate_extension": {
      const id = nid("ext");
      state.extensions.unshift({ id, name: "Custom patch", path: `extensions/${id}.js`, enabled: true, code: `// ${a.prompt}\n` });
      return ok("Patch saved in the preview.");
    }
    case "open_provider_window": {
      const provider = state.providers.find((item) => item.id === a.label);
      const url = String(a.url ?? provider?.binaryOrEndpoint ?? "");
      const note = openSite(url);
      if (provider && note.startsWith("Opened") && (provider.providerType === "isolated_webview" || provider.providerType === "official_oauth")) {
        provider.healthDetail = "Window opened. Sign in on that site. A reply inside this chat still needs the API key on this card.";
      }
      return ok(note);
    }
    case "pick_paths":
      return ok("The file picker runs in the desktop shell.");
    case "connect_external_bot": {
      const handle = String(a.draft.handle ?? "").startsWith("@") ? String(a.draft.handle) : `@${String(a.draft.handle ?? "").trim()}`;
      const id = nid("bot");
      const mode = String(a.draft.mode ?? "");
      const command = String(a.draft.commandOrUrl ?? "");
      state.profiles.push(makeProfile({
        id,
        handle,
        displayName: String(a.draft.displayName ?? handle),
        avatar: "XB",
        soulMarkdown: "External bot linked in the browser preview.",
        role: String(a.draft.engine ?? "External bot"),
        engine: String(a.draft.engine ?? ""),
        commandOrUrl: command,
        runStatus: "ready",
        harnessLaneId: mode === "http" ? "ag_ui_url" : "",
        agUiEndpointUrl: mode === "http" ? command : "",
      }));
      state.activeProfileId = id;
      return ok(`${handle} is linked in this preview. The desktop shell can clone and launch it.`);
    }
    case "set_bot_run": {
      const bot = state.profiles.find((item) => item.id === a.id);
      if (bot) {
        bot.runStatus = a.action === "start" ? "running" : "stopped";
        bot.activePid = null;
      }
      return ok(a.action === "start" ? "Marked running in the preview." : "Marked stopped.");
    }
    case "set_app_path": {
      const app = state.apps.find((item) => item.id === a.appId);
      if (app && a.path) {
        app.executablePath = String(a.path);
        app.status = "ready";
        app.detail = "Path set in the preview.";
      }
      return ok("Path saved in the preview.");
    }
    case "add_app": {
      const appName = String(a.name ?? "").trim() || "Custom App";
      const slug = appName.toLowerCase().replace(/[^a-z0-9]+/g, "_") || "app";
      const id = String(a.id ?? `app_${slug}`);
      if (state.apps.some((item) => item.id === id)) {
        return ok("An app with that id already exists.");
      }
      const path = String(a.executablePath ?? a.executable_path ?? "").trim();
      state.apps.push({
        id,
        appName,
        category: String(a.category ?? "tools"),
        executablePath: path,
        bridgeProtocol: "local_process",
        activePid: null,
        localPort: null,
        status: path ? "ready" : "missing",
        detail: path ? "Configured in preview." : "Not found yet.",
      });
      return ok(`App '${appName}' added.`);
    }
    case "fleet_action": {
      const appId = String(a.appId ?? a.id ?? "");
      const action = String(a.action ?? "start");
      const app = state.apps.find((ap) => ap.id === appId);
      if (!app) return ok("App not found.");
      if (action === "start") {
        if (!app.executablePath) {
          return ok(`${app.appName} is not installed or has no executable path configured.`);
        }
        app.status = "running";
        state.fleetLogs.unshift({
          id: nid("flog"),
          botName: app.appName,
          stream: "stdout",
          line: `Started ${app.appName} (Desktop shell executes binary)`,
          createdAt: Date.now(),
        });
        return ok(`Started ${app.appName}.`);
      } else if (action === "stop") {
        app.status = "ready";
        app.activePid = null;
        state.fleetLogs.unshift({
          id: nid("flog"),
          botName: app.appName,
          stream: "stdout",
          line: `Stopped ${app.appName}`,
          createdAt: Date.now(),
        });
        return ok(`Stopped ${app.appName}.`);
      }
      return ok("Fleet action processed.");
    }
    case "start_fleet_daemon": {
      const id = String(a.id ?? "daemon");
      const app = state.apps.find((ap) => ap.id === id);
      const name = app ? app.appName : id;
      if (app && !app.executablePath) {
        return ok(`${name} executable path is not configured.`);
      }
      if (app) {
        app.status = "running";
        if (app.activePid == null) app.activePid = 1;
      }
      state.fleetLogs.unshift({
        id: nid("flog"),
        botName: name,
        stream: "stdout",
        line: `Started daemon ${name}`,
        createdAt: Date.now(),
      });
      return ok(`Started ${name}.`);
    }
    case "stop_fleet_daemon": {
      const id = String(a.id ?? "daemon");
      const app = state.apps.find((ap) => ap.id === id);
      const name = app ? app.appName : id;
      if (app) {
        app.status = "ready";
        app.activePid = null;
      }
      state.fleetLogs.unshift({
        id: nid("flog"),
        botName: name,
        stream: "warn",
        line: `Stopped daemon ${name}`,
        createdAt: Date.now(),
      });
      return ok(`Stopped ${name}.`);
    }
    case "restart_fleet_daemon": {
      const id = String(a.id ?? "daemon");
      const app = state.apps.find((ap) => ap.id === id);
      const name = app ? app.appName : id;
      if (app) {
        app.status = "running";
      }
      state.fleetLogs.unshift({
        id: nid("flog"),
        botName: name,
        stream: "stdout",
        line: `Restarted daemon ${name}`,
        createdAt: Date.now(),
      });
      return ok(`Restarted ${name}.`);
    }
    case "toggle_fleet_ghost_runner": {
      const id = String(a.id ?? "");
      const enabled = Boolean(a.enabled);
      if (enabled) {
        if (!state.settings.ghostRunners.includes(id)) state.settings.ghostRunners.push(id);
      } else {
        state.settings.ghostRunners = state.settings.ghostRunners.filter((g) => g !== id);
      }
      state.fleetLogs.unshift({
        id: nid("flog"),
        botName: id || "Grokbot",
        stream: "stdout",
        line: `${id}: 24/7 Cloud Ghost Runner ${enabled ? "ENABLED" : "DISABLED"}`,
        createdAt: Date.now(),
      });
      return ok(`Ghost runner updated for ${id}.`);
    }
    case "run_fleet_routine": {
      const id = String(a.id ?? "");
      state.fleetLogs.unshift({
        id: nid("flog"),
        botName: "Watchdog",
        stream: "stdout",
        line: `Manually triggered routine "${id}" -> Running now...`,
        createdAt: Date.now(),
      });
      return ok("Scheduled routine triggered.");
    }
    case "send_fleet_daemon_input": {
      const id = String(a.id ?? "Grokbot");
      const input = String(a.input ?? "").trim();
      if (input) {
        state.fleetLogs.unshift({
          id: nid("flog"),
          botName: id || "Grokbot",
          stream: "stdout",
          line: `stdin <- "${input}"`,
          createdAt: Date.now(),
        });
      }
      return ok("Command sent to daemon.");
    }
    case "clear_fleet_logs": {
      state.fleetLogs = [];
      return ok("Fleet logs cleared.");
    }
    case "inspect_url": {
      state.computerUrl = String(a.url ?? "");
      state.domNodes = [];
      state.domLatencyMs = 0;
      return ok("This preview does not fetch pages. The desktop shell inspects the URL.");
    }
    case "show_bot_screen":
      return ok("This preview cannot open the bot's computer. The desktop app opens it.");
    case "run_sandbox": {
      const botId = String(a.botId ?? "");
      const text = `$ ${a.command}\nThe desktop shell runs the allowlisted command.`;
      const bot = botId ? state.profiles.find((item) => item.id === botId) : undefined;
      if (bot) bot.shellOutput = text;
      else state.sandboxOutput = text;
      return ok("Sandbox commands run in the desktop shell.");
    }
    case "memory_vault":
      return { ...ok("Vault search runs in the desktop app."), payload: { hits: [], events: [] } };
    case "workspace_git":
      return ok("Git status and agent dispatch run in the desktop app.");
    case "install_git_package":
      return ok("Cloning a Git repository runs in the desktop app.");
    case "create_workflow": {
      const id = nid("wf");
      const name = String(a.name ?? "").trim() || "Untitled workflow";
      const node: WfNode = { id: "node_1", name: "Step", kind: "llm_reasoning", botProfile: "", model: "", prompt: "", status: "pending", latencyMs: 0 };
      state.workflows.unshift({
        id,
        name,
        yamlSource: `id: ${id}\nname: ${name}\nstatus: idle\ntriggers:\nnodes:\n  - id: node_1\n    name: Step\n    kind: llm_reasoning\n    bot: ""\n    model: ""\n    status: pending\n    latency_ms: 0\n    prompt: ""\n`,
        nodes: [node],
        triggers: [],
        currentStatus: "idle",
        pausedAtNodeId: null,
        checkpoint: {},
        updatedAt: Date.now(),
      });
      return ok("Workflow created.");
    }
    case "update_workflow": {
      const wf = state.workflows.find((w) => w.id === a.patch.id);
      if (!wf) return ok("Missing workflow.");
      if (a.patch.yamlSource) wf.yamlSource = a.patch.yamlSource;
      const node = wf.nodes.find((n: WfNode) => n.id === a.patch.nodeId);
      if (node) {
        if (a.patch.model) node.model = a.patch.model;
        if (a.patch.prompt) node.prompt = a.patch.prompt;
      }
      return ok("Workflow updated.");
    }
    case "pause_workflow": {
      const wf = state.workflows.find((w) => w.id === a.id);
      if (wf) {
        const targetNodeId = a.nodeId ?? a.node_id;
        const node = targetNodeId ? wf.nodes.find((n) => n.id === targetNodeId) : wf.nodes.find((n) => n.status !== "done");
        if (node) {
          node.status = "paused";
          wf.pausedAtNodeId = node.id;
        }
        wf.currentStatus = "paused_editable";
        return ok("Paused.");
      }
      const thread = state.threads.find((t) => t.id === a.id);
      if (thread) {
        thread.status = "paused";
        return ok("Routine paused.");
      }
      return ok("Paused.");
    }
    case "resume_workflow": {
      const wf = state.workflows.find((w) => w.id === a.id);
      if (wf) {
        wf.nodes.forEach((n) => {
          if (n.status !== "done") n.status = "done";
        });
        wf.currentStatus = "completed";
        wf.pausedAtNodeId = null;
        return ok("Resumed in the preview. The desktop shell also runs the wallet node through policy.");
      }
      const thread = state.threads.find((t) => t.id === a.id);
      if (thread) {
        thread.status = "idle";
        return ok("Routine resumed.");
      }
      return ok("Resumed in the preview. The desktop shell also runs the wallet node through policy.");
    }
    case "set_ide_agent":
      state.ideAgent = a.agent;
      return ok(null);
    case "close_position": {
      const pos = state.positions.find((p) => p.symbol === a.symbol);
      if (pos) pos.open = false;
      return ok("Sandbox position marked closed.");
    }
    case "scan_all_harnesses":
      return ok("Harnesses scanned in browser preview.");
    case "open_harness_window": {
      return ok("The harness stays inside Ronic OS. Pick its model in the chat menu and send from there.");
    }
    case "launch_local_app":
      return ok("This preview cannot launch a program on this computer.");
    case "run_harness_prompt":
      return ok("This preview cannot send that prompt. Open the desktop app.");
    case "reset_workspace":
      if (a.confirm !== "RESET") return ok("Type RESET to confirm.");
      state = seed();
      return ok("Preview reset.");
    case "create_bot_group": {
      const draft = (a.draft ?? {}) as Record<string, unknown>;
      const members = Array.isArray(draft.memberBotIds) ? draft.memberBotIds.map((item) => String(item)) : [];
      const unique = [...new Set(members)].filter((id) => state.profiles.some((bot) => bot.id === id));
      if (unique.length < 2 || unique.length > 8) return ok("A group needs 2 to 8 bots.");
      const mode = String(draft.coordinationMode ?? "");
      if (mode !== "parallel_swarm" && mode !== "lead_delegated" && mode !== "autonomous_handoff") return ok("Unknown coordination mode.");
      const title = String(draft.title ?? "").trim();
      const slug = title.replace(/^#/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
      if (!slug) return ok("A group needs a name.");
      const handle = `#${slug}`;
      if (state.botGroups.some((group) => group.groupHandle === handle)) return ok("That group name is already used.");
      const id = nid("grp");
      state.botGroups.unshift({
        id,
        groupHandle: handle,
        title,
        purpose: String(draft.purpose ?? "").trim(),
        coordinationMode: mode,
        leadBotId: unique[0],
        memberBotIds: unique,
        sharedWorkspaceDir: `~/.omniworkspace/bots/groups/${id}/workspace`,
        routineSchedule: "",
        createdAt: Date.now(),
      });
      const threadId = nid("thread");
      state.threads.unshift(makeThread({ id: threadId, botProfileId: unique[0], title: handle, targetType: "bot_group", groupId: id }));
      state.activeThreadId = threadId;
      state.activeProfileId = unique[0];
      return ok("Group created. The bots share one thread.");
    }
    case "open_group": {
      const group = state.botGroups.find((item) => item.id === a.groupId);
      if (!group) return ok("Group not found.");
      let thread = state.threads.find((item) => item.groupId === group.id);
      if (!thread) {
        const threadId = nid("thread");
        thread = makeThread({ id: threadId, botProfileId: group.leadBotId || group.memberBotIds[0], title: group.groupHandle, targetType: "bot_group", groupId: group.id, routineSchedule: group.routineSchedule });
        state.threads.unshift(thread);
      }
      state.activeThreadId = thread.id;
      state.activeProfileId = thread.botProfileId;
      return ok(null);
    }
    case "set_group_mode": {
      const group = state.botGroups.find((item) => item.id === a.groupId);
      const mode = String(a.mode ?? "");
      if (!group || (mode !== "parallel_swarm" && mode !== "lead_delegated" && mode !== "autonomous_handoff")) return ok("Could not save that mode.");
      group.coordinationMode = mode;
      return ok("Coordination mode saved.");
    }
    case "set_routine": {
      const thread = state.threads.find((item) => item.id === a.threadId);
      const schedule = String(a.schedule ?? "").trim();
      if (!thread) return ok("Open a chat before scheduling it.");
      thread.routineSchedule = schedule;
      const group = state.botGroups.find((item) => item.id === thread.groupId);
      if (group) group.routineSchedule = schedule;
      return ok(schedule ? "Routine saved on this thread." : "Routine removed.");
    }
    case "run_routine": {
      const thread = state.threads.find((item) => item.id === a.threadId) ?? activeThread();
      if (!thread) return ok("Open a bot or a group first.");
      state.activeThreadId = thread.id;
      const last = [...state.steps].reverse().find((item) => item.threadId === thread.id && item.role === "user");
      const group = state.botGroups.find((item) => item.id === thread.groupId);
      const prompt = last?.contentMarkdown || group?.purpose || thread.title;
      return browserCall("send_message", { prompt, providerId: a.providerId, model: a.model, modelId: a.modelId, effort: a.effort, attachments: [] });
    }
    case "resolve_gateway": {
      const step = state.steps.find((item) => item.id === a.stepId && item.actionType === "gateway_approval");
      if (!step || step.actionPayload.approvalState !== "pending") return ok("That approval is already decided.");
      const surface = String(step.actionPayload.surface ?? "gateway");
      const target = String(step.actionPayload.target ?? "");
      const botId = String(step.actionPayload.botId ?? "");
      const bot = state.profiles.find((item) => item.id === botId);
      if (!a.approve) {
        step.actionPayload = { ...step.actionPayload, approvalState: "declined" };
        pushAudit(botId, bot?.handle ?? "", step.threadId, surface, target, "denied_by_rule");
        state.steps.push({ id: nid("step"), threadId: step.threadId, turnId: nid("turn"), role: "assistant", modelUsed: "gateway", contentMarkdown: "Declined. A deny rule was saved for this action.", actionType: "message", actionPayload: {}, executionLatencyMs: 0, createdAt: Date.now() });
        return ok("Declined. A deny rule was saved.");
      }
      step.actionPayload = { ...step.actionPayload, approvalState: "approved" };
      pushAudit(botId, bot?.handle ?? "", step.threadId, surface, target, "allowed");
      if (step.actionPayload.kind === "wallet") {
        const amount = Number(step.actionPayload.amountUsd ?? 0);
        const blocked = applyMoney("crypto_x402", amount, "spend", "approved_by_user");
        const note = blocked ?? "approved_by_user";
        if (!blocked) {
          pushTx({ botProfileId: botId, rail: "crypto_x402", amountUsd: amount, nativeAmount: `$${amount}`, counterparty: "agent-request", purpose: String(step.actionPayload.prompt ?? ""), policyDecision: "approved_by_user", actor: "agent" });
        }
        state.steps.push({ id: nid("step"), threadId: step.threadId, turnId: nid("turn"), role: "tool", modelUsed: "policy-gate", contentMarkdown: note, actionType: "wallet_tx", actionPayload: { note, amountUsd: amount }, executionLatencyMs: 1, createdAt: Date.now() });
        return ok(note);
      }
      skipGate = true;
      state.activeThreadId = step.threadId;
      return browserCall("send_message", { prompt: String(step.actionPayload.prompt ?? ""), providerId: a.providerId, model: a.model, modelId: a.modelId, effort: a.effort, attachments: [] });
    }
    case "teach_task": {
      const draft = (a.draft ?? a) as Record<string, unknown>;
      const bot = state.profiles.find((item) => item.id === String(draft.botId ?? state.activeProfileId));
      if (!bot) return ok("Pick a bot first.");
      const title = String(draft.title ?? "Taught workflow").trim() || "Taught workflow";
      const notes = String(draft.notes ?? "").trim();
      const url = String(draft.url ?? state.computerUrl ?? "");
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "taught-workflow";
      const body = `---\nname: ${slug}\ndescription: Taught from a demonstration on this bot's computer.\n---\n\n# ${title}\n\nURL: ${url}\n\n${notes || "The person demonstrated this workflow and asked to save it."}\n`;
      const note = saveSkill(state, { profileId: bot.id, slug, title, description: notes || title, slashCommand: `/${slug}`, body });
      const thread = activeThread();
      if (thread) {
        state.steps.push({ id: nid("step"), threadId: thread.id, turnId: nid("turn"), role: "assistant", modelUsed: bot.handle, contentMarkdown: `Saved this demonstration as /${slug}. It is on this bot's skill list.`, actionType: "message", actionPayload: { kind: "taught_skill", slug: `/${slug}`, url }, executionLatencyMs: 0, createdAt: Date.now() });
      }
      return ok(note);
    }
    case "set_takeover": {
      const bot = state.profiles.find((item) => item.id === a.botId);
      if (!bot) return ok("Bot not found.");
      bot.takeover = Boolean(a.on);
      bot.statusLine = bot.takeover ? "You have control of this computer" : "Ready for tasks";
      return ok(bot.takeover ? "You have control of this bot's computer." : "The bot can work again.");
    }
    default:
      return ok(null);
  }
}

function memoryEngines(): MemoryEngine[] {
  return [
    { id: "mem0_builtin", label: "Mem0 (built in)", kind: "builtin", availability: "builtin", endpoint: "state.db", detail: "Local Mem0 vault in this workspace. No extra process.", latencyMs: null, scannedAt: 0 },
    { id: "zep_graphiti", label: "Zep (Graphiti)", kind: "external_mcp", availability: "missing", endpoint: "", detail: "Looks for a server on 127.0.0.1:8000.", latencyMs: null, scannedAt: 0 },
    { id: "cognee", label: "Cognee", kind: "external_mcp", availability: "missing", endpoint: "", detail: "Looks for Cognee on 127.0.0.1:8000.", latencyMs: null, scannedAt: 0 },
    { id: "letta", label: "Letta", kind: "external_mcp", availability: "missing", endpoint: "", detail: "Looks for a server on 127.0.0.1:8283.", latencyMs: null, scannedAt: 0 },
    { id: "obsidian_khoj", label: "Obsidian", kind: "vault", availability: "missing", endpoint: "", detail: "Markdown vault and wikilinks.", latencyMs: null, scannedAt: 0 },
  ];
}

function memoryRoute(): MemoryRoute {
  return { id: "global", scope: "global", engineId: "mem0_builtin", companionEngineId: null, updatedAt: 0 };
}

function adoptMem0(snap: Snapshot) {
  const builtin = memoryEngines()[0];
  const rewrite = (id: string) => (id === "openmemory_builtin" || id === "mem0_sdk" ? "mem0_builtin" : id);
  snap.memoryEngines = (snap.memoryEngines ?? []).filter((engine) => engine.id !== "openmemory_builtin" && engine.id !== "mem0_sdk");
  const current = snap.memoryEngines.find((engine) => engine.id === "mem0_builtin");
  if (!current) snap.memoryEngines.unshift(builtin);
  else {
    current.label = builtin.label;
    current.kind = "builtin";
    current.availability = "builtin";
    current.endpoint = builtin.endpoint;
    current.detail = builtin.detail;
  }
  if (snap.memoryRoute) snap.memoryRoute.engineId = rewrite(snap.memoryRoute.engineId);
  for (const route of snap.memoryRoutes ?? []) route.engineId = rewrite(route.engineId);
  for (const item of snap.memories ?? []) {
    if (!item.engineOrigin || item.engineOrigin === "openmemory_builtin" || item.engineOrigin === "mem0_sdk") item.engineOrigin = "mem0_builtin";
    if (!Array.isArray(item.syncedEngines)) item.syncedEngines = [];
  }
}

function initialMemories(): MemoryItem[] {
  return [];
}

function seed(): Snapshot {
  const policy: Policy = {
    maxPerTxUsd: 5,
    dailyCapUsd: 50,
    requireHumanApprovalAboveUsd: 10,
    maxSlippageBps: 35,
    killswitchEngaged: false,
    whitelisted: [],
  };
  const defaultBot: BotProfile = makeProfile({
    id: "bot_raj",
    handle: "@raj",
    displayName: "raj",
    avatar: "NW",
    avatarColor: "#6366f1",
    role: "Assistant & Operator",
    statusLine: "Ready for tasks",
    soulMarkdown: "You are @raj, an intelligent and reliable assistant and coworker in Ronic OS.",
    primaryAccountId: "prov_openrouter",
    longContextAccountId: "prov_gemini",
    fallbackAccountId: "prov_ollama",
    isPinned: true,
    allowComputerUse: true,
    allowBrowserUse: true,
    allowCodeExec: true,
  });
  const defaultThread: ChatThread = makeThread({
    id: "thread_raj_1",
    botProfileId: "bot_raj",
    title: "Chat with @raj",
    updatedAt: Date.now(),
  });
  return {
    homeDir: "~/.omniworkspace",
    onboardingComplete: false,
    vaultUnlocked: true,
    hasPassphrase: false,
    sandbox: true,
    kernel: "browser",
    activeProfileId: "bot_raj",
    activeThreadId: "thread_raj_1",
    profiles: [defaultBot],
    threads: [defaultThread],
    steps: [],
    botGroups: [],
    gatewayAudits: [],
    providers: [
      provider("prov_claude", "Claude Code", "cli_subprocess", "", 0, "", "prov_anthropic", "Not installed. Download Claude Code from the chat dock, or use an Anthropic key."),
      provider("prov_chatgpt", "ChatGPT", "official_oauth", "https://chatgpt.com", 0, "", "prov_openrouter", "Not signed in. Open the site, or paste an OpenAI API key to chat here."),
      provider("prov_anthropic", "Anthropic", "byok_api", "https://api.anthropic.com", 0, "", "prov_openrouter", "Needs an API key. Claude.ai opens from the icon dock."),
      provider("prov_gemini", "Gemini", "cli_subprocess", "", 0, "", "prov_openrouter", "Not signed in. Open Gemini, or paste a Google AI key."),
      provider("prov_grok", "Grok", "isolated_webview", "https://grok.com", 0, "", "prov_openrouter", "Not signed in. Open grok.com, or paste an xAI API key."),
      provider("prov_openrouter", "OpenRouter", "byok_api", "https://openrouter.ai/api/v1", 0, "", "prov_ollama", "Needs an API key."),
      provider("prov_deepseek", "DeepSeek", "byok_api", "https://api.deepseek.com/v1", 0, "", "prov_ollama", "Needs an API key."),
      provider("prov_qwen", "Qwen", "byok_api", "https://dashscope.aliyuncs.com/compatible-mode/v1", 0, "", null, "Needs an API key."),
      provider("prov_tokenrouter", "TokenRouter", "byok_api", "https://api.tokenrouter.io/v1", 0, "", "prov_openrouter", "Needs an API key."),
      provider("prov_bedrock", "Bedrock", "byok_api", "https://bedrock-runtime.us-east-1.amazonaws.com", 0, "", "prov_anthropic", "Needs a Bedrock API key."),
      provider("prov_nvidia", "NVIDIA NIM", "byok_api", "https://integrate.api.nvidia.com/v1", 0, "", "prov_openrouter", "Needs an NVIDIA API key."),
      provider("prov_mistral", "Mistral", "byok_api", "https://api.mistral.ai/v1", 0, "", null, "Needs a Mistral API key. Le Chat opens from the model menu."),
      provider("prov_groq", "Groq", "byok_api", "https://api.groq.com/openai/v1", 0, "", null, "Needs a Groq API key."),
      provider("prov_perplexity", "Perplexity", "byok_api", "https://api.perplexity.ai", 0, "", null, "Needs a Perplexity API key. The site sign-in stays on perplexity.ai."),
      provider("prov_together", "Together", "byok_api", "https://api.together.xyz/v1", 0, "", null, "Needs a Together API key."),
      provider("prov_cohere", "Cohere", "byok_api", "https://api.cohere.com/compatibility/v1", 0, "", null, "Needs a Cohere API key."),
      provider("prov_ollama", "Ollama", "local_ollama", "http://127.0.0.1:11434", 0, "", null, "Not running. Download Ollama, then Test ping."),
    ],
    apps: [
      app("app_cursor", "Cursor", "ide_bridge", "ws_companion"),
      app("app_vscode", "VS Code", "ide_bridge", "ws_companion"),
      app("app_obsidian", "Obsidian", "memory_vault", "fs_watcher"),
      app("app_aider", "Aider", "acp_agent", "acp_stdio"),
      app("app_opencode", "OpenCode", "acp_agent", "acp_stdio"),
      app("app_claude", "Claude Code", "acp_agent", "acp_stdio"),
      app("app_codex", "Codex CLI", "acp_agent", "acp_stdio"),
      app("app_gemini", "Gemini CLI", "acp_agent", "acp_stdio"),
      app("app_grokbot", "Grokbot", "bot_daemon", "uv_daemon"),
      app("app_muse", "Muse", "bot_daemon", "uv_daemon"),
      app("app_dots", "Dots", "bot_daemon", "uv_daemon"),
      app("app_hermes", "Hermes", "bot_daemon", "local_command"),
      app("app_openclaw", "OpenClaw", "bot_daemon", "local_command"),
    ],
    memories: initialMemories(),
    memoryEngines: memoryEngines(),
    memoryRoute: memoryRoute(),
    memoryRoutes: [memoryRoute()],
    skills: [],
    plugins: [],
    mcpServers: [],
    skillProposals: [],
    registry: rebuildRegistry([], []),
    skillIndexDelta: "",
    workflows: [],
    policy,
    balances: [
      { rail: "crypto_x402", label: "Crypto & x402", amountUsd: 0, nativeAmount: "0.00 USDC", nativeValue: 0, detail: "Sandbox ledger. No exchange is connected." },
      { rail: "razorpay_upi", label: "Razorpay India", amountUsd: 0, nativeAmount: "₹0", nativeValue: 0, detail: "Sandbox ledger. No payout account is connected." },
      { rail: "stripe_card", label: "Stripe virtual card", amountUsd: 0, nativeAmount: "No card", nativeValue: 0, detail: "Sandbox ledger. No card is connected." },
    ],
    transactions: [],
    positions: [],
    remediation: [],
    processes: [],
    fleetLogs: [],
    extensions: [],
    marketplace: MARKETPLACE_CATALOG.map((m) => ({
      slug: m.slug,
      title: m.name,
      author: m.authorOrRepo,
      category: m.category,
      blurb: m.description,
      installed: false,
      verified: m.verified,
      price: "Free",
    })),
    settings: {
      theme: "light",
      density: "standard",
      projectRoot: "",
      obsidianVault: "",
      watchdogEnabled: true,
      hotpatchEnabled: true,
      shadowGit: true,
      autoFailover: true,
      autoActUnderUsd: 0.5,
      updateChannel: "stable",
      version: "2.1.4",
      availableVersion: "2.1.4",
      plan: "Local",
      burstCreditsUsd: 0,
      ghostRunners: [],
      liveRails: false,
      triageUrl: "",
      claudePath: "",
      codexPath: "",
      geminiPath: "",
      aiderPath: "",
      opencodePath: "",
      uvPath: "",
      bunPath: "",
      showRailLabels: false,
    },
    scan: null,
    proxyUrl: "http://127.0.0.1:4141/v1",
    heartbeatAgeMs: 0,
    ipcLog: ["kernel preview"],
    quoteBtc: "—",
    quoteNifty: "—",
    spentTodayUsd: 0,
    ideAgent: "",
    computerUrl: "",
    domNodes: [],
    domLatencyMs: 0,
    sandboxOutput: "",
    bugPreview: "",
  };
}

function bagFromState(): ToolBag {
  const profileId = state.activeProfileId;
  return {
    memories: state.memories.map((item) => ({ id: item.id, title: item.title, content: item.contentMarkdown })),
    skills: state.skills.map((item) => ({
      slug: item.slug,
      slash: item.slashCommand,
      description: item.description,
      body: item.body,
      indexLine: item.indexLine,
      inIndex: inIndex(item, state.plugins, profileId),
      files: item.files.map((file) => ({ path: file.path, content: file.content })),
    })),
    providers: state.providers.map((item) => ({ name: item.name, health: item.healthDetail })),
    threads: state.threads.map((item) => ({ title: item.title })),
    proposals: [],
    profileId,
    delta: state.skillIndexDelta,
  };
}

function writeBag(bag: ToolBag) {
  const seen = new Set(bag.memories.map((item) => item.id));
  for (const row of bag.memories) {
    const index = state.memories.findIndex((item) => item.id === row.id);
    if (index >= 0) {
      state.memories[index].title = row.title;
      state.memories[index].contentMarkdown = row.content;
      continue;
    }
    state.memories.unshift({
      id: row.id,
      title: row.title,
      contentMarkdown: row.content,
      sourceType: "manual",
      scopedBotId: state.activeProfileId || null,
      filePathOrUri: "",
      wikilinks: [...row.content.matchAll(/\[\[(.+?)\]\]/g)].map((match) => match[1]),
      updatedAt: Date.now(),
      engineOrigin: state.memoryRoutes.find((route) => route.id === state.activeProfileId)?.engineId ?? state.memoryRoute.engineId ?? "mem0_builtin",
      syncedEngines: [],
    });
  }
  state.memories = state.memories.filter((item) => seen.has(item.id));
  for (const proposal of bag.proposals) {
    if (!state.skillProposals.some((item) => item.id === proposal.id)) state.skillProposals.unshift(proposal);
  }
}

function provider(id: string, name: string, providerType: Snapshot["providers"][number]["providerType"], endpoint: string, quota: number, resets: string, fallback: string | null, detail: string) {
  return {
    id, name, providerType, binaryOrEndpoint: endpoint, hasSecret: false, quotaWindowHours: 5, quotaUsedPercent: quota, quotaResetsAt: resets, fallbackAccountId: fallback, isActive: true, allowCliDispatch: false, lastHealthCheckMs: null, healthDetail: detail,
  };
}

function app(id: string, appName: string, category: string, bridgeProtocol: string) {
  return { id, appName, category, executablePath: "", bridgeProtocol, activePid: null, localPort: null, status: "missing", detail: "Not found yet. Scan this computer." };
}
