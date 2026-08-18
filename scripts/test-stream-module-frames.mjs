import assert from "node:assert/strict";

import {
  M03_DRAFT_MODULES,
  parseStreamModuleDraftFrame,
} from "../src/lib/diagnosis-stream-protocol.ts";

assert.deepEqual(M03_DRAFT_MODULES, [
  "m03.western",
  "m03.syndrome",
  "m03.pathogenesis",
  "m03.therapy",
]);

const valid = parseStreamModuleDraftFrame({
  type: "module_draft",
  module: "m03.western",
  revision: 1,
  content: "## 西医判断\n**诊断倾向**：反酸",
});
assert.equal(valid?.module, "m03.western");
assert.equal(valid?.revision, 1);

for (const invalid of [
  { type: "module_draft", module: "m04.formula", revision: 1, content: "x" },
  { type: "module_draft", module: "m03.western", revision: 0, content: "x" },
  { type: "module_draft", module: "m03.western", revision: 1, content: "" },
  { type: "module_draft", module: "m03.western", revision: 1, content: "x".repeat(8_001) },
  { type: "heartbeat", module: "m03.western", revision: 1, content: "x" },
]) {
  assert.equal(parseStreamModuleDraftFrame(invalid), null);
}

console.log(JSON.stringify({
  suite: "stream-module-frames",
  modules: M03_DRAFT_MODULES.length,
  failures: 0,
}));
