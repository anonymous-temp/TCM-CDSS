import floor from "../data/tcm-two-organ-method-floor.source.json" with { type: "json" };
import { governedFourCharacterMethodTerms } from "./clinical-governance-tables";

/**
 * 两脏同虚的证名，治法里每一脏都要有着落（第六十二轮；数据与来由见 tcm-two-organ-method-floor.source.json）。
 * 缺哪一脏，就从国标四字治法术语里取一条补上；治法条数已到上限、证名不是两脏同虚、或两脏都已有着落时原样返回。
 * 只做补位：不改已有各项、不改顺序，重复调用结果不变。
 */
const NAME = new RegExp(floor.deficiencyNamePattern, "u");
const splitItems = (method: string) => method.split(/[，,、；;]/u).map((item) => item.trim()).filter(Boolean);

export function twoOrganMethodFloorItem(primarySyndrome: string, method: string): string | undefined {
  const match = NAME.exec(primarySyndrome.trim());
  if (!match || match[1] === match[2]) return undefined;
  const covered = (organ: string) => (floor.coveredBy as Record<string, string[]>)[organ]?.some((mark) => method.includes(mark));
  const missing = [match[1], match[2]].filter((organ) => !covered(organ));
  // 两脏都没着落，说明这条治法不是按脏写的（如「益气养血」），不在这里猜。
  if (missing.length !== 1) return undefined;
  const nature = floor.natureOf.find((rule) => primarySyndrome.includes(rule.when))?.nature || floor.defaultNature;
  const governed = new Set(governedFourCharacterMethodTerms());
  const candidates = ((floor.templates as Record<string, string[]>)[nature] || [])
    .map((template) => template.replace("X", missing[0])).filter((term) => governed.has(term));
  // 优先取与已有各项不重字的那条（已有「益气固表」时补「健脾和胃」而不是再写一次「益气」）。
  return candidates.find((term) => !method.includes(term.slice(0, 2)) && !method.includes(term.slice(2))) || candidates[0];
}

/** 条数已到上限时不加条：把只写了另一脏的那一项换成两脏合写的国标术语（「滋肾益阴」→「滋补肝肾」）。找不到合写术语时原样返回。 */
function jointTermReplacing(primarySyndrome: string, items: readonly string[]): string[] | undefined {
  const match = NAME.exec(primarySyndrome.trim());
  if (!match) return undefined;
  const method = items.join("，");
  const covered = (organ: string) => (floor.coveredBy as Record<string, string[]>)[organ]?.some((mark) => method.includes(mark));
  const missing = [match[1], match[2]].filter((organ) => !covered(organ));
  if (missing.length !== 1) return undefined;
  const other = match[1] === missing[0] ? match[2] : match[1];
  const nature = floor.natureOf.find((rule) => primarySyndrome.includes(rule.when))?.nature || floor.defaultNature;
  const governed = new Set(governedFourCharacterMethodTerms());
  const joint = ((floor.jointTemplates as Record<string, string[]>)[nature] || [])
    .flatMap((template) => [template.replace("A", match[1]).replace("B", match[2]), template.replace("A", match[2]).replace("B", match[1])])
    .find((term) => governed.has(term));
  const at = items.findIndex((item) => item.includes(other) && !item.includes(missing[0]));
  if (!joint || at < 0 || items.includes(joint)) return undefined;
  return items.map((item, index) => (index === at ? joint : item));
}

export function withTwoOrganMethodFloor(method: string, primarySyndrome: string, cap: number): string {
  const items = splitItems(method);
  if (items.length === 0) return method;
  if (items.length >= cap) return jointTermReplacing(primarySyndrome, items)?.join("，") || method;
  const item = twoOrganMethodFloorItem(primarySyndrome, method);
  return item && !items.includes(item) ? [...items, item].join("，") : method;
}
