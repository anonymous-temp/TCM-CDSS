import type { CaseState } from "./diagnosis-types";

export type ClinicalWarningLevel = "L0" | "L1" | "L2" | "L3" | "L4";
export type ClinicalWarningAction =
  | "display_only"
  | "acknowledge"
  | "reason_required"
  | "non_executable";

export type ClinicalWarningProfile = {
  level: ClinicalWarningLevel;
  label: string;
  action: ClinicalWarningAction;
  executable: boolean;
  reasons: string[];
};

const WARNING_RANK: Record<ClinicalWarningLevel, number> = {
  L0: 0,
  L1: 1,
  L2: 2,
  L3: 3,
  L4: 4,
};

const LABELS: Record<ClinicalWarningLevel, string> = {
  L0: "常规信息",
  L1: "一般提醒",
  L2: "需确认",
  L3: "高风险复核",
  L4: "确定性阻断",
};

function activeRiskLine(text: string, pattern: RegExp): string | undefined {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/[*#>|]/g, "").trim())
    .find((line) =>
      pattern.test(line) &&
      !/(未发现|未见|无明确|不存在|不构成|已排除|否认|尚未发现|未检出).{0,16}(?:禁忌|冲突|十八反|十九畏|超量|阻断)/.test(line),
    );
}

function uniqueReasons(reasons: Array<string | undefined>): string[] {
  return [...new Set(reasons.map((reason) => reason?.trim()).filter((reason): reason is string => Boolean(reason)))].slice(0, 8);
}

function profile(level: ClinicalWarningLevel, reasons: string[], executable = true): ClinicalWarningProfile {
  const action: ClinicalWarningAction =
    !executable || level === "L4" ? "non_executable" :
    level === "L3" ? "reason_required" :
    level === "L2" ? "acknowledge" :
    "display_only";
  return { level, label: LABELS[level], action, executable: executable && level !== "L4", reasons };
}

export function warningLevelRank(level: ClinicalWarningLevel): number {
  return WARNING_RANK[level];
}

export function classifyHerbWarning(input: {
  drug?: string;
  dose?: string;
  evidence?: string;
  safety?: string;
  verificationTier?: "verified" | "unverified_dose" | "identity_pending" | "toxic_regulated";
  verificationReasons?: string[];
}): ClinicalWarningProfile {
  const drug = input.drug?.trim() || "该药味";
  const dose = input.dose?.trim() || "";
  const evidence = input.evidence?.trim() || "";
  const safety = input.safety?.trim() || "";
  const combined = [drug, dose, evidence, safety].filter(Boolean).join("；");

  const blocking = activeRiskLine(
    combined,
    /(?:十八反|十九畏|配伍禁忌|绝对禁忌|严禁|禁止使用|审方结论.{0,12}(?:BLOCK|阻断)|风险等级.{0,8}CRITICAL)/i,
  );
  if (blocking) {
    return profile("L4", [`${drug}命中确定性禁忌或阻断规则`, blocking], false);
  }

  const highRisk = activeRiskLine(
    combined,
    /(?:大毒|有毒|毒性药品|孕妇禁用|妊娠禁用|儿童禁用|肝肾功能不全.{0,12}(?:禁用|慎用)|先煎|久煎|后下|另煎|冲服|不可火煅|慎用|禁用)/,
  );
  if (highRisk) {
    return profile("L3", uniqueReasons([
      `${drug}需医生说明理由并复核特殊风险`,
      ...(input.verificationReasons || []),
      highRisk,
    ]));
  }

  if (input.verificationTier === "toxic_regulated") {
    return profile("L3", uniqueReasons([
      `${drug}属于毒性/受管制药味，需医生和药师复核`,
      ...(input.verificationReasons || []),
    ]));
  }

  if (input.verificationTier === "identity_pending" || input.verificationTier === "unverified_dose") {
    return profile("L2", uniqueReasons([
      ...(input.verificationReasons || []),
      input.verificationTier === "identity_pending"
        ? `${drug}药味身份待核定`
        : `${drug}剂量边界待核验`,
    ]));
  }

  const missingDose = !dose || /(?:待确认|待补充|未知|不详|—|--|暂无)/.test(dose);
  const missingEvidence = !evidence || /(?:待补证|待检索|证据不足|待核验|未核验|暂无|—|--)/.test(evidence);
  const unresolvedSafety = /(?:待医生|待药师|人工复核|审方不可用|尚未审方|无法确认|未知)/.test(safety);
  if (missingDose || missingEvidence || unresolvedSafety) {
    return profile("L2", uniqueReasons([
      missingDose ? `${drug}剂量尚未形成可执行依据` : undefined,
      missingEvidence ? `${drug}证据来源尚未完成核验` : undefined,
      unresolvedSafety ? safety : undefined,
    ]));
  }

  if (safety && !/(无特殊|未见异常|常规复核|按常规)/.test(safety)) {
    return profile("L1", [`${drug}存在一般用药提醒`, safety]);
  }

  return profile("L0", [`${drug}当前未命中额外分级警示`]);
}

export function deriveCaseWarningProfile(caseState: CaseState): ClinicalWarningProfile {
  const gate = caseState.safetyGate;
  const revision = caseState.prescriptionRevision;
  const combined = [caseState.prescription, caseState.riskAssessment].filter(Boolean).join("\n");

  const blockingLine = activeRiskLine(
    combined,
    /(?:十八反|十九畏|配伍禁忌|绝对禁忌|审方结论.{0,12}(?:BLOCK|阻断)|风险等级.{0,8}CRITICAL)/i,
  );
  if (revision?.auditResult === "BLOCK" || revision?.highestRiskLevel === "CRITICAL" || blockingLine) {
    return profile("L4", uniqueReasons([
      revision?.auditResult === "BLOCK" ? "处方审方结论为阻断" : undefined,
      revision?.highestRiskLevel === "CRITICAL" ? "处方命中严重级别风险" : undefined,
      blockingLine,
    ]), false);
  }

  if (gate?.status === "red_flag") {
    return profile("L3", uniqueReasons([
      ...gate.redFlags,
      ...gate.reasons,
      "当前仅可形成转诊/急诊风险说明，不生成或导出剂量级处方",
    ]), false);
  }

  const highRiskLine = activeRiskLine(
    combined,
    /(?:孕妇禁用|妊娠禁用|儿童禁用|肝肾功能不全.{0,12}(?:禁用|慎用)|毒性药品|大毒|高风险|强提示)/,
  );
  if (revision?.highestRiskLevel === "HIGH" || highRiskLine) {
    return profile("L3", uniqueReasons([
      revision?.highestRiskLevel === "HIGH" ? "处方审方最高风险等级为 HIGH" : undefined,
      highRiskLine,
    ]));
  }

  const unavailableAudit = revision?.auditAvailable === false || caseState.auditAdvisory?.available === false;
  if (
    gate?.status === "needs_information" ||
    unavailableAudit ||
    caseState.safetyLocked === true ||
    Boolean(caseState.lastError)
  ) {
    return profile("L2", uniqueReasons([
      ...(gate?.missingItems || []),
      unavailableAudit ? "自动审方本次不可用，不能等同于无风险" : undefined,
      caseState.safetyLocked ? "当前结果处于安全锁定状态" : undefined,
      caseState.lastError ? `${caseState.lastError.phase.toUpperCase()} 阶段未完整完成` : undefined,
    ]));
  }

  const generalReasons = uniqueReasons([
    ...(gate?.advisories || []),
    revision?.auditResult === "REMIND" || revision?.auditResult === "MANUAL_REVIEW"
      ? "审方提示需医生或药师复核"
      : undefined,
  ]);
  if (generalReasons.length > 0) return profile("L1", generalReasons);

  return profile("L0", ["当前确定性安全层未识别额外警示；仍需医生最终确认"]);
}
