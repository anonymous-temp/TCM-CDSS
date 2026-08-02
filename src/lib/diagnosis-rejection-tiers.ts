/**
 * 阶段合同拒绝原因的分级表（M03）。
 *
 * 分级语义：
 *   T1 安全/结论承重 —— 行为完全不变：拒绝 → 修复 → 仍不通过则 fail-closed 到受限合同。
 *   T2 结论成立，但支撑叙述或鉴别说明不完整。
 *   T3 结论与叙述均成立，仅措辞/重复/模板层面瑕疵。
 *
 * 默认拒绝（default-deny）：只有出现在下面的白名单／模式表里的原因码才会被判为 T2/T3，其余一律 T1。
 * 未来新增的检查、传输类失败（json_invalid / sentinel_count_* / schema_invalid_* /
 * trailing_content / stage_* / resolver_rejected / finish_*）自动保持今天的 fail-closed 行为。
 * M03 独立复核意见只影响建议置信度；候选仍须另行通过完整的确定性安全合同。
 *
 * M04 曾经被一行 `if (code.startsWith("m04_")) return "T1"` 整体钉死在最高危级别——理由是
 * 「不存在与 m03SafetyContractIssue 等价的 T1 复核门」。该硬门已补齐（m04SafetyContractIssue），
 * 因此 M04 改用下方的模式表分级，口径与 M03 对称。
 *
 * 本表只负责“严格文档合同”到“医生可见质量提示”的映射，不承担事实安全判断。
 * 带批注受理前必须另行完整执行 diagnosis-stage-contract.ts 的 m03SafetyContractIssue；
 * 后者直接检查结构、剂量越权、病历接地、极性和随访安全网，不依赖这里的短路顺序。
 */

export type RejectionTier = "T1" | "T2" | "T3";

/** T2 —— 结论本身成立且有依据，缺的是把依据讲清楚的那段文字。 */
const T2_M03: ReadonlySet<string> = new Set([
  // 西医块的证据呈现问题只能降级西医块，不能连带清空中医辨证。
  "western_support_empty",
  "western_support_tcm_pollution",
  "western_support_demographic_padding",
  "western_support_normal_vital_padding",
  "western_support_nondiscriminating",
  "western_support_historical_only",
  "western_support_polarity_mismatch",
  "western_primary_tcm_pollution",
  "western_primary_duration_mismatch",
  "western_diagnosis_unstable",
  "western_primary_ambiguous",
  "western_clinical_rationale_missing",
  "western_clinical_rationale_restatement",
  "western_differential_ambiguous",
  "western_differential_analysis_missing",
  "clinical_wording_intensity_mismatch",
  "clinical_wording_subjective_objective_mismatch",
  // 有结论但证据层级未达到 resolved 时，改成 bounded/unresolved，而不是整单作废。
  "primary_syndrome_resolved_without_basis",
  "primary_syndrome_basis_ungrounded",
  "primary_syndrome_basis_polarity",
  "primary_syndrome_resolution_reason_missing",
  "symptom_cluster_polarity",
  "chain_key_discriminator_missing",
  "location_resolved_without_basis",
  "location_resolved_basis_ungrounded",
  "location_resolution_reason_missing",
  "single_evidence_location",
  "nature_resolved_without_basis",
  "nature_resolved_basis_ungrounded",
  "nature_resolution_reason_missing",
  "nature_dimension_insufficient",
  "tcm_diagnostic_rationale_missing",
  // 需求3：辨病推理缺失。缺一段病名归属理由不影响辨证结论可用性，带批注受理即可。
  "tcm_disease_rationale_missing",
  "tcm_reasoning_diagnostic_dependency",
  "tcm_differential_analysis_missing",
  "discrimination_missing",
  "location_classification_missing",
  "nature_classification_empty",
  "chain_incomplete",
  // 随访安全网表述不完整是管理段的文档质量项：辨证结论与病机链不受影响，批注提示医生补充
  // 随访条件即可。此前未分级（T1），与 chain_incomplete/literal 一起构成内伤发热类归零的
  // 终结码族。
  "followup_safety_net_not_actionable",
  "sub_therapies_missing",
  "sub_therapies_insufficient",
  "sub_therapy_incomplete",
  "sub_therapy_primary_missing",
  "treatment_principle_target_mismatch",
  "therapy_principle_invalid",
  // M03 独立复核是质量层：复核提出意见时保留通过确定性安全合同的内容并标为有界。
  "primary_diagnosis_semantic_review",
  "tcm_reasoning_semantic_review",
  "formula_indication_semantic_review",
]);

