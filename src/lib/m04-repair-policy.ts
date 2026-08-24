export type TransparentFormulaFallbackInput = {
  completedRepairAttempts: number;
  /**
   * 修复机会已被证明用尽：同一条提示重复注入（fixpoint 早退）或编排总时限触顶。
   * 与「完成一轮 provider 修复」在语义上等价——都表示再给模型一轮也改变不了结果。
   */
  repairExhausted?: boolean;
  strictFormulaIssue?: string;
  therapyIssue?: string;
  requestAborted: boolean;
};

export type M04RepairState = {
  completedAttempts: number;
  requestAborted: boolean;
};

export type M04RepairOutcome = {
  ok: boolean;
  finishReason?: string | null;
  requestAborted?: boolean;
};

export function initialM04RepairState(): M04RepairState {
  return { completedAttempts: 0, requestAborted: false };
}

export function advanceM04RepairState(state: M04RepairState, outcome: M04RepairOutcome): M04RepairState {
  return {
    completedAttempts: state.completedAttempts + (outcome.ok && outcome.finishReason === "stop" ? 1 : 0),
    requestAborted: state.requestAborted || outcome.requestAborted === true,
  };
}

/**
 * A classic identity may be removed only after one completed targeted provider repair and only
 * when the remaining defect is that identity itself. A second model retry adds long-tail latency
 * without improving a composition that has already passed independent herb-therapy, dose and risk
 * contracts. Network failures, cancelled requests, clinical incompatibility and every other
 * contract failure keep the prescription in the retry state.
 *
 * 调用方在判定前已确定性剥离方剂身份，并用剥离后的内容重跑严格合同，因此 strictFormulaIssue
 * 为空即代表「以自拟方形态自证合格」。此前这里只认 formula_reference_declassified 一个码，
 * 而模型保留方名时剩余缺陷叫 formula_compilation_composition_drift ——同一件事（这张方不能
 * 继承该经典身份）的另一种写法，却让整方作废：实测麻黄汤 4 味小方被加到 9 味即 0 味出方，
 * 而方中每一味的剂量、配伍、君臣与病机引用都是通过的。
 */
/**
 * 修复耗尽后该不该受理这条治法码。
 *
 * **默认拒绝 + 质量族白名单**，不是「不匹配就放行」。
 * 我第一版写成了默认放行，被 test:m04-safety-contract 当场拦下：剂量码 herb_6_dose
 * 不在排除列表里，于是被放行——那正是 fail-open 的形状。本仓库 rejection-tier 的注释
 * 早写过同一条：「未分类 → T1。这是安全默认值，不要改成 T2。」
 *
 * 白名单里的都是**本系统词表能力边界**，不是这张方有临床错误（甲方 2026-08-08 定：质量不阻断）：
 *   · transparent_therapy_coverage / herb_support —— 治法方向覆盖率阈值
 *   · transparent_therapy_herb_knowledge_missing —— 药味功效词表未收载
 *   · herb_N_emperor_therapy_mismatch / emperor_knowledge_missing —— 君药方向对不上/查不到功效
 *   · pathogenesis_node_uncovered_Pn —— M03 某病机方向本次没有对应药味
 * 白名单之外一律拒绝，包括：结构缺失（contract_missing / herbs_missing / unresolved）、
 * 方向对立（unsupported_high_impact_*，调用方按 waive=true 算码时剩下的必然是对立）、
 * 以及任何剂量/配伍/特殊人群类码。
 */
const ACCEPTABLE_M04_THERAPY_FAMILIES: readonly RegExp[] = [
  /^transparent_therapy_(?:coverage|herb_support|herb_knowledge_missing)$/,
  /^herb_\d+_emperor_(?:therapy_mismatch|knowledge_missing)$/,
  /^pathogenesis_node_uncovered_[A-Za-z0-9]+$/,
  /^therapy_direction_uncovered_[a-z_]+$/,
];

