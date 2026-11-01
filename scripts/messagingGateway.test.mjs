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
  assert.equal(mod.pairingUri("whatsapp", "abc"), "ronic://gateway/pair?channel=whatsapp&code=abc");
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
