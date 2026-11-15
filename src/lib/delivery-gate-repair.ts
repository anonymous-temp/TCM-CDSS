import type { InvariantFinding } from "./delivery-invariants";
import { asRecord, collectDeliveryText, pointerValue, stableDeliveryJson, type DeliveryJson } from "./delivery-text";

export type DeliveryRepairRequest = {
  owner: InvariantFinding["repairOwner"]; operation: "rewrite_fields" | "append_differentials" | "restore_ownership" | "repair_references" | "delete_sentence";
  findingIds: string[]; allowedPaths: string[]; lockedPaths: string[]; expected: Array<{ path: string; value: unknown }>;
  maxAttempts: 1; snapshot: string;
  preserve: { conclusions: true; herbTable: true; safety: true; citations: true };
};
export type DeliveryRepairPlan = { requests: DeliveryRepairRequest[]; unresolved: InvariantFinding[] };
/** Returns requests for F's existing retry/quality budget. Never calls models, edits prescriptions, promotes T1, or grants adoption. */
export function findingsToDeliveryRepairRequests(findings: readonly InvariantFinding[], snapshot: { m03?: unknown; m04?: unknown }, mode: "off" | "shadow" | "enforce" = "shadow"): DeliveryRepairPlan {
  if (mode !== "enforce") return { requests: [], unresolved: [...findings] };
  const requests: DeliveryRepairRequest[] = [];
  const unresolved: InvariantFinding[] = [];
  for (const [index, finding] of findings.entries()) {
    if (finding.mode !== "enforce" || finding.status !== "violation" || finding.ruleId === "R11" || finding.repairOwner === "governance") { unresolved.push(finding); continue; }
    const locks = ["/m03/overview/primarySyndrome", "/m03/overview/secondarySyndromes", "/m03/overview/tcmDiseaseName", "/m03/therapy/overallMethod", "/m04/formula/candidates", "/m03/safetyGate", "/m04/safetyGate", "/m03/clinicalReview", "/m04/clinicalReview"];
    let allowedPaths = [finding.path];
    let operation: DeliveryRepairRequest["operation"] = "rewrite_fields";
    if (finding.repairOwner === "formula") {
      // Only formulaAnalysis is writable; a model cannot re-add a withdrawn herb to justify prose.
      if (!/\/formula\/candidates\/\d+\/formulaAnalysis$/u.test(finding.path)) { unresolved.push(finding); continue; }
      const candidatePath = finding.path.slice(0, finding.path.lastIndexOf("/"));
      const candidate = asRecord(pointerValue(snapshot, candidatePath));
      locks.splice(locks.indexOf("/m04/formula/candidates"), 1);
      for (const key of Object.keys(candidate)) if (key !== "formulaAnalysis") locks.push(`${candidatePath}/${key}`);
    } else if (finding.repairOwner === "ownership") operation = "restore_ownership";
    else if (finding.repairOwner === "differentials") { operation = "append_differentials"; if (finding.ruleId !== "R09") operation = "rewrite_fields"; }
    else if (finding.repairOwner === "references") {
      operation = "repair_references";
      locks.splice(locks.indexOf("/m04/formula/candidates"), 1);
    }
    else if (finding.repairOwner === "integrity") {
      operation = "delete_sentence";
      if (/\/formula\/candidates\/\d+\/formulaAnalysis$/u.test(finding.path)) locks.splice(locks.indexOf("/m04/formula/candidates"), 1);
    }
    else if (finding.repairOwner === "modifications") {
      // Trigger and source must be repaired together, using HPI only; the item may instead be removed.
      const rowPath = finding.path.slice(0, finding.path.lastIndexOf("/"));
      allowedPaths = [`${rowPath}/trigger`, `${rowPath}/triggerSource`];
    }
    if (allowedPaths.some((path) => locks.some((lock) => path === lock || path.startsWith(`${lock}/`)))) { unresolved.push(finding); continue; }
    requests.push({ owner: finding.repairOwner, operation, findingIds: [`${finding.ruleId}:${index}`], allowedPaths, lockedPaths: locks,
      expected: [{ path: finding.path, value: finding.expected }], maxAttempts: 1, snapshot: stableDeliveryJson(snapshot),
      preserve: { conclusions: true, herbTable: true, safety: true, citations: true } });
  }
  return { requests, unresolved };
}
/** Validation after a scoped repair is separate from the old clinical acceptance conditions, which still apply. */
export function deliveryRepairStayedInScope(before: unknown, after: unknown, request: DeliveryRepairRequest): boolean {
  if (stableDeliveryJson(before) !== request.snapshot) return false;
  const same = (path: string) => stableDeliveryJson(pointerValue(before, path)) === stableDeliveryJson(pointerValue(after, path));
  if (request.lockedPaths.some((path) => !same(path))) return false;
  if (request.operation === "restore_ownership") {
    if (request.expected.some((entry) => stableDeliveryJson(pointerValue(after, entry.path)) !== stableDeliveryJson(entry.value))) return false;
  } else {
    const protectedRoles = new Set(["source_citation", "verbatim_record", "deterministic_safety"]);
    const beforeProtected = collectDeliveryText(before).filter((entry) => protectedRoles.has(entry.role));
    const afterProtected = collectDeliveryText(after).filter((entry) => protectedRoles.has(entry.role));
    if (stableDeliveryJson(beforeProtected) !== stableDeliveryJson(afterProtected)) return false;
  }
  const visit = (left: unknown, right: unknown, path: string): boolean => {
    if (stableDeliveryJson(left) === stableDeliveryJson(right)) return true;
    if (request.allowedPaths.includes(path)) {
      if (request.operation === "append_differentials") return Array.isArray(left) && Array.isArray(right) && right.length >= left.length && left.every((item, index) => stableDeliveryJson(item) === stableDeliveryJson(right[index]));
      return true;
    }
    if (!left || !right || typeof left !== "object" || typeof right !== "object" || Array.isArray(left) !== Array.isArray(right)) return false;
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    return [...keys].every((key) => visit((left as DeliveryJson)[key], (right as DeliveryJson)[key], `${path}/${key.replace(/~/gu, "~0").replace(/\//gu, "~1")}`));
  };
  return visit(before, after, "");
}
