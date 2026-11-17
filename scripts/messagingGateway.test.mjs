// Simulated end-to-end test of the Remote Messaging Gateway frontend flows.
// Drives the same pure state transitions the React component uses and asserts
// the security + UX behavior for every scenario a user can trigger from the UI.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const outDir = mkdtempSync(path.join(tmpdir(), "ronic-gateway-"));

const compile = spawnSync(
  process.execPath,
  [path.join(root, "node_modules", "typescript", "bin", "tsc"), "--target", "ES2022", "--module", "ES2022", "--moduleResolution", "bundler", "--lib", "ES2022,DOM", "--strict", "--skipLibCheck", path.join(root, "src", "kernel", "messagingGateway.ts"), "--outDir", outDir],
  { encoding: "utf8" },
);
assert.equal(compile.status, 0, compile.stdout + compile.stderr);

const mod = await import(pathToFileURL(path.join(outDir, "messagingGateway.js")).href);
process.on("exit", () => rmSync(outDir, { recursive: true, force: true }));

const baseChannel = {
  id: "telegram",
  name: "Telegram",
  enabled: false,
  status: "disconnected",
  botTokenMasked: "",
  ownerUserId: "",
  defaultBot: "@claude",
  routableBots: ["@claude"],
};

test("push alert buttons match the trigger event", () => {
  const wallet = mod.pushButtonsForEvent("wallet_approval_gate");
  assert.deepEqual(wallet.map((b) => b.callbackActionId), [
    "approve_tx_901",
    "reject_tx_901",
    "view_pip_screenshot",
  ]);
  const sentinel = mod.pushButtonsForEvent("sentinel_incident");
  assert.deepEqual(sentinel.map((b) => b.callbackActionId), [
    "view_pip_screenshot",
    "ack_sentinel_supabase",
  ]);
  const done = mod.pushButtonsForEvent("task_completed");
  assert.deepEqual(done.map((b) => b.callbackActionId), ["view_pip_screenshot"]);
});

test("push alerts are only sendable when connected and enabled", () => {
  assert.equal(mod.canSendPush({ status: "connected", enabled: true }), true);
  assert.equal(mod.canSendPush({ status: "connected", enabled: false }), false);
  assert.equal(mod.canSendPush({ status: "disconnected", enabled: true }), false);
  assert.equal(mod.canSendPush({ status: "pid_conflict", enabled: true }), false);
});

test("reclaim clears the PID conflict and connects in one step", () => {
  const conflicted = {
    ...baseChannel,
    status: "pid_conflict",
    conflictPid: 19268,
    conflictError: "token locked by orphaned gateway",
  };
  const reclaimed = mod.applyReclaim(conflicted);
  assert.equal(reclaimed.status, "connected");
  assert.equal(reclaimed.enabled, true);
  assert.equal(reclaimed.conflictPid, undefined);
  assert.equal(reclaimed.conflictError, undefined);
  // Original object untouched (React state immutability).
  assert.equal(conflicted.status, "pid_conflict");
});

test("connect fills missing credentials from the draft, disconnect blocks", () => {
  const draft = { token: "8790...oC30", ownerId: "6194820194" };
  const connected = mod.applyToggleConnect(baseChannel, draft);
  assert.equal(connected.status, "connected");
  assert.equal(connected.enabled, true);
  assert.equal(connected.botTokenMasked, "8790...oC30");
  assert.equal(connected.ownerUserId, "6194820194");

  const disconnected = mod.applyToggleConnect(connected, draft);
  assert.equal(disconnected.status, "disconnected");
  assert.equal(disconnected.enabled, false);
  assert.equal(mod.canSendPush(disconnected), false);
  assert.equal(mod.localCommandVerdict(disconnected), "blocked");
});

test("connect keeps existing credentials over the draft", () => {
  const configured = { ...baseChannel, botTokenMasked: "saved-token", ownerUserId: "saved-owner" };
  const connected = mod.applyToggleConnect(configured, { token: "typed", ownerId: "typed" });
  assert.equal(connected.botTokenMasked, "saved-token");
  assert.equal(connected.ownerUserId, "saved-owner");
});

