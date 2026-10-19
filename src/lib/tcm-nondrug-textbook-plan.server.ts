import { readFileSync } from "node:fs";
import path from "node:path";
import webSourcesJson from "../data/tcm-nondrug-web-sources.source.json" with { type: "json" };
import webSchedulesJson from "../data/tcm-nondrug-web-schedules.source.json" with { type: "json" };
import syndromeConceptsJson from "../data/tcm-syndrome-label-concepts.source.json" with { type: "json" };
import natureLexiconJson from "../data/tcm-nature-lexicon.json" with { type: "json" };
import { resolveTcmDiseaseName } from "./clinical-terminology";
import { formulaAnalysisHerbMentions } from "./formula-analysis-review";
import { findTcmHerbPairCautions, findTcmHerbPairIncompatibilities, getTcmHerbDoseLimit, getTcmHerbFunctionCategories, getTcmHerbGenerationSafetyProfile } from "./tcm-knowledge";
import { TCM_ACUPOINTS } from "./tcm-acupoints";
import { herbRecordCautionConflict } from "./herb-record-caution";
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
/** alias = 教材证型名后括注的又名（「行痹（风痹）」），证名本身不带病性字时用它比对。 */
type AcupunctureSyndrome = { label: string; alias?: string; keySymptoms?: string; addPoints: string[]; line?: number | null };
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
  /** 本例当前事实：专节也可按教材给专节下的定义表现认（PRESENTATION_SECTIONS），不只按西医诊断名。 */
  currentFacts = "",
): T[] {
  // 字面相符的节优先，国标归一后才相符的节只在没有字面相符时用（2026-10-19）：GB/T 15657 把「不育症」也归到「不孕」，
  // 此前女性不孕症病例拿到的是男子「不育症」节的治法与取穴（验收集 M-TCM-SD-449314、H-tri-6870）。
  const literalWanted = new Set(diseaseNames.map((name) => diseaseKey(name)).filter(Boolean));
  const literal = list.filter((entry) => entryKeys(entry).some((key) => literalWanted.has(diseaseKey(key))));
  const wanted = new Set(diseaseNames.flatMap((name) => [diseaseKey(name), canonicalDisease(name)]).filter(Boolean));
  const exact = literal.length > 0 ? literal : list.filter((entry) => entryKeys(entry).some((key) =>
    wanted.has(diseaseKey(key)) || wanted.has(canonicalDisease(key))));
  const westernCores = westernNames.map(westernNameCore).filter((name) => name.length >= 2);
  const westernForms = [...new Set([...westernNames.map((name) => compact(name)), ...westernCores])].filter((name) => name.length >= 2 && !name.includes("中枢"));
  if (exact.length > 0) {
    // 教材对这一类病另有专节、西医诊断点名了专节时用专节（SPECIFIC_SECTIONS，闭集）。
    const allowed = new Set(exact.flatMap((entry) => SPECIFIC_SECTIONS[entry.disease] || []));
    const specific = allowed.size === 0 ? [] : list.filter((entry) => allowed.has(entry.disease) &&
      entryKeys(entry).some((key) => { const k = compact(key); return k.length >= 2 && westernForms.some((name) => name.includes(k)); }));
    if (specific.length > 0) return specific;
    const presented = allowed.size === 0 ? [] : list.filter((entry) => allowed.has(entry.disease) &&
      PRESENTATION_SECTIONS.some((rule) => rule.section === entry.disease && rule.presents(currentFacts, westernNames)));
    return presented.length > 0 ? presented : exact;
  }
  // 中医病名对不上教材节时，用签名的西医诊断名对教材「西医学…属本病范畴」的范围，或对节名/又名（去掉急慢性、左右侧、待查后）；
  // 只认整词相等，不做子串。
  const western = new Set(westernNames.map((name) => compact(name)).filter((name) => name.length >= 3));
  if (western.size === 0 && westernCores.length === 0) return [];
  return list.filter((entry) => (entry.westernScope || "").split(/[、,，]/).some((part) => western.has(compact(part))) ||
    entryKeys(entry).some((key) => { const k = compact(key); return k.length >= 3 && westernCores.includes(k); }));
}

/**
 * 教材对这一类病另有专节时，西医诊断点名的专节优先于类目节（2026-10-19，r1019 验收集）：
 * 痹证 + 坐骨神经痛的针刺卡只有「阿是穴」（痹病节按关节部位分组，下肢后侧放射痛对不上任何一组），
 * 痹证 + 神经根型颈椎病拿到「脊背」组的腰阳关；周围性面瘫被写成中风时拿到醒脑开窍的水沟、极泉。
 * 键 = 中医病名对上的教材节，值 = 教材里该类病之下另立的专节（《针灸治疗学》《针灸学》节名）。闭集：
 * 只收「同一类病的部位或类型专节」，不收两个不同的病（眩晕与不寐、牙痛与面痛各是一病，不在此列）。
 * 腰痛不在此列：腰痛节自有瘀血（闪挫）腰痛的配穴，换到急性腰扭伤节反而丢了按证型配穴。
 */
const SPECIFIC_SECTIONS: Readonly<Record<string, readonly string[]>> = {
  痹病: ["坐骨神经痛", "颈椎病", "项痹", "漏肩风", "肩痹", "膝骨性关节炎", "肘劳", "腱鞘炎", "落枕", "急性腰扭伤", "踝关节扭伤", "急性踝关节扭伤", "痛风"],
  痹证: ["坐骨神经痛", "颈椎病", "项痹", "漏肩风", "肩痹", "膝骨性关节炎", "肘劳", "腱鞘炎", "落枕", "急性腰扭伤", "踝关节扭伤", "急性踝关节扭伤", "痛风"],
  中风: ["面瘫"],
};

/**
 * 专节按教材给它下的定义表现认（2026-10-19 Claude 评审，西医诊断名没写专节名时）：
 *  · 坐骨神经痛：《针灸治疗学》「沿坐骨神经通路及其分布区内（臀部、大腿后侧、小腿后外侧和足外侧）以放射性疼痛为主要特点」。
 *    病历写疼痛（或麻）从腰、臀放射、牵扯、窜到腿、小腿、足——痹证病例只拿到痹病节的腰骶组与阿是穴（H-tri-3751「疼痛从腰部放射至小腿外侧」，
 *    X-H-0398「沿右侧臀部向右大腿后外侧、右小腿外侧…放射性痛麻」）。
 *  · 落枕：《针灸治疗学》「急性单纯性颈项强痛，活动受限」，多因睡姿或感受风寒。西医诊断写急性的颈部肌肉病（急性颈肌劳损、急性颈肌筋膜炎）
 *    时用落枕节（X-H-0171、X-H-0230 拿到痹病节「脊背」组的大杼、身柱，没有天柱、后溪、外劳宫）。只凭病历「晨起颈痛」不换节。
 * 部位词、方向词是有限闭集。
 */
const PRESENTATION_SECTIONS: ReadonlyArray<{ section: string; presents: (facts: string, westernNames: readonly string[]) => boolean }> = [
  {
    section: "坐骨神经痛",
    // 同一句里先写腰或臀、后写大腿、小腿、腘、足，并写到放射、牵扯、窜（「沿右侧臀部向右大腿后外侧、右小腿外侧…放射性痛麻」）。
    // 放射词所在小句写「无、未、不伴、否认」的不算（「不伴下肢放射痛」在肯定句里仍留着）。
    presents: (facts) => String(facts || "").normalize("NFKC").split(/[。；;\n]/u).some((sentence) => {
      const trunk = sentence.search(/腰|臀/u);
      const leg = sentence.slice(Math.max(trunk, 0)).search(/大腿|小腿|腘|足|下肢/u);
      return trunk >= 0 && leg > 0 && sentence.split(/[，,]/u).some((clause) =>
        /放射|牵扯|牵涉|牵掣|窜|串/u.test(clause) && !/无|未|没有|不伴|否认/u.test(clause));
    }),
  },
  {
    section: "落枕",
    presents: (_facts, westernNames) => westernNames.some((name) => /急性/u.test(name) && /颈/u.test(name) && /肌|筋膜|扭伤|劳损|痉挛/u.test(name)),
  },
];

/** 西医诊断名去掉急慢性、左右侧与待查字样后的主干（只用于和教材节名、又名比对）。 */
function westernNameCore(name: string): string {
  return compact(name)
    .replace(/^(?:急性|慢性|亚急性)/u, "")
    .replace(/(?:左侧|右侧|双侧)/gu, "")
    .replace(/^[左右双]/u, "")
    .replace(/(?:待查|待排)$/u, "")
    // 「膝关节骨关节炎」即教材节名又名「膝骨关节炎」（2026-10-19 Claude 评审 M-TCMChat-test-336：膝痹病例对不上膝骨性关节炎节，
    // 针刺卡只剩「局部阿是穴、循经远端穴」）。
    .replace(/^(膝|髋|肩|踝|肘|腕)关节(?=骨)/u, "$1");
}

type ConceptRule = { id: string; terms: string[]; covers?: string[] };
const CONCEPTS = syndromeConceptsJson as { organs: ConceptRule[]; natures: ConceptRule[] };

