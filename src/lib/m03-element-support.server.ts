import "server-only";

import lexiconJson from "../data/tcm-deficiency-element-lexicon.source.json" with { type: "json" };
import { diagnosticsCriteriaFor, primaryManifestationTerms, verifySecondaryByCriteria, withoutClauses, type CriteriaVerdict } from "./m03-secondary-syndrome-consistency.server";
import { textbookRowForSyndrome } from "./tcm-textbook-syndromes";

/**
 * 证素核对（2026-10-22 第十五轮）。
 *
 * 外部复核（hospital-a，心悸·心虚胆怯证）：病历只有情绪紧张时心悸、坐卧不安、入睡困难、多梦易醒、舌淡红苔薄白、脉弦细，
 * 输出却在病机链第二节点写「心血不足，神失所养 → 养血安神」并加酸枣仁；本机重跑写成「肝血不足 → 养血柔肝」并加白芍。
 * 第十二轮起「兼证」要过《中医诊断学》辨证要点（m03-secondary-syndrome-consistency 的判据），同一个判断写进病机链节点就不受约束，
 * 再流向分治法、M04 药味与方义——同一判据两处各写各的。已存 513 份输出粗扫：约 8% 在主证名之外写了虚性证素、病历支撑不超过 1 条。
 * 教材本身的写法：心虚胆怯证「兼心血不足，加阿胶、制何首乌、龙眼肉」是**条件加减**，不是既定病机。
 *
 * 做法：病机链各节点与病性轴里、主证/兼证名没有涵盖的虚性证素（气虚、血虚、阴虚、阳虚；本表 tcm-deficiency-element-lexicon.source.json
 * 认说法与脏腑），按类别归到《中医诊断学》条目（单一脏腑有条目用脏腑条目，否则用该类总条目），走与兼证同一个判据
 *（verifySecondaryByCriteria：小任务只把病历原文对到条目，服务端计数，主证教材证型自己的表现不算）。
 *  · 不够数：从病机链（删那一分句与只为它写的治法项；删完不剩独立病机或治法的节点整条撤下，链上至少留一条）、分治法、总治法、病性轴、辨证依据与总体病机里撤下，
 *    在不确定项里写一条「是否兼X」；开方阶段只看得到留下的病机，不会再为它加药。不按药物功效删药（第十轮试过，删错的多）。
 *  · 够数：节点证据标为《中医诊断学》该条辨证要点（标准资料）。
 *  · 小任务失败、查不到条目：原样不动。
 * 只在有名外虚性证素时发请求（约两成输出），与兼证核对、本例说法核对并行。开关：CDSS_M03_ELEMENT_SUPPORT=false 关闭。
 * 文献：模型自己几乎不会标「证据不足」（ConfiDx，npj Digit Med 2025：未经训练的模型识别率最高 0.057），判据须在模型外。
 */

type Json = Record<string, unknown>;
export type DeficiencyType = "气虚" | "血虚" | "阴虚" | "阳虚";

const MAX_UNITS = 2;

type TypeConfig = { genericEntry: string; organEntrySuffix: string; keyPoints: string; therapyVerbs: string[]; therapyWord: string };
const LEXICON = lexiconJson as unknown as {
  organs: Record<string, string>;
  mentions: Array<{ pattern: string; types: DeficiencyType[] }>;
  types: Record<DeficiencyType, TypeConfig>;
  entailment: {
    organDeficiencyDefaultType: DeficiencyType;
    organDeficiencyAllTypes: string[];
    anyTypeMarkers: string[];
    coldDeficiencyMarkers: string[];
    heatDeficiencyMarkers: string[];
    insecurityMarkers: string[];
    deficiencyNameMarkers: string[];
    organCoverageGroups: string[][];
    typeImplies: Partial<Record<DeficiencyType, DeficiencyType[]>>;
    impliedByName: Array<{ marker: string; types: DeficiencyType[]; organs: string[] }>;
  };
  dependentClauseOpeners: string[];
};
const ALL_TYPES = Object.keys(LEXICON.types) as DeficiencyType[];
const MENTION_PATTERNS = [...LEXICON.mentions].sort((a, b) => b.pattern.length - a.pattern.length);
const DEPENDENT_OPENERS = [...LEXICON.dependentClauseOpeners].sort((a, b) => b.length - a.length);

export function elementSupportEnabled(): boolean {
  return process.env.CDSS_M03_ELEMENT_SUPPORT !== "false";
}