test("saved credentials survive a reload and a blank form clears them", () => {
  const file = mod.upsertSavedCredential({}, "telegram", { token: "123456789:AAH-token-token-token-token-token", ownerId: "8512444167", extras: [] }, true);
  const parsed = mod.parseSavedCredentials(JSON.parse(JSON.stringify(file)));
  assert.equal(parsed.telegram.reconnect, true);
  assert.equal(parsed.telegram.ownerId, "8512444167");
  const channels = mod.applyStoredCredentials([baseChannel], parsed);
  assert.equal(channels[0].botTokenMasked, parsed.telegram.token);
  const cleared = mod.upsertSavedCredential(parsed, "telegram", { token: "", ownerId: "", extras: [] });
  assert.equal(cleared.telegram, undefined);
  const linked = mod.upsertSavedCredential({}, "whatsapp", { token: "", ownerId: "", extras: [] }, true);
  assert.equal(linked.whatsapp.reconnect, true);
});

test("a scanned QR fills the gateway it belongs to", () => {
  const telegram = mod.interpretScannedGatewayQr("token 123456789:AAHabcdefghijklmnopqrstuvwxyz0123456789", "discord");
  assert.equal(telegram.ok, true);
  assert.equal(telegram.channelId, "telegram");
  assert.equal(telegram.kind, "bot_token");
  const login = mod.interpretScannedGatewayQr("tg://login?token=abc", "telegram");
  assert.equal(login.ok, false);
  const four = "2@AbCdEf,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=,BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=,CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=";
  const whatsapp = mod.interpretScannedGatewayQr(`${four},1`, "telegram");
  assert.equal(whatsapp.ok, true);
  assert.equal(whatsapp.channelId, "whatsapp");
  assert.equal(whatsapp.kind, "whatsapp_link");
  assert.equal(mod.isWhatsAppCompanionCode(`https://wa.me/settings/linked_devices#${four},1`), true);
  assert.equal(mod.isWhatsAppCompanionCode("http://192.168.1.20:9/pair?channel=signal&code=ab"), false);
  const slack = mod.interpretScannedGatewayQr("xoxb-123456789012-abcdefABCDEF", "telegram");
  assert.equal(slack.channelId, "slack");
  const other = mod.interpretScannedGatewayQr("mattermost-bot-secret", "mattermost");
  assert.equal(other.ok, true);
  assert.equal(other.channelId, "mattermost");
});

test("saving credentials writes the draft onto the channel", () => {
  const saved = mod.applySaveCredentials(baseChannel, { token: "t1", ownerId: "o1" });
  assert.equal(saved.botTokenMasked, "t1");
  assert.equal(saved.ownerUserId, "o1");
  assert.equal(baseChannel.botTokenMasked, "");
});

test("credential drafts are per-channel, never shared", () => {
  const tg = { ...baseChannel, id: "telegram", botTokenMasked: "tg-token", ownerUserId: "tg-owner" };
  const wa = { ...baseChannel, id: "whatsapp", botTokenMasked: "wa-token", ownerUserId: "wa-owner" };
  const drafts = { telegram: { token: "edited", ownerId: "edited" } };
  assert.deepEqual(mod.draftFor(drafts, tg), { token: "edited", ownerId: "edited", extras: [] });
  // WhatsApp has no draft — seeds from its own saved credentials.
  assert.deepEqual(mod.draftFor(drafts, wa), { token: "wa-token", ownerId: "wa-owner", extras: [] });
});

test("routable bot pills toggle on and off", () => {
  const added = mod.toggleRoutableBot(baseChannel, "@grokbot");
  assert.deepEqual(added.routableBots, ["@claude", "@grokbot"]);
  const removed = mod.toggleRoutableBot(added, "@claude");
  assert.deepEqual(removed.routableBots, ["@grokbot"]);
});

test("command simulator verdict enforces the only-if-connected rule", () => {
  assert.equal(mod.localCommandVerdict({ status: "connected", enabled: true }), "executed");
  assert.equal(mod.localCommandVerdict({ status: "disconnected", enabled: false }), "blocked");
  assert.equal(mod.localCommandVerdict({ status: "pid_conflict", enabled: true }), "blocked");
  assert.equal(mod.localCommandVerdict({ status: "error", enabled: true }), "blocked");
});

