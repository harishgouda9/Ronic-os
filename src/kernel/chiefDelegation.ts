// Chief Officer delegation shared by the browser preview.
// Contracts stay in progress until the owner attests them. The commitment is a
// SHA-256 of the scoped sub-goal, not a zero-knowledge proof.

export type PlanBot = {
  id: string;
  handle: string;
  role: string;
  soul: string;
  allowComputerUse: boolean;
  allowBrowserUse: boolean;
  allowCodeExec: boolean;
  allowFileWrite: boolean;
  primaryAccountId: string;
  longContextAccountId: string;
  fallbackAccountId: string;
};

export type PlanGroup = {
  id: string;
  handle: string;
  name: string;
  managerId: string;
  memberIds: string[];
};

export type PlannedContract = {
  assigneeId: string;
  subGoal: string;
  complexity: number;
  routedEndpoint: string;
  costTier: string;
  scopes: string[];
  verifierRule: string;
  requiresHuman: boolean;
  status: "in_progress" | "friction_challenged";
  frictionReason: string;
};

export type PlanSuccess = {
  ok: true;
  plans: PlannedContract[];
  scopeLabel: string;
  toast: string;
};

export type PlanFailure = { ok: false; error: string };

const HEAVY = ["refactor", "audit", "security", "payroll", "architecture", "migrate", "concurrency", "race", "ledger", "invariant"];
const MEDIUM = ["test", "verify", "patch", "fix", "bug", "implement", "review"];
const LIGHT = ["format", "csv", "json", "rename", "summary", "summarize", "list", "reformat"];
const STOP = new Set(["the", "and", "for", "with", "this", "that", "from", "into", "your", "you", "are", "was", "were", "have", "has", "will", "then", "than", "not", "but", "all", "any", "our", "its", "per"]);
const OR_VERBS = ["lock", "convert", "send", "pay", "patch", "skip", "approve", "reject", "delete", "transfer", "withdraw", "rebalance", "merge"];
const VERIFIER = "The owner attests this sub-goal is done. It stays in progress until then.";

export function scoreComplexity(text: string): number {
  const lower = text.toLowerCase();
  const heavyHits = HEAVY.filter((word) => lower.includes(word)).length;
  const medium = MEDIUM.some((word) => lower.includes(word));
  const light = LIGHT.some((word) => lower.includes(word));
  let score = 20;
  if (heavyHits > 0) score += 30;
  if (heavyHits >= 2) score += 20;
  if (medium) score += 15;
  if (light && heavyHits === 0) score -= 15;
  if ([...text].length > 180) score += 8;
  return Math.max(1, Math.min(100, score));
}

export function frictionReason(text: string): string | null {
  const trimmed = text.trim();
  if ([...trimmed].length < 12) return "Objective is too short to grade. Say what finished work looks like.";
  const lower = trimmed.toLowerCase();
  if (hasOrChoice(lower)) return "The objective offers two actions. Name one before a bot runs it.";
  if (currencyKinds(lower) >= 2 && !hasRateInstruction(lower)) return "Two currencies are named and no rate or lock is specified.";
  if (asksToMoveMoney(lower)) return "This asks a bot to move money. Confirm the amount in the workspace before it runs.";
  return null;
}

export function splitClauses(text: string): string[] {
  const clauses: string[] = [];
  for (const line of text.split(/[\n\r;]/)) {
    for (const part of splitAnd(line)) {
      const trimmed = part.trim();
      if (trimmed) clauses.push(trimmed);
    }
  }
  return clauses.slice(0, 8);
}

export function verifyDelegationAuthority(issuerId: string, isChief: boolean, assigneeId: string, group: PlanGroup | null): string | null {
  if (!assigneeId.trim()) return "Missing assignee.";
  if (isChief) return null;
  if (!group) return `AUTHORITY DENIED: ${issuerId} is not the chief officer and no group was given.`;
  if (group.managerId !== issuerId) return `AUTHORITY DENIED: this bot is not the manager of ${group.name}.`;
  if (!group.memberIds.includes(assigneeId)) return `SCOPE VIOLATION: the manager of ${group.name} can only assign bots in that group.`;
  return null;
}

export function routeAccount(score: number, bot: PlanBot): { endpoint: string; tier: string } {
  if (score < 35) return { endpoint: nonempty(bot.fallbackAccountId, bot.primaryAccountId), tier: "lightweight" };
  if (score < 70) return { endpoint: nonempty(bot.primaryAccountId, bot.fallbackAccountId), tier: "balanced" };
  return { endpoint: nonempty(bot.longContextAccountId, bot.primaryAccountId), tier: "heavy" };
}

