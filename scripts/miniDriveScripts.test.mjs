// Gate for the mini-computer drive scripts: the Rust format! builders must
// emit syntactically valid JavaScript. Two real failures shipped: an unclosed
// `new Promise(` (every eval died with "the page did not answer") and, once
// promises were used, this WebView2 runtime serialized the Promise as {} and
// every read died with "missing field url". Scripts must be plain sync IIFEs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const src = readFileSync(join(root, "src-tauri", "src", "computer_subsystem.rs"), "utf8");

function rawString(constName) {
  const marker = `const ${constName}: &str = r#"`;
  const start = src.indexOf(marker) + marker.length;
  return src.slice(start, src.indexOf('"#;', start));
}

// Applies the same substitutions Rust's format! would, given literal slots.
function build(fnName, slots) {
  const fnStart = src.indexOf(`fn ${fnName}`);
  assert.ok(fnStart > 0, `fn ${fnName} exists`);
  const rawStart = src.indexOf('r#"(function()', fnStart);
  let js = src.slice(rawStart + 3, src.indexOf('"#', rawStart));
  js = js.replace(/\{MINI_COLLECT_FN\}/g, rawString("MINI_COLLECT_FN"));
  for (const [key, value] of Object.entries(slots)) {
    js = js.replaceAll(`{${key}}`, value);
  }
  return js.replaceAll("{{", "{").replaceAll("}}", "}");
}

test("generated mini-computer drive scripts parse as plain sync JavaScript", () => {
  const scripts = {
    collect: build("mini_collect_js", {}),
    click: build("mini_click_js", { index: "2" }),
    type: build("mini_type_js", { index: "4", encoded: '"ronic-release"' }),
    smartClick: build("mini_smart_click_js", { encoded: '"add to cart"' }),
    scroll: build("mini_scroll_js", { sign: "1" }),
    find: build("mini_find_js", { encoded: '"add to cart"' }),
  };
  for (const [name, js] of Object.entries(scripts)) {
    assert.doesNotThrow(() => new Function(js), `${name} script must be valid JavaScript`);
    assert.match(js, /\(function\(\)\{/, `${name} script is an IIFE`);
    assert.ok(!js.includes("new Promise"), `${name} script must not return a promise (WebView2 serializes it as {})`);
  }
  assert.match(scripts.smartClick, /__ronicScore/, "smart click scores matches");
  assert.match(scripts.smartClick, /scrollIntoView/, "smart click scrolls the target into view");
  assert.match(scripts.click, /__ronicControls\(\)/, "click uses the visibility-filtered control list");
  assert.match(scripts.find, /hits\.length < 15/, "find caps its hits");
});

test("collector exposes media state so playback is verifiable", () => {
  const collect = rawString("MINI_COLLECT_FN");
  // The collector declares several helpers, so execute then call it.
  assert.doesNotThrow(() => new Function(`${collect}; return __ronicCollect();`));
  assert.match(collect, /querySelector\("video"\)/);
  assert.match(collect, /video\.paused/);
  assert.match(collect, /__ronicControls/, "controls pass through the visibility filter");
  assert.match(collect, /type === "hidden"/, "hidden inputs are dropped");
  assert.match(collect, /type === "file"/, "file inputs are dropped");
});