test("liveStateToStatus maps backend states to UI statuses", () => {
  assert.equal(mod.liveStateToStatus("Connected"), "connected");
  assert.equal(mod.liveStateToStatus("Error"), "error");
  assert.equal(mod.liveStateToStatus("Disconnected"), "disconnected");
  assert.equal(mod.liveStateToStatus("Validating"), "disconnected");
  assert.equal(mod.liveStateToStatus("Connecting"), "disconnected");
  assert.equal(mod.liveStateToStatus("AwaitingQrScan"), "disconnected");
});

test("routable bots are the ones that exist, and unknown handles are refused", () => {
  const fleet = mod.fleetMembers(
    [{ id: "bot_raj", handle: "raj", displayName: "Raj" }],
    [{ id: "grp_1", groupHandle: "growth", title: "Growth", leadBotId: "bot_raj" }],
  );
  assert.deepEqual(fleet.map((member) => member.handle), ["@raj", "#growth"]);

  const channel = { routableBots: ["@claude", "@raj", "#growth"], defaultBot: "@claude" };
  const pruned = mod.pruneChannelRouting(channel, fleet);
  assert.deepEqual(pruned.routableBots, ["@raj", "#growth"]);
  assert.equal(pruned.defaultBot, "@raj");
  assert.equal(mod.pruneChannelRouting({ routableBots: ["@raj"], defaultBot: "" }, fleet).defaultBot, "");

  const missing = mod.resolveInboundRoute("@claude check the build", pruned, fleet);
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /not a bot in this workspace/);

  const off = mod.resolveInboundRoute("@raj check the build", { routableBots: [], defaultBot: "" }, fleet);
  assert.equal(off.ok, false);
  assert.match(off.reason, /not routable/);

  const routed = mod.resolveInboundRoute("@raj check the build", pruned, fleet);
  assert.equal(routed.ok, true);
  assert.equal(routed.handle, "@raj");
  assert.equal(routed.botId, "bot_raj");
  assert.equal(routed.prompt, "check the build");

  const fallback = mod.resolveInboundRoute("check the build", pruned, fleet);
  assert.equal(fallback.ok, true);
  assert.equal(fallback.handle, "@raj");

  const group = mod.resolveInboundRoute("#growth ship the note", pruned, fleet);
  assert.equal(group.ok, true);
  assert.equal(group.kind, "group");
  assert.equal(group.botId, "bot_raj");
  assert.equal(group.prompt, "ship the note");
});

test("extra credentials stay optional and only known ones change the connection", () => {
  const plain = { token: "xoxb-bot", ownerId: "U1", extras: [] };
  assert.equal(mod.composeConnectToken("slack", plain), "xoxb-bot");
  assert.equal(mod.connectTokenFor("whatsapp", { token: "", ownerId: "", extras: [] }), "");
  assert.equal(mod.connectTokenFor("whatsapp", plain), "xoxb-bot");
  assert.deepEqual(mod.allowlistFromDraft(plain), ["U1"]);

  const withExtras = {
    token: "xoxb-bot",
    ownerId: "U1",
    extras: [
      { id: "1", label: "App token", value: "xapp-1" },
      { id: "2", label: "Allowlisted sender", value: "U2" },
      { id: "3", label: "", value: "ignored" },
      { id: "4", label: "Webhook secret", value: "shhh" },
    ],
  };
  assert.equal(mod.composeConnectToken("slack", withExtras), "xoxb-bot/xapp-1");
  assert.deepEqual(mod.allowlistFromDraft(withExtras), ["U1", "U2"]);
  assert.equal(mod.usableExtras(withExtras.extras).length, 3);

  const cloudOnly = {
    token: "",
    ownerId: "",
    extras: [{ id: "c", label: "Cloud API token", value: "EAAB" }],
  };
  assert.equal(mod.connectTokenFor("whatsapp", cloudOnly), "EAAB");
  assert.equal(mod.connectTokenFor("telegram", cloudOnly), "");
  assert.equal(mod.channelUsesQrPairing("whatsapp"), true);
  assert.equal(mod.channelUsesQrPairing("telegram"), false);
  assert.equal(mod.pairingUri("whatsapp", "abc", "192.168.1.20:47321"), "http://192.168.1.20:47321/pair?channel=whatsapp&code=abc");
  assert.equal(mod.pairingUri("whatsapp", "abc").includes("ronic://"), false);
  const instructions = mod.whatsappLinkInstructions();
  assert.match(instructions, /Linked devices/);
  assert.match(instructions, /Link a device/);
  assert.equal(instructions.includes("does not log in"), false);
  assert.equal(instructions.includes("http://"), false);
});

