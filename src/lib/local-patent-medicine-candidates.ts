import localMedicineIndex from "../data/local-patent-medicine-index.json" with { type: "json" };
import { affirmedClinicalText, type AssistedNegationClauses } from "./clinical-polarity";
import type { CaseState } from "./diagnosis-types";
import { matchingMedicineClinicalConcepts } from "./medicine-clinical-concepts";
import { executableFormulaCompilationReferences } from "./tcm-formula-provenance";

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

/** 中成药名去掉剂型后缀后的基础方名，用作同方多剂型的去重键。 */
const PATENT_DOSAGE_FORM_SUFFIX = /(?:缓释|控释|肠溶)?(?:片|胶囊|颗粒|丸|口服液|合剂|液|冲剂|糖浆|散|膏|丹|栓|贴|酊|露|饮)$/;

function patentMedicineBaseName(name: string): string {
  return String(name || "").normalize("NFKC").replace(/\s/g, "").replace(PATENT_DOSAGE_FORM_SUFFIX, "");
}

/**
 * 该中成药是否为受控方剂目录中某个经典名方的成药剂型；是则返回该经典方名。
 * 既作临床性 tie-breaker（药典标准方优先于同证冷门厂牌药），也作同方多剂型的去重键
 * ——归脾丸／归脾合剂／归脾片／归脾液 全部归到「归脾汤」这一个键上。
 */
function governedClassicFormulaName(name: string): string | undefined {
  const base = patentMedicineBaseName(name);
  if (base.length < 2) return undefined;
  for (const suffix of ["汤", "散", "丸", "饮", "煎"]) {
    const reference = executableFormulaCompilationReferences([`${base}${suffix}`])[0];
    if (reference) return reference.formulaName;
  }
  return undefined;
}

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
    // 原实现在这里加一项 riskDetailScore：说明书的禁忌/注意/孕哺/相互作用四栏每填一栏 +0.05。
    // 本意是「文档更全的产品略微优先」，但临床概念词表粒度粗、并列极其常见，于是这个**非临床**
    // 代理指标事实上成了排序主键。实测（心脾两虚型不寐）：召回 10 条里 9 条并列 17.15，
    // 唯一的区分项就是这 0.05——归脾丸因说明书「禁忌：尚不明确」少算一栏，以 17.1 排在最后，
    // 输给了五味安神颗粒、参茯胶囊、灵芪加口服液等冷门厂牌药。药典标准方被文档完整度挤掉。
    //
    // 换成临床性 tie-breaker：该中成药是否为受控目录中某个经典名方的成药剂型
    // （归脾丸→归脾汤、逍遥丸→逍遥散、补中益气丸→补中益气汤）。权重仅 0.5，
    // 远小于证型轴 6–7 分，只在临床信号真正并列时起作用，不会盖过方证匹配本身。
    const classicFormula = governedClassicFormulaName(entry.name);
    return {
      ...entry,
      id: "",
      matchedConcepts: matched.map((concept) => concept.key),
      matchedPatientFacts: [...new Set(matchedPatientFacts)].slice(0, 3),
      score: matched.reduce((total, concept) => total + concept.weight, 0) + (classicFormula ? 0.5 : 0),
      classicFormula,
    };
  })
    .filter((entry) => entry.matchedConcepts.length > 0)
    .sort((left, right) =>
      right.score - left.score ||
      right.matchedConcepts.length - left.matchedConcepts.length ||
      left.name.localeCompare(right.name));

  // 同方多剂型去重。归脾合剂／归脾液／归脾片／归脾丸 是同一基础方的四种剂型，此前各占一个名额，
  // 实测把 10 条候选中的 4 条吃掉，把真正不同的选择挤出列表。按基础方保留评分最高的一条。
  const byBaseFormula = new Map<string, (typeof scored)[number]>();
  for (const entry of scored) {
    const key = entry.classicFormula || patentMedicineBaseName(entry.name) || entry.name;
    if (!byBaseFormula.has(key)) byBaseFormula.set(key, entry);
  }
  return [...byBaseFormula.values()]
    .slice(0, Math.max(0, limit))
    .map((entry, index) => ({ ...entry, id: `LOCAL-INST-${String(index + 1).padStart(3, "0")}` }));
}

function compact(value: string, limit: number, fallback = "未载明"): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return (clean || fallback).slice(0, limit);
}

export function buildLocalPatentMedicineContext(
  caseState: CaseState,
  limit = 10,
  assistedNegations?: AssistedNegationClauses,
): string {
  const candidates = retrieveLocalPatentMedicineCandidates(caseState, limit, assistedNegations);
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
