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

/** 病机不可用（模型没给 targetPathogenesis）时的兜底关系句。有病机时一律走分组标题，不再逐味重复。 */
function untargetedRoleClause(role: string): string {
  if (role === "君") return "承担本方的核心治疗作用";
  if (role === "臣") return "协同君药、加强主治方向";
  if (role === "佐") return "兼顾兼夹病机或制约峻烈";
  if (role === "使") return "协调方中药性、衔接各治疗方向";
  return "参与本方配伍";
}

function structuralRoleClause(role: string, target: string): string {
  if (/(?:引经|载药)/.test(target)) return "引经载药，衔接全方";
  if (/(?:调和诸药|协调药性)/.test(target)) return "调和诸药，协调药性";
  if (/(?:制约峻烈|缓和药性|反佐|制偏)/.test(target)) return "制约偏性，缓和药性";
  if (/(?:顾护中焦|防补药滋腻)/.test(target)) return "顾护中焦，防补药滋腻";
  return untargetedRoleClause(role);
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
  const segments = value.split(/[；;]/).map((segment) => segment.trim()).filter(Boolean)
    .filter((segment) => !/(?:具体配伍作用|具体作用).*(?:结合方义|复核)|本方中的具体配伍作用/.test(segment));
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
  //
  // 逗号是必需的，不是可选的（甲方评测 2026-08-04 第 7.1 条「方解格式不正确」的实测残句）：
  // 原式 /[，,]?\s*(?:故|则)[^，,]*$/ 允许零逗号起头，于是「清窍失养，不荣则痛」里那个
  // **词内**的「则」也被当成分句引导词，砍出「清窍失养，不荣」这种半句话印在医生页面上。
  // 「不荣则痛」「不通则痛」是病机定式，「则」在词中；真正的症状复述一定挂在逗号之后
  // （「…胃失和降，故胃脘胀痛」）。要求逗号在场即可精确区分这两种形态。
  const clauses = value.split(/[；;]/).map((clause) => clause.trim()).filter(Boolean);
  const mechanismClauses = clauses.filter((clause) => !/^(?:故|则|以致|遂)/.test(clause));
  const trunk = (mechanismClauses[0] || clauses[0] || value).replace(/[，,]\s*(?:故|则)[^，,]*$/, "").trim();
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
  // 连续方解仍按药味数线性给预算：每味只保留 1–2 项与本方有关的作用，
  // 君臣佐使按角色合句，实际命中的药对关系只补一遍。
  return 80 + 40 * Math.max(0, herbCount);
}

/**
 * 返回医生可读的连续方解；herbs 为空时返回空串。
 * 甲方 2026-08-05 第 7.1 条要求分析药物在本方中的作用，而不是罗列全部功效，
 * 并给出了麻黄汤连续自然段示例。因此这里不再生成 Markdown 病机标题或逐味列表。
 */
