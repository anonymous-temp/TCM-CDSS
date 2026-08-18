import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { getTcmHerbFunctionText } = jiti("../../src/lib/tcm-knowledge.ts");
const { requiredDecoctionRequirement } = jiti("../../src/lib/herb-decoction-rules.ts");
const { getM03TherapyLock } = jiti("../../src/lib/m03-therapy-lock.ts");

function auditControlReasoning(control, signedDiagnoseReasoning) {
  const evidence = { evidenceLevel: "model_inference", source: "虚构审方正控" };
  const primaryPathogenesis = signedDiagnoseReasoning?.pathogenesis?.chain?.[0]?.pathogenesis || control.syndrome;
  const herbs = control.herbs.map((herb, index) => ({
    name: herb.name,
    processing: null,
    dose: herb.dose,
    role: index === 0 ? "君" : index < 3 ? "臣" : "佐",
    prescriptionRole: "虚构审方正控药味",
    targetKind: "pathogenesis_node",
    targetRef: "P1",
    structureRole: null,
    targetPathogenesis: primaryPathogenesis,
    function: signedDiagnoseReasoning ? (getTcmHerbFunctionText(herb.name) || "仅用于验证审方规则命中") : "仅用于验证审方规则命中",
    decoctionRequirement: signedDiagnoseReasoning ? (requiredDecoctionRequirement(herb.name) || null) : null,
    isToxic: false,
    evidence,
  }));
  return {
    schemaVersion: "tcm-cdss-reasoning-v2",
    stage: "prescribe",
    overview: signedDiagnoseReasoning?.overview || {
      primarySyndrome: control.syndrome,
      overallPathogenesis: control.syndrome,
      overallTherapy: "仅用于虚构审方变异测试",
      recommendedFormulaDirection: "虚构审方正控",
      evidence,
    },
    westernDiagnosis: signedDiagnoseReasoning?.westernDiagnosis || {
      primary: {
        name: control.diagnosis,
        status: "证据有限",
        confidence: "中",
        supportingFacts: [control.chiefComplaint],
        limitations: ["虚构正控，不代表临床建议"],
        suggestedChecks: [],
        evidence,
      },
      differentials: [],
    },
    pathogenesis: signedDiagnoseReasoning?.pathogenesis || {
      summary: control.syndrome,
      locationDifferentiation: { items: ["心", "脾"], evidence },
      natureDifferentiation: { items: ["虚"], evidence },
      chain: [{ nodeId: "P1", patientFact: control.chiefComplaint, syndromeEvidence: control.syndrome, pathogenesis: control.syndrome, therapyDirection: "仅作审方测试", evidence }],
      uncertainties: [],
    },
    therapy: signedDiagnoseReasoning?.therapy || { overallPrinciple: "因人制宜", overallMethod: "仅用于虚构审方变异测试", subTherapies: [] },
    formula: {
      candidates: [{
        name: signedDiagnoseReasoning ? "本例辨证组方（医生编辑版）" : `虚构正控-${control.mutation}`,
        formulaNames: [],
        constructionType: "self_devised",
        positioning: "仅学术思路",
        formulaSource: evidence,
        therapyMatch: signedDiagnoseReasoning ? getM03TherapyLock(signedDiagnoseReasoning).candidateMatch : "故意变异，预期触发审方问题",
        applicable: "不适用于真实患者",
        notApplicable: "禁止临床使用",
        herbs,
        formulaAnalysis: "处方由回归框架故意变异，仅验证审方告警。",
        decoction: {
          doseCount: "3剂",
          dosesPerDay: 1,
          administrationTimesPerDay: 2,
          method: "每日1剂，水煎两次，每日分2次服",
          course: "3日",
          followUpNode: "3日后复核",
        },
      }],
      patentAndWestern: [],
      modifications: [],
    },
    nonPharma: {
      diet: "少量多餐，避免辛辣油腻；可用山药小米粥作为早餐，每周3次。",
      lifestyle: "保持规律作息",
      emotion: "记录情绪变化",
      acupointCare: null,
      monitoring: [{ metric: control.chiefComplaint, timing: "本次", trigger: "若审方命中预期问题则必须人工复核" }],
    },
    lineageAdaptation: null,
  };
}

export function buildAuditPositiveControlState(control, signedDiagnoseReasoning) {
  const reasoning = auditControlReasoning(control, signedDiagnoseReasoning);
  return {
    id: `primary50_${control.id}`,
    phase: "assess",
    patient: control.patient,
    chiefComplaint: control.chiefComplaint,
    symptoms: { presentHistory: control.chiefComplaint },
    tongue: "舌淡",
    pulse: "脉细",
    vitals: {},
    pastHistory: control.pastHistory,
    medicationHistory: control.medicationHistory,
    allergyHistory: control.allergyHistory,
    diagnosis: `## 西医诊断\n- ${control.diagnosis}\n\n## 中医辨证结论\n证型：${control.syndrome}`,
    prescription: "虚构审方正控，结构化药味见 reasoningPrescribe。",
    reasoningPrescribe: reasoning,
    reasoningV2: reasoning,
    ...(signedDiagnoseReasoning ? {
      reasoningDiagnose: signedDiagnoseReasoning,
      prescriptionRevision: {
        source: "herb_workbench",
        candidateIndex: 0,
        herbHash: "pending-server-recompute",
        auditedAt: new Date().toISOString(),
        auditResult: "MANUAL_REVIEW",
        highestRiskLevel: "HIGH",
      },
    } : {}),
    completeness: { level: "C", redFlag: 0.8, infoGain: 0.8, managementImpact: 0.8, answerability: 0.8 },
    questionRounds: 1,
    maxQuestionRounds: 1,
    conversation: [],
  };
}
