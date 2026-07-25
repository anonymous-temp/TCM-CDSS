import diagnosticsContextJson from "../data/diagnostics-context-lexicon.json" with { type: "json" };
import clinicalOutputContractJson from "../data/clinical-output-contract-registry.json" with { type: "json" };
import clinicalRequiredFieldJson from "../data/clinical-required-field-matrix.json" with { type: "json" };
import engineeringJargonJson from "../data/engineering-jargon-lexicon.json" with { type: "json" };
import redflagTriageJson from "../data/redflag-triage-lexicon.json" with { type: "json" };
import tcmLocationJson from "../data/tcm-location-lexicon.json" with { type: "json" };
import tcmNatureJson from "../data/tcm-nature-lexicon.json" with { type: "json" };
import tcmSyndromeJson from "../data/tcm-syndrome-lexicon.json" with { type: "json" };
import tcmTreatmentPrincipleJson from "../data/tcm-treatment-principle-lexicon.json" with { type: "json" };
import tcmNondrugTreatmentJson from "../data/tcm-nondrug-treatment-evidence-catalog.json" with { type: "json" };
import tcmClinicalTerminologyExtensionsJson from "../data/tcm-clinical-terminology-extensions.json" with { type: "json" };

type CanonicalEntry = {
  id: string;
  canonical: string;
  aliases: readonly string[];
  termClass?: string;
};

type DiagnosticContextGroup = {
  id: string;
  class: string;
  terms: readonly string[];
  tcmReasoningPolicy: string;
  forbiddenFrames: readonly string[];
};

type EngineeringJargonEntry = {
  id: string;
  terms: readonly string[];
  replacement: string;
  severity: string;
};

type TreatmentPrincipleEntry = CanonicalEntry & {
  examples: readonly string[];
  relationPolicy: string;
  permitsPrioritization?: boolean;
};

type RequiredFieldPolicyEntry = {
  id: string;
  label: string;
  casePaths: readonly string[];
  m02TargetField?: string;
  stagePolicy: Readonly<Record<string, string>>;
  currentEnforcement: string;
  unknownPolicy: string;
  rationale: string;
};

type TerminologyExtensions = {
  syndromeEntries: CanonicalEntry[];
  treatmentAliasAugmentations: Array<{ targetCanonical: string; aliases: string[] }>;
  treatmentEntries: TreatmentPrincipleEntry[];
};

const terminologyExtensions = tcmClinicalTerminologyExtensionsJson as TerminologyExtensions;
const syndromeEntries = [
  ...(tcmSyndromeJson.entries as readonly CanonicalEntry[]),
  ...terminologyExtensions.syndromeEntries,
] as readonly CanonicalEntry[];
const natureEntries = tcmNatureJson.entries as readonly CanonicalEntry[];
const locationEntries = tcmLocationJson.entries as readonly CanonicalEntry[];
const treatmentAliasAugmentations = new Map(
  terminologyExtensions.treatmentAliasAugmentations.map((item) => [item.targetCanonical, item.aliases] as const),
);
const treatmentPrincipleEntries = [
  ...(tcmTreatmentPrincipleJson.entries as readonly TreatmentPrincipleEntry[]).map((entry) => ({
    ...entry,
    aliases: [...new Set([...entry.aliases, ...(treatmentAliasAugmentations.get(entry.canonical) || [])])],
  })),
  ...terminologyExtensions.treatmentEntries,
] as readonly TreatmentPrincipleEntry[];
const diagnosticContextGroups = diagnosticsContextJson.groups as readonly DiagnosticContextGroup[];
const engineeringJargonEntries = engineeringJargonJson.entries as readonly EngineeringJargonEntry[];
const requiredFieldEntries = clinicalRequiredFieldJson.entries as readonly RequiredFieldPolicyEntry[];
const requiredFieldById = new Map(requiredFieldEntries.map((entry) => [entry.id, entry]));

