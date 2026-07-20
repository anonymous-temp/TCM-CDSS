type AuditAdvisory = {
  available: boolean;
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
  const concreteRiskPattern = /慎用|禁忌|相互作用|ADR|不良反应|过敏|肝肾|出血|妊娠|哺乳|儿童|老年|毒性|当前用药未知|无法评估|减量|替换|停药|转诊|强提示|一般提示|信息不足提示/;
  const noRiskPattern = /未见明显|未发现|暂无|无明确|无特殊/;
  const onlyNoRisk = noRiskPattern.test(text) && !concreteRiskPattern.test(text);
  if (onlyNoRisk) return false;
  return concreteRiskPattern.test(text) || /需确认|需复核/.test(text);
}

export function resolveAuditReviewPresentation(
  advisory: AuditAdvisory | null | undefined,
  content?: string,
): AuditReviewPresentation | null {
  if (advisory?.available === false) {
    return {
      kind: "unavailable",
      title: "合理用药审查 · 本次未完成",
      subtitle: "当前结果不能视为已完成合理用药审查",
    };
  }
  const hasIssues = hasMeaningfulMedicationRisk(content) ||
    /\|\s*(?:强提示|一般提示|信息不足提示)\s*\|/.test(content || "");
  if (!hasIssues) return null;
  return {
    kind: "risk",
    title: "合理用药审查 · 发现风险提示",
    subtitle: "按审查问题 ID 逐条复核",
  };
}

function hasRecordedValue(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.trim().length > 0;
  return value != null;
}

function hasRecordedVitals(vitals: Record<string, unknown> | undefined): boolean {
  return Boolean(vitals && Object.values(vitals).some(hasRecordedValue));
}

function presentHistory(context: MedicineCandidateContext): string {
  const symptoms = context.symptoms || {};
  return clean(context.hisRecord?.fields?.xianbingshi) ||
    clean(symptoms.presentHistory) ||
    clean(symptoms.xianbingshi) ||
    clean(symptoms.history);
}

export function buildMedicineCandidateEmptyState(context: MedicineCandidateContext): {
  headline: string;
  explanation: string;
  action: string;
  missingFacts: string[];
} {
  const missingFacts = [
    !(typeof context.patient?.age === "number" && Number.isFinite(context.patient.age)) || !clean(context.patient?.sex)
      ? "年龄/生理状态"
      : "",
    !presentHistory(context) ? "现病史与伴随症状" : "",
    !hasRecordedVitals(context.vitals) ? "生命体征" : "",
    !clean(context.pastHistory) ? "既往史" : "",
    !clean(context.allergyHistory) ? "过敏史" : "",
    !clean(context.medicationHistory) ? "当前用药" : "",
  ].filter(Boolean);
  return {
    headline: "本次没有形成可安全展示的具体候选药物",
    explanation: "系统只展示适应证、用法用量边界及来源均可核验的西药/中成药候选；本次没有条目同时满足这些条件，不会为了填满栏目生成具体药名。",
    action: missingFacts.length > 0
      ? `如需重新评估，请先补充${missingFacts.join("、")}，然后重新分析。`
      : "如需重新评估，请补充诊断分型所需信息或检查结果后重新分析。",
    missingFacts,
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

function uniqueText(items: string[]): string[] {
  return [...new Set(items.map((item) => clean(item)).filter(Boolean))];
}

export function buildTieredSuggestedChecks(
  context: ClinicalDisplayContext,
  checks: string[],
): string[] {
  const normalizedChecks = uniqueText(checks);
  if (context.safetyGate?.status === "red_flag") return normalizedChecks;

  const sparseAssessment = !presentHistory(context) ||
    !hasRecordedVitals(context.vitals) ||
    !(typeof context.patient?.age === "number" && Number.isFinite(context.patient.age));
  if (!sparseAssessment) return normalizedChecks;

  const hasAdvancedTesting = normalizedChecks.some((item) =>
    /\bCT\b|MRI|磁共振|增强扫描|经颅多普勒|TCD|血管造影|CTA|MRA/i.test(item));
  const hasOtherTesting = normalizedChecks.some((item) =>
    !/\bCT\b|MRI|磁共振|增强扫描|经颅多普勒|TCD|血管造影|CTA|MRA/i.test(item));
  return [
    "先补充病程、诱因、伴随症状及既往史，测量生命体征并完成神经系统查体。",
    ...(hasAdvancedTesting
      ? ["若出现红旗表现或神经系统查体异常，再由接诊医生评估是否需要针对性影像学检查。"]
      : []),
    ...(hasOtherTesting
      ? ["其余检验检查应根据补充问诊和查体后的鉴别方向选择，不作无差别筛查。"]
      : []),
  ];
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
