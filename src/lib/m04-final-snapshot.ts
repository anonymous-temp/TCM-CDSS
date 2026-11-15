import originalJson from "../data/tcm-formula-original-compositions.json";
import textbookJson from "../data/tcm-herb-textbook-references.json";
import distinctions from "../data/tcm-formula-original-form-distinctions.source.json";
import citationsJson from "../data/tcm-fangjixue-formula-citations.json";
import { originalFormulasNamed, canonicalFormulaBook, originalFormulaNameKey, originalHerbAcceptedSubstitutes, withoutPreparationPrefix, type OriginalFormula } from "./formula-original-composition";
import { compositionIdentityName, originalFormulaFor, originalHerbMatches } from "./tcm-formula-provenance";
import { herbFunctionSourceClauses } from "./herb-function-display-source";
import { contentDigest, freezeContent, stableContent } from "./m04-content-fingerprint";
import { asRecord, asRecords, asText, type FinalM04Snapshot, type FormulaDelta, type SourceSpan, type PresentFinding } from "./m04-final-content-types";

export type FinalSnapshotContext = {
  record: string; prior: unknown; candidateIndex?: number; textbookRowId?: string;
  /** Server-resolved version choices, never model metadata. Keys are base formula names. */
  variants?: Readonly<Record<string, string>>; alternates?: Readonly<Record<string, number>>;
  decoctionGuideNames?: readonly string[];
  /** Test/data adapter: use the same complete versioned records, not catalog compositions. */
  originals?: readonly OriginalFormula[];
  findings?: readonly PresentFinding[];
};
const SOURCE_VERSION = contentDigest([originalJson, textbookJson, distinctions, citationsJson, "m04-final-v1"]);

function formDomain(name: string, original: boolean): string {
  for (const entry of distinctions.forms) for (const group of entry.groups) {
    if ((original ? group.originalNames : group.prescriptionNames).includes(name)) return `${entry.herb}:${group.form}`;
  }
  return "";
}
export function exactHerbFormKey(name: string): string {
  return `${compositionIdentityName(name)}:${formDomain(name, false)}:${name}`;
}
function sameComposition(original: string, current: string): boolean {
  const left = formDomain(original, true), right = formDomain(current, false);
  if (left && right && left !== right) return false;
  // 生/制何首乌 must not collapse into the same composition identity.
  if (/何首乌$/u.test(original) && /何首乌$/u.test(current) && original !== current) return false;
  return originalHerbMatches(original, current);
}

export function deriveFormulaDelta(candidateValue: unknown, context: FinalSnapshotContext): FormulaDelta {
  const candidate = asRecord(candidateValue);
  const selfDevised = candidate.constructionType === "self_devised" || candidate.identityDeclassified === true;
  const explicit = asRecords(candidate.baseFormulas);
  const bases = explicit.length ? explicit : (selfDevised ? candidate.declassifiedFromFormulaNames : candidate.formulaNames);
  const names = Array.isArray(bases) && bases.length ? bases.map((base) => typeof base === "string" ? { name: base } : asRecord(base))
    : selfDevised ? [] : [{ name: asText(candidate.name), source: candidate.source }];
  if (!names.length) return { status: selfDevised ? "self_devised" : "unavailable", bases: [], changes: [] };
  const finalHerbs = asRecords(candidate.herbs).map((herb) => asText(herb.name));
  const modifications = asRecords(asRecord(candidate._formula).modifications);
  const resultBases: FormulaDelta["bases"][number][] = [];
  const changes: FormulaDelta["changes"][number][] = [];
  const covered = new Set<string>();
  const addChange = (change: Omit<FormulaDelta["changes"][number], "id">) => changes.push({ ...change, id: `delta:${contentDigest(change)}` });
  for (const base of names) {
    const name = asText(base.name), book = canonicalFormulaBook(asText(base.source) || asText(candidate.source));
    const inferred = context.originals ? undefined : originalFormulaFor(name, { book, textbookRowId: context.textbookRowId });
    let options = [...(context.originals || originalFormulasNamed(name))].filter((entry) => originalFormulaNameKey(entry.name) === originalFormulaNameKey(name) || entry.aliases?.some((alias) => originalFormulaNameKey(alias) === originalFormulaNameKey(name)));
    const selectedBook = book || inferred?.book;
    if (selectedBook) options = options.filter((entry) => entry.book === selectedBook || entry.citedBooks?.includes(selectedBook));
    if (context.variants?.[name]) options = options.filter((entry) => entry.variant === context.variants?.[name]);
    if (!options.length) return { status: "unavailable", bases: [], changes: [] };
    if (options.length !== 1) return { status: "ambiguous", bases: [], changes: [] };
    const entry = options[0], key = `${entry.name}|${entry.book}|${entry.variant || ""}`;
    resultBases.push({ key, name: entry.name, book: entry.book, variant: entry.variant, evidenceRef: entry.evidence.ref });
    // Choose a single evidenced alternate as a whole; never mix per-herb variants.
    const alternatives: OriginalFormula["herbs"][] = [entry.herbs, ...(entry.alternates || []).map((alternate) => [
      ...entry.herbs.filter((herb) => !alternate.remove.includes(herb.herb)),
      ...alternate.add.map((herb) => ({ herb, written: herb })),
    ])];
    const specified = context.alternates?.[name];
    if (specified !== undefined && !alternatives[specified]) return { status: "unavailable", bases: [], changes: [] };
    const distance = (herbs: OriginalFormula["herbs"]) => herbs.filter((herb) => !finalHerbs.some((current) => sameComposition(herb.written, current))).length;
    const herbs = specified === undefined ? alternatives.reduce((best, current) => distance(current) < distance(best) ? current : best) : alternatives[specified];
    const alternateBasis = entry.alternates?.[alternatives.indexOf(herbs) - 1]?.basis;
    const ref = alternateBasis ? `${entry.evidence.ref}；${alternateBasis}` : entry.evidence.ref;
    for (const herb of herbs) {
      const current = finalHerbs.find((value) => sameComposition(herb.written, value) || sameComposition(herb.herb, value) && !formDomain(herb.written, true));
      if (current) {
        covered.add(current);
        const prep = herb.preparation;
        if (prep && !current.includes(prep) || !prep && withoutPreparationPrefix(current) !== current && current !== herb.written) {
          addChange({ baseKey: key, kind: "preparation_changed", from: herb.written, to: current, sourceRef: ref });
        }
      } else {
        const substitute = originalHerbAcceptedSubstitutes(herb.herb).flatMap((sub) => finalHerbs.filter((current) => sameComposition(sub, current)))[0];
        if (substitute) { covered.add(substitute); addChange({ baseKey: key, kind: "substituted", from: herb.written, to: substitute, sourceRef: ref }); }
        else addChange({ baseKey: key, kind: "removed", from: herb.written, sourceRef: ref });
      }
    }
    for (const guide of entry.guides) {
      const table = finalHerbs.find((name) => sameComposition(guide, name));
      if (table) covered.add(table);
      const inModifications = modifications.some((row) => row.action === "加" && sameComposition(guide, asText(row.herbName)));
      const inDecoction = context.decoctionGuideNames?.some((name) => sameComposition(guide, name));
      // A mention in usage prose could be an instruction or a historical omission.
      // Without the integrator's verified guide list we cannot assert either.
      const usage = stableContent(candidate.decoction || asRecord(candidate._formula).decoction);
      if (!table && !inModifications && context.decoctionGuideNames === undefined && usage.includes(guide)) {
        return { status: "unavailable", bases: [], changes: [] };
      }
      const location = table ? "table" : inModifications ? "modification" : inDecoction ? "decoction" : "history";
      addChange({ baseKey: key, kind: location === "history" ? "guide_omitted" : "guide_present", from: guide,
        to: table, guideLocation: location, sourceRef: entry.evidence.ref });
    }
  }
  for (const name of finalHerbs.filter((name) => !covered.has(name))) addChange({ baseKey: resultBases.map((base) => base.key).join("+"), kind: "added", to: name, sourceRef: "final_herb_table" });
  return { status: "known", bases: resultBases, changes };
}

