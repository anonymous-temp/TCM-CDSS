import references from "../data/tcm-herb-textbook-references.json" with { type: "json" };

/**
 * 研末吞服、研粉冲服时的一次用量（《中药学》十三五教材【用法用量】原句，与药典一致：三七「研末吞服，1次1～3g」、
 * 川贝母「研粉冲服，1次1～2g」）。知识库剂量只有煎服区间（三七 3–9g），冲服写 6g 曾按煎服区间放过（第四十九轮 p100c C070）。
 * 只认这一种写法，不推断。
 */
const POWDER_ROUTE_USAGE = /(?:研末|研粉)?(?:吞服|冲服)[，,]?\s*(?:1|一)次\s*([\d.]+)\s*[～~\-－]\s*([\d.]+)\s*g/u;
const LIMITS = new Map<string, { min: number; max: number; usage: string }>();
for (const [name, entry] of Object.entries((references as { herbs: Record<string, { usage?: string }> }).herbs || {})) {
  const match = POWDER_ROUTE_USAGE.exec(String(entry.usage || ""));
  if (match) LIMITS.set(name, { min: Number(match[1]), max: Number(match[2]), usage: match[0] });
}

/** 这一味按冲服/吞服/研末给时的一次用量上限；没有教材写法或不是冲服类写法时返回 undefined。 */
export function powderRouteDoseLimit(herbName: string, decoctionRequirement: string): { min: number; max: number; usage: string } | undefined {
  if (!/(?:冲|吞)服|研(?:末|粉)/u.test(String(decoctionRequirement || ""))) return undefined;
  return LIMITS.get(String(herbName || "").trim());
}
