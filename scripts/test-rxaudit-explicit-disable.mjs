import assert from "node:assert/strict";
import { test } from "node:test";
import { createJiti } from "jiti";
import { buildAuditPositiveControlState } from "./lib/primary-care-audit-positive-controls.mjs";

Object.assign(process.env, {
  RXAI_AUDIT_ENABLED: "false", RXAI_QUERY_ENABLED: "true", CDSS_SHOW_RX_AUDIT_SECTION: "true",
  RXAI_AUDIT_BASE_URL: "https://audit.example.invalid", RXAI_AUDIT_TOKEN: "offline-fixture-token",
  CDSS_CLINICAL_FACTS_BACKSTOP: "true", M05_FOLLOWUP_AUTHORING: "false",
  REASONING_CONTRACT_SIGNING_KEY: "explicit-disable-offline-signing-key-at-least-32-characters",
});
for (const key of ["OPENAI_API_KEY", "BAILIAN_QWEN_API_KEY", "DASHSCOPE_API_KEY", "QWEN_API_KEY", "EVIMED_API_KEY"]) delete process.env[key];
const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src`, "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js` } });
const audit = await jiti.import("../src/lib/rxaudit.ts");
const { normalizeCaseStateInput } = await jiti.import("../src/lib/diagnosis-types.ts");
const signatures = await jiti.import("../src/lib/reasoning-contract-signature.ts");
const { POST: assess } = await jiti.import("../src/app/api/diagnosis/assess/route.ts");
const { POST: postRisk } = await jiti.import("../src/app/api/diagnosis/post-prescription-risk/route.ts");
const { POST: hisScheme } = await jiti.import("../src/app/api/diagnosis/his-scheme/route.ts");
const { GET: health } = await jiti.import("../src/app/api/diagnosis/health/route.ts");
const { deriveStructuredCaseWarningFloor } = await jiti.import("../src/lib/clinical-warning-tier.ts");
const { issuePrescriptionRevisionAttestation, verifyPrescriptionRevisionAttestation } = await jiti.import("../src/lib/prescription-revision-attestation.server.ts");
const { invalidatePrescriptionContractAfterEdit } = await jiti.import("../src/lib/prescription-revision.ts");
const { computePrescriptionVersionHash } = await jiti.import("../src/lib/prescription-version.ts");
const { revisionFromAudit, applyAcceptedPrescriptionDisplayResult, applyCompletedM05DisplayResult } = await jiti.import("../src/lib/followup-display-state.ts");
const { consumeMarkdownStreamWithMetadata } = await jiti.import("../src/lib/diagnosis-engine.ts");
const { prepareWarningObservation, resolveWarningDisplayProfile } = await jiti.import("../src/lib/warning-display-observation.ts");
const { derivePrescriptionPermission, withSafetyGate } = await jiti.import("../src/lib/diagnosis-safety.ts");
const { maybeAttachClinicalFactsBackstop } = await jiti.import("../src/lib/clinical-facts-runtime.ts");
const { getTcmHerbFunctionText } = await jiti.import("../src/lib/tcm-knowledge.ts");
const { getM03TherapyLock } = await jiti.import("../src/lib/m03-therapy-lock.ts");
const customer = { clientId: "local-development", customerId: "test-hospital" };

