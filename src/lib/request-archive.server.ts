/**
 * 临床请求内容留存（2026-10-12 owner：服务端留存请求内容，先不限时，合规已确认）。
 *
 * 为什么要有：此前服务端不保存任何请求体——nginx 只记时间/IP/路径/状态/字节数，容器日志只有遥测码，
 * 甲方病例出了问题（红旗回放、空方页、证候名）只能靠字节数反推，拿不到病历原文就无法复现。
 *
 * 口径：
 * - 只留存临床路由的请求体（ARCHIVED_ROUTES 闭集）。唯一接入点是 diagnosis-request.ts 的
 *   readJsonRequest，登录、库存、知识检索、快照不经过它；闭集是第二道保险——登录体里是接口 Token，
 *   绝不能因为哪天有人改用 readJsonRequest 就被写盘。
 * - 加密落盘：AES-256-GCM，密钥由 CASE_SNAPSHOT_ENCRYPTION_KEY 经 HMAC 派生（用途隔离，不与快照
 *   共用同一把密钥）。明文只有时间与路由；客户编号、查询串与请求体都在密文里。
 *   **轮换 CASE_SNAPSHOT_ENCRYPTION_KEY 会让此前的留存无法解密**——每条记录带 kid 以便识别。
 * - 不按时间删除。磁盘保护是**停写不删**：目录总量超过 CDSS_REQUEST_ARCHIVE_MAX_BYTES（缺省 4GB）后
 *   不再追加并留遥测，已有留存一条不动（8/9 根分区写满曾让 strict health 503）。
 * - 永不影响请求本身：不 await、任何失败只留原因码，不带内容。
 * - 读取：scripts/request-archive-export.mjs（只依赖 node 内置模块，可直接管道进容器执行）。
 * - 响应也留存（用户 2026-10-26 决定 D3）：同一闭集路由的响应正文，边流给调用方边复制，结束后同样加密追加到同一份
 *   日文件；请求行与响应行带同一个 exchangeId 对上（响应行 kind="response"，请求行没有 kind）。调用方中途断开时
 *   留下已收到的部分并标 aborted；单条超过 4MB 只留前 4MB 并标 truncated；服务端自己发起的预先计算不留。
 */
