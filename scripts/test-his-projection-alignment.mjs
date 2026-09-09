import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createJiti } from "jiti";

// Synthetic, offline fixtures only; never load a runtime secret file.
Object.assign(process.env, {
  REASONING_CONTRACT_SIGNING_KEY: "his-projection-test-signing-key-at-least-32-characters",
  CDSS_API_CLIENT_ID: "his-projection-client", CDSS_API_CUSTOMER_IDS: "his-projection-customer",
  CDSS_DEFAULT_CUSTOMER_ID: "his-projection-customer", CDSS_CUSTOMER_ID: "his-projection-customer",
  RXAI_AUDIT_ENABLED: "false",
});
const jiti = createJiti(import.meta.url, { alias: {
  "@": `${process.cwd()}/src`, "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
} });
const signatures = await jiti.import("../src/lib/reasoning-contract-signature.ts");
const { normalizeCaseStateInput } = await jiti.import("../src/lib/diagnosis-types.ts");
const { withSafetyGate, buildDeterministicRiskFollowup } = await jiti.import("../src/lib/diagnosis-safety.ts");
const { getTcmHerbFunctionText } = await jiti.import("../src/lib/tcm-knowledge.ts");
const { synchronizeVisibleClinicalSummary } = await jiti.import("../src/lib/diagnosis-visible-summary.ts");
const { buildUnavailableRxAuditSection, buildAuditItemsFromHerbs } = await jiti.import("../src/lib/rxaudit.ts");
const { findLocalPatentMedicineEntry } = await jiti.import("../src/lib/local-patent-medicine-candidates.ts");
const { validateHisPrescriptionForWriteBack } = await jiti.import("../src/lib/his-prescription-validation.ts");
const { deriveCaseWarningProfile } = await jiti.import("../src/lib/clinical-warning-tier.ts");
const { medicineCandidateRow, verifiedLocalLabelRisk } = await jiti.import("../src/lib/medicine-reference-projection.ts");
const { buildHisAiSchemePayload } = await jiti.import("../src/lib/his-scheme.ts");
const { unsupportedHighImpactHerbFindings } = await jiti.import("../src/lib/diagnosis-stage-contract.ts");
const { isSafetyClinicalDeliveryAdvisory } = await jiti.import("../src/lib/clinical-delivery-advisory.ts");
const { invalidatePrescriptionContractAfterEdit } = await jiti.import("../src/lib/prescription-revision.ts");

// Reuse the existing complete synthetic fixture constructors without changing the golden oracle.
const source = readFileSync(new URL("./regress-tcm-cdss.mjs", import.meta.url), "utf8");
const helpers = source.slice(source.indexOf("function hisRecord("), source.indexOf("function expected("));
const bindings = { ...signatures, normalizeCaseStateInput, withSafetyGate, getTcmHerbFunctionText,
  synchronizeVisibleClinicalSummary, buildUnavailableRxAuditSection, buildDeterministicRiskFollowup,
  CDSS_CUSTOMER_ID: "his-projection-customer" };
const fixtures = new Function(...Object.keys(bindings), `${helpers}\nreturn {baseCase, reasoningV2WithHerbs, completeHisDeliveryFixture};`)(...Object.values(bindings));
const clone = structuredClone;
function complete(reasoning, id = "his-projection") {
  const state = fixtures.completeHisDeliveryFixture(fixtures.baseCase(id, { reasoningV2: reasoning }));
  state.reasoningPrescribe = state.reasoningV2;
  state.riskAssessment = "## 处方安全总评\n审方建议医生复核。\n\n## 随访管理方案\n完成5剂后复诊。";
  state.prescriptionRevision = { candidateIndex: 0, source: "generated", auditAvailable: true,
    auditResult: "MANUAL_REVIEW", highestRiskLevel: "HIGH", needManualReview: true };
  return state;
}
function benign() {
  return complete(fixtures.reasoningV2WithHerbs([{ name: "酸枣仁", dose: "10g", function: "养心安神" }]));
}
const entry = findLocalPatentMedicineEntry("外感风寒颗粒");
assert.ok(entry?.fingerprint);
const compact = (text) => text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 800);
const labelRisk = compact([entry.contraindication, entry.precaution, entry.pregnancyLactation, entry.interaction].filter(Boolean).join("；"));
assert.match(labelRisk, /禁止使用/);
function medicine() {
  return { type: "中成药", name: entry.name, specification: entry.specification,
    evidenceId: "LOCAL-INST-007", evidenceFingerprint: entry.fingerprint, recommendationMode: "candidate_review",
    positioning: "需医生评估", correspondingProblem: "恶寒无汗", usageBoundary: "说明书用法字段已与本候选的说明书条目及指纹绑定。",
    relationship: "与中药饮片方案不默认联用，由医生结合重复功效、相互作用和治疗目标择一或评估联用。",
    riskNote: labelRisk, evidence: { evidenceLevel: "kb_entry", source: "本地药品说明书 [LOCAL-INST-007]", confidence: "中" } };
}
function withMedicine(state, item = medicine()) {
  const reasoning = clone(state.reasoningPrescribe);
  reasoning.formula.patentAndWestern = [item];
  delete reasoning.contractSignature;
  return complete(reasoning);
}
function scope(state) {
  return { candidateIndex: 0, submittedItems: clone(buildAuditItemsFromHerbs(state, 0)) };
}
function payload(state, auditScope = scope(state)) {
  const validation = validateHisPrescriptionForWriteBack(state);
  assert.equal(validation.ok, true, JSON.stringify(validation));
  return buildHisAiSchemePayload(state, undefined, validation.advisories, auditScope);
}

