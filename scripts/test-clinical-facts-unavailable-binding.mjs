import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, test } from "node:test";
import { createJiti } from "jiti";

const customer = { clientId: "facts-failure-client", customerId: "facts-customer-a" };
const otherCustomer = "facts-customer-b";
const settings = {
  NODE_ENV: "test", CDSS_REQUIRE_API_AUTH: "true", CDSS_API_TOKEN: "synthetic-facts-failure-access-token",
  CDSS_API_CLIENT_ID: customer.clientId, CDSS_API_CUSTOMER_IDS: `${customer.customerId},${otherCustomer}`,
  CDSS_DEFAULT_CUSTOMER_ID: customer.customerId, CDSS_CUSTOMER_ID: customer.customerId,
  CDSS_CUSTOMER_JIT_REGISTRATION: "false", CDSS_CLINICAL_FACTS_BACKSTOP: "true", CDSS_CLINICAL_FACTS_REVIEW: "true",
  CLINICAL_FACTS_ATTESTATION_KEY: "synthetic-facts-attestation-key",
  REASONING_CONTRACT_SIGNING_KEY: "synthetic-facts-failure-reasoning-key-at-least-32-characters",
  AI_TEXT_PROVIDER: "openai-compatible", OPENAI_API_KEY: "synthetic-facts-model-key",
  OPENAI_BASE_URL: "https://api.deepseek.com", OPENAI_MODEL: "deepseek-v4-flash",
  PRIMARY_CLINICAL_REVIEW_PROVIDER: "primary", CLINICAL_FACTS_EXTRACT_MODEL: "deepseek-v4-flash",
  CLINICAL_FACTS_REVIEW_MODEL: "deepseek-v4-flash", CLINICAL_FACTS_ADJUDICATE_MODEL: "deepseek-v4-flash",
  RXAI_AUDIT_ENABLED: "false", RXAI_QUERY_ENABLED: "false", M05_FOLLOWUP_AUTHORING: "false",
};
Object.assign(process.env, settings);
const jiti = createJiti(import.meta.url, { alias: {
  "@": `${process.cwd()}/src`, "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
} });
const runtime = await jiti.import("../src/lib/clinical-facts-runtime.ts");
const { normalizeCaseStateInput } = await jiti.import("../src/lib/diagnosis-types.ts");
const { readCustomerBoundCaseStateRequest } = await jiti.import("../src/lib/diagnosis-request.ts");

beforeEach((t) => {
  Object.assign(process.env, settings);
  runtime.resetClinicalFactsServerCache();
  t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected offline test fetch"); });
});

function makeCase() {
  return normalizeCaseStateInput({ id: "facts-unavailable-case", customerId: customer.customerId, phase: "idle",
    patient: { sex: "男", age: 40 }, chiefComplaint: "神疲乏力2月",
    symptoms: { presentHistory: "神疲乏力2月，活动后加重" }, tongue: "舌淡苔白", pulse: "脉细弱",
    pastHistory: "否认重大疾病", allergyHistory: "否认药物过敏", medicationHistory: "否认当前用药",
    vitals: { T: "36.5℃", P: "75", R: "18", BP: "120/80", SpO2: "99%" },
  });
}

function request(state, route = "assess", customerId = state.customerId) {
  return new Request(`http://localhost/api/diagnosis/${route}`, { method: "POST",
    headers: { "content-type": "application/json", "x-cdss-customer-id": customerId },
    body: JSON.stringify({ caseState: state }),
  });
}

function assertUnavailable(state, reason) {
  const facts = state.clinicalFacts;
  assert.ok(facts, "the producer must emit an explicit unavailable snapshot");
  assert.deepEqual(facts.redFlags, [], "an outage cannot retain stale findings");
  assert.equal(facts.semanticStatus, "unavailable");
  assert.equal(facts.resultSource, "failure");
  assert.equal(facts.unavailableReason, reason);
  for (const field of ["attestation", "reviewStatus", "encounterScope", "modelTrace", "extractedAt"]) {
    assert.equal(facts[field], undefined, `failure must not acquire clinical authority via ${field}`);
  }
  assert.equal(runtime.hasValidClinicalFactsAttestation(facts, Date.now(), undefined, state.customerId), false);
}

