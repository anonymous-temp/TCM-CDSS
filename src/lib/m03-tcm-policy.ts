/** Effective non-secret policies shared by runtime and cache identity; no model imports. */
export function m03TcmCheckPolicy(env: Record<string, string | undefined> = process.env) {
  return { elements: env.CDSS_M03_ELEMENT_SUPPORT !== "false",
    secondary: env.CDSS_M03_SECONDARY_CRITERIA !== "false" && env.CDSS_M03_SECONDARY_CONSISTENCY !== "false",
    diseasePoints: env.CDSS_M03_DISEASE_POINTS_CHECK !== "false", visitReason: env.CDSS_M03_VISIT_REASON_CHECK !== "false",
    methods: env.CDSS_M03_METHOD_COVERAGE !== "false", lineage: env.CDSS_M03_LENS_CONSISTENCY !== "false" };
}

export function m03TcmTwoPassPolicy(env: Record<string, string | undefined> = process.env) {
  return { enabled: env.CDSS_M03_TCM_TWO_PASS === "true" && env.M03_PARALLEL_GENERATION?.trim().toLowerCase() !== "false",
    prefetch: env.CDSS_M03_TCM_CHECK_PREFETCH !== "false", rewrite: env.CDSS_M03_TCM_NARRATIVE_REWRITE !== "false",
    checks: m03TcmCheckPolicy(env), version: "m03-tcm-two-pass-v1" };
}
