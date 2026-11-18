import source from "../data/tcm-textbook-disease-subtypes.source.json" with { type: "json" };
import { diseaseEvidenceGroups, diseaseEvidenceIndex, diseaseEvidenceTerm, diseaseRecordAge, diseaseRefinementEnabled, diseaseRuleEnabled } from "./m03-disease-evidence";
import { recordMentionPolarityAt } from "./diagnosis-safety";
import { courseSpans, recordCourseDays } from "./western-record-course";
import { affirmedWesternHistoryDiagnosis } from "./western-diagnosis-aliases";

type EvidenceRule = {
  id: string;
  disease: string;
  label: string;
  axis?: string;
  groups?: string[][];
  chief?: string[][];
  absent?: string[][];
  historyDiagnosis?: string;
  minAge?: number;
  maxAge?: number;
  historyGroups?: string[][];
  minimumChiefDays?: number;
  maximumChiefDays?: number;
  numeric?: string;
  rowGroup?: string;
  requiresImaging?: boolean;
  continuationForms?: string[];
  sameClauseGroups?: string[][];
  currentChiefGroups?: string[][];
};
const rules: EvidenceRule[] = source.evidenceRules;

export function isEvidenceDiseaseSubtype(disease: string, subtype?: string): boolean {
  const labels = subtype?.split("·") || [];
  const matching = rules.filter((rule) => rule.disease === disease && labels.includes(rule.label));
  return labels.length === 0 ? rules.some((rule) => rule.disease === disease) :
    matching.length === labels.length && new Set(matching.map((rule) => rule.axis)).size === labels.length;
}

export function evidenceSubtypeRowGroup(disease: string, subtype: string | undefined): string | undefined {
  return rules.find((rule) => rule.disease === disease && rule.rowGroup && subtype?.split("·").includes(rule.label))?.rowGroup;
}

export function evidenceSubtypeParent(name: string): string | undefined {
  // 「急性期」等通用阶段单写不能辨病。
  return rules.find((rule) => !rule.axis && rule.label === name)?.disease;
}

const STROKE_EVENTS = source.strokeTiming.eventForms;
const STROKE_FOCAL = source.strokeTiming.focalForms;
const EVENT_NEGATION = /^(?:无|否认)/u;
const VISIT_DATE = new RegExp(`(?:${source.strokeTiming.visitDateLabels.join("|")})[：:]\\s*(\\d{4}[-年]\\d{1,2}[-月]\\d{1,2}日?)`, "u");
const STOOL_FREQUENCY = new RegExp(`(?:${source.stoolFrequencyLabels.join("|")})\\s*(\\d{1,2})\\s*(?:[～~至-]\\s*\\d{1,2})?\\s*次`, "gu");
const NEAR_SIX_MONTHS = new RegExp(`(?:${source.strokeTiming.nearForms.join("|")})\\s*[6六]\\s*个?月`, "u");

function strokeEpisodeSentences(record: string): string[] {
  return record.normalize("NFKC").split(/[。；;\n]/u).filter((sentence) =>
    STROKE_EVENTS.some((form) => diseaseEvidenceTerm(sentence, form, false)));
}

function strokeTypeSupported(rule: EvidenceRule, episode: string): boolean {
  return Boolean(rule.groups?.every((group) => group.some((form) => {
    // 「无意识障碍」是有记录的否认，区别于现在清醒或病历漏记。
    if (EVENT_NEGATION.test(form)) {
      const at = episode.indexOf(form);
      return at >= 0 && recordMentionPolarityAt(episode, at) !== "excluded" &&
        diseaseEvidenceIndex(episode, form.replace(EVENT_NEGATION, ""), false) === undefined;
    }
    return Boolean(diseaseEvidenceTerm(episode, form, false));
  })));
}

function calendarDate(value: string): Date | undefined {
  const parts = value.split(/[-年月日]/u).filter(Boolean).map(Number);
  if (parts.length !== 3) return undefined;
  const [year, month, day] = parts;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : undefined;
}

function strokeRange(episode: string, record: string): { days: number; overSix?: boolean; endpoint?: boolean } | undefined {
  const first = episode.split(/[，,]/u)[0];
  const onsetDate = first.match(/\d{4}[-年]\d{1,2}[-月]\d{1,2}日?/u)?.[0];
  const visitDate = record.match(VISIT_DATE)?.[1];
  const onset = onsetDate && calendarDate(onsetDate);
  const visit = visitDate && calendarDate(visitDate);
  if (onset && visit && visit >= onset) {
    const year = onset.getUTCFullYear();
    const month = onset.getUTCMonth() + 6;
    const maxDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const boundary = new Date(Date.UTC(year, month, Math.min(onset.getUTCDate(), maxDay)));
    return { days: (visit.getTime() - onset.getTime()) / 86_400_000, overSix: visit > boundary, endpoint: +visit === +boundary };
  }
  if (first.includes("半年") || NEAR_SIX_MONTHS.test(first)) return undefined;
  const spans = courseSpans(first);
  if (spans.length !== 1) return undefined;
  const span = spans[0];
  const token = first.slice(span.index, span.index + span.length);
  if (span.lower === 180) {
    if (source.strokeTiming.strictOverForms.some((form) => token.includes(form)) || /超过\s*$/u.test(first.slice(0, span.index))) return { days: 181, overSix: true };
    return undefined;
  }
  if (span.upperExclusive) return undefined;
  // 数字“月/年”按日历单位比较；只报天数时跨过任意六个月的最大日数方可定后遗症期。
  if (/[月年]/u.test(token)) return { days: span.lower, overSix: span.lower > 180 };
  if (span.lower >= 181 && span.lower <= 184) return undefined;
  return { days: span.lower, overSix: span.lower > 184 };
}