import { createCipheriv, createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { INTERNAL_PRECOMPUTE_HEADER, isInternalPrecomputeRequest } from "./internal-precompute";
import { appendFile, mkdir, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { gzip } from "node:zlib";

export const REQUEST_ARCHIVE_FORMAT_VERSION = 1;
const KEY_CONTEXT = "tcm-cdss-request-archive-v1";
const DEFAULT_MAX_BYTES = 4 * 1024 ** 3;
const gzipAsync = promisify(gzip);

/** 留存的临床路由（去掉 basePath 之后的路径）。 */
export const ARCHIVED_ROUTES: ReadonlySet<string> = new Set([
  "/api/diagnosis/collect",
  "/api/diagnosis/question",
  "/api/diagnosis/question/interpret",
  "/api/diagnosis/red-flags",
  "/api/diagnosis/diagnose",
  "/api/diagnosis/prescribe",
  "/api/diagnosis/assess",
  "/api/diagnosis/post-prescription-risk",
  "/api/diagnosis/his-scheme",
  "/api/diagnosis/emergency-clearance",
  "/api/diagnosis/terminology/confirm",
]);

export type RequestArchiveLine = {
  v: number;
  ts: string;
  route: string;
  kid: string;
  iv: string;
  tag: string;
  data: string;
};

export function requestArchiveEnabled(): boolean {
  return process.env.CDSS_REQUEST_ARCHIVE === "true";
}

function archiveDirectory(): string {
  return resolve(process.env.CDSS_REQUEST_ARCHIVE_PATH?.trim() ||
    resolve(process.cwd(), "artifacts/runtime/request-archive"));
}

function maxArchiveBytes(): number {
  const parsed = Number(process.env.CDSS_REQUEST_ARCHIVE_MAX_BYTES || "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_BYTES;
}

/** 与 scripts/request-archive-export.mjs 的派生逐字一致（套件钉住往返）。 */
export function requestArchiveKey(): { key: Buffer; kid: string } | undefined {
  const secret = process.env.CASE_SNAPSHOT_ENCRYPTION_KEY || "";
  if (secret.length < 16) return undefined;
  const root = createHash("sha256").update(secret).digest();
  const key = createHmac("sha256", root).update(KEY_CONTEXT).digest();
  return { key, kid: createHash("sha256").update(key).digest("hex").slice(0, 8) };
}

/** 去掉 basePath，只留 /api/… 路径；不在闭集里返回 undefined。 */
export function archivedRouteOf(url: string): string | undefined {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return undefined;
  }
  const at = pathname.indexOf("/api/");
  const route = at >= 0 ? pathname.slice(at).replace(/\/+$/, "") : "";
  return ARCHIVED_ROUTES.has(route) ? route : undefined;
}

/** 北京时间日期作文件名：甲方按北京时间说「哪天哪次调用」，按 UTC 切会把上午八点前的请求分到前一天。 */
function segmentName(now: Date): string {
  const beijing = new Date(now.getTime() + 8 * 3_600_000).toISOString().slice(0, 10).replace(/-/g, "");
  return `requests-${beijing}.ndjson`;
}

export async function encryptRequestArchiveLine(
  route: string,
  payload: unknown,
  now = new Date(),
): Promise<RequestArchiveLine | undefined> {
  const material = requestArchiveKey();
  if (!material) return undefined;
  const ts = now.toISOString();
  const compressed = await gzipAsync(Buffer.from(JSON.stringify(payload), "utf8"));
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", material.key, iv);
  // 明文元数据进 AAD：改时间或路由会让解密失败，而不是把一条请求挂到别的接口名下。
  cipher.setAAD(Buffer.from(`${REQUEST_ARCHIVE_FORMAT_VERSION}|${ts}|${route}`, "utf8"));
  const data = Buffer.concat([cipher.update(compressed), cipher.final()]);
  return {
    v: REQUEST_ARCHIVE_FORMAT_VERSION,
    ts,
    route,
    kid: material.kid,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

let appendTail: Promise<void> = Promise.resolve();
/** 每个留存目录已写字节数（首次写入时扫一遍目录，之后累加）。 */
const archivedBytes = new Map<string, number>();
let lastFullNoticeAt = 0;
let keyMissingNoticed = false;
/** 同一次调用的请求行与响应行共用的编号（只在留存打开、路由在闭集里时生成）。 */
const exchangeIds = new WeakMap<Request, string>();
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

async function currentArchiveBytes(directory: string): Promise<number> {
  const known = archivedBytes.get(directory);
  if (known !== undefined) return known;
  let total = 0;
  try {
    for (const name of await readdir(directory)) {
      if (!name.endsWith(".ndjson")) continue;
      total += (await stat(join(directory, name))).size;
    }
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "ENOENT") throw error;
  }
  archivedBytes.set(directory, total);
  return total;
}

function notice(reason: string, detail: Record<string, unknown> = {}): void {
  console.warn("[tcm-cdss:telemetry] request_archive", { reason, ...detail });
}

/**
 * 留存一条临床请求。调用方不 await；返回的 Promise 只供测试等待落盘。
 * 任何失败只留原因码（不带请求内容），绝不抛给调用方。
 */
export function archiveClinicalRequest(req: Request, body: unknown): Promise<void> {
  if (!requestArchiveEnabled()) return Promise.resolve();
  const route = archivedRouteOf(req.url);
  if (!route) return Promise.resolve();
  if (!requestArchiveKey()) {
    if (!keyMissingNoticed) notice("key_unavailable");
    keyMissingNoticed = true;
    return Promise.resolve();
  }
  let query: string | undefined;
  try {
    query = new URL(req.url).search || undefined;
  } catch {
    query = undefined;
  }
  const payload = {
    method: req.method,
    ...(query ? { query } : {}),
    customerIdHeader: req.headers.get("x-cdss-customer-id")?.slice(0, 128) || undefined,
    regenerate: req.headers.get("x-cdss-regenerate") || undefined,
    contentEncoding: req.headers.get("content-encoding") || undefined,
    exchangeId: exchangeIds.get(req),
    body,
  };
  return enqueueArchiveLine(route, payload);
}

function enqueueArchiveLine(route: string, payload: unknown): Promise<void> {
  // 目录与上限在请求到达时定下，而不是轮到写盘时再读：写盘是排队异步的。
  const now = new Date();
  const directory = archiveDirectory();
  const maxBytes = maxArchiveBytes();
  const task = appendTail.catch(() => undefined).then(async () => {
    const line = await encryptRequestArchiveLine(route, payload, now);
    if (!line) return;
    const text = `${JSON.stringify(line)}\n`;
    const bytes = Buffer.byteLength(text);
    const written = await currentArchiveBytes(directory);
    if (written + bytes > maxBytes) {
      if (Date.now() - lastFullNoticeAt > 3_600_000) {
        lastFullNoticeAt = Date.now();
        notice("archive_full_writes_paused", { maxBytes });
      }
      return;
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await appendFile(join(directory, segmentName(now)), text, { mode: 0o600 });
    archivedBytes.set(directory, written + bytes);
  }).catch((error: unknown) => {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "unknown";
    notice("write_failed", { code, route });
  });
  appendTail = task;
  return task;
}

function concatChunks(chunks: Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** 把一个临床路由的响应包一层：正文照原样流给调用方，同时复制一份，结束（或调用方断开）时加密留存。 */
function archiveClinicalResponse(req: Request, route: string, response: Response, startedAt: number): Response {
  const meta = {
    kind: "response" as const,
    exchangeId: exchangeIds.get(req),
    status: response.status,
    contentType: response.headers.get("content-type") || undefined,
    stageResult: response.headers.get("x-cdss-stage-result") || undefined,
    customerIdHeader: req.headers.get("x-cdss-customer-id")?.slice(0, 128) || undefined,
  };
  if (!response.body) {
    void enqueueArchiveLine(route, { ...meta, body: "", truncated: false, aborted: false, ms: Date.now() - startedAt });
    return response;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  let finished = false;
  const finish = (aborted: boolean) => {
    if (finished) return;
    finished = true;
    const body = new TextDecoder().decode(concatChunks(chunks, size));
    void enqueueArchiveLine(route, { ...meta, body, truncated, aborted, ms: Date.now() - startedAt });
  };
  const copy = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (!truncated) {
        const room = MAX_RESPONSE_BYTES - size;
        const kept = chunk.byteLength > room ? chunk.subarray(0, room) : chunk;
        if (kept.byteLength < chunk.byteLength) truncated = true;
        chunks.push(kept);
        size += kept.byteLength;
      }
      controller.enqueue(chunk);
    },
    flush() {
      finish(false);
    },
  });
  req.signal?.addEventListener("abort", () => finish(true), { once: true });
  return new Response(response.body.pipeThrough(copy), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * 临床路由出口的统一包装（用户 2026-10-26 决定 D3：响应也加密留存）。留存关闭、路由不在闭集里、或服务端自己发起的
 * 预先计算时原样返回；任何留存失败都不影响响应本身。
 */
export function withClinicalResponseArchive(
  handler: (req: Request) => Promise<Response>,
): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    const route = requestArchiveEnabled() && requestArchiveKey() ? archivedRouteOf(req.url) : undefined;
    if (route) exchangeIds.set(req, randomUUID());
    const startedAt = Date.now();
    const response = await handler(req);
    if (!route) return response;
    try {
      if (req.headers.has(INTERNAL_PRECOMPUTE_HEADER) && await isInternalPrecomputeRequest(req.headers)) return response;
      return archiveClinicalResponse(req, route, response, startedAt);
    } catch {
      notice("response_wrap_failed", { route });
      return response;
    }
  };
}

/** 等已排队的留存写完（只给测试与优雅退出用；请求路径从不等它）。 */
export function requestArchiveIdle(): Promise<void> {
  return appendTail.catch(() => undefined);
}

/** 测试用：清掉进程内计数与提示状态。 */
export function resetRequestArchiveStateForTests(): void {
  archivedBytes.clear();
  lastFullNoticeAt = 0;
  keyMissingNoticed = false;
}
