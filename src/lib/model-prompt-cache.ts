/** Public template prefixes only. Never retain a complete prompt, patient data or response. */
const publicPrefixes = new Map<string, string>();
const invalidPrefixes = new Set<string>();
const MAX_PUBLIC_TEMPLATES = 16;

export function explicitPromptCacheEnabled(): boolean {
  return process.env.CDSS_EXPLICIT_PROMPT_CACHE === "true";
}

/** Call only at a source-code template boundary before the first case-dependent interpolation. */
export function buildPromptWithPublicPrefix(template: string, publicPrefix: string, caseSuffix: string): string {
  if (!invalidPrefixes.has(template)) {
    const previous = publicPrefixes.get(template);
    if (previous !== undefined && previous !== publicPrefix) {
      // A supposedly fixed template changed within this process: disable its optimization only.
      publicPrefixes.delete(template);
      invalidPrefixes.add(template);
    } else if (publicPrefix && publicPrefixes.size + invalidPrefixes.size < MAX_PUBLIC_TEMPLATES) {
      publicPrefixes.set(template, publicPrefix);
    }
  }
  return publicPrefix + caseSuffix;
}

type CacheTextPart = { type: "text"; text: string; cache_control?: { type: "ephemeral" } };
type PromptMessage = { role: "system" | "user"; content: string | CacheTextPart[] };

// Documented text models used by this application; no inferred version suffixes or VL/Coder SKUs.
// https://help.aliyun.com/zh/model-studio/context-cache (verified 2026-09-07)
const EXPLICIT_CACHE_MODELS = new Set([
  "qwen3.8-max", "qwen3.8-max-0902", "qwen3.7-max", "qwen3.7-max-2026-05-20", "qwen3.7-max-2026-06-08",
  "qwen3.6-max-preview", "qwen3-max", "qwen3.7-plus", "qwen3.7-plus-2026-05-26", "qwen3.6-plus",
  "qwen3.5-plus", "qwen3.5-plus-2026-04-20", "qwen-plus", "qwen3.8-flash", "qwen3.7-flash",
  "qwen3.7-flash-2026-07-15", "qwen3.6-flash", "qwen3.5-flash", "qwen-flash",
]);

/** Bailian OpenAI-compatible explicit cache; provider decides support, threshold, TTL and hits. */
export function explicitPromptCacheMessages(
  systemPrompt: string,
  prompt: string,
  config: { provider: string; model: string },
): PromptMessage[] {
  const unchanged: PromptMessage[] = [{ role: "system", content: systemPrompt }, { role: "user", content: prompt }];
  if (!explicitPromptCacheEnabled() || config.provider !== "bailian-qwen" || !EXPLICIT_CACHE_MODELS.has(config.model)) return unchanged;
  // Match only prefixes registered by builders, never a marker found in arbitrary clinical text.
  const prefix = [...publicPrefixes.values()].filter((item) => prompt.startsWith(item))
    .sort((a, b) => b.length - a.length)[0];
  if (!prefix || prefix.length === prompt.length) return unchanged;
  // Qwen3.5+ caches at whole-message boundaries, not inside a message's content array.
  // Move ONLY the source-owned public instructions to the existing system message; every
  // patient byte remains in the following user message. The marker is the final system block.
  // https://help.aliyun.com/zh/model-studio/explicit-cache-guide
  return [
    { role: "system", content: [
      { type: "text", text: systemPrompt },
      { type: "text", text: prefix, cache_control: { type: "ephemeral" } },
    ] },
    { role: "user", content: prompt.slice(prefix.length) },
  ];
}
