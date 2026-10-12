/**
 * 方剂 → 流派取向的受治理映射（甲方基线 §10.2：流派必须实质影响候选方来源与排序）。
 *
 * 数据源 tcm-formula-lineage-affinity.source.json 有两条归属路径，逐条带核对状态；未通过核对的条目
 * （pending_clinician_review / evidence_rejected）一切条目零影响——不加分、不标注、不出现在任何输出：
 *  · 出处书规则（bookRules × formulaAdjudications）：方的目录出处是该流派著作；
 *  · 标志性运用（schoolUsage，2026-10-12）：方出自别处，但在该流派著作中被反复、标志性地运用
 *    （扶阳学派用《伤寒论》四逆辈、温补学派用六味/八味丸）。只按出处归属时，一首方只能属于一个流派，
 *    扶阳学派因此一首可排序的方都没有（10/12 实测 0 首），选了等于没选。每行绑定目录里的
 *    （方名, 出处）这一条，并且必须带该流派原典的逐字引文。
 * 2026-09-29 起没有可签字的中医师：书规则、逐首取向与标志性运用由联网权威来源（《中医各家学说》十三五教材、
 * 《四库全书总目》、各方原文功用）与本地原典逐条核对，通过的记 evidence_approved（与 clinician_approved 同效）。
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
  "warm-tonify",
  "support-yang",
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

type SchoolUsage = {
  formulaName: string;
  source: string;
  lineageCode: string;
  relation: "created" | "signature_use";
  schoolBook: string;
  status: string;
};

type AffinityData = {
  bookRules: readonly BookRule[];
  formulaAdjudications: readonly FormulaAdjudication[];
  schoolUsage: readonly SchoolUsage[];
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
  const schoolUsage = Array.isArray(record.schoolUsage)
    ? (record.schoolUsage as (SchoolUsage & { evidence?: unknown })[]).filter((row) =>
        row && typeof row.formulaName === "string" && row.formulaName.length > 0 &&
        typeof row.source === "string" && row.source.length > 0 &&
        typeof row.lineageCode === "string" && SCHOOL_LINEAGE_CODES.has(row.lineageCode) &&
        (row.relation === "created" || row.relation === "signature_use") &&
        typeof row.schoolBook === "string" && row.schoolBook.length > 0 &&
        typeof row.status === "string" &&
        // 没有原典证据的行按「无任何映射」处理，而不是靠状态字段放行。
        Array.isArray(row.evidence) && row.evidence.length > 0)
    : [];
  return { bookRules, formulaAdjudications, schoolUsage };
}

const DATA = sanitizedData(affinitySource);

// clinician_approved：中医师签字；evidence_approved：联网权威来源逐条核对通过（2026-09-29，owner 决定无中医师可签字）。
const APPROVED_STATUSES = new Set(["clinician_approved", "evidence_approved"]);

export interface FormulaLineageAffinity {
  lineageCode: string;
  lineageLabelText: string;
  book: string;
  /** source_book：方出自该流派著作；school_usage：方出自别处、在该流派著作中标志性运用。 */
  basis: "source_book" | "school_usage";
  /** 只有 true（已核对通过；逐首模式下该方也已核对通过）才产生任何可见效果。 */
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
  const ruleApproved = APPROVED_STATUSES.has(rule.adjudicationStatus);
  const formulaRow = rule.confirmationMode === "per_formula"
    ? data.formulaAdjudications.find((item) => item.formulaName === formulaName && item.lineageCode === rule.lineageCode)
    : undefined;
  const adjudicated = ruleApproved &&
    (rule.confirmationMode === "rule" || (formulaRow !== undefined && APPROVED_STATUSES.has(formulaRow.status)));
  return {
    lineageCode: rule.lineageCode,
    lineageLabelText: lineageLabel(rule.lineageCode),
    book: rule.book,
    basis: "source_book",
    adjudicated,
  };
}

/** 一首方的全部流派归属：出处书规则（至多一条）+ 标志性运用（可多条、可跨流派）。 */
export function lineageAffinitiesForFormula(
  formulaName: string,
  source: string,
  data: AffinityData = DATA,
): FormulaLineageAffinity[] {
  if (!formulaName || !source) return [];
  const byBook = lineageAffinityForFormula(formulaName, source, data);
  const usage = (data.schoolUsage || [])
    // 绑定（方名, 出处）：同名异方（如《金匮》温经汤与《妇人大全良方》温经汤）不得互相沾光。
    .filter((row) => row.formulaName === formulaName && row.source === source)
    .map((row): FormulaLineageAffinity => ({
      lineageCode: row.lineageCode,
      lineageLabelText: lineageLabel(row.lineageCode),
      book: row.schoolBook,
      basis: "school_usage",
      adjudicated: APPROVED_STATUSES.has(row.status),
    }));
  return [...(byBook ? [byBook] : []), ...usage];
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
  /** 已核对通过且命中偏好的候选（按方名），供渲染层追加「流派取向」标注。 */
  affinityByName: Map<string, FormulaLineageAffinity>;
  applied: boolean;
}

/**
 * 展示层重排：稳定排序，层级键（正向充分性 → 剂量可编译）保持原判据，
 * 只在层内用 score + 加分 重排；未核对通过/未命中偏好的候选顺序与原序完全一致。
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
    // 出处书规则排在前面：同一流派两条路径都命中时，标注「出自」比「标志性运用」更直接。
    const affinity = lineageAffinitiesForFormula(candidate.name, candidate.source, data)
      .find((item) => item.adjudicated && item.lineageCode === preference);
    if (affinity) affinityByName.set(candidate.name, affinity);
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
