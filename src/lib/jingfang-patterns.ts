import patternsJson from "../data/tcm-jingfang-patterns.json" with { type: "json" };

/**
 * 经方方证表的运行时读取（2026-10-19，第八轮 WP-A）。
 *
 * 为什么要它：X 集（考试题式病例）中医诊断不合格 33/110，其中 17 例的标准答案是《伤寒论》《金匮要略》方证
 * （桂枝汤证、吴茱萸汤证、大陷胸汤证、苓桂术甘汤证…）。系统的 M03 只把内科、妇科等教材的「病—证—法—方」行
 * 当候选，教材里没有对应行时模型就近套一个错的行。方证辨证是仲景的「方证系统」，与病证系统相交而不等同
 *（现代中医临床 2026;33(4)）。
 *
 * 数据：src/data/tcm-jingfang-patterns.json，由 scripts/build-jingfang-patterns.mjs 从受治理的
 * tcm-jingfang-patterns.source.json 生成并逐条校验（条文逐字出自本地《伤寒论》《金匮要略方论》原文并带行号，
 * 主症逐字出自条文，证名来自 GB/T 16751.2 / 《方剂学》主治 / 《伤寒论选读》）。
 *
 * 本模块只做读取、提示词渲染与锚定判断，不产生任何诊断；选方证由 jingfang-pattern-pick.server.ts 的闭集小任务完成。
 */

export interface JingfangClause { book: string; line: number; text: string }
export interface JingfangPattern {
  id: string;
  formula: string;
  patternName: string;
  aliases?: string[];
  syndromeName: string;
  syndromeSource: string;
  /** 条文主症 + 教材主症（《伤寒论选读》主症行），都是可对病历的症状短语。 */
  symptoms: string[];
  /** 至少要对上几个不同的症状才算（默认 2；只有一个特异症状的方证为 1）。 */
  minQuotes: 1 | 2;
  clauses: JingfangClause[];
  differentiation: { vs: string; text: string };
  catalog: { status: "ok" | "missing"; sourceNote?: string };
  catalogMissing?: boolean;
}

/** approximate：核对只判到「近似」（程度、颜色、部位或说法有出入），不是同一说法；提示词里标出，让 M03 不把它当逐字吻合。 */
export interface JingfangEvidence { symptom: string; quote: string; approximate?: boolean }
/** 闭集小任务通过校验的结果：方证 + 病历里逐字可见的证据。 */
export interface JingfangPick { patternName: string; evidence: JingfangEvidence[] }

const DATA = patternsJson as unknown as { genericSymptoms: string[]; patterns: JingfangPattern[] };
export const JINGFANG_PATTERNS: readonly JingfangPattern[] = DATA.patterns;
/** 泛化症状（单独出现时不足以支持方证）：判定时证据里至少要有一个不在这张表里的症状。数据在 source.json 的 genericSymptoms。 */
export const JINGFANG_GENERIC_SYMPTOMS: ReadonlySet<string> = new Set(DATA.genericSymptoms);

const BY_NAME = new Map<string, JingfangPattern>();
for (const pattern of JINGFANG_PATTERNS) {
  for (const name of [pattern.patternName, ...(pattern.aliases || [])]) BY_NAME.set(name, pattern);
}

export function jingfangPatternByName(name: string): JingfangPattern | undefined {
  return BY_NAME.get(String(name || "").trim());
}

/** 方名比较：去空白与「加减/化裁」尾巴。 */
function formulaIdentity(value: string): string {
  return String(value || "").replace(/\s+/gu, "").replace(/(?:加减|化裁)$/u, "");
}

/** 方向文字里是否写到了该经方（含「X加减」「X合Y加减」「X或Y」）。 */
export function jingfangFormulaMentioned(direction: string, formula: string): boolean {
  const text = String(direction || "").replace(/\s+/gu, "");
  return text.length > 0 && text.includes(formulaIdentity(formula));
}

/**
 * 已签名的证名与方向正是经方方证表里的一项：证名 = 该方证的规范证名（或方证名），且方向里写到了该经方。
 * 同一规范证名可对应几个方证（太阳伤寒证：麻黄汤证、葛根汤证），由方向里写到的经方定。
 * 锚定（tcm-formula-provenance）据此不把这样的证名改回「最近的教材行」，也不覆盖治法与方向。
 */
export function jingfangPatternForSignedSyndrome(syndromeName: string, direction: string): JingfangPattern | undefined {
  const syndrome = String(syndromeName || "").replace(/\s+/gu, "");
  if (!syndrome || !direction) return undefined;
  return JINGFANG_PATTERNS.find((pattern) =>
    (syndrome === pattern.syndromeName || syndrome === pattern.patternName || (pattern.aliases || []).includes(syndrome))
    && jingfangFormulaMentioned(direction, pattern.formula));
}

/**
 * 经方方证与教材行一样，是「证名—方」的正向依据（对应 textbookRelationFormulaIdentityNames）：已定证名与方向正是方证表里的一项时，
 * 该经方可以承接，不必再经受控关系表或功效词对齐来证明它对证。没有这条，经方的功效词与模型写的治法一旦对不上词，
 * 方就被判「缺少正向充分性」，开方阶段整方退成非剂量页。
 */
