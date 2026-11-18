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

test("project list upserts, pins, sorts, and removes projects", () => {
  let list = mod.upsertProject([], "C:\\Work\\Alpha", 100);
  list = mod.upsertProject(list, "C:\\Work\\Beta\\", 200);
  assert.equal(list.length, 2);
  assert.equal(list[0].name, "Beta");
  list = mod.togglePinProject(list, "c:\\work\\alpha");
  assert.equal(list[0].name, "Alpha");
  assert.equal(list[0].pinned, true);
  list = mod.removeProject(list, "C:\\Work\\Beta");
  assert.equal(list.length, 1);
  assert.equal(list[0].name, "Alpha");
});

test("coding sessions append turns, derive title, summarize history, rename, and delete", () => {
  const s = mod.createSession("C:\\Work\\Alpha", "gemini", undefined, 1000);
  let sessions = [s];
  sessions = mod.appendTurn(
    sessions,
    s.id,
    {
      id: "t1",
      prompt: "Inspect skills and fix build",
      output: "Checked 12 skills and fixed build.",
      agent: "gemini",
      exitCode: 0,
      createdAt: 1001,
      durationMs: 1200,
      attachedFiles: ["src/app.ts"],
      selectedSkills: ["gravitas"],
      changedFiles: ["src/app.ts"],
    },
    1002,
  );
  assert.equal(sessions[0].title, "Inspect skills and fix build");
  assert.equal(sessions[0].turns.length, 1);
  const summary = mod.buildHistorySummary(sessions[0], 3);
  assert.match(summary, /Inspect skills and fix build/);
  assert.match(summary, /Checked 12 skills/);
  sessions = mod.renameSession(sessions, s.id, "Build Fix");
  assert.equal(sessions[0].title, "Build Fix");
  sessions = mod.deleteSession(sessions, s.id);
  assert.equal(sessions.length, 0);
});

test("draggable layout clamps bounds and reorders panes safely", () => {
  const clamped = mod.clampLayout({
    leftWidth: 9999,
    rightWidth: 10,
    terminalHeight: -5,
    leftTopRatio: 0.99,
    centerSplitRatio: 0.01,
    centerMode: "split",
    paneOrder: ["capabilities", "explorer"],
  });
  assert.equal(clamped.leftWidth, 520);
  assert.equal(clamped.rightWidth, 230);
  assert.equal(clamped.terminalHeight, 110);
  assert.equal(clamped.leftTopRatio, 0.8);
  assert.equal(clamped.centerSplitRatio, 0.25);
  assert.deepEqual(clamped.paneOrder, ["capabilities", "explorer", "workspace"]);
  assert.deepEqual(
    mod.reorderPanes(["explorer", "workspace", "capabilities"], "capabilities", "explorer"),
    ["capabilities", "explorer", "workspace"],
  );
});

test("tree, file content, sync report, and dispatch envelope parse cleanly", () => {
  const tree = mod.treeFromPayload({
    entries: [{ name: "src", path: "src", isDir: true, size: 0 }, { bad: true }],
  });
  assert.equal(tree.length, 1);
  assert.equal(tree[0].isDir, true);

  const fileObj = mod.fileContentFromPayload({
    path: "src/index.ts",
    content: "export {};\n",
    size: 11,
    lines: 1,
    binary: false,
    truncated: false,
  });
  assert.equal(fileObj.path, "src/index.ts");

  const sync = mod.syncReportFromPayload({
    sync: {
      agent: "gemini",
      bridgeOnline: true,
      bridgeEndpoint: "http://127.0.0.1:47331/mcp",
      contextFile: "C:\\Users\\u\\.ronicos\\coding-context.md",
      configTargets: ["Gemini CLI"],
      syncedServers: ["ronic-os"],
      skillsCount: 5,
      pluginsCount: 2,
      mcpCount: 3,
      memoryCount: 4,
      warnings: [],
      syncedAt: 123,
    },
  });
  assert.equal(sync.agent, "gemini");
  assert.equal(sync.bridgeOnline, true);
  assert.equal(sync.skillsCount, 5);

  const env = JSON.parse(
    mod.buildDispatchEnvelope({
      text: "run tests",
      injectContext: true,
      autoApprove: true,
      fastContext: true,
      model: "gemini-3.8-flash-low",
      effort: "low",
      historySummary: "prev",
      attachedFiles: ["a.ts"],
      selectedSkills: ["gravitas"],
    }),
  );
  assert.equal(env.__ronicDispatch, true);
  assert.equal(env.autoApprove, true);
  assert.equal(env.fastContext, true);
  assert.equal(env.model, "gemini-3.8-flash-low");
  assert.equal(env.effort, "low");
  assert.deepEqual(env.selectedSkills, ["gravitas"]);
});

test("model parsing, deduplication, and interactive CLI command include model and effort flags", () => {
  const parsed = mod.modelsFromPayload({
    models: [
      { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)", tier: "fast", source: "cli" },
      { id: "" },
    ],
  });
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].tier, "fast");

  const merged = mod.mergeModelOptions(
    parsed,
    [{ id: "gemini-3.8-flash-low", label: "dup", tier: "fast", source: "connected" }, { id: "o4-mini", label: "o4-mini", tier: "fast", source: "connected" }],
    ["custom-fast-v1"],
  );
  assert.deepEqual(merged.map((m) => m.id), ["gemini-3.8-flash-low", "custom-fast-v1", "o4-mini"]);

  const agyCmd = mod.interactiveCliCommand({
    agent: "gemini",
    agentPath: "C:\\Users\\haris\\.gemini\\bin\\agy.exe",
    projectRoot: "C:\\Work\\App",
    model: "gemini-3.8-flash-low",
    effort: "low",
    isWin: true,
  });
  assert.match(agyCmd, /--model gemini-3\.8-flash-low/);
  assert.match(agyCmd, /--effort low/);

  const codexCmd = mod.interactiveCliCommand({
    agent: "codex",
    agentPath: "codex",
    projectRoot: "/work/app",
    model: "o4-mini",
    effort: "low",
    isWin: false,
  });
  assert.match(codexCmd, /-m o4-mini/);
  assert.ok(!codexCmd.includes("--effort"));
});
