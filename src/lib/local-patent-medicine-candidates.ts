import localMedicineIndex from "../data/local-patent-medicine-index.json" with { type: "json" };
import { affirmedClinicalText, type AssistedNegationClauses } from "./clinical-polarity";
import type { CaseState } from "./diagnosis-types";
import { matchingMedicineClinicalConcepts } from "./medicine-clinical-concepts";

type LocalPatentMedicineEntry = {
  name: string;
  specification: string;
  approvalNumber: string;
  manufacturer: string;
  category: string;
  url: string;
  indication: string;
  usage: string;
  adverseReaction: string;
  contraindication: string;
  precaution: string;
  children: string;
  elderly: string;
  pregnancyLactation: string;
  interaction: string;
  fingerprint: string;
};

export type LocalPatentMedicineCandidate = LocalPatentMedicineEntry & {
  id: string;
  matchedConcepts: string[];
  matchedPatientFacts: string[];
  score: number;
};

// This bounded bridge is deliberately narrower than free-text similarity. A label can enter the
// prompt only when its recorded indication and a current positive patient fact share the same
// controlled clinical concept. The model therefore cannot retrieve a medicine from a disease name
// alone when the patient explicitly denies the corresponding symptom.
const ENTRIES = (localMedicineIndex as { entries?: LocalPatentMedicineEntry[] }).entries || [];

function positiveCaseFacts(caseState: CaseState, assistedNegations?: AssistedNegationClauses): string[] {
  const reasoning = caseState.reasoningDiagnose;
  const positiveSymptoms = Object.entries(caseState.symptoms || {})
    .map(([key, value]) => {
      const positive = affirmedClinicalText(typeof value === "string" ? value : String(value ?? ""), "affirmed", assistedNegations);
      return positive ? `${key}：${positive}` : undefined;
    })
    .filter((value): value is string => Boolean(value));
  const sources = [
    caseState.chiefComplaint,
    ...positiveSymptoms,
    caseState.tongue,
    caseState.pulse,
    caseState.faceNote,
    ...caseState.conversation.filter((item) => item.role === "user").map((item) => item.content),
    reasoning?.westernDiagnosis?.primary?.name,
    ...(reasoning?.westernDiagnosis?.primary?.supportingFacts || []),
    reasoning?.overview?.primarySyndrome,
    ...(reasoning?.overview?.primarySyndromeBasis || []),
  ];
  return [...new Set(sources
    .map((value) => affirmedClinicalText(value, "affirmed", assistedNegations))
    .filter((value): value is string => Boolean(value)))];
}

export function retrieveLocalPatentMedicineCandidates(
  caseState: CaseState,
  limit = 10,
  assistedNegations?: AssistedNegationClauses,
): LocalPatentMedicineCandidate[] {
  const facts = positiveCaseFacts(caseState, assistedNegations);
  if (facts.length === 0) return [];
  const semanticConceptIds = (caseState.reasoningDiagnose?.terminologyMappings || [])
    .filter((item) =>
      item.namespace === "medicine_clinical_concept" &&
      item.fieldPath.startsWith("retrieval.medicineClinicalConcept."))
    .map((item) => item.candidateId);
  const scored = ENTRIES.map((entry) => {
    const matched = matchingMedicineClinicalConcepts(facts.join("；"), entry.indication, semanticConceptIds);
    const matchedPatientFacts = facts.filter((fact) => matched.some((concept) => concept.casePattern.test(fact)));
    const riskDetailScore = [entry.contraindication, entry.precaution, entry.pregnancyLactation, entry.interaction]
      .filter((value) => value && !/^(?:尚不明确|无|暂无)$/.test(value)).length * 0.05;
    return {
      ...entry,
      id: "",
      matchedConcepts: matched.map((concept) => concept.key),
      matchedPatientFacts: [...new Set(matchedPatientFacts)].slice(0, 3),
      score: matched.reduce((total, concept) => total + concept.weight, 0) + riskDetailScore,
    };
  })
    .filter((entry) => entry.matchedConcepts.length > 0)
    .sort((left, right) =>
      right.score - left.score ||
      right.matchedConcepts.length - left.matchedConcepts.length ||
      left.name.localeCompare(right.name))
    .slice(0, Math.max(0, limit));
  return scored.map((entry, index) => ({ ...entry, id: `LOCAL-INST-${String(index + 1).padStart(3, "0")}` }));
}

function compact(value: string, limit: number, fallback = "未载明"): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return (clean || fallback).slice(0, limit);
}

export function buildLocalPatentMedicineContext(caseState: CaseState, limit = 10): string {
  const candidates = retrieveLocalPatentMedicineCandidates(caseState, limit);
  if (candidates.length === 0) {
    return "【本地中成药说明书检索】本例当前阳性事实未命中本地非处方中成药说明书索引；不得据此自由生成中成药候选。";
  }
  return [
    "【本地中成药说明书检索（病例绑定候选；不是自动处方）】",
    // Keep each candidate on one evidence-record line: the sanitizer deliberately binds an ID,
    // fingerprint, medicine name, specification and indication within the same retrieved record.
    ...candidates.map((candidate) =>
      `- [${candidate.id}] 药名：${candidate.name}｜规格：${compact(candidate.specification, 120)}｜批准文号：${candidate.approvalNumber}｜生产企业：${candidate.manufacturer}｜适应证：${compact(candidate.indication, 360)}｜本例命中：${candidate.matchedConcepts.join("、")}｜事实：${candidate.matchedPatientFacts.join("；")}｜用法：${compact(candidate.usage, 220)}｜禁忌/注意：${compact([candidate.contraindication, candidate.precaution].filter(Boolean).join("；"), 360)}｜特殊人群：${compact([candidate.children, candidate.elderly, candidate.pregnancyLactation].filter(Boolean).join("；"), 260)}｜相互作用：${compact(candidate.interaction, 220)}｜条目指纹：${candidate.fingerprint}${/^https:\/\//i.test(candidate.url) ? `｜URL:${candidate.url}` : ""}`),
    "选择纪律：只能复制上方同一条目的药名、规格、ID和指纹；适应证必须覆盖本例当前阳性问题。条目是候选边界，不替代医师辨证、说明书原文核验或药师审查；不得补写条目未载明的信息。",
  ].join("\n");
}
