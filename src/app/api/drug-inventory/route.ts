import { randomUUID } from "node:crypto";
import { readJsonBodyWithLimit } from "@/lib/http-guard";
import { drugInventorySnapshot, importDrugInventory, validateDrugInventoryPayload } from "@/lib/drug-inventory.server";
import { requireCustomerContext } from "@/lib/customer-context";
import { CUSTOMER_ID_HEADER } from "@/lib/customer-id";
import {
  recordTenantAuditEvent,
  tenantAuditCustomerHash,
} from "@/lib/tenant-audit.server";

/**
 * 院内药品库存导入（甲方 2026-08-05「药品同步接口」入站方向）。
 *
 * 甲方把医院库存药推进来，开方时优先落在有货药味上；缺货药**不静默替换**，
 * 而是标注缺货并给出受治理替代候选（判据见 src/lib/drug-inventory.server.ts 顶部）。
 *
 * 本路由在 src/proxy.ts 的 /api/:path* matcher 覆盖内，鉴权与限流沿用既有链路。
 */

// 2 万条药品条目的 JSON 上限。按院内中药饮片 + 中成药常见规模留足余量，
// 超限明确回 413 并给出**分片整批替换**通路，而不是截断——截断会让被截掉的药全部变成「缺货」。
// 注意「分片」不等于「分批各自落盘」：本接口是整批替换，分片只写暂存，集齐才提交一次
// （甲方 2026-08-10 ⑫④：旧 413 文案 split into batches 会让第一批被第二批整体覆盖）。
const MAX_BODY_BYTES = 8_000_000;

function customerJsonResponse(
  customerId: string,
  body: unknown,
  init?: ResponseInit,
): Response {
  const headers = new Headers(init?.headers);
  headers.set(CUSTOMER_ID_HEADER, customerId);
  return Response.json(body, { ...init, headers });
}

async function tryRecordInventoryAudit(
  event: Parameters<typeof recordTenantAuditEvent>[0],
): Promise<boolean> {
  try {
    await recordTenantAuditEvent(event);
    return true;
  } catch {
    console.error("[tcm-cdss:audit] inventory audit completion pending", {
      clientId: event.clientId,
      customerHash: event.customerHash,
      operationId: event.operationId,
      outcome: event.outcome,
    });
    return false;
  }
}

