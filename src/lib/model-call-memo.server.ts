import { AsyncLocalStorage } from "node:async_hooks";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

/**
 * 同一请求内容只向模型要一次答案（2026-11-01 第三十四轮，「同病历波动」）。
 *
 * 温度 0 不保证逐字相同：托管接口的批处理与浮点运算都会改 logits，DeepSeek 没有 seed，百炼的 seed 也只是尽力而为
 * （Atil 等 2024、Thinking Machines 2025）。第十三轮量过：42 例里 41 例的第一处差异是**提示词**不同，而提示词不同来自
 * 更早一步的模型输出（事实层、追问、选病）；一条链路约 30 次模型调用，任何一次抽到另一答案，后面全跟着变。
 * 所以稳定性要在调用这一层解决：键是实际发给模型的内容（模型名 + 消息 + 影响输出的参数），命中就回放当时的原始响应。
 *
 * 只做「同内容同答案」，不改任何判断：
 *  · 只在临床路由的作用域里生效（runWithModelCallMemo）；健康检查、部署探针永远走真实调用，否则查不出上游故障；
 *  · 只存完整且正常收尾的响应；被截断（length）、断流、非 2xx 不存；
 *  · 阶段结果判为降级（占位页、上游故障页、修复用尽页），这次用过的键全部作废（forgetModelCallsInScope），
 *    下一次重试才可能抽到不同答案——否则一次坏结果会被固定 30 天；
 *  · 键不含租户：提示词里已有整份病历，能命中说明调用方本来就持有这些内容；同一份病历换诊所也得到同一结果。
 *  · 键不含代码版本：发版后提示词没变的调用照旧回放，方证不会因为一次无关发版而变；提示词改了自然未命中。
 *
 * 生产默认开启，本机与测试默认关闭（测试要反复换模型桩）；`CDSS_MODEL_CALL_MEMO=true|false` 优先。
 * 落盘目录 `CDSS_MODEL_CALL_MEMO_PATH`，未设置则只在进程内。加密同阶段结果留存：AES-256-GCM，
 * 密钥由 CASE_SNAPSHOT_ENCRYPTION_KEY 派生，轮换后读不出按未命中处理。
 */

type Scope = { fresh: boolean; used: Set<string>; forgotten: boolean; regenerationFallbackSection?: string };

/**
 * 强制重新生成时重抽哪些调用（2026-11-23 第五十八轮，「强制重生成方名药味仍变」）。
 *
 * 一条链路约 30 次模型调用。此前 `force` 把它们全部重抽：事实抽取、选病、用药规划、外部检索段、各项窄核对每一个都可能抽到另一答案，
 * 主生成的提示词跟着变，后面的核对又各自再变一次——重新生成的差异大半不是主生成自己的。
 * 现在只有**阶段主生成**（流式首轮及其重试、兜底重生成、修复轮，都走 diagnosis-api.ts 的 fetchWithConnectTimeout）重抽；
 * 其余小任务与外部检索段照常「同内容同答案」：输入没变就回放，输入变了自然未命中。
 * `CDSS_REGENERATE_FRESH_SCOPE=all` 恢复「全部重抽」（量整条链路的独立抽样波动时用）。
 */
function freshAppliesTo(scope: Scope, primary: boolean): boolean {
  if (!scope.fresh) return false;
  return primary || process.env.CDSS_REGENERATE_FRESH_SCOPE === "all";
}
type Stored = { contentType: string; text: string };

const scopes = new AsyncLocalStorage<Scope>();
const inFlight = new Map<string, Promise<Stored | undefined>>();
const memory = new Map<string, { storedAt: number; value: Stored }>();
const MEMORY_MAX_ENTRIES = 64;
const MEMORY_TTL_MS = 30 * 60_000;
const KEY_CONTEXT = "tcm-cdss-model-call-memo-v1";
/** 这些参数不影响模型「写什么」：max_tokens 只决定是否截断（截断的响应不存）。 */
const NON_GENERATIVE_FIELDS = new Set(["stream_options", "max_tokens", "max_completion_tokens", "user"]);

export function modelCallMemoEnabled(): boolean {
  const explicit = process.env.CDSS_MODEL_CALL_MEMO;
  if (explicit === "true") return true;
  if (explicit === "false") return false;
  return process.env.NODE_ENV === "production";
}

