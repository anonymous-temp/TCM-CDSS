import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
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
 *
 * **换绑（2026-10-12 线上实测）**：指纹有意不含病例编号（HIS 同一病历重推常换编号），但 M03/M04
 * 的合同签名绑定病例编号与就诊编号。原实现把旧编号的签名原样回放给新编号，下游 M05 验签必然
 * 失败——甲方 9/30、10/9 的 4 次 `invalid_m04_signature` 全部是这一形状（诊断、开方都是复用，
 * 1 秒内返回）。现在回放给**不同绑定**的请求时，先把最终正文按本次请求重新签名（`rebindFinalContent`），
 * 换绑不了就照常重算；进行中的计算对不同绑定的请求不实时转发，等它算完再换绑回放。
 * `CDSS_STAGE_RESULT_REUSE=false` 整体关闭（回滚开关）；生产（NODE_ENV=production）默认开启。
 */

export type CoalescedStage = "diagnose" | "prescribe";

type Entry = {
  key: string;
  stage: CoalescedStage;
  /** 发起计算那次请求的签名绑定身份（病例编号 + 就诊编号）。 */
  bindingId: string;
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
  /** 计算结束（无论可否复用）。换绑回放要等最终正文。 */
  finished: Promise<void>;
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

const WORKFLOW_KEYS = ["questionRounds", "questionOutcome", "maxQuestionRounds", "completeness", "safetyGate", "clinicalFacts", "lastError"] as const;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(typeof value === "string" ? fingerprintText(value) : value ?? null);
}

/**
 * 指纹里的文本只抹掉不改变意思的差异（2026-10-13，「相同病例要输出一致」）：全半角、空白、标点的中英文写法、
 * 连续重复的标点和句末标点。标点本身保留——「无胸痛，发热」与「无，胸痛发热」不是同一句话。
 */
function fingerprintText(value: string): string {
  return value.normalize("NFKC")
    .replace(/\s+/g, "")
    .replace(/[，,]/g, ",").replace(/[；;]/g, ";").replace(/[。．]/g, ".").replace(/[：:]/g, ":").replace(/[、]/g, ",")
    .replace(/([,;.:])\1+/g, "$1")
    .replace(/[,;.:]+$/g, "");
}

