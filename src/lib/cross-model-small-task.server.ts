import "server-only";

import { memoizedSmallTask, smallTaskMemoKey } from "./small-task-memo.server";
import { createTextModelClient, getControlledTerminologyModelConfig, textModelConfigForModel, textModelRequestTuning } from "./text-model";
import { observeModelTask } from "./cdss-model-task-telemetry";

const CROSS_CHECK_MODEL = () => process.env.PRIMARY_STRUCTURED_FALLBACK_MODEL?.trim() || "qwen3.8-flash";

type Messages = Array<{ role: "system" | "user"; content: string }>;

async function runOne<T>(
  namespace: string,
  stage: "diagnose" | "prescribe",
  config: ReturnType<typeof getControlledTerminologyModelConfig>,
  messages: Messages,
  maxTokens: number,
  timeoutMs: number,
  parse: (content: unknown) => T | undefined,
  signal?: AbortSignal,
): Promise<T | undefined> {
  if (signal?.aborted || !config.configured) return undefined;
  return memoizedSmallTask<T | undefined>(namespace, smallTaskMemoKey([config.model, messages]), async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await observeModelTask({ task: namespace, stage, model: config.model }, () => createTextModelClient(config).chat.completions.create({
        model: config.model,
        temperature: 0,
        max_tokens: maxTokens,
        stream: false,
        response_format: { type: "json_object" },
        ...textModelRequestTuning(config.model, { reasoningEffort: "low", thinkingEnabled: false }),
        messages,
      }, { signal: controller.signal }));
      const value = parse(response.choices[0]?.message?.content);
      return { value, cacheable: value !== undefined };
    } catch {
      return { value: undefined, cacheable: false };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }, undefined, signal);
}

/**
 * 同一个窄问题问两个不同厂商的模型（deepseek-flash 与 qwen3.8-flash），两个都答出来才返回。
 * 自己核对自己容易认同自己，跨模型核对更可靠；调用方只采信两边都指向同一处的结论，任一边失败就按没有结论处理（原样交付）。
 */
export async function crossModelJsonTask<T>(
  namespace: string,
  stage: "diagnose" | "prescribe",
  messages: Messages,
  options: { maxTokens: number; timeoutMs: number },
  parse: (content: unknown) => T | undefined,
  signal?: AbortSignal,
): Promise<[T, T] | undefined> {
  const [first, second] = await Promise.all([
    runOne(namespace, stage, getControlledTerminologyModelConfig(), messages, options.maxTokens, options.timeoutMs, parse, signal),
    runOne(namespace, stage, textModelConfigForModel(CROSS_CHECK_MODEL()), messages, options.maxTokens, options.timeoutMs, parse, signal),
  ]);
  return first !== undefined && second !== undefined ? [first, second] : undefined;
}

/**
 * 先提名、后复核：deepseek-flash 自由提名，qwen3.8-flash 只对这一条具体说法答对错。
 * 两个模型各自自由作答再取一致，等于把两次抽样相乘，真问题也常被其中一次漏掉（2026-10-31 实测：风寒袭肺证痰多，一个答「化痰」、一个答没有；
 * 暑湿例「湿重于热」同样只有一边说）；把提名指给第二个模型再问，是「指出位置后再核对」，比让它自己再找一遍稳。提名为空时不发第二个请求。
 */
export async function proposeThenVerify<P>(
  namespace: string,
  stage: "diagnose" | "prescribe",
  propose: { messages: Messages; maxTokens: number; parse: (content: unknown) => P | undefined },
  verify: (proposal: NonNullable<P>) => { messages: Messages; maxTokens: number; parse: (content: unknown) => boolean | undefined } | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<NonNullable<P> | undefined> {
  const proposal = await runOne(namespace, stage, getControlledTerminologyModelConfig(), propose.messages, propose.maxTokens, timeoutMs, propose.parse, signal);
  if (proposal === undefined || proposal === null) return undefined;
  const request = verify(proposal as NonNullable<P>);
  if (!request) return undefined;
  const verdict = await runOne(`${namespace}_verify`, stage, textModelConfigForModel(CROSS_CHECK_MODEL()), request.messages, request.maxTokens, timeoutMs, request.parse, signal);
  return verdict === true ? proposal as NonNullable<P> : undefined;
}

/** 提名是一张排了序的清单时：合格的几项同时问复核，取排在最前、复核说对的一项。 */
export async function proposeThenVerifyFirst<P>(
  namespace: string,
  stage: "diagnose" | "prescribe",
  propose: { messages: Messages; maxTokens: number; parse: (content: unknown) => P[] | undefined },
  verify: (proposal: P) => { messages: Messages; maxTokens: number; parse: (content: unknown) => boolean | undefined } | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<P | undefined> {
  const proposals = await runOne(namespace, stage, getControlledTerminologyModelConfig(), propose.messages, propose.maxTokens, timeoutMs, propose.parse, signal);
  if (!proposals || proposals.length === 0) return undefined;
  const verdicts = await Promise.all(proposals.map((proposal) => {
    const request = verify(proposal);
    return request
      ? runOne(`${namespace}_verify`, stage, textModelConfigForModel(CROSS_CHECK_MODEL()), request.messages, request.maxTokens, timeoutMs, request.parse, signal)
      : Promise.resolve(undefined);
  }));
  const at = verdicts.findIndex((verdict) => verdict === true);
  return at >= 0 ? proposals[at] : undefined;
}

/** 复核答案里的 yes/no：{"confirmed":true|false}。 */
export function parseConfirmed(content: unknown): boolean | undefined {
  if (typeof content !== "string" || !content.trim()) return undefined;
  try {
    const value = (JSON.parse(content) as { confirmed?: unknown })?.confirmed;
    return typeof value === "boolean" ? value : undefined;
  } catch {
    return undefined;
  }
}
