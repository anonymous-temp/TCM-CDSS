// src/lib/diagnosis-types.ts
import { z } from "zod";
import { isSupportedIcd10PayerCode } from "./icd10-code";
import { EVIDENCE_LEVELS, type EvidenceLevelValue } from "./cdss-vocab";
import { withCanonicalClinicalTerminology } from "./clinical-terminology";
import { resolveLineageCode } from "./tcm-lineages";
import { parseClinicalFacts, type ClinicalFacts } from "./clinical-facts";
import { parseTcmTreatmentCapabilities, TCM_TREATMENT_PROJECT_CODES, type TcmTreatmentProjectCode } from "./tcm-treatment-projects";

export type Phase =
  | "idle"
  | "collect"
  | "question"
  | "diagnose"
  | "prescribe"
  | "assess"
  | "done"
  | "error";

export interface Completeness {
  level: "A" | "B" | "C";
  redFlag: number;       // 0-1
  infoGain: number;      // 0-1
  managementImpact: number; // 0-1
  answerability: number; // 0-1
}

export interface HisRecordSnapshot {
  schemaVersion: "tcm-cdss-his-v1";
  source: "tcm-cdss-his";
  caseId: string;
  updatedAt: string;
  tongueImageUploaded: boolean;
  fields: {
    patientName?: string;
    sex?: string;
    age?: string;
    zhushu?: string;
    xianbingshi?: string;
    jiwangshi?: string;
    guomin?: string;
    yongyaoshi?: string;
    vitalsT?: string;
    vitalsP?: string;
    vitalsR?: string;
    vitalsBP?: string;
    vitalsDetail?: string;
    tcmFace?: string;
    tcmPulse?: string;
    tcmTongue?: string;
    tcmDetail?: string;
    tcmLineagePreference?: string;
    clinicTreatmentCapabilities?: string;
    fuzhuJiancha?: string;
    extraText?: string;
  };
  rawText: string;
}

export interface SafetyGate {
  status: "ready" | "needs_information" | "red_flag";
  allowDiagnosis: boolean;
  allowDosePrescription: boolean;
  action:
    | "proceed"
    | "complete_before_prescription"
    | "refer_or_emergency";
  missingItems: string[];
  missingItemCodes?: SafetyMissingItemCode[];
  redFlags: string[];
  redFlagFindings?: Array<{
    ruleId: string;
    severity: "emergency";
    sourceQuote: string;
    ruleExplanation: string;
    message: string;
  }>;
  advisories?: string[];
  semanticTriage?: {
    level: "emergency_review" | "priority_review";
    findings: string[];
    evidence?: Array<{
      category: string;
      sourceQuote: string;
      escalationRationale?: string;
      evidenceQuotes: string[];
    }>;
  };
  reasons: string[];
}

export type SafetyMissingItemCode =
  | "chief_complaint"
  | "age_invalid"
  | "age_conflict"
  | "sex_unknown"
  | "allergy_unknown"
  | "allergy_details"
  | "medication_unknown"
  | "medication_details"
  | "blood_pressure_invalid"
  | "vitals_invalid"
  | "vitals_source_conflict"
  | "semantic_screen_unavailable"
  | "priority_evaluation_required"
  | "high_risk_missing_vitals"
  | "tongue_unknown"
  | "pulse_unknown"
  | "pediatric_weight_unknown"
  | "pediatric_dose_rules_unavailable"
  | "pregnancy_unknown"
  | "lactation_unknown"
  | "conception_unknown"
  | "behavioral_crisis_screening"
  | "osa_screening"
  | "thyroid_screening";

export type StructuredFollowupTimelineItem = {
  time: string;
  action: string;
  indicators: string[];
  triggers: string[];
};

export interface CaseState {
  id: string;
  phase: Phase;

  // M01 四诊信息
  patient: {
    name?: string;
    sex?: string;
    age?: number;
    occupation?: string;
  };
  chiefComplaint: string;
  symptoms: Record<string, unknown>;
  tongue?: string;
  pulse?: string;
  faceNote?: string;
  tongueImageDesc?: string;   // GLM vision 舌象图像分析结果
  tongueDx?: TongueDiagnosisResult;
  faceCapture?: FaceCaptureResult;
  vitals?: Record<string, unknown>;
  pastHistory?: string;
  medicationHistory?: string;
  allergyHistory?: string;
  tcmLineagePreference?: string;
  clinicTreatmentCapabilities?: string[];
  clinicTreatmentCapabilitiesRestricted?: boolean;
  hisRecord?: HisRecordSnapshot;
  safetyGate?: SafetyGate;
  // 结构化事实(加法兜底)。semanticStatus/resultSource 明确区分已检查、新抽取、缓存命中与不可用；
  // 安全门可据此允许 M03 继续，但不得把 semantic unavailable 静默视为可生成剂量处方。
  clinicalFacts?: ClinicalFacts;
  // 医生对“本次就诊目标不明确”语义预检结论的显式确认。通过 sourceFingerprint 绑定当前病历版本：
  // 病历文本变化后指纹改变，确认自动失效，需对最新语义预检结论重新确认。
  encounterScopeConfirmation?: { sourceFingerprint: string; confirmedAt: string };
  // 医生完成现场急症排查后的显式留痕。它只对当前红旗事实指纹有效：
  // 病历中的红旗证据发生变化后自动失效，不能作为全局关闭急症规则的开关。
  emergencyClearance?: {
    redFlagFingerprint: string;
    confirmedAt: string;
    assessmentSummary: string;
    contractSignature: string;
  };
  // 医生导出前对当前风险分级的确认记录。L4/red-flag 只允许 non_dose_risk_report，
  // 该记录不能改变处方权限、审方结论或安全门状态。
  warningAcknowledgement?: {
    warningLevel: "L2" | "L3" | "L4";
    acknowledgedAt: string;
    reportFingerprint: string;
    reason?: string;
    exportMode: "full_advisory_report" | "non_dose_risk_report";
  };

  // M02 充分度
  completeness: Completeness;
  questionRounds: number;
  maxQuestionRounds: number;
  questionOutcome?: "answered" | "skipped" | "not_needed";
  // 医生显式“跳过追问、按现有信息继续”后置 true：绕过辨证充分度门（安全门/红旗/剂量门仍把关）。
  skipDifferentiationGate?: boolean;

  // 对话历史（最多 10 条）
  conversation: { role: "user" | "assistant"; content: string }[];

  // M03-M05 结果
  diagnosis?: string;
  prescription?: string;
  riskAssessment?: string;
  followupTimeline?: StructuredFollowupTimelineItem[];
  // Display-only snapshot retained while a newer run is in progress or has failed. It must never
  // participate in model context, safety decisions, prescription audit, report export, or HIS write-back.
  previousResult?: {
    diagnosis?: string;
    prescription?: string;
    riskAssessment?: string;
    capturedAt: string;
  };
  auditAdvisory?: {
    available: boolean;
    reason?: "no_prescription_items" | "service_unavailable";
  };
  reasoningDiagnose?: ClinicalReasoningResultV2;
  reasoningPrescribe?: ClinicalReasoningResultV2;
  reasoningV2?: ClinicalReasoningResultV2;
  prescriptionRevision?: {
    source: "herb_workbench";
    candidateIndex: number;
    herbHash: string;
    auditedAt: string;
    auditResult: "PASS" | "REMIND" | "MANUAL_REVIEW" | "BLOCK";
    highestRiskLevel: "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
    auditAvailable?: boolean;
    degraded?: boolean;
    degradeReason?: string;
    needManualReview?: boolean;
    auditReason?: string;
    auditId?: string;
    traceId?: string;
  };
  safetyLocked?: boolean;

  // 错误追踪
  lastError?: { phase: Phase; message: string };
}

export type EvidenceLevel = EvidenceLevelValue;

export interface EvidenceRef {
  evidenceLevel: EvidenceLevel;
  source: string;
  confidence?: "高" | "中" | "低";
}

export type ClinicalResolution = "resolved" | "bounded" | "unresolved";

export type ClinicalReviewAttestation = {
  status: "accepted" | "unavailable";
  provider?: string;
  model?: string;
  source?: "preferred" | "cross_model_fallback";
  reviewedPayloadHash?: string;
};

export type ControlledTerminologyMappingTrace = {
  namespace: "tcm_syndrome" | "tcm_location" | "tcm_nature" | "tcm_treatment_principle" |
    "tcm_formula" | "medicine_clinical_concept" | "icd10";
  fieldPath: string;
  originalText: string;
  candidateId: string;
  canonical: string;
  resolvedBy: "deepseek_closed_set";
  status: "suggested" | "clinician_confirmed";
  confidence: number;
  model: string;
  consensus: true;
  cache: "hit" | "miss";
};