export function scopesFor(bot: PlanBot): string[] {
  const scopes = ["read:assigned_subgoal", "deny:vault_secrets", "deny:wallet_spend"];
  if (bot.allowCodeExec) scopes.push("exec:code");
  if (bot.allowBrowserUse) scopes.push("use:browser");
  if (bot.allowComputerUse) scopes.push("use:computer");
  if (bot.allowFileWrite) scopes.push("write:bot_workspace");
  return scopes;
}

export function executionCommitment(contractId: string, subGoal: string, scopes: string[]): string {
  const payload = ["ronic-delegation-v1", contractId, subGoal, ...scopes].join("\n") + "\n";
  return `commit_sha256:${sha256Hex(payload)}`;
}

export function planDelegation(objective: string, issuerId: string, chiefId: string, group: PlanGroup | null, bots: PlanBot[]): PlanSuccess | PlanFailure {
  const text = objective.trim();
  if (!text) return { ok: false, error: "Write an objective first." };
  if ([...text].length > 4000) return { ok: false, error: "That objective is too long." };
  const scoped = group !== null;
  if (!scoped && !chiefId) return { ok: false, error: "Appoint a chief officer first." };
  if (!scoped && issuerId !== chiefId) return { ok: false, error: "Only the chief officer can delegate across the workspace." };
  if (scoped && group && group.managerId !== issuerId) return { ok: false, error: `AUTHORITY DENIED: this bot is not the manager of ${group.name}.` };
  const known = new Set(bots.map((bot) => bot.id));
  if (!known.has(issuerId)) return { ok: false, error: "That bot does not exist." };

  const candidates = scoped && group
    ? bots.filter((bot) => group.memberIds.includes(bot.id))
    : bots.filter((bot) => bot.id !== issuerId);
  if (candidates.length === 0) {
    return { ok: false, error: scoped ? "This group has no member bots." : "The chief needs at least one other bot to delegate to." };
  }
  for (const bot of candidates) {
    const denied = verifyDelegationAuthority(issuerId, !scoped, bot.id, group);
    if (denied) return { ok: false, error: denied };
  }

  const whole = frictionReason(text);
  const clauses = whole ? [text] : splitClauses(text);
  if (clauses.length === 0) return { ok: false, error: "Write an objective first." };
  const assigned = assignClauses(clauses, candidates);
  const scopeLabel = scoped && group ? `GROUP: ${group.name}` : "GLOBAL";
  const plans = assigned.map(({ clause, bot }) => {
    const reason = frictionReason(clause);
    const complexity = scoreComplexity(clause);
    const route = routeAccount(complexity, bot);
    return {
      assigneeId: bot.id,
      subGoal: clause,
      complexity,
      routedEndpoint: route.endpoint || "unassigned",
      costTier: route.tier,
      scopes: scopesFor(bot),
      verifierRule: VERIFIER,
      requiresHuman: reason !== null || needsHuman(clause),
      status: reason ? "friction_challenged" as const : "in_progress" as const,
      frictionReason: reason ?? "",
    };
  });
  return { ok: true, plans, scopeLabel, toast: delegationToast(plans) };
}

export function delegationToast(plans: { status: string }[]): string {
  const noun = plans.length === 1 ? "contract" : "contracts";
  const waiting = plans.filter((plan) => plan.status === "friction_challenged").length;
  if (waiting > 0) return `Delegated ${plans.length} ${noun}. ${waiting} need a decision before they run.`;
  return `Delegated ${plans.length} ${noun}. They stay in progress until you attest them.`;
}

export type MobileRoute = {
  issuerId: string;
  groupId: string;
  objective: string;
  scopeLabel: string;
};

