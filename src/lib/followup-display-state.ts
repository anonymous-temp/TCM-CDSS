import type { CaseState, Phase, StructuredFollowupTimelineItem, ClinicalReasoningResultV2 } from "./diagnosis-types";
import { normalizeCaseStateInput } from "./diagnosis-types";
import { withSafetyGate, reconcileRestoredCaseState, derivePrescriptionPermission, parseStructuredFollowupTimeline, stripStructuredFollowupTimeline } from "./diagnosis-safety";
import { sanitizeAuthoritativeClinicalOutput } from "./clinical-output-authority";
import { stripEvimedTrailingQuestions } from "./markdown-stream-content";
import { adviceText, joinWarningText, mapWarningText, type WarningTextProjection } from "./warning-text-projection";
import { stableWarningJson } from "./warning-display-binding";
import { sanitizeCaseStateForBrowserPersistence } from "./browser-case-persistence";
import { parseRxAuditStatusMarker, stripRxAuditStatusMarker } from "./rxaudit-status";
import { diagnoseReasoningFromState, mergeReasoningStages } from "./diagnosis-parse";
import { classifyHerbWarning, type ClinicalWarningProfile } from "./clinical-warning-tier";
import { customerEvidenceDisplayStatus } from "./customer-evidence";
import { normalizedFormulaModificationFields } from "./formula-modification";

type StructuredHerb = NonNullable<ClinicalReasoningResultV2["formula"]>["candidates"][number]["herbs"][number];

export function structuredHerbWarningProfile(herb: StructuredHerb): ClinicalWarningProfile {
  return classifyHerbWarning({
    drug: herb.name,
    dose: herb.dose || "",
    evidence: herb.evidence?.source || "",
    safety: [
      herb.isToxic ? "毒性药味，需复核" : "",
      herb.decoctionRequirement,
    ].filter(Boolean).join("；"),
    verificationTier: herb.verificationTier,
    verificationReasons: herb.verificationReasons,
  });
}

export function markdownTableCell(value: unknown): string {
  return String(value ?? "").replace(/\r?\n/g, "；").replace(/\|/g, "｜").trim();
}

export function buildAcceptedPrescriptionMarkdown(reasoning: ClinicalReasoningResultV2, candidateIndex: number, herbHash?: string): string {
  return buildAcceptedPrescriptionWarningProjection(reasoning, candidateIndex, herbHash).markdown;
}

export function buildAcceptedPrescriptionWarningProjection(reasoning: ClinicalReasoningResultV2, candidateIndex: number, herbHash?: string): WarningTextProjection {
  const candidate = reasoning.formula?.candidates[candidateIndex];
  if (!candidate) return joinWarningText([]);
  const herbRows = candidate.herbs.map((herb, index) => {
    const warning = structuredHerbWarningProfile(herb);
    return `| ${index + 1} | ${markdownTableCell(herb.name)} | ${markdownTableCell(herb.verificationTier === "identity_pending" ? "待核定" : herb.dose || "待医生确认")} | ${markdownTableCell(herb.role)} | ${markdownTableCell(herb.targetPathogenesis)} | ${markdownTableCell(herb.function)} | ${markdownTableCell([herb.processing ? `炮制：${herb.processing}` : "", herb.decoctionRequirement].filter(Boolean).join("；") || "常规")} | ${warning.label} · ${markdownTableCell(warning.reasons.join("；"))} |`;
  });
  const modifications = reasoning.formula?.modifications || [];
  return mapWarningText(joinWarningText([
    "## 中药饮片处方",
    ...(herbHash ? [`**处方版本摘要**：${markdownTableCell(herbHash)}`] : []),
    `**候选方名/方向**：${markdownTableCell(candidate.name)}`,
    "",
    "| 序号 | 药名 | 剂量 | 角色 | 对应病机 | 功用 | 炮制/煎服 | 核验分级 |",
    "|---|---|---|---|---|---|---|---|",
    ...herbRows,
    "",
    "## 方义解析",
    candidate.formulaAnalysis,
    ...(shouldRenderEvidenceStatus(candidate.formulaSource) ? [
      "",
      "## 方剂出处",
      `**出处**：${markdownTableCell(candidate.formulaSource.source)}`,
    ] : []),
    ...(candidate.constructionType === "combined" && candidate.baseFormulas && candidate.baseFormulas.length > 1 ? candidate.baseFormulas.map((base) =>
      `- ${markdownTableCell(base.name)}：${markdownTableCell(base.source)}；${base.verificationStatus === "verified_individually" ? "已逐方核验" : "原方案来源参考"}；组成匹配 ${base.matchedIngredientCount}/${base.totalIngredientCount || "?"} 味${base.requiredIngredientCount != null ? `，核心药味 ${base.matchedRequiredIngredientCount || 0}/${base.requiredIngredientCount} 味` : ""}${base.minimumPreservedIngredientCount != null ? `，组成下限 ${base.minimumPreservedIngredientCount} 味` : ""}。`
    ) : []),
    "",
    "## 煎服法",
    `剂数：${candidate.decoction.doseCount || "待医生确认"}；方法：${candidate.decoction.method}；疗程：${candidate.decoction.course}；复核节点：${candidate.decoction.followUpNode}`,
    ...(modifications.length > 0 ? [
      "",
      "## 随症加减",
      ...modifications.flatMap((item) => {
        const modification = normalizedFormulaModificationFields(item);
        return modification
          ? [adviceText(`- ${markdownTableCell(item.trigger)}：动作：${modification.action}；药味：${markdownTableCell(modification.herbName)}${item.doseOrHandling ? `（${markdownTableCell(item.doseOrHandling)}）` : ""}；${markdownTableCell(item.reason)}`)]
          : [];
      }),
    ] : []),
  ]), (text) => text.trim());
}

