import mapping from "../data/tcm-emergency-redflag-map.source.json" with { type: "json" };
import selection from "../data/tcm-emergency-selection.source.json" with { type: "json" };
import type { CaseState } from "./diagnosis-types";
import { evaluateSafetyGate, trustedInputText } from "./diagnosis-safety";
import { groundClinicalFacts } from "./clinical-facts";
import { textbookRowById } from "./tcm-textbook-syndromes";
import { affirmedTextbookTerm, textbookFormulaStageNotice } from "./textbook-formula-stage";

export type EmergencyTextbookCandidate = { rowId: string; disease: string; category: string; matched: string[] };

/** 红旗只提供入口；每一行还须满足 KD 归纳的全部表现组。这里从不写回闸门。 */
export function emergencyTextbookCandidates(caseState: CaseState): EmergencyTextbookCandidate[] {
  const gate = caseState.safetyGate || evaluateSafetyGate(caseState);
  if (gate.status !== "red_flag") return [];
  const text = trustedInputText(caseState);
  const categories = new Set<string>(caseState.clinicalFacts
    ? groundClinicalFacts(caseState.clinicalFacts, text).redFlags.filter((finding) =>
      finding.subject === "patient" && finding.status === "positive" && finding.urgency === "emergency").map((finding) => finding.category)
    : []);
  const found = new Map<string, EmergencyTextbookCandidate>();
  for (const binding of selection.bindings) {
    if (!gate.redFlags.some((flag) => binding.reasonCues.some((cue) => flag.includes(cue))) &&
      !binding.factCategories.some((category) => categories.has(category))) continue;
    const category = mapping.find((item) => item.gateCategory === binding.gateCategory);
    for (const rowId of category?.candidateRows || []) {
      const rule = (selection.rows as Record<string, { allOf: string[][]; allowHistoricalGroups?: number[] }>)[rowId];
      const row = textbookRowById(rowId);
      if (!row || !rule || found.has(rowId)) continue;
      if ((row.bookKey === "erke" || /儿科/u.test(row.department)) &&
        !(typeof caseState.patient?.age === "number" && caseState.patient.age < 14)) continue;
      if (/妇|产科/u.test(row.department) && /男/u.test(caseState.patient?.sex || "")) continue;
      const matched = rule.allOf.map((terms, index) => affirmedTextbookTerm(text, terms, rule.allowHistoricalGroups?.includes(index)));
      if (matched.some((term) => !term)) continue;
      found.set(rowId, { rowId, disease: row.disease, category: binding.gateCategory, matched: matched as string[] });
    }
  }
  return [...found.values()];
}

export function withEmergencyDiseasesFirst(picks: readonly string[], candidates: readonly EmergencyTextbookCandidate[]): string[] {
  return [...new Set([...candidates.map((item) => item.disease), ...picks])];
}

export function emergencyTextbookNotice(candidates: readonly EmergencyTextbookCandidate[], recordText: string): string {
  if (!candidates.length) return "";
  return ["", "【急症辨证候选优先】", "以下候选因当前危急表现与教材分支相符而排在前面。先处理急症病因、闭脱与救治先后，再辨病辨证；仅作候选，不凭红旗类别确诊，不替代急诊处置。",
    ...candidates.map((item) => {
      const row = textbookRowById(item.rowId)!;
      const notice = textbookFormulaStageNotice(row, recordText);
      return `${row.disease}·${row.syndromeName}：${item.category}，病历有「${item.matched.join("」「")}」。${notice}`;
    }),
  ].join("\n");
}
