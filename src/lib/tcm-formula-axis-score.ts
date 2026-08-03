import syndromeLexiconJson from "../data/tcm-syndrome-lexicon.json" with { type: "json" };
import { assessPregnancyState } from "./clinical-state";

/**
 * 经典方召回的病位/病性/人群轴评分内核（确定性、零模型）。
 *
 * 为什么存在：M03 前的经典方短名单长期按「证候 token 重叠」排序，字面重合分不清方向，
 * 造成模板化偏置——归脾汤这类主治词面宽的方跨病种高频入围，而方向相反的清热方/温里方
 * 只要词面蹭得上也能排到前面。受治理目录里其实一直带着病位（locationTags/证候病位）、
 * 病性（natureTags/证候病性）与主治原文中的人群标记，本层把它们变成显式的加减分：
 * 轴一致加分、轴方向对立减分、token 重叠只作为基础分。
 *
 * ★ 三条边界 ★
 * 1. **只调排序，不做准入**：轴分从不进入 evidenceScore（准入分）。轴对立只能降权，
 *    绝不淘汰任何已凭检索证据入场的候选；轴数据缺失的方剂总分调整为 0，完全回退纯 token 分。
 * 2. **方向判定必须无歧义才生效**：病例或方剂在某维度上同时存在两侧标记（寒热并见、
 *    虚实夹杂）时该维度弃权，不加也不减——把「未知/混合」当成某一侧才是不可接受的错误。
 * 3. **全部可解释**：每个候选带 axisScoreBreakdown，逐轴列出加了/减了多少与命中值，
 *    供测试钉住与日志核查。它不是诊断结论，只是检索排序的确定性依据。
 */

type LexiconSyndromeEntry = {
  id: string;
  canonical: string;
  termClass?: string;
  locations?: string[];
  natures?: string[];
};

type SyndromeAxisRecord = {
  locations: readonly string[];
  natures: readonly string[];
  axisCount: number;
};

const SYNDROME_AXES_BY_ID: ReadonlyMap<string, SyndromeAxisRecord> = (() => {
  const lexicon = syndromeLexiconJson as {
    entries: LexiconSyndromeEntry[];
    clinicalExtensions?: LexiconSyndromeEntry[];
  };
  const byId = new Map<string, SyndromeAxisRecord>();
  for (const entry of [...lexicon.entries, ...(lexicon.clinicalExtensions || [])]) {
    if (entry.termClass === "category_heading") continue;
    const locations = entry.locations || [];
    const natures = entry.natures || [];
    if (locations.length + natures.length === 0) continue;
    byId.set(entry.id, { locations, natures, axisCount: locations.length + natures.length });
  }
  return byId;
})();

/**
 * 证候轴的特异性上限：轴数超过此值的证候（如「气分」12 条轴、「风寒感冒」8 条轴）是
 * 百科式粗粒度条目，把它们的轴并进方剂档案会让几乎每首方同时携带寒热两侧标记，
 * 匹配加分变成撒胡椒面。方向投票不受此限（见 directionFromSyndromeVotes 的单侧过滤）。
 */
const SYNDROME_AXIS_SPECIFICITY_LIMIT = 6;

// ─── 病性方向词表（受控 nature 轴闭集的子集；不在任一侧的值为中性，不参与方向判定） ───
/** 寒侧：虚寒（阳虚）与实寒同侧——对立面都是清热。 */
const COLD_SIDE: ReadonlySet<string> = new Set(["cold", "blood_cold", "yang_deficiency"]);
/** 热侧：实热与虚热（阴虚）同侧——对立面都是温散/温补。 */
const HEAT_SIDE: ReadonlySet<string> = new Set(["heat", "fire_heat", "blood_heat", "summerheat", "yin_deficiency"]);
const DEFICIENCY_SIDE: ReadonlySet<string> = new Set([
  "deficiency", "qi_deficiency", "blood_deficiency", "yin_deficiency", "yang_deficiency",
  "essence_deficiency", "qi_sinking", "qi_collapse", "fluid_depletion",
]);
/** 实侧只收明确的实邪/实滞标记；wind/cold/heat/dryness 这类可虚可实的原始病性不参与虚实方向。 */
const EXCESS_SIDE: ReadonlySet<string> = new Set([
  "excess", "fire_heat", "food_stagnation", "blood_stasis", "qi_stagnation", "phlegm",
  "dampness", "water_dampness", "fluid_retention", "toxin", "parasite_accumulation", "summerheat",
]);

