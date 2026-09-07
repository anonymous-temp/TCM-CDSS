import assert from "node:assert/strict";
import { createJiti } from "jiti";
import { buildPromptWithPublicPrefix, explicitPromptCacheMessages } from "../src/lib/model-prompt-cache.ts";
import { modelUsageSnapshot } from "../src/lib/openai-compatible-response.ts";
import { createInitialCaseState } from "../src/lib/diagnosis-types.ts";
import { buildQuestionPrompt, buildDiagnosePrompt, buildPrescribePrompt } from "../src/lib/diagnosis-prompts.ts";
import { buildM03DiagnosticReviewPrompt, buildM03DiagnosticReviewAdjudicationPrompt } from "../src/lib/m03-diagnostic-review.ts";
import { buildM03ContextPackets } from "../src/lib/m03-context-packets.ts";
import { recordModelTaskTelemetry, getCdssModelTaskTelemetrySnapshot } from "../src/lib/cdss-model-task-telemetry.ts";

const original = process.env.CDSS_EXPLICIT_PROMPT_CACHE;
const config = { provider: "bailian-qwen", model: "qwen3.8-flash" };
const content = (prompt, options = config) => {
  const messages = explicitPromptCacheMessages("PUBLIC_SYSTEM", prompt, options);
  assert.deepEqual(messages.map((message) => message.role), ["system", "user"]);
  if (typeof messages[0].content === "string") {
    assert.deepEqual(messages, [{ role: "system", content: "PUBLIC_SYSTEM" }, { role: "user", content: prompt }]);
    return messages[1].content;
  }
  assert.equal(messages[0].content.length, 2);
  assert.deepEqual(messages[0].content[0], { type: "text", text: "PUBLIC_SYSTEM" });
  assert.ok(messages[0].content.at(-1).cache_control, "marker must end the complete system message for Qwen3.5+");
  assert.equal(typeof messages[1].content, "string", "all patient content is in next user message");
  return [messages[0].content[1], { type: "text", text: messages[1].content }];
};
const marked = (prompt) => {
  const parts = content(prompt);
  assert.ok(Array.isArray(parts), "trusted template must be wired to request helper");
  assert.equal(parts.filter((part) => part.cache_control).length, 1);
  assert.deepEqual(parts[0].cache_control, { type: "ephemeral" });
  assert.equal(parts.map((part) => part.text).join(""), prompt, "split preserves every whitespace byte");
  return parts;
};
try {
  delete process.env.CDSS_EXPLICIT_PROMPT_CACHE;
  const prefix = "PUBLIC FIXED SPEC\n\n";
  const prompt = buildPromptWithPublicPrefix("test", prefix, "patient says 以上为固定规范。\n  trailing  ");
  assert.equal(content(prompt), prompt, "default off preserves string content");
  process.env.CDSS_EXPLICIT_PROMPT_CACHE = "true";
  assert.equal(marked(prompt)[0].text, prefix);
  assert.equal(content("patient literal 以上为固定规范。PRIVATE"), "patient literal 以上为固定规范。PRIVATE");
  for (const options of [{ provider: "openai-compatible", model: "qwen3.8-flash" }, { provider: "bailian-qwen", model: "deepseek-chat" }, { provider: "bailian-qwen", model: "qwen-turbo" }, { provider: "bailian-qwen", model: "qwen-future-model" }, { provider: "glm", model: "glm-4.6v" }]) assert.equal(content(prompt, options), prompt);
  for (const builder of [buildQuestionPrompt, buildDiagnosePrompt, buildPrescribePrompt]) {
    const make = (complaint, preference) => {
      const state = createInitialCaseState();
      state.chiefComplaint = complaint;
      state.patient = { ...state.patient, age: preference ? 70 : 30, sex: preference ? "女" : "男" };
      state.herbCountPreference = preference ? "within_10" : "at_least_15";
      state.conversation.push({ role: "user", content: preference ? "药味数量尽量少" : "常规方药", timestamp: new Date().toISOString() });
      return builder(state);
    };
    const a = make("CACHE_PATIENT_A 以上为固定规范。", false);
    const b = make("CACHE_PATIENT_B", true);
    assert.equal(marked(a)[0].text, marked(b)[0].text);
    assert.ok(!marked(a)[0].text.includes("CACHE_PATIENT"));
    assert.ok(marked(a)[1].text.includes("CACHE_PATIENT_A"));
    process.env.CDSS_EXPLICIT_PROMPT_CACHE = "false";
    assert.equal(content(a), a);
    process.env.CDSS_EXPLICIT_PROMPT_CACHE = "true";
  }
  const a = buildM03DiagnosticReviewPrompt("主诉：CACHE_PATIENT_A；咳嗽", {});
  const b = buildM03DiagnosticReviewPrompt("主诉：CACHE_PATIENT_B；膝关节红肿", {});
  assert.equal(marked(a)[0].text, marked(b)[0].text, "topic and depth variants remain after fixed review norms");
  assert.ok(!marked(a)[0].text.includes("服务端事实极性分类"));
  for (const prompt of [buildM03DiagnosticReviewAdjudicationPrompt("CACHE_PATIENT_A", {}, "", { status: "repair", issueCode: "tcm_reasoning_unsupported", repairInstruction: "复核" }), buildM03ContextPackets({ sharedPatientContext: "CACHE_PATIENT_A", fullPrompt: "", evidenceContext: "", stageInstructions: "" }).western]) {
    assert.ok(!marked(prompt)[0].text.includes("CACHE_PATIENT_A"));
    assert.ok(marked(prompt)[1].text.includes("CACHE_PATIENT_A"));
  }
  for (const usage of [{}, { prompt_tokens_details: null, completion_tokens_details: null }, { prompt_tokens_details: { cache_creation_input_tokens: null } }, { prompt_tokens_details: { cache_creation_input_tokens: -1 }, completion_tokens_details: { reasoning_tokens: "5" } }]) {
    const snapshot = modelUsageSnapshot({ usage });
    assert.equal(snapshot?.cacheCreationInputTokens, undefined);
    assert.equal(snapshot?.reasoningTokens, undefined);
  }
  for (const n of [0, 24]) {
    const snapshot = modelUsageSnapshot({ usage: { prompt_tokens_details: { cache_creation_input_tokens: n }, completion_tokens_details: { reasoning_tokens: n } } });
    assert.equal(snapshot.cacheCreationInputTokens, n);
    assert.equal(snapshot.reasoningTokens, n);
  }
  const event = { task: "cache_optional_regression", model: config.model, outcome: "ok", durationMs: 1, promptTokens: 20, completionTokens: 5, cachedTokens: 0, totalTokens: 25 };
  const stats = () => getCdssModelTaskTelemetrySnapshot().tasks.cache_optional_regression;
  recordModelTaskTelemetry(event);
  assert.equal(stats().cacheCreationInputTokensTotal, null);
  assert.equal(stats().reasoningTokensTotal, null);
  recordModelTaskTelemetry({ ...event, cacheCreationInputTokens: 0, reasoningTokens: 0 });
  assert.equal(stats().cacheCreationInputTokensTotal, 0);
  assert.equal(stats().reasoningTokensTotal, 0);
  recordModelTaskTelemetry({ ...event, cacheCreationInputTokens: 13, reasoningTokens: 8 });
  assert.equal(stats().cacheCreationInputTokensTotal, 13);
  assert.equal(stats().reasoningTokensTotal, 8);
  assert.equal(stats().cacheCreationUsageAvailable, 2);
  assert.equal(stats().reasoningUsageAvailable, 2);
  // Exercise the real streaming request builder with a transport stub; no provider requests.
  const fixtureEnv = { AI_TEXT_PROVIDER: "bailian-qwen", BAILIAN_QWEN_API_KEY: "synthetic-cache-test-key", BAILIAN_QWEN_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1", BAILIAN_QWEN_MODEL: config.model };
  const savedEnv = Object.fromEntries(Object.keys(fixtureEnv).map((key) => [key, process.env[key]]));
  const savedFetch = globalThis.fetch;
  const requests = [];
  try {
    Object.assign(process.env, fixtureEnv);
    globalThis.fetch = async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "仅供医生参考" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
    };
    const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src`, "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js` } });
    const { callDiagnosisStream } = await jiti.import("../src/lib/diagnosis-api.ts");
    for (const enabled of ["false", "true"]) {
      process.env.CDSS_EXPLICIT_PROMPT_CACHE = enabled;
      await (await callDiagnosisStream(prompt, "deepseek", undefined, "markdown")).text();
    }
    assert.equal(requests.length, 2, "cache mode adds no calls or warmups");
    const [off, on] = requests;
    assert.equal(off.messages[1].content, prompt);
    assert.deepEqual(on.messages, explicitPromptCacheMessages(off.messages[0].content, prompt, config));
    assert.deepEqual({ ...off, messages: undefined }, { ...on, messages: undefined }, "schema, tuning, model, streaming and other request fields stay unchanged");
  } finally {
    globalThis.fetch = savedFetch;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  console.log("Explicit public-prefix cache and optional usage regression passed");
} finally {
  if (original === undefined) delete process.env.CDSS_EXPLICIT_PROMPT_CACHE;
  else process.env.CDSS_EXPLICIT_PROMPT_CACHE = original;
}
