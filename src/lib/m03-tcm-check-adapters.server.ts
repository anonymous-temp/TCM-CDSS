import "server-only";
import { z } from "zod";
import { criteriaItemsFor, diagnosticsCriteriaFor } from "./m03-secondary-syndrome-consistency.server";
import type { M03TcmCheckInput, M03TcmConclusionCheckIO } from "./m03-tcm-conclusion-checks.server";
import type { FormulaReferenceCaseSafety } from "./tcm-formula-provenance";

const UnitSchema = z.object({ id: z.string(), status: z.enum(["matched", "fail", "unknown"]),
  matches: z.array(z.object({ item: z.string(), quoteId: z.string() }).strict()).max(40) }).strict();
const DiseaseSchema = z.object({ checker: z.enum(["visit_reason", "history", "disease_points"]),
  status: z.enum(["pass", "fail", "unknown", "not_applicable"]), replacement: z.string().nullable(), quoteIds: z.array(z.string()).max(16) }).strict();
const MethodSchema = z.object({ id: z.string(), status: z.enum(["pass", "fail", "unknown"]) }).strict();
const LineageSchema = z.object({ status: z.enum(["pass", "fail", "unknown"]) }).strict();
const VerifySchema = z.object({ confirmations: z.array(z.object({ id: z.string(), confirmed: z.boolean() }).strict()).max(200) }).strict();
export type M03TcmCheckKind = "units" | "disease" | "methods" | "lineage";
export type M03TcmCheckTransport = {
  /** P5 binds proposer to the primary family and verifier to the other configured family. No fallback-as-pass. */
  completeCheck: (request: { kind: M03TcmCheckKind; phase: "propose" | "verify"; prompt: string;
    schema: Record<string, unknown>; maxTokens: number; signal: AbortSignal; absoluteDeadline: number }) => Promise<{ value: unknown; finishReason: string }>;
};
const unpack = (value: unknown) => typeof value === "string" ? JSON.parse(value) : value;

