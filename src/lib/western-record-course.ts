import certaintyPolicy from "../data/western-certainty-policy.source.json";
import { SERVER_LABELED_GROUNDING_LINE } from "./diagnosis-safety";
const COURSE_SPAN = new RegExp(certaintyPolicy.courseRules.spanPattern, "gu");
const COURSE_UNIT_DAYS: Record<string, number> = certaintyPolicy.courseRules.unitDays;
const CHINESE_DIGITS: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

function courseNumber(token: string): number | undefined {
  if (/^\d+(?:\.\d+)?$/u.test(token)) return Number(token);
  if (CHINESE_DIGITS[token]) return CHINESE_DIGITS[token];
  const tens = token.match(/^([一二两三四五六七八九])?十([一二三四五六七八九])?$/u);
  if (tens) return (tens[1] ? CHINESE_DIGITS[tens[1]] : 1) * 10 + (tens[2] ? CHINESE_DIGITS[tens[2]] : 0);
  return undefined;
}

/**
 * upperExclusive：「2月余」「10余天」「3个多月」是「满 N、不到 N+1」——上界本身取不到（2026-10-29 甲方「失眠…2月余」：上界 90 天
 * 与慢性失眠障碍的 90 天门槛相等，按「上界 < 门槛」判成够不上未满，交付了「慢性失眠障碍」）。确数（「3个月」）上界就是它本身。
 */
type CourseSpan = { lower: number; upper: number; upperExclusive: boolean; index: number; length: number };

export function courseSpans(text: string): CourseSpan[] {
  const spans: CourseSpan[] = [];
  for (const match of text.normalize("NFKC").matchAll(COURSE_SPAN)) {
    const [whole, amount, before, , middle, unit, after] = match;
    const days = COURSE_UNIT_DAYS[unit];
    if (!days) continue;
    // 「每3天1次」「3天一行」是频次，不是病程。
    const tail = text.normalize("NFKC").slice((match.index || 0) + whole.length, (match.index || 0) + whole.length + 2);
    if (/^(?:1|一)次|^一行/u.test(tail)) continue;
    const approx = Boolean(before || middle || after);
    let lower: number;
    let upper: number;
    if (amount === "半") {
      lower = upper = 0.5 * days;
    } else if (amount === "数" || amount === "几") {
      lower = 2 * days;
      upper = 9 * days;
    } else {
      const value = courseNumber(amount);
      if (value == null || value <= 0) continue;
      lower = value * days;
      upper = approx ? (value >= 10 && value % 10 === 0 ? value + 10 : value + 1) * days : lower;
    }
    spans.push({ lower, upper, upperExclusive: approx && amount !== "半" && amount !== "数" && amount !== "几", index: match.index || 0, length: whole.length });
  }
  return spans;
}

/** 病历主诉那一行：带「主诉」标签的行，否则第一行（甲方传参形状里第一行就是主诉）；太长的不是主诉。 */
/** 主诉末尾的病程（「3月」「1月余」「XXX天」）：甲方模板里病程常写成 XXX。 */
export function withoutTrailingCourse(text: string): string {
  return text.replace(new RegExp(certaintyPolicy.courseRules.trailingPattern, "iu"), "");
}

export function chiefComplaintLine(recordText: string): string {
  const lines = recordText.split(/\n+/u).map((line) => line.trim()).filter(Boolean);
  const labelled = lines.find((line) => /^主诉\s*[:：]/u.test(line));
  const line = labelled ? labelled.replace(/^主诉\s*[:：]\s*/u, "") : lines.find((line) => !SERVER_LABELED_GROUNDING_LINE.test(line)) || "";
  return line.length <= 60 ? line : "";
}

export function recordCourseDays(recordText: string, nonCoursePrefix?: RegExp, presentIllness?: unknown): { lower: number; upper: number; upperExclusive: boolean } | undefined {
  const chief = chiefComplaintLine(recordText);
  // 交付文字核对可排除「孕20周」这类上下文时长；默认调用保持既有判据。
  const eligible = (text: string) => courseSpans(text).filter((span) => !nonCoursePrefix?.test(text.slice(0, span.index)));
  let spans = eligible(chief);
  // 主诉留了占位、但本次现病史有明确病程时，用同一数值读法；不从既往史或用药史补时长。
  if (spans.length === 0 && typeof presentIllness === "string") spans = eligible(presentIllness);
  if (spans.length === 0) return undefined;
  const upper = Math.max(...spans.map((span) => span.upper));
  return {
    lower: Math.max(...spans.map((span) => span.lower)),
    upper,
    upperExclusive: spans.filter((span) => span.upper === upper).every((span) => span.upperExclusive),
  };
}

/** 病程确定够不上门槛（天）：上界取不到时等于门槛也算够不上。 */
export function recordCourseBelowThreshold(course: { upper: number; upperExclusive: boolean }, thresholdDays: number): boolean {
  return course.upperExclusive ? course.upper <= thresholdDays : course.upper < thresholdDays;
}

