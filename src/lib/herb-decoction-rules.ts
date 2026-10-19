import knowledge from "../data/tcm-knowledge.json" with { type: "json" };
import { resolveGovernedTcmHerbIdentity } from "./tcm-herb-identity";
import { textbookHerbUsage } from "./herb-textbook-identity";

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
  // 胶类药烊化兑服（药典 2020 一部：鹿角胶、龟甲胶【用法与用量】均为「烊化兑服」）。知识库里只有阿胶带这一条，
  // 左归丸、右归丸里的二胶于是没有被点名（2026-10-13 独立评审：眩晕·肾精不足证，煎服法只标了菟丝子包煎）。
  鹿角胶: ["烊化"],
  龟甲胶: ["烊化"],
  // 《北京市中药饮片调剂规程》（2011 年修订，北京市卫生局、北京市中医管理局）第三章五「调剂时需单包…的品种」3. 包煎品种：
  //「旋覆花、车前子、葶苈子、六一散、青黛、黛蛤散、生蒲黄、蒲黄炭、滑石粉、儿茶、金礞石、海金沙、辛夷、马勃、益元散」。
  // 知识库里这三味没有煎法字段（其余已有）。2026-10-18 留出例 S145 的同类缺陷（特殊煎法药未标）后逐条对照补齐。
  马勃: ["包煎"],
  青黛: ["包煎"],
  儿茶: ["包煎"],
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
/**
 * 鲜汁、乳类不入煎，取汁兑入煎好的药液服（2026-10-19，验收集 X-G-1104：消渴方加减里的藕汁、牛乳，煎服行一字未提，
 * 评审判「藕汁、牛乳不宜同煎」）。这几味在知识库里有名无煎法条目，上面的规则表查不到。
 * 依据：《丹溪心法》消渴方「黄连末 天花粉末 生地黄汁 藕汁 人乳汁 姜汁 蜂蜜」（本地教材语料 L140097）为和汁调服；
 *《中药学》生姜汁「本品系用生姜捣汁入药」（L153199）。只收汁、乳本身，不收同名饮片（生姜、藕节、生地黄照旧按饮片煎）。
 */
const LIQUID_ADJUNCT_METHODS: Record<string, string[]> = {
  藕汁: ["兑服"],
  梨汁: ["兑服"],
  生地黄汁: ["兑服"],
  生姜汁: ["兑服"],
  姜汁: ["兑服"],
  牛乳: ["兑服"],
  人乳: ["兑服"],
  人乳汁: ["兑服"],
};
/** 《中药学》【用法用量】里的特殊煎法（「宜布包入煎」即包煎）。 */
const TEXTBOOK_DECOCTION_METHOD = /先煎|后下|包煎|布包|烊化/gu;

/**
 * 《中药学》【用法用量】写到的特殊煎法，按这味药的写法分开（2026-10-19 留出例 S131、S145）：
 *  · 同一味药分块、粉两种规格各写一种煎法（滑石「滑石块先煎，滑石粉包煎」）：写「滑石粉」的只认包煎，写「滑石」的只认先煎——
 *    此前知识库把两种规格并在一条里，药味表照抄「先煎、包煎」，煎服行只写了先煎；
 *  · 知识库没有煎法条目、教材写了的（蚕沙「宜布包入煎」、代赭石「先煎」、檀香「宜后下」）照教材补。
 * 否定说法（「不宜后下」）、别的给药途径（「研粉冲服」「浓缩粉冲服」）不算。own 是这一规格的煎法，otherForm 是另一规格的。
 */
