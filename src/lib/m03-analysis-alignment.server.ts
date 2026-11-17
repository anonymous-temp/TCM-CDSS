import { classifyNatureColumns } from "./nature-column-classification";
import { reconcileAnalysisUncertainties } from "./pathogenesis-columns";
import "server-only";

import factPolicy from "../data/delivery-facts-policy.source.json";
import natureLexiconJson from "../data/tcm-nature-lexicon.json" with { type: "json" };
import { primaryModelJsonTask } from "./cross-model-small-task.server";
import { clauseLocalMentionPolarityAt } from "./diagnosis-safety";
import { compositeSyndromeRename } from "./delivered-surface";
import { withMethodImpliedNatureElements } from "./analysis-element-closure";
import { foreignSyndromeNames } from "./m03-rationale-coverage.server";
import { isLineageLensSentence } from "./tcm-lineages";
import { sanitizeOptionalPathogenesisClassifications } from "./diagnosis-visible-summary";
import { isStructurallyEmptyM03CoreText } from "./diagnosis-stage-contract";

/**
 * 辨证分析与结论对齐（2026-11-14 第四十五轮，「先定结论、再写文字」的服务端一半）。
 *
 * 为什么：甲方 100 例逐字复核 256 条「错」里 76 条是同一份输出前后矛盾，多数是证名与分析不一致——模型一次写出证名、依据、病性、
 * 总体病机，之后教材对齐改了证名、证素核对撤了证素、兼证核对撤了兼证，分析文字仍是改之前的：
 *  · 证名「痰火扰心证」，病性只有「内热」、依据写「支持肝火扰心」（C024）；
 *  · 证名「气滞血瘀证」，病性只有「气滞」、全篇没有瘀象（C030、C041）；
 *  · 证名「气血虚弱证」，病性列着血瘀、总体病机写「瘀阻胞宫」（C070）；
 *  · 证名是虚证（气厥虚证、心阳欲脱证），病性写「本虚：无」（C028、C022）。
 * 怎么做：结论（病名、主证、兼证、治法）不动；交付前用确定性判据查分析与结论对不对得上（analysisMisalignments），对不上时让模型按定了的结论
 * 重写分析那几段（辨证依据、病性三栏与依据、总体病机、待核实），服务端逐项核对后才换：病性依据逐段在病历里、依据末句落到交付的证名、
 * 不出现结论以外的证名、病性要素都在结论里、重写后再查一遍要对得上。任何一步不过、超时或失败，删除违规句/项；必填内容删空交回既有合同，不保留有矛盾的原文。
 * 只在对不上时发请求（第四十五轮方案：不是每例都多一次调用）。开关：CDSS_M03_ANALYSIS_ALIGNMENT=false。
 */
export function analysisAlignmentEnabled(): boolean {
  return process.env.CDSS_M03_ANALYSIS_ALIGNMENT !== "false";
}

type Json = Record<string, unknown>;
const record = (value: unknown): Json | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const strings = (value: unknown): string[] => Array.isArray(value) ? value.map(text).filter(Boolean) : [];

const LEXICON = (natureLexiconJson as { entries: Array<{ id: string; canonical: string; aliases: string[]; kind: string }> }).entries;
/** 同一病性要素的不同写法归一组（热与火热、湿与水湿、气滞与气郁）。 */
const ELEMENT_GROUP: Readonly<Record<string, string>> = { heat: "heat", fire_heat: "heat", summerheat: "heat", damp: "dampness", water_damp: "dampness", dampness: "dampness", water_dampness: "dampness" };
const groupOf = (id: string) => ELEMENT_GROUP[id] || id;

