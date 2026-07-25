import { classicEvidenceForFormulaNames } from "./tcm-classic-evidence.server";
import {
  compositionLogicForFormulaNames,
  formulaDiscriminationPaths,
  textualModificationsForFormulaNames,
} from "./tcm-classic-inference";
import { formulaContraindicationIssues } from "./tcm-formula-contraindications";

export { classicEvidenceForFormulaNames } from "./tcm-classic-evidence.server";

export function buildM04ClassicSafetyContext(
  formulaNames: string[],
  clinicalText: string,
): string {
  const paths = formulaDiscriminationPaths(formulaNames, clinicalText);
  const evidence = classicEvidenceForFormulaNames(formulaNames);
  const composition = compositionLogicForFormulaNames(formulaNames);
  const modifications = textualModificationsForFormulaNames(formulaNames, clinicalText);
  const issues = formulaContraindicationIssues(formulaNames, clinicalText);
  if (
    paths.length === 0 &&
    evidence.length === 0 &&
    composition.length === 0 &&
    modifications.length === 0 &&
    issues.length === 0
  ) return "";
  return [
    "【受控方证鉴别、经典依据与禁忌矩阵】",
    ...paths.map((item) =>
      `- 鉴别 ${item.againstFormula}：${item.question}；状态=${item.status}；` +
      `本方支持=${item.matchedTerms.join("、") || "未确认"}；对侧支持=${item.opposingTerms.join("、") || "未确认"}；` +
      `${item.contraindicationHints.length > 0 ? `安全提示=${item.contraindicationHints.join("、")}；` : ""}` +
      `来源=${item.sourceRef}`),
    ...evidence.map((item) =>
      `- 经典证据 ${item.evidenceId}：${item.citation}；锚点=${item.anchorLevel}${item.clauseNumber ? `:${item.clauseNumber}` : ""}；层级=${item.tier}。`),
    ...composition.map((item) =>
      `- 受控组成逻辑 ${item.formulaName}：${item.summary}；层级=${item.tier}；来源=${item.sourceRefs.join(" / ")}。`),
    ...modifications.map((item) =>
      `- 条文加减候选 ${item.ruleId}：当前阳性触发=${item.matchedTriggers.join("、")}；` +
      `${item.resultingFormula ? `结果方=${item.resultingFormula}；` : ""}` +
      `加=${item.addHerbs.join("、") || "无"}；去=${item.removeHerbs.join("、") || "无"}；` +
      `证据=${item.sourceEvidenceId}/${item.sourceCitation}；仅供医生复核，禁止据此自动增删药味。`),
    ...issues.map((item) =>
      `- ${item.severity === "block" ? "禁忌阻断" : "重点复核"} ${item.ruleId}：` +
      `${item.matchedTerms.join("、")}；${item.message}`),
    "服务端会再次执行禁忌矩阵。任何 block 命中均不得通过改写文字绕过，也不得输出参考项目中的经验剂量、炮制或急症自行处置法。",
  ].join("\n");
}
