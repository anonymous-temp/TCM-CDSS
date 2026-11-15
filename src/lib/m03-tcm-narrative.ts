import { z } from "zod";

const Id = z.string().min(1).max(100);
const Ids = z.array(Id).max(16);
export const M03TcmSentenceSchema = z.object({ id: Id, text: z.string().min(2).max(240), quoteIds: Ids, unitIds: Ids }).strict();
export type M03TcmSentence = z.infer<typeof M03TcmSentenceSchema>;
const DifferentialSchema = z.object({
  candidateId: Id, reason: M03TcmSentenceSchema, distinguishingPoints: M03TcmSentenceSchema,
  nextCheck: M03TcmSentenceSchema.nullable(),
}).strict();
export const M03TcmNarrativeSchema = z.object({
  diseaseRationale: z.array(M03TcmSentenceSchema).max(4),
  rationale: z.array(M03TcmSentenceSchema).max(6),
  overall: z.array(M03TcmSentenceSchema).max(4),
  chain: z.array(M03TcmSentenceSchema.extend({
    factQuoteIds: Ids, evidenceQuoteIds: Ids, methodIds: Ids, dependsOn: Ids,
  }).strict()).max(4),
  uncertainties: z.array(z.object({ pendingId: Id, item: M03TcmSentenceSchema, reason: M03TcmSentenceSchema, affects: M03TcmSentenceSchema }).strict()).max(4),
  diseaseDifferentials: z.array(DifferentialSchema).max(3),
  syndromeDifferentials: z.array(DifferentialSchema).max(3),
  lineageText: z.object({ reason: z.array(M03TcmSentenceSchema).max(4),
    influencedDecisions: z.array(z.object({ aspect: z.enum(["辨证视角", "方源选择", "组方思路", "加减风格"]),
      detail: M03TcmSentenceSchema, targetIds: Ids }).strict()).max(4),
  }).strict().nullable(),
}).strict();
export type M03TcmNarrative = z.infer<typeof M03TcmNarrativeSchema>;
export const M03_TCM_NARRATIVE_PROVIDER_SCHEMA = z.toJSONSchema(M03TcmNarrativeSchema);
export type NarrativeViolation = {
  code: string; sentenceIds: string[]; nodeIds: string[]; expectedUnitIds: string[];
  recordQuoteIds: string[]; detail: string;
};
export type NarrativeSentenceSlot = { path: string; sentence: M03TcmSentence; requiresQuote: boolean };
/** All prose, including pending, lens and both sides of both differentials, shares one check surface. */
export function m03TcmNarrativeSentences(draft: M03TcmNarrative): NarrativeSentenceSlot[] {
  const slots: NarrativeSentenceSlot[] = [];
  for (const key of ["diseaseRationale", "rationale", "overall", "chain"] as const) {
    draft[key].forEach((sentence, index) => slots.push({ path: `${key}.${index}`, sentence, requiresQuote: true }));
  }
  for (const key of ["diseaseDifferentials", "syndromeDifferentials"] as const) draft[key].forEach((row, index) => {
    slots.push({ path: `${key}.${index}.reason`, sentence: row.reason, requiresQuote: true });
    slots.push({ path: `${key}.${index}.distinguishingPoints`, sentence: row.distinguishingPoints, requiresQuote: true });
    if (row.nextCheck) slots.push({ path: `${key}.${index}.nextCheck`, sentence: row.nextCheck, requiresQuote: false });
  });
  draft.uncertainties.forEach((row, index) => {
    for (const key of ["item", "reason", "affects"] as const) slots.push({ path: `uncertainties.${index}.${key}`, sentence: row[key], requiresQuote: false });
  });
  draft.lineageText?.reason.forEach((sentence, index) => slots.push({ path: `lineageText.reason.${index}`, sentence, requiresQuote: true }));
  draft.lineageText?.influencedDecisions.forEach((row, index) => slots.push({ path: `lineageText.influencedDecisions.${index}`, sentence: row.detail, requiresQuote: true }));
  return slots;
}

/** Drop whole units and recursively drop downstream causal nodes. Never splice words. */
export function pruneInvalidM03TcmSentences(draft: M03TcmNarrative, violations: readonly NarrativeViolation[]): M03TcmNarrative {
  const pruned = structuredClone(draft);
  const removed = new Set(violations.flatMap((item) => [...item.sentenceIds, ...item.nodeIds]));
  let previousSize: number;
  do {
    previousSize = removed.size;
    for (const node of pruned.chain) if (node.dependsOn.some((id) => removed.has(id))) removed.add(node.id);
  } while (removed.size !== previousSize);
  const clean = (sentence: M03TcmSentence) => !removed.has(sentence.id);
  for (const key of ["diseaseRationale", "rationale", "overall"] as const) pruned[key] = pruned[key].filter(clean);
  pruned.chain = pruned.chain.filter(clean);
  pruned.uncertainties = pruned.uncertainties.filter((row) => clean(row.item) && clean(row.reason) && clean(row.affects));
  for (const key of ["diseaseDifferentials", "syndromeDifferentials"] as const) pruned[key] = pruned[key]
    .filter((row) => clean(row.reason) && clean(row.distinguishingPoints))
    .map((row) => ({ ...row, nextCheck: row.nextCheck && clean(row.nextCheck) ? row.nextCheck : null }));
  if (pruned.lineageText) {
    pruned.lineageText.reason = pruned.lineageText.reason.filter(clean);
    pruned.lineageText.influencedDecisions = pruned.lineageText.influencedDecisions.filter((row) => clean(row.detail));
  }
  return pruned;
}
export const usableM03TcmNarrative = (draft: M03TcmNarrative): boolean =>
  draft.diseaseRationale.length > 0 && draft.rationale.length > 0 && draft.overall.length > 0 && draft.chain.length > 0;