function record(value: unknown): Json | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
}
function records(value: unknown): Json[] {
  return Array.isArray(value) ? value.flatMap((item) => { const entry = record(item); return entry ? [entry] : []; }) : [];
}
function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
const compact = (value: string) => value.replace(/[\s，,。；;、：:（）()]/gu, "");

export type ElementMention = { types: DeficiencyType[]; organs: string[]; start: number; end: number; text: string };

/** 一段话里的虚性证素说法（最长匹配），带它前面紧挨着的脏腑字（「心胆气虚」→ 心、胆；「中气不足」→ 脾）。 */
export function deficiencyMentions(value: string): ElementMention[] {
  const out: ElementMention[] = [];
  let index = 0;
  while (index < value.length) {
    const hit = MENTION_PATTERNS.find((entry) => value.startsWith(entry.pattern, index));
    if (!hit) { index += 1; continue; }
    const organs: string[] = [];
    for (let back = index - 1; back >= 0 && index - back <= 3; back -= 1) {
      const organ = LEXICON.organs[value[back]];
      if (!organ) break;
      organs.unshift(organ);
    }
    out.push({ types: hit.types, organs: [...new Set(organs)], start: index, end: index + hit.pattern.length, text: value.slice(index, index + hit.pattern.length) });
    index += hit.pattern.length;
  }
  return out;
}

/** 证名涵盖的虚性证素：类别 → 脏腑集合（"any" 表示不限脏腑）。 */
export type Entailment = Map<DeficiencyType, Set<string> | "any">;

function entail(map: Entailment, type: DeficiencyType, organs: readonly string[]): void {
  for (const implied of [type, ...(LEXICON.entailment.typeImplies[type] || [])]) {
    if (organs.length === 0) { map.set(implied, "any"); continue; }
    const current = map.get(implied);
    if (current === "any") continue;
    const next = current || new Set<string>();
    for (const organ of organs) {
      next.add(organ);
      for (const group of LEXICON.entailment.organCoverageGroups) if (group.includes(organ)) group.forEach((member) => next.add(member));
    }
    map.set(implied, next);
  }
}

/**
 * 主证、兼证名涵盖哪些虚性证素。宽口径：只为找出明显的「名外」证素，涵盖不清时一律算涵盖。
 *  · 名中直接写了（心血虚、气阴两虚、脾肾阳虚）；
 *  · 名里有「虚、怯、弱、亏、不足、衰」字样的：名中各脏气虚（肾涵盖各类）——心虚胆怯证涵盖心、胆气虚（国标心胆气虚证即此证）；
 *  · 「两虚」「不足证」「亏虚证」：名中各脏的各类；虚寒/火衰 → 阳虚，虚火/虚热 → 阴虚，不固同「虚」；
 *  · 证名本身含的病机（肝阳上亢、风阳、相火、心肾不交 → 阴虚，下元、劳淋、失健运…，见词表 impliedByName）；
 *  · 脾、胃同组；阳虚涵盖同脏气虚。
 */
export function entailedDeficiencies(names: readonly string[]): Entailment {
  const map: Entailment = new Map();
  const config = LEXICON.entailment;
  for (const raw of names) {
    const name = compact(raw);
    if (!name) continue;
    const organsInName = [...new Set([...name].flatMap((char) => LEXICON.organs[char] ? [LEXICON.organs[char]] : []))];
    for (const mention of deficiencyMentions(name)) for (const type of mention.types) entail(map, type, mention.organs);
    for (const rule of config.impliedByName) if (name.includes(rule.marker)) for (const type of rule.types) entail(map, type, rule.organs);
    if ([...config.deficiencyNameMarkers, ...config.insecurityMarkers].some((marker) => name.includes(marker))) {
      for (const organ of organsInName) {
        if (config.organDeficiencyAllTypes.includes(organ)) for (const type of ALL_TYPES) entail(map, type, [organ]);
        else entail(map, config.organDeficiencyDefaultType, [organ]);
      }
    }
    if (config.anyTypeMarkers.some((marker) => name.includes(marker))) for (const type of ALL_TYPES) entail(map, type, organsInName);
    if (config.coldDeficiencyMarkers.some((marker) => name.includes(marker))) entail(map, "阳虚", organsInName);
    if (config.heatDeficiencyMarkers.some((marker) => name.includes(marker))) entail(map, "阴虚", organsInName);
    if (config.insecurityMarkers.some((marker) => name.includes(marker))) entail(map, "气虚", organsInName);
  }
  return map;
}

