export type MedicationLabelUsage = {
  route?: string;
  singleDose?: string;
  frequency?: string;
  administrationTiming?: string;
  course?: string;
};

function clean(value: string): string {
  return value.trim().replace(/^[：:，,；;。\s]+|[：:，,；;。\s]+$/g, "");
}

// 只抽取说明书原文中实际出现的给药动作。列表按长词优先排列，避免“温开水送服”
// 被截成“送服”；不得根据剂型或药名推断未写明的给药途径。
const ROUTE_PHRASES = [
  "温开水冲服", "温开水送服", "温开水泡服", "开水冲服", "开水送服", "开水泡服",
  "烊化兑服", "另煎兑服", "舌下含服", "直肠给药", "肛门直肠给药", "阴道给药",
  "雾化吸入", "口腔吸入", "鼻腔喷雾", "喷射给药", "口腔用药", "肛门用药",
  "局部外用", "外用药", "开水冲泡", "开水泡饮", "温开水冲饮", "开水冲饮",
  "水煎服", "泡服", "煎服", "调服", "嚼服", "口嚼服", "咀嚼服用", "咀嚼口服",
  "咀嚼咽下", "口含服", "含服", "含化", "吞服", "冲服", "送服", "兑服", "化服",
  "服用", "饮服", "冲饮", "代茶饮", "饮用", "含漱", "漱口", "熏洗", "灌洗",
  "坐浴", "泡足", "喷鼻", "滴眼", "滴鼻", "滴耳用", "吸入", "灌肠", "纳肛",
  "肛门塞入", "肛门给药", "塞入栓剂", "穴位贴敷", "贴敷", "喷或敷药", "涂抹",
  "涂药", "敷药", "点耳", "口嚼", "嚼碎服", "直射疚法", "外贴", "外用", "口服",
] as const;
const EXTERNAL_ROUTE_PREFIXES = new Set(["外用"]);
const ADJACENT_APPLICATION_SITE = /^(?:贴|贴敷|敷|涂|涂擦|搽|擦|喷|滴|塞|纳|置|注入|取适量(?:涂|敷|搽|擦))[^。；;]{0,50}(?:患处|局部|脐部|脐中|眼内|眼部|鼻腔|鼻孔|肛门|直肠|阴道|皮肤|穴位|部位)$/;
const SITE_BOUND_ROUTE = /(?:贴敷|外贴|贴|涂擦|涂敷|涂抹|涂|搽|擦|喷射|喷|滴|点|塞|纳|置|撒放|敷盖|敷|抹洗|冲洗|送|挤|插|放|覆盖)(?:于|入|至|在)?[^，,。；;]{0,32}(?:患处|患部|局部|脐部|脐中|创面|溃疡面|牙痛处|烫伤处|忠处|眼睑内|眼内|患眼|鼻内|鼻腔|鼻孔|口腔|咽喉部|肛门内|肛门|直肠内|直肠|阴道深部|阴道深处|阴道|外阴|宫颈区|皮肤|穴位|痛点|耳内|前额|太阳穴|下腹)/;
const TIMED_ORAL_ROUTE = /(?:饭前|饭后|空腹|睡前|早晨|晨起|清晨|早晚)[^，,。；;]{0,8}(?:口服|服用|服)/;
const INLINE_ORAL_ACTION = /[含服](?=[一二两三四五六七八九十半\d])/;
const BARE_SINGLE_DOSE = /^(?:\d+(?:\.\d+)?|[一二两三四五六七八九十半]+)(?:\s*[～~\-—至]\s*(?:\d+(?:\.\d+)?|[一二两三四五六七八九十半]+))?\s*(?:微克|毫克|克|千克|毫升|mL|ml|滴|喷|贴|枚|片|粒|丸|袋|包|支)$/i;

function routeFromFragments(fragments: readonly string[]): string | undefined {
  for (let index = 0; index < fragments.length; index += 1) {
    const fragment = fragments[index];
    const siteBound = fragment.match(SITE_BOUND_ROUTE)?.[0];
    if (siteBound) return clean(siteBound);
    const timedOral = fragment.match(TIMED_ORAL_ROUTE)?.[0];
    const inlineOral = fragment.match(INLINE_ORAL_ACTION)?.[0];
    const prefix = ROUTE_PHRASES.find((candidate) => fragment.includes(candidate));
    if (!prefix && !timedOral && !inlineOral) continue;
    if (timedOral && !prefix) return clean(timedOral);
    if (inlineOral && !prefix) return inlineOral;
    const adjacent = fragments[index + 1];
    if (fragment === prefix && EXTERNAL_ROUTE_PREFIXES.has(prefix) && adjacent && ADJACENT_APPLICATION_SITE.test(adjacent)) {
      return `${fragment}，${adjacent}`;
    }
    // Return an exact source substring. A route fragment that also contains an executable dose is
    // not copied wholesale into the route field; the dose is projected independently below.
    return prefix;
  }
  return undefined;
}

export function parseMedicationLabelUsage(value: unknown): MedicationLabelUsage {
  const source = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!source) return {};
  const fragments = source.split(/[，,。；;]+/).map(clean).filter(Boolean);
  const route = routeFromFragments(fragments);
  const singleDose = fragments.find((item) =>
    (item.includes("一次") || item.includes("每次")) &&
    !item.includes("一日") && !item.includes("每日") && !item.includes("每天") &&
    !/(?:小时|分钟).*(?:一次|每次)/.test(item)) ||
    fragments.find((item) => BARE_SINGLE_DOSE.test(item));
  const frequency = fragments.find((item) =>
    ((item.includes("一日") || item.includes("每日") || item.includes("每天")) && item.includes("次")) ||
    /(?:每\s*)?\d+(?:\.\d+)?\s*小时[^。；;]{0,12}(?:一次|1次|换药一次)/.test(item));
  const administrationTiming = fragments.find((item) =>
    item.includes("饭前") || item.includes("饭后") || item.includes("餐前") || item.includes("餐后") ||
    item.includes("空腹") || item.includes("睡前") || item.includes("晨起"));
  const course = fragments.find((item) =>
    (item.includes("疗程") || item.includes("连用") || item.includes("连续服用")) &&
    (item.includes("日") || item.includes("天") || item.includes("周")));
  return {
    ...(route ? { route } : {}),
    ...(singleDose ? { singleDose } : {}),
    ...(frequency ? { frequency } : {}),
    ...(administrationTiming ? { administrationTiming } : {}),
    ...(course ? { course } : {}),
  };
}
