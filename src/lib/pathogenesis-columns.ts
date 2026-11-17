import criteriaJson from "../data/tcm-diagnostics-syndrome-criteria.json";
import labelConcepts from "../data/tcm-syndrome-label-concepts.source.json";
import factPolicy from "../data/delivery-facts-policy.source.json";
import policy from "../data/pathogenesis-columns.source.json";
import coldHeatSigns from "../data/tcm-cold-heat-signs.source.json";
import natureJson from "../data/tcm-nature-lexicon.json";
import { clauseLocalMentionPolarityAt, negationGroundingEquivalents, recordedFindingReading } from "./diagnosis-safety";
import { EXCESS_ELEMENTS, MIN_RECORD_SIGNS, natureLabelSignTerms, recordExcessSigns, uncertaintyAnsweredByRecord, uncertaintyMissingClaims, uncertaintiesWithRecordedAnswers, uncertaintyAsksListedElement, uncertaintyDiscussesSyndromeNaming, uncertaintyLeaksPromptWording } from "./analysis-element-closure";
import { classifyNatureColumns, natureItemDeficiencyOrExcess } from "./nature-column-classification";

type Json = Record<string, unknown>;
const object = (value: unknown): Json | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
const rows = (value: unknown): Json[] => Array.isArray(value) ? value.flatMap((row) => object(row) ? [row as Json] : []) : [];
const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const strings = (value: unknown): string[] => Array.isArray(value) ? value.map(text).filter(Boolean) : [];
const PROCESS_ONLY = new RegExp(policy.processOnlyAssertionPattern, "u");
const PENDING_SENTENCE = new RegExp(policy.uncertainty.pendingSentencePattern, "u");
const AUTHOR_MODAL = new RegExp(policy.assertionModalityPattern, "u");
const RELATION = new RegExp(policy.uncertainty.questionRelationPattern, "u");
const UNKNOWN = new RegExp(policy.uncertainty.unknownPattern, "u");
const SETTLED = new RegExp(policy.uncertainty.settledPattern, "gu");
const PENDING = new RegExp(policy.uncertainty.pendingPattern, "u");
const PREFIX = new RegExp(policy.uncertainty.questionPrefix, "u");
const SUFFIX = new RegExp(policy.uncertainty.questionSuffix, "u");
const GLUE = new RegExp(policy.uncertainty.questionGlue, "u");
const aliases = natureJson.entries.filter((entry) => entry.kind !== "eight_principles" && entry.kind !== "disharmony")
  .map((entry) => ({ label: entry.canonical, forms: [entry.canonical, ...entry.aliases] }));
const assertionRows = [...policy.assertionAliases, ...aliases];
const sentences = (value: string): string[] => value.match(/[^。！？!?；;]+[。！？!?；;]?/gu) || [];
const clauses = (value: string): string[] => value.split(/[，,。；;\n]/u).filter(Boolean);

/** Only affirmed authored assertions; lexical forms are governed, polarity is the existing shared reader. */
export function assertedNatureLabels(value: string, context = value): string[] {
  const virtualCold = clauses(context).some((clause) => !AUTHOR_MODAL.test(clause) && policy.virtualColdContextForms.some((form) => clause.includes(form)));
  const virtualHeat = clauses(context).some((clause) => !AUTHOR_MODAL.test(clause) && policy.virtualHeatContextForms.some((form) => clause.includes(form)));
  const found = new Set<string>();
  for (const clause of clauses(value)) {
    if (AUTHOR_MODAL.test(clause)) continue;
    const protectedSpans: Array<[number, number]> = [];
    for (const form of [...policy.nonExcessForms, ...policy.assertionFindingOnlyForms]) for (let at = clause.indexOf(form); at >= 0; at = clause.indexOf(form, at + form.length)) protectedSpans.push([at, at + form.length]);
    if (virtualCold) for (const match of clause.matchAll(new RegExp(policy.virtualColdFormsPattern, "gu"))) protectedSpans.push([match.index!, match.index! + match[0].length]);
    if (virtualHeat) for (const match of clause.matchAll(new RegExp(policy.virtualHeatFormsPattern, "gu"))) protectedSpans.push([match.index!, match.index! + match[0].length]);
    for (const row of assertionRows) {
      for (const form of row.forms) {
        if (PROCESS_ONLY.test(form)) continue;
        for (let at = clause.indexOf(form); at >= 0; at = clause.indexOf(form, at + form.length)) {
          if (clauseLocalMentionPolarityAt(clause, at) !== "affirmed") continue;
          if (policy.uncertainty.assertionExclusions.some((marker) => clause.slice(0, at).endsWith(marker))) continue;
          if (new RegExp(policy.assertionNegativeTailPattern, "u").test(clause.slice(0, at))) continue;
          if (natureItemDeficiencyOrExcess(row.label) === "branch" && protectedSpans.some(([start, end]) => at >= start && at + form.length <= end)) continue;
          // A virtual cold/heat belongs to the deficiency; do not read its last character as an excess pathogen.
          if (form.length === 1 && at > 0 && natureItemDeficiencyOrExcess(clause.slice(Math.max(0, at - 2), at + 1)) === "root") continue;
          found.add(row.label);
        }
      }
    }
  }
  return [...found];
}

