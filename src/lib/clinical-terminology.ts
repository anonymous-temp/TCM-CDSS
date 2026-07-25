import { canonicalTcmLocationTerm, canonicalTcmNatureTerm } from "./clinical-governance-tables";

const SPACE_AND_PUNCTUATION = /[\s，,。.!！?？；;：:、（）()【】\[\]《》"'“”‘’_-]+/g;

type TerminologyReasoning = {
  overview: { primarySyndrome: string; tcmDiseaseName?: string };
  westernDiagnosis: { primary: { name: string }; differentials?: Array<{ name: string }> };
  pathogenesis?: {
    locationDifferentiation?: { items?: string[] };
    natureDifferentiation?: { items?: string[]; rootDeficiency?: string[]; branchExcess?: string[] };
  };
  therapy?: { overallPrinciple?: string; overallMethod?: string };
};

function compactTerm(value: unknown): string {
  return typeof value === "string" ? value.normalize("NFKC").replace(SPACE_AND_PUNCTUATION, "").trim() : "";
}

type TerminologyRule = {
  pattern: RegExp;
  canonical: string;
};

const WESTERN_DIAGNOSIS_RULES: readonly TerminologyRule[] = [
  { pattern: /(?:慢性|非器质性).*失眠|失眠.*(?:慢性|非器质性)/, canonical: "慢性失眠障碍" },
  { pattern: /失眠(?:障碍|综合征|症)?/, canonical: "失眠障碍" },
  { pattern: /(?:原发性)?高血压(?:病)?/, canonical: "高血压" },
  { pattern: /2型糖尿病|二型糖尿病/, canonical: "2型糖尿病" },
  { pattern: /阻塞性睡眠呼吸暂停(?:低通气)?(?:综合征)?|OSA/, canonical: "阻塞性睡眠呼吸暂停" },
  { pattern: /不宁腿(?:综合征)?|RLS/, canonical: "不宁腿综合征" },
] as const;

const TCM_DISEASE_RULES: readonly TerminologyRule[] = [
  { pattern: /失眠|不寐/, canonical: "不寐" },
  { pattern: /头晕|眩晕/, canonical: "眩晕" },
  { pattern: /心慌|心悸/, canonical: "心悸" },
  { pattern: /胃痛|胃脘痛/, canonical: "胃脘痛" },
  { pattern: /腹泻|泄泻/, canonical: "泄泻" },
  { pattern: /便秘/, canonical: "便秘" },
  { pattern: /咳嗽/, canonical: "咳嗽" },
  { pattern: /头痛/, canonical: "头痛" },
  { pattern: /盗汗|自汗|汗证/, canonical: "汗证" },
] as const;

function canonicalFromRules(value: string, rules: readonly TerminologyRule[]): string | undefined {
  const compact = compactTerm(value);
  return rules.find((rule) => rule.pattern.test(compact))?.canonical;
}

export function canonicalWesternDiagnosisName(value: unknown): string {
  const original = typeof value === "string" ? value.trim() : "";
  return canonicalFromRules(original, WESTERN_DIAGNOSIS_RULES) || original;
}

/**
 * Differential rows are diagnostic identities, not free-form conclusions. A provider can wrap a
 * governed disease name in prose (for example, "症状待查，需排除阻塞性睡眠呼吸暂停") and also emit the
 * same disease as a standalone row. Resolve both to the same canonical identity so downstream
 * de-duplication and contract checks cannot mistake wording variation for two diagnoses.
 */
export function canonicalWesternDifferentialName(value: unknown): string {
  return canonicalWesternDiagnosisName(value);
}

export function westernDifferentialIdentity(value: unknown): string {
  return compactTerm(canonicalWesternDifferentialName(value));
}

export function canonicalTcmDiseaseName(
  value: unknown,
  context: TerminologyReasoning,
): string | undefined {
  const original = typeof value === "string" ? value.trim() : "";
  const direct = canonicalFromRules(original, TCM_DISEASE_RULES);
  if (direct) return direct;
  // Do not turn a Western diagnosis or a short-lived symptom into a TCM disease automatically.
  // The compatibility fallback only recovers legacy outputs that mixed the disease name into the
  // syndrome field (for example "失眠（心脾两虚证）").
  const inferred = canonicalFromRules(context.overview.primarySyndrome, TCM_DISEASE_RULES);
  return inferred || original || undefined;
}

export function withCanonicalClinicalTerminology<T extends TerminologyReasoning>(
  reasoning: T,
): T {
  const westernName = canonicalWesternDiagnosisName(reasoning.westernDiagnosis.primary.name);
  const normalized = {
    ...reasoning,
    westernDiagnosis: {
      ...reasoning.westernDiagnosis,
      primary: {
        ...reasoning.westernDiagnosis.primary,
        name: westernName || reasoning.westernDiagnosis.primary.name,
      },
      ...(reasoning.westernDiagnosis.differentials
        ? {
            differentials: reasoning.westernDiagnosis.differentials.map((item) => ({
              ...item,
              name: canonicalWesternDifferentialName(item.name) || item.name,
            })),
          }
        : {}),
    },
  };
  const tcmDiseaseName = canonicalTcmDiseaseName(normalized.overview.tcmDiseaseName, normalized);
  const location = normalized.pathogenesis?.locationDifferentiation;
  const nature = normalized.pathogenesis?.natureDifferentiation;
  const therapy = normalized.therapy;
  const canonicalList = (
    values: string[] | undefined,
    canonicalize: (value: string) => { canonical: string } | undefined,
  ) => Array.isArray(values)
    ? [...new Set(values.map((value) => canonicalize(value)?.canonical || value.trim()).filter(Boolean))]
    : values;
  return {
    ...normalized,
    overview: {
      ...normalized.overview,
      ...(tcmDiseaseName ? { tcmDiseaseName } : {}),
    },
    ...(normalized.pathogenesis ? {
      pathogenesis: {
        ...normalized.pathogenesis,
        ...(location ? {
          locationDifferentiation: {
            ...location,
            items: canonicalList(location.items, canonicalTcmLocationTerm),
          },
        } : {}),
        ...(nature ? {
          natureDifferentiation: {
            ...nature,
            items: canonicalList(nature.items, canonicalTcmNatureTerm),
            rootDeficiency: canonicalList(nature.rootDeficiency, canonicalTcmNatureTerm),
            branchExcess: canonicalList(nature.branchExcess, canonicalTcmNatureTerm),
          },
        } : {}),
      },
    } : {}),
    // Do not invent a cross-case treatment principle when terminology normalization misses.
    // The original value must reach the M03 repair contract, which can request a clinically
    // supported principle instead of silently turning every case into “因人制宜”.
    ...(therapy ? { therapy } : {}),
  } as T;
}
