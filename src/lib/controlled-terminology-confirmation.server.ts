import "server-only";

import {
  normalizeReasoningV2,
  type CaseState,
  type ClinicalReasoningResultV2,
  type ControlledTerminologyMappingTrace,
} from "./diagnosis-types";
import {
  buildDiagnoseContractSignatureContext,
  signDiagnoseReasoning,
  verifyDiagnoseReasoningSignature,
} from "./reasoning-contract-signature";
import { namedFormulaPositiveSufficiencyIssue } from "./tcm-formula-indications";

export type ConfirmableTerminologyMapping = Pick<
  ControlledTerminologyMappingTrace,
  "namespace" | "fieldPath" | "candidateId"
>;

export type ControlledTerminologyConfirmationResult =
  | { ok: true; reasoning: ClinicalReasoningResultV2; restoredFormulaNames: string[] }
  | { ok: false; status: 400 | 409; code: string; error: string };

function confirmationTargetAllowed(mapping: ConfirmableTerminologyMapping): boolean {
  return (
    mapping.namespace === "tcm_syndrome" &&
    mapping.fieldPath === "overview.primarySyndrome"
  ) || (
    mapping.namespace === "icd10" &&
    mapping.fieldPath === "westernDiagnosis.primary.name"
  );
}

export function confirmControlledTerminologyMapping(
  caseState: CaseState,
  requested: ConfirmableTerminologyMapping,
): ControlledTerminologyConfirmationResult {
  if (!confirmationTargetAllowed(requested)) {
    return {
      ok: false,
      status: 400,
      code: "terminology_confirmation_target_not_allowed",
      error: "Only the primary syndrome or primary ICD-10 suggestion can be explicitly confirmed.",
    };
  }
  const current = normalizeReasoningV2(
    caseState.reasoningDiagnose ||
    (caseState.reasoningV2?.stage === "diagnose" ? caseState.reasoningV2 : undefined),
  );
  if (!current || !verifyDiagnoseReasoningSignature(current, caseState)) {
    return {
      ok: false,
      status: 409,
      code: "invalid_m03_signature",
      error: "The current M03 contract is missing, stale, or invalid.",
    };
  }
  const selected = (current.terminologyMappings || []).find((item) =>
    item.namespace === requested.namespace &&
    item.fieldPath === requested.fieldPath &&
    item.candidateId === requested.candidateId &&
    item.status === "suggested");
  if (!selected) {
    return {
      ok: false,
      status: 409,
      code: "terminology_suggestion_not_current",
      error: "The requested terminology suggestion is not present in the signed current M03 contract.",
    };
  }

  const mappings = (current.terminologyMappings || []).map((item) =>
    item === selected ? { ...item, status: "clinician_confirmed" as const } : item);
  let next: ClinicalReasoningResultV2 = {
    ...current,
    contractSignature: undefined,
    // The independent model reviewed the pre-confirmation result. The clinician action is explicit
    // authority, but must not be relabelled as if that model reviewed the new replacement.
    clinicalReview: { status: "unavailable" },
    terminologyMappings: mappings,
  };
  const restoredFormulaNames: string[] = [];

  if (selected.namespace === "tcm_syndrome") {
    const deferred = current.overview.deferredFormulaSelection;
    // primarySyndrome 存的是**去后缀规范名**（canonical），不是国标原文用词。
    //
    // 这是刻意的，别改：T1 词表每条同时存 canonical（供归一/等同判定、方剂召回、证-方一致性校验）
    // 与 standardTerm（含「证」后缀的国标原文）。clinical-governance-tables.ts:18 的分工是
    // 「医生可见面用 standardTerm，内部匹配继续用 canonical」。
    // 曾尝试把这里改写成 standardTerm 以满足甲方 R2 的国标诉求，结果打断了下游按 canonical 的匹配
    // （test:reasoning-signature 当场变红）。国标名的呈现责任在渲染层
    //（diagnosis-visible-summary.nationalStandardSyndromeName 的双显括注），不在这里。
    next = {
      ...next,
      overview: {
        ...next.overview,
        primarySyndrome: selected.canonical,
        primarySyndromeResolutionReason: [
          next.overview.primarySyndromeResolutionReason,
          `医生已确认标准证候名：${selected.originalText} → ${selected.canonical}`,
        ].filter(Boolean).join("；"),
      },
    };
    if (deferred && !namedFormulaPositiveSufficiencyIssue(next, deferred.names)) {
      restoredFormulaNames.push(...deferred.names);
      next = {
        ...next,
        overview: {
          ...next.overview,
          recommendedFormulaDirection: deferred.direction,
          recommendedFormulaNames: deferred.names,
          formulaSelectionMode: deferred.mode,
          deferredFormulaSelection: undefined,
        },
      };
    }
  } else {
    next = {
      ...next,
      westernDiagnosis: {
        ...next.westernDiagnosis,
        primary: {
          ...next.westernDiagnosis.primary,
          coding: {
            system: "ICD-10",
            code: selected.candidateId,
            display: selected.canonical,
            source: "医生确认的标准术语对照",
          },
        },
      },
    };
  }

  return {
    ok: true,
    reasoning: signDiagnoseReasoning(next, buildDiagnoseContractSignatureContext(caseState)),
    restoredFormulaNames,
  };
}
