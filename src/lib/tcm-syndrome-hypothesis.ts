import syndromeLexiconJson from "../data/tcm-syndrome-lexicon.json" with { type: "json" };
import symptomAxisMapJson from "../data/tcm-symptom-axis-map.source.json" with { type: "json" };

/**
 * 证候假设层（L1a，确定性，零模型）。
 *
 * 存在的理由：M03 之前的方剂检索是「症状字面串 ↔ 主治原文字面串」的重合度打分，它**不认识证候**。
 * 而方名锁定那一端只认签名证候与方剂的受控关系。召回按症状、锁方按证候，两端口径不一致——
 * 实测后果是「失眠+口苦+目赤」（肝火）首位召回二至丸（肝肾阴虚，治疗方向相反），
 * 因为二至丸主治里恰好同时出现口苦/失眠/多梦三个词。字面重合永远分不清
 * 「失眠属心脾两虚」还是「失眠属肝火扰心」，因为区分它们的信息是一个**证候判断**，不是一个词。
 *
 * 本层把病历里的阳性事实映射到病位/病性轴，再用轴一致性从 2050 条受控证候里筛出**假设集**，
 * 供检索多走一条「证候→方」的路。
 *
 * ★ 三条边界 ★
 * 1. **并集语义**：输出只用来增加召回路径。本层失效（无命中）时，检索退回纯症状召回，不多不少。
 * 2. **不是诊断**：这里产出的是「假设」，绝不进入病历事实、不呈现给医生、不参与
 *    positiveSufficiency 与身份锁。医生看到的证候只能来自 M03 在完整病历上辨证并签名的结果。
 * 3. **轴是召回先验，不是标准定义**：证候词表的 governance.scopeNote 已声明 locations/natures 是
 *    「项目规则派生候选，不等同于标准定义或临床裁定」，因此它们只能用于筛候选，不能用于下结论。
 */

type AxisEntry = {
  terms: string[];
  locations: string[];
  natures: string[];
};

type SyndromeAxes = {
  id: string;
  canonical: string;
  locations: Set<string>;
  natures: Set<string>;
  axisCount: number;
};

const AXIS_ENTRIES: AxisEntry[] = (symptomAxisMapJson as { entries: AxisEntry[] }).entries;

const SYNDROME_AXES: SyndromeAxes[] = (() => {
  const lexicon = syndromeLexiconJson as {
    entries: Array<{ id: string; canonical: string; termClass?: string; locations?: string[]; natures?: string[] }>;
    clinicalExtensions?: Array<{ id: string; canonical: string; termClass?: string; locations?: string[]; natures?: string[] }>;
  };
  return [...lexicon.entries, ...(lexicon.clinicalExtensions || [])]
    .filter((entry) => entry.termClass !== "category_heading")
    .map((entry) => ({
      id: entry.id,
      canonical: entry.canonical,
      locations: new Set(entry.locations || []),
      natures: new Set(entry.natures || []),
      axisCount: (entry.locations || []).length + (entry.natures || []).length,
    }))
    .filter((entry) => entry.axisCount > 0);
})();

export type SyndromeHypothesis = {
  syndromeId: string;
  canonical: string;
  /** 命中的轴数；单轴命中不成立（见 MIN_AXIS_MATCHES）。 */
  matchedAxes: number;
  /** 该证候的轴被本例覆盖的比例，用于压制「风寒」这类粗粒度单因素证候。 */
  coverage: number;
  score: number;
};

export type SyndromeHypothesisRerankDecision = {
  syndromeId: string;
  /** 闭集语义相关度，只能在 0–1 之间；它不是诊断置信度。 */
  relevance: number;
};

/**
 * 至少要命中两条轴。单轴命中毫无鉴别力——「heat」一条轴就能挂上 982 条证候，
 * 那等于把噪声当召回。
 */
const MIN_AXIS_MATCHES = 2;

/**
 * 只取前若干条假设。证候→方的分布是长尾且被粗词占据（497 个有方证候里，
 * 「风寒」一个就挂 58 首），不设上限会让一次粗词命中灌入数十首无鉴别力的方。
 */
const MAX_HYPOTHESES = 8;

