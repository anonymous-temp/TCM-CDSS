import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { createJiti } from "jiti";

// Synthetic signing only. No env files, HTTP server, provider, or production credentials.
Object.assign(process.env, {
  REASONING_CONTRACT_SIGNING_KEY: "golden-harness-test-signing-key-at-least-32-characters",
  CDSS_API_CLIENT_ID: "golden-harness-client", CDSS_API_CUSTOMER_IDS: "golden-harness-customer",
  CDSS_DEFAULT_CUSTOMER_ID: "golden-harness-customer",
  CDSS_CUSTOMER_ID: "golden-harness-customer", RXAI_AUDIT_ENABLED: "false",
});
const source = readFileSync(new URL("./regress-tcm-cdss.mjs", import.meta.url), "utf8");
const jiti = createJiti(import.meta.url, { alias: {
  "@": `${process.cwd()}/src`, "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
} });
const signatures = await jiti.import("../src/lib/reasoning-contract-signature.ts");
const { normalizeCaseStateInput } = await jiti.import("../src/lib/diagnosis-types.ts");
const { withSafetyGate, buildDeterministicRiskFollowup } = await jiti.import("../src/lib/diagnosis-safety.ts");
const { getTcmHerbFunctionText } = await jiti.import("../src/lib/tcm-knowledge.ts");
const { synchronizeVisibleClinicalSummary } = await jiti.import("../src/lib/diagnosis-visible-summary.ts");
const { buildUnavailableRxAuditSection } = await jiti.import("../src/lib/rxaudit.ts");
const { validateHisPrescriptionForWriteBack } = await jiti.import("../src/lib/his-prescription-validation.ts");
const { buildHisAiSchemePayload } = await jiti.import("../src/lib/his-scheme.ts");
const { buildEvidenceScope } = await jiti.import("../src/lib/evidence-source-validation.ts");
const { isSafetyClinicalDeliveryAdvisory, clinicalDeliveryAdvisoryFromIssue, deduplicateClinicalDeliveryAdvisories } =
  await jiti.import("../src/lib/clinical-delivery-advisory.ts");
const { prescriptionRegimenContractIssue, prescriptionRegimenFromDecoction } = await jiti.import("../src/lib/prescription-regimen-contract.ts");
const { revisionFromAudit } = await jiti.import("../src/lib/followup-display-state.ts");
const { issuePrescriptionRevisionAttestation, verifyPrescriptionRevisionAttestation } =
  await jiti.import("../src/lib/prescription-revision-attestation.server.ts");

function between(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `real harness source boundaries: ${start} / ${end}`);
  return source.slice(from, to);
}

// Execute the actual fixture declarations, not copies that can drift from the live harness.
// Only the HTTP transport/assertion recorder is replaced; all constructors and signatures run.
const helpers = between("function hisRecord(", "function expected(");
const declarations = between("  const invalidWorkbenchReasoning =", "  const trustedDoctorEditCase =");
const requests = [];
const bindings = {
  ...signatures, normalizeCaseStateInput, withSafetyGate, getTcmHerbFunctionText,
  synchronizeVisibleClinicalSummary, buildUnavailableRxAuditSection, buildDeterministicRiskFollowup,
  buildHisAiSchemePayload, buildEvidenceScope,
  revisionFromAudit,
  CDSS_CUSTOMER_ID: "golden-harness-customer",
  request: async (_method, path, body) => { requests.push({ path, caseState: structuredClone(body.caseState) }); return { status: 200, json: {} }; },
  assert: () => {}, assertDeliveryReport: () => {},
};
const load = new Function(...Object.keys(bindings), `return (async () => { ${helpers}\n${declarations}\nreturn {
  negatives: [...hisContractNegativeCases, { name: "HIS classic formula composition drift", caseState: formulaCompositionDriftCase },
    { name: "HIS model output cannot forge the doctor-edit formula exemption", caseState: modelForgedDoctorEditCase }],
  baseCase, reasoningV2WithHerbs, completeHisDeliveryFixture,
}; })();`);
const fixtures = await load(...Object.values(bindings));
const validation = (state) => validateHisPrescriptionForWriteBack(normalizeCaseStateInput(state));
const project = (state, advisories) => buildHisAiSchemePayload(withSafetyGate({ ...state,
  prescriptionRevision: { ...state.prescriptionRevision, source: "herb_workbench", candidateIndex: 0,
    auditResult: "MANUAL_REVIEW", highestRiskLevel: "HIGH", auditAvailable: false, needManualReview: true },
}), buildEvidenceScope(""), advisories);
const allItems = (payload) => [payload.diagnoses.western, payload.diagnoses.tcmPatterns, payload.diagnoses.mechanism,
  payload.prescriptions.herbal, payload.prescriptions.westernOrPatent, payload.checks, payload.followup].flat();
