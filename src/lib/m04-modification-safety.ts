import { canonicalTcmHerbIdentity, highImpactHerbDirectionIssue, m04HerbDirectionIssue } from "./diagnosis-stage-contract";
import { executableFormulaCompilationReferences } from "./tcm-formula-provenance";
import type { ClinicalReasoningResultV2 } from "./diagnosis-types";

const START_MARKER = "<!-- DIAGNOSIS_JSON_START -->";
const END_MARKER = "<!-- DIAGNOSIS_JSON_END -->";
const MODIFICATION_ADDITION = /(?:^|时|则|可|建议)(?:加入|加用|新增|加)([\u4e00-\u9fa5]{1,8})/;

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * Conditional modifications are optional decision support, not part of the current audited dose
 * candidate. The proposal compiler already drops an `add` row whose herb introduces a high-impact
 * direction absent from signed M03. Providers can nevertheless return a legacy full reasoning-v2
 * envelope, so apply the same invariant to every completed M04 envelope before review/signing.
 *
 * Only the unsupported optional row is removed. The candidate prescription and every other field
 * remain unchanged and still pass the complete M04 contract, independent review and external audit.
 */
export function dropUnsupportedM04ModificationDirections(
  content: string,
  prior: ClinicalReasoningResultV2 | null | undefined,
): string {
  if (!prior || prior.stage !== "diagnose") return content;
  const start = content.indexOf(START_MARKER);
  const end = start >= 0 ? content.indexOf(END_MARKER, start + START_MARKER.length) : -1;
  if (start < 0 || end < 0) return content;
  try {
    const reasoning = JSON.parse(content.slice(start + START_MARKER.length, end).trim()) as Record<string, unknown>;
    const formula = recordValue(reasoning.formula);
    const modifications = formula?.modifications;
    if (!formula || !Array.isArray(modifications) || modifications.length === 0) return content;
    const retained = modifications.filter((value) => {
      const modification = recordValue(value);
      if (!modification) return true;
      const action = typeof modification.action === "string" ? modification.action.trim().replace(/\s/g, "") : "";
      const addition = action.match(MODIFICATION_ADDITION);
      if (!addition) return true;
      const declaredDirection = [modification.reason, modification.targetPathogenesis]
        .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
        .join("；");
      return !highImpactHerbDirectionIssue(addition[1], declaredDirection, prior);
    });
    if (retained.length === modifications.length) return content;
    formula.modifications = retained;
    return `${content.slice(0, start + START_MARKER.length)}\n${JSON.stringify(reasoning, null, 2)}\n${content.slice(end)}`;
  } catch {
    return content;
  }
}

/**
 * 类的另一半：**实际药味**里方向未成立的加味，按单味剔除而不是让整张方作废。
 *
 * 上面那个函数已经确定性剔除「方向未成立的加减建议」；同一条不变量此前没有覆盖
 * candidate.herbs。后果是单味缺陷被放大成整方级作废：M03 锁定的经典方基准本身完全合格，
 * 只因模型多加了一味方向不成立的药，整张方连同基准药味一起被丢弃，医生拿到 0 味。
 *
 * 实测（甲方 10 例，flash 生产构建）两例同类：
 *   · 感冒-风寒束表锁麻黄汤，基准 4/4 达标，方中多出川芎（blood_move，治法「辛温解表」无活血）；
 *   · 牙痛-胃火炽盛锁清胃散，基准 4/5 达标，方中多出大黄（purge，治法「清胃泻火」无泻下）。
 * 两例修复轮都没删该味，最终 fixpoint 退化成非剂量输出。
 *
 * 四条剔除边界，缺一不可（不满足即原样返回，回到既有驳回行为，安全面一条未放宽）：
 *   1) 只剔除高影响方向未成立的药味——判定完全复用 highImpactHerbDirectionIssue，与门禁同一口径；
 *   2) **君药不剔除**：君药决定全方走向，其方向未成立属 emperor_therapy_mismatch，必须重选而非删除；
 *   3) **基准组成不剔除**：锁定经典方的法定组成本就享受身份豁免，不会走到这里；显式排除以防
 *      别名/饮片名解析差异误删基准药；
 *   4) 剔除后必须仍剩至少一味治疗性药味，且每个锁定基准的保留数仍达标——否则剔除会把一张
 *      合格的经典方削到身份下限以下，那是比原驳回更糟的结果。
 *
 * 剔除后的候选仍走完整既有链路：君臣佐使、剂量边界、P 节点引用、独立临床复核、灵犀审方
 * 一条不减。本函数只做减法，绝不新增药味、剂量或病机节点。
 */
