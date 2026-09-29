import profilesJson from "../data/tcm-formula-decoction-profiles.json" with { type: "json" };

/**
 * 命名方的教材煎服法档案（2026-09-29，甲方 9.24/9.27 测评 2.6/2.7）。
 *
 * 甲方点名的两处：银翘散（辛凉平剂）被写成「服后可少进热粥、加衣覆被以助微汗」——那是桂枝汤的将息法，
 * 银翘散原书是「香气大出，即取服，勿过煮」；清胃散、龙胆泻肝汤（清热）被写成「空腹温服、得利即停」。
 * 根因是按治法关键词分档（见 diagnosis-visible-summary 的 decoctionProfileFromSignedTherapy），
 * 命名方本来有教材原文用法可读。档案由 scripts/build-formula-decoction-profiles.py 从《方剂学》各方【用法】确定性导出：
 *   sweating  —— porridge_and_cover（原文要求啜热粥、温覆，桂枝汤类）/ cover_light_sweat_no_porridge（温覆微汗、不啜粥，麻黄汤类）/
 *                no_sweat_induction（解表剂但原文不取汗，银翘散类）/ none（非解表）
 *   timing    —— fasting / before_meal / after_meal / bedtime / any / null（原文没写）
 *   notes     —— 勿过煮、先煎、久煎、微火等原文提示
 */
export type NamedFormulaDecoctionProfile = {
  name: string;
  chapter?: string;
  sweating: "porridge_and_cover" | "cover_light_sweat_no_porridge" | "no_sweat_induction" | "none";
  timing: "fasting" | "before_meal" | "after_meal" | "bedtime" | "any" | null;
  notes: string[];
  usageOriginal?: string;
  line?: number;
};

const PROFILES = (profilesJson as { formulas: Record<string, NamedFormulaDecoctionProfile> }).formulas || {};

function baseFormulaName(name: string): string {
  const compact = String(name || "").replace(/\s+/g, "");
  // 「某方加减/加味/化裁」去掉修饰后缀（长的先试）。后缀是构词修饰，不是临床词表。
  const suffix = "加减方,加味方,化裁方,加减,加味,化裁".split(",").find((item) => compact.endsWith(item) && compact.length > item.length);
  return suffix ? compact.slice(0, compact.length - suffix.length) : compact;
}

export function namedFormulaDecoctionProfile(name: unknown): NamedFormulaDecoctionProfile | undefined {
  if (typeof name !== "string") return undefined;
  return PROFILES[baseFormulaName(name)];
}

export function formulaDecoctionProfileCount(): number {
  return Object.keys(PROFILES).length;
}
