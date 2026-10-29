import labelsJson from "../data/tcm-chp-pregnancy-herb-labels.source.json" with { type: "json" };
import { resolveGovernedTcmHerbIdentity } from "./tcm-herb-identity";
import {
  assessConceptionState,
  assessLactationState,
  assessPregnancyState,
  conceptionWithoutPregnancyOrLactation,
  isKnownClinicalState,
  isPositiveOrPossibleClinicalState,
  recordExcludesPregnancyPotential,
} from "./clinical-state";
import { labeledAgeYears } from "./pediatric-dose-rule";

/**
 * 药典 2020 年版一部写到孕妇的饮片（禁用/忌用 37、慎用 60；数据与来源见 tcm-chp-pregnancy-herb-labels.source.json）。
 *
 * 只给「备孕/未避孕」这一档用（clinical-state 的 conceptionWithoutPregnancyOrLactation）：禁用的不进方（M04 合同按特殊人群
 * 高风险驱动修复轮，加减里直接剔除），慎用的照用、在该味的核对说明里写明。已确认或可能妊娠、哺乳的患者不给剂量，不走这里。
 *
 * 药名对应：先按原名与表内别名逐字对（制川乌是慎用、川乌是禁用，两个品种都在表里，逐字先命中）；对不上再按受治理的药名身份
 *（resolveGovernedTcmHerbIdentity：醋三棱→三棱、生薏苡仁→薏苡仁、炒枳壳→枳壳）。这里不另写炮制前缀词表。
 */
export type ChpPregnancyLabel = { level: "prohibited" | "caution"; name: string; wording: string };

type LabelRow = { name: string; aliases?: string[]; wording: string };
const LABELS = labelsJson as { prohibited: LabelRow[]; caution: LabelRow[] };

const BY_NAME = new Map<string, ChpPregnancyLabel>();
for (const [level, rows] of [["prohibited", LABELS.prohibited], ["caution", LABELS.caution]] as const) {
  for (const row of rows) {
    for (const name of [row.name, ...(row.aliases || [])]) {
      if (!BY_NAME.has(name)) BY_NAME.set(name, { level, name: row.name, wording: row.wording });
    }
  }
}

export function chpPregnancyLabel(herbName: unknown): ChpPregnancyLabel | undefined {
  const name = String(herbName || "").normalize("NFKC").replace(/[（(][^）)]*[）)]/g, "").replace(/\s+/g, "").trim();
  if (name.length < 2) return undefined;
  const direct = BY_NAME.get(name);
  if (direct) return direct;
  const identity = resolveGovernedTcmHerbIdentity(name);
  const canonical = identity.canonicalName || identity.doseCanonicalName;
  return canonical ? BY_NAME.get(canonical) : undefined;
}

/**
 * 药典孕妇禁用饮片不进方的两档（与 M04 合同、编译器、提示词读同一个判据）：
 * - conception：备孕/未避孕（owner 2026-10-14），禁用的不进方、慎用的逐味标注；
 * - pregnancy_unknown：15–49 岁女性、病历没有记录妊娠状态（owner 2026-10-24 交由我们按建议定）：禁用的不进方，慎用的照用不逐味标注
 *   （注意事项里「如已怀孕、可能怀孕或正在哺乳，请服药前告知医生」那一句照旧）。理由：药典「孕妇禁用」的 37 味多为峻下逐水、
 *   破血消癥或大毒之品，避开它们几乎总有替代；而育龄女性在不知情的早孕期误服的代价不可逆。临床上对有生育可能的女性开说明书
 *   标「孕妇禁用」的药，本来就要先排除妊娠。慎用药（桂枝、牡丹皮、桃仁、红花、牛膝、大黄…）是大量常用方的组成，一律回避会改掉方子本身。
 * 年龄取人口统计通用的育龄口径 15–49 岁；没有数值年龄、病历写明绝经或子宫切除、妊娠已明确（阳性、可疑或否认）、哺乳阳性或可疑时都不属于这一档。
 */
export type ChpPregnancyHerbTier = "conception" | "pregnancy_unknown";

export function pregnancyUnknownReproductiveAgeFemale(groundingText: string): boolean {
  const text = String(groundingText || "").normalize("NFKC");
  if (!/性别\s*[:：]?\s*女/u.test(text)) return false;
  const age = labeledAgeYears(text);
  if (age == null || age < 15 || age >= 50) return false;
  if (recordExcludesPregnancyPotential(text, age)) return false;
  return !isKnownClinicalState(assessPregnancyState(text)) &&
    !isPositiveOrPossibleClinicalState(assessLactationState(text)) &&
    !isPositiveOrPossibleClinicalState(assessConceptionState(text));
}

export function chpPregnancyHerbTier(groundingText: string): ChpPregnancyHerbTier | undefined {
  if (conceptionWithoutPregnancyOrLactation(groundingText, labeledAgeYears(String(groundingText || "").normalize("NFKC")))) return "conception";
  if (pregnancyUnknownReproductiveAgeFemale(groundingText)) return "pregnancy_unknown";
  return undefined;
}

/** 写在该味核对说明里的一句（禁用的正常情况下进不了方；修复用尽仍留着时同样写明）。妊娠状态未记录档只写禁用的。 */
export function conceptionHerbNote(herbName: string, tier: ChpPregnancyHerbTier = "conception"): string | undefined {
  const label = chpPregnancyLabel(herbName);
  if (!label) return undefined;
  if (tier === "pregnancy_unknown") {
    return label.level === "prohibited"
      ? `${herbName}：药典2020「${label.wording}」本例为育龄女性、病历未记录妊娠状态，不宜使用，请替换；确认未妊娠后由医生决定。`
      : undefined;
  }
  return label.level === "prohibited"
    ? `${herbName}：药典2020「${label.wording}」本例备孕/未避孕，不宜使用，请替换。`
    : `${herbName}：药典2020「${label.wording}」本例备孕/未避孕，使用前请确认未妊娠，月经逾期者先验孕。`;
}

/** 药典孕妇禁用的饮片名（提示词里列给 M04，按表内顺序）。 */
export function chpPregnancyProhibitedHerbNames(): string[] {
  return LABELS.prohibited.map((row) => row.name);
}