const codes = (findings) => findings.flatMap((finding) => [finding.code, ...(finding.relatedCodes || [])]);

test("live harness preserves every issuer-bound revision field including explicit skip and retained genuine BLOCK", () => {
  const adopter = new Function("revisionFromAudit", `${between("function adoptAttestedRevision(", "/** Deterministic signed cases")}\nreturn adoptAttestedRevision;`)(revisionFromAudit);
  const customer = { clientId: "golden-harness-client", customerId: "golden-harness-customer" };
  for (const candidateIndex of [0, 1, 2]) {
    for (const kind of ["NOT_SUBMITTED", "PASS", "REMIND", "MANUAL_REVIEW", "BLOCK", "retained_BLOCK"]) {
      const state = fixtures.baseCase(`revision-parity-${candidateIndex}-${kind}`);
      const skipped = kind === "NOT_SUBMITTED";
      const retained = kind === "retained_BLOCK";
      const revision = {
        source: "herb_workbench", candidateIndex, herbHash: `sha256-${"a".repeat(64)}`,
        auditedAt: "2026-09-10T00:00:00.000Z", auditResult: retained ? "BLOCK" : kind,
        ...(skipped ? {} : { highestRiskLevel: kind === "PASS" ? "INFO" : "CRITICAL" }),
        auditAvailable: !skipped, degraded: false, needManualReview: kind !== "PASS",
        auditReason: skipped ? "rxaudit_disabled" : "audited",
      };
      const issued = issuePrescriptionRevisionAttestation(state, customer, revision);
      assert.ok(issued, `${kind}: actual issuer signs the synthetic revision`);
      const audit = { ...revision, ...issued, source: skipped || retained ? "skipped" : "lingxi",
        reason: skipped || retained ? "rxaudit_disabled" : "audited", retainedPriorAudit: retained };
      adopter(state, audit);
      assert.equal(verifyPrescriptionRevisionAttestation(state, customer, revision.herbHash), true,
        `${candidateIndex}/${kind}: harness must not rewrite signed fields`);
      assert.equal(state.prescriptionRevision.candidateIndex, candidateIndex);
      assert.equal(state.prescriptionRevision.auditResult, revision.auditResult);
      assert.equal(state.prescriptionRevision.highestRiskLevel, revision.highestRiskLevel);
    }
  }
});

test("advisory assertions accept truthful NOT_SUBMITTED only in explicit-off mode and still reject a fabricated PASS", () => {
  const checks = between("function matchingDeliveryWarning(", "// 源码级断言");
  const execute = (payload, enabled, his = false) => {
    const failures = [];
    new Function("expectRxAuditEnabled", "assert", `${checks}\nassertDeliveryReport({status:200,json:arguments[2]}, /dose_sanity_ceiling/, "test", {his:arguments[3]});`)(enabled,
      (condition, message) => { if (!condition) failures.push(message); }, payload, his);
    return failures;
  };
  const warning = { code: "dose_sanity_ceiling", message: "合成剂量核对提示" };
  const post = { warnings: [warning], section: warning.message, followup: "合成随访正文", audit: {
    source: "skipped", auditResult: "NOT_SUBMITTED", auditAvailable: false, degraded: false,
    reason: "rxaudit_disabled", needManualReview: true,
  } };
  assert.deepEqual(execute(post, false), []);
  assert.ok(execute(post, true).length > 0, "enabled audit cannot silently become skipped");
  assert.ok(execute({ ...post, audit: { ...post.audit, auditResult: "PASS", highestRiskLevel: "INFO" } }, false).length > 0);
  const item = { content: "合成可读内容", adoptable: false };
  const his = { warnings: [warning], status: "limited", candidateStatus: "invalid", workflowPermission: "continue", auditStatus: "not_submitted",
    diagnoses: { western: [item], tcmPatterns: [item], mechanism: [item] },
    prescriptions: { structuredHerbs: [{ name: "合成药味" }], herbal: [item], westernOrPatent: [item] },
    checks: [item], followup: [item], writeBackPolicy: { allowSingleItemAdoption: false, allowOneClickAdoption: false } };
  assert.deepEqual(execute(his, false, true), []);
  assert.ok(execute(his, true, true).length > 0);
  assert.ok(execute({ ...his, auditStatus: "pass" }, false, true).length > 0);
  assert.ok(execute({ ...his, prescriptions: { ...his.prescriptions, herbal: [{ ...item, adoptable: true }] } }, false, true).length > 0,
    "skipping a dependency cannot waive the local T1 item boundary");
});

