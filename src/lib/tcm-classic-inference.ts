import differentiationRulesJson from "../data/tcm-differentiation-rules.json" with { type: "json" };
import formulaAliasesJson from "../data/tcm-formula-aliases.json" with { type: "json" };
import formulaCompositionRulesJson from "../data/tcm-formula-composition-rules.json" with { type: "json" };
import formulaDiscriminationGraphJson from "../data/tcm-formula-discrimination-graph.json" with { type: "json" };
import textualModificationRulesJson from "../data/tcm-textual-modification-rules.json" with { type: "json" };
import type { CaseState } from "./diagnosis-types";
import { affirmedClinicalText } from "./clinical-polarity";
export { firstFormulaContraindicationIssue, formulaContraindicationIssues } from "./tcm-formula-contraindications";
export { SIX_HEALTH_FOLLOWUP_DIMENSIONS, sixHealthFollowupTable } from "./tcm-followup-dimensions";

type DifferentiationRule = {
  id: string;
  triggerTerms: string[];
  question: string;
  resolves: string[];
  discriminates?: string[];
  dimensions: string[];
  priority?: number;
  informationGain?: number;
  sourceRefs: string[];
};

type FormulaNode = {
  id: string;
  formulaName: string;
  formulaAliases: string[];
  sixChannelSection: string;
  pattern: string;
  supportTerms: string[];
  discriminator: string;
  safetyClass: "standard" | "restricted";
  sourceRefs: string[];
};

type DiscriminationEdge = {
  id: string;
  from: string;
  to: string;
  discriminator: string;
  questionText?: string;
  sides?: {
    from: { supportTerms: string[]; againstTerms: string[] };
    to: { supportTerms: string[]; againstTerms: string[] };
  };
  contraindicationHints?: string[];
  priority?: number;
  ruleId: string;
  sourceRefs: string[];
};

type TextualModificationRule = {
  id: string;
  baseFormula: string;
  triggerTerms: string[];
  triggerMode: "all" | "any";
  resultingFormula?: string;
  addHerbs: string[];
  removeHerbs: string[];
  sourceEvidenceId: string;
  sourceCitation: string;
  evidenceAnchorLevel: "tiaowen" | "chapter_paragraph" | "page_paragraph";
  tier: "canon" | "common" | "experience";
  requiresClinicianReview: true;
};

export type FormulaDiscriminationPath = {
  againstFormula: string;
  question: string;
  status: "confirmed" | "absent" | "unknown";
  matchedTerms: string[];
  opposingTerms: string[];
  contraindicationHints: string[];
  sourceRef: string;
};

export type FormulaCompositionLogic = {
  formulaName: string;
  summary: string;
  tier: "common" | "experience";
  sourceRefs: string[];
};

export type TextualModificationEvidence = {
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
};

const differentiationRules = differentiationRulesJson.rules as DifferentiationRule[];
const formulaNodes = (formulaDiscriminationGraphJson.nodes || []) as FormulaNode[];
const discriminationEdges = formulaDiscriminationGraphJson.edges as DiscriminationEdge[];
const formulaCompositionRules = formulaCompositionRulesJson.entries as FormulaCompositionLogic[];
const textualModificationRules = textualModificationRulesJson.entries as TextualModificationRule[];

const aliasToCanonical = new Map<string, string>();
for (const entry of formulaAliasesJson.entries) {
  aliasToCanonical.set(entry.canonical, entry.canonical);
  for (const alias of entry.aliases) aliasToCanonical.set(alias, entry.canonical);
}

function normalizedFormulaName(value: string): string {
  const compact = value
    .replace(/[（(]?\s*《[^》]+》\s*[）)]?/g, "")
    .replace(/(?:加减|化裁|加味)方?$/g, "")
    .replace(/\s+/g, "")
    .trim();
  return aliasToCanonical.get(compact) || compact;
}

const TCM_AFFIRMED_STATE_TERMS = [
  "小便不利",
  "饥而不欲食",
  "心中烦不得卧",
  "不得眠",
  "不放屁",
  "无食欲",
  "食不下",
  "不欲饮",
  "不恶寒",
  "不渴",
] as const;

function tcmAffirmedText(value: string | null | undefined): string {
  let protectedText = value || "";
  const replacements = new Map<string, string>();
  TCM_AFFIRMED_STATE_TERMS.forEach((term, index) => {
    const token = `TCMSTATE${String(index).padStart(2, "0")}`;
    if (protectedText.includes(term)) {
      protectedText = protectedText.replaceAll(term, token);
      replacements.set(token, term);
    }
  });
  const noSweatToken = "TCMSTATE99";
  protectedText = protectedText.replace(/无汗(?!出)/g, noSweatToken);
  replacements.set(noSweatToken, "无汗");
  let affirmed = affirmedClinicalText(protectedText) || "";
  for (const [token, term] of replacements) affirmed = affirmed.replaceAll(token, term);
  return affirmed;
}

