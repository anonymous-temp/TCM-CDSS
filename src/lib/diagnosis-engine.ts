// src/lib/diagnosis-engine.ts
import type { CaseState, Phase, StructuredFollowupTimelineItem } from "./diagnosis-types";
import { ageValue, createInitialCaseState, normalizeCaseStateInput } from "./diagnosis-types";
import { extractDiagnosisJSON, stripDiagnosisJSON, parseCompleteness } from "./diagnosis-parse";
import { isUnknownClinicalFieldText, isUnknownClinicalText, isUnrecordedInspectionFieldValue } from "./clinical-state";
import { safeHttpUrl } from "./safe-url";
import {
  parseStreamModuleDraftFrame,
  parseWarningProfileFrame,
  STREAM_REPLACE_MARKER,
  type StreamModuleDraftFrame,
} from "./diagnosis-stream-protocol";
import type { WarningDisplayReceipt } from "./warning-display-binding";
import { stripEvimedTrailingQuestions } from "./markdown-stream-content";
import { sanitizeCaseStateForBrowserPersistence } from "./browser-case-persistence";
export { scrubPersistentPhiText, sanitizeCaseStateForBrowserPersistence } from "./browser-case-persistence";

const LS_PREFIX = "diagnosis_case_";
const MAX_CONVERSATION = 10;
const ENABLE_BROWSER_CASE_PERSISTENCE = process.env.NEXT_PUBLIC_ENABLE_BROWSER_CASE_PERSISTENCE !== "false";
const STREAM_IDLE_TIMEOUT_MS = 195_000;
const STREAM_TOTAL_TIMEOUT_MS = 210_000;
let disabledPersistenceCleared = false;

type StreamConsumeOptions = {
  /** Only M05's designated final-result consumer may collect this outer metadata channel. */
  collectWarningProfile?: boolean;
  allowPartial?: boolean;
  idleTimeoutMs?: number;
  totalTimeoutMs?: number;
  abortSignal?: AbortSignal;
  onModuleDraft?: (frame: StreamModuleDraftFrame) => void;
  onFinalReplacement?: () => void;
  /** 服务端心跳帧（{type:"heartbeat",status}）上报；仅信息展示，不参与流内容与超时判定。 */
  onHeartbeat?: (status: string) => void;
};

// ─── Persistence ─────────────────────────────────────────────────────────────

function clearBrowserDiagnosisCases(): void {
  try {
    Object.keys(localStorage)
      .filter((key) => key.startsWith(LS_PREFIX))
      .forEach((key) => localStorage.removeItem(key));
  } catch {
    // localStorage may be unavailable
  }
}

function clearDisabledPersistenceOnce(): void {
  if (ENABLE_BROWSER_CASE_PERSISTENCE || disabledPersistenceCleared) return;
  disabledPersistenceCleared = true;
  clearBrowserDiagnosisCases();
}

export function isBrowserCasePersistenceEnabled(): boolean {
  return ENABLE_BROWSER_CASE_PERSISTENCE;
}


export function saveCase(state: CaseState): void {
  void state;
  clearDisabledPersistenceOnce();
  // Durable browser recovery is owned by the encrypted workspace envelope in DiagnosisClient.
  // Legacy per-case plaintext snapshots are intentionally never written.
}

export function loadCase(id: string): CaseState | null {
  void id;
  clearBrowserDiagnosisCases();
  return null;
}

export function loadLatestCase(): CaseState | null {
  clearBrowserDiagnosisCases();
  return null;
}

export function clearCase(id: string): void {
  try {
    localStorage.removeItem(`${LS_PREFIX}${id}`);
  } catch {
    // silent
  }
}

export function clearAllSavedCases(): void {
  clearBrowserDiagnosisCases();
}

// ─── Stream consumers ─────────────────────────────────────────────────────────

/**
 * Strip partially-streamed sentinel JSON from display text during streaming.
 * Removes everything from "<!-- DIAGNOSIS_JSON_START" or any "第三部分" heading onward.
 * Matches as soon as "第三部分" appears — no need to wait for the colon.
 */
