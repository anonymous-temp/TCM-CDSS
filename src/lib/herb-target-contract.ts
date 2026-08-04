export const FORMULA_STRUCTURE_TARGETS = {
  middle_jiao_support: "顾护中焦，防补药滋腻",
  harmonize: "调和诸药，协调药性",
  guide: "引经载药，调和诸药",
  temper: "制约峻烈，缓和药性",
} as const;

export type FormulaStructureRole = keyof typeof FORMULA_STRUCTURE_TARGETS;

export function normalizeFormulaStructureRole(value: unknown): FormulaStructureRole | undefined {
  if (typeof value !== "string") return undefined;
  if (value in FORMULA_STRUCTURE_TARGETS) return value as FormulaStructureRole;
  const compact = value.toLowerCase().replace(/[\s_-]/g, "");
  const aliases: Array<[RegExp, FormulaStructureRole]> = [
    [/(?:middlejiaosupport|中焦支持|健脾和中|顾护中焦|顾护脾胃|防滋腻)/, "middle_jiao_support"],
    [/(?:harmonize|调和诸药|调和药性|调和|协同|协调|相辅|增效|协调药势)/, "harmonize"],
    [/(?:guide|引经|引药|导药|载药)/, "guide"],
    [/(?:temper|缓和|制约|减毒|反佐|纠偏|制偏)/, "temper"],
  ];
  return aliases.find(([pattern]) => pattern.test(compact))?.[1];
}

export function formulaStructureTarget(value: unknown): string | undefined {
  const role = normalizeFormulaStructureRole(value);
  return role ? FORMULA_STRUCTURE_TARGETS[role] : undefined;
}

/**
 * 逐味方义生成（需求7：「方义分析写得过于笼统，要写清楚药是在这个方子里干了啥起了啥作用」）。
 *
 * 原实现按**角色分组**成句，且每个角色配一句固定模板：
 *   「君药以党参（补脾益气）为组，对应脾胃虚弱，直治核心病机，构成本方主要治疗支点。」
 * 三个问题叠加导致「笼统」：
 *   1) 分组之后看不出组内每味药各自干什么——「臣药以白术、茯苓为组」读不出茯苓的独立作用；
 *   2) 「直治核心病机，构成本方主要治疗支点」这句话对**每一张方**的君药都完全相同，不携带本例信息；
 *   3) 结尾固定附一句「各药组共同形成……治疗层次」，不含任何可核对内容。
 *
 * 改为逐味成句，每句只由本例数据构成：该药的**自身功用** + 它**实际承接的病机原文** + 角色关系。
 * 同一病机上的两味药因功用不同而自然写出不同的句子，这正是医生按方义读方时需要的粒度。
 * 服务端与药味工作台编辑后共用本函数，避免两条路径给出不同口径的方义。
 */
export type FormulaAnalysisHerb = {
  name?: unknown;
  role?: unknown;
  function?: unknown;
  targetPathogenesis?: unknown;
};

const ANALYSIS_ROLE_ORDER = ["君", "臣", "佐", "使"] as const;

function analysisText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").replace(/[；;。、,，]+$/g, "").trim() : "";
}

function roleClause(role: string, target: string, sharesEmperorTarget: boolean): string {
  // 甲方评测(2026-08-04) 第 2 条「方义解析仍然冗长」：每句尾巴上的固定模板是主要冗余源。
  // 「，是本方的治疗支点」「，加强该方向的力量」对每一张方都逐字相同，不携带本例信息；
  // 角色本身已经写在药名后的括号里（君/臣/佐/使），再用一句话复述角色定义就是纯噪音。
  // 保留的只有**本例特有**的部分：该药实际承接的那段病机原文。
  if (role === "君") return target ? `直接承接核心病机「${target}」，为本方治疗支点` : "承担本方的核心治疗作用";
  if (role === "臣") {
    if (!target) return "协同君药、加强主治方向";
    return sharesEmperorTarget ? `协同君药同治「${target}」` : `承接次级病机「${target}」`;
  }
  if (role === "佐") return target ? `兼顾「${target}」` : "兼顾兼夹病机或制约峻烈";
  if (role === "使") return target ? `承担「${target}」的方内结构作用` : "协调方中药性、衔接各治疗方向";
  return target ? `对应「${target}」` : "参与本方配伍";
}

