import referenceRules from "../data/western-guideline-reference-rules.source.json" with { type: "json" };
import criteriaSource from "../data/western-diagnostic-criteria.source.json" with { type: "json" };

type Citation = { evidenceId: string; citation: string; url?: string; appliesTo?: string };
type Criteria = { name: string; aliases?: string[]; title: string; siteName: string; url: string };
const entries: readonly Criteria[] = criteriaSource.entries;
const qualifiers = [...Object.values(criteriaSource.nameLookupQualifiers).filter((value): value is string[] => Array.isArray(value)).flat(), ...referenceRules.additionalCourseQualifiers].sort((a, b) => b.length - a.length);
const withoutPending = (name: string) => String(name || "").normalize("NFKC").replace(/\s+/gu, "").replace(/[,(]?(?:病因)?待[查排][)]?$/u, "");

/** 病名核心保留器官/病因；只去已治理的病程、侧别、人群及待查限定，不借主诉症状选指南。 */
export function westernGuidelineCore(name: string): string {
  let value = withoutPending(name);
  for (;;) {
    const prefix = qualifiers.find((term) => value.startsWith(term) && value.length > term.length + 1);
    if (!prefix) return value;
    value = value.slice(prefix.length);
  }
}
function criteriaForGuideline(name: string): Criteria | undefined {
  const settledName = withoutPending(name);
  const core = westernGuidelineCore(name);
  return entries.find((entry) => entry.name === settledName || entry.aliases?.includes(settledName)) ||
    entries.find((entry) => westernGuidelineCore(entry.name) === core || entry.aliases?.some((alias) => westernGuidelineCore(alias) === core));
}
export function westernGuidelineTitleMatches(name: string, title: string): boolean {
  const entry = criteriaForGuideline(name);
  const concepts = [westernGuidelineCore(name), ...(entry ? [entry.name, ...(entry.aliases || [])].map(westernGuidelineCore) : [])];
  // citation 的末尾括注是机构/年份；学组名或摘要里的病名不能冒充题名命中。
  const normalized = String(title || "").normalize("NFKC").replace(/\s*(?:URL:)?https?:\/\/\S+.*$/iu, "").replace(/\s+/gu, "").replace(/\([^()]*\)$/u, "");
  return concepts.some((concept) => concept.length >= 2 && normalized.includes(concept));
}

/** 输入的引用已由 evidence scope 核真；此处只按最终病名核题，查表兜底绝不接受模型的 URL/title。 */
export function finalWesternGuidelineReferences(name: string, verified: readonly Citation[]): Citation[] {
  const relevant = verified.filter((citation) => citation && typeof citation.citation === "string" && westernGuidelineTitleMatches(name, citation.citation));
  if (relevant.length) return relevant.slice(0, 1);
  const entry = criteriaForGuideline(name);
  return entry?.url && entry.title ? [{ evidenceId: `LOCAL-WESTERN-CRITERIA:${entry.name}`, citation: [entry.title, entry.siteName].filter(Boolean).join("（") + (entry.siteName ? "）" : ""), url: entry.url }] : [];
}

/** 定稿（所有病名核对与 certainty 改名）之后再次核题；重复调用不会复活旧病名的引用。 */
export function finalizeWesternGuidelineContent(content: string): string {
  return content.replace(/<!-- DIAGNOSIS_JSON_START -->\s*([\s\S]*?)\s*<!-- DIAGNOSIS_JSON_END -->/gu, (block, raw: string) => {
    try {
      const parsed = JSON.parse(raw);
      if (parsed.stage !== "diagnose" || !parsed.westernDiagnosis?.primary) return block;
      const primary = parsed.westernDiagnosis.primary;
      primary.guidelineReferences = finalWesternGuidelineReferences(primary.name, Array.isArray(primary.guidelineReferences) ? primary.guidelineReferences : []);
      return `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(parsed)}\n<!-- DIAGNOSIS_JSON_END -->`;
    } catch { return block; }
  });
}