/** 结果只在同一版代码、同一组模型下复用：换了版本或换了模型，旧结果不再回放。 */
function generationIdentity(): string {
  return [
    process.env.CDSS_BUILD_SOURCE_DIGEST || "",
    process.env.PRIMARY_DIAGNOSE_MODEL || "",
    process.env.PRIMARY_PRESCRIBE_MODEL || "",
    process.env.CDSS_HOME_ACUPOINT_CARE || "",
    process.env.CDSS_REDFLAG_EXPLICIT_ONLY || "",
  ].join("|");
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
  // 流程字段不进指纹（2026-10-13）：追问轮次与结果、完整度、闸门结果、事实层快照都由同一份病历派生，
  // 不是生成输入。带进指纹时，同一份病历「未追问」「跳过追问」「页面带着快照重推」会各算一次、各不相同。
  for (const key of WORKFLOW_KEYS) delete state[key];
  // 上游阶段产物里只与绑定有关的字段（合同签名）不进指纹：同一 M03 换绑到新编号后签名必然不同，
  // 带进指纹会让 M04 永远复用不上；回放时按本次请求重新签名（见 rebindFinalContent）。
  for (const key of ["reasoningDiagnose", "reasoningV2"]) {
    const reasoning = state[key];
    if (reasoning && typeof reasoning === "object" && !Array.isArray(reasoning)) {
      const unsigned = { ...(reasoning as Record<string, unknown>) };
      delete unsigned.contractSignature;
      state[key] = unsigned;
    }
  }
  return createHash("sha256")
    .update(`${stage}\n${generationIdentity()}\n${tenant.clientId || ""}\n${tenant.customerId || ""}\n${canonicalJson(state)}`)
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

// ─── 落盘留存（2026-10-13，甲方「相同病例要输出一致」「两次输出结果不一致」）────────────────────
//
// 进程内缓存 30 分钟、重启即空：同一份病历隔天再测、或发版之后再测，就是一次全新的生成，证型叫法、
// 方名、药味都可能不同（生产实测同一病例重新生成 3 次，方名只有一半病例完全一致）。温度设 0 也不保证
// 逐字相同；能保证的只有把结果留下来。这里把可复用的最终结果按指纹加密落盘，缺省保留 30 天：
//   · 目录由 CDSS_STAGE_RESULT_STORE_PATH 指定（未设置即不落盘，行为与此前完全相同）；
//   · 加密与请求留存同一做法：AES-256-GCM，密钥由 CASE_SNAPSHOT_ENCRYPTION_KEY 派生（轮换后旧文件读不出，按未命中处理）；
//   · 指纹含代码版本与模型名（generationIdentity），发版后旧结果不会被回放；
//   · 显式重新生成（x-cdss-regenerate: 1）不读留存，算完覆盖写入。
const PERSIST_KEY_CONTEXT = "tcm-cdss-stage-result-v1";

function persistDir(): string | undefined {
  const dir = process.env.CDSS_STAGE_RESULT_STORE_PATH?.trim();
  return dir || undefined;
}

function persistTtlMs(): number {
  const days = Number(process.env.CDSS_STAGE_RESULT_PERSIST_DAYS);
  return (Number.isFinite(days) && days > 0 && days <= 365 ? days : 30) * 86_400_000;
}

function persistKey(): Buffer | undefined {
  const secret = process.env.CASE_SNAPSHOT_ENCRYPTION_KEY || "";
  if (secret.length < 16) return undefined;
  return createHmac("sha256", createHash("sha256").update(secret).digest()).update(PERSIST_KEY_CONTEXT).digest();
}

function persistPath(dir: string, stage: CoalescedStage, key: string): string {
  return join(dir, stage, key.slice(0, 2), `${key}.bin`);
}

async function writePersisted(entry: Entry): Promise<void> {
  const dir = persistDir();
  const key = persistKey();
  if (!dir || !key || !entry.cacheable || entry.status !== 200) return;
  try {
    const path = persistPath(dir, entry.stage, entry.key);
    await mkdir(join(dir, entry.stage, entry.key.slice(0, 2)), { recursive: true, mode: 0o700 });
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(`${entry.stage}|${entry.key}`, "utf8"));
    const plain = gzipSync(Buffer.from(JSON.stringify({
      bindingId: entry.bindingId,
      finishedAt: entry.finishedAt || Date.now(),
      contentType: entry.headers?.get("content-type") || "",
      lines: entry.lines,
    }), "utf8"));
    const data = Buffer.concat([cipher.update(plain), cipher.final()]);
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, Buffer.concat([iv, cipher.getAuthTag(), data]), { mode: 0o600 });
    await rename(temporary, path);
    // 顺手清一个分片里过期的文件：不设常驻清理任务，写入时摊还。
    void prunePersistedShard(join(dir, entry.stage, entry.key.slice(0, 2)));
  } catch (error) {
    console.warn("[tcm-cdss:telemetry] stage_result_persist", { ok: false, reason: error instanceof Error ? error.name : "unknown" });
  }
}

async function prunePersistedShard(shard: string): Promise<void> {
  try {
    const cutoff = Date.now() - persistTtlMs();
    for (const name of await readdir(shard)) {
      const path = join(shard, name);
      const info = await stat(path);
      if (info.mtimeMs < cutoff || (name.endsWith(".tmp") && info.mtimeMs < Date.now() - 3_600_000)) await unlink(path);
    }
  } catch {
    // 清理失败不影响任何请求。
  }
}

async function readPersisted(stage: CoalescedStage, cacheKey: string): Promise<Entry | undefined> {
  const dir = persistDir();
  const key = persistKey();
  if (!dir || !key) return undefined;
  try {
    const path = persistPath(dir, stage, cacheKey);
    const info = await stat(path);
    if (Date.now() - info.mtimeMs > persistTtlMs()) return undefined;
    const raw = await readFile(path);
    const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(`${stage}|${cacheKey}`, "utf8"));
    decipher.setAuthTag(raw.subarray(12, 28));
    const stored = JSON.parse(gunzipSync(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()])).toString("utf8")) as {
      bindingId?: unknown; finishedAt?: unknown; contentType?: unknown; lines?: unknown;
    };
    if (!Array.isArray(stored.lines) || !stored.lines.every((line) => typeof line === "string")) return undefined;
    const now = Date.now();
    const headers = new Headers();
    if (typeof stored.contentType === "string" && stored.contentType) headers.set("content-type", stored.contentType);
    return {
      key: cacheKey,
      stage,
      bindingId: typeof stored.bindingId === "string" ? stored.bindingId : "",
      // 载入内存后按进程内缓存的口径计时：30 分钟后从内存淘汰，需要时再从盘上读。
      createdAt: now,
      finishedAt: now,
      status: 200,
      headers,
      lines: stored.lines as string[],
      rawChunks: [],
      done: true,
      cacheable: true,
      subscribers: new Set(),
      ready: Promise.resolve(),
      finished: Promise.resolve(),
    };
  } catch {
    return undefined;
  }
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