test("all 18 migrated HIS fixtures have synchronized complete bodies and current signatures", () => {
  assert.equal(fixtures.negatives.length, 18);
  for (const item of fixtures.negatives) {
    const state = requests.find((request) => request.path === "/api/diagnosis/his-scheme" && request.caseState.id === item.caseState.id)?.caseState;
    assert.ok(state, `${item.name}: actual outgoing fixture captured`);
    for (const field of ["diagnosis", "prescription", "riskAssessment"]) assert.ok(state[field]?.trim(), `${item.name}: complete ${field}`);
    assert.equal(signatures.verifyDiagnoseReasoningSignature(state.reasoningDiagnose, state), true, item.name);
    assert.equal(signatures.verifyPrescribeReasoningSignature(state.reasoningV2, state), true, item.name);
    const candidate = state.reasoningV2.formula.candidates[0];
    assert.deepEqual(candidate, item.caseState.reasoningV2.formula.candidates[0], `${item.name}: exact intended defects survive completion`);
    for (const herb of candidate.herbs) {
      assert.ok(state.prescription.includes(herb.name), `${item.name}: ${herb.name} remains readable`);
      assert.ok(state.prescription.includes(herb.dose), `${item.name}: ${herb.dose} remains readable`);
    }
  }
});

test("10 T1 and 7 follow-up DTO negatives remain limited/invalid with every adoption field false", () => {
  for (const item of fixtures.negatives.filter((entry) => entry.name !== "HIS ungrounded herb function")) {
    assert.notEqual(item.qualityOnly, true, `${item.name}: actual DTO safety error cannot be labeled T2-only`);
    const checked = validation(item.caseState);
    assert.equal(checked.ok, true, `${item.name}: authenticated readable report survives`);
    assert.ok(checked.advisories.some(isSafetyClinicalDeliveryAdvisory), item.name);
    const payload = project(item.caseState, checked.advisories);
    assert.equal(payload.status, "limited", item.name);
    assert.equal(payload.candidateStatus, "invalid", item.name);
    assert.equal(payload.workflowPermission, "continue", item.name);
    assert.notEqual(payload.auditStatus, "pass", item.name);
    assert.equal(payload.writeBackPolicy.allowSingleItemAdoption, false, item.name);
    assert.equal(payload.writeBackPolicy.allowOneClickAdoption, false, item.name);
    assert.ok(allItems(payload).length >= 7 && allItems(payload).every((item) => item.adoptable === false), item.name);
  }
});

test("fixture completion preserves the entire malformed candidate byte-for-byte and leaves its input untouched", () => {
  for (const item of fixtures.negatives) {
    const original = structuredClone(item.caseState);
    original.prescription = "";
    original.riskAssessment = "";
    const snapshot = structuredClone(original);
    const completed = fixtures.completeHisDeliveryFixture(original);
    assert.deepEqual(original, snapshot, `${item.name}: caller's fixture is immutable`);
    assert.deepEqual(completed.reasoningV2.formula, snapshot.reasoningV2.formula, `${item.name}: exact herbs/doses/targets/decoction/follow-up survive`);
    assert.deepEqual(completed.reasoningDiagnose.overview, snapshot.reasoningDiagnose.overview, `${item.name}: formula identity remains unchanged`);
  }
});