/** 证名或病性条目里的病性要素（受治理病性词表；虚性四类按字面另认）。只认两字以上的写法与单字病邪，宁少认，不多认。 */
export function natureElementsIn(value: string): Set<string> {
  const raw = String(value || "").normalize("NFKC");
  // Exact governed names take precedence over lexical fragments: 气虚发热 is not an excess heat syndrome.
  const exact = (factPolicy.syndromeElements as Record<string, string[]>)[raw.trim()];
  if (exact) return new Set(exact.map(groupOf));
  if (raw.includes("、")) return new Set(raw.split("、").flatMap((part) => [...natureElementsIn(part)]));
  // 虚寒、虚热、虚火、阴虚火旺是虚证本身的寒热，不另算寒、热这一病邪（脾胃虚寒证的病性写阳虚即可）。
  // 同一串里写了阴虚（阳虚）时，火旺、内热（寒、内寒）是虚证自身的热（寒），归阴虚（阳虚）：「阴虚、火旺」与「阴虚火旺证」同一结论。
  let source = raw.replace(/虚寒|内寒|虚热|虚火|阴虚火旺|火衰/gu, "虚");
  if (/阴虚|阴亏|阴液不足/u.test(raw)) source = source.replace(/火旺|内热|火炽/gu, "虚");
  if (/阳虚|阳气不足|阳衰/u.test(raw)) source = source.replace(/(?<![风湿])寒(?:凝|盛)?/gu, "虚");
  const found = new Set<string>();
  const idOf = (canonical: string, fallback: string) => groupOf(LEXICON.find((entry) => entry.canonical === canonical)?.id || fallback);
  if (/虚寒|内寒|火衰/u.test(raw)) found.add(idOf("阳虚", "yang_deficiency"));
  if (/虚热|虚火|阴虚火旺/u.test(raw)) found.add(idOf("阴虚", "yin_deficiency"));
  // 证名的简写：肝郁、气郁之于气滞，瘀之于血瘀，积滞之于食积。
  if (/郁(?!热)|气滞/u.test(source)) found.add(idOf("气滞", "qi_stagnation"));
  if (/瘀/u.test(source)) found.add(idOf("血瘀", "blood_stasis"));
  if (/积滞|食积|食滞|伤食/u.test(source)) found.add(idOf("食积", "food_retention"));
  for (const entry of LEXICON) {
    if (entry.kind === "eight_principles" || entry.kind === "disharmony") continue;
    const names = [entry.canonical, ...entry.aliases].filter((name) => name.length >= 2 || /^[风寒热火湿燥暑毒痰饮]$/u.test(name));
    if (names.some((name) => source.includes(name))) found.add(groupOf(entry.id));
  }
  // 虚性：「气血两虚」「脾气虚」「心阳欲脱」这类写法词表的全名对不上。
  if (/气血(?:两虚|亏虚|不足|虚弱|亏耗)|气虚|气不足|气弱|气亏|元气/u.test(source)) found.add(LEXICON.find((entry) => entry.canonical === "气虚")?.id || "qi_deficiency");
  if (/气血(?:两虚|亏虚|不足|虚弱|亏耗)|血虚|血不足|血亏|血少/u.test(source)) found.add(LEXICON.find((entry) => entry.canonical === "血虚")?.id || "blood_deficiency");
  if (/阴虚|阴亏|阴不足|阴液不足|阴津/u.test(source)) found.add(LEXICON.find((entry) => entry.canonical === "阴虚")?.id || "yin_deficiency");
  if (/阳虚|阳气不足|阳亏|阳(?:气)?(?:欲|暴)?脱|亡阳|阳衰|命门火衰/u.test(source)) found.add(LEXICON.find((entry) => entry.canonical === "阳虚")?.id || "yang_deficiency");
  return found;
}

const DEFICIENCY_NAME = /虚|亏|不足|衰|弱|脱|怯|不固/u;
const EXCESS_KINDS = new Set(["pathogen", "pathological_product", "pathodynamic_state", "blood_disorder"]);
const isExcessElement = (id: string) => {
  const entry = LEXICON.find((item) => groupOf(item.id) === id);
  return Boolean(entry && (EXCESS_KINDS.has(entry.kind) || (entry.kind === "qi_disorder" && /滞|逆/u.test(entry.canonical))));
};

