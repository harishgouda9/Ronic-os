import assert from "node:assert/strict";
import test from "node:test";
import { devLaunchDecision, isOurDevServer } from "./desktop.mjs";

test("isOurDevServer only accepts the Ronic OS page", () => {
  assert.equal(isOurDevServer("<title>Ronic OS</title>"), true);
  assert.equal(isOurDevServer("<title>Something else</title>"), false);
  assert.equal(isOurDevServer(""), false);
  assert.equal(isOurDevServer(undefined), false);
});

test("devLaunchDecision launches when the dev port is free", () => {
  assert.equal(devLaunchDecision({ portBusy: false, ours: false, appRunning: null }), "launch");
  assert.equal(devLaunchDecision({ portBusy: false, ours: false, appRunning: false }), "launch");
});

test("devLaunchDecision flags a stranded window when the server died but the exe lives", () => {
  assert.equal(devLaunchDecision({ portBusy: false, ours: false, appRunning: true }), "orphaned-window");
});

test("devLaunchDecision refuses a port held by another program", () => {
  assert.equal(devLaunchDecision({ portBusy: true, ours: false, appRunning: null }), "port-taken");
});

test("devLaunchDecision reuses the running desktop window instead of relaunching", () => {
  assert.equal(devLaunchDecision({ portBusy: true, ours: true, appRunning: true }), "already-running");
  assert.equal(devLaunchDecision({ portBusy: true, ours: true, appRunning: null }), "already-running");
});

test("devLaunchDecision names a stale dev server when the window is gone", () => {
  assert.equal(devLaunchDecision({ portBusy: true, ours: true, appRunning: false }), "stale-server");
});
