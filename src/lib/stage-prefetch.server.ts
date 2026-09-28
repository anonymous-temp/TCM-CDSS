import type { CaseState } from "./diagnosis-types";
import {
  diagnoseReasoningFromState,
  extractDiagnosisJSON,
  mergeReasoningStages,
  prescribeReasoningFromState,
  stripDiagnosisJSON,
} from "./diagnosis-parse";
import { STREAM_REPLACE_MARKER } from "./diagnosis-stream-protocol";
import { buildExternalEvidenceContext } from "./evimed-guide";
import { normalizeCaseTextForFormulaRecall } from "./formula-recall-normalization.server";
import { assistedPolarityDecisions } from "./polarity-negation-assist.server";
import { rerankSyndromeHypothesesForFormulaRecall } from "./syndrome-hypothesis-rerank.server";
import { deriveSafetyLocked, sanitizeCaseStateForModel, withSafetyGate } from "./diagnosis-safety";
import { planEvidenceBoundMedicineCandidates } from "./medicine-candidate-planner.server";
import { maybeAttachClinicalFactsBackstop } from "./clinical-facts-runtime";
import {
  buildLocalHighRiskHerbPairSection,
  buildPrescriptionInputAdvisories,
  buildPrescriptionInputAdvisorySection,
  buildRetainedPrescriptionRiskSection,
  resolvePrescriptionCandidateIndex,
} from "./local-prescription-checks";
import { authorFollowupForCase } from "./m05-followup-authoring.server";
import { applyDeterministicFollowUpNode } from "./diagnosis-visible-summary";
import { normalizeM04DraftCandidate } from "./m04-proposal-compiler";

/**
 * 阶段间预取（2026-09-27，提速）。
 *
 * M04 生成前要先等两条与模型无关的腿：用药候选规划（模型约 1.2s + 其后串行的西药说明书检索）
 * 和 EviMed 检索（线上约 3.5s）。两者的输入只有「病例 + 已签名 M03 + 租户库存」，M03 签名那一刻
 * 就全部齐了；而医生（或外部接口调用方）从拿到 M03 到发起 M04 之间总有一段间隔。
 * 所以 M03 流结束时服务端按「M04 将会收到的病例形状」把这两条腿先跑一遍，结果进各自的缓存
 * （evimed-guide 的检索缓存、规划器缓存）；M04 路由原样调用时直接命中。
 *
 * 纪律：
 *  · 预取只写缓存，不写病例、不产出任何对外内容；预取失败静默，M04 照常自己算；
 *  · 缓存键是被调用函数自己的输入（检索词、规划输入文本），不是这里的推测——病例形状与 M04
 *    实际收到的不一致时只会未命中，不可能拿错结果；
 *  · 不预取任何模型生成的临床内容（M04 候选本身），只预取检索与规划这类确定性输入。
 */
export function prefetchPrescribeInputsFromSignedDiagnose(
  gatedCaseState: CaseState,
  finalDiagnoseContent: string,
  customerId: string | undefined,
): void {
  try {
    const reasoning = extractDiagnosisJSON(finalDiagnoseContent);
    if (!reasoning || reasoning.stage !== "diagnose" || typeof reasoning.contractSignature !== "string") return;
    // 与对外接口文档「M03 → M04 交接：caseState.diagnosis、caseState.reasoningDiagnose」同形。
    const handoff: CaseState = {
      ...gatedCaseState,
      phase: "prescribe",
      diagnosis: stripDiagnosisJSON(finalDiagnoseContent),
      reasoningDiagnose: reasoning as unknown as CaseState["reasoningDiagnose"],
    };
    const safeState = sanitizeCaseStateForModel(handoff);
    void buildExternalEvidenceContext(safeState, "prescribe").catch(() => undefined);
    void planEvidenceBoundMedicineCandidates(safeState, customerId).catch(() => undefined);
  } catch {
    // 预取是纯增益：任何异常都不影响 M03 已交付的结果。
  }
}

/**
 * 透传阶段响应的 NDJSON 流，在 `[END]` 时把最终正文（最后一个 STREAM_REPLACE_MARKER 之后的内容，
 * 与客户端 applyStreamChunk 同一口径）交给回调。字节原样转发，不改变任何帧。
 */
