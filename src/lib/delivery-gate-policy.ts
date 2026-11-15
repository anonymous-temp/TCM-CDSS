import type { GateMode } from "./delivery-gate-types";

const mode = (value: string | undefined, fallback: GateMode): GateMode =>
  value === "false" || value === "off" ? "off" : value === "true" || value === "enforce" ? "enforce" : value === "shadow" ? "shadow" : fallback;
/** Freeze once per request. Semantic deletion and quality rejection stay shadow until paired vendor precision/coverage and bounded-tier delivery are measured. */
export function deliveryGatePolicy(env: Record<string, string | undefined> = process.env) {
  const total = mode(env.CDSS_DELIVERY_GATES, "enforce");
  const limited = (value: string | undefined, fallback: GateMode): GateMode => {
    const child = mode(value, fallback);
    return total === "off" || child === "off" ? "off" : total === "shadow" ? "shadow" : child;
  };
  const timeout = Number(env.CDSS_DELIVERY_GATE_TIMEOUT_MS ?? 900);
  return { version: "r1064-wire-v1", mode: total,
    integrity: limited(env.CDSS_REWRITE_INTEGRITY, "shadow"),
    facts: limited(env.CDSS_FINAL_PATIENT_FACTS, "shadow"),
    invariants: limited(env.CDSS_DELIVERY_INVARIANTS, "shadow"),
    ledger: total === "off" || env.CDSS_DELIVERY_REWRITE_LEDGER === "off" || env.CDSS_DELIVERY_REWRITE_LEDGER === "false" ? "off" as const : "memory" as const,
    incremental: env.CDSS_DELIVERY_GATE_INCREMENTAL !== "false",
    timeoutMs: Number.isFinite(timeout) ? Math.max(1, Math.min(900, timeout)) : 900,
  };
}