function caseFor({ medicationHistory = "否认当前用药", herbs = [{ name: "黄芪", dose: "15g" }, { name: "茯苓", dose: "12g" }] } = {}) {
  const control = { id: "explicit-skip", patient: { sex: "男", age: 46 }, chiefComplaint: "入睡困难三个月", diagnosis: "失眠障碍", syndrome: "心脾两虚证", pastHistory: "否认重要慢病", allergyHistory: "否认药物过敏", medicationHistory, herbs };
  const state = normalizeCaseStateInput({ ...buildAuditPositiveControlState(control), customerId: "test-hospital", phase: "done", vitals: { T: "36.5", P: "75", R: "18", BP: "120/80", SpO2: "99%" } });
  const m03 = { ...structuredClone(state.reasoningPrescribe), stage: "diagnose", formula: null, nonPharma: null, clinicalReview: undefined,
    overview: { ...state.reasoningPrescribe.overview, recommendedFormulaNames: [], formulaSelectionMode: "self_devised" } };
  state.reasoningDiagnose = signatures.signDiagnoseReasoning(m03, signatures.buildDiagnoseContractSignatureContext(state));
  const m04 = structuredClone(state.reasoningPrescribe);
  state.reasoningPrescribe = signatures.signPrescribeReasoning(m04, signatures.buildPrescribeContractSignatureContext(state));
  state.reasoningV2 = state.reasoningPrescribe;
  return state;
}
function request(path, caseState) { return new Request(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json", "x-cdss-customer-id": "test-hospital" }, body: JSON.stringify({ caseState }) }); }
async function readyCaseFor(options) {
  // Reach the real downstream route using an offline, server-attested clinical-facts result.
  // The audit toggle must not bypass or disable this independent semantic safety layer.
  return maybeAttachClinicalFactsBackstop(caseFor(options), async () => JSON.stringify({ redFlags: [] }));
}
async function withoutNetwork(fn) {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error("offline test prohibits external calls"); };
  try { await fn(); assert.equal(calls, 0, "explicit skip must invoke neither audit, medication extraction nor compatibility service"); }
  finally { globalThis.fetch = original; }
}

test("only raw false selects a server-owned skipped state, even without sidecar configuration", async () => {
  const prior = process.env.RXAI_AUDIT_BASE_URL;
  try {
  delete process.env.RXAI_AUDIT_BASE_URL;
  assert.equal(audit.getRxAuditConfig().explicitlyDisabled, true);
  assert.equal(audit.getRxAuditStatus().disabledReason, "rxaudit_disabled");
  assert.equal(audit.rxAuditPresentationEnabled(), false);
  process.env.RXAI_AUDIT_ENABLED = "";
  assert.equal(audit.getRxAuditConfig().explicitlyDisabled, false);
  assert.equal(audit.getRxAuditStatus().disabledReason, "rxaudit_not_configured");
  } finally { process.env.RXAI_AUDIT_ENABLED = "false"; process.env.RXAI_AUDIT_BASE_URL = prior; }
});

test("skip metadata never invents a provider result or unavailable-medication finding", async () => withoutNetwork(async () => {
  const run = await audit.runBoundedRxAudit(caseFor(), 0);
  assert.equal(run.providerAudit.source, "skipped");
  assert.equal(run.providerAudit.ok, false);
  assert.equal(run.medicationExtraction.needsManualReview, false);
  assert.deepEqual(audit.buildAuditInputAdvisories(caseFor(), 0, run.medicationExtraction), []);
  assert.equal(audit.ownedAuditWarningInputs(run.providerAudit), undefined);
  const correlation = audit.buildRxAuditCorrelationMetadata({ providerOutcome: run.providerAudit });
  assert.equal(correlation.providerAvailable, false);
  assert.equal(correlation.providerReason, "rxaudit_disabled");
  assert.equal(correlation.effectiveAuditResult, undefined);
  assert.equal(correlation.effectiveHighestRiskLevel, undefined);
  assert.equal(correlation.needManualReview, undefined);
}));

test("three clinical routes deliver local content with honest skip semantics", async () => withoutNetwork(async () => {
  for (const [path, handler] of [["assess", assess], ["post-prescription-risk", postRisk], ["his-scheme", hisScheme]]) {
    const response = await handler(request(`/api/diagnosis/${path}`, await readyCaseFor()));
    const body = await response.text();
    assert.equal(response.status, 200, `${path}: ${body.slice(0, 400)}`);
    assert.doesNotMatch(body, /medication_semantics_unavailable|lingxi_unavailable|自动审方未完成|审方服务暂不可用/, path);
    if (path === "assess") {
      assert.match(body, /TCM_CDSS_RXAUDIT_STATUS:DISABLED/);
    } else {
      const json = JSON.parse(body);
      if (path === "post-prescription-risk") {
        assert.equal(json.audit.source, "skipped");
        assert.equal(json.audit.auditResult, "NOT_SUBMITTED");
        assert.equal(json.audit.highestRiskLevel, undefined);
        assert.equal(json.audit.needManualReview, false);
      } else assert.equal(json.auditStatus, "not_submitted");
    }
  }
}));

test("local medication uncertainty, dose validation and contraindicated pairs survive skip", async () => withoutNetwork(async () => {
  for (const variant of [{ medicationHistory: "现用药不详", expected: /现用药信息明确不详|用药.*不详/ },
    { herbs: [{ name: "黄芪", dose: "" }], expected: /黄芪.*未标注|剂量/ },
    { herbs: [{ name: "甘草", dose: "6g" }, { name: "海藻", dose: "9g" }], expected: /十八反|甘草.*海藻/ }]) {
    const state = await readyCaseFor(variant);
    const run = await audit.runBoundedRxAudit(state, 0);
    assert.equal(run.providerAudit.source, "skipped");
    const findings = audit.buildAuditInputAdvisorySection(audit.buildAuditInputAdvisories(state, 0, run.medicationExtraction), true) + audit.buildLocalHighRiskHerbPairSection(state, 0);
    assert.match(findings, variant.expected);
    if (variant.herbs?.[0].name === "甘草") assert.equal(deriveStructuredCaseWarningFloor(state).level, "L4");
    for (const [path, handler] of [["assess", assess], ["post-prescription-risk", postRisk], ["his-scheme", hisScheme]]) {
      const response = await handler(request(`/api/diagnosis/${path}`, state));
      const body = await response.text();
      assert.equal(response.status, 200, `${path}: ${body}`);
      assert.match(body, variant.expected, path);
      assert.doesNotMatch(body, /medication_semantics_unavailable|lingxi_unavailable/, path);
    }
  }
}));

test("existing critical revision remains a floor when external service is skipped", () => {
  const state = caseFor();
  state.prescriptionRevision = { source: "herb_workbench", candidateIndex: 0, herbHash: "previous-version", auditedAt: new Date().toISOString(), auditResult: "BLOCK", highestRiskLevel: "CRITICAL", auditAvailable: true };
  assert.equal(deriveStructuredCaseWarningFloor(state).level, "L4");
});

test("health treats explicit disable as optional skip and absent config as degraded", async () => {
  const read = async () => (await health(new Request("http://localhost/api/diagnosis/health?diagnostics=1"))).json();
  const disabled = await read();
  assert.equal(disabled.rxAudit.enabled, false);
  assert.equal(disabled.rxAudit.explicitlyDisabled, true);
  assert.ok(!disabled.degradedReasons.some((reason) => /rxaudit/.test(reason)));
  delete process.env.RXAI_AUDIT_ENABLED;
  const unconfigured = await read();
  assert.equal(unconfigured.rxAudit.explicitlyDisabled, false);
  assert.ok(unconfigured.degradedReasons.some((reason) => /rxaudit/.test(reason)));
  process.env.RXAI_AUDIT_ENABLED = "false";
});

async function workbenchCase() {
  const state = await readyCaseFor();
  const revised = invalidatePrescriptionContractAfterEdit(structuredClone(state.reasoningPrescribe));
  Object.assign(revised.formula.candidates[0], { name: "益气安神方（医生编辑版）", constructionType: "self_devised", modificationStatus: "modified" });
  state.reasoningPrescribe = revised; state.reasoningV2 = revised;
  const herbHash = await computePrescriptionVersionHash(revised, 0, state);
  state.prescriptionRevision = { source: "herb_workbench", candidateIndex: 0, herbHash, auditedAt: new Date().toISOString(), auditResult: "MANUAL_REVIEW", highestRiskLevel: "HIGH", auditAvailable: false };
  return state;
}

test("workbench skip issues an honest receipt that survives normalization and does not add an audit floor", async () => withoutNetwork(async () => {
  const submitted = await workbenchCase();
  const response = await postRisk(request("/api/diagnosis/post-prescription-risk", submitted));
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.audit.source, "skipped");
  assert.equal(body.audit.auditResult, "NOT_SUBMITTED");
  assert.equal(body.audit.highestRiskLevel, undefined);
  assert.equal(body.audit.degraded, false);
  const accepted = { caseId: submitted.id, reasoning: submitted.reasoningPrescribe, auditSection: body.section, followupSection: body.followup.trim(), followupTimeline: body.followupTimeline,
    serverSafetyLocked: derivePrescriptionPermission(withSafetyGate(submitted)).formalAdoption === "blocked", revision: revisionFromAudit(body.audit, 0, body.audit.herbHash, true) };
  const final = applyAcceptedPrescriptionDisplayResult(submitted, accepted);
  const normalized = normalizeCaseStateInput(JSON.parse(JSON.stringify(final)));
  assert.equal(normalized.prescriptionRevision.auditResult, "NOT_SUBMITTED");
  assert.equal(normalized.prescriptionRevision.highestRiskLevel, undefined);
  assert.equal(verifyPrescriptionRevisionAttestation(normalized, customer, body.audit.herbHash), true);
  assert.ok(body.warningObservation, "skip must keep the existing workbench display receipt contract");
  const installed = await prepareWarningObservation({ receipt: body.warningObservation, requestState: submitted, finalState: final, customerId: customer.customerId, isCurrent: () => true });
  assert.ok(installed);
  const displayStateBefore = JSON.stringify(final);
  assert.ok(resolveWarningDisplayProfile(final).reasons.some((reason) => /审方.*不可用/.test(reason)), "raw client fields do not prove operator skip");
  assert.ok(!resolveWarningDisplayProfile(final, installed).reasons.some((reason) => /审方.*不可用/.test(reason)), "a matched server receipt must not recreate a skipped-module floor");
  assert.equal(JSON.stringify(final), displayStateBefore, "display projection must preserve signed state and material bytes");
  assert.ok(!body.warningObservation.live.profile.reasons.some((reason) => /审方.*(?:不可用|HIGH|高风险)|审方结论为/.test(reason)));
  const assessed = await assess(request("/api/diagnosis/assess", normalized));
  assert.equal(assessed.status, 200, await assessed.clone().text());
  const result = await consumeMarkdownStreamWithMetadata(assessed, () => {}, { collectWarningProfile: true });
  const completed = applyCompletedM05DisplayResult(normalized, result, customer.customerId);
  assert.ok(await prepareWarningObservation({ receipt: result.warningObservation, requestState: normalized, finalState: completed, customerId: customer.customerId, isCurrent: () => true }));
  assert.ok(!result.warningObservation.live.profile.reasons.some((reason) => /审方.*(?:不可用|HIGH|高风险)/.test(reason)));
  const his = await hisScheme(request("/api/diagnosis/his-scheme", completed));
  assert.equal(his.status, 200, await his.clone().text());
  assert.equal((await his.json()).auditStatus, "not_submitted");
  const forged = structuredClone(normalized);
  forged.prescriptionRevision.attestation = `hmac-sha256:${"0".repeat(64)}`;
  assert.equal((await assess(request("/api/diagnosis/assess", forged))).status, 409);
  process.env.RXAI_AUDIT_ENABLED = "true";
  try {
    assert.equal(verifyPrescriptionRevisionAttestation(normalized, customer, body.audit.herbHash), false, "reenabling external audit must invalidate old skip authority");
    assert.equal((await assess(request("/api/diagnosis/assess", normalized))).status, 409);
    assert.equal((await hisScheme(request("/api/diagnosis/his-scheme", normalized))).status, 409);
  } finally { process.env.RXAI_AUDIT_ENABLED = "false"; }
}));