/** 换绑回放：保留带 type 的事件帧，正文换成按本次请求重新签名的最终正文。 */
function reboundResponse(entry: Entry, content: string): Response {
  const encoder = new TextEncoder();
  const lines = entry.lines.filter((line) => {
    try {
      const frame = JSON.parse(line) as { type?: unknown };
      return typeof frame.type === "string";
    } catch {
      return false;
    }
  });
  const body = [...lines, JSON.stringify({ content }), JSON.stringify({ content: "[END]" })].map((line) => `${line}\n`).join("");
  const headers = new Headers(entry.headers);
  headers.set("x-cdss-stage-result", "reused");
  return new Response(encoder.encode(body), { status: 200, headers });
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
  /** 本次请求的签名绑定身份；与发起计算的请求不同则不能原样回放。 */
  bindingId?: string;
  /** 把可复用的最终正文按本次请求重新签名；返回 undefined 表示换绑不了，本次照常重算。 */
  rebindFinalContent?: (finalContent: string) => string | undefined;
}): Promise<Response> {
  if (!stageResultReuseEnabled()) return input.compute(new AbortController().signal);
  const now = Date.now();
  evictExpired(now);
  let existing = input.bypass ? undefined : entries.get(input.key);
  if (!existing && !input.bypass) {
    const persisted = await readPersisted(input.stage, input.key);
    // 读盘期间同一指纹的请求可能已经开始计算：以内存里的为准。
    existing = entries.get(input.key) || persisted;
    if (persisted && existing === persisted) {
      entries.set(input.key, persisted);
      console.info("[tcm-cdss:telemetry] stage_result_reuse", { stage: input.stage, mode: "persisted" });
    }
  }
  const bindingId = input.bindingId ?? "";
  if (existing) {
    await existing.ready;
    if (existing.status === 200 && (!existing.done || existing.cacheable)) {
      if (existing.bindingId === bindingId) {
        console.info("[tcm-cdss:telemetry] stage_result_reuse", {
          stage: input.stage,
          mode: existing.done ? "reused" : "joined",
          ageMs: now - existing.createdAt,
        });
        return subscriberResponse(existing, existing.done ? "reused" : "joined");
      }
      if (input.rebindFinalContent) {
        await existing.finished;
        if (existing.cacheable) {
          let rebound: string | undefined;
          try {
            rebound = input.rebindFinalContent(finalContentFromLines(existing.lines).content);
          } catch {
            rebound = undefined;
          }
          if (rebound !== undefined) {
            console.info("[tcm-cdss:telemetry] stage_result_reuse", {
              stage: input.stage,
              mode: "rebound",
              ageMs: Date.now() - existing.createdAt,
            });
            return reboundResponse(existing, rebound);
          }
        }
      }
      // 绑定不同且换绑不了：不回放别的病例编号的签名，本次照常重算。
    }
  }
  const controller = new AbortController();
  const hardLimit = setTimeout(() => controller.abort(), input.hardLimitMs ?? 240_000);
  let markReady: () => void = () => {};
  let markFinished: () => void = () => {};
  const entry: Entry = {
    key: input.key,
    stage: input.stage,
    bindingId,
    createdAt: now,
    lines: [],
    rawChunks: [],
    done: false,
    cacheable: false,
    subscribers: new Set(),
    ready: new Promise<void>((resolve) => { markReady = resolve; }),
    finished: new Promise<void>((resolve) => { markFinished = resolve; }),
  };
  entries.set(input.key, entry);
  let response: Response;
  try {
    response = await input.compute(controller.signal);
  } catch (error) {
    clearTimeout(hardLimit);
    entries.delete(input.key);
    markReady();
    markFinished();
    throw error;
  }
  entry.status = response.status;
  entry.headers = new Headers(response.headers);
  markReady();
  if (response.status !== 200 || !response.body) {
    clearTimeout(hardLimit);
    entries.delete(input.key);
    markFinished();
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
    else void writePersisted(entry);
    entry.rawChunks = [];
    for (const subscriber of entry.subscribers) {
      try { subscriber.close(); } catch { /* subscriber already gone */ }
    }
    entry.subscribers.clear();
    markFinished();
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
