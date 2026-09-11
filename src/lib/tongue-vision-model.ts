import { getPrimaryTextModelConfig, textModelRequestTuning, type TextModelConfig } from "./text-model";

export type TongueVisionModelConfig = {
  provider: "glm" | "primary" | "unsupported";
  providerLabel: string;
  model: string;
  apiKey: string;
  endpoint: string;
  enabled: boolean;
  configured: boolean;
  disabledReason?: TextModelConfig["disabledReason"] | "disabled" | "unsupported_provider" | "unsupported_vision_model";
  requestTuning: Record<string, unknown>;
  missingMessage: string;
};

/** Only the explicitly verified primary model may receive images; never fall back to another key. */
export function getTongueVisionModelConfig(): TongueVisionModelConfig {
  const enabled = process.env.GLM_VISION_ENABLED !== "false";
  const provider = process.env.TONGUE_VISION_PROVIDER?.trim().toLowerCase() || "glm";
  if (provider === "glm") {
    const apiKey = process.env.GLM_API_KEY?.trim() || "";
    return {
      provider,
      providerLabel: "GLM vision",
      model: process.env.GLM_VISION_MODEL?.trim() || "glm-5v-turbo",
      apiKey,
      endpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
      enabled,
      configured: enabled && Boolean(apiKey),
      disabledReason: !enabled ? "disabled" : !apiKey ? "missing_api_key" : undefined,
      requestTuning: { thinking: { type: process.env.GLM_VISION_THINKING_ENABLED === "true" ? "enabled" : "disabled" } },
      missingMessage: "GLM_API_KEY not configured",
    };
  }
  if (provider === "primary") {
    const primary = getPrimaryTextModelConfig();
    const supportsVision = primary.provider === "openai-compatible" && primary.model === "deepseek-flash";
    // Unlike development text fixtures, image transport always requires HTTPS. Host/vendor
    // approval remains owned by the existing primary configuration; no separate endpoint or key.
    const secureTransport = primary.baseUrl.startsWith("https://");
    const disabledReason = !enabled ? "disabled"
      : primary.disabledReason || (!secureTransport ? "insecure_transport"
        : !supportsVision ? "unsupported_vision_model" : undefined);
    return {
      provider,
      providerLabel: primary.providerLabel,
      model: primary.model,
      apiKey: primary.apiKey,
      endpoint: `${primary.baseUrl}/chat/completions`,
      enabled,
      configured: enabled && primary.configured && secureTransport && supportsVision,
      disabledReason,
      requestTuning: textModelRequestTuning(primary.model, { reasoningEffort: "low", thinkingEnabled: false }),
      missingMessage: disabledReason === "missing_api_key"
        ? `${primary.keyVariable} not configured for ${primary.providerLabel} tongue vision`
        : `${primary.providerLabel} 舌象识别仅支持已批准的 HTTPS 端点与 deepseek-flash 模型`,
    };
  }
  return {
    provider: "unsupported",
    providerLabel: "Tongue vision",
    model: "unconfigured",
    apiKey: "",
    endpoint: "",
    enabled,
    configured: false,
    disabledReason: !enabled ? "disabled" : "unsupported_provider",
    requestTuning: {},
    missingMessage: "TONGUE_VISION_PROVIDER must be glm or primary",
  };
}
