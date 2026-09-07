export const STREAM_REPLACE_MARKER = "<<<CDSS_STREAM_FINAL>>>";

export const M03_DRAFT_MODULES = [
  "m03.western",
  "m03.syndrome",
  "m03.pathogenesis",
  "m03.therapy",
] as const;

export type M03DraftModule = (typeof M03_DRAFT_MODULES)[number];
export const M04_DRAFT_MODULES = ["m04.candidate"] as const;
export type StreamDraftModule = M03DraftModule | (typeof M04_DRAFT_MODULES)[number];

export type StreamModuleDraftFrame = {
  type: "module_draft";
  module: StreamDraftModule;
  revision: number;
  content: string;
  contentKind?: "clinical_draft";
};

export function parseStreamModuleDraftFrame(value: unknown): StreamModuleDraftFrame | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    row.type !== "module_draft" ||
    ![...M03_DRAFT_MODULES, ...M04_DRAFT_MODULES].includes(row.module as StreamDraftModule) ||
    !Number.isInteger(row.revision) ||
    Number(row.revision) < 1 ||
    typeof row.content !== "string" ||
    !row.content.trim() ||
    row.content.length > 8_000
  ) {
    return null;
  }
  return {
    type: "module_draft", module: row.module as StreamDraftModule,
    revision: Number(row.revision), content: row.content,
    ...(row.contentKind === "clinical_draft" ? { contentKind: "clinical_draft" as const } : {}),
  };
}

/**
 * ── 心跳阶段名（2026-08-27 实测缺陷）────────────────────────────────────────────
 *
 * 服务端每 5s 下发一帧 `{type:"heartbeat",status}`，M03/M04 的消费器把 status 直接追加到
 * 医生可见的进度卡里（diagnosis-engine.ts：`[visible, status].join("\n\n")`）。
 * 但阶段名此前只由 contentChars/reasoningChars 推断——这两个计数在**首稿流结束后就不再变**，
 * 于是独立复核（5–15s）与逐轮定稿修订（每轮 40–50s）全程都在报「模型正在组织临床正文」。
 * 实测 M04 中位 43.6s 里，有相当一段医生读到的是一句与实际不符的进度。
 *
 * 心跳只报告已知编排阶段。独立 module_draft 帧提供标记为未定稿的只读临床预览，
 * 不进入最终报告、处方编辑器或 HIS 输入；剂量仍由最终签名报告提供。
 */
export const STAGE_PROGRESS_PHASES = ["draft", "review", "repair"] as const;

export type StageProgressPhase = (typeof STAGE_PROGRESS_PHASES)[number];

export const STAGE_PROGRESS_HEARTBEAT_SUFFIX = "，服务保持响应并持续校验";

export function stageProgressHeartbeatStatus(input: {
  phase: StageProgressPhase;
  structuredStage: "diagnose" | "prescribe" | undefined;
  contentChars: number;
  reasoningChars: number;
  repairRound: number;
}): string {
  const { phase, structuredStage, contentChars, reasoningChars, repairRound } = input;
  if (phase === "review") {
    const label = structuredStage === "prescribe"
      ? "正在独立复核处方安全性与方证一致性"
      : structuredStage === "diagnose"
        ? "正在独立复核辨病辨证依据"
        : "正在独立复核本节结论";
    return `${label}${STAGE_PROGRESS_HEARTBEAT_SUFFIX}`;
  }
  if (phase === "repair") {
    // 轮次对医生是有用的信息：它说明「还在改」而不是「卡住了」。轮次上限由编排时限兜底，
    // 这里不做封顶，但至少从第 1 轮起计（0 轮不会进入 repair 阶段）。
    const round = Number.isFinite(repairRound) && repairRound > 0 ? Math.floor(repairRound) : 1;
    return `正在按复核意见第 ${round} 轮修订定稿${STAGE_PROGRESS_HEARTBEAT_SUFFIX}`;
  }
  const label = contentChars === 0 && reasoningChars > 0
    ? "模型正在进行深度推理"
    : contentChars > 0
      ? "模型正在组织临床正文"
      : "正在等待模型开始响应";
  return `${label}${STAGE_PROGRESS_HEARTBEAT_SUFFIX}`;
}
