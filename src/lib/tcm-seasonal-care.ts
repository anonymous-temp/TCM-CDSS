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

export function buildSeasonalCare(clinicalPattern: string, date = new Date()): SeasonalCare {
  const term = currentSolarTerm(date);
  const base = SEASONAL_BASE[term.season];
  const pattern = clinicalPattern.replace(/\s+/g, "");
  const tailored: string[] = [];

  if (/(阴虚|火旺|内热|痰热|湿热|阳亢|血热)/.test(pattern)) {
    tailored.push("本例偏热象时，减少辛辣、酒类及熬夜等助热因素，关注口渴、汗出和睡眠变化");
  }
  if (/(阳虚|寒证|虚寒|畏寒|形寒|寒湿)/.test(pattern)) {
    tailored.push("本例偏寒象时，避免长时间受凉及过量生冷，运动强度以不明显疲劳为度");
  }
  if (/(痰湿|夹湿|湿困|湿阻|湿热|水湿)/.test(pattern)) {
    tailored.push("本例夹湿时，重点观察纳食、腹胀、大便和肢体困重，饮食避免黏腻厚味");
  }
  if (/(气虚|血虚|心脾两虚|脾虚|肾虚)/.test(pattern)) {
    tailored.push("本例有虚象时，活动和作息宜循序恢复，避免连续劳倦或一次性过量运动");
  }

  return {
    solarTerm: `${term.name}前后`,
    climateFocus: base.focus,
    advice: [base.advice, ...tailored].join("；") + "。",
  };
}
