import { createHash } from "node:crypto";
import { STREAM_REPLACE_MARKER } from "./diagnosis-stream-protocol";

/**
 * 同一病历的 M03/M04 请求只算一次（2026-09-29，甲方 9.24/9.27 测评「内容输出不稳定」「未诊断却给了处方」）。
 *
 * 生产遥测里的三种形状，根因是同一个：
 *   1. 饮片「暂未生成」：9/24 0059 的 M04 在第 30.2 秒被调用方断开（request_cancelled），而模型 4 秒后
 *      就产出了合格处方——断开即作废，重试从零再算，慢一点的病例重试多少次都一样卡住；
 *   2. 同一病历一分钟内被连发两轮（重推/自动重试），两轮结果不同，面板把第二轮的诊断和第一轮的处方
 *      拼在一起（0060：诊断栏是占位、饮片栏却有方）；
 *   3. 同一病历每点一次就重算一次，方名、出处前后不一。
 *
 * 做法：按「租户 + 阶段 + 会影响本阶段生成的病例内容」算指纹。
 *   · 同指纹的请求**进行中** → 并入同一次计算，先补发已产出的帧、再实时转发后续帧；
 *   · 同指纹的结果**已完成且可复用**（30 分钟内、不是降级/中断/上游故障页）→ 直接回放；
 *   · 计算与任何一个调用方的连接**解耦**：调用方断开不中止计算，算完照样入缓存，下一次重试直接拿到。
 * 请求头 `x-cdss-regenerate: 1`（或 `?regenerate=1`）显式要求重新生成时绕过复用。
 * `CDSS_STAGE_RESULT_REUSE=false` 整体关闭（回滚开关）；生产（NODE_ENV=production）默认开启。
 */

export type CoalescedStage = "diagnose" | "prescribe";

type Entry = {
  key: string;
  stage: CoalescedStage;
  createdAt: number;
  finishedAt?: number;
  status?: number;
  headers?: Headers;
  /** 不含心跳的 NDJSON 行（回放用）。 */
  lines: string[];
  /** 进行中：已转发给现有订阅者的原始字节（新加入者先补发这些）。 */
  rawChunks: Uint8Array[];
  done: boolean;
  cacheable: boolean;
  subscribers: Set<ReadableStreamDefaultController<Uint8Array>>;
  ready: Promise<void>;
};

const RESULT_TTL_MS = 30 * 60_000;
const MAX_ENTRIES = 256;
const entries = new Map<string, Entry>();

/**
 * 生产默认开启；本机开发与测试默认关闭（测试会用同一份输入反复打路由、逐次换模型桩/环境，期望每次真算）。
 * 显式开关优先：`CDSS_STAGE_RESULT_REUSE=true|false`。
 */
export function stageResultReuseEnabled(): boolean {
  const flag = process.env.CDSS_STAGE_RESULT_REUSE;
  if (flag === "false") return false;
  if (flag === "true") return true;
  return process.env.NODE_ENV === "production";
}

// 本阶段及之后阶段的**产物**不进指纹：HIS 重推时常把上一轮的诊断/处方原样带回来，
// 它们不影响本阶段的生成输入，带进指纹就永远对不上。
const OUTPUT_KEYS: Record<CoalescedStage, readonly string[]> = {
  diagnose: ["id", "phase", "diagnosis", "prescription", "riskAssessment", "followupTimeline", "previousResult",
    "auditAdvisory", "reasoningDiagnose", "reasoningPrescribe", "prescriptionRevision", "warningAcknowledgement"],
  prescribe: ["id", "phase", "prescription", "riskAssessment", "followupTimeline", "previousResult",
    "auditAdvisory", "reasoningPrescribe", "prescriptionRevision", "warningAcknowledgement"],
};

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function stageRequestFingerprint(
  stage: CoalescedStage,
  tenant: { clientId?: string; customerId?: string },
  caseState: unknown,
): string {
  const state = caseState && typeof caseState === "object" && !Array.isArray(caseState)
    ? { ...(caseState as Record<string, unknown>) }
    : {};
  for (const key of OUTPUT_KEYS[stage]) delete state[key];
  return createHash("sha256")
    .update(`${stage}\n${tenant.clientId || ""}\n${tenant.customerId || ""}\n${canonicalJson(state)}`)
    .digest("hex");
}

/** 从一组 NDJSON 行还原最终正文（与 tapFinalStageContent 同口径：取最后一个替换标记之后）。 */
function finalContentFromLines(lines: readonly string[]): { content: string; ended: boolean; errored: boolean } {
  let accumulated = "";
  let ended = false;
  let errored = false;
  for (const line of lines) {
    let frame: { content?: unknown; error?: unknown };
    try {
      frame = JSON.parse(line) as { content?: unknown; error?: unknown };
    } catch {
      continue;
    }
    if (frame.error !== undefined) errored = true;
    if (typeof frame.content !== "string") continue;
    if (frame.content === "[END]") {
      ended = true;
      continue;
    }
    const combined = accumulated + frame.content;
    const markerIndex = combined.lastIndexOf(STREAM_REPLACE_MARKER);
    accumulated = markerIndex >= 0 ? combined.slice(markerIndex + STREAM_REPLACE_MARKER.length) : combined;
  }
  return { content: accumulated, ended, errored };
}

