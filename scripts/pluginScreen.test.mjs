import assert from "node:assert/strict";
import test from "node:test";
import { keepDesktop, sidePlugins } from "../src/kernel/pluginScreen.ts";

test("webview, screen, and side bits become a side pane", () => {
  assert.deepEqual(keepDesktop([
    { kind: "webview", label: "Docs Canvas", target: "docs-canvas" },
    { kind: "side", label: " Notes ", target: "notes" },
    { kind: "Screen", label: "Board", target: "" },
    { kind: "mystery", label: "Skip", target: "x" },
    { kind: "pane", label: "  ", target: "empty" },
    { kind: "status", label: "Ready", target: "" },
  ]), [
    { kind: "pane", label: "Docs Canvas", target: "docs-canvas" },
    { kind: "pane", label: "Notes", target: "notes" },
    { kind: "pane", label: "Board", target: "" },
    { kind: "status", label: "Ready", target: "" },
  ]);
});

test("the rail lists a trusted plugin only after its desktop switch is on", () => {
  const plugin = {
    id: "plugin-docs-canvas",
    slug: "docs-canvas",
    name: "Docs Canvas",
    version: "1.2.0",
    source: "folder",
    sourcePath: "",
    trust: "trusted",
    hasAgent: true,
    hasDesktop: true,
    tools: [],
    hooks: [],
    bundledSkills: [],
    desktop: [{ kind: "pane", label: "Docs Canvas", target: "docs-canvas" }],
    agentEnables: [],
    desktopEnabled: false,
  };
  assert.equal(sidePlugins([plugin]).length, 0);
  assert.equal(sidePlugins([{ ...plugin, desktopEnabled: true }]).length, 1);
  assert.equal(sidePlugins([{ ...plugin, desktopEnabled: true, trust: "untrusted" }]).length, 0);
});