export function isAcceptableM04TherapyIssue(therapyIssue: string | undefined): boolean {
  if (typeof therapyIssue !== "string" || !therapyIssue) return true;
  const core = therapyIssue
    .replace(/^m04_/, "")
    .replace(/^candidate_\d+_/, "")
    .replace(/^modification_\d+_/, "")
    .replace(/^transparent_therapy_(?=herb_\d)/, "");
  return ACCEPTABLE_M04_THERAPY_FAMILIES.some((pattern) => pattern.test(core));
}

export function canAcceptTransparentFormulaFallback(input: TransparentFormulaFallbackInput): boolean {
  // A locked classic identity is never transferred to a composition that failed its governed
  // baseline. After repair exhaustion the caller strips that identity, records which M03 formula
  // was declassified for the visible cross-stage explanation, then re-runs every hard prescription
  // and formula contract plus clinical review on the self-devised candidate. This preserves the
  // clinical plan without falsely presenting it as the named formula; before repair exhaustion the
  // same path remains unavailable.
  // 「完成一轮修复」与「修复已被证明无效」是同一个前提的两种到达方式。此前只认前者，于是
  // fixpoint 早退（同一提示重复注入）反而拿不到降级资格：fixpoint 的语义正是「再修也是同一张
  // 失败彩票」，却因为跳过了那一轮而不算「完成」，整方随即作废。实测胃痛-肝气犯胃：
  // 柴胡疏肝散 7/7 组成达标、fixpoint 早退、无降级、0 味；同一轮里恰好先完成过一轮修复的
  // 麻黄汤与清胃散则正常降级出方——差别只在到达方式，不在候选质量。
  return (input.completedRepairAttempts >= 1 || input.repairExhausted === true) &&
    !input.requestAborted &&
    (input.strictFormulaIssue === undefined || input.strictFormulaIssue === "" ||
      input.strictFormulaIssue === "formula_reference_declassified") &&
    // 治法侧：**质量类一律受理**（甲方 2026-08-08）。调用方已按 waive=true 口径算 therapyIssue，
    // 词表覆盖率/君药功效/病机节点这类在那一侧就解析成 undefined 了；能到这里的
    // therapyIssue 只剩两类——结构缺失（contract_missing / herbs_missing，无从标注、必须拦）
    // 与方向对立（unsupported_high_impact_*，临床错误、任何时候不豁免）。
    // 判据因此从「有没有批注文案」改为「是不是这两类」：前者是文案表，会随文案增删漂移；
    // 后者才是语义。
    (!input.therapyIssue || isAcceptableM04TherapyIssue(input.therapyIssue));
}

/**
 * 治法覆盖类问题在修复耗尽后的处置：带批注受理，而不是 0 味。
 *
 * 依据是这两个码的**性质**：它们是本系统治法词表上的覆盖率阈值（方向覆盖 ≥50%、君臣落在
 * 已锁定方向 ≥80%），不是药有没有毒、量有没有越界。每一味药此前都已单独通过：高影响方向
 * 门禁（附子混进热证照样拦）、逐味药典剂量边界、十八反十九畏、特殊人群门禁、监管名单扣除。
 * 阈值不达标只说明「本系统没能自动核验方义」，把它当成「这张方临床错误」，就是网络医案
 * 37/41（两例自汗，煅牡蛎/麻黄根类收涩方向）整方 0 味的直接原因。
 *
 * 产品语义（甲方定）：**安全问题阻断，质量问题标注**——医生看得到批注，灵犀审方照常复核。
 * transparent_therapy_contract_missing 不在此列：它意味着候选或 M03 结构本身缺失，无从标注。
 */
