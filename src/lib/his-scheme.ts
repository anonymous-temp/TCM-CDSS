import { derivePrescriptionPermission, deriveSafetyLocked, detectProgrammaticRedFlags, evaluateSafetyGate, hasCurrentRiskLine, isNonDosePrescriptionText, withSafetyGate } from "./diagnosis-safety";
import { sectionTitleGroup } from "./cdss-vocab";
import type { CaseState, SafetyGate } from "./diagnosis-types";
import { extractPrescribedHerbs, getTcmHerbDoseLimit, clinicianDoseHerbClass } from "./tcm-knowledge";
import { diagnoseReasoningFromState, mergeReasoningStages, prescribeReasoningFromState } from "./diagnosis-parse";
import { isValidEditedHerbDose } from "./prescription-revision";
import { prescriptionRegimenFromDecoction, type PrescriptionRegimenDto } from "./prescription-regimen-contract";
import { customerEvidenceDisplayStatus } from "./customer-evidence";
import { resolveFormulaSources } from "./tcm-formula-provenance";
import { sourceAllowed, type EvidenceScope } from "./evidence-source-validation";
import { compileTcmTreatmentRecommendations } from "./tcm-treatment-capabilities.server";
import { isKnownTcmTreatmentProjectCode } from "./tcm-treatment-projects";
import { lineageLabel } from "./tcm-lineages";
import { classifyHerbWarning, deriveCaseWarningProfile, warningLevelRank, type ClinicalWarningLevel } from "./clinical-warning-tier";

type SchemeStatus = "ready" | "pending" | "limited";

type EvidenceRef = {
  source: string;
  title?: string;
  year?: string;
  quote?: string;
  url?: string;
};

type AdoptableItem = {
  id: string;
  title: string;
  content: string;
  evidence?: string;
  reference?: string;
  adoptable: boolean;
  referenceOnly?: boolean;
  blockedReason?: string;
};

export type HisAiSchemePayload = {
  schemaVersion: "tcm-cdss-his-ai-scheme-v1";
  module: "tcm_cdss";
  targetContainer: "Ai 诊疗支持方案";
  caseId: string;
  generatedAt: string;
  status: SchemeStatus;
  candidateStatus: "valid" | "limited" | "invalid";
  auditStatus: "pass" | "alert" | "unavailable" | "not_submitted";
  workflowPermission: "continue";
  reviewRequired: boolean;
  warningProfile: {
    level: ClinicalWarningLevel;
    label: string;
    action: "display_only" | "acknowledge" | "reason_required" | "non_executable";
    executable: boolean;
    reasons: string[];
    exportMode: "full_advisory_report" | "non_dose_risk_report";
  };
  lastWarningAcknowledgement?: {
    warningLevel: "L2" | "L3" | "L4";
    acknowledgedAt: string;
    reportFingerprint: string;
    exportMode: "full_advisory_report" | "non_dose_risk_report";
    reasonRecorded: boolean;
  };
  redFlag: {
    label: "低风险" | "需关注" | "高风险" | "待评估";
    description: string;
    redFlags: string[];
  };
  safetyGate: SafetyGate;
  prescriptionRevision?: {
    herbHash: string;
    auditedAt: string;
    auditResult: string;
    highestRiskLevel: string;
  };
  aiMedicalRecord: {
    chiefComplaint: string;
    presentHistory?: string;
    pastHistory?: string;
    allergyHistory?: string;
    medicationHistory?: string;
    tcmFourDiagnosis?: string;
    tcmLineagePreference?: string;
    vitals?: string;
  };
  diagnoses: {
    western: AdoptableItem[];
    tcmPatterns: AdoptableItem[];
    mechanism: AdoptableItem[];
  };
  prescriptions: {
    herbal: AdoptableItem[];
    structuredHerbs: Array<{
      itemNo: number;
      name: string;
      processing?: string;
      dose: string;
      role: string;
      prescriptionRole: string;
      targetKind?: string;
      targetRef?: string;
      targetPathogenesis: string;
      function: string;
      decoctionRequirement?: string;
      verificationTier: "verified" | "unverified_dose" | "identity_pending" | "toxic_regulated";
      warningLevel: ClinicalWarningLevel;
      verificationLabel: string;
      verificationReasons: string[];
      doseSource: "governed_boundary" | "classical_source" | "none";
    }>;
    westernOrPatent: AdoptableItem[];
    regimen: PrescriptionRegimenDto | null;
  };
  treatments: {
    tcmProjects: Array<{
      projectCode: string;
      projectName: string;
      availability: "clinic_available" | "referral_only";
      targetPathogenesis: string;
      assessmentPositioning?: string;
      protocolStatus: "governed_patient_specific_plan" | "assessment_only_no_patient_specific_protocol";
      protocolGap?: string;
      treatmentContent: string;
      suggestedSitesOrPoints: string[];
      scheduleSuggestion: string;
      techniqueBoundary: string;
      protocolSource: string;
      operatorRequirement: string;
      requiredChecks: string[];
      riskLevel: "low" | "moderate" | "specialist";
      recommendationMode: "clinician_assessment" | "referral_assessment" | "specialist_assessment_only";
      containsMedication: boolean;
      requiresMedicationAudit: boolean;
      adoptable: false;
      clinicianReviewRequired: true;
    }>;
  };
  checks: AdoptableItem[];
  followup: AdoptableItem[];
  riskTips: AdoptableItem[];
  references: EvidenceRef[];
    writeBackPolicy: {
      allowSingleItemAdoption: boolean;
      allowOneClickAdoption: boolean;
      doctorReviewRequired: boolean;
      pharmacistReviewRequired: boolean;
      overrideReasonRequired: boolean;
      warningConfirmationMode: "none" | "checkbox" | "checkbox_and_reason" | "blocked";
      warningAcknowledgementRequired: boolean;
      warningReasonRequired: boolean;
      finalPrescriptionReleaseAllowed: false;
      autoWriteDiagnosis: false;
      autoWritePrescription: false;
  };
};

