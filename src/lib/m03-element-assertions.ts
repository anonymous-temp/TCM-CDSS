import lexicon from "../data/m03-element-closure-v2.source.json";
import deficiency from "../data/tcm-deficiency-element-lexicon.source.json";
import legacy from "../data/tcm-syndrome-element-promotion.source.json";
import { EXCESS_ELEMENTS, withoutDanglingConclusionLeads } from "./analysis-element-closure";
import { resolveNationalStandardTcmSyndromeTerm } from "./clinical-governance-tables";
import { clauseLocalMentionPolarityAt, maskNonNegatingWuWords } from "./diagnosis-safety";
import { classifyNatureColumns } from "./nature-column-classification";
import { textbookFormulaRowsForDisease, textbookRowById, textbookRowElementAnalysis, textbookRowForSyndrome, type TextbookSyndromeRow } from "./tcm-textbook-syndromes";

export type ClosureRule = "d1" | "d2" | "d3" | "d4" | "d5" | "d6" | "d7";
export type ElementClosurePolicy = { mode: "off" | "observe" | "enforce"; disabled: ReadonlySet<string> };
export const elementClosurePolicy = (): ElementClosurePolicy => {
  const mode = process.env.CDSS_M03_ELEMENT_CLOSURE_V2;
  return {
    mode: mode === "off" || mode === "observe" ? mode : "enforce",
    disabled: new Set((process.env.CDSS_M03_ELEMENT_CLOSURE_V2_DISABLE || "").toLowerCase().split(",").map((value) => value.trim()).filter(Boolean)),
  };
};
export function elementClosureCacheIdentity(): string {
  const policy = elementClosurePolicy();
  return ["r1067-closure2", policy.mode, [...policy.disabled].sort().join(","), process.env.CDSS_M03_ELEMENT_SUPPORT || "",
    process.env.CDSS_M03_SECONDARY_CRITERIA || ""].join("/");
}
export const closureRule = (policy: ElementClosurePolicy, id: ClosureRule) => !policy.disabled.has(id);
const fullPolicy: ElementClosurePolicy = { mode: "enforce", disabled: new Set() };

export type ClosureJson = Record<string, unknown>;
export const closureObject = (v: unknown): ClosureJson | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? v as ClosureJson : undefined;
const read = (v: unknown) => typeof v === "string" ? v : "";
export const closureStrings = (v: unknown): string[] => Array.isArray(v) ? v.map(read).map(s => s.trim()).filter(Boolean) : [];
const unique = <T,>(v: T[]) => [...new Set(v)];
const syndromeSuffix = new RegExp(`(?:${lexicon.syndromeSuffixes.join("|")})$`, "u");
const core = (name: string) => name.trim().replace(syndromeSuffix, "");
const range = /[^，,；;。！？!?\n、]+/gu;
const sentenceRange = /[^。；;！？!?\n]+/gu;
const ambiguousDeficiency = "两虚";
const pendingLead = new RegExp(`^.*?(?:${lexicon.pendingLeads.join("|")})`, "u");
const locations = [...new Set([...lexicon.locations, ...Object.keys(lexicon.locationAliases)])].sort((a, b) => b.length - a.length);
const locationAliases: Record<string, string> = lexicon.locationAliases;
const familyByType = new Map(lexicon.families.map(row => [row.type, row]));
const governedMethods: Record<string, string> = lexicon.methodOrgans;
const locatedPhrases: Record<string, string> = lexicon.analysisKinds;
const namePairs: Record<string, string[][]> = lexicon.namePairs;
const nameMarkers: Record<string, string[]> = lexicon.nameOnlyMarkers;
const shadowedTypes: Record<string, string[]> = lexicon.shadowedBySpecific;
const deficiencyTypes = new Set(Object.keys(deficiency.types));