/** 从已判定为阳性的病历文本里提取病位/病性轴。输入必须是**阳性事实**，否定句不得进来。 */
export function clinicalAxesFromAffirmedText(affirmedTexts: readonly string[]): {
  locations: Set<string>;
  natures: Set<string>;
  matchedTerms: string[];
} {
  const merged = affirmedTexts.join("；");
  const locations = new Set<string>();
  const natures = new Set<string>();
  const matchedTerms: string[] = [];
  for (const entry of AXIS_ENTRIES) {
    const hit = entry.terms.find((term) => merged.includes(term));
    if (!hit) continue;
    matchedTerms.push(hit);
    for (const value of entry.locations) locations.add(value);
    for (const value of entry.natures) natures.add(value);
  }
  applyDerivedNatureAxes(natures);
  return { locations, natures, matchedTerms };
}

/**
 * 组合派生轴。逐症状映射只能表达「这个症状指向哪条轴」，表达不了「两条轴同时成立时等于第三条」，
 * 而阴阳虚正是这种关系：虚 + 寒 = 阳虚，虚 + 热 = 阴虚。这是辨证的基本恒等式，不是启发式。
 *
 * 不补这一层的实测后果：「腰痛3个月，遇冷加重，腰膝酸软」得到 kidney/bones + deficiency/cold，
 * 而「肾阳虚」的轴是 kidney + yang_deficiency（挂 15 首方，含右归丸），一条都对不上，
 * 于是假设集里全是挂 1–3 首方的边缘证候，滋阴的左归丸靠词面重合压过温阳的右归丸——
 * 寒热阴阳搞反是最不能接受的一类错误。
 *
 * 只做加法，不删原轴：deficiency 与 cold 仍然保留，派生轴是追加的第三条线索。
 */
function applyDerivedNatureAxes(natures: Set<string>): void {
  const hasDeficiency = natures.has("deficiency") || natures.has("qi_deficiency");
  if (hasDeficiency && (natures.has("cold") || natures.has("yang_deficiency"))) natures.add("yang_deficiency");
  if (hasDeficiency && (natures.has("heat") || natures.has("yin_deficiency"))) natures.add("yin_deficiency");
}

/**
 * 轴一致性 → 受控证候假设集。
 *
 * 打分刻意同时看「命中数」和「覆盖率」：
 *   · 命中数保证证据量；
 *   · 覆盖率 = 命中轴 / 该证候全部轴，保证**这个证候基本被本例说明白了**，
 *     而不是本例的一堆轴恰好蹭到了某个宽泛证候的一条轴。
 * 只按命中数排会让轴多的宽泛证候永远占先；只按覆盖率排会让单轴证候（覆盖率恒为 1）霸榜。
 */
export function syndromeHypothesesFromAxes(
  locations: ReadonlySet<string>,
  natures: ReadonlySet<string>,
  limit = MAX_HYPOTHESES,
  /**
   * 只考虑**挂得上方**的证候。受控词表 2050 条里只有 497 条有方（75.8% 是检索死点），
   * 不加这道过滤时，按轴拟合度排出来的前几名多半是零方证候，整条路径白跑。
   * 实测：肝火病例的前 5 条假设里有 4 条零方，而真正带龙胆泻肝汤/丹栀逍遥散标签的
   * 「肝火扰心」被挤出榜外——本层唯一的用途就是召回，够不着方的假设对召回没有意义。
   * 这不是放宽标准：过滤只发生在**检索**这一层，与证候是否成立、能否锁方无关。
   */
  eligibleSyndromeIds?: ReadonlySet<string>,
): SyndromeHypothesis[] {
  if (locations.size === 0 && natures.size === 0) return [];
  const scored: SyndromeHypothesis[] = [];
  for (const syndrome of SYNDROME_AXES) {
    if (eligibleSyndromeIds && !eligibleSyndromeIds.has(syndrome.id)) continue;
    let matchedAxes = 0;
    for (const value of syndrome.locations) if (locations.has(value)) matchedAxes += 1;
    for (const value of syndrome.natures) if (natures.has(value)) matchedAxes += 1;
    if (matchedAxes < MIN_AXIS_MATCHES) continue;
    const coverage = matchedAxes / syndrome.axisCount;
    scored.push({
      syndromeId: syndrome.id,
      canonical: syndrome.canonical,
      matchedAxes,
      coverage,
      score: matchedAxes * coverage,
    });
  }
  return scored
    .sort((left, right) =>
      right.score - left.score ||
      right.matchedAxes - left.matchedAxes ||
      left.canonical.localeCompare(right.canonical, "zh-CN"))
    .slice(0, Math.max(0, limit));
}