/** 同一病机上的后续药味只写关系，不重复病机原文。分组排序保证「上述」永远指向紧邻的上一组。 */
function repeatTargetClause(role: string, sharesEmperorTarget: boolean): string {
  if (role === "君") return "同承接上述核心病机，为本方治疗支点";
  if (role === "臣") return sharesEmperorTarget ? "协同君药同治上述病机" : "同承接上述病机";
  if (role === "佐") return "兼顾上述病机";
  if (role === "使") return "承担上述方内结构作用";
  return "同承接上述病机";
}

/**
 * 甲方评测(2026-08-03) 7.1/7.2 的三类呈现根修：
 *  · 功用文本剥掉「；清热药；清热凉血药」这类**药类归类尾巴**并限长——归类是检索索引，
 *    不是医生要读的方义；
 *  · 治法方向串剥掉受控词表的「…的」后缀与分号连接（「发散风寒的;解表的」→「发散风寒、解表」）；
 *  · 同一病机原文不再逐味整句重复：首次出现全文引用，其后各味写「同承接上述…病机」；
 *  · 行间用 Markdown 列表（`- `）+ 空行，正文不再塌成一整段。
 */
/**
 * 功用文本的**长度与信息密度**治理（第 2 条「冗长」的另一半）。
 *
 * 三处收紧，都是「删无信息量的字」而不是截断临床内容：
 *  1. 药类归类尾巴（「补气药」「利水消肿药」）是检索索引，不是方义。原实现只在**还有别的段落**
 *     时才剥掉它；只有归类可用时会回落成 `以「补虚药」`，医生页面上就出现纯索引词。改为归类
 *     整体不可用时返回空串，由调用方省略整个「以「…」」从句。
 *  2. 条目上限 3→2。实测功用串第三项多为前两项的近义改写（「养阴清热，清热养阴，清热泻火」）。
 *  3. 去掉互为子串的近义项，避免同一句里把同一个功效说两遍。
 */
function cleanHerbFunctionText(value: string): string {
  const segments = value.split(/[；;]/).map((segment) => segment.trim()).filter(Boolean);
  const functional = segments.filter((segment) => !/^[一-龥]{1,8}药$/.test(segment));
  if (functional.length === 0) return "";
  const core = functional[0].split(/[，,]/).map((item) => item.trim()).filter(Boolean);
  const distinct: string[] = [];
  for (const item of core) {
    // 子串近义（「清热」⊂「清热凉血」）与**同字异序**近义（「养阴清热」/「清热养阴」）都算重复。
    // 中药功用术语是四字定式，异序同义极常见，只按子串判会漏掉一半。
    if (distinct.some((kept) => kept.includes(item) || item.includes(kept) || sameCharacterSet(kept, item))) continue;
    distinct.push(item);
    if (distinct.length === 2) break;
  }
  return distinct.join("，");
}

function sameCharacterSet(left: string, right: string): boolean {
  if (left.length !== right.length || left.length < 2) return false;
  return [...left].sort().join("") === [...right].sort().join("");
}

/**
 * 方义里引用的病机原文长度治理。
 *
 * M03 的 `pathogenesis` 字段常把病机与其症状表现写在一句里（「…气机郁滞，胃失和降，故胃脘胀痛；
 * 气滞不畅则胸闷、善叹息；…」）。方义解析要说明的是**这味药承接哪条病机**，症状复述已在病机
 * 推理区完整呈现过——照抄进来既冗长又与上文重复（第 2、3 条同时命中）。
 * 因此只保留「故/则」引导的症状复述之前的病机主干，并在句读边界上收敛到长度预算内。
 * 这是**按结构取主干**，不是按字数硬截断：不会在词中间断开，也不会丢掉整条病机。
 */
