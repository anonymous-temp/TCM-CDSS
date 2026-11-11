import governedFormulaCatalogJson from "../data/tcm-formula-governed-catalog.json" with { type: "json" };
import acceptedSource from "../data/tcm-formula-original-reconciliation.source.json" with { type: "json" };
import { originalFormula, type OriginalFormula } from "./formula-original-composition";
import { originalHerbMatches, originalHerbSatisfiedBy } from "./tcm-formula-provenance";

/**
 * 受治理方剂目录 × 原方组成表 全表对账（第四十二轮，根因一第 4 条）。
 *
 * 目录条目（方名+出处）在原方组成表里有同一本书的原方时，两边按药味身份逐味比：
 *  · 生姜、大枣的位置不计（原书作药引、目录列为药味，或反过来）；原方药引列进目录药味不算多；
 *  · 法定或通行的替代（犀角→水牛角，表的 substitutions）不算差异；原书自注、通行本的异文（表的 alternates）任一相符即一致；
 *  · 其余多出或缺少的药都是差异。
 * 差异只有两个去处：走订正通道（tcm-formula-catalog-collation.source.json）把目录改成原方；或者写进
 * tcm-formula-original-reconciliation.source.json 的 accepted（逐条带理由：原方含今不用的药、目录取通行改订本等）。
 * test:formula-original-compositions 钉「未列入清单的差异为零、清单里没有过期项」——以后目录或原方表新增的差异直接红。
 */
export type CatalogOriginalDifference = {
  id: string;
  name: string;
  source: string;
  sourceClass: string;
  book: string;
  tier: OriginalFormula["tier"];
  extraInCatalog: string[];
  missingInCatalog: string[];
};

type GovernedEntry = { id: string; name: string; source?: string; sourceClass: string; ingredients: string[] };
type AcceptedDifference = { name: string; book: string; extraInCatalog: string[]; missingInCatalog: string[]; category: string; reason: string };

const ADJUNCTS = ["生姜", "大枣"];

function differenceFor(entry: GovernedEntry, original: OriginalFormula): Omit<CatalogOriginalDifference, "id" | "name" | "source" | "sourceClass" | "book" | "tier"> | undefined {
  const isAdjunct = (herb: string) => ADJUNCTS.some((adjunct) => originalHerbMatches(adjunct, herb));
  const catalog = [...new Set(entry.ingredients)].filter((name) => !isAdjunct(name));
  const base = original.herbs.map((item) => item.herb);
  const readings = [base, ...(original.alternates || []).map((alternate) => [...base.filter((herb) => !alternate.remove.includes(herb)), ...alternate.add])];
  let best: { extra: string[]; missing: string[] } | undefined;
  for (const reading of readings) {
    const wanted = reading.filter((herb) => !isAdjunct(herb));
    const extra = catalog.filter((name) => ![...wanted, ...original.guides].some((herb) => originalHerbSatisfiedBy(herb, name)));
    const missing = wanted.filter((herb) => !catalog.some((name) => originalHerbSatisfiedBy(herb, name)));
    if (!best || extra.length + missing.length < best.extra.length + best.missing.length) best = { extra, missing };
  }
  return best && (best.extra.length > 0 || best.missing.length > 0) ? { extraInCatalog: best.extra.sort(), missingInCatalog: best.missing.sort() } : undefined;
}

/** 目录条目与同书原方不一致的全部条目（未扣除已接受清单）。 */
export function governedCatalogOriginalDifferences(): CatalogOriginalDifference[] {
  const out: CatalogOriginalDifference[] = [];
  for (const entry of governedFormulaCatalogJson.entries as unknown as GovernedEntry[]) {
    if (!entry.source || !Array.isArray(entry.ingredients) || entry.ingredients.length === 0) continue;
    const original = originalFormula(entry.name, entry.source);
    if (!original) continue;
    const difference = differenceFor(entry, original);
    if (difference) out.push({ id: entry.id, name: entry.name, source: entry.source, sourceClass: entry.sourceClass, book: original.book, tier: original.tier, ...difference });
  }
  return out;
}

export function acceptedCatalogOriginalDifferences(): AcceptedDifference[] {
  return (acceptedSource as { accepted: AcceptedDifference[] }).accepted;
}

const sameList = (left: readonly string[], right: readonly string[]) => left.length === right.length && [...left].sort().join("、") === [...right].sort().join("、");

/** 对账结论：未列入清单的差异、清单里已不存在（过期）的条目、目录里有同书原方可比的条目数。 */
export function catalogOriginalReconciliation(): { compared: number; unresolved: CatalogOriginalDifference[]; staleAccepted: AcceptedDifference[]; accepted: number } {
  const differences = governedCatalogOriginalDifferences();
  const accepted = acceptedCatalogOriginalDifferences();
  const matches = (difference: CatalogOriginalDifference, item: AcceptedDifference) =>
    item.name === difference.name && item.book === difference.book &&
    sameList(item.extraInCatalog, difference.extraInCatalog) && sameList(item.missingInCatalog, difference.missingInCatalog);
  const compared = (governedFormulaCatalogJson.entries as unknown as GovernedEntry[]).filter((entry) => entry.source && originalFormula(entry.name, entry.source)).length;
  return {
    compared,
    unresolved: differences.filter((difference) => !accepted.some((item) => matches(difference, item))),
    staleAccepted: accepted.filter((item) => !differences.some((difference) => matches(difference, item))),
    accepted: accepted.length,
  };
}
