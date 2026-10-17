import { readFileSync } from "node:fs";
import path from "node:path";
import webSourcesJson from "../data/tcm-nondrug-web-sources.source.json" with { type: "json" };
import webSchedulesJson from "../data/tcm-nondrug-web-schedules.source.json" with { type: "json" };
import syndromeConceptsJson from "../data/tcm-syndrome-label-concepts.source.json" with { type: "json" };
import { resolveTcmDiseaseName } from "./clinical-terminology";
import { formulaAnalysisHerbMentions } from "./formula-analysis-review";
import { TCM_ACUPOINTS } from "./tcm-acupoints";
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
  /** 教材把基本治疗分成几套写的病（眩晕「实证 / 虚证」、中风「中经络 / 中脏腑」…）：每套各自的治法、主穴、操作。 */
  variants?: Array<{ label: string; therapy: string; mainPoints: string[]; operation: string }>;
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
/**
 * 教材证型名与本例已定证名是否是同一个证：去掉「证/型」后相等，或一方完整包含另一方（「心虚胆怯」与「心虚胆怯证」，
 * 「肝气犯胃」与「肝气犯胃证」）。只共享一个病性词（都有「气」「虚」）不算——那是 pickSyndromes 的宽口径，
 * 适合挑配穴，不适合决定给患者吃什么。
 */
function syndromeLabelMatchesSigned(label: string, signedSyndromeText: string): boolean {
  const core = (value: string) => value.normalize("NFKC").replace(/[\s（()）]/g, "").replace(/(?:证候|证型|证|型)$/u, "");
  const target = core(label);
  if (target.length < 2) return false;
  return signedSyndromeText.split(/[，,；;、\n]/).map(core).filter((item) => item.length >= 2)
    .some((item) => item === target || item.includes(target) || target.includes(item));
}

/**
 * 拿来比对的证型名。教材有的证型名本身不带病性（《针灸学》消渴「上消 / 中消 / 下消」），而辨证要点末尾写明了它是哪个证
 *（「…脉细数，为肾阴亏虚」）：这时用「为」后那个证名比对。此前下消对不上任何已签名证候，肾阴亏虚证反而对上了只含泛概念
 *「虚」的「阴阳两虚」，针刺卡写「本例属阴阳两虚，加关元、命门」（2026-10-14 独立评审）。
 */
function scoringLabel(item: { label: string; keySymptoms?: string }): string {
  if (syndromeConcepts(item.label).natures.size > 0) return item.label;
  return String(item.keySymptoms || "").match(/为([一-龥]{2,8})[。]?$/)?.[1] || item.label;
}

