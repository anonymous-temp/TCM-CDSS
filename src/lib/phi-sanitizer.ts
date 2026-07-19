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
    // the clinical narrative remains untouched. The clock time may follow 日 directly
    // (就诊时间：2026年7月18日14:35) — the separator is optional and a full-width colon is allowed,
    // so the labeled pass never leaves a bare time fragment behind.
    .replace(/(?:就诊|接诊|门诊|问诊|入院|出院)(?:时间|日期)?\s*[:：]?\s*(?:20\d{2})[-/.年]\d{1,2}[-/.月]\d{1,2}日?(?:[T\s]?\d{1,2}[:：]\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?/gi, (match) => {
      const label = match.match(/^(?:就诊|接诊|门诊|问诊|入院|出院)(?:时间|日期)?/)?.[0] || "就诊时间";
      return `${label}：[已泛化]`;
    })
    // Precise datetimes, ISO (T or space separator) and Chinese format. Both run before the bare-date
    // pass so a full datetime collapses to one marker instead of a date marker plus a leaked time.
    .replace(/\b20\d{2}-\d{1,2}-\d{1,2}[T\s]\d{1,2}[:：]\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g, "[精确时间已泛化]")
    .replace(/20\d{2}年\d{1,2}月\d{1,2}日\s*\d{1,2}[:：]\d{2}(?::\d{2})?/g, "[精确时间已泛化]")
    // Bare dates are quasi-identifiers on every egress path (model + snapshot). Year-month onset text
    // (2026年3月) carries clinical meaning and intentionally stays intact.
    .replace(/\b(?:19|20)\d{2}[-/.]\d{1,2}[-/.]\d{1,2}\b/g, "[日期已泛化]")
    // Address labels are handled by the existing scrubbers. This catches an address embedded in
    // prose without a label, while requiring an address-specific road/street token plus house no.
    // The tail tolerates 号院/号楼 and a trailing room number so no fragment (院3栋502) survives.
    .replace(/(^|[\s，,；;。])(?:[一-龥]{2,}(?:省|自治区|市|区|县|镇|乡|街道|社区|村))?[一-龥A-Za-z0-9]{1,24}(?:大道|路|街|巷|弄|胡同)\s*\d{1,6}(?:号|弄)(?:院|楼)?(?:\s*\d{1,4}(?:栋|幢|单元|室)){0,3}(?:\s*\d{3,4}室?)?/g, "$1[地址已脱敏]")
    // Compound residence names (小区/花园/苑/园/公寓/大院/新村) carry no road token, so they fire only
    // when BOTH a residence anchor (住/居住/家住/居于/住在) AND an administrative token (省/市/区/县)
    // precede the name within a short window. Clinical/regional text such as 腹部四区, 产业园区合作 or
    // 校区 lacks at least one guard and passes through untouched.
    .replace(/(家住|居住|居于|住在|住)([一-龥]{0,8}(?:省|自治区|市|区|县)[一-龥]{0,10}?(?:小区|花园|苑|园|公寓|大院|新村)[一-龥]{0,4})/g, "$1[地址已脱敏]")
    // Anchored free-text occupations route through the same generalizer as the occupation field
    // (unknown titles fall to [职业已泛化]). Unanchored titles in prose are NOT regexed — clinical
    // false-positive risk; they remain a known limitation with field-level occupation as mitigation.
    // The value stops at digits (a following duration like 20年 survives) and never starts inside a
    // __CDSS_REDACTION_n__ protection token emitted by the persistence layer, keeping re-saves
    // idempotent.
    .replace(/(职业为|从事|任职于|工作于|工作岗位为|职业|工作岗位|occupation)\s*[:：]?\s*([^，,；;。\n\d_]{2,30})/gi, (_match, anchor: string, value: string) => {
      const generalized = generalizeOccupation(value);
      return /^(?:职业|工作岗位|occupation)$/i.test(anchor) ? `职业：${generalized}` : `${anchor}${generalized}`;
    });
}

export function dateOnly(value: string | undefined): string {
  return value?.match(/^\d{4}-\d{2}-\d{2}/)?.[0] || "";
}
