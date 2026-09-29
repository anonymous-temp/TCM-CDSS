import { readFileSync } from "node:fs";
import path from "node:path";
import webSourcesJson from "../data/tcm-nondrug-web-sources.source.json" with { type: "json" };
import webSchedulesJson from "../data/tcm-nondrug-web-schedules.source.json" with { type: "json" };
import syndromeConceptsJson from "../data/tcm-syndrome-label-concepts.source.json" with { type: "json" };
import { resolveTcmDiseaseName } from "./clinical-terminology";
import { formulaAnalysisHerbMentions } from "./formula-analysis-review";
import type { TcmTreatmentProjectCode } from "./tcm-treatment-projects";

/**
 * 中医非药物治疗的「教材方案」运行时（2026-09-29，甲方 9.24/9.27 测评 2.4）。
 *
 * 甲方原话：「中医治疗项目非常机械化，不能形成可执行的治疗操作」「食疗还需要取穴针刺吗」。
 * 目录里 22 个项目 19 个是类目模板、0 个可执行，命不中模板的病例只能得到「本轮仅进行现场适应证…评估，
 * 不形成操作计划」。缺的是方案内容：规划教材（针灸治疗学/针灸学/推拿学/中医食疗学）各病证节本来就写得很全
 * ——治法、主穴、按证型配穴、按症状配穴、操作、其他疗法、按证型的食疗方。
 * scripts/build-tcm-nondrug-textbook-protocols.py 把它们整形成 src/data/tcm-nondrug-textbook-protocols.json，
 * 每条带书名与行号。本模块只做三件事：按本例中医病名找到教材病证节；按已签名证型取教材配穴/食疗方；
 * 组装成卡片各字段。**不改写任何临床文字**：穴名、药名、剂量、做法都是教材原句。
 *
 * 安全边界（与治理目录同口径）：
 *  · 结果永远 executable=false、clinicianReviewRequired=true（针刺、推拿等须由接诊医师现场操作），教材来源标注「项目治理教材来源」；
 *    证型配穴的依据是教材原句 + 联网权威来源核对，状态记 approved（2026-09-29 owner 决定：没有可签字的中医师，
 *    不再把教材配穴挂成待终审）；
 *  · 食疗方配料必须全部出自国家「既是食品又是中药材」目录或普通食物；含其他药材（麻黄附子粥、川芎白芷类）的整方不出，
 *    目录里仅作香辛料的（当归等）也不得作主料；
 *  · 只在病种命中且证型/症状相符时才加穴，命不中就只给病种主穴并如实写「未按本例证型加减」。
 * `CDSS_NONDRUG_TEXTBOOK_PLANS=false` 整体关闭（回滚开关）。
 */

type TextbookBook = { title?: string; editors?: string; edition?: string | null; publisher?: string; year?: number };
type AcupunctureSyndrome = { label: string; keySymptoms?: string; addPoints: string[]; line?: number };
type ProjectItem = { method: string; content: string; points: string[]; pointSystem: string; indication: string; line: number };
type AcupunctureEntry = {
  disease: string; aliases: string[]; westernScope: string; book: string; line: number; therapy: string;
  mainPoints: string[]; syndromes: AcupunctureSyndrome[];
  symptomAddPoints: Array<{ symptom: string; points: string[] }>;
  operation: string; cautions: string[]; projects: Record<string, ProjectItem[]>;
};
type TuinaEntry = {
  disease: string; aliases: string[]; line: number; principle: string; sites: string[]; points: string[];
  manipulations: string[]; operation: string[]; syndromeModifications: Array<{ label: string; content: string }>;
};
type DietRecipe = { name: string; classicSource: string; text: string; line?: number };
type DietSyndrome = { label: string; keySymptoms: string; method: string; ingredients: string[]; recipes: DietRecipe[]; line?: number };
type DietEntry = { disease: string; aliases: string[]; westernScope: string; line: number; principle: string; syndromes: DietSyndrome[] };
type ProtocolData = {
  sources: Record<string, TextbookBook>;
  modalityDefaults: Record<string, { text: string; line: number }>;
  acupuncture: AcupunctureEntry[];
  tuina: TuinaEntry[];
  diet: DietEntry[];
};

let cachedData: ProtocolData | null | undefined;

function protocolData(): ProtocolData | null {
  if (cachedData !== undefined) return cachedData;
  try {
    cachedData = JSON.parse(readFileSync(path.join(process.cwd(), "src", "data", "tcm-nondrug-textbook-protocols.json"), "utf8")) as ProtocolData;
  } catch {
    console.warn("[tcm-cdss:knowledge] tcm-nondrug-textbook-protocols.json unreadable; textbook plans disabled");
    cachedData = null;
  }
  return cachedData;
}

