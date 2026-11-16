import closureJson from "../data/tcm-analysis-element-closure.source.json" with { type: "json" };
import { clinicalEventTemporalScopeAt } from "./clinical-polarity";
import { clauseLocalMentionPolarityAt } from "./diagnosis-safety";

/**
 * 证名、病性轴、病机链、总体病机、治法、辨证依据对同一组实邪证素说同一句话（2026-11-15 第四十六轮）。
 *
 * 甲方 11.05「病机分析」17/17 不合格、两次点名「分析为脾虚湿蕴，证名只写脾虚证」；第四十五轮逐字复核 200 份里同一类 40 余处：
 *  · 经行泄泻·脾虚证（教材治法「健脾渗湿，理气调经」）：病机链写「湿浊下注大肠」，治法健脾渗湿，病性栏却只有气虚、标实「无」，
 *    证名也只写脾虚证（new45-n20、new40-m23）；肥胖·脾虚不运证「渗利水湿」、子肿·脾虚证「健脾除湿，行水消肿」同样（m13、m18）。
 *    分析与结论对齐那一步（m03-analysis-alignment）看到病性栏的湿不在证名里，让模型把湿从病性栏删掉——只会把分析往下改，
 *    治法里明明在治湿。
 * 这一模块只做确定性的那一半：治法本身在治的实邪（methodImpliedExcessElements），分析也写了它、病历有两条以上它的表现时，
 * 病性栏要列出它（withMethodImpliedNatureElements）；证名由交付面的国标合称接上（脾虚证 + 湿 → 脾虚湿困证，compositeSyndromeRename）。
 * 治法没在治、模型自己在分析里立的实邪，由证素核对（m03-element-support）按《中医诊断学》辨证要点判：成组则证名带上，不成组则撤回。
 * 词表在 tcm-analysis-element-closure.source.json（受治理来源）。
 */

type Json = Record<string, unknown>;
export type ExcessElementId = "damp" | "water" | "phlegm" | "stasis" | "fluid";
export type ExcessElement = {
  id: ExcessElementId;
  label: string;
  criteriaEntry: string;
  secondaryNames: string[];
  methodItem: string;
  compound: Array<{ with: string; mention: string; criteriaEntry: string; secondaryNames: string[]; methodItem: string }>;
  nameMarkers: string[];
  analysisMentions: string[];
  methodWords: string[];
  recordSigns: string[];
};
const CLOSURE = closureJson as unknown as {
  elements: ExcessElement[];
  minRecordSigns: number;
  conclusionLeads: string[];
  conclusionMarkers: string[];
  uncertaintyAnswers: { rows: Array<{ asked: string; answered: string }>; itemGlue: string };
  promptInternalWording: { phrases: string[] };
  metaUncertaintyWording: { phrases: string[] };
};
export const EXCESS_ELEMENTS: readonly ExcessElement[] = CLOSURE.elements;
export const MIN_RECORD_SIGNS = CLOSURE.minRecordSigns;
const byId = new Map(EXCESS_ELEMENTS.map((element) => [element.id, element]));
export function excessElement(id: ExcessElementId): ExcessElement {
  return byId.get(id)!;
}

const record = (value: unknown): Json | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
const records = (value: unknown): Json[] => Array.isArray(value) ? value.flatMap((item) => { const entry = record(item); return entry ? [entry] : []; }) : [];
const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const strings = (value: unknown): string[] => Array.isArray(value) ? value.map(text).filter(Boolean) : [];

// 否认、排除写在说法前几个字里（「无湿热」「非痰浊」「未见瘀血」「不属湿阻」），这一处不算分析在说本例有它。
const NEGATED_BEFORE = /(?:无|非|不属|未见|尚无|并非|不是|未及|否认|未有|排除)[一-鿿]{0,3}$/u;

/** 一段分析里写到的实邪证素（病机写法，最长匹配；否认说法不算）。 */
export function excessElementMentionsIn(value: string): Set<ExcessElementId> {
  const found = new Set<ExcessElementId>();
  const source = String(value || "");
  for (const element of EXCESS_ELEMENTS) {
    for (const mention of element.analysisMentions) {
      let at = source.indexOf(mention);
      while (at >= 0) {
        if (!NEGATED_BEFORE.test(source.slice(Math.max(0, at - 6), at))) { found.add(element.id); break; }
        at = source.indexOf(mention, at + mention.length);
      }
      if (found.has(element.id)) break;
    }
  }
  return found;
}