export function shouldRenderEvidenceStatus(evidence?: { evidenceLevel?: string; source?: string; confidence?: string }): boolean {
  return customerEvidenceDisplayStatus(evidence) === "traceable";
}

export function extractRiskAuditSection(content = ""): string {
  const lines = content.split("\n");
  const collected: string[] = [];
  let capturing = false;
  for (const line of lines) {
    const heading = line.match(/^##\s+(.+?)\s*$/)?.[1] || "";
    if (heading) {
      if (capturing) break;
      capturing = /合理用药审方|灵犀统一审方/.test(heading);
    }
    if (capturing) collected.push(line);
  }
  return collected.join("\n").trim();
}

export function extractRiskNonAuditSection(content = ""): string {
  const auditSection = extractRiskAuditSection(content);
  return (auditSection ? content.replace(auditSection, "") : content).trim();
}

export function replaceRiskAssessmentFollowup(existing: string | undefined, generated: string): string {
  if (/^##\s*(?:合理用药审方|灵犀统一审方)/m.test(generated)) return generated.trim();
  return [extractRiskAuditSection(existing), generated.trim()].filter(Boolean).join("\n\n");
}

export function recoverInterruptedRun(state: CaseState, runningPhase?: Phase): CaseState {
  const interruptedPhase = runningPhase || (state.phase === "question" ? undefined : state.phase);
  if (!interruptedPhase || !(["collect", "question", "diagnose", "prescribe", "assess"] as Phase[]).includes(interruptedPhase) || state.lastError) return state;
  return {
    ...state,
    phase: "error",
    lastError: {
      phase: interruptedPhase,
      message: "页面刷新或关闭中断了正在运行的阶段；已保留病历和已完成结果，可从当前阶段安全重试。",
    },
  };
}

export function restoreWarningDisplayCase(value: unknown, runningPhase?: Phase): CaseState | undefined {
  const normalized = normalizeCaseStateInput(value);
  if (!normalized) return undefined;
  // A missing bookkeeping timestamp is not a restore event. Preserve absence locally rather than
  // binding a new wall-clock default on every decrypt; supplied dates remain unchanged.
  const raw = value as Partial<CaseState>;
  for (const key of ["hisRecord", "faceCapture"] as const) {
    if (raw[key] && normalized[key] && (raw[key].updatedAt === undefined || raw[key].updatedAt === "")) normalized[key].updatedAt = "";
  }
  return recoverInterruptedRun(reconcileRestoredCaseState(withSafetyGate(sanitizeCaseStateForBrowserPersistence(normalized))), runningPhase);
}

export function preserveUnchangedHisSnapshot(previous: CaseState, rebuilt: CaseState): CaseState {
  if (!previous.hisRecord || !rebuilt.hisRecord) return rebuilt;
  const unchangedClock = { ...rebuilt, hisRecord: { ...rebuilt.hisRecord, updatedAt: previous.hisRecord.updatedAt } };
  return stableWarningJson(unchangedClock) === stableWarningJson(previous) ? unchangedClock : rebuilt;
}

export function applyCompletedM05DisplayResult(
  previous: CaseState,
  result: { content: string; followupTimeline: StructuredFollowupTimelineItem[] },
  resolvedCustomerId?: string,
): CaseState {
  if (previous.customerId && resolvedCustomerId && previous.customerId !== resolvedCustomerId) throw new Error("warning_customer_mismatch");
  const machineAuditStatus = parseRxAuditStatusMarker(result.content);
  const cleanRiskAssessment = stripRxAuditStatusMarker(result.content);
  const riskAssessment = replaceRiskAssessmentFollowup(previous.riskAssessment, cleanRiskAssessment);
  const noAuditItems = machineAuditStatus?.reason === "no_prescription_items" ||
    /候选方药结构尚未达到自动审方接口要求|候选方药无法形成可核验的自动审方对象|尚未形成完整药味清单/.test(cleanRiskAssessment);
  const auditUnavailable = machineAuditStatus
    ? machineAuditStatus.available === false
    : noAuditItems || /本次未完成自动用药复核|自动用药复核暂未返回结果|M05 未完成灵犀处方后审方/.test(cleanRiskAssessment);
  return withSafetyGate({ ...previous,
    ...(resolvedCustomerId ? { customerId: resolvedCustomerId } : {}),
    riskAssessment, followupTimeline: result.followupTimeline,
    auditAdvisory: machineAuditStatus?.presentationDisabled
      ? { available: false, presentationDisabled: true }
      : auditUnavailable
        ? { available: false, reason: machineAuditStatus?.reason || (noAuditItems ? "no_prescription_items" : "service_unavailable") }
        : { available: true },
    skipDifferentiationGate: undefined, phase: "done", previousResult: undefined,
  });
}

/** Mirror the existing NDJSON presentation and stream-finalization transforms before reduction. */
export function finalizeM05DisplayResult(previous: CaseState, raw: WarningTextProjection, customerId?: string) {
  const followupTimeline = parseStructuredFollowupTimeline(raw.markdown);
  const final = mapWarningText(raw, (text) => stripEvimedTrailingQuestions(sanitizeAuthoritativeClinicalOutput(stripStructuredFollowupTimeline(text))));
  const state = applyCompletedM05DisplayResult(previous, { content: final.markdown, followupTimeline }, customerId);
  // Merge exactly the same retained old audit text. Empty advice projections are intentional and
  // must not trigger a fallback to the unprojected display or to old care prose.
  const projectedState = applyCompletedM05DisplayResult(previous, { content: final.currentRiskMarkdown, followupTimeline }, customerId);
  return { state, content: final.markdown, followupTimeline,
    projection: { markdown: state.riskAssessment || "", currentRiskMarkdown: projectedState.riskAssessment || "" },
  };
}

export type AcceptedPrescriptionDisplayResult = {
  caseId: string; reasoning: ClinicalReasoningResultV2; auditSection: string; followupSection: string;
  followupTimeline: StructuredFollowupTimelineItem[]; serverSafetyLocked: boolean;
  revision: NonNullable<CaseState["prescriptionRevision"]>;
};

export function applyAcceptedPrescriptionDisplayResult(previous: CaseState, accepted: AcceptedPrescriptionDisplayResult, complete = true): CaseState {
  const auditAdvisory: CaseState["auditAdvisory"] = accepted.revision.auditAvailable === false
    ? { available: false, reason: accepted.revision.auditReason === "no_prescription_items" ? "no_prescription_items" : "service_unavailable" }
    : { available: true };
  const merged = mergeReasoningStages(diagnoseReasoningFromState(previous), accepted.reasoning);
  const edited = withSafetyGate({ ...previous, phase: "assess",
    prescription: buildAcceptedPrescriptionMarkdown(accepted.reasoning, accepted.revision.candidateIndex, accepted.revision.herbHash),
    riskAssessment: accepted.auditSection, reasoningPrescribe: accepted.reasoning, reasoningV2: merged || accepted.reasoning,
    prescriptionRevision: accepted.revision, auditAdvisory, safetyLocked: accepted.serverSafetyLocked, lastError: undefined,
  });
  return !complete ? edited : withSafetyGate({ ...edited, phase: "done",
    riskAssessment: replaceRiskAssessmentFollowup(accepted.auditSection, accepted.followupSection),
    followupTimeline: accepted.followupTimeline,
    safetyLocked: accepted.serverSafetyLocked || derivePrescriptionPermission(edited).formalAdoption === "blocked",
  });
}

export function revisionFromAudit(audit: Record<string, unknown>, candidateIndex: number, herbHash: string, responseOk: boolean): NonNullable<CaseState["prescriptionRevision"]> {
  const rawResult = String(audit.auditResult || "").toUpperCase();
  const rawRisk = String(audit.highestRiskLevel || "").toUpperCase();
  return { source: "herb_workbench", candidateIndex, herbHash,
    auditedAt: typeof audit.auditedAt === "string" ? audit.auditedAt : new Date().toISOString(),
    auditResult: ["PASS", "REMIND", "MANUAL_REVIEW", "BLOCK"].includes(rawResult) ? rawResult as NonNullable<CaseState["prescriptionRevision"]>["auditResult"] : "MANUAL_REVIEW",
    highestRiskLevel: ["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(rawRisk) ? rawRisk as NonNullable<CaseState["prescriptionRevision"]>["highestRiskLevel"] : "HIGH",
    auditAvailable: responseOk && audit.source === "lingxi" && audit.degraded !== true,
    degraded: audit.degraded === true, degradeReason: typeof audit.degradeReason === "string" ? audit.degradeReason : undefined,
    needManualReview: audit.needManualReview === true, auditReason: typeof audit.reason === "string" ? audit.reason : undefined,
    auditId: typeof audit.auditId === "string" ? audit.auditId : undefined, traceId: typeof audit.traceId === "string" ? audit.traceId : undefined,
    attestationVersion: audit.attestationVersion === "tcm-cdss-workbench-revision-v1" ? audit.attestationVersion : undefined,
    attestation: typeof audit.attestation === "string" ? audit.attestation : undefined,
  };
}