export function textbookNondrugPlansEnabled(): boolean {
  return process.env.CDSS_NONDRUG_TEXTBOOK_PLANS !== "false";
}

// ─── 病名 / 证型相符 ──────────────────────────────────────────────────────────

function compact(value: string): string {
  return String(value || "").normalize("NFKC").replace(/[\s（）()，,。；;：:、·]/g, "");
}

function diseaseKey(value: string): string {
  const text = compact(value);
  return text.length > 2 ? text.replace(/[病症]$/, "") : text;
}

function canonicalDisease(value: string): string {
  const resolved = resolveTcmDiseaseName(value);
  return resolved && resolved.status !== "unverified" ? diseaseKey(resolved.canonical) : "";
}

function entryKeys(entry: { disease: string; aliases: string[] }): string[] {
  return [entry.disease, ...entry.aliases].flatMap((name) =>
    name.split(/[、,，]/).map((part) => part.trim()).filter(Boolean));
}

/** 本例中医病名（及其受治理别名）与教材病证节的相符。同名多节时（针灸治疗学/针灸学各一节）全部返回。 */
function matchDiseaseEntries<T extends { disease: string; aliases: string[]; westernScope?: string }>(
  list: readonly T[],
  diseaseNames: readonly string[],
  westernNames: readonly string[],
): T[] {
  const wanted = new Set(diseaseNames.flatMap((name) => [diseaseKey(name), canonicalDisease(name)]).filter(Boolean));
  const exact = list.filter((entry) => entryKeys(entry).some((key) =>
    wanted.has(diseaseKey(key)) || wanted.has(canonicalDisease(key))));
  if (exact.length > 0) return exact;
  // 中医病名对不上时，用签名的西医诊断名对教材「西医学…属本病范畴」的范围；只认整词相等，不做子串。
  const western = new Set(westernNames.map((name) => compact(name)).filter((name) => name.length >= 3));
  if (western.size === 0) return [];
  return list.filter((entry) => (entry.westernScope || "").split(/[、,，]/)
    .some((part) => western.has(compact(part))));
}

type ConceptRule = { id: string; terms: string[]; covers?: string[] };
const CONCEPTS = syndromeConceptsJson as { organs: ConceptRule[]; natures: ConceptRule[] };

function syndromeConcepts(label: string): { organs: Set<string>; natures: Set<string> } {
  const text = compact(label).replace(/证候$/, "").replace(/[证型]$/, "");
  const organs = new Set<string>();
  const natures = new Set<string>();
  for (const rule of CONCEPTS.organs) if (rule.terms.some((term) => text.includes(term))) organs.add(rule.id);
  // 「表」只在证名里单独出现、且不是「表里」这类构词时才算脏腑位（风寒表证、风热袭表）。
  for (const rule of CONCEPTS.natures) {
    if (rule.terms.some((term) => text.includes(term))) {
      natures.add(rule.id);
      for (const cover of rule.covers || []) natures.add(cover);
    }
  }
  return { organs, natures };
}

/**
 * 教材证型名与本例已签名证候（主证+兼证结论）相符的程度：0=不符。
 * 教材证型的脏腑与病性概念必须**全部**出现在本例证候里，且至少一个是病性概念；得分=概念个数（越具体越高）。
 */
function syndromeMatchScore(textbookLabel: string, caseSyndromeText: string): { score: number; natures: Set<string> } {
  const target = syndromeConcepts(textbookLabel);
  if (target.natures.size === 0) return { score: 0, natures: new Set() };
  const have = syndromeConcepts(caseSyndromeText);
  for (const organ of target.organs) if (!have.organs.has(organ)) return { score: 0, natures: new Set() };
  // 泛概念「虚」由具体虚证覆盖；具体概念必须逐字出现。
  for (const nature of target.natures) if (!have.natures.has(nature)) return { score: 0, natures: new Set() };
  return { score: target.organs.size + target.natures.size, natures: target.natures };
}

/**
 * 证型名对上还不够：教材该证型的辨证要点（症状短语，舌脉除外）在本例**当前事实**里至少出现一条，才按证型配穴/选方。
 * 与目录证型加减同一条底线（中医师要求证型证据成立才加穴）；没有病历事实时一律不按证型加减（fail-closed）。
 */