/** 证名（主证、兼证）里已有的实邪证素。 */
export function namedExcessElements(names: readonly string[]): Set<ExcessElementId> {
  const joined = names.map((name) => String(name || "").replace(/证$/u, "")).join("、");
  return new Set(EXCESS_ELEMENTS.filter((element) => element.nameMarkers.some((marker) => joined.includes(marker))).map((element) => element.id));
}

/** 治法在治的实邪证素（治法写法：渗湿、化痰、活血、利水、化饮…）。湿与水停同治时只算湿（渗利水湿、利水渗湿）。 */
export function methodImpliedExcessElements(method: string): Set<ExcessElementId> {
  const value = String(method || "");
  const found = new Set(EXCESS_ELEMENTS.filter((element) => element.methodWords.some((word) => value.includes(word))).map((element) => element.id));
  if (found.has("damp")) found.delete("water");
  return found;
}

/** 病性栏（items、本虚、标实）写到这一证素。 */
export function natureListsElement(nature: Json | undefined, id: ExcessElementId): boolean {
  const items = [...strings(nature?.items), ...strings(nature?.rootDeficiency), ...strings(nature?.branchExcess)].join("、");
  if (!items) return false;
  const element = excessElement(id);
  return element.nameMarkers.some((marker) => items.includes(marker)) || element.analysisMentions.some((mention) => items.includes(mention));
}

/**
 * 病历里这一证素的表现（肯定的、本人的；同一处只认最长的写法）：返回所见写法与所在小句原文。
 * 极性按所在逗号小句读（clauseLocalMentionPolarityAt），「无浮肿」「是否便溏尚未询问」不算。
 */
export function recordExcessSigns(recordText: string, id: ExcessElementId): Array<{ sign: string; quote: string }> {
  const source = String(recordText || "");
  if (!source) return [];
  const signs = [...excessElement(id).recordSigns].sort((a, b) => b.length - a.length);
  const taken: Array<[number, number]> = [];
  const out: Array<{ sign: string; quote: string }> = [];
  for (const sign of signs) {
    for (let at = source.indexOf(sign); at >= 0; at = source.indexOf(sign, at + 1)) {
      if (taken.some(([from, to]) => at < to && at + sign.length > from)) continue;
      if (clauseLocalMentionPolarityAt(source, at) !== "affirmed") continue;
      taken.push([at, at + sign.length]);
      const left = Math.max(...["，", ",", "。", "；", ";", "\n", "：", ":"].map((mark) => source.lastIndexOf(mark, at)));
      const rights = ["，", ",", "。", "；", ";", "\n"].map((mark) => source.indexOf(mark, at)).filter((index) => index >= 0);
      const quote = source.slice(left + 1, rights.length > 0 ? Math.min(...rights) : source.length).trim();
      if (!out.some((item) => item.sign === sign)) out.push({ sign, quote });
      break;
    }
  }
  // 「苔白腻」与「苔腻」、「便溏」与「大便溏」是同一处表现的写法：按所在小句去重计数。
  const seenQuotes = new Set<string>();
  return out.filter((item) => (seenQuotes.has(item.quote) ? false : (seenQuotes.add(item.quote), true)));
}

/** 分析各段（病机链各节点、总体病机、辨证依据）。 */
function analysisTexts(reasoning: Json): string[] {
  const overview = record(reasoning.overview);
  const pathogenesis = record(reasoning.pathogenesis);
  return [
    ...records(pathogenesis?.chain).map((node) => text(node.pathogenesis)),
    text(overview?.overallPathogenesis),
    text(overview?.tcmDiagnosticRationale),
  ].filter(Boolean);
}

/**
 * 治法在治、分析也写了、病历有两条以上表现的实邪证素，病性栏补上（items 与标实两栏，依据补上病历原文小句）。纯函数、就地改，返回补上的标签。
 * 只补不删；病性栏已经写了的不动。给交付面与几处「交付时证名」的预判共用（compositeSyndromeRename 之前）。
 */
