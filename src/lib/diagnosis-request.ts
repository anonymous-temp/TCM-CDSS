import { canonicalizeInputKeyCase, normalizeCaseStateInput, type CaseState } from "./diagnosis-types";
import { recoverUnreadableVitals } from "./input-vitals-recovery.server";
import { stripInvalidEmergencyClearance } from "./emergency-clearance.server";
import { readJsonBodyWithLimit } from "./http-guard";
import { archiveClinicalRequest } from "./request-archive.server";
import { INTERNAL_PRECOMPUTE_HEADER, isInternalPrecomputeRequest } from "./internal-precompute";
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
  const parsed = await readJsonBodyWithLimit(req, opts?.maxBytes ?? 1_000_000);
  // 临床请求内容留存（owner 2026-10-12）：所有临床路由的请求体都从这里进来。不 await，不影响时延与结果。
  // 服务端自己发起的预先计算请求不是调用方发的，不进留存。
  if (parsed.ok) {
    if (!req.headers.has(INTERNAL_PRECOMPUTE_HEADER)) {
      void archiveClinicalRequest(req, parsed.body);
    } else {
      // 带了标记头的请求核对标记值：对不上的不是服务端自己发的，照常留存。
      void isInternalPrecomputeRequest(req.headers).then((internal) => {
        if (!internal) void archiveClinicalRequest(req, parsed.body);
      });
    }
  }
  return parsed;
}

export async function readCaseStateRequest(req: Request): Promise<CaseStateRequestResult> {
  const parsed = await readJsonRequest(req);
  if (!parsed.ok) return parsed;

  const body = parsed.body && typeof parsed.body === "object" ? parsed.body as { caseState?: unknown } : {};
  if (body.caseState == null) {
    return { ok: false, response: Response.json({ error: "caseState required" }, { status: 400 }) };
  }

  // 键名大小写与文档不同的已知键照样读（normalizeCaseStateInput 内部同一个函数）；这里只记被改名的路径，便于告诉调用方。
  const keyCase = canonicalizeInputKeyCase(body.caseState);
  if (keyCase.renamed.length > 0) {
    console.warn("[tcm-cdss:telemetry] input_key_case_normalized", { paths: keyCase.renamed.slice(0, 16), count: keyCase.renamed.length });
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
  // 生命体征传来的不是数值时，从同一租户同一病例最近一次请求补回（用户 2026-10-26 D2）。
  const rawCaseState = parsed.body && typeof parsed.body === "object" ? (parsed.body as { caseState?: unknown }).caseState : undefined;
  tenantBoundState = recoverUnreadableVitals(tenantBoundState, rawCaseState, customer.context.customerId || "-");
  if (tenantBoundState.clinicalFacts && !clinicalFactsTenantBindingMatches(
    tenantBoundState.clinicalFacts,
    customer.context.customerId,
  )) {
    tenantBoundState = { ...tenantBoundState, clinicalFacts: undefined };
  }
  return { ...parsed, caseState: tenantBoundState, customer: customer.context };
}
