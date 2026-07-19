import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

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

export type RefineSearchQueryResult =
  | { ok: true; query: string; provider: ReturnType<typeof getPublicTextModelStatus> }
  | { ok: false; response: Response };

export async function refineEvidenceSearchQueryWithModel(opts: {
  agentId: string;
  userInput: string;
  templatedQuery: string;
}): Promise<RefineSearchQueryResult> {
  const config = getPrimaryTextModelConfig();
  if (!config.configured) {
    return {
      ok: false,
      response: Response.json({ error: getTextModelMissingMessage(config) }, { status: 500 }),
    };
  }

  const client = createTextModelClient(config);
  const messages: ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: [
        "你是中医临床证据检索式改写助手。",
        "请把用户问题改写为适合医学证据检索的中文查询词。",
        "只输出一行检索 query，不要解释，不要编号，不要 Markdown。",
        "保留疾病、症状、中医治疗、方药、穴位/经络、研究对象和结局指标。",
        "不得生成不存在的文献、指南或数据库结果。",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `功能模块：${opts.agentId}`,
        `用户原始问题：${opts.userInput}`,
        `已有模板检索式：${opts.templatedQuery}`,
        "请输出最终检索 query。",
      ].join("\n"),
    },
  ];

  try {
    const completion = await client.chat.completions.create({
      model: config.model,
      messages,
      temperature: 0.2,
      max_tokens: 180,
      stream: false,
    });
    const query = completion.choices[0]?.message?.content?.trim().replace(/^["'“”]+|["'“”]+$/g, "");
    if (!query) {
      return {
        ok: false,
        response: Response.json({ error: "DeepSeek returned empty search query" }, { status: 502 }),
      };
    }
    return {
      ok: true,
      query: query.slice(0, 1800),
      provider: getPublicTextModelStatus(config),
    };
  } catch {
    return {
      ok: false,
      response: Response.json({ error: "DeepSeek search query refinement failed" }, { status: 502 }),
    };
  }
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