/**
 * 病位等价桥。病例侧轴（症状映射表）说脏腑/表里，方剂侧目录常标皮毛/卫分/六经——
 * 同一病位在两套受控词表里各有写法，不搭桥「表实无汗」会判麻黄汤（locationTags=skin）
 * 病位不相交。六经→脏腑映射是教材恒等（太阳膀胱小肠、阳明胃大肠、少阳胆三焦、
 * 太阴脾肺、少阴心肾、厥阴肝心包），只用于重叠判定，不产生新的临床断言。
 */
const LOCATION_EQUIVALENCE: Readonly<Record<string, readonly string[]>> = {
  skin: ["exterior", "lung"],
  wei_level: ["exterior"],
  exterior: ["skin", "wei_level"],
  collaterals: ["channels"],
  channels: ["collaterals"],
  chong_ren: ["uterus"],
  uterus: ["chong_ren"],
  taiyang_channel_level: ["exterior", "bladder", "small_intestine"],
  yangming_channel_level: ["stomach", "large_intestine"],
  shaoyang_channel_level: ["gallbladder", "triple_burner"],
  taiyin_channel_level: ["spleen", "lung"],
  shaoyin_channel_level: ["heart", "kidney"],
  jueyin_channel_level: ["liver", "pericardium"],
};

// ─── 人群标记（来自受治理主治原文，正则闭集，构建期一次判定） ───
/**
 * 「适用」用宽口径（含妇人/经带等妇科措辞），只产生小额加分；
 * 「专用」判定改用严格产科口径：古籍常以「妇人」统摄性别中立的方（《金匮》半夏厚朴汤
 * 「妇人咽中如有炙脔」、四物汤的妇人经病表述），按宽口径判专用会把这类通用经典方
 * 对男性病例错误降权。只有胎产限定（产后/妊娠/恶露…）才足以支撑「与人群冲突」的减分。
 */
const MATERNAL_RE = /产后|产前|临产|难产|坐月|妊娠|孕妇|胎前|胎动|恶露|乳汁|催乳|妇人|妇女|经闭|月经|经水|经行|崩漏|带下|血崩|胎漏|保胎/;
const OBSTETRIC_RE = /产后|产前|临产|难产|坐月|妊娠|孕妇|胎前|胎动|胎漏|保胎|恶露|乳汁|催乳/;
const PEDIATRIC_RE = /小儿|婴儿|婴孩|幼儿|新生儿|胎怯|疳积|解颅/;
const GERIATRIC_RE = /老人|老年|高年|年高|年老/;
/** 主治里出现跨人群措辞（大人小儿…）时，该方不是任何单一人群的专用方。 */
const BROAD_POPULATION_RE = /大人|成人|男子|男女|老幼|老少|无论长幼/;

export type PopulationGroup = "maternal" | "pediatric" | "geriatric";

export type FormulaAxisProfile = {
  /** 方剂病位档案：自带 locationTags ∪ 特异证候（轴数≤上限）的病位。未展开等价桥。 */
  locations: ReadonlySet<string>;
  /** 方剂病性档案：自带 natureTags ∪ 特异证候的病性。 */
  natures: ReadonlySet<string>;
  /** 寒热方向；null = 无标记或双侧并存（弃权）。自带 natureTags 单侧时具有裁定权。 */
  thermal: "cold" | "heat" | null;
  /** 虚实方向；null = 无标记或虚实夹杂（弃权）。 */
  deficiencyExcess: "deficiency" | "excess" | null;
  /** 每条主治都限定于该人群 → 专用；任一条提及 → 适用。 */
  population: { dedicated: readonly PopulationGroup[]; applicable: readonly PopulationGroup[] };
  /**
   * 胎产限定专用（每条主治分支都命中 OBSTETRIC_RE）。男性冲突减分只认它——
   * 「妇人咽中如有炙脔」这类宽口径妇人措辞的通用经典方不因措辞被降权（见 MATERNAL_RE 注释）。
   */
  obstetricDedicated: boolean;
  /** 三轴均无数据 → true，评分内核直接返回全零（纯 token 分回退）。 */
  axisless: boolean;
};

