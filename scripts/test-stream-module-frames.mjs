import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  M03_DRAFT_MODULES,
  STREAM_REPLACE_MARKER,
  parseStreamModuleDraftFrame,
} from "../src/lib/diagnosis-stream-protocol.ts";
import { consumeCollectStream, consumeMarkdownStreamWithMetadata } from "../src/lib/diagnosis-engine.ts";

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

// Transport cleanup cannot hold a completed contract, a timeout or a user cancellation hostage.
const unhandledCleanupRejections = [];
const onUnhandledCleanup = (reason) => unhandledCleanupRejections.push(reason);
process.on("unhandledRejection", onUnhandledCleanup);
try {
  for (const [consumerName, consume] of [["markdown", consumeMarkdownStreamWithMetadata], ["collect", consumeCollectStream]]) {
    for (const terminal of ["end", "timeout", "abort"]) {
      for (const cleanup of ["pending", "rejected"]) {
        const controller = new AbortController();
        const content = '完成报告\n<!-- DIAGNOSIS_JSON_START -->\n{"fixture":true}\n<!-- DIAGNOSIS_JSON_END -->';
        let cancelCalls = 0;
        const response = new Response(new ReadableStream({
          start(stream) {
            stream.enqueue(new TextEncoder().encode(JSON.stringify({ content }) + "\n"));
            if (terminal === "end") stream.enqueue(new TextEncoder().encode('{"content":"[END]"}\n'));
          },
          cancel() {
            cancelCalls += 1;
            return cleanup === "pending" ? new Promise(() => {}) : Promise.reject(new Error("synthetic cleanup rejected"));
          },
        }));
        let deadlineTimer;
        let abortTimer;
        try {
          const resultPromise = consume(response, () => {}, {
            idleTimeoutMs: terminal === "timeout" ? 10 : 1000,
            totalTimeoutMs: terminal === "timeout" ? 20 : 1000,
            abortSignal: controller.signal,
          }).then((value) => ({ value }), (error) => ({ error }));
          if (terminal === "abort") abortTimer = setTimeout(() => controller.abort(), 5);
          const result = await Promise.race([resultPromise, new Promise((resolve) => {
            deadlineTimer = setTimeout(() => resolve({ stuck: true }), 500);
          })]);
          assert.ok(!result.stuck, `${consumerName}/${terminal}/${cleanup}: transport cleanup must not block result delivery`);
          assert.equal(cancelCalls, 1);
          assert.equal(response.body.locked, false, "consumer must release its reader lock without waiting for cleanup");
          if (terminal === "end") {
            assert.equal(result.error, undefined);
            if (consumerName === "markdown") assert.equal(result.value.content, content);
            else assert.deepEqual(result.value.jsonData, { fixture: true });
          } else {
            assert.match(result.error?.message ?? "", terminal === "abort" ? /推理已取消/ : /模型流长时间无数据/);
          }
        } finally {
          clearTimeout(deadlineTimer);
          clearTimeout(abortTimer);
        }
      }
    }
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(unhandledCleanupRejections, [], "rejected transport cleanup must have a rejection handler");
} finally {
  process.off("unhandledRejection", onUnhandledCleanup);
}

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
assert.match(clientSource, /M04_DRAFT_MODULES\.flatMap\(/, "M04 候选也有只读模块卡");
assert.match(clientSource, /clinicalGenerationRef\.current === generation/, "旧请求不可更新新一轮的预览或终稿");
assert.match(clientSource, /activeRunAbortController === runController/, "旧控制器取消不能覆盖新请求");
assert.match(clientSource, /onFinalReplacement: clearModuleDrafts/, "最终替换应立即清空草稿");
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