export interface ClinicalReasoningResultV2 {
  schemaVersion: "tcm-cdss-reasoning-v2";
  stage: "diagnose" | "prescribe";
  // 只登记当前在用的版本号（历史版本不保留）。M04 升到 v2 是因为 nonPharma 的 monitoring 三元组
  // 已换成自由文本 precautions，签名载荷字段集随之变化；在途快照会因版本不匹配确定性失效并
  // fail-closed 转人工复核，而不是表现为难以解释的 HMAC 不符。
  contractSignatureVersion?: "tcm-cdss-m03-signature-v4" | "tcm-cdss-m04-signature-v2";
  contractSignature?: string;
  clinicalReview?: ClinicalReviewAttestation;
  terminologyMappings?: ControlledTerminologyMappingTrace[];
  completeness?: Completeness;
  overview: {
    tcmDiseaseName?: string;
    primarySyndrome: string;
    primarySyndromeResolution: ClinicalResolution;
    primarySyndromeBasis: string[];
    primarySyndromeResolutionReason?: string;
    // 需求3：诊断分三段——西医诊断（含 ICD-10 关联）、中医辨病、中医辨证候，各自给出推理过程。
    // 辨病与辨证是两个不同的判断：辨病回答「这组表现属于哪个中医病名范畴」（病名归属，看主症
    // 特征与病程形态），辨证回答「当前是该病的哪一证型」（证候归属，看四诊合参与病机）。
    // 它们此前共用 tcmDiagnosticRationale 一个字段，结果是病名归属的理由被证型推理挤掉——
    // 医生看到「不寐」却读不到为什么把这组表现归入不寐而不是郁病或心悸。
    // tcmDiagnosticRationale 保留承担**辨证**（它现有的 restatement 契约检查正是为辨证写的），
    // 辨病另起 tcmDiseaseRationale。
    tcmDiseaseRationale?: string;
    tcmDiagnosticRationale?: string;
    tcmDifferentials?: Array<{
      syndrome: string;
      reason: string;
      distinguishingPoints: string;
      nextCheck: string | null;
    }>;
    secondarySyndromes?: string[];
    overallPathogenesis: string;
    overallTherapy: string;
    recommendedFormulaDirection: string;
    recommendedFormulaNames?: string[];
    formulaSelectionMode?: "single" | "combined" | "alternatives" | "self_devised" | "none";
    deferredFormulaSelection?: {
      direction: string;
      names: string[];
      mode: "single" | "combined" | "alternatives";
      reason: "semantic_mapping_pending_clinician_confirmation";
    };
    evidence: EvidenceRef;
  };
  westernDiagnosis: {
    primary: {
      name: string;
      coding?: {
        system: "ICD-10";
        code: string;
        display: string;
        source: string;
      };
      status: "考虑" | "需排除" | "证据有限";
      confidence: "高" | "中" | "低";
      supportingFacts: string[];
      clinicalRationale?: string;
      limitations: string[];
      suggestedChecks: string[];
      evidence: EvidenceRef;
    };
    differentials: Array<{
      name: string;
      reason: string;
      distinguishingPoints?: string;
      nextCheck: string | null;
    }>;
  };
  pathogenesis: {
    summary: string;
    locationDifferentiation: {
      items: string[];
      details?: Array<{ location: string; basis: string }>;
      resolution: ClinicalResolution;
      resolutionReason?: string;
      evidence: EvidenceRef;
    };
    natureDifferentiation: {
      items: string[];
      rootDeficiency?: string[];
      branchExcess?: string[];
      basis?: string;
      resolution: ClinicalResolution;
      resolutionReason?: string;
      evidence: EvidenceRef;
    };
    symptomClusters?: Array<{
      symptoms: string[];
      mechanism: string;
    }>;
    caseRelationship?: {
      rootPattern: string;
      mainManifestation: string;
      relationship: string;
    };
    chain: Array<{
      nodeId?: string;
      patientFact: string;
      syndromeEvidence: string;
      pathogenesis: string;
      therapyDirection: string;
      pathogenesisType?: "始动" | "传变" | "兼夹" | "因果";
      biaoBen?: "本" | "标" | "标本兼夹";
      evidence: EvidenceRef;
    }>;
    uncertainties: Array<{ item: string; reason: string; affects: string }>;
  };
  therapy: {
    overallPrinciple: string;
    overallMethod?: string;
    subTherapies: Array<{
      therapy: string;
      targetPathogenesis: string;
      priority: "主要" | "次要";
      evidence: EvidenceRef;
    }>;
  };
  formula: null | {
    candidates: Array<{
      name: string;
      formulaNames?: string[];
      positioning: "首选" | "备选" | "仅学术思路";
      constructionType?: "single_base" | "combined" | "self_devised" | "single_herb";
      modificationStatus?: "canonical" | "modified";
      identityDeclassified?: boolean;
      identityDeclassificationReason?: "classic_composition_unverified_after_repair";
      baseFormulas?: Array<{
        name: string;
        source: string;
        matchedIngredientCount: number;
        totalIngredientCount?: number;
        minimumPreservedIngredientCount?: number;
        matchedRequiredIngredientCount?: number;
        requiredIngredientCount?: number;
        verificationStatus?: "verified_individually";
      }>;
      discriminationPath?: Array<{
        againstFormula: string;
        question: string;
        status: "confirmed" | "absent" | "unknown";
        sourceRef: string;
      }>;
      classicEvidence?: Array<{
        evidenceId: string;
        citation: string;
        anchorLevel: "tiaowen" | "chapter_paragraph" | "page_paragraph";
        clauseNumber?: number;
        excerpt: string;
        tier: "canon" | "common" | "experience";
      }>;
      compositionLogic?: Array<{
        formulaName: string;
        summary: string;
        tier: "common" | "experience";
        sourceRefs: string[];
      }>;
      textualModifications?: Array<{
        ruleId: string;
        baseFormula: string;
        matchedTriggers: string[];
        resultingFormula?: string;
        addHerbs: string[];
        removeHerbs: string[];
        sourceEvidenceId: string;
        sourceCitation: string;
        evidenceAnchorLevel: "tiaowen" | "chapter_paragraph" | "page_paragraph";
        tier: "canon" | "common" | "experience";
        requiresClinicianReview: true;
      }>;
      formulaSource: EvidenceRef;
      therapyMatch: string;
      applicable: string;
      notApplicable: string;
      herbs: Array<{
        name: string;
        processing: string | null;
        dose: string | null;
        role: "君" | "臣" | "佐" | "使";
        prescriptionRole: string;
        targetKind?: "pathogenesis_node" | "formula_structure";
        targetRef?: string;
        structureRole?: "middle_jiao_support" | "harmonize" | "guide" | "temper" | null;
        targetPathogenesis: string;
        function: string;
        isToxic?: boolean;
        decoctionRequirement?: string;
        verificationTier?: "verified" | "unverified_dose" | "identity_pending" | "toxic_regulated";
        doseSource?: "governed_boundary" | "classical_source" | "none";
        verificationReasons?: string[];
        evidence: EvidenceRef;
      }>;
      formulaAnalysis: string;
      decoction: {
        doseCount: string | null;
        method: string;
        course: string;
        followUpNode: string;
        dosesPerDay: number;
        administrationTimesPerDay: number;
        soakMinutes?: number;
        decoctionTimes?: number;
        firstDecoctionMinutes?: number;
        secondDecoctionMinutes?: number;
        targetVolumeMl?: number;
        administration?: string;
        followUpAfterDoses?: number;
        followUpAfterDays?: number;
      };
    }>;
    patentAndWestern: Array<{
      type: "西药" | "中成药";
      name: string;
      specification: string | null;
      evidenceId?: string;
      evidenceFingerprint?: string;
      recommendationMode?: "candidate_review" | "discussion_only";
      singleDose?: string;
      frequency?: string;
      route?: string;
      usageBoundary: string;
      course: string;
      positioning: "联合治疗" | "替代方案" | "短期对症" | "需医生评估";
      correspondingProblem: string;
      evidence: EvidenceRef;
      relationship: string;
      riskNote: string;
    }> | null;
    medicineCandidateStatus?: {
      status: "available" | "no_evidence_match";
      reason: string;
    };
    modifications: Array<{
      trigger: string;
      triggerSource?: {
        kind: "primary_syndrome_basis" | "pathogenesis_patient_fact" | "western_supporting_fact";
        sourceRef: string;
        sourceQuote: string;
      };
      targetPathogenesis: string;
      action: string;
      doseOrHandling: string | null;
      reason: string;
      riskNote: string;
      evidence: EvidenceRef;
    }>;
    modificationReview?: {
      submittedCount: number;
      retainedCount: number;
      droppedCount: number;
      droppedReason: string | null;
      droppedReasons: Array<{ code: string; count: number; message: string }>;
    };
  };
  nonPharma: null | {
    diet: string;
    lifestyle: string;
    emotion: string;
    acupointCare: string | null;
    tcmTreatments: Array<{
      projectCode: TcmTreatmentProjectCode;
      projectName: string;
      availability: "clinic_available" | "referral_only";
      riskLevel: "low" | "moderate" | "specialist";
      recommendationMode: "clinician_assessment" | "referral_assessment" | "specialist_assessment_only";
      targetRef: string;
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
      containsMedication: boolean;
      requiresMedicationAudit: boolean;
      executable: boolean;
      clinicianReviewRequired: true;
    }>;
    // 注意事项（自由文本）。刻意不做 metric/timing/trigger 这类多字段语义分离：
    // 旧的 monitoring 三元组正是 5 个 M04 驳回码（monitoring_N_incomplete / _metric_semantics /
    // _trigger_semantics / _duplicate / _metric_ungrounded）的唯一产地，而这 5 个码在
    // structured-clinical-repair 里从来没有修复引导语，命中后模型只能盲目重采样直到编排
    // 超时把可用处方降级成受限输出。安全权威在 withSafetyGate 与 rxaudit，二者都不读这个字段，
    // 因此把它改成零驳回码的自由文本是净安全收益。「必有内容」由编译层确定性兜底提供。
    precautions: string[];
  };
  lineageAdaptation: null | {
    schemaVersion: "tcm-cdss-reasoning-v2";
    lineageCode: string;
    label: string;
    applicable: "applicable" | "partial" | "not-applicable";
    applicabilityReason: string;
    influencedDecisions: Array<{
      aspect: "辨证视角" | "方源选择" | "组方思路" | "加减风格";
      detail: string;
    }>;
    unaffectedBySafety: string[];
    alternativeDirection?: string;
    safetyDeference: string;
  };
  management?: null | {
    redFlagLoop?: string;
    mustCollect?: string[];
    followupSafetyNet?: string;
  };
}

