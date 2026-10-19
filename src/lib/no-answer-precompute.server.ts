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

/** 回环调 diagnose，再用它交付的 M03 调 prescribe；与调用方稍后的请求同指纹时并入或复用。失败静默。 */
function runPrecomputeChain(req: Request, record: Record<string, unknown>, label: "no_answer_precompute" | "answered_precompute"): void {
  void (async () => {
    const marker = await internalPrecomputeToken();
    if (!marker) return;
    const dedupeKey = `${label}|${req.headers.get("x-cdss-customer-id") || ""}|${JSON.stringify(record)}`;
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
      console.info(`[tcm-cdss:telemetry] ${label}`, {
        diagnosed: Boolean(reasoningDiagnose), prescribed, diagnoseMs, totalMs: Date.now() - startedAt,
      });
    } catch (error) {
      console.info(`[tcm-cdss:telemetry] ${label}`, { ok: false, reason: error instanceof Error ? error.name : "unknown" });
    } finally {
      inFlight.delete(dedupeKey);
    }
  })();
}

export function precomputeNoAnswerPath(req: Request, caseState: CaseState): void {
  if (!precomputeEnabled()) return;
  // 只在首次出题时做：已有追问作答的病例不是「不回答」的形状。
  if ((caseState.conversation || []).length > 0 || caseState.questionRounds >= 1) return;
  if (!(caseState.chiefComplaint || "").trim()) return;
  runPrecomputeChain(req, noAnswerCaseState(caseState), "no_answer_precompute");
}

/** 作答后的病例形状：病历与对话原样，去掉流程字段与各阶段产物（与 stage-result-coalescing 的指纹同一口径）。 */
export function answeredCaseState(caseState: CaseState): Record<string, unknown> {
  const { conversation, ...rest } = caseState;
  return { ...noAnswerCaseState(rest as CaseState), conversation: JSON.parse(JSON.stringify(conversation || [])) };
}

/**
 * 医生作答之后、调用方按顺序先调红旗筛查再调辨证（2026-10-19 第九轮）。
 *
 * 甲方接口验收给了各能力的 P90/P99；生产上按甲方传参方式、作答后冷算实测（10 例）：红旗筛查约 5 秒（事实层随作答重算）、
 * 辨证约 13 秒、开方约 11 秒。红旗筛查与辨证之间没有任何医生操作，于是在红旗筛查收到作答后的病例时，就按同一病例
 * 经回环先算辨证和开方；调用方随后发来的辨证请求指纹相同（指纹不含流程字段）就并入正在算的那一份，体感少掉红旗筛查这几秒。
 *
 * 不做的情形：没有作答（未追问或跳过，出题时已按「不回答」预先算过）；页面请求（只带登录 cookie）；请求带 x-cdss-regenerate（评测要求重新生成，
 * 预先算的一份用不上，只会让生产多算一遍）；结果复用关闭；`CDSS_REDFLAGS_PRECOMPUTE=false`。
 */
export function precomputeAnsweredPath(req: Request, caseState: CaseState): void {
  if (!precomputeEnabled() || process.env.CDSS_REDFLAGS_PRECOMPUTE === "false") return;
  if (req.headers.get("x-cdss-regenerate") === "1" || new URL(req.url).searchParams.get("regenerate") === "1") return;
  // 只给接口调用方（HIS 带令牌头）：页面作答后的病例形状与它随后发出的辨证请求不同，先算的一份并不上，白占一路并发。
  if (!req.headers.get("x-cdss-api-token") && !/^Bearer\s/i.test(req.headers.get("authorization") || "")) return;
  if (!(caseState.chiefComplaint || "").trim()) return;
  const answered = (caseState.conversation || []).some((message, index, all) =>
    message?.role === "user" && index > 0 && all[index - 1]?.role === "assistant" && typeof message.content === "string" && message.content.trim().length > 0);
  if (!answered) return;
  runPrecomputeChain(req, answeredCaseState(caseState), "answered_precompute");
}