/**
 * 交付时的证名（delivered-surface 的合称改名在交付面才做，这里按它将要写成的名字核）。交付面先按治法补齐病性栏的实邪
 *（withMethodImpliedNatureElements：健脾渗湿而病性只写气虚时补上湿），再判合称；这里同一顺序（第四十六轮）。
 */
function deliveredPrimary(reasoning: Json, recordText: string): string {
  const primary = text(record(reasoning.overview)?.primarySyndrome);
  try {
    const lookahead = structuredClone(reasoning);
    withMethodImpliedNatureElements(lookahead, recordText);
    return compositeSyndromeRename(lookahead, recordText)?.to || primary;
  } catch {
    return primary;
  }
}

/**
 * 结论里的病性要素：证名（主证、兼证）加上治法在治的（第四十六轮）。治法本身在治的病性不是「证名里没有」：
 * 经行泄泻·脾虚证教材治法「健脾渗湿」，病性栏写湿与结论一致；此前把它判成「病性栏的湿，证名里没有」，重写稿把湿从病性栏删掉，
 * 病机链与治法照旧在治湿（第四十六轮重跑 n20）。
 */
function conclusionElements(names: string, method: string): Set<string> {
  return new Set([...natureElementsIn(names), ...natureElementsIn(method)]);
}

export type AnalysisMisalignment = { code: "syndrome_element_missing" | "nature_element_unnamed" | "deficiency_without_root" | "rationale_other_syndrome" | "uncertainty_asks_named_element"; detail: string };

/** 分析与结论哪里对不上（纯函数，供测试）。 */
export function analysisMisalignments(reasoning: Json, recordText: string): AnalysisMisalignment[] {
  const overview = record(reasoning.overview);
  const pathogenesis = record(reasoning.pathogenesis);
  const nature = record(pathogenesis?.natureDifferentiation);
  const primary = deliveredPrimary(reasoning, recordText);
  if (!overview || !pathogenesis || !nature || !primary) return [];
  const secondary = strings(overview.secondarySyndromes);
  const named = [primary, ...secondary].join("、");
  const namedElements = natureElementsIn(named);
  const concludedElements = conclusionElements(named, text(record(reasoning.therapy)?.overallMethod) || text(overview.overallTherapy));
  const natureItems = [...new Set([...strings(nature.items), ...strings(nature.rootDeficiency), ...strings(nature.branchExcess)])];
  const natureElements = natureElementsIn(natureItems.join("、"));
  const issues: AnalysisMisalignment[] = [];
  // 证名里的病邪、病理产物、瘀与滞，病性栏得有（痰火扰心证而病性只有内热）。
  for (const id of namedElements) {
    if (isExcessElement(id) && !natureElements.has(id)) issues.push({ code: "syndrome_element_missing", detail: `证名「${primary}」里的${LEXICON.find((entry) => groupOf(entry.id) === id)?.canonical}，病性栏没有` });
  }
  // 病性栏的病邪、病理产物，证名（主证、兼证）与治法里都没有（气血虚弱证、益气养血而病性列血瘀）。
  for (const id of natureElements) {
    if (isExcessElement(id) && !concludedElements.has(id)) issues.push({ code: "nature_element_unnamed", detail: `病性栏的${LEXICON.find((entry) => groupOf(entry.id) === id)?.canonical}，证名里没有` });
  }
  // 证名是虚证，病性栏本虚为空（气厥虚证、心阳欲脱证而「本虚：无」）。
  if (DEFICIENCY_NAME.test(primary.replace(/证$/u, "")) && strings(nature.rootDeficiency).length === 0) issues.push({ code: "deficiency_without_root", detail: `证名「${primary}」是虚证，病性栏本虚为空` });
  // 辨证依据落到另一个证名上（「支持肝火扰心」而证名是痰火扰心证）。
  const rationale = text(overview.tcmDiagnosticRationale);
  const foreign = foreignSyndromeNames(rationale, { rationale: "", primary, secondary, disease: text(overview.tcmDiseaseName), recordText });
  // 「支持肝火扰心」「故属风痰阻络」不带「证」字的结论句（C024、C023）：补上证字再认；与主证、兼证不共两字的才算别的证。
  const conclusionSpans = [...rationale.matchAll(/(?:支持|故属|属于|证属|辨为|故为|当属|乃属)([\u4e00-\u9fff]{3,8}?)(?:证|之象)?(?=[，,。；;]|$)/gu)].map((match) => match[1]);
  const namedCores = [primary, ...secondary].map((name) => name.replace(/证$/u, ""));
  const implicit = conclusionSpans.filter((span) => /[心肝脾肺肾胃胆肠]/u.test(span) && /[虚实寒热火痰湿瘀滞郁风燥毒亢扰阻]/u.test(span) &&
    !namedCores.some((core) => core.includes(span) || span.includes(core)) &&
    !/本证|主证|此证|该证/u.test(span));
  const otherSyndromes = [...new Set([...foreign, ...implicit.map((span) => `${span}证`)])];
  if (otherSyndromes.length > 0) issues.push({ code: "rationale_other_syndrome", detail: `辨证依据写到证名以外的证「${otherSyndromes.join("、")}」` });
  // 待核实问的正是证名里已有的要素（「是否兼心阳虚」而证名是心阳欲脱证）。
  for (const row of Array.isArray(pathogenesis.uncertainties) ? pathogenesis.uncertainties : []) {
    const item = text(record(row)?.item);
    const asked = item.match(/是否兼(.{2,8}?)(?:证|$)/u)?.[1];
    if (!asked) continue;
    const askedElements = natureElementsIn(asked);
    if (askedElements.size > 0 && [...askedElements].every((id) => namedElements.has(id))) issues.push({ code: "uncertainty_asks_named_element", detail: `待核实「${item}」问的是证名里已有的要素` });
  }
  return issues;
}

