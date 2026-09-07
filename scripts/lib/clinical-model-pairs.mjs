/** Full clinical HTTP comparison; callers own transport and credentials, never this report. */
export async function runClinicalModelPairs({ fixtures, call, onProgress = () => {} }) {
  if (!Array.isArray(fixtures) || !fixtures.length || fixtures.length > 20 || fixtures.some(x => x.synthetic !== true || !x.state)) {
    throw new Error("Use 1–20 explicitly synthetic paired clinical cases");
  }
  const results = [];
  for (const fixture of fixtures) {
    const result = { label: fixture.label, synthetic: true, outcome: "incomplete", stages: [], diagnosis: {}, prescription: {} };
    results.push(result);
    const state = structuredClone(fixture.state);
    const preflight = await call("baseline", "red-flags", structuredClone(state));
    result.stages.push({ arm: "baseline", route: "red-flags", ...preflight.measurement });
    if (preflight.measurement.outcome !== "delivered" || !preflight.json?.safetyGate) { result.notReached = "diagnose"; continue; }
    Object.assign(state, { clinicalFacts: preflight.json.clinicalFacts, safetyGate: preflight.json.safetyGate, completeness: preflight.json.operationalCompleteness });
    let frozenDiagnosis;
    for (const arm of ["baseline", "alternative"]) {
      const diagnosed = await call(arm, "diagnose", structuredClone(state));
      result.stages.push({ arm, route: "diagnose", ...diagnosed.measurement, signed: Boolean(diagnosed.reasoning?.contractSignature) });
      result.diagnosis[arm] = clinicalSummary(diagnosed.reasoning);
      if (arm === "baseline" && diagnosed.reasoning?.contractSignature && diagnosed.measurement.outcome === "delivered") frozenDiagnosis = diagnosed;
      onProgress({ event: "paired_diagnose", label: fixture.label, ...result.stages.at(-1) });
    }
    if (!frozenDiagnosis) { result.notReached = "prescribe"; continue; }
    const sharedInput = { ...state, phase: "prescribe", diagnosis: frozenDiagnosis.content, reasoningDiagnose: frozenDiagnosis.reasoning };
    for (const arm of ["baseline", "alternative"]) {
      const prescribed = await call(arm, "prescribe", structuredClone(sharedInput));
      result.stages.push({ arm, route: "prescribe", ...prescribed.measurement, signed: Boolean(prescribed.reasoning?.contractSignature) });
      result.prescription[arm] = clinicalSummary(prescribed.reasoning);
      onProgress({ event: "paired_prescribe", label: fixture.label, ...result.stages.at(-1) });
    }
    if (result.stages.every(stage => stage.outcome === "delivered" && (stage.route === "red-flags" || stage.signed))) result.outcome = "delivered";
  }
  return { scope: "paired_full_clinical_http", clinicalEquivalence: "requires_clinician_review", m04Input: "same_baseline_m03_for_both_arms", results };
}

function clinicalSummary(reasoning) {
  if (!reasoning) return null;
  return {
    primaryDiagnosis: reasoning.westernDiagnosis?.primary?.name ?? null,
    syndrome: reasoning.overview?.primarySyndrome ?? null,
    clinicalRationale: reasoning.westernDiagnosis?.primary?.clinicalRationale ?? null,
    overallPathogenesis: reasoning.overview?.overallPathogenesis ?? null,
    therapy: reasoning.therapy?.overallMethod ?? null,
    chainNodeCount: reasoning.pathogenesis?.chain?.length ?? 0,
    reviewStatus: reasoning.clinicalReview?.status ?? null,
    candidate: reasoning.formula?.candidates?.[0] ? {
      name: reasoning.formula.candidates[0].name,
      formulaAnalysis: reasoning.formula.candidates[0].formulaAnalysis,
      herbs: reasoning.formula.candidates[0].herbs?.map(({ name, dose, function: purpose }) => ({ name, dose, purpose })) ?? [],
    } : null,
    modifications: reasoning.formula?.modifications?.map(({ action, herbName }) => ({ action, herbName })) ?? [],
  };
}