/** 临床路由的入口。`fresh`：阶段主生成不读旧答案、算完覆盖写入（显式要求重抽）；其余调用照常回放，见 freshAppliesTo。 */
export function runWithModelCallMemo<T>(options: { fresh?: boolean }, run: () => T): T {
  if (!modelCallMemoEnabled()) return run();
  return scopes.run({ fresh: Boolean(options.fresh), used: new Set(), forgotten: false }, run);
}

export function currentModelCallMemoScope(): Scope | undefined {
  return scopes.getStore();
}

// ─── 重新生成的基准：同一次调用上一次的输出（2026-11-23 第五十八轮）────────────────────────────
//
// 强制重新生成是一次真实抽样，温度 0 也不保证与上次相同（同一份已签名辨证三次开方：药味 14/14/13，加减 2/4/4 条）。
// 用户定：把之前的结果作为背景回传给模型，让差异尽量小。最贴近的做法就在这一层——主生成要重抽时，同一份请求内容
// 上一次留下的完整输出还在（键相同），把它附在提示词末尾作为基准，要求结论照写、文字可沿用；新输出仍存回同一个键。
//  · 只对阶段主生成、且只在强制重新生成时做；不强制时照旧回放，与此无关。
//  · 降级结果用过的键已作废（forgetModelCallsInScope），坏结果不会成为基准。
//  · 提示词变了（病历改了、提示词改了）键就不同，自然没有基准；开方阶段此时用路由给的「同一病历上一次处方」兜底
//    （regeneration-anchor.server.ts，辨证文字重写后开方提示词会变）。
//  · `CDSS_REGENERATION_ANCHOR=false` 关闭（两层一起关），强制重新生成回到独立抽样。
const REGENERATION_PREVIOUS_OUTPUT_MAX_CHARS = 24_000;

export function regenerationReferenceEnabled(): boolean {
  return process.env.CDSS_REGENERATION_ANCHOR !== "false";
}

/** 路由给本次请求的兜底基准段（同一病历上一次的处方）；没有同内容的上一次输出时才用。 */
export function setRegenerationFallbackSection(section: string | undefined): void {
  const scope = scopes.getStore();
  if (scope) scope.regenerationFallbackSection = section?.trim() || undefined;
}

type ToolCallPart = { function?: { arguments?: unknown } };

/**
 * 从留存的原始响应里取模型写出的内容（流式 SSE 或非流式 JSON）：正文；没有正文时取强制工具调用的参数
 *（辨证两半首轮不合 schema 时的重试就是这种形式，它的输出才是当时被采用的那一份）。都没有、超长、残缺返回 undefined。
 */
export function assistantTextFromModelResponse(raw: string): string | undefined {
  let content = "";
  let toolArguments = "";
  if (raw.includes("data:")) {
    for (const line of raw.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const delta = (JSON.parse(payload) as { choices?: Array<{ delta?: { content?: unknown; tool_calls?: ToolCallPart[] } }> }).choices?.[0]?.delta;
        if (typeof delta?.content === "string") content += delta.content;
        const part = delta?.tool_calls?.[0]?.function?.arguments;
        if (typeof part === "string") toolArguments += part;
      } catch {
        return undefined;
      }
    }
  } else {
    try {
      const message = (JSON.parse(raw) as { choices?: Array<{ message?: { content?: unknown; tool_calls?: ToolCallPart[] } }> }).choices?.[0]?.message;
      if (typeof message?.content === "string") content = message.content;
      const part = message?.tool_calls?.[0]?.function?.arguments;
      if (typeof part === "string") toolArguments = part;
    } catch {
      return undefined;
    }
  }
  const trimmed = content.trim() || toolArguments.trim();
  return trimmed && trimmed.length <= REGENERATION_PREVIOUS_OUTPUT_MAX_CHARS ? trimmed : undefined;
}

export function previousOutputRegenerationSection(previous: string): string {
  return [
    "【同一份输入上一次的输出（本次重新生成的基准）】",
    "这是对同一份输入的重新生成：输入没有任何变化。上一次的输出如下：",
    "<<<上一次输出开始",
    previous,
    "上一次输出结束>>>",
    "要求：本次输出与上一次保持一致，按同样的结构把上一次的输出原样再写一遍——各项结论不增不减、不换说法（病名、证候与兼证、治法、方名与方药方向、每一味药的药名含炮制写法、剂量与君臣佐使、随证加减的条件与药味、推荐的中成药/西药与治疗项目、追问的问题与选项），说明性文字也沿用上一次的原句，不改写、不润色、不补充。",
  ].join("\n");
}

