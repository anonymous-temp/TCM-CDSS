/**
 * 候选方「不适用情形」里由服务端追加的逐味提示：毒性与特殊人群用药边界。
 *
 * 2026-10-13 全面回归：这段文字此前是规则表的原样拼接——「麻黄（孕期/妊娠:MEDIUM/麻黄；心血管病:MEDIUM/麻黄）」，
 * 内部等级枚举和规则原文片段直接进了签名载荷，红旗/妊娠等非剂量页还把它印给医生（185 例里 14 例）。
 * 另一处缺陷：候选每重新编译一次（修复轮、终审），上一次追加的尾段先被叙述净化削成
 * 「；；；；。命中相应人群或状态时…复核。」再追加一遍新的，残段逐轮累积（瘦身前后都是约四分之一病例）。
 * 生成与剥离放在同一个文件里：尾段长什么样只有这里知道，编译器与出处富化都调同一个剥离函数。
 */
export type HerbBoundaryRule = { population: string; severity: "LOW" | "MEDIUM" | "HIGH" };
export type HerbBoundaryProfile = { herb: string; isToxic: boolean; toxicity: readonly string[]; populationRules: readonly HerbBoundaryRule[] };

const HERB_BOUNDARY_MARKER = "各药毒性与特殊人群提示：";
const HERB_BOUNDARY_TRAILER = "相应人群或状态请停用、替换，或经医生/药师复核后使用。";
/** 旧版写法：已签名的历史载荷与浏览器快照里还有，剥离时必须认得。 */
const LEGACY_HERB_BOUNDARY_MARKER = "逐味生成前安全边界：";
const LEGACY_HERB_BOUNDARY_TRAILER = "命中相应人群或状态时按规则停用、替换或由医生/药师复核。";

const SEVERITY_WORDING = [
  ["HIGH", "禁用或须强复核"],
  ["MEDIUM", "慎用"],
] as const;

/** 单味药的提示；没有毒性也没有中高等级人群规则时返回 undefined。 */
export function herbBoundaryNote(profile: HerbBoundaryProfile): string | undefined {
  const parts = [
    ...(profile.isToxic && profile.toxicity.length > 0 ? [`毒性：${profile.toxicity.join("、")}`] : []),
    ...SEVERITY_WORDING.flatMap(([severity, wording]) => {
      const populations = [...new Set(profile.populationRules
        .filter((rule) => rule.severity === severity)
        .map((rule) => rule.population.trim())
        .filter(Boolean))];
      return populations.length > 0 ? [`${populations.join("、")}${wording}`] : [];
    }),
  ];
  return parts.length > 0 ? `${profile.herb}（${parts.join("；")}）` : undefined;
}

/** 整段尾注；没有任何一味需要提示时返回空串。 */
export function herbBoundaryTail(profiles: readonly HerbBoundaryProfile[]): string {
  const notes = profiles.flatMap((profile) => herbBoundaryNote(profile) ?? []);
  return notes.length > 0 ? `${HERB_BOUNDARY_MARKER}${notes.join("；")}。${HERB_BOUNDARY_TRAILER}` : "";
}

/**
 * 去掉服务端此前追加的尾段（新旧两种写法），以及旧尾段被叙述净化削剩的残段。
 * 只认本文件自己写出去的标记与结尾句；模型写的正文不动。
 */
export function stripHerbBoundaryTail(text: string): string {
  let head = String(text || "");
  for (const marker of [HERB_BOUNDARY_MARKER, LEGACY_HERB_BOUNDARY_MARKER]) {
    const at = head.indexOf(marker);
    if (at >= 0) head = head.slice(0, at);
  }
  for (const trailer of [HERB_BOUNDARY_TRAILER, LEGACY_HERB_BOUNDARY_TRAILER]) head = head.split(trailer).join("");
  return head
    .replace(/[；;]{2,}。?/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}
