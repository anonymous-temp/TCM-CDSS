import { createHash } from "node:crypto";
import { z } from "zod";

/** Internal contracts only. No external DTO, safety decision or model transport lives here. */
const Id = z.string().min(1).max(100);
const Name = z.string().min(1).max(120);
const Ids = z.array(Id).max(40);
const Indices = z.array(z.number().int().min(0).max(15)).max(16);
const CriteriaIds = z.array(z.string().min(1).max(200)).max(40);
const UnitProposalSchema = z.object({ id: Id, quotes: Indices, criteria: CriteriaIds }).strict();
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
  id: Id, label: Name, locationIds: Ids, quoteIds: Ids, criteriaIds: CriteriaIds,
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
  id: string; label: string; aliases?: string[]; kind: "location" | "root" | "branch"; locationIds: string[];
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
  unconfirmedFollowupQuestions?: readonly string[];
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

/** Local repair of optional items never manufactures a clinical conclusion. */
export function parseM03TcmProposal(value: unknown, ctx: M03TcmContext, violations: string[] = []): M03TcmConclusionProposal {
  const raw = z.record(z.string(), z.unknown()).parse(value);
  for (const key of Object.keys(raw)) if (!(key in M03TcmConclusionProposalSchema.shape)) throw new Error("unexpected_proposal_key");
  const note = (code: string) => { if (!violations.includes(code)) violations.push(code); };
  const rows = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
  const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const quotePool: M03TcmConclusionProposal["quotePool"] = [];
  const quoteMap = new Map<number, number>();
  rows(raw.quotePool).slice(0, 16).forEach((item, index) => {
    const parsed = M03TcmConclusionProposalSchema.shape.quotePool.element.safeParse({ ...object(item), sourceHint: object(item).sourceHint ?? null });
    if (!parsed.success) { note("invalid_quote"); return; }
    let at = quotePool.findIndex(quote => quote.quote === parsed.data.quote);
    if (at < 0) { at = quotePool.length; quotePool.push(parsed.data); } else note("duplicate_quote");
    quoteMap.set(index, at);
  });
  const indices = (value: unknown) => [...new Set(rows(value).flatMap(index => {
    if (typeof index !== "number" || !Number.isInteger(index) || !quoteMap.has(index)) { note("quote_index_out_of_range"); return []; }
    return [quoteMap.get(index)!];
  }))];
  const disease = M03TcmConclusionProposalSchema.shape.disease.parse({ ...object(raw.disease), quotes: indices(object(raw.disease).quotes) });
  if (!ctx.diseases.some(candidate => candidate.name === disease.name)) throw new Error("disease_out_of_set");
  const syndrome = (name: unknown) => {
    if (typeof name !== "string") return undefined;
    const matches = ctx.syndromes.filter(candidate => candidate.name === name.trim() || candidate.equivalentNames?.includes(name.trim()));
    return matches.length === 1 ? matches[0].name : undefined;
  };
  const primary = syndrome(raw.primary);
  if (!primary) throw new Error("syndrome_out_of_set");
  const secondary = rows(raw.secondary).flatMap(name => {
    const mapped = syndrome(name);
    if (!mapped || mapped === primary) { note("secondary_out_of_set"); return []; }
    return [mapped];
  }).filter((name, i, all) => all.indexOf(name) === i).slice(0, 2);
  const resolveUnit = (name: unknown) => {
    if (typeof name !== "string") return undefined;
    const exact = ctx.units.find(candidate => candidate.id === name.trim());
    if (exact) return exact;
    const matches = ctx.units.filter(candidate => candidate.label === name.trim() || candidate.aliases?.includes(name.trim()));
    return matches.length === 1 ? matches[0] : undefined;
  };
  const seen = new Set<string>();
  const units = (value: unknown, kind: M03TcmUnitCandidate["kind"], limit: number) => rows(value).flatMap(item => {
    const entry = object(item), candidate = resolveUnit(entry.id);
    if (!candidate || candidate.kind !== kind) { note("unit_out_of_set"); return []; }
    if (seen.has(candidate.id)) { note("duplicate_unit"); return []; }
    const quotes = indices(entry.quotes);
    if (!quotes.length) { note("unit_without_quote"); return []; }
    const criteria = rows(entry.criteria).filter((id): id is string => typeof id === "string" && candidate.criteriaIds.includes(id));
    if (criteria.length !== rows(entry.criteria).length) note("criteria_out_of_set");
    if (candidate.id !== entry.id) note("unit_name_mapped");
    seen.add(candidate.id);
    return [{ id: candidate.id, quotes, criteria: [...new Set(criteria)] }];
  }).slice(0, limit);
  const locations = units(raw.locations, "location", 4);
  const elements = { root: units(object(raw.elements).root, "root", 8), branch: units(object(raw.elements).branch, "branch", 8) };
  const all = [...locations, ...elements.root, ...elements.branch];
  const methods = rows(raw.methods).flatMap(item => {
    const entry = object(item), candidate = ctx.methods.find(method => method.text === entry.text);
    if (!candidate) { note("method_out_of_set"); return []; }
    const targets = rows(entry.targets).flatMap(id => {
      const unit = resolveUnit(id);
      return unit && candidate.targets.includes(unit.id) && all.some(item => item.id === unit.id) ? [unit.id] : [];
    });
    const quotes = indices(entry.quotes);
    if (!targets.length || !quotes.length) { note("method_without_support"); return []; }
    return [{ text: candidate.text, targets: [...new Set(targets)], quotes }];
  }).filter((item, i, all) => all.findIndex(other => other.text === item.text) === i).slice(0, 5);
  const lens = M03TcmConclusionProposalSchema.shape.lineage.safeParse(raw.lineage ?? null);
  const lineage = lens.success && lens.data && ctx.lineage && lens.data.targets.every(id => ctx.lineage!.targets.includes(id)) ? lens.data : null;
  if (raw.lineage && !lineage) note("lineage_out_of_set");
  const proposal = M03TcmConclusionProposalSchema.parse({ disease, quotePool, locations, elements, primary, secondary, methods,
    direction: typeof raw.direction === "string" ? raw.direction.slice(0, 1200) : "", lineage });
  const grounded = new Set(locateM03TcmQuotes(proposal, ctx).map(quote => Number(quote.id.slice(1)) - 1));
  if (!all.some(unit => unit.quotes.some(index => grounded.has(index)))) throw new Error("core_evidence_missing");
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
    "编号规则：locations[].id只能取locationIds；elements.root[].id只能取rootIds；elements.branch[].id只能取branchIds。不得把病名、病机描述写作id。criteria只能逐字取该id的criteriaIds，不能改写。primary/secondary只能取syndromeNames，病名不可充当证名。methods.text只能取methodCandidates.text；targets只能引用已选units的id。无资料填空数组；未选流派填null。",
    JSON.stringify({ candidateIds: {
      diseaseNames: ctx.diseases.map(item => item.name), syndromeNames: ctx.syndromes.map(item => item.name),
      locationIds: ctx.units.filter(item => item.kind === "location").map(item => item.id),
      rootIds: ctx.units.filter(item => item.kind === "root").map(item => item.id),
      branchIds: ctx.units.filter(item => item.kind === "branch").map(item => item.id),
      unitCandidates: ctx.units, methodCandidates: ctx.methods,
    } }),
    '结构示意（占位符须换成候选值，不是病例答案）：{"disease":{"name":"<候选病名>","quotes":[0]},"quotePool":[{"quote":"<病历完整分句>","sourceHint":null}],"locations":[{"id":"<locationIds中的编号>","quotes":[0],"criteria":["<该编号的criteriaIds原文>"]}],"elements":{"root":[],"branch":[]},"primary":"<syndromeNames中的证名>","secondary":[],"methods":[],"direction":"","lineage":null}',
    ...(ctx.unconfirmedFollowupQuestions?.length ? ["未确认事项只有题干，不能引用为事实。依赖答案才能定下的证候要保留疑问，与其无关的判断照常。"] : []),
    JSON.stringify({ context: ctx, violations }),
  ].join("\n");
}