/** 把基准段接在最后一条 user 消息末尾；请求体不是预期形状时返回 undefined（照原样发）。 */
export function requestBodyWithRegenerationSection(body: string, section: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { messages?: Array<{ role?: unknown; content?: unknown }> };
    if (!Array.isArray(parsed.messages)) return undefined;
    for (let index = parsed.messages.length - 1; index >= 0; index -= 1) {
      const message = parsed.messages[index];
      if (message?.role !== "user") continue;
      if (typeof message.content !== "string") return undefined;
      parsed.messages[index] = { ...message, content: `${message.content}\n\n${section}` };
      return JSON.stringify(parsed);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function memoDir(): string | undefined {
  return process.env.CDSS_MODEL_CALL_MEMO_PATH?.trim() || undefined;
}

function ttlMs(): number {
  const days = Number(process.env.CDSS_MODEL_CALL_MEMO_DAYS);
  return (Number.isFinite(days) && days > 0 && days <= 365 ? days : 30) * 86_400_000;
}

function encryptionKey(): Buffer | undefined {
  const secret = process.env.CASE_SNAPSHOT_ENCRYPTION_KEY || "";
  if (secret.length < 16) return undefined;
  return createHmac("sha256", createHash("sha256").update(secret).digest()).update(KEY_CONTEXT).digest();
}

/** 只抹掉不改变意思的差异（全半角、空白、标点的中英文写法），标点本身保留。 */
function normalizedText(value: string): string {
  return value.normalize("NFKC")
    .replace(/\s+/g, "")
    .replace(/[，,、]/g, ",").replace(/[；;]/g, ";").replace(/[。．]/g, ".").replace(/[：:]/g, ":");
}

function canonical(value: unknown): unknown {
  if (typeof value === "string") return normalizedText(value);
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort()
      .map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
  }
  return value;
}

/** 键：请求体里所有影响生成的字段。解析不了的请求体不参与（返回 undefined，照常真实调用）。 */
export function modelCallMemoKey(url: string, body: unknown): string | undefined {
  if (typeof body !== "string") return undefined;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || !parsed.messages) return undefined;
  const fields = Object.fromEntries(Object.entries(parsed).filter(([key]) => !NON_GENERATIVE_FIELDS.has(key)));
  return createHash("sha256").update(JSON.stringify([url.replace(/^https?:\/\/[^/]+/, ""), canonical(fields)])).digest("hex");
}

/** 只认完整且正常收尾的响应；被截断、断流的不存。 */
export function modelResponseComplete(text: string): boolean {
  if (text.includes("data:")) {
    let finish: unknown;
    let content = false;
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const choice = (JSON.parse(payload) as { choices?: Array<{ finish_reason?: unknown; delta?: { content?: unknown; tool_calls?: unknown } }> }).choices?.[0];
        if (choice?.finish_reason) finish = choice.finish_reason;
        if (choice?.delta?.content || choice?.delta?.tool_calls) content = true;
      } catch {
        return false;
      }
    }
    return content && (finish === "stop" || finish === "tool_calls");
  }
  try {
    const choice = (JSON.parse(text) as { choices?: Array<{ finish_reason?: unknown; message?: { content?: unknown; tool_calls?: unknown } }> }).choices?.[0];
    return Boolean((choice?.message?.content || choice?.message?.tool_calls) && (choice?.finish_reason === "stop" || choice?.finish_reason === "tool_calls"));
  } catch {
    return false;
  }
}

function pathFor(dir: string, key: string): string {
  return join(dir, key.slice(0, 2), `${key}.bin`);
}

async function readStored(key: string): Promise<Stored | undefined> {
  const held = memory.get(key);
  if (held) {
    if (Date.now() - held.storedAt < MEMORY_TTL_MS) return held.value;
    memory.delete(key);
  }
  const dir = memoDir();
  const secret = encryptionKey();
  if (!dir || !secret) return undefined;
  try {
    const path = pathFor(dir, key);
    const info = await stat(path);
    if (Date.now() - info.mtimeMs > ttlMs()) return undefined;
    const raw = await readFile(path);
    const decipher = createDecipheriv("aes-256-gcm", secret, raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(key, "utf8"));
    decipher.setAuthTag(raw.subarray(12, 28));
    const stored = JSON.parse(gunzipSync(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()])).toString("utf8")) as Stored;
    return typeof stored.text === "string" ? { contentType: String(stored.contentType || ""), text: stored.text } : undefined;
  } catch {
    return undefined;
  }
}

