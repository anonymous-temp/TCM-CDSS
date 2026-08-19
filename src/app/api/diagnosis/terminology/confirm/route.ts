import { confirmControlledTerminologyMapping } from "@/lib/controlled-terminology-confirmation.server";
import { readJsonRequest } from "@/lib/diagnosis-request";
import { normalizeCaseStateInput } from "@/lib/diagnosis-types";
import { requireCustomerContext } from "@/lib/customer-context";

export async function POST(req: Request) {
  const parsed = await readJsonRequest(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body && typeof parsed.body === "object"
    ? parsed.body as {
        caseState?: unknown;
        mapping?: { namespace?: unknown; fieldPath?: unknown; candidateId?: unknown };
      }
    : {};
  const caseState = normalizeCaseStateInput(body.caseState);
  const mapping = body.mapping;
  if (
    !caseState ||
    !mapping ||
    typeof mapping.namespace !== "string" ||
    typeof mapping.fieldPath !== "string" ||
    typeof mapping.candidateId !== "string"
  ) {
    return Response.json({
      error: "caseState and a complete terminology mapping selector are required",
      code: "invalid_terminology_confirmation_request",
    }, { status: 400 });
  }
  const customer = await requireCustomerContext(req, caseState);
  if (!customer.ok) return customer.response;
  caseState.customerId = customer.context.customerId;
  if (mapping.namespace !== "tcm_syndrome" && mapping.namespace !== "icd10") {
    return Response.json({
      error: "This terminology namespace cannot be confirmed through this endpoint",
      code: "terminology_confirmation_target_not_allowed",
    }, { status: 400 });
  }
  const result = confirmControlledTerminologyMapping(caseState, {
    namespace: mapping.namespace,
    fieldPath: mapping.fieldPath,
    candidateId: mapping.candidateId,
  });
  if (!result.ok) {
    return Response.json({ error: result.error, code: result.code }, { status: result.status });
  }
  return Response.json({
    reasoning: result.reasoning,
    restoredFormulaNames: result.restoredFormulaNames,
    prescriptionMustBeRegenerated: true,
  });
}
