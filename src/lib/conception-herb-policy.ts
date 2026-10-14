import labelsJson from "../data/tcm-chp-pregnancy-herb-labels.source.json" with { type: "json" };
import { resolveGovernedTcmHerbIdentity } from "./tcm-herb-identity";

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

/** 备孕档下写在该味核对说明里的一句（禁用的正常情况下进不了方；修复用尽仍留着时同样写明）。 */
export function conceptionHerbNote(herbName: string): string | undefined {
  const label = chpPregnancyLabel(herbName);
  if (!label) return undefined;
  return label.level === "prohibited"
    ? `${herbName}：药典2020「${label.wording}」本例备孕/未避孕，不宜使用，请替换。`
    : `${herbName}：药典2020「${label.wording}」本例备孕/未避孕，使用前请确认未妊娠，月经逾期者先验孕。`;
}

/** 药典孕妇禁用的饮片名（提示词里列给 M04，按表内顺序）。 */
export function chpPregnancyProhibitedHerbNames(): string[] {
  return LABELS.prohibited.map((row) => row.name);
}
