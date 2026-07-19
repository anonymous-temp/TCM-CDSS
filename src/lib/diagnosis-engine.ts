// src/lib/diagnosis-engine.ts
import type { CaseState, Phase } from "./diagnosis-types";
import { ageValue, createInitialCaseState, normalizeCaseStateInput } from "./diagnosis-types";
import { extractDiagnosisJSON, stripDiagnosisJSON, parseCompleteness } from "./diagnosis-parse";
import { isUnknownClinicalFieldText, isUnknownClinicalText } from "./clinical-state";
import { safeHttpUrl } from "./safe-url";
import { STREAM_REPLACE_MARKER } from "./diagnosis-stream-protocol";
import { dateOnly, generalizeOccupation, scrubQuasiIdentifierText } from "./phi-sanitizer";

const LS_PREFIX = "diagnosis_case_";
const MAX_CONVERSATION = 10;
const ENABLE_BROWSER_CASE_PERSISTENCE = process.env.NEXT_PUBLIC_ENABLE_BROWSER_CASE_PERSISTENCE !== "false";
const STREAM_IDLE_TIMEOUT_MS = 195_000;
const STREAM_TOTAL_TIMEOUT_MS = 210_000;
let disabledPersistenceCleared = false;

type StreamConsumeOptions = {
  allowPartial?: boolean;
  idleTimeoutMs?: number;
  totalTimeoutMs?: number;
  abortSignal?: AbortSignal;
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

export function scrubPersistentPhiText(text: string, explicitNames: string[] = []): string {
  let next = text;
  for (const name of explicitNames) {
    const cleaned = name.trim();
    if (cleaned) next = next.replaceAll(cleaned, "[姓名已脱敏]");
  }

  // Redaction markers are terminal values. Protect them from the broad name/address recognizers so
  // saving, normalizing and saving the same case cannot consume a marker or change a signed hash.
  const protectedMarkers: string[] = [];
  next = next.replace(/\[(?:姓名|手机号|电话|邮箱|证件号|地址|出生日期|精确时间|职业)[^\]]*(?:脱敏|泛化)[^\]]*\]/g, (marker) => {
    const token = `__CDSS_REDACTION_${protectedMarkers.length}__`;
    protectedMarkers.push(marker);
    return token;
  });

  const scrubbed = scrubQuasiIdentifierText(next
    .replace(/(?:出生日期|出生年月日|出生年月|出生时间)\s*[:：]?\s*(?:19|20)\d{2}(?:[-/.年]\d{1,2})?(?:[-/.月]\d{1,2}日?)?/gi, "出生日期：[已脱敏]")
    .replace(/\b(?:19|20)\d{2}[-/.]\d{1,2}[-/.]\d{1,2}\b/g, "[出生日期已脱敏]")
    .replace(/(?:姓名|患者|家属|联系人|陪同者|监护人)\s*[:：]?\s*[A-Z][A-Za-z'-]{1,30}(?:\s+[A-Z][A-Za-z'-]{1,30}){1,3}/g, (match) => {
      const label = match.match(/^(姓名|患者|家属|联系人|陪同者|监护人)/)?.[1] || "人员";
      return `${label}：[姓名已脱敏]`;
    })
    .replace(/(^|[；;。\n]\s*)([A-Z][A-Za-z'-]{1,30}(?:\s+[A-Z][A-Za-z'-]{1,30}){1,3})(?=\s*(?:昨夜|今日|今晨|近日|近\d|来诊|就诊|入院|出院|自述|反映|称|表示|出现|发生|患|失眠|头痛|头晕|胸痛|腹痛|发热|咳嗽|心悸))/g, "$1[姓名已脱敏]")
    .replace(/(^|[；;。\n]\s*)([A-Z][A-Za-z'-]{1,30}(?:\s+[A-Z][A-Za-z'-]{1,30}){1,3})(?=\s*[\u4e00-\u9fa5])/g, "$1[姓名已脱敏]")
    .replace(/((?:患者|家属|联系人|陪同者|监护人|医生|医师)?\s*)(?:赵|钱|孙|李|周|吴|郑|王|冯|陈|褚|卫|蒋|沈|韩|杨|朱|秦|尤|许|何|吕|施|张|孔|曹|严|华|金|魏|陶|姜|戚|谢|邹|喻|柏|水|窦|章|云|苏|潘|葛|奚|范|彭|郎|鲁|韦|昌|马|苗|凤|花|方|俞|任|袁|柳|鲍|史|唐|费|廉|岑|薛|雷|贺|倪|汤|滕|殷|罗|毕|郝|邬|安|常|乐|于|时|傅|皮|卞|齐|康|伍|余|元|顾|孟|黄|和|穆|萧|尹|姚|邵|汪|祁|毛|禹|狄|米|贝|明|臧|计|伏|成|戴|宋|茅|庞|熊|纪|舒|屈|项|祝|董|梁|杜|阮|蓝|闵|席|季|麻|强|贾|路|娄|危|江|童|颜|郭|梅|盛|林|钟|徐|邱|骆|高|夏|蔡|田|樊|胡|凌|霍|虞|万|支|柯|管|卢|莫|房|裘|缪|干|解|应|宗|丁|宣|邓|郁|单|杭|洪|包|诸|左|石|崔|吉|龚|程|嵇|邢|裴|陆|荣|翁|荀|羊|甄|曲|封|储|靳|段|巫|乌|焦|巴|弓|牧|隗|山|谷|车|侯|宓|蓬|全|班|仰|秋|仲|伊|宫|宁|仇|栾|暴|甘|厉|戎|祖|武|符|刘|景|詹|束|龙|叶|幸|司|韶|黎|乔|苍|双|闻|莘|党|翟|谭|贡|劳|逄|姬|申|扶|堵|冉|宰|郦|雍|却|璩|桑|桂|濮|牛|寿|通|边|扈|燕|冀|浦|尚|农|温|别|庄|晏|柴|瞿|阎|连|习|艾|鱼|容|向|古|易|廖|终|步|都|耿|满|弘|匡|国|文|寇|广|禄|阙|东|欧|利|蔚|越|夔|隆|师|巩|厍|聂|晁|勾|敖|融|冷|訾|辛|阚|那|简|饶|空|曾|毋|沙|乜|养|鞠|须|丰|巢|关|蒯|相|查|后|荆|红|游|竺|权|逯|盖|益|桓|公)[\u4e00-\u9fa5]{1,2}(?=(?:昨夜|今日|今晨|近日|来诊|就诊|入院|出院|自述|反映|称|表示|告知))/g, "$1[姓名已脱敏]")
    .replace(/(?:患者|家属|联系人|陪同者|监护人|医生|医师)\s*[:：]?\s*[\u4e00-\u9fa5]{2,4}(?=[，,；。\s]|反映|诉|称|表示|告知|建议|记录)/g, (match) => {
      const label = match.match(/^(患者|家属|联系人|陪同者|监护人|医生|医师)/)?.[1] || "人员";
      return `${label}[姓名已脱敏]`;
    })
    .replace(/(^|[\s，,；。:：])[\u4e00-\u9fa5]{2,4}(?=\s*(?:\[手机号已脱敏\]|1[3-9]\d{9}|电话|手机))/g, "$1[姓名已脱敏]")
    .replace(/\b1[3-9]\d{9}\b/g, "[手机号已脱敏]")
    .replace(/\b0\d{2,3}-?\d{7,8}\b/g, "[电话已脱敏]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[邮箱已脱敏]")
    .replace(/\b[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g, "[证件号已脱敏]")
    .replace(/(身份证号?|证件号?|医保号|社保号|就诊号|门诊号|住院号|病案号|病历号|病例号|病例编号|电子病历号|医疗记录号|患者编号|MRN)\s*[:：]?\s*[A-Za-z0-9-]{4,}/gi, (_match, label: string) => {
      return `${label}：[已脱敏]`;
    })
    .replace(/(?:住址|地址|家庭住址|工作单位)\s*[:：]?\s*[^，；。\n]+/g, (match) => {
      const label = match.split(/[:：]/)[0] || "地址";
      return `${label}：[已脱敏]`;
    }));

  return protectedMarkers.reduce(
    (restored, marker, index) => restored.replaceAll(`__CDSS_REDACTION_${index}__`, marker),
    scrubbed,
  );
}

