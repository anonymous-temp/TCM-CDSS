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
  modelForInitialConnectAttempt, readProviderChunk } =
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
const expectedModelMatrix = {
  OPENAI_MODEL: "deepseek-v4-flash",
  BAILIAN_QWEN_MODEL: "qwen3.7-plus",
  PRIMARY_DIAGNOSE_MODEL: "qwen3.7-flash",
  PRIMARY_DIAGNOSE_REPAIR_MODEL: "qwen3.8-max",
  PRIMARY_PRESCRIBE_MODEL: "qwen3.8-max",
  PRIMARY_PRESCRIBE_CONNECT_FALLBACK_MODEL: "qwen3.7-plus",
  PRIMARY_PRESCRIBE_REPAIR_MODEL: "qwen3.8-max",
  PRIMARY_CLINICAL_REVIEW_MODEL: "qwen3.8-max",
  PRIMARY_DIAGNOSE_REVIEW_FALLBACK_MODEL: "qwen3.7-plus",
  PRIMARY_PRESCRIBE_REVIEW_FALLBACK_MODEL: "qwen3.7-plus",
  CLINICAL_FACTS_MODEL: "qwen3.7-flash",
  CLINICAL_FACTS_REVIEW_MODEL: "qwen3.8-max",
  CLINICAL_FACTS_ADJUDICATION_MODEL: "qwen3.7-plus",
  CONTROLLED_TERMINOLOGY_MODEL: "qwen3.7-flash",
};
assert.match(composeSource, /STRUCTURED_INITIAL_CONNECT_TIMEOUT_MS: \$\{STRUCTURED_INITIAL_CONNECT_TIMEOUT_MS:-25000\}/);
assert.match(envExampleSource, /^STRUCTURED_INITIAL_CONNECT_TIMEOUT_MS=25000$/m);
assert.match(composeSource, /AI_TEXT_PROVIDER: \$\{AI_TEXT_PROVIDER:-bailian-qwen\}/);
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
  "BAILIAN_QWEN_API_KEY", "BAILIAN_QWEN_BASE_URL", "BAILIAN_QWEN_MODEL",
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
