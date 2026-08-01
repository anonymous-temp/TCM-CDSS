import OpenAI from "openai";

export type TextModelProvider = "bailian-qwen" | "openai-compatible";

export type TextModelConfig = {
  provider: TextModelProvider;
  providerLabel: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  configured: boolean;
  transportAllowed: boolean;
  disabledReason?: "missing_api_key" | "insecure_transport" | "vendor_policy";
  keyVariable: string;
};

const DEFAULT_BAILIAN_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const DEFAULT_QWEN_MODEL = "qwen-plus";
const TEXT_MODEL_HEALTH_TIMEOUT_MS = 120_000;

function cleanBaseUrl(value: string): string {
  return value.trim().replace(/\/$/, "");
}

function isLocalHttpEndpoint(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.protocol === "http:" && /^(localhost|127\.0\.0\.1|::1|\[::1\])$/.test(url.hostname);
  } catch {
    return false;
  }
}

function endpointTransportAllowed(baseUrl: string): boolean {
  if (baseUrl.startsWith("https://")) return true;
  return process.env.NODE_ENV !== "production" && isLocalHttpEndpoint(baseUrl);
}

function firstEnv(names: string[]): { name: string; value: string } {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return { name, value };
  }
  return { name: names[0], value: "" };
}

export function getBailianQwenConfig(): TextModelConfig {
  const key = firstEnv(["BAILIAN_QWEN_API_KEY", "DASHSCOPE_API_KEY", "QWEN_API_KEY"]);
  const baseUrl = firstEnv(["BAILIAN_QWEN_BASE_URL", "DASHSCOPE_BASE_URL", "QWEN_BASE_URL"]);
  const model = firstEnv(["BAILIAN_QWEN_MODEL", "DASHSCOPE_MODEL", "QWEN_MODEL"]);

  const resolvedBaseUrl = cleanBaseUrl(baseUrl.value || DEFAULT_BAILIAN_BASE_URL);
  const transportAllowed = endpointTransportAllowed(resolvedBaseUrl);
  return {
    provider: "bailian-qwen",
    providerLabel: "Alibaba Cloud Bailian Qwen",
    apiKey: key.value,
    baseUrl: resolvedBaseUrl,
    model: model.value || DEFAULT_QWEN_MODEL,
    configured: Boolean(key.value) && transportAllowed,
    transportAllowed,
    disabledReason: !key.value ? "missing_api_key" : !transportAllowed ? "insecure_transport" : undefined,
    keyVariable: key.name,
  };
}

function getOpenAICompatibleConfig(): TextModelConfig {
  const key = firstEnv(["OPENAI_API_KEY"]);
  const baseUrl = firstEnv(["OPENAI_BASE_URL"]);
  const model = firstEnv(["OPENAI_MODEL"]);

  const resolvedBaseUrl = cleanBaseUrl(baseUrl.value || "https://api.deepseek.com");
  const transportAllowed = endpointTransportAllowed(resolvedBaseUrl);
  const resolvedModel = model.value || "deepseek-v4-flash";
  const allowedHosts = new Set([
    "api.deepseek.com",
    ...(process.env.CDSS_DEEPSEEK_ALLOWED_HOSTS || "")
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  ]);
  let deepseekEndpointAllowed = false;
  try {
    deepseekEndpointAllowed = allowedHosts.has(new URL(resolvedBaseUrl).hostname.toLowerCase());
  } catch {
    deepseekEndpointAllowed = false;
  }
  const vendorAllowed = deepseekEndpointAllowed && isDeepseekModel(resolvedModel);
  return {
    provider: "openai-compatible",
    providerLabel: "DeepSeek",
    apiKey: key.value,
    baseUrl: resolvedBaseUrl,
    model: resolvedModel,
    configured: Boolean(key.value) && transportAllowed && vendorAllowed,
    transportAllowed,
    disabledReason: !key.value
      ? "missing_api_key"
      : !transportAllowed
        ? "insecure_transport"
        : !vendorAllowed
          ? "vendor_policy"
          : undefined,
    keyVariable: key.name,
  };
}

