import formulaCatalogJson from "../data/tcm-formula-sources.json" with { type: "json" };
import verifiedSupplementJson from "../data/tcm-verified-formula-supplements.json" with { type: "json" };
import governedFormulaCatalogJson from "../data/tcm-formula-governed-catalog.json" with { type: "json" };
import type { CaseState, ClinicalReasoningResultV2, EvidenceRef } from "./diagnosis-types";
import { getTcmHerbDoseLimit, getTcmHerbGenerationSafetyProfile, isKnownTcmHerbName } from "./tcm-knowledge";
import { resolveGovernedTcmHerbIdentity } from "./tcm-herb-identity";
import {
  compositionLogicForFormulaNames,
  formulaDiscriminationPaths,
  textualModificationsForFormulaNames,
} from "./tcm-classic-inference";

type FormulaVariant = {
  source: string;
  ingredients: string[];
  requiredIngredients?: string[];
  minimumPreservedIngredientCount?: number;
};

type FormulaCatalog = {
  schemaVersion: "tcm-formula-provenance-v2";
  sourceFile: string;
  sourceSha256: string;
  sourceRowCount: number;
  formulaNameCount: number;
  officialClassicSourceFile: string;
  officialClassicSourceSha256: string;
  officialClassicFormulaCount: number;
  officialClassicFormulas: Record<string, FormulaVariant & {
    sourceOriginal: string;
    prescription: string;
    dosageForm: string;
    catalogBatch: string;
  }>;
  formulas: Record<string, FormulaVariant[]>;
};

type VerifiedFormulaSupplements = {
  schemaVersion: "tcm-verified-formula-supplements-v1";
  entries: Record<string, FormulaVariant & {
    verification: Array<{ title: string; url: string }>;
  }>;
};

export type ResolvedFormulaSource = {
  formulaName: string;
  source: string;
  matchedIngredientCount: number;
  totalIngredientCount: number;
  minimumPreservedIngredientCount: number;
  matchedRequiredIngredientCount: number;
  requiredIngredientCount: number;
  verificationStatus: "verified_individually";
  exactComposition: boolean;
  origin: "official_classic_catalog" | "verified_reference_catalog" | "local_formula_catalog";
};

export type FormulaCompilationReference = {
  formulaName: string;
  source: string;
  ingredients: string[];
  minimumPreservedIngredientCount: number;
  requiredIngredients: string[];
  origin: ResolvedFormulaSource["origin"];
};

const catalog = formulaCatalogJson as FormulaCatalog;
const verifiedSupplements = verifiedSupplementJson as VerifiedFormulaSupplements;

type GovernedFormulaCompilationRow = {
  name: string;
  source: string;
  ingredients: string[];
  sourceClass: "official_classic_catalog" | "verified_reference_catalog" | "official_local_formula_standard";
  identityLockEligible: boolean;
  prescriptionLockEligible: boolean;
  doseCompilationEligible: boolean;
};

const governedFormulaCompilationRows = (governedFormulaCatalogJson.entries as readonly GovernedFormulaCompilationRow[])
  .filter((entry) => entry.identityLockEligible);
const governedFormulaCompilationByExactName = new Map(governedFormulaCompilationRows.map((entry) => [
  exactFormulaIdentityName(entry.name), entry,
]));
const governedFormulaCompilationCandidatesByNormalizedName = new Map<string, GovernedFormulaCompilationRow[]>();
for (const entry of governedFormulaCompilationRows) {
  const key = normalizeFormulaName(entry.name);
  const candidates = governedFormulaCompilationCandidatesByNormalizedName.get(key) || [];
  candidates.push(entry);
  governedFormulaCompilationCandidatesByNormalizedName.set(key, candidates);
}

const GOVERNED_FORMULA_NAMES = new Set([
  ...Object.keys(catalog.officialClassicFormulas),
  ...Object.keys(catalog.formulas),
  ...Object.keys(verifiedSupplements.entries),
].flatMap((name) => {
  const displayName = cleanFormulaDisplayName(name);
  const normalizedName = normalizeFormulaName(displayName);
  return [displayName, normalizedName].filter((item) => item.length >= 3);
}));

const FORMULA_DOSAGE_FORM_CHARACTERS = new Set(["汤", "散", "丸", "饮", "膏", "丹"]);
const FORMULA_CLAIM_MODIFIER = /^(?:加减|化裁|加味|类方)/;
const FORMULA_CLAIM_LEFT_CONTEXT = /(?:按|参考|基于|仿|合|取|采用|源于|沿用|原方)$/;

