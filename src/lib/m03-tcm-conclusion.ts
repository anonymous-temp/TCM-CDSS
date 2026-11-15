import { createHash } from "node:crypto";
import { z } from "zod";

/** Internal contracts only. No external DTO, safety decision or model transport lives here. */
const Id = z.string().min(1).max(100);
const Name = z.string().min(1).max(120);
const Ids = z.array(Id).max(40);
const Indices = z.array(z.number().int().min(0).max(15)).max(16);
const UnitProposalSchema = z.object({ id: Id, quotes: Indices, criteria: Ids }).strict();
export const M03TcmConclusionProposalSchema = z.object({
  disease: z.object({ name: Name, quotes: Indices }).strict(),
  quotePool: z.array(z.object({ quote: z.string().min(2).max(160), sourceHint: z.string().max(200).nullable() }).strict()).max(16),
  locations: z.array(UnitProposalSchema).max(4),
  elements: z.object({ root: z.array(UnitProposalSchema).max(8), branch: z.array(UnitProposalSchema).max(8) }).strict(),
  primary: Name,
  secondary: z.array(Name).max(2),
  methods: z.array(z.object({ text: z.string().min(1).max(120), targets: Ids, quotes: Indices }).strict()).max(5),
  direction: z.string().max(1200),
  lineage: z.object({ applicable: z.enum(["applicable", "partial", "not-applicable"]), targets: Ids }).strict().nullable(),
}).strict();
export const M03_TCM_CONCLUSION_PROVIDER_SCHEMA = z.toJSONSchema(M03TcmConclusionProposalSchema);
export type M03TcmConclusionProposal = z.infer<typeof M03TcmConclusionProposalSchema>;
export type UnitProposal = z.infer<typeof UnitProposalSchema>;
export const CheckStatusSchema = z.enum(["pass", "fail", "unknown", "not_applicable"]);
export type CheckStatus = z.infer<typeof CheckStatusSchema>;
const QuoteSchema = z.object({
  id: Id, text: z.string().min(2).max(160), fieldPath: Id,
  start: z.number().int().nonnegative(), end: z.number().int().nonnegative(),
  scope: z.enum(["current", "history", "other"]), polarity: z.enum(["affirmed", "denied", "unknown"]),
  observation: z.enum(["abnormal", "normal", "unknown"]),
}).strict();
export type RecordQuote = z.infer<typeof QuoteSchema>;
const CheckedUnitSchema = z.object({
  id: Id, label: Name, locationIds: Ids, quoteIds: Ids, criteriaIds: Ids,
  status: CheckStatusSchema, strict: z.boolean(), reasonCode: Id,
}).strict();
export type CheckedUnit = z.infer<typeof CheckedUnitSchema>;
const SyndromeSchema = z.object({ name: Name, locationIds: Ids, elementIds: Ids }).strict();
export const M03TcmConclusionSchema = z.object({
  version: z.literal("m03-tcm-conclusion-v1"), revision: z.number().int().positive(),
  disease: z.object({ name: Name, quoteIds: Ids, status: CheckStatusSchema }).strict(),
  quotes: z.array(QuoteSchema).max(16), locations: z.array(CheckedUnitSchema).max(4),
  root: z.array(CheckedUnitSchema).max(8), branch: z.array(CheckedUnitSchema).max(8),
  primary: SyndromeSchema.extend({ resolution: z.enum(["resolved", "bounded", "unresolved"]) }).strict(),
  secondary: z.array(SyndromeSchema).max(2),
  methods: z.array(z.object({ id: Id, text: z.string().min(1).max(120), targets: Ids, quoteIds: Ids, sourceId: Id.nullable() }).strict()).max(5),
  direction: z.string().max(1200),
  formulaLock: z.object({ names: z.array(Name).max(4), mode: z.enum(["single", "combined", "alternatives", "self_devised", "none"]), sourceIds: Ids }).strict(),
  anchor: z.object({ textbookRowId: Id.nullable(), jingfangId: Id.nullable(), compositeRuleId: Id.nullable() }).strict(),
  pending: z.array(z.object({ id: Id, target: Name, seenQuoteIds: Ids, missingCriteriaIds: Ids, reasonCode: Id }).strict()).max(24),
  lineage: M03TcmConclusionProposalSchema.shape.lineage,
  checks: z.array(z.object({ checker: Id, inputHash: Id, status: CheckStatusSchema }).strict()).max(40),
}).strict();
export type M03TcmConclusion = z.infer<typeof M03TcmConclusionSchema>;
type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
export type FrozenM03TcmConclusion = DeepReadonly<M03TcmConclusion & { conclusionHash: string }>;