function pickSyndromes<T extends { label: string; keySymptoms?: string }>(
  candidates: readonly T[],
  caseSyndromeText: string,
  currentFacts: string,
): T[] {
  const scored = candidates
    .map((item, index) => ({ item, index, ...syndromeMatchScore(scoringLabel(item), caseSyndromeText) }))
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
  /** 患者年龄（岁）。老年人不列刺络放血、不套用长时间留针的疗程。 */
  patientAgeYears?: number;
  /** 主诉（教材分套的基本治疗按字面对套时用）。 */
  chiefComplaint?: string;
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
/** 禁针穴（闭集）：针刺项目的取穴里不列。 */
const NO_NEEDLE_POINTS: ReadonlySet<string> = new Set(["神阙", "乳中"]);

/**
 * 教材把主穴按疼痛部位分组的病（《针灸治疗学》痹病，教材原文「主穴 肩部：阿是穴 肩髃 肩髎 肩贞 臑俞 / 肘部：… / 腕部：… /
 * 脊背：… / 髀部：… / 膝部：… / 踝部：…」）。生成物把七组拍平成一列，取前 12 个就全是肩、肘、腕的穴——
 * 2026-10-13 独立评审：右膝、右踝红肿热痛的病例，针刺取穴全在上肢。分组照教材原文，部位词是闭集。
 */
const REGIONAL_MAIN_POINT_GROUPS: Readonly<Record<string, ReadonlyArray<{ region: string; cue: RegExp; points: readonly string[] }>>> = {
  痹病: [
    { region: "肩部", cue: /肩/, points: ["肩髃", "肩髎", "肩贞", "臑俞"] },
    { region: "肘部", cue: /肘/, points: ["曲池", "天井", "尺泽", "少海"] },
    { region: "腕部", cue: /腕|手指|指关节|掌指/, points: ["阳池", "外关", "阳溪", "腕骨"] },
    { region: "脊背", cue: /脊|背|腰|颈/, points: ["大杼", "身柱", "腰阳关", "夹脊"] },
    { region: "髀部", cue: /髋|髀|臀|胯/, points: ["环跳", "居髎", "秩边", "髀关"] },
    { region: "膝部", cue: /膝/, points: ["血海", "梁丘", "膝眼", "阳陵泉"] },
    { region: "踝部", cue: /踝|足跟|足背|跖趾|足趾|脚趾/, points: ["申脉", "照海", "昆仑", "丘墟"] },
  ],
};

/**
 * 教材把基本治疗分成几套写时，本例该用哪一套（2026-10-14）。
 *
 * 此前各套的治法、主穴、操作被合并成一条：眩晕·肾精不足（虚证）的病例，治法写「实证：平肝潜阳，和胃化痰… | 虚证：补益气血，益精填髓…」，
 * 取穴把实证的太冲、内关、丰隆和虚证的肝俞、肾俞、足三里混在一起（独立评审：两套并列未取舍，混入泻实穴）。
 *  · 「实证 / 虚证」两套：按已签名证候的名称定——只有虚损字样（虚、亏、不足、失养…）取虚证，只有实邪字样取实证；
 *    两类字样都有（气虚血瘀）或都没有时不取舍，沿用合并写法；
 *  · 其他分法（中经络 / 中脏腑、发作期 / 间歇期、月经先期 / 后期…）：套名逐字出现在已签名病名、证候或主诉里，且只对上一套时取它。
 * 判不出时返回 undefined，行为与此前相同。
 */
const DEFICIENCY_SYNDROME_WORDS = /虚|亏|不足|失养|衰少|不固|不摄/;
const EXCESS_SYNDROME_WORDS = /实|热|火|痰|湿|瘀|滞|郁|风|寒|毒|积|闭|亢|逆|扰|饮|浊/;
function pickBasicTreatmentVariant(entry: AcupunctureEntry, input: TextbookPlanInput) {
  const variants = (entry.variants || []).filter((item) => item.label && item.mainPoints.length > 0);
  if (variants.length < 2) return undefined;
  const byLabel = (label: string) => variants.find((item) => item.label === label);
  const deficiencyVariant = byLabel("虚证");
  const excessVariant = byLabel("实证");
  if (deficiencyVariant && excessVariant) {
    const nature = signedSyndromeDeficiencyExcess(input.signedSyndromeText);
    return nature === "deficiency" ? deficiencyVariant : nature === "excess" ? excessVariant : undefined;
  }
  const haystack = compact([...input.diseaseNames, input.signedSyndromeText, input.chiefComplaint || ""].join("；"));
  const literal = variants.filter((item) => {
    const label = compact(item.label.replace(/（[^）]*）|\([^)]*\)/g, ""));
    return label.length >= 2 && haystack.includes(label);
  });
  return literal.length === 1 ? literal[0] : undefined;
}

/**
 * 已签名证候是纯虚、纯实，还是判不出（虚实夹杂或没有字样）。教材「实证 / 虚证」两套取哪一套、刺络放血列不列、补泻手法与证候
 * 是否相反，都用这一个判据。虚热、虚火、虚风、虚寒、虚阳算虚，不因其中的热、火、风、寒算实。
 */
