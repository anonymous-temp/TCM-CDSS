export function withoutCacheMarkers(messages) {
  return structuredClone(messages).map(message => {
    if (Array.isArray(message.content)) for (const part of message.content) delete part.cache_control;
    return message;
  });
}

/** Same message layout in both arms; only the cache marker changes. No retries or warm-up calls. */
export async function runCacheBenchmark({ models, messagesForModel, invoke, onProgress = () => {} }) {
  const rows = [];
  const number = value => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  for (const model of models) {
    const explicit = messagesForModel(model);
    if (!explicit.some(message => Array.isArray(message.content) && message.content.some(part => part.cache_control))) {
      throw new Error("Benchmark requires an actual public cache boundary");
    }
    for (const mode of ["implicit_same_layout", "explicit"]) for (const round of [1, 2]) {
      const started = performance.now();
      let row;
      try {
        const sample = await invoke({ model, messages: mode === "explicit" ? structuredClone(explicit) : withoutCacheMarkers(explicit) });
        let parsed;
        try { parsed = JSON.parse(sample.content); } catch { parsed = null; }
        const usage = sample.usage;
        row = { model, mode, round, outcome: "ok", durationMs: sample.durationMs, firstTokenMs: sample.firstTokenMs ?? null,
          finishReason: sample.finishReason ?? null, jsonObject: Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed)),
          outputChars: sample.content?.length ?? 0,
          promptTokens: number(usage?.prompt_tokens), completionTokens: number(usage?.completion_tokens),
          cachedTokens: number(usage?.prompt_tokens_details?.cached_tokens),
          cacheCreationInputTokens: number(usage?.prompt_tokens_details?.cache_creation_input_tokens),
          reasoningTokens: number(usage?.completion_tokens_details?.reasoning_tokens),
        };
      } catch {
        row = { model, mode, round, outcome: "error", durationMs: Math.round(performance.now() - started), issueCode: "provider_request_failed" };
      }
      rows.push(row); onProgress(row);
    }
  }
  return rows;
}
