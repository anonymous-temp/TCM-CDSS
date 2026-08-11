import knowledge from "../data/tcm-knowledge.json" with { type: "json" };
import { resolveGovernedTcmHerbIdentity } from "./tcm-herb-identity";

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
  紫苏子: ["包煎"],
  // 2026-08-10 50 例基层回归实测新增：审方分别提「火麻仁 应包煎」「蜂蜜 应烊化」，
  // 而本地知识库这两味**没有煎法字段**（阿胶「烊化兑服」、苦杏仁「后下」都有），
  // 于是我方无法在出方时先标注，只能等审方回头提——这正是 M05「可预防问题」要拦的形态。
  // 与上面四味同源：审方已核验、历史来源管线缺失的煎法，集中在这一张受治理表里补，
  // M04 候选、药味工作台编辑与 M05 载荷共用同一条规则。
  火麻仁: ["包煎"],
  蜂蜜: ["烊化"],
};
/**
 * 「几选一」的受治理煎法（2026-08-11）。与上表同源——审方已核验、历史来源管线缺失——
 * 区别在于这一类药的正确投料方式**取决于用药目的**，不能压成单一值。
 *
 * 大黄是这一类的标准例，也是 50 例实测里最后一条未关闭的「可预防问题」：
 * 审方原话是「大黄 应先煎、后下或冲服」，而本地知识库只有否定式约束「禁止久煎」，
 * 于是我方出方时一个字都标不出来，只能等审方回头提。
 *
 * 此前的处理是「不补」，理由是取泻下须后下、取清热活血可同煎，一刀切标注会临床出错——
 * 这个理由对**单值**成立，对 oneOf 不成立：oneOf 表达的正是「这几种都可以、由医师按
 * 用药目的择一」，既清掉了「未标注」，又没有替医师做选择。列表首项取临床最常用的后下
 * （取泻下须后下或开水泡服；欲缓下可同煎，但无论何种目的都不可久煎——久煎泻下力大减，
 * 这一条由既有的 prohibited「禁止久煎」继续承担）。
 * 判据逐字取自审方引擎的受治理规则，不是本仓库自行裁定的临床结论。
 */
const AUDIT_VERIFIED_ONE_OF_SUPPLEMENTS: Record<string, string[][]> = {
  大黄: [["后下", "先煎", "冲服"]],
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
  const direct = herbByName.get(normalized) ||
    (controlled ? herbByName.get(controlled) : undefined) ||
    (withoutProcessing !== normalized ? herbByName.get(withoutProcessing) : undefined);
  if (direct) return direct;
  // 兜底走 T9 受控身份归一。上面那两条（手写 CONTROLLED_ALIASES + 前缀剥离）都是字面规则，
  // 覆盖不到药典正式炮制名：`炮附片`/`黑顺片`的前缀「炮」不在剥离表里，`朱砂粉`/`燀苦杏仁`
  // 压根没有可剥离的前缀。后果是**煎法规则整条查不到**——
  //   附子 → 先煎、久煎（乌头碱水解，中药煎法里最要紧的一条）
  //   炮附片/黑顺片 → undefined
  //   朱砂 → 禁止同煎 / 冲服；朱砂粉 → undefined
  //   苦杏仁 → 后下、捣碎后同煎；燀苦杏仁 → undefined
  // 而炮附片/黑顺片正是药典正名、临床实际调配的形态。
  // 此前没出事只因 `isKnownTcmHerbName("炮附片")=false` 让 M04 把整条候选驳回——
  // 那是身份覆盖的**巧合**，不是安全规则；T9 身份表一扩（本轮 90→377），巧合就会失效。
  // 只接受 autoResolvable 的归一结果：resolveGovernedTcmHerbIdentity 仅在人工裁定过的行上
  // 返回 canonicalName，ambiguous/待裁定的行不返回，因此这条兜底不会引入未经治理的猜测。
  const identity = resolveGovernedTcmHerbIdentity(value);
  const governed = identity.canonicalName || identity.doseCanonicalName;
  return governed ? herbByName.get(normalizedName(governed)) : undefined;
}

/**
 * 与「同煎」**不相容**的投料方式：这味药不是和其余药一起从头煎到尾的。
 *
 * 刻意只收有把握的几条，不做「所有煎法两两互斥」的推广：
 *  · 久煎 不在其中——它是**时长**限定，附子正是「先煎且久煎」（乌头碱水解），
 *    误当互斥会把中药煎法里最要紧的一条拆成二选一；
 *  · 包煎 也不在其中——它是**包裹**方式，与何时投料不矛盾。
 */
const TIMINGS_INCOMPATIBLE_WITH_CO_DECOCTION =
  ["先煎", "后下", "另煎", "另炖", "烊化", "冲服", "兑服"] as const;

function hasSpecificDecoctionTiming(required: ReadonlySet<string>, oneOf: readonly string[][]): boolean {
  return TIMINGS_INCOMPATIBLE_WITH_CO_DECOCTION.some((timing) =>
    required.has(timing) || oneOf.some((alternatives) => alternatives.includes(timing)));
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
  for (const alternatives of AUDIT_VERIFIED_ONE_OF_SUPPLEMENTS[herb.name] || []) addOneOf(alternatives);
  // 「捣碎」是**准备**指令，「同煎」是**时机**指令，两者不是一回事。
  //
  // 原实现把「捣碎」无条件升级成「捣碎后同煎」，于是已经要求「后下」的药会同时拿到
  // 两条互斥的时机。甲方实测：苦杏仁 → required=["后下","捣碎后同煎"]，
  // 医生读到的是「后下」和「同煎」两条相反的煎法指令。
  // （药典对生苦杏仁的要求是「捣碎、入煎剂后下」——捣碎是准备，后下是时机，不冲突。）
  //
  // 「同煎」是默认时机：只有在没有任何特定时机要求时才需要说出来。
  if (required.has("捣碎")) {
    required.delete("捣碎");
    required.add(hasSpecificDecoctionTiming(required, oneOf) ? "捣碎" : "捣碎后同煎");
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