/** T3 —— 结论与叙述都成立，问题只在措辞、重复、模板残留。 */
const T3_M03: ReadonlySet<string> = new Set([
  "western_clinical_rationale_restatement",
  "tcm_diagnostic_rationale_restatement",
  "western_differential_duplicate",
  "therapy_principle_method_duplicate",
  "pathogenesis_nodes_duplicated",
  "pathogenesis_therapy_directions_duplicated",
  "sub_therapy_duplicated",
  "sub_therapy_target_duplicated",
  "sub_therapy_repeats_overall_method",
  "overall_pathogenesis_restates_facts",
  "generic_tcm_template",
  "explanation_placeholder",
  "nature_item_is_mechanism",
  // 「受控目录里存在可锁定的命名方，而模型把方名留空了」是一条**策略观察**，不是结构缺陷。
  // m03SemanticIssue 里这条检查自己的注释就写着「漏锁不由服务端代选——选方是临床决策，仍归
  // 模型与医生」；既然服务端不代选，它就不该拥有作废整份诊断的权力。
  //
  // 此前它落在默认 T1，与 chain_empty、primary_syndrome_unstable 同级：一个拒绝命名经典方的
  // 模型输出会被反复注入修复提示，直到 M03 编排时限耗尽，最后降级成「重新完成辨病辨证分析」的
  // 安全有限合同——医生连证候和病机都拿不到。这个错分级此前一直没暴露，是因为复合证候归一
  // 失效时可锁定候选恒为空、这条检查几乎从不触发；主证段归一修好后它立刻成为高频码。
  // 实测：同一例胸痹病例，修正前给出「气虚血瘀，痰热内阻」+2 个病机节点，修正后 0 节点。
  //
  // T3 的效果是带批注受理：医生照常拿到完整诊断，另附一句「受控目录中存在可锁定的候选方」。
  "formula_selection_missed_lockable",
]);

/**
 * M04 的分级用**模式**而不是 Set：处方阶段的原因码几乎全带下标
 * （candidate_0_herb_3_function、non_pharma_treatment_1_availability、modification_2_action），
 * 逐个字面量枚举不可能穷尽。default-deny 不变——不匹配下面任何一条模式的码一律 T1。
 *
 * 分级依据只有一条：**这一项不满足，是否改变"这张方能不能安全服用"**。
 * 改变的留 T1；只影响叙述完整性、建议性内容或展示同步的降级。
 *
 * 受理前必须另行完整执行 diagnosis-stage-contract.ts 的 m04SafetyContractIssue。
 * 这一条对 M04 比对 M03 更要紧：m04SemanticIssue 的检查顺序不反映临床严重度，
 * nonPharma.tcmTreatments 的 15 个字段检查排在剂量、十八反十九畏与特殊人群**之前**，
 * 拿到一个 T2 码只证明排在它前面的检查通过了。
 */
