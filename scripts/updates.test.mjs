import assert from "node:assert/strict";
import test from "node:test";
import { compareVersions, feedAddress, parseFeed, pickUpdate, shouldNotify } from "../src/updates/feed.ts";

const installed = "2.1.4";

test("compareVersions orders numeric segments", () => {
  assert.equal(compareVersions("2.1.4", "2.1.4"), 0);
  assert.equal(compareVersions("v2.1.4", "2.1.4"), 0);
  assert.equal(compareVersions("2.1.10", "2.1.4"), 1);
  assert.equal(compareVersions("2.1.4", "2.2.0"), -1);
  assert.equal(compareVersions("latest", "2.1.4"), 0);
});

test("a newer stable release is available and keeps its changes", () => {
  const status = pickUpdate(installed, "stable", [
    { name: "Feed address", text: null },
    {
      name: "This build",
      text: JSON.stringify({
        version: "2.2.0",
        channel: "stable",
        published: "2026-11-01",
        summary: "Notes for the next build",
        downloadUrl: "http://example.test/setup.exe",
        changes: [
          { kind: "feature", title: "Update", detail: "Settings lists what changed." },
          { kind: "fix", title: "Gate", detail: "A spend check stays local." },
        ],
      }),
    },
  ]);
  assert.equal(status.available?.version, "2.2.0");
  assert.equal(status.available?.downloadUrl, "");
  assert.equal(status.available?.changes[0].kind, "feature");
  assert.equal(status.current, null);
  assert.equal(shouldNotify(status, [], false), true);
  assert.equal(shouldNotify(status, ["2.2.0"], false), false);
  assert.equal(shouldNotify(status, ["2.2.0"], true), true);
});

test("the same version is the current build and does not count as available", () => {
  const status = pickUpdate(installed, "stable", [
    {
      name: "This build",
      text: JSON.stringify({
        version: "2.1.4",
        summary: "Settings includes Update.",
        changes: [{ kind: "feature", title: "Update", detail: "Read the notes." }],
      }),
    },
  ]);
  assert.equal(status.available, null);
  assert.equal(status.current?.version, "2.1.4");
  assert.equal(status.current?.channel, "any");
  assert.equal(shouldNotify(status, [], false), true);
  assert.equal(shouldNotify(status, ["2.1.4"], false), false);
  assert.equal(shouldNotify(status, ["2.1.4"], true), false);
});

test("a nightly release stays off the stable channel", () => {
  const status = pickUpdate(installed, "stable", [
    { name: "This build", text: JSON.stringify({ version: "2.3.0", channel: "nightly", summary: "Nightly" }) },
  ]);
  assert.equal(status.available, null);
  assert.equal(status.history.length, 0);
});

test("a tauri notes manifest becomes one change", () => {
  const releases = parseFeed(JSON.stringify({ version: "2.2.1", notes: "Signed Windows build.", pub_date: "2026-11-01T00:00:00Z" }), "Feed address");
  assert.equal(releases?.length, 1);
  assert.equal(releases?.[0].changes[0].detail, "Signed Windows build.");
  assert.equal(releases?.[0].published, "2026-11-01T00:00:00Z");
});

test("invalid JSON is rejected and an https address is required", () => {
  assert.equal(parseFeed("{", "This build"), null);
  const status = pickUpdate(installed, "stable", [{ name: "Local release file", text: "not json" }]);
  assert.deepEqual(status.errors, ["Local release file is not a release file."]);
  assert.equal(feedAddress("http://example.test/feed.json").error, "The feed address has to start with https://.");
  assert.equal(feedAddress("https://example.test/feed.json").url, "https://example.test/feed.json");
});

test("the newer of two sources wins and the local file beats an older bundled copy", () => {
  const status = pickUpdate(installed, "stable", [
    { name: "Feed address", text: JSON.stringify({ version: "2.1.5", channel: "stable", summary: "Remote" }) },
    { name: "Local release file", text: JSON.stringify({ version: "2.4.0", channel: "stable", summary: "Local" }) },
    { name: "This build", text: JSON.stringify({ version: "2.1.4", channel: "stable", summary: "Bundled" }) },
  ]);
  assert.equal(status.available?.version, "2.4.0");
  assert.equal(status.available?.source, "Local release file");
  assert.equal(status.current?.source, "This build");
});