const TARGET_QUOTE_MAX_CHARS = 40;

function cleanTargetQuoteText(value: string): string {
  if (!value) return "";
  // 1. 去掉「故…」「则…」引导的症状复述分句。
  const clauses = value.split(/[；;]/).map((clause) => clause.trim()).filter(Boolean);
  const mechanismClauses = clauses.filter((clause) => !/^(?:故|则|以致|遂)/.test(clause));
  const trunk = (mechanismClauses[0] || clauses[0] || value).replace(/[，,]?\s*(?:故|则)[^，,]*$/, "").trim();
  if (trunk.length <= TARGET_QUOTE_MAX_CHARS) return trunk;
  // 2. 仍超预算时按逗号边界收敛，至少保留第一个分句。
  const parts = trunk.split(/[，,]/).map((part) => part.trim()).filter(Boolean);
  const kept: string[] = [];
  for (const part of parts) {
    if (kept.length > 0 && [...kept, part].join("，").length > TARGET_QUOTE_MAX_CHARS) break;
    kept.push(part);
  }
  return kept.join("，");
}

function cleanTherapyMatchText(value: string): string {
  const parts = value
    .split(/[；;、，,]/)
    .map((part) => part.trim().replace(/的$/, ""))
    .filter(Boolean);
  return [...new Set(parts)].join("、");
}

/**
 * 方义解析的长度预算（甲方评测 2026-08-04 第 2 条「方义解析仍然冗长」的可断言上界）。
 *
 * 逐味成句是甲方上一轮明确要求的粒度（「要写清楚药是在这个方子里干了啥起了啥作用」），
 * 所以预算必须随药味数线性放宽，不能设一个与方剂规模无关的常数。构成：
 *   · 头部一行 ≤ 80 字：`本方共N味，围绕「总治法」分层组方：` ＋ Markdown 空行；
 *   · 每味一行 ≤ 56 字：药名 ≤6 ＋ 角色括号 3 ＋「功用」≤15（2 条 × ≤6 字＋分隔＋引号）
 *     ＋ 关系从句 ≤32（病机短引用 ≤ TARGET_QUOTE_MAX_CHARS=40 的分句收敛结果＋固定模板 ≤12）。
 *
 * 实测校准：对 artifacts/ 下 909 份带方义解析的归档 M04 产出，用当前实现重算得均值 350 字、
 * 最长 547 字（15 味方），无一例越过本预算；归档里的根修前原文均值 487 字、最长 1002 字。
 * 预算不做运行时截断——它是渲染层测试（scripts/test-visible-output-hygiene.mjs）的断言，
 * 越界即说明有人又往每行加了不携带本例信息的模板句。
 */
/**
 * 药味表「对应病机」列的去重呈现（甲方评测 2026-08-04 第 3 条「病机内容重复」的**最大单一来源**）。
 *
 * 这一处是渲染层测试发现的：既有的病机去重账本只覆盖病机推理区与分治方向表，而药味表的
 * 「对应病机」列是**逐味**印一遍。实测 fixture：15 味方里同一句 20–30 字的病机在药味表里
 * 连印 15 遍，加上方义解析与分治方向表，同一句病机在一页里出现 19 次。lib 层测试全绿——
 * 因为没有任何函数「返回」这张表，它是在 JSX 与 Markdown 模板里逐行拼出来的。
 *
 * 规则：**每段病机原文在本表内只写一次**，重复行改写成指向首次出现的引用。
 *  · 全表只有一条病机时不编号，重复行写「同上」；
 *  · 有多条时按首次出现顺序编号（①②③…），重复行写「同①」——非相邻重复也不会指错。
 * 信息量不减：每一行仍然能读出这味药承接哪条病机。
 */
const CIRCLED_MARKERS = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳";

