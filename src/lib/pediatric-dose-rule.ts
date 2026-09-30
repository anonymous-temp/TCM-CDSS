import ruleData from "../data/tcm-pediatric-dose-rule.source.json" with { type: "json" };

/**
 * 儿童中药汤剂剂量的年龄分数法（单一权威；数据与依据见 tcm-pediatric-dose-rule.source.json）。
 *
 * 此前未满 18 岁一律收回剂量（「没有可验证的儿童剂量规则」）。owner 2026-09-30 决定改按教材年龄分数法折算：
 * 儿童每味药的上限 = 成人（药典逐药区间）上限 × 年龄档分数，不设下限。「谁是儿童、属于哪一档」只在这里算一次，
 * 安全门、M04 合同、编译器、HIS 方案都读同一个结果——本仓头号缺陷形状就是同一判据多处各写各的。
 *
 * 纯模块：不引用 diagnosis-safety（它引用本模块），输入只有年龄（年）或病历文本。
 */

export type PediatricStageCode = "neonate" | "infant" | "toddler" | "preschool" | "school" | "adolescent";

export type PediatricDoseRule = {
  stage: PediatricStageCode;
  /** 页面用语：新生儿 / 乳婴儿 / 幼儿 / 学龄前儿童 / 学龄期及青少年。 */
  label: string;
  /** 教材分数表里对应的行：新生儿 / 乳婴儿 / 幼儿 / 学龄儿童。 */
  tableLabel: string;
  ageText: string;
  numerator: number;
  denominator: number;
  fraction: number;
  fractionText: string;
  /** 一日两煎合并药液量（mL）：《儿童中药用量及用法》按年龄给出，12 岁及以上与成人同。 */
  decoctionVolumeMl: number;
};

type StageRow = {
  code: PediatricStageCode;
  label: string;
  tableLabel: string;
  minDays: number;
  maxDays: number;
  numerator: number;
  denominator: number;
  ageText: string;
  decoctionVolumeMl: number;
};

const STAGES = ruleData.stages as readonly StageRow[];
const STAGE_WORDS = ruleData.stageWords as Readonly<Record<PediatricStageCode, readonly string[]>>;
const UNSPECIFIED_CHILD_WORDS = ruleData.unspecifiedChildWords as readonly string[];
type HerbRestrictionRow = {
  names: readonly string[];
  level: "prohibited" | "caution";
  scope: "any_child" | "infant_below";
  reason: string;
  quote: string;
  basis: string;
};
const HERB_RESTRICTIONS = ruleData.herbRestrictions as readonly HerbRestrictionRow[];
const DOSE_CONTROL_HERBS = ruleData.doseControlHerbs.herbs as readonly string[];
const DOSE_CONTROL_MAX_FRACTION = ruleData.doseControlHerbs.maxFraction.numerator / ruleData.doseControlHerbs.maxFraction.denominator;
const REGIMEN_GUIDANCE = ruleData.regimenGuidance as readonly string[];
const AGE_UNIT_DAYS = ruleData.ageUnitDays as Readonly<Record<string, number>>;
const DAYS_PER_YEAR = 365;
/** 分数的最小步长：儿童上限向下取到 0.5g，避免「1.667g」这类不可称量的数。 */
const CEILING_STEP_G = 0.5;

function ruleFromStage(row: StageRow): PediatricDoseRule {
  return {
    stage: row.code,
    label: row.label,
    tableLabel: row.tableLabel,
    ageText: row.ageText,
    numerator: row.numerator,
    denominator: row.denominator,
    fraction: row.numerator / row.denominator,
    fractionText: row.numerator === row.denominator ? "1" : `${row.numerator}/${row.denominator}`,
    decoctionVolumeMl: row.decoctionVolumeMl,
  };
}

/** 年龄（岁，可为小数）→ 档位。18 岁及以上、非法值返回 undefined（不是儿童）。 */
export function pediatricDoseRuleForAgeYears(ageYears: number): PediatricDoseRule | undefined {
  if (!Number.isFinite(ageYears) || ageYears < 0) return undefined;
  const days = ageYears * DAYS_PER_YEAR;
  const row = STAGES.find((stage) => days >= stage.minDays && days < stage.maxDays);
  return row ? ruleFromStage(row) : undefined;
}

/**
 * 只知道档位（病历只写「幼儿」「新生儿」，没有数值年龄）时，按该档**最大**的年龄取参考值：
 * 心率/呼吸的判定线随年龄递减、低血压线随年龄递增，取档内最大年龄两头都落在更保守的一侧。
 */
