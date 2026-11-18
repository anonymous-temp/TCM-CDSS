import source from "../data/western-diagnosis-abbreviations.source.json" with { type: "json" };
import { diseaseEvidenceIndex, diseaseRefinementEnabled } from "./m03-disease-evidence";

export function westernDiagnosisAbbreviations(): readonly { abbreviation: string; fullName: string }[] {
  return diseaseRefinementEnabled() ? source.entries : source.entries.filter((entry) => !("diseaseRefinement" in entry));
}

export function westernDiagnosisAbbreviationFullName(name: string): string | undefined {
  return westernDiagnosisAbbreviations().find((entry) => entry.abbreviation.toUpperCase() === name.toUpperCase())?.fullName;
}

export function westernDiagnosisAliases(fullName: string): string[] {
  const key = fullName.normalize("NFKC").replace(/\s+/gu, "");
  return westernDiagnosisAbbreviations().filter((entry) => entry.fullName === key).map((entry) => entry.abbreviation);
}

/** 病名主体：去掉开头的「急性/慢性/急慢性」。主体至少 3 个字（「胃炎」「肺炎」这类两字主体太宽，不用）。 */
function westernCore(name: string): string {
  return name.normalize("NFKC").replace(/\s+/gu, "").replace(/^(?:急?慢|急)性/u, "");
}

function clauseAround(text: string, index: number): string {
  let start = index;
  while (start > 0 && !/[，,。；;\n]/u.test(text[start - 1])) start -= 1;
  let end = index;
  while (end < text.length && !/[，,。；;\n]/u.test(text[end])) end += 1;
  return text.slice(start, end).slice(0, 40);
}

/** 既往诊断在原病历槽位定位；简称不展开后再判极性。 */
export function affirmedWesternHistoryDiagnosis(history: string, western: string): { term: string; quote: string } | undefined {
  const core = westernCore(western);
  const aliases = diseaseRefinementEnabled() ? westernDiagnosisAliases(western) : [];
  if (core.length < 3 && aliases.length === 0) return undefined;
  const forms = [western, ...(core.length >= 3 ? [core] : []), ...aliases];
  for (const form of forms) {
    const at = diseaseEvidenceIndex(history, form, false);
    if (at !== undefined) return { term: history.slice(at, at + form.length), quote: clauseAround(history, at) };
  }
}