export interface TongueDiagnosisResult {
  schemaVersion: "tongue-dx-v1";
  quality: { score: number; issues: string[]; needRetake: boolean };
  tongueBody: {
    color: string | null;
    shape: string[];
    posture: string[];
  } | null;
  coating: {
    color: string | null;
    thickness: string | null;
    moisture: string | null;
    greasiness: string | null;
    peeling: string | null;
  } | null;
  sublingualVeins: {
    color: string | null;
    distension: string | null;
    source: "image" | "manual" | null;
  } | null;
  clinicalEvidenceLevel: "supportive" | "reference-only" | "insufficient";
  summaryText: string;
}

export interface FaceCaptureResult {
  schemaVersion: "face-capture-v1";
  quality: { score: number; issues: string[]; needRetake: boolean };
  complexion: string[];
  spirit: string[];
  shape: string[];
  notes: string;
  clinicalEvidenceLevel: "reference-only" | "insufficient";
  updatedAt: string;
}

export const CompletenessSchema = z.object({
  level: z.enum(["A", "B", "C"]),
  redFlag: z.number().min(0).max(1),
  infoGain: z.number().min(0).max(1),
  managementImpact: z.number().min(0).max(1),
  answerability: z.number().min(0).max(1),
});

const PhaseSchema = z.enum(["idle", "collect", "question", "diagnose", "prescribe", "assess", "done", "error"]);
const MAX_TEXT_FIELD_CHARS = 6000;
const MAX_RAW_TEXT_CHARS = 12000;
const MAX_MODEL_OUTPUT_CHARS = 30000;
const MAX_CONVERSATION_ITEMS = 10;
const MAX_CONVERSATION_CHARS = 2000;

const EvidenceRefSchema = z.object({
  evidenceLevel: z.enum(EVIDENCE_LEVELS).catch("insufficient"),
  source: z.string().max(800).catch("内部证据缺口"),
  confidence: z.preprocess(normalizeClinicalConfidence, z.enum(["高", "中", "低"])).optional().catch(undefined),
});