export type CasePopulationProfile = {
  pediatric: boolean;
  adult: boolean;
  geriatric: boolean;
  /** 阳性事实中的产后/妊娠状态（妊娠判定复用 assessPregnancyState，备孕/孕前不落入）。 */
  maternal: boolean;
  male: boolean;
  basis: readonly string[];
};

export type FormulaAxisScoreBreakdown = {
  /** 三轴调整分之和。0 = 轴数据缺失或无可判方向，候选完全回退纯 token 分。 */
  total: number;
  location: {
    score: number;
    /** 经等价桥后与方剂病位重叠的病例病位值。 */
    matched: readonly string[];
    /** 双方都有明确病位且完全不相交（降权而非淘汰的那条规则）。 */
    disjoint: boolean;
  };
  nature: {
    score: number;
    /** 病例病性与方剂病性档案的直接交集。 */
    matched: readonly string[];
    caseThermal: "cold" | "heat" | null;
    formulaThermal: "cold" | "heat" | null;
    thermalOpposition: boolean;
    caseDeficiencyExcess: "deficiency" | "excess" | null;
    formulaDeficiencyExcess: "deficiency" | "excess" | null;
    deficiencyExcessOpposition: boolean;
  };
  population: {
    score: number;
    conflicts: readonly string[];
    matches: readonly string[];
  };
};

// ─── 评分常数：与词面证据（单词 0.4–2 分、总分常见 2–20）同量级，方向对立显著大于单项匹配 ───
const LOCATION_MATCH_PER_HIT = 0.8;
const LOCATION_MATCH_CAP = 2.4;
const LOCATION_DISJOINT_PENALTY = -1.5;
const NATURE_MATCH_PER_HIT = 0.6;
const NATURE_MATCH_CAP = 2.4;
const THERMAL_ALIGNMENT_BONUS = 1.2;
/** 寒热对立是最不能接受的方向错误（虚寒病例配清热方），罚分最重。 */
const THERMAL_OPPOSITION_PENALTY = -4;
const DEFICIENCY_EXCESS_ALIGNMENT_BONUS = 1.2;
const DEFICIENCY_EXCESS_OPPOSITION_PENALTY = -2.5;
const POPULATION_MATCH_BONUS = 0.8;
const POPULATION_CONFLICT_PENALTY = -2;
/** 老年专用方罕见且「专用」判定更弱（年老体弱常是修辞），冲突罚分减半。 */
const GERIATRIC_CONFLICT_PENALTY = -1;

function sideOf(values: Iterable<string>, side: ReadonlySet<string>): boolean {
  for (const value of values) if (side.has(value)) return true;
  return false;
}

function unambiguousDirection(
  values: Iterable<string>,
  leftSide: ReadonlySet<string>,
  rightSide: ReadonlySet<string>,
): "left" | "right" | null {
  const materialized = [...values];
  const left = sideOf(materialized, leftSide);
  const right = sideOf(materialized, rightSide);
  if (left && !right) return "left";
  if (right && !left) return "right";
  return null;
}

/**
 * 证候方向投票：每条证候只有在其病性落于**单侧**时才投票（寒热并存的百科条目自动弃权），
 * 汇总后仅当一侧有票且另一侧零票时形成方向。单侧过滤本身就是噪声闸，故投票不设特异性上限。
 */
function directionFromSyndromeVotes(
  syndromeTags: readonly string[],
  leftSide: ReadonlySet<string>,
  rightSide: ReadonlySet<string>,
): "left" | "right" | null {
  let left = 0;
  let right = 0;
  for (const id of syndromeTags) {
    const record = SYNDROME_AXES_BY_ID.get(id);
    if (!record) continue;
    const vote = unambiguousDirection(record.natures, leftSide, rightSide);
    if (vote === "left") left += 1;
    else if (vote === "right") right += 1;
  }
  if (left > 0 && right === 0) return "left";
  if (right > 0 && left === 0) return "right";
  return null;
}

function resolveDirection(
  ownNatures: readonly string[],
  syndromeTags: readonly string[],
  leftSide: ReadonlySet<string>,
  rightSide: ReadonlySet<string>,
): "left" | "right" | null {
  // 目录自带 natureTags 是逐方勾选的裁定数据，只要在该维度上有单侧标记就以它为准；
  // 双侧并存则该维度弃权（不回落证候投票——自带数据说这方寒热兼治，投票不得推翻）。
  if (sideOf(ownNatures, leftSide) || sideOf(ownNatures, rightSide)) {
    return unambiguousDirection(ownNatures, leftSide, rightSide);
  }
  return directionFromSyndromeVotes(syndromeTags, leftSide, rightSide);
}