test("a live Connected listener enables the channel", () => {
  const waiting = mod.syncChannelFromLive(
    { status: "disconnected", enabled: false },
    { state: "AwaitingQrScan", error: null },
  );
  assert.equal(waiting.status, "disconnected");
  assert.equal(waiting.enabled, false);
  assert.equal(mod.canSendPush(waiting), false);
  const live = mod.syncChannelFromLive(waiting, { state: "Connected", error: null });
  assert.equal(live.status, "connected");
  assert.equal(live.enabled, true);
  assert.equal(mod.canSendPush(live), true);
  assert.equal(mod.pushBlockReason({ status: "connected", enabled: false }).includes("not connected"), false);
  assert.match(mod.pushBlockReason({ status: "connected", enabled: false }), /listener is connected/);
});

test("the first telegram sender is adopted and an @username matches that id", () => {
  const adopted = mod.decideInboundAccess([], "8512444167", "Hari (@harish_g_9449)");
  assert.equal(adopted.ok, true);
  assert.equal(adopted.adoptedOwnerId, "8512444167");
  const again = mod.decideInboundAccess(adopted.allow, "8512444167", "Hari (@harish_g_9449)");
  assert.equal(again.ok, true);
  assert.equal(again.adoptedOwnerId, null);
  const named = mod.decideInboundAccess(["@harish_g_9449"], "8512444167", "Hari (@harish_g_9449)");
  assert.equal(named.ok, true);
  assert.equal(named.adoptedOwnerId, null);
  const stranger = mod.decideInboundAccess(["8512444167"], "999", "Other (@nope)");
  assert.equal(stranger.ok, false);
  assert.match(stranger.reason, /999/);
  assert.match(mod.ownerAllowlistRefusal(stranger.reason), /Owner allowlist/);
});

test("a saved empty allowlist refuses the next sender", () => {
  const bag = new Map();
  globalThis.localStorage = {
    getItem: (key) => bag.get(key) ?? null,
    setItem: (key, value) => bag.set(key, value),
    removeItem: (key) => bag.delete(key),
  };
  mod.writeOwnerAllowlist("telegram", []);
  const blocked = mod.inboundAccess("telegram", "", "999", "Stranger");
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /999/);
  const fresh = mod.inboundAccess("slack", "", "8512444167", "Hari");
  assert.equal(fresh.ok, true);
  assert.equal(fresh.adoptedOwnerId, "8512444167");
});

test("owner allowlist adds a blocked sender without dropping the saved owner", () => {
  const bag = new Map();
  globalThis.localStorage = {
    getItem: (key) => bag.get(key) ?? null,
    setItem: (key, value) => bag.set(key, value),
    removeItem: (key) => bag.delete(key),
  };
  assert.deepEqual(mod.effectiveOwnerAllowlist(null, "111"), ["111"]);
  assert.deepEqual(mod.withAllowedOwner([], "111", "8512444167"), ["111", "8512444167"]);
  assert.deepEqual(mod.withoutAllowedOwner(["111", "8512444167"], "111"), ["8512444167"]);

  assert.equal(mod.savedOwnerAllowlist("telegram"), null);
  assert.deepEqual(mod.inboundAllowlist("telegram", "111"), ["111"]);
  const allowed = mod.allowOwner("telegram", "111", "8512444167");
  assert.deepEqual(allowed, ["111", "8512444167"]);
  assert.deepEqual(mod.inboundAllowlist("telegram", "999"), ["111", "8512444167"]);
  const kept = mod.decideInboundAccess(mod.inboundAllowlist("telegram", "111"), "8512444167", "Hari");
  assert.equal(kept.ok, true);
  mod.rememberBlockedSender("telegram", "8512444167", "Hari");
  assert.equal(mod.lastBlockedSender("telegram").senderId, "8512444167");
  mod.clearBlockedSender("telegram", "8512444167");
  assert.equal(mod.lastBlockedSender("telegram"), null);
  assert.deepEqual(mod.removeAllowedOwner("telegram", "111", "111"), ["8512444167"]);
  const onlyOwner = mod.decideInboundAccess(mod.inboundAllowlist("telegram", "111"), "111", "Other");
  assert.equal(onlyOwner.ok, false);
});

