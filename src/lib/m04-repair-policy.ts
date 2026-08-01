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
export function canAcceptTransparentFormulaFallback(input: TransparentFormulaFallbackInput): boolean {
  // 「完成一轮修复」与「修复已被证明无效」是同一个前提的两种到达方式。此前只认前者，于是
  // fixpoint 早退（同一提示重复注入）反而拿不到降级资格：fixpoint 的语义正是「再修也是同一张
  // 失败彩票」，却因为跳过了那一轮而不算「完成」，整方随即作废。实测胃痛-肝气犯胃：
  // 柴胡疏肝散 7/7 组成达标、fixpoint 早退、无降级、0 味；同一轮里恰好先完成过一轮修复的
  // 麻黄汤与清胃散则正常降级出方——差别只在到达方式，不在候选质量。
  return (input.completedRepairAttempts >= 1 || input.repairExhausted === true) &&
    !input.requestAborted &&
    (input.strictFormulaIssue === undefined || input.strictFormulaIssue === "" ||
      input.strictFormulaIssue === "formula_reference_declassified") &&
    !input.therapyIssue;
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
  return undefined;
}
