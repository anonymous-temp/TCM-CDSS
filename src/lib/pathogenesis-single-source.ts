import concepts from "../data/tcm-syndrome-label-concepts.source.json";
import natureLexicon from "../data/tcm-nature-lexicon.json";
import locationLexicon from "../data/tcm-location-lexicon.json";
import consistency from "../data/diagnosis-text-consistency.source.json";
import factPolicy from "../data/delivery-facts-policy.source.json";
import { clinicalClausePolarity, clinicalEventTemporalScopeAt } from "./clinical-polarity";
import { clauseLocalMentionPolarityAt, recordedFindingReading } from "./diagnosis-safety";
import { natureLabelSignTerms, recordSignQuotes, uncertaintyAnsweredByRecord, uncertaintyAsksListedElement, uncertaintyDiscussesSyndromeNaming, uncertaintyLeaksPromptWording, uncertaintyWithRecordedAnswers } from "./analysis-element-closure";
import { coldHeatPolesOfNatureLabels, natureItemDeficiencyOrExcess, recordColdHeatSupport, withoutNormalFindingSegments } from "./diagnosis-visible-summary";

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => v && typeof v === "object" && !Array.isArray(v) ? v as Json : {};
const str = (v: unknown): string => typeof v === "string" ? v.trim() : "";
const arr = (v: unknown): string[] => Array.isArray(v) ? v.map(str).filter(Boolean) : [];
const rows = (v: unknown): Json[] => Array.isArray(v) ? v.map(obj) : [];
const unique = (v: string[]) => [...new Set(v)];
const compact = (v: string) => v.normalize("NFKC").replace(/[^\S\n]/gu, "");
const natureGroups: Record<string, string> = { fire_heat: "heat", water_dampness: "dampness" };
const natureId = (id: string) => natureGroups[id] || id;
const locationForms = [
  ...locationLexicon.entries.flatMap((entry) => [entry.canonical, ...entry.aliases]
    .filter((form) => form.length > 1 || entry.system !== "wei_qi_ying_blood")
    .map((form) => ({ id: entry.id, form }))),
  ...consistency.analysisSourcePolicy.locationForms.flatMap((entry) => entry.forms.map((form) => ({ id: entry.id, form }))),
];

/** Controlled label decomposition only; no symptom-to-syndrome inference. */
export function analysisElements(value: string, mechanism = false): { locations: string[]; natures: string[] } {
  const locations = new Set<string>();
  const natures = new Set<string>();
  for (const rawPart of value.split(/[，,。；;、]/u)) {
    const part = [...consistency.analysisSourcePolicy.locationNonMechanismForms, ...consistency.analysisSourcePolicy.natureNonMechanismForms].reduce((s, form) => s.split(form).join(""), rawPart);
    if (clinicalClausePolarity(part) !== "affirmed" || clauseLocalMentionPolarityAt(part, 0) !== "affirmed") continue;
    // Longest lexical location wins at an occurrence: 心包 is not a second 心; 肌表 is not 表分.
    const hits = locationForms.flatMap(({ id, form }) => {
      const found: Array<{ id: string; at: number; end: number }> = [];
      for (let at = part.indexOf(form); at >= 0; at = part.indexOf(form, at + 1)) found.push({ id, at, end: at + form.length });
      return found;
    });
    for (const hit of hits) if (!hits.some((other) => other.at <= hit.at && other.end >= hit.end && other.end - other.at > hit.end - hit.at)) locations.add(hit.id);
    const exact = (factPolicy.syndromeElements as Record<string, string[]>)[part.endsWith("证") ? part : `${part}证`];
    if (exact && !mechanism) { for (const id of exact) natures.add(natureId(id)); continue; }
    for (const entry of natureLexicon.entries) {
      if (entry.kind === "eight_principles" || entry.kind === "disharmony") continue;
      if ([entry.canonical, ...entry.aliases].some((form) => part.includes(form))) natures.add(natureId(entry.id));
    }
    for (const id of exact || []) natures.add(natureId(id));
    for (const row of consistency.analysisSourcePolicy.natureMechanisms) if (row.forms.some((form) => part.includes(form))) natures.add(row.id);
    for (const row of consistency.analysisSourcePolicy.compoundDeficiencies) if (row.forms.some((form) => part.includes(form))) row.ids.forEach((id) => natures.add(id));
    for (const row of concepts.natures) {
      if (!row.terms.some((term) => part.includes(term) && !(term === "虚寒" && /气虚寒/u.test(part)) && (!mechanism || row.id !== "郁滞" || (term.length > 1 && term !== "不和")))) continue;
      const entry = natureLexicon.entries.find((entry) => [entry.canonical, ...entry.aliases].some((form) => row.terms.includes(form)));
      if (entry && entry.kind !== "eight_principles") natures.add(natureId(entry.id));
    }
    if (new RegExp(consistency.analysisSourcePolicy.yangCollapse, "u").test(part)) natures.add("yang_deficiency");
    if (/[虚亏怯衰脱]|不足/u.test(part) && ![...natures].some((id) => natureLexicon.entries.some((e) => e.id === id && e.kind === "deficiency"))) natures.add("deficiency");
    // Deficiency heat/cold are qualities of the root, not a second excess pathogen.
    if (new RegExp(consistency.analysisSourcePolicy.deficiencyHeat, "u").test(part)) { natures.add("yin_deficiency"); natures.delete("heat"); }
    if (/(?<!气)虚寒/u.test(part)) { natures.add("yang_deficiency"); natures.delete("cold"); }
  }
  if ([...natures].some((id) => id.endsWith("_deficiency"))) natures.delete("deficiency");
  return { locations: [...locations], natures: [...natures] };
}