function evictExpired(now: number): void {
  for (const [key, entry] of entries) {
    if (entry.done && (!entry.cacheable || now - (entry.finishedAt || entry.createdAt) > RESULT_TTL_MS)) entries.delete(key);
  }
  while (entries.size > MAX_ENTRIES) {
    const oldest = [...entries.values()].filter((entry) => entry.done).sort((left, right) => left.createdAt - right.createdAt)[0];
    if (!oldest) break;
    entries.delete(oldest.key);
  }
}

function subscriberResponse(entry: Entry, role: "origin" | "joined" | "reused"): Response {
  const replayOnly = role === "reused";
  const encoder = new TextEncoder();
  let registered: ReadableStreamDefaultController<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (replayOnly) {
        for (const line of entry.lines) controller.enqueue(encoder.encode(`${line}\n`));
        controller.close();
        return;
      }
      for (const chunk of entry.rawChunks) controller.enqueue(chunk);
      if (entry.done) {
        controller.close();
        return;
      }
      registered = controller;
      entry.subscribers.add(controller);
    },
    cancel() {
      if (registered) entry.subscribers.delete(registered);
    },
  });
  const headers = new Headers(entry.headers);
  // 发起计算的那次请求不带此头；只有并入进行中的计算、或回放已完成结果的请求才标注。
  if (role !== "origin") headers.set("x-cdss-stage-result", role);
  return new Response(body, { status: entry.status || 200, headers });
}

/**
 * @param compute 真正的阶段计算。拿到的 signal 与调用方连接无关（只在服务端硬上限时中止）。
 * @param cacheable 最终正文可否复用（降级页、中断页、上游故障页不复用，下次照常重算）。
 */
export async function coalesceStageResponse(input: {
  stage: CoalescedStage;
  key: string;
  bypass?: boolean;
  compute: (signal: AbortSignal) => Promise<Response>;
  cacheable: (finalContent: string) => boolean;
  hardLimitMs?: number;
}): Promise<Response> {
  if (!stageResultReuseEnabled()) return input.compute(new AbortController().signal);
  const now = Date.now();
  evictExpired(now);
  const existing = input.bypass ? undefined : entries.get(input.key);
  if (existing) {
    await existing.ready;
    if (existing.status === 200 && (!existing.done || existing.cacheable)) {
      console.info("[tcm-cdss:telemetry] stage_result_reuse", {
        stage: input.stage,
        mode: existing.done ? "reused" : "joined",
        ageMs: now - existing.createdAt,
      });
      return subscriberResponse(existing, existing.done ? "reused" : "joined");
    }
  }
  const controller = new AbortController();
  const hardLimit = setTimeout(() => controller.abort(), input.hardLimitMs ?? 240_000);
  let markReady: () => void = () => {};
  const entry: Entry = {
    key: input.key,
    stage: input.stage,
    createdAt: now,
    lines: [],
    rawChunks: [],
    done: false,
    cacheable: false,
    subscribers: new Set(),
    ready: new Promise<void>((resolve) => { markReady = resolve; }),
  };
  entries.set(input.key, entry);
  let response: Response;
  try {
    response = await input.compute(controller.signal);
  } catch (error) {
    clearTimeout(hardLimit);
    entries.delete(input.key);
    markReady();
    throw error;
  }
  entry.status = response.status;
  entry.headers = new Headers(response.headers);
  markReady();
  if (response.status !== 200 || !response.body) {
    clearTimeout(hardLimit);
    entries.delete(input.key);
    return response;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  const finish = () => {
    clearTimeout(hardLimit);
    entry.done = true;
    entry.finishedAt = Date.now();
    const final = finalContentFromLines(entry.lines);
    entry.cacheable = final.ended && !final.errored && input.cacheable(final.content);
    if (!entry.cacheable) entries.delete(input.key);
    entry.rawChunks = [];
    for (const subscriber of entry.subscribers) {
      try { subscriber.close(); } catch { /* subscriber already gone */ }
    }
    entry.subscribers.clear();
  };
  // 后台泵：把计算结果读完，逐块转发给当前订阅者并留档；与任何调用方连接无关。
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        entry.rawChunks.push(value);
        for (const subscriber of entry.subscribers) {
          try { subscriber.enqueue(value); } catch { entry.subscribers.delete(subscriber); }
        }
        pending += decoder.decode(value, { stream: true });
        let newline = pending.indexOf("\n");
        while (newline >= 0) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          if (line.trim() && !/^\{"type":"heartbeat"/.test(line)) entry.lines.push(line);
          newline = pending.indexOf("\n");
        }
      }
      if (pending.trim() && !/^\{"type":"heartbeat"/.test(pending)) entry.lines.push(pending);
    } catch {
      // 读流失败：本次结果不复用，已订阅者收到截断流（与原先连接断开同效）。
    } finally {
      finish();
    }
  })();
  return subscriberResponse(entry, "origin");
}

/** 测试用：清空进程内缓存。 */
export function resetStageResultCacheForTests(): void {
  entries.clear();
}