export function signedSyndromeDeficiencyExcess(signedSyndromeText: string): "deficiency" | "excess" | undefined {
  const syndrome = signedSyndromeText.replace(/虚热|虚火|虚风|虚寒|虚阳/g, "虚");
  const deficiency = DEFICIENCY_SYNDROME_WORDS.test(syndrome);
  const excess = EXCESS_SYNDROME_WORDS.test(syndrome);
  return deficiency && !excess ? "deficiency" : excess && !deficiency ? "excess" : undefined;
}

/**
 * 教材把外感、内伤（或实证、虚证）的操作写在同一句里（「外感咳嗽针用泻法，肺俞可配闪罐，每日治疗1~2次；内伤咳嗽针用平补平泻或补法…」），
 * 只留与本例证候相符的那一小句（2026-10-14 独立评审：内伤痰湿咳嗽的卡片写着外感咳嗽的泻法与闪罐）。判不出时原样保留。
 */
const EXTERIOR_SYNDROME_WORDS = /风寒|风热|风燥|风温|暑湿|外感|表|犯表|袭表|束表/;
function withSyndromeMatchedClauses(text: string, input: TextbookPlanInput): string {
  if (!/外感/.test(text) && !/内伤/.test(text) && !/实证/.test(text) && !/虚证/.test(text)) return text;
  const exterior = EXTERIOR_SYNDROME_WORDS.test(input.signedSyndromeText);
  const nature = signedSyndromeDeficiencyExcess(input.signedSyndromeText);
  return text.split(/(?<=[。；;])/).filter((clause) => {
    if (/^\s*外感/.test(clause) && !exterior) return false;
    if (/^\s*内伤/.test(clause) && exterior) return false;
    if (/^\s*实证/.test(clause) && nature === "deficiency") return false;
    if (/^\s*虚证/.test(clause) && nature === "excess") return false;
    return true;
  }).join("").trim() || text;
}

/**
 * 补泻手法与已签名证候相反的泛指句，改成与证候相符的一句（2026-10-14 独立评审：痰火扰心的实热证，针刺卡写「留针用补法」，
 * 出自院内目录的失眠模板）。依据是针灸治疗原则「补虚泻实」（《针灸学》各节：实证毫针泻法、虚证毫针补法；不寐等节「其他按虚补实泻操作」）。
 * 不动的句子：点名到具体穴位的（醒脑开窍法「三阴交用提插补法」、牙痛「配穴太溪用补法」是该穴的定法，不随证候改）、
 * 含平补平泻或「按虚补实泻」的；虚实判不出时整段不动。教材卡与目录卡在卡片汇总处（tcm-treatment-capabilities）都过这一道。
 */
export function manipulationMatchedToSyndrome(text: string, signedSyndromeText: string): string {
  const nature = signedSyndromeDeficiencyExcess(signedSyndromeText);
  if (!nature) return text;
  const wrong = nature === "excess" ? /补法/ : /泻法/;
  // 带「平补平泻」的句子照旧不动（本虚标实的痰湿蕴肺用平补平泻是教材原法）；只有证名是纯实热（带热/火、不带虚）而句子又把补法列为
  // 可选时算写错（2026-10-17 留出集：痰热郁肺、痰火扰心沿用「内伤咳嗽针用平补平泻或补法」）。
  const heatExcess = nature === "excess" && /热|火/.test(signedSyndromeText) && !/虚/.test(signedSyndromeText);
  const right = nature === "excess"
    ? (heatExcess ? /泻法|虚补实泻|补虚泻实/ : /泻法|平补平泻|虚补实泻|补虚泻实/)
    : /补法|平补平泻|虚补实泻|补虚泻实/;
  let replaced = false;
  return text.split(/(?<=[。；;])/).map((clause) => {
    if (!wrong.test(clause) || right.test(clause) || namesAcupoint(clause)) return clause;
    if (replaced) return "";
    replaced = true;
    return `针用${nature === "excess" ? "泻法" : "补法"}${clause.trim().match(/[。；;]$/)?.[0] || "。"}`;
  }).join("").trim() || text;
}

