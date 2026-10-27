import herbCategoriesJson from "../data/tcm-herb-function-categories.json";
import { clinicianDoseHerbClass, getTcmHerbGenerationSafetyProfile, getTcmHerbRiskProfile } from "./tcm-knowledge";
/**
 * 活动性出血红旗时的治法与用药（第二十三轮，用户要求处理：胎盘早剥被开少腹逐瘀汤，君药延胡索、川芎是活血化瘀药）。
 *
 * 剂量一致化（D4）后红旗病例也给剂量，开方核对在活动性出血时拦《中药学》活血化瘀药（m04GenerationSpecialPopulationIssue）。
 * 但辨证阶段若把治法定成「活血化瘀」、锁定以活血化瘀药为君的方，开方阶段只能二选一：违背锁定方，或违背出血规则，
 * 修复轮收不住，整页退成非剂量页。根子在治法：出血未止时先止血，这是血证的通则，不是本系统自创。依据（本地语料逐字核过）：
 *   · 唐容川《血证论》卷二·吐血（tcmoc-master/books/209-血证论.txt 第 313–315 行）：「惟以止血为第一要法。血止之后。
 *     其离经而未吐出者。是为瘀血……故以消瘀为第二法……故以宁血为第三法……故又以补虚为收功之法」；
 *   · 《中医内科学》血证（TCM Educational Materials.txt 第 236691 行）：「治火、治气、治血是血证治疗三大原则」；
 *   · 《中医妇科学》妊娠病（同上第 121674 行）：「妊娠期间凡峻下、滑利、祛瘀、破血、耗气、散气及一切有毒药品，均应慎用或禁用」。
 * 化瘀止血药（三七、蒲黄、茜草、花蕊石）在《中药学》止血药一章，不属活血化瘀药，开方核对不拦。茜草性寒、功效含「凉血」，
 * 证无热象时会被「清热方向无病机支撑」核对拦下（第二十四轮 C098 肺栓塞咯血），提示词举例时不把它放在前面。
 */
export const ACTIVE_BLEEDING_M03_RULE =
  "【活动性出血】本例有活动性出血红旗：急则治标，治法以止血为先——《血证论》「惟以止血为第一要法。血止之后……故以消瘀为第二法」，" +
  "《中医内科学》血证以治火、治气、治血为三大原则。有瘀者用化瘀止血之法（如三七、蒲黄、花蕊石；证属血热时可用茜草），不立活血化瘀、破血逐瘀为主法，" +
  "也不推荐以活血化瘀药为君的方；妊娠病例并遵《中医妇科学》「妊娠期间凡峻下、滑利、祛瘀、破血……均应慎用或禁用」。" +
  "辨病辨证照常写，证名可如实写出瘀象，治法与方向按上述原则。";

/**
 * 本系统按《中药学》（第十版）归为活血化瘀药的饮片（tcm-herb-function-categories.json，开方核对就按这张表拦）。提示词里此前只举了
 * 十来个例子加「等」，模型按旧版教材把降香当化瘀止血药作君（第二十五轮 C098 肺栓塞咯血丝，整方退成非剂量页）。全表列出；
 * 管制、有毒、濒危的不点名（它们本来就由医师单独定量，不进系统剂量）。
 */
const BLOOD_MOVING_HERBS_FOR_PROMPT = Object.entries((herbCategoriesJson as { categories: Record<string, string[]> }).categories)
  .filter(([name, categories]) => {
    if (!categories.includes("活血化瘀药")) return false;
    if (clinicianDoseHerbClass(name)?.match(/^(?:controlled_or_toxic|endangered_or_banned)$/)) return false;
    // 有毒、破血逐瘀的不点名，提示里按类写；知识库查不到风险条目的写法（表里的「斑鳌」）也不列。
    const risk = getTcmHerbRiskProfile(name);
    return Boolean(risk) && !risk.includes("BLOOD_BREAKING") && getTcmHerbGenerationSafetyProfile(name).toxicity.length === 0;
  })
  .map(([name]) => name);
