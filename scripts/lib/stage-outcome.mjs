/**
 * One definition of "did this stage actually produce a clinical result".
 *
 * Why this module exists. Every eval harness has to answer the same question, and getting it wrong
 * is silent: HTTP 200 with a stream that terminated cleanly looks like success at the transport
 * layer even when the doctor received a refusal page. A harness that scored on `res.ok` recorded a
 * run where M04 produced no prescription at all — and where M05 and the rx-audit were consequently
 * skipped — as three consecutive `ok: true`. Any "M04 pass rate" derived that way is measuring
 * whether the server answered, not whether a prescription exists.
 *
 * The semantics below are the ones documented in scripts/regress-real-100-evaluate.mjs. They live
 * here so a new harness inherits them instead of re-deriving them, and so they are covered by
 * scripts/test-stage-outcome.mjs rather than by reviewer attention.
 *
 * Deliberately dependency-free and content-only: it classifies a stage's assembled text, so it
 * works for live HTTP harnesses and for replaying recorded artifacts alike.
 */

export const START_MARKER = "<!-- DIAGNOSIS_JSON_START -->";
export const END_MARKER = "<!-- DIAGNOSIS_JSON_END -->";
export const NON_DOSE_MARKER = "<!-- CDSS_NON_DOSE_PRESCRIPTION -->";
export const STREAM_REPLACE_MARKER = "<<<CDSS_STREAM_FINAL>>>";

/** Evidence sources the server stamps on a deterministically degraded M03. */
const SIGNED_LIMITED_SOURCES = new Set([
  "服务端M03有限结果门禁",
  "服务端急危重安全门禁",
]);

/** Extract the reasoning-v2 payload for a stage, or null when the sentinel block is absent/invalid. */
export function extractStageReasoning(content, stage) {
  const text = String(content || "");
  const start = text.lastIndexOf(START_MARKER);
  const end = start >= 0 ? text.indexOf(END_MARKER, start + START_MARKER.length) : -1;
  if (start < 0 || end < 0) return null;
  try {
    const parsed = JSON.parse(text.slice(start + START_MARKER.length, end).trim());
    if (parsed?.schemaVersion === "tcm-cdss-reasoning-v2" && parsed.stage === stage) return parsed;
  } catch {
    return null;
  }
  return null;
}

/**
 * A signed-limited M03 carries a signature but no usable differentiation: the syndrome is
 * unresolved AND the pathogenesis chain is empty. It is a deterministic gate output, not a
 * diagnosis, and must never be counted as a complete M03.
 */
export function isSignedLimitedM03(reasoning) {
  if (!reasoning || typeof reasoning !== "object") return false;
  const overview = reasoning.overview || {};
  const chain = reasoning.pathogenesis?.chain;
  const chainEmpty = !Array.isArray(chain) || chain.length === 0;
  if (overview.primarySyndromeResolution !== "unresolved" || !chainEmpty) return false;
  const source = overview.evidence?.source;
  // The evidence stamp is the authoritative marker, but an unresolved+empty-chain payload is a
  // limited result regardless of how it was stamped — never upgrade it on a missing source.
  return typeof source !== "string" || source.trim() === "" || SIGNED_LIMITED_SOURCES.has(source.trim());
}

/**
 * Classify M03. `complete` requires a real differentiation, not merely a well-formed response.
 * Returns one of: "complete" | "signed_limited" | "unparsable" | "error".
 */
export function classifyM03(content, { transportOk = true } = {}) {
  if (!transportOk) return "error";
  const reasoning = extractStageReasoning(content, "diagnose");
  if (!reasoning) return "unparsable";
  return isSignedLimitedM03(reasoning) ? "signed_limited" : "complete";
}

/**
 * Classify M04. `dose_level` requires at least one candidate herb carrying a concrete dose —
 * the only outcome from which a prescription, an rx-audit and M05 can actually follow.
 * Returns one of: "dose_level" | "non_dose" | "unparsable" | "error".
 */
export function classifyM04(content, { transportOk = true } = {}) {
  if (!transportOk) return "error";
  const text = String(content || "");
  if (text.includes(NON_DOSE_MARKER)) return "non_dose";
  const reasoning = extractStageReasoning(content, "prescribe");
  if (!reasoning) return "unparsable";
  const candidates = reasoning.formula?.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return "non_dose";
  const hasDosedHerb = candidates.some((candidate) => (candidate?.herbs || [])
    .some((herb) => typeof herb?.dose === "string" && /\d/.test(herb.dose)));
  return hasDosedHerb ? "dose_level" : "non_dose";
}

/**
 * Whether the downstream stages (M05 assess, post-prescription rx-audit) are reachable at all.
 * A harness that skips them because M04 degraded must record the skip as a CONSEQUENCE of the
 * M04 failure — never as an independent success.
 */
export function downstreamReachable(m04Classification) {
  return m04Classification === "dose_level";
}

/**
 * Roll a set of per-case classifications into the numbers worth reporting. `clinicalSuccessRate`
 * is deliberately the headline: it is the fraction of cases that yielded a usable prescription,
 * which is what "does this product work" means.
 */
export function summarizeOutcomes(cases) {
  const rows = [...cases];
  const count = (predicate) => rows.filter(predicate).length;
  const total = rows.length;
  const doseLevel = count((row) => row.m04 === "dose_level");
  return {
    total,
    m03: {
      complete: count((row) => row.m03 === "complete"),
      signedLimited: count((row) => row.m03 === "signed_limited"),
      unparsable: count((row) => row.m03 === "unparsable"),
      error: count((row) => row.m03 === "error"),
    },
    m04: {
      doseLevel,
      nonDose: count((row) => row.m04 === "non_dose"),
      unparsable: count((row) => row.m04 === "unparsable"),
      error: count((row) => row.m04 === "error"),
    },
    // Transport success is reported separately so it can never be mistaken for the headline.
    transportSuccessRate: total === 0 ? 0 : Number((count((row) => row.m04 !== "error") / total).toFixed(4)),
    clinicalSuccessRate: total === 0 ? 0 : Number((doseLevel / total).toFixed(4)),
  };
}
