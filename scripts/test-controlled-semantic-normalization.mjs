import assert from "node:assert/strict";
import syndromeJson from "../src/data/tcm-syndrome-lexicon.json" with { type: "json" };

const {
  prefilterControlledSemanticCandidates,
  validatedClosedSetDecision,
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

// 2026-09-25 预筛改为按候选缓存预处理 + 整数名次排序（去掉每次对几千个同分项逐对 localeCompare）。
// 下面是 68ea3f0 的原算法逐字参照实现：新实现必须与它逐项同序，含「正分不足 limit 时零分项补齐」。
{
  const TERM_PUNCTUATION = /[\s，,。.!！?？；;：:、（）()【】\[\]《》"'“”‘’_\-/\\]+/g;
  const norm = (v) => typeof v === "string" ? v.normalize("NFKC").replace(TERM_PUNCTUATION, "").toLowerCase().trim() : "";
  const chars = (v) => new Set([...v]);
  const grams = (v, w) => !v ? new Set() : v.length <= w ? new Set([v]) : new Set(Array.from({ length: v.length - w + 1 }, (_, i) => v.slice(i, i + w)));
  const dice = (l, r) => { if (!l.size || !r.size) return 0; let o = 0; for (const x of l) if (r.has(x)) o += 1; return (2 * o) / (l.size + r.size); };
  const score = (input, c) => {
    let best = 0;
    for (const v of [c.canonical, ...c.aliases].map(norm).filter(Boolean)) {
      if (v === input) return 100;
      const containment = v.includes(input) || input.includes(v) ? Math.min(v.length, input.length) / Math.max(v.length, input.length) : 0;
      best = Math.max(best, containment * 8 + dice(grams(input, 2), grams(v, 2)) * 6 + dice(chars(input), chars(v)) * 3 +
        Number(input[0] === v[0]) * 0.25 + Number(input.at(-1) === v.at(-1)) * 0.25);
    }
    return best;
  };
  const reference = (inputValue, candidates, limit = 24) => {
    const input = norm(inputValue);
    if (!input) return [];
    return candidates.map((c) => ({ c, s: score(input, c) }))
      .sort((a, b) => b.s - a.s || a.c.canonical.localeCompare(b.c.canonical) || a.c.id.localeCompare(b.c.id))
      .slice(0, Math.max(1, limit)).map((x) => x.c.id);
  };
  const inputs = ["痰热蒙扰心神", "肝胃不和", "脾虚湿盛", "心脾两虚", "a", "", "湿热下注证", "不寐"];
  for (let i = 0; i < syndromeCandidates.length; i += 97) inputs.push(syndromeCandidates[i].canonical.slice(1));
  for (const input of inputs) for (const limit of [1, 24, 60]) {
    assert.deepEqual(prefilterControlledSemanticCandidates(input, syndromeCandidates, limit).map((c) => c.id), reference(input, syndromeCandidates, limit), `prefilter order drift: ${input}/${limit}`);
    cases += 1;
  }
  const tiny = [{ id: "b", canonical: "乙", aliases: [] }, { id: "a", canonical: "甲", aliases: ["丙"] }, { id: "c", canonical: "乙", aliases: [] }];
  for (const input of ["甲", "丁", "乙丙"]) for (const limit of [1, 2, 3, 10]) {
    assert.deepEqual(prefilterControlledSemanticCandidates(input, tiny, limit).map((c) => c.id), reference(input, tiny, limit), `zero-score fill drift: ${input}/${limit}`);
    cases += 1;
  }
}

const target = {
  key: "m1",
  namespace: "tcm_syndrome",
  fieldPath: "overview.primarySyndrome",
  input: "痰热蒙扰心神",
  candidates: shortlist,
};
// 2026-09-20 起单次闭集调用（原为同一提示词连发两遍取一致）。受理判据仍守住：闭集内、置信度下限、弃权不映射。
check(
  validatedClosedSetDecision(target, { key: "m1", candidateId: governedPhlegmFire.id, confidence: 0.88 }, 0.8)?.candidate.id === governedPhlegmFire.id,
  "one in-set high-confidence decision may form one controlled suggestion",
);
check(
  validatedClosedSetDecision(target, { key: "m1", candidateId: "NOT-IN-CLOSED-SET", confidence: 0.99 }) == null,
  "an invented ID must be rejected",
);
check(
  validatedClosedSetDecision(target, { key: "m1", candidateId: governedPhlegmFire.id, confidence: 0.79 }, 0.8) == null,
  "a decision below the confidence floor must abstain",
);
check(
  validatedClosedSetDecision(target, { key: "m1", candidateId: null, confidence: 0.99 }) == null,
  "an explicit model abstention must never form a mapping",
);
check(
  validatedClosedSetDecision(target, { key: "m2", candidateId: governedPhlegmFire.id, confidence: 0.99 }) == null,
  "a decision for another target key must not be borrowed",
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