export function pediatricStageOldestAgeYears(rule: PediatricDoseRule): number | undefined {
  const row = STAGES.find((stage) => stage.code === rule.stage);
  return row ? (row.maxDays - 1) / DAYS_PER_YEAR : undefined;
}

const INFANT_FEEDING_PHRASES = ruleData.infantFeedingPhrases as readonly string[];

/**
 * 婴幼儿病历里的喂养方式词（母乳喂养/混合喂养/哺乳…）描述的是患儿自己，不是母亲的哺乳期。孕哺阳性判据读文本前先去掉它们
 * （仅对儿童语境调用）；妊娠、备孕等其他表述原样保留。词表在数据文件 infantFeedingPhrases，长词优先。
 */
export function stripInfantFeedingPhrases(text: string): string {
  let out = text;
  for (const phrase of [...INFANT_FEEDING_PHRASES].sort((left, right) => right.length - left.length)) out = out.split(phrase).join("");
  return out;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const alternation = (words: readonly string[]) =>
  [...words].sort((left, right) => right.length - left.length).map(escapeRegExp).join("|");

const ALL_STAGE_WORDS = Object.values(STAGE_WORDS).flat();
/** 病历里出现即判为「儿童」的定性词（结构化人口学字段用）。 */
export const PEDIATRIC_STRUCTURED_WORD_PATTERN = new RegExp(
  `(?:${alternation([...ALL_STAGE_WORDS, ...UNSPECIFIED_CHILD_WORDS, "月龄"])})`,
);
/** 叙述里必须出现在**分句开头**的儿童主语（「患者高龄，其孙女是儿童」不算）。 */
export const PEDIATRIC_CLAUSE_SUBJECT_PATTERN = new RegExp(
  `^(?:(?:患者|病人)\\s*(?:为|系|是)?\\s*)?(?:一名|一位|该名|这个)?\\s*(?:${alternation([...ALL_STAGE_WORDS, ...UNSPECIFIED_CHILD_WORDS])})`,
);

/** 接地语料里带标签的年龄行：单位表来自数据文件（ageUnitDays），不在代码里手写。 */
const LABELED_AGE = new RegExp(
  `(?:患者)?年龄\\s*[:：]\\s*(\\d+(?:\\.\\d+)?)\\s*(${alternation(Object.keys(AGE_UNIT_DAYS))})`,
);

/**
 * 定性词 → 档位。同时命中多档时取分数最小的（最保守）：「婴幼儿」= 婴儿 ∪ 幼儿，取乳婴儿档 1/3。
 * 只有「患儿/儿童/宝宝」这类不带年龄段的词 → undefined（无法折算，调用方按「年龄段未知」处理）。
 */
export function pediatricDoseRuleForStageWords(text: string): PediatricDoseRule | undefined {
  const rules = STAGES
    .filter((row) => STAGE_WORDS[row.code]?.some((word) => text.includes(word)))
    .map(ruleFromStage);
  return rules.sort((left, right) => left.fraction - right.fraction)[0];
}

/**
 * 接地语料里的年龄标签行 → 年（可为小数）。首选服务端写的「患者年龄：N岁」（小数年，权威口径，排在语料首行），
 * 也认叙述里带标签的「年龄：8个月 / 20天」。没有标签行返回 undefined。
 */
function labeledAgeYears(text: string): number | undefined {
  const match = text.match(LABELED_AGE);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const daysPerUnit = AGE_UNIT_DAYS[match[2]];
  if (!Number.isFinite(amount) || !Number.isFinite(daysPerUnit)) return undefined;
  return (amount * daysPerUnit) / DAYS_PER_YEAR;
}

/**
 * 接地语料（clinicalGroundingText）→ 档位；没有数值年龄时才看儿童定性词。
 * 与病历侧 `pediatricDoseRuleForCase`（diagnosis-safety）读的是同一个权威年龄，所以合同、编译器与安全门不会各算各的。
 */
export function pediatricDoseRuleFromGroundingText(text: string): PediatricDoseRule | undefined {
  const years = labeledAgeYears(text);
  if (years != null) return pediatricDoseRuleForAgeYears(years);
  const clause = text.split(/[。；;\n]+/).map((item) => item.trim()).find((item) => PEDIATRIC_CLAUSE_SUBJECT_PATTERN.test(item));
  return clause ? pediatricDoseRuleForStageWords(clause) : undefined;
}

/** 接地语料里是否已经明确是儿童（数值年龄 <18 或定性词）——M04 特殊人群矩阵的儿童臂用它，不再写第二份正则。 */
export function isPediatricGroundingText(text: string): boolean {
  const years = labeledAgeYears(text);
  if (years != null) return years < 18;
  return text.split(/[。；;\n]+/).some((item) => PEDIATRIC_CLAUSE_SUBJECT_PATTERN.test(item.trim()));
}

/** 教材点名要「注意控制剂量」的辛热/苦寒/攻伐/峻烈药：任何年龄档的分数都不超过 2/3（不因「接近成人量」或「药味少可增量」放大）。 */
export function pediatricDoseFractionFor(rule: PediatricDoseRule, herbName?: string): number {
  if (herbName && DOSE_CONTROL_HERBS.some((name) => herbName.includes(name))) {
    return Math.min(rule.fraction, DOSE_CONTROL_MAX_FRACTION);
  }
  return rule.fraction;
}

/** 儿童单味上限（克）：成人上限 × 分数，向下取 0.5g；不足 0.5g 时保留三位小数，不取零。传药名时对控量药按上限 2/3 封顶。 */
export function pediatricDoseCeilingG(adultMaxG: number, rule: PediatricDoseRule, herbName?: string): number {
  const raw = adultMaxG * pediatricDoseFractionFor(rule, herbName);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  if (raw < CEILING_STEP_G) return Math.round(raw * 1000) / 1000;
  return Math.floor(raw / CEILING_STEP_G + 1e-9) * CEILING_STEP_G;
}

export type PediatricHerbRestriction = { level: "prohibited" | "caution"; reason: string; basis: string; herb: string };

/** 该药在这个年龄档是否禁用/慎用（药典 2020、十三五教材、国家药监部门通告；数据见 herbRestrictions）。 */
export function pediatricHerbRestriction(herbName: string, rule: PediatricDoseRule): PediatricHerbRestriction | undefined {
  const name = String(herbName || "").trim();
  if (!name) return undefined;
  let found: PediatricHerbRestriction | undefined;
  for (const row of HERB_RESTRICTIONS) {
    if (row.scope === "infant_below" && rule.stage !== "neonate" && rule.stage !== "infant") continue;
    const hit = row.names.find((item) => name.includes(item));
    if (!hit) continue;
    // 同一味药命中多行时禁用优先于慎用
    if (!found || (row.level === "prohibited" && found.level !== "prohibited")) {
      found = { level: row.level, reason: row.reason, basis: row.basis, herb: hit };
    }
  }
  return found;
}

/** 本档禁用/慎用药名清单（写进提示词，让模型一开始就避开）。 */
export function pediatricRestrictedHerbNames(rule: PediatricDoseRule): { prohibited: string[]; caution: string[] } {
  const out = { prohibited: [] as string[], caution: [] as string[] };
  for (const row of HERB_RESTRICTIONS) {
    if (row.scope === "infant_below" && rule.stage !== "neonate" && rule.stage !== "infant") continue;
    (row.level === "prohibited" ? out.prohibited : out.caution).push(row.names[0]);
  }
  return out;
}

/** 一句话：写进提示词、页面「儿童用药说明」与 HIS 复核项。 */
export function pediatricDoseRuleSummary(rule: PediatricDoseRule): string {
  const head = `儿童（${rule.label}，${rule.ageText}）：剂量按《中药学》《中医儿科学》年龄分数法折算`;
  return rule.fraction >= 1
    ? `${head}，接近成人用量，每味药不超过药典成人上限（${rule.tableLabel}档）`
    : `${head}，每味药取成人一般用量的 ${rule.fractionText} 以内（${rule.tableLabel}档）`;
}

/** 面向医生的用药提示（M04 页「儿童用药说明」用）。 */
export function pediatricDoseRuleGuidance(rule: PediatricDoseRule): string[] {
  const lines = [
    `年龄分数法：${rule.tableLabel}用成人量的 ${rule.fractionText}；分数针对成人一般用量，逐味上限 = 药典成人上限 × ${rule.fractionText}，低于成人下限是儿童用量的常态。`,
    "总量控制：药味多的处方主药用量不宜再减，辅助药可酌减或精简药味；药味特别少的处方每味可增大，但不超过成人一般用量。",
    "病情急重者不受上述比例限制，由接诊医师按体重与病情个体化确定。",
    "辛热、苦寒、攻伐和药性峻烈的药物（如麻黄、附子、细辛、乌头、大黄、巴豆、芒硝）应控制剂量，任何年龄档均不超过成人上限的 2/3。",
    ...REGIMEN_GUIDANCE,
  ];
  const restricted = pediatricRestrictedHerbNames(rule);
  lines.push(`本档禁用药味：${restricted.prohibited.join("、")}；慎用药味：${restricted.caution.join("、")}。`);
  if (rule.stage === "neonate") lines.push("新生儿期（出生28天内）汤剂宜少量多次喂服，并优先由儿科医师评估。");
  return lines;
}
