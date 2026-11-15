import { currentModelCallMemoScope, forgetModelCallsInScope } from "./model-call-memo.server";
import { AsyncLocalStorage } from "node:async_hooks";
const outcomes = new AsyncLocalStorage<{ reusable: boolean }>();
export function withStageGenerationOutcome<T>(outcome: { reusable: boolean }, work: () => T): T {
  return outcomes.run(outcome, work);
}
/** Internal only; no extra fields in NDJSON, the clinical payload or HMAC schema. */
export function markStageGenerationNonReusable(): void {
  const outcome = outcomes.getStore();
  if (outcome) outcome.reusable = false;
  // Dev/tests may disable stage coalescing while model-call memo remains enabled.
  void forgetModelCallsInScope(currentModelCallMemoScope());
}
