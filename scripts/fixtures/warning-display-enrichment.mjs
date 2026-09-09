// Offline route fixture: a fresh backstop result exists only on the server, never in the request.
export function enrichWarningTestCase(state) {
  return { ...state, clinicalFacts: { redFlags: [], sourceFingerprint: `sha256:${"e".repeat(64)}`,
    semanticStatus: "checked", resultSource: "fresh", sourceCoverage: "full", reviewStatus: "checked" } };
}
export async function maybeAttachClinicalFactsBackstop(state) { return enrichWarningTestCase(state); }
