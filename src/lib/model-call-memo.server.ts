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

type Scope = { fresh: boolean; used: Set<string>; forgotten: boolean };
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

/** 临床路由的入口。`fresh`：本次不读旧答案、算完覆盖写入（显式要求重抽）。 */
export function runWithModelCallMemo<T>(options: { fresh?: boolean }, run: () => T): T {
  if (!modelCallMemoEnabled()) return run();
  return scopes.run({ fresh: Boolean(options.fresh), used: new Set(), forgotten: false }, run);
}

export function currentModelCallMemoScope(): Scope | undefined {
  return scopes.getStore();
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
export async function memoizedModelFetch(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
  const scope = scopes.getStore();
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
  const key = scope && !scope.forgotten ? modelCallMemoKey(url, init?.body) : undefined;
  if (!scope || !key) return globalThis.fetch(input, init);
  scope.used.add(key);
  // 登记进行中要在任何 await 之前：读盘期间同内容的另一路就得看到它，否则两路都会发真实请求。
  const pending = scope.fresh ? undefined : inFlight.get(key);
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
  if (!scope.fresh && !pending) {
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
  let response: Response;
  try {
    response = await globalThis.fetch(input, init);
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
 * 不在作用域内等于直接算；fresh 时重算并覆盖。
 */
export async function memoizedScopeText(namespace: string, keyParts: unknown, compute: () => Promise<string>): Promise<string> {
  const scope = scopes.getStore();
  if (!scope) return compute();
  const key = createHash("sha256").update(JSON.stringify([namespace, canonical(keyParts)])).digest("hex");
  scope.used.add(key);
  const pending = scope.fresh ? undefined : inFlight.get(key);
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
  if (!scope.fresh && !pending) {
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