async function pruneShard(shard: string): Promise<void> {
  try {
    const cutoff = Date.now() - ttlMs();
    for (const name of await readdir(shard)) {
      const path = join(shard, name);
      const info = await stat(path);
      if (info.mtimeMs < cutoff || (name.endsWith(".tmp") && info.mtimeMs < Date.now() - 3_600_000)) await unlink(path);
    }
  } catch {
    // 清理失败不影响任何请求。
  }
}

async function writeStored(key: string, value: Stored): Promise<void> {
  memory.set(key, { storedAt: Date.now(), value });
  while (memory.size > MEMORY_MAX_ENTRIES) {
    const oldest = memory.keys().next().value;
    if (oldest === undefined) break;
    memory.delete(oldest);
  }
  const dir = memoDir();
  const secret = encryptionKey();
  if (!dir || !secret) return;
  try {
    const shard = join(dir, key.slice(0, 2));
    await mkdir(shard, { recursive: true, mode: 0o700 });
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", secret, iv);
    cipher.setAAD(Buffer.from(key, "utf8"));
    const data = Buffer.concat([cipher.update(gzipSync(Buffer.from(JSON.stringify(value), "utf8"))), cipher.final()]);
    const path = pathFor(dir, key);
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, Buffer.concat([iv, cipher.getAuthTag(), data]), { mode: 0o600 });
    await rename(temporary, path);
    void pruneShard(shard);
  } catch (error) {
    console.warn("[tcm-cdss:telemetry] model_call_memo", { ok: false, reason: error instanceof Error ? error.name : "unknown" });
  }
}

function replay(stored: Stored): Response {
  return new Response(stored.text, {
    status: 200,
    headers: { "content-type": stored.contentType || "application/json", "x-cdss-model-call-memo": "hit" },
  });
}

/**
 * 模型调用的唯一入口（SDK 的 fetch 选项与 fetchWithConnectTimeout 都走这里）。不在作用域内时等于 globalThis.fetch。
 * 进行中的同内容调用并入：调用方先到的负责真实请求，后到的等它的完整响应；它失败或被中止，后到的自己再发一次。
 */
