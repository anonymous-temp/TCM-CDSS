import { originalFormula, withoutPreparationPrefix, type OriginalFormula } from "./formula-original-composition";
import { compositionLogicForFormulaNames, type FormulaCompositionLogic } from "./tcm-classic-inference";
import { resolveGovernedTcmHerbIdentity } from "./tcm-herb-identity";
import { getTcmHerbDoseLimit, getTcmHerbGenerationSafetyProfile, isKnownTcmHerbName } from "./tcm-knowledge";

/**
 * 给开方模型看的组成基准药名：只写饮片基础名和原方炮制，不带调剂品名（第四十二轮，根因一第 5 条）。
 *
 * 受治理目录里 545 条来自深圳《中药方剂编码规则》，药名是调剂品名（姜天麻、煅石决明、黄芩片、盐杜仲、朱茯神、燀桃仁）。
 * 此前这些名字原样印进「服务端方剂目录编译基准」和 M03 检索卡片，模型照抄进药味表，「原方」核对又拿同一张表比。
 * 这里把每味换成：原方组成表里这首方该味的基础名（原书炮制通行的带上：炙甘草、土炒白术）；表里没有这首方时，
 * 换成受治理药名身份的正名（姜天麻→天麻、黄芩片→黄芩）。药典各自成条目的饮片（法半夏、制川乌、熟地黄、炙甘草）本来就是正名，不动。
 *
 * 只改给模型看的名字；编译基准的味数、保留下限、锚点仍按目录条目逐味对应（按药味身份比，写基础名同样核得过）。
 */

/** 调剂品名、古名换成受治理正名；正名带括注的（延胡索（元胡））去掉括注。认不出、或换了以后知识库不认的，保持原样。 */
export function dispensingBaseName(raw: string): string {
  const name = String(raw || "").trim();
  if (!name) return name;
  const resolution = resolveGovernedTcmHerbIdentity(name);
  const canonical = String(resolution.doseCanonicalName || resolution.canonicalName || "").replace(/[（(][^）)]*[）)]/gu, "").trim();
  if (!canonical || canonical === name) return name;
  if (!isKnownTcmHerbName(canonical)) return name;
  // 换名不得丢掉剂量边界与毒性提示：原名有药典用量而正名没有、或两者毒性标注不同的，不换。
  const rawLimit = getTcmHerbDoseLimit(name);
  const baseLimit = getTcmHerbDoseLimit(canonical);
  if (rawLimit && !baseLimit) return name;
  if (getTcmHerbGenerationSafetyProfile(name).isToxic !== getTcmHerbGenerationSafetyProfile(canonical).isToxic) return name;
  return canonical;
}

function baseIdentity(name: string): string {
  return withoutPreparationPrefix(dispensingBaseName(name));
}

/** 原书写明、通行的炮制换成饮片名（土炒→土炒白术，炒→炒山药，酒→酒白芍，炙→炙甘草，炭→荆芥穗炭）；知识库不认或剂量边界不同的不换。 */
export function originalPreparedHerbName(base: string, preparation: string): string | undefined {
  const candidates = [
    `${preparation}${base}`,
    preparation.endsWith("炒") && preparation.length === 2 ? `${preparation[0]}${base}` : "",
    preparation === "蜜炙" ? `炙${base}` : "",
    preparation === "炙" ? `蜜${base}` : "",
    preparation === "炭" ? `${base}炭` : "",
  ].filter(Boolean);
  return candidates.find((name) => knownWithSameDose(name, base));
}

/**
 * 改出来的饮片名要知识库认得、剂量边界与原药相同；有毒的药不在这里改（附子、半夏一类的炮制规格与剂量由毒性药规则与医生定，
 * 改名会让注意事项里按药名写的毒性提示对不上）。
 */
export function knownWithSameDose(form: string, base: string): boolean {
  if (!isKnownTcmHerbName(form)) return false;
  if (getTcmHerbGenerationSafetyProfile(base).isToxic || getTcmHerbGenerationSafetyProfile(form).isToxic) return false;
  const formLimit = getTcmHerbDoseLimit(form);
  const baseLimit = getTcmHerbDoseLimit(base);
  if (!formLimit) return false;
  return !baseLimit || (formLimit.min === baseLimit.min && formLimit.max === baseLimit.max);
}

/**
 * 一首方的目录组成 → 给模型看的药名（与输入逐味对应、等长）。
 * original 是原方组成表里这首方（方名+出处）的条目；没有时只做调剂品名→正名。
 */
export function formulaBaselineDisplayNames(ingredients: readonly string[], original?: OriginalFormula): string[] {
  const originalByIdentity = new Map((original?.herbs || []).map((item) => [baseIdentity(item.herb), item] as const));
  return ingredients.map((raw) => {
    const base = dispensingBaseName(raw);
    const matched = originalByIdentity.get(baseIdentity(raw));
    if (!matched) return base;
    // 有毒的药不按原书改名（制川乌、姜半夏、附片的炮制规格由毒性药规则管，原书的「川乌」「半夏」是生品名）。
    if (getTcmHerbGenerationSafetyProfile(base).isToxic || getTcmHerbGenerationSafetyProfile(matched.herb).isToxic) return base;
    const herb = isKnownTcmHerbName(matched.herb) ? matched.herb : base;
    if (matched.deliver && matched.preparation) return originalPreparedHerbName(herb, matched.preparation) || herb;
    // 原书没有写炮制、目录条目却带了通行的炮制前缀（炙甘草）：目录这一味本身是正名时保留，其余按原书写基础名。
    return herb;
  });
}

/** 原方组成表里这首方（方名+出处）的条目；给提示词用（不经受治理目录按名回查）。 */
export function originalFormulaForCatalogEntry(name: string, source: string | undefined | null): OriginalFormula | undefined {
  return source ? originalFormula(name, source) : undefined;
}

/**
 * 方剂「组成逻辑」（随处方 JSON、HIS 方案交给对接方，也进开方提示词的「受控组成逻辑」）：
 * 生成器按受治理目录写的「组成：姜天麻、钩藤、煅石决明…。出处：…。」同样带调剂品名，这里按同一口径换成基础名与原方炮制。
 * 开方提示词与处方编译都从这里取，不直接读 compositionLogicForFormulaNames（test:r1057-main 6.3 钉住）。
 */
export function compositionLogicWithBaselineNames(formulaNames: string[]): FormulaCompositionLogic[] {
  return compositionLogicForFormulaNames(formulaNames).map((entry) => {
    const raw = entry as FormulaCompositionLogic & { ingredients?: string[]; source?: string };
    if (!Array.isArray(raw.ingredients) || raw.ingredients.length === 0 || !/^组成：/u.test(raw.summary)) return entry;
    const names = [...new Set(formulaBaselineDisplayNames(raw.ingredients, originalFormulaForCatalogEntry(raw.formulaName, raw.source)))];
    return { ...entry, summary: raw.summary.replace(/^组成：[^。]*。/u, `组成：${names.join("、")}。`) };
  });
}
