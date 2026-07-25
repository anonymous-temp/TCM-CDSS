import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";
import { buildAuditPositiveControlState } from "./lib/primary-care-audit-positive-controls.mjs";

process.env.CDSS_CLINICAL_FACTS_BACKSTOP = "false";
process.env.AI_TEXT_PROVIDER = "bailian-qwen";
for (const key of [
  "BAILIAN_QWEN_API_KEY",
  "DASHSCOPE_API_KEY",
  "QWEN_API_KEY",
  "OPENAI_API_KEY",
]) delete process.env[key];
process.env.RXAI_AUDIT_ENABLED = "true";
process.env.RXAI_AUDIT_BASE_URL = "http://127.0.0.1:18092";
process.env.RXAI_AUDIT_TOKEN = "route-contract-token";
process.env.RXAI_AUDIT_ALLOW_INSECURE_HTTP = "true";
process.env.RXAI_AUDIT_RETRY_ATTEMPTS = "0";
// Pin the unified/attempt timeouts for the PASS and degraded phases so an inherited shell
// override cannot turn expected-PASS requests into rxaudit_total_timeout; the timeout phase
// below overrides these in-process and restores them to these pinned values.
const preExistingRxAuditTotalTimeout = process.env.RXAI_AUDIT_TOTAL_TIMEOUT_MS;
const preExistingRxAuditAttemptTimeout = process.env.RXAI_AUDIT_ATTEMPT_TIMEOUT_MS;
const preExistingRxAuditLegacyTimeout = process.env.RXAI_AUDIT_TIMEOUT_MS;
process.env.RXAI_AUDIT_TOTAL_TIMEOUT_MS = "15000";
process.env.RXAI_AUDIT_ATTEMPT_TIMEOUT_MS = "12000";
delete process.env.RXAI_AUDIT_TIMEOUT_MS;
process.env.REASONING_CONTRACT_SIGNING_KEY = "route-contract-signing-key-2026-at-least-32-bytes";

