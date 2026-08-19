import { derivePrescriptionPermission, deriveSafetyLocked, detectProgrammaticRedFlags, evaluateSafetyGate, hasCurrentRiskLine, isNonDosePrescriptionText, withSafetyGate } from "./diagnosis-safety";
import { sectionTitleGroup } from "./cdss-vocab";
import type { CaseState, ClinicalCitation, SafetyGate } from "./diagnosis-types";
import { extractPrescribedHerbs, getTcmHerbDoseLimit, clinicianDoseHerbClass } from "./tcm-knowledge";
import { diagnoseReasoningFromState, mergeReasoningStages, prescribeReasoningFromState } from "./diagnosis-parse";
import { isValidEditedHerbDose } from "./prescription-revision";
import { prescriptionRegimenFromDecoction, type PrescriptionRegimenDto } from "./prescription-regimen-contract";
import { customerEvidenceDisplayStatus } from "./customer-evidence";
import { resolveFormulaSources } from "./tcm-formula-provenance";
import { sourceAllowed, type EvidenceScope } from "./evidence-source-validation";
import { compileTcmTreatmentRecommendations } from "./tcm-treatment-capabilities.server";
import { isKnownTcmTreatmentProjectCode } from "./tcm-treatment-projects";
import { displayableLineageAdaptation, lineageLabel } from "./tcm-lineages";
import { classifyHerbWarning, deriveCaseWarningProfile, warningLevelRank, type ClinicalWarningLevel } from "./clinical-warning-tier";
import { hasBoundClinicalReviewAttestation } from "./clinical-review-binding";
import { clinicalReviewIndependenceOf, clinicalReviewLabel, clinicalReviewMethodNote } from "./clinical-review-independence";
import { CLASSIC_EVIDENCE_ANCHOR_LABELS, CLASSIC_EVIDENCE_TIER_LABELS } from "./internal-tag-hygiene";
import { safeDietAdviceForDisplay, GOVERNED_FORMULA_DATA_LABEL } from "./result-display-policy";
import { tcmTreatmentProtocolGapCopy, westernDiagnosisLabelForDisplay } from "./diagnosis-visible-summary";
import { prioritizeTcmEvidenceForDisplay, prioritizeWesternEvidenceForDisplay } from "./clinical-evidence-display";

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
  /**
   * 本次临床复核的**实际拓扑**（甲方 2026-08-10 ⑨）。
   * cross_model = 换了模型身份的独立复核；same_model_second_pass = 同一模型的第二次
   * 无对话状态请求（复核专用提示词、只增不减风险提示），不构成跨模型独立复核。
   * 未记录复核时为 null。
   */
  clinicalReviewMethod: {
    status: "accepted" | "unavailable";
    independence: "cross_model" | "same_model_second_pass";
    label: string;
    note: string;
    provider?: string;
    model?: string;
  } | null;
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
    /**
     * 流派适配记录（甲方基线 §10.2「报告须简洁说明采用了哪些流派特征」）。
     * 仅当医生选择了具体流派且模型产出了非空适配内容时下发；unrestricted 或空内容一律缺省。
     * 新增可选字段，V1/V2 契约均非破坏。
     */
    tcmLineageAdaptation?: {
      label: string;
      applicability: "适用" | "部分适用" | "不适用";
      reason?: string;
      influencedDecisions: Array<{ aspect: string; detail: string }>;
      safetyBoundary: string;
    };
    vitals?: string;
  };
  diagnoses: {
    western: AdoptableItem[];
    tcmPatterns: AdoptableItem[];
    mechanism: AdoptableItem[];
    /**
     * 西医诊断的结构化待查依据（甲方 2026-08-05「西医诊断无待查依据」）。
     *
     * 此前只有 markdown 卡片，而「为什么还不能下这个诊断」被压进正文里，集成方无法分辨
     * 「资料限制」与「建议检查」是两类不同的东西：前者说明当前证据不足在哪，
     * 后者说明补什么能推进。status 一并给出，否则 HIS 无法区分「考虑」与「需排除」。
     */
    westernDetail: {
      name: string;
      status: string;
      confidence: string;
      supportingFacts: string[];
      /** 事实到诊断倾向的临床推理。此前只落到服务端 Markdown 一个出口，写回链路取不到。 */
      clinicalRationale?: string;
      limitations: string[];
      suggestedChecks: string[];
      /**
       * 指南/文献依据（甲方 2026-08-10 ⑩）。题名/机构/年份/URL 由服务端按 evidenceId
       * 反查本轮真检索到的 EviMed 条目渲染，模型只提交 id + 一句 appliesTo。
       * 检索不到就没有这个字段——绝不回落到模型自撰题名。
       */
      guidelineReferences?: Array<{ evidenceId: string; citation: string; url?: string; appliesTo?: string }>;
      icd10?: { code: string; display: string; source: string };
    } | null;
    /**
     * 中医辨病/辨证的结构化推理（2026-08-10 新增）。
     *
     * 与 westernDetail 同构。此前这几项只落到服务端 Markdown 一个出口：
     * 「辨病推理」「鉴别的典型表现」「被剥离的方名」在写回链路里整段取不到，
     * 集成方只能从 markdown 卡片里正则抠。与本轮 ②③⑥⑨ 是同一个缺陷形状。
     */
    tcmDetail: {
      tcmDiseaseName?: string;
      tcmDiseaseRationale?: string;
      tcmDiagnosticRationale?: string;
      tcmDiseaseReferences: ClinicalCitation[];
      tcmSyndromeReferences: ClinicalCitation[];
      primarySyndrome: string;
      primarySyndromeResolution: string;
      primarySyndromeBasis: string[];
      syndromeDifferentials: Array<{ syndrome: string; typicalManifestation?: string; reason: string; distinguishingPoints?: string; nextCheck?: string }>;
      diseaseDifferentials: Array<{ diseaseName: string; typicalManifestation?: string; reason: string; distinguishingPoints?: string; nextCheck?: string }>;
      /** 模型选过、但因与签名证候无治理目录直接关系而被服务端剥离的方名。可选：未发生剥离时不下发。 */
      deferredFormulaSelection?: { names: string[]; reason?: string };
    } | null;
    /**
     * 受控术语归一痕迹（2026-08-11 补进 HIS 出参）。
     *
     * 系统把医生原文归一到国标/受控词表（「胃痞」→「痞满」、ICD-10 规范名）时，
     * 这条轨迹此前只进签名载荷与医生页面。HIS 侧看到的是归一**之后**的名字，
     * 拿不到原文、候选 ID 与状态，也就无法回答「这个证候名是医生写的还是系统改的、确认了没有」。
     * status=suggested 表示系统建议、医生尚未确认；clinician_confirmed 表示已确认。
     */
    terminologyMappings: Array<{
      namespace: string;
      fieldPath: string;
      originalText: string;
      canonical: string;
      candidateId: string;
      status: "suggested" | "clinician_confirmed";
      confidence: number;
    }>;
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
    /**
     * 煎服法细节（甲方 2026-08-05「剂数与煎服法结构化字段」）。
     *
     * regimen 只承载剂数/疗程/服法这几项受合同校验的字段——它同时是 rxaudit 的提交门与
     * 处方回写合同，不能为了补字段去动它。煎法细节另开一块：浸泡/火候/一煎二煎时长/出液量
     * 本就随方剂性质变化（解表剂「勿过煮」、补益剂文火久煎），此前只存在于 method 那句
     * 拼接文本里，集成方要靠正则去抠。
     */
    decoctionDetail: {
      soakMinutes?: number;
      decoctionTimes?: number;
      firstDecoctionMinutes?: number;
      secondDecoctionMinutes?: number;
      targetVolumeMl?: number;
      method: string;
      course: string;
    } | null;
    /**
     * 方义/组成逻辑/方证鉴别/经典条文（甲方 2026-08-05 🔴高「补充到 M04 出参结构化字段」）。
     *
     * 四项都是**确定性产物**（受治理方剂库 + 组成规则表 164 条 + 鉴别图 167 条边 + 经典条文语料），
     * 早已生成并进 M04 sentinel，但从未进入对外投影，因此甲方视角是「没有」。
     * 自拟方时四项恒空——它们锚定在受治理方名上，无方名即无出处，这是正确行为而非缺陷。
     */
    formulaRationale: {
      formulaAnalysis: string;
      compositionLogic: Array<{ formulaName: string; summary: string; tierLabel: string; sourceRefs: string[] }>;
      discriminationPath: Array<{ againstFormula: string; question: string; statusLabel: string; sourceRef: string }>;
      classicEvidence: Array<{
        evidenceId: string;
        citation: string;
        anchorLabel: string;
        clauseNumber?: number;
        excerpt: string;
        tierLabel: string;
      }>;
      /** 固定呈现纪律，必须与条文一同下发，避免 HIS 把出处当适应证、把古代剂量当可执行用量。 */
      evidenceBoundary: string;
    } | null;
    /**
     * 随证加减建议（甲方 2026-08-05 🔴高）+ 可替换药味说明。
     *
     * 加减针对的是**已记录但主方覆盖不足的兼症**，不是预设的未来症状；加减行本身不带克数，
     * 剂量由药味工作台与审方链路负责。substitutions 覆盖缺货/过敏/特殊人群禁用场景，
     * 每条自带替代理由与差异——只给药名等于让医生自己去查，而差异正是最容易出事的地方。
     */
    modifications: Array<{
      trigger: string;
      /**
       * 触发依据的**可回溯落点**（2026-08-11 补进 HIS 出参）。
       *
       * 这一栏此前只进签名载荷与医生页面正文，HIS 侧拿到的 trigger 是一句自由文本，
       * 集成方无从判断「去年体检血糖偏高」这条触发到底出自主诉、既往史还是西医支持事实。
       * 本项目的原则是每条结论都要能指回一个患者事实——出口少接一个，这条原则在该出口就不成立。
       */
      triggerSource: { kind: string; sourceRef: string; sourceQuote: string } | null;
      targetPathogenesis: string;
      action: string;
      doseOrHandling: string | null;
      reason: string;
      riskNote: string;
      substitutions: Array<{ replaces: string; substitute: string; rationale: string; differenceNote: string }>;
    }>;
    /**
     * 中成药候选的结构化子字段（甲方 2026-08-05「补充到 M04 patentMedicines 结构」）。
     *
     * 字段名按甲方文档口径定为 patentMedicines：此前对外接口文档承诺的就是这个名字，
     * 而代码里叫 formula.patentAndWestern，集成方按文档取值自然恒空。
     * 保留 westernOrPatent 那张 markdown 卡片不动，避免打断既有集成。
     */
    patentMedicines: Array<{
      type: "西药" | "中成药";
      name: string;
      specification: string | null;
      singleDose: string | null;
      frequency: string | null;
      route: string | null;
      administrationTiming: string | null;
      usageBoundary: string;
      course: string | null;
      positioning: string;
      correspondingProblem: string;
      relationship: string;
      riskNote: string;
      evidenceId?: string;
      /** 说明书未给全用法用量时不猜，这里如实标记，HIS 不得据此自动生成医嘱。 */
      dosageAvailable: boolean;
    }>;
  };
  /**
   * 健康调护（甲方 2026-08-05 🔴高「饮食/起居/情志/注意事项：无此模块」）。
   *
   * 甲方判断字面属实：三段调护与注意事项在 M04 是必填、医生端也有独立卡片，
   * 唯独对外投影一处都没有。食疗净化此前只做在客户端，接口出口走的是未净化原文，
   * 这里统一走服务端净化，避免「山楂活血化瘀」这类把食物写成治疗手段的表述流到 HIS。
   */
  healthGuidance: {
    diet: string;
    lifestyle: string;
    emotion: string;
    precautions: string[];
  } | null;
  treatments: {
    tcmProjects: Array<{
      projectCode: string;
      projectName: string;
      availability: "clinic_available" | "referral_only";
      targetPathogenesis: string;
      assessmentPositioning?: string;
      protocolStatus: "governed_patient_specific_plan" | "governed_class_template_not_syndrome_tailored" | "assessment_only_no_patient_specific_protocol";
      /**
       * 方案加减状态的**真实值**（V1.5 新增，非破坏）。
       * V1 契约下 protocolStatus 会把第三态折叠成 assessment_only_...（见 his-scheme-contract-version），
       * 这一栏不折叠：要区分「病种模板未按证型加减」与「纯现场评估」，读它。
       */
      tailoringStatus?: "syndrome_tailored" | "class_template_only" | "assessment_only";
      /** 内部状态码。要展示给人看请用 protocolGapNote。 */
      protocolGap?: string;
      /** protocolGap 的临床语言说明（受控映射，认不出的码不下发）。 */
      protocolGapNote?: string;
      /**
       * 该条证型加减是否已完成中医师终审（V1.5 新增）。
       * pending_clinician_review 时服务端**没有应用**该条加穴，下方穴位只是病种标准取穴。
       */
      adjudicationStatus?: "approved" | "pending_clinician_review";
      /** 命中但因未终审而未予应用的证型加减。系统看到了什么、为什么没用，如实下发。 */
      /**
       * 待**签字**的病种标准取穴模板：整条模板未启用、本项目仍是评估态。
       * 与下面的 deferredSyndromeRefinement 是两个必须分清的概念——
       * 后者是「病种模板能用、这一条证型加减不敢用」。
       */
      deferredGovernedTemplate?: {
        templateId: string;
        indicationLabel: string;
        deferredPoints: string[];
        conflictNote: string;
      };
      /** 命中本例证型的配穴方案但未完成终审，因而未予应用；病种模板本身照常可用。 */
      deferredSyndromeRefinement?: { syndromeLabel: string; deferredPoints: string[]; conflictNote: string };
      treatmentContent: string;
      suggestedSitesOrPoints: string[];
      /**
       * 逐穴来源与权威分级（V1.5 新增）。
       *
       * 此前对外只有 protocolSource 一个拼接字符串（"SRC-A、SRC-B"），集成方看不出
       * 哪个穴来自哪个来源、什么等级、有没有分歧——而这三件事决定要不要展示、以什么等级展示、
       * 能不能采纳。主穴与加减穴来自不同来源，因此粒度必须到穴位。
       * authorityTier 取值见受治理来源注册表：regulatory_primary / government_primary /
       * government_mirror / professional_society_standard / professional_society_reference /
       * project_governed_source / unregistered。
       */
      pointProvenance?: Array<{
        point: string;
        role: "base_point" | "syndrome_refinement" | "syndrome_removal" | "conditional_point";
        sourceRefs: string[];
        authorityTier: string;
        adjudicationStatus: "approved" | "pending_clinician_review";
        conflictNote: string | null;
      }>;
      /** 本条方案全部来源里的最高权威等级。逐穴等级见 pointProvenance。 */
      sourceAuthorityTier?: string;
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

/**
 * 从医生可见正文里按标题整行精确匹配取出一段。
 *
 * **导出是为了让回归套件钉住真实判据本身**，而不是在测试里重建一份同源副本——
 * 重建副本的后果本仓库已有先例：判据改了测试不会红。test:his-section-coupling 用它
 * 逐条核对「受治理输出契约登记表的可见标题」与「SECTION_TITLES 分组」是否仍然咬合。
 */
export function section(text: string | undefined, titles: string[]): string {
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
      if (!refs.has(key)) refs.set(key, { source: GOVERNED_FORMULA_DATA_LABEL, title });
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

/** 内部枚举一律经标签表转中文再对外；裸枚举泄漏是甲方 8-04 已提过的缺陷类（L0/L1/L3）。 */
function tierLabel(tier: unknown): string {
  const key = typeof tier === "string" ? tier : "";
  return CLASSIC_EVIDENCE_TIER_LABELS[key] || (key ? "" : "");
}

function anchorLabel(anchor: unknown): string {
  const key = typeof anchor === "string" ? anchor : "";
  return CLASSIC_EVIDENCE_ANCHOR_LABELS[key] || "";
}

/** 方证鉴别的 status 枚举（confirmed/absent/unknown）此前被原样打印，这里统一中文化。 */
const DISCRIMINATION_STATUS_LABELS: Record<string, string> = {
  confirmed: "本例已确认",
  absent: "本例未见",
  unknown: "本例尚未核实",
};

const CLASSIC_EVIDENCE_BOUNDARY =
  "经典条文按方名检索给出，用于说明该方的经典出处与主治语境，不代表已判定适用于本例；"
  + "条文内的古代剂量与现代法定剂量不可直接换算，处方用量以药味表与审方结论为准。";

function projectFormulaRationale(
  candidate: ReturnType<typeof structuredCandidate>,
): HisAiSchemePayload["prescriptions"]["formulaRationale"] {
  if (!candidate) return null;
  const compositionLogic = (candidate.compositionLogic || []).map((entry) => ({
    formulaName: clean(entry.formulaName),
    summary: clean(entry.summary),
    tierLabel: tierLabel(entry.tier),
    sourceRefs: (entry.sourceRefs || []).map((ref) => clean(ref)).filter(Boolean),
  })).filter((entry) => entry.formulaName && entry.summary);
  const discriminationPath = (candidate.discriminationPath || []).map((entry) => ({
    againstFormula: clean(entry.againstFormula),
    question: clean(entry.question),
    statusLabel: DISCRIMINATION_STATUS_LABELS[entry.status] || "本例尚未核实",
    sourceRef: clean(entry.sourceRef),
  })).filter((entry) => entry.againstFormula && entry.question);
  const classicEvidence = (candidate.classicEvidence || []).map((entry) => ({
    evidenceId: clean(entry.evidenceId),
    citation: clean(entry.citation),
    anchorLabel: anchorLabel(entry.anchorLevel),
    ...(typeof entry.clauseNumber === "number" ? { clauseNumber: entry.clauseNumber } : {}),
    excerpt: clean(entry.excerpt),
    tierLabel: tierLabel(entry.tier),
  })).filter((entry) => entry.citation);
  const formulaAnalysis = clean(candidate.formulaAnalysis);
  if (!formulaAnalysis && compositionLogic.length === 0 && discriminationPath.length === 0 && classicEvidence.length === 0) {
    return null;
  }
  return {
    formulaAnalysis,
    compositionLogic,
    discriminationPath,
    classicEvidence,
    evidenceBoundary: CLASSIC_EVIDENCE_BOUNDARY,
  };
}

function projectModifications(
  candidateSource: { modifications?: unknown } | null | undefined,
): HisAiSchemePayload["prescriptions"]["modifications"] {
  const rows = Array.isArray(candidateSource?.modifications) ? candidateSource.modifications : [];
  return rows.flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const entry = raw as Record<string, unknown>;
    const trigger = clean(typeof entry.trigger === "string" ? entry.trigger : "");
    const action = clean(typeof entry.action === "string" ? entry.action : "");
    if (!trigger || !action) return [];
    const substitutions = Array.isArray(entry.substitutions) ? entry.substitutions : [];
    const rawTriggerSource = entry.triggerSource && typeof entry.triggerSource === "object" && !Array.isArray(entry.triggerSource)
      ? entry.triggerSource as Record<string, unknown>
      : null;
    const triggerSourceQuote = clean(typeof rawTriggerSource?.sourceQuote === "string" ? rawTriggerSource.sourceQuote : "");
    const triggerSourceRef = clean(typeof rawTriggerSource?.sourceRef === "string" ? rawTriggerSource.sourceRef : "");
    const triggerSourceKind = clean(typeof rawTriggerSource?.kind === "string" ? rawTriggerSource.kind : "");
    return [{
      trigger,
      // 三项齐全才写回：残缺的溯源比没有溯源更坏——集成方会把它当作已核实的落点。
      triggerSource: triggerSourceKind && triggerSourceRef && triggerSourceQuote
        ? { kind: triggerSourceKind, sourceRef: triggerSourceRef, sourceQuote: triggerSourceQuote }
        : null,
      targetPathogenesis: clean(typeof entry.targetPathogenesis === "string" ? entry.targetPathogenesis : ""),
      action,
      doseOrHandling: typeof entry.doseOrHandling === "string" && entry.doseOrHandling.trim()
        ? clean(entry.doseOrHandling)
        : null,
      reason: clean(typeof entry.reason === "string" ? entry.reason : ""),
      riskNote: clean(typeof entry.riskNote === "string" ? entry.riskNote : ""),
      substitutions: substitutions.flatMap((rawSub) => {
        if (!rawSub || typeof rawSub !== "object" || Array.isArray(rawSub)) return [];
        const sub = rawSub as Record<string, unknown>;
        const replaces = clean(typeof sub.replaces === "string" ? sub.replaces : "");
        const substitute = clean(typeof sub.substitute === "string" ? sub.substitute : "");
        if (!replaces || !substitute) return [];
        return [{
          replaces,
          substitute,
          rationale: clean(typeof sub.rationale === "string" ? sub.rationale : ""),
          differenceNote: clean(typeof sub.differenceNote === "string" ? sub.differenceNote : ""),
        }];
      }),
    }];
  });
}

function projectPatentMedicines(
  patentAndWestern: unknown,
): HisAiSchemePayload["prescriptions"]["patentMedicines"] {
  const rows = Array.isArray(patentAndWestern) ? patentAndWestern : [];
  return rows.flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const entry = raw as Record<string, unknown>;
    const name = clean(typeof entry.name === "string" ? entry.name : "");
    if (!name) return [];
    const type = entry.type === "西药" ? "西药" as const : "中成药" as const;
    const text = (key: string): string | null => {
      const value = entry[key];
      return typeof value === "string" && value.trim() ? clean(value) : null;
    };
    const singleDose = text("singleDose");
    const frequency = text("frequency");
    const route = text("route");
    const administrationTiming = text("administrationTiming");
    return [{
      type,
      name,
      specification: text("specification"),
      singleDose,
      frequency,
      route,
      administrationTiming,
      usageBoundary: clean(typeof entry.usageBoundary === "string" ? entry.usageBoundary : ""),
      course: text("course"),
      positioning: clean(typeof entry.positioning === "string" ? entry.positioning : ""),
      correspondingProblem: clean(typeof entry.correspondingProblem === "string" ? entry.correspondingProblem : ""),
      relationship: clean(typeof entry.relationship === "string" ? entry.relationship : ""),
      riskNote: clean(typeof entry.riskNote === "string" ? entry.riskNote : ""),
      ...(typeof entry.evidenceId === "string" && entry.evidenceId.trim() ? { evidenceId: clean(entry.evidenceId) } : {}),
      // 西药一律不下发剂量，中成药只在说明书条目本身给全时才算可用；缺一项即为不可用，
      // 由医生按说明书确定，HIS 不得据此自动生成医嘱。
      dosageAvailable: type === "中成药" && Boolean(singleDose && frequency),
    }];
  });
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
  // 依据排序接**同一个**导出谓词（甲方 2026-08-10 ②）：prioritize*ForDisplay 此前只被
  // 客户端一张 React 卡片消费，Markdown 与 HIS 两个出口各自把原始字段直接写出去，
  // 于是同一份签名载荷在三个出口不一致——医生页面里被降权的主诉复述，在 HIS 写回里照样出现。
  const westernStructuredFacts = prioritizeWesternEvidenceForDisplay(
    activeReasoning?.westernDiagnosis?.primary?.supportingFacts?.filter(Boolean) || [],
  ).join("；");
  const hisChiefComplaint = caseState.hisRecord?.fields?.zhushu || caseState.chiefComplaint || "";
  const tcmStructuredFacts = (activeReasoning?.pathogenesis?.chain || [])
    .map((item) => [
      item.patientFact,
      prioritizeTcmEvidenceForDisplay([item.syndromeEvidence || ""], [], hisChiefComplaint, 2).join("；")
        || item.syndromeEvidence,
    ].filter(Boolean).join(" → "))
    .filter(Boolean)
    .join("；");
  const contentMismatch = suppressDoseLevelOutputs ? false : markdownV2HerbMismatch(markdownHerbal, caseState);
  const invalidStructuredDose = suppressDoseLevelOutputs ? false : structuredHerbs(caseState).some((herb) => !isValidEditedHerbDose(herb.dose));
  const unauditedConcreteMedicine = hasConcreteWesternOrPatentMedication(medicine);
  // 受理裁决范围读取(2026-08-03 根源工程): 生成侧带批注受理的裁决随合同签名下发,
  // HIS 侧**读取并呈现**豁免/批注码,而不是用自己的口径把已受理候选再判一遍——
  // "这里受理、那里重判"的分叉在写回边界由读取取代。哈希未绑定(旧快照/被篡改)时不显示。
  const acceptanceScopeNotice = (() => {
    const scope = prescribeReasoning?.clinicalReview?.acceptanceScope;
    if (!scope || !hasBoundClinicalReviewAttestation(prescribeReasoning)) return "";
    const codes = [...new Set([...scope.waivedIssueCodes, ...scope.qualityAnnotationCodes])];
    if (codes.length === 0) return "";
    return [
      "## 生成侧受理裁决（随合同签名下发）",
      `**质量批注受理**：生成侧已按质量批注受理本候选，涉及缺陷码：${codes.join("、")}。`,
      "对应医生可读批注见处方正文首部；该裁决位于合同签名域内，写回链路只读取、不改写。采纳前请医生结合批注逐项复核；本提示不阻断诊疗流程。",
    ].join("\n");
  })();
  /**
   * 复核方式如实写回（甲方 2026-08-10 ⑨）。
   *
   * HIS 与医生页面此前都只看得到「独立复核」四个字，而默认全 V4-Flash 部署下
   * `independentFromGenerator=false`——同一模型的第二次无对话状态请求。
   * 这里把拓扑位与它对应的方式说明一并下发，集成方与医生据此判断这道复核的证据强度。
   */
  const clinicalReviewMethod = (() => {
    const attestation = prescribeReasoning?.clinicalReview || diagnoseReasoning?.clinicalReview;
    if (!attestation) return null;
    const independence = clinicalReviewIndependenceOf(attestation.independentFromGenerator);
    return {
      status: attestation.status,
      independence,
      label: clinicalReviewLabel(independence),
      note: clinicalReviewMethodNote(independence),
      ...(attestation.provider ? { provider: attestation.provider } : {}),
      ...(attestation.model ? { model: attestation.model } : {}),
    };
  })();
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
    acceptanceScopeNotice,
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
    // 复核方式（甲方 2026-08-10 ⑨）：拓扑位随签名 attestation 下发，不再无条件写「独立」。
    clinicalReviewMethod,
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
      // 适配记录直接读签名载荷的结构化字段（displayableLineageAdaptation 是三出口共用判据），
      // 不走 Markdown 切段——unrestricted 或空壳内容时字段整体缺省，V1/V2 契约均非破坏。
      tcmLineageAdaptation: (() => {
        const display = displayableLineageAdaptation(activeReasoning?.lineageAdaptation);
        return display ? {
          label: display.label,
          applicability: display.applicability,
          ...(display.reason ? { reason: display.reason } : {}),
          influencedDecisions: display.influencedDecisions,
          safetyBoundary: display.safetyBoundary,
        } : undefined;
      })(),
      vitals: [
        caseState.hisRecord?.fields?.vitalsT,
        caseState.hisRecord?.fields?.vitalsP,
        caseState.hisRecord?.fields?.vitalsR,
        caseState.hisRecord?.fields?.vitalsBP,
        caseState.hisRecord?.fields?.vitalsDetail,
      ].filter(Boolean).join("；") || compact(caseState.vitals),
    },
    diagnoses: {
      // 诊断名走 westernDiagnosisLabelForDisplay——它自述是「医生可见标签的唯一权威
      //（Markdown 摘要、客户端诊断卡、HIS 方案共用）」，而这里此前从 Markdown 正文里
      // extractField 取字符串，绕开了它（甲方 2026-08-10 ③）：ICD-10 规范名不生效、
      // 「头痛（症状性）」这类非规范括注也不会被收敛成「头痛，病因待查」。
      // 结构化载荷取不到名字时才回落到 Markdown 抽取，保持既有兼容行为。
      western: [item("western-1", westernDiagnosisLabelForDisplay(
        activeReasoning?.westernDiagnosis?.primary?.name,
        activeReasoning?.westernDiagnosis?.primary?.coding,
      ) || extractField(western, ["风险/需排除方向", "西医诊断"]) || "西医诊断", western, {
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
      westernDetail: (() => {
        const primary = activeReasoning?.westernDiagnosis?.primary;
        if (!primary?.name) return null;
        return {
          // 同一权威：结构化 westernDetail.name 也必须走 westernDiagnosisLabelForDisplay，
          // 否则 HIS 的两个字段（diagnoses.western[0].name 与 westernDetail.name）会不一致。
          name: clean(westernDiagnosisLabelForDisplay(primary.name, primary.coding) || primary.name),
          status: clean(primary.status || ""),
          confidence: clean(primary.confidence || ""),
          supportingFacts: (primary.supportingFacts || []).map((fact) => clean(fact)).filter(Boolean),
          ...(primary.clinicalRationale ? { clinicalRationale: clean(primary.clinicalRationale) } : {}),
          limitations: (primary.limitations || []).map((entry) => clean(entry)).filter(Boolean),
          suggestedChecks: (primary.suggestedChecks || []).map((entry) => clean(entry)).filter(Boolean),
          // 指南/文献依据（甲方 2026-08-10 ⑩）。题名/机构/年份/URL 全部由服务端按
          // evidenceId 反查本轮真检索到的条目渲染，模型只提交 id + 一句 appliesTo。
          // 取不到就没有这个字段，绝不回落到模型自撰题名。
          ...(primary.guidelineReferences?.length ? {
            guidelineReferences: primary.guidelineReferences.map((entry) => ({
              evidenceId: entry.evidenceId,
              citation: clean(entry.citation),
              ...(entry.url ? { url: entry.url } : {}),
              ...(entry.appliesTo ? { appliesTo: clean(entry.appliesTo) } : {}),
            })),
          } : {}),
          ...(primary.coding?.code ? {
            icd10: {
              code: clean(primary.coding.code),
              display: clean(primary.coding.display),
              source: clean(primary.coding.source),
            },
          } : {}),
        };
      })(),
      tcmDetail: (() => {
        const overview = activeReasoning?.overview;
        if (!overview?.primarySyndrome) return null;
        const differential = (item: { typicalManifestation?: string; reason?: string; distinguishingPoints?: string; nextCheck?: string | null }) => ({
          ...(item.typicalManifestation ? { typicalManifestation: clean(item.typicalManifestation) } : {}),
          reason: clean(item.reason || ""),
          ...(item.distinguishingPoints ? { distinguishingPoints: clean(item.distinguishingPoints) } : {}),
          ...(item.nextCheck ? { nextCheck: clean(item.nextCheck) } : {}),
        });
        const deferred = overview.deferredFormulaSelection;
        const citations = (items: readonly ClinicalCitation[] | undefined): ClinicalCitation[] =>
          (items || []).map((item) => ({
            evidenceId: clean(item.evidenceId),
            citation: clean(item.citation),
            sourceType: item.sourceType,
            ...(item.url ? { url: clean(item.url) } : {}),
            ...(item.doi ? { doi: clean(item.doi) } : {}),
            ...(item.pmid ? { pmid: clean(item.pmid) } : {}),
          })).filter((item) => Boolean(item.evidenceId && item.citation));
        return {
          ...(overview.tcmDiseaseName ? { tcmDiseaseName: clean(overview.tcmDiseaseName) } : {}),
          ...(overview.tcmDiseaseRationale ? { tcmDiseaseRationale: clean(overview.tcmDiseaseRationale) } : {}),
          ...(overview.tcmDiagnosticRationale ? { tcmDiagnosticRationale: clean(overview.tcmDiagnosticRationale) } : {}),
          tcmDiseaseReferences: citations(overview.tcmDiseaseReferences),
          tcmSyndromeReferences: citations(overview.tcmSyndromeReferences),
          primarySyndrome: clean(overview.primarySyndrome),
          primarySyndromeResolution: clean(overview.primarySyndromeResolution || ""),
          primarySyndromeBasis: (overview.primarySyndromeBasis || []).map((entry) => clean(entry)).filter(Boolean),
          syndromeDifferentials: (overview.tcmDifferentials || []).map((item) => ({ syndrome: clean(item.syndrome), ...differential(item) })),
          diseaseDifferentials: (overview.tcmDiseaseDifferentials || []).map((item) => ({ diseaseName: clean(item.diseaseName), ...differential(item) })),
          ...(deferred?.names?.length
            ? { deferredFormulaSelection: { names: deferred.names.map((name) => clean(name)).filter(Boolean), ...(deferred.reason ? { reason: clean(deferred.reason) } : {}) } }
            : {}),
        };
      })(),
      // 归一痕迹取自本轮实际生效的那份 reasoning（M04 阶段沿用 M03 的映射）。
      // 只下发身份与状态字段，不下发 model/cache/resolvedBy 这类内部执行痕迹。
      terminologyMappings: (activeReasoning?.terminologyMappings || []).flatMap((mapping) => {
        const originalText = clean(mapping.originalText || "");
        const canonical = clean(mapping.canonical || "");
        if (!originalText || !canonical) return [];
        return [{
          namespace: mapping.namespace,
          fieldPath: clean(mapping.fieldPath || ""),
          originalText,
          canonical,
          candidateId: clean(mapping.candidateId || ""),
          status: mapping.status,
          confidence: mapping.confidence,
        }];
      }),
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
      decoctionDetail: (() => {
        if (suppressDoseLevelOutputs) return null;
        const decoction = structuredCandidate(caseState)?.decoction;
        if (!decoction) return null;
        const num = (value: unknown): number | undefined =>
          typeof value === "number" && Number.isFinite(value) ? value : undefined;
        return {
          ...(num(decoction.soakMinutes) != null ? { soakMinutes: num(decoction.soakMinutes) } : {}),
          ...(num(decoction.decoctionTimes) != null ? { decoctionTimes: num(decoction.decoctionTimes) } : {}),
          ...(num(decoction.firstDecoctionMinutes) != null ? { firstDecoctionMinutes: num(decoction.firstDecoctionMinutes) } : {}),
          ...(num(decoction.secondDecoctionMinutes) != null ? { secondDecoctionMinutes: num(decoction.secondDecoctionMinutes) } : {}),
          ...(num(decoction.targetVolumeMl) != null ? { targetVolumeMl: num(decoction.targetVolumeMl) } : {}),
          method: clean(decoction.method || ""),
          course: clean(decoction.course || ""),
        };
      })(),
      formulaRationale: suppressDoseLevelOutputs ? null : projectFormulaRationale(structuredCandidate(caseState)),
      modifications: suppressDoseLevelOutputs ? [] : projectModifications(prescribeReasoning?.formula),
      patentMedicines: suppressDoseLevelOutputs ? [] : projectPatentMedicines(prescribeReasoning?.formula?.patentAndWestern),
    },
    treatments: {
      tcmProjects: suppressDoseLevelOutputs ? [] : structuredTcmTreatments(caseState).map((project) => ({
        projectCode: project.projectCode,
        projectName: project.projectName,
        availability: project.availability,
        targetPathogenesis: project.targetPathogenesis,
        assessmentPositioning: project.assessmentPositioning,
        protocolStatus: project.protocolStatus,
        ...(project.tailoringStatus ? { tailoringStatus: project.tailoringStatus } : {}),
        protocolGap: project.protocolGap,
        ...(project.adjudicationStatus ? { adjudicationStatus: project.adjudicationStatus } : {}),
        ...(project.deferredGovernedTemplate ? {
          deferredGovernedTemplate: {
            templateId: clean(project.deferredGovernedTemplate.templateId),
            indicationLabel: clean(project.deferredGovernedTemplate.indicationLabel),
            deferredPoints: (project.deferredGovernedTemplate.deferredPoints || []).map((point) => clean(point)).filter(Boolean),
            conflictNote: clean(project.deferredGovernedTemplate.conflictNote),
          },
        } : {}),
        ...(project.deferredSyndromeRefinement ? {
          deferredSyndromeRefinement: {
            syndromeLabel: clean(project.deferredSyndromeRefinement.syndromeLabel),
            deferredPoints: (project.deferredSyndromeRefinement.deferredPoints || []).map((point) => clean(point)).filter(Boolean),
            conflictNote: clean(project.deferredSyndromeRefinement.conflictNote),
          },
        } : {}),
        ...(project.pointProvenance?.length ? {
          pointProvenance: project.pointProvenance.map((entry) => ({
            point: clean(entry.point),
            role: entry.role,
            sourceRefs: (entry.sourceRefs || []).map((ref) => clean(ref)).filter(Boolean),
            authorityTier: entry.authorityTier,
            adjudicationStatus: entry.adjudicationStatus,
            conflictNote: entry.conflictNote ? clean(entry.conflictNote) : null,
          })),
        } : {}),
        ...(project.sourceAuthorityTier ? { sourceAuthorityTier: project.sourceAuthorityTier } : {}),
        // protocolGap 是内部状态码；集成方要直接展示时用这一句临床语言，不要自己翻译码值
        //（Markdown 出口此前把码值原样印给医生看，见 diagnosis-visible-summary 的同名映射）。
        ...(tcmTreatmentProtocolGapCopy(project.protocolGap || "") ? { protocolGapNote: tcmTreatmentProtocolGapCopy(project.protocolGap || "") } : {}),
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
    healthGuidance: (() => {
      const nonPharma = prescribeReasoning?.nonPharma;
      if (!nonPharma) return null;
      const diet = clean(safeDietAdviceForDisplay(nonPharma.diet || "", {
        chiefComplaint: caseState.chiefComplaint,
        allergyHistory: caseState.allergyHistory,
        medicationHistory: caseState.medicationHistory,
      }));
      const lifestyle = clean(nonPharma.lifestyle || "");
      const emotion = clean(nonPharma.emotion || "");
      const precautions = (nonPharma.precautions || []).map((entry) => clean(entry)).filter(Boolean);
      if (!diet && !lifestyle && !emotion && precautions.length === 0) return null;
      return { diet, lifestyle, emotion, precautions };
    })(),
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
