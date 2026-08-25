import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseCustomerId } from "./customer-id";

const REGISTRY_SCHEMA_VERSION = "tcm-cdss-customer-registry-v1" as const;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{3,64}$/;
const DEFAULT_JIT_CUSTOMER_QUOTA = 100;
const MAX_JIT_CUSTOMER_QUOTA = 1_000;
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{8,200}$/;

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
    if (customers.length !== value.customers.length || customers.length > MAX_JIT_CUSTOMER_QUOTA) return undefined;
    return { schemaVersion: REGISTRY_SCHEMA_VERSION, customers };
  } catch {
    return undefined;
  }
}

function readRegistrySync(): CustomerRegistryFile | undefined {
  try {
    return parseRegistry(readFileSync(registryPath(), "utf8"));
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    return code === "ENOENT" ? emptyRegistry() : undefined;
  }
}

async function readRegistry(): Promise<CustomerRegistryFile | undefined> {
  try {
    return parseRegistry(await readFile(registryPath(), "utf8"));
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    return code === "ENOENT" ? emptyRegistry() : undefined;
  }
}

async function writeRegistry(registry: CustomerRegistryFile): Promise<void> {
  const target = registryPath();
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
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
  const registry = readRegistrySync();
  return registry?.customers.find(
    (item) => item.clientId === clientId && item.customerId === customerId && item.status === "active",
  );
}

export function registeredCustomerIdsForClient(clientId: string): string[] | undefined {
  const registry = readRegistrySync();
  return registry?.customers
    .filter((item) => item.clientId === clientId && item.status === "active")
    .map((item) => item.customerId);
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
  const idempotencyKey = input.idempotencyKey.trim();
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
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
