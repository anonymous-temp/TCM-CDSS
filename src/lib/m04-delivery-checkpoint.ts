import { normalizeReasoningV2, reasoningV2SchemaIssueCode, type ClinicalReasoningResultV2, type ClinicalReviewAttestation } from "./diagnosis-types";
import { clinicalReviewPayloadHash, hasBoundClinicalReviewAttestation, sha256CanonicalForContract } from "./clinical-review-binding";
import { m04SafetyContractIssue } from "./diagnosis-stage-contract";
import { enrichReasoning, formulaCompilationContractIssue } from "./tcm-formula-provenance";
import { isKnownTcmHerbName } from "./tcm-knowledge";
import { sanitizeGeneratedSuggestionPreviewText } from "./diagnosis-stream-safety";
import { NON_DOSE_PRESCRIPTION_MARKER } from "./diagnosis-safety";
import { projectDeliveredReasoning } from "./delivered-surface";
import { cdssReasonCodeMarker } from "./cdss-reason-codes";
import { pediatricDoseRuleFromGroundingText } from "./pediatric-dose-rule";
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
  const safetyIssue = m04SafetyContractIssue(enriched, input.priorReasoning, {
    isKnownHerbName: isKnownTcmHerbName, trustedWorkbenchEdit: false, auditedClinicalRisksAreAdvisory: false,
    clinicalContext: input.clinicalContext || "", waiveTherapyCoverageAnnotated: true,
  });
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
        ...contractIssues.map((issue) => clinicalDeliveryAdvisoryFromIssue(issue, candidate, 0, pediatricDoseRuleFromGroundingText(input.clinicalContext || ""))),
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

/**
 * 非剂量页的结构化副本（2026-09-29，甲方 9.24/9.27：「饮片暂未生成」）。
 *
 * 红旗未解除、儿童、妊娠/哺乳阳性时 M04 按独立硬边界只给**非剂量**页：药味与方义在正文里，但没有
 * DIAGNOSIS_JSON 区块，HIS 只认那个区块，于是页面上明明有候选方，HIS 里却是「暂未生成」，
 * 而且没有任何结构化字段说明为什么。这里另加一个**独立的**区块（不同的哨兵，现有解析方不认识、不受影响）：
 *   · 只含药味、君臣佐使、功用、方义、适用/不适用，不含剂量、煎服法、疗程；
 *   · `adoptable:false`，不签名，不能写回处方；
 *   · `reasonCode` 与 `doseWithheldReasons` 说明为什么没有剂量。
 * 字符串统一过「非剂量掩码」，并转义尖括号，保证不会提前闭合 HTML 注释。
 */
// 整个区块是**一条** HTML 注释（`<!-- CDSS_NON_DOSE_CANDIDATE_JSON:{…} -->`）：DIAGNOSIS_JSON 那种「两条注释夹一段文本」的形态
// 靠前端专门剥离，新区块前端不认识，夹在中间的 JSON 会当正文显示给医生。JSON 里的「-」「<」「>」全部转成 \\uXXXX，
// 保证注释不会被提前闭合（HTML 注释里不能出现「--」「-->」）。
export const NON_DOSE_CANDIDATE_JSON_PREFIX = "<!-- CDSS_NON_DOSE_CANDIDATE_JSON:";
export const NON_DOSE_CANDIDATE_JSON_SUFFIX = " -->";