/** Only current, affirmative, abnormal verbatim pieces may support an axis. */
export function groundedAnalysisQuotes(value: string, recordText: string): string[] {
  const source = compact(recordText);
  return unique(value.split(/[，,。；;、\n]/u).map(str).map((q) => q.replace(/^[^：:]*[：:]\s*/u, "")).filter(Boolean).filter((quote) => {
    if (!withoutNormalFindingSegments(quote) || new RegExp(consistency.analysisSourcePolicy.normalFindings, "u").test(quote)) return false;
    if (clinicalClausePolarity(quote) !== "affirmed" || new RegExp(consistency.analysisSourcePolicy.unusableFindingPrefix, "u").test(quote) || new RegExp(consistency.analysisSourcePolicy.ageOnly, "u").test(quote)) return false;
    const needle = compact(quote);
    for (let at = source.indexOf(needle); at >= 0; at = source.indexOf(needle, at + 1)) {
      if (clauseLocalMentionPolarityAt(source, at + (quote.startsWith("未") ? 1 : 0)) !== "affirmed") continue;
      if (clinicalEventTemporalScopeAt(source, at, needle.length, { groundingQuote: true }) !== "current") continue;
      // The record's field scope is retained; a quote stripped of its history heading cannot escape it.
      const end = source.indexOf("\n", at);
      const line = source.slice(source.lastIndexOf("\n", at) + 1, end < 0 ? source.length : end);
      if (new RegExp(consistency.analysisSourcePolicy.excludedSection, "u").test(line)) continue;
      if (new RegExp(consistency.analysisSourcePolicy.triggerOnly, "u").test(quote)) continue;
      return true;
    }
    return false;
  }));
}

function labelsFor(ids: string[], candidates: string[], kind: "locations" | "natures"): string[] {
  const allowed = new Set(ids);
  const covered = new Set<string>();
  const labels: string[] = [];
  for (const candidate of candidates) {
    const mapped = analysisElements(candidate)[kind];
    if (kind === "natures" && mapped.some((id) => natureLexicon.entries.find((e) => e.id === id)?.kind === "deficiency") && mapped.some((id) => { const e = natureLexicon.entries.find((e) => e.id === id); return e && e.kind !== "deficiency" && e.kind !== "eight_principles"; })) continue;
    if (!mapped.length || mapped.some((id) => !allowed.has(id)) || mapped.every((id) => covered.has(id))) continue;
    labels.push(candidate);
    mapped.forEach((id) => covered.add(id));
  }
  const lexicon = kind === "locations" ? [...locationLexicon.entries, ...consistency.analysisSourcePolicy.locationForms] : natureLexicon.entries;
  for (const id of ids) if (!covered.has(id)) {
    const label = lexicon.find((entry) => entry.id === id)?.canonical;
    if (label) labels.push(label);
  }
  return unique(labels).sort((a, b) => Math.min(...analysisElements(a)[kind].map((id) => ids.indexOf(id))) - Math.min(...analysisElements(b)[kind].map((id) => ids.indexOf(id))));
}