export function jingfangRelationFormulaIdentityNames(reasoning: unknown, names: readonly string[]): Set<string> {
  const overview = (reasoning as { overview?: { primarySyndrome?: unknown; primarySyndromeResolution?: unknown; recommendedFormulaDirection?: unknown } } | null | undefined)?.overview;
  if (names.length === 0 || typeof overview?.primarySyndrome !== "string" || overview.primarySyndromeResolution === "unresolved") return new Set();
  const pattern = jingfangPatternForSignedSyndrome(overview.primarySyndrome, typeof overview.recommendedFormulaDirection === "string" ? overview.recommendedFormulaDirection : "");
  if (!pattern) return new Set();
  const wanted = formulaIdentity(pattern.formula);
  return new Set(names.map(formulaIdentity).filter((identity) => identity === wanted));
}

/**
 * 症状的特异度 = 1 / 含有它（或被它包含）的症状所在的方证数。「汗出」「发热」「恶寒」在二十多个方证里都有，特异度很低；
 * 「鼻鸣」「里急后重」「喜悲伤欲哭」只在一两个方证里。方证成立的证据按特异度求和（pickJingfangEvidenceSufficient），
 * 比一张手写的泛症表更不容易被「几个人人都有的症状」凑出来。
 */
const SPECIFICITY_CACHE = new Map<string, number>();
/** 方证的症状清单里是否有一条与该症状同一个（相等，或一方是另一方的子串且长度≥2）。特异度与「谁能覆盖这组症状」共用。 */
function patternHasSymptom(pattern: JingfangPattern, symptom: string): boolean {
  return pattern.symptoms.some((other) => other === symptom || (other.length >= 2 && (other.includes(symptom) || symptom.includes(other))));
}
export function jingfangSymptomSpecificity(symptom: string): number {
  const cached = SPECIFICITY_CACHE.get(symptom);
  if (cached !== undefined) return cached;
  const patternsWith = JINGFANG_PATTERNS.filter((pattern) => patternHasSymptom(pattern, symptom)).length;
  const value = 1 / Math.max(1, patternsWith);
  SPECIFICITY_CACHE.set(symptom, value);
  return value;
}

/** 表里是否有以该前缀起头的症状（不大便、不欲饮水、不得眠…这类以否定字起头的症状本身）。供引文否定判断用表自己当词表。 */
export function jingfangSymptomStartsWith(prefix: string): boolean {
  return prefix.length > 0 && JINGFANG_PATTERNS.some((pattern) => pattern.symptoms.some((symptom) => symptom.startsWith(prefix)));
}

/**
 * 同一条文里的互证（2026-10-19，第九轮 WP9-A）：已确认的症状里，逐字出现在同一条《伤寒论》《金匮要略》条文中的最多有几个。
 * 条文把一组症状写在一起，病历同时对上同一条文里的两个以上主症，就是「条文级」吻合——桂枝汤证的「汗出、发热」，
 * 桂枝去芍药汤证的「脉促、胸满」，大陷胸汤证的「不大便、从心下至少腹硬满而痛不可近」，这些症状在整张表里各出现在许多方证里，
 * 单个特异度很低（特异度之和凑不到下限），但它们合在一起正是那一条的原文。为什么不降特异度下限：下限降低会让
 * 任何「几个常见症状」都放行；条文内互证只认同一条文里的症状组，不同条文里各拿一个常见症状（真武汤证的头眩与自下利）不算。
 * 返回 { count, symptoms }：count 为同一条文内最多的已确认症状数，symptoms 为这一组。纯函数。
 */