function nonDoseCandidateJsonBlock(
  candidates: ReadonlyArray<{
    name?: unknown; formulaAnalysis?: unknown; applicable?: unknown; notApplicable?: unknown;
    herbs?: ReadonlyArray<{ name?: unknown; role?: unknown; function?: unknown; targetPathogenesis?: unknown }>;
  }>,
  reasonCode: string,
  doseWithheldReasons: readonly string[],
): string {
  const clean = (value: unknown): string => typeof value === "string"
    ? sanitizeGeneratedSuggestionPreviewText(value).replace(/\s+/g, " ").trim()
    : "";
  const payload = {
    schemaVersion: "tcm-cdss-non-dose-candidate-v1",
    adoptable: false,
    reasonCode,
    doseWithheldReasons: doseWithheldReasons.map(clean).filter(Boolean),
    candidates: candidates.map((candidate) => ({
      name: clean(candidate.name),
      herbs: (candidate.herbs || []).map((herb) => ({
        name: clean(herb.name),
        role: clean(herb.role),
        function: clean(herb.function),
        targetPathogenesis: clean(herb.targetPathogenesis),
      })).filter((herb) => herb.name),
      formulaAnalysis: clean(candidate.formulaAnalysis),
      applicable: clean(candidate.applicable),
      notApplicable: clean(candidate.notApplicable),
    })).filter((candidate) => candidate.name && candidate.herbs.length > 0),
  };
  if (payload.candidates.length === 0) return "";
  const json = JSON.stringify(payload)
    .replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/-/g, "\\u002d");
  return `${NON_DOSE_CANDIDATE_JSON_PREFIX}${json}${NON_DOSE_CANDIDATE_JSON_SUFFIX}`;
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
  // 非剂量页与带剂量页走同一份交付面投影（2026-10-13）：此前这一页直接渲染未投影的结果，方名显示
  //「本例辨证组方」、方义写「本方以本方案为基础加减」、适用栏是「适用于与本例锁定证候…及病机链一致的情况」。
  const prior = priorReasoning ? projectDeliveredReasoning(priorReasoning) : priorReasoning;
  if (checkpoint) checkpoint = { ...checkpoint, reasoning: projectDeliveredReasoning(checkpoint.reasoning) };
  // 机器码随页交付（2026-09-13）：此前这一整类非剂量页**不带任何 reasonCode**，前端只能靠
  // 文案正则分流，服务端改一句措辞前端就瞎。三种处置各有各的恢复动作，必须分开。
  const reasonMarker = cdssReasonCodeMarker(
    reason === "dose_withheld" ? "dose_authorization_withheld"
      : reason === "upstream_unavailable" ? "upstream_model_unavailable"
      : checkpoint ? "m04_candidate_retained_non_dose"
      : "m04_truncated_no_candidate",
  );
  // 每行带上它是什么（2026-10-14）：此前这五项是没有标签的五行裸文本，读的人要自己猜哪一行是证候、哪一行是治则。
  const labelled = (label: string, ...values: unknown[]) => {
    const body = values.map(text).filter(Boolean).join("；");
    return body ? [`${label}：${body}`] : [];
  };
  const lines = [NON_DOSE_PRESCRIPTION_MARKER, reasonMarker, ...(prior ? ["## 已完成的辨病辨证"] : []),
    ...labelled("西医诊断", prior?.westernDiagnosis?.primary?.name),
    ...labelled("证候", prior?.overview?.primarySyndrome),
    ...labelled("病机", prior?.overview?.overallPathogenesis),
    ...labelled("治则治法", prior?.therapy?.overallPrinciple, prior?.therapy?.overallMethod),
  ];
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
        ? `本例暂不给出具体用量（${doseWithheldReasons.join("；") || "需先完成相关核实"}），且本轮尚未形成可保留的个体化方药候选。${retainedState}暂不提供药味、剂量或用法。`
      : `本轮尚未形成可保留的个体化方药候选（模型未产出结构完整的候选）。${retainedState}暂不提供药味、剂量或用法。`);
    return lines.join("\n\n");
  }
  const clean = m04DeliveryCheckpointIsClean(checkpoint);
  // 这一页的说明写给医生看（2026-10-14）：此前写的是「本次已生成候选；自动修复未能消除下方问题」
  //「尚未通过全部确定性校验」「候选方：」——说的是系统自己的流程（第二轮独立评审 5 个不给剂量页全部记为工程用语）。
  // 意思不变：为什么没有剂量、这一页有什么没有什么、有没有需要医生核对的地方。
  const status = reason === "dose_withheld"
    ? `本例暂不给出具体用量（${doseWithheldReasons.join("；") || "需先完成相关核实"}）；药味与方义照常列出。`
    : reason === "deadline"
      ? "本次生成超过时限，下面是已得到的药味与方义。"
      // 修复没完成的原因仍要如实写出来（2026-10-12）：医生需要知道为什么没有剂量页。
      : reason === "upstream_unavailable"
        ? "模型服务暂时不可用，下面的药味与方义未能完成核对。"
      : reason === "contract_rejected"
        ? "下面的药味与方义仍有未解决的问题（见「处方补充提示」），因此不给出剂量。"
      : "下面是本次已得到的药味与方义。";
  // 带问题的方药照常列出，但必须如实写明其中有需要核对的地方——保留内容不等于已核对无误（owner 2026-09-13）。
  const scopeLine = clean
    ? "本页只列药味与方义，不含剂量、煎服法和疗程，用量由医生评估后确定。"
    : "本页只列药味与方义，不含剂量、煎服法和疗程；其中**有需要医生核对之处**，见下方「处方补充提示」。";
  lines.push("", "## 参考方药（未给剂量）", status, scopeLine);
  for (const candidate of checkpoint.reasoning.formula?.candidates || []) {
    lines.push(`方名：${text(candidate.name)}`);
    for (const herb of candidate.herbs) lines.push(`- ${text(herb.name)}（${text(herb.role)}）：${text(herb.function)}`);
    lines.push(...labelled("方义", candidate.formulaAnalysis), ...labelled("适用", candidate.applicable), ...labelled("慎用与不适用", candidate.notApplicable));
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
  // 这一页不给剂量：注意事项里带用量、剂数、疗程的条目经掩码后只剩半句（「不可在家自行用法与疗程以审定处方为准」），整条不列。
  const precautions = (care?.precautions || []).filter((item) => typeof item === "string" && sanitizeGeneratedSuggestionPreviewText(item) === item);
  if (care) lines.push("", "## 调护建议", ...[care.diet, care.lifestyle, care.exercise, care.emotion, care.acupointCare, ...precautions].filter(Boolean).map(text));
  const structuredCopy = nonDoseCandidateJsonBlock(
    checkpoint.reasoning.formula?.candidates || [],
    reason === "dose_withheld" ? "dose_authorization_withheld" : "m04_candidate_retained_non_dose",
    doseWithheldReasons,
  );
  if (structuredCopy) lines.push("", structuredCopy);
  return lines.filter((line) => line !== "").join("\n\n");
}
