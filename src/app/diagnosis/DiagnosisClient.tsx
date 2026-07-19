// src/app/diagnosis/page.tsx
"use client";

import { useState, useRef, useEffect, useCallback, useMemo, type ReactNode } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Activity,
  AlertTriangle,
  BookOpen,
  Brain,
  Check,
  ChevronDown,
  Circle,
  ClipboardList,
  Download,
  FileText,
  History,
  ImageIcon,
  Loader2,
  Lock,
  MessageSquare,
  Pill,
  Plus,
  RefreshCw,
  Stethoscope,
  X,
} from "lucide-react";
import { appendClinicalPresetValue, appendDelimitedValue, detectTonguePulseFieldConflict } from "@/lib/clinical-entry";
import type { CaseState, ClinicalReasoningResultV2, HisRecordSnapshot, Phase, SafetyGate } from "@/lib/diagnosis-types";
import { ageValue, normalizeCaseStateInput } from "@/lib/diagnosis-types";
import {
  saveCase, loadLatestCase, clearCase, clearAllSavedCases, isBrowserCasePersistenceEnabled,
  sanitizeCaseStateForBrowserPersistence, scrubPersistentPhiText,
  consumeCollectStream, consumeMarkdownStream,
  applyCollectResult, applyQuestionResult, applyUserAnswer,
  setPhase, setError, newCase,
} from "@/lib/diagnosis-engine";
import {
  diagnoseReasoningFromState,
  mergeReasoningStages,
  parseReasoningV2,
  prescribeReasoningFromState,
  stripDiagnosisJSON,
} from "@/lib/diagnosis-parse";
import { hasExecutableSignedM03, isDisplayableClinicalText } from "@/lib/diagnosis-client-guards";
import { computePrescriptionVersionHash } from "@/lib/prescription-version";
import { containsUnknownClinicalCue, isUnknownClinicalText } from "@/lib/clinical-state";
import { computeTongueRoiCrop, detectTongueRoi } from "@/lib/tongue-image-roi";
import { LINEAGE_OPTIONS, getLineageCard, getLineageQuestionStrategy, lineageLabel } from "@/lib/tcm-lineages";
import { customerEvidenceDisplayStatus, sanitizeCustomerEvidenceNarrative, sanitizeLabeledEvidenceLines } from "@/lib/customer-evidence";
import {
  buildDeterministicRiskFollowup,
  buildSafetyLimitedPrescription,
  derivePrescriptionPermission,
  deriveSafetyLocked,
  detectProgrammaticRedFlags,
  evaluateSafetyGate,
  hasActionableM03Diagnosis,
  isLimitedDiagnosisText,
  isRiskLineNegatedOrEnumerative,
  reconcileRestoredCaseState,
  sanitizeFreeTextForExternalClinicalService,
  withSafetyGate,
} from "@/lib/diagnosis-safety";
import { markdownUrlTransform as urlTransform } from "@/lib/safe-url";
import { parseEvidenceDisplayReferences, splitEvidenceReferenceItems, type EvidenceDisplayReference } from "@/lib/evidence-display";
import { isEncryptedSnapshotEnvelope } from "@/lib/encrypted-snapshot";
import { FORMULA_STRUCTURE_TARGETS, type FormulaStructureRole } from "@/lib/herb-target-contract";
import { parseRxAuditStatusMarker, stripRxAuditStatusMarker } from "@/lib/rxaudit-status";
import { buildSeasonalCare } from "@/lib/tcm-seasonal-care";
import { sanitizeDiagnoseStreamingDraft } from "@/lib/diagnosis-stream-safety";
import { parseClinicalFacts, type ClinicalFacts } from "@/lib/clinical-facts";
import {
  isCompoundAffirmativeQuestionOption,
  parseM02PlanFromContent,
  type M02Plan,
  type M02TargetField,
} from "@/lib/m02-question-contract";

const APP_BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || "";
const BROWSER_CASE_PERSISTENCE_ENABLED = isBrowserCasePersistenceEnabled();
const DIAGNOSIS_REQUEST_TIMEOUT_MS = 210_000;
const MAX_SHORT_INPUT_CHARS = 200;
const MAX_LONG_INPUT_CHARS = 3000;
const MAX_CASE_SUPPLEMENT_CHARS = 6000;
const MAX_MODEL_INPUT_CHARS = 12000;
const MAX_CONVERSATION = 10;
const TONGUE_VISION_STATUS_TIMEOUT_MS = 5000;
const DIAGNOSIS_STREAM_IDLE_TIMEOUT_MS = 195_000;
// The complete primary attempt, validation and bounded repair share one 180s server deadline.
// Keep only a small browser transport margin beyond that hard clinical-stage ceiling.
const DIAGNOSIS_STREAM_TOTAL_TIMEOUT_MS = 210_000;
const WORKSPACE_RESTORE_TIMEOUT_MS = 8_000;
const HERB_FUNCTION_LOOKUP_TIMEOUT_MS = 8_000;
const RED_FLAG_SEMANTIC_TIMEOUT_MS = 12_000;
const HERB_FUNCTION_LOOKUP_DEBOUNCE_MS = 250;
const MAX_TONGUE_IMAGE_INPUT_BYTES = 8 * 1024 * 1024;
const ALLOWED_TONGUE_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function apiUrl(path: string): string {
  return `${APP_BASE_PATH}${path}`;
}

async function fetchTcmHerbFunction(herb: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(apiUrl("/api/tcm-knowledge/herb-function"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ herb }),
    cache: "no-store",
    signal,
  });
  const body = await response.json().catch(() => null) as { functionText?: unknown } | null;
  if (!response.ok) throw new Error("中药功效查询失败");
  return typeof body?.functionText === "string" ? body.functionText.trim() : "";
}

async function isTongueVisionAvailable(): Promise<boolean> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), TONGUE_VISION_STATUS_TIMEOUT_MS);
  try {
    const res = await fetch(apiUrl("/api/model-health"), {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!res.ok) return false;
    const body = await res.json().catch(() => null) as { diagnosis?: { tongueVision?: { configured?: boolean } } } | null;
    return body?.diagnosis?.tongueVision?.configured === true;
  } catch {
    return false;
  } finally {
    window.clearTimeout(timeout);
  }
}

// Handle to the in-flight M01→M05 request chain so it can be cancelled on unmount or when a new run
// starts. This page renders a single DiagnosisClient instance, so a module-level handle is sufficient
// and avoids threading an AbortSignal through every stage fetch.
let activeRunAbortController: AbortController | null = null;

async function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit, timeoutMs = DIAGNOSIS_REQUEST_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  const runController = activeRunAbortController;
  const onRunAbort = () => controller.abort();
  if (runController) {
    if (runController.signal.aborted) controller.abort();
    else runController.signal.addEventListener("abort", onRunAbort, { once: true });
  }
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(runController?.signal.aborted ? "推理已取消" : "请求超时，请重试");
    }
    throw new Error(normalizeRequestError(error));
  } finally {
    window.clearTimeout(timeout);
    runController?.signal.removeEventListener("abort", onRunAbort);
  }
}

async function fetchJsonWithTimeout<T>(
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs = DIAGNOSIS_REQUEST_TIMEOUT_MS,
): Promise<{ response: Response; body: T | null }> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  const runController = activeRunAbortController;
  const onRunAbort = () => controller.abort();
  if (runController) {
    if (runController.signal.aborted) controller.abort();
    else runController.signal.addEventListener("abort", onRunAbort, { once: true });
  }
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    const raw = await response.text();
    let body: T | null = null;
    try {
      body = raw ? JSON.parse(raw) as T : null;
    } catch {
      body = null;
    }
    return { response, body };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(runController?.signal.aborted ? "推理已取消" : "请求超时，请重试");
    }
    throw new Error(normalizeRequestError(error));
  } finally {
    window.clearTimeout(timeout);
    runController?.signal.removeEventListener("abort", onRunAbort);
  }
}

type RedFlagSemanticResponse = {
  available?: boolean;
  clinicalFacts?: ClinicalFacts | null;
  safetyGate?: SafetyGate;
};

function unavailableClinicalFacts(reason: ClinicalFacts["unavailableReason"]): ClinicalFacts {
  return {
    redFlags: [],
    semanticStatus: "unavailable",
    resultSource: "failure",
    unavailableReason: reason,
  };
}

async function refreshClinicalSafetyFacts(state: CaseState): Promise<CaseState> {
  try {
    const { response, body } = await fetchJsonWithTimeout<RedFlagSemanticResponse>(apiUrl("/api/diagnosis/red-flags"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ caseState: state }),
    }, RED_FLAG_SEMANTIC_TIMEOUT_MS);
    if (!response.ok || !body) {
      return withSafetyGate({ ...state, clinicalFacts: unavailableClinicalFacts("model_error") });
    }
    const clinicalFacts = parseClinicalFacts(body.clinicalFacts);
    return withSafetyGate({
      ...state,
      clinicalFacts: clinicalFacts || unavailableClinicalFacts("invalid_output"),
    });
  } catch (error) {
    if (activeRunAbortController?.signal.aborted) throw error;
    // Preserve the outage as data instead of turning "not checked" into an apparent negative screen.
    // The workflow may continue with a visibly limited candidate, while formal adoption still relies
    // on fresh server-side contracts.
    return withSafetyGate({ ...state, clinicalFacts: unavailableClinicalFacts("timeout") });
  }
}

// Start a fresh cancellable run scope, aborting any previous in-flight chain.
function beginRunScope(): void {
  activeRunAbortController?.abort();
  activeRunAbortController = new AbortController();
}

export function abortDiagnosisRun(controller: AbortController | null): boolean {
  if (!controller || controller.signal.aborted) return false;
  controller.abort();
  return true;
}

type RunningStageClock = {
  phase: Phase;
  startedAt: number;
};

export function nextRunningStageClock(
  current: RunningStageClock | null,
  phase: Phase,
  now: number,
): RunningStageClock {
  return current?.phase === phase ? current : { phase, startedAt: now };
}

export function runningStageElapsedSeconds(
  clock: RunningStageClock | null,
  phase: Phase,
  now: number,
): number {
  if (!clock || clock.phase !== phase) return 0;
  return Math.max(0, Math.floor((now - clock.startedAt) / 1000));
}

function streamConsumeOptions() {
  return {
    idleTimeoutMs: DIAGNOSIS_STREAM_IDLE_TIMEOUT_MS,
    totalTimeoutMs: DIAGNOSIS_STREAM_TOTAL_TIMEOUT_MS,
    abortSignal: activeRunAbortController?.signal,
  };
}

function normalizeRequestError(error: unknown, fallback = "请求失败，请稍后重试"): string {
  if (error instanceof DOMException && error.name === "AbortError") return "请求超时，请重试";
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (/Failed to fetch|NetworkError|Load failed|ERR_FAILED|Network request failed/i.test(raw)) {
    return "网络连接失败或智能推理服务暂不可达，请检查网络后重试。";
  }
  if (/body stream|network connection was lost|The operation couldn.t be completed|terminated/i.test(raw)) {
    return "内容生成中断，请检查网络后重新生成本节内容。";
  }
  return raw.trim() || fallback;
}

async function readErrorMessage(res: Response, fallback: string): Promise<string> {
  if (res.status === 401) {
    // Session/token expired. The generic "retry" path would loop forever against the same stale
    // cookie, so send the doctor to re-login (preserving where they were) instead.
    if (typeof window !== "undefined") {
      const next = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.href = apiUrl(`/login?next=${next}`);
    }
    return "登录已过期，请重新登录后继续。";
  }
  const body = await res.json().catch(() => null) as { error?: unknown } | null;
  return typeof body?.error === "string" && body.error.trim()
    ? body.error.trim()
    : fallback;
}

// ─── Markdown helpers ─────────────────────────────────────────────────────────

const markdownComponents = {
  img: ({ alt }: React.ImgHTMLAttributes<HTMLImageElement>) => (
    <span className="my-2 inline-flex rounded border border-amber-200 bg-amber-50 px-2 py-1 text-[12px] font-medium text-amber-700">
      已隐藏外部图片{alt ? `：${alt}` : ""}
    </span>
  ),
  table: ({ children, ...props }: React.TableHTMLAttributes<HTMLTableElement>) => (
    <div className="not-prose my-3 block w-full max-w-full overflow-x-auto rounded-xl border border-gray-200 bg-white">
      <table className="w-max min-w-[820px] border-separate border-spacing-0 text-left text-xs" {...props}>
        {children}
      </table>
    </div>
  ),
  th: ({ children, ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) => (
    <th className="border-b border-gray-200 bg-gray-50 px-3 py-2 align-top font-semibold text-gray-700" {...props}>
      {children}
    </th>
  ),
  td: ({ children, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) => (
    <td className="border-b border-gray-100 px-3 py-2 align-top leading-relaxed text-gray-700" {...props}>
      {children}
    </td>
  ),
};

// ─── Image compression ──────────────────────────────────────────────────────

async function fileToCompressedBase64(
  file: File,
  maxSizeBytes = 4 * 1024 * 1024,
): Promise<{ base64: string; roiMethod: "detected" | "fallback-center" }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        try {
          const sourceWidth = img.naturalWidth || img.width;
          const sourceHeight = img.naturalHeight || img.height;
          // Content-aware ROI: classic-CV tongue/lip tissue detection on a small analysis
          // canvas, mapped back to full resolution. Advisory only — any failure keeps the
          // conservative center crop; the doctor always confirms the preview before upload.
          let crop = computeTongueRoiCrop(sourceWidth, sourceHeight);
          let roiMethod: "detected" | "fallback-center" = "fallback-center";
          try {
            const ANALYSIS_MAX_DIM = 256;
            const analysisRatio = Math.min(1, ANALYSIS_MAX_DIM / Math.max(sourceWidth, sourceHeight));
            const analysisWidth = Math.max(1, Math.round(sourceWidth * analysisRatio));
            const analysisHeight = Math.max(1, Math.round(sourceHeight * analysisRatio));
            const analysisCanvas = document.createElement("canvas");
            analysisCanvas.width = analysisWidth;
            analysisCanvas.height = analysisHeight;
            const analysisCtx = analysisCanvas.getContext("2d", { willReadFrequently: true });
            if (analysisCtx) {
              analysisCtx.drawImage(img, 0, 0, analysisWidth, analysisHeight);
              const detected = detectTongueRoi(analysisCtx.getImageData(0, 0, analysisWidth, analysisHeight));
              if (detected.method === "detected") {
                const scaleX = sourceWidth / analysisWidth;
                const scaleY = sourceHeight / analysisHeight;
                const dx = Math.min(Math.max(0, Math.round(detected.x * scaleX)), sourceWidth - 1);
                const dy = Math.min(Math.max(0, Math.round(detected.y * scaleY)), sourceHeight - 1);
                const dw = Math.min(Math.max(1, Math.round(detected.w * scaleX)), sourceWidth - dx);
                const dh = Math.min(Math.max(1, Math.round(detected.h * scaleY)), sourceHeight - dy);
                crop = { x: dx, y: dy, width: dw, height: dh };
                roiMethod = "detected";
              }
            }
          } catch {
            // ROI detection is advisory only — never block the upload on it.
          }
          const canvas = document.createElement("canvas");
          let width = crop.width;
          let height = crop.height;
          const MAX_DIM = 2048;
          if (width > MAX_DIM || height > MAX_DIM) {
            const ratio = Math.min(MAX_DIM / width, MAX_DIM / height);
            width = Math.round(width * ratio);
            height = Math.round(height * ratio);
          }
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext("2d");
          if (!ctx) throw new Error("canvas unavailable");
          ctx.drawImage(img, crop.x, crop.y, crop.width, crop.height, 0, 0, width, height);
          let quality = 0.85;
          let dataUrl = canvas.toDataURL("image/jpeg", quality);
          while (dataUrl.length * 0.75 > maxSizeBytes && quality > 0.3) {
            quality -= 0.1;
            dataUrl = canvas.toDataURL("image/jpeg", quality);
          }
          if (dataUrl.length * 0.75 > maxSizeBytes) {
            throw new Error("compressed image too large");
          }
          resolve({ base64: dataUrl, roiMethod });
        } catch (error) {
          reject(error);
        }
      };
      img.onerror = () => reject(new Error("image decode failed"));
      img.src = reader.result as string;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ─── Phase config ─────────────────────────────────────────────────────────────

const VALID_PHASES: Phase[] = ["collect", "question", "diagnose", "prescribe", "assess"];

const PHASE_STEPS: { phase: Phase; label: string }[] = [
  { phase: "collect",   label: "病历采集"  },
  { phase: "question",  label: "重点追问"  },
  { phase: "diagnose",  label: "辨病辨证"  },
  { phase: "prescribe", label: "候选方药"  },
  { phase: "assess",    label: "审方随访"  },
];

const PHASE_ORDER: Phase[] = ["idle", "collect", "question", "diagnose", "prescribe", "assess", "done", "error"];

function phaseIndex(phase: Phase): number {
  return PHASE_ORDER.indexOf(phase);
}

type StepStatus = "todo" | "doing" | "done" | "error" | "limited" | "blocked" | "skipped";

function hasActionableDiagnosisOutput(caseState: CaseState): boolean {
  return hasExecutableM03Diagnosis(caseState);
}

export function getStepStatus(caseState: CaseState, step: typeof PHASE_STEPS[0]): StepStatus {
  const stepIdx = phaseIndex(step.phase);
  if (
    step.phase === "prescribe" &&
    caseState.safetyGate?.status === "red_flag" &&
    !caseState.prescription &&
    ["assess", "done", "error"].includes(caseState.phase)
  ) return "skipped";
  if (caseState.phase === "error" && caseState.lastError) {
    const failedStepIdx = phaseIndex(caseState.lastError.phase);
    if (stepIdx < failedStepIdx) return "done";
    if (stepIdx === failedStepIdx) return "error";
    // A failed/cancelled stage stops the chain: downstream stages never ran, so they must read as
    // "not executed" instead of looking like a pending or in-progress step.
    return "blocked";
  }
  const currentPhaseIdx = phaseIndex(caseState.phase);
  if (caseState.phase === "done") {
    const summary = buildDecisionSummary(caseState);
    const activeReasoning = mergeReasoningStages(diagnoseReasoningFromState(caseState), prescribeReasoningFromState(caseState)) || caseState.reasoningV2;
    const hasDosePrescription = hasGeneratedDosePrescription(summary, activeReasoning);
    if (step.phase === "collect") return "done";
    // This strip reports pipeline execution, while sufficiency and safety keep their own cards.
    // Once the case reaches a terminal result, M02 either supplied a focused question round or
    // explicitly decided that no round was needed; missing optional facts must not look like a
    // failed workflow stage here.
    if (step.phase === "question") return caseState.questionOutcome === "skipped" ? "skipped" : "done";
    if (step.phase === "diagnose") return hasActionableDiagnosisOutput(caseState) ? "done" : "limited";
    if (step.phase === "prescribe") return hasDosePrescription ? "done" : "limited";
    if (step.phase === "assess") {
      if (!caseState.riskAssessment) return "limited";
      if (!hasDosePrescription) return caseState.safetyGate?.status === "red_flag" ? "done" : "limited";
      return caseState.auditAdvisory?.available === false ? "limited" : "done";
    }
  }
  if (stepIdx < currentPhaseIdx) return "done";
  if (stepIdx === currentPhaseIdx) return "doing";
  return "todo";
}

function extractSectionLoose(text: string | undefined, titles: string[]): string {
  if (!text) return "";
  const escapedTitles = titles.map((title) => title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const headingRegex = new RegExp(`^(#{1,4})\\s*(?:【)?(?:${escapedTitles})(?:】)?\\s*(?:[：:]\\s*([^\\n]+))?\\s*$`, "im");
  const heading = headingRegex.exec(text);
  if (!heading) return "";
  const level = heading[1]?.length ?? 2;
  const start = heading.index + heading[0].length;
  const rest = text.slice(start).replace(/^\s*\n/, "");
  const nextHeading = rest.search(new RegExp(`^#{1,${level}}\\s`, "m"));
  const inline = heading[2]?.trim();
  const body = (nextHeading === -1 ? rest : rest.slice(0, nextHeading)).trim();
  return [inline, body].filter(Boolean).join("\n").trim();
}

function extractFirstMatch(text: string | undefined, patterns: RegExp[]): string {
  if (!text) return "";
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]?.trim()) return match[1].trim();
  }
  return "";
}

function normalizeClinicalText(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/&nbsp;/gi, " ")
    .replace(/Safe Mode\s*[（(][^。\n|）)]*[）)]/gi, "信息不足安全建议")
    .replace(/Safe Mode/gi, "信息不足安全建议")
    .replace(/参考西医诊断|现代医学风险\/需排除方向/g, "西医诊断")
    .replace(/中成药替代方案/g, "西药/中成药方案")
    .replace(/((?:西医诊断|现代医学风险\/需排除方向)[^\n|]*?[：:\t ]+[^。\n|]*?)([^；。\n|]+)[？?]/g, (_match, prefix: string, phrase: string) => `${prefix}${phrase.trim()}待排除`)
    .replace(/(\|\s*(?:西医诊断|现代医学风险\/需排除方向)\s*\|\s*[^|\n]*?)([^；。|\n]+)[？?]/g, (_match, prefix: string, phrase: string) => `${prefix}${phrase.trim()}待排除`);
}

function sanitizeCustomerEvidenceSurface(text: string): string {
  return sanitizeCustomerEvidenceNarrative(text)
    .replace(/^.*(?:内部检索状态|AUTO_PARSED_NEEDS_REVIEW).*$/gm, "")
    .replace(/(?:证据不足\s*[/／]\s*待检索|依据待检索|引用待检索|证据来源待核验|证据URL待核验|内部证据缺口)/g, "")
    .replace(/<!--\s*EVIDENCE_GAP:[^>]+-->/g, "")
    .replace(/^\s*(?:[-*]\s*)?\*\*(?:证据依据|来源依据|参考依据|引用来源|方剂出处或依据)\*\*[：:]\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanInlineMarkdown(text: string): string {
  return normalizeClinicalText(text)
    .replace(/^#{1,6}\s*/, "")
    .replace(/\*\*/g, "")
    .replace(/^\s*[-*]\s*/, "")
    .replace(/^\s*\|?[-\s:：]+\|?\s*$/, "")
    .trim();
}

function isLikelyTableHeaderValue(value: string): boolean {
  return /^(内容|支持证据|证据支持|证据依据|来源依据|反证\/冲突点|反证\/限制|缺失信息|置信度|下一步|主次权重|子治疗方向|用药定位|对应问题|联用\/替代关系|风险提示|医生复核点|安全标签|君臣佐使|药物定位|对应病机|对应证候|对应症状|配伍意义|建议剂量范围|炮制\/规格)$/i.test(value);
}

function extractField(text: string | undefined, labels: string[]): string {
  if (!text) return "";
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const patterns = [
      new RegExp(`\\*\\*${escaped}\\*\\*\\s*[：:]\\s*([^\\n|]+)`),
      new RegExp(`^\\s*[-*]?\\s*${escaped}\\s*[：:]\\s*([^\\n|]+)`, "m"),
      new RegExp(`\\|\\s*${escaped}\\s*\\|\\s*([^|\\n]+)\\|`),
    ];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      const value = cleanInlineMarkdown(match?.[1] ?? "");
      if (isLikelyTableHeaderValue(value)) continue;
      if (value) return value;
    }
  }
  return "";
}

function normalizeWesternDiagnosis(value: string): string {
  if (!value) return "";
  return value
    .replace(/([^；。！？?]+)[？?]/g, (_match, phrase: string) => `${phrase.trim()}待排除`)
    .replace(/是否存在/g, "需排除")
    .trim();
}

function extractTableFirstColumnValues(section: string | undefined, max = 3): string {
  if (!section) return "";
  const values: string[] = [];
  for (const line of section.split("\n")) {
    if (!line.trim().startsWith("|") || /---/.test(line)) continue;
    const cells = line.split("|").map((cell) => cleanInlineMarkdown(cell)).filter(Boolean);
    const first = cells[0];
    if (!first || /候选证候|证候|维度|项目|检查项|药名/.test(first)) continue;
    if (!values.includes(first)) values.push(first);
    if (values.length >= max) break;
  }
  return values.join("；");
}

function firstMeaningfulLine(text: string | undefined): string {
  if (!text) return "";
  for (const raw of text.split("\n")) {
    const line = cleanInlineMarkdown(raw.replace(/\|/g, " "));
    if (!line || /^[-:：\s]+$/.test(line) || /^(项目|内容|---)/.test(line)) continue;
    return line;
  }
  return "";
}

function compactMarkdown(text: string, max = 520): string {
  const clean = text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (clean.length <= max) return clean || "暂无";
  return `${clean.slice(0, max).trim()}...`;
}

type MarkdownTable = {
  headers: string[];
  rows: string[][];
};

type PrescriptionCandidate = {
  label: string;
  name: string;
  body: string;
  metadata: Record<string, string>;
  herbTable?: MarkdownTable;
};

type FollowupTimelineItem = {
  time: string;
  action: string;
  indicators: string;
  trigger: string;
};

function splitMarkdownTableCells(line: string): string[] {
  const trimmed = line.trim();
  const inner = trimmed.startsWith("|") && trimmed.endsWith("|")
    ? trimmed.slice(1, -1)
    : trimmed;
  return splitEscapedPipes(inner).map((cell) => cleanInlineMarkdown(cell));
}

function isMarkdownSeparator(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?[-—–]{2,}:?$/.test(cell.replace(/\s/g, "")));
}

function hasTablePipes(line: string): boolean {
  return (line.match(/\|/g) || []).length >= 2;
}

function splitEscapedPipes(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === "|" && line[i - 1] !== "\\") {
      cells.push(current);
      current = "";
    } else if (char === "\\" && line[i + 1] === "|") {
      current += "|";
      i += 1;
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

function parseMarkdownTables(text: string | undefined): MarkdownTable[] {
  if (!text) return [];
  const lines = text.split("\n");
  const tables: MarkdownTable[] = [];
  let i = 0;

  while (i < lines.length - 1) {
    const headerLine = lines[i] ?? "";
    const separatorLine = lines[i + 1] ?? "";
    if (!hasTablePipes(headerLine) || !hasTablePipes(separatorLine)) {
      i += 1;
      continue;
    }

    const headers = splitMarkdownTableCells(headerLine);
    const separator = splitMarkdownTableCells(separatorLine);
    if (!isMarkdownSeparator(separator)) {
      i += 1;
      continue;
    }

    const rows: string[][] = [];
    let j = i + 2;
    while (j < lines.length && hasTablePipes(lines[j] ?? "")) {
      const row = splitMarkdownTableCells(lines[j] ?? "");
      if (!isMarkdownSeparator(row)) rows.push(row);
      j += 1;
    }

    tables.push({ headers, rows });
    i = j;
  }

  let tabIndex = 0;
  while (tabIndex < lines.length) {
    if (!(lines[tabIndex] ?? "").includes("\t")) {
      tabIndex += 1;
      continue;
    }

    const headers = (lines[tabIndex] ?? "").split("\t").map((cell) => cleanInlineMarkdown(cell));
    if (headers.length < 3 || isMarkdownSeparator(headers)) {
      tabIndex += 1;
      continue;
    }

    const rows: string[][] = [];
    let rowIndex = tabIndex + 1;
    while (rowIndex < lines.length && (lines[rowIndex] ?? "").includes("\t")) {
      const row = (lines[rowIndex] ?? "").split("\t").map((cell) => cleanInlineMarkdown(cell));
      if (!isMarkdownSeparator(row) && row.some(Boolean)) rows.push(row);
      rowIndex += 1;
    }

    if (rows.length > 0) tables.push({ headers, rows });
    tabIndex = rowIndex;
  }

  return tables;
}

function normalizeHeader(value: string): string {
  return value.replace(/\s/g, "").replace(/[（）()]/g, "").toLowerCase();
}

function headerMatches(header: string, aliases: string[]): boolean {
  const normalizedHeader = normalizeHeader(header);
  return aliases.some((alias) => {
    const normalizedAlias = normalizeHeader(alias);
    return normalizedHeader.includes(normalizedAlias) || normalizedAlias.includes(normalizedHeader);
  });
}

function findTableByHeaders(text: string | undefined, requiredHeaders: string[]): MarkdownTable | undefined {
  return parseMarkdownTables(text).find((table) =>
    requiredHeaders.every((required) =>
      table.headers.some((header) => headerMatches(header, [required])) ||
      normalizeHeader(table.headers.join("")).includes(normalizeHeader(required))
    )
  );
}

function findTableByAnyHeaders(text: string | undefined, aliases: string[]): MarkdownTable | undefined {
  return parseMarkdownTables(text).find((table) =>
    table.headers.some((header) => headerMatches(header, aliases)) ||
    aliases.some((alias) => normalizeHeader(table.headers.join("")).includes(normalizeHeader(alias)))
  );
}

function getTableCell(table: MarkdownTable, row: string[], aliases: string[]): string {
  const index = table.headers.findIndex((header) => headerMatches(header, aliases));
  if (index < 0) return "";
  return cleanInlineMarkdown(row[index] ?? "");
}

function clipText(text: string, max = 96): string {
  const cleaned = cleanInlineMarkdown(text).replace(/\s+/g, " ");
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max).trim()}...`;
}

function parsePrescriptionCandidates(section: string | undefined): PrescriptionCandidate[] {
  if (!section) return [];
  const matches = Array.from(section.matchAll(/^###\s*(候选(?:处方|方案)\s*\d*)[：:]\s*([^\n]+)/gm));
  const metadataLabels = [
    "处方定位",
    "适用条件",
    "不适用条件",
    "经典方出处",
    "方剂资料收载来源",
    "组方依据",
    "方剂出处或依据",
    "证据依据",
    "加减逻辑",
    "加减思路",
    "剂数",
    "煎服法",
    "疗程建议",
    "疗程",
    "注意事项",
  ];

  const buildCandidate = (label: string, name: string, body: string): PrescriptionCandidate => {
    const metadata = metadataLabels.reduce<Record<string, string>>((acc, labelName) => {
      const value = extractField(body, [labelName]);
      if (value) acc[labelName] = value;
      return acc;
    }, {});
    return {
      label: cleanInlineMarkdown(label || "候选处方"),
      name: cleanInlineMarkdown(name || extractField(body, ["方剂", "推荐处方"]) || firstMeaningfulLine(body)),
      body: body.trim(),
      metadata,
      herbTable: findTableByHeaders(body, ["药名", "剂量"]),
    };
  };

  if (matches.length === 0) {
    const table = findTableByHeaders(section, ["药名", "剂量"]);
    if (!table) return [];
    return [buildCandidate("候选处方1", extractField(section, ["处方名称", "方剂", "推荐处方"]) || "中药饮片候选处方", section)];
  }

  return matches.map((match, index) => {
    const start = match.index + match[0].length;
    const end = matches[index + 1]?.index ?? section.length;
    return buildCandidate(match[1] ?? `候选处方${index + 1}`, match[2] ?? "", section.slice(start, end));
  });
}

function meaningfulField(...values: Array<string | undefined>): string {
  return values.find((value) => value && cleanInlineMarkdown(value))?.trim() ?? "";
}

function isCustomerEvidencePlaceholder(value?: string): boolean {
  const clean = cleanInlineMarkdown(value || "");
  return !isDisplayableClinicalText(clean) ||
    /(?:基于本例|病例内推理|模型推断|结构化匹配|患者事实与症状推断)/.test(clean);
}

function parseFollowupTimelineItems(section: string | undefined): FollowupTimelineItem[] {
  const table =
    findTableByHeaders(section, ["时间点", "医生/患者动作"]) ||
    findTableByAnyHeaders(section, ["时间点", "观察指标", "触发处置"]);
  if (!table) return [];
  return dedupeFollowupTimelineItems(table.rows
    .map((row) => ({
      time: getTableCell(table, row, ["时间点"]),
      action: getTableCell(table, row, ["医生/患者动作", "患者动作", "医生动作", "动作"]),
      indicators: getTableCell(table, row, ["观察指标", "指标"]),
      trigger: getTableCell(table, row, ["触发处置", "处置"]),
    }))
    .filter((item) => item.time || item.action));
}

function dedupeFollowupTimelineItems(items: FollowupTimelineItem[]): FollowupTimelineItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = [item.time, item.action, item.indicators, item.trigger]
      .map((value) => cleanInlineMarkdown(value || "").replace(/\s+/g, ""))
      .join("|");
    if (!key.replace(/\|/g, "") || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function redFlagStatusForCase(caseState: CaseState) {
  const gate = evaluateSafetyGate(caseState);
  const redFlags = gate.redFlags.length > 0 ? gate.redFlags : detectProgrammaticRedFlags(caseState);
  if (redFlags.length > 0) {
    return { label: "高风险", tone: "red", desc: redFlags[0] || "命中程序化红旗指征" };
  }
  if ((gate.advisories || []).length > 0) {
    return { label: "需关注", tone: "yellow", desc: gate.advisories?.[0] || "当前信息提示需优先复核的临床线索。" };
  }
  const redFlagText = extractSectionLoose(caseState.diagnosis, ["红旗排查", "红旗指征", "红旗风险", "红旗预警"]);
  const redFlagLines = redFlagText.split("\n").map((line) => cleanInlineMarkdown(line).trim()).filter(Boolean);
  const highRiskLine = redFlagLines.find((line) => {
    if (isRiskLineNegatedOrEnumerative(line)) return false;
    return /(?:^|[\t|：:\s])高风险(?:[\t|。；,\s]|$)/.test(line) ||
      /(?:红旗状态|风险等级|综合判断|结果)[\t|：:\s]+高风险/.test(line) ||
      /^(建议)?(急诊|转诊|立即转诊|需转诊|危急值|急危重)/.test(line);
  });
  if (highRiskLine) {
    return { label: "高风险", tone: "red", desc: firstMeaningfulLine(redFlagText) || "当前资料提示高风险，需医生优先复核。" };
  }
  const concernLine = redFlagLines.find((line) => /(需关注|待排除|需排除|警惕|建议检查|建议复查|进一步评估|不能排除)/.test(line));
  if (concernLine) {
    return { label: "需关注", tone: "yellow", desc: concernLine || "当前资料提示仍需进一步评估。" };
  }
  if (!caseState.diagnosis) {
    return {
      label: "暂未识别",
      tone: "gray",
      desc: "当前已提交内容未命中程序化急危重红旗；待完成辨证分析后，将结合病史、生命体征与必要检查继续复核。",
    };
  }
  return { label: "低风险", tone: "green", desc: "已提交信息中未识别明确急危重红旗；仍需医生结合现场查体、生命体征和必要检查复核。" };
}

type DifferentiationSignalStatus = "complete" | "partial" | "missing";

type DifferentiationSignal = {
  label: string;
  value: string;
  status: DifferentiationSignalStatus;
  action?: string;
};

type SufficiencyDisplayBase = {
  score: number;
  label: string;
  tone: string;
  desc: string;
};

type ClinicalDisplayContext = {
  hasMeasuredVitals: boolean;
  requiresLimitedReview: boolean;
};

const UNRECORDED_VITALS_NOTICE = "未录入实测生命体征，开方前需现场复核";

export function hasRecordedMeasuredVitals(vitals?: Record<string, unknown>): boolean {
  if (!vitals) return false;
  return ["temperature", "pulse", "respiration", "bloodPressure"].some((key) => {
    const value = vitals[key];
    if (typeof value === "number") return Number.isFinite(value);
    if (typeof value !== "string") return false;
    const normalized = value.trim();
    return /\d/.test(normalized) && !/(未测|未量|待核实|待确认|不清楚|未知|暂无)/.test(normalized);
  });
}

export function resolveSufficiencyDisplay(
  base: SufficiencyDisplayBase,
  context: ClinicalDisplayContext,
): SufficiencyDisplayBase {
  if (context.requiresLimitedReview) {
    return {
      score: Math.min(69, base.score),
      label: "当前依据较少",
      tone: "yellow",
      desc: context.hasMeasuredVitals
        ? "系统仅依据已记录内容进行分析；未提供的信息保持未知，可补充关键证候后重新评估。"
        : `系统仅依据已记录内容进行分析；未提供的信息保持未知。${UNRECORDED_VITALS_NOTICE}。`,
    };
  }
  if (!context.hasMeasuredVitals) {
    return {
      score: Math.min(99, base.score),
      label: base.tone === "green" ? "需现场复核" : base.label,
      tone: base.tone === "green" ? "yellow" : base.tone,
      desc: `${UNRECORDED_VITALS_NOTICE}。非高风险病例不因此阻断剂量级候选生成；${base.desc}`,
    };
  }
  return base;
}

export function resolvePrescriptionDisplay(
  hasPrescription: boolean,
  context: ClinicalDisplayContext,
  isGenerating = false,
): { label: string; desc: string; tone: "green" | "yellow" | "gray" } {
  if (!hasPrescription) {
    if (isGenerating) {
      return {
        label: "生成与校验中",
        desc: "正在生成候选方药；药味、剂量、病机对应、煎法和出处核验完成后，本区域会自动更新。",
        tone: "gray",
      };
    }
    return {
      label: "未生成",
      desc: "当前无剂量级候选处方，随访仅展示补齐信息和复评路径。",
      tone: "gray",
    };
  }
  if (context.requiresLimitedReview || !context.hasMeasuredVitals) {
    return {
      label: "已生成",
      desc: context.hasMeasuredVitals
        ? "候选方药已生成，当前依据覆盖有限，医生可结合现场信息调整。"
        : `候选方药已生成；${UNRECORDED_VITALS_NOTICE}。`,
      tone: "yellow",
    };
  }
  return {
    label: "已生成",
    desc: "剂量级候选方药已生成，是否采纳由医生独立判断。",
    tone: "green",
  };
}

export function requiresLimitedCandidateReview(
  hasPrescription: boolean,
  safetyLocked: boolean,
  sufficiencyLabel: string,
): boolean {
  return hasPrescription && (safetyLocked || sufficiencyLabel !== "辨证充分");
}

function signalFromText(label: string, value: string | undefined, action: string): DifferentiationSignal {
  const cleaned = cleanInlineMarkdown(value || "");
  const grounded = Boolean(cleaned && !isUnknownClinicalText(cleaned));
  const partial = grounded && containsUnknownClinicalCue(cleaned);
  return {
    label,
    value: grounded ? cleaned : "未形成稳定证据",
    status: partial ? "partial" : grounded ? "complete" : "missing",
    action,
  };
}

function hasReasoningEvidenceSource(source: unknown): boolean {
  return typeof source === "string" &&
    cleanInlineMarkdown(source).length > 0 &&
    !/(?:内部证据缺口|证据不足|待检索|待核验|未配置)/.test(source);
}

function hasReasoningV2SyndromeSupport(caseState: CaseState): boolean {
  const reasoning = diagnoseReasoningFromState(caseState) || caseState.reasoningV2;
  return Boolean(
    reasoning?.overview?.primarySyndrome &&
    (
      hasReasoningEvidenceSource(reasoning.overview.evidence?.source) ||
      (reasoning.pathogenesis?.chain ?? []).some((item) => item.syndromeEvidence || item.patientFact)
    ),
  );
}

function hasReasoningV2MechanismSupport(caseState: CaseState): boolean {
  const reasoning = diagnoseReasoningFromState(caseState) || caseState.reasoningV2;
  return Boolean(
    reasoning?.overview?.overallPathogenesis &&
    (reasoning.pathogenesis?.chain ?? []).some((item) =>
      item.patientFact?.trim() &&
      item.syndromeEvidence?.trim() &&
      item.pathogenesis?.trim()
    ),
  );
}

function signalStatusClass(status: DifferentiationSignalStatus): string {
  if (status === "complete") return "border-emerald-100 bg-emerald-50 text-emerald-800";
  if (status === "partial") return "border-amber-100 bg-amber-50 text-amber-900";
  return "border-red-100 bg-red-50 text-red-800";
}

function signalStatusLabel(status: DifferentiationSignalStatus): string {
  if (status === "complete") return "已具备";
  if (status === "partial") return "待补强";
  return "不足";
}

function caseSymptomSummary(caseState: CaseState): string {
  const fields = caseState.hisRecord?.fields;
  const direct = [
    caseState.chiefComplaint,
    fields?.zhushu,
    fields?.xianbingshi,
    formatUnknown(caseState.symptoms),
  ]
    .map((item) => cleanInlineMarkdown(String(item || "")))
    .filter((item) => item && item !== "未提及");
  return direct[0] || "";
}

function buildDifferentiationSignals(caseState: CaseState, summary: DecisionSummary): DifferentiationSignal[] {
  const tonguePulse = [
    caseState.tongue || caseState.hisRecord?.fields?.tcmTongue,
    caseState.pulse || caseState.hisRecord?.fields?.tcmPulse,
  ].filter(Boolean).join("；");
  const faceAndInquiry = [
    caseState.faceNote || caseState.hisRecord?.fields?.tcmFace,
    caseState.hisRecord?.fields?.tcmDetail,
  ].filter(Boolean).join("；");
  const hasTongue = Boolean(tonguePulse && [caseState.tongue || caseState.hisRecord?.fields?.tcmTongue].some((value) => value && !isUnknownClinicalText(String(value))));
  const hasPulse = Boolean(tonguePulse && [caseState.pulse || caseState.hisRecord?.fields?.tcmPulse].some((value) => value && !isUnknownClinicalText(String(value))));
  const observationText = [tonguePulse, faceAndInquiry].filter(Boolean).join("；");
  const hasOtherObservation = Boolean(faceAndInquiry && !isUnknownClinicalText(faceAndInquiry));
  const observationStatus: DifferentiationSignalStatus = hasTongue && hasPulse
    ? "complete"
    : hasTongue || hasPulse || hasOtherObservation
      ? "partial"
      : "missing";
  const observationSignal: DifferentiationSignal = {
    label: "四诊辨证信息",
    value: observationText && !isUnknownClinicalText(observationText) ? cleanInlineMarkdown(observationText) : "未形成稳定证据",
    status: observationStatus,
    action: "可按病例需要补充舌质/舌苔、脉象、面象或寒热汗出、饮食二便。",
  };
  // Prefer the structured reasoningV2 fields M03 emits (machine-readable, phrasing-stable) over
  // regex-parsed markdown headings — otherwise an off-whitelist 证候/病机 heading silently blanks the
  // signal, downgrading 辨证充分度 to "辨证不足" and dead-ending the dose gate on a fully valid diagnosis.
  const diagnoseReasoning = diagnoseReasoningFromState(caseState) || caseState.reasoningV2;
  const syndrome = meaningfulField(diagnoseReasoning?.overview?.primarySyndrome, summary.tcmPattern, summary.tcmDiagnosisSection, summary.patternSection);
  const mechanism = meaningfulField(diagnoseReasoning?.overview?.overallPathogenesis, summary.coreMechanism, summary.mechanismSection, summary.subMechanismSection);
  const signals = [
    signalFromText("主诉与现病史", caseSymptomSummary(caseState), "补齐起病、诱因、主症程度、伴随症状和诊疗经过。"),
    observationSignal,
    signalFromText("证候归纳", syndrome, "补足能区分主证与兼证的关键症状、舌脉和反证。"),
    signalFromText("病机关联", mechanism, "把患者事实、证候证据、病位病性和治法方向串成可复核链路。"),
  ];

  if (signals[2].status === "complete" && !summary.tcmEvidence && !summary.tcmReference && !hasReasoningV2SyndromeSupport(caseState)) {
    signals[2].status = "partial";
  }
  if (signals[3].status === "complete" && !summary.treatmentPrinciple && !hasReasoningV2MechanismSupport(caseState)) {
    signals[3].status = "partial";
  }

  return signals;
}

function differentiationSufficiencyProfile(caseState: CaseState, summary: DecisionSummary) {
  const signals = buildDifferentiationSignals(caseState, summary);
  const score = Math.round((
    caseState.completeness.infoGain * 0.28 +
    caseState.completeness.answerability * 0.24 +
    caseState.completeness.managementImpact * 0.22 +
    caseState.completeness.redFlag * 0.16 +
    (signals.filter((item) => item.status === "complete").length / signals.length) * 0.10
  ) * 100);
  const missingSignals = signals.filter((item) => item.status === "missing");
  // Before M03 has produced a diagnosis (e.g. still streaming), nothing has been differentiated yet —
  // show a neutral "pending" state instead of a red "辨证不足" that contradicts the in-progress reasoning.
  if (!meaningfulField(caseState.diagnosis)) {
    return {
      score: Math.max(0, Math.min(100, score)),
      label: "待辨证完成",
      tone: "gray",
      desc: "四诊信息已录入；辨证推理完成后给出辨证充分度评估。",
      signals,
    };
  }
  const label = caseState.completeness.level === "C" && missingSignals.length === 0
    ? "辨证充分"
    : "有限信息可辨证";
  const tone = label === "辨证充分" ? "green" : "yellow";
  const desc = label === "辨证充分"
    ? "主诉、舌脉、证候和病机链已能支撑候选方案推理；处方仍需独立安全复核。"
    : "系统已基于现有信息完成辨证；未提供的资料会降低置信度，并作为医生复核点展示，不阻断后续分析。";
  // 展示的百分比必须与 label/tone(权威=完整度 level 门控)同源，否则会出现「81% + 辨证不足/红条」这类
  // 数值与色标自相矛盾。把连续加权 score 夹到 label 对应区间，level 门控保持唯一权威。
  const displayScore = label === "辨证充分"
    ? Math.max(70, Math.min(100, score))
    : Math.max(40, Math.min(69, score));
  return { score: displayScore, label, tone, desc, signals };
}

type PrescriptionRiskLevel = "strong" | "info" | "general" | "none";

export function prescriptionRiskLabel(
  level: PrescriptionRiskLevel,
  auditAvailable: boolean | undefined = true,
): { label: string; desc: string; tone: "red" | "yellow" | "green" } {
  if (level === "strong") {
    return {
      label: "需调整后复核",
      desc: "候选处方命中强提示，医生需先调整剂量/药味或药师复核后再考虑采纳。",
      tone: "red",
    };
  }
  if (auditAvailable === false) {
    return {
      label: "自动审方未完成 · 仅提示",
      desc: "自动审方本次未完成；当前仅展示已有确定性或本地风险提示，不能视为已完成审方或未见风险。",
      tone: "yellow",
    };
  }
  if (level === "info") {
    return {
      label: "信息不足",
      desc: "处方风险复核存在信息缺口，当前仅适合查看，不建议直接采纳。",
      tone: "yellow",
    };
  }
  if (level === "general") {
    return {
      label: "需常规复核",
      desc: "存在一般用药提醒，需医生结合处方意图与审方规则复核。",
      tone: "yellow",
    };
  }
  return {
    label: "未见强提示",
    desc: "未识别到强处方风险，但仍需医生完成最终审方和医嘱确认。",
    tone: "green",
  };
}

function canContinueLimitedCase(caseState: CaseState): boolean {
  return caseState.phase === "done" && !caseState.lastError &&
    !caseState.diagnosis && !caseState.prescription && !caseState.riskAssessment;
}

export function maxQuestionRoundNotice(
  state: Pick<CaseState, "questionRounds" | "maxQuestionRounds" | "phase">,
): string {
  if (state.questionRounds < state.maxQuestionRounds) return "";
  if (state.phase === "done") return "";
  if (state.phase === "question") {
    return "本轮集中核实关键问题；提交已确认信息或选择跳过后，将直接进入辨病辨证。";
  }
  return "";
}

export function differentiationScoreCaption(
  state: Pick<CaseState, "phase">,
  sufficiencyLabel: string,
): string {
  if (sufficiencyLabel.startsWith("有限辨证")) {
    return "本轮按已提供信息完成有限辨证；未回答项保持未知，补充最关键的辨证信息后可重新评估。";
  }
  if (state.phase === "done") {
    return "该分值用于回顾剂量级候选方药的辨证支撑度；本轮评估已完成，不足项可在补充信息后重新评估。";
  }
  return "该分值用于表达当前判断的证据覆盖度；资料不全会降低置信度，但不阻断本轮分析。";
}

function isDifferentiationLimitedTerminalCase(caseState: CaseState): boolean {
  return caseState.phase === "done" &&
    !caseState.prescription &&
    !caseState.riskAssessment &&
    !hasExecutableM03Diagnosis(caseState) &&
    /信息不足分析模式|辨证充分度仍未达到|需补充信息后再继续/.test(caseState.diagnosis || "");
}

function canEnterDiagnosisChain(caseState: CaseState): boolean {
  return Boolean((caseState.chiefComplaint || caseState.hisRecord?.fields?.zhushu || "").trim());
}

function shouldAskHighInformationFollowup(caseState: CaseState): boolean {
  if (caseState.questionRounds >= caseState.maxQuestionRounds) return false;
  if ((caseState.safetyGate || evaluateSafetyGate(caseState)).status === "red_flag") return false;
  // M02 is a semantic planner, not a fixed-slot completeness threshold. For every non-emergency
  // case with a chief complaint it gets one bounded opportunity to return ask(1..2) or proceed(0).
  // This lets the model judge whether an unresolved branch is actually worth asking instead of
  // equating missing tongue/pulse/demographics with high information gain.
  return canEnterDiagnosisChain(caseState);
}

function canSkipDifferentiationGate(caseState: CaseState): boolean {
  return canEnterDiagnosisChain(caseState);
}

export function hasExecutableM03Diagnosis(caseState: CaseState): boolean {
  const reasoning = diagnoseReasoningFromState(caseState);
  if (!caseState.diagnosis) return false;
  // Current cases always carry the governed M03 object. Once present, it is the sole executable
  // truth; management prose such as "完善甲功后再评估" must not overturn a valid contract. The
  // Markdown detector remains only for pre-V2 browser snapshots.
  if (reasoning) {
    return hasExecutableSignedM03(reasoning);
  }
  return hasActionableM03Diagnosis(caseState.diagnosis) && !isLimitedDiagnosisText(caseState.diagnosis);
}

function canEnterDosePrescriptionChain(caseState: CaseState): boolean {
  return Boolean(caseState.diagnosis && hasExecutableM03Diagnosis(caseState));
}

function buildDifferentiationFollowupQuestions(caseState: CaseState): QuestionItem[] {
  if (canEnterDiagnosisChain(caseState)) return [];
  return [{
    id: "chief-complaint",
    question: "请描述这次最想解决的主要不适，以及大概持续了多久。",
    reason: "主诉用于确定本轮分析目标；其他病史、舌脉和检查均可按已有情况选填。",
    options: [],
  }];
}

function buildDifferentiationFollowupContent(caseState: CaseState): string {
  const questions = buildDifferentiationFollowupQuestions(caseState);
  return [
    "## 请补充主诉",
    "请填写本次最希望辅助分析的主要不适。其余信息均为选填，不会因为缺少舌脉、生命体征或完整病史而阻断本轮推理。",
    "",
    ...questions.map((item, index) => [
      `**问题${index + 1}：** ${item.question}`,
      `（追问理由：${item.reason}）`,
      item.options.length > 0
        ? `可选项：${item.options.map((option, optionIndex) => `${String.fromCharCode(65 + optionIndex)}. ${option.answer}`).join("；")}`
        : "",
    ].filter(Boolean).join("\n")),
  ].join("\n\n");
}

function applyDifferentiationFollowupState(caseState: CaseState): CaseState {
  const content = buildDifferentiationFollowupContent(caseState);
  const lastMessage = caseState.conversation[caseState.conversation.length - 1];
  const conversation = lastMessage?.role === "assistant" && lastMessage.content === content
    ? caseState.conversation
    : [
      ...caseState.conversation,
      { role: "assistant" as const, content },
    ].slice(-MAX_CONVERSATION);
  return {
    ...caseState,
    conversation,
    prescription: undefined,
    riskAssessment: undefined,
    safetyLocked: false,
    lastError: undefined,
    phase: "question",
  };
}

function applyDifferentiationGateOutcome(caseState: CaseState): CaseState {
  if (!canEnterDiagnosisChain(caseState)) return applyDifferentiationFollowupState(caseState);
  return setError(
    { ...caseState, phase: "diagnose", prescription: undefined, riskAssessment: undefined },
    "辨病辨证结果未形成可继续使用的完整结构，请重新生成辨病辨证；已填写的病历不会丢失。",
  );
}

function statusToneClass(tone: string): string {
  if (tone === "red") return "bg-red-50 text-red-700 border-red-200";
  if (tone === "yellow") return "bg-yellow-50 text-yellow-800 border-yellow-200";
  if (tone === "green") return "bg-emerald-50 text-emerald-700 border-emerald-200";
  return "bg-gray-50 text-gray-600 border-gray-200";
}

// ─── Productized diagnosis surfaces ─────────────────────────────────────────

function TopProgress({ caseState }: { caseState: CaseState }) {
  return (
    <div className="border-b border-gray-100 bg-white px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        {PHASE_STEPS.map((step, idx) => {
          const status = getStepStatus(caseState, step);
          return (
            <div key={step.phase} className="flex items-center gap-2 shrink-0">
              <div
                className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs transition-all ${
                  status === "done" ? "border-emerald-200 bg-emerald-50 text-emerald-700" :
                  status === "doing" ? "border-blue-200 bg-blue-50 text-blue-700" :
                  status === "error" ? "border-red-200 bg-red-50 text-red-700" :
                  status === "limited" ? "border-amber-200 bg-amber-50 text-amber-700" :
                  status === "blocked" ? "border-gray-200 bg-gray-50 text-gray-500" :
                  status === "skipped" ? "border-sky-100 bg-sky-50 text-sky-700" :
                  "border-gray-200 bg-gray-50 text-gray-400"
                }`}
              >
                {status === "done" && <Check className="h-3.5 w-3.5" />}
                {status === "doing" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {status === "error" && <AlertTriangle className="h-3.5 w-3.5" />}
                {status === "limited" && <AlertTriangle className="h-3.5 w-3.5" />}
                {status === "blocked" && <Lock className="h-3.5 w-3.5" />}
                {status === "skipped" && <Circle className="h-3.5 w-3.5" />}
                {status === "todo" && <Circle className="h-3.5 w-3.5" />}
                <span className="font-medium">{step.label}{status === "blocked" ? " 未执行" : status === "skipped" ? " 已跳过" : ""}</span>
              </div>
              {idx < PHASE_STEPS.length - 1 && <div className="h-px w-5 bg-gray-200" />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RiskSummaryPanel({
  caseState,
  followupQuestionCard,
}: {
  caseState: CaseState;
  followupQuestionCard?: ReactNode;
}) {
  const redStatus = redFlagStatusForCase(caseState);
  const summary = buildDecisionSummary(caseState);
  const differentiationProfile = useMemo(
    () => {
      const base = differentiationSufficiencyProfile(caseState, summary);
      const activeReasoning = mergeReasoningStages(diagnoseReasoningFromState(caseState), prescribeReasoningFromState(caseState)) || caseState.reasoningV2;
      const hasDosePrescription = hasGeneratedDosePrescription(summary, activeReasoning);
      const hasMeasuredVitals = hasRecordedMeasuredVitals(caseState.vitals);
      const display = resolveSufficiencyDisplay(base, {
        hasMeasuredVitals,
        requiresLimitedReview: requiresLimitedCandidateReview(
          hasDosePrescription,
          caseState.safetyLocked === true,
          base.label,
        ),
      });
      const signals = base.signals;
      return { ...base, ...display, signals };
    },
    [caseState, summary],
  );
  const shouldShowDifferentiationProfile =
    Boolean(caseState.diagnosis) ||
    isDifferentiationLimitedTerminalCase(caseState);
  const questionRoundNotice = maxQuestionRoundNotice(caseState);
  const redFlagSummary = useMemo(
    () => extractSectionLoose(caseState.diagnosis, ["红旗排查", "红旗指征", "红旗风险", "红旗预警"]),
    [caseState.diagnosis],
  );
  const isRedFlag = (caseState.safetyGate || evaluateSafetyGate(caseState)).status === "red_flag";
  const hasTriageAdvisory = !isRedFlag && ((caseState.safetyGate || evaluateSafetyGate(caseState)).advisories || []).length > 0;

  return (
    <div className="flex flex-col gap-3">
      {isRedFlag && <div data-testid="risk-red-flag-card" className="bg-white border rounded-xl p-4">
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">急危重红旗风险</p>
          <span data-testid="risk-status-badge" className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${statusToneClass(redStatus.tone)}`}>
            {redStatus.label}
          </span>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-gray-500">{redStatus.desc}</p>
        {redFlagSummary && (
          <div className="mt-3 rounded-lg border bg-gray-50 px-3 py-2 text-xs leading-relaxed text-gray-700">
            <MarkdownBlock content={compactMarkdown(redFlagSummary, 420)} compact />
          </div>
        )}
      </div>}

      {hasTriageAdvisory && <div data-testid="risk-advisory-card" className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs font-semibold text-amber-900">临床优先关注</p>
          <span className="shrink-0 rounded-full border border-amber-200 bg-white px-2.5 py-1 text-xs font-semibold text-amber-800">{redStatus.label}</span>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-amber-900">{redStatus.desc}</p>
      </div>}

      {shouldShowDifferentiationProfile && (
        <div data-testid="completeness-card" className="bg-white border rounded-xl p-4">
          <div className="mb-3 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">辨证充分度</p>
              <p className="mt-1 text-xs leading-relaxed text-gray-500">{differentiationProfile.desc}</p>
            </div>
            <span className={`shrink-0 rounded-full border px-2.5 py-1 text-xs font-bold ${statusToneClass(differentiationProfile.tone)}`}>
              {differentiationProfile.label}
            </span>
          </div>
          <div className="mb-3 rounded-lg border border-gray-100 bg-gray-50 px-3 py-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-gray-700">综合支撑度</span>
              <span className={`font-bold ${
                differentiationProfile.tone === "green" ? "text-emerald-600" :
                differentiationProfile.tone === "yellow" ? "text-amber-600" :
                differentiationProfile.tone === "red" ? "text-red-500" :
                "text-gray-500"
              }`}>{differentiationProfile.score}%</span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white">
              <div
                className={`h-full rounded-full transition-all ${
                  differentiationProfile.tone === "green" ? "bg-emerald-500" :
                  differentiationProfile.tone === "yellow" ? "bg-amber-400" :
                  differentiationProfile.tone === "red" ? "bg-red-400" :
                  "bg-gray-300"
                }`}
                style={{ width: `${differentiationProfile.score}%` }}
              />
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-gray-500">
              {differentiationScoreCaption(caseState, differentiationProfile.label)}
            </p>
          </div>
          <div className="grid gap-2">
            {differentiationProfile.signals.map((signal) => (
              <div key={signal.label} className={`rounded-lg border px-3 py-2 text-xs ${signalStatusClass(signal.status)}`}>
                <div className="flex items-center justify-between gap-2">
                  <p className="font-semibold">{signal.label}</p>
                  <span className="shrink-0 text-[11px] font-bold opacity-75">{signalStatusLabel(signal.status)}</span>
                </div>
                <p className="mt-1 line-clamp-2 leading-relaxed">{signal.value}</p>
                {signal.status !== "complete" && signal.action && (
                  <p className="mt-1 text-[11px] leading-relaxed opacity-80">补强：{signal.action}</p>
                )}
              </div>
            ))}
          </div>
          <p className="text-xs text-gray-400 mt-2">
            {caseState.questionOutcome === "skipped"
              ? "本轮关键追问已跳过"
              : caseState.questionOutcome === "not_needed"
                ? "本例无需追加关键追问"
                : `已完成 ${caseState.questionRounds}/${caseState.maxQuestionRounds} 轮追问`}
          </p>
          {questionRoundNotice && (
            <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs leading-relaxed text-amber-700">
              {questionRoundNotice}
            </p>
          )}
          {followupQuestionCard && (
            <div className="mt-3" data-testid="sufficiency-followup-card">
              {followupQuestionCard}
            </div>
          )}
        </div>
      )}

      {!shouldShowDifferentiationProfile && followupQuestionCard && (
        <div data-testid="sufficiency-followup-card" className="bg-white border rounded-xl p-4">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">本轮关键追问</p>
          <p className="mt-1 text-xs leading-relaxed text-gray-500">可点选实际回答或在每题下直接记录患者原话、查体和检查结果；也可跳过并按现有信息继续。</p>
          <div className="mt-3">{followupQuestionCard}</div>
        </div>
      )}

    </div>
  );
}

export function errorRequiresM03Refresh(lastError: CaseState["lastError"] | undefined): boolean {
  if (!lastError || !["prescribe", "assess"].includes(lastError.phase)) return false;
  const message = normalizeRequestError(lastError.message, "");
  return /M03.*(?:签名|合同)|重新生成\s*M03|reasoning.*signature|contract.*signature/i.test(message);
}

export function stageErrorDisplay(lastError: NonNullable<CaseState["lastError"]>): {
  stepLabel: string;
  message: string;
  retryText: string;
  downstreamLabels: string[];
} {
  const failedStep = PHASE_STEPS.find((step) => step.phase === lastError.phase);
  const stepLabel = failedStep?.label || "当前阶段";
  const message = normalizeRequestError(lastError.message, `${stepLabel} 未完成，请补充信息或重试。`);
  const requiresM03Refresh = errorRequiresM03Refresh(lastError);
  const retryText =
    requiresM03Refresh ? "重新生成辨病辨证并继续" :
    lastError.phase === "diagnose" ? "重新生成辨病辨证" :
    lastError.phase === "prescribe" ? "重新生成候选方药" :
    lastError.phase === "assess" ? "重新生成审方与随访" :
    "重试本阶段";
  // PHASE_ORDER 比 PHASE_STEPS 多一个头部 "idle"，索引差 1：下游切片直接用 PHASE_ORDER 下标即可，
  // 不能再 +1，否则失败阶段的下一个阶段会被漏掉（例如 M04 失败时漏掉“审方随访未执行”）。
  const downstreamLabels = PHASE_STEPS.slice(phaseIndex(lastError.phase)).map((step) => step.label);
  return { stepLabel, message, retryText, downstreamLabels };
}

function StageErrorCard({ caseState, onRetry }: { caseState: CaseState; onRetry: () => void }) {
  if (caseState.phase !== "error" || !caseState.lastError) return null;
  const { stepLabel, message, retryText, downstreamLabels } = stageErrorDisplay(caseState.lastError);

  return (
    <div data-testid="stage-error-card" className="mb-3 rounded-xl border border-red-200 bg-red-50 p-4 text-red-900">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-700" />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-bold">{stepLabel} 未完成</p>
          <p className="mt-1 text-[12px] leading-relaxed">{message}</p>
          {downstreamLabels.length > 0 && (
            <p className="mt-1 text-[12px] leading-relaxed text-red-700">
              上一阶段未成功，{downstreamLabels.join("、")} 阶段未执行。
            </p>
          )}
          <button
            type="button"
            onClick={onRetry}
            className="mt-3 inline-flex items-center justify-center gap-1.5 rounded-lg border border-red-200 bg-white px-3 py-2 text-[12px] font-bold text-red-700 transition-colors hover:bg-red-100"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {retryText}
          </button>
        </div>
      </div>
    </div>
  );
}

function MarkdownBlock({ content, compact = false }: { content: string; compact?: boolean }) {
  const renderedContent = normalizeClinicalText(content || "暂无");
  return (
    <div className={`prose prose-sm prose-gray min-w-0 max-w-none prose-headings:font-semibold prose-h2:text-base prose-h3:text-sm prose-p:my-2 prose-ul:my-2 prose-li:my-0.5 prose-table:text-xs ${compact ? "prose-p:my-1 prose-ul:my-1" : ""}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents} urlTransform={urlTransform}>
        {renderedContent}
      </ReactMarkdown>
    </div>
  );
}

function Disclosure({
  title,
  subtitle,
  children,
  defaultOpen = false,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details open={defaultOpen} className="group rounded-xl border bg-white">
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3">
        <ChevronDown className="h-4 w-4 text-gray-400 transition-transform group-open:rotate-180" />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-gray-800">{title}</p>
          {subtitle && <p className="mt-0.5 text-xs text-gray-500">{subtitle}</p>}
        </div>
      </summary>
      <div className="min-w-0 border-t px-5 py-4">{children}</div>
    </details>
  );
}

function EvidenceCallout({}: {
  evidence?: string;
  reference?: string;
}) {
  // 证据支持/证据依据 摘要蓝框按产品要求下线：与下方证据表格重复，且当无检索命中时会并列出现
  // “证据不足/待检索”与“基于共识/教材”，读起来自相矛盾。表格内的支持证据/证据依据列保留。
  return null;
}

function formatUnknown(value: unknown): string {
  if (value === null || value === undefined || value === "") return "未提及";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== null && v !== undefined && v !== "")
      .map(([k, v]) => `${k}：${formatUnknown(v)}`);
    return entries.length ? entries.join("；") : "未提及";
  }
  return "未提及";
}

type QuestionItem = {
  id: string;
  question: string;
  reason: string;
  targetField?: M02TargetField;
  fields?: string[];
  options: QuestionOption[];
};

type QuestionOption = {
  label: string;
  answer: string;
  kind?: "clinical_fact" | "pending_action" | "workflow_instruction";
  patch?: Partial<HisRecordDraft>;
  replacePatch?: boolean;
  guidance?: string;
  requiresDetail?: boolean;
  targetField?: M02TargetField;
  detailTarget?: "xianbingshi" | "tcmDetail" | "jiwangshi" | "fuzhuJiancha" | "allergyMedication" | "vitals" | "tonguePulse";
};

type QuestionOptionSelection = {
  questionId?: string;
  label?: string;
  answer: string;
  kind?: "clinical_fact" | "pending_action" | "workflow_instruction";
  patch?: Partial<HisRecordDraft>;
  replacePatch?: boolean;
  guidance?: string;
  requiresDetail?: boolean;
  detailAnswer?: string;
  targetField?: M02TargetField;
  detailTarget?: "xianbingshi" | "tcmDetail" | "jiwangshi" | "fuzhuJiancha" | "allergyMedication" | "vitals" | "tonguePulse";
};

function questionOptionKind(option: Pick<QuestionOptionSelection, "kind">): NonNullable<QuestionOptionSelection["kind"]> {
  return option.kind || "clinical_fact";
}

function redFlagQuestionScope(question: string): string[] {
  const groups: Array<[RegExp, string]> = [
    [/(胸痛|胸闷|压榨|放射痛|大汗|气促|呼吸困难)/, "胸痛、胸闷、大汗或呼吸困难"],
    [/(晕厥|黑矇|心悸|恶性心律|运动耐量)/, "晕厥、黑矇、明显心悸或运动耐量骤降"],
    [/(剧烈头痛|意识|偏瘫|言语不清|抽搐)/, "突发剧烈头痛、意识改变、偏瘫、言语不清或抽搐"],
    [/(发热|高热|寒战|感染)/, "持续高热、寒战或其他明显感染表现"],
  ];
  return groups.filter(([pattern]) => pattern.test(question)).map(([, label]) => label);
}

function quickOptionsForQuestion(question: string): QuestionOption[] {
  if (/胸痛|胸闷|气促|大汗|晕厥|黑矇|剧烈头痛|意识|发热|寒战|红旗/.test(question)) {
    const scopes = redFlagQuestionScope(question);
    return [
      ...(scopes.length > 0 ? [{
        label: "经询问未见上述表现",
        answer: `已当面核实：未见${scopes.join("、")}。`,
        patch: { xianbingshi: `本题红旗核实：未见${scopes.join("、")}。` },
      }] : []),
      {
        label: "存在异常",
        answer: "请填写实际异常症状、发生时间、严重程度和已经采取的处置。",
        guidance: "请在本卡片补充异常症状、发生时间、严重程度和处置情况；系统会回填现病史。",
        requiresDetail: true,
        detailTarget: "xianbingshi",
      },
      {
        label: "本次未取得该信息",
        answer: "本次接诊尚未取得该信息，保持未知。",
        kind: "pending_action",
      },
    ];
  }
  if (/过敏/.test(question)) {
    return [
      {
        label: "否认过敏",
        answer: "已当面核实：否认药物、食物及中药过敏史。",
        patch: { allergyHistory: "否认药物、食物及中药过敏史" },
        replacePatch: true,
      },
      {
        label: "有过敏史",
        answer: "请填写具体过敏原、反应表现和发生时间。",
        guidance: "请在本卡片补充具体过敏原和反应，例如“青霉素皮疹”；系统会回填过敏史。",
        requiresDetail: true,
        detailTarget: "allergyMedication",
      },
      {
        label: "本次未取得该信息",
        answer: "本次接诊尚未取得该信息，保持未知。",
        kind: "pending_action",
      },
    ];
  }
  if (/用药|药物|中成药|保健品|西药/.test(question)) {
    return [
      {
        label: "否认当前用药",
        answer: "已当面核实：目前未使用中药、中成药、西药或保健品。",
        patch: { medicationHistory: "否认当前使用中药、中成药、西药及保健品" },
        replacePatch: true,
      },
      {
        label: "正在用药",
        answer: "请填写当前药名、剂量、频次、开始时间和用药目的。",
        guidance: "请在本卡片补充药名、剂量、频次；系统会回填用药史并重新评估联用风险。",
        requiresDetail: true,
        detailTarget: "allergyMedication",
      },
      {
        label: "偶用非处方药",
        answer: "请填写非处方药名、频次和最近一次使用时间。",
        guidance: "请在本卡片补充具体非处方药信息；系统会回填用药史。",
        requiresDetail: true,
        detailTarget: "allergyMedication",
      },
      {
        label: "本次未取得该信息",
        answer: "本次接诊尚未取得该信息，保持未知。",
        kind: "pending_action",
      },
    ];
  }
  if (/血压|体温|心率|呼吸|SpO2|生命体征/.test(question)) {
    return [
      {
        label: "填写实测值",
        answer: "请在下方补充本次实测生命体征，例如：T36.6 P78 R18 BP120/80。",
        guidance: "在本卡片下方填写具体数值并提交；系统不会代填模板生命体征。",
        requiresDetail: true,
        detailTarget: "vitals",
      },
      {
        label: "数值异常",
        answer: "生命体征存在异常，需补充T/P/R/BP具体数值及是否复测。",
        guidance: "在本卡片下方填写具体异常数值、复测结果和处置情况。",
        requiresDetail: true,
        detailTarget: "vitals",
      },
      {
        label: "暂未测量",
        answer: "暂未测量生命体征，本项不作为通用必填；若患者存在胸痛、晕厥、呼吸困难、高热等红旗线索，应先测量并处置。",
        guidance: "如无红旗线索，可继续依据已采集的四诊信息推理；如存在红旗线索，请先补测并评估。",
        kind: "pending_action",
      },
    ];
  }
  if (/舌|脉/.test(question)) {
    return [
      {
        label: "淡红薄白 / 弦细",
        answer: "舌淡红，苔薄白；脉弦细。",
        patch: { tcmTongue: "舌淡红，苔薄白", tcmPulse: "脉弦细" },
      },
      {
        label: "舌红少苔 / 细数",
        answer: "舌红少苔；脉细数。",
        patch: { tcmTongue: "舌红少苔", tcmPulse: "脉细数" },
      },
      {
        label: "舌淡苔白 / 沉细",
        answer: "舌淡，苔白；脉沉细。",
        patch: { tcmTongue: "舌淡，苔白", tcmPulse: "脉沉细" },
      },
      {
        label: "手动填写",
        answer: "请在下方补充本次实际舌象和脉象，例如：舌淡红苔薄白，脉弦细。",
        guidance: "在本卡片下方填写医生实际观察到的舌象、脉象后提交。",
        requiresDetail: true,
        detailTarget: "tonguePulse",
      },
    ];
  }
  if (/妊娠|哺乳|月经|孕/.test(question)) {
    return [
      {
        label: "否认妊娠哺乳",
        answer: "否认妊娠、哺乳及备孕，月经情况无特殊。",
        patch: { jiwangshi: "女性特殊情况：否认妊娠、哺乳及备孕，月经情况无特殊" },
      },
      {
        label: "存在可能",
        answer: "存在妊娠、哺乳或备孕可能，暂不建议输出剂量级处方。",
        patch: { jiwangshi: "女性特殊情况：存在妊娠/哺乳/备孕可能，需特殊人群用药复核。" },
      },
      {
        label: "补充具体情况",
        answer: "请填写实际月经、孕产、哺乳和备孕情况。",
        guidance: "请在本卡片补充月经、孕产、哺乳和备孕状态；系统会回填既往史。",
        requiresDetail: true,
        detailTarget: "jiwangshi",
      },
    ];
  }
  if (/大便|小便|睡眠|出汗|口渴|寒热|饮食/.test(question)) {
    return [
      {
        label: "无特殊异常",
        answer: "饮食、二便、睡眠、寒热汗出、口渴饮水等问诊信息无特殊异常。",
        patch: { tcmDetail: "问诊：饮食、二便、睡眠、寒热汗出、口渴饮水等无特殊异常" },
      },
      {
        label: "有明显异常",
        answer: "请填写寒热汗出、口渴饮水、饮食二便、睡眠情志的实际异常表现。",
        guidance: "请在本卡片记录寒热、汗出、口渴、饮食、二便、睡眠、情志等；系统会回填问诊补充。",
        requiresDetail: true,
        detailTarget: "tcmDetail",
      },
      {
        label: "本次未取得该信息",
        answer: "本次接诊尚未取得该信息，保持未知。",
        kind: "pending_action",
      },
    ];
  }
  return [
    {
      label: "未见明显异常",
      answer: "已当面核实：该项未见明显异常。",
    },
    {
      label: "症状明显",
      answer: "请填写该项症状的具体程度、持续时间、诱因、缓解因素和伴随症状。",
      guidance: "请在本卡片补充细节；系统会回填现病史或问诊补充。",
      requiresDetail: true,
      detailTarget: "xianbingshi",
    },
    {
      label: "本次未取得该信息",
      answer: "本次接诊尚未取得该信息，保持未知。",
      kind: "pending_action",
    },
  ];
}

function parseQuestionFields(body: string): string[] {
  const match = body.match(/补录字段\s*[：:]\s*([^\n]+)/);
  if (!match?.[1]) return [];
  return match[1]
    .replace(/[［\[\]］]/g, "")
    .split(/[、,，/；;\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function guidanceForQuestionFields(fields: string[], question: string): string | undefined {
  const normalized = fields.join("、") || question;
  if (/过敏/.test(normalized)) return "请在本卡片补充具体过敏原、反应；若本项经核实为阴性，可记录“否认”，系统会回填过敏史。";
  if (/用药|药物|中成药|西药|保健品/.test(normalized)) return "请在本卡片补充具体药名、剂量、频次和用药目的；若本项经核实为阴性，可记录“否认”，系统会回填用药史。";
  if (/生命体征|血压|体温|心率|呼吸/.test(normalized)) return "请在本卡片下方填写已测得的具体数值；未测且无红旗线索时，不作为通用必填项。";
  if (/舌/.test(normalized)) return "请在本卡片点选或填写实际舌象；系统会回填舌象栏。";
  if (/脉/.test(normalized)) return "请在本卡片点选或填写实际脉象；系统会回填脉象栏。";
  if (/面/.test(normalized)) return "请在本卡片补充面色、神态、形体等特征词；系统会回填面象栏。";
  if (/既往|妊娠|哺乳|备孕|月经/.test(normalized)) return "请在本卡片补充相关病史或特殊人群信息；系统会回填既往史。";
  if (/辅助检查|检验|检查/.test(normalized)) return "请在本卡片补充检验检查结果；系统会回填辅助检查。";
  if (/问诊|寒热|汗|饮食|二便|睡眠|情志/.test(normalized)) return "请在本卡片记录寒热汗出、饮食二便、睡眠情志等；系统会回填问诊补充。";
  return "请在本卡片补充后提交，系统会回填相应病历字段。";
}

function extractVitalsPatch(answer: string): Partial<HisRecordDraft> {
  const patch: Partial<HisRecordDraft> = {};
  const t = answer.match(/(?:T|体温)\s*[:：]?\s*((?:3[0-9]|4[0-5])(?:\.\d)?)/i)?.[1];
  const p = answer.match(/(?:P|HR|心率|脉搏)\s*[:：]?\s*(\d{2,3})/i)?.[1];
  const r = answer.match(/(?:R|RR|呼吸)\s*[:：]?\s*(\d{1,2})/i)?.[1];
  const bp = answer.match(/(?:BP|血压)\s*[:：]?\s*(\d{2,3}\s*\/\s*\d{2,3})/i)?.[1]?.replace(/\s+/g, "");
  if (t) patch.vitalsT = t;
  if (p) patch.vitalsP = p;
  if (r) patch.vitalsR = r;
  if (bp) patch.vitalsBP = bp;
  return patch;
}

function inferredDetailTarget(scope: string): QuestionOption["detailTarget"] {
  if (/生命体征|血压|体温|心率|呼吸|SpO2/.test(scope)) return "vitals";
  if (/舌|脉/.test(scope)) return "tonguePulse";
  if (/过敏|用药|药物|中成药|西药|保健品/.test(scope)) return "allergyMedication";
  if (/既往|妊娠|哺乳|备孕|月经/.test(scope)) return "jiwangshi";
  if (/辅助检查|检验|检查/.test(scope)) return "fuzhuJiancha";
  if (/问诊|寒热|汗|饮食|二便|睡眠|情志|口渴/.test(scope)) return "tcmDetail";
  return "xianbingshi";
}

function inferQuestionPatch(question: string, answer: string, fields: string[]): Pick<QuestionOption, "kind" | "patch" | "replacePatch" | "guidance" | "requiresDetail" | "detailTarget"> {
  const scope = `${fields.join(" ")} ${question} ${answer}`;
  if (/暂不清楚|不清楚|待补问|待确认|未测量|暂未测量|未采集|未取得|无法核实/.test(answer)) {
    return {
      kind: "pending_action",
      guidance: guidanceForQuestionFields(fields, question),
    };
  }

  const compoundAffirmative = isCompoundAffirmativeQuestionOption(answer);

  if (compoundAffirmative || /需补充|补充具体|请填写|填写实际|下方填写|请在.{0,12}(?:记录|补充)(?:实况|详情|具体)/.test(answer)) {
    return {
      kind: "clinical_fact",
      guidance: guidanceForQuestionFields(fields, question),
      requiresDetail: true,
      detailTarget: inferredDetailTarget(scope),
    };
  }

  if (/过敏/.test(scope)) {
    if (/(否认|无|没有|未见)/.test(answer)) {
      return { patch: { allergyHistory: "否认药物、食物及中药过敏史" }, replacePatch: true };
    }
    return { patch: { allergyHistory: answer } };
  }
  if (/用药|药物|中成药|西药|保健品/.test(scope)) {
    if (/(否认|无|没有|未使用|未服用)/.test(answer)) {
      return { patch: { medicationHistory: "否认当前使用中药、中成药、西药及保健品" }, replacePatch: true };
    }
    return { patch: { medicationHistory: answer } };
  }
  if (/生命体征|血压|体温|心率|呼吸|SpO2/.test(scope)) {
    const patch = extractVitalsPatch(answer);
    return Object.keys(patch).length > 0 ? { patch, replacePatch: true } : { guidance: guidanceForQuestionFields(fields, question) };
  }
  if (/舌|脉/.test(scope)) {
    const patch: Partial<HisRecordDraft> = {};
    if (/舌/.test(answer)) patch.tcmTongue = answer.split(/[；;]/).find((part) => part.includes("舌")) || answer;
    if (/脉/.test(answer)) patch.tcmPulse = answer.split(/[；;]/).find((part) => part.includes("脉")) || answer;
    return Object.keys(patch).length > 0 ? { patch } : { guidance: guidanceForQuestionFields(fields, question) };
  }
  if (/面象|面色|神态/.test(scope)) return { patch: { tcmFace: answer } };
  if (/既往|妊娠|哺乳|备孕|月经/.test(scope)) return { patch: { jiwangshi: answer } };
  if (/辅助检查|检验|检查/.test(scope)) return { patch: { fuzhuJiancha: answer } };
  if (/问诊|寒热|汗|饮食|二便|睡眠|情志|口渴/.test(scope)) return { patch: { tcmDetail: answer } };
  if (/主诉|现病史|症状|红旗/.test(scope)) return { patch: { xianbingshi: answer } };
  return { guidance: guidanceForQuestionFields(fields, question) };
}

function modelOptionsForQuestion(body: string, question: string, reason: string): QuestionOption[] {
  const optionBlock = body.match(/可选项\s*[：:]\s*([\s\S]*)/)?.[1] || "";
  if (!optionBlock) return [];
  const fields = parseQuestionFields(body);
  const options = Array.from(optionBlock.matchAll(/^\s*(?:[-*]\s*)?([A-CＡ-Ｃ])[\.\、．:：]\s*(.+)$/gm))
    .map((match) => cleanInlineMarkdown(match[2] || ""))
    .filter((text) => text && !/^\[.*\]$/.test(text))
    .slice(0, 4);

  return options.map((answer) => {
    if (/暂不清楚|不清楚|未注意|无法确认|未取得|需询问|需核实/.test(answer)) {
      return {
        label: "本次未取得该信息",
        answer: "本次接诊尚未取得该信息，保持未知。",
        kind: "pending_action" as const,
        guidance: "本项保持未知，不作为阴性或阳性患者事实。",
      };
    }
    const inferred = inferQuestionPatch(question, answer, fields);
    return {
      label: clipText(answer.replace(/^已当面核实[：:]/, ""), 28),
      answer,
      guidance: inferred.guidance || reason,
      ...inferred,
    };
  });
}

function questionDedupeKey(item: QuestionItem): string {
  const text = `${item.question} ${item.reason}`;
  if (/自杀|自伤|他伤|伤害他人/.test(text)) return "required:mental-safety";
  if (/OSA|睡眠呼吸暂停|打鼾|日间嗜睡/.test(text)) return "required:osa-screen";
  if (/甲状腺|甲功|TSH|FT3|FT4/.test(text)) return "required:thyroid-screen";
  if (/生命体征|血压|体温|心率|脉搏|呼吸|T\/P\/R\/BP/.test(text)) return "required:vitals";
  if (/舌|脉/.test(text)) return "required:tongue-pulse";
  if (/性别/.test(text)) return "required:sex";
  if (/年龄/.test(text)) return "required:age";
  if (/儿童体重|体重/.test(text)) return "required:pediatric-weight";
  if (/过敏/.test(text)) return "required:allergy";
  if (/当前用药|用药史|药名|剂量|频次/.test(text)) return "required:medication";
  if (/妊娠|哺乳|备孕/.test(text)) return "required:pregnancy";
  return item.question.replace(/\s+/g, "");
}

function mergeQuestionItems(requiredItems: QuestionItem[], parsedItems: QuestionItem[]): QuestionItem[] {
  const result: QuestionItem[] = [];
  const seen = new Set<string>();
  for (const item of [...requiredItems, ...parsedItems]) {
    const key = questionDedupeKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
    if (result.length >= 4) break;
  }
  return result;
}

function isInternalFollowupQuestion(item: QuestionItem): boolean {
  const text = `${item.question} ${item.reason} ${item.options.map((option) => option.answer).join(" ")}`;
  return /请补充或复核/.test(text) &&
    /(证候归纳|病机关联|安全边界|确定性安全门控)/.test(text);
}

export function parseQuestionItems(content: string): QuestionItem[] {
  const typedPlan = parseM02PlanFromContent(content);
  if (typedPlan) {
    if (typedPlan.decision === "proceed") return [];
    return typedPlan.questions.map((item) => ({
      id: item.id,
      question: item.question,
      reason: item.reason,
      targetField: item.targetField,
      fields: [item.targetField],
      options: item.options.map((option) => ({
        label: option.label,
        answer: option.answer,
        kind: option.kind === "unknown" ? "pending_action" : "clinical_fact",
        targetField: item.targetField,
        patch: option.recordValue
          ? { [item.targetField]: option.recordValue } as Partial<HisRecordDraft>
          : undefined,
        requiresDetail: option.requiresDetail,
        guidance: option.requiresDetail ? "请记录患者实际回答、医生查体或已取得的检查结果。" : undefined,
      })),
    }));
  }
  const cleanedContent = content
    .replace(/<!--\s*DIAGNOSIS_JSON_START\s*-->[\s\S]*?<!--\s*DIAGNOSIS_JSON_END\s*-->/g, "")
    .replace(/\s*[-—]*\s*\*{0,2}【?第二部分[：:][^】\n]*(?:】)?\*{0,2}/g, "")
    .replace(/\s*[-—]*\s*\*{0,2}【?结构化(?:数据|JSON)[^】\n]*(?:】)?\*{0,2}/g, "");
  const matches = Array.from(cleanedContent.matchAll(/(?:^|\n)\s*\*{0,2}问题(\d+)[：:]\*{0,2}\s*([\s\S]*?)(?=\n\s*\*{0,2}问题\d+[：:]|\s*$)/g));
  const parsed = matches.map((match) => {
    const id = match[1] ?? "";
    const body = (match[2] ?? "").trim();
    // Providers may append the reason to the question line instead of starting a new line.
    // Split both forms here so the clinician never sees the reason twice in one card.
    const reasonHeader = body.match(/[（(]\s*追问理由[：:]\s*/);
    const reasonStart = reasonHeader?.index ?? -1;
    const reasonValueStart = reasonStart >= 0 ? reasonStart + (reasonHeader?.[0].length || 0) : -1;
    const reasonTail = reasonValueStart >= 0 ? body.slice(reasonValueStart) : "";
    const reasonBoundary = reasonTail.search(/\n\s*(?:补录字段|可选项)\s*[：:]/);
    const reasonRaw = reasonValueStart >= 0
      ? body.slice(reasonValueStart, reasonBoundary >= 0 ? reasonValueStart + reasonBoundary : body.length)
      : "";
    const questionSource = reasonStart >= 0 ? body.slice(0, reasonStart) : body;
    const question = questionSource
      .replace(/补录字段\s*[：:][^\n]+/g, "")
      .replace(/可选项\s*[：:][\s\S]*$/g, "")
      .replace(/\s*[-—]*\s*\*{0,2}【?第二部分[：:][^】\n]*(?:】)?\*{0,2}/g, "")
      .replace(/\s*[-—]*\s*\*{0,2}【?结构化(?:数据|JSON)[^】\n]*(?:】)?\*{0,2}/g, "")
      .trim();
    const reason = reasonRaw.replace(/[）)]\s*$/, "").trim() || "用于提高当前判断质量。";
    const fields = parseQuestionFields(body);
    const modelOptions = modelOptionsForQuestion(body, question, reason);
    return {
      id,
      question: question || `问题${id}`,
      reason,
      fields,
      options: modelOptions.length > 0 ? modelOptions : quickOptionsForQuestion(question),
    };
  }).filter((item) => !isInternalFollowupQuestion(item));
  if (parsed.length > 0) return parsed;

  // Providers occasionally preserve the requested clinical content but drop the Markdown wrapper
  // around "问题1". Treat it as a question only when both a reason and concrete A/B/C options are
  // present, so ordinary prose cannot accidentally reopen M02.
  const reasonMatch = cleanedContent.match(/[（(]\s*追问理由[：:]\s*([\s\S]*?)[）)]/);
  const optionStart = cleanedContent.search(/可选项\s*[：:]/);
  if (!reasonMatch || optionStart < 0) return [];
  const question = cleanedContent
    .slice(0, reasonMatch.index ?? optionStart)
    .replace(/^\s*(?:请进一步询问患者[：:]?)?\s*/g, "")
    .replace(/^\s*(?:\*{0,2})?问题\s*1\s*[：:]\s*(?:\*{0,2})?/g, "")
    .trim();
  const reason = reasonMatch[1]?.trim() || "用于提高当前判断质量。";
  const options = modelOptionsForQuestion(cleanedContent, question, reason);
  if (!question || options.length === 0) return [];
  const fallback = { id: "1", question, reason, fields: parseQuestionFields(cleanedContent), options };
  return isInternalFollowupQuestion(fallback) ? [] : [fallback];
}

function isInternalCollectMessage(content: string): boolean {
  return (
    /四诊信息整理/.test(content) &&
    (/完整度初评/.test(content) || /完整度/.test(content))
  );
}

function QuestionPromptCard({
  content,
  onOption,
  selectedOptions = {},
  freeText = "",
  onFreeTextChange,
  onSubmitAnswer,
  onDetailAnswer,
  canSubmitAnswer = false,
  submitHint,
  isRunning = false,
  requiredItems = [],
}: {
  content: string;
  onOption: (selection: QuestionOptionSelection) => void;
  selectedOptions?: Record<string, QuestionOptionSelection>;
  freeText?: string;
  onFreeTextChange?: (value: string) => void;
  onSubmitAnswer?: () => void;
  onDetailAnswer?: (item: QuestionItem, value: string) => void;
  canSubmitAnswer?: boolean;
  submitHint?: string;
  isRunning?: boolean;
  requiredItems?: QuestionItem[];
}) {
  const items = mergeQuestionItems(requiredItems, parseQuestionItems(content));
  if (items.length === 0) {
    const fallbackSelected = selectedOptions.__fallback?.answer === "本次接诊尚未取得该信息，保持未知。";
    return (
      <div className="space-y-3">
        <MarkdownBlock content={compactMarkdown(content, 900)} compact />
        <button
          type="button"
          onClick={() => onOption({ questionId: "__fallback", answer: "本次接诊尚未取得该信息，保持未知。", kind: "pending_action" })}
          className={`rounded-lg border px-3 py-1.5 text-xs transition-colors ${
            fallbackSelected ? "border-rose-200 bg-rose-50 text-rose-700" : "text-gray-600 hover:bg-gray-50"
          }`}
        >
          {fallbackSelected ? "已选：本次未取得该信息" : "本次未取得该信息"}
        </button>
        <QuestionAnswerComposer
          value={freeText}
          onChange={onFreeTextChange}
          onSubmit={onSubmitAnswer}
          canSubmit={canSubmitAnswer}
          submitHint={submitHint}
          isRunning={isRunning}
        />
      </div>
    );
  }

  const selectedAnswers = items
    .map((item) => {
      const selected = selectedOptions[item.id];
      if (selected && questionOptionKind(selected) !== "clinical_fact") return null;
      if (selected?.requiresDetail && !selected.detailAnswer?.trim()) return null;
      if (!selected) return null;
      const answer = selected.requiresDetail
        ? `医生补充：${selected.detailAnswer?.trim()}`
        : selected.answer;
      return `问题${item.id}：${answer}`;
    })
    .filter(Boolean);
  const selectedGuidance = items
    .map((item) => {
      const selected = selectedOptions[item.id];
      return questionOptionKind(selected || {}) === "clinical_fact" && selected?.requiresDetail && !selected.detailAnswer?.trim()
        ? selected.guidance
        : null;
    })
    .filter(Boolean);
  const selectedAutofillCount = items
    .map((item) => selectedOptions[item.id])
    .filter((option): option is QuestionOptionSelection =>
      questionOptionKind(option || {}) === "clinical_fact" && Boolean(option?.patch && Object.keys(option.patch).length > 0),
    )
    .length;

  return (
    <div className="space-y-3">
      <div>
        <p className="text-sm font-semibold text-gray-800">需补充的信息</p>
        <p className="mt-1 text-xs text-gray-500">
          本轮集中核实最影响判断的几项信息。可直接点选，也可在对应问题下记录患者原话、查体或检查结果；未回答项保持未知。
        </p>
      </div>
      {selectedAnswers.length > 0 && (
        <div className="rounded-xl border border-rose-100 bg-rose-50 px-3 py-2 text-xs leading-relaxed text-rose-700">
          已选择：{selectedAnswers.join("；")}
          {selectedAutofillCount > 0 && <p className="mt-1 text-rose-600">已暂存 {selectedAutofillCount} 项确认信息；提交本轮回答后一次性回填病历。</p>}
        </div>
      )}
      {selectedGuidance.length > 0 && (
        <div className="rounded-xl border border-blue-100 bg-blue-50 px-3 py-2 text-xs leading-relaxed text-blue-800">
          补录位置：{Array.from(new Set(selectedGuidance)).join("；")}
        </div>
      )}
      {items.map((item) => (
        <div key={item.id} className="rounded-xl border bg-gray-50 p-3">
          <p className="text-sm font-medium leading-relaxed text-gray-800">{item.question}</p>
          <p className="mt-1 text-xs leading-relaxed text-gray-500">追问理由：{item.reason}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {item.options.map((option) => {
              const selected = selectedOptions[item.id]?.answer === option.answer;
              const pendingAction = selected && questionOptionKind(option) !== "clinical_fact";
              const detailPending = selected && questionOptionKind(option) === "clinical_fact" && option.requiresDetail && !selectedOptions[item.id]?.detailAnswer?.trim();
              return (
                <button
                  key={option.label}
                  type="button"
                  onClick={() => onOption({ ...option, questionId: item.id })}
                  className={`rounded-full border px-3 py-1.5 text-xs transition-colors ${
                    pendingAction || detailPending
                      ? "border-amber-300 bg-amber-50 text-amber-800"
                      : selected
                      ? "border-rose-300 bg-rose-100 text-rose-800"
                      : "bg-white text-gray-700 hover:border-rose-200 hover:bg-rose-50 hover:text-rose-700"
                  }`}
                >
                  {pendingAction ? `已选：${option.label}` : detailPending ? `待填写：${option.label}` : selected ? `已选：${option.label}` : option.label}
                </button>
              );
            })}
          </div>
          {onDetailAnswer && (
            <label className="mt-3 block text-xs font-medium text-gray-600">
              {selectedOptions[item.id]?.requiresDetail ? "补充具体表现" : "其他（医生补充）"}
              <textarea
                value={selectedOptions[item.id]?.requiresDetail
                  ? selectedOptions[item.id]?.detailAnswer || ""
                  : selectedOptions[item.id]?.label === "医生补充" ? selectedOptions[item.id]?.answer || "" : ""}
                onChange={(event) => onDetailAnswer(item, event.target.value.slice(0, MAX_CASE_SUPPLEMENT_CHARS))}
                maxLength={MAX_CASE_SUPPLEMENT_CHARS}
                rows={2}
                disabled={isRunning}
                placeholder={selectedOptions[item.id]?.requiresDetail
                  ? "请写明患者实际出现的具体表现"
                  : "记录患者实际回答、医生查体或已取得的检查结果"}
                className="mt-1.5 w-full resize-y rounded-lg border border-gray-200 bg-white px-3 py-2 text-[13px] leading-5 text-gray-800 outline-none placeholder:text-gray-400 focus:border-teal-300 disabled:bg-gray-50 disabled:text-gray-400"
              />
            </label>
          )}
        </div>
      ))}
      {onSubmitAnswer && (
        <form
          className="rounded-xl border border-amber-200 bg-white p-3"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmitAnswer();
          }}
        >
          <button
            type="submit"
            disabled={isRunning || !canSubmitAnswer}
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-teal-600 px-4 py-2 text-[13px] font-bold text-white transition-colors hover:bg-teal-700 disabled:cursor-not-allowed disabled:bg-gray-300"
          >
            {isRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Brain className="h-4 w-4" />}
            提交本轮回答并继续推理
          </button>
          {submitHint && <p className="mt-2 text-center text-[11px] font-medium text-amber-600">{submitHint}</p>}
        </form>
      )}
    </div>
  );
}

function QuestionAnswerComposer({
  value,
  onChange,
  onSubmit,
  canSubmit,
  submitHint,
  isRunning,
}: {
  value: string;
  onChange?: (value: string) => void;
  onSubmit?: () => void;
  canSubmit: boolean;
  submitHint?: string;
  isRunning: boolean;
}) {
  if (!onChange || !onSubmit) return null;
  return (
    <form
      className="rounded-xl border border-amber-200 bg-white p-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <label className="text-xs font-bold text-gray-700" htmlFor="question-inline-answer">补充信息</label>
      <textarea
        id="question-inline-answer"
        value={value}
        onChange={(event) => onChange(event.target.value.slice(0, MAX_CASE_SUPPLEMENT_CHARS))}
        maxLength={MAX_CASE_SUPPLEMENT_CHARS}
        placeholder="可直接填写：舌淡红苔薄白，脉弦细；或 T36.6 P78 R18 BP120/80；或年龄45岁。"
        rows={3}
        disabled={isRunning}
        className="mt-2 w-full resize-y rounded-lg border border-gray-200 px-3 py-2 text-[13px] leading-5 text-gray-800 outline-none placeholder:text-gray-400 focus:border-teal-300 disabled:bg-gray-50 disabled:text-gray-400"
      />
      <button
        type="submit"
        disabled={isRunning || !canSubmit}
        className="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-teal-600 px-4 py-2 text-[13px] font-bold text-white transition-colors hover:bg-teal-700 disabled:cursor-not-allowed disabled:bg-gray-300"
      >
        {isRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Brain className="h-4 w-4" />}
        用已选信息继续推理
      </button>
      {submitHint && <p className="mt-2 text-center text-[11px] font-medium text-amber-600">{submitHint}</p>}
    </form>
  );
}

export function buildDecisionSummary(caseState: CaseState) {
  const diagnosisText = caseState.diagnosis ?? "";
  const prescriptionText = caseState.prescription ?? "";
  const riskText = caseState.riskAssessment ?? "";

  const westernSection = extractSectionLoose(diagnosisText, ["现代医学风险/需排除方向", "西医诊断", "西医辨病", "现代医学诊断"]);
  const tcmDiagnosisSection = extractSectionLoose(diagnosisText, ["中医证候诊断", "中医病名与证候诊断", "中医诊断"]);
  const patternSection = extractSectionLoose(diagnosisText, ["证候分布与病机映射", "中医辨证分型", "中医辨证", "中医证候", "证候诊断", "辨证分型"]);
  const mechanismSection = extractSectionLoose(diagnosisText, ["总体病机", "总病机", "核心病机"]);
  const subMechanismSection = extractSectionLoose(diagnosisText, ["子病机拆解", "子病机", "病机拆解"]);
  const treatmentSection = extractSectionLoose(diagnosisText, ["治法框架", "治法", "治疗原则"]);
  const diagnosisEvidenceSection = extractSectionLoose(diagnosisText, ["证据链", "诊断证据", "证据支持", "循证依据"]);

  const preCheckSection = extractSectionLoose(prescriptionText, ["处方前必要信息核查", "处方前核查", "必要信息核查"]);
  const formulaThinkingSection = extractSectionLoose(prescriptionText, ["组方总思路", "处方总思路", "方药总思路"]);
  const mechanismDrugMatrixSection = extractSectionLoose(prescriptionText, ["子病机-治法-药组矩阵", "子病机治法药组矩阵", "病机-治法-药组矩阵"]);
  const prescriptionPlanSection = extractSectionLoose(prescriptionText, ["中药饮片处方", "候选治疗方案", "候选方药方案", "推荐处方", "方药建议", "治疗方案"]);
  const herbMatrixSection = extractSectionLoose(prescriptionText, ["饮片药物角色明细", "单味药角色矩阵", "药物角色矩阵", "药味角色矩阵"]);
  const matchMatrixSection = extractSectionLoose(prescriptionText, ["病-证-方-药匹配矩阵", "病证方药匹配矩阵"]);
  const additionSection = extractSectionLoose(prescriptionText, ["加减方案", "加减思路", "随证加减"]);
  const medicineRiskSection = extractSectionLoose(
    riskText,
    ["合理用药审方（灵犀统一审方引擎）", "合理用药审方", "灵犀统一审方"],
  );
  const westernPatentMedicineSection = extractSectionLoose(prescriptionText, ["西药/中成药方案", "西药与中成药方案", "中成药方案", "联合用药方案", "中成药替代方案"]);
  const nonDrugSection = extractSectionLoose(prescriptionText, ["非药物干预", "非药物治疗"]);

  const riskSummarySection = extractSectionLoose(riskText, ["处方安全总评", "风险总评", "安全总评"]);
  const referralSection = extractSectionLoose(riskText, ["转诊评估", "转诊建议"]);
  const followupSection = extractSectionLoose(riskText, ["随访管理方案", "随访方案"]);
  const followupTimelineSection = extractSectionLoose(riskText, ["随访时间轴", "时间轴"]);
  const redFlagPatientSection = extractSectionLoose(riskText, ["红旗预警（患者须知）", "红旗预警"]);
  const rehabSection = extractSectionLoose(riskText, ["中医康复管理", "康复管理"]);
  const streamIntegritySection = [
    extractSectionLoose(prescriptionText, ["流式完整性提示", "模型响应完整性提示"]),
    extractSectionLoose(riskText, ["流式完整性提示", "模型响应完整性提示"]),
  ].filter(Boolean).join("\n\n");

  const westernDiagnosis = normalizeWesternDiagnosis(
    extractField(westernSection, ["风险/需排除方向", "现代医学风险", "西医诊断", "首要考虑诊断"]) ||
    extractField(diagnosisText, ["风险/需排除方向", "现代医学风险", "西医诊断", "首要考虑诊断"]) ||
    firstMeaningfulLine(westernSection)
  );
  const westernEvidence =
    extractField(westernSection, ["支持证据", "诊断证据", "证据支持"]) ||
    extractField(diagnosisText, ["西医诊断证据"]);
  const westernReference =
    extractField(westernSection, ["证据依据", "来源依据", "参考依据"]) ||
    extractField(diagnosisText, ["西医证据依据"]);
  const tcmPattern =
    extractTableFirstColumnValues(patternSection) ||
    extractField(tcmDiagnosisSection, ["证候诊断", "主证候", "证候", "证型"]) ||
    extractField(patternSection, ["候选证候", "主证", "证候", "证型"]) ||
    extractField(diagnosisText, ["证候诊断", "中医证候", "证候", "证型"]) ||
    firstMeaningfulLine(patternSection);
  const tcmEvidence =
    extractField(tcmDiagnosisSection, ["证据支持", "支持证据", "辨证依据"]) ||
    extractField(patternSection, ["支持证据"]);
  const tcmReference =
    extractField(tcmDiagnosisSection, ["证据依据", "来源依据"]) ||
    extractField(diagnosisText, ["中医证据依据"]);
  const coreMechanism =
    extractField(mechanismSection, ["核心病机", "总体病机", "总病机"]) ||
    firstMeaningfulLine(mechanismSection);
  const treatmentPrinciple =
    extractField(treatmentSection, ["总治法", "治法", "治疗原则"]) ||
    firstMeaningfulLine(treatmentSection);
  const outputLevel =
    extractField(diagnosisText, ["结论", "输出层级"]) ||
    extractField(preCheckSection, ["输出层级"]) ||
    extractFirstMatch(diagnosisText, [/完整候选方案|信息不足建议模式|高风险安全建议模式/]);
  const formulaName = cleanInlineMarkdown(
    extractFirstMatch(prescriptionPlanSection || prescriptionText, [
      /###\s*候选(?:处方|方案)\d*[：:]\s*([^\n]+)/,
      /##\s*(?:中药饮片处方|候选治疗方案)\s*\n[\s\S]*?###\s*([^\n]+)/,
      /\*\*方剂\*\*[：:]\s*([^\n]+)/,
      /\*\*推荐处方\*\*[：:]\s*([^\n]+)/,
    ]) || firstMeaningfulLine(prescriptionPlanSection)
  );
  const formulaReference =
    extractField(prescriptionPlanSection, ["经典方出处", "方剂资料收载来源", "组方依据", "方剂出处或依据", "证据依据", "方剂依据", "依据"]) ||
    extractField(formulaThinkingSection, ["经典方出处", "方剂资料收载来源", "组方依据", "证据依据", "方剂依据", "依据"]);
  const formulaEvidence =
    extractField(prescriptionPlanSection, ["适用条件", "加减逻辑", "证据支持"]) ||
    extractField(formulaThinkingSection, ["处方策略", "总体病机"]);
  const westernPatentReference = extractField(westernPatentMedicineSection, ["证据依据", "来源依据", "依据"]);
  const westernPatentEvidence = extractField(westernPatentMedicineSection, ["用药定位", "对应问题", "适用条件", "证据支持"]);

  return {
    westernSection,
    tcmDiagnosisSection,
    patternSection,
    mechanismSection,
    subMechanismSection,
    treatmentSection,
    preCheckSection,
    formulaThinkingSection,
    mechanismDrugMatrixSection,
    prescriptionPlanSection,
    herbMatrixSection,
    matchMatrixSection,
    additionSection,
    medicineRiskSection,
    westernPatentMedicineSection,
    nonDrugSection,
    riskSummarySection,
    referralSection,
    followupSection,
    followupTimelineSection,
    redFlagPatientSection,
    rehabSection,
    streamIntegritySection,
    diagnosisEvidenceSection,
    westernDiagnosis,
    westernEvidence,
    westernReference,
    tcmPattern,
    tcmEvidence,
    tcmReference,
    coreMechanism,
    treatmentPrinciple,
    outputLevel,
    formulaName,
    formulaEvidence,
    formulaReference,
    westernPatentEvidence,
    westernPatentReference,
  };
}

function extractRiskAuditSection(content = ""): string {
  const lines = content.split("\n");
  const collected: string[] = [];
  let capturing = false;
  for (const line of lines) {
    const heading = line.match(/^##\s+(.+?)\s*$/)?.[1] || "";
    if (heading) {
      if (capturing) break;
      capturing = /合理用药审方|灵犀统一审方/.test(heading);
    }
    if (capturing) collected.push(line);
  }
  return collected.join("\n").trim();
}

function extractRiskNonAuditSection(content = ""): string {
  const auditSection = extractRiskAuditSection(content);
  return (auditSection ? content.replace(auditSection, "") : content).trim();
}

function replaceRiskAssessmentFollowup(existing: string | undefined, generated: string): string {
  if (/^##\s*(?:合理用药审方|灵犀统一审方)/m.test(generated)) return generated.trim();
  return [extractRiskAuditSection(existing), generated.trim()].filter(Boolean).join("\n\n");
}

function generationStatus(phase: Phase): { title: string; desc: string } {
  if (phase === "diagnose") {
    return { title: "正在生成辨病辨证结果", desc: "完成后会展示现代医学风险方向、证候诊断、病机、治法和证据支持。" };
  }
  if (phase === "prescribe") {
    return { title: "正在生成候选方药", desc: "完成后会补入饮片处方、剂量、煎服法、药物角色和西药/中成药方案。" };
  }
  if (phase === "assess") {
    return { title: "正在生成风险随访提示", desc: "红旗状态、处方风险、转诊和随访建议会汇总到右侧与风险随访页。" };
  }
  return { title: "正在处理", desc: "请稍候。" };
}

export function buildCompleteReport(caseState: CaseState): string {
  const reportSection = (content?: string) => sanitizeCustomerEvidenceSurface(stripDiagnosisJSON(content || ""));
  const deidentifiedPatient = {
    sex: caseState.patient.sex,
    age: caseState.patient.age,
  };
  return normalizeClinicalText([
    `# 中医CDSS辅助诊疗脱敏报告`,
    `导出说明：本报告默认脱敏，仅供授权医生在院内环境复核使用。`,
    `病例编号：已脱敏`,
    `主诉：${caseState.chiefComplaint || "未采集"}`,
    "",
    "## 已采集信息",
    `基本信息：${formatUnknown(deidentifiedPatient)}`,
    `症状：${formatUnknown(caseState.symptoms)}`,
    `舌象：${formatUnknown(caseState.tongue)}`,
    `脉象：${formatUnknown(caseState.pulse)}`,
    `面色/神志：${formatUnknown(caseState.faceNote)}`,
    `生命体征：${formatUnknown(caseState.vitals)}`,
    `既往史：${formatUnknown(caseState.pastHistory)}`,
    `用药史：${formatUnknown(caseState.medicationHistory)}`,
    `过敏史：${formatUnknown(caseState.allergyHistory)}`,
    `诊疗思路偏好：${caseState.tcmLineagePreference ? lineageLabel(caseState.tcmLineagePreference) : "未设置"}`,
    "",
    caseState.diagnosis ? `## 辨病辨证\n${reportSection(caseState.diagnosis)}` : "",
    caseState.prescription ? `## 候选方药\n${reportSection(caseState.prescription)}` : "",
    caseState.riskAssessment ? `## 审方与风险随访\n${reportSection(caseState.riskAssessment)}` : "",
  ].filter(Boolean).join("\n\n"));
}

function capturePreviousResult(state: CaseState): CaseState["previousResult"] {
  if (!state.diagnosis && !state.prescription && !state.riskAssessment) return state.previousResult;
  return {
    diagnosis: state.diagnosis,
    prescription: state.prescription,
    riskAssessment: state.riskAssessment,
    capturedAt: new Date().toISOString(),
  };
}

function PreviousResultCard({ result }: { result: NonNullable<CaseState["previousResult"]> }) {
  const sections = [
    { title: "上一版辨病辨证", content: result.diagnosis },
    { title: "上一版候选方药", content: result.prescription },
    { title: "上一版风险随访", content: result.riskAssessment },
  ].filter((section): section is { title: string; content: string } => Boolean(section.content?.trim()));
  if (sections.length === 0) return null;
  return (
    <div data-testid="previous-result-card" className="mb-3 rounded-xl border border-amber-200 bg-white p-4">
      <div className="flex items-start gap-3">
        <History className="mt-0.5 h-4 w-4 text-amber-700" />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-bold text-gray-900">上一版结果（只读对照）</p>
          <p className="mt-1 text-[12px] leading-relaxed text-gray-600">
            新一轮推理尚未完成。以下内容对应修改前病历，不参与本轮辅助分析、自动审方、报告导出或医嘱写回。
          </p>
        </div>
      </div>
      <div className="mt-3 divide-y divide-gray-100 rounded-lg border border-gray-100">
        {sections.map((section) => (
          <details key={section.title} className="group px-3 py-2 first:rounded-t-lg last:rounded-b-lg">
            <summary className="cursor-pointer list-none text-xs font-semibold text-gray-700">
              {section.title}
            </summary>
            <div className="mt-2 border-t border-gray-100 pt-2">
              <MarkdownBlock content={compactMarkdown(section.content, 1400)} compact />
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}

export function scrubReportPhi(text: string, caseState: CaseState): string {
  const explicitNames = [caseState.patient.name, caseState.hisRecord?.fields.patientName]
    .filter((value): value is string => Boolean(value));
  return sanitizeFreeTextForExternalClinicalService(text, explicitNames)
    .replace(/(?:年龄\s*[:：]?\s*)?(?:9\d|1[0-4]\d)\s*岁/g, "年龄：90岁以上")
    .replace(/(?:职业|工作岗位|occupation)\s*[:：]?\s*[^，；。\n]+/gi, "职业：[已泛化]");
}

type DecisionSummary = ReturnType<typeof buildDecisionSummary>;

function hasStructuredDosePrescription(reasoning?: ClinicalReasoningResultV2): boolean {
  return Boolean(
    reasoning?.formula?.candidates?.some((candidate) =>
      candidate.herbs?.some((herb) => cleanInlineMarkdown(herb.name).length > 0 && cleanInlineMarkdown(herb.dose || "").length > 0),
    ),
  );
}

function hasGeneratedDosePrescription(summary: DecisionSummary, reasoning?: ClinicalReasoningResultV2): boolean {
  if (hasStructuredDosePrescription(reasoning)) return true;
  const text = cleanInlineMarkdown(summary.prescriptionPlanSection || "");
  if (!text.trim()) return false;
  // Explicit no-dose conclusions take precedence over incidental words such as “剂量” inside a
  // safety explanation. Otherwise “当前不展示剂量级候选方药” is misclassified as a prescription.
  if (/(?:暂不|不再|未|不)(?:展示|生成|形成).{0,16}剂量级|不生成候选|待生成|信息不足|尚不具备.{0,20}(?:剂量|处方)|未满足剂量级|无剂量级候选|本轮非剂量/.test(text)) return false;
  return /(候选处方|处方名称|推荐处方|剂量|煎服法|\d+\s*g|克)/.test(text);
}

export function hasExplicitNonDosePrescriptionResult(caseState: Pick<CaseState, "prescription">, hasCandidate = false): boolean {
  return !hasCandidate && Boolean(
    caseState.prescription &&
    /(?:不展示剂量级候选方药|不生成中药饮片剂量|当前未满足剂量级候选处方)/.test(caseState.prescription),
  );
}

function hasMeaningfulMedicationRisk(section?: string): boolean {
  const text = cleanInlineMarkdown(section || "").replace(/\s+/g, "");
  if (!text || text === "暂无" || text === "待生成") return false;
  const onlyNoRisk =
    /未见明显|未发现|暂无|无明确|无特殊/.test(text) &&
    !/慎用|禁忌|相互作用|ADR|不良反应|过敏|肝肾|出血|妊娠|哺乳|儿童|老年|毒性|当前用药未知|无法评估|需确认|需复核|强提示|一般提示|信息不足提示/.test(text);
  if (onlyNoRisk) return false;
  return /强提示|一般提示|信息不足提示|慎用|禁忌|相互作用|ADR|不良反应|过敏|肝肾|出血|妊娠|哺乳|儿童|老年|毒性|当前用药未知|无法评估|需确认|需复核|减量|替换|停药|转诊/.test(text);
}

function DecoctionInstructionsPanel({ decoction }: {
  decoction?: {
    doseCount: string | null;
    method: string;
    course: string;
    followUpNode: string;
    dailyDoseCount?: number;
    soakMinutes?: number;
    decoctionTimes?: number;
    firstDecoctionMinutes?: number;
    secondDecoctionMinutes?: number;
    targetVolumeMl?: number;
    administration?: string;
  };
}) {
  if (!decoction) return null;
  const preparation = [
    decoction.soakMinutes != null ? `冷水浸泡 ${decoction.soakMinutes} 分钟` : "",
    "武火煮沸后转文火",
    decoction.decoctionTimes != null ? `煎煮 ${decoction.decoctionTimes} 次` : "",
    decoction.firstDecoctionMinutes != null ? `一煎 ${decoction.firstDecoctionMinutes} 分钟` : "",
    decoction.secondDecoctionMinutes != null ? `二煎 ${decoction.secondDecoctionMinutes} 分钟` : "",
    decoction.targetVolumeMl != null ? `合并药液约 ${decoction.targetVolumeMl}mL` : "",
  ].filter(Boolean).join("；");
  const items = [
    { label: "剂数与疗程", value: [decoction.doseCount, decoction.course].filter(Boolean).join(" · ") },
    { label: "煎煮", value: preparation || decoction.method },
    { label: "服法", value: decoction.administration || (decoction.dailyDoseCount ? `每日${decoction.dailyDoseCount}剂` : "") },
    { label: "复诊", value: decoction.followUpNode },
  ].filter((item) => isDisplayableClinicalText(item.value) && !/(?:由服务端生成|信息展示不全|待确认)/.test(item.value));
  if (items.length === 0) return null;
  return (
    <div className="rounded-xl border border-rose-100 bg-rose-50/60 p-3">
      <p className="text-xs font-bold text-rose-800">常规煎服参考</p>
      <div className="mt-2 grid gap-2 md:grid-cols-2">
      {items.map((item) => (
        <div key={item.label} className="rounded-lg bg-white px-3 py-2 text-xs leading-relaxed text-gray-700">
          <p className="text-[11px] font-bold text-rose-600">{item.label}</p>
          <p className="mt-1">{item.value}</p>
        </div>
      ))}
      </div>
    </div>
  );
}

function FormulaReasonBand({
  condition,
  rationale,
  evidence,
}: {
  condition?: string;
  rationale?: string;
  evidence?: string;
}) {
  const items = [
    { label: "方证匹配", value: condition || evidence || "围绕证候、病机和主症进行方药匹配。" },
    { label: "加减思路", value: rationale || "根据本例兼证、舌脉与症状变化随证加减，由医生结合复诊结果复核。" },
  ];

  return (
    <div className="rounded-xl border border-blue-100 bg-blue-50/70 p-3">
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-blue-800">
        <BookOpen className="h-3.5 w-3.5" />
        方证匹配与加减思路
      </div>
      <div className={`grid gap-2 ${items.length >= 3 ? "md:grid-cols-3" : "md:grid-cols-2"}`}>
        {items.map((item) => (
          <div key={item.label} className="rounded-lg bg-white/80 px-3 py-2">
            <p className="text-[11px] font-semibold text-blue-500">{item.label}</p>
            <p className="mt-1 text-xs leading-relaxed text-blue-950">{clipText(item.value, 150)}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function MechanismDrugMatrix({ section }: { section?: string }) {
  const table = findTableByHeaders(section, ["子病机", "子治疗方向"]);
  if (!table || table.rows.length === 0) return null;

  return (
    <div className="rounded-xl border bg-white p-4">
      <div className="mb-3 flex items-center gap-2">
        <ClipboardList className="h-4 w-4 text-rose-600" />
        <p className="text-sm font-semibold text-gray-900">病机-治法-药组链路</p>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {table.rows.map((row, index) => {
          const mechanism = getTableCell(table, row, ["子病机"]);
          const direction = getTableCell(table, row, ["子治疗方向"]);
          const mainDrugs = getTableCell(table, row, ["主药组"]);
          const pair = getTableCell(table, row, ["增强配伍"]);
          const evidence = getTableCell(table, row, ["对应症状/四诊依据", "四诊依据", "症状依据"]);
          const risk = getTableCell(table, row, ["风险点"]);
          return (
            <div key={`${mechanism}-${index}`} className="rounded-xl border border-gray-100 bg-gray-50 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-semibold text-rose-700">
                  {mechanism || `子病机${index + 1}`}
                </span>
                {direction && <span className="text-xs font-medium text-gray-700">{direction}</span>}
              </div>
              <div className="mt-3 grid gap-2 text-xs leading-relaxed text-gray-700">
                {mainDrugs && <p><span className="font-semibold text-gray-900">主药组：</span>{mainDrugs}</p>}
                {pair && <p><span className="font-semibold text-gray-900">增强配伍：</span>{pair}</p>}
                {evidence && <p><span className="font-semibold text-gray-900">依据：</span>{evidence}</p>}
                {risk && <p className="text-amber-700"><span className="font-semibold">风险点：</span>{risk}</p>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

type StructuredFormula = NonNullable<ClinicalReasoningResultV2["formula"]>;
type StructuredCandidate = StructuredFormula["candidates"][number];
type StructuredHerb = StructuredCandidate["herbs"][number];
type HerbAuditStatus = "pristine" | "dirty" | "checking" | "reviewed" | "warning" | "error";
type HerbFunctionLookupStatus = "loading" | "found" | "not_found" | "error";
export const WORKBENCH_REFRESH_WARNING = "当前未提交的药味编辑仅保留在本页面；刷新或关闭页面会丢失。请先完成重新审方并标记为医生候选方案。";
type AcceptedEditedPrescription = {
  caseId: string;
  reasoning: ClinicalReasoningResultV2;
  auditSection: string;
  followupSection: string;
  serverSafetyLocked: boolean;
  revision: NonNullable<CaseState["prescriptionRevision"]>;
};

function auditRevisionNeedsAttention(revision: NonNullable<CaseState["prescriptionRevision"]>): boolean {
  return revision.auditAvailable === false ||
    revision.degraded === true ||
    revision.needManualReview === true ||
    revision.auditResult === "MANUAL_REVIEW" ||
    revision.auditResult === "BLOCK" ||
    ["MEDIUM", "HIGH", "CRITICAL"].includes(revision.highestRiskLevel);
}

function defaultEvidenceRef() {
  return { evidenceLevel: "model_inference" as const, source: "医生编辑后待重新审方", confidence: "中" as const };
}

const EDITED_HERB_PLACEHOLDER = /(待医生|待填写|待补充|待确认|待核实|未填写|未说明|占位)/;
const EDITED_HERB_DOSE = /^(\d+(?:\.\d+)?)\s*(g|克|mg|毫克)$/i;

function hasIncompleteEditedHerb(herb: StructuredHerb): boolean {
  const doseMatch = String(herb.dose ?? "").trim().match(EDITED_HERB_DOSE);
  const doseAmount = doseMatch ? Number(doseMatch[1]) : Number.NaN;
  const doseGrams = doseMatch && /^(?:mg|毫克)$/i.test(doseMatch[2]) ? doseAmount / 1000 : doseAmount;
  const invalidDose = !doseMatch || !Number.isFinite(doseGrams) || doseGrams < 0.001 || doseGrams > 500;
  const invalidTarget = herb.targetKind === "pathogenesis_node"
    ? !/^P\d{1,2}$/.test(herb.targetRef || "") || herb.structureRole != null
    : herb.targetKind === "formula_structure"
      ? herb.targetRef !== "FORMULA_STRUCTURE" || !herb.structureRole || (herb.role !== "佐" && herb.role !== "使")
      : true;
  return !herb.name.trim() || invalidDose || !herb.role || invalidTarget ||
    !herb.targetPathogenesis.trim() || !herb.function.trim() ||
    EDITED_HERB_PLACEHOLDER.test(`${herb.targetPathogenesis} ${herb.function}`);
}

function editedFormulaAnalysis(herbs: StructuredHerb[]): string {
  const roleOrder: StructuredHerb["role"][] = ["君", "臣", "佐", "使"];
  const roleText = roleOrder.flatMap((role) => {
    const members = herbs.filter((herb) => herb.role === role && herb.name.trim());
    if (members.length === 0) return [];
    return [`${role}药${members.map((herb) => `${herb.name}（${herb.function}，对应${herb.targetPathogenesis}）`).join("、")}`];
  });
  return [
    `编辑后方义（以当前${herbs.length}味药为准）`,
    ...roleText,
    "本段由当前结构化药味表确定性生成；药味再次增删改后须重新生成并获取审方提示。",
  ].join("；");
}

function removeDeletedHerbClauses(value: string, deletedNames: string[]): string {
  if (!value || deletedNames.length === 0) return value;
  return value
    .split(/[；;。\n]+/)
    .map((clause) => clause.trim())
    .filter((clause) => clause && !deletedNames.some((name) => clause.includes(name)))
    .join("；");
}

function synchronizedDecoction(
  candidate: StructuredCandidate,
  herbs: StructuredHerb[],
  deletedNames: string[],
): StructuredCandidate["decoction"] {
  const baseMethod = removeDeletedHerbClauses(candidate.decoction.method, deletedNames);
  const requirements = herbs
    .filter((herb) => herb.decoctionRequirement?.trim())
    .map((herb) => `${herb.name}${herb.decoctionRequirement}`)
    .filter((item, index, all) => all.indexOf(item) === index && !baseMethod.includes(item));
  return {
    ...candidate.decoction,
    method: [baseMethod, ...requirements].filter(Boolean).join("；"),
  };
}

function synchronizeEditedCandidate(candidate: StructuredCandidate, herbs: StructuredHerb[]): StructuredCandidate {
  const originalByName = new Map(candidate.herbs.map((herb) => [herb.name.trim(), herb]));
  const editComparable = (herb: StructuredHerb) => JSON.stringify({
    name: herb.name.trim(), processing: herb.processing, dose: herb.dose, role: herb.role,
    prescriptionRole: herb.prescriptionRole, targetKind: herb.targetKind, targetRef: herb.targetRef,
    structureRole: herb.structureRole, targetPathogenesis: herb.targetPathogenesis,
    function: herb.function, decoctionRequirement: herb.decoctionRequirement, isToxic: herb.isToxic,
  });
  const synchronizedHerbs = herbs.map((herb) => ({
    ...herb,
    prescriptionRole: herb.prescriptionRole.replace(/(?:^|；)\s*知识库功用[：:][\s\S]*$/, "").trim()
      || `对应${herb.targetPathogenesis}`,
    evidence: !originalByName.has(herb.name.trim()) ||
      editComparable(originalByName.get(herb.name.trim())!) !== editComparable(herb) ||
      EDITED_HERB_PLACEHOLDER.test(herb.evidence?.source || "") || /待重新审方/.test(herb.evidence?.source || "")
      ? { evidenceLevel: "model_inference" as const, source: "医生结构化编辑记录；已纳入本次编辑后审方版本", confidence: "中" as const }
      : herb.evidence,
  }));
  const currentNames = new Set(synchronizedHerbs.map((herb) => herb.name.trim()).filter(Boolean));
  const deletedNames = candidate.herbs
    .map((herb) => herb.name.trim())
    .filter((name) => name && !currentNames.has(name));
  const changedNames = synchronizedHerbs
    .filter((herb) => {
      const original = originalByName.get(herb.name.trim());
      return original && editComparable(original) !== editComparable(herb);
    })
    .map((herb) => herb.name.trim());
  const retainedOriginalCount = candidate.herbs.filter((herb) => currentNames.has(herb.name.trim())).length;
  const baseFormulas = candidate.baseFormulas?.length
    ? candidate.baseFormulas.map((base) => ({
        ...base,
        matchedIngredientCount: Math.min(base.matchedIngredientCount, retainedOriginalCount),
      }))
    : candidate.formulaSource?.source?.trim()
      ? [{
          name: candidate.name.replace(/(?:加减|化裁|合方|医生编辑版).*$/, "").trim() || candidate.name,
          source: candidate.formulaSource.source,
          matchedIngredientCount: retainedOriginalCount,
        }]
      : undefined;
  return {
    ...candidate,
    name: "本例辨证组方（医生编辑版）",
    constructionType: "self_devised",
    modificationStatus: "modified",
    baseFormulas,
    formulaSource: {
      evidenceLevel: "model_inference",
      source: "医生基于原候选方药完成结构化增删改；经典方信息仅作为原方案来源参考",
      confidence: "中",
    },
    herbs: synchronizedHerbs,
    formulaAnalysis: editedFormulaAnalysis(synchronizedHerbs),
    decoction: synchronizedDecoction(candidate, synchronizedHerbs, [...deletedNames, ...changedNames]),
    therapyMatch: removeDeletedHerbClauses(candidate.therapyMatch, deletedNames) || "以编辑后的药味组合对应当前治法与病机，需医生复核。",
    applicable: removeDeletedHerbClauses(candidate.applicable, deletedNames) || "以编辑后药味、当前证候和安全信息为准。",
    notApplicable: removeDeletedHerbClauses(candidate.notApplicable, deletedNames) || "证候或安全边界变化时不再适用。",
  };
}

function filterModificationsForEditedHerbs(
  modifications: StructuredFormula["modifications"],
  originalHerbs: StructuredHerb[],
  editedHerbs: StructuredHerb[],
): StructuredFormula["modifications"] {
  const currentNames = new Set(editedHerbs.map((herb) => herb.name.trim()).filter(Boolean));
  const originalNames = new Set(originalHerbs.map((herb) => herb.name.trim()).filter(Boolean));
  const deletedNames = originalHerbs.map((herb) => herb.name.trim()).filter((name) => name && !currentNames.has(name));
  const retained = modifications.filter((item) => !deletedNames.some((name) =>
    `${item.action} ${item.doseOrHandling || ""} ${item.reason}`.includes(name)
  )).map((item) => {
    const edited = editedHerbs.find((herb) => item.action.includes(herb.name.trim()));
    const original = edited && originalHerbs.find((herb) => herb.name.trim() === edited.name.trim());
    if (!edited || !original || JSON.stringify(original) === JSON.stringify(edited)) return item;
    return {
      ...item,
      targetPathogenesis: edited.targetPathogenesis,
      doseOrHandling: [edited.dose, edited.decoctionRequirement].filter(Boolean).join("；") || null,
      reason: edited.function,
      riskNote: "该药味已由医生结构化编辑并进入当前审方版本，原加减说明不再适用。",
      evidence: { evidenceLevel: "model_inference" as const, source: "医生结构化编辑记录", confidence: "中" as const },
    };
  });
  const added = editedHerbs
    .filter((herb) => herb.name.trim() && !originalNames.has(herb.name.trim()))
    .filter((herb) => !retained.some((item) => `${item.action} ${item.doseOrHandling || ""}`.includes(herb.name.trim())))
    .map((herb): StructuredFormula["modifications"][number] => ({
      trigger: "医生结构化编辑",
      targetPathogenesis: herb.targetPathogenesis,
      action: `加${herb.name.trim()}`,
      doseOrHandling: [herb.dose, herb.decoctionRequirement].filter(Boolean).join("；") || null,
      reason: herb.function,
      riskNote: "新增药味已进入编辑后审方版本，采纳前仍需医生结合患者情况复核。",
      evidence: { evidenceLevel: "model_inference", source: "医生结构化编辑记录", confidence: "中" },
    }));
  return [...retained, ...added];
}

function cloneStructuredHerb(herb: StructuredHerb): StructuredHerb {
  return {
    ...herb,
    processing: herb.processing ?? null,
    dose: herb.dose ?? null,
    evidence: herb.evidence || defaultEvidenceRef(),
  };
}

function createBlankHerb(defaultNode?: { id: string; text: string }): StructuredHerb {
  return {
    name: "",
    processing: null,
    dose: "",
    role: "佐",
    prescriptionRole: "医生新增药味，待审方复核",
    targetKind: "pathogenesis_node",
    targetRef: defaultNode?.id || "",
    structureRole: null,
    targetPathogenesis: defaultNode?.text || "待选择对应病机",
    function: "待医生填写加减目的",
    isToxic: false,
    decoctionRequirement: undefined,
    evidence: defaultEvidenceRef(),
  };
}

function herbEditSignature(herbs: StructuredHerb[]): string {
  return JSON.stringify(herbs.map((herb) => ({
    name: herb.name,
    processing: herb.processing,
    dose: herb.dose,
    role: herb.role,
    prescriptionRole: herb.prescriptionRole,
    targetKind: herb.targetKind,
    targetRef: herb.targetRef,
    structureRole: herb.structureRole,
    targetPathogenesis: herb.targetPathogenesis,
    function: herb.function,
    decoctionRequirement: herb.decoctionRequirement,
    isToxic: herb.isToxic,
  })));
}

function markdownTableCell(value: unknown): string {
  return String(value ?? "").replace(/\r?\n/g, "；").replace(/\|/g, "｜").trim();
}

function buildAcceptedPrescriptionMarkdown(reasoning: ClinicalReasoningResultV2, candidateIndex: number, herbHash?: string): string {
  const candidate = reasoning.formula?.candidates[candidateIndex];
  if (!candidate) return "";
  const herbRows = candidate.herbs.map((herb, index) =>
    `| ${index + 1} | ${markdownTableCell(herb.name)} | ${markdownTableCell(herb.dose || "待医生确认")} | ${markdownTableCell(herb.role)} | ${markdownTableCell(herb.targetPathogenesis)} | ${markdownTableCell(herb.function)} | ${markdownTableCell([herb.processing ? `炮制：${herb.processing}` : "", herb.decoctionRequirement].filter(Boolean).join("；") || "常规")} |`
  );
  const modifications = reasoning.formula?.modifications || [];
  return [
    "## 中药饮片处方",
    ...(herbHash ? [`**处方版本摘要**：${markdownTableCell(herbHash)}`] : []),
    `**候选方名/方向**：${markdownTableCell(candidate.name)}`,
    "",
    "| 序号 | 药名 | 剂量 | 角色 | 对应病机 | 功用 | 炮制/煎服 |",
    "|---|---|---|---|---|---|---|",
    ...herbRows,
    "",
    "## 方义解析",
    candidate.formulaAnalysis,
    ...(shouldRenderEvidenceStatus(candidate.formulaSource) ? [
      "",
      "## 方剂出处",
      `**出处**：${markdownTableCell(candidate.formulaSource.source)}`,
    ] : []),
    ...(candidate.constructionType === "combined" && candidate.baseFormulas && candidate.baseFormulas.length > 1 ? candidate.baseFormulas.map((base) =>
      `- ${markdownTableCell(base.name)}：${markdownTableCell(base.source)}；当前保留匹配药味 ${base.matchedIngredientCount} 味。`
    ) : []),
    "",
    "## 煎服法",
    `剂数：${candidate.decoction.doseCount || "待医生确认"}；方法：${candidate.decoction.method}；疗程：${candidate.decoction.course}；复核节点：${candidate.decoction.followUpNode}`,
    ...(modifications.length > 0 ? [
      "",
      "## 随症加减",
      ...modifications.map((item) => `- ${markdownTableCell(item.trigger)}：${markdownTableCell(item.action)}${item.doseOrHandling ? `（${markdownTableCell(item.doseOrHandling)}）` : ""}；${markdownTableCell(item.reason)}`),
    ] : []),
  ].join("\n").trim();
}

function candidateHerbSignature(candidate: StructuredCandidate): string {
  return herbEditSignature(candidate.herbs.map(cloneStructuredHerb));
}

function buildReasoningWithEditedHerbs(
  reasoning: ClinicalReasoningResultV2,
  candidateIndex: number,
  herbs: StructuredHerb[],
): ClinicalReasoningResultV2 {
  if (!reasoning.formula) return reasoning;
  const originalCandidate = reasoning.formula.candidates[candidateIndex];
  if (!originalCandidate) return reasoning;
  return {
    ...reasoning,
    formula: {
      ...reasoning.formula,
      candidates: reasoning.formula.candidates.map((candidate, index) =>
        index === candidateIndex
          ? synchronizeEditedCandidate(candidate, herbs.map(cloneStructuredHerb))
          : candidate
      ),
      modifications: filterModificationsForEditedHerbs(
        reasoning.formula.modifications,
        originalCandidate.herbs,
        herbs,
      ),
    },
  };
}

function formatWorkbenchUnsavedAt(unsavedAt: string): string {
  const parsed = Date.parse(unsavedAt);
  if (!Number.isFinite(parsed)) return "时间未知";
  return new Date(parsed).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function HerbModificationWorkbench({
  caseState,
  candidate,
  candidateIndex,
  onAccept,
  restoredUnsavedDraft,
  onUnsavedDraftChange,
}: {
  caseState: CaseState;
  candidate: StructuredCandidate;
  candidateIndex: number;
  onAccept: (accepted: AcceptedEditedPrescription) => Promise<void>;
  restoredUnsavedDraft?: WorkbenchUnsavedDraftFlag | null;
  onUnsavedDraftChange?: (flag: WorkbenchUnsavedDraftFlag | null) => void;
}) {
  const initialHerbs = useMemo(() => candidate.herbs.map(cloneStructuredHerb), [candidate]);
  const pathogenesisOptions = useMemo(() => {
    const reasoning = diagnoseReasoningFromState(caseState);
    return (reasoning?.pathogenesis?.chain || []).map((node, index) => ({
      id: node.nodeId || `P${index + 1}`,
      text: node.pathogenesis || node.syndromeEvidence,
    })).filter((item) => item.text.trim());
  }, [caseState]);
  const initialSignature = useMemo(() => herbEditSignature(initialHerbs), [initialHerbs]);
  const alreadyAccepted =
    caseState.prescriptionRevision?.candidateIndex === candidateIndex &&
    caseState.prescriptionRevision.herbHash.startsWith("sha256-");
  const activeReasoning = mergeReasoningStages(diagnoseReasoningFromState(caseState), prescribeReasoningFromState(caseState)) || caseState.reasoningV2;
  const restoredAcceptedRevision = alreadyAccepted && caseState.prescriptionRevision && activeReasoning
    ? {
        caseId: caseState.id,
        reasoning: activeReasoning,
        auditSection: extractRiskAuditSection(caseState.riskAssessment),
        followupSection: extractRiskNonAuditSection(caseState.riskAssessment),
        serverSafetyLocked: caseState.safetyLocked === true,
        revision: caseState.prescriptionRevision,
      } satisfies AcceptedEditedPrescription
    : null;
  const [herbs, setHerbs] = useState<StructuredHerb[]>(() => initialHerbs);
  const [auditStatus, setAuditStatus] = useState<HerbAuditStatus>(() => {
    if (!alreadyAccepted || !caseState.prescriptionRevision) return "pristine";
    return auditRevisionNeedsAttention(caseState.prescriptionRevision) ? "warning" : "reviewed";
  });
  const [auditMessage, setAuditMessage] = useState(alreadyAccepted
    ? "编辑后的药味已完成审方并写回当前病例，页面、报告与 HIS 均使用该版本。"
    : "增删改药味后，请重新审方以更新风险提示。");
  const [finalReady, setFinalReady] = useState(alreadyAccepted);
  const [acceptedRevision, setAcceptedRevision] = useState<AcceptedEditedPrescription | null>(() => restoredAcceptedRevision);
  const herbFunctionCacheRef = useRef(new Map<string, string>());
  const [herbFunctionLookupStatus, setHerbFunctionLookupStatus] = useState<Record<string, HerbFunctionLookupStatus>>({});

  const missingHerbFunctionNamesKey = useMemo(() => JSON.stringify(Array.from(new Set(
    herbs
      .filter((herb) => !herb.function.trim())
      .map((herb) => herb.name.trim())
      .filter(Boolean),
  ))), [herbs]);

  useEffect(() => {
    const pendingNames = JSON.parse(missingHerbFunctionNamesKey) as string[];
    if (pendingNames.length === 0) return;

    const controller = new AbortController();
    let requestTimeout: number | undefined;
    const debounce = window.setTimeout(() => {
      setHerbFunctionLookupStatus((current) => ({
        ...current,
        ...Object.fromEntries(pendingNames.map((name) => [name, "loading" as const])),
      }));
      requestTimeout = window.setTimeout(() => controller.abort(), HERB_FUNCTION_LOOKUP_TIMEOUT_MS);

      void Promise.all(pendingNames.map(async (name) => {
        if (herbFunctionCacheRef.current.has(name)) {
          const functionText = herbFunctionCacheRef.current.get(name) || "";
          return { name, functionText, status: functionText ? "found" as const : "not_found" as const };
        }
        try {
          const functionText = await fetchTcmHerbFunction(name, controller.signal);
          herbFunctionCacheRef.current.set(name, functionText);
          return { name, functionText, status: functionText ? "found" as const : "not_found" as const };
        } catch {
          return { name, functionText: "", status: "error" as const };
        }
      })).then((results) => {
        if (controller.signal.aborted) return;
        const byName = new Map(results.map((result) => [result.name, result.functionText]));
        setHerbFunctionLookupStatus((current) => ({
          ...current,
          ...Object.fromEntries(results.map((result) => [result.name, result.status])),
        }));
        setHerbs((current) => {
          let changed = false;
          const next = current.map((herb) => {
            const name = herb.name.trim();
            const functionText = byName.get(name) || "";
            if (herb.function.trim() || !functionText) return herb;
            changed = true;
            return {
              ...herb,
              function: functionText,
              prescriptionRole: herb.targetPathogenesis
                ? `对应${herb.targetPathogenesis}`
                : "",
            };
          });
          return changed ? next : current;
        });
        if (results.some((result) => result.status === "found")) {
          setAuditStatus("dirty");
          setAuditMessage("药味功效已从服务端知识库补全，请重新获取审方提示后再标记为编辑后候选方案。");
          setFinalReady(false);
          setAcceptedRevision(null);
        }
      }).finally(() => {
        if (requestTimeout !== undefined) window.clearTimeout(requestTimeout);
      });
    }, HERB_FUNCTION_LOOKUP_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(debounce);
      if (requestTimeout !== undefined) window.clearTimeout(requestTimeout);
      controller.abort();
    };
  }, [missingHerbFunctionNamesKey]);

  const currentSignature = useMemo(() => herbEditSignature(herbs), [herbs]);
  const currentSignatureRef = useRef(currentSignature);
  useEffect(() => {
    currentSignatureRef.current = currentSignature;
  }, [currentSignature]);
  const changed = currentSignature !== initialSignature;
  // 上报未采纳草稿脏状态（只上报标记，不上报草稿本体）：父级把它随加密工作区快照持久化，
  // 刷新后即使草稿本体丢失，也能提示“上次有未保存编辑”，避免界面静默恢复为已采纳版本造成分叉。
  // 注意：本次挂载从未变脏时不上报清除，否则会抹掉刚从快照恢复的脏标记，提示会在挂载瞬间闪没。
  const reportedDirtyRef = useRef(false);
  useEffect(() => {
    if (!onUnsavedDraftChange) return;
    const dirty = changed && !finalReady;
    if (dirty) reportedDirtyRef.current = true;
    if (!dirty && !reportedDirtyRef.current) return;
    onUnsavedDraftChange(
      dirty
        ? { caseId: caseState.id, candidateIndex, unsavedAt: new Date().toISOString() }
        : null,
    );
  }, [changed, finalReady, candidateIndex, caseState.id, onUnsavedDraftChange]);
  const originalHerbCount = initialHerbs.filter((herb) => herb.name.trim()).length;
  const currentHerbCount = herbs.filter((herb) => herb.name.trim()).length;
  const hasInvalidHerb = herbs.some(hasIncompleteEditedHerb);
  const herbNames = herbs.map((herb) => herb.name.trim()).filter(Boolean);
  const editSemanticIssue = new Set(herbNames).size !== herbNames.length ? "duplicate_herb" : undefined;
  const canAudit = changed && !hasInvalidHerb && !editSemanticIssue && auditStatus !== "checking" && Boolean(activeReasoning?.formula);
  const canMarkFinal = (auditStatus === "reviewed" || auditStatus === "warning") &&
    changed &&
    acceptedRevision !== null;
  const controlsLocked = auditStatus === "checking";
  const activeHerbNames = herbs.map((herb) => herb.name.trim()).filter(Boolean);
  const herbFunctionLookupInProgress = activeHerbNames.some((name) => herbFunctionLookupStatus[name] === "loading");
  const herbFunctionLookupProblemNames = Array.from(new Set(activeHerbNames.filter((name) =>
    herbFunctionLookupStatus[name] === "not_found" || herbFunctionLookupStatus[name] === "error"
  )));
  const restoredUnsavedNotice =
    restoredUnsavedDraft &&
    restoredUnsavedDraft.caseId === caseState.id &&
    restoredUnsavedDraft.candidateIndex === candidateIndex &&
    !changed
      ? restoredUnsavedDraft
      : null;
  const auditTone =
    auditStatus === "reviewed" ? "border-emerald-200 bg-emerald-50 text-emerald-800" :
    auditStatus === "warning" ? "border-amber-200 bg-amber-50 text-amber-900" :
    auditStatus === "error" ? "border-red-200 bg-red-50 text-red-800" :
    auditStatus === "dirty" ? "border-amber-200 bg-amber-50 text-amber-900" :
    "border-gray-200 bg-gray-50 text-gray-700";
  const markDirty = (nextHerbs: StructuredHerb[]) => {
    setHerbs(nextHerbs);
    setAuditStatus("dirty");
    setAuditMessage("药味已调整，请重新获取审方提示后再标记为编辑后候选方案。");
    setFinalReady(false);
    setAcceptedRevision(null);
  };

  const updateHerb = (index: number, patch: Partial<StructuredHerb>) => {
    markDirty(herbs.map((herb, herbIndex) => herbIndex === index ? { ...herb, ...patch } : herb));
  };

  const updateHerbRole = (index: number, role: StructuredHerb["role"]) => {
    const herb = herbs[index];
    if (herb?.targetKind === "formula_structure" && role !== "佐" && role !== "使") {
      const fallback = pathogenesisOptions[0];
      updateHerb(index, {
        role,
        targetKind: "pathogenesis_node",
        targetRef: fallback?.id || "",
        structureRole: null,
        targetPathogenesis: fallback?.text || "待选择对应病机",
      });
      return;
    }
    updateHerb(index, { role });
  };

  const updateHerbTarget = (index: number, value: string) => {
    if (value.startsWith("node:")) {
      const node = pathogenesisOptions.find((item) => item.id === value.slice(5));
      if (!node) return;
      updateHerb(index, {
        targetKind: "pathogenesis_node", targetRef: node.id, structureRole: null, targetPathogenesis: node.text,
        prescriptionRole: `对应${node.text}`,
      });
      return;
    }
    if (value.startsWith("structure:")) {
      const structureRole = value.slice(10) as FormulaStructureRole;
      const target = FORMULA_STRUCTURE_TARGETS[structureRole];
      if (!target) return;
      updateHerb(index, {
        targetKind: "formula_structure", targetRef: "FORMULA_STRUCTURE", structureRole, targetPathogenesis: target,
        prescriptionRole: `对应${target}`,
      });
    }
  };

  const removeHerb = (index: number) => {
    markDirty(herbs.filter((_, herbIndex) => herbIndex !== index));
  };

  const addHerb = () => {
    markDirty([...herbs, createBlankHerb(pathogenesisOptions[0])]);
  };

  const runEditedAudit = async () => {
    if (!activeReasoning?.formula || !canAudit) return;
    const submittedSignature = currentSignature;
    const submittedHerbs = herbs.map(cloneStructuredHerb);
    setAuditStatus("checking");
    setAuditMessage("正在审查编辑后的药味与剂量，结果将作为风险提示供医生复核。");
    setFinalReady(false);
    const revisedReasoning = buildReasoningWithEditedHerbs(activeReasoning, candidateIndex, submittedHerbs);
    const submittedAuditState = { ...caseState, reasoningPrescribe: revisedReasoning, reasoningV2: revisedReasoning };
    const submittedVersionHash = await computePrescriptionVersionHash(revisedReasoning, candidateIndex, submittedAuditState).catch(() => "");
    if (!submittedVersionHash) {
      setAuditStatus("error");
      setAuditMessage("无法生成编辑后处方版本摘要，本次未提交审方，请重试。");
      return;
    }
    try {
      const { response: res, body } = await fetchJsonWithTimeout<{
        section?: unknown;
        followup?: unknown;
        audit?: {
          safetyLocked?: unknown;
          needManualReview?: unknown;
          auditResult?: unknown;
          highestRiskLevel?: unknown;
          source?: unknown;
          reason?: unknown;
          degraded?: unknown;
          degradeReason?: unknown;
          auditId?: unknown;
          traceId?: unknown;
          herbHash?: unknown;
          auditedAt?: unknown;
        };
      }>(apiUrl("/api/diagnosis/post-prescription-risk"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          caseState: {
            ...caseState,
            reasoningPrescribe: revisedReasoning,
            reasoningV2: revisedReasoning,
            prescriptionRevision: {
              source: "herb_workbench",
              candidateIndex,
              herbHash: submittedVersionHash,
              auditedAt: new Date().toISOString(),
              auditResult: "MANUAL_REVIEW",
              highestRiskLevel: "HIGH",
              auditAvailable: false,
            },
            // 清除旧版本可能残留的审方锁；当前版本只由独立病例安全门控决定是否阻断。
            safetyLocked: false,
          },
        }),
      });
      if (currentSignatureRef.current !== submittedSignature) return;
      if (res.status === 422 || body?.audit?.source === "local_input_validation") {
        setAcceptedRevision(null);
        setAuditStatus("error");
        setAuditMessage("药味名称、剂量、对应病机或功用不完整，请修正后重新获取审方提示。");
        return;
      }
      if (body?.audit?.herbHash !== submittedVersionHash) {
        setAcceptedRevision(null);
        setAuditStatus("error");
        setAuditMessage("审方响应与当前处方版本摘要不一致，系统已拒绝写回，请重新审方。");
        return;
      }
      const section = typeof body?.section === "string" && body.section.trim()
        ? body.section
        : "## 合理用药审方\n**审方服务状态**：本次未获得可解析的审方结果。\n**处置建议**：请医生或药师人工复核；该提示不阻断候选方案流程。";
      const followupSection = typeof body?.followup === "string" && body.followup.trim()
        ? body.followup.trim()
        : buildDeterministicRiskFollowup(withSafetyGate({ ...caseState, reasoningV2: revisedReasoning, reasoningPrescribe: revisedReasoning, riskAssessment: section }));
      const rawAuditResult = String(body?.audit?.auditResult || "").toUpperCase();
      const rawRiskLevel = String(body?.audit?.highestRiskLevel || "").toUpperCase();
      const auditResult: NonNullable<CaseState["prescriptionRevision"]>["auditResult"] =
        ["PASS", "REMIND", "MANUAL_REVIEW", "BLOCK"].includes(rawAuditResult)
          ? rawAuditResult as NonNullable<CaseState["prescriptionRevision"]>["auditResult"]
          : "MANUAL_REVIEW";
      const highestRiskLevel: NonNullable<CaseState["prescriptionRevision"]>["highestRiskLevel"] =
        ["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(rawRiskLevel)
          ? rawRiskLevel as NonNullable<CaseState["prescriptionRevision"]>["highestRiskLevel"]
          : "HIGH";
      const auditAvailable = res.ok && body?.audit?.source === "lingxi" && body?.audit?.degraded !== true;
      const needsAttention =
        !auditAvailable ||
        body?.audit?.needManualReview === true ||
        body?.audit?.degraded === true ||
        auditResult === "MANUAL_REVIEW" ||
        auditResult === "BLOCK" ||
        ["MEDIUM", "HIGH", "CRITICAL"].includes(highestRiskLevel) ||
        /BLOCK|MANUAL_REVIEW|强提示|高风险|确定性审方未完成|灵犀审方未完成|不能等同/.test([
          body?.audit?.auditResult,
          body?.audit?.highestRiskLevel,
          body?.audit?.reason,
          section,
        ].filter(Boolean).join("\n"));
      setAcceptedRevision({
        caseId: caseState.id,
        reasoning: revisedReasoning,
        auditSection: section,
        followupSection,
        // Lingxi audit is advisory. Only the patient-safety permission authority may lock formal
        // adoption; audit severity or availability must never be repurposed as that lock.
        serverSafetyLocked: derivePrescriptionPermission(withSafetyGate(caseState)).formalAdoption === "blocked",
        revision: {
          source: "herb_workbench",
          candidateIndex,
          herbHash: submittedVersionHash,
          auditedAt: typeof body?.audit?.auditedAt === "string" ? body.audit.auditedAt : new Date().toISOString(),
          auditResult,
          highestRiskLevel,
          auditAvailable,
          degraded: body?.audit?.degraded === true,
          degradeReason: typeof body?.audit?.degradeReason === "string" ? body.audit.degradeReason : undefined,
          needManualReview: body?.audit?.needManualReview === true,
          auditReason: typeof body?.audit?.reason === "string" ? body.audit.reason : undefined,
          auditId: typeof body?.audit?.auditId === "string" ? body.audit.auditId : undefined,
          traceId: typeof body?.audit?.traceId === "string" ? body.audit.traceId : undefined,
        },
      });
      setAuditStatus(needsAttention ? "warning" : "reviewed");
      setAuditMessage(needsAttention
        ? "审方已返回风险提示或当前服务不可用；提示不阻断流程，请医生/药师人工复核后决定是否采纳。"
        : "编辑后药味已完成审方，仍需医生结合现场情况最终复核。");
    } catch (error) {
      const reason = normalizeRequestError(error, "编辑后药味审方失败，请人工复核。");
      const section = `## 合理用药审方\n**审方服务状态**：${reason}\n**处置建议**：本次审方不可用，仅作风险提示；医生或药师人工复核后可继续处理候选方案。`;
      const followupSection = buildDeterministicRiskFollowup(withSafetyGate({ ...caseState, reasoningV2: revisedReasoning, reasoningPrescribe: revisedReasoning, riskAssessment: section }));
      setAcceptedRevision({
        caseId: caseState.id,
        reasoning: revisedReasoning,
        auditSection: section,
        followupSection,
        serverSafetyLocked: derivePrescriptionPermission(withSafetyGate(caseState)).formalAdoption === "blocked",
        revision: {
          source: "herb_workbench",
          candidateIndex,
          herbHash: submittedVersionHash,
          auditedAt: new Date().toISOString(),
          auditResult: "MANUAL_REVIEW",
          highestRiskLevel: "HIGH",
          auditAvailable: false,
          degraded: true,
          degradeReason: reason,
          needManualReview: true,
          auditReason: reason,
        },
      });
      setAuditStatus("warning");
      setAuditMessage("审方服务本次不可用；已保留人工复核提示，不阻断标记为医生候选方案。");
    }
  };

  return (
    <div data-testid="herb-modification-workbench" className="rounded-xl border bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-gray-950">
            药味加减工作台
            {changed && !finalReady && (
              <span
                data-testid="workbench-unsaved-badge"
                className="ml-2 inline-flex rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 align-middle text-[11px] font-bold text-amber-800"
              >
                未保存编辑
              </span>
            )}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-gray-500">
            原方 {originalHerbCount} 味，当前 {currentHerbCount} 味；增删改后请更新风险提示，具体问题统一在下方“合理用药审方”中查看。
          </p>
        </div>
      </div>

      {restoredUnsavedNotice && (
        <p
          data-testid="workbench-unsaved-restored-notice"
          className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800"
        >
          上次会话有未保存的药味编辑（{formatWorkbenchUnsavedAt(restoredUnsavedNotice.unsavedAt)}）；刷新后已恢复为最近已审方/采纳版本。未采纳的编辑不会进入审方、报告或 HIS。
        </p>
      )}

      {changed && !finalReady && (
        <p
          data-testid="workbench-refresh-warning"
          className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800"
        >
          {WORKBENCH_REFRESH_WARNING}
        </p>
      )}

      <div className="mt-3 overflow-x-auto rounded-lg border border-gray-100">
        <div className="grid min-w-[1080px] grid-cols-[1fr_0.8fr_0.7fr_1.2fr_1.3fr_0.8fr_1fr_64px] gap-2 border-b bg-gray-50 px-3 py-2 text-[11px] font-bold text-gray-500">
          <span>药味</span>
          <span>剂量</span>
          <span>角色</span>
          <span>病机/结构作用</span>
          <span>存在意义</span>
          <span>炮制</span>
          <span>煎服要求</span>
          <span>操作</span>
        </div>
        <div className="divide-y divide-gray-100">
          {herbs.map((herb, index) => (
            <div key={`${herb.name || "new"}-${index}`} className="grid min-w-[1080px] grid-cols-[1fr_0.8fr_0.7fr_1.2fr_1.3fr_0.8fr_1fr_64px] gap-2 px-3 py-2">
              <input
                aria-label={`药味${index + 1}`}
                value={herb.name}
                onChange={(event) => {
                  const name = event.target.value.slice(0, 40);
                  updateHerb(index, {
                    name,
                    function: "",
                    prescriptionRole: "",
                  });
                }}
                disabled={controlsLocked}
                className="rounded border border-gray-200 px-2 py-1.5 text-xs font-semibold text-gray-900 outline-none focus:border-teal-300"
                placeholder="药名"
              />
              <input
                aria-label={`剂量${index + 1}`}
                value={herb.dose || ""}
                onChange={(event) => updateHerb(index, { dose: event.target.value.slice(0, 40) })}
                disabled={controlsLocked}
                className="rounded border border-gray-200 px-2 py-1.5 text-xs text-gray-800 outline-none focus:border-teal-300"
                placeholder="如 10g"
              />
              <select
                aria-label={`角色${index + 1}`}
                value={herb.role}
                onChange={(event) => updateHerbRole(index, event.target.value as StructuredHerb["role"])}
                disabled={controlsLocked}
                className="rounded border border-gray-200 px-2 py-1.5 text-xs text-gray-800 outline-none focus:border-teal-300"
              >
                {["君", "臣", "佐", "使"].map((role) => <option key={role} value={role}>{role}</option>)}
              </select>
              <select
                aria-label={`对应病机${index + 1}`}
                value={herb.targetKind === "formula_structure" ? `structure:${herb.structureRole || ""}` : herb.targetRef ? `node:${herb.targetRef}` : ""}
                onChange={(event) => updateHerbTarget(index, event.target.value)}
                disabled={controlsLocked}
                className="rounded border border-gray-200 px-2 py-1.5 text-xs text-gray-800 outline-none focus:border-teal-300"
              >
                <option value="" disabled>选择病机或结构作用</option>
                <optgroup label="病机节点">
                  {pathogenesisOptions.map((item) => <option key={item.id} value={`node:${item.id}`}>{item.id} · {item.text}</option>)}
                </optgroup>
                <optgroup label="方内结构作用">
                  <option value="structure:middle_jiao_support" disabled={herb.role !== "佐" && herb.role !== "使"}>顾护中焦、防滋腻</option>
                  <option value="structure:harmonize" disabled={herb.role !== "佐" && herb.role !== "使"}>调和诸药、协调药性</option>
                  <option value="structure:guide" disabled={herb.role !== "佐" && herb.role !== "使"}>引经载药</option>
                  <option value="structure:temper" disabled={herb.role !== "佐" && herb.role !== "使"}>制约峻烈、缓和药性</option>
                </optgroup>
              </select>
              <input
                aria-label={`存在意义${index + 1}`}
                value={herb.prescriptionRole}
                readOnly
                disabled={controlsLocked}
                className="rounded border border-gray-200 bg-gray-50 px-2 py-1.5 text-xs text-gray-700 outline-none"
                placeholder={herbFunctionLookupStatus[herb.name.trim()] === "loading"
                  ? "正在查询规范功效"
                  : herbFunctionLookupStatus[herb.name.trim()] === "not_found" || herbFunctionLookupStatus[herb.name.trim()] === "error"
                    ? "未从知识库补全功效"
                    : "选择药味与病机后自动生成"}
                title="由当前病机引用和服务端中药知识库确定性生成"
              />
              <input
                aria-label={`炮制${index + 1}`}
                value={herb.processing || ""}
                onChange={(event) => updateHerb(index, { processing: event.target.value.slice(0, 40) || null })}
                disabled={controlsLocked}
                className="rounded border border-gray-200 px-2 py-1.5 text-xs text-gray-800 outline-none focus:border-teal-300"
                placeholder="如 炒/炙"
              />
              <input
                aria-label={`煎服要求${index + 1}`}
                value={herb.decoctionRequirement || ""}
                onChange={(event) => updateHerb(index, { decoctionRequirement: event.target.value.slice(0, 120) || undefined })}
                disabled={controlsLocked}
                className="rounded border border-gray-200 px-2 py-1.5 text-xs text-gray-800 outline-none focus:border-teal-300"
                placeholder="如 先煎/后下"
              />
              <button
                type="button"
                onClick={() => removeHerb(index)}
                disabled={controlsLocked || herbs.length <= 1}
                className="inline-flex items-center justify-center rounded border border-gray-200 bg-white text-gray-500 transition-colors hover:border-red-200 hover:bg-red-50 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-40"
                title="删除药味"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      </div>

      {herbFunctionLookupInProgress && (
        <p className="mt-2 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs leading-relaxed text-sky-800">
          正在从服务端中药知识库补全药味功效，完成后可继续审方。
        </p>
      )}
      {herbFunctionLookupProblemNames.length > 0 && (
        <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800">
          {herbFunctionLookupProblemNames.join("、")}未能从知识库获得规范功效，系统未生成替代内容；请核对药名或稍后重新输入。
        </p>
      )}

      {hasInvalidHerb && (
        <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800">
          药名、剂量、君臣佐使、对应病机和本例配伍意义需完整填写，不能保留“待填写/待确认”占位后提交审方。
        </p>
      )}
      {!hasInvalidHerb && editSemanticIssue && (
        <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800">
          存在重复药味，请合并为一行并确认总剂量。
        </p>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={addHerb}
          disabled={controlsLocked}
          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-bold text-gray-700 transition-colors hover:bg-gray-50"
        >
          <Plus className="h-3.5 w-3.5" />
          加一味
        </button>
        <button
          type="button"
          onClick={runEditedAudit}
          disabled={!canAudit}
          className="inline-flex items-center gap-1.5 rounded-lg bg-teal-600 px-3 py-2 text-xs font-bold text-white transition-colors hover:bg-teal-700 disabled:cursor-not-allowed disabled:bg-gray-300"
        >
          {auditStatus === "checking" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          更新风险提示
        </button>
        <button
          type="button"
          onClick={async () => {
            if (!acceptedRevision) return;
            setAuditStatus("checking");
            setAuditMessage("正在同步编辑后处方、审方提示与风险随访，请稍候。");
            try {
              await onAccept(acceptedRevision);
              setAuditStatus(auditRevisionNeedsAttention(acceptedRevision.revision) ? "warning" : "reviewed");
              setAuditMessage(BROWSER_CASE_PERSISTENCE_ENABLED
                ? "编辑后处方、最新风险提示和审方版本已同步写回并保存。"
                : "编辑后处方和审方提示已写回当前会话；浏览器恢复已关闭，刷新后不会保留。"
              );
              setFinalReady(true);
            } catch (error) {
              setAuditStatus("error");
              setAuditMessage(normalizeRequestError(error, "编辑后处方同步失败，当前版本未写回病例，请重试。"));
              setFinalReady(false);
            }
          }}
          disabled={!canMarkFinal}
          className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-700 transition-colors hover:bg-emerald-100 disabled:cursor-not-allowed disabled:border-gray-200 disabled:bg-gray-100 disabled:text-gray-400"
        >
          <Check className="h-3.5 w-3.5" />
          标记为编辑后候选方案
        </button>
      </div>

      <div className={`mt-3 rounded-lg border px-3 py-2 text-xs leading-relaxed ${auditTone}`}>
        {auditMessage}
        {finalReady && <p className="mt-1 font-bold">已标记为编辑后候选方案；仍需医生最终确认，不能自动写成正式医嘱。</p>}
      </div>
    </div>
  );
}

function HerbPrescriptionRows({ table }: { table?: MarkdownTable }) {
  if (!table || table.rows.length === 0) return null;

  return (
    <div className="overflow-hidden rounded-xl border bg-white">
      <div className="hidden grid-cols-[1.1fr_0.85fr_1.05fr_1.35fr_1.1fr] gap-3 border-b bg-gray-50 px-4 py-2 text-[11px] font-semibold text-gray-500 md:grid">
        <span>饮片/规格/剂量</span>
        <span>君臣佐使</span>
        <span>处方角色</span>
        <span>对应与存在意义</span>
        <span>证据与安全</span>
      </div>
      <div className="divide-y divide-gray-100">
        {table.rows.map((row, index) => {
          const drug = getTableCell(table, row, ["药名"]);
          const spec = getTableCell(table, row, ["炮制/规格", "规格"]);
          const dose = getTableCell(table, row, ["剂量"]);
          const role = getTableCell(table, row, ["君臣佐使"]);
          const position = getTableCell(table, row, ["处方角色", "药物定位"]);
          const target = getTableCell(table, row, ["对应病机/证候/症状", "对应病机", "对应证候", "对应症状"]);
          const meaning = getTableCell(table, row, ["配伍意义", "存在意义"]);
          const evidence = getTableCell(table, row, ["证据依据", "证据支持", "依据"]);
          const safety = getTableCell(table, row, ["安全提示", "风险提示"]);

          return (
            <div key={`${drug}-${index}`} className="grid gap-3 px-4 py-3 text-xs md:grid-cols-[1.1fr_0.85fr_1.05fr_1.35fr_1.1fr]">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-gray-950">{drug || `药味${index + 1}`}</p>
                <p className="mt-1 text-gray-500">{[spec, dose].filter(Boolean).join(" · ") || "剂量待医生确认"}</p>
              </div>
              <div className="min-w-0 flex-1">
                <span className="inline-flex rounded-full bg-rose-50 px-2.5 py-1 text-[11px] font-semibold text-rose-700">
                  {role || "角色待标注"}
                </span>
              </div>
              <p className="leading-relaxed text-gray-700">{position || "处方角色待补充"}</p>
              <div className="space-y-1 leading-relaxed text-gray-700">
                <p><span className="font-semibold text-gray-900">对应：</span>{target || "对应病机/证候/症状待确认"}</p>
                <p><span className="font-semibold text-gray-900">意义：</span>{meaning || "配伍意义待补证"}</p>
              </div>
              <div className="space-y-1 leading-relaxed">
                {!isCustomerEvidencePlaceholder(evidence) && (
                  <p className="text-blue-800"><span className="font-semibold">依据：</span>{evidence}</p>
                )}
                <p className="text-amber-700"><span className="font-semibold">安全：</span>{safety || "安全提示待医生结合审方规则复核"}</p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AdditionPlanCards({ section }: { section?: string }) {
  const table = findTableByHeaders(section, ["触发条件", "加减药物"]);
  if (!table || table.rows.length === 0) return null;

  return (
    <div className="rounded-xl border bg-white p-4">
      <p className="text-sm font-semibold text-gray-900">随证加减方案</p>
      <div className="mt-3 grid gap-2">
        {table.rows.map((row, index) => {
          const trigger = getTableCell(table, row, ["触发条件"]);
          const mechanism = getTableCell(table, row, ["对应子病机", "子病机"]);
          const drugs = getTableCell(table, row, ["加减药物", "药物"]);
          const dose = getTableCell(table, row, ["剂量或处理", "剂量"]);
          const reason = getTableCell(table, row, ["加减原因", "原因"]);
          return (
            <div key={`${trigger}-${index}`} className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2 text-xs leading-relaxed">
              <p className="font-semibold text-gray-900">{trigger || `加减条件${index + 1}`}</p>
              <p className="mt-1 text-gray-700">
                {mechanism && `因 ${mechanism}，`}
                {drugs && `调整 ${drugs}`}
                {dose && `（${dose}）`}
              </p>
              {reason && (
                <p className="mt-1 text-blue-800">
                  加减原因：{reason}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PrescriptionCandidateCard({
  candidate,
  fallbackEvidence,
  formulaThinking,
}: {
  candidate: PrescriptionCandidate;
  fallbackEvidence?: string;
  formulaThinking?: string;
}) {
  const rationale = meaningfulField(candidate.metadata["加减逻辑"], candidate.metadata["加减思路"], formulaThinking);
  const condition = meaningfulField(candidate.metadata["适用条件"], fallbackEvidence);
  const course = meaningfulField(candidate.metadata["疗程建议"], candidate.metadata["疗程"]);

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-rose-100 bg-rose-50/70 p-4">
        <div>
          <div className="min-w-0">
            <h3 className="mt-1 break-words text-lg font-semibold text-gray-950">{candidate.name || "候选处方"}</h3>
          </div>
        </div>
        <div className="mt-3 grid gap-2 text-xs leading-relaxed text-gray-700 md:grid-cols-2">
          {candidate.metadata["剂数"] && <p><span className="font-semibold">剂数：</span>{candidate.metadata["剂数"]}</p>}
          {course && <p><span className="font-semibold">疗程：</span>{course}</p>}
          {candidate.metadata["煎服法"] && <p className="md:col-span-2"><span className="font-semibold">煎服：</span>{candidate.metadata["煎服法"]}</p>}
        </div>
      </div>

      <FormulaReasonBand
        condition={condition}
        rationale={rationale}
        evidence={fallbackEvidence}
      />

      {candidate.herbTable ? (
        <HerbPrescriptionRows table={candidate.herbTable} />
      ) : (
        <div className="rounded-xl border bg-white p-4">
          <p className="mb-2 text-sm font-semibold text-gray-900">处方正文</p>
          <MarkdownBlock content={compactMarkdown(candidate.body, 1600)} compact />
        </div>
      )}
    </div>
  );
}

function PrescriptionCandidateTabs({ summary }: { summary: DecisionSummary }) {
  const candidates = parsePrescriptionCandidates(summary.prescriptionPlanSection);
  const [activeIndex, setActiveIndex] = useState(0);
  const activeCandidate = candidates[Math.min(activeIndex, Math.max(candidates.length - 1, 0))];

  if (candidates.length === 0 || !activeCandidate) {
    const fallback = [
      summary.prescriptionPlanSection && `### 处方明细\n${summary.prescriptionPlanSection}`,
      summary.herbMatrixSection && `### 药味角色标注\n${summary.herbMatrixSection}`,
    ].filter(Boolean).join("\n\n");
    return fallback ? <MarkdownBlock content={compactMarkdown(fallback, 2400)} compact /> : null;
  }

  return (
    <div className="space-y-4">
      {candidates.length > 1 && (
        <div className="flex flex-wrap gap-2 rounded-xl border bg-gray-50 p-1" role="group" aria-label="候选处方选择">
          {candidates.map((candidate, index) => {
            const active = index === activeIndex;
            return (
              <button
                key={`${candidate.label}-${index}`}
                type="button"
                aria-pressed={active}
                onClick={() => setActiveIndex(index)}
                className={`min-h-10 flex-1 rounded-lg px-3 py-2 text-left text-xs transition-colors ${
                  active ? "bg-white font-semibold text-gray-950 shadow-sm ring-1 ring-gray-200" : "text-gray-600 hover:bg-white/70"
                }`}
              >
                <span className="block">{candidate.label}</span>
                <span className="mt-0.5 block truncate font-normal text-gray-500">{candidate.name}</span>
              </button>
            );
          })}
        </div>
      )}

      <PrescriptionCandidateCard
        candidate={activeCandidate}
        fallbackEvidence={summary.formulaEvidence}
        formulaThinking={summary.formulaThinkingSection}
      />

      <AdditionPlanCards section={summary.additionSection} />
    </div>
  );
}

function MedicinePlanCards({ section, nonDrugSection }: { section?: string; nonDrugSection?: string }) {
  const table =
    findTableByHeaders(section, ["药品/方案", "用法用量边界"]) ||
    findTableByAnyHeaders(section, ["药品/方案", "药品类型", "用药定位", "联用/替代关系"]);
  if (!table || table.rows.length === 0) {
    return null;
  }

  const rows = table.rows.filter((row) => {
    const name = cleanInlineMarkdown(getTableCell(table, row, ["药品/方案", "药品"]));
    const evidence = cleanInlineMarkdown(getTableCell(table, row, ["证据依据", "依据"]));
    if (!name || isCustomerEvidencePlaceholder(evidence)) return false;
    return !/(?:可选方向|存在意义|联用\/替代关系|证据与复核|按说明书|医生评估后|重新对应证候|暂不生成|暂无|待核验)/.test(name);
  });
  if (rows.length === 0) return null;

  return (
    <div className="space-y-4">
      <div className="grid gap-3">
        {rows.map((row, index) => {
          const type = getTableCell(table, row, ["药品类型"]);
          const name = getTableCell(table, row, ["药品/方案", "药品"]);
          const spec = getTableCell(table, row, ["规格"]);
          const usage = getTableCell(table, row, ["用法用量边界", "用法用量"]);
          const course = getTableCell(table, row, ["疗程"]);
          const position = getTableCell(table, row, ["用药定位"]);
          const issue = getTableCell(table, row, ["对应问题"]);
          const evidence = getTableCell(table, row, ["证据依据", "依据"]);
          const relation = getTableCell(table, row, ["联用/替代关系", "联用", "替代"]);
          const risk = getTableCell(table, row, ["风险提示"]);

          return (
            <div key={`${name}-${index}`} className="rounded-xl border bg-white p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Pill className="h-4 w-4 text-blue-600" />
                    <p className="break-words text-sm font-semibold text-gray-950">{name || `药品方案${index + 1}`}</p>
                    {type && <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-semibold text-blue-700">{type}</span>}
                  </div>
                  <p className="mt-1 text-xs text-gray-500">{[spec, usage, course].filter(Boolean).join(" · ")}</p>
                </div>
                {relation && <span className="rounded-full border border-emerald-100 bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-700">{relation}</span>}
              </div>
              <div className="mt-3 grid gap-2 text-xs leading-relaxed text-gray-700 md:grid-cols-2">
                {position && <p><span className="font-semibold text-gray-900">存在意义：</span>{position}</p>}
                {issue && <p><span className="font-semibold text-gray-900">对应问题：</span>{issue}</p>}
                {!isCustomerEvidencePlaceholder(evidence) && (
                  <p className="text-blue-800"><span className="font-semibold">证据依据：</span>{evidence}</p>
                )}
                {risk && <p className="text-amber-700"><span className="font-semibold">风险提示：</span>{risk}</p>}
              </div>
            </div>
          );
        })}
      </div>
      {nonDrugSection && (
        <details className="rounded-xl border bg-white">
          <summary className="cursor-pointer list-none px-4 py-3 text-sm font-semibold text-gray-800">非药物干预</summary>
          <div className="border-t px-4 py-3">
            <MarkdownBlock content={compactMarkdown(nonDrugSection, 1000)} compact />
          </div>
        </details>
      )}
    </div>
  );
}

function isCompleteStructuredMedicineCandidate(
  item: NonNullable<StructuredFormula["patentAndWestern"]>[number],
): boolean {
  const fields = [item.name, item.specification, item.singleDose, item.frequency, item.route, item.course];
  return fields.every((value) =>
    typeof value === "string" &&
    value.trim().length > 0 &&
    !/(?:按说明书|医生复核|医生评估|待确认|待核验|待检索|结合病情|另行确定)/.test(value)
  ) && shouldRenderEvidenceStatus(item.evidence);
}

function StructuredMedicinePlanCards({ candidates }: {
  candidates: NonNullable<StructuredFormula["patentAndWestern"]>;
}) {
  const visible = candidates.filter(isCompleteStructuredMedicineCandidate);
  if (visible.length === 0) return null;
  return (
    <div className="grid gap-3">
      {visible.map((item, index) => (
        <div key={`${item.type}-${item.name}-${index}`} className="rounded-xl border bg-white p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Pill className="h-4 w-4 text-blue-600" />
                <p className="break-words text-sm font-semibold text-gray-950">{item.name}</p>
                <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-semibold text-blue-700">{item.type}</span>
              </div>
              <p className="mt-1 text-xs text-gray-500">{item.specification}</p>
            </div>
            <span className="rounded-full border border-emerald-100 bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-700">{item.positioning}</span>
          </div>
          <div className="mt-3 grid gap-2 md:grid-cols-2">
            <SummaryLine label="用法" value={`${item.route}，${item.singleDose}，${item.frequency}；${item.course}`} tone="blue" />
            <SummaryLine label="对应问题" value={item.correspondingProblem} tone="green" />
            <SummaryLine label="联用/替代关系" value={item.relationship} tone="gray" />
            <SummaryLine label="风险提示" value={item.riskNote} tone="amber" />
          </div>
          <div className="mt-3 border-t border-blue-100 pt-2 text-xs leading-relaxed text-blue-800">
            <p className="font-semibold">参考文献</p>
            <EvidenceReferenceList source={item.evidence.source} relevance="支持该药品的适应证、用法边界或风险提示" />
          </div>
        </div>
      ))}
    </div>
  );
}

function AuditReviewSection({ caseState, content }: { caseState: CaseState; content?: string }) {
  if (!content?.trim() && caseState.auditAdvisory == null) return null;
  const unavailable = caseState.auditAdvisory?.available === false;
  const hasIssues = hasMeaningfulMedicationRisk(content) || /\|\s*(?:强提示|一般提示|信息不足提示)\s*\|/.test(content || "");
  const pass = caseState.auditAdvisory?.available === true && !hasIssues;
  const title = unavailable
    ? "合理用药审方 · 本次未完成"
    : hasIssues
      ? "合理用药审方 · 发现风险提示"
      : "Lingxi 建议性复核 · 未见明确风险提示";
  const subtitle = unavailable
    ? "当前结果不能视为已完成审方"
    : hasIssues
      ? "按审方问题 ID 逐条复核"
      : "结果仅供参考，最终由医生或药师决定";
  const toneClass = unavailable
    ? "border-amber-200 bg-amber-50/60 text-amber-900"
    : hasIssues
      ? "border-red-200 bg-red-50/60 text-red-900"
      : "border-emerald-200 bg-emerald-50/60 text-emerald-900";
  return (
    <details id="cdss-section-risk-review" open={unavailable || hasIssues} className={`group scroll-mt-3 rounded-xl border ${toneClass}`}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3.5 py-3">
        <div className="min-w-0">
          <p className="text-[13px] font-bold">{title}</p>
          <p className="mt-0.5 truncate text-[11px] opacity-70">{subtitle}</p>
        </div>
        <ChevronDown className="h-4 w-4 shrink-0 opacity-60 transition-transform group-open:rotate-180" />
      </summary>
      <div className="border-t border-current/10 bg-white px-3.5 py-3 text-gray-800">
        {content?.trim() ? (
          <MarkdownBlock content={compactMarkdown(content, 3600)} compact />
        ) : (
          <p className={`text-xs leading-relaxed ${pass ? "text-emerald-700" : "text-amber-800"}`}>
            {pass ? "本次自动审方未返回明确风险问题。" : "自动审方本次未完成，请由医生或药师复核。"}
          </p>
        )}
      </div>
    </details>
  );
}

function PrescriptionPlanTabs({ summary }: { summary: DecisionSummary }) {
  const [activeTab, setActiveTab] = useState<"herbal" | "medicine">("herbal");

  const tabs: Array<{ id: "herbal" | "medicine"; label: string; desc: string }> = [
    { id: "herbal", label: "中药饮片处方", desc: "候选处方、剂量、角色、证据" },
    { id: "medicine", label: "西药/中成药", desc: "联用、替代或对症方案" },
  ];

  return (
    <Disclosure title="处方建议" subtitle="审阅中药饮片与西药/中成药方案" defaultOpen>
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2 rounded-xl border bg-gray-50 p-1" role="tablist" aria-label="处方方案类型">
          {tabs.map((tab) => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                id={`prescription-tab-${tab.id}`}
                aria-controls={`prescription-panel-${tab.id}`}
                aria-selected={isActive}
                tabIndex={isActive ? 0 : -1}
                onClick={() => setActiveTab(tab.id)}
                onKeyDown={(event) => {
                  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                  event.preventDefault();
                  const next = event.key === "Home" || event.key === "ArrowLeft" ? "herbal" : "medicine";
                  setActiveTab(next);
                  document.getElementById(`prescription-tab-${next}`)?.focus();
                }}
                className={`min-h-12 flex-1 rounded-lg px-3 py-2 text-left transition-colors ${
                  isActive ? "bg-white shadow-sm ring-1 ring-gray-200" : "hover:bg-white/70"
                }`}
              >
                <span className="block text-sm font-semibold text-gray-900">{tab.label}</span>
                <span className="mt-0.5 block text-xs text-gray-500">{tab.desc}</span>
              </button>
            );
          })}
        </div>

        {activeTab === "herbal" ? (
          <div id="prescription-panel-herbal" role="tabpanel" aria-labelledby="prescription-tab-herbal" className="space-y-4">
            <MechanismDrugMatrix section={summary.mechanismDrugMatrixSection} />
            <PrescriptionCandidateTabs summary={summary} />
          </div>
        ) : (
          <div id="prescription-panel-medicine" role="tabpanel" aria-labelledby="prescription-tab-medicine" className="space-y-4">
            <EvidenceCallout evidence={summary.westernPatentEvidence} reference={summary.westernPatentReference} />
            <MedicinePlanCards section={summary.westernPatentMedicineSection} nonDrugSection={summary.nonDrugSection} />
          </div>
        )}
      </div>
    </Disclosure>
  );
}

function FollowupDetail({
  label,
  value,
  tone = "gray",
}: {
  label: string;
  value?: string;
  tone?: "gray" | "amber" | "blue";
}) {
  if (!isDisplayableClinicalText(value)) return null;
  const toneClass =
    tone === "amber" ? "bg-amber-50 text-amber-800" :
    tone === "blue" ? "bg-blue-50 text-blue-800" :
    "bg-gray-50 text-gray-700";
  return (
    <div className={`rounded-lg px-3 py-2 ${toneClass}`}>
      <p className="text-[11px] font-semibold opacity-70">{label}</p>
      <p className="mt-1 text-xs leading-relaxed">{value}</p>
    </div>
  );
}

function FollowupTimeline({ summary, reasoning }: { summary: DecisionSummary; reasoning?: ClinicalReasoningResultV2 }) {
  const firstReviewTime =
    extractField(summary.followupSection, ["首次复诊时间"]) ||
    extractFirstMatch(summary.followupSection, [/首次复诊时间[：:]\s*([^，。\n]+)/]);
  const reviewFocus = extractField(summary.followupSection, ["复诊评估重点"]);
  const efficacy = extractField(summary.followupSection, ["疗效评价标准"]);
  const safety = extractField(summary.followupSection, ["安全性观察"]);
  const contingency = extractField(summary.followupSection, ["无效或加重的处置预案"]);
  const referral = firstMeaningfulLine(summary.referralSection);
  const risk = extractField(summary.riskSummarySection, ["医生需确认事项", "综合风险判断", "评级依据"]);
  const rehab = firstMeaningfulLine(summary.rehabSection);
  const parsedItems = parseFollowupTimelineItems(summary.followupTimelineSection);
  const hasDosePrescription = hasGeneratedDosePrescription(summary, reasoning);

  const prePrescriptionItems: FollowupTimelineItem[] = [
    {
      time: "当前",
      action: "按现有信息完成评估",
      indicators: risk || "主诉、舌脉、核心症状变化，以及已提示但不完整的过敏/用药/特殊人群或生命体征异常信息。",
      trigger: referral || "未知项保留为复核提示；出现明确急危重信号时优先现场处置。",
    },
    {
      time: "取得新增信息后",
      action: "更新辅助推理",
      indicators: "复核证候、病机、候选方药和风险提示是否需要调整。",
      trigger: "医生取得新的问诊、查体或检查结果时，可直接补录并重新评估。",
    },
  ];

  const fallbackItems: FollowupTimelineItem[] = [
    {
      time: "开方前",
      action: "安全复核",
      indicators: risk || "核对生命体征、肝肾功能、特殊人群信息，以及已知过敏/已知用药或候选药物明确相关的安全风险。",
      trigger: referral || "若存在红旗、禁忌、妊娠哺乳或严重肝肾异常，先完善评估或转诊。",
    },
    {
      time: "服药第1-3天",
      action: "安全观察",
      indicators: safety || summary.redFlagPatientSection || "观察胃肠反应、过敏、头晕加重、胸闷心悸等安全信号。",
      trigger: "出现明显不良反应、红旗症状或原症加重时，停药联系医生或急诊评估。",
    },
    {
      time: firstReviewTime || "首次复诊",
      action: "疗效与证候复核",
      indicators: [reviewFocus, efficacy].filter(Boolean).join("；") || "复核主症、睡眠/饮食/二便、舌脉变化，并判断是否加减方。",
      trigger: "疗效不足或证候转化时，重新辨证并调整方药或安排检查。",
    },
    {
      time: "无效或加重",
      action: "调整或转诊",
      indicators: "主症无改善、症状加重、检查异常或出现红旗信号。",
      trigger: contingency || referral || "症状无改善、出现红旗信号或检查异常时，重新辨证并考虑转诊。",
    },
    {
      time: "疗程结束",
      action: "续方/停方决策",
      indicators: rehab || "结合主要症状改善程度和安全性决定续方、减停或转换方案。",
      trigger: "达到疗效目标且安全性可接受时考虑减停；未达标则重新评估诊断与治疗方向。",
    },
  ];

  // M05 is generated in the same chain as M04 and may still contain a medication timeline when
  // the dose-level prescription is later rejected. In that state, discard the entire generated
  // medication timeline instead of trying to redact individual phrases: triggers and indicators
  // can also carry stale dose/continuation assumptions.
  const items = hasDosePrescription
    ? (parsedItems.length > 0 ? parsedItems : fallbackItems)
    : prePrescriptionItems;
  const displayItems = items.length > 0 ? items : prePrescriptionItems;

  return (
    <div className="space-y-4">
      <div className="relative space-y-4 pl-5 before:absolute before:left-2 before:top-2 before:h-[calc(100%-1rem)] before:w-px before:bg-rose-200">
        {displayItems.map((item, index) => (
          <div key={`${item.time}-${item.action}-${index}`} className="relative">
            <div className="absolute -left-[18px] top-1.5 h-3 w-3 rounded-full border-2 border-white bg-rose-500 shadow-sm" />
            <div className="rounded-xl border bg-white px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-rose-50 px-2.5 py-1 text-xs font-semibold text-rose-700">{item.time || `第${index + 1}项`}</span>
                <p className="text-sm font-semibold text-gray-900">{item.action || "随访动作待确认"}</p>
              </div>
              <div className="mt-3 grid gap-2 md:grid-cols-2">
                <FollowupDetail label="观察指标" value={item.indicators} tone="blue" />
                <FollowupDetail label="触发处置" value={item.trigger} tone="amber" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SchemeSection({
  id,
  title,
  subtitle,
  children,
  defaultOpen = true,
}: {
  id?: string;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details id={id} open={defaultOpen} className="group scroll-mt-3 rounded-xl border border-gray-200 bg-white">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3.5 py-3">
        <div className="min-w-0">
          <p className="text-[13px] font-bold text-gray-900">{title}</p>
          {subtitle && <p className="mt-0.5 truncate text-[11px] text-gray-500">{subtitle}</p>}
        </div>
        <ChevronDown className="h-4 w-4 shrink-0 text-gray-400 transition-transform group-open:rotate-180" />
      </summary>
      <div className="border-t border-gray-100 px-3.5 py-3">
        {children}
      </div>
    </details>
  );
}

function SummaryLine({ label, value, tone = "gray" }: { label: string; value?: string; tone?: "gray" | "blue" | "amber" | "green" | "red" }) {
  if (!isDisplayableClinicalText(value)) return null;
  const toneClass =
    tone === "red" ? "border-red-100 bg-red-50 text-red-900" :
    tone === "blue" ? "border-blue-100 bg-blue-50 text-blue-900" :
    tone === "amber" ? "border-amber-100 bg-amber-50 text-amber-900" :
    tone === "green" ? "border-emerald-100 bg-emerald-50 text-emerald-900" :
    "border-gray-100 bg-gray-50 text-gray-900";
  return (
    <div className={`rounded-lg border px-3 py-2 ${toneClass}`}>
      <p className="text-[11px] font-bold opacity-70">{label}</p>
      <p className="mt-1 text-[13px] font-semibold leading-relaxed">{value}</p>
    </div>
  );
}

function hasDisplayableEvidence(evidence?: { evidenceLevel?: string; source?: string; confidence?: string }): boolean {
  return customerEvidenceDisplayStatus(evidence) === "traceable";
}

function shouldRenderEvidenceStatus(evidence?: { evidenceLevel?: string; source?: string; confidence?: string }): boolean {
  return customerEvidenceDisplayStatus(evidence) === "traceable";
}

const EVIDENCE_DOI_IN_TEXT = /\b10\.\d{4,9}\/[^\s，。；、）》】"')\]]+/i;
const EVIDENCE_LITERATURE_ID_IN_TEXT = /\b(?:PMID|PMCID|CNKI|批准文号|注册证号)\s*[:：]?\s*[A-Za-z0-9._/-]+/i;
const EVIDENCE_RETRIEVED_DATE_IN_TEXT = /(?:检索日期|检索时间|检索于|检索|accessed|retrieved(?:\s+at)?)\s*[:：]?\s*((?:19|20)\d{2}(?:[-/.年](?:1[0-2]|0?[1-9])(?:[-/.月](?:3[01]|[12]\d|0?[1-9])日?)?)?)/i;

// 上游证据契约（EviMed ExternalEvidenceItem / 结构化 EvidenceRef）只携带题名、机构、年份，
// URL 与 DOI/PMID/批准文号有时随 source 字符串给出；契约没有检索时间字段，也没有决策绑定字段。
// 展示层因此只呈现载荷中字面存在的信息：URL 缺失就明示“来源未提供链接”，检索时间缺失就不展示，
// 绝不在渲染时用当前日期或其他值伪造。
export function enrichEvidenceReferenceForDisplay(reference: EvidenceDisplayReference): {
  doi?: string;
  literatureId?: string;
  retrievedAt?: string;
} {
  const doiCandidate = reference.raw.match(EVIDENCE_DOI_IN_TEXT)?.[0]?.replace(/[.,;，；。、]+$/, "");
  const doi = doiCandidate && /^10\.\d{4,9}\/\S+$/i.test(doiCandidate) ? doiCandidate : undefined;
  const literatureId = doi ? undefined : reference.raw.match(EVIDENCE_LITERATURE_ID_IN_TEXT)?.[0];
  const retrievedAt = reference.retrievedAt || reference.raw.match(EVIDENCE_RETRIEVED_DATE_IN_TEXT)?.[1];
  return {
    ...(doi ? { doi } : {}),
    ...(literatureId ? { literatureId } : {}),
    ...(retrievedAt ? { retrievedAt } : {}),
  };
}

function EvidenceReferenceList({ source, relevance }: { source?: string; relevance: string }) {
  const references = parseEvidenceDisplayReferences(source, relevance)
    .filter((reference) => !isCustomerEvidencePlaceholder(reference.raw));
  if (references.length === 0) return null;
  return (
    <div className="mt-1">
      <ol className="list-decimal space-y-2 pl-4">
        {references.map((reference) => {
          const display = enrichEvidenceReferenceForDisplay(reference);
          return (
            <li key={reference.raw}>
              {reference.url ? (
                <a className="font-semibold underline decoration-blue-300 underline-offset-2 hover:text-blue-950" href={reference.url} target="_blank" rel="noopener noreferrer">
                  {reference.title}
                </a>
              ) : (
                <span className="font-semibold">
                  {reference.title}
                  <span className="ml-1 font-normal opacity-75">（来源未提供链接）</span>
                </span>
              )}
              <span className="mt-0.5 block text-[10px] font-normal opacity-75">
                来源类型：{reference.sourceType}
                {reference.publicationDate ? ` · 发布/修订：${reference.publicationDate}` : ""}
                {display.doi ? ` · DOI：${display.doi}` : ""}
                {!display.doi && display.literatureId ? ` · 文献ID：${display.literatureId}` : ""}
                {display.retrievedAt ? ` · 检索时间：${display.retrievedAt}` : ""}
                {` · 对应决策：${reference.relevance}`}
              </span>
            </li>
          );
        })}
      </ol>
      <p className="mt-1.5 text-[10px] opacity-70">以上证据仅供参考，不替代医生对本例患者的独立判断。</p>
    </div>
  );
}

function EvidenceDetail({ evidence, relevance = "支持当前结论" }: { evidence?: { evidenceLevel?: string; source?: string; confidence?: string }; relevance?: string }) {
  if (!hasDisplayableEvidence(evidence)) return null;
  const safeEvidence = evidence as { evidenceLevel: string; source: string; confidence?: string };
  return (
    <EvidenceReferenceList source={safeEvidence.source} relevance={relevance} />
  );
}

function evidenceReferenceItems(source: string | undefined): string[] {
  return splitEvidenceReferenceItems(source).filter((item) => !isCustomerEvidencePlaceholder(item));
}

function ResultTabsV2({
  caseState,
  summary,
  onRetry,
  onAcceptEditedPrescription,
  onConfirmEncounterScope,
  restoredUnsavedDraft,
  onUnsavedDraftChange,
}: {
  caseState: CaseState;
  summary: DecisionSummary;
  onRetry?: () => void;
  onAcceptEditedPrescription: (accepted: AcceptedEditedPrescription) => Promise<void>;
  onConfirmEncounterScope: () => Promise<void>;
  restoredUnsavedDraft?: WorkbenchUnsavedDraftFlag | null;
  onUnsavedDraftChange?: (flag: WorkbenchUnsavedDraftFlag | null) => void;
}) {
  const reasoning = mergeReasoningStages(diagnoseReasoningFromState(caseState), prescribeReasoningFromState(caseState)) || caseState.reasoningV2;
  if (!reasoning) return null;

  const formula = reasoning.formula;
  const firstCandidate = formula?.candidates?.[0];
  const hasExplicitNonDoseResult = hasExplicitNonDosePrescriptionResult(caseState, Boolean(firstCandidate));
  // The server remains the enforcement point (attestation + fingerprint); this only mirrors the
  // visible state so the doctor gets an explicit confirmation action instead of a dead end.
  const unclearScopeAwaitingConfirmation = hasExplicitNonDoseResult &&
    caseState.clinicalFacts?.encounterScope?.status === "unclear" &&
    Boolean(caseState.clinicalFacts.sourceFingerprint) &&
    caseState.encounterScopeConfirmation?.sourceFingerprint !== caseState.clinicalFacts.sourceFingerprint;
  const medicineCandidates = formula?.patentAndWestern?.filter(isCompleteStructuredMedicineCandidate) || [];
  const hasMedicineCandidates = medicineCandidates.length > 0;
  // When the chain stopped at prescribe/assess, the failed stage keeps its own section with the
  // actual failure reason and an in-panel retry; downstream sections must not pretend to have run.
  const failedStage = caseState.phase === "error" && caseState.lastError ? caseState.lastError.phase : undefined;
  const prescribeStageFailed = failedStage === "prescribe";
  const assessStageFailed = failedStage === "assess";
  const seasonalCare = buildSeasonalCare([
    reasoning.overview.primarySyndrome,
    ...(reasoning.overview.secondarySyndromes || []),
    reasoning.overview.overallPathogenesis,
  ].filter(Boolean).join("；"), new Date());
  const retrievedEvidence = [...new Set([
    ...evidenceReferenceItems(reasoning.westernDiagnosis.primary.evidence?.source),
    ...evidenceReferenceItems(firstCandidate?.formulaSource?.source),
    ...medicineCandidates.flatMap((item) => evidenceReferenceItems(item.evidence?.source)),
  ].filter(Boolean))];
  const generationBasis = [
    { label: "病例资料", value: "医生本次录入的主诉、病史、四诊、检查及已完成的追问回答。" },
    { label: "临床推理", value: "模型在已知资料边界内完成西医鉴别、中医辨病辨证、病机与治法推理；未知信息保留为不确定项。" },
    ...(firstCandidate ? [{ label: "中医药知识", value: "候选方剂身份、出处、药味、剂量边界、配伍及特殊煎法由本地结构化知识校验。" }] : []),
    ...(retrievedEvidence.length > 0 ? [{ label: "已命中资料", value: retrievedEvidence.join("；") }] : []),
    { label: "安全校验", value: "红旗、特殊人群、剂量与结构完整性由确定性规则复核；风险提示不代替医生判断。" },
    ...(caseState.auditAdvisory?.available === true ? [{ label: "合理用药审方", value: "本候选处方已调用合理用药审方，具体问题与结论见审方板块。" }] : []),
  ];

  return (
    <div id="cdss-section-ai" data-testid="ai-report-v2" className="space-y-3 scroll-mt-3">
      <SchemeSection id="cdss-section-diagnosis" title="诊断结论" subtitle="西医诊断倾向与中医诊断">
        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-lg border border-blue-100 bg-blue-50 p-3 text-xs leading-relaxed text-blue-950">
            <p className="font-bold text-blue-800">西医诊断倾向</p>
            <p className="mt-1 text-sm font-semibold">{reasoning.westernDiagnosis.primary.name}</p>
            {reasoning.westernDiagnosis.primary.supportingFacts.length > 0 && <p className="mt-2">依据：{reasoning.westernDiagnosis.primary.supportingFacts.join("；")}</p>}
            {reasoning.westernDiagnosis.primary.limitations.length > 0 && <p className="mt-1 text-blue-800">限制：{reasoning.westernDiagnosis.primary.limitations.join("；")}</p>}
            {reasoning.westernDiagnosis.primary.suggestedChecks.length > 0 && <p className="mt-1">建议检查：{reasoning.westernDiagnosis.primary.suggestedChecks.join("；")}</p>}
            {shouldRenderEvidenceStatus(reasoning.westernDiagnosis.primary.evidence) && (
              <div className="mt-3 border-t border-blue-100 pt-2 text-blue-800">
                <p className="font-semibold">参考文献</p>
                <EvidenceReferenceList source={reasoning.westernDiagnosis.primary.evidence.source} relevance="支持当前西医诊断倾向或鉴别边界" />
              </div>
            )}
            {reasoning.westernDiagnosis.differentials.length > 0 && (
              <div className="mt-3 border-t border-blue-100 pt-2">
                <p className="font-semibold text-blue-800">鉴别方向</p>
                <div className="mt-1 space-y-1.5">
                  {reasoning.westernDiagnosis.differentials.map((item, index) => (
                    <p key={`${item.name}-${index}`}>
                      <span className="font-semibold">{item.name}：</span>{item.reason}
                      {item.nextCheck ? `；建议核实：${item.nextCheck}` : ""}
                    </p>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="rounded-lg border border-amber-100 bg-amber-50 p-3 text-xs leading-relaxed text-amber-950">
            <p className="font-bold text-amber-800">中医诊断</p>
            {reasoning.overview.tcmDiseaseName && (
              <p className="mt-1 text-sm font-semibold">病名：{reasoning.overview.tcmDiseaseName}</p>
            )}
            <p className={`${reasoning.overview.tcmDiseaseName ? "mt-1" : "mt-1 text-sm"} font-semibold`}>证型：{reasoning.overview.primarySyndrome}</p>
            {reasoning.overview.secondarySyndromes && reasoning.overview.secondarySyndromes.length > 0 && (
              <p className="mt-1">兼证：{reasoning.overview.secondarySyndromes.join("、")}</p>
            )}
            {reasoning.overview.primarySyndromeResolution !== "resolved" && (
              <p className="mt-2 rounded-md bg-white/70 px-2 py-1.5 text-amber-900">
                {reasoning.overview.primarySyndromeResolution === "bounded" ? "当前为有限资料下的工作判断" : "当前资料尚不足以确定稳定证型"}
                {reasoning.overview.primarySyndromeResolutionReason ? `：${reasoning.overview.primarySyndromeResolutionReason}` : "。"}
              </p>
            )}
            <p className="mt-2 text-amber-800">判断把握度：{reasoning.overview.evidence.confidence || reasoning.westernDiagnosis.primary.confidence || "中"}</p>
          </div>
        </div>
      </SchemeSection>

      {/* 顺序按临床逻辑：证候(上方总览) → 病机推理(总体病机/子病机链) → 治则治法 → 候选方药 */}
      <SchemeSection id="cdss-section-pathogenesis" title="病机分析" subtitle="总体病机、病位病性与子病机">
        {(() => {
          // 只呈现一个连贯的病机视图：模型给的结构化子字段若为空/占位("待生成/证据不足/需补充")，
          // 不再与 Markdown 兜底正文并列展示，避免"病机链证据不足 + 待生成 + 完整病机分析"这类自相矛盾。
          const p = reasoning.pathogenesis;
          const placeholder = /(暂未|证据不足|待补|待确认|待生成|不生成|无法形成|需补充关键)/;
          const overallPathogenesis = (reasoning.overview.overallPathogenesis || "").trim();
          const summaryText = (p.summary || "").trim();
          const summaryOk = !isDisplayableClinicalText(overallPathogenesis) && isDisplayableClinicalText(summaryText) && !placeholder.test(summaryText);
          const locItems = p.locationDifferentiation.items.map((item) => item.trim()).filter(isDisplayableClinicalText);
          const locDetails = (p.locationDifferentiation.details || []).filter((item) =>
            isDisplayableClinicalText(item.location) && isDisplayableClinicalText(item.basis)
          );
          const natItems = p.natureDifferentiation.items.map((item) => item.trim()).filter(isDisplayableClinicalText);
          const rootDeficiency = (p.natureDifferentiation.rootDeficiency || []).map((item) => item.trim()).filter(isDisplayableClinicalText);
          const branchExcess = (p.natureDifferentiation.branchExcess || []).map((item) => item.trim()).filter(isDisplayableClinicalText);
          const natureBasis = (p.natureDifferentiation.basis || "").trim();
          const symptomClusters = (p.symptomClusters || []).filter((item) =>
            item.symptoms.some(isDisplayableClinicalText) && isDisplayableClinicalText(item.mechanism)
          );
          const chain = p.chain.filter((step) =>
            step.patientFact?.trim() &&
            !isCustomerEvidencePlaceholder(step.patientFact) &&
            step.syndromeEvidence?.trim() &&
            !isCustomerEvidencePlaceholder(step.syndromeEvidence) &&
            step.pathogenesis?.trim() &&
            !isCustomerEvidencePlaceholder(step.pathogenesis) &&
            step.therapyDirection?.trim() &&
            !isCustomerEvidencePlaceholder(step.therapyDirection)
          );
          const caseRelationship = p.caseRelationship;
          const fallback = compactMarkdown(summary.mechanismSection || summary.patternSection || "", 1200);
          const showFallback = chain.length === 0 && !summaryOk && Boolean(fallback) && fallback !== "待生成";
          const deepReasoning = compactMarkdown([
            summary.patternSection,
            summary.mechanismSection,
            summary.subMechanismSection,
          ].filter(Boolean).join("\n\n"), 2200);
          const showDeepReasoning = /\|[^|\n]+\|/.test(deepReasoning);
          const nothing = !isDisplayableClinicalText(overallPathogenesis) && !summaryOk && locItems.length === 0 && locDetails.length === 0 && natItems.length === 0 && rootDeficiency.length === 0 && branchExcess.length === 0 && symptomClusters.length === 0 && chain.length === 0 && !showFallback;
          return (
            <div className="space-y-3">
              {(locItems.length > 0 || locDetails.length > 0 || natItems.length > 0 || rootDeficiency.length > 0 || branchExcess.length > 0) && (
                <div className="grid gap-2 md:grid-cols-2">
                  {(locItems.length > 0 || locDetails.length > 0) && (
                    <div className="rounded-lg bg-amber-50 p-3">
                      <p className="text-[11px] font-bold text-amber-700">病位辨证</p>
                      {locDetails.length > 0 ? (
                        <div className="mt-1 space-y-1.5 text-xs leading-relaxed text-amber-950">
                          {locDetails.map((item, index) => (
                            <p key={`${item.location}-${index}`}><span className="font-semibold">{item.location}：</span>{item.basis}</p>
                          ))}
                        </div>
                      ) : (
                        <p className="mt-1 text-xs leading-relaxed text-amber-950">{locItems.join("、")}</p>
                      )}
                      {shouldRenderEvidenceStatus(p.locationDifferentiation.evidence) && (
                        <p className="mt-2 border-t border-amber-100 pt-2 text-[11px] leading-relaxed text-amber-800">
                          参考文献：{evidenceReferenceItems(p.locationDifferentiation.evidence.source).join("；")}
                        </p>
                      )}
                      {p.locationDifferentiation.resolution !== "resolved" && p.locationDifferentiation.resolutionReason && (
                        <p className="mt-2 text-[11px] leading-relaxed text-amber-800">当前判断：{p.locationDifferentiation.resolutionReason}</p>
                      )}
                    </div>
                  )}
                  {(natItems.length > 0 || rootDeficiency.length > 0 || branchExcess.length > 0) && (
                    <div className="rounded-lg bg-rose-50 p-3">
                      <p className="text-[11px] font-bold text-rose-700">病性辨证</p>
                      <p className="mt-1 text-xs leading-relaxed text-rose-950">
                        {(natItems.length > 0 ? natItems : [...rootDeficiency, ...branchExcess]).join("、")}
                      </p>
                      {isDisplayableClinicalText(natureBasis) && <p className="mt-1 text-[11px] leading-relaxed text-rose-800">判断依据：{natureBasis}</p>}
                      {shouldRenderEvidenceStatus(p.natureDifferentiation.evidence) && (
                        <p className="mt-2 border-t border-rose-100 pt-2 text-[11px] leading-relaxed text-rose-800">
                          参考文献：{evidenceReferenceItems(p.natureDifferentiation.evidence.source).join("；")}
                        </p>
                      )}
                      {p.natureDifferentiation.resolution !== "resolved" && p.natureDifferentiation.resolutionReason && (
                        <p className="mt-2 text-[11px] leading-relaxed text-rose-800">当前判断：{p.natureDifferentiation.resolutionReason}</p>
                      )}
                    </div>
                  )}
                </div>
              )}
              {isDisplayableClinicalText(overallPathogenesis) && (
                <div className="rounded-lg border border-amber-100 bg-amber-50 p-3">
                  <p className="text-[11px] font-bold text-amber-700">总体病机</p>
                  <p className="mt-1 text-xs leading-relaxed text-amber-950">{overallPathogenesis}</p>
                  {summaryOk && <p className="mt-1 text-xs leading-relaxed text-amber-800">{summaryText}</p>}
                </div>
              )}
              {caseRelationship && [caseRelationship.rootPattern, caseRelationship.mainManifestation, caseRelationship.relationship].some(isDisplayableClinicalText) && (
                <div className="grid gap-2 rounded-lg border border-violet-100 bg-violet-50 p-3 text-xs leading-relaxed text-violet-950 md:grid-cols-3">
                  <div><p className="text-[11px] font-bold text-violet-700">本证</p><p className="mt-1">{caseRelationship.rootPattern}</p></div>
                  <div><p className="text-[11px] font-bold text-violet-700">主要表现</p><p className="mt-1">{caseRelationship.mainManifestation}</p></div>
                  <div><p className="text-[11px] font-bold text-violet-700">病机联系</p><p className="mt-1">{caseRelationship.relationship}</p></div>
                </div>
              )}
              {symptomClusters.length > 0 && (
                <div className="rounded-lg border border-sky-100 bg-sky-50 p-3">
                  <p className="text-[11px] font-bold text-sky-700">症状群与病机联系</p>
                  <div className="mt-2 space-y-1.5 text-xs leading-relaxed text-sky-950">
                    {symptomClusters.map((item, index) => (
                      <p key={`${item.mechanism}-${index}`}><span className="font-semibold">{item.symptoms.filter(isDisplayableClinicalText).join(" + ")}：</span>{item.mechanism}</p>
                    ))}
                  </div>
                </div>
              )}
              {chain.length > 0 && (
                <div className="space-y-2">
                  <p className="text-[11px] font-bold text-gray-500">子病机与对应治法</p>
                  {chain.map((step, index) => (
                    <div key={`${step.pathogenesis}-${index}`} className="rounded-lg border border-gray-100 bg-gray-50 p-3 text-xs leading-relaxed">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <p className="font-semibold text-gray-900">子病机 {index + 1}</p>
                        {step.pathogenesisType && <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-bold text-amber-700" title="病机在本例演变链中的位置">{step.pathogenesisType}</span>}
                      </div>
                      <div className="mt-2 grid gap-1.5 md:grid-cols-2">
                        <p className="rounded-md bg-white px-2 py-1.5 text-gray-700"><span className="font-semibold">患者事实：</span>{step.patientFact}</p>
                        <p className="rounded-md bg-white px-2 py-1.5 text-sky-800"><span className="font-semibold">证候依据：</span>{step.syndromeEvidence}</p>
                      </div>
                      <p className="mt-1 text-amber-800"><span className="font-semibold">病机演变：</span>{step.pathogenesis}</p>
                      <p className="mt-1 text-emerald-800"><span className="font-semibold">对应治法：</span>{step.therapyDirection}</p>
                    </div>
                  ))}
                </div>
              )}
              {p.uncertainties.length > 0 && (
                <details className="rounded-lg border border-gray-100 bg-white">
                  <summary className="cursor-pointer list-none px-3 py-2 text-xs font-semibold text-gray-700">影响判断的待核实信息</summary>
                  <div className="space-y-1.5 border-t border-gray-100 px-3 py-2 text-xs leading-relaxed text-gray-600">
                    {p.uncertainties.map((item, index) => (
                      <p key={`${item.item}-${index}`}><span className="font-semibold text-gray-800">{item.item}：</span>{item.reason}{item.affects ? `；可能影响${item.affects}` : ""}</p>
                    ))}
                  </div>
                </details>
              )}
              {showDeepReasoning && (
                <details className="rounded-lg border border-gray-100 bg-white">
                  <summary className="cursor-pointer list-none px-3 py-2 text-xs font-semibold text-gray-700">查看证候与病机推理明细</summary>
                  <div className="border-t border-gray-100 px-3 py-2">
                    <MarkdownBlock content={deepReasoning} compact />
                  </div>
                </details>
              )}
              {showFallback && <MarkdownBlock content={fallback} compact />}
              {nothing && null}
            </div>
          );
        })()}
      </SchemeSection>

      <SchemeSection id="cdss-section-differentiation" title="治则治法" subtitle="治则、总治法与分治方向">
        <div className="space-y-3">
          <div className="grid gap-2 md:grid-cols-2">
            <SummaryLine label="治则" value={reasoning.therapy.overallPrinciple || summary.treatmentPrinciple} tone="green" />
            <SummaryLine label="总治法" value={reasoning.therapy.overallMethod || reasoning.overview.overallTherapy} tone="blue" />
          </div>
          {reasoning.therapy.subTherapies.length > 0 && (
            <div className="grid gap-2 md:grid-cols-2">
              {reasoning.therapy.subTherapies.map((item, index) => (
                <div key={`${item.therapy}-${index}`} className="rounded-lg border bg-gray-50 p-3 text-xs leading-relaxed text-gray-700">
                  <p className="font-semibold text-gray-950">{item.priority}治法：{item.therapy}</p>
                  <p className="mt-1">对应病机：{item.targetPathogenesis}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </SchemeSection>

      {prescribeStageFailed && onRetry && (
        <SchemeSection id="cdss-section-prescription" title="候选方药" subtitle="本阶段未完成">
          <StageErrorCard caseState={caseState} onRetry={onRetry} />
        </SchemeSection>
      )}

      {firstCandidate && <SchemeSection id="cdss-section-prescription" title="候选方药" subtitle="方名、出处、药味、方义与煎服">
        <div className="space-y-3">
          {firstCandidate ? (
            <div className="space-y-3">
              <div className="rounded-xl border border-rose-100 bg-rose-50 px-3 py-2">
                <div className="min-w-0">
                  <h3 className="mt-1 text-base font-bold text-gray-950">{firstCandidate.name}</h3>
                  {firstCandidate.therapyMatch && !/^对应锁定治法[：:]/.test(firstCandidate.therapyMatch) && (
                    <p className="mt-1 text-xs leading-relaxed text-gray-600">{firstCandidate.therapyMatch}</p>
                  )}
                </div>
              </div>
              {firstCandidate.identityDeclassified && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-relaxed text-amber-900">
                  <p className="font-bold">处方身份说明</p>
                  <p className="mt-1">实际组成未沿用原命名经方身份，不代表原方或经典出处；请按当前完整药味与剂量重新审方。</p>
                </div>
              )}
              {shouldRenderEvidenceStatus(firstCandidate.formulaSource) && (
                <div className={`rounded-lg border p-3 text-xs leading-relaxed ${firstCandidate.formulaSource.evidenceLevel === "insufficient" ? "border-amber-200 bg-amber-50 text-amber-950" : "border-blue-100 bg-blue-50 text-blue-950"}`}>
                  <p className={`font-bold ${firstCandidate.formulaSource.evidenceLevel === "insufficient" ? "text-amber-800" : "text-blue-800"}`}>
                    {firstCandidate.formulaSource.evidenceLevel === "kb_entry"
                      ? "方剂资料收载来源"
                      : firstCandidate.constructionType === "self_devised" || firstCandidate.constructionType === "single_herb"
                      ? "组方依据"
                      : firstCandidate.constructionType === "combined"
                        ? "合方基础方出处"
                        : firstCandidate.modificationStatus === "modified"
                          ? "参考基础方及出处"
                          : "经典方出处"}
                  </p>
                  <EvidenceDetail evidence={firstCandidate.formulaSource} relevance="支持候选方身份、组方依据或药味来源" />
                  {firstCandidate.constructionType === "combined" && firstCandidate.baseFormulas && firstCandidate.baseFormulas.length > 1 && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {firstCandidate.baseFormulas.map((base) => (
                        <span key={`${base.name}-${base.source}`} className="rounded-full border border-blue-100 bg-white px-2.5 py-1 text-[11px] font-semibold text-blue-800">
                          {base.name}：{base.source}；匹配 {base.matchedIngredientCount}/{base.totalIngredientCount || "?"} 味
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <DecoctionInstructionsPanel decoction={firstCandidate.decoction} />
              <div className="overflow-x-auto rounded-xl border">
                <div className="min-w-[760px]">
                <div className="grid grid-cols-[0.9fr_0.65fr_0.65fr_1fr_1fr] gap-2 border-b bg-gray-50 px-3 py-2 text-[11px] font-bold text-gray-500">
                  <span>药名</span><span>剂量</span><span>角色</span><span>对应病机</span><span>本例配伍意义</span>
                </div>
                <div className="divide-y divide-gray-100">
                  {firstCandidate.herbs.map((herb, index) => (
                    <div key={`${herb.name}-${index}`} className="px-3 py-2 text-xs leading-relaxed text-gray-700">
                      <div className="grid grid-cols-[0.9fr_0.65fr_0.65fr_1fr_1fr] gap-2">
                        <span className="font-semibold text-gray-950">{herb.name}{herb.processing ? `（${herb.processing}）` : ""}</span>
                        <span>{herb.dose}</span>
                        <span>{herb.role}</span>
                        <span>{herb.targetPathogenesis}</span>
                        <span>{herb.function}</span>
                      </div>
                      {(herb.isToxic || herb.decoctionRequirement) && (
                        <div className="mt-2 rounded-lg bg-gray-50 p-2 text-[11px] text-gray-600">
                          {herb.isToxic && <p><span className="font-semibold text-gray-700">药味注意：</span>毒性/峻烈药需严守炮制剂量。</p>}
                          {herb.decoctionRequirement && <p><span className="font-semibold text-gray-700">特殊煎法：</span>{herb.decoctionRequirement}</p>}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                </div>
              </div>
              {formula?.modifications?.length ? (
                <div className="rounded-lg border bg-gray-50 p-3">
                  <p className="text-sm font-semibold text-gray-950">随症加减建议</p>
                  <p className="mt-1 text-[11px] leading-relaxed text-gray-500">仅在触发条件成立时采用；不为凑数量生成，不替代医生对舌脉、兼证和用药风险的复核。</p>
                  <div className="mt-2 space-y-2">
                    {formula.modifications.map((item, index) => (
                      <div key={`${item.trigger}-${index}`} className="rounded-lg border bg-white p-3 text-xs leading-relaxed text-gray-700">
                        <p><span className="font-semibold text-gray-950">{item.trigger}：</span>{item.action}{item.doseOrHandling ? `（${item.doseOrHandling}）` : ""}</p>
                        <p className="mt-1"><span className="font-semibold text-gray-900">对应病机：</span>{item.targetPathogenesis}；{item.reason}</p>
                        {item.riskNote && <p className="mt-1 text-amber-700"><span className="font-semibold">采用前：</span>{item.riskNote}</p>}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
              <HerbModificationWorkbench
                key={`${caseState.id}:0:${candidateHerbSignature(firstCandidate)}`}
                caseState={caseState}
                candidate={firstCandidate}
                candidateIndex={0}
                onAccept={onAcceptEditedPrescription}
                restoredUnsavedDraft={restoredUnsavedDraft}
                onUnsavedDraftChange={onUnsavedDraftChange}
              />
              <div className="rounded-lg border border-blue-100 bg-blue-50 p-3 text-xs leading-relaxed text-blue-950">
                <p className="font-bold text-blue-800">方义解析</p>
                <p className="mt-1">{firstCandidate.formulaAnalysis}</p>
              </div>
            </div>
          ) : caseState.phase === "prescribe" ? null : (
            <PrescriptionPlanTabs summary={summary} />
          )}
        </div>
      </SchemeSection>}

      {hasExplicitNonDoseResult && !prescribeStageFailed && (
        <SchemeSection id="cdss-section-prescription" title="候选方药" subtitle="本轮非剂量安全结论">
          <div data-testid="non-dose-prescription-result" className="space-y-3">
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-relaxed text-amber-950">
              <p className="font-bold text-amber-800">本轮未生成剂量级候选方药</p>
              <p className="mt-1">当前资料可用于辨病辨证和调护建议，但尚不具备安全生成具体药味剂量、剂数及煎服法的条件。</p>
            </div>
            {unclearScopeAwaitingConfirmation && (
              <div className="rounded-lg border border-sky-200 bg-sky-50 p-3 text-xs leading-relaxed text-sky-950">
                <p className="font-bold text-sky-800">本次就诊目标待医生确认</p>
                <p className="mt-1">语义预检无法判断本次就诊是否存在当前活动性治疗目标，因此未生成具体剂量。如确认本次确有需要治疗的目标，可确认后重新生成候选方药；如病情有变化，请先补充病历后再重新分析。</p>
                <button
                  type="button"
                  data-testid="confirm-encounter-scope"
                  onClick={() => { void onConfirmEncounterScope(); }}
                  className="mt-2 inline-flex items-center gap-1 rounded-md border border-sky-300 bg-white px-2.5 py-1.5 text-[11px] font-bold text-sky-700 transition-colors hover:bg-sky-100"
                >
                  确认本次有治疗目标并重新生成候选方药
                </button>
              </div>
            )}
            <div className="rounded-lg border bg-white p-3">
              <MarkdownBlock
                content={compactMarkdown([
                  summary.preCheckSection,
                  summary.prescriptionPlanSection,
                  summary.westernPatentMedicineSection,
                ].filter(Boolean).join("\n\n"), 2200)}
                compact
              />
            </div>
          </div>
        </SchemeSection>
      )}

      {hasMedicineCandidates && <SchemeSection id="cdss-section-medicine" title="西药/中成药候选" subtitle="基于西医诊断与证据的独立候选方案">
        <StructuredMedicinePlanCards candidates={medicineCandidates} />
      </SchemeSection>}
      {!hasMedicineCandidates && caseState.phase !== "diagnose" && caseState.phase !== "prescribe" && (
        <SchemeSection id="cdss-section-medicine" title="西药/中成药候选" subtitle="逐药证据核验结果">
          <p className="text-xs leading-relaxed text-gray-500">本次未形成具备可核验说明书或指南依据的西药/中成药候选。</p>
        </SchemeSection>
      )}

      {firstCandidate && <AuditReviewSection caseState={caseState} content={summary.medicineRiskSection} />}

      {assessStageFailed && onRetry && (
        <SchemeSection id="cdss-section-assess" title="审方随访" subtitle="本阶段未完成">
          <StageErrorCard caseState={caseState} onRetry={onRetry} />
        </SchemeSection>
      )}

      <SchemeSection id="cdss-section-generation-basis" title="本次生成依据" subtitle="仅列实际参与本次结果的资料与校验环节" defaultOpen={false}>
        <div className="space-y-2 text-xs leading-relaxed text-gray-700">
          {generationBasis.map((item) => (
            <div key={item.label} className="rounded-lg bg-gray-50 px-3 py-2">
              <span className="font-semibold text-gray-950">{item.label}：</span>{item.value}
            </div>
          ))}
        </div>
      </SchemeSection>

      <SchemeSection id="cdss-section-followup" title="健康调护与随访" subtitle="饮食起居、情志外治、复诊节奏和触发处置">
        <div className="space-y-3">
          {reasoning.nonPharma ? (
            <div className="grid gap-2">
              <SummaryLine label="饮食调养" value={reasoning.nonPharma.diet} tone="green" />
              <SummaryLine label="生活方式" value={reasoning.nonPharma.lifestyle} tone="blue" />
              <SummaryLine label="情志调护" value={reasoning.nonPharma.emotion} tone="amber" />
              {reasoning.nonPharma.acupointCare && <SummaryLine label="穴位/外治" value={reasoning.nonPharma.acupointCare} tone="blue" />}
              {reasoning.nonPharma.tcmTreatments.length > 0 && (
                <div>
                  <p className="mb-2 text-xs font-semibold text-gray-900">中医治疗项目</p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {reasoning.nonPharma.tcmTreatments.map((item, index) => (
                      <div key={`${item.projectCode}-${index}`} className="rounded-lg border border-gray-200 bg-white p-3 text-xs leading-relaxed text-gray-700">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="font-semibold text-gray-950">{item.projectName}</p>
                          <span className={`rounded px-2 py-0.5 font-medium ${item.availability === "clinic_available" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
                            {item.availability === "clinic_available" ? "本机构可开展" : "转介评估"}
                          </span>
                        </div>
                        <p className="mt-2"><span className="font-medium text-gray-900">对应病机：</span>{item.targetPathogenesis}</p>
                        <p className="mt-1"><span className="font-medium text-gray-900">评估定位：</span>{item.assessmentPositioning}</p>
                        <p className="mt-1 text-amber-800"><span className="font-medium">安全边界：</span>{item.operatorRequirement}；{item.requiredChecks.join("；")}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {seasonalCare && <SummaryLine label={`节气调护（${seasonalCare.solarTerm}）`} value={`${seasonalCare.climateFocus}：${seasonalCare.advice}`} tone="green" />}
              {reasoning.nonPharma.monitoring.length > 0 && (
                <div className="overflow-x-auto rounded-lg border border-gray-100">
                  <table className="min-w-full text-left text-xs">
                    <thead className="bg-gray-50 text-gray-500"><tr><th className="px-3 py-2">监测指标</th><th className="px-3 py-2">观察时间</th><th className="px-3 py-2">复诊触发</th></tr></thead>
                    <tbody className="divide-y divide-gray-100 text-gray-700">
                      {reasoning.nonPharma.monitoring.map((item, index) => (
                        <tr key={`${item.metric}-${index}`}><td className="px-3 py-2 font-medium text-gray-900">{item.metric}</td><td className="px-3 py-2">{item.timing}</td><td className="px-3 py-2">{item.trigger}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ) : summary.nonDrugSection ? (
            <MarkdownBlock content={compactMarkdown(summary.nonDrugSection, 1200)} compact />
          ) : null}
          {summary.rehabSection && <MarkdownBlock content={compactMarkdown(summary.rehabSection, 1400)} compact />}
          <FollowupTimeline summary={summary} reasoning={reasoning} />
        </div>
      </SchemeSection>
    </div>
  );
}

function CompactAiSchemeCardFlow({
  caseState,
  onRetry,
  onAcceptEditedPrescription,
  onConfirmEncounterScope,
  restoredUnsavedDraft,
  onUnsavedDraftChange,
}: {
  caseState: CaseState;
  onRetry: () => void;
  onAcceptEditedPrescription: (accepted: AcceptedEditedPrescription) => Promise<void>;
  onConfirmEncounterScope: () => Promise<void>;
  restoredUnsavedDraft?: WorkbenchUnsavedDraftFlag | null;
  onUnsavedDraftChange?: (flag: WorkbenchUnsavedDraftFlag | null) => void;
}) {
  const summary = useMemo(
    () => buildDecisionSummary(caseState),
    [caseState],
  );
  const activeReasoning = mergeReasoningStages(diagnoseReasoningFromState(caseState), prescribeReasoningFromState(caseState)) || caseState.reasoningV2;
  const hasDosePrescription = hasGeneratedDosePrescription(summary, activeReasoning);
  const isRedFlag = (caseState.safetyGate || evaluateSafetyGate(caseState)).status === "red_flag";

  if (isRedFlag) {
    return (
      <div id="cdss-section-ai" data-testid="ai-report-red-flag" className="space-y-3 scroll-mt-3">
        <div className="rounded-xl border border-red-200 bg-red-50 p-3">
          <p className="text-[11px] font-bold uppercase tracking-wide text-red-700">急危重风险处置提示</p>
          <h2 className="mt-1 break-words text-[15px] font-bold leading-snug text-gray-950">
            {caseState.chiefComplaint || "待采集主诉"}
          </h2>
          <p className="mt-2 text-[11px] leading-relaxed text-red-800">
            当前信息提示急危重风险，应优先完成急诊或转诊评估；本页继续提供风险依据与处置建议，不生成常规候选方药。
          </p>
        </div>
        {caseState.diagnosis && (
          <div className="rounded-xl border border-red-100 bg-white p-4">
            <p className="mb-2 text-xs font-bold text-red-800">本次风险依据与处置</p>
            <MarkdownBlock content={compactMarkdown(caseState.diagnosis, 1800)} compact />
          </div>
        )}
      </div>
    );
  }

  if (activeReasoning) {
    return <ResultTabsV2 caseState={caseState} summary={summary} onRetry={onRetry} onAcceptEditedPrescription={onAcceptEditedPrescription} onConfirmEncounterScope={onConfirmEncounterScope} restoredUnsavedDraft={restoredUnsavedDraft} onUnsavedDraftChange={onUnsavedDraftChange} />;
  }

  // A failed structured stage is already explained by StageErrorCard. Do not render the legacy
  // compatibility report underneath it, because its empty fields used to look like completed
  // "待生成" clinical conclusions after a refresh.
  if (caseState.phase === "error" && caseState.lastError) return null;

  return (
    <div id="cdss-section-ai" data-testid="ai-report" className="space-y-3 scroll-mt-3">
      <div className="grid gap-2">
        <SummaryLine label="西医诊断" value={summary.westernDiagnosis} tone="blue" />
        <SummaryLine label="中医证候" value={summary.tcmPattern} tone="amber" />
        <SummaryLine label="治法/处方方向" value={summary.formulaName || summary.treatmentPrinciple} tone="green" />
      </div>

      <SchemeSection title="证候-病机-治法" subtitle={summary.coreMechanism || "证候与病机依据"}>
        <div className="space-y-3">
          {/* 顺序按临床逻辑：证候分布 → 总体病机 → 子病机 → 治法 */}
          <MarkdownBlock
            content={compactMarkdown(
              [
                summary.patternSection && `### 证候分布\n${summary.patternSection}`,
                summary.mechanismSection && `### 总体病机\n${summary.mechanismSection}`,
                summary.subMechanismSection && `### 子病机\n${summary.subMechanismSection}`,
              ].filter(Boolean).join("\n\n"),
              1200,
            )}
            compact
          />
          <div className="grid gap-2">
            <SummaryLine label="核心病机" value={summary.coreMechanism} tone="amber" />
            <SummaryLine label="总治法" value={summary.treatmentPrinciple} tone="green" />
          </div>
          <EvidenceCallout evidence={summary.tcmEvidence} reference={summary.tcmReference} />
        </div>
      </SchemeSection>

      {hasDosePrescription && <SchemeSection id="cdss-section-prescription" title="处方建议" subtitle="中药饮片 / 西药与中成药">
        <div className="space-y-3">
          <PrescriptionPlanTabs summary={summary} />
        </div>
      </SchemeSection>}

      {summary.westernSection && <SchemeSection title="西医诊断依据" subtitle={summary.westernReference || "支持证据与限制"}>
        <div className="space-y-3">
          <EvidenceCallout evidence={summary.westernEvidence} reference={summary.westernReference} />
          <MarkdownBlock content={compactMarkdown(summary.westernSection, 1000)} compact />
        </div>
      </SchemeSection>}

      {hasDosePrescription && <AuditReviewSection caseState={caseState} content={summary.medicineRiskSection} />}

      <SchemeSection id="cdss-section-followup" title="风险随访" subtitle="复诊、监测、触发处置">
        <div className="space-y-3">
          <FollowupTimeline summary={summary} reasoning={activeReasoning} />
        </div>
      </SchemeSection>
    </div>
  );
}

// ─── Streaming text state per phase ──────────────────────────────────────────

type StreamingState = Partial<Record<Phase, string>>;

type HisRecordDraft = {
  patientName: string;
  sex: string;
  age: string;
  zhushu: string;
  xianbingshi: string;
  jiwangshi: string;
  allergyHistory: string;
  medicationHistory: string;
  vitalsT: string;
  vitalsP: string;
  vitalsR: string;
  vitalsBP: string;
  vitalsDetail: string;
  tcmFace: string;
  tcmPulse: string;
  tcmTongue: string;
  tcmDetail: string;
  tcmLineagePreference: string;
  fuzhuJiancha: string;
};

// 工作台未采纳药味编辑的最小脏标记（不含草稿本体）：只记录“哪个病例、哪个候选、何时有未保存编辑”。
// 草稿本体按产品决定不持久化；刷新后界面恢复为最近已审方/采纳版本，并用该标记提示分叉。
type WorkbenchUnsavedDraftFlag = {
  caseId: string;
  candidateIndex: number;
  unsavedAt: string;
};

type WorkspaceSnapshot = {
  schemaVersion: "tcm-cdss-workspace-v1";
  updatedAt: string;
  runningPhase?: Phase;
  caseState: CaseState;
  recordDraft: HisRecordDraft;
  input: string;
  selectedQuestionOptions: Record<string, QuestionOptionSelection>;
  workbenchDraft?: WorkbenchUnsavedDraftFlag | null;
};

const WORKSPACE_STORAGE_KEY = "tcm_cdss_workspace_v1";
const WORKSPACE_BINDING_KEY = "tcm_cdss_workspace_binding_v1";
const WORKSPACE_TTL_MS = 24 * 60 * 60 * 1000;
let workspaceSaveSequence = 0;

function workspaceSnapshotBinding(createIfMissing: boolean): string | null {
  if (typeof window === "undefined") return null;
  const existing = window.localStorage.getItem(WORKSPACE_BINDING_KEY);
  if (existing && /^[a-f0-9]{64}$/i.test(existing)) return existing.toLowerCase();
  if (!createIfMissing) return null;
  const bytes = new Uint8Array(32);
  window.crypto.getRandomValues(bytes);
  const created = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  window.localStorage.setItem(WORKSPACE_BINDING_KEY, created);
  return created;
}

function sanitizeRecordDraftForBrowserPersistence(draft: HisRecordDraft, caseState: CaseState): HisRecordDraft {
  const explicitNames = [draft.patientName, caseState.patient.name, caseState.hisRecord?.fields.patientName].filter((item): item is string => Boolean(item?.trim()));
  return {
    ...draft,
    patientName: "",
    zhushu: scrubPersistentPhiText(draft.zhushu, explicitNames),
    xianbingshi: scrubPersistentPhiText(draft.xianbingshi, explicitNames),
    jiwangshi: scrubPersistentPhiText(draft.jiwangshi, explicitNames),
    allergyHistory: scrubPersistentPhiText(draft.allergyHistory, explicitNames),
    medicationHistory: scrubPersistentPhiText(draft.medicationHistory, explicitNames),
    vitalsDetail: scrubPersistentPhiText(draft.vitalsDetail, explicitNames),
    tcmFace: scrubPersistentPhiText(draft.tcmFace, explicitNames),
    tcmPulse: scrubPersistentPhiText(draft.tcmPulse, explicitNames),
    tcmTongue: scrubPersistentPhiText(draft.tcmTongue, explicitNames),
    tcmDetail: scrubPersistentPhiText(draft.tcmDetail, explicitNames),
    fuzhuJiancha: scrubPersistentPhiText(draft.fuzhuJiancha, explicitNames),
  };
}

function sanitizeQuestionSelectionsForBrowserPersistence(
  selections: Record<string, QuestionOptionSelection>,
  explicitNames: string[],
): Record<string, QuestionOptionSelection> {
  return Object.fromEntries(Object.entries(selections).map(([key, selection]) => [key, {
    ...selection,
    answer: scrubPersistentPhiText(selection.answer, explicitNames),
    label: selection.label ? scrubPersistentPhiText(selection.label, explicitNames) : undefined,
    guidance: selection.guidance ? scrubPersistentPhiText(selection.guidance, explicitNames) : undefined,
    patch: selection.patch
      ? Object.fromEntries(Object.entries(selection.patch).map(([field, value]) => [field, scrubPersistentPhiText(String(value || ""), explicitNames)])) as Partial<HisRecordDraft>
      : undefined,
  }]));
}

async function saveWorkspaceSnapshot(snapshot: Omit<WorkspaceSnapshot, "schemaVersion" | "updatedAt">): Promise<string | null> {
  if (!BROWSER_CASE_PERSISTENCE_ENABLED) return null;
  if (typeof window === "undefined") return null;
  const updatedAt = new Date().toISOString();
  try {
    const binding = workspaceSnapshotBinding(true);
    if (!binding) return null;
    const explicitNames = [snapshot.recordDraft.patientName, snapshot.caseState.patient.name, snapshot.caseState.hisRecord?.fields.patientName].filter((item): item is string => Boolean(item?.trim()));
    const payload: WorkspaceSnapshot = {
      schemaVersion: "tcm-cdss-workspace-v1",
      updatedAt,
      runningPhase: snapshot.runningPhase,
      caseState: sanitizeCaseStateForBrowserPersistence(snapshot.caseState),
      recordDraft: sanitizeRecordDraftForBrowserPersistence(snapshot.recordDraft, snapshot.caseState),
      input: scrubPersistentPhiText(snapshot.input, explicitNames),
      selectedQuestionOptions: sanitizeQuestionSelectionsForBrowserPersistence(snapshot.selectedQuestionOptions, explicitNames),
      workbenchDraft: snapshot.workbenchDraft ?? null,
    };
    const sequence = ++workspaceSaveSequence;
    const { response, body } = await fetchJsonWithTimeout<{ ok?: boolean; envelope?: unknown }>(apiUrl("/api/diagnosis/snapshot"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "encrypt", payload, binding }),
    });
    if (!response.ok || !body?.ok || !isEncryptedSnapshotEnvelope(body.envelope) || sequence !== workspaceSaveSequence) return null;
    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(body.envelope));
    return body.envelope.updatedAt;
  } catch {
    return null;
  }
}

async function loadWorkspaceSnapshot(): Promise<WorkspaceSnapshot | null> {
  if (!BROWSER_CASE_PERSISTENCE_ENABLED) {
    clearWorkspaceSnapshot();
    clearAllSavedCases();
    return null;
  }
  if (typeof window === "undefined") return null;
  clearAllSavedCases();
  try {
    const raw = window.localStorage.getItem(WORKSPACE_STORAGE_KEY);
    if (!raw) return null;
    const envelope = JSON.parse(raw) as unknown;
    if (!isEncryptedSnapshotEnvelope(envelope)) {
      window.localStorage.removeItem(WORKSPACE_STORAGE_KEY);
      return null;
    }
    const binding = workspaceSnapshotBinding(false);
    if (!binding) {
      window.localStorage.removeItem(WORKSPACE_STORAGE_KEY);
      return null;
    }
    const { response, body } = await fetchJsonWithTimeout<{ ok?: boolean; payload?: unknown }>(apiUrl("/api/diagnosis/snapshot"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "decrypt", envelope, binding }),
    }, WORKSPACE_RESTORE_TIMEOUT_MS);
    if (!response.ok || !body?.ok || !body.payload || typeof body.payload !== "object") {
      // Preserve the only encrypted copy across transient auth/network/provider failures. Delete it
      // only when the server has positively classified the envelope/request as invalid.
      if ([400, 413, 422].includes(response.status)) window.localStorage.removeItem(WORKSPACE_STORAGE_KEY);
      return null;
    }
    const parsed = body.payload as Partial<WorkspaceSnapshot>;
    if (parsed.schemaVersion !== "tcm-cdss-workspace-v1") return null;
    const updatedAtMs = parsed.updatedAt ? Date.parse(parsed.updatedAt) : 0;
    if (!Number.isFinite(updatedAtMs) || Date.now() - updatedAtMs > WORKSPACE_TTL_MS) {
      window.localStorage.removeItem(WORKSPACE_STORAGE_KEY);
      return null;
    }
    const normalizedCaseState = normalizeCaseStateInput(parsed.caseState);
    if (!normalizedCaseState) return null;
    // Safety/completeness decisions are derived data. Recompute them with the current release so a
    // pre-fix snapshot cannot keep an obsolete ready gate and expose stale candidate prescriptions.
    const recomputedCaseState = withSafetyGateAndOperationalCompleteness(
      sanitizeCaseStateForBrowserPersistence(normalizedCaseState),
    );
    const caseState = reconcileRestoredCaseState(recomputedCaseState);
    const rawRecordDraft = { ...createEmptyHisRecordDraft(), ...(parsed.recordDraft || {}) };
    const legacyNames = [rawRecordDraft.patientName, normalizedCaseState.patient.name, normalizedCaseState.hisRecord?.fields.patientName].filter((item): item is string => Boolean(item?.trim()));
    const rawWorkbenchDraft = parsed.workbenchDraft;
    const workbenchDraft: WorkbenchUnsavedDraftFlag | null =
      rawWorkbenchDraft &&
      typeof rawWorkbenchDraft === "object" &&
      typeof rawWorkbenchDraft.caseId === "string" &&
      rawWorkbenchDraft.caseId === caseState.id &&
      typeof rawWorkbenchDraft.candidateIndex === "number" &&
      Number.isInteger(rawWorkbenchDraft.candidateIndex) &&
      typeof rawWorkbenchDraft.unsavedAt === "string" &&
      Number.isFinite(Date.parse(rawWorkbenchDraft.unsavedAt))
        ? { caseId: rawWorkbenchDraft.caseId, candidateIndex: rawWorkbenchDraft.candidateIndex, unsavedAt: rawWorkbenchDraft.unsavedAt }
        : null;
    const sanitizedSnapshot: WorkspaceSnapshot = {
      schemaVersion: "tcm-cdss-workspace-v1",
      updatedAt: parsed.updatedAt || new Date(updatedAtMs).toISOString(),
      runningPhase: parsed.runningPhase && (["collect", "question", "diagnose", "prescribe", "assess"] as Phase[]).includes(parsed.runningPhase)
        ? parsed.runningPhase
        : undefined,
      caseState,
      recordDraft: sanitizeRecordDraftForBrowserPersistence(rawRecordDraft, caseState),
      input: typeof parsed.input === "string" ? scrubPersistentPhiText(parsed.input, legacyNames).slice(0, MAX_CASE_SUPPLEMENT_CHARS) : "",
      selectedQuestionOptions: sanitizeQuestionSelectionsForBrowserPersistence(parsed.selectedQuestionOptions || {}, legacyNames),
      workbenchDraft,
    };
    return sanitizedSnapshot;
  } catch {
    // Network failures are retryable. The encrypted envelope remains in localStorage and can be
    // restored on the next reload once connectivity/authentication recovers.
    return null;
  }
}

function recoverInterruptedRun(state: CaseState, runningPhase?: Phase): CaseState {
  const interruptedPhase = runningPhase || (state.phase === "question" ? undefined : state.phase);
  if (!interruptedPhase || !(["collect", "question", "diagnose", "prescribe", "assess"] as Phase[]).includes(interruptedPhase) || state.lastError) return state;
  return {
    ...state,
    phase: "error",
    lastError: {
      phase: interruptedPhase,
      message: "页面刷新或关闭中断了正在运行的阶段；已保留病历和已完成结果，可从当前阶段安全重试。",
    },
  };
}

function clearWorkspaceSnapshot(): void {
  if (typeof window === "undefined") return;
  try {
    workspaceSaveSequence += 1;
    window.localStorage.removeItem(WORKSPACE_STORAGE_KEY);
  } catch {
    // localStorage may be unavailable
  }
}

type ChipGroupPreset = {
  title: string;
  items: string[];
};

const FACE_PRESETS: ChipGroupPreset[] = [
  { title: "面色", items: ["面色少华", "面色萎黄", "面色淡白", "面色潮红", "面色晦暗", "面色青紫"] },
  { title: "神态", items: ["神清", "精神倦怠", "烦躁易怒", "少气懒言", "形寒肢冷", "目赤"] },
  { title: "形体/局部", items: ["形体消瘦", "形体肥胖", "目周色暗", "唇色淡", "唇色紫暗", "两颧潮红"] },
];

const PULSE_PRESETS: ChipGroupPreset[] = [
  { title: "合脉", items: ["脉沉细", "脉沉迟", "脉细弱", "脉细数", "脉弦细", "脉弦数", "脉滑数", "脉浮紧", "脉浮数"] },
  { title: "单脉", items: ["脉浮", "脉沉", "脉弦", "脉细", "脉数", "脉滑", "脉涩", "脉弱", "脉濡", "脉缓", "脉紧", "脉迟"] },
];

const TONGUE_PRESETS: ChipGroupPreset[] = [
  { title: "舌质", items: ["舌淡红", "舌淡白", "舌红", "舌尖红", "舌边红", "舌绛", "舌暗紫", "瘀点瘀斑"] },
  { title: "舌形", items: ["舌淡胖", "边有齿印", "舌体瘦小", "舌有裂纹", "舌有点刺", "舌下络脉迂曲"] },
  { title: "舌苔", items: ["苔薄白", "苔白滑", "苔黄", "苔黄腻", "苔厚腻", "苔少", "无苔", "苔燥"] },
];

const TCM_DETAIL_PRESETS: ChipGroupPreset[] = [
  { title: "寒热汗出", items: ["畏寒喜暖", "手足不温", "五心烦热", "潮热盗汗", "自汗", "无汗"] },
  { title: "饮食二便", items: ["纳差腹胀", "口干不欲饮", "喜热饮", "口苦咽干", "大便溏薄", "大便干结", "小便清长", "小便黄赤"] },
  { title: "睡眠情志", items: ["入睡困难", "易醒多梦", "早醒", "烦躁易怒", "情志抑郁", "健忘心悸"] },
  { title: "腹诊/疼痛", items: ["腹部喜按", "腹部拒按", "疼痛固定刺痛", "疼痛游走", "胀痛", "刺痛"] },
];

const TCM_LINEAGE_SELECT_OPTIONS = LINEAGE_OPTIONS;

function createEmptyHisRecordDraft(): HisRecordDraft {
  return {
    patientName: "",
    sex: "",
    age: "",
    zhushu: "",
    xianbingshi: "",
    jiwangshi: "",
    allergyHistory: "",
    medicationHistory: "",
    vitalsT: "",
    vitalsP: "",
    vitalsR: "",
    vitalsBP: "",
    vitalsDetail: "",
    tcmFace: "",
    tcmPulse: "",
    tcmTongue: "",
    tcmDetail: "",
    tcmLineagePreference: "unrestricted",
    fuzhuJiancha: "",
  };
}

function mergeDraftPatch(draft: HisRecordDraft, patch: Partial<HisRecordDraft>, replace = false): HisRecordDraft {
  const next = { ...draft };
  for (const [key, rawValue] of Object.entries(patch) as Array<[keyof HisRecordDraft, string | undefined]>) {
    const value = (rawValue || "").trim();
    if (!value) continue;
    next[key] = replace ? value : appendDelimitedValue(next[key], value);
  }
  return next;
}

function selectedQuestionAnswerText(
  selections: Record<string, QuestionOptionSelection>,
  includePatched = false,
): string {
  return Object.entries(selections)
    .filter(([, selection]) => questionOptionKind(selection) !== "workflow_instruction")
    .filter(([, selection]) => questionOptionKind(selection) !== "clinical_fact" || !selection.requiresDetail || Boolean(selection.detailAnswer?.trim()))
    .filter(([, selection]) => includePatched || !selection.patch || Object.keys(selection.patch).length === 0)
    .map(([key, selection]) => {
      const answer = selection.requiresDetail
        ? `医生补充：${selection.detailAnswer?.trim()}`
        : selection.answer;
      return key === "__fallback" ? answer : `问题${key}：${answer}`;
    })
    .join("\n");
}

function hasPendingQuestionDetail(
  selections: Record<string, QuestionOptionSelection>,
): boolean {
  return Object.values(selections).some((selection) =>
    questionOptionKind(selection) === "clinical_fact" && selection.requiresDetail && !selection.detailAnswer?.trim(),
  );
}

function questionDetailPatch(selection: QuestionOptionSelection, detailText: string): Partial<HisRecordDraft> {
  const detail = detailText.trim();
  if (!detail) return {};
  const selected = selection;
  if (selected.targetField) {
    return { [selected.targetField]: detail } as Partial<HisRecordDraft>;
  }
  if (selected.detailTarget === "xianbingshi") {
    return { xianbingshi: `现病史补充：${detail}` };
  }
  if (selected.detailTarget === "tcmDetail") {
    return { tcmDetail: `问诊补充：${detail}` };
  }
  if (selected.detailTarget === "jiwangshi") {
    return { jiwangshi: `既往史/特殊人群补充：${detail}` };
  }
  if (selected.detailTarget === "fuzhuJiancha") {
    return { fuzhuJiancha: `辅助检查补充：${detail}` };
  }
  if (selected.detailTarget === "allergyMedication") {
    const inferred = inferDraftPatchFromFreeText(detail);
    const patch = {
      ...(inferred.allergyHistory ? { allergyHistory: inferred.allergyHistory } : {}),
      ...(inferred.medicationHistory ? { medicationHistory: inferred.medicationHistory } : {}),
    };
    return Object.keys(patch).length > 0 ? patch : { tcmDetail: `过敏/用药信息补充：${detail}` };
  }
  if (selected.detailTarget === "vitals") {
    const patch = extractVitalsPatch(detail);
    return Object.keys(patch).length > 0 ? patch : { vitalsDetail: `生命体征补充：${detail}` };
  }
  if (selected.detailTarget === "tonguePulse") {
    const patch: Partial<HisRecordDraft> = {};
    const clauses = detail.split(/[；;，,]/).map((item) => item.trim()).filter(Boolean);
    const tongue = clauses.filter((item) => /舌|苔/.test(item)).join("，");
    const pulse = clauses.filter((item) => /脉/.test(item)).join("，");
    if (tongue) patch.tcmTongue = tongue;
    if (pulse) patch.tcmPulse = pulse;
    return Object.keys(patch).length > 0 ? patch : { tcmDetail: `四诊补充：${detail}` };
  }
  const label = `${selected.label || ""} ${selected.answer}`;
  if (/诱因病程|具体病程|起病|病程|诱因|症状性质|发作规律|加重缓解|现病史/.test(label)) {
    return { xianbingshi: `现病史补充：${detail}` };
  }
  return { tcmDetail: `问诊补充（${selected.label || "详情"}）：${detail}` };
}

function applySelectedQuestionOptionsToDraft(
  draft: HisRecordDraft,
  selections: Record<string, QuestionOptionSelection>,
): HisRecordDraft {
  let next = { ...draft };
  for (const selection of Object.values(selections)) {
    if (questionOptionKind(selection) !== "clinical_fact") continue;
    const patch = selection.patch || (
      selection.requiresDetail && !selection.targetField
        ? questionDetailPatch(selection, selection.detailAnswer || "")
        : {}
    );
    if (Object.keys(patch).length === 0) continue;
    next = mergeDraftPatch(next, patch, selection.replacePatch);
  }
  return next;
}

type M02InterpretationApiResponse = {
  ok?: boolean;
  answers?: unknown[];
  failure?: { code?: string; message?: string };
};

function latestM02AskPlan(state: CaseState): M02Plan | undefined {
  for (const message of [...state.conversation].reverse()) {
    if (message.role !== "assistant") continue;
    const plan = parseM02PlanFromContent(message.content);
    if (plan?.decision === "ask" && plan.questions.length > 0) return plan;
  }
  return undefined;
}

async function interpretTypedQuestionDetails(
  state: CaseState,
  selections: Record<string, QuestionOptionSelection>,
): Promise<Record<string, QuestionOptionSelection>> {
  const plan = latestM02AskPlan(state);
  if (!plan) return selections;
  const detailAnswers = Object.entries(selections)
    .filter(([, selection]) => selection.targetField && selection.detailAnswer?.trim())
    .map(([questionId, selection]) => `问题${questionId}：${selection.detailAnswer?.trim()}`)
    .join("\n");
  if (!detailAnswers) return selections;

  const preserveRawDetails = () => Object.fromEntries(Object.entries(selections).map(([questionId, selection]) => {
    const rawDetail = selection.detailAnswer?.trim();
    return [questionId, rawDetail && selection.targetField
      ? { ...selection, patch: { [selection.targetField]: rawDetail } as Partial<HisRecordDraft> }
      : selection];
  }));

  try {
    const { response, body } = await fetchJsonWithTimeout<M02InterpretationApiResponse>(
      apiUrl("/api/diagnosis/question/interpret"),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caseState: state, m02Plan: plan, answer: detailAnswers }),
      },
      25_000,
    );
    if (!response.ok || body?.ok !== true || !Array.isArray(body.answers)) return preserveRawDetails();
    const interpreted = { ...selections };
    for (const rawAnswer of body.answers) {
      if (!rawAnswer || typeof rawAnswer !== "object") continue;
      const questionId = (rawAnswer as { questionId?: unknown }).questionId;
      const targetField = (rawAnswer as { targetField?: unknown }).targetField;
      const recordValue = (rawAnswer as { recordValue?: unknown }).recordValue;
      if (typeof questionId !== "string" || typeof targetField !== "string" ||
          (recordValue !== null && typeof recordValue !== "string")) continue;
      const previous = interpreted[questionId];
      const authorized = plan.questions.find((question) =>
        question.id === questionId && question.targetField === targetField,
      );
      if (!previous || !authorized) continue;
      interpreted[questionId] = {
        ...previous,
        targetField: authorized.targetField,
        patch: recordValue?.trim()
          ? { [authorized.targetField]: recordValue.trim() } as Partial<HisRecordDraft>
          : undefined,
      };
    }
    return interpreted;
  } catch {
    // The clinician's words still enter the reasoning conversation. A failed semantic projection
    // must never be replaced with keyword guessing or block the workflow.
    return preserveRawDetails();
  }
}

function inferDraftPatchFromFreeText(text: string): Partial<HisRecordDraft> {
  const normalized = text.replace(/\s+/g, " ").trim();
  const patch: Partial<HisRecordDraft> = {};
  if (!normalized) return patch;

  // “待核实/不清楚”是明确的未知状态，不是舌脉、过敏或用药阳性事实。
  // 先写入未知占位并覆盖旧选择，避免抽取器把“舌象和脉象均待核实”误识别成舌象，
  // 同时残留上一轮脉象造成证据污染。
  const unknownCue = /(待核实|未核实|待确认|暂不清楚|不清楚|未知|未说明|未观察|无法判断|无法识别|图片质量不足|说不清)/;
  if (unknownCue.test(normalized)) {
    if (/性别/.test(normalized)) patch.sex = "未说明";
    if (/过敏史|过敏/.test(normalized)) patch.allergyHistory = "过敏史待核实";
    if (/当前用药|用药史|用药/.test(normalized)) patch.medicationHistory = "当前用药待核实";
    if (/舌象|舌脉|舌和脉/.test(normalized)) patch.tcmTongue = "舌象待核实";
    if (/脉象|舌脉|舌和脉/.test(normalized)) patch.tcmPulse = "脉象待核实";
  }

  const sexMatch = normalized.match(/(?:性别|患者)?\s*(男|女)(?:性|患者)?/);
  if (!patch.sex && sexMatch?.[1] &&
      !/(男女|男或女|男性或女性)/.test(normalized) &&
      !/(?:是否|是不是|可能|疑似|待确认|需确认)[^，。；;]{0,6}(?:男|女)/.test(normalized)) {
    patch.sex = sexMatch[1];
  }

  const ageMatch = normalized.match(/(?:年龄|患者)?\s*(\d{1,3})\s*岁/);
  if (ageMatch?.[1]) {
    const age = Number(ageMatch[1]);
    if (Number.isFinite(age) && age >= 0 && age <= 120) patch.age = String(age);
  }

  const t = normalized.match(/(?:T|体温)\s*[:：]?\s*((?:3[0-9]|4[0-5])(?:\.\d)?)(?:℃|度)?/i)?.[1];
  const p = normalized.match(/(?:P|HR|心率|脉搏)\s*[:：]?\s*(\d{2,3})(?:次\/分|次每分|bpm)?/i)?.[1];
  const r = normalized.match(/(?:R|RR|呼吸)\s*[:：]?\s*(\d{1,2})(?:次\/分|次每分)?/i)?.[1];
  const bp = normalized.match(/(?:BP|血压)\s*[:：]?\s*(\d{2,3}\s*(?:\/|\\|-|－|—|–|~|～)\s*\d{2,3})/i)?.[1]?.replace(/\s+/g, "");
  if (t) patch.vitalsT = t;
  if (p) patch.vitalsP = p;
  if (r) patch.vitalsR = r;
  if (bp) patch.vitalsBP = normalizeBloodPressureInput(bp);
  const weight = normalized.match(/(?:体重|WT|weight)\s*[:：]?\s*(\d{1,3}(?:\.\d+)?)\s*(kg|公斤|千克)/i);
  if (weight?.[1]) patch.vitalsDetail = `体重${weight[1]}kg`;

  const tongueMatch = unknownCue.test(normalized) ? null : normalized.match(/舌[^，。；;\n]{1,50}(?:[，,、 ]?苔[^，。；;\n]{1,30})?/);
  if (tongueMatch?.[0]) patch.tcmTongue = tongueMatch[0];
  const pulseMatch = unknownCue.test(normalized) ? null : normalized.match(/脉(?:浮|沉|迟|数|滑|涩|弦|细|弱|濡|缓|紧|实|虚|微|洪|结|代|促){1,4}/);
  if (pulseMatch?.[0]) patch.tcmPulse = pulseMatch[0];

  return patch;
}

function normalizeBloodPressureInput(value: string): string {
  const text = value.trim();
  if (!text) return "";
  const match = text.match(/(\d{2,3})\s*(?:\/|\\|-|－|—|–|~|～)\s*(\d{2,3})/);
  if (!match) return text.replace(/[／\\]/g, "/");
  const first = Number(match[1]);
  const second = Number(match[2]);
  if (!Number.isFinite(first) || !Number.isFinite(second)) return text;
  return `${first}/${second}`;
}

function buildVitalsLine(draft: HisRecordDraft): string {
  const bp = normalizeBloodPressureInput(draft.vitalsBP);
  const values = [
    draft.vitalsT && `T ${draft.vitalsT}℃`,
    draft.vitalsP && `P ${draft.vitalsP}次/分`,
    draft.vitalsR && `R ${draft.vitalsR}次/分`,
    bp && `BP ${bp}mmHg`,
    draft.vitalsDetail,
  ].filter(Boolean);
  return values.join("，");
}

function buildHisRecordText(draft: HisRecordDraft, extraText = "", tongueUploaded = false): string {
  const ageText = draft.age.trim();
  const patient = [
    draft.sex && `性别${draft.sex}`,
    ageText && `年龄${/(岁|月|天|日)/.test(ageText) ? ageText : `${ageText}岁`}`,
  ].filter(Boolean).join("，");
  const rows = [
    patient && `患者信息：${patient}`,
    draft.zhushu && `主诉：${draft.zhushu}`,
    draft.xianbingshi && `现病史：${draft.xianbingshi}`,
    draft.jiwangshi && `既往史：${draft.jiwangshi}`,
    draft.allergyHistory && `过敏史：${draft.allergyHistory}`,
    draft.medicationHistory && `用药史：${draft.medicationHistory}`,
    buildVitalsLine(draft) && `生命体征/体格检查：${buildVitalsLine(draft)}`,
    draft.tcmFace && `面象：${draft.tcmFace}`,
    (draft.tcmTongue || tongueUploaded) && `舌象：${[draft.tcmTongue, tongueUploaded ? "已上传舌象图片" : ""].filter(Boolean).join("，")}`,
    draft.tcmPulse && `脉象：${draft.tcmPulse}`,
    draft.tcmDetail && `其他四诊/问诊补充：${draft.tcmDetail}`,
    draft.tcmLineagePreference && draft.tcmLineagePreference !== "unrestricted" && `诊疗思路偏好：${lineageLabel(draft.tcmLineagePreference)}`,
    draft.fuzhuJiancha && `辅助检查：${draft.fuzhuJiancha}`,
    extraText.trim() && `补充说明：${extraText.trim()}`,
  ].filter(Boolean);
  return rows.join("\n");
}

function hasHisRecordInput(draft: HisRecordDraft, extraText: string, tongueUploaded: boolean): boolean {
  return Boolean(buildHisRecordText(draft, extraText, tongueUploaded).trim());
}

function isModelInputOverBudget(text: string): boolean {
  return text.length > MAX_MODEL_INPUT_CHARS;
}

function compactHisFields(fields: HisRecordSnapshot["fields"]): HisRecordSnapshot["fields"] {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => typeof value === "string" && value.trim()),
  ) as HisRecordSnapshot["fields"];
}

function buildHisRecordSnapshot(
  draft: HisRecordDraft,
  extraText: string,
  tongueUploaded: boolean,
  caseId: string,
): HisRecordSnapshot {
  return {
    schemaVersion: "tcm-cdss-his-v1",
    source: "tcm-cdss-his",
    caseId,
    updatedAt: new Date().toISOString(),
    tongueImageUploaded: tongueUploaded,
    fields: compactHisFields({
      patientName: draft.patientName,
      sex: draft.sex,
      age: draft.age,
      zhushu: draft.zhushu,
      xianbingshi: draft.xianbingshi,
      jiwangshi: draft.jiwangshi,
      guomin: draft.allergyHistory,
      yongyaoshi: draft.medicationHistory,
      vitalsT: draft.vitalsT,
      vitalsP: draft.vitalsP,
      vitalsR: draft.vitalsR,
      vitalsBP: normalizeBloodPressureInput(draft.vitalsBP),
      vitalsDetail: draft.vitalsDetail,
      tcmFace: draft.tcmFace,
      tcmPulse: draft.tcmPulse,
      tcmTongue: draft.tcmTongue,
      tcmDetail: draft.tcmDetail,
      tcmLineagePreference: draft.tcmLineagePreference,
      fuzhuJiancha: draft.fuzhuJiancha,
      extraText,
    }),
    rawText: buildHisRecordText(draft, extraText, tongueUploaded),
  };
}

function parseAgeInput(value: string): number | undefined {
  const age = ageValue(value);
  return age != null && age >= 0 && age <= 120 ? age : undefined;
}

function hasChiefComplaintInput(draft: HisRecordDraft): boolean {
  return Boolean(draft.zhushu.trim());
}

function hasAnyDraftInput(draft: HisRecordDraft): boolean {
  return (Object.entries(draft) as Array<[keyof HisRecordDraft, string]>).some(([key, value]) => {
    if (key === "tcmLineagePreference" && value === "unrestricted") return false;
    return value.trim().length > 0;
  });
}

const DRAFT_INPUT_TEST_IDS = [
  "patient-name",
  "patient-sex",
  "patient-age",
  "chief-complaint",
  "present-history",
  "past-history",
  "allergy-history",
  "medication-history",
  "vitals-t",
  "vitals-p",
  "vitals-r",
  "vitals-bp",
  "tcm-face",
  "tcm-pulse",
  "tcm-tongue",
  "tcm-detail",
  "tcm-lineage",
  "aux-exam",
] as const;

function hasAnyDraftInputInDocument(): boolean {
  if (typeof document === "undefined") return false;
  return DRAFT_INPUT_TEST_IDS.some((testId) => {
    const element = document.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[data-testid="${testId}"]`);
    if (testId === "tcm-lineage" && element?.value === "unrestricted") return false;
    return Boolean(element?.value.trim());
  });
}

function withSafetyGateAndOperationalCompleteness(state: CaseState): CaseState {
  return withSafetyGate(state);
}

function applyDraftToCaseState(
  state: CaseState,
  draft: HisRecordDraft,
  extraText: string,
  tongueUploaded: boolean,
): CaseState {
  const hisRecord = buildHisRecordSnapshot(draft, extraText, tongueUploaded, state.id);
  const vitals = Object.fromEntries(
    [
      ["temperature", draft.vitalsT.trim()],
      ["pulse", draft.vitalsP.trim()],
      ["respiration", draft.vitalsR.trim()],
      ["bloodPressure", normalizeBloodPressureInput(draft.vitalsBP)],
      ["detail", draft.vitalsDetail.trim()],
    ].filter(([, value]) => Boolean(value)),
  );
  const symptoms = {
    ...Object.fromEntries(Object.entries(state.symptoms || {}).filter(([key]) => !["presentHistory", "tcmDetail", "exams", "extraText"].includes(key))),
    ...(draft.xianbingshi.trim() ? { presentHistory: draft.xianbingshi.trim() } : {}),
    ...(draft.tcmDetail.trim() ? { tcmDetail: draft.tcmDetail.trim() } : {}),
    ...(draft.fuzhuJiancha.trim() ? { exams: draft.fuzhuJiancha.trim() } : {}),
    ...(extraText.trim() ? { extraText: extraText.trim() } : {}),
  };
  return {
    ...state,
    hisRecord,
    chiefComplaint: draft.zhushu.trim(),
    patient: {
      occupation: state.patient.occupation,
      ...(draft.sex.trim() ? { sex: draft.sex.trim() } : {}),
      ...(parseAgeInput(draft.age) != null ? { age: parseAgeInput(draft.age) } : {}),
    },
    symptoms,
    tongue: draft.tcmTongue.trim() || undefined,
    pulse: draft.tcmPulse.trim() || undefined,
    faceNote: draft.tcmFace.trim() || undefined,
    pastHistory: draft.jiwangshi.trim() || undefined,
    medicationHistory: draft.medicationHistory.trim() || undefined,
    allergyHistory: draft.allergyHistory.trim() || undefined,
    tcmLineagePreference: draft.tcmLineagePreference.trim() || undefined,
    vitals: Object.keys(vitals).length > 0 ? vitals : undefined,
  };
}

function hasQuestionRecordChange(
  draft: HisRecordDraft,
  previous: HisRecordSnapshot | undefined,
  tongueUploaded: boolean,
  caseId: string,
): boolean {
  const next = buildHisRecordSnapshot(draft, "", tongueUploaded, caseId);
  const normalizeComparableFields = (fields: HisRecordSnapshot["fields"] | undefined) => {
    return Object.fromEntries(
      Object.entries(fields || {}).filter(([key]) => key !== "extraText"),
    ) as HisRecordSnapshot["fields"];
  };
  const previousFields = JSON.stringify(normalizeComparableFields(previous?.fields));
  const nextFields = JSON.stringify(normalizeComparableFields(next.fields));
  return previousFields !== nextFields || Boolean(tongueUploaded) !== Boolean(previous?.tongueImageUploaded);
}

function InputCell({
  label,
  value,
  onChange,
  placeholder,
  testId,
  required = false,
  maxLength = MAX_SHORT_INPUT_CHARS,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  testId?: string;
  required?: boolean;
  maxLength?: number;
}) {
  return (
    <div className="flex min-h-[38px] border-b border-gray-200 last:border-b-0">
      <div className="flex w-[88px] shrink-0 items-center border-r border-gray-200 bg-gray-50 px-2 text-[12px] font-medium text-gray-700">
        {label}{required && <span className="ml-0.5 text-rose-500">*</span>}
      </div>
      <input
        aria-label={label}
        data-testid={testId}
        value={value}
        onChange={(event) => onChange(event.target.value.slice(0, maxLength))}
        maxLength={maxLength}
        placeholder={placeholder}
        className="min-w-0 flex-1 bg-white px-2 text-[13px] font-medium text-gray-800 outline-none placeholder:text-gray-300"
      />
    </div>
  );
}

function SelectCell({
  label,
  value,
  onChange,
  options,
  testId,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly { value: string; label: string }[];
  testId?: string;
}) {
  return (
    <div className="flex min-h-[38px] border-b border-gray-200 last:border-b-0">
      <div className="flex w-[88px] shrink-0 items-center border-r border-gray-200 bg-gray-50 px-2 text-[12px] font-medium text-gray-700">
        {label}
      </div>
      <select
        aria-label={label}
        data-testid={testId}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="min-w-0 flex-1 appearance-auto bg-white px-2 text-[13px] font-medium text-gray-800 outline-none"
      >
        {options.map((option) => (
          <option key={option.label} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function TextareaCell({
  label,
  value,
  onChange,
  placeholder,
  actions,
  testId,
  required = false,
  maxLength,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  actions?: React.ReactNode;
  testId?: string;
  required?: boolean;
  maxLength?: number;
}) {
  const isLongField = /主诉|现病史|既往史|过敏史|用药史|问诊补充|辅助检查/.test(label);
  const limit = maxLength ?? (isLongField ? MAX_LONG_INPUT_CHARS : MAX_SHORT_INPUT_CHARS);
  return (
    <div className={`flex border-b border-gray-200 last:border-b-0 ${isLongField ? "min-h-[72px]" : "min-h-[48px]"}`}>
      <div className="flex w-[88px] shrink-0 items-center border-r border-gray-200 bg-gray-50 px-2 text-[12px] font-medium text-gray-700">
        {label}{required && <span className="ml-0.5 text-rose-500">*</span>}
      </div>
      <div className={`flex min-w-0 flex-1 gap-2 px-1.5 py-1 ${isLongField ? "items-stretch" : "items-center"}`}>
        <textarea
          aria-label={label}
          data-testid={testId}
          value={value}
          onChange={(event) => onChange(event.target.value.slice(0, limit))}
          maxLength={limit}
          placeholder={placeholder}
          rows={isLongField ? 2 : 1}
          className={`min-w-0 flex-1 bg-white px-1 py-1 text-[13px] font-medium leading-5 text-gray-800 outline-none placeholder:text-gray-300 ${
            isLongField ? "min-h-[58px] resize-y" : "min-h-[28px] resize-none"
          }`}
        />
        {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
      </div>
    </div>
  );
}

function ChipPanel({
  groups,
  onPick,
}: {
  groups: ChipGroupPreset[];
  onPick: (value: string) => void;
}) {
  return (
    <div className="space-y-2 rounded-lg border border-gray-200 bg-white p-2">
      {groups.map((group) => (
        <div key={group.title}>
          <p className="mb-1 text-[11px] font-bold text-gray-500">{group.title}</p>
          <div className="flex flex-wrap gap-1">
            {group.items.map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => onPick(item)}
                className="rounded border border-gray-200 bg-gray-50 px-2 py-0.5 text-[12px] font-medium text-gray-700 transition-colors hover:border-teal-200 hover:bg-teal-50 hover:text-teal-700"
              >
                {item}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

type ToggleChipViewport = {
  width: number;
  height: number;
  offsetLeft: number;
  offsetTop: number;
};

type ToggleChipTriggerRect = {
  top: number;
  bottom: number;
  right: number;
};

export function resolveToggleChipPanelPosition(
  triggerRect: ToggleChipTriggerRect,
  viewport: ToggleChipViewport,
  measuredHeight = 0,
): { top: number; left: number; width: number; maxHeight: number } {
  const gap = 6;
  const viewportGap = 12;
  const viewportLeft = viewport.offsetLeft;
  const viewportTop = viewport.offsetTop;
  const viewportRight = viewportLeft + viewport.width;
  const viewportBottom = viewportTop + viewport.height;
  const width = Math.max(0, Math.min(320, viewport.width - viewportGap * 2));
  const left = Math.max(
    viewportLeft + viewportGap,
    Math.min(viewportRight - width - viewportGap, triggerRect.right - width),
  );
  const belowSpace = Math.max(0, viewportBottom - triggerRect.bottom - gap - viewportGap);
  const aboveSpace = Math.max(0, triggerRect.top - gap - viewportTop - viewportGap);
  const showAbove = measuredHeight > 0
    ? measuredHeight > belowSpace && aboveSpace > belowSpace
    : belowSpace < 180 && aboveSpace > belowSpace;
  const available = showAbove ? aboveSpace : belowSpace;
  const usableViewportHeight = Math.max(0, viewport.height - viewportGap * 2);
  const preferredHeight = available || Math.round(viewport.height * 0.76);
  const maxHeight = Math.min(520, usableViewportHeight, Math.max(80, preferredHeight));
  const visibleHeight = measuredHeight > 0 ? Math.min(measuredHeight, maxHeight) : maxHeight;
  const top = showAbove
    ? Math.max(viewportTop + viewportGap, triggerRect.top - gap - visibleHeight)
    : Math.min(triggerRect.bottom + gap, viewportBottom - viewportGap - visibleHeight);
  return { top, left, width, maxHeight };
}

function ToggleChipPanel({
  label,
  icon,
  groups,
  onPick,
  testId,
}: {
  label: string;
  icon: React.ReactNode;
  groups: ChipGroupPreset[];
  onPick: (value: string) => void;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const floatingRef = useRef<HTMLDivElement | null>(null);
  const [floatingPosition, setFloatingPosition] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null);
  const updateFloatingPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const visualViewport = window.visualViewport;
    const viewport: ToggleChipViewport = visualViewport
      ? {
          width: visualViewport.width,
          height: visualViewport.height,
          offsetLeft: visualViewport.offsetLeft,
          offsetTop: visualViewport.offsetTop,
        }
      : { width: window.innerWidth, height: window.innerHeight, offsetLeft: 0, offsetTop: 0 };
    // Use the panel's full content height. getBoundingClientRect() only reports the
    // already-clipped height after max-height is applied and can make a tall menu
    // look as though it still fits below the trigger.
    const measuredHeight = floatingRef.current?.scrollHeight || 0;
    setFloatingPosition(resolveToggleChipPanelPosition(rect, viewport, measuredHeight));
  }, []);
  useEffect(() => {
    if (!open) return;
    updateFloatingPosition();
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        panelRef.current && !panelRef.current.contains(target) &&
        floatingRef.current && !floatingRef.current.contains(target)
      ) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onReposition = () => updateFloatingPosition();
    const visualViewport = window.visualViewport;
    const animationFrame = window.requestAnimationFrame(updateFloatingPosition);
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(updateFloatingPosition);
    if (floatingRef.current) resizeObserver?.observe(floatingRef.current);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onReposition);
    window.addEventListener("scroll", onReposition, true);
    visualViewport?.addEventListener("resize", onReposition);
    visualViewport?.addEventListener("scroll", onReposition);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      resizeObserver?.disconnect();
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onReposition, true);
      visualViewport?.removeEventListener("resize", onReposition);
      visualViewport?.removeEventListener("scroll", onReposition);
    };
  }, [open, updateFloatingPosition]);
  return (
    <div className="relative" ref={panelRef}>
      <button
        ref={triggerRef}
        type="button"
        data-testid={testId}
        onClick={() => {
          updateFloatingPosition();
          setOpen((value) => !value);
        }}
        className="inline-flex h-8 items-center gap-1 rounded border border-gray-200 bg-gray-50 px-2 text-[12px] font-bold text-gray-700 transition-colors hover:bg-gray-100"
        title={label}
      >
        {icon}
        {label}
      </button>
      {open && floatingPosition && createPortal(
        <div
          ref={floatingRef}
          className="fixed z-50 overflow-y-auto rounded-lg shadow-xl"
          style={{ top: floatingPosition.top, left: floatingPosition.left, width: floatingPosition.width, maxHeight: floatingPosition.maxHeight }}
        >
          <ChipPanel
            groups={groups}
            onPick={(value) => {
              onPick(value);
              setOpen(false);
            }}
          />
        </div>,
        document.body,
      )}
    </div>
  );
}

function CaptureModalShell({
  title,
  subtitle,
  onClose,
  children,
  footer,
  testId,
}: {
  title: string;
  subtitle: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  testId?: string;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-950/35 px-3 py-4" role="presentation">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="capture-modal-title"
        data-testid={testId}
        className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-2xl"
      >
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-gray-200 px-5 py-4">
          <div className="min-w-0">
            <h2 id="capture-modal-title" className="text-[15px] font-bold text-gray-950">{title}</h2>
            <p className="mt-1 text-[12px] leading-relaxed text-gray-500">{subtitle}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-500 transition-colors hover:bg-gray-50"
            aria-label="关闭采集弹窗"
            title="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto bg-[#F7F9FB] p-4">{children}</div>
        {footer && <div className="shrink-0 border-t border-gray-200 bg-white px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

function GuidanceLine({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex gap-2 text-[12px] leading-relaxed text-gray-600">
      <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-teal-600" />
      <span>{children}</span>
    </li>
  );
}

function CaptureProgressCard({
  title,
  status,
  active = false,
}: {
  title: string;
  status: string;
  active?: boolean;
}) {
  return (
    <div className={`rounded-lg border p-3 ${active ? "border-teal-200 bg-teal-50" : "border-gray-200 bg-white"}`}>
      <div className="flex items-center gap-2">
        <div className={`flex h-8 w-8 items-center justify-center rounded-lg ${active ? "bg-teal-600 text-white" : "bg-gray-100 text-gray-400"}`}>
          <ImageIcon className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-[12px] font-bold text-gray-800">{title}</p>
          <p className={`mt-0.5 text-[11px] font-medium ${active ? "text-teal-700" : "text-gray-400"}`}>{status}</p>
        </div>
      </div>
    </div>
  );
}

function TongueCaptureModal({
  tongueValue,
  tongueImage,
  uploadNotice,
  isRunning,
  onPick,
  onManualChange,
  onUpload,
  onClearImage,
  imageConsent,
  onImageConsentChange,
  onClose,
}: {
  tongueValue: string;
  tongueImage: string | null;
  uploadNotice?: string;
  isRunning: boolean;
  onPick: (value: string) => void;
  onManualChange: (value: string) => void;
  onUpload: () => void;
  onClearImage: () => void;
  imageConsent: boolean;
  onImageConsentChange: (checked: boolean) => void;
  onClose: () => void;
}) {
  const [activeStep, setActiveStep] = useState<"tongue" | "sublingual" | "review">("tongue");
  const stepOrder = ["tongue", "sublingual", "review"] as const;
  const activeIndex = stepOrder.indexOf(activeStep);
  const goNext = () => setActiveStep(stepOrder[Math.min(stepOrder.length - 1, activeIndex + 1)]);
  return (
    <CaptureModalShell
      title="望诊分析"
      subtitle="标准化舌诊采集：舌面图像、舌下络脉与人工复核分步完成；图像仅用于本次辅助分析，不写入本机自动保存。"
      onClose={onClose}
      testId="tongue-capture-dialog"
      footer={
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[11px] leading-relaxed text-gray-500">质量不足时会提示重拍，低质量图像不会覆盖医生手动舌象。</span>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-[13px] font-bold text-gray-700 transition-colors hover:bg-gray-50">
              取消
            </button>
            {activeStep !== "review" ? (
              <button type="button" onClick={goNext} className="rounded-lg bg-teal-600 px-4 py-2 text-[13px] font-bold text-white transition-colors hover:bg-teal-700">
                下一步
              </button>
            ) : (
              <button type="button" onClick={onClose} className="rounded-lg bg-teal-600 px-4 py-2 text-[13px] font-bold text-white transition-colors hover:bg-teal-700">
                完成采集
              </button>
            )}
          </div>
        </div>
      }
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-4">
          <div className="flex rounded-lg border border-gray-200 bg-white p-1">
            {[
              ["tongue", "舌面图像"],
              ["sublingual", "舌下络脉"],
              ["review", "人工复核"],
            ].map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setActiveStep(key as "tongue" | "sublingual" | "review")}
                className={`min-h-9 flex-1 rounded-md px-2 text-[12px] font-bold transition-colors ${
                  activeStep === key ? "bg-teal-600 text-white" : "text-gray-500 hover:bg-gray-50"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {activeStep === "tongue" && (
            <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_300px]">
              <div className="rounded-xl border border-gray-200 bg-white p-4">
                <h3 className="text-[13px] font-bold text-gray-900">拍摄舌面图像</h3>
                <p className="mt-1 text-[12px] leading-relaxed text-gray-500">请按以下指引拍摄患者舌面图像，确保光线充足、图像清晰。</p>
                <ul className="mt-3 space-y-2">
                  <GuidanceLine>伸出舌头，自然舒展，不要过分用力或卷曲。</GuidanceLine>
                  <GuidanceLine>选择光线明亮处，避免阴影、强反光、滤镜和美颜。</GuidanceLine>
                  <GuidanceLine>摄像头距离舌尖约 20-30cm，保持镜头垂直向下。</GuidanceLine>
                </ul>
                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={onUpload}
                    disabled={isRunning || !imageConsent}
                    className="inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-teal-600 px-3 text-[12px] font-bold text-white transition-colors hover:bg-teal-700 disabled:cursor-not-allowed disabled:bg-gray-300"
                  >
                    <ImageIcon className="h-3.5 w-3.5" />
                    本地上传/拍摄
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveStep("review")}
                    className="inline-flex min-h-9 items-center rounded-lg border border-gray-200 bg-white px-3 text-[12px] font-bold text-gray-700 transition-colors hover:bg-gray-50"
                  >
                    手动录入
                  </button>
                </div>
                <label className="mt-3 flex cursor-pointer items-start gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-[11px] leading-relaxed text-gray-600">
                  <input
                    type="checkbox"
                    checked={imageConsent}
                    onChange={(event) => onImageConsentChange(event.target.checked)}
                    disabled={isRunning}
                    className="mt-0.5 h-3.5 w-3.5 accent-teal-600"
                  />
                  <span>已取得患者授权，同意将本次舌照发送至院方配置的舌象识别服务；图像不进入本机病例自动保存。</span>
                </label>
              </div>
              <div className="rounded-xl border border-gray-200 bg-white p-3">
                <div className="flex aspect-[4/3] items-center justify-center overflow-hidden rounded-lg border border-dashed border-gray-200 bg-gray-50">
                  {tongueImage ? (
                    <div className="relative h-full w-full">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={tongueImage} alt="舌象预览" className="h-full w-full object-cover" />
                      <button
                        type="button"
                        onClick={onClearImage}
                        disabled={isRunning}
                        className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full bg-rose-600 text-white shadow-sm"
                        title="移除舌照"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ) : (
                    <div className="px-6 text-center">
                      <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-teal-50 text-teal-600">
                        <ImageIcon className="h-8 w-8" />
                      </div>
                      <p className="mt-2 text-[12px] font-medium text-gray-400">待上传舌面图像</p>
                      <p className="mt-1 text-[11px] leading-relaxed text-gray-400">建议画面只保留口唇与舌体，避免背景干扰。</p>
                    </div>
                  )}
                </div>
                {uploadNotice && <p className="mt-2 text-[12px] font-medium text-amber-700">{uploadNotice}</p>}
              </div>
            </div>
          )}

          {activeStep === "sublingual" && (
            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <h3 className="text-[13px] font-bold text-gray-900">舌下络脉采集</h3>
              <p className="mt-1 text-[12px] leading-relaxed text-gray-500">当前版本以医生人工描述为主，舌下照片识别暂不强制启用。</p>
              <div className="mt-3">
                <ChipPanel
                  groups={[{ title: "舌下络脉", items: ["舌下络脉淡紫", "舌下络脉青紫", "舌下络脉迂曲", "舌下络脉怒张", "舌下络脉不显"] }]}
                  onPick={onPick}
                />
              </div>
            </div>
          )}

          {activeStep === "review" && (
            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <h3 className="text-[13px] font-bold text-gray-900">人工复核舌象</h3>
              <p className="mt-1 text-[12px] leading-relaxed text-gray-500">医生可直接录入或修正图像分析结果，最终以人工确认字段进入推理链。</p>
              <div className="mt-3">
                <ChipPanel groups={TONGUE_PRESETS} onPick={onPick} />
              </div>
              <textarea
                value={tongueValue}
                onChange={(event) => onManualChange(event.target.value.slice(0, MAX_SHORT_INPUT_CHARS))}
                maxLength={MAX_SHORT_INPUT_CHARS}
                placeholder="例如：舌暗红，苔黄腻，舌下络脉迂曲"
                className="mt-3 min-h-[92px] w-full resize-y rounded-lg border border-gray-200 bg-white p-3 text-[13px] font-medium leading-5 text-gray-800 outline-none focus:border-teal-400"
              />
            </div>
          )}
        </div>

        <div className="space-y-3">
          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <h3 className="text-[13px] font-bold text-gray-900">当前采集进度</h3>
            <div className="mt-3 grid gap-2">
              <CaptureProgressCard title="舌面图像采集" status={tongueImage ? "已采集，待图像质控" : "待采集"} active={activeStep === "tongue"} />
              <CaptureProgressCard title="舌下络脉采集" status={/舌下络脉/.test(tongueValue) ? "已记录" : "可选，未记录"} active={activeStep === "sublingual"} />
              <CaptureProgressCard title="人工复核记录" status={tongueValue.trim() ? "已填写" : "待填写"} active={activeStep === "review"} />
            </div>
          </div>
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
            <h3 className="text-[13px] font-bold text-amber-900">注意事项</h3>
            <ul className="mt-2 space-y-2">
              <GuidanceLine>采集前 30 分钟内尽量避免进食、饮水、吸烟或刷舌。</GuidanceLine>
              <GuidanceLine>不要使用美颜、锐化、滤镜或强制补光。</GuidanceLine>
              <GuidanceLine>图像识别只作为辅助证据，不替代医生舌诊判断。</GuidanceLine>
            </ul>
          </div>
        </div>
      </div>
    </CaptureModalShell>
  );
}

function HisMedicalRecordWorkspace({
  draft,
  setDraft,
  isRunning,
  tongueImage,
  uploadNotice,
  tongueInputRef,
  onImageChange,
  onClearTongueImage,
  onOpenTongueCapture,
}: {
  draft: HisRecordDraft;
  setDraft: React.Dispatch<React.SetStateAction<HisRecordDraft>>;
  isRunning: boolean;
  tongueImage: string | null;
  uploadNotice?: string;
  tongueInputRef: React.RefObject<HTMLInputElement | null>;
  onImageChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onClearTongueImage: () => void;
  onOpenTongueCapture: () => void;
}) {
  const update = <K extends keyof HisRecordDraft>(key: K, value: HisRecordDraft[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  };
  const append = (key: keyof HisRecordDraft, value: string) => {
    setDraft((prev) => ({ ...prev, [key]: appendClinicalPresetValue(key, prev[key], value) }));
  };
  const tonguePulseConflict = detectTonguePulseFieldConflict(draft.tcmTongue, draft.tcmPulse);

  return (
    <section id="cdss-section-record" className="flex scroll-mt-3 flex-col overflow-hidden rounded-xl border border-gray-200 bg-white xl:min-h-0 xl:flex-1" data-rx-card="1">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-gray-200 px-4">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-teal-700" />
          <span className="text-[14px] font-bold text-gray-900">门诊病历</span>
          <span className="rounded bg-teal-50 px-1.5 py-0.5 text-[10px] font-bold text-teal-700">中医</span>
        </div>
        <span className="text-[11px] font-medium text-gray-400">一诉五史 · 生命体征 · 四诊信息</span>
      </div>

      <div className="bg-[#F7F9FB] p-3 xl:min-h-0 xl:flex-1 xl:overflow-y-auto">
        <fieldset disabled={isRunning} aria-busy={isRunning} className="min-w-0 rounded-xl border border-gray-200 bg-white disabled:cursor-wait">
          <div className="grid border-b border-gray-200 md:grid-cols-3">
            <InputCell label="姓名" value={draft.patientName} onChange={(value) => update("patientName", value)} placeholder="可不填" testId="patient-name" />
            <InputCell label="性别" value={draft.sex} onChange={(value) => update("sex", value)} placeholder="可不填" testId="patient-sex" />
            <InputCell label="年龄" value={draft.age} onChange={(value) => update("age", value)} placeholder="如45岁/6个月" testId="patient-age" />
          </div>
          <TextareaCell label="主诉" required value={draft.zhushu} onChange={(value) => update("zhushu", value)} placeholder="核心症状 + 持续时间，例如：失眠多梦伴心悸半年" testId="chief-complaint" />
          <TextareaCell label="现病史" value={draft.xianbingshi} onChange={(value) => update("xianbingshi", value)} placeholder="起病、诱因、主要症状、伴随症状、诊治经过" testId="present-history" />
          <TextareaCell label="既往史" value={draft.jiwangshi} onChange={(value) => update("jiwangshi", value)} placeholder="慢病、手术外伤、传染病、家族相关信息可在补充说明中展开" testId="past-history" />
          <TextareaCell label="过敏史" value={draft.allergyHistory} onChange={(value) => update("allergyHistory", value)} placeholder="否认过敏 / 具体药物或食物过敏及反应" testId="allergy-history" />
          <TextareaCell label="用药史" value={draft.medicationHistory} onChange={(value) => update("medicationHistory", value)} placeholder="当前中药、中成药、西药、保健品及剂量频次" testId="medication-history" />
          <SelectCell
            label="流派偏好"
            value={draft.tcmLineagePreference}
            onChange={(value) => update("tcmLineagePreference", value)}
            options={TCM_LINEAGE_SELECT_OPTIONS}
            testId="tcm-lineage"
          />
          <div className="border-b border-gray-200 bg-sky-50/60 px-3 py-2 text-[11px] leading-relaxed text-sky-900 sm:px-[96px]">
            {(() => {
              const card = getLineageCard(draft.tcmLineagePreference);
              const strategy = getLineageQuestionStrategy(draft.tcmLineagePreference);
              const formulas = card.representativeFormulas.length ? `示例方：${card.representativeFormulas.slice(0, 4).join("、")}。` : "";
              const focus = strategy.lineageCode !== "unrestricted" ? `问诊焦点：${strategy.inquiryFocus.slice(0, 3).join("、")}；证候锚点：${strategy.syndromeAnchors.slice(0, 3).join("、")}。` : "";
              const provenance = card.provenance.representativeWorks.length ? `依据：${card.provenance.representativeWorks.slice(0, 3).join("、")}。` : "";
              return `${card.coreTheory}${formulas}${focus}${provenance} 诊疗思路用于辅助辨证，急危重风险仍需优先处置。`;
            })()}
          </div>

          <div className="border-b border-gray-200">
            <div className="flex items-center border-b border-gray-100">
              <div className="flex w-[88px] shrink-0 items-center self-stretch border-r border-gray-200 bg-gray-50 px-2 text-[12px] font-medium text-gray-700">生命体征</div>
              <div className="grid min-w-0 flex-1 grid-cols-2 gap-1 p-1.5 md:grid-cols-4">
                <input aria-label="体温" data-testid="vitals-t" value={draft.vitalsT} onChange={(event) => update("vitalsT", event.target.value.slice(0, 24))} maxLength={24} placeholder="T ℃" className="rounded border border-gray-200 px-2 py-1.5 text-[12px] outline-none focus:border-teal-400" />
                <input aria-label="脉搏" data-testid="vitals-p" value={draft.vitalsP} onChange={(event) => update("vitalsP", event.target.value.slice(0, 24))} maxLength={24} placeholder="P 次/分" className="rounded border border-gray-200 px-2 py-1.5 text-[12px] outline-none focus:border-teal-400" />
                <input aria-label="呼吸" data-testid="vitals-r" value={draft.vitalsR} onChange={(event) => update("vitalsR", event.target.value.slice(0, 24))} maxLength={24} placeholder="R 次/分" className="rounded border border-gray-200 px-2 py-1.5 text-[12px] outline-none focus:border-teal-400" />
                <input
                  aria-label="血压"
                  data-testid="vitals-bp"
                  value={draft.vitalsBP}
                  onChange={(event) => update("vitalsBP", event.target.value.slice(0, 24))}
                  maxLength={24}
                  onBlur={() => update("vitalsBP", normalizeBloodPressureInput(draft.vitalsBP))}
                  placeholder="BP 如120/80"
                  className="rounded border border-gray-200 px-2 py-1.5 text-[12px] outline-none focus:border-teal-400"
                />
              </div>
            </div>
            <div className="border-b border-gray-100 px-3 py-2 text-[11px] leading-relaxed text-gray-500 sm:px-[96px]">
              生命体征仅录入本次实测值；如未测量，请留空并按追问提示补测。
            </div>
          </div>

          <TextareaCell
            label="面象"
            value={draft.tcmFace}
            onChange={(value) => update("tcmFace", value)}
            placeholder="面色、神态、形体等；不上传面照"
            testId="tcm-face"
            actions={
              <ToggleChipPanel
                label="面象选择"
                icon={<Activity className="h-3.5 w-3.5" />}
                groups={FACE_PRESETS}
                onPick={(value) => append("tcmFace", value)}
                testId="tcm-face-preset-toggle"
              />
            }
          />
          <TextareaCell
            label="舌象"
            value={draft.tcmTongue}
            onChange={(value) => update("tcmTongue", value)}
            placeholder="舌质、舌形、苔色苔质；可上传舌照"
            testId="tcm-tongue"
            actions={
              <>
                <ToggleChipPanel
                  label="舌象选择"
                  icon={<Activity className="h-3.5 w-3.5" />}
                  groups={TONGUE_PRESETS}
                  onPick={(value) => append("tcmTongue", value)}
                  testId="tcm-tongue-preset-toggle"
                />
                <input ref={tongueInputRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" disabled={isRunning} onChange={onImageChange} />
                <button
                  type="button"
                  data-testid="tongue-capture-open"
                  onClick={onOpenTongueCapture}
                  disabled={isRunning}
                  className={`inline-flex h-8 items-center gap-1 rounded border px-2 text-[12px] font-bold transition-colors ${
                    tongueImage ? "border-teal-200 bg-teal-50 text-teal-700" : "border-gray-200 bg-gray-50 text-gray-700 hover:bg-gray-100"
                  } disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-300`}
                  title="打开舌诊采集"
                >
                  <ImageIcon className="h-3.5 w-3.5" />
                  舌诊采集
                </button>
              </>
            }
          />
          <TextareaCell
            label="脉象"
            value={draft.tcmPulse}
            onChange={(value) => update("tcmPulse", value)}
            placeholder="脉象手动录入或点选"
            testId="tcm-pulse"
            actions={
              <ToggleChipPanel
                label="脉象选择"
                icon={<Activity className="h-3.5 w-3.5" />}
                groups={PULSE_PRESETS}
                onPick={(value) => append("tcmPulse", value)}
                testId="tcm-pulse-preset-toggle"
              />
            }
          />
          {tonguePulseConflict.swapped && (
            <div data-testid="tongue-pulse-conflict" className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-900 sm:px-[96px]">
              <span>检测到舌象和脉象内容可能填反，请复核后再进入推理。</span>
              <button
                type="button"
                onClick={() => setDraft((prev) => ({ ...prev, tcmTongue: prev.tcmPulse, tcmPulse: prev.tcmTongue }))}
                className="rounded border border-amber-300 bg-white px-2.5 py-1 font-bold text-amber-800 hover:bg-amber-100"
              >
                交换舌脉内容
              </button>
            </div>
          )}
          {tongueImage && (
            <div className="flex items-center gap-3 border-b border-gray-200 bg-teal-50/40 px-3 py-2 sm:px-[96px]">
              <div className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={tongueImage} alt="舌象" className="h-14 w-14 rounded-md border object-cover" />
                <button
                  type="button"
                  onClick={onClearTongueImage}
                  disabled={isRunning}
                  className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-white"
                  title="移除舌照"
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </div>
              <span className="text-[12px] font-medium text-teal-700">舌照仅用于本次辅助分析；需按院内授权、审计和留存制度使用。</span>
            </div>
          )}
          {uploadNotice && (
            <div className="border-b border-gray-200 bg-amber-50 px-3 py-2 text-[12px] font-medium text-amber-700 sm:px-[96px]">
              {uploadNotice}
            </div>
          )}
          <TextareaCell
            label="问诊补充"
            value={draft.tcmDetail}
            onChange={(value) => update("tcmDetail", value)}
            placeholder="寒热汗出、饮食二便、睡眠情志、疼痛性质、腹诊等；闻诊模块本轮暂不启用"
            testId="tcm-detail"
            actions={
              <ToggleChipPanel
                label="问诊选择"
                icon={<ClipboardList className="h-3.5 w-3.5" />}
                groups={TCM_DETAIL_PRESETS}
                onPick={(value) => append("tcmDetail", value)}
              />
            }
          />
          <TextareaCell label="辅助检查" value={draft.fuzhuJiancha} onChange={(value) => update("fuzhuJiancha", value)} placeholder="检验检查结果；没有可不填" testId="aux-exam" />
        </fieldset>
      </div>
    </section>
  );
}

function AiSupportPanel({
  caseState,
  isRunning,
  canCancelRun,
  isCancelling,
  runningElapsedSeconds,
  currentStreaming,
  visibleConversation,
  hasUnsubmittedRecordChange,
  selectedQuestionOptions,
  freeTextAnswer,
  onFreeTextAnswerChange,
  onOption,
  onDetailAnswer,
  onSubmitAnswer,
  onSkipFollowup,
  canSkipFollowup,
  onRetry,
  onCancelRun,
  onDownloadReport,
  onAcceptEditedPrescription,
  onConfirmEncounterScope,
  onRunReasoning,
  canRunReasoning,
  submitHint,
  restoredUnsavedDraft,
  onUnsavedDraftChange,
}: {
  caseState: CaseState;
  isRunning: boolean;
  canCancelRun: boolean;
  isCancelling: boolean;
  runningElapsedSeconds: number;
  currentStreaming: string;
  visibleConversation: CaseState["conversation"];
  hasUnsubmittedRecordChange: boolean;
  selectedQuestionOptions: Record<string, QuestionOptionSelection>;
  freeTextAnswer: string;
  onFreeTextAnswerChange: (value: string) => void;
  onOption: (selection: QuestionOptionSelection) => void;
  onDetailAnswer: (item: QuestionItem, value: string) => void;
  onSubmitAnswer: () => void;
  onSkipFollowup?: () => void;
  canSkipFollowup: boolean;
  onRetry: () => void;
  onCancelRun: () => void;
  onDownloadReport: () => void;
  onAcceptEditedPrescription: (accepted: AcceptedEditedPrescription) => Promise<void>;
  onConfirmEncounterScope: () => Promise<void>;
  onRunReasoning: () => void;
  canRunReasoning: boolean;
  submitHint?: string;
  restoredUnsavedDraft?: WorkbenchUnsavedDraftFlag | null;
  onUnsavedDraftChange?: (flag: WorkbenchUnsavedDraftFlag | null) => void;
}) {
  const hasDecisionResults = Boolean(caseState.diagnosis || caseState.prescription || caseState.riskAssessment);
  const isFollowupOnlyState =
    !caseState.prescription &&
    !caseState.riskAssessment &&
    (
      caseState.phase === "question" ||
      isDifferentiationLimitedTerminalCase(caseState)
    );
  const hasAnalyzedClinicalState =
    hasDecisionResults ||
    ["question", "diagnose", "prescribe", "assess", "done", "error"].includes(caseState.phase);
  const hasStaleClinicalOutput = hasAnalyzedClinicalState && hasUnsubmittedRecordChange && !isRunning;
  // A failed prescribe/assess stage renders its own failed panel (reason + retry) inside the
  // results flow below; suppress the panel-top card there so the retry is not rendered twice.
  // The condition must mirror exactly the path that renders ResultTabsV2, otherwise neither
  // surface would appear (red-flag view, stale output, follow-up-only state, or no reasoning).
  const stageErrorCoveredInFlow =
    caseState.phase === "error" &&
    Boolean(caseState.lastError && ["prescribe", "assess"].includes(caseState.lastError.phase)) &&
    hasDecisionResults && !hasStaleClinicalOutput && !isFollowupOnlyState &&
    (caseState.safetyGate || evaluateSafetyGate(caseState)).status !== "red_flag" &&
    Boolean(mergeReasoningStages(diagnoseReasoningFromState(caseState), prescribeReasoningFromState(caseState)) || caseState.reasoningV2);
  const shouldShowStreamingPreview =
    isRunning &&
    ["diagnose", "prescribe", "assess"].includes(caseState.phase) &&
    currentStreaming.trim().length > 0;
  const shouldShowPreviousResult = Boolean(caseState.previousResult) &&
    (isRunning || caseState.phase === "error" || !hasDecisionResults);
  const latestAssistantQuestion = [...visibleConversation].reverse().find((msg) => msg.role === "assistant" && parseQuestionItems(msg.content).length > 0)?.content;
  const questionContent = caseState.phase === "question" && parseQuestionItems(currentStreaming).length > 0
    ? currentStreaming
    : latestAssistantQuestion ?? (caseState.phase === "question" ? "" : undefined);
  const requiredQuestionItems: QuestionItem[] = [];
  const questionContentForDisplay = questionContent ?? (requiredQuestionItems.length > 0 ? "" : undefined);
  const shouldShowFollowupQuestionCard =
    !hasStaleClinicalOutput &&
    isFollowupOnlyState &&
    !isRunning &&
    questionContentForDisplay !== undefined;
  const followupQuestionCard = shouldShowFollowupQuestionCard ? (
    <div className="space-y-2">
      <QuestionPromptCard
        content={questionContentForDisplay}
        onOption={onOption}
        onDetailAnswer={onDetailAnswer}
        selectedOptions={selectedQuestionOptions}
        freeText={freeTextAnswer}
        onFreeTextChange={onFreeTextAnswerChange}
        onSubmitAnswer={onSubmitAnswer}
        canSubmitAnswer={canRunReasoning}
        submitHint={submitHint}
        isRunning={isRunning}
        requiredItems={requiredQuestionItems}
      />
      {onSkipFollowup && (
        <button
          type="button"
          onClick={onSkipFollowup}
          disabled={isRunning || !canSkipFollowup}
          className="w-full rounded-lg border border-dashed border-gray-300 bg-white px-3 py-2 text-xs text-gray-500 transition-colors hover:border-gray-400 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {canSkipFollowup
            ? "暂不补充，按现有信息继续推理"
            : "请先填写主诉后继续"}
        </button>
      )}
    </div>
  ) : null;

  return (
    <aside id="cdss-section-ai-panel" className="flex flex-col overflow-hidden rounded-xl border border-gray-200 bg-white xl:min-h-0 xl:w-[410px] 2xl:w-[460px]">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-gray-200 px-4">
        <div className="flex items-center gap-2">
          <Brain className="h-4 w-4 text-teal-700" />
          <span className="text-[14px] font-bold text-teal-700">中医辅助诊疗报告</span>
        </div>
        <button
          type="button"
          onClick={onDownloadReport}
          className="inline-flex items-center gap-1 rounded-md border border-gray-200 px-2 py-1 text-[11px] font-bold text-gray-500 hover:bg-gray-50"
          title="下载完整报告"
        >
          <Download className="h-3 w-3" />
          报告
        </button>
      </div>
      <TopProgress caseState={caseState} />

      <div className="flex flex-col bg-[#F7F9FB] p-3 xl:min-h-0 xl:flex-1 xl:overflow-y-auto">
        {caseState.phase === "error" && !isRunning && !stageErrorCoveredInFlow && (
          <StageErrorCard caseState={caseState} onRetry={onRetry} />
        )}

        {hasStaleClinicalOutput && (
          <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 p-4">
            <div className="flex items-start gap-3">
              <RefreshCw className="mt-0.5 h-4 w-4 text-amber-700" />
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-bold text-amber-900">病历已修改，等待重新分析</p>
                <p className="mt-1 text-[12px] leading-relaxed text-amber-800">
                  当前上一版分析结论仍对应旧病历；点击后将重新完成风险排查、资料完整性评估、诊断和处方生成。
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onRunReasoning}
              disabled={!canRunReasoning}
              className="mt-4 inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-teal-600 px-4 py-2 text-[13px] font-bold text-white hover:bg-teal-700 disabled:cursor-not-allowed disabled:bg-gray-300"
            >
              <Brain className="h-4 w-4" />
              重新辅助推理
            </button>
            {submitHint && <p className="mt-2 text-center text-[11px] font-medium text-amber-700">{submitHint}</p>}
          </div>
        )}

        {hasAnalyzedClinicalState && !hasStaleClinicalOutput && (
          <div className="mb-3">
            <RiskSummaryPanel caseState={caseState} followupQuestionCard={followupQuestionCard} />
          </div>
        )}

        {shouldShowStreamingPreview && (
          <div className="mb-3">
            <StreamingPreviewCard
              phase={caseState.phase}
              content={currentStreaming}
              runningElapsedSeconds={runningElapsedSeconds}
              canCancelRun={canCancelRun}
              isCancelling={isCancelling}
              onCancelRun={onCancelRun}
            />
          </div>
        )}

        {shouldShowPreviousResult && caseState.previousResult && (
          <PreviousResultCard result={caseState.previousResult} />
        )}

        {!hasStaleClinicalOutput && !hasDecisionResults && !isRunning && questionContentForDisplay === undefined && (
          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <div className="flex items-start gap-3">
              <MessageSquare className="mt-0.5 h-4 w-4 text-teal-700" />
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-bold text-gray-900">等待病历信息</p>
                <p className="mt-1 text-[12px] leading-relaxed text-gray-500">
                  只需填写主诉即可开始。其他病史、生命体征和四诊信息均为可选；填写越充分，判断把握度越高。必要时系统会在一轮内集中提出 1–2 个最能改变判断的问题，也可直接跳过。
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onRunReasoning}
              disabled={!canRunReasoning}
              className="mt-4 inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-teal-600 px-4 py-2 text-[13px] font-bold text-white hover:bg-teal-700 disabled:cursor-not-allowed disabled:bg-gray-300"
            >
              <Brain className="h-4 w-4" />
              执行辅助推理
            </button>
            {submitHint && <p className="mt-2 text-center text-[11px] font-medium text-amber-600">{submitHint}</p>}
          </div>
        )}

        {isRunning && caseState.phase !== "idle" && !shouldShowStreamingPreview && (
          <div className="rounded-xl border border-teal-100 bg-white p-4">
            <div className="flex items-start gap-3">
              <Loader2 className="mt-0.5 h-4 w-4 animate-spin text-teal-600" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-gray-900">
                  {caseState.phase === "collect" ? "正在整理病历与评估下一步" : generationStatus(caseState.phase).title}
                </p>
                <p className="mt-1 text-xs leading-relaxed text-gray-500">
                  {caseState.phase === "collect" ? "已同步门诊病历，系统正在决定是否需要追问或进入诊疗方案生成。" : generationStatus(caseState.phase).desc}
                </p>
                <p className="mt-1 text-[11px] font-medium text-teal-700">
                  本阶段耗时 {runningElapsedSeconds}s{runningElapsedSeconds >= 60 ? " · 本阶段仍在生成" : ""}
                </p>
              </div>
              <button
                type="button"
                data-testid="cancel-diagnosis-run"
                onClick={onCancelRun}
                disabled={!canCancelRun || isCancelling}
                className="inline-flex shrink-0 items-center gap-1 rounded-md border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-[11px] font-bold text-rose-700 transition-colors hover:bg-rose-100 disabled:cursor-wait disabled:opacity-60"
              >
                {isCancelling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
                {isCancelling ? "正在取消" : "取消运行"}
              </button>
            </div>
          </div>
        )}

        {hasDecisionResults && !hasStaleClinicalOutput && !isFollowupOnlyState && (
          <CompactAiSchemeCardFlow caseState={caseState} onRetry={onRetry} onAcceptEditedPrescription={onAcceptEditedPrescription} onConfirmEncounterScope={onConfirmEncounterScope} restoredUnsavedDraft={restoredUnsavedDraft} onUnsavedDraftChange={onUnsavedDraftChange} />
        )}
      </div>
    </aside>
  );
}

function sanitizeStreamingPreview(content: string, phase: Phase): string {
  let next = sanitizeLabeledEvidenceLines(
    sanitizeCustomerEvidenceSurface(content
      .replace(/https?:\/\/[^\s)）\]，。；;]+/g, "")
      .replace(/<<<CDSS_STREAM(?:_FINAL)?(?:>>>)?/g, "")),
    () => false,
  );
  // The sentinel object is an internal contract, not a clinician-facing stream. Remove the full
  // block and also an in-progress tail after START before ReactMarkdown sees it.
  next = next
    .replace(/<!-- DIAGNOSIS_JSON_START -->[\s\S]*?<!-- DIAGNOSIS_JSON_END -->/g, "")
    .replace(/<!-- DIAGNOSIS_JSON_START -->[\s\S]*$/g, "")
    .replace(/<!-- DIAGNOSIS_JSON_END -->/g, "")
    .trim();
  if (phase === "diagnose") return sanitizeDiagnoseStreamingDraft(next);
  if (phase !== "prescribe") return next;
  // Preserve the candidate structure and medicine names during streaming so the section does not
  // appear to vanish. Only unfinalized dosage fragments are masked until evidence normalization
  // and the independent medication audit have completed.
  return next.replace(
    /((?:[\u4e00-\u9fa5A-Za-z0-9]+(?:片|胶囊|丸|滴丸|颗粒|注射液|口服液|散|膏|合剂|糖浆))[^。\n]{0,40}?)(?:每次|一次|每日|每天|bid|tid|qd|\d+\s*(?:片|粒|丸|袋|支|ml|mL|g|mg))[^。\n]*/gi,
    "$1用法用量待最终核验",
  );
}

function StreamingPreviewCard({
  phase,
  content,
  runningElapsedSeconds,
  canCancelRun,
  isCancelling,
  onCancelRun,
}: {
  phase: Phase;
  content: string;
  runningElapsedSeconds: number;
  canCancelRun: boolean;
  isCancelling: boolean;
  onCancelRun: () => void;
}) {
  const status = generationStatus(phase);
  const safePreview = sanitizeStreamingPreview(content, phase);
  return (
    <div data-testid="streaming-preview-card" className="rounded-xl border border-teal-100 bg-white p-4">
      <div className="mb-3 flex items-start gap-3">
        <Loader2 className="mt-0.5 h-4 w-4 animate-spin text-teal-600" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-gray-900">{status.title}</p>
          <p className="mt-1 text-xs leading-relaxed text-gray-500">
            {phase === "prescribe"
              ? "处方包含药味与剂量，完整通过病机对应、剂量、煎法和出处校验后才会展示；当前卡片会持续更新生成进度。"
              : phase === "assess"
                ? "正在同步合理用药风险提示并生成随访计划；审方暂不可用时仍会完成报告，不阻断医生继续审阅。"
                : "正在生成并校验辨病辨证结果；结构、临床事实与证据全部通过后将一次性展示。"}
          </p>
          <p className="mt-1 text-[11px] font-medium text-teal-700">本阶段耗时 {runningElapsedSeconds}s</p>
        </div>
        <button
          type="button"
          data-testid="cancel-diagnosis-run"
          onClick={onCancelRun}
          disabled={!canCancelRun || isCancelling}
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-[11px] font-bold text-rose-700 transition-colors hover:bg-rose-100 disabled:cursor-wait disabled:opacity-60"
        >
          {isCancelling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
          {isCancelling ? "正在取消" : "取消运行"}
        </button>
      </div>
      <div className="max-h-[360px] overflow-y-auto rounded-lg border border-gray-100 bg-gray-50 px-3 py-2">
        <MarkdownBlock content={compactMarkdown(safePreview, 2600)} compact />
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function DiagnosisPage() {
  const [caseState, setCaseState] = useState<CaseState>(newCase);
  const [recordDraft, setRecordDraft] = useState<HisRecordDraft>(createEmptyHisRecordDraft);
  const [input, setInput] = useState("");
  const [selectedQuestionOptions, setSelectedQuestionOptions] = useState<Record<string, QuestionOptionSelection>>({});
  const selectedQuestionOptionsRef = useRef<Record<string, QuestionOptionSelection>>({});
  const [isRunning, setIsRunning] = useState(false);
  const runningRef = useRef(false);
  const [runningStageClock, setRunningStageClock] = useState<RunningStageClock | null>(null);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [runCancelRequested, setRunCancelRequested] = useState(false);
  const [streaming, setStreaming] = useState<StreamingState>({});
  const [workspaceRestored, setWorkspaceRestored] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [tongueImage, setTongueImage] = useState<string | null>(null);
  const [tongueImageConsent, setTongueImageConsent] = useState(false);
  const [uploadNotice, setUploadNotice] = useState("");
  const [captureModal, setCaptureModal] = useState<"tongue" | null>(null);
  const [pendingNewCaseConfirm, setPendingNewCaseConfirm] = useState(false);
  const [workbenchUnsavedDraft, setWorkbenchUnsavedDraft] = useState<WorkbenchUnsavedDraftFlag | null>(null);
  const tongueInputRef = useRef<HTMLInputElement>(null);
  const activeCaseIdRef = useRef(caseState.id);
  const hasInProgressWorkRef = useRef(false);
  const workspaceRestoreGenerationRef = useRef(0);

  const commitSelectedQuestionOptions = useCallback((next: Record<string, QuestionOptionSelection>) => {
    selectedQuestionOptionsRef.current = next;
    setSelectedQuestionOptions(next);
  }, []);

  const setRunning = useCallback((value: boolean) => {
    runningRef.current = value;
    setIsRunning(value);
  }, []);

  useEffect(() => {
    activeCaseIdRef.current = caseState.id;
  }, [caseState.id]);

  useEffect(() => {
    if (!isRunning) {
      setRunningStageClock(null);
      setRunCancelRequested(false);
      return;
    }
    const now = Date.now();
    setClockNow(now);
    setRunningStageClock((current) => nextRunningStageClock(current, caseState.phase, now));
  }, [caseState.phase, isRunning]);

  useEffect(() => {
    if (!isRunning) return;
    const timer = window.setInterval(() => setClockNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isRunning]);

  // Restore the last encrypted local workspace on mount. Image bytes are intentionally never restored.
  useEffect(() => {
    const generation = ++workspaceRestoreGenerationRef.current;
    void (async () => {
      try {
        const workspace = await loadWorkspaceSnapshot();
        if (workspaceRestoreGenerationRef.current !== generation) return;
        if (workspace) {
          const restoredCase = recoverInterruptedRun(workspace.caseState, workspace.runningPhase);
          activeCaseIdRef.current = restoredCase.id;
          setCaseState(restoredCase);
          setRecordDraft(workspace.recordDraft);
          setInput(workspace.input);
          commitSelectedQuestionOptions(workspace.selectedQuestionOptions);
          setWorkbenchUnsavedDraft(workspace.workbenchDraft ?? null);
          setLastSavedAt(workspace.updatedAt);
        } else {
          loadLatestCase();
        }
      } finally {
        if (workspaceRestoreGenerationRef.current === generation) setWorkspaceRestored(true);
      }
    })();
    return () => {
      if (workspaceRestoreGenerationRef.current === generation) workspaceRestoreGenerationRef.current += 1;
    };
  }, [commitSelectedQuestionOptions]);

  const setStreamingForPhase = useCallback((phase: Phase, text: string) => {
    setStreaming((prev) => ({ ...prev, [phase]: text }));
  }, []);

  const persistState = useCallback((state: CaseState) => {
    if (state.id !== activeCaseIdRef.current) return;
    setCaseState(state);
    saveCase(state);
  }, []);

  const handleWorkbenchUnsavedDraftChange = useCallback((flag: WorkbenchUnsavedDraftFlag | null) => {
    setWorkbenchUnsavedDraft((current) => {
      if (current === flag) return current;
      if (!current || !flag) return flag;
      if (current.caseId === flag.caseId &&
        current.candidateIndex === flag.candidateIndex &&
        current.unsavedAt === flag.unsavedAt) return current;
      return flag;
    });
  }, []);

  const hasInProgressWork = useMemo(
    () =>
      isRunning ||
      Boolean(input.trim()) ||
      Object.keys(selectedQuestionOptions).length > 0 ||
      Boolean(tongueImage) ||
      hasAnyDraftInput(recordDraft) ||
      caseState.phase !== "idle" ||
      Boolean(caseState.diagnosis || caseState.prescription || caseState.riskAssessment),
    [caseState, input, isRunning, recordDraft, selectedQuestionOptions, tongueImage],
  );

  useEffect(() => {
    if (!workspaceRestored) return;
    if (!hasInProgressWork && !hasAnyDraftInput(recordDraft) && !input.trim()) return;
    const timer = window.setTimeout(() => {
      void saveWorkspaceSnapshot({
        caseState,
        recordDraft,
        input,
        selectedQuestionOptions,
        runningPhase: isRunning ? caseState.phase : undefined,
        workbenchDraft: workbenchUnsavedDraft,
      }).then((savedAt) => {
        if (savedAt) setLastSavedAt(savedAt);
      });
      saveCase(caseState);
    }, 150);
    return () => window.clearTimeout(timer);
  }, [caseState, hasInProgressWork, input, isRunning, recordDraft, selectedQuestionOptions, workbenchUnsavedDraft, workspaceRestored]);

  useEffect(() => {
    hasInProgressWorkRef.current = hasInProgressWork;
  }, [hasInProgressWork]);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasInProgressWorkRef.current && !hasAnyDraftInputInDocument()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  // Cancel any in-flight M01→M05 chain when the page unmounts, to stop wasted model calls.
  useEffect(() => () => {
    activeRunAbortController?.abort();
    activeRunAbortController = null;
  }, []);

  const handleCancelRun = useCallback(() => {
    if (!runningRef.current || !isRunning || runCancelRequested) return;
    if (abortDiagnosisRun(activeRunAbortController)) setRunCancelRequested(true);
  }, [isRunning, runCancelRequested]);

  async function handleImageUpload(
    e: React.ChangeEvent<HTMLInputElement>,
    setter: (val: string | null) => void
  ) {
    const file = e.target.files?.[0];
    try {
      if (!file) return;
      if (isRunning) {
        setUploadNotice("推理运行中暂不支持更换舌照，请等待本轮完成后再上传。");
        return;
      }
      if (!ALLOWED_TONGUE_IMAGE_TYPES.has(file.type)) {
        setUploadNotice("仅支持 PNG、JPEG 或 WebP 舌象位图。");
        return;
      }
      if (file.size > MAX_TONGUE_IMAGE_INPUT_BYTES) {
        setUploadNotice("舌照文件过大，请先压缩至8MB以内再上传。");
        return;
      }
      if (!await isTongueVisionAvailable()) {
        setter(null);
        setUploadNotice("当前未启用舌照识别服务，请在舌象栏手动录入舌质、舌形和舌苔后提交。");
        return;
      }
      const { base64, roiMethod } = await fileToCompressedBase64(file);
      setter(base64);
      setUploadNotice(
        roiMethod === "detected"
          ? "舌照已按检测到的舌体/口唇区域裁切与压缩；请确认预览中舌尖、舌边和舌根区域完整可见。"
          : "舌照已按中心区域保守裁切与压缩，请确认舌体完整：预览中舌尖、舌边和舌根区域需完整可见。",
      );
    } catch {
      setUploadNotice("舌照读取或压缩失败，请更换图片后重试。");
    } finally {
      e.target.value = "";
    }
  }

  // ─── M03→M04→M05 chain ──────────────────────────────────────────────────────
  // Defined before runCollect so it can be referenced in runCollect's closure.

  const runDiagnoseChain = useCallback(async (state: CaseState): Promise<void> => {
    let current = await refreshClinicalSafetyFacts(state);
    // Only a missing chief complaint prevents starting the chain. Optional-history gaps and positive
    // safety findings remain visible advisories while the doctor-facing report continues downstream.
    if (!canEnterDiagnosisChain(current) && current.skipDifferentiationGate !== true) {
      persistState(applyDifferentiationGateOutcome(current));
      return;
    }
    const needsDiagnose = current.phase === "diagnose" || !hasExecutableM03Diagnosis(current);
    const needsPrescribe = needsDiagnose || current.phase === "prescribe" || !current.prescription;

    if (needsDiagnose) {
      try {
        setStreamingForPhase("diagnose", "");
        const res3 = await fetchWithTimeout(apiUrl("/api/diagnosis/diagnose"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ caseState: current }),
        });
        if (!res3.ok) throw new Error(await readErrorMessage(res3, `辨病辨证生成失败 (${res3.status})`));
        const rawDiagnosis = await consumeMarkdownStream(res3, (t) => setStreamingForPhase("diagnose", t), streamConsumeOptions());
        const diagnosisTruncated =
          rawDiagnosis.includes("[TRUNCATED]") ||
          !rawDiagnosis.includes("<!-- DIAGNOSIS_JSON_START -->") ||
          !rawDiagnosis.includes("<!-- DIAGNOSIS_JSON_END -->");
        const parsedDiagnosisReasoningV2 = parseReasoningV2(rawDiagnosis);
        const diagnosisReasoningV2 = parsedDiagnosisReasoningV2?.stage === "diagnose" ? parsedDiagnosisReasoningV2 : undefined;
        if (diagnosisTruncated || !diagnosisReasoningV2) {
          const visibleDraft = sanitizeDiagnoseStreamingDraft(
            stripDiagnosisJSON(rawDiagnosis).replace(/\[TRUNCATED\]/g, "").trim(),
          );
          persistState(setError(
            { ...current, phase: "diagnose", diagnosis: visibleDraft || current.diagnosis, reasoningDiagnose: undefined },
            "辨病辨证本次未完整生成。已保留可见草稿，重新生成本节即可继续；已录入病历不会丢失。",
          ));
          return;
        }
        const diagnosis = sanitizeDiagnoseStreamingDraft(stripDiagnosisJSON(rawDiagnosis));
        const nextDiagnoseReasoning = diagnosisReasoningV2 || diagnoseReasoningFromState(current);
        current = withSafetyGate({
          ...current,
          diagnosis,
          reasoningDiagnose: nextDiagnoseReasoning,
          reasoningV2: mergeReasoningStages(nextDiagnoseReasoning, prescribeReasoningFromState(current)),
          // 保留 skipDifferentiationGate：医生"跳过追问"的意图需跨过 M03 一直生效到 M04，否则链条会在此断掉。
          // 它在 M04 成功(见下方 assess 前)或流程失败回弹时清除，且持久化时被剥离，不会残留。
          phase: "prescribe",
        });
        if (!canEnterDosePrescriptionChain(current)) {
          persistState(applyDifferentiationGateOutcome({ ...current, skipDifferentiationGate: undefined }));
          return;
        }
        // The structured M03 contract above is authoritative. Limited prose detection is retained
        // only for legacy snapshots and must not reclassify this newly validated response.
        persistState(current);
      } catch (e) {
        persistState(setError(current, normalizeRequestError(e, "辨病辨证失败")));
        return;
      }
    }

    if (needsPrescribe && (!hasExecutableM03Diagnosis(current) || !canEnterDosePrescriptionChain(current))) {
      persistState(applyDifferentiationGateOutcome({ ...current, prescription: undefined, riskAssessment: undefined, reasoningPrescribe: undefined, skipDifferentiationGate: undefined }));
      return;
    }

    if (needsPrescribe) {
      try {
        setStreamingForPhase("prescribe", "");
        const res4 = await fetchWithTimeout(apiUrl("/api/diagnosis/prescribe"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ caseState: current }),
        });
        if (!res4.ok) throw new Error(await readErrorMessage(res4, `候选方药生成失败 (${res4.status})`));
        const rawPrescription = await consumeMarkdownStream(res4, (t) => setStreamingForPhase("prescribe", t), streamConsumeOptions());
        const expectedNonDoseLimitedPrescription =
          rawPrescription.includes("<!-- CDSS_NON_DOSE_PRESCRIPTION -->") &&
          /不展示剂量级候选方药|不生成中药饮片剂量/.test(rawPrescription) &&
          !/\d+(?:\.\d+)?\s*(?:g|mg|克|毫克|毫升|mL)\b/i.test(rawPrescription);
        const prescriptionTransportIncomplete =
          rawPrescription.includes("[TRUNCATED]") ||
          !rawPrescription.includes("<!-- DIAGNOSIS_JSON_START -->") ||
          !rawPrescription.includes("<!-- DIAGNOSIS_JSON_END -->");
        const parsedPrescriptionReasoningV2 = prescriptionTransportIncomplete ? undefined : parseReasoningV2(rawPrescription);
        const prescriptionReasoningV2 = parsedPrescriptionReasoningV2?.stage === "prescribe" ? parsedPrescriptionReasoningV2 : undefined;
        const prescriptionContractInvalid = !expectedNonDoseLimitedPrescription && (prescriptionTransportIncomplete || !prescriptionReasoningV2);
        const mergedReasoningV2 = mergeReasoningStages(diagnoseReasoningFromState(current), prescriptionReasoningV2);
        const truncatedGate: SafetyGate = {
          status: "needs_information",
          allowDiagnosis: true,
          allowDosePrescription: false,
          action: "complete_before_prescription",
          missingItems: ["候选方药完整性"],
          redFlags: [],
          reasons: ["候选方药生成被截断或药味表未闭合，系统未展示半截处方。"],
        };
        const prescription = expectedNonDoseLimitedPrescription
          ? stripDiagnosisJSON(rawPrescription).replace("<!-- CDSS_NON_DOSE_PRESCRIPTION -->", "").replace(/\[TRUNCATED\]/g, "").trim()
          : prescriptionContractInvalid
          ? [
              "## 候选方药生成状态",
              "本次未形成可核验的完整药味与剂量，因此没有展示半截处方。已完成的辨病辨证仍保留，可直接重新生成候选方药。",
              "",
              buildSafetyLimitedPrescription(truncatedGate),
            ].join("\n")
          : stripDiagnosisJSON(rawPrescription).replace(/\[TRUNCATED\]/g, "").trim();
        if (prescriptionContractInvalid) {
          persistState(setError(
            { ...current, prescription, reasoningPrescribe: undefined, phase: "prescribe" },
            "候选方药本次未完整生成。请重新生成该板块；辨病辨证和已录入病历均已保留。",
          ));
          return;
        }
        current = withSafetyGate({
          ...current,
          prescription,
          reasoningPrescribe: prescriptionReasoningV2,
          reasoningV2: mergedReasoningV2 || current.reasoningV2,
          riskAssessment: undefined,
          // Optional-history gaps and a deliberate one-round skip lower confidence but do not lock
          // the report workflow. Positive safety findings remain visible and HIS adoption is governed
          // separately from candidate generation.
          safetyLocked: false,
          phase: "assess",
        });
        current = { ...current, safetyLocked: deriveSafetyLocked(current) };
        persistState(current);
      } catch (e) {
        persistState(setError(current, normalizeRequestError(e, "候选方药生成失败")));
        return;
      }
    }

    // M05
    // The assess route fail-closes (409) unless the current chain carries a signed M04 reasoning
    // contract. A non-dose M04 result (safety-limited, encounter-scope gated, or otherwise degraded)
    // has no such contract, so calling M05 would produce a guaranteed 409 and a misleading
    // "正在生成风险随访提示" spinner. Skip the doomed call and land directly on the same
    // deterministic follow-up terminal state the M05 error path below already produces.
    if (!prescribeReasoningFromState(current)) {
      const nonDoseRiskAssessment = replaceRiskAssessmentFollowup(
        current.riskAssessment,
        buildDeterministicRiskFollowup(current),
      );
      persistState(withSafetyGate({
        ...current,
        riskAssessment: nonDoseRiskAssessment,
        auditAdvisory: { available: false, reason: "no_prescription_items" },
        skipDifferentiationGate: undefined,
        phase: "done",
        previousResult: undefined,
        lastError: undefined,
      }));
      return;
    }
    try {
      setStreamingForPhase("assess", "");
      const res5 = await fetchWithTimeout(apiUrl("/api/diagnosis/assess"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caseState: current }),
      });
      if (!res5.ok) throw new Error(await readErrorMessage(res5, `合理用药审方与随访生成失败 (${res5.status})`));
      const generatedRiskAssessment = await consumeMarkdownStream(res5, (t) => setStreamingForPhase("assess", t), streamConsumeOptions());
      const machineAuditStatus = parseRxAuditStatusMarker(generatedRiskAssessment);
      const cleanRiskAssessment = stripRxAuditStatusMarker(generatedRiskAssessment);
      const riskAssessment = replaceRiskAssessmentFollowup(current.riskAssessment, cleanRiskAssessment);
      const noAuditItems = machineAuditStatus?.reason === "no_prescription_items" ||
        /候选方药结构尚未达到自动审方接口要求|候选方药无法形成可核验的自动审方对象|尚未形成完整药味清单/.test(cleanRiskAssessment);
      const auditUnavailable = machineAuditStatus
        ? machineAuditStatus.available === false
        : noAuditItems || /本次未完成自动用药复核|自动用药复核暂未返回结果|M05 未完成灵犀处方后审方/.test(cleanRiskAssessment);
      current = withSafetyGate({
        ...current,
        riskAssessment,
        auditAdvisory: auditUnavailable
          ? { available: false, reason: machineAuditStatus?.reason || (noAuditItems ? "no_prescription_items" : "service_unavailable") }
          : { available: true },
        skipDifferentiationGate: undefined,
        phase: "done",
        previousResult: undefined,
      });
      persistState(current);
    } catch (e) {
      if (activeRunAbortController?.signal.aborted) {
        // A cancelled M05 must land in the same failed-stage state as M03/M04: the failed panel
        // shows the actual reason with an in-panel retry, instead of leaving the 审方随访 step
        // spinning in a "running" state that no action can recover from.
        persistState(setError(current, normalizeRequestError(e, "合理用药审方与随访生成失败")));
        return;
      }
      // M05 contains an advisory external audit plus deterministic follow-up. An unavailable audit
      // must be disclosed, but it cannot strand a completed M03/M04 chain in a global error state.
      const riskAssessment = replaceRiskAssessmentFollowup(
        current.riskAssessment,
        buildDeterministicRiskFollowup(current),
      );
      persistState(withSafetyGate({
        ...current,
        riskAssessment,
        auditAdvisory: { available: false, reason: "service_unavailable" },
        skipDifferentiationGate: undefined,
        phase: "done",
        previousResult: undefined,
        lastError: undefined,
      }));
    }
  }, [persistState, setStreamingForPhase]);

  // ─── M02 question ───────────────────────────────────────────────────────────

  const runQuestion = useCallback(async (
    state: CaseState,
    opts?: { countRound?: boolean },
  ): Promise<void> => {
    setStreamingForPhase("question", "");
    try {
      const res = await fetchWithTimeout(apiUrl("/api/diagnosis/question"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caseState: state }),
      });
      if (!res.ok) throw new Error(await readErrorMessage(res, `请求失败 (${res.status})`));
      const { displayContent, jsonData } = await consumeCollectStream(res, (t) => setStreamingForPhase("question", t), streamConsumeOptions());
      const updated = withSafetyGateAndOperationalCompleteness(applyQuestionResult(state, displayContent, jsonData, { countRound: opts?.countRound }));
      if (parseQuestionItems(displayContent).length === 0) {
        const readyState = setPhase({ ...updated, questionOutcome: "not_needed" }, "diagnose");
        persistState(readyState);
        await runDiagnoseChain(readyState);
        return;
      }
      persistState(updated);
    } catch {
      if (activeRunAbortController?.signal.aborted) {
        // 医生主动取消的口径与 M03/M04/M05 一致：落为失败阶段，面板显示“推理已取消”并给出
        // 本阶段重试入口，而不是静默回到追问中状态（那会让取消看起来像仍在等待回答）。
        persistState(setError({ ...state, phase: "question" }, "推理已取消"));
        return;
      }
      // M02 improves information gain but is not a workflow dependency. Keep the free-text and skip
      // surface available so a transient question-model failure cannot become an error dead end.
      persistState({ ...state, phase: "question", lastError: undefined });
    }
  }, [persistState, runDiagnoseChain, setStreamingForPhase]);

  // ─── M01 collect ────────────────────────────────────────────────────────────
  // No setIsRunning(false) before handing off to chained functions — the chain
  // manages its own completion and sets isRunning(false) via the finally block.

  const runCollect = useCallback(async (userInput: string, state: CaseState, hisRecord?: HisRecordSnapshot): Promise<void> => {
    setRunning(true);
    setStreamingForPhase("collect", "");
    const currentState = withSafetyGate(setPhase(
      {
        ...state,
        chiefComplaint: state.chiefComplaint || hisRecord?.fields?.zhushu || userInput,
        hisRecord,
      },
      "collect",
    ));
    persistState(currentState);

    try {
      const collectOnce = async (useTongueImage: boolean) => {
        setStreamingForPhase("collect", "");
        const response = await fetchWithTimeout(apiUrl("/api/diagnosis/collect"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userInput,
            ...(useTongueImage && tongueImage ? { tongueImage } : {}),
            ...(useTongueImage && tongueImage ? { tongueImageConsent } : {}),
          }),
        });
        if (!response.ok) throw new Error(await readErrorMessage(response, `请求失败 (${response.status})`));
        return consumeCollectStream(response, (t) => {
          setStreamingForPhase("collect", t);
        }, streamConsumeOptions());
      };

      let visionUsed = Boolean(tongueImage);
      let collectResult;
      try {
        collectResult = await collectOnce(visionUsed);
      } catch (error) {
        if (activeRunAbortController?.signal.aborted) throw error;
        if (!visionUsed) throw error;
        visionUsed = false;
        setUploadNotice("舌照识别暂未返回，已保留其他病历并继续分析；舌象可稍后手动补录或重新采集。");
        collectResult = await collectOnce(false);
      }
      const { displayContent, jsonData } = collectResult;
      const collectState = visionUsed || !currentState.hisRecord
        ? currentState
        : { ...currentState, hisRecord: { ...currentState.hisRecord, tongueImageUploaded: false } };
      const collected = withSafetyGateAndOperationalCompleteness(applyCollectResult(collectState, displayContent, jsonData, userInput));
      const updated = await refreshClinicalSafetyFacts(collected);
      // Clear image base64 from React state (images are never included in encrypted snapshots)
      setTongueImage(null);
      setTongueImageConsent(false);
      setUploadNotice("");

      if (!shouldAskHighInformationFollowup(updated)) {
        const readyState = setPhase(updated, "diagnose");
        persistState(readyState);
        await runDiagnoseChain(readyState);
      } else {
        const readyState = setPhase(updated, "question");
        persistState(readyState);
        await runQuestion(readyState, { countRound: false });
      }
    } catch (e) {
      persistState(setError(currentState, normalizeRequestError(e, "病历采集分析失败")));
    } finally {
      setRunning(false);
    }
  }, [persistState, runDiagnoseChain, runQuestion, setRunning, setStreamingForPhase, tongueImage, tongueImageConsent]);

  // ─── User input handling ─────────────────────────────────────────────────────

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = input.trim();
    if (runningRef.current || isRunning) return;
    if (!hasChiefComplaintInput(recordDraft)) return;

    const submittedCaseId = caseState.id;
    setRunning(true);
    beginRunScope();
    try {
      if (caseState.phase === "idle" || caseState.phase === "collect") {
      const draftAppliedState = withSafetyGateAndOperationalCompleteness(applyDraftToCaseState(caseState, recordDraft, trimmed, Boolean(tongueImage)));
      const caseInput = draftAppliedState.hisRecord?.rawText || buildHisRecordText(recordDraft, trimmed, Boolean(tongueImage));
      if (!caseInput.trim()) return;
      if (isModelInputOverBudget(caseInput)) return;
      const hisRecord = draftAppliedState.hisRecord || buildHisRecordSnapshot(recordDraft, trimmed, Boolean(tongueImage), caseState.id);
      setInput("");
      await runCollect(caseInput, draftAppliedState, hisRecord);
    } else if (caseState.phase === "error") {
      const failedPhase = caseState.lastError?.phase || "collect";
      const retrySelections = failedPhase === "question"
        ? await interpretTypedQuestionDetails(caseState, selectedQuestionOptions)
        : selectedQuestionOptions;
      if (activeCaseIdRef.current !== submittedCaseId || activeRunAbortController?.signal.aborted) return;
      // M02 answers are projected by the typed LLM interpreter. Legacy snapshots without a typed
      // plan keep the doctor's words in conversation but never fall back to keyword field guessing.
      const directPatch = failedPhase === "question" ? {} : inferDraftPatchFromFreeText(trimmed);
      const retryDraftWithSelections = applySelectedQuestionOptionsToDraft(recordDraft, retrySelections);
      const retryDraftWithDirect = Object.keys(directPatch).length > 0
        ? mergeDraftPatch(retryDraftWithSelections, directPatch, true)
        : retryDraftWithSelections;
      const retryDraft = retryDraftWithDirect;
      if (retryDraft !== recordDraft) setRecordDraft(retryDraft);
      const draftAppliedState = withSafetyGateAndOperationalCompleteness(applyDraftToCaseState(caseState, retryDraft, trimmed, Boolean(tongueImage)));
      const hisRecord = draftAppliedState.hisRecord || buildHisRecordSnapshot(recordDraft, trimmed, Boolean(tongueImage), caseState.id);
      if (hisRecord.rawText && isModelInputOverBudget(hisRecord.rawText)) return;
      const recovered = withSafetyGateAndOperationalCompleteness({
        ...draftAppliedState,
        hisRecord,
        lastError: undefined,
      });
      setInput("");
      if (failedPhase === "collect") {
        await runCollect(hisRecord.rawText || recovered.chiefComplaint, recovered, hisRecord);
      } else if (failedPhase === "question") {
        const retryAnswer = [selectedQuestionAnswerText(retrySelections), trimmed].filter(Boolean).join("\n");
        const questionState = retryAnswer ? applyUserAnswer(recovered, retryAnswer) : recovered;
        setInput("");
        commitSelectedQuestionOptions({});
        setRunning(true);
        try {
          await runQuestion(withSafetyGateAndOperationalCompleteness(questionState), { countRound: false });
        } finally {
          setRunning(false);
        }
      } else {
        setRunning(true);
        try {
          await runDiagnoseChain(setPhase(recovered, failedPhase));
        } finally {
          setRunning(false);
        }
      }
    } else if (caseState.phase === "done" && !canContinueLimitedCase(caseState)) {
      const draftAppliedState = withSafetyGateAndOperationalCompleteness(applyDraftToCaseState(caseState, recordDraft, trimmed, Boolean(tongueImage)));
      const caseInput = draftAppliedState.hisRecord?.rawText || buildHisRecordText(recordDraft, trimmed, Boolean(tongueImage));
      if (!caseInput.trim()) return;
      if (isModelInputOverBudget(caseInput)) return;
      const hisRecord = draftAppliedState.hisRecord || buildHisRecordSnapshot(recordDraft, trimmed, Boolean(tongueImage), caseState.id);
      const rerunState = withSafetyGateAndOperationalCompleteness({
        ...draftAppliedState,
        previousResult: capturePreviousResult(draftAppliedState),
        conversation: [],
        diagnosis: undefined,
        prescription: undefined,
        riskAssessment: undefined,
        lastError: undefined,
        questionRounds: 0,
      });
      setInput("");
      await runCollect(caseInput, rerunState, hisRecord);
    } else if (caseState.phase === "question" || canContinueLimitedCase(caseState)) {
      const submissionSelections = await interpretTypedQuestionDetails(caseState, selectedQuestionOptions);
      if (activeCaseIdRef.current !== submittedCaseId || activeRunAbortController?.signal.aborted) return;
      const submissionAnswer = selectedQuestionAnswerText(submissionSelections);
      const directPatch: Partial<HisRecordDraft> = {};
      const draftWithSelections = applySelectedQuestionOptionsToDraft(recordDraft, submissionSelections);
      const draftWithDirectFields = Object.keys(directPatch).length > 0
        ? mergeDraftPatch(draftWithSelections, directPatch, true)
        : draftWithSelections;
      const draftForSubmit = draftWithDirectFields;
      if (draftForSubmit !== recordDraft) setRecordDraft(draftForSubmit);
      const hasRecordChange = hasQuestionRecordChange(draftForSubmit, caseState.hisRecord, Boolean(tongueImage), caseState.id);
      if (!trimmed && !hasRecordChange && !submissionAnswer) return;
      const draftAppliedState = withSafetyGateAndOperationalCompleteness(applyDraftToCaseState(caseState, draftForSubmit, trimmed, Boolean(tongueImage)));
      const hisRecord = draftAppliedState.hisRecord || caseState.hisRecord;
      if (hisRecord?.rawText && isModelInputOverBudget(hisRecord.rawText)) return;
      const recordSupplement = hasRecordChange && hisRecord?.rawText.trim() ? `本轮病历补充：\n${hisRecord.rawText}` : "";
      const combinedAnswer = [submissionAnswer, hasRecordChange ? recordSupplement : trimmed].filter(Boolean).join("\n\n");
      if (isModelInputOverBudget(combinedAnswer)) return;
      if (draftAppliedState.safetyGate?.status === "needs_information") {
        setInput("");
        commitSelectedQuestionOptions({});
        const answered = combinedAnswer.trim()
          ? applyUserAnswer({ ...draftAppliedState, hisRecord }, combinedAnswer)
          : draftAppliedState;
        const updated: CaseState = {
          ...answered,
          questionRounds: Math.min(answered.maxQuestionRounds, answered.questionRounds + 1),
          questionOutcome: "answered",
        };
        const nextState = await refreshClinicalSafetyFacts(withSafetyGateAndOperationalCompleteness(updated));
        if (nextState.safetyGate?.status === "red_flag") {
          const readyState = setPhase({
            ...nextState,
            previousResult: capturePreviousResult(nextState),
            diagnosis: undefined,
            prescription: undefined,
            riskAssessment: undefined,
          }, "diagnose");
          persistState(readyState);
          setRunning(true);
          try {
            await runDiagnoseChain(readyState);
          } finally {
            setRunning(false);
          }
          return;
        }
        if (canEnterDiagnosisChain(nextState)) {
          const readyState = setPhase({
            ...nextState,
            previousResult: capturePreviousResult(nextState),
            diagnosis: undefined,
            prescription: undefined,
            riskAssessment: undefined,
          }, "diagnose");
          persistState(readyState);
          setRunning(true);
          try {
            await runDiagnoseChain(readyState);
          } finally {
            setRunning(false);
          }
        } else {
          persistState(applyDifferentiationGateOutcome(nextState));
        }
        return;
      }
      if (!combinedAnswer.trim()) return;
      setInput("");
      commitSelectedQuestionOptions({});
      const answered = applyUserAnswer({ ...draftAppliedState, hisRecord }, combinedAnswer);
      const updated: CaseState = {
        ...answered,
        questionRounds: Math.min(answered.maxQuestionRounds, answered.questionRounds + 1),
        questionOutcome: "answered",
      };
      const reassessBase = await refreshClinicalSafetyFacts(withSafetyGateAndOperationalCompleteness({
        ...updated,
        previousResult: capturePreviousResult(updated),
        diagnosis: undefined,
        prescription: undefined,
        riskAssessment: undefined,
      }));
      if (reassessBase.safetyGate?.status === "red_flag") {
        const readyState = setPhase(reassessBase, "diagnose");
        persistState(readyState);
        setRunning(true);
        try {
          await runDiagnoseChain(readyState);
        } finally {
          setRunning(false);
        }
        return;
      }
      setRunning(true);
      try {
        if (canEnterDiagnosisChain(reassessBase)) {
          const readyState = setPhase(reassessBase, "diagnose");
          persistState(readyState);
          await runDiagnoseChain(readyState);
        } else {
          persistState(applyDifferentiationGateOutcome(reassessBase));
        }
      } finally {
        setRunning(false);
      }
    }
    } finally {
      setRunning(false);
    }
  }

  async function handleRetry() {
    if (runningRef.current || isRunning || !caseState.lastError) return;
    const failedPhase = caseState.lastError.phase;
    // Guard: only retry known active phases
    if (!VALID_PHASES.includes(failedPhase)) return;

    setRunning(true);
    beginRunScope();
    const submittedCaseId = caseState.id;
    let recovered = caseState;
    let retryPhase: Phase = failedPhase;
    try {
        const supplemental = input.trim();
        const retrySelections = failedPhase === "question"
          ? await interpretTypedQuestionDetails(caseState, selectedQuestionOptions)
          : selectedQuestionOptions;
        if (activeCaseIdRef.current !== submittedCaseId || activeRunAbortController?.signal.aborted) return;
        const directPatch = failedPhase === "question" ? {} : inferDraftPatchFromFreeText(supplemental);
        const retryDraftWithSelections = applySelectedQuestionOptionsToDraft(recordDraft, retrySelections);
        const retryDraft = Object.keys(directPatch).length > 0
          ? mergeDraftPatch(retryDraftWithSelections, directPatch, true)
          : retryDraftWithSelections;
        if (retryDraft !== recordDraft) setRecordDraft(retryDraft);
        const recordChanged = hasQuestionRecordChange(retryDraft, caseState.hisRecord, Boolean(tongueImage), caseState.id);
        const requiresM03Refresh = errorRequiresM03Refresh(caseState.lastError) ||
          (["prescribe", "assess"].includes(failedPhase) && recordChanged);
        retryPhase = requiresM03Refresh ? "diagnose" : failedPhase;
        const draftAppliedState = withSafetyGateAndOperationalCompleteness(applyDraftToCaseState(caseState, retryDraft, supplemental, Boolean(tongueImage)));
        const recoveredBase = { ...draftAppliedState, phase: retryPhase, lastError: undefined };
        recovered = retryPhase === "diagnose"
          ? {
              ...recoveredBase,
              diagnosis: undefined,
              prescription: undefined,
              riskAssessment: undefined,
              reasoningDiagnose: undefined,
              reasoningPrescribe: undefined,
              reasoningV2: undefined,
              auditAdvisory: undefined,
            }
          : retryPhase === "prescribe"
            ? {
                ...recoveredBase,
                prescription: undefined,
                riskAssessment: undefined,
                reasoningPrescribe: undefined,
                reasoningV2: diagnoseReasoningFromState(recoveredBase),
                auditAdvisory: undefined,
              }
            : retryPhase === "assess"
              ? { ...recoveredBase, riskAssessment: undefined, auditAdvisory: undefined }
              : recoveredBase;
        persistState(recovered);

        if (retryPhase === "collect") {
          const hisRecord = recovered.hisRecord || buildHisRecordSnapshot(retryDraft, supplemental, Boolean(tongueImage), caseState.id);
          await runCollect(hisRecord.rawText || recovered.chiefComplaint, recovered, hisRecord);
        } else if (retryPhase === "question") {
          const selectedAnswer = selectedQuestionAnswerText(retrySelections);
          const retryAnswer = [selectedAnswer, supplemental].filter(Boolean).join("\n");
          const retryQuestionState = retryAnswer ? applyUserAnswer(recovered, retryAnswer) : recovered;
          if (retryAnswer) setInput("");
          commitSelectedQuestionOptions({});
          await runQuestion(withSafetyGateAndOperationalCompleteness(retryQuestionState), { countRound: false });
        } else {
          // diagnose / prescribe / assess — resume from the failed phase. If a prior M03 diagnosis
          // already exists, resume the chain directly (it skips M03 and re-runs only the failed stage)
          // instead of re-gating with canEnterDiagnosisChain, which could discard the valid diagnosis
          // into follow-up mode. Only fall back to follow-up when there is no diagnosis to resume from.
          const retryState = { ...recovered, phase: retryPhase };
          const canResumeForcedRun = retryState.skipDifferentiationGate === true && canSkipDifferentiationGate(retryState);
          if (retryState.diagnosis || canEnterDiagnosisChain(retryState) || canResumeForcedRun) {
            await runDiagnoseChain(retryState);
          } else {
            persistState(applyDifferentiationGateOutcome(retryState));
          }
        }
    } catch (error) {
      persistState(setError(recovered, normalizeRequestError(error, `${retryPhase.toUpperCase()}重试失败`)));
    } finally {
      setRunning(false);
    }
  }

  async function handleSkipFollowup() {
    if (runningRef.current || isRunning) return;
    setRunning(true);
    beginRunScope();
    try {
      // “跳过” discards this round's unsubmitted selections/text. The separate submit action is the
      // only path that may project answers into the medical record.
      const draftForSkip = recordDraft;
      const draftApplied = withSafetyGateAndOperationalCompleteness(
        applyDraftToCaseState(caseState, draftForSkip, "", Boolean(tongueImage)),
      );
      if (!canSkipDifferentiationGate(draftApplied)) return;
      const base: CaseState = {
        ...draftApplied,
        questionRounds: Math.min(draftApplied.maxQuestionRounds, draftApplied.questionRounds + 1),
        questionOutcome: "skipped",
      };
      setInput("");
      commitSelectedQuestionOptions({});
      const reuseM03 = hasExecutableM03Diagnosis(base);
      const forcedBase: CaseState = reuseM03
        ? { ...base, skipDifferentiationGate: true }
        : { ...base, previousResult: capturePreviousResult(base), skipDifferentiationGate: true, diagnosis: undefined, reasoningDiagnose: undefined, reasoningV2: undefined, reasoningPrescribe: undefined, prescription: undefined, riskAssessment: undefined };
      const skipState = setPhase(withSafetyGate(forcedBase), reuseM03 ? "prescribe" : "diagnose");
      persistState(skipState);
      await runDiagnoseChain(skipState);
    } finally {
      setRunning(false);
    }
  }

  function resetCurrentCase() {
    clearCase(caseState.id);
    clearWorkspaceSnapshot();
    const nextCase = newCase();
    activeCaseIdRef.current = nextCase.id;
    setCaseState(nextCase);
    setRecordDraft(createEmptyHisRecordDraft());
    setStreaming({});
    setInput("");
    commitSelectedQuestionOptions({});
    setTongueImage(null);
    setTongueImageConsent(false);
    setUploadNotice("");
    setCaptureModal(null);
    setPendingNewCaseConfirm(false);
    setWorkbenchUnsavedDraft(null);
  }

  function handleNewCase() {
    if (runningRef.current || isRunning) return;
    if (hasInProgressWork || hasAnyDraftInputInDocument()) {
      setPendingNewCaseConfirm(true);
      return;
    }
    resetCurrentCase();
  }

  function handleDownloadReport() {
    const report = scrubReportPhi(buildCompleteReport(caseState), caseState);
    const blob = new Blob([report], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `中医CDSS脱敏报告_${Date.now()}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async function handleAcceptEditedPrescription(accepted: AcceptedEditedPrescription): Promise<void> {
    if (runningRef.current || isRunning) throw new Error("当前已有诊疗阶段在运行，请等待完成后再同步编辑处方。");
    if (caseState.id !== accepted.caseId || activeCaseIdRef.current !== accepted.caseId) throw new Error("病例已切换，编辑后处方未写回。请在当前病例重新审方。");
    setRunning(true);
    beginRunScope();
    try {
    const prescription = buildAcceptedPrescriptionMarkdown(accepted.reasoning, accepted.revision.candidateIndex, accepted.revision.herbHash);
    if (!prescription) throw new Error("编辑后处方为空，未写回病例。");
    const auditAdvisory: CaseState["auditAdvisory"] = accepted.revision.auditAvailable === false
      ? {
          available: false,
          reason: accepted.revision.auditReason === "no_prescription_items"
            ? "no_prescription_items"
            : "service_unavailable",
        }
      : { available: true };
    const mergedReasoning = mergeReasoningStages(
      diagnoseReasoningFromState(caseState),
      accepted.reasoning,
    );
    const latestDraftCase = applyDraftToCaseState(caseState, recordDraft, caseState.hisRecord?.fields.extraText || "", Boolean(tongueImage));
    const editedState = withSafetyGate({
      ...latestDraftCase,
      phase: "assess",
      prescription,
      riskAssessment: accepted.auditSection,
      reasoningPrescribe: accepted.reasoning,
      reasoningV2: mergedReasoning || accepted.reasoning,
      prescriptionRevision: accepted.revision,
      auditAdvisory,
      // Preserve the fresh server-owned patient safety result. RxAudit severity itself remains
      // advisory and does not participate in this flag.
      safetyLocked: accepted.serverSafetyLocked,
      lastError: undefined,
    });
    const permission = derivePrescriptionPermission(editedState);
    if (permission.candidateMode === "non_dose_only" || permission.candidateMode === "blocked") {
      throw new Error("病例出现急性风险、特殊人群或关键数值异常，编辑后剂量方案未写回；可继续查看风险分析，并请专科/药师复核。");
    }
    const currentVersionHash = await computePrescriptionVersionHash(accepted.reasoning, accepted.revision.candidateIndex, editedState).catch(() => "");
    if (!currentVersionHash || currentVersionHash !== accepted.revision.herbHash) {
      throw new Error("病例诊断、过敏史、现用药或人口学信息已变化；请对当前病例重新审方后再写回。");
    }

    if (activeCaseIdRef.current !== accepted.caseId) throw new Error("病例已切换，旧病例响应已丢弃。");
    const riskAssessment = replaceRiskAssessmentFollowup(accepted.auditSection, accepted.followupSection);

    const committed = withSafetyGate({
      ...editedState,
      phase: "done",
      riskAssessment,
      safetyLocked: accepted.serverSafetyLocked || permission.formalAdoption === "blocked",
    });
    const savedAt = BROWSER_CASE_PERSISTENCE_ENABLED
      ? await saveWorkspaceSnapshot({
          caseState: committed,
          recordDraft,
          input,
          selectedQuestionOptions,
          runningPhase: undefined,
          // 采纳后未保存草稿分叉消除：清除脏标记，快照只保留已审方/采纳版本。
          workbenchDraft: null,
        })
      : null;
    if (BROWSER_CASE_PERSISTENCE_ENABLED && !savedAt) throw new Error("编辑后方案未能安全保存，请检查浏览器存储或网络后重试；当前版本尚未写回。");
    persistState(committed);
    setWorkbenchUnsavedDraft(null);
    if (savedAt) setLastSavedAt(savedAt);
    setStreamingForPhase("assess", "");
    } finally {
      setRunning(false);
    }
  }

  // 医生显式确认“本次就诊存在治疗目标”：确认只通过 sourceFingerprint 绑定当前病历版本，
  // 病历任何变化都会改变指纹并使确认失效。确认后清除上一轮非剂量结果并重试 M04；
  // 服务端仍以 attested 语义预检结论为准，客户端按钮不构成分叉的放行权限。
  async function handleConfirmEncounterScope(): Promise<void> {
    if (runningRef.current || isRunning) return;
    const sourceFingerprint = caseState.clinicalFacts?.sourceFingerprint;
    if (!sourceFingerprint) return;
    setRunning(true);
    beginRunScope();
    try {
      const confirmed = withSafetyGate({
        ...caseState,
        encounterScopeConfirmation: { sourceFingerprint, confirmedAt: new Date().toISOString() },
        prescription: undefined,
        riskAssessment: undefined,
        reasoningPrescribe: undefined,
        reasoningV2: diagnoseReasoningFromState(caseState),
        auditAdvisory: undefined,
        lastError: undefined,
        phase: "prescribe",
      });
      persistState(confirmed);
      await runDiagnoseChain(confirmed);
    } finally {
      setRunning(false);
    }
  }

  function handleQuestionOption(selection: QuestionOptionSelection) {
    const questionId = selection.questionId || "__fallback";
    const currentSelections = selectedQuestionOptionsRef.current;
    const previous = currentSelections[questionId];
    const toggledOff = previous?.answer === selection.answer;
    const nextSelections = { ...currentSelections };
    if (toggledOff) {
      delete nextSelections[questionId];
    } else {
      nextSelections[questionId] = selection.requiresDetail
        ? { ...selection, questionId, patch: undefined, replacePatch: undefined }
        : { ...selection, questionId };
    }
    commitSelectedQuestionOptions(nextSelections);
  }

  function handleQuestionDetailAnswer(item: QuestionItem, value: string) {
    const currentSelections = selectedQuestionOptionsRef.current;
    const previous = currentSelections[item.id];
    const nextSelections = { ...currentSelections };
    const detail = value.trim();
    if (item.targetField) {
      if (!detail) {
        if (previous?.requiresDetail) {
          nextSelections[item.id] = { ...previous, detailAnswer: "", patch: undefined };
        } else {
          delete nextSelections[item.id];
        }
      } else {
        nextSelections[item.id] = {
          ...(previous || { label: "医生补充", answer: value, kind: "clinical_fact" as const }),
          questionId: item.id,
          answer: value,
          requiresDetail: true,
          detailAnswer: value,
          targetField: item.targetField,
          patch: undefined,
          replacePatch: undefined,
        };
      }
      commitSelectedQuestionOptions(nextSelections);
      return;
    }
    if (previous?.requiresDetail) {
      const patch = detail ? questionDetailPatch(previous, detail) : {};
      const selection: QuestionOptionSelection = {
        ...previous,
        questionId: item.id,
        detailAnswer: value,
        patch,
      };
      nextSelections[item.id] = selection;
      commitSelectedQuestionOptions(nextSelections);
      return;
    }
    if (!detail) {
      delete nextSelections[item.id];
      commitSelectedQuestionOptions(nextSelections);
      return;
    }
    const inferred = item.targetField
      ? { targetField: item.targetField, patch: { [item.targetField]: detail } as Partial<HisRecordDraft> }
      : inferQuestionPatch(`${item.question} ${item.reason}`, detail, item.fields || []);
    const selection: QuestionOptionSelection = {
      questionId: item.id,
      label: "医生补充",
      answer: value,
      ...inferred,
    };
    nextSelections[item.id] = selection;
    commitSelectedQuestionOptions(nextSelections);
  }

  const limitedCanContinue = canContinueLimitedCase(caseState);
  const currentStreaming = streaming[caseState.phase] ?? "";
  const visibleConversation = caseState.conversation
    .filter((msg) => !(msg.role === "assistant" && isInternalCollectMessage(msg.content)));
  const projectedQuestionDraft = useMemo(
    () => applySelectedQuestionOptionsToDraft(recordDraft, selectedQuestionOptions),
    [recordDraft, selectedQuestionOptions],
  );
  const liveDraftCaseState = useMemo(
    () => withSafetyGateAndOperationalCompleteness(applyDraftToCaseState(caseState, recordDraft, "", Boolean(tongueImage))),
    [caseState, recordDraft, tongueImage],
  );
  const liveReassessmentCaseState = useMemo(
    () => withSafetyGateAndOperationalCompleteness(applyDraftToCaseState(caseState, projectedQuestionDraft, input, Boolean(tongueImage))),
    [caseState, projectedQuestionDraft, input, tongueImage],
  );
  const isQuestionSupplementFlow = caseState.phase === "question" || limitedCanContinue;
  const liveUiCaseState = isQuestionSupplementFlow ? liveReassessmentCaseState : liveDraftCaseState;
  const chiefComplaintReady = hasChiefComplaintInput(recordDraft);
  const recordChangedForSubmit = hasQuestionRecordChange(projectedQuestionDraft, caseState.hisRecord, Boolean(tongueImage), caseState.id);
  const hasUnsubmittedRecordChange = caseState.phase !== "idle" && !isQuestionSupplementFlow && recordChangedForSubmit;
  const selectedAnswerForBudget = selectedQuestionAnswerText(selectedQuestionOptions);
  const hasPendingDetail = hasPendingQuestionDetail(selectedQuestionOptions);
  const hasSubmitChange = Boolean(input.trim()) || Boolean(selectedAnswerForBudget) || recordChangedForSubmit;
  const pendingHisRecordText = buildHisRecordText(projectedQuestionDraft, input, Boolean(tongueImage));
  const pendingRecordSupplement = recordChangedForSubmit && pendingHisRecordText.trim()
    ? `本轮病历补充：\n${pendingHisRecordText}`
    : "";
  const pendingSubmitText = isQuestionSupplementFlow
    ? [selectedAnswerForBudget, recordChangedForSubmit ? pendingRecordSupplement : input.trim()].filter(Boolean).join("\n\n")
    : pendingHisRecordText;
  const modelInputTooLong = isModelInputOverBudget(pendingSubmitText);
  const canSubmit = isQuestionSupplementFlow
    ? chiefComplaintReady && hasSubmitChange && !modelInputTooLong
    : chiefComplaintReady && hasHisRecordInput(recordDraft, input, Boolean(tongueImage)) && !modelInputTooLong;
  const noChangeToSubmit = chiefComplaintReady && !canSubmit;
  const submitHint = !chiefComplaintReady
    ? "请先填写主诉。"
    : isQuestionSupplementFlow && hasPendingDetail && !hasSubmitChange
      ? "已选择需要补充详情的项目，请填写患者实际回答，或再次点击该项取消。"
    : isQuestionSupplementFlow && hasPendingDetail
      ? "未填写的待补充项不会作为患者事实提交；可先用已确认信息继续推理。"
    : modelInputTooLong
      ? `病历文本过长（${pendingSubmitText.length}/${MAX_MODEL_INPUT_CHARS}），请先压缩现病史、补充说明或辅助检查内容。`
    : noChangeToSubmit
        ? (isQuestionSupplementFlow
            ? "请补充至少一项信息或点选一个追问选项后再提交。"
            : "修改病历任一字段后可重新评估。")
        : undefined;
  const runningElapsedSeconds = isRunning
    ? runningStageElapsedSeconds(runningStageClock, caseState.phase, clockNow)
    : 0;
  const appendDraftValue = useCallback((key: keyof HisRecordDraft, value: string) => {
    setRecordDraft((prev) => ({ ...prev, [key]: appendClinicalPresetValue(key, prev[key], value) }));
  }, []);
  const interactionLocked = isRunning || !workspaceRestored;

  return (
    <div className="flex min-h-screen flex-col bg-[#F7F9FB] text-gray-900 xl:h-screen xl:overflow-hidden">
      <header className="shrink-0 border-b border-gray-200 bg-white px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-teal-50 text-teal-700">
            <Stethoscope className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <h1 className="text-sm font-bold">青羊承德诊所 · 中医 CDSS</h1>
            <p className="text-xs text-gray-500">
              面向 HIS 集成的四诊辨证支持 · {BROWSER_CASE_PERSISTENCE_ENABLED ? "本机仅短期保存加密草稿和结果" : "本机不保存草稿，关闭后请从 HIS 恢复"} · 不保存图像
              {BROWSER_CASE_PERSISTENCE_ENABLED && lastSavedAt ? ` · 已保存 ${new Date(lastSavedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}` : ""}
            </p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {caseState.phase !== "idle" && (
              <span className="hidden text-xs text-gray-400 lg:inline">当前病例</span>
            )}
            <button
              type="button"
              onClick={handleNewCase}
              disabled={interactionLocked}
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-600 transition-colors hover:border-teal-200 hover:bg-teal-50 hover:text-teal-700 disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-300"
              aria-label="新建诊疗"
              title="新建诊疗"
            >
              <Plus className="h-4 w-4" />
            </button>
          </div>
        </div>
      </header>

      <div className="flex flex-1 xl:min-h-0 xl:overflow-hidden">
        <main className="relative grid flex-1 gap-3 overflow-visible p-3 xl:min-h-0 xl:grid-cols-[minmax(0,1fr)_410px] xl:overflow-hidden 2xl:grid-cols-[minmax(0,1fr)_460px]">
          <HisMedicalRecordWorkspace
            key={caseState.id}
            draft={recordDraft}
            setDraft={setRecordDraft}
            isRunning={interactionLocked}
            tongueImage={tongueImage}
            uploadNotice={uploadNotice}
            tongueInputRef={tongueInputRef}
            onImageChange={(event) => handleImageUpload(event, setTongueImage)}
            onClearTongueImage={() => {
              setTongueImage(null);
              setTongueImageConsent(false);
              setUploadNotice("");
            }}
            onOpenTongueCapture={() => setCaptureModal("tongue")}
          />
          <AiSupportPanel
            caseState={isQuestionSupplementFlow ? liveUiCaseState : caseState}
            isRunning={interactionLocked}
            canCancelRun={isRunning}
            isCancelling={runCancelRequested}
            runningElapsedSeconds={runningElapsedSeconds}
            currentStreaming={currentStreaming}
            visibleConversation={visibleConversation}
            hasUnsubmittedRecordChange={hasUnsubmittedRecordChange}
            selectedQuestionOptions={selectedQuestionOptions}
            freeTextAnswer={input}
            onFreeTextAnswerChange={setInput}
            onOption={handleQuestionOption}
            onDetailAnswer={handleQuestionDetailAnswer}
            onSubmitAnswer={() => {
              void handleSubmit({ preventDefault: () => undefined } as React.FormEvent);
            }}
            onSkipFollowup={handleSkipFollowup}
            canSkipFollowup={canSkipDifferentiationGate(liveUiCaseState)}
            onRetry={handleRetry}
            onCancelRun={handleCancelRun}
            onDownloadReport={handleDownloadReport}
            onAcceptEditedPrescription={handleAcceptEditedPrescription}
            onConfirmEncounterScope={handleConfirmEncounterScope}
            restoredUnsavedDraft={workbenchUnsavedDraft}
            onUnsavedDraftChange={handleWorkbenchUnsavedDraftChange}
            onRunReasoning={() => {
              void handleSubmit({ preventDefault: () => undefined } as React.FormEvent);
            }}
            canRunReasoning={canSubmit}
            submitHint={submitHint}
          />
          {!workspaceRestored && (
            <div
              className="absolute inset-3 z-40 flex items-center justify-center rounded-xl border border-teal-100 bg-white/95"
              role="status"
              aria-live="polite"
              data-testid="workspace-restoring"
            >
              <div className="flex items-center gap-3 text-sm font-semibold text-gray-700">
                <Loader2 className="h-4 w-4 animate-spin text-teal-600" />
                正在恢复上次加密保存的病历与推理结果…
              </div>
            </div>
          )}
          {captureModal === "tongue" && (
            <TongueCaptureModal
              tongueValue={recordDraft.tcmTongue}
              tongueImage={tongueImage}
              uploadNotice={uploadNotice}
              isRunning={isRunning}
              imageConsent={tongueImageConsent}
              onImageConsentChange={setTongueImageConsent}
              onPick={(value) => appendDraftValue("tcmTongue", value)}
              onManualChange={(value) => setRecordDraft((prev) => ({ ...prev, tcmTongue: value }))}
              onUpload={() => {
                if (!isRunning) tongueInputRef.current?.click();
              }}
              onClearImage={() => {
                setTongueImage(null);
                setTongueImageConsent(false);
                setUploadNotice("");
              }}
              onClose={() => setCaptureModal(null)}
            />
          )}
          {pendingNewCaseConfirm && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-950/30 px-4" role="presentation">
              <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="new-case-confirm-title"
                className="w-full max-w-sm rounded-lg border border-gray-200 bg-white p-4 shadow-xl"
              >
                <h2 id="new-case-confirm-title" className="text-sm font-bold text-gray-900">清空当前诊疗？</h2>
                <p className="mt-2 text-[13px] leading-relaxed text-gray-600">
                  {BROWSER_CASE_PERSISTENCE_ENABLED
                    ? "当前本机加密保存的病历草稿和 AI 结果会一起清空。舌照/图像不会被保存；清空后无法从本机恢复，请确认已经写回 HIS 或完成记录。"
                    : "当前页面中的病历草稿和 AI 结果会一起清空。舌照/图像不会被保存；请确认已经写回 HIS 或完成记录。"}
                </p>
                <div className="mt-4 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setPendingNewCaseConfirm(false)}
                    className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-[13px] font-bold text-gray-700 transition-colors hover:bg-gray-50"
                  >
                    继续编辑
                  </button>
                  <button
                    type="button"
                    onClick={resetCurrentCase}
                    className="rounded-lg bg-rose-600 px-3 py-2 text-[13px] font-bold text-white transition-colors hover:bg-rose-700"
                  >
                    清空并新建
                  </button>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
