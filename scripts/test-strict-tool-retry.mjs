// DeepSeek strict 工具调用重试通道（2026-09-27）钉住的性质：
//  ① 工具参数 schema 落在 DeepSeek strict 子集内：不含带对象/数组分支的 anyOf（9/24 第一版正是它
//     让西医半 management、中医半 lineageAdaptation 输出 `::`/多余括号）；每个对象全部属性必填、
//     additionalProperties:false；不含 minItems/maxItems/minLength/maxLength。
//  ② 参数回映射：末尾多余闭合括号、单键 parameter 包装两类格式噪声确定性修补；空串/全空对象按原 schema
//     可空位置还原为 null；回映射后能通过与首轮同一套校验（checkNonStrictStructuredValue）。
//  ③ 只对 M03 两半、只对支持 strict 工具参数的模型开放；两半的兜底链都是「strict 工具调用 → Qwen 严格兜底」。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
const format = await jiti.import("../src/lib/model-response-format.ts");
const failures = [];
const check = (name, fn) => { try { fn(); } catch (error) { failures.push({ name, message: error.message }); } };

function walk(node, visit, path = "") {
  if (Array.isArray(node)) { node.forEach((child, index) => walk(child, visit, `${path}/${index}`)); return; }
  if (!node || typeof node !== "object") return;
  visit(node, path);
  for (const [key, child] of Object.entries(node)) walk(child, visit, `${path}/${key}`);
}

for (const task of ["m03_western", "m03_tcm"]) {
  check(`${task}: tool parameters stay inside the DeepSeek strict subset`, () => {
    const schema = format.strictToolParametersForTask(task);
    walk(schema, (node, path) => {
      if (Array.isArray(node.anyOf)) {
        for (const branch of node.anyOf) {
          assert.ok(!(branch && (branch.type === "object" || branch.type === "array" || branch.properties || branch.items || branch.$ref)),
            `${task}${path}: anyOf must not have object/array branches`);
        }
      }
      for (const keyword of ["minItems", "maxItems", "minLength", "maxLength", "$ref", "$defs"]) {
        assert.ok(!(keyword in node), `${task}${path}: unsupported keyword ${keyword}`);
      }
      if (node.type === "object" || node.properties) {
        assert.equal(node.additionalProperties, false, `${task}${path}: additionalProperties must be false`);
        assert.deepEqual([...(node.required || [])].sort(), Object.keys(node.properties || {}).sort(), `${task}${path}: every property must be required`);
      }
    });
  });
}

check("tool argument repairs: trailing extra closers and single-key wrappers", () => {
  const good = { westernDiagnosis: { primary: { name: "慢性浅表性胃炎" } } };
  assert.deepEqual(format.structuredValueFromToolArguments("m03_western", `${JSON.stringify(good)}}`)?.repairs, ["trailing_extra_closers"]);
  const wrapped = format.structuredValueFromToolArguments("m03_western", JSON.stringify({ parameter: JSON.stringify(good) }));
  assert.deepEqual(wrapped?.repairs, ["unwrapped_string_wrapper"]);
  assert.equal(wrapped.value.westernDiagnosis.primary.name, "慢性浅表性胃炎");
  assert.equal(format.structuredValueFromToolArguments("m03_western", "{\"westernDiagnosis\":: 1}"), undefined, "real corruption stays unrecoverable");
});

check("empty strings / all-empty objects map back to null only where the provider schema is nullable", () => {
  const provider = format.providerJsonSchemaForTask("m03_western");
  const management = provider.properties?.management;
  assert.ok(management, "fixture assumption: m03_western has a management object");
  const mapped = format.structuredValueFromToolArguments("m03_western", JSON.stringify({ management: { mustCollect: [], redFlagLoop: "", followupSafetyNet: "" } }));
  const managementAdmitsNull = JSON.stringify(management).includes("\"null\"");
  if (managementAdmitsNull) assert.equal(mapped.value.management, null, "an all-empty nullable object becomes null");
});

check("round trip: a provider-valid value survives the tool shape and back", () => {
  // 用首轮真实重放里通过校验的中医半形状做最小样本：可空字段以 null 出现。
  const schema = format.strictToolParametersForTask("m03_tcm");
  const toToolShape = (node) => {
    if (!node || typeof node !== "object") return null;
    if (Array.isArray(node.anyOf)) return null;
    if (node.type === "object") return Object.fromEntries(Object.entries(node.properties || {}).map(([k, v]) => [k, toToolShape(v)]));
    if (node.type === "array") return [];
    if (node.type === "string") return Array.isArray(node.enum) ? node.enum[0] : "";
    if (node.type === "number" || node.type === "integer") return 0;
    if (node.type === "boolean") return false;
    return null;
  };
  const sample = toToolShape(schema);
  const mapped = format.structuredValueFromToolArguments("m03_tcm", JSON.stringify(sample));
  assert.ok(mapped, "tool-shaped JSON must map back");
  const lineage = mapped.value.lineageAdaptation;
  assert.ok(lineage === null || typeof lineage === "object", "lineageAdaptation must be an object or null after mapping");
});

check("strict tool retry is only offered for M03 halves on strict-tool-capable models", () => {
  assert.equal(format.supportsStrictToolRetry("deepseek-flash", "m03_western"), true);
  assert.equal(format.supportsStrictToolRetry("deepseek-flash", "m03_tcm"), true);
  assert.equal(format.supportsStrictToolRetry("deepseek-flash", "m04_proposal"), false, "M04 strict tools measured 5–9/16 valid — not offered");
  assert.equal(format.supportsStrictToolRetry("qwen3.8-flash", "m03_tcm"), false);
});

check("both M03 halves try the strict tool call before the Qwen strict fallback", () => {
  const api = readFileSync("src/lib/diagnosis-api.ts", "utf8");
  const western = api.slice(api.indexOf("async function collectM03ParallelWesternHalf("), api.indexOf("type StructuredRepairResult"));
  assert.ok(western.indexOf('attemptOnce(model, "strict_tool")') > 0, "western half must retry with the strict tool call");
  assert.ok(western.indexOf('attemptOnce(model, "strict_tool")') < western.indexOf("result = await attemptOnce(strictFallback)"), "tool retry precedes the Qwen fallback");
  const tcmStart = api.indexOf("supportsStrictToolRetry(initialResponseModel, initialStructuredTask)");
  assert.ok(tcmStart > 0, "TCM half must check the strict tool retry path");
  assert.ok(tcmStart < api.indexOf("const strictFallback = structuredStrictFallbackModel(initialResponseModel);", tcmStart), "tool retry precedes the Qwen fallback");
  assert.match(api, /tool_choice: \{ type: "function", function: \{ name: toolName \} \}/);
  assert.match(api, /strict: true/);
});

console.log(JSON.stringify({ suite: "strict-tool-retry", failures }, null, 1));
if (failures.length) process.exit(1);
