import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { drugInventoryPath } from "./drug-inventory.server";
import { withSerializedLock } from "./serialized-lock";

/**
 * 库存写入的幂等事务（POST /api/drug-inventory）。
 *
 * ## 这道闸拦的是什么
 *
 * 甲方 2026-09-15 实测：同一个 `Idempotency-Key` 连发两次、第二次载荷不同，两次都返回 200，
 * **第二次把第一次导入的库存整批覆盖了**。原因是这个请求头此前只交给 requireCustomerContext，
 * 用于未登记客户的 JIT 登记；客户一旦已登记，`shouldProvision` 为假，幂等键连格式都不再校验，
 * 请求直接落到 importDrugInventory 的「整批替换」上。
 *
 * 危害不是「少了一次去重」。库存语义下被覆盖掉的药味不会退回 unknown，而是变成
 * **out_of_stock**——院内明明有麻黄，系统却告诉医生缺货并给替代候选。缺数据必须不改变链路行为，
 * 而一次重复提交把「有货」讲成「缺货」，是比导入失败严重得多的故障。
 *
 * ## 判据
 *
 * 记录身份 = sha256(clientId ⊕ customerId ⊕ 幂等键)，**不落盘原始键**（与客户登记表
 * 只存 idempotencyKeyHash 的口径一致）。同一身份再次到达时比对请求体指纹：
 * - 指纹相同 ⇒ 重放首次响应（状态码与响应体逐字节相同，另加 `idempotent-replay: true` 响应头），不再写库存；
 * - 指纹不同 ⇒ 409 `idempotency_conflict`，**一个字节都不写**。
 *
 * ## 只记录真正落盘的结果（200）
 *
 * 202（分片已暂存未提交）不记录：分片按 (importId,index) 覆盖写暂存，重发同一片本身就是幂等的；
 * 记录它反而会把「首次响应里的 receivedParts/missingParts」这种会过期的进度重放给调用方。
 * 4xx/5xx 同样不记录——此时线上库存未变，调用方应当能用同一个键改正载荷后重试，
 * 这与 PROV-08「失败的首提交不留租户副作用」是同一条口径。
 *
 * ## 分片整批替换为什么不需要额外的作用域
 *
 * 曾按「同键的各片各自去重」给记录身份加过 `part:<index>` 作用域，反证跑下来是空转：
 * 202 本就不记录，同一次分片导入里只有最后触发提交的那一片会落记录，各片之间根本不会撞。
 * 加上它反而让「把上一次的键复用到另一次导入」推迟到最后一片才报 409——那时前几片已经暂存。
 * 去掉之后，键复用在**第一片**就 409，更早也更干净。
 *
 * ## 持久化
 *
 * 与库存文件同目录、同卷（`${drugInventoryPath(customerId)}.idempotency.json`），因此不需要新增
 * 环境变量，生产上自然落在已挂载的 tcm-cdss-runtime 卷里；容器重建不丢，也天然按客户隔离。
 * 写入走临时文件 + rename 原子替换。
 */

const SCHEMA_VERSION = "tcm-cdss-inventory-idempotency-v1" as const;

/** 记录有效期。重复提交发生在重试、定时任务重跑与网络抖动的尺度上，7 天足够覆盖。 */
export const INVENTORY_IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 每客户保留的记录条数上限。响应体结构有界（快照计数 + 至多各 200 条未归一/歧义药名）。 */
export const INVENTORY_IDEMPOTENCY_MAX_RECORDS = 50;

type IdempotencyRecord = {
  recordHash: string;
  fingerprint: string;
  status: number;
  body: unknown;
  createdAt: string;
};

type IdempotencyFile = {
  schemaVersion: typeof SCHEMA_VERSION;
  records: IdempotencyRecord[];
};

/** 同一 (客户, 记录身份) 的「查—执行—落记录」串行；不同键并发。 */
const recordLocks = new Map<string, Promise<void>>();
/** 记录文件本身的读改写串行（不同键会写同一个文件，否则丢更新）。 */
const fileLocks = new Map<string, Promise<void>>();