test("exact canonical label risk stays visible without becoming a patient L4", () => {
  const state = withMedicine(benign());
  assert.match(state.prescription, /本品性状发生改变时禁止使用/);
  assert.equal(verifiedLocalLabelRisk(state.reasoningPrescribe.formula.patentAndWestern[0]), true);
  assert.ok(state.prescription.includes(medicineCandidateRow(state.reasoningPrescribe.formula.patentAndWestern[0])));
  const warning = deriveCaseWarningProfile(state);
  assert.equal(warning.level, "L3");
  assert.equal(warning.executable, true);
});

test("current-risk copies, appended risk, other patient columns and forged provenance stay active", () => {
  const state = withMedicine(benign());
  for (const changed of [
    { ...state, riskAssessment: `${state.riskAssessment}\n本品性状发生改变时禁止使用` },
    { ...state, prescription: `${state.prescription}\n## 处方风险提示\n本品性状发生改变时禁止使用` },
    { ...state, prescription: state.prescription.replace(labelRisk, `${labelRisk}；本例配伍禁忌`) },
    withMedicine(benign(), { ...medicine(), correspondingProblem: "本例存在绝对禁忌" }),
    withMedicine(benign(), { ...medicine(), evidenceFingerprint: "forged" }),
    withMedicine(benign(), { ...medicine(), specification: "changed" }),
    withMedicine(benign(), { ...medicine(), riskNote: `${labelRisk}；本例绝对禁忌` }),
    { ...state, prescription: state.prescription.replace(entry.name, "未知颗粒") },
  ]) assert.equal(deriveCaseWarningProfile(changed).level, "L4");
});

test("BLOCK, effective CRITICAL, selected genuine pair and legacy risk cannot be masked", () => {
  for (const revision of [{ auditResult: "BLOCK" }, { highestRiskLevel: "CRITICAL" }]) {
    const state = withMedicine(benign());
    state.prescriptionRevision = { ...state.prescriptionRevision, ...revision };
    assert.equal(deriveCaseWarningProfile(state).level, "L4");
  }
  const pair = withMedicine(complete(fixtures.reasoningV2WithHerbs([
    { name: "甘草", dose: "3g" }, { name: "甘遂", dose: "1g" },
  ])));
  assert.equal(deriveCaseWarningProfile(pair).level, "L4");
  assert.equal(deriveCaseWarningProfile({ ...benign(), prescription: "旧处方：本品性状发生改变时禁止使用" }).level, "L4");
});

function vocabularyState() {
  const reasoning = fixtures.reasoningV2WithHerbs([{ name: "升麻", dose: "3g", prescriptionRole: "升阳举陷" }]);
  reasoning.therapy = { overallPrinciple: "补中益气，升阳举陷", overallMethod: "补中益气，升阳举陷", subTherapies: [] };
  reasoning.overview.overallTherapy = "补中益气，升阳举陷";
  reasoning.formula.candidates[0].therapyMatch = "补中益气，升阳举陷";
  reasoning.clinicalReview = { status: "accepted", provider: "synthetic", model: "synthetic", source: "preferred",
    acceptanceScope: { waivedIssueCodes: [], qualityAnnotationCodes: ["m04_candidate_0_herb_0_unsupported_high_impact_heat_clear"] } };
  return complete(reasoning, "vocabulary-quality");
}

