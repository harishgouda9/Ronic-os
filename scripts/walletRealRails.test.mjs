import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const outDir = mkdtempSync(path.join(tmpdir(), "ronic-wallet-test-"));

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
    path.join(root, "src", "kernel", "walletRails.ts"),
    "--outDir", outDir,
  ],
  { encoding: "utf8" }
);
assert.equal(compile.status, 0, compile.stdout + compile.stderr);

const targetFile = fs.readdirSync(outDir, { recursive: true }).find((f) => f.endsWith("walletRails.js"));
if (!targetFile) throw new Error("walletRails.js not generated: " + compile.stderr);

const mod = await import(pathToFileURL(path.join(outDir, targetFile)).href);
process.on("exit", () => rmSync(outDir, { recursive: true, force: true }));

const {
  CHAIN_META,
  validateWalletAddress,
  evaluatePolicyMovement,
  calculateBotSpendProgress,
} = mod;

test("CHAIN_META covers all 8 real production chains with proper currencies and rails", () => {
  const chains = ["base", "ethereum", "solana", "arbitrum", "polygon", "hyperliquid", "stripe", "razorpay"];
  for (const c of chains) {
    assert.ok(CHAIN_META[c], `Missing CHAIN_META for ${c}`);
    assert.ok(CHAIN_META[c].name.length > 0, `Missing name for ${c}`);
    assert.ok(CHAIN_META[c].currency.length > 0, `Missing currency for ${c}`);
    assert.ok(CHAIN_META[c].railKey.length > 0, `Missing railKey for ${c}`);
  }

  assert.equal(CHAIN_META.base.currency, "USDC");
  assert.equal(CHAIN_META.solana.currency, "SOL");
  assert.equal(CHAIN_META.razorpay.currency, "INR");
  assert.equal(CHAIN_META.hyperliquid.currency, "USDC");
});

test("validateWalletAddress checks format for EVM, Solana, and UPI rails", () => {
  assert.equal(validateWalletAddress("base", "0x847291a10F853B4A9C128d542A169cb4B63b45E0").valid, true);
  assert.equal(validateWalletAddress("base", "invalid_address").valid, false);

  assert.equal(validateWalletAddress("solana", "7EYnhQoR9YM3N7UoaKRoA44Uy8Jeaтус3UeU8KjB2jW").valid, true);
  assert.equal(validateWalletAddress("solana", "too_short").valid, false);

  assert.equal(validateWalletAddress("razorpay", "merchant@upi").valid, true);
  assert.equal(validateWalletAddress("razorpay", "plain_text_invalid").valid, false);
});

test("evaluatePolicyMovement halts spend when killswitch is engaged", () => {
  const policy = {
    maxPerTxUsd: 100,
    dailyCapUsd: 500,
    requireHumanApprovalAboveUsd: 15,
    killswitchEngaged: true,
  };

  // Bot spend should be rejected by killswitch
  assert.equal(evaluatePolicyMovement(policy, 10, 0, false), "rejected_killswitch");
  // User deposit should still be allowed through killswitch
  assert.equal(evaluatePolicyMovement(policy, 100, 0, true), "auto_signed");
});

test("evaluatePolicyMovement intercepts transactions above approval ceiling", () => {
  const policy = {
    maxPerTxUsd: 100,
    dailyCapUsd: 500,
    requireHumanApprovalAboveUsd: 15,
    killswitchEngaged: false,
  };

  assert.equal(evaluatePolicyMovement(policy, 10, 0, false), "auto_signed");
  assert.equal(evaluatePolicyMovement(policy, 25, 0, false), "pending_approval");
  assert.equal(evaluatePolicyMovement(policy, 50, 480, false), "rejected_daily_cap");
});

test("calculateBotSpendProgress computes percentage and alert status correctly", () => {
  const normal = calculateBotSpendProgress(25, 100);
  assert.equal(normal.pct, 25);
  assert.equal(normal.isOverBudget, false);
  assert.equal(normal.statusColor, "emerald");

  const warning = calculateBotSpendProgress(75, 100);
  assert.equal(warning.pct, 75);
  assert.equal(warning.statusColor, "amber");

  const breach = calculateBotSpendProgress(105, 100);
  assert.equal(breach.pct, 100);
  assert.equal(breach.isOverBudget, true);
  assert.equal(breach.statusColor, "rose");
});
