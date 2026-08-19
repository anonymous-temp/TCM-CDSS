// src/app/diagnosis/page.tsx
"use client";

import { useState, useRef, useEffect, useCallback, useMemo, type ReactNode } from "react";
import { extractCdssReasonCode, reasonCodeRequiresM03Rerun } from "@/lib/cdss-reason-codes";
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
import { classifyWesternDiagnosticEvidence, westernDiagnosticEvidenceGroups, clinicalFactSourcesFromCaseState, clinicalFactWithSource, guidelineReferenceDisplay, uniqueClinicalFacts } from "@/lib/clinical-fact-source";
import type { CaseState, ClinicalCitation, ClinicalReasoningResultV2, HisRecordSnapshot, Phase, SafetyGate, StructuredFollowupTimelineItem } from "@/lib/diagnosis-types";
import { ageValue, normalizeCaseStateInput, normalizeStructuredFollowupTimeline } from "@/lib/diagnosis-types";
import { LINEAGE_OPTIONS, displayableLineageAdaptation } from "@/lib/tcm-lineages";
import {
  saveCase, loadLatestCase, clearCase, clearAllSavedCases, isBrowserCasePersistenceEnabled,
  sanitizeCaseStateForBrowserPersistence, scrubPersistentPhiText,
  consumeCollectStream, consumeMarkdownStream, consumeMarkdownStreamWithMetadata,
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
import { clinicalTextForDisplay, hasExecutableSignedM03, isDisplayableClinicalText, syndromeDifferentiationState } from "@/lib/diagnosis-client-guards";
import { computePrescriptionVersionHash } from "@/lib/prescription-version";
import { filterModificationsForEditedHerbs, hasIncompleteEditedHerb, synchronizeEditedCandidate } from "@/lib/prescription-revision";
import { containsUnknownClinicalCue, isUnknownClinicalText, PULSE_FORCE_PATTERN_SOURCE, PULSE_QUALITY_PATTERN_SOURCE } from "@/lib/clinical-state";
import { inspectionLexiconGroups, inspectionLexiconNormal, type InspectionField } from "@/lib/tcm-inspection-lexicon";
import { computeTongueRoiCrop, detectTongueRoi } from "@/lib/tongue-image-roi";
import { customerEvidenceDisplayStatus, sanitizeCustomerEvidenceNarrative, sanitizeLabeledEvidenceLines } from "@/lib/customer-evidence";
import { TCM_DISEASE_NAME_VISIBLE_TO_CLINICIAN, clinicalOutputLabel, clinicalOutputRendererId, clinicalOutputSurface, clinicalSentence, joinClinicalClauses, sanitizeAuthoritativeClinicalOutput } from "@/lib/clinical-output-authority";
import {
  buildDeterministicRiskFollowupPayload,
  buildSafetyLimitedPrescription,
  derivePrescriptionPermission,
  deriveSafetyLocked,
  detectProgrammaticRedFlags,
  evaluateSafetyGate,
  hasActionableM03Diagnosis,
  isLimitedDiagnosisText,
  isNonDosePrescriptionText,
  isRiskLineNegatedOrEnumerative,
  reconcileRestoredCaseState,
  sanitizeFreeTextForExternalClinicalService,
  withSafetyGate,
  redFlagRuleIdForMessage,
} from "@/lib/diagnosis-safety";
import {
  clinicalEvidenceFingerprint,
  prioritizeTcmEvidenceForDisplay,
  prioritizeWesternEvidenceForDisplay,
} from "@/lib/clinical-evidence-display";
import {
  activeEmergencyClearanceFindingsFromGate,
  emergencyClearanceContractIssue,
  emergencyClearanceFindingKey,
  emergencyClearanceIssueMessage,
  EMERGENCY_CLEARANCE_DISPOSITIONS,
  type EmergencyClearanceFindingAttestation,
} from "@/lib/emergency-clearance-contract";
import { markdownUrlTransform as urlTransform } from "@/lib/safe-url";
import { isEncryptedSnapshotEnvelope } from "@/lib/encrypted-snapshot";
import { FORMULA_STRUCTURE_TARGETS, formulaTargetPathogenesisCells, type FormulaStructureRole } from "@/lib/herb-target-contract";
import { parseRxAuditStatusMarker, stripRxAuditStatusMarker } from "@/lib/rxaudit-status";
import { buildSeasonalCare } from "@/lib/tcm-seasonal-care";
import { sanitizeDiagnoseStreamingDraft } from "@/lib/diagnosis-stream-safety";
import {
  M03_DRAFT_MODULES,
  type M03DraftModule,
  type StreamModuleDraftFrame,
} from "@/lib/diagnosis-stream-protocol";
import { parseClinicalFacts, type ClinicalFacts } from "@/lib/clinical-facts";
import {
  buildMedicineCandidateEmptyState,
  buildTieredSuggestedChecks,
  herbCaseMeaning,
  isNonRedundantClinicalRationale,
  resolveAuditReviewPresentation,
  safeDietAdviceForDisplay,
  doseSourceLabelForDisplay,
  GOVERNED_HERB_DATA_LABEL,
} from "@/lib/result-display-policy";
import {
  isCompoundAffirmativeQuestionOption,
  parseM02PlanFromContent,
  type M02Plan,
  type M02TargetField,
} from "@/lib/m02-question-contract";
import {
  parseTcmTreatmentCapabilities,
  type TcmTreatmentProjectCode,
} from "@/lib/tcm-treatment-projects";
import { buildClinicianTreatmentProjects } from "@/lib/tcm-treatment-clinician-view";
import {
  classifyHerbWarning,
  deriveCaseWarningProfile,
  type ClinicalWarningLevel,
  type ClinicalWarningProfile,
} from "@/lib/clinical-warning-tier";
import {
  createPathogenesisNarrativeLedger,
  westernDiagnosisLabelForDisplay,
} from "@/lib/diagnosis-visible-summary";
import { clinicianVisibleMedicationRiskNote } from "@/lib/patient-relevant-medication-risk";

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
// The clinic treatment-project scope is one small status read: no streamed chunks and no
// server-declared deadline, so elapsed wall time is the only continuous signal that honestly
// exists. Bounding the read gives that signal an endpoint, so the panel always resolves to a
// definite state instead of an open-ended wait.
const TREATMENT_SCOPE_STATUS_TIMEOUT_MS = 8_000;
const TREATMENT_SCOPE_STATUS_TIMEOUT_SECONDS = Math.round(TREATMENT_SCOPE_STATUS_TIMEOUT_MS / 1000);
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
  return sanitizeAuthoritativeClinicalOutput(sanitizeCustomerEvidenceNarrative(text)
    .replace(/^.*(?:内部检索状态|AUTO_PARSED_NEEDS_REVIEW).*$/gm, "")
    .replace(/^\s*#{1,6}\s*加减建议核查说明\s*$/gm, "")
    .replace(/^.*(?:未采用经典方说明|逐味核验|本次未形成同时满足.+随症加减条目|另有\s*\d+\s*条加减建议未展示).*$/gm, "")
    .replace(/^\s*\|[^|\n]*采纳候选前[^|\n]*\|[^|\n]*完成针对性安全复核[^|\n]*\|.*$/gm, "")
    .replace(/(?:证据不足\s*[/／]\s*待检索|依据待检索|引用待检索|证据来源待核验|证据URL待核验|内部证据缺口)/g, "")
    .replace(/<!--\s*EVIDENCE_GAP:[^>]+-->/g, "")
    .replace(/^\s*(?:[-*]\s*)?\*\*(?:证据依据|来源依据|参考依据|引用来源|方剂出处或依据)\*\*[：:]\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim());
}

/**
 * `tcmDiseaseName` remains part of the signed reasoning contract because retrieval and
 * downstream consistency checks use it. It is not useful on the clinician-facing syndrome
 * card, so remove only the labeled disease-name row from customer-visible Markdown.
 */
export function stripTcmDiseaseNameForCustomer(text: string): string {
  // 与服务端渲染、结构化卡片共用同一个开关（2026-08-11）。此前这里无条件删除，
  // 而另外两个出口无条件渲染——同一份内容在报告里没有、在页面上有，正是甲方看到的自相矛盾。
  if (TCM_DISEASE_NAME_VISIBLE_TO_CLINICIAN) return text;
  return text
    .replace(/^(#{1,6}\s*.*)中医病名与证候诊断(.*)$/gm, "$1中医证候诊断$2")
    .replace(/^\s*(?:[-*]\s*)?(?:\*\*)?(?:中医)?病名(?:\*\*)?\s*[：:].*(?:\n|$)/gm, "")
    .replace(/^\s*\|\s*(?:中医)?病名\s*\|[^\n]*(?:\n|$)/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Keep only the concise Western working diagnosis and grounded supporting facts on clinician-facing
 * compatibility/export surfaces. Structured rationale, differentials and checks remain available
 * to the review contracts but are not repeated as model reasoning in the report.
 */
export function stripWesternAnalysisForCustomer(text: string): string {
  const lines = text
    .replace(/西医诊断倾向与鉴别/g, "西医诊断倾向")
    .split("\n");
  const result: string[] = [];
  let hiddenHeadingLevel: number | null = null;
  for (const line of lines) {
    const heading = line.match(/^(#{1,6})\s*(.+?)\s*$/);
    if (hiddenHeadingLevel != null) {
      if (!heading || heading[1].length > hiddenHeadingLevel) continue;
      hiddenHeadingLevel = null;
    }
    const title = heading?.[2]?.replace(/[：:]/g, "").trim() || "";
    if (heading && /^(?:西医诊断分析|西医鉴别分析|鉴别方向|参考文献)$/.test(title)) {
      hiddenHeadingLevel = heading[1].length;
      continue;
    }
    if (/^\s*(?:[-*]\s*)?\*\*(?:临床分析|限制与反证|建议检查|下一步)\*\*[：:]/.test(line)) continue;
    result.push(line);
  }
  return result.join("\n").replace(/\n{3,}/g, "\n\n").trim();
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

function redFlagStatusForCase(caseState: CaseState) {
  const gate = evaluateSafetyGate(caseState);
  const redFlags = gate.redFlags.length > 0 ? gate.redFlags : detectProgrammaticRedFlags(caseState);
  if (redFlags.length > 0) {
    const finding = gate.redFlagFindings?.[0];
    const trace = finding
      ? `命中原文：${finding.sourceQuote}；判定规则：${finding.ruleExplanation}`
      : "";
    return {
      label: "高风险",
      tone: "red",
      desc: [redFlags[0] || "当前资料提示需优先处理的急危重症风险", trace].filter(Boolean).join(" "),
    };
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
      desc: "当前已提交内容未识别明确急危重症风险；待完成辨证分析后，将结合病史、生命体征与必要检查继续复核。",
    };
  }
  return { label: "低风险", tone: "green", desc: "已提交信息中未识别明确急危重红旗；仍需医生结合现场查体、生命体征和必要检查复核。" };
}

export type EmergencyPresentation = {
  pageTitle: "急诊转诊建议";
  eventTitle: string;
  immediateAction: string;
  clinicalConcern: string;
  evidenceChips: string[];
  escalationRationale?: string;
  actions: string[];
};

export function buildEmergencyPresentation(caseState: CaseState): EmergencyPresentation {
  const gate = caseState.safetyGate || evaluateSafetyGate(caseState);
  const finding = gate.redFlagFindings?.[0];
  const semanticEvidence = gate.semanticTriage?.evidence?.[0];
  const rawEvidence = [
    ...(semanticEvidence?.evidenceQuotes || []),
    semanticEvidence?.sourceQuote,
    finding?.sourceQuote,
  ].filter((value): value is string => Boolean(value?.trim()));
  // 红旗触发证据 = 规则/语义分诊**实际匹配到的原话**，按分句切开，一句一枚。
  //
  // 此前这里挂着一条手写自然语言正则，从原话里抠关键词片段：
  //   /突发…(?:最剧烈|爆炸样|雷击样)…头痛|(?:恶心|呕吐)|胸(?:痛|闷)|大汗|…/g
  // 甲方 2026-08-12 线上实测（52岁男性，「1小时前活动中突然出现剧烈头痛，呈爆裂样，
  // 数秒内达高峰，伴喷射性呕吐2次，颈项僵硬」）只印出「恶心、呕吐」两枚——
  //   · 「突然」不是「突发」、「爆裂样」不是「爆炸样」，且性状词在头痛之后另起一个分句，
  //     那条头痛支路整条不命中；
  //   · 「颈项僵硬」「数秒达峰」这两条最关键的脑膜刺激征/雷击样特征根本不在表里；
  //   · 而只要**任意一个**片段命中（这里是「呕吐」），下面的分支就整体丢弃完整原话。
  // 于是医生看到的证据恰好少了定性的那几条，同一屏下方的组合判断却识别正确——
  // 同一份证据两套判据，其中一套是靠枚举自然语言，这在本仓库是明令禁止的形态。
  //
  // 判据换成纯结构的：按分句切分 + 按包含关系去重（uniqueClinicalFacts，与西医依据同一个）。
  // 一个字都不新增、一个字都不丢，医生看到的就是规则匹配到的原话。
  const evidenceChips = uniqueClinicalFacts(
    rawEvidence.flatMap((value) => value
      .normalize("NFKC")
      .split(/[，,。．；;\n]+/)
      .map((clause) => clause.trim().replace(/^[“”"'「」]+|[“”"'「」]+$/g, ""))
      // 一字残片（切分留下的「等」「及」）不成其为证据；两字起（「大汗」「呕血」）都要保留。
      .filter((clause) => clause.length >= 2)),
  ).map((value) => truncateClinicalTextForDisplay(value, 60)).slice(0, 8);
  // 该显示哪张急诊卡片，只问规则表——此前这里自带 `/心血管|冠脉|胸痛|胸闷/`
  // 与 `/头痛|神经/` 两份关键词表，与 diagnosis-safety 的 RED_FLAG_FINDING_RULES.message
  // 是同一判据的第二份抄写：那边加一条规则，这边不会知道。
  // 没有 finding 时（只拿到提示语）用同一张表反查规则 id，认不出就走通用急症措辞。
  const ruleId = finding?.ruleId || redFlagRuleIdForMessage(gate.redFlags.join("；"));

  if (ruleId === "acute-neurologic-event") {
    return {
      pageTitle: "急诊转诊建议",
      eventTitle: "疑似急性神经血管事件（雷击样头痛）",
      immediateAction: "建议立即急诊或转诊评估；危及生命时呼叫 120。",
      clinicalConcern: "符合雷击样头痛特征，需排查蛛网膜下腔出血等急性神经血管事件。",
      evidenceChips,
      escalationRationale: semanticEvidence?.escalationRationale,
      actions: [
        "现场评估血压、意识、瞳孔及神经系统体征。",
        "立即联系急诊或安排转诊；危及生命时呼叫 120。",
        "急症排除并留痕后，再回到本系统继续常规诊疗。",
      ],
    };
  }
  if (ruleId === "acute-cardiac-event") {
    return {
      pageTitle: "急诊转诊建议",
      eventTitle: "疑似急性心血管事件",
      immediateAction: "建议立即急诊或转诊评估；危及生命时呼叫 120。",
      clinicalConcern: "需优先排查急性冠脉综合征等时间敏感性心血管事件。",
      evidenceChips,
      escalationRationale: semanticEvidence?.escalationRationale,
      actions: [
        "现场复测生命体征并完成心电图等急性心血管评估。",
        "立即联系急诊或安排转诊；危及生命时呼叫 120。",
        "急症排除并留痕后，再回到本系统继续常规诊疗。",
      ],
    };
  }
  return {
    pageTitle: "急诊转诊建议",
    eventTitle: "疑似急危重症事件",
    immediateAction: "建议立即急诊或转诊评估；危及生命时呼叫 120。",
    clinicalConcern: finding?.ruleExplanation || gate.redFlags[0] || "当前病例存在需要优先排查的急危重症风险。",
    evidenceChips,
    escalationRationale: semanticEvidence?.escalationRationale,
    actions: [
      "立即复测生命体征并完成针对性的现场评估。",
      "联系急诊或安排转诊；危及生命时呼叫 120。",
      "急症排除并留痕后，再回到本系统继续常规诊疗。",
    ],
  };
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
    // 「生命体征未录入」是一条**录入事实**，不是辨证充分度的等级（2026-08-11 线上实测）。
    //
    // 此前这一档把 label 改写成「需现场复核」、tone 由绿降黄，却不重新归一 score——
    // 分数仍停在「辨证充分」的 70–100 档，于是甲方看到「需现场复核」与「综合支撑度 96%」同屏，
    // 一个说要复核、一个说很充分，医生无从理解。根因是等级槽位（label/tone/score）被
    // 两套规则各写各的：一套在 differentiationSufficiencyProfile（按辨证充分度归一），
    // 另一套就在这里（按有没有体征改写）。
    //
    // 收敛：等级槽位只由辨证充分度决定，本分支**只追加说明**，不再动 label/tone/score。
    // 「生命体征未录入」照常显著提示，只是不再冒充一个辨证充分度等级。
    return {
      ...base,
      desc: `${UNRECORDED_VITALS_NOTICE}。非高风险病例不因此阻断候选处方生成；${base.desc}`,
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
      desc: "当前未形成包含具体用量的候选处方，随访仅展示补充信息和复评路径。",
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
    desc: "包含具体用量的候选方药已生成，是否采纳由医生独立判断。",
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
  // 主证候没有成立时不得显示「辨证充分」。这个评分取自 M02 的**信息采集完整度**（completeness 四维
  // 加权），与 M03 是否真的辨出证候不同源：服务端在安全降级、合同复核未过、仅既往史等分支下会把
  // primarySyndromeResolution 置为非 resolved，但 completeness 原样透传、客户端也从不回写，
  // 所以 level 仍可能是 C、四维仍可能满分。实测后果就是「综合支撑度 100% 辨证充分」与
  // 「当前证候依据不足以形成稳定结论」同屏——采集量与判断量被并排当成同一件事。
  // 采集充分不等于辨证成立；结论未成立时以结论为准。
  const signedDiagnoseReasoning = diagnoseReasoningFromState(caseState);
  // 三态各自成话（2026-08-11）：此前这里把 `!== "resolved"` 一刀切写成「辨证未成立」，
  // 把契约里的 bounded（证型**成立**、但可回溯依据有限）也算了进去。
  // 于是甲方看到「辨证未成立 / 69%」与一张 6 味 7 剂的处方同屏——说法错了，不是门禁放行错了。
  // 判据收敛在 syndromeDifferentiationState 一处（见该函数注释），本处只负责怎么说。
  const differentiationState = syndromeDifferentiationState(signedDiagnoseReasoning);
  if (differentiationState === "not_established") {
    return {
      score: Math.max(0, Math.min(39, score)),
      label: "辨证未成立",
      tone: "yellow" as const,
      desc: "信息采集已达标，但本次未能形成稳定的主证候结论；结论区已说明原因与需补充项。",
      signals,
    };
  }
  if (differentiationState === "bounded") {
    return {
      score: Math.max(40, Math.min(69, score)),
      label: "有界辨证",
      tone: "yellow" as const,
      // 原因文字取已签名载荷里服务端写好的那句（「仅有 N 条可逐字回溯的本例依据…」），
      // 不在客户端另造说法。
      desc: clinicalTextForDisplay(signedDiagnoseReasoning?.overview.primarySyndromeResolutionReason)
        || "已形成主证候结论，但可逐字回溯的本例依据有限；候选方案按有限信息生成，采纳前请补齐结论区所列项。",
      signals,
    };
  }
  const label = caseState.completeness.level === "C" && missingSignals.length === 0
    ? "辨证充分"
    : "有限信息可辨证";
  const tone = label === "辨证充分" ? "green" : "yellow";
  const desc = label === "辨证充分"
    ? "主诉、舌脉、证候和病机链已能支撑候选方案推理；处方仍需独立安全复核。"
    : "系统已基于现有信息完成辨证；未提供的资料会作为具体复核点展示，不阻断后续分析。";
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
      label: "待补充信息后再评估",
      desc: "处方风险复核存在明确的信息缺口，补齐后再评估是否可采纳。",
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

/**
 * F1（追问不阻断）：M02 生成追问后分析自动继续，本轮结束时若医生仍未回答/未跳过，
 * 追问以“并行增强”身份保留在结果区。此状态下的提交沿用既有追问回答链路
 * （清空结论并从辨病辨证重跑），而不是 done 态的整轮重采集。
 */
export function hasPendingFollowupQuestions(
  caseState: Pick<CaseState, "phase" | "questionOutcome" | "conversation">,
): boolean {
  return caseState.phase === "done" &&
    !caseState.questionOutcome &&
    caseState.conversation.some((msg) => msg.role === "assistant" && parseQuestionItems(msg.content).length > 0);
}

export function maxQuestionRoundNotice(
  state: Pick<CaseState, "questionRounds" | "maxQuestionRounds" | "phase">,
): string {
  if (state.questionRounds < state.maxQuestionRounds) return "";
  if (state.phase === "done") return "";
  if (state.phase === "question") {
    return "分析已自动继续；补充回答可随时完善并重新分析。";
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
    return "该分值用于回顾候选方药的辨证支撑度；本轮评估已完成，不足项可在补充信息后重新评估。";
  }
  return "该分值用于表达当前病历的证据覆盖度；资料不全会列为具体复核点，但不阻断本轮分析。";
}

// The 综合支撑度 headline is a weighted blend; these are its actual factors and weights (kept in
// sync with differentiationSufficiencyProfile). Surfaced on demand so a doctor who taps the score
// sees exactly what drives it, instead of a wall of all-green "已具备" rows.
export function differentiationScoreComponents(
  state: Pick<CaseState, "completeness">,
  signals: DifferentiationSignal[],
): Array<{ label: string; weight: number; value: number; contribution: number }> {
  const completeRatio = signals.length
    ? signals.filter((item) => item.status === "complete").length / signals.length
    : 0;
  return [
    { label: "信息增益", weight: 0.28, value: state.completeness.infoGain },
    { label: "可回答性", weight: 0.24, value: state.completeness.answerability },
    { label: "管理影响度", weight: 0.22, value: state.completeness.managementImpact },
    { label: "红旗筛查覆盖", weight: 0.16, value: state.completeness.redFlag },
    { label: "四诊信号完整度", weight: 0.1, value: completeRatio },
  ].map((row) => ({
    ...row,
    value: Math.max(0, Math.min(1, row.value)),
    contribution: Math.round(Math.max(0, Math.min(1, row.value)) * row.weight * 100),
  }));
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
    followupTimeline: undefined,
    safetyLocked: false,
    lastError: undefined,
    phase: "question",
  };
}

function applyDifferentiationGateOutcome(caseState: CaseState): CaseState {
  if (!canEnterDiagnosisChain(caseState)) return applyDifferentiationFollowupState(caseState);
  return setError(
    { ...caseState, phase: "diagnose", prescription: undefined, riskAssessment: undefined, followupTimeline: undefined },
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
  const activeGate = caseState.safetyGate || evaluateSafetyGate(caseState);
  const isRedFlag = activeGate.status === "red_flag";
  const hasEmergencyReferralReport = isRedFlag && Boolean(caseState.diagnosis || caseState.riskAssessment);
  const emergencyPresentation = useMemo(
    () => buildEmergencyPresentation(caseState),
    [caseState],
  );
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
    !isRedFlag && (
      Boolean(caseState.diagnosis) ||
      isDifferentiationLimitedTerminalCase(caseState)
    );
  const questionRoundNotice = maxQuestionRoundNotice(caseState);
  const hasTriageAdvisory = !isRedFlag && (activeGate.advisories || []).length > 0;
  const [showScoreBreakdown, setShowScoreBreakdown] = useState(false);
  const scoreComponents = useMemo(
    () => differentiationScoreComponents(caseState, differentiationProfile.signals),
    [caseState, differentiationProfile.signals],
  );

  return (
    <div className="flex flex-col gap-3">
      {isRedFlag && !hasEmergencyReferralReport && (
        <div
          data-testid="risk-red-flag-card"
          data-clinical-contract-ids="red-flag-warning"
          data-clinical-renderer="risk-summary-panel"
          className="rounded-xl border border-red-200 bg-red-50 p-4"
        >
          <p className="text-[11px] font-bold tracking-wide text-red-700">{emergencyPresentation.pageTitle}</p>
          <h2 className="mt-1 text-sm font-bold leading-snug text-red-950">{emergencyPresentation.eventTitle}</h2>
          <p className="mt-2 text-xs font-semibold leading-relaxed text-red-800">{emergencyPresentation.immediateAction}</p>
          {emergencyPresentation.evidenceChips.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5" aria-label="红旗触发证据">
              {emergencyPresentation.evidenceChips.map((evidence) => (
                <span key={evidence} className="rounded-full border border-red-200 bg-white px-2 py-1 text-[11px] font-medium text-red-800">
                  {evidence}
                </span>
              ))}
            </div>
          )}
          <div className="sr-only">
            <span data-testid="risk-status-badge">{redStatus.label}</span>
          </div>
        </div>
      )}

      {hasTriageAdvisory && <div data-testid="risk-advisory-card" className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs font-semibold text-amber-900">临床优先关注</p>
          <span className="shrink-0 rounded-full border border-amber-200 bg-white px-2.5 py-1 text-xs font-semibold text-amber-800">{redStatus.label}</span>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-amber-900">{redStatus.desc}</p>
      </div>}

      {shouldShowDifferentiationProfile && (
        <div data-testid="completeness-card" className="bg-white border rounded-xl p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">辨证充分度</p>
            <span className={`shrink-0 rounded-full border px-2.5 py-1 text-xs font-bold ${statusToneClass(differentiationProfile.tone)}`}>
              {differentiationProfile.label}
            </span>
          </div>
          {/* 综合支撑度整行可点击：展开时给出该分值的加权构成与未具备项，收起时不再堆叠全绿“已具备”卡。 */}
          <button
            type="button"
            onClick={() => setShowScoreBreakdown((value) => !value)}
            aria-expanded={showScoreBreakdown}
            className="w-full rounded-lg border border-gray-100 bg-gray-50 px-3 py-2 text-left transition-colors hover:bg-gray-100"
          >
            <div className="flex items-center justify-between text-xs">
              <span className="flex items-center gap-1 font-semibold text-gray-700">
                综合支撑度
                <ChevronDown className={`h-3.5 w-3.5 text-gray-400 transition-transform ${showScoreBreakdown ? "rotate-180" : ""}`} />
              </span>
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
            {!showScoreBreakdown && (
              <p className="mt-1.5 text-[11px] text-gray-400">点击查看该分值由哪些维度构成</p>
            )}
          </button>
          {showScoreBreakdown && (
            <div className="mt-2 rounded-lg border border-gray-100 bg-white px-3 py-2.5">
              <p className="mb-2 text-[11px] font-semibold text-gray-500">分值构成（各维度覆盖度 × 权重）</p>
              <div className="grid gap-1.5">
                {scoreComponents.map((component) => (
                  <div key={component.label} className="text-[11px]">
                    <div className="flex items-center justify-between text-gray-600">
                      <span>{component.label} <span className="text-gray-400">×{Math.round(component.weight * 100)}%</span></span>
                      <span className="font-semibold text-gray-700">{Math.round(component.value * 100)}% → +{component.contribution}</span>
                    </div>
                    <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-gray-100">
                      <div className="h-full rounded-full bg-gray-300" style={{ width: `${Math.round(component.value * 100)}%` }} />
                    </div>
                  </div>
                ))}
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-gray-400">
                综合支撑度为以上维度加权合成，并按当前辨证充分度等级归一展示。
              </p>
              <div className="mt-2.5 grid gap-1.5">
                {differentiationProfile.signals.map((signal) => (
                  <div key={signal.label} className={`rounded-lg border px-2.5 py-1.5 text-[11px] ${signalStatusClass(signal.status)}`}>
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-semibold">{signal.label}</p>
                      <span className="shrink-0 text-[10px] font-bold opacity-75">{signalStatusLabel(signal.status)}</span>
                    </div>
                    {signal.status !== "complete" && signal.action && (
                      <p className="mt-0.5 leading-relaxed opacity-80">补强：{signal.action}</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
          <p className="text-xs text-gray-400 mt-2">
            {caseState.questionOutcome === "skipped"
              ? "本轮关键追问已跳过"
              : caseState.questionOutcome === "not_needed"
                ? "本例无需追加关键追问"
                : `已完成 ${caseState.questionRounds}/${caseState.maxQuestionRounds} 轮追问`}
          </p>
          {caseState.questionOutcome !== "not_needed" && (
            <div
              className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-gray-100"
              role="progressbar"
              aria-label="关键追问进度"
              aria-valuemin={0}
              aria-valuemax={caseState.maxQuestionRounds}
              aria-valuenow={caseState.questionRounds}
            >
              <div
                className="h-full rounded-full bg-teal-500 transition-[width]"
                style={{ width: `${Math.min(100, Math.round((caseState.questionRounds / Math.max(1, caseState.maxQuestionRounds)) * 100))}%` }}
              />
            </div>
          )}
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

      {!isRedFlag && !shouldShowDifferentiationProfile && followupQuestionCard && (
        <div data-testid="sufficiency-followup-card" className="bg-white border rounded-xl p-4">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">本轮关键追问</p>
          <p className="mt-1 text-xs leading-relaxed text-gray-500">可点选实际回答或在每题下直接记录患者原话、查体和检查结果；也可跳过并按现有信息继续。</p>
          <div className="mt-3">{followupQuestionCard}</div>
        </div>
      )}

    </div>
  );
}

/**
 * F2（甲方反馈「候选方药拦截，刷新后依旧不能生成」）：M04 因 M03 级原因（辨证不稳 / 未形成
 * 稳定证候 / 辨证复核未完成）给出非剂量页或报错时，仅重跑 M04 会复用同一份 M03，必然原地复卡。
 * 命中以下判据的“重新生成候选方药/重试本阶段”动作一律升级为从 M03 重跑。
 */
const M03_LEVEL_PRESCRIBE_BLOCK_PATTERN = /尚未形成通过临床复核的稳定证候|本次辨病辨证结果完整性|辨证语义复核未完成|未形成可执行|辨证信息完整度不足/;

export function prescribeRetryRequiresM03Rerun(
  caseState: Pick<CaseState, "lastError" | "prescription">,
): boolean {
  const message = caseState.lastError?.phase === "prescribe"
    ? normalizeRequestError(caseState.lastError.message, "")
    : "";
  // reasonCode 机器码优先(2026-08-03 根源工程): 服务端降级页嵌入稳定码,按码分流,
  // 文案可以随便改。旧文案正则只作为存量缓存病例(无标记)的回退,不再是第一权威。
  const machineCode = extractCdssReasonCode(message) ?? extractCdssReasonCode(caseState.prescription || "");
  if (machineCode) return reasonCodeRequiresM03Rerun(machineCode);
  return M03_LEVEL_PRESCRIBE_BLOCK_PATTERN.test(message) ||
    M03_LEVEL_PRESCRIBE_BLOCK_PATTERN.test(caseState.prescription || "");
}

export function errorRequiresM03Refresh(lastError: CaseState["lastError"] | undefined): boolean {
  if (!lastError || !["prescribe", "assess"].includes(lastError.phase)) return false;
  const message = normalizeRequestError(lastError.message, "");
  // NOTE: this routes recovery off the doctor-facing message text, so any reword of a message that
  // must force an M03 refresh has to be reflected here too — 未能取得确认后的诊断结论 is the
  // terminology-confirmation failure raised in confirmTerminologyMapping.
  return /M03.*(?:签名|合同)|重新生成\s*M03|辨病辨证结果签名已失效|当前辨病辨证结果已失效|未能取得确认后的诊断结论|reasoning.*signature|contract.*signature/i.test(message);
}

export function errorRequiresM04Refresh(lastError: CaseState["lastError"] | undefined): boolean {
  if (!lastError || lastError.phase !== "assess") return false;
  const message = normalizeRequestError(lastError.message, "");
  return /M04.*(?:签名|合同)|重新生成\s*M04|候选处方.*(?:签名|合同).*(?:失效|无效)|当前候选处方.*有效签名|重新生成候选方药|prescription.*signature/i.test(message);
}

export function automaticSignatureRecoveryState(
  state: CaseState,
  lastError: NonNullable<CaseState["lastError"]>,
): CaseState | undefined {
  if (errorRequiresM03Refresh(lastError)) {
    return {
      ...state,
      phase: "diagnose",
      diagnosis: undefined,
      prescription: undefined,
      riskAssessment: undefined,
      followupTimeline: undefined,
      reasoningDiagnose: undefined,
      reasoningPrescribe: undefined,
      reasoningV2: undefined,
      auditAdvisory: undefined,
      lastError: undefined,
    };
  }
  if (errorRequiresM04Refresh(lastError)) {
    return {
      ...state,
      phase: "prescribe",
      prescription: undefined,
      riskAssessment: undefined,
      followupTimeline: undefined,
      reasoningPrescribe: undefined,
      reasoningV2: diagnoseReasoningFromState(state),
      auditAdvisory: undefined,
      lastError: undefined,
    };
  }
  return undefined;
}

export function stageErrorDisplay(lastError: NonNullable<CaseState["lastError"]>): {
  stepLabel: string;
  message: string;
  retryText: string;
  downstreamLabels: string[];
  warningLevel: "L2" | "L3";
} {
  const failedStep = PHASE_STEPS.find((step) => step.phase === lastError.phase);
  const stepLabel = failedStep?.label || "当前阶段";
  const message = normalizeRequestError(lastError.message, `${stepLabel} 未完成，请补充信息或重试。`);
  const requiresM03Refresh = errorRequiresM03Refresh(lastError);
  const requiresM04Refresh = errorRequiresM04Refresh(lastError);
  // F2：M04 报错但根因在 M03 级（辨证不稳/未形成稳定证候）时，重试按钮明示会从辨证重跑，
  // 与 handleRetry / handleSubmit 错误分支的升级判据保持一致。
  const requiresM03RerunForPrescribeBlock =
    lastError.phase === "prescribe" && M03_LEVEL_PRESCRIBE_BLOCK_PATTERN.test(message);
  const retryText =
    requiresM03RerunForPrescribeBlock ? "重新辨证并生成方药" :
    requiresM03Refresh ? "重新生成辨病辨证并继续" :
    requiresM04Refresh ? "重新生成候选方药并继续" :
    lastError.phase === "diagnose" ? "重新生成辨病辨证" :
    lastError.phase === "prescribe" ? "重新生成候选方药" :
    lastError.phase === "assess" ? "重新生成审方与随访" :
    "重试本阶段";
  // PHASE_ORDER 比 PHASE_STEPS 多一个头部 "idle"，索引差 1：下游切片直接用 PHASE_ORDER 下标即可，
  // 不能再 +1，否则失败阶段的下一个阶段会被漏掉（例如 M04 失败时漏掉“审方随访未执行”）。
  const downstreamLabels = PHASE_STEPS.slice(phaseIndex(lastError.phase)).map((step) => step.label);
  const warningLevel = /(?:篡改|伪造|非法|越权|鉴权失败|权限不足|CSRF|安全合同不一致)/i.test(message) ? "L3" : "L2";
  return { stepLabel, message, retryText, downstreamLabels, warningLevel };
}

function StageErrorCard({ caseState, onRetry }: { caseState: CaseState; onRetry: () => void }) {
  if (caseState.phase !== "error" || !caseState.lastError) return null;
  const { stepLabel, message, retryText, downstreamLabels, warningLevel } = stageErrorDisplay(caseState.lastError);
  const highRisk = warningLevel === "L3";

  return (
    <div
      data-testid="stage-error-card"
      data-warning-level={warningLevel}
      className={`mb-3 rounded-xl border p-4 ${highRisk ? "border-red-200 bg-red-50 text-red-900" : "border-amber-200 bg-amber-50 text-amber-950"}`}
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className={`mt-0.5 h-4 w-4 shrink-0 ${highRisk ? "text-red-700" : "text-amber-700"}`} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[13px] font-bold">{stepLabel} 未完成</p>
            {/* warningLevel（L2/L3）是内部分级枚举，右侧中文已经说清了性质，不再把枚举值印给医生。 */}
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${highRisk ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-800"}`}>
              {highRisk ? "安全异常" : "可恢复异常"}
            </span>
          </div>
          <p className="mt-1 text-[12px] leading-relaxed">{message}</p>
          {downstreamLabels.length > 0 && (
            <p className={`mt-1 text-[12px] leading-relaxed ${highRisk ? "text-red-700" : "text-amber-800"}`}>
              上一阶段未成功，{downstreamLabels.join("、")} 阶段未执行。
            </p>
          )}
          <button
            type="button"
            onClick={onRetry}
            className={`mt-3 inline-flex items-center justify-center gap-1.5 rounded-lg border bg-white px-3 py-2 text-[12px] font-bold transition-colors ${
              highRisk ? "border-red-200 text-red-700 hover:bg-red-100" : "border-amber-200 text-amber-800 hover:bg-amber-100"
            }`}
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
        answer: "存在妊娠、哺乳或备孕可能，暂不建议形成包含具体用量的处方。",
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
  return "请在本卡片补充后提交，系统会回填到相应病历栏目。";
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
      <div
        className="space-y-3"
        data-clinical-contract-ids="M02-question-plan"
        data-clinical-renderer="question-plan-card"
      >
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
    <div
      className="space-y-3"
      data-clinical-contract-ids="M02-question-plan"
      data-clinical-renderer="question-plan-card"
    >
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
  const currentConclusionSection = [
    extractSectionLoose(prescriptionText, ["当前结论"]),
    extractSectionLoose(riskText, ["当前结论"]),
    extractSectionLoose(diagnosisText, ["本次分析结论", "当前结论"]),
  ].find(Boolean) || "";

  const riskSummarySection = extractSectionLoose(riskText, ["处方安全总评", "风险总评", "安全总评"]);
  const referralSection = extractSectionLoose(riskText, ["转诊评估", "转诊建议"]);
  const followupSection = extractSectionLoose(riskText, ["随访管理方案", "随访方案"]);
  const followupTimelineSection = extractSectionLoose(riskText, ["随访时间轴", "时间轴"]);
  const followupTimelineItems = (caseState.followupTimeline || []).filter((item) =>
    !/采纳候选前/.test(item.time) && !/完成针对性安全复核/.test(item.action)
  );
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
    currentConclusionSection,
    riskSummarySection,
    referralSection,
    followupSection,
    followupTimelineSection,
    followupTimelineItems,
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

export function generationStatus(phase: Phase, isRedFlag = false): { title: string; desc: string } {
  if (isRedFlag && (phase === "prescribe" || phase === "assess")) {
    return {
      title: "正在生成候选方药与风险处置建议",
      desc: "本例存在急危重风险提示：候选方药照常生成并置顶安全警示，采纳前请先完成急诊/转诊评估。",
    };
  }
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

export function buildCompleteReport(
  caseState: CaseState,
  options: { warningProfile?: ClinicalWarningProfile; nonDoseOnly?: boolean } = {},
): string {
  const reportSection = (content?: string) => sanitizeCustomerEvidenceSurface(stripDiagnosisJSON(content || ""));
  const diagnosisReportSection = (content?: string) =>
    stripWesternAnalysisForCustomer(stripTcmDiseaseNameForCustomer(reportSection(content)));
  const warningProfile = options.warningProfile || deriveCaseWarningProfile(caseState);
  const nonDoseOnly = options.nonDoseOnly === true || !warningProfile.executable;
  const emergencyReferral = (caseState.safetyGate || evaluateSafetyGate(caseState)).status === "red_flag";
  const emergencyPresentation = emergencyReferral ? buildEmergencyPresentation(caseState) : undefined;
  const acknowledgement = caseState.warningAcknowledgement;
  const deidentifiedPatient = {
    sex: caseState.patient.sex,
    age: caseState.patient.age,
  };
  return normalizeClinicalText([
    emergencyReferral ? "# 中医CDSS急诊转诊建议与依据" : "# 中医CDSS辅助诊疗脱敏报告",
    `导出说明：本报告默认脱敏，仅供授权医生在院内环境复核使用。`,
    // 下载报告与页面同口径：分级只写中文标签，不写 L0–L4 枚举值（甲方评测 2026-08-04 第 1 条）。
    emergencyReferral ? `处置类别：${emergencyPresentation?.pageTitle}` : `风险分级：${warningProfile.label}`,
    `可执行状态：${emergencyReferral ? "转诊建议与触发依据，不含候选方药或剂量" : nonDoseOnly ? "安全评估说明，不得作为处方或医嘱执行" : "辅助建议，须经医生最终确认"}`,
    `分级理由：${warningProfile.reasons.join("；") || "无额外分级理由"}`,
    acknowledgement
      ? `导出确认：${acknowledgement.acknowledgedAt}；模式=${acknowledgement.exportMode}；指纹=${acknowledgement.reportFingerprint}${acknowledgement.reason ? `；理由=${acknowledgement.reason}` : ""}`
      : "",
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
    "",
    emergencyPresentation ? [
      "## 急诊转诊建议",
      `疑似事件：${emergencyPresentation.eventTitle}`,
      `立即行动：${emergencyPresentation.immediateAction}`,
      `临床关注：${emergencyPresentation.clinicalConcern}`,
      `触发证据：${emergencyPresentation.evidenceChips.join("；") || "结构化病例事实命中确定性规则"}`,
      ...emergencyPresentation.actions.map((action, index) => `${index + 1}. ${action}`),
    ].join("\n") : "",
    caseState.emergencyClearance
      ? `## 医生现场排查留痕\n确认时间：${caseState.emergencyClearance.confirmedAt}\n评估结果：${caseState.emergencyClearance.assessmentSummary}`
      : "",
    caseState.diagnosis ? `## 辨病辨证\n${diagnosisReportSection(caseState.diagnosis)}` : "",
    !nonDoseOnly && caseState.prescription ? `## 候选方药\n${reportSection(caseState.prescription)}` : "",
    nonDoseOnly ? `## 处方执行边界\n${emergencyReferral ? "急危重风险未排除前不生成候选方药或剂量；请先完成急诊或转诊评估。" : "本次安全评估不允许导出剂量级候选方药；请解除确定性阻断后重新评估。"}` : "",
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

function PreviousResultCard({ result, note }: { result: NonNullable<CaseState["previousResult"]>; note?: string }) {
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
            {note ?? "新一轮推理尚未完成。以下内容对应修改前病历，不参与本轮辅助分析、自动审方、报告导出或医嘱写回。"}
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

async function reportExportFingerprint(caseState: CaseState): Promise<string> {
  const payload = JSON.stringify({
    caseId: caseState.id,
    diagnosis: caseState.diagnosis || "",
    prescription: caseState.prescription || "",
    riskAssessment: caseState.riskAssessment || "",
    safetyStatus: caseState.safetyGate?.status || "",
    redFlags: caseState.safetyGate?.redFlags || [],
    herbHash: caseState.prescriptionRevision?.herbHash || "",
  });
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return `sha256-${Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
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
  // 判定短语与降级正文同源维护在 diagnosis-safety.ts；展示层不再自带正文副本。
  return !hasCandidate && isNonDosePrescriptionText(caseState.prescription);
}

/**
 * 经典条文出处面板。
 *
 * 这批数据（222,338 条 tcmoc 古籍证据）此前只在服务端被填进 candidate.classicEvidence 并随
 * 结构化流下发，前端与 HIS 都没有任何渲染代码——医生只能看到一行「经典方出处：《XX》」，
 * 拿不到任何可核验的原文。证据绑定系统里，看不到原文的「证据」等于没有证据。
 *
 * 三条呈现纪律：
 * 1. **默认折叠**：右栏只有 410/460px，条文是核验材料不是首屏结论；点开即在，一条不删。
 * 2. **摘录给全**：这是医生自证的唯一材料。剂量与操作已在服务端按规则打码
 *    （显示为「[具体剂量或操作已隔离]」），这是刻意的——条文里的古代剂量不能被当成可执行用量。
 * 3. **不越界断言**：这些条文是按**方名**检索出来的，只能证明"历代如此论述该方"，
 *    不能证明"适用于本例患者"。标题与脚注都必须把这条说清楚，否则等于用出处冒充适应证依据。
 */
function ClassicEvidencePanel({ evidence }: {
  evidence?: Array<{ evidenceId: string; citation: string; anchorLevel: string; clauseNumber?: number; excerpt: string; tier: string }>;
}) {
  const items = (evidence || []).filter((item) => item?.citation && item?.excerpt);
  if (items.length === 0) return null;
  const tierLabel = (tier: string) => tier === "canon" ? "经典" : tier === "common" ? "通行" : "经验";
  const anchorLabel = (level: string) => level === "tiaowen" ? "条文" : level === "chapter_paragraph" ? "篇章段" : "页段";
  return (
    <details className="rounded-xl border border-slate-200 bg-slate-50">
      <summary className="cursor-pointer list-none px-3 py-2 text-xs font-bold text-slate-700">
        经典条文出处（{items.length} 条）
        <span className="ml-2 font-normal text-slate-500">按方名检索所得，说明历代如何论述该方，不代表适用于本例</span>
      </summary>
      <div className="space-y-2 px-3 pb-3">
        {items.map((item) => (
          <div key={item.evidenceId} className="rounded-lg border border-slate-200 bg-white p-2.5">
            <p className="text-[11px] font-semibold text-slate-700">
              {item.citation}
              <span className="ml-2 font-normal text-slate-500">
                {tierLabel(item.tier)}·{anchorLabel(item.anchorLevel)}{item.clauseNumber != null ? `·第${item.clauseNumber}条` : ""}
              </span>
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-slate-600">{item.excerpt}</p>
            <p className="mt-1 text-[10px] text-slate-400">证据ID {item.evidenceId}</p>
          </div>
        ))}
        <p className="text-[10px] leading-relaxed text-slate-500">
          条文中的具体剂量与操作已隔离显示：古代剂量与现代用量不可直接换算，本例用量以上方药味表与处方后审方为准。
        </p>
      </div>
    </details>
  );
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
    {
      label: "频次与服法",
      value: [
        decoction.dailyDoseCount ? `每日${decoction.dailyDoseCount}剂` : "",
        decoction.administration || "",
      ].filter(Boolean).join("；"),
    },
    { label: "复诊", value: decoction.followUpNode },
  ].filter((item) => isDisplayableClinicalText(item.value) && !/(?:由服务端生成|信息展示不全|待确认)/.test(item.value));
  if (items.length === 0) return null;
  return (
    <div
      className="rounded-xl border border-rose-100 bg-rose-50/60 p-3"
      data-clinical-contract-ids="M04-decoction"
      data-clinical-renderer="decoction-panel"
    >
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
  followupTimeline: StructuredFollowupTimelineItem[];
  serverSafetyLocked: boolean;
  revision: NonNullable<CaseState["prescriptionRevision"]>;
};

function structuredHerbWarningProfile(herb: StructuredHerb): ClinicalWarningProfile {
  return classifyHerbWarning({
    drug: herb.name,
    dose: herb.dose || "",
    evidence: herb.evidence?.source || "",
    safety: [
      herb.isToxic ? "毒性药味，需复核" : "",
      herb.decoctionRequirement,
    ].filter(Boolean).join("；"),
    verificationTier: herb.verificationTier,
    verificationReasons: herb.verificationReasons,
  });
}

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

// 医生编辑处方的同步逻辑**不在这里实现**。此前这里有一份私有副本，与
// src/lib/prescription-revision.ts 那份并存并已经漂开：服务端那份按
// canonicalTcmHerbIdentity 判同一味药（甘草/炙甘草算改动），这里按 name.trim() 判
// （同一次编辑被算成一删一增），于是 baseFormulas 的命中味数、随证加减的保留与合成、
// 煎服法的删句范围三处结果都不同。更要命的是**被测试覆盖的是没人调用的那一份**：
// test:clinical-grounding 测的是 lib 里的实现，线上跑的是这里的副本。
// 现已合并为一份（lib 侧采纳了本副本原有的「编辑即降核验档」行为）。

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
    verificationTier: "identity_pending",
    doseSource: "none",
    verificationReasons: ["医生新增药味，药味身份与剂量来源待重新核验"],
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
  const herbRows = candidate.herbs.map((herb, index) => {
    const warning = structuredHerbWarningProfile(herb);
    return `| ${index + 1} | ${markdownTableCell(herb.name)} | ${markdownTableCell(herb.verificationTier === "identity_pending" ? "待核定" : herb.dose || "待医生确认")} | ${markdownTableCell(herb.role)} | ${markdownTableCell(herb.targetPathogenesis)} | ${markdownTableCell(herb.function)} | ${markdownTableCell([herb.processing ? `炮制：${herb.processing}` : "", herb.decoctionRequirement].filter(Boolean).join("；") || "常规")} | ${warning.label} · ${markdownTableCell(warning.reasons.join("；"))} |`;
  });
  const modifications = reasoning.formula?.modifications || [];
  return [
    "## 中药饮片处方",
    ...(herbHash ? [`**处方版本摘要**：${markdownTableCell(herbHash)}`] : []),
    `**候选方名/方向**：${markdownTableCell(candidate.name)}`,
    "",
    "| 序号 | 药名 | 剂量 | 角色 | 对应病机 | 功用 | 炮制/煎服 | 核验分级 |",
    "|---|---|---|---|---|---|---|---|",
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
      `- ${markdownTableCell(base.name)}：${markdownTableCell(base.source)}；${base.verificationStatus === "verified_individually" ? "已逐方核验" : "原方案来源参考"}；组成匹配 ${base.matchedIngredientCount}/${base.totalIngredientCount || "?"} 味${base.requiredIngredientCount != null ? `，核心药味 ${base.matchedRequiredIngredientCount || 0}/${base.requiredIngredientCount} 味` : ""}${base.minimumPreservedIngredientCount != null ? `，组成下限 ${base.minimumPreservedIngredientCount} 味` : ""}。`
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
        followupTimeline: caseState.followupTimeline || [],
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
          setAuditMessage(`药味功效已按${GOVERNED_HERB_DATA_LABEL}补全，请重新获取审方提示后再标记为编辑后候选方案。`);
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
        followupTimeline?: unknown;
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
      const fallbackFollowup = buildDeterministicRiskFollowupPayload(withSafetyGate({
        ...caseState,
        reasoningV2: revisedReasoning,
        reasoningPrescribe: revisedReasoning,
        riskAssessment: section,
      }));
      const followupSection = typeof body?.followup === "string" && body.followup.trim()
        ? body.followup.trim()
        : fallbackFollowup.markdown;
      const responseTimeline = normalizeStructuredFollowupTimeline(body?.followupTimeline);
      const followupTimeline = responseTimeline.length > 0 ? responseTimeline : fallbackFollowup.timelineItems;
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
        followupTimeline,
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
      const followup = buildDeterministicRiskFollowupPayload(withSafetyGate({
        ...caseState,
        reasoningV2: revisedReasoning,
        reasoningPrescribe: revisedReasoning,
        riskAssessment: section,
      }));
      setAcceptedRevision({
        caseId: caseState.id,
        reasoning: revisedReasoning,
        auditSection: section,
        followupSection: followup.markdown,
        followupTimeline: followup.timelineItems,
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
                value={herbCaseMeaning(herb)}
                readOnly
                disabled={controlsLocked}
                className="rounded border border-gray-200 bg-gray-50 px-2 py-1.5 text-xs text-gray-700 outline-none"
                placeholder={herbFunctionLookupStatus[herb.name.trim()] === "loading"
                  ? "正在查询规范功效"
                  : herbFunctionLookupStatus[herb.name.trim()] === "not_found" || herbFunctionLookupStatus[herb.name.trim()] === "error"
                    ? "未补全功效"
                    : "选择药味与病机后自动生成"}
                title={`依据当前病机与${GOVERNED_HERB_DATA_LABEL}生成`}
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
          正在按{GOVERNED_HERB_DATA_LABEL}补全药味功效，完成后可继续审方。
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
  const classifiedRows = table.rows.map((row, index) => {
    const drug = getTableCell(table, row, ["药名"]);
    const spec = getTableCell(table, row, ["炮制/规格", "规格"]);
    const dose = getTableCell(table, row, ["剂量"]);
    const role = getTableCell(table, row, ["君臣佐使"]);
    const position = getTableCell(table, row, ["处方角色", "药物定位"]);
    const target = getTableCell(table, row, ["对应病机/证候/症状", "对应病机", "对应证候", "对应症状"]);
    const meaning = getTableCell(table, row, ["配伍意义", "存在意义"]);
    const evidence = getTableCell(table, row, ["证据依据", "证据支持", "依据"]);
    const safety = getTableCell(table, row, ["安全提示", "风险提示"]);
    return {
      row,
      index,
      drug,
      spec,
      dose,
      role,
      position,
      target,
      meaning,
      evidence,
      safety,
      warning: classifyHerbWarning({ drug, dose, evidence, safety }),
    };
  });
  const tierCounts = classifiedRows.reduce<Record<ClinicalWarningLevel, number>>(
    (counts, item) => {
      counts[item.warning.level] += 1;
      return counts;
    },
    { L0: 0, L1: 0, L2: 0, L3: 0, L4: 0 },
  );

  return (
    <div className="overflow-hidden rounded-xl border bg-white" data-testid="herb-warning-tier-table">
      <div className="hidden grid-cols-[1.1fr_0.85fr_1.05fr_1.35fr_1.1fr] gap-3 border-b bg-gray-50 px-4 py-2 text-[11px] font-semibold text-gray-500 md:grid">
        <span>饮片/规格/剂量</span>
        <span>君臣佐使</span>
        <span>处方角色</span>
        <span>对应与存在意义</span>
        <span>证据与安全</span>
      </div>
      <div className="divide-y divide-gray-100">
        {classifiedRows.map(({ index, drug, spec, dose, role, position, target, meaning, evidence, safety, warning }) => {
          const tierTone =
            warning.level === "L4" ? "border-l-red-900 bg-red-50/70" :
            warning.level === "L3" ? "border-l-red-500 bg-red-50/40" :
            warning.level === "L2" ? "border-l-orange-400 bg-orange-50/30" :
            warning.level === "L1" ? "border-l-amber-300 bg-amber-50/20" :
            "border-l-slate-300";
          const badgeTone =
            warning.level === "L4" ? "bg-red-900 text-white" :
            warning.level === "L3" ? "bg-red-100 text-red-800" :
            warning.level === "L2" ? "bg-orange-100 text-orange-800" :
            warning.level === "L1" ? "bg-amber-100 text-amber-800" :
            "bg-slate-100 text-slate-700";

          return (
            <div
              key={`${drug}-${index}`}
              data-warning-level={warning.level}
              className={`grid gap-3 border-l-4 px-4 py-3 text-xs md:grid-cols-[1.1fr_0.85fr_1.05fr_1.35fr_1.1fr] ${tierTone}`}
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <p className="text-sm font-semibold text-gray-950">{drug || `药味${index + 1}`}</p>
                  {/* 同上：分级枚举只保留中文标签，L0（常规信息）不渲染 chip。 */}
                  {warning.level !== "L0" && (
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${badgeTone}`} title={warning.reasons.join("；")}>
                      {warning.label}
                    </span>
                  )}
                </div>
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
                {warning.level !== "L0" && (
                  <p className="text-gray-500"><span className="font-semibold">分级理由：</span>{warning.reasons.join("；")}</p>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t bg-gray-50 px-4 py-2 text-[11px] text-gray-600">
        <span className="font-semibold text-gray-800">药味警示汇总</span>
        {(["L4", "L3", "L2", "L1", "L0"] as ClinicalWarningLevel[])
          .filter((level) => tierCounts[level] > 0)
          .map((level) => (
            <span key={level} className="rounded-full border border-gray-200 bg-white px-2 py-0.5">
              {level}：{tierCounts[level]}
            </span>
          ))}
        <span className="ml-auto">L2 以上需确认；L4 不可执行或写回。</span>
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
  return [item.name, item.correspondingProblem, item.evidenceId, item.evidenceFingerprint]
    .every((value) => typeof value === "string" && value.trim().length > 0) &&
    shouldRenderEvidenceStatus(item.evidence);
}

function StructuredMedicinePlanCards({ candidates, caseState }: {
  candidates: NonNullable<StructuredFormula["patentAndWestern"]>;
  caseState: CaseState;
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
            <span className="rounded-full border border-emerald-100 bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-700">
              {item.recommendationMode === "discussion_only" ? "仅供讨论" : "候选需复核"}
            </span>
          </div>
          {/* 甲方 UI 决策：展示医生实际要看的主信息——适应症、用法用量、风险提示；
              「候选定位/使用边界」类定位话术与「外部参考资料核验」块不再呈现。
              用法用量来自结构化字段（途径/单次量/频次/疗程），缺项自然省略。 */}
          <div className="mt-3 grid gap-2 md:grid-cols-2">
            <SummaryLine label="适应症（本例对应问题）" value={item.correspondingProblem} tone="green" />
            <SummaryLine
              label="用法用量"
              value={[item.route, item.singleDose, item.frequency, item.course]
                .filter((part): part is string => typeof part === "string" && Boolean(part.trim()))
                .join("，")}
              tone="blue"
            />
            <SummaryLine
              label="风险提示"
              value={clinicianVisibleMedicationRiskNote(item.riskNote, caseState)}
              tone="amber"
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function AuditReviewSection({ caseState, content, order }: { caseState: CaseState; content?: string; order?: number }) {
  const presentation = resolveAuditReviewPresentation(caseState.auditAdvisory, content);
  if (!presentation) return null;
  const unavailable = presentation.kind === "unavailable";
  const toneClass = unavailable
    ? "border-amber-200 bg-amber-50/60 text-amber-900"
    : "border-red-200 bg-red-50/60 text-red-900";
  return (
    <details
      id="cdss-section-risk-review"
      open
      style={{ order }}
      data-clinical-contract-ids="M05-assessment"
      data-clinical-renderer="audit-followup-section"
      className={`group scroll-mt-3 rounded-xl border ${toneClass}`}
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3.5 py-3">
        <div className="min-w-0">
          <p className="text-[13px] font-bold">{presentation.title}</p>
          <p className="mt-0.5 truncate text-[11px] opacity-70">{presentation.subtitle}</p>
        </div>
        <ChevronDown className="h-4 w-4 shrink-0 opacity-60 transition-transform group-open:rotate-180" />
      </summary>
      <div className="border-t border-current/10 bg-white px-3.5 py-3 text-gray-800">
        {content?.trim() ? (
          <MarkdownBlock content={compactMarkdown(content, 3600)} compact />
        ) : (
          <p className="text-xs leading-relaxed text-amber-800">
            合理用药审查本次未完成，请由医生或药师复核。
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
            <MedicinePlanCards section={summary.westernPatentMedicineSection} nonDrugSection={summary.nonDrugSection} />
          </div>
        )}
      </div>
    </Disclosure>
  );
}

function SchemeSection({
  id,
  title,
  subtitle,
  children,
  defaultOpen = true,
  order,
  contractIds,
  rendererId,
}: {
  id?: string;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  order?: number;
  contractIds?: string | string[];
  rendererId?: string;
}) {
  const governedContractIds = contractIds
    ? (Array.isArray(contractIds) ? contractIds : [contractIds])
    : [];
  const governedRendererId = rendererId ||
    (governedContractIds.length > 0 ? clinicalOutputRendererId(governedContractIds[0]) : undefined);
  return (
    <details
      id={id}
      open={defaultOpen}
      style={{ order }}
      data-clinical-contract-ids={governedContractIds.length > 0 ? governedContractIds.join(",") : undefined}
      data-clinical-renderer={governedRendererId}
      className="group scroll-mt-3 rounded-xl border border-gray-200 bg-white"
    >
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

function ClinicalCitationLinks({
  label,
  citations,
}: {
  label: string;
  citations?: ReadonlyArray<Pick<ClinicalCitation, "evidenceId" | "citation" | "url"> & { appliesTo?: string }>;
}) {
  const visible = (citations || []).flatMap((citation) => {
    const display = guidelineReferenceDisplay(citation);
    return display.text ? [{ ...display, evidenceId: citation.evidenceId }] : [];
  });
  if (visible.length === 0) return null;
  return (
    <div className="mt-2">
      <p className="text-[11px] font-semibold">{label}</p>
      <div className="mt-1 flex flex-wrap gap-1.5">
        {visible.map((citation) => citation.href ? (
          <a
            key={`${citation.evidenceId}-${citation.text}`}
            href={citation.href}
            target="_blank"
            rel="noreferrer noopener"
            className="rounded-md bg-white/80 px-2 py-1 text-[11px] underline decoration-current/30 underline-offset-2"
          >
            {citation.text}
          </a>
        ) : (
          <span key={`${citation.evidenceId}-${citation.text}`} className="rounded-md bg-white/80 px-2 py-1 text-[11px]">
            {citation.text}
          </span>
        ))}
      </div>
    </div>
  );
}

function shouldRenderEvidenceStatus(evidence?: { evidenceLevel?: string; source?: string; confidence?: string }): boolean {
  return customerEvidenceDisplayStatus(evidence) === "traceable";
}

// 甲方评测(2026-08-04) 第 4 条「旧的深层推理明细组件源码也未完全删除」：
// 「查看证候与病机推理明细」折叠区在上一轮已按甲方反馈下线（见病机区 F5 注释），但它的证据明细
// 子组件族被留在源码里，靠一行 `void X;` 压掉未用告警继续编译。这不是「保留待重新挂载」
// （那种情况见 HerbModificationWorkbench，有明确注释、有回归断言钉住），而是删了一半。
// 本轮整族删除，grep 确认零引用（含 JSX、字符串与动态引用）后执行：
//   · 组件/判据：EvidenceCallout（永远 return null 的空壳，却仍挂在两处 JSX 上）、EvidenceDetail、
//     EvidenceReferenceList、evidenceReferenceItems、hasDisplayableEvidence；
//   · 参考文献格式化：enrichEvidenceReferenceForDisplay 及其 DOI/PMID/检索时间正则，
//     以及它依赖的整个 src/lib/evidence-display.ts（parseEvidenceDisplayReferences /
//     splitEvidenceReferenceItems）——EvidenceReferenceList 是它们在应用里唯一的调用方，
//     组件删掉后它们只被自己的测试引用。「留着因为有测试钉住」是循环论证：测试钉的是页面上
//     已经不存在的东西。相应的 test:evidence-display 套件与 test:diagnosis-display 里的
//     6 处断言一并移除。
// 表格内的支持证据/证据依据列不属于本族，仍由 shouldRenderEvidenceStatus 等保留。

// 展示层依据排序已上提到 @/lib/clinical-evidence-display（甲方 2026-08-10 ②）：
// 此前整段写在本文件里、只被一张 React 卡片消费，Markdown 与 HIS 两个出口没接。
// 这里保留同名 re-export，既有 import 路径与回归断言不受影响。
export {
  clinicalEvidenceFingerprint,
  prioritizeTcmEvidenceForDisplay,
  prioritizeWesternEvidenceForDisplay,
};

/** 展示层截断：超过 limit 的条目加省略号；完整内容在展开态/下方分析区仍可读。 */
export function truncateClinicalTextForDisplay(value: string, limit: number): string {
  const text = value.trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * 服务端置顶通知：安全警示横幅（`<!-- CDSS_SAFETY_ADVISORY -->` 后的引用块）与质量批注
 * （前置普通段落）都位于可见正文首个 "## " 标题之前。结果区按节抽取渲染，标题前的内容
 * 不属于任何节——不在这里显式提取，服务端刚写进去的警示与批注就会被前端整体丢掉。
 */
function extractServerLeadingNotices(caseState: CaseState): { safety: string[]; annotations: string[] } {
  const safety: string[] = [];
  const annotations: string[] = [];
  for (const text of [caseState.diagnosis, caseState.prescription]) {
    const head = (text || "").split(/^##\s/m)[0] || "";
    if (!head.trim()) continue;
    const hasMarker = head.includes("<!-- CDSS_SAFETY_ADVISORY -->");
    for (const rawLine of head.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("<!--")) continue;
      if (line.startsWith(">")) {
        const quoted = line.replace(/^>+\s*-?\s*/, "").replace(/\*\*/g, "").trim();
        if (quoted && hasMarker && !safety.includes(quoted)) safety.push(quoted);
        continue;
      }
      if (!line.startsWith("#") && /[。；]/.test(line) && !annotations.includes(line)) annotations.push(line);
    }
  }
  return { safety, annotations };
}

function ServerLeadingNotices({ caseState }: { caseState: CaseState }) {
  const { safety, annotations } = extractServerLeadingNotices(caseState);
  if (safety.length === 0 && annotations.length === 0) return null;
  return (
    <div className="space-y-2" data-testid="server-leading-notices">
      {safety.length > 0 && (
        <div className="rounded-xl border border-red-300 bg-red-50 p-3" data-testid="server-safety-advisory">
          <p className="text-xs font-bold text-red-800">安全警示（服务端判定，未解除）</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-xs leading-relaxed text-red-800">
            {safety.map((line) => <li key={line}>{line}</li>)}
          </ul>
        </div>
      )}
      {annotations.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3" data-testid="server-quality-annotations">
          <p className="text-xs font-bold text-amber-900">质量批注（采纳前请核对）</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-xs leading-relaxed text-amber-900">
            {annotations.map((line) => <li key={line}>{line}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
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
  // 药味加减工作台已按甲方决策从结果区下线（实现与受理链路保留，待新入口重新挂载）；
  // 外部参考展示同批下线。props 与实现保留以免破坏上层线程与持久化，显式 void 消除未用告警。
  void onAcceptEditedPrescription; void restoredUnsavedDraft; void onUnsavedDraftChange;
  // @retained-pending-remount HerbModificationWorkbench
  //   甲方决策：药味加减工作台从结果区下线，但实现与受理链路（onAcceptEditedPrescription → 服务端
  //   重新审方）整条保留，待新入口重新挂载。这是**声明式保留**，不是「删了一半」：
  //   scripts/test-visible-output-hygiene.mjs 的孤儿扫描只认这条标注，没有标注的未挂载定义一律判失败。
  //   与之同批的 candidateHerbSignature 已删除——它连工作台都不用，只是被 void 压着的死代码。
  void HerbModificationWorkbench;
  // F3（甲方反馈：西医支持依据罗列病历、冗余）：默认只展示前 4 条且每条约 60 字截断，
  // 展开后显示全部完整内容。仅展示层状态，不改结构化载荷。Hook 须在下方 early return 之前调用。
  const reasoning = mergeReasoningStages(diagnoseReasoningFromState(caseState), prescribeReasoningFromState(caseState)) || caseState.reasoningV2;
  if (!reasoning) return null;

  const formula = reasoning.formula;
  const firstCandidate = formula?.candidates?.[0];
  const firstCandidateWarnings = firstCandidate?.herbs.map(structuredHerbWarningProfile) || [];
  const firstCandidateTargetCells = formulaTargetPathogenesisCells(firstCandidate?.herbs.map((herb) => herb.targetPathogenesis) || []);
  const modificationLedger = createPathogenesisNarrativeLedger();
  const modificationCells = (formula?.modifications || []).map((item) => ({
    target: modificationLedger.claim(item.targetPathogenesis) ? item.targetPathogenesis : "",
    reason: item.reason || "",
  }));
  // 后台治理对象保留完整；医生页面只消费最小投影。缺具体内容、穴位或频次的项目直接不成卡，
  // 不再把模板状态、来源、资质或安全闸门当成“内容”回退显示。
  const clinicianTreatmentProjects = buildClinicianTreatmentProjects(reasoning.nonPharma);
  const hasDietTherapyProject = clinicianTreatmentProjects.some((item) => item.projectCode === "diet_therapy");
  const hasExplicitNonDoseResult = hasExplicitNonDosePrescriptionResult(caseState, Boolean(firstCandidate));
  // The server remains the enforcement point (attestation + fingerprint); this only mirrors the
  // visible state so the doctor gets an explicit confirmation action instead of a dead end.
  const unclearScopeAwaitingConfirmation = hasExplicitNonDoseResult &&
    caseState.clinicalFacts?.encounterScope?.status === "unclear" &&
    Boolean(caseState.clinicalFacts.sourceFingerprint) &&
    caseState.encounterScopeConfirmation?.sourceFingerprint !== caseState.clinicalFacts.sourceFingerprint;
  const medicineCandidates = formula?.patentAndWestern?.filter(isCompleteStructuredMedicineCandidate) || [];
  const hasMedicineCandidates = medicineCandidates.length > 0;
  const medicineCandidateEmptyState = buildMedicineCandidateEmptyState(caseState);
  // 需求3：诊断分三段各带推理——西医诊断（含 ICD-10）、中医辨病、中医辨证。
  // 辨病与辨证此前共用 tcmDiagnosticRationale，界面上也只显示证型：医生看到「心脾两虚证」
  // 却读不到中医病名，更读不到为什么把这组表现归入该病名而不是相邻病名。
  // 病名是否上屏走**与服务端同一个开关**（2026-08-11）。此前这里无条件渲染，
  // 而同一份内容在报告 Markdown 里被 stripTcmDiseaseNameForCustomer 删掉——
  // 一处删除、一处重新渲染，甲方在页面上看到病名、在报告里看不到。
  const tcmDiseaseName = TCM_DISEASE_NAME_VISIBLE_TO_CLINICIAN
    ? (reasoning.overview.tcmDiseaseName || "").trim()
    : "";
  const tcmDiseaseRationale = TCM_DISEASE_NAME_VISIBLE_TO_CLINICIAN && isDisplayableClinicalText(reasoning.overview.tcmDiseaseRationale || "")
    ? reasoning.overview.tcmDiseaseRationale || ""
    : "";
  const tcmRationale = isDisplayableClinicalText(reasoning.overview.tcmDiagnosticRationale || "") &&
    isNonRedundantClinicalRationale(
      reasoning.overview.tcmDiagnosticRationale || "",
      reasoning.overview.primarySyndromeBasis,
    )
    ? reasoning.overview.tcmDiagnosticRationale || ""
    : "";
  // 甲方 2.2「要求根据病名进行鉴别诊断，目前还有证候鉴别」(2026-08-05)。
  //
  // 服务端可见正文当时就改对了（diagnosis-visible-summary 只出病名鉴别、证候鉴别不出栏），
  // **但这个 React 页面没跟着改**，而医生看的正是这里：页面上渲染的是「鉴别 {证候名}」，
  // 病名鉴别 tcmDiseaseDifferentials 则一次都没渲染过——与甲方要求恰好相反。
  // 又一次「一个出口修了、另一个没修」，与本轮 HIS 投影、食疗净化是同一形态。
  //
  // 证候之间的取舍属于辨证过程，已在「辨证推理」一段交代；签名载荷里的
  // overview.tcmDifferentials 一字不动，已集成的调用方照常可取。
  const tcmDiseaseDifferentials = reasoning.overview.tcmDiseaseDifferentials || [];
  const westernDifferentials = reasoning.westernDiagnosis.differentials || [];
  // 方名只从已签名载荷里逐字取出，不重新检索、不代选（与服务端 deferredFormulaSelectionLines 同源）。
  const deferredFormulaNames = (reasoning.overview.deferredFormulaSelection?.names || [])
    .filter((name): name is string => typeof name === "string" && Boolean(name.trim()));
  const tcmDifferentials = reasoning.overview.tcmDifferentials || [];
  const tcmDifferentialBoundary = tcmDifferentials.length === 0 &&
    reasoning.overview.primarySyndromeResolution !== "resolved" &&
    isDisplayableClinicalText(reasoning.overview.primarySyndromeResolutionReason || "")
    ? reasoning.overview.primarySyndromeResolutionReason || ""
    : "";
  const tcmGroundedAlternativeFacts = [
    ...(reasoning.pathogenesis?.symptomClusters || []).flatMap((cluster) => cluster.symptoms || []),
    ...(reasoning.pathogenesis?.chain || []).flatMap((step) => [step.patientFact, step.syndromeEvidence]),
  ].filter((value): value is string => typeof value === "string" && Boolean(value.trim()));
  // 甲方评测(2026-08-04) 1.1.1：西医诊断下方不再是一串主诉/现病史复述，改为
  // 分类依据（症状/体征/检查/排除/待查/指南），每条标注它来自病历的哪个字段。
  // 三类与来源都由确定性层从已签名载荷与病例状态派生（clinical-fact-source.ts），此处只负责呈现。
  const westernFactSources = clinicalFactSourcesFromCaseState(caseState);
  // sources 必须传：分类的第二把判据是「这条事实落在病历的哪个字段」，不传等于把字段兜底
  // 整个关掉，凡是模型没标注的条目一律掉进「症状依据」——线上实测里生命体征、既往史、
  // 用药史因此都被印成症状。服务端 Markdown 一直传着（diagnosis-visible-summary.ts:2696），
  // 只有这个出口没传：又一次「同一判据两处各写各的」。
  const westernEvidence = classifyWesternDiagnosticEvidence(reasoning.westernDiagnosis.primary, westernFactSources);
  // 分组与标题走**服务端同一个投影函数**（2026-08-11）。
  //
  // 甲方 2026-08-10 要求把笼统的「支持依据 / 待查依据」改成分类呈现，那次只改了服务端 Markdown，
  // 这个页面继续渲染旧的三组——而甲方读的正是页面，于是线上实测「支持依据没生效」。
  // 与本轮 ②③⑥⑨ 完全同形：同一个呈现口径在两个出口各写各的。现在只有 clinical-fact-source 一处。
  //
  // 折叠只作用于「症状依据」（它是最长的一组、也是甲方 F3 反馈的那一组），其余分组照常全量呈现。
  const westernEvidenceGroups = westernDiagnosticEvidenceGroups(
    // 「症状依据」必须是**分类后的**症状子集，不能拿全量支持依据顶上。
    // 2026-08-12 甲方线上实测：「神清，表情痛苦」同时出现在症状依据与体征依据——
    // 根因就在这里：westernSupportingFactsAll 是全部支持依据（含体征、检查），
    // 被当成 symptom 传进来，于是每一条体征依据都被印两遍。
    // 折叠/截断仍然只作用在症状那一组（下面的展开按钮也只挂在它上面）。
    westernEvidence,
    // 甲方线上实测：「指南引用要能点开看原文」。url 一直在载荷里、服务端 Markdown 也一直在印，
    // 只有这里在拼展示串时把第三段丢了——同一份数据两个出口各写各的。现在共用同一个投影。
    (reasoning.westernDiagnosis.primary.guidelineReferences || []).map(guidelineReferenceDisplay),
  ).filter((group) => !["症状依据", "体征依据", "依据"].includes(group.label));
  // When the chain stopped at prescribe/assess, the failed stage keeps its own section with the
  // actual failure reason and an in-panel retry; downstream sections must not pretend to have run.
  const failedStage = caseState.phase === "error" && caseState.lastError ? caseState.lastError.phase : undefined;
  const prescribeStageFailed = failedStage === "prescribe";
  const assessStageFailed = failedStage === "assess";
  // 传**结构化病性条目**而不是拼接后的自由文本：拼接串会让「上热下寒」同时命中寒热两条、
  // 让「尚未化热」这类否定表述照样触发建议。buildSeasonalCare 现按 T2 病性词表逐条解析。
  const seasonalCare = buildSeasonalCare([
    ...(reasoning.pathogenesis?.natureDifferentiation?.items || []),
    ...(reasoning.pathogenesis?.natureDifferentiation?.rootDeficiency || []),
    ...(reasoning.pathogenesis?.natureDifferentiation?.branchExcess || []),
    reasoning.overview.primarySyndrome,
    ...(reasoning.overview.secondarySyndromes || []),
  ].filter((value): value is string => typeof value === "string" && Boolean(value.trim())), new Date());
  const governedSurfaceId = caseState.safetyGate?.status === "red_flag"
    ? "red_flag_escalation"
    : hasExplicitNonDoseResult
      ? "non_dose_treatment_direction"
      : "comprehensive_clinical_scheme";
  const governedSectionOrder = clinicalOutputSurface(governedSurfaceId)?.sectionOrder || [];
  const sectionOrder = (contractIds: string | string[], offset = 0) => {
    const indexes = (Array.isArray(contractIds) ? contractIds : [contractIds])
      .map((contractId) => governedSectionOrder.indexOf(contractId))
      .filter((index) => index >= 0);
    const index = indexes.length > 0 ? Math.min(...indexes) : governedSectionOrder.length;
    return index * 10 + offset;
  };
  return (
    <div
      id="cdss-section-ai"
      data-testid="ai-report-v2"
      data-governed-surface={governedSurfaceId}
      data-governed-section-order={governedSectionOrder.join(",")}
      className="flex scroll-mt-3 flex-col gap-3"
    >
      <ServerLeadingNotices caseState={caseState} />
      <SchemeSection
        order={sectionOrder(["M03-overview", "M03-western"])}
        id="cdss-section-diagnosis"
        title="诊断结论"
        subtitle="西医诊断倾向与中医诊断"
        contractIds={["M03-overview", "M03-western"]}
        rendererId="diagnosis-conclusion-section"
      >
        {/*
          xl 以上必须退回单栏：lg: 是**视口**媒体查询（≥1024px），而这张卡真正的容器是右侧 aside，
          它在 xl 以下是整幅宽度、在 xl 及以上被固定成 410/460px（见 :7049 与 :8533）。
          两者在 1280px 处分道扬镳——1440×900 下 lg: 仍然生效，但可用宽度只剩约 354px：
          右轨 minmax(18rem,…) 有 288px 硬地板、左轨下限是 0，于是西医栏被压到约 54px，
          中文逐字竖排不可读。这不是缺 min-w-0（左轨的 min 已经是 0），恰恰是因为它能塌缩到 0
          而兄弟轨有地板。断点判断的宽度和布局发生的宽度是两回事。
        */}
        <div className="grid items-start gap-3 lg:grid-cols-[minmax(0,1.15fr)_minmax(18rem,0.85fr)] xl:grid-cols-1">
          <div className="rounded-lg border border-blue-100 bg-blue-50 p-3 text-xs leading-relaxed text-blue-950">
            <p className="font-bold text-blue-800">西医诊断倾向</p>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <p className="text-sm font-semibold">{westernDiagnosisLabelForDisplay(reasoning.westernDiagnosis.primary.name, reasoning.westernDiagnosis.primary.coding)}</p>
              {reasoning.westernDiagnosis.primary.coding && (
                <span className="rounded-full border border-blue-200 bg-white px-2 py-0.5 text-[10px] font-bold text-blue-800">
                  ICD-10 {reasoning.westernDiagnosis.primary.coding.code}
                </span>
              )}
            </div>
            {reasoning.westernDiagnosis.primary.coding && reasoning.westernDiagnosis.primary.coding.display !== reasoning.westernDiagnosis.primary.name && (
              <p className="mt-1 text-[11px] text-blue-700">编码名称：{reasoning.westernDiagnosis.primary.coding.display}</p>
            )}
            {westernEvidenceGroups.map((group) => (
              <div key={group.label} className="mt-2">
                <p className="text-[11px] font-semibold text-blue-800">{group.label}</p>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  {group.items.map((item, index) => (
                    item.href ? (
                      <a
                        key={`${item.text}-${index}`}
                        href={item.href}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="rounded-md bg-white/80 px-2 py-1 text-[11px] text-blue-900 underline decoration-blue-300 underline-offset-2 hover:bg-white"
                      >
                        {item.text}
                      </a>
                    ) : (
                      <span key={`${item.text}-${index}`} className="rounded-md bg-white/80 px-2 py-1 text-[11px] text-blue-900">
                        {group.withSource ? clinicalFactWithSource(item.text, westernFactSources) : item.text}
                      </span>
                    )
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="rounded-lg border border-amber-100 bg-amber-50 p-3 text-xs leading-relaxed text-amber-950">
            <p className="font-bold text-amber-800">中医诊断</p>
            {/*
              甲方评测(2026-08-04) 1.2.1「中医诊断卡只保留证候结论，病名与病史复述移除」。
              移走的两行各有各的理由：
                · 「辨病：X」是另一个判断，它的推理（辨病推理 + 病名鉴别）本来就在下方
                  「中医辨病辨证分析」区，标题留在这张卡里等于把同一段判断劈成两半；
                · 「主症：…」取的是 primarySyndromeBasis[0]，即主诉原句——正是甲方连续两轮
                  指出的「病史复述」。它在辨证推理句里作为四诊要点出现即可，不该单列一行。
              字段本身不变：tcmDiseaseName 仍在签名载荷、HIS 方案与下方分析区中呈现。
            */}
            {tcmDiseaseName && <p className="mt-1 text-sm font-semibold">辨病：{tcmDiseaseName}</p>}
            <ClinicalCitationLinks label="中医辨病依据" citations={reasoning.overview.tcmDiseaseReferences} />
            <p className="mt-2 text-sm font-semibold">辨证：{reasoning.overview.primarySyndrome}</p>
            {reasoning.overview.secondarySyndromes && reasoning.overview.secondarySyndromes.length > 0 && (
              <p className="mt-1">兼证：{joinClinicalClauses(reasoning.overview.secondarySyndromes, "、")}</p>
            )}
            <ClinicalCitationLinks label="中医辨证依据" citations={reasoning.overview.tcmSyndromeReferences} />
            {/* 被剥离的方名：服务端可见摘要 2026-08-10 起已经写这一行，医生页面当时没跟上——
                同一个字段只接了一个出口。剥离本身是对的（方名锁定要求签名证候与该方在治理目录
                中有直接关系），但医生只看到「本例辨证组方」时，既不知道系统曾指向哪张方，
                也无从判断要不要自己采用。措辞与服务端摘要同源：明确写「未锁定、由医生判断」。 */}
            {deferredFormulaNames.length > 0 && (
              <p data-testid="deferred-formula-selection" className="mt-1 rounded-md bg-amber-100/70 px-2.5 py-2">
                <span className="font-semibold">未锁定经典方方向：</span>
                本次分析曾检索到 {joinClinicalClauses(deferredFormulaNames, "、")}
                ，但该方与本例签名证候尚无可核验的直接对应关系，因此未予锁定为候选处方；仅供医生进行方证鉴别。
              </p>
            )}
          </div>
        </div>
        {westernDifferentials.length > 0 && (
          <div data-testid="western-differentials" className="mt-3 rounded-lg border border-blue-100 bg-white p-3 text-xs leading-relaxed text-gray-700">
            <p className="font-bold text-blue-800">西医鉴别诊断</p>
            <div className="mt-2 grid gap-2 lg:grid-cols-2 xl:grid-cols-1">
              {westernDifferentials.map((item, index) => (
                <div key={`${item.name}-${index}`} className="rounded-md bg-blue-50 px-2.5 py-2">
                  <p><span className="font-semibold text-blue-900">{item.name}</span></p>
                  {isDisplayableClinicalText(item.distinguishingPoints || item.reason) && (
                    <p className="mt-1"><span className="font-semibold">鉴别要点：</span>{item.distinguishingPoints || item.reason}</p>
                  )}
                  {item.nextCheck && <p className="mt-1"><span className="font-semibold">建议检查：</span>{item.nextCheck}</p>}
                  <ClinicalCitationLinks label="参考文献" citations={item.guidelineReferences} />
                </div>
              ))}
            </div>
          </div>
        )}
        {(tcmDiseaseName || tcmDiseaseRationale || tcmRationale || tcmDiseaseDifferentials.length > 0 || tcmDifferentialBoundary) && (
          <div className="mt-3 rounded-lg border border-amber-100 bg-white p-3 text-xs leading-relaxed text-gray-700">
            <p className="font-bold text-amber-800">中医辨病辨证分析</p>
            {/* 两段推理分开呈现：辨病回答「为什么归入这个病名」，辨证回答「为什么是这个证型」。
                病名（1.2.1 从诊断卡移出）与它的归属推理归在同一处，医生一眼读到的是完整的一段判断。 */}
            {tcmDiseaseName && <p className="mt-1"><span className="font-semibold">中医病名：</span>{tcmDiseaseName}</p>}
            {tcmDiseaseRationale && <p className="mt-1"><span className="font-semibold">辨病推理：</span>{tcmDiseaseRationale}</p>}
            {tcmRationale && <p className="mt-1"><span className="font-semibold">辨证推理：</span>{tcmRationale}</p>}
            {tcmDiseaseDifferentials.length > 0 && (
              <div data-testid="tcm-disease-differentials" className="mt-2 grid gap-2 lg:grid-cols-2">
                {tcmDiseaseDifferentials.map((item, index) => (
                  <p key={`${item.diseaseName}-${index}`} className="rounded-md bg-amber-50 px-2.5 py-2">
                    <span className="font-semibold text-amber-900">鉴别 {item.diseaseName}：</span>
                    {/* typicalManifestation（该病名通常长什么样）是「鉴别要写全三件事」里的第一件，
                        此前只落到了服务端 Markdown 一个出口，医生页面读不到——读者不知道拿什么在跟本例比。 */}
                    {clinicalSentence([
                      item.typicalManifestation ? `常见：${item.typicalManifestation}` : "",
                      item.reason,
                      item.distinguishingPoints ? `区分要点：${item.distinguishingPoints}` : "",
                      item.nextCheck ? `建议核实：${item.nextCheck}` : "",
                    ], "；")}
                  </p>
                ))}
              </div>
            )}
            {tcmDifferentialBoundary && (
              <p data-testid="tcm-differential-boundary" className="mt-2 rounded-md bg-amber-50 px-2.5 py-2">
                <span className="font-semibold text-amber-900">当前鉴别边界：</span>{tcmDifferentialBoundary}
              </p>
            )}
          </div>
        )}
      </SchemeSection>

      {/* 顺序按临床逻辑：证候(上方总览) → 病机推理(总体病机/子病机链) → 治则治法 → 候选方药。
          标题取自受治理输出契约登记表，不再硬编码（甲方 3.1「总体病机显示错误，显示为病机分析了」）：
          登记表里 M03-pathogenesis 的标签是「病机拆解」，服务端可见正文渲染的也是它，
          唯独这个页面写死成「病机分析」——又一处两份标题各自演进。
          用 clinicalOutputLabel 取值后，改名只需改登记表一处，页面与正文不会再分叉。 */}
      <SchemeSection
        order={sectionOrder("M03-pathogenesis")}
        id="cdss-section-pathogenesis"
        title={clinicalOutputLabel("M03-pathogenesis", "病机拆解")}
        subtitle="总体病机、病位病性与子病机"
        contractIds="M03-pathogenesis"
        rendererId="pathogenesis-section"
      >
        {(() => {
          // 只呈现一个连贯的病机视图：模型给的结构化子字段若为空/占位("待生成/证据不足/需补充")，
          // 不再与 Markdown 兜底正文并列展示，避免"病机链证据不足 + 待生成 + 完整病机分析"这类自相矛盾。
          const p = reasoning.pathogenesis;
          const placeholder = /(暂未|证据不足|待补|待确认|待生成|不生成|无法形成|需补充关键)/;
          const overallPathogenesis = (reasoning.overview.overallPathogenesis || "").trim();
          const summaryText = (p.summary || "").trim();
          const locItems = p.locationDifferentiation.items.map((item) => item.trim()).filter(isDisplayableClinicalText);
          const locDetails = (p.locationDifferentiation.details || []).filter((item) =>
            isDisplayableClinicalText(item.location) && isDisplayableClinicalText(item.basis)
          );
          // 需求4 之后病位只按 items 渲染，details 仅用于判断本区块是否有结论（见下方注释）。
          const locationResolutionReason = (p.locationDifferentiation.resolutionReason || "").trim();
          const hasLocationConclusion = locItems.length > 0 || locDetails.length > 0 ||
            p.locationDifferentiation.resolution === "unresolved" || isDisplayableClinicalText(locationResolutionReason);
          const natItems = p.natureDifferentiation.items.map((item) => item.trim()).filter(isDisplayableClinicalText);
          const rootDeficiency = (p.natureDifferentiation.rootDeficiency || []).map((item) => item.trim()).filter(isDisplayableClinicalText);
          const branchExcess = (p.natureDifferentiation.branchExcess || []).map((item) => item.trim()).filter(isDisplayableClinicalText);
          // 需求4：病性的 basis 不再上屏，因此不再计算它的展示版本。
          const natureResolutionReason = (p.natureDifferentiation.resolutionReason || "").trim();
          const hasNatureConclusion = natItems.length > 0 || rootDeficiency.length > 0 || branchExcess.length > 0 ||
            p.natureDifferentiation.resolution === "unresolved" || isDisplayableClinicalText(natureResolutionReason);
          // 需求4：症状群只保留真正有信息量的。原过滤只要求「至少一个症状可展示 + 机制可展示」，
          // 于是两类无意义条目照样上屏：
          //   1) 只有一个症状的「群」——症状群的价值就在于多个表现指向同一机制，单症状不构成群，
          //      它已经在病机链里逐条出现过；
          //   2) 机制只是把症状换个说法重述（「入睡困难 + 多梦：睡眠障碍」），读完不增加任何判断。
          const symptomClusters = (p.symptomClusters || []).filter((item) => {
            const symptoms = (item.symptoms || []).filter(isDisplayableClinicalText);
            const mechanism = (item.mechanism || "").trim();
            if (symptoms.length < 2 || !isDisplayableClinicalText(mechanism)) return false;
            const mechanismCore = mechanism.replace(/[\s，,。；;、（）()]/g, "");
            return !symptoms.every((symptom) => {
              const core = symptom.replace(/[\s，,。；;、（）()]/g, "");
              return core.length > 0 && mechanismCore.includes(core);
            });
          });
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
          // 病机区的**单一去重权威**：按呈现顺序登记，判据是「逐字相同，或已被更长的一段完整包含」。
          // 原实现各处自写 isSameClinicalNarrative（只判逐字相等），于是 summary（病机链的合并投影）
          // 与各 chain 节点互相「不相等」，同一句病机在本区里被完整印两遍——渲染层测试正是从这里
          // 揪出来的：lib 层函数全绿，因为这段判断根本不在任何函数里，而在 JSX 的三元表达式里。
          const pathogenesisLedger = createPathogenesisNarrativeLedger();
          pathogenesisLedger.claim(overallPathogenesis);
          // summary 是病机链的合并投影。有链时逐条呈现，合并句就是纯重复，不再上屏；
          // 无链时它是本区唯一的结构化病机表述，照常显示。
          const summaryOk = chain.length === 0 &&
            isDisplayableClinicalText(summaryText) &&
            !placeholder.test(summaryText) &&
            pathogenesisLedger.claim(summaryText);
          const caseRelationship = p.caseRelationship;
          const caseRelationshipText = pathogenesisLedger.claim(caseRelationship?.relationship)
            ? caseRelationship?.relationship
            : "";
          // F5（甲方反馈）：原「查看证候与病机推理明细」折叠区与本区结构化病机视图内容重复，已移除；
          // 它唯一可能独有的 subMechanismSection 并入 fallback 链，结构化内容缺失时仍可见。
          const fallback = compactMarkdown(summary.mechanismSection || summary.patternSection || summary.subMechanismSection || "", 1200);
          const showFallback = chain.length === 0 && !summaryOk && Boolean(fallback) && fallback !== "待生成";
          const nothing = !isDisplayableClinicalText(overallPathogenesis) && !summaryOk && locItems.length === 0 && locDetails.length === 0 && natItems.length === 0 && rootDeficiency.length === 0 && branchExcess.length === 0 && symptomClusters.length === 0 && chain.length === 0 && !showFallback;
          return (
            <div className="space-y-3">
              {(hasLocationConclusion || hasNatureConclusion) && (
                <div className="grid gap-2 md:grid-cols-2">
                  {hasLocationConclusion && (
                    <div className="rounded-lg bg-amber-50 p-3">
                      <p className="text-[11px] font-bold text-amber-700">病位辨证</p>
                      {/*
                        需求4：病机区不再逐条罗列「依据」。此前病位按 details[].basis 逐条展开成
                        「脾：食少倦怠 → 归属脾」这类句子，与紧邻的病机链、证候依据大面积重复，
                        医生要在三处读同一批原文。结论本身（病位）保留，依据回到病机链一处呈现。
                        顺带消掉一类 bug：details 只是 items 的「逐字可回溯」子集，原实现是
                        details ? … : items ? … 的三元，details 非空时会把没有 detail 的病位整条吃掉
                        （心脾两虚只显示「脾」，「心」在界面上凭空消失）。现在统一按 items 渲染，
                        两个列表不再有分歧，locDetails / locItemsWithoutDetail 也不再参与展示。
                      */}
                      {locItems.length > 0 ? (
                        <p className="mt-1 text-xs leading-relaxed text-amber-950">{joinClinicalClauses(locItems, "、")}</p>
                      ) : (
                        <p className="mt-1 text-xs leading-relaxed text-amber-950">
                          {locationResolutionReason || "当前记录尚不能支持明确病位归属"}
                        </p>
                      )}
                      {/* 甲方 UI 决策：外部参考资料核验展示下线（意义不大）；证据仍在结构化载荷与 HIS 载荷中。 */}
                    </div>
                  )}
                  {hasNatureConclusion && (
                    <div className="rounded-lg bg-rose-50 p-3">
                      <p className="text-[11px] font-bold text-rose-700">病性辨证</p>
                      {(natItems.length > 0 || rootDeficiency.length > 0 || branchExcess.length > 0) ? (
                        <p className="mt-1 text-xs leading-relaxed text-rose-950">
                          {joinClinicalClauses(natItems.length > 0 ? natItems : [...rootDeficiency, ...branchExcess], "、")}
                        </p>
                      ) : (
                        <p className="mt-1 text-xs leading-relaxed text-rose-950">
                          {natureResolutionReason || "当前记录尚不能支持明确病性归纳"}
                        </p>
                      )}
                      {/* 需求4：病性同样不再单列「判断依据」，理由同病位——依据统一回到病机链一处。 */}

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
              {caseRelationship && [caseRelationship.rootPattern, caseRelationship.mainManifestation, caseRelationshipText].some(isDisplayableClinicalText) && (
                <div className="grid gap-2 rounded-lg border border-violet-100 bg-violet-50 p-3 text-xs leading-relaxed text-violet-950 md:grid-cols-3">
                  <div><p className="text-[11px] font-bold text-violet-700">本证</p><p className="mt-1">{caseRelationship.rootPattern}</p></div>
                  <div><p className="text-[11px] font-bold text-violet-700">主要表现</p><p className="mt-1">{caseRelationship.mainManifestation}</p></div>
                  {isDisplayableClinicalText(caseRelationshipText) && (
                    <div><p className="text-[11px] font-bold text-violet-700">病机联系</p><p className="mt-1">{caseRelationshipText}</p></div>
                  )}
                </div>
              )}
              {symptomClusters.length > 0 && (
                <div className="rounded-lg border border-sky-100 bg-sky-50 p-3">
                  <p className="text-[11px] font-bold text-sky-700">症状群与病机联系</p>
                  <div className="mt-2 space-y-1.5 text-xs leading-relaxed text-sky-950">
                    {symptomClusters.map((item, index) => (
                      <p key={`${item.mechanism}-${index}`}><span className="font-semibold">{item.symptoms.filter(isDisplayableClinicalText).join(" + ")}：</span>{clinicalTextForDisplay(item.mechanism)}</p>
                    ))}
                  </div>
                </div>
              )}
              {chain.length > 0 && (
                <div className="space-y-2">
                  <p className="text-[11px] font-bold text-gray-500">子病机与对应治法</p>
                  {chain.map((step, index) => {
                    // 与上方同一本账本：本区里已完整呈现过的病机不再重复，只保留节点特有的部分。
                    const pathogenesisDisplay = step.pathogenesis;
                    const relatedClusterFacts = symptomClusters
                      .filter((cluster) => {
                        const mechanism = clinicalEvidenceFingerprint(cluster.mechanism);
                        const pathogenesis = clinicalEvidenceFingerprint(step.pathogenesis);
                        return mechanism.includes(pathogenesis) || pathogenesis.includes(mechanism);
                      })
                      .flatMap((cluster) => cluster.symptoms);
                    const evidenceDisplay = prioritizeTcmEvidenceForDisplay(
                      [step.syndromeEvidence],
                      relatedClusterFacts.length > 0 ? relatedClusterFacts : tcmGroundedAlternativeFacts,
                      caseState.chiefComplaint || caseState.hisRecord?.fields?.zhushu || "",
                      2,
                    );
                    return (
                    <div key={`${step.pathogenesis}-${index}`} className="rounded-lg border border-gray-100 bg-gray-50 p-3 text-xs leading-relaxed">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <p className="font-semibold text-gray-900">子病机 {index + 1}</p>
                        {step.pathogenesisType && <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-bold text-amber-700" title="病机在本例演变链中的位置">{step.pathogenesisType}</span>}
                      </div>
                      <div className="mt-2 grid gap-1.5 md:grid-cols-2">
                        <p className="rounded-md bg-white px-2 py-1.5 text-gray-700"><span className="font-semibold">患者事实：</span>{step.patientFact}</p>
                        <p className="rounded-md bg-white px-2 py-1.5 text-sky-800">
                          <span className="font-semibold">辨证关键依据：</span>
                          {joinClinicalClauses(evidenceDisplay.length > 0 ? evidenceDisplay : [step.syndromeEvidence], "；")}
                        </p>
                      </div>
                      {isDisplayableClinicalText(pathogenesisDisplay) && (
                        <p className="mt-1 text-amber-800"><span className="font-semibold">病机演变：</span>{pathogenesisDisplay}</p>
                      )}
                      <p className="mt-1 text-emerald-800"><span className="font-semibold">对应治法：</span>{step.therapyDirection}</p>
                    </div>
                    );
                  })}
                </div>
              )}
              {p.uncertainties.length > 0 && (
                <details className="rounded-lg border border-gray-100 bg-white">
                  <summary className="cursor-pointer list-none px-3 py-2 text-xs font-semibold text-gray-700">影响判断的待核实信息</summary>
                  <div className="space-y-1.5 border-t border-gray-100 px-3 py-2 text-xs leading-relaxed text-gray-600">
                    {p.uncertainties.map((item, index) => (
                      <p key={`${item.item}-${index}`}><span className="font-semibold text-gray-800">{item.item}：</span>{clinicalSentence([item.reason, item.affects ? `可能影响${item.affects}` : ""], "；")}</p>
                    ))}
                  </div>
                </details>
              )}
              {showFallback && <MarkdownBlock content={fallback} compact />}
              {nothing && null}
            </div>
          );
        })()}
      </SchemeSection>

      <SchemeSection
        order={sectionOrder("M03-therapy")}
        id="cdss-section-differentiation"
        title="治则治法"
        subtitle="治则、总治法与分治方向"
        contractIds="M03-therapy"
        rendererId="therapy-section"
      >
        <div className="space-y-3">
          <div className="grid gap-2 md:grid-cols-2">
            <SummaryLine label="治则" value={reasoning.therapy.overallPrinciple || summary.treatmentPrinciple} tone="green" />
            <SummaryLine label="总治法" value={reasoning.therapy.overallMethod || reasoning.overview.overallTherapy} tone="blue" />
          </div>
          {reasoning.therapy.subTherapies.length > 0 && (
              <div className="grid gap-2 md:grid-cols-2">
                {reasoning.therapy.subTherapies.map((item, index) => (
                  <div key={`${item.therapy}-${index}`} className="rounded-lg border bg-gray-50 p-3 text-xs leading-relaxed text-gray-700">
                    <p className="font-semibold text-gray-950">{item.priority === "主要" ? "主要治法" : "兼顾治法"}：{item.therapy}</p>
                    {isDisplayableClinicalText(item.targetPathogenesis) && <p className="mt-1">对应病机：{item.targetPathogenesis}</p>}
                  </div>
                ))}
              </div>
          )}
        </div>
      </SchemeSection>

      {(() => {
        // 流派适配记录：可展示判据与 Markdown 摘要、HIS 方案共用 displayableLineageAdaptation
        //（未选具体流派或内容为空壳时三个出口一致不出现）。
        const lineageDisplay = displayableLineageAdaptation(reasoning.lineageAdaptation);
        if (!lineageDisplay) return null;
        return (
          <SchemeSection
            order={sectionOrder("M03-M04-lineage")}
            id="cdss-section-lineage"
            title="流派适配记录"
            subtitle="所选诊疗思路对本例判断的影响"
            contractIds="M03-M04-lineage"
            rendererId="lineage-adaptation-section"
          >
            <div className="space-y-2" data-testid="lineage-adaptation-card">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-[11px] font-bold text-indigo-700">{lineageDisplay.label}</span>
                <span className="text-xs text-gray-600">本例{lineageDisplay.applicability}</span>
              </div>
              {lineageDisplay.reason && <p className="text-xs leading-relaxed text-gray-700">{lineageDisplay.reason}</p>}
              {lineageDisplay.influencedDecisions.length > 0 && (
                <div className="grid gap-2 md:grid-cols-2">
                  {lineageDisplay.influencedDecisions.map((item, index) => (
                    <div key={`${item.aspect}-${index}`} className="rounded-lg border bg-gray-50 p-3 text-xs leading-relaxed text-gray-700">
                      <p className="font-semibold text-gray-950">{item.aspect}</p>
                      <p className="mt-1">{item.detail}</p>
                    </div>
                  ))}
                </div>
              )}
              {lineageDisplay.alternativeDirection && (
                <p className="text-xs leading-relaxed text-gray-700"><span className="font-semibold">替代方向：</span>{lineageDisplay.alternativeDirection}</p>
              )}
              <p className="text-[11px] text-gray-500">{lineageDisplay.safetyBoundary}</p>
            </div>
          </SchemeSection>
        );
      })()}

      {prescribeStageFailed && onRetry && (
        <SchemeSection order={sectionOrder("M04-formula")} id="cdss-section-prescription" title="候选方药" subtitle="本阶段未完成" contractIds="M04-formula" rendererId="formula-section">
          <StageErrorCard caseState={caseState} onRetry={onRetry} />
        </SchemeSection>
      )}

      {firstCandidate && <SchemeSection order={sectionOrder("M04-formula")} id="cdss-section-prescription" title="候选方药" subtitle="方名、出处、药味、方义与煎服" contractIds="M04-formula" rendererId="formula-section">
        <div className="space-y-3">
          {firstCandidate ? (
            <div className="space-y-3">
              <div className="rounded-xl border border-rose-100 bg-rose-50 px-3 py-2">
                <div className="min-w-0">
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <h3 className="text-base font-bold text-gray-950">{firstCandidate.name}</h3>
                    {firstCandidate.constructionType === "self_devised" && (
                      <span data-testid="self-devised-formula-badge" className="rounded-full border border-violet-200 bg-white px-2 py-0.5 text-[10px] font-bold text-violet-700">
                        自拟方
                      </span>
                    )}
                    {firstCandidate.constructionType === "single_herb" && (
                      <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-bold text-slate-700">
                        单味方案
                      </span>
                    )}
                  </div>
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
              {firstCandidate.constructionType !== "self_devised" &&
                firstCandidate.constructionType !== "single_herb" &&
                shouldRenderEvidenceStatus(firstCandidate.formulaSource) && (
                <div className={`rounded-lg border p-3 text-xs leading-relaxed ${firstCandidate.formulaSource.evidenceLevel === "insufficient" ? "border-amber-200 bg-amber-50 text-amber-950" : "border-blue-100 bg-blue-50 text-blue-950"}`}>
                  <p className={`font-bold ${firstCandidate.formulaSource.evidenceLevel === "insufficient" ? "text-amber-800" : "text-blue-800"}`}>
                    {firstCandidate.formulaSource.evidenceLevel === "kb_entry"
                      ? "方剂资料收载来源"
                      : firstCandidate.constructionType === "combined"
                        ? "合方基础方出处"
                        : firstCandidate.modificationStatus === "modified"
                          ? "参考基础方及出处"
                          : "经典方出处"}
                  </p>
                  {firstCandidate.formulaSource?.source && (
                    <p className="mt-1 text-xs text-blue-900">{firstCandidate.formulaSource.source}</p>
                  )}
                  {firstCandidate.constructionType === "combined" && firstCandidate.baseFormulas && firstCandidate.baseFormulas.length > 1 && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {firstCandidate.baseFormulas.map((base) => (
                        <span key={`${base.name}-${base.source}`} className="rounded-full border border-blue-100 bg-white px-2.5 py-1 text-[11px] font-semibold text-blue-800">
                          {base.name}：{base.source}；{base.verificationStatus === "verified_individually" ? "逐方已核验" : "来源参考"}；组成 {base.matchedIngredientCount}/{base.totalIngredientCount || "?"} 味{base.requiredIngredientCount != null ? `，核心药味 ${base.matchedRequiredIngredientCount || 0}/${base.requiredIngredientCount}` : ""}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <ClassicEvidencePanel evidence={firstCandidate.classicEvidence} />
              <DecoctionInstructionsPanel decoction={firstCandidate.decoction} />
              <div className="overflow-x-auto rounded-xl border">
                <div className="min-w-[640px]">
                {/* 甲方 UI 决策：逐味「本例配伍意义」与方义解析重复，删列；全方配伍思路
                    统一在独立的「方义解析」模块呈现。 */}
                <div className="grid grid-cols-[1fr_0.6fr_0.5fr_1.4fr] gap-2 border-b bg-gray-50 px-3 py-2 text-[11px] font-bold text-gray-500">
                  <span>药名</span><span>剂量</span><span>角色</span><span>对应病机</span>
                </div>
                <div className="divide-y divide-gray-100">
                  {firstCandidate.herbs.map((herb, index) => {
                    const warning = firstCandidateWarnings[index];
                    // 「对应病机」列与服务端 Markdown 共用同一份去重呈现（见 formulaTargetPathogenesisCells）：
                    // 同一段病机在本表里只完整写一次。此前是逐味印一遍——15 味方就把同一句印 15 遍，
                    // 这是甲方第 3 条「病机内容重复」在页面上最大的单一来源，而 lib 层测试看不到它，
                    // 因为这张表不是任何函数的返回值，是在 JSX 里逐行拼出来的。
                    const rowTone =
                      warning.level === "L4" ? "border-l-red-900 bg-red-50/70" :
                      warning.level === "L3" ? "border-l-red-500 bg-red-50/40" :
                      warning.level === "L2" ? "border-l-orange-400 bg-orange-50/30" :
                      warning.level === "L1" ? "border-l-amber-300 bg-amber-50/20" :
                      "border-l-slate-300";
                    const badgeTone =
                      warning.level === "L4" ? "bg-red-900 text-white" :
                      warning.level === "L3" ? "bg-red-100 text-red-800" :
                      warning.level === "L2" ? "bg-orange-100 text-orange-800" :
                      warning.level === "L1" ? "bg-amber-100 text-amber-800" :
                      "bg-slate-100 text-slate-700";
                    return (
                    <div
                      key={`${herb.name}-${index}`}
                      data-warning-level={warning.level}
                      className={`border-l-4 px-3 py-2 text-xs leading-relaxed text-gray-700 ${rowTone}`}
                    >
                      <div className="grid grid-cols-[1fr_0.6fr_0.5fr_1.4fr] gap-2">
                        <span className="font-semibold text-gray-950">
                          {herb.name}{herb.processing ? `（${herb.processing}）` : ""}
                          {/* 甲方评测(2026-08-04) 第 1 条「混入 L0/L1/L3 等工程标签」的**可复现来源**就在这里：
                              ClinicalWarningLevel 是内部分级枚举（L0–L4），这枚 chip 此前把枚举值本身印在
                              每一味药后面，医生看到的是「桂枝 L0 9g 君 …」。分级枚举有现成的中文标签
                              （clinical-warning-tier.ts 的 LABELS，经 profile().label 暴露），改印标签。
                              L0＝「常规信息」即未命中任何额外警示，一枚说「没事」的 chip 是纯噪音，整枚不渲染；
                              data-warning-level 属性保留，机器读取与测试定位不受影响。 */}
                          {warning.level !== "L0" && (
                            <span className={`ml-1.5 inline-flex rounded-full px-1.5 py-0.5 align-middle text-[9px] font-bold ${badgeTone}`} title={warning.reasons.join("；")}>
                              {warning.label}
                            </span>
                          )}
                        </span>
                        <span className={warning.level === "L2" || warning.level === "L3" || warning.level === "L4" ? "font-semibold text-orange-800" : ""}>
                          {herb.verificationTier === "identity_pending" ? "待核定" : herb.dose}
                        </span>
                        <span>{herb.role}</span>
                        <span>{firstCandidateTargetCells[index]}</span>
                      </div>
                      {(warning.level !== "L0" || herb.isToxic || herb.decoctionRequirement) && (
                        <div className="mt-2 rounded-lg bg-gray-50 p-2 text-[11px] text-gray-600">
                          {warning.level !== "L0" && <p><span className="font-semibold text-gray-700">分级理由：</span>{warning.reasons.join("；")}</p>}
                          {herb.doseSource && <p><span className="font-semibold text-gray-700">剂量来源：</span>{doseSourceLabelForDisplay(herb.doseSource)}</p>}
                          {herb.isToxic && <p><span className="font-semibold text-gray-700">药味注意：</span>毒性/峻烈药需严守炮制剂量。</p>}
                          {herb.decoctionRequirement && <p><span className="font-semibold text-gray-700">特殊煎法：</span>{herb.decoctionRequirement}</p>}
                        </div>
                      )}
                    </div>
                  )})}
                </div>
                </div>
              </div>
              {/*
                需求6：药味加减要以「随证加减建议」的形式主动给出，而不是把加减这件事整个丢给
                药味工作台让医生自己改。因此这一块即使为空也要出现——否则医生分不清
                「系统评估过、本方已覆盖各兼症」与「系统压根没做这件事」。
              */}
              {formula ? (
                <div
                  className="rounded-lg border bg-gray-50 p-3"
                  data-clinical-contract-ids="M04-modifications"
                  data-clinical-renderer="formula-modification-list"
                >
                  <p className="text-sm font-semibold text-gray-950">随证加减建议</p>
                  <p className="mt-1 text-[11px] leading-relaxed text-gray-500">针对本次病历已记录、主方未直接针对的兼症给出加减提示；采用后须按调整后的完整处方重新审方。</p>
                  {!formula.modifications?.length && (
                    <p className="mt-2 rounded-md bg-white px-2.5 py-2 text-xs leading-relaxed text-gray-600">
                      本次病历已记录的表现均已由主方药味直接覆盖，暂无需额外加减；如复诊时出现新的兼症，可在药味工作台调整后重新审方。
                    </p>
                  )}
                  {/* 多条加减常挂在同一个病机上；与服务端 Markdown 共用同一本去重账本，
                      本节内的病机原文只完整写一次（甲方评测 2026-08-04 第 3 条）。 */}
                  <div className="mt-2 space-y-2">
                    {(formula.modifications || []).map((item, index) => {
                      const cell = modificationCells[index];
                      return (
                      <div key={`${item.trigger}-${index}`} className="rounded-lg border bg-white p-3 text-xs leading-relaxed text-gray-700">
                        <p><span className="font-semibold text-gray-950">{item.trigger}：</span>{item.action}{item.doseOrHandling ? `（${item.doseOrHandling}）` : ""}</p>
                        {cell.target && (
                          <p className="mt-1"><span className="font-semibold text-gray-900">对应病机：</span>{clinicalSentence([cell.target, cell.reason], "；")}</p>
                        )}
                        {!cell.target && cell.reason && (
                          <p className="mt-1"><span className="font-semibold text-gray-900">加减理由：</span>{cell.reason}</p>
                        )}
                        {/* 甲方 UI 决策：不再逐条渲染「触发依据」（整段现病史原文逐条重复）与
                            「采用前」（每条同一句审方套话）——加减依据已并入对应病机行，
                            重新审方的要求由本节副标题一次性说明。 */}
                      </div>
                    )})}
                  </div>
                </div>
              ) : null}
              {/* 甲方 UI 决策 2026-08-02：药味加减工作台从结果区下线（「工作台的位置不在这，
                  我们不用做」）。组件实现与 handleAcceptEditedPrescription 链路保留，待产品
                  确定新入口后重新挂载；方义解析移出本节，单独成块（见下方 SchemeSection）。 */}
            </div>
          ) : caseState.phase === "prescribe" ? null : (
            <PrescriptionPlanTabs summary={summary} />
          )}
        </div>
      </SchemeSection>}

      {formula && firstCandidate?.formulaAnalysis && isDisplayableClinicalText(firstCandidate.formulaAnalysis) && (
        <SchemeSection
          order={sectionOrder("M04-formula", 2)}
          id="cdss-section-formula-analysis"
          title="方义解析"
          subtitle="各药在方中作用与配伍关系"
          contractIds="M04-formula"
          rendererId="formula-analysis-section"
        >
          {/* 新结果是连续自然段；历史快照可能仍含 Markdown 标题/列表，统一经过 MarkdownBlock，
              防止星号与短横线作为原始语法直接暴露给医生。 */}
          <div className="rounded-lg border border-blue-100 bg-blue-50 p-3 text-sm leading-relaxed text-blue-950">
            <MarkdownBlock content={firstCandidate.formulaAnalysis} compact />
          </div>
        </SchemeSection>
      )}

      {hasExplicitNonDoseResult && !prescribeStageFailed && (
        <SchemeSection order={sectionOrder("M04-formula")} id="cdss-section-prescription" title="候选方药" subtitle="本轮非剂量安全结论" contractIds="M04-formula" rendererId="formula-section">
          <div data-testid="non-dose-prescription-result" className="space-y-3">
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-relaxed text-amber-950">
              <p className="font-bold text-amber-800">当前结论</p>
              {summary.currentConclusionSection ? (
                <div className="mt-1">
                  <MarkdownBlock content={compactMarkdown(summary.currentConclusionSection, 1200)} compact />
                </div>
              ) : (
                <p className="mt-1">当前资料可用于辨病辨证和调护建议，但尚不具备安全生成具体药味剂量、剂数及煎服法的条件；请按下方核查项补充后重新评估。</p>
              )}
            </div>
            {unclearScopeAwaitingConfirmation && (
              <div className="rounded-lg border border-sky-200 bg-sky-50 p-3 text-xs leading-relaxed text-sky-950">
                <p className="font-bold text-sky-800">本次就诊目标待医生确认</p>
                <p className="mt-1">语义预检尚未确认本次就诊是否存在当前活动性治疗目标，因此未生成具体剂量。如确认本次确有需要治疗的目标，可确认后重新生成候选方药；如病情有变化，请先补充病历后再重新分析。</p>
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

      {hasMedicineCandidates && <SchemeSection order={sectionOrder("M04-patent-western", 1)} id="cdss-section-medicine" title={clinicalOutputLabel("M04-patent-western", "中成药/西药候选")} subtitle="基于西医诊断与证据的独立候选方案" contractIds="M04-patent-western" rendererId="medicine-section">
        <StructuredMedicinePlanCards candidates={medicineCandidates} caseState={caseState} />
      </SchemeSection>}
      {!hasMedicineCandidates && caseState.phase !== "diagnose" && caseState.phase !== "prescribe" && (
        <SchemeSection order={sectionOrder("M04-patent-western", 1)} id="cdss-section-medicine" title="中成药候选" subtitle="本地证型检索结果；西药需外部说明书证据" contractIds="M04-patent-western" rendererId="medicine-section">
          <div className="space-y-1.5 text-xs leading-relaxed text-gray-600">
            <p className="font-semibold text-gray-900">{medicineCandidateEmptyState.headline}</p>
            <p>{formula?.medicineCandidateStatus?.reason || medicineCandidateEmptyState.explanation}</p>
            <p className="text-blue-700">{medicineCandidateEmptyState.action}</p>
          </div>
        </SchemeSection>
      )}

      {firstCandidate && <AuditReviewSection order={sectionOrder("M04-formula", 2)} caseState={caseState} content={summary.medicineRiskSection} />}

      {assessStageFailed && onRetry && (
        <SchemeSection order={sectionOrder("M05-assessment")} id="cdss-section-assess" title={clinicalOutputLabel("M05-assessment", "风险与随访汇总")} subtitle="本阶段未完成" contractIds="M05-assessment" rendererId="audit-followup-section">
          <StageErrorCard caseState={caseState} onRetry={onRetry} />
        </SchemeSection>
      )}

      {clinicianTreatmentProjects.length > 0 && (
        <SchemeSection
          order={sectionOrder("M03-M04-tcm-treatment")}
          id="cdss-section-tcm-treatment"
          title="中医非药物方案"
          contractIds="M03-M04-tcm-treatment"
          rendererId="tcm-treatment-section"
        >
          <div className="grid gap-2 sm:grid-cols-2">
            {clinicianTreatmentProjects.map((item, index) => (
              <div key={`${item.projectCode}-${index}`} className="rounded-lg border border-gray-200 bg-white p-3 text-xs leading-relaxed text-gray-700">
                <p className="font-semibold text-gray-950">{item.title}</p>
                <p className="mt-2"><span className="font-medium text-gray-900">核心内容：</span>{item.content}</p>
                {item.sitesOrPoints && item.sitesOrPoints.length > 0 && (
                  <p className="mt-1"><span className="font-medium text-gray-900">穴位/部位：</span>{joinClinicalClauses(item.sitesOrPoints, "；")}</p>
                )}
                {item.schedule && (
                  <p className="mt-1"><span className="font-medium text-gray-900">频次/复评：</span>{item.schedule}</p>
                )}
              </div>
            ))}
          </div>
        </SchemeSection>
      )}

      <SchemeSection
        order={sectionOrder(["M03-M04-nonpharma", "M03-M04-management"])}
        id="cdss-section-followup"
        title="健康调护与注意事项"
        subtitle="饮食起居、情志调护、注意事项与随访安全网"
        contractIds={["M03-M04-nonpharma", "M03-M04-management"]}
        rendererId="followup-care-section"
      >
        <div className="space-y-3">
          {reasoning.nonPharma ? (
            <div className="grid gap-2">
              {!hasDietTherapyProject && (
                <SummaryLine label="饮食调养" value={safeDietAdviceForDisplay(reasoning.nonPharma.diet, caseState)} tone="green" />
              )}
              <SummaryLine label="生活方式" value={reasoning.nonPharma.lifestyle} tone="blue" />
              <SummaryLine label="情志调护" value={reasoning.nonPharma.emotion} tone="amber" />
              {reasoning.nonPharma.acupointCare && <SummaryLine label="穴位/外治" value={reasoning.nonPharma.acupointCare} tone="blue" />}
              {/* 中医治疗项目已上移为独立模块（cdss-section-tcm-treatment），此处不再重复渲染。 */}
              {seasonalCare && <SummaryLine label={`节气调护（${seasonalCare.solarTerm}）`} value={`${seasonalCare.climateFocus}：${seasonalCare.advice}`} tone="green" />}
              {reasoning.nonPharma.precautions.length > 0 && (
                <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-3">
                  <p className="mb-1.5 text-xs font-semibold text-amber-900">注意事项</p>
                  <ul className="list-disc space-y-1 pl-4 text-xs leading-relaxed text-amber-900">
                    {reasoning.nonPharma.precautions.map((item, index) => (
                      <li key={`precaution-${index}`}>{item}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : summary.nonDrugSection ? (
            <MarkdownBlock content={compactMarkdown(summary.nonDrugSection, 1200)} compact />
          ) : (
            // 空态必须可见：此前 nonPharma 为空时本模块只剩标题+随访占位，视觉上等于「模块消失」
            //（甲方实测反馈）。明示未生成并给出动作，而不是静默留白。
            <p className="rounded-lg border border-dashed border-gray-200 bg-gray-50 px-3 py-2 text-xs leading-relaxed text-gray-500">
              本轮未生成饮食/起居/情志调护内容；可点击「重新生成」补齐，或由医生按本例证候直接补充。
            </p>
          )}
          {summary.rehabSection && <MarkdownBlock content={compactMarkdown(summary.rehabSection, 1400)} compact />}
          {reasoning.management && (
            <div className="grid gap-2 md:grid-cols-2">
              {/* 甲方线上实测（0811）：基础病史/生命体征/查体都还没有的病例，「需优先补充」里
                  头颅 CT、经颅多普勒与"问病程"并列，等于把最贵的检查放进了第一步。分级判据
                  buildTieredSuggestedChecks 早就写好了，只是在 851e4d76（治法词表对账）里被
                  连带删掉了调用，从此成了死代码——所以线上看到的是模型原样自由文本。 */}
              <SummaryLine label="需优先补充" value={joinClinicalClauses(buildTieredSuggestedChecks(caseState, reasoning.management.mustCollect || []), "；")} tone="blue" />
              <SummaryLine label="风险复评" value={reasoning.management.redFlagLoop} tone="amber" />
              <SummaryLine label="随访安全网" value={reasoning.management.followupSafetyNet} tone="amber" />
            </div>
          )}
        </div>
      </SchemeSection>
    </div>
  );
}

function EmergencyReferralReport({
  caseState,
  onDownloadReport,
  onConfirmEmergencyClearance,
}: {
  caseState: CaseState;
  onDownloadReport: () => void;
  onConfirmEmergencyClearance: (
    assessmentSummary: string,
    findings: EmergencyClearanceFindingAttestation[],
  ) => Promise<void>;
}) {
  const gate = caseState.safetyGate || evaluateSafetyGate(caseState);
  const presentation = buildEmergencyPresentation(caseState);
  const [assessmentSummary, setAssessmentSummary] = useState("");
  const [isConfirming, setIsConfirming] = useState(false);
  // 逐条处置留痕。判据与服务端签发端共用 emergency-clearance-contract 的同一个导出谓词——
  // 此前这里与服务端各写一遍 `length >= 12`，而那正是「一句废话清空全部红旗」的入口。
  const activeFindings = useMemo(() => activeEmergencyClearanceFindingsFromGate(gate), [gate]);
  const [dispositions, setDispositions] = useState<Record<string, string>>({});
  const [bases, setBases] = useState<Record<string, string>>({});
  const attestations = useMemo(() => activeFindings.flatMap((finding) => {
    const key = emergencyClearanceFindingKey(finding);
    const disposition = dispositions[key];
    const basis = (bases[key] || "").trim();
    return disposition && basis
      ? [{ ruleId: finding.ruleId, message: finding.message, disposition, basis } as EmergencyClearanceFindingAttestation]
      : [];
  }), [activeFindings, dispositions, bases]);
  const contractIssue = emergencyClearanceContractIssue({
    activeFindings,
    attestations: attestations.length === activeFindings.length ? attestations : undefined,
    assessmentSummary,
  });
  const canConfirm = !contractIssue && !isConfirming;
  const missingItems = [...new Set(gate.missingItems)].filter(Boolean);

  return (
    <div
      id="cdss-section-ai"
      data-testid="ai-report-red-flag"
      data-clinical-contract-ids="red-flag-warning"
      data-clinical-renderer="emergency-referral-report"
      className="space-y-3 scroll-mt-3"
    >
      <div className="rounded-xl border border-red-300 bg-red-50 p-4">
        <p className="text-[11px] font-bold tracking-wide text-red-700">{presentation.pageTitle}</p>
        <h2 className="mt-1 text-lg font-bold leading-snug text-red-950">{presentation.eventTitle}</h2>
        <p className="mt-2 text-sm font-semibold leading-relaxed text-red-800">{presentation.immediateAction}</p>
      </div>

      <div className="rounded-xl border border-red-100 bg-white p-4">
        <p className="text-xs font-bold text-gray-900">触发证据（患者原文）</p>
        <div className="mt-2 flex flex-wrap gap-2" data-testid="emergency-evidence-chips">
          {presentation.evidenceChips.length > 0 ? presentation.evidenceChips.map((evidence) => (
            <span key={evidence} className="rounded-full border border-red-200 bg-red-50 px-2.5 py-1 text-[11px] font-semibold text-red-800">
              {evidence}
            </span>
          )) : (
            <span className="text-xs text-gray-500">当前结构化病历事实已命中急危重症规则。</span>
          )}
        </div>
        <p className="mt-3 text-sm leading-relaxed text-gray-800">{presentation.clinicalConcern}</p>
        {presentation.escalationRationale && (
          <p className="mt-2 border-l-2 border-red-200 pl-3 text-xs leading-relaxed text-gray-600">
            组合判断：{presentation.escalationRationale}
          </p>
        )}
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-4">
        <p className="text-xs font-bold text-gray-900">你需要做的</p>
        <ol className="mt-2 space-y-2 text-sm leading-relaxed text-gray-700">
          {presentation.actions.map((action, index) => (
            <li key={action} className="flex gap-2">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-red-50 text-[11px] font-bold text-red-700">{index + 1}</span>
              <span>{action}</span>
            </li>
          ))}
        </ol>
      </div>

      <div className="rounded-xl border border-sky-200 bg-sky-50 p-4">
        <p className="text-xs font-bold text-sky-950">已完成现场急症排查时，请逐条记录处置方式与客观依据</p>
        <p className="mt-1 text-[11px] leading-relaxed text-sky-800">
          下面每一条都是系统确定性判定的急危重线索。解除急诊约束的记录必须写明**做过什么**
          （心电图、复测血压、已转急诊完成交接…），不能只写一段感受性描述。
        </p>
        <div className="mt-3 space-y-3" data-testid="emergency-clearance-findings">
          {activeFindings.map((finding) => {
            const key = emergencyClearanceFindingKey(finding);
            const disposition = dispositions[key] || "";
            const hint = EMERGENCY_CLEARANCE_DISPOSITIONS.find((item) => item.value === disposition)?.basisHint
              || "写明做了哪项检查/复测/转诊及其结果";
            return (
              <div key={key} className="rounded-lg border border-sky-200 bg-white p-3">
                <p className="text-xs font-semibold leading-relaxed text-red-900">{finding.message}</p>
                <select
                  data-testid={`emergency-clearance-disposition-${finding.ruleId}`}
                  value={disposition}
                  onChange={(event) => setDispositions((prev) => ({ ...prev, [key]: event.target.value }))}
                  className="mt-2 w-full rounded-lg border border-sky-200 bg-white px-2 py-1.5 text-xs font-semibold text-gray-900 outline-none focus:border-sky-400"
                >
                  <option value="">请选择本条的处置方式…</option>
                  {EMERGENCY_CLEARANCE_DISPOSITIONS.map((item) => (
                    <option key={item.value} value={item.value}>{item.label}</option>
                  ))}
                </select>
                <input
                  data-testid={`emergency-clearance-basis-${finding.ruleId}`}
                  value={bases[key] || ""}
                  onChange={(event) => setBases((prev) => ({ ...prev, [key]: event.target.value.slice(0, 500) }))}
                  maxLength={500}
                  placeholder={hint}
                  className="mt-2 w-full rounded-lg border border-sky-200 bg-white px-2 py-1.5 text-xs leading-relaxed text-gray-900 outline-none focus:border-sky-400"
                />
              </div>
            );
          })}
        </div>
        <label className="mt-3 block text-xs font-bold text-sky-950" htmlFor="emergency-clearance-summary">
          现场评估或急诊排查结果小结
        </label>
        <textarea
          id="emergency-clearance-summary"
          data-testid="emergency-clearance-summary"
          value={assessmentSummary}
          onChange={(event) => setAssessmentSummary(event.target.value.slice(0, 1_000))}
          maxLength={1_000}
          rows={3}
          placeholder="例如：血压复测正常，意识清楚，瞳孔等大等圆，神经系统查体未见局灶异常；已经急诊影像评估排除急性神经血管事件。"
          className="mt-2 w-full resize-y rounded-lg border border-sky-200 bg-white px-3 py-2 text-sm leading-relaxed text-gray-900 outline-none focus:border-sky-400"
        />
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            data-testid="confirm-emergency-clearance"
            disabled={!canConfirm}
            onClick={async () => {
              setIsConfirming(true);
              try {
                await onConfirmEmergencyClearance(assessmentSummary.trim(), attestations);
              } finally {
                setIsConfirming(false);
              }
            }}
            className="inline-flex items-center gap-1.5 rounded-lg bg-teal-700 px-3 py-2 text-xs font-bold text-white hover:bg-teal-800 disabled:cursor-not-allowed disabled:bg-gray-300"
          >
            {isConfirming ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            已完成急症排查，继续常规诊疗
          </button>
          <button
            type="button"
            onClick={onDownloadReport}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-bold text-gray-700 hover:bg-gray-50"
          >
            <Download className="h-3.5 w-3.5" />
            下载转诊建议与依据
          </button>
        </div>
        {contractIssue && (
          <p data-testid="emergency-clearance-blocked-reason" className="mt-2 text-[11px] font-semibold leading-relaxed text-red-700">
            {emergencyClearanceIssueMessage(contractIssue)}
          </p>
        )}
        <p className="mt-2 text-[11px] leading-relaxed text-sky-800">确认记录只对当前红旗事实有效；病历出现新的急危重线索时会自动重新拦截。</p>
      </div>

      <p className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs leading-relaxed text-gray-600">
        辨病辨证与候选方药照常生成并附安全警示；在完成上述急诊/转诊评估之前，请勿采纳其中的用药内容。
      </p>

      {missingItems.length > 0 && (
        <details className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs text-gray-500">
          <summary className="cursor-pointer font-semibold text-gray-600">待补充信息（不影响当前急诊处置）</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {missingItems.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </details>
      )}
    </div>
  );
}

/**
 * 结果区的根组件（内部渲染 ResultTabsV2 等全部方案卡片）。
 *
 * 导出**仅为渲染层测试**：`scripts/test-visible-output-hygiene.mjs` 用 `react-dom/server` 把它
 * 渲染成静态 HTML、抽出纯文本，再对**医生真正看到的字**做断言。本仓库 69 套确定性测试全部断言
 * lib 层函数返回值，而甲方看的是渲染结果——「函数绿 + 页面错」正是从这条缝里漏出去的。
 * 页面本身的挂载点不变（见下方 `hasDecisionResults &&` 分支），导出不改变任何运行时行为。
 */
export function CompactAiSchemeCardFlow({
  caseState,
  onRetry,
  onAcceptEditedPrescription,
  onConfirmEncounterScope,
  onConfirmEmergencyClearance,
  onDownloadReport,
  restoredUnsavedDraft,
  onUnsavedDraftChange,
}: {
  caseState: CaseState;
  onRetry: () => void;
  onAcceptEditedPrescription: (accepted: AcceptedEditedPrescription) => Promise<void>;
  onConfirmEncounterScope: () => Promise<void>;
  onConfirmEmergencyClearance: (assessmentSummary: string, findings: EmergencyClearanceFindingAttestation[]) => Promise<void>;
  onDownloadReport: () => void;
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

  // 处置改「提示不拦截」后，红旗与完整结果**并存**是常态：服务端照常生成 M03/M04（置顶
  // 安全警示横幅），前端相应地把急诊卡置顶、结果照常展示。旧行为用急诊卡整页替换结果区，
  // 服务端刚生成的辨证与候选被前端藏掉——后台改完前端还在拦，正是要消灭的形态。
  // 结果尚未生成时（红旗在采集阶段即命中），急诊卡仍然独占——此时确实没有别的可展示。
  if (isRedFlag && !activeReasoning) {
    return (
      <EmergencyReferralReport
        caseState={caseState}
        onDownloadReport={onDownloadReport}
        onConfirmEmergencyClearance={onConfirmEmergencyClearance}
      />
    );
  }

  if (activeReasoning) {
    return (
      <div className="space-y-3">
        {isRedFlag && (
          <EmergencyReferralReport
            caseState={caseState}
            onDownloadReport={onDownloadReport}
            onConfirmEmergencyClearance={onConfirmEmergencyClearance}
          />
        )}
        <ResultTabsV2 caseState={caseState} summary={summary} onRetry={onRetry} onAcceptEditedPrescription={onAcceptEditedPrescription} onConfirmEncounterScope={onConfirmEncounterScope} restoredUnsavedDraft={restoredUnsavedDraft} onUnsavedDraftChange={onUnsavedDraftChange} />
      </div>
    );
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
        </div>
      </SchemeSection>

      {hasDosePrescription && <SchemeSection id="cdss-section-prescription" title="处方建议" subtitle="中药饮片 / 西药与中成药">
        <div className="space-y-3">
          <PrescriptionPlanTabs summary={summary} />
        </div>
      </SchemeSection>}

      {hasDosePrescription && <AuditReviewSection caseState={caseState} content={summary.medicineRiskSection} />}

    </div>
  );
}

// ─── Streaming text state per phase ──────────────────────────────────────────

type StreamingState = Partial<Record<Phase, string>>;
type ModuleDraftState = Partial<Record<M03DraftModule, StreamModuleDraftFrame>>;

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
  herbCountPreference: string;
  clinicTreatmentCapabilities: string;
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

/**
 * 面象 / 舌象 / 脉象的点选项直接由望诊字典生成，不再手写。
 * （措辞注意：本文件被 test:diagnosis-display 扫描，注释里也不要出现流水线术语。）
 *
 * 此前这三组是手写常量，与甲方字典**双向分叉**：字典里的舌态整组（舌体萎软/歪斜/颤动/强硬/
 * 吐弄舌/短缩舌）、苔腐/苔剥落/苔灰/苔黑/苔白如积粉/黄白苔、舌下络脉整组、面色黑/青/红、
 * 目光乏神、精神不振在页面上根本点不到；反过来页面有些词字典里没有。
 * 「页面能点的」「后台能认的」「字典里有的」本该是同一份东西。
 *
 * 词表之外的既有常用词并未删除，另置一组保留——它们临床上成立（脉浮紧是最常见的表寒合脉之一，
 * 甲方字典的合脉列表里恰好没有），删掉是净损失。这些词照样被后台的形态学正则识别。
 */
const LEXICON_EXTRA_PRESETS: Record<InspectionField, ChipGroupPreset | undefined> = {
  face: { title: "其他常用", items: ["神清", "精神倦怠", "少气懒言", "形体消瘦", "形体肥胖", "两颧潮红", "唇色淡", "唇色紫暗", "目周色暗"] },
  pulse: { title: "其他常用", items: ["脉浮紧", "脉沉缓", "脉弦滑数", "脉细涩"] },
  tongue: { title: "其他常用", items: ["瘀点瘀斑", "舌淡胖", "苔白滑", "苔黄腻", "苔厚腻"] },
};

function inspectionPresets(field: InspectionField): ChipGroupPreset[] {
  const normal = inspectionLexiconNormal(field);
  const groups: ChipGroupPreset[] = [
    // 正常项单列一组放最前：这是门诊最高频的一次点击，埋在分组里等于让医生每次都找。
    ...(normal ? [{ title: "正常", items: [normal] }] : []),
    ...inspectionLexiconGroups(field).map((group) => ({ title: group.name, items: [...group.terms] })),
  ];
  const extra = LEXICON_EXTRA_PRESETS[field];
  const known = new Set(groups.flatMap((group) => group.items));
  const remaining = extra ? extra.items.filter((item) => !known.has(item)) : [];
  return remaining.length > 0 ? [...groups, { title: extra!.title, items: remaining }] : groups;
}

const FACE_PRESETS: ChipGroupPreset[] = inspectionPresets("face");
const PULSE_PRESETS: ChipGroupPreset[] = inspectionPresets("pulse");
const TONGUE_PRESETS: ChipGroupPreset[] = inspectionPresets("tongue");

const TCM_DETAIL_PRESETS: ChipGroupPreset[] = [
  { title: "寒热汗出", items: ["畏寒喜暖", "手足不温", "五心烦热", "潮热盗汗", "自汗", "无汗"] },
  { title: "饮食二便", items: ["纳差腹胀", "口干不欲饮", "喜热饮", "口苦咽干", "大便溏薄", "大便干结", "小便清长", "小便黄赤"] },
  { title: "睡眠情志", items: ["入睡困难", "易醒多梦", "早醒", "烦躁易怒", "情志抑郁", "健忘心悸"] },
  { title: "腹诊/疼痛", items: ["腹部喜按", "腹部拒按", "疼痛固定刺痛", "疼痛游走", "胀痛", "刺痛"] },
];

const PATIENT_SEX_OPTIONS = [
  { value: "", label: "请选择" },
  { value: "男", label: "男" },
  { value: "女", label: "女" },
  { value: "其他或未明确", label: "其他或未明确" },
] as const;

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
    herbCountPreference: "",
    clinicTreatmentCapabilities: "",
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

export function normalizePresentHistoryText(value: string): string {
  let normalized = value.trim();
  while (/^(?:现病史(?:补充)?|病史补充)\s*[：:]\s*/.test(normalized)) {
    normalized = normalized.replace(/^(?:现病史(?:补充)?|病史补充)\s*[：:]\s*/, "").trim();
  }
  return normalized;
}

function questionDetailPatch(selection: QuestionOptionSelection, detailText: string): Partial<HisRecordDraft> {
  const detail = detailText.trim();
  if (!detail) return {};
  const selected = selection;
  if (selected.targetField) {
    return {
      [selected.targetField]: selected.targetField === "xianbingshi"
        ? normalizePresentHistoryText(detail)
        : detail,
    } as Partial<HisRecordDraft>;
  }
  if (selected.detailTarget === "xianbingshi") {
    return { xianbingshi: normalizePresentHistoryText(detail) };
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
    return { xianbingshi: normalizePresentHistoryText(detail) };
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

  // 性别必须有明确前后文标记才认。原正则 /(?:性别|患者)?\s*(男|女)(?:性|患者)?/ 的前缀是**可选**的，
  // 于是任意位置的裸「男」「女」字都命中——「女婿陪同」「其子女均体健」「妇女保健科」
  // 都会把性别抽出来，而 mergeDraftPatch(..., true) 是覆盖语义，会把已录入的正确值改掉。
  // 性别不是显示字段：它进 FEMALE_ONLY_CLINICAL_CONTEXT（diagnosis-safety.ts）、进 collect
  // 必填校验、并参与妊娠相关路径，判错方向是**放行**（男性患者不会触发妊娠门禁）。
  // 因此这里只认四种明确写法，其余一律不猜——采集缺项有独立的追问链路兜底，比猜错强。
  const sexMatch = normalized.match(
    /(?:性别\s*[:：]?\s*(男|女)|(男|女)性(?![^，。；;]{0,4}(?:朋友|友))|患者\s*(男|女)|(?:^|[，,、；;])\s*(男|女)\s*(?=[，,、；;]|\s*\d{1,3}\s*岁))/,
  );
  const inferredSex = sexMatch ? (sexMatch[1] || sexMatch[2] || sexMatch[3] || sexMatch[4]) : undefined;
  if (!patch.sex && inferredSex &&
      !/(男女|男或女|男性或女性)/.test(normalized) &&
      !/(?:是否|是不是|可能|疑似|待确认|需确认)[^，。；;]{0,6}(?:男|女)/.test(normalized)) {
    patch.sex = inferredSex;
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
  const pulseMatch = unknownCue.test(normalized) ? null : normalized.match(new RegExp(`脉(?:${PULSE_QUALITY_PATTERN_SOURCE}){1,4}(?:${PULSE_FORCE_PATTERN_SOURCE})?`));
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

function normalizeVitalValueUnit(value: string, unitPattern: RegExp): string {
  return value.trim().replace(unitPattern, "").trim();
}

export function buildVitalsLine(draft: HisRecordDraft): string {
  const bp = normalizeBloodPressureInput(draft.vitalsBP);
  const temperature = normalizeVitalValueUnit(draft.vitalsT, /(?:℃|°C|度)$/i);
  const pulse = normalizeVitalValueUnit(draft.vitalsP, /(?:次\s*[\/／]\s*分|次每分|bpm)$/i);
  const respiration = normalizeVitalValueUnit(draft.vitalsR, /(?:次\s*[\/／]\s*分|次每分|bpm)$/i);
  const values = [
    temperature && `T ${temperature}℃`,
    pulse && `P ${pulse}次/分`,
    respiration && `R ${respiration}次/分`,
    bp && `BP ${bp}mmHg`,
    draft.vitalsDetail,
  ].filter(Boolean);
  return values.join("，");
}

function buildHisRecordText(draft: HisRecordDraft, extraText = "", tongueUploaded = false): string {
  const ageText = draft.age.trim();
  const presentHistory = normalizePresentHistoryText(draft.xianbingshi);
  const patient = [
    draft.sex && `性别${draft.sex}`,
    ageText && `年龄${/(岁|月|天|日)/.test(ageText) ? ageText : `${ageText}岁`}`,
  ].filter(Boolean).join("，");
  const rows = [
    patient && `患者信息：${patient}`,
    draft.zhushu && `主诉：${draft.zhushu}`,
    presentHistory && `现病史：${presentHistory}`,
    draft.jiwangshi && `既往史：${draft.jiwangshi}`,
    draft.allergyHistory && `过敏史：${draft.allergyHistory}`,
    draft.medicationHistory && `用药史：${draft.medicationHistory}`,
    buildVitalsLine(draft) && `生命体征/体格检查：${buildVitalsLine(draft)}`,
    draft.tcmFace && `面象：${draft.tcmFace}`,
    (draft.tcmTongue || tongueUploaded) && `舌象：${[draft.tcmTongue, tongueUploaded ? "已上传舌象图片" : ""].filter(Boolean).join("，")}`,
    draft.tcmPulse && `脉象：${draft.tcmPulse}`,
    draft.tcmDetail && `其他四诊/问诊补充：${draft.tcmDetail}`,
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
      xianbingshi: normalizePresentHistoryText(draft.xianbingshi),
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
      // 原先硬编码 "unrestricted"：draft 里有这个字段、页面上却没有控件，
      // 而且即使有控件，值也会在这里被丢掉。甲方「流派配置未完成」指的就是这条链路。
      tcmLineagePreference: draft.tcmLineagePreference || "unrestricted",
      ...(draft.clinicTreatmentCapabilities.trim()
        ? { clinicTreatmentCapabilities: draft.clinicTreatmentCapabilities.trim() }
        : {}),
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

/** 页面下拉值 → CaseState 的三档取值。空值表示医生没设偏好。 */
function normalizeHerbCountDraft(value: string): CaseState["herbCountPreference"] {
  return value === "within_10" || value === "between_10_15" || value === "at_least_15" ? value : undefined;
}

const HERB_COUNT_OPTIONS = [
  { value: "", label: "不限（默认）" },
  { value: "within_10", label: "10 味以内" },
  { value: "between_10_15", label: "10–15 味" },
  { value: "at_least_15", label: "15 味以上" },
] as const;

function hasAnyDraftInput(draft: HisRecordDraft): boolean {
  return (Object.entries(draft) as Array<[keyof HisRecordDraft, string]>).some(([key, value]) => {
    if (key === "tcmLineagePreference" && value === "unrestricted") return false;
    if (key === "herbCountPreference" && !value) return false;
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
  "aux-exam",
] as const;

function hasAnyDraftInputInDocument(): boolean {
  if (typeof document === "undefined") return false;
  return DRAFT_INPUT_TEST_IDS.some((testId) => {
    const element = document.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[data-testid="${testId}"]`);
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
    ...(normalizePresentHistoryText(draft.xianbingshi) ? { presentHistory: normalizePresentHistoryText(draft.xianbingshi) } : {}),
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
    tcmLineagePreference: draft.tcmLineagePreference || "unrestricted",
    // 饮片味数是**软偏好**：写进 prompt 供组方参考，绝不参与确定性裁剪
    //（经典方基准组成、绑定病机的药味、安全所需佐制药一味都不因它删减，见 diagnosis-types.ts）。
    herbCountPreference: normalizeHerbCountDraft(draft.herbCountPreference),
    clinicTreatmentCapabilities: draft.clinicTreatmentCapabilities.trim()
      ? parseTcmTreatmentCapabilities(draft.clinicTreatmentCapabilities)
      : undefined,
    clinicTreatmentCapabilitiesRestricted: Boolean(draft.clinicTreatmentCapabilities.trim()),
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
  required = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly { value: string; label: string }[];
  testId?: string;
  required?: boolean;
}) {
  return (
    <div className="flex min-h-[38px] border-b border-gray-200 last:border-b-0">
      <div className="flex w-[88px] shrink-0 items-center border-r border-gray-200 bg-gray-50 px-2 text-[12px] font-medium text-gray-700">
        {label}{required && <span className="ml-0.5 text-rose-500">*</span>}
      </div>
      <select
        aria-label={label}
        required={required}
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
              <p className="mt-1 text-[12px] leading-relaxed text-gray-500">医生可直接录入或修正图像分析结果，最终以医生确认的内容进入辨证推理。</p>
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
  lockReason,
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
  lockReason?: string;
  tongueImage: string | null;
  uploadNotice?: string;
  tongueInputRef: React.RefObject<HTMLInputElement | null>;
  onImageChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onClearTongueImage: () => void;
  onOpenTongueCapture: () => void;
}) {
  type CapabilityItem = {
    projectCode: TcmTreatmentProjectCode;
    name: string;
    deliveryMode: "onsite" | "referral";
    riskLevel: "low" | "moderate" | "specialist";
    containsMedication: boolean;
    requiresMedicationAudit: boolean;
  };
  const [treatmentSettingsOpen, setTreatmentSettingsOpen] = useState(false);
  const [configuredTreatmentProjects, setConfiguredTreatmentProjects] = useState<CapabilityItem[]>([]);
  // "none_deployed" (this clinic runs no in-house projects) and "misconfigured" (the project
  // registration is broken and only an administrator can repair it) are settled answers that
  // looking again cannot change. "unreachable" is the only state where another attempt can
  // succeed, so it is the only one that may offer to look again.
  const [treatmentSettingsStatus, setTreatmentSettingsStatus] = useState<
    "loading" | "ready" | "none_deployed" | "misconfigured" | "unreachable"
  >("loading");
  const [treatmentScopeWaitedSeconds, setTreatmentScopeWaitedSeconds] = useState(0);
  const [treatmentScopeReadAttempt, setTreatmentScopeReadAttempt] = useState(0);
  const update = <K extends keyof HisRecordDraft>(key: K, value: HisRecordDraft[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  };
  const append = (key: keyof HisRecordDraft, value: string) => {
    setDraft((prev) => ({ ...prev, [key]: appendClinicalPresetValue(key, prev[key], value) }));
  };
  const tonguePulseConflict = detectTonguePulseFieldConflict(draft.tcmTongue, draft.tcmPulse);
  useEffect(() => {
    const controller = new AbortController();
    const startedAt = Date.now();
    let timedOut = false;
    const deadline = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, TREATMENT_SCOPE_STATUS_TIMEOUT_MS);
    const ticker = window.setInterval(() => {
      setTreatmentScopeWaitedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    }, 1000);
    void fetch(apiUrl("/api/diagnosis/health"), { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("health_unavailable");
        return response.json() as Promise<{
          tcmTreatmentProjects?: { configurationValid?: boolean; reason?: string; items?: CapabilityItem[] };
        }>;
      })
      .then((body) => {
        const scope = body.tcmTreatmentProjects;
        const items = scope?.configurationValid === true && Array.isArray(scope.items) ? scope.items : [];
        setConfiguredTreatmentProjects(items);
        if (items.length > 0) {
          setTreatmentSettingsStatus("ready");
          return;
        }
        // A valid scope with no projects and an explicit "not_configured" deployment are both
        // successful answers: this clinic simply runs no in-house projects. A stated reason means
        // the registration itself is broken, which only an administrator can repair. A reply that
        // carries no scope at all has not answered, so it stays transient instead of blaming an
        // administrator for a fault that may not exist.
        setTreatmentSettingsStatus(
          scope?.configurationValid === true || scope?.reason === "not_configured"
            ? "none_deployed"
            : typeof scope?.reason === "string"
              ? "misconfigured"
              : "unreachable",
        );
      })
      .catch((error: unknown) => {
        // An abort raised by this effect's cleanup means the panel went away; an abort raised by the
        // deadline, and every other failure, means the read genuinely did not land.
        if (timedOut || (error as { name?: string })?.name !== "AbortError") {
          setTreatmentSettingsStatus("unreachable");
        }
      })
      .finally(() => {
        window.clearInterval(ticker);
        window.clearTimeout(deadline);
      });
    return () => {
      window.clearInterval(ticker);
      window.clearTimeout(deadline);
      controller.abort();
    };
  }, [treatmentScopeReadAttempt]);
  const customTreatmentScope = draft.clinicTreatmentCapabilities.trim();
  const selectedTreatmentCodes = new Set<TcmTreatmentProjectCode>(
    customTreatmentScope
      ? parseTcmTreatmentCapabilities(customTreatmentScope)
      : configuredTreatmentProjects.map((item) => item.projectCode),
  );
  const toggleTreatmentProject = (projectCode: TcmTreatmentProjectCode) => {
    const next = new Set(selectedTreatmentCodes);
    if (next.has(projectCode)) next.delete(projectCode);
    else next.add(projectCode);
    const deploymentOrder = configuredTreatmentProjects.map((item) => item.projectCode);
    const ordered = deploymentOrder.filter((code) => next.has(code));
    update(
      "clinicTreatmentCapabilities",
      ordered.length === deploymentOrder.length ? "" : ordered.length === 0 ? "__none__" : ordered.join(","),
    );
  };

  return (
    <section
      id="cdss-section-record"
      data-clinical-contract-ids="M01-case-summary"
      data-clinical-renderer="case-record-panel"
      className="flex scroll-mt-3 flex-col overflow-hidden rounded-xl border border-gray-200 bg-white xl:min-h-0 xl:flex-1"
      data-rx-card="1"
    >
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-gray-200 px-4">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-teal-700" />
          <span className="text-[14px] font-bold text-gray-900">门诊病历</span>
          <span className="rounded bg-teal-50 px-1.5 py-0.5 text-[10px] font-bold text-teal-700">中医</span>
        </div>
        <span className="text-[11px] font-medium text-gray-400">一诉五史 · 生命体征 · 四诊信息</span>
      </div>

      <div className="bg-[#F7F9FB] p-3 xl:min-h-0 xl:flex-1 xl:overflow-y-auto">
        {isRunning && lockReason && (
          <p data-testid="record-readonly-reason" className="mb-2 rounded-lg border border-teal-100 bg-teal-50 px-3 py-2 text-[11px] leading-relaxed text-teal-900">
            {lockReason}
          </p>
        )}
        <fieldset disabled={isRunning} aria-busy={isRunning} className="min-w-0 rounded-xl border border-gray-200 bg-white disabled:cursor-wait">
          <div className="grid border-b border-gray-200 md:grid-cols-3">
            <InputCell label="姓名" value={draft.patientName} onChange={(value) => update("patientName", value)} placeholder="可不填" testId="patient-name" />
            <SelectCell label="性别" required value={draft.sex} onChange={(value) => update("sex", value)} options={PATIENT_SEX_OPTIONS} testId="patient-sex" />
            <InputCell label="年龄" required value={draft.age} onChange={(value) => update("age", value)} placeholder="如45岁/6个月" testId="patient-age" />
          </div>
          {parseAgeInput(draft.age) == null && (
            <p data-testid="age-required-hint" className="border-b border-amber-200 bg-amber-50 px-3 py-2 text-[11px] font-medium leading-relaxed text-amber-800 sm:px-[96px]">
              请录入实际年龄或月龄；年龄会参与儿童、妊娠和老年安全规则，未录入时暂不能开始推理。
            </p>
          )}
          <TextareaCell label="主诉" required value={draft.zhushu} onChange={(value) => update("zhushu", value)} placeholder="核心症状 + 持续时间，例如：失眠多梦伴心悸半年" testId="chief-complaint" />
          <TextareaCell label="现病史" value={draft.xianbingshi} onChange={(value) => update("xianbingshi", value)} placeholder="起病、诱因、主要症状、伴随症状、诊治经过" testId="present-history" />
          <TextareaCell label="既往史" value={draft.jiwangshi} onChange={(value) => update("jiwangshi", value)} placeholder="慢病、手术外伤、传染病、家族相关信息可在补充说明中展开" testId="past-history" />
          <TextareaCell label="过敏史" value={draft.allergyHistory} onChange={(value) => update("allergyHistory", value)} placeholder="否认过敏 / 具体药物或食物过敏及反应" testId="allergy-history" />
          <TextareaCell label="用药史" value={draft.medicationHistory} onChange={(value) => update("medicationHistory", value)} placeholder="当前中药、中成药、西药、保健品及剂量频次" testId="medication-history" />
          <div className="border-b border-gray-200 px-3 py-2 sm:px-[96px]" data-testid="tcm-treatment-capability-settings">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="flex items-center gap-1.5 text-[12px] font-semibold text-gray-800">
                  中医治疗项目
                  {treatmentSettingsStatus === "loading" && <Loader2 className="h-3 w-3 animate-spin text-teal-600" />}
                </p>
                <p className="mt-0.5 text-[11px] leading-relaxed text-gray-500" role="status">
                  {treatmentSettingsStatus === "loading"
                    ? "正在查询本机构已开展的中医治疗项目…"
                    : treatmentSettingsStatus === "none_deployed"
                      ? "本机构未开展可推荐的中医治疗项目，本例只给出方药与调护建议。"
                      : treatmentSettingsStatus === "misconfigured"
                        ? "本机构项目目录登记有误，已暂停项目推荐；请联系管理员核对后重新登记。"
                        : treatmentSettingsStatus === "unreachable"
                          ? "暂时查不到本机构已开展的项目，本例不会推荐院内项目。"
                          : customTreatmentScope === "__none__"
                            ? "本病例已明确不生成项目推荐"
                            : customTreatmentScope
                              ? `本病例已选 ${selectedTreatmentCodes.size}/${configuredTreatmentProjects.length} 项`
                              : `按机构默认启用 ${configuredTreatmentProjects.length} 项`}
                </p>
                {treatmentSettingsStatus === "loading" && treatmentScopeWaitedSeconds >= 2 && (
                  <p className="mt-0.5 text-[11px] text-gray-400" aria-hidden="true">
                    已等待 {treatmentScopeWaitedSeconds} 秒，最长等待 {TREATMENT_SCOPE_STATUS_TIMEOUT_SECONDS} 秒。
                  </p>
                )}
                {treatmentSettingsStatus === "unreachable" && (
                  <button
                    type="button"
                    data-testid="tcm-treatment-settings-reload"
                    onClick={() => {
                      setTreatmentScopeWaitedSeconds(0);
                      setTreatmentSettingsStatus("loading");
                      setTreatmentScopeReadAttempt((current) => current + 1);
                    }}
                    disabled={isRunning}
                    className="mt-1 inline-flex h-7 items-center gap-1 rounded border border-gray-200 bg-white px-2 text-[11px] font-bold text-gray-700 transition-colors hover:border-teal-200 hover:bg-teal-50 hover:text-teal-700 disabled:cursor-not-allowed disabled:text-gray-300"
                  >
                    <RefreshCw className="h-3 w-3" />
                    重新查询
                  </button>
                )}
              </div>
              <button
                type="button"
                data-testid="tcm-treatment-settings-toggle"
                onClick={() => setTreatmentSettingsOpen((current) => !current)}
                disabled={treatmentSettingsStatus !== "ready" || isRunning}
                className="inline-flex h-8 items-center gap-1 rounded border border-gray-200 bg-gray-50 px-2.5 text-[12px] font-bold text-gray-700 transition-colors hover:border-teal-200 hover:bg-teal-50 hover:text-teal-700 disabled:cursor-not-allowed disabled:text-gray-300"
              >
                <ClipboardList className="h-3.5 w-3.5" />
                项目设置
              </button>
            </div>
            {treatmentSettingsOpen && treatmentSettingsStatus === "ready" && (
              <div className="mt-2 rounded-lg border border-gray-200 bg-gray-50 p-2.5" data-testid="tcm-treatment-settings-panel">
                <p className="mb-2 text-[11px] leading-relaxed text-gray-500">这里只能缩小本机构已部署的项目范围；最终仍按本例已确认诊断、病机节点与项目适配规则个性化筛选。</p>
                <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                  {configuredTreatmentProjects.map((item) => (
                    <label key={item.projectCode} className="flex cursor-pointer items-start gap-2 rounded border border-gray-200 bg-white px-2.5 py-2 text-[12px] text-gray-700">
                      <input
                        type="checkbox"
                        checked={selectedTreatmentCodes.has(item.projectCode)}
                        onChange={() => toggleTreatmentProject(item.projectCode)}
                        className="mt-0.5 accent-teal-600"
                      />
                      <span>
                        <span className="font-semibold text-gray-900">{item.name}</span>
                        <span className="ml-1 text-[10px] text-gray-400">{item.deliveryMode === "onsite" ? "本机构" : "转介"}{item.containsMedication ? " · 含药审方" : ""}</span>
                      </span>
                    </label>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => update("clinicTreatmentCapabilities", "")}
                  className="mt-2 text-[11px] font-semibold text-teal-700 hover:text-teal-800"
                >
                  恢复机构默认
                </button>
              </div>
            )}
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
          {/* 甲方 11 项需求里的「流派/药味数量配置」：两条链路后端早就通了
              （tcmLineagePreference 进 prompt 的流派策略，herbCountPreference 进组方提示），
              但页面上一直没有控件，而且 applyDraftToCaseState 还把流派硬编码成 unrestricted，
              医生就算选了也会被丢。这里补上控件并接通写回。
              味数是**软偏好**：不参与任何确定性裁剪，经典方基准组成不因它删减。 */}
          <SelectCell
            label="诊疗思路"
            value={draft.tcmLineagePreference}
            onChange={(value) => update("tcmLineagePreference", value)}
            options={LINEAGE_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
            testId="lineage-preference"
          />
          <SelectCell
            label="饮片味数"
            value={draft.herbCountPreference}
            onChange={(value) => update("herbCountPreference", value)}
            options={HERB_COUNT_OPTIONS}
            testId="herb-count-preference"
          />
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
  moduleDrafts,
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
  onConfirmEmergencyClearance,
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
  moduleDrafts: ModuleDraftState;
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
  onConfirmEmergencyClearance: (assessmentSummary: string, findings: EmergencyClearanceFindingAttestation[]) => Promise<void>;
  onRunReasoning: () => void;
  canRunReasoning: boolean;
  submitHint?: string;
  restoredUnsavedDraft?: WorkbenchUnsavedDraftFlag | null;
  onUnsavedDraftChange?: (flag: WorkbenchUnsavedDraftFlag | null) => void;
}) {
  const hasDecisionResults = Boolean(caseState.diagnosis || caseState.prescription || caseState.riskAssessment);
  const warningProfile = deriveCaseWarningProfile(caseState);
  const isActiveRedFlag = (caseState.safetyGate || evaluateSafetyGate(caseState)).status === "red_flag";
  const warningBadgeTone =
    warningProfile.level === "L4" ? "bg-red-900 text-white" :
    warningProfile.level === "L3" ? "bg-red-100 text-red-800" :
    warningProfile.level === "L2" ? "bg-orange-100 text-orange-800" :
    warningProfile.level === "L1" ? "bg-amber-100 text-amber-800" :
    "bg-slate-100 text-slate-700";
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
  // F1（追问不阻断）：分析自动续跑后，未回答的追问以并行增强身份保留在结果区，
  // 医生随时可答；提交沿用“清空结论并重新分析”链路。
  const hasPendingQuestionEnhancement = hasPendingFollowupQuestions(caseState);
  const shouldShowFollowupQuestionCard =
    !hasStaleClinicalOutput &&
    (isFollowupOnlyState || hasPendingQuestionEnhancement) &&
    !isRunning &&
    questionContentForDisplay !== undefined;
  const followupQuestionCard = shouldShowFollowupQuestionCard ? (
    <div className="space-y-2">
      {!isFollowupOnlyState && (
        <p className="rounded-lg border border-teal-100 bg-teal-50 px-3 py-2 text-xs leading-relaxed text-teal-800">
          分析已自动继续；补充回答可随时完善并重新分析。
        </p>
      )}
      {/* 跳过入口必须排在追问表单之前：一轮 1-2 题、每题含选项行与两行文本域，排在表单之后时
          在 410px 侧栏里要滚动一屏以上才出现，医生因此不知道可以不作答直接继续。放在普通文档流
          的表单之前，而不是吸底浮层，选项按钮永远不会被遮挡。跳过按钮只在流程真正停等的
          followup-only 状态出现——分析已续跑时它没有语义。 */}
      {onSkipFollowup && isFollowupOnlyState && (
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
    </div>
  ) : null;

  // 长阶段结束后把结论滚到视野内：本面板是独立滚动容器，医生在等待期间往往已经滚到别处，
  // 结果落在屏幕外会被读成“没生成”。每轮只滚一次，不打断医生自己的滚动。
  // 只有 canCancelRun 才代表确实有一轮在跑（isRunning 还包含工作区恢复中），
  // 否则刷新页面恢复既往病例时会无故自动滚动。
  const runScrollArmedRef = useRef(false);
  useEffect(() => {
    if (canCancelRun) {
      runScrollArmedRef.current = true;
      return;
    }
    if (!runScrollArmedRef.current || isRunning) return;
    if (caseState.phase !== "done" && caseState.phase !== "error") return;
    runScrollArmedRef.current = false;
    const target = caseState.phase === "error"
      ? document.querySelector<HTMLElement>('[data-testid="stage-error-card"]')
      : document.querySelector<HTMLElement>('[data-testid="run-complete-banner"]') ?? document.getElementById("cdss-section-ai");
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [canCancelRun, caseState.phase, isRunning]);

  return (
    <aside id="cdss-section-ai-panel" className="flex flex-col overflow-hidden rounded-xl border border-gray-200 bg-white xl:min-h-0 xl:w-[410px] 2xl:w-[460px]">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-gray-200 px-4">
        <div className="flex items-center gap-2">
          {isActiveRedFlag ? <AlertTriangle className="h-4 w-4 text-red-700" /> : <Brain className="h-4 w-4 text-teal-700" />}
          <span className={`text-[14px] font-bold ${isActiveRedFlag ? "text-red-800" : "text-teal-700"}`}>
            {isActiveRedFlag ? "急诊转诊建议" : "中医辅助诊疗报告"}
          </span>
        </div>
        <button
          type="button"
          onClick={onDownloadReport}
          className="inline-flex items-center gap-1 rounded-md border border-gray-200 px-2 py-1 text-[11px] font-bold text-gray-500 hover:bg-gray-50"
          title={isActiveRedFlag ? "下载转诊建议与依据" : "下载完整报告"}
        >
          <Download className="h-3 w-3" />
          {isActiveRedFlag ? "转诊依据" : "报告"}
        </button>
      </div>
      {!isActiveRedFlag && <TopProgress caseState={caseState} />}

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

        {hasStaleClinicalOutput && hasDecisionResults && !shouldShowPreviousResult && (
          // 病历一改动，上一版结论此前会整段消失。医生常在读完报告后回填病历，结论凭空不见会被当成系统丢了结果。
          // 这里降级为已有的只读对照卡：只改显示，报告导出、审方与医嘱写回所用的数据不变。
          <PreviousResultCard
            result={{
              diagnosis: caseState.diagnosis,
              prescription: caseState.prescription,
              riskAssessment: caseState.riskAssessment,
              capturedAt: caseState.hisRecord?.updatedAt ?? "",
            }}
            note="以下是病历修改前生成的结论，仅供对照阅读；它不会随本次修改自动更新，请先重新分析，再据此写回医嘱。"
          />
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
              isRedFlag={isActiveRedFlag}
              content={currentStreaming}
              moduleDrafts={moduleDrafts}
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
                  请选择性别并填写主诉即可开始。其他病史、生命体征和四诊信息可按实际情况补充；资料越充分，诊断与鉴别会越具体。必要时系统会在一轮内集中提出 1–2 个最能改变判断的问题，也可直接跳过。
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
                  {caseState.phase === "collect" ? "正在整理病历与评估下一步" : generationStatus(caseState.phase, isActiveRedFlag).title}
                </p>
                <p className="mt-1 text-xs leading-relaxed text-gray-500">
                  {caseState.phase === "collect" ? "已同步门诊病历，系统正在决定是否需要追问或进入诊疗方案生成。" : generationStatus(caseState.phase, isActiveRedFlag).desc}
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

        {caseState.phase === "done" && !isRunning && hasDecisionResults && !hasStaleClinicalOutput && !isFollowupOnlyState && !isActiveRedFlag && (
          <div data-testid="run-complete-banner" className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-gray-200 bg-white px-3 py-2.5">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-[13px] font-bold text-gray-900">本轮辅助推理已完成</p>
                <span data-testid="case-warning-level" className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${warningBadgeTone}`}>
                  {warningProfile.level} · {warningProfile.label}
                </span>
              </div>
              <p className="mt-0.5 text-[11px] leading-relaxed text-gray-500">
                {warningProfile.executable
                  ? "下方结论仅供参考，请结合患者情况判断后再开具医嘱；需要补充病历可直接编辑左侧后重新分析。"
                  : "当前只允许查看和导出非剂量风险说明，不允许作为处方或医嘱执行。"}
              </p>
            </div>
            <button
              type="button"
              onClick={onDownloadReport}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-teal-600 px-3 py-2 text-[12px] font-bold text-white transition-colors hover:bg-teal-700"
            >
              <Download className="h-3.5 w-3.5" />
              {warningProfile.executable ? "下载脱敏报告" : "下载非剂量风险报告"}
            </button>
          </div>
        )}

        {hasDecisionResults && !hasStaleClinicalOutput && !isFollowupOnlyState && (
          <CompactAiSchemeCardFlow
            caseState={caseState}
            onRetry={onRetry}
            onAcceptEditedPrescription={onAcceptEditedPrescription}
            onConfirmEncounterScope={onConfirmEncounterScope}
            onConfirmEmergencyClearance={onConfirmEmergencyClearance}
            onDownloadReport={onDownloadReport}
            restoredUnsavedDraft={restoredUnsavedDraft}
            onUnsavedDraftChange={onUnsavedDraftChange}
          />
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
  if (phase === "diagnose") return stripTcmDiseaseNameForCustomer(sanitizeDiagnoseStreamingDraft(next));
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
  isRedFlag,
  content,
  moduleDrafts,
  runningElapsedSeconds,
  canCancelRun,
  isCancelling,
  onCancelRun,
}: {
  phase: Phase;
  isRedFlag: boolean;
  content: string;
  moduleDrafts: ModuleDraftState;
  runningElapsedSeconds: number;
  canCancelRun: boolean;
  isCancelling: boolean;
  onCancelRun: () => void;
}) {
  const status = generationStatus(phase, isRedFlag);
  const safePreview = sanitizeStreamingPreview(content, phase);
  // M05 是确定性 Markdown，会真的逐段下发正文，保持文档式渲染。
  // M03/M04 在完成前只有进度行；但流末尾会用最终正文整体替换一次，此时必须立刻切回文档式渲染，
  // 否则临床结论会被排成进度条目。用是否出现 Markdown 结构判定，判错时退回既有渲染。
  const progressLines = safePreview.split("\n").map((line) => line.trim()).filter(Boolean);
  const orderedDrafts = phase === "diagnose" && !/^#\s+中医辅助诊疗报告/m.test(safePreview)
    ? M03_DRAFT_MODULES.flatMap((module) => moduleDrafts[module] ? [moduleDrafts[module]] : [])
    : [];
  const showProgressLog = phase !== "assess" &&
    progressLines.length > 0 &&
    !/^\s{0,3}(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\||```)/m.test(safePreview);
  return (
    <div data-testid="streaming-preview-card" className="rounded-xl border border-teal-100 bg-white p-4">
      <div className="mb-3 flex items-start gap-3">
        <Loader2 className="mt-0.5 h-4 w-4 animate-spin text-teal-600" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-gray-900">{status.title}</p>
          <p className="mt-1 text-xs leading-relaxed text-gray-500">
            {isRedFlag && (phase === "prescribe" || phase === "assess")
              ? status.desc
              : phase === "prescribe"
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
      {showProgressLog ? (
        // M03/M04 在结构与临床复核通过前不会下发任何临床正文，这一段能拿到的只有阶段进度和保活状态。
        // 排成进度行而不是正文段落：医生不会把“正在生成…”误读成已经生成的结论。
        <ol data-testid="streaming-progress-log" className="max-h-[220px] space-y-1 overflow-y-auto rounded-lg border border-gray-100 bg-gray-50 px-3 py-2">
          {progressLines.map((line, index) => {
            const isLatest = index === progressLines.length - 1;
            return (
              <li
                key={`${index}-${line}`}
                className={`flex items-start gap-2 text-[11px] leading-relaxed ${isLatest ? "font-semibold text-teal-800" : "text-gray-400"}`}
              >
                {isLatest
                  ? <Loader2 className="mt-0.5 h-3 w-3 shrink-0 animate-spin" />
                  : <Circle className="mt-0.5 h-3 w-3 shrink-0" />}
                <span className="min-w-0 flex-1">{line}</span>
              </li>
            );
          })}
        </ol>
      ) : (
        <div className="max-h-[360px] overflow-y-auto rounded-lg border border-gray-100 bg-gray-50 px-3 py-2">
          <MarkdownBlock content={compactMarkdown(safePreview, 2600)} compact />
        </div>
      )}
      {orderedDrafts.length > 0 && (
        <div data-testid="streaming-module-drafts" className="mt-3 space-y-2">
          {orderedDrafts.map((draft) => (
            <section
              key={`${draft.module}-${draft.revision}`}
              data-testid={`streaming-module-${draft.module}`}
              className="rounded-lg border border-amber-200 bg-amber-50/70 p-3"
            >
              <div className="mb-2 inline-flex items-center rounded-full border border-amber-300 bg-white px-2 py-0.5 text-[10px] font-bold text-amber-800">
                生成中 · 未定稿
              </div>
              <MarkdownBlock content={compactMarkdown(draft.content, 2600)} compact />
            </section>
          ))}
        </div>
      )}
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
  const [moduleDrafts, setModuleDrafts] = useState<ModuleDraftState>({});
  const [workspaceRestored, setWorkspaceRestored] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [tongueImage, setTongueImage] = useState<string | null>(null);
  const [tongueImageConsent, setTongueImageConsent] = useState(false);
  const [uploadNotice, setUploadNotice] = useState("");
  const [captureModal, setCaptureModal] = useState<"tongue" | null>(null);
  const [pendingNewCaseConfirm, setPendingNewCaseConfirm] = useState(false);
  const [pendingReportExport, setPendingReportExport] = useState<ClinicalWarningProfile | null>(null);
  const [reportExportAcknowledged, setReportExportAcknowledged] = useState(false);
  const [reportExportReason, setReportExportReason] = useState("");
  const [workbenchUnsavedDraft, setWorkbenchUnsavedDraft] = useState<WorkbenchUnsavedDraftFlag | null>(null);
  const tongueInputRef = useRef<HTMLInputElement>(null);
  const activeCaseIdRef = useRef(caseState.id);
  const hasInProgressWorkRef = useRef(false);
  const workspaceRestoreGenerationRef = useRef(0);
  const runDiagnoseChainRef = useRef<(state: CaseState, automaticSignatureRecoveryAttempts?: number) => Promise<void>>(
    async () => undefined,
  );

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
    setModuleDrafts({});
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
    setModuleDrafts({});
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
        setUploadNotice("当前无法使用舌照识别服务，请在舌象栏手动录入舌质、舌形和舌苔后提交。");
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

  const runDiagnoseChain = useCallback(async (
    state: CaseState,
    automaticSignatureRecoveryAttempts = 0,
  ): Promise<void> => {
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
        setModuleDrafts({});
        setStreamingForPhase("diagnose", "");
        const res3 = await fetchWithTimeout(apiUrl("/api/diagnosis/diagnose"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ caseState: current }),
        });
        if (!res3.ok) throw new Error(await readErrorMessage(res3, `辨病辨证生成失败 (${res3.status})`));
        const rawDiagnosis = await consumeMarkdownStream(res3, (t) => setStreamingForPhase("diagnose", t), {
          ...streamConsumeOptions(),
          onModuleDraft: (frame) => setModuleDrafts((previous) => {
            const currentDraft = previous[frame.module];
            return currentDraft && currentDraft.revision >= frame.revision
              ? previous
              : { ...previous, [frame.module]: frame };
          }),
        });
        setModuleDrafts({});
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
        setModuleDrafts({});
        persistState(setError(current, normalizeRequestError(e, "辨病辨证失败")));
        return;
      }
    }

    if (needsPrescribe && (!hasExecutableM03Diagnosis(current) || !canEnterDosePrescriptionChain(current))) {
      persistState(applyDifferentiationGateOutcome({ ...current, prescription: undefined, riskAssessment: undefined, followupTimeline: undefined, reasoningPrescribe: undefined, skipDifferentiationGate: undefined }));
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
        // 剂量词否决只能扫**处方正文**两节。"当前结论 / 处方前必要信息核查 / 用药风险提示"
        // 由服务端把 gate.redFlags、gate.missingItems 原样插值进去，而红旗本身就常常逐字引用
        // 病历里的数值（"血红蛋白 58 g/L""呕血约300mL""二甲双胍 500mg bid"）。
        // 全文扫描会把这些引文误判成"合同泄露剂量"，进而被下面的 prescriptionContractInvalid
        // 复用成"传输失败"——因为 buildSafetyLimitedPrescription 天生不带 DIAGNOSIS_JSON sentinel，
        // transportIncomplete 恒为 true。结果是医生看到红色"未完成 + 重新生成"，而不是
        // 服务端已经备好的三段式转诊说明；那个按钮打的是同一条确定性路由，必然再败。
        // 越危急的病例（红旗带化验值）越容易命中，正好是最不该显示成系统故障的场景。
        const nonDosePrescriptionBody = rawPrescription
          .split(/^##\s+/m)
          .filter((section) => /^(?:中药饮片处方|西药\/中成药方案)/.test(section))
          .join("\n");
        const expectedNonDoseLimitedPrescription =
          rawPrescription.includes("<!-- CDSS_NON_DOSE_PRESCRIPTION -->") &&
          isNonDosePrescriptionText(rawPrescription) &&
          !/\d+(?:\.\d+)?\s*(?:g|mg|克|毫克|毫升|mL)\b/i.test(nonDosePrescriptionBody);
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
          followupTimeline: undefined,
          // Optional-history gaps and a deliberate one-round skip lower confidence but do not lock
          // the report workflow. Positive safety findings remain visible and HIS adoption is governed
          // separately from candidate generation.
          safetyLocked: false,
          phase: "assess",
        });
        current = { ...current, safetyLocked: deriveSafetyLocked(current) };
        persistState(current);
      } catch (e) {
        const message = normalizeRequestError(e, "候选方药生成失败");
        const recovery = automaticSignatureRecoveryAttempts < 1
          ? automaticSignatureRecoveryState(current, { phase: "prescribe", message })
          : undefined;
        if (recovery && !activeRunAbortController?.signal.aborted) {
          persistState(recovery);
          await runDiagnoseChainRef.current(recovery, automaticSignatureRecoveryAttempts + 1);
          return;
        }
        persistState(setError(current, message));
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
      const nonDoseFollowup = buildDeterministicRiskFollowupPayload(current);
      const nonDoseRiskAssessment = replaceRiskAssessmentFollowup(current.riskAssessment, nonDoseFollowup.markdown);
      persistState(withSafetyGate({
        ...current,
        riskAssessment: nonDoseRiskAssessment,
        followupTimeline: nonDoseFollowup.timelineItems,
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
      const generatedRisk = await consumeMarkdownStreamWithMetadata(res5, (t) => setStreamingForPhase("assess", t), streamConsumeOptions());
      const machineAuditStatus = parseRxAuditStatusMarker(generatedRisk.content);
      const cleanRiskAssessment = stripRxAuditStatusMarker(generatedRisk.content);
      const riskAssessment = replaceRiskAssessmentFollowup(current.riskAssessment, cleanRiskAssessment);
      const noAuditItems = machineAuditStatus?.reason === "no_prescription_items" ||
        /候选方药结构尚未达到自动审方接口要求|候选方药无法形成可核验的自动审方对象|尚未形成完整药味清单/.test(cleanRiskAssessment);
      const auditUnavailable = machineAuditStatus
        ? machineAuditStatus.available === false
        : noAuditItems || /本次未完成自动用药复核|自动用药复核暂未返回结果|M05 未完成灵犀处方后审方/.test(cleanRiskAssessment);
      current = withSafetyGate({
        ...current,
        riskAssessment,
        followupTimeline: generatedRisk.followupTimeline,
        auditAdvisory: auditUnavailable
          ? { available: false, reason: machineAuditStatus?.reason || (noAuditItems ? "no_prescription_items" : "service_unavailable") }
          : { available: true },
        skipDifferentiationGate: undefined,
        phase: "done",
        previousResult: undefined,
      });
      persistState(current);
    } catch (e) {
      const message = normalizeRequestError(e, "合理用药审方与随访生成失败");
      if (activeRunAbortController?.signal.aborted) {
        // A cancelled M05 must land in the same failed-stage state as M03/M04: the failed panel
        // shows the actual reason with an in-panel retry, instead of leaving the 审方随访 step
        // spinning in a "running" state that no action can recover from.
        persistState(setError(current, message));
        return;
      }
      const recovery = automaticSignatureRecoveryAttempts < 1
        ? automaticSignatureRecoveryState(current, { phase: "assess", message })
        : undefined;
      if (recovery) {
        persistState(recovery);
        await runDiagnoseChainRef.current(recovery, automaticSignatureRecoveryAttempts + 1);
        return;
      }
      // M05 contains an advisory external audit plus deterministic follow-up. An unavailable audit
      // must be disclosed, but it cannot strand a completed M03/M04 chain in a global error state.
      const fallbackFollowup = buildDeterministicRiskFollowupPayload(current);
      const riskAssessment = replaceRiskAssessmentFollowup(current.riskAssessment, fallbackFollowup.markdown);
      persistState(withSafetyGate({
        ...current,
        riskAssessment,
        followupTimeline: fallbackFollowup.timelineItems,
        auditAdvisory: { available: false, reason: "service_unavailable" },
        skipDifferentiationGate: undefined,
        phase: "done",
        previousResult: undefined,
        lastError: undefined,
      }));
    }
  }, [persistState, setStreamingForPhase]);

  useEffect(() => {
    runDiagnoseChainRef.current = runDiagnoseChain;
  }, [runDiagnoseChain]);

  // ─── M02 question ───────────────────────────────────────────────────────────

  const runQuestion = useCallback(async (
    state: CaseState,
    opts?: { countRound?: boolean },
  ): Promise<void> => {
    setStreamingForPhase("question", "");
    // 甲方反馈「追问依旧影响诊疗流程」：M02 是并行增强而非门禁。无论追问是否生成成功，
    // 本轮都继续进入辨病辨证；追问面板保留展示，医生的补充回答随时可以触发重新分析。
    // 链路续跑放在 try/catch 之外，保证 runDiagnoseChain 只被调用一次（自身内部处理错误），
    // 不会被本函数的 catch 误当成追问失败而二次续跑。
    let continueState: CaseState;
    try {
      const res = await fetchWithTimeout(apiUrl("/api/diagnosis/question"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caseState: state }),
      });
      if (!res.ok) throw new Error(await readErrorMessage(res, `请求失败 (${res.status})`));
      const { displayContent, jsonData } = await consumeCollectStream(res, (t) => setStreamingForPhase("question", t), streamConsumeOptions());
      const updated = withSafetyGateAndOperationalCompleteness(applyQuestionResult(state, displayContent, jsonData, { countRound: opts?.countRound }));
      continueState = parseQuestionItems(displayContent).length === 0
        ? setPhase({ ...updated, questionOutcome: "not_needed" }, "diagnose")
        // 新一轮追问已生成：清掉上一组问题的 outcome，本组问题在结果区保持“待回答”状态。
        : setPhase({ ...updated, questionOutcome: undefined }, "diagnose");
    } catch {
      if (activeRunAbortController?.signal.aborted) {
        // 医生主动取消的口径与 M03/M04/M05 一致：落为失败阶段，面板显示“推理已取消”并给出
        // 本阶段重试入口，而不是静默回到追问中状态（那会让取消看起来像仍在等待回答）。
        persistState(setError({ ...state, phase: "question" }, "推理已取消"));
        return;
      }
      // M02 improves information gain but is not a workflow dependency. A transient question-model
      // failure must not stall the flow in the question phase either: continue into diagnosis.
      continueState = setPhase({ ...state, lastError: undefined }, "diagnose");
    }
    persistState(continueState);
    await runDiagnoseChain(continueState);
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
            patientSex: currentState.patient.sex,
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
        // F2：M04 因 M03 级原因失败时，仅重跑 M04 会复用同一份 M03 而原地复卡；
        // 升级为清空诊断结论并从 M03 重跑。
        const upgradeToM03Rerun = failedPhase === "prescribe" && prescribeRetryRequiresM03Rerun(caseState);
        const retryTarget = upgradeToM03Rerun
          ? {
              ...recovered,
              diagnosis: undefined,
              prescription: undefined,
              riskAssessment: undefined,
              followupTimeline: undefined,
              reasoningDiagnose: undefined,
              reasoningPrescribe: undefined,
              reasoningV2: undefined,
              auditAdvisory: undefined,
            }
          : recovered;
        setRunning(true);
        try {
          await runDiagnoseChain(setPhase(retryTarget, upgradeToM03Rerun ? "diagnose" : failedPhase));
        } finally {
          setRunning(false);
        }
      }
    } else if (caseState.phase === "done" && !canContinueLimitedCase(caseState) && !hasPendingFollowupQuestions(caseState)) {
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
        followupTimeline: undefined,
        lastError: undefined,
        questionRounds: 0,
      });
      setInput("");
      await runCollect(caseInput, rerunState, hisRecord);
    } else if (caseState.phase === "question" || canContinueLimitedCase(caseState) || hasPendingFollowupQuestions(caseState)) {
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
            followupTimeline: undefined,
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
            followupTimeline: undefined,
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
        followupTimeline: undefined,
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
          // F2：M04 报错但根因在 M03 级（辨证不稳/未形成稳定证候）时，重试升级为从 M03 重跑。
          (failedPhase === "prescribe" && prescribeRetryRequiresM03Rerun(caseState)) ||
          (["prescribe", "assess"].includes(failedPhase) && recordChanged);
        const requiresM04Refresh = !requiresM03Refresh && errorRequiresM04Refresh(caseState.lastError);
        retryPhase = requiresM03Refresh ? "diagnose" : requiresM04Refresh ? "prescribe" : failedPhase;
        const draftAppliedState = withSafetyGateAndOperationalCompleteness(applyDraftToCaseState(caseState, retryDraft, supplemental, Boolean(tongueImage)));
        const recoveredBase = { ...draftAppliedState, phase: retryPhase, lastError: undefined };
        recovered = retryPhase === "diagnose"
          ? {
              ...recoveredBase,
              diagnosis: undefined,
              prescription: undefined,
              riskAssessment: undefined,
              followupTimeline: undefined,
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
                followupTimeline: undefined,
                reasoningPrescribe: undefined,
                reasoningV2: diagnoseReasoningFromState(recoveredBase),
                auditAdvisory: undefined,
              }
            : retryPhase === "assess"
              ? { ...recoveredBase, riskAssessment: undefined, followupTimeline: undefined, auditAdvisory: undefined }
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
        : { ...base, previousResult: capturePreviousResult(base), skipDifferentiationGate: true, diagnosis: undefined, reasoningDiagnose: undefined, reasoningV2: undefined, reasoningPrescribe: undefined, prescription: undefined, riskAssessment: undefined, followupTimeline: undefined };
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
    setPendingReportExport(null);
    setReportExportAcknowledged(false);
    setReportExportReason("");
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

  function downloadReport(state: CaseState, warningProfile: ClinicalWarningProfile) {
    const nonDoseOnly = !warningProfile.executable;
    const emergencyReferral = (state.safetyGate || evaluateSafetyGate(state)).status === "red_flag";
    const report = scrubReportPhi(buildCompleteReport(state, { warningProfile, nonDoseOnly }), state);
    const blob = new Blob([report], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${
      emergencyReferral
        ? "中医CDSS转诊建议与依据"
        : nonDoseOnly
          ? "中医CDSS安全评估说明"
          : "中医CDSS脱敏报告"
    }_${Date.now()}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function handleDownloadReport() {
    const warningProfile = deriveCaseWarningProfile(caseState);
    if (warningProfile.level === "L0" || warningProfile.level === "L1") {
      downloadReport(caseState, warningProfile);
      return;
    }
    setReportExportAcknowledged(false);
    setReportExportReason("");
    setPendingReportExport(warningProfile);
  }

  async function confirmReportExport() {
    if (!pendingReportExport || !reportExportAcknowledged) return;
    if (pendingReportExport.level === "L0" || pendingReportExport.level === "L1") return;
    if ((pendingReportExport.level === "L3" || pendingReportExport.level === "L4") && !reportExportReason.trim()) return;
    const acknowledgedState: CaseState = {
      ...caseState,
      warningAcknowledgement: {
        warningLevel: pendingReportExport.level,
        acknowledgedAt: new Date().toISOString(),
        reportFingerprint: await reportExportFingerprint(caseState),
        reason: reportExportReason.trim() || undefined,
        exportMode: pendingReportExport.executable ? "full_advisory_report" : "non_dose_risk_report",
      },
    };
    persistState(acknowledgedState);
    downloadReport(acknowledgedState, pendingReportExport);
    setPendingReportExport(null);
    setReportExportAcknowledged(false);
    setReportExportReason("");
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
      followupTimeline: accepted.followupTimeline,
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
      // F2：非剂量结论若同时给出 M03 级原因（辨证不稳/未形成稳定证候），确认后仅重跑 M04
      // 仍会复用同一份 M03 而原地复卡；此时升级为从 M03 重跑（就诊目标确认仍按指纹绑定生效）。
      const upgradeToM03Rerun = prescribeRetryRequiresM03Rerun(caseState);
      const confirmed = withSafetyGate({
        ...caseState,
        encounterScopeConfirmation: { sourceFingerprint, confirmedAt: new Date().toISOString() },
        diagnosis: upgradeToM03Rerun ? undefined : caseState.diagnosis,
        prescription: undefined,
        riskAssessment: undefined,
        followupTimeline: undefined,
        reasoningDiagnose: upgradeToM03Rerun ? undefined : caseState.reasoningDiagnose,
        reasoningPrescribe: undefined,
        reasoningV2: upgradeToM03Rerun ? undefined : diagnoseReasoningFromState(caseState),
        auditAdvisory: undefined,
        lastError: undefined,
        phase: upgradeToM03Rerun ? "diagnose" : "prescribe",
      });
      persistState(confirmed);
      await runDiagnoseChain(confirmed);
    } finally {
      setRunning(false);
    }
  }

  async function handleConfirmEmergencyClearance(
    assessmentSummary: string,
    findings: EmergencyClearanceFindingAttestation[],
  ): Promise<void> {
    if (runningRef.current || isRunning) return;
    const summary = assessmentSummary.trim();
    const currentGate = evaluateSafetyGate(caseState);
    if (currentGate.status !== "red_flag") return;
    // 前端判据必须与服务端签发端逐字同源；服务端仍会独立重跑一遍（fail-closed 两道）。
    if (emergencyClearanceContractIssue({
      activeFindings: activeEmergencyClearanceFindingsFromGate(currentGate),
      attestations: findings,
      assessmentSummary: summary,
    })) return;

    setRunning(true);
    beginRunScope();
    try {
      const response = await fetchWithTimeout(apiUrl("/api/diagnosis/emergency-clearance"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caseState, assessmentSummary: summary, findings }),
      });
      const payload = await response.json().catch(() => null) as {
        emergencyClearance?: CaseState["emergencyClearance"];
        error?: string;
      } | null;
      if (!response.ok || !payload?.emergencyClearance) {
        throw new Error(payload?.error || `急症排查确认失败 (${response.status})`);
      }
      const confirmed = withSafetyGate({
        ...caseState,
        emergencyClearance: payload.emergencyClearance,
        previousResult: capturePreviousResult(caseState),
        diagnosis: undefined,
        prescription: undefined,
        riskAssessment: undefined,
        followupTimeline: undefined,
        reasoningDiagnose: undefined,
        reasoningPrescribe: undefined,
        reasoningV2: undefined,
        prescriptionRevision: undefined,
        auditAdvisory: undefined,
        warningAcknowledgement: undefined,
        safetyLocked: true,
        lastError: undefined,
        skipDifferentiationGate: true,
        phase: "diagnose",
      });
      if (confirmed.safetyGate?.status === "red_flag") {
        throw new Error("当前病历中的急危重风险线索已经变化，请重新完成现场评估并记录结果。");
      }
      persistState(confirmed);
      await runDiagnoseChain(confirmed);
    } catch (error) {
      persistState(setError(
        { ...caseState, phase: "diagnose" },
        normalizeRequestError(error, "急症排查记录未能绑定当前病历"),
      ));
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
  // F1：done 态下仍未回答/未跳过的追问保持“补充回答”提交语义（含选项投影与病历补充），
  // 而不是切回整轮重采集；与 handleSubmit 的分支路由保持一致。
  const isQuestionSupplementFlow = caseState.phase === "question" || limitedCanContinue || hasPendingFollowupQuestions(caseState);
  const liveUiCaseState = isQuestionSupplementFlow ? liveReassessmentCaseState : liveDraftCaseState;
  const chiefComplaintReady = hasChiefComplaintInput(recordDraft);
  const patientSexReady = Boolean(recordDraft.sex.trim());
  const patientAgeReady = parseAgeInput(recordDraft.age) != null;
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
  const pendingExportIsEmergency = Boolean(pendingReportExport) &&
    (caseState.safetyGate || evaluateSafetyGate(caseState)).status === "red_flag";
  const canSubmit = isQuestionSupplementFlow
    ? patientSexReady && patientAgeReady && chiefComplaintReady && hasSubmitChange && !modelInputTooLong
    : patientSexReady && patientAgeReady && chiefComplaintReady && hasHisRecordInput(recordDraft, input, Boolean(tongueImage)) && !modelInputTooLong;
  const noChangeToSubmit = patientSexReady && patientAgeReady && chiefComplaintReady && !canSubmit;
  const submitHint = !patientSexReady
    ? "请先选择性别；无法确认时可选择“其他或未明确”。"
    : !patientAgeReady
      ? "请录入有效年龄或月龄（如 45岁、6个月）；年龄用于安全规则判定。"
    : !chiefComplaintReady
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
            : "修改病历任一项后可重新评估。")
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
            lockReason={isRunning
              ? "本轮分析进行中，病历各栏暂时只读，以免读到改了一半的病历。需要现在修改，可在右侧点击“取消运行”。"
              : undefined}
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
            moduleDrafts={moduleDrafts}
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
            onConfirmEmergencyClearance={handleConfirmEmergencyClearance}
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
          {pendingReportExport && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-950/30 px-4" role="presentation">
              <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="report-export-confirm-title"
                className="w-full max-w-lg rounded-xl border border-gray-200 bg-white p-5 shadow-xl"
                data-testid="report-export-confirm"
              >
                <div className="flex items-start gap-3">
                  <AlertTriangle className={`mt-0.5 h-5 w-5 shrink-0 ${pendingReportExport.level === "L4" ? "text-red-600" : "text-amber-600"}`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 id="report-export-confirm-title" className="text-sm font-bold text-gray-900">
                        {pendingExportIsEmergency ? "下载转诊建议与依据" : "导出前风险确认"}
                      </h2>
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                        pendingReportExport.level === "L4" ? "bg-red-100 text-red-800" :
                        pendingReportExport.level === "L3" ? "bg-orange-100 text-orange-800" :
                        "bg-amber-100 text-amber-800"
                      }`}>
                        {pendingExportIsEmergency ? "急诊转诊建议" : `${pendingReportExport.level} · ${pendingReportExport.label}`}
                      </span>
                    </div>
                    <p className="mt-2 text-[13px] leading-relaxed text-gray-600">
                      {pendingReportExport.executable
                        ? "报告仍是辅助建议，不会自动写回正式诊断或医嘱。请确认已阅读以下风险。"
                        : pendingExportIsEmergency
                          ? "当前只导出转诊建议与触发依据，不含候选方药或剂量，不能用于开方或写回医嘱。"
                          : "当前安全评估不允许导出剂量级处方。系统只会生成不含候选剂量的安全评估说明，不能用于开方或写回医嘱。"}
                    </p>
                    <ul className="mt-2 list-disc space-y-1 pl-5 text-[12px] leading-relaxed text-gray-600">
                      {pendingReportExport.reasons.map((reason) => <li key={reason}>{reason}</li>)}
                    </ul>
                  </div>
                </div>

                {(pendingReportExport.level === "L3" || pendingReportExport.level === "L4") && (
                  <label className="mt-4 block text-[12px] font-semibold text-gray-700">
                    {pendingExportIsEmergency ? "转诊处置/导出用途" : "复核/导出理由"}
                    <textarea
                      value={reportExportReason}
                      onChange={(event) => setReportExportReason(event.target.value.slice(0, 500))}
                      maxLength={500}
                      rows={3}
                      placeholder={pendingExportIsEmergency ? "请记录转诊处置或本次导出用途" : "请记录已完成的复核或本次导出用途"}
                      className="mt-1.5 w-full resize-none rounded-lg border border-gray-200 px-3 py-2 text-[13px] font-normal outline-none focus:border-teal-400"
                    />
                  </label>
                )}

                <label className="mt-4 flex cursor-pointer items-start gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5 text-[12px] leading-relaxed text-gray-700">
                  <input
                    type="checkbox"
                    checked={reportExportAcknowledged}
                    onChange={(event) => setReportExportAcknowledged(event.target.checked)}
                    className="mt-0.5 h-4 w-4 rounded border-gray-300 text-teal-600"
                  />
                  <span>
                    我已阅读风险分级及处置边界，并确认本次导出仅供授权医务人员复核，不代表系统自动开具医嘱。
                  </span>
                </label>

                <div className="mt-4 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setPendingReportExport(null);
                      setReportExportAcknowledged(false);
                      setReportExportReason("");
                    }}
                    className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-[13px] font-bold text-gray-700 hover:bg-gray-50"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={confirmReportExport}
                    disabled={!reportExportAcknowledged || ((pendingReportExport.level === "L3" || pendingReportExport.level === "L4") && !reportExportReason.trim())}
                    className="rounded-lg bg-teal-600 px-3 py-2 text-[13px] font-bold text-white hover:bg-teal-700 disabled:cursor-not-allowed disabled:bg-gray-300"
                  >
                    {pendingReportExport.executable
                      ? "确认并导出"
                      : pendingExportIsEmergency
                        ? "下载转诊建议与依据"
                        : "导出安全评估说明"}
                  </button>
                </div>
              </div>
            </div>
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