test("skipping a previously attested critical version retains its real result and signature", async () => withoutNetwork(async () => {
  const state = await workbenchCase();
  const revision = { ...state.prescriptionRevision, auditResult: "BLOCK", highestRiskLevel: "CRITICAL", auditAvailable: true, degraded: false, needManualReview: true };
  state.prescriptionRevision = { ...revision, ...issuePrescriptionRevisionAttestation(state, customer, revision) };
  const response = await postRisk(request("/api/diagnosis/post-prescription-risk", state));
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.audit.source, "skipped");
  assert.equal(body.audit.auditResult, "BLOCK");
  assert.equal(body.audit.highestRiskLevel, "CRITICAL");
  const retained = { ...state, prescriptionRevision: revisionFromAudit(body.audit, 0, revision.herbHash, true) };
  assert.equal(verifyPrescriptionRevisionAttestation(retained, customer, revision.herbHash), true);
  assert.equal(body.warningObservation.live.profile.level, "L4");
  assert.equal(body.warningObservation.stored.profile.level, "L4");
  for (const [name, handler] of [["assess", assess], ["his-scheme", hisScheme]]) {
    const result = await handler(request(`/api/diagnosis/${name}`, retained));
    const text = await result.text();
    assert.equal(result.status, 200, text);
    assert.match(text, /已有经确认的严重风险/);
    assert.match(text, /L4/);
  }
  const changed = structuredClone(state);
  changed.reasoningPrescribe.formula.candidates[0].herbs[0].dose = "12g";
  changed.reasoningV2 = changed.reasoningPrescribe;
  const changedHash = await computePrescriptionVersionHash(changed.reasoningPrescribe, 0, changed);
  assert.notEqual(changedHash, revision.herbHash);
  assert.equal(verifyPrescriptionRevisionAttestation(changed, customer, changedHash), false);
  const changedResponse = await postRisk(request("/api/diagnosis/post-prescription-risk", changed));
  const changedBody = await changedResponse.json();
  assert.equal(changedResponse.status, 200, JSON.stringify(changedBody));
  assert.equal(changedBody.audit.auditResult, "NOT_SUBMITTED");
  assert.equal(changedBody.audit.retainedPriorAudit, false);
}));