function filterSentinelFromStreaming(text: string): string {
  // 1. Strip from sentinel marker start (partial or full)
  const sentinelIdx = text.indexOf("<!-- DIAGNOSIS_JSON");
  if (sentinelIdx !== -1) return text.slice(0, sentinelIdx).trimEnd();

  // 2. Strip from any model-emitted structured-data heading.
  const structuredPatterns = ["结构化JSON", "结构化数据", "DIAGNOSIS_JSON", "第三部分"];
  const structuredIdx = structuredPatterns
    .map((pattern) => text.indexOf(pattern))
    .filter((idx) => idx !== -1)
    .sort((a, b) => a - b)[0];
  if (structuredIdx !== undefined) {
    const lineStart = text.lastIndexOf("\n", structuredIdx);
    return text.slice(0, lineStart === -1 ? structuredIdx : lineStart).trimEnd();
  }

  return text;
}

function cancelStreamReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  // Transport cancellation is cleanup, not a delivery condition. It may never settle after a
  // broken connection; END, timeout and user cancellation must still finish promptly.
  void reader.cancel().catch(() => undefined);
}

async function readStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  deadline: number,
  opts?: StreamConsumeOptions,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (opts?.abortSignal?.aborted) throw new Error("推理已取消");

  const idleTimeoutMs = opts?.idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS;
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw new Error("模型流总耗时超限，请重试当前阶段");
  const timeoutMs = Math.max(1, Math.min(idleTimeoutMs, remainingMs));

  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let abortHandler: (() => void) | null = null;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error("模型流长时间无数据，请重试当前阶段")), timeoutMs);
  });
  const abortPromise = opts?.abortSignal
    ? new Promise<never>((_, reject) => {
        abortHandler = () => reject(new Error("推理已取消"));
        opts.abortSignal?.addEventListener("abort", abortHandler, { once: true });
      })
    : null;

  try {
    return await Promise.race([
      reader.read(),
      timeoutPromise,
      ...(abortPromise ? [abortPromise] : []),
    ]);
  } catch (error) {
    cancelStreamReader(reader);
    throw error;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    if (abortHandler) opts?.abortSignal?.removeEventListener("abort", abortHandler);
  }
}

/**
 * Consume a streaming NDJSON response.
 * Calls onChunk with the full accumulated text on each new chunk.
 * Returns the final accumulated string.
 */
