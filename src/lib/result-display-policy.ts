type AuditAdvisory = {
  available: boolean;
  presentationDisabled?: boolean;
};

export type AuditReviewPresentation = {
  kind: "risk" | "unavailable";
  title: string;
  subtitle: string;
};

type MedicineCandidateContext = {
  patient?: { age?: number; sex?: string };
  chiefComplaint?: string;
  symptoms?: Record<string, unknown>;
  vitals?: Record<string, unknown>;
  pastHistory?: string;
  allergyHistory?: string;
  medicationHistory?: string;
  safetyGate?: { status?: "ready" | "needs_information" | "red_flag" };
  hisRecord?: {
    fields?: {
      xianbingshi?: string;
    };
  };
};

type ClinicalDisplayContext = MedicineCandidateContext;

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function hasMeaningfulMedicationRisk(section?: string): boolean {
  const text = clean(section).replace(/\s+/g, "");
  if (!text || text === "暂无" || text === "待生成") return false;
  const concreteRiskPattern = /慎用|禁忌|相互作用|ADR|不良反应|过敏|肝肾|出血|妊娠|哺乳|儿童|老年|毒性|当前用药未知|无法评估|减量|替换|停药|转诊|强提示|一般提示|信息不足提示|待补充信息后再评估/;
  const noRiskPattern = /未见明显|未发现|暂无|无明确|无特殊/;
  const onlyNoRisk = noRiskPattern.test(text) && !concreteRiskPattern.test(text);
  if (onlyNoRisk) return false;
  return concreteRiskPattern.test(text) || /需确认|需复核/.test(text);
}

export function resolveAuditReviewPresentation(
  advisory: AuditAdvisory | null | undefined,
  content?: string,
): AuditReviewPresentation | null {
  // 审方展示被关闭时不出任何审方卡片:此时没有「未完成」可言,审方在它自己的接口与页面里。
  if (advisory?.presentationDisabled) return null;
  if (advisory?.available === false) {
    return {
      kind: "unavailable",
      title: "合理用药审查 · 本次未完成",
      subtitle: "当前结果不能视为已完成合理用药审查",
    };
  }
  const hasIssues = hasMeaningfulMedicationRisk(content) ||
    /\|\s*(?:强提示|一般提示|信息不足提示|待补充信息后再评估)\s*\|/.test(content || "");
  if (!hasIssues) return null;
  return {
    kind: "risk",
    title: "合理用药审查 · 发现风险提示",
    subtitle: "按审查问题 ID 逐条复核",
  };
}

export function herbCaseMeaning(herb: {
  function?: string;
  prescriptionRole?: string;
}): string {
  const functionText = clean(herb.function).replace(/[；;。]+$/g, "");
  const prescriptionRole = clean(herb.prescriptionRole).replace(/[；;。]+$/g, "");
  if (!functionText) return prescriptionRole;
  if (!prescriptionRole || functionText.includes(prescriptionRole)) return functionText;
  if (prescriptionRole.includes(functionText)) return prescriptionRole;
  return `${functionText}；${prescriptionRole}`;
}

function reasoningFingerprint(value: string): string {
  return value.normalize("NFKC").replace(/[\s，,。.；;：:（）()、"'“”‘’]/g, "");
}

/** A rationale must add an explanatory link, not merely repeat the fact list in sentence form. */
export function isNonRedundantClinicalRationale(rationale: string, supportingFacts: readonly string[]): boolean {
  const reasoning = reasoningFingerprint(rationale);
  if (reasoning.length < 8) return false;
  const facts = supportingFacts.map(reasoningFingerprint).filter(Boolean);
  if (facts.some((fact) => fact === reasoning || fact.includes(reasoning))) return false;
  const copiedLength = facts.reduce((total, fact) => total + (reasoning.includes(fact) ? fact.length : 0), 0);
  const hasInferenceLink = /(?:提示|支持|符合|考虑|因而|故|结合|但|尚不能|不支持|区别于|排除)/.test(rationale);
  return hasInferenceLink && copiedLength / reasoning.length < 0.8;
}

export function safeDietAdviceForDisplay(
  advice: string,
  context: ClinicalDisplayContext,
): string {
  const text = clean(advice);
  if (!text) return text;
  const therapeuticFoodClaim = /多食|宜多食|食疗|药膳|活血化瘀|补气(?:血)?|滋阴|温阳|清热解毒|祛湿|安神(?:助眠)?|软坚散结/.test(text);
  if (!therapeuticFoodClaim) return text;
  const needsIndividualReview = !clean(context.allergyHistory) || !clean(context.medicationHistory);
  if (!needsIndividualReview) {
    return "保持规律、均衡饮食和充足饮水；不要把食疗替代诊疗或药物。具体饮食调整请由接诊医生结合基础病、过敏史和当前用药确认。";
  }
  return "保持规律、均衡饮食和充足饮水；不要把食疗替代诊疗或药物。存在基础病、过敏或正在用药时，具体饮食调整请由接诊医生结合实际情况确认。";
}

/**
 * 「本系统据以核对药材/方剂的那套标准数据」的对外说法。
 *
 * 医生要知道的是"这条信息有标准依据、不是模型现编的"，不是我们内部管它叫什么。
 */
export const GOVERNED_HERB_DATA_LABEL = "标准药材资料";
export const GOVERNED_FORMULA_DATA_LABEL = "标准方剂资料";
