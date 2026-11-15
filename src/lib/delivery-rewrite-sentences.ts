/** Local sentence boundaries use JS UTF-16 offsets. Commas remain inside a sentence. */
import type { DeliveryCandidate, RewriteEvent, SentenceChange, SentenceSpan } from "./delivery-gate-types";
import { deliveryTextLeaves, rewriteTextHash } from "./delivery-rewrite-ledger";

export function localSentenceSpans(text: string): SentenceSpan[] {
  const spans: SentenceSpan[] = [];
  let start = 0;
  const stack: string[] = [];
  const closing: Record<string, string> = { "）": "（", ")": "(", "”": "“", "’": "‘", "」": "「", "』": "『" };
  for (let i = 0; i < text.length; i++) {
    if ("（(“‘「『".includes(text[i])) stack.push(text[i]);
    else if (closing[text[i]] && stack[stack.length - 1] === closing[text[i]]) stack.pop();
    if (stack.length) continue;
    if (!/[。！？!?；;\n]/u.test(text[i])) continue;
    let end = i + 1;
    while (end < text.length && /[”’」』）)]/u.test(text[end])) end++;
    if (text.slice(start, end).trim()) spans.push({ start, end, text: text.slice(start, end) });
    start = end; i = end - 1;
  }
  if (start < text.length && text.slice(start).trim()) spans.push({ start, end: text.length, text: text.slice(start) });
  return spans;
}

/** Follow sentence occurrences through intermediate field versions for rule statistics. */
function sentenceEventLineage(events: readonly RewriteEvent[]): Set<string>[] {
  let priorText = events[0]?.before || "";
  let lineage = localSentenceSpans(priorText).map(() => new Set<string>());
  for (const event of events) {
    const before = localSentenceSpans(event.before); const after = localSentenceSpans(event.after);
    if (event.before !== priorText) lineage = before.map(() => new Set(events.slice(0, events.indexOf(event)).map(e => e.eventId)));
    const used = new Set<number>(); const pairs = new Map<number, number>();
    after.forEach((span, j) => {
      const i = before.findIndex((s, k) => !used.has(k) && s.text === span.text);
      if (i >= 0) { used.add(i); pairs.set(j, i); }
    });
    const changedBefore = before.flatMap((_, i) => used.has(i) ? [] : [i]);
    const changedAfter = after.flatMap((_, j) => pairs.has(j) ? [] : [j]);
    lineage = after.map((_, j) => {
      const unchanged = pairs.get(j);
      if (unchanged !== undefined) return new Set(lineage[unchanged]);
      const sourceIndices = changedBefore.length === changedAfter.length ? [changedBefore[changedAfter.indexOf(j)]] : changedBefore;
      return new Set([...sourceIndices.flatMap(i => [...(lineage[i] || [])]), event.eventId]);
    });
    priorText = event.after;
  }
  return lineage;
}

/**
 * Inspect changed final sentences once, with both neighbours as context. A deleted
 * field produces a tombstone, never a candidate for restoring removed content.
 * All intermediate events remain attached; matching identical sentences consumes
 * occurrences separately rather than deduplicating by text.
 */
export function changedSentenceUnits(ledger: readonly RewriteEvent[], final: DeliveryCandidate): SentenceChange[] {
  const stages = [...new Set(ledger.map(e => e.stage))];
  const leaves = new Map<string, string>();
  for (const stage of stages) for (const pair of deliveryTextLeaves(final.payload, `/${stage}`)) leaves.set(...pair);
  if (final.visible !== undefined) leaves.set("/visible", final.visible);
  const grouped = new Map<string, RewriteEvent[]>();
  for (const event of ledger) {
    if (event.observationOnly || event.before === event.after) continue;
    const group = grouped.get(event.occurrenceId) || []; group.push(event); grouped.set(event.occurrenceId, group);
  }
  const out: SentenceChange[] = [];
  for (const [occurrenceId, events] of grouped) {
    const first = events[0]; const last = events[events.length - 1];
    const path = last.path; const finalText = leaves.get(path);
    // A stale or missing final field is unknown to integration, never silently passed.
    const text = last.tombstone ? "" : finalText ?? "";
    const beforeSpans = localSentenceSpans(first.before);
    const afterSpans = localSentenceSpans(text);
    const lineage = sentenceEventLineage(events);
    const used = new Set<number>();
    const matchedAfter = new Map<number, number>();
    const changed: number[] = [];
    for (let i = 0; i < afterSpans.length; i++) {
      const at = beforeSpans.findIndex((s, j) => !used.has(j) && s.text === afterSpans[i].text);
      if (at >= 0) { used.add(at); matchedAfter.set(at, i); } else changed.push(i);
    }
    const base = { path, occurrenceId, textHash: rewriteTextHash(text), before: first.before, events, protected: events.some(e => e.protected),
      stale: !last.tombstone && (finalText === undefined || last.after !== finalText) };
    for (const i of changed) out.push({ ...base, ...afterSpans[i], sentenceId: `${occurrenceId}:${afterSpans[i].start}`,
      events: base.stale ? events : events.filter(e => lineage[i]?.has(e.eventId)),
      previous: afterSpans[i - 1]?.text, next: afterSpans[i + 1]?.text });
    if (beforeSpans.some((_, j) => !used.has(j)) && !changed.length) {
      // Deletion-only: check the join using the retained neighbours; do not revive before.
      for (let j = 0; j < beforeSpans.length; j++) {
        if (used.has(j)) continue;
        const firstDeleted = j;
        while (j + 1 < beforeSpans.length && !used.has(j + 1)) j++;
        const left = matchedAfter.get(firstDeleted - 1); const right = matchedAfter.get(j + 1);
        const offset = right !== undefined ? afterSpans[right].start : left !== undefined ? afterSpans[left].end : 0;
        out.push({ ...base, sentenceId: `${occurrenceId}:deleted:${beforeSpans[firstDeleted].start}`, start: offset, end: offset, text: "", deleted: true,
          previous: left === undefined ? undefined : afterSpans[left].text, next: right === undefined ? undefined : afterSpans[right].text });
      }
    }
  }
  return out;
}

/** Guard an edit at application time even if an earlier writer changed the text. */
export function applyIntegrityTextEdits(text: string, edits: readonly { start: number; end: number; textHash: string; expectedText: string; replacement: string }[]): string | undefined {
  const ordered = [...edits].sort((a, b) => b.start - a.start);
  let previousStart = text.length;
  for (const edit of ordered) {
    if (edit.textHash !== rewriteTextHash(text) || edit.start < 0 || edit.end < edit.start || edit.end > previousStart ||
      text.slice(edit.start, edit.end) !== edit.expectedText) return undefined;
    previousStart = edit.start;
  }
  let out = text;
  for (const edit of ordered) out = out.slice(0, edit.start) + edit.replacement + out.slice(edit.end);
  return out;
}
