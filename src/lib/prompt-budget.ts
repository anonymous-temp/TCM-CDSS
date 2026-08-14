const EVIDENCE_OMISSION_MARKER = "\n\n【证据上下文预算裁剪】中间的低优先级检索文本已省略；仅可引用本提示中仍完整可见的条目。\n\n";

export type PromptEvidenceBudget = {
  text: string;
  truncated: boolean;
  omittedChars: number;
};

function lineBoundaryBefore(text: string, target: number): number {
  const boundary = text.lastIndexOf("\n", target);
  return boundary >= Math.floor(target / 2) ? boundary : target;
}

function lineBoundaryAfter(text: string, target: number): number {
  const boundary = text.indexOf("\n", target);
  return boundary >= 0 && boundary - target <= Math.max(200, Math.floor((text.length - target) / 2))
    ? boundary + 1
    : target;
}

/**
 * Keep evidence inside the model prompt budget without silently discarding an entire authority tier.
 *
 * Evidence is ordered with official/local rules first and external case-bound results later. Keeping
 * both ends preserves those two independent trust anchors. Cuts prefer newline boundaries so an ID,
 * title or URL is not normally split into a misleading partial citation. The returned text is also
 * the only text that may be used to build the output citation whitelist.
 */
export function compactEvidenceContextForPrompt(
  evidenceContext: string,
  maxChars: number,
): PromptEvidenceBudget {
  const source = String(evidenceContext || "");
  const limit = Math.max(0, Math.floor(maxChars));
  if (source.length <= limit) return { text: source, truncated: false, omittedChars: 0 };
  if (limit === 0) return { text: "", truncated: true, omittedChars: source.length };
  if (limit <= EVIDENCE_OMISSION_MARKER.length + 40) {
    const text = source.slice(0, limit);
    return { text, truncated: true, omittedChars: source.length - text.length };
  }

  const contentBudget = limit - EVIDENCE_OMISSION_MARKER.length;
  const desiredHead = Math.floor(contentBudget * 0.6);
  const desiredTail = contentBudget - desiredHead;
  const headEnd = lineBoundaryBefore(source, desiredHead);
  const tailStart = lineBoundaryAfter(source, source.length - desiredTail);

  if (headEnd >= tailStart) {
    const text = source.slice(0, limit);
    return { text, truncated: true, omittedChars: source.length - text.length };
  }
  const head = source.slice(0, headEnd).trimEnd();
  const tail = source.slice(tailStart).trimStart();
  const text = `${head}${EVIDENCE_OMISSION_MARKER}${tail}`.slice(0, limit);
  return { text, truncated: true, omittedChars: source.length - head.length - tail.length };
}
