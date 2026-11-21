/**
 * 方名的等价写法（2026-10-18 起由方名识别使用；2026-11-21 第五十四轮抽成共用判据）。
 *  · 瓜蒌的三种写法：教材写「栝蒌薤白半夏汤」，国家经典名方目录写「瓜蒌薤白半夏汤」，名录写「栝楼薤白白酒汤」；
 *  · 丸散方作汤剂：教材写「知柏地黄汤」「杞菊地黄汤」，目录收的是「知柏地黄丸」「杞菊地黄丸」（同一首方改作汤剂）。
 *
 * 为什么抽出来：方名识别按这张表把教材的「知柏地黄汤」认成目录的「知柏地黄丸」，而主治覆盖（formulaCoversDiseaseOrComplaint）与
 * 「推荐方向写的就是教材代表方」（withDeterministicFormulaReferences）按字面比，于是瘰疬·阴虚火旺证、精浊·阴虚火旺证等
 * 认出了方却判「不覆盖本病」、方向改写为辨证组方，辨证阶段锁不上，开方阶段每次重抽方名与药味都可能不同。几处现在读同一张表。
 */
export function formulaNameSpellings(fragment: string): string[] {
  const spellings = /栝蒌|栝楼|瓜蒌/u.test(fragment)
    ? [fragment, ...["瓜蒌", "栝楼", "栝蒌"].map((spelling) => fragment.replace(/栝蒌|栝楼|瓜蒌/gu, spelling))]
    : [fragment];
  return [...new Set(spellings.flatMap((spelling) => /汤$/u.test(spelling) && spelling.length >= 4
    ? [spelling, `${spelling.slice(0, -1)}丸`, `${spelling.slice(0, -1)}散`]
    : [spelling]))];
}

const bareName = (value: string) => String(value || "").replace(/\s+/gu, "").replace(/(?:加减|化裁)$/u, "");

/** 两个方名是不是同一首方的等价写法（字面相同，或一方按上表换写后与另一方相同）。 */
export function sameFormulaNameSpelling(left: string, right: string): boolean {
  const a = bareName(left);
  const b = bareName(right);
  if (!a || !b) return false;
  return a === b || formulaNameSpellings(a).includes(b) || formulaNameSpellings(b).includes(a);
}
