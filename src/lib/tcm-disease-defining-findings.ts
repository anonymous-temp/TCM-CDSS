import source from "../data/tcm-disease-defining-findings.source.json" with { type: "json" };
import { authoritativePatientAgeYears, recordedFindingReading, recordMentionPolarityAt, trustedInputText } from "./diagnosis-safety";
import type { CaseState } from "./diagnosis-types";
import { chiefComplaintLeadSegment, diseaseEvidenceGroups, diseaseEvidenceTerm, diseaseRecordAge, diseaseRecordChief, diseaseRefinementEnabled, diseaseRuleEnabled } from "./m03-disease-evidence";
import { recordCourseDays } from "./western-record-course";
import { affirmedWesternHistoryDiagnosis } from "./western-diagnosis-aliases";

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
/**
 * 「部位＋痛」这一类定义性表现，病历在部位和痛字之间写了一到三个修饰字（「胃脘拘急作痛」「上腹部隐隐作痛」「腰部酸痛」）也算写到：
 * 此前只认表里逐字列的写法，胃痛·寒邪客胃证的病历被记了一条「上腹胃脘部疼痛——病历尚未记明该表现」（第六十二轮 d027）。
 * 构词式守卫：部位取表里这个词去掉痛字后的部分（至少两个字），中间不许有标点、否定词或并列连词；否认、未评估、他人的读法
 * 交给共用的病历读法（部位处须是本人当前肯定）——不另按小句前半有没有「不」字判，「不慎受凉后胃脘拘急作痛」是肯定。
 */
const SITE_PAIN_TERM = /^([\u4e00-\u9fff]{2,4}?)部?[疼痛]{1,2}$/u;
function affirmedSitePainWithModifier(recordText: string, term: string): boolean {
  const site = term.match(SITE_PAIN_TERM)?.[1];
  if (!site) return false;
  for (let at = recordText.indexOf(site); at >= 0; at = recordText.indexOf(site, at + 1)) {
    const after = recordText.slice(at + site.length).replace(/^部/u, "");
    const gap = after.match(/^([^，,。；;、：:\s]{1,3}?)[疼痛]/u)?.[1];
    if (!gap || /[不无未没非否和与及或]/u.test(gap)) continue;
    if (recordMentionPolarityAt(recordText, at) === "affirmed") return true;
  }
  return false;
}

export function affirmedDefiningFinding(recordText: string, term: string, exclusions: readonly string[] = []): boolean {
  const reading = recordedFindingReading(recordText, term);
  if (reading !== "affirmed" && reading !== "conflicting") return exclusions.length === 0 && !recordText.includes(term) && affirmedSitePainWithModifier(recordText, term);
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
  const chief = diseaseRecordChief(recordText);
  const specificOwnSite = rule.anyOf.some((branch) => branch.every((group) => group.some((term) => !rule.genericTerms?.includes(term) && affirmedDefiningFinding(chief, term, rule.lexicalExclusions?.[term]))));
  const anotherMainSite = chief && rule.mainSiteAlternatives?.some((name) => rules.find((item) => item.names.includes(name))?.anyOf
    .some((branch) => branch.every((group) => group.some((term) => affirmedDefiningFinding(chief, term)))));
  if (anotherMainSite && !specificOwnSite) return { status: "missing", rule };
  return { status: supported || definingTemperatureQuote(rule, recordText) ? "supported" : "missing", rule };
}

function definingTemperatureQuote(rule: FindingRule, recordText: string): string | undefined {
  if (rule.temperatureAbove === undefined) return undefined;
  const bound = rule.temperatureAbove;
  return [...recordText.matchAll(/(?:体温|T\s*[:：]?)\s*(\d{2}(?:\.\d+)?)\s*(?:℃|°C|C)?/giu)]
    .find((match) => Number(match[1]) > bound && recordMentionPolarityAt(recordText, match.index!) === "affirmed")?.[0];
}

export function diseaseDefiningFindingEvidence(rule: FindingRule, recordText: string): string[] {
  for (const branch of rule.anyOf) {
    const terms = branch.map((group) => group.find((term) => affirmedDefiningFinding(recordText, term, rule.lexicalExclusions?.[term])));
    if (terms.every((term): term is string => Boolean(term))) return terms;
  }
  const temperature = definingTemperatureQuote(rule, recordText);
  return temperature ? [temperature] : [];
}

