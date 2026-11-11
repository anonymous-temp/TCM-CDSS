import originalCompositionsJson from "../data/tcm-formula-original-compositions.json" with { type: "json" };

/**
 * 原方组成的唯一权威（2026-11-10 第四十二轮，根因一）。
 *
 * 表 tcm-formula-original-compositions.json：键（方名, 出处书[, variant]），每条的药味、原文炮制、煎服法里的药引都摘自原书原文
 *（生成器 scripts/build-formula-original-compositions.py，输入 tcm-formula-original-compositions.source.json 带逐字摘句）。
 *
 * 为什么：受治理方剂目录里 545 条来自深圳《中药方剂编码规则》（调剂标准），药名是调剂品名（姜天麻、煅石决明、黄芩片），
 * 组成有的被现代改过（人参养荣汤多枸杞子、首乌藤而无肉桂），出处却标原书；「原方」核对又拿同一条目录去比，所以通过。
 * 「原方」措辞、「加减」后缀、药引、原方炮制、出处此前各读各的（目录、教材「常用药」、方解、original-text 表）。
 * 现在这几件事只读这张表；表里没有的方，系统不写「原方」。目录条目（含深圳标准）与教材「常用药」不是原方依据。
 *
 * 本模块只做数据访问（不依赖药味身份函数，避免与 tcm-formula-provenance 循环引用）；按药味身份比对由调用方做。
 */
export type OriginalFormulaHerb = {
  /** 饮片基础名（不带炮制）。 */
  herb: string;
  /** 原文写法。 */
  written: string;
  /** 原文写明的炮制（炙、炒、煅、酒…）。 */
  preparation?: string;
  /** 这味的原文炮制交付时随方写进药名（国家经典名方目录原文、通行的甘草炙/黄芪炙/酸枣仁炒、《方剂学》同方照写的）。 */
  deliver?: boolean;
};

export type OriginalFormula = {
  name: string;
  /** 规范书名，不带书名号。 */
  book: string;
  /** 同一本书里有几首同名方时的主治要点。 */
  variant?: string;
  /** 原书里的方名或通行异写（人参养营汤）。 */
  aliases?: string[];
  /** 引这首方时用的其他书名（教材、目录写的出处与原书不同）。 */
  citedBooks?: string[];
  tier: "original_text" | "national_catalog" | "fangjixue" | "textbook_appendix" | "modern_source";
  herbs: OriginalFormulaHerb[];
  /** 煎服法里另加、不在药味表里的药引（基础名）。 */
  guides: string[];
  /**
   * 原书自注或通行本的异文：与正文差几味、同样算原方（《局方》川芎茶调散正文香附子，小注「别本作细辛」，《方剂学》取别本）。
   * add/remove 是相对正文药味的增减（基础名）。
   */
  alternates?: Array<{ add: string[]; remove: string[]; basis: string }>;
  evidence: { kind: string; ref: string; url?: string; quote: string };
};

const TABLE = originalCompositionsJson as unknown as {
  substitutions: Array<{ original: string; substitutes: string[]; reason: string }>;
  equivalentHerbNames: string[][];
  bookAliases: Record<string, string>;
  entries: OriginalFormula[];
  textbookCitations: Record<string, Record<string, string>>;
};

