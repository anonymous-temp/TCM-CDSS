/**
 * Invariant for the Tier-2「带批注受理」machinery.
 *
 * The machinery lets a NON-safety M03 rejection be accepted with a quality annotation instead of
 * burning repair rounds until the orchestration deadline degrades a clinically usable result. The
 * whole design rests on one property: no matter how permissive the tier predicate is, a T1 safety
 * violation must still block acceptance.
 *
 * m03SemanticIssue returns the first strict quality finding. m03SafetyContractIssue is deliberately
 * independent from that short-circuit and directly re-checks structure, dose leakage, chart
 * grounding/polarity, current positive evidence and the follow-up safety net.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@": `${process.cwd()}/src`,
    "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
  },
});

const { rejectionTier, isSafetyRejection, qualityAnnotationTier, qualityAnnotationCopy, shouldAcceptWithQualityAnnotation } = await jiti.import("../src/lib/diagnosis-rejection-tiers.ts");
const { m03SafetyContractIssue } = await jiti.import("../src/lib/diagnosis-stage-contract.ts");

// 1. Default-deny: anything not explicitly listed is T1, including future/unknown codes, transport
//    failures and every m04_* code.
for (const unknown of [
  "totally_new_check_added_next_week",
  "json_invalid",
  "sentinel_count_0_0",
  "schema_invalid_overview",
  "trailing_content",
  "resolver_rejected",
  "finish_length",
  "m04_candidate_0_herb_1_dose",
]) {
  assert.equal(rejectionTier(unknown), "T1", `${unknown} 必须默认按 T1 处理（default-deny）`);
  assert.equal(isSafetyRejection(unknown), true, `${unknown} 必须被视为安全承重`);
  assert.equal(qualityAnnotationTier(unknown), undefined, `${unknown} 不得获得质量批注受理`);
}

// 2. Evidence-list and resolution-depth findings are quality issues. They downgrade the affected
//    block instead of erasing the grounded TCM chain.
for (const qualityOnly of [
  "western_support_demographic_padding",
  "western_support_nondiscriminating",
  "western_support_tcm_pollution",
  "western_support_polarity_mismatch",
  "primary_syndrome_resolved_without_basis",
  "nature_dimension_insufficient",
  "m03_primary_diagnosis_semantic_review",
  "m03_tcm_reasoning_semantic_review",
  "m03_formula_indication_semantic_review",
]) {
  assert.equal(
    rejectionTier(qualityOnly),
    "T2",
    `${qualityOnly} 应局部降级而不是清空整份 M03`,
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

const groundedBase = {
  stage: "diagnose",
  formula: null,
  overview: {
    primarySyndrome: "风寒袭肺证",
    primarySyndromeBasis: ["咳嗽3天"],
    overallPathogenesis: "风寒外束，肺失宣降",
  },
  pathogenesis: {
    chain: [{
      patientFact: "意识异常",
      syndromeEvidence: "咳嗽3天",
      pathogenesis: "风寒外束，肺失宣降",
      therapyDirection: "疏风散寒，宣肺止咳",
    }],
  },
  therapy: { overallMethod: "疏风散寒，宣肺止咳" },
  management: { followupSafetyNet: "若出现呼吸困难、意识异常或高热持续，应立即急诊评估。" },
};
assert.match(
  m03SafetyContractIssue(
    groundedBase,
    "咳嗽3天；无胸痛、咯血、明显呼吸困难、意识异常",
    alwaysNonSafety,
  ),
  /^patient_fact_ungrounded_0_0_polarity$/,
  "质量分级不得放过病机链把病历否定事实反写为阳性的错误",
);

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
  defaultDenyChecked: 8,
  qualityDowngradeChecked: 9,
  t1HoldsUnderPermissivePredicate: t1Cases.length,
  annotatableSampled: annotatable.length,
  failures: 0,
}, null, 2));

// 7. 受理判定：三个条件缺一不可，任何一条不满足都必须维持今天的 fail-closed。
const okInput = { rejectionReason: "western_differential_duplicate", safetyIssue: undefined, visibleDraftLength: 200 };
assert.equal(shouldAcceptWithQualityAnnotation({ ...okInput, safetyIssue: "" }), true, "T3 + 无 T1 问题 + 草稿完整 → 受理");
// safetyIssue 漏传 = fail-closed（缺省为 safety_gate_not_evaluated）
assert.equal(shouldAcceptWithQualityAnnotation(okInput), false, "漏传 safetyIssue 必须判为不可受理");
// T1 码永不受理，哪怕 T1 门禁恰好没报问题
for (const t1 of ["chain_empty", "tcm_syndrome_current_fact_missing", "m04_candidate_0_herb_1_dose", "未来新增的码"]) {
  assert.equal(
    shouldAcceptWithQualityAnnotation({ rejectionReason: t1, safetyIssue: "", visibleDraftLength: 500 }),
    false,
    `${t1} 属 T1，任何情况下都不得带批注受理`,
  );
}
// T1 门禁报了问题 → 即使拒绝码是 T3 也不受理（短路陷阱的兜底）
assert.equal(
  shouldAcceptWithQualityAnnotation({ rejectionReason: "western_differential_duplicate", safetyIssue: "chain_empty", visibleDraftLength: 500 }),
  false,
  "T1 门禁报出问题时，T3 拒绝码也不得受理",
);
// 空壳草稿不受理
assert.equal(
  shouldAcceptWithQualityAnnotation({ rejectionReason: "western_differential_duplicate", safetyIssue: "", visibleDraftLength: 10 }),
  false,
  "草稿过短不得受理——那是把「无结论」包装成「有结论」",
);
// 批注必须是临床语言，不得泄露原因码或工程术语
for (const reason of ["chain_incomplete", "western_differential_duplicate"]) {
  const copy = qualityAnnotationCopy(reason);
  if (!copy) continue;
  assert.doesNotMatch(copy, /m0[34]_|[a-z]{4,}_[a-z]{4,}/, `批注不得包含原因代码：${copy}`);
  assert.doesNotMatch(copy, /合同|契约|门禁|校验器|降级|兜底|sentinel|schema/, `批注不得包含工程术语：${copy}`);
  assert.ok(copy.length >= 20, "批注必须说明医生该做什么");
}
assert.equal(qualityAnnotationCopy("chain_empty"), undefined, "T1 没有批注文案");

// 6. 随访监测词表曾经要求「单一事实来源」：编译层丢弃畸形行、合同层校验幸存行，两者各持一份
//    字面量就会互相打架。该字段(nonPharma.monitoring 的 metric/timing/trigger 三元组)连同它的
//    5 个驳回码已被自由文本 precautions 取代，两层都不再持有这份词表——重复风险随之消失。
//
//    换成锁住取代它的那个设计决策：precautions 是零驳回码字段。校验只在编译层以 zod 约束形状、
//    畸形条目逐条丢弃，合同层一个驳回码都不得有。这是「非承重字段不得拥有整份输出的一票否决权」
//    这条原则在本字段上的落点；日后若有人在合同层给它加驳回码，这条断言会立刻失败。
const contractSource = readFileSync(new URL("../src/lib/diagnosis-stage-contract.ts", import.meta.url), "utf8");
const compilerSource = readFileSync(new URL("../src/lib/m04-proposal-compiler.ts", import.meta.url), "utf8");
const monitoringLiteral = /\/\(\?:若\|如\|一旦\|当\|出现/g;
assert.equal(
  (contractSource.match(monitoringLiteral) || []).length,
  0,
  "随访监测三元组词表已随该字段一并移除，合同层不得再持有",
);
assert.equal(
  (compilerSource.match(monitoringLiteral) || []).length,
  0,
  "m04-proposal-compiler 不得再复制随访监测词表字面量",
);
assert.equal(
  (contractSource.match(/precautions_[a-z0-9_]+/g) || []).length,
  0,
  "precautions 必须保持零驳回码：合同层不得为注意事项引入任何 precautions_* 驳回码",
);
assert.match(
  compilerSource,
  /precautions:\s*z\.array\(/,
  "注意事项的形状约束必须留在编译层的 zod schema 上（畸形条目丢弃，而非驳回整份 M04）",
);
// MONITORING_ACTION_OR_CONDITION 曾是两层共享的词表常量，随监测三元组一并移除。
// 取代它的 precautions 清洗规则只存在于编译层（长度/剂量样式/占位语/去重），合同层不持有副本，
// 因此不再需要跨层导入约束——上面两条词表 length===0 断言已经保证两层都不会重新各持一份。
// 合同层保留了一段说明该字段为何被删除的墓碑注释，其中提到这个常量名；那是文档不是实现，
// 不做「标识符不得出现」这类断言，否则会把有价值的删除理由一并逼走。

// ─── 策略层观察不得拥有作废整份诊断的权力 ──────────────────────────────────────
// formula_selection_missed_lockable 的语义是「受控目录里存在可锁定的命名方，而模型把方名留空了」。
// m03SemanticIssue 里这条检查自己的注释写着「漏锁不由服务端代选——选方是临床决策」；既然服务端
// 不代选，它就不该是 T1。此前它落在默认 T1，与 chain_empty 同级：模型不肯命名经典方 ⇒ 反复注入
// 修复提示 ⇒ 耗尽 M03 编排时限 ⇒ 降级成安全有限合同，医生连证候和病机都拿不到。
//
// 这个错分级长期没暴露，是因为复合证候归一失效时可锁定候选恒为空、该检查几乎从不触发。
// 主证段归一修好后它立刻成为高频码，一例胸痹病例的病机节点数从 2 掉到 0。
assert.equal(
  rejectionTier("m03_formula_selection_missed_lockable"), "T3",
  "「漏锁可锁定命名方」是策略观察，必须带批注受理而不是作废整份 M03",
);
// 与它相邻的**结构性**缺陷仍须是 T1，否则这次降级就越界了。
for (const code of ["m03_chain_empty", "m03_primary_syndrome_unstable", "m03_stage"]) {
  assert.equal(rejectionTier(code), "T1", `${code} 是结构性缺陷，必须保持 T1`);
}
// 分级只决定「要不要重跑」，不决定「安不安全」：T1 硬门 m03SafetyContractIssue 独立执行，
// 带批注受理仍以它为准（见本文件顶部说明），这里确认降级没有把该码塞进硬门。
{
  const { m03SafetyContractIssue } = await import("../src/lib/diagnosis-stage-contract.ts");
  const grounded = {
    stage: "diagnose",
    overview: { primarySyndrome: "心脾两虚证", overallPathogenesis: "心脾两虚，心神失养", recommendedFormulaNames: [] },
    pathogenesis: { chain: [{ nodeId: "P1", patientFact: "入睡困难", syndromeEvidence: "舌淡苔薄白", pathogenesis: "心脾两虚", therapyDirection: "补益心脾" }] },
    therapy: { overallPrinciple: "补益心脾", overallMethod: "补益心脾，养血安神" },
    management: { followupSafetyNet: "若出现胸痛、晕厥或症状明显加重，应立即就医。" },
    formula: null,
  };
  assert.notEqual(
    m03SafetyContractIssue(grounded, ""), "formula_selection_missed_lockable",
    "T1 硬门不得包含策略层的漏锁码——否则降级为 T3 等于没做",
  );
}
