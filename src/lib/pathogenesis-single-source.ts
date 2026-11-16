import concepts from "../data/tcm-syndrome-label-concepts.source.json";
import natureLexicon from "../data/tcm-nature-lexicon.json";
import locationLexicon from "../data/tcm-location-lexicon.json";
import consistency from "../data/diagnosis-text-consistency.source.json";
import factPolicy from "../data/delivery-facts-policy.source.json";
import diagnosticsCriteria from "../data/tcm-diagnostics-syndrome-criteria.json";
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

/**
 * 病位与表现的对应：《中医诊断学》证候表现里以该脏腑/部位命名的证的表现（肺气虚证、风寒犯肺证……的咳嗽、鼻塞、流涕），
 * 加上直接定位表与缺项提示表的体征。舌脉不作定位依据。模型写的病位依据要能落到这里、或直接写到该部位、或来自病机链里
 * 讲到该部位的那一节，才算本例依据（复核员：「脾←语言表达落后」「胆←口干咽燥」「肺←过敏性鼻炎」）。
 */
let locationSignCache: Map<string, string[]> | undefined;
function locationSigns(id: string): string[] {
  if (!locationSignCache) {
    locationSignCache = new Map();
    const entries = (diagnosticsCriteria as unknown as { entries: Array<{ name: string; manifestations?: string[] }> }).entries || [];
    for (const entry of locationLexicon.entries) {
      const forms = [entry.canonical, ...entry.aliases].filter((form) => form.length > 1 || entry.system === "zangfu");
      // 只取单一脏腑命名的证（肝郁脾虚证的便溏不算肝的表现）。
      const organsIn = (name: string) => locationLexicon.entries.filter((other) => other.system === "zangfu" && name.includes(other.canonical)).map((other) => other.id);
      const signs = entries.filter((row) => forms.some((form) => row.name.includes(form)) && organsIn(row.name).every((other) => other === entry.id))
        .flatMap((row) => row.manifestations || []).filter((sign) => sign.length >= 2 && !/^[舌苔脉]/u.test(sign));
      locationSignCache.set(entry.id, unique(signs));
    }
  }
  const canonical = locationLexicon.entries.find((entry) => entry.id === id)?.canonical;
  const direct = consistency.directLocations.find((row) => canonical && row.names.includes(canonical))?.signs || [];
  const missing = (consistency.analysisSourcePolicy.missingLocationFindings as Record<string, string[]>)[id] || [];
  return unique([...(locationSignCache.get(id) || []), ...direct, ...missing]);
}
/** 虚证名里的脏腑缺依据时，点名该脏虚证的表现（肝血虚证：眩晕、视力减退），不用肝郁一类的胁胀。 */
function deficiencySignsForLocation(id: string): string[] {
  const entry = locationLexicon.entries.find((row) => row.id === id);
  if (!entry || entry.system !== "zangfu") return [];
  const rows = (diagnosticsCriteria as unknown as { entries: Array<{ name: string; manifestations?: string[] }> }).entries || [];
  const organsIn = (name: string) => locationLexicon.entries.filter((other) => other.system === "zangfu" && name.includes(other.canonical)).map((other) => other.id);
  const row = rows.find((candidate) => candidate.name.includes(entry.canonical) && /虚|亏|不足/u.test(candidate.name) && organsIn(candidate.name).every((other) => other === id));
  return (row?.manifestations || []).filter((sign) => !/^[舌苔脉]/u.test(sign)).slice(0, 2);
}
function quoteSupportsLocation(quote: string, id: string, chainQuotes: string[]): boolean {
  if (chainQuotes.includes(quote)) return true;
  if (/^[舌苔脉]/u.test(quote)) return false;
  if (analysisElements(quote).locations.includes(id)) return true;
  // 只核对脏腑病位（复核员点出的无关依据都在脏腑：脾、胆、肺……）；下焦、冲任、胞宫、经络等部位接得上病历的原文照用。
  if (locationLexicon.entries.find((entry) => entry.id === id)?.system !== "zangfu") return true;
  const signs = locationSigns(id);
  if (!signs.length) return true;
  return signs.some((sign) => quote.includes(sign) || (quote.length <= 8 && quote.length >= 2 && sign.includes(quote)));
}
function inRecordOrder(quotes: string[], recordText: string): string[] {
  const source = compact(recordText);
  const at = (quote: string) => { const index = source.indexOf(compact(quote)); return index < 0 ? Number.MAX_SAFE_INTEGER : index; };
  return unique(quotes).map((quote, index) => ({ quote, index })).sort((a, b) => at(a.quote) - at(b.quote) || a.index - b.index).map((row) => row.quote);
}

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
  return unique(value.split(/[，,。；;、\n]/u).map(str).map((q) => q.replace(/^[^：:]*[：:]\s*/u, "")).filter(Boolean).filter((quote) => analysisQuoteGrounded(quote, recordText)));
}

