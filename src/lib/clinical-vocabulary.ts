import affirmativeNegation from "../data/tcm-affirmative-negation-forms.json" with { type: "json" };
import derived from "../data/clinical-vocabulary-derived.json" with { type: "json" };

/**
 * 临床词表的**唯一**运行时入口(2026-08-04 根治「代码内手写词表」元问题)。
 *
 * 规矩:任何用于**临床语义判断**的词表——病位词、病性词、人群限定词、证候→轴分解——
 * 只能经此模块读取生成物 `clinical-vocabulary-derived.json`(由 build:clinical-vocabulary
 * 从受治理词表 + tcm-population-scope.source.json 生成)。模块内不得再出现手写中文词表;
 * 新增手写词表由 scripts/test-clinical-vocabulary-single-source.mjs 在确定性回归里拦截。
 *
 * 为什么这条规矩值得用测试强制:手写表与受治理词表必然漂移,而漂移的表现就是一个个临床
 * 缺陷(方向判错、人群误伤、等价判 0 分)。逐个修永远修不完——下一个人还会手写下一张表。
 * 词表集中后,改一处即全局生效,且每张表都有 basis 可审计。
 *
 * 本模块只做**词法层**判断(某段文本命中了哪些受控病位/病性/人群词),不做临床裁决;
 * 裁决逻辑(轴一致/对立、加减分、门禁)仍在各自的领域模块里。
 */

type LexEntry = { id: string; canonical: string; forms: string[] };
type Derived = {
  locations: Array<LexEntry & { system: string | null }>;
  natures: Array<LexEntry & { kind: string | null }>;
  syndromeAxes: Record<string, { id: string; locations: string[]; natures: string[] }>;
  populations: Record<string, string[]>;
  counts: Record<string, number>;
};

const VOCAB = derived as unknown as Derived;
const AFFIRMATIVE_NEGATION_FORMS = new Set(
  ((affirmativeNegation as { terms?: Array<{ term: string }> }).terms || []).map((row) => row.term),
);

export type PopulationScopeGroup = "maternal" | "obstetric" | "pediatric" | "geriatric" | "broad";

/** 生成物自检:任一维度为空说明生成器或上游词表出了问题,宁可显式失败也不静默降级。 */
export function clinicalVocabularyCounts(): Record<string, number> {
  return { ...VOCAB.counts };
}

function matchedIds(text: string, entries: readonly LexEntry[]): string[] {
  const value = String(text || "");
  if (!value) return [];
  const hits: string[] = [];
  for (const entry of entries) {
    if (entry.forms.some((form) => value.includes(form))) hits.push(entry.id);
  }
  return hits;
}

/** 文本命中的受控病位 id(如 heart/spleen)。纯词法,不做归属推断。 */
export function governedLocationIdsIn(text: string): string[] {
  return matchedIds(text, VOCAB.locations);
}

/** 文本命中的受控病性 id(如 qi_deficiency/damp)。纯词法。 */
export function governedNatureIdsIn(text: string): string[] {
  return matchedIds(text, VOCAB.natures);
}

/**
 * 证候**标签**的轴分解(病位/病性 id)。数据来自受治理证候词表本身携带的 locations/natures——
 * 「气血亏虚→{气虚,血虚}」「脾肾两虚→{脾虚,肾虚}」这类映射本就在词表里,任何模块都不该再手写。
 * 词表未收录该写法时回退到词法匹配(标签里出现的受控病位/病性词)。
 */
export function governedSyndromeLabelAxes(label: string): { locations: string[]; natures: string[] } {
  const value = String(label || "").trim();
  if (!value) return { locations: [], natures: [] };
  const exact = VOCAB.syndromeAxes[value];
  if (exact) return { locations: [...exact.locations], natures: [...exact.natures] };
  // 包含匹配必须取**最长命中**,不能合并全部命中:「脾胃虚寒证」同时包含「虚寒」「脾胃」
  // 以及一堆更短的证候写法,全合并会把寒热虚实两侧的轴一起塞进来,方向判定随即弃权——
  // 实测因此漏掉「白虎汤(大寒) × 脾胃虚寒证」这种最典型的方向对立。最大匹配是词法层的
  // 常规做法:最长的那条写法才是这个标签真正对应的证候。
  let bestLength = 0;
  const locations = new Set<string>();
  const natures = new Set<string>();
  for (const [form, axes] of Object.entries(VOCAB.syndromeAxes)) {
    if (form.length < 2 || form.length < bestLength || !value.includes(form)) continue;
    if (form.length > bestLength) {
      bestLength = form.length;
      locations.clear();
      natures.clear();
    }
    for (const id of axes.locations) locations.add(id);
    for (const id of axes.natures) natures.add(id);
  }
  if (locations.size > 0 || natures.size > 0) return { locations: [...locations], natures: [...natures] };
  return { locations: governedLocationIdsIn(value), natures: governedNatureIdsIn(value) };
}

/** 文本是否命中某人群限定组。词表来自 tcm-population-scope.source.json(唯一归属地)。 */
export function matchesPopulationScope(text: string, group: PopulationScopeGroup): boolean {
  const value = String(text || "");
  if (!value) return false;
  return (VOCAB.populations[group] || []).some((form) => value.includes(form));
}

/** 供构建期/测试使用:某组人群限定词的全量写法(只读)。 */
export function populationScopeForms(group: PopulationScopeGroup): readonly string[] {
  return VOCAB.populations[group] || [];
}

/**
 * 阴性形式的阳性体征(无汗/不渴/小便不利…)。中医里这类词是证候的**定义性指征**,
 * 不是「没有该症状」;语言学否定规则若把它们剥离,表实、寒证、腑实等证的关键依据会静默丢失。
 * 词表为受治理生成物 tcm-affirmative-negation-forms.json(由鉴别图 + 古方主治原文 + 存量种子派生)。
 */
export function isAffirmativeNegationForm(clause: string): boolean {
  const value = String(clause || "").replace(/\s+/g, "");
  return value.length > 0 && AFFIRMATIVE_NEGATION_FORMS.has(value);
}

/**
 * 文本中出现的受治理阴性形式阳性体征词(逐词包含匹配,长词优先)。
 *
 * 用于**只有排除权**的守卫路径:极性层按语言学规则会把「无汗」整条剥掉,而它恰是
 * 太阳伤寒表实证的定义性指征。不在极性层做全局改判——同一字串在症状回顾式否认
 * (「无发热、咳嗽、消瘦或心悸」)里是真否定,把患者的否认读成阳性体征比原缺陷更危险。
 * 因此改为在守卫处并入:守卫唯一的权力是**移除**候选,不确定时多排除一个方向相反的
 * 候选,方向上是安全的;而在极性层改判会让错误读法流向全系统的每一条结论。
 */
export function affirmativeNegationFormsIn(text: string): string[] {
  const value = String(text || "").replace(/\s+/g, "");
  if (!value) return [];
  return [...AFFIRMATIVE_NEGATION_FORMS].filter((term) => value.includes(term));
}

/** 供构建期/测试使用:受治理阴性形式阳性体征词条数。 */
export function affirmativeNegationFormCount(): number {
  return AFFIRMATIVE_NEGATION_FORMS.size;
}
