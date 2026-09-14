// 复核器闭集结论在 DeepSeek 上走 strict tool-call（2026-09-14）。
//
// 根因（生产 222 例实测）：DeepSeek 的 response_format 只有 json_object、不执行 schema，
// 复核器的四码闭集只是提示词里的一句话。31 例线上同款复现里 2 例把整句中文写进枚举字段
// repairFocus；生产 54 次 invalid contract 正是同类泄漏落到必填的 issueCode 上，同一坏候选
// 在首审/终审/修复轮被以 T=0 反复问、每次同样失败（108 条日志）。
// DeepSeek 对 strict:true 的函数参数做服务端约束解码（正式端点与 beta 端点各 6/6 精确枚举）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src`, "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js` } });
const { buildClinicalReviewRequestBody, clinicalReviewContentFromChoice } = await jiti.import("../src/lib/diagnosis-api.ts");
const { strictReviewToolParameters, supportsStrictToolArguments, supportsStrictJsonSchema } = await jiti.import("../src/lib/model-response-format.ts");
const { parseM04ClinicalReview } = await jiti.import("../src/lib/m04-clinical-review.ts");
const { parseM03DiagnosticReview } = await jiti.import("../src/lib/m03-diagnostic-review.ts");

const body = (model, stage = "prescribe") => buildClinicalReviewRequestBody({
  model, provider: "openai-compatible", stage, systemPrompt: "系统", userPrompt: "用户",
});

test("DeepSeek review requests force a strict tool call instead of json_object", () => {
  for (const model of ["deepseek-flash", "deepseek-v4-pro", "DeepSeek-Flash"]) {
    assert.equal(supportsStrictJsonSchema(model), false, `${model} 没有严格 json_schema`);
    assert.equal(supportsStrictToolArguments(model), true, `${model} 有 strict tool 参数`);
    for (const stage of ["prescribe", "diagnose"]) {
      const request = body(model, stage);
      assert.equal(request.response_format, undefined, `${model}/${stage}: 不再发 response_format`);
      assert.equal(request.tools?.length, 1);
      assert.equal(request.tools[0].function.strict, true);
      assert.equal(request.tool_choice?.function?.name, request.tools[0].function.name, "必须强制调用该函数");
      assert.equal(request.max_tokens, 800);
      assert.equal(request.temperature, 0);
      assert.equal(request.stream, false);
    }
  }
});

test("strict json_schema models keep response_format and never get tools", () => {
  for (const model of ["qwen3.8-max", "qwen3.7-plus"]) {
    const request = body(model);
    assert.equal(request.tools, undefined, `${model}: 不发 tools`);
    assert.equal(request.tool_choice, undefined);
    assert.equal(request.response_format?.type, "json_schema", `${model}: 严格 schema 不变`);
  }
  const weak = body("some-unknown-model");
  assert.equal(weak.tools, undefined);
  assert.deepEqual(weak.response_format, { type: "json_object" }, "未知模型维持 json_object 回落");
});

test("tool parameter schemas obey the DeepSeek strict subset and match the parsers' closed sets", () => {
  const forbidden = new Set(["minLength", "maxLength", "minItems", "maxItems", "uniqueItems", "minimum", "maximum"]);
  const walk = (node, path = "$") => {
    if (Array.isArray(node)) return node.forEach((item, i) => walk(item, `${path}[${i}]`));
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      assert.ok(!forbidden.has(key), `${path}.${key} 不在 DeepSeek strict 子集内`);
      walk(value, `${path}.${key}`);
    }
  };
  for (const task of ["m03_review", "m04_review"]) {
    const schema = strictReviewToolParameters(task);
    walk(schema);
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort(), `${task}: 所有属性必须 required`);
  }
  // 枚举 ⊆ 解析层接受集：schema 允许的每个码都必须被解析器认可（否则 strict 也白搭）。
  const m04 = strictReviewToolParameters("m04_review").properties;
  for (const code of m04.issueCode.enum.filter((c) => c !== "none")) {
    const parsed = parseM04ClinicalReview(JSON.stringify({ status: "repair", issueCode: code, repairFocus: null, candidateIndex: null, implicatedHerbs: [] }));
    assert.equal(parsed.status, "repair", `m04 issueCode ${code} 必须被解析器接受`);
    assert.equal(parsed.issueCode, code);
  }
  assert.deepEqual(parseM04ClinicalReview(JSON.stringify({ status: "accepted", issueCode: "none", repairFocus: null, candidateIndex: null, implicatedHerbs: [] })),
    { status: "accepted", issueCode: "none" }, "可空字段回 null 时 accepted 照常解析");
  const focusEnum = m04.repairFocus.anyOf.find((item) => item.enum).enum;
  const focusParsed = parseM04ClinicalReview(JSON.stringify({ status: "repair", issueCode: "herb_plan_mismatch", repairFocus: "emperor_role", candidateIndex: 0, implicatedHerbs: ["黄芪"] }));
  assert.equal(focusParsed.repairFocus, "emperor_role");
  assert.ok(focusEnum.includes("emperor_role"));
  const m03 = strictReviewToolParameters("m03_review").properties;
  for (const code of m03.issueCode.enum.filter((c) => c !== "none")) {
    const parsed = parseM03DiagnosticReview(JSON.stringify({ status: "repair", issueCode: code, repairInstruction: null }));
    assert.equal(parsed.status, "repair", `m03 issueCode ${code} 必须被解析器接受`);
  }
  assert.deepEqual(parseM03DiagnosticReview(JSON.stringify({ status: "accepted", issueCode: "none", repairInstruction: null })),
    { status: "accepted", issueCode: "none" });
});

test("tool-call arguments take precedence over message content; content path is unchanged", () => {
  const args = JSON.stringify({ status: "repair", issueCode: "dose_rationale_concern", repairFocus: "dose_strength", candidateIndex: 0, implicatedHerbs: ["附子"] });
  assert.equal(clinicalReviewContentFromChoice({ message: { content: "", tool_calls: [{ function: { name: "submit_clinical_review", arguments: args } }] } }), args);
  assert.equal(clinicalReviewContentFromChoice({ message: { content: "prose", tool_calls: [{ function: { arguments: args } }] } }), args, "同时存在时以 tool 参数为准");
  assert.equal(clinicalReviewContentFromChoice({ message: { content: '{"status":"accepted","issueCode":"none"}' } }), '{"status":"accepted","issueCode":"none"}');
  assert.equal(clinicalReviewContentFromChoice({ message: { content: "x", tool_calls: [{ function: { arguments: "   " } }] } }), "x", "空参数回落 content");
  assert.equal(clinicalReviewContentFromChoice(undefined), "");
  // 生产失败形态：整句中文进了枚举字段 —— 解析层仍然拒绝（strict 只是让它不再发生）。
  const prose = JSON.stringify({ status: "repair", issueCode: "中成药候选的说明书适应证与本例不符，应移除该候选", repairFocus: "x" });
  assert.equal(parseM04ClinicalReview(prose).status, "unavailable", "闭集校验一个字不放宽");
});
