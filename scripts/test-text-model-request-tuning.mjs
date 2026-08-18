import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
const {
  getPrimaryTextModelConfig,
  isApprovedTextModel,
  isDeepseekModel,
  isQwenModel,
  textModelRequestTuning,
} = await jiti.import("../src/lib/text-model.ts");

const ENV_KEYS = [
  "AI_TEXT_PROVIDER", "AI_PROVIDER",
  "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL",
  "BAILIAN_QWEN_API_KEY", "BAILIAN_QWEN_BASE_URL", "BAILIAN_QWEN_MODEL",
  "DASHSCOPE_API_KEY", "DASHSCOPE_BASE_URL", "DASHSCOPE_MODEL",
  "QWEN_API_KEY", "QWEN_BASE_URL", "QWEN_MODEL",
  "CDSS_TEXT_MODEL_ALLOWED_HOSTS", "CDSS_DEEPSEEK_ALLOWED_HOSTS",
];
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

try {
  assert.equal(isDeepseekModel("deepseek-v4-flash"), true);
  assert.equal(isQwenModel("qwen3.7-plus"), true);
  for (const model of ["deepseek-v4-flash", "qwen3.7-plus", "qwen3.7-flash", "qwen3.8-max"]) {
    assert.equal(isApprovedTextModel(model), true, `${model} must be in the approved text-model family set`);
  }
  assert.equal(isApprovedTextModel("glm-5"), false);

  process.env.AI_TEXT_PROVIDER = "openai-compatible";
  process.env.OPENAI_API_KEY = "deepseek-test-key";
  process.env.OPENAI_BASE_URL = "https://api.deepseek.com";
  process.env.OPENAI_MODEL = "deepseek-v4-flash";
  let config = getPrimaryTextModelConfig();
  assert.equal(config.provider, "openai-compatible");
  assert.equal(config.configured, true);
  assert.equal(config.model, "deepseek-v4-flash");

  process.env.AI_TEXT_PROVIDER = "bailian-qwen";
  process.env.BAILIAN_QWEN_API_KEY = "qwen-test-key";
  process.env.BAILIAN_QWEN_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
  process.env.BAILIAN_QWEN_MODEL = "qwen3.7-plus";
  config = getPrimaryTextModelConfig();
  assert.equal(config.provider, "bailian-qwen");
  assert.equal(config.configured, true);
  assert.equal(config.model, "qwen3.7-plus");
  assert.equal(config.keyVariable, "BAILIAN_QWEN_API_KEY");

  process.env.BAILIAN_QWEN_BASE_URL = "https://unapproved.example.com/compatible-mode/v1";
  assert.equal(getPrimaryTextModelConfig().disabledReason, "vendor_policy");

  process.env.AI_TEXT_PROVIDER = "unknown-provider";
  assert.equal(getPrimaryTextModelConfig().disabledReason, "vendor_policy");

  assert.deepEqual(
    textModelRequestTuning("deepseek-v4-flash", { reasoningEffort: "low", thinkingEnabled: false }),
    { reasoning_effort: "low", thinking: { type: "disabled" } },
  );
  assert.deepEqual(
    textModelRequestTuning("deepseek-v4-flash", { reasoningEffort: "medium", thinkingEnabled: true }),
    { reasoning_effort: "medium", thinking: { type: "enabled" } },
  );
  assert.deepEqual(
    textModelRequestTuning("qwen3.7-plus", { reasoningEffort: "medium", thinkingEnabled: false }),
    { enable_thinking: false },
  );
  assert.deepEqual(
    textModelRequestTuning("qwen3.8-max", { reasoningEffort: "high", thinkingEnabled: true }),
    { enable_thinking: true },
  );
  assert.deepEqual(textModelRequestTuning("glm-5", { reasoningEffort: "low", thinkingEnabled: false }), {});
} finally {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
}

console.log(JSON.stringify({ suite: "text-model-request-tuning", models: 4, providers: 2, failures: 0 }));