function textbookUsageMethods(value: string): { own: Set<string>; otherForm: Set<string>; ownText: string } | undefined {
  const usage = textbookHerbUsage(value);
  if (!usage) return undefined;
  // 这味药写的是哪种规格：粉、块（后缀），生、煅、制（前缀）；都不是时为原名（药典原名即生品、块状：石膏、滑石、川乌生品外用另说）。
  const written = normalizedName(String(value || ""));
  const form = /粉$/u.test(written) ? "粉" : /块$/u.test(written) ? "块" : (written.match(/^(生|煅|制)/u)?.[1] ?? "");
  const matches = (marker: string) => !marker || marker === form || (!form && (marker === "块" || marker === "生"));
  const own = new Set<string>();
  const otherForm = new Set<string>();
  const ownClauses: string[] = [];
  for (const sentence of usage.text.split(/[。；;]/u)) {
    // 一句开头点了规格（「生石膏煎服，15～60g，宜打碎先煎」），句内后面没再点规格的小句沿用它；小句自己点了的（「滑石粉包煎」）以小句为准。
    let sentenceMarker = "";
    for (const clause of sentence.split(/[，,]/u)) {
      const at = clause.search(new RegExp(TEXTBOOK_DECOCTION_METHOD.source, "u"));
      const head = at >= 0 ? clause.slice(0, at) : clause;
      const marker = /粉/u.test(head) ? "粉" : /块/u.test(head) ? "块" : (head.match(/(?:^|[^\u4e00-\u9fff])?(生|煅|制)[\u4e00-\u9fff]/u)?.[1] ?? "");
      if (marker && !sentenceMarker) sentenceMarker = marker;
      const effective = marker || sentenceMarker;
      const mine = matches(effective);
      if (mine) ownClauses.push(clause);
      if (at < 0 || /(?:不|勿|忌|禁)[^，,；;。]{0,2}$/u.test(head)) continue;
      for (const match of clause.matchAll(TEXTBOOK_DECOCTION_METHOD)) (mine ? own : otherForm).add(match[0] === "布包" ? "包煎" : match[0]);
    }
  }
  return { own, otherForm, ownText: ownClauses.join("，") };
}

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
  const liquid = LIQUID_ADJUNCT_METHODS[normalizedName(String(value || ""))];
  // 不写 prohibited「同煎」：合同把它读成「不入汤剂、须从方中删除」（route_not_decoction），而汁、乳是要随汤服的。
  if (liquid) return { required: [...liquid], oneOf: [], prohibited: [] };
  const herb = resolveHerb(value);
  const textbook = textbookUsageMethods(value);
  if (!herb) return textbook && textbook.own.size > 0 ? { required: [...textbook.own], oneOf: [], prohibited: [] } : undefined;
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
      // curatedDose 是未经复核的模型生成行。药典用法用量先给煎服量、研粉只是另一种用法（川贝母「3～10g；研粉冲服，一次1～2g」）时，
      // 它写的「冲服」不升格成必选：此前川贝母因此一律标冲服而剂量仍按煎服量给（留出例 S011「冲服 6g」，药典研粉冲服一次 1～2g）。
      //《北京市中药饮片调剂规程》的冲服品种里也没有川贝母（只有三七粉等「粉」）。
      const pharmacopoeiaDoseText = (herb.entries || [])
        .filter((item) => item.type === "dose")
        .map((item) => typeof item.doseText === "string" ? item.doseText : "")
        .join("；");
      const powderIsAlternative = /^\s*\d+(?:\.\d+)?～\d+(?:\.\d+)?g[；;]\s*研(?:粉|末)/u.test(pharmacopoeiaDoseText);
      for (const method of entry.methods) {
        if (typeof method !== "string") continue;
        if (powderIsAlternative && /冲服|调服|研粉|研末|吞服|丸散/.test(method) && !/先煎|后下|包煎|另煎|另炖|烊化/.test(method)) continue;
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
  // 教材按规格分写的煎法：另一规格才有的那一种不归这味药（滑石不包煎）；知识库收了这味药却没有煎法条目、教材写了的补上
  //（代赭石先煎、檀香后下、饴糖烊化…，textbookUsageMethods）。
  for (const method of textbook?.otherForm || []) if (!textbook?.own.has(method)) required.delete(method);
  for (const method of textbook?.own || []) {
    if (!required.has(method) && !oneOf.some((alternatives) => alternatives.includes(method))) required.add(method);
  }
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

/**
 * 药典要求的煎法写成一种：几选一（大黄「后下或先煎或冲服」）取所列第一种，与煎服行的取法同一（specialDecoctionOrderIndex）。
 * 2026-10-17：此前整串写给模型与药味表，模型照抄成「大黄（后下或先煎或冲服、禁止久煎）」，煎服行却已定为后下，医生看不出到底怎么煎
 *（甲方标准病历 7，独立评审）。
 */
export function requiredDecoctionRequirement(value: string): string | undefined {
  const rule = decoctionRuleForHerb(value);
  if (!rule) return undefined;
  return [
    ...rule.required,
    ...rule.oneOf.map((alternatives) => alternatives[0]),
    ...rule.prohibited.map((method) => `禁止${method}`),
  ].join("、") || undefined;
}

/** 药味表里照抄的几选一整串换成选定的那一种（声明里只点了其中一种的不动）。 */
export function withOneOfDecoctionResolved(value: string, declared: string): string {
  const rule = decoctionRuleForHerb(value);
  let out = declared;
  for (const alternatives of rule?.oneOf || []) {
    const joined = alternatives.join("或");
    if (out.includes(joined)) out = out.split(joined).join(alternatives[0]);
  }
  return out;
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

/**
 * 需要在煎服用法里点名的特殊煎法，按煎药的先后顺序排列。「捣碎」之类不改变下药顺序的不在此列。
 * 先煎且久煎的毒性药（药典：附子、制川乌、制草乌「先煎，久煎」）单列在最前：此前它们与龙骨、牡蛎并在一起写「先煎20–30分钟」，
 * 而药味表里标的是「先煎、久煎」，两处不一致，时间也不够（2026-10-14 独立评审，7 岁患儿方中有附子）。
 * 时长取《中药学》总论：「附子、川乌、草乌等毒性大的药物，宜先煎45～60分钟后再下它药」；附子条：「先煎，久煎，口尝至无麻辣感为度」。
 * 煎服行（diagnosis-visible-summary）与随证加减的处理说明（m04-proposal-compiler）用这同一张表。
 */
/**
 * 药典【用法与用量】写了先煎时长、且远长于一般先煎 20–30 分钟的药（有限闭集，原文照录）：
 *  · 水牛角：《中国药典》2020 一部「15～30g，宜先煎3小时以上」。此前煎服行与一般先煎并在一起写「水牛角先煎20–30分钟」
 *   （2026-10-19 M 集 Claude 评审 RobustSDT-single_0232，清热地黄汤）。
 * 只在这味药落在先煎一组时起作用（按 normalizedName 认写法）；水牛角浓缩粉冲服，不进先煎一组。组的顺序与编号不变。
 */
const PHARMACOPOEIA_LONG_DECOCTION: Readonly<Record<string, string>> = { 水牛角: "先煎3小时以上" };

function firstDecoctionPhrase(herbs: string): string {
  const names = herbs.split("、").filter(Boolean);
  const long = new Map<string, string[]>();
  const usual: string[] = [];
  for (const name of names) {
    const phrase = PHARMACOPOEIA_LONG_DECOCTION[normalizedName(name)];
    if (phrase) long.set(phrase, [...(long.get(phrase) || []), name]);
    else usual.push(name);
  }
  return [
    ...[...long].map(([phrase, group]) => `${group.join("、")}${phrase}`),
    ...(usual.length > 0 ? [`${usual.join("、")}先煎20–30分钟`] : []),
  ].join("，");
}

export const SPECIAL_DECOCTION_ORDER: ReadonlyArray<{ pattern: RegExp; phrase: (herbs: string) => string }> = [
  { pattern: /久煎/, phrase: (herbs) => `${herbs}先煎45–60分钟（至口尝无麻辣感）` },
  // 药典写了先煎时长、比一般先煎长得多的（水牛角，见 PHARMACOPOEIA_LONG_DECOCTION）在这一组里单独写、写在前面（先下锅）。
  { pattern: /先煎/, phrase: (herbs) => firstDecoctionPhrase(herbs) },
  { pattern: /后下/, phrase: (herbs) => `${herbs}后下` },
  { pattern: /包煎/, phrase: (herbs) => `${herbs}包煎` },
  { pattern: /另煎|另炖/, phrase: (herbs) => `${herbs}另煎兑入` },
  { pattern: /烊化/, phrase: (herbs) => `${herbs}烊化兑服` },
  { pattern: /冲服|冲入/, phrase: (herbs) => `${herbs}冲服（不入煎）` },
  // 鲜汁、乳类（LIQUID_ADJUNCT_METHODS）兑入煎好的药液服，不说「冲服」。排在冲服之后：既有声明里写「冲服」的仍归冲服一组。
  { pattern: /兑服/, phrase: (herbs) => `${herbs}兑入药液服（不入煎）` },
];

/**
 * 这味药在 SPECIAL_DECOCTION_ORDER 里归哪一组（-1 表示不必点名）。药典数据要求的煎法优先；模型自己标了而药典没有要求的
 *（如钩藤后下）同样点名。药典给的是几选一时（大黄「后下或先煎或冲服」），以这味药实际标注的那一种为准，没有标注取所列的第一种——
 * 此前把几选一整串拿来按字面匹配，先碰到「先煎」：药味表写「大黄（后下）」，煎服行却写「大黄先煎20–30分钟」
 *（2026-10-14 独立评审留出样本，含大黄的 5 例全中）。
 */
export function specialDecoctionOrderIndex(name: string, declared = ""): number {
  return specialDecoctionOrderIndexes(name, declared)[0] ?? -1;
}

function specialDecoctionRequirementText(name: string, declared: string): string {
  const rule = decoctionRuleForHerb(name);
  let rest = withoutUnsupportedDecoctionLabels(name, declared);
  const chosenAlternatives = (rule?.oneOf || []).map((alternatives) => {
    const named = alternatives.filter((alternative) => declared.includes(alternative));
    // 只点了其中一种才算选定。把几选一整串照抄（药味表写「大黄（后下或先煎或冲服、禁止久煎）」）不是选择，取所列第一种；
    // 这几个字也不再参与下面的匹配——此前整串留在声明里，先碰到「先煎」（2026-10-14 全量复测 190 例中 3 例）。
    for (const alternative of alternatives) rest = rest.split(alternative).join("");
    return named.length === 1 ? named[0] : alternatives[0];
  });
  return [...(rule?.required || []), ...chosenAlternatives, rest].join("、").replace(/(?:禁止|不宜|不可|不得)[^、；;，,]*/g, "");
}

/**
 * 这味药在煎服行里要点名的各组。下药时机只取一组（specialDecoctionOrderIndex，即第一项）；包煎是包裹方式，与先煎（含久煎）、
 * 后下并存——药典金礞石、青礞石「先煎、包煎」，《中药学》礞石「宜打碎布包先煎」。时机落在先煎或后下、同时要求包煎的，包煎一组
 * 也点名（2026-10-19）：此前只取一组，药味表「先煎、包煎」，煎服行只写「金礞石先煎20–30分钟」。另煎、烊化、冲服、兑服不随群药
 * 同煎，不再叠包煎。「排在包煎之前的组」即久煎、先煎、后下三组（SPECIAL_DECOCTION_ORDER 的顺序）。
 */
export function specialDecoctionOrderIndexes(name: string, declared = ""): number[] {
  const requirement = specialDecoctionRequirementText(name, declared);
  const first = SPECIAL_DECOCTION_ORDER.findIndex((item) => item.pattern.test(requirement));
  if (first < 0) return [];
  const wrap = SPECIAL_DECOCTION_ORDER.findIndex((item) => item.pattern.test("包煎"));
  return first < wrap && SPECIAL_DECOCTION_ORDER[wrap].pattern.test(requirement) ? [first, wrap] : [first];
}

/** 单味药的特殊煎法说明（「附子先煎45–60分钟（至口尝无麻辣感）」）；不必点名时为空串。先煎又包煎的两组都写（「金礞石先煎20–30分钟，金礞石包煎」）。 */
export function specialDecoctionPhrase(name: string, declared = ""): string {
  return specialDecoctionOrderIndexes(name, declared).map((index) => SPECIAL_DECOCTION_ORDER[index].phrase(name)).join("，");
}

/** 特殊煎法标注（改变下药时机或方式的那几种）。「捣碎」「打碎」是准备，不在此列。 */
const SPECIAL_DECOCTION_LABEL = /先煎|久煎|后下|包煎|另煎|另炖|烊化|冲服|兑服/gu;

/**
 * 这味药的特殊煎法标注有没有出处：受治理煎法规则（药典煎法条目与本文件的补充表）或《中药学》【用法用量】写到的才算
 *（2026-10-19 留出例 S054：模型给肉豆蔻标「后下」——药典与教材都是「煎服，3～10g。内服须煨制去油用」，后下是豆蔻的用法，
 * 模型把两味弄混了，药味表与煎服行都写成「肉豆蔻后下」）。两处都查不到这味药时返回 undefined：判不了，不删。
 * 回放 759 个特殊煎法标注（M/X 验收集与甲方 10 例、留出集），无出处的只有 2 个：肉豆蔻后下、半夏先煎。
 */
export function supportedSpecialDecoctionLabels(value: string): Set<string> | undefined {
  const rule = decoctionRuleForHerb(value);
  const usage = textbookUsageMethods(value);
  if (!rule && !usage) return undefined;
  const supported = new Set<string>();
  // 教材按规格分写时只看这一规格的那几句（「滑石粉包煎」不给「滑石」作出处）。
  for (const method of [...(rule?.required || []), ...(rule?.oneOf || []).flat(), usage?.ownText || ""]) {
    for (const match of String(method).matchAll(SPECIAL_DECOCTION_LABEL)) supported.add(match[0]);
  }
  if (supported.has("另煎")) supported.add("另炖");
  if (supported.has("另炖")) supported.add("另煎");
  return supported;
}

/**
 * 去掉没有出处的特殊煎法标注（见 supportedSpecialDecoctionLabels），其余照留：「禁止久煎」这类禁止语、「捣碎」这类准备不动。
 * 编译器写药味表、煎服行按药味取特殊煎法（specialDecoctionOrderIndex）都过这一道，两处说法一致。
 */
export function withoutUnsupportedDecoctionLabels(value: string, declared: string): string {
  const text = String(declared || "");
  if (!text.trim()) return text;
  const supported = supportedSpecialDecoctionLabels(value);
  if (!supported) return text;
  const pieces = text.split(/([、，,；;\s]+)/u);
  const kept: string[] = [];
  let dropped = false;
  for (let index = 0; index < pieces.length; index += 2) {
    const piece = pieces[index];
    const labels = [...piece.matchAll(SPECIAL_DECOCTION_LABEL)].map((match) => match[0]);
    const prohibition = /^(?:禁止|不宜|不可|不得|避免|勿)/u.test(piece.trim());
    if (prohibition || labels.length === 0 || labels.every((label) => supported.has(label))) kept.push(piece);
    else dropped = true;
  }
  return dropped ? kept.filter((piece) => piece.trim()).join("、") : text;
}