function expandLocations(values: Iterable<string>): Set<string> {
  const expanded = new Set<string>();
  for (const value of values) {
    expanded.add(value);
    for (const equivalent of LOCATION_EQUIVALENCE[value] || []) expanded.add(equivalent);
  }
  return expanded;
}

function populationOf(indications: readonly string[]): FormulaAxisProfile["population"] & { obstetricDedicated: boolean } {
  const groups: Array<[PopulationGroup, RegExp]> = [
    ["maternal", MATERNAL_RE],
    ["pediatric", PEDIATRIC_RE],
    ["geriatric", GERIATRIC_RE],
  ];
  const meaningful = indications.filter((text) => text.trim().length > 0);
  const dedicated: PopulationGroup[] = [];
  const applicable: PopulationGroup[] = [];
  if (meaningful.length === 0) return { dedicated, applicable, obstetricDedicated: false };
  const broad = meaningful.some((text) => BROAD_POPULATION_RE.test(text));
  // 「专用」按主治分支判定，不按整段文本：主治原文常把多个适应证并进一句
  // （理中丸「脾胃虚寒证，或阳虚失血证，或小儿慢惊，…」），人群词只统辖它所在的分支。
  // 句读（。；;）分段后再按并列连接词（或/以及）拆分支；每个分支都限定于该人群才算专用。
  // 拆得更细只会让「专用」更难成立——漏掉一次降权是安全方向，把通用经典方错判成专用不是。
  const branches = meaningful
    .flatMap((text) => text.split(/[。；;]/))
    .flatMap((sentence) => sentence.split(/或|以及/))
    .map((branch) => branch.trim())
    .filter((branch) => branch.length > 0);
  for (const [group, pattern] of groups) {
    if (!meaningful.some((text) => pattern.test(text))) continue;
    applicable.push(group);
    if (!broad && branches.length > 0 && branches.every((branch) => pattern.test(branch))) {
      dedicated.push(group);
    }
  }
  const obstetricDedicated = !broad && branches.length > 0 && branches.every((branch) => OBSTETRIC_RE.test(branch));
  return { dedicated, applicable, obstetricDedicated };
}

export type FormulaAxisSourceFields = {
  natureTags: readonly string[];
  locationTags: readonly string[];
  syndromeTags: readonly string[];
  indications: readonly string[];
};

/** 由受治理目录字段构建方剂轴档案。纯函数；调用方可按方剂 id 缓存结果。 */
export function buildFormulaAxisProfile(entry: FormulaAxisSourceFields): FormulaAxisProfile {
  const locations = new Set(entry.locationTags);
  const natures = new Set(entry.natureTags);
  for (const id of entry.syndromeTags) {
    const record = SYNDROME_AXES_BY_ID.get(id);
    if (!record || record.axisCount > SYNDROME_AXIS_SPECIFICITY_LIMIT) continue;
    for (const value of record.locations) locations.add(value);
    for (const value of record.natures) natures.add(value);
  }
  const thermalDirection = resolveDirection(entry.natureTags, entry.syndromeTags, COLD_SIDE, HEAT_SIDE);
  const deficiencyExcessDirection = resolveDirection(entry.natureTags, entry.syndromeTags, DEFICIENCY_SIDE, EXCESS_SIDE);
  const { obstetricDedicated, ...population } = populationOf(entry.indications);
  return {
    locations,
    natures,
    thermal: thermalDirection === "left" ? "cold" : thermalDirection === "right" ? "heat" : null,
    deficiencyExcess: deficiencyExcessDirection === "left"
      ? "deficiency"
      : deficiencyExcessDirection === "right" ? "excess" : null,
    population,
    obstetricDedicated,
    axisless: locations.size === 0 && natures.size === 0 &&
      population.dedicated.length === 0 && population.applicable.length === 0,
  };
}

const POSTPARTUM_RE = /产后|产褥|分娩后|坐月子/;
const MALE_SEX_RE = /男/;
const FEMALE_SEX_RE = /女/;
/** 与确定性安全层同口径：<18 按儿科处理（diagnosis-safety.ts 的儿科门禁）。 */
const PEDIATRIC_AGE_LIMIT = 18;
const GERIATRIC_AGE_FLOOR = 65;

