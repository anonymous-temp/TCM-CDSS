import "server-only";

import type { CaseState, ClinicalReasoningResultV2 } from "./diagnosis-types";
import { diagnoseReasoningFromState, prescribeReasoningFromState } from "./diagnosis-parse";
import { m04SafetyContractIssue } from "./diagnosis-stage-contract";
import {
  editedPrescriptionIssueMessage,
  editedPrescriptionSemanticIssue,
  hasIncompleteEditedHerb,
} from "./prescription-revision";
import { verifyDiagnoseReasoningSignature, verifyPrescribeReasoningSignature } from "./reasoning-contract-signature";
import { formulaCompilationContractIssue } from "./tcm-formula-provenance";
import { isKnownTcmHerbName } from "./tcm-knowledge";
import { prescriptionRegimenContractIssue } from "./prescription-regimen-contract";

type ValidationFailure = {
  ok: false;
  status: 409 | 422;
  code: string;
  message: string;
  issue?: string;
};

type ValidationSuccess = {
  ok: true;
  prescribed: ClinicalReasoningResultV2;
  candidateIndex: number;
};

export type HisPrescriptionValidationResult = ValidationFailure | ValidationSuccess;

function invalidPrescription(issue: string): ValidationFailure {
  return {
    ok: false,
    status: 422,
    code: `invalid_his_prescription_${issue}`,
    issue,
    message: editedPrescriptionIssueMessage(issue),
  };
}

export function validateHisPrescriptionForWriteBack(caseState: CaseState): HisPrescriptionValidationResult {
  const prescribed = prescribeReasoningFromState(caseState);
  if (!prescribed || prescribed.stage !== "prescribe" || !prescribed.formula) {
    return {
      ok: false,
      status: 422,
      code: "missing_structured_prescription",
      message: "缺少有效的候选处方，已拒绝生成可写回 HIS 的方案。",
    };
  }

  const diagnoseReasoning = diagnoseReasoningFromState(caseState);
  if (!verifyDiagnoseReasoningSignature(diagnoseReasoning, caseState)) {
    return {
      ok: false,
      status: 409,
      code: "invalid_m03_signature",
      message: "当前辨病辨证结果已失效，请重新生成后再生成 HIS 方案。",
    };
  }

  // Mirror the M04-route predicate: a signed M03 with no syndrome resolution and no pathogenesis
  // chain is a server-owned limited contract. It can never authorize dose generation, so a
  // client-claimed herb_workbench revision must not turn it into a dose-level HIS payload.
  if (diagnoseReasoning &&
    diagnoseReasoning.overview.primarySyndromeResolution === "unresolved" &&
    diagnoseReasoning.pathogenesis.chain.length === 0) {
    return {
      ok: false,
      status: 409,
      code: "limited_m03_not_prescribable",
      message: "本次辨病辨证仅形成有限结果，尚未形成可采纳的证候与病机链，不能生成剂量级 HIS 方案；请补充会影响辨证或用药的患者信息后重新分析。",
    };
  }

  const candidateIndex = caseState.prescriptionRevision?.candidateIndex ?? 0;
  const candidate = Number.isSafeInteger(candidateIndex) && candidateIndex >= 0
    ? prescribed.formula.candidates[candidateIndex]
    : undefined;
  if (!candidate || candidate.herbs.length === 0) {
    return {
      ok: false,
      status: 422,
      code: "invalid_candidate_index",
      message: "所选候选方不存在或没有结构化药味，已拒绝生成 HIS 方案。",
    };
  }

  const trustedWorkbenchEdit = caseState.prescriptionRevision?.source === "herb_workbench" &&
    candidate.constructionType === "self_devised" &&
    candidate.modificationStatus === "modified" &&
    /医生编辑版/.test(candidate.name);
  if (!trustedWorkbenchEdit && !verifyPrescribeReasoningSignature(prescribed, caseState)) {
    return {
      ok: false,
      status: 409,
      code: "invalid_m04_signature",
      message: "当前候选处方缺少与本病例及辨证结果绑定的有效签名，请重新生成候选方药。",
    };
  }

  if (candidate.herbs.some(hasIncompleteEditedHerb)) {
    return {
      ok: false,
      status: 422,
      code: "invalid_structured_herb",
      issue: "invalid_structured_herb",
      message: "结构化药味的药名、剂量、角色、病机靶点或功用不完整，已拒绝生成 HIS 方案。",
    };
  }

  const regimenIssue = prescriptionRegimenContractIssue(candidate.decoction);
  if (regimenIssue) return invalidPrescription(regimenIssue);

  // This shared workbench validator covers duplicate names plus the deterministic herb-level
  // knowledge checks (known herb, dose, function, target reference, processing/decoction route).
  const editedIssue = editedPrescriptionSemanticIssue(prescribed, candidateIndex, diagnoseReasoning);
  if (editedIssue) return invalidPrescription(editedIssue);

  const selectedReasoning: ClinicalReasoningResultV2 = {
    ...prescribed,
    formula: {
      ...prescribed.formula,
      candidates: [candidate],
    },
  };

  if (!trustedWorkbenchEdit) {
    // HIS 写回是最后一道信任边界，执行的是**安全底线合同**（逐味剂量边界、配伍禁忌、特殊
    // 人群、方向对立、君臣结构、跨阶段漂移），而不是全量质量口径——质量合同的权力止于流层
    // 的生成与修复轮。此前这里复跑全量 m04SemanticIssue：流层按降级/批注受理的候选（页面
    // 已显示完成）在生成 HIS 方案时被同一族 T2 码再判死、422 拒绝——「页面看似完成、对外
    // 集成拿不到交付结果」（甲方生产实测病例1），这是同一结构性分叉的第 6 处复发点。
    const floorIssue = m04SafetyContractIssue(
      selectedReasoning,
      diagnoseReasoning,
      isKnownTcmHerbName,
      false,
      true,
      "",
      true,
    );
    if (floorIssue) return invalidPrescription(floorIssue);
  }

  // Every HIS candidate reaches the same server compilation contract. That contract applies its
  // narrow self-devised/modified doctor-edit exception only when this trusted path passes true.
  const formulaIssue = formulaCompilationContractIssue(
    selectedReasoning,
    diagnoseReasoning,
    trustedWorkbenchEdit,
  );
  if (formulaIssue) return invalidPrescription(formulaIssue);

  return { ok: true, prescribed, candidateIndex };
}
