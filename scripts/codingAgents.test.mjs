import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const outDir = mkdtempSync(path.join(tmpdir(), "ronic-coding-"));

const compile = spawnSync(
  process.execPath,
  [path.join(root, "node_modules", "typescript", "bin", "tsc"), "--target", "ES2022", "--module", "ES2022", "--moduleResolution", "bundler", "--lib", "ES2022", "--strict", "--skipLibCheck", path.join(root, "src", "kernel", "codingAgents.ts"), "--outDir", outDir],
  { encoding: "utf8" },
);
assert.equal(compile.status, 0, compile.stdout + compile.stderr);

const mod = await import(pathToFileURL(path.join(outDir, "codingAgents.js")).href);
process.on("exit", () => rmSync(outDir, { recursive: true, force: true }));

const file = { path: "src/a.ts", additions: 1, deletions: 0, staged: false, diff: "+a" };

test("payload files drop blank rows and keep a real diff", () => {
  const files = mod.filesFromPayload({
    files: [{ path: "src/a.ts", additions: "2", deletions: 1, staged: 1, diff: "+x" }, { path: "" }, null, { nope: true }],
  });
  assert.equal(files.length, 1);
  assert.equal(files[0].path, "src/a.ts");
  assert.equal(files[0].additions, 2);
  assert.equal(files[0].staged, true);
  assert.equal(files[0].diff, "+x");
  assert.equal(mod.filesFromPayload(null), null);
  assert.equal(mod.filesFromPayload({ note: "no files" }), null);
});

test("an editor open that returns no files keeps the tree", () => {
  const kept = mod.filesAfterDispatch([file], { files: [] });
  assert.deepEqual(kept, [file]);
  const replaced = mod.filesAfterDispatch([file], { files: [], opened: true });
  assert.deepEqual(replaced, []);
  const finished = mod.filesAfterDispatch([file], { files: [], exitCode: 0 });
  assert.deepEqual(finished, []);
  const missing = mod.filesAfterDispatch([file], { output: "still running" });
  assert.deepEqual(missing, [file]);
});

test("refresh stays on the same path and clamps a short list", () => {
  const next = [{ ...file, path: "src/b.ts" }, file];
  assert.equal(mod.indexAfterRefresh([file], next, 0), 1);
  assert.equal(mod.indexAfterRefresh([file], [], 0), 0);
  assert.equal(mod.clampFileIndex(4, 2), 1);
});

test("the editor button prefers the selected installed app", () => {
  assert.equal(mod.ideToOpen("claude", { cursor: true, vscode: true }), "cursor");
  assert.equal(mod.ideToOpen("vscode", { cursor: true, vscode: false }), "cursor");
  assert.equal(mod.ideToOpen("claude", { cursor: false, vscode: true }), "vscode");
  assert.equal(mod.ideToOpen("vscode", { cursor: false, vscode: true }), "vscode");
  assert.equal(mod.dispatchOutput({ output: "done" }), "done");
  assert.equal(mod.dispatchOutput({}), "");
});
