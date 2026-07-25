import "server-only";

import {
  enrichPrescriptionProvenance as enrichPrescriptionProvenanceCore,
  enrichReasoning as enrichReasoningCore,
} from "./tcm-formula-provenance";
import { classicEvidenceForFormulaNames } from "./tcm-classic-evidence.server";

export function enrichReasoning(
  ...args: Parameters<typeof enrichReasoningCore>
): ReturnType<typeof enrichReasoningCore> {
  return enrichReasoningCore(args[0], args[1], classicEvidenceForFormulaNames);
}

export function enrichPrescriptionProvenance(
  ...args: Parameters<typeof enrichPrescriptionProvenanceCore>
): ReturnType<typeof enrichPrescriptionProvenanceCore> {
  return enrichPrescriptionProvenanceCore(args[0], args[1], classicEvidenceForFormulaNames);
}
