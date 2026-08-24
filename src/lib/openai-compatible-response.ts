type CompatChunk = {
  usage?: CompatUsage;
  choices?: Array<{
    delta?: { content?: string | null; reasoning_content?: string | null };
    message?: { content?: string | null; reasoning_content?: string | null };
    finish_reason?: string | null;
  }>;
};

export type CompatUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
};

export type CompatCompletion = {
  choices?: Array<{
    message?: { content?: string | null; reasoning_content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: CompatUsage;
};

export type ModelUsageSnapshot = Readonly<{
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
}>;

export function modelUsageSnapshot(value: unknown): ModelUsageSnapshot | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = "usage" in value ? (value as { usage?: unknown }).usage : value;
  if (!usage || typeof usage !== "object") return undefined;
  const number = (field: unknown) => typeof field === "number" && Number.isFinite(field) && field >= 0
    ? Math.trunc(field)
    : 0;
  const details = (usage as CompatUsage).prompt_tokens_details;
  const snapshot = {
    promptTokens: number((usage as CompatUsage).prompt_tokens),
    completionTokens: number((usage as CompatUsage).completion_tokens),
    totalTokens: number((usage as CompatUsage).total_tokens),
    cachedTokens: number(details?.cached_tokens),
  };
  return snapshot.promptTokens || snapshot.completionTokens || snapshot.totalTokens || snapshot.cachedTokens
    ? snapshot
    : undefined;
}

export function parseOpenAICompatCompletionPayload(raw: string): CompatCompletion | null {
  try {
    const parsed = JSON.parse(raw) as CompatCompletion;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    // Some OpenAI-compatible gateways emit SSE frames even when stream=false.
  }
  let content = "";
  let reasoningContent = "";
  let finishReason: string | null = null;
  let usage: CompatUsage | undefined;
  let sawData = false;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const chunk = JSON.parse(payload) as CompatChunk;
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      sawData = true;
      content += choice.delta?.content || choice.message?.content || "";
      reasoningContent += choice.delta?.reasoning_content || choice.message?.reasoning_content || "";
      if (choice.finish_reason != null) finishReason = choice.finish_reason;
    } catch {
      return null;
    }
  }
  return sawData && content
    ? {
        choices: [{ message: { content, reasoning_content: reasoningContent || null }, finish_reason: finishReason }],
        ...(usage ? { usage } : {}),
      }
    : null;
}
