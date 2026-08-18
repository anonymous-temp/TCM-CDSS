import assert from "node:assert/strict";

import {
  M03_DRAFT_MODULES,
  STREAM_REPLACE_MARKER,
  parseStreamModuleDraftFrame,
} from "../src/lib/diagnosis-stream-protocol.ts";
import { consumeMarkdownStreamWithMetadata } from "../src/lib/diagnosis-engine.ts";

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

function ndjsonResponse(frames) {
  return new Response(`${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`, {
    headers: { "content-type": "application/x-ndjson" },
  });
}

const receivedModules = [];
const streamed = await consumeMarkdownStreamWithMetadata(ndjsonResponse([
  valid,
  { content: "正在生成" },
  { content: `${STREAM_REPLACE_MARKER}最终签名报告` },
  { content: "[END]" },
]), () => undefined, {
  onModuleDraft: (frame) => receivedModules.push(frame),
});
assert.equal(receivedModules.length, 1, "模块帧必须通过独立回调送达");
assert.equal(receivedModules[0].module, "m03.western");
assert.equal(streamed.content, "最终签名报告", "模块草稿不得污染最终 content");
assert.ok(!streamed.content.includes("生成中"));

for (const malformedModuleFrame of [
  { type: "module_draft", module: "m04.formula", revision: 1, content: "非法模块" },
  { type: "module_draft", module: "m03.western", revision: 0, content: "非法版本" },
  { type: "module_draft", module: "m03.western", revision: 1, content: "" },
]) {
  await assert.rejects(
    () => consumeMarkdownStreamWithMetadata(ndjsonResponse([
      malformedModuleFrame,
      { content: "最终签名报告" },
      { content: "[END]" },
    ]), () => undefined),
    /模型流格式异常/,
  );
}

console.log(JSON.stringify({
  suite: "stream-module-frames",
  modules: M03_DRAFT_MODULES.length,
  failures: 0,
}));