const SYSTEM = [
  "你是中医主治医师。下面这份辨证的结论已经定了：病名、主证（primary）、兼证（secondary）、治法（method），不要改结论，也不要另立证。",
  "现在辨证分析的几段文字与结论对不上（problems 列出了哪里对不上）。请只按 record（病历原文）重写这几段，使它们支持并落到这个结论：",
  "1. rationale（辨证依据，≤220字）：把病历里的表现按「表现→病机」逐组解释，最后落到 primary（写出 primary 的证名原字）；不写结论以外的证名；病历没有的表现不写；舌淡红、苔薄白、脉平或脉缓这类正常所见不作为任何病理的依据；current.rationale 末尾若有一句流派视角的话（某某学派/思路看…），原样保留在末尾。",
  "2. natureItems：结论里的病性要素（如气虚、血虚、阴虚、阳虚、气滞、血瘀、痰、湿、热、寒、风、毒），只列 primary、secondary 里有的，以及 method 本身在治的（method 有渗湿、化痰、活血时的湿、痰、血瘀）；rootDeficiency 放其中的虚性要素，branchExcess 放其中的邪实要素；natureBasis 写病历原文里支持这些病性的片段，逐字摘抄，几段之间用「；」隔开。",
  "3. overallPathogenesis（≤100字）：按结论写本例的总体病机。",
  "4. uncertainties：仍待核实的事项（最多3条，每条 item 是待核实的那件事、reason 说为什么、affects 说影响哪一项判断）；不问结论里已经有的要素，不问病历已写明的事。",
  "只输出 JSON：{\"rationale\":\"\",\"natureItems\":[],\"rootDeficiency\":[],\"branchExcess\":[],\"natureBasis\":\"\",\"overallPathogenesis\":\"\",\"uncertainties\":[{\"item\":\"\",\"reason\":\"\",\"affects\":\"\"}]}",
].join("\n");

type Rewrite = { rationale: string; natureItems: string[]; rootDeficiency: string[]; branchExcess: string[]; natureBasis: string; overallPathogenesis: string; uncertainties: Array<{ item: string; reason: string; affects: string }> };

