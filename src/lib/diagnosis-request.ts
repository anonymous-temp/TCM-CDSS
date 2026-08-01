import { normalizeCaseStateInput, type CaseState } from "./diagnosis-types";
import { stripInvalidEmergencyClearance } from "./emergency-clearance.server";
import { readJsonBodyWithLimit } from "./http-guard";

export type CaseStateRequestResult =
  | { ok: true; caseState: CaseState }
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

  return { ok: true, caseState: stripInvalidEmergencyClearance(caseState) };
}
