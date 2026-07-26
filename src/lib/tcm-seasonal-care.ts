import natureLexicon from "../data/tcm-nature-lexicon.json" with { type: "json" };
import { canonicalTcmNatureTerm } from "./clinical-governance-tables";

/** T2 病性正名全集（含临床扩展）。复合词拆解只在这个受控集合里做，不引入表外词汇。 */
const GOVERNED_NATURE_ENTRIES: ReadonlyArray<{ id: string; canonical: string }> = natureLexicon.entries
  .map((entry) => ({ id: entry.id, canonical: entry.canonical }))
  // 长名优先：先匹配「血热」再匹配「热」，避免复合词被拆到过泛的正名上。
  .sort((left, right) => right.canonical.length - left.canonical.length);

export type SeasonalCare = {
  solarTerm: string;
  climateFocus: string;
  advice: string;
};

type SolarTermBoundary = {
  month: number;
  day: number;
  name: string;
  season: "spring" | "summer" | "long_summer" | "autumn" | "winter";
};

const SOLAR_TERM_BOUNDARIES: SolarTermBoundary[] = [
  { month: 1, day: 5, name: "小寒", season: "winter" },
  { month: 1, day: 20, name: "大寒", season: "winter" },
  { month: 2, day: 4, name: "立春", season: "spring" },
  { month: 2, day: 19, name: "雨水", season: "spring" },
  { month: 3, day: 5, name: "惊蛰", season: "spring" },
  { month: 3, day: 20, name: "春分", season: "spring" },
  { month: 4, day: 4, name: "清明", season: "spring" },
  { month: 4, day: 20, name: "谷雨", season: "spring" },
  { month: 5, day: 5, name: "立夏", season: "summer" },
  { month: 5, day: 21, name: "小满", season: "summer" },
  { month: 6, day: 5, name: "芒种", season: "summer" },
  { month: 6, day: 21, name: "夏至", season: "summer" },
  { month: 7, day: 7, name: "小暑", season: "long_summer" },
  { month: 7, day: 23, name: "大暑", season: "long_summer" },
  { month: 8, day: 7, name: "立秋", season: "long_summer" },
  { month: 8, day: 23, name: "处暑", season: "autumn" },
  { month: 9, day: 7, name: "白露", season: "autumn" },
  { month: 9, day: 23, name: "秋分", season: "autumn" },
  { month: 10, day: 8, name: "寒露", season: "autumn" },
  { month: 10, day: 23, name: "霜降", season: "autumn" },
  { month: 11, day: 7, name: "立冬", season: "winter" },
  { month: 11, day: 22, name: "小雪", season: "winter" },
  { month: 12, day: 7, name: "大雪", season: "winter" },
  { month: 12, day: 21, name: "冬至", season: "winter" },
];

function shanghaiMonthDay(date: Date): { month: number; day: number } {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "numeric",
    day: "numeric",
  }).formatToParts(date);
  const part = (type: "month" | "day") => Number(parts.find((item) => item.type === type)?.value || 0);
  return { month: part("month"), day: part("day") };
}

export function currentSolarTerm(date = new Date()): SolarTermBoundary {
  const { month, day } = shanghaiMonthDay(date);
  const stamp = month * 100 + day;
  return [...SOLAR_TERM_BOUNDARIES]
    .reverse()
    .find((item) => item.month * 100 + item.day <= stamp) || SOLAR_TERM_BOUNDARIES.at(-1)!;
}

const SEASONAL_BASE: Record<SolarTermBoundary["season"], { focus: string; advice: string }> = {
  spring: {
    focus: "气温起伏、风邪与情志舒展",
    advice: "作息逐步顺应日照变化，注意早晚温差；活动以舒缓、持续为宜，避免骤然大汗",
  },
  summer: {
    focus: "暑热、汗出与睡眠节律",
    advice: "避开高温时段久处或剧烈活动，保持通风和规律补水；晚间减少持续兴奋和过晚进食",
  },
  long_summer: {
    focus: "暑湿困脾、汗出与体液消耗",
    advice: "饮食宜清淡有节，减少油腻甜食和过量生冷；高温时段避免剧烈活动，并观察食欲、二便和乏力变化",
  },
  autumn: {
    focus: "燥邪、昼夜温差与呼吸道不适",
    advice: "注意补充水分和室内湿度，避免辛燥过度；早晚添衣，并维持规律睡眠和适量活动",
  },
  winter: {
    focus: "寒邪、阳气潜藏与心脑血管负荷",
    advice: "注意保暖和起居规律，清晨及严寒时段避免骤然剧烈活动；饮食不过度温燥，按症状变化调整活动量",
  },
};

