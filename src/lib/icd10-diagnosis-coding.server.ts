import icdIndex from "../data/icd10-diagnosis-index.json" with { type: "json" };
import { clinicalClausePolarity } from "./clinical-polarity";

type IcdEntry = {
  code: string;
  name: string;
  level: "diagnosis" | "subcategory" | "category";
  aliases: string[];
};

export type Icd10DiagnosisCoding = {
  system: "ICD-10";
  code: string;
  display: string;
  source: string;
  mapping: "exact_alias" | "governed_alias" | "unique_subcategory";
};

const SOURCE = "ICD-10医保2.0版-中英对应-20220426";
const entries = (icdIndex as { entries?: IcdEntry[] }).entries || [];
const levelPriority: Record<IcdEntry["level"], number> = { diagnosis: 0, subcategory: 1, category: 2 };
const GOVERNED_SYMPTOM_ALIASES: Readonly<Record<string, string>> = {
  胃食管反流症状: "R12.x00x002",
  反流症状: "R12.x00x002",
  反酸烧心症状: "R12.x00x002",
  嗳气症状: "R14.x00x002",
};
const GOVERNED_CLINICAL_ALIASES: Readonly<Record<string, string>> = {
  copd: "J44.900",
  慢性咳嗽: "R05.x00",
  咳嗽症状: "R05.x00",
  慢阻肺: "J44.900",
  慢性阻塞性肺疾病: "J44.900",
  慢性阻塞性肺病: "J44.900",
  慢性失眠障碍: "G47.000",
  失眠障碍: "G47.000",
  便秘症状: "K59.000",
  ...GOVERNED_SYMPTOM_ALIASES,
};
// These labels already denote an etiologically unspecified ICD entity. Appending “病因待查” does
// not make them safer; it makes the clinician-facing diagnosis self-contradictory and prevents the
// exact payer-code match. Keep this list narrow and code-backed: disease-specific labels such as
// gout or GERD are intentionally absent and therefore remain fail-closed when similarly qualified.
const GOVERNED_REDUNDANT_CAUSE_QUALIFIER_CODES: Readonly<Record<string, string>> = {
  急性上呼吸道感染: "J06.900",
};
const entryByCode = new Map(entries.map((entry) => [entry.code, entry]));