async function consumeStream(
  response: Response,
  onChunk: (accumulated: string) => void,
  opts?: StreamConsumeOptions,
): Promise<string> {
  if (!response.body) throw new Error("模型响应为空");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + (opts?.totalTimeoutMs ?? STREAM_TOTAL_TIMEOUT_MS);
  let buffer = "";
  let accumulated = "";
  let sawEnd = false;
  let malformedLines = 0;
  let upstreamError = "";
  try {
    while (true) {
      const { done, value } = await readStreamChunk(reader, deadline, opts);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        if (sawEnd) {
          malformedLines += 1;
          continue;
        }
        try {
          const chunk = JSON.parse(line) as Record<string, unknown>;
          if (typeof chunk.error === "string" && chunk.error.trim()) {
            upstreamError = chunk.error.trim();
          } else if (chunk.content === "[END]") {
            sawEnd = true;
          } else if (typeof chunk.content === "string" && chunk.content) {
            accumulated = applyStreamChunk(accumulated, chunk.content);
            onChunk(filterSentinelFromStreaming(accumulated));
          } else if (chunk.type === "heartbeat" && typeof chunk.status === "string" && chunk.status.trim()) {
            // M01/M02 的心跳此前被分支链整个忽略（2026-08-25 审查 X3）：服务端每 5s 的
            // 进度/排队信息在采集与追问阶段全部蒸发，医生最长 3.5 分钟只看到一行计秒。
            opts?.onHeartbeat?.(chunk.status.trim());
          } else if ("content" in chunk && chunk.content != null) {
            malformedLines += 1;
          }
        } catch {
          malformedLines += 1;
        }
      }
      if (sawEnd) {
        if (buffer.trim()) malformedLines += 1;
        cancelStreamReader(reader);
        buffer = "";
        break;
      }
    }

    // Flush remaining buffer
    if (!sawEnd && buffer.trim()) {
      try {
        const chunk = JSON.parse(buffer) as Record<string, unknown>;
        if (typeof chunk.error === "string" && chunk.error.trim()) {
          upstreamError = chunk.error.trim();
        } else if (chunk.content === "[END]") {
          sawEnd = true;
        } else if (typeof chunk.content === "string" && chunk.content) {
          accumulated = applyStreamChunk(accumulated, chunk.content);
          onChunk(filterSentinelFromStreaming(accumulated));
        } else if ("content" in chunk && chunk.content != null) {
          malformedLines += 1;
        }
      } catch {
        malformedLines += 1;
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (upstreamError) {
    throw new Error(upstreamError);
  }
  if (!sawEnd) {
    throw new Error("模型流未完整结束，请重试");
  }
  if (malformedLines > 0) {
    throw new Error("模型流格式异常，请重试");
  }
  if (!accumulated.trim()) {
    throw new Error("模型未返回有效内容");
  }

  return accumulated;
}

/**
 * Consume M01/M02 stream: extracts and strips sentinel JSON from result.
 */
export async function consumeCollectStream(
  response: Response,
  onChunk: (text: string) => void,
  opts?: StreamConsumeOptions,
): Promise<{ displayContent: string; jsonData: Record<string, unknown> | null }> {
  const accumulated = await consumeStream(response, onChunk, opts);
  const jsonData = extractDiagnosisJSON(accumulated);
  if (!jsonData) throw new Error("模型未返回完整结构化数据，请重试或改为手动补充信息");
  const displayContent = stripDiagnosisJSON(accumulated);
  return { displayContent, jsonData };
}

/**
 * Strip the "## 红旗排查" section from diagnosis text so it only appears in the right panel.
 */
export function stripRedFlagSection(text: string): string {
  return text
    .replace(/^##\s*红旗排查[\s\S]*?(?=^##|\s*$)/m, "")
    .trim();
}

/**
 * Strip provider-generated trailing follow-up question bullets ("- 是否希望...").
 * Also strip inline reference/evidence sections that duplicate the structured
 * ## 参考文献 section we can build from quote data.
 */

/**
 * Lightweight streaming filter applied to accumulated text BEFORE onChunk.
 * Strips trailing "是否希望..." lines and complete "## 循证..." sections
 * so they never flash in the UI during streaming.
 */
function filterStreamingText(text: string): string {
  // A final replacement marker may be split across multiple NDJSON content frames by a future
  // adapter. Hide any trailing marker prefix so internal protocol text never flashes in the UI.
  const markerStart = text.lastIndexOf("<<<");
  if (markerStart >= 0 && STREAM_REPLACE_MARKER.startsWith(text.slice(markerStart))) {
    text = text.slice(0, markerStart);
  }
  const sentinelIdx = text.indexOf("<!-- DIAGNOSIS_JSON");
  if (sentinelIdx !== -1) return text.slice(0, sentinelIdx).trimEnd();
  const structuredIdx = text.search(/(?:结构化JSON|结构化数据|DIAGNOSIS_JSON|V2结构化展示数据)/);
  if (structuredIdx !== -1) {
    const lineStart = text.lastIndexOf("\n", structuredIdx);
    return text.slice(0, lineStart === -1 ? structuredIdx : lineStart).trimEnd();
  }
  // 1. Strip complete evidence sections (same regex as post-stream strip)
  const filtered = text.replace(
    /^##\s*(?:循证文献依据|循证处方依据|循证随访依据|参考文献|循证证据|文献依据)[\s\S]*?(?=^##\s|\s*$)/gm,
    ""
  );
  // 2. Strip trailing "是否希望..." lines
  const lines = filtered.split("\n");
  let end = lines.length;
  while (end > 0) {
    const line = lines[end - 1].trim();
    if (line === "" || /^[-•*]\s*是否/.test(line) || /^是否/.test(line)) {
      end--;
    } else {
      break;
    }
  }
  return lines.slice(0, end).join("\n");
}

/**
 * Consume M03/M04/M05 stream: pure Markdown, no JSON extraction.
 * Also handles optional {"quto":[...]} messages emitted by evidence adapters and
 * appends a formatted ## 参考文献 section with provider links.
 */
function applyStreamChunk(accumulated: string, content: string): string {
  const combined = accumulated + content;
  const markerIdx = combined.indexOf(STREAM_REPLACE_MARKER);
  return markerIdx >= 0 ? combined.slice(markerIdx + STREAM_REPLACE_MARKER.length) : combined;
}

function parseTypedFollowupTimeline(value: unknown): StructuredFollowupTimelineItem[] | null {
  if (!Array.isArray(value)) return null;
  const items = value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const item = entry as Record<string, unknown>;
    if (typeof item.time !== "string" || !item.time.trim() ||
      typeof item.action !== "string" || !item.action.trim() ||
      !Array.isArray(item.indicators) || !item.indicators.every((part) => typeof part === "string" && Boolean(part.trim())) ||
      !Array.isArray(item.triggers) || !item.triggers.every((part) => typeof part === "string" && Boolean(part.trim()))) {
      return [];
    }
    return [{
      time: item.time.trim(),
      action: item.action.trim(),
      indicators: item.indicators.slice(0, 8) as string[],
      triggers: item.triggers.slice(0, 8) as string[],
    }];
  }).slice(0, 8);
  return items.length === value.length && items.length > 0 ? items : null;
}

export async function consumeMarkdownStreamWithMetadata(
  response: Response,
  onChunk: (text: string) => void,
  opts?: StreamConsumeOptions,
): Promise<{ content: string; followupTimeline: StructuredFollowupTimelineItem[]; warningObservation?: WarningDisplayReceipt }> {
  if (!response.body) throw new Error("模型响应为空");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + (opts?.totalTimeoutMs ?? STREAM_TOTAL_TIMEOUT_MS);
  let buffer = "";
  let accumulated = "";
  const qutoItems: unknown[] = [];
  let followupTimeline: StructuredFollowupTimelineItem[] = [];
  let sawEnd = false;
  let sawFinalReplacement = false;
  let warningObservation: WarningDisplayReceipt | undefined;
  let warningFrames = 0;
  let invalidWarningObservation = false;
  const acceptWarningFrame = (chunk: Record<string, unknown>): boolean => {
    if (chunk.type !== "warning_profile") return false;
    if (!opts?.collectWarningProfile) return true;
    warningFrames += 1;
    const parsed = parseWarningProfileFrame(chunk);
    if (warningFrames !== 1 || sawEnd || !parsed) invalidWarningObservation = true;
    if (!invalidWarningObservation) warningObservation = parsed;
    return true;
  };
  const acceptContent = (content: string) => {
    if (!sawFinalReplacement && (accumulated + content).includes(STREAM_REPLACE_MARKER)) {
      sawFinalReplacement = true;
      opts?.onFinalReplacement?.();
    }
    accumulated = applyStreamChunk(accumulated, content);
    onChunk(filterStreamingText(accumulated));
  };
  let malformedLines = 0;
  let upstreamError = "";
  const idleWindowMs = opts?.idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS;
  let lastValidFrameAt = Date.now();
  const validFrameReadOptions = (): StreamConsumeOptions => ({
    ...opts,
    idleTimeoutMs: Math.max(1, lastValidFrameAt + idleWindowMs - Date.now()),
  });
  const markValidFrame = () => {
    lastValidFrameAt = Date.now();
  };

  try {
    while (true) {
      const { done, value } = await readStreamChunk(reader, deadline, validFrameReadOptions());
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        if (sawEnd) {
          try {
            const chunk = JSON.parse(line) as Record<string, unknown>;
            if (typeof chunk.error === "string" && chunk.error.trim()) {
              upstreamError = chunk.error.trim();
              continue;
            }
            if (acceptWarningFrame(chunk) || parseStreamModuleDraftFrame(chunk)) continue;
          } catch { /* retain malformed-frame handling */ }
          malformedLines += 1;
          continue;
        }
        try {
          const chunk = JSON.parse(line) as Record<string, unknown>;
          if (typeof chunk.error === "string" && chunk.error.trim()) {
            markValidFrame();
            upstreamError = chunk.error.trim();
          } else if (acceptWarningFrame(chunk)) {
            // Metadata never carries, appends or replaces clinical content, even when malformed.
          } else if (Array.isArray(chunk.quto)) {
            markValidFrame();
            qutoItems.push(...(chunk.quto as unknown[]));
          } else if (chunk.type === "heartbeat" && typeof chunk.status === "string") {
            markValidFrame();
            const visible = filterStreamingText(accumulated);
            onChunk([visible, chunk.status.trim()].filter(Boolean).join("\n\n"));
          } else if (chunk.type === "module_draft") {
            const moduleDraft = parseStreamModuleDraftFrame(chunk);
            if (moduleDraft) {
              markValidFrame();
              if (!sawFinalReplacement && !opts?.abortSignal?.aborted) opts?.onModuleDraft?.(moduleDraft);
            } else {
              malformedLines += 1;
            }
          } else if (chunk.type === "followup_timeline") {
            const parsedTimeline = parseTypedFollowupTimeline(chunk.timelineItems);
            if (parsedTimeline) {
              markValidFrame();
              followupTimeline = parsedTimeline;
            } else {
              malformedLines += 1;
            }
          } else if (chunk.content === "[END]") {
            markValidFrame();
            sawEnd = true;
          } else if (typeof chunk.content === "string" && chunk.content) {
            markValidFrame();
            acceptContent(chunk.content);
          } else if ("content" in chunk && chunk.content != null) {
            malformedLines += 1;
          }
        } catch {
          malformedLines += 1;
        }
      }
      if (sawEnd) {
        if (buffer.trim()) {
          try {
            const tail = JSON.parse(buffer) as Record<string, unknown>;
            if (typeof tail.error === "string" && tail.error.trim()) upstreamError = tail.error.trim();
            else if (!acceptWarningFrame(tail) && !parseStreamModuleDraftFrame(tail)) malformedLines += 1;
          }
          catch { malformedLines += 1; }
        }
        cancelStreamReader(reader);
        buffer = "";
        break;
      }
    }
    // Flush remaining buffer
    if (!sawEnd && buffer.trim()) {
      try {
        const chunk = JSON.parse(buffer) as Record<string, unknown>;
        if (typeof chunk.error === "string" && chunk.error.trim()) {
          markValidFrame();
          upstreamError = chunk.error.trim();
        } else if (acceptWarningFrame(chunk)) {
          // Malformed metadata is omitted without touching the readable report.
        } else if (Array.isArray(chunk.quto)) {
          markValidFrame();
          qutoItems.push(...(chunk.quto as unknown[]));
        } else if (chunk.type === "heartbeat" && typeof chunk.status === "string") {
          markValidFrame();
          const visible = filterStreamingText(accumulated);
          onChunk([visible, chunk.status.trim()].filter(Boolean).join("\n\n"));
        } else if (chunk.type === "module_draft") {
          const moduleDraft = parseStreamModuleDraftFrame(chunk);
          if (moduleDraft) {
            markValidFrame();
            if (!sawFinalReplacement && !opts?.abortSignal?.aborted) opts?.onModuleDraft?.(moduleDraft);
          } else {
            malformedLines += 1;
          }
        } else if (chunk.type === "followup_timeline") {
          const parsedTimeline = parseTypedFollowupTimeline(chunk.timelineItems);
          if (parsedTimeline) {
            markValidFrame();
            followupTimeline = parsedTimeline;
          } else {
            malformedLines += 1;
          }
        } else if (chunk.content === "[END]") {
          markValidFrame();
          sawEnd = true;
        } else if (typeof chunk.content === "string" && chunk.content) {
          markValidFrame();
          acceptContent(chunk.content);
        } else if ("content" in chunk && chunk.content != null) {
          malformedLines += 1;
        }
      } catch {
        malformedLines += 1;
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (!accumulated.trim()) {
    if (upstreamError) {
      throw new Error(upstreamError);
    }
    if (malformedLines > 0) {
      throw new Error("模型流格式异常，请重试");
    }
    throw new Error("模型未返回有效内容");
  }
  const recoverableStreamIssue = Boolean(opts?.allowPartial) && accumulated.trim().length >= 200 && (Boolean(upstreamError) || !sawEnd || malformedLines > 0);
  if (upstreamError && !recoverableStreamIssue) {
    throw new Error(upstreamError);
  }
  if (!sawEnd && !recoverableStreamIssue) {
    throw new Error("模型流未完整结束，请重试");
  }
  if (malformedLines > 0 && !recoverableStreamIssue) {
    throw new Error("模型流格式异常，请重试");
  }

  // Strip trailing questions BEFORE appending references (otherwise they end up
  // sandwiched between content and references, and the backward-walking strip misses them)
  accumulated = stripEvimedTrailingQuestions(accumulated);

  if (recoverableStreamIssue) {
    const issue = upstreamError
      ? `模型服务返回错误：${upstreamError}`
      : !sawEnd
        ? "未收到结束标记"
        : "存在少量无法解析的流式片段";
    accumulated += [
      "",
      "## 流式完整性提示",
      `本阶段模型响应已返回主要内容，但${issue}。请医生复核当前内容；如需正式采纳处方或写回病历，建议重试当前阶段或进行人工复核。`,
    ].join("\n");
  }

  // Append real reference list from quote data
  if (qutoItems.length > 0) {
    const refSection = buildReferenceSection(qutoItems);
    if (refSection) {
      accumulated = accumulated + "\n\n" + refSection;
    }
  }

  return { content: accumulated, followupTimeline,
    ...(opts?.collectWarningProfile && !invalidWarningObservation && !recoverableStreamIssue && sawEnd &&
      !upstreamError && malformedLines === 0 && !opts?.abortSignal?.aborted && warningObservation ? { warningObservation } : {}),
  };
}

export async function consumeMarkdownStream(
  response: Response,
  onChunk: (text: string) => void,
  opts?: StreamConsumeOptions,
): Promise<string> {
  return (await consumeMarkdownStreamWithMetadata(response, onChunk, opts)).content;
}

const PATIENT_NARRATIVE_REFERENCE = /(?:^|[\s；;|])(?:主诉|现病史|既往史|过敏史|用药史|患者事实|病例事实|本例资料|病历原文|舌象|脉象|生命体征)\s*[：:]|(?:患者|病人)\s*(?:诉|自述|描述|出现|伴有|伴随)|基于本例(?:病史|症状|资料|主诉)/;
const REFERENCE_IDENTIFIER = /\b(?:PMID|PMCID|DOI)\s*[:：]?\s*[A-Za-z0-9._/-]+/i;
const REFERENCE_YEAR = /\b(?:19|20)\d{2}\b/;

function quoteText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(quoteText).filter(Boolean).join("、");
  return "";
}

function bibliographicStringReference(value: string): boolean {
  const text = value.trim();
  if (!text || PATIENT_NARRATIVE_REFERENCE.test(text)) return false;
  return REFERENCE_IDENTIFIER.test(text) ||
    (/《[^》]{2,120}》/.test(text) && REFERENCE_YEAR.test(text));
}

/**
 * Build a Markdown ## 参考文献 section from optional quote items.
 *
 * Upstream adapters sometimes place the retrieval query or copied chief complaint in `quto`.
 * A bare string or title is therefore not evidence. Only records carrying bibliographic identity
 * (DOI/PMID, or title plus author/journal/year metadata) are allowed into the clinician-facing
 * reference list.
 */
function buildReferenceSection(items: unknown[]): string {
  const lines: string[] = [];
  const seenTitles = new Set<string>();
  const safeLabel = (value: string) => value.replace(/[\r\n]+/g, " ").replace(/[\[\]()<>*_`]/g, (char) => `\\${char}`).trim();
  const safeEvimedUrl = (value: unknown): string => {
    const safe = safeHttpUrl(value, "");
    if (!safe) return "";
    try {
      const host = new URL(safe).hostname.toLowerCase();
      return host === "evimed.com" || host.endsWith(".evimed.com") ? safe : "";
    } catch {
      return "";
    }
  };
  items.forEach((item) => {
    if (typeof item === "string" && item.trim()) {
      if (!bibliographicStringReference(item)) return;
      if (seenTitles.has(item.trim())) return;
      seenTitles.add(item.trim());
      const doi = item.match(/\b10\.\d{4,9}\/[^\s，。；、）》】]+/i)?.[0];
      const pmid = item.match(/\bPMID\s*[:：]?\s*(\d{4,12})/i)?.[1];
      const href = doi
        ? `https://doi.org/${doi}`
        : pmid
          ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`
          : `https://www.evimed.com/#/search?keywords=${encodeURIComponent(item.trim().slice(0, 150))}`;
      lines.push(`${lines.length + 1}. [${safeLabel(item.trim())}](${href})`);
    } else if (item && typeof item === "object") {
      const obj = item as Record<string, unknown>;
      const display =
        typeof obj.literatureTitle === "string" && obj.literatureTitle.trim()
          ? obj.literatureTitle.trim()
          : typeof obj.title === "string" && obj.title.trim()
          ? obj.title.trim()
          : null;
      if (!display || PATIENT_NARRATIVE_REFERENCE.test(display)) return;
      const author = quoteText(obj.author || obj.authors);
      const journal = quoteText(obj.journal || obj.publisher || obj.organization);
      const year = quoteText(obj.year || obj.publicationYear || obj.publicationDate || obj.publishDate)
        .match(REFERENCE_YEAR)?.[0] || "";
      const doi = quoteText(obj.doi || obj.DOI).match(/10\.\d{4,9}\/[^\s，。；、）》】]+/i)?.[0] ||
        display.match(/\b10\.\d{4,9}\/[^\s，。；、）》】]+/i)?.[0] || "";
      const pmid = quoteText(obj.pmid || obj.PMID).match(/\d{4,12}/)?.[0] ||
        display.match(/\bPMID\s*[:：]?\s*(\d{4,12})/i)?.[1] || "";
      const hasBibliographicIdentity = Boolean(
        doi || pmid ||
        (year && (author || journal)) ||
        (author && journal),
      );
      if (!hasBibliographicIdentity) return;
      const urlField = obj.url;
      const evimedHref =
        typeof urlField === "string"
          ? safeEvimedUrl(urlField)
          : urlField && typeof urlField === "object"
          ? (() => {
              const u = urlField as Record<string, unknown>;
              return safeEvimedUrl(u.evimed) || safeEvimedUrl(u.h5_evimed) || null;
            })()
          : null;
      const finalHref = evimedHref ||
        (doi ? `https://doi.org/${doi}` : "") ||
        (pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : "") ||
        `https://www.evimed.com/#/search?keywords=${encodeURIComponent(display.slice(0, 150))}`;
      const citation = [display, author, journal, year, doi ? `DOI:${doi}` : "", pmid ? `PMID:${pmid}` : ""]
        .filter(Boolean)
        .join("；");
      if (seenTitles.has(citation)) return;
      seenTitles.add(citation);
      lines.push(`${lines.length + 1}. [${safeLabel(citation)}](${finalHref})`);
    }
  });
  if (lines.length === 0) return "";
  return `## 参考文献\n\n${lines.join("\n")}`;
}

// ─── CaseState mutation helpers ───────────────────────────────────────────────

function mergeStructuredData(
  state: CaseState,
  jsonData: Record<string, unknown> | null,
): CaseState {
  if (!jsonData) return state;

  let updated = state;
  const nonEmptyString = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  const usableModelString = (value: unknown): value is string =>
    nonEmptyString(value) && !isUnknownClinicalText(value);

  const completeness = parseCompleteness(jsonData);
  if (completeness) updated = { ...updated, completeness };

  const normalizedTongueDx = jsonData.tongueDx
    ? normalizeCaseStateInput({ ...updated, tongueDx: jsonData.tongueDx })?.tongueDx
    : undefined;
  const rejectedTongueImage = Boolean(normalizedTongueDx?.quality.needRetake);
  if (normalizedTongueDx && !rejectedTongueImage) {
    updated = {
      ...updated,
      tongueDx: normalizedTongueDx,
      tongue: updated.tongue || normalizedTongueDx.summaryText || updated.tongue,
      tongueImageDesc: updated.tongueImageDesc || normalizedTongueDx.summaryText || updated.tongueImageDesc,
    };
  }

  if (jsonData.symptoms && typeof jsonData.symptoms === "object") {
    updated = {
      ...updated,
      symptoms: {
        ...updated.symptoms,
        ...(jsonData.symptoms as Record<string, unknown>),
      },
    };
  }
  // 字段槽口径（2026-08-26）：M01 抽出来的是**要写进舌/脉栏的值**，问题是「这段文本算不算
  // 一条已记录的所见」，不是「写法是不是标准脉名」。用严格识别面会把医生原话里的转述式
  // 描述整段丢掉，栏位留空，门禁随即报未采集——与门禁面同一个缺陷的上游半段。
  if (!rejectedTongueImage && !updated.tongue && usableModelString(jsonData.tongue) && !isUnrecordedInspectionFieldValue(jsonData.tongue, "tongue")) updated = { ...updated, tongue: jsonData.tongue.trim() };
  if (!updated.pulse && usableModelString(jsonData.pulse) && !isUnrecordedInspectionFieldValue(jsonData.pulse, "pulse")) updated = { ...updated, pulse: jsonData.pulse.trim() };
  if (!updated.faceNote && usableModelString(jsonData.faceNote)) updated = { ...updated, faceNote: jsonData.faceNote.trim() };

  if (jsonData.vitals && typeof jsonData.vitals === "object") {
    updated = {
      ...updated,
      vitals: {
        ...(jsonData.vitals as Record<string, unknown>),
        ...(updated.vitals || {}),
      },
    };
  }
  if (!updated.pastHistory && usableModelString(jsonData.pastHistory)) updated = { ...updated, pastHistory: jsonData.pastHistory.trim() };
  if (!updated.medicationHistory && usableModelString(jsonData.medicationHistory) && !isUnknownClinicalFieldText(jsonData.medicationHistory, "medication")) updated = { ...updated, medicationHistory: jsonData.medicationHistory.trim() };
  if (!updated.allergyHistory && usableModelString(jsonData.allergyHistory) && !isUnknownClinicalFieldText(jsonData.allergyHistory, "allergy")) updated = { ...updated, allergyHistory: jsonData.allergyHistory.trim() };

  if (jsonData.patient && typeof jsonData.patient === "object") {
    const p = jsonData.patient as Record<string, unknown>;
    updated = {
      ...updated,
      patient: {
        name: undefined,
        sex: updated.patient.sex || (usableModelString(p.sex) ? p.sex.trim() : undefined),
        age: updated.patient.age ?? ageValue(p.age),
        occupation: updated.patient.occupation || (usableModelString(p.occupation) ? p.occupation.trim() : undefined),
      },
    };
  }

  return updated;
}

/**
 * Apply M01 collect result to CaseState.
 * Extracts patient, symptoms, tongue, pulse, vitals, and history fields from jsonData.
 */
export function applyCollectResult(
  state: CaseState,
  displayContent: string,
  jsonData: Record<string, unknown> | null,
  userInput: string
): CaseState {
  void displayContent;
  const newConv = [
    ...state.conversation,
    { role: "user" as const, content: userInput },
  ].slice(-MAX_CONVERSATION);

  const updated: CaseState = {
    ...state,
    chiefComplaint: state.chiefComplaint || userInput,
    conversation: newConv,
  };

  return mergeStructuredData(updated, jsonData);
}

export function applyQuestionResult(
  state: CaseState,
  displayContent: string,
  jsonData: Record<string, unknown> | null,
  opts?: { countRound?: boolean }
): CaseState {
  const newConv = [
    ...state.conversation,
    { role: "assistant" as const, content: displayContent },
  ].slice(-MAX_CONVERSATION);

  const updated: CaseState = {
    ...state,
    conversation: newConv,
    questionRounds: opts?.countRound === false ? state.questionRounds : state.questionRounds + 1,
  };

  return mergeStructuredData(updated, jsonData);
}

export function applyUserAnswer(state: CaseState, answer: string): CaseState {
  const newConv = [
    ...state.conversation,
    { role: "user" as const, content: answer },
  ].slice(-MAX_CONVERSATION);
  // Free-text follow-up answers remain immutable source evidence for M01/M02 semantic extraction
  // and M03 reasoning. Only explicit option patches or clinician-edited HIS fields may mutate the
  // structured chart; local keyword parsing must not promote prose into trusted clinical facts.
  return { ...state, conversation: newConv };
}

export function shouldProceedToDiagnose(state: CaseState): boolean {
  return state.completeness.level === "C";
}

export function setPhase(state: CaseState, phase: Phase): CaseState {
  return { ...state, phase };
}

export function setError(state: CaseState, message: string): CaseState {
  return {
    ...state,
    phase: "error",
    lastError: { phase: state.phase, message },
  };
}

export function newCase(): CaseState {
  return createInitialCaseState();
}

export function exportCaseJSON(state: CaseState): void {
  const sanitized = sanitizeCaseStateForBrowserPersistence(state);
  const exportState = {
    ...sanitized,
    id: "case-export",
    hisRecord: sanitized.hisRecord ? { ...sanitized.hisRecord, caseId: "case-export" } : undefined,
  };
  const blob = new Blob([JSON.stringify(exportState, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `diagnosis_export_${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 100);
}
