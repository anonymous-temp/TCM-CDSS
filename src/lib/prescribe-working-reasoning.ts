import type { CaseState, ClinicalReasoningResultV2 } from "./diagnosis-types";
import { affirmedClinicalSourceClauses } from "./clinical-polarity";
import { isLimitedM03NotPrescribable } from "./his-prescription-validation";
import { restoreDiagnoseSupportingFacts } from "./delivered-surface";

/**
 * 开方阶段在内存里用的那份辨证结果：交付面清空的西医支持事实，按病历现病史的肯定分句补回（有限结论不补）。
 *
 * 开方路由与「辨证签名后预取开方输入」（stage-prefetch.server.ts）共用这一处（2026-10-25 第十九轮）。此前只有路由补，
 * 预取拿的是交付形状（支持事实为空），用药规划器的缓存键含支持事实，于是预取从未命中：线上 48 小时 81 次开方、
 * 规划器模型调用 162 次。
 */
export function prescribeWorkingPriorReasoning<T extends ClinicalReasoningResultV2 | undefined>(caseState: CaseState, prior: T): T {
  if (!prior || isLimitedM03NotPrescribable(prior)) return prior;
  return restoreDiagnoseSupportingFacts(prior, affirmedClinicalSourceClauses(
    [caseState.hisRecord?.fields?.xianbingshi, caseState.symptoms?.presentHistory]
      .find((value): value is string => typeof value === "string" && Boolean(value.trim())),
  ));
}