export function dropUnsupportedM04CandidateHerbs(
  content: string,
  prior: ClinicalReasoningResultV2 | null | undefined,
  /**
   * 是否仍需守住经典方基准的最低保留数。正常 finalize 路径为 true（候选还在声称方名，
   * 削到身份下限以下比原驳回更糟）。**透明降级路径必须传 false**：方名已被确定性剥离，
   * 候选不再声称任何经典身份，基准保留数不再是它的约束——继续套用会让「基准本就不满足」的
   * 候选放弃剔除，问题药留在方里，降级验证随即失败，最终仍是 0 味
   *（实测感冒-风寒束表：前胡 heat_clear 未成立，基准不满足 → 放弃剔除 → 降级被拒）。
   */
  enforceBaselineFloor = true,
): string {
  if (!prior || prior.stage !== "diagnose") return content;
  const start = content.indexOf(START_MARKER);
  const end = start >= 0 ? content.indexOf(END_MARKER, start + START_MARKER.length) : -1;
  if (start < 0 || end < 0) return content;
  try {
    const reasoning = JSON.parse(content.slice(start + START_MARKER.length, end).trim()) as Record<string, unknown>;
    const formula = recordValue(reasoning.formula);
    const candidates = formula?.candidates;
    if (!formula || !Array.isArray(candidates) || candidates.length === 0) return content;
    const candidate = recordValue(candidates[0]);
    const herbs = candidate?.herbs;
    if (!candidate || !Array.isArray(herbs) || herbs.length === 0) return content;

    const lockedNames = [
      ...(Array.isArray(candidate.formulaNames) ? candidate.formulaNames : []),
      ...(Array.isArray(prior.overview?.recommendedFormulaNames) ? prior.overview.recommendedFormulaNames : []),
    ].filter((name): name is string => typeof name === "string" && Boolean(name.trim()));
    const baselines = executableFormulaCompilationReferences([...new Set(lockedNames)]);
    const baselineIdentities = new Set(
      baselines.flatMap((reference) => reference.ingredients).map((name) => canonicalTcmHerbIdentity(name)),
    );

    const retained = herbs.filter((value) => {
      const herb = recordValue(value);
      if (!herb) return true;
      const name = typeof herb.name === "string" ? herb.name.trim() : "";
      if (!name) return true;
      if (herb.role === "君") return true;
      if (baselineIdentities.has(canonicalTcmHerbIdentity(name))) return true;
      // 与门禁同一入口、同一入参形态：拼接功用串再判会落到 function 分支，与门禁读
      // prescriptionRole/targetPathogenesis 的口径不一致，导致「该剔的没剔、门禁照旧驳回」。
      return !m04HerbDirectionIssue(herb as Parameters<typeof m04HerbDirectionIssue>[0], prior);
    });
    if (retained.length === herbs.length) return content;

    const retainedTherapeutic = retained.filter((value) => recordValue(value)?.targetKind !== "formula_structure");
    if (retainedTherapeutic.length === 0) return content;
    const retainedIdentities = new Set(
      retained
        .map((value) => recordValue(value)?.name)
        .filter((name): name is string => typeof name === "string" && Boolean(name.trim()))
        .map((name) => canonicalTcmHerbIdentity(name)),
    );
    const baselineStillSatisfied = !enforceBaselineFloor || baselines.every((reference) =>
      reference.ingredients.filter((ingredient) => retainedIdentities.has(canonicalTcmHerbIdentity(ingredient))).length
        >= reference.minimumPreservedIngredientCount);
    if (!baselineStillSatisfied) return content;

    candidate.herbs = retained;
    return `${content.slice(0, start + START_MARKER.length)}\n${JSON.stringify(reasoning, null, 2)}\n${content.slice(end)}`;
  } catch {
    return content;
  }
}