/** 方名查找键：去掉出处括注、空白标点与「加减/化裁/加味」后缀。 */
export function originalFormulaNameKey(name: string): string {
  return String(name || "")
    .replace(/[（(]?\s*《[^》]{1,80}》[^）)]{0,12}[）)]?/gu, "")
    .replace(/[\s·•，,。；;：:（）()【】\[\]“”"']/gu, "")
    .replace(/(?:加减方?|化裁方?|加味方?)$/u, "")
    .trim();
}

/**
 * 出处写法 → 规范书名：取第一个《》里的书名，去掉卷次与篇名，简称换全称（《局方》卷五 → 太平惠民和剂局方）。
 * 没有书名号时把整串当书名处理；空串返回空串。
 */
export function canonicalFormulaBook(source: string | undefined | null): string {
  const raw = String(source || "").trim();
  if (!raw) return "";
  const quoted = raw.match(/《([^》]{1,40})》/u)?.[1] ?? raw;
  const withoutVolume = quoted.replace(/卷[一二三四五六七八九十百上中下之\d]+.*$/u, "").replace(/^[·•\s]+|[·•\s]+$/gu, "");
  if (TABLE.bookAliases[withoutVolume]) return TABLE.bookAliases[withoutVolume];
  const head = withoutVolume.split(/[·•]/u)[0];
  return TABLE.bookAliases[head] || head;
}

const byName = new Map<string, OriginalFormula[]>();
for (const entry of TABLE.entries) {
  for (const name of [entry.name, ...(entry.aliases || [])]) {
    const key = originalFormulaNameKey(name);
    if (!key) continue;
    const list = byName.get(key) || [];
    if (!list.includes(entry)) list.push(entry);
    byName.set(key, list);
  }
}

/** 这个方名（含异写）在表里的全部条目，各书各一条。 */
export function originalFormulasNamed(name: string): readonly OriginalFormula[] {
  return byName.get(originalFormulaNameKey(name)) || [];
}

function entryMatchesBook(entry: OriginalFormula, book: string): boolean {
  return entry.book === book || (entry.citedBooks || []).includes(book);
}

/**
 * （方名, 出处书）在表里的那一条。
 *  · 给了出处：只取那本书的条目（书不同就是没有，不借别的书的同名方）；同一本书有几首同名方时取不带 variant 的那首，都带则取第一首。
 *  · 没给出处：这个方名在表里只有一本书的条目时取它；有几本书的，取条目方名（不是别名）与所问方名相同的那几条里唯一的一条；否则不取。
 */
export function originalFormula(name: string, source?: string | null): OriginalFormula | undefined {
  const candidates = originalFormulasNamed(name);
  if (candidates.length === 0) return undefined;
  const book = canonicalFormulaBook(source);
  if (book) {
    const matched = candidates.filter((entry) => entryMatchesBook(entry, book));
    return matched.find((entry) => !entry.variant) || matched[0];
  }
  const books = new Set(candidates.map((entry) => entry.book));
  if (books.size === 1) return candidates.find((entry) => !entry.variant) || candidates[0];
  const key = originalFormulaNameKey(name);
  const exact = candidates.filter((entry) => originalFormulaNameKey(entry.name) === key);
  return new Set(exact.map((entry) => entry.book)).size === 1 ? exact.find((entry) => !entry.variant) || exact[0] : undefined;
}

/** 教材行里这首方写的出处书（「白术散（《全生指迷方》）」，或该教材方剂索引里的出处）；教材没写的返回 undefined。 */
export function textbookRowFormulaBook(rowId: string | undefined | null, formulaName: string): string | undefined {
  if (!rowId) return undefined;
  const cited = TABLE.textbookCitations[rowId];
  if (!cited) return undefined;
  const key = originalFormulaNameKey(formulaName);
  for (const [name, book] of Object.entries(cited)) {
    if (originalFormulaNameKey(name) === key) return book;
  }
  return undefined;
}

/**
 * 原方里今天依法或通行以他药替代的药（犀角→水牛角）：处方用了替代品仍算原方，目录条目写替代品也不算与原方不一致。
 * 清单与依据在 tcm-formula-original-compositions.source.json 的 substitutions。
 */
export function originalHerbAcceptedSubstitutes(herb: string): string[] {
  return TABLE.substitutions.filter((item) => item.original === herb).flatMap((item) => item.substitutes);
}

const equivalentGroupOf = new Map<string, number>();
TABLE.equivalentHerbNames.forEach((group, index) => group.forEach((name) => equivalentGroupOf.set(name, index)));

/** 同一味药的不同写法（古名、处方名、规格名）是否在同一组（表的 equivalentHerbNames）。 */
export function originalHerbNamesEquivalent(left: string, right: string): boolean {
  const group = equivalentGroupOf.get(left);
  return group !== undefined && group === equivalentGroupOf.get(right);
}

/** 出处显示用：《书名》。 */
export function originalFormulaSourceLabel(entry: OriginalFormula): string {
  return `《${entry.book}》`;
}

export function originalFormulaTableStatus(): { entries: number; textbookRowsWithCitations: number } {
  return { entries: TABLE.entries.length, textbookRowsWithCitations: Object.keys(TABLE.textbookCitations).length };
}