export function formulaTargetPathogenesisCells(targets: readonly unknown[]): string[] {
  const values = targets.map((item) => analysisText(item));
  const distinct: string[] = [];
  for (const value of values) {
    if (value && !distinct.includes(value)) distinct.push(value);
  }
  const unnumbered = distinct.length <= 1;
  const marker = (value: string): string => {
    const index = distinct.indexOf(value);
    return CIRCLED_MARKERS[index] || `病机${index + 1}`;
  };
  const shown = new Set<string>();
  return values.map((value) => {
    if (!value) return "";
    if (!shown.has(value)) {
      shown.add(value);
      return unnumbered ? value : `${marker(value)} ${value}`;
    }
    return unnumbered ? "同上" : `同${marker(value)}`;
  });
}

export function formulaAnalysisCharBudget(herbCount: number): number {
  return 80 + 56 * Math.max(0, herbCount);
}

/** 返回逐味方义段落；herbs 为空时返回空串（调用方自行决定占位文案）。 */
export function buildFormulaAnalysis(herbs: readonly FormulaAnalysisHerb[], therapyMatch = ""): string {
  const rows = herbs
    .map((herb) => ({
      name: analysisText(herb.name),
      role: analysisText(herb.role),
      fn: cleanHerbFunctionText(analysisText(herb.function)),
      // target 用于**分组与去重判等**（保持原文，两条不同病机不会因取主干而误并成一组）；
      // quote 是实际印在方义里的短引用。
      target: analysisText(herb.targetPathogenesis),
      quote: cleanTargetQuoteText(analysisText(herb.targetPathogenesis)),
    }))
    .filter((row) => row.name);
  if (rows.length === 0) return "";
  const emperorTargets = new Set(rows.filter((row) => row.role === "君" && row.target).map((row) => row.target));
  const roleRank = (role: string): number => {
    const index = ANALYSIS_ROLE_ORDER.indexOf(role as typeof ANALYSIS_ROLE_ORDER[number]);
    return index < 0 ? ANALYSIS_ROLE_ORDER.length : index;
  };
  // 先按「病机分组」再按君臣佐使排序（第 2/3 条根修）。
  //
  // 原实现只按角色排序，同一病机的药味被其他病机的药味隔开，后续药味只能写成
  // 「同承接上述病机（同熟地黄）」——必须带一个回指药名才不歧义，于是每行多背 6 个字，
  // 实测 15 味方里这句重复 8 次。按病机分组后「上述」永远指紧邻的上一组，回指药名可以整体删掉。
  // 组内仍按君臣佐使排列，君药所在的组自然排在最前（roleRank 最小），临床阅读顺序不变。
  const groupOrder: string[] = [];
  for (const row of [...rows].sort((left, right) => roleRank(left.role) - roleRank(right.role))) {
    if (row.target && !groupOrder.includes(row.target)) groupOrder.push(row.target);
  }
  const groupRank = (target: string): number => {
    const index = groupOrder.indexOf(target);
    return index < 0 ? groupOrder.length : index;
  };
  const ordered = [...rows].sort((left, right) =>
    groupRank(left.target) - groupRank(right.target) || roleRank(left.role) - roleRank(right.role));
  const quotedTargets = new Set<string>();
  const lines = ordered.map((row) => {
    const sharesEmperorTarget = row.role === "臣" && emperorTargets.has(row.target);
    const alreadyQuoted = Boolean(row.target) && quotedTargets.has(row.target);
    if (row.target) quotedTargets.add(row.target);
    const clause = alreadyQuoted
      ? repeatTargetClause(row.role, sharesEmperorTarget)
      : roleClause(row.role, row.quote, sharesEmperorTarget);
    const roleLabel = row.role ? `（${row.role}）` : "";
    return row.fn
      ? `- **${row.name}**${roleLabel}：以「${row.fn}」${clause}。`
      : `- **${row.name}**${roleLabel}：${clause}。`;
  });
  const cleanedTherapyMatch = cleanTherapyMatchText(analysisText(therapyMatch));
  const head = cleanedTherapyMatch
    ? `本方共${rows.length}味，围绕「${cleanedTherapyMatch}」分层组方：`
    : `本方共${rows.length}味，按已锁定病机与治法分层组方：`;
  return [head, "", ...lines].join("\n");
}