export function jingfangClauseCooccurrence(pattern: JingfangPattern, verifiedSymptoms: readonly string[]): { count: number; symptoms: string[] } {
  const normalize = (text: string) => String(text || "").replace(/[\s，。、；：:;,.！!？?（）()“”"'《》　]+/gu, "");
  let best: string[] = [];
  for (const clause of pattern.clauses) {
    const text = normalize(clause.text);
    const inside = [...new Set(verifiedSymptoms)].filter((symptom) => symptom && text.includes(normalize(symptom)));
    if (inside.length > best.length) best = inside;
  }
  return { count: best.length, symptoms: best };
}

/**
 * 表里能同时覆盖这组症状的方证名（第九轮）。单个症状的特异度只说「这个症状在几个方证里出现」，而一组症状合在一起往往只有
 * 一个方证能全部覆盖（汗出+发热+脉浮缓只有桂枝汤证，脉促+胸满只有桂枝去芍药汤证）；恶寒+无汗+脉浮紧则麻黄汤证、葛根汤证、
 * 大青龙汤证都能覆盖——这组证据分不出是哪一个，不能据此把其中一个推给 M03。纯函数。
 */
export function jingfangPatternsCovering(symptoms: readonly string[]): string[] {
  const wanted = [...new Set(symptoms.filter(Boolean))];
  if (wanted.length === 0) return [];
  return JINGFANG_PATTERNS.filter((pattern) => wanted.every((symptom) => patternHasSymptom(pattern, symptom))).map((pattern) => pattern.patternName);
}

/** 证据特异度之和的下限：本机 20 例口语化方证病历 + 甲方 10 例 + 留出 32 例的校准值（见 test-r1020-jingfang 与回复里的数字）。 */
export const JINGFANG_MIN_SPECIFICITY = 1.0;

/** 供闭集小任务使用的清单：方证名 + 可对病历的症状短语。 */
export function jingfangClosedSetForPick(): Array<{ pattern: string; symptoms: string[] }> {
  return JINGFANG_PATTERNS.map((pattern) => ({ pattern: pattern.patternName, symptoms: pattern.symptoms }));
}

function cut(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * M03 中医半提示词里的「经方方证候选」段。没有通过校验的方证时返回空串（提示词与此前逐字相同）。
 * 规则写在段内而不是固定前缀里：没有选出方证的病例（绝大多数）不增加任何提示词。
 */
export function buildJingfangCandidateContext(picks: readonly JingfangPick[] | undefined, lineagePreference?: string): string {
  const entries = (picks || []).flatMap((pick) => {
    const pattern = jingfangPatternByName(pick.patternName);
    return pattern ? [{ pattern, pick }] : [];
  });
  if (entries.length === 0) return "";
  const lines = entries.flatMap(({ pattern, pick }) => [
    `◆ ${pattern.patternName}｜规范证名：${pattern.syndromeName}｜经方：${pattern.formula}`,
    `  - 病历已见（与方证主症相合）：${pick.evidence.map((item) => `病历「${item.quote}」${item.approximate ? "近似" : "≈"}${item.symptom}`).join("；")}`,
    `  - 方证主症：${pattern.symptoms.slice(0, 12).join("、")}`,
    ...pattern.clauses.slice(0, 2).map((clause) => `  - 原文（《${clause.book}》）：${cut(clause.text, 110)}`),
    `  - 与相近方证的区分：${pattern.differentiation.text}`,
  ]);
  return [
    "【经方方证候选】（以下方证的原文主症在病历里逐字可见。方证辨证出自《伤寒论》《金匮要略》，与上方教材「病—证—法—方」对照是两套并行的辨证体系，相交而不等同；条文为本地古籍电子版原文，个别字有缺漏。）",
    ...lines,
    ...(lineagePreference === "classical-formula"
      ? [
          // 医生选了经方思路（2026-10-24 第十八轮）：甲方要看「不同诊疗思路是否改变分析重点」，经方思路的分析重点就是方证相应；
          // 此前这里与不限定流派同一条「教材行优先」规则，选了经方思路的感冒、心悸照样落在教材的时方上。
          "医生选定了经方思路：下面第 2 条的逐项比较改为——「病历已见」里有条文特征症（第 1 条）、且病历与方证的区分点不相反（第 4 条）时，采用方证，不再因为教材行也能解释而改用教材行；教材代表方可在辨证依据里作对照。只有泛化症状时仍不采用。",
        ]
      : []),
    "采用规则（只在上面列出了方证时适用，是对重要原则第 7 条“有贴合行就用教材行”的补充）：",
    "1. 先分清「病历已见」里的两类表现。条文特征症：「方证主症」里别的方证少见、能把该方证与相近方证分开的表现（如颠顶痛、干呕吐涎沫、心中懊憹、气上冲、脐下悸、脉促胸满、汗出恶风脉浮缓、心下痛按之石硬）。泛化症状：发热、恶寒、头痛、咳嗽、口渴、腹痛、心烦、脉数这类很多证型共有的表现。「病历已见」里只有泛化症状时，不采用本段。",
    "2. 再逐项对教材行，不要因为教材行“大致贴合”就放弃方证。取【教材病证候选】里与本例最近的一行，看那些条文特征症是否已写在这一行的主症里：",
    "  ① 教材里没有贴合本例的行，或这一行的主症里一项条文特征症都没有（只有方证能解释它们）→ 采用方证；",
    "  ② 教材行的主症已经写全这些条文特征症（教材行同样能解释）→ 采用教材行，不采用本段（普通病例按教材写）；",
    "  ③ 教材行只解释了其中一部分、另有条文特征症教材行解释不了时：看教材行里能把它与同病其他证型分开的表现（寒热、虚实、诱因、伴随症状、舌脉），病历里齐全 → 采用教材行；缺其中一项以上 → 采用方证。",
    "3. 采用方证时：overview.primarySyndrome 逐字写该方证的“规范证名”，治法按该经方的功用写（解肌、和解、攻下、温阳、利水这一类），overview.recommendedFormulaDirection 写该经方（如“桂枝汤加减”）；overview.tcmDiseaseName 仍写病历主诉对应的规范中医病名，不写“某某汤证”；tcmDiagnosticRationale 要引用病历里对应的原话、写出“符合某某汤证”，并说明为什么取方证而不取教材行。",
    "4. 病历与方证的区分点相反（如病历有汗而方证为无汗、口渴而方证为不渴）时，或“病历已见”里标“近似”的表现多于逐字吻合的而又没有条文特征症时，不采用本段。",
  ].join("\n");
}
