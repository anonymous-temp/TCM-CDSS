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

/**
 * 病历抬头姓名（句首中文姓名 + 性别/年龄）的**共享**脱敏。
 *
 * 【为什么单独提出来】服务端 scrubPhi 与浏览器持久化 scrubPersistentPhiText 各自
 * 在共享的 scrubQuasiIdentifierText 之上叠了一套**自己的**姓名规则，两套策略不同：
 * 服务端走上下文模式（句首+性别年龄、患者+姓名、本例+姓名…），浏览器走百家姓枚举。
 * 行为实测（2026-08-16）：
 *   「张伟，男，45岁，主诉胃脘痛3天」   服务端 ✓脱敏 / 浏览器 **✗留存**
 *   「欧阳明月，女，32岁，头痛」        服务端 ✓脱敏 / 浏览器 **✗留存**（复姓不在枚举内）
 *   「本例赵敏既往有高血压」            服务端 ✓脱敏 / 浏览器 **✗留存**
 *   「患者李娜」「姓名：王建国」「身份证号」两侧一致 ✓
 * 浏览器那侧保护的是 **localStorage 里的静态 PHI**——「姓名，男，NN岁」正是标准 HIS
 * 抬头格式，漏掉它意味着患者姓名长期留在浏览器里。
 *
 * 【本次只收敛这一条，不做全量合并】服务端姓名规则有 10+ 条 52 行，全量合并是一次
 * PHI 安全代码的大重构；在缺乏充分回归覆盖时做砸比现有缺口更糟。这条的过度脱敏风险最低
 * （必须后接 男/女/NN岁 才触发），且覆盖最高频的漏法。其余差异记为已知缺口，见
 * test:duplicated-safety-predicates 的注释与 docs 未完项。
 *
 * 【两侧共有的、本次未修的缺口】外文译名（「麦克·约翰逊，男，50岁」）两侧都留存——
 * 服务端的中点姓名规则要求前缀（姓名/患者/家属…），句首规则又限定 2-4 个汉字且不含中点。
 */
const CHINESE_SURNAME = /(?:赵|钱|孙|李|周|吴|郑|王|冯|陈|褚|卫|蒋|沈|韩|杨|朱|秦|尤|许|何|吕|施|张|孔|曹|严|华|金|魏|陶|姜|戚|谢|邹|喻|柏|水|窦|章|云|苏|潘|葛|奚|范|彭|郎|鲁|韦|昌|马|苗|凤|花|方|俞|任|袁|柳|鲍|史|唐|费|廉|岑|薛|雷|贺|倪|汤|滕|殷|罗|毕|郝|邬|安|常|乐|于|时|傅|皮|卞|齐|康|伍|余|元|顾|孟|黄|和|穆|萧|尹|姚|邵|汪|祁|毛|禹|狄|米|贝|明|臧|计|伏|成|戴|宋|茅|庞|熊|纪|舒|屈|项|祝|董|梁|杜|阮|蓝|闵|席|季|麻|强|贾|路|娄|危|江|童|颜|郭|梅|盛|林|钟|徐|邱|骆|高|夏|蔡|田|樊|胡|凌|霍|虞|万|支|柯|管|卢|莫|房|裘|缪|干|解|应|宗|丁|宣|邓|郁|单|杭|洪|包|诸|左|石|崔|吉|龚|程|嵇|邢|裴|陆|荣|翁|荀|羊|甄|曲|封|储|靳|段|巫|乌|焦|巴|弓|牧|隗|山|谷|车|侯|宓|蓬|全|班|仰|秋|仲|伊|宫|宁|仇|栾|暴|甘|厉|戎|祖|武|符|刘|景|詹|束|龙|叶|幸|司|韶|黎|乔|苍|双|闻|莘|党|翟|谭|贡|劳|逄|姬|申|扶|堵|冉|宰|郦|雍|却|璩|桑|桂|濮|牛|寿|通|边|扈|燕|冀|浦|尚|农|温|别|庄|晏|柴|瞿|阎|连|习|艾|鱼|容|向|古|易|廖|终|步|都|耿|满|弘|匡|国|文|寇|广|禄|阙|东|欧|利|蔚|越|夔|隆|师|巩|厍|聂|晁|勾|敖|融|冷|訾|辛|阚|那|简|饶|空|曾|毋|沙|乜|养|鞠|须|丰|巢|关|蒯|相|查|后|荆|红|游|竺|权|逯|盖|益|桓|公)/;
/** 复姓：单字姓枚举覆盖不到，实测「欧阳明月，女，32岁」两侧都漏。 */
const CHINESE_COMPOUND_SURNAME = /(?:欧阳|司马|上官|夏侯|诸葛|东方|皇甫|尉迟|公羊|澹台|公冶|宗政|濮阳|淳于|单于|太叔|申屠|公孙|仲孙|轩辕|令狐|钟离|宇文|长孙|慕容|司徒|司空|鲜于|闾丘|子车|亓官|司寇|巫马|公西|颛孙|壤驷|公良|漆雕|乐正|拓跋|夹谷|完颜|赫连|端木|万俟|南宫)/;

export function scrubRecordHeaderName(text: string, marker = "[姓名已脱敏]"): string {
  const source = String(text || "");
  const header = source.match(/^([\u4e00-\u9fa5]{2,4})(?=[，,；。\s]*(?:男|女|\d{1,3}\s*岁))/);
  if (!header) return source;
  const candidate = header[1];
  // **必须以已知姓氏开头**才认定为姓名。只靠「句首 2-4 字 + 性别/年龄」这一个上下文条件，
  // 实测会把临床文本整段吃掉（服务端 scrubPhi 至今如此）：
  //   「反复咳嗽，男，45岁」 → 「[已脱敏]，男，45岁」   ← 主诉开头没了
  //   「初诊，女，32岁」     → 「[已脱敏]，女，32岁」
  //   「既往体健，男，60岁」 → 「[已脱敏]，男，60岁」
  //   「患者男，45岁」       → 「[已脱敏]，45岁」        ← 连「男」都被吃
  // 这是**送模型路径上的临床信息丢失**，不只是显示问题。
  // 姓氏枚举 + 上下文两个条件取交集，才既认得出姓名、又不误伤临床措辞。
  const startsWithSurname = new RegExp(`^(?:${CHINESE_COMPOUND_SURNAME.source}|${CHINESE_SURNAME.source})`).test(candidate);
  if (!startsWithSurname) return source;
  return source.replace(header[0], marker);
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
