import OpenAI from "openai";

import { textModelCapabilities } from "./text-model-capabilities";
import { observedModelFetch } from "./model-transport-observation";

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
const DEFAULT_QWEN_MODEL = "qwen3.8-flash";
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

function configuredAllowedHosts(): string[] {
  return [process.env.CDSS_TEXT_MODEL_ALLOWED_HOSTS, process.env.CDSS_DEEPSEEK_ALLOWED_HOSTS]
    .flatMap((value) => String(value || "").split(","))
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

function endpointHostAllowed(baseUrl: string, defaultHosts: readonly string[]): boolean {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return new Set([...defaultHosts, ...configuredAllowedHosts()]).has(hostname);
  } catch {
    return false;
  }
}

function modelAllowedForProvider(provider: TextModelProvider, model: string): boolean {
  return provider === "bailian-qwen" ? isQwenModel(model) : isDeepseekModel(model);
}

function sameModelFamily(left: string, right: string): boolean {
  return (isQwenModel(left) && isQwenModel(right)) ||
    (isDeepseekModel(left) && isDeepseekModel(right));
}

export function getBailianQwenConfig(): TextModelConfig {
  const key = firstEnv(["BAILIAN_QWEN_API_KEY", "DASHSCOPE_API_KEY", "QWEN_API_KEY"]);
  const baseUrl = firstEnv(["BAILIAN_QWEN_BASE_URL", "DASHSCOPE_BASE_URL", "QWEN_BASE_URL"]);
  const model = firstEnv(["BAILIAN_QWEN_MODEL", "DASHSCOPE_MODEL", "QWEN_MODEL"]);

  const resolvedBaseUrl = cleanBaseUrl(baseUrl.value || DEFAULT_BAILIAN_BASE_URL);
  const transportAllowed = endpointTransportAllowed(resolvedBaseUrl);
  const resolvedModel = model.value || DEFAULT_QWEN_MODEL;
  const vendorAllowed = endpointHostAllowed(resolvedBaseUrl, ["dashscope.aliyuncs.com"]) &&
    modelAllowedForProvider("bailian-qwen", resolvedModel);
  return {
    provider: "bailian-qwen",
    providerLabel: "Alibaba Cloud Bailian Qwen",
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

function getOpenAICompatibleConfig(): TextModelConfig {
  const key = firstEnv(["OPENAI_API_KEY"]);
  const baseUrl = firstEnv(["OPENAI_BASE_URL"]);
  const model = firstEnv(["OPENAI_MODEL"]);

  const resolvedBaseUrl = cleanBaseUrl(baseUrl.value || "https://api.deepseek.com");
  const transportAllowed = endpointTransportAllowed(resolvedBaseUrl);
  const resolvedModel = model.value || "deepseek-v4-flash";
  // `openai-compatible` describes the wire protocol, not a vendor identity. Keep model and endpoint
  // paired so a Qwen model can use the approved DashScope endpoint without weakening the host gate,
  // while a DeepSeek model remains confined to its own approved endpoint family.
  const qwenCompatible = isQwenModel(resolvedModel) &&
    endpointHostAllowed(resolvedBaseUrl, ["dashscope.aliyuncs.com"]);
  const deepseekCompatible = isDeepseekModel(resolvedModel) &&
    endpointHostAllowed(resolvedBaseUrl, ["api.deepseek.com"]);
  const vendorAllowed = qwenCompatible || deepseekCompatible;
  return {
    provider: "openai-compatible",
    providerLabel: qwenCompatible ? "OpenAI-compatible Qwen" : "DeepSeek",
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
  const provider = (process.env.AI_TEXT_PROVIDER || process.env.AI_PROVIDER || "openai-compatible").toLowerCase();
  if (provider === "openai-compatible" || provider === "deepseek") return getOpenAICompatibleConfig();
  if (provider === "bailian-qwen" || provider === "bailian" || provider === "qwen") return getBailianQwenConfig();
  const config = getOpenAICompatibleConfig();
  return { ...config, configured: false, disabledReason: "vendor_policy" };
}

/**
 * 按**模型家族**解析出该模型真正可用的端点与密钥。
 *
 * 在此之前，每个 per-stage 模型变量都直接套用主 provider 的端点与密钥，只换模型名：
 * 主 provider 是百炼时把 `deepseek-flash` 填进 `CONTROLLED_TERMINOLOGY_MODEL`，请求会带着
 * DeepSeek 的模型名打到 dashscope，100% 失败；辅助任务失败都是静默 fail-open 到确定性结果，
 * 于是「配错了」和「模型没意见」长得一模一样。
 *
 * 需要这条路径的理由是延迟：主生成必须留在 Qwen（严格 JSON Schema 是 2026-09-19 换回 Qwen 的
 * 全部理由，DeepSeek 的 json_object 不执行 schema），但小任务只用 json_object，而 DeepSeek
 * 的出字速度实测是 qwen3.8-flash 的 2–3 倍（线上账本：185–227 tok/s vs 65–95）。
 *
 * 边界：目标家族没配齐（缺 key / 非 HTTPS / 端点不在白名单）时 **fail-closed**——返回
 * configured=false，调用方按既有分支退回确定性结果，绝不偷偷改用另一个家族的模型顶包。
 */
export function textModelConfigForModel(model: string): TextModelConfig {
  const primary = getPrimaryTextModelConfig();
  const requested = model.trim();
  if (!requested || !isApprovedTextModel(requested)) {
    return { ...primary, model: requested || primary.model, configured: false, disabledReason: "vendor_policy" };
  }
  if (sameModelFamily(primary.model, requested)) return { ...primary, model: requested };
  const wantsQwen = isQwenModel(requested);
  const alternate = wantsQwen ? getBailianQwenConfig() : getOpenAICompatibleConfig();
  const vendorAllowed = endpointHostAllowed(
    alternate.baseUrl,
    wantsQwen ? ["dashscope.aliyuncs.com"] : ["api.deepseek.com"],
  );
  const usable = Boolean(alternate.apiKey) && alternate.transportAllowed && vendorAllowed;
  return {
    ...alternate,
    providerLabel: wantsQwen ? "Alibaba Cloud Bailian Qwen" : "DeepSeek",
    model: requested,
    configured: usable,
    disabledReason: usable
      ? undefined
      : !alternate.apiKey
        ? "missing_api_key"
        : !alternate.transportAllowed
          ? "insecure_transport"
          : "vendor_policy",
  };
}

/**
 * Explicit GOV-08 exception: this is an independent closed-set terminology classifier, not a
 * fallback for M01-M04 clinical generation. Its model identity is separately visible in health.
 * 该变量同时驱动术语归一、证候重排、方名召回归一、极性助手与 M05 作文这五个小任务。
 */
export function getControlledTerminologyModelConfig(): TextModelConfig {
  const model = process.env.CONTROLLED_TERMINOLOGY_MODEL?.trim();
  if (!model) return getPrimaryTextModelConfig();
  return textModelConfigForModel(model);
}

/** Application recovery owns the whole retry budget when selected; other callers retain SDK recovery. */
export function createTextModelClient(
  config = getPrimaryTextModelConfig(),
  options: { retryOwner?: "sdk" | "application" } = {},
): OpenAI {
  return new OpenAI({
    apiKey: config.apiKey || "missing-api-key",
    baseURL: config.baseUrl,
    maxRetries: options.retryOwner === "application" ? 0 : 2,
    fetch: observedModelFetch,
  });
}

export function getTextModelMissingMessage(config = getPrimaryTextModelConfig()): string {
  if (config.disabledReason === "vendor_policy") {
    return "文本临床推理仅允许使用已批准的模型与端点";
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

export function isQwenModel(model: string): boolean {
  return model.trim().toLowerCase().startsWith("qwen");
}

export function isApprovedTextModel(model: string): boolean {
  return isDeepseekModel(model) || isQwenModel(model);
}

export function textModelRequestTuning(
  model: string,
  options: { reasoningEffort?: string; thinkingEnabled?: boolean },
): Record<string, unknown> {
  const thinkingEnabled = options.thinkingEnabled ?? false;
  if (isDeepseekModel(model)) {
    return {
      ...(options.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {}),
      thinking: { type: thinkingEnabled ? "enabled" : "disabled" },
    };
  }
  if (isQwenModel(model)) {
    if (!thinkingEnabled) return { enable_thinking: false };
    const effort = String(options.reasoningEffort || "medium").trim().toLowerCase();
    if (textModelCapabilities(model).qwenThinkingControl === "reasoning_effort") {
      const reasoningEffort = effort === "low" ? "low" : effort === "medium" ? "medium" : "xhigh";
      return { enable_thinking: true, reasoning_effort: reasoningEffort };
    }
    const thinkingBudget = effort === "low"
      ? 2_048
      : effort === "high"
        ? 8_192
        : effort === "xhigh" || effort === "max"
          ? 16_384
          : 4_096;
    return { enable_thinking: true, thinking_budget: thinkingBudget };
  }
  return {};
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
        stream_options: { include_usage: true },
        ...textModelRequestTuning(config.model, { thinkingEnabled: false }),
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