function normalizeDiagnosisName(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/^(?:西医诊断|初步诊断|临床诊断|考虑|疑似|可能)\s*[：:]?/g, "")
    .replace(/[，,]?(?:病因待查|病因待鉴别|病因未明|可能|待排|待明确|待鉴别|倾向)$/g, "")
    .replace(/[\s\-—_，,。；;：:（）()\[\]［］【】“”"'‘’/\\]/g, "")
    .toLowerCase();
}

const byAlias = new Map<string, IcdEntry[]>();
for (const entry of entries) {
  for (const rawAlias of [entry.name, ...entry.aliases]) {
    const alias = normalizeDiagnosisName(rawAlias);
    if (alias.length < 2) continue;
    const bucket = byAlias.get(alias) || [];
    if (!bucket.some((candidate) => candidate.code === entry.code && candidate.level === entry.level)) bucket.push(entry);
    byAlias.set(alias, bucket);
  }
}

function uniqueBestEntry(candidates: readonly IcdEntry[]): IcdEntry | undefined {
  if (candidates.length === 0) return undefined;
  const bestLevel = Math.min(...candidates.map((entry) => levelPriority[entry.level]));
  const best = candidates.filter((entry) => levelPriority[entry.level] === bestLevel);
  const codes = new Map(best.map((entry) => [entry.code, entry]));
  return codes.size === 1 ? [...codes.values()][0] : undefined;
}

function lookupKeys(name: string): string[] {
  const normalized = normalizeDiagnosisName(name);
  const keys = [normalized];
  for (const suffix of ["疾病", "障碍", "综合征", "病", "症"]) {
    if (normalized.endsWith(suffix) && normalized.length - suffix.length >= 2) {
      keys.push(normalized.slice(0, -suffix.length));
    }
  }
  return [...new Set(keys)];
}

export function resolveIcd10Diagnosis(name: string, status: string = "考虑"): Icd10DiagnosisCoding | undefined {
  const limitedEvidence = status === "证据有限";
  const causeUnresolved = /(?:病因待查|病因待鉴别|病因未明)/.test(name);
  if ((status !== "考虑" && !limitedEvidence) || /(?:症状性诊断|急危重症风险|无法形成|待临床鉴别)/.test(name)) return undefined;
  const normalized = normalizeDiagnosisName(name);
  const redundantCauseQualifierCode = causeUnresolved
    ? Object.entries(GOVERNED_REDUNDANT_CAUSE_QUALIFIER_CODES)
        .find(([canonicalName]) => normalizeDiagnosisName(canonicalName) === normalized)?.[1]
    : undefined;
  const symptomOnlyBoundary = limitedEvidence || (causeUnresolved && !redundantCauseQualifierCode);
  const limitedStatusAllows = (entry: IcdEntry): boolean =>
    (!symptomOnlyBoundary || entry.code.startsWith("R") || normalized.endsWith("症状")) &&
    (!redundantCauseQualifierCode || entry.code === redundantCauseQualifierCode);
  for (const key of lookupKeys(name)) {
    const match = uniqueBestEntry(byAlias.get(key) || []);
    if (match && limitedStatusAllows(match)) {
      return { system: "ICD-10", code: match.code, display: match.name, source: SOURCE, mapping: "exact_alias" };
    }
  }
  const governedCode = Object.entries(GOVERNED_CLINICAL_ALIASES)
    .find(([alias]) => normalized === alias || normalized.startsWith(alias))?.[1];
  const governed = governedCode ? entryByCode.get(governedCode) : undefined;
  if (governed && limitedStatusAllows(governed)) {
    return { system: "ICD-10", code: governed.code, display: governed.name, source: SOURCE, mapping: "governed_alias" };
  }
  if (symptomOnlyBoundary || causeUnresolved) return undefined;
  const fuzzySubcategories = entries.filter((entry) =>
    entry.level === "subcategory" &&
    [entry.name, ...entry.aliases].some((alias) => {
      const key = normalizeDiagnosisName(alias);
      return key.length >= 4 && (normalized.includes(key) || key.includes(normalized));
    }));
  const uniqueSubcategory = uniqueBestEntry(fuzzySubcategories);
  if (uniqueSubcategory) {
    return {
      system: "ICD-10",
      code: uniqueSubcategory.code,
      display: uniqueSubcategory.name,
      source: SOURCE,
      mapping: "unique_subcategory",
    };
  }
  return undefined;
}

/** Replace any provider-supplied code with a deterministic workbook match, or omit it. */
export function applyDeterministicIcd10Coding(content: string): string {
  return content.replace(
    /<!-- DIAGNOSIS_JSON_START -->\s*([\s\S]*?)\s*<!-- DIAGNOSIS_JSON_END -->/g,
    (match, jsonText: string) => {
      try {
        const parsed = JSON.parse(jsonText) as {
          westernDiagnosis?: {
            primary?: {
              name?: unknown;
              status?: unknown;
              coding?: unknown;
              supportingFacts?: unknown;
              clinicalRationale?: unknown;
              limitations?: unknown;
              suggestedChecks?: unknown;
            };
            differentials?: unknown;
          };
        };
        const primary = parsed.westernDiagnosis?.primary;
        if (!primary || typeof primary.name !== "string") return match;
        const supportingFacts = Array.isArray(primary.supportingFacts)
          ? primary.supportingFacts.filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
          : [];
        const unresolvedRefluxDisease =
          normalizeDiagnosisName(primary.name) === "胃食管反流病" &&
          /(?:病因待查|病因待鉴别|病因未明)/.test(primary.name) &&
          supportingFacts.some((fact) => fact.includes("反酸") && clinicalClausePolarity(fact) === "affirmed");
        if (unresolvedRefluxDisease) {
          const limitations = Array.isArray(primary.limitations)
            ? primary.limitations.filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
            : [];
          const suggestedChecks = Array.isArray(primary.suggestedChecks)
            ? primary.suggestedChecks.filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
            : [];
          const differentials = Array.isArray(parsed.westernDiagnosis?.differentials)
            ? parsed.westernDiagnosis.differentials.filter((value): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value)))
            : [];
          if (!differentials.some((item) => normalizeDiagnosisName(String(item.name || "")) === "胃食管反流病")) {
            differentials.unshift({
              name: "胃食管反流病",
              reason: typeof primary.clinicalRationale === "string" ? primary.clinicalRationale : "需结合客观检查确认疾病诊断",
              distinguishingPoints: limitations.join("；") || "当前只有症状依据，尚缺疾病级客观依据",
              nextCheck: suggestedChecks[0] || null,
            });
          }
          parsed.westernDiagnosis!.differentials = differentials;
          primary.name = "反酸";
          primary.clinicalRationale = "本例已记录反酸及相关消化道症状；在缺少疾病级客观检查依据时，本轮以反酸作为症状级工作诊断，胃食管反流病保留在鉴别诊断中。";
        }
        const primaryName = String(primary.name || "");
        const normalizedPrimaryName = normalizeDiagnosisName(primaryName);
        const coding = resolveIcd10Diagnosis(primaryName, String(primary.status || ""));
        if (coding) {
          primary.coding = coding;
          // “胃食管反流症状”这类疾病名+症状后缀不是规范诊断名。映射到受治理症状码时，
          // 主诊断名同步改为编码名称；疾病实体继续由既有 differentials 承载。
          if (coding.mapping === "governed_alias" && Object.hasOwn(GOVERNED_SYMPTOM_ALIASES, normalizedPrimaryName)) {
            primary.name = coding.display;
          }
          const redundantCauseQualifierCode = /(?:病因待查|病因待鉴别|病因未明)/.test(primaryName)
            ? Object.entries(GOVERNED_REDUNDANT_CAUSE_QUALIFIER_CODES)
                .find(([canonicalName]) => normalizeDiagnosisName(canonicalName) === normalizedPrimaryName)?.[1]
            : undefined;
          if (redundantCauseQualifierCode === coding.code) {
            primary.name = coding.display;
            if (typeof primary.clinicalRationale === "string") {
              primary.clinicalRationale = primary.clinicalRationale.replaceAll(primaryName, coding.display);
            }
          }
        }
        else delete primary.coding;
        return `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(parsed)}\n<!-- DIAGNOSIS_JSON_END -->`;
      } catch {
        return match;
      }
    },
  );
}
