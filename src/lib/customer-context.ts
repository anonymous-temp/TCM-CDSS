import "server-only";

import { createHash } from "node:crypto";
import type { CaseState } from "./diagnosis-types";
import { CUSTOMER_ID_HEADER, parseCustomerId } from "./customer-id";
import { customerIdFromCdssRequestCookie, isCdssAuthRequired } from "./cdss-auth";
import { authorizeCustomerId } from "./customer-authorization";

export type CustomerContext = Readonly<{
  clientId: string;
  customerId: string;
  customerHash: string;
  source: "header" | "cookie" | "default";
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
  const defaultCustomerInput = process.env.CDSS_DEFAULT_CUSTOMER_ID?.trim() || "";
  const defaultCustomerId = defaultCustomerInput ? parseCustomerId(defaultCustomerInput) : undefined;
  if (defaultCustomerInput && !defaultCustomerId) {
    return {
      ok: false,
      response: Response.json(
        { error: "customer authorization is not configured", code: "customer_authorization_not_configured" },
        { status: 503 },
      ),
    };
  }
  const customerId = headerCustomerId || cookieCustomerId || defaultCustomerId;
  if (!customerId) {
    return {
      ok: false,
      response: Response.json({ error: "x-cdss-customer-id required", code: "customer_id_required" }, { status: 400 }),
    };
  }
  const authorization = authorizeCustomerId(customerId, isCdssAuthRequired());
  if (!authorization.ok) {
    return {
      ok: false,
      response: Response.json(
        {
          error: authorization.code === "customer_forbidden"
            ? "customer is not authorized"
            : "customer authorization is not configured",
          code: authorization.code,
        },
        { status: authorization.status },
      ),
    };
  }
  if (caseState?.customerId && caseState.customerId !== customerId) {
    return {
      ok: false,
      response: Response.json({ error: "customer context does not match case", code: "customer_context_mismatch" }, { status: 409 }),
    };
  }
  return { ok: true, context: {
    clientId: authorization.clientId,
    customerId,
    customerHash: customerIdHash(customerId),
    source: headerCustomerId ? "header" : cookieCustomerId ? "cookie" : "default",
  } };
}
