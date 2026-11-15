import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { createRewriteLedger, installRewriteLedgerResolver, type RewriteLedger } from "./delivery-rewrite-ledger";
import type { GateContext } from "./delivery-gate-types";

const storage = new AsyncLocalStorage<RewriteLedger | undefined>();
installRewriteLedgerResolver(() => storage.getStore());
export function deliveryRewriteLedgerMode(value = process.env.CDSS_DELIVERY_REWRITE_LEDGER): "off" | "memory" | "archive" {
  return value === "memory" || value === "archive" ? value : "off";
}
/** No route is wired here. F owns the complete request scope and controlled persistence. */
export async function withRewriteLedger<T>(context: GateContext, work: () => T | Promise<T>, mode = deliveryRewriteLedgerMode()): Promise<{ value: T; ledger: ReturnType<typeof createRewriteLedger>["events"] }> {
  if (mode === "off") return storage.run(undefined, async () => ({ value: await work(), ledger: [] }));
  const ledger = createRewriteLedger(context);
  return storage.run(ledger, async () => ({ value: await work(), ledger: ledger.events }));
}