export function withMethodImpliedNatureElements(reasoning: Json, recordText: string): string[] {
  const overview = record(reasoning.overview);
  const pathogenesis = record(reasoning.pathogenesis);
  const nature = record(pathogenesis?.natureDifferentiation);
  const method = text(record(reasoning.therapy)?.overallMethod) || text(overview?.overallTherapy);
  if (!overview || !nature || !method || !recordText) return [];
  const asserted = excessElementMentionsIn(analysisTexts(reasoning).join("。"));
  const added: string[] = [];
  for (const id of methodImpliedExcessElements(method)) {
    if (!asserted.has(id) || natureListsElement(nature, id)) continue;
    const signs = recordExcessSigns(recordText, id);
    if (signs.length < MIN_RECORD_SIGNS) continue;
    const label = excessElement(id).label;
    nature.items = [...strings(nature.items), label];
    nature.branchExcess = [...strings(nature.branchExcess), label];
    const basis = text(nature.basis);
    const quotes = signs.slice(0, 2).map((item) => item.quote).filter((quote) => quote && !basis.includes(quote));
    if (quotes.length > 0) nature.basis = [basis, ...quotes].filter(Boolean).join("；");
    added.push(label);
  }
  return added;
}

/** 辨证依据里下结论的那几小句（「诸症合参，证属…」「故辨证为…」「合为…之证」）。 */
export function rationaleConclusionClauses(rationale: string): string[] {
  const sentences = String(rationale || "").split(/[。；;]/u).map((sentence) => sentence.trim()).filter(Boolean);
  return sentences.flatMap((sentence) => {
    const clauses = sentence.split(/[，,]/u).map((clause) => clause.trim()).filter(Boolean);
    const leadAt = clauses.findIndex((clause) => CLOSURE.conclusionLeads.some((lead) => clause.startsWith(lead)));
    return clauses.filter((clause, index) => (leadAt >= 0 && index >= leadAt) || CLOSURE.conclusionMarkers.some((marker) => clause.includes(marker)));
  });
}

/**
 * 只有一个结论引语、后面什么都没有的句子（「诸症合参。」「综上。」）：别的核对删掉结论小句后留下的残句（第四十六轮重跑 n36
 * 「…为久病络脉瘀滞之外候。诸症合参。发声费力…」）。整句去掉。
 */
