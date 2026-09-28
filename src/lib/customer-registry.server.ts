import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseCustomerId } from "./customer-id";
import { normalizeIdempotencyKey } from "./idempotency-key";

const REGISTRY_SCHEMA_VERSION = "tcm-cdss-customer-registry-v1" as const;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{3,64}$/;
const DEFAULT_JIT_CUSTOMER_QUOTA = 100;
// 甲方客户一万多家（2026-09-28），生产配 20,000。硬顶留出余量。
const MAX_JIT_CUSTOMER_QUOTA = 50_000;
const REGISTRY_SANITY_MAX_ENTRIES = 200_000;

type RegisteredCustomer = Readonly<{
  clientId: string;
  customerId: string;
  status: "provisioning" | "active" | "failed" | "deactivated";
  createdAt: string;
  updatedAt: string;
  idempotencyKeyHash: string;
  authorizationSource?: "jit" | "static";
}>;

type CustomerRegistryFile = Readonly<{
  schemaVersion: typeof REGISTRY_SCHEMA_VERSION;
  customers: RegisteredCustomer[];
}>;

export type RegisterCustomerResult =
  | { ok: true; created: boolean; customer: RegisteredCustomer }
  | {
      ok: false;
      status: 400 | 409 | 429 | 503;
      code: "customer_jit_disabled" | "idempotency_key_required" | "idempotency_conflict" |
        "customer_quota_exceeded" | "customer_registry_unavailable" | "tenant_audit_unavailable";
      error: string;
    };

let registryMutationTail: Promise<void> = Promise.resolve();

function registryPath(): string {
  const configured = process.env.CDSS_CUSTOMER_REGISTRY_PATH?.trim();
  return configured
    ? resolve(configured)
    : resolve(process.cwd(), "artifacts/runtime/customer-registry.json");
}

function emptyRegistry(): CustomerRegistryFile {
  return { schemaVersion: REGISTRY_SCHEMA_VERSION, customers: [] };
}

function parseRegistry(raw: string): CustomerRegistryFile | undefined {
  try {
    const value = JSON.parse(raw) as Partial<CustomerRegistryFile>;
    if (value.schemaVersion !== REGISTRY_SCHEMA_VERSION || !Array.isArray(value.customers)) return undefined;
    const customers = value.customers.filter((item): item is RegisteredCustomer => Boolean(
      item && CLIENT_ID_PATTERN.test(item.clientId) && parseCustomerId(item.customerId) === item.customerId &&
      ["provisioning", "active", "failed", "deactivated"].includes(item.status) &&
      typeof item.createdAt === "string" && typeof item.updatedAt === "string" &&
      /^[a-f0-9]{64}$/.test(item.idempotencyKeyHash) &&
      (item.authorizationSource === undefined || ["jit", "static"].includes(item.authorizationSource)),
    ));
    // 条目数只做健全性上限，不与配额挂钩。2026-09-28 之前这里用的是配额硬顶 1,000：
    // 登记表一旦写进第 1,001 条，整张表判为损坏，**全部**客户一起 403——而当天甲方
    // 一次接入 1,926 家诊所，只差配置一改就会踩上。配额只在登记新客户时检查。
    if (customers.length !== value.customers.length || customers.length > REGISTRY_SANITY_MAX_ENTRIES) return undefined;
    return { schemaVersion: REGISTRY_SCHEMA_VERSION, customers };
  } catch {
    return undefined;
  }
}

/**
 * 登记表的进程内缓存与索引。
 *
 * 每个接口请求的鉴权都要查登记表 2～4 次（可用性、客户列表、单客户查找）。此前每次都
 * readFileSync + 整表解析：105 家时无感，2 万家时实测每次鉴权卡住事件循环 67ms，
 * 所有请求排队。缓存按文件身份（设备、inode、大小、纳秒修改时间）失效：本模块的写入是
 * 临时文件 + rename（换 inode），运维或测试原地改写会改变大小或修改时间，都能被看到。
 */
