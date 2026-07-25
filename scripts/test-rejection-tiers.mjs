/**
 * Invariant for the Tier-2「带批注受理」machinery.
 *
 * The machinery lets a NON-safety M03 rejection be accepted with a quality annotation instead of
 * burning repair rounds until the orchestration deadline degrades a clinically usable result. The
 * whole design rests on one property: no matter how permissive the tier predicate is, a T1 safety
 * violation must still block acceptance.
 *
 * The subtle failure this guards against is short-circuiting. m03SemanticIssue returns the FIRST
 * problem it finds, so a T3 code only proves the checks ahead of it passed — the T1 checks after it
 * never ran. m03SafetyContractIssue therefore re-runs the T1 subset in full, and multi-code helper
 * functions (m03WesternSupportIssue, m03ResolutionContractIssue, …) are treated as absolute vetoes
 * rather than being tier-filtered, because filtering their output would skip the T1 checks that sit
 * behind the first hit inside them.
 */
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@": `${process.cwd()}/src`,
    "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
  },
});

const { rejectionTier, isSafetyRejection, qualityAnnotationTier } = await jiti.import("../src/lib/diagnosis-rejection-tiers.ts");
const { m03SafetyContractIssue } = await jiti.import("../src/lib/diagnosis-stage-contract.ts");

// 1. Default-deny: anything not explicitly listed is T1, including future/unknown codes, transport
//    failures, independent-review codes and every m04_* code.
for (const unknown of [
  "totally_new_check_added_next_week",
  "json_invalid",
  "sentinel_count_0_0",
  "schema_invalid_overview",
  "trailing_content",
  "resolver_rejected",
  "finish_length",
  "m03_tcm_reasoning_semantic_review",
  "m04_candidate_0_herb_1_dose",
]) {
  assert.equal(rejectionTier(unknown), "T1", `${unknown} 必须默认按 T1 处理（default-deny）`);
  assert.equal(isSafetyRejection(unknown), true, `${unknown} 必须被视为安全承重`);
  assert.equal(qualityAnnotationTier(unknown), undefined, `${unknown} 不得获得质量批注受理`);
}

// 2. Codes emitted by short-circuiting multi-code helpers must NOT be tier-downgraded, or the T1
//    checks sitting behind them inside those helpers would never execute.
for (const shortCircuited of [
  "western_support_demographic_padding",
  "western_support_nondiscriminating",
  "western_support_tcm_pollution",
  "location_unresolved_with_items",
  "nature_unresolved_with_items",
]) {
  assert.equal(
    rejectionTier(shortCircuited),
    "T1",
    `${shortCircuited} 由短路多码辅助函数产出，按分级放行会跳过它后面未执行的 T1 检查`,
  );
}

// 3. The T1 gate must hold even when the tier predicate is maximally permissive — i.e. when every
//    reason is claimed to be non-safety. This is the property the whole accept path depends on.
const alwaysNonSafety = () => false;
const t1Cases = [
  ["stage", { stage: "prescribe" }],
  ["formula_not_null", { stage: "diagnose", formula: { candidates: [] }, pathogenesis: { chain: [{}] } }],
  ["chain_empty", { stage: "diagnose", pathogenesis: { chain: [] } }],
];
for (const [expected, reasoning] of t1Cases) {
  assert.equal(
    m03SafetyContractIssue(reasoning, "", alwaysNonSafety),
    expected,
    `即使分级谓词声称全部非安全，${expected} 仍必须阻断受理`,
  );
}

// 4. Missing predicate must degrade to absolute veto (fail-closed), never to permissive.
assert.equal(
  m03SafetyContractIssue({ stage: "diagnose", pathogenesis: { chain: [] } }, ""),
  "chain_empty",
  "未注入分级谓词时必须退化为绝对否决",
);
assert.equal(m03SafetyContractIssue(null, ""), "stage", "空 reasoning 必须被阻断");
assert.equal(m03SafetyContractIssue(undefined, ""), "stage", "undefined reasoning 必须被阻断");

// 5. Only genuinely non-safety codes may earn an annotation, and they must be single-point checks
//    returned directly from m03SemanticIssue.
const annotatable = ["western_differential_duplicate", "pathogenesis_nodes_duplicated"].filter(
  (reason) => rejectionTier(reason) !== "T1",
);
for (const reason of annotatable) {
  assert.ok(["T2", "T3"].includes(qualityAnnotationTier(reason)), `${reason} 应可获得质量批注`);
  assert.equal(isSafetyRejection(reason), false, `${reason} 不应被判为安全承重`);
}

console.log(JSON.stringify({
  defaultDenyChecked: 9,
  shortCircuitGuarded: 5,
  t1HoldsUnderPermissivePredicate: t1Cases.length,
  annotatableSampled: annotatable.length,
  failures: 0,
}, null, 2));
