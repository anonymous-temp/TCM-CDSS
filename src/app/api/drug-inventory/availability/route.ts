import { requireCustomerContext } from "@/lib/customer-context";
import { inventoryAvailabilityView, type DrugInventoryItemKind } from "@/lib/drug-inventory.server";
import { readJsonBodyWithLimit } from "@/lib/http-guard";
import { recordTenantAuditEvent, tenantAuditCustomerHash } from "@/lib/tenant-audit.server";

export const runtime = "nodejs";

/**
 * 按药名查院内库存状态（2026-09-28，甲方：页面药名旁显示「院内有货 / 缺货 / 库存外用药」）。
 *
 * 只读、不调模型、不进签名合同：页面在方案出来后单独请求一次，失败就不显示标签，
 * 不影响任何诊疗结果。HIS 方案出参里的 herbAvailability / medicineAvailability 与这里同一判据。
 */
const MAX_BODY_BYTES = 32 * 1024;
const MAX_ITEMS = 100;
const KINDS: ReadonlySet<string> = new Set(["herb", "patent", "western"]);

function customerJsonResponse(customerId: string, body: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("x-cdss-customer-id", customerId);
  headers.set("cache-control", "no-store");
  return Response.json(body, { ...init, headers });
}

export async function POST(req: Request) {
  const parsed = await readJsonBodyWithLimit(req, MAX_BODY_BYTES);
  if (!parsed.ok) return parsed.response;
  const rawItems = parsed.body && typeof parsed.body === "object" && !Array.isArray(parsed.body)
    ? (parsed.body as { items?: unknown }).items
    : undefined;
  if (!Array.isArray(rawItems) || rawItems.length > MAX_ITEMS) {
    return Response.json(
      { error: `items must be an array of at most ${MAX_ITEMS} {name, kind}`, code: "invalid_availability_items" },
      { status: 400 },
    );
  }
  const items = rawItems.flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const entry = raw as { name?: unknown; kind?: unknown };
    const name = typeof entry.name === "string" ? entry.name.trim().slice(0, 120) : "";
    const kind = typeof entry.kind === "string" && KINDS.has(entry.kind) ? entry.kind as DrugInventoryItemKind : undefined;
    return name && kind ? [{ name, kind }] : [];
  });
  const customer = await requireCustomerContext(req);
  if (!customer.ok) return customer.response;
  const view = await inventoryAvailabilityView(customer.context.customerId);
  await recordTenantAuditEvent({
    event: "inventory_read",
    clientId: customer.context.clientId,
    customerHash: tenantAuditCustomerHash(customer.context.clientId, customer.context.customerId),
    outcome: "accepted",
    code: "availability_lookup",
    requestId: req.headers.get("x-request-id")?.trim() || undefined,
    itemCount: items.length,
  }).catch(() => undefined);
  return customerJsonResponse(customer.context.customerId, {
    inventoryLoaded: view.inventoryLoaded,
    ...(view.inventoryLoaded
      ? { inventoryVersion: view.inventoryVersion, coverage: view.coverage, stale: view.stale, ...(view.ageDays !== undefined ? { ageDays: view.ageDays } : {}) }
      : {}),
    items: items.map((item) => ({ ...item, ...view.statusOf(item.name, item.kind) })),
  });
}
