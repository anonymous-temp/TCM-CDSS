/** Shared presentation policy. Closed-set selection stays opt-in until paired model/budget validation. */
export type FinalContentMode = "off" | "shadow" | "on";
export function m04FinalContentPolicy(env: Readonly<Record<string, string | undefined>> = process.env) {
  const mode = (value: string | undefined, fallback: FinalContentMode): FinalContentMode => value === undefined ? fallback : value === "on" || value === "true" ? "on" : value === "shadow" ? "shadow" : "off";
  const enabled = env.CDSS_M04_FINAL_CONTENT !== "false" && env.CDSS_M04_FINAL_CONTENT !== "off";
  const analysis = mode(env.CDSS_M04_FINAL_ANALYSIS, "on"), functions = mode(env.CDSS_M04_HERB_FUNCTION_SOURCE_ONLY, "on"), modifications = mode(env.CDSS_M04_MODIFICATION_CLOSED_SET, "off");
  const error = analysis === "on" && functions !== "on" ? "analysis_requires_source_functions"
    : modifications !== "off" && env.CDSS_STANDBY_MODIFICATIONS === "true" ? "closed_set_incompatible_with_standby" : undefined;
  const budget = (name: string, fallback: number) => {
    const n = Number(env[name]); return Number.isFinite(n) && n > 0 ? Math.min(10_000, Math.round(n)) : fallback;
  };
  return { enabled: enabled && !error, error, analysis, functions, modifications,
    applicationPrefetch: env.CDSS_M04_APPLICATION_RETRIEVAL_PREFETCH !== "false",
    m05Prefetch: env.CDSS_M04_FINAL_CANDIDATE_M05_PREFETCH !== "false",
    analysisBudgetMs: budget("M04_FINAL_ANALYSIS_TIMEOUT_MS", 900),
    modificationBudgetMs: budget("M04_CLOSED_MODIFICATION_BUDGET_MS", 2500),
    // E must include this in whole-stage reuse/coalescing keys; these modules do not cache.
    version: `m04-final-v2:${enabled}:${analysis}:${functions}:${modifications}:${error || "ok"}` };
}