function syndromeEvidencePresent(keySymptoms: string | undefined, currentFacts: string): boolean {
  const facts = compact(currentFacts);
  if (!facts) return false;
  const text = compact(String(keySymptoms || "").split(/[，、；。：:]/)
    .filter((phrase) => !/^[舌脉苔]/.test(compact(phrase))).join(""));
  if (text.length < 2) return true;
  // 教材辨证要点是叙述句（「风团色红，灼热剧痒，遇热加重」），病历写法各异：按二字组比对，
  // 扣掉「疼痛/加重/发作」这类任何病都有的泛词，至少共有一个症状二字组（且本例有病历事实）才算有证据；证型相符本身已由已签名证候名判定，这里只防「证名撞上、病历却毫无相关表现」。
  const generic = new Set("疼痛,加重,不适,发作,反复,伴有,兼见,可见,时作,时止,持续,明显,症状,或者".split(","));
  const shared = new Set<string>();
  for (let index = 0; index + 2 <= text.length; index += 1) {
    const gram = text.slice(index, index + 2);
    if (!generic.has(gram) && facts.includes(gram)) shared.add(gram);
  }
  return shared.size >= 1;
}

/** 取相符度最高的一个证型，再补一个与它病性概念不相交的（本例兼有两类证候时，如「湿热蕴结，气滞血瘀」）。 */
function pickSyndromes<T extends { label: string; keySymptoms?: string }>(
  candidates: readonly T[],
  caseSyndromeText: string,
  currentFacts: string,
): T[] {
  const scored = candidates
    .map((item, index) => ({ item, index, ...syndromeMatchScore(item.label, caseSyndromeText) }))
    .filter((entry) => entry.score > 0 && syndromeEvidencePresent(entry.item.keySymptoms, currentFacts))
    .sort((left, right) => right.score - left.score || left.index - right.index);
  if (scored.length === 0) return [];
  const first = scored[0];
  const second = scored.slice(1).find((entry) => [...entry.natures].every((nature) => !first.natures.has(nature)));
  return second ? [first.item, second.item] : [first.item];
}

// ─── 出处 ─────────────────────────────────────────────────────────────────────

const BOOK_KEY_BY_ENTRY_BOOK: Record<string, string> = {
  zhenjiu_zhiliao: "zhenjiu_zhiliao", zhenjiu_xue: "zhenjiu_xue", tuina: "tuina", shiliao: "shiliao",
};

function bookCitation(data: ProtocolData, book: string, section: string, line: number): string {
  const info = data.sources[BOOK_KEY_BY_ENTRY_BOOK[book] || book];
  if (!info) return `教材「${section}」节（第${line}行）`;
  return `《${info.title}》（${info.editors}主编，${info.publisher}，${info.year}）「${section}」节（教材原文第${line}行）`;
}

// ─── 频次 ─────────────────────────────────────────────────────────────────────

function frequencySentence(text: string): string {
  // 频次词是有限闭集（每日/每天/隔日/每周…），不是临床语义词表。
  const anchor = new RegExp(["每日", "每天", "隔日", "每周", "一日", "每隔"].join("|"));
  for (const sentence of String(text || "").split(/[。；;]/)) {
    if (anchor.test(sentence) && /\d/.test(sentence) && sentence.includes("次")) return `${sentence.trim()}。`;
  }
  return "";
}

// ─── 药食同源 ────────────────────────────────────────────────────────────────

type WebSources = {
  foodMedicineHomology: { items: Array<{ name: string; listedAs?: string }>; restrictedUse: Array<{ name: string; restriction: string }> };
  commonFoodAllowlist: string[];
  daoyinRoutines: Array<{ routine: string; movements: string[]; movementEffects?: Array<{ movement: string; effect: string; sourceId: string }> }>;
  conditionDaoyin: Array<{ condition: string; method: string; movement: string; frequency: string; sourceIds: string[]; notes?: string }>;
  techniqueSafety: Array<{ technique: string; contraindications: string }>;
};
const WEB = webSourcesJson as unknown as WebSources;

let homologyNames: Set<string> | undefined;

function homologySet(): Set<string> {
  if (homologyNames) return homologyNames;
  const names = new Set<string>();
  for (const item of WEB.foodMedicineHomology.items) {
    for (const raw of [item.name, item.listedAs || ""]) {
      for (const part of raw.split(/[（）()、,，/\s]+/)) if (part) names.add(part);
    }
  }
  // 目录印刷写法与食谱写法的常见差异（目录说明 notes：用「橘皮」不用「陈皮」、「紫苏」=紫苏叶、「姜」含生姜干姜、「枣」含大枣）。
  const bridges: Array<[string, string]> = [["苏叶", "紫苏"], ["紫苏叶", "紫苏"], ["生姜", "姜"], ["干姜", "姜"], ["大枣", "枣"], ["红枣", "枣"],
    ["桂圆", "龙眼肉"], ["陈皮", "橘皮"], ["橘红", "桔红"], ["苦杏仁", "杏仁"], ["甜杏仁", "杏仁"], ["银花", "金银花"], ["熟地黄", "地黄"], ["生地黄", "地黄"]];
  for (const [alias, base] of bridges) if (names.has(base)) names.add(alias);
  for (const restricted of WEB.foodMedicineHomology.restrictedUse) names.delete(restricted.name);
  homologyNames = names;
  return names;
}

