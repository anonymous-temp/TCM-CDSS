import "server-only";
import { buildTrustedRecordIndex } from "./delivery-trusted-record.server";
import { clinicalClausePolarity, clinicalEventTemporalScopeAt } from "./clinical-polarity";
import { recordMentionPolarityAt, clauseLocalMentionPolarityAt, normalizeClinicalText } from "./diagnosis-safety";
import { withoutNormalFindingSegments } from "./diagnosis-visible-summary";
import type { CaseState } from "./diagnosis-types";
import type { M03TcmFactField } from "./m03-tcm-conclusion";

/** Original UTF-16 spans stay intact; existing ConText readers own the interpretation.
 * No additional model call, new clinical lexicon or change to the safety gate.
 */
export function deterministicM03TcmFacts(state: CaseState): M03TcmFactField[] {
  const facts: M03TcmFactField[] = [];
  for (const source of buildTrustedRecordIndex(state).sources) {
    for (const match of source.text.matchAll(/[^，,。；;\n！？!?]+/gu)) {
      const text = match[0].trim();
      if (text.length < 2) continue;
      const start = match.index + match[0].indexOf(text);
      // The safety reader's normalization preserves UTF-16 offsets. Use the end
      // of the assertion so prefix scope is visible, retaining hard field boundaries.
      const normalized = normalizeClinicalText(source.text);
      const at = start + text.length - 1;
      const mention = recordMentionPolarityAt(normalized, at);
      const local = clauseLocalMentionPolarityAt(normalized, at);
      const clause = clinicalClausePolarity(text);
      const temporalText = source.text.normalize("NFKC").replace(/\r\n?/gu, "\n");
      const temporalAt = source.text.slice(0, start + text.length).normalize("NFKC").replace(/\r\n?/gu, "\n").length - 1;
      const temporal = clinicalEventTemporalScopeAt(temporalText, temporalAt, 1);
      const scope = source.role === "demographics" || source.role === "mixed" || mention === "excluded" ? "other"
        : source.role === "history" || temporal !== "current" ? "history" : "current";
      const polarity = clause === "uncertain" || mention === "excluded" || local === "excluded" ? "unknown"
        : clause === "negative" || mention === "negated" || local === "negated" ? "denied" : "affirmed";
      const observation = !withoutNormalFindingSegments(text) ? "normal"
        : polarity === "affirmed" && scope === "current" ? "abnormal" : "unknown";
      facts.push({ fieldPath: `${source.sourcePath}#${start}`, text, scope, polarity, observation });
    }
  }
  // Duplicate HIS/structured copies with identical scope are one fact. Conflicting
  // scopes remain separate, so quote location remains ambiguous and fails closed.
  return facts.filter((fact, index) => facts.findIndex(other => other.text === fact.text &&
    other.scope === fact.scope && other.polarity === fact.polarity && other.observation === fact.observation) === index);
}