export function uncertaintyAlreadySettled(row: { item?: unknown; reason?: unknown }): boolean {
  const value = `${text(row.item)}；${text(row.reason)}`;
  SETTLED.lastIndex = 0;
  const matches = value.match(SETTLED);
  return Boolean(matches?.length) && !PENDING.test(value.replace(SETTLED, ""));
}

function questionCore(item: string): string {
  return item.replace(PREFIX, "").replace(SUFFIX, "").trim();
}
function findingAnswered(term: string, recordText: string, questionContext = ""): boolean {
  // An explicit information gap remains open despite a historical value or a concern mentioning the same noun.
  const gapForms = [term, ...negationGroundingEquivalents(term)];
  if (clauses(recordText).some((clause) => UNKNOWN.test(clause) && gapForms.some((form) => clause.includes(form)))) return false;
  let documented = recordText.replace(/[^，,。；;\n]+/gu, (clause) => UNKNOWN.test(clause) ? "" : clause);
  const slot = policy.uncertainty.recordedSlots.find((entry) => entry.asked.includes(term) && new RegExp(entry.questionContext, "u").test(questionContext));
  if (slot) {
    documented = documented.split(/[。！？!?\n]/u).filter((sentence) => new RegExp(slot.recordContext, "u").test(sentence) && !new RegExp(slot.excludeRecordContext, "u").test(sentence)).join("。");
    term = slot.term;
  }
  if (uncertaintyAnsweredByRecord(term, documented)) return true;
  const forms = [...new Set([term, ...negationGroundingEquivalents(term).filter((form) => documented.includes(form))])];
  const readings = forms.map((form) => recordedFindingReading(documented, form));
  if (readings.some((reading) => reading === "conflicting" || reading === "ambiguous")) return false;
  return readings.some((reading) => reading === "affirmed" || reading === "denied");
}
function sameElement(question: string, asserted: readonly string[]): boolean {
  const remainder = assertionRows.flatMap((row) => row.forms).sort((a, b) => b.length - a.length).reduce((rest, form) => rest.split(form).join(""), question);
  if (!new RegExp(policy.uncertainty.elementQuestionRemainder, "u").test(remainder)) return false;
  const wanted = assertedNatureLabels(question);
  return wanted.length > 0 && wanted.every((label) => asserted.includes(label));
}