test("revision schema keeps legacy grades mandatory and rejects contradictory skip claims", async () => {
  const state = await workbenchCase();
  for (const result of ["PASS", "REMIND", "MANUAL_REVIEW", "BLOCK"]) {
    const invalid = { ...state, prescriptionRevision: { ...state.prescriptionRevision, auditResult: result, highestRiskLevel: undefined } };
    assert.equal(normalizeCaseStateInput(invalid).prescriptionRevision, undefined, `${result} requires a real risk grade`);
  }
  const skipped = { ...state.prescriptionRevision, auditResult: "NOT_SUBMITTED", highestRiskLevel: undefined, auditAvailable: false, degraded: false, auditReason: "rxaudit_disabled" };
  assert.equal(normalizeCaseStateInput({ ...state, prescriptionRevision: skipped }).prescriptionRevision.auditResult, "NOT_SUBMITTED");
  for (const mutation of [{ highestRiskLevel: "INFO" }, { auditAvailable: true }, { degraded: true }, { auditReason: undefined }]) {
    assert.equal(normalizeCaseStateInput({ ...state, prescriptionRevision: { ...skipped, ...mutation } }).prescriptionRevision, undefined);
  }
});

for (const candidateIndex of [1, 2]) {
  for (const selectedUnsafe of [false, true]) {
    test(`skipped selection ${candidateIndex} keeps ${selectedUnsafe ? "selected" : "unselected"} contraindications correctly scoped across routes and installed view`, async () => withoutNetwork(async () => {
      const submitted = await workbenchCase();
      const safe = structuredClone(submitted.reasoningPrescribe.formula.candidates[0]);
      safe.therapyMatch = getM03TherapyLock(submitted.reasoningDiagnose).candidateMatch;
      safe.herbs = safe.herbs.map((herb) => ({ ...herb, function: getTcmHerbFunctionText(herb.name) }));
      const unsafe = structuredClone(safe);
      unsafe.herbs = unsafe.herbs.map((herb, index) => ({ ...herb, name: index === 0 ? "甘草" : "海藻" }));
      submitted.reasoningPrescribe.formula.candidates = Array.from({ length: candidateIndex + 1 }, (_, index) =>
        structuredClone(index === candidateIndex ? selectedUnsafe ? unsafe : safe : selectedUnsafe ? safe : unsafe));
      submitted.reasoningV2 = submitted.reasoningPrescribe;
      const herbHash = await computePrescriptionVersionHash(submitted.reasoningPrescribe, candidateIndex, submitted);
      submitted.prescriptionRevision = { ...submitted.prescriptionRevision, candidateIndex, herbHash };
      const before = JSON.stringify(submitted);
      const response = await postRisk(request("/api/diagnosis/post-prescription-risk", submitted));
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.equal(body.audit.candidateIndex, candidateIndex);
      assert.equal(body.audit.auditResult, "NOT_SUBMITTED");
      const checkProfile = (profile, label) => {
        assert.equal(profile.level === "L4", selectedUnsafe, `${label}: ${JSON.stringify(profile)}; findings: ${JSON.stringify(body.warnings)}`);
        assert.equal(profile.executable, !selectedUnsafe, label);
        assert.equal(profile.reasons.some((reason) => /甘草.*海藻|十八反/.test(reason)), selectedUnsafe, label);
      };
      checkProfile(body.warningObservation.live.profile, "post-risk live");
      checkProfile(body.warningObservation.stored.profile, "post-risk stored");
      const final = applyAcceptedPrescriptionDisplayResult(submitted, {
        caseId: submitted.id, reasoning: submitted.reasoningPrescribe, auditSection: body.section,
        followupSection: body.followup.trim(), followupTimeline: body.followupTimeline,
        serverSafetyLocked: derivePrescriptionPermission(withSafetyGate(submitted)).formalAdoption === "blocked",
        revision: revisionFromAudit(body.audit, candidateIndex, herbHash, true),
      });
      const materialBefore = JSON.stringify(final);
      const installed = await prepareWarningObservation({ receipt: body.warningObservation, requestState: submitted,
        finalState: final, customerId: customer.customerId, isCurrent: () => true });
      assert.ok(installed);
      checkProfile(resolveWarningDisplayProfile(final, installed), "installed client");
      if (!selectedUnsafe) assert.ok(resolveWarningDisplayProfile(final).reasons.some((reason) => /审方.*不可用/.test(reason)), "no receipt remains conservative");
      assert.equal(JSON.stringify(final), materialBefore, "the installed projection must not mutate signed fields or material");
      const normalized = normalizeCaseStateInput(JSON.parse(materialBefore));
      assert.equal(normalized.prescriptionRevision.candidateIndex, candidateIndex);
      assert.equal(normalized.prescriptionRevision.herbHash, herbHash);
      assert.equal(verifyPrescriptionRevisionAttestation(normalized, customer, herbHash), true);
      const assessment = await assess(request("/api/diagnosis/assess", normalized));
      assert.equal(assessment.status, 200, await assessment.clone().text());
      const result = await consumeMarkdownStreamWithMetadata(assessment, () => {}, { collectWarningProfile: true });
      checkProfile(result.warningObservation.live.profile, "M05 live");
      checkProfile(result.warningObservation.stored.profile, "M05 stored");
      const completed = applyCompletedM05DisplayResult(normalized, result, customer.customerId);
      const m05Installed = await prepareWarningObservation({ receipt: result.warningObservation, requestState: normalized,
        finalState: completed, customerId: customer.customerId, isCurrent: () => true });
      assert.ok(m05Installed);
      checkProfile(resolveWarningDisplayProfile(completed, m05Installed), "M05 installed client");
      const his = await hisScheme(request("/api/diagnosis/his-scheme", completed));
      const payload = await his.json();
      assert.equal(his.status, 200, JSON.stringify(payload));
      assert.equal(payload.auditStatus, "not_submitted");
      checkProfile(payload.warningProfile, "HIS");
      assert.equal(JSON.stringify(submitted), before, "none of the routes may mutate the submitted selection");
    }));
  }
}

