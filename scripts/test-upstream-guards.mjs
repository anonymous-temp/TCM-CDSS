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
const { isTongueVisionConfigured } = await jiti.import("../src/lib/diagnosis-api.ts");
const { callDiagnosisStream } = await jiti.import("../src/lib/diagnosis-api.ts");
const { buildTongueVisionPrompt } = await jiti.import("../src/lib/diagnosis-prompts.ts");
const { getPrimaryTextModelConfig } = await jiti.import("../src/lib/text-model.ts");
const { POST: collectPost } = await jiti.import("../src/app/api/diagnosis/collect/route.ts");

const collectRequest = (body) => new Request("http://localhost/api/diagnosis/collect", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
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
for (const modelVariable of [
  "OPENAI_MODEL",
  "PRIMARY_DIAGNOSE_MODEL",
  "PRIMARY_DIAGNOSE_REPAIR_MODEL",
  "PRIMARY_PRESCRIBE_MODEL",
  "PRIMARY_PRESCRIBE_REPAIR_MODEL",
  "PRIMARY_CLINICAL_REVIEW_MODEL",
  "PRIMARY_DIAGNOSE_REVIEW_FALLBACK_MODEL",
  "PRIMARY_PRESCRIBE_REVIEW_FALLBACK_MODEL",
  "CLINICAL_FACTS_MODEL",
  "CLINICAL_FACTS_REPAIR_MODEL",
  "CLINICAL_FACTS_REVIEW_MODEL",
  "CLINICAL_FACTS_ADJUDICATION_MODEL",
]) {
  assert.match(
    composeSource,
    new RegExp(`${modelVariable}: \\$\\{${modelVariable}:-deepseek-v4-pro\\}`),
    `${modelVariable} must be pinned to DeepSeek V4 Pro in the production container contract`,
  );
}

const originalGlmKey = process.env.GLM_API_KEY;
const originalGlmVisionEnabled = process.env.GLM_VISION_ENABLED;
process.env.GLM_API_KEY = "configured-but-not-enabled";
process.env.GLM_VISION_ENABLED = "false";
assert.equal(isTongueVisionConfigured(), false, "a stored GLM key must not implicitly enable a provider");
process.env.GLM_VISION_ENABLED = "true";
assert.equal(isTongueVisionConfigured(), true, "tongue vision requires both an explicit rollout flag and a key");
const noImageGlm = await callDiagnosisStream("病例文本不得发给GLM", "glm");
assert.equal(noImageGlm.status, 400, "GLM route must reject text-only requests");
const visionPrompt = buildTongueVisionPrompt();
assert.doesNotMatch(visionPrompt, /## 患者输入|"""|GLM_TEXT_LEAK_MARKER/, "GLM prompt must contain no case-text slots");
if (originalGlmKey == null) delete process.env.GLM_API_KEY;
else process.env.GLM_API_KEY = originalGlmKey;
if (originalGlmVisionEnabled == null) delete process.env.GLM_VISION_ENABLED;
else process.env.GLM_VISION_ENABLED = originalGlmVisionEnabled;

const modelEnv = Object.fromEntries([
  "AI_TEXT_PROVIDER", "AI_PROVIDER", "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL", "CDSS_DEEPSEEK_ALLOWED_HOSTS",
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
for (const [key, value] of Object.entries(modelEnv)) {
  if (value == null) delete process.env[key];
  else process.env[key] = value;
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

console.log(JSON.stringify({ cases: 34, failures: 0 }));
