import { normalizeReasoningV2, reasoningV2SchemaIssueCode, type ClinicalReasoningResultV2, type ClinicalReviewAttestation } from "./diagnosis-types";
import { clinicalReviewPayloadHash, hasBoundClinicalReviewAttestation, sha256CanonicalForContract } from "./clinical-review-binding";
import { m04SafetyContractIssue } from "./diagnosis-stage-contract";
import { enrichReasoning, formulaCompilationContractIssue } from "./tcm-formula-provenance";
import { isKnownTcmHerbName } from "./tcm-knowledge";
import { sanitizeGeneratedSuggestionPreviewText } from "./diagnosis-stream-safety";
import { NON_DOSE_PRESCRIPTION_MARKER } from "./diagnosis-safety";
import { cdssReasonCodeMarker } from "./cdss-reason-codes";
import { clinicalDeliveryAdvisoryFromIssue, clinicalDeliveryAdvisorySection, collectClinicalDeliveryAdvisories, deduplicateClinicalDeliveryAdvisories, isSafetyClinicalDeliveryAdvisory, type ClinicalDeliveryAdvisory } from "./clinical-delivery-advisory";

export type M04DeliveryCheckpoint = Readonly<{
  content: string;
  reasoning: ClinicalReasoningResultV2;
  payloadHash: string;
  acceptanceScope?: ClinicalReviewAttestation["acceptanceScope"];
  /**
   * 本候选走过 attestation 绑定这一步（不论是否因合同码而未绑定）。只供遥测区分
   * reviewStatus=unavailable（走过）与 not_run（只被保留、未走到绑定）。
   */
  attestationAttempted?: true;
  attestation?: ClinicalReviewAttestation;
  signedContent?: string;
  /**
   * 本候选未通过的确定性合同码（安全底线 / 方剂编译）。**非空不等于不可保留**——
   * 它只决定两件事：本候选永远不进签名剂量页（只作非剂量呈现），以及择优时排在干净候选之后。
   */
  contractIssues?: readonly string[];
  /** 随结果一起交付给医生的问题条目；也是回喂模型二次重试的反馈来源。 */
  findings?: readonly ClinicalDeliveryAdvisory[];
}>;

/** 本候选是否通过了全部确定性交付合同（干净候选才可签名、才可显示剂量）。 */
export function m04DeliveryCheckpointIsClean(checkpoint: M04DeliveryCheckpoint | undefined): boolean {
  return !!checkpoint && (checkpoint.contractIssues?.length || 0) === 0;
}

/** 本候选的 T1（安全底线）问题条目数；择优与采纳位都读它。 */
export function m04DeliveryCheckpointSafetyFindingCount(checkpoint: M04DeliveryCheckpoint | undefined): number {
  return (checkpoint?.findings || []).filter(isSafetyClinicalDeliveryAdvisory).length;
}

/**
 * Keep completed evidence ahead of pending/failed work; equal-strength completed candidates advance.
 *
 * 择优而非取最后一版（2026-09-13）。保留候选之后必须由**问题严重度**先分层，否则一轮
 * 带十八反的重写会顶掉上一轮干净的候选。
 *
 * 排序键依次为：
 *  1. **已签名**：走完全部合同 + attestation + 签名的剂量页永远优先，任何软性问题计数都不得把它挤掉
 *     （否则一轮「问题更少但未签名」的新候选会让医生从剂量页掉回非剂量页，是纯粹的可交付性倒退）；
 *  2. 合同干净 > 带合同码；
 *  3. T1（安全底线）问题少者优先；
 *  4. 问题总数少者优先（T2/T3 软性项，只在前三项全平时才起作用）。
 * （原第 4 键「复核状态 accepted > repair > 未跑」随模型复核环节删除：状态恒为 unavailable，
 *  该键只剩「已签名」一种取值，与第 1 键重合。）
 */
export function preferM04DeliveryCheckpoint(previous: M04DeliveryCheckpoint | undefined, next: M04DeliveryCheckpoint | undefined) {
  const score = (value: M04DeliveryCheckpoint | undefined): readonly number[] => !value
    ? [-1, -1, 0, 0]
    : [
        value.signedContent ? 1 : 0,
        m04DeliveryCheckpointIsClean(value) ? 1 : 0,
        -m04DeliveryCheckpointSafetyFindingCount(value),
        -(value.findings?.length || 0),
      ];
  const left = score(previous);
  const right = score(next);
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index] ? previous : next;
  }
  return next;
}

function immutable<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}

