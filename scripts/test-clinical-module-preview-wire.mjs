import assert from "node:assert/strict";
import { createJiti } from "jiti";

// Synthetic provider traffic only: every fetch below is intercepted.
process.env.AI_TEXT_PROVIDER = "bailian-qwen";
process.env.BAILIAN_QWEN_API_KEY = "test-only-not-a-secret";
process.env.BAILIAN_QWEN_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
process.env.BAILIAN_QWEN_MODEL = "qwen3.7-plus";
process.env.PRIMARY_PRESCRIBE_MODEL = "qwen3.7-plus";
const jiti = createJiti(import.meta.url, { alias: {
  "@": `${process.cwd()}/src`,
  "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
} });
const { callDiagnosisStream } = await jiti.import("../src/lib/diagnosis-api.ts");
const encoder = new TextEncoder();
const candidate = { name: "四君子汤", herbs: [{ name: "党参", processing: null, dose: "12g", role: "君",
  targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, isToxic: false, function: "益气健脾",
}], decoction: { doseCount: "5剂", dosesPerDay: 1, administrationTimesPerDay: 2, method: "水煎服", followUpNode: "复诊" } };
const partial = '{"candidate":' + JSON.stringify(candidate) + ',"nonPharma":{';
const originalFetch = globalThis.fetch;
const abort = new AbortController();
let fetches = 0;
let wireRequest;
let upstream;
let reader;
let timeout;
try {
  globalThis.fetch = async (_url, init) => {
    fetches += 1;
    wireRequest = JSON.parse(init.body);
    return new Response(new ReadableStream({
      start(controller) {
        upstream = controller;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: partial } }] })}\n\n`));
        // Intentionally leave the remaining nonPharma and provider DONE pending.
      },
    }), { headers: { "content-type": "text/event-stream" } });
  };
  const response = await callDiagnosisStream("synthetic preview fixture", "deepseek", undefined, "markdown", {
    structuredStage: "prescribe", requestSignal: abort.signal,
  });
  reader = response.body.getReader();
  const observed = [];
  const readPreview = async () => {
    let buffer = "";
    while (true) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false, "预览必须在响应关闭前到达");
      buffer += new TextDecoder().decode(chunk.value);
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines.filter(Boolean)) {
        const frame = JSON.parse(line);
        observed.push(frame);
        if (frame.type === "module_draft") return frame;
      }
    }
  };
  const preview = await Promise.race([readPreview(), new Promise((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error("未在 nonPharma 完成前收到实际 M04 proposal 草稿")), 2500);
  })]);
  assert.equal(preview.module, "m04.candidate");
  assert.match(preview.content, /四君子汤/);
  assert.match(preview.content, /益气健脾/);
  assert.doesNotMatch(preview.content, /12g|5剂|targetRef/);
  assert.equal(fetches, 1, "只读预览不得新增模型调用");
  assert.ok(wireRequest.response_format.json_schema.schema.properties.candidate, "测试必须走实际 m04_proposal 格式");
  assert.ok(!observed.some((frame) => frame.content?.includes("<<<CDSS_STREAM_FINAL>>>") || frame.content === "[END]"));
} finally {
  clearTimeout(timeout);
  abort.abort();
  await reader?.cancel().catch(() => {});
  try { upstream?.close(); } catch { /* consumer cancellation may already close the mock */ }
  globalThis.fetch = originalFetch;
}
console.log(JSON.stringify({ suite: "clinical-module-preview-wire", failures: 0 }));