function parse(content: unknown): Rewrite | undefined {
  if (typeof content !== "string" || !content.trim()) return undefined;
  try {
    const value = record(JSON.parse(content));
    if (!value) return undefined;
    const rewrite: Rewrite = {
      rationale: text(value.rationale),
      natureItems: strings(value.natureItems),
      rootDeficiency: strings(value.rootDeficiency),
      branchExcess: strings(value.branchExcess),
      natureBasis: text(value.natureBasis),
      overallPathogenesis: text(value.overallPathogenesis),
      uncertainties: (Array.isArray(value.uncertainties) ? value.uncertainties : []).map(record).filter((row): row is Json => Boolean(row))
        .map((row) => ({ item: text(row.item), reason: text(row.reason), affects: text(row.affects) })).filter((row) => row.item && row.reason).slice(0, 3),
    };
    return rewrite.rationale ? rewrite : undefined;
  } catch {
    return undefined;
  }
}

const compact = (value: string) => value.normalize("NFKC").replace(/[\s，,。；;：:、]/gu, "");

/**
 * 重写稿能不能换上去（纯函数，供测试）。不过时返回 undefined，由调用方删违规句/项。
 *  · 辨证依据 40–320 字、写到交付的主证名、不出现结论以外的证名、原有的流派视角句仍在；
 *  · 病性条目都在结论里（natureElementsIn 认得出的要素都是证名里的），本虚、标实两栏是病性条目的分组；
 *  · 病性依据每段都逐字在病历里（去掉空白、标点比）；
 *  · 换上之后再查一遍，前面那几类对不上的都不再出现。
 */
export function acceptedAlignmentRewrite(reasoning: Json, rewrite: Rewrite, recordText: string, rejection?: { reason: string }): Json | undefined {
  const reject = (reason: string) => {
    if (rejection) rejection.reason = reason;
    return undefined;
  };
  const overview = record(reasoning.overview);
  const pathogenesis = record(reasoning.pathogenesis);
  const nature = record(pathogenesis?.natureDifferentiation);
  if (!overview || !pathogenesis || !nature) return reject("structure");
  const primary = deliveredPrimary(reasoning, recordText);
  const secondary = strings(overview.secondarySyndromes);
  const rationale = rewrite.rationale.replace(/\s+/gu, "");
  if (rationale.length < 40 || rationale.length > 320) return reject("rationale_length");
  const primaryCore = compact(primary).replace(/证$/u, "");
  if (!compact(rationale).includes(primaryCore)) return reject("rationale_without_primary");
  if (foreignSyndromeNames(rationale, { rationale: "", primary, secondary, disease: text(overview.tcmDiseaseName), recordText }).length > 0) return reject("rationale_foreign_syndrome");
  const oldLens = text(overview.tcmDiagnosticRationale).split(/(?<=[。])/u).find((sentence) => isLineageLensSentence(sentence));
  if (oldLens && !rationale.includes(oldLens.replace(/\s+/gu, "").slice(0, 8))) return reject("lens_lost");
  const namedElements = conclusionElements([primary, ...secondary].join("、"), text(record(reasoning.therapy)?.overallMethod) || text(overview.overallTherapy));
  // 原分析里已列、模型重写时仍保留的要素（病历有依据、证名没写的标实，如脾气虚证的湿）照留：不新增要素，也不替模型删它认为有据的要素
  //（第四十五轮本机实测：19 次重写里 12 次因保留了原有的湿、血瘀被拒）。这类要素不再算「对不上」。
  const originalElements = natureElementsIn([...strings(nature.items), ...strings(nature.rootDeficiency), ...strings(nature.branchExcess)].join("、"));
  const allowed = new Set([...namedElements, ...originalElements]);
  const items = [...new Set(rewrite.natureItems)];
  if (items.length === 0 || items.some((item) => [...natureElementsIn(item)].some((id) => !allowed.has(id)))) return reject("nature_outside_conclusion");
  if ([...rewrite.rootDeficiency, ...rewrite.branchExcess].some((item) => !items.includes(item))) return reject("columns_outside_items");
  const record_ = compact(recordText);
  const segments = rewrite.natureBasis.split(/[；;]/u).map((segment) => segment.trim()).filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => compact(segment).length < 2 || !record_.includes(compact(segment)))) return reject("basis_not_verbatim");
  const next = structuredClone(reasoning);
  const nextOverview = record(next.overview)!;
  const nextPathogenesis = record(next.pathogenesis)!;
  const nextNature = record(nextPathogenesis.natureDifferentiation)!;
  nextOverview.tcmDiagnosticRationale = rationale;
  nextNature.items = items;
  nextNature.rootDeficiency = [];
  nextNature.branchExcess = [];
  classifyNatureColumns(nextNature);
  nextNature.basis = segments.join("；");
  if (rewrite.overallPathogenesis && rewrite.overallPathogenesis.length <= 140) {
    nextOverview.overallPathogenesis = rewrite.overallPathogenesis;
    if (typeof nextPathogenesis.summary === "string") nextPathogenesis.summary = rewrite.overallPathogenesis;
  }
  // 重写稿的待核实项不收三类（第四十六轮）：评论证名本身的（「湿邪是否作为独立病性要素——结论证名未列湿」，m13）、照抄提示段内部说法的、
  // 问病历已写明的四诊属性的（舌苔厚薄而病历记苔薄）。剩下的才换上去。
  nextPathogenesis.uncertainties = rewrite.uncertainties;
  reconcileAnalysisUncertainties(next, recordText);
  const remaining = analysisMisalignments(next, recordText)
    .filter((issue) => issue.code !== "nature_element_unnamed" || ![...originalElements].some((id) => !namedElements.has(id) && issue.detail.includes(LEXICON.find((entry) => groupOf(entry.id) === id)?.canonical || "\u0000")));
  return remaining.length === 0 ? next : reject(`still:${remaining.map((issue) => issue.code).join("+")}`);
}

