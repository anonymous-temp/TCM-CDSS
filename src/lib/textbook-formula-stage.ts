import preconditionsSource from "../data/tcm-textbook-row-preconditions.source.json" with { type: "json" };
import { originalFormula } from "./formula-original-composition";
import { recordMentionPolarityAt } from "./diagnosis-safety";
import { clinicalEventTemporalScopeAt } from "./clinical-polarity";

/** 仅复用原文极性，做教材候选/用方阶段检索，不产生红旗或修改安全结论。 */
export function affirmedTextbookTerm(record: string, terms: readonly string[], allowHistorical = false): string | undefined {
  const source = String(record || "").normalize("NFKC");
  for (const term of terms) {
    let from = 0;
    for (;;) {
      const at = source.indexOf(term.normalize("NFKC"), from);
      if (at < 0) break;
      // 字段名不是阳性事实：「过敏史：无已知药物过敏」不能凭标签里的「过敏」匹配过敏性休克。
      const lineStart = source.lastIndexOf("\n", at - 1) + 1;
      const fieldLead = source.slice(lineStart).match(/^[^\n：:，,。；;]{1,24}[:：]/u)?.[0] || "";
      if (at - lineStart < fieldLead.length) { from = at + term.length; continue; }
      if (recordMentionPolarityAt(source, at) === "affirmed" &&
        (allowHistorical || clinicalEventTemporalScopeAt(source, at, term.length) === "current")) return term;
      from = at + term.length;
    }
  }
  return undefined;
}

export type TextbookPreconditionFallback = { book: string; syndrome: string; line: number; quote: string; priorityLine: number; priorityQuote: string; therapy: string; formulas: string[]; formulaBooks: Record<string, string>; alternatives?: TextbookPreconditionFallback[] };
export type TextbookRowPrecondition = {
  kind: "post_surgery" | "post_treatment"; book: string; line: number; quote: string; procedureTerms: string[]; genericProcedureTerm?: string; contextExclusions: string[]; nonCompletedPrefixes: string[]; priority: string;
  fallback?: TextbookPreconditionFallback;
};

export interface TextbookFormulaStageRow {
  formulas: string[];
  formulaJoin: string;
  precondition?: string | TextbookRowPrecondition;
  preconditionNotice?: string;
  therapy?: string;
  composition?: string[];
  modifications?: unknown[];
  formulaStage?: string;
  formulaSequence?: Array<{ stage: string; formulas: string[] }>;
  runtimePolicy?: {
    requireAll?: string[][];
    /** 与结构化本次操作条件等价的 requireAll 组；其它阶段组仍独立核对。 */
    procedureRequirementGroups?: number[];
    stopIfAny?: string[];
    sequenceRequirements?: Record<string, string[][]>;
    priority: string;
  };
}

const completionGrammar = preconditionsSource.completionGrammar;
const completedGenericBefore = new RegExp(completionGrammar.genericBefore, "u");
const completedGenericAfter = new RegExp(completionGrammar.genericAfter, "u");
const completedSpecificBefore = new RegExp(completionGrammar.specificBefore, "u");
const completedSpecificAfter = new RegExp(completionGrammar.specificAfter, "u");

/** 复用原有闭集操作词和极性守卫，不新增开放语言分类规则。 */
function procedureCompleted(condition: TextbookRowPrecondition, recordText: string): boolean {
  const nonCompleted = new RegExp(`(?:${condition.nonCompletedPrefixes.map((term) => term.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|")})[^，,。；;]{0,8}$`, "u");
  const clauses = String(recordText || "").split(/[。；;\n]/u);
  const completed = clauses.some((clause) => condition.procedureTerms.some((term) => {
    const at = clause.indexOf(term);
    if (at < 0 || recordMentionPolarityAt(clause, at) !== "affirmed") return false;
    if (nonCompleted.test(clause.slice(0, at))) return false;
    if (condition.contextExclusions.some((term) => clause.slice(0, at).includes(term))) return false;
    if (term === condition.genericProcedureTerm) return completedGenericBefore.test(clause.slice(0, at)) || completedGenericAfter.test(clause.slice(at + term.length));
    return completedSpecificBefore.test(clause.slice(0, at)) || completedSpecificAfter.test(clause.slice(at + term.length));
  }));
  return completed;
}

/**
 * 教材用方唯一判据。结构化操作条件负责本次治疗是否完成；KD 提供其它阶段、先后、停药条件。
 * 两源描述同一个操作前提时，以结构化条件为准（含否认/计划/既往/他人排除），不再用宽泛「术后」重复放行。
 * representativeFormulas 是本行当前可用的原代表方；formulas/row 可包含有出处且通过禁忌核对的替代方向。
 * 这里只限制教材建议，不产生或放宽安全层结论。
 */
