export type TransparentFormulaFallbackInput = {
  completedRepairAttempts: number;
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
 */
export function canAcceptTransparentFormulaFallback(input: TransparentFormulaFallbackInput): boolean {
  return input.completedRepairAttempts >= 1 &&
    !input.requestAborted &&
    input.strictFormulaIssue === "formula_reference_declassified" &&
    !input.therapyIssue;
}
