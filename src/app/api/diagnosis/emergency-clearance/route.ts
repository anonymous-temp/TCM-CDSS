import { readJsonRequest } from "@/lib/diagnosis-request";
import { normalizeCaseStateInput } from "@/lib/diagnosis-types";
import { issueEmergencyClearance, stripInvalidEmergencyClearance } from "@/lib/emergency-clearance.server";
import { requireCustomerContext } from "@/lib/customer-context";
import { withClinicalResponseArchive } from "@/lib/request-archive.server";

async function handlePost(req: Request) {
  const parsed = await readJsonRequest(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body && typeof parsed.body === "object"
    ? parsed.body as { caseState?: unknown; assessmentSummary?: unknown; findings?: unknown }
    : {};
  const normalized = normalizeCaseStateInput(body.caseState);
  if (!normalized || typeof body.assessmentSummary !== "string") {
    return Response.json({
      error: "caseState and assessmentSummary are required",
      code: "invalid_emergency_clearance_request",
    }, { status: 400 });
  }
  const customer = await requireCustomerContext(req, normalized);
  if (!customer.ok) return customer.response;
  normalized.customerId = customer.context.customerId;
  // findings 是逐条红旗的处置留痕，缺省即由内容契约判为不受理（emergency-clearance-contract.ts）。
  // 这里不预先 400，是为了让调用方拿到具体的契约码与可读原因，而不是一句 "invalid request"。
  const result = issueEmergencyClearance(
    stripInvalidEmergencyClearance(normalized),
    body.assessmentSummary,
    body.findings,
  );
  if (!result.ok) {
    // details：当前要逐条处置的红旗、处置方式取值、逐处问题——调用方据此一次改对。
    return Response.json({ error: result.error, code: result.code, ...(result.details || {}) }, { status: result.status });
  }
  if (result.clearance === null) {
    // 当前没有需要解除的红旗：200 + emergencyClearance:null，流程照常继续（原先 409）。
    return Response.json({ emergencyClearance: null, notRequired: true, message: result.message });
  }
  return Response.json({ emergencyClearance: result.clearance });
}

// 临床请求与响应都加密留存（用户 2026-10-26 D3），见 request-archive.server.ts。
export const POST = withClinicalResponseArchive(handlePost);