/** 这一处说法里，证名没有涵盖的类别。不写脏腑的说法，名中同类不论哪个脏腑都算涵盖。 */
export function unentailedTypes(mention: Pick<ElementMention, "types" | "organs">, entailment: Entailment): DeficiencyType[] {
  return mention.types.filter((type) => {
    const covered = entailment.get(type);
    if (!covered) return true;
    if (covered === "any") return false;
    if (mention.organs.length === 0) return false;
    return !mention.organs.every((organ) => covered.has(organ));
  });
}

function namedSyndromes(root: Json): string[] {
  const overview = record(root.overview);
  return [text(overview?.primarySyndrome), ...(Array.isArray(overview?.secondarySyndromes) ? overview!.secondarySyndromes.map(text) : [])].filter(Boolean);
}

/** 要核对的一个类别：证名没涵盖、而病机链或病性轴写了。 */
export type ElementUnit = { type: DeficiencyType; organs: string[]; entryName: string; mentions: number };

function entryFor(type: DeficiencyType, organs: readonly string[]): string {
  const config = LEXICON.types[type];
  const tryNames = organs.length === 1
    ? [`${organs[0]}${config.organEntrySuffix}`]
    : organs.length === 2
      ? [`${organs[0]}${organs[1]}${config.organEntrySuffix}`, `${organs[1]}${organs[0]}${config.organEntrySuffix}`]
      : [];
  for (const name of tryNames) {
    const entry = diagnosticsCriteriaFor(name);
    if (entry) return entry.name;
  }
  return config.genericEntry;
}

function natureTerms(root: Json): string[] {
  const nature = record(record(root.pathogenesis)?.natureDifferentiation);
  return ["items", "rootDeficiency", "branchExcess"].flatMap((key) => Array.isArray(nature?.[key]) ? (nature![key] as unknown[]).map(text) : []).filter(Boolean);
}

/** 中医半里需要核对的类别（纯函数，供测试）。至多 MAX_UNITS 个，按出现次数多少排。 */
export function elementCheckUnits(root: Json): ElementUnit[] {
  const entailment = entailedDeficiencies(namedSyndromes(root));
  const byType = new Map<DeficiencyType, { organs: Set<string>; mentions: number }>();
  const sources = [
    ...records(record(root.pathogenesis)?.chain).map((node) => text(node.pathogenesis)),
    ...natureTerms(root),
  ];
  for (const source of sources) {
    for (const mention of deficiencyMentions(source)) {
      for (const type of unentailedTypes(mention, entailment)) {
        const unit = byType.get(type) || { organs: new Set<string>(), mentions: 0 };
        // 只记证名没涵盖的那几个脏腑：肾气虚证下写「脾肾气虚」，要核的是脾气虚，不是气虚（2026-10-22 实测 S-renal-006）。
        const covered = entailment.get(type);
        mention.organs.filter((organ) => !(covered instanceof Set && covered.has(organ))).forEach((organ) => unit.organs.add(organ));
        unit.mentions += 1;
        byType.set(type, unit);
      }
    }
  }
  return [...byType].map(([type, unit]) => ({ type, organs: [...unit.organs], entryName: entryFor(type, [...unit.organs]), mentions: unit.mentions }))
    .sort((a, b) => b.mentions - a.mentions)
    .slice(0, MAX_UNITS);
}

/** confidence：够数时节点证据的置信；脏腑条目不够数、该类总条目够数时为「低」（证素成立，脏腑归属是推断）。 */
export type ElementDecision = { verdicts: Array<{ unit: ElementUnit; verdict: CriteriaVerdict; confidence?: "中" | "低" }> };

/**
 * 一个类别的判定：先按脏腑条目核；证名里完全没有这一类证素、脏腑条目又不够数时，再按该类总条目核（两次并行）。
 * 湿热壅盛证下写「肾阳不足」、病历畏寒肢冷成组而没有腰膝冷痛之类：阳虚成立、肾的归属没有依据，保留并标「低」，不整类撤下（2026-10-22 实测）。
 * 证名已涵盖这一类的别的脏腑时（肾气虚证下的脾气虚），问的就是脏腑归属，不用总条目兜。
 */
