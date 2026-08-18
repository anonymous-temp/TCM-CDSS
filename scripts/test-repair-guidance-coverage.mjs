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
 * Template-literal reason codes — `` return `candidate_${i}_herb_${j}_dose` ``.
 *
 * Why this half matters more than the literal half. M04 emits almost all of its codes this way,
 * so an extractor that only scanned `return "literal"` left this invariant近乎完全失效 on the
 * prescribe stage: measured 81 M04 codes, 19 guided (23%), 62 returning an empty hint. A model
 * that receives a bare token in a repair round cannot locate the defect — it can only resample,
 * until M04_ORCHESTRATION_DEADLINE_MS turns a clinically usable candidate into a non-dose contract
 * the doctor cannot use. That is the same failure this file's header describes for M03, relocated.
 *
 * Index variables are instantiated with concrete numbers. A template whose only remaining variable
 * IS the whole trailing segment (`candidate_${i}_${coverageIssue}`) is a pass-through of another
 * function's code, not a distinct code of its own, so it is skipped — the wrapped code is already
 * covered where it is produced.
 */
function templateReasonCodes() {
  const codes = new Set();
  for (const match of CONTRACT_SOURCE.matchAll(/return `([^`]+)`/g)) {
    const template = match[1];
    if (!/^[a-z]/.test(template)) continue;
    // 任何下标型变量都实例化成数字：*Index / index / i / j / n。写成模式而不是逐个列举，
    // 否则每新增一个下标名（chainIndex、factIndex 就是这么漏掉的）都会让该码悄悄退出覆盖。
    const indexed = template.replace(/\$\{\s*(?:[A-Za-z]*[Ii]ndex|[ijn])\s*\}/g, "0");
    // Literal word segments left after removing every remaining interpolation. Fewer than two
    // means the interpolation carries the identity of the code → pass-through, skip.
    const literalSegments = indexed.split(/\$\{[^}]*\}/).filter((part) => /[a-z]{3,}/.test(part));
    if (indexed.includes("${") && literalSegments.length < 2) continue;
    const instantiated = indexed.replace(/\$\{[^}]*\}/g, "sample");
    // A reason code is a bare snake_case token. Anything else is this regex having walked into a
    // nested interpolation (`${xs.map((x) => x).join("_")}`) rather than a real code.
    if (!/^[a-z][a-z0-9_]*$/.test(instantiated)) continue;
    codes.add(instantiated);
  }
  return [...codes].sort();
}

// Literal reasons emitted by M04 or its cross-stage helpers. Test them through the
// actual prescribe repair path instead of manufacturing an m03_ prefix.
const M04_REASON_CODES = new Set([
  "candidate_count",
  "candidates_empty",
  "formula_direction_drift",
  "formula_reference_contract_missing",
  "formula_reference_display_mismatch",
  "formula_reference_missing",
  "non_pharma_incomplete",
  "non_pharma_diet_not_actionable",
  "non_pharma_treatment_count",
  "transparent_therapy_contract_missing",
  "transparent_therapy_coverage",
  "transparent_therapy_herb_knowledge_missing",
  "transparent_therapy_herb_support",
  "transparent_therapy_herbs_missing",
  "transparent_therapy_unresolved",
  "visible_extra_herb_rows",
]);

function repairRouteForCode(code) {
  const prescribe = M04_REASON_CODES.has(code);
  const transparent = code.startsWith("transparent_therapy_");
  return {
    stage: prescribe ? "prescribe" : "diagnose",
    reason: prescribe
      ? `m04_${transparent ? "candidate_0_" : ""}${code}`
      : `m03_${code}`,
  };
}

/** Template codes route by prefix: these families are only ever produced by the prescribe stage. */
const M04_TEMPLATE_PREFIXES = [
  "candidate_",
  "candidates_",
  "herb_",
  "modification_",
  "non_pharma_",
  "visible_",
  "transparent_therapy_",
  "formula_component_",
];

function repairRouteForTemplateCode(code) {
  const prescribe = M04_TEMPLATE_PREFIXES.some((prefix) => code.startsWith(prefix));
  return { stage: prescribe ? "prescribe" : "diagnose", reason: `${prescribe ? "m04" : "m03"}_${code}` };
}

const codes = literalReasonCodes();
assert.ok(codes.length > 60, `expected the contract to expose many reason codes, saw ${codes.length}`);

const templateCodes = templateReasonCodes();
assert.ok(
  templateCodes.length > 30,
  `expected the contract to expose many template reason codes, saw ${templateCodes.length}`,
);

const guided = [];
const unguided = [];
for (const code of codes) {
  const route = repairRouteForCode(code);
  const hint = structuredClinicalRepairHint(route.stage, route.reason).trim();
  (hint.length > 0 ? guided : unguided).push(code);
}
for (const code of templateCodes) {
  const route = repairRouteForTemplateCode(code);
  const hint = structuredClinicalRepairHint(route.stage, route.reason).trim();
  (hint.length > 0 ? guided : unguided).push(code);
}

assert.deepEqual(
  unguided,
  [],
  `拒绝代码没有配套修复指导，模型收到裸代码只会重采样而不是修复：\n  ${unguided.join("\n  ")}\n` +
    "请在 structuredClinicalRepairHint 中补充真实阶段的针对性指导。",
);

// Guidance must be actionable prose, not the reason code echoed back at the model.
for (const code of guided) {
  const route = codes.includes(code) ? repairRouteForCode(code) : repairRouteForTemplateCode(code);
  const hint = structuredClinicalRepairHint(route.stage, route.reason);
  assert.ok(hint.length >= 40, `${code} 的修复指导过短，无法指导模型定位要改的字段`);
  assert.ok(!/^m0[34]_/.test(hint.trim()), `${code} 的修复指导不能只是回显原因代码`);
}

console.log(JSON.stringify({
  literalReasonCodes: codes.length,
  templateReasonCodes: templateCodes.length,
  guided: guided.length,
  knownUnguided: unguided.length,
  coveragePct: Math.round((guided.length / (codes.length + templateCodes.length)) * 100),
  failures: 0,
}, null, 2));