function commonFoods(): Set<string> {
  return new Set(WEB.commonFoodAllowlist);
}

/** 食谱是否只用国家「既是食品又是中药材」目录物质或普通食物。含任何其他药材（含仅作香辛料的当归）即整方不出。 */
export function recipeUsesOnlyFoodSafeIngredients(recipeText: string): boolean {
  const ingredientSentence = String(recipeText || "").split("。")[0] || "";
  const allowed = homologySet();
  const foods = commonFoods();
  const restricted = new Set(WEB.foodMedicineHomology.restrictedUse.map((item) => item.name));
  for (const mention of formulaAnalysisHerbMentions(ingredientSentence)) {
    if (restricted.has(mention.token)) return false;
    if (allowed.has(mention.token) || foods.has(mention.token)) continue;
    return false;
  }
  return true;
}

// ─── 计划组装 ────────────────────────────────────────────────────────────────

export type TextbookPlanInput = {
  projectCode: TcmTreatmentProjectCode;
  /** 已签名的中医病名（tcmDiseaseName 及其别名）。 */
  diseaseNames: readonly string[];
  /** 已签名的西医主诊断名（仅在中医病名对不上教材节时作范围核对）。 */
  westernNames: readonly string[];
  /** 已签名证候结论：主证 + 兼证。证型配穴/食疗只读它，不读病历原文。 */
  signedSyndromeText: string;
  /** 本例当前阳性事实（主诉/现病史/四诊，已阳性化）。按症状加穴只读它。 */
  currentFacts: string;
  /** 本例证候的病位/病机/治法叙述，仅供功法动作选择。 */
  signedNarrative?: string;
};

export type TextbookPlanPoint = {
  name: string;
  role: "base_point" | "syndrome_refinement" | "conditional_point";
  /** 配穴来自哪个教材证型（role=syndrome_refinement 时）。 */
  syndromeLabel?: string;
  note?: string;
};

export type TextbookPlan = {
  kind: "acupoint" | "diet" | "daoyin";
  treatmentContent: string;
  points: TextbookPlanPoint[];
  /** 食疗方 / 功法动作等非穴位条目（每条 ≤200 字）。 */
  items: string[];
  scheduleSuggestion: string;
  techniqueBoundary: string;
  protocolSource: string;
  syndromeLabels: string[];
  /** 是否按本例已签名证型做了配穴/选方。 */
  syndromeTailored: boolean;
  sourceRefs: string[];
};

const POINT_LIMIT = 12;

// ─── 联网核对的频次（A/B 级来源）─────────────────────────────────────────────

type WebScheduleEntry = {
  disease: string; aliases: string[]; modality: string; schedule: string; techniqueNote: string;
  sourceId: string; sourceTitle: string; publisher: string; tier: string; url: string;
};
const WEB_SCHEDULES = (webSchedulesJson as unknown as { entries: WebScheduleEntry[] }).entries;

/**
 * 教材该病证节没有单列频次时，用联网核对的 A/B 级来源补：国家/省级中医药管理局诊疗方案优先（A 级先于 B 级）。
 * 病名按名称与别名整词相等匹配；来源与等级写进卡片来源栏，医生看得到这条频次是谁说的。
 */
function webScheduleFor(modality: string, diseaseNames: readonly string[]): { schedule: string; citation: string } | undefined {
  const wanted = new Set(diseaseNames.map(diseaseKey).filter(Boolean));
  if (wanted.size === 0) return undefined;
  const hits = WEB_SCHEDULES.filter((entry) => entry.modality === modality &&
    [entry.disease, ...entry.aliases].flatMap((name) => name.split(/[\/、]/)).map((name) => diseaseKey(name.replace(/（[^）]*）/g, "")))
      .some((key) => key && wanted.has(key)))
    .sort((left, right) => left.tier.localeCompare(right.tier));
  const best = hits[0];
  if (!best) return undefined;
  return {
    schedule: `${best.schedule.replace(/[。]+$/, "")}（${best.publisher}《${best.sourceTitle}》）`,
    citation: `频次来源：${best.publisher}《${best.sourceTitle}》（${best.tier}级，${best.url}）`,
  };
}

function uniq<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function syndromeOptionsText(syndromes: readonly AcupunctureSyndrome[]): string {
  return syndromes.filter((item) => item.addPoints.length > 0)
    .map((item) => `${item.label}配${item.addPoints.join("、")}`).join("；");
}