export type M03TcmFactField = {
  fieldPath: string; text: string; scope: RecordQuote["scope"]; polarity: RecordQuote["polarity"];
  observation: RecordQuote["observation"];
};
/** The caller supplies governed IDs and mappings, never the proposal's own assessment. */
export type M03TcmUnitCandidate = {
  id: string; label: string; kind: "location" | "root" | "branch"; locationIds: string[];
  criteriaIds: string[]; criteriaName?: string;
};
export type M03TcmSyndromeCandidate = {
  name: string; locationIds: string[]; elementIds: string[]; neutral?: boolean;
  equivalentNames?: string[]; textbookRowId?: string; jingfangId?: string; compositeRuleId?: string;
};
export type M03TcmMethodCandidate = { id: string; text: string; targets: string[]; sourceId: string | null };
export type M03TcmDifferentialCandidate = { id: string; name: string; typicalManifestation: string };
export type M03TcmContext = {
  /** Sanitized facts from one fixed safeState snapshot; labels apply to the entire supplied span. */
  facts: M03TcmFactField[]; chiefComplaint: string;
  diseases: { name: string; diagnosisPoints: string[]; sourceId: string }[];
  units: M03TcmUnitCandidate[]; syndromes: M03TcmSyndromeCandidate[]; methods: M03TcmMethodCandidate[];
  differentials: { disease: M03TcmDifferentialCandidate[]; syndrome: M03TcmDifferentialCandidate[] };
  lineage: { code: string; label: string; targets: string[]; safetyDeference: string; unaffectedBySafety: string[] } | null;
  /** Read-only outputs of the existing deterministic layer. Never model-authored. */
  safety: { redFlag: boolean; context: string };
  findingsChecklist: string[];
};

export function m03TcmHash(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical)
    : item && typeof item === "object" ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, canonical(child)])) : item;
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex")}`;
}
export function deepFreezeM03<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreezeM03);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}
export const validM03TcmUnit = (unit: Pick<CheckedUnit, "status" | "strict">): boolean => unit.status === "pass" && unit.strict === true;
export const activeM03TcmUnits = (record: M03TcmConclusion | FrozenM03TcmConclusion) => [...record.locations, ...record.root, ...record.branch];

/** A sourceHint cannot disambiguate repeated source words or override annotated scope/polarity. */
export function locateM03TcmQuotes(proposal: M03TcmConclusionProposal, ctx: M03TcmContext): RecordQuote[] {
  return proposal.quotePool.flatMap(({ quote }, index) => {
    const hits = ctx.facts.flatMap((field) => {
      const found: RecordQuote[] = [];
      for (let start = field.text.indexOf(quote); start >= 0; start = field.text.indexOf(quote, start + 1)) {
        found.push({ id: `Q${index + 1}`, text: quote, fieldPath: field.fieldPath, start, end: start + quote.length,
          scope: field.scope, polarity: field.polarity, observation: field.observation });
      }
      return found;
    });
    return hits.length === 1 ? hits : [];
  });
}

export function parseM03TcmProposal(value: unknown, ctx: M03TcmContext): M03TcmConclusionProposal {
  const proposal = M03TcmConclusionProposalSchema.parse(value);
  const all = [...proposal.locations, ...proposal.elements.root, ...proposal.elements.branch];
  const require = (ok: boolean, code: string) => { if (!ok) throw new Error(code); };
  require(ctx.diseases.some((disease) => disease.name === proposal.disease.name), "disease_out_of_set");
  require([proposal.primary, ...proposal.secondary].every((name) => ctx.syndromes.some((syndrome) => syndrome.name === name)), "syndrome_out_of_set");
  require(new Set(all.map((unit) => unit.id)).size === all.length, "duplicate_unit");
  require(new Set(proposal.quotePool.map((item) => item.quote)).size === proposal.quotePool.length, "duplicate_quote");
  require(new Set([proposal.primary, ...proposal.secondary]).size === proposal.secondary.length + 1, "duplicate_syndrome");
  require(new Set(proposal.methods.map((method) => method.text)).size === proposal.methods.length, "duplicate_method");
  for (const [kind, units] of [["location", proposal.locations], ["root", proposal.elements.root], ["branch", proposal.elements.branch]] as const) {
    for (const unit of units) {
      const candidate = ctx.units.find((item) => item.id === unit.id && item.kind === kind);
      require(Boolean(candidate) && unit.criteria.every((id) => candidate!.criteriaIds.includes(id)), "unit_out_of_set");
    }
  }
  for (const indices of [proposal.disease.quotes, ...all.map((unit) => unit.quotes), ...proposal.methods.map((method) => method.quotes)]) {
    require(indices.every((index) => index < proposal.quotePool.length), "quote_index_out_of_range");
  }
  for (const method of proposal.methods) {
    const candidate = ctx.methods.find((item) => item.text === method.text);
    require(Boolean(candidate) && method.targets.length > 0 && method.targets.every((target) => candidate!.targets.includes(target) && all.some((unit) => unit.id === target)), "method_out_of_set");
  }
  require(!proposal.lineage || Boolean(ctx.lineage) && proposal.lineage.targets.every((id) => ctx.lineage!.targets.includes(id)), "lineage_out_of_set");
  return proposal;
}