export type ElementPair = { type: string; organ?: string };
export type AssertionSource = "prose" | "mechanism" | "nature" | "method" | "pending" | "location";
export type ElementAssertion = ElementPair & {
  phrase: string; start: number; end: number; clauseStart: number; clauseEnd: number;
  source: AssertionSource; field?: string; compound?: string; label: string;
};
export type FinalM03ElementContext = {
  disease: string;
  primarySyndrome: string;
  secondarySyndromes: readonly string[];
  textbookRow?: Pick<TextbookSyndromeRow, "id">;
};
export const pairKey = ({ type, organ }: ElementPair) => `${type}/${organ || ""}`;

type Marker = { phrase: string; type: string };
function markerTable(source: "mechanism" | "method" | "name", expanded: boolean): Marker[] {
  const out: Marker[] = [];
  const add = (type: string, phrases: readonly string[]) => {
    out.push(...phrases.filter(Boolean).map(phrase => ({ type, phrase })));
  };
  for (const { id, label, analysisMentions, methodWords, nameMarkers } of EXCESS_ELEMENTS) {
    add(id, source === "method" ? methodWords : source === "name" ? nameMarkers : [...analysisMentions, label === "血瘀" ? label : ""]);
  }
  for (const row of legacy.extras) add(row.type, source === "method" ? row.methods : source === "name" ? row.nameMarkers : row.mentions);
  if (source !== "method") {
    for (const { types, pattern } of deficiency.mentions) {
      if (pattern === ambiguousDeficiency) continue;
      for (const type of types) add(type, [pattern]);
    }
  } else {
    for (const [type, values] of Object.entries(legacy.deficiencyMethods)) add(type, values);
    for (const [type, config] of Object.entries(deficiency.types)) {
      for (const organ of lexicon.locations) add(type, config.therapyVerbs
        .filter(verb => verb.length === 2 && verb[1] === type[0])
        .map(verb => `${verb[0]}${organ}${type[0]}`));
    }
  }
  if (expanded) for (const row of lexicon.families) {
    add(row.type, source === "method" ? row.methods : source === "name" ? [...row.mentions, ...(nameMarkers[row.type] || [])] : row.mentions);
  }
  const seen = new Set<string>();
  return out.filter(({ type, phrase }) => {
    const key = `${type}/${phrase}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => b.phrase.length - a.phrase.length);
}
const markerTables = [false, true].map(expanded => ({
  mechanism: markerTable("mechanism", expanded),
  method: markerTable("method", expanded),
  name: markerTable("name", expanded),
}));

const canonicalOrgan = (value: string) => locationAliases[value] || value;
function localOrgans(value: string, phrase: string, at: number, method: boolean, name: boolean, policy: ElementClosurePolicy): string[] {
  if (!closureRule(policy, "d5")) return [];
  const located = method ? governedMethods[phrase] : locatedPhrases[phrase];
  if (located) return [located];
  const before = value.slice(0, at);
  const adjacent: string[] = [];
  let prefix = before;
  while (adjacent.length < 2) {
    const part = locations.find(organ => prefix.endsWith(organ));
    if (!part) break;
    adjacent.unshift(canonicalOrgan(part));
    prefix = prefix.slice(0, -part.length);
  }
  if (adjacent.length) return unique(adjacent);
  if (method && phrase.length === 3) {
    const infix = locations.find(organ => phrase.slice(1, -1) === organ);
    if (infix) return [canonicalOrgan(infix)];
  }
  // Name endings and narrowly governed transfer predicates locate the preceding element.
  const after = value.slice(at + phrase.length);
  const transfer = /^[于入犯扰壅阻蕴郁扰伤盛结]{1,2}/u.exec(after)?.[0];
  const tail = transfer ? after.slice(transfer.length) : name || /[犯扰壅阻蕴郁伤结]$/u.test(phrase) ? after : "";
  const target = locations.find(organ => tail.startsWith(organ));
  return target ? [canonicalOrgan(target)] : [];
}

function startsContext(value: string, terms: readonly string[]) {
  return terms.some(term => value.trimStart().startsWith(term));
}

function positiveOccurrence(value: string, at: number, length: number): boolean {
  const masked = maskNonNegatingWuWords(value);
  const before = masked.slice(0, at);
  const after = masked.slice(at + length);
  return !legacy.analysisNegationBefore.some(term => before.endsWith(term)) &&
    !legacy.analysisNegationAfter.some(term => after.startsWith(term)) &&
    !legacy.analysisNegatedClauseSuffixes.some(term => masked.endsWith(term)) &&
    clauseLocalMentionPolarityAt(masked, at) === "affirmed";
}

function clauseAssertions(value: string, source: AssertionSource | "name", policy: ElementClosurePolicy): ElementAssertion[] {
  const tables = markerTables[Number(closureRule(policy, "d1"))];
  const markers = tables[source === "method" ? "method" : source === "name" ? "name" : "mechanism"];
  const out: ElementAssertion[] = [];
  const protectedQuotes = [...value.matchAll(/[“「『][^”」』]+[”」』]/gu)].filter(match =>
    !deficiency.rationaleClauseFilter.assertionMarkers.some(marker => value.slice(0, match.index).trimEnd().endsWith(marker)));
  const add = (type: string, phrase: string, start: number, compound?: string, organs?: string[]) => {
    if (protectedQuotes.some(quote => start >= quote.index && start < quote.index + quote[0].length)) return;
    if (!["name", "pending", "nature", "method"].includes(source) && !positiveOccurrence(value, start, phrase.length)) return;
    const end = start + phrase.length;
    const targets = organs || localOrgans(value, phrase, start, source === "method", source === "name", policy);
    for (const organ of targets.length ? targets : [undefined]) {
      if (out.some(hit => hit.type === type && hit.organ === organ && hit.start <= start && hit.end >= end)) continue;
      out.push({ type, organ, phrase, start, end, compound, clauseStart: 0, clauseEnd: value.length,
        source: source === "name" ? "mechanism" : source, label: familyByType.get(type)?.label || phrase });
    }
  };
  if (closureRule(policy, "d1") && source !== "method") {
    const compounds = [...lexicon.compounds].sort((a, b) => b.mention.length - a.mention.length);
    for (const { mention, components } of compounds) {
      for (let at = value.indexOf(mention); at >= 0; at = value.indexOf(mention, at + mention.length)) {
        const compound = compounds.find(other => value.startsWith(other.mention, at) && other.components.some(type => components.includes(type)));
        if (compound?.mention !== mention) continue;
        const encompassing = Object.keys(locatedPhrases).find(phrase => phrase.includes(mention) && value.includes(phrase));
        const organs = encompassing && closureRule(policy, "d5") ? [locatedPhrases[encompassing]] : localOrgans(value, mention, at, false, source === "name", policy);
        for (const type of components) add(type, mention, at, mention, organs);
      }
    }
  }
  for (const { phrase, type } of markers) {
    for (let at = value.indexOf(phrase); at >= 0; at = value.indexOf(phrase, at + phrase.length)) {
      if (type === "heat" && phrase === "火" && /衰/u.test(value[at + 1] || "")) continue;
      if (type === "heat" && (value.slice(Math.max(0, at - 2), at).endsWith("虚") || value.startsWith("阴虚火旺", Math.max(0, at - 2)))) continue;
      if (type === "cold" && (phrase === "虚寒" || value.slice(Math.max(0, at - 2), at).endsWith("虚"))) continue;
      if (type === "damp" && source === "name" && value.startsWith("水湿", at - 1)) continue;
      if (out.some(hit => hit.type === type && hit.compound && hit.start <= at && hit.end >= at + phrase.length)) continue;
      add(type, phrase, at);
    }
  }
  if (source === "nature" || source === "pending") {
    const compact = core(value);
    for (const row of lexicon.families) {
      if (!closureRule(policy, "d1") && !markerTables[0].mechanism.some(marker => marker.type === row.type)) continue;
      if (row.label !== compact || out.some(hit => hit.type === row.type)) continue;
      add(row.type, compact, value.indexOf(compact));
    }
    if (source === "nature" && !out.length && compact && compact !== "无" && !startsContext(compact, lexicon.contextOnly)) add("unmapped", compact, value.indexOf(compact));
  }
  return out.filter(hit => !out.some(other => {
    if (hit === other || other.start >= hit.end || other.end <= hit.start) return false;
    if (hit.type === other.type && other.organ && !hit.organ) return true;
    return (!hit.organ || !other.organ || hit.organ === other.organ) && shadowedTypes[other.type]?.includes(hit.type);
  }));
}

/** Deterministic sources carry their own scope. Prose spans retain their UTF-16 offsets. */
export function elementAssertionsInText(value: string, source: AssertionSource = "prose", policy: ElementClosurePolicy = fullPolicy): ElementAssertion[] {
  const out: ElementAssertion[] = [];
  const modernProse = closureRule(policy, "d4");
  const quotes = [...value.matchAll(/[“「『][^”」』]+[”」』]/gu)].filter(quote =>
    !deficiency.rationaleClauseFilter.assertionMarkers.some(marker => value.slice(0, quote.index).trimEnd().endsWith(marker)));
  const scanText = source === "prose" || source === "mechanism" || source === "location"
    ? quotes.reduce((prose, quote) => prose.slice(0, quote.index) + " ".repeat(quote[0].length) + prose.slice(quote.index + quote[0].length), value) : value;
  for (const sentence of scanText.matchAll(sentenceRange)) {
    let scoped = !lexicon.theoryScope.some(marker => sentence[0].includes(marker));
    let nonCurrent = false;
    let negatedList = false;
    for (const part of sentence[0].matchAll(range)) {
      const phrase = part[0].trim();
      if (!phrase) continue;
      const offset = sentence.index + part.index + part[0].indexOf(phrase);
      const current = startsContext(phrase, lexicon.patientScope);
      if (source !== "pending" && !current && negatedList && sentence[0][part.index - 1] === "、") continue;
      negatedList = startsContext(phrase, legacy.analysisNegationBefore);
      if (current) { scoped = true; nonCurrent = false; }
      if (startsContext(phrase, lexicon.theoryScope)) scoped = false;
      if (startsContext(phrase, lexicon.contextOnly)) {
        nonCurrent = !startsContext(phrase, legacy.analysisNegationBefore);
        if (source !== "pending") continue;
      }
      if (source !== "pending" && (!scoped || nonCurrent)) continue;
      if (source === "prose" && !modernProse && !deficiency.rationaleClauseFilter.assertionMarkers.some(marker => phrase.includes(marker))) continue;
      if (source === "location" && !closureRule(policy, "d5")) continue;
      const parsed = source === "pending" ? phrase.replace(pendingLead, "") : phrase;
      const shift = offset + phrase.indexOf(parsed);
      for (const hit of clauseAssertions(parsed, source, policy)) out.push({
        ...hit, start: shift + hit.start, end: shift + hit.end, clauseStart: offset, clauseEnd: offset + phrase.length,
      });
    }
  }
  return out;
}

function directDeliveryNamePairs(name: string, policy: ElementClosurePolicy): ElementPair[] {
  const standard = resolveNationalStandardTcmSyndromeTerm(name)?.standardTerm;
  const exact = namePairs[name] || (standard && namePairs[standard]);
  const located = closureRule(policy, "d5");
  return exact ? exact.map(([type, organ]) => ({ type, organ: (located && organ) || undefined }))
    : unique([name, standard || name]).flatMap(value => clauseAssertions(core(value), "name", policy));
}

export function deliveryNamePairs(name: string, policy: ElementClosurePolicy = fullPolicy): ElementPair[] {
  const direct = directDeliveryNamePairs(name, policy);
  const result: ElementPair[] = [];
  for (const { type, organ } of direct) {
    result.push({ type, organ });
    if (deficiencyTypes.has(type) && organ) result.push({ type: "deficiency", organ });
    if (type === "阳虚") result.push({ type: "气虚", organ }, { type: "deficient-cold", organ });
    if (type === "阴虚") result.push({ type: "deficient-heat", organ });
    if (type === "blood-heat") result.push({ type: "heat", organ });
  }
  return [...new Map(result.map(pair => [pairKey(pair), pair])).values()];
}

export function deliveryPairCovered(pair: ElementPair, allowed: readonly ElementPair[]): boolean {
  return allowed.some(item => item.type === pair.type && (!pair.organ || item.organ === pair.organ));
}

export function selectedElementRow(context: FinalM03ElementContext): TextbookSyndromeRow | undefined {
  const row = textbookRowForSyndrome(context.disease, context.primarySyndrome);
  if (!context.textbookRow) return row && sameDiseaseElementRows(context.disease, row) ? row : undefined;
  if (row?.id === context.textbookRow.id && sameDiseaseElementRows(context.disease, row)) return row;
  const original = textbookRowById(context.textbookRow.id);
  if (!original || !sameDiseaseElementRows(context.disease, original)) return undefined;
  const merged = resolveNationalStandardTcmSyndromeTerm(context.primarySyndrome);
  const equivalent = (name: string) => merged && resolveNationalStandardTcmSyndromeTerm(name)?.id === merged.id;
  const fromOriginal = legacy.rules.some(rule => equivalent(rule.composite)
    && rule.primary.some(name => core(name) === core(original.syndromeName)))
    || lexicon.qualifiedComposites.some(rule => equivalent(rule.to) && core(rule.from) === core(original.syndromeName));
  return fromOriginal ? original : undefined;
}

export function rowElementPairs(row: TextbookSyndromeRow | undefined, policy: ElementClosurePolicy = fullPolicy): ElementPair[] {
  if (!row || !closureRule(policy, "d2")) return [];
  const analysis = elementAssertionsInText(textbookRowElementAnalysis(row)?.text || "", "mechanism", policy);
  const methods = elementAssertionsInText(row.therapy, "method", policy);
  // The row's own named organ can scope a generic treatment. Never infer a second organ from another row.
  const sites = unique(deliveryNamePairs(row.syndromeName, policy).flatMap(hit => hit.organ ? [hit.organ] : []));
  const manifestations = elementAssertionsInText(row.manifestations, "mechanism", policy);
  const patterns = lexicon.rowManifestationCriteria.filter(rule => rule.tongue.some(term => row.tongue.includes(term))
    && rule.pulse.some(term => row.pulse.includes(term))).flatMap(rule => rule.types.map(type => ({ type, organ: undefined })));
  return [...analysis, ...methods, ...manifestations, ...patterns].flatMap(({ type, organ }) => organ || sites.length !== 1
    ? [{ type, organ }] : [{ type }, { type, organ: sites[0] }]);
}

export function m03ElementContext(root: ClosureJson, row?: Pick<TextbookSyndromeRow, "id">): FinalM03ElementContext {
  const overview = closureObject(root.overview);
  return { disease: read(overview?.tcmDiseaseName).trim(), primarySyndrome: read(overview?.primarySyndrome).trim(),
    secondarySyndromes: closureStrings(overview?.secondarySyndromes), textbookRow: row };
}

/** P2 acceptance. The caller supplies the final disease, names and selected row, plus one section of prose. */
export function findUnsupportedM03ElementAssertions(context: FinalM03ElementContext, prose: string): ElementAssertion[] {
  const allowed = [...[context.primarySyndrome, ...context.secondarySyndromes].flatMap(name => deliveryNamePairs(name)), ...rowElementPairs(selectedElementRow(context))];
  return elementAssertionsInText(prose).filter(assertion => !deliveryPairCovered(assertion, allowed));
}

type ClosureSection = { parent: ClosureJson; key: string; path: string; source: AssertionSource };
function sections(root: ClosureJson, includeRationales = false): ClosureSection[] {
  const out: ClosureSection[] = [];
  const add = (parent: ClosureJson | undefined, path: string, fields: Record<string, AssertionSource>) => {
    if (!parent) return;
    for (const [key, source] of Object.entries(fields)) if (typeof parent[key] === "string") out.push({ parent, key, path: `${path}/${key}`, source });
  };
  const list = (parent: ClosureJson | undefined, key: string) => Array.isArray(parent?.[key]) ? parent[key] as unknown[] : [];
  const addList = (parent: ClosureJson | undefined, key: string, prefix: string, fields: Record<string, AssertionSource>) => {
    list(parent, key).forEach((row, index) => add(closureObject(row), `${prefix}/${key}/${index}`, fields));
  };
  const addStrings = (parent: ClosureJson | undefined, key: string, prefix: string, source: AssertionSource) => {
    const values = list(parent, key);
    values.forEach((value, index) => {
      if (typeof value === "string") out.push({ parent: values as unknown as ClosureJson, key: String(index), path: `${prefix}/${key}/${index}`, source });
    });
  };
  const overview = closureObject(root.overview);
  const path = closureObject(root.pathogenesis);
  const therapy = closureObject(root.therapy);
  const nature = closureObject(path?.natureDifferentiation);
  const location = closureObject(path?.locationDifferentiation);
  if (includeRationales) add(overview, "/overview", { tcmDiagnosticRationale: "prose", tcmDiseaseRationale: "prose" });
  add(overview, "/overview", { overallPathogenesis: "mechanism", overallTherapy: "method" });
  add(path, "/pathogenesis", { summary: "mechanism", natureSummary: "mechanism", locationSummary: "location" });
  add(nature, "/pathogenesis/natureDifferentiation", { basis: "prose", resolutionReason: "prose" });
  add(location, "/pathogenesis/locationDifferentiation", { resolutionReason: "location" });
  for (const key of ["items", "rootDeficiency", "branchExcess"]) addStrings(nature, key, "/pathogenesis/natureDifferentiation", "nature");
  addStrings(location, "items", "/pathogenesis/locationDifferentiation", "location");
  addList(location, "details", "/pathogenesis/locationDifferentiation", { location: "location", basis: "location" });
  addList(path, "chain", "/pathogenesis", { pathogenesis: "mechanism", therapyDirection: "method", syndromeEvidence: "prose" });
  addList(path, "symptomClusters", "/pathogenesis", { mechanism: "mechanism" });
  addList(path, "uncertainties", "/pathogenesis", { item: "pending", reason: "pending", affects: "pending" });
  add(therapy, "/therapy", { overallMethod: "method", overallPrinciple: "method" });
  addList(therapy, "subTherapies", "/therapy", { therapy: "method", targetPathogenesis: "mechanism" });
  return out;
}

export function collectM03ElementAssertions(root: ClosureJson, policy: ElementClosurePolicy, includeRationales = false): ElementAssertion[] {
  return sections(root, includeRationales).flatMap(section =>
    elementAssertionsInText(read(section.parent[section.key]), section.source, policy).map(hit => ({ ...hit, field: section.path })));
}

export function checkM03ElementClosure(root: ClosureJson, policy: ElementClosurePolicy = fullPolicy,
  permits?: (assertion: ElementAssertion) => boolean): ElementAssertion[] {
  const context = m03ElementContext(root);
  const allowed = [...[context.primarySyndrome, ...context.secondarySyndromes].flatMap(name => deliveryNamePairs(name, policy)), ...rowElementPairs(selectedElementRow(context), policy)];
  return collectM03ElementAssertions(root, policy).filter(hit => !(permits ? permits(hit) : deliveryPairCovered(hit, allowed)));
}

function withoutAssertionClauses(value: string, hits: readonly ElementAssertion[], source: AssertionSource): string {
  const sentences: string[] = [];
  for (const sentence of value.matchAll(sentenceRange)) {
    const parts = [...sentence[0].matchAll(range)];
    const kept: string[] = [];
    let cut = false;
    for (const part of parts) {
      const offset = sentence.index + part.index;
      if (hits.some(hit => hit.start >= offset && hit.start < offset + part[0].length)) { cut = true; continue; }
      if (cut && startsContext(part[0], lexicon.dependentClauses)) continue;
      kept.push(part[0].trim());
      cut = false;
    }
    if (kept.length === 0) continue;
    const unchanged = kept.length === parts.length;
    const end = sentence.index + sentence[0].length;
    const punctuation = /[。；;！？!?]/u.test(value[end] || "") ? value[end] : "";
    const body = unchanged ? sentence[0] : kept.join("，");
    sentences.push(body + punctuation);
  }
  const next = withoutDanglingConclusionLeads(sentences.join("").trim()).replace(/^[，,；;、。]+|[，,；;、]+$/gu, "");
  return source === "method" ? next.replace(/[。！？!?]+$/u, "") : next;
}

export function pruneM03ElementAssertions(root: ClosureJson, policy: ElementClosurePolicy, permits: (hit: ElementAssertion) => boolean, recordText: string): string | undefined {
  const path = closureObject(root.pathogenesis);
  const therapy = closureObject(root.therapy);
  const overview = closureObject(root.overview);
  const nature = closureObject(path?.natureDifferentiation);
  const location = closureObject(path?.locationDifferentiation);
  const hadNature = nature && [nature.items, nature.rootDeficiency, nature.branchExcess].some(value => closureStrings(value).length);
  const removedPending = new Set<number>();
  const changedPaths = new Set<string>();
  const overallBefore = read(overview?.overallPathogenesis);
  const summaryBefore = read(path?.summary);
  for (const section of sections(root)) {
    const value = read(section.parent[section.key]);
    const hits = elementAssertionsInText(value, section.source, policy).filter(hit => !permits({ ...hit, field: section.path }));
    if (!hits.length) continue;
    changedPaths.add(section.path);
    if (section.source === "pending") {
      removedPending.add(Number(section.path.split("/")[3]));
      continue;
    }
    if (section.source === "nature") {
      const kept = elementAssertionsInText(value, "nature", policy).filter(permits);
      const validLabel = (hit: ElementAssertion): string[] => {
        const label = hit.organ && !hit.label.startsWith(hit.organ) ? `${hit.organ}${hit.label}` : hit.label;
        const parsed = elementAssertionsInText(label, "nature", policy);
        return parsed.some(item => pairKey(item) === pairKey(hit)) && parsed.every(permits) ? [label] : [];
      };
      section.parent[section.key] = unique(kept.flatMap(validLabel)).join("、");
      continue;
    }
    if (section.source === "method") {
      const edits: Array<{ start: number; end: number }> = [];
      for (const { start, end } of [...hits].sort((a, b) => a.start - b.start)) {
        const prior = edits.at(-1);
        if (prior && start <= prior.end) prior.end = Math.max(prior.end, end);
        else edits.push({ start, end });
      }
      const atoms = edits.reverse().reduce((rest, hit) => rest.slice(0, hit.start) + rest.slice(hit.end), value);
      const items = atoms.split(/[，,、；;]/u).map(item => item.trim()).filter(Boolean);
      // Only retain complete four-character treatment items or intact closed clauses.
      section.parent[section.key] = items.every(item => item.length >= 4)
        && elementAssertionsInText(atoms, "method", policy).every(permits) ? items.join("，") : withoutAssertionClauses(value, hits, section.source);
    } else section.parent[section.key] = withoutAssertionClauses(value, hits, section.source);
  }
  for (const [parent, keys] of [[nature, ["items", "rootDeficiency", "branchExcess"]], [location, ["items"]]] as const) {
    if (parent) for (const key of keys) if (Array.isArray(parent[key])) parent[key] = closureStrings(parent[key]);
  }
  if (nature && hadNature && !closureStrings(nature.items).length && (
    [...changedPaths].some(path => path.startsWith("/pathogenesis/natureDifferentiation/items/"))
    || ![nature.rootDeficiency, nature.branchExcess].some(value => closureStrings(value).length)
  )) {
    const names = m03ElementContext(root);
    const pairs = [names.primarySyndrome, ...names.secondarySyndromes].flatMap(name => directDeliveryNamePairs(name, policy));
    const labels = pairs.flatMap(({ type }) => {
      const label = familyByType.get(type)?.label;
      if (!label) return [];
      const parsed = elementAssertionsInText(label, "nature", policy);
      return parsed.some(hit => hit.type === type) && parsed.every(permits) ? [label] : [];
    });
    nature.items = unique(labels);
  }
  if (nature && [...changedPaths].some(path => path.startsWith("/pathogenesis/natureDifferentiation/"))) classifyNatureColumns(nature);
  const rows = (parent: ClosureJson | undefined, key: string, keep: (row: ClosureJson, index: number) => boolean) => {
    if (parent && Array.isArray(parent[key])) parent[key] = parent[key].filter((value, index) => {
      const row = closureObject(value);
      return row && keep(row, index);
    });
  };
  rows(path, "uncertainties", (_row, index) => !removedPending.has(index));
  const changedRow = (prefix: string, index: number) => [...changedPaths].some(path => path.startsWith(`${prefix}/${index}/`));
  const originalIds = new Map<unknown, string>();
  if (Array.isArray(path?.chain)) path.chain.forEach((node, index) =>
    originalIds.set(node, read(closureObject(node)?.nodeId) || `P${index + 1}`));
  rows(path, "chain", (row, index) => !changedRow("/pathogenesis/chain", index) || Boolean(row.pathogenesis && row.therapyDirection));
  rows(path, "symptomClusters", (row, index) => !changedRow("/pathogenesis/symptomClusters", index) || Boolean(row.mechanism));
  rows(location, "details", (row, index) => !changedRow("/pathogenesis/locationDifferentiation/details", index) || Boolean(row.location && row.basis));
  rows(therapy, "subTherapies", (row, index) => !changedRow("/therapy/subTherapies", index) || Boolean(row.therapy && row.targetPathogenesis));
  // An existing complete sentence in the same field may survive a cut. Require its name,
  // an intact patient quote, and a supported mechanism before using it as the field's fallback.
  const context = m03ElementContext(root);
  const quotes = closureStrings(overview?.primarySyndromeBasis).filter(quote => quote.length >= 2 && recordText.includes(quote));
  for (const [parent, key, before] of [[overview, "overallPathogenesis", overallBefore], [path, "summary", summaryBefore]] as const) {
    if (!parent || parent[key] || !before || !context.primarySyndrome) continue;
    const groundedSentences = [before, read(overview?.tcmDiagnosticRationale)].flatMap(value => value.split(/(?<=。)/u));
    parent[key] = groundedSentences.find(sentence => sentence.includes(context.primarySyndrome) && quotes.some(quote => sentence.includes(quote))
      && /。$/u.test(sentence.trim()) && elementAssertionsInText(sentence, "mechanism", policy).every(permits)) || "";
  }
  // Renumber a surviving reference with its original node. Referring to a
  // removed node must never silently retarget therapy to the next node.
  const chain = Array.isArray(path?.chain) ? path.chain : [];
  const ids = new Map<string, string>();
  chain.forEach((value, index) => {
    const node = closureObject(value);
    if (!node) return;
    const id = `P${index + 1}`;
    ids.set(originalIds.get(node)!, id);
    if (node.nodeId) node.nodeId = id;
  });
  for (const target of Array.isArray(therapy?.subTherapies) ? therapy.subTherapies : []) {
    const row = closureObject(target);
    if (!row) continue;
    for (const key of ["targetRef", "targetPathogenesis"]) {
      const original = read(row[key]);
      const refs = original.match(/\bP\d{1,2}\b/gu);
      if (!refs) continue;
      if (refs.some(ref => !ids.has(ref))) return "missing_chain_reference";
      row[key] = original.replace(/\bP\d{1,2}\b/gu, ref => ids.get(ref)!);
    }
  }
}

function sameDiseaseElementRows(disease: string, row: TextbookSyndromeRow) {
  return textbookFormulaRowsForDisease(disease).some(candidate => candidate.id === row.id);
}

export const elementClosureLexicon = lexicon;
