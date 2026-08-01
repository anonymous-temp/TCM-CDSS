/**
 * Invariant: a stage that returned HTTP 200 but produced no usable clinical result must never be
 * classified as a success.
 *
 * Why this test exists. The failure it guards is invisible at the transport layer. A recorded
 * end-to-end run in which M04 emitted the deterministic non-dose contract — no herbs, no doses, a
 * refusal page for the doctor — was scored `ok: true`, and the two stages it blocked (M05 and the
 * post-prescription rx-audit) were scored `ok: true` as well, because they were "skipped" rather
 * than failed. Three green ticks, zero prescriptions. Any pass rate computed that way hides the
 * single most important failure mode of the product.
 *
 * These assertions pin the semantics in scripts/lib/stage-outcome.mjs so a future harness inherits
 * a correct definition instead of re-deriving `res.ok`.
 */
import assert from "node:assert/strict";
import {
  NON_DOSE_MARKER,
  START_MARKER,
  END_MARKER,
  classifyM03,
  classifyM04,
  downstreamReachable,
  extractStageReasoning,
  isSignedLimitedM03,
  summarizeOutcomes,
} from "./lib/stage-outcome.mjs";

const sentinel = (payload) => `${START_MARKER}\n${JSON.stringify(payload)}\n${END_MARKER}`;

const completeM03 = {
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "diagnose",
  overview: {
    primarySyndrome: "心脾两虚证",
    primarySyndromeResolution: "bounded",
    evidence: { source: "病例内推理" },
  },
  pathogenesis: { chain: [{ nodeId: "P1", pathogenesis: "脾虚气血生化不足" }] },
};

const signedLimitedM03 = {
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "diagnose",
  overview: {
    primarySyndrome: "",
    primarySyndromeResolution: "unresolved",
    evidence: { source: "服务端M03有限结果门禁" },
  },
  pathogenesis: { chain: [] },
};

const dosedM04 = {
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "prescribe",
  formula: { candidates: [{ name: "归脾汤加减", herbs: [{ name: "黄芪", dose: "15g", role: "君" }] }] },
};

const undosedM04 = {
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "prescribe",
  formula: { candidates: [{ name: "归脾汤加减", herbs: [{ name: "黄芪", dose: "待确认", role: "君" }] }] },
};

// ── M03 ──────────────────────────────────────────────────────────────────────
assert.equal(classifyM03(sentinel(completeM03)), "complete");
assert.equal(classifyM03(sentinel(signedLimitedM03)), "signed_limited",
  "unresolved syndrome + empty chain is a deterministic gate output, not a diagnosis");
assert.equal(classifyM03("模型服务暂时不可用"), "unparsable");
assert.equal(classifyM03(sentinel(completeM03), { transportOk: false }), "error");

// A limited payload keeps its classification even if the evidence stamp is missing — the
// unresolved+empty-chain shape is the substance, the stamp is only the label.
assert.equal(isSignedLimitedM03({ ...signedLimitedM03, overview: { primarySyndromeResolution: "unresolved", evidence: {} } }), true);
// ...but a resolved syndrome with a real chain is never limited, whatever the source says.
assert.equal(isSignedLimitedM03(completeM03), false);

// ── M04: the case that motivated this module ─────────────────────────────────
assert.equal(classifyM04(`${NON_DOSE_MARKER}\n## 当前结论\n当前尚不能形成：包含具体用量的候选处方`), "non_dose",
  "the non-dose contract is a refusal page — it is never a prescription");
assert.equal(classifyM04(sentinel(dosedM04)), "dose_level");
assert.equal(classifyM04(sentinel(undosedM04)), "non_dose",
  "a candidate whose herbs carry no numeric dose cannot be dispensed");
assert.equal(classifyM04(sentinel({ ...dosedM04, formula: { candidates: [] } })), "non_dose");
assert.equal(classifyM04(sentinel({ ...dosedM04, formula: null })), "non_dose");
assert.equal(classifyM04("正在生成本阶段临床推理，请稍候…"), "unparsable");

// ── downstream reachability ──────────────────────────────────────────────────
assert.equal(downstreamReachable("dose_level"), true);
assert.equal(downstreamReachable("non_dose"), false,
  "M05 and rx-audit skipped because M04 degraded are consequences of that failure, not successes");
assert.equal(downstreamReachable("unparsable"), false);
assert.equal(downstreamReachable("error"), false);