export function m04TherapyIssueQualityAnnotation(therapyIssue: string | undefined): string | undefined {
  if (typeof therapyIssue !== "string" || !therapyIssue) return undefined;
  // 各发射点会给同一族码加不同前缀（m04_ / candidate_N_ / transparent_therapy_ /
  // modification_N_），豁免语义只看核心码。
  const core = therapyIssue
    .replace(/^m04_/, "")
    .replace(/^candidate_\d+_/, "")
    .replace(/^modification_\d+_/, "")
    // 注意 herb_support 也以 herb_ 开头——只在后随数字（herb_3_…逐味码）时才剥这层前缀。
    .replace(/^transparent_therapy_(?=herb_\d)/, "");
  if (core === "transparent_therapy_coverage") {
    return "本次候选方药的逐味剂量边界、配伍禁忌、特殊人群与高影响方向门禁均已通过安全核验；但系统未能自动核验全部治法方向的覆盖情况，方义与治法的对应关系请医生结合本次病历确认后再采纳。";
  }
  if (core === "transparent_therapy_herb_support") {
    return "本次候选方药的逐味剂量边界、配伍禁忌、特殊人群与高影响方向门禁均已通过安全核验；但部分君臣药味的功效方向未能被系统自动对应到已锁定治法，请医生逐味核对方义后再采纳。";
  }
  // 词表未成立 ≠ 方向对立：对立（与锁定治法直接相反）在合同里是独立判定、任何时候不豁免；
  // 这里放行的只是「系统词表没能把该药的方向对应到 M03 已锁定治法」。
  // 「本系统词表没收这味药的功效」与上面两条同性质，此前却不可批注、整方作废。
  // transparentFormulaTherapyIssue 在**任意一味治疗性药味的 herbTherapyConcepts 为空**时
  // 就返回这个码——判据是「我们的知识库有没有收载」，不是「这味药有没有害」。该方的逐味
  // 药典剂量边界、十八反十九畏、特殊人群门禁、高影响方向门禁此前都已单独通过。
  // 线上实测（2026-08-07，50 例验收）：透明降级块进去 15 次全被拒，其中 3 次死在这个码上，
  // 医生看到的是空白处方页；而同一张方去掉那味未收载的药就能受理——差别只在词表覆盖率。
  // 与 owner doctrine 一致：安全问题阻断，质量问题标注。
  // contract_missing / herbs_missing 不在此列：那意味着候选或 M03 结构本身缺失，无从标注。
  if (core === "transparent_therapy_herb_knowledge_missing") {
    return "本次候选方药的逐味剂量边界、配伍禁忌、特殊人群与高影响方向门禁均已通过安全核验；但个别药味的功效方向系统未能自动核验（本系统药味功效词表未收载该药，不代表该药存在风险），请医生核对方义后再采纳。";
  }
  if (/^herb_\d+_unsupported_high_impact_[a-z_]+$/.test(core)) {
    return "本次候选方药的逐味剂量边界、配伍禁忌与特殊人群门禁均已通过安全核验；但个别药味的功效方向未能被系统自动对应到本例已锁定的治法（不属于方向相反），该药味的取舍请医生结合方义判断后再采纳。";
  }
  if (/^herb_\d+_emperor_therapy_mismatch$/.test(core)) {
    return "本次候选方药的逐味剂量边界、配伍禁忌与特殊人群门禁均已通过安全核验；但君药的功效方向未能被系统自动对应到主病机治法，君药的选取请医生按辨证结论确认后再采纳。";
  }
  const uncoveredDirection = /^therapy_direction_uncovered_([a-z_]+)$/.exec(core);
  if (uncoveredDirection) {
    // 方向名用受控中文映射，医生页面不出现内部枚举值。
    const labels: Record<string, string> = { heat_clear: "清热", yang_warm: "温阳/温里", blood_move: "活血", purge: "泻下", orifice_open: "开窍", mass_soften: "软坚" };
    const label = labels[uncoveredDirection[1]] || "该";
    return `本次候选方药的逐味剂量边界、配伍禁忌、特殊人群与高影响方向门禁均已通过安全核验；`
      + `但已锁定治法中的「${label}」方向在主方药味中未见系统可自动核验的承接药味，`
      + `是否加入相应药味请医生结合方义判断后再采纳。`;
  }
  if (/^pathogenesis_node_uncovered_[A-Za-z0-9]+$/.test(core)) {
    return "本次候选方药的逐味剂量边界、配伍禁忌与特殊人群门禁均已通过安全核验；但 M03 辨证提出的个别病机方向本次未见对应药味，是否补充针对性药味请医生判断后再采纳。";
  }
  return undefined;
}