/**
 * R49 rejection fallback. Issue-directed offending prose is removed; element arrays belong to P6a.
 * Omissions cannot be repaired by inventing evidence or erasing all valid analysis; leave contract failure visible.
 */
export function withoutMisalignedAnalysis(reasoning: Json, recordText: string): Json {
  const issues = analysisMisalignments(reasoning, recordText);
  if (!issues.length) return structuredClone(reasoning);
  const next = structuredClone(reasoning);
  const overview = record(next.overview)!;
  const pathogenesis = record(next.pathogenesis)!;
  const primary = deliveredPrimary(reasoning, recordText);
  const secondary = strings(overview.secondarySyndromes);
  const forbidden = new Set(issues.filter((issue) => issue.code === "nature_element_unnamed").flatMap((issue) =>
    LEXICON.filter((entry) => issue.detail.includes(`病性栏的${entry.canonical}，`)).map((entry) => groupOf(entry.id))));
  // A missing element/root is an unresolved omission, not proof that every authored sentence is false.
  // Remove only contradicted material below; leave the omission visible to final contracts/findings.
  const contradicts = (value: string): boolean => {
    for (const entry of LEXICON) {
      if (!forbidden.has(groupOf(entry.id))) continue;
      for (const mention of [entry.canonical, ...entry.aliases]) {
        for (let at = value.indexOf(mention); at >= 0; at = value.indexOf(mention, at + mention.length)) {
          // A named-syndrome mention is handled by the assertion guard below, not as an unscoped element token.
          if (/^(?:主|兼)?证/u.test(value.slice(at + mention.length))) continue;
          if (clauseLocalMentionPolarityAt(value, at) === "affirmed") return true;
        }
      }
    }
    const foreign = foreignSyndromeNames(value, { rationale: "", primary, secondary, disease: text(overview.tcmDiseaseName), recordText });
    for (const name of foreign) {
      const core = name.replace(/证$/u, "");
      for (let at = value.indexOf(core); at >= 0; at = value.indexOf(core, at + core.length)) {
        const head = value.slice(0, at).trimEnd();
        const asserted = factPolicy.alignmentAssertionMarkers.some((marker) => head.endsWith(marker)) || value.replace(/[。；;\s]/gu, "") === name;
        if (!asserted || clauseLocalMentionPolarityAt(value, at) !== "affirmed") continue;
        return true;
      }
    }
    return false;
  };
  const contradictsIssue = (sentence: string): boolean => {
    if (contradicts(sentence)) return true;
    if (!issues.some((issue) => issue.code === "rationale_other_syndrome")) return false;
    const probe = structuredClone(reasoning);
    record(probe.overview)!.tcmDiagnosticRationale = sentence;
    return analysisMisalignments(probe, recordText).some((issue) => issue.code === "rationale_other_syndrome") &&
      factPolicy.alignmentAssertionMarkers.filter((marker) => marker.length >= 2).some((marker) => {
        const at = sentence.indexOf(marker);
        return at >= 0 && !/(?:不|未|非)$/u.test(sentence.slice(0, at)) && clauseLocalMentionPolarityAt(sentence, at + marker.length) === "affirmed";
      });
  };
  const cut = (value: unknown): string => asSentences(text(value)).filter((sentence) => !contradictsIssue(sentence)).join("");
  // 删句不能把核心文字删空（第四十九轮 new40 m11：对齐两次被拒，兜底删掉总体病机全部句子 → overall_pathogenesis_unstable T1 →
  // M03 退成占位、M04 无方）。删后结构上为空或不足一句时保留原文，矛盾留给后面的核对与复核看见，不让整页作废。
  const cutCore = (value: unknown): string => {
    const original = text(value);
    const kept = cut(value);
    return kept.length >= 8 && !isStructurallyEmptyM03CoreText(kept) ? kept : original;
  };
  for (const key of ["tcmDiagnosticRationale", "overallPathogenesis"]) {
    if (typeof overview[key] === "string") overview[key] = cutCore(overview[key]);
  }
  for (const key of ["summary", "natureSummary"]) if (typeof pathogenesis[key] === "string") pathogenesis[key] = cut(pathogenesis[key]);
  // R49: element promotion/withdrawal belongs to P6a. This fallback edits prose only.
  if (Array.isArray(pathogenesis.chain)) {
    const originalChain = structuredClone(pathogenesis.chain);
    pathogenesis.chain = pathogenesis.chain.filter((raw) => {
      const node = record(raw);
      if (!node) return true;
      for (const key of ["pathogenesis", "syndromeEvidence", "therapyDirection"]) if (typeof node[key] === "string") node[key] = cut(node[key]);
      // Remove the whole unexplainable item; retained node IDs remain stable for reference repair.
      return Boolean(text(node.pathogenesis));
    });
    // 同上：病机链删到一个节点不剩时保留原链（空链是 T1 m03_chain_empty）。
    if (pathogenesis.chain.length === 0 && originalChain.length > 0) pathogenesis.chain = originalChain;
  }
  reconcileAnalysisUncertainties(next, recordText);
  return next;
}
function asSentences(value: string): string[] {
  return value.match(/[^。！？!?；;]+[。！？!?；;]?/gu) || [];
}

