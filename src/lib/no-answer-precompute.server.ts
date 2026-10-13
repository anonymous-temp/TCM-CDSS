import type { CaseState } from "./diagnosis-types";
import { INTERNAL_PRECOMPUTE_HEADER, internalPrecomputeToken } from "./internal-precompute";
import { stageResultReuseEnabled } from "./stage-result-coalescing.server";

/**
 * 追问发出的同时，按「不回答」把辨证和开方先算出来（2026-10-13）。
 *
 * 生产留存：甲方 26 轮追问跳过了 21 轮，跳过之后还要等辨证约 12 秒、开方约 11 秒。医生看题的那几秒本来是空着的：
 * 这里在出题的同时就开始算「不回答」的结果，医生点跳过时，后面两步直接从结果复用里取现成的。
 *
 * 做法是经本机回环调自己的 diagnose / prescribe 接口，而不是直接调内部函数：两个阶段的全部编排、
 * 安全闸门、签名与结果复用指纹都在路由里，回环请求与调用方稍后发来的请求走的是同一条路，
 * 指纹相同（指纹不含病例阶段与追问轮次这些流程字段）就并入或复用，不相同只是白算一次。
 * 医生如果作答，病历多了一条回答，指纹不同，预先算的那份不会被用上。
 *
 * 只在结果复用开启时进行（生产默认开启）；`CDSS_M02_PRECOMPUTE_NO_ANSWER=false` 单独关闭。
 * 失败静默：它只是提前量，不影响追问本身。
 */

const STAGE_TIMEOUT_MS = 200_000;
const inFlight = new Map<string, number>();

function precomputeEnabled(): boolean {
  if (process.env.CDSS_M02_PRECOMPUTE_NO_ANSWER === "false") return false;
  return stageResultReuseEnabled();
}

function loopbackBase(): string {
  const port = process.env.PORT || "3000";
  const basePath = (process.env.NEXT_PUBLIC_BASE_PATH || "").replace(/\/+$/, "");
  return `http://127.0.0.1:${port}${basePath}`;
}

/** 调用方跳过追问后发来的病例形状：病历原样、对话为空、没有流程字段。 */
export function noAnswerCaseState(caseState: CaseState): Record<string, unknown> {
  const {
    phase: _phase, questionRounds: _rounds, questionOutcome: _outcome, maxQuestionRounds: _max,
    completeness: _completeness, safetyGate: _gate, clinicalFacts: _facts, lastError: _error,
    diagnosis: _diagnosis, prescription: _prescription, riskAssessment: _risk,
    reasoningDiagnose: _rd, reasoningPrescribe: _rp, reasoningV2: _rv2,
    ...record
  } = caseState;
  void _phase; void _rounds; void _outcome; void _max; void _completeness; void _gate; void _facts; void _error;
  void _diagnosis; void _prescription; void _risk; void _rd; void _rp; void _rv2;
  // 与真正发出去的请求体同形：值为 undefined 的键在 JSON 里不存在（归一把「键存在」当作「调用方声明了这一项」）。
  return JSON.parse(JSON.stringify({ ...record, conversation: [] })) as Record<string, unknown>;
}

function finalStructured(text: string): unknown {
  let content = "";
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const frame = JSON.parse(line) as { content?: unknown; type?: unknown };
      if (frame.type || typeof frame.content !== "string" || frame.content === "[END]") continue;
      content += frame.content;
    } catch {
      // 非 JSON 行忽略。
    }
  }
  const start = content.lastIndexOf("<!-- DIAGNOSIS_JSON_START -->");
  const end = start >= 0 ? content.indexOf("<!-- DIAGNOSIS_JSON_END -->", start) : -1;
  if (start < 0 || end < 0) return undefined;
  try {
    return JSON.parse(content.slice(start + "<!-- DIAGNOSIS_JSON_START -->".length, end).trim());
  } catch {
    return undefined;
  }
}

async function postStage(route: "diagnose" | "prescribe", headers: Headers, caseState: unknown): Promise<string | undefined> {
  const response = await fetch(`${loopbackBase()}/api/diagnosis/${route}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ caseState }),
    signal: AbortSignal.timeout(STAGE_TIMEOUT_MS),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return undefined;
  }
  return response.text();
}

export function precomputeNoAnswerPath(req: Request, caseState: CaseState): void {
  if (!precomputeEnabled()) return;
  // 只在首次出题时做：已有追问作答的病例不是「不回答」的形状。
  if ((caseState.conversation || []).length > 0 || caseState.questionRounds >= 1) return;
  if (!(caseState.chiefComplaint || "").trim()) return;
  void (async () => {
    const marker = await internalPrecomputeToken();
    if (!marker) return;
    const record = noAnswerCaseState(caseState);
    const dedupeKey = `${req.headers.get("x-cdss-customer-id") || ""}|${JSON.stringify(record)}`;
    const now = Date.now();
    for (const [key, startedAt] of inFlight) if (now - startedAt > STAGE_TIMEOUT_MS * 2) inFlight.delete(key);
    if (inFlight.has(dedupeKey)) return;
    inFlight.set(dedupeKey, now);
    try {
      const headers = new Headers({ "content-type": "application/json", [INTERNAL_PRECOMPUTE_HEADER]: marker });
      for (const name of ["x-cdss-api-token", "authorization", "x-cdss-customer-id", "x-cdss-client-id"]) {
        const value = req.headers.get(name);
        if (value) headers.set(name, value);
      }
      const startedAt = Date.now();
      const diagnosed = await postStage("diagnose", headers, record);
      const reasoningDiagnose = diagnosed ? finalStructured(diagnosed) : undefined;
      const diagnoseMs = Date.now() - startedAt;
      let prescribed = false;
      if (reasoningDiagnose && typeof reasoningDiagnose === "object" && (reasoningDiagnose as { stage?: unknown }).stage === "diagnose") {
        prescribed = Boolean(await postStage("prescribe", headers, { ...record, reasoningDiagnose }));
      }
      console.info("[tcm-cdss:telemetry] no_answer_precompute", {
        diagnosed: Boolean(reasoningDiagnose), prescribed, diagnoseMs, totalMs: Date.now() - startedAt,
      });
    } catch (error) {
      console.info("[tcm-cdss:telemetry] no_answer_precompute", { ok: false, reason: error instanceof Error ? error.name : "unknown" });
    } finally {
      inFlight.delete(dedupeKey);
    }
  })();
}
