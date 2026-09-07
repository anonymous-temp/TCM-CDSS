import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { stabilizeM04DoseOnlyRepair, buildM04ClinicalRepairHint } = await jiti.import("../src/lib/structured-clinical-repair.ts");
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
