import "server-only";
import { applyPatientClaimRemovals, decidePatientClaimRemovals, patientClaimRecordText, type PatientClaimRemoval } from "./m03-patient-claim-check.server";
import { trustedInputText, commaContinuedDenialReadingNotice } from "./diagnosis-safety";
import type { FinalRationaleContext } from "./m03-final-rationale-context.server";
import { rationaleLength, validateRationaleProse, type RationalePair, type RationaleVerdict } from "./m03-final-rationale-validation.server";

export type RationaleClaimCheck = (
  content: string, recordText: string, signal: AbortSignal, onNetworkAttempt: () => void,
) => Promise<PatientClaimRemoval[] | undefined>;
type ClaimCheckResult = {
  claimCheck: "checked" | "unavailable"; claimCalls: number; claimRemovals: number; verdict: RationaleVerdict;
};

const decide: RationaleClaimCheck = async (content, recordText, signal, onNetworkAttempt) => {
  let checked = false;
  const removals = await decidePatientClaimRemovals(content, {
    recordText, onNetworkAttempt, onChecked: () => { checked = true; },
  }, "tcm", signal);
  return checked ? removals : undefined;
};

/** Only the new pair is open to review. Any loss of required evidence rolls back the whole pair. */
export async function checkFinalRationaleClaims(
  draft: Extract<RationaleVerdict, { ok: true }>,
  context: FinalRationaleContext,
  signal: AbortSignal,
  check: RationaleClaimCheck = decide,
): Promise<ClaimCheckResult> {
  const content = { overview: { ...draft.pair } };
  const { state } = context;
  const recordText = [patientClaimRecordText(trustedInputText(state), state.patient, state.vitals),
    commaContinuedDenialReadingNotice(state).trim()].filter(Boolean).join("\n");
  let claimCalls = 0;
  let removals: PatientClaimRemoval[] | undefined;
  if (!signal.aborted) {
    let abort: (() => void) | undefined;
    const unavailable = new Promise<undefined>((resolve) => {
      abort = () => resolve(undefined);
      signal.addEventListener("abort", abort, { once: true });
    });
    try {
      removals = await Promise.race([
        unavailable,
        check(JSON.stringify(content), recordText, signal, () => { if (!signal.aborted) claimCalls++; }),
      ]);
    } catch {
      // The existing claim checker treats an unavailable model as an abstention.
    } finally {
      if (abort) signal.removeEventListener("abort", abort);
    }
  }
  if (!removals || signal.aborted) return { claimCheck: "unavailable", claimCalls, claimRemovals: 0, verdict: draft };
  const claimRemovals = applyPatientClaimRemovals(content, "tcm", removals, recordText, { deletionOnly: true });
  const verdict = claimRemovals ? validateAfterRemoval(content.overview, context) : draft;
  return { claimCheck: "checked", claimCalls, claimRemovals, verdict };
}

function validateAfterRemoval(pair: RationalePair, context: FinalRationaleContext): RationaleVerdict {
  const x = pair.tcmDiseaseRationale;
  const diagnostic = pair.tcmDiagnosticRationale;
  const boundary = context.input.lineage ? diagnostic.lastIndexOf("。", diagnostic.length - 2) + 1 : diagnostic.length;
  const y = diagnostic.slice(0, boundary);
  const l = diagnostic.slice(boundary) || null;
  if (rationaleLength(x) < 15 || rationaleLength(y) < 80) return { ok: false, reasons: [{ code: "claim_check_shortened", field: "$" }] };
  // The outline is unchanged. Recheck every hard rule that reads either revised paragraph.
  return validateRationaleProse({ x, y, l }, context);
}