export async function POST(req: Request) {
  const idempotencyKey = req.headers.get("idempotency-key")?.trim() || "";
  const requestId = req.headers.get("x-request-id")?.trim() || undefined;
  const parsed = await readJsonBodyWithLimit(req, MAX_BODY_BYTES);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body && typeof parsed.body === "object" && !Array.isArray(parsed.body)
    ? parsed.body as { source?: unknown; items?: unknown; part?: unknown }
    : {};
  // PROV-08（甲方 2026-08-24 验收）：载荷内在的 4xx/413 必须先于 requireCustomerContext 的
  // JIT 登记，否则一次失败的首提交会留下已激活、可正常 GET 的空租户。此时尚无客户上下文，
  // 响应不带 x-cdss-customer-id 头。
  const invalidPayload = validateDrugInventoryPayload(body);
  if (invalidPayload) {
    return Response.json({
      error: invalidPayload.error,
      code: invalidPayload.code,
      ...(invalidPayload.rejectedEntries
        ? { rejectedEntries: invalidPayload.rejectedEntries, rejectedEntryCount: invalidPayload.rejectedEntryCount }
        : {}),
    }, { status: invalidPayload.status });
  }
  const customer = await requireCustomerContext(req, undefined, {
    allowJitProvisioning: true,
    idempotencyKey,
    requestId,
  });
  if (!customer.ok) return customer.response;
  const auditCustomerHash = tenantAuditCustomerHash(
    customer.context.clientId,
    customer.context.customerId,
  );
  const operationId = randomUUID();
  const intentRecorded = await tryRecordInventoryAudit({
    event: "inventory_import",
    clientId: customer.context.clientId,
    customerHash: auditCustomerHash,
    outcome: "pending",
    code: "inventory_import_started",
    requestId,
    operationId,
  });
  if (!intentRecorded) {
    return customerJsonResponse(customer.context.customerId, {
      error: "tenant audit is unavailable; inventory was not changed",
      code: "tenant_audit_unavailable",
    }, { status: 503 });
  }

  const result = await importDrugInventory(customer.context.customerId, body);
  if (!result.ok) {
    await tryRecordInventoryAudit({
      event: "inventory_import",
      clientId: customer.context.clientId,
      customerHash: auditCustomerHash,
      outcome: "rejected",
      code: result.code,
      requestId,
      operationId,
    });
    return Response.json({
      error: result.error,
      code: result.code,
      ...(result.rejectedEntries
        ? { rejectedEntries: result.rejectedEntries, rejectedEntryCount: result.rejectedEntryCount }
        : {}),
    }, { status: result.status });
  }
  if ("pending" in result) {
    const auditFinalized = await tryRecordInventoryAudit({
      event: "inventory_import",
      clientId: customer.context.clientId,
      customerHash: auditCustomerHash,
      outcome: "pending",
      code: "inventory_part_staged",
      requestId,
      operationId,
      itemCount: result.pending.bufferedItemCount,
    });
    // 202：分片已收下但还没到齐。线上库存此刻**未被改动**，这一点必须显式回给甲方，
    // 否则「收到 200」会被理解成「这一批已经生效」，正是旧文案造成的误解。
    return customerJsonResponse(customer.context.customerId, {
      ...result.pending,
      // PROV 计划字段：本次请求完成了 JIT 登记时显式告知调用方。
      ...(customer.context.provisioned ? { customerRegistered: true } : {}),
      ...(!auditFinalized ? { auditStatus: "pending_reconciliation" } : {}),
      note: `已暂存第 ${result.pending.receivedParts.join("、")} 片，仍缺第 ${result.pending.missingParts.join("、")} 片。`
        + " 集齐全部分片后系统才会做一次整批替换；在此之前线上库存保持上一版本不变。",
    }, { status: 202 });
  }
  const auditFinalized = await tryRecordInventoryAudit({
    event: "inventory_import",
    clientId: customer.context.clientId,
    customerHash: auditCustomerHash,
    outcome: "accepted",
    requestId,
    operationId,
    itemCount: result.snapshot.itemCount,
    inventoryVersion: result.snapshot.inventoryVersion,
  });
  return customerJsonResponse(customer.context.customerId, {
    ...result.snapshot,
    // PROV 计划字段：本次请求完成了 JIT 登记时显式告知调用方。
    ...(customer.context.provisioned ? { customerRegistered: true } : {}),
    ...(!auditFinalized ? { auditStatus: "pending_reconciliation" } : {}),
    // 归一不到与歧义的药名如实回报，供甲方补映射。静默吞掉会让这些药永远处于「缺货」，
    // 而甲方无从知道是自己没推还是我们没认出来。
    note: result.snapshot.unresolvedNames.length > 0 || result.snapshot.ambiguousNames.length > 0
      ? "部分院内药名未能归一到标准正名（unresolvedNames）或存在多个候选（ambiguousNames）。"
        + "系统不会替这些名字自动择一；它们不参与正名级匹配，请补充映射后重新导入。"
      : undefined,
  });
}

export async function GET(req: Request) {
  const customer = await requireCustomerContext(req);
  if (!customer.ok) return customer.response;
  const snapshot = await drugInventorySnapshot(customer.context.customerId);
  await recordTenantAuditEvent({
    event: "inventory_read",
    clientId: customer.context.clientId,
    customerHash: tenantAuditCustomerHash(customer.context.clientId, customer.context.customerId),
    outcome: "accepted",
    requestId: req.headers.get("x-request-id")?.trim() || undefined,
    ...(snapshot
      ? { itemCount: snapshot.itemCount, inventoryVersion: snapshot.inventoryVersion }
      : {}),
  });
  if (!snapshot) {
    return customerJsonResponse(customer.context.customerId, {
      inventoryLoaded: false,
      // 未导入不是错误状态：可得性不是安全控制，缺库存数据时链路行为与导入前完全一致。
      note: "尚未导入院内库存。当前所有药味的可得性标为 unknown，开方链路行为与未接库存时一致。",
    });
  }
  return customerJsonResponse(customer.context.customerId, { inventoryLoaded: true, ...snapshot });
}
