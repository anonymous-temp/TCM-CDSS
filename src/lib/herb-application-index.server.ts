import "server-only";
import textbookJson from "../data/tcm-herb-textbook-references.json";
import relevance from "../data/tcm-modification-relevance.source.json";
import { preciseHerbSourceName } from "./herb-function-display-source";
import { compositionIdentityName } from "./tcm-formula-provenance";
import { contentDigest } from "./m04-content-fingerprint";
import type { ModificationOption, PresentFinding, SourceSpan } from "./m04-final-content-types";

type ApplicationHerb = { applications?: string; applicationsLine?: number | null; parent?: string };
const TABLE = textbookJson as unknown as { source: { sha256: string }; herbs: Record<string, ApplicationHerb> };
let index: Map<string, readonly SourceSpan[]> | undefined;
function applicationIndex(): Map<string, readonly SourceSpan[]> {
  if (index) return index;
  index = new Map();
  for (const [name, entry] of Object.entries(TABLE.herbs)) {
    if (!entry.applications || !entry.applicationsLine || entry.parent) continue;
    let offset = 0;
    const paragraphs = entry.applications.split("\n").filter(Boolean).map((text, paragraph) => {
      const start = entry.applications!.indexOf(text, offset); offset = start + text.length;
      const line = entry.applicationsLine! + entry.applications!.slice(0, start).split("\n").length - 1;
      const digest = contentDigest([TABLE.source.sha256, name, text, line]);
      return { id: `application:${name}:${paragraph + 1}:${digest}`, kind: "textbook_application" as const,
        herbKey: name, text, sourceRef: `《中药学》${name}【应用】`, sourceDigest: digest,
        lineStart: line, lineEnd: line, start, end: start + text.length };
    });
    index.set(name, paragraphs);
  }
  return index;
}
export function herbApplications(name: string): readonly SourceSpan[] {
  // Labels in the paragraph settle 生/制何首乌. The bare name is ambiguous.
  if (name === "何首乌") return [];
  if (/^(生|制)何首乌$/u.test(name)) return (applicationIndex().get("何首乌") || [])
    .filter((source) => source.text.includes(name) && !source.text.includes(name.startsWith("生") ? "制何首乌" : "生何首乌"))
    .map((source) => ({ ...source, herbKey: name, id: `${source.id}:${name}` }));
  const key = preciseHerbSourceName(name);
  return key ? applicationIndex().get(key) || [] : [];
}
export function applicationCitation(source: SourceSpan): string {
  return `${source.sourceRef}（第${source.lineStart}行；${source.id}；${source.sourceDigest}）：${source.text}`;
}
export function applicationCitationVerified(source: string): boolean {
  for (const name of [...applicationIndex().keys(), "生何首乌", "制何首乌"]) {
    if (herbApplications(name).some((span) => applicationCitation(span) === source)) return true;
  }
  return false;
}
export function applicationRecallCatalog(): readonly { id: string; name: string; titles: string[] }[] {
  const names = [...applicationIndex().keys()].flatMap((name) => name === "何首乌" ? ["生何首乌", "制何首乌"] : [name]);
  return names.map((name) => ({ id: `herb:${name}`, name,
    titles: herbApplications(name).map((span) => span.text.split(/[　。]/u)[0]).slice(0, 2) }));
}
function bigrams(text: string): string[] {
  const chars = text.replace(/[^一-鿿]/gu, "");
  return [...new Set(Array.from({ length: Math.max(0, chars.length - 1) }, (_, index) => chars.slice(index, index + 2)))];
}
const EQUIVALENTS = relevance.equivalents as Record<string, string[]>;
export function retrieveApplicationCandidates(input: {
  record: string; prior: unknown; findings: readonly PresentFinding[]; baseHerbNames: readonly string[];
  textbookEntryIds: readonly string[];
  /** Server-extracted herbs belonging to those exact textbook entries; recall only. */
  textbookHerbNames?: readonly string[]; recalledHerbIds?: readonly string[];
}, limits = { perFinding: 10, total: 24 }): readonly ModificationOption[] {
  const pool: ModificationOption[] = [];
  for (const finding of input.findings) {
    const tokens = bigrams(finding.quote);
    const synonyms = Object.entries(EQUIVALENTS).filter(([term]) => finding.quote.includes(term)).flatMap(([, group]) => group);
    const scored = applicationRecallCatalog().map((entry) => entry.name).flatMap((name) => {
      if (input.baseHerbNames.some((base) => compositionIdentityName(base) === compositionIdentityName(name))) return [];
      const applications = herbApplications(name);
      const ranked = applications.map((source) => {
        const words = bigrams(source.text), title = source.text.split(/[　。]/u)[0];
        // Length-normalized term overlap plus an independent governed-synonym/textbook recall path.
        const lexical = tokens.filter((token) => words.includes(token)).length / (1 + words.length / 160);
        const concept = synonyms.some((term) => source.text.includes(term)) ? 3 : 0;
        return { source, score: lexical + concept + (tokens.some((token) => title.includes(token)) ? 2 : 0) };
      }).sort((a,b) => b.score - a.score);
      const closedRecall = input.recalledHerbIds?.includes(`herb:${name}`) || input.textbookHerbNames?.includes(name);
      if (!ranked[0] || ranked[0].score === 0 && !closedRecall) return [];
      return [{ name, score: ranked[0].score + (closedRecall ? 4 : 0), applications: ranked.filter((item) => item.score > 0 || closedRecall).slice(0, 2).map((item) => item.source) }];
    }).sort((a,b) => b.score - a.score || a.name.localeCompare(b.name));
    for (const item of scored.slice(0, Math.max(0, Math.min(12, limits.perFinding)))) {
      if (new Set(pool.map((option) => option.herbKey)).size >= Math.min(24, limits.total) && !pool.some((option) => option.herbKey === item.name)) continue;
      pool.push({ id: `option:${contentDigest([finding.id,item.name,item.applications.map((span) => span.id)])}`,
        findingId: finding.id, herbKey: item.name, displayName: item.name, action: "加", applications: item.applications, scope: "uncovered" });
    }
  }
  return pool;
}

/** Position binding only. Current/affirmed/target eligibility is a separate semantic decision. */
export function validatePresentFindingQuote(finding: PresentFinding, record: string, fields?: Readonly<Record<string, string>>): boolean {
  if (!finding.id || finding.quote.length < 2 || !Number.isInteger(finding.start) || !Number.isInteger(finding.end) || finding.start < 0) return false;
  const field = fields ? fields[finding.fieldRef] : finding.fieldRef === "record" ? record : undefined;
  return typeof field === "string" && record.includes(field) && field.slice(finding.start, finding.end) === finding.quote && finding.end - finding.start === finding.quote.length;
}
