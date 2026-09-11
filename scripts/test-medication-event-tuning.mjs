import assert from "node:assert/strict";
import { test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { extractMedicationEventsWithModel } = await jiti.import("../src/lib/medication-event-extractor.ts");
const medicationHistory = "目前服用华法林3mg每日一次";
for (const [model, provider, endpoint] of [
  ["deepseek-flash", "openai-compatible", "https://api.deepseek.com"],
  ["qwen3.7-plus", "bailian-qwen", "https://dashscope.aliyuncs.com/compatible-mode/v1"],
]) {
  test(`${model} medication extraction and repair send explicit non-thinking tuning`, async () => {
    const overrides = { AI_TEXT_PROVIDER: provider, OPENAI_API_KEY: "synthetic-text-key", OPENAI_MODEL: model,
      OPENAI_BASE_URL: endpoint, BAILIAN_QWEN_API_KEY: "synthetic-qwen-key", BAILIAN_QWEN_MODEL: model,
      BAILIAN_QWEN_BASE_URL: endpoint };
    const saved = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
    const originalFetch = globalThis.fetch;
    const requests = [];
    Object.assign(process.env, overrides);
    globalThis.fetch = async (_input, init) => {
      requests.push(JSON.parse(init.body));
      return Response.json({ choices: [{ message: { content: requests.length === 1 ? "{}" : JSON.stringify({
        events: [{ drugName: "华法林", status: "current", doseText: "3mg", frequency: "每日一次",
          sourceQuotes: [medicationHistory], confidence: 0.99 }], unresolvedReferences: [],
      }) }, finish_reason: "stop" }] });
    };
    try {
      const result = await extractMedicationEventsWithModel(medicationHistory);
      assert.equal(result.source, "model");
      assert.equal(result.needsManualReview, false);
      assert.equal(requests.length, 2, "invalid schema still receives exactly one application-owned repair");
      for (const request of requests) {
        assert.equal(request.model, model);
        assert.deepEqual(request.response_format, { type: "json_object" });
        if (model.startsWith("deepseek")) {
          assert.deepEqual(request.thinking, { type: "disabled" });
          assert.equal(request.reasoning_effort, "low");
        } else {
          assert.equal(request.enable_thinking, false);
          assert.equal(request.thinking, undefined);
        }
      }
    } finally {
      globalThis.fetch = originalFetch;
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });
}
