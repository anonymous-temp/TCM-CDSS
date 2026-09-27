import type { CaseState } from "./diagnosis-types";
import { extractDiagnosisJSON, stripDiagnosisJSON } from "./diagnosis-parse";
import { STREAM_REPLACE_MARKER } from "./diagnosis-stream-protocol";
import { buildExternalEvidenceContext } from "./evimed-guide";
import { normalizeCaseTextForFormulaRecall } from "./formula-recall-normalization.server";
import { assistedPolarityDecisions } from "./polarity-negation-assist.server";
import { rerankSyndromeHypothesesForFormulaRecall } from "./syndrome-hypothesis-rerank.server";
import { sanitizeCaseStateForModel, withSafetyGate } from "./diagnosis-safety";
import { planEvidenceBoundMedicineCandidates } from "./medicine-candidate-planner.server";

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
