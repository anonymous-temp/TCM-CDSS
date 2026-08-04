import discriminationGraph from "../data/tcm-formula-discrimination-graph.json" with { type: "json" };

/**
 * 方剂鉴别反证守卫(2026-08-04,根治甲方实测 #7:无汗、脉浮紧的风寒**表实**病例仍推荐
 * 「桂枝合剂」——桂枝汤是太阳中风**表虚有汗**的方,表实无汗恰是它的禁忌)。
 *
 * 根因不是逻辑缺失,而是**数据没被用上**:
 *  · 受治理鉴别图 tcm-formula-discrimination-graph.json 有 167 条边,每条都带
 *    supportTerms/againstTerms —— 「桂枝汤 vs 麻黄汤:有汗/无汗、脉缓/脉紧」正在其中;
 *  · 但这份数据此前**只喂提示词**(tcm-classic-inference),从不做确定性守卫。
 *    于是模型爱推什么推什么,而我们手上明明有确定性反证。
 *  · 中成药通路更彻底:说明书 contraindication 栏(桂枝合剂写着「表实无汗…者禁服」)
 *    此前只被用来算「文档完整度」加分,从不用于排除。
 *
 * 本模块只做一件事:给定方名与病历阳性事实文本,返回命中的**反证词**。
 * 判据全部来自受治理鉴别图,不新增任何手写词表(词表守卫会拦)。
 *
 * 处置分层(调用方决定,本模块不判罚):
 *  · 中成药候选表 —— 反证命中即**排除**。候选表的职责就是只放该放的;把说明书法定禁忌
 *    命中的药摆给医生,正是甲方指出的缺陷,不属于「never-block」保护的范围(它不中断
 *    任何流程,只是不推荐一个错误选项)。
 *  · 汤方候选 —— **降权 + 批注**。汤方是医生在加减化裁的底本,异病同治、反治法都可能成立,
 *    直接删会误伤;把反证摆出来让医生判断才对。
 *
 * 边界:
 *  · 反证词同时也是该方 supportTerms 时**弃权**(数据自相矛盾,不猜);
 *  · 图里没有这个方 ⇒ 返回空,绝不因数据缺口驳回任何方。
 */

type Side = { supportTerms?: string[]; againstTerms?: string[] };
type Edge = {
  from?: string;
  to?: string;
  discriminator?: string;
  sides?: { from?: Side; to?: Side };
  sourceRefs?: string[];
};

const EDGES = ((discriminationGraph as { edges?: Edge[] }).edges || []).filter(Boolean);

/** 方名 → {反证词, 支持词}。同一方可出现在多条边的任一侧,取并集。 */
type TermSets = { against: Set<string>; support: Set<string>; discriminators: Set<string> };
const BY_FORMULA = new Map<string, TermSets>();

function slot(name: string): TermSets {
  const key = normalizeFormulaKey(name);
  let entry = BY_FORMULA.get(key);
  if (!entry) {
    entry = { against: new Set(), support: new Set(), discriminators: new Set() };
    BY_FORMULA.set(key, entry);
  }
  return entry;
}

/** 去空白与常见加减后缀,让「桂枝汤加减」「桂枝汤(加味)」都能落到同一条目。 */
export function normalizeFormulaKey(name: string): string {
  return String(name || "")
    .replace(/\s+/g, "")
    .replace(/[（(].*?[)）]/g, "")
    .replace(/(加减|加味|化裁|变方|类方)$/g, "");
}

for (const edge of EDGES) {
  for (const which of ["from", "to"] as const) {
    const formulaName = edge[which];
    if (!formulaName) continue;
    const side = edge.sides?.[which];
    if (!side) continue;
    const entry = slot(formulaName);
    for (const term of side.againstTerms || []) if (term) entry.against.add(term);
    for (const term of side.supportTerms || []) if (term) entry.support.add(term);
    if (edge.discriminator) entry.discriminators.add(edge.discriminator);
  }
}

export type FormulaCounterEvidence = {
  formulaName: string;
  /** 病历中命中的反证词(该方的对立侧特征)。 */
  matchedAgainstTerms: string[];
  /** 该反证来自哪些鉴别点,供医生核对。 */
  discriminators: string[];
};

/**
 * 返回某方在本例病历事实下的反证据;无反证或图中无此方时返回 undefined。
 *
 * caseFactsText 必须是**已确认为阳性**的病历文本(调用方负责极性过滤)——
 * 把「否认无汗」当成「无汗」会造成反向误伤,这正是本项目反复强调的
 * 「不要把未提及/否定当阳性」那一类。
 */
export function formulaCounterEvidence(
  formulaName: string,
  caseFactsText: string,
): FormulaCounterEvidence | undefined {
  const entry = BY_FORMULA.get(normalizeFormulaKey(formulaName));
  if (!entry) return undefined;
  const text = String(caseFactsText || "");
  if (!text) return undefined;

  const matched: string[] = [];
  for (const term of entry.against) {
    // 同时是支持词 ⇒ 数据自相矛盾(该方既主治又反对同一特征),弃权不判。
    if (entry.support.has(term)) continue;
    if (text.includes(term)) matched.push(term);
  }
  if (matched.length === 0) return undefined;
  return {
    formulaName,
    matchedAgainstTerms: matched.sort((a, b) => b.length - a.length).slice(0, 4),
    discriminators: [...entry.discriminators].slice(0, 2),
  };
}

/** 给医生看的一句话说明(呈现层用)。 */
export function counterEvidenceNotice(items: readonly FormulaCounterEvidence[]): string | undefined {
  if (items.length === 0) return undefined;
  const lines = items.map((item) =>
    `${item.formulaName}：本例出现「${item.matchedAgainstTerms.join("、")}」，` +
    `属该方鉴别点（${item.discriminators.join("；") || "受治理鉴别图"}）的**对立侧**特征`);
  return `⚠️ **方剂鉴别反证**：${lines.join("；")}。依据为本地受治理方剂鉴别图的确定性比对，` +
    `不代表一定错误（可能存在兼夹或先后缓急的考量），但请医生确认后再采纳。`;
}

/** 供构建期/测试使用:图中覆盖的方剂数与边数。 */
export function discriminationGraphCoverage(): { formulas: number; edges: number } {
  return { formulas: BY_FORMULA.size, edges: EDGES.length };
}