/** Called only for completed, normalized candidates; raw stream previews never enter this store. */
export function retainM04DeliveryCheckpoint(
  previous: M04DeliveryCheckpoint | undefined,
  input: {
    content: string;
    reasoning: ClinicalReasoningResultV2;
    priorReasoning?: ClinicalReasoningResultV2;
    clinicalContext?: string;
    acceptanceScope?: ClinicalReviewAttestation["acceptanceScope"];
    /** 调用方已经知道的驳回码（路由终审投影抛出的 finalized_prescription_*）。 */
    extraContractIssues?: readonly string[];
  },
): M04DeliveryCheckpoint | undefined {
  if (reasoningV2SchemaIssueCode(input.reasoning)) return previous;
  const start = input.content.lastIndexOf("<!-- DIAGNOSIS_JSON_START -->");
  const end = input.content.indexOf("<!-- DIAGNOSIS_JSON_END -->", start);
  if (start < 0 || end < 0) return previous;
  // ── 投影改写载荷时**以 sentinel 为准**，而不是丢弃候选（2026-09-14 生产实测）────────
  //
  // content 与 reasoning 必须描述同一份字节——这条不放宽。但此前不一致时直接 return previous，
  // 而路由终审投影恰恰会改写载荷（确定性补写药味 function、恢复受治理方名、
  // synchronizeVisibleClinicalSummary 归一化回写），调用方传进来的却是投影**前**那份对象。
  // 结果：候选在 `finalized M04 accepted with quality annotation` 之后被静默丢弃，
  // 终审复核一旦翻成 repair 就落到 `contract_rejected_no_valid_candidate`、0 味——
  // 正是本轮要修掉的那一类（上线后首次实测复现，caseRef 223e2dd8b3d1）。
  // 现在：两者不一致时从 sentinel 重新取载荷（schema 与阶段照常校验），
  // 保证 content/reasoning 仍然同源，且不再有「改写即丢弃」。
  let reasoning = normalizeReasoningV2(input.reasoning);
  let payloadHash = clinicalReviewPayloadHash(reasoning);
  if (!reasoning || reasoning.stage !== "prescribe" || !payloadHash) return previous;
  try {
    const sentinel = JSON.parse(input.content.slice(start + "<!-- DIAGNOSIS_JSON_START -->".length, end));
    if (clinicalReviewPayloadHash(sentinel) !== payloadHash) {
      if (reasoningV2SchemaIssueCode(sentinel)) return previous;
      const reprojected = normalizeReasoningV2(sentinel);
      const reprojectedHash = clinicalReviewPayloadHash(reprojected);
      if (!reprojected || reprojected.stage !== "prescribe" || !reprojectedHash) return previous;
      reasoning = reprojected;
      payloadHash = reprojectedHash;
    }
  } catch { return previous; }
  const enriched = enrichReasoning(reasoning).reasoning;
  // ── 合同不过**不再丢弃候选**（owner 决策 2026-09-13）─────────────────────────────
  //
  // 222 例实测第四类 13 例：流中已经出现 7–11 味药的候选草稿，全部 finishReason=stop、
  // 全部未触及 M04 总时限，最终却因为这里的「安全合同或方剂编译合同不过就 return previous」
  // 而连一味药都没留下，医生拿到的是「本次尚未形成通过校验的个体化方药候选」。
  //
  // 现在改为：合同码变成**随候选交付的问题条目**，候选照常保留。保留的候选只作
  // 非剂量呈现（renderM04DeliveryCheckpoint 从不输出剂量/用法/疗程），且 bindM04DeliveryAttestation
  // 拒绝为带合同码的候选绑定签名或 attestation —— 「保留内容」不得被冒充成「已通过校验」。
  const safetyIssue = m04SafetyContractIssue(
    enriched, input.priorReasoning, isKnownTcmHerbName, false, false, input.clinicalContext || "", true);
  const compilationIssue = formulaCompilationContractIssue(
    enriched, input.priorReasoning, false, reasoning.formula?.candidates?.[0]?.identityDeclassified === true);
  const contractIssues = [...new Set([safetyIssue, compilationIssue, ...(input.extraContractIssues || [])]
    .filter((issue): issue is string => Boolean(issue)))];
  // Never replace a completed attested result with a pending or malformed repair. For the same
  // payload preserve its attestation, even if a later phase checks it again.
  if (previous?.signedContent || previous?.payloadHash === payloadHash) return previous;
  const candidate = reasoning.formula?.candidates?.[0];
  const findings = candidate
    ? deduplicateClinicalDeliveryAdvisories([
        ...collectClinicalDeliveryAdvisories(candidate, input.priorReasoning, input.clinicalContext || "", contractIssues, 0),
        ...contractIssues.map((issue) => clinicalDeliveryAdvisoryFromIssue(issue, candidate, 0)),
      ])
    : [];
  return immutable(structuredClone({ content: input.content, reasoning, payloadHash,
    acceptanceScope: input.acceptanceScope,
    ...(contractIssues.length > 0 ? { contractIssues } : {}),
    ...(findings.length > 0 ? { findings } : {}) }));
}

