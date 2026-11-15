import "server-only";
import { z } from "zod";
import { activeM03TcmUnits, m03TcmHash, verifyFrozenM03TcmConclusion, type FrozenM03TcmConclusion, type M03TcmContext } from "./m03-tcm-conclusion";
import { M03TcmNarrativeSchema, m03TcmNarrativeSentences, type M03TcmNarrative, type NarrativeViolation, type NarrativeSentenceSlot } from "./m03-tcm-narrative";
import { withinM03TcmBudget } from "./m03-tcm-conclusion-checks.server";
import { assertM03TcmProjection, type M03TcmHalf } from "./m03-tcm-projection";

export type M03TcmTextCheckInput = {
  inputHash: string; conclusionHash: string; baseRevision: number;
  conclusion: FrozenM03TcmConclusion; context: M03TcmContext;
  sentences: NarrativeSentenceSlot[]; projected: M03TcmHalf | null;
};
const ViolationSchema = z.object({ code: z.string().min(1).max(100), sentenceIds: z.array(z.string()).max(100),
  nodeIds: z.array(z.string()).max(16), expectedUnitIds: z.array(z.string()).max(40), recordQuoteIds: z.array(z.string()).max(16), detail: z.string().max(800) }).strict();
const CheckResultSchema = z.object({ inputHash: z.string(), conclusionHash: z.string(), baseRevision: z.number().int(),
  status: z.enum(["pass", "fail", "unknown"]), violations: z.array(ViolationSchema).max(100) }).strict();
export type M03TcmTextChecker = (input: M03TcmTextCheckInput, signal: AbortSignal, absoluteDeadline: number) => Promise<z.infer<typeof CheckResultSchema>>;
export type M03TcmTextCheckIO = {
  /** S1a ledger/integrity adapter. Full sentences, no duplicate local language rules. */
  checkIntegrity?: M03TcmTextChecker;
  /** S1b final full-field facts adapter, including time, negatives, pending and differential knowledge separation. */
  checkFacts?: M03TcmTextChecker;
  /** Narrow relation check: quote→mechanism/units/method/lineage agrees with frozen conclusion. */
  checkSemantics?: M03TcmTextChecker;
};
export type M03TcmNarrativeCheck = { status: "pass" | "fail" | "unknown"; violations: NarrativeViolation[] };
const violation = (code: string, ids: string[], detail = ""): NarrativeViolation => ({ code, sentenceIds: ids, nodeIds: [], expectedUnitIds: [], recordQuoteIds: [], detail });

export function structuralM03TcmNarrativeViolations(draft: M03TcmNarrative, conclusion: FrozenM03TcmConclusion, ctx: M03TcmContext): NarrativeViolation[] {
  const violations: NarrativeViolation[] = [];
  const slots = m03TcmNarrativeSentences(draft);
  const known = new Set(activeM03TcmUnits(conclusion).map((unit) => unit.id));
  const quotes = new Set(conclusion.quotes.map((quote) => quote.id));
  const methods = new Map(conclusion.methods.map((method) => [method.id, method]));
  const add = (code: string, id: string) => violations.push(violation(code, [id]));
  for (const { sentence, requiresQuote } of slots) {
    if (slots.filter((slot) => slot.sentence.id === sentence.id).length !== 1) add("duplicate_sentence_id", sentence.id);
    if (sentence.unitIds.some((id) => !known.has(id))) add("inactive_unit", sentence.id);
    if (sentence.quoteIds.some((id) => !quotes.has(id)) || requiresQuote && sentence.quoteIds.length === 0) add("invalid_sentence_quote", sentence.id);
  }
  for (const node of draft.chain) {
    if (node.unitIds.length === 0 || node.factQuoteIds.length === 0 || node.evidenceQuoteIds.length === 0 || node.methodIds.length === 0) add("empty_chain_relation", node.id);
    if ([...node.factQuoteIds, ...node.evidenceQuoteIds].some((id) => !quotes.has(id) || !node.quoteIds.includes(id))) add("invalid_chain_quote", node.id);
    const supportQuotes = new Set(node.unitIds.flatMap((id) => activeM03TcmUnits(conclusion).find((unit) => unit.id === id)?.quoteIds || []));
    if (node.evidenceQuoteIds.some((id) => !supportQuotes.has(id))) add("unrelated_chain_evidence", node.id);
    if (node.methodIds.some((id) => !methods.has(id) || !methods.get(id)!.targets.some((target) => node.unitIds.includes(target)))) add("inactive_method", node.id);
    const position = draft.chain.findIndex((item) => item.id === node.id);
    if (node.dependsOn.some((id) => !draft.chain.slice(0, position).some((item) => item.id === id))) add("invalid_chain_dependency", node.id);
  }
  for (const row of draft.uncertainties) {
    if (!conclusion.pending.some((item) => item.id === row.pendingId)) violations.push(violation("unknown_pending", [row.item.id, row.reason.id, row.affects.id]));
  }
  for (const [kind, rows] of [["disease", draft.diseaseDifferentials], ["syndrome", draft.syndromeDifferentials]] as const) {
    const seen = new Set<string>();
    for (const row of rows) {
      const candidate = ctx.differentials[kind].find((item) => item.id === row.candidateId);
      if (!candidate || seen.has(row.candidateId) || candidate.name === (kind === "disease" ? conclusion.disease.name : conclusion.primary.name)) violations.push(violation("differential_out_of_set", [row.reason.id, row.distinguishingPoints.id, ...(row.nextCheck ? [row.nextCheck.id] : [])]));
      seen.add(row.candidateId);
    }
  }
  const lensIds = slots.filter((slot) => slot.path.startsWith("lineageText")).map((slot) => slot.sentence.id);
  if (draft.lineageText && !conclusion.lineage) violations.push(violation("lineage_not_frozen", lensIds));
  for (const row of draft.lineageText?.influencedDecisions || []) {
    if (row.targetIds.length === 0 || row.targetIds.some((id) => !conclusion.lineage?.targets.includes(id))) add("lineage_target_drift", row.detail.id);
  }
  return violations;
}