/**
 * 病例人群档案。输入必须是**阳性事实**文本（否定句已被极性层剥离），
 * 妊娠判定复用带备孕/孕前/避孕排除的 assessPregnancyState，避免「备孕中」被读成孕产人群。
 */
export function buildCasePopulationProfile(
  patient: { sex?: string; age?: number } | undefined,
  affirmedFacts: readonly string[],
): CasePopulationProfile {
  const basis: string[] = [];
  const age = typeof patient?.age === "number" && Number.isFinite(patient.age) ? patient.age : undefined;
  const sexText = typeof patient?.sex === "string" ? patient.sex : "";
  const male = MALE_SEX_RE.test(sexText) && !FEMALE_SEX_RE.test(sexText);
  const pediatric = age != null && age >= 0 && age < PEDIATRIC_AGE_LIMIT;
  const adult = age != null && age >= PEDIATRIC_AGE_LIMIT;
  const geriatric = age != null && age >= GERIATRIC_AGE_FLOOR;
  if (age != null) basis.push(`年龄${age}岁`);
  if (male) basis.push("性别男");
  const merged = affirmedFacts.join("；");
  const postpartum = POSTPARTUM_RE.test(merged);
  const pregnancyStatus = merged ? assessPregnancyState(merged).status : "unknown";
  const pregnant = pregnancyStatus === "positive" || pregnancyStatus === "possible";
  const maternal = !male && (postpartum || pregnant);
  if (postpartum && !male) basis.push("阳性事实含产后状态");
  if (pregnant && !male) basis.push(`妊娠状态判定为${pregnancyStatus}`);
  return { pediatric, adult, geriatric, maternal, male, basis };
}

export type CaseAxisInput = {
  locations: ReadonlySet<string>;
  natures: ReadonlySet<string>;
};

export type FormulaAxisScoreOptions = {
  /** full = 加分+减分（M03 前病例事实召回）；guard = 只减分（M03 后签名证候复查，匹配加分已由证候关系分承担）。 */
  mode?: "full" | "guard";
  /** 缺省表示本调用场景没有病例人口学信息（如签名辨证投影），人群轴整轴跳过。 */
  population?: CasePopulationProfile;
};

const ZERO_BREAKDOWN: FormulaAxisScoreBreakdown = {
  total: 0,
  location: { score: 0, matched: [], disjoint: false },
  nature: {
    score: 0,
    matched: [],
    caseThermal: null,
    formulaThermal: null,
    thermalOpposition: false,
    caseDeficiencyExcess: null,
    formulaDeficiencyExcess: null,
    deficiencyExcessOpposition: false,
  },
  population: { score: 0, conflicts: [], matches: [] },
};

/**
 * 轴评分内核。所有分量确定性可解释；轴数据任一侧缺失时对应分量为 0（additive 兜底），
 * 方向仅在双方都无歧义时才参与加减。返回值只供排序与展示，绝不得写入准入分。
 */
