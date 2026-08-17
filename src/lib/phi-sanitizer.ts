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
 * 【2026-08-16 只收敛了抬头这一条】当时判断服务端姓名规则有 10+ 条 52 行，全量合并是一次
 * PHI 安全代码大重构，缺乏回归覆盖时做砸比缺口更糟，于是只收敛过度脱敏风险最低的这条。
 *
 * 【2026-08-17 补完其余三条】发布前逐条实测，推翻了「其余只是缺口」的判断——
 * 剩下三条规则**同时**在漏检和过度脱敏两个方向出错，而过度脱敏发生在**送模型路径**上：
 *   主语前缀（本例X）：「本例患儿出现发热」「该患者既往有糖尿病」「病人自诉头痛」被吃；
 *                       浏览器侧则**完全没有**这条规则。
 *   关系前缀（家属X）：「患者自诉头痛，家属补充…」主诉整段被吃；
 *                       同时「家属王强代述」「监护人张伟签字」漏检（动词表没收这两个词）。
 *   中点姓名：外籍译名与维吾尔/藏/蒙姓名两侧都留存。
 * 四条现已全部收敛为本文件的共享导出，两侧共用，修法一致：**姓氏（或中点）正向判定 ∩ 上下文**。
 * 这四条的正反两向都由 test:duplicated-safety-predicates 钉住。
 */
const CHINESE_SURNAME = /(?:赵|钱|孙|李|周|吴|郑|王|冯|陈|褚|卫|蒋|沈|韩|杨|朱|秦|尤|许|何|吕|施|张|孔|曹|严|华|金|魏|陶|姜|戚|谢|邹|喻|柏|水|窦|章|云|苏|潘|葛|奚|范|彭|郎|鲁|韦|昌|马|苗|凤|花|方|俞|任|袁|柳|鲍|史|唐|费|廉|岑|薛|雷|贺|倪|汤|滕|殷|罗|毕|郝|邬|安|常|乐|于|时|傅|皮|卞|齐|康|伍|余|元|顾|孟|黄|和|穆|萧|尹|姚|邵|汪|祁|毛|禹|狄|米|贝|明|臧|计|伏|成|戴|宋|茅|庞|熊|纪|舒|屈|项|祝|董|梁|杜|阮|蓝|闵|席|季|麻|强|贾|路|娄|危|江|童|颜|郭|梅|盛|林|钟|徐|邱|骆|高|夏|蔡|田|樊|胡|凌|霍|虞|万|支|柯|管|卢|莫|房|裘|缪|干|解|应|宗|丁|宣|邓|郁|单|杭|洪|包|诸|左|石|崔|吉|龚|程|嵇|邢|裴|陆|荣|翁|荀|羊|甄|曲|封|储|靳|段|巫|乌|焦|巴|弓|牧|隗|山|谷|车|侯|宓|蓬|全|班|仰|秋|仲|伊|宫|宁|仇|栾|暴|甘|厉|戎|祖|武|符|刘|景|詹|束|龙|叶|幸|司|韶|黎|乔|苍|双|闻|莘|党|翟|谭|贡|劳|逄|姬|申|扶|堵|冉|宰|郦|雍|却|璩|桑|桂|濮|牛|寿|通|边|扈|燕|冀|浦|尚|农|温|别|庄|晏|柴|瞿|阎|连|习|艾|鱼|容|向|古|易|廖|终|步|都|耿|满|弘|匡|国|文|寇|广|禄|阙|东|欧|利|蔚|越|夔|隆|师|巩|厍|聂|晁|勾|敖|融|冷|訾|辛|阚|那|简|饶|空|曾|毋|沙|乜|养|鞠|须|丰|巢|关|蒯|相|查|后|荆|红|游|竺|权|逯|盖|益|桓|公)/;
/** 复姓：单字姓枚举覆盖不到，实测「欧阳明月，女，32岁」两侧都漏。 */
const CHINESE_COMPOUND_SURNAME = /(?:欧阳|司马|上官|夏侯|诸葛|东方|皇甫|尉迟|公羊|澹台|公冶|宗政|濮阳|淳于|单于|太叔|申屠|公孙|仲孙|轩辕|令狐|钟离|宇文|长孙|慕容|司徒|司空|鲜于|闾丘|子车|亓官|司寇|巫马|公西|颛孙|壤驷|公良|漆雕|乐正|拓跋|夹谷|完颜|赫连|端木|万俟|南宫)/;