/** 一步到位：阳性文本 → 证候假设集。 */
export function syndromeHypothesesFromAffirmedText(
  affirmedTexts: readonly string[],
  limit = MAX_HYPOTHESES,
  eligibleSyndromeIds?: ReadonlySet<string>,
): SyndromeHypothesis[] {
  const axes = clinicalAxesFromAffirmedText(affirmedTexts);
  return syndromeHypothesesFromAxes(axes.locations, axes.natures, limit, eligibleSyndromeIds);
}

/**
 * 解析 L1b 闭集重排结果。任何候选外 ID、重复 ID、越界分数或非 JSON 内容都被逐项隔离；
 * 解析失败返回空数组，调用方据此完整回退到 L1a。
 */
export function parseClosedSetSyndromeHypothesisRerank(
  raw: unknown,
  candidateSyndromeIds: ReadonlySet<string>,
): SyndromeHypothesisRerankDecision[] {
  let payload: unknown = raw;
  if (typeof raw === "string") {
    try {
      payload = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!payload || typeof payload !== "object") return [];
  const rankings = (payload as { rankings?: unknown }).rankings;
  if (!Array.isArray(rankings)) return [];

  const seen = new Set<string>();
  const decisions: SyndromeHypothesisRerankDecision[] = [];
  for (const item of rankings) {
    if (!item || typeof item !== "object") continue;
    const syndromeId = (item as { syndromeId?: unknown }).syndromeId;
    const relevance = (item as { relevance?: unknown }).relevance;
    if (
      typeof syndromeId !== "string" ||
      !candidateSyndromeIds.has(syndromeId) ||
      seen.has(syndromeId) ||
      typeof relevance !== "number" ||
      !Number.isFinite(relevance) ||
      relevance < 0 ||
      relevance > 1
    ) {
      continue;
    }
    seen.add(syndromeId);
    decisions.push({ syndromeId, relevance });
  }
  return decisions;
}

/**
 * L1b 只允许在 L1a 已生成的闭集内做最多 +20% 的加性重排。
 *
 * - 不给任何 L1a 假设减分或按模型结果直接过滤；调用方仍可应用既有 Top-K 输出边界；
 * - 不接纳候选外 ID；
 * - 不修改 matchedAxes / coverage；
 * - 无有效结果时严格保持 L1a 的原顺序与分数。
 */
export function applyBoundedSyndromeHypothesisRerank(
  hypotheses: readonly SyndromeHypothesis[],
  decisions: readonly SyndromeHypothesisRerankDecision[],
  limit = hypotheses.length,
): SyndromeHypothesis[] {
  if (hypotheses.length === 0 || decisions.length === 0) {
    return hypotheses.slice(0, Math.max(0, limit));
  }
  const candidateIds = new Set(hypotheses.map((item) => item.syndromeId));
  const relevanceById = new Map(
    decisions
      .filter((item) => candidateIds.has(item.syndromeId) && item.relevance >= 0 && item.relevance <= 1)
      .map((item) => [item.syndromeId, item.relevance] as const),
  );
  if (relevanceById.size === 0) return hypotheses.slice(0, Math.max(0, limit));

  return hypotheses
    .map((item) => {
      const relevance = relevanceById.get(item.syndromeId);
      return relevance == null
        ? { ...item }
        : { ...item, score: item.score * (1 + Math.min(1, Math.max(0, relevance)) * 0.2) };
    })
    .sort((left, right) =>
      right.score - left.score ||
      right.matchedAxes - left.matchedAxes ||
      left.canonical.localeCompare(right.canonical, "zh-CN"))
    .slice(0, Math.max(0, limit));
}
