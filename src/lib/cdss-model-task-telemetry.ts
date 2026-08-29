/**
 * 全流水线模型调用账本（P0）。
 *
 * 立项原因（2026-08-29 token 审计）：`recordModelUsage` 只挂在 diagnosis-api 的 M03/M04 主链上，
 * 而全仓有 11 个模块各自直连 `chat.completions.create`（M02 出题复核 / M02 答案解释 / 临床事实
 * 三相位 / 受控术语 / 极性 / 证候重排 / 方剂召回 / 药味规划 / 用药事件抽取 / M05 作文），它们的
 * token 一分钱没记过。生产实测因此只能算出「调用次数上限」，算不出真实成本——一条病例链在事实
 * 回补 TTL 全失效时最坏 12 次 ~10k token 的调用完全不可见。
 *
 * 该模块是这些调用的唯一记账口：`observeModelTask()` 包住任意返回体带 `usage` 的 Promise
 * （OpenAI SDK 客户端与裸 fetch 两种形态都覆盖），计时、抽取 usage、落聚合与结构化日志。
 *
 * 只落配置值、词表化的原因码、token 计数与时延——**任何患者内容、prompt 正文、模型输出都不落**。
 */

import { modelUsageSnapshot } from "./openai-compatible-response";

export type ModelTaskOutcome = "ok" | "error" | "aborted";

export type ModelTaskMeta = Readonly<{
  /** 任务标识（词表化，见 MAX_DISTINCT_KEYS 折叠）：m03_tcm / clinical_facts_extract / … */
  task: string;
  /** 归属阶段；横切任务用 "shared"。 */
  stage?: string;
  model: string;
  provider?: string;
  /** 同一逻辑任务内的第几次尝试（修复轮 / 共识腿 / 传输重试），从 1 起。 */
  attempt?: number;
  /**
   * 争议/修复原因码。M03/M04 的 issueCode 之所以必须落到这里：3/5 例触发 M04 整份重生成，
   * 而 stage_result 不带 issue code，长尾至今无法归因——降低触发率比加速修复值钱得多。
   */
  issueCode?: string;
  /** 提示词字符数。与 promptTokens 一起用来判断某个块该不该进显式缓存。 */
  promptChars?: number;
}>;

export type ModelTaskTelemetryEvent = ModelTaskMeta & Readonly<{
  outcome: ModelTaskOutcome;
  durationMs: number;
  /** 流式调用的首 token 时延；非流式为 undefined（不可观测，不猜）。 */
  firstTokenMs?: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  totalTokens: number;
}>;

type TaskAggregate = {
  total: number;
  outcomes: Record<ModelTaskOutcome, number>;
  durationMsTotal: number;
  recentDurationsMs: number[];
  recentFirstTokenMs: number[];
  promptTokensTotal: number;
  completionTokensTotal: number;
  cachedTokensTotal: number;
  promptCharsTotal: number;
  attemptTotal: number;
  /** 尝试次数 > 1 的调用数：共识腿 / 修复轮 / 传输重试的真实发生率。 */
  retried: number;
  issueCodes: Record<string, number>;
  models: Record<string, number>;
};

type ModelTaskStore = {
  startedAt: string;
  updatedAt: string;
  tasks: Record<string, TaskAggregate>;
};

const MODEL_TASK_STORE = Symbol.for("tcm-cdss.model-task-telemetry.v1");
const MAX_DISTINCT_KEYS = 96;
const RECENT_SAMPLE_LIMIT = 300;

function nullProtoRecord(): Record<string, number> {
  return Object.create(null) as Record<string, number>;
}

function emptyAggregate(): TaskAggregate {
  return {
    total: 0,
    outcomes: { ok: 0, error: 0, aborted: 0 },
    durationMsTotal: 0,
    recentDurationsMs: [],
    recentFirstTokenMs: [],
    promptTokensTotal: 0,
    completionTokensTotal: 0,
    cachedTokensTotal: 0,
    promptCharsTotal: 0,
    attemptTotal: 0,
    retried: 0,
    issueCodes: nullProtoRecord(),
    models: nullProtoRecord(),
  };
}