export function combinedElementVerdict(
  organ: CriteriaVerdict,
  generic: CriteriaVerdict | undefined,
): { verdict: CriteriaVerdict; confidence?: "中" | "低" } {
  if (organ.verdict === "pass") return { verdict: organ, confidence: "中" };
  if (generic?.verdict === "pass") return { verdict: generic, confidence: "低" };
  return { verdict: organ };
}

/** 中医半返回后发小任务核对（与兼证核对、本例说法核对并行）。没有名外虚性证素、开关关闭或解析失败时为 undefined。 */
export async function decideElementSupport(
  tcmContent: string,
  context: { recordText: string },
  signal?: AbortSignal,
): Promise<ElementDecision | undefined> {
  if (!elementSupportEnabled()) return undefined;
  let root: Json | undefined;
  try { root = record(JSON.parse(tcmContent)); } catch { return undefined; }
  const overview = record(root?.overview);
  if (!root || !overview || !text(overview.primarySyndrome) || text(overview.primarySyndromeResolution) === "unresolved") return undefined;
  const units = elementCheckUnits(root);
  if (units.length === 0) return undefined;
  const primaryTerms = primaryManifestationTerms(textbookRowForSyndrome(text(overview.tcmDiseaseName), text(overview.primarySyndrome)));
  const entailment = entailedDeficiencies(namedSyndromes(root));
  const verify = (entryName: string) => verifySecondaryByCriteria(entryName, { recordText: context.recordText, primaryTerms }, signal);
  const results = await Promise.all(units.map(async (unit) => {
    const genericEntry = LEXICON.types[unit.type].genericEntry;
    const withGeneric = unit.entryName !== genericEntry && !entailment.has(unit.type);
    const [organ, generic] = await Promise.all([verify(unit.entryName), withGeneric ? verify(genericEntry) : Promise.resolve(undefined)]);
    return { unit, ...combinedElementVerdict(organ, generic), organ, generic };
  }));
  const describe = (item: CriteriaVerdict) => `${item.entry || "?"}:${item.verdict}:${item.specific}/${item.category}/${item.distinct}`;
  console.info("[tcm-cdss:telemetry] m03_element_support", {
    units: results.map((item) => `${item.unit.type}/${item.unit.organs.join("") || "-"}→${describe(item.organ)}${item.generic ? `|${describe(item.generic)}` : ""}`),
  });
  return { verdicts: results.map(({ unit, verdict, confidence }) => ({ unit, verdict, ...(confidence ? { confidence } : {}) })) };
}

const SWEAT_DISCRIMINATOR = /无汗|自汗/u;

function clausesOf(value: string): string[] {
  return value.split(/[，,；;]/u).map((item) => item.trim()).filter(Boolean);
}

function hasFailedMention(value: string, failed: ReadonlySet<DeficiencyType>, entailment: Entailment): boolean {
  return deficiencyMentions(value).some((mention) => unentailedTypes(mention, entailment).some((type) => failed.has(type)));
}

/**
 * 只为这一类证素写的治法项。动词与类别字之间可以夹一个脏腑字：「养肝血」「滋肾阴」「温脾阳」「补肺气」
 *（2026-10-22 实测：心虚胆怯证的「养肝血，安神助寐」只认「养血」时漏掉）。
 */
const ORGAN_CHAR_CLASS = Object.keys(LEXICON.organs).join("");
const THERAPY_PATTERNS = new Map<DeficiencyType, RegExp>(ALL_TYPES.map((type) => {
  const core = type[0];
  const alternatives = LEXICON.types[type].therapyVerbs.map((verb) =>
    verb.length === 2 && verb[1] === core ? `${verb[0]}[${ORGAN_CHAR_CLASS}]?${core}` : verb);
  return [type, new RegExp(alternatives.join("|"), "u")];
}));

function therapyItemTargets(item: string, failed: ReadonlySet<DeficiencyType>): boolean {
  return [...failed].some((type) => THERAPY_PATTERNS.get(type)!.test(item));
}

/** 证据标签：判据够数的节点标为《中医诊断学》该条辨证要点。 */
export function diagnosticsCriteriaEvidence(entryName: string, confidence: "中" | "低" = "中"): { evidenceLevel: "kb_entry"; source: string; confidence: "中" | "低" } {
  return { evidenceLevel: "kb_entry", source: `《中医诊断学》${entryName}辨证要点`, confidence };
}

