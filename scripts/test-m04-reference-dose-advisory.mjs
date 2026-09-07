import assert from "node:assert/strict";
import { test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: {
  "@": `${process.cwd()}/src`,
  "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
} });
const { ordinaryHistoricalDoseDeviation, m04SemanticIssue, m04SafetyContractIssue, dosePassesSafetySanityCeiling } = await jiti.import("../src/lib/diagnosis-stage-contract.ts");
const { compileM04Proposal } = await jiti.import("../src/lib/m04-proposal-compiler.ts");
const { normalizeReasoningV2, normalizeCaseStateInput, ReasoningV2Schema } = await jiti.import("../src/lib/diagnosis-types.ts");
const { buildHisAiSchemePayload } = await jiti.import("../src/lib/his-scheme.ts");
const { classifyHerbWarning } = await jiti.import("../src/lib/clinical-warning-tier.ts");
const { getTcmHerbDoseLimit, isKnownTcmHerbName } = await jiti.import("../src/lib/tcm-knowledge.ts");
const { rejectionTier, qualityAnnotationCopy } = await jiti.import("../src/lib/diagnosis-rejection-tiers.ts");
const { collectClinicalDeliveryAdvisories } = await jiti.import("../src/lib/clinical-delivery-advisory.ts");
const { m04FinalReviewQualityAnnotation } = await jiti.import("../src/lib/m04-repair-policy.ts");

const prior = ReasoningV2Schema.parse({
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
  overview: { primarySyndrome: "脾胃虚弱证", overallPathogenesis: "脾胃虚弱，运化无力", recommendedFormulaNames: [], formulaSelectionMode: "self_devised" },
  pathogenesis: { chain: [
    { nodeId: "P1", patientFact: "食少倦怠", syndromeEvidence: "食少倦怠", pathogenesis: "脾胃虚弱，运化无力", therapyDirection: "健脾益气" },
    { nodeId: "P2", patientFact: "大便溏薄", syndromeEvidence: "大便溏薄", pathogenesis: "脾虚湿盛", therapyDirection: "健脾化湿" },
  ] },
  therapy: { overallPrinciple: "虚则补之", overallMethod: "健脾益气，化湿和中", subTherapies: [{ therapy: "健脾益气", targetPathogenesis: "脾胃虚弱", priority: "主要" }] },
  formula: { candidates: [], patentAndWestern: [], modifications: [] },
});
const proposal = {
  candidate: {
    name: "本例辨证组方",
    herbs: [
      { name: "党参", dose: "12g", role: "君", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, function: "补脾益气" },
      { name: "白术", dose: "10g", role: "臣", targetKind: "pathogenesis_node", targetRef: "P2", structureRole: null, function: "健脾燥湿" },
      { name: "茯苓", dose: "12g", role: "佐", targetKind: "pathogenesis_node", targetRef: "P2", structureRole: null, function: "健脾渗湿" },
      { name: "炙甘草", dose: "6g", role: "使", targetKind: "formula_structure", targetRef: "FORMULA_STRUCTURE", structureRole: "harmonize", function: "补脾和胃" },
    ].map((herb) => ({ ...herb, processing: null, isToxic: false, decoctionRequirement: null })),
    decoction: { doseCount: "5剂", dosesPerDay: 1, administrationTimesPerDay: 2, method: "每日一剂，煎服", followUpNode: "五日复诊" },
    formulaAnalysis: "党参补脾益气，白术健脾燥湿，茯苓渗湿，炙甘草补脾和胃。",
  },
  patentAndWestern: [], modifications: [],
  nonPharma: { diet: "早餐可用山药小米粥，少量多餐。", lifestyle: "规律作息。", emotion: "调畅情志。", precautions: [], tcmTreatments: [] },
};
const compiled = (dose = "12g") => {
  const value = structuredClone(proposal);
  value.candidate.herbs[0].dose = dose;
  return compileM04Proposal(value, prior);
};
const floor = (value, context = "食少倦怠；大便溏薄") => m04SafetyContractIssue(value, prior, isKnownTcmHerbName, false, false, context, true);

test("ordinary historical range deviation has a distinct advice code, never blanket T1 demotion", () => {
  for (const name of ["党参", "黄连", "海螵蛸"]) {
    const limit = getTcmHerbDoseLimit(name);
    for (const grams of [limit.min / 2, limit.max + 1]) {
      const dose = `${grams}g`;
      const deviation = ordinaryHistoricalDoseDeviation({ name, dose, isToxic: false }, "煎服");
      assert.ok(deviation, `${name} ${dose} should carry a reference-deviation advisory`);
      assert.equal(deviation.dose, dose);
      assert.equal(deviation.min, limit.min);
      assert.equal(deviation.max, limit.max);
      assert.equal(deviation.basis, limit.basis);
      assert.equal(deviation.direction, grams < limit.min ? "below_reference" : "above_reference");
    }
  }
  assert.equal(rejectionTier("m04_candidate_0_herb_0_dose_reference_deviation"), "T2");
  assert.equal(rejectionTier("m04_candidate_0_herb_0_dose_outside_conservative_range"), "T1");
});

test("toxic, controlled, ambiguous, missing/curated ranges and invalid magnitudes remain ineligible", () => {
  for (const herb of [
    { name: "党参", dose: "31g", isToxic: true },
    { name: "附子", dose: "16g" }, { name: "朱砂", dose: "1g" }, { name: "犀角", dose: "1g" },
    { name: "贯众", dose: "10g" }, { name: "不存在药味", dose: "10g" },
    { name: "龙骨", dose: "121g" }, { name: "生地黄", dose: "16g" },
    { name: "党参", dose: "501g" }, { name: "党参", dose: "0g" },
    { name: "党参", dose: "-1g" }, { name: "党参", dose: "2片" },
  ]) assert.equal(ordinaryHistoricalDoseDeviation(herb, "煎服"), undefined, JSON.stringify(herb));
  assert.equal(ordinaryHistoricalDoseDeviation({ name: "党参", dose: "12g" }, "煎服"), undefined);
});