/** 模型写的依据按分号成段：整段逐字接得上病历就整段保留（「尿频、尿急、轻度尿痛，尿道灼热感」），否则退回逐小句核对。 */
export function groundedAnalysisSegments(value: string, recordText: string): string[] {
  return unique(value.split(/[。；;\n]/u).map(str).map((q) => q.replace(/^[^：:]*[：:]\s*/u, "")).filter(Boolean)
    .flatMap((segment) => analysisQuoteGrounded(segment, recordText) ? [segment] : groundedAnalysisQuotes(segment, recordText)));
}

function analysisQuoteGrounded(quote: string, recordText: string): boolean {
  const source = compact(recordText);
  if (!withoutNormalFindingSegments(quote) || new RegExp(consistency.analysisSourcePolicy.normalFindings, "u").test(quote)) return false;
  if (clinicalClausePolarity(quote) !== "affirmed" || new RegExp(consistency.analysisSourcePolicy.unusableFindingPrefix, "u").test(quote) || new RegExp(consistency.analysisSourcePolicy.ageOnly, "u").test(quote)) return false;
  const needle = compact(quote);
  for (let at = source.indexOf(needle); at >= 0; at = source.indexOf(needle, at + 1)) {
    if (clauseLocalMentionPolarityAt(source, at + (quote.startsWith("未") ? 1 : 0)) !== "affirmed") continue;
    // 「4月前久坐后出现会阴坠胀」是本次病程的起病句，不是既往史；只有紧挨着写了既往、曾、已愈一类的才不作本例依据
    // （共用时序规则把以月、年计的起病算作既往，慢性病主诉因此一条依据也找不到）。
    if (clinicalEventTemporalScopeAt(source, at, needle.length, { groundingQuote: true }) !== "current" &&
      new RegExp(consistency.analysisSourcePolicy.explicitPastBeforeQuote, "u").test(source.slice(Math.max(0, at - 16), at))) continue;
    // The record's field scope is retained; a quote stripped of its history heading cannot escape it.
    const end = source.indexOf("\n", at);
    const line = source.slice(source.lastIndexOf("\n", at) + 1, end < 0 ? source.length : end);
    if (new RegExp(consistency.analysisSourcePolicy.excludedSection, "u").test(line)) continue;
    if (new RegExp(consistency.analysisSourcePolicy.triggerOnly, "u").test(quote)) continue;
    return true;
  }
  return false;
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
  const location = obj(path.locationDifferentiation), nature = obj(path.natureDifferentiation);
  // 证名只说「两虚/不足」（肝肾两虚证）时，模型写的具体虚性要素（阳虚、气虚）是对「虚」的细化，照用；不退成一个空泛的「虚」。
  if (ids.natures.includes("deficiency")) {
    const refined = analysisElements([...arr(nature.items), ...arr(nature.rootDeficiency)].join("；")).natures.filter((id) => id.endsWith("_deficiency"));
    ids.natures = unique([...ids.natures, ...refined]);
  }
  // 气脱、阳脱本身就是虚到极处，不再另列一个空泛的「虚」去要神疲乏力。
  if (ids.natures.some((id) => id.endsWith("_deficiency") || id.endsWith("_collapse"))) ids.natures = ids.natures.filter((id) => id !== "deficiency");
  // 第四十八轮（主会话收窄）：模型写的病位与依据只要接得上病历就照用，不按病机链措辞整栏重排——整栏重排把肾绞痛的
  // 「肾、膀胱」换成链上「胃气上逆」里的「胃」，把同一条链原文分给每一个病位，把舌脉写成胞宫的依据。只补三件事：
  // 证名里有而栏里没有的病位；没有原文依据的病位（证名/病机链里有的才留，并点名缺的表现）；完全没写病位时才用链。
  const modelDetails = rows(location.details);
  const modelBasisFor = (label: string): string[] => {
    const mapped = analysisElements(label).locations;
    return unique(modelDetails.filter((detail) => str(detail.location) === label || analysisElements(str(detail.location)).locations.some((id) => mapped.includes(id)))
      .flatMap((detail) => groundedAnalysisSegments(str(detail.basis), recordText))
      .filter((quote) => mapped.some((id) => quoteSupportsLocation(quote, id, mechanisms.filter((m) => m.axes.locations.includes(id)).flatMap((m) => m.quotes)))));
  };
  const derivedLocationSupport = (id: string): string[] => {
    const linked = mechanisms.filter((m) => m.axes.locations.includes(id)).flatMap((m) => m.quotes);
    const canonical = labelsFor([id], [], "locations")[0];
    const direct = consistency.directLocations.find((row) => row.names.includes(canonical));
    const directQuotes = direct ? groundedAnalysisQuotes(recordSignQuotes(recordText, direct.signs).join("；"), recordText) : [];
    return unique([...linked, ...(direct && direct.signs.filter((sign) => directQuotes.some((q) => q.includes(sign))).length >= direct.minSigns ? directQuotes : [])]);
  };
  const modelLocationLabels = arr(location.items).filter((label) => analysisElements(label).locations.length > 0);
  const candidateLabels = [
    ...modelLocationLabels.filter((label) => modelBasisFor(label).length > 0),
    ...labelsFor(named.locations, modelLocationLabels, "locations"),
    ...modelLocationLabels.filter((label) => analysisElements(label).locations.every((id) => ids.locations.includes(id))),
  ];
  const coveredLocations = new Set<string>();
  let locationItems = unique(candidateLabels).filter((label) => {
    const mapped = analysisElements(label).locations;
    if (mapped.every((id) => coveredLocations.has(id))) return false;
    mapped.forEach((id) => coveredLocations.add(id));
    return true;
  });
  // 词表外的模型病位（清窍、精室、腰腹…）无从核对脏腑归属，依据接得上病历就照留。
  const unlexiconLabels = arr(location.items).filter((label) => !analysisElements(label).locations.length && modelDetails
    .some((detail) => str(detail.location) === label && groundedAnalysisSegments(str(detail.basis), recordText).length));
  locationItems = unique([...locationItems, ...unlexiconLabels]);
  if (!locationItems.length) locationItems = labelsFor(ids.locations, modelLocationLabels, "locations");
  const details: Json[] = [];
  const missingLocations: string[] = [];
  for (const label of locationItems) {
    const own = analysisElements(label).locations.length ? modelBasisFor(label)
      : unique(modelDetails.filter((detail) => str(detail.location) === label).flatMap((detail) => groundedAnalysisSegments(str(detail.basis), recordText)));
    const quotes: string[] = [...own];
    if (!own.length) for (const id of analysisElements(label).locations) {
      // 从病机链补的依据只取与该部位对得上的、至多三条（不把整条链的原文都堆给一个病位）。
      const all = derivedLocationSupport(id);
      const relevant = all.filter((quote) => quoteSupportsLocation(quote, id, []));
      const support = (relevant.length ? relevant : all).slice(0, 3);
      quotes.push(...support);
      if (!support.length) {
        const deficient = named.natures.some((nature) => nature === "deficiency" || nature.endsWith("_deficiency"));
        const deficiencySigns = deficient ? deficiencySignsForLocation(id) : [];
        const signs = deficiencySigns.length ? deficiencySigns : (consistency.analysisSourcePolicy.missingLocationFindings as Record<string, string[]>)[id] || [];
        const name = labelsFor([id], [], "locations")[0];
        missingLocations.push(`“${name}”：${signs.slice(0, 2).join("、")}`);
      }
    }
    if (quotes.length) details.push({ location: label, basis: inRecordOrder(quotes, recordText).join("；") });
  }
  const natureItems = labelsFor(ids.natures, [...arr(nature.items), ...arr(nature.rootDeficiency), ...arr(nature.branchExcess)], "natures");
  // 病性依据同理：模型依据里接得上病历的原文照留；某个要素在其中找不到对应表现时，才从证候表现表或病机链补一两条。
  const modelNatureQuotes = groundedAnalysisSegments(str(nature.basis), recordText);
  const natureQuotes: string[] = [...modelNatureQuotes], missingNatures: string[] = [];
  for (const id of ids.natures) {
    const label = labelsFor([id], [], "natures")[0];
    const signs = natureLabelSignTerms(label);
    const poles = coldHeatPolesOfNatureLabels(label);
    const observed = groundedAnalysisQuotes([...recordSignQuotes(recordText, signs), ...poles.flatMap((pole) => recordColdHeatSupport(recordText, pole).quotes)].join("；"), recordText);
    // The chain supplies the case-specific mapping for elements outside the sign table (e.g. 风、毒).
    const linked = mechanisms.filter((m) => m.axes.natures.includes(id)).flatMap((m) => m.quotes);
    // 证候表现表没有这一要素（气脱、毒…）时，用缺项提示表的表现同样核对一遍病历（气脱：冷汗、脉微；病历「出冷汗」即有）。
    const targets = signs.length ? signs : (consistency.analysisSourcePolicy.missingNatureFindings as Record<string, string[]>)[id] || [];
    const fallback = signs.length ? [] : groundedAnalysisQuotes(recordSignQuotes(recordText, targets).join("；"), recordText);
    const candidates = unique([...observed, ...linked, ...fallback]);
    const alreadySupported = modelNatureQuotes.some((quote) => candidates.includes(quote) || targets.some((sign) => sign.length >= 2 && quote.includes(sign)));
    if (alreadySupported) continue;
    if (candidates.length) natureQuotes.push(...candidates.slice(0, 2));
    else missingNatures.push(`“${label}”：${targets.slice(0, 2).join("、")}`);
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
  nature.basis = inRecordOrder(natureQuotes, recordText).join("；");
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
