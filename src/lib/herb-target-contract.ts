export const FORMULA_STRUCTURE_TARGETS = {
  middle_jiao_support: "顾护中焦，防补药滋腻",
  harmonize: "调和诸药，协调药性",
  guide: "引经载药，调和诸药",
  temper: "制约峻烈，缓和药性",
} as const;

export type FormulaStructureRole = keyof typeof FORMULA_STRUCTURE_TARGETS;

export function normalizeFormulaStructureRole(value: unknown): FormulaStructureRole | undefined {
  if (typeof value !== "string") return undefined;
  if (value in FORMULA_STRUCTURE_TARGETS) return value as FormulaStructureRole;
  const compact = value.toLowerCase().replace(/[\s_-]/g, "");
  const aliases: Array<[RegExp, FormulaStructureRole]> = [
    [/(?:middlejiaosupport|中焦支持|健脾和中|顾护中焦|顾护脾胃|防滋腻)/, "middle_jiao_support"],
    [/(?:harmonize|调和诸药|调和药性|调和|协同|协调|相辅|增效|协调药势)/, "harmonize"],
    [/(?:guide|引经|引药|导药|载药)/, "guide"],
    [/(?:temper|缓和|制约|减毒|反佐|纠偏|制偏)/, "temper"],
  ];
  return aliases.find(([pattern]) => pattern.test(compact))?.[1];
}

export function formulaStructureTarget(value: unknown): string | undefined {
  const role = normalizeFormulaStructureRole(value);
  return role ? FORMULA_STRUCTURE_TARGETS[role] : undefined;
}