export function snapshotFingerprint(snapshot: Omit<FinalM04Snapshot, "fingerprint"> | FinalM04Snapshot): string {
  const { fingerprint: ignored, ...bound } = snapshot as FinalM04Snapshot;
  void ignored;
  return contentDigest(bound);
}

export function buildFinalM04Snapshot(reasoning: unknown, context: FinalSnapshotContext): FinalM04Snapshot {
  const root = asRecord(reasoning), formula = asRecord(root.formula);
  const candidate = asRecords(formula.candidates)[context.candidateIndex || 0] || {};
  const { formulaAnalysis: ignored, ...nonProse } = candidate;
  void ignored;
  const delta = deriveFormulaDelta({ ...candidate, _formula: formula }, context);
  const commentaries: SourceSpan[] = [];
  const table = textbookJson as unknown as { formulaCommentaries: Record<string, { commentary?: string; commentaryLine?: number }> };
  // Commentary keyed only by name cannot resolve a homonym. Bind to its own
  // cited original book; never take another same-name formula's commentary.
  for (const base of delta.bases) {
    const entry = table.formulaCommentaries[base.name];
    const citation = (citationsJson.formulas as Record<string, { book: string }>)[base.name];
    if (!entry?.commentary || canonicalFormulaBook(citation?.book) !== base.book) continue;
    commentaries.push({ id: `commentary:${contentDigest([base,entry])}`, kind: "formula_commentary", formulaKey: base.key,
      text: entry.commentary, sourceRef: `《方剂学》${base.name}【方解】:${entry.commentaryLine}`, sourceDigest: SOURCE_VERSION, lineStart: entry.commentaryLine });
  }
  const snapshot = {
    candidateKey: `${asText(candidate.id)}:candidate:${context.candidateIndex || 0}`, name: asText(candidate.name),
    constructionType: candidate.identityDeclassified === true ? "self_devised" : asText(candidate.constructionType),
    herbs: asRecords(candidate.herbs).map((herb, index) => ({ id: `H${index + 1}`, name: asText(herb.name),
      identity: compositionIdentityName(asText(herb.name)), formKey: exactHerbFormKey(asText(herb.name)), role: asText(herb.role),
      functionText: asText(herb.function), functionSources: herbFunctionSourceClauses(asText(herb.name))
        .filter((source) => asText(herb.function).includes(source.text)),
      targetRef: asText(herb.targetRef), targetPathogenesis: asText(herb.targetPathogenesis) })),
    delta, modifications: structuredClone(asRecords(formula.modifications)), commentaries,
    priorDigest: contentDigest(context.prior), decoctionDigest: contentDigest(candidate.decoction || formula.decoction),
    recordDigest: contentDigest(context.record), sourceVersion: SOURCE_VERSION, candidateDigest: contentDigest(nonProse),
    clinicalContext: { primarySyndrome: asText(asRecord(asRecord(context.prior).overview).primarySyndrome),
      therapy: structuredClone(asRecord(context.prior).therapy || {}), findings: structuredClone(context.findings || []) },
  };
  return freezeContent({ ...snapshot, fingerprint: snapshotFingerprint(snapshot) });
}
