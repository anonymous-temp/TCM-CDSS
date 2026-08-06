import tcmAcupointJson from "../data/tcm-acupoint-evidence-catalog.json" with { type: "json" };

/**
 * T12 穴位证据层（《经络腧穴学》规划教材,399 穴：361 经穴 + 印堂(DU29) + 37 经外奇穴）。
 * 定位/主治/操作只作医师参考证据,不构成可执行指令——针刺项目 executable=false 边界不变。
 * 构建:scripts/ingest/acupoint-evidence-extract.mjs（确定性解析,零模型调用）。
 */

export type TcmAcupointEntry = {
  code: string;
  name: string;
  pinyin: string;
  meridian: string;
  specialClass?: string;
  location: string;
  indications: string[];
  operation?: string;
  classicalExcerpts?: string[];
  sourceRef: string;
};

type AcupointCatalog = {
  schemaVersion: string;
  evidenceTier: string;
  governance: Record<string, unknown>;
  meridianCoverage: string[];
  entries: TcmAcupointEntry[];
};

const catalog = tcmAcupointJson as unknown as AcupointCatalog;

export const TCM_ACUPOINTS: readonly TcmAcupointEntry[] = catalog.entries;
export const TCM_ACUPOINT_MERIDIAN_COVERAGE: readonly string[] = catalog.meridianCoverage;

const BY_CODE = new Map(TCM_ACUPOINTS.map((e) => [e.code, e]));
const BY_NAME = new Map(TCM_ACUPOINTS.map((e) => [e.name, e]));

/** 常见同名/俗称归一（教材正名为准,只收不歧义的）。 */
const ACUPOINT_ALIASES: Readonly<Record<string, string>> = {
  人中: "水沟",
  神阙旁: "天枢",
};

/** 模板穴位字段的确定性归一：去「双侧」前缀、去括注、取「或」二选一的首项、去空白。 */
export function normalizeAcupointSiteName(raw: unknown): string {
  return String(raw || "")
    .replace(/（[^）]*）|\([^)]*\)/g, "")
    .replace(/^双侧/, "")
    .split(/[或、,，/]/)[0]
    .replace(/\s+/g, "")
    .trim();
}

export function resolveAcupoint(raw: unknown): TcmAcupointEntry | undefined {
  const name = normalizeAcupointSiteName(raw);
  if (!name) return undefined;
  return BY_NAME.get(name) || BY_NAME.get(ACUPOINT_ALIASES[name] || "");
}

export function getAcupointByCode(code: string): TcmAcupointEntry | undefined {
  return BY_CODE.get(String(code || "").toUpperCase());
}

/** 名称形如穴位（在目录或可解析别名内）而不需要额外语境即可查证的判定。 */
export function isKnownAcupointName(raw: unknown): boolean {
  return resolveAcupoint(raw) !== undefined;
}

/**
 * 按**本例主症**从受控穴位目录选穴（2026-08-05，甲方 6.1）。
 *
 * 甲方实测：风寒束表例（淋雨后、恶寒重发热轻、流清涕、无汗、脉浮紧），右侧穴位栏写着
 * 「常用穴位（通用参考，未按本例适应证核定）」——那句话本身就说明了问题：给的是一个
 * 通用穴位池，不是辨证后的处方。
 *
 * 追下去发现是同一个老形状：**治理数据在库里，运行时没读**。本目录 400 个穴位每一个都带
 * `indications`（教材主治），而运行时选穴走的是「把该项目全部模板的穴位按出现频次取 top5」——
 * 与本例是什么证、什么症，一点关系都没有。
 *
 * 改为按主治逐条匹配后（实测）：
 *   风寒感冒 → 合谷、风门、风池、列缺        脾虚泄泻 → 天枢、足三里、公孙、阴陵泉
 *   失眠心悸 → 神门、心俞、四神聪、安眠
 * 都是教材级取穴，而且**每一穴都能说出是本例哪个症把它选进来的**。
 *
 * 边界不变：仍是证据层参考，`executable=false` 一条未动，具体选穴、补泻、深度、留针
 * 仍由现场医师按适应证与禁忌确定。本函数只把「凭什么是这几个穴」从「出现得多」
 * 换成「主治与本例主症对得上」。
 */
export type AcupointIndicationMatch = {
  entry: TcmAcupointEntry;
  matchedTerms: string[];
};

/** 特定穴优先级：同分时按临床取穴惯例排序，保证结果稳定且不随目录顺序漂移。 */
function specialClassRank(entry: TcmAcupointEntry): number {
  const text = entry.specialClass || "";
  if (/原穴/.test(text)) return 0;
  if (/络穴/.test(text)) return 1;
  if (/背俞穴|募穴/.test(text)) return 2;
  if (/五输穴|合穴|输穴|荥穴|井穴|经穴/.test(text)) return 3;
  if (/交会穴/.test(text)) return 4;
  return 5;
}

export function selectAcupointsForCaseTerms(
  terms: readonly string[],
  limit = 6,
): AcupointIndicationMatch[] {
  const cleaned = [...new Set(terms
    .map((item) => String(item || "").trim())
    .filter((item) => item.length >= 2))];
  if (cleaned.length === 0) return [];
  const scored: Array<{ entry: TcmAcupointEntry; matchedTerms: string[] }> = [];
  for (const entry of TCM_ACUPOINTS) {
    const indicationText = (entry.indications || []).join("；");
    if (!indicationText) continue;
    const matchedTerms = cleaned.filter((term) => indicationText.includes(term));
    if (matchedTerms.length === 0) continue;
    scored.push({ entry, matchedTerms });
  }
  return scored
    .sort((left, right) =>
      right.matchedTerms.length - left.matchedTerms.length ||
      specialClassRank(left.entry) - specialClassRank(right.entry) ||
      left.entry.code.localeCompare(right.entry.code))
    .slice(0, Math.max(1, limit));
}