/** 交付时需要回喂模型的问题码（整批，不是第一条）。 */
export function m04DeliveryCheckpointFeedbackCodes(checkpoint: M04DeliveryCheckpoint | undefined): string[] {
  return [...new Set((checkpoint?.findings || []).flatMap((finding) => [finding.code, ...(finding.relatedCodes || [])]))]
    .filter(Boolean);
}

/** Attestation and signature belong to the exact candidate hash, never the latest global flag. */
export function bindM04DeliveryAttestation(
  checkpoint: M04DeliveryCheckpoint | undefined,
  reasoning: ClinicalReasoningResultV2,
  attestation?: ClinicalReviewAttestation,
  signedContent?: string,
): M04DeliveryCheckpoint | undefined {
  if (!checkpoint || checkpoint.payloadHash !== clinicalReviewPayloadHash(reasoning)) return checkpoint;
  // 带确定性合同码的候选**永不签名、永不绑 attestation**：它保留下来是为了让医生看见药味与
  // 问题条目，不是为了冒充「已通过校验」。这条是「保留候选」与「安全底线」之间的唯一分界。
  // 模型复核环节已移除（2026-09-16）：attestation 固定为 unavailable/not_configured，
  // 「已完成」的判据是「签名存在且哈希绑定到这份字节」——hasBoundClinicalReviewAttestation
  // 本就接受 unavailable，签名模块与这里读同一个谓词。
  const bound = m04DeliveryCheckpointIsClean(checkpoint) && attestation !== undefined &&
    hasBoundClinicalReviewAttestation({ ...checkpoint.reasoning, clinicalReview: attestation });
  let matchingSignedContent: string | undefined;
  if (bound && signedContent) {
    const start = signedContent.lastIndexOf("<!-- DIAGNOSIS_JSON_START -->");
    const end = signedContent.indexOf("<!-- DIAGNOSIS_JSON_END -->", start);
    try {
      const signed = start >= 0 && end >= 0 && normalizeReasoningV2(JSON.parse(
        signedContent.slice(start + "<!-- DIAGNOSIS_JSON_START -->".length, end),
      ));
      if (signed && signed.clinicalReview &&
          signed.contractSignature?.startsWith("hmac-sha256:") &&
          sha256CanonicalForContract(signed.clinicalReview) === sha256CanonicalForContract(attestation) &&
          clinicalReviewPayloadHash(signed) === checkpoint.payloadHash && hasBoundClinicalReviewAttestation(signed)) {
        matchingSignedContent = signedContent;
      }
    } catch { /* Mismatched or incomplete signed bytes remain a non-dose candidate. */ }
  }
  return immutable(structuredClone({ ...checkpoint,
    attestationAttempted: true as const,
    attestation: bound ? attestation : undefined, signedContent: matchingSignedContent }));
}