/**
 * 不确定项按所核的条目写（「是否兼脾气虚」），不按类别写：主证肾气虚证、多写的是脾气不足时，「是否兼气虚」与主证自相矛盾
 *（2026-10-22 实测 S-renal-006）。脏腑条目的辨证要点取《中医诊断学》原文；类别总条目取本表 keyPoints（阳虚证原文本地语料缺字）。
 */
function uncertaintyFor(type: DeficiencyType, entryName: string): Json {
  const config = LEXICON.types[type];
  const generic = entryName === config.genericEntry;
  const label = generic ? type : entryName.replace(/证$/u, "");
  const keyPoints = generic
    ? config.keyPoints
    : (diagnosticsCriteriaFor(entryName)?.keyPointsText || config.keyPoints).replace(/(?:等)?为主要表现/u, "").replace(/[。；;，,\s]+$/u, "");
  return {
    item: `是否兼${label}`,
    reason: `${label}的辨证要点（${keyPoints}）在本例尚未成组出现`,
    affects: `望诊、问诊核实后再定是否兼顾${config.therapyWord}`,
  };
}

/**
 * 把核对结果落到中医半上（纯函数，供测试）。在兼证核对之后调用：那一步补上的兼证若已涵盖某类，这一类不再撤。
 * 返回新的 JSON 文本；没有改动时原样返回。
 */