type Groups = readonly (readonly string[])[];
type SourceRef = FindingRule["sourceRef"];
type RefinementBranch = {
  historyDiagnosis?: string;
  current?: Groups;
  anyRecord?: Groups;
  exam?: Groups;
  minimumChiefDays?: number;
};
type RefinementRule = {
  id?: string;
  fromNames: readonly string[];
  to: string;
  display?: string;
  chief?: Groups;
  branches?: readonly RefinementBranch[];
  minAge?: number;
  maxAge?: number;
  excludedChief?: readonly string[];
  allOf?: Groups;
  absent?: readonly string[];
  sourceRef: SourceRef;
};
export type DiseaseRecordContext = { recordText: string; chiefComplaint?: string; pastHistory?: string; exam?: string; ageYears?: number };
export type DiseaseRefinementMatch = { id?: string; section: string; display: string; definition: string; reference: string; evidence: string[] };

export function diseaseRecordContext(state: CaseState): DiseaseRecordContext {
  const symptoms = state.symptoms as Record<string, unknown> | undefined;
  const fields = state.hisRecord?.fields;
  const sourceText = (...values: unknown[]) => values.find((value): value is string => typeof value === "string" && Boolean(value.trim()));
  const recordText = trustedInputText(state);
  const exam = sourceText(fields?.fuzhuJiancha, symptoms?.exams, symptoms?.["辅助检查"]);
  const history = sourceText(fields?.jiwangshi, state.pastHistory, symptoms?.["既往史"], symptoms?.["既往病史"], symptoms?.pastHistory);
  return {
    recordText,
    chiefComplaint: state.chiefComplaint,
    pastHistory: history && recordText.includes(history) ? history : undefined,
    exam: exam && recordText.includes(exam) ? exam : undefined,
    ageYears: authoritativePatientAgeYears(state) ?? undefined,
  };
}

const recordSlot = (record: string, label: RegExp) => record.split("\n").find((line) => label.test(line))?.replace(label, "") || "";

function matchBranch(branch: RefinementBranch, input: DiseaseRecordContext, chief: string): string[] | undefined {
  const { recordText } = input;
  const pastHistory = input.pastHistory || recordSlot(recordText, /^(?:既往病?史)[：:]/u);
  const history = branch.historyDiagnosis ? affirmedWesternHistoryDiagnosis(pastHistory, branch.historyDiagnosis) : undefined;
  if (branch.historyDiagnosis && !history) return undefined;
  if (branch.minimumChiefDays && (recordCourseDays(chief)?.lower ?? 0) < branch.minimumChiefDays) return undefined;
  const exam = input.exam || recordSlot(recordText, /^(?:辅助检查|影像检查)[：:]/u);
  // 部位与检查所见必须出现在同一条报告，避免把手部退变与膝部检查拼接。
  const examEvidence = branch.exam ? exam.split(/[。；;\n]/u).map((clause) => diseaseEvidenceGroups(clause, branch.exam!, false)).find(Boolean) : [];
  const current = diseaseEvidenceGroups(recordText, branch.current || []);
  const anyRecord = diseaseEvidenceGroups(recordText, branch.anyRecord || [], false);
  if (!examEvidence || !current || !anyRecord) return undefined;
  return [...(history ? [history.term] : []), ...current, ...examEvidence, ...anyRecord];
}

export function textbookDiseaseRefinementMatches(input: DiseaseRecordContext, candidates: readonly string[], disease?: string): DiseaseRefinementMatch[] {
  const chief = chiefComplaintLeadSegment(input.chiefComplaint || diseaseRecordChief(input.recordText));
  const age = input.ageYears ?? diseaseRecordAge(input.recordText);
  return (source.refinements as RefinementRule[]).flatMap((row) => {
    if (!candidates.includes(row.to) || (disease && !row.fromNames.includes(core(disease)))) return [];
    if (row.id && (!diseaseRefinementEnabled() || !diseaseRuleEnabled(row.id))) return [];
    if (!row.id && !disease) return []; // 原有肛裂规则只在原病为痔时核对。
    if (row.minAge !== undefined && (age === undefined || age < row.minAge)) return [];
    if (row.maxAge !== undefined && (age === undefined || age >= row.maxAge)) return [];
    if (row.excludedChief?.some((term) => diseaseEvidenceTerm(chief, term))) return [];
    if (row.absent?.some((term) => affirmedDefiningFinding(input.recordText, term))) return [];
    const chiefEvidence = diseaseEvidenceGroups(chief, row.chief || []);
    const evidence = row.branches
      ? row.branches.map((branch) => matchBranch(branch, input, chief)).find(Boolean)
      : row.allOf?.map((group) => group.find((term) => affirmedDefiningFinding(input.recordText, term)));
    if (!chiefEvidence || !evidence || !evidence.every((term): term is string => Boolean(term))) return [];
    return [{ id: row.id, section: row.to, display: row.display || row.to, definition: row.sourceRef.quote,
      reference: `${row.sourceRef.book}:${row.sourceRef.line}`, evidence: [...new Set([...chiefEvidence, ...evidence])] }];
  });
}

