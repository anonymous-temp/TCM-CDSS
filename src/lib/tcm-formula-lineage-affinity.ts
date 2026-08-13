/**
 * 方剂 → 流派取向的受治理映射（甲方基线 §10.2：流派必须实质影响候选方来源与排序）。
 *
 * 数据源 tcm-formula-lineage-affinity.source.json 由「受治理目录 source 书名 ×
 * 流派卡 representativeWorks」推导，逐条带 adjudicationStatus；中医师终审前
 * （pending_clinician_review）一切条目零影响——不加分、不标注、不出现在任何输出。
 *
 * 三条硬边界（与数据文件 boundaries、医师工作包任务三的承诺逐字一致）：
 *  1) 加分只作用于**候选展示顺序**（提示词候选块）。retrieveTcmFormulaCandidatesForReasoning
 *     的返回序喂给 systemLockable 自动锁方（tcm-formula-indications.ts），本模块绝不介入——
 *     test:lineage-affinity 以源码断言钉住这一点。
 *  2) 不参与准入（evidenceScore 门槛）判定；够不着候选资格的方，加分也进不来。
 *  3) 只在同一「正向充分性 × 剂量可编译」层内重排：加分不得使候选跨层上移，
 *     所以证据层级（positiveSufficiency 优先、可编译优先）永远压过流派偏好。
 */
import affinitySource from "../data/tcm-formula-lineage-affinity.source.json" with { type: "json" };
import { lineageLabel } from "./tcm-lineages";

/** 展示层加分幅度：与病性标签单项权重同级（nature=2），低于证候单项（6）与高频关系（5/8）。 */
export const LINEAGE_AFFINITY_PRESENTATION_BONUS = 2;

const SCHOOL_LINEAGE_CODES = new Set([
  "classical-formula",
  "warm-disease",
  "nourish-yin-danxi",
  "warm-tonify-yang",
]);

type BookRule = {
  book: string;
  lineageCode: string;
  confirmationMode: "rule" | "per_formula";
  adjudicationStatus: string;
};

type FormulaAdjudication = {
  formulaName: string;
  source: string;
  lineageCode: string;
  status: string;
};

type AffinityData = {
  bookRules: readonly BookRule[];
  formulaAdjudications: readonly FormulaAdjudication[];
};

function sanitizedData(input: unknown): AffinityData {
  // fail-closed：数据文件形状不对时按「无任何映射」处理，而不是让半解析结果参与排序。
  const record = (input || {}) as Record<string, unknown>;
  const bookRules = Array.isArray(record.bookRules)
    ? (record.bookRules as BookRule[]).filter((rule) =>
        rule && typeof rule.book === "string" && rule.book.length > 0 &&
        typeof rule.lineageCode === "string" && SCHOOL_LINEAGE_CODES.has(rule.lineageCode) &&
        (rule.confirmationMode === "rule" || rule.confirmationMode === "per_formula") &&
        typeof rule.adjudicationStatus === "string")
    : [];
  const formulaAdjudications = Array.isArray(record.formulaAdjudications)
    ? (record.formulaAdjudications as FormulaAdjudication[]).filter((item) =>
        item && typeof item.formulaName === "string" && item.formulaName.length > 0 &&
        typeof item.source === "string" && typeof item.lineageCode === "string" &&
        typeof item.status === "string")
    : [];
  return { bookRules, formulaAdjudications };
}

const DATA = sanitizedData(affinitySource);

const APPROVED = "clinician_approved";

export interface FormulaLineageAffinity {
  lineageCode: string;
  lineageLabelText: string;
  book: string;
  /** 只有 true（书规则已终审，且逐首模式下该方也已终审）才产生任何可见效果。 */
  adjudicated: boolean;
}

export function lineageAffinityForFormula(
  formulaName: string,
  source: string,
  data: AffinityData = DATA,
): FormulaLineageAffinity | null {
  if (!formulaName || !source) return null;
  const rule = data.bookRules.find((item) => source.includes(item.book));
  if (!rule) return null;
  const ruleApproved = rule.adjudicationStatus === APPROVED;
  const formulaRow = rule.confirmationMode === "per_formula"
    ? data.formulaAdjudications.find((item) => item.formulaName === formulaName && item.lineageCode === rule.lineageCode)
    : undefined;
  const adjudicated = ruleApproved &&
    (rule.confirmationMode === "rule" || formulaRow?.status === APPROVED);
  return {
    lineageCode: rule.lineageCode,
    lineageLabelText: lineageLabel(rule.lineageCode),
    book: rule.book,
    adjudicated,
  };
}

interface PresentationCandidate {
  name: string;
  source: string;
  score: number;
  positiveSufficiency?: boolean;
  doseCompilationEligible?: boolean;
}

export interface LineagePresentationOrder<T extends PresentationCandidate> {
  ordered: T[];
  /** 已终审且命中偏好的候选（按方名），供渲染层追加「流派取向」标注。 */
  affinityByName: Map<string, FormulaLineageAffinity>;
  applied: boolean;
}

/**
 * 展示层重排：稳定排序，层级键（正向充分性 → 剂量可编译）保持原判据，
 * 只在层内用 score + 加分 重排；未终审/未命中偏好的候选顺序与原序完全一致。
 */
export function applyLineageAffinityPresentationOrder<T extends PresentationCandidate>(
  candidates: readonly T[],
  lineagePreference: string | undefined,
  data: AffinityData = DATA,
): LineagePresentationOrder<T> {
  const noop: LineagePresentationOrder<T> = {
    ordered: [...candidates],
    affinityByName: new Map(),
    applied: false,
  };
  const preference = (lineagePreference || "").trim();
  if (!SCHOOL_LINEAGE_CODES.has(preference) || candidates.length < 2) return noop;
  const affinityByName = new Map<string, FormulaLineageAffinity>();
  for (const candidate of candidates) {
    const affinity = lineageAffinityForFormula(candidate.name, candidate.source, data);
    if (affinity && affinity.adjudicated && affinity.lineageCode === preference) {
      affinityByName.set(candidate.name, affinity);
    }
  }
  if (affinityByName.size === 0) return noop;
  const stratum = (item: T): number =>
    Number(Boolean(item.positiveSufficiency)) * 2 + Number(Boolean(item.doseCompilationEligible));
  const adjustedScore = (item: T): number =>
    item.score + (affinityByName.has(item.name) ? LINEAGE_AFFINITY_PRESENTATION_BONUS : 0);
  const ordered = candidates
    .map((item, index) => ({ item, index }))
    .sort((left, right) =>
      stratum(right.item) - stratum(left.item) ||
      adjustedScore(right.item) - adjustedScore(left.item) ||
      left.index - right.index)
    .map((entry) => entry.item);
  const applied = ordered.some((item, index) => item !== candidates[index]);
  return { ordered, affinityByName, applied };
}

/** 仅供测试注入自定义裁定数据；运行时一律走文件数据。 */
export const __lineageAffinityInternalsForTest = { sanitizedData, DATA };
