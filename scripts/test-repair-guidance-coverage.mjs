/**
 * Invariant: every rejection code the M03/M04 contract can emit must tell the model what to change.
 *
 * Why this test exists. A rejection with no repair guidance is not a repair round — the model
 * receives a bare token like `m03_primary_syndrome_resolved_without_basis`, cannot act on it, and
 * simply resamples. It then fails the same check again until the orchestration deadline degrades a
 * clinically usable result into a signed-limited fallback the doctor cannot use. Measured in
 * production, that path was the dominant cause of M03 degradation.
 *
 * The structural point: adding a gate must cost the same as explaining the gate. Without this test
 * a new `return "some_new_code"` is one line, while the guidance that makes it repairable is
 * optional and therefore skipped. This test removes that asymmetry.
 *
 * KNOWN_UNGUIDED below is a debt register, not a config knob. Entries may be REMOVED as guidance is
 * written. Adding an entry is how this invariant dies — write the guidance instead.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { structuredClinicalRepairHint } from "../src/lib/structured-clinical-repair.ts";

const CONTRACT_SOURCE = readFileSync(new URL("../src/lib/diagnosis-stage-contract.ts", import.meta.url), "utf8");

/** Literal `return "code"` reason codes the contract can emit. */
function literalReasonCodes() {
  return [...new Set([...CONTRACT_SOURCE.matchAll(/return "([a-z][a-z0-9_]+)"/g)].map((m) => m[1]))]
    // `stage` / `unrecognized` are structural resolver states, not clinical rejections the model repairs.
    .filter((code) => code !== "stage" && code !== "unrecognized")
    .sort();
}

/**
 * Codes that still lack targeted guidance. Each one is a known repair round that degrades into a
 * resample. Shrink this list; never grow it.
 */
const KNOWN_UNGUIDED = new Set([
  "candidate_count",
  "candidates_empty",
  "dose_level_content",
  "formula_direction_drift",
  "formula_not_null",
  "formula_reference_contract_missing",
  "formula_reference_display_mismatch",
  "formula_reference_missing",
  "neutral_tongue_only",
  "non_pharma_incomplete",
  "non_pharma_treatment_count",
  "sub_therapy_primary_missing",
  "tcm_reasoning_diagnostic_dependency",
  "therapy_principle_invalid",
  "therapy_principle_method_duplicate",
  "transparent_therapy_contract_missing",
  "transparent_therapy_coverage",
  "transparent_therapy_herb_knowledge_missing",
  "transparent_therapy_herb_support",
  "transparent_therapy_herbs_missing",
  "transparent_therapy_unresolved",
  "treatment_principle_target_mismatch",
  "visible_extra_herb_rows",
  "western_differential_duplicate",
  "western_primary_tcm_pollution",
]);

const codes = literalReasonCodes();
assert.ok(codes.length > 60, `expected the contract to expose many reason codes, saw ${codes.length}`);

const guided = [];
const unguided = [];
for (const code of codes) {
  // M03 codes are emitted as `m03_<code>`; the same predicate set is reachable for prescribe.
  const hint = structuredClinicalRepairHint("diagnose", `m03_${code}`).trim();
  (hint.length > 0 ? guided : unguided).push(code);
}

const regressions = unguided.filter((code) => !KNOWN_UNGUIDED.has(code));
assert.deepEqual(
  regressions,
  [],
  `新增的拒绝代码没有配套修复指导，模型收到裸代码只会重采样而不是修复：\n  ${regressions.join("\n  ")}\n` +
    "请在 src/lib/diagnosis-api.ts structuredClinicalRepairHint 中补充针对性指导，而不是把代码加入 KNOWN_UNGUIDED。",
);

// The debt register must stay honest: an entry that has since gained guidance has to be removed,
// otherwise the list silently stops reflecting reality and the ratchet stops tightening.
const staleDebt = [...KNOWN_UNGUIDED].filter((code) => guided.includes(code));
assert.deepEqual(
  staleDebt,
  [],
  `以下代码已经有修复指导，请从 KNOWN_UNGUIDED 中删除：\n  ${staleDebt.join("\n  ")}`,
);

const obsoleteDebt = [...KNOWN_UNGUIDED].filter((code) => !codes.includes(code));
assert.deepEqual(
  obsoleteDebt,
  [],
  `以下代码合同里已不存在，请从 KNOWN_UNGUIDED 中删除：\n  ${obsoleteDebt.join("\n  ")}`,
);

// Guidance must be actionable prose, not the reason code echoed back at the model.
for (const code of guided) {
  const hint = structuredClinicalRepairHint("diagnose", `m03_${code}`);
  assert.ok(hint.length >= 40, `${code} 的修复指导过短，无法指导模型定位要改的字段`);
  assert.ok(!/^m0[34]_/.test(hint.trim()), `${code} 的修复指导不能只是回显原因代码`);
}

console.log(JSON.stringify({
  reasonCodes: codes.length,
  guided: guided.length,
  knownUnguided: unguided.length,
  coveragePct: Math.round((guided.length / codes.length) * 100),
  failures: 0,
}, null, 2));
