import "server-only";
import { projectDeterministicDecoctionMethod } from "./diagnosis-visible-summary";
import { authoritativePatientAgeYears } from "./diagnosis-safety";
import { projectGroundedHerbFunctions } from "./herb-function-display-source";
import { buildFinalM04Snapshot, type FinalSnapshotContext } from "./m04-final-snapshot";
import { authorFinalFormulaAnalysis } from "./m04-final-analysis.server";
import { renderFinalFormulaAnalysis } from "./m04-final-analysis-validation";
import { planClosedModifications, type ClosedModificationContext } from "./m04-modification-closed-set.server";
import { applicationRecallCatalog, herbApplications, retrieveApplicationCandidates, validatePresentFindingQuote } from "./herb-application-index.server";
import { m04FinalContentPolicy } from "./m04-final-content-policy.server";
import { callFinalM04Task } from "./m04-final-task.server";
import { contentDigest } from "./m04-content-fingerprint";
import { asRecord, asRecords, asText, type M04FinalContentIO, type ModificationOption, type PresentFinding } from "./m04-final-content-types";

export type FinalizeM04Context = FinalSnapshotContext & ClosedModificationContext & {
  signal?: AbortSignal; deadline?: number;
  /** Server-owned facts from an already validated semantic reader, never public JSON metadata. */
  findings?: readonly PresentFinding[];
  env?: Readonly<Record<string, string | undefined>>;
  textbookEntryIds?: readonly string[]; textbookHerbNames?: readonly string[];
};

/** E calls this after all identity/processing/safety projections and before binding/signing.
 * Returns only the existing public structure. E still owns final schema/T1 checks,
 * Markdown render, checkpoint/HIS/client policy, attestation and signature. */