function normalizeFormulaName(value: string): string {
  return value
    .replace(/^.*?(?:候选处方|候选方案)\s*\d*[：:]\s*/, "")
    .replace(/[（(]?\s*《[^》]{2,80}》\s*[）)]?/g, "")
    .replace(/[\s·•，,。；;：:（）()【】\[\]“”"']/g, "")
    .replace(/(?:加减方?|化裁方?|加味方?)$/g, "")
    .trim();
}

function exactFormulaIdentityName(value: string): string {
  return value
    .replace(/^.*?(?:候选处方|候选方案)\s*\d*[：:]\s*/, "")
    .replace(/[（(]?\s*《[^》]{2,80}》\s*[）)]?/g, "")
    .replace(/[\s·•，,。；;：:（）()【】\[\]“”"']/g, "")
    .trim();
}

function governedFormulaCompilationRow(value: string): GovernedFormulaCompilationRow | undefined {
  const exact = governedFormulaCompilationByExactName.get(exactFormulaIdentityName(value));
  if (exact) return exact;
  const candidates = governedFormulaCompilationCandidatesByNormalizedName.get(normalizeFormulaName(value)) || [];
  return candidates.length === 1 ? candidates[0] : undefined;
}

function cleanFormulaDisplayName(value: string): string {
  return value
    .replace(/[（(]?\s*《[^》]{2,80}》\s*[）)]?/g, "")
    .replace(/[：:；;，,。\s]+$/g, "")
    .trim();
}

function explicitFormulaIdentityNames(values: Array<string | undefined>): string[] {
  return [...new Set(values.flatMap((value) => {
    if (!value) return [];
    const displayName = cleanFormulaDisplayName(value);
    const normalizedName = normalizeFormulaName(displayName);
    return [displayName, normalizedName];
  }).filter((value) => value.length >= 3))].sort((left, right) => right.length - left.length);
}

function replaceLiteralFormulaClaims(value: string, names: string[], replacement: string): string {
  return names.reduce((output, name) => output.split(name).join(replacement), value);
}

function isUnambiguousGovernedFormulaClaim(value: string, start: number, end: number, name: string): boolean {
  if (!name.endsWith("散") || name.length >= 4) return true;
  const rightContext = value.slice(end);
  if (end === value.length || /^[\s，,。；;：:、（）()【】\[\]“”"']/.test(rightContext)) return true;
  if (FORMULA_CLAIM_MODIFIER.test(rightContext)) return true;
  return FORMULA_CLAIM_LEFT_CONTEXT.test(value.slice(Math.max(0, start - 4), start));
}

function governedFormulaClaimRanges(value: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  for (let endIndex = 0; endIndex < value.length; endIndex += 1) {
    if (!FORMULA_DOSAGE_FORM_CHARACTERS.has(value[endIndex])) continue;
    const earliestStart = Math.max(0, endIndex - 11);
    let matchedStart = -1;
    for (let startIndex = earliestStart; startIndex <= endIndex - 2; startIndex += 1) {
      const name = value.slice(startIndex, endIndex + 1);
      if (!GOVERNED_FORMULA_NAMES.has(name)) continue;
      if (!isUnambiguousGovernedFormulaClaim(value, startIndex, endIndex + 1, name)) continue;
      matchedStart = startIndex;
      break;
    }
    if (matchedStart >= 0) {
      ranges.push({ start: matchedStart, end: endIndex + 1 });
      endIndex = Math.max(endIndex, ranges.at(-1)!.end - 1);
    }
  }
  return ranges;
}

function replaceGovernedFormulaClaims(value: string, replacement: string): string {
  const ranges = governedFormulaClaimRanges(value);
  if (ranges.length === 0) return value;
  let output = "";
  let cursor = 0;
  for (const range of ranges) {
    if (range.start < cursor) continue;
    output += value.slice(cursor, range.start) + replacement;
    cursor = range.end;
  }
  return output + value.slice(cursor);
}

// Formula provenance is stricter than dose lookup: medicinal parts, processing
// methods and preparation forms remain distinct. Only true spelling/historical
// name aliases may collapse inside the signed formula-identity contract.
const HARD_IDENTITY_HERB_ALIASES: Record<string, string> = {
  黄耆: "黄芪",
  代赭: "代赭石",
} as const;

function normalizeHerbName(value: string): string {
  const normalized = value
    .replace(/[\s·•，,。；;：:（）()【】\[\]“”"']/g, "")
    .replace(/(?:饮片|颗粒)$/g, "")
    .trim();
  for (const [alias, canonical] of Object.entries(HARD_IDENTITY_HERB_ALIASES)
    .sort(([left], [right]) => right.length - left.length)) {
    if (normalized === alias || normalized.endsWith(alias)) {
      return `${normalized.slice(0, -alias.length)}${canonical}`;
    }
  }
  return normalized;
}

function rawHerbIdentityName(value: string): string {
  return value
    .replace(/[\s·•，,。；;：:（）()【】\[\]“”"']/g, "")
    .replace(/(?:饮片|颗粒)$/g, "")
    .trim();
}

function equivalentHerbIdentityNames(value: string): string[] {
  const raw = rawHerbIdentityName(value);
  const canonical = normalizeHerbName(raw);
  const reverseAliases = Object.entries(HARD_IDENTITY_HERB_ALIASES).flatMap(([alias, target]) =>
    canonical === target || canonical.endsWith(target)
      ? [`${canonical.slice(0, -target.length)}${alias}`]
      : []
  );
  return [...new Set([
    raw,
    normalizeHerbName(raw),
    ...reverseAliases,
  ].filter(Boolean))];
}

type FormulaHerbInput = { name?: string; processing?: string | null };

const PROCESSING_IDENTITY_ALIASES: Readonly<Record<string, string>> = {
  炙制: "炙",
  炒制: "炒",
  姜炙: "姜制",
  酒炙: "酒制",
  醋炙: "醋制",
  盐炙: "盐制",
};

const NON_IDENTITY_PREPARATION = /^(?:捣碎|打碎|研碎|切片|切段|切块|去核|去芦|洗净|先煎|后下|另煎|另炖|包煎|烊化|冲服|兑服|同煎)$/;

function formulaHerbIdentityName(herb: FormulaHerbInput): string {
  const name = rawHerbIdentityName(herb.name || "");
  if (!name) return "";
  const rawProcessing = typeof herb.processing === "string"
    ? herb.processing.replace(/[\s·•，,。；;：:（）()【】\[\]“”"']/g, "").replace(/(?:法|品)$/g, "").trim()
    : "";
  if (!rawProcessing || /^(?:无|饮片|常规)$/.test(rawProcessing) || NON_IDENTITY_PREPARATION.test(rawProcessing)) {
    return normalizeHerbName(name);
  }
  const processing = PROCESSING_IDENTITY_ALIASES[rawProcessing] || rawProcessing;
  const composed = name.startsWith(processing) ? name : `${processing}${name}`;
  return normalizeHerbName(composed);
}

function formulaHerbBaseIdentityName(herb: FormulaHerbInput): string {
  return normalizeHerbName(rawHerbIdentityName(herb.name || ""));
}

function sourceIngredientRequiresProcessingIdentity(value: string): boolean {
  const raw = rawHerbIdentityName(value);
  const prefixes = [...new Set([
    ...Object.keys(PROCESSING_IDENTITY_ALIASES),
    ...Object.values(PROCESSING_IDENTITY_ALIASES),
  ])].sort((left, right) => right.length - left.length);
  return prefixes.some((prefix) => raw.startsWith(prefix) && raw.length > prefix.length);
}

function formulaHerbBaseAliases(herbs: FormulaHerbInput[]): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const herb of herbs) {
    const exact = formulaHerbIdentityName(herb);
    const base = formulaHerbBaseIdentityName(herb);
    if (exact && base && exact !== base) aliases.set(exact, base);
  }
  return aliases;
}

const CORE_SAFETY_HERBS = new Set([
  "附子", "乌头", "川乌", "草乌", "半夏", "天南星", "麻黄", "细辛", "大黄", "巴豆", "朱砂", "雄黄", "马钱子",
]);

function requiredFormulaAnchors(formulaName: string, variant: FormulaVariant, ingredients: string[]): string[] {
  const configured = (variant.requiredIngredients || []).map(normalizeHerbName).filter(Boolean);
  if (configured.length > 0) return configured;
  const normalizedFormulaName = normalizeFormulaName(formulaName);
  // Identify name-bearing herbs from both the raw source token and its canonical alias. Doing this
  // only after alias normalization loses anchors such as 代赭 -> 代赭石 because “旋覆代赭汤” does
  // not contain the longer canonical token. The public/validator contract still stores the final
  // canonical herb name so aliases remain one identity downstream.
  const named = [...new Set([
    ...variant.ingredients.filter((raw) => {
      return equivalentHerbIdentityNames(raw).some((identity) =>
        identity.length >= 2 && normalizedFormulaName.includes(identity)
      );
    }).map(normalizeHerbName),
    ...ingredients.filter((ingredient) => equivalentHerbIdentityNames(ingredient).some((identity) =>
      identity.length >= 2 && normalizedFormulaName.includes(identity)
    )),
  ])];
  const safetyCritical = ingredients.filter((ingredient) => CORE_SAFETY_HERBS.has(ingredient));
  return [...new Set([...named, ...safetyCritical, ingredients[0]].filter(Boolean))];
}

const normalizedCatalog = new Map<string, { name: string; variants: FormulaVariant[] }>();
for (const [name, variants] of Object.entries(catalog.formulas)) {
  const normalized = normalizeFormulaName(name);
  if (normalized.length < 2) continue;
  const existing = normalizedCatalog.get(normalized);
  if (!existing) {
    normalizedCatalog.set(normalized, { name, variants: [...variants] });
    continue;
  }
  // Annotated aliases can normalize to the same formula name while carrying different exact
  // compositions/sources. Merge every variant into one ranking pool instead of silently dropping
  // later aliases and attributing an exact composition to the wrong book.
  const seen = new Set(existing.variants.map((variant) => `${variant.source}::${variant.ingredients.join("|")}`));
  for (const variant of variants) {
    const key = `${variant.source}::${variant.ingredients.join("|")}`;
    if (!seen.has(key)) {
      existing.variants.push(variant);
      seen.add(key);
    }
  }
}

const normalizedOfficialClassics = new Map<string, { name: string; variant: FormulaCatalog["officialClassicFormulas"][string] }>();
for (const [name, variant] of Object.entries(catalog.officialClassicFormulas)) {
  normalizedOfficialClassics.set(normalizeFormulaName(name), { name, variant });
}

const normalizedVerifiedSupplements = new Map<string, { name: string; variant: VerifiedFormulaSupplements["entries"][string] }>();
for (const [name, variant] of Object.entries(verifiedSupplements.entries)) {
  normalizedVerifiedSupplements.set(normalizeFormulaName(name), { name, variant });
}

function knownFormulaMatches(normalized: string): Array<{ name: string; start: number }> {
  const matches: Array<{ name: string; start: number }> = [];
  for (let start = 0; start < normalized.length; start += 1) {
    for (let end = normalized.length; end >= start + 2; end -= 1) {
      const fragment = normalized.slice(start, end);
      // The broad local workbook contains short common nouns (e.g. 补汤/膏药/炒面). They are useful
      // for composition lookup after a doctor has named a candidate, but unsafe as free-text identity
      // matches. Two-character names are accepted only from the governed official/verified catalogs.
      if (normalizedOfficialClassics.has(fragment) || normalizedVerifiedSupplements.has(fragment) || (fragment.length >= 3 && normalizedCatalog.has(fragment))) {
        matches.push({ name: fragment, start });
        break;
      }
    }
  }
  return matches
    .sort((a, b) => b.name.length - a.name.length || a.start - b.start)
    .filter((match, index, all) => !all.slice(0, index).some((chosen) => {
      const chosenEnd = chosen.start + chosen.name.length;
      const matchEnd = match.start + match.name.length;
      return match.start < chosenEnd && matchEnd > chosen.start;
    }))
    .sort((a, b) => a.start - b.start);
}

function canonicalFormulaDisplayName(normalizedName: string): string {
  return cleanFormulaDisplayName(normalizedOfficialClassics.get(normalizedName)?.name ||
    normalizedVerifiedSupplements.get(normalizedName)?.name ||
    normalizedCatalog.get(normalizedName)?.name ||
    normalizedName);
}

/**
 * Resolve formula names from natural language against the governed local catalog. The model's
 * prose is never treated as an identifier: only catalog-backed, longest non-overlapping matches
 * become references used by the M03 -> M04 contract.
 */
export function identifyKnownFormulaNames(value: string): string[] {
  const clauses = value
    .replace(/(?<!不)(?=(?:但|而)?(?:改用|改予|转用|换用|首选|建议(?:采用|使用)))/g, "；")
    .split(/[。；;\n]+/)
    .map((item) => normalizeFormulaName(item))
    .filter(Boolean);
  const matches = clauses.flatMap((normalized) => knownFormulaMatches(normalized)
    .filter((match) => {
      const localPrefix = normalized.slice(Math.max(0, match.start - 18), match.start);
      const localSuffix = normalized.slice(match.start + match.name.length, match.start + match.name.length + 18);
      const selfDevisedPrefix = /(?:自拟|经验方|协定方|院内方|辨证组方)[^汤散丸饮丹膏]{0,4}$/.test(localPrefix);
      const negativePrefix = /(?:不建议(?:使用|采用)?|不推荐|不宜|不应|不用|不使用|不采用|不予(?:使用|采用|选用)?|不得(?:使用|采用|选用)?|不可(?:使用|采用|选用)?|严禁(?:使用|采用|选用)?|禁忌(?:使用|采用|选用)?|禁用|禁止|忌用|勿用|排除|暂缓|暂停|停用|避免|不选|不考虑|不作为|仅作|仅用于|仅供)[^汤散丸饮丹膏]{0,10}$/.test(localPrefix);
      const negativeSuffix = /^(?![^汤散丸饮丹膏]{0,12}(?:无|没有|未见)(?:明显|使用)?禁忌)[^汤散丸饮丹膏]{0,12}(?:禁忌(?:方|使用)?|禁用|忌用|(?:应|须|需)?避免(?:继续)?(?:使用|采用|选用)?|不予(?:使用|采用|选用)|不应(?:继续)?(?:使用|采用|选用)|暂停(?:使用|采用|选用)?|停用|严禁(?:使用)?|不得(?:使用)?|不可(?:使用)?|禁止|勿用|不宜|不建议|不推荐|不作为|仅作鉴别|仅用于鉴别|仅供鉴别|排除)/.test(localSuffix);
      return !selfDevisedPrefix && !negativePrefix && !negativeSuffix;
    }));
  return [...new Set(matches
    .slice(0, 4)
    .map((match) => canonicalFormulaDisplayName(match.name)))]
    .slice(0, 4);
}

/**
 * Return a deterministic, catalog-backed composition anchor for an M03 formula reference. This is
 * prompt input, not a prescription: doses still come from the governed herb knowledge and model
 * reasoning, while M04 composition is checked back against the same catalog after generation.
 */
function compilationReference(
  formulaName: string,
  variant: FormulaVariant,
  origin: ResolvedFormulaSource["origin"],
): FormulaCompilationReference {
  // The same canonical, de-duplicated ingredient list is shown to the model and enforced after
  // generation. Raw workbooks can contain alias duplicates; counting those publicly but matching
  // them canonically would create two conflicting 80% thresholds.
  const ingredients = [...new Set(variant.ingredients.map(normalizeHerbName).filter(Boolean))];
  return {
    formulaName,
    source: variant.source,
    ingredients,
    minimumPreservedIngredientCount: Math.max(1, Math.ceil(ingredients.length * 0.8)),
    requiredIngredients: requiredFormulaAnchors(formulaName, variant, ingredients),
    origin,
  };
}

export function formulaCompilationReferences(names: string[]): FormulaCompilationReference[] {
  return [...new Set(names.map(exactFormulaIdentityName).filter(Boolean))].flatMap<FormulaCompilationReference>((formulaName) => {
    const governed = governedFormulaCompilationRow(formulaName);
    if (!governed) return [];
    const origin = governed.sourceClass === "official_classic_catalog"
      ? "official_classic_catalog"
      : governed.sourceClass === "official_local_formula_standard"
        ? "local_formula_catalog"
        : "verified_reference_catalog";
    return [compilationReference(governed.name, {
      source: governed.source,
      ingredients: governed.ingredients,
    }, origin)];
  });
}

export function executableFormulaCompilationReferences(names: string[]): FormulaCompilationReference[] {
  return formulaCompilationReferences(names).filter((reference) => {
    const governed = governedFormulaCompilationRow(reference.formulaName);
    if (!governed?.doseCompilationEligible) return false;
    return reference.ingredients.every((name) => {
    const resolution = resolveGovernedTcmHerbIdentity(name);
    const doseIdentity = resolution.doseCanonicalName || resolution.canonicalName || name;
    const limit = getTcmHerbDoseLimit(doseIdentity);
    return isKnownTcmHerbName(doseIdentity) && limit?.min != null && limit?.max != null;
    });
  });
}

/** Names whose governed formula identity is valid but whose full composition lacks an executable
 * numeric dose boundary. They may remain visible as a formula direction, but cannot enter M04 dose
 * generation until the missing identities/boundaries are adjudicated in T8/T9. */
export function formulaNamesWithoutExecutableDoseCompilation(names: string[]): string[] {
  const executable = new Set(executableFormulaCompilationReferences(names).map((item) => item.formulaName));
  return [...new Set(names.map((name) => governedFormulaCompilationRow(name)?.name).filter((name): name is string => Boolean(name)))]
    .filter((name) => !executable.has(name));
}

export function formulaCompilationContractIssue(
  reasoning: ClinicalReasoningResultV2 | null | undefined,
  prior: ClinicalReasoningResultV2 | null | undefined,
  trustedWorkbenchEdit = false,
  allowTransparentDeclassification = true,
): string | undefined {
  const candidate = reasoning?.formula?.candidates?.[0];
  if (!reasoning || reasoning.stage !== "prescribe" || !candidate || !prior || prior.stage !== "diagnose") {
    return "formula_compilation_contract_missing";
  }
  if (trustedWorkbenchEdit && candidate.constructionType === "self_devised" &&
    candidate.modificationStatus === "modified" && /医生编辑版/.test(candidate.name)) {
    return undefined;
  }
  const governedNames = prior.overview.recommendedFormulaNames || [];
  const mode = prior.overview.formulaSelectionMode || "none";
  const candidateNames = candidate.formulaNames || [];
  if (mode === "none" || mode === "self_devised") {
    return candidateNames.length === 0 ? undefined : "formula_direction_drift";
  }
  const references = formulaCompilationReferences(governedNames);
  if (references.length !== governedNames.length) return "formula_reference_ambiguous";
  // M03 names are a recommended formula direction, not permission to attach a classic identity
  // to a different composition. enrichReasoning deliberately declassifies a candidate to the
  // transparent self-devised label when its actual herbs cannot satisfy the governed baseline.
  // Keep that clinically usable candidate and omit the unsupported classic source instead of
  // discarding the whole prescription after repeated model retries.
  const declassifiedSelfDevised = candidateNames.length === 0 &&
    candidate.constructionType === "self_devised" &&
    /^(?:本例辨证组方|辨证组方)(?:加减)?$/.test(candidate.name.trim());
  if (declassifiedSelfDevised) {
    // Provider generation gets a chance to honour an M03-governed classic baseline. Transparent
    // declassification remains a valid final safety fallback, but accepting it during provider
    // validation would suppress the targeted composition repair entirely.
    return allowTransparentDeclassification ? undefined : "formula_reference_declassified";
  }
  const selectedReferences = mode === "alternatives"
    ? references.filter((item) => candidateNames.includes(item.formulaName))
    : references;
  if (selectedReferences.length !== candidateNames.length || selectedReferences.length === 0) {
    return "formula_reference_selection_drift";
  }
  const combined = mode === "combined";
  const explicitlyModified = /(?:加减|化裁|加味)/.test(candidate.name);
  const herbNames = candidate.herbs.map((herb) => formulaHerbIdentityName(herb)).filter(Boolean);
  const baseAliases = formulaHerbBaseAliases(candidate.herbs);
  if (mode === "alternatives") {
    const actualHerbs = new Set([
      ...herbNames.map(normalizeHerbName).filter(Boolean),
      ...baseAliases.values(),
    ]);
    const containsCompleteUnselectedBaseline = references
      .filter((reference) => !candidateNames.includes(reference.formulaName))
      .some((reference) => reference.ingredients.every((ingredient) => actualHerbs.has(normalizeHerbName(ingredient))));
    if (containsCompleteUnselectedBaseline) return "formula_compilation_composition_drift";
  }
  const componentVerifications = selectedReferences.map((reference) =>
    verifyFormulaCompilationComponent(reference, candidate.herbs, combined, explicitlyModified));
  const failedComponentIndex = componentVerifications.findIndex((item) => !item.verified);
  if (failedComponentIndex < 0) return undefined;
  if (combined) return `formula_component_${failedComponentIndex}_unverified`;
  // The signed M03 contract binds every selected name to one governed compilation reference.
  // Same-name historical variants remain searchable as evidence, but cannot replace that baseline
  // during automatic M04 generation because another formula may share most of the short variant.
  // A mismatched composition must be repaired or transparently declassified as self-devised.
  return "formula_compilation_composition_drift";
}

function formulaSelectionMode(value: string, names: string[]): NonNullable<ClinicalReasoningResultV2["overview"]["formulaSelectionMode"]> {
  if (names.length === 0) {
    return /(?:自拟|经验方|协定方|院内方|辨证组方)/.test(value) ? "self_devised" : "none";
  }
  if (names.length === 1) return "single";
  const normalized = normalizeFormulaName(value);
  const matches = knownFormulaMatches(normalized)
    .filter((match) => names.some((name) => normalizeFormulaName(name) === match.name))
    .sort((a, b) => a.start - b.start);
  const relationText = matches.slice(0, -1).map((match, index) =>
    normalized.slice(match.start + match.name.length, matches[index + 1].start)
  ).join("|");
  const last = matches[matches.length - 1];
  const trailing = last ? normalized.slice(last.start + last.name.length) : "";
  if (/(?:或|任选|二选一)/.test(relationText) || /^(?:酌情选用|酌选|任选|二选一)/.test(trailing)) return "alternatives";
  if (/(?:合方|联合|合|与)/.test(relationText)) return "combined";
  // An unqualified list must not silently authorize a combined prescription.
  return "alternatives";
}

export function withDeterministicFormulaReferences(reasoning: ClinicalReasoningResultV2): ClinicalReasoningResultV2 {
  if (reasoning.stage === "diagnose") {
    const direction = String(reasoning.overview?.recommendedFormulaDirection || "");
    const identifiedNames = identifyKnownFormulaNames(direction);
    const identifiedMode = formulaSelectionMode(direction, identifiedNames);
    const identityGovernedNames = identifiedNames.filter((name) => formulaCompilationReferences([name]).length === 1);
    const incompleteCombined = identifiedMode === "combined" && identityGovernedNames.length !== identifiedNames.length;
    const recommendedFormulaNames = incompleteCombined ? [] : identityGovernedNames;
    const governedDirection = identifiedNames.length > 0 && recommendedFormulaNames.length === 0
      ? "按已锁定病机与治法辨证组方"
      : direction;
    return {
      ...reasoning,
      overview: {
        ...reasoning.overview,
        recommendedFormulaDirection: governedDirection,
        recommendedFormulaNames,
        formulaSelectionMode: formulaSelectionMode(governedDirection, recommendedFormulaNames),
      },
    };
  }
  if (reasoning.stage === "prescribe" && reasoning.formula) {
    return {
      ...reasoning,
      formula: {
        ...reasoning.formula,
        candidates: reasoning.formula.candidates.map((candidate) => ({
          ...candidate,
          formulaNames: identifyKnownFormulaNames(candidate.name),
        })),
      },
    };
  }
  return reasoning;
}

export function applyDeterministicFormulaReferences(content: string): string {
  return content.replace(
    /<!-- DIAGNOSIS_JSON_START -->\s*([\s\S]*?)\s*<!-- DIAGNOSIS_JSON_END -->/g,
    (match, jsonText: string) => {
      try {
        const parsed = JSON.parse(jsonText) as ClinicalReasoningResultV2;
        if (parsed.schemaVersion !== "tcm-cdss-reasoning-v2") return match;
        const next = withDeterministicFormulaReferences(parsed);
        return `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(next, null, 2)}\n<!-- DIAGNOSIS_JSON_END -->`;
      } catch {
        return match;
      }
    },
  );
}

function candidateBaseFormulaNames(candidateName: string): string[] {
  if (/(?:自拟|经验方|协定方|院内方|辨证方)/.test(candidateName)) return [];
  const normalized = normalizeFormulaName(candidateName);
  if (!normalized) return [];
  const direct = normalizedOfficialClassics.get(normalized) || normalizedVerifiedSupplements.get(normalized) || normalizedCatalog.get(normalized);
  if (direct) return [normalized];

  const matches = knownFormulaMatches(normalized).slice(0, 4);
  if (matches.length === 0) return [];
  let remainder = normalized;
  [...matches].sort((a, b) => b.start - a.start).forEach((match) => {
    remainder = remainder.slice(0, match.start) + remainder.slice(match.start + match.name.length);
  });
  remainder = remainder.replace(/(?:加减|化裁|加味)$/g, "");
  if (matches.length >= 2 && /^(?:(?:联合|合方|合|与))+$/.test(remainder)) {
    return [...new Set(matches.map((match) => match.name))];
  }
  if (/(?:联合|合方|合|与)/.test(remainder)) return [];
  return matches.length === 1 && remainder.length === 0 ? [matches[0].name] : [];
}

type FormulaSourceCandidate = {
  formulaName: string;
  variant: FormulaVariant;
  origin: ResolvedFormulaSource["origin"];
};

function bestFormulaSourceCandidate(
  candidates: FormulaSourceCandidate[],
  herbs: string[],
  combinedFormula = false,
  explicitlyModified = false,
  sourceHint = "",
  inferredAdditionsOnly = false,
  baseIdentityByExact: ReadonlyMap<string, string> = new Map(),
): { candidate: FormulaSourceCandidate; overlap: number; f1: number; matchedHerbs: string[]; usedBaseAlias: boolean } | undefined {
  const normalizedHerbs = [...new Set(herbs.map(normalizeHerbName).filter(Boolean))];
  if (normalizedHerbs.length === 0) return undefined;
  const ranked = candidates
    .map((candidate) => {
      const variant = candidate.variant;
      const normalizedFormulaIdentity = normalizeFormulaName(candidate.formulaName);
      const ingredients = [...new Set(variant.ingredients.map(normalizeHerbName).filter((ingredient) =>
        ingredient && ingredient !== normalizedFormulaIdentity
      ))];
      const ingredientOwner = new Array<number>(ingredients.length).fill(-1);
      const canMatch = (herb: string, ingredient: string) => ingredient === herb || (
        baseIdentityByExact.get(herb) === ingredient && !sourceIngredientRequiresProcessingIdentity(ingredient)
      );
      const assign = (herbIndex: number, seen: boolean[]): boolean => {
        for (let ingredientIndex = 0; ingredientIndex < ingredients.length; ingredientIndex += 1) {
          if (seen[ingredientIndex] || !canMatch(normalizedHerbs[herbIndex], ingredients[ingredientIndex])) continue;
          seen[ingredientIndex] = true;
          if (ingredientOwner[ingredientIndex] < 0 || assign(ingredientOwner[ingredientIndex], seen)) {
            ingredientOwner[ingredientIndex] = herbIndex;
            return true;
          }
        }
        return false;
      };
      normalizedHerbs.forEach((_, herbIndex) => assign(herbIndex, new Array<boolean>(ingredients.length).fill(false)));
      const matchedHerbs = ingredientOwner.filter((herbIndex) => herbIndex >= 0).map((herbIndex) => normalizedHerbs[herbIndex]);
      const usedBaseAlias = ingredientOwner.some((herbIndex, ingredientIndex) =>
        herbIndex >= 0 && normalizedHerbs[herbIndex] !== ingredients[ingredientIndex]
      );
      const overlap = ingredientOwner.filter((herbIndex) => herbIndex >= 0).length;
      const precision = overlap / Math.max(normalizedHerbs.length, 1);
      const recall = overlap / Math.max(ingredients.length, 1);
      const f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;
      const requiredOverlap = ingredients.length <= 2 ? ingredients.length : 2;
      const requiredIngredients = requiredFormulaAnchors(candidate.formulaName, variant, ingredients);
      const requiredIngredientsPresent = requiredIngredients.every((required) =>
        normalizedHerbs.some((herb) => canMatch(herb, required))
      );
      // Formula identity is provenance, not a fuzzy similarity label. Every source and every
      // single/combined branch must enforce the same public contract: retain at least 80% of the
      // governed baseline and every identity/safety anchor. F1 remains a ranking signal only; it
      // must never let a low-recall local formula inherit a classic name or source.
      const identityFloorSatisfied = overlap >= (variant.minimumPreservedIngredientCount ?? Math.max(1, Math.ceil(ingredients.length * 0.8))) && requiredIngredientsPresent;
      const inferredAdditiveMatch = inferredAdditionsOnly &&
        recall >= 0.999 &&
        precision >= 0.35 &&
        requiredIngredientsPresent;
      const accepted = ingredients.length > 0 && overlap >= requiredOverlap && identityFloorSatisfied && (
        inferredAdditionsOnly
          ? inferredAdditiveMatch
          : combinedFormula
          ? (explicitlyModified ? true : recall >= 0.999)
          : explicitlyModified
            ? precision >= 0.35
            : recall >= 0.999 && precision >= 0.999
      );
      return {
        candidate,
        overlap,
        f1,
        recall,
        matchedHerbs,
        usedBaseAlias,
        ingredientSignature: `${[...matchedHerbs].sort().join("|")}::missing=${ingredients.length - overlap}`,
        accepted,
      };
    })
    .filter((item) => item.accepted)
    .sort((a, b) =>
      Number(Boolean(sourceHint && b.candidate.variant.source.includes(sourceHint))) - Number(Boolean(sourceHint && a.candidate.variant.source.includes(sourceHint))) ||
      b.f1 - a.f1 || b.overlap - a.overlap ||
      (a.candidate.origin === "official_classic_catalog" ? -1 : a.candidate.origin === "verified_reference_catalog" ? 0 : 1) -
      (b.candidate.origin === "official_classic_catalog" ? -1 : b.candidate.origin === "verified_reference_catalog" ? 0 : 1));
  const best = ranked[0];
  if (!best) return undefined;
  // 同组成同名方由可信目录优先；不同组成近分则拒绝归典，避免任选一个看似权威的出处。
  const competingDifferentFormula = ranked.slice(1).find((item) =>
    item.candidate.variant.source !== best.candidate.variant.source && item.ingredientSignature !== best.ingredientSignature
  );
  const bestExact = best.f1 >= 0.999;
  const bestFullyCovered = best.recall >= 0.999 && competingDifferentFormula && competingDifferentFormula.recall < 0.999;
  const trustedCombinedFull = combinedFormula && best.recall >= 0.999 && best.candidate.origin !== "local_formula_catalog";
  if (competingDifferentFormula && !bestExact && !bestFullyCovered && !trustedCombinedFull && best.f1 - competingDifferentFormula.f1 < 0.08) return undefined;
  return { candidate: best.candidate, overlap: best.overlap, f1: best.f1, matchedHerbs: best.matchedHerbs, usedBaseAlias: best.usedBaseAlias };
}

export type FormulaComponentVerification = {
  formulaName: string;
  source: string;
  verified: boolean;
  matchedIngredientCount: number;
  totalIngredientCount: number;
  minimumPreservedIngredientCount: number;
  matchedRequiredIngredientCount: number;
  requiredIngredientCount: number;
};

function verifyFormulaCompilationComponent(
  reference: FormulaCompilationReference,
  herbs: FormulaHerbInput[],
  combined: boolean,
  explicitlyModified: boolean,
): FormulaComponentVerification {
  const herbNames = herbs.map(formulaHerbIdentityName).filter(Boolean);
  const baseAliases = formulaHerbBaseAliases(herbs);
  const sourceCandidate: FormulaSourceCandidate = {
    formulaName: reference.formulaName,
    variant: {
      source: reference.source,
      ingredients: reference.ingredients,
      requiredIngredients: reference.requiredIngredients,
      minimumPreservedIngredientCount: reference.minimumPreservedIngredientCount,
    },
    origin: reference.origin,
  };
  const matched = bestFormulaSourceCandidate(
    [sourceCandidate],
    herbNames,
    combined,
    explicitlyModified,
    reference.source,
    false,
    baseAliases,
  ) || (!explicitlyModified
    ? bestFormulaSourceCandidate(
        [sourceCandidate],
        herbNames,
        combined,
        true,
        reference.source,
        true,
        baseAliases,
      )
    : undefined);
  const normalizedHerbs = new Set(herbNames.map(normalizeHerbName).filter(Boolean));
  const normalizedBaseAliases = new Set(baseAliases.values());
  const matchedRequiredIngredientCount = reference.requiredIngredients.filter((ingredient) => {
    const normalized = normalizeHerbName(ingredient);
    return normalizedHerbs.has(normalized) ||
      (!sourceIngredientRequiresProcessingIdentity(normalized) && normalizedBaseAliases.has(normalized));
  }).length;
  return {
    formulaName: reference.formulaName,
    source: reference.source,
    verified: Boolean(matched),
    matchedIngredientCount: matched?.overlap || 0,
    totalIngredientCount: reference.ingredients.length,
    minimumPreservedIngredientCount: reference.minimumPreservedIngredientCount,
    matchedRequiredIngredientCount,
    requiredIngredientCount: reference.requiredIngredients.length,
  };
}

/** Verify every named base against its own governed source, anchors, and composition floor. */
export function verifyFormulaCompilationComponents(
  formulaNames: string[],
  herbs: FormulaHerbInput[],
  combined = formulaNames.length > 1,
  explicitlyModified = false,
): FormulaComponentVerification[] {
  return formulaCompilationReferences(formulaNames).map((reference) =>
    verifyFormulaCompilationComponent(reference, herbs, combined, explicitlyModified));
}

export function resolveFormulaSources(candidateName: string, herbs: FormulaHerbInput[] = []): ResolvedFormulaSource[] {
  const herbNames = herbs.map(formulaHerbIdentityName).filter(Boolean);
  const baseAliases = formulaHerbBaseAliases(herbs);
  const baseNames = candidateBaseFormulaNames(candidateName);
  if (baseNames.length === 0 || herbNames.length === 0) return [];
  const resolved: ResolvedFormulaSource[] = [];
  const matchedHerbs = new Set<string>();
  const combined = baseNames.length > 1;
  const explicitlyModified = /(?:加减|化裁|加味)/.test(candidateName);
  const sourceHint = candidateName.match(/《([^》]{2,80})》/)?.[1]?.replace(/[。；;，,\s]+$/g, "") || "";
  for (const normalizedName of baseNames) {
    const candidates: FormulaSourceCandidate[] = [];
    const official = normalizedOfficialClassics.get(normalizedName);
    if (official) {
      candidates.push({
        formulaName: official.name,
        variant: official.variant,
        origin: "official_classic_catalog",
      });
    }
    const verified = normalizedVerifiedSupplements.get(normalizedName);
    if (verified) {
      candidates.push({
        formulaName: verified.name,
        variant: verified.variant,
        origin: "verified_reference_catalog",
      });
    }
    const catalogEntry = normalizedCatalog.get(normalizedName);
    catalogEntry?.variants.forEach((variant) => candidates.push({
      formulaName: catalogEntry.name,
      variant,
      origin: "local_formula_catalog",
    }));
    const matched = bestFormulaSourceCandidate(candidates, herbNames, combined, explicitlyModified, sourceHint, false, baseAliases) ||
      (!explicitlyModified
        ? bestFormulaSourceCandidate(candidates, herbNames, combined, true, sourceHint, true, baseAliases)
        : undefined);
    if (!matched) return [];
    const normalizedHerbs = new Set(herbNames.map(normalizeHerbName).filter(Boolean));
    const normalizedBaseAliases = new Set(baseAliases.values());
    const normalizedIngredients = matched.candidate.variant.ingredients.map(normalizeHerbName).filter(Boolean);
    const requiredIngredients = requiredFormulaAnchors(
      matched.candidate.formulaName,
      matched.candidate.variant,
      normalizedIngredients,
    );
    const matchedRequiredIngredientCount = requiredIngredients.filter((ingredient) =>
      normalizedHerbs.has(ingredient) ||
      (!sourceIngredientRequiresProcessingIdentity(ingredient) && normalizedBaseAliases.has(ingredient))
    ).length;
    matched.matchedHerbs.forEach((herb) => matchedHerbs.add(herb));
    resolved.push({
      formulaName: matched.candidate.formulaName,
      source: matched.candidate.variant.source,
      matchedIngredientCount: matched.overlap,
      totalIngredientCount: matched.candidate.variant.ingredients.length,
      minimumPreservedIngredientCount: matched.candidate.variant.minimumPreservedIngredientCount ??
        Math.max(1, Math.ceil(normalizedIngredients.length * 0.8)),
      matchedRequiredIngredientCount,
      requiredIngredientCount: requiredIngredients.length,
      verificationStatus: "verified_individually",
      exactComposition: matched.f1 >= 0.999 && !matched.usedBaseAlias,
      origin: matched.candidate.origin,
    });
  }
  const normalizedCandidateHerbs = new Set(herbNames.map(normalizeHerbName).filter(Boolean));
  if (combined && (
    explicitlyModified
      ? matchedHerbs.size / Math.max(normalizedCandidateHerbs.size, 1) < 0.6
      : matchedHerbs.size !== normalizedCandidateHerbs.size
  )) return [];
  return resolved.length === baseNames.length ? resolved : [];
}

function professionalModelInferenceEvidence(source: string | undefined): EvidenceRef {
  if (source && !/证据不足|待检索|待核验|内部证据缺口/.test(source)) {
    return { evidenceLevel: "model_inference", source, confidence: "中" };
  }
  return {
    evidenceLevel: "model_inference",
    source: "本例证候、病机、治法与药味功效的结构化匹配（病例内推理，需医生复核）",
    confidence: "中",
  };
}

type ClassicEvidenceResolver = (
  formulaNames: string[],
) => NonNullable<NonNullable<ClinicalReasoningResultV2["formula"]>["candidates"][number]["classicEvidence"]>;

export function enrichReasoning(
  reasoning: ClinicalReasoningResultV2,
  clinicalContext = "",
  classicEvidenceResolver?: ClassicEvidenceResolver,
): { reasoning: ClinicalReasoningResultV2; sourceLabels: string[] } {
  if (!reasoning.formula) return { reasoning, sourceLabels: [] };
  const sourceLabels: string[] = [];
  const candidates = reasoning.formula.candidates.map((candidate) => {
    const herbSafetyProfiles = candidate.herbs.map((herb) => getTcmHerbGenerationSafetyProfile(herb.name));
    const generationSafetyBoundaries = herbSafetyProfiles.flatMap((profile) => {
      const actionableRules = profile.populationRules.filter((rule) => rule.severity !== "LOW");
      if (!profile.isToxic && actionableRules.length === 0) return [];
      return [`${profile.herb}（${[
        ...(profile.isToxic ? [`毒性:${profile.toxicity.join("、")}`] : []),
        ...actionableRules.map((rule) => `${rule.population}:${rule.severity}/${rule.rule}`),
      ].join("；")}）`];
    });
    const sources = resolveFormulaSources(candidate.name, candidate.herbs);
    const sourceLabel = sources.map((item) => `${item.formulaName}：${item.source}`).join("；");
    sourceLabels.push(sourceLabel);
    const constructionType = candidate.herbs.length === 1
      ? (sources.length === 1 ? "single_base" as const : "single_herb" as const)
      : sources.length > 1
        ? "combined" as const
        : sources.length === 1
          ? "single_base" as const
          : "self_devised" as const;
    const inferredCompositionModification = sources.some((item) => !item.exactComposition);
    const baseVerifiedName = sources.length > 0 || /(?:自拟|经验方|协定方|院内方|辨证组方)/.test(candidate.name)
      ? cleanFormulaDisplayName(candidate.name)
      : "本例辨证组方";
    const verifiedName = inferredCompositionModification && sources.length > 0 && !/(?:加减|化裁|加味)/.test(baseVerifiedName)
      ? `${baseVerifiedName}加减`
      : baseVerifiedName;
    const modificationStatus = /(?:加减|化裁|加味)/.test(candidate.name) || sources.length > 1 || inferredCompositionModification
      ? "modified" as const
      : "canonical" as const;
    const explicitIdentityNames = explicitFormulaIdentityNames([candidate.name, ...(candidate.formulaNames || [])]);
    const resolvedFormulaNames = sources.map((item) => item.formulaName);
    return {
      ...candidate,
      name: verifiedName,
      formulaNames: resolvedFormulaNames,
      constructionType,
      modificationStatus,
      therapyMatch: constructionType === "self_devised" ? replaceFormulaIdentityClaims(candidate.therapyMatch, explicitIdentityNames) : candidate.therapyMatch,
      formulaAnalysis: constructionType === "self_devised" ? replaceFormulaIdentityClaims(candidate.formulaAnalysis, explicitIdentityNames) : candidate.formulaAnalysis,
      applicable: professionalCandidateBoundary(
        candidate.applicable,
        "适用于与本例锁定证候、病机和治法一致，且处方前安全信息经医生复核的情况。",
      ),
      notApplicable: [
        professionalCandidateBoundary(
          candidate.notApplicable.split("逐味生成前安全边界：")[0].trim(),
          "证候、病机、舌脉或安全边界发生变化时暂停采用，并重新辨证。",
        ),
        ...(generationSafetyBoundaries.length > 0
          ? [`逐味生成前安全边界：${generationSafetyBoundaries.join("；")}。命中相应人群或状态时按规则停用、替换或由医生/药师复核。`]
          : []),
      ].join(" "),
      baseFormulas: sources.map((item) => ({
        name: item.formulaName,
        source: item.source,
        matchedIngredientCount: item.matchedIngredientCount,
        totalIngredientCount: item.totalIngredientCount,
        minimumPreservedIngredientCount: item.minimumPreservedIngredientCount,
        matchedRequiredIngredientCount: item.matchedRequiredIngredientCount,
        requiredIngredientCount: item.requiredIngredientCount,
        verificationStatus: item.verificationStatus,
      })),
      discriminationPath: formulaDiscriminationPaths(resolvedFormulaNames, clinicalContext),
      classicEvidence: classicEvidenceResolver
        ? classicEvidenceResolver(resolvedFormulaNames)
        : candidate.classicEvidence || [],
      compositionLogic: compositionLogicForFormulaNames(resolvedFormulaNames),
      textualModifications: textualModificationsForFormulaNames(resolvedFormulaNames, clinicalContext),
      formulaSource: sourceLabel
        ? {
            evidenceLevel: sources.every((item) => item.origin !== "local_formula_catalog") ? "classic_text" as const : "kb_entry" as const,
            source: sourceLabel,
            confidence: modificationStatus === "canonical" && sources.every((item) => item.origin === "official_classic_catalog" && item.exactComposition)
              ? "高" as const
              : "中" as const,
          }
        : professionalModelInferenceEvidence(undefined),
      herbs: candidate.herbs.map((herb, herbIndex) => ({
        ...herb,
        isToxic: herbSafetyProfiles[herbIndex]?.isToxic === true,
        ...(/酸枣仁/.test(herb.name) && /先煎/.test(herb.decoctionRequirement || "")
          ? { decoctionRequirement: "捣碎后与群药同煎" }
          : {}),
        evidence: herb.evidence?.evidenceLevel !== "insufficient"
          ? herb.evidence
          : professionalModelInferenceEvidence(undefined),
      })),
    };
  });
  return { reasoning: { ...reasoning, formula: { ...reasoning.formula, candidates } }, sourceLabels };
}

function replaceSelfDevisedFormulaClaims(block: string, explicitIdentityNames: string[]): string {
  return replaceGovernedFormulaClaims(
    replaceLiteralFormulaClaims(block, explicitIdentityNames, "本例辨证组方"),
    "本例辨证组方",
  ).replace(/原方/g, "本方案");
}

function replaceFormulaIdentityClaims(value: string, explicitIdentityNames: string[]): string {
  return replaceGovernedFormulaClaims(
    replaceLiteralFormulaClaims(value, explicitIdentityNames, "本方案"),
    "本方案",
  ).replace(/原方/g, "本方案");
}

function professionalCandidateBoundary(value: string, fallback: string): string {
  return /(?:待核实|未在本次|未记录|未明确|未提及|阴性史待)/.test(value) ? fallback : value;
}

function replaceCandidateSourceFields(
  content: string,
  sourceLabels: string[],
  sourceHeadings: string[],
  candidateNames: string[],
  candidateConstructionTypes: string[],
  candidateIdentityClaims: string[][],
): string {
  const headingPattern = /^#{2,6}\s*候选(?:处方|方案|方药|方药方案)\s*(?:\d+|[一二三四五六七八九十]+)?\s*[：:]\s*[^\n]+/gm;
  const headings = Array.from(content.matchAll(headingPattern));
  if (headings.length === 0) return content;
  let output = "";
  let cursor = 0;
  headings.forEach((heading, index) => {
    const start = heading.index || 0;
    const sentinelIndex = content.search(/<!-- DIAGNOSIS_JSON_START -->/);
    const end = headings[index + 1]?.index ?? (sentinelIndex >= 0 ? sentinelIndex : content.length);
    output += content.slice(cursor, start);
    let block = content.slice(start, end);
    const verifiedName = candidateNames[index];
    if (verifiedName) block = block.replace(/^(#{2,6}\s*候选(?:处方|方案|方药|方药方案)\s*(?:\d+|[一二三四五六七八九十]+)?\s*[：:])\s*[^\n]+/m, `$1${verifiedName}`);
    if (candidateConstructionTypes[index] === "self_devised") {
      block = replaceSelfDevisedFormulaClaims(block, candidateIdentityClaims[index] || []);
    }
    const sourceLabel = sourceLabels[index] || "";
    const sourceHeading = sourceHeadings[index] || "组方依据";
    const replacement = sourceLabel ? `**${sourceHeading}**：${sourceLabel}` : "";
    const sourceField = /^\*\*(?:方剂出处或依据|经典方出处|参考基础方及出处|方剂资料收载来源|组方依据)\*\*[：:].*$/m;
    if (sourceField.test(block)) {
      block = block.replace(sourceField, replacement);
    } else if (replacement) {
      block = block.replace(/^(###[^\n]+)$/m, `$1\n${replacement}`);
    }
    output += block;
    cursor = end;
  });
  return output + content.slice(cursor);
}

export function enrichPrescriptionProvenance(
  content: string,
  clinicalContext = "",
  classicEvidenceResolver?: ClassicEvidenceResolver,
): string {
  let sourceLabels: string[] = [];
  let sourceHeadings: string[] = [];
  let candidateNames: string[] = [];
  let candidateConstructionTypes: string[] = [];
  let candidateIdentityClaims: string[][] = [];
  const enriched = content.replace(
    /<!-- DIAGNOSIS_JSON_START -->\s*([\s\S]*?)\s*<!-- DIAGNOSIS_JSON_END -->/g,
    (match, jsonText: string) => {
      try {
        const parsed = JSON.parse(jsonText) as ClinicalReasoningResultV2;
        if (parsed.schemaVersion !== "tcm-cdss-reasoning-v2" || parsed.stage !== "prescribe") return match;
        candidateIdentityClaims = parsed.formula?.candidates.map((candidate) =>
          explicitFormulaIdentityNames([candidate.name, ...(candidate.formulaNames || [])])
        ) || [];
        const result = enrichReasoning(parsed, clinicalContext, classicEvidenceResolver);
        sourceLabels = result.sourceLabels;
        sourceHeadings = result.reasoning.formula?.candidates.map((candidate) =>
          candidate.modificationStatus === "modified" && candidate.formulaSource.evidenceLevel !== "model_inference"
            ? "参考基础方及出处"
            : candidate.formulaSource.evidenceLevel === "classic_text"
              ? "经典方出处"
              : candidate.formulaSource.evidenceLevel === "kb_entry"
                ? "方剂资料收载来源"
                : "组方依据"
        ) || [];
        candidateNames = result.reasoning.formula?.candidates.map((candidate) => candidate.name) || [];
        candidateConstructionTypes = result.reasoning.formula?.candidates.map((candidate) => candidate.constructionType || "") || [];
        return `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(result.reasoning, null, 2)}\n<!-- DIAGNOSIS_JSON_END -->`;
      } catch {
        return match;
      }
    },
  );
  const alignedNarrative = replaceCandidateSourceFields(
    enriched,
    sourceLabels,
    sourceHeadings,
    candidateNames,
    candidateConstructionTypes,
    candidateIdentityClaims,
  );
  return alignedNarrative.replace(/^([^\n]*酸枣仁[^\n]*)$/gm, (line) =>
    /先煎/.test(line) ? line.replace(/先煎(?:\s*\d+\s*分钟)?/g, "捣碎后同煎") : line
  );
}

export function buildFormulaProvenanceContext(caseState: CaseState): string {
  const diagnose = caseState.reasoningDiagnose || (caseState.reasoningV2?.stage === "diagnose" ? caseState.reasoningV2 : undefined);
  const references = formulaCompilationReferences(diagnose?.overview?.recommendedFormulaNames || []);
  if (references.length === 0) {
    // 不要在这里宣传方剂资料总量。出处库只负责给「已选定的方名」补出处，可被推荐的方剂仅限受控
    // 检索目录；报出目录外的方名会在锁定阶段被剥离并降级为自拟方，宣传一个更大的库只会诱发该失败。
    return "## 本地方剂出处库\n候选方名确定后，由服务端匹配经典出处；可选方剂以上文受控经典方候选为准。若为自拟方，不得伪造原典，只能说明本例组方依据。";
  }
  return [
    "## 本地方剂出处库",
    "以下出处来自本地标准方剂索引；合方须逐一列出基础方出处，加减药味另述本例病机依据：",
    ...references.map((item, index) => `[LOCAL-FORMULA-${String(index + 1).padStart(3, "0")}] ${item.formulaName}：${item.source}`),
  ].join("\n");
}

export function getFormulaCatalogStatus() {
  return {
    schemaVersion: catalog.schemaVersion,
    sourceFile: catalog.sourceFile,
    sourceSha256: catalog.sourceSha256,
    sourceRowCount: catalog.sourceRowCount,
    formulaNameCount: catalog.formulaNameCount,
    officialClassicSourceFile: catalog.officialClassicSourceFile,
    officialClassicSourceSha256: catalog.officialClassicSourceSha256,
    officialClassicFormulaCount: catalog.officialClassicFormulaCount,
    verifiedSupplementSchemaVersion: verifiedSupplements.schemaVersion,
    verifiedSupplementFormulaCount: Object.keys(verifiedSupplements.entries).length,
  };
}
