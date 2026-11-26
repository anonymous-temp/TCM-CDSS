import type { CaseState } from "./diagnosis-types";
import { auxiliaryReportForeignPersons } from "./diagnosis-safety";

/** 报告包开头常是全部报告的合并摘要。含错贴报告时仅保留身份相符的独立报告段。 */
export function westernPatientRecord(state: CaseState): CaseState {
  const foreign = auxiliaryReportForeignPersons(state).length > 0;
  if (!foreign && !state.hisRecord?.fields.tcmLineagePreference) return state;
  const copy = structuredClone(state);
  if (copy.hisRecord) delete copy.hisRecord.fields.tcmLineagePreference;
  if (!foreign) return copy;
  const rawReplacements = new Map<string, string>();
  for (const fields of [copy.symptoms, copy.hisRecord?.fields]) {
    if (!fields) continue;
    for (const [key, value] of Object.entries(fields)) {
      if (typeof value !== "string") continue;
      const hasForeignReport = (report: string) => auxiliaryReportForeignPersons({
        ...state, symptoms: { [key]: report }, hisRecord: state.hisRecord && { ...state.hisRecord,
          fields: { age: state.hisRecord.fields.age, sex: state.hisRecord.fields.sex, [key]: report },
        },
      }).length > 0;
      if (!hasForeignReport(value)) continue;
      const reports = value.split(/(?=【报告解读】)/u);
      const kept = reports.filter(report => report.startsWith("【报告解读】") && !hasForeignReport(report)).join("\n").trim();
      (fields as Record<string, unknown>)[key] = kept;
      rawReplacements.set(value, kept);
    }
  }
  if (copy.hisRecord?.rawText) {
    for (const [original, kept] of rawReplacements) copy.hisRecord.rawText = copy.hisRecord.rawText.replaceAll(original, kept);
  }
  return copy;
}
