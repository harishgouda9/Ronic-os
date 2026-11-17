// A chat model belongs to one bot. Picking it for a second bot takes it off the first.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const outDir = mkdtempSync(path.join(tmpdir(), "ronic-models-"));

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
    path.join(root, "src", "kernel", "modelPrefs.ts"),
    "--outDir", outDir,
  ],
  { encoding: "utf8" },
);
assert.equal(compile.status, 0, compile.stdout + compile.stderr);

const emitted = path.join(outDir, "kernel", "modelPrefs.js");
writeFileSync(emitted, readFileSync(emitted, "utf8").replace('from "./liveChat"', 'from "./liveChat.js"'));
const mod = await import(pathToFileURL(emitted).href);
process.on("exit", () => rmSync(outDir, { recursive: true, force: true }));

test("choosing a model takes it off the other bot", () => {
  const first = mod.claimModel({}, "bot_a", "prov_grok:grok-4");
  const second = mod.claimModel(first, "bot_b", "prov_grok:grok-4");
  assert.equal(second.bot_a, undefined);
  assert.equal(second.bot_b, "prov_grok:grok-4");
  assert.equal(mod.modelClaimedBy(second, "prov_grok:grok-4", "bot_b"), "");
  assert.equal(mod.modelClaimedBy(second, "prov_grok:grok-4", "bot_a"), "bot_b");
});

test("clearing one bot leaves the other bot's model", () => {
  const both = mod.claimModel(mod.claimModel({}, "bot_a", "prov_openai:gpt-4o"), "bot_b", "prov_anthropic:claude");
  const cleared = mod.claimModel(both, "bot_a", "");
  assert.equal(cleared.bot_a, undefined);
  assert.equal(cleared.bot_b, "prov_anthropic:claude");
});

test("two bots can keep two different models", () => {
  const both = mod.claimModel(mod.claimModel({}, "bot_a", "prov_openai:gpt-4o"), "bot_b", "prov_anthropic:claude");
  assert.equal(both.bot_a, "prov_openai:gpt-4o");
  assert.equal(both.bot_b, "prov_anthropic:claude");
});
