import knowledge from "../data/tcm-knowledge.json" with { type: "json" };

type HerbEntry = Record<string, unknown>;
type HerbRecord = { name: string; aliases?: string[]; entries?: HerbEntry[] };

const CONTROLLED_ALIASES: Record<string, string> = {
  桂圆肉: "龙眼肉",
  炒白术: "白术",
  麸炒白术: "白术",
  炒酸枣仁: "酸枣仁",
  制远志: "远志",
  蜜炙黄芪: "黄芪",
  炙黄芪: "黄芪",
  蜜炙甘草: "甘草",
  炙甘草: "甘草",
  夜交藤: "首乌藤",
};
const AUDIT_VERIFIED_METHOD_SUPPLEMENTS: Record<string, string[]> = {
  // Institutional Lingxi audit regressions supplement preparation methods that are absent from the
  // historical source pipeline. Keeping them in one governed knowledge map lets every M04 candidate,
  // workbench edit and M05 payload share the same rule instead of branching on individual cases.
  枇杷叶: ["包煎"],
  菟丝子: ["包煎"],
  莱菔子: ["包煎"],
};
export type DecoctionRule = {
  required: string[];
  oneOf: string[][];
  prohibited: string[];
};

function normalizedName(value: string): string {
  return value.replace(/[\s（）()]/g, "").replace(/(?:饮片|颗粒)$/g, "");
}

const herbRecords = (knowledge.herbs || []) as HerbRecord[];
const herbByName = new Map<string, HerbRecord>();
for (const herb of herbRecords) {
  herbByName.set(normalizedName(herb.name), herb);
  for (const alias of herb.aliases || []) herbByName.set(normalizedName(alias), herb);
}

function resolveHerb(value: string): HerbRecord | undefined {
  const normalized = normalizedName(value);
  const controlled = CONTROLLED_ALIASES[normalized];
  const withoutProcessing = normalized.replace(/^(?:蜜炙|麸炒|土炒|炒|炙|醋制|酒制|盐制|姜制|煅|制|生)/, "");
  return herbByName.get(normalized) ||
    (controlled ? herbByName.get(controlled) : undefined) ||
    (withoutProcessing !== normalized ? herbByName.get(withoutProcessing) : undefined);
}