export function normalizePrescriptionRole(value: unknown): unknown {
  const text = Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value.join("")
    : value;
  if (typeof text !== "string") return value;
  const roleLabel = text.trim().split(/[（(【\[：:_-]/, 1)[0];
  const compact = roleLabel.replace(/[\s、，,/]+/g, "").replaceAll("药", "");
  if (!/^[君臣佐使](?:兼?[君臣佐使])*$/.test(compact)) return value;
  return compact[0];
}

const PrescriptionRoleSchema = z.preprocess(
  normalizePrescriptionRole,
  z.enum(["君", "臣", "佐", "使"]),
);

export function normalizeModelNullableText(value: unknown): unknown {
  if (value == null || value === "") return null;
  if (Array.isArray(value)) {
    const items = value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
    return items.length ? items.join("、") : null;
  }
  return value;
}

export function normalizeWesternDiagnosisStatus(value: unknown): unknown {
  if (typeof value !== "string") return "证据有限";
  const text = value.trim();
  if (/不考虑|不支持|未支持|尚未支持|不能证实|未能证实|无法判断|不能判断/.test(text)) return "证据有限";
  if (/排除|除外|警惕|优先排查/.test(text)) return "需排除";
  if (/考虑|倾向|疑似|可能|初步|支持|符合/.test(text)) return "考虑";
  if (/证据|信息|不确定|待查|待定|未明|不足|有限|无法判断/.test(text)) return "证据有限";
  return "证据有限";
}

export function normalizeClinicalConfidence(value: unknown): unknown {
  if (typeof value !== "string") return "低";
  const text = value.trim();
  if (/不高|较低|偏低|低|有限|不足|待评估|不确定/.test(text)) return "低";
  if (/很高|较高|高度|高/.test(text)) return "高";
  if (/中等|一般|中/.test(text)) return "中";
  return "低";
}

const INSUFFICIENT_EVIDENCE_REF: EvidenceRef = {
  evidenceLevel: "insufficient",
  source: "内部证据缺口",
  confidence: "低",
};

const DEFAULT_OVERVIEW: ClinicalReasoningResultV2["overview"] = {
  tcmDiseaseName: undefined,
  primarySyndrome: "尚未形成稳定证型",
  primarySyndromeResolution: "unresolved",
  primarySyndromeBasis: [],
  primarySyndromeResolutionReason: "结构化结果中没有可供判断的证型名称与可回溯依据",
  tcmDiseaseRationale: "",
  tcmDiagnosticRationale: "",
  tcmDifferentials: [],
  secondarySyndromes: [],
  overallPathogenesis: "病机链尚未稳定，需结合补充问诊后复核",
  overallTherapy: "暂不锁定剂量级治法",
  recommendedFormulaDirection: "暂不生成剂量级候选方药",
  recommendedFormulaNames: [],
  formulaSelectionMode: "none",
  evidence: INSUFFICIENT_EVIDENCE_REF,
};

const DEFAULT_PATHOGENESIS: ClinicalReasoningResultV2["pathogenesis"] = {
  summary: "病机链尚未稳定，需补充关键四诊与安全边界后复核。",
  locationDifferentiation: { items: [], details: [], resolution: "unresolved", resolutionReason: "结构化结果中没有病位分类及可回溯依据", evidence: INSUFFICIENT_EVIDENCE_REF },
  natureDifferentiation: { items: [], rootDeficiency: [], branchExcess: [], basis: "", resolution: "unresolved", resolutionReason: "结构化结果中没有病性分类及可回溯依据", evidence: INSUFFICIENT_EVIDENCE_REF },
  symptomClusters: [],
  caseRelationship: undefined,
  chain: [],
  uncertainties: [],
};

const DEFAULT_THERAPY: ClinicalReasoningResultV2["therapy"] = {
  overallPrinciple: "暂不锁定剂量级治法",
  overallMethod: undefined,
  subTherapies: [],
};

const DEFAULT_WESTERN_DIAGNOSIS: ClinicalReasoningResultV2["westernDiagnosis"] = {
  primary: {
    name: "症状性诊断，病因待临床鉴别",
    status: "证据有限",
    confidence: "低",
    supportingFacts: [],
    clinicalRationale: "",
    limitations: ["当前模型结果未形成可用的西医诊断区块"],
    suggestedChecks: [],
    evidence: INSUFFICIENT_EVIDENCE_REF,
  },
  differentials: [],
};

const ReasoningV2SchemaBase = z.object({
  schemaVersion: z.literal("tcm-cdss-reasoning-v2"),
  stage: z.enum(["diagnose", "prescribe"]),
  contractSignatureVersion: z.enum(["tcm-cdss-m03-signature-v4", "tcm-cdss-m04-signature-v2"]).optional().catch(undefined),
  contractSignature: z.string().max(160).optional().catch(undefined),
  clinicalReview: z.object({
    status: z.enum(["accepted", "unavailable"]),
    provider: z.string().max(100).optional().catch(undefined),
    model: z.string().max(200).optional().catch(undefined),
    source: z.enum(["preferred", "cross_model_fallback"]).optional().catch(undefined),
    reviewedPayloadHash: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional().catch(undefined),
  }).optional().catch(undefined),
  terminologyMappings: z.array(z.object({
    namespace: z.enum([
      "tcm_syndrome",
      "tcm_location",
      "tcm_nature",
      "tcm_treatment_principle",
      "tcm_formula",
      "medicine_clinical_concept",
      "icd10",
    ]),
    fieldPath: z.string().min(1).max(200),
    originalText: z.string().min(1).max(600),
    candidateId: z.string().min(1).max(160),
    canonical: z.string().min(1).max(600),
    resolvedBy: z.literal("deepseek_closed_set"),
    status: z.enum(["suggested", "clinician_confirmed"]),
    confidence: z.number().min(0).max(1),
    model: z.string().min(1).max(160),
    consensus: z.literal(true),
    cache: z.enum(["hit", "miss"]),
  })).max(20).optional().catch([]),
  completeness: CompletenessSchema.optional(),
  overview: z.object({
    tcmDiseaseName: z.string().min(1).max(300).optional().catch(undefined),
    primarySyndrome: z.string().max(1200),
    primarySyndromeResolution: z.enum(["resolved", "bounded", "unresolved"]).optional().catch(undefined),
    primarySyndromeBasis: z.array(z.string().min(1).max(600)).max(8).optional().catch([]),
    primarySyndromeResolutionReason: z.string().min(1).max(800).optional().catch(undefined),
    tcmDiseaseRationale: z.string().max(1200).optional().catch(""),
    tcmDiagnosticRationale: z.string().max(1600).optional().catch(""),
    tcmDifferentials: z.array(z.object({
      syndrome: z.string().min(1).max(300),
      reason: z.string().min(2).max(1000),
      distinguishingPoints: z.string().min(2).max(1000),
      nextCheck: z.preprocess(normalizeModelNullableText, z.string().max(600).nullable()),
    })).max(6).optional().catch([]),
    secondarySyndromes: z.array(z.string().min(1).max(300)).max(6).optional().catch([]),
    overallPathogenesis: z.string().max(2000),
    overallTherapy: z.string().max(1200),
    recommendedFormulaDirection: z.string().max(1200),
    recommendedFormulaNames: z.array(z.string().max(300)).max(4).optional().catch([]),
    formulaSelectionMode: z.enum(["single", "combined", "alternatives", "self_devised", "none"]).optional().catch("none"),
    deferredFormulaSelection: z.object({
      direction: z.string().min(1).max(1200),
      names: z.array(z.string().min(1).max(300)).min(1).max(4),
      mode: z.enum(["single", "combined", "alternatives"]),
      reason: z.literal("semantic_mapping_pending_clinician_confirmation"),
    }).optional().catch(undefined),
    evidence: EvidenceRefSchema,
  }).catch(DEFAULT_OVERVIEW),
  westernDiagnosis: z.object({
    primary: z.object({
      name: z.string().min(2).max(600).catch(DEFAULT_WESTERN_DIAGNOSIS.primary.name),
      coding: z.object({
        system: z.literal("ICD-10"),
        code: z.string().refine(isSupportedIcd10PayerCode, "invalid governed ICD-10 payer code"),
        display: z.string().min(2).max(600),
        source: z.string().min(2).max(300),
      }).optional().catch(undefined),
      status: z.preprocess(normalizeWesternDiagnosisStatus, z.enum(["考虑", "需排除", "证据有限"])),
      confidence: z.preprocess(normalizeClinicalConfidence, z.enum(["高", "中", "低"])),
      supportingFacts: z.array(z.string().min(1).max(600)).max(12).catch([]),
      clinicalRationale: z.string().max(1600).optional().catch(""),
      limitations: z.array(z.string().max(600)).max(12).catch([]),
      suggestedChecks: z.array(z.string().max(600)).max(12).catch([]),
      evidence: EvidenceRefSchema.catch(INSUFFICIENT_EVIDENCE_REF),
    }).catch(DEFAULT_WESTERN_DIAGNOSIS.primary),
    differentials: z.array(z.object({
      name: z.string().max(600),
      reason: z.string().max(1000),
      distinguishingPoints: z.string().max(1000).optional().catch(""),
      nextCheck: z.preprocess(normalizeModelNullableText, z.string().max(600).nullable()),
    })).max(8).catch([]),
  }).catch(DEFAULT_WESTERN_DIAGNOSIS),
  pathogenesis: z.object({
    summary: z.string().max(3000).catch(""),
    locationDifferentiation: z.object({
      items: z.array(z.string().max(200)).max(16).default([]),
      details: z.array(z.object({
        location: z.string().min(1).max(200),
        basis: z.string().min(1).max(800),
      })).max(8).optional().catch([]),
      resolution: z.enum(["resolved", "bounded", "unresolved"]).optional().catch(undefined),
      resolutionReason: z.string().min(1).max(800).optional().catch(undefined),
      evidence: EvidenceRefSchema.catch(INSUFFICIENT_EVIDENCE_REF),
    }).catch(DEFAULT_PATHOGENESIS.locationDifferentiation),
    natureDifferentiation: z.object({
      items: z.array(z.string().max(200)).max(16).default([]),
      rootDeficiency: z.array(z.string().min(1).max(200)).max(8).optional().catch([]),
      branchExcess: z.array(z.string().min(1).max(200)).max(8).optional().catch([]),
      basis: z.string().max(800).optional().catch(""),
      resolution: z.enum(["resolved", "bounded", "unresolved"]).optional().catch(undefined),
      resolutionReason: z.string().min(1).max(800).optional().catch(undefined),
      evidence: EvidenceRefSchema.catch(INSUFFICIENT_EVIDENCE_REF),
    }).catch(DEFAULT_PATHOGENESIS.natureDifferentiation),
    symptomClusters: z.array(z.object({
      symptoms: z.array(z.string().min(1).max(300)).min(1).max(8),
      mechanism: z.string().min(2).max(1000),
    })).max(6).optional().catch([]),
    caseRelationship: z.object({
      rootPattern: z.string().min(1).max(600),
      mainManifestation: z.string().min(1).max(300),
      relationship: z.string().min(1).max(1200),
    }).optional().catch(undefined),
    chain: z.array(z.object({
      nodeId: z.string().regex(/^P\d{1,2}$/).optional().catch(undefined),
      patientFact: z.string().max(1200).catch(""),
      syndromeEvidence: z.string().max(1200).catch(""),
      pathogenesis: z.string().max(1200).catch(""),
      therapyDirection: z.string().max(1200).catch(""),
      pathogenesisType: z.enum(["始动", "传变", "兼夹", "因果"]).optional().catch(undefined),
      biaoBen: z.enum(["本", "标", "标本兼夹"]).optional().catch(undefined),
      evidence: EvidenceRefSchema.catch(INSUFFICIENT_EVIDENCE_REF),
    })).max(12).default([]),
    uncertainties: z.array(z.object({
      item: z.string().max(600).catch(""),
      reason: z.string().max(1000).catch(""),
      affects: z.string().max(1000).catch(""),
    })).max(12).default([]),
  }).catch(DEFAULT_PATHOGENESIS),
  therapy: z.object({
    overallPrinciple: z.string().max(2000),
    overallMethod: z.string().max(2000).optional().catch(undefined),
    subTherapies: z.array(z.object({
      therapy: z.string().max(600),
      targetPathogenesis: z.string().max(600),
      priority: z.enum(["主要", "次要"]),
      evidence: EvidenceRefSchema,
    })).max(12).default([]),
  }).catch(DEFAULT_THERAPY),
  formula: z.object({
    candidates: z.array(z.object({
      name: z.string().max(300),
      formulaNames: z.array(z.string().max(300)).max(4).optional().catch([]),
      positioning: z.enum(["首选", "备选", "仅学术思路"]),
      constructionType: z.enum(["single_base", "combined", "self_devised", "single_herb"]).optional(),
      modificationStatus: z.enum(["canonical", "modified"]).optional(),
      identityDeclassified: z.boolean().optional().catch(undefined),
      identityDeclassificationReason: z.literal("classic_composition_unverified_after_repair").optional().catch(undefined),
      baseFormulas: z.array(z.object({
        name: z.string().max(300).catch(""),
        source: z.string().max(800).catch(""),
        matchedIngredientCount: z.number().int().min(0).max(100).catch(0),
        totalIngredientCount: z.number().int().min(1).max(100).optional(),
        minimumPreservedIngredientCount: z.number().int().min(1).max(100).optional(),
        matchedRequiredIngredientCount: z.number().int().min(0).max(100).optional(),
        requiredIngredientCount: z.number().int().min(0).max(100).optional(),
        verificationStatus: z.literal("verified_individually").optional(),
      })).max(4).optional(),
      discriminationPath: z.array(z.object({
        againstFormula: z.string().min(1).max(300),
        question: z.string().min(1).max(800),
        status: z.enum(["confirmed", "absent", "unknown"]),
        sourceRef: z.string().min(1).max(500),
      })).max(6).optional().catch([]),
      classicEvidence: z.array(z.object({
        evidenceId: z.string().min(1).max(100),
        citation: z.string().min(1).max(300),
        anchorLevel: z.enum(["tiaowen", "chapter_paragraph", "page_paragraph"]),
        clauseNumber: z.number().int().min(1).max(500).optional(),
        excerpt: z.string().min(1).max(600),
        tier: z.enum(["canon", "common", "experience"]),
      })).max(6).optional().catch([]),
      compositionLogic: z.array(z.object({
        formulaName: z.string().min(1).max(300),
        summary: z.string().min(1).max(1200),
        tier: z.enum(["common", "experience"]),
        sourceRefs: z.array(z.string().min(1).max(500)).min(1).max(6),
      })).max(4).optional().catch([]),
      textualModifications: z.array(z.object({
        ruleId: z.string().min(1).max(100),
        baseFormula: z.string().min(1).max(300),
        matchedTriggers: z.array(z.string().min(1).max(100)).min(1).max(8),
        resultingFormula: z.string().min(1).max(300).optional(),
        addHerbs: z.array(z.string().min(1).max(120)).max(8),
        removeHerbs: z.array(z.string().min(1).max(120)).max(8),
        sourceEvidenceId: z.string().min(1).max(100),
        sourceCitation: z.string().min(1).max(300),
        evidenceAnchorLevel: z.enum(["tiaowen", "chapter_paragraph", "page_paragraph"]),
        tier: z.enum(["canon", "common", "experience"]),
        requiresClinicianReview: z.literal(true),
      })).max(6).optional().catch([]),
      formulaSource: EvidenceRefSchema.catch(INSUFFICIENT_EVIDENCE_REF),
      therapyMatch: z.string().max(1200).catch(""),
      applicable: z.string().max(1200).catch(""),
      notApplicable: z.string().max(1200).catch(""),
      herbs: z.array(z.object({
        name: z.string().max(120),
        processing: z.preprocess(normalizeModelNullableText, z.string().max(120).nullable()),
        dose: z.string().max(120).nullable(),
        role: PrescriptionRoleSchema,
        prescriptionRole: z.string().max(300),
        targetKind: z.enum(["pathogenesis_node", "formula_structure"]).optional().catch(undefined),
        targetRef: z.string().max(20).optional().catch(undefined),
        structureRole: z.enum(["middle_jiao_support", "harmonize", "guide", "temper"]).nullable().optional().catch(undefined),
        targetPathogenesis: z.string().max(600),
        function: z.string().max(800),
        isToxic: z.boolean().optional(),
        decoctionRequirement: z.preprocess(
          normalizeModelNullableText,
          z.string().max(200).nullable().optional(),
        ).transform((value) => value ?? undefined),
        verificationTier: z.enum(["verified", "unverified_dose", "identity_pending", "toxic_regulated"]).optional(),
        doseSource: z.enum(["governed_boundary", "classical_source", "none"]).optional(),
        verificationReasons: z.array(z.string().min(1).max(500)).max(8).optional().catch(undefined),
        evidence: EvidenceRefSchema.catch(INSUFFICIENT_EVIDENCE_REF),
      })).max(50).default([]),
      formulaAnalysis: z.string().max(4000).catch(""),
      decoction: z.object({
        doseCount: z.string().max(120).nullable(),
        method: z.string().max(1000),
        course: z.string().max(1000),
        followUpNode: z.string().max(1000),
        dosesPerDay: z.number().int().min(1).max(3),
        administrationTimesPerDay: z.number().int().min(1).max(6),
        soakMinutes: z.number().int().min(0).max(120).optional(),
        decoctionTimes: z.number().int().min(1).max(4).optional(),
        firstDecoctionMinutes: z.number().int().min(1).max(180).optional(),
        secondDecoctionMinutes: z.number().int().min(1).max(180).optional(),
        targetVolumeMl: z.number().int().min(50).max(3000).optional(),
        administration: z.string().max(300).optional(),
        followUpAfterDoses: z.number().int().min(1).max(30).optional(),
        followUpAfterDays: z.number().int().min(1).max(90).optional(),
      }),
    })).max(3).default([]),
    patentAndWestern: z.array(z.object({
      type: z.enum(["西药", "中成药"]),
      name: z.string().max(300),
      specification: z.preprocess(normalizeModelNullableText, z.string().max(300).nullable()),
      evidenceId: z.string().max(80).optional(),
      evidenceFingerprint: z.string().max(100).optional(),
      recommendationMode: z.enum(["candidate_review", "discussion_only"]).optional(),
      singleDose: z.string().max(300).optional(),
      frequency: z.string().max(300).optional(),
      route: z.string().max(300).optional(),
      usageBoundary: z.string().max(800),
      course: z.string().max(500),
      positioning: z.enum(["联合治疗", "替代方案", "短期对症", "需医生评估"]),
      correspondingProblem: z.string().max(800),
      evidence: EvidenceRefSchema.catch(INSUFFICIENT_EVIDENCE_REF),
      relationship: z.string().max(800),
      riskNote: z.string().max(1000),
    })).max(8).nullable().catch(null),
    medicineCandidateStatus: z.object({
      status: z.enum(["available", "no_evidence_match"]),
      reason: z.string().max(500),
    }).optional(),
    modifications: z.array(z.object({
      trigger: z.string().max(800),
      triggerSource: z.object({
        kind: z.enum(["primary_syndrome_basis", "pathogenesis_patient_fact", "western_supporting_fact"]),
        sourceRef: z.string().min(1).max(120),
        sourceQuote: z.string().min(1).max(600),
      }).optional(),
      targetPathogenesis: z.string().max(600).nullable().transform((value) => value ?? ""),
      action: z.string().max(600),
      doseOrHandling: z.string().max(300).nullable(),
      reason: z.string().max(1200),
      riskNote: z.string().max(1200).nullable().transform((value) => value ?? ""),
      evidence: EvidenceRefSchema.catch(INSUFFICIENT_EVIDENCE_REF),
    })).max(30).default([]),
    modificationReview: z.object({
      submittedCount: z.number().int().min(0).max(30),
      retainedCount: z.number().int().min(0).max(30),
      droppedCount: z.number().int().min(0).max(30),
      droppedReason: z.string().max(1200).nullable(),
      droppedReasons: z.array(z.object({
        code: z.string().min(1).max(80),
        count: z.number().int().min(1).max(30),
        message: z.string().min(1).max(300),
      })).max(12),
    }).optional(),
  }).nullable(),
  nonPharma: z.object({
    diet: z.string().max(1600),
    lifestyle: z.string().max(1600),
    emotion: z.string().max(1600),
    acupointCare: z.string().max(1600).nullable().catch(null),
    tcmTreatments: z.array(z.object({
      projectCode: z.enum(TCM_TREATMENT_PROJECT_CODES),
      projectName: z.string().min(1).max(120),
      availability: z.enum(["clinic_available", "referral_only"]),
      riskLevel: z.enum(["low", "moderate", "specialist"]),
      recommendationMode: z.enum(["clinician_assessment", "referral_assessment", "specialist_assessment_only"]),
      targetRef: z.string().regex(/^P\d{1,2}$/),
      targetPathogenesis: z.string().min(1).max(600),
      assessmentPositioning: z.string().min(1).max(800).optional(),
      protocolStatus: z.enum(["governed_patient_specific_plan", "assessment_only_no_patient_specific_protocol"]),
      protocolGap: z.string().min(1).max(800).optional(),
      treatmentContent: z.string().min(1).max(1200),
      suggestedSitesOrPoints: z.array(z.string().min(1).max(200)).max(12),
      scheduleSuggestion: z.string().max(600),
      techniqueBoundary: z.string().min(1).max(1000),
      protocolSource: z.string().min(1).max(1000),
      operatorRequirement: z.string().min(1).max(600),
      requiredChecks: z.array(z.string().min(1).max(600)).min(1).max(8),
      containsMedication: z.boolean().catch(false),
      requiresMedicationAudit: z.boolean().catch(false),
      executable: z.boolean(),
      clinicianReviewRequired: z.literal(true),
    })).max(3).default([]),
    // `.default([]).catch([])` 双保险：旧快照（含 monitoring、无 precautions）在 normalize 时
    // 静默补 []，类型非法时归零而不是让整个 nonPharma 落到下面的 `.nullable().catch(null)`
    // ——后者会连带丢掉 diet/lifestyle/emotion。旧的 monitoring 键因 nonPharma 不是 strict
    // object 而被静默剥离，不产生任何拒绝。
    precautions: z.array(z.string().max(200)).max(6).default([]).catch([]),
  }).nullable().catch(null),
  lineageAdaptation: z.object({
    schemaVersion: z.literal("tcm-cdss-reasoning-v2"),
    lineageCode: z.string().max(80),
    label: z.string().max(120),
    applicable: z.enum(["applicable", "partial", "not-applicable"]).catch("partial"),
    applicabilityReason: z.string().max(1600),
    influencedDecisions: z.array(z.object({
      aspect: z.enum(["辨证视角", "方源选择", "组方思路", "加减风格"]),
      detail: z.string().max(1000),
    })).max(12).default([]),
    unaffectedBySafety: z.array(z.string().max(600)).max(12).default([]),
    alternativeDirection: z.string().max(1200).optional(),
    safetyDeference: z.string().max(1200),
  }).nullable().catch(null),
  management: z.object({
    redFlagLoop: z.string().max(1600).optional(),
    mustCollect: z.array(z.string().max(300)).max(20).default([]).optional(),
    followupSafetyNet: z.string().max(1600).optional(),
  }).nullable().optional().catch(null),
});

export const ReasoningV2Schema = ReasoningV2SchemaBase;

const TongueDxSchema = z.object({
  schemaVersion: z.literal("tongue-dx-v1").catch("tongue-dx-v1"),
  quality: z.object({
    score: z.number().min(0).max(1).catch(0),
    issues: z.array(z.string().max(80)).max(12).default([]),
    needRetake: z.boolean().catch(false),
  }),
  tongueBody: z.object({
    color: z.string().max(80).nullable().catch(null),
    shape: z.array(z.string().max(80)).max(12).default([]),
    posture: z.array(z.string().max(80)).max(12).default([]),
  }).nullable().catch(null),
  coating: z.object({
    color: z.string().max(80).nullable().catch(null),
    thickness: z.string().max(80).nullable().catch(null),
    moisture: z.string().max(80).nullable().catch(null),
    greasiness: z.string().max(80).nullable().catch(null),
    peeling: z.string().max(80).nullable().catch(null),
  }).nullable().catch(null),
  sublingualVeins: z.object({
    color: z.string().max(80).nullable().catch(null),
    distension: z.string().max(120).nullable().catch(null),
    source: z.enum(["image", "manual"]).nullable().catch(null),
  }).nullable().catch(null),
  clinicalEvidenceLevel: z.enum(["supportive", "reference-only", "insufficient"]).catch("insufficient"),
  summaryText: z.string().max(1200).catch(""),
});

const FaceCaptureSchema = z.object({
  schemaVersion: z.literal("face-capture-v1").catch("face-capture-v1"),
  quality: z.object({
    score: z.number().min(0).max(1).catch(0),
    issues: z.array(z.string().max(80)).max(12).default([]),
    needRetake: z.boolean().catch(false),
  }),
  complexion: z.array(z.string().max(80)).max(12).default([]),
  spirit: z.array(z.string().max(80)).max(12).default([]),
  shape: z.array(z.string().max(80)).max(12).default([]),
  notes: z.string().max(1200).catch(""),
  clinicalEvidenceLevel: z.enum(["reference-only", "insufficient"]).catch("reference-only"),
  updatedAt: z.string().max(80).catch(""),
});

function clamp01(value: unknown): number {
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? Math.min(Math.max(num, 0), 1) : 0;
}

function limitString(value: string, max = MAX_TEXT_FIELD_CHARS): string {
  return value.length > max ? `${value.slice(0, max)}\n[内容已按接口预算截断]` : value;
}

function stringValue(value: unknown, max = MAX_TEXT_FIELD_CHARS): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return limitString(value.trim(), max);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function numberValue(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const num = typeof value === "number" ? value : Number(String(value).replace(/[^\d.]/g, ""));
  return Number.isFinite(num) ? num : undefined;
}

export function ageValue(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 && value <= 130 ? value : undefined;
  }

  const text = String(value).trim();
  if (!text) return undefined;

  const yearMatch = text.match(/(\d+(?:\.\d+)?)\s*岁/);
  if (yearMatch) {
    const years = Number(yearMatch[1]);
    return Number.isFinite(years) && years >= 0 && years <= 130 ? years : undefined;
  }

  const monthMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:个)?月/);
  if (monthMatch) {
    const months = Number(monthMatch[1]);
    return Number.isFinite(months) && months >= 0 ? months / 12 : undefined;
  }

  const dayMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:天|日)/);
  if (dayMatch) {
    const days = Number(dayMatch[1]);
    return Number.isFinite(days) && days >= 0 ? days / 365 : undefined;
  }

  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const years = Number(text);
    return Number.isFinite(years) && years >= 0 && years <= 130 ? years : undefined;
  }

  return undefined;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