// 原规则举过的十味照旧放在最前（桃仁带「破血」风险标记，按上面的筛法会被略去）。
const RULE_EXAMPLES_BEFORE_ROUND_25 = "川芎、丹参、红花、桃仁、延胡索、牛膝、益母草、五灵脂、没药、乳香";
const BLOOD_MOVING_HERBS_LISTED = [...new Set([...RULE_EXAMPLES_BEFORE_ROUND_25.split("、"), ...BLOOD_MOVING_HERBS_FOR_PROMPT])];

export const ACTIVE_BLEEDING_M04_RULE =
  "【活动性出血】本例有活动性出血红旗：《中药学》活血化瘀药不得入方，开方核对会拦下；本系统按《中药学》（第十版）归为活血化瘀药的有：" +
  `${BLOOD_MOVING_HERBS_LISTED.join("、")}，以及破血逐瘀类药（降香、郁金虽有化瘀止血或止血之功，也在此列）；` +
  "治以止血为先（《血证论》「惟以止血为第一要法」），确需化瘀时用化瘀止血药（三七、蒲黄、花蕊石；茜草性寒、功效写「凉血」，只在证属血热时用）。锁定方或教材代表方的君药属活血化瘀药时，去掉这几味、" +
  "candidate.name 写「本例辨证组方」，formulaAnalysis 第一句写明参照哪首方、去了哪几味（活动性出血不宜活血化瘀）。";

/**
 * 活动性出血时治法里的止血一项排在最前（《血证论》「惟以止血为第一要法」）。模型写成「化瘀通络，宣肺平喘，宁络止血」时，
 * 开方阶段「君药承担治法第一项」把化瘀药推上君位，与本例「活血化瘀药不入方」相撞，修复轮收不住、整页退成非剂量
 *（2026-10-27 第二十四轮生产探针 C098 肺栓塞咯血丝，连续 3 次）。只调次序，不增删治法；治法里没有止血一项时原样返回。
 */
export function hemostasisFirstMethod(method: string): string {
  const items = String(method || "").split(/[，,、；;]/u).map((item) => item.trim()).filter(Boolean);
  const index = items.findIndex((item) => item.includes("止血"));
  if (index <= 0) return method;
  return [items[index], ...items.filter((_, position) => position !== index)].join("，");
}

/**
 * 红旗里的出血只是「需排除」的情况、病历没记载当前出血时（activeBleedingWording = to_exclude），处理照旧（排除之前按出血处理），
 * 只是措辞写「出血尚未排除」：C068 盆腔炎方义写成「因活动性出血不宜活血化瘀」，评审判病历里没有的出血（2026-10-27）。
 */
const TO_EXCLUDE_LEAD = "【出血尚未排除】本例红旗要求排除的出血（如腹腔内、颅内出血）尚未排除，排除之前按出血处理：";
const TO_EXCLUDE_TAIL = "依据、治法与方义里写「出血尚未排除」，不要写成本例已有活动性出血。";
export function activeBleedingM03Rule(wording: "recorded" | "to_exclude" = "recorded"): string {
  if (wording === "recorded") return ACTIVE_BLEEDING_M03_RULE;
  return ACTIVE_BLEEDING_M03_RULE.replace("【活动性出血】本例有活动性出血红旗：", TO_EXCLUDE_LEAD) + TO_EXCLUDE_TAIL;
}
export function activeBleedingM04Rule(wording: "recorded" | "to_exclude" = "recorded"): string {
  if (wording === "recorded") return ACTIVE_BLEEDING_M04_RULE;
  return ACTIVE_BLEEDING_M04_RULE.replace("【活动性出血】本例有活动性出血红旗：", TO_EXCLUDE_LEAD)
    .replace("（活动性出血不宜活血化瘀）", "（出血尚未排除，不宜活血化瘀）") + TO_EXCLUDE_TAIL;
}