test("one routable bot receives a message that names nobody", () => {
  const fleet = mod.fleetMembers([{ id: "bot_spidy", handle: "spidy", displayName: "Spidy" }], []);
  const routed = mod.resolveInboundRoute("Hi", { routableBots: ["@spidy"], defaultBot: "" }, fleet);
  assert.equal(routed.ok, true);
  assert.equal(routed.handle, "@spidy");
  assert.equal(routed.prompt, "Hi");
  const many = mod.resolveInboundRoute("Hi", { routableBots: ["@spidy", "@raj"], defaultBot: "" }, [
    ...fleet,
    { id: "bot_raj", handle: "@raj", displayName: "Raj", kind: "bot", leadBotId: "bot_raj" },
  ]);
  assert.equal(many.ok, false);
  assert.match(many.reason, /No default bot/);
});

test("full simulated flow: reclaim → configure → route → push → disconnect", () => {
  // 1. Telegram starts in PID conflict (matches the shipped demo state).
  let ch = {
    ...baseChannel,
    status: "pid_conflict",
    conflictPid: 19268,
    conflictError: "locked",
    botTokenMasked: "8790...oC30",
    ownerUserId: "6194820194",
  };
  assert.equal(mod.canSendPush(ch), false);
  assert.equal(mod.localCommandVerdict(ch), "blocked");

  // 2. One-click reclaim connects it.
  ch = mod.applyReclaim(ch);
  assert.equal(ch.status, "connected");
  assert.equal(mod.canSendPush(ch), true);

  // 3. Owner routes an extra bot and changes the default.
  ch = mod.toggleRoutableBot(ch, "@dots");
  ch = { ...ch, defaultBot: "@dots" };
  assert.ok(ch.routableBots.includes("@dots"));

  // 4. Push alert with wallet-gate buttons is now sendable.
  const buttons = mod.pushButtonsForEvent("wallet_approval_gate");
  assert.equal(buttons.length, 3);
  assert.equal(mod.canSendPush(ch), true);

  // 5. Disconnect blocks everything again.
  ch = mod.applyToggleConnect(ch, { token: "", ownerId: "" });
  assert.equal(mod.canSendPush(ch), false);
  assert.equal(mod.localCommandVerdict(ch), "blocked");
});

test("a gateway turn replies with the new assistant text only", () => {
  const before = new Set(["old"]);
  const steps = [
    { id: "old", threadId: "t1", role: "assistant", actionType: "message", contentMarkdown: "earlier" },
    { id: "think", threadId: "t1", role: "assistant", actionType: "thinking", contentMarkdown: "hidden" },
    { id: "user", threadId: "t1", role: "user", actionType: "message", contentMarkdown: "[Telegram] hi" },
    { id: "new", threadId: "t1", role: "assistant", actionType: "message", contentMarkdown: "Hello from spidy." },
    { id: "other", threadId: "t2", role: "assistant", actionType: "message", contentMarkdown: "wrong thread" },
  ];
  assert.equal(mod.gatewayAssistantReply(steps, "t1", before), "Hello from spidy.");
  assert.equal(mod.gatewayAssistantReply(steps, "", before), "");
});

test("telegram replies are split and markdown-safe", () => {
  assert.equal(mod.channelAcceptsReply("telegram"), true);
  assert.equal(mod.channelAcceptsReply("whatsapp"), false);
  const chunks = mod.outboundChannelChunks("telegram", "use _this_ *model*");
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0], "use \\_this\\_ \\*model\\*");
  const long = `${"a".repeat(2000)}\n${"b".repeat(50)}`;
  const parts = mod.outboundChannelChunks("telegram", long);
  assert.ok(parts.length >= 2);
  assert.ok(parts.every((part) => part.length <= 4096));
});
