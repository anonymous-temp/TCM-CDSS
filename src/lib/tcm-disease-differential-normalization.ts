import crosswalkJson from "../data/tcm-western-disease-crosswalk.json" with { type: "json" };
import abbreviationsJson from "../data/western-diagnosis-abbreviations.source.json" with { type: "json" };
import textbookDiseaseNamesJson from "../data/tcm-textbook-disease-names.json" with { type: "json" };
import icd10IndexJson from "../data/icd10-diagnosis-index.json" with { type: "json" };
import { governedTcmDiseaseCode, resolveTcmDiseaseName, textbookSectionDeliveryName } from "./clinical-terminology";
import { textbookDifferentialsForDisease } from "./tcm-textbook-syndromes";

/**
 * 中医病名鉴别栏只收中医病名（2026-09-29，甲方 9.24/9.27 测评 1.1：风寒感冒例的中医鉴别写了「流感」）。
 *
 * 合同侧此前只拦「把证型写进病名鉴别」，词表外写法一律放行，西医病名就这样原样出去了。
 * 这里对每一条病名鉴别：
 *   · 是受治理中医病名（GB/T 15657 正名/别名/临床扩展）→ 原样保留；
 *   · 不是 → 先把西医简称还原成全称，再按教材原句对照表（tcm-western-disease-crosswalk.json）
 *     归一到中医病名：流行性感冒 → 时行感冒。多个候选时取与当前病名不同、且更具体（编码更深）的那个；
 *   · 归一不了 → 这一条丢掉（不能让西医病名冒充中医病名鉴别）。
 */

/** 中医鉴别（病名级、证候级）每栏至少几项：甲方验收「鉴别诊断覆盖率：存在明显需鉴别病种/证候时，至少各有 2 条」。 */
export const MIN_TCM_DIFFERENTIALS = 2;

const TEXTBOOK_DISEASE_NAMES = new Set<string>((textbookDiseaseNamesJson as { names: string[] }).names);

type CrosswalkRow = { westernName: string; tcmDisease: string };

const CROSSWALK = new Map<string, string[]>();
for (const row of (crosswalkJson as { entries: CrosswalkRow[] }).entries) {
  const list = CROSSWALK.get(row.westernName) || [];
  if (!list.includes(row.tcmDisease)) list.push(row.tcmDisease);
  CROSSWALK.set(row.westernName, list);
}
const ABBREVIATIONS = new Map((abbreviationsJson as { entries: Array<{ abbreviation: string; fullName: string }> }).entries
  .map((entry) => [entry.abbreviation, entry.fullName] as const));

function governedCanonical(value: string): string {
  const resolved = resolveTcmDiseaseName(value);
  return resolved && resolved.status !== "unverified" && !resolved.temporary ? resolved.canonical : "";
}

/**
 * 教材对当前病列出的鉴别病名，按教材原样保留（2026-10-17）。
 *
 * 此前只认教材节名与国标条目：「腰痛应与背痛、尻痛相鉴别」里的背痛、尻痛两样都不是，整条丢掉；国标把真头痛收为厥头痛的别名，
 * 于是头痛例的「真头痛：突发剧烈头痛…神昏」被改名成「厥头痛」，描述还是真头痛的（甲方标准病历 3，独立评审）。补写鉴别的小任务
 * 与交付面兜底又各用各的判据：补写只取这里判得过的名字（腰痛、瘾疹一个都没有，于是不补写），兜底却把教材原文整段贴出来
 *（「背痛是指由于身体某组织受伤或怀孕…」）。现在三处都只认这一个函数。
 * 教材外科、妇科各节也列西医病名（瘾疹节的丘疹性荨麻疹、蛇串疮节的肋间神经痛），所以西医写法（对照表或缩写表里有、或带西医构词）
 * 仍走下面的对照归一或丢弃。
 */
export const WESTERN_DISEASE_FORM = /性|炎|综合征|症$|瘤|癌|感染|溃疡|结石|梗[死塞]|增生|硬化|障碍|紊乱|病毒|细菌|神经|血管|细胞|淋巴|[A-Za-z]/u;
/**
 * 只收中医病证名的构词：二到四个字、以痛/疮/痹/汗/衄/证/痨收尾（背痛、尻痛、真头痛、胃脘痛、脱汗、战汗、舌衄、抱儿痨、脓窝疮）。
 * 教材全表 460 对鉴别里，放宽到「教材列了就收」会新收进肠梗阻、直肠息肉、尖锐湿疣、血友病这类西医病名，并让荨麻疹不再归一成瘾疹，
 * 所以只开这一个有限的口子；其余仍走国标与对照表。
 */
