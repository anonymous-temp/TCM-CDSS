import assert from "node:assert/strict";
import { runCacheBenchmark, withoutCacheMarkers } from "./lib/cache-benchmark.mjs";
const messages = [{ role: "system", content: [{ type: "text", text: "public", cache_control: { type: "ephemeral" } }] }, { role: "user", content: "synthetic case" }];
const implicit = withoutCacheMarkers(messages);
assert.equal(implicit[0].content[0].cache_control, undefined);
assert.ok(messages[0].content[0].cache_control);
assert.deepEqual(implicit.map(x => x.role), messages.map(x => x.role));
const seen = [];
const rows = await runCacheBenchmark({ models: ["qwen3.8-flash"], messagesForModel: () => messages,
  invoke: async request => { seen.push(request); return { content: "{}", durationMs: 2, firstTokenMs: 1, finishReason: "stop",
    usage: { prompt_tokens: 100, completion_tokens: 2, total_tokens: 102, prompt_tokens_details: { cached_tokens: 0, cache_creation_input_tokens: 0 } } }; } });
assert.equal(rows.length, 4);
assert.deepEqual(seen[0].messages, withoutCacheMarkers(seen[2].messages));
assert.ok(rows.every(x => x.cacheCreationInputTokens === 0 && x.cachedTokens === 0));
const missing = await runCacheBenchmark({ models: ["qwen3.8-flash"], messagesForModel: () => messages,
  invoke: async () => ({ content: "{}", durationMs: 2, finishReason: "stop" }) });
assert.ok(missing.every(x => x.cachedTokens === null && x.cacheCreationInputTokens === null && x.reasoningTokens === null));
const failed = await runCacheBenchmark({ models: ["qwen3.8-flash"], messagesForModel: () => messages, invoke: async () => { throw new Error("secret-provider-request"); } });
assert.ok(failed.every(x => x.outcome === "error"));
assert.ok(!JSON.stringify(failed).includes("secret-provider-request"));
console.log(JSON.stringify({ suite: "cache-benchmark", checks: 9, failures: 0 }));
