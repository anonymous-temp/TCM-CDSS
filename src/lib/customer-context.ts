import "server-only";

import { createHash } from "node:crypto";
import type { CaseState } from "./diagnosis-types";
import { CUSTOMER_ID_HEADER, parseCustomerId } from "./customer-id";
import { customerIdFromCdssRequestCookie } from "./cdss-auth";

export type CustomerContext = Readonly<{
  customerId: string;
  customerHash: string;
  source: "header" | "cookie";
}>;

export type CustomerContextResult =
  | { ok: true; context: CustomerContext }
  | { ok: false; response: Response };

export function customerIdHash(customerId: string): string {
  return createHash("sha256").update(customerId).digest("hex").slice(0, 32);
}

export async function requireCustomerContext(
  req: Request,
  caseState?: Pick<CaseState, "customerId"> | null,
): Promise<CustomerContextResult> {
  const suppliedHeader = req.headers.get(CUSTOMER_ID_HEADER)?.trim() || "";
  const headerCustomerId = suppliedHeader ? parseCustomerId(suppliedHeader) : undefined;
  if (suppliedHeader && !headerCustomerId) {
    return {
      ok: false,
      response: Response.json({ error: "invalid x-cdss-customer-id", code: "invalid_customer_id" }, { status: 400 }),
    };
  }
  const cookieCustomerId = await customerIdFromCdssRequestCookie(req);
  if (headerCustomerId && cookieCustomerId && headerCustomerId !== cookieCustomerId) {
    return {
      ok: false,
      response: Response.json({ error: "customer identity sources do not match", code: "customer_context_mismatch" }, { status: 409 }),
    };
  }
  const customerId = headerCustomerId || cookieCustomerId;
  if (!customerId) {
    return {
      ok: false,
      response: Response.json({ error: "x-cdss-customer-id required", code: "customer_id_required" }, { status: 400 }),
    };
  }
  if (caseState?.customerId && caseState.customerId !== customerId) {
    return {
      ok: false,
      response: Response.json({ error: "customer context does not match case", code: "customer_context_mismatch" }, { status: 409 }),
    };
  }
  return { ok: true, context: {
    customerId,
    customerHash: customerIdHash(customerId),
    source: headerCustomerId ? "header" : "cookie",
  } };
}