function scrubFreeClinicalInputForPersistence(value: unknown, explicitNames: string[]): unknown {
  if (typeof value === "string") return scrubPersistentPhiText(value, explicitNames);
  if (Array.isArray(value)) return value.map((item) => scrubFreeClinicalInputForPersistence(item, explicitNames));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key, raw]) =>
    /(name|姓名|患者名|联系人|身份证|证件|电话|手机|地址|住址|就诊号|门诊号|住院号|病案号|病历号|病例号|病例编号|电子病历号|医疗记录号|患者编号|mrn|medical.?record|record.?number|patient.?id)/i.test(key)
      ? []
      : [[key, scrubFreeClinicalInputForPersistence(raw, explicitNames)]],
  ));
}

function scrubExplicitNamesForPersistence(text: string, explicitNames: string[]): string {
  return explicitNames.reduce((next, name) => {
    const cleaned = name.trim();
    return cleaned ? next.replaceAll(cleaned, "[姓名已脱敏]") : next;
  }, text);
}

export function sanitizeCaseStateForBrowserPersistence(state: CaseState): CaseState {
  const explicitNames = [state.patient.name, state.hisRecord?.fields.patientName].filter((item): item is string => Boolean(item?.trim()));
  return {
    // M03/M04/M05、处方与审方对象是受治理的结构化临床输出，必须原样持久化；
    // 仅对明确身份字段、M01/M02 自由病历输入和用户回答执行脱敏。
    ...state,
    // “跳过追问”是本次医生操作意图，不是病例事实；刷新后必须重新确认，不能被快照自动沿用。
    skipDifferentiationGate: undefined,
    patient: {
      ...state.patient,
      name: undefined,
      occupation: generalizeOccupation(state.patient.occupation),
    },
    chiefComplaint: scrubPersistentPhiText(state.chiefComplaint, explicitNames),
    symptoms: scrubFreeClinicalInputForPersistence(state.symptoms, explicitNames) as CaseState["symptoms"],
    tongue: state.tongue ? scrubPersistentPhiText(state.tongue, explicitNames) : undefined,
    pulse: state.pulse ? scrubPersistentPhiText(state.pulse, explicitNames) : undefined,
    faceNote: state.faceNote ? scrubPersistentPhiText(state.faceNote, explicitNames) : undefined,
    vitals: state.vitals
      ? scrubFreeClinicalInputForPersistence(state.vitals, explicitNames) as CaseState["vitals"]
      : undefined,
    pastHistory: state.pastHistory ? scrubPersistentPhiText(state.pastHistory, explicitNames) : undefined,
    medicationHistory: state.medicationHistory ? scrubPersistentPhiText(state.medicationHistory, explicitNames) : undefined,
    allergyHistory: state.allergyHistory ? scrubPersistentPhiText(state.allergyHistory, explicitNames) : undefined,
    conversation: state.conversation.map((message) => ({
      ...message,
      content: message.role === "user"
        ? scrubPersistentPhiText(message.content, explicitNames)
        : scrubExplicitNamesForPersistence(message.content, explicitNames),
    })),
    previousResult: state.previousResult ? {
      capturedAt: dateOnly(state.previousResult.capturedAt),
      diagnosis: state.previousResult.diagnosis
        ? scrubExplicitNamesForPersistence(state.previousResult.diagnosis, explicitNames)
        : undefined,
      prescription: state.previousResult.prescription
        ? scrubExplicitNamesForPersistence(state.previousResult.prescription, explicitNames)
        : undefined,
      riskAssessment: state.previousResult.riskAssessment
        ? scrubExplicitNamesForPersistence(state.previousResult.riskAssessment, explicitNames)
        : undefined,
    } : undefined,
    lastError: state.lastError ? {
      ...state.lastError,
      message: scrubExplicitNamesForPersistence(state.lastError.message, explicitNames),
    } : undefined,
    faceCapture: state.faceCapture ? { ...state.faceCapture, updatedAt: dateOnly(state.faceCapture.updatedAt) } : undefined,
    prescriptionRevision: state.prescriptionRevision ? {
      ...state.prescriptionRevision,
      auditedAt: dateOnly(state.prescriptionRevision.auditedAt),
      auditId: undefined,
      traceId: undefined,
    } : undefined,
    hisRecord: state.hisRecord ? {
      ...state.hisRecord,
      updatedAt: dateOnly(state.hisRecord.updatedAt),
      fields: {
        ...scrubFreeClinicalInputForPersistence(
          state.hisRecord.fields,
          explicitNames,
        ) as NonNullable<CaseState["hisRecord"]>["fields"],
        patientName: undefined,
      },
      rawText: scrubPersistentPhiText(state.hisRecord.rawText || "", explicitNames),
    } : undefined,
  };
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
    await reader.cancel().catch(() => undefined);
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
          } else if ("content" in chunk && chunk.content != null) {
            malformedLines += 1;
          }
        } catch {
          malformedLines += 1;
        }
      }
      if (sawEnd) {
        if (buffer.trim()) malformedLines += 1;
        await reader.cancel().catch(() => undefined);
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
function stripEvimedTrailingQuestions(text: string): string {
  // 1. Strip duplicate evidence/reference sections generated by EviMed
  //    These overlap with our ## 参考文献 section built from structured quote data
  const cleaned = text.replace(
    /^##\s*(?:循证文献依据|循证处方依据|循证随访依据|参考文献|循证证据|文献依据)[\s\S]*?(?=^##\s|\s*$)/gm,
    ""
  );

  // 2. Strip trailing "是否希望..." bullets
  const lines = cleaned.split("\n");
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

export async function consumeMarkdownStream(
  response: Response,
  onChunk: (text: string) => void,
  opts?: StreamConsumeOptions,
): Promise<string> {
  if (!response.body) throw new Error("模型响应为空");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + (opts?.totalTimeoutMs ?? STREAM_TOTAL_TIMEOUT_MS);
  let buffer = "";
  let accumulated = "";
  const qutoItems: unknown[] = [];
  let sawEnd = false;
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
          malformedLines += 1;
          continue;
        }
        try {
          const chunk = JSON.parse(line) as Record<string, unknown>;
          if (typeof chunk.error === "string" && chunk.error.trim()) {
            markValidFrame();
            upstreamError = chunk.error.trim();
          } else if (Array.isArray(chunk.quto)) {
            markValidFrame();
            qutoItems.push(...(chunk.quto as unknown[]));
          } else if (chunk.type === "heartbeat" && typeof chunk.status === "string") {
            markValidFrame();
            const visible = filterStreamingText(accumulated);
            onChunk([visible, chunk.status.trim()].filter(Boolean).join("\n\n"));
          } else if (chunk.content === "[END]") {
            markValidFrame();
            sawEnd = true;
          } else if (typeof chunk.content === "string" && chunk.content) {
            markValidFrame();
            accumulated = applyStreamChunk(accumulated, chunk.content);
            onChunk(filterStreamingText(accumulated));
          } else if ("content" in chunk && chunk.content != null) {
            malformedLines += 1;
          }
        } catch {
          malformedLines += 1;
        }
      }
      if (sawEnd) {
        if (buffer.trim()) malformedLines += 1;
        await reader.cancel().catch(() => undefined);
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
        } else if (Array.isArray(chunk.quto)) {
          markValidFrame();
          qutoItems.push(...(chunk.quto as unknown[]));
        } else if (chunk.type === "heartbeat" && typeof chunk.status === "string") {
          markValidFrame();
          const visible = filterStreamingText(accumulated);
          onChunk([visible, chunk.status.trim()].filter(Boolean).join("\n\n"));
        } else if (chunk.content === "[END]") {
          markValidFrame();
          sawEnd = true;
        } else if (typeof chunk.content === "string" && chunk.content) {
          markValidFrame();
          accumulated = applyStreamChunk(accumulated, chunk.content);
          onChunk(filterStreamingText(accumulated));
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

  return accumulated;
}

/**
 * Build a Markdown ## 参考文献 section from optional quote items.
 * Quote objects usually include title/literatureTitle/url/journal/author/year.
 * Falls back to string handling for simpler formats.
 * Deduplicates by title to avoid repeated citations.
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
      if (seenTitles.has(item.trim())) return;
      seenTitles.add(item.trim());
      const encoded = encodeURIComponent(item.trim().slice(0, 150));
      lines.push(`${lines.length + 1}. [${safeLabel(item.trim())}](https://www.evimed.com/#/search?keywords=${encoded})`);
    } else if (item && typeof item === "object") {
      const obj = item as Record<string, unknown>;
      // Use literatureTitle (full citation) if available, else title
      const display =
        typeof obj.literatureTitle === "string" && obj.literatureTitle.trim()
          ? obj.literatureTitle.trim()
          : typeof obj.title === "string" && obj.title.trim()
          ? obj.title.trim()
          : null;
      // Prefer evimed URL for direct deep-link
      // url can be a string or a dict {"h5_evimed": "...", "evimed": "..."}
      const urlField = obj.url;
      const href =
        typeof urlField === "string"
          ? safeEvimedUrl(urlField)
          : urlField && typeof urlField === "object"
          ? (() => {
              const u = urlField as Record<string, unknown>;
              return safeEvimedUrl(u.evimed) || safeEvimedUrl(u.h5_evimed) || null;
            })()
          : null;
      const finalHref = href ?? (display
        ? `https://www.evimed.com/#/search?keywords=${encodeURIComponent(display.slice(0, 150))}`
        : "https://www.evimed.com/");
      if (display) {
        if (seenTitles.has(display)) return;
        seenTitles.add(display);
        lines.push(`${lines.length + 1}. [${safeLabel(display)}](${finalHref})`);
      }
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
  if (!rejectedTongueImage && !updated.tongue && usableModelString(jsonData.tongue) && !isUnknownClinicalFieldText(jsonData.tongue, "tongue")) updated = { ...updated, tongue: jsonData.tongue.trim() };
  if (!updated.pulse && usableModelString(jsonData.pulse) && !isUnknownClinicalFieldText(jsonData.pulse, "pulse")) updated = { ...updated, pulse: jsonData.pulse.trim() };
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
