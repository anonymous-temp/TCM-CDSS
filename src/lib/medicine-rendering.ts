import type { CaseState, ClinicalReasoningResultV2 } from "./diagnosis-types";
import { clinicalOutputLabel, clinicalSentence } from "./clinical-output-authority";
import { clinicianVisibleMedicationRiskNote } from "./patient-relevant-medication-risk";

type Medicine = NonNullable<NonNullable<ClinicalReasoningResultV2["formula"]>["patentAndWestern"]>[number];
type RenderMedicine = Partial<Omit<Medicine, "evidence">> & { evidence?: { source?: string } | null };
const cell = (value: unknown): string => typeof value === "string" ? value.replace(/[|\r\n]+/g, " ").trim() : "";

export function medicineCandidateRow(item: RenderMedicine, state?: Partial<CaseState> | null, risk = item.riskNote): string {
  const level = item.recommendationMode === "discussion_only" ? "仅供讨论（无剂量）" : "说明书绑定候选（无剂量）";
  const usage = clinicalSentence([item.route, item.singleDose, item.frequency, item.administrationTiming, item.course].map(cell), "，");
  const visibleRisk = clinicianVisibleMedicationRiskNote(cell(risk), state);
  return `| ${cell(item.type)} | ${cell(item.name)} | ${cell(item.specification) || "—"} | ${level} | ${cell(usage) || "—"} | ${cell(item.positioning)} | ${cell(item.correspondingProblem)} | ${cell(item.evidence?.source)} | ${cell(visibleRisk)} |`;
}

export function medicineCandidateTable(items: readonly RenderMedicine[], state?: Partial<CaseState> | null): string[] {
  return [
    `## ${clinicalOutputLabel("M04-patent-western", "中成药/西药候选")}`,
    "| 类型 | 药品 | 规格 | 建议层级 | 说明书用法 | 用药定位 | 对应问题 | 参考文献 | 风险提示 |",
    "|---|---|---|---|---|---|---|---|---|",
    ...items.map((item) => medicineCandidateRow(item, state)),
  ];
}


