// Pure checks for Chief Officer delegation. The browser preview and the
// desktop kernel share these rules: scores, friction, assignment, and the
// phone allowlist. Contracts are not marked done here.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const outDir = mkdtempSync(path.join(tmpdir(), "ronic-chief-"));

const compile = spawnSync(
  process.execPath,
  [
    path.join(root, "node_modules", "typescript", "bin", "tsc"),
    "--target", "ES2022",
    "--module", "ES2022",
    "--moduleResolution", "bundler",
    "--lib", "ES2022,DOM",
    "--strict",
    "--skipLibCheck",
    path.join(root, "src", "kernel", "chiefDelegation.ts"),
    "--outDir", outDir,
  ],
  { encoding: "utf8" },
);
assert.equal(compile.status, 0, compile.stdout + compile.stderr);

const mod = await import(pathToFileURL(path.join(outDir, "chiefDelegation.js")).href);
process.on("exit", () => rmSync(outDir, { recursive: true, force: true }));

function bot(id, handle, role, soul, flags = {}) {
  return {
    id,
    handle,
    role,
    soul,
    allowComputerUse: false,
    allowBrowserUse: true,
    allowCodeExec: true,
    allowFileWrite: false,
    primaryAccountId: "prov_main",
    longContextAccountId: "prov_long",
    fallbackAccountId: "prov_fast",
    ...flags,
  };
}

const writer = bot("writer", "@writer", "formats csv reports", "");
const auditor = bot("auditor", "@auditor", "security reviews", "reviews webhook bugs and security audits");
const chief = bot("chief", "@chief", "Coordinates the workspace", "");
const bots = [chief, writer, auditor];
const group = {
  id: "grp",
  handle: "#ops",
  name: "ops",
  managerId: "writer",
  memberIds: ["writer", "auditor"],
};

test("complexity scores match the cost tiers", () => {
  assert.equal(mod.scoreComplexity("Reformat the csv export"), 5);
  assert.equal(mod.scoreComplexity("Patch the webhook bug"), 35);
  assert.equal(mod.scoreComplexity("Audit the payroll ledger"), 70);
  assert.equal(mod.scoreComplexity("Refactor the security architecture and migrate the ledger"), 70);
  assert.deepEqual(mod.routeAccount(5, writer), { endpoint: "prov_fast", tier: "lightweight" });
  assert.deepEqual(mod.routeAccount(35, writer), { endpoint: "prov_main", tier: "balanced" });
  assert.deepEqual(mod.routeAccount(70, writer), { endpoint: "prov_long", tier: "heavy" });
  const empty = bot("bare", "@bare", "", "", { primaryAccountId: "", longContextAccountId: "", fallbackAccountId: "" });
  assert.equal(mod.routeAccount(5, empty).endpoint, "");
});

test("friction catches short text, a choice, two currencies, and a payment", () => {
  assert.match(mod.frictionReason("do it"), /too short/);
  assert.match(mod.frictionReason("lock the reserve or convert the balance"), /two actions/);
  assert.match(mod.frictionReason("compare usd and inr totals"), /Two currencies/);
  assert.match(mod.frictionReason("pay the $20 invoice now"), /move money/);
  assert.equal(mod.frictionReason("Patch the 429 webhook retry"), null);
  assert.equal(mod.frictionReason("compare usd and inr totals at the spot rate"), null);
  assert.equal(mod.frictionReason("Do not pay. Leave the invoice."), null);
  assert.equal(mod.frictionReason("use the spot rate"), null);
});

test("a short and-clause stays one piece, and eight is the cap", () => {
  assert.deepEqual(mod.splitClauses("Patch the webhook bug and reformat the csv export"), [
    "Patch the webhook bug",
    "reformat the csv export",
  ]);
  assert.deepEqual(mod.splitClauses("Fix it and go"), ["Fix it and go"]);
  const many = Array.from({ length: 10 }, (_, index) => `Reformat export ${index + 10}`).join("\n");
  assert.equal(mod.splitClauses(many).length, 8);
});

test("a group manager can assign members, including themselves", () => {
  assert.match(mod.verifyDelegationAuthority("writer", false, "outsider", group), /SCOPE VIOLATION/);
  assert.equal(mod.verifyDelegationAuthority("writer", false, "auditor", group), null);
  assert.equal(mod.verifyDelegationAuthority("writer", false, "writer", group), null);
  assert.equal(mod.verifyDelegationAuthority("chief", true, "outsider", null), null);
  assert.match(mod.verifyDelegationAuthority("writer", false, "auditor", null), /AUTHORITY DENIED/);
});

test("scoped work goes to the matching member and is not marked done", () => {
  const planned = mod.planDelegation("Patch the webhook bug and reformat the csv export", "writer", "chief", group, bots);
  assert.equal(planned.ok, true);
  assert.equal(planned.plans.length, 2);
  assert.equal(planned.plans[0].assigneeId, "auditor");
  assert.equal(planned.plans[1].assigneeId, "writer");
  assert.equal(planned.plans[0].status, "in_progress");
  assert.equal(planned.plans[1].status, "in_progress");
  assert.equal(planned.plans[0].costTier, "balanced");
  assert.equal(planned.plans[1].costTier, "lightweight");
  for (const plan of planned.plans) {
    assert.ok(plan.scopes.includes("deny:wallet_spend"));
    assert.ok(plan.scopes.includes("deny:vault_secrets"));
    assert.equal(plan.scopes.some((scope) => scope.includes("wallet") && !scope.startsWith("deny:")), false);
    assert.match(plan.verifierRule, /stays in progress/);
  }
  assert.match(planned.toast, /Delegated 2 contracts\. They stay in progress until you attest them\./);
});