function store(): ModelTaskStore {
  const root = globalThis as typeof globalThis & { [MODEL_TASK_STORE]?: ModelTaskStore };
  if (!root[MODEL_TASK_STORE]) {
    const now = new Date().toISOString();
    root[MODEL_TASK_STORE] = { startedAt: now, updatedAt: now, tasks: {} };
  }
  const state = root[MODEL_TASK_STORE];
  if (!state.tasks) state.tasks = {};
  return state;
}

/** 词表化：小写、限定字符集、限长。与 stage-telemetry 同一套规则，保证键不会被脏输入撑爆。 */
export function safeTaskKey(value: string | undefined): string {
  const normalized = value?.toLowerCase().replace(/[^a-z0-9_.:/-]/g, "_").slice(0, 120);
  return normalized || "unknown";
}

function bumpKey(map: Record<string, number>, rawKey: string | undefined): void {
  const safe = rawKey ? safeTaskKey(rawKey) : "";
  if (!safe || safe === "unknown") return;
  const key = map[safe] == null && Object.keys(map).length >= MAX_DISTINCT_KEYS ? "other" : safe;
  map[key] = (map[key] || 0) + 1;
}

function pushBounded(samples: number[], value: number): void {
  samples.push(value);
  if (samples.length > RECENT_SAMPLE_LIMIT) samples.shift();
}

export function recordModelTaskTelemetry(event: ModelTaskTelemetryEvent): void {
  const state = store();
  const taskKey = safeTaskKey(event.task);
  const aggregate = state.tasks[taskKey] || emptyAggregate();
  aggregate.total += 1;
  aggregate.outcomes[event.outcome] += 1;
  const durationMs = Math.max(0, Math.round(event.durationMs));
  aggregate.durationMsTotal += durationMs;
  pushBounded(aggregate.recentDurationsMs, durationMs);
  if (typeof event.firstTokenMs === "number" && Number.isFinite(event.firstTokenMs)) {
    pushBounded(aggregate.recentFirstTokenMs, Math.max(0, Math.round(event.firstTokenMs)));
  }
  aggregate.promptTokensTotal += Math.max(0, Math.round(event.promptTokens));
  aggregate.completionTokensTotal += Math.max(0, Math.round(event.completionTokens));
  aggregate.cachedTokensTotal += Math.max(0, Math.round(event.cachedTokens));
  aggregate.promptCharsTotal += Math.max(0, Math.round(event.promptChars || 0));
  const attempt = Math.max(1, Math.round(event.attempt || 1));
  aggregate.attemptTotal += attempt;
  if (attempt > 1) aggregate.retried += 1;
  bumpKey(aggregate.issueCodes, event.issueCode);
  bumpKey(aggregate.models, event.model);
  state.tasks[taskKey] = aggregate;
  state.updatedAt = new Date().toISOString();
  console.info("[tcm-cdss:telemetry] model_task", {
    task: taskKey,
    stage: event.stage || "shared",
    model: event.model,
    provider: event.provider || "primary",
    attempt,
    outcome: event.outcome,
    durationMs,
    firstTokenMs: event.firstTokenMs ?? null,
    promptTokens: event.promptTokens,
    completionTokens: event.completionTokens,
    cachedTokens: event.cachedTokens,
    totalTokens: event.totalTokens,
    promptChars: event.promptChars ?? null,
    issueCode: event.issueCode || "none",
  });
}

/**
 * 包住一次模型调用：计时 → 抽 usage → 记账 → 原样返回。
 *
 * 刻意做成「透明包装」而不是「统一客户端」：11 个调用点各有自己的超时、AbortController、
 * response_format 与重试语义，换成统一客户端就得同时改 11 处控制流，风险远大于记账收益。
 * 包装器不改变任何返回值、不吞异常、不改写 AbortError 语义。
 */
