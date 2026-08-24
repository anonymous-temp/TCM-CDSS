import { normalizeCaseStateInput, type CaseState } from "./diagnosis-types";
import { stripInvalidEmergencyClearance } from "./emergency-clearance.server";
import { readJsonBodyWithLimit } from "./http-guard";
import { requireCustomerContext, type CustomerContext } from "./customer-context";
import { clinicalFactsTenantBindingMatches } from "./clinical-facts-runtime";

export type CaseStateRequestResult =
  // body 原样带出：契约版本协商这类**非临床**的请求级选项要在路由里读，
  // 而重新读一遍 req.body 是不行的（流已被消费）。caseState 仍是唯一的临床入口。
  | { ok: true; caseState: CaseState; body: unknown }
  | { ok: false; response: Response };

export async function readJsonRequest(
  req: Request,
  opts?: { maxBytes?: number },
): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  return readJsonBodyWithLimit(req, opts?.maxBytes ?? 1_000_000);
}

export async function readCaseStateRequest(req: Request): Promise<CaseStateRequestResult> {
  const parsed = await readJsonRequest(req);
  if (!parsed.ok) return parsed;

  const body = parsed.body && typeof parsed.body === "object" ? parsed.body as { caseState?: unknown } : {};
  if (body.caseState == null) {
    return { ok: false, response: Response.json({ error: "caseState required" }, { status: 400 }) };
  }

  const caseState = normalizeCaseStateInput(body.caseState);
  if (!caseState) {
    return { ok: false, response: Response.json({ error: "caseState must be an object" }, { status: 400 }) };
  }

  // Tenant-bound attestations cannot be verified until the authenticated customer context has
  // replaced the caller-controlled customerId. The customer-bound wrapper performs that step.
  return { ok: true, caseState, body: parsed.body };
}

export type CustomerBoundCaseStateRequestResult =
  | { ok: true; caseState: CaseState; body: unknown; customer: CustomerContext }
  | { ok: false; response: Response };

export async function readCustomerBoundCaseStateRequest(
  req: Request,
): Promise<CustomerBoundCaseStateRequestResult> {
  const parsed = await readCaseStateRequest(req);
  if (!parsed.ok) return parsed;
  const customer = await requireCustomerContext(req, parsed.caseState);
  if (!customer.ok) return customer;
  let tenantBoundState = stripInvalidEmergencyClearance({
    ...parsed.caseState,
    customerId: customer.context.customerId,
  });
  if (tenantBoundState.clinicalFacts && !clinicalFactsTenantBindingMatches(
    tenantBoundState.clinicalFacts,
    customer.context.customerId,
  )) {
    tenantBoundState = { ...tenantBoundState, clinicalFacts: undefined };
  }
  return { ...parsed, caseState: tenantBoundState, customer: customer.context };
}
