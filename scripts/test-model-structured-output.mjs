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

{
  // ── 非严格供应商（DeepSeek json_object）的同一份结构合同（2026-09-24，提速第三批）──
  // 提示里附的 schema 与服务端校验用的 schema 必须是同一份；校验必须抓住 9/11–9/19 线上真实出现过的
  // 形状错误，同时不能把「语义上等价」的写法（省略可空字段、可空字段写空串、多写服务端自有字段）
  // 当成违规——否则每一例都会白白多跑一轮严格兜底。
  const { createJiti } = await import("jiti");
  const fmtJiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
  const { checkNonStrictStructuredContent, checkNonStrictStructuredValue, providerJsonSchemaForTask, providerSchemaViolations,
    structuredOutputSchemaInstruction } = await fmtJiti.import("../src/lib/model-response-format.ts");

  for (const task of ["m03_western", "m03_tcm", "m03_full"]) {
    const instruction = structuredOutputSchemaInstruction("deepseek-flash", task);
    assert.match(instruction, /【输出 JSON Schema/, `${task}: DeepSeek 必须拿到 schema`);
    const shown = JSON.parse(instruction.split("\n").find((line) => line.startsWith("{")));
    const provider = providerJsonSchemaForTask(task);
    assert.deepEqual(Object.keys(shown.properties).sort(), Object.keys(provider.properties).sort(),
      `${task}: 提示里的 schema 与校验用的 schema 同源`);
    assert.equal(structuredOutputSchemaInstruction("qwen3.8-flash", task), "", `${task}: 严格模型不重复附 schema`);
  }
  assert.match(structuredOutputSchemaInstruction("deepseek-flash", "m03_tcm"), /三轴各自独立定档/,
    "中医半给 DeepSeek 重申 resolution 定档规则（实测 bounded 16/18 → 重申后 resolved 7/18）");
  assert.doesNotMatch(structuredOutputSchemaInstruction("deepseek-flash", "m03_western"), /三轴各自独立定档/, "西医半没有 resolution 三轴");
  assert.equal(structuredOutputSchemaInstruction("deepseek-flash", "m04_proposal"), "",
    "M04 不附 schema：重放实测附了反而 14/14 → 11/14");

  const western = {
    westernDiagnosis: {
      primary: {
        name: "慢性失眠障碍", status: "考虑", confidence: "中",
        supportingFacts: ["入睡困难3个月"],
        supportingFactKinds: [{ fact: "入睡困难3个月", kind: "symptom" }],
        clinicalRationale: "病程超过3个月且每周多晚发作", limitations: ["未做睡眠监测"], suggestedChecks: ["睡眠日记"],
      },
      differentials: [],
    },
  };
  assert.deepEqual(providerSchemaViolations("m03_western", western), [], "省略全部可空字段 = 合规");
  const kindsAsStrings = structuredClone(western);
  kindsAsStrings.westernDiagnosis.primary.supportingFactKinds = ["symptom"];
  assert.ok(providerSchemaViolations("m03_western", kindsAsStrings).some((item) => item.keyword === "type"),
    "依据分类写成字符串（9/11–9/19 线上形状）必须判违规");
  const missingChecks = structuredClone(western);
  delete missingChecks.westernDiagnosis.primary.suggestedChecks;
  assert.ok(providerSchemaViolations("m03_western", missingChecks).some((item) => item.keyword === "required:suggestedChecks"),
    "缺必填非空字段必须判违规");
  const misnamed = structuredClone(western);
  misnamed.westernDiagnosis.primary.suggestedCheck = ["睡眠日记"];
  assert.ok(providerSchemaViolations("m03_western", misnamed).length > 0, "schema 外的键名（多半是写错键名）必须判违规");
  const serverOwned = structuredClone(western);
  serverOwned.schemaVersion = "tcm-cdss-reasoning-v2";
  serverOwned.westernDiagnosis.primary.evidence = { evidenceLevel: "model_inference" };
  assert.deepEqual(checkNonStrictStructuredValue("m03_western", serverOwned).violations, [],
    "多写服务端自有字段无害（服务端覆盖、zod 丢弃），不得触发兜底");
  assert.ok(providerSchemaViolations("m03_western", serverOwned).length > 0,
    "裸校验（严格供应商视角）仍把它们当 schema 外的键——容忍只发生在非严格入口");
  const emptyOptional = structuredClone(western);
  emptyOptional.westernDiagnosis.primary.coding = "";
  assert.deepEqual(providerSchemaViolations("m03_western", emptyOptional), [], "可空字段写空串与省略同义");

  const tcmValue = { pathogenesis: { chain: [{ pathogenesisType: "不存在的类型" }] } };
  assert.ok(providerSchemaViolations("m03_tcm", tcmValue).some((item) => item.path === "/pathogenesis/chain/0/pathogenesisType" && item.keyword === "enum"),
    "枚举外取值（中医半重放 6/18）必须判违规");

  const complete = JSON.stringify(western);
  const missingBrace = complete.slice(0, -1);
  assert.throws(() => JSON.parse(missingBrace));
  const completed = checkNonStrictStructuredContent("m03_western", missingBrace);
  assert.deepEqual(completed.violations, [], "只漏末尾括号的输出补齐后合规");
  assert.deepEqual(completed.repairs, ["trailing_closers"]);
  assert.deepEqual(JSON.parse(completed.content), western);
  const earlyClose = `{"westernDiagnosis":{"primary":${JSON.stringify(western.westernDiagnosis.primary)}},"differentials":[]}}`;
  assert.deepEqual(checkNonStrictStructuredContent("m03_western", earlyClose).violations, [{ path: "/", keyword: "json" }],
    "提前闭合（括号错位）不是「补末尾」能修的，照报");
  assert.equal(checkNonStrictStructuredContent("m03_western", complete).content, complete, "无修补时内容逐字不变");

  const basisLimit = providerJsonSchemaForTask("m03_tcm").properties.overview.properties.primarySyndromeBasis.maxItems;
  assert.equal(typeof basisLimit, "number");
  const overLong = { overview: { primarySyndromeBasis: Array.from({ length: basisLimit + 2 }, (_, index) => `依据${index + 1}`) } };
  const clamped = checkNonStrictStructuredValue("m03_tcm", overLong);
  assert.deepEqual(JSON.parse(clamped.content).overview.primarySyndromeBasis, overLong.overview.primarySyndromeBasis.slice(0, basisLimit),
    "超长数组截到上限并保留前 N 条（zod 对超长数组是整组清空）");
  assert.ok(clamped.repairs.includes("max_items:/overview/primarySyndromeBasis"));
  assert.ok(!clamped.violations.some((item) => item.keyword === "maxItems"));
}