export async function observeModelTask<T>(meta: ModelTaskMeta, run: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await run();
    const usage = modelUsageSnapshot(result);
    recordModelTaskTelemetry({
      ...meta,
      outcome: "ok",
      durationMs: Date.now() - startedAt,
      promptTokens: usage?.promptTokens || 0,
      completionTokens: usage?.completionTokens || 0,
      cachedTokens: usage?.cachedTokens || 0,
      totalTokens: usage?.totalTokens || 0,
    });
    return result;
  } catch (error) {
    const aborted = error instanceof Error
      && (error.name === "AbortError" || /abort/i.test(error.message));
    recordModelTaskTelemetry({
      ...meta,
      outcome: aborted ? "aborted" : "error",
      durationMs: Date.now() - startedAt,
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
    });
    throw error;
  }
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))];
}

export function getCdssModelTaskTelemetrySnapshot(): unknown {
  const state = store();
  const tasks = Object.entries(state.tasks).map(([task, aggregate]) => {
    const total = aggregate.total || 1;
    return [task, {
      total: aggregate.total,
      outcomes: { ...aggregate.outcomes },
      averageDurationMs: Math.round(aggregate.durationMsTotal / total),
      p50DurationMs: percentile(aggregate.recentDurationsMs, 0.5),
      p95DurationMs: percentile(aggregate.recentDurationsMs, 0.95),
      // n<=20 时 p95 退化为最大值——保留字段名但同时给样本量，读数的人自己判断可信度。
      latencySampleSize: aggregate.recentDurationsMs.length,
      averageFirstTokenMs: aggregate.recentFirstTokenMs.length > 0
        ? Math.round(aggregate.recentFirstTokenMs.reduce((sum, value) => sum + value, 0) / aggregate.recentFirstTokenMs.length)
        : null,
      p95FirstTokenMs: aggregate.recentFirstTokenMs.length > 0
        ? percentile(aggregate.recentFirstTokenMs, 0.95)
        : null,
      firstTokenSampleSize: aggregate.recentFirstTokenMs.length,
      promptTokensTotal: aggregate.promptTokensTotal,
      completionTokensTotal: aggregate.completionTokensTotal,
      cachedTokensTotal: aggregate.cachedTokensTotal,
      averagePromptTokens: Math.round(aggregate.promptTokensTotal / total),
      averageCompletionTokens: Math.round(aggregate.completionTokensTotal / total),
      // 真实缓存命中率。历史教训：用重放病例测出的 99% 是假象，只有分流流量下的值可用。
      cacheHitRatio: aggregate.promptTokensTotal > 0
        ? Number((aggregate.cachedTokensTotal / aggregate.promptTokensTotal).toFixed(4))
        : null,
      averagePromptChars: Math.round(aggregate.promptCharsTotal / total),
      averageAttempts: Number((aggregate.attemptTotal / total).toFixed(3)),
      retried: aggregate.retried,
      issueCodes: { ...aggregate.issueCodes },
      models: { ...aggregate.models },
    }];
  });
  const totals = Object.values(state.tasks).reduce((sum, aggregate) => ({
    calls: sum.calls + aggregate.total,
    promptTokens: sum.promptTokens + aggregate.promptTokensTotal,
    completionTokens: sum.completionTokens + aggregate.completionTokensTotal,
    cachedTokens: sum.cachedTokens + aggregate.cachedTokensTotal,
  }), { calls: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0 });
  return {
    schemaVersion: "tcm-cdss-model-task-telemetry-v1",
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    totals: {
      ...totals,
      cacheHitRatio: totals.promptTokens > 0
        ? Number((totals.cachedTokens / totals.promptTokens).toFixed(4))
        : null,
    },
    tasks: Object.fromEntries(tasks),
  };
}