const TCM_DIFFERENTIAL_NAME_FORM = /^[\u4e00-\u9fff]{1,3}[痛疮痹汗衄证痨]$/u;
/** 教材句子里的描述性短语（「与内科其他疾病中的虚证鉴别」），不是病名。 */
const DESCRIPTIVE_PHRASE = /其他|疾病|各种|一般|之/u;
function textbookListedTcmDifferential(name: string, currentDisease: string): boolean {
  if (!currentDisease || CROSSWALK.has(name) || ABBREVIATIONS.has(name) || WESTERN_DISEASE_FORM.test(name) || DESCRIPTIVE_PHRASE.test(name)) return false;
  if (!TCM_DIFFERENTIAL_NAME_FORM.test(name)) return false;
  return textbookDifferentialsForDisease(currentDisease).some((item) => item.name === name);
}

let icd10DiseaseNames: Set<string> | undefined;
/** ICD-10 中文病名（含索引别名）。只在要把一个中医病名改成国标正名时才读，第一次用到时建一次。 */
function isIcd10DiseaseName(value: string): boolean {
  if (!icd10DiseaseNames) {
    icd10DiseaseNames = new Set();
    for (const entry of (icd10IndexJson as { entries: Array<{ name?: unknown; aliases?: unknown }> }).entries) {
      if (typeof entry.name === "string") icd10DiseaseNames.add(entry.name);
      if (Array.isArray(entry.aliases)) for (const alias of entry.aliases) if (typeof alias === "string") icd10DiseaseNames.add(alias);
    }
  }
  const name = value.trim();
  return icd10DiseaseNames.has(name) || icd10DiseaseNames.has(name.replace(/病$/u, "")) || icd10DiseaseNames.has(`${name}病`);
}

/**
 * 国标把一个中医病名收为别名、正名却是西医（ICD-10）病名的一类（2026-10-19 Claude 评审验收主集 M，TCM-SD-488343）：
 * 肥胖的教材鉴别「黄胖」归一成了国标正名「钩虫病」，中医鉴别栏里出现寄生虫病名。同类还有 黄肿→钩虫病、寸白虫病→绦虫病、
 * 赤虫病→姜片虫病、蛊虫病→血吸虫病、肺虫病→肺吸虫病、疠风→麻风病、痘疮→天花、核瘟→鼠疫、暑痉→中暑、注车→晕动病、
 * 鼻痔→鼻息肉、肉刺→鸡眼、锁子骨断伤→锁骨骨折这类骨伤旧名（国标 41 个正名）。正名是 ICD-10 病名、又不是教材立节的病名，
 * 而原写法本身不是 ICD-10 病名时，保留原来的中医病名。正名就是教材节名的（肠澼→痢疾、风痧→风疹）照旧归一。
 */
function keepsTcmAliasOverWesternCanonical(name: string, canonical: string): boolean {
  if (TEXTBOOK_DISEASE_NAMES.has(canonical) || TEXTBOOK_DISEASE_NAMES.has(canonical.replace(/病$/u, ""))) return false;
  return isIcd10DiseaseName(canonical) && !isIcd10DiseaseName(name) && !WESTERN_DISEASE_FORM.test(name);
}

export type TcmDiseaseDifferentialNameResolution =
  | { action: "keep"; name: string }
  | { action: "rename"; name: string; from: string }
  | { action: "drop"; from: string };

