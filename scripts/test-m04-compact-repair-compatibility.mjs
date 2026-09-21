import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { stabilizeM04DoseOnlyRepair, buildM04ClinicalRepairHint, m04CandidatePatchEligible, m04CandidatePatchBase, spliceM04CandidatePatch } = await jiti.import("../src/lib/structured-clinical-repair.ts");
const { responseFormatForTask } = await jiti.import("../src/lib/model-response-format.ts");
const version = "tcm-cdss-m04-proposal-v1";
const rejected = {
  candidate: {
    name: "本例辨证组方",
    herbs: [{ name: "黄连", dose: "12g", role: "君" }, { name: "甘草", dose: "3g", role: "使" }],
    decoction: { doseCount: "5剂", dosesPerDay: 1, administrationTimesPerDay: 2 },
    formulaAnalysis: "黄连清热，甘草调和。",
  },
  patentAndWestern: [], modifications: [], nonPharma: { precautions: ["每日观察症状变化。"] },
};
const repaired = structuredClone(rejected);
repaired.candidate.herbs[0].dose = "5g";
repaired.candidate.herbs[1].dose = "9g";
repaired.candidate.herbs[1].role = "臣";
repaired.candidate.decoction.doseCount = "7剂";
const reason = "m04_candidate_0_herb_0_dose_outside_conservative_range";
const stabilize = (left, right, code = reason) => stabilizeM04DoseOnlyRepair(JSON.stringify(left), JSON.stringify(right), code);

for (const [leftLegacy, rightLegacy] of [[false, false], [true, false], [false, true], [true, true]]) {
  test(`dose-only repair preserves all siblings for legacy=${leftLegacy}/${rightLegacy}`, () => {
    const left = { ...rejected, ...(leftLegacy ? { schemaVersion: version } : {}) };
    const right = { ...repaired, ...(rightLegacy ? { schemaVersion: version } : {}) };
    const expected = structuredClone(left);
    expected.candidate.herbs[0].dose = "5g";
    for (const code of [reason, "m04_candidate_0_herb_0_dose_sanity_ceiling"]) {
      const result = stabilize(left, right, code);
      assert.ok(result, "compact proposal must not silently skip dose stabilization");
      assert.deepEqual(JSON.parse(result), expected);
    }
  });
}

test("unknown versions and full reasoning envelopes cannot enter dose-only stabilization", () => {
  for (const patch of [
    { schemaVersion: "future-proposal-v9" }, { schemaVersion: null },
    { schemaVersion: "tcm-cdss-reasoning-v2" },
    { stage: "prescribe", formula: { candidates: [] } },
    { overview: { primarySyndrome: "不属于提案的诊断" } },
  ]) {
    assert.equal(stabilize({ ...rejected, ...patch }, repaired), undefined);
    assert.equal(stabilize(rejected, { ...repaired, ...patch }), undefined);
  }
});

test("missing or ambiguous target and non-dose repairs preserve existing fallback behavior", () => {
  for (const herbs of [[], [{ name: "白术", dose: "5g" }], [{ name: "黄连", dose: "5g" }, { name: "黄连", dose: "6g" }]]) {
    assert.equal(stabilize(rejected, { ...repaired, candidate: { ...repaired.candidate, herbs } }), undefined);
  }
  assert.equal(stabilize(rejected, repaired, "m04_patient_context_semantic_review"), undefined);
});

test("repair prompts respect server-owned version, therapyMatch and acupoint fields", () => {
  const source = readFileSync(new URL("../src/lib/diagnosis-api.ts", import.meta.url), "utf8");
  const proposalHint = source.slice(source.indexOf("const proposalRepairHint ="), source.indexOf("const repairFieldRule ="));
  assert.equal(proposalHint.includes("schemaVersion=tcm-cdss-m04-proposal-v1"), false);
  assert.equal(proposalHint.includes("acupointCare 固定为 null"), false);
  assert.match(proposalHint, /不要输出 schemaVersion/);
  assert.match(proposalHint, /nonPharma\.acupointCare/);
  for (const code of ["name", "therapy_match", "therapy_unaligned", "herbs_empty"]) {
    const hint = buildM04ClinicalRepairHint(`m04_candidate_0_${code}`);
    assert.equal(hint.includes("candidate.therapyMatch（本方如何落实"), false);
    assert.match(hint, /therapyMatch 由服务端/);
  }
});

