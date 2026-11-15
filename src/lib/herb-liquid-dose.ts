import source from "../data/tcm-herb-liquid-dose.source.json";

export function liquidHerbDoseRule(name: string) {
  return source.herbs.find((row) => row.names.includes(String(name || "").trim()));
}

export function liquidHerbDoseMl(name: string, dose: string): number | undefined {
  if (!liquidHerbDoseRule(name)) return undefined;
  const match = String(dose || "").trim().match(/^(\d+(?:\.\d+)?)\s*(?:mL|毫升)$/iu);
  const amount = match ? Number(match[1]) : NaN;
  return Number.isFinite(amount) && amount > 0 && amount <= 500 ? amount : undefined;
}

/** 液体药被模型误写为 g 时纠正计量单位；无数值的「适量」不猜量。 */
export function normalizedLiquidHerbDose(name: string, dose: string): string {
  if (!liquidHerbDoseRule(name)) return dose;
  const match = String(dose || "").trim().match(/^(\d+(?:\.\d+)?)\s*(?:g|克|mL|毫升)$/iu);
  return match ? `${match[1]}mL` : dose;
}

export function liquidHerbDoseWithinRange(name: string, dose: string, fraction = 1): boolean {
  const rule = liquidHerbDoseRule(name);
  const amount = liquidHerbDoseMl(name, dose);
  return Boolean(rule && amount != null && amount > 0 && amount <= rule.maxMl * fraction && (fraction < 1 || amount >= rule.minMl));
}

/** 加味剂量与现有固体药同样夹到参考区间；没有数值时取教材下限，不套用通用的 10g。 */
export function suggestedLiquidHerbDose(name: string, dose: string | undefined, fraction = 1): string | undefined {
  const rule = liquidHerbDoseRule(name);
  if (!rule) return undefined;
  const amount = dose ? liquidHerbDoseMl(name, normalizedLiquidHerbDose(name, dose)) : undefined;
  const upper = rule.maxMl * fraction;
  const lower = rule.minMl * fraction;
  return `${Number(Math.min(upper, Math.max(lower, amount ?? lower)).toFixed(2))}mL`;
}