function section(text: string | undefined, titles: string[]): string {
  if (!text) return "";
  const escaped = titles.map((title) => title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const match = new RegExp(`^##\\s*(?:${escaped})\\s*(?:[：:]\\s*([^\\n]+))?\\s*$`, "im").exec(text);
  if (!match) return "";
  const start = match.index + match[0].length;
  const rest = text.slice(start).replace(/^\s*\n/, "");
  const next = rest.search(/^##\s+/m);
  return [match[1]?.trim(), (next === -1 ? rest : rest.slice(0, next)).trim()].filter(Boolean).join("\n").trim();
}

function normalizeQuotePairs(value: string): string {
  // 源病历录入常见的引号错配（“剖宫产术" / “股骨骨折‘）：中文开引号被英文引号或单引号
  // “闭合”，透传到 HIS 病历/警示字段就是甲方反馈的“残缺标点”。仅在存在未闭合的中文
  // 开引号时，把下一个任意引号字符归一为中文闭引号；本就配平的文本逐字保留。
  let open = false;
  let out = "";
  for (const ch of value) {
    if (ch === "“") { open = true; out += ch; continue; }
    if (open && (ch === "”" || ch === '"' || ch === "'" || ch === "‘" || ch === "’")) {
      open = false;
      out += "”";
      continue;
    }
    out += ch;
  }
  return out;
}

function recordText(value: string | undefined): string | undefined {
  return typeof value === "string" && value ? normalizeQuotePairs(value) : value;
}

function clean(value: string | undefined): string {
  return normalizeQuotePairs((value || "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/(?:《?中华人民共和国药典》?|中国药典)[^|；。\n]{0,30}2020[^|；。\n]*/g, "历史药典规则基线（不作为现行药典核验结论）")
    .replace(/\*\*/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim());
}

function firstLine(value: string | undefined): string {
  return clean(value).split("\n").map((line) => line.replace(/^#{1,6}\s*/, "").replace(/^[-*]\s*/, "").trim()).find(Boolean) || "";
}

function extractField(text: string | undefined, labels: string[]): string {
  if (!text) return "";
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const patterns = [
      new RegExp(`\\*\\*${escaped}\\*\\*\\s*[：:]\\s*([^\\n|]+)`),
      new RegExp(`^\\s*[-*]?\\s*${escaped}\\s*[：:]\\s*([^\\n|]+)`, "m"),
      new RegExp(`\\|\\s*${escaped}\\s*\\|\\s*([^|\\n]+)\\|`),
    ];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match?.[1]?.trim()) return clean(match[1]);
    }
  }
  return "";
}

function isPlaceholderContent(content: string): boolean {
  // 安全降级的非剂量正文不是可采纳内容。判定短语与正文同源维护在 diagnosis-safety.ts，
  // 否则一次措辞改写就会让 HIS 把“当前不展示包含具体用量的候选方药”当成可写回的中药饮片处方。
  return !clean(content) || isNonDosePrescriptionText(content) ||
    /(待生成|暂不生成|信息不足|高风险安全建议模式|信息不足建议模式|不生成候选|未满足剂量级候选处方安全门控)/.test(content);
}

function item(
  id: string,
  title: string,
  content: string,
  opts?: { evidence?: string; reference?: string; adoptable?: boolean; referenceOnly?: boolean; blockedReason?: string; safetyLocked?: boolean },
): AdoptableItem {
  const placeholder = isPlaceholderContent(content);
  const safetyLocked = opts?.safetyLocked === true;
  const adoptable = safetyLocked ? false : opts?.adoptable ?? (!placeholder && Boolean(clean(content)));
  const blockedReason = safetyLocked
    ? (opts?.blockedReason || "当前方案已被确定性安全锁定，需医生/药师人工复核后再处理")
    : placeholder
      ? (opts?.blockedReason || "当前内容尚未形成可采纳结论")
      : adoptable
        ? undefined
        : opts?.blockedReason;
  return {
    id,
    title,
    content: clean(content),
    evidence: opts?.evidence ? clean(opts.evidence) : undefined,
    reference: opts?.reference ? clean(opts.reference) : undefined,
    adoptable: placeholder ? false : adoptable,
    referenceOnly: opts?.referenceOnly,
    blockedReason,
  };
}

function hasTruncatedOutput(...texts: Array<string | undefined>): boolean {
  return /内容已按(?:接口预算|模型上下文预算)截断/.test(texts.filter(Boolean).join("\n"));
}

function redFlagStatus(caseState: CaseState, gate: SafetyGate): {
  label: HisAiSchemePayload["redFlag"]["label"];
  description: string;
} {
  const redFlags = gate.redFlags.length > 0 ? gate.redFlags : detectProgrammaticRedFlags(caseState);
  if (redFlags.length > 0) {
    return { label: "高风险", description: redFlags[0] || gate.reasons[0] || "当前资料提示需优先处理的急危重症风险" };
  }
  if ((gate.advisories || []).length > 0) {
    return { label: "需关注", description: gate.advisories?.[0] || "当前信息提示需优先复核的临床线索" };
  }
  if (gate.status === "needs_information") {
    return { label: "需关注", description: gate.reasons[0] || `需补充：${gate.missingItems.join("、")}` };
  }
  return { label: "低风险", description: "当前资料未识别明确急危重症风险；仍需由医生结合现场情况复核" };
}

type StructuredEvidence = { evidenceLevel?: string; source?: string; confidence?: string };

const TRUSTED_STRUCTURED_REFERENCE = /\[(?:EVID-(?:GUIDE|INST|PAPER)-\d{3}|OFFICIAL-[A-Z0-9_-]+(?:-\d+)?)\]/i;

function trustedStructuredEvidenceText(
  evidence: StructuredEvidence | null | undefined,
  scope?: EvidenceScope,
): string | undefined {
  if (!scope) return undefined;
  if (customerEvidenceDisplayStatus(evidence) !== "traceable") return undefined;
  const source = clean(evidence?.source);
  if (!source || !TRUSTED_STRUCTURED_REFERENCE.test(source)) return undefined;
  if (/(?:中国药典|药典).{0,12}2020|2020.{0,12}(?:中国药典|药典)/.test(source)) return undefined;
  if (!sourceAllowed(source, evidence?.evidenceLevel, scope)) return undefined;
  return source;
}

function structuredEvidenceReferences(caseState: CaseState, scope?: EvidenceScope, includePrescription = true): EvidenceRef[] {
  const reasoning = mergeReasoningStages(
    diagnoseReasoningFromState(caseState),
    prescribeReasoningFromState(caseState),
  ) || caseState.reasoningV2;
  if (!reasoning) return [];
  const evidenceItems: Array<StructuredEvidence | null | undefined> = [
    reasoning.overview?.evidence,
    reasoning.westernDiagnosis?.primary?.evidence,
    reasoning.pathogenesis?.locationDifferentiation?.evidence,
    reasoning.pathogenesis?.natureDifferentiation?.evidence,
    ...(reasoning.pathogenesis?.chain || []).map((item) => item.evidence),
    ...(reasoning.therapy?.subTherapies || []).map((item) => item.evidence),
    ...(includePrescription ? (reasoning.formula?.candidates || []).flatMap((candidate) => (candidate.herbs || []).map((herb) => herb.evidence)) : []),
    ...(includePrescription ? (reasoning.formula?.patentAndWestern || []).map((item) => item.evidence) : []),
  ];
  const refs = new Map<string, EvidenceRef>();
  for (const evidence of evidenceItems) {
    const sourceText = trustedStructuredEvidenceText(evidence, scope);
    if (!sourceText) continue;
    for (const source of sourceText.split(/\n+/).map((item) => item.trim()).filter(Boolean)) {
      if (!TRUSTED_STRUCTURED_REFERENCE.test(source)) continue;
      const url = source.match(/https?:\/\/[^\s)）\]】]+/)?.[0];
      const title = source
        .replace(url || "", "")
        .replace(/^\[(?:EVID|OFFICIAL)-[^\]]+\]\s*/, "")
        .replace(/[｜|；;，,：:]\s*$/, "")
        .trim() || source;
      const key = `${title}|${url || ""}`;
      if (!refs.has(key)) refs.set(key, {
        source: /^\[EVID-/.test(source) ? "EviMed" : (evidence?.evidenceLevel || "临床资料"),
        title,
        ...(url ? { url } : {}),
      });
    }
  }
  const candidate = includePrescription ? structuredCandidate(caseState) : undefined;
  if (candidate) {
    for (const formula of resolveFormulaSources(candidate.name, candidate.herbs)) {
      const title = `${formula.formulaName}：${formula.source}`;
      const key = `${title}|`;
      if (!refs.has(key)) refs.set(key, { source: "本地方剂知识库", title });
    }
  }
  return [...refs.values()].slice(0, 20);
}

function verifiedFormulaReference(caseState: CaseState): string | undefined {
  const candidate = structuredCandidate(caseState);
  if (!candidate) return undefined;
  const sources = resolveFormulaSources(candidate.name, candidate.herbs);
  return sources.length > 0
    ? sources.map((item) => `${item.formulaName}：${item.source}`).join("；")
    : undefined;
}

function compact(value: unknown): string | undefined {
  if (value == null || value === "") return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function structuredCandidate(caseState: CaseState) {
  const activeReasoning = prescribeReasoningFromState(caseState) || caseState.reasoningV2;
  return caseState.prescriptionRevision
    ? activeReasoning?.formula?.candidates?.[caseState.prescriptionRevision.candidateIndex]
    : activeReasoning?.formula?.candidates?.find((candidate) => candidate.herbs.length > 0);
}

function structuredHerbs(caseState: CaseState) {
  const selected = structuredCandidate(caseState);
  return selected
    ?.herbs
    ?.filter((herb) => herb.name?.trim())
    ?.slice(0, 50) || [];
}

function structuredTcmTreatments(caseState: CaseState) {
  const diagnose = diagnoseReasoningFromState(caseState);
  const prescribe = prescribeReasoningFromState(caseState);
  const proposals = (prescribe?.nonPharma?.tcmTreatments || []).flatMap((item) =>
    isKnownTcmTreatmentProjectCode(item.projectCode) && /^P\d{1,2}$/.test(item.targetRef)
      ? [{ projectCode: item.projectCode, targetRef: item.targetRef }]
      : []
  );
  return compileTcmTreatmentRecommendations(proposals, diagnose, caseState);
}

function structuredHerbalSection(caseState: CaseState): string {
  const candidate = structuredCandidate(caseState);
  const herbs = candidate?.herbs?.filter((herb) => herb.name?.trim()).slice(0, 50) || [];
  if (!candidate || herbs.length === 0) return "";
  const regimen = prescriptionRegimenFromDecoction(candidate.decoction);
  const formulaEvidenceStatus = customerEvidenceDisplayStatus(candidate.formulaSource);
  const doseSourceConflictHerbs = herbs
    .filter((herb) => getTcmHerbDoseLimit(herb.name)?.sourceConflict)
    .map((herb) => clean(herb.name));
  const rows = herbs.map((herb, index) => [
    `| ${index + 1} | ${clean(herb.name)} | ${clean(herb.dose || "待医生确认")} | ${clean(herb.role || "待复核")} | ${clean([herb.processing ? `炮制：${herb.processing}` : "", herb.decoctionRequirement].filter(Boolean).join("；") || "常规")} |`,
  ].join(""));
  return [
    candidate.name ? `**候选方名/方向**：${clean(candidate.name)}` : "",
    candidate.constructionType === "self_devised"
      ? "**方案类型**：自拟方"
      : candidate.constructionType === "single_herb"
        ? "**方案类型**：单味方案"
        : formulaEvidenceStatus === "traceable"
          ? `**${candidate.formulaSource.evidenceLevel === "kb_entry" ? "方剂资料收载来源" : "经典方出处"}**：${clean(candidate.formulaSource.source)}`
          : "",
    ...(candidate.baseFormulas?.length ? [
      "**原方案基础方与出处**：",
      ...candidate.baseFormulas.map((base) =>
        `- ${clean(base.name)}：${clean(base.source)}；${base.verificationStatus === "verified_individually" ? "逐方已核验" : "原方案来源参考"}；组成匹配 ${base.matchedIngredientCount}/${base.totalIngredientCount || "?"} 味${base.requiredIngredientCount != null ? `；核心药味 ${base.matchedRequiredIngredientCount || 0}/${base.requiredIngredientCount} 味` : ""}${base.minimumPreservedIngredientCount != null ? `；组成下限 ${base.minimumPreservedIngredientCount} 味` : ""}`),
    ] : []),
    candidate.formulaAnalysis ? `**组方解析**：${clean(candidate.formulaAnalysis)}` : "",
    "| 序号 | 药名 | 剂量 | 角色 | 煎服要求 |",
    "|---|---|---|---|---|",
    ...rows,
    ...(doseSourceConflictHerbs.length ? [
      "",
      `**分用途剂量复核**：${doseSourceConflictHerbs.join("、")}在本地历史规则中存在不同用途或途径的剂量范围；当前候选采用保守主范围，正式采纳前须由药师结合实际饮片、用途、给药途径及现行规则复核。`,
    ] : []),
    ...(regimen ? [
      "",
      `**剂数/疗程**：${regimen.doseCount} / ${regimen.course}（每日${regimen.dosesPerDay}剂）`,
      `**服法**：${clean(regimen.administration)}`,
      `**复诊节点**：${clean(regimen.followUpNode)}`,
    ] : []),
    "",
    "**一致性说明**：HIS 展示、医生复核与自动审方使用同一份药味和疗程方案。",
  ].filter(Boolean).join("\n");
}

function normalizedHerbName(value: string): string {
  return clean(value).replace(/[炙炒制生酒醋蜜盐姜]?(.+)/, "$1").trim();
}

function markdownV2HerbMismatch(markdownHerbal: string, caseState: CaseState): boolean {
  const markdownText = clean(markdownHerbal);
  const structuredNamePairs = structuredHerbs(caseState)
    .map((herb) => ({ raw: clean(herb.name), normalized: normalizedHerbName(herb.name) }))
    .filter((herb) => herb.raw || herb.normalized);
  const structuredNames = new Set(structuredNamePairs.map((herb) => herb.normalized || herb.raw).filter(Boolean));
  if (structuredNames.size === 0 || !markdownText) return false;
  const markdownHerbs = extractPrescribedHerbs(markdownHerbal).map((herb) => normalizedHerbName(herb.name)).filter(Boolean);
  if (markdownHerbs.length === 0 && !isPlaceholderContent(markdownHerbal)) return true;
  const missingStructuredName = structuredNamePairs.some((herb) =>
    !markdownText.includes(herb.raw) && !markdownText.includes(herb.normalized)
  );
  return missingStructuredName || markdownHerbs.some((name) => !structuredNames.has(name));
}

function hasConcreteWesternOrPatentMedication(medicine: string): boolean {
  const text = clean(medicine);
  if (!text || isPlaceholderContent(text)) return false;
  return /(片|胶囊|颗粒|丸|口服液|注射液|滴丸|mg|ml|tid|bid|qd|qn|每日|每次|用法用量|阿司匹林|氯吡格雷|华法林|二甲双胍|胰岛素|氨氯地平|美托洛尔|阿莫西林|头孢|布洛芬|对乙酰氨基酚|复方丹参|藿香正气|逍遥丸|六味地黄丸)/i.test(text);
}

function hasStrongPrescriptionRisk(...texts: string[]): boolean {
  const strongCue = /(强提示|(?<!最)高风险|禁用|禁忌|不宜|避免使用|十八反|十九畏|相互作用|当前用药冲突|同类互斥|特殊人群.*慎用|特殊人群.*禁用|剂量.*超|ADR.*高|转诊建议\s*[：:]\s*需要|确定性审方未完成|确定性处方风险复核未完成|风险复核失败)/;
  return hasCurrentRiskLine(texts.filter(Boolean).join("\n"), strongCue);
}

function missingMedicationAuditSection(): string {
  return [
    "## 合理用药审方",
    "**审方服务状态**：本次未获得自动审方结果。",
    "**处置建议**：当前不能等同为无用药风险，请医生或药师人工复核；该提示不阻断诊疗流程。",
  ].join("\n");
}


/**
 * 无法定数值剂量边界的成分在处方里的核验级别。
 *
 * 系统不再因它们否决整方（甲方决策：降低门禁、审方兜底），但也绝不把它们与有药典边界的
 * 药味等同呈现——责任是移交而不是消失：管制毒性与法律禁用动物药按最高级别标注并要求
 * 医师按监管要求单独处理；其余标为待核验剂量，提示用量由医师确定。
 */
function clinicianDoseTier(name: unknown): "toxic_regulated" | "unverified_dose" | undefined {
  const herbName = typeof name === "string" ? name.trim() : "";
  if (!herbName) return undefined;
  const clinicianClass = clinicianDoseHerbClass(herbName);
  if (!clinicianClass) return undefined;
  return clinicianClass === "controlled_or_toxic" || clinicianClass === "endangered_or_banned"
    ? "toxic_regulated"
    : "unverified_dose";
}

export function buildHisAiSchemePayload(caseState: CaseState, evidenceScope?: EvidenceScope): HisAiSchemePayload {
  const normalizedState = withSafetyGate(caseState);
  const gate = evaluateSafetyGate(normalizedState);
  caseState = normalizedState;
  const permission = derivePrescriptionPermission(caseState);
  const suppressDoseLevelOutputs = permission.candidateMode === "non_dose_only" || permission.candidateMode === "blocked";
  const warningProfile = deriveCaseWarningProfile(caseState);
  const diagnosis = caseState.diagnosis || "";
  const prescription = suppressDoseLevelOutputs ? "" : caseState.prescription || "";
  const risk = caseState.riskAssessment || "";
  const deterministicRiskFromAssessment = suppressDoseLevelOutputs ? "" : section(risk, sectionTitleGroup("lingxiAudit"));
  const hasPrescriptionCandidate = Boolean(clean(prescription)) && !isPlaceholderContent(prescription);
  const deterministicRisk = deterministicRiskFromAssessment || (hasPrescriptionCandidate ? missingMedicationAuditSection() : "");
  const western = section(diagnosis, sectionTitleGroup("westernDiagnosis"));
  const tcmPattern = section(diagnosis, sectionTitleGroup("tcmPattern"));
  const mechanism = [
    section(diagnosis, sectionTitleGroup("mechanismOverall")),
    section(diagnosis, sectionTitleGroup("mechanismSub")),
    section(diagnosis, sectionTitleGroup("therapyFrame")),
  ].filter(Boolean).join("\n\n");
  const markdownHerbal = suppressDoseLevelOutputs ? "" : section(prescription, sectionTitleGroup("herbalPrescription"));
  const v2Herbal = suppressDoseLevelOutputs ? "" : structuredHerbalSection(caseState);
  const herbal = v2Herbal || markdownHerbal;
  const medicine = suppressDoseLevelOutputs ? "" : section(prescription, sectionTitleGroup("westernOrPatent"));
  const diagnoseReasoning = diagnoseReasoningFromState(caseState);
  const prescribeReasoning = suppressDoseLevelOutputs ? undefined : prescribeReasoningFromState(caseState);
  const activeReasoning = mergeReasoningStages(diagnoseReasoning, prescribeReasoning) || caseState.reasoningV2;
  const westernStructuredReference = trustedStructuredEvidenceText(activeReasoning?.westernDiagnosis?.primary?.evidence, evidenceScope);
  const tcmStructuredReference = trustedStructuredEvidenceText(activeReasoning?.overview?.evidence, evidenceScope);
  const herbalStructuredReference = suppressDoseLevelOutputs ? undefined : verifiedFormulaReference(caseState);
  const westernStructuredFacts = activeReasoning?.westernDiagnosis?.primary?.supportingFacts?.filter(Boolean).join("；");
  const tcmStructuredFacts = activeReasoning?.pathogenesis?.chain
    .map((item) => [item.patientFact, item.syndromeEvidence].filter(Boolean).join(" → "))
    .filter(Boolean)
    .join("；");
  const contentMismatch = suppressDoseLevelOutputs ? false : markdownV2HerbMismatch(markdownHerbal, caseState);
  const invalidStructuredDose = suppressDoseLevelOutputs ? false : structuredHerbs(caseState).some((herb) => !isValidEditedHerbDose(herb.dose));
  const unauditedConcreteMedicine = hasConcreteWesternOrPatentMedication(medicine);
  const consistencyRisk = [
    contentMismatch
      ? "## 处方一致性校验\n**结论**：处方正文与药味表不一致，HIS 展示已改用药味表；原输出需医生/药师人工复核，不允许写回采纳。"
      : "",
    unauditedConcreteMedicine
      ? "## 处方一致性校验\n**结论**：西药/中成药候选未进入本次中药饮片审方，请按药品说明书、相互作用和院内药事规则人工复核；该提示不阻断诊疗流程。"
      : "",
    invalidStructuredDose
      ? "## 处方一致性校验\n**结论**：药味表存在缺失、非正数或明显超出通用数量级的单次剂量；不得采纳或写回，需医生修正后重新审方。"
      : "",
  ].filter(Boolean).join("\n\n");
  const checks = section(risk, sectionTitleGroup("checks")) || extractField(western, ["建议检查"]);
  const followup = suppressDoseLevelOutputs ? "" : [
    section(risk, sectionTitleGroup("followupPlan")),
    section(risk, sectionTitleGroup("followupTimeline")),
  ].filter(Boolean).join("\n\n");
  const riskTips = suppressDoseLevelOutputs ? [
    "## 急危重风险提示",
    ...gate.redFlags.map((entry) => `- ${clean(entry)}`),
    "**处置建议**：优先完成急诊或转诊评估；当前不提供任何剂量级候选方药、煎服或疗程信息。",
  ].join("\n") : [
    deterministicRisk,
    consistencyRisk,
    section(prescription, sectionTitleGroup("prescriptionRisk")),
    section(risk, sectionTitleGroup("riskSummary")),
    section(risk, sectionTitleGroup("compatibilityRisk")),
    section(risk, sectionTitleGroup("adrRisk")),
    section(risk, sectionTitleGroup("interactionRisk")),
    section(risk, sectionTitleGroup("specialPopulationRisk")),
    section(risk, sectionTitleGroup("redFlag")),
  ].filter(Boolean).join("\n\n");
  const strongPrescriptionRisk = hasStrongPrescriptionRisk(riskTips, prescription, risk);
  const redFlag = redFlagStatus(caseState, gate);
  const hasAllOutputs = Boolean(diagnosis.trim() && prescription.trim() && risk.trim());
  const phaseComplete = caseState.phase === "done" && !caseState.lastError && hasAllOutputs;
  const truncatedOutput = hasTruncatedOutput(diagnosis, prescription, risk);
  const safetyLocked = deriveSafetyLocked(caseState, {
    truncated: truncatedOutput,
    placeholderSource: !v2Herbal && isPlaceholderContent(markdownHerbal || prescription),
    contentMismatch: contentMismatch || unauditedConcreteMedicine || invalidStructuredDose,
  });
  const structurallyInvalid = truncatedOutput
    || contentMismatch
    || unauditedConcreteMedicine
    || invalidStructuredDose
    || (!v2Herbal && isPlaceholderContent(markdownHerbal || prescription));
  const status: SchemeStatus = !hasAllOutputs
    ? "pending"
    : phaseComplete && !truncatedOutput && !safetyLocked
      ? "ready"
      : "limited";
  // Automatic prescription review is advisory. A warning, degraded provider response, or manual
  // review recommendation remains visible in riskTips but cannot by itself lock a structurally
  // valid clinician-reviewed HIS proposal.
  const canAdopt = status === "ready"
    && permission.formalAdoption === "eligible_after_doctor_confirmation"
    && !structurallyInvalid;
  const auditStatus: HisAiSchemePayload["auditStatus"] = caseState.prescriptionRevision?.auditAvailable === false
    ? "unavailable"
    : caseState.prescriptionRevision?.auditAvailable === true
      ? strongPrescriptionRisk || caseState.prescriptionRevision.needManualReview === true ? "alert" : "pass"
      : caseState.auditAdvisory?.available === false
        ? "unavailable"
        : caseState.auditAdvisory?.available === true
          ? strongPrescriptionRisk ? "alert" : "pass"
          : "not_submitted";
  const blockedReason = contentMismatch || unauditedConcreteMedicine || invalidStructuredDose
      ? "处方展示对象与审方对象不一致或存在未审具体用药，需医生/药师人工复核"
    : !phaseComplete
      ? "诊疗链路未完整成功结束，仅允许医生查看已有辅助内容，不允许写回采纳"
    : truncatedOutput
          ? "候选方案生成被截断，内容不完整，不允许写回采纳"
          : strongPrescriptionRisk
              ? "处方存在强风险提示，但不做硬拦截；医嘱与病历写回需由医生在HIS原生流程中逐项确认"
              : "AI诊疗支持方案仅供医生参考，医嘱与病历写回需由医生在HIS原生流程中确认";

  return {
    schemaVersion: "tcm-cdss-his-ai-scheme-v1",
    module: "tcm_cdss",
    targetContainer: "Ai 诊疗支持方案",
    caseId: caseState.hisRecord?.caseId || caseState.id,
    generatedAt: new Date().toISOString(),
    status,
    candidateStatus: structurallyInvalid
      ? "invalid"
      : canAdopt ? "valid" : "limited",
    auditStatus,
    workflowPermission: "continue",
    reviewRequired: true,
    warningProfile: {
      ...warningProfile,
      exportMode: warningProfile.executable ? "full_advisory_report" : "non_dose_risk_report",
    },
    lastWarningAcknowledgement: caseState.warningAcknowledgement ? {
      warningLevel: caseState.warningAcknowledgement.warningLevel,
      acknowledgedAt: caseState.warningAcknowledgement.acknowledgedAt,
      reportFingerprint: caseState.warningAcknowledgement.reportFingerprint,
      exportMode: caseState.warningAcknowledgement.exportMode,
      reasonRecorded: Boolean(caseState.warningAcknowledgement.reason),
    } : undefined,
    redFlag: {
      label: redFlag.label,
      description: redFlag.description,
      redFlags: gate.redFlags,
    },
    safetyGate: gate,
    prescriptionRevision: !suppressDoseLevelOutputs && caseState.prescriptionRevision ? {
      herbHash: caseState.prescriptionRevision.herbHash,
      auditedAt: caseState.prescriptionRevision.auditedAt,
      auditResult: caseState.prescriptionRevision.auditResult,
      highestRiskLevel: caseState.prescriptionRevision.highestRiskLevel,
    } : undefined,
    aiMedicalRecord: {
      chiefComplaint: normalizeQuotePairs(caseState.hisRecord?.fields?.zhushu || caseState.chiefComplaint),
      presentHistory: recordText(caseState.hisRecord?.fields?.xianbingshi),
      pastHistory: recordText(caseState.hisRecord?.fields?.jiwangshi || caseState.pastHistory),
      allergyHistory: recordText(caseState.hisRecord?.fields?.guomin || caseState.allergyHistory),
      medicationHistory: recordText(caseState.hisRecord?.fields?.yongyaoshi || caseState.medicationHistory),
      tcmFourDiagnosis: normalizeQuotePairs([
        caseState.hisRecord?.fields?.tcmFace || caseState.faceNote,
        caseState.hisRecord?.fields?.tcmTongue || caseState.tongue,
        caseState.hisRecord?.fields?.tcmPulse || caseState.pulse,
        caseState.hisRecord?.fields?.tcmDetail,
      ].filter(Boolean).join("；")),
      // 该字段在接口类型里声明了，但此前从未赋值——医生选定的学术流派倾向一路走到 HIS 就成了
      // undefined。写入的是受控卡片的**可读标签**而不是内部代码：caseState.tcmLineagePreference
      // 在 normalizeCaseStateInput 里已被 resolveLineageCode 归一成 classical-formula 这类枚举，
      // 直接回传等于把内部标识符塞进病历文本字段。lineageLabel 做的正是「代码→医生读得懂的名称」。
      // 未选择流派时留空，不要下发 unrestricted 兜底卡的标签冒充医生的选择。
      tcmLineagePreference: caseState.tcmLineagePreference
        ? lineageLabel(caseState.tcmLineagePreference)
        : undefined,
      vitals: [
        caseState.hisRecord?.fields?.vitalsT,
        caseState.hisRecord?.fields?.vitalsP,
        caseState.hisRecord?.fields?.vitalsR,
        caseState.hisRecord?.fields?.vitalsBP,
        caseState.hisRecord?.fields?.vitalsDetail,
      ].filter(Boolean).join("；") || compact(caseState.vitals),
    },
    diagnoses: {
      western: [item("western-1", extractField(western, ["风险/需排除方向", "西医诊断"]) || "西医诊断", western, {
        evidence: westernStructuredFacts,
        reference: westernStructuredReference,
        adoptable: false,
        referenceOnly: true,
        blockedReason: "西医诊断由AI提供医生参考，不允许一键写回正式诊断",
      })],
      tcmPatterns: [item("tcm-pattern-1", extractField(tcmPattern, ["证候诊断", "主证候"]) || "中医证候", tcmPattern, {
        evidence: tcmStructuredFacts,
        reference: tcmStructuredReference,
        adoptable: canAdopt,
        safetyLocked,
        blockedReason,
      })],
      mechanism: [item("mechanism-1", extractField(mechanism, ["核心病机", "总体病机"]) || "证候-病机-治法", mechanism, {
        adoptable: canAdopt,
        safetyLocked,
        blockedReason,
      })],
    },
    prescriptions: {
      herbal: suppressDoseLevelOutputs ? [] : [item("herbal-1", firstLine(herbal) || "中药饮片处方", herbal, {
        reference: herbalStructuredReference,
        adoptable: canAdopt,
        safetyLocked,
        blockedReason,
      })],
      structuredHerbs: suppressDoseLevelOutputs ? [] : structuredHerbs(caseState).map((herb, index) => {
        const doseLimit = getTcmHerbDoseLimit(herb.name);
        const evidence = herb.evidence?.evidenceLevel === "insufficient"
          ? "证据来源待核验"
          : herb.evidence?.source || "";
        const safety = [
          herb.isToxic ? "毒性药味，需复核" : "",
          herb.decoctionRequirement,
          doseLimit?.sourceConflict ? "分用途剂量范围存在冲突，需药师复核" : "",
        ].filter(Boolean).join("；");
        const verification = classifyHerbWarning({
          drug: herb.name,
          dose: herb.dose || "",
          evidence,
          safety,
          verificationTier: herb.verificationTier,
          verificationReasons: herb.verificationReasons,
        });
        return {
          itemNo: index + 1,
          name: clean(herb.name),
          ...(herb.processing ? { processing: clean(herb.processing) } : {}),
          dose: clean(herb.dose || ""),
          role: clean(herb.role),
          prescriptionRole: clean(herb.prescriptionRole),
          ...(herb.targetKind ? { targetKind: herb.targetKind } : {}),
          ...(herb.targetRef ? { targetRef: clean(herb.targetRef) } : {}),
          targetPathogenesis: clean(herb.targetPathogenesis),
          function: clean(herb.function),
          ...(herb.decoctionRequirement ? { decoctionRequirement: clean(herb.decoctionRequirement) } : {}),
          // 「由医师确定用量」类成分（无法定数值边界，甲方 2026-08-01 决策改为不阻断出方）
          // 必须在这里如实分级，否则医生看到的是一张所有药味都同等可信的处方：
          // 管制毒性与法律禁用动物药 → toxic_regulated（告警升级、要求单独处理）；
          // 药典未收载/丸散专用/食材辅料 → unverified_dose（提示用量由医师确定）。
          verificationTier: herb.verificationTier || (
            herb.isToxic
              ? "toxic_regulated"
              : clinicianDoseTier(herb.name) || (
                doseLimit && !doseLimit.sourceConflict
                  ? "verified"
                  : "unverified_dose"
              )
          ),
          warningLevel: verification.level,
          verificationLabel: verification.label,
          verificationReasons: verification.reasons,
          doseSource: herb.doseSource || (doseLimit && !doseLimit.sourceConflict ? "governed_boundary" as const : "none" as const),
        };
      }),
      westernOrPatent: suppressDoseLevelOutputs ? [] : [item("medicine-1", "西药/中成药方案", medicine, {
        adoptable: canAdopt,
        safetyLocked,
        blockedReason,
      })],
      regimen: suppressDoseLevelOutputs ? null : prescriptionRegimenFromDecoction(structuredCandidate(caseState)?.decoction),
    },
    treatments: {
      tcmProjects: suppressDoseLevelOutputs ? [] : structuredTcmTreatments(caseState).map((project) => ({
        projectCode: project.projectCode,
        projectName: project.projectName,
        availability: project.availability,
        targetPathogenesis: project.targetPathogenesis,
        assessmentPositioning: project.assessmentPositioning,
        protocolStatus: project.protocolStatus,
        protocolGap: project.protocolGap,
        treatmentContent: project.treatmentContent,
        suggestedSitesOrPoints: project.suggestedSitesOrPoints,
        scheduleSuggestion: project.scheduleSuggestion,
        techniqueBoundary: project.techniqueBoundary,
        protocolSource: project.protocolSource,
        operatorRequirement: project.operatorRequirement,
        requiredChecks: project.requiredChecks,
        riskLevel: project.riskLevel,
        recommendationMode: project.recommendationMode,
        containsMedication: project.containsMedication,
        requiresMedicationAudit: project.requiresMedicationAudit,
        adoptable: false,
        clinicianReviewRequired: true,
      })),
    },
    checks: [item("check-1", "检验检查建议", checks, { adoptable: canAdopt, safetyLocked, blockedReason })],
    followup: [item("followup-1", "风险随访时间轴", followup, { adoptable: canAdopt, safetyLocked, blockedReason })],
    riskTips: [item("risk-1", redFlag.label === "高风险" ? "高风险提示" : "用药与转诊风险提示", riskTips, {
      adoptable: false,
      blockedReason: "风险提示仅用于展示和医生复核，不作为可直接写回医嘱项",
    })],
    references: structuredEvidenceReferences(caseState, evidenceScope, !suppressDoseLevelOutputs),
    writeBackPolicy: {
      allowSingleItemAdoption: canAdopt,
      allowOneClickAdoption: false,
      doctorReviewRequired: true,
      pharmacistReviewRequired: true,
      overrideReasonRequired: strongPrescriptionRisk || warningLevelRank(warningProfile.level) >= warningLevelRank("L3"),
      warningConfirmationMode:
        warningProfile.level === "L4" ? "blocked" :
        warningProfile.level === "L3" ? "checkbox_and_reason" :
        warningProfile.level === "L2" ? "checkbox" :
        "none",
      warningAcknowledgementRequired: warningLevelRank(warningProfile.level) >= warningLevelRank("L2"),
      warningReasonRequired: warningLevelRank(warningProfile.level) >= warningLevelRank("L3"),
      finalPrescriptionReleaseAllowed: false,
      autoWriteDiagnosis: false,
      autoWritePrescription: false,
    },
  };
}
