const OCCUPATION_GROUPS: Array<[RegExp, string]> = [
  [/(?:医生|医师|护士|药师|医务|护理)/, "医疗卫生工作"],
  [/(?:教师|老师|教授|讲师|教研)/, "教育工作"],
  [/(?:程序员|开发|工程师|设计师|会计|文员|行政|办公室)/, "室内脑力工作"],
  [/(?:司机|驾驶|快递|外卖|运输)/, "交通运输工作"],
  [/(?:焊工|矿工|化工|喷漆|粉尘|工人|车间|制造)/, "工业生产工作"],
  [/(?:农民|务农|种植|养殖|渔民)/, "农业生产工作"],
  [/(?:厨师|餐饮|食品加工)/, "餐饮工作"],
  [/(?:学生|研究生|本科生|中学生|小学生)/, "学生"],
  [/(?:退休|离休)/, "退休"],
  [/(?:无业|待业)/, "暂未就业"],
];

const GENERALIZED_OCCUPATIONS = new Set([
  ...OCCUPATION_GROUPS.map(([, group]) => group),
  "[职业已泛化]",
]);

/** Preserve clinically relevant exposure category without retaining a rare job title or employer. */
export function generalizeOccupation(value: string | undefined): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (GENERALIZED_OCCUPATIONS.has(text)) return text;
  for (const [pattern, group] of OCCUPATION_GROUPS) if (pattern.test(text)) return group;
  return "[职业已泛化]";
}

/** Shared quasi-identifier pass used by browser persistence and every external model egress. */
export function scrubQuasiIdentifierText(text: string): string {
  return text
    // Exact encounter timestamps are not clinically needed by the model; duration/relative time in
    // the clinical narrative remains untouched.
    .replace(/(?:就诊|接诊|门诊|问诊|入院|出院)(?:时间|日期)?\s*[:：]?\s*(?:20\d{2})[-/.年]\d{1,2}[-/.月]\d{1,2}日?(?:[T\s]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?/gi, (match) => {
      const label = match.match(/^(?:就诊|接诊|门诊|问诊|入院|出院)(?:时间|日期)?/)?.[0] || "就诊时间";
      return `${label}：[已泛化]`;
    })
    .replace(/\b20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g, "[精确时间已泛化]")
    // Address labels are handled by the existing scrubbers. This catches an address embedded in
    // prose without a label, while requiring an address-specific road/street token plus house no.
    .replace(/(^|[\s，,；;。])(?:[\u4e00-\u9fa5]{2,}(?:省|自治区|市|区|县|镇|乡|街道|社区|村))?[\u4e00-\u9fa5A-Za-z0-9]{1,24}(?:大道|路|街|巷|弄|胡同)\s*\d{1,6}(?:号|弄)(?:\s*\d{1,4}(?:栋|幢|单元|室)){0,3}/g, "$1[地址已脱敏]")
    .replace(/(?:职业|工作岗位|occupation)\s*[:：]?\s*[^，,；;。\n]+/gi, (match) => {
      const value = match.replace(/^(?:职业|工作岗位|occupation)\s*[:：]?\s*/i, "");
      return `职业：${generalizeOccupation(value)}`;
    });
}

export function dateOnly(value: string | undefined): string {
  return value?.match(/^\d{4}-\d{2}-\d{2}/)?.[0] || "";
}
