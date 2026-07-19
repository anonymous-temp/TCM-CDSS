type CompatChunk = {
  choices?: Array<{
    delta?: { content?: string | null; reasoning_content?: string | null };
    message?: { content?: string | null; reasoning_content?: string | null };
    finish_reason?: string | null;
  }>;
};

export type CompatCompletion = {
  choices?: Array<{
    message?: { content?: string | null; reasoning_content?: string | null };
    finish_reason?: string | null;
  }>;
};

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
  let sawData = false;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const chunk = JSON.parse(payload) as CompatChunk;
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
    ? { choices: [{ message: { content, reasoning_content: reasoningContent || null }, finish_reason: finishReason }] }
    : null;
}