const TIMEOUT_MS = 9_000;

/** 对齐一份已合并的辨证结果（含哨兵的完整内容）。对得上、开关关着时原样返回；失败或不过核对时删除违规句/项。 */
export async function alignAnalysisWithConclusion(content: string, context: { recordText: string }, signal?: AbortSignal, rewriteTask = primaryModelJsonTask): Promise<string> {
  if (!analysisAlignmentEnabled()) return content;
  const START = "<!-- DIAGNOSIS_JSON_START -->";
  const END = "<!-- DIAGNOSIS_JSON_END -->";
  const start = content.indexOf(START);
  const end = start >= 0 ? content.indexOf(END, start + START.length) : -1;
  if (start < 0 || end < 0) return content;
  let reasoning: Json | undefined;
  try { reasoning = record(JSON.parse(content.slice(start + START.length, end).trim())); } catch { return content; }
  if (!reasoning || reasoning.stage !== "diagnose") return content;
  const issues = analysisMisalignments(reasoning, context.recordText);
  if (issues.length === 0) return content;
  const overview = record(reasoning.overview)!;
  const pathogenesis = record(reasoning.pathogenesis)!;
  const nature = record(pathogenesis.natureDifferentiation)!;
  const messages: Parameters<typeof primaryModelJsonTask>[2] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: JSON.stringify({
      record: context.recordText.slice(0, 3_000),
      disease: text(overview.tcmDiseaseName),
      primary: deliveredPrimary(reasoning, context.recordText),
      secondary: strings(overview.secondarySyndromes),
      method: text(record(reasoning.therapy)?.overallMethod),
      current: {
        rationale: text(overview.tcmDiagnosticRationale),
        nature: { items: strings(nature.items), rootDeficiency: strings(nature.rootDeficiency), branchExcess: strings(nature.branchExcess), basis: text(nature.basis) },
        overallPathogenesis: text(overview.overallPathogenesis),
        uncertainties: pathogenesis.uncertainties,
      },
      problems: issues.map((issue) => issue.detail),
    }) },
  ];
  let accepted: Json | undefined;
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (signal?.aborted) break;
    const rewrite = await rewriteTask("m03_analysis_alignment", "diagnose", messages,
      { maxTokens: 900, timeoutMs: TIMEOUT_MS }, parse, signal).catch(() => undefined);
    const rejection = { reason: rewrite ? "" : "task_failed_or_invalid_json" };
    accepted = rewrite ? acceptedAlignmentRewrite(reasoning, rewrite, context.recordText, rejection) : undefined;
    console.info("[tcm-cdss:telemetry] m03_analysis_alignment", { issues: issues.map((issue) => issue.code), attempt, rewritten: Boolean(rewrite), accepted: Boolean(accepted), rejected: rejection.reason || null });
    if (accepted) break;
    messages.push({ role: "user", content: JSON.stringify({ rejected: rejection.reason, previousRewrite: rewrite, instruction: "上次稿件未通过同一核对。请修正拒绝原因，仍只重写同一组字段，遵守原结论和逐字病历依据要求。" }) });
  }
  if (!accepted) {
    const cut = withoutMisalignedAnalysis(reasoning, context.recordText);
    // Do not run a normalizer that may restore rejected prose. The existing caller revalidates the contract.
    return `${content.slice(0, start + START.length)}\n${JSON.stringify(cut, null, 2)}\n${content.slice(end)}`;
  }
  return contentWithAcceptedRewrite(content, accepted, context.recordText);
}