const HisFieldsInputSchema = z.object({
  patientName: z.unknown().optional(),
  sex: z.unknown().optional(),
  age: z.unknown().optional(),
  zhushu: z.unknown().optional(),
  xianbingshi: z.unknown().optional(),
  jiwangshi: z.unknown().optional(),
  guomin: z.unknown().optional(),
  yongyaoshi: z.unknown().optional(),
  vitalsT: z.unknown().optional(),
  vitalsP: z.unknown().optional(),
  vitalsR: z.unknown().optional(),
  vitalsBP: z.unknown().optional(),
  vitalsDetail: z.unknown().optional(),
  tcmFace: z.unknown().optional(),
  tcmPulse: z.unknown().optional(),
  tcmTongue: z.unknown().optional(),
  tcmDetail: z.unknown().optional(),
  tcmLineagePreference: z.unknown().optional(),
  clinicTreatmentCapabilities: z.unknown().optional(),
  fuzhuJiancha: z.unknown().optional(),
  extraText: z.unknown().optional(),
}).partial().catch({});

const HisRecordInputSchema = z.object({
  schemaVersion: z.unknown().optional(),
  source: z.unknown().optional(),
  caseId: z.unknown().optional(),
  updatedAt: z.unknown().optional(),
  tongueImageUploaded: z.unknown().optional(),
  fields: HisFieldsInputSchema.optional(),
  rawText: z.unknown().optional(),
}).partial().passthrough();