// ── the headline number must not be transport success ────────────────────────
const summary = summarizeOutcomes([
  { m03: "complete", m04: "dose_level" },
  { m03: "complete", m04: "non_dose" },
  { m03: "signed_limited", m04: "non_dose" },
  { m03: "complete", m04: "error" },
]);
assert.equal(summary.total, 4);
assert.equal(summary.m03.complete, 3);
assert.equal(summary.m03.signedLimited, 1);
assert.equal(summary.m04.doseLevel, 1);
assert.equal(summary.m04.nonDose, 2);
assert.equal(summary.clinicalSuccessRate, 0.25, "1 of 4 cases yielded a usable prescription");
assert.equal(summary.transportSuccessRate, 0.75);
assert.notEqual(summary.clinicalSuccessRate, summary.transportSuccessRate,
  "these must be reported as different numbers — conflating them is the bug this module prevents");

// extractStageReasoning must not accept a payload belonging to another stage.
assert.equal(extractStageReasoning(sentinel(dosedM04), "diagnose"), null);
assert.equal(extractStageReasoning("no sentinel here", "diagnose"), null);
assert.equal(extractStageReasoning(`${START_MARKER}\n{not json\n${END_MARKER}`, "diagnose"), null);

console.log(JSON.stringify({ suite: "stage-outcome", assertions: 24, failures: 0 }, null, 2));

// ─── 同一条确定性合同拒绝码只修一次 ──────────────────────────────────────────
// 既有的三处定点守卫都键在复核驱动的条件上（quarantineShape / reviewBasedRejection），
// 纯合同拒绝码不满足任何一条，于是那条路上没有定点检测：同一个码可在多个顺序重试阶段被反复注入。
// 实测一次 M03 里 m03_patient_fact_ungrounded_0_1_literal 连续出现 3 次（同节点同事实），
// M04 的 m04_formula_reference_declassified 连续 2 次，单例 M03 从 15s 涨到 2.4 分钟。
// 合同拒绝码的修复提示是 (阶段, 原因码) 的纯函数，同码必然同提示，再注入一次是重抽同一张彩票。
{
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../src/lib/diagnosis-api.ts", import.meta.url), "utf8");
  assert.match(source, /const contractRepairedReasons = new Map<string, number>\(\)/,
    "合同拒绝码账本必须存在——否则纯合同码的重试没有任何定点检测");
  assert.match(source, /CONTRACT_REPAIR_MAX_PER_REASON = 2/,
    "同码修复上限必须是 2：1 次会把随机性叙述缺陷（chain_incomplete）逼进安全有限页，无上限则回到无界重注入");
  assert.match(source, /isRepeatedContractRepair/, "重试门必须查询该账本");
  // 三处重试入口都要接上，漏一处就等于账本形同虚设。
  const gates = source.match(/isRepeatedContractRepair\(/g) || [];
  assert.ok(gates.length >= 3, `只有 ${gates.length} 处重试门接了定点检测，应覆盖全部合同驱动入口`);
  const notes = source.match(/noteContractRepair\(/g) || [];
  assert.ok(notes.length >= 3, `只有 ${notes.length} 处记录了已修原因码，记录与查询必须成对`);
  // 复核驱动的拒绝码不进账本：同一个宽泛码带不同子型仍算新信息，这条既有语义不得被改掉。
  assert.match(source, /!reviewDriven/, "复核驱动的拒绝码必须排除在账本之外");
  // 提前收敛不得绕过 T1 硬门：终态出口仍须重跑安全合同再决定受理或降级。
  assert.match(source, /m03SafetyContractIssue\(/, "M03 终态出口必须仍执行 T1 硬门");
  // M04 的 T1 硬门在处方路由的终态受理处，不在流式层。
  const prescribeRoute = readFileSync(new URL("../src/app/api/diagnosis/prescribe/route.ts", import.meta.url), "utf8");
  assert.match(prescribeRoute, /m04SafetyContractIssue\(/, "M04 终态出口必须仍执行 T1 硬门");
}

// 复核标志必须按阶段取：M04 的合同拒绝码不得用 M03 的复核标志判定。
// 传错会让 M04 的合同码被当成「复核驱动」而绕过账本——实测一次 prescribe 里
// m04_formula_reference_declassified 仍连注两轮，最后靠 M04 自己那道守卫才收住。
{
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../src/lib/diagnosis-api.ts", import.meta.url), "utf8");
  assert.match(source, /targetedReviewDriven[\s\S]{0,200}retriedM04ClinicalReviewRejected/,
    "定向重试门必须按阶段选择复核标志（prescribe 用 M04 的）");
  assert.doesNotMatch(source, /isRepeatedContractRepair\(retryRejectionReason, retriedDiagnosticReviewRejected\)/,
    "不得再对 M04 使用 M03 的复核标志");
}
