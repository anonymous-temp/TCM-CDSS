import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import OpenAI from "openai";

const apiKey = process.env.BAILIAN_QWEN_API_KEY?.trim()
  || process.env.DASHSCOPE_API_KEY?.trim()
  || process.env.QWEN_API_KEY?.trim()
  || "";
const baseURL = (process.env.BAILIAN_QWEN_BASE_URL
  || process.env.DASHSCOPE_BASE_URL
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

const primary = await probeStreaming("qwen3.7-plus", "primary");
const fast = await probeJson("qwen3.7-flash", "fast");
const critical = await probeJson("qwen3.8-max", "critical");
const criticalOk = critical.httpOk && critical.finalContent && critical.finishReason && critical.jsonObject;
const criticalFallback = criticalOk ? null : await probeJson("qwen3.7-plus", "critical_fallback");
const fallbackOk = criticalFallback == null || (
  criticalFallback.httpOk && criticalFallback.finalContent && criticalFallback.finishReason && criticalFallback.jsonObject
);
const ok = primary.httpOk && primary.finalContent && primary.finishReason &&
  fast.httpOk && fast.finalContent && fast.finishReason && fast.jsonObject &&
  (criticalOk || fallbackOk);
const result = {
  schemaVersion: "qwen-model-matrix-probe-v1",
  checkedAt: new Date().toISOString(),
  ok,
  rows: [primary, fast, critical],
  criticalFallback,
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(JSON.stringify(result, null, 2));
process.exit(ok ? 0 : 1);
