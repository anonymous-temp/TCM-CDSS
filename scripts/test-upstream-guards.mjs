import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";

process.env.EVIMED_API_KEY = "test-only-key";
process.env.EVIMED_EVIDENCE_RETRY_ATTEMPTS = "0";
const jiti = createJiti(import.meta.url, {
  alias: {
    "@": `${process.cwd()}/src`,
    "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
  },
});
const { UpstreamResponseTooLargeError, readResponseTextLimited } = await jiti.import("../src/lib/http-response-limit.ts");
const { cancelResponseBody } = await jiti.import("../src/lib/http-response-lifecycle.ts");
const { callDiagnosisStream, fetchWithConnectTimeout, isTongueVisionConfigured, isTongueVisionEnabled,
  isRetryableProviderHttpStatus, modelForInitialConnectAttempt, modelForQuestionStage, readProviderChunk,
  structuredRepairFailureIsUpstreamUnavailable, structuredStrictFallbackModel } =
  await jiti.import("../src/lib/diagnosis-api.ts");
const { buildTongueVisionPrompt } = await jiti.import("../src/lib/diagnosis-prompts.ts");
const { getPrimaryTextModelConfig } = await jiti.import("../src/lib/text-model.ts");
const { POST: collectPost } = await jiti.import("../src/app/api/diagnosis/collect/route.ts");

const collectRequest = (body) => new Request("http://localhost/api/diagnosis/collect", {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-cdss-customer-id": "test-hospital" },
  body: JSON.stringify(body),
});
const oversizedCollect = await collectPost(collectRequest({ userInput: "失眠".repeat(7000) }));
assert.equal(oversizedCollect.status, 413, "transport-size rejection must precede clinical required-field validation");
const unconsentedTongue = await collectPost(collectRequest({
  userInput: "主诉：失眠2月",
  tongueImage: "data:image/png;base64,iVBORw0KGgo=",
}));
assert.equal(unconsentedTongue.status, 400);
assert.match(await unconsentedTongue.text(), /授权/, "tongue-image authorization must be enforced before clinical required-field validation");
const missingSexCollect = await collectPost(collectRequest({ userInput: "主诉：失眠2月" }));
assert.equal(missingSexCollect.status, 400);
assert.equal((await missingSexCollect.json()).field, "sex", "ordinary collection still enforces T10 sex/physiology state");