export function applyElementSupportDecision(tcmContent: string, decision: ElementDecision | undefined, primaryTextbookMethod?: string): string {
  if (!decision || decision.verdicts.length === 0) return tcmContent;
  let root: Json | undefined;
  try { root = record(JSON.parse(tcmContent)); } catch { return tcmContent; }
  const overview = record(root?.overview);
  const pathogenesis = record(root?.pathogenesis);
  if (!root || !overview || !pathogenesis) return tcmContent;
  const entailment = entailedDeficiencies(namedSyndromes(root));
  const failed = new Set(decision.verdicts.filter((item) => item.verdict.verdict === "fail").map((item) => item.unit.type));
  const passed = decision.verdicts.filter((item) => item.verdict.verdict === "pass");
  const textbookMethod = primaryTextbookMethod ??
    (textbookRowForSyndrome(text(overview.tcmDiseaseName), text(overview.primarySyndrome))?.therapy || "");
  const textbookItems = new Set(clausesOf(textbookMethod).map(compact));
  let changed = false;

  const chain = records(pathogenesis.chain);
  // 够数的类别：写了它的节点证据标为该条辨证要点。
  for (const { unit, verdict, confidence } of passed) {
    for (const node of chain) {
      if (deficiencyMentions(text(node.pathogenesis)).some((mention) => unentailedTypes(mention, entailment).includes(unit.type))) {
        node.evidence = diagnosticsCriteriaEvidence(verdict.entry || unit.entryName, confidence || "中");
        changed = true;
      }
    }
  }
  // 撤下前先看哪些类别在病机链或病性轴里确实还写着（兼证核对补上的兼证若已涵盖，就不算）。
  const writtenTypes = new Set<DeficiencyType>();
  for (const source of [...chain.map((node) => text(node.pathogenesis)), ...natureTerms(root)]) {
    for (const mention of deficiencyMentions(source)) for (const type of unentailedTypes(mention, entailment)) if (failed.has(type)) writtenTypes.add(type);
  }
  for (const type of [...failed]) if (!writtenTypes.has(type)) failed.delete(type);
  if (failed.size === 0) return changed ? JSON.stringify(root) : tcmContent;

  // 病机链：删写了这一证素的分句与只为它写的治法项；删完不剩独立病机或治法的节点整条撤下（链上至少留一条）。
  const keptNodes: Json[] = [];
  chain.forEach((node, index) => {
    const nodeText = text(node.pathogenesis);
    if (!hasFailedMention(nodeText, failed, entailment)) { keptNodes.push(node); return; }
    const clauses = clausesOf(nodeText);
    const remaining = clauses.filter((clause) => !hasFailedMention(clause, failed, entailment));
    const substantive = remaining.filter((clause) => !DEPENDENT_OPENERS.some((opener) => clause.startsWith(opener)) && compact(clause).length >= 4);
    const therapyItems = clausesOf(text(node.therapyDirection));
    const keptTherapy = therapyItems.filter((item) => !therapyItemTargets(item, failed) || textbookItems.has(compact(item)));
    const holdsDiscriminator = [node.patientFact, node.syndromeEvidence].some((value) => SWEAT_DISCRIMINATOR.test(text(value)));
    // 首节点也可以撤，只要链上还有别的节点：主证名里没有、病历又不够数的虚性证素写成了首节点（湿热壅盛证的首节点「脾肾阳虚气化失司…」，
    // 2026-10-22 实测 S-renal-009），它本来就不是主证那一条，撤下后下一条成为首节点（分治法「主要」随之）。只有一个节点时不撤。
    const canDrop = (index > 0 || chain.length >= 2) && !holdsDiscriminator;
    // 删掉这一分句后还剩独立成句的病机（「魂不守舍，虚烦不寐」）就留着节点，只是不再说它；只剩「兼失濡润」这类依附分句、或治法删空了，整条撤下。
    if (canDrop && (substantive.length === 0 || keptTherapy.length === 0)) { changed = true; return; }
    if (substantive.length === 0 || keptTherapy.length === 0) { keptNodes.push(node); return; }
    node.pathogenesis = remaining.join("，");
    node.therapyDirection = keptTherapy.join("，");
    keptNodes.push(node);
    changed = true;
  });
  // 撤完后两个节点病机或治法相同（分治法会判重复）：后一个撤下。
  const seen = new Set<string>();
  const deduplicated = keptNodes.filter((node, index) => {
    const keys = [compact(text(node.pathogenesis)), compact(text(node.therapyDirection))];
    if (index > 0 && keys.some((key) => key && seen.has(key))) { changed = true; return false; }
    keys.forEach((key) => key && seen.add(key));
    return true;
  });
  if (deduplicated.length > 0) pathogenesis.chain = deduplicated;

  // 总治法：只为这一证素写的项去掉（教材主证治法里的项不动），至少留一项；多节点时不得与某个分治法逐字相同。
  const therapy = record(root.therapy);
  const method = text(therapy?.overallMethod);
  if (therapy && method) {
    const items = clausesOf(method);
    const kept = items.filter((item) => !therapyItemTargets(item, failed) || textbookItems.has(compact(item)));
    const next = kept.join("，");
    const repeatsNode = deduplicated.length > 1 && deduplicated.some((node) => compact(text(node.therapyDirection)) === compact(next));
    if (kept.length > 0 && kept.length < items.length && !repeatsNode) { therapy.overallMethod = next; changed = true; }
  }

  // 病性轴：去掉这一类的条目（至少留一条）。
  const nature = record(pathogenesis.natureDifferentiation);
  if (nature) {
    const isFailedTerm = (value: unknown) => hasFailedMention(text(value), failed, entailment);
    const items = Array.isArray(nature.items) ? nature.items : [];
    const keptItems = items.filter((item) => !isFailedTerm(item));
    if (keptItems.length > 0 && keptItems.length < items.length) {
      nature.items = keptItems;
      for (const key of ["rootDeficiency", "branchExcess"] as const) {
        if (Array.isArray(nature[key])) nature[key] = (nature[key] as unknown[]).filter((item) => !isFailedTerm(item));
      }
      changed = true;
    }
  }

  // 辨证依据、总体病机：删写了这一证素的分句（删到太短就不删）。
  for (const [key, minimum] of [["tcmDiagnosticRationale", 20], ["overallPathogenesis", 10]] as const) {
    const value = text(overview[key]);
    if (!value) continue;
    const clauses = value.split(/[，,。；;]/u).map((item) => item.trim()).filter((clause) => clause && hasFailedMention(clause, failed, entailment));
    if (clauses.length === 0) continue;
    const next = withoutClauses(value, clauses);
    if (next.length >= minimum && next !== value) { overview[key] = next; changed = true; }
  }

  // 不确定项：写明这一证素的要点尚未成组出现，供医生望诊、问诊核实。
  const uncertainties = Array.isArray(pathogenesis.uncertainties) ? pathogenesis.uncertainties : [];
  for (const type of failed) {
    const unit = decision.verdicts.find((item) => item.unit.type === type);
    const entry = uncertaintyFor(type, unit?.verdict.entry || unit?.unit.entryName || LEXICON.types[type].genericEntry);
    if (!records(uncertainties).some((item) => text(item.item) === entry.item)) uncertainties.unshift(entry);
  }
  pathogenesis.uncertainties = uncertainties;
  return JSON.stringify(root);
}