export async function validateM03TcmNarrative(
  draft: M03TcmNarrative, conclusion: FrozenM03TcmConclusion, ctx: M03TcmContext,
  io: M03TcmTextCheckIO, signal: AbortSignal, absoluteDeadline: number, projected: M03TcmHalf | null = null,
): Promise<M03TcmNarrativeCheck> {
  M03TcmNarrativeSchema.parse(draft);
  if (!verifyFrozenM03TcmConclusion(conclusion)) throw new Error("conclusion_hash_changed");
  if (projected) assertM03TcmProjection(conclusion, projected, ctx);
  const violations = structuralM03TcmNarrativeViolations(draft, conclusion, ctx);
  const sentences = m03TcmNarrativeSentences(draft);
  const input: M03TcmTextCheckInput = { conclusionHash: conclusion.conclusionHash, baseRevision: conclusion.revision,
    inputHash: m03TcmHash({ conclusionHash: conclusion.conclusionHash, ctx, draft, projected }), conclusion, context: ctx, sentences, projected };
  const allIds = sentences.map((slot) => slot.sentence.id);
  let unknown = false;
  const results = await Promise.all(([ ["integrity", io.checkIntegrity], ["facts", io.checkFacts], ["semantics", io.checkSemantics] ] as const).map(async ([name, checker]) => {
    let result: z.infer<typeof CheckResultSchema> | undefined;
    try {
      if (checker) result = CheckResultSchema.parse(await withinM03TcmBudget((child) => checker(structuredClone(input), child, absoluteDeadline), signal, absoluteDeadline));
    } catch { signal.throwIfAborted(); }
    return { name, result };
  }));
  for (const { name, result } of results) {
    if (!result || result.inputHash !== input.inputHash || result.conclusionHash !== input.conclusionHash || result.baseRevision !== input.baseRevision || result.status === "unknown" || result.status === "fail" && result.violations.length === 0) {
      unknown = true; violations.push(violation(`${name}_unavailable`, allIds)); continue;
    }
    for (const item of result.violations) {
      // The checker must point at actual complete units; unaddressable findings cannot be silently ignored.
      const ids = [...item.sentenceIds, ...item.nodeIds];
      const bound = item.recordQuoteIds.some((id) => conclusion.quotes.some((quote) => quote.id === id)) ||
        item.expectedUnitIds.some((id) => activeM03TcmUnits(conclusion).some((unit) => unit.id === id));
      if (ids.length === 0 || ids.some((id) => !allIds.includes(id)) || name !== "integrity" && !bound) {
        unknown = true; violations.push(violation(`${name}_unaddressable`, allIds));
      } else violations.push(item);
    }
  }
  return { status: unknown ? "unknown" : violations.length > 0 ? "fail" : "pass", violations };
}