const skippedMedicationScopeCases = [
  ["发病后未服药", "medication_current_scope_incomplete"],
  ["既往服用阿莫西林，发病后未服药", "medication_current_scope_incomplete"],
  ["曾服阿莫西林已停用，发病后未服药", "medication_current_scope_incomplete"],
  ["否认服用阿司匹林，发病后未服药", "medication_current_scope_incomplete"],
  ["家属长期服用阿司匹林，发病后未服药", "medication_current_scope_incomplete"],
  ["现用药不 详", "medication_current_scope_unknown"],
  ["现用药不\n详", "medication_current_scope_unknown"],
  ["现用药未 提 及", "medication_current_scope_unknown"],
  ["目前无任何用药", undefined],
  ["既往服用阿司匹林，当前无任何用药", undefined],
  ["现服阿司匹林，发病后未服其他药", undefined],
  ["长期服用阿司匹林，发病后未服药", undefined],
  ["未停用阿司匹林，发病后未服其他药", undefined],
];
for (const [medicationHistory, expectedReason] of skippedMedicationScopeCases) {
  test(`skipped medication scope preserves current/history polarity: ${JSON.stringify(medicationHistory)}`, async () => withoutNetwork(async () => {
    const state = await readyCaseFor({ medicationHistory });
    const before = JSON.stringify(state);
    const run = await audit.runBoundedRxAudit(state, 0);
    assert.equal(run.providerAudit.source, "skipped");
    assert.equal(run.medicationExtraction.reason, expectedReason);
    assert.equal(run.medicationExtraction.needsManualReview, Boolean(expectedReason));
    assert.deepEqual(run.medicationExtraction.events, [], "skip must not fabricate extracted current-medication events");
    const existing = audit.verifyMedicationSemanticCoverage(audit.buildMedicationExtractionContext(state).text,
      { source: "not_needed", events: [], unresolvedReferences: [], needsManualReview: false });
    const existingScopeReasons = (existing.reason || "").split(",").filter((reason) => reason.startsWith("medication_current_scope_"));
    assert.deepEqual(existingScopeReasons, expectedReason ? [expectedReason] : [], "the skipped path must match the existing pure scope semantics");
    for (const [path, handler] of [["assess", assess], ["post-prescription-risk", postRisk], ["his-scheme", hisScheme]]) {
      const response = await handler(request(`/api/diagnosis/${path}`, state));
      const text = await response.text();
      assert.equal(response.status, 200, `${path}: ${text}`);
      if (path === "his-scheme") {
        assert.equal(JSON.parse(text).aiMedicalRecord.medicationHistory, medicationHistory, "HIS preserves the original scope evidence, including non-dose projections");
      } else {
        assert.equal(/已记录本次或局部未用药|现用药信息明确不详或尚未核实/.test(text), Boolean(expectedReason), `${path}: ${text}`);
      }
      assert.doesNotMatch(text, /medication_semantics_unavailable/);
      if (path === "post-prescription-risk") {
        const body = JSON.parse(text);
        assert.equal(body.audit.inputAdvisories.some((item) => item.code === "medication_semantics_incomplete"), Boolean(expectedReason));
        assert.equal(body.audit.needManualReview, Boolean(expectedReason));
      }
    }
    assert.equal(JSON.stringify(state), before, "current and historical medication facts remain untouched");
  }));
}
