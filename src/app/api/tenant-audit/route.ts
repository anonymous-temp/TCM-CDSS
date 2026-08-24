import { requireCustomerContext } from "@/lib/customer-context";
import { queryTenantAuditEvents, tenantAuditCustomerHash } from "@/lib/tenant-audit.server";

export async function GET(req: Request) {
  const customer = await requireCustomerContext(req);
  if (!customer.ok) return customer.response;
  const url = new URL(req.url);
  const requestedLimit = Number.parseInt(url.searchParams.get("limit") || "100", 10);
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(500, requestedLimit)) : 100;
  const events = await queryTenantAuditEvents(
    customer.context.clientId,
    tenantAuditCustomerHash(customer.context.clientId, customer.context.customerId),
    limit,
  );
  return Response.json({ customerId: customer.context.customerId, events }, {
    headers: { "x-cdss-customer-id": customer.context.customerId },
  });
}