function strokeSubtype(eligible: readonly EvidenceRule[], chief: string, record: string): string | undefined {
  const episodes = strokeEpisodeSentences(record);
  // 主诉与病历可能重复同一次记录，按证据结果去重；一旦多次发作给出不同分期就不自动贴标签。
  if (!episodes.length && STROKE_FOCAL.some((form) => diseaseEvidenceTerm(chief, form))) episodes.push(chief);
  const types = eligible.filter((rule) => rule.axis === "strokeType" && episodes.some((episode) => {
    const eventAt = Math.min(...STROKE_EVENTS.map((form) => diseaseEvidenceIndex(episode, form, false) ?? Infinity));
    if (!Number.isFinite(eventAt)) return false;
    const event = episode.slice(eventAt);
    const boundary = Math.min(...source.strokeTiming.currentContextForms.map((form) => event.indexOf(form)).filter((at) => at >= 0));
    const context = event.slice(0, Number.isFinite(boundary) ? boundary : undefined);
    return strokeTypeSupported(rule, context);
  }));
  const type = types.length === 1 ? types[0].label : undefined;
  const stages = new Set(episodes.map((episode) => {
    const range = strokeRange(episode, record);
    if (!range || range.endpoint) return undefined;
    if (range.overSix) return "stroke-sequela";
    if (range.days <= 14 || (type === "中脏腑" && range.days <= 30)) return "stroke-acute";
    if (range.days > 30 || type === "中经络") return "stroke-recovery";
    return undefined;
  }).filter(Boolean));
  const stage = stages.size === 1 ? eligible.find((rule) => rule.id === [...stages][0])?.label : undefined;
  return [type, stage].filter(Boolean).join("·") || undefined;
}

function subtypeCurrentEvidence(rule: EvidenceRule, chief: string, record: string): boolean {
  if (diseaseEvidenceGroups(record, rule.groups || [])) return true;
  if (rule.sameClauseGroups && record.split(/[。；;\n]/u).some((sentence) => diseaseEvidenceGroups(sentence, rule.sameClauseGroups!))) return true;
  if (!rule.continuationForms || !rule.currentChiefGroups || !diseaseEvidenceGroups(chief, rule.currentChiefGroups)) return false;
  return record.split(/[。；;\n]/u).some((sentence) => rule.continuationForms!.some((form) => {
    const at = diseaseEvidenceIndex(sentence, form, false);
    return at !== undefined && Boolean(diseaseEvidenceGroups(sentence.slice(at), rule.groups || []));
  }));
}

export function evidenceDiseaseSubtype(disease: string, chief: string, record: string, ageYears?: number): string | undefined {
  if (!diseaseRefinementEnabled()) return undefined;
  const age = ageYears ?? diseaseRecordAge(record);
  const eligible = rules.filter((rule) => rule.disease === disease && diseaseRuleEnabled(rule.id) &&
    (rule.minAge === undefined || (age !== undefined && age >= rule.minAge)) &&
    (rule.maxAge === undefined || (age !== undefined && age < rule.maxAge)));
  if (!eligible.length) return undefined;
  if (disease === "中风") return strokeSubtype(eligible, chief, record);
  const course = recordCourseDays(chief);
  const matches = eligible.filter((rule) => {
    if (!diseaseEvidenceGroups(chief, rule.chief || [])) return false;
    if (rule.requiresImaging) {
      const imaging = record.split(/[。；;\n]/u).filter((clause) => source.imagingForms.some((form) => diseaseEvidenceTerm(clause, form, false)));
      if (!imaging.some((clause) => diseaseEvidenceGroups(clause, rule.groups || []))) return false;
    } else if (!subtypeCurrentEvidence(rule, chief, record)) return false;
    if (rule.historyGroups && !diseaseEvidenceGroups(record, rule.historyGroups, false)) return false;
    if (rule.absent?.some((group) => diseaseEvidenceGroups(record, [group], false))) return false;
    if (rule.minimumChiefDays && (!course || course.lower < rule.minimumChiefDays)) return false;
    if (rule.maximumChiefDays && (!course || course.upper > rule.maximumChiefDays)) return false;
    if (rule.historyDiagnosis && !record.split("\n").some((line) =>
      /^(?:既往病?史)[：:]/u.test(line) && affirmedWesternHistoryDiagnosis(line, rule.historyDiagnosis!))) return false;
    if (rule.numeric === "stoolFrequency" && ![...record.matchAll(STOOL_FREQUENCY)]
      .some((match) => Number(match[1]) >= 3 && diseaseEvidenceTerm(record, match[0]))) return false;
    return true;
  });
  return matches.length === 1 ? matches[0].label : undefined;
}
