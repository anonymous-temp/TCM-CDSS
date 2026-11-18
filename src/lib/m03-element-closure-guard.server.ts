import "server-only";

import { isSafetyRejection } from "./diagnosis-rejection-tiers";
import { m03KeySyndromeDiscriminatorIssue, m03SafetyContractIssue, m03SemanticIssue } from "./diagnosis-stage-contract";
import { normalizeReasoningV2, reasoningV2SchemaIssueCode } from "./diagnosis-types";
import { closureObject, type ClosureJson } from "./m03-element-assertions";

const requiredFields = [
  ["pathogenesis", "natureDifferentiation", "items"],
  ["pathogenesis", "locationDifferentiation", "items"],
  ["pathogenesis", "locationDifferentiation", "details"],
  ["pathogenesis", "chain"], ["pathogenesis", "summary"],
  ["overview", "overallPathogenesis"], ["overview", "overallTherapy"],
  ["therapy", "overallPrinciple"], ["therapy", "overallMethod"], ["therapy", "subTherapies"],
];

function populated(root: ClosureJson, path: string[]): boolean {
  const field = path.reduce<unknown>((value, key) => closureObject(value)?.[key], root);
  return Array.isArray(field) ? field.length > 0 : typeof field === "string" && Boolean(field.trim());
}

function rejection(root: ClosureJson, record: string) {
  const schema = reasoningV2SchemaIssueCode(root);
  if (schema) return schema;
  const normalized = normalizeReasoningV2(root);
  const hard = m03SafetyContractIssue(normalized, record, isSafetyRejection);
  if (hard) return hard;
  const issue = m03SemanticIssue(normalized, record);
  return issue && isSafetyRejection(issue) ? issue : undefined;
}

/** The caller discards the entire tentative edit. Pre-existing faults still go
 * through the ordinary M03 contract and its own repair/limited-page policy. */
export function closureGuardReason(before: ClosureJson, after: ClosureJson, record: string): string | undefined {
  const emptied = requiredFields.find(path => populated(before, path) && !populated(after, path));
  if (emptied) return emptied.join("/");
  const hasNature = (root: ClosureJson) => ["items", "rootDeficiency", "branchExcess"]
    .some(key => populated(root, ["pathogenesis", "natureDifferentiation", key]));
  if (hasNature(before) && !hasNature(after)) return "pathogenesis/natureDifferentiation";
  if (m03KeySyndromeDiscriminatorIssue(after, record) && !m03KeySyndromeDiscriminatorIssue(before, record)) return "chain_key_discriminator_missing";
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  const issue = rejection(after, record);
  return issue && issue !== rejection(before, record) ? issue : undefined;
}
