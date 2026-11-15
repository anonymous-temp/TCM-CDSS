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

export interface TextbookFormulaStageRow {
  formulas: string[];
  formulaJoin: string;
  precondition?: string;
  formulaStage?: string;
  formulaSequence?: Array<{ stage: string; formulas: string[] }>;
  runtimePolicy?: {
    requireAll?: string[][];
    stopIfAny?: string[];
    sequenceRequirements?: Record<string, string[][]>;
    priority: string;
  };
}

/** 不把术后/苏醒后方当作当前方，也不把「先用、继用」拼成合方。 */
export function currentTextbookFormulas(row: TextbookFormulaStageRow, recordText = ""): string[] {
  const policy = row.runtimePolicy;
  if (policy?.stopIfAny && affirmedTextbookTerm(recordText, policy.stopIfAny)) return [];
  if (policy?.requireAll?.some((group) => !affirmedTextbookTerm(recordText, group))) return [];
  if (row.formulaJoin === "sequential" && row.formulaSequence?.length) {
    const available = row.formulaSequence.filter((step, index) => index === 0 ||
      Boolean(policy?.sequenceRequirements?.[step.stage]?.every((group) => affirmedTextbookTerm(recordText, group))));
    return available.at(-1)?.formulas || [];
  }
  // 条件方须由医生按分支再择，不把五首方拼成一张方。
  if (row.formulaJoin === "conditional") return [];
  return row.formulas;
}

export function textbookFormulaStageNotice(row: TextbookFormulaStageRow, recordText = ""): string {
  if (!row.precondition && !row.formulaSequence?.length && !row.formulaStage) return "";
  const current = currentTextbookFormulas(row, recordText);
  return [
    row.precondition ? `前置处置：${row.precondition}` : "",
    row.formulaStage ? `适用阶段：${row.formulaStage}` : "",
    row.formulaSequence?.length ? `用方先后：${row.formulaSequence.map((step) => `${step.stage}：${step.formulas.join("、")}`).join("；")}（不得作合方）` : "",
    row.runtimePolicy?.priority || "",
    current.length ? `当前阶段仅参考：${current.join("、")}，须结合上述处置。` : "本例未确认用方前提，先完成上述处置并重新辨证；不把本行代表方作为当前方。",
  ].filter(Boolean).join("；");
}
