import assert from "node:assert/strict";
import test from "node:test";
import { siteRedirect } from "../src/site/account.ts";
import { doorStatus, MCP_URL, toolNames } from "../src/site/door.ts";
import { downloads, primaryDownload } from "../src/site/downloads.ts";

test("the download button matches the visitor's computer", () => {
  assert.equal(primaryDownload("Mozilla/5.0 (Windows NT 10.0)").id, "windows");
  assert.equal(primaryDownload("Mozilla/5.0 (Macintosh; Intel Mac OS X)").id, "mac");
  assert.equal(primaryDownload("Mozilla/5.0 (X11; Linux x86_64)").id, "linux");
  assert.equal(primaryDownload("Mozilla/5.0 (Linux; Android 14)").id, "windows");
  assert.match(primaryDownload("").href, /Ronic\.OS_2\.2\.0_x64-setup\.exe$/);
  assert.equal(downloads.length, 5);
});

test("site sign-in returns to this website", () => {
  assert.equal(siteRedirect("https://ronicos.vercel.app/pricing?code=1", "https://ronicos.vercel.app"), "https://ronicos.vercel.app/pricing");
  assert.equal(siteRedirect("https://evil.test/steal", "https://ronicos.vercel.app"), "https://ronicos.vercel.app");
  assert.equal(siteRedirect("", "https://ronicos.vercel.app"), "https://ronicos.vercel.app");
});

test("the site reads the MCP door's real reply", () => {
  assert.equal(MCP_URL, "https://ronicos.vercel.app/mcp");
  assert.deepEqual(doorStatus(503, '{"error":"door is not configured"}'), { ok: false, detail: "door is not configured" });
  assert.deepEqual(doorStatus(200, '{"result":{"serverInfo":{"name":"ronic","version":"2"}}}'), { ok: true, detail: "ronic 2" });
  assert.deepEqual(doorStatus(200, 'event: message\ndata: {"result":{"serverInfo":{"name":"ronic","version":"2"}}}\n'), { ok: true, detail: "ronic 2" });
  assert.deepEqual(doorStatus(200, '{"error":{"message":"session required"}}'), { ok: false, detail: "session required" });
  assert.deepEqual(doorStatus(404, "<!doctype html><html></html>"), { ok: false, detail: "The door answered HTTP 404." });
  assert.deepEqual(toolNames('data: {"result":{"tools":[{"name":"read_file"},{"name":""},{"name":"list_files"}]}}\n'), ["read_file", "list_files"]);
});
