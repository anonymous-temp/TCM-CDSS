/** Actual public M03 template/schema cache comparison. Does not change production configuration. */
import { createJiti } from "jiti";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { runCacheBenchmark } from "./lib/cache-benchmark.mjs";
import { experienceCases, experienceCaseState } from "./lib/experience-fixtures.mjs";

if (!process.argv.includes("--live")) {
  console.log(JSON.stringify({ mode: "dry-run", plannedCalls: 8, scope: "same_layout_cache_comparison", clinicalQuality: "not_evaluated" }));
  process.exit(0);
}
const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
const { createInitialCaseState } = await jiti.import("../src/lib/diagnosis-types.ts");
const { buildDiagnosePrompt } = await jiti.import("../src/lib/diagnosis-prompts.ts");
const { explicitPromptCacheMessages } = await jiti.import("../src/lib/model-prompt-cache.ts");
const { getPrimaryTextModelConfig, createTextModelClient, textModelRequestTuning } = await jiti.import("../src/lib/text-model.ts");
const { responseFormatForTask } = await jiti.import("../src/lib/model-response-format.ts");
const config = getPrimaryTextModelConfig();
if (!config.configured || config.provider !== "bailian-qwen") throw new Error("Inject the approved Bailian runtime configuration");
const models = (process.env.CACHE_BENCH_MODELS || "qwen3.8-flash,qwen3.7-plus").split(",").map(x => x.trim());
if (models.length > 2 || models.some(model => !["qwen3.8-flash", "qwen3.7-plus"].includes(model))) throw new Error("Use only the approved Flash/Plus benchmark models");
const initial = createInitialCaseState();
const state = { ...initial, ...experienceCaseState(experienceCases[1], "synthetic-cache") };
// A public experiment nonce avoids accidentally measuring a template primed by an earlier run.
// It is identical across both cache modes and is not a patient fact.
const system = `你是临床辅助建议助手。本次为合成测试，无真实患者。实验标识${randomUUID()}不属于患者事实，不要写进临床结果。`;
process.env.CDSS_EXPLICIT_PROMPT_CACHE = "true";
const prompt = buildDiagnosePrompt(state);
const client = createTextModelClient(config, { retryOwner: "application" });
const rows = await runCacheBenchmark({
  models, messagesForModel: model => explicitPromptCacheMessages(system, prompt, { ...config, model }),
  invoke: async ({ model, messages }) => {
    const started = performance.now();
    let firstTokenMs = null, content = "", finishReason = null, usage;
    const stream = await client.chat.completions.create({ model, messages, stream: true, stream_options: { include_usage: true },
      temperature: 0, response_format: responseFormatForTask(model, "m03_tcm"), ...textModelRequestTuning(model, { thinkingEnabled: false }),
    }, { signal: AbortSignal.timeout(90_000) });
    for await (const chunk of stream) {
      const choice = chunk.choices?.[0];
      if (choice?.delta?.content) { firstTokenMs ??= Math.round(performance.now() - started); content += choice.delta.content; }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (chunk.usage) usage = chunk.usage;
    }
    return { content, usage, finishReason, firstTokenMs, durationMs: Math.round(performance.now() - started) };
  }, onProgress: row => console.log(JSON.stringify({ event: "cache_sample", ...row })),
});
const report = { checkedAt: new Date().toISOString(), scope: "same_layout_actual_m03_template_cache", clinicalQuality: "not_evaluated",
  note: "Round1 is not assumed cold: use observed hit/creation counters. Model caches are isolated. No production config was changed.", rows };
if (process.env.CACHE_BENCH_OUTPUT) {
  await mkdir(dirname(process.env.CACHE_BENCH_OUTPUT), { recursive: true });
  await writeFile(process.env.CACHE_BENCH_OUTPUT, JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ event: "complete", ...report }));
if (rows.some(row => row.outcome !== "ok" || !row.jsonObject || row.finishReason !== "stop")) process.exitCode = 1;
