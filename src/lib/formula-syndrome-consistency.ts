import governedCatalog from "../data/tcm-formula-governed-catalog.json" with { type: "json" };
import { governedSyndromeLabelAxes } from "./clinical-vocabulary";
import { buildFormulaAxisProfile, scoreFormulaAxes } from "./tcm-formula-axis-score";

/**
 * 证-方一致性交叉校验(2026-08-04,来自甲方考题集 14 例分歧的循证裁决第 1 条建议)。
 *
 * 实测缺陷:系统判「脾虚湿蕴证」却锁定**茵陈术附汤**——该方是寒湿阻遏证的专方(#338);
 * 判「脾胃伏火证」却应走疏风散火(#340)。证名与所选方各自看都像话,合起来自相矛盾,
 * 而此前没有任何一层校验它们的关系。
 *
 * 判据刻意只拦**方向对立**,不拦「不同」:一方治多证是中医常态,把「方的归属证 ≠ 主证」
 * 一律判违规会大面积误伤。方向对立(签名证候虚寒 vs 方剂清热泻实)才是不可能同时成立的
 * 临床矛盾。对立判定直接复用 tcm-formula-axis-score 的确定性轴内核(guard 模式),
 * 不新写任何规则或词表——这正是「不再靠硬编码/关键词」的落法。
 *
 * 边界:
 *  · 方无证候标注、或证候标签解不出轴时**弃权**(返回 undefined),绝不因数据缺口驳回;
 *  · 只看寒热与虚实两个方向轴,病位不相交不构成矛盾(异病同治);
 *  · 返回的是**驳回码**,由调用方决定处置(修复轮/批注),本模块不做处置判断。
 */

type CatalogEntry = {
  name: string;
  aliases?: string[];
  natureTags?: string[];
  locationTags?: string[];
  syndromeTags?: string[];
  indications?: string[];
};

const ENTRIES = (governedCatalog as { entries: CatalogEntry[] }).entries;
const BY_NAME = new Map<string, CatalogEntry>();
for (const entry of ENTRIES) {
  const key = (entry.name || "").replace(/\s+/g, "");
  if (key && !BY_NAME.has(key)) BY_NAME.set(key, entry);
  for (const alias of entry.aliases || []) {
    const aliasKey = (alias || "").replace(/\s+/g, "");
    if (aliasKey && !BY_NAME.has(aliasKey)) BY_NAME.set(aliasKey, entry);
  }
}

function catalogEntryFor(name: string): CatalogEntry | undefined {
  const key = String(name || "").replace(/\s+/g, "").replace(/加减$|加味$|化裁$|合.*$/g, "");
  return BY_NAME.get(key) || BY_NAME.get(String(name || "").replace(/\s+/g, ""));
}

export type FormulaSyndromeConflict = {
  formulaName: string;
  /** thermal = 寒热对立;deficiency_excess = 虚实对立。 */
  axis: "thermal" | "deficiency_excess";
  syndromeSide: string;
  formulaSide: string;
};

/**
 * 返回签名证候与所选方之间的方向对立(可为空)。调用方按需转为驳回码或医生批注。
 */
export function formulaSyndromeConflicts(
  formulaNames: readonly string[],
  primarySyndrome: string,
): FormulaSyndromeConflict[] {
  const syndrome = String(primarySyndrome || "").trim();
  if (!syndrome || formulaNames.length === 0) return [];
  const axes = governedSyndromeLabelAxes(syndrome);
  if (axes.locations.length === 0 && axes.natures.length === 0) return [];

  const conflicts: FormulaSyndromeConflict[] = [];
  for (const name of formulaNames) {
    const entry = catalogEntryFor(name);
    if (!entry) continue;
    const profile = buildFormulaAxisProfile({
      natureTags: entry.natureTags || [],
      locationTags: entry.locationTags || [],
      syndromeTags: entry.syndromeTags || [],
      indications: entry.indications || [],
    });
    if (profile.axisless) continue;
    // guard 模式:只做方向对立判定,不计匹配加分。
    const breakdown = scoreFormulaAxes(profile, { locations: new Set(axes.locations), natures: new Set(axes.natures) }, { mode: "guard" });
    if (breakdown.nature.thermalOpposition && breakdown.nature.caseThermal && breakdown.nature.formulaThermal) {
      conflicts.push({
        formulaName: name,
        axis: "thermal",
        syndromeSide: breakdown.nature.caseThermal,
        formulaSide: breakdown.nature.formulaThermal,
      });
      continue;
    }
    if (
      breakdown.nature.deficiencyExcessOpposition &&
      breakdown.nature.caseDeficiencyExcess &&
      breakdown.nature.formulaDeficiencyExcess
    ) {
      conflicts.push({
        formulaName: name,
        axis: "deficiency_excess",
        syndromeSide: breakdown.nature.caseDeficiencyExcess,
        formulaSide: breakdown.nature.formulaDeficiencyExcess,
      });
    }
  }
  return conflicts;
}

/** 给医生看的一句话说明(呈现层用);无冲突返回 undefined。 */
export function formulaSyndromeConflictNotice(conflicts: readonly FormulaSyndromeConflict[]): string | undefined {
  if (conflicts.length === 0) return undefined;
  const axisLabel = { thermal: "寒热方向", deficiency_excess: "虚实方向" } as const;
  const sideLabel: Record<string, string> = {
    cold: "偏寒", heat: "偏热", deficiency: "属虚", excess: "属实",
  };
  const items = conflicts.map((item) =>
    `${item.formulaName}(标准目录归属${sideLabel[item.formulaSide] || item.formulaSide}) 与本例证候(${sideLabel[item.syndromeSide] || item.syndromeSide})在${axisLabel[item.axis]}上相反`);
  return `⚠️ **证-方方向核对**：${items.join("；")}。该判定由本地标准目录确定性比对得出,不代表一定错误(异病同治、反治法均可成立),但请医生确认选方与辨证的对应关系后再采纳。`;
}