export function getPrimaryTextModelConfig(): TextModelConfig {
  const config = getOpenAICompatibleConfig();
  const provider = (process.env.AI_TEXT_PROVIDER || process.env.AI_PROVIDER || "openai-compatible").toLowerCase();
  if (provider === "openai-compatible" || provider === "deepseek") return config;
  return { ...config, configured: false, disabledReason: "vendor_policy" };
}

/**
 * Explicit GOV-08 exception: this is an independent closed-set terminology classifier, not a
 * fallback for M01-M04 clinical generation. Its model identity is separately visible in health.
 */
export function getControlledTerminologyModelConfig(): TextModelConfig {
  const primary = getOpenAICompatibleConfig();
  const model = process.env.CONTROLLED_TERMINOLOGY_MODEL?.trim() || "deepseek-v4-flash";
  const modelAllowed = isDeepseekModel(model);
  return {
    ...primary,
    model,
    configured: primary.configured && modelAllowed,
    disabledReason: !modelAllowed ? "vendor_policy" : primary.disabledReason,
  };
}

export function createTextModelClient(config = getPrimaryTextModelConfig()): OpenAI {
  return new OpenAI({
    apiKey: config.apiKey || "missing-api-key",
    baseURL: config.baseUrl,
  });
}

export function getTextModelMissingMessage(config = getPrimaryTextModelConfig()): string {
  if (config.disabledReason === "vendor_policy") {
    return "文本临床推理仅允许使用已批准的 DeepSeek 模型与端点";
  }
  if (!config.transportAllowed) {
    return `${config.providerLabel} base URL must use HTTPS in production`;
  }
  if (config.provider === "bailian-qwen") {
    return `${config.keyVariable} not configured for Bailian Qwen`;
  }
  return `${config.keyVariable} not configured for DeepSeek`;
}

export function getPublicTextModelStatus(config = getPrimaryTextModelConfig()) {
  return {
    provider: config.providerLabel,
    providerId: config.provider,
    model: config.model,
    configured: config.configured,
    transportAllowed: config.transportAllowed,
    disabledReason: config.disabledReason,
  };
}

export function isDeepseekModel(model: string): boolean {
  return model.toLowerCase().startsWith("deepseek");
}

export async function runTextModelHealthCheck() {
  const config = getPrimaryTextModelConfig();
  const publicStatus = getPublicTextModelStatus(config);
  if (!config.configured) {
    return {
      ok: false,
      ...publicStatus,
      error: getTextModelMissingMessage(config),
    };
  }

  try {
    const client = createTextModelClient(config);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TEXT_MODEL_HEALTH_TIMEOUT_MS);
    let content = "";
    let reasoningReceived = false;
    let finishReason: string | null | undefined;
    try {
      const stream = await client.chat.completions.create({
        model: config.model,
        messages: [
          { role: "system", content: "你是接口健康检查助手，只回复 ok，不要解释。" },
          { role: "user", content: "health check" },
        ],
        max_tokens: 256,
        temperature: 0,
        stream: true,
      }, { signal: controller.signal });
      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        const delta = choice?.delta as { content?: string | null; reasoning_content?: string | null } | undefined;
        if (delta?.content) content += delta.content;
        if (delta?.reasoning_content) reasoningReceived = true;
        if (choice?.finish_reason) finishReason = choice.finish_reason;
      }
    } finally {
      clearTimeout(timeout);
    }
    const sampleReceived = Boolean(content.trim());
    return {
      ok: sampleReceived && Boolean(finishReason),
      ...publicStatus,
      sampleReceived,
      reasoningReceived,
      streamContractOk: sampleReceived && Boolean(finishReason),
      finishReason,
      ...(!sampleReceived && reasoningReceived ? { error: "model health check returned reasoning but no final content" } : {}),
    };
  } catch (error) {
    return {
      ok: false,
      ...publicStatus,
      error: error instanceof Error && /abort|timeout/i.test(error.message)
        ? "model health check timed out"
        : "model health check request failed",
    };
  }
}
