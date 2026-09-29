import functionContextGatesJson from "../data/tcm-herb-function-context-gates.source.json" with { type: "json" };

/**
 * 药味功效条目是否适用于本例（2026-09-29，甲方测评 2.1「药味功效错误」）。
 *
 * 症状专指型功效（调经、利咽、止咳、通便、安神…）只有在本例上下文出现对应症状/病位时才可选用；
 * 病机层功效（补气、清热、活血…）不设门。词表见 tcm-herb-function-context-gates.source.json。
 * 只做排除、不造文字：被排除的条目仍在药味库里。
 */
type ContextGate = { functionTerms: readonly string[]; contextTerms: readonly string[] };

const CONTEXT_GATES: readonly ContextGate[] = (functionContextGatesJson as { entries: ContextGate[] }).entries
  .filter((entry) => entry.functionTerms.length > 0 && entry.contextTerms.length > 0);

export function herbFunctionClauseFitsContext(clause: string, context: string): boolean {
  const compactClause = clause.replace(/\s+/g, "");
  const compactContext = context.replace(/\s+/g, "");
  for (const gate of CONTEXT_GATES) {
    if (!gate.functionTerms.some((term) => compactClause.includes(term))) continue;
    if (!gate.contextTerms.some((term) => compactContext.includes(term))) return false;
  }
  return true;
}

/** 使药（及调和/引经类结构位）应先取的功效条目：调和诸药、引经、载药上行。 */
export function isHarmonizingOrGuidingFunction(clause: string): boolean {
  return ["调和", "引经", "引药", "载药", "缓和药性"].some((term) => clause.includes(term));
}
