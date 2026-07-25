import icdIndex from "../data/icd10-diagnosis-index.json" with { type: "json" };

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
};
const entryByCode = new Map(entries.map((entry) => [entry.code, entry]));

function normalizeDiagnosisName(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/^(?:西医诊断|初步诊断|临床诊断|考虑|疑似|可能)\s*[：:]?/g, "")
    .replace(/(?:可能|待排|待明确|待鉴别|倾向)$/g, "")
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
  if (status !== "考虑" || /(?:症状性诊断|病因待|急危重症风险|无法形成|待临床鉴别)/.test(name)) return undefined;
  for (const key of lookupKeys(name)) {
    const match = uniqueBestEntry(byAlias.get(key) || []);
    if (match) {
      return { system: "ICD-10", code: match.code, display: match.name, source: SOURCE, mapping: "exact_alias" };
    }
  }
  const normalized = normalizeDiagnosisName(name);
  const governedCode = Object.entries(GOVERNED_CLINICAL_ALIASES)
    .find(([alias]) => normalized === alias || normalized.startsWith(alias))?.[1];
  const governed = governedCode ? entryByCode.get(governedCode) : undefined;
  if (governed) {
    return { system: "ICD-10", code: governed.code, display: governed.name, source: SOURCE, mapping: "governed_alias" };
  }
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
          westernDiagnosis?: { primary?: { name?: unknown; status?: unknown; coding?: unknown } };
        };
        const primary = parsed.westernDiagnosis?.primary;
        if (!primary || typeof primary.name !== "string") return match;
        const coding = resolveIcd10Diagnosis(primary.name, String(primary.status || ""));
        if (coding) primary.coding = coding;
        else delete primary.coding;
        return `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(parsed)}\n<!-- DIAGNOSIS_JSON_END -->`;
      } catch {
        return match;
      }
    },
  );
}
