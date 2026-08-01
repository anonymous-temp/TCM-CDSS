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