/** One outlet for generated, rewritten, cached and overview-migrated pending items. Mixed questions retain the unanswered part. */
export function reconcileAnalysisUncertainties(reasoning: Json, recordText: string): void {
  const pathogenesis = object(reasoning.pathogenesis);
  const overview = object(reasoning.overview);
  if (!pathogenesis) return;
  const names = [text(overview?.primarySyndrome), ...strings(overview?.secondarySyndromes)].join("、");
  const namedIds = [text(overview?.primarySyndrome), ...strings(overview?.secondarySyndromes)].flatMap((name) => (factPolicy.syndromeElements as Record<string, string[]>)[name] || []);
  const namedLabels = labelConcepts.natures.filter((row) => row.terms.some((term) => names.includes(term)) && natureJson.entries.some((entry) => entry.canonical === row.id)).map((row) => row.id);
  const asserted = [...new Set([...assertedNatureLabels(`${names}。${text(overview?.tcmDiagnosticRationale)}`), ...namedLabels, ...natureJson.entries.filter((entry) => namedIds.includes(entry.id)).map((entry) => entry.canonical)])];
  const reconcileRows = (items: Json[]): Json[] => (recordText ? uncertaintiesWithRecordedAnswers(items, recordText) : items).flatMap((original) => {
    let row = original;
    const claims = uncertaintyMissingClaims(text(row.reason));
    if (claims.length === 1 && !RELATION.test(text(row.item))) {
      const parts = questionCore(claims[0]).split(GLUE).map((part) => part.trim()).filter(Boolean);
      const missing = parts.filter((part) => !findingAnswered(part, recordText, text(row.item)));
      if (missing.length < parts.length) row = { ...row, reason: `尚需核实${missing.length ? missing.join("、") : text(row.item)}` };
    }
    if (uncertaintyAlreadySettled(row) || uncertaintyLeaksPromptWording(row) || uncertaintyDiscussesSyndromeNaming(row) || uncertaintyAsksListedElement(text(row.item).replace(SUFFIX, ""), pathogenesis)) return [];
    const item = text(row.item);
    const core = questionCore(item);
    if (RELATION.test(item) || new RegExp(policy.uncertainty.reasonQuestionPattern, "u").test(text(row.reason))) return [row];
    // Ask-elements are explicitly introduced with 是否兼/夹/合并. A question about degree or course is still a question.
    if (new RegExp(policy.uncertainty.elementQuestionPrefix, "u").test(item) && sameElement(core, asserted)) return [];
    if (new RegExp(policy.uncertainty.elementQuestionPrefix, "u").test(item) && EXCESS_ELEMENTS.some((element) => element.nameMarkers.includes(core) && recordExcessSigns(recordText, element.id).length >= MIN_RECORD_SIGNS)) return [];
    const parts = core.split(GLUE).map((part) => part.trim()).filter(Boolean);
    const answered = (part: string): boolean => findingAnswered(part, recordText, item) || (part.length === 4 && [part.slice(0, 2), part.slice(2)].every((half) => findingAnswered(half, recordText, item)));
    if (!parts.length || !recordText) return [row];
    const missing = parts.filter((part) => !answered(part));
    if (missing.length === parts.length) return [row];
    if (!missing.length) return [];
    const remaining = missing.join("、");
    return [{ ...row, item: remaining.includes("是否") || !PREFIX.test(item) ? remaining : `有无${remaining}`, reason: `尚需核实${remaining}` }];
  });
  if (Array.isArray(pathogenesis.uncertainties)) pathogenesis.uncertainties = reconcileRows(rows(pathogenesis.uncertainties));
  const pendingProse = (value: string): string => sentences(value).flatMap((sentence) => {
    const question = sentence.trim().replace(/[。；;]$/u, "").replace(/^待核实[：:]\s*/u, "");
    if (!PENDING_SENTENCE.test(sentence.trim())) return [sentence];
    const kept = reconcileRows([{ item: question, reason: "尚需核实", affects: "辨证" }]);
    if (!kept.length) return [];
    return kept[0].item === question ? [sentence] : [`${text(kept[0].item)}尚待核实。`];
  }).join("");
  if (overview) for (const key of ["tcmDiagnosticRationale", "overallPathogenesis"]) if (typeof overview[key] === "string") overview[key] = pendingProse(text(overview[key]));
  for (const key of ["summary", "natureSummary"]) if (typeof pathogenesis[key] === "string") pathogenesis[key] = pendingProse(text(pathogenesis[key]));
  if (overview && typeof overview.primarySyndromeResolutionReason === "string") {
    const reason = overview.primarySyndromeResolutionReason.replace(/[^，,。；;\n]+/gu, (clause) => {
      if (!UNKNOWN.test(clause)) return clause;
      const kept = reconcileRows([{ item: clause.trim(), reason: clause.trim(), affects: "证候" }]);
      return kept.length ? (kept[0].item === clause.trim() ? clause : text(kept[0].reason)) : "";
    }).replace(/[，,；;](?=[，,。；;])/gu, "").replace(/^[，,。；;\s]+/u, "").trim();
    if (reason) overview.primarySyndromeResolutionReason = reason;
    else delete overview.primarySyndromeResolutionReason;
  }
}

const methodItems = (value: string): string[] => [...new Set(value.split(/[，,、；;。]/u).map((item) => item.trim()).filter(Boolean))];
/** The delivered overall method is the only phrase authority. A fallback copies a related existing item, never authors a method. */
export function reconcileChainTherapy(reasoning: Json): void {
  const pathogenesis = object(reasoning.pathogenesis);
  const overall = methodItems(text(object(reasoning.therapy)?.overallMethod));
  if (!pathogenesis) return;
  for (const node of rows(pathogenesis.chain)) {
    const kept = methodItems(text(node.therapyDirection)).filter((item) => overall.some((method) => method.includes(item)));
    if (kept.length) { node.therapyDirection = kept.join("，"); continue; }
    const mechanism = text(node.pathogenesis);
    const scores = overall.map((method, index) => ({ method, index, score: policy.therapyElements.reduce((sum, row) => sum + (row.pathogenesis.some((word) => mechanism.includes(word)) && row.method.some((word) => method.includes(word)) ? 1 : 0), 0) }));
    scores.sort((a, b) => b.score - a.score || a.index - b.index);
    node.therapyDirection = scores[0]?.method || "";
  }
}