/** 把条目并进正文，总长不超过卡片字段上限；放不下的条目整条舍去，不截断。 */
function contentWithItems(head: string, items: readonly string[]): string {
  const budget = 1150;
  let text = cutText(head, 400);
  for (const item of items) {
    const next = `${text}${text.endsWith("：") || text.endsWith("。") ? "" : "；"}${item}`;
    if (next.length > budget) break;
    text = next;
  }
  return text;
}

function cutText(value: string, max: number): string {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

const TECHNIQUE_NAME_BY_PROJECT: Record<string, string> = {
  acupuncture: "针刺（附）", moxibustion: "艾灸", cupping: "拔罐", guasha: "刮痧", auricular: "耳穴", tuina: "推拿",
};

/** 该项目的技术禁忌（国家中医药管理局护理方案与技术规范，逐条核对过引文，见来源快照）。 */
function techniqueContraindications(code: string): string {
  const name = TECHNIQUE_NAME_BY_PROJECT[code];
  const item = name ? WEB.techniqueSafety.find((entry) => entry.technique === name) : undefined;
  return item ? `禁忌：${item.contraindications}。` : "";
}

function acupointPlan(data: ProtocolData, input: TextbookPlanInput): TextbookPlan | undefined {
  const entries = matchDiseaseEntries(data.acupuncture, input.diseaseNames, input.westernNames);
  if (entries.length === 0) return undefined;
  const primary = entries.find((entry) => entry.book === "zhenjiu_zhiliao") || entries[0];
  const secondary = entries.find((entry) => entry !== primary);
  const code = input.projectCode;
  const sourceRefs: string[] = [];
  const cite = (entry: AcupunctureEntry) => {
    sourceRefs.push(`《${data.sources[entry.book]?.title || "教材"}》(${data.sources[entry.book]?.year || ""})`);
    return bookCitation(data, entry.book, entry.disease, entry.line);
  };

  // 项目专属条目：针刺用主穴；灸/罐/刮痧/耳穴/推拿/埋线等取该病证节「其他治疗」里的对应条目。
  let base: { points: string[]; content: string; system: string; line: number; entry: AcupunctureEntry } | undefined;
  if (code === "acupuncture") {
    base = { points: primary.mainPoints, content: primary.therapy, system: "body", line: primary.line, entry: primary };
  } else {
    for (const entry of [primary, ...entries.filter((item) => item !== primary)]) {
      const items = entry.projects[code] || [];
      if (items.length === 0) continue;
      const merged = uniq(items.flatMap((item) => item.points));
      base = {
        points: merged,
        content: items.map((item) => item.content).join(" "),
        system: items[0].pointSystem,
        line: items[0].line,
        entry,
      };
      break;
    }
  }
  if (!base || base.points.length === 0) return undefined;

  const points: TextbookPlanPoint[] = base.points.map((name) => ({ name, role: "base_point" as const }));
  const syndromeLabels: string[] = [];
  let tailored = false;
  let syndromeClause = "";
  // 证型配穴与症状配穴只对针刺主方案做（其他疗法在教材里是固定取穴，没有按证型的配穴表）。
  if (code === "acupuncture") {
    const candidateSyndromes = [
      ...primary.syndromes,
      ...(secondary ? secondary.syndromes : []),
    ].filter((item) => item.addPoints.length > 0);
    const picked = pickSyndromes(candidateSyndromes, input.signedSyndromeText, input.currentFacts);
    if (picked.length > 0) {
      tailored = true;
      for (const syndrome of picked) {
        syndromeLabels.push(syndrome.label);
        for (const point of syndrome.addPoints) {
          if (!points.some((existing) => existing.name === point)) points.push({ name: point, role: "syndrome_refinement", syndromeLabel: syndrome.label, note: `${syndrome.label}配穴` });
        }
      }
      syndromeClause = `本例已签名证候与教材「${picked.map((item) => item.label).join("」「")}」相符，在主穴基础上加${picked.flatMap((item) => item.addPoints).join("、")}；`;
    } else {
      const options = syndromeOptionsText(primary.syndromes);
      syndromeClause = options
        ? `本例证候未与教材证型逐一对应，教材按证型配穴为：${options}；按本例证型选用；`
        : "";
    }
    const facts = compact(input.currentFacts);
    const symptomParts: string[] = [];
    for (const item of [...primary.symptomAddPoints, ...(secondary?.symptomAddPoints || [])]) {
      const label = compact(item.symptom).replace(/^(?:素体|兼)/, "");
      const halves = label.length === 4 ? [label.slice(0, 2), label.slice(2)] : [];
      const present = label.length >= 2 && (facts.includes(label) || (halves.length === 2 && halves.every((half) => facts.includes(half))));
      if (!present) continue;
      const fresh = item.points.filter((point) => !points.some((existing) => existing.name === point));
      if (fresh.length === 0) continue;
      for (const point of fresh) points.push({ name: point, role: "conditional_point", note: `本例有「${item.symptom}」加用` });
      symptomParts.push(`${item.symptom}加${fresh.join("、")}`);
    }
    if (symptomParts.length > 0) syndromeClause += `按本例症状加用：${symptomParts.join("；")}；`;
  }

  const finalPoints = points.slice(0, POINT_LIMIT);
  const citation = cite(base.entry);
  if (secondary && code === "acupuncture") cite(secondary);
  const projectName = code === "acupuncture" ? "针刺" : "";
  const contentHead = code === "acupuncture"
    ? `按教材，${primary.disease}的针刺治法为「${cutText(base.content.replace(/[。]+$/, ""), 80)}」。`
    : `按教材，${primary.disease}可选用的${projectName}${cutText(base.content, 240)}`;
  const operation = code === "acupuncture" ? primary.operation : base.content;
  const frequency = frequencySentence(operation) || frequencySentence(primary.operation);
  const defaultKey = code === "acupuncture" ? "acupuncture" : code === "cupping" ? "cupping" : code === "moxibustion" ? "moxibustion" : "";
  const defaultText = defaultKey ? data.modalityDefaults[defaultKey]?.text || "" : "";
  const defaultClause = defaultText ? `${defaultText.replace(/[。]+$/, "")}（《刺法灸法学》总论）。` : "";
  const web = frequency ? undefined : webScheduleFor(code, input.diseaseNames);
  const schedule = frequency
    ? `${frequency}${defaultClause ? ` ${defaultClause}` : ""}`
    : web
      ? `${web.schedule}。${defaultClause}`
      : defaultClause
        ? `${defaultClause}该病证节未另列频次与疗程，具体间隔按病情与耐受确定。`
        : "该病证节未单列频次与疗程，按操作时长与耐受确定间隔。";
  const technique = code === "acupuncture"
    ? cutText(primary.operation || "毫针常规针刺。", 420)
    : cutText(`${base.content}`, 420);

  return {
    kind: "acupoint",
    treatmentContent: cutText(`${contentHead}${syndromeClause}穴位见下。${tailored ? "" : "未按本例证型加减的部分请按寒热虚实增减。"}`, 1150),
    points: finalPoints,
    items: [],
    scheduleSuggestion: cutText(schedule, 560),
    techniqueBoundary: cutText(`${technique} ${techniqueContraindications(code)}补泻手法、进针深度以现场查体为准。`, 980),
    protocolSource: cutText(`${citation}${secondary && code === "acupuncture" ? `；《${data.sources[secondary.book]?.title}》同名节（教材原文第${secondary.line}行）` : ""}${web ? `；${web.citation}` : ""}`, 980),
    syndromeLabels,
    syndromeTailored: tailored,
    sourceRefs: uniq(sourceRefs).slice(0, 8),
  };
}

function tuinaPlan(data: ProtocolData, input: TextbookPlanInput): TextbookPlan | undefined {
  const entries = matchDiseaseEntries(data.tuina, input.diseaseNames, input.westernNames);
  const entry = entries[0];
  if (!entry) return undefined;
  const sites = uniq([...entry.sites, ...entry.points]);
  if (sites.length === 0) return undefined;
  const picked = pickSyndromes(entry.syndromeModifications.map((item) => ({ ...item, keySymptoms: "" })), input.signedSyndromeText, input.currentFacts);
  const modification = picked[0];
  const tuinaWeb = webScheduleFor("tuina", input.diseaseNames);
  return {
    kind: "acupoint",
    treatmentContent: cutText(
      `按教材，${entry.disease}的推拿治则为「${(entry.principle.split("。")[0] || entry.principle).trim()}」，手法：${uniq(entry.manipulations).slice(0, 8).join("、") || "见操作"}。${modification ? `本例证候与教材「${modification.label}」相符：${cutText(modification.content, 200)}` : ""}`,
      1150,
    ),
    points: sites.slice(0, POINT_LIMIT).map((name) => ({ name, role: "base_point" as const })),
    items: [],
    scheduleSuggestion: tuinaWeb
      ? `${tuinaWeb.schedule}。教材按手法逐项给出操作时长（如每穴约1分钟、反复3～5遍）。`
      : "教材按手法逐项给出操作时长（如每穴约1分钟、反复3～5遍），未单列每周次数；疗程与间隔按耐受确定，每次操作完毕观察反应。",
    techniqueBoundary: cutText(`${entry.operation.slice(0, 3).join(" ")} ${techniqueContraindications("tuina")}`, 980) || "手法与力度以现场查体为准。",
    protocolSource: cutText(`${bookCitation(data, "tuina", entry.disease, entry.line)}${tuinaWeb ? `；${tuinaWeb.citation}` : ""}`, 980),
    syndromeLabels: modification ? [modification.label] : [],
    syndromeTailored: Boolean(modification),
    sourceRefs: [`《${data.sources.tuina?.title}》(${data.sources.tuina?.year})`],
  };
}

function dietPlan(data: ProtocolData, input: TextbookPlanInput): TextbookPlan | undefined {
  const entries = matchDiseaseEntries(data.diet, input.diseaseNames, input.westernNames);
  const entry = entries[0];
  if (!entry) return undefined;
  // 教材里有些食疗方只写「见‘血证’节」这类互见，没有配料与做法，不能当方案给出。
  const safeRecipes = (syndrome: DietSyndrome) => syndrome.recipes.filter((recipe) =>
    recipe.text.length >= 20 && !recipe.text.startsWith("见") && recipeUsesOnlyFoodSafeIngredients(recipe.text));
  const principleSentence = cutText((entry.principle.split("。")[0] || "").trim(), 110);
  const picked = pickSyndromes(entry.syndromes, input.signedSyndromeText, input.currentFacts).filter((syndrome) => safeRecipes(syndrome).length > 0);
  const format = (syndrome: DietSyndrome, recipe: DietRecipe) =>
    cutText(`${syndrome.label}：${recipe.name}${recipe.classicSource ? `（${recipe.classicSource}）` : ""}：${recipe.text}`, 200);
  let items: string[];
  let tailored = false;
  let head: string;
  if (picked.length > 0) {
    tailored = true;
    items = picked.flatMap((syndrome) => safeRecipes(syndrome).slice(0, 2).map((recipe) => format(syndrome, recipe)));
    head = `本例已签名证候与教材食疗「${picked.map((item) => item.label).join("」「")}」相符，食疗原则：${picked.map((item) => item.method).filter(Boolean).join("；")}。`;
  } else {
    // 本例证候没有对应的教材证型时只给「证型—食疗方法—代表方」的框架，不把某一型的具体食谱当成本例方案。
    items = entry.syndromes.filter((syndrome) => safeRecipes(syndrome).length > 0).slice(0, 6)
      .map((syndrome) => cutText(`${syndrome.label}：${syndrome.method || "见教材"}（代表方：${safeRecipes(syndrome)[0].name}）`, 200));
    head = "教材按证型分型给出食疗方，本例证候未与其逐一对应，下列为各型的食疗方法与代表方，具体食谱按本例证型选用。";
  }
  if (items.length === 0) return undefined;
  const first = picked[0] ? safeRecipes(picked[0])[0] : undefined;
  const usage = first ? frequencySentence(first.text) || first.text.split("。").find((part) => part.includes("每日") || part.includes("每天")) || "" : "";
  const dietHead = `按教材，${entry.disease}${tailored && principleSentence ? `：${principleSentence}。` : "的食疗："}${head}`;
  return {
    kind: "diet",
    // 食疗方进 treatmentContent（无穴项目的 suggestedSitesOrPoints 保持为空，与目录口径一致；
    // 「取穴」「穴位/部位」这类栏目对食疗没有意义，2026-09-29 甲方测评点名）。整条放不下就整条不放，绝不截断食谱。
    treatmentContent: contentWithItems(dietHead, items),
    points: [],
    items,
    scheduleSuggestion: cutText(usage ? `${usage.replace(/[。]+$/, "")}（各方以其原文用法为准）。` : "各方以其原文用法为准，随三餐日常执行，复诊时按症状变化复评。", 560),
    techniqueBoundary: "配料已限定为国家「既是食品又是中药材」目录物质与普通食物，仅作饮食调养，不替代药物治疗；对方中食材过敏、正在服用抗凝/降糖/降压药、孕期哺乳期、慢性肾病或吞咽障碍者须先核对，孕妇哺乳期与婴幼儿不推荐食药物质。",
    protocolSource: cutText(bookCitation(data, "shiliao", entry.disease, entry.line), 980),
    syndromeLabels: picked.map((item) => item.label),
    syndromeTailored: tailored,
    sourceRefs: [`《${data.sources.shiliao?.title}》(${data.sources.shiliao?.year})`],
  };
}

function daoyinPlan(input: TextbookPlanInput): TextbookPlan | undefined {
  const facts = compact(`${input.diseaseNames.join("")}${input.westernNames.join("")}${input.signedSyndromeText}`);
  const condition = WEB.conditionDaoyin.find((item) => {
    const key = compact(item.condition).replace(/[（(].*$/, "");
    return key.length >= 2 && facts.includes(key.replace(/^(?:老年人|中老年)/, ""));
  });
  const narrative = compact(`${input.signedSyndromeText}${input.signedNarrative || ""}`);
  const eight = WEB.daoyinRoutines.find((routine) => routine.routine.includes("八段锦"));
  const scored = (eight?.movementEffects || [])
    .filter((effect) => effect.movement && !/预备|收势/.test(effect.movement))
    .map((effect) => {
      const grams = new Set<string>();
      const text = compact(effect.effect);
      for (let index = 0; index + 2 <= text.length; index += 1) grams.add(text.slice(index, index + 2));
      let score = 0;
      for (const gram of grams) if (narrative.includes(gram)) score += 1;
      return { movement: effect.movement, effect: effect.effect, score };
    })
    .filter((entry) => entry.score >= 3)
    .sort((left, right) => right.score - left.score);
  const picked = uniq(scored.slice(0, 3).map((entry) => entry.movement));
  if (!condition && picked.length === 0) return undefined;
  const items = [
    ...(condition ? [cutText(`${condition.method}${condition.movement ? `（${condition.movement}）` : ""}：${condition.frequency}`, 200)] : []),
    ...picked.map((movement) => {
      const effect = scored.find((entry) => entry.movement === movement)?.effect || "";
      return cutText(`八段锦「${movement}」：${effect}`, 200);
    }),
  ];
  const general = WEB.conditionDaoyin.find((item) => item.condition.includes("通则"));
  const schedule = condition?.frequency && /\d/.test(condition.frequency)
    ? `${condition.frequency}`
    : general?.frequency ? `${general.frequency}（团体标准资料性附录，循序渐进）` : "每周不少于5天，每天30分钟左右，循序渐进。";
  return {
    kind: "daoyin",
    treatmentContent: contentWithItems(
      `按国家体育总局健身气功管理中心与中华中医药学会团体标准，本例可习练：${condition ? "" : "（动作按本例病位病机所对应的功效选取）"}`,
      items,
    ),
    points: [],
    items,
    scheduleSuggestion: cutText(schedule, 560),
    techniqueBoundary: "慢性病稳定期人群应经专科医生评估许可，在专业人员指导下低强度习练；运动中出现胸痛、明显气促、头晕或心悸立即停止并就医。",
    protocolSource: "健身气功·八段锦（国家体育总局健身气功管理中心；T/CACM 1676—2026 / T/CHQA 0001—2026，中华中医药学会、中国健身气功协会）",
    syndromeLabels: [],
    syndromeTailored: false,
    sourceRefs: ["W-G0-38"],
  };
}

// 需专科资质的项目（放血/针刀/埋线…）与含药外治不出教材方案：它们只做评估，药物身份与审方是另一条通路。
const ACUPOINT_PROJECTS = new Set<string>(["acupuncture", "moxibustion", "cupping", "guasha", "auricular"]);

/** 本项目能否由教材给出方案（不看病例，只看项目类型）。 */
export function textbookPlanSupportsProject(code: string): boolean {
  return ACUPOINT_PROJECTS.has(code) || ["tuina", "diet_therapy", "qigong_daoyin"].includes(code);
}

/** 教材里有没有该病证的该项目方案（不看证型与病历事实）。供适应证排序：标签没收的病名，教材有方案即算适应证。 */
export function textbookPlanExistsForDisease(
  projectCode: TcmTreatmentProjectCode,
  tcmDiseaseName: string | undefined,
  westernName: string | undefined,
): boolean {
  if (!tcmDiseaseName && !westernName) return false;
  return Boolean(textbookTreatmentPlan({
    projectCode,
    diseaseNames: tcmDiseaseName ? [tcmDiseaseName] : [],
    westernNames: westernName ? [westernName] : [],
    signedSyndromeText: "",
    currentFacts: "",
  }));
}

export function textbookTreatmentPlan(input: TextbookPlanInput): TextbookPlan | undefined {
  if (!textbookNondrugPlansEnabled()) return undefined;
  const data = protocolData();
  if (!data) return undefined;
  const code = input.projectCode;
  if (code === "tuina") return tuinaPlan(data, input);
  if (code === "diet_therapy") return dietPlan(data, input);
  if (code === "qigong_daoyin") return daoyinPlan(input);
  if (ACUPOINT_PROJECTS.has(code)) return acupointPlan(data, input);
  return undefined;
}