/**
 * 主语前缀 + 姓名（「本例赵敏既往有高血压」）。与抬头姓名同一修法：**姓氏枚举 ∩ 上下文**。
 *
 * 服务端原先那条只有「主语前缀 + 2-4 字 + 叙述线索」，没有姓氏正向判定，
 * 实测在**送模型路径**上吃掉临床文本（2026-08-17）：
 *   「本例患儿出现发热」   → 「本例[已脱敏]出现发热」   ← 儿科信号没了
 *   「该患者既往有糖尿病」 → 「该患者[已脱敏]有糖尿病」 ← 「既往」被吃，既往史变成现症
 *   「病人自诉头痛3天」    → 「病人[已脱敏]头痛3天」
 * 「既往」被吃会把 historical 读成 positive——本系统整套临床状态词汇就建立在这个区分上
 * （clinical-state.ts 的 positive/possible/negative/historical/unknown）。
 * 加姓氏判定是**严格改进**：上面四条误伤全部消失，而既有的「本例于夜间发热」这类
 * （于本身是百家姓）在加判定前后同样会误报，不因此变差。
 * 取舍与抬头姓名一致：罕见非百家姓姓氏会漏——显式 patientName 替换与准标识符层仍在其后兜底。
 *
 * 浏览器侧原本**完全没有这条规则**（localStorage 里「本例赵敏」原样留存）。
 * 收敛成共享导出后两侧共用，不再各写各的。
 */
const SUBJECT_PREFIXED_NAME = new RegExp(
  `(本例|该患者|病例|病人|患儿)\\s*(?:${CHINESE_COMPOUND_SURNAME.source}|${CHINESE_SURNAME.source})`
  + "[\\u4e00-\\u9fa5]{1,2}?"
  + "(?=(?:既往|曾经|曾有|近|昨|今|因|诉|称|反映|表示|出现|发生|患|有|于|睡|入睡|失眠|头痛|头晕|胸痛|腹痛|发热|咳嗽|心悸|就诊|来诊|男|女|\\d{1,3}\\s*岁))",
  "g",
);

export function scrubSubjectPrefixedName(text: string, marker = "[姓名已脱敏]"): string {
  return String(text || "").replace(SUBJECT_PREFIXED_NAME, `$1${marker}`);
}

/**
 * 关系前缀 + 姓名（「家属王强代述病情」「监护人张伟签字」）。同样是姓氏枚举 ∩ 上下文。
 *
 * 原服务端那条只有「关系前缀 + 2-4 字 + 叙述动词/标点」，**两个方向都错**（2026-08-17 实测）：
 *   误吃向：「患者自诉头痛，家属补充夜间加重」→「患者[已脱敏]，…」——主诉整段没了；
 *           「家属代述，患者昨夜失眠」→「家属[已脱敏]，…」
 *   漏检向：「家属王强代述病情」「监护人张伟签字」原样留存——动词表里没有「代述」「签字」。
 * 加姓氏判定同时解决两头：自/代/补 不是姓氏所以不再误吃，王/张 是姓氏所以不再漏。
 * 有了姓氏这道正向判定，动词表才可以安全扩充——扩之前它是唯一的精度来源，扩一个词就多一分误吃。
 */
const RELATION_PREFIXED_NAME = new RegExp(
  "(患者|家属|联系人|陪同者|监护人|医生|医师)\\s*[:：]?\\s*"
  + `(?:${CHINESE_COMPOUND_SURNAME.source}|${CHINESE_SURNAME.source})`
  + "[\\u4e00-\\u9fa5]{1,2}"
  + "(?=[，,；。\\s]|男|女|\\d{1,3}\\s*岁|反映|诉|称|表示|告知|建议|记录|代述|转述|追述|复述|补充|陪同|签字|提供|同意|拒绝)",
  "g",
);

export function scrubRelationPrefixedName(text: string, marker = "[姓名已脱敏]"): string {
  return String(text || "").replace(RELATION_PREFIXED_NAME, `$1${marker}`);
}

/**
 * 中点姓名：外籍译名与维吾尔/藏/蒙等少数民族姓名的标准写法（麦克·约翰逊、阿依古丽·买买提）。
 * 百家姓枚举对它们**结构上无效**——「麦克」「阿依古丽」不是汉姓，下面那条正向判定一个都认不出，
 * 实测两侧（服务端 scrubPhi 与浏览器 scrubPersistentPhiText）**都留存**。
 * 这里改用中点本身作正向判据。中点在本领域确实高频，但用途是书名与朝代作者引注
 * （《证治准绳·类方》、清·汪讱庵）与目录点线，**从不出现在「抬头 + 性别/年龄」位置**：
 * 本条正则对仓内全部 74 个数据文件（含 8 万余处中点）实测命中 0 处误报。
 * 上下文闸与汉名那条完全一致，不放宽。
 */
const DOTTED_HEADER_NAME =
  /^([一-龥]{1,8}[·•‧・][一-龥·•‧・]{1,16})(?=[，,；。\s]*(?:男|女|\d{1,3}\s*岁))/;

export function scrubRecordHeaderName(text: string, marker = "[姓名已脱敏]"): string {
  const source = String(text || "");
  const dotted = source.match(DOTTED_HEADER_NAME);
  if (dotted) return source.replace(dotted[0], marker);
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