/** Mutates only optional analysis axes and pending items; names, chain and safety are untouched. */
export function derivePathogenesisFromConclusions(reasoning: Json, recordText: string): void {
  const path = obj(reasoning.pathogenesis), overview = obj(reasoning.overview);
  if (!reasoning.pathogenesis || !str(overview.primarySyndrome)) return;
  const names = [str(overview.primarySyndrome), ...arr(overview.secondarySyndromes)];
  const chain = rows(path.chain);
  const named = analysisElements(names.join("；"));
  const mechanisms = chain.map((node) => ({ node, axes: analysisElements(str(node.pathogenesis), true), quotes: groundedAnalysisQuotes([str(node.patientFact), str(node.syndromeEvidence)].join("；"), recordText) }));
  const ids = {
    locations: unique([...named.locations, ...mechanisms.flatMap((m) => m.axes.locations)]),
    natures: unique([...named.natures, ...mechanisms.flatMap((m) => m.axes.natures)]),
  };
  if (ids.natures.some((id) => id.endsWith("_deficiency"))) ids.natures = ids.natures.filter((id) => id !== "deficiency");
  const location = obj(path.locationDifferentiation), nature = obj(path.natureDifferentiation);
  const locationItems = labelsFor(ids.locations, arr(location.items), "locations");
  const natureItems = labelsFor(ids.natures, [...arr(nature.items), ...arr(nature.rootDeficiency), ...arr(nature.branchExcess)], "natures");
  const details: Json[] = [];
  const missingLocations: string[] = [];
  for (const label of locationItems) {
    const mapped = analysisElements(label).locations;
    const quotes: string[] = [];
    for (const id of mapped) {
      const linked = mechanisms.filter((m) => m.axes.locations.includes(id)).flatMap((m) => m.quotes);
      const canonical = labelsFor([id], [], "locations")[0];
      const direct = consistency.directLocations.find((row) => row.names.includes(canonical));
      const directQuotes = direct ? groundedAnalysisQuotes(recordSignQuotes(recordText, direct.signs).join("；"), recordText) : [];
      const support = unique([...linked, ...(direct && direct.signs.filter((sign) => directQuotes.some((q) => q.includes(sign))).length >= direct.minSigns ? directQuotes : [])]);
      quotes.push(...support);
      if (!support.length) {
        const signs = (consistency.analysisSourcePolicy.missingLocationFindings as Record<string, string[]>)[id] || [];
        const name = labelsFor([id], [], "locations")[0];
        missingLocations.push(`“${name}”：${signs.slice(0, 2).join("、")}`);
      }
    }
    if (quotes.length) details.push({ location: label, basis: unique(quotes).join("；") });
  }
  const natureQuotes: string[] = [], missingNatures: string[] = [];
  // Resolve every atomic element, even when the retained candidate says “气血两虚/湿热”.
  for (const id of ids.natures) {
    const label = labelsFor([id], [], "natures")[0];
    const signs = natureLabelSignTerms(label);
    const poles = coldHeatPolesOfNatureLabels(label);
    const observed = groundedAnalysisQuotes([...recordSignQuotes(recordText, signs), ...poles.flatMap((pole) => recordColdHeatSupport(recordText, pole).quotes)].join("；"), recordText);
    // The chain supplies the case-specific mapping for elements outside the sign table (e.g. 风、毒).
    const linked = mechanisms.filter((m) => m.axes.natures.includes(id)).flatMap((m) => m.quotes);
    const quotes = unique([...observed, ...linked]);
    if (quotes.length) natureQuotes.push(...quotes);
    else {
      const targets = signs.length ? signs : (consistency.analysisSourcePolicy.missingNatureFindings as Record<string, string[]>)[id] || [];
      missingNatures.push(`“${label}”：${targets.slice(0, 2).join("、")}`);
    }
  }
  const settle = (axis: Json, items: string[], missing: string[]) => {
    axis.items = items;
    axis.resolution = items.length === 0 ? "unresolved" : missing.length ? "bounded" : "resolved";
    if (missing.length) axis.resolutionReason = `需核实${missing.join("；")}`;
    else delete axis.resolutionReason;
    if (axis.evidence) obj(axis.evidence).confidence = items.length ? "中" : "低";
  };
  settle(location, locationItems, missingLocations);
  location.details = details;
  settle(nature, natureItems, missingNatures);
  nature.basis = unique(natureQuotes).join("；");
  nature.rootDeficiency = natureItems.filter((label) => natureItemDeficiencyOrExcess(label) === "root");
  nature.branchExcess = natureItems.filter((label) => natureItemDeficiencyOrExcess(label) === "branch");
  path.locationDifferentiation = location;
  path.natureDifferentiation = nature;
  filterAnalysisUncertainties(reasoning, recordText);
}