const T2_M04_PATTERNS: readonly RegExp[] = [
  // 建议性内容：非药物调护三段与中医治疗项目卡片。项目卡片的 12 个字段本就由服务端按目录生成，
  // 模型只提交 projectCode 与 targetRef——拿服务端自己生成的字段驳回模型的处方没有意义。
  /^non_pharma_incomplete$/,
  /^non_pharma_treatment_count$/,
  /^non_pharma_treatment_\d+_(?:code|incomplete|positioning|target_ref|checks|plan|protocol_status|governed_plan_incomplete|assessment_parameters|availability|risk|mode|execution_boundary|specialist_mode)$/,
  // 随症加减的措辞与接地。真正承重的三类（夹带剂量、未收载药味、方向未成立的高影响药味）
  // 留在 T1，见 m04SafetyContractIssue。
  /^modification_\d+_(?:incomplete|trigger_ungrounded|action|missing_herb)$/,
  // 候选方与药味行的叙述性字段。方名/治法说明缺失不改变药味与剂量；
  // 君臣佐使的真实绑定完整性由 crossStageReasoningIssue 在 T1 把守。
  /^candidate_\d+_(?:name|therapy_match)$/,
  /^candidate_\d+_herb_\d+_(?:role|prescription_role|target|function|function_ungrounded)$/,
  // 煎服法文本与复诊节点：两者在生成路径上由服务端确定性生成
  // （serverOwnsDecoctionMethod / serverOwnsFollowUpNode），模型侧文本不完整不影响可服用性。
  // 特殊煎法（先煎/后下/包煎等）是另一回事，属逐味安全控制，留在 T1。
  /^candidate_\d+_(?:course|follow_up|follow_up_inconsistent)$/,
  /^candidate_\d+_method_incomplete(?:_[a-z_]+)?$/,
  // 病机节点覆盖不足。这是「处方不得超出诊断」的反方向守卫，此前不存在。覆盖不足不影响这张方
  // 能不能安全服用，但医生必须被告知「M03 提出的某个病机方向本次没有对应药味」——
  // 静默不覆盖比明确降级更危险，因为医生看不到缺口就不会去补。
  /^pathogenesis_node_uncovered_[A-Za-z0-9]+$/,
];

/** T3 —— 展示层与权威 JSON 的同步问题。权威是结构化 JSON，正文由服务端同步生成。 */
const T3_M04_PATTERNS: readonly RegExp[] = [
  /^visible_extra_herb_rows$/,
  /^visible_method_incomplete(?:_[a-z_]+)?$/,
  /^candidate_\d+_herb_\d+_visible_pair$/,
];

/**
 * 分级查询。同时接受带阶段前缀形式（m03_xxx / m04_xxx）与裸原因码（xxx）。
 * 未分类 → T1。这是安全默认值，不要改成 T2。
 */
export function rejectionTier(reason: string): RejectionTier {
  const code = typeof reason === "string" ? reason.trim() : "";
  if (!code) return "T1";
  if (code.startsWith("m04_")) {
    const bare = code.slice(4);
    if (T2_M04_PATTERNS.some((pattern) => pattern.test(bare))) return "T2";
    if (T3_M04_PATTERNS.some((pattern) => pattern.test(bare))) return "T3";
    return "T1";
  }
  const bare = code.startsWith("m03_") ? code.slice(4) : code;
  if (T2_M03.has(bare)) return "T2";
  if (T3_M03.has(bare)) return "T3";
  // 病历接地的**字面**分支单独降为 T2：它拦的是「时间/频度副词与症状本体跨子句重组」
  //（病历「下腹部发热」+「多在下午3时后出现」→ 模型引用「下午3时后下腹部发热」），
  // 重组不产生新的临床断言。实测网络医案 10/31「内伤发热」连续 4 轮命中同一个
  // *_literal 码、修复不收敛、整页作废——医生连证候病机都拿不到。
  // **极性**分支（*_polarity，断言与病历相反）不在此列，仍是 T1：那是编造，不是措辞。
  if (/^patient_fact_ungrounded_\d+_\d+_literal$/.test(bare)) return "T2";
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
  const prescribe = typeof reason === "string" && reason.trim().startsWith("m04_");
  if (prescribe) {
    // 处方阶段的批注必须让医生知道「哪一层通过了」：药味、剂量、配伍禁忌、特殊人群与
    // 处方计划这些承重项已完整核验通过（m04SafetyContractIssue），不完整的是它们之外的说明或建议内容。
    return tier === "T2"
      ? "本次候选方药的药味、剂量、配伍禁忌、特殊人群与处方计划已完整通过安全核验；部分调护建议、加减说明或方义描述仍不完整，请结合本次病历核对后再采纳。"
      : "本次候选方药已完整通过安全核验；医生可见正文与结构化结果之间存在个别展示差异，用药内容以药味清单为准。";
  }
  return tier === "T2"
    ? "本次辨证已形成可用的有界建议并通过事实与安全边界核验；部分支撑说明或鉴别分析仍需结合本次病历核对。"
    : "本次辨证已形成可用建议并通过事实与安全边界核验；个别表述存在重复或不够精炼，不影响其余已核实内容。";
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
