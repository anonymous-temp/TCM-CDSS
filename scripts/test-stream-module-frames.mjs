import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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

const clientSource = readFileSync(new URL("../src/app/diagnosis/DiagnosisClient.tsx", import.meta.url), "utf8");
assert.match(clientSource, /data-testid="streaming-module-drafts"/, "页面必须有独立模块草稿容器");
assert.match(clientSource, /data-testid=\{`streaming-module-\$\{draft\.module\}`\}/, "每个模块必须有稳定测试标识");
assert.match(clientSource, /M03_DRAFT_MODULES\.flatMap\(/, "模块卡必须按共享临床顺序渲染");
assert.match(clientSource, /onModuleDraft:\s*\(frame\)/, "M03 客户端必须消费独立模块帧");
assert.match(clientSource, /setModuleDrafts\(\{\}\)/, "开始、结束与取消路径必须能清空请求级草稿");
assert.match(clientSource, /生成中 · 未定稿/, "模块卡必须明确标注未定稿");
assert.doesNotMatch(clientSource, /saveCase\([^)]*moduleDrafts/, "模块草稿不得进入病例持久化");
assert.doesNotMatch(clientSource, /caseState\s*:\s*\{[^}]*moduleDrafts/s, "模块草稿不得混入 CaseState 或快照请求体");

const apiSource = readFileSync(new URL("../src/lib/diagnosis-api.ts", import.meta.url), "utf8");
const prefixIndex = apiSource.indexOf("enqueueClient(opts.initialVisiblePrefix)");
const progressIndex = apiSource.indexOf("enqueueClient(progressMessages[0])");
assert.ok(prefixIndex >= 0, "流式选项必须支持服务器确定性首屏前缀");
assert.ok(progressIndex >= 0 && prefixIndex < progressIndex, "安全横幅必须在第一条进度或模块状态之前入流");

const routeSource = readFileSync(new URL("../src/app/api/diagnosis/diagnose/route.ts", import.meta.url), "utf8");
assert.match(routeSource, /initialVisiblePrefix:\s*initialSafetyBanner/, "M03 路由必须把确定性安全横幅传入首屏通道");
assert.match(routeSource, /return initialSafetyBanner \? `\$\{initialSafetyBanner\}\$\{sanitized\}` : sanitized/, "终稿必须复用同一横幅，不能另算一份发生漂移");

console.log(JSON.stringify({
  suite: "stream-module-frames",
  modules: M03_DRAFT_MODULES.length,
  failures: 0,
}));
