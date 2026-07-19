import { isUnknownClinicalText } from "./clinical-state";

type TherapyLock = {
  candidateMatch: string;
  validationContext: string;
};

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function clinicalText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

const NON_EXECUTABLE_THERAPY_PRODUCTION = new RegExp([
  "(?:服务端|后端|后台|系统|模型|程序|接口|知识库|算法|平台|工作流|流程|模块|引擎)[^。；;\\n]{0,18}(?:生成|补全|填充|填写|返回|提供|输出|产出|计算|确定|给出|处理)",
  "(?:治法|治则|治疗方案|具体方案|治疗内容)[^。；;\\n]{0,20}(?:待|等待|稍后|后续|下一阶段|另行|自动|将由|将在|需由|需要由)[^。；;\\n]{0,18}(?:生成|补全|填充|填写|返回|提供|输出|产出|形成|确定|给出|处理)",
  "(?:待|等待|稍后|后续|下一阶段|另行|自动)[^。；;\\n]{0,18}(?:生成|补全|填充|填写|返回|提供|输出|产出|形成|确定|给出)[^。；;\\n]{0,12}(?:治法|治则|治疗|方案|内容|结果)?",
].join("|"));

/**
 * A treatment lock must be clinical text that can be acted on now, not provenance or a promise
 * that another component will produce the treatment later. The production grammar intentionally
 * covers open wording variants while leaving concise/classical treatment terms intact.
 */
export function isExecutableM03TherapyText(value: unknown): value is string {
  const text = clinicalText(value);
  if (!text || isUnknownClinicalText(text) || NON_EXECUTABLE_THERAPY_PRODUCTION.test(text)) return false;
  return /[\u4e00-\u9fa5]{2,}/.test(text);
}

function actionableTherapyText(value: unknown): string {
  const text = clinicalText(value);
  return isExecutableM03TherapyText(text) ? text : "";
}

/**
 * Build the single cross-stage treatment lock shared by the M04 compiler, canonicalizer and
 * semantic validator. The concrete method owns the candidate label; broader principles and node
 * directions remain in the validation context so equivalent, non-conflicting wording can pass.
 */
export function getM03TherapyLock(priorReasoning: unknown): TherapyLock {
  const prior = recordValue(priorReasoning);
  const therapy = recordValue(prior?.therapy);
  const pathogenesis = recordValue(prior?.pathogenesis);
  const chain = Array.isArray(pathogenesis?.chain) ? pathogenesis.chain : [];
  const nodeMethods = chain
    .map((node) => actionableTherapyText(recordValue(node)?.therapyDirection))
    .filter(Boolean);
  const overallMethod = actionableTherapyText(therapy?.overallMethod);
  const overallPrinciple = actionableTherapyText(therapy?.overallPrinciple);
  const candidateMatch = overallMethod || [...new Set(nodeMethods)].join("；") || overallPrinciple;
  const validationContext = [...new Set([
    overallMethod,
    overallPrinciple,
    ...nodeMethods,
  ].filter(Boolean))].join("；");
  return { candidateMatch, validationContext };
}
