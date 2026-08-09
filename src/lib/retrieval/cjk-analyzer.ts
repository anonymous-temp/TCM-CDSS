/**
 * 中文（CJK）词法分析器 —— 可复用检索层的第一层。
 *
 * 为什么不是「上 jieba / Intl.Segmenter 就完了」（2026-08-09 实测，全部在本仓语料上跑过）：
 *   · Node 自带 `Intl.Segmenter('zh-Hans')` 对中医术语几乎全线失效：
 *     证候词 3164 条只有 1.0% 被切成单一词，方名 2949 条只有 0.3%，药名 15.2%
 *     （黄芪→黄/芪、白术→白/术、厚朴→厚/朴）。通用中文分词器不认专业术语。
 *   · SQLite FTS5 的 unicode61 对无空格中文返回 0 命中，trigram 对 2 字词（「脾虚」）也是 0。
 *
 * 因此采用**两路并存**，这是本项目独有的先验（已有高质量受控词表）带来的选择：
 *   1) 受控术语最长匹配 —— 高精度。词表来自证候/疾病/治法/方名/药名等受治理来源。
 *   2) 字符 bigram 兜底 —— 无 OOV、无词典维护，对长查询召回最好。
 * 实测（2915 张方剂卡 / 2320 条真实医案查询）：短查询词表路更好（nDCG +6.8%），
 * 长查询 bigram 路明显更好（+35%）。两路都产出、由上层按字段权重合成。
 *
 * 本层不做任何临床判断，只做字符切分——不属于 clinical-vocabulary 治理范围。
 */

/** 一个词项及其来源路，供上层按路加权。 */
export type AnalyzedTerm = {
  term: string;
  /** term 来自受控词表最长匹配，还是字符 bigram 兜底。 */
  route: "vocabulary" | "bigram";
};

const CJK = /[一-鿿]/;
const ASCII_TOKEN = /[a-zA-Z0-9][a-zA-Z0-9.\-+]*/g;

/**
 * 受控术语词典。用**最长匹配、非重叠**扫描：与 `includes()` 的重叠子串语义不同，
 * 非重叠会让命中的轴数严格减少，上层若依赖轴数判定必须自行核对口径。
 */
export type ControlledVocabulary = {
  /** 词 → 该词的最小长度分桶，扫描时按长度倒序尝试。 */
  readonly terms: ReadonlySet<string>;
  readonly maxTermLength: number;
};

export function buildControlledVocabulary(terms: Iterable<string>): ControlledVocabulary {
  const set = new Set<string>();
  let max = 0;
  for (const raw of terms) {
    const term = String(raw || "").trim();
    // 单字不进词表：单字命中率极高但区分度极低，会把「气」「热」这类字变成噪声词项。
    if (term.length < 2) continue;
    set.add(term);
    if (term.length > max) max = term.length;
  }
  return { terms: set, maxTermLength: max || 2 };
}

/** 归一：去空白与常见标点，保留汉字/字母/数字。大小写统一为小写。 */
export function normalizeForRetrieval(value: string): string {
  return String(value || "")
    .toLowerCase()
    .replace(/[\s　]+/g, "")
    .replace(/[。．，,、；;：:！!？?（）()【】\[\]「」『』《》〈〉"'`~·…—\-_/\\|]+/g, "");
}

/**
 * 切分为词项。受控词表命中的片段**不再**参与 bigram（避免同一段文字被双重计数），
 * 未命中的连续汉字段落走 bigram。
 */
export function analyze(value: string, vocabulary?: ControlledVocabulary): AnalyzedTerm[] {
  const text = normalizeForRetrieval(value);
  if (!text) return [];
  const out: AnalyzedTerm[] = [];

  // ASCII/数字整体成词（药品规格、检验项等）。
  for (const match of text.matchAll(ASCII_TOKEN)) {
    if (match[0].length >= 2) out.push({ term: match[0], route: "vocabulary" });
  }

  let index = 0;
  let pendingBigramStart = -1;
  const flushBigrams = (end: number) => {
    if (pendingBigramStart < 0) return;
    const segment = text.slice(pendingBigramStart, end);
    for (let i = 0; i + 1 < segment.length; i += 1) {
      const bigram = segment.slice(i, i + 2);
      if (CJK.test(bigram[0]) || CJK.test(bigram[1])) out.push({ term: bigram, route: "bigram" });
    }
    // 单字段落也要产出，否则「痰」这类单字查询完全没有词项。
    if (segment.length === 1 && CJK.test(segment)) out.push({ term: segment, route: "bigram" });
    pendingBigramStart = -1;
  };

  while (index < text.length) {
    let matched = "";
    if (vocabulary && CJK.test(text[index])) {
      const maxLen = Math.min(vocabulary.maxTermLength, text.length - index);
      for (let len = maxLen; len >= 2; len -= 1) {
        const candidate = text.slice(index, index + len);
        if (vocabulary.terms.has(candidate)) { matched = candidate; break; }
      }
    }
    if (matched) {
      flushBigrams(index);
      out.push({ term: matched, route: "vocabulary" });
      index += matched.length;
      continue;
    }
    if (pendingBigramStart < 0) pendingBigramStart = index;
    index += 1;
  }
  flushBigrams(text.length);
  return out;
}

/** 只要词项字符串，按出现次数保留（BM25 需要词频）。 */
export function analyzeTerms(value: string, vocabulary?: ControlledVocabulary): string[] {
  return analyze(value, vocabulary).map((item) => item.term);
}
