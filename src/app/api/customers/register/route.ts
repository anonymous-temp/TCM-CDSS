import { CUSTOMER_ID_HEADER } from "@/lib/customer-id";
import { requireCustomerContext } from "@/lib/customer-context";

export async function POST(req: Request) {
  const customer = await requireCustomerContext(req, undefined, {
    allowJitProvisioning: true,
    forceJitRegistration: true,
    idempotencyKey: req.headers.get("idempotency-key")?.trim() || "",
    requestId: req.headers.get("x-request-id")?.trim() || undefined,
  });
  if (!customer.ok) return customer.response;
  return Response.json({
    customerId: customer.context.customerId,
    status: "active",
    created: Boolean(customer.context.provisioned),
  }, {
    status: customer.context.provisioned ? 201 : 200,
    headers: { [CUSTOMER_ID_HEADER]: customer.context.customerId },
  });
}
