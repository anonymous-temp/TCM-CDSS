import type { CaseState } from "./diagnosis-types";
import { executableFormulaCompilationReferences, formulaManualDoseIngredients } from "./tcm-formula-provenance";
import { getTcmHerbDoseLimit } from "./tcm-knowledge";
import { requiredDecoctionRequirement } from "./herb-decoction-rules";

type PriorReasoningLike = {
  overview?: {
    recommendedFormulaNames?: readonly string[] | null;
    primarySyndrome?: unknown;
  };
  therapy?: { overallMethod?: unknown; overallPrinciple?: unknown };
} | null | undefined;

/**
 * M04 模型输出彻底不可回收（截断/无候选/结构不闭合）时的**确定性**兜底：
 * 若 M03 已锁定受治理经典方且其基准组成可编译，则渲染「方名 + 受治理基准组成 +
 * 药典剂量区间 + 特殊煎法 + 监管扣除说明」——全部来自本地受治理知识库，不经模型。
 *
 * 为什么值得做：此前这条路径返回一页「未形成处方」，医生一无所获，只能脱离系统徒手开方
 * （甲方生产实测病例6/10：HTTP 200 但页面等于空白，M05/HIS 无法继续）。锁定方的法定组成
 * 与药典区间是系统**本来就核验过**的数据，把它们按「用量由医师确定」的非剂量形态给出，
 * 是证据绑定语义下能给的最大帮助。
 *
 * 边界（保持诚实）：
 *  · 仍是非剂量输出（保留 CDSS_NON_DOSE_PRESCRIPTION 标记）——系统不给具体克数，
 *    区间仅为药典边界，用量由医师确定并经院内审方复核；
 *  · M03 未锁方或锁定方不可编译时，回退到原有安全有限文案（调用方兜底）；
 *  · 不产生结构化 M04 载荷，不参与签名——它是给医生看的确定性参考，不是可采纳候选。
 */
export function buildDeterministicFormulaReferenceFallback(
  state: CaseState,
  prior: PriorReasoningLike,
): string | undefined {
  void state;
  const names = (prior?.overview?.recommendedFormulaNames || [])
    .filter((name): name is string => typeof name === "string" && Boolean(name.trim()));
  if (names.length === 0) return undefined;
  const references = executableFormulaCompilationReferences(names);
  if (references.length === 0) return undefined;

  const syndrome = typeof prior?.overview?.primarySyndrome === "string" ? prior.overview.primarySyndrome : "";
  const method = typeof prior?.therapy?.overallMethod === "string"
    ? prior.therapy.overallMethod
    : typeof prior?.therapy?.overallPrinciple === "string" ? prior.therapy.overallPrinciple : "";

  const sections = references.map((reference) => {
    const rows = reference.ingredients.map((name, index) => {
      const limit = getTcmHerbDoseLimit(name);
      const range = limit?.min != null && limit?.max != null ? `${limit.min}–${limit.max}g（药典区间）` : "由医师确定";
      const decoction = requiredDecoctionRequirement(name) || "";
      return `| ${index + 1} | ${name} | ${range} | ${decoction} |`;
    });
    const deducted = formulaManualDoseIngredients(reference.formulaName);
    return [
      `### ${reference.formulaName}（${reference.source}）`,
      "",
      "| 序号 | 药名 | 药典剂量区间 | 特殊煎法 |",
      "|---|---|---|---|",
      ...rows,
      ...(deducted.length > 0
        ? ["", `> 原方另含 ${deducted.join("、")}（毒性/管制类）：系统不为其编制用量，是否使用及用量由医师按监管要求单独决定并经审方复核。`]
        : []),
    ].join("\n");
  });

  return [
    "<!-- CDSS_NON_DOSE_PRESCRIPTION -->",
    "## 当前结论",
    "本轮模型未能形成可核验的剂量级候选处方（输出截断或未通过结构化合同）。以下为 M03 已锁定方剂的**受治理基准组成与药典剂量区间**——全部来自本地受治理知识库的确定性数据，不含模型生成内容，供医生直接参考定量。",
    "",
    ...(syndrome || method
      ? [`**辨证锚点**：${[syndrome, method].filter(Boolean).join("；")}`, ""]
      : []),
    ...sections,
    "",
    "## 处方安全边界",
    "上表剂量区间为药典边界而非本例建议量；具体用量由医师结合本例证候强度、年龄与体质确定，采纳前须经院内审方复核。可点击「重新生成」再次尝试形成完整剂量级候选。",
  ].join("\n");
}