export function assertM03TcmConclusion(record: M03TcmConclusion | FrozenM03TcmConclusion, ctx: M03TcmContext): void {
  const units = activeM03TcmUnits(record);
  const ids = new Set(units.map((unit) => unit.id));
  const quoteIds = new Set(record.quotes.map((quote) => quote.id));
  const fail = (condition: boolean) => { if (!condition) throw new Error("invalid_conclusion_closure"); };
  fail(ids.size === units.length && quoteIds.size === record.quotes.length);
  fail(units.every(validM03TcmUnit));
  fail(record.pending.every((item) => !ids.has(item.id)));
  fail(record.disease.status === "pass" && record.disease.quoteIds.length > 0);
  for (const quote of record.quotes) {
    const field = ctx.facts.find((item) => item.fieldPath === quote.fieldPath);
    fail(Boolean(field) && field!.text.slice(quote.start, quote.end) === quote.text && field!.scope === quote.scope && field!.polarity === quote.polarity && field!.observation === quote.observation);
  }
  const refs = (values: readonly string[]) => values.every((id) => quoteIds.has(id));
  fail(refs(record.disease.quoteIds));
  for (const unit of units) {
    const candidate = ctx.units.find((item) => item.id === unit.id);
    fail(Boolean(candidate) && candidate!.label === unit.label && refs(unit.quoteIds) && unit.quoteIds.length > 0);
    fail(new Set(unit.quoteIds).size === unit.quoteIds.length);
    fail(unit.quoteIds.every((id) => {
      const quote = record.quotes.find((item) => item.id === id)!;
      return quote.scope === "current" && quote.polarity === "affirmed" && quote.observation === "abnormal";
    }));
    fail(unit.locationIds.every((id) => record.locations.some((item) => item.id === id)));
  }
  const named = [record.primary, ...record.secondary];
  for (const syndrome of named) {
    const candidate = ctx.syndromes.find((item) => item.name === syndrome.name);
    fail(Boolean(candidate) && candidate!.elementIds.length === syndrome.elementIds.length && candidate!.locationIds.length === syndrome.locationIds.length);
    fail(candidate!.elementIds.every((id) => syndrome.elementIds.includes(id)) && candidate!.locationIds.every((id) => syndrome.locationIds.includes(id)));
    fail([...syndrome.locationIds, ...syndrome.elementIds].every((id) => ids.has(id)));
    fail(syndrome.elementIds.length > 0 || candidate!.neutral === true && syndrome.locationIds.length > 0);
  }
  fail([...record.root, ...record.branch].every((unit) => named.some((syndrome) => syndrome.elementIds.includes(unit.id))));
  for (const method of record.methods) {
    const candidate = ctx.methods.find((item) => item.id === method.id && item.text === method.text);
    fail(Boolean(candidate) && method.targets.length > 0 && method.targets.every((id) => ids.has(id) && candidate!.targets.includes(id)) && refs(method.quoteIds) && method.quoteIds.length > 0);
    fail(method.quoteIds.every((id) => record.quotes.some((quote) => quote.id === id && quote.scope === "current" && quote.polarity === "affirmed" && quote.observation === "abnormal")));
  }
  fail(record.methods.length > 0);
  fail(new Set(record.methods.map((method) => method.id)).size === record.methods.length);
  fail(record.primary.resolution !== "unresolved");
}

export function freezeM03TcmConclusion(record: M03TcmConclusion, ctx: M03TcmContext): FrozenM03TcmConclusion {
  const parsed = M03TcmConclusionSchema.parse(record);
  assertM03TcmConclusion(parsed, ctx);
  return deepFreezeM03({ ...parsed, conclusionHash: m03TcmHash(parsed) });
}
export function verifyFrozenM03TcmConclusion(record: FrozenM03TcmConclusion): boolean {
  const { conclusionHash, ...payload } = record;
  return conclusionHash === m03TcmHash(payload);
}

export function buildM03TcmConclusionPrompt(ctx: M03TcmContext, violations: readonly string[] = []): string {
  return [
    "M03 中医结论记录 v1。只输出给定 schema 的 JSON。先逐字引文，再条目与病位证素，再名称、治法方向；不写依据段、病机链、剂量、安全裁决。",
    "仅在给定闭集中选择。每项 quotes 是 quotePool 从0开始的整数索引。正常舌脉、药后反应、他人、将来条件、缺信息不算本次阳性；不得剪去否认范围。教材表现不是患者原文。未提及不等于没有。",
    "主诉及本次现病史优先，既往确诊只能支持相应发作。本虚标实来自条目证据，不从治法倒推；兼证须有独立成组证据。病性不足用给定中性证名，不造名字。流派只能解释已成立结论。",
    JSON.stringify({ context: ctx, violations }),
  ].join("\n");
}
