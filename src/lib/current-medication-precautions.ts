import policy from "../data/current-medication-claim-policy.source.json" with { type: "json" };
import { medicationHistoryItemCandidate, medicationOnlyPastMentions, medicationStopped, medicationStoppedInNextSentence, medicationNotTaken, splitMedicationList } from "./clinical-polarity";

const claim = new RegExp(policy.claimPattern, "gu");

/** 核对现用药清单的身份与时间状态，旧投影不能把已排除的药名再次当成现用药。 */
export function currentMedicationPrecautions(lines: readonly string[], recordText?: string): string[] {
  if (!recordText) return [...lines];
  return lines.filter((line) => [...line.matchAll(claim)].every((match) =>
    splitMedicationList(match[1]).every((raw) => {
      const { candidate, notCurrent } = medicationHistoryItemCandidate(raw);
      return Boolean(candidate) && !notCurrent && !medicationOnlyPastMentions(recordText, candidate) &&
        !medicationStopped(recordText, candidate) && !medicationStoppedInNextSentence(recordText, candidate) && !medicationNotTaken(recordText, candidate);
    })));
}
