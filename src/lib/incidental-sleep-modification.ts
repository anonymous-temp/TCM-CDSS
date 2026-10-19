import { getTcmHerbFunctionText } from "./tcm-knowledge";

/**
 * 「睡眠差随主病而来、不另加安神药」这一条的判据（2026-10-17 起，原在 m04-proposal-compiler.ts；2026-10-20 第八轮移出，
 * 让教材加减的检索与提示词（tcm-textbook-syndromes.ts）也能用同一个判据：教材本证只列了睡眠一条加减（湿疮·血虚风燥证
 * 「瘙痒不能入眠者，加珍珠母、夜交藤、酸枣仁」）时，这一条被编译器按本规则不列，随证加减一栏就是空的，留出例 S132）。
 * 编译器从这里 import 并原名再导出，行为不变。
 */

/** 只需要证名、病名两个字段，编译器的 ClinicalReasoningResultV2 与合同的 M03ReasoningLike 都满足。 */
export type SignedScopeLike = {
  overview?: { primarySyndrome?: string | null; secondarySyndromes?: readonly string[] | null; tcmDiseaseName?: string | null };
};

export const SEDATIVE_CATEGORY = /(?:^|；)(?:养心|重镇)?安神药(?:；|$)/u;
/**
 * 已签名的证名与病名涉及心、神、寐（含夜啼）、悸、郁：睡眠本身就在病机里，安神药不算顺带。
 * 病名本身是神志病的（注意力缺陷多动障碍、抽动障碍、痴呆、癫狂、痫病）同样算：教材这几病的证型就是心肝火旺、心脾两虚、痰火扰神，
 * 只是阴虚、髓海不足这几证的证名里不带「心」「神」（2026-10-19；回放例 X-E-0950 多动障碍·肝肾阴虚「若夜寐不安：加酸枣仁」，
 * 《中医儿科学》本证原文加减 L168782「夜寐不安者，加酸枣仁、五味子」）。
 */
export function signedScopeInvolvesMind(prior: SignedScopeLike): boolean {
  const mindScope = `${prior.overview?.primarySyndrome || ""}${(prior.overview?.secondarySyndromes || []).join("")}${prior.overview?.tcmDiseaseName || ""}`;
  return /心|神|寐|眠|悸|郁|啼|多动|抽动|痴呆|癫|狂|痫/.test(mindScope);
}
/**
 * 随证加减里为顺带的睡眠差加安神药（2026-10-18；留出例 S132 瘾疹「若瘙痒不能入眠：加珍珠母（平肝潜阳安神）」、
 * S158 积滞「若烦躁、夜啼难眠：加蝉蜕（宁心安神）」，独立评审判 incidental-sleep 不通过）。主方的同一条判据只管
 * 君臣佐使表，加减行此前不经过它。判据与主方同源：证名、病名不涉心神；触发条件说的是睡眠；拟加的药归安神药类，
 * 或这条加减自己写的理由就是安神。教材在本证型下列明的加减（条件与药味都对得上）不在此列。
 */
const SLEEP_TRIGGER = /眠|寐|夜啼|夜醒|易醒|早醒|多梦|睡/u;
const SEDATIVE_REASON = /安神|宁神|宁心|镇静|助眠/u;
/**
 * 理由里明写是为了睡眠（「助眠」「安眠」）：触发条件没写睡眠时同样算（2026-10-19 起，按用意判）。
 * 「止啼」不收：回放 1,437 条加减里唯一新命中的是五迟·脾虚肝旺「若惊惕不安较甚、夜啼频作：加天麻（平肝息风、镇惊止啼）」，
 * 天麻治的是肝旺本身。留出例 S132（珍珠母）、S158（蝉蜕）两条是教材本证的加减原文（《中医外科学》湿疮·血虚风燥证
 *「瘙痒不能入眠者，加珍珠母、夜交藤、酸枣仁」；《中医儿科学》积滞·食积化热「烦躁、夜啼难眠者，加蝉蜕、钩藤」），此前按教材加减照列；2026-10-19 起由下面 incidentalSleepTriggerModification 不列。
 */
