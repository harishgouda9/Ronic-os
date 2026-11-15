import assert from "node:assert/strict";
import test from "node:test";
import { downloads, primaryDownload } from "../src/site/downloads.ts";

test("the download button matches the visitor's computer", () => {
  assert.equal(primaryDownload("Mozilla/5.0 (Windows NT 10.0)").id, "windows");
  assert.equal(primaryDownload("Mozilla/5.0 (Macintosh; Intel Mac OS X)").id, "mac");
  assert.equal(primaryDownload("Mozilla/5.0 (X11; Linux x86_64)").id, "linux");
  assert.equal(primaryDownload("Mozilla/5.0 (Linux; Android 14)").id, "windows");
  assert.match(primaryDownload("").href, /Ronic\.OS_2\.2\.0_x64-setup\.exe$/);
  assert.equal(downloads.length, 5);
});
