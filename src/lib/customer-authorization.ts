import "server-only";

import { parseCustomerId } from "./customer-id";
import {
  customerJitRegistrationEnabled,
  customerRegistryAvailable,
  registerCustomerForClient,
  registeredCustomerIdsForClient,
  registeredCustomerForClient,
  type RegisterCustomerResult,
} from "./customer-registry.server";
import { recordTenantAuditEvent, tenantAuditCustomerHash } from "./tenant-audit.server";

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
  const jitEnabled = customerJitRegistrationEnabled();
  const registryAvailable = !jitEnabled || customerRegistryAvailable();
  const configured = rawCustomerIds.length > 0 || jitEnabled;
  const clientConfigured = CLIENT_ID_PATTERN.test(rawClientId);

  const entries = rawCustomerIds ? rawCustomerIds.split(",").map((entry) => entry.trim()) : [];
  const parsedEntries = entries.map((entry) => parseCustomerId(entry));
  const customerListValid = (rawCustomerIds.length > 0 || jitEnabled) &&
    entries.length <= MAX_AUTHORIZED_CUSTOMERS &&
    entries.every((entry) => entry.length > 0) &&
    parsedEntries.every((entry): entry is string => Boolean(entry)) &&
    new Set(parsedEntries).size === parsedEntries.length;
  const allowedCustomerIds = new Set(customerListValid ? parsedEntries as string[] : []);
  const defaultCustomerId = rawDefaultCustomerId ? parseCustomerId(rawDefaultCustomerId) : undefined;
  const defaultCustomerValid = !rawDefaultCustomerId || Boolean(
    defaultCustomerId && (
      allowedCustomerIds.has(defaultCustomerId) ||
      clientConfigured && registeredCustomerForClient(rawClientId, defaultCustomerId)
    ),
  );
  const valid = customerListValid && defaultCustomerValid && registryAvailable;
  const registeredCustomerIds = clientConfigured
    ? registeredCustomerIdsForClient(rawClientId)
    : [];
  const status = {
    configured,
    valid,
    clientConfigured,
    customerCount: customerListValid
      ? new Set([...allowedCustomerIds, ...(registeredCustomerIds || [])]).size
      : 0,
    ready: configured && valid && clientConfigured,
  } satisfies CustomerAuthorizationStatus;

  return {
    status,
    clientId: clientConfigured ? rawClientId : "",
    allowedCustomerIds,
    entirelyUnconfigured: !rawClientId && !rawCustomerIds && !rawDefaultCustomerId && !jitEnabled,
  };
}

/** Non-secret release status. The authorized customer identifiers are deliberately not returned. */
export function getCustomerAuthorizationStatus(): CustomerAuthorizationStatus {
  return parseCustomerAuthorization().status;
}

/**
 * Return the canonical customer identifiers available to an already-authenticated browser login.
 *
 * Callers must verify the shared access token before invoking this helper. Keeping the lookup here
 * avoids weakening parseCustomerId or inventing unstable numeric aliases for tenant identifiers.
 */
export function authorizedCustomerIdsForAuthenticatedLogin(): string[] {
  const configuration = parseCustomerAuthorization();
  if (!configuration.status.ready) return [];
  return [...new Set([
    ...configuration.allowedCustomerIds,
    ...(registeredCustomerIdsForClient(configuration.clientId) || []),
  ])].sort((left, right) => left.localeCompare(right));
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
  const normalizedCustomerId = parseCustomerId(customerId);
  if (!normalizedCustomerId || normalizedCustomerId !== customerId) {
    return { ok: false, status: 403, code: "customer_forbidden" };
  }
  const configuration = parseCustomerAuthorization();
  if (!configuration.status.ready) {
    if (!required && configuration.entirelyUnconfigured) {
      return {
        ok: true,
        clientId: LOCAL_DEVELOPMENT_CLIENT_ID,
        customerId: normalizedCustomerId,
      };
    }
    return {
      ok: false,
      status: 503,
      code: "customer_authorization_not_configured",
    };
  }
  if (!configuration.allowedCustomerIds.has(normalizedCustomerId) &&
      !registeredCustomerForClient(configuration.clientId, normalizedCustomerId)) {
    return { ok: false, status: 403, code: "customer_forbidden" };
  }
  return {
    ok: true,
    clientId: configuration.clientId,
    customerId: normalizedCustomerId,
  };
}

export async function provisionCustomerId(
  customerId: string,
  idempotencyKey: string,
  requestId?: string,
): Promise<RegisterCustomerResult> {
  const normalizedCustomerId = parseCustomerId(customerId);
  const configuration = parseCustomerAuthorization();
  if (!normalizedCustomerId || normalizedCustomerId !== customerId || !configuration.status.ready) {
    return {
      ok: false,
      status: 503,
      code: "customer_registry_unavailable",
      error: "customer authorization is not configured",
    };
  }
  const customerHash = tenantAuditCustomerHash(configuration.clientId, normalizedCustomerId);
  let activationAudited = false;
  const result = await registerCustomerForClient({
    clientId: configuration.clientId,
    customerId: normalizedCustomerId,
    idempotencyKey,
    staticCustomerIds: [...configuration.allowedCustomerIds],
    beforeActivate: async (customer) => {
      await recordTenantAuditEvent({
        event: "customer_registration",
        clientId: configuration.clientId,
        customerHash,
        outcome: "pending",
        code: customer.authorizationSource === "static" ? "static_binding_started" : "provisioning_started",
        requestId,
      });
      activationAudited = true;
    },
  });
  if (activationAudited) {
    try {
      await recordTenantAuditEvent({
        event: "customer_registration",
        clientId: configuration.clientId,
        customerHash,
        outcome: result.ok ? "accepted" : "failed",
        code: result.ok ? (result.created ? "created" : "already_active") : result.code,
        requestId,
      });
    } catch {
      console.error("[tcm-cdss:audit] customer registration completion pending", {
        clientId: configuration.clientId,
        customerHash,
        outcome: result.ok ? "accepted" : "failed",
      });
    }
  } else {
    try {
      await recordTenantAuditEvent({
        event: "customer_registration",
        clientId: configuration.clientId,
        customerHash,
        outcome: result.ok ? "accepted" : "rejected",
        code: result.ok ? (result.created ? "created" : "already_active") : result.code,
        requestId,
      });
    } catch {
      console.error("[tcm-cdss:audit] customer registration audit unavailable", {
        clientId: configuration.clientId,
        customerHash,
        outcome: result.ok ? "accepted" : "rejected",
      });
    }
  }
  return result;
}