test("payment and mixed-currency objectives stay one paused contract", () => {
  const money = mod.planDelegation("pay the $20 invoice and reformat the csv export", "chief", "chief", null, bots);
  assert.equal(money.ok, true);
  assert.equal(money.plans.length, 1);
  assert.equal(money.plans[0].status, "friction_challenged");
  assert.match(money.toast, /Delegated 1 contract\. 1 need a decision before they run\./);

  const currencies = mod.planDelegation("compare usd and inr totals", "chief", "chief", null, bots);
  assert.equal(currencies.ok, true);
  assert.equal(currencies.plans.length, 1);
  assert.equal(currencies.plans[0].status, "friction_challenged");
});

test("only the chief can delegate across the workspace", () => {
  const blocked = mod.planDelegation("Patch the webhook bug", "auditor", "chief", null, bots);
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /Only the chief/);
  const missing = mod.planDelegation("Patch the webhook bug", "chief", "", null, bots);
  assert.equal(missing.ok, false);
  assert.match(missing.error, /Appoint a chief/);
});

test("an empty account label becomes unassigned", () => {
  const bare = bot("bare", "@bare", "reviews webhook bugs", "", {
    primaryAccountId: "",
    longContextAccountId: "",
    fallbackAccountId: "",
  });
  const planned = mod.planDelegation("Patch the webhook bug", "chief", "chief", null, [chief, bare]);
  assert.equal(planned.ok, true);
  assert.equal(planned.plans[0].assigneeId, "bare");
  assert.equal(planned.plans[0].routedEndpoint, "unassigned");
});

test("phone routing, the owner allowlist, and callbacks stay closed", () => {
  const scoped = mod.routeMobile("#ops Patch the webhook bug", "chief", [group], bots);
  assert.equal(scoped.ok, true);
  assert.equal(scoped.route.issuerId, "writer");
  assert.equal(scoped.route.groupId, "grp");
  assert.equal(scoped.route.objective, "Patch the webhook bug");

  const global = mod.routeMobile("/chief Audit the payroll ledger", "chief", [group], bots);
  assert.equal(global.ok, true);
  assert.equal(global.route.issuerId, "chief");
  assert.equal(global.route.groupId, "");

  const none = mod.routeMobile("Audit the payroll ledger", "", [group], bots);
  assert.equal(none.ok, false);

  assert.equal(
    mod.authorizeMobile(false, "telegram", "owner", "owner"),
    "BLOCKED: Messaging channel 'telegram' is not connected. Connect it first.",
  );
  assert.equal(
    mod.authorizeMobile(true, "telegram", "  ", "owner"),
    "BLOCKED: This channel has no allowlisted owner. Connect it again and set an owner id.",
  );
  assert.equal(
    mod.authorizeMobile(true, "telegram", "owner", "intruder"),
    "UNAUTHORIZED: Sender ID does not match the allowlisted owner.",
  );
  assert.equal(mod.authorizeMobile(true, "telegram", " owner ", "owner"), null);

  assert.deepEqual(mod.parseCallback("attest:ctr_1"), { ok: true, kind: "attest", id: "ctr_1" });
  const resolved = mod.parseCallback("resolve:ctr_1:use the spot rate");
  assert.equal(resolved.ok, true);
  assert.equal(resolved.kind, "resolve");
  assert.match(mod.parseCallback("approve_tx_901").error, /not a delegation/);
  assert.equal(mod.parseCallback("resolve:ctr_1:short").ok, false);

  assert.equal(mod.inboundChiefAction("hello from the phone"), null);
  assert.deepEqual(mod.inboundChiefAction("/chief Patch the webhook bug"), {
    text: "/chief Patch the webhook bug",
    callback: "",
  });
  assert.deepEqual(mod.inboundChiefAction("[button_tap:attest:ctr_1]"), { text: "", callback: "attest:ctr_1" });
});

test("the commitment is SHA-256 and the card does not claim a proof or a passing test", () => {
  assert.equal(mod.sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(mod.sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  const commitment = mod.executionCommitment("ctr_1", "Patch the webhook bug", ["read:assigned_subgoal", "deny:wallet_spend"]);
  assert.match(commitment, /^commit_sha256:[0-9a-f]{64}$/);
  assert.equal(
    commitment,
    mod.executionCommitment("ctr_1", "Patch the webhook bug", ["read:assigned_subgoal", "deny:wallet_spend"]),
  );

  const card = mod.executiveCard("@chief", "GLOBAL", "Patch the webhook bug", [{
    issuerHandle: "@chief",
    assigneeHandle: "@auditor",
    subGoal: "Patch the webhook bug",
    status: "in_progress",
    costTier: "balanced",
    routedEndpoint: "prov_main",
    commitment,
    frictionReason: "",
    scopes: ["read:assigned_subgoal", "deny:wallet_spend"],
  }]);
  assert.match(card, /^RONIC OS — Executive report/);
  assert.match(card, /1 in progress, 0 waiting on you/);
  assert.equal(card.toLowerCase().includes("tests passed"), false);
  assert.equal(card.toLowerCase().includes("zkp"), false);
  assert.equal(card.toLowerCase().includes("zk-snark"), false);
});