function selectedClinicalFields(state: CaseState): unknown {
  return {
    chiefComplaint: state.chiefComplaint,
    symptoms: state.symptoms,
    tongue: state.tongue,
    pulse: state.pulse,
    faceNote: state.faceNote,
    vitals: state.vitals,
    pastHistory: state.pastHistory,
    medicationHistory: state.medicationHistory,
    allergyHistory: state.allergyHistory,
    conversation: state.conversation
      .filter((message) => message.role === "user")
      .map((message) => message.content),
  };
}

export function tcmFusionClinicalText(state: CaseState): string {
  return tcmAffirmedText(JSON.stringify(selectedClinicalFields(state)));
}

export function rankedDifferentiationRules(
  clinicalText: string,
  limit = 4,
): Array<DifferentiationRule & { matchedTerms: string[]; informationScore: number }> {
  const affirmed = tcmAffirmedText(clinicalText);
  return differentiationRules
    .map((rule) => {
      const matchedTerms = rule.triggerTerms.filter((term) => affirmed.includes(term));
      return {
        ...rule,
        matchedTerms,
        informationScore:
          matchedTerms.length * 10 +
          (rule.priority || 0) / 10 +
          (rule.informationGain || 0),
      };
    })
    .filter((rule) => rule.matchedTerms.length > 0)
    .sort((left, right) =>
      right.informationScore - left.informationScore ||
      left.id.localeCompare(right.id))
    .slice(0, limit);
}

export type FormulaCandidateScore = {
  formulaName: string;
  score: number;
  matchedTerms: string[];
  pattern: string;
  safetyClass: "standard" | "restricted";
  sourceRefs: string[];
};

export function evaluateFormulaCandidates(
  clinicalText: string,
  limit = 8,
): FormulaCandidateScore[] {
  const affirmed = tcmAffirmedText(clinicalText);
  if (!affirmed) return [];
  return formulaNodes
    .map((node) => {
      const matchedTerms = node.supportTerms.filter((term) => affirmed.includes(term));
      return {
        formulaName: node.formulaName,
        score: matchedTerms.length,
        matchedTerms,
        pattern: node.pattern,
        safetyClass: node.safetyClass,
        sourceRefs: node.sourceRefs,
      };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) =>
      right.score - left.score ||
      left.formulaName.localeCompare(right.formulaName, "zh-CN"))
    .slice(0, limit);
}

export function buildM02ClassicDiscriminationContext(state: CaseState): string {
  const clinicalText = tcmFusionClinicalText(state);
  const rules = rankedDifferentiationRules(clinicalText, 4);
  if (rules.length === 0) return "";
  const candidates = evaluateFormulaCandidates(clinicalText, 6);
  return [
    "【经方鉴别追问图（仅用于决定追问优先级，不构成诊断或选方）】",
    ...rules.map((rule) =>
      `- ${rule.id}：信息增益=${rule.informationScore.toFixed(1)}；命中当前阳性线索 ${rule.matchedTerms.join("、")}；` +
      `优先核实“${rule.question}”；可区分 ${rule.resolves.join(" / ")}。`),
    ...(candidates.length > 1
      ? [
          `当前仅用于选题的候选节点：${candidates.map((item) =>
            `${item.formulaName}[${item.matchedTerms.join("、")}]`).join(" / ")}。`,
        ]
      : []),
    "只能从中选择当前病例尚未回答、且会改变安全处置或辨证方向的问题；不得在问题中暗示患者必然属于某证或应使用某方。",
  ].join("\n");
}