/**
 * 卡片里写给别的证型的句子不留（2026-10-17，甲方标准病历 6，独立评审两次判不通过）：
 * 肾阴虚腰痛的拔罐卡写「瘀血腰痛和寒湿腰痛可行刺络拔罐」，针刺卡写「寒湿腰痛、肾虚腰痛者，可加用灸法」。
 *  · 句中用证型修饰本病名（「寒湿腰痛」「瘀血腰痛」）或直接写「风热证」「寒湿者」，而没有一个与已签名证候相符时，整句不留。相符 = 修饰语的每个字都在证候名里
 *    （肾虚 ⊂ 肾阴虚证）。修饰语只认由证候用字组成的两字词（寒湿、瘀血、肾虚、湿热…），「急性腰痛」「慢性头痛」不算证型。
 *  · 证候属阴虚或热证时，建议用灸的句子不留（《刺法灸法学》：阴虚阳亢、邪热内炽者慎用灸法）；写「禁灸」「不宜灸」的句子照留。
 * 只删句，不改写；删完为空时原样返回。教材卡与目录卡在卡片汇总处都过这一道。
 */
const SYNDROME_DESCRIPTOR_CHARS = /^[寒湿热风暑燥火瘀血气虚实阴阳肾肝脾肺心胃胆痰郁滞亏损食积水饮]{2}$/u;
// 火字证名（火旺、肝火、胃火、痰火扰心…）都算，命门火衰是阳虚，不算。
const MOXIBUSTION_UNSUITABLE_SYNDROME = /阴虚|阴亏|阴液|实热|热盛|热毒|肺热|湿热|血热|痰热|郁热|火(?!衰)/u;
export function cardSentencesMatchedToSyndrome(text: string, diseaseNames: readonly string[], signedSyndromeText: string): string {
  const syndrome = String(signedSyndromeText || "");
  if (!text || !syndrome.trim()) return text;
  const diseases = diseaseNames.map((name) => name.trim()).filter((name) => name.length >= 2);
  const fits = (descriptor: string) => [...descriptor].every((char) => syndrome.includes(char));
  const noMoxibustion = MOXIBUSTION_UNSUITABLE_SYNDROME.test(syndrome);
  const kept = text.split(/(?<=[。；;])/).filter((sentence) => {
    if (noMoxibustion && /灸/.test(sentence) && !/禁灸|不宜灸|慎灸|忌灸|不灸/.test(sentence)) return false;
    const descriptors = [
      ...diseases.flatMap((disease) => [...sentence.matchAll(new RegExp(`([\\u4e00-\\u9fff]{2})${disease.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "gu"))]
        .map((match) => match[1])),
      // 「风热证大椎可行刺络拔罐」「寒湿者加灸」：证型修饰语后面直接跟证/者/型，不带病名（2026-10-17 甲方标准病历 1，风寒感冒卡里的风热刺络）。
      ...[...sentence.matchAll(/([\u4e00-\u9fff]{2})(?:证|者|型)/gu)].map((match) => match[1]),
    ].filter((descriptor) => SYNDROME_DESCRIPTOR_CHARS.test(descriptor));
    return descriptors.length === 0 || descriptors.some(fits);
  }).join("").trim();
  return kept || text;
}

let acupointNamePattern: RegExp | undefined;
/** 句子里点名了某个穴位（按穴位目录的穴名，长名优先）。 */
function namesAcupoint(clause: string): boolean {
  if (!acupointNamePattern) {
    const names = [...new Set(TCM_ACUPOINTS.map((entry) => entry.name).filter((name) => typeof name === "string" && name.length >= 2))]
      .sort((left, right) => right.length - left.length)
      .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    acupointNamePattern = new RegExp(names.join("|"));
  }
  return acupointNamePattern.test(clause);
}

/** 刺络放血类操作（刺络拔罐、点刺出血、三棱针）。 */
// 「皮肤针重叩出血后加拔火罐」也是出血类操作（2026-10-17 留出集：脾虚湿蕴、糜烂渗出的湿疮仍写这一句）。
const BLOODLETTING_SENTENCE = /刺络|放血|点刺出血|三棱针|刺血|叩(?:刺|至)?出血|重叩出血|出血后加拔/;
/** 病历写到的皮肤破损（抓破、结痂、破溃、糜烂、渗液）：这些部位不宜拔罐、刺络。 */
const BROKEN_SKIN_FACT = /抓痕|血痂|结痂|破溃|溃烂|糜烂|溃疡|渗液|渗出|皲裂/;
const ELDERLY_AGE_YEARS = 65;

/**
 * 刺络放血不作为常规写法的三种情形：老年人、已签名证候属虚证、病历写到皮肤破损（2026-10-14 独立评审：85 岁、皮肤干燥有抓痕血痂、
 * 血虚肝旺的瘙痒病例，操作栏写「背部穴、局部阿是穴均可刺络拔罐」）。依据：《刺法灸法学》三棱针法「体质虚弱者…慎用」、拔罐法
 *「皮肤有溃疡、破裂处不宜拔罐」；中华中医药学会 T/CACM 1560.3—2023「年老、虚弱、严重消瘦者，拔罐时间宜短」。只删提到这类操作的那一句。
 */
function withoutBloodlettingWhenUnsuitable(text: string, input: TextbookPlanInput): string {
  if (!BLOODLETTING_SENTENCE.test(text)) return text;
  const elderly = input.patientAgeYears != null && input.patientAgeYears >= ELDERLY_AGE_YEARS;
  const deficiency = signedSyndromeDeficiencyExcess(input.signedSyndromeText) === "deficiency";
  const brokenSkin = BROKEN_SKIN_FACT.test(input.currentFacts);
  if (!elderly && !deficiency && !brokenSkin) return text;
  return text.split(/(?<=[。；])/).filter((sentence) => !BLOODLETTING_SENTENCE.test(sentence)).join("").trim();
}

// ─── 联网核对的频次（A/B 级来源）─────────────────────────────────────────────

type WebScheduleEntry = {
  disease: string; aliases: string[]; modality: string; schedule: string; techniqueNote: string;
  sourceId: string; sourceTitle: string; publisher: string; tier: string; url: string;
  /** 该频次出自某个西医病种的专篇时，本例须确有该病（西医诊断或病历里出现其中一个词）才引用。 */
  requiresWesternContext?: string[];
};
const WEB_SCHEDULES = (webSchedulesJson as unknown as { entries: WebScheduleEntry[] }).entries;

/**
 * 教材该病证节没有单列频次时，用联网核对的 A/B 级来源补：国家/省级中医药管理局诊疗方案优先（A 级先于 B 级）。
 * 病名按名称与别名整词相等匹配；来源与等级写进卡片来源栏，医生看得到这条频次是谁说的。
 */
function webScheduleFor(
  modality: string,
  diseaseNames: readonly string[],
  context?: Pick<TextbookPlanInput, "westernNames" | "currentFacts" | "patientAgeYears">,
): { schedule: string; citation: string } | undefined {
  const wanted = new Set(diseaseNames.map(diseaseKey).filter(Boolean));
  if (wanted.size === 0) return undefined;
  const westernContext = context ? `${context.westernNames.join("；")}；${context.currentFacts}` : "";
  const hits = WEB_SCHEDULES.filter((entry) => entry.modality === modality &&
    [entry.disease, ...entry.aliases].flatMap((name) => name.split(/[\/、]/)).map((name) => diseaseKey(name.replace(/（[^）]*）/g, "")))
      .some((key) => key && wanted.has(key)))
    // 来源是某个西医病种专篇的频次（眩晕条目的出处是《高血压病》），只用于确有该病的病例：血压正常的眩晕不套高血压的疗程。
    .filter((entry) => !context || !entry.requiresWesternContext || entry.requiresWesternContext.some((term) => westernContext.includes(term)))
    // 老年人不套用留针超过 30 分钟的疗程（针刺量宜小、留针宜短，见 ELDERLY 说明）。
    .filter((entry) => !(context?.patientAgeYears != null && context.patientAgeYears >= ELDERLY_AGE_YEARS && /留针[^。；]{0,12}(?:小时|[4-9]\d\s*分钟|3[1-9]\s*分钟)/.test(entry.schedule)))
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
  // 教材分套写基本治疗的病：按本例证候只取对应的一套（见 pickBasicTreatmentVariant）。
  const variant = code === "acupuncture" ? pickBasicTreatmentVariant(primary, input) : undefined;
  if (code === "acupuncture") {
    base = { points: variant?.mainPoints || primary.mainPoints, content: variant?.therapy || primary.therapy, system: "body", line: primary.line, entry: primary };
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

  // 主穴按部位分组的病（痹病）：只取本例疼痛部位那几组，对不上部位时只留阿是穴。
  const regionalGroups = code === "acupuncture" ? REGIONAL_MAIN_POINT_GROUPS[base.entry.disease] : undefined;
  const regionalBase = regionalGroups
    ? (() => {
        const facts = input.currentFacts.normalize("NFKC");
        const matched = regionalGroups.filter((group) => group.cue.test(facts));
        const grouped = new Set(regionalGroups.flatMap((group) => group.points));
        const keep = new Set(matched.flatMap((group) => group.points));
        return base.points.filter((name) => !grouped.has(name) || keep.has(name));
      })()
    : base.points;
  const points: TextbookPlanPoint[] = regionalBase.map((name) => ({ name, role: "base_point" as const }));
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
      syndromeClause = `本例属${picked.map((item) => item.label).join("、")}，在主穴基础上加${picked.flatMap((item) => item.addPoints).join("、")}。`;
    }
    // 证型对不上教材的配穴表时只给主穴，不把各证型的配穴整张表列给医生自己挑（2026-10-13，甲方 10.12 测评 5.1/5.2）。
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
    if (symptomParts.length > 0) syndromeClause += `随症配穴：${symptomParts.join("；")}。`;
  }

  // 神阙、乳中禁针（神阙只灸）：教材在针灸方案里把神阙列为灸穴，拍平后混进了针刺取穴（2026-10-13 独立评审）。
  const needleable = code === "acupuncture" ? points.filter((point) => !NO_NEEDLE_POINTS.has(point.name)) : points;
  const finalPoints = needleable.slice(0, POINT_LIMIT);
  const citation = cite(base.entry);
  if (secondary && code === "acupuncture") cite(secondary);
  const projectName = code === "acupuncture" ? "针刺" : "";
  // 没有按本例证型配穴时，教材写在基本处方前面的那句治法是按病、不是按本例证候定的（血虚肝旺的瘙痒写「疏风清热，润燥止痒」），
  // 与辨证结论对不上：只保留「取某经穴为主」的取穴说明，并写明是按病取的基本穴。
  const acupunctureTherapy = base.content.replace(/[。]+$/, "");
  const meridianSentence = acupunctureTherapy.split("。").map((part) => part.trim()).filter((part) => /^取/.test(part)).join("。");
  const contentHead = code === "acupuncture"
    ? tailored || variant || !meridianSentence
      ? `治法：${cutText(acupunctureTherapy, 80)}。`
      : `按病取基本穴（本例证型在教材中没有对应的配穴）：${cutText(meridianSentence, 70)}。`
    : `${projectName}${cutText(base.content, 240)}`;
  const variantOperation = variant?.operation || primary.operation;
  const operation = code === "acupuncture" ? variantOperation : base.content;
  // 其他疗法不借针刺的操作句：此前耳穴、拔罐卡的疗程栏里出现「外感咳嗽针用泻法，肺俞可配闪罐」（2026-10-14 独立评审）。
  const frequency = frequencySentence(withSyndromeMatchedClauses(operation, input)) ||
    (code === "acupuncture" ? frequencySentence(withSyndromeMatchedClauses(primary.operation, input)) : "");
  const defaultKey = code === "acupuncture" ? "acupuncture" : code === "cupping" ? "cupping" : code === "moxibustion" ? "moxibustion" : "";
  const defaultText = defaultKey ? data.modalityDefaults[defaultKey]?.text || "" : "";
  const defaultClause = defaultText ? `${defaultText.replace(/[。]+$/, "")}（《刺法灸法学》总论）。` : "";
  const web = frequency ? undefined : webScheduleFor(code, input.diseaseNames, input);
  const schedule = frequency
    ? `${frequency}${defaultClause ? ` ${defaultClause}` : ""}`
    : web
      ? `${web.schedule}。${defaultClause}`
      : defaultClause
        ? `${defaultClause}间隔与疗程按病情和耐受确定。`
        : "间隔与疗程按病情和耐受确定。";
  const technique = withoutBloodlettingWhenUnsuitable(withSyndromeMatchedClauses(code === "acupuncture"
    ? cutText(variantOperation || "毫针常规针刺。", 420)
    : cutText(`${base.content}`, 420), input), input) || "穴位常规刺。";

  return {
    kind: "acupoint",
    treatmentContent: cutText(`${contentHead}${syndromeClause}`, 1150),
    points: finalPoints,
    items: [],
    scheduleSuggestion: cutText(schedule, 560),
    // 「补泻手法、进针深度」只对用针的项目成立（拔罐、灸法卡上也挂着这句——2026-10-14 复核时发现）。
    techniqueBoundary: cutText(`${technique} ${techniqueContraindications(code)}${code === "acupuncture" || code === "auricular" ? "补泻手法、进针深度以现场查体为准。" : ""}`.trim(), 980),
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
      `治则：${(entry.principle.split("。")[0] || entry.principle).trim().replace(/[“”"]/g, "")}。手法：${uniq(entry.manipulations).slice(0, 8).join("、") || "见操作"}。${modification ? `本例证候与教材「${modification.label}」相符：${cutText(modification.content, 200)}` : ""}`,
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
  const format = (syndrome: DietSyndrome, recipe: DietRecipe) =>
    cutText(`${syndrome.label}：${recipe.name}${recipe.classicSource ? `（${recipe.classicSource}）` : ""}：${recipe.text}`, 200);
  // 证型对不上教材的食疗分型就不出食疗（2026-10-13，甲方 10.12 测评 5.1：心虚胆怯证给出了「气阴两虚」的食疗方，
  // 对不上时又把各证型的方子整张列出来）。对得上时只给一个方子：方名、配料与做法都是教材原文。
  const matched = entry.syndromes.filter((syndrome) => safeRecipes(syndrome).length > 0)
    .find((syndrome) => syndromeLabelMatchesSigned(syndrome.label, input.signedSyndromeText));
  if (!matched) return undefined;
  const first = safeRecipes(matched)[0];
  const items = [format(matched, first)];
  const usage = frequencySentence(first.text) || first.text.split("。").find((part) => part.includes("每日") || part.includes("每天")) || "";
  const dietHead = matched.method ? `食疗原则：${matched.method.replace(/[。]+$/, "")}。` : "";
  return {
    kind: "diet",
    // 食疗方进 treatmentContent（无穴项目的 suggestedSitesOrPoints 保持为空，与目录口径一致；
    // 「取穴」「穴位/部位」这类栏目对食疗没有意义，2026-09-29 甲方测评点名）。整条放不下就整条不放，绝不截断食谱。
    treatmentContent: contentWithItems(dietHead, items),
    points: [],
    items,
    scheduleSuggestion: cutText(usage ? `${usage.replace(/[。]+$/, "")}。` : "随三餐食用，复诊时按症状变化调整。", 560),
    techniqueBoundary: "仅作饮食调养，不替代药物治疗；对方中食材过敏者不用，糖尿病、慢性肾病、孕期哺乳期及正在服用抗凝药者请先咨询医生。",
    protocolSource: cutText(bookCitation(data, "shiliao", entry.disease, entry.line), 980),
    syndromeLabels: [matched.label],
    syndromeTailored: true,
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
