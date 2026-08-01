import { readJsonRequest } from "@/lib/diagnosis-request";
import { normalizeCaseStateInput } from "@/lib/diagnosis-types";
import { issueEmergencyClearance, stripInvalidEmergencyClearance } from "@/lib/emergency-clearance.server";

export async function POST(req: Request) {
  const parsed = await readJsonRequest(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body && typeof parsed.body === "object"
    ? parsed.body as { caseState?: unknown; assessmentSummary?: unknown }
    : {};
  const normalized = normalizeCaseStateInput(body.caseState);
  if (!normalized || typeof body.assessmentSummary !== "string") {
    return Response.json({
      error: "caseState and assessmentSummary are required",
      code: "invalid_emergency_clearance_request",
    }, { status: 400 });
  }
  const result = issueEmergencyClearance(
    stripInvalidEmergencyClearance(normalized),
    body.assessmentSummary,
  );
  if (!result.ok) {
    return Response.json({ error: result.error, code: result.code }, { status: result.status });
  }
  return Response.json({ emergencyClearance: result.clearance });
}