const capturedAuditBodies = [];
const capturedAuditHeaders = [];
const originalFetch = globalThis.fetch;
let providerMode = "pass";
globalThis.fetch = async (_url, init) => {
  capturedAuditBodies.push(JSON.parse(String(init?.body || "{}")));
  capturedAuditHeaders.push(new Headers(init?.headers));
  if (providerMode === "timeout") {
    return new Promise((_resolve, reject) => {
      const signal = init?.signal;
      const abort = () => reject(new DOMException("aborted", "AbortError"));
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
  }
  const sequence = capturedAuditBodies.length;
  return Response.json({
    code: 200,
    trace_id: `TRACE-ROUTE-${sequence}`,
    data: {
      audit_id: `AUDIT-ROUTE-${sequence}`,
      audit_result: "PASS",
      highest_risk_level: "INFO",
      need_manual_review: false,
      issues: [],
      ...(providerMode === "degraded" ? { degraded: true, degrade_reason: "interaction_component_timeout" } : {}),
    },
  });
};

try {
  for (const routePath of [
    "src/app/api/diagnosis/assess/route.ts",
    "src/app/api/diagnosis/his-scheme/route.ts",
    "src/app/api/diagnosis/post-prescription-risk/route.ts",
  ]) {
    const source = readFileSync(routePath, "utf8");
    assert.match(source, /runBoundedRxAudit\(/);
    assert.match(source, /buildUnavailableRxAuditSection\(/);
    assert.match(source, /mergeLocalHighRiskHerbPairIssues|buildLocalHighRiskHerbPairSection/);
    assert.match(source, /buildRxAuditCorrelation(?:Metadata|Marker)/);
    assert.match(source, /effectiveOutcome: effectiveAudit|effectiveAuditResult: "MANUAL_REVIEW"/);
    if (routePath.includes("his-scheme")) {
      assert.match(source, /auditResult: effectiveAudit\.auditResult/);
      assert.match(source, /auditAvailable: !providerAudit\.degraded/);
      assert.match(source, /needManualReview: effectiveAudit\.needManualReview/);
    }
  }

  const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src`, "server-only": "/dev/null" } });
  const { POST: assessPost } = await jiti.import("../src/app/api/diagnosis/assess/route.ts");
  const { POST: postRiskPost } = await jiti.import("../src/app/api/diagnosis/post-prescription-risk/route.ts");
  const {
    buildDiagnoseContractSignatureContext,
    buildPrescribeContractSignatureContext,
    signDiagnoseReasoning,
    signPrescribeReasoning,
    verifyDiagnoseReasoningSignature,
  } = await jiti.import("../src/lib/reasoning-contract-signature.ts");
  const control = {
    id: "route-audit-contract",
    mutation: "route-contract",
    patient: { sex: "男", age: 46 },
    chiefComplaint: "入睡困难三个月",
    diagnosis: "失眠障碍",
    syndrome: "心脾两虚证",
    pastHistory: "否认重要慢病",
    medicationHistory: "现服华法林3mg每日一次",
    allergyHistory: "否认药物过敏",
    herbs: [{ name: "黄芪", dose: "15g" }, { name: "酸枣仁", dose: "15g" }],
  };
  const unsignedState = buildAuditPositiveControlState(control);
  const prescribeReasoning = unsignedState.reasoningPrescribe;
  const unsignedDiagnose = {
    ...prescribeReasoning,
    stage: "diagnose",
    overview: {
      ...prescribeReasoning.overview,
      recommendedFormulaNames: [],
      formulaSelectionMode: "self_devised",
    },
    formula: null,
    nonPharma: null,
    clinicalReview: undefined,
  };
  const signedDiagnose = signDiagnoseReasoning(unsignedDiagnose, buildDiagnoseContractSignatureContext(unsignedState));
  const caseState = buildAuditPositiveControlState(control, signedDiagnose);
  assert.equal(verifyDiagnoseReasoningSignature(signedDiagnose, caseState), true, "signed route fixture must bind to the exact final clinical input");
  const request = (path, requestCaseState = caseState) => new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ caseState: requestCaseState }),
  });

  const assessResponse = await assessPost(request("/api/diagnosis/assess"));
  const assessText = await assessResponse.text();
  assert.equal(assessResponse.status, 200, assessText);
  assert.match(assessText, /现用药时间线或指代未能可靠结构化/);
  assert.match(assessText, /TCM_CDSS_RXAUDIT_CORRELATION/);
  assert.match(assessText, /AUDIT-ROUTE-1/);
  assert.match(assessText, /"type":"followup_timeline"/);
  assert.match(assessText, /"indicators":\[/);

  const postRiskResponse = await postRiskPost(request("/api/diagnosis/post-prescription-risk"));
  assert.equal(postRiskResponse.status, 200);
  const postRisk = await postRiskResponse.json();
  assert.ok(postRisk.audit.inputAdvisories.some((item) => item.code === "medication_semantics_unavailable"));
  assert.equal(postRisk.audit.auditId, "AUDIT-ROUTE-2");
  assert.equal(postRisk.audit.traceId, "TRACE-ROUTE-2");
  assert.equal(postRisk.audit.candidateIndex, 0);
  assert.equal(postRisk.audit.correlation.providerAuditResult, "PASS");
  assert.equal(postRisk.audit.correlation.effectiveAuditResult, "MANUAL_REVIEW");
  assert.ok(Array.isArray(postRisk.followupTimeline) && postRisk.followupTimeline.length > 0);
  assert.ok(postRisk.followupTimeline.every((item) =>
    typeof item.time === "string" &&
    typeof item.action === "string" &&
    Array.isArray(item.indicators) &&
    Array.isArray(item.triggers)));
  assert.doesNotMatch(postRisk.followup, /FOLLOWUP_TIMELINE_JSON/, "JSON route must return timeline as a typed field, not a Markdown sentinel");

  assert.equal(capturedAuditBodies.length, 2);
  for (const headers of capturedAuditHeaders) {
    assert.equal(headers.get("x-api-key"), "route-contract-token", "LingXi requests authenticate with the live X-API-Key contract");
    assert.equal(headers.get("authorization"), null, "the retired Bearer contract must not be sent in place of X-API-Key");
    assert.equal(headers.get("x-tenant-id"), "EH_INTERNET_HOSPITAL");
  }
  for (const body of capturedAuditBodies) {
    assert.deepEqual(body.data.prescription.patient.current_medications, [
      { drug_name: "华法林", dose_daily: "现服华法林3mg每日一次" },
    ]);
    assert.equal(body.data.prescription.patient.name, "匿名患者");
    assert.equal(body.data.options.enable_llm_audit, false, "synchronous M05 must not wait for optional audit-LLM enrichment");
    assert.doesNotMatch(JSON.stringify(body), /route-audit-contract/);
  }

  const missingFrequencyReasoning = structuredClone(caseState.reasoningPrescribe);
  delete missingFrequencyReasoning.formula.candidates[0].decoction.dosesPerDay;
  delete missingFrequencyReasoning.contractSignature;
  const unsignedMissingFrequencyState = {
    ...structuredClone(caseState),
    prescriptionRevision: undefined,
    reasoningPrescribe: missingFrequencyReasoning,
    reasoningV2: missingFrequencyReasoning,
  };
  const fetchesBeforeMissingFrequency = capturedAuditBodies.length;
  assert.throws(
    () => signPrescribeReasoning(
      missingFrequencyReasoning,
      buildPrescribeContractSignatureContext(unsignedMissingFrequencyState),
    ),
    /invalid M04 reasoning contract/,
    "an incomplete frequency dimension cannot obtain the M04 signature required by any audit route",
  );
  assert.equal(capturedAuditBodies.length, fetchesBeforeMissingFrequency, "an unsigned incomplete regimen cannot reach the external audit interface");

  const parseCorrelationMarker = (text) => {
    const encoded = text.match(/TCM_CDSS_RXAUDIT_CORRELATION:([^\s]+)\s*-->/)?.[1];
    assert.ok(encoded, "assess response must contain correlation metadata");
    return JSON.parse(decodeURIComponent(encoded));
  };

  providerMode = "degraded";
  const degradedAssessResponse = await assessPost(request("/api/diagnosis/assess"));
  assert.equal(degradedAssessResponse.status, 200);
  const degradedAssessText = await degradedAssessResponse.text();
  assert.match(degradedAssessText, /TCM_CDSS_RXAUDIT_STATUS:UNAVAILABLE:SERVICE_UNAVAILABLE/);
  assert.match(degradedAssessText, /审方降级.*不得视为完整 PASS/);
  const degradedAssessCorrelation = parseCorrelationMarker(degradedAssessText);
  assert.equal(degradedAssessCorrelation.providerDegraded, true);
  assert.equal(degradedAssessCorrelation.providerAuditResult, "PASS");
  assert.equal(degradedAssessCorrelation.effectiveAuditResult, "MANUAL_REVIEW");
  assert.equal(degradedAssessCorrelation.needManualReview, true);

  const degradedPostResponse = await postRiskPost(request("/api/diagnosis/post-prescription-risk"));
  assert.equal(degradedPostResponse.status, 200);
  const degradedPost = await degradedPostResponse.json();
  assert.equal(degradedPost.audit.degraded, true);
  assert.equal(degradedPost.audit.providerAuditResult, "PASS");
  assert.equal(degradedPost.audit.effectiveAuditResult, "MANUAL_REVIEW");
  assert.equal(degradedPost.audit.needManualReview, true);
  assert.equal(degradedPost.audit.correlation.providerDegraded, true);
  assert.equal(degradedPost.audit.correlation.effectiveAuditResult, "MANUAL_REVIEW");
  assert.ok(Array.isArray(degradedPost.followupTimeline) && degradedPost.followupTimeline.length > 0);
  assert.match(degradedPost.section, /审方降级.*不得视为完整 PASS/);

  const previousTotalTimeout = process.env.RXAI_AUDIT_TOTAL_TIMEOUT_MS;
  const previousAttemptTimeout = process.env.RXAI_AUDIT_ATTEMPT_TIMEOUT_MS;
  process.env.RXAI_AUDIT_TOTAL_TIMEOUT_MS = "1000";
  process.env.RXAI_AUDIT_ATTEMPT_TIMEOUT_MS = "30000";
  providerMode = "timeout";
  const timeoutStartedAt = Date.now();
  const timedOutPostResponse = await postRiskPost(request("/api/diagnosis/post-prescription-risk"));
  const timeoutElapsedMs = Date.now() - timeoutStartedAt;
  assert.equal(timedOutPostResponse.status, 200, "advisory audit timeout must not hard-block the workflow");
  assert.ok(timeoutElapsedMs >= 850 && timeoutElapsedMs < 2500, `unified audit timeout must be bounded, got ${timeoutElapsedMs}ms`);
  const timedOutPost = await timedOutPostResponse.json();
  assert.equal(timedOutPost.audit.reason, "rxaudit_total_timeout");
  assert.equal(timedOutPost.audit.degraded, true);
  assert.equal(timedOutPost.audit.effectiveAuditResult, "MANUAL_REVIEW");
  assert.equal(timedOutPost.audit.correlation.providerReason, "rxaudit_total_timeout");
  assert.equal(timedOutPost.audit.correlation.effectiveAuditResult, "MANUAL_REVIEW");
  assert.match(timedOutPost.section, /统一总时限内完整完成.*审方降级/);
  assert.match(timedOutPost.section, /不阻断诊疗流程/);
  if (previousTotalTimeout == null) delete process.env.RXAI_AUDIT_TOTAL_TIMEOUT_MS;
  else process.env.RXAI_AUDIT_TOTAL_TIMEOUT_MS = previousTotalTimeout;
  if (previousAttemptTimeout == null) delete process.env.RXAI_AUDIT_ATTEMPT_TIMEOUT_MS;
  else process.env.RXAI_AUDIT_ATTEMPT_TIMEOUT_MS = previousAttemptTimeout;

  console.log(JSON.stringify({ cases: 19, failures: 0 }));
} finally {
  globalThis.fetch = originalFetch;
  if (preExistingRxAuditTotalTimeout == null) delete process.env.RXAI_AUDIT_TOTAL_TIMEOUT_MS;
  else process.env.RXAI_AUDIT_TOTAL_TIMEOUT_MS = preExistingRxAuditTotalTimeout;
  if (preExistingRxAuditAttemptTimeout == null) delete process.env.RXAI_AUDIT_ATTEMPT_TIMEOUT_MS;
  else process.env.RXAI_AUDIT_ATTEMPT_TIMEOUT_MS = preExistingRxAuditAttemptTimeout;
  if (preExistingRxAuditLegacyTimeout == null) delete process.env.RXAI_AUDIT_TIMEOUT_MS;
  else process.env.RXAI_AUDIT_TIMEOUT_MS = preExistingRxAuditLegacyTimeout;
}
