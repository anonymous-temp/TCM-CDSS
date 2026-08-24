import "server-only";

import { createHash, createHmac } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type TenantAuditEvent = Readonly<{
  timestamp: string;
  event: "customer_registration" | "inventory_import" | "inventory_read";
  clientId: string;
  customerHash: string;
  outcome: "accepted" | "pending" | "rejected" | "failed";
  code?: string;
  requestIdHash?: string;
  operationId?: string;
  itemCount?: number;
  inventoryVersion?: string;
}>;

type TenantAuditEventInput = Omit<TenantAuditEvent, "timestamp" | "requestIdHash"> & {
  requestId?: string;
};

const DEFAULT_AUDIT_MAX_BYTES = 8_000_000;
const DEFAULT_AUDIT_ARCHIVE_FILES = 4;
let appendTail: Promise<void> = Promise.resolve();

function auditPath(): string {
  return resolve(process.env.CDSS_TENANT_AUDIT_PATH?.trim() ||
    resolve(process.cwd(), "artifacts/runtime/tenant-audit.ndjson"));
}

function clean(value: string | undefined, max: number): string | undefined {
  const normalized = value?.replace(/[\r\n\u0000-\u001f]/g, " ").trim().slice(0, max);
  return normalized || undefined;
}

function auditMaxBytes(): number {
  const parsed = Number.parseInt(process.env.CDSS_TENANT_AUDIT_MAX_BYTES || "", 10);
  return Number.isFinite(parsed)
    ? Math.max(1_024, Math.min(128_000_000, parsed))
    : DEFAULT_AUDIT_MAX_BYTES;
}

function auditArchiveFiles(): number {
  const parsed = Number.parseInt(process.env.CDSS_TENANT_AUDIT_ARCHIVE_FILES || "", 10);
  return Number.isFinite(parsed)
    ? Math.max(1, Math.min(10, parsed))
    : DEFAULT_AUDIT_ARCHIVE_FILES;
}

async function rotateAuditIfNeeded(target: string, incomingBytes: number): Promise<void> {
  let currentBytes = 0;
  try {
    currentBytes = (await stat(target)).size;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "ENOENT") throw error;
  }
  if (currentBytes + incomingBytes <= auditMaxBytes()) return;

  const archives = auditArchiveFiles();
  for (let index = archives; index >= 1; index -= 1) {
    const from = index === 1 ? target : `${target}.${index - 1}`;
    const to = `${target}.${index}`;
    await rm(to, { force: true });
    try {
      await rename(from, to);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code !== "ENOENT") throw error;
    }
  }
}

export function tenantAuditCustomerHash(clientId: string, customerId: string): string {
  return createHash("sha256").update(`${clientId}\0${customerId}`).digest("hex").slice(0, 32);
}

function tenantAuditRequestIdHash(clientId: string, customerHash: string, requestId: string): string {
  const scopedValue = `tcm-cdss-tenant-audit-request-id\0${clientId}\0${customerHash}\0${requestId}`;
  const secret = process.env.CDSS_API_TOKEN?.trim() || "";
  return (secret.length >= 16
    ? createHmac("sha256", secret).update(scopedValue)
    : createHash("sha256").update(scopedValue))
    .digest("hex")
    .slice(0, 32);
}

export async function recordTenantAuditEvent(
  event: TenantAuditEventInput,
): Promise<void> {
  const requestId = clean(event.requestId, 128);
  const clientId = clean(event.clientId, 64) || "unknown";
  const customerHash = /^[a-f0-9]{32}$/.test(event.customerHash) ? event.customerHash : "invalid";
  const safeEvent: TenantAuditEvent = {
    timestamp: new Date().toISOString(),
    event: event.event,
    clientId,
    customerHash,
    outcome: event.outcome,
    ...(clean(event.code, 80) ? { code: clean(event.code, 80) } : {}),
    ...(requestId
      ? { requestIdHash: tenantAuditRequestIdHash(clientId, customerHash, requestId) }
      : {}),
    ...(clean(event.operationId, 80) ? { operationId: clean(event.operationId, 80) } : {}),
    ...(Number.isSafeInteger(event.itemCount) && Number(event.itemCount) >= 0
      ? { itemCount: Number(event.itemCount) }
      : {}),
    ...(clean(event.inventoryVersion, 128) ? { inventoryVersion: clean(event.inventoryVersion, 128) } : {}),
  };
  const task = appendTail.catch(() => undefined).then(async () => {
    const target = auditPath();
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const line = `${JSON.stringify(safeEvent)}\n`;
    await rotateAuditIfNeeded(target, Buffer.byteLength(line));
    await appendFile(target, line, { mode: 0o600 });
  });
  appendTail = task;
  await task;
}

export async function queryTenantAuditEvents(
  clientId: string,
  customerHash: string,
  limit = 100,
): Promise<TenantAuditEvent[]> {
  const target = auditPath();
  const paths = [
    ...Array.from({ length: auditArchiveFiles() }, (_, index) => `${target}.${auditArchiveFiles() - index}`),
    target,
  ];
  const contents: string[] = [];
  for (const path of paths) {
    try {
      const raw = await readFile(path);
      contents.push(raw.subarray(Math.max(0, raw.length - auditMaxBytes())).toString("utf8"));
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code !== "ENOENT") throw error;
    }
  }
  return contents.join("").split("\n")
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as TenantAuditEvent;
        return parsed.clientId === clientId && parsed.customerHash === customerHash ? [parsed] : [];
      } catch {
        return [];
      }
    })
    .slice(-Math.max(1, Math.min(500, limit)))
    .reverse();
}