export function tapFinalStageContent(response: Response, onFinal: (content: string) => void): Response {
  if (!response.ok || !response.body) return response;
  const decoder = new TextDecoder();
  let pending = "";
  let accumulated = "";
  let delivered = false;
  const consumeLine = (line: string) => {
    if (delivered || !line.trim()) return;
    let frame: { content?: unknown };
    try {
      frame = JSON.parse(line) as { content?: unknown };
    } catch {
      return;
    }
    if (typeof frame.content !== "string") return;
    if (frame.content === "[END]") {
      delivered = true;
      const finalContent = accumulated;
      setTimeout(() => {
        try {
          onFinal(finalContent);
        } catch {
          // 回调只做预取，异常不影响已转发的流。
        }
      }, 0);
      return;
    }
    const combined = accumulated + frame.content;
    const markerIndex = combined.lastIndexOf(STREAM_REPLACE_MARKER);
    accumulated = markerIndex >= 0 ? combined.slice(markerIndex + STREAM_REPLACE_MARKER.length) : combined;
  };
  const tap = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      pending += decoder.decode(chunk, { stream: true });
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        consumeLine(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
    },
    flush() {
      pending += decoder.decode();
      consumeLine(pending);
    },
  });
  return new Response(response.body.pipeThrough(tap), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * M02 → M03 预取（2026-09-27）。M03 两半开跑前要串行等：EviMed 检索、方名召回改写与口语否定增补
 * （并行）、其后的证候重排——线上合计约 3.8s。这四样的输入都只是病例字段，M02 请求到来时已经齐了；
 * 外部接口直调时 M03 的病例通常与此刻相同。预取结果进各自的缓存（检索缓存、small-task-memo、
 * 否定增补缓存），M03 路由原样调用时命中；病例在 M02 之后被改写（医生答了追问）则只是未命中。
 */
export function prefetchDiagnoseInputs(caseState: CaseState): void {
  try {
    const safeState = sanitizeCaseStateForModel(withSafetyGate(caseState));
    void buildExternalEvidenceContext(safeState, "diagnose").catch(() => undefined);
    void normalizeCaseTextForFormulaRecall(safeState).catch(() => undefined);
    void assistedPolarityDecisions(safeState)
      .then((negations) => rerankSyndromeHypothesesForFormulaRecall(safeState, negations))
      .catch(() => undefined);
  } catch {
    // 预取是纯增益：任何异常都不影响 M02 本身。
  }
}

/**
 * M04 → M05 预取（2026-09-27，提速）。M05 路由 ~4s 里 ~3.7s 是随访作文这一次模型调用
 * （生产 9/27 四例 3.2–4.1s），其输入只有「病例 + 已签名 M03 + 已签名 M04 选中候选的药味 +
 * 本地确定性处方核对」，M04 签名那一刻就全部齐了。所以 M04 流结束时按「M05 将会收到的病例形状」
 * （与前端 M04 完成后写回的状态同形：去掉 JSON 块的处方正文、签名 M04、合并后的 reasoningV2）
 * 把 assess 路由到作文为止的计算走一遍，结果进 m05-followup-authoring 的缓存；M05 原样调用时命中。
 *
 * 这里与 assess 路由逐步对应（非工作台改方、带签名 M04 的那条路径）。两边一旦不一致，后果只是
 * 缓存未命中（作文缓存的键是实际下发给模型的用户消息），不会拿错结果；test:latency-prefetch-caches
 * 用「先预取、再真实调用 assess 路由、模型只被调一次」钉住两边同形。
 * `CDSS_M05_PREFETCH=false` 关闭。
 */
export function prefetchAssessFollowupFromSignedPrescribe(requestCaseState: CaseState, finalPrescribeContent: string): Promise<void> {
  if (process.env.CDSS_M05_PREFETCH === "false") return Promise.resolve();
  return (async () => {
    const reasoning = extractDiagnosisJSON(finalPrescribeContent);
    if (!reasoning || reasoning.stage !== "prescribe" || typeof reasoning.contractSignature !== "string") return;
    await authorFollowupFromPrescribeHandoff(
      requestCaseState,
      reasoning as unknown as CaseState["reasoningPrescribe"],
      stripDiagnosisJSON(finalPrescribeContent).replace(/\[TRUNCATED\]/g, "").trim(),
    );
  })().catch(() => undefined);
}

/**
 * M04 首轮流 → M05 预取（2026-09-28）。上面的签名后预取要等 M04 整段结束（约 13s）才开始作文（约 4s），
 * 前端/调用方 M04 一结束就调 M05 时仍要等 3–4s。而作文的全部 M04 依赖——选中候选的药味与剂数（剂数
 * 决定首次复诊时间）——在首轮流的 `candidate` 对象闭合时（本机 65 例中位约在输出的 49% 处，距 M04 结束
 * 约 6s）就已写定。这里在那一刻按同一条 assess 管线把作文算一遍：
 *  · 药味先过终稿编译的同一段归一（normalizeM04DraftCandidate：药名规范化、剂数/疗程），首次复诊时间
 *    由服务端同一个确定性函数（applyDeterministicFollowUpNode）从剂数算出；
 *  · 只进作文缓存（键 = 实际下发给模型的用户消息）。终稿与原文不一致（被修复轮改过药、药名被规范化、
 *    处方正文带强提示改写了首次复诊时间）时只是不命中，签名后预取照常再算一次，结果不会拿错。
 * 本机 65 例基线：未修复的 26 例 M04 里 24 例原文药味与终稿逐字相同。
 * `CDSS_M05_DRAFT_PREFETCH=false` 单独关闭（`CDSS_M05_PREFETCH=false` 连同签名后预取一起关）。
 */
export function prefetchAssessFollowupFromDraftCandidate(requestCaseState: CaseState, rawCandidate: Record<string, unknown>): Promise<void> {
  if (process.env.CDSS_M05_PREFETCH === "false" || process.env.CDSS_M05_DRAFT_PREFETCH === "false") return Promise.resolve();
  return (async () => {
    const prior = diagnoseReasoningFromState(requestCaseState);
    if (!prior) return;
    const candidate = normalizeM04DraftCandidate(rawCandidate, prior);
    if (!candidate) return;
    const draft = {
      schemaVersion: "tcm-cdss-reasoning-v2",
      stage: "prescribe",
      formula: { candidates: [candidate], patentAndWestern: [], modifications: [] },
    };
    const withFollowUp = extractDiagnosisJSON(applyDeterministicFollowUpNode(
      `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(draft)}\n<!-- DIAGNOSIS_JSON_END -->`,
    ));
    if (!withFollowUp) return;
    await authorFollowupFromPrescribeHandoff(requestCaseState, withFollowUp as unknown as CaseState["reasoningPrescribe"], "");
  })().catch(() => undefined);
}

/** 与 assess/route.ts 同序同参：事实回补 → 安全门 → 选中候选 → 本地处方核对三段 → 作文（只写作文缓存）。 */
async function authorFollowupFromPrescribeHandoff(
  requestCaseState: CaseState,
  reasoningPrescribe: CaseState["reasoningPrescribe"],
  prescriptionText: string,
): Promise<void> {
  const handoff: CaseState = {
    ...requestCaseState,
    prescription: prescriptionText,
    reasoningPrescribe,
    reasoningV2: mergeReasoningStages(diagnoseReasoningFromState(requestCaseState), reasoningPrescribe) || requestCaseState.reasoningV2,
    riskAssessment: undefined,
    followupTimeline: undefined,
    safetyLocked: false,
    phase: "assess",
  };
  const caseState = await maybeAttachClinicalFactsBackstop(handoff, undefined, undefined);
  const gated = withSafetyGate(caseState);
  const diagnoseReasoning = diagnoseReasoningFromState(gated);
  const prescribed = prescribeReasoningFromState(gated);
  const candidateIndex = gated.prescriptionRevision?.candidateIndex ?? resolvePrescriptionCandidateIndex(gated);
  const selectedCandidate = candidateIndex == null ? undefined : prescribed?.formula?.candidates[candidateIndex];
  const postPrescriptionRisk = [
    buildLocalHighRiskHerbPairSection(gated, candidateIndex),
    buildRetainedPrescriptionRiskSection(gated.prescriptionRevision),
    buildPrescriptionInputAdvisorySection(buildPrescriptionInputAdvisories(gated, candidateIndex)),
  ].filter(Boolean).join("\n\n");
  const assessed = withSafetyGate({ ...gated, riskAssessment: postPrescriptionRisk, safetyLocked: deriveSafetyLocked(gated) });
  await authorFollowupForCase(assessed, diagnoseReasoning, selectedCandidate);
}