const composeSource = readFileSync(new URL("../docker-compose.yml", import.meta.url), "utf8");
const envExampleSource = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
for (const flashAssistPath of [
  "../src/lib/formula-recall-normalization.server.ts",
  "../src/lib/polarity-negation-assist.server.ts",
  "../src/lib/syndrome-hypothesis-rerank.server.ts",
]) {
  const flashAssistSource = readFileSync(new URL(flashAssistPath, import.meta.url), "utf8");
  assert.match(
    flashAssistSource,
    /textModelRequestTuning\([^)]*\{\s*reasoningEffort:\s*"low",\s*thinkingEnabled:\s*false\s*\}\)/,
    `${flashAssistPath} must disable extended thinking so its bounded output budget reaches final content`,
  );
}
const governedFormulaCatalog = JSON.parse(readFileSync(new URL("../src/data/tcm-formula-governed-catalog.json", import.meta.url), "utf8"));
const governedFormulaByName = new Map(governedFormulaCatalog.entries.map((entry) => [entry.name, entry]));
const embeddedFormulaChapterAliases = governedFormulaCatalog.entries.flatMap((entry) => {
  const match = entry.name.match(/(?:用|宜|服)([一-龥]{2,12}(?:汤|丸|散|膏|丹|饮|方))$/);
  if (!match) return [];
  const target = governedFormulaByName.get(match[1]);
  if (!target || target.source !== entry.source) return [];
  const sourceIngredients = new Set(entry.ingredients || []);
  const targetIngredients = new Set(target.ingredients || []);
  const denominator = Math.min(sourceIngredients.size, targetIngredients.size);
  const overlap = denominator
    ? [...sourceIngredients].filter((ingredient) => targetIngredients.has(ingredient)).length / denominator
    : 0;
  return overlap >= 0.6 ? [{ chapterTitle: entry.name, target: target.name, overlap }] : [];
});
assert.deepEqual(
  embeddedFormulaChapterAliases,
  [],
  "章节描述句不得在同源真实方名已存在且组成高度重合时，再作为第二个运行时方剂身份",
);
assert.ok(governedFormulaByName.has("三星汤"), "隔离章节描述句时必须保留真实方名三星汤");
assert.match(
  composeSource,
  /PRIMARY_PRESCRIBE_REPAIR_REASONING_EFFORT: \$\{PRIMARY_PRESCRIBE_REPAIR_REASONING_EFFORT:-medium\}/,
  "M04 repair reasoning effort must be visible in the production container contract",
);
assert.match(
  envExampleSource,
  /^PRIMARY_PRESCRIBE_REPAIR_REASONING_EFFORT=medium$/m,
  "M04 repair reasoning effort must be documented in the deployable environment template",
);
for (const enabledByDefaultAssist of [
  "FORMULA_RECALL_NORMALIZATION",
  "POLARITY_NEGATION_ASSIST",
  "SYNDROME_HYPOTHESIS_RERANK",
]) {
  assert.match(
    composeSource,
    new RegExp(`${enabledByDefaultAssist}: \\$\\{${enabledByDefaultAssist}:-true\\}`),
    `${enabledByDefaultAssist} must be visible in the production container contract`,
  );
  assert.match(
    envExampleSource,
    new RegExp(`^${enabledByDefaultAssist}=true$`, "m"),
    `${enabledByDefaultAssist} must be documented in the environment template`,
  );
}
assert.match(
  composeSource,
  /CDSS_MODEL_RATE_LIMIT_PER_10_MIN: \$\{CDSS_MODEL_RATE_LIMIT_PER_10_MIN:-60\}/,
  "the production container must receive the documented per-tenant model rate limit",
);
assert.match(
  envExampleSource,
  /^CDSS_MODEL_RATE_LIMIT_PER_10_MIN=60$/m,
  "the deployable environment template must document the production model rate limit",
);
// 2026-09-19 owner 裁定：只用 qwen3.8-flash + qwen3.8-max 两档。首轮与小任务 flash，修复轮与 M04 传输兜底 max。
// 事实层三相位全用 max（整套黄金基线 222 例定档）：flash 抽取常漏标低体温 35.5℃ 与「否认头晕，剧烈头痛」
// （冷启动各 3 次只过 1 次）；flash 复核更慢且超时/不合格输出多，整套 21 条失败；全 max 只剩 1 条偏保守的失败。
// 2026-09-24（提速第三批）：M02 出题、M03 两半、M04 首轮改跑 DeepSeek，Qwen strict 退为兜底——
// 不合 schema / 连不上时由 PRIMARY_STRUCTURED_FALLBACK_MODEL 对同一份提示词重生成。
const expectedModelMatrix = {
  OPENAI_MODEL: "deepseek-v4-flash",
  BAILIAN_QWEN_MODEL: "qwen3.8-flash",
  PRIMARY_QUESTION_MODEL: "deepseek-flash",
  PRIMARY_STRUCTURED_FALLBACK_MODEL: "qwen3.8-flash",
  PRIMARY_DIAGNOSE_MODEL: "deepseek-flash",
  PRIMARY_DIAGNOSE_REPAIR_MODEL: "qwen3.8-max",
  PRIMARY_PRESCRIBE_MODEL: "deepseek-flash",
  PRIMARY_PRESCRIBE_CONNECT_FALLBACK_MODEL: "qwen3.8-max",
  PRIMARY_PRESCRIBE_REPAIR_MODEL: "qwen3.8-max",
  CLINICAL_FACTS_MODEL: "qwen3.8-max",
  CLINICAL_FACTS_REVIEW_MODEL: "qwen3.8-max",
  CLINICAL_FACTS_ADJUDICATION_MODEL: "qwen3.8-max",
  // 小任务改跑 DeepSeek（2026-09-20）。主生成留在 Qwen：严格 JSON Schema 是 9/19 换回 Qwen 的全部理由。
  CONTROLLED_TERMINOLOGY_MODEL: "deepseek-flash",
  PRIMARY_REVIEW_MODEL: "deepseek-flash",
};
{
  // 结构化阶段靠供应商解码器执行 schema；矩阵里任何一个 Qwen 档没有严格模式，对应任务就退回
  // json_object，「schema 对不上」这一整类问题会原样回来（9/11–9/19 的 DeepSeek 期即如此）。
  const { textModelCapabilities } = await jiti.import("../src/lib/text-model-capabilities.ts");
  for (const [modelVariable, model] of Object.entries(expectedModelMatrix)) {
    if (!model.startsWith("qwen")) continue;
    assert.equal(textModelCapabilities(model).strictJsonSchema, true,
      `${modelVariable}=${model} must support strict JSON Schema`);
  }
}
assert.match(composeSource, /STRUCTURED_INITIAL_CONNECT_TIMEOUT_MS: \$\{STRUCTURED_INITIAL_CONNECT_TIMEOUT_MS:-25000\}/);
assert.match(envExampleSource, /^STRUCTURED_INITIAL_CONNECT_TIMEOUT_MS=25000$/m);
assert.match(composeSource, /AI_TEXT_PROVIDER: \$\{AI_TEXT_PROVIDER:-bailian-qwen\}/);
{
  // 跨厂商解析（2026-09-20）：per-stage 模型变量过去一律套用主 provider 的端点与密钥，只换模型名。
  // 主 provider 是百炼时把 deepseek-* 填进这些变量，请求会带着 DeepSeek 的模型名打到 dashscope，
  // 100% 上游失败；而小任务失败全是静默 fail-open 到确定性结果，「配错了」与「模型没意见」无法区分。
  const { textModelConfigForModel } = await jiti.import("../src/lib/text-model.ts");
  const withEnv = async (patch, fn) => {
    const saved = Object.fromEntries(Object.keys(patch).map((key) => [key, process.env[key]]));
    Object.entries(patch).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
    try { return await fn(); } finally {
      Object.entries(saved).forEach(([key, value]) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      });
    }
  };
  const qwenPrimary = {
    AI_TEXT_PROVIDER: "bailian-qwen",
    BAILIAN_QWEN_API_KEY: "test-qwen-key",
    BAILIAN_QWEN_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    BAILIAN_QWEN_MODEL: "qwen3.8-flash",
    OPENAI_API_KEY: "test-deepseek-key",
    OPENAI_BASE_URL: "https://api.deepseek.com",
    OPENAI_MODEL: "deepseek-flash",
    CDSS_TEXT_MODEL_ALLOWED_HOSTS: "",
    CDSS_DEEPSEEK_ALLOWED_HOSTS: "",
  };
  await withEnv(qwenPrimary, () => {
    const cross = textModelConfigForModel("deepseek-flash");
    assert.equal(cross.configured, true, "配齐 OPENAI_* 时跨厂商小任务必须可用");
    assert.equal(cross.model, "deepseek-flash");
    assert.equal(new URL(cross.baseUrl).hostname, "api.deepseek.com",
      "DeepSeek 模型必须走 DeepSeek 端点，绝不能沿用主 provider 的 dashscope 端点");
    assert.equal(cross.apiKey, "test-deepseek-key", "跨厂商必须改用该家族自己的密钥");
    const same = textModelConfigForModel("qwen3.8-max");
    assert.equal(new URL(same.baseUrl).hostname, "dashscope.aliyuncs.com");
    assert.equal(same.apiKey, "test-qwen-key");
  });
  await withEnv({ ...qwenPrimary, OPENAI_API_KEY: "" }, () => {
    const cross = textModelConfigForModel("deepseek-flash");
    assert.equal(cross.configured, false, "目标家族缺密钥必须 fail-closed，调用方退回确定性结果");
    assert.equal(cross.disabledReason, "missing_api_key");
  });
  await withEnv({ ...qwenPrimary, OPENAI_BASE_URL: "https://evil.example.com/v1" }, () => {
    assert.equal(textModelConfigForModel("deepseek-flash").configured, false,
      "端点不在批准白名单必须 fail-closed");
  });
  await withEnv(qwenPrimary, () => {
    assert.equal(textModelConfigForModel("gpt-4o").configured, false, "未批准模型一律 fail-closed");
  });
  // 严格兜底（2026-09-24）：DeepSeek 首轮只有 json_object，不合 schema 或连不上时必须换到一个
  // 支持严格 schema、且端点已配齐的模型；严格模型自己不需要兜底。
  await withEnv({ ...qwenPrimary, PRIMARY_STRUCTURED_FALLBACK_MODEL: undefined }, () => {
    assert.equal(structuredStrictFallbackModel("deepseek-flash"), "qwen3.8-flash", "缺省兜底是改动前的线上首轮模型");
    assert.equal(structuredStrictFallbackModel("qwen3.8-flash"), undefined, "严格模型不设兜底");
  });
  await withEnv({ ...qwenPrimary, PRIMARY_STRUCTURED_FALLBACK_MODEL: "qwen3.8-max" }, () => {
    assert.equal(structuredStrictFallbackModel("deepseek-flash"), "qwen3.8-max");
  });
  await withEnv({ ...qwenPrimary, PRIMARY_STRUCTURED_FALLBACK_MODEL: "deepseek-v4-pro" }, () => {
    assert.equal(structuredStrictFallbackModel("deepseek-flash"), undefined, "不支持严格 schema 的兜底等于没有兜底");
  });
  await withEnv({ ...qwenPrimary, PRIMARY_STRUCTURED_FALLBACK_MODEL: "none" }, () => {
    assert.equal(structuredStrictFallbackModel("deepseek-flash"), undefined, "none 显式关闭兜底");
  });
  await withEnv({ ...qwenPrimary, AI_TEXT_PROVIDER: "openai-compatible", BAILIAN_QWEN_API_KEY: "", PRIMARY_STRUCTURED_FALLBACK_MODEL: undefined }, () => {
    assert.equal(structuredStrictFallbackModel("deepseek-flash"), undefined, "兜底家族缺密钥时 fail-closed，不假装有兜底");
  });
  await withEnv({ ...qwenPrimary, PRIMARY_STRUCTURED_FALLBACK_MODEL: undefined, PRIMARY_PRESCRIBE_CONNECT_FALLBACK_MODEL: "qwen3.8-max" }, () => {
    assert.equal(modelForInitialConnectAttempt("deepseek-flash", "prescribe", 0), "deepseek-flash");
    assert.equal(modelForInitialConnectAttempt("deepseek-flash", "prescribe", 1), "qwen3.8-flash",
      "DeepSeek 首轮连不上时换到严格兜底（跨家族，端点按模型解析）");
    assert.equal(modelForInitialConnectAttempt("deepseek-flash", "diagnose", 1), "qwen3.8-flash",
      "M03 首轮同样有传输兜底——DeepSeek 402 欠费不能再让全链瘫痪");
    assert.equal(modelForInitialConnectAttempt("deepseek-flash", undefined, 1), "deepseek-flash", "非结构化阶段不换模型");
  });
  {
    // 阶段模型可以是另一家：那一家缺 key 时主模型照样「已配置」，健康检查必须逐阶段报出来。
    const { GET: healthGet } = await jiti.import("../src/app/api/diagnosis/health/route.ts");
    const readHealth = async () => (await healthGet(new Request("http://localhost/api/diagnosis/health"))).json();
    await withEnv({ ...qwenPrimary, PRIMARY_DIAGNOSE_MODEL: "deepseek-flash", PRIMARY_PRESCRIBE_MODEL: "deepseek-flash",
      PRIMARY_QUESTION_MODEL: "deepseek-flash", OPENAI_API_KEY: "" }, async () => {
      const body = await readHealth();
      for (const reason of ["question_model_not_configured", "diagnose_model_not_configured", "prescribe_model_not_configured"]) {
        assert.ok(body.degradedReasons.includes(reason), `缺 DeepSeek 密钥必须报 ${reason}`);
      }
      assert.equal(body.strictReady, false, "阶段模型不可用时不得判发布就绪");
    });
    await withEnv({ ...qwenPrimary, PRIMARY_DIAGNOSE_MODEL: "deepseek-flash", PRIMARY_PRESCRIBE_MODEL: "deepseek-flash",
      PRIMARY_QUESTION_MODEL: "deepseek-flash" }, async () => {
      const body = await readHealth();
      assert.ok(!body.degradedReasons.some((reason) => /^(question|diagnose|prescribe)_model_not_configured$/.test(reason)),
        "两家都配齐时不得误报");
    });
  }
  await withEnv({ ...qwenPrimary, PRIMARY_QUESTION_MODEL: undefined }, () => {
    assert.equal(modelForQuestionStage("qwen3.8-flash"), "qwen3.8-flash", "未配置时 M02 出题跟随主模型");
  });
  await withEnv({ ...qwenPrimary, PRIMARY_QUESTION_MODEL: "deepseek-flash" }, async () => {
    assert.equal(modelForQuestionStage("qwen3.8-flash"), "deepseek-flash");
    // 整条 M02 调用：出题请求必须带着 DeepSeek 的模型名与密钥打到 DeepSeek 端点，而不是主 provider。
    const savedFetch = globalThis.fetch;
    const seen = [];
    globalThis.fetch = async (url, init) => {
      seen.push({ host: new URL(String(url)).hostname, auth: init.headers.Authorization, body: JSON.parse(init.body) });
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "{}" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, {
        headers: { "Content-Type": "text/event-stream" },
      });
    };
    try {
      const response = await callDiagnosisStream("synthetic M02 prompt", "deepseek", undefined, "question", {});
      await response.text();
    } finally {
      globalThis.fetch = savedFetch;
    }
    assert.equal(seen.length, 1);
    assert.equal(seen[0].host, "api.deepseek.com", "M02 出题走 DeepSeek 端点");
    assert.equal(seen[0].auth, "Bearer test-deepseek-key");
    assert.equal(seen[0].body.model, "deepseek-flash");
    assert.deepEqual(seen[0].body.response_format, { type: "json_object" });
  });
}
assert.match(envExampleSource, /^AI_TEXT_PROVIDER=bailian-qwen$/m);
for (const [modelVariable, expectedModel] of Object.entries(expectedModelMatrix)) {
  assert.match(
    composeSource,
    new RegExp(`${modelVariable}: \\$\\{${modelVariable}:-${expectedModel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\}`),
    `${modelVariable} must use the approved production model matrix`,
  );
  assert.match(envExampleSource, new RegExp(`^${modelVariable}=${expectedModel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
}
for (const bailianVariable of [
  "BAILIAN_QWEN_BASE_URL",
  "BAILIAN_QWEN_MODEL",
]) {
  assert.match(
    composeSource,
    new RegExp(`${bailianVariable}: \\\${${bailianVariable}:-`),
    `${bailianVariable} must be forwarded into the production container`,
  );
  assert.match(
    envExampleSource,
    new RegExp(`^${bailianVariable}=`, "m"),
    `${bailianVariable} must be documented in the deployable environment template`,
  );
}
assert.match(envExampleSource, /^BAILIAN_QWEN_API_KEY=$/m);
assert.match(composeSource, /BAILIAN_QWEN_API_KEY: \$\{BAILIAN_QWEN_API_KEY:\?set BAILIAN_QWEN_API_KEY\}/,
  "Qwen-default production must fail startup when the Bailian key is absent");
assert.match(composeSource, /CDSS_TEXT_MODEL_ALLOWED_HOSTS: \$\{CDSS_TEXT_MODEL_ALLOWED_HOSTS:-\}/);
assert.match(envExampleSource, /^CDSS_TEXT_MODEL_ALLOWED_HOSTS=$/m);

const originalGlmKey = process.env.GLM_API_KEY;
const originalGlmVisionEnabled = process.env.GLM_VISION_ENABLED;
process.env.GLM_API_KEY = "configured-for-test";
process.env.GLM_VISION_ENABLED = "false";
assert.equal(isTongueVisionEnabled(), false, "an explicit false flag must retain the degraded manual-entry deployment mode");
assert.equal(isTongueVisionConfigured(), false, "an explicitly disabled provider must remain unavailable even with a stored key");
delete process.env.GLM_VISION_ENABLED;
assert.equal(isTongueVisionEnabled(), true, "tongue vision must be enabled by default");
assert.equal(isTongueVisionConfigured(), true, "the default-enabled tongue provider becomes configured when a key is present");
const noImageGlm = await callDiagnosisStream("病例文本不得发给GLM", "glm");
assert.equal(noImageGlm.status, 400, "GLM route must reject text-only requests");
const visionPrompt = buildTongueVisionPrompt();
assert.doesNotMatch(visionPrompt, /## 患者输入|"""|GLM_TEXT_LEAK_MARKER/, "GLM prompt must contain no case-text slots");
if (originalGlmKey == null) delete process.env.GLM_API_KEY;
else process.env.GLM_API_KEY = originalGlmKey;
if (originalGlmVisionEnabled == null) delete process.env.GLM_VISION_ENABLED;
else process.env.GLM_VISION_ENABLED = originalGlmVisionEnabled;

const modelEnv = Object.fromEntries([
  "AI_TEXT_PROVIDER", "AI_PROVIDER", "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL", "CDSS_DEEPSEEK_ALLOWED_HOSTS", "CDSS_TEXT_MODEL_ALLOWED_HOSTS",
  "BAILIAN_QWEN_API_KEY", "BAILIAN_QWEN_BASE_URL", "BAILIAN_QWEN_MODEL", "PRIMARY_DIAGNOSE_MODEL",
].map((key) => [key, process.env[key]]));
process.env.OPENAI_API_KEY = "test-key";
process.env.OPENAI_BASE_URL = "https://api.deepseek.com";
process.env.OPENAI_MODEL = "deepseek-v4-flash";
process.env.AI_TEXT_PROVIDER = "openai-compatible";
assert.equal(getPrimaryTextModelConfig().configured, true, "approved DeepSeek text route should be configured");
process.env.OPENAI_MODEL = "glm-5.1";
assert.equal(getPrimaryTextModelConfig().disabledReason, "vendor_policy", "non-DeepSeek text model must be rejected");
process.env.OPENAI_MODEL = "deepseek-v4-flash";
process.env.OPENAI_BASE_URL = "https://unapproved.example.com/v1";
assert.equal(getPrimaryTextModelConfig().disabledReason, "vendor_policy", "unapproved text endpoint must be rejected");
process.env.AI_TEXT_PROVIDER = "bailian-qwen";
process.env.BAILIAN_QWEN_API_KEY = "test-qwen-key";
process.env.BAILIAN_QWEN_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
process.env.BAILIAN_QWEN_MODEL = "qwen3.7-plus";
assert.equal(getPrimaryTextModelConfig().configured, true, "approved Qwen text route should be configured");
process.env.BAILIAN_QWEN_MODEL = "glm-5.1";
assert.equal(getPrimaryTextModelConfig().disabledReason, "vendor_policy", "non-Qwen model must be rejected on Bailian route");
for (const status of [408, 425, 429, 500, 502, 503, 504]) assert.equal(isRetryableProviderHttpStatus(status), true, `retryable HTTP ${status}`);
for (const status of [400, 401, 403, 404, 409, 422]) assert.equal(isRetryableProviderHttpStatus(status), false, `non-transient HTTP ${status}`);
assert.equal(structuredRepairFailureIsUpstreamUnavailable({ ok: false, reason: "retry_http_error", status: 503 }), true);
assert.equal(structuredRepairFailureIsUpstreamUnavailable({ ok: false, reason: "retry_http_error", status: 401 }), false);
assert.equal(structuredRepairFailureIsUpstreamUnavailable({ ok: false, reason: "retry_timeout_or_cancelled" }, { parentAborted: true }), false);
assert.equal(structuredRepairFailureIsUpstreamUnavailable({ ok: false, reason: "retry_budget_exhausted" }), false);
assert.equal(structuredRepairFailureIsUpstreamUnavailable({ ok: false, reason: "text_model_vendor_policy" }), false);
// 首轮生成的两次传输尝试全失败时，必须用「上游不可用」专用签名页，
// 不得把服务故障签成「生成内容没通过合同」。HTTP 503 与网络异常是两个独立入口。
process.env.BAILIAN_QWEN_MODEL = "qwen3.7-plus";
delete process.env.PRIMARY_DIAGNOSE_MODEL;
{
  const originalFetch = globalThis.fetch;
  const runInitialFailure = async (mode, stage = "diagnose") => {
    let attempts = 0;
    globalThis.fetch = async () => {
      attempts += 1;
      if (mode === "network") throw new TypeError("simulated network failure");
      return new Response("temporary outage", { status: 503 });
    };
    const response = await callDiagnosisStream("test prompt", "deepseek", undefined, "markdown", {
      structuredStage: stage,
      ...(stage === "diagnose" ? { authoritativeTruncateFallback: true } : {}),
      truncateFallback: "SIGNED_CONTRACT_FALLBACK",
      upstreamUnavailableFallback: "SIGNED_UPSTREAM_UNAVAILABLE_FALLBACK",
      ...(stage === "prescribe" ? { outputTransform: (value) => `TRANSFORMED:${value}` } : {}),
    });
    const body = await response.text();
    assert.equal(attempts, 2, `${mode}: initial generation should consume exactly two bounded attempts`);
    assert.match(body, stage === "prescribe" ? /模型服务.*不可用/ : /SIGNED_UPSTREAM_UNAVAILABLE_FALLBACK/,
      `${mode}: transport failure must retain upstream attribution`);
    assert.doesNotMatch(body, /SIGNED_CONTRACT_FALLBACK/, `${mode}: transport failure must not be signed as a content-contract failure`);
  };
  try {
    await runInitialFailure("http503");
    await runInitialFailure("network");
    await runInitialFailure("http503", "prescribe");
    await runInitialFailure("network", "prescribe");

    let streamAttempts = 0;
    globalThis.fetch = async () => {
      streamAttempts += 1;
      return new Response(new ReadableStream({
        start(controller) {
          controller.error(new TypeError("simulated socket disconnect"));
        },
      }), { status: 200 });
    };
    const brokenStream = await callDiagnosisStream("test prompt", "deepseek", undefined, "markdown", {
      structuredStage: "diagnose",
      authoritativeTruncateFallback: true,
      truncateFallback: "SIGNED_CONTRACT_FALLBACK",
      upstreamUnavailableFallback: "SIGNED_UPSTREAM_UNAVAILABLE_FALLBACK",
    });
    const brokenStreamBody = await brokenStream.text();
    assert.equal(streamAttempts, 1, "a stream that disconnects after HTTP 200 must not replay generation blindly");
    assert.match(brokenStreamBody, /SIGNED_UPSTREAM_UNAVAILABLE_FALLBACK/);
    assert.doesNotMatch(brokenStreamBody, /SIGNED_CONTRACT_FALLBACK/);

    for (const stage of ["diagnose", "prescribe"]) {
      let earlyEofAttempts = 0;
      globalThis.fetch = async () => {
        earlyEofAttempts += 1;
        return new Response(new ReadableStream({
          start(controller) {
            controller.close();
          },
        }), { status: 200 });
      };
      const earlyEof = await callDiagnosisStream("test prompt", "deepseek", undefined, "markdown", {
        structuredStage: stage,
        ...(stage === "diagnose" ? { authoritativeTruncateFallback: true } : {}),
        truncateFallback: "SIGNED_CONTRACT_FALLBACK",
        upstreamUnavailableFallback: "SIGNED_UPSTREAM_UNAVAILABLE_FALLBACK",
        ...(stage === "prescribe" ? { outputTransform: (value) => `TRANSFORMED:${value}` } : {}),
      });
      const earlyEofBody = await earlyEof.text();
      assert.equal(earlyEofAttempts, 1, `${stage}: HTTP 200 early EOF must not replay clinical generation`);
      assert.match(earlyEofBody, stage === "prescribe" ? /模型服务.*不可用/ : /SIGNED_UPSTREAM_UNAVAILABLE_FALLBACK/,
        `${stage}: missing provider DONE is an upstream truncation`);
      assert.doesNotMatch(earlyEofBody, /SIGNED_CONTRACT_FALLBACK/);
    }

    let nonTransientAttempts = 0;
    globalThis.fetch = async () => {
      nonTransientAttempts += 1;
      return new Response("unauthorized", { status: 401 });
    };
    const unauthorized = await callDiagnosisStream("test prompt", "deepseek", undefined, "markdown", {
      structuredStage: "diagnose",
      authoritativeTruncateFallback: true,
      truncateFallback: "SIGNED_CONTRACT_FALLBACK",
      upstreamUnavailableFallback: "SIGNED_UPSTREAM_UNAVAILABLE_FALLBACK",
    });
    const unauthorizedBody = await unauthorized.text();
    assert.equal(nonTransientAttempts, 1, "401 must not consume the transient retry");
    assert.match(unauthorizedBody, /SIGNED_CONTRACT_FALLBACK/);
    assert.doesNotMatch(unauthorizedBody, /SIGNED_UPSTREAM_UNAVAILABLE_FALLBACK/);

    const cancelledRequest = new AbortController();
    globalThis.fetch = async (_url, init) => await new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
    const cancelled = await callDiagnosisStream("test prompt", "deepseek", undefined, "markdown", {
      requestSignal: cancelledRequest.signal,
      structuredStage: "diagnose",
      authoritativeTruncateFallback: true,
      truncateFallback: "SIGNED_CONTRACT_FALLBACK",
      upstreamUnavailableFallback: "SIGNED_UPSTREAM_UNAVAILABLE_FALLBACK",
    });
    setTimeout(() => cancelledRequest.abort(), 10);
    const cancelledBody = await cancelled.text();
    assert.doesNotMatch(cancelledBody, /SIGNED_(?:CONTRACT|UPSTREAM)/, "client cancellation must emit no signed fallback page");

    globalThis.fetch = async () => {
      throw new TypeError("network failure after orchestration deadline");
    };
    const deadline = await callDiagnosisStream("test prompt", "deepseek", undefined, "markdown", {
      structuredOrchestrationStartedAt: Date.now() - 500_000,
      structuredStage: "prescribe",
      truncateFallback: "SIGNED_CONTRACT_FALLBACK",
      upstreamUnavailableFallback: "SIGNED_UPSTREAM_UNAVAILABLE_FALLBACK",
      deadlineFallback: "SIGNED_DEADLINE_FALLBACK",
      outputTransform: (value) => `TRANSFORMED:${value}`,
    });
    const deadlineBody = await deadline.text();
    assert.match(deadlineBody, /超过时限.*尚未形成.*个体化/, "M04 orchestration deadline must outrank upstream transport attribution");
    assert.match(deadlineBody, /CDSS_NON_DOSE_PRESCRIPTION/);
    assert.doesNotMatch(deadlineBody, /SIGNED_(?:CONTRACT|UPSTREAM)_FALLBACK/);
  } finally {
    globalThis.fetch = originalFetch;
  }
}
for (const [key, value] of Object.entries(modelEnv)) {
  if (value == null) delete process.env[key];
  else process.env[key] = value;
}

// A per-attempt timeout must never poison the shared parent signal. The second attempt therefore
// remains usable, while explicit stage cancellation still propagates into each child attempt.
{
  const originalFetch = globalThis.fetch;
  const parent = new AbortController();
  let calls = 0;
  try {
    globalThis.fetch = async (_url, init) => {
      calls += 1;
      if (calls === 1) {
        return await new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        });
      }
      return new Response("ok", { status: 200 });
    };
    await assert.rejects(
      () => fetchWithConnectTimeout("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", {}, parent, Date.now() + 500, 15),
      /模型连接超时/,
    );
    assert.equal(parent.signal.aborted, false, "one connect timeout must not abort the stage parent");
    const recovered = await fetchWithConnectTimeout(
      "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", {}, parent, Date.now() + 500, 100,
    );
    assert.equal(recovered.status, 200, "the bounded second connection attempt must remain usable");

    globalThis.fetch = async (_url, init) => await new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
    const cancelledParent = new AbortController();
    const pending = fetchWithConnectTimeout(
      "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", {}, cancelledParent, Date.now() + 500, 400,
    );
    cancelledParent.abort(new DOMException("client cancelled", "AbortError"));
    await assert.rejects(pending, /client cancelled|aborted/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

{
  const previousFallback = process.env.PRIMARY_PRESCRIBE_CONNECT_FALLBACK_MODEL;
  process.env.PRIMARY_PRESCRIBE_CONNECT_FALLBACK_MODEL = "qwen3.7-plus";
  assert.equal(modelForInitialConnectAttempt("qwen3.8-max", "prescribe", 0), "qwen3.8-max");
  assert.equal(modelForInitialConnectAttempt("qwen3.8-max", "prescribe", 1), "qwen3.7-plus");
  assert.equal(modelForInitialConnectAttempt("qwen3.8-max", "diagnose", 1), "qwen3.8-max");
  process.env.PRIMARY_PRESCRIBE_CONNECT_FALLBACK_MODEL = "deepseek-v4-flash";
  assert.equal(modelForInitialConnectAttempt("qwen3.8-max", "prescribe", 1), "qwen3.8-max",
    "transport fallback must not cross the approved vendor/model family boundary");
  delete process.env.PRIMARY_PRESCRIBE_CONNECT_FALLBACK_MODEL;
  assert.equal(modelForInitialConnectAttempt("qwen3.8-flash", "prescribe", 1), "qwen3.8-max",
    "unconfigured Qwen transport fallback must stay inside the approved flash/max pair");
  if (previousFallback == null) delete process.env.PRIMARY_PRESCRIBE_CONNECT_FALLBACK_MODEL;
  else process.env.PRIMARY_PRESCRIBE_CONNECT_FALLBACK_MODEL = previousFallback;
}

process.env.RXAI_AUDIT_ENABLED = "true";
process.env.RXAI_AUDIT_BASE_URL = "http://127.0.0.1:18092";
process.env.RXAI_AUDIT_TOKEN = "test-audit-token";
process.env.RXAI_AUDIT_ALLOW_INSECURE_HTTP = "true";
const { probeRxAuditTransport } = await jiti.import("../src/lib/rxaudit.ts");
let auditProbeRequest;
globalThis.fetch = async (_url, init) => {
  auditProbeRequest = init;
  return new Response("unauthorized", { status: 401 });
};
const unauthorizedAudit = await probeRxAuditTransport();
assert.equal(unauthorizedAudit.ok, false);
assert.equal(unauthorizedAudit.reason, "unauthorized", "strict readiness must not treat an audit 401 as healthy");
assert.equal(auditProbeRequest?.method, "POST", "the audit readiness probe must exercise the authenticated POST boundary");
assert.equal(auditProbeRequest?.body, "{}", "the audit readiness probe must send no patient or prescription data");
globalThis.fetch = async () => new Response("invalid payload", { status: 422 });
const authenticatedAudit = await probeRxAuditTransport();
assert.equal(authenticatedAudit.ok, true, "an authenticated request-validation response proves the credential reached the audit service");
process.env.RXAI_AUDIT_ENABLED = "false";
let skippedAuditFetches = 0;
globalThis.fetch = async () => { skippedAuditFetches += 1; return new Response("invalid payload", { status: 422 }); };
const skippedAudit = await probeRxAuditTransport();
assert.equal(skippedAudit.ok, false, "an intentionally skipped probe must never claim provider health");
assert.equal(skippedAudit.reason, "disabled");
assert.equal(skippedAuditFetches, 0, "explicit audit disable must stop even credential-only probes");
process.env.RXAI_AUDIT_ENABLED = "true";

await assert.rejects(
  () => readResponseTextLimited(new Response("0123456789", { headers: { "Content-Length": "10" } }), 5),
  UpstreamResponseTooLargeError,
);
const streamed = new ReadableStream({
  start(controller) {
    controller.enqueue(new TextEncoder().encode("1234"));
    controller.enqueue(new TextEncoder().encode("5678"));
    controller.close();
  },
});
await assert.rejects(() => readResponseTextLimited(new Response(streamed), 5), UpstreamResponseTooLargeError);
assert.equal(await readResponseTextLimited(new Response("正常响应"), 64), "正常响应");

let wedgedReaderAborted = false;
let wedgedReaderCancelCalled = false;
const wedgedReader = {
  read: () => new Promise(() => {}),
  cancel: () => {
    wedgedReaderCancelCalled = true;
    return new Promise(() => {});
  },
};
const wedgedReaderStartedAt = Date.now();
await assert.rejects(
  () => readProviderChunk(wedgedReader, Date.now() + 20, () => {
    wedgedReaderAborted = true;
  }),
  /模型流长时间无响应|模型流总时长超时/,
);
assert.equal(wedgedReaderAborted, true, "stream timeout must abort the upstream transport before body cleanup");
assert.equal(wedgedReaderCancelCalled, true, "stream timeout still starts provider-body cleanup");
assert.ok(
  Date.now() - wedgedReaderStartedAt < 500,
  "a provider cancel() promise that never resolves must not stretch the orchestration deadline",
);

let sharedCancellationCalls = 0;
const sharedFailedResponse = new Response(new ReadableStream({
  start(controller) {
    controller.enqueue(new TextEncoder().encode("failed"));
  },
  cancel() {
    sharedCancellationCalls += 1;
  },
}), { status: 503 });
await cancelResponseBody(sharedFailedResponse);
assert.equal(sharedCancellationCalls, 1, "all adapters share one non-success response cleanup contract");

let fetchCalls = 0;
const evidenceRequestBodies = [];
let releaseFetch;
const fetchGate = new Promise((resolve) => { releaseFetch = resolve; });
globalThis.fetch = async (_url, init) => {
  fetchCalls += 1;
  evidenceRequestBodies.push(JSON.parse(String(init?.body || "{}")));
  await fetchGate;
  return new Response(JSON.stringify({ code: 200, data: { list: [] } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};
const { fetchExternalEvidence, probeExternalEvidenceSources } = await jiti.import("../src/lib/evimed-guide.ts");
const probes = [probeExternalEvidenceSources(), probeExternalEvidenceSources(), probeExternalEvidenceSources()];
await new Promise((resolve) => setTimeout(resolve, 20));
releaseFetch();
await Promise.all(probes);
assert.equal(fetchCalls, 1, "concurrent strict health probes should share one documented guide request");
assert.deepEqual(Object.keys(evidenceRequestBodies[0] || {}).sort(), ["count", "query"], "EviMed requests must contain only fields from the documented guide contract");

let cancelledFailureBodies = 0;
globalThis.fetch = async () => new Response(new ReadableStream({
  start(controller) {
    controller.enqueue(new TextEncoder().encode("upstream failure"));
  },
  cancel() {
    cancelledFailureBodies += 1;
  },
}), { status: 500 });
const failedEvidence = await fetchExternalEvidence("guide", "测试非成功响应释放");
assert.equal(failedEvidence.ok, false);
assert.equal(cancelledFailureBodies, 1, "EviMed non-success bodies must be cancelled before returning or retrying");

console.log(JSON.stringify({ cases: 36, failures: 0 }));


{
  const { createJiti } = await import("jiti");
  const chainJiti = createJiti(import.meta.url, { alias: {
    "@": `${process.cwd()}/src`,
    "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
  } });
  // ── M04 证据固定预算钳制 ──
  const { m04EvidencePromptBudgetChars } = await chainJiti.import("../src/lib/prompt-budget.ts");
  const savedBudget = process.env.PRIMARY_PRESCRIBE_EVIDENCE_MAX_CHARS;
  try {
    delete process.env.PRIMARY_PRESCRIBE_EVIDENCE_MAX_CHARS;
    assert.equal(m04EvidencePromptBudgetChars(), 15000, "默认 15k 字符——不再填满到 60k 提示词上限");
    process.env.PRIMARY_PRESCRIBE_EVIDENCE_MAX_CHARS = "999999";
    assert.equal(m04EvidencePromptBudgetChars(), 15000, "越界取值回落默认");
    process.env.PRIMARY_PRESCRIBE_EVIDENCE_MAX_CHARS = "20000";
    assert.equal(m04EvidencePromptBudgetChars(), 20000);
  } finally {
    if (savedBudget === undefined) delete process.env.PRIMARY_PRESCRIBE_EVIDENCE_MAX_CHARS; else process.env.PRIMARY_PRESCRIBE_EVIDENCE_MAX_CHARS = savedBudget;
  }
}


