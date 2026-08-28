import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import OpenAI from "openai";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { responseFormatForTask } = await jiti.import("../src/lib/model-response-format.ts");

const openAiCompatibleBase = process.env.OPENAI_BASE_URL?.trim() || "";
const qwenCompatibleOpenAiEnv = (() => {
  try {
    return new URL(openAiCompatibleBase).hostname.toLowerCase() === "dashscope.aliyuncs.com";
  } catch {
    return false;
  }
})();
const apiKey = process.env.BAILIAN_QWEN_API_KEY?.trim()
  || process.env.DASHSCOPE_API_KEY?.trim()
  || process.env.QWEN_API_KEY?.trim()
  || (qwenCompatibleOpenAiEnv ? process.env.OPENAI_API_KEY?.trim() : "")
  || "";
const baseURL = (process.env.BAILIAN_QWEN_BASE_URL
  || process.env.DASHSCOPE_BASE_URL
  || (qwenCompatibleOpenAiEnv ? openAiCompatibleBase : "")
  || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/$/, "");
const outputPath = resolve(process.env.QWEN_MATRIX_PROBE_OUT || "artifacts/qwen-model-matrix/probe.json");

if (!apiKey) {
  console.error("Qwen matrix probe requires a configured Bailian credential");
  process.exit(2);
}

const client = new OpenAI({ apiKey, baseURL });
const TIMEOUT_MS = 90_000;

function failureReason(error) {
  const status = Number(error?.status || error?.response?.status || 0);
  if (status) return `http_${status}`;
  return /abort|timeout/i.test(String(error?.message || "")) ? "timeout" : "request_failed";
}

function safeProviderError(error) {
  return {
    status: Number(error?.status || error?.response?.status || 0) || undefined,
    type: typeof error?.type === "string" ? error.type.slice(0, 80) : undefined,
    code: typeof error?.code === "string" ? error.code.slice(0, 120) : undefined,
    param: typeof error?.param === "string" ? error.param.slice(0, 160) : undefined,
    // The probe prompt is synthetic and contains no patient data. Preserve the bounded provider
    // explanation so a newly advertised model cannot pass the tiny schema probe while rejecting
    // the production M03 schema.
    message: typeof error?.message === "string" ? error.message.slice(0, 500) : undefined,
  };
}

async function probeStreaming(model, phase) {
  const startedAt = Date.now();
  let content = "";
  let finishReason = "";
  try {
    const stream = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: "你是接口健康检查助手，只回复 ok，不要解释。" },
        { role: "user", content: "health check" },
      ],
      temperature: 0,
      max_tokens: 128,
      stream: true,
      enable_thinking: false,
    }, { timeout: TIMEOUT_MS });
    for await (const chunk of stream) {
      const choice = chunk.choices?.[0];
      if (choice?.delta?.content) content += choice.delta.content;
      if (choice?.finish_reason) finishReason = choice.finish_reason;
    }
    return {
      model, phase, httpOk: true,
      finalContent: Boolean(content.trim()),
      finishReason: Boolean(finishReason),
      jsonObject: false,
      thinkingDisabledAccepted: true,
      durationMs: Date.now() - startedAt,
      reason: content.trim() && finishReason ? "ok" : "stream_contract_incomplete",
    };
  } catch (error) {
    return {
      model, phase, httpOk: false, finalContent: false, finishReason: false,
      jsonObject: false, thinkingDisabledAccepted: false,
      durationMs: Date.now() - startedAt, reason: failureReason(error),
    };
  }
}

async function probeJson(model, phase) {
  const startedAt = Date.now();
  try {
    const completion = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: "你是接口健康检查助手，只输出JSON。" },
        { role: "user", content: "只输出 {\"status\":\"ok\"}" },
      ],
      temperature: 0,
      max_tokens: 300,
      response_format: { type: "json_object" },
      stream: false,
      enable_thinking: false,
    }, { timeout: TIMEOUT_MS });
    const content = completion.choices?.[0]?.message?.content || "";
    const finishReason = completion.choices?.[0]?.finish_reason || "";
    let jsonObject = false;
    try {
      const parsed = JSON.parse(content);
      jsonObject = parsed?.status === "ok";
    } catch {
      jsonObject = false;
    }
    return {
      model, phase, httpOk: true,
      finalContent: Boolean(content.trim()),
      finishReason: Boolean(finishReason),
      jsonObject,
      thinkingDisabledAccepted: true,
      durationMs: Date.now() - startedAt,
      reason: content.trim() && finishReason && jsonObject ? "ok" : "json_contract_invalid",
    };
  } catch (error) {
    return {
      model, phase, httpOk: false, finalContent: false, finishReason: false,
      jsonObject: false, thinkingDisabledAccepted: false,
      durationMs: Date.now() - startedAt, reason: failureReason(error),
    };
  }
}

