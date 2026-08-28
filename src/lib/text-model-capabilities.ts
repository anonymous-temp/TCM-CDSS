export type TextModelCapabilities = Readonly<{
  family: "qwen3.8" | "qwen3.7" | "qwen" | "deepseek" | "unknown";
  strictJsonSchema: boolean;
  qwenThinkingControl: "reasoning_effort" | "thinking_budget" | null;
  functionCalling: boolean;
  providerWebSearch: boolean;
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
    };
  }
  if (normalized.startsWith("qwen3.7-")) {
    return {
      family: "qwen3.7",
      strictJsonSchema: QWEN_37_STRICT.test(normalized),
      qwenThinkingControl: "thinking_budget",
      functionCalling: true,
      providerWebSearch: false,
    };
  }
  if (normalized.startsWith("qwen")) {
    return {
      family: "qwen",
      strictJsonSchema: false,
      qwenThinkingControl: "thinking_budget",
      functionCalling: true,
      providerWebSearch: false,
    };
  }
  if (normalized.startsWith("deepseek")) {
    return {
      family: "deepseek",
      strictJsonSchema: false,
      qwenThinkingControl: null,
      functionCalling: false,
      providerWebSearch: false,
    };
  }
  return {
    family: "unknown",
    strictJsonSchema: false,
    qwenThinkingControl: null,
    functionCalling: false,
    providerWebSearch: false,
  };
}
