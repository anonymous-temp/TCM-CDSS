export type TextModelCapabilities = Readonly<{
  family: "qwen3.8" | "qwen3.7" | "qwen" | "deepseek" | "unknown";
  strictJsonSchema: boolean;
  qwenThinkingControl: "reasoning_effort" | "thinking_budget" | null;
  functionCalling: boolean;
  providerWebSearch: boolean;
  /**
   * 供应商是否对 tool-call 参数做**服务端** JSON Schema 强制（`strict: true`）。
   * 2026-09-14 实测：DeepSeek 正式端点与 beta 端点都对 strict 函数参数做约束解码
   * （枚举精确、可空字段返回 null），而它的 response_format 只有 json_object、不执行 schema。
   * 复核器这种闭集分类器在 json_object 下会把整句中文写进枚举字段（31 例里 2 例），
   * 生产 222 例因此 54 次 invalid contract。有此能力的模型走 tool-call 取回闭集结论。
   */
  strictToolArguments: boolean;
}>;

const QWEN_38_SUPPORTED = /^qwen3\.8-(?:flash|max)(?:$|[-_])/i;
const QWEN_37_STRICT = /^qwen3\.7-(?:plus|max)(?:$|[-_])/i;

/**
 * Provider capability decisions live here rather than in prompts, deployment files and request
 * adapters independently. A model rollout should change this table once; every caller then gets
 * the same constrained-output and thinking protocol. Unknown variants stay conservative.
 */
export function textModelCapabilities(model: string): TextModelCapabilities {
  const normalized = model.trim().toLowerCase();
  if (QWEN_38_SUPPORTED.test(normalized)) {
    return {
      family: "qwen3.8",
      strictJsonSchema: true,
      qwenThinkingControl: "reasoning_effort",
      functionCalling: true,
      providerWebSearch: true,
      strictToolArguments: false,
    };
  }
  if (normalized.startsWith("qwen3.7-")) {
    return {
      family: "qwen3.7",
      strictJsonSchema: QWEN_37_STRICT.test(normalized),
      qwenThinkingControl: "thinking_budget",
      functionCalling: true,
      providerWebSearch: false,
      strictToolArguments: false,
    };
  }
  if (normalized.startsWith("qwen")) {
    return {
      family: "qwen",
      strictJsonSchema: false,
      qwenThinkingControl: "thinking_budget",
      functionCalling: true,
      providerWebSearch: false,
      strictToolArguments: false,
    };
  }
  if (normalized.startsWith("deepseek")) {
    return {
      family: "deepseek",
      strictJsonSchema: false,
      qwenThinkingControl: null,
      functionCalling: false,
      providerWebSearch: false,
      strictToolArguments: true,
    };
  }
  return {
    family: "unknown",
    strictJsonSchema: false,
    qwenThinkingControl: null,
    functionCalling: false,
    providerWebSearch: false,
    strictToolArguments: false,
  };
}