async function probeStrictJson(model, phase) {
  const startedAt = Date.now();
  try {
    const completion = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: "你是接口健康检查助手，只输出契约JSON。" },
        { role: "user", content: "返回 status=ok、mode=strict。" },
      ],
      temperature: 0,
      max_tokens: 300,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "qwen38_flash_probe",
          strict: true,
          schema: {
            type: "object",
            properties: {
              status: { type: "string", enum: ["ok"] },
              mode: { type: "string", enum: ["strict"] },
            },
            required: ["status", "mode"],
            additionalProperties: false,
          },
        },
      },
      stream: false,
      enable_thinking: false,
    }, { timeout: TIMEOUT_MS });
    const content = completion.choices?.[0]?.message?.content || "";
    const finishReason = completion.choices?.[0]?.finish_reason || "";
    let jsonObject = false;
    try {
      const parsed = JSON.parse(content);
      jsonObject = parsed?.status === "ok" && parsed?.mode === "strict";
    } catch {
      jsonObject = false;
    }
    return {
      model, phase, httpOk: true,
      finalContent: Boolean(content.trim()), finishReason: Boolean(finishReason), jsonObject,
      strictJsonSchema: jsonObject, thinkingDisabledAccepted: true,
      durationMs: Date.now() - startedAt,
      reason: content.trim() && finishReason && jsonObject ? "ok" : "strict_json_contract_invalid",
    };
  } catch (error) {
    return {
      model, phase, httpOk: false, finalContent: false, finishReason: false,
      jsonObject: false, strictJsonSchema: false, thinkingDisabledAccepted: false,
      durationMs: Date.now() - startedAt, reason: failureReason(error),
    };
  }
}

async function probeProductionM03Schema(model, phase) {
  const startedAt = Date.now();
  try {
    const completion = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: "这是无患者数据的结构化接口兼容性探针。" },
        { role: "user", content: "按给定 JSON Schema 输出一个最小合法对象。" },
      ],
      temperature: 0,
      max_tokens: 300,
      response_format: responseFormatForTask(model, "m03_full"),
      stream: false,
      enable_thinking: false,
    }, { timeout: TIMEOUT_MS });
    return {
      model, phase, httpOk: true,
      finalContent: Boolean(completion.choices?.[0]?.message?.content?.trim()),
      finishReason: Boolean(completion.choices?.[0]?.finish_reason),
      productionM03SchemaAccepted: true,
      durationMs: Date.now() - startedAt,
      reason: "ok",
    };
  } catch (error) {
    return {
      model, phase, httpOk: false, finalContent: false, finishReason: false,
      productionM03SchemaAccepted: false,
      durationMs: Date.now() - startedAt,
      reason: failureReason(error),
      providerError: safeProviderError(error),
    };
  }
}

const primary = await probeStreaming("qwen3.7-plus", "primary");
const fast = await probeJson("qwen3.7-flash", "fast");
const latestFast = await probeStrictJson("qwen3.8-flash", "latest_fast");
const latestFastProductionSchema = await probeProductionM03Schema("qwen3.8-flash", "latest_fast_m03_schema");
const critical = await probeJson("qwen3.8-max", "critical");
const criticalOk = critical.httpOk && critical.finalContent && critical.finishReason && critical.jsonObject;
const criticalFallback = criticalOk ? null : await probeJson("qwen3.7-plus", "critical_fallback");
const fallbackOk = criticalFallback == null || (
  criticalFallback.httpOk && criticalFallback.finalContent && criticalFallback.finishReason && criticalFallback.jsonObject
);
const ok = primary.httpOk && primary.finalContent && primary.finishReason &&
  fast.httpOk && fast.finalContent && fast.finishReason && fast.jsonObject &&
  latestFast.httpOk && latestFast.finalContent && latestFast.finishReason && latestFast.strictJsonSchema &&
  latestFastProductionSchema.httpOk && latestFastProductionSchema.productionM03SchemaAccepted &&
  (criticalOk || fallbackOk);
const result = {
  schemaVersion: "qwen-model-matrix-probe-v1",
  checkedAt: new Date().toISOString(),
  ok,
  rows: [primary, fast, latestFast, latestFastProductionSchema, critical],
  criticalFallback,
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(JSON.stringify(result, null, 2));
process.exit(ok ? 0 : 1);