export function scoreFormulaAxes(
  profile: FormulaAxisProfile,
  caseAxes: CaseAxisInput,
  options: FormulaAxisScoreOptions = {},
): FormulaAxisScoreBreakdown {
  if (profile.axisless) return ZERO_BREAKDOWN;
  const mode = options.mode || "full";
  const bonusesEnabled = mode === "full";

  // ── 病位轴 ──
  // 只展开方剂侧再用病例原值求交：等价桥是对称收录的，单侧展开即可覆盖两向；
  // 双侧同时展开会让同一处病位（表↔皮毛）以两个等价值各计一次命中。
  const formulaLocations = expandLocations(profile.locations);
  const matchedLocations = [...caseAxes.locations].filter((value) => formulaLocations.has(value));
  const disjoint = profile.locations.size > 0 && caseAxes.locations.size > 0 && matchedLocations.length === 0;
  const locationScore = (bonusesEnabled
    ? Math.min(LOCATION_MATCH_CAP, matchedLocations.length * LOCATION_MATCH_PER_HIT)
    : 0) + (disjoint ? LOCATION_DISJOINT_PENALTY : 0);

  // ── 病性轴 ──
  const matchedNatures = [...caseAxes.natures].filter((value) => profile.natures.has(value));
  const caseThermalDirection = unambiguousDirection(caseAxes.natures, COLD_SIDE, HEAT_SIDE);
  const caseThermal = caseThermalDirection === "left" ? "cold" : caseThermalDirection === "right" ? "heat" : null;
  const caseDeficiencyExcessDirection = unambiguousDirection(caseAxes.natures, DEFICIENCY_SIDE, EXCESS_SIDE);
  const caseDeficiencyExcess = caseDeficiencyExcessDirection === "left"
    ? "deficiency"
    : caseDeficiencyExcessDirection === "right" ? "excess" : null;
  const thermalOpposition = Boolean(caseThermal && profile.thermal && caseThermal !== profile.thermal);
  const thermalAlignment = Boolean(caseThermal && profile.thermal && caseThermal === profile.thermal);
  const deficiencyExcessOpposition = Boolean(
    caseDeficiencyExcess && profile.deficiencyExcess && caseDeficiencyExcess !== profile.deficiencyExcess,
  );
  const deficiencyExcessAlignment = Boolean(
    caseDeficiencyExcess && profile.deficiencyExcess && caseDeficiencyExcess === profile.deficiencyExcess,
  );
  const natureScore =
    (bonusesEnabled ? Math.min(NATURE_MATCH_CAP, matchedNatures.length * NATURE_MATCH_PER_HIT) : 0) +
    (bonusesEnabled && thermalAlignment ? THERMAL_ALIGNMENT_BONUS : 0) +
    (thermalOpposition ? THERMAL_OPPOSITION_PENALTY : 0) +
    (bonusesEnabled && deficiencyExcessAlignment ? DEFICIENCY_EXCESS_ALIGNMENT_BONUS : 0) +
    (deficiencyExcessOpposition ? DEFICIENCY_EXCESS_OPPOSITION_PENALTY : 0);

  // ── 人群轴 ──
  const conflicts: string[] = [];
  const matches: string[] = [];
  let populationScore = 0;
  const casePopulation = options.population;
  if (casePopulation) {
    const dedicated = new Set(profile.population.dedicated);
    if (dedicated.has("pediatric") && casePopulation.adult) {
      conflicts.push("目录主治为儿科专用，与本例成人年龄冲突");
      populationScore += POPULATION_CONFLICT_PENALTY;
    }
    if (profile.obstetricDedicated && casePopulation.male) {
      conflicts.push("目录主治为孕产/妇人专用，与本例性别（男）冲突");
      populationScore += POPULATION_CONFLICT_PENALTY;
    }
    if (profile.obstetricDedicated && casePopulation.pediatric && !casePopulation.maternal) {
      conflicts.push("目录主治为孕产/妇人专用，与本例儿科年龄冲突");
      populationScore += POPULATION_CONFLICT_PENALTY;
    }
    if (dedicated.has("geriatric") && casePopulation.pediatric) {
      conflicts.push("目录主治为老年专用，与本例儿科年龄冲突");
      populationScore += GERIATRIC_CONFLICT_PENALTY;
    }
    if (bonusesEnabled && conflicts.length === 0) {
      const applicable = new Set(profile.population.applicable);
      if (casePopulation.maternal && applicable.has("maternal")) {
        matches.push("目录孕产/妇人适用标记与本例孕产状态一致");
        populationScore += POPULATION_MATCH_BONUS;
      }
      if (casePopulation.pediatric && applicable.has("pediatric")) {
        matches.push("目录儿科适用标记与本例儿科年龄一致");
        populationScore += POPULATION_MATCH_BONUS;
      }
      if (casePopulation.geriatric && applicable.has("geriatric")) {
        matches.push("目录老年适用标记与本例老年年龄一致");
        populationScore += POPULATION_MATCH_BONUS;
      }
    }
  }

  return {
    total: locationScore + natureScore + populationScore,
    location: { score: locationScore, matched: matchedLocations, disjoint },
    nature: {
      score: natureScore,
      matched: matchedNatures,
      caseThermal,
      formulaThermal: profile.thermal,
      thermalOpposition,
      caseDeficiencyExcess,
      formulaDeficiencyExcess: profile.deficiencyExcess,
      deficiencyExcessOpposition,
    },
    population: { score: populationScore, conflicts, matches },
  };
}
