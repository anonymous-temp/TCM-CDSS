/**
 * BM25F（字段加权）倒排检索 —— 可复用检索层的第二层。
 *
 * 为什么值得换掉现有的「子串包含计数」（2026-08-09 实测，2915 张受治理方剂卡 +
 * 2320 条真实医案查询，金标准方名已从查询中剔除防泄漏）：
 *   子串包含基线 nDCG@10 = 0.0619，BM25F(bigram) = 0.1304（2.1×），R@10 10.8% → 22.3%，
 *   而且**更快**：0.87ms → 0.29ms（倒排比全表扫描快）。
 *
 * 参数选择也有实测依据，不要凭直觉改：
 *   · k1=0.9 / b=0.4 优于 1.2/0.75（后者 qB nDCG 掉 9.2%）。这与 Kamphuis 等 ECIR 2020
 *     「八个 BM25 变体之间无显著差异」的复现结论一致——**该调的是 k1/b 和字段权重，
 *     不是挑 BM25+/BM25L/DFR 变体**。
 *   · 字段加权（BM25F）相对扁平 BM25 是免费午餐：+7.5%，成本只是几个常数。
 *
 * 本层只做排序，不做准入。**准入线必须留在调用方**——把绝对阈值改成「取分数前 N」
 * 会让 fail-closed 的「查不到」状态永不可达，那是本项目明令禁止的形状。
 */
import type { ControlledVocabulary } from "./cjk-analyzer";
import { analyze } from "./cjk-analyzer";

export type Bm25FieldSpec<T> = {
  /** 字段名，仅用于调试与权重表。 */
  readonly name: string;
  /** 该字段的权重。命中同一词项时按字段权重累加词频。 */
  readonly weight: number;
  /** 从文档取该字段文本。 */
  readonly text: (doc: T) => string;
};

export type Bm25Options = {
  /** 词频饱和参数。实测 0.9 优于 1.2。 */
  readonly k1?: number;
  /** 长度归一强度。实测 0.4 优于 0.75。 */
  readonly b?: number;
  /** 受控词表最长匹配用的词典；不传则纯 bigram。 */
  readonly vocabulary?: ControlledVocabulary;
  /**
   * 停用词阈值：文档频率超过该比例的词项跳过。
   * 中文 bigram 里高频组合（「之上」「者也」）没有区分度，留着只是拖慢。
   */
  readonly maxDocFrequencyRatio?: number;
  /** 受控词表命中的词项额外加权（高精度路）。 */
  readonly vocabularyRouteBoost?: number;
};

type Posting = { doc: number; tf: number };

export type Bm25Index<T> = {
  readonly size: number;
  search(query: string, limit?: number): Array<{ doc: T; score: number }>;
};

/**
 * 建索引。**在内存里惰性建**，不产出 src/data 产物——对小规模集合（数百到数千文档）
 * 这样零镜像体积代价、零构建期依赖。文档量上万时再考虑构建期产物与体积预算。
 */
export function buildBm25Index<T>(
  docs: readonly T[],
  fields: readonly Bm25FieldSpec<T>[],
  options: Bm25Options = {},
): Bm25Index<T> {
  const k1 = options.k1 ?? 0.9;
  const b = options.b ?? 0.4;
  const maxDfRatio = options.maxDocFrequencyRatio ?? 0.5;
  const vocabBoost = options.vocabularyRouteBoost ?? 1.5;

  const postings = new Map<string, Posting[]>();
  const docLength = new Float64Array(docs.length);

  for (let docIndex = 0; docIndex < docs.length; docIndex += 1) {
    const termFrequency = new Map<string, number>();
    let length = 0;
    for (const field of fields) {
      const raw = field.text(docs[docIndex]);
      if (!raw) continue;
      for (const item of analyze(raw, options.vocabulary)) {
        const routeWeight = item.route === "vocabulary" ? vocabBoost : 1;
        const add = field.weight * routeWeight;
        termFrequency.set(item.term, (termFrequency.get(item.term) || 0) + add);
        length += add;
      }
    }
    docLength[docIndex] = length;
    for (const [term, tf] of termFrequency) {
      let list = postings.get(term);
      if (!list) { list = []; postings.set(term, list); }
      list.push({ doc: docIndex, tf });
    }
  }

  const totalLength = docLength.reduce((sum, value) => sum + value, 0);
  const avgLength = docs.length > 0 ? totalLength / docs.length : 1;
  const dfCap = Math.max(1, Math.floor(docs.length * maxDfRatio));

  return {
    size: docs.length,
    search(query: string, limit = 10) {
      const queryTerms = new Map<string, number>();
      for (const item of analyze(query, options.vocabulary)) {
        const weight = item.route === "vocabulary" ? vocabBoost : 1;
        queryTerms.set(item.term, (queryTerms.get(item.term) || 0) + weight);
      }
      if (queryTerms.size === 0) return [];

      const scores = new Map<number, number>();
      for (const [term, queryWeight] of queryTerms) {
        const list = postings.get(term);
        if (!list || list.length > dfCap) continue;
        // 标准 BM25 IDF（加 0.5 平滑，下界 0 防止高频词负贡献）。
        const idf = Math.max(0, Math.log(1 + (docs.length - list.length + 0.5) / (list.length + 0.5)));
        if (idf === 0) continue;
        for (const posting of list) {
          const norm = 1 - b + b * (docLength[posting.doc] / (avgLength || 1));
          const contribution = idf * ((posting.tf * (k1 + 1)) / (posting.tf + k1 * norm)) * queryWeight;
          scores.set(posting.doc, (scores.get(posting.doc) || 0) + contribution);
        }
      }
      return [...scores.entries()]
        .sort((a, b2) => (b2[1] - a[1]) || (a[0] - b2[0]))
        .slice(0, Math.max(0, limit))
        .map(([docIndex, score]) => ({ doc: docs[docIndex], score }));
    },
  };
}