function recordPath(customerId: string): string {
  return `${drugInventoryPath(customerId)}.idempotency.json`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * 请求体指纹。键序无关（调用方换一个 JSON 序列化实现不该被判成不同请求），
 * 但取值完全一致才算同一请求——少一味药、改一个 goodsId 都必须判为冲突。
 */
export function inventoryRequestFingerprint(body: {
  source?: unknown;
  items?: unknown;
  part?: unknown;
}): string {
  return createHash("sha256")
    .update(canonicalJson({ source: body.source ?? null, items: body.items ?? null, part: body.part ?? null }))
    .digest("hex");
}

function recordIdentity(input: {
  clientId: string;
  customerId: string;
  idempotencyKey: string;
}): string {
  return createHash("sha256")
    .update(`${input.clientId}\n${input.customerId}\n${input.idempotencyKey}`)
    .digest("hex");
}

function parseFile(raw: string): IdempotencyFile {
  try {
    const value = JSON.parse(raw) as Partial<IdempotencyFile>;
    if (value.schemaVersion !== SCHEMA_VERSION || !Array.isArray(value.records)) {
      return { schemaVersion: SCHEMA_VERSION, records: [] };
    }
    const records = value.records.filter((item): item is IdempotencyRecord => Boolean(
      item && typeof item === "object" &&
      /^[a-f0-9]{64}$/.test(String(item.recordHash)) &&
      /^[a-f0-9]{64}$/.test(String(item.fingerprint)) &&
      Number.isInteger(item.status) &&
      typeof item.createdAt === "string",
    ));
    return { schemaVersion: SCHEMA_VERSION, records };
  } catch {
    // 记录文件损坏一律当作「没有记录」：幂等记录是写入去重，不是安全控制，
    // 读不出来时退回到「照常执行一次」，绝不因此拒绝一次合法的库存导入。
    return { schemaVersion: SCHEMA_VERSION, records: [] };
  }
}

async function readFileRecords(customerId: string): Promise<IdempotencyFile> {
  try {
    return parseFile(await readFile(recordPath(customerId), "utf8"));
  } catch {
    return { schemaVersion: SCHEMA_VERSION, records: [] };
  }
}

function pruneRecords(records: IdempotencyRecord[], now: number): IdempotencyRecord[] {
  const live = records.filter((item) => {
    const createdAt = Date.parse(item.createdAt);
    return Number.isFinite(createdAt) && now - createdAt <= INVENTORY_IDEMPOTENCY_TTL_MS;
  });
  return live.slice(-INVENTORY_IDEMPOTENCY_MAX_RECORDS);
}

async function appendRecord(customerId: string, record: IdempotencyRecord): Promise<void> {
  await withSerializedLock(fileLocks, customerId, async () => {
    const current = await readFileRecords(customerId);
    const merged = pruneRecords(
      [...current.records.filter((item) => item.recordHash !== record.recordHash), record],
      Date.now(),
    );
    const target = recordPath(customerId);
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, records: merged })}\n`, "utf8");
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  });
}

export type InventoryIdempotencyOutcome<T> =
  | { kind: "executed"; result: T }
  | { kind: "replayed"; status: number; body: unknown }
  | { kind: "conflict" };

/**
 * 在幂等事务里执行一次库存写入。
 *
 * `run` 返回 `record` 时才落幂等记录——调用方据此只登记真正改动了线上库存的结果。
 */
export async function withInventoryIdempotency<T>(
  input: {
    clientId: string;
    customerId: string;
    idempotencyKey: string;
    fingerprint: string;
  },
  run: () => Promise<{ result: T; record?: { status: number; body: unknown } }>,
): Promise<InventoryIdempotencyOutcome<T>> {
  const recordHash = recordIdentity(input);
  return withSerializedLock(recordLocks, `${input.customerId}:${recordHash}`, async () => {
    const existing = (await readFileRecords(input.customerId)).records.find(
      (item) => item.recordHash === recordHash &&
        Date.now() - Date.parse(item.createdAt) <= INVENTORY_IDEMPOTENCY_TTL_MS,
    );
    if (existing) {
      return existing.fingerprint === input.fingerprint
        ? { kind: "replayed" as const, status: existing.status, body: existing.body }
        : { kind: "conflict" as const };
    }
    const outcome = await run();
    if (outcome.record) {
      await appendRecord(input.customerId, {
        recordHash,
        fingerprint: input.fingerprint,
        status: outcome.record.status,
        body: outcome.record.body,
        createdAt: new Date().toISOString(),
      });
    }
    return { kind: "executed" as const, result: outcome.result };
  });
}

/** 供测试断言记录落盘形态；生产路径不读它。 */
export async function inventoryIdempotencyRecordsForTests(customerId: string): Promise<IdempotencyRecord[]> {
  return (await readFileRecords(customerId)).records;
}