export function evaluateTextbookFormulaUse<T extends TextbookFormulaStageRow>(row: T | undefined, recordText = "", options: {
  barredHerb?: (herb: string) => boolean; formulaNames?: readonly string[];
} = {}) {
  if (!row) return undefined;
  const policy = row.runtimePolicy;
  const condition = typeof row.precondition === "object" ? row.precondition : undefined;
  const pending = condition && !procedureCompleted(condition, recordText) ? condition : undefined;
  const stopped = Boolean(policy?.stopIfAny && affirmedTextbookTerm(recordText, policy.stopIfAny));
  const unmetStage = Boolean(policy?.requireAll?.some((group, index) =>
    !(condition && policy.procedureRequirementGroups?.includes(index)) && !affirmedTextbookTerm(recordText, group)));
  const sequential = row.formulaJoin === "sequential" && Boolean(row.formulaSequence?.length);
  let formulas = row.formulas;
  let fallback: TextbookPreconditionFallback | undefined;
  if (stopped || unmetStage || pending || row.formulaJoin === "conditional") formulas = [];
  else if (sequential) {
    const available = row.formulaSequence!.filter((step, index) => index === 0 ||
      Boolean(policy?.sequenceRequirements?.[step.stage]?.every((group) => affirmedTextbookTerm(recordText, group))));
    formulas = available.at(-1)?.formulas || [];
  }
  const representativeFormulas = formulas;
  const composition = (option: TextbookPreconditionFallback) => option.formulas.flatMap((formula) => originalFormula(formula, option.formulaBooks[formula])?.herbs.map((herb) => herb.herb) || []);
  if (pending && !stopped && !unmetStage) {
    const candidates = pending.fallback ? [pending.fallback, ...(pending.fallback.alternatives || [])] : [];
    fallback = candidates.find((option) => (options.formulaNames === undefined || option.formulas.length === options.formulaNames.length && option.formulas.every((formula) => options.formulaNames!.includes(formula))) &&
      (!options.barredHerb || composition(option).length > 0 && composition(option).every((herb) => !options.barredHerb!(herb))));
    formulas = fallback?.formulas || [];
  }
  const restricted = Boolean(pending || stopped || unmetStage || sequential || row.formulaJoin === "conditional");
  const pendingPrecondition = pending ? { ...pending, fallback } : undefined;
  const priority = pending?.priority || (restricted ? policy?.priority || "先完成教材要求的前置处置并重新辨证" : "");
  const treatmentRow: T = restricted ? { ...row, formulas,
    ...(pendingPrecondition ? { precondition: pendingPrecondition } : {}),
    // 阶段变化时不把原阶段的组成、加减带给开方；已完成前提的原方保持完整。
    composition: fallback ? composition(fallback) : [], modifications: [],
    therapy: pending ? fallback?.therapy || "" : formulas.length ? row.therapy : "",
    formulaJoin: formulas.length === 1 ? "single" : "combined",
  } : row;
  const preconditionText = typeof row.precondition === "string" ? row.precondition : row.preconditionNotice || condition?.quote;
  const notice = !preconditionText && !row.formulaSequence?.length && !row.formulaStage && !policy ? "" : [
    preconditionText ? `前置处置：${preconditionText}` : "",
    row.formulaStage ? `适用阶段：${row.formulaStage}` : "",
    row.formulaSequence?.length ? `用方先后：${row.formulaSequence.map((step) => `${step.stage}：${step.formulas.join("、")}`).join("；")}（不得作合方）` : "",
    priority || policy?.priority || "",
    representativeFormulas.length ? `当前阶段仅参考：${formulas.join("、")}，须结合上述处置。` : "本例未确认用方前提或已满足停药条件，先完成上述处置并重新辨证；不把本行代表方作为当前方。",
    fallback ? `当前配合方向：${formulas.join("合")}，不得延误上述处置。` : "",
  ].filter(Boolean).join("；");
  return { row: treatmentRow, formulas, representativeFormulas, pendingPrecondition, restricted, sequential, priority, notice };
}

/** 兼容接口：原代表方清单，不包含术前替代方。 */
export function currentTextbookFormulas(row: TextbookFormulaStageRow, recordText = ""): string[] {
  return evaluateTextbookFormulaUse(row, recordText)!.representativeFormulas;
}

/** 渲染接口：不自行判断阶段或可用方。 */
export function textbookFormulaStageNotice(row: TextbookFormulaStageRow, recordText = ""): string {
  return evaluateTextbookFormulaUse(row, recordText)!.notice;
}