export function decoctionRuleForHerb(value: string): DecoctionRule | undefined {
  const herb = resolveHerb(value);
  if (!herb) return undefined;
  const required = new Set<string>();
  const prohibited = new Set<string>();
  const oneOf: string[][] = [];
  const addOneOf = (alternatives: string[]) => {
    const key = alternatives.join("|");
    if (!oneOf.some((existing) => existing.join("|") === key)) oneOf.push(alternatives);
  };
  const addCode = (code: string) => {
    if (code === "DECOCT_FIRST") required.add("先煎");
    else if (code === "DECOCT_LONG") required.add("久煎");
    else if (code === "WRAPPED_DECOCTION" || code === "WRAP_DECOCTION") required.add("包煎");
    else if (code === "SEPARATE_DECOCTION") addOneOf(["另煎", "另炖"]);
    else if (code === "DISSOLVE_MELT_OR_LATE") addOneOf(["烊化", "后下"]);
    else if (code === "DISSOLVE_MELT") required.add("烊化");
    else if (code === "ADD_LATER") required.add("后下");
    else if (code === "LATE_OR_POWDER_TAKE") addOneOf(["后下", "冲服"]);
    else if (["POWDER_SWALLOW", "POWDER_TAKE", "POWDER_FLUSH", "PILL_POWDER"].includes(code)) {
      addOneOf(["冲服", "调服", "研粉", "研末", "吞服", "丸散"]);
    }
    else if (code === "CRUSH_OR_SPLIT") addOneOf(["打碎", "劈开", "捣碎"]);
    else if (code === "AVOID_LONG_DECOCTION") prohibited.add("久煎");
    else if (code === "NOT_IN_DECOCTION" || code === "NO_DECOCTION") prohibited.add("同煎");
  };
  const explicitlyNoDecoction = (herb.entries || []).some((entry) =>
    /(?:一般)?不(?:宜|应)?入(?:煎剂|汤剂)|不入(?:煎剂|汤剂)|不宜同煎|不能按普通同煎/.test(
      [entry.doseText, entry.note, entry.method].filter((item): item is string => typeof item === "string").join("；"),
    )
  );
  for (const entry of herb.entries || []) {
    const entryType = typeof entry.type === "string" ? entry.type : "";
    const routeForm = typeof entry.routeForm === "string" ? entry.routeForm : "";
    if (entryType === "decoction") addCode(String(entry.methodCode || ""));
    // Route-specific oral forms such as 烊化、研粉 and 丸散 carry the decisive "do not
    // co-decoct" rule. Restrict this to oral non-decoction forms so an unrelated external-use
    // record does not contaminate a herb that also has a valid ordinary decoction route.
    const ordinaryDecoctionRoute = /煎服|汤剂|另煎|另炖/.test(routeForm);
    const explicitOralAlternative = explicitlyNoDecoction && /烊化|溶化|冲服|调服|研粉|散剂|丸散|粉末/.test(routeForm);
    if (entryType === "routeDose" && (ordinaryDecoctionRoute || explicitOralAlternative)) {
      for (const code of String(entry.methodCodes || "").split(/[；;,]/).filter(Boolean)) {
        if (ordinaryDecoctionRoute && ["POWDER_SWALLOW", "PILL_POWDER", "NO_DECOCTION"].includes(code)) continue;
        addCode(code);
      }
    }
    if (entryType === "curatedDose" && Array.isArray(entry.methods)) {
      for (const method of entry.methods) {
        if (typeof method !== "string") continue;
        if (/先煎/.test(method)) addCode("DECOCT_FIRST");
        if (/久煎/.test(method)) addCode("DECOCT_LONG");
        if (/后下/.test(method)) addCode("ADD_LATER");
        if (/包煎/.test(method)) addCode("WRAP_DECOCTION");
        if (/另煎|另炖/.test(method)) addCode("SEPARATE_DECOCTION");
        if (/烊化/.test(method)) addCode("DISSOLVE_MELT");
        if (/冲服|调服|研粉|研末|吞服|丸散/.test(method)) addCode("POWDER_SWALLOW");
        if (/捣碎|打碎|劈开/.test(method)) required.add(method);
      }
    }
  }
  for (const method of AUDIT_VERIFIED_METHOD_SUPPLEMENTS[herb.name] || []) required.add(method);
  if (required.has("捣碎")) {
    required.delete("捣碎");
    required.add("捣碎后同煎");
  }
  return required.size || prohibited.size || oneOf.length
    ? { required: [...required], oneOf, prohibited: [...prohibited] }
    : undefined;
}

export function requiredDecoctionRequirement(value: string): string | undefined {
  const rule = decoctionRuleForHerb(value);
  if (!rule) return undefined;
  return [
    ...rule.required,
    ...rule.oneOf.map((alternatives) => alternatives.join("或")),
    ...rule.prohibited.map((method) => `禁止${method}`),
  ].join("、") || undefined;
}

export function decoctionRuleSatisfied(value: string, declaration: string): boolean {
  const rule = decoctionRuleForHerb(value);
  if (!rule) return true;
  if (!rule.required.every((method) => declaration.includes(method))) return false;
  if (!rule.oneOf.every((alternatives) => alternatives.some((method) => declaration.includes(method)))) return false;
  if (rule.prohibited.some((method) => {
    if (!declaration.includes(method)) return false;
    const escaped = method.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return !new RegExp(`(?:禁止|不宜|不可|避免|不得|不要)[^；。\\n]{0,12}${escaped}|不(?:与|同)[^；。\\n]{0,12}${escaped}`).test(declaration);
  })) return false;
  return true;
}