export function withoutDanglingConclusionLeads(value: string): string {
  const leads = CLOSURE.conclusionLeads.map((lead) => lead.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|");
  return String(value || "")
    .replace(new RegExp(`(^|[。；;])\\s*(?:故|因此|综合)?(?:${leads})[，,]?\\s*(?:[。；;]|$)`, "gu"), "$1")
    .replace(/^[。；;，,\s]+/u, "")
    .trim();
}

/**
 * 待核实项问的是病历已经写明的四诊属性（舌苔厚薄而病历记苔薄、肢温而病历记皮肤湿冷）。有限闭集（uncertaintyAnswers），
 * 只看待核实的那件事（item）：病历里有对这件事的回答（肯定或否定）即算已写明。
 */
const ANSWER_ROWS = CLOSURE.uncertaintyAnswers.rows.map((row) => ({ asked: new RegExp(row.asked, "u"), answered: new RegExp(row.answered, "u") }));
const ANSWER_ITEM_GLUE = new RegExp(CLOSURE.uncertaintyAnswers.itemGlue, "u");
function answerRowsCoverItem(item: string, matches: typeof ANSWER_ROWS): boolean {
  const remainder = matches.reduce((rest, row) => rest.replace(new RegExp(row.asked.source, "gu"), ""), item);
  return ANSWER_ITEM_GLUE.test(remainder);
}
function answerIsRecorded(row: typeof ANSWER_ROWS[number], source: string): boolean {
  for (const hit of source.matchAll(new RegExp(row.answered.source, "gu"))) {
    const at = hit.index ?? 0;
    if (clauseLocalMentionPolarityAt(source, at) === "excluded") continue;
    if (clinicalEventTemporalScopeAt(source, at, hit[0].length, { groundingQuote: true }) !== "current") continue;
    return true; // Positive, negative and normal findings all answer an existence/attribute question.
  }
  return false;
}
export function uncertaintyAnsweredByRecord(item: string, recordText: string): boolean {
  const asked = String(item || "");
  const source = String(recordText || "");
  if (!asked || !source) return false;
  const matches = ANSWER_ROWS.filter((row) => row.asked.test(asked));
  if (!answerRowsCoverItem(asked, matches)) return false;
  return matches.length > 0 && matches.every((row) => answerIsRecorded(row, source));
}

/** 组合问项只剩一部分未答时，交付剩余问项，不能把已有回答也写成“未记录”。 */
export function uncertaintyWithRecordedAnswers<T extends { item?: unknown; reason?: unknown }>(row: T, recordText: string): T | undefined {
  const item = text(row.item);
  const matches = ANSWER_ROWS.filter((entry) => entry.asked.test(item));
  if (!answerRowsCoverItem(item, matches)) return row;
  if (!matches.some((entry) => answerIsRecorded(entry, recordText))) return row;
  const missing = matches.filter((entry) => !answerIsRecorded(entry, recordText));
  if (missing.length === 0) return undefined;
  const pending = [...new Set(missing.map((entry) => entry.asked.exec(item)?.[0]).filter(Boolean))].join("、");
  return { ...row, item: pending, reason: `尚需核实${pending}` };
}

const PROMPT_INTERNAL = new RegExp(CLOSURE.promptInternalWording.phrases.map((phrase) => phrase.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|"), "u");
const META_UNCERTAINTY = new RegExp(CLOSURE.metaUncertaintyWording.phrases.map((phrase) => phrase.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|"), "u");
/** 待核实项里出现服务端提示段的内部说法（「按否认读」「病历读法」「闭集」…）：提示词用语外露。 */
export function uncertaintyLeaksPromptWording(row: { item?: unknown; reason?: unknown; affects?: unknown }): boolean {
  return PROMPT_INTERNAL.test([row.item, row.reason, row.affects].map((value) => typeof value === "string" ? value : "").join("；"));
}
/** 待核实项在评论证名本身（「湿邪是否作为独立病性要素」「结论证名未列湿」）：讲辨证规则，不是要核实的病人情况。 */
export function uncertaintyDiscussesSyndromeNaming(row: { item?: unknown; reason?: unknown; affects?: unknown }): boolean {
  return META_UNCERTAINTY.test([row.item, row.reason, row.affects].map((value) => typeof value === "string" ? value : "").join("；"));
}

/**
 * 待核实项问「是否兼X」，而病位栏已列X的脏腑、病性栏已列X的病性（第四十六轮复核 C043：病位脾、病性阳虚，待核实又问「是否兼脾阳虚」）。
 * 证素核对撤了这一证素而另一处又写着它时会这样；已列着就不再问。
 */
const ORGAN_CHARACTERS = /[心肝脾肺肾胃胆肠]/gu;
export function uncertaintyAsksListedElement(item: string, pathogenesis: Json | undefined): boolean {
  const asked = String(item || "").trim().match(/^是否(?:兼|夹|合并)(?:有)?([一-鿿]{2,6}?)证?$/u)?.[1];
  if (!asked || !pathogenesis) return false;
  const typePart = asked.replace(ORGAN_CHARACTERS, "");
  if (typePart.length < 1) return false;
  const nature = record(pathogenesis.natureDifferentiation);
  const natureText = [...strings(nature?.items), ...strings(nature?.rootDeficiency), ...strings(nature?.branchExcess)].join("、");
  if (!natureText.includes(typePart)) return false;
  const organs = [...new Set(asked.match(ORGAN_CHARACTERS) || [])];
  const locations = strings(record(pathogenesis.locationDifferentiation)?.items).join("、");
  return organs.every((organ) => locations.includes(organ));
}

const NATURE_SIGN_ROWS = (closureJson as unknown as { natureSigns: { rows: Array<{ type: string; labels: string[]; signs: string[] }> } }).natureSigns.rows;
/**
 * 病性栏一条（「气虚」「血瘀」「湿」「气血两虚」）在病历里该有哪些表现。气血阴阳虚与气滞按 natureSigns，实邪五类按 elements 的 recordSigns；
 * 寒、热这类由调用方按寒热见证表判。认不出的返回空数组。
 */
export function natureLabelSignTerms(label: string): string[] {
  const value = String(label || "");
  const fromRows = NATURE_SIGN_ROWS.filter((row) => row.labels.some((name) => value.includes(name))).flatMap((row) => row.signs);
  const fromElements = EXCESS_ELEMENTS.filter((element) => element.nameMarkers.some((marker) => value.includes(marker)) || value === element.label)
    .flatMap((element) => element.recordSigns);
  return [...new Set([...fromRows, ...fromElements])];
}

/**
 * 一段话里有没有这一表现。「舌淡」不认「舌淡红」（淡红舌是正常舌象，第四十六轮复核 C081「舌淡红、苔薄示气血不足」）。
 */
export function textHasSign(value: string, sign: string): boolean {
  return signOccurrences(String(value || ""), sign).length > 0;
}

/**
 * 一种表现在一段话里的出现位置。舌脉照病历字段的写法也认（第四十六轮复核 C041、C042、C069：病历「脉象：弦」「脉沉弦」，
 * 病性说明却写「尚未见到…脉弦等表现」）：「脉X」认「脉象：X」「脉沉X」「X脉」，「舌X」「苔X」认「舌象：舌X」「舌质：X」「舌苔：X」。
 * 中间至多隔两个同类描述字。「舌淡」不认「舌淡红」（淡红舌是正常舌象）。
 */
const PULSE_QUALIFIERS = "浮沉迟数滑涩弦紧缓虚实洪细弱濡微促结代芤革牢散伏动长短大";
function signOccurrences(source: string, sign: string): number[] {
  const out: number[] = [];
  for (let at = source.indexOf(sign); at >= 0; at = source.indexOf(sign, at + 1)) {
    if (sign.endsWith("淡") && source[at + sign.length] === "红") continue;
    out.push(at);
  }
  if (out.length > 0) return out;
  const tongue = sign.match(/^([舌苔])(.+)$/u);
  const pulse = sign.match(/^脉(.+)$/u);
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = pulse
    ? new RegExp(`脉(?:象)?[：:\\s]*[${PULSE_QUALIFIERS}]{0,2}${escape(pulse[1])}|${escape(pulse[1])}脉`, "gu")
    : tongue
      ? new RegExp(`${tongue[1] === "舌" ? "舌(?:质|体|象)?" : "(?:舌苔|苔)"}[：:\\s]*(?:舌)?[^，,。；;\\n：:]{0,2}${escape(tongue[2])}`, "gu")
      : undefined;
  if (!pattern) return out;
  for (const match of source.matchAll(pattern)) {
    const end = (match.index ?? 0) + match[0].length;
    if (sign.endsWith("淡") && source[end] === "红") continue;
    out.push(match.index ?? 0);
  }
  return out;
}

/** 病历里这几种表现的肯定提及：所在小句原文（去重，按出现先后）。 */
export function recordSignQuotes(recordText: string, signs: readonly string[]): string[] {
  const source = String(recordText || "");
  if (!source || signs.length === 0) return [];
  const hits: Array<{ at: number; quote: string }> = [];
  for (const sign of [...signs].sort((a, b) => b.length - a.length)) {
    for (const at of signOccurrences(source, sign)) {
      if (clauseLocalMentionPolarityAt(source, at) !== "affirmed") continue;
      const left = Math.max(...["，", ",", "。", "；", ";", "\n", "：", ":"].map((mark) => source.lastIndexOf(mark, at)));
      const rights = ["，", ",", "。", "；", ";", "\n"].map((mark) => source.indexOf(mark, at)).filter((index) => index >= 0);
      const quote = source.slice(left + 1, rights.length > 0 ? Math.min(...rights) : source.length).trim();
      if (quote && quote.length <= 30 && !hits.some((hit) => hit.quote === quote)) hits.push({ at, quote });
      break;
    }
  }
  return hits.sort((a, b) => a.at - b.at).map((hit) => hit.quote);
}
