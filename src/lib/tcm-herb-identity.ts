import herbIdentityJson from "../data/tcm-herb-identity-catalog.json" with { type: "json" };

export type GovernedHerbIdentityStatus =
  | "exact_standard_name"
  | "unique_high_confidence"
  | "unique_source_backed"
  | "source_backed_clinical_extension"
  | "source_backed_preparation_form"
  | "unique_mapping_requires_review"
  | "ambiguous"
  | "unmapped";

export type GovernedHerbIdentityResolution = {
  inputName: string;
  canonicalName?: string;
  suggestedCanonicalName?: string;
  status: GovernedHerbIdentityStatus;
  candidates: string[];
  preparation?: string;
  medicinalPart?: string;
  doseCanonicalName?: string;
};

type ResolutionRow = {
  canonicalName: string | null;
  status: Exclude<GovernedHerbIdentityStatus, "unmapped">;
  autoResolvable?: boolean;
  candidates?: string[];
  preparation?: string;
  medicinalPart?: string;
  doseCanonicalName?: string;
};

const RESOLUTION_INDEX = herbIdentityJson.resolutionIndex as Readonly<Record<string, ResolutionRow>>;

function identityInput(value: unknown): string {
  return String(value ?? "").normalize("NFKC").replace(/\s+/g, "").trim();
}

/**
 * T9 is the first and authoritative identity resolver. A multi-target alias remains unresolved;
 * callers may display its candidates for pharmacist confirmation but must never silently choose one.
 */
export function resolveGovernedTcmHerbIdentity(value: unknown): GovernedHerbIdentityResolution {
  const inputName = identityInput(value);
  if (!inputName) return { inputName, status: "unmapped", candidates: [] };
  const row = RESOLUTION_INDEX[inputName];
  if (!row) return { inputName, status: "unmapped", candidates: [] };
  if (row.status === "ambiguous" || !row.canonicalName) {
    return { inputName, status: "ambiguous", candidates: [...(row.candidates || [])] };
  }
  if (!row.autoResolvable) {
    return {
      inputName,
      suggestedCanonicalName: row.canonicalName,
      status: row.status,
      candidates: [row.canonicalName],
    };
  }
  return {
    inputName,
    canonicalName: row.canonicalName,
    status: row.status,
    candidates: [],
    ...(row.preparation ? { preparation: row.preparation } : {}),
    ...(row.medicinalPart ? { medicinalPart: row.medicinalPart } : {}),
    ...(row.doseCanonicalName ? { doseCanonicalName: row.doseCanonicalName } : {}),
  };
}

export function isAmbiguousGovernedTcmHerbIdentity(value: unknown): boolean {
  return resolveGovernedTcmHerbIdentity(value).status === "ambiguous";
}
