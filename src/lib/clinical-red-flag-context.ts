import type { SafetyGate } from "./diagnosis-types";

/** 已定安全门的红旗状态；交付投影只有复诊目标时读同一 red_flag_clearance 标记，不从症状文字另判。 */
export function redFlagActiveFor(context?: {
  safetyGate?: Pick<SafetyGate, "status">;
  caseState?: { safetyGate?: Pick<SafetyGate, "status"> };
  doseWithheld?: string;
  priorityEvaluation?: unknown;
}): boolean {
  const gate = context?.safetyGate || context?.caseState?.safetyGate;
  if (gate) return gate.status === "red_flag";
  if (context?.doseWithheld === "red_flag") return true;
  const target = context?.priorityEvaluation;
  return Boolean(target && typeof target === "object" && "pathway" in target && target.pathway === "red_flag_clearance");
}