export function routeMobile(text: string, chiefId: string, groups: PlanGroup[], bots: PlanBot[]): { ok: true; route: MobileRoute } | PlanFailure {
  let trimmed = text.trim();
  if (trimmed.startsWith("/chief")) trimmed = trimmed.slice("/chief".length).trim();
  if (!trimmed) return { ok: false, error: "Write an objective first." };
  const first = trimmed.split(/\s+/)[0] ?? "";
  const rest = trimmed.slice(first.length).trim();
  if (first.startsWith("#")) {
    const group = findGroup(first, groups);
    if (!group) return { ok: false, error: `No group matches ${first}.` };
    const objective = rest || trimmed;
    return { ok: true, route: { issuerId: group.managerId, groupId: group.id, objective, scopeLabel: `GROUP: ${group.name}` } };
  }
  if (first.startsWith("@")) {
    const bot = bots.find((item) => sameHandle(item.handle, first));
    if (!bot) return { ok: false, error: `No bot matches ${first}.` };
    const led = groups.filter((group) => group.managerId === bot.id);
    if (led.length > 0) {
      const group = led[0];
      return { ok: true, route: { issuerId: bot.id, groupId: group.id, objective: rest || trimmed, scopeLabel: `GROUP: ${group.name}` } };
    }
    if (bot.id === chiefId) {
      return { ok: true, route: { issuerId: chiefId, groupId: "", objective: rest || trimmed, scopeLabel: "GLOBAL" } };
    }
    return { ok: false, error: "That bot is not the chief officer or a group manager." };
  }
  if (!chiefId) return { ok: false, error: "Appoint a chief officer before sending a workspace command." };
  return { ok: true, route: { issuerId: chiefId, groupId: "", objective: trimmed, scopeLabel: "GLOBAL" } };
}

export function authorizeMobile(connected: boolean, channelId: string, storedOwner: string, senderId: string): string | null {
  if (!connected) return `BLOCKED: Messaging channel '${channelId}' is not connected. Connect it first.`;
  if (!storedOwner.trim()) return "BLOCKED: This channel has no allowlisted owner. Connect it again and set an owner id.";
  if (senderId.trim() !== storedOwner.trim()) return "UNAUTHORIZED: Sender ID does not match the allowlisted owner.";
  return null;
}

export function parseCallback(callback: string): { ok: true; kind: "attest"; id: string } | { ok: true; kind: "resolve"; id: string; note: string } | PlanFailure {
  const raw = callback.trim();
  if (raw.startsWith("attest:")) {
    const id = raw.slice("attest:".length).trim();
    if (!id) return { ok: false, error: "Missing contract id." };
    return { ok: true, kind: "attest", id };
  }
  if (raw.startsWith("resolve:")) {
    const rest = raw.slice("resolve:".length);
    const splitAt = rest.indexOf(":");
    const id = (splitAt === -1 ? rest : rest.slice(0, splitAt)).trim();
    const note = splitAt === -1 ? "" : rest.slice(splitAt + 1).trim();
    if (!id || [...note].length < 8) return { ok: false, error: "A resolve callback needs a contract id and a clarification." };
    return { ok: true, kind: "resolve", id, note };
  }
  return { ok: false, error: "That phone button is not a delegation action." };
}

export function inboundChiefAction(text: string): { text: string; callback: string } | null {
  const trimmed = text.trim();
  const tap = trimmed.match(/^\[button_tap:(attest:[^\]]+|resolve:[^\]]+)\]$/);
  if (tap) return { text: "", callback: tap[1] };
  if (trimmed === "/chief" || trimmed.startsWith("/chief ") || trimmed.startsWith("#") || trimmed.startsWith("@")) {
    return { text: trimmed, callback: "" };
  }
  return null;
}

export type CardRow = {
  issuerHandle: string;
  assigneeHandle: string;
  subGoal: string;
  status: string;
  costTier: string;
  routedEndpoint: string;
  commitment: string;
  frictionReason: string;
  scopes: string[];
};

export function executiveCard(commander: string, scope: string, objective: string, rows: CardRow[]): string {
  const lines = [
    "RONIC OS — Executive report",
    `Commander: ${commander}`,
    `Scope: ${scope}`,
    `Objective: ${objective}`,
    "",
  ];
  rows.forEach((row, index) => {
    lines.push(`${index + 1}. ${row.issuerHandle} → ${row.assigneeHandle}`);
    lines.push(`   ${row.subGoal}`);
    lines.push(`   Status: ${row.status} · ${row.costTier} · ${row.routedEndpoint}`);
    lines.push(`   Commitment: ${row.commitment}`);
    lines.push(`   Permissions: ${row.scopes.join(", ")}`);
    if (row.frictionReason) lines.push(`   Needs a decision: ${row.frictionReason}`);
  });
  const waiting = rows.filter((row) => row.status === "friction_challenged").length;
  const open = rows.filter((row) => row.status === "in_progress").length;
  lines.push("");
  lines.push(`${open} in progress, ${waiting} waiting on you. Nothing is marked done until you attest it.`);
  const card = lines.join("\n");
  return card.length > 3500 ? `${card.slice(0, 3400)}\n…` : card;
}

