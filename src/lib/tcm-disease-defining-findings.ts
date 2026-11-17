import source from "../data/tcm-disease-defining-findings.source.json" with { type: "json" };
import { recordedFindingReading, recordMentionPolarityAt } from "./diagnosis-safety";

type FindingRule = {
  names: string[];
  missing: string;
  anyOf: string[][][];
  sourceRef: { book: string; line: number; quote: string };
  lexicalExclusions?: Record<string, string[]>;
  temperatureAbove?: number;
  mainSiteAlternatives?: string[];
  genericTerms?: string[];
};
const rules: readonly FindingRule[] = source.entries;
const core = (name: string) => name.trim().replace(/类病$/u, "").split(/[（(]/u)[0];

/** 有限教材表现闭集；极性、他人/未问及语境均复用现有读法，不新增开放语言分类器。 */
export function affirmedDefiningFinding(recordText: string, term: string, exclusions: readonly string[] = []): boolean {
  const reading = recordedFindingReading(recordText, term);
  if (reading !== "affirmed" && reading !== "conflicting") return false;
  let at = recordText.indexOf(term);
  while (at >= 0) {
    const embedded = exclusions.some((word) => {
      const start = at - word.indexOf(term);
      return start >= 0 && recordText.slice(start, start + word.length) === word;
    });
    if (!embedded && recordMentionPolarityAt(recordText, at) === "affirmed") return true;
    at = recordText.indexOf(term, at + term.length);
  }
  return false;
}

export function diseaseDefiningFindingStatus(disease: string, recordText: string): { status: "unlisted" | "supported" | "missing"; rule?: FindingRule } {
  const rule = rules.find((item) => item.names.includes(core(disease)));
  if (!rule) return { status: "unlisted" };
  const supported = rule.anyOf.some((branch) => branch.every((group) => group.some((term) => affirmedDefiningFinding(recordText, term, rule.lexicalExclusions?.[term]))));
  // 主诉明确了疼痛主部位时，正文笼统的「腹痛」不能推翻它。只比较表内同部位词组，不另读开放语言。
  // clinicalGroundingText 在权威年龄/性别之后直接写主诉值，不带「主诉：」标签。
  const chief = /主诉[：:]\s*([^\n]+)/u.exec(recordText)?.[1] || recordText.split("\n").find((line) => line.trim() && !/^患者(?:年龄|性别)[:：]/u.test(line)) || "";
  const specificOwnSite = rule.anyOf.some((branch) => branch.every((group) => group.some((term) => !rule.genericTerms?.includes(term) && affirmedDefiningFinding(chief, term, rule.lexicalExclusions?.[term]))));
  const anotherMainSite = chief && rule.mainSiteAlternatives?.some((name) => rules.find((item) => item.names.includes(name))?.anyOf
    .some((branch) => branch.every((group) => group.some((term) => affirmedDefiningFinding(chief, term)))));
  if (anotherMainSite && !specificOwnSite) return { status: "missing", rule };
  const temperature = rule.temperatureAbove !== undefined && [...recordText.matchAll(/(?:体温|T\s*[:：]?)\s*(\d{2}(?:\.\d+)?)\s*(?:℃|°C|C)?/giu)]
    .some((match) => Number(match[1]) > rule.temperatureAbove! && recordMentionPolarityAt(recordText, match.index!) === "affirmed");
  return { status: supported || temperature ? "supported" : "missing", rule };
}

/** 仅提名教材中已有且在闭集里的细分病名，重抽时由原中医半重写依据；不直接篡改结论。 */
export function textbookDiseaseRefinement(disease: string, recordText: string, candidates: readonly string[]): string | undefined {
  return source.refinements.find((row) => row.fromNames.includes(core(disease)) && candidates.includes(row.to) &&
    row.allOf.every((group) => group.some((term) => affirmedDefiningFinding(recordText, term))) &&
    !row.absent.some((term) => affirmedDefiningFinding(recordText, term)))?.to;
}

/** 重抽后仍缺定义性表现、重抽失败或无可用重抽通道时，保留病名并明确证据缺口。幂等。 */
export function withDiseaseDefiningFindingCaveat<T extends { tcmDiseaseName?: unknown; tcmDiseaseRationale?: unknown }>(overview: T, recordText: string): void {
  if (typeof overview.tcmDiseaseName !== "string" || typeof overview.tcmDiseaseRationale !== "string" || !recordText.trim()) return;
  const result = diseaseDefiningFindingStatus(overview.tcmDiseaseName, recordText);
  if (result.status !== "missing" || !result.rule) return;
  const note = `${result.rule.missing}尚未见，病名待核实`;
  const rationale = overview.tcmDiseaseRationale.trim();
  if (!rationale.includes(note)) overview.tcmDiseaseRationale = `${rationale.replace(/[。；;，,]+$/u, "")}${rationale ? "；" : ""}${note}。`;
}
