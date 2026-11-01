import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const outDir = mkdtempSync(path.join(tmpdir(), "ronic-chrome-"));

const compile = spawnSync(
  process.execPath,
  [path.join(root, "node_modules", "typescript", "bin", "tsc"), "--target", "ES2022", "--module", "ES2022", "--moduleResolution", "bundler", "--lib", "ES2022,DOM", "--strict", "--skipLibCheck", path.join(root, "src", "kernel", "workspaceChrome.ts"), "--outDir", outDir],
  { encoding: "utf8" },
);
assert.equal(compile.status, 0, compile.stdout + compile.stderr);

const mod = await import(pathToFileURL(path.join(outDir, "workspaceChrome.js")).href);

test("relative time uses minutes, hours, and days", () => {
  const now = Date.parse("2026-10-23T12:00:00Z");
  assert.equal(mod.ago(now - 30_000, now), "now");
  assert.equal(mod.ago(now - 29 * 60_000, now), "29m");
  assert.equal(mod.ago(now - 10 * 3_600_000, now), "10h");
  assert.equal(mod.ago(now - 7 * 86_400_000, now), "7d");
});

test("last line keeps the newest user or assistant message", () => {
  const line = mod.lastLine([
    { threadId: "a", role: "tool", actionType: "message", contentMarkdown: "skip", createdAt: 5 },
    { threadId: "a", role: "assistant", actionType: "thinking", contentMarkdown: "hidden", createdAt: 6 },
    { threadId: "a", role: "user", actionType: "message", contentMarkdown: "Hello\nthere", createdAt: 2 },
    { threadId: "b", role: "assistant", actionType: "message", contentMarkdown: "other", createdAt: 9 },
    { threadId: "a", role: "assistant", actionType: "message", contentMarkdown: "Yes. A real account already works", createdAt: 4 },
  ], ["a"]);
  assert.equal(line.text, "Yes. A real account already works");
  assert.equal(line.at, 4);
});

test("page addresses stay on https or local http", () => {
  assert.equal(mod.safePageUrl("http://127.0.0.1:3000/login"), "http://127.0.0.1:3000/login");
  assert.equal(mod.safePageUrl("localhost:3000/login"), "http://localhost:3000/login");
  assert.equal(mod.safePageUrl("https://example.com/app"), "https://example.com/app");
  assert.equal(mod.safePageUrl("http://example.com"), null);
  assert.equal(mod.safePageUrl("javascript:alert(1)"), null);
  assert.equal(mod.safePageUrl("file:///c:/windows"), null);
});

test("schedules wait until the next slot and then become due", () => {
  const every = mod.parseSchedule("every 15m");
  const saved = Date.parse("2026-10-23T12:00:00Z");
  assert.equal(mod.isDue(every, saved, 0, saved + 14 * 60_000), false);
  assert.equal(mod.isDue(every, saved, 0, saved + 15 * 60_000), true);
  assert.equal(mod.parseSchedule("Every day at 8:00 AM")?.label, "Every day at 8:00 AM");
  const daily = mod.parseSchedule("daily 08:00");
  const morning = Date.parse("2026-10-23T07:00:00");
  const slot = new Date(morning);
  slot.setHours(8, 0, 0, 0);
  assert.equal(mod.nextRun(daily, morning, 0, morning), slot.getTime());
  const afternoon = Date.parse("2026-10-23T09:00:00");
  const tomorrow = new Date(afternoon);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(8, 0, 0, 0);
  assert.equal(mod.nextRun(daily, afternoon, 0, afternoon), tomorrow.getTime());
  assert.equal(mod.parseSchedule("nope"), null);
});

test.after(() => {
  rmSync(outDir, { recursive: true, force: true });
});