/** T2 病性 id → 调护方向。词表是权威，这里只做 id→建议的映射，不再对自由文本做子串匹配。 */
const HEAT_NATURE_IDS = new Set(["heat", "fire_heat", "blood_heat", "summerheat", "yin_deficiency", "dryness", "fluid_depletion"]);
const COLD_NATURE_IDS = new Set(["cold", "blood_cold", "yang_deficiency"]);
const DAMP_NATURE_IDS = new Set(["dampness", "water_dampness", "phlegm", "fluid_retention"]);
const DEFICIENCY_NATURE_IDS = new Set([
  "qi_deficiency", "blood_deficiency", "yin_deficiency", "yang_deficiency",
  "essence_deficiency", "fluid_depletion", "deficiency", "qi_sinking",
]);

/**
 * 把病性条目解析成受控 T2 id。
 *
 * 原实现对「主证＋兼证＋病机」拼成的一整段自由文本做子串匹配，三个后果：
 *   · 「上热下寒」「寒热错杂」同时命中热象与寒象两条，输出自相矛盾的调护建议；
 *   · 「尚未化热」「无明显湿象」「非阳虚之寒」这类否定表述照样触发对应建议
 *     （该函数不经 clinical-polarity 的任何极性判定）；
 *   · 同一条链路上游**已经**把病性归一成受控 T2 词条，这里却回头去猜自由文本。
 * 现改为接收上游已结构化的病性条目，逐条走 T2 词表。复合词（湿热、寒湿）不是 T2 正名，
 * 按包含关系拆到构成它的正名上——**词汇仍来自 T2**，不是新写的正则表。
 */
function governedNatureIds(natureTerms: readonly string[]): Set<string> {
  const ids = new Set<string>();
  for (const raw of natureTerms) {
    const term = String(raw || "").replace(/\s+/g, "");
    if (!term) continue;
    // 新契约传的是结构化病性条目（「热」「阴虚」），不该出现否定散文。但调用方可能回退成
    // 拼接文本，这里挡一道：「尚未化热」「无明显湿象」「非阳虚之寒」不得触发对应调护。
    if (/^(?:未|无|非|不)|尚未|没有|不明显|排除/.test(term)) continue;
    const exact = canonicalTcmNatureTerm(term);
    if (exact) {
      ids.add(exact.id);
      continue;
    }
    for (const entry of GOVERNED_NATURE_ENTRIES) {
      if (term.includes(entry.canonical)) ids.add(entry.id);
    }
  }
  return ids;
}

export function buildSeasonalCare(
  natureTerms: readonly string[],
  date = new Date(),
): SeasonalCare {
  const term = currentSolarTerm(date);
  const base = SEASONAL_BASE[term.season];
  const natureIds = governedNatureIds(natureTerms);
  const hasHeat = [...natureIds].some((id) => HEAT_NATURE_IDS.has(id));
  const hasCold = [...natureIds].some((id) => COLD_NATURE_IDS.has(id));
  const tailored: string[] = [];

  // 寒热并见（上热下寒、寒热错杂、真寒假热）时给一条合并建议，而不是两条互相打架的。
  if (hasHeat && hasCold) {
    tailored.push("本例寒热并见，起居饮食不宜一味温补或一味清凉，需按医师所辨寒热主次分层调整");
  } else if (hasHeat) {
    tailored.push("本例偏热象时，减少辛辣、酒类及熬夜等助热因素，关注口渴、汗出和睡眠变化");
  } else if (hasCold) {
    tailored.push("本例偏寒象时，避免长时间受凉及过量生冷，运动强度以不明显疲劳为度");
  }
  if ([...natureIds].some((id) => DAMP_NATURE_IDS.has(id))) {
    tailored.push("本例夹湿时，重点观察纳食、腹胀、大便和肢体困重，饮食避免黏腻厚味");
  }
  if ([...natureIds].some((id) => DEFICIENCY_NATURE_IDS.has(id))) {
    tailored.push("本例有虚象时，活动和作息宜循序恢复，避免连续劳倦或一次性过量运动");
  }

  return {
    solarTerm: `${term.name}前后`,
    climateFocus: base.focus,
    advice: [base.advice, ...tailored].join("；") + "。",
  };
}
