import assert from "node:assert/strict";
import syndromeJson from "../src/data/tcm-syndrome-lexicon.json" with { type: "json" };

const {
  prefilterControlledSemanticCandidates,
  validatedConsensusDecision,
} = await import("../src/lib/controlled-semantic-normalization.ts");
const { retrieveTcmFormulaCandidatesForReasoning } = await import("../src/lib/tcm-formula-indications.ts");

let cases = 0;
const check = (condition, message) => {
  cases += 1;
  assert.ok(condition, message);
};

const syndromeCandidates = syndromeJson.entries
  .filter((item) => item.termClass !== "category_heading")
  .map((item) => ({ id: item.id, canonical: item.canonical, aliases: item.aliases || [] }));
const shortlist = prefilterControlledSemanticCandidates("痰热蒙扰心神", syndromeCandidates, 24);
const governedPhlegmFire = shortlist.find((item) => item.canonical === "痰火扰神");
check(Boolean(governedPhlegmFire), "generic lexical prefilter must retain the governed semantic equivalent without a case-specific regex");

const target = {
  key: "m1",
  namespace: "tcm_syndrome",
  fieldPath: "overview.primarySyndrome",
  input: "痰热蒙扰心神",
  candidates: shortlist,
};
check(
  validatedConsensusDecision(
    target,
    { key: "m1", candidateId: governedPhlegmFire.id, confidence: 0.91 },
    { key: "m1", candidateId: governedPhlegmFire.id, confidence: 0.88 },
    0.8,
  )?.candidate.id === governedPhlegmFire.id,
  "two in-set high-confidence decisions may form one controlled suggestion",
);
check(
  validatedConsensusDecision(
    target,
    { key: "m1", candidateId: governedPhlegmFire.id, confidence: 0.91 },
    { key: "m1", candidateId: shortlist.find((item) => item.id !== governedPhlegmFire.id).id, confidence: 0.91 },
  ) == null,
  "first-run disagreement must abstain",
);
check(
  validatedConsensusDecision(
    target,
    { key: "m1", candidateId: "NOT-IN-CLOSED-SET", confidence: 0.99 },
    { key: "m1", candidateId: "NOT-IN-CLOSED-SET", confidence: 0.99 },
  ) == null,
  "an invented ID must be rejected even when both model calls agree",
);
check(
  validatedConsensusDecision(
    target,
    { key: "m1", candidateId: governedPhlegmFire.id, confidence: 0.79 },
    { key: "m1", candidateId: governedPhlegmFire.id, confidence: 0.99 },
  ) == null,
  "the weaker consensus leg must still satisfy the confidence floor",
);

const reasoningWithMapping = (status) => ({
  overview: {
    primarySyndrome: "痰热蒙扰心神",
    overallPathogenesis: "痰热内扰，心神不宁",
    tcmDifferentials: [],
  },
  pathogenesis: {
    summary: "痰热内扰心神",
    locationDifferentiation: { items: ["心"], details: [] },
    natureDifferentiation: { items: ["痰", "热"], rootDeficiency: [], branchExcess: ["痰", "热"] },
    chain: [{ pathogenesis: "痰热内扰心神", therapyDirection: "理气化痰、清胆和胃" }],
  },
  therapy: {
    overallPrinciple: "祛邪",
    overallMethod: "理气化痰、清胆和胃",
    subTherapies: [],
  },
  terminologyMappings: [{
    namespace: "tcm_syndrome",
    fieldPath: "overview.primarySyndrome",
    originalText: "痰热蒙扰心神",
    candidateId: governedPhlegmFire.id,
    canonical: governedPhlegmFire.canonical,
    resolvedBy: "deepseek_closed_set",
    status,
    confidence: 0.88,
    model: "deepseek-v4-flash",
    consensus: true,
    cache: "miss",
  }],
});
const suggestedRecall = retrieveTcmFormulaCandidatesForReasoning(reasoningWithMapping("suggested"), 10);
const suggestedWendan = suggestedRecall.find((item) => item.name === "温胆汤");
check(Boolean(suggestedWendan), "a semantic mapping may add the governed formula to the recall union");
check(suggestedWendan?.positiveSufficiency === false, "an unconfirmed semantic mapping must not lock a named formula");
check(/待医生确认/.test(suggestedWendan?.positiveSufficiencyBasis || ""), "the recall trace must expose the confirmation boundary");
const confirmedWendan = retrieveTcmFormulaCandidatesForReasoning(reasoningWithMapping("clinician_confirmed"), 10)
  .find((item) => item.name === "温胆汤");
check(confirmedWendan?.positiveSufficiency === true, "the same governed ID may authorize positive sufficiency only after explicit clinician confirmation");

console.log(JSON.stringify({ cases, failures: 0 }));
