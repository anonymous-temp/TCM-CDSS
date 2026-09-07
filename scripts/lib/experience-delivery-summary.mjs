/** Whitelisted synthetic-test projection. A signed/readable candidate is not a dose approval. */
export function summarizeExperienceDoseStatus(reasoning, his) {
  return {
    candidates: (reasoning?.formula?.candidates || []).map(candidate => ({
      name: candidate.name ?? null,
      herbs: (candidate.herbs || []).map(herb => ({
        name: herb.name ?? null,
        dose: herb.dose ?? null,
        verificationTier: herb.verificationTier ?? null,
        verificationReasons: herb.verificationReasons || [],
      })),
    })),
    hisHerbalItems: (his?.prescriptions?.herbal || []).map(item => ({
      id: item.id ?? null,
      adoptable: typeof item.adoptable === "boolean" ? item.adoptable : null,
      referenceOnly: typeof item.referenceOnly === "boolean" ? item.referenceOnly : null,
      reason: item.blockedReason ?? null,
    })),
  };
}
