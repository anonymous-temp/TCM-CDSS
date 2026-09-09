import type { CaseState, ClinicalReasoningResultV2 } from "./diagnosis-types";
import { clinicalOutputLabel, clinicalSentence } from "./clinical-output-authority";
import { clinicianVisibleMedicationRiskNote } from "./patient-relevant-medication-risk";
import { findLocalPatentMedicineEntry } from "./local-patent-medicine-candidates";

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

/** Re-derive provenance from governed data, including in the browser. A client reference flag or
 * signature-shaped string is never sufficient. Only this exact label cell is a reference domain;
 * patient-specific columns and every noncanonical/extended risk cell remain current risk prose.
 * External evidence cannot be independently verified here and retains conservative classification.
 */
export function verifiedLocalLabelRisk(item: Medicine): boolean {
  if (item.type !== "中成药" || !/^LOCAL-INST-\d+$/.test(item.evidenceId || "")) return false;
  const label = findLocalPatentMedicineEntry(item.name);
  if (!label || label.name !== item.name || label.specification !== item.specification ||
    label.fingerprint !== item.evidenceFingerprint || !item.evidence?.source.includes(`[${item.evidenceId}]`)) return false;
  const canonicalRisk = [label.contraindication, label.precaution, label.pregnancyLactation, label.interaction]
    .filter(Boolean).join("；").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 800);
  return Boolean(canonicalRisk) && item.riskNote === canonicalRisk;
}
