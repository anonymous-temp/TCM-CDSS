// src/lib/diagnosis-types.ts
import { z } from "zod";
import { isSupportedIcd10PayerCode } from "./icd10-code";
import { EVIDENCE_LEVELS, type EvidenceLevelValue } from "./cdss-vocab";
import { withCanonicalClinicalTerminology } from "./clinical-terminology";
import { resolveLineageCode } from "./tcm-lineages";
import { parseClinicalFacts, type ClinicalFacts } from "./clinical-facts";
import { parseTcmTreatmentCapabilities, TCM_TREATMENT_PROJECT_CODES, type TcmTreatmentProjectCode } from "./tcm-treatment-projects";
import { normalizeEmergencyClearanceAttestations, type EmergencyClearanceFindingAttestation } from "./emergency-clearance-contract";

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
  /**
   * 饮片味数偏好（2026-08-05，甲方接口需求）。
   *
   * 甲方原话把边界写得很清楚：「味数控制只是建议，如诊疗必须也不能裁剪，如经方不能裁剪、
   * 必须加药味不能裁剪」。所以它是**软偏好**，写进 prompt 供组方时参考，绝不参与任何
   * 确定性裁剪：经典方基准组成、绑定病机节点的药味、安全所需的佐制药，一味都不因它删减。
   * 违背偏好时在 M04 输出里说明原因，而不是牺牲方剂完整性去凑数字。
   */
  herbCountPreference?: "within_10" | "between_10_15" | "at_least_15";
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
    /**
     * 逐条红旗的处置留痕。**没有它就不解除**——见 emergency-clearance-contract.ts：
     * 这一处的判据此前只有 assessmentSummary 的字数，一句废话即可清空全部确定性红旗。
     */
    findings: EmergencyClearanceFindingAttestation[];
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
  /**
   * 这次复核是否真的换了模型身份（甲方 2026-08-10 ⑨）。
   *
   * diagnosis-api 一直算着这一位，却**算出来即丢弃**：只进了 /api/model-health 的拓扑遥测，
   * 呈现层无人读，而医生可见措辞一律无条件写「独立复核」。默认全 V4-Flash 部署下它是 false
   *（同一模型的第二次无对话状态请求）。写进签名 attestation 之后，三个出口读同一份，
   * 措辞由 clinical-review-independence 的唯一谓词决定。
   */
  independentFromGenerator?: boolean;
  reviewedPayloadHash?: string;
  /**
   * 受理裁决范围（2026-08-03 复盘的根源级工程）：受理时把「豁免了哪些质量码、带了哪些
   * 批注码」一并写进 attestation。attestation 位于合同签名域内（HMAC 只排除 contractSignature
   * 本身），下游各层（M04 路由终审、HIS 写回）在载荷哈希匹配时**读取**这份签名过的裁决,
   * 不再各自用不同口径重判一遍——"这里受理、那里重判"的分叉从入口上消失。
   * 缺省（旧快照/未受理路径）时下游回退既有重算路径,fail-closed 语义不变。
   * 安全边界：安全层码(T1)永远不允许进入 waivedIssueCodes——写入侧由受理策略保证,
   * 读取侧仍对全量码重跑安全谓词兜底。
   */
  acceptanceScope?: {
    waivedIssueCodes: string[];
    qualityAnnotationCodes: string[];
  };
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
      /** 该证候的典型表现（参考知识，非本例断言）。 */
      typicalManifestation?: string;
    }>;
    /** 病名级鉴别（与相邻中医病名区分；证型鉴别见 tcmDifferentials）。 */
    tcmDiseaseDifferentials?: Array<{
      diseaseName: string;
      reason: string;
      distinguishingPoints: string;
      nextCheck: string | null;
      /**
       * 该病名的典型表现。zod schema（TcmDiseaseDifferentialSchema）一直有这个字段，
       * **类型里漏了**——于是消费侧（客户端鉴别卡）拿不到它，只有服务端 Markdown 一个出口在印。
       * 类型与 schema 分叉正是「同一判据两处各写各的」的另一种形态。
       */
      typicalManifestation?: string;
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
      /**
       * semantic_mapping_pending_clinician_confirmation: 模型选了方名但证候映射待医生确认。
       * system_retrieved_pending_clinician_selection: 模型未给方名(自拟)或所给方名未通过充分性,
       *   服务端用**已签名证候**做确定性二次检索,把找到的受治理经典方作为参考呈现给医生。
       *   两者都**不是锁定**:不进 recommendedFormulaNames、不参与 M04 编译、由医生决定是否采用。
       */
      reason: "semantic_mapping_pending_clinician_confirmation" | "system_retrieved_pending_clinician_selection";
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
      /**
       * 指南/文献依据。**服务端按 evidenceId 反查本轮真检索到的条目后写入**，
       * 模型只提交 {evidenceId, appliesTo}（见 cdss-evidence-context 的
       * resolveGovernedGuidelineReferences）。题名/机构/年份/URL 一律来自条目字段，
       * 模型无法引入任何新字符串；取不到就没有这个字段，绝不回落到自撰题名。
       */
      guidelineReferences?: Array<{
        evidenceId: string;
        citation: string;
        url?: string;
        appliesTo?: string;
      }>;
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
      /** 剥名前 M03 锁定的方名。剥名时必须让医生看到系统原本想开什么，否则两页互相矛盾。 */
      declassifiedFromFormulaNames?: string[];
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
        tier: "canon" | "common" | "experience" | "book";
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
        tier: "canon" | "common" | "experience" | "book";
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
      /**
       * 可替换药味说明（2026-08-05，甲方接口需求「随证加减建议——可增加：可替换药味的说明」）。
       *
       * 场景是真实的：该加的药缺货、过敏、或属特殊人群禁用时，医生需要一个同向替代。
       * 因此每条替代都必须自带**替代理由与差异**——只给一个名字等于让医生自己去查，
       * 而「替代品与原药的差异在哪」正是临床上最容易出事的地方。
       * 替代药同样受全部安全边界约束：剂量上限、十八反十九畏、特殊人群规则一条不减。
       */
      substitutions?: Array<{
        replaces: string;
        substitute: string;
        rationale: string;
        differenceNote: string;
      }>;
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
      protocolStatus:
        | "governed_patient_specific_plan"
        // 命中该病种标准取穴模板，但本例证型未匹配到受治理的证型加减 ⇒ 尚未按证型加减。
        // 新增第三态的理由见 tcm-treatment-projects.ts 的 syndromeRefinements 注释：
        // 此前四组八例（风寒/风热、心脾两虚/肝火扰心、湿热中阻/脾胃虚寒、寒湿/湿热）
        // 穴位逐字相同，却八次都标 governed_patient_specific_plan。
        | "governed_class_template_not_syndrome_tailored"
        | "assessment_only_no_patient_specific_protocol";
      /**
       * protocolStatus 的**非破坏性伴生字段**（2026-08-11）。三态的真实值恒在这里；
       * HIS 的 V1 兼容投影会把 protocolStatus 折叠回旧两态，tailoringStatus 不折叠。
       */
      tailoringStatus?: "syndrome_tailored" | "class_template_only" | "assessment_only";
      protocolGap?: string;
      /**
       * 该条证型加减是否已完成中医师终审（2026-08-11）。
       * pending_clinician_review 时服务端**不应用**该条的加穴、protocolStatus 降为病种模板态；
       * 剔除穴仍照常应用（保守方向）。未登记进终审台账的条目一律按 pending 处理。
       */
      adjudicationStatus?: "approved" | "pending_clinician_review";
      /** 命中但因未终审而未予应用的证型加减。不隐藏——医生要知道系统看到了什么、为什么没用。 */
      deferredSyndromeRefinement?: {
        syndromeLabel: string;
        deferredPoints: string[];
        conflictNote: string;
      };
      /**
       * 命中但**尚未中医师签字**的精确证型标准取穴模板（2026-08-11）。
       * 未签字时模板整条不启用、本例保持评估态——但不能因此静默：
       * 医生需要知道系统已经匹配到一条待签字的标准取穴，否则页面上只剩关键词召回的结果，
       * 看起来就像"系统对这个病种什么都没有"。与 deferredSyndromeRefinement 同源处置。
       */
      deferredGovernedTemplate?: {
        templateId: string;
        indicationLabel: string;
        deferredPoints: string[];
        conflictNote: string;
      };
      treatmentContent: string;
      suggestedSitesOrPoints: string[];
      /**
       * 逐穴的来源、权威等级与终审状态（2026-08-11）。
       * 主穴与加减穴来自**不同**来源，拼成一个 protocolSource 字符串等于把这件事抹平：
       * 集成方看不出哪个穴来自哪个来源、什么等级、有没有分歧，也就无法决定展示与采纳等级。
       */
      pointProvenance?: Array<{
        point: string;
        /**
         * conditional_point：既非主穴也非证型加减，而是本例出现某组**当前症状**时才加的穴
         * （中医师 2026-08-11 裁定：风寒咳嗽兼鼻窍/头项症状时加风池）。
         * HIS 的 V1 兼容投影把它折叠回 syndrome_refinement，V2 才开放这个值。
         */
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

/**
 * 数组逐条隔离：一条非法只丢那一条，同批合法条目照常出参。
 *
 * 这是本文件里反复付出代价才立住的一条约定。zod 的数组语义是「一条不合法 = 整个数组不合法」，
 * 再叠上块级 `.catch()`，后果不是「少一条」而是**整块变 null / 整块换成工程占位串**，
 * 且因为 `.catch()` 让 safeParse **成功**，`reasoningV2SchemaIssueCode` 一律返回 undefined
 * ——既不产码、不驱动修复轮、也不进任何日志，只能靠线上肉眼发现。同族缺陷已复发 5 次：
 * 最近一次是单条子治法非法连坐整个 therapy，治则被换成「暂不锁定剂量级治法」出厂（f7b55cda）。
 *
 * 与临床事实回补层同一条信条：单条非法不得抹掉同批有效条目。
 * 用法：`z.preprocess(isolateInvalidItems(X), z.array(X).max(N).default([]))`，
 * 预处理与数组元素**必须复用同一个 schema 常量**，否则两处判据会各自漂移。
 *
 * **它只管「单条非法」，不管「条数超限」。** 服务端自产的数组超过 `.max(N)` 时照样整段清空，
 * 那一维要靠生成侧先 slice 到上限 + test:guard-symmetry 的上限一致性断言来兜
 * （实测踩过：逍遥散 8 条 textualModifications、terminologyMappings 生产上限 24 > 契约 20）。
 * 别因为「这一族已经修过一次」就不查长度维度。
 */
function isolateInvalidItems(itemSchema: z.ZodTypeAny) {
  return (value: unknown) => (Array.isArray(value)
    ? value.filter((item) => itemSchema.safeParse(item).success)
    : value);
}

/** 单条证型鉴别。提出为具名 schema，供 tcmDifferentials 的逐条隔离复用同一判据。 */
const TcmSyndromeDifferentialSchema = z.object({
  syndrome: z.string().min(1).max(300),
  reason: z.string().min(2).max(1000),
  distinguishingPoints: z.string().min(2).max(1000),
  // 该证候的**典型表现**（甲方 2026-08-10）。医生读鉴别时要先知道「这个证候通常长什么样」，
  // 才看得懂「本例哪一点对不上」。它是**关于证候的参考知识**，不是对本例的断言——
  // 与西医鉴别理由里的疾病特征分句同一性质，因此允许模型写，
  // 但同样不得在其中断言本例的患者事实。
  typicalManifestation: z.string().max(600).optional().catch(""),
  nextCheck: z.preprocess(normalizeModelNullableText, z.string().max(600).nullable()),
});

/** 单条病名鉴别（甲方 2026-08-03：鉴别诊断要求病名级）。 */
const TcmDiseaseDifferentialSchema = z.object({
  diseaseName: z.string().min(1).max(300),
  reason: z.string().min(2).max(1000),
  distinguishingPoints: z.string().min(2).max(1000),
  /** 该病名的典型表现，口径同 TcmSyndromeDifferentialSchema.typicalManifestation。 */
  typicalManifestation: z.string().max(600).optional().catch(""),
  nextCheck: z.preprocess(normalizeModelNullableText, z.string().max(600).nullable()),
});

/** 单条西医鉴别诊断。 */
const WesternDifferentialSchema = z.object({
  name: z.string().max(600),
  reason: z.string().max(1000),
  distinguishingPoints: z.string().max(1000).optional().catch(""),
  nextCheck: z.preprocess(normalizeModelNullableText, z.string().max(600).nullable()),
});

/** 单条分治法。提出为具名 schema，供 subTherapies 的逐条隔离预处理复用同一判据。 */
const SubTherapySchema = z.object({
  therapy: z.string().max(600),
  targetPathogenesis: z.string().max(600),
  priority: z.enum(["主要", "次要"]),
  evidence: EvidenceRefSchema,
});

/** 单条受控术语映射痕迹。提出为具名 schema，供 terminologyMappings 的逐条隔离复用同一判据。 */
const ControlledTerminologyMappingSchema = z.object({
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
});

/** 单条可替换药味（服务端受治理推导，模型不参与提名）。 */
const HerbSubstitutionSchema = z.object({
  replaces: z.string().min(1).max(60),
  substitute: z.string().min(1).max(60),
  rationale: z.string().min(1).max(400),
  differenceNote: z.string().min(1).max(400),
});

/** 单条症状群。提出为具名 schema，供 symptomClusters 的逐条隔离复用同一判据。 */
const SymptomClusterSchema = z.object({
  symptoms: z.array(z.string().min(1).max(300)).min(1).max(8),
  mechanism: z.string().min(2).max(1000),
});

/**
 * 单个病机链节点。提出为具名 schema，供 chain 的逐条隔离复用同一判据。
 *
 * 原先单条不是对象就让整个 pathogenesis 落 DEFAULT_PATHOGENESIS，summary、病位、病性、
 * 症状群一起归零。归零本身被 chain_empty（T1 硬拦）接住，方向是 fail-closed；但代价是
 * 一条写歪就把整份病机拆解作废，而不是丢那一条——这正是甲方 3.x 反复看到的「病机没拆」。
 */
const PathogenesisChainNodeSchema = z.object({
  nodeId: z.string().regex(/^P\d{1,2}$/).optional().catch(undefined),
  patientFact: z.string().max(1200).catch(""),
  syndromeEvidence: z.string().max(1200).catch(""),
  pathogenesis: z.string().max(1200).catch(""),
  therapyDirection: z.string().max(1200).catch(""),
  pathogenesisType: z.enum(["始动", "传变", "兼夹", "因果"]).optional().catch(undefined),
  biaoBen: z.enum(["本", "标", "标本兼夹"]).optional().catch(undefined),
  evidence: EvidenceRefSchema.catch(INSUFFICIENT_EVIDENCE_REF),
});

/** 单条病机不确定项。 */
const PathogenesisUncertaintySchema = z.object({
  item: z.string().max(600).catch(""),
  reason: z.string().max(1000).catch(""),
  affects: z.string().max(1000).catch(""),
});

/**
 * 单项中医外治。提出为具名 schema，供 tcmTreatments 的逐条隔离复用同一判据。
 *
 * 这一条是全表连坐面最大的：20 个字段、带 regex 与 min(1)，原先没有自己的 catch，
 * 任一条 projectCode 越枚举 / targetRef 不合 /^P\d{1,2}$/ / 缺 requiredChecks，都会让
 * 整个 nonPharma 落到 `.nullable().catch(null)` —— **一条外治项目写歪，健康调护
 * （diet/lifestyle/emotion/precautions）跟着一起消失**，而这两项都是甲方 8-05 标「高」的模块。
 * 紧邻的 precautions 早就为这个风险加了 `.default([]).catch([])` 双保险并写下了注释，
 * 但危险得多的 tcmTreatments 一直没做同样处理——又一次「一个面修了、另一个没修」。
 */
const TcmTreatmentRecommendationSchema = z.object({
  projectCode: z.enum(TCM_TREATMENT_PROJECT_CODES),
  projectName: z.string().min(1).max(120),
  availability: z.enum(["clinic_available", "referral_only"]),
  riskLevel: z.enum(["low", "moderate", "specialist"]),
  recommendationMode: z.enum(["clinician_assessment", "referral_assessment", "specialist_assessment_only"]),
  targetRef: z.string().regex(/^P\d{1,2}$/),
  targetPathogenesis: z.string().min(1).max(600),
  assessmentPositioning: z.string().min(1).max(800).optional(),
  protocolStatus: z.enum(["governed_patient_specific_plan", "governed_class_template_not_syndrome_tailored", "assessment_only_no_patient_specific_protocol"]),
  // 新增字段一律 fail-soft：写歪一条不能让整条诊疗项目被逐条隔离机制剔掉——
  // 那正是本轮刚修完的「一个空字符串让整条项目消失」（见 tcm-treatment-capabilities 注释）。
  tailoringStatus: z.enum(["syndrome_tailored", "class_template_only", "assessment_only"]).optional().catch(undefined),
  protocolGap: z.string().min(1).max(800).optional(),
  adjudicationStatus: z.enum(["approved", "pending_clinician_review"]).optional().catch(undefined),
  deferredGovernedTemplate: z.object({
    templateId: z.string().min(1).max(120),
    indicationLabel: z.string().min(1).max(120),
    deferredPoints: z.array(z.string().min(1).max(60)).max(24),
    conflictNote: z.string().min(1).max(800),
  }).optional(),
  deferredSyndromeRefinement: z.object({
    syndromeLabel: z.string().min(1).max(120),
    deferredPoints: z.array(z.string().min(1).max(200)).max(12),
    conflictNote: z.string().min(1).max(800),
  }).optional().catch(undefined),
  pointProvenance: z.preprocess(
    isolateInvalidItems(z.object({
      point: z.string().min(1).max(200),
      role: z.enum(["base_point", "syndrome_refinement", "syndrome_removal", "conditional_point"]),
      sourceRefs: z.array(z.string().min(1).max(120)).max(8),
      authorityTier: z.string().min(1).max(80),
      adjudicationStatus: z.enum(["approved", "pending_clinician_review"]),
      conflictNote: z.string().max(800).nullable(),
    })),
    z.array(z.object({
      point: z.string().min(1).max(200),
      role: z.enum(["base_point", "syndrome_refinement", "syndrome_removal", "conditional_point"]),
      sourceRefs: z.array(z.string().min(1).max(120)).max(8),
      authorityTier: z.string().min(1).max(80),
      adjudicationStatus: z.enum(["approved", "pending_clinician_review"]),
      conflictNote: z.string().max(800).nullable(),
    })).max(24).optional(),
  ).catch(undefined),
  sourceAuthorityTier: z.string().min(1).max(80).optional().catch(undefined),
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
});

/** 单条流派影响决策。提出为具名 schema，供 influencedDecisions 的逐条隔离复用同一判据。 */
const LineageInfluencedDecisionSchema = z.object({
  aspect: z.enum(["辨证视角", "方源选择", "组方思路", "加减风格"]),
  detail: z.string().max(1000),
});

/**
 * 单条中成药/西药建议。提出为具名 schema，供 patentAndWestern 的逐条隔离复用同一判据。
 *
 * 原先是 `z.array(...).max(8).nullable().catch(null)`：8 条里坏 1 条，另外 7 条一起变 null。
 * 且这一栏不在 enrichReasoning 的服务端无条件回填清单里，没有任何兜底能救；schema 码、
 * 语义合同、修复轮、批注四路全无信号，是全表信噪比最差的一格（甲方 8-05「中成药」整项消失）。
 */
const PatentAndWesternSchema = z.object({
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
});

/**
 * 单张候选方。提出为具名 schema，供 candidates 的逐条隔离复用同一判据。
 *
 * 隔离口径是**只隔离备选**：首选（index 0）非法仍整份拒收。
 * 理由分两头——原先 formula 是全表唯一没有块级 catch 的大块，备选方少一个 dosesPerDay，
 * 连同已完全合格的首选方、辨证、病机、调护一起作废，这与「非剂量/空白页只在真的没东西
 * 可展示时才允许」直接冲突，也是修复轮与编排时限被烧光的主要消耗源；但反过来，若把首选也
 * 一并隔离掉，出参里剩下的第一张就成了原本标注为「备选」的方，等于系统替医生改了首选，
 * 且剂量安全语义会从 fail-closed 滑向 fail-open。所以首选保持原样冒泡拒收（有 schema 码、
 * 驱动修复轮），备选逐条丢弃。
 */
const PrescriptionCandidateSchema = z.object({
  name: z.string().max(300),
  formulaNames: z.array(z.string().max(300)).max(4).optional().catch([]),
  positioning: z.enum(["首选", "备选", "仅学术思路"]),
  constructionType: z.enum(["single_base", "combined", "self_devised", "single_herb"]).optional(),
  modificationStatus: z.enum(["canonical", "modified"]).optional(),
  identityDeclassified: z.boolean().optional().catch(undefined),
  identityDeclassificationReason: z.literal("classic_composition_unverified_after_repair").optional().catch(undefined),
  declassifiedFromFormulaNames: z.array(z.string().max(120)).max(4).optional().catch(undefined),
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
});

/**
 * 候选方隔离：首选（index 0）原样保留，非法就让它冒泡到整份拒收；备选逐条过滤。
 */
function isolateInvalidAlternateCandidates(value: unknown) {
  if (!Array.isArray(value)) return value;
  return value.filter((item, index) => index === 0 || PrescriptionCandidateSchema.safeParse(item).success);
}

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
    independentFromGenerator: z.boolean().optional().catch(undefined),
    reviewedPayloadHash: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional().catch(undefined),
    // 受理裁决范围：码表为内部驳回码(kebab/snake 短标识),单码长度与数量都设上限,
    // 防止把自由文本塞进签名域。整体非法时按缺省处理(回退重算路径),不作废 attestation。
    acceptanceScope: z.object({
      waivedIssueCodes: z.array(z.string().min(1).max(120)).max(32),
      qualityAnnotationCodes: z.array(z.string().min(1).max(120)).max(32),
    }).optional().catch(undefined),
  }).optional().catch(undefined),
  terminologyMappings: z.preprocess(
    isolateInvalidItems(ControlledTerminologyMappingSchema),
    z.array(ControlledTerminologyMappingSchema).max(20).optional(),
  ).catch([]),
  completeness: CompletenessSchema.optional(),
  overview: z.object({
    tcmDiseaseName: z.string().min(1).max(300).optional().catch(undefined),
    // 以下五个叙述字段原先都没有自己的 catch，任一越界就让整个 overview 落 DEFAULT_OVERVIEW，
    // 一次性把主证/病机/治法/选方方向四个工程占位串全放出来，并连坐清空两组鉴别诊断与辨证依据。
    // 医生看到的是「整个辨证没做出来」，实际只是模型某一栏写长了。
    // 归零后每一栏各自缺失，且都仍被既有硬合同接住：空主证 → primary_syndrome_unstable、
    // 空病机 → overall_pathogenesis_unstable（两者的 `!value` 分支与占位串同码），检测力度不变。
    primarySyndrome: z.string().max(1200).catch(""),
    primarySyndromeResolution: z.enum(["resolved", "bounded", "unresolved"]).optional().catch(undefined),
    primarySyndromeBasis: z.preprocess(
      isolateInvalidItems(z.string().min(1).max(600)),
      z.array(z.string().min(1).max(600)).max(8).optional(),
    ).catch([]),
    primarySyndromeResolutionReason: z.string().min(1).max(800).optional().catch(undefined),
    tcmDiseaseRationale: z.string().max(1200).optional().catch(""),
    tcmDiagnosticRationale: z.string().max(1600).optional().catch(""),
    tcmDifferentials: z.preprocess(
      isolateInvalidItems(TcmSyndromeDifferentialSchema),
      z.array(TcmSyndromeDifferentialSchema).max(6).optional(),
    ).catch([]),
    // 甲方评测(2026-08-03)：鉴别诊断要求病名级(与相邻中医病名区分)，证型鉴别(tcmDifferentials)
    // 保留为辨证层内容。二者呈现在不同小节。
    tcmDiseaseDifferentials: z.preprocess(
      isolateInvalidItems(TcmDiseaseDifferentialSchema),
      z.array(TcmDiseaseDifferentialSchema).max(6).optional(),
    ).catch([]),
    secondarySyndromes: z.preprocess(
      isolateInvalidItems(z.string().min(1).max(300)),
      z.array(z.string().min(1).max(300)).max(6).optional(),
    ).catch([]),
    overallPathogenesis: z.string().max(2000).catch(""),
    overallTherapy: z.string().max(1200).catch(""),
    recommendedFormulaDirection: z.string().max(1200).catch(""),
    recommendedFormulaNames: z.array(z.string().max(300)).max(4).optional().catch([]),
    formulaSelectionMode: z.enum(["single", "combined", "alternatives", "self_devised", "none"]).optional().catch("none"),
    deferredFormulaSelection: z.object({
      direction: z.string().min(1).max(1200),
      names: z.array(z.string().min(1).max(300)).min(1).max(4),
      mode: z.enum(["single", "combined", "alternatives"]),
      reason: z.enum(["semantic_mapping_pending_clinician_confirmation", "system_retrieved_pending_clinician_selection"]),
    }).optional().catch(undefined),
    evidence: EvidenceRefSchema.catch(INSUFFICIENT_EVIDENCE_REF),
  }).catch(DEFAULT_OVERVIEW),
  westernDiagnosis: z.object({
    primary: z.object({
      // 归零而不是换占位串。原先写死 `.catch("症状性诊断，病因待临床鉴别")`：模型只要把
      // 病名写短了一个字（min(2)），出参就变成一份「有 supportingFacts 的占位诊断」——
      // 看起来像模型自己给不出诊断，实际是校验替换的。甲方 1.1.2「诊断术语不规范，
      // 症状工作性诊断？」抱怨的正是这个串本身。归零后交由 diagnosis-visible-summary
      // 里既有的**基于患者事实**的兜底决定要不要写占位。
      name: z.string().min(2).max(600).catch(""),
      coding: z.object({
        system: z.literal("ICD-10"),
        code: z.string().refine(isSupportedIcd10PayerCode, "invalid governed ICD-10 payer code"),
        display: z.string().min(2).max(600),
        source: z.string().min(2).max(300),
      }).optional().catch(undefined),
      status: z.preprocess(normalizeWesternDiagnosisStatus, z.enum(["考虑", "需排除", "证据有限"])),
      confidence: z.preprocess(normalizeClinicalConfidence, z.enum(["高", "中", "低"])),
      supportingFacts: z.array(z.string().min(1).max(600)).max(12).catch([]),
      // 依据分类（甲方 2026-08-10）：症状 / 体征 / 检查。由模型标注，因为
      // 「咽部充血(++)」记在现病史里也仍然是体征——这需要临床理解，不是查字段能定的。
      // 它**只能给 supportingFacts 里已有的条目贴标签**，标了本例没有的条目会被丢弃，
      // 所以模型无法借这个字段新增一条依据；没标的按病历落点字段兜底归类。
      supportingFactKinds: z.preprocess(
        isolateInvalidItems(z.object({
          fact: z.string().min(1).max(600),
          kind: z.enum(["symptom", "sign", "exam"]),
        })),
        z.array(z.object({
          fact: z.string().min(1).max(600),
          kind: z.enum(["symptom", "sign", "exam"]),
        })).max(12),
      ).optional().catch([]),
      clinicalRationale: z.string().max(1600).optional().catch(""),
      limitations: z.array(z.string().max(600)).max(12).catch([]),
      suggestedChecks: z.array(z.string().max(600)).max(12).catch([]),
      // 服务端写入的受治理引用（模型侧 guidelineRefs 在证据清洗阶段即被删除）。
      guidelineReferences: z.array(z.object({
        evidenceId: z.string().regex(/^EVID-(?:GUIDE|PAPER)-\d{3}$/),
        citation: z.string().min(2).max(400),
        url: z.string().max(600).optional(),
        appliesTo: z.string().max(200).optional(),
      })).max(3).optional().catch(undefined),
      evidence: EvidenceRefSchema.catch(INSUFFICIENT_EVIDENCE_REF),
    }).catch(DEFAULT_WESTERN_DIAGNOSIS.primary),
    differentials: z.preprocess(
      isolateInvalidItems(WesternDifferentialSchema),
      z.array(WesternDifferentialSchema).max(8),
    ).catch([]),
    /**
     * 排序候选诊断（甲方 2026-08-10「西医诊断给 top3，别就一个」）。
     *
     * 与 differentials 不是一回事：differentials 回答「还需要排除什么」，
     * candidates 回答「按当前资料，最可能的是哪几个、各自凭什么」。
     * 第 1 条必须与 primary.name 一致——否则页面上会出现两个互相矛盾的「首选」。
     * 缺省为空数组：拿不出第二、第三候选时不硬凑，页面就只显示主诊断。
     */
    candidates: z.preprocess(
      isolateInvalidItems(z.object({
        name: z.string().min(2).max(300),
        likelihood: z.preprocess(normalizeClinicalConfidence, z.enum(["高", "中", "低"])),
        keyEvidence: z.array(z.string().min(1).max(400)).max(6).catch([]),
        againstEvidence: z.array(z.string().min(1).max(400)).max(6).catch([]),
      })),
      z.array(z.object({
        name: z.string().min(2).max(300),
        likelihood: z.preprocess(normalizeClinicalConfidence, z.enum(["高", "中", "低"])),
        keyEvidence: z.array(z.string().min(1).max(400)).max(6).catch([]),
        againstEvidence: z.array(z.string().min(1).max(400)).max(6).catch([]),
      })).max(3),
    ).optional().catch([]),
  }).catch(DEFAULT_WESTERN_DIAGNOSIS),
  pathogenesis: z.object({
    summary: z.string().max(3000).catch(""),
    locationDifferentiation: z.object({
      // 逐条隔离：原先单条病位超 200 字就让整个病位块落占位（location_classification_missing
      // 只得一条 T2 批注），医生看到的是「病位没辨出来」，实际只是有一条写长了。
      items: z.preprocess(
        isolateInvalidItems(z.string().max(200)),
        z.array(z.string().max(200)).max(16).default([]),
      ),
      details: z.array(z.object({
        location: z.string().min(1).max(200),
        basis: z.string().min(1).max(800),
      })).max(8).optional().catch([]),
      resolution: z.enum(["resolved", "bounded", "unresolved"]).optional().catch(undefined),
      resolutionReason: z.string().min(1).max(800).optional().catch(undefined),
      evidence: EvidenceRefSchema.catch(INSUFFICIENT_EVIDENCE_REF),
    }).catch(DEFAULT_PATHOGENESIS.locationDifferentiation),
    natureDifferentiation: z.object({
      items: z.preprocess(
        isolateInvalidItems(z.string().max(200)),
        z.array(z.string().max(200)).max(16).default([]),
      ),
      rootDeficiency: z.array(z.string().min(1).max(200)).max(8).optional().catch([]),
      branchExcess: z.array(z.string().min(1).max(200)).max(8).optional().catch([]),
      basis: z.string().max(800).optional().catch(""),
      resolution: z.enum(["resolved", "bounded", "unresolved"]).optional().catch(undefined),
      resolutionReason: z.string().min(1).max(800).optional().catch(undefined),
      evidence: EvidenceRefSchema.catch(INSUFFICIENT_EVIDENCE_REF),
    }).catch(DEFAULT_PATHOGENESIS.natureDifferentiation),
    symptomClusters: z.preprocess(
      isolateInvalidItems(SymptomClusterSchema),
      z.array(SymptomClusterSchema).max(6).optional(),
    ).catch([]),
    caseRelationship: z.object({
      rootPattern: z.string().min(1).max(600),
      mainManifestation: z.string().min(1).max(300),
      relationship: z.string().min(1).max(1200),
    }).optional().catch(undefined),
    chain: z.preprocess(
      isolateInvalidItems(PathogenesisChainNodeSchema),
      z.array(PathogenesisChainNodeSchema).max(12).default([]),
    ).catch([]),
    uncertainties: z.preprocess(
      isolateInvalidItems(PathogenesisUncertaintySchema),
      z.array(PathogenesisUncertaintySchema).max(12).default([]),
    ).catch([]),
  }).catch(DEFAULT_PATHOGENESIS),
  therapy: z.object({
    // `.catch("")` 而不是让它连坐整块：治则超长/类型错时落 DEFAULT_THERAPY，治则就变成
    // 「暂不锁定剂量级治法」并被签名出厂（甲方 4.1「治则未显示」）。而
    // applyDeterministicTreatmentPrinciple 的接管判据是「空 **或** 恰好等于占位串」，
    // 超长值两头不沾、守卫早退，占位串反而成了权威出参。归零让守卫能接手；
    // 真的补不出来时，合同侧 `!principle` 走的仍是同一个 therapy_principle_invalid。
    overallPrinciple: z.string().max(2000).catch(""),
    overallMethod: z.string().max(2000).optional().catch(undefined),
    // 分治法**逐条隔离**：一条不合法只丢那一条，不得连坐整个 therapy（2026-08-06，线上实测）。
    //
    // 原先 subTherapies 没有自己的 catch，任何一条子治法缺 evidence 或 priority 不合枚举，
    // 都会让整个 therapy 对象落到外层 .catch(DEFAULT_THERAPY)——**治则随之变成工程占位串
    // 「暂不锁定剂量级治法」**。线上实测正是这一幕：可见正文的治则是模型写的「虚则补之」，
    // 结构化出参却是占位串，而甲方集成读的正是结构化出参（甲方 4.1「治则未显示」）。
    // 更隐蔽的是 overallMethod 事后又被 overview.overallTherapy 回填，于是表现成
    // 「治法有、治则没有」，看不出是整块被替换过。
    //
    // 与临床事实回补层同一条信条：单条非法不得抹掉同批有效条目。
    subTherapies: z.preprocess(
      isolateInvalidItems(SubTherapySchema),
      z.array(SubTherapySchema).max(12).default([]),
    ).catch([]),
  }).catch(DEFAULT_THERAPY),
  formula: z.object({
    candidates: z.preprocess(
      isolateInvalidAlternateCandidates,
      z.array(PrescriptionCandidateSchema).max(3).default([]),
    ),
    patentAndWestern: z.preprocess(
      isolateInvalidItems(PatentAndWesternSchema),
      z.array(PatentAndWesternSchema).max(8).nullable(),
    ).catch(null),
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
      // 新增字段必须 fail-soft:没有 .catch 时,模型写歪一条 substitutions 会让**整条加减**
      // 解析失败,进而可能拖垮整个候选。新字段的价值远小于处方本身,不可为它牺牲主链路。
      substitutions: z.preprocess(
        isolateInvalidItems(HerbSubstitutionSchema),
        z.array(HerbSubstitutionSchema).max(4).optional(),
      ).catch(undefined),
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
    // 三栏各自兜底：原先任一栏超长都会让整个 nonPharma 变 null，连中医外治一并带走。
    diet: z.string().max(1600).catch(""),
    lifestyle: z.string().max(1600).catch(""),
    emotion: z.string().max(1600).catch(""),
    acupointCare: z.string().max(1600).nullable().catch(null),
    tcmTreatments: z.preprocess(
      isolateInvalidItems(TcmTreatmentRecommendationSchema),
      z.array(TcmTreatmentRecommendationSchema).max(3).default([]),
    ).catch([]),
    // `.default([]).catch([])` 双保险：旧快照（含 monitoring、无 precautions）在 normalize 时
    // 静默补 []，类型非法时归零而不是让整个 nonPharma 落到下面的 `.nullable().catch(null)`
    // ——后者会连带丢掉 diet/lifestyle/emotion。旧的 monitoring 键因 nonPharma 不是 strict
    // object 而被静默剥离，不产生任何拒绝。
    precautions: z.array(z.string().max(200)).max(6).default([]).catch([]),
  }).nullable().catch(null),
  lineageAdaptation: z.object({
    schemaVersion: z.literal("tcm-cdss-reasoning-v2"),
    lineageCode: z.string().max(80).catch(""),
    label: z.string().max(120).catch(""),
    applicable: z.enum(["applicable", "partial", "not-applicable"]).catch("partial"),
    applicabilityReason: z.string().max(1600).catch(""),
    influencedDecisions: z.preprocess(
      isolateInvalidItems(LineageInfluencedDecisionSchema),
      z.array(LineageInfluencedDecisionSchema).max(12).default([]),
    ).catch([]),
    unaffectedBySafety: z.array(z.string().max(600)).max(12).default([]),
    alternativeDirection: z.string().max(1200).optional(),
    safetyDeference: z.string().max(1200).catch(""),
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
  herbCountPreference: z.unknown().optional(),
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

/**
 * 饮片味数偏好归一（2026-08-05）。受控枚举之外一律丢弃，不做模糊解析——
 * 这是个会写进 prompt 的偏好，写错比不写更坏。同时接受甲方文档里的中文档位写法。
 */
function normalizeHerbCountPreference(value: unknown): CaseState["herbCountPreference"] {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return undefined;
  if (text === "within_10" || /10\s*味?以内|≤\s*10|<\s*10/.test(text)) return "within_10";
  // 字符类必须含 en dash / em dash：系统自己在 prompt 里印的就是「10–15 味」（U+2013），
  // 原样传回来却匹配不上，三档里恰好中间那一档静默失效且不报错。
  if (text === "between_10_15" || /10\s*[-–—~－至]\s*15/.test(text)) return "between_10_15";
  if (text === "at_least_15" || /15\s*味?(?:及以上|以上)|≥\s*15|>\s*15/.test(text)) return "at_least_15";
  return undefined;
}

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
  // 逐条处置留痕缺失或非法 ⇒ 整份凭证判为缺省。这一处的 fail-closed 方向与系统别处相反：
  // 凭证 = 解除约束，因此「解析不出」只能是「不解除」，不能是「按老形态放行」。
  const findings = normalizeEmergencyClearanceAttestations(raw.findings);
  if (
    !redFlagFingerprint ||
    !confirmedAt ||
    !assessmentSummary ||
    !contractSignature ||
    !findings ||
    assessmentSummary.length < 12 ||
    !/^hmac-sha256:[a-f0-9]{64}$/i.test(contractSignature) ||
    !Number.isFinite(Date.parse(confirmedAt))
  ) return undefined;
  return { redFlagFingerprint, confirmedAt, assessmentSummary, findings, contractSignature };
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

/**
 * symptoms 允许直接给一段自由文本或一组自由文本。
 *
 * 对外接口文档 :159 写的就是 `symptoms: string`，示例与另外两处写的是 object，而代码
 * 只认 object：`recordValue("胸痛伴大汗…")` 返回 `{}`，整段现病史**无声消失**，请求照常 200、
 * 无任何告警。实测差别不是「少一段文字」而是红旗等级：
 *   symptoms=object → 红旗「胸痛/胸闷伴大汗、放射痛或气促」
 *   symptoms=string → 红旗降级为「…即使暂未记录伴随症状…」的弱档
 * 主诉写得平淡、关键描述全放 symptoms 字符串里时，这条就从「红旗降级」变成「红旗完全漏检」。
 *
 * 归一到 presentHistory：它是本仓库现病史的既有键（result-display-policy、
 * buildEvidenceQuery、临床接地文本都读它），不新造键，也就不需要下游各自适配。
 * HIS 的 xianbingshi 仍然优先——它是结构化字段、权威度更高；此时自由文本不丢弃，
 * 而是并入 extraText，绝不出现「因为有更权威的字段，所以把这段扔了」。
 */
function mergeHisSymptoms(inputSymptoms: unknown, fields: HisRecordSnapshot["fields"]): Record<string, unknown> {
  const freeText = typeof inputSymptoms === "string"
    ? inputSymptoms.trim()
    : Array.isArray(inputSymptoms)
      ? inputSymptoms.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
          .map((item) => item.trim()).join("；")
      : "";
  const symptoms = { ...recordValue(inputSymptoms) };
  if (freeText) symptoms.presentHistory = freeText.slice(0, 20_000);
  const carriedFreeText = freeText && fields.xianbingshi && fields.xianbingshi !== freeText ? freeText : "";
  if (fields.xianbingshi) symptoms.presentHistory = fields.xianbingshi;
  if (fields.fuzhuJiancha) symptoms.exams = fields.fuzhuJiancha;
  if (fields.extraText || carriedFreeText) {
    symptoms.extraText = [fields.extraText, carriedFreeText].filter(Boolean).join("\n");
  }
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
    herbCountPreference: normalizeHerbCountPreference(input.herbCountPreference),
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