/**
 * 修复轮走完之后，独立复核的 repair 意见还能不能被受理——以及受理时给医生的批注。
 *
 * 这条规则必须只有一处实现。它此前散落在三个地方，每处各自决定「repair ⇒ 作废」，
 * 于是同一个类别的 0 味被修了三遍还在复发：透明降级块内、块外的入口守卫、以及
 * finalize 阶段的最后一次复核（后者会把已经受理的降级候选重新判死）。
 *
 * 分流依据是**意见的性质**，不是意见的严重程度措辞：
 *  · 组成不符 / 君臣-病机匹配 / 患者前提未知 —— 这三项在确定性层都有对应检查并且已经跑过：
 *    方剂基准组成核验、君臣结构与病机引用核验、妊娠哺乳儿科门禁 + 十八反十九畏 + 逐味剂量
 *    上限。复核在此之上给的是质量意见，按带批注受理，医生看得见、审方还会再过一遍。
 *  · 剂量强度不相称 —— 维持 fail-closed。剂量是唯一不能含糊的一项，确定性层只能保证不越界，
 *    保证不了「这个强度对这个人合不合适」。
 *  · 未知码 —— default-deny。
 *
 * 前提是**修复确实已经无路可走**（fixpoint 早退 / 编排超时 / 修复轮已用过）：还能修的时候
 * 照旧去修，本函数不参与。
 */
export function m04FinalReviewQualityAnnotation(review: { status?: string; issueCode?: string }): string | undefined {
  if (review.status !== "repair") return undefined;
  if (review.issueCode === "formula_composition_mismatch") {
    return "本次候选方药的药味、剂量、配伍禁忌、特殊人群与君臣结构已完整通过安全核验；因实际组成未能满足所引经方的核心结构，已改按本例辨证组方呈现，请结合本次病历核对方义后再采纳。";
  }
  if (review.issueCode === "herb_plan_mismatch") {
    return "本次候选方药的药味、剂量、配伍禁忌、特殊人群与君臣结构已完整通过安全核验；独立复核对方药与病机的对应关系仍有保留意见，请结合本次病历逐味核对后再采纳。";
  }
  if (review.issueCode === "patient_context_mismatch") {
    return "本次候选方药的药味、剂量、配伍禁忌、特殊人群与君臣结构已完整通过安全核验；但本例的过敏史、当前用药、肝肾功能等信息尚未采集，方案按「未知」保守处理，请医生补充确认并经院内审方复核后再采纳。";
  }
  if (review.issueCode === "dose_rationale_concern") {
    // 数值本身出不了圈：每味剂量已被药典上下限确定性钳制，越界在此之前就被逐味驳回。
    // 复核在圈内提的是「强度与本例相称与否」——这正是医师定夺的事项，批注明示并交由
    // 医师与审方，比整方作废让医生一无所获更安全（0 味时医生只能脱离系统徒手开方）。
    return "本次候选方药的每味剂量均在药典边界内，配伍禁忌、特殊人群与君臣结构已通过安全核验；独立复核认为部分药味的剂量强度与本例病情的相称性需医生把握，请结合患者年龄、体质与证候强度调整后再采纳。";
  }
  return undefined;
}

/**
 * Quality opinions that never justify a provider rewrite.
 *
 * Keep this deliberately narrower than `m04FinalReviewQualityAnnotation`: a dose-strength or
 * patient-dependency opinion can expose risk that deterministic upper/lower bounds cannot prove
 * away, so those paths retain their fail-closed repair/fallback behavior. The only zero-rewrite
 * shape is an otherwise safe herb-direction preference; the caller still re-runs the complete
 * deterministic M04 safety and formula contracts before attaching the signed annotation.
 */
export function m04ZeroProviderRepairQualityAnnotation(review: {
  status?: string;
  issueCode?: string;
  repairFocus?: string;
}): string | undefined {
  if (review.status !== "repair" ||
      review.issueCode !== "herb_plan_mismatch" ||
      review.repairFocus !== "herb_direction") return undefined;
  return m04FinalReviewQualityAnnotation(review);
}

/**
 * A provider-repair exhaustion claim is valid only for the reviewer issue that actually triggered
 * a completed repair in this request. A global/cross-request exhaustion flag or an unrelated
 * contract fixpoint cannot authorize a new reviewer concern. Dose and patient-dependency opinions
 * use their dedicated fail-closed policies and never enter this quality-only path.
 */