/** 仅提名当前可用教材节；重画由现有中医半完成。 */
export function textbookDiseaseRefinement(disease: string, recordText: string, candidates: readonly string[]): string | undefined {
  return textbookDiseaseRefinementMatches({ recordText }, candidates, disease)[0]?.section;
}

export function diseaseVisitComplicationMatch(disease: string, input: DiseaseRecordContext): string[] | undefined {
  if (!diseaseRefinementEnabled()) return undefined;
  const rule = source.visitComplications.find((item) => item.disease === core(disease) && diseaseRuleEnabled(item.id));
  if (!rule) return undefined;
  const chief = diseaseEvidenceGroups(input.chiefComplaint || diseaseRecordChief(input.recordText), rule.chief);
  const findings = diseaseEvidenceGroups(input.recordText, rule.current);
  const exam = input.exam || input.recordText;
  const ketones = diseaseEvidenceGroups(exam, rule.exam);
  const glucose = [...exam.matchAll(/血糖\s*[：:]?\s*(\d+(?:\.\d+)?)\s*mmol\s*\/\s*L/giu)].find((match) =>
    Number(match[1]) >= rule.glucoseAtLeast && diseaseEvidenceTerm(exam, match[0]));
  if (chief && findings && ketones && glucose) return [...chief, ...findings, ...ketones, glucose[0]];
}

export function missingDiseaseFindingTerms(rule: FindingRule, record: string): { unrecorded: string[]; denied: string[] } {
  const unrecorded = new Set<string>();
  const denied = new Set<string>();
  for (const group of rule.anyOf.flat()) {
    if (group.some((term) => affirmedDefiningFinding(record, term, rule.lexicalExclusions?.[term]))) continue;
    const negatives = group.filter((term) => recordedFindingReading(record, term) === "denied");
    if (negatives.length) negatives.forEach((term) => denied.add(term));
    else unrecorded.add(group[0]);
  }
  return { unrecorded: [...unrecorded], denied: [...denied] };
}

/** 重画未能补齐时，保留病名和原依据，只记录尚无记载的定义性表现。 */
export function withDiseaseDefiningFindingCaveat(
  overview: { tcmDiseaseName?: unknown }, recordText: string, pathogenesis?: { uncertainties?: unknown },
): void {
  if (!pathogenesis || typeof overview.tcmDiseaseName !== "string" || !recordText.trim()) return;
  const result = diseaseDefiningFindingStatus(overview.tcmDiseaseName, recordText);
  if (result.status !== "missing" || !result.rule) return;
  const { unrecorded, denied } = missingDiseaseFindingTerms(result.rule, recordText);
  if (!unrecorded.length) return;
  const existing = Array.isArray(pathogenesis.uncertainties) ? pathogenesis.uncertainties : [];
  // 避名词同义追问。某一组已明确否认时只在重画指令记录其极性。
  const synonyms = result.rule.anyOf.flat().filter((group) => unrecorded.includes(group[0])).flat();
  if (existing.some((row) => [row?.item, row?.reason].some((value) =>
    typeof value === "string" && (value.includes(result.rule!.missing) || synonyms.some((term) => value.includes(term)))))) return;
  const item = denied.length ? unrecorded.join("、") : result.rule.missing;
  pathogenesis.uncertainties = [...existing, { item, reason: "病历尚未记明该表现", affects: `辨别${overview.tcmDiseaseName}` }];
}
