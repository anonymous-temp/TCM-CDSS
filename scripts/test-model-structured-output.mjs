import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: {
  "@": `${process.cwd()}/src`,
  "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
} });
const { responseFormatForTask, supportsStrictJsonSchema } = await jiti.import("../src/lib/model-response-format.ts");
const { modelUsageSnapshot, parseOpenAICompatCompletionPayload } = await jiti.import("../src/lib/openai-compatible-response.ts");

function assertStrictObjects(value, path = "schema") {
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertStrictObjects(child, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  assert.notEqual(Object.keys(value).length, 0, `${path} must not contain an unconstrained empty schema`);
  if (Array.isArray(value.type) && value.type.includes("null") && Array.isArray(value.enum)) {
    assert.equal(value.enum.includes(null), true,
      `${path} declares nullable type but its enum still rejects null`);
  }
  if (value.properties && typeof value.properties === "object" && !Array.isArray(value.properties)) {
    assert.equal(value.additionalProperties, false, `${path} must reject unknown properties`);
    assert.deepEqual(new Set(value.required), new Set(Object.keys(value.properties)),
      `${path} must require every declared property for provider strict mode`);
  }
  for (const [key, child] of Object.entries(value)) assertStrictObjects(child, `${path}.${key}`);
}

// 2026-09-19 同请求体配对重放：qwen3.8-flash strict 下这些数组「可空或允许空」时 6 次里只有 0–2 次有内容
// （同时把证候/病位/病性写成 resolved），DeepSeek 6/6；加 minItems:1 后 9/9。只收紧下发给模型的 schema。
const M03_NON_EMPTY_PATHS = [
  ["overview", "primarySyndromeBasis"],
  ["overview", "tcmDiseaseDifferentials"],
  ["overview", "tcmDifferentials"],
  ["pathogenesis", "locationDifferentiation", "items"],
  ["pathogenesis", "locationDifferentiation", "details"],
  ["pathogenesis", "natureDifferentiation", "items"],
  ["pathogenesis", "uncertainties"],
  ["therapy", "subTherapies"],
];
const schemaNodeAt = (schema, path) => path.reduce((node, key) => node?.properties?.[key], schema);
for (const model of ["qwen3.7-plus", "qwen3.7-max", "qwen3.8-flash", "qwen3.8-max"]) {
  assert.equal(supportsStrictJsonSchema(model), true);
  for (const task of ["m03_full", "m03_western", "m03_tcm", "m04_proposal"]) {
    const format = responseFormatForTask(model, task);
    assert.equal(format.type, "json_schema", `${model}/${task} must use strict JSON Schema`);
    assert.equal(format.json_schema.strict, true);
    assert.equal(format.json_schema.name, task);
    assert.equal(format.json_schema.schema.type, "object");
    assertStrictObjects(format.json_schema.schema);
    if (task === "m03_full" || task === "m03_tcm") {
      assert.equal(
        format.json_schema.schema.properties.pathogenesis.properties.chain.minItems,
        1,
        `${model}/${task} must constrain generated M03 to a non-empty pathogenesis chain`,
      );
      for (const path of M03_NON_EMPTY_PATHS) {
        const node = schemaNodeAt(format.json_schema.schema, path);
        const label = `${model}/${task} ${path.join(".")}`;
        assert.equal(node?.minItems, 1, `${label} must be constrained to at least one generated item`);
        // 可空就能用 null 绕过 minItems——实测「必填不可空但无 minItems」仍 0/6，两条缺一不可。
        assert.equal(node?.type, "array", `${label} must not admit null`);
        assert.equal("default" in node, false, `${label} must not advertise an empty default`);
      }
    }
  }
}
{
  // 约束只在下发给模型的投影上：共享 zod 契约（签名、HIS、确定性兜底）照旧接受空数组。
  const { z } = await jiti.import("zod");
  const { ReasoningV2Schema } = await jiti.import("../src/lib/diagnosis-types.ts");
  const shared = z.toJSONSchema(ReasoningV2Schema, { unrepresentable: "any", reused: "ref" });
  for (const path of M03_NON_EMPTY_PATHS) {
    const node = schemaNodeAt(shared, path);
    assert.ok(node, `shared contract must still declare ${path.join(".")}`);
    assert.equal(node.minItems, undefined, `shared contract must not require ${path.join(".")} to be non-empty`);
  }
  // 西医半与 M04 实测本就 6/6 有内容，不收紧。
  for (const task of ["m03_western", "m04_proposal"]) {
    const serialized = JSON.stringify(responseFormatForTask("qwen3.8-flash", task));
    for (const key of ["primarySyndromeBasis", "tcmDifferentials", "uncertainties", "subTherapies"]) {
      assert.equal(serialized.includes(`"${key}"`), false, `${task} must not carry the TCM-half field ${key}`);
    }
  }
}
assert.deepEqual(responseFormatForTask("qwen3.7-flash", "m03_full"), { type: "json_object" });
assert.deepEqual(responseFormatForTask("deepseek-v4-flash", "m04_proposal"), { type: "json_object" });

const sse = [
  'data: {"choices":[{"delta":{"content":"{\\"ok\\":true}"},"finish_reason":"stop"}]}',
  'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20,"total_tokens":120,"prompt_tokens_details":{"cached_tokens":80}}}',
  "data: [DONE]",
  "",
].join("\n");
const parsed = parseOpenAICompatCompletionPayload(sse);
assert.equal(parsed.choices[0].message.content, '{"ok":true}');
assert.deepEqual(modelUsageSnapshot(parsed), {
  promptTokens: 100,
  completionTokens: 20,
  totalTokens: 120,
  cachedTokens: 80,
});

const diagnosisSource = readFileSync("src/lib/diagnosis-api.ts", "utf8");
assert.match(diagnosisSource, /stream_options:\s*\{\s*include_usage:\s*true\s*\}/);
assert.match(diagnosisSource, /enqueueHeartbeat\("模型已开始返回临床正文",\s*contentChars\s*\+\s*reasoningChars\)/,
  "provider first-content timing must be observable separately from server-owned banners");
assert.doesNotMatch(diagnosisSource, /\btool_choice\b|\bparallel_tool_calls\b/,
  "deterministic server retrieval must not be replaced by model-controlled tool calls");
// 2026-09-16：M03/M04 模型复核环节已移除，随之删除的还有复核器的 strict tool-call 取回。
// 结构化输出层与编排器现在都必须是零 tool 面：模型不控制任何检索或流程。
const responseFormatSource = readFileSync("src/lib/model-response-format.ts", "utf8");
assert.doesNotMatch(responseFormatSource, /\bparallel_tool_calls\b|\btool_choice\b|\btools:\s*\[/, "no tool use anywhere in the structured-output layer");
assert.doesNotMatch(diagnosisSource, /\bstructuredReviewRequestFields\b|\bsubmit_clinical_review\b/, "the removed review request builder must not come back");

const prodSmokeSource = readFileSync("scripts/regress-prod-smoke.mjs", "utf8");
assert.match(prodSmokeSource, /PROD_SMOKE_SAMPLES[\s\S]*?\|\|\s*"5"/,
  "production SLO must default to multiple complete M03/M04 samples");
assert.match(prodSmokeSource, /percentile95\(m03Durations\)/);
assert.match(prodSmokeSource, /percentile95\(m04Durations\)/);
assert.match(prodSmokeSource, /chunk\.status\s*===\s*"模型已开始返回临床正文"/,
  "first-content SLO must use the provider marker rather than the immediate server heartbeat");

for (const [file, fixedMarker, patientMarker, candidateMarker] of [
  ["src/lib/m03-diagnostic-review.ts", "你是独立的中西医临床推理复核器", "患者事实边界：", "待复核M03临床投影："],
  ["src/lib/m04-clinical-review.ts", "你是独立的中药候选处方临床复核器", "患者事实边界：", "待复核M04临床投影："],
]) {
  const source = readFileSync(file, "utf8");
  const fixedRules = source.indexOf(fixedMarker);
  const patient = source.indexOf(patientMarker);
  const candidate = source.indexOf(candidateMarker);
  assert.ok(fixedRules >= 0 && patient > fixedRules && candidate > patient,
    `${file} must keep fixed review rules before patient/candidate payloads for prefix caching`);
}

console.log(JSON.stringify({ suite: "model-structured-output", tasks: 6, models: 6, failures: 0 }));


{
  // ── interpret 严格 schema 出口（2026-08-25 甲方复测 P1-2：json_object 两轮不合契约→502） ──
  const { createJiti } = await import("jiti");
  const fmtJiti = createJiti(import.meta.url, { alias: {
    "@": `${process.cwd()}/src`,
    "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
  } });
  const { responseFormatForZodSchema } = await fmtJiti.import("../src/lib/model-response-format.ts");
  const { z } = await fmtJiti.import("zod");
  const schema = z.object({ answers: z.array(z.object({ questionId: z.string(), interpretation: z.string() })).max(2) });
  // interpret 跟随 primary 模型（生产 BAILIAN_QWEN_MODEL=qwen3.8-flash，2026-09-19 起）；qwen3.7-flash
  // 不在百炼严格模式白名单（3.7-plus/3.7-max/3.8-flash/3.8-max），落 json_object——这条边界一并钉住，
  // 防止有人把 interpret 降到 3.7-flash 后误以为仍有解码层契约保护。
  const strict = responseFormatForZodSchema("qwen3.7-plus", "m02_interpret", schema);
  assert.equal(strict.type, "json_schema", "支持严格模式的 Qwen 档必须走 json_schema");
  assert.equal(responseFormatForZodSchema("qwen3.7-flash", "m02_interpret", schema).type, "json_object",
    "flash 不支持严格模式，必须回落 json_object");
  assert.equal(strict.json_schema?.strict, true);
  assert.equal(strict.json_schema?.name, "m02_interpret");
  const fallback = responseFormatForZodSchema("deepseek-v4-flash", "m02_interpret", schema);
  assert.equal(fallback.type, "json_object", "不支持严格模式的模型回落 json_object");
}
