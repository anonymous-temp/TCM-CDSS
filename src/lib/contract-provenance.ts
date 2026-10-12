import type { ClinicalDeliveryAdvisory } from "./clinical-delivery-advisory";
import type { CaseState } from "./diagnosis-types";

/**
 * 签名/凭据核验**只标注、不拦截**（owner 2026-10-12；与 2026-09-13「推理结果全部输出，有问题带
 * 提示交付，不拦截、不作废、不清空」同一口径）。
 *
 * 【为什么】线上 9/30–10/12 甲方的 4 次 M05 409（invalid_m04_signature）全部发生在同一病历换了
 * 病例编号重推、M03/M04 命中复用缓存的那几轮：结果本身是本系统按完全相同的临床输入生成的，
 * 只是签名绑着旧编号。缓存换绑已修（stage-result-coalescing.server.ts），但签名不一致还会有
 * 别的正常成因——HIS 侧医生改了病历或处方、序列化时丢了字段——它们都不是拒绝整份结果的理由。
 *
 * 【现在怎么处理】核验不通过时照常按回传内容继续，在结果里给出这里的提示（M05 正文、HIS
 * `warnings[]`、页面同一条）。临床安全不依赖签名：剂量边界、十八反十九畏、特殊人群、红旗
 * 等确定性核对在每个出口都对**实际回传的内容**重跑。签名只回答「这是不是本系统签发的那一版」，
 * 所以它的结论是来源说明（T3），不是临床问题，也不收回采纳（diagnosis-rejection-tiers.ts）。
 *
 * 【仍然成立的边界】未核验内容不会因此获得新的服务端凭据：编辑前的合同签名不会被沿用到编辑版，
 * 形状不合规的工作台版本不签发审方凭据，被剥离的非结构化处方文本不进入任何消费方。
 */
export type ContractProvenanceIssue =
  | "m03_unverified"
  | "m04_unverified"
  | "workbench_revision_unattested"
  | "workbench_pre_edit_metadata_removed"
  | "workbench_edit_shape_unattested"
  | "unstructured_prescription_ignored";

const COPY: Record<ContractProvenanceIssue, { message: string; suggestedAction: string }> = {
  m03_unverified: {
    message: "回传的辨病辨证结果与本系统签发的版本不一致（可能在 HIS 侧被修改、未原样回传，或属于另一病例/租户），本次按回传内容继续。",
    suggestedAction: "请医生核对诊断、证候与病机是否为本次就诊的结论；如需与系统签发版本一致，请重新生成辨病辨证。",
  },
  m04_unverified: {
    message: "回传的候选处方与本系统签发的版本不一致（可能在 HIS 侧被修改、未原样回传，或属于另一病例/租户），本次按回传内容完成安全核对与随访。",
    suggestedAction: "请医生核对药味、剂量与煎服法；本次的剂量边界、配伍禁忌与特殊人群核对已按回传内容重新执行。",
  },
  workbench_revision_unattested: {
    message: "医生编辑版处方没有与本病例及当前药味版本绑定的审方凭据，本次按回传药味重新完成安全核对。",
    suggestedAction: "如需写回 HIS，建议先经处方后审接口对当前药味版本重新审方。",
  },
  workbench_pre_edit_metadata_removed: {
    message: "医生编辑后的处方仍携带编辑前的签名与复核标记，已移除（它们只对应编辑前的版本），本次按当前药味重新审方。",
    suggestedAction: "无需处理；如由集成方回传，请在编辑后清除旧的 contractSignature / clinicalReview 字段。",
  },
  workbench_edit_shape_unattested: {
    message: "当前提交不是药味工作台形成的规范医生编辑版（应为自拟组方、已修改、方名含「医生编辑版」），已完成安全核对，但未签发可写回版本的审方凭据。",
    suggestedAction: "如需写回 HIS，请按医生编辑版的规范形态重新提交。",
  },
  unstructured_prescription_ignored: {
    message: "提交的处方是未经本系统生成的处方文本，没有结构化药味，无法逐味核对，本次未纳入评估，仅按辨证结果给出随访与安全总评。",
    suggestedAction: "如需对处方做安全核对与随访，请回传候选方药接口返回的结构化处方（reasoningPrescribe）。",
  },
};

export function contractProvenanceAdvisory(issue: ContractProvenanceIssue, candidateIndex = 0): ClinicalDeliveryAdvisory {
  return { code: `contract_provenance_${issue}`, candidateIndex, ...COPY[issue] };
}

/** 计数用：看线上多久出现一次、出在哪个出口（无病例内容）。 */
export function recordContractProvenance(route: string, issues: readonly ContractProvenanceIssue[]): void {
  if (issues.length === 0) return;
  console.info("[tcm-cdss:telemetry] contract_provenance", { route, issues: [...issues] });
}

/**
 * 未核验的 M04 不得带着「生成侧受理裁决」进入写回方案：`clinicalReview.acceptanceScope` 在 HIS 里
 * 会被呈现为「随合同签名下发的受理裁决」，而复核哈希是公开可算的，签名才是它的出处证明。
 * 签名不再拦截之后，未核验内容里的这一段只能剥掉，不能照读。
 */
export function withoutUnverifiedPrescribeReview(caseState: CaseState): CaseState {
  const strip = (reasoning: CaseState["reasoningPrescribe"]) => {
    if (!reasoning || reasoning.stage !== "prescribe" || reasoning.clinicalReview == null) return reasoning;
    const rest = { ...reasoning };
    delete rest.clinicalReview;
    return rest;
  };
  return {
    ...caseState,
    reasoningPrescribe: strip(caseState.reasoningPrescribe),
    reasoningV2: caseState.reasoningV2?.stage === "prescribe" ? strip(caseState.reasoningV2) : caseState.reasoningV2,
  };
}