const SafetyGateInputSchema = z.object({
  status: z.enum(["ready", "needs_information", "red_flag"]),
  allowDiagnosis: z.boolean(),
  allowDosePrescription: z.boolean(),
  action: z.enum(["proceed", "complete_before_prescription", "refer_or_emergency"]),
  missingItems: z.array(z.string()).default([]),
  missingItemCodes: z.array(z.enum([
    "chief_complaint", "age_invalid", "age_conflict", "sex_unknown", "allergy_unknown", "allergy_details",
    "medication_unknown", "medication_details", "blood_pressure_invalid", "vitals_invalid", "vitals_source_conflict",
    "semantic_screen_unavailable", "priority_evaluation_required", "high_risk_missing_vitals", "tongue_unknown", "pulse_unknown",
    "pediatric_weight_unknown", "pediatric_dose_rules_unavailable", "pregnancy_unknown", "lactation_unknown",
    "conception_unknown", "behavioral_crisis_screening", "osa_screening", "thyroid_screening",
  ])).default([]),
  redFlags: z.array(z.string()).default([]),
  redFlagFindings: z.array(z.object({
    ruleId: z.string().min(1).max(100),
    severity: z.literal("emergency"),
    sourceQuote: z.string().min(1).max(500),
    ruleExplanation: z.string().min(1).max(500),
    message: z.string().min(1).max(1000),
  })).max(20).default([]),
  advisories: z.array(z.string()).default([]),
  semanticTriage: z.object({
    level: z.enum(["emergency_review", "priority_review"]),
    findings: z.array(z.string()).min(1).max(20),
    evidence: z.array(z.object({
      category: z.string().min(1).max(80),
      sourceQuote: z.string().min(1).max(240),
      escalationRationale: z.string().min(1).max(600).optional(),
      evidenceQuotes: z.array(z.string().min(1).max(200)).max(8).default([]),
    })).max(20).optional(),
  }).optional(),
  reasons: z.array(z.string()).default([]),
}).partial().catch({});

const CaseStateInputSchema = z.object({
  id: z.unknown().optional(),
  phase: PhaseSchema.optional(),
  patient: z.unknown().optional(),
  chiefComplaint: z.unknown().optional(),
  symptoms: z.unknown().optional(),
  tongue: z.unknown().optional(),
  pulse: z.unknown().optional(),
  faceNote: z.unknown().optional(),
  tongueImageDesc: z.unknown().optional(),
  tongueDx: z.unknown().optional(),
  faceCapture: z.unknown().optional(),
  vitals: z.unknown().optional(),
  pastHistory: z.unknown().optional(),
  medicationHistory: z.unknown().optional(),
  allergyHistory: z.unknown().optional(),
  tcmLineagePreference: z.unknown().optional(),
  clinicTreatmentCapabilities: z.unknown().optional(),
  hisRecord: HisRecordInputSchema.optional(),
  safetyGate: SafetyGateInputSchema.optional(),
  clinicalFacts: z.unknown().optional(),
  emergencyClearance: z.unknown().optional(),
  warningAcknowledgement: z.unknown().optional(),
  completeness: z.unknown().optional(),
  questionRounds: z.unknown().optional(),
  questionOutcome: z.unknown().optional(),
  maxQuestionRounds: z.unknown().optional(),
  conversation: z.unknown().optional(),
  diagnosis: z.unknown().optional(),
  prescription: z.unknown().optional(),
  riskAssessment: z.unknown().optional(),
  followupTimeline: z.unknown().optional(),
  previousResult: z.unknown().optional(),
  auditAdvisory: z.unknown().optional(),
  reasoningDiagnose: z.unknown().optional(),
  reasoningPrescribe: z.unknown().optional(),
  reasoningV2: z.unknown().optional(),
  prescriptionRevision: z.unknown().optional(),
  skipDifferentiationGate: z.unknown().optional(),
  safetyLocked: z.unknown().optional(),
  lastError: z.unknown().optional(),
}).partial().passthrough();

const PrescriptionRevisionSchema = z.object({
  source: z.literal("herb_workbench"),
  candidateIndex: z.number().int().min(0).max(2),
  herbHash: z.string().min(1).max(80),
  auditedAt: z.string().min(1).max(80),
  auditResult: z.enum(["PASS", "REMIND", "MANUAL_REVIEW", "BLOCK"]),
  highestRiskLevel: z.enum(["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"]),
  auditAvailable: z.boolean().optional(),
  degraded: z.boolean().optional(),
  degradeReason: z.string().max(500).optional(),
  needManualReview: z.boolean().optional(),
  auditReason: z.string().max(500).optional(),
  auditId: z.string().max(200).optional(),
  traceId: z.string().max(200).optional(),
});

function normalizePrescriptionRevision(value: unknown): CaseState["prescriptionRevision"] {
  const parsed = PrescriptionRevisionSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function normalizeAuditAdvisory(value: unknown): CaseState["auditAdvisory"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.available !== "boolean") return undefined;
  const reason = raw.reason === "no_prescription_items" || raw.reason === "service_unavailable" ? raw.reason : undefined;
  return { available: raw.available, reason };
}

function normalizePreviousResult(value: unknown): CaseState["previousResult"] {
  const raw = recordValue(value);
  const diagnosis = stringValue(raw.diagnosis, MAX_MODEL_OUTPUT_CHARS);
  const prescription = stringValue(raw.prescription, MAX_MODEL_OUTPUT_CHARS);
  const riskAssessment = stringValue(raw.riskAssessment, MAX_MODEL_OUTPUT_CHARS);
  const capturedAt = stringValue(raw.capturedAt, 80);
  if ((!diagnosis && !prescription && !riskAssessment) || !capturedAt) return undefined;
  return { diagnosis, prescription, riskAssessment, capturedAt };
}

export function normalizeStructuredFollowupTimeline(value: unknown): StructuredFollowupTimelineItem[] {
  if (!Array.isArray(value)) return [];
  const items = value.flatMap((entry) => {
    const raw = recordValue(entry);
    const time = stringValue(raw.time, 120);
    const action = stringValue(raw.action, 400);
    const indicators = Array.isArray(raw.indicators)
      ? raw.indicators.flatMap((item) => stringValue(item, 400) || []).slice(0, 8)
      : [];
    const triggers = Array.isArray(raw.triggers)
      ? raw.triggers.flatMap((item) => stringValue(item, 600) || []).slice(0, 8)
      : [];
    return time && action && (indicators.length > 0 || triggers.length > 0)
      ? [{ time, action, indicators, triggers }]
      : [];
  }).slice(0, 8);
  return items;
}

function normalizeFollowupTimeline(value: unknown): StructuredFollowupTimelineItem[] | undefined {
  const items = normalizeStructuredFollowupTimeline(value);
  return items.length > 0 ? items : undefined;
}