function normalizedTerm(value: unknown): string {
  return typeof value === "string"
    ? value.normalize("NFKC").replace(/[\s，,。；;：:、（）()【】\[\]“”'\"]+/g, "").trim()
    : "";
}

function canonicalMap(entries: readonly CanonicalEntry[], stripTcmSuffix = false): Map<string, CanonicalEntry> {
  const result = new Map<string, CanonicalEntry>();
  for (const entry of entries) {
    for (const value of [entry.canonical, ...entry.aliases]) {
      const compact = normalizedTerm(value);
      const token = stripTcmSuffix ? compact.replace(/(?:证候|证|型)$/u, "") : compact;
      if (token && !result.has(token)) result.set(token, entry);
    }
  }
  return result;
}

function syndromeToken(value: unknown): string {
  return normalizedTerm(value).replace(/(?:证候|证|型)$/u, "");
}

const syndromeCanonicalByToken = new Map<string, CanonicalEntry>();
const syndromeAliasCandidatesByToken = new Map<string, CanonicalEntry[]>();
for (const entry of syndromeEntries) {
  const canonicalToken = syndromeToken(entry.canonical);
  if (canonicalToken && !syndromeCanonicalByToken.has(canonicalToken)) syndromeCanonicalByToken.set(canonicalToken, entry);
  for (const alias of entry.aliases) {
    const token = syndromeToken(alias);
    if (!token) continue;
    const candidates = syndromeAliasCandidatesByToken.get(token) || [];
    if (!candidates.some((candidate) => candidate.id === entry.id)) candidates.push(entry);
    syndromeAliasCandidatesByToken.set(token, candidates);
  }
}
const syndromeByToken = new Map(syndromeCanonicalByToken);
for (const [token, candidates] of syndromeAliasCandidatesByToken) {
  if (!syndromeByToken.has(token) && candidates.length === 1) syndromeByToken.set(token, candidates[0]);
}
const natureByToken = canonicalMap(natureEntries);
const locationByToken = canonicalMap(locationEntries);
const governedTermById = new Map(
  [...syndromeEntries, ...natureEntries, ...locationEntries].map((entry) => [entry.id, entry] as const),
);

export function canonicalTcmSyndromeTerm(value: unknown): CanonicalEntry | undefined {
  const token = syndromeToken(value);
  const canonical = syndromeCanonicalByToken.get(token);
  if (canonical) return canonical;
  const candidates = syndromeAliasCandidatesByToken.get(token) || [];
  return candidates.length === 1 ? candidates[0] : undefined;
}

export function resolveTcmSyndromeTerm(value: unknown): {
  status: "canonical" | "alias" | "ambiguous" | "unmapped";
  entry?: CanonicalEntry;
  candidates: CanonicalEntry[];
} {
  const token = syndromeToken(value);
  const canonical = syndromeCanonicalByToken.get(token);
  if (canonical) return { status: "canonical", entry: canonical, candidates: [canonical] };
  const candidates = syndromeAliasCandidatesByToken.get(token) || [];
  if (candidates.length === 1) return { status: "alias", entry: candidates[0], candidates };
  if (candidates.length > 1) return { status: "ambiguous", candidates };
  return { status: "unmapped", candidates: [] };
}

export function canonicalTcmNatureTerm(value: unknown): CanonicalEntry | undefined {
  return natureByToken.get(normalizedTerm(value));
}

export function canonicalTcmLocationTerm(value: unknown): CanonicalEntry | undefined {
  return locationByToken.get(normalizedTerm(value));
}

/** Return governed T3 locations explicitly named in a syndrome/pathogenesis statement. */
export function governedTcmLocationsInText(value: unknown): CanonicalEntry[] {
  const text = normalizedTerm(value);
  if (!text) return [];
  return locationEntries.filter((entry) =>
    [entry.canonical, ...entry.aliases]
      .map(normalizedTerm)
      .filter(Boolean)
      .some((token) => text.includes(token)));
}

/** Resolve T1/T3/T4 stable IDs when another governance table stores normalized relations. */
export function governedTcmTermLabelById(value: unknown): string | undefined {
  return typeof value === "string" ? governedTermById.get(value)?.canonical : undefined;
}

const syndromeTokens = [...syndromeByToken.keys()]
  .filter((token) => token.length >= 2 && syndromeByToken.get(token)?.termClass !== "category_heading")
  .sort((left, right) => right.length - left.length);

/** Detect a TCM syndrome qualifier inside a Western diagnosis label from T1. */
export function westernLabelContainsTcmSyndrome(value: unknown): boolean {
  const source = typeof value === "string" ? value.normalize("NFKC") : "";
  if (!source) return false;
  const parenthetical = [...source.matchAll(/[（(]([^）)]{1,40})[）)]/g)]
    .map((match) => normalizedTerm(match[1]));
  const compact = normalizedTerm(source);
  return syndromeTokens.some((token) =>
    parenthetical.some((segment) => segment.includes(token)) ||
    compact.endsWith(`${token}证`) || compact.endsWith(`${token}型`) || compact.endsWith(`${token}证候`));
}

export function treatmentPrinciplesInText(value: unknown): TreatmentPrincipleEntry[] {
  const text = normalizedTerm(value);
  if (!text) return [];
  return treatmentPrincipleEntries.filter((entry) =>
    [entry.canonical, ...entry.aliases, ...entry.examples]
      .map(normalizedTerm)
      .some((term) => term && text.includes(term)));
}

export function governedTreatmentPrinciplesInText(value: unknown): TreatmentPrincipleEntry[] {
  return treatmentPrinciplesInText(value).filter((entry) =>
    entry.termClass !== "category_heading" &&
    entry.relationPolicy !== "method_requires_case_binding" &&
    entry.relationPolicy !== "therapy_requires_capability_and_safety_review");
}

export function governedTreatmentPrinciplePromptContext(): string {
  const entries = treatmentPrincipleEntries.filter((entry) =>
    entry.termClass !== "category_heading" &&
    entry.relationPolicy !== "method_requires_case_binding" &&
    entry.relationPolicy !== "therapy_requires_capability_and_safety_review");
  const terms = [...new Set(entries.map((entry) => entry.canonical).filter(Boolean))];
  return [
    "【T4 受控治则词表】",
    `therapy.overallPrinciple 只能从以下治则或其受控同义表达中选择：${terms.join("、")}。`,
    "治则必须与本例病机和分治目标一致：选择“标本兼治”时，subTherapies 至少分别覆盖本与标两个不同目标；选择“扶正祛邪”时，必须同时有可回溯的正虚与邪实目标。具体的疏肝、清热、健脾、化痰、安神等只写入 overallMethod/subTherapies，不得冒充治则。",
  ].join("\n");
}

export function diagnosticContextsInText(value: unknown): DiagnosticContextGroup[] {
  const text = typeof value === "string" ? value.normalize("NFKC") : "";
  if (!text) return [];
  return diagnosticContextGroups.filter((group) =>
    group.terms.some((term) => text.toLowerCase().includes(term.toLowerCase())));
}

/** T5 is context-sensitive: the examination term is legal; only a listed dependency frame fails. */
export function tcmDiagnosticDependencyContexts(value: unknown): DiagnosticContextGroup[] {
  const text = typeof value === "string" ? value.normalize("NFKC") : "";
  if (!text) return [];
  return diagnosticContextGroups.filter((group) => group.terms.some((term) => {
    const lowerText = text.toLowerCase();
    const lowerTerm = term.toLowerCase();
    let from = 0;
    while (from < lowerText.length) {
      const index = lowerText.indexOf(lowerTerm, from);
      if (index < 0) return false;
      const clauseStart = Math.max(
        text.lastIndexOf("。", index),
        text.lastIndexOf("；", index),
        text.lastIndexOf("\n", index),
        index - 28,
      );
      const frame = text.slice(Math.max(0, clauseStart + 1), index);
      if (group.forbiddenFrames.some((prefix) => frame.includes(prefix))) return true;
      from = index + lowerTerm.length;
    }
    return false;
  }));
}

export function engineeringJargonInText(value: unknown): EngineeringJargonEntry[] {
  const text = typeof value === "string" ? value.normalize("NFKC") : "";
  if (!text) return [];
  return engineeringJargonEntries.filter((entry) => entry.terms.some((term) => text.includes(term)));
}

export function clinicalRequiredFieldPolicy(id: string): RequiredFieldPolicyEntry | undefined {
  return requiredFieldById.get(id);
}

export function clinicalRequiredFieldLabel(id: string, fallback: string): string {
  return requiredFieldById.get(id)?.label || fallback;
}

export function clinicalFieldRequiresExplicitPrescriptionState(id: string): boolean {
  const policy = requiredFieldById.get(id)?.stagePolicy.prescribe || "";
  return policy.includes("explicit_state_required") || policy.startsWith("required_for_");
}

export const CLINICAL_GOVERNANCE_TABLES = {
  syndrome: tcmSyndromeJson,
  nature: tcmNatureJson,
  location: tcmLocationJson,
  treatmentPrinciple: tcmTreatmentPrincipleJson,
  diagnosticsContext: diagnosticsContextJson,
  redflagTriage: redflagTriageJson,
  engineeringJargon: engineeringJargonJson,
  requiredFieldPolicy: clinicalRequiredFieldJson,
  outputContract: clinicalOutputContractJson,
  nondrugTreatment: tcmNondrugTreatmentJson,
  terminologyExtensions: tcmClinicalTerminologyExtensionsJson,
} as const;