test("generation emits advice while full safety rerun retains every other safety check", () => {
  assert.equal(floor(compiled()), undefined, "baseline is a valid safety-floor fixture");
  for (const dose of ["1g", "31g"]) {
    const value = compiled(dose);
    assert.equal(m04SemanticIssue(value, "", prior, isKnownTcmHerbName, true, true, false, false, "", true), "candidate_0_herb_0_dose_reference_deviation");
    assert.equal(floor(value), undefined);
    const badSecond = structuredClone(value);
    badSecond.formula.candidates[0].herbs[1].dose = "200g";
    assert.match(floor(badSecond), /herb_1_dose_sanity_ceiling/);
    const badUnit = structuredClone(value);
    badUnit.formula.candidates[0].herbs[1].dose = "2片";
    assert.match(floor(badUnit), /herb_1_dose$/);
  }
  assert.equal(dosePassesSafetySanityCeiling("党参", "1000g"), false);
});

test("compiler keeps dose visible and explicitly unverified through normalization", () => {
  for (const dose of ["1g", "31g"]) {
    const value = compiled(dose);
    const herb = value.formula.candidates[0].herbs[0];
    assert.equal(herb.dose, dose);
    assert.equal(herb.verificationTier, "unverified_dose");
    assert.match(herb.verificationReasons.join("；"), /历史参考/);
    assert.ok(herb.verificationReasons.some((reason) => reason.includes(dose)));
    assert.match(herb.verificationReasons.join("；"), /2020/);
    assert.doesNotMatch(herb.verificationReasons.join("；"), /剂量已按.*完成规则校验/);
    const normalized = normalizeReasoningV2(value);
    assert.deepEqual(normalized.formula.candidates[0].herbs[0].verificationReasons, herb.verificationReasons);
    assert.equal(normalized.formula.candidates[0].herbs[0].verificationTier, "unverified_dose");
  }
  assert.equal(compiled().formula.candidates[0].herbs[0].verificationTier, "verified");
});

test("doctor advice distinguishes a historical reference from medical approval", () => {
  const candidate = compiled("31g").formula.candidates[0];
  const advice = collectClinicalDeliveryAdvisories(candidate, prior, "食少倦怠；大便溏薄");
  const doseAdvice = advice.find((row) => row.code === "candidate_0_herb_0_dose_reference_deviation");
  assert.ok(doseAdvice);
  assert.match(doseAdvice.message, /31g/);
  assert.match(doseAdvice.message, /历史参考/);
  assert.match(doseAdvice.suggestedAction, /医生/);
  assert.doesNotMatch(qualityAnnotationCopy("m04_candidate_0_herb_0_dose_reference_deviation"), /通过安全核验|剂量.*通过/);
  assert.doesNotMatch(m04FinalReviewQualityAnnotation({ status: "repair", issueCode: "dose_rationale_concern" }), /每味剂量均在药典边界内/);
});

test("HIS preserves readable unverified dose and marks only herbal adoption as reference-only", () => {
  const scheme = (dose) => buildHisAiSchemePayload(normalizeCaseStateInput({
    chiefComplaint: "食少倦怠，大便溏薄", phase: "done", questionRounds: 2,
    patient: { age: 40, sex: "男" }, allergyHistory: "否认药物过敏史", medicationHistory: "否认长期用药",
    fields: { zhushu: "食少倦怠，大便溏薄", shexiang: "舌淡苔白", maixiang: "脉弱" },
    diagnosis: "## 中医诊断概览\n脾胃虚弱证\n## 治则治法\n健脾益气，化湿和中",
    prescription: `## 中药饮片处方\n党参${dose} 白术10g 茯苓12g 炙甘草6g`,
    riskAssessment: "## 随访管理方案\n五日复诊",
    reasoningDiagnose: prior, reasoningPrescribe: compiled(dose),
  }));
  const normal = scheme("12g");
  const unusual = scheme("31g");
  const herb = unusual.prescriptions.structuredHerbs[0];
  assert.ok(herb, "reference-only mode must preserve the entire herbal table");
  assert.equal(herb.dose, "31g");
  assert.equal(herb.verificationTier, "unverified_dose");
  assert.equal(unusual.prescriptions.herbal[0].referenceOnly, true);
  assert.equal(unusual.prescriptions.herbal[0].adoptable, false);
  assert.match(unusual.prescriptions.herbal[0].blockedReason, /AI.*候选|候选.*剂量/);
  assert.equal(unusual.writeBackPolicy.overrideReasonRequired, true);
  assert.equal(unusual.writeBackPolicy.doctorReviewRequired, true);
  assert.equal(unusual.writeBackPolicy.pharmacistReviewRequired, true);
  assert.deepEqual(unusual.diagnoses, normal.diagnoses);
  assert.equal(normal.prescriptions.herbal[0].referenceOnly, undefined);
  const warning = classifyHerbWarning({ drug: herb.name, dose: herb.dose, verificationTier: herb.verificationTier, verificationReasons: herb.verificationReasons });
  assert.equal(warning.level, "L2");
  assert.ok(warning.reasons.some((reason) => reason.includes("31g")));
});