function syndromeConcepts(label: string): { organs: Set<string>; natures: Set<string> } {
  // 「阳气虚衰」「阳气不足」是阳虚，不因其中的「气虚」二字算气虚（2026-10-19 Claude 评审 H-tri-9278：颤证·气血亏虚证的针刺卡写
  //「本例属阳气虚衰，加关元、肾俞」——教材颤证节「阳气虚衰」被拆出气虚概念，与本例的气虚对上了）。
  const text = compact(label).replace(/证候$/, "").replace(/[证型]$/, "").replace(/阳气(?=虚|不足|亏)/gu, "阳")
    // 饮食停滞、饮食内停、饮食积滞、宿食都是食积（GB/T 16751.2 食积证的同义写法），不因「滞」字另算气滞（X-H-0240：胃痞·饮食内停证
    // 对不上目录胃肠模板的「饮食停滞」配穴）。
    .replace(/饮食(?:停滞|内停|积滞|停积)|宿食(?:停滞|内停)?|停食/gu, "食积");
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
function keySymptomText(keySymptoms: string | undefined): string {
  return compact(String(keySymptoms || "").split(/[，、；。：:]/)
    .filter((phrase) => !/^[舌脉苔]/.test(compact(phrase))).join(""));
}
function keySymptomGrams(keySymptoms: string | undefined): Set<string> {
  const text = keySymptomText(keySymptoms);
  const grams = new Set<string>();
  for (let index = 0; index + 2 <= text.length; index += 1) grams.add(text.slice(index, index + 2));
  return grams;
}
/**
 * 同一教材节里两个以上证型的辨证要点都有的二字组（「小便」之于六淋，「关节」「局部」「恶风」之于痹病四型）：那是本病的共同表现，
 * 不是这一型的证据（2026-10-19 Claude 评审：石淋病历「小便艰涩」因「小便」二字被当作热淋的证据，H-tri-796；颈项痛「恶风畏寒」因「恶风」
 * 被当作行痹（疼痛游走）的证据，X-H-0171；肩痛「局部无红肿」「关节」被当作痛痹、着痹的证据，H-tri-10170）。
 */
function sharedKeySymptomGrams(syndromes: ReadonlyArray<{ keySymptoms?: string }>): Set<string> {
  const count = new Map<string, number>();
  for (const syndrome of syndromes) for (const gram of keySymptomGrams(syndrome.keySymptoms)) count.set(gram, (count.get(gram) || 0) + 1);
  return new Set([...count].filter(([, n]) => n >= 2).map(([gram]) => gram));
}
function syndromeEvidencePresent(keySymptoms: string | undefined, currentFacts: string, sharedGrams?: ReadonlySet<string>, minGrams = 1): boolean {
  const facts = compact(currentFacts);
  if (!facts) return false;
  const text = keySymptomText(keySymptoms);
  if (text.length < 2) return true;
  // 教材辨证要点是叙述句（「风团色红，灼热剧痒，遇热加重」），病历写法各异：按二字组比对，
  // 扣掉「疼痛/加重/发作」这类任何病都有的泛词，至少共有一个症状二字组（且本例有病历事实）才算有证据；证型相符本身已由已签名证候名判定，这里只防「证名撞上、病历却毫无相关表现」。
  // 同节各型共有的二字组也扣掉（sharedKeySymptomGrams）：它分不出是哪一型。
  const generic = new Set("疼痛,加重,不适,发作,反复,伴有,兼见,可见,时作,时止,持续,明显,症状,或者".split(","));
  const shared = new Set<string>();
  for (let index = 0; index + 2 <= text.length; index += 1) {
    const gram = text.slice(index, index + 2);
    if (!generic.has(gram) && !sharedGrams?.has(gram) && facts.includes(gram)) shared.add(gram);
  }
  return shared.size >= minGrams;
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
function scoringLabel(item: { label: string; alias?: string; keySymptoms?: string }): string {
  if (syndromeConcepts(item.label).natures.size > 0) return item.label;
  if (item.alias && syndromeConcepts(item.alias).natures.size > 0) return item.alias;
  return String(item.keySymptoms || "").match(/为([一-龥]{2,8})[。]?$/)?.[1] || item.label;
}

/**
 * 卡片上「本例属X」「按X取穴」的 X 与已签名证候（主证＋兼证结论）是否相符：概念全部在本例证候里（syndromeMatchScore），
 * 或证名字面相同/包含（syndromeLabelMatchesSigned）。院内目录的证型配穴按病机叙述命中时也要过这一道（tcm-treatment-capabilities）。
 */
export function syndromeLabelFitsSigned(label: string, signedSyndromeText: string): boolean {
  if (!label || !String(signedSyndromeText || "").trim()) return false;
  return syndromeMatchScore(label, signedSyndromeText).score > 0 || syndromeLabelMatchesSigned(label, signedSyndromeText);
}

/** 已签名主证（「主证；兼证…」的第一段）去掉「证/型」与括注后的写法，用于与教材证型名比是否同名。 */
function signedPrimaryCore(signedSyndromeText: string): string {
  return (String(signedSyndromeText || "").split(/[；;]/)[0] || "").normalize("NFKC")
    .replace(/[\s（()）]/g, "").replace(/(?:证候|证型|证|型)$/u, "");
}

/** 证名里没有病性字的教材证型（淋证「石淋」「膏淋」）按概念对不上，已签名证名与它字面相同时按它取（2026-10-19 留出例 S067 石淋没加秩边、水道、委阳）。 */
const LITERAL_SYNDROME_SCORE = 100;

/**
 * 已签名的辨病/辨证依据里肯定地写到了本节的哪一型（2026-10-19 晚，留出例 S067：病名「淋证」、证名「湿热蕴结证」，辨证依据「…故属石淋湿热蕴结证」，
 * 针刺卡却写「本例属热淋，加委中、行间」——证名里的「热」按概念对上了热淋）。教材同节分「型」的病（淋证六淋、癃闭…），型写在依据里，
 * 病名与证名往往只写到病与病性。构词式守卫（有限闭集）：型名紧跟在「属/为/即/归为/诊为/辨为」之后（中间不隔字：「为风寒之邪袭于太阳经输」是病机叙述，不是下型；
 * 回放 H 集 X-H-0230 痛痹被换成「太阳经证」），且这个动词前面不是不/非/未/无——「与热淋相鉴别」「非热淋」「不属热淋」不算肯定。
 */
const AFFIRMING_TYPE_LEAD = /(?<![不非未无])(?:属于?|为|即|归为|诊为|辨为|当为)$/u;
export function affirmedSectionTypes<T extends { label: string; alias?: string }>(types: readonly T[], rationale: string): T[] {
  const text = String(rationale || "").normalize("NFKC");
  if (!text.trim()) return [];
  const coreOf = (value: string) => value.replace(/[\s（()）]/g, "").replace(/(?:证候|证型|证|型)$/u, "");
  // 只认「证名里没有病性字」的型（石淋、膏淋…，pickSyndromes 里的 literal 型）：这类型按概念永远对不上，只能字面取，依据里写明才算数。
  // 带病性概念的型（热淋、肾气不足、暑湿…）本来就按已签名证名的概念取；依据里「…为肾气不足、膀胱失约」那样的病机叙述不是下型，不能拿来换证名。
  // （首版不分这一点，回放 1050 例有 25 张卡的型被依据里的病机词换掉，遗尿·下元虚寒证写成「本例属肾气不足」。）
  return types.filter((type) => syndromeConcepts(type.label).natures.size === 0 &&
    [type.label, type.alias || ""].map(coreOf).filter((core) => core.length >= 2).some((core) => {
    for (let at = text.indexOf(core); at >= 0; at = text.indexOf(core, at + 1)) {
      if (AFFIRMING_TYPE_LEAD.test(text.slice(Math.max(0, at - 12), at))) return true;
    }
    return false;
  }));
}

function pickSyndromes<T extends { label: string; alias?: string; keySymptoms?: string; sharedGrams?: ReadonlySet<string> }>(
  candidates: readonly T[],
  caseSyndromeText: string,
  currentFacts: string,
  diseaseNames: readonly string[] = [],
  /** 已签名依据里写明的型（见 affirmedSectionTypes）：allTypes 是本节全部的型（含没有配穴的），rationale 是依据原文。 */
  affirmedFrom?: { allTypes: readonly { label: string; alias?: string }[]; rationale: string },
): T[] {
  const picked = pickSyndromesByConcept(candidates, caseSyndromeText, currentFacts, diseaseNames);
  if (!affirmedFrom || compact(currentFacts).length === 0) return picked;
  const affirmed = affirmedSectionTypes(affirmedFrom.allTypes, affirmedFrom.rationale);
  if (affirmed.length === 0) return picked;
  const isAffirmed = (item: T) => affirmed.some((type) => type.label === item.label);
  // 按概念挑的型与依据写明的型一致：不动（含主证之外再挑的兼证一型）。
  if (picked.some(isAffirmed)) return picked;
  // 挑中的型本来就是已签名的证名/病名点到的（肾气亏虚证之于「肾气亏虚」，依据里泛泛写的「属虚证」不能把它换掉）：不动。
  // 只换「仅凭证名里一个病性字对上」的型（湿热蕴结证的「热」之于热淋）。
  if (picked.some((item) => syndromeLabelMatchesSigned(item.label, caseSyndromeText) ||
    diseaseNames.some((name) => syndromeLabelMatchesSigned(item.label, name)))) return picked;
  // 依据写明的型有教材配穴时以它为准；那一型没有配穴时保持原挑选，不新增断言。
  const own = candidates.find(isAffirmed);
  return own ? [own] : picked;
}

function pickSyndromesByConcept<T extends { label: string; alias?: string; keySymptoms?: string; sharedGrams?: ReadonlySet<string> }>(
  candidates: readonly T[],
  caseSyndromeText: string,
  currentFacts: string,
  diseaseNames: readonly string[] = [],
): T[] {
  // 教材按类型分的证（淋证「热淋 / 石淋 / 血淋…」）里，已签名的病名就是其中一型（病名「石淋」）：本例就属这一型，不再按证候概念
  // 另挑同节别的类型（2026-10-19 Claude 评审 H-tri-796：石淋·湿热蕴结证因「热」对上热淋，卡写「本例属热淋，加委中、行间」，
  // 没有石淋的秩边、水道、委阳）。
  const diseaseCores = new Set(diseaseNames.map(signedPrimaryCore).filter((core) => core.length >= 2));
  const diseaseType = candidates.find((item) => [item.label, item.alias || ""].some((name) => diseaseCores.has(signedPrimaryCore(name))));
  if (diseaseType && compact(currentFacts).length > 0) return [diseaseType];
  // 本例主证名与教材证型名（或其括注又名）相同：证型就是已签名的结论，不再要求病历里有该型辨证要点的同字二字组
  //（2026-10-19 M-TCMChat-test-438：痛痹，病历写「受凉后疼痛加重」，教材写「遇寒痛增」，二字组对不上，卡片退回目录模板的「瘀血阻络」配穴）。
  // 没有病历事实时照旧一律不按证型加减（fail-closed，见 syndromeEvidencePresent）。
  const primaryCore = signedPrimaryCore(caseSyndromeText);
  const isPrimary = (item: T) => primaryCore.length >= 2 && compact(currentFacts).length > 0 &&
    [item.label, (item as { alias?: string }).alias || ""].some((name) => signedPrimaryCore(name) === primaryCore);
  // 教材注明「属危急之候」、或辨证要点写神昏的证型（丹毒「火毒内陷」、中风「闭证」）只在已签名证候逐字写到它时取：
  // 门诊出卡的病人不在危急状态（那时安全门判红旗、不出卡），按概念对上会把风热毒蕴的面部丹毒写成「本例属火毒内陷，加十宣、十二井穴」
  //（2026-10-19 Claude 评审 H-tri-17402）。两本教材同名证型有一本这样写即算（《针灸学》丹毒节的火毒内陷没写辨证要点）。
  const acuteLabels = new Set(candidates.filter((item) => /危急|危候|急危|神昏/u.test(item.keySymptoms || "")).map((item) => item.label));
  const matched = candidates
    .map((item, index) => {
      const acuteOnly = acuteLabels.has(item.label);
      const concept = acuteOnly ? { score: 0, natures: new Set<string>() } : syndromeMatchScore(scoringLabel(item), caseSyndromeText);
      const literal = concept.score === 0 && (acuteOnly || syndromeConcepts(item.label).natures.size === 0) &&
        syndromeLabelMatchesSigned(item.label, caseSyndromeText);
      return { item, index, literal, ...(literal ? { score: LITERAL_SYNDROME_SCORE, natures: new Set<string>([`literal:${item.label}`]) } : concept) };
    })
    .filter((entry) => entry.score > 0);
  // 已签名证候按概念同时对上同节几个类型、且不分高下时（「风寒湿痹」对行痹、痛痹、着痹各一个病性），证名定不了是哪一型，
  // 要病历写出这一型自己的表现：同节各型共有的字样（恶风、关节、局部…）不算证据（sharedKeySymptomGrams）。证名只对上一型时
  //（风热犯表证 → 风热证）照旧，那时「发热、咳嗽」这类共有症状也算有相关表现。
  const topScore = Math.max(0, ...matched.filter((entry) => !entry.literal).map((entry) => entry.score));
  // 两本教材同一证型（风热证 / 风热感冒）病性相同，不算几型；一型的病性包含另一型（气滞痰凝 ⊃ 肝郁气滞的气滞）也不算——
  // 只有病性互不包含的几型（行痹的风、痛痹的寒、着痹的湿）同时对上，才是证名定不了型。
  const top = matched.filter((entry) => !entry.literal && entry.score === topScore).map((entry) => [...entry.natures]);
  const within = (left: string[], right: string[]) => left.every((nature) => right.includes(nature));
  const ambiguous = top.some((left, index) => top.slice(index + 1).some((right) => !within(left, right) && !within(right, left)));
  const scored = matched
    .filter((entry) => isPrimary(entry.item) ||
      // 定型要两处以上本型自己的表现：一个二字组常是拼出来的（「疼痛较前缓解」的「痛较」对上痛痹「疼痛较剧」，H-tri-10170）。
      (ambiguous && !entry.literal
        ? syndromeEvidencePresent(entry.item.keySymptoms, currentFacts, entry.item.sharedGrams, 2)
        : syndromeEvidencePresent(entry.item.keySymptoms, currentFacts)))
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

/** 说治疗频次的小句（每日/隔日…若干次）：疗程栏只放这几小句，操作栏不再重印（acupointPlan）。 */
function isFrequencyClause(clause: string): boolean {
  return /每日|每天|隔日|每周|一日|每隔/u.test(clause) && /\d/u.test(clause) && clause.includes("次");
}

function frequencySentence(text: string): string {
  // 频次词是有限闭集（每日/每天/隔日/每周…），不是临床语义词表。
  const anchor = new RegExp(["每日", "每天", "隔日", "每周", "一日", "每隔"].join("|"));
  for (const sentence of String(text || "").split(/[。；;]/)) {
    if (anchor.test(sentence) && /\d/.test(sentence) && sentence.includes("次")) return `${sentence.trim()}。`;
  }
  return "";
}

/**
 * 卡片已有本项目自己的时长写法（留针、留罐、施灸的分钟数或壮数）：总论的通用时长不再并列（acupointPlan）。
 * 只认带数字的写法；「久留针」「不宜久留针」这类没有数字的说法不算。
 */
export function cardStatesDuration(code: string, text: string): boolean {
  const value = String(text || "").normalize("NFKC");
  if (code === "acupuncture") return /留针[^。；;，,]{0,8}\d/u.test(value);
  if (code === "cupping") return /留罐[^。；;，,]{0,8}\d/u.test(value);
  if (code === "moxibustion") return /灸[^。；;，,]{0,10}\d+(?:\.\d+)?\s*(?:[～~\-－至]\s*\d+(?:\.\d+)?\s*)?(?:分钟|壮)|\d+\s*(?:[～~\-－至]\s*\d+\s*)?壮/u.test(value);
  return false;
}

// ─── 药食同源 ────────────────────────────────────────────────────────────────

type WebSources = {
  foodMedicineHomology: { items: Array<{ name: string; listedAs?: string }>; restrictedUse: Array<{ name: string; restriction: string }> };
  commonFoodAllowlist: string[];
  daoyinRoutines: Array<{ routine: string; movements: string[]; movementEffects?: Array<{ movement: string; effect: string; sourceId: string }> }>;
  conditionDaoyin: Array<{ condition: string; method: string; movement: string; frequency: string; sourceIds: string[]; notes?: string }>;
  techniqueSafety: Array<{ technique: string; contraindications: string }>;
  /** 教材明文的食物—药物同用禁忌（相恶、药食同用禁忌）；十八反、十九畏走知识库配伍规则，不在这里。 */
  dietHerbAntagonism: { items: Array<{ herb: string; foods: string[]; foodExclusions?: string[]; relation: string }> };
};
const WEB = webSourcesJson as unknown as WebSources;

let homologyNames: Set<string> | undefined;

/** 药食同源目录里的物质（目录写法与常见别名都认；限制使用的不算）。 */
export function isFoodMedicineHomologyItem(name: string): boolean {
  return homologySet().has(String(name || "").trim());
}

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
    ["桂圆", "龙眼肉"], ["陈皮", "橘皮"], ["橘红", "桔红"], ["苦杏仁", "杏仁"], ["甜杏仁", "杏仁"], ["银花", "金银花"], ["熟地黄", "地黄"], ["生地黄", "地黄"],
    // 薯蓣即山药（《神农本草经》名，教材食谱原文「生薯蓣（山药）」，2026-10-19 甲方病历 5 脾气虚的薯蓣拨粥因此被当成非药食同源药材）。
    ["薯蓣", "山药"], ["生薯蓣", "山药"], ["生山药", "山药"]];
  for (const [alias, base] of bridges) if (names.has(base)) names.add(alias);
  for (const restricted of WEB.foodMedicineHomology.restrictedUse) names.delete(restricted.name);
  homologyNames = names;
  return names;
}

function commonFoods(): Set<string> {
  // 「白面粉」即面粉（食谱写法，同上）。
  const foods = new Set(WEB.commonFoodAllowlist);
  if (foods.has("面粉")) foods.add("白面粉");
  return foods;
}

/**
 * 食疗方里高风险药材的用量超过药典上限（2026-10-19，验收集 M-TCM-RobustSDT-single_0214：瘀血腰痛的「葱耳蒜粥」写
 * 桃仁15～30g，药典用量 5～10g、孕妇慎用，同页汤药里还有桃仁 9g）。只看知识库标为有毒或孕期高风险（HIGH）的药材：
 * 山药、薏苡仁这类食材在食疗里本来就按食物量用，不按药典煎剂量卡。
 */
/**
 * 2026-10-19（Claude 评审 M-TCM-BEST4SDT-254：寒湿腰痛的「二姜茶」高良姜 15g，药典 3～6g，同页汤药里还有附子）：
 * 药典用量上限不超过 10 g 的辛香、峻烈之品（高良姜、肉桂、丁香、小茴香、白芷、桔梗、薄荷、荷叶…，药典把它们的煎服量定得小），
 * 在按日服用的食疗方里同样不超过药典上限；超了就不选这一方。山药、百合、莲子、薏苡仁这类药典上限在 10 g 以上、本来按食物量吃的不卡；
 * 生姜、干姜、花椒这类作调料的普通食物（目录 commonFoodAllowlist）不卡。整料制成膏、粉、酒、按「每次服若干」分次吃的（桑椹蜜膏、
 * 天麻菊花枸杞粉、加味大豆酒），方里写的是整料用量，不按单日量比。
 */
const SMALL_DOSE_HERB_MAX_G = 10;
const BATCH_RECIPE = /每(?:次|服)(?:服|食|取|用|饮)?\s*\d+(?:\.\d+)?\s*(?:[～~\-－至]\s*\d+(?:\.\d+)?\s*)?(?:g|克|ml|mL|毫升)|每次\s*\d*\s*(?:汤匙|匙|勺|茶匙|调羹)|装瓶|贮存|贮藏|密封\s*\d+\s*[日天]|蒸馏/u;
export function recipeExceedsHighRiskHerbDose(recipeText: string): boolean {
  const ingredientSentence = String(recipeText || "").split("。")[0] || "";
  const batch = BATCH_RECIPE.test(String(recipeText || ""));
  for (const mention of formulaAnalysisHerbMentions(ingredientSentence)) {
    const profile = getTcmHerbGenerationSafetyProfile(mention.token);
    const highRisk = profile.isToxic || profile.populationRules.some((rule) => /孕/.test(rule.population) && rule.severity === "HIGH");
    const max = getTcmHerbDoseLimit(mention.token)?.max;
    const smallDose = !batch && max != null && max <= SMALL_DOSE_HERB_MAX_G && !commonFoods().has(mention.token);
    if (!highRisk && !smallDose) continue;
    const amount = ingredientSentence.slice(mention.end).match(/^\s*(\d+(?:\.\d+)?)\s*(?:[～~\-－至]\s*(\d+(?:\.\d+)?))?\s*(?:g|克)/u);
    if (!amount || max == null) continue;
    if (Number(amount[2] ?? amount[1]) > max) return true;
  }
  return false;
}

/**
 * 病历记有糖尿病（消渴）时不选的食疗方（2026-10-19 Claude 评审 M-TCMChat-test-405：空腹血糖 13 的糖尿病人拿到「葛根粉粥」，粳米 100g 早晚服；
 * 另有蜂蜜、冰糖入方的）。依据《成人糖尿病食养指南（2023年版）》（国卫办食品函〔2023〕5号）：原则三「主食定量，不宜过多，多选全谷物和低 GI 食物」，
 * 附录 1 表 1.1「即食大米粥」「大米饭、糯米饭」与糖果类「葡萄糖、麦芽糖、白糖、蜂蜜」均为高 GI；原则五「不喝含糖饮料」。
 *  · 方里有糖类（白糖、冰糖、红糖、砂糖、蜂蜜、饴糖、麦芽糖、葡萄糖）；
 *  · 精白米（粳米、大米、糯米）煮粥、作饭超过 30 g——指南自己的食谱示例里，粥饭中的精白米每份不超过 30 g（百合莲子粥「粳米 30g」、
 *    杂粮粥「大米 30g」）。
 * 大枣、山药等指南示例本身用到的食药物质不在此列。
 */
const DIABETES_SUGAR = /白糖|冰糖|红糖|砂糖|蜂蜜|蜜糖|饴糖|麦芽糖|葡萄糖/u;
const REFINED_RICE = /(粳米|大米|糯米|白米)\s*(\d+(?:\.\d+)?)\s*(?:g|克)/gu;
/** 方里的谷薯类主食（米、面、山药、薯、芋、粥饭）：糖尿病患者计入当餐主食量。 */
const DIABETES_STAPLE_FOOD = /米|面粉|面条|山药|薯|芋|粥|饭/u;
export function recipeUnsuitableForDiabetes(recipeText: string): boolean {
  const text = String(recipeText || "");
  const ingredientSentence = text.split("。")[0] || "";
  if (DIABETES_SUGAR.test(text)) return true;
  return [...ingredientSentence.matchAll(REFINED_RICE)].some((match) => Number(match[2]) > 30);
}

/** 饮食调护或注意事项写明忌茶、不宜饮茶时，方里有茶叶的食疗方不选（2026-10-19 Claude 评审 X-H-0163：注意事项「不宜喝茶」，食疗卡给姜茶饮（绿茶 10g））。 */
const TEA_LEAF_INGREDIENT = /茶叶|绿茶|红茶|花茶|普洱|乌龙茶/u;
export function dietAdviceAvoidsTea(text: string): boolean {
  // 并列写在一串忌口里的茶同样算（「服本方期间不宜同时服萝卜、浓茶」，2026-10-19 Claude 评审 X-H-0163：此前只看忌字后 4 个字，
  // 这一句没认出来，食疗卡仍给姜茶饮）。不跨逗号、句号。
  return /(?:忌|不宜|避免|勿|少|戒)(?:饮|喝|饮用)?[^。；;，,]{0,10}茶/u.test(String(text || "").replace(/代茶/gu, ""));
}

/**
 * 食疗方与本卡食疗原则方向相反时不出这一方（2026-10-19 留出例 S046：胃火上逆「食疗原则：清胃泻火，降逆止呃」下面给的是白扁豆粥，
 * 白扁豆《中药学》归补气药、甘微温、健脾化湿；教材同型下的白糖番茄不受影响）。判据用受治理的《中药学》功效分类
 *（getTcmHerbFunctionCategories，tcm-herb-function-categories.json），只看方里的药食同源物质；普通食物没有分类，不作判断：
 *  · 原则是清热、泻火、凉血、解毒（不带温）：方里有补气、补阳、补血、温里药不出；
 *  · 原则是温中、散寒、益气、健脾（不带清、不带养阴生津）：方里有清热类、泻下类药不出。
 */
const DIET_CLEARING_PRINCIPLE = /清[^，。；]{0,3}(?:热|火)|泻火|凉血|解毒|清胃|清肺|清肝|清心/u;
const DIET_WARMING_PRINCIPLE = /温|散寒|祛寒|助阳|益气|补气|健脾/u;
const DIET_YIN_PRINCIPLE = /阴|生津|润燥/u;
const DIET_WARM_TONIC_CATEGORY = new Set(["补气药", "补阳药", "补血药", "温里药"]);
const DIET_COOLING_CATEGORY = new Set(["清热药", "清热泻火药", "清热解毒药", "清热凉血药", "清热燥湿药", "泻下药", "攻下药", "峻下逐水药"]);
export function recipeContradictsDietPrinciple(recipeText: string, principle: string): boolean {
  const method = String(principle || "");
  const clearing = DIET_CLEARING_PRINCIPLE.test(method) && !/温/u.test(method);
  const warming = !clearing && DIET_WARMING_PRINCIPLE.test(method) && !/清/u.test(method) && !DIET_YIN_PRINCIPLE.test(method);
  if (!clearing && !warming) return false;
  const ingredientSentence = String(recipeText || "").split("。")[0] || "";
  return formulaAnalysisHerbMentions(ingredientSentence).some((mention) => getTcmHerbFunctionCategories(mention.token)
    .some((category) => (clearing ? DIET_WARM_TONIC_CATEGORY : DIET_COOLING_CATEGORY).has(category)));
}

/**
 * 饮食调护要求清淡、忌油腻、避免滋腻，而食疗方是猪肺、老鸭这类肥甘之品：同一页前后相反（2026-10-17 甲方标准病历 5「猪肺粥」对
 *「避免滋腻碍脾」，交付面把这张卡整张去掉；2026-10-19 起出卡时就从同型里换一个不肥甘的方子，病历 5 给黄芪黑豆汤）。
 * 两个判据与交付面（delivered-surface.ts）那一道同一写法，交付面可改为从这里取，免得两处各写各的。
 */
const DIET_ADVICE_AVOIDS_RICH_FOOD = /清淡|忌(?:食)?[^。；，,]{0,6}油腻|少(?:食|吃)[^。；，,]{0,4}油腻|避免[^。；，,]{0,4}滋腻|忌[^。；，,]{0,4}肥甘|少(?:食|吃)肥甘|不宜油腻/u;
// 油煎、油炸的做法同样是肥甘（2026-10-19 Claude 评审 H-tri-10297：饮食栏「少食肥甘厚腻」，食疗卡给「用花生油煎熟」的油煎毛蛋）。
const RICH_RECIPE_INGREDIENT_PATTERN = /猪(?!苓)|羊肉|牛肉|排骨|肥肉|蹄|鸭肉|老鸭|鹅|鸡汤|鸡肉|乌鸡|母鸡|油煎|油炸|油[^。，,；;]{0,3}(?:煎|炸)/u;
export function dietAdviceAvoidsRichFood(dietAdvice: string): boolean {
  return DIET_ADVICE_AVOIDS_RICH_FOOD.test(String(dietAdvice || ""));
}
export function recipeHasRichIngredient(recipeText: string): boolean {
  return RICH_RECIPE_INGREDIENT_PATTERN.test(String(recipeText || ""));
}

/**
 * 食品安全上不应推荐的食材（闭集）：毛蛋（孵化中途死亡的鸡胚）属《中华人民共和国食品安全法》第三十四条所禁「病死、毒死或者死因不明的禽、畜…
 * 及其制品」，各地市场监管部门多次提示勿食（2026-10-19 Claude 评审 H-tri-10297：头痛食疗卡给「油煎毛蛋（验方）」）。
 */
const FOOD_SAFETY_EXCLUDED_INGREDIENT = /毛蛋|死胎蛋|鸡胚/u;
/** 食谱是否只用国家「既是食品又是中药材」目录物质或普通食物。含任何其他药材（含仅作香辛料的当归）即整方不出。 */
export function recipeUsesOnlyFoodSafeIngredients(recipeText: string): boolean {
  if (FOOD_SAFETY_EXCLUDED_INGREDIENT.test(String(recipeText || ""))) return false;
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

/**
 * 食物与本次处方里的药味相冲（2026-10-19 晚，验收集 M-MTCMB-11：痰浊闭阻的食疗卡给「莱菔粥」〔莱菔子30g〕，同页汤药里有人参；
 * 《中药学》七情「相恶」的例子就是「人参恶莱菔子，莱菔子能削弱人参的补气作用」，《中医食疗学》药食同用禁忌另列人参与萝卜、茶叶）。
 * 两个来源，不新立药名表：
 *  · 十八反、十九畏：知识库的配伍规则（findTcmHerbPairIncompatibilities / findTcmHerbPairCautions），食疗方里的药食同源品
 *    （丁香、肉桂…）与处方药味逐对比；
 *  · 教材明文写出的食物—药物同用禁忌（tcm-nondrug-web-sources 的 dietHerbAntagonism，逐条带书名与行号；知识库里没有这几对）。
 * 饮食栏、食疗卡、食疗方选取共用这一组判据：饮食栏推荐萝卜、食疗卡给莱菔粥，对人参方都是同一个问题。
 */
export type PrescribedHerbScope = {
  /** 本次处方的药味名（原样，供知识库配伍规则按各自的别名解析）。 */
  names: readonly string[];
  /** 某味药（教材写法）是否在本次处方里（调用方按处方身份判定）。 */
  has: (herb: string) => boolean;
};

/** 本次处方里的药味在教材上与之相冲的食物写法（空表示没有）。 */
export function foodsAntagonizingPrescription(prescribed: PrescribedHerbScope | undefined): string[] {
  if (!prescribed) return [];
  return WEB.dietHerbAntagonism.items.filter((row) => prescribed.has(row.herb)).flatMap((row) => row.foods);
}

/** 文本里点到了该食物（同名异物先去掉：胡萝卜不是萝卜）。 */
export function textMentionsAntagonistFood(text: string, foods: readonly string[]): string | undefined {
  if (foods.length === 0) return undefined;
  let cleaned = String(text || "");
  for (const row of WEB.dietHerbAntagonism.items) for (const exclusion of row.foodExclusions || []) cleaned = cleaned.split(exclusion).join("");
  return foods.find((food) => cleaned.includes(food));
}

/** 一段文字（食疗卡的治疗内容、饮食建议的一个小句）里有没有与本次处方相冲的食物或药味。 */
export function textAntagonizesPrescription(text: string, prescribed: PrescribedHerbScope | undefined): boolean {
  if (!prescribed || prescribed.names.length === 0) return false;
  if (textMentionsAntagonistFood(text, foodsAntagonizingPrescription(prescribed))) return true;
  const own = [...new Set(prescribed.names.map((name) => String(name || "").trim()).filter(Boolean))];
  const ingredients = [...new Set(formulaAnalysisHerbMentions(String(text || "")).map((mention) => mention.token))]
    .filter((token) => !prescribed.has(token) && !own.includes(token));
  return ingredients.some((token) => own.some((herb) =>
    findTcmHerbPairIncompatibilities([token, herb]).length > 0 || findTcmHerbPairCautions([token, herb]).length > 0));
}

/** 食疗方：只看配料那一句（教材食谱第一句写配料与用量，后面是做法）。 */
export function recipeAntagonizesPrescription(recipeText: string, prescribed: PrescribedHerbScope | undefined): boolean {
  return textAntagonizesPrescription(String(recipeText || "").split("。")[0] || "", prescribed);
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
  /**
   * 已签名的辨病、辨证依据原文（overview.tcmDiseaseRationale + tcmDiagnosticRationale）。教材同节分「型」的病（淋证热淋/石淋/血淋…）
   * 里，病名只写到病（淋证）、证名只写病性（湿热蕴结证），型写在依据里（「故属石淋湿热蕴结证」）：针刺卡「本例属X」的 X 以它为准，
   * 不按证名里的「热」去对热淋（pickSyndromes / affirmedSectionTypes，2026-10-19 晚留出例 S067）。
   */
  signedRationale?: string;
  /** 患者年龄（岁）。老年人不列刺络放血、不套用长时间留针的疗程。 */
  patientAgeYears?: number;
  /** 已签名治则（M03 therapy.overallPrinciple，交付给医生的那一栏）。主证名判不出虚实时按它取舍（signedCardNature）。 */
  signedPrinciple?: string;
  /** 已签名治法（M03 therapy.overallMethod）。针刺卡按本例证型配了穴时，卡上的治法写它，不写教材本病的通用治法。 */
  signedMethod?: string;
  /** 主诉（教材分套的基本治疗按字面对套时用）。 */
  chiefComplaint?: string;
  /**
   * 院内目录已按本例证型命中、且已终审的证型配穴（目录模板的主穴只是「局部阿是穴（查体确认）」「循经远端穴（按疼痛部位选择）」
   * 这类延期说明时，由卡片汇总处传入）。教材本节没有本例证型时，在教材主穴上加这组配穴；教材有本例证型时不用它。
   */
  catalogSyndromeRefinement?: { label: string; addPoints: readonly string[]; removePoints?: readonly string[] };
  /** 本例饮食调护要求清淡、忌油腻或避免滋腻（dietAdviceAvoidsRichFood）：食疗方不选肥甘之品。 */
  avoidRichFood?: boolean;
  /** 本次处方里已有的药味（按处方身份判定，调用方给）：食疗方里有同一味药的不选，免得汤药与食疗叠加用量（病历 5 黄芪）。 */
  herbAlreadyPrescribed?: (herb: string) => boolean;
  /** 本次处方的药味名（原样）。食疗方里的食物与处方药味相冲的不选（recipeAntagonizesPrescription：十八反/十九畏 + 教材药食同用禁忌）。 */
  prescribedHerbNames?: readonly string[];
  /** 病历（含既往史）或已签名诊断记有糖尿病、消渴：食疗方不选含糖与大量精白米粥饭的（recipeUnsuitableForDiabetes）。 */
  recordedDiabetes?: boolean;
  /** 饮食调护或注意事项写明忌茶（dietAdviceAvoidsTea）：食疗方不选含茶叶的。 */
  avoidTea?: boolean;
};

export type TextbookPlanPoint = {
  name: string;
  role: "base_point" | "syndrome_refinement" | "conditional_point";
  /** 配穴来自哪个教材证型（role=syndrome_refinement 时）。 */
  syndromeLabel?: string;
  note?: string;
  /** 配穴来自院内目录的证型配穴表（catalogSyndromeRefinement），不出自教材本节。 */
  fromCatalogRefinement?: boolean;
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
/**
 * 2026-10-19（Claude 评审 M 集、H 集）补了三件事：
 *  · 部位词须与不适写在同一小句（complaint）：查体模板「颈部对称，无青筋暴露」曾让双手、足趾关节肿痛的类风湿病例取到脊背组
 *    （M-TCM-SD-488395）；「下足腕扎带」曾让周身关节痛取到腕部组（H-tri-10610）。
 *  · 部位写法：近端指间、掌指、跖趾关节的病历缩写（PIP、MCP、DIP、MTP）与「双手」「手部」算腕手部，「足腕」不算腕。
 *  · 教材「脊背：大杼 身柱 腰阳关 夹脊」按脊柱节段分开：颈项、背痛取大杼、身柱、夹脊，腰骶痛取腰阳关、夹脊
 *    （X-H-0171、X-H-0230 颈项强痛取到腰阳关）。四个穴仍出自教材这一组，只按局部取穴的原则不跨节段。
 * 同法分组的还有头痛（四经分部）与痿证（上肢、下肢两组），原文见下。对不上部位时：痹病只留阿是穴（教材「取局部穴为主」），
 * 头痛、痿证保持全部主穴（病历没写部位）。
 */
type RegionalScheme = {
  /** 部位词所在小句里须有的不适字样（闭集）。 */
  complaint: RegExp;
  /** 一个部位都对不上时：只留阿是穴，或保留全部主穴。 */
  unmatched: "local_only" | "all";
  groups: ReadonlyArray<{
    region: string; cue: RegExp; points: readonly string[];
    /** 同一部位内外侧各有其穴时（踝部：申脉、昆仑、丘墟在外踝，照海在内踝），病历只写到一侧就不取另一侧的穴。 */
    sides?: ReadonlyArray<{
      cue: RegExp; points: readonly string[];
      /** 这一侧另取教材同名节里按经筋分侧写的那一型的配穴（《针灸学》踝关节扭伤「足太阴经筋及阴跷脉病证」）：label 是该型名的匹配式。 */
      sideSyndrome?: { label: RegExp; side: string };
    }>;
  }>;
};
const REGIONAL_MAIN_POINT_GROUPS: Readonly<Record<string, RegionalScheme>> = {
  痹病: {
    complaint: /痛|疼|酸|麻|僵|肿|胀|受限|不利|屈伸|无力|活动障碍|弹响|畸形|变形|累及|受累|冷|凉|异样|热|灼/u,
    unmatched: "local_only",
    groups: [
      { region: "肩部", cue: /肩/u, points: ["肩髃", "肩髎", "肩贞", "臑俞"] },
      { region: "肘部", cue: /肘/u, points: ["曲池", "天井", "尺泽", "少海"] },
      { region: "腕部", cue: /(?<!足)腕|手指|[拇食中环小]指|无名指|指关节|掌指|指间|双手|[左右]手(?!术)|手部|手掌|PIP|MCP|DIP/iu, points: ["阳池", "外关", "阳溪", "腕骨"] },
      // 「足背」「趾背」「手背」是足、手的背面，不是脊背（X-H-0398「右趾背侧针刺觉减退」「足背放射性痛麻」曾取到大杼、身柱）。
      { region: "颈背", cue: /颈|项|(?<![足脚手趾踇躅掌])背|胸椎/u, points: ["大杼", "身柱", "夹脊"] },
      { region: "腰骶", cue: /腰|骶/u, points: ["腰阳关", "夹脊"] },
      { region: "髀部", cue: /髋|髀|臀|胯|大腿/u, points: ["环跳", "居髎", "秩边", "髀关"] },
      { region: "膝部", cue: /膝/u, points: ["血海", "梁丘", "膝眼", "阳陵泉"] },
      // 内外踝分侧（H-tri-1476 痛在外踝后，取到内踝下的照海）。
      { region: "踝部", cue: /踝|足跟|足背|跖趾|足趾|脚趾|趾关节|MTP/iu, points: ["申脉", "照海", "昆仑", "丘墟"],
        sides: [{ cue: /外踝/u, points: ["申脉", "昆仑", "丘墟"] }, { cue: /内踝/u, points: ["照海"] }] },
    ],
  },
  // 《针灸治疗学》头痛「主穴 阳明头痛：头维 印堂 阳白 阿是穴 合谷 内庭 / 少阳头痛：太阳 丝竹空 率谷 风池 阿是穴 外关 侠溪 /
  // 太阳头痛：天柱 后顶 风池 阿是穴 后溪 申脉 / 厥阴头痛：百会 四神聪 阿是穴 太冲 中冲」，辨证要点按部位归经（前额眉棱鼻根、侧头、
  // 后枕下连于项、巅顶）；《针灸学》同（少阳另有足临泣，厥阴另有内关）。此前四组拍平后截前 12 个，后枕痛连项的太阳头痛拿到阳明、少阳两组
  //（H-tri-9376），后枕至颞侧的头痛拿到前额组（H-tri-10297）。
  头痛: {
    complaint: /痛|胀|重/u,
    unmatched: "all",
    groups: [
      { region: "阳明", cue: /前额|额部|额头|眉棱|眉骨|鼻根/u, points: ["头维", "印堂", "阳白", "合谷", "内庭"] },
      { region: "少阳", cue: /侧头|头[^，,。；;]{0,3}[两一单]侧|颞|偏头|太阳穴/u, points: ["太阳", "丝竹空", "率谷", "风池", "外关", "侠溪", "足临泣"] },
      { region: "太阳", cue: /后枕|枕部|枕后|后头|头后|项/u, points: ["天柱", "后顶", "风池", "后溪", "申脉"] },
      { region: "厥阴", cue: /巅顶|颠顶|头顶/u, points: ["百会", "四神聪", "太冲", "中冲", "内关"] },
    ],
  },
  // 《针灸治疗学》痿证「主穴 上肢：肩髃 曲池 合谷 颈、胸夹脊 / 下肢：髀关 足三里 阳陵泉 三阴交 腰夹脊」；《针灸学》上肢另有手三里、
  // 外关，下肢另有伏兔。此前两组整块拼上：只左腕下垂的病例列着髀关、腰夹脊（H-tri-17725），只双下肢无力的列着肩髃、颈夹脊（H-tri-5395）。
  痿证: {
    complaint: /无力|痿|萎|瘫|麻木|不遂|下垂|不利|受限|不能|困难|跛|肌力|握力|抬举|垂腕|垂足/u,
    unmatched: "all",
    groups: [
      { region: "上肢", cue: /上肢|四肢|臂|肘|(?<!足)腕|手(?!术)|指|握|肩/u, points: ["肩髃", "曲池", "手三里", "合谷", "外关", "颈夹脊", "胸夹脊"] },
      // 「手足麻木」「手套和袜套样」是上下肢都受累（2026-10-19 Claude 评审 H-tri-16576：药物性周围神经病「手足麻木…袜形分布」只取了上肢组）。
      { region: "下肢", cue: /下肢|四肢|腿|(?<!不)足(?!月|够|以|量)|脚|膝|踝|髋|袜|行走|步态|步履|站立|下蹲|跛/u, points: ["髀关", "伏兔", "阳陵泉", "足三里", "三阴交", "腰夹脊"] },
    ],
  },
  // 《针灸治疗学》急性踝关节扭伤「主穴 阿是穴 申脉 丘墟 养老」——申脉、丘墟在外踝，养老是与之手足同名经相应的腕部穴，写的是最常见的外踝内翻扭伤；
  //《针灸学》踝关节扭伤按经筋分侧：「足少阳经筋及阳跷脉病证」加悬钟、丘墟、申脉、足临泣，「足太阴经筋及阴跷脉病证」加三阴交、商丘、照海、水泉。
  // 病历只写内踝时（H-tri-6746「内踝尖前下方压痛」取到申脉、丘墟、养老）不取外踝一侧的穴，按《针灸学》内踝那一型取穴。
  急性踝关节扭伤: {
    complaint: /痛|肿|胀|受限|不利|瘀|青紫/u,
    unmatched: "all",
    groups: [
      { region: "踝部", cue: /踝/u, points: ["申脉", "丘墟", "养老"],
        sides: [
          { cue: /外踝/u, points: ["申脉", "丘墟", "养老"] },
          { cue: /内踝/u, points: [], sideSyndrome: { label: /阴跷/u, side: "内踝" } },
        ] },
    ],
  },
};
/** 本例对上的部位组（部位词与不适字样同在一小句）。 */
function matchedRegionalGroups(scheme: RegionalScheme, currentFacts: string) {
  const clauses = currentFacts.normalize("NFKC").split(/[，,。；;\n]/);
  return scheme.groups.flatMap((group) => {
    const hits = clauses.filter((clause) => group.cue.test(clause) && scheme.complaint.test(clause));
    if (hits.length === 0) return [];
    const sides = (group.sides || []).filter((side) => hits.some((clause) => side.cue.test(clause)));
    if (sides.length !== 1) return [group];
    const otherSide = new Set((group.sides || []).filter((side) => side !== sides[0]).flatMap((side) => side.points));
    return [{ ...group, points: group.points.filter((point) => !otherSide.has(point)), sideSyndrome: sides[0].sideSyndrome }];
  });
}

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
// 「心肾不交」：《中医诊断学》定为心肾阴虚阳亢的虚热证（「心与肾的阴液亏虚，阳气偏亢」），《中医内科学》不寐节归虚证；
// 证名里没有虚损字样，此前判不出虚实（2026-10-19 Claude 评审 M-TCM-RobustSDT-single_0686：针刺卡加太溪、肾俞补肾，操作写「针用泻法」）。
const DEFICIENCY_SYNDROME_WORDS = /虚|亏|不足|失养|衰少|不固|不摄|心肾不交/;
const EXCESS_SYNDROME_WORDS = /实|热|火|痰|湿|瘀|滞|郁|风|寒|毒|积|闭|亢|逆|扰|饮|浊/;
/**
 * 教材分套里按虚实取舍的套名（闭集，取自生成物 variants 的全部套名）：实证/虚证，急惊风（实热）/慢惊风（虚），血滞经闭/血枯经闭。
 */
const VARIANT_LABEL_NATURE: Readonly<Record<string, "deficiency" | "excess">> = {
  实证: "excess", 虚证: "deficiency", 急惊风: "excess", 慢惊风: "deficiency", 血滞经闭: "excess", 血枯经闭: "deficiency",
};
/**
 * 急危状态的那一套与门诊常态的那一套（闭集）：中脏腑（神志昏蒙，闭证/脱证）对中经络，发作期对间歇期。
 * 门诊出卡时病人不在昏迷或抽搐发作中——那两种情形安全门判红旗、整页不出项目卡（applyTcmTreatmentCapabilityPriority 开头）。
 * 所以急危那一套只在已签名病名、证候或主诉逐字写到它（或写到闭证、脱证）时取，其余取常态那一套
 *（2026-10-19 Claude 评审 M-TCM-RobustSDT-single_0578：中风后 20 个月、中经络，针刺卡仍带「百会闭证用毫针刺，泻法」；
 *  X-H-0047「痫病发作后来诊」，卡上发作期的水沟强刺激与间歇期的鸠尾并列）。
 */
const ACUTE_STATE_VARIANTS: ReadonlyArray<{ acute: string; acuteCues: RegExp; usual: string }> = [
  { acute: "中脏腑", acuteCues: /中脏腑|闭证|脱证/u, usual: "中经络" },
  { acute: "发作期", acuteCues: /发作期/u, usual: "间歇期" },
];
function pickBasicTreatmentVariant(entry: AcupunctureEntry, input: TextbookPlanInput) {
  const variants = (entry.variants || []).filter((item) => item.label && item.mainPoints.length > 0);
  if (variants.length < 2) return undefined;
  const byLabel = (label: string) => variants.find((item) => item.label === label);
  const haystack = compact([...input.diseaseNames, input.signedSyndromeText, input.chiefComplaint || ""].join("；"));
  for (const pair of ACUTE_STATE_VARIANTS) {
    const acute = byLabel(pair.acute);
    const usual = byLabel(pair.usual);
    if (acute && usual) return pair.acuteCues.test(haystack) ? acute : usual;
  }
  const natureVariants = variants.filter((item) => VARIANT_LABEL_NATURE[item.label]);
  if (natureVariants.length === 2 && new Set(natureVariants.map((item) => VARIANT_LABEL_NATURE[item.label])).size === 2) {
    const nature = signedCardNature(input.signedSyndromeText, input.signedPrinciple);
    return natureVariants.find((item) => nature && VARIANT_LABEL_NATURE[item.label] === nature);
  }
  const literal = variants.filter((item) => {
    const label = compact(item.label.replace(/（[^）]*）|\([^)]*\)/g, ""));
    return label.length >= 2 && haystack.includes(label);
  });
  return literal.length === 1 ? literal[0] : undefined;
}

/**
 * 卡片上按虚实取舍（教材实证/虚证两套、外感内伤与实证虚证的操作小句、补泻手法）用的本例虚实（2026-10-19）。
 * 此前把主证与兼证连成一串判：肝肾阴虚证（主）兼「脾阳不足、湿浊内蕴证」判成虚实夹杂、两套并列（M-TCM-RobustSDT-single_0582
 * 耳鸣：实证的听会、侠溪、中渚泻法与虚证的太溪、肾俞补法同列）；心肾不交证兼血瘀证因「瘀」判成实证、操作写泻法（single_0686）。
 *  · 先看主证名：纯虚、纯实即按它（兼证是次要的，卡片治的是主证）；
 *  · 主证名判不出（虚实两类字样都有、或都没有：咽喉气机不和证）时看已签名的治则——它就是交付给医生的那一栏
 *   （diagnosis-visible-summary nationalTreatmentPrinciple 按证名与治法推出）：虚则补之 ⇒ 虚，实则泻之、热者寒之、寒者热之 ⇒ 实，
 *    扶正祛邪一类 ⇒ 判不出。
 */
export function signedCardNature(signedSyndromeText: string, signedPrinciple = ""): "deficiency" | "excess" | undefined {
  const primary = String(signedSyndromeText || "").split(/[；;]/)[0] || "";
  const byName = signedSyndromeDeficiencyExcess(primary);
  if (byName) return byName;
  const principle = String(signedPrinciple || "");
  if (/扶正祛邪|祛邪扶正|攻补兼施|先攻后补|先补后攻|寓攻于补|寓补于攻|标本兼治/u.test(principle)) return undefined;
  if (/虚则补之|扶正固本|虚者补其母/u.test(principle)) return "deficiency";
  if (/实则泻之|实者泻其子|热者寒之|寒者热之/u.test(principle)) return "excess";
  return undefined;
}

/**
 * 主证带虚损（纯虚，或本虚标实如脾虚湿蕴、气虚血瘀）：刺络放血不作常规写法（《刺法灸法学》三棱针法「体质虚弱者…慎用」）。
 * 此前只拦纯虚证，脾虚湿蕴的手部慢性湿疹仍写「皮肤针重叩出血后加拔火罐」（2026-10-19 Claude 评审 M-TCM-BEST4SDT-154）。
 * 治则写的是补法（虚则补之、扶正祛邪一类）同样算。
 */
export function signedPrimaryHasDeficiency(signedSyndromeText: string, signedPrinciple = ""): boolean {
  const primary = (String(signedSyndromeText || "").split(/[；;]/)[0] || "").replace(/虚热|虚火|虚风|虚寒|虚阳/g, "虚");
  if (DEFICIENCY_SYNDROME_WORDS.test(primary)) return true;
  return /虚则补之|扶正固本|虚者补其母|扶正祛邪|祛邪扶正|攻补兼施|先攻后补|先补后攻|寓攻于补|寓补于攻/u.test(String(signedPrinciple || ""));
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
  const nature = signedCardNature(input.signedSyndromeText, input.signedPrinciple);
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
export function manipulationMatchedToSyndrome(text: string, signedSyndromeText: string, signedPrinciple = ""): string {
  // 虚实按主证（主证判不出时按已签名治则）定，与教材分套取舍同一判据 signedCardNature（2026-10-19：心肾不交证兼血瘀证曾被兼证的「瘀」
  // 判成实证，目录失眠模板的「留针用补法」被改成「针用泻法」，同卡却加太溪、肾俞补肾）。
  const nature = signedCardNature(signedSyndromeText, signedPrinciple);
  if (!nature) return text;
  const wrong = nature === "excess" ? /补法/ : /泻法/;
  const primary = String(signedSyndromeText || "").split(/[；;]/)[0] || "";
  // 带「平补平泻」的句子照旧不动（本虚标实的痰湿蕴肺用平补平泻是教材原法）；只有证名是纯实热（带热/火、不带虚）而句子又把补法列为
  // 可选时算写错（2026-10-17 留出集：痰热郁肺、痰火扰心沿用「内伤咳嗽针用平补平泻或补法」）。
  const heatExcess = nature === "excess" && /热|火/.test(primary) && !/虚/.test(primary);
  const right = nature === "excess"
    ? (heatExcess ? /泻法|虚补实泻|补虚泻实/ : /泻法|平补平泻|虚补实泻|补虚泻实/)
    : /补法|平补平泻|虚补实泻|补虚泻实/;
  // 教材已把本例的补泻落到具体穴上（虚火牙痛「主穴用泻法…配穴太溪用补法」）：通用小句说的是主穴，不改（2026-10-19 Claude 评审 H-tri-15384：
  // 「毫针常规刺，泻法」被改成「针用补法」，颊车、内庭等主穴也成了补法）。
  if (text.split(/(?<=[。；;])/).some((sentence) => right.test(sentence) && namesAcupoint(sentence) && /[补泻]法/u.test(sentence))) return text;
  // 只换说补泻的那一小句，同句的频次等其余小句照留（2026-10-19 第五轮留出例 S011、S151：「内伤咳嗽针用平补平泻或补法，每日或隔日治疗1次」
  // 整句换成「针用泻法」，疗程栏与操作栏都只剩这一句）。
  let replaced = false;
  return text.split(/(?<=[。；;])/).map((sentence) => {
    if (!wrong.test(sentence) || right.test(sentence) || namesAcupoint(sentence)) return sentence;
    const ending = sentence.trim().match(/[。；;]$/)?.[0] || "。";
    const clauses = sentence.replace(/[。；;]\s*$/u, "").split(/(?<=[，,])/);
    const kept = clauses.flatMap((clause) => {
      if (!wrong.test(clause)) return [clause];
      if (replaced) return [];
      replaced = true;
      return [`针用${nature === "excess" ? "泻法" : "补法"}${/[，,]\s*$/u.test(clause) ? "，" : ""}`];
    }).join("").replace(/[，,]\s*$/u, "").trim();
    return kept ? `${kept}${ending}` : "";
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
// 2026-10-18：外感风热、燥热、胃热、热秘等也不宜灸（留出例 S002 风热感冒的针刺卡疗程写「留针15分钟，灸5分钟」，
// 该频次来源原文是「风寒者，取针后在大椎穴施雀啄灸」）。寒热错杂不在此列。
const MOXIBUSTION_UNSUITABLE_SYNDROME = /阴虚|阴亏|阴液|实热|热盛|热毒|[风燥暑胃肝肺心湿血痰郁里]热|热(?:秘|证|结|壅|蕴|郁)|火(?!衰)/u;
/**
 * 证名里病性属热的字样，取自受治理病性词表（tcm-nature-lexicon.json 的热、火热、暑、血热四项及其别名），不在这里另列词表
 *（2026-10-19 终评 M-TCM-RobustSDT-single_0102：暑湿伤表证、偏热，针刺卡疗程照写「灸5分钟」——上面那条只认「暑热」不认「暑湿」）。
 * 寒热错杂、上热下寒、寒热往来、命门火衰不算。
 */
const HEAT_NATURE_LEXICON_IDS = new Set(["heat", "fire_heat", "summerheat", "blood_heat"]);
const HEAT_NATURE_TERMS: readonly string[] = (natureLexiconJson as { entries: Array<{ id: string; canonical: string; aliases?: string[] }> }).entries
  .filter((entry) => HEAT_NATURE_LEXICON_IDS.has(entry.id))
  .flatMap((entry) => [entry.canonical, ...(entry.aliases || [])])
  .filter(Boolean);
export function syndromeHasHeatNature(signedSyndromeText: string): boolean {
  const text = String(signedSyndromeText || "");
  if (MOXIBUSTION_UNSUITABLE_SYNDROME.test(text)) return true;
  const withoutMixed = text.replace(/寒热错杂|上热下寒|上寒下热|寒热往来|命门火衰|火衰/gu, "");
  return HEAT_NATURE_TERMS.some((term) => withoutMixed.includes(term));
}
/** 已签名证候不宜用灸（阴虚、实热、湿热、暑、火）：卡片里说灸的句子去掉，整张灸法卡也不出（见 tcm-treatment-capabilities）。 */
export function moxibustionUnsuitableForSyndrome(signedSyndromeText: string, signedMethodText = ""): boolean {
  if (syndromeHasHeatNature(String(signedSyndromeText || ""))) return true;
  // 教材按类型命名、证名里不带寒热字的证（淋证的「石淋」「热淋」、痹证的「行痹」）：看已签名的治法。治法是纯清热、泻火、滋阴、凉血、
  // 清利而不带温、散寒、助阳的，同样不宜灸（2026-10-18：留出例 S067 证名「石淋」、治法清热利湿，仍拿到整张灸法卡）。
  const method = String(signedMethodText || "");
  return /清热|泻火|滋阴|凉血|清利|清泄|清肝|清胃/u.test(method) && !/温|散寒|助阳|补阳|壮阳|回阳/u.test(method);
}

/**
 * 卡片自己写明只适用于本病的另几个类型（「常规灸法，多用于膏淋、劳淋」），而本例的证不在其中：整张卡不出（2026-10-18，留出例 S067
 * 湿热石淋拿到这张灸法卡，独立评审判套用别病模板）。类型名按教材写法认：2–4 字、末字与本病名首字相同（淋证→…淋，痹证→…痹），
 * 或以证、型结尾；本例证名包含该类型名（或反过来）即算相符。没有这类句子、或列的不是类型名时不管。
 */
export function cardApplicabilityExcludesSyndrome(text: string, diseaseNames: readonly string[], signedSyndromeText: string): boolean {
  const syndrome = String(signedSyndromeText || "").replace(/证$/u, "");
  if (!text || !syndrome) return false;
  // 卡片写明「适用于素体虚弱的患者」，本例是纯实证（2026-10-19：急性腰扭伤节的灸法卡给到瘀血腰痛）。
  if (/适用于[^。；;，,]{0,6}(?:素体虚弱|体质虚弱|体虚|虚证)/u.test(text) && signedSyndromeDeficiencyExcess(syndrome) === "excess") return true;
  const diseaseHeads = diseaseNames.map((name) => name.trim()[0]).filter(Boolean);
  for (const match of text.matchAll(/(?:多|主要|常|宜|适)用于([^。；;，,]{2,30})/gu)) {
    const names = match[1].split(/[、和及与或]/u).map((item) => item.trim()).filter(Boolean);
    const subtypes = names.filter((name) => /^[\u4e00-\u9fff]{2,4}$/u.test(name) &&
      (diseaseHeads.some((head) => name.endsWith(head)) || /[证型]$/u.test(name)));
    if (subtypes.length === 0 || subtypes.length !== names.length) continue;
    const fits = subtypes.some((name) => {
      const core = name.replace(/[证型]$/u, "");
      return syndrome.includes(core) || core.includes(syndrome);
    });
    if (!fits) return true;
  }
  return false;
}
/**
 * 本例病程：急性还是慢性（只用于卡片里「急性X…」「慢性X…」这类分病程写的小句取舍）。西医主诊断写明急性、慢性时按它；
 * 否则按主诉里第一个病程数字：≥3 个月算慢性，≤2 周算急性。判不出时返回 undefined，两类小句都留。
 */
const CHINESE_DIGITS: Readonly<Record<string, number>> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function courseNumber(raw: string): number | undefined {
  if (/^\d/.test(raw)) return Number(raw);
  if (raw === "半") return 0.5;
  if (raw === "十") return 10;
  const tens = raw.match(/^([一二两三四五六七八九])?十([一二三四五六七八九])?$/u);
  if (tens) return (tens[1] ? CHINESE_DIGITS[tens[1]] : 1) * 10 + (tens[2] ? CHINESE_DIGITS[tens[2]] : 0);
  return raw.length === 1 ? CHINESE_DIGITS[raw] : undefined;
}
export function caseCourse(westernNames: readonly string[], chiefComplaint: string): "acute" | "chronic" | undefined {
  const western = westernNames.join("；");
  if (/慢性/u.test(western)) return "chronic";
  if (/急性/u.test(western)) return "acute";
  const match = String(chiefComplaint || "").normalize("NFKC")
    .match(/(\d+(?:\.\d+)?|[一二两三四五六七八九十半]+)\s*(?:余|多)?\s*(年|个月|月|周|星期|天|日)/u);
  const amount = match ? courseNumber(match[1]) : undefined;
  if (!match || amount == null) return undefined;
  const days = amount * ({ 年: 365, 个月: 30, 月: 30, 周: 7, 星期: 7, 天: 1, 日: 1 } as Record<string, number>)[match[2]];
  return days >= 90 ? "chronic" : days <= 14 ? "acute" : undefined;
}

const SYNDROME_DESCRIPTOR_CHAR = /[寒湿热风暑燥火瘀血气虚实阴阳肾肝脾肺心胃胆痰郁滞亏损食积水饮]/u;
/**
 * 卡片小句里限定「写给哪一型、哪一期」的说法，及其与本例是否相符（2026-10-19 起按小句判，此前按整句）。
 *  · 证型修饰本病名：「寒湿腰痛」「瘀血腰痛」（两字修饰语 + 病名），「热痹」「风寒湿痹」（1–3 字修饰语 + 病名首字，病名是「X证/X病」时）；
 *    相符 = 修饰语每个字都在本例证候里；三字以上的类目（风寒湿痹）与本例病性有交集也算（痛痹属风寒湿痹）。
 *  · 证型名直接带条件：「风热证…」「寒湿者…」，以及小句开头的证型名（可并列）后接「者」或「可/宜」：「瘀血阻络者可用三棱针点刺出血」
 *   「肾阳虚衰可用隔附子饼灸」「肾气亏虚、脾气虚弱者可温针灸」；相符按证名概念（syndromeLabelFitsSigned）。
 *  · 病程：「急性腰痛，痛势剧烈者…」「慢性泄泻每日或隔日治疗1次」，与本例病程（caseCourse）相反的不留。
 */
function clauseQualifierVerdict(
  clause: string,
  diseases: readonly string[],
  syndrome: string,
  course: "acute" | "chronic" | undefined,
): "fits" | "other" | "none" {
  const charFit = (descriptor: string) => [...descriptor].every((char) => syndrome.includes(char));
  const have = syndromeConcepts(syndrome).natures;
  const descriptorFits = (descriptor: string) => charFit(descriptor) ||
    (descriptor.length >= 3 && [...syndromeConcepts(descriptor).natures].some((nature) => nature !== "虚" && have.has(nature)));
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const verdicts: boolean[] = [];
  for (const disease of diseases) {
    for (const match of clause.matchAll(new RegExp(`([\\u4e00-\\u9fff]{2})${escape(disease)}`, "gu"))) {
      if (SYNDROME_DESCRIPTOR_CHARS.test(match[1])) verdicts.push(descriptorFits(match[1]));
    }
    // 病名首字（痹证 → 痹，淋证 → 淋）前的 1–3 个证候用字：「热痹」「风寒湿痹」。
    const head = /^[\u4e00-\u9fff][证病]$/u.test(disease) ? disease[0] : "";
    if (head) {
      for (const match of clause.matchAll(new RegExp(`([\\u4e00-\\u9fff]{1,3})${escape(head)}(?![证病])`, "gu"))) {
        let descriptor = match[1];
        while (descriptor && !SYNDROME_DESCRIPTOR_CHAR.test(descriptor[0])) descriptor = descriptor.slice(1);
        if (descriptor && [...descriptor].every((char) => SYNDROME_DESCRIPTOR_CHAR.test(char))) verdicts.push(descriptorFits(descriptor));
      }
    }
  }
  for (const match of clause.matchAll(/([\u4e00-\u9fff]{2})(?:证|者|型)/gu)) {
    if (SYNDROME_DESCRIPTOR_CHARS.test(match[1])) verdicts.push(descriptorFits(match[1]));
  }
  // 证型名本身不含「可、宜、用、者」：「寒证可用艾灸法」不能读成证型「寒证可」。
  const lead = clause.trim().match(/^(?:若|如|凡|对于?)?((?:[^\x00-\x7F可宜用者、和及与或，,。；;\s]{2,4}[、和及与或])*[^\x00-\x7F可宜用者、和及与或，,。；;\s]{2,4})(者|证者|型者)?(?=可|宜|加用|用)/u);
  if (lead) {
    // 两字的只认带本病类型字的（便秘 → 冷秘、虚秘；痹证 → 热痹）或两字都是证候用字的（血寒、血虚、肾虚，2026-10-19 第五轮留出例 S102：
    // 痰湿月经后期的针刺卡留着「血寒、血虚、肾虚可加灸」），免得「局部可…」这类两字词被当成证型。
    const typeChar = (disease: string) => /[证病]$/u.test(disease) ? disease[0] : disease.slice(-1);
    const labels = lead[1].split(/[、和及与或]/u).filter((label) => (lead[2] || label.length >= 3 || SYNDROME_DESCRIPTOR_CHARS.test(label) ||
      diseases.some((disease) => label.endsWith(typeChar(disease)))) &&
      (syndromeConcepts(label).natures.size > 0 || syndromeLabelMatchesSigned(label, syndrome)) && !namesAcupoint(label) && !/灸|针|罐|刺/u.test(label));
    // 条件里的证型与本例相符 = 同名，或脏腑与具体病性都在本例证候里（「胃寒积滞…可加灸」对胃中寒冷证）。
    // 「积滞、郁滞」与泛称的「虚」不作比较，其余具体病性都要在本例证候里（寒湿腰痛对湿热腰痛不符）。
    const overlapFits = (label: string) => {
      const target = syndromeConcepts(label);
      const specific = [...target.natures].filter((nature) => nature !== "虚" && nature !== "郁滞");
      return specific.length > 0 && specific.every((nature) => have.has(nature)) &&
        [...target.organs].every((organ) => syndromeConcepts(syndrome).organs.has(organ));
    };
    if (labels.length > 0) verdicts.push(labels.some((label) => syndromeLabelFitsSigned(label, syndrome) || charFit(label) || overlapFits(label)));
  }
  const courseWord = clause.trim().match(/^(急性|慢性)/u)?.[1];
  if (courseWord && course && diseases.some((disease) => clause.includes(disease) || clause.includes(disease.replace(/[证病]$/u, "")))) {
    verdicts.push((courseWord === "急性") === (course === "acute"));
  }
  if (verdicts.length === 0) return "none";
  return verdicts.some(Boolean) ? "fits" : "other";
}

export function cardSentencesMatchedToSyndrome(
  text: string,
  diseaseNames: readonly string[],
  signedSyndromeText: string,
  course?: "acute" | "chronic",
): string {
  const syndrome = String(signedSyndromeText || "");
  if (!text || !syndrome.trim()) return text;
  const diseases = diseaseNames.map((name) => name.trim()).filter((name) => name.length >= 2);
  const noMoxibustion = syndromeHasHeatNature(syndrome);
  namesAcupoint("");
  // 「灸」只认施灸的说法：书名、出处括注里的「灸」（《刺法灸法学》）和「针灸」一词不算。施灸的小句只去那一小句
  //（「留针15分钟，灸5分钟。」→「留针15分钟。」）。此前整句判、句句都带出处里的「灸」，全删光后整段原样退回（2026-10-18 留出例 S002）。
  // 「温针灸」是施灸（针柄上燃艾），其中的「针灸」不是那个泛称词：此前把它当「针灸」去掉，热痹卡的「可加电针，或温针灸」照留
  //（2026-10-19 Claude 评审 M-TCMChat-test-336 风湿热痹）。
  const moxibustionWording = (value: string) => /灸/.test(value.replace(/《[^》]*》|（[^）]*）|\([^)]*\)|(?<!温)针灸/g, "")) && !/禁灸|不宜灸|慎灸|忌灸|不灸/.test(value);
  const kept = text.split(/(?<=[。；;])/).flatMap((sentence) => {
    if (!noMoxibustion || !moxibustionWording(sentence)) return [sentence];
    const clauses = sentence.split(/(?<=[，,])/);
    const rest = clauses.filter((clause) => !moxibustionWording(clause)).join("").replace(/[，,]\s*$/, "");
    // 剩下的只是施灸的条件（「寒湿腰痛、肾虚腰痛者」「除阴虚火旺外」）时整句去。
    if (!rest.trim() || rest.length === sentence.length || /(?:者|外|时|后|则|可)\s*$/.test(rest) || /^\s*(?:若|如|除|凡)/.test(rest)) return [];
    return [/[。；;]$/.test(rest) ? rest : `${rest}${sentence.match(/[。；;]$/)?.[0] || ""}`];
  }).flatMap((sentence) => {
    // 写给别的证型、别的病程的小句不留：「风寒湿痹可加用灸法，热痹局部可点刺出血。」对痛痹只留前一小句（2026-10-19 Claude 评审
    // X-H-0059、0437、0171 等 7 例）；「寒湿内盛、脾胃虚弱可用隔姜灸…；肾阳虚衰可用隔附子饼灸。」对脾胃虚弱去后一句（X-H-0146）；
    //「急性腰痛，痛势剧烈者，阿是穴、委中可用三棱针点刺出血」对十年腰痛整句去（X-H-0097）。限定小句是条件（以者、时结尾，或只是
    //「急性腰痛」这样的类型名）时，它管的是整句，整句去；本身带做法的只去这一小句。
    const ending = sentence.match(/[。；;]\s*$/u)?.[0]?.trim() || "";
    const clauses = sentence.replace(/[。；;]\s*$/u, "").split(/(?<=[，,])/);
    const keptClauses: string[] = [];
    for (const clause of clauses) {
      // 「本例属X，在主穴基础上加…」是出卡时按已签名证候写的，不按类型名再筛一遍。
      if (/^\s*本例属/u.test(clause)) { keptClauses.push(clause); continue; }
      const verdict = clauseQualifierVerdict(clause, diseases, syndrome, course);
      if (verdict !== "other") { keptClauses.push(clause); continue; }
      const bare = clause.replace(/[，,]\s*$/u, "").trim();
      const conditional = /(?:者|时)$/u.test(bare) || /^(?:若|如|凡)/u.test(bare) ||
        diseases.some((disease) => bare.replace(/^(?:急性|慢性)/u, "").replace(/^[\u4e00-\u9fff]{0,2}/u, "") === disease) ||
        /^(?:急性|慢性)[\u4e00-\u9fff]{1,4}$/u.test(bare);
      if (conditional) return [];
    }
    if (keptClauses.length === clauses.length) return [sentence];
    const joined = keptClauses.join("").replace(/[，,]\s*$/u, "").trim();
    return joined ? [`${joined}${ending || "。"}`] : [];
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

/**
 * 卡片操作栏里点名的穴位一个都不在本卡穴位里的句子不留（2026-10-17 本地复测甲方标准病历 1：风寒感冒的针刺卡穴位是列缺、合谷、风池…，
 * 操作栏仍写着教材风热那一支的「少商、商阳用点刺放血法」）。说禁忌、慎用的句子照留——那是安全提示，不是操作。
 */
export function cardSentencesNamingListedPoints(text: string, points: readonly string[]): string {
  if (!text || points.length === 0) return text;
  namesAcupoint("");
  const onCard = (name: string) => points.some((point) => point.includes(name));
  const namedIn = (value: string) => [...value.matchAll(new RegExp(acupointNamePattern!.source, "g"))].map((match) => match[0]);
  // 「背俞穴注意针刺的方向、角度和深度」说的是一类穴：卡上没有任何背俞穴（…俞）时与本卡无关（2026-10-19 Claude 评审 H-tri-5396 不寐卡）。
  const categoryOffCard = (value: string) => /背俞穴/u.test(value) && !points.some((point) => /俞(?:（|$)/u.test(point));
  const kept = text.split(/(?<=[。；;])/).flatMap((sentence) => {
    // 点了穴名的句子，所点的穴至少一个在本卡上才留（2026-10-17 甲方病历 1）。教材单列的「禁忌：」句同样（2026-10-18 甲方病历 6 腰痛卡上
    // 印着「禁忌：膏肓、肺俞、膈俞等穴局部肌肉薄…避免气胸」）。
    const named = namedIn(sentence);
    if (/^\s*禁忌[：:]/u.test(sentence)) return named.length === 0 || named.some(onCard) ? [sentence] : [];
    // 其余按小句判（2026-10-19 Claude 评审）：注意小句（禁、慎、不宜、不可…）点的穴都不在卡上时去掉这一小句——此前整句照留，
    // 产后尿失禁卡上印着「肺俞、脾俞不可直刺、深刺」（H-tri-14396），水肿卡印着「肺俞不宜直刺、深刺」（H-tri-3750）；
    // 并列点穴（「大敦、隐白可点刺出血」）只留在卡上的那几个穴名（H-tri-15803 卡上没有隐白）。
    const ending = sentence.match(/[。；;]\s*$/u)?.[0]?.trim() || "";
    const clauses = sentence.replace(/[。；;]\s*$/u, "").split(/(?<=[，,])/);
    // 去掉的小句后面紧跟的「以免…」「以防…」是它的下半句，一并去掉（水肿卡「毫针常规刺，肺俞不宜直刺、深刺，以免伤及内脏」）。
    // 按小句去的是注意小句与以穴名开头的做法小句（「神阙用灸，余穴毫针常规刺」去前一小句；「足三里行补法」）；穴名在小句中间的
    //（「使针感能到达会阴…」的会阴是部位）不按穴名去。
    const cautionClause = (clause: string) => /禁|慎|勿|避免|不宜|不可|切忌|注意/u.test(clause) ||
      new RegExp(`^\\s*(?:${acupointNamePattern!.source})`, "u").test(clause);
    let droppedPrevious = false;
    const keptClauses = clauses.flatMap((clause) => {
      if (droppedPrevious && /^\s*(?:以免|以防|防止|免得|否则|或|亦可|也可)/u.test(clause)) return [];
      droppedPrevious = false;
      if (categoryOffCard(clause)) { droppedPrevious = true; return []; }
      const names = namedIn(clause);
      if (names.length === 0) return [clause];
      if (!names.some(onCard) && cautionClause(clause)) { droppedPrevious = true; return []; }
      const list = clause.match(new RegExp(`^\\s*((?:(?:${acupointNamePattern!.source})、)+(?:${acupointNamePattern!.source}))`, "u"));
      if (!list) return [clause];
      const listed = list[1].split("、").filter(onCard);
      return listed.length > 0 ? [`${listed.join("、")}${clause.slice(list[0].length)}`] : [clause];
    });
    if (keptClauses.length === 0) return [];
    // 做法句（不带注意字样）点的穴一个都不在卡上：整句不留（2026-10-17 甲方病历 1「少商、商阳用点刺放血法」）。
    const remainingNames = namedIn(keptClauses.join(""));
    if (remainingNames.length > 0 && !remainingNames.some(onCard) && !/禁|慎|勿|避免|不宜|不可|以免|切忌/u.test(keptClauses.join(""))) return [];
    if (keptClauses.length === clauses.length && keptClauses.every((clause, index) => clause === clauses[index])) return [sentence];
    const joined = keptClauses.join("").replace(/[，,]\s*$/u, "").trim();
    // 剩下的只是没有做法的半句（「毫针常规刺，」之外全被去掉时照常收句）。
    return joined ? [`${joined}${ending || "。"}`] : [];
  }).join("").replace(/[；;](\s*)(?=禁忌[：:]|$)/g, "。$1").trim();
  return kept || text;
}

/**
 * 项目卡上写给孕妇、哺乳期的那几句或那几项，只写给可能属于这些人群的患者（2026-10-18 甲方病历 2/4/6/8 男性患者，
 * 耳穴卡写「妊娠期慎用」，针刺卡的必查项写「妊娠相关穴位」）。判据与注意事项、逐味提示同一个（reproductiveAdviceRelevant，
 * 由调用方给）。小句按「，；。」切，列举按「、」切，只去含孕哺字样的那一项。
 */
const REPRODUCTIVE_CARD_ITEM = /妊娠|孕|哺乳|经期|月经期/u;
/**
 * 列举的最后一项常连着整句的谓语（「糖尿病、慢性肾病、孕期哺乳期及正在服用抗凝药者请先咨询医生」）。整项去掉会把谓语一起去掉，
 * 剩下「糖尿病、慢性肾病。」一个没有下文的列举（2026-10-19，验收集与留出集食疗卡 39 处）：孕哺字样后面用「及/和/或/与」连着别的对象时，
 * 只去孕哺字样，留下后面那个对象和谓语。没有连词（「妊娠期禁用」「妊娠相关穴位」）的照旧整项去掉。
 */
const REPRODUCTIVE_ITEM_LEAD = /^(?:(?:孕期|孕妇|妊娠期|妊娠|哺乳期|哺乳|经期|月经期)、?)+(?:妇女)?(?:及|和|或|与)/u;
const REPRODUCTIVE_ITEM_PREDICATE = /(?:不宜|禁用|慎用|忌用|禁止|不可|请先|须|应)[^、]*$/u;
function itemWithoutReproductive(item: string): string | undefined {
  if (!REPRODUCTIVE_CARD_ITEM.test(item)) return item;
  const rest = item.replace(REPRODUCTIVE_ITEM_LEAD, "");
  return rest !== item && rest.length >= 2 && !REPRODUCTIVE_CARD_ITEM.test(rest) ? rest : undefined;
}
export function cardTextForPopulation(text: string, reproductiveRelevant: boolean): string {
  if (reproductiveRelevant || !text || !REPRODUCTIVE_CARD_ITEM.test(text)) return text;
  const out = text.split(/(?<=[，,；;。])/u).flatMap((clause) => {
    if (!REPRODUCTIVE_CARD_ITEM.test(clause)) return [clause];
    const ending = clause.match(/[，,；;。]$/u)?.[0] || "";
    const items = clause.slice(0, clause.length - ending.length).split("、");
    const keptItems = items.map(itemWithoutReproductive).filter((item): item is string => Boolean(item));
    if (keptItems.length === 0) return [];
    // 去掉的是带谓语的最后一项（「颜面部、大血管部位、孕妇腹部及腰骶部不宜施灸」）：谓语接回剩下的列举，不留「颜面部、大血管部位；」。
    const last = items[items.length - 1];
    const predicate = itemWithoutReproductive(last) === undefined ? last.match(REPRODUCTIVE_ITEM_PREDICATE)?.[0] : undefined;
    if (predicate) keptItems[keptItems.length - 1] = `${keptItems[keptItems.length - 1]}${predicate}`;
    return [`${keptItems.join("、")}${ending}`];
  }).join("");
  return out.replace(/[，,；;]$/u, "。").trim() || text;
}

/** 刺络放血类操作（刺络拔罐、点刺出血、三棱针）。 */
// 「皮肤针重叩出血后加拔火罐」也是出血类操作（2026-10-17 留出集：脾虚湿蕴、糜烂渗出的湿疮仍写这一句）。
// 「皮肤针重叩使出血少许，加拔罐」同样算（2026-10-19 Claude 评审：膝骨性关节炎·肝肾亏损的拔罐卡）。
const BLOODLETTING_SENTENCE = /刺络|放血|点刺出血|三棱针|刺血|叩(?:刺|至)?出血|重叩出血|叩[^，,。；;]{0,3}使出血|出血后加拔/;
/** 病历写到的皮肤破损（抓破、结痂、破溃、糜烂、渗液）：这些部位不宜拔罐、刺络。 */
const BROKEN_SKIN_FACT = /抓痕|血痂|结痂|破溃|溃烂|糜烂|溃疡|渗液|渗出|皲裂/;
const ELDERLY_AGE_YEARS = 65;

/**
 * 刺络放血不作为常规写法的三种情形：老年人、已签名证候属虚证、病历写到皮肤破损（2026-10-14 独立评审：85 岁、皮肤干燥有抓痕血痂、
 * 血虚肝旺的瘙痒病例，操作栏写「背部穴、局部阿是穴均可刺络拔罐」）。依据：《刺法灸法学》三棱针法「体质虚弱者…慎用」、拔罐法
 *「皮肤有溃疡、破裂处不宜拔罐」；中华中医药学会 T/CACM 1560.3—2023「年老、虚弱、严重消瘦者，拔罐时间宜短」。只删提到这类操作的那一句。
 */
/**
 * 面部（尤其鼻旁、唇周的「危险三角区」）不刺络放血：面部静脉无静脉瓣、与颅内海绵窦相通，局部挤压、针刺出血有感染上行的风险
 *（2026-10-18 验收集 H-tri-17402：鼻旁皮损局部三棱针散刺出血）。只删同时写到放血与面部部位的那一句；背部大椎、肺俞刺络照常。
 */
// 「鼻骨旁」「颊部」同样是面部（2026-10-19 Claude 评审 H-tri-17402：病历写「鼻骨旁颊部红肿水泡」，此前只认「鼻旁」「面颊」，
// 「皮损局部用三棱针散刺出血」照留）。「颊车」是穴名，不算部位词。
const FACIAL_SITE = /面部|颜面|面颊|鼻旁|鼻骨旁|鼻翼|鼻周|鼻唇|唇周|口周|上唇|危险三角|颊(?!车)/u;
/**
 * 面部疮疡（丹毒、疔疖、痈、脓疱、红肿水疱）：面部静脉与颅内相通，疮疡处不针刺、不挤压、不放血（《中医外科学》颜面部疔疮：
 *「切忌挤压、碰伤、过早切开」）。部位词与疮疡字样须在同一小句，或已签名诊断就是疮疡类而病历写到面部。只读本例肯定句。
 */
const FACIAL_SORE_WORDS = /红肿|肿痛|脓|疮|疖|疔|痈|水[疱泡]|丹毒/u;
export function facialSoreRecorded(currentFacts: string, diagnosisNames: readonly string[] = []): boolean {
  const facts = String(currentFacts || "").normalize("NFKC");
  if (facts.split(/[，,。；;\n]/u).some((clause) => FACIAL_SITE.test(clause) && FACIAL_SORE_WORDS.test(clause))) return true;
  return diagnosisNames.some((name) => /丹毒|疔|疖|痈|颜面[^，,。；;]{0,3}疮/u.test(name)) && FACIAL_SITE.test(facts);
}
/** 放血落在皮损/患处本身（「皮损局部用三棱针散刺出血」「阿是穴散刺出血」），部位由病历决定。 */
const LESION_LOCAL_SITE = /皮损局部|患部|患处|局部阿是穴|阿是穴|疱疹及周围|局部/u;

/**
 * 卡上取的是面部穴位时（面瘫、面痛的拔罐卡「取阳白、颧髎、地仓、颊车。行闪罐、走罐或刺络拔罐」），放血那一项同样不写（2026-10-19，
 * 验收集 H-tri-16571：13 岁周围性面瘫）。并列写的只去「或刺络拔罐」这一项，整句都是放血的去整句。面部穴位为闭集。
 */
// 只收颜面（额、颊、鼻旁、口周）的穴位；太阳、耳尖、攒竹这类目眶与颞侧穴点刺出血是眼病的教材常规（麦粒肿、目赤肿痛），不在此列。
const FACIAL_ACUPOINTS = /阳白|四白|颧髎|地仓|颊车|下关|迎香|承泣|承浆|牵正|巨髎/u;
function withoutFacialPointBloodletting(text: string, pointNames: readonly string[]): string {
  if (!BLOODLETTING_SENTENCE.test(text) || !pointNames.some((name) => FACIAL_ACUPOINTS.test(name))) return text;
  namesAcupoint("");
  const allFacial = pointNames.every((name) => FACIAL_ACUPOINTS.test(name));
  // 句中点名了面部穴位，或句中没点穴名而本卡全是面部穴位：去掉放血那一项；点名到别处穴位的（「内庭可点刺出血」）照留。
  const facialSentence = (sentence: string) => FACIAL_ACUPOINTS.test(sentence) || (allFacial && !acupointNamePattern!.test(sentence));
  return text.split(/(?<=[。；])/).flatMap((sentence) => {
    if (!BLOODLETTING_SENTENCE.test(sentence) || !facialSentence(sentence)) return [sentence];
    const trimmed = sentence.replace(/[、，,或]\s*(?:刺络拔罐|三棱针点刺(?:出血)?(?:后拔罐)?|点刺出血)/gu, "");
    return BLOODLETTING_SENTENCE.test(trimmed) ? [] : [trimmed];
  }).join("").trim() || text;
}

/**
 * 主证是寒（风寒、寒湿、实寒），又没有热、火、瘀、毒、血：不带条件的放血写法不留（2026-10-19 Claude 评审 H-tri-18612：风寒湿痹的膝痹拔罐卡
 *「皮肤针重叩使出血少许，加拔罐」——教材痹病节只对热痹写「局部可点刺出血」，风寒湿痹写「可加用灸法」）。教材写明给寒证的（「瘀血腰痛和
 * 寒湿腰痛可行刺络拔罐」）或带条件的（「疼痛较重者…」「急性腰痛，痛势剧烈者…」「对于顽固性头痛…」）照留。并列写的只去放血那一项
 *（落枕「再针局部的腧穴，可加艾灸或点刺出血」→「…可加艾灸」）。
 */
function withoutUnqualifiedColdBloodletting(text: string, signedSyndromeText: string): string {
  const primary = String(signedSyndromeText || "").split(/[；;]/)[0] || "";
  if (!/寒/u.test(primary) || /热|火|瘀|毒|血/u.test(primary) || !BLOODLETTING_SENTENCE.test(text)) return text;
  return text.split(/(?<=[。；])/).flatMap((sentence) => {
    if (!BLOODLETTING_SENTENCE.test(sentence) || /者|型|证|时|若|如|对于|寒|热|瘀|急性|顽固/u.test(sentence)) return [sentence];
    const trimmed = sentence.replace(/[、，,或]\s*(?:刺络拔罐|三棱针点刺(?:出血)?(?:后拔罐)?|点刺(?:出血|放血))/gu, "");
    return BLOODLETTING_SENTENCE.test(trimmed) ? [] : [trimmed];
  }).join("").trim();
}

function withoutBloodlettingWhenUnsuitable(text: string, input: TextbookPlanInput): string {
  if (!BLOODLETTING_SENTENCE.test(text)) return text;
  const facialLesion = FACIAL_SITE.test(input.currentFacts);
  text = text.split(/(?<=[。；])/).filter((sentence) => !(BLOODLETTING_SENTENCE.test(sentence) &&
    (FACIAL_SITE.test(sentence) || (facialLesion && LESION_LOCAL_SITE.test(sentence))))).join("").trim();
  text = withoutUnqualifiedColdBloodletting(text, input.signedSyndromeText);
  const elderly = input.patientAgeYears != null && input.patientAgeYears >= ELDERLY_AGE_YEARS;
  const deficiency = signedPrimaryHasDeficiency(input.signedSyndromeText, input.signedPrinciple);
  const brokenSkin = BROKEN_SKIN_FACT.test(input.currentFacts);
  if (!elderly && !deficiency && !brokenSkin) return text;
  // 只去放血的那几小句：同一句里另有针法（蛇串疮「皮损局部阿是穴用围刺法，即…向疱疹带中央沿皮平刺，也可在阿是穴散刺出血后加拔火罐」）
  // 时留下针法，此前整句去掉，围刺也跟着没了（2026-10-19 第三轮）。剩下的若只是条件（「急性腰痛，痛势剧烈者」）或没有针刺（「风寒湿痹可加用灸法」
  // 是写给别的证型的），整句去。
  return text.split(/(?<=[。；])/).map((sentence) => {
    if (!BLOODLETTING_SENTENCE.test(sentence)) return sentence;
    const ending = sentence.match(/[。；]\s*$/u)?.[0]?.trim() || "";
    const kept = sentence.replace(/[。；]\s*$/u, "").split(/(?<=[，,])/)
      .filter((clause) => !BLOODLETTING_SENTENCE.test(clause)).join("").replace(/[，,]\s*$/u, "").trim();
    return kept && /刺|针/u.test(kept) && !/者$/u.test(kept) ? `${kept}${ending || "。"}` : "";
  }).join("").trim();
}

// ─── 联网核对的频次（A/B 级来源）─────────────────────────────────────────────

type WebScheduleEntry = {
  disease: string; aliases: string[]; modality: string; schedule: string; techniqueNote: string;
  sourceId: string; sourceTitle: string; publisher: string; tier: string; url: string;
  /** 该频次出自某个西医病种的专篇时，本例须确有该病（西医诊断或病历里出现其中一个词）才引用。 */
  requiresWesternContext?: string[];
  /** 该频次出自老年人专篇时，本例年龄须不小于此值（年龄不详时不引用）。 */
  requiresMinAgeYears?: number;
  /** 该频次出自急性或慢性病专篇时，本例病程（caseCourse）判得出且相反时不引用。 */
  requiresCourse?: "acute" | "chronic";
};
const WEB_SCHEDULES = (webSchedulesJson as unknown as { entries: WebScheduleEntry[] }).entries;

/**
 * 教材该病证节没有单列频次时，用联网核对的 A/B 级来源补：国家/省级中医药管理局诊疗方案优先（A 级先于 B 级）。
 * 病名按名称与别名整词相等匹配；来源与等级写进卡片来源栏，医生看得到这条频次是谁说的。
 */
function webScheduleFor(
  modality: string,
  diseaseNames: readonly string[],
  context?: Pick<TextbookPlanInput, "westernNames" | "currentFacts" | "patientAgeYears" | "chiefComplaint">,
): { schedule: string; citation: string } | undefined {
  const wanted = new Set(diseaseNames.map(diseaseKey).filter(Boolean));
  if (wanted.size === 0) return undefined;
  const westernContext = context ? `${context.westernNames.join("；")}；${context.currentFacts}` : "";
  const hits = WEB_SCHEDULES.filter((entry) => entry.modality === modality &&
    [entry.disease, ...entry.aliases].flatMap((name) => name.split(/[\/、]/)).map((name) => diseaseKey(name.replace(/（[^）]*）/g, "")))
      .some((key) => key && wanted.has(key)))
    // 来源是某个西医病种专篇的频次（眩晕条目的出处是《高血压病》），只用于确有该病的病例：血压正常的眩晕不套高血压的疗程。
    .filter((entry) => !context || !entry.requiresWesternContext || entry.requiresWesternContext.some((term) => westernContext.includes(term)))
    // 人群、病程专篇（2026-10-19 第五轮留出例 S055：36 岁热秘引用《老年便秘（老年功能性便秘）中医诊疗方案》；S128 急性荨麻疹引用
    //《瘾疹（慢性荨麻疹）中医诊疗方案》）。
    .filter((entry) => entry.requiresMinAgeYears == null || (context?.patientAgeYears != null && context.patientAgeYears >= entry.requiresMinAgeYears))
    .filter((entry) => {
      if (!entry.requiresCourse || !context) return true;
      const course = caseCourse(context.westernNames, context.chiefComplaint || "");
      return !course || course === entry.requiresCourse;
    })
    // 老年人不套用留针超过 30 分钟的疗程（针刺量宜小、留针宜短，见 ELDERLY 说明）。
    .filter((entry) => !(context?.patientAgeYears != null && context.patientAgeYears >= ELDERLY_AGE_YEARS && /留针[^。；]{0,12}(?:小时|[4-9]\d\s*分钟|3[1-9]\s*分钟)/.test(entry.schedule)))
    // 12 岁以下不套用写明留针时长的疗程：同卡的小儿说明是「一般不留针」（2026-10-18 留出例 S161 9 岁患儿拿到老年便秘方案的「留针20分钟」）。
    .filter((entry) => !(context?.patientAgeYears != null && context.patientAgeYears < 12 && /留针[^。；]{0,6}\d/.test(entry.schedule)))
    .sort((left, right) => left.tier.localeCompare(right.tier));
  const best = hits[0];
  if (!best) return undefined;
  const label = webSourceLabel(best.publisher, best.sourceTitle);
  return {
    schedule: `${best.schedule.replace(/[。]+$/, "")}（${label}）`,
    citation: `频次来源：${label}（${best.tier}级）`,
  };
}

/**
 * 网络来源在卡片上的写法：发布者 + 《篇名》，不带网址（2026-10-19 甲方病历 7：疗程栏写着
 * 「中国针灸学会（caam.cn 科普之窗·科普知识）《牙痛--中国针灸学会官网》」——网页标题当篇名、英文域名进了正文）。
 * 篇名去掉网页标题里的站点后缀（「--站点名」「|关键词|-站点」「_栏目_…」「 - 站点名」）；发布者去掉域名。网址留在来源快照里备查。
 */
export function webSourceLabel(publisher: string, sourceTitle: string): string {
  const title = String(sourceTitle || "")
    .split(/--|\||_/)[0]
    .replace(/\s+-\s+.*$/u, "")
    .trim();
  const by = String(publisher || "")
    .replace(/[A-Za-z0-9][A-Za-z0-9.-]*\.(?:cn|com|org|net|gov)(?:\.cn)?\b/g, "")
    .replace(/[（(]\s*[）)]/g, "")
    .replace(/[（(]\s+/g, "（")
    .replace(/\s+[）)]/g, "）")
    .trim();
  return title ? `${by}《${title}》` : by;
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

/**
 * 取穴上限内先保证证型配穴与随症配穴（2026-10-19）。此前先截前 12 个再说「加某某」：
 * 痹病四个部位（肩、肘、腕、膝）共 17 个主穴，截完只剩肩肘腕，膝部一穴不剩，行痹的膈俞、血海也被截掉（留出例 S079）；
 * 头痛 20 个主穴，风湿头痛的偏历、阴陵泉被截掉，卡片因此不算「已按证型配穴」，落到院内头痛模板（验收集 X-H-0127/0141）。
 * 主穴按部位分组的病，每个对上的部位各留几穴，不让排在前面的部位占满名额。
 */
function pointsWithinLimit(points: readonly TextbookPlanPoint[], matchedRegions: ReadonlyArray<{ points: readonly string[] }>): TextbookPlanPoint[] {
  const extra = points.filter((point) => point.role !== "base_point");
  const base = points.filter((point) => point.role === "base_point");
  const budget = Math.max(0, POINT_LIMIT - extra.length);
  let keptBase = base.slice(0, budget);
  if (matchedRegions.length > 1 && base.length > budget) {
    const local = base.filter((point) => point.name === "阿是穴").slice(0, 1);
    const per = Math.max(1, Math.floor((budget - local.length) / matchedRegions.length));
    const take = new Set(matchedRegions.flatMap((group) => group.points.slice(0, per)));
    keptBase = [...local, ...base.filter((point) => point.name !== "阿是穴" && take.has(point.name))].slice(0, budget);
  }
  return [...keptBase, ...extra].slice(0, POINT_LIMIT);
}

/**
 * 教材写在基本处方前的治法里，与本例已签名证候相反的那一小句不印（2026-10-19，r1019 验收集）：
 * 虚火牙痛印「祛风泻火」（X-H-0334）、带状疱疹后遗痛（瘀血阻络）印「泻火解毒，清热利湿」（H-tri-9007）、
 * 肝郁阳痿印「补益肾气，荣养宗筋」（M-TCM-BEST4SDT-218）、眩晕「实证」一套对肝阳上亢和痰湿中阻都印「平肝潜阳，和胃化痰」。
 *  · 纯实证不印补益类小句，纯虚证不印泻火类小句（虚实判据与刺络放血、补泻手法同一个 signedSyndromeDeficiencyExcess）；
 *  · 证候里没有热、火、阴虚、燥的，不印清热泻火、解毒、凉血的小句——除非这一小句还说到本例证候里有的病邪（「清热利湿」对湿证照留）；
 *  · 教材分套的治法（multiSet，眩晕实证一套写两个证）：有一小句与本例证候相符时，只留相符的那几小句。
 * 只删小句、不改写；「取某经穴为主」照留。删完没有治法小句时只留取穴说明。
 */
export function therapyClausesForSyndrome(therapy: string, signedSyndromeText: string, multiSet = false): string {
  const syndrome = String(signedSyndromeText || "");
  if (!therapy || !syndrome.trim()) return therapy;
  const [methodPart, ...rest] = therapy.split("。");
  const clauses = methodPart.split(/[，,]/).map((clause) => clause.trim()).filter(Boolean);
  if (clauses.length === 0) return therapy;
  const have = syndromeConcepts(syndrome);
  const nature = signedSyndromeDeficiencyExcess(syndrome);
  const heatish = /热|火|阴虚|阴亏|阴液|津伤|燥/.test(syndrome);
  // 寒象：证名带寒、阳虚、阳衰、虚冷（2026-10-19 留出例 S102：痰湿月经后期印着同节「月经后期」一套的「温经散寒，补血调经」）。
  const coldish = /寒|阳虚|阳衰|阳气不足|虚冷/.test(syndrome);
  const conceptOf = (clause: string) => syndromeConcepts(clause.replace(/[潜平]阳/g, ""));
  const fits = (clause: string) => {
    const concept = conceptOf(clause);
    return [...concept.organs].some((organ) => have.organs.has(organ)) || [...concept.natures].some((item) => have.natures.has(item));
  };
  const conflicts = (clause: string) => {
    if (/^取/.test(clause)) return false;
    // 分套治法写的是那一套里某一脏的证（耳聋「虚证」一套「补肾养窍」写给肾精亏虚），本例证候点了别的脏而没有这一脏时不印
    //（2026-10-19 Claude 评审 H-tri-14837：耳聋·脾胃虚弱证的针刺卡写「治法：补肾养窍」）。只管分套的治法。
    if (multiSet && have.organs.size > 0) {
      const organs = conceptOf(clause).organs;
      if (organs.size > 0 && ![...organs].some((organ) => have.organs.has(organ))) return true;
    }
    if (nature === "excess" && /补益|补肾|温补|益气|补气|补血|养血|滋补|益精|填髓|荣养/.test(clause)) return true;
    if (nature === "deficiency" && /泻火|泻热|清热泻火/.test(clause)) return true;
    if (!coldish && /温经|散寒|祛寒|温阳|温中|温肾|温通/.test(clause) && !fits(clause.replace(/温经|散寒|祛寒|温阳|温中|温肾|温通/g, ""))) return true;
    return !heatish && /泻火|清热|解毒|凉血/.test(clause) && !fits(clause.replace(/泻火|清热|解毒|凉血/g, ""));
  };
  const contentful = multiSet ? clauses.filter((clause) => !/^取/.test(clause) && conceptOf(clause).organs.size + conceptOf(clause).natures.size > 0) : [];
  const chooseMatching = contentful.length >= 2 && contentful.some(fits);
  const kept = clauses.filter((clause) => !conflicts(clause) && !(chooseMatching && contentful.includes(clause) && !fits(clause)));
  if (kept.length === clauses.length) return therapy;
  return [kept.join("，"), ...rest.map((part) => part.trim())].filter(Boolean).join("。");
}

/**
 * 教材操作与疗程句里与年龄不相宜的小句（2026-10-19）。小儿（未满 12 岁）不留针、不写留针时长；老年人（65 岁起）不写重刺激、
 * 强刺激、深刺、久留针——卡片上同时印着「老年人针刺量宜小…浅刺、留针时间宜短」（验收集 H-tri-19029：面痛节「用重刺激手法，
 * 局部穴宜深刺、久留针」与老年提示同卡）。「不可深刺，以免伤及内脏」这类注意句照留。只删小句，删完为空时返回空串。
 */
export function operationClausesForAge(text: string, ageYears: number | undefined): string {
  if (!text || ageYears == null) return text;
  const child = ageYears < 12;
  const elderly = ageYears >= ELDERLY_AGE_YEARS;
  if (!child && !elderly) return text;
  // 深刺（未写「不可、不宜…」的）对小儿与老人都不写：同卡的小儿说明是「宜浅刺、快出针」（2026-10-19 Claude 评审 H-tri-3721：9 岁患儿的
  // 痹证卡写「小儿针刺宜浅刺…」又写「病在筋骨可深刺」）。小儿另不写重刺激、强刺激（同卡「手法宜轻」）。
  const deepNeedling = (clause: string) => /深刺/.test(clause) && !/不可|不宜|勿|避免|禁|以免/.test(clause);
  // 小儿另不写电针：电针要留针通电，与同卡「宜浅刺、快出针，一般不留针」相抵（2026-10-19 Claude 评审 H-tri-3721：9 岁热痹卡「可用电针」）。
  const unsuitable = (clause: string) => child
    ? /留针[^。；，,]{0,8}\d|留针时间宜长|延长留针|久留针|重刺激|强刺激|电针/.test(clause) || deepNeedling(clause)
    : /重刺激|强刺激|久留针|留针时间宜长|延长留针|留针[^。；，,]{0,8}(?:小时|[4-9]\d\s*分钟|3[1-9]\s*分钟)/.test(clause) ||
      deepNeedling(clause);
  return text.split(/(?<=[。；;])/).map((sentence) => {
    if (!unsuitable(sentence)) return sentence;
    const ending = sentence.match(/[。；;]\s*$/)?.[0]?.trim() || "";
    const kept = sentence.split(/(?<=[，,])/).filter((clause) => !unsuitable(clause)).join("").replace(/[，,；;。\s]+$/u, "");
    return kept.trim() ? `${kept}${ending || "。"}` : "";
  }).join("").trim();
}

/**
 * 小儿（未满 12 岁）耳穴只用压丸（贴压），不写毫针、埋针、电针及其刺激量、留针（2026-10-19 留出例 S151、S160：卡上先写「小儿耳穴宜用贴压，
 * 不用毫针」，紧接着教材原句「毫针刺法，或压丸法」）。逐小句去掉用针的做法；一句里的做法全是用针时换成「压丸法」，
 * 「每次选用2~3穴」「耳尖可点刺放血」这类不用针的小句照留。卡片的小儿说明（populationCardNote）本就是「小儿耳穴宜用贴压，不用毫针」；
 * 《针灸学》耳针法：压丸法「疼痛轻微，无副作用，是目前最常用的方法」，「一般儿童、孕妇、年老体弱、神经衰弱者用轻刺激」（教材原文第114947、114948行）。
 * 只用在教材耳穴节的原句上（院内目录的耳穴模板本来就只写贴压，其中「不输出侵入性埋针步骤」这类说明不能按做法改写）。
 */
const EAR_NEEDLE_METHOD = /(?:或用?|也可用?|亦可用?|、)?(?:毫针(?:浅)?刺(?:法)?|埋针(?:法)?|揿针(?:法)?|电针[^，,。；;、或]*)(?:、|或用?)?/g;
const EAR_NEEDLE_PARAMETER = /^(?:用)?(?:强|中等|中|轻|弱)?刺激$|留针|行针|运针/;
export function auricularMethodsForChild(text: string): string {
  if (!text || !/毫针|埋针|揿针|电针/.test(text)) return text;
  return text.split(/(?<=[。；;])/).map((sentence) => {
    if (!/毫针|埋针|揿针|电针/.test(sentence)) return sentence;
    const ending = sentence.match(/[。；;]\s*$/)?.[0]?.trim() || "";
    const clauses = sentence.replace(/[。；;]\s*$/, "").split(/[，,]/).map((clause) => clause.trim()).filter(Boolean);
    let pressInserted = false;
    const hasPress = /压丸|压籽|贴压|王不留行/.test(sentence);
    const kept: string[] = [];
    let removedBefore = false;
    for (const clause of clauses) {
      if (!/毫针|埋针|揿针|电针/.test(clause)) {
        if (EAR_NEEDLE_PARAMETER.test(clause.replace(/^用/, ""))) continue;
        kept.push(removedBefore ? clause.replace(/^(?:或用?|也可用?|亦可用?)/, "") : clause);
        continue;
      }
      removedBefore = true;
      const rest = clause.replace(EAR_NEEDLE_METHOD, "").replace(/^(?:或用?|也可用?|亦可用?|可用|、)+/, "").trim();
      const restIsParameter = !rest || EAR_NEEDLE_PARAMETER.test(rest);
      if (!restIsParameter) {
        kept.push(/压丸|压籽|贴压/.test(rest) || hasPress || pressInserted ? rest : `${rest}用压丸法`);
        pressInserted ||= !/压丸|压籽|贴压/.test(rest) && !hasPress;
      } else if (!hasPress && !pressInserted) {
        kept.push("压丸法");
        pressInserted = true;
      }
    }
    return kept.length > 0 ? `${kept.join("，")}${ending || "。"}` : "";
  }).join("").trim();
}

/**
 * 麻痹性斜视按麻痹的眼外肌配穴（《针灸治疗学》斜视节「内直肌麻痹加睛明、攒竹；外直肌麻痹加瞳子髎、太阳」），病历写的是眼位与眼球运动：
 * 眼球不能向内转（内收受限）、向外斜是内直肌麻痹；不能向外转（外展受限）、向内斜、外展神经（第Ⅵ对脑神经，只支配外直肌）麻痹是外直肌麻痹。
 * 解剖关系是闭集；上下转受限各对两条肌（上直肌与下斜肌、下直肌与上斜肌），判不出是哪条，不在此列（2026-10-19 Claude 评审 H-tri-11654
 *「眼珠不能向内转动」、H-tri-16191「左眼向内斜视」「外展神经麻痹」，卡上只有风池、光明、太冲等远端穴，没有眼周局部穴）。
 */
const EYE_MUSCLE_PALSY_FORMS: Readonly<Record<string, RegExp>> = {
  内直肌麻痹: /(?:眼|目|睛)[^，,。；;]{0,4}(?:不能|难以|无法)向?内(?:转|收|侧运动)|(?:眼|目|睛)[^，,。；;]{0,4}内(?:转|收)(?:受限|不能|不全|障碍)|(?:眼|目|睛)[^，,。；;]{0,4}向?外斜|外斜视/u,
  外直肌麻痹: /(?:眼|目|睛)[^，,。；;]{0,4}(?:不能|难以|无法)向?外(?:转|展|侧运动)|(?:眼|目|睛)[^，,。；;]{0,4}外(?:转|展)(?:受限|不能|不全|障碍)|(?:眼|目|睛)[^，,。；;]{0,4}向?内斜|内斜视|外展神经(?:不全)?麻痹/u,
};

/** 四字随症配穴拆开时，后一半是这类泛词就不放宽到只看前一半首字（「腰骶疼痛」不因「腰部疼痛」成立）。 */
const GENERIC_SYMPTOM_HALVES: ReadonlySet<string> = new Set(["疼痛", "不适", "加重", "发作", "明显", "无力"]);

/**
 * 教材扫描文本里的错字（闭集，每条都对过原书上下文）：生成物保留扫描原文，出卡时改正，与 tcm-textbook-syndromes 的 TEXTBOOK_OCR_FIXES 同一做法。
 * 「顽同性头痛」即「顽固性头痛」（《针灸治疗学》头痛节其他治疗·耳针，第 8995 行；2026-10-19 Claude 评审 H-tri-10297、9376）。
 */
const NONDRUG_TEXTBOOK_OCR_FIXES: ReadonlyArray<readonly [string, string]> = [["顽同性", "顽固性"]];
function textbookOcrFixed(text: string): string {
  return NONDRUG_TEXTBOOK_OCR_FIXES.reduce((value, [wrong, right]) => value.split(wrong).join(right), String(text || ""));
}

/**
 * 痿证节的方案（手足阳明经排刺、补益肢体）只给本例确有肢体痿弱的病历（2026-10-19 Claude 评审 H-tri-5409「四肢肌力、肌张力尚正常」、
 * 以共济失调与构音障碍为主；H-tri-15057 小脑桥脑萎缩，走路不稳、复视、呛咳而上肢不弱——两例都拿到四肢阳明主穴与萎缩排刺）。
 * 痿证的定义是「肢体筋脉弛缓，软弱无力，不能随意运动，或伴肌肉萎缩」（《中医内科学》）：病历写到肢体无力、瘫、下垂、不能抬举握持、
 * 肌力分级下降或肌肉萎缩才算；写明肌力正常而没有分级下降的不算。「脑萎缩」「小脑萎缩」不是肌肉萎缩。闭集。
 */
const MUSCLE_ATROPHY = /(?:肌肉|肌|肢体|鱼际|骨间肌|大腿|小腿|上臂|前臂)[^，,。；;]{0,3}(?:萎缩|瘦削|消瘦)|肉萎|肌肉瘦/u;
const LIMB_WEAKNESS = /无力|痿软|痿弱|瘫|下垂|不遂|弛缓|软弱|不能(?:抬|举|握|行走|站|翘|伸|屈|持)|(?:行走|抬|举|握|站立|上楼|蹲起)[^，,。；;]{0,2}困难|握力[^，,。；;]{0,3}(?:差|下降|减退|减弱)/u;
const STRENGTH_GRADE_DOWN = /肌力[^，,。；;]{0,6}(?:下降|减退|减弱|[0-4]\s*级|[ⅠⅡⅢⅣ]|IV|III|II)/u;
const STRENGTH_NORMAL = /肌力[^，,。；;]{0,6}(?:正常|尚可|5\s*级|Ⅴ级)/u;
/**
 * 写给囊肿的那一段操作（《针灸治疗学》瘿病「…再用一根针从囊肿顶部刺入，直达底部，小幅提插捻转」）：病历没写囊肿、囊性结节时不印
 *（2026-10-19 Claude 评审 H-tri-18842：甲亢弥漫性甲状腺肿）。从说囊肿的小句去到下一个注意小句（注意、以免、避免、勿…）之前。
 */
function withoutCystOnlyClauses(text: string, currentFacts: string): string {
  if (!/囊肿/u.test(text) || /囊/u.test(String(currentFacts || ""))) return text;
  return text.split(/(?<=[。；;])/).map((sentence) => {
    if (!/囊肿/u.test(sentence)) return sentence;
    const ending = sentence.match(/[。；;]\s*$/u)?.[0]?.trim() || "";
    let skipping = false;
    const kept = sentence.replace(/[。；;]\s*$/u, "").split(/(?<=[，,])/).filter((clause) => {
      if (/囊肿/u.test(clause)) { skipping = true; return false; }
      if (skipping && /^\s*(?:注意|以免|避免|勿|切忌|不可)/u.test(clause)) skipping = false;
      return !skipping;
    }).join("").replace(/[，,]\s*$/u, "").trim();
    return kept ? `${kept}${ending || "。"}` : "";
  }).join("").trim() || text;
}
/**
 * 疱疹已结痂脱落、消退，现为后遗神经痛：写给疱疹本身的外治（《针灸学》蛇串疮灸法「疱疹患处阿是穴…或用铺棉灸…覆盖疱疹，从一边点燃」）
 * 不适用（2026-10-19 Claude 评审 H-tri-9007：疱疹愈后半年的灸法卡写急性期的铺棉灸）。病历另写新发疱疹、水疱时照给。
 */
export function herpesLesionHealed(currentFacts: string, westernNames: readonly string[] = []): boolean {
  const text = `${String(currentFacts || "")}；${westernNames.join("；")}`.normalize("NFKC");
  if (/新(?:发|出|起)[^。；;，,]{0,4}(?:疱|疹)|水[疱泡](?!已)/u.test(text.replace(/[^，,。；;]*(?:结痂|脱落|消退|愈合|痊愈|已愈)[^，,。；;]*/gu, ""))) return false;
  return /(?:疱疹|皮疹|水[疱泡])[^。；;]{0,8}(?:结痂|脱落|消退|愈合|痊愈|已愈)|后(?:遗)?神经痛|疱疹愈后/u.test(text);
}

/** 已签名病名、诊断或病机写到外伤（扭伤、骨折、挫伤、跌仆、闪挫…）：居家保健不按这次外伤的瘀滞推体质（home-acupoint-care）。闭集。 */
export function traumaticEtiologyRecorded(text: string): boolean {
  return /扭伤|挫伤|骨折|外伤|创伤|跌仆|跌打|闪挫|脱位|撞伤|摔伤|打伤/u.test(String(text || ""));
}

/** 「上肢肌肉萎缩手阳明经排刺；下肢肌肉萎缩足阳明经排刺」写给有肌肉萎缩的病人：病历没写肌肉萎缩时不印（H-tri-5395「未见胫前及小腿外侧肌肉萎缩」）。 */
function withoutAtrophyOnlyClauses(text: string, currentFacts: string): string {
  if (MUSCLE_ATROPHY.test(String(currentFacts || "").normalize("NFKC"))) return text;
  return text.split(/(?<=[。；;])/).filter((sentence) => !/肌肉萎缩[^。；;]{0,10}排刺/u.test(sentence)).join("").trim() || text;
}
export function limbWeaknessRecorded(currentFacts: string): boolean {
  const facts = String(currentFacts || "").normalize("NFKC");
  if (STRENGTH_GRADE_DOWN.test(facts) || MUSCLE_ATROPHY.test(facts)) return true;
  if (STRENGTH_NORMAL.test(facts)) return false;
  return LIMB_WEAKNESS.test(facts);
}

function acupointPlan(data: ProtocolData, input: TextbookPlanInput): TextbookPlan | undefined {
  const entries = matchDiseaseEntries(data.acupuncture, input.diseaseNames, input.westernNames, input.currentFacts);
  if (entries.length === 0) return undefined;
  // 只在有病历事实时判（textbookPlanExistsForDisease 用空事实问「本病有没有教材方案」）。
  if (entries.some((entry) => entry.disease === "痿证") && compact(input.currentFacts).length > 0 && !limbWeaknessRecorded(input.currentFacts)) return undefined;
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
    base = { points: variant?.mainPoints || primary.mainPoints, content: textbookOcrFixed(variant?.therapy || primary.therapy), system: "body", line: primary.line, entry: primary };
  } else {
    for (const entry of [primary, ...entries.filter((item) => item !== primary)]) {
      const items = entry.projects[code] || [];
      if (items.length === 0) continue;
      // 教材抽取把「皮疹所在部位相应耳穴」的「穴」当成穴名后缀剥掉了，只剩「…相应耳」（2026-10-17 第四轮复测评审）；
      // 原文里紧跟着「穴」的耳穴名补回来。
      const merged = uniq(items.flatMap((item) => item.points.map((point) =>
        item.pointSystem === "ear" && point.endsWith("耳") && item.content.includes(`${point}穴`) ? `${point}穴` : point)));
      const content = textbookOcrFixed(items.map((item) => item.content).join(" "));
      // 「相应病变脏腑（肺、脾、肝、肾）」是取穴说明、括注里才是穴：不把说明本身当一个穴列出（2026-10-19 Claude 评审 H-tri-13758、1173、2579）。
      const optionHeader = (point: string) => {
        const options = content.match(new RegExp(`${point.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}（([^）]+)）`, "u"))?.[1];
        return Boolean(options) && options!.split(/[、，,]/u).map((item) => item.trim()).filter(Boolean).every((item) => merged.includes(item));
      };
      // 「上颌或下颌」按病历写的牙位取一个（2026-10-19 第五轮甲方病历 7 右下牙痛同时列上颌、下颌）；牙位没写或上下都写时两个都留。
      const jawSide = (point: string) => {
        if (!content.includes("上颌或下颌")) return true;
        const upper = /上(?:牙|齿|颌|排牙)/u.test(input.currentFacts);
        const lower = /下(?:牙|齿|颌|排牙)/u.test(input.currentFacts);
        if (upper === lower) return true;
        return point === "上颌" ? upper : point === "下颌" ? lower : true;
      };
      base = {
        points: merged.filter((point) => !optionHeader(point) && jawSide(point)),
        content,
        system: items[0].pointSystem,
        line: items[0].line,
        entry,
      };
      break;
    }
  }
  if (!base || base.points.length === 0) return undefined;
  if (code !== "acupuncture" && /疱疹/u.test(base.content) && herpesLesionHealed(input.currentFacts, input.westernNames)) return undefined;
  // 颜面穴位上的这一项只有放血一种做法（面痛拔罐「取颊车、地仓、颧髎。用三棱针点刺后拔罐。适用于…」），去掉放血后只剩穴名与适用说明、
  // 没有做法：整张不出。
  // 寒证去掉不带条件的放血写法后同样（寒证膝痹的拔罐卡只有「皮肤针重叩使出血少许，加拔罐」一种做法，H-tri-18612）。
  const methodLeft = (text: string) => !text.split(/(?<=[。；])/).every((sentence) => !sentence.trim() || /^(?:取|适用于|多用于|常用于)/.test(sentence.trim()));
  if (code !== "acupuncture" && BLOODLETTING_SENTENCE.test(base.content) &&
    (!methodLeft(withoutFacialPointBloodletting(base.content, base.points)) ||
      !methodLeft(withoutUnqualifiedColdBloodletting(base.content, input.signedSyndromeText)))) {
    return undefined;
  }

  // 主穴按部位分组的病（痹病、头痛、痿证）：只取本例不适部位那几组；对不上部位时痹病只留阿是穴，头痛、痿证保持全部主穴。
  const regionalScheme = code === "acupuncture" ? REGIONAL_MAIN_POINT_GROUPS[base.entry.disease] : undefined;
  const matchedRegions = regionalScheme ? matchedRegionalGroups(regionalScheme, input.currentFacts) : [];
  const regionalBase = regionalScheme && (matchedRegions.length > 0 || regionalScheme.unmatched === "local_only")
    ? (() => {
        const grouped = new Set(regionalScheme.groups.flatMap((group) => group.points));
        const keep = new Set(matchedRegions.flatMap((group) => group.points));
        return base.points.filter((name) => !grouped.has(name) || keep.has(name));
      })()
    : base.points;
  const points: TextbookPlanPoint[] = regionalBase.map((name) => ({ name, role: "base_point" as const }));
  const syndromeLabels: string[] = [];
  let tailored = false;
  let syndromeClause = "";
  const pointMethodNotes: string[] = [];
  // 证型配穴与症状配穴只对针刺主方案做（其他疗法在教材里是固定取穴，没有按证型的配穴表）。
  if (code === "acupuncture") {
    // 各节同型共有的二字组按节算（两本教材各一节），见 sharedKeySymptomGrams。
    const withShared = (entry: AcupunctureEntry) => {
      const sharedGrams = sharedKeySymptomGrams(entry.syndromes);
      return entry.syndromes.map((item) => ({ ...item, sharedGrams }));
    };
    const allSectionTypes = [
      ...withShared(primary),
      ...(secondary ? withShared(secondary) : []),
    ];
    const candidateSyndromes = allSectionTypes.filter((item) => item.addPoints.length > 0);
    const picked = pickSyndromes(candidateSyndromes, input.signedSyndromeText, input.currentFacts, input.diseaseNames,
      input.signedRationale ? { allTypes: allSectionTypes, rationale: input.signedRationale } : undefined);
    if (picked.length > 0) {
      tailored = true;
      // 教材给这一型配穴写了定法（《针灸学》牙痛「配穴太溪用补法，余穴均用泻法」）：两本教材的操作句里点到本例配穴的补泻写进操作栏，
      // 通用的「泻法」就是说主穴（manipulationMatchedToSyndrome 见到点穴的补泻句就不改通用句）。
      const operations = [primary.operation, secondary?.operation || ""].join("。");
      for (const point of uniq(picked.flatMap((item) => item.addPoints))) {
        const method = operations.match(new RegExp(`${point.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:穴)?(?:针)?(?:用|行)(?:提插|捻转)?(补法|泻法)`, "u"))?.[1];
        if (method && !pointMethodNotes.some((note) => note.startsWith(point))) pointMethodNotes.push(`${point}用${method}`);
      }
      // 「在主穴基础上加…」只写穴位表里有的穴：禁针穴（神阙）不列入针刺取穴，正文也不写（2026-10-19 Claude 评审 X-H-0174、0163：
      // 正文「加脾俞、神阙」，穴位表里没有神阙）。
      const addedNames: string[] = [];
      for (const syndrome of picked) {
        syndromeLabels.push(syndrome.label);
        for (const point of syndrome.addPoints) {
          if (NO_NEEDLE_POINTS.has(point)) continue;
          if (!addedNames.includes(point)) addedNames.push(point);
          if (!points.some((existing) => existing.name === point)) points.push({ name: point, role: "syndrome_refinement", syndromeLabel: syndrome.label, note: `${syndrome.label}配穴` });
        }
      }
      syndromeClause = `本例属${picked.map((item) => item.label).join("、")}${addedNames.length > 0 ? `，在主穴基础上加${addedNames.join("、")}` : ""}。`;
    } else if (input.catalogSyndromeRefinement && input.catalogSyndromeRefinement.addPoints.length > 0) {
      // 教材本节没有本例证型（腰痛节无湿热腰痛）、院内目录的证型配穴已命中时：教材主穴 + 目录配穴（2026-10-19 留出例 S086：
      // 目录模板主穴只是「局部阿是穴（查体确认）」「循经远端穴（按疼痛部位选择）」，没有委中、肾俞、大肠俞）。
      const refinement = input.catalogSyndromeRefinement;
      const removed = new Set(refinement.removePoints || []);
      for (let index = points.length - 1; index >= 0; index -= 1) if (removed.has(points[index].name)) points.splice(index, 1);
      const added = refinement.addPoints.filter((point) => !points.some((existing) => existing.name === point) && !NO_NEEDLE_POINTS.has(point));
      if (added.length > 0) {
        tailored = true;
        syndromeLabels.push(refinement.label);
        for (const point of added) points.push({ name: point, role: "syndrome_refinement", syndromeLabel: refinement.label, note: `${refinement.label}配穴`, fromCatalogRefinement: true });
        syndromeClause = `本例属${refinement.label}，在主穴基础上加${added.join("、")}。`;
      }
    }
    // 证型对不上教材的配穴表时只给主穴，不把各证型的配穴整张表列给医生自己挑（2026-10-13，甲方 10.12 测评 5.1/5.2）。
    const facts = compact(input.currentFacts);
    const factClauses = input.currentFacts.split(/[，,。；;\n]/).map(compact).filter(Boolean);
    const symptomParts: string[] = [];
    // 随症配穴里的穴，若教材把它列为本病另一个虚实相反证型的配穴，在已按证型配穴的病例上不加（2026-10-19 留出例 S161：
    // 热秘已配合谷、腹结，又因「大便干结配关元、下巨虚」加了关元——关元是同节虚秘、冷秘的配穴；下巨虚照加）。
    // 同一个穴若也是同性质证型的配穴（关元既是寒湿内盛也是肾阳虚衰的配穴），照加。
    const pickedNature = signedSyndromeDeficiencyExcess(picked.map((item) => item.label).join("；"));
    const natureOf = (item: AcupunctureSyndrome) => signedSyndromeDeficiencyExcess(item.label);
    const sameNaturePoints = new Set(pickedNature ? candidateSyndromes
      .filter((item) => picked.includes(item) || natureOf(item) === pickedNature).flatMap((item) => item.addPoints) : []);
    const oppositeTypePoints = new Set(pickedNature ? candidateSyndromes
      .filter((item) => !picked.includes(item) && natureOf(item) != null && natureOf(item) !== pickedNature)
      .flatMap((item) => item.addPoints).filter((point) => !sameNaturePoints.has(point)) : []);
    for (const item of [...primary.symptomAddPoints, ...(secondary?.symptomAddPoints || [])]) {
      const label = compact(item.symptom).replace(/^(?:素体|兼)/, "");
      const halves = label.length === 4 ? [label.slice(0, 2), label.slice(2)] : [];
      // 四字症状拆成两半时，两半须在同一小句里（2026-10-19：「双下肢无浮肿」的「下肢」与「左侧肢体不遂」的「不遂」拼成了「下肢不遂」）。
      // 后一半与前一半（或前一半的首字，「腹型肥胖」之于「腹部肥胖」）同在一小句才算。
      const halfInClause = (clause: string) => clause.includes(halves[1]) &&
        (clause.includes(halves[0]) || (!GENERIC_SYMPTOM_HALVES.has(halves[1]) && clause.includes(halves[0][0])));
      const present = label.length >= 2 && (facts.includes(label) || (halves.length === 2 && factClauses.some(halfInClause)) ||
        Boolean(EYE_MUSCLE_PALSY_FORMS[label]?.test(`${input.currentFacts}；${input.westernNames.join("；")}`.normalize("NFKC"))));
      if (!present) continue;
      const fresh = item.points.filter((point) => !points.some((existing) => existing.name === point) && !oppositeTypePoints.has(point) && !NO_NEEDLE_POINTS.has(point));
      if (fresh.length === 0) continue;
      for (const point of fresh) points.push({ name: point, role: "conditional_point", note: `本例有「${item.symptom}」加用` });
      symptomParts.push(`${item.symptom}加${fresh.join("、")}`);
    }
    if (symptomParts.length > 0) syndromeClause += `随症配穴：${symptomParts.join("；")}。`;
    // 按经筋分侧取的那一型（踝关节扭伤只写内踝时取《针灸学》「足太阴经筋及阴跷脉病证」的穴，见 REGIONAL_MAIN_POINT_GROUPS）。
    const sideParts: string[] = [];
    for (const region of matchedRegions) {
      const rule = (region as { sideSyndrome?: { label: RegExp; side: string } }).sideSyndrome;
      if (!rule) continue;
      const syndrome = entries.flatMap((entry) => entry.syndromes).find((item) => rule.label.test(item.label) && item.addPoints.length > 0);
      if (!syndrome) continue;
      const fresh = syndrome.addPoints.filter((point) => !points.some((existing) => existing.name === point) && !NO_NEEDLE_POINTS.has(point));
      for (const point of fresh) points.push({ name: point, role: "conditional_point", note: `本例伤在${rule.side}加用` });
      if (fresh.length > 0) sideParts.push(`伤在${rule.side}，按${syndrome.label}取${fresh.join("、")}`);
    }
    if (sideParts.length > 0) syndromeClause += `本例${sideParts.join("；")}。`;
  }

  // 神阙、乳中禁针（神阙只灸）：教材在针灸方案里把神阙列为灸穴，拍平后混进了针刺取穴（2026-10-13 独立评审）。
  const needleable = code === "acupuncture" ? points.filter((point) => !NO_NEEDLE_POINTS.has(point.name)) : points;
  const finalPoints = pointsWithinLimit(needleable, matchedRegions);
  const citation = cite(base.entry);
  if (secondary && code === "acupuncture") cite(secondary);
  const projectName = code === "acupuncture" ? "针刺" : "";
  // 没有按本例证型配穴时，教材写在基本处方前面的那句治法是按病、不是按本例证候定的（血虚肝旺的瘙痒写「疏风清热，润燥止痒」），
  // 与辨证结论对不上：只保留「取某经穴为主」的取穴说明，并写明是按病取的基本穴。
  const acupunctureTherapy = base.content.replace(/[。]+$/, "");
  // 小儿耳穴只用压丸（auricularMethodsForChild）。
  const childEar = code === "auricular" && input.patientAgeYears != null && input.patientAgeYears < 12;
  const projectContent = childEar ? auricularMethodsForChild(base.content) : base.content;
  // 取穴说明也有写成「以督脉、足厥阴、足少阳经穴为主」的（颤证）。
  const takeSentence = (therapy: string) => therapy.split("。").map((part) => part.trim()).filter((part) => /^取/.test(part) || /^以[^。]*为主$/u.test(part)).join("。");
  // 分套写的病判不出该取哪一套时，取穴说明按套写明（「实证取…为主；虚证取…为主」）。此前只留「取…」小句、套名丢了，
  // 卡上是「取手太阴、手足阳明经穴为主。取足少阴经穴为主。」两句互相矛盾（2026-10-19 Claude 评审 X-H-0107、X-H-0047、X-H-0280）。
  const undecidedVariants = code === "acupuncture" && !variant ? (primary.variants || []).filter((item) => item.label && takeSentence(item.therapy)) : [];
  const meridianSentence = undecidedVariants.length >= 2
    ? undecidedVariants.map((item) => `${item.label}${takeSentence(item.therapy)}`).join("；")
    : takeSentence(acupunctureTherapy);
  // 分套治法（眩晕实证一套写肝阳上亢、痰湿中阻两证：「平肝潜阳，和胃化痰」）只留与本例证候相符的那几小句（2026-10-19，
  // 验收集纯肝阳上亢或纯痰湿的 4 例照印整句、评审判治法与证不符）。
  const therapyForCase = therapyClausesForSyndrome(acupunctureTherapy, input.signedSyndromeText, Boolean(variant));
  // 分套治法的小句全与本例证候相反、又没按证型配穴时，与没有分套一样写「按病取基本穴」（留出例 S102 痰湿月经后期）。
  const variantTherapyFits = Boolean(variant) && !/^取/.test(therapyForCase);
  // 按本例证型配了穴时，治法写已签名的那一条，不写教材本病的通用治法（2026-10-19 第五轮留出例 S131 脾虚湿蕴、S132 血虚风燥的
  // 湿疮针刺卡都印着「清热利湿，润燥息风」）。没配上证型配穴时照旧只写按病取的主穴（10/14 起的口径）。
  const signedMethod = String(input.signedMethod || "").trim().replace(/[。]+$/u, "");
  const contentHead = code === "acupuncture" && tailored && signedMethod
    ? `治法：${cutText(signedMethod, 80)}。${meridianSentence ? `${cutText(meridianSentence, 70)}。` : ""}`
    : code === "acupuncture"
    ? tailored || variantTherapyFits || !meridianSentence
      ? /^取/.test(therapyForCase) ? `${cutText(therapyForCase, 80)}。` : `治法：${cutText(therapyForCase, 80)}。`
      // 「（本例证型在教材中没有对应的配穴）」是系统在讲自己查表的结果，不是给医生的治疗内容（2026-10-19 终评 S067 等 8 例点名）：只写按病取的主穴。
      : `按病取基本穴：${cutText(meridianSentence, 70)}。`
    : `${projectName}${cutText(operationClausesForAge(withoutFacialPointBloodletting(withoutBloodlettingWhenUnsuitable(
      withSyndromeMatchedClauses(projectContent, input), input), base.points), input.patientAgeYears), 240)}`;
  const variantOperation = textbookOcrFixed(variant?.operation || primary.operation);
  const operation = code === "acupuncture" ? variantOperation : projectContent;
  // 其他疗法不借针刺的操作句：此前耳穴、拔罐卡的疗程栏里出现「外感咳嗽针用泻法，肺俞可配闪罐」（2026-10-14 独立评审）。
  const ageFit = (text: string) => operationClausesForAge(text, input.patientAgeYears);
  const frequency = ageFit(frequencySentence(withSyndromeMatchedClauses(operation, input)) ||
    (code === "acupuncture" ? frequencySentence(withSyndromeMatchedClauses(primary.operation, input)) : ""));
  const defaultKey = code === "acupuncture" ? "acupuncture" : code === "cupping" ? "cupping" : code === "moxibustion" ? "moxibustion" : "";
  const defaultText = defaultKey ? data.modalityDefaults[defaultKey]?.text || "" : "";
  // 《刺法灸法学》的「…即可出针或留针10～30分钟」是成人的通用写法；未满 12 岁的针刺卡上同时印着「小儿…一般不留针」，
  // 两句矛盾（2026-10-18 留出例 S160、S161 独立评审）。《针灸治疗学》疳证节：「对婴幼儿可采取速刺不留针」（第 11162 行）。
  const childNeedling = code === "acupuncture" && input.patientAgeYears != null && input.patientAgeYears < 12;
  const web = frequency ? undefined : webScheduleFor(code, input.diseaseNames, input);
  // 总论的留针、留罐、施灸时长只是没有专门写法时的通用参考：教材本节、联网频次来源或本项目原文已写了时长（「留针30分钟」「留罐10分钟」
  //「每次8~10壮」「每个部位施灸3～5分钟」）就不再并列总论那一句（2026-10-19 Claude 评审：两种留针时长并列；验收集 37 张针刺卡、6 张罐灸卡）。
  const ownDuration = cardStatesDuration(code, [frequency, web?.schedule || "", base.content, code === "acupuncture" ? textbookOcrFixed(variant?.operation || primary.operation) : ""].join("。"));
  const defaultClause = defaultText && !childNeedling && !ownDuration ? `${defaultText.replace(/[。]+$/, "")}（《刺法灸法学》总论）。` : "";
  // 疗程栏只放频次那几小句：「局部阿是穴施以齐刺…，针后可令局部出血，每日1~2次」只取「每日1~2次」，前半句在操作栏
  //（2026-10-19 第五轮留出例 S145 两栏各印一遍）。
  const frequencyOnly = frequency
    ? (() => {
        const clauses = frequency.replace(/[。]+$/u, "").split(/(?<=[，,])/).filter(isFrequencyClause);
        return clauses.length > 0 ? `${clauses.join("").replace(/[，,]\s*$/u, "").trim()}。` : frequency;
      })()
    : "";
  const schedule = frequency
    ? `${frequencyOnly}${defaultClause ? ` ${defaultClause}` : ""}`
    : web
      ? `${web.schedule}。${defaultClause}`
      : defaultClause
        ? `${defaultClause}间隔与疗程按病情和耐受确定。`
        : "间隔与疗程按病情和耐受确定。";
  // 针刺卡的操作栏：教材操作原句去掉已作疗程栏的那一句（此前「头痛急性发作时每日治疗1-2次…」在疗程栏、操作栏各印一遍）。
  // 其他项目（耳穴、拔罐、灸法）的操作就是治疗内容栏那段教材原文，操作栏不再逐字重抄，只写技术禁忌（2026-10-19 Claude 评审：
  // X-H-0334、0454、0129 等 10 张耳穴卡「技术边界」与「治疗内容」逐字相同）。
  // 只去那一句里说频次的小句，同句的手法照留（「内伤咳嗽针用平补平泻或补法，每日或隔日治疗1次」→「内伤咳嗽针用平补平泻或补法。」）。
  const operationWithoutSchedule = (text: string) => {
    const sentence = frequency.replace(/[。]+$/u, "").trim();
    if (!sentence) return text;
    return text.split(/(?<=[。；;])/).map((part) => {
      if (ageFit(part.replace(/[。；;]\s*$/u, "").trim()) !== sentence) return part;
      const ending = part.match(/[。；;]\s*$/u)?.[0]?.trim() || "。";
      const kept = part.replace(/[。；;]\s*$/u, "").split(/(?<=[，,])/)
        .filter((clause) => !isFrequencyClause(clause))
        .join("").replace(/[，,]\s*$/u, "").trim();
      return kept ? `${kept}${ending}` : "";
    }).join("");
  };
  const freshPointMethods = pointMethodNotes.filter((note) => !variantOperation.includes(note));
  const pointMethodSentence = freshPointMethods.length > 0 ? `配穴${freshPointMethods.join("，")}。` : "";
  const technique = code === "acupuncture"
    ? ageFit(withoutFacialPointBloodletting(withoutBloodlettingWhenUnsuitable(withSyndromeMatchedClauses(
      `${withoutCystOnlyClauses(withoutAtrophyOnlyClauses(operationWithoutSchedule(cutText(variantOperation || "毫针常规针刺。", 420)), input.currentFacts), input.currentFacts)}${pointMethodSentence}`, input), input), base.points)) || "毫针常规刺。"
    : "";
  // 耳穴技术规范的「留置3～7天」说的是压丸贴压；疗程栏已按来源写了换贴间隔或留针时长（「隔日换贴1次」「留针1小时」）时不再并列这一句，
  // 免得两栏互相矛盾（2026-10-19 第五轮甲方病历 7、8）。
  const contraindications = code === "auricular" && /换贴|更换|留针|留置/u.test(schedule)
    ? techniqueContraindications(code).replace(/留置3～7天，?/u, "")
    : techniqueContraindications(code);

  return {
    kind: "acupoint",
    treatmentContent: cutText(`${contentHead}${syndromeClause}`, 1150),
    points: finalPoints,
    items: [],
    scheduleSuggestion: cutText(schedule, 560),
    // 「补泻手法、进针深度」只对用针的项目成立（拔罐、灸法卡上也挂着这句——2026-10-14 复核时发现）。
    techniqueBoundary: cutText(`${technique} ${contraindications}${code === "acupuncture" || (code === "auricular" && !childEar) ? "补泻手法、进针深度以现场查体为准。" : ""}`.trim(), 980) ||
      "操作参数以现场评估为准。",
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
  const tuinaWeb = webScheduleFor("tuina", input.diseaseNames, input);
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

/**
 * 证名字面对不上教材食疗分型时，按证名概念再对一次（2026-10-19 甲方病历 5：虚劳·肺脾两虚证，即《中医诊断学》脾肺气虚证，
 * 教材虚劳节分「肺气虚」「脾气虚」两型，字面对不上，食疗一张都不出）。口径比挑配穴严：教材证型的脏腑与病性概念须全部在本例证名里，
 * 且至少一个是具体病性（气虚、阴虚、湿、热……），只有泛称「虚」的不算——「心虚胆怯」不会再对上「气阴两虚」；本例当前事实里须有该型的辨证要点。
 * 同分取教材里靠前的一型。
 */
function dietSyndromeByConcepts<T extends DietSyndrome>(syndromes: readonly T[], signedSyndromeText: string, currentFacts: string): T | undefined {
  return syndromes
    .map((syndrome, index) => ({ syndrome, index, ...syndromeMatchScore(syndrome.label, signedSyndromeText) }))
    .filter((entry) => entry.score > 0 && [...entry.natures].some((nature) => nature !== "虚") &&
      syndromeEvidencePresent(entry.syndrome.keySymptoms, currentFacts))
    .sort((left, right) => right.score - left.score || left.index - right.index)[0]?.syndrome;
}

/**
 * 方里的药味与本例病历的教材【使用注意】相冲（大便溏泻者慎用的苦杏仁给日泻 7～9 次的病人，2026-10-19 Claude 评审
 * M-TCM-RobustSDT-single_0501）：判据与处方药味同一个 herbRecordCautionConflict（《中药学》使用注意 × 病历阳性面）。
 */
export function recipeConflictsWithRecordedCaution(recipeText: string, currentFacts: string, signedSyndromeText: string): boolean {
  return formulaAnalysisHerbMentions(String(recipeText || "").split("。")[0] || "")
    .some((mention) => !commonFoods().has(mention.token) && Boolean(herbRecordCautionConflict(mention.token, currentFacts, signedSyndromeText)));
}

/** 方子原文里说怎么吃的那一小句（取最后一处，不取写配料用量的小句）。 */
function recipeUsageClause(text: string): string {
  const clauses = String(text || "").split(/[。；;，,]/u).map((clause) => clause.trim()).filter(Boolean);
  for (let index = clauses.length - 1; index >= 0; index -= 1) {
    const clause = clauses[index];
    // 做法步骤（「加白糖拌匀服」，2026-10-19 第五轮留出例 S046）不当服法。
    if (/\d+(?:\.\d+)?\s*(?:g|克)/u.test(clause) || /^(?:备注|注[:：]|注意|加|放|拌|撕|捣|切|洗|去)/u.test(clause)) continue;
    if (/服|饮|食用|佐餐|代茶|早餐|晚餐|空腹|频频/u.test(clause)) return clause;
  }
  return "";
}

function dietPlan(data: ProtocolData, input: TextbookPlanInput): TextbookPlan | undefined {
  const entries = matchDiseaseEntries(data.diet, input.diseaseNames, input.westernNames);
  const entry = entries[0];
  if (!entry) return undefined;
  const recordCautionConflict = (recipeText: string) => recipeConflictsWithRecordedCaution(recipeText, input.currentFacts, input.signedSyndromeText);
  const prescribedScope: PrescribedHerbScope | undefined = input.herbAlreadyPrescribed && input.prescribedHerbNames?.length
    ? { names: input.prescribedHerbNames, has: input.herbAlreadyPrescribed }
    : undefined;
  // 教材里有些食疗方只写「见‘血证’节」这类互见，没有配料与做法，不能当方案给出。
  const safeRecipes = (syndrome: DietSyndrome) => syndrome.recipes.filter((recipe) =>
    recipe.text.length >= 20 && !recipe.text.startsWith("见") && recipeUsesOnlyFoodSafeIngredients(recipe.text) &&
    !recipeExceedsHighRiskHerbDose(recipe.text) && !recipeContradictsDietPrinciple(recipe.text, syndrome.method) &&
    !(input.avoidRichFood && recipeHasRichIngredient(recipe.text)) &&
    !(input.recordedDiabetes && recipeUnsuitableForDiabetes(recipe.text)) &&
    !(input.avoidTea && TEA_LEAF_INGREDIENT.test(String(recipe.text).split("。")[0] || "")) &&
    !recordCautionConflict(recipe.text) &&
    // 方里的食物与处方药味相冲（人参方给莱菔粥）：同一页前后相反，不选这一方（验收集 M-MTCMB-11）。
    !recipeAntagonizesPrescription(recipe.text, prescribedScope) &&
    // 生姜、葱、花椒这类作调料的普通食物不算（目录 commonFoodAllowlist），只看真正的药味。
    !(input.herbAlreadyPrescribed && formulaAnalysisHerbMentions(String(recipe.text).split("。")[0] || "")
      .some((mention) => !commonFoods().has(mention.token) && input.herbAlreadyPrescribed!(mention.token))));
  const format = (syndrome: DietSyndrome, recipe: DietRecipe) =>
    cutText(`${syndrome.label}：${recipe.name}${recipe.classicSource ? `（${recipe.classicSource}）` : ""}：${recipe.text}`, 200);
  // 证型对不上教材的食疗分型就不出食疗（2026-10-13，甲方 10.12 测评 5.1：心虚胆怯证给出了「气阴两虚」的食疗方，
  // 对不上时又把各证型的方子整张列出来）。对得上时只给一个方子：方名、配料与做法都是教材原文。
  const usable = entry.syndromes.filter((syndrome) => safeRecipes(syndrome).length > 0);
  // 字面对上的分型即本例证型：它没有可给的食疗方（方中有非药食同源药材）时就不出食疗，不再按概念换一型
  //（黄疸·热重于湿的方子都含茵陈，按概念会落到「湿热留恋，以除余邪」那一型，那是恢复期）。
  // 主证先于兼证（脾胃虚寒证兼湿热中阻证给脾胃虚寒的方子，不按教材排序先碰上的兼证那一型）。
  const primarySyndrome = String(input.signedSyndromeText || "").split(/[；;]/)[0] || "";
  const literal = entry.syndromes.find((syndrome) => syndromeLabelMatchesSigned(syndrome.label, primarySyndrome)) ||
    entry.syndromes.find((syndrome) => syndromeLabelMatchesSigned(syndrome.label, input.signedSyndromeText));
  const matched = literal
    ? usable.find((syndrome) => syndrome === literal)
    : dietSyndromeByConcepts(usable, input.signedSyndromeText, input.currentFacts);
  if (!matched) return undefined;
  const first = safeRecipes(matched)[0];
  const items = [format(matched, first)];
  // 疗程栏照方子自己的服法写（「每早空腹及午饭前各服半杯」「趁热频服」「泡水代茶饮」）；此前没有「每日N次」时一律写
  //「随三餐食用」，与方子的服法相反（2026-10-19 Claude 评审 X-H-0326、0174、0406、0276、0312）。
  const usage = frequencySentence(first.text) || first.text.split("。").find((part) => part.includes("每日") || part.includes("每天")) ||
    recipeUsageClause(first.text);
  const dietHead = matched.method ? `食疗原则：${matched.method.replace(/[。]+$/, "")}。` : "";
  return {
    kind: "diet",
    // 食疗方进 treatmentContent（无穴项目的 suggestedSitesOrPoints 保持为空，与目录口径一致；
    // 「取穴」「穴位/部位」这类栏目对食疗没有意义，2026-09-29 甲方测评点名）。整条放不下就整条不放，绝不截断食谱。
    treatmentContent: contentWithItems(dietHead, items),
    points: [],
    items,
    scheduleSuggestion: cutText(usage ? `${usage.replace(/[。]+$/, "")}。` : "按方中做法食用，复诊时按症状变化调整。", 560),
    // 病历记有糖尿病时，卡上不再写「糖尿病…请先咨询医生」——开这张卡的就是医生，那句话对本例自相矛盾（2026-10-19 Claude 评审
    // M-TCM-SD-447858：消渴的黄芪山药粥卡自述「糖尿病请先咨询医生」）；改写本例要做的：方中米、山药这类谷薯计入当餐主食量，监测血糖
    //（《成人糖尿病食养指南（2023年版）》：主食定量，粗细搭配；薯类、杂豆替换部分主食）。
    techniqueBoundary: input.recordedDiabetes
      ? `仅作饮食调养，不替代药物治疗；对方中食材过敏者不用，慢性肾病、孕期哺乳期及正在服用抗凝药者请先咨询医生。本例有糖尿病：${DIABETES_STAPLE_FOOD.test(String(first.text).split("。")[0] || "") ? "方中米、山药等谷薯类计入当餐主食量，" : ""}食用后注意监测血糖。`
      : "仅作饮食调养，不替代药物治疗；对方中食材过敏者不用，糖尿病、慢性肾病、孕期哺乳期及正在服用抗凝药者请先咨询医生。",
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

/**
 * 本例病名对上的针刺教材节的节名与又名（头风病 → 头痛节：头痛、头风、头风病、头痛病）。
 * 供出卡处判断院内目录模板对的是不是本病：模板匹配词与这些名字相合即算本病的模板（头痛模板之于头风病、流感模板之于时行感冒）。
 */
export function textbookSectionNames(diseaseNames: readonly string[], westernNames: readonly string[]): string[] {
  if (!textbookNondrugPlansEnabled()) return [];
  const data = protocolData();
  if (!data) return [];
  return uniq(matchDiseaseEntries(data.acupuncture, diseaseNames, westernNames).flatMap(entryKeys));
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

/**
 * 给 M04 写饮食调护栏用的一段参考（2026-10-18）。饮食栏（nonPharma.diet）由模型按例写，食疗卡另走 dietPlan；此前模型写饮食栏时
 * 看不到教材的分证食疗，140 份输出里约一半写「可常食小米粥」「山药粥」（甲方 10.12 测评 5.1「食疗要与辨证相符」）。
 * 这里按食疗卡同一套病名、证型匹配（matchDiseaseEntries + syndromeLabelMatchesSigned）取《中医食疗学》该证的食疗原则与推荐食材，
 * 食材只留药食同源目录与普通食物（recipeUsesOnlyFoodSafeIngredients 同一份目录），不留酒类。对不上分证时返回空串，提示词不变。
 */
export function textbookDietPromptSection(input: { diseaseNames: readonly string[]; westernNames: readonly string[]; signedSyndromeText: string }): string {
  if (!textbookNondrugPlansEnabled()) return "";
  const data = protocolData();
  if (!data) return "";
  const entry = matchDiseaseEntries(data.diet, input.diseaseNames, input.westernNames)[0];
  const matched = entry?.syndromes.find((syndrome) => syndromeLabelMatchesSigned(syndrome.label, input.signedSyndromeText));
  if (!entry || !matched) return "";
  const allowed = homologySet();
  const foods = commonFoods();
  const ingredients = [...new Set(matched.ingredients.map((name) => name.trim()))]
    .filter((name) => name && !/酒/u.test(name) && (allowed.has(name) || foods.has(name)))
    .slice(0, 8);
  if (!matched.method && ingredients.length === 0) return "";
  return [
    `【本证饮食参考（《中医食疗学》${entry.disease}·${matched.label}）】`,
    matched.method ? `食疗原则：${matched.method.replace(/[。]+$/u, "")}。` : "",
    ingredients.length > 0 ? `相宜食材：${ingredients.join("、")}。` : "",
    "nonPharma.diet 按这一原则写：从相宜食材里选 1–2 种写成家常吃法，并写本证要忌的饮食；不要默认写小米粥、山药粥。",
  ].join("");
}
