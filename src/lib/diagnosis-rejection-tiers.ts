/**
 * 阶段合同拒绝原因的分级表（M03）。
 *
 * 分级语义：
 *   T1 安全/结论承重 —— 行为完全不变：拒绝 → 修复 → 仍不通过则 fail-closed 到受限合同。
 *   T2 结论成立，但支撑叙述或鉴别说明不完整。
 *   T3 结论与叙述均成立，仅措辞/重复/模板层面瑕疵。
 *
 * 默认拒绝（default-deny）：只有出现在下面两个白名单里的原因码才会被判为 T2/T3，其余一律 T1。
 * 未来新增的检查、独立复核器的 *_semantic_review、传输类失败（json_invalid / sentinel_count_* /
 * schema_invalid_* / trailing_content / stage_* / resolver_rejected / finish_*）以及全部 m04_*
 * 自动保持今天的 fail-closed 行为。
 *
 * ★ 本表的唯一准入范围（不要扩大）★
 * 只有【在 m03SemanticIssue 函数体内直接 return 的单点检查】才可以进入本表。
 * 凡是由多码辅助函数产出的原因码一律不得进入，因为那些函数命中第一个问题就短路返回：
 * 把它们的返回值按分级过滤掉，等于跳过排在它后面、根本没有执行的 T1 检查。
 * 具体禁止来源（已核对）：
 *   m03WesternSupportIssue                  —— 内含 western_support_polarity_mismatch(T1)
 *   m03ResolutionContractIssue              —— 内含 *_resolved_without_basis / *_basis_ungrounded(T1)
 *   m03SevenStageInferenceIssue             —— 内含 nature_dimension_insufficient(T1)
 *   m03PathogenesisAndTherapyStructureIssue —— 内含 sub_therapies_missing / sub_therapy_incomplete(T1)
 *   m03PathogenesisSummaryConsistencyIssue / m03UncertaintyStateIssue / ungroundedPatientFactReason
 * 唯一例外是 m03WesternClinicalRationaleIssue：它的返回类型已在源码中收敛为两个非 T1 码，
 * 因此过滤它不可能跳过任何 T1 检查。新增例外必须先证明该函数的全部产出码都不是 T1。
 *
 * 本表只做分级，不做任何临床判断。带批注受理的实际门禁是 diagnosis-stage-contract.ts 的
 * m03SafetyContractIssue。
 */

export type RejectionTier = "T1" | "T2" | "T3";

/** T2 —— 结论本身成立且有依据，缺的是把依据讲清楚的那段文字。 */
const T2_M03: ReadonlySet<string> = new Set([
  "western_primary_tcm_pollution",
  "western_clinical_rationale_missing",
  "western_differential_analysis_missing",
  "tcm_diagnostic_rationale_missing",
  "tcm_reasoning_diagnostic_dependency",
  "tcm_differential_analysis_missing",
  "discrimination_missing",
  "location_classification_missing",
  "chain_incomplete",
]);

/** T3 —— 结论与叙述都成立，问题只在措辞、重复、模板残留。 */
const T3_M03: ReadonlySet<string> = new Set([
  "western_clinical_rationale_restatement",
  "tcm_diagnostic_rationale_restatement",
  "western_differential_duplicate",
  "therapy_principle_method_duplicate",
  "generic_tcm_template",
  "explanation_placeholder",
  "nature_item_is_mechanism",
]);

/**
 * 分级查询。同时接受带阶段前缀形式（m03_xxx / m04_xxx）与裸原因码（xxx）。
 * 未分类 → T1。这是安全默认值，不要改成 T2。
 */
export function rejectionTier(reason: string): RejectionTier {
  const code = typeof reason === "string" ? reason.trim() : "";
  if (!code) return "T1";
  // 处方阶段硬门：M04 输出含剂量级内容，且不存在与 m03SafetyContractIssue 等价的 T1 复核门。
  if (code.startsWith("m04_")) return "T1";
  const bare = code.startsWith("m03_") ? code.slice(4) : code;
  if (T2_M03.has(bare)) return "T2";
  if (T3_M03.has(bare)) return "T3";
  return "T1";
}

/** 谓词形式，供 m03SafetyContractIssue 注入（保持 diagnosis-stage-contract.ts 不反向依赖本模块）。 */
export function isSafetyRejection(reason: string): boolean {
  return rejectionTier(reason) === "T1";
}

/** 可带批注受理时返回批注档位；T1 返回 undefined。 */
export function qualityAnnotationTier(reason: string): "T2" | "T3" | undefined {
  const tier = rejectionTier(reason);
  return tier === "T1" ? undefined : tier;
}

/**
 * 医生可见的质量批注（M03-06：临床语言，不得出现原因代码或工程术语）。
 *
 * 受理的含义是「结论本身成立、可用，但某一处说明不够完整」，因此批注必须让医生知道
 * 该复核哪一层，而不是把内部原因码翻译一遍。
 */
export function qualityAnnotationCopy(reason: string): string | undefined {
  const tier = qualityAnnotationTier(reason);
  if (!tier) return undefined;
  return tier === "T2"
    ? "本次辨证结论已形成并通过安全核验；其中部分支撑说明或鉴别分析仍不够完整，请医生结合病历复核后使用。"
    : "本次辨证结论已形成并通过安全核验；个别表述存在重复或不够精炼，不影响结论本身，请医生按需调整。";
}

/**
 * 「带批注受理」的最终判定。
 *
 * 三个条件必须同时成立，缺一即维持今天的 fail-closed 行为：
 *  1. 拒绝原因是 T2/T3——T1 永远不受理（default-deny，未知码一律 T1）。
 *  2. safetyIssue 为 undefined——调用方必须传入 m03SafetyContractIssue 的完整结果。
 *     这一条不能省：m03SemanticIssue 命中第一个问题就短路返回，拿到一个 T3 码只证明
 *     排在它前面的检查通过了，后面的 T1 检查根本没执行，必须完整重跑 T1 子集。
 *  3. 草稿足够完整——受理一份空壳对医生毫无价值，只会把「无结论」包装成「有结论」。
 *
 * safetyIssue 缺省为 "safety_gate_not_evaluated"：漏传即判定为不可受理，fail-closed。
 */
export function shouldAcceptWithQualityAnnotation(input: {
  rejectionReason: string;
  safetyIssue?: string;
  visibleDraftLength: number;
  minimumDraftLength?: number;
}): boolean {
  const safetyIssue = input.safetyIssue === undefined ? "safety_gate_not_evaluated" : input.safetyIssue;
  if (safetyIssue) return false;
  if (!qualityAnnotationTier(input.rejectionReason)) return false;
  return input.visibleDraftLength >= (input.minimumDraftLength ?? 80);
}