export function resolveTcmDiseaseDifferentialName(rawName: string, currentDisease = ""): TcmDiseaseDifferentialNameResolution {
  const name = rawName.trim();
  if (!name) return { action: "drop", from: rawName };
  // 教材的节名是可交付的规范病名（clinical-terminology.canonicalTcmDiseaseName 同一口径）：原样保留，
  // 不归一到国标条目（「头痛」→「头风病」），也不因国标没有收录而丢掉（教材的鉴别病名如「奔豚」「热疮」）。
  const textbookName = name.replace(/类病$/u, "");
  if (TEXTBOOK_DISEASE_NAMES.has(textbookName)) {
    // 教材节名是西医病名而教材写明它属哪个中医病的（血栓闭塞性脉管炎 → 脱疽），鉴别栏也写中医病名；与当前病名同一个病时不构成鉴别。
    const delivered = textbookSectionDeliveryName(textbookName);
    return delivered === currentDisease.trim().replace(/类病$/u, "")
      ? { action: "drop", from: name }
      : delivered === name ? { action: "keep", name } : { action: "rename", name: delivered, from: name };
  }
  if (textbookListedTcmDifferential(name, currentDisease.trim().replace(/类病$/u, ""))) return { action: "keep", name };
  const currentCanonical = governedCanonical(currentDisease);
  const direct = governedCanonical(name);
  if (direct) {
    // 与当前病名是同一病名（含别名，如「伤风」对「感冒」之外的同一条目）不构成鉴别。
    if (currentCanonical && direct === currentCanonical) return { action: "drop", from: name };
    // GB/T 15657 把「带状疱疹」「荨麻疹」「湿疹」「偏头痛」收为别名：鉴别栏写正名（蛇串疮/瘾疹/湿疮/偏头风）。
    const compact = (value: string) => value.replace(/\s+/g, "").replace(/病$/, "");
    if (compact(direct) === compact(name) || keepsTcmAliasOverWesternCanonical(name, direct)) return { action: "keep", name };
    return { action: "rename", name: direct, from: name };
  }
  const stripped = name.replace(/（[^（）]*）|\([^()]*\)/g, "").replace(/(?:可能|待排|待排除|待鉴别)$/, "").trim();
  const expanded = [name, stripped, ABBREVIATIONS.get(stripped) || "", ABBREVIATIONS.get(name) || ""].filter(Boolean);
  // 教材写「慢性荨麻疹」「急性胃炎」，模型常写不带病程前缀的「荨麻疹」「胃炎」：前缀不改变归属。
  const withCourse = [...CROSSWALK.keys()].filter((key) =>
    expanded.some((value) => key !== value && key.replace(/^(?:急慢性|急性|慢性)/, "") === value));
  const keys = [...new Set([...expanded, ...withCourse])];
  const current = governedCanonical(currentDisease);
  const currentCode = current ? governedTcmDiseaseCode(current) : "";
  const candidates = [...new Set(keys.flatMap((key) => CROSSWALK.get(key) || []).map(governedCanonical).filter(Boolean))]
    .filter((candidate) => candidate !== current);
  if (candidates.length === 0) return { action: "drop", from: name };
  // 更具体者优先：当前病名的下位病名 > 编码更深者 > 表中先出现者。
  const ranked = candidates
    .map((candidate, index) => {
      const code = governedTcmDiseaseCode(candidate);
      const underCurrent = Boolean(currentCode && code.startsWith(`${currentCode}.`));
      return { candidate, index, underCurrent, depth: code ? code.split(".").length : 0 };
    })
    .sort((left, right) => Number(right.underCurrent) - Number(left.underCurrent) ||
      right.depth - left.depth || left.index - right.index);
  return { action: "rename", name: ranked[0].candidate, from: name };
}

const START_MARKER = "<!-- DIAGNOSIS_JSON_START -->";
const END_MARKER = "<!-- DIAGNOSIS_JSON_END -->";

/** M03 载荷投影：逐条归一 overview.tcmDiseaseDifferentials[].diseaseName，归一不了的条目丢弃。 */
export function normalizeM03TcmDiseaseDifferentialNames(content: string): string {
  const start = content.indexOf(START_MARKER);
  const end = start >= 0 ? content.indexOf(END_MARKER, start + START_MARKER.length) : -1;
  if (start < 0 || end < 0) return content;
  try {
    const reasoning = JSON.parse(content.slice(start + START_MARKER.length, end).trim()) as Record<string, unknown>;
    if (reasoning.stage !== "diagnose") return content;
    const overview = reasoning.overview && typeof reasoning.overview === "object" && !Array.isArray(reasoning.overview)
      ? reasoning.overview as Record<string, unknown>
      : undefined;
    const rows = Array.isArray(overview?.tcmDiseaseDifferentials) ? overview.tcmDiseaseDifferentials : [];
    if (!overview || rows.length === 0) return content;
    const currentDisease = typeof overview.tcmDiseaseName === "string" ? overview.tcmDiseaseName : "";
    let changed = false;
    const seen = new Set<string>();
    const kept = rows.flatMap((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [raw];
      const row = raw as Record<string, unknown>;
      const name = typeof row.diseaseName === "string" ? row.diseaseName : "";
      const resolution = resolveTcmDiseaseDifferentialName(name, currentDisease);
      if (resolution.action === "drop") {
        changed = true;
        console.info("[tcm-cdss:telemetry] tcm_disease_differential_normalized", { action: "drop" });
        return [];
      }
      const finalName = resolution.name;
      if (seen.has(finalName)) {
        changed = true;
        return [];
      }
      seen.add(finalName);
      if (resolution.action === "rename") {
        changed = true;
        console.info("[tcm-cdss:telemetry] tcm_disease_differential_normalized", { action: "rename" });
        const replaceName = (value: unknown) => typeof value === "string" ? value.split(resolution.from).join(finalName) : value;
        return [{ ...row, diseaseName: finalName, reason: replaceName(row.reason), distinguishingPoints: replaceName(row.distinguishingPoints) }];
      }
      return [row];
    });
    if (!changed) return content;
    overview.tcmDiseaseDifferentials = kept;
    return `${content.slice(0, start + START_MARKER.length)}\n${JSON.stringify(reasoning, null, 2)}\n${content.slice(end)}`;
  } catch {
    return content;
  }
}