test("signed strict-only direction vocabulary is a visible quality advisory", () => {
  const state = vocabularyState();
  const candidate = state.reasoningPrescribe.formula.candidates[0];
  assert.ok(unsupportedHighImpactHerbFindings(candidate.herbs, state.reasoningDiagnose, true, [], false).some((f) => f.concepts.includes("heat_clear")));
  assert.equal(unsupportedHighImpactHerbFindings(candidate.herbs, state.reasoningDiagnose, true, [], true).length, 0);
  const checked = validateHisPrescriptionForWriteBack(state);
  assert.equal(checked.ok, true);
  assert.ok(checked.advisories.some((a) => /heat_clear/.test(a.code)), JSON.stringify(checked.advisories));
  assert.equal(checked.advisories.some(isSafetyClinicalDeliveryAdvisory), false, JSON.stringify(checked.advisories));
});

test("true opposing direction and simultaneous unrelated safety survive quality acceptance", () => {
  for (const mode of ["opposition", "dose", "pair"]) {
    const reasoning = clone(vocabularyState().reasoningPrescribe);
    delete reasoning.contractSignature;
    if (mode === "opposition") {
      reasoning.therapy = { overallPrinciple: "清热泻火", overallMethod: "苦寒清热", subTherapies: [] };
      reasoning.formula.candidates[0].herbs = fixtures.reasoningV2WithHerbs([{ name: "干姜", dose: "3g" }]).formula.candidates[0].herbs;
    } else if (mode === "dose") reasoning.formula.candidates[0].herbs[0].dose = "9999g";
    else reasoning.formula.candidates[0].herbs.push(...fixtures.reasoningV2WithHerbs([{ name: "甘草", dose: "3g" }, { name: "甘遂", dose: "1g" }]).formula.candidates[0].herbs);
    const state = complete(reasoning);
    const checked = validateHisPrescriptionForWriteBack(state);
    assert.equal(checked.ok, true);
    assert.ok(checked.advisories.some(isSafetyClinicalDeliveryAdvisory), mode);
    assert.equal(payload(state).prescriptions.herbal[0].adoptable, false, mode);
  }
});

test("post-acceptance edit loses signature and review binding", () => {
  const state = vocabularyState();
  const edited = invalidatePrescriptionContractAfterEdit(state.reasoningPrescribe);
  assert.equal(edited.contractSignature, undefined);
  assert.equal(edited.clinicalReview, undefined);
  const checked = validateHisPrescriptionForWriteBack({ ...state, reasoningV2: edited, reasoningPrescribe: edited });
  assert.equal(checked.ok, false);
  assert.equal(checked.code, "invalid_m04_signature");
});

test("submitted identity and combination scope unlocks only the herbal candidate", () => {
  const state = withMedicine(benign());
  const result = payload(state);
  assert.equal(result.status, "ready");
  assert.equal(result.prescriptions.herbal[0].adoptable, true);
  assert.equal(result.prescriptions.westernOrPatent[0].adoptable, false);
  assert.doesNotMatch(JSON.stringify(result), /西药\/中成药候选未进入本次中药饮片审方/);
});

test("missing scope, extra orders, changed medicine fields and truncation stay limited", () => {
  const state = withMedicine(benign());
  assert.equal(payload(state, null).prescriptions.herbal[0].adoptable, false);
  for (const changed of [
    { ...state, prescription: `${state.prescription}\n## 西药/中成药方案\n阿莫西林胶囊每次500mg每日3次` },
    { ...state, prescription: state.prescription.replace(entry.name, "阿莫西林胶囊") },
    withMedicine(benign(), { ...medicine(), specification: "changed" }),
    withMedicine(benign(), { ...medicine(), frequency: "每日99次" }),
  ]) assert.equal(payload(changed, scope(state)).prescriptions.herbal[0].adoptable, false);
  const truncated = scope(state);
  truncated.submittedItems = truncated.submittedItems.filter((item) => item.drug_type === "中药饮片");
  assert.equal(payload(state, truncated).prescriptions.herbal[0].adoptable, false);
});

test("observation-only daily prose does not invent an unsubmitted medicine", () => {
  const state = benign();
  state.prescription += "\n## 中成药/西药候选\n每日观察症状";
  assert.equal(payload(state, null).prescriptions.herbal[0].adoptable, true);
});

test("all three projections agree on a usable herbal candidate while retaining quality and label notices", () => {
  const state = withMedicine(vocabularyState());
  const result = payload(state);
  assert.equal(result.warningProfile.level, "L3");
  assert.equal(result.status, "ready");
  assert.equal(result.candidateStatus, "valid");
  assert.equal(result.writeBackPolicy.allowSingleItemAdoption, true);
  assert.equal(result.prescriptions.herbal[0].adoptable, true);
  assert.equal(result.prescriptions.westernOrPatent[0].adoptable, false);
  assert.ok(result.warnings.some((a) => /heat_clear/.test(a.code)));
  assert.match(result.prescriptions.westernOrPatent[0].content, /禁止使用/);
});