export function createInitialCaseState(opts?: { maxQuestionRounds?: number }): CaseState {
  return {
    id: `case_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    phase: "idle",
    patient: {},
    chiefComplaint: "",
    symptoms: {},
    completeness: { level: "A", redFlag: 0, infoGain: 0, managementImpact: 0, answerability: 0 },
    questionRounds: 0,
    maxQuestionRounds: opts?.maxQuestionRounds ?? 1,
    conversation: [],
  };
}

function normalizeHisRecord(value: z.infer<typeof HisRecordInputSchema> | undefined, fallbackCaseId: string): HisRecordSnapshot | undefined {
  if (!value) return undefined;
  const fieldsInput = value.fields || {};
  const hasCapabilityRestriction = Object.prototype.hasOwnProperty.call(fieldsInput, "clinicTreatmentCapabilities");
  const fields: HisRecordSnapshot["fields"] = {
    patientName: stringValue(fieldsInput.patientName),
    sex: stringValue(fieldsInput.sex),
    age: stringValue(fieldsInput.age),
    zhushu: stringValue(fieldsInput.zhushu),
    xianbingshi: stringValue(fieldsInput.xianbingshi),
    jiwangshi: stringValue(fieldsInput.jiwangshi),
    guomin: stringValue(fieldsInput.guomin),
    yongyaoshi: stringValue(fieldsInput.yongyaoshi),
    vitalsT: stringValue(fieldsInput.vitalsT),
    vitalsP: stringValue(fieldsInput.vitalsP),
    vitalsR: stringValue(fieldsInput.vitalsR),
    vitalsBP: stringValue(fieldsInput.vitalsBP),
    vitalsDetail: stringValue(fieldsInput.vitalsDetail),
    tcmFace: stringValue(fieldsInput.tcmFace),
    tcmPulse: stringValue(fieldsInput.tcmPulse),
    tcmTongue: stringValue(fieldsInput.tcmTongue),
    tcmDetail: stringValue(fieldsInput.tcmDetail),
    tcmLineagePreference: stringValue(fieldsInput.tcmLineagePreference),
    ...(hasCapabilityRestriction
      ? { clinicTreatmentCapabilities: parseTcmTreatmentCapabilities(fieldsInput.clinicTreatmentCapabilities).join(",") }
      : {}),
    fuzhuJiancha: stringValue(fieldsInput.fuzhuJiancha),
    extraText: stringValue(fieldsInput.extraText),
  };

  return {
    schemaVersion: "tcm-cdss-his-v1",
    source: "tcm-cdss-his",
    caseId: stringValue(value.caseId) || fallbackCaseId,
    updatedAt: stringValue(value.updatedAt) || new Date().toISOString(),
    tongueImageUploaded: value.tongueImageUploaded === true || value.tongueImageUploaded === "true",
    fields,
    rawText: stringValue(value.rawText, MAX_RAW_TEXT_CHARS) || "",
  };
}

function normalizeCompleteness(value: unknown): Completeness {
  const input = recordValue(value);
  const scores = {
    redFlag: clamp01(input.redFlag),
    infoGain: clamp01(input.infoGain),
    managementImpact: clamp01(input.managementImpact),
    answerability: clamp01(input.answerability),
  };
  return {
    ...scores,
    level: determineCompletenessLevelFromScores(scores),
  };
}

function determineCompletenessLevelFromScores(
  scores: Pick<Completeness, "redFlag" | "infoGain" | "managementImpact" | "answerability">,
): "A" | "B" | "C" {
  if (scores.redFlag >= 0.7 && scores.infoGain >= 0.6 && scores.managementImpact >= 0.6 && scores.answerability >= 0.6) return "C";
  if (scores.redFlag < 0.3 || scores.infoGain < 0.3 || scores.managementImpact < 0.3 || scores.answerability < 0.3) return "A";
  return "B";
}

function normalizeSafetyGate(value: unknown): SafetyGate | undefined {
  const parsed = SafetyGateInputSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const gate = parsed.data;
  if (!gate.status || !gate.action) return undefined;
  return {
    status: gate.status,
    allowDiagnosis: Boolean(gate.allowDiagnosis),
    allowDosePrescription: Boolean(gate.allowDosePrescription),
    action: gate.action,
    missingItems: gate.missingItems || [],
    missingItemCodes: gate.missingItemCodes || [],
    redFlags: gate.redFlags || [],
    redFlagFindings: gate.redFlagFindings || [],
    advisories: gate.advisories || [],
    semanticTriage: gate.semanticTriage,
    reasons: gate.reasons || [],
  };
}

function normalizeConversation(value: unknown): CaseState["conversation"] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => recordValue(item))
    .map((item) => {
      const role = item.role === "assistant" ? "assistant" : item.role === "user" ? "user" : undefined;
      const content = stringValue(item.content, MAX_CONVERSATION_CHARS);
      return role && content ? { role, content } : null;
    })
    .filter((item): item is CaseState["conversation"][number] => Boolean(item))
    .slice(-MAX_CONVERSATION_ITEMS);
}

function normalizeTongueDx(value: unknown): TongueDiagnosisResult | undefined {
  const parsed = TongueDxSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const dx = parsed.data;
  const issues = dx.quality.issues || [];
  const needRetake =
    dx.quality.score < 0.6 ||
    issues.some((item) => /not_a_tongue|tongue_not_fully_extended|blurry|too_dark|too_bright|missing_tongue|模糊|过暗|过曝|未完整/.test(item));
  const summaryText = stringValue(dx.summaryText, 1200) || "";
  return {
    ...dx,
    quality: { ...dx.quality, needRetake },
    clinicalEvidenceLevel: needRetake ? "insufficient" : dx.clinicalEvidenceLevel,
    summaryText,
  };
}

function normalizeFaceCapture(value: unknown): FaceCaptureResult | undefined {
  const parsed = FaceCaptureSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const face = parsed.data;
  return {
    ...face,
    updatedAt: face.updatedAt || new Date().toISOString(),
    clinicalEvidenceLevel: face.quality.needRetake ? "insufficient" : face.clinicalEvidenceLevel,
  };
}

export function normalizeReasoningV2(value: unknown): ClinicalReasoningResultV2 | undefined {
  const parsed = ReasoningV2Schema.safeParse(value);
  if (!parsed.success) return undefined;
  const normalized = withCanonicalClinicalTerminology(parsed.data);
  const syndromeBasis = normalized.overview.primarySyndromeBasis || [];
  const syndromeResolution = normalized.overview.primarySyndromeResolution
    || (normalized.overview.primarySyndrome.trim() && syndromeBasis.length > 0 ? "resolved" : "bounded");
  const location = normalized.pathogenesis.locationDifferentiation;
  const locationResolution = location.resolution
    || (location.items.length === 0 ? "unresolved" : (location.details?.length || 0) > 0 ? "resolved" : "bounded");
  const nature = normalized.pathogenesis.natureDifferentiation;
  const natureResolution = nature.resolution
    || (nature.items.length === 0 && !(nature.rootDeficiency?.length || nature.branchExcess?.length)
      ? "unresolved"
      : nature.basis?.trim() ? "resolved" : "bounded");
  return {
    ...normalized,
    overview: {
      ...normalized.overview,
      primarySyndromeResolution: syndromeResolution,
      primarySyndromeBasis: syndromeBasis,
      primarySyndromeResolutionReason: normalized.overview.primarySyndromeResolutionReason
        || (syndromeResolution === "resolved"
          ? undefined
          : `证型“${normalized.overview.primarySyndrome || "未定"}”只有${syndromeBasis.length}条结构化可回溯依据`),
    },
    pathogenesis: {
      ...normalized.pathogenesis,
      locationDifferentiation: {
        ...location,
        resolution: locationResolution,
        resolutionReason: location.resolutionReason
          || (locationResolution === "resolved"
            ? undefined
            : locationResolution === "bounded"
              ? `病位“${location.items.join("、")}”只有${location.details?.length || 0}条结构化可回溯依据`
              : "结构化结果中没有病位分类及可回溯依据"),
      },
      natureDifferentiation: {
        ...nature,
        resolution: natureResolution,
        resolutionReason: nature.resolutionReason
          || (natureResolution === "resolved"
            ? undefined
            : natureResolution === "bounded"
              ? `病性“${[...nature.items, ...(nature.rootDeficiency || []), ...(nature.branchExcess || [])].join("、")}”缺少结构化可回溯依据`
              : "结构化结果中没有病性分类及可回溯依据"),
      },
    },
    therapy: {
      ...normalized.therapy,
      overallMethod: normalized.therapy.overallMethod || normalized.overview.overallTherapy,
    },
  };
}

export function reasoningV2SchemaIssueCode(value: unknown): string | undefined {
  const parsed = ReasoningV2Schema.safeParse(value);
  if (parsed.success) return undefined;
  const first = parsed.error.issues[0];
  const path = first?.path.map((part) => String(part).replace(/[^a-zA-Z0-9_-]/g, "_")).join("_") || "root";
  return `${first?.code || "invalid"}_${path}`.slice(0, 180);
}

function firstText(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = stringValue(value);
    if (text) return text;
  }
  return undefined;
}

function normalizeLastError(value: unknown): CaseState["lastError"] {
  const raw = recordValue(value);
  const phase = PhaseSchema.safeParse(raw.phase);
  const message = stringValue(raw.message, 2_000);
  return phase.success && message ? { phase: phase.data, message } : undefined;
}

function normalizeEncounterScopeConfirmation(value: unknown): CaseState["encounterScopeConfirmation"] {
  const raw = recordValue(value);
  const sourceFingerprint = stringValue(raw.sourceFingerprint, 128);
  const confirmedAt = stringValue(raw.confirmedAt, 64);
  if (!sourceFingerprint || !confirmedAt || !Number.isFinite(Date.parse(confirmedAt))) return undefined;
  return { sourceFingerprint, confirmedAt };
}

function normalizeEmergencyClearance(value: unknown): CaseState["emergencyClearance"] {
  const raw = recordValue(value);
  const redFlagFingerprint = stringValue(raw.redFlagFingerprint, 96);
  const confirmedAt = stringValue(raw.confirmedAt, 64);
  const assessmentSummary = stringValue(raw.assessmentSummary, 1_000);
  const contractSignature = stringValue(raw.contractSignature, 96);
  if (
    !redFlagFingerprint ||
    !confirmedAt ||
    !assessmentSummary ||
    !contractSignature ||
    assessmentSummary.length < 12 ||
    !/^hmac-sha256:[a-f0-9]{64}$/i.test(contractSignature) ||
    !Number.isFinite(Date.parse(confirmedAt))
  ) return undefined;
  return { redFlagFingerprint, confirmedAt, assessmentSummary, contractSignature };
}

function normalizeWarningAcknowledgement(value: unknown): CaseState["warningAcknowledgement"] {
  const raw = recordValue(value);
  const warningLevel = raw.warningLevel;
  const acknowledgedAt = stringValue(raw.acknowledgedAt, 64);
  const reportFingerprint = stringValue(raw.reportFingerprint, 96);
  const exportMode = raw.exportMode;
  if (
    (warningLevel !== "L2" && warningLevel !== "L3" && warningLevel !== "L4") ||
    !acknowledgedAt ||
    !reportFingerprint ||
    !Number.isFinite(Date.parse(acknowledgedAt)) ||
    (exportMode !== "full_advisory_report" && exportMode !== "non_dose_risk_report")
  ) return undefined;
  return {
    warningLevel,
    acknowledgedAt,
    reportFingerprint,
    reason: stringValue(raw.reason, 500),
    exportMode,
  };
}

function likelyHisRecordText(value: string | undefined): boolean {
  if (!value) return false;
  return value.includes("\n") && /(患者信息|主诉|现病史|既往史|过敏史|用药史|生命体征|舌象|脉象)/.test(value);
}

function mergeHisVitals(inputVitals: unknown, fields: HisRecordSnapshot["fields"]): Record<string, unknown> {
  const vitals = { ...recordValue(inputVitals) };
  const sourceConflicts = Array.isArray(vitals.sourceConflicts)
    ? vitals.sourceConflicts.map((item) => stringValue(item)).filter((item): item is string => Boolean(item))
    : [];
  const preserveConflictingInput = (label: string, hisValue: string | undefined, keys: string[]) => {
    if (!hisValue) return;
    const comparable = (text: string) => text.normalize("NFKC").replace(/[\s，,；;：:]/g, "").toLowerCase();
    for (const key of keys) {
      const inputValue = stringValue(vitals[key]);
      if (!inputValue || comparable(inputValue) === comparable(hisValue)) continue;
      sourceConflicts.push(`顶层${label}(${key}):${inputValue}；HIS${label}:${hisValue}`);
    }
  };
  preserveConflictingInput("体温T", fields.vitalsT, ["temperature", "T", "temp"]);
  preserveConflictingInput("脉搏P", fields.vitalsP, ["pulse", "P", "HR", "heartRate"]);
  preserveConflictingInput("呼吸R", fields.vitalsR, ["respiration", "R", "RR", "respiratoryRate"]);
  preserveConflictingInput("血压BP", fields.vitalsBP, ["bloodPressure", "BP", "bp"]);
  if (fields.vitalsT) {
    vitals.temperature = fields.vitalsT;
  }
  if (fields.vitalsP) {
    vitals.pulse = fields.vitalsP;
  }
  if (fields.vitalsR) {
    vitals.respiration = fields.vitalsR;
  }
  if (fields.vitalsBP) {
    vitals.bloodPressure = fields.vitalsBP;
  }
  if (fields.vitalsDetail) vitals.detail = fields.vitalsDetail;
  if (sourceConflicts.length > 0) vitals.sourceConflicts = [...new Set(sourceConflicts)];
  return vitals;
}

function mergeHisSymptoms(inputSymptoms: unknown, fields: HisRecordSnapshot["fields"]): Record<string, unknown> {
  const symptoms = { ...recordValue(inputSymptoms) };
  if (fields.xianbingshi) symptoms.presentHistory = fields.xianbingshi;
  if (fields.fuzhuJiancha) symptoms.exams = fields.fuzhuJiancha;
  if (fields.extraText) symptoms.extraText = fields.extraText;
  if (fields.tcmDetail) symptoms.tcmDetail = fields.tcmDetail;
  return symptoms;
}

export function normalizeCaseStateInput(value: unknown): CaseState | null {
  const parsed = CaseStateInputSchema.safeParse(value);
  if (!parsed.success) return null;
  const input = parsed.data;
  // M02 is a single information-gain decision, not a questionnaire loop. Legacy/external snapshots
  // are normalized here so no restored case can reopen a second or third follow-up round.
  const maxQuestionRounds = 1;
  const base = createInitialCaseState({ maxQuestionRounds });
  const normalizedHisRecord = normalizeHisRecord(input.hisRecord, stringValue(input.id) || base.id);
  const id = stringValue(input.id) || normalizedHisRecord?.caseId || base.id;
  const hisRecord = normalizedHisRecord ? { ...normalizedHisRecord, caseId: normalizedHisRecord.caseId || id } : undefined;
  const fields = hisRecord?.fields || {};
  const topCapabilityRestricted = Object.prototype.hasOwnProperty.call(input, "clinicTreatmentCapabilities");
  const hisCapabilityRestricted = Object.prototype.hasOwnProperty.call(fields, "clinicTreatmentCapabilities");
  const capabilityRestrictions = [
    ...(topCapabilityRestricted ? [parseTcmTreatmentCapabilities(input.clinicTreatmentCapabilities)] : []),
    ...(hisCapabilityRestricted ? [parseTcmTreatmentCapabilities(fields.clinicTreatmentCapabilities)] : []),
  ];
  const clinicTreatmentCapabilities = capabilityRestrictions.length === 0
    ? undefined
    : capabilityRestrictions.slice(1).reduce(
        (allowed, restriction) => allowed.filter((item) => restriction.includes(item)),
        capabilityRestrictions[0],
      );
  const patient = recordValue(input.patient);
  const rawChiefComplaint = stringValue(input.chiefComplaint);
  const chiefComplaint = fields.zhushu ||
    (rawChiefComplaint && !likelyHisRecordText(rawChiefComplaint) ? rawChiefComplaint : undefined) ||
    rawChiefComplaint ||
    "";
  const normalizedTongueDx = normalizeTongueDx(input.tongueDx);
  const rawTongueDx = recordValue(input.tongueDx);
  const rawTongueQuality = recordValue(rawTongueDx.quality);
  const rawTongueIssues = Array.isArray(rawTongueQuality.issues) ? rawTongueQuality.issues.map((item) => String(item)) : [];
  const normalizedReasoningV2 = normalizeReasoningV2(input.reasoningV2);
  const normalizedReasoningDiagnose =
    normalizeReasoningV2(input.reasoningDiagnose) ||
    (normalizedReasoningV2?.stage === "diagnose" ? normalizedReasoningV2 : undefined);
  const normalizedReasoningPrescribe =
    normalizeReasoningV2(input.reasoningPrescribe) ||
    (normalizedReasoningV2?.stage === "prescribe" ? normalizedReasoningV2 : undefined);
  const tongueImageRejected =
    normalizedTongueDx?.quality.needRetake === true ||
    rawTongueQuality.needRetake === true ||
    ((numberValue(rawTongueQuality.score) ?? 1) < 0.6) ||
    rawTongueIssues.some((item) => /not_a_tongue|tongue_not_fully_extended|blurry|too_dark|too_bright|missing_tongue|模糊|过暗|过曝|未完整/.test(item));
  const manualTongueFromHis = firstText(fields.tcmTongue);

  return {
    ...base,
    id,
    phase: input.phase || base.phase,
    patient: {
      name: undefined,
      sex: firstText(fields.sex, patient.sex),
      age: ageValue(fields.age) ?? ageValue(patient.age),
      occupation: stringValue(patient.occupation),
    },
    chiefComplaint,
    symptoms: mergeHisSymptoms(input.symptoms, fields),
    tongue: tongueImageRejected ? manualTongueFromHis : firstText(fields.tcmTongue, input.tongue),
    pulse: firstText(fields.tcmPulse, input.pulse),
    faceNote: firstText(fields.tcmFace, input.faceNote),
    tongueImageDesc: tongueImageRejected ? undefined : stringValue(input.tongueImageDesc),
    tongueDx: tongueImageRejected ? undefined : normalizedTongueDx,
    faceCapture: normalizeFaceCapture(input.faceCapture),
    vitals: mergeHisVitals(input.vitals, fields),
    pastHistory: firstText(fields.jiwangshi, input.pastHistory),
    medicationHistory: firstText(fields.yongyaoshi, input.medicationHistory),
    allergyHistory: firstText(fields.guomin, input.allergyHistory),
    tcmLineagePreference: resolveLineageCode(firstText(fields.tcmLineagePreference, input.tcmLineagePreference)),
    clinicTreatmentCapabilities,
    clinicTreatmentCapabilitiesRestricted: capabilityRestrictions.length > 0,
    hisRecord,
    safetyGate: normalizeSafetyGate(input.safetyGate),
    clinicalFacts: parseClinicalFacts(input.clinicalFacts) || undefined,
    encounterScopeConfirmation: normalizeEncounterScopeConfirmation(input.encounterScopeConfirmation),
    emergencyClearance: normalizeEmergencyClearance(input.emergencyClearance),
    warningAcknowledgement: normalizeWarningAcknowledgement(input.warningAcknowledgement),
    completeness: normalizeCompleteness(input.completeness),
    questionRounds: Math.min(Math.max(numberValue(input.questionRounds) ?? 0, 0), maxQuestionRounds),
    maxQuestionRounds,
    questionOutcome: input.questionOutcome === "answered" || input.questionOutcome === "skipped" || input.questionOutcome === "not_needed"
      ? input.questionOutcome
      : undefined,
    conversation: normalizeConversation(input.conversation),
    diagnosis: stringValue(input.diagnosis, MAX_MODEL_OUTPUT_CHARS),
    prescription: stringValue(input.prescription, MAX_MODEL_OUTPUT_CHARS),
    riskAssessment: stringValue(input.riskAssessment, MAX_MODEL_OUTPUT_CHARS),
    followupTimeline: normalizeFollowupTimeline(input.followupTimeline),
    previousResult: normalizePreviousResult(input.previousResult),
    auditAdvisory: normalizeAuditAdvisory(input.auditAdvisory),
    reasoningDiagnose: normalizedReasoningDiagnose,
    reasoningPrescribe: normalizedReasoningPrescribe,
    reasoningV2: normalizedReasoningV2 || normalizedReasoningPrescribe || normalizedReasoningDiagnose,
    prescriptionRevision: normalizePrescriptionRevision(input.prescriptionRevision),
    skipDifferentiationGate: input.skipDifferentiationGate === true ? true : undefined,
    safetyLocked: input.safetyLocked === true,
    lastError: normalizeLastError(input.lastError),
  };
}
