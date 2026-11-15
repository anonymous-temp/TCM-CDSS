import "server-only";
import { distinctModificationConditions, topUpModificationRow, withoutOrphanPartnerRows } from "./m04-proposal-compiler";
import { m04ModificationSafetyIssue } from "./diagnosis-stage-contract";
import { findTcmHerbPairCautions, findTcmHerbPairIncompatibilities, isKnownTcmHerbName } from "./tcm-knowledge";
import { compositionIdentityName } from "./tcm-formula-provenance";
import { applicationCitation, applicationCitationVerified, herbApplications, validatePresentFindingQuote } from "./herb-application-index.server";
import { callFinalM04Task } from "./m04-final-task.server";
import { asRecord, asRecords, asText, type FinalM04Snapshot, type M04FinalContentIO, type ModificationOption, type PresentFinding } from "./m04-final-content-types";
import type { CaseState, ClinicalReasoningResultV2 } from "./diagnosis-types";
import { herbFunctionSourceClauses } from "./herb-function-display-source";
import { contentDigest } from "./m04-content-fingerprint";
import { herbPropertyReferenceText, herbCautionReferenceText } from "./m04-formula-analysis-claim-check.server";

export type ClosedModificationContext = {
  record: string; fields?: Readonly<Record<string, string>>;
  prior: ClinicalReasoningResultV2; caseState: CaseState;
  deadline?: number;
  /** Existing deterministic compiler adapter for non-add actions. No model may supply it. */
  compileExistingRow?: (row: Record<string, unknown>, accepted: readonly Record<string, unknown>[]) => Record<string, unknown> | undefined;
  validateRows?: (rows: readonly Record<string, unknown>[]) => boolean;
};
export type ClosedModificationResult = {
  rows: readonly Record<string, unknown>[]; rejected: readonly { optionId: string; reason: string }[];
  distinctConditions: number; shortfall: number;
};

/** All rows, including textbook rows and the last remaining row, require positive verification.
 * Injection provides the semantic readers, never a safety waiver. */
