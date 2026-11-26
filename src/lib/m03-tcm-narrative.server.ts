import "server-only";
import { verifyFrozenM03TcmConclusion, activeM03TcmUnits, type FrozenM03TcmConclusion, type M03TcmContext } from "./m03-tcm-conclusion";
import { M03TcmNarrativeSchema, M03_TCM_NARRATIVE_PROVIDER_SCHEMA, type M03TcmNarrative, type NarrativeViolation } from "./m03-tcm-narrative";
import { withinM03TcmBudget } from "./m03-tcm-conclusion-checks.server";

export type M03TcmModelTask = "m03_tcm_conclusion" | "m03_tcm_narrative";
export type M03TcmModelRequest = {
  task: M03TcmModelTask; prompt: string; schema: Record<string, unknown>; maxTokens: number;
  signal: AbortSignal; absoluteDeadline: number;
};
export type M03TcmModelResponse = { value: unknown; finishReason: string; usage?: { completionTokens: number; promptTokens: number } };
/** P5 implements existing transport/schema recovery/strict fallback inside this one callback. */
export type M03TcmModelIO = { complete: (request: M03TcmModelRequest) => Promise<M03TcmModelResponse> };
export function buildM03TcmNarrativePrompt(conclusion: FrozenM03TcmConclusion, ctx: M03TcmContext, violations: readonly NarrativeViolation[] = []): string {
  const expanded = activeM03TcmUnits(conclusion).map((unit) => ({ ...unit, quotes: unit.quoteIds.map((id) => conclusion.quotes.find((quote) => quote.id === id)) }));
  return [
    "M03 中医文字 v1。只按冻结结论写给定 schema 的完整句，不重新辨病辨证或改治法方向。每句 id 唯一并引用 Q 引文及已成立 unitIds；chain 另列 factQuoteIds/evidenceQuoteIds/methodIds/dependsOn。",
    "一次写辨病依据、辨证依据、总体病机、链、真正尚缺的信息及鉴别；总体病机与链同源。不得补写病历未载的久则/先后因果，不得把正常观察当虚实依据，不得用耗伤阴津等同义语引入待核实证素。",
    "待核实的 pendingId 必须来自冻结记录，已记录或否认的项目不写未记录。鉴别仅选给定 candidateId，典型表现由服务端取原文；reason/distinguishingPoints区分本例与参考知识。病名鉴别尽量2项，证型鉴别可为空，不凑无关病。",
    "病位/病性轴、治则、总治法、方名、出处、安全裁决都由服务端给定，不输出这些键。流派只引用冻结 targets，不另立病性，不选未交付的方。无流派写null。",
    "流派视角与influencedDecisions点名采用的方必须等于最终交付方；未采用的方须明确写未用。选择经方流派却交付非经方时，须按本例表现解释经方候选为何没有方证相合者，再说明实际选方，不得只写部分适配；没有冻结依据时少说，不编造方证。",
    "句子必须完整，删去一句后剩余句仍可独立阅读；明确因果依赖的链节点在 dependsOn 引前序节点id。主诉和有意义舌脉应解释，但不要求每个伴随表现都立证。",
    JSON.stringify({ conclusion, expanded, unconfirmedFollowupQuestions: ctx.unconfirmedFollowupQuestions, facts: ctx.facts, findingsChecklist: ctx.findingsChecklist, differentials: ctx.differentials, lineage: ctx.lineage, violations }),
  ].join("\n");
}
export async function authorM03TcmNarrative(
  conclusion: FrozenM03TcmConclusion, ctx: M03TcmContext, io: M03TcmModelIO,
  signal: AbortSignal, absoluteDeadline: number, violations: readonly NarrativeViolation[] = [],
): Promise<M03TcmNarrative | undefined> {
  if (!verifyFrozenM03TcmConclusion(conclusion)) throw new Error("conclusion_hash_changed");
  try {
    const response = await withinM03TcmBudget((child) => io.complete({ task: "m03_tcm_narrative", prompt: buildM03TcmNarrativePrompt(conclusion, ctx, violations),
      schema: M03_TCM_NARRATIVE_PROVIDER_SCHEMA, maxTokens: 1600, signal: child, absoluteDeadline }), signal, absoluteDeadline);
    if (response.finishReason !== "stop") return undefined;
    const parsed = M03TcmNarrativeSchema.safeParse(typeof response.value === "string" ? JSON.parse(response.value) : response.value);
    return parsed.success ? parsed.data : undefined;
  } catch { signal.throwIfAborted(); return undefined; }
}
