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

const ROUTE_PREFIXES = [
  "开水冲服", "温开水冲服", "烊化兑服", "另煎兑服", "舌下含服", "直肠给药",
  "阴道给药", "雾化吸入", "鼻腔喷雾", "喷鼻", "滴眼", "滴鼻", "吸入", "灌肠",
  "纳肛", "肛门塞入", "外用", "口服", "含服", "吞服", "冲服", "兑服",
] as const;
const EXTERNAL_ROUTE_PREFIXES = new Set(["外用"]);
const ADJACENT_APPLICATION_SITE = /^(?:贴|贴敷|敷|涂|涂擦|搽|擦|喷|滴|塞|纳|置|注入|取适量(?:涂|敷|搽|擦))[^。；;]{0,50}(?:患处|局部|脐部|脐中|眼内|眼部|鼻腔|鼻孔|肛门|直肠|阴道|皮肤|穴位|部位)$/;
const BARE_SINGLE_DOSE = /^(?:\d+(?:\.\d+)?|[一二两三四五六七八九十半]+)(?:\s*[～~\-—至]\s*(?:\d+(?:\.\d+)?|[一二两三四五六七八九十半]+))?\s*(?:微克|毫克|克|千克|毫升|mL|ml|滴|喷|贴|枚|片|粒|丸|袋|包|支)$/i;

function routeFromFragments(fragments: readonly string[]): string | undefined {
  for (let index = 0; index < fragments.length; index += 1) {
    const fragment = fragments[index];
    const prefix = ROUTE_PREFIXES.find((candidate) => fragment.startsWith(candidate));
    if (!prefix) continue;
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