function factText(value: unknown): string {
  if (typeof value !== "string") return "";
  // Source facts include measured concentrations, bleeding volumes and historical medication.
  // Escaping controls presentation only; none of those quantities is a new dosing suggestion.
  return value.replace(/\s+/g, " ").trim()
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/[\\`*_{}\[\]()#+.!|~-]/g, "\\$&");
}

function text(value: unknown): string {
  return factText(typeof value === "string" ? sanitizeGeneratedSuggestionPreviewText(value) : value);
}

/** A read-only non-dose projection, or the exact already-signed completed candidate. */
export function renderM04DeliveryCheckpoint(
  checkpoint: M04DeliveryCheckpoint | undefined,
  priorReasoning: ClinicalReasoningResultV2 | undefined,
  reason: "deadline" | "interrupted" | "upstream_unavailable" | "contract_rejected" | "dose_withheld",
  /** 剂量被独立硬边界收回时的确定性理由（儿科体重缺失、妊娠阳性、红旗未解除…）。 */
  doseWithheldReasons: readonly string[] = [],
): string {
  // 剂量授权轴收回时**永远不返回已签名的剂量页**：那一页带完整用量。候选、方义、调护照常呈现。
  if (reason !== "dose_withheld" && checkpoint?.signedContent && checkpoint.attestation) {
    return checkpoint.signedContent;
  }
  const prior = priorReasoning;
  // 机器码随页交付（2026-09-13）：此前这一整类非剂量页**不带任何 reasonCode**，前端只能靠
  // 文案正则分流，服务端改一句措辞前端就瞎。三种处置各有各的恢复动作，必须分开。
  const reasonMarker = cdssReasonCodeMarker(
    reason === "dose_withheld" ? "dose_authorization_withheld"
      : reason === "upstream_unavailable" ? "upstream_model_unavailable"
      : checkpoint ? "m04_candidate_retained_non_dose"
      : "m04_truncated_no_candidate",
  );
  const lines = [NON_DOSE_PRESCRIPTION_MARKER, reasonMarker, ...(prior ? ["## 已完成的辨病辨证"] : []), ...[
    prior?.westernDiagnosis?.primary?.name,
    prior?.overview?.primarySyndrome,
    prior?.overview?.overallPathogenesis,
    prior?.therapy?.overallPrinciple,
    prior?.therapy?.overallMethod,
  ].filter(Boolean).map(text)];
  for (const node of prior?.pathogenesis?.chain || []) {
    lines.push(`- ${factText(node.patientFact)}；${text(node.pathogenesis)}；${text(node.therapyDirection)}`);
  }
  if (!checkpoint) {
    const retainedState = prior ? "已完成的辨病辨证与治法保留，" : "本次没有可用的已签名辨病辨证，";
    // 「通过校验」四个字删掉（2026-09-13）：候选保留策略生效后，走到这里表示**根本没有
    // 可保留的候选**（模型未产出结构完整的候选、传输中断或时限到期），而不是「校验没过」。
    // 校验没过的候选现在照常保留并带问题提示交付，不再落到本分支。
    lines.push("", "## 候选方药生成状态", reason === "deadline"
      ? `本阶段超过时限，尚未形成可保留的个体化方药候选。${retainedState}暂不提供药味、剂量或用法。`
      : reason === "upstream_unavailable"
        ? `模型服务暂时不可用，尚未形成可保留的个体化方药候选。${retainedState}暂不提供药味、剂量或用法。`
      : reason === "dose_withheld"
        ? `本例剂量由独立硬边界暂缓（${doseWithheldReasons.join("；") || "需先完成相关核实"}），且本轮尚未形成可保留的个体化方药候选。${retainedState}暂不提供药味、剂量或用法。`
      : `本轮尚未形成可保留的个体化方药候选（模型未产出结构完整的候选）。${retainedState}暂不提供药味、剂量或用法。`);
    return lines.join("\n\n");
  }
  const clean = m04DeliveryCheckpointIsClean(checkpoint);
  const status = reason === "dose_withheld"
    ? `本次已生成候选方药；按独立硬边界本例暂不显示具体用量（${doseWithheldReasons.join("；") || "需先完成相关核实"}）。`
    : reason === "deadline"
      ? "本次已生成候选，本阶段超过时限。"
      : "本次已生成候选。";
  // 「已通过确定性校验」这句话只有在候选确实干净时才成立。带合同码的候选照常展示，
  // 但必须如实写明它没有通过哪些校验——保留内容不等于冒充已复核通过（owner 2026-09-13）。
  const scopeLine = clean
    ? "以下为本次已通过确定性校验的药味与方义，不代表处方已获批准；本页不提供剂量、给药方法或疗程。"
    : "以下为本次生成的药味与方义，**尚未通过全部确定性校验**，不代表处方已获批准；本页不提供剂量、给药方法或疗程。请结合下方问题提示判断。";
  lines.push("", "## 本次候选方药（非剂量，供医生审阅）", status, scopeLine);
  for (const candidate of checkpoint.reasoning.formula?.candidates || []) {
    lines.push(`候选方：${text(candidate.name)}`);
    for (const herb of candidate.herbs) lines.push(`- ${text(herb.name)}（${text(herb.role)}）：${text(herb.function)}`);
    lines.push(text(candidate.formulaAnalysis), text(candidate.applicable), text(candidate.notApplicable));
  }
  // 问题提示同样走非剂量掩码：本页的全部意义就是不给具体用量，提示文案里的
  // 「当前药量 500g」会把模型提出的剂量从后门放出去。掩码与药味功用共用同一支
  // sanitizeGeneratedSuggestionPreviewText，不另写一套判据。
  const findingsSection = clinicalDeliveryAdvisorySection((checkpoint.findings || []).map((finding) => ({
    ...finding,
    message: sanitizeGeneratedSuggestionPreviewText(finding.message),
    suggestedAction: sanitizeGeneratedSuggestionPreviewText(finding.suggestedAction),
  })));
  if (findingsSection) lines.push("", findingsSection);
  const care = checkpoint.reasoning.nonPharma;
  if (care) lines.push("", "## 已生成的健康调护建议", ...[care.diet, care.lifestyle, care.emotion, ...care.precautions].filter(Boolean).map(text));
  return lines.filter((line) => line !== "").join("\n\n");
}