export function filterAnalysisUncertainties(reasoning: Json, recordText: string): void {
  const path = obj(reasoning.pathogenesis), overview = obj(reasoning.overview);
  const named = analysisElements([str(overview.primarySyndrome), ...arr(overview.secondarySyndromes)].join("；"));
  const seen = new Set<string>();
  path.uncertainties = rows(path.uncertainties).flatMap((original) => {
    const row = uncertaintyWithRecordedAnswers(original, recordText);
    if (!row) return [];
    const item = str(row.item);
    if (uncertaintyLeaksPromptWording(row) || uncertaintyDiscussesSyndromeNaming(row) || uncertaintyAnsweredByRecord(item, recordText) || uncertaintyAsksListedElement(item, path)) return [];
    const asked = item.match(new RegExp(consistency.analysisSourcePolicy.askedElement, "u"))?.[1];
    const elements = analysisElements(asked || "");
    if (elements.natures.length && elements.natures.every((id) => named.natures.includes(id)) && elements.locations.every((id) => named.locations.includes(id))) return [];
    if (uncertaintyContradictsResolvedAxis(row, path)) return [];
    if (asked && asked.split(/[、，,及与]/u).filter(Boolean).every((term) => ["affirmed", "denied"].includes(recordedFindingReading(recordText, term)))) return [];
    const key = uncertaintyIdentity(item);
    if (seen.has(key)) return [];
    seen.add(key);
    return [row];
  });
}

/** Shared with offline auditing: a pending row cannot retract an already grounded axis. */
export function uncertaintyContradictsResolvedAxis(row: Json, path: Json): boolean {
  const value = [str(row.item), str(row.reason)].join("；");
  if (!new RegExp(consistency.analysisSourcePolicy.resolutionDoubt, "u").test(value)) return false;
  const disputed = analysisElements(value);
  const settled = (axis: Json, kind: "locations" | "natures", ids: string[]) => axis.resolution === "resolved" && ids.every((id) =>
    kind === "natures" && id === "deficiency"
      ? arr(axis.items).some((label) => natureItemDeficiencyOrExcess(label) === "root")
      : analysisElements(arr(axis.items).join("；"))[kind].includes(id));
  if ((disputed.locations.length || disputed.natures.length)
    && (!disputed.locations.length || settled(obj(path.locationDifferentiation), "locations", disputed.locations))
    && (!disputed.natures.length || settled(obj(path.natureDifferentiation), "natures", disputed.natures))) return true;
  const field = new RegExp(consistency.analysisSourcePolicy.resolvedFieldQuestions.natures, "gu");
  const item = str(row.item);
  // A combined question can still contain an unanswered test/pregnancy detail. Do not erase it with the axis question.
  return obj(path.natureDifferentiation).resolution === "resolved" && field.test(item)
    && new RegExp(consistency.analysisSourcePolicy.resolutionFieldOnlyGlue, "u").test(item.replace(field, ""));
}

function uncertaintyIdentity(item: string): string {
  const rows = consistency.analysisSourcePolicy.uncertaintySynonyms;
  return rows.reduce((value, row) => row.forms.reduce((s, form) => s.split(form).join(row.canonical), value), item)
    .replace(new RegExp(consistency.analysisSourcePolicy.questionIdentityPrefix, "u"), "").replace(/[？?\s]/gu, "");
}
