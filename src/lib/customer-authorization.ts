import "server-only";

import { parseCustomerId } from "./customer-id";

const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{3,64}$/;
const MAX_AUTHORIZED_CUSTOMERS = 1_000;
const LOCAL_DEVELOPMENT_CLIENT_ID = "local-development";

export type CustomerAuthorizationStatus = Readonly<{
  configured: boolean;
  valid: boolean;
  clientConfigured: boolean;
  customerCount: number;
  ready: boolean;
}>;

export type CustomerAuthorizationDecision =
  | { ok: true; clientId: string; customerId: string }
  | { ok: false; status: 403; code: "customer_forbidden" }
  | { ok: false; status: 503; code: "customer_authorization_not_configured" };

type ParsedCustomerAuthorization = Readonly<{
  status: CustomerAuthorizationStatus;
  clientId: string;
  allowedCustomerIds: ReadonlySet<string>;
  entirelyUnconfigured: boolean;
}>;

function parseCustomerAuthorization(): ParsedCustomerAuthorization {
  const rawClientId = process.env.CDSS_API_CLIENT_ID?.trim() || "";
  const rawCustomerIds = process.env.CDSS_API_CUSTOMER_IDS?.trim() || "";
  const rawDefaultCustomerId = process.env.CDSS_DEFAULT_CUSTOMER_ID?.trim() || "";
  const configured = rawCustomerIds.length > 0;
  const clientConfigured = CLIENT_ID_PATTERN.test(rawClientId);

  const entries = configured ? rawCustomerIds.split(",").map((entry) => entry.trim()) : [];
  const parsedEntries = entries.map((entry) => parseCustomerId(entry));
  const customerListValid = configured &&
    entries.length <= MAX_AUTHORIZED_CUSTOMERS &&
    entries.every((entry) => entry.length > 0) &&
    parsedEntries.every((entry): entry is string => Boolean(entry)) &&
    new Set(parsedEntries).size === parsedEntries.length;
  const allowedCustomerIds = new Set(customerListValid ? parsedEntries as string[] : []);
  const defaultCustomerId = rawDefaultCustomerId ? parseCustomerId(rawDefaultCustomerId) : undefined;
  const defaultCustomerValid = !rawDefaultCustomerId || Boolean(
    defaultCustomerId && allowedCustomerIds.has(defaultCustomerId),
  );
  const valid = customerListValid && defaultCustomerValid;
  const status = {
    configured,
    valid,
    clientConfigured,
    customerCount: customerListValid ? allowedCustomerIds.size : 0,
    ready: configured && valid && clientConfigured,
  } satisfies CustomerAuthorizationStatus;

  return {
    status,
    clientId: clientConfigured ? rawClientId : "",
    allowedCustomerIds,
    entirelyUnconfigured: !rawClientId && !rawCustomerIds && !rawDefaultCustomerId,
  };
}

/** Non-secret release status. The authorized customer identifiers are deliberately not returned. */
export function getCustomerAuthorizationStatus(): CustomerAuthorizationStatus {
  return parseCustomerAuthorization().status;
}

/**
 * Authorize one already-normalized customer identifier.
 *
 * Local development retains the pre-tenant behavior only when authentication and every customer
 * authorization variable are absent. A partial/invalid configuration never becomes permissive.
 */
export function authorizeCustomerId(
  customerId: string,
  required: boolean,
): CustomerAuthorizationDecision {
  const configuration = parseCustomerAuthorization();
  if (!configuration.status.ready) {
    if (!required && configuration.entirelyUnconfigured) {
      return { ok: true, clientId: LOCAL_DEVELOPMENT_CLIENT_ID, customerId };
    }
    return {
      ok: false,
      status: 503,
      code: "customer_authorization_not_configured",
    };
  }
  if (!configuration.allowedCustomerIds.has(customerId)) {
    return { ok: false, status: 403, code: "customer_forbidden" };
  }
  return { ok: true, clientId: configuration.clientId, customerId };
}