export function buildM03SevenStageContext(state: CaseState): string {
  const clinicalText = tcmFusionClinicalText(state);
  const rules = rankedDifferentiationRules(clinicalText, 4);
  const candidates = evaluateFormulaCandidates(clinicalText, 6);
  return [
    "【经方融合七阶段辨证约束（advisory only）】",
    "1. 病位：至少同时引用两类患者证据（主症/兼症/舌/脉/大小便/寒热之一），单一症状不得锁定病位。",
    "2. 整体状态：明确病程、精神、饮食、睡眠与二便中已有和缺失的信息。",
    "3. 寒热：形成明确寒热判断时，至少核对寒热、口渴饮水、二便、舌、脉、四肢温度中的两个维度；冲突则写入 uncertainties。",
    "4. 虚实：把正气状态与邪实表现分开，未知不得写成阴性。",
    "5. 病机链：每个节点维持“患者事实→证候依据→子病机→治法”，禁止课程比喻代替临床证据。",
    "6. 方证鉴别：对拟锁定方至少列一个相邻方、相反证据及能改变选择的核实点；核实点未回答时标记 unknown，不得冒充 absent。",
    "7. 治法：总治法必须逐项覆盖 P1/P2 病机；经典课程只能作 common/experience 级参考，不能覆盖现代红旗、审方和药典边界。",
    ...(rules.length > 0 ? [
      "本例优先鉴别节点：",
      ...rules.map((rule) => `- ${rule.id}：${rule.question}（区分 ${rule.resolves.join(" / ")}）`),
    ] : ["本例未命中受控鉴别图；应安全弃权，不得强行套入六经或方证。"]),
    ...(candidates.length > 0
      ? [
          "确定性候选收敛（仅按已确认词命中，不等于锁方）：",
          ...candidates.map((candidate) =>
            `- ${candidate.formulaName}：score=${candidate.score}；支持=${candidate.matchedTerms.join("、")}；` +
            `安全级=${candidate.safetyClass}；来源=${candidate.sourceRefs.join(" / ")}。`),
          "若前两名仍并列或相邻边的两侧证据同时出现，必须保留 unknown 并把该边问题列入建议补充信息。",
        ]
      : []),
  ].join("\n");
}

export function formulaDiscriminationPaths(
  formulaNames: string[],
  clinicalText = "",
): FormulaDiscriminationPath[] {
  const names = new Set(formulaNames.map(normalizedFormulaName));
  const affirmed = tcmAffirmedText(clinicalText);
  return discriminationEdges
    .filter((edge) => names.has(normalizedFormulaName(edge.from)) || names.has(normalizedFormulaName(edge.to)))
    .sort((left, right) => (right.priority || 0) - (left.priority || 0) || left.id.localeCompare(right.id))
    .slice(0, 6)
    .map((edge) => {
      const currentIsFrom = names.has(normalizedFormulaName(edge.from));
      const againstFormula = currentIsFrom ? edge.to : edge.from;
      const currentSide = currentIsFrom ? edge.sides?.from : edge.sides?.to;
      const opposingSide = currentIsFrom ? edge.sides?.to : edge.sides?.from;
      const matchedTerms = (currentSide?.supportTerms || []).filter((term) => affirmed.includes(term));
      const opposingTerms = (opposingSide?.supportTerms || []).filter((term) => affirmed.includes(term));
      const status = matchedTerms.length > 0 && opposingTerms.length === 0
        ? "confirmed" as const
        : opposingTerms.length > 0 && matchedTerms.length === 0
          ? "absent" as const
          : "unknown" as const;
      return {
        againstFormula,
        question: edge.questionText || edge.discriminator,
        status,
        matchedTerms,
        opposingTerms,
        contraindicationHints: edge.contraindicationHints || [],
        sourceRef: `${edge.id}:${edge.sourceRefs[0]}`,
      };
    });
}

export function compositionLogicForFormulaNames(formulaNames: string[]): FormulaCompositionLogic[] {
  const names = new Set(formulaNames.map(normalizedFormulaName));
  return formulaCompositionRules
    .filter((item) => names.has(normalizedFormulaName(item.formulaName)))
    .slice(0, 4);
}

export function textualModificationsForFormulaNames(
  formulaNames: string[],
  clinicalText: string,
): TextualModificationEvidence[] {
  const names = new Set(formulaNames.map(normalizedFormulaName));
  const affirmed = tcmAffirmedText(clinicalText);
  return textualModificationRules.flatMap((rule) => {
    if (!names.has(normalizedFormulaName(rule.baseFormula))) return [];
    const matchedTriggers = rule.triggerTerms.filter((term) => affirmed.includes(term));
    const triggerSatisfied = rule.triggerMode === "all"
      ? matchedTriggers.length === rule.triggerTerms.length
      : matchedTriggers.length > 0;
    if (!triggerSatisfied) return [];
    return [{
      ruleId: rule.id,
      baseFormula: rule.baseFormula,
      matchedTriggers,
      ...(rule.resultingFormula ? { resultingFormula: rule.resultingFormula } : {}),
      addHerbs: rule.addHerbs,
      removeHerbs: rule.removeHerbs,
      sourceEvidenceId: rule.sourceEvidenceId,
      sourceCitation: rule.sourceCitation,
      evidenceAnchorLevel: rule.evidenceAnchorLevel,
      tier: rule.tier,
      requiresClinicianReview: true as const,
    }];
  });
}
