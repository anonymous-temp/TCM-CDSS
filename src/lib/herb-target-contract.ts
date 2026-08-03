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
  if (role === "君") return target ? `直接承接核心病机「${target}」，是本方的治疗支点` : "承担本方的核心治疗作用";
  if (role === "臣") {
    if (!target) return "协同君药、加强主治方向";
    return sharesEmperorTarget ? `与君药同承接「${target}」，加强该方向的力量` : `承接次级病机「${target}」`;
  }
  if (role === "佐") return target ? `兼顾「${target}」` : "兼顾兼夹病机或制约峻烈";
  if (role === "使") return target ? `承担「${target}」的方内结构作用` : "协调方中药性、衔接各治疗方向";
  return target ? `对应「${target}」` : "参与本方配伍";
}

/**
 * 甲方评测(2026-08-03) 7.1/7.2 的三类呈现根修：
 *  · 功用文本剥掉「；清热药；清热凉血药」这类**药类归类尾巴**并限长——归类是检索索引，
 *    不是医生要读的方义；
 *  · 治法方向串剥掉受控词表的「…的」后缀与分号连接（「发散风寒的;解表的」→「发散风寒、解表」）；
 *  · 同一病机原文不再逐味整句重复：首次出现全文引用，其后各味写「同承接上述…病机」；
 *  · 行间用 Markdown 列表（`- `）+ 空行，正文不再塌成一整段。
 */
function cleanHerbFunctionText(value: string): string {
  const segments = value.split(/[；;]/).map((segment) => segment.trim()).filter(Boolean);
  const functional = segments.filter((segment) => !/^[一-龥]{1,8}药$/.test(segment));
  const core = (functional[0] || segments[0] || "").split(/[，,]/).map((item) => item.trim()).filter(Boolean);
  return core.slice(0, 3).join("，");
}

function cleanTherapyMatchText(value: string): string {
  const parts = value
    .split(/[；;、，,]/)
    .map((part) => part.trim().replace(/的$/, ""))
    .filter(Boolean);
  return [...new Set(parts)].join("、");
}

/** 返回逐味方义段落；herbs 为空时返回空串（调用方自行决定占位文案）。 */
export function buildFormulaAnalysis(herbs: readonly FormulaAnalysisHerb[], therapyMatch = ""): string {
  const rows = herbs
    .map((herb) => ({
      name: analysisText(herb.name),
      role: analysisText(herb.role),
      fn: cleanHerbFunctionText(analysisText(herb.function)),
      target: analysisText(herb.targetPathogenesis),
    }))
    .filter((row) => row.name);
  if (rows.length === 0) return "";
  const emperorTargets = new Set(rows.filter((row) => row.role === "君" && row.target).map((row) => row.target));
  const ordered = [...rows].sort((left, right) => {
    const leftIndex = ANALYSIS_ROLE_ORDER.indexOf(left.role as typeof ANALYSIS_ROLE_ORDER[number]);
    const rightIndex = ANALYSIS_ROLE_ORDER.indexOf(right.role as typeof ANALYSIS_ROLE_ORDER[number]);
    return (leftIndex < 0 ? ANALYSIS_ROLE_ORDER.length : leftIndex) - (rightIndex < 0 ? ANALYSIS_ROLE_ORDER.length : rightIndex);
  });
  const quotedTargets = new Map<string, string>();
  const lines = ordered.map((row) => {
    const firstQuoteHerb = row.target ? quotedTargets.get(row.target) : undefined;
    const displayTarget = row.target && !firstQuoteHerb ? row.target : "";
    if (row.target && !firstQuoteHerb) quotedTargets.set(row.target, row.name);
    const clause = displayTarget || !row.target
      ? roleClause(row.role, displayTarget, row.role === "臣" && emperorTargets.has(row.target))
      : row.role === "臣" && emperorTargets.has(row.target)
        ? `与君药同承接上述病机（同${firstQuoteHerb}），加强该方向的力量`
        : `同承接上述病机（同${firstQuoteHerb}）`;
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