type IndexedRegistry = Readonly<{
  registry: CustomerRegistryFile;
  activeByBinding: ReadonlyMap<string, RegisteredCustomer>;
  activeIdsByClient: ReadonlyMap<string, ReadonlySet<string>>;
}>;

let registryCache: { key: string; value: IndexedRegistry | undefined } | undefined;

function bindingKey(clientId: string, customerId: string): string {
  return `${clientId}\0${customerId}`;
}

function indexRegistry(registry: CustomerRegistryFile): IndexedRegistry {
  const activeByBinding = new Map<string, RegisteredCustomer>();
  const activeIdsByClient = new Map<string, Set<string>>();
  for (const item of registry.customers) {
    if (item.status !== "active") continue;
    activeByBinding.set(bindingKey(item.clientId, item.customerId), item);
    const ids = activeIdsByClient.get(item.clientId) || new Set<string>();
    ids.add(item.customerId);
    activeIdsByClient.set(item.clientId, ids);
  }
  return { registry, activeByBinding, activeIdsByClient };
}

function registryFileKey(target: string): string | undefined {
  try {
    const stats = statSync(target, { bigint: true });
    return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}`;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    return code === "ENOENT" ? "missing" : undefined;
  }
}

function indexedRegistrySync(): IndexedRegistry | undefined {
  const target = registryPath();
  const key = registryFileKey(target);
  // stat 本身失败（权限、I/O）不缓存：按「不可用」返回，下一次请求重新判断。
  if (!key) return undefined;
  const cacheKey = `${target}\0${key}`;
  if (registryCache?.key === cacheKey) return registryCache.value;
  let value: IndexedRegistry | undefined;
  if (key === "missing") {
    value = indexRegistry(emptyRegistry());
  } else {
    try {
      const parsed = parseRegistry(readFileSync(target, "utf8"));
      value = parsed ? indexRegistry(parsed) : undefined;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      value = code === "ENOENT" ? indexRegistry(emptyRegistry()) : undefined;
    }
  }
  registryCache = { key: cacheKey, value };
  return value;
}

function readRegistrySync(): CustomerRegistryFile | undefined {
  return indexedRegistrySync()?.registry;
}

async function readRegistry(): Promise<CustomerRegistryFile | undefined> {
  // 变更路径同样走缓存：变更已由 registryMutationTail 串行化，且写入后立刻按新文件身份
  // 回填缓存，所以这里拿到的就是最近一次落盘的内容，不必每次登记都重新解析整张表。
  return readRegistrySync();
}

async function writeRegistry(registry: CustomerRegistryFile): Promise<void> {
  const target = registryPath();
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  // 紧凑格式：2 万家时缩进格式约 8MB，每次登记要写两遍。
  await writeFile(temporary, `${JSON.stringify(registry)}\n`, { mode: 0o600 });
  await rename(temporary, target);
  const key = registryFileKey(target);
  registryCache = key && key !== "missing" ? { key: `${target}\0${key}`, value: indexRegistry(registry) } : undefined;
}

function idempotencyKeyHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function jitQuota(): number {
  const parsed = Number.parseInt(process.env.CDSS_CUSTOMER_JIT_MAX_CUSTOMERS || "", 10);
  return Number.isFinite(parsed)
    ? Math.max(1, Math.min(MAX_JIT_CUSTOMER_QUOTA, parsed))
    : DEFAULT_JIT_CUSTOMER_QUOTA;
}

export function customerJitRegistrationEnabled(): boolean {
  return process.env.CDSS_CUSTOMER_JIT_ENABLED === "true";
}

/** Missing registry files represent an empty registry; malformed/unreadable files are unavailable. */
export function customerRegistryAvailable(): boolean {
  return Boolean(readRegistrySync());
}

export function registeredCustomerForClient(
  clientId: string,
  customerId: string,
): RegisteredCustomer | undefined {
  return indexedRegistrySync()?.activeByBinding.get(bindingKey(clientId, customerId));
}

export function registeredCustomerIdsForClient(clientId: string): string[] | undefined {
  const indexed = indexedRegistrySync();
  if (!indexed) return undefined;
  return [...(indexed.activeIdsByClient.get(clientId) || [])];
}

/** 每个请求都要用的客户计数走这里：返回缓存里的只读集合，不复制 2 万个字符串。 */
export function registeredActiveCustomerIdSetForClient(clientId: string): ReadonlySet<string> | undefined {
  const indexed = indexedRegistrySync();
  if (!indexed) return undefined;
  return indexed.activeIdsByClient.get(clientId) || new Set<string>();
}

export async function registerCustomerForClient(input: {
  clientId: string;
  customerId: string;
  idempotencyKey: string;
  staticCustomerIds?: readonly string[];
  beforeActivate?: (customer: RegisteredCustomer) => Promise<void>;
}): Promise<RegisterCustomerResult> {
  if (!customerJitRegistrationEnabled()) {
    return { ok: false, status: 503, code: "customer_jit_disabled", error: "customer JIT registration is disabled" };
  }
  if (!CLIENT_ID_PATTERN.test(input.clientId) || parseCustomerId(input.customerId) !== input.customerId) {
    return { ok: false, status: 400, code: "customer_registry_unavailable", error: "invalid customer registration binding" };
  }
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  if (!idempotencyKey) {
    return { ok: false, status: 400, code: "idempotency_key_required", error: "valid Idempotency-Key header required" };
  }

  let release: (() => void) | undefined;
  const turn = new Promise<void>((resolveTurn) => { release = resolveTurn; });
  const previous = registryMutationTail;
  registryMutationTail = previous.catch(() => undefined).then(() => turn);
  await previous.catch(() => undefined);
  try {
    const registry = await readRegistry();
    if (!registry) {
      return { ok: false, status: 503, code: "customer_registry_unavailable", error: "customer registry is unavailable" };
    }
    const keyHash = idempotencyKeyHash(idempotencyKey);
    const keyOwner = registry.customers.find((item) => item.idempotencyKeyHash === keyHash);
    if (keyOwner && (keyOwner.clientId !== input.clientId || keyOwner.customerId !== input.customerId)) {
      return { ok: false, status: 409, code: "idempotency_conflict", error: "Idempotency-Key is already bound to another customer" };
    }
    const existing = registry.customers.find(
      (item) => item.clientId === input.clientId && item.customerId === input.customerId,
    );
    if (existing && existing.idempotencyKeyHash !== keyHash) {
      return {
        ok: false,
        status: 409,
        code: "idempotency_conflict",
        error: "customer registration is already bound to another Idempotency-Key",
      };
    }
    if (existing?.status === "active") {
      return { ok: true, created: false, customer: existing };
    }
    const staticCustomerIds = new Set(input.staticCustomerIds || []);
    const clientCustomerIds = new Set(staticCustomerIds);
    for (const item of registry.customers) {
      // failed 是登记流程失败的中间态，deactivated 是运维显式吊销的终态——两者都不再占用
      // 活跃配额，否则注销测试租户无法为真实客户腾出名额。
      if (item.clientId === input.clientId && item.status !== "failed" && item.status !== "deactivated") {
        clientCustomerIds.add(item.customerId);
      }
    }
    const clientCustomerCount = clientCustomerIds.size;
    if (!existing && !staticCustomerIds.has(input.customerId) && clientCustomerCount >= jitQuota()) {
      return { ok: false, status: 429, code: "customer_quota_exceeded", error: "customer registration quota exceeded" };
    }
    const now = new Date().toISOString();
    const provisioning: RegisteredCustomer = {
      clientId: input.clientId,
      customerId: input.customerId,
      status: "provisioning",
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      idempotencyKeyHash: keyHash,
      authorizationSource: staticCustomerIds.has(input.customerId) ? "static" : existing?.authorizationSource || "jit",
    };
    const customersWithProvisioning = existing
      ? registry.customers.map((item) => item === existing ? provisioning : item)
      : [...registry.customers, provisioning];
    try {
      // Persist the intermediate state first. A process crash can therefore be retried with the
      // same idempotency key instead of silently losing whether provisioning had begun.
      await writeRegistry({ ...registry, customers: customersWithProvisioning });
    } catch {
      return { ok: false, status: 503, code: "customer_registry_unavailable", error: "customer registry is unavailable" };
    }
    try {
      // Registration audit is part of activation, not best effort. This keeps a failed audit sink
      // from creating an authorized customer with no acceptance evidence.
      await input.beforeActivate?.(provisioning);
    } catch {
      const failed: RegisteredCustomer = { ...provisioning, status: "failed", updatedAt: new Date().toISOString() };
      await writeRegistry({
        ...registry,
        customers: customersWithProvisioning.map((item) => item === provisioning ? failed : item),
      }).catch(() => undefined);
      return { ok: false, status: 503, code: "tenant_audit_unavailable", error: "tenant audit is unavailable" };
    }
    const active: RegisteredCustomer = { ...provisioning, status: "active", updatedAt: new Date().toISOString() };
    const activeCustomers = customersWithProvisioning.map((item) => item === provisioning ? active : item);
    try {
      await writeRegistry({ ...registry, customers: activeCustomers });
    } catch {
      const failed: RegisteredCustomer = { ...provisioning, status: "failed", updatedAt: new Date().toISOString() };
      await writeRegistry({
        ...registry,
        customers: customersWithProvisioning.map((item) => item === provisioning ? failed : item),
      }).catch(() => undefined);
      return { ok: false, status: 503, code: "customer_registry_unavailable", error: "customer registry is unavailable" };
    }
    return { ok: true, created: active.authorizationSource !== "static", customer: active };
  } finally {
    release?.();
  }
}

export type DeactivateCustomerResult =
  | { ok: true; customer: RegisteredCustomer; alreadyDeactivated: boolean }
  | {
      ok: false;
      status: 404 | 503;
      code: "customer_not_registered" | "customer_registry_unavailable";
      error: string;
    };

/**
 * 注销一个已登记客户（P1-5，甲方 2026-08-24 验收提出的清理通路）。
 *
 * - **吊销即时生效**：授权读取器（registeredCustomerForClient / registeredCustomerIdsForClient）
 *   只认 status === "active"，写入 deactivated 后该客户的所有 API 访问立刻回到 403。
 * - **幂等键绑定保留**：deactivated 条目仍占有原 Idempotency-Key——用原键重新登记 = 显式的
 *   停用恢复（重新走 provisioning → active），换键或把该键改绑他人仍 409。
 * - **不占配额**：与 failed 同待遇，注销后名额立即释放。
 * - 与 registerCustomerForClient 共用同一条 registryMutationTail 串行链，避免并发
 *   read-modify-write 互相覆盖。
 */
export async function deactivateCustomerForClient(input: {
  clientId: string;
  customerId: string;
}): Promise<DeactivateCustomerResult> {
  let release: (() => void) | undefined;
  const turn = new Promise<void>((resolveTurn) => { release = resolveTurn; });
  const previous = registryMutationTail;
  registryMutationTail = previous.catch(() => undefined).then(() => turn);
  await previous.catch(() => undefined);
  try {
    const registry = await readRegistry();
    if (!registry) {
      return { ok: false, status: 503, code: "customer_registry_unavailable", error: "customer registry is unavailable" };
    }
    const existing = registry.customers.find(
      (item) => item.clientId === input.clientId && item.customerId === input.customerId,
    );
    if (!existing) {
      return { ok: false, status: 404, code: "customer_not_registered", error: "customer is not registered" };
    }
    if (existing.status === "deactivated") {
      return { ok: true, customer: existing, alreadyDeactivated: true };
    }
    const deactivated: RegisteredCustomer = { ...existing, status: "deactivated", updatedAt: new Date().toISOString() };
    try {
      await writeRegistry({
        ...registry,
        customers: registry.customers.map((item) => item === existing ? deactivated : item),
      });
    } catch {
      return { ok: false, status: 503, code: "customer_registry_unavailable", error: "customer registry is unavailable" };
    }
    return { ok: true, customer: deactivated, alreadyDeactivated: false };
  } finally {
    release?.();
  }
}
