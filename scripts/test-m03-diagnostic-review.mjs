import assert from "node:assert/strict";

import {
  boundedM03DiagnosticRepairGuidance,
  buildM03DiagnosticReviewPayload,
  canRebindM03DiagnosticReview,
  m03DiagnosticReviewDiffPaths,
  m03DiagnosticRepairGuidanceCodes,
  m03DiagnosticReviewSemanticHash,
  parseM03DiagnosticReview,
  preflightM03DiagnosticReview,
} from "../src/lib/m03-diagnostic-review.ts";

const evidence = { evidenceLevel: "model_inference", source: "本例四诊资料", confidence: "中" };
const reviewed = {
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "diagnose",
  overview: {
    primarySyndrome: "心脾两虚证",
    primarySyndromeBasis: ["心悸健忘", "纳差便溏"],
    secondarySyndromes: [],
    overallPathogenesis: "脾气亏虚，心血失养",
    overallTherapy: "健脾益气，养血安神",
    recommendedFormulaDirection: "归脾汤加减",
    recommendedFormulaNames: ["归脾汤"],
    formulaSelectionMode: "single",
    evidence,
  },
  westernDiagnosis: {
    primary: {
      name: "失眠症状",
      status: "考虑",
      confidence: "中",
      supportingFacts: ["入睡困难、多梦易醒3个月"],
      limitations: ["未完成睡眠量表"],
      suggestedChecks: [],
      evidence,
    },
    differentials: [],
  },
  pathogenesis: {
    summary: "心脾两虚，心神失养",
    locationDifferentiation: { items: ["心", "脾"], evidence },
    natureDifferentiation: { items: ["气血两虚"], evidence },
    chain: [{
      nodeId: "P1",
      patientFact: "心悸健忘、纳差便溏",
      syndromeEvidence: "舌淡，脉细弱",
      pathogenesis: "脾气亏虚，心血失养",
      therapyDirection: "健脾益气，养血安神",
      evidence,
    }],
    uncertainties: [],
  },
  therapy: { overallPrinciple: "健脾益气，养血安神", subTherapies: [] },
};

const provenanceOnly = structuredClone(reviewed);
provenanceOnly.overview.evidence = { ...evidence, source: "经服务端证据白名单核验" };
provenanceOnly.pathogenesis.chain[0].evidence = { ...evidence, confidence: "高" };
provenanceOnly.contractSignature = "hmac-sha256:placeholder";
provenanceOnly.clinicalReview = { status: "accepted", reviewedPayloadHash: "sha256:placeholder" };
provenanceOnly.formula = null;
provenanceOnly.nonPharma = null;

assert.deepEqual(buildM03DiagnosticReviewPayload(provenanceOnly), buildM03DiagnosticReviewPayload(reviewed));
assert.equal(m03DiagnosticReviewSemanticHash(provenanceOnly), m03DiagnosticReviewSemanticHash(reviewed));
assert.equal(canRebindM03DiagnosticReview(reviewed, provenanceOnly), true);
assert.deepEqual(m03DiagnosticReviewDiffPaths(reviewed, provenanceOnly), []);

for (const mutate of [
  (value) => { value.westernDiagnosis.primary.supportingFacts = ["无来源的新事实"]; },
  (value) => { value.overview.primarySyndrome = "痰热扰心证"; },
  (value) => { value.pathogenesis.chain[0].therapyDirection = "清热化痰"; },
  (value) => { value.overview.recommendedFormulaNames = ["黄连温胆汤"]; },
]) {
  const changed = structuredClone(reviewed);
  mutate(changed);
  assert.equal(canRebindM03DiagnosticReview(reviewed, changed), false);
  assert.ok(m03DiagnosticReviewDiffPaths(reviewed, changed).length > 0);
}

assert.deepEqual(parseM03DiagnosticReview('{"status":"accepted","issueCode":"none"}'), {
  status: "accepted",
  issueCode: "none",
});
assert.deepEqual(parseM03DiagnosticReview('{"status":"repair","issueCode":"supporting_fact_mismatch"}'), {
  status: "repair",
  issueCode: "supporting_fact_mismatch",
});
assert.deepEqual(parseM03DiagnosticReview('{"status":"repair","issueCode":"tcm_reasoning_unsupported","repairInstruction":"pathogenesis.chain[0] 使用了病历未支持的痰热方向，请删除并按现有阳性事实降级。"}'), {
  status: "repair",
  issueCode: "tcm_reasoning_unsupported",
  repairInstruction: "pathogenesis.chain[0] 使用了病历未支持的痰热方向，请删除并按现有阳性事实降级。",
});
const boundedTcmGuidance = boundedM03DiagnosticRepairGuidance({
  status: "repair",
  issueCode: "tcm_reasoning_unsupported",
  repairInstruction: "清空病机链并补入阴虚火旺",
});
assert.match(boundedTcmGuidance, /硬性删减/);
assert.match(boundedTcmGuidance, /阴虚、阳虚、气虚、血虚/);
assert.match(boundedTcmGuidance, /语义隔离模式/);
assert.doesNotMatch(boundedTcmGuidance, /清空病机链并补入阴虚火旺/);
const emptyReviewed = structuredClone(reviewed);
emptyReviewed.pathogenesis.chain = [];
const reviewedClinicalContext = "心悸健忘、纳差便溏；舌淡，脉细弱；入睡困难、多梦易醒3个月";
assert.deepEqual(preflightM03DiagnosticReview(emptyReviewed, reviewedClinicalContext), {
  status: "repair",
  issueCode: "tcm_reasoning_unsupported",
  repairInstruction: "deterministic_contract:chain_empty",
});
assert.equal(preflightM03DiagnosticReview(reviewed, reviewedClinicalContext), undefined);
assert.equal(boundedM03DiagnosticRepairGuidance({
  status: "repair",
  issueCode: "formula_indication_mismatch",
  repairInstruction: "移除缺少方证依据的命名方",
}), "移除缺少方证依据的命名方");
assert.deepEqual(m03DiagnosticRepairGuidanceCodes({
  status: "repair",
  issueCode: "tcm_reasoning_unsupported",
  repairInstruction: "病机链只是重复主诉，阴虚与营卫失和均无充分支持；请勿清空病位病性。",
}), ["empty_or_unresolved", "symptom_restatement", "chain_not_closed", "yin_deficiency_overreach", "ying_wei_overreach"]);
assert.equal(parseM03DiagnosticReview('{"status":"accepted","issueCode":"invented"}').status, "unavailable");

console.log(JSON.stringify({ cases: 15, failures: 0 }));
