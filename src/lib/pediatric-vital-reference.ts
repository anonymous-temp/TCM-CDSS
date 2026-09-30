import referenceData from "../data/tcm-pediatric-vital-reference.source.json" with { type: "json" };

/**
 * 儿童生命体征的年龄分档判定线（数据与出处见 tcm-pediatric-vital-reference.source.json）。
 *
 * 成人固定线（心率≥150 红旗、呼吸≥35 红旗、收缩压≤80 危急）会把健康新生儿（呼吸 40～45、心率 120～160）
 * 判成红旗——儿童剂量放开之后，这等于新生儿/乳婴儿几乎每例都被收回剂量。2026-09-30 回放：12 天新生儿
 * 呼吸 40 次/分被判红旗，8 月龄婴儿心率 120、呼吸 32 被提示「需尽快复测」。
 *
 * 纯模块（不引用 diagnosis-safety）。只覆盖未满 12 岁；12 岁及以上、年龄未知返回 undefined，调用方沿用成人线。
 * 只放宽「正常儿童被误报」的方向：低端（心率<40、呼吸≤8）、体温、血氧、高血压线不由本模块改动。
 */

export type PediatricVitalReference = {
  label: string;
  pulseAdvisoryFrom: number;
  pulseRedFlagFrom: number;
  respirationAdvisoryFrom: number;
  respirationRedFlagFrom: number;
  /** 收缩压低于此值即低血压危急；未满 10 岁才有，10～12 岁沿用成人线。 */
  systolicHypotensionBelow?: number;
};

type BandRow = {
  minDays: number;
  maxDays: number;
  label: string;
  pulseAdvisoryFrom: number;
  pulseRedFlagFrom: number;
  respirationAdvisoryFrom: number;
  respirationRedFlagFrom: number;
  systolicHypotensionBelow?: { base: number; perYear: number };
};

const BANDS = referenceData.bands as readonly BandRow[];
const DAYS_PER_YEAR = 365;

export function pediatricVitalReferenceForAgeYears(ageYears: number | null | undefined): PediatricVitalReference | undefined {
  if (ageYears == null || !Number.isFinite(ageYears) || ageYears < 0) return undefined;
  const days = ageYears * DAYS_PER_YEAR;
  const band = BANDS.find((row) => days >= row.minDays && days < row.maxDays);
  if (!band) return undefined;
  const hypotension = band.systolicHypotensionBelow;
  return {
    label: band.label,
    pulseAdvisoryFrom: band.pulseAdvisoryFrom,
    pulseRedFlagFrom: band.pulseRedFlagFrom,
    respirationAdvisoryFrom: band.respirationAdvisoryFrom,
    respirationRedFlagFrom: band.respirationRedFlagFrom,
    ...(hypotension ? { systolicHypotensionBelow: hypotension.base + hypotension.perYear * Math.floor(ageYears) } : {}),
  };
}
