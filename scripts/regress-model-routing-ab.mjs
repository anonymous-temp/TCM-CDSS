/**
 * Optional synthetic microbenchmark, never production model configuration mutation.
 * node scripts/regress-model-routing-ab.mjs --dry-run (default, no network)
 * node scripts/regress-model-routing-ab.mjs --fixture (no network)
 * node scripts/regress-model-routing-ab.mjs --live (uses injected runtime env; does not read .env)
 * Measures one bounded provider request per arm. This is not the full M03/M04 clinical pipeline.
 */
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti";

const schema = {
  type: "object", additionalProperties: false,
  properties: { summary: { type: "string" }, uncertainty: { type: "array", items: { type: "string" } }, advice: { type: "array", items: { type: "string" } } },
  required: ["summary", "uncertainty", "advice"],
};
export const syntheticRoutingCases = [
  { id: "synthetic-m03", synthetic: true, task: "diagnose", models: ["qwen3.8-flash", "qwen3.7-plus"], prompt: "合成基准病例，无真实患者：40岁成年人，间歇胃部不适，病程2周，生命体征平稳；其余情况未知。给出非确诊性质的鉴别建议，说明缺失信息。不得新增事实或文献。只输出指定JSON。" },
  { id: "synthetic-m04", synthetic: true, task: "prescribe", models: ["qwen3.7-plus", "qwen3.8-max"], prompt: "合成基准病例，无真实患者：40岁成年人，间歇胃部不适，尚未完成辨证，过敏史与用药史未知。提供需要核实的信息和非剂量随访建议。不得生成具体方药、剂量或文献。只输出指定JSON。" },
];

/** invoke is injectable for deterministic offline verification and controlled runtime replay. */
export async function runModelRoutingAb({ cases, invoke }) {
  if (!Array.isArray(cases) || cases.length > 20 || cases.some((item) => item.synthetic !== true || !Array.isArray(item.models) || item.models.length !== 2)) {
    throw new Error("A/B replay requires at most 20 explicitly synthetic paired cases");
  }
  const rows = [];
  for (const item of cases) {
    for (const model of item.models) {
      const started = performance.now();
      const base = { caseId: item.id, task: item.task, model, clinicalQuality: "not_evaluated" };
      try {
        const completion = await invoke({ model, task: item.task, prompt: item.prompt, schema });
        const text = completion.choices?.[0]?.message?.content ?? "";
        let parsed;
        try { parsed = JSON.parse(text); } catch { parsed = null; }
        const shapeValid = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
          && Object.keys(parsed).length === 3 && typeof parsed.summary === "string"
          && [parsed.uncertainty, parsed.advice].every((field) => Array.isArray(field) && field.every((entry) => typeof entry === "string"));
        const usage = completion.usage;
        const usageAvailable = [usage?.prompt_tokens, usage?.completion_tokens, usage?.total_tokens].every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0);
        rows.push({ ...base, outcome: "ok", durationMs: Math.round(performance.now() - started), shapeValid, answerExcerpt: text.slice(0, 240), usageAvailable,
          tokens: usageAvailable ? { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens, totalTokens: usage.total_tokens } : null });
      } catch {
        // Provider exceptions can contain the complete request, endpoint credentials or text.
        rows.push({ ...base, outcome: "error", durationMs: Math.round(performance.now() - started), shapeValid: false, usageAvailable: false, tokens: null, issueCode: "model_request_failed" });
      }
    }
  }
  return rows;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some((arg) => !["--dry-run", "--fixture", "--live"].includes(arg))) throw new Error("Use exactly one of --dry-run, --fixture, --live");
  const mode = args[0] ?? "--dry-run";
  if (mode === "--dry-run") {
    console.log(JSON.stringify({ mode, networkCalls: 0, plannedCalls: 4, cases: syntheticRoutingCases.map(({ id, task, models }) => ({ id, task, models })), clinicalQuality: "not_evaluated" }, null, 2));
    return;
  }
  let invoke;
  if (mode === "--fixture") {
    invoke = async () => ({ choices: [{ message: { content: JSON.stringify({ summary: "合成夹具", uncertainty: ["未知信息"], advice: ["建议进一步核实"] }) } }] });
  } else {
    const jiti = createJiti(import.meta.url);
    const { getPrimaryTextModelConfig, createTextModelClient, isQwenModel, textModelRequestTuning } = jiti("../src/lib/text-model.ts");
    const config = getPrimaryTextModelConfig();
    if (!config.configured || !isQwenModel(config.model)) throw new Error("Live Qwen A/B requires an already configured approved Qwen provider in runtime env");
    // No SDK retries: compare one physical attempt per arm, with equal timeout and output budgets.
    const client = createTextModelClient(config, { retryOwner: "application" });
    invoke = ({ model, prompt, schema: responseSchema }) => client.chat.completions.create({
      model, messages: [{ role: "user", content: prompt }], temperature: 0, max_tokens: 1_200,
      response_format: { type: "json_schema", json_schema: { name: "synthetic_routing_ab", strict: true, schema: responseSchema } },
      ...textModelRequestTuning(model, { thinkingEnabled: false }),
    }, { signal: AbortSignal.timeout(45_000) });
  }
  const rows = await runModelRoutingAb({ cases: syntheticRoutingCases, invoke });
  console.log(JSON.stringify({ mode, scope: "synthetic_provider_microbenchmark", clinicalQuality: "not_evaluated", rows }, null, 2));
  if (rows.some((row) => row.outcome !== "ok" || !row.shapeValid)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error("Routing A/B failed: check mode and approved runtime provider configuration"); process.exitCode = 1; });
}