export async function finalizeM04Content<T>(reasoning: T, ctx: FinalizeM04Context, io: M04FinalContentIO = {}): Promise<T> {
  const policy = m04FinalContentPolicy(ctx.env);
  if (!policy.enabled || asRecord(reasoning).stage !== "prescribe") {
    if (policy.error) io.report?.("configuration_error", { code: policy.error, version: policy.version });
    return reasoning;
  }
  io = { ...io, patientName: ctx.caseState.patient.name || ctx.caseState.hisRecord?.fields.patientName || io.patientName };
  if (policy.modifications !== "off" && !applicationRecallCatalog().length) {
    io.report?.("configuration_error", { code: "applications_unavailable" }); return reasoning;
  }
  const result = policy.functions === "on" ? projectGroundedHerbFunctions(reasoning, { sex: String(ctx.caseState.patient.sex || ""), ageYears: authoritativePatientAgeYears(ctx.caseState) ?? undefined, recordText: ctx.record }) : structuredClone(reasoning);
  let finalContext = ctx;
  if (policy.functions === "shadow") io.report?.("function_shadow", { changed: contentDigest(projectGroundedHerbFunctions(reasoning, { sex: String(ctx.caseState.patient.sex || ""), ageYears: authoritativePatientAgeYears(ctx.caseState) ?? undefined, recordText: ctx.record })) !== contentDigest(reasoning) });
  const root = asRecord(result), formula = asRecord(root.formula);
  const candidates = asRecords(formula.candidates);
  if (!candidates.length) return reasoning;
  const remaining = (budget: number) => Math.max(0, Math.min(budget, (ctx.deadline ?? Infinity) - Date.now()));
  if (policy.modifications !== "off") {
    const deadline = Date.now() + remaining(policy.modificationBudgetMs);
    let facts = ctx.findings?.filter((finding) => validatePresentFindingQuote(finding, ctx.record, ctx.fields));
    if (!facts) {
      const found = await callFinalM04Task(io, "findings", {
        instruction: "从完整病历选当前肯定的症状/体征。只返回findings:{id,quote,fieldRef,start,end,kind:symptom|sign,conceptId,current:true,affirmed:true,eligible:true}。offset相对指定字段。不得把正常、未记载、否认、既往、诱因/缓解因素、表情、红旗处置征象、仅舌脉、被主病解释的顺带表现当独立加减。相同临床条件用同一conceptId。", record: ctx.record, fields: ctx.fields,
        prior: ctx.prior, herbs: buildFinalM04Snapshot(result, ctx).herbs,
      }, remaining(deadline - Date.now()), ctx.signal);
      facts = asRecords(asRecord(found).findings).filter((finding) => finding.current === true && finding.affirmed === true && finding.eligible === true && (finding.kind === "symptom" || finding.kind === "sign"))
        .map((finding) => ({ id: asText(finding.id), quote: asText(finding.quote), fieldRef: asText(finding.fieldRef), start: Number(finding.start), end: Number(finding.end), kind: finding.kind as PresentFinding["kind"], conceptId: asText(finding.conceptId) }))
        .filter((finding) => validatePresentFindingQuote(finding, ctx.record, ctx.fields));
    }
    facts = [...new Map(facts.map((fact) => [fact.conceptId || `${fact.fieldRef}:${fact.start}:${fact.end}`, fact])).values()];
    const snapshot = buildFinalM04Snapshot(result, ctx);
    const retrievalInput = { record: ctx.record, prior: ctx.prior, findings: facts,
      baseHerbNames: snapshot.herbs.map((herb) => herb.name), textbookEntryIds: ctx.textbookEntryIds || [], textbookHerbNames: ctx.textbookHerbNames };
    let pool = retrieveApplicationCandidates(retrievalInput);
    if (facts.length && facts.some((finding) => pool.filter((option) => option.findingId === finding.id).length < 2)) {
      const catalog = applicationRecallCatalog();
      // The shared PHI scrubber caps arrays at 100. Keep every local ID visible by
      // batching the static catalog, rather than accidentally recalling only A–D.
      const catalogBatches = Array.from({ length: Math.ceil(catalog.length / 100) }, (_, index) => catalog.slice(index * 100, index * 100 + 100));
      const recalled = asRecord(await callFinalM04Task(io, "recall", {
        instruction: "召回仅选catalogBatches内的id，返回herbIds；不得自由生成药名或引文。", facts, catalogBatches,
      }, remaining(deadline - Date.now()), ctx.signal));
      const ids = Array.isArray(recalled.herbIds) ? recalled.herbIds.filter((id): id is string => typeof id === "string") : [];
      pool = retrieveApplicationCandidates({ ...retrievalInput, recalledHerbIds: ids });
    }
    // Existing rows have no exemption. Offer their actual action as another option,
    // bound to the same present finding and real application source as every addition.
    const existingOptions: ModificationOption[] = asRecords(formula.modifications).flatMap((row) => {
      const name = asText(row.herbName), action = asText(row.action);
      if (action !== "加" && action !== "减" && action !== "调整") return [];
      const applications = herbApplications(name).slice(0, 2);
      if (!applications.length) return [];
      return facts.flatMap((finding) => {
        if (asRecord(row.triggerSource).sourceQuote !== finding.quote && row.trigger !== finding.quote && row.trigger !== `本例已见${finding.quote}`) return [];
        return [{ id: `existing:${contentDigest([snapshot.fingerprint, name, action, finding.id])}`, findingId: finding.id,
          herbKey: name, displayName: name, action, applications, scope: "uncovered" as const }];
      });
    });
    pool = [...pool, ...existingOptions];
    const planned = await planClosedModifications({ snapshot, facts, pool, existingRows: asRecords(formula.modifications), context: { ...ctx, deadline } }, io, ctx.signal);
    finalContext = { ...ctx, findings: facts.filter((finding) => planned.rows.some((row) => asRecord(row.triggerSource).sourceQuote === finding.quote)) };
    if (policy.modifications === "on") formula.modifications = planned.rows;
    io.report?.("closed_modifications", { distinctConditions: planned.distinctConditions, shortfall: planned.shortfall, rejected: planned.rejected, shadow: policy.modifications === "shadow" });
  }
  // Closed-set additions are chosen after the earlier route-level decoction pass.
  // Refresh the shared method before the authoring snapshot is built.
  const regimen = asRecords(asRecord(asRecord(projectDeterministicDecoctionMethod(result, ctx.record, authoritativePatientAgeYears(ctx.caseState) ?? undefined)).formula).candidates);
  candidates.forEach((candidate, index) => { if (regimen[index]?.decoction) candidate.decoction = regimen[index].decoction; });
  if (policy.analysis !== "off") {
    for (let index = 0; index < candidates.length; index++) {
      const snapshot = buildFinalM04Snapshot(result, { ...finalContext, candidateIndex: index });
      const authored = await authorFinalFormulaAnalysis(snapshot, io, ctx.signal, remaining(policy.analysisBudgetMs));
      // The IO adapter can retain a reference to a detached payload only. Still rebind to
      // the live context in case a caller changed its record/prior while awaiting.
      const current = buildFinalM04Snapshot(result, { ...finalContext, candidateIndex: index });
      const stable = current.fingerprint === snapshot.fingerprint;
      const analysis = renderFinalFormulaAnalysis(current, stable ? authored.sentences : []);
      if (policy.analysis === "on") candidates[index].formulaAnalysis = analysis;
      io.report?.("final_analysis", { candidate: index, degraded: authored.status === "unavailable" || !stable,
        violations: authored.violations, fingerprint: current.fingerprint, missingFunctions: current.herbs.filter((herb) => !herb.functionText).length, shadow: policy.analysis === "shadow" });
    }
  }
  // No call to the old sentence-repair/render/projection chain here.
  return result;
}