/** Empty governed regex cells can yield zero-width matches; a finding reader must only receive nonempty terms. */
export function natureEvidenceTerms(label: string, evidence: readonly string[]): string[] {
  const labels = (policy.signLabels as Record<string, string[]>)[label] || [label];
  const signs = labels.flatMap(natureLabelSignTerms);
  const criteria = (policy.evidenceCriteria as Record<string, string[]>)[label] || [];
  for (const entry of criteriaJson.entries) if (criteria.includes(entry.name)) signs.push(...entry.specific, ...entry.manifestations);
  const dimensions = (policy.evidenceDimensions as Record<string, string[]>)[label] || [];
  for (const dimension of coldHeatSigns.dimensions.filter((row) => dimensions.includes(row.dimension))) for (const quote of evidence) {
    for (const match of quote.matchAll(new RegExp(dimension.heat, "gu"))) signs.push(match[0]);
  }
  if (labels.includes("寒") || labels.includes("热")) {
    const pole = labels.includes("寒") ? "cold" : "heat";
    for (const dimension of coldHeatSigns.dimensions) for (const quote of evidence) {
      for (const match of quote.matchAll(new RegExp(dimension[pole], "gu"))) signs.push(match[0]);
    }
  }
  return [...new Set(signs)].filter(Boolean);
}

/** Only close an explicit empty-column contradiction. Other absent elements remain P6a's responsibility. */
export function reconcileEmptyNatureAssertions(reasoning: Json, recordText: string): void {
  const overview = object(reasoning.overview), pathogenesis = object(reasoning.pathogenesis);
  const nature = object(pathogenesis?.natureDifferentiation);
  if (!overview || !pathogenesis || !nature) return;
  classifyNatureColumns(nature);
  if (!recordText) return;
  const emptyRoot = !strings(nature.rootDeficiency).length, emptyBranch = !strings(nature.branchExcess).length;
  if (!emptyRoot && !emptyBranch) return;
  const nodes = rows(pathogenesis.chain);
  const authored = [text(overview.tcmDiagnosticRationale), text(overview.overallPathogenesis), text(pathogenesis.summary), ...nodes.map((node) => text(node.pathogenesis))].join("。");
  const context = [authored, strings(nature.items).join("、"), text(overview.primarySyndrome)].join("。");
  const current = assertedNatureLabels(strings(nature.items).join("、"), context);
  const chainLabels = assertedNatureLabels(nodes.map((node) => text(node.pathogenesis)).join("。"), context);
  const missing = assertedNatureLabels(authored, context).filter((label) => !current.includes(label) && (natureItemDeficiencyOrExcess(label) === "root" ? emptyRoot : emptyBranch && policy.emptyBranchExceptionLabels.includes(label) && chainLabels.includes(label)));
  const denied: string[] = [];
  const evidence = [text(nature.basis), ...strings(overview.primarySyndromeBasis), ...nodes.map((node) => text(node.patientFact))].flatMap(clauses)
    .map((quote) => quote.trim()).filter((quote) => quote.length >= 2 && recordText.includes(quote));
  for (const label of missing) {
    const signs = natureEvidenceTerms(label, evidence);
    const grounded = evidence.find((quote) => signs.some((sign) => quote.includes(sign) && recordedFindingReading(recordText, sign) === "affirmed"));
    if (grounded) {
      nature.items = [...strings(nature.items), label];
      if (!text(nature.basis).includes(grounded)) nature.basis = [text(nature.basis), grounded].filter(Boolean).join("；");
    } else denied.push(label);
  }
  // No replacement prose: remove only the independent authored sentence asserting an ungrounded element.
  const cut = (value: unknown) => sentences(text(value)).filter((sentence) => !assertedNatureLabels(sentence, context).some((label) => denied.includes(label))).join("");
  if (denied.length) {
    for (const key of ["tcmDiagnosticRationale", "overallPathogenesis"]) if (typeof overview[key] === "string") overview[key] = cut(overview[key]);
    for (const key of ["summary", "natureSummary"]) if (typeof pathogenesis[key] === "string") pathogenesis[key] = cut(pathogenesis[key]);
    pathogenesis.chain = nodes.flatMap((node) => {
      const mechanism = cut(node.pathogenesis);
      return mechanism ? [{ ...node, pathogenesis: mechanism }] : [];
    });
  }
  classifyNatureColumns(nature);
}

export function reconcilePathogenesisColumns(reasoning: Json, recordText: string): void {
  reconcileEmptyNatureAssertions(reasoning, recordText);
  reconcileAnalysisUncertainties(reasoning, recordText);
  reconcileChainTherapy(reasoning);
}