export async function memoizedModelFetch(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
  onNetworkAttempt?: () => void,
  options: { primaryGeneration?: boolean } = {},
): Promise<Response> {
  const scope = scopes.getStore();
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
  const key = scope && !scope.forgotten ? modelCallMemoKey(url, init?.body) : undefined;
  if (!scope || !key) {
    onNetworkAttempt?.();
    return globalThis.fetch(input, init);
  }
  scope.used.add(key);
  const fresh = freshAppliesTo(scope, Boolean(options.primaryGeneration));
  // 登记进行中要在任何 await 之前：读盘期间同内容的另一路就得看到它，否则两路都会发真实请求。
  const pending = fresh ? undefined : inFlight.get(key);
  if (pending) {
    const stored = await abortable(pending, init?.signal);
    if (stored) {
      console.info("[tcm-cdss:telemetry] model_call_memo", { hit: true, joined: true });
      return replay(stored);
    }
  }
  init?.signal?.throwIfAborted();
  let settle: (value: Stored | undefined) => void = () => {};
  const mine = new Promise<Stored | undefined>((resolve) => { settle = resolve; });
  inFlight.set(key, mine);
  const release = (value: Stored | undefined) => {
    if (inFlight.get(key) === mine) inFlight.delete(key);
    settle(value);
  };
  if (!fresh && !pending) {
    const stored = await readStored(key);
    if (stored) {
      release(stored);
      console.info("[tcm-cdss:telemetry] model_call_memo", { hit: true, joined: false });
      return replay(stored);
    }
    // 读盘期间调用方可能已中止（小任务的时限）：不发请求，也别让并入的人白等。
    if (init?.signal?.aborted) {
      release(undefined);
      init.signal.throwIfAborted();
    }
  }
  // 主生成重抽：同内容上一次的输出作基准附在提示词末尾；没有时用路由给的兜底基准段。键不变，新输出覆盖旧输出。
  let requestInit = init;
  let regenerationPrevious: string | undefined;
  if (fresh && options.primaryGeneration && regenerationReferenceEnabled() && typeof init?.body === "string") {
    const stored = await readStored(key);
    if (init.signal?.aborted) {
      release(undefined);
      init.signal.throwIfAborted();
    }
    const previous = stored ? assistantTextFromModelResponse(stored.text) : undefined;
    const section = previous ? previousOutputRegenerationSection(previous) : scope.regenerationFallbackSection;
    const body = section ? requestBodyWithRegenerationSection(init.body, section) : undefined;
    if (body) requestInit = { ...init, body };
    if (body && previous) regenerationPrevious = previous;
    console.info("[tcm-cdss:telemetry] regeneration_reference", { source: !body ? "none" : previous ? "previous_output" : "record_anchor" });
  }
  let response: Response;
  try {
    onNetworkAttempt?.();
    response = await globalThis.fetch(input, requestInit);
  } catch (error) {
    release(undefined);
    throw error;
  }
  if (!response.ok || !response.body) {
    release(undefined);
    return response;
  }
  const contentType = response.headers.get("content-type") || "";
  void response.clone().text().then(
    async (text) => {
      if (!modelResponseComplete(text)) return release(undefined);
      // 线上核对用：带着上一次输出重新生成，这次是否逐字照写（只记真假与长度，不含内容）。
      if (regenerationPrevious !== undefined) {
        const current = assistantTextFromModelResponse(text);
        console.info("[tcm-cdss:telemetry] regeneration_reference", {
          reproduced: current === regenerationPrevious,
          previousChars: regenerationPrevious.length,
          currentChars: current?.length ?? 0,
        });
      }
      const value = { contentType, text };
      release(value);
      if (!scope.forgotten) await writeStored(key, value);
    },
    () => release(undefined),
  );
  return response;
}

/**
 * 同一份输入第二次起用第一次的文本（外部检索段：它按时钟截断，每次可能不同）。键是调用方给的内容；空串也留，「这次没带」本身就是要固定的结论。
 * 不在作用域内等于直接算；fresh 且 CDSS_REGENERATE_FRESH_SCOPE=all 时重算并覆盖。
 */
export async function memoizedScopeText(namespace: string, keyParts: unknown, compute: () => Promise<string>): Promise<string> {
  const scope = scopes.getStore();
  if (!scope) return compute();
  const key = createHash("sha256").update(JSON.stringify([namespace, canonical(keyParts)])).digest("hex");
  scope.used.add(key);
  // 外部检索段不是主生成：强制重新生成时照常回放（它按时钟截断，重抽只会让主生成的提示词无故不同）。
  const fresh = freshAppliesTo(scope, false);
  const pending = fresh ? undefined : inFlight.get(key);
  if (pending) {
    const stored = await pending;
    if (stored) return stored.text;
  }
  let settle: (value: Stored | undefined) => void = () => {};
  const mine = new Promise<Stored | undefined>((resolve) => { settle = resolve; });
  inFlight.set(key, mine);
  const release = (value: Stored | undefined) => {
    if (inFlight.get(key) === mine) inFlight.delete(key);
    settle(value);
  };
  if (!fresh && !pending) {
    const stored = await readStored(key);
    if (stored) {
      release(stored);
      return stored.text;
    }
  }
  try {
    const text = await compute();
    const value = { contentType: "text/plain", text };
    release(value);
    if (!scope.forgotten) void writeStored(key, value);
    return text;
  } catch (error) {
    release(undefined);
    throw error;
  }
}

function abortable<T>(pending: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return pending;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

/** 阶段结果判为降级时调用：这次用过的答案全部作废，下一次重试才可能不同。 */
export async function forgetModelCallsInScope(scope: Scope | undefined): Promise<void> {
  if (!scope || scope.forgotten) return;
  scope.forgotten = true;
  const dir = memoDir();
  for (const key of scope.used) {
    memory.delete(key);
    if (dir) await unlink(pathFor(dir, key)).catch(() => undefined);
  }
  console.info("[tcm-cdss:telemetry] model_call_memo", { forgotten: scope.used.size });
}

/** 测试用。 */
export function resetModelCallMemoForTests(): void {
  memory.clear();
  inFlight.clear();
}