/**
 * 把采信的重写稿换进内容（纯函数，供测试）。病性栏换了条目与依据，把握度与说明按换上的条目重判（第四十六轮：此前沿用重写前的说明，
 * 病性只剩气滞，说明还写「病性“气滞、津亏”中…」，甲方 100 例 C064、new45 n12「病性定为阳虚，说明却称寒热只见灼热」）。
 * 与准备阶段同一个判据（sanitizeOptionalPathogenesisClassifications）：依据逐项都摘了就是已确定，否则有界并点名缺哪一条。
 */
export function contentWithAcceptedRewrite(content: string, accepted: Json, recordText: string): string {
  const START = "<!-- DIAGNOSIS_JSON_START -->";
  const END = "<!-- DIAGNOSIS_JSON_END -->";
  const start = content.indexOf(START);
  const end = start >= 0 ? content.indexOf(END, start + START.length) : -1;
  if (start < 0 || end < 0) return content;
  const next = structuredClone(accepted);
  const nature = record(record(next.pathogenesis)?.natureDifferentiation);
  if (nature) {
    nature.resolution = "bounded";
    delete nature.resolutionReason;
  }
  const replaced = `${content.slice(0, start + START.length)}\n${JSON.stringify(next, null, 2)}\n${content.slice(end)}`;
  return sanitizeOptionalPathogenesisClassifications(replaced, recordText);
}