async function assertRetainedOnlyForOwner(state) {
  const parsed = await readCustomerBoundCaseStateRequest(request(state));
  assert.equal(parsed.ok, true);
  assert.ok(parsed.caseState.clinicalFacts, "same-tenant unavailable facts must survive the real request boundary");
  assert.equal(parsed.caseState.clinicalFacts.semanticStatus, "unavailable");
  assert.equal(parsed.caseState.clinicalFacts.resultSource, "failure");
  assert.ok(runtime.clinicalFactsTenantBindingMatches(state.clinicalFacts, customer.customerId));
  assert.equal(runtime.clinicalFactsTenantBindingMatches(state.clinicalFacts, otherCustomer), false);
  assert.ok(parsed.caseState.clinicalFacts.customerBindingHash === state.clinicalFacts.customerBindingHash);
  const replayed = await readCustomerBoundCaseStateRequest(request({ ...state, customerId: otherCustomer }));
  assert.equal(replayed.ok, true);
  assert.equal(replayed.caseState.clinicalFacts, undefined, "cross-tenant facts are stripped even after relabeling the case");
}

const failureModes = ["disabled", "invalid_output", "model_error", "timeout", "aborted", "signing_unavailable"];
for (const reason of failureModes) {
  test(`${reason}: producer-owned empty facts retain tenant binding without an attestation`, async () => {
    if (reason === "disabled") process.env.CDSS_CLINICAL_FACTS_BACKSTOP = "false";
    if (reason === "signing_unavailable") {
      delete process.env.CLINICAL_FACTS_ATTESTATION_KEY;
      delete process.env.REASONING_CONTRACT_SIGNING_KEY;
    }
    const controller = new AbortController();
    let calls = 0;
    if (reason === "aborted") controller.abort();
    const state = await runtime.maybeAttachClinicalFactsBackstop({ ...makeCase(), clinicalFacts: {
      redFlags: [{ category: "cardiac", subject: "patient", status: "positive", quote: "旧病例胸痛" }],
      customerBindingHash: "caller-controlled-binding", sourceFingerprint: "stale-source",
      semanticStatus: "checked", reviewStatus: "checked", encounterScope: { status: "historical_or_stable_only", quote: "旧记录" },
    } }, async () => {
      calls += 1;
      if (reason === "model_error") throw new Error("synthetic model outage");
      if (reason === "timeout") throw new DOMException("synthetic phase timeout", "TimeoutError");
      return reason === "signing_unavailable" ? JSON.stringify({ redFlags: [] }) : "invalid JSON";
    }, controller.signal);
    assertUnavailable(state, reason);
    if (["disabled", "aborted"].includes(reason)) assert.equal(calls, 0);
    else assert.ok(calls > 0, "failure branch must be reached via extraction");
    await assertRetainedOnlyForOwner(state);
    assert.equal(runtime.clinicalFactsServerCacheSize(), 0, "unavailable facts never enter the signed cache");
  });
}

test("invalid customer/client identity cannot borrow a caller-supplied binding", async () => {
  process.env.CDSS_CLINICAL_FACTS_BACKSTOP = "false";
  for (const invalidCustomer of [undefined, "bad/customer", " facts-customer-a "]) {
    const state = await runtime.maybeAttachClinicalFactsBackstop({ ...makeCase(), customerId: invalidCustomer,
      clinicalFacts: { redFlags: [], customerBindingHash: "caller-controlled-binding" },
    });
    assertUnavailable(state, "disabled");
    assert.equal(state.clinicalFacts.customerBindingHash, undefined);
    const rebound = await readCustomerBoundCaseStateRequest(request({ ...state, customerId: customer.customerId }));
    assert.equal(rebound.ok, true);
    assert.equal(rebound.caseState.clinicalFacts, undefined);
  }
  process.env.CDSS_API_CLIENT_ID = "bad/client";
  const state = await runtime.maybeAttachClinicalFactsBackstop(makeCase());
  assert.equal(state.clinicalFacts.customerBindingHash, undefined);
  const rejected = await readCustomerBoundCaseStateRequest(request(state));
  assert.equal(rejected.ok, false);
  assert.equal(rejected.response.status, 503);
});

test("a failure retries normally and only a successful attested result enters the configured cache", async (t) => {
  let calls = 0;
  let recover = false;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return recover
      ? Response.json({ choices: [{ message: { content: JSON.stringify({ redFlags: [] }) }, finish_reason: "stop" }] })
      : Response.json({ error: { message: "synthetic provider rejection" } }, { status: 400 });
  });
  const failed = await runtime.maybeAttachClinicalFactsBackstop(makeCase());
  assertUnavailable(failed, "model_error");
  assert.equal(runtime.clinicalFactsServerCacheSize(), 0);
  const afterFailure = calls;
  recover = true;
  const recovered = await runtime.maybeAttachClinicalFactsBackstop(failed);
  assert.ok(calls > afterFailure, "a same-source failed snapshot cannot bypass fresh extraction");
  assert.ok(runtime.hasValidClinicalFactsAttestation(recovered.clinicalFacts, Date.now(), undefined, customer.customerId));
  assert.equal(recovered.clinicalFacts.resultSource, "fresh");
  assert.equal(runtime.clinicalFactsServerCacheSize(), 1);
  const afterRecovery = calls;
  const cached = await runtime.maybeAttachClinicalFactsBackstop(makeCase());
  assert.equal(calls, afterRecovery);
  assert.equal(cached.clinicalFacts.resultSource, "cache");
  assert.ok(runtime.hasValidClinicalFactsAttestation(cached.clinicalFacts, Date.now(), undefined, customer.customerId));
});

