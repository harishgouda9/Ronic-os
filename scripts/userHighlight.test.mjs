import assert from "node:assert/strict";
import test from "node:test";
import { faceHue, lightUserHighlight } from "../src/ui/userHighlight.ts";

test("a profile color becomes a light wash of itself", () => {
  assert.deepEqual(lightUserHighlight("#dc2626", "spidy"), { bg: "#fae1e1", border: "#f4baba" });
  assert.deepEqual(lightUserHighlight("#16a34a", "spidy"), { bg: "#def2e6", border: "#b4e2c5" });
  assert.deepEqual(lightUserHighlight("#2563eb", "spidy"), { bg: "#e0e9fc", border: "#b9cdf9" });
  assert.deepEqual(lightUserHighlight("#000000", "spidy"), { bg: "#dbdbdb", border: "#adadad" });
});

test("no saved color follows the face hue for that bot", () => {
  assert.equal(faceHue("a"), 97);
  assert.deepEqual(lightUserHighlight("", "a"), { bg: "hsl(97 75% 90%)", border: "hsl(97 48% 78%)" });
  assert.notEqual(lightUserHighlight("", "a").bg, lightUserHighlight("", "spidy").bg);
});
