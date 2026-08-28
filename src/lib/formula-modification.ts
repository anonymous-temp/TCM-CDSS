/**
 * 随证加减的唯一结构化边界。
 *
 * 新出参必须把动作与药味拆开：`{ action: "加", herbName: "茯苓" }`。
 * 旧签名快照可能仍保存 `action: "加茯苓"`，因此消费侧可只读解析旧串；该兼容函数
 * 不会把旧串重新写回新结果，也不会绕过后续药味身份、方向和审方校验。
 */

export type FormulaModificationAction = "加" | "减" | "调整";

const ACTION_ALIASES: Readonly<Record<string, FormulaModificationAction>> = {
  add: "加",
  添加: "加",
  加入: "加",
  加用: "加",
  新增: "加",
  加: "加",
  remove: "减",
  移除: "减",
  减去: "减",
  去掉: "减",
  删除: "减",
  停用: "减",
  去: "减",
  减: "减",
  adjust: "调整",
  调整剂量: "调整",
  调整: "调整",
};

// Derived from the schema alias map instead of maintaining a second vocabulary. A bare canonical
// action cannot be consumed because splitLegacyAction also requires a non-empty suffix.
// Longest-first prevents `调整` from consuming `调整剂量…`.
const LEGACY_ACTION_PREFIXES = Object.keys(ACTION_ALIASES)
  .filter((key) => Array.from(key).some((char) => (char.codePointAt(0) || 0) > 127))
  .sort((left, right) => right.length - left.length);

function cleanScalar(value: unknown): string {
  return typeof value === "string" ? value.normalize("NFKC").trim().replace(/\s+/g, "") : "";
}

function splitLegacyAction(value: unknown): { action: FormulaModificationAction; herbName: string } | null {
  const text = cleanScalar(value);
  for (const prefix of LEGACY_ACTION_PREFIXES) {
    if (!text.startsWith(prefix) || text.length <= prefix.length) continue;
    const action = ACTION_ALIASES[prefix];
    if (action) return { action, herbName: text.slice(prefix.length) };
  }
  return null;
}

export function normalizeFormulaModificationAction(value: unknown): FormulaModificationAction | null {
  const text = cleanScalar(value);
  if (!text) return null;
  if (ACTION_ALIASES[text]) return ACTION_ALIASES[text];
  return splitLegacyAction(text)?.action || null;
}

export function legacyFormulaModificationHerbName(action: unknown): string {
  return splitLegacyAction(action)?.herbName || "";
}

export function formulaModificationHerbName(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const record = value as Record<string, unknown>;
  const explicit = cleanScalar(record.herbName);
  const legacy = legacyFormulaModificationHerbName(record.action);
  // Mixed old/new payloads must agree. Otherwise a caller could put one drug in the legacy action
  // and a different drug in herbName, making the display, review and safety layers inspect different identities.
  if (explicit && legacy && explicit !== legacy) return "";
  return explicit || legacy;
}

export function normalizedFormulaModificationFields(value: unknown): {
  action: FormulaModificationAction;
  herbName: string;
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const action = normalizeFormulaModificationAction(record.action);
  const herbName = formulaModificationHerbName(record);
  return action && herbName ? { action, herbName } : null;
}
