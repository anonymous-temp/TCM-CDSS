import { resolveNationalStandardTcmSyndromeTerm } from "./clinical-governance-tables";
import { resolveTcmDiseaseName } from "./clinical-terminology";
import type { ClinicalCitation } from "./diagnosis-types";

const START_MARKER = "<!-- DIAGNOSIS_JSON_START -->";
const END_MARKER = "<!-- DIAGNOSIS_JSON_END -->";

const DISEASE_STANDARD_CITATION: ClinicalCitation = {
  evidenceId: "STD-GBT-15657-2021",
  citation: "国家市场监督管理总局, 国家标准化管理委员会. 中医病证分类与代码: GB/T 15657-2021[S]. 2021.",
  sourceType: "standard",
};

const SYNDROME_STANDARD_CITATION: ClinicalCitation = {
  evidenceId: "STD-GBT-16751-2-2021",
  citation: "国家市场监督管理总局, 国家标准化管理委员会. 中医临床诊疗术语 第2部分: 证候: GB/T 16751.2-2021[S]. 2021.",
  sourceType: "standard",
};

export function tcmDiseaseStandardCitations(value: unknown): ClinicalCitation[] {
  const resolved = resolveTcmDiseaseName(value);
  if (!resolved || (resolved.status !== "standard" && resolved.status !== "standard_alias")) {
    return [];
  }
  return [{ ...DISEASE_STANDARD_CITATION }];
}

function citationKey(value: unknown): string {
  return typeof value === "string"
    ? value.normalize("NFKC").replace(/[\s，,。；;：:、（）()《》\[\]]+/g, "")
    : "";
}

function governedExtensionDiseaseCitations(
  value: unknown,
  references: readonly unknown[],
): ClinicalCitation[] {
  const resolved = resolveTcmDiseaseName(value);
  if (!resolved || resolved.status !== "extension") return [];
  const diseaseKey = citationKey(resolved.canonical);
  if (!diseaseKey) return [];
  const seen = new Set<string>();
  return references.flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const item = raw as Partial<ClinicalCitation>;
    const evidenceId = typeof item.evidenceId === "string" ? item.evidenceId.trim() : "";
    const citation = typeof item.citation === "string" ? item.citation.trim() : "";
    if (!evidenceId || !citation || seen.has(evidenceId) || !citationKey(citation).includes(diseaseKey)) return [];
    if (item.sourceType !== "guideline" && item.sourceType !== "consensus") return [];
    seen.add(evidenceId);
    return [{ ...item, evidenceId, citation } as ClinicalCitation];
  });
}

export function tcmSyndromeStandardCitations(value: unknown): ClinicalCitation[] {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return [];
  const segments = text
    .split(/[，,、；;+/]/)
    .map((item) => item.trim())
    .filter(Boolean);
  const allSegmentsGoverned = segments.length > 0 && segments.every((item) =>
    Boolean(resolveNationalStandardTcmSyndromeTerm(item)),
  );
  return allSegmentsGoverned ? [{ ...SYNDROME_STANDARD_CITATION }] : [];
}

export function applyGovernedTcmDiagnosticCitations(content: string): string {
  const start = content.indexOf(START_MARKER);
  const end = start >= 0 ? content.indexOf(END_MARKER, start + START_MARKER.length) : -1;
  if (start < 0 || end < 0) return content;
  try {
    const parsed = JSON.parse(content.slice(start + START_MARKER.length, end).trim()) as {
      schemaVersion?: unknown;
      stage?: unknown;
      overview?: Record<string, unknown>;
      westernDiagnosis?: {
        primary?: { guidelineReferences?: unknown[] };
        differentials?: Array<{ guidelineReferences?: unknown[] }>;
      };
    };
    if (parsed.schemaVersion !== "tcm-cdss-reasoning-v2" || parsed.stage !== "diagnose" || !parsed.overview) {
      return content;
    }
    const availableGuidelineReferences = [
      ...(Array.isArray(parsed.westernDiagnosis?.primary?.guidelineReferences)
        ? parsed.westernDiagnosis.primary.guidelineReferences
        : []),
      ...(Array.isArray(parsed.westernDiagnosis?.differentials)
        ? parsed.westernDiagnosis.differentials.flatMap((item) =>
            Array.isArray(item?.guidelineReferences) ? item.guidelineReferences : [])
        : []),
    ];
    const diseaseStandards = tcmDiseaseStandardCitations(parsed.overview.tcmDiseaseName);
    parsed.overview.tcmDiseaseReferences = diseaseStandards.length > 0
      ? diseaseStandards
      : governedExtensionDiseaseCitations(parsed.overview.tcmDiseaseName, availableGuidelineReferences);
    parsed.overview.tcmSyndromeReferences = tcmSyndromeStandardCitations(parsed.overview.primarySyndrome);
    return `${content.slice(0, start)}${START_MARKER}\n${JSON.stringify(parsed, null, 2)}\n${content.slice(end)}`;
  } catch {
    return content;
  }
}