// ── 2026-09-20 定向修复：只重写 candidate ───────────────────────────────────────────────
test("candidate-patch eligibility: every observed production trigger is candidate-scoped", () => {
  for (const code of [
    "m04_formula_reference_declassified",
    "m04_formula_compilation_composition_drift",
    "m04_candidate_0_herb_1_dose_outside_conservative_range",
    "m04_candidate_0_herb_5_unknown",
    "m04_candidate_0_transparent_therapy_herb_7_unsupported_high_impact_heat_clear",
    "m04_candidate_0_high_risk_pair_incompatibility",
    "m04_candidates_empty",
  ]) assert.equal(m04CandidatePatchEligible(code), true, code);
});
test("candidate-patch eligibility: non-candidate reasons and non-candidate T1 batch items force full regeneration", () => {
  for (const code of ["json_invalid", "m04_proposal_candidate_missing", "m04_modification_0_missing_herb", "", "structured_resolver_rejected"]) {
    assert.equal(m04CandidatePatchEligible(code), false, code || "(empty)");
  }
  const primary = "m04_candidate_0_herb_1_dose_outside_conservative_range";
  assert.equal(m04CandidatePatchEligible(primary, ["candidate_0_herb_3_function_ungrounded", "non_pharma_diet_not_actionable"]), true,
    "T2/T3 findings outside candidate are annotate-only and do not force a full rewrite");
  assert.equal(m04CandidatePatchEligible(primary, ["modification_0_unknown_herb"]), false,
    "a T1 finding outside candidate must still be repaired, so the whole proposal is rewritten");
});
test("candidate-patch base accepts only a minimal proposal that carries a candidate object", () => {
  assert.ok(m04CandidatePatchBase(JSON.stringify(rejected)));
  assert.ok(m04CandidatePatchBase(JSON.stringify({ ...rejected, schemaVersion: version })));
  for (const raw of ["not json", JSON.stringify({ stage: "prescribe", formula: { candidates: [] } }), JSON.stringify({ ...rejected, candidate: null })]) {
    assert.equal(m04CandidatePatchBase(raw), undefined, raw.slice(0, 40));
  }
});
test("splicing keeps every non-candidate section byte-identical and ignores provider output outside candidate", () => {
  const base = m04CandidatePatchBase(JSON.stringify({ ...rejected, patentAndWestern: [{ keep: "中成药条目" }], nonPharma: { diet: "原饮食建议" } }));
  const spliced = JSON.parse(spliceM04CandidatePatch(base, JSON.stringify({
    candidate: repaired.candidate, nonPharma: { diet: "越权改写" }, patentAndWestern: [],
  })));
  assert.deepEqual(spliced.candidate, repaired.candidate);
  assert.deepEqual(spliced.patentAndWestern, [{ keep: "中成药条目" }]);
  assert.deepEqual(spliced.nonPharma, { diet: "原饮食建议" });
  assert.deepEqual(spliced.modifications, rejected.modifications);
  for (const patch of ["not json", JSON.stringify({}), JSON.stringify({ candidate: { ...repaired.candidate, herbs: [] } })]) {
    assert.equal(spliceM04CandidatePatch(base, patch), undefined, "a patch without herbs is not a repair");
  }
});
test("the candidate-patch provider schema is exactly the proposal's candidate subtree", () => {
  const full = responseFormatForTask("qwen3.8-max", "m04_proposal").json_schema.schema;
  const patch = responseFormatForTask("qwen3.8-max", "m04_candidate_patch").json_schema.schema;
  assert.deepEqual(Object.keys(patch.properties), ["candidate"]);
  assert.deepEqual(patch.required, ["candidate"]);
  const def = (schema) => schema.$defs[schema.properties.candidate.$ref.split("/").pop()];
  assert.deepEqual(def(patch), def(full));
});