/** Direct transport adapters: P5 only supplies model IO and the existing S1 checkers. */
export function createM03TcmConclusionModelChecks(transport: M03TcmCheckTransport, caseSafety: FormulaReferenceCaseSafety): M03TcmConclusionCheckIO {
  const ask = async <T>(kind: M03TcmCheckKind, input: M03TcmCheckInput, schema: z.ZodType<T>, rules: string, signal: AbortSignal, absoluteDeadline: number) => {
    const units = [...input.proposal.locations, ...input.proposal.elements.root, ...input.proposal.elements.branch].map((unit) => {
      const candidate = input.context.units.find((item) => item.id === unit.id)!;
      const entry = candidate.criteriaName ? diagnosticsCriteriaFor(candidate.criteriaName) : undefined;
      return { ...unit, candidate, entry: entry ? { ...entry, items: criteriaItemsFor(entry) } : null };
    });
    const prompt = ["m03-tcm-checks-v1", rules, "只输出给定JSON schema。未知不能答通过。逐字引用仅用输入Q编号；他人、历史、否认、正常观察不能支持本次病性。每个单位单独作答。",
      JSON.stringify({ disease: input.proposal.disease, primary: input.proposal.primary, secondary: input.proposal.secondary,
        quotes: input.quotes, units, methods: input.proposal.methods, lineage: input.proposal.lineage, context: input.context })].join("\n");
    const result = await transport.completeCheck({ kind, phase: "propose", prompt, schema: z.toJSONSchema(schema), maxTokens: kind === "units" ? 650 : 400, signal, absoluteDeadline });
    if (result.finishReason !== "stop") throw new Error("incomplete_check");
    let value = unpack(result.value);
    if (kind === "units" && value && typeof value === "object" && Array.isArray(value.units)) {
      // Isolate malformed item replies; a bad factor must not erase a valid sibling.
      value = { ...value, units: value.units.filter((item: unknown) => UnitSchema.safeParse(item).success) };
    }
    return { result: schema.parse(value), prompt };
  };
  const verify = async (kind: M03TcmCheckKind, prompt: string, claims: { id: string; claim: unknown }[], signal: AbortSignal, absoluteDeadline: number) => {
    if (claims.length === 0) return new Set<string>();
    const result = await transport.completeCheck({ kind, phase: "verify", prompt: [
      "逐条核对提名的窄结论是否确实由输入支持，只答对应id和confirmed。拒绝无据推断、把未知当通过、引用真实但不支持该条目、正常观察当病性。不得重新诊断或新增匹配。",
      prompt, JSON.stringify({ claims }),
    ].join("\n"), schema: z.toJSONSchema(VerifySchema), maxTokens: 500, signal, absoluteDeadline });
    if (result.finishReason !== "stop") throw new Error("incomplete_verification");
    const confirmations = VerifySchema.parse(unpack(result.value)).confirmations;
    return new Set(confirmations.filter((item) => item.confirmed && confirmations.filter((other) => other.id === item.id).length === 1 && claims.some((claim) => claim.id === item.id)).map((item) => item.id));
  };
  const envelope = <T>(input: M03TcmCheckInput, result: T) => ({ baseRevision: input.baseRevision, inputHash: input.inputHash, result });
  return {
    caseSafety,
    checkUnits: async (input, signal, deadline) => {
      const schema = z.object({ units: z.array(UnitSchema).max(20) }).strict();
      const proposed = await ask("units", input, schema, "只做quote→候选条目语义匹配；item必须逐字选输入条目，不输出病名、评分或充分性。病位必须核实定位关系，主证不得扣掉自己的表现。", signal, deadline);
      const claims = proposed.result.units.flatMap((unit, i) => unit.matches.map((match, j) => ({ id: `U${i}M${j}`, claim: { unitId: unit.id, ...match } })));
      const accepted = await verify("units", proposed.prompt, claims, signal, deadline);
      return envelope(input, proposed.result.units.map((unit, i) => ({ ...unit, matches: unit.matches.filter((_, j) => accepted.has(`U${i}M${j}`)) })));
    },
    checkDisease: async (input, signal, deadline) => {
      const schema = z.object({ diseases: z.array(DiseaseSchema).max(3) }).strict();
      const proposed = await ask("disease", input, schema, "分别核本次病名是否解释来诊原因、是否与教材要点矛盾、是否违背本次相关的唯一既往确诊病约束。明确矛盾为fail并引反证Q；替代病只能闭集选。主诉本已点名可not_applicable；缺要点或调用不可用是unknown，不是fits。", signal, deadline);
      const accepted = await verify("disease", proposed.prompt, proposed.result.diseases.map((claim, i) => ({ id: `D${i}`, claim })), signal, deadline);
      return envelope(input, proposed.result.diseases.map((row, i) => accepted.has(`D${i}`) ? row : { ...row, status: "unknown" as const }));
    },
    checkMethods: async (input, signal, deadline) => {
      const schema = z.object({ methods: z.array(MethodSchema).max(5) }).strict();
      const proposed = await ask("methods", input, schema, "逐个核原子治法与已提证素及其引用的对应关系；治法不能逆推新增证素，不能治疗否认或未载表现，不能越过既有安全边界。id只能选context.methods。", signal, deadline);
      const accepted = await verify("methods", proposed.prompt, proposed.result.methods.map((claim, i) => ({ id: `M${i}`, claim })), signal, deadline);
      return envelope(input, proposed.result.methods.map((row, i) => accepted.has(`M${i}`) ? row : { ...row, status: "unknown" as const }));
    },
    checkLineage: async (input, signal, deadline) => {
      const proposed = await ask("lineage", input, LineageSchema, "只核流派适用性及targets能否由本次事实支持；允许partial，不另下病名、病性或安全裁决。不适配的判断也要真实，不能凭所选流派强行套证。", signal, deadline);
      const accepted = await verify("lineage", proposed.prompt, [{ id: "L", claim: proposed.result }], signal, deadline);
      return envelope(input, { status: accepted.has("L") ? proposed.result.status : "unknown" });
    },
  };
}
