import type { CaseState } from "./diagnosis-types";
import { gateDispositionIsAdvisory } from "./diagnosis-safety";
import { INTERNAL_EVIDENCE_PLACEHOLDER } from "./customer-evidence";

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

/**
 * L0–L4 是内部枚举，医生可见位置一律用中文标签（甲方评测 2026-08-04 第 1 条；
 * 2026-08-25 审查发现页面「药味警示汇总」条仍直印枚举——词表只扫 Markdown 流，
 * 管不到 JSX 字面量，故导出单一谓词供 JSX 引用）。
 */
export function warningLevelClinicianLabel(level: ClinicalWarningLevel): string {
  return LABELS[level];
}

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

/**
 * L4 确定性阻断的**单一判据**。
 *
 * 此前药味级与病例级各写一条正则，只差 `严禁|禁止使用` 两个词——而这两个词恰恰是
 * 最直白的禁用表述。实测同一句风险语：
 *   「本品严禁与含乌头类药材同用」 药味级 L4（阻断） / 病例级 **L0（常规信息，仅展示）**
 *   「禁止使用于孕妇」             药味级 L4         / 病例级 **L0**
 *   「配伍禁忌：十八反」「风险等级 CRITICAL」两级一致（L4/L4）
 * 差 4 个档位：一条明确的禁用语在病例级被当成常规信息。
 * 两条正则是包含关系（病例级 ⊂ 药味级），收敛到药味级那份，方向只增不减。
 */
const L4_DETERMINISTIC_BLOCKING = /(?:十八反|十九畏|配伍禁忌|绝对禁忌|严禁|禁止使用|审方结论.{0,12}(?:BLOCK|阻断)|风险等级.{0,8}CRITICAL)/i;

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

  const blocking = activeRiskLine(combined, L4_DETERMINISTIC_BLOCKING);
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
  // 内部占位符走 customer-evidence 的唯一一份词表，不在这里另写一份同义词。
  // 原来这里自写的那份少收 6 个（内部证据缺口/检索失败/未配置/来源机构未明/年份未明/摘要未提供），
  // 其中「内部证据缺口」就是 INSUFFICIENT_EVIDENCE_REF.source——证据最弱的一档被判成 L0 常规信息，
  // 与《伤寒论》这类真引用无法区分。两处词表各写各的，是本项目反复出现的形状。
  const missingEvidence = !evidence ||
    /(?:待补证|未核验|暂无|—|--)/.test(evidence) ||
    INTERNAL_EVIDENCE_PLACEHOLDER.test(evidence);
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

  const blockingLine = activeRiskLine(combined, L4_DETERMINISTIC_BLOCKING);
  if (revision?.auditResult === "BLOCK" || revision?.highestRiskLevel === "CRITICAL" || blockingLine) {
    return profile("L4", uniqueReasons([
      revision?.auditResult === "BLOCK" ? "处方审方结论为阻断" : undefined,
      revision?.highestRiskLevel === "CRITICAL" ? "处方命中严重级别风险" : undefined,
      blockingLine,
    ]), false);
  }

  if (gate?.status === "red_flag") {
    // advise 档（默认）：红旗保持 L3 警示级别与全部理由，但候选仍可执行/可导出——
    // 处置改「提示不拦截」后，导出报告删除 M04 段等于把服务端刚生成的结果又藏起来。
    if (gateDispositionIsAdvisory()) {
      return profile("L3", uniqueReasons([
        ...gate.redFlags,
        ...gate.reasons,
        "存在未解除的急危重风险提示：请优先完成急诊/转诊评估，候选方药仅供处置后参考，采纳须医生确认并经审方复核",
      ]), true);
    }
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