export function m04ProviderRepairExhaustedQualityAnnotation(input: {
  review: { status?: string; issueCode?: string; repairFocus?: string };
  previousReviewReason?: string;
  previousReviewFocus?: string;
  completedRepairAttemptsForIssue: number;
}): string | undefined {
  if (input.completedRepairAttemptsForIssue < 1 ||
      input.previousReviewReason !== "m04_herb_plan_semantic_review" ||
      input.review.status !== "repair" ||
      input.review.issueCode !== "herb_plan_mismatch" ||
      !input.previousReviewFocus ||
      input.previousReviewFocus !== input.review.repairFocus) return undefined;
  return m04FinalReviewQualityAnnotation(input.review);
}

/**
 * A patient-context review remains actionable for one bounded repair round. If the reviewer
 * returns the same patient-dependency issue after both bounded repairs, there is no repair round
 * left to execute. The latest candidate may legitimately differ because it attempted to remove
 * that dependency; byte equality with the preceding candidate is therefore not a safety
 * invariant. At that point the caller may resolve the repeated review as quality-only, but only
 * after independently re-running the complete deterministic prescription safety and
 * formula-compilation contracts on the latest candidate.
 *
 * This is intentionally narrower than `m04FinalReviewQualityAnnotation`: dose, composition and
 * herb-plan opinions never enter this path, a newly introduced issue code defaults to denial, and
 * an aborted request can never be converted into acceptance.
 */
export function canAcceptRepeatedM04PatientContextReviewAfterRepairExhaustion(input: {
  review: {
    status?: string;
    issueCode?: string;
    repairFocus?: string;
    implicatedHerbs?: string[];
  };
  previousReviewReason?: string;
  completedRepairAttempts: number;
  hardSafetyIssue?: string;
  formulaCompilationIssue?: string;
  requestAborted: boolean;
}): boolean {
  const { review } = input;
  return !input.requestAborted &&
    input.completedRepairAttempts >= 2 &&
    input.previousReviewReason === "m04_patient_context_semantic_review" &&
    review.status === "repair" &&
    review.issueCode === "patient_context_mismatch" &&
    review.repairFocus === "patient_dependency" &&
    !input.hardSafetyIssue &&
    !input.formulaCompilationIssue;
}

/**
 * M03 侧的同一条最后一公里策略：finalize 阶段的独立复核跑在全部修复轮之后，它给出的
 * repair 已无承接者，唯一的效果是把一份**确定性接地合同已通过**的辨证判成空白，随后
 * M04 直接 409/降级，整个后台 agent 流程在此卡死（实测网络医案 10/13/24「内伤发热」类）。
 *
 * 受理边界与 M04 同构：
 *  · tcm_reasoning_unsupported / formula_indication_mismatch —— 复核对辨证依据充分性/
 *    方向对应关系的**质量意见**。确定性层的 m03SafetyContractIssue（病历接地、极性、
 *    红旗、完整度、链条结构）必须由调用方重跑并确认为空，才允许带批注受理。
 *  · criteria_not_met / diagnostic_label_overstated / supporting_fact_mismatch —— 指向
 *    「诊断标签本身站不住」，且其对应的确定性降级路径（西医主诊断降级为『考虑』）在
 *    修复轮内已有机会执行，finalize 处维持作废。
 *  · 未知码 default-deny。
 */
export function m03FinalReviewQualityAnnotation(review: { status?: string; issueCode?: string }): string | undefined {
  if (review.status !== "repair") return undefined;
  if (review.issueCode === "tcm_reasoning_unsupported") {
    return "本次辨证的病历接地、红旗边界与结构完整性已通过确定性核验；独立复核对部分辨证依据的充分性仍有保留意见，请医生结合四诊资料复核证候结论后再采纳。";
  }
  if (review.issueCode === "formula_indication_mismatch") {
    return "本次辨证的病历接地、红旗边界与结构完整性已通过确定性核验；独立复核对推荐方向与证候的对应关系仍有保留意见，方药方向请以医生辨证为准。";
  }
  return undefined;
}
