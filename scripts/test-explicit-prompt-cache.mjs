import assert from "node:assert/strict";
import { buildPromptWithPublicPrefix, explicitPromptCacheContent } from "../src/lib/model-prompt-cache.ts";
import { modelUsageSnapshot } from "../src/lib/openai-compatible-response.ts";
import { createInitialCaseState } from "../src/lib/diagnosis-types.ts";
import { buildQuestionPrompt, buildDiagnosePrompt, buildPrescribePrompt } from "../src/lib/diagnosis-prompts.ts";
import { buildM03DiagnosticReviewPrompt, buildM03DiagnosticReviewAdjudicationPrompt } from "../src/lib/m03-diagnostic-review.ts";
import { buildM03ContextPackets } from "../src/lib/m03-context-packets.ts";

const original = process.env.CDSS_EXPLICIT_PROMPT_CACHE;
const config = { provider: "bailian-qwen", model: "qwen3.8-flash" };
const content = (prompt, options = config) => explicitPromptCacheContent(prompt, options);
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
  for (const options of [{ provider: "openai-compatible", model: "qwen3.8-flash" }, { provider: "bailian-qwen", model: "deepseek-chat" }, { provider: "glm", model: "glm-4.6v" }]) assert.equal(content(prompt, options), prompt);
  for (const builder of [buildQuestionPrompt, buildDiagnosePrompt, buildPrescribePrompt]) {
    const make = (complaint, preference) => {
      const state = createInitialCaseState();
      state.chiefComplaint = complaint;
      state.patient = { ...state.patient, age: preference ? 70 : 30, sex: preference ? "女" : "男" };
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
  for (const usage of [{}, { prompt_tokens_details: null, completion_tokens_details: null }, { cache_creation_input_tokens: null }, { cache_creation_input_tokens: -1, completion_tokens_details: { reasoning_tokens: "5" } }]) {
    const snapshot = modelUsageSnapshot({ usage });
    assert.equal(snapshot?.cacheCreationInputTokens, undefined);
    assert.equal(snapshot?.reasoningTokens, undefined);
  }
  for (const n of [0, 24]) {
    const snapshot = modelUsageSnapshot({ usage: { cache_creation_input_tokens: n, completion_tokens_details: { reasoning_tokens: n } } });
    assert.equal(snapshot.cacheCreationInputTokens, n);
    assert.equal(snapshot.reasoningTokens, n);
  }
  console.log("Explicit public-prefix cache and optional usage regression passed");
} finally {
  if (original === undefined) delete process.env.CDSS_EXPLICIT_PROMPT_CACHE;
  else process.env.CDSS_EXPLICIT_PROMPT_CACHE = original;
}