test("candidate follow-up description T2 cannot hide the independent bare DTO T1, including merged codes", () => {
  const followups = fixtures.negatives.filter((item) => item.issue?.source === "follow_up_inconsistent");
  assert.equal(followups.length, 7);
  for (const item of followups) {
    const candidate = item.caseState.reasoningV2.formula.candidates[0];
    assert.equal(prescriptionRegimenContractIssue(candidate.decoction), "follow_up_inconsistent", item.name);
    assert.equal(prescriptionRegimenFromDecoction(candidate.decoction), null, item.name);
    const candidateOnly = clinicalDeliveryAdvisoryFromIssue("candidate_0_follow_up_inconsistent", candidate);
    const bareDto = clinicalDeliveryAdvisoryFromIssue("follow_up_inconsistent", candidate);
    assert.equal(isSafetyClinicalDeliveryAdvisory(candidateOnly), false);
    assert.equal(isSafetyClinicalDeliveryAdvisory(bareDto), true);
    const merged = deduplicateClinicalDeliveryAdvisories([candidateOnly, bareDto]);
    assert.equal(merged.length, 1);
    assert.ok(codes(merged).includes("follow_up_inconsistent"));
    assert.equal(isSafetyClinicalDeliveryAdvisory(merged[0]), true);
    const checked = validation(item.caseState);
    assert.ok(codes(checked.advisories).includes("follow_up_inconsistent"));
    assert.ok(codes(checked.advisories).some((code) => /^candidate_\d+_follow_up_inconsistent$/.test(code)));
  }
});

test("ungrounded function is a real T2 delta over an actually adoptable complete control; missing bodies stay pending", () => {
  const item = fixtures.negatives.find((entry) => entry.name === "HIS ungrounded herb function");
  const state = item.caseState;
  const checked = validation(state);
  assert.equal(checked.ok, true);
  assert.ok(codes(checked.advisories).some((code) => /function_ungrounded/.test(code)));
  assert.equal(checked.advisories.some(isSafetyClinicalDeliveryAdvisory), false);
  const baseline = requests.find((request) => request.caseState.id === "his-function-quality-baseline")?.caseState;
  assert.ok(baseline, "the real harness submits the complete benign control");
  const baselineCheck = validation(baseline);
  assert.equal(baselineCheck.ok, true);
  assert.equal(baselineCheck.advisories.some(isSafetyClinicalDeliveryAdvisory), false);
  assert.equal(codes(baselineCheck.advisories).some((code) => /function_ungrounded/.test(code)), false);
  const correctedFormula = structuredClone(state.reasoningV2.formula);
  correctedFormula.candidates[0].herbs[0].function = "养心安神";
  assert.deepEqual(correctedFormula, baseline.reasoningV2.formula, "the paired candidate changes only the intended function description");
  const before = project(baseline, baselineCheck.advisories);
  const after = project(state, checked.advisories);
  assert.equal(before.status, "ready", "control must already be complete and adoptable");
  assert.equal(before.candidateStatus, "valid");
  assert.equal(before.writeBackPolicy.allowSingleItemAdoption, true);
  assert.equal(before.prescriptions.herbal[0].adoptable, true);
  assert.deepEqual(after.writeBackPolicy, before.writeBackPolicy);
  assert.deepEqual(allItems(after).map((item) => item.adoptable), allItems(before).map((item) => item.adoptable));
  assert.equal(after.status, before.status);
  assert.equal(after.candidateStatus, before.candidateStatus);
  assert.ok(codes(after.warnings).some((code) => /function_ungrounded/.test(code)));
  for (const field of ["diagnosis", "prescription", "riskAssessment"]) {
    const missing = project({ ...state, [field]: "" }, checked.advisories);
    assert.equal(missing.status, "pending", `missing ${field} keeps documented pending precedence`);
    assert.equal(missing.writeBackPolicy.allowSingleItemAdoption, false);
  }
  assert.equal(fixtures.baseCase("unmodified-base").prescription, "", "baseCase defaults remain untouched");
});

test("the real CLI failure-report block drains multi-megabyte JSON before exiting nonzero", async () => {
  const reportBlock = between("    const failureReport = COMPACT_FAILURES", "\n  }\n}\n\nmain()");
  const program = `const COMPACT_FAILURES = false; const failures = [{ message: "synthetic-large-report", details: "临床夹具证据".repeat(180000) }];\n${reportBlock}`;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", program], { stdio: ["ignore", "pipe", "pipe"] });
  const chunks = [];
  child.stderr.on("data", (chunk) => chunks.push(chunk));
  const exitCode = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
  assert.equal(exitCode, 1, "failed regression keeps nonzero exit status");
  const output = Buffer.concat(chunks).toString("utf8");
  assert.ok(Buffer.byteLength(output) > 2_000_000, `full report must reach the pipe; got ${Buffer.byteLength(output)} bytes`);
  const report = JSON.parse(output);
  assert.equal(report.failures[0].message, "synthetic-large-report");
  assert.equal(report.failures[0].details, "临床夹具证据".repeat(180000));
  assert.doesNotMatch(source, /process\.exit\(/, "all terminal CLI branches must drain their report, including catch");
});