const SLEEP_PURPOSE_REASON = /助眠|安眠/u;
export function incidentalSleepSedativeModification(
  item: { trigger: string; herbName: string; reason?: string },
  prior: SignedScopeLike,
): boolean {
  if (signedScopeInvolvesMind(prior)) return false;
  if (!SLEEP_TRIGGER.test(item.trigger) && !SLEEP_PURPOSE_REASON.test(item.reason || "")) return false;
  return SEDATIVE_CATEGORY.test(getTcmHerbFunctionText(item.herbName)) || SEDATIVE_REASON.test(item.reason || "");
}
/**
 * 加减条件只说睡不好（「若瘙痒不能入眠」「若烦躁、夜啼难眠」「若失眠多梦明显」），证名、病名不涉心神，加的又是安神药或理由写明安神
 *（incidentalSleepSedativeModification）：教材本证列明的这类加减同样不列（2026-10-19）。
 * 留出例 S132「若瘙痒不能入眠：加珍珠母（重镇安神止痒）」、S158「若烦躁、夜啼难眠：加蝉蜕（清心除烦，安神定惊）」七轮独立评审判
 * incidental-sleep（另四轮按教材加减判通过）；两条都是教材本证加减原文（《中医外科学》湿疮·血虚风燥证 L207559、《中医儿科学》积滞·食积化热 L167648），
 * 此前按教材加减照列。睡眠差随主病而来，治主病即可（与主方去掉顺带的安神药同一口径）。
 * 「只说睡不好」按条目判：条件按顿号逗号拆开，每一条都是睡眠或随之的烦躁。条件里另有成组表现的不算——
 *「若头晕耳鸣、虚烦少寐、腰膝酸软：加熟地黄、五味子、山茱萸」（《中医内科学》血虚头痛）治的是肝肾，「若兼见心悸怔忡，少寐健忘：加柏子仁」
 * 是心血不足（评审判过通过），「若阴虚火旺，兼见五心烦热、躁动失眠：加知母」治的是火旺。
 * 不收「寐深难以唤醒」「因寐不醒」——那是遗尿的睡得太沉，石菖蒲醒神正对。
 */
const SLEEP_LOSS_TRIGGER = /难眠|不能入眠|不眠|失眠|少寐|不寐|多梦|夜啼|入睡困难|难以入睡|影响入睡|夜寐不安|寐不安|睡眠不实|睡不安|易醒|早醒|眠差|寐差/u;
const SLEEP_COMPANION_ITEM = /^(?:烦躁|心烦|虚烦|烦热|躁扰|哭闹)$/u;
const TRIGGER_ITEM_FILLER = /^(?:若|如|兼见|症见|伴有|伴|或)+|(?:者|明显|加重|较甚|尤甚|甚|等)+$/gu;
function sleepOnlyTrigger(trigger: string): boolean {
  const items = String(trigger || "")
    .split(/[、，,；;。]/u)
    .map((item) => item.replace(TRIGGER_ITEM_FILLER, "").trim())
    .filter(Boolean);
  return items.some((item) => SLEEP_LOSS_TRIGGER.test(item)) &&
    items.every((item) => SLEEP_LOSS_TRIGGER.test(item) || SLEEP_COMPANION_ITEM.test(item));
}
export function incidentalSleepTriggerModification(
  item: { trigger: string; herbName: string; reason?: string },
  prior: SignedScopeLike,
): boolean {
  return sleepOnlyTrigger(item.trigger) && incidentalSleepSedativeModification(item, prior);
}

/**
 * 教材加减的一条（条件 + 药）是不是「睡眠差随主病而来」那一类（2026-10-20 第八轮，教材加减检索与提示词用，tcm-textbook-syndromes）：
 * 条件只说睡不好、证名病名不涉心神，加的药**每一味**都是安神药（知识库归安神药类，或功效里写着安神/宁心/镇静/助眠）。
 * 与 incidentalSleepTriggerModification 的区别：那条是对模型写的某一行加减，药的方向可以看模型写的理由；教材条目没有理由，
 * 只看药自己。药里有不是安神药的（心烦失眠加黄连、夜啼难眠加蝉蜕钩藤）不算，编译时由模型的理由决定留不留。
 */
export function textbookModificationIsIncidentalSleep(
  item: { condition: string; herbs: readonly string[] },
  scope: SignedScopeLike,
): boolean {
  if (item.herbs.length === 0 || signedScopeInvolvesMind(scope) || !sleepOnlyTrigger(`若${item.condition.replace(/^若/u, "")}`)) return false;
  return item.herbs.every((herb) => {
    const text = getTcmHerbFunctionText(herb);
    return SEDATIVE_CATEGORY.test(text) || SEDATIVE_REASON.test(text);
  });
}