async function signedCase() {
  // Reuse the same synthetic, genuinely signed M03/M04 fixture as the existing warning route suite.
  const signatures = await jiti.import("../src/lib/reasoning-contract-signature.ts");
  const safety = await jiti.import("../src/lib/diagnosis-safety.ts");
  const { getTcmHerbFunctionText } = await jiti.import("../src/lib/tcm-knowledge.ts");
  const { synchronizeVisibleClinicalSummary } = await jiti.import("../src/lib/diagnosis-visible-summary.ts");
  const { buildUnavailableRxAuditSection } = await jiti.import("../src/lib/rxaudit.ts");
  const { findLocalPatentMedicineEntry } = await jiti.import("../src/lib/local-patent-medicine-candidates.ts");
  const source = readFileSync(new URL("./regress-tcm-cdss.mjs", import.meta.url), "utf8");
  const helpers = source.slice(source.indexOf("function hisRecord("), source.indexOf("function expected("));
  const bindings = { ...signatures, ...safety, normalizeCaseStateInput, getTcmHerbFunctionText,
    synchronizeVisibleClinicalSummary, buildUnavailableRxAuditSection, findLocalPatentMedicineEntry,
    CDSS_CUSTOMER_ID: customer.customerId };
  const cases = new Function(...Object.keys(bindings), `${helpers}\nreturn buildHisProjectionRegressionCases();`)(...Object.values(bindings));
  return { ...cases[1].state, phase: "assess", riskAssessment: "" };
}

for (const mode of ["disabled", "model_error"]) {
  test(`real red-flags → M05 flow preserves a verifiable display-only receipt during ${mode}`, async (t) => {
    process.env.CDSS_CLINICAL_FACTS_BACKSTOP = mode === "disabled" ? "false" : "true";
    let modelCalls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      modelCalls += 1;
      return Response.json({ error: { message: "synthetic provider outage" } }, { status: 400 });
    });
    const { POST: redFlags } = await jiti.import("../src/app/api/diagnosis/red-flags/route.ts");
    const { POST: assess } = await jiti.import("../src/app/api/diagnosis/assess/route.ts");
    const { consumeMarkdownStreamWithMetadata } = await jiti.import("../src/lib/diagnosis-engine.ts");
    const { applyCompletedM05DisplayResult } = await jiti.import("../src/lib/followup-display-state.ts");
    const { prepareWarningObservation } = await jiti.import("../src/lib/warning-display-observation.ts");
    const { verifyWarningDisplayReceipt } = await jiti.import("../src/lib/warning-display-receipt.server.ts");
    const initial = await signedCase();
    const response = await redFlags(request(initial, "red-flags"));
    assert.equal(response.status, 200);
    const redFlagResult = await response.json();
    assert.equal(redFlagResult.available, false);
    const submitted = { ...initial, clinicalFacts: redFlagResult.clinicalFacts };
    assertUnavailable(submitted, mode);
    const assessed = await assess(request(submitted));
    assert.equal(assessed.status, 200, "the genuine existing M04 signature must remain accepted");
    const result = await consumeMarkdownStreamWithMetadata(assessed, () => {}, { collectWarningProfile: true });
    assert.ok(result.warningObservation, "unavailable facts must not break source equivalence and suppress the receipt");
    const finalState = applyCompletedM05DisplayResult(submitted, result, customer.customerId);
    assert.ok(await verifyWarningDisplayReceipt(result.warningObservation, customer, finalState, "live"));
    assert.ok(await prepareWarningObservation({ receipt: result.warningObservation, requestState: submitted,
      finalState, customerId: customer.customerId, isCurrent: () => true }));
    assert.equal(result.warningObservation.live.profile.executable, false);
    assertUnavailable(finalState, mode);
    assert.equal(runtime.clinicalFactsServerCacheSize(), 0);
    assert.equal(mode === "disabled" ? modelCalls === 0 : modelCalls >= 4, true);
  });
}
