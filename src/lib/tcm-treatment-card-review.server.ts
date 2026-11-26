import "server-only";
import { primaryModelJsonTask } from "./cross-model-small-task.server";
import { treatmentReviewInput, type TreatmentReviewCard, type TreatmentReview } from "./tcm-treatment-card-review";
export type { TreatmentReview } from "./tcm-treatment-card-review";

export async function reviewTreatmentCards(cards: TreatmentReviewCard[], record: string, diagnoses: string, signal?: AbortSignal, task = primaryModelJsonTask): Promise<TreatmentReview | undefined> {
  if (!cards.length || !record.trim()) return;
  const candidates = cards.map(treatmentReviewInput);
  try {
    return await task("tcm_treatment_card_fit", "prescribe", [
      { role: "system", content: '逐张核对治疗项目所针对的主病、证候、病程阶段、部位、操作与食疗成分是否适合本例。依据不足以否定时保留。有明确不符或卡内操作互相矛盾时撤下该项供医师重新评估。不改剂量、操作或必须核查的项目。对于通用禁忌列表，已经符合的应撤下整项；需面诊核实、资料不清或与本人相关的条目保留，只有年龄、部位等明确不适用于本人时才略去。每组备选穴按本例选一项。按输入顺序返回 {"cards":[{"project":"原项目代码","keep":true,"choices":[],"cautions":[]}]}，choices 为各组所选穴的从零开始的序号，cautions 为要展示的禁忌条目序号。' },
      { role: "user", content: JSON.stringify({ record: record.slice(0, 6000), diagnoses, candidates }) },
    ], { maxTokens: 450, timeoutMs: 3200 }, (raw) => {
      const result = JSON.parse(String(raw)).cards;
      if (!Array.isArray(result) || result.length !== cards.length) return;
      const decisions: TreatmentReview = new Map();
      for (const [i, row] of result.entries()) {
        const alternatives = candidates[i].alternatives;
        if (!row || row.project !== candidates[i].project || typeof row.keep !== "boolean" || !Array.isArray(row.choices)) continue;
        if (row.keep && (row.choices.length !== alternatives.length || alternatives.some((options, j) =>
          !Number.isInteger(row.choices[j]) || !options[row.choices[j]]))) continue;
        const cautions = row.cautions;
        if (!Array.isArray(cautions) || cautions.some((index) => !Number.isInteger(index) || !candidates[i].cautions[index])) continue;
        decisions.set(JSON.stringify(candidates[i]), { keep: row.keep, choices: row.choices, cautions });
      }
      return decisions;
    }, signal);
  } catch {
    return undefined;
  }
}