export function sha256Hex(message: string): string {
  const data = new TextEncoder().encode(message);
  const bitLen = data.length * 8;
  const pad = (56 - ((data.length + 1) % 64) + 64) % 64;
  const buf = new Uint8Array(data.length + 1 + pad + 8);
  buf.set(data);
  buf[data.length] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(buf.length - 8, Math.floor(bitLen / 0x100000000));
  view.setUint32(buf.length - 4, bitLen >>> 0);

  const k = Uint32Array.from([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Uint32Array(64);
  for (let offset = 0; offset < buf.length; offset += 64) {
    for (let t = 0; t < 16; t += 1) w[t] = view.getUint32(offset + t * 4);
    for (let t = 16; t < 64; t += 1) {
      const s0 = (rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3)) >>> 0;
      const s1 = (rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10)) >>> 0;
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let t = 0; t < 64; t += 1) {
      const s1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ ((~e) & g)) >>> 0;
      const temp1 = (h + s1 + ch + k[t] + w[t]) >>> 0;
      const s0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (s0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0; d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map((part) => part.toString(16).padStart(8, "0")).join("");
}

function nonempty(preferred: string, fallback: string): string {
  return preferred.trim() || fallback.trim();
}

function needsHuman(text: string): boolean {
  const lower = text.toLowerCase();
  return ["which ", "prefer", "should we", "looks better"].some((word) => lower.includes(word));
}

function hasOrChoice(lower: string): boolean {
  const at = lower.indexOf(" or ");
  if (at === -1) return false;
  const left = lower.slice(0, at);
  const right = lower.slice(at + 4);
  const hit = (side: string) => OR_VERBS.some((verb) => side.includes(verb));
  return hit(left) && hit(right);
}

function currencyKinds(lower: string): number {
  let count = 0;
  if (lower.includes("$") || lower.includes("usd") || lower.includes("usdc")) count += 1;
  if (lower.includes("₹") || lower.includes("inr") || lower.includes("rupee")) count += 1;
  if (lower.includes("eur") || lower.includes("€")) count += 1;
  if (lower.includes("gbp") || lower.includes("£")) count += 1;
  return count;
}

function hasRateInstruction(lower: string): boolean {
  return ["spot", "lock rate", "locked rate", "fixed rate", "exchange rate", "at rate"].some((word) => lower.includes(word));
}

function asksToMoveMoney(lower: string): boolean {
  const verb = ["pay ", "pay the", "send ", "transfer ", "withdraw ", "approve payment"].some((word) => lower.includes(word));
  const money = lower.includes("$") || lower.includes("₹") || lower.includes("usd") || lower.includes("inr") || lower.includes("usdc") || lower.includes("payment");
  return verb && money && !lower.includes("do not pay") && !lower.includes("don't pay") && !lower.includes("do not send");
}

function splitAnd(input: string): string[] {
  const lower = input.toLowerCase();
  const parts: string[] = [];
  let start = 0;
  let index = 0;
  while (index < lower.length) {
    if (lower.startsWith(" and ", index)) {
      const left = input.slice(start, index).trim();
      const right = input.slice(index + 5).trim();
      if ([...left].length >= 8 && [...right].length >= 8) {
        parts.push(left);
        start = index + 5;
        index = start;
        continue;
      }
    }
    index += 1;
  }
  const tail = input.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

function fitWords(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length >= 3 && !STOP.has(word));
}

function fitScore(clause: string, bot: PlanBot): number {
  const hay = `${bot.handle} ${bot.role} ${bot.soul}`.toLowerCase();
  return fitWords(clause).reduce((score, word) => score + (hay.includes(word) ? 1 : 0), 0);
}

function assignClauses(clauses: string[], candidates: PlanBot[]): { clause: string; bot: PlanBot }[] {
  const used = candidates.map(() => 0);
  return clauses.map((clause) => {
    let best = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    candidates.forEach((bot, index) => {
      const score = fitScore(clause, bot) * 100 - used[index];
      if (score > bestScore) {
        bestScore = score;
        best = index;
      }
    });
    used[best] += 1;
    return { clause, bot: candidates[best] };
  });
}

function findGroup(token: string, groups: PlanGroup[]): PlanGroup | undefined {
  const bare = token.replace(/^#/, "");
  return groups.find((group) => {
    const handleBare = group.handle.replace(/^#/, "");
    return group.handle.toLowerCase() === token.toLowerCase()
      || handleBare.toLowerCase() === bare.toLowerCase()
      || group.name.toLowerCase() === bare.toLowerCase()
      || group.name.toLowerCase() === token.toLowerCase();
  });
}

function sameHandle(handle: string, token: string): boolean {
  const left = handle.trim().replace(/^@/, "");
  const right = token.trim().replace(/^@/, "");
  return left.length > 0 && left.toLowerCase() === right.toLowerCase();
}

function rotr(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}