export async function planClosedModifications(input: {
  snapshot: FinalM04Snapshot; facts: readonly PresentFinding[]; pool: readonly ModificationOption[];
  existingRows: readonly unknown[]; context: ClosedModificationContext;
}, io: M04FinalContentIO = {}, signal?: AbortSignal): Promise<ClosedModificationResult> {
  io = { ...io, patientName: input.context.caseState.patient.name || input.context.caseState.hisRecord?.fields.patientName || io.patientName };
  const rejected: { optionId: string; reason: string }[] = [];
  const rows: Record<string, unknown>[] = [];
  const rowOptions = new Map<Record<string, unknown>, string>();
  const dependencies = new Map<string, readonly string[]>();
  const scopes = new Map<Record<string, unknown>, string>();
  const deadline = input.context.deadline ?? Date.now() + 2500;
  const remaining = () => Math.max(0, deadline - Date.now());
  const payload = {
    instruction: "只选给定optionId；每项提交findingId、applicationSpanIds、quoteOffsets（spanId/start/end/quote，保留完整应用段）、dose及reasonSources中的reasonSourceId。覆盖判断读最终主方、M03和原始病历。正常、既往、缓解诱因、表情、急危重处置征象、仅舌脉、由主病解释的顺带表现均不作独立加减。主方薄弱环节须说明whyWeak。不能为条数造第二个条件。",
    snapshot: input.snapshot, record: input.context.record, prior: input.context.prior,
    facts: input.facts, options: input.pool.map((option) => ({ ...option, reasonSources: herbFunctionSourceClauses(option.displayName),
      property: herbPropertyReferenceText(option.displayName), caution: herbCautionReferenceText(option.displayName) })),
  };
  const proposed = asRecords(asRecord(await callFinalM04Task(io, "select", payload, remaining(), signal)).selections).slice(0, 12);
  const eligible: { proposal: Record<string, unknown>; option: ModificationOption; finding: PresentFinding }[] = [];
  for (const proposal of proposed) {
    const id = asText(proposal.optionId), option = input.pool.find((item) => item.id === id);
    const reject = (reason: string) => rejected.push({ optionId: id, reason });
    if (!option || proposal.findingId !== option.findingId || proposal.herbName !== undefined && proposal.herbName !== option.displayName) { reject("outside_closed_set"); continue; }
    const finding = input.facts.find((fact) => fact.id === option.findingId);
    if (!finding || !validatePresentFindingQuote(finding, input.context.record, input.context.fields)) { reject("ungrounded_finding"); continue; }
    // Caller-supplied pools cannot invent genuine-looking application spans.
    const actual = herbApplications(option.displayName);
    const sourceIds = Array.isArray(proposal.applicationSpanIds) ? proposal.applicationSpanIds : [];
    const quotes = asRecords(proposal.quoteOffsets);
    const sourceOK = sourceIds.length > 0 && sourceIds.every((id) => {
      const source = option.applications.find((span) => span.id === id);
      const real = actual.find((span) => span.id === id);
      const quote = quotes.find((quote) => quote.spanId === id);
      return source && real && applicationCitation(source) === applicationCitation(real) && quote && quote.start === 0 && quote.end === real.text.length && quote.quote === real.text;
    });
    if (!sourceOK) { reject("application_quote_invalid"); continue; }
    eligible.push({ proposal, option, finding });
  }
  const verified = asRecords(asRecord(await callFinalM04Task(io, "verify", {
    instruction: "逐条正向核对，返回rows:{optionId,verdict:fits|misfit|unknown,recordQuote,current,affirmed,independent,scope:uncovered|weakly_covered,whyWeak,applicationSpanIds,reasonSourceId,requiredPartnerOptionIds}。requiredPartnerOptionIds必须填写：只有需同时保留的本批候选ID；无需伙伴时填[]。加、减、调整及教材行同核。仅在应用原文支持药症关系和所选reasonSourceId的功效、当前肯定现症且主方未覆盖/确有薄弱点时fits；读完整应用段及配伍限定，需搭配的药不在主方或同批建议中时unknown。reason及自写function不是证据。不可决定安全许可。",
    snapshot: input.snapshot, prior: input.context.prior, record: input.context.record,
    selections: eligible.map((selection) => ({ ...selection, reasonSources: herbFunctionSourceClauses(selection.option.displayName),
      property: herbPropertyReferenceText(selection.option.displayName), caution: herbCautionReferenceText(selection.option.displayName) })),
  }, remaining(), signal)).rows);
  if (input.snapshot.recordDigest !== contentDigest(input.context.record) || input.snapshot.priorDigest !== contentDigest(input.context.prior)) {
    return { rows: [], rejected: [{ optionId: "", reason: "stale_context" }], distinctConditions: 0, shortfall: 2 };
  }
  for (const { proposal, option, finding } of eligible) {
    const verdict = verified.filter((row) => row.optionId === option.id);
    const v = verdict[0];
    const reject = (reason: string) => rejected.push({ optionId: option.id, reason });
    if (verdict.length !== 1 || v?.verdict !== "fits" || v.current !== true || v.affirmed !== true || v.independent !== true || v.recordQuote !== finding.quote ||
      !(v.scope === "uncovered" || v.scope === "weakly_covered" && asText(v.whyWeak).trim()) ||
      !Array.isArray(v.applicationSpanIds) || !(proposal.applicationSpanIds as unknown[]).every((id) => (v.applicationSpanIds as unknown[]).includes(id))) { reject("not_positively_verified"); continue; }
    if (!Array.isArray(v.requiredPartnerOptionIds) || v.requiredPartnerOptionIds.some((id) => typeof id !== "string" || id === option.id || !eligible.some((item) => item.option.id === id))) { reject("invalid_partner_ids"); continue; }
    const names = [...input.snapshot.herbs.map((herb) => herb.name), ...rows.filter((row) => row.action === "加").map((row) => asText(row.herbName))];
    const reasonSource = herbFunctionSourceClauses(option.displayName).find((source) => source.id === proposal.reasonSourceId && source.id === v.reasonSourceId);
    if (!reasonSource) { reject("ungrounded_reason"); continue; }
    let compiled: Record<string, unknown> | undefined;
    if (option.action === "加") compiled = topUpModificationRow({ trigger: finding.quote, herbName: option.displayName,
      dose: asText(proposal.dose), reason: reasonSource.text }, {
      prior: input.context.prior, caseState: input.context.caseState, candidateHerbNames: names, existingTriggers: [],
    });
    else {
      const existing = asRecords(input.existingRows).find((row) => row.action === option.action && row.herbName === option.displayName);
      if (existing && names.includes(option.displayName)) compiled = input.context.compileExistingRow?.(structuredClone(existing), rows);
    }
    if (!compiled || compiled.herbName !== option.displayName || compiled.action !== option.action || m04ModificationSafetyIssue(compiled, 0, input.context.prior, isKnownTcmHerbName)) { reject("deterministic_rejection"); continue; }
    const source = option.applications.find((span) => span.id === (proposal.applicationSpanIds as unknown[])[0])!;
    const citation = applicationCitation(source);
    if (!applicationCitationVerified(citation) || citation.length > 800) { reject("unverified_source"); continue; }
    // Compiler owns dose, handling and caution text. The reason remains the checked source,
    // never a model's invented pharmacology. Do not carry arbitrary substitutions.
    delete compiled.substitutions;
    compiled = { ...compiled, trigger: `本例已见${finding.quote}`, triggerSource: { kind: "pathogenesis_patient_fact", sourceRef: finding.fieldRef, sourceQuote: finding.quote },
      reason: reasonSource.text, evidence: { evidenceLevel: "kb_entry", source: citation, confidence: "中" } };
    if (m04ModificationSafetyIssue(compiled, 0, input.context.prior, isKnownTcmHerbName)) { reject("final_row_safety"); continue; }
    const combinedNames = option.action === "加" ? [...names, option.displayName] : names;
    if (option.action === "加" && (names.some((name) => compositionIdentityName(name) === compositionIdentityName(option.displayName)) ||
      findTcmHerbPairIncompatibilities(combinedNames).length > 0 || findTcmHerbPairCautions(combinedNames).length > 0) ||
      input.context.validateRows && !input.context.validateRows([...rows, compiled])) { reject("combined_conflict"); continue; }
    rows.push(compiled);
    rowOptions.set(compiled, option.id);
    dependencies.set(option.id, v.requiredPartnerOptionIds as string[]);
    scopes.set(compiled, asText(v.scope));
  }
  // Keep dependency components together, including after dose/population/pair
  // rejection. Later verified options can fill vacancies without another call.
  const byOption = new Map(rows.map((row) => [rowOptions.get(row)!, row]));
  const selected: Record<string, unknown>[] = [];
  const conditionFor = (row: Record<string, unknown>) => {
    const quote = asText((row.triggerSource as Record<string, unknown>)?.sourceQuote);
    const finding = input.facts.find((finding) => finding.quote === quote);
    return finding?.conceptId || finding?.id || quote;
  };
  const ranked = [...rows].sort((left, right) => Number(scopes.get(left) !== "uncovered") - Number(scopes.get(right) !== "uncovered"));
  const distinctFirst = ranked.filter((row, index) => ranked.findIndex((other) => conditionFor(other) === conditionFor(row)) === index);
  const ordered = [...distinctFirst, ...ranked.filter((row) => !distinctFirst.includes(row))];
  for (const row of ordered) {
    const component = new Set<string>();
    let complete = true;
    const visit = (id: string) => {
      if (component.has(id)) return;
      component.add(id);
      if (!byOption.has(id)) { complete = false; return; }
      for (const partner of dependencies.get(id) || []) visit(partner);
    };
    visit(rowOptions.get(row)!);
    if (!complete) { rejected.push({ optionId: rowOptions.get(row)!, reason: "partner_not_accepted" }); continue; }
    const additions = [...component].map((id) => byOption.get(id)!).filter((item) => !selected.includes(item));
    if (selected.length + additions.length > 4) { rejected.push({ optionId: rowOptions.get(row)!, reason: "row_limit" }); continue; }
    selected.push(...additions);
  }
  let completeRows = withoutOrphanPartnerRows(selected, input.snapshot.herbs.map((herb) => herb.name));
  for (let pass = 0; pass < selected.length; pass++) {
    completeRows = completeRows.filter((row) => (dependencies.get(rowOptions.get(row)!) || []).every((id) => completeRows.includes(byOption.get(id)!)));
  }
  if (input.context.validateRows && !input.context.validateRows(completeRows)) {
    return { rows: [], rejected: [...rejected, { optionId: "", reason: "final_combined_conflict" }], distinctConditions: 0, shortfall: 2 };
  }
  const clinicalConditions = new Set(completeRows.map(conditionFor));
  const distinctConditions = Math.min(distinctModificationConditions(completeRows), clinicalConditions.size);
  return { rows: completeRows, rejected, distinctConditions, shortfall: Math.max(0, 2 - distinctConditions) };
}