export function buildFormulaAnalysis(herbs: readonly FormulaAnalysisHerb[], therapyMatch = ""): string {
  const rows = herbs
    .map((herb) => ({
      name: analysisText(herb.name),
      role: analysisText(herb.role),
      fn: cleanHerbFunctionText(analysisText(herb.function)),
      target: analysisText(herb.targetPathogenesis),
      quote: cleanTargetQuoteText(analysisText(herb.targetPathogenesis)),
    }))
    .filter((row) => row.name);
  if (rows.length === 0) return "";
  const roleRank = (role: string): number => {
    const index = ANALYSIS_ROLE_ORDER.indexOf(role as typeof ANALYSIS_ROLE_ORDER[number]);
    return index < 0 ? ANALYSIS_ROLE_ORDER.length : index;
  };
  const ordered = [...rows].sort((left, right) => roleRank(left.role) - roleRank(right.role));
  const roleRows = (role: string) => ordered.filter((row) => row.role === role);
  const shownTargets = new Set<string>();
  const targetText = (items: typeof ordered): string => {
    const fresh = [...new Set(items.map((row) => row.quote).filter(Boolean))]
      .filter((target) => !/(?:补益药滋腻|引经载药|调和诸药|协调药性|顾护中焦|制约峻烈)/.test(target))
      .filter((target) => !shownTargets.has(target))
      .slice(0, 2);
    fresh.forEach((target) => shownTargets.add(target));
    return fresh.join("，兼顾");
  };
  const roleTargetClause = (role: string, items: typeof ordered): string => {
    const target = targetText(items);
    if (!target) return "";
    if (role === "君") return `，直治${target}`;
    if (role === "臣") return `，助君药并兼治${target}`;
    if (role === "佐") return `，佐助主治并兼顾${target}`;
    if (role === "使") return "";
    return `，共同作用于${target}`;
  };
  const roleSentence = (role: string, items: typeof ordered, first: boolean): string => {
    if (items.length === 0) return "";
    const names = items.map((row) => row.name).join("、");
    const subject = first ? `方中${names}` : names;
    const rolePhrase = items.length === 1 ? `为${role}` : `共为${role}药`;
    const actions = items.map((row) => row.fn
      ? `${items.length === 1 ? "" : row.name}取其${row.fn}之长`
      : `${items.length === 1 ? "" : row.name}${structuralRoleClause(row.role, row.target)}`);
    const actionText = items.length === 1 ? actions[0] : `其中${actions.join("；")}`;
    return `${subject}${rolePhrase}，${actionText}${roleTargetClause(role, items)}。`;
  };
  const roleSentences: string[] = [];
  for (const role of ANALYSIS_ROLE_ORDER) {
    const sentence = roleSentence(role, roleRows(role), roleSentences.length === 0);
    if (sentence) roleSentences.push(sentence);
  }
  const unclassified = ordered.filter((row) => !ANALYSIS_ROLE_ORDER.includes(row.role as typeof ANALYSIS_ROLE_ORDER[number]));
  if (unclassified.length > 0) roleSentences.push(roleSentence("配伍药", unclassified, roleSentences.length === 0));

  const names = new Set(ordered.map((row) => row.name));
  const findName = (...candidates: string[]): string => candidates.find((name) => names.has(name)) || "";
  const pairSentences: string[] = [];
  const mahuang = findName("麻黄");
  const guizhi = findName("桂枝");
  const xingren = findName("苦杏仁", "杏仁");
  const gancao = findName("炙甘草", "甘草");
  if (mahuang && guizhi) pairSentences.push(`${mahuang}与${guizhi}相须为用，${guizhi}助${mahuang}解肌发表，以增强发汗散寒之力。`);
  if (mahuang && xingren) pairSentences.push(`${mahuang}与${xingren}相伍，一宣一降，以复肺气宣降。`);
  if (mahuang && guizhi && gancao) pairSentences.push(`${gancao}调和诸药，并缓和${mahuang}、${guizhi}发汗之峻，防止汗出太过。`);

  const renshen = findName("人参", "党参");
  const baizhu = findName("白术", "炒白术");
  const fuling = findName("茯苓");
  const sharen = findName("砂仁");
  const jiegeng = findName("桔梗");
  if (renshen && baizhu) pairSentences.push(`${renshen}与${baizhu}相伍，一补一健，共扶脾气以助运化。`);
  if (baizhu && fuling) pairSentences.push(`${baizhu}与${fuling}相伍，健脾与渗湿并举，使湿去而运化复。`);
  const tonics = ordered.filter((row) => /^(?:君|臣)$/.test(row.role) && /(?:补|滋|养|健脾|益气)/.test(row.fn));
  if (sharen && tonics.length > 0) {
    pairSentences.push(`${sharen}行气醒脾，既助中焦运化，又可防${tonics.slice(0, 2).map((row) => row.name).join("、")}等补益药滋腻碍胃。`);
  }
  if (jiegeng && baizhu && fuling) pairSentences.push(`${jiegeng}宣肺利气、载药上行，使脾气得健而肺气得宣。`);

  const cleanedTherapyMatch = cleanTherapyMatchText(analysisText(therapyMatch));
  const conclusion = cleanedTherapyMatch ? `诸药合用，共奏${cleanedTherapyMatch}之效。` : "";
  return [...roleSentences, ...pairSentences, conclusion].filter(Boolean).join("");
}
