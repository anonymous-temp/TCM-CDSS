import type { CaseState } from "./diagnosis-types";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { getPrimaryTextModelConfig, createTextModelClient, isApprovedTextModel, textModelRequestTuning } from "./text-model";
import {
  CLINICAL_FACTS_EXTRACTOR_VERSION,
  CLINICAL_FACTS_PROMPT_VERSION,
  extractClinicalFacts,
  type ClinicalFactsModelIdentity,
  type ClinicalFactsUnavailableReason,
  type FactsLlmCall,
  type ClinicalFactsPhase,
} from "./clinical-facts";
import { sanitizeCaseStateForModel, trustedInputText } from "./diagnosis-safety";
import { parseCustomerId } from "./customer-id";
import { observeModelTask, recordModelTaskTelemetry } from "./cdss-model-task-telemetry";
import { modelUsageSnapshot } from "./openai-compatible-response";

export { CLINICAL_FACTS_EXTRACTOR_VERSION, CLINICAL_FACTS_PROMPT_VERSION } from "./clinical-facts";

/**
 * LLM 临床语义红旗层的运行时接线。
 *
 * 默认启用；仅当 `CDSS_CLINICAL_FACTS_BACKSTOP === "false"` 时关闭。确定性层负责危急生命体征与明确高置信
 * 事实，LLM 层负责口语、组合语义、否定和时序。模型结论必须通过 schema 与原文引用校验后才可进入
 * 追加提醒/澄清链；它不单独拥有硬红旗门权。
 * 抽取失败(模型不可用/超时/输出非法)清除陈旧 finding，并显式标记 semantic unavailable，供安全门在
 * 允许 M03 继续分析的同时阻断静默处方升级。
 */

export const CLINICAL_FACTS_ATTESTATION_VERSION = "tcm-cdss-clinical-facts-attestation-v8";
export const CLINICAL_FACTS_CACHE_TTL_MS = 5 * 60_000;
// A signed M03 may legitimately consume the full 180s orchestration budget, and one bounded M04
// regeneration can extend the same unchanged chain beyond the ordinary semantic cache TTL. Routes
// may opt into this ceiling only after they have verified the stage signature that binds the exact
// case state. The normal red-flag/question/diagnose cache policy remains unchanged.
export const CLINICAL_FACTS_SIGNED_CHAIN_CACHE_TTL_MS = 10 * 60_000;
/**
 * 空红旗结果的短 TTL。2026-08-08 由 30s 抬到 150s，理由与边界如下——
 *
 * 现象：prod 集实测 diagnose+prescribe p50 57.4s、488/488 全部 > 30s。于是"无红旗"这个多数
 * 病例在走到 M05 时必然过期，assess 路由触发 extract+review 两次串行模型调用，把一个对外声称
 * "完全确定性"的阶段拖到 p50 7.0s / p90 17.5s。
 *
 * 为什么抬它不等于放宽陈旧风险：内容陈旧由 sourceFingerprint 全额覆盖（:447 要求指纹逐字节
 * 相等，病历改一个字就重抽），版本陈旧由 attestation/extractor/prompt 三个版本字段覆盖。
 * 时间 TTL 在这三者之上只剩一件事：对**同一段文本**再抽一次样。同一输入的第二次抽样并不能发现
 * 新的临床内容，只是同一张彩票再买一次；而第一次抽样已经过单调性复核（review 不得抹掉 grounded
 * 结果）。所以这里让渡的是"每 30 秒重抽一次"的复采样频率，不是任何一条可判定的安全性质。
 *
 * 保留的不变量：空结果 TTL 仍必须**短于**有 finding 的结果（150s < 300s）——空结果是风险方向，
 * 复采样价值更高，这个不对称是刻意的，scripts/test-clinical-facts.mjs 对两条都有断言。
 */
export const CLINICAL_FACTS_EMPTY_CACHE_TTL_MS = 150_000;
const CLINICAL_FACTS_FUTURE_SKEW_MS = 30_000;
const CLINICAL_FACTS_SOURCE_LIMIT = 12_000;
const PROJECTED_SOURCE_MARKER = "【原始病历中段已按模型上下文预算省略】";

function projectClinicalFactsSource(fullText: string): { text: string; coverage: "full" | "partial" } {
  if (fullText.length <= CLINICAL_FACTS_SOURCE_LIMIT) {
    return { text: fullText, coverage: fullText.includes(PROJECTED_SOURCE_MARKER) ? "partial" : "full" };
  }
  const half = Math.floor((CLINICAL_FACTS_SOURCE_LIMIT - 120) / 2);
  return {
    text: `${fullText.slice(0, half)}\n【中间病历过长，语义预检仅保留首尾；完整病历仍进入后续临床推理】\n${fullText.slice(-half)}`,
    coverage: "partial",
  };
}

function clinicalFactsTotalTimeoutMs(): number {
  const configured = Number(process.env.CLINICAL_FACTS_TOTAL_TIMEOUT_MS || 25_000);
  return Number.isFinite(configured) && configured >= 5_000 && configured <= 30_000
    ? Math.round(configured)
    : 25_000;
}

function clinicalFactsPhaseTimeoutMs(): number {
  // 8s 对长病历的复核相位偏紧（TCM-SD 真实住院病历现病史+查体上千字，实测撞不过去）。
  // 提到 12s：成功例本来就在 3–5s/相位，不受影响；长病历多出的 4s 换回的是
  // 30% → 目标 <10% 的语义层不可用率。总预算 25s 不动——超时不再重试后，
  // 最坏路径是抽取(~4s)+复核(12s) ≈ 16s，比原先烧满 25s 更快降级。
  const configured = Number(process.env.CLINICAL_FACTS_PHASE_TIMEOUT_MS || 12_000);
  return Number.isFinite(configured) && configured >= 3_000 && configured <= 12_000
    ? Math.round(configured)
    : 8_000;
}

type ClinicalFactsPhaseModel = ClinicalFactsModelIdentity & {
  apiKey: string;
  endpoint: string;
  configured: boolean;
  source: "primary" | "independent_review";
};

function chatCompletionsEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/chat/completions`;
}

function endpointAllowed(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    if (url.protocol === "https:") return true;
    return process.env.NODE_ENV !== "production" && url.protocol === "http:" &&
      /^(localhost|127\.0\.0\.1|::1|\[::1\])$/.test(url.hostname);
  } catch {
    return false;
  }
}

function primaryFactsPhaseModel(model: string): ClinicalFactsPhaseModel {
  const primary = getPrimaryTextModelConfig();
  const endpoint = chatCompletionsEndpoint(primary.baseUrl);
  return {
    provider: primary.provider,
    model,
    apiKey: primary.apiKey,
    endpoint,
    configured: Boolean(primary.configured && primary.apiKey && isApprovedTextModel(model) && endpointAllowed(endpoint)),
    source: "primary",
  };
}

function independentFactsReviewModel(): ClinicalFactsPhaseModel {
  const primary = getPrimaryTextModelConfig();
  // All textual clinical reasoning is pinned to DeepSeek. GLM credentials are reserved exclusively
  // for the image-only tongue route and can never become a silent safety-review fallback.
  const provider = (process.env.PRIMARY_CLINICAL_REVIEW_PROVIDER || "primary")
    .trim().toLowerCase();
  // PRIMARY_CLINICAL_REVIEW_PROVIDER 管的是 **M03/M04 的独立临床复核**。此前这里把它
  // 一并当成本相位的开关：只要它不是 primary，临床事实复核相位直接判 unconfigured。
  //
  // 实测代价（2026-08-16）：为落地 T8′②a 把该变量设为 bailian-qwen 后，M03/M04 跨厂商复核
  // 确实生效（attestation independentFromGenerator=true），但**临床事实探针随即 ok=false、
  // health?strict=1 塌成 strictReady=false**——而 Docker healthcheck 打的正是这个口，
  // 容器进入 health: starting 并重启。两个本该独立的能力被这一行做成了互斥。
  //
  // 保留 fail-closed 默认：跨厂商拓扑下本相位默认仍判未配置（本文件不实现 bailian 传输，
  // 静默改用主模型等于把「独立」二字变成假话）。但给一条**显式**出口——
  // 运维显式设置 CLINICAL_FACTS_REVIEW_MODEL 时，表示已知本相位走主模型传输、
  // 与 M03/M04 的跨厂商复核是两件事，此时按该模型配置放行。
  // 显式优于沉默：不设就仍然 fail-closed，设了就必须是运维写下来的那一行。
  const explicitFactsReviewModel = process.env.CLINICAL_FACTS_REVIEW_MODEL?.trim();
  if (provider !== "primary" && !explicitFactsReviewModel) {
    return {
      provider: "unconfigured",
      model: "unconfigured",
      apiKey: "",
      endpoint: "",
      configured: false,
      source: "independent_review",
    };
  }
  const model = explicitFactsReviewModel ||
    process.env.PRIMARY_CLINICAL_REVIEW_MODEL?.trim() ||
    process.env.PRIMARY_DIAGNOSE_MODEL?.trim() || primary.model;
  return primaryFactsPhaseModel(model);
}

function sameModelIdentity(a: ClinicalFactsModelIdentity, b: ClinicalFactsModelIdentity): boolean {
  return a.provider === b.provider && a.model === b.model;
}

export function getClinicalFactsModelPlan() {
  const primary = getPrimaryTextModelConfig();
  // Triage is a compact JSON classification task. All identities follow the approved primary
  // DeepSeek release model; phase-specific token/reasoning budgets keep this pre-check bounded.
  const extractor = primaryFactsPhaseModel(process.env.CLINICAL_FACTS_MODEL?.trim() || primary.model);
  const reviewer = independentFactsReviewModel();
  const adjudicator = primaryFactsPhaseModel(
    process.env.CLINICAL_FACTS_ADJUDICATION_MODEL?.trim() ||
    process.env.CLINICAL_FACTS_MODEL?.trim() || primary.model,
  );
  const independentReview = reviewer.configured && !sameModelIdentity(extractor, reviewer);
  const independentAdjudication = adjudicator.configured && !sameModelIdentity(reviewer, adjudicator);
  return {
    extractor,
    reviewer,
    adjudicator,
    independentReview,
    independentAdjudication,
    separateInvocationReview: reviewer.configured,
    separateInvocationAdjudication: adjudicator.configured,
    // Same-model phases are still separate calls, but they may not erase or downgrade a grounded
    // first-pass risk. Disposition reductions require a genuinely different model identity in both
    // downstream phases.
    reductionsAllowed: independentReview && independentAdjudication,
  };
}

type ClinicalFactsModelProbeResult = {
  ok: boolean;
  reason: "ok" | "not_configured" | "unauthorized" | "timeout" | "invalid_response" | "unavailable";
};

type ClinicalFactsModelsProbe = {
  checkedAt: string;
  latencyMs: number;
  cached?: boolean;
  ok: boolean;
  phases: {
    extractor: ClinicalFactsModelProbeResult;
    reviewer: ClinicalFactsModelProbeResult;
    adjudicator: ClinicalFactsModelProbeResult;
  };
};

let clinicalFactsProbeCache: { expiresAt: number; value: ClinicalFactsModelsProbe } | undefined;
let clinicalFactsProbeInFlight: Promise<ClinicalFactsModelsProbe> | undefined;

function modelProbeReason(error: unknown): ClinicalFactsModelProbeResult["reason"] {
  const message = String(error instanceof Error ? error.message : error || "");
  if (/not_configured/.test(message)) return "not_configured";
  if (/(?:http_|status code )401|unauthor/i.test(message)) return "unauthorized";
  if (/abort|timeout/i.test(message)) return "timeout";
  return "unavailable";
}

async function probeClinicalFactsPhaseModel(config: ClinicalFactsPhaseModel): Promise<ClinicalFactsModelProbeResult> {
  if (!config.configured) return { ok: false, reason: "not_configured" };
  try {
    const raw = await callFactsPhaseModel(
      config,
      "你是JSON健康探针，只输出一个JSON对象。",
      "只输出 {\"ok\":true}，不要解释。",
      AbortSignal.timeout(12_000),
      "probe",
    );
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) return { ok: false, reason: "invalid_response" };
    const parsed = JSON.parse(raw.slice(start, end + 1)) as { ok?: unknown };
    return parsed.ok === true
      ? { ok: true, reason: "ok" }
      : { ok: false, reason: "invalid_response" };
  } catch (error) {
    return { ok: false, reason: modelProbeReason(error) };
  }
}

export async function probeClinicalFactsModels() {
  if (clinicalFactsProbeCache && clinicalFactsProbeCache.expiresAt > Date.now()) {
    return { ...clinicalFactsProbeCache.value, cached: true };
  }
  if (clinicalFactsProbeInFlight) {
    const shared = await clinicalFactsProbeInFlight;
    return { ...shared, cached: true };
  }
  const run = (async (): Promise<ClinicalFactsModelsProbe> => {
  const plan = getClinicalFactsModelPlan();
  const startedAt = Date.now();
  // 三个相位在默认全 V4-Flash 拓扑下是**同一个模型身份**，逐个探等于对同一个端点打三次。
  // health?strict=1 由 Docker healthcheck 每 60s 触发一次，这是纯浪费的真实上游调用。
  // 按 endpoint+model 去重后按身份分发结果——与复核探针（diagnosis-api.ts:720）同款做法，
  // 那边一直是去重的，这边没有，又一处「同一件事两处各写各的」。
  const probeByIdentity = new Map<string, Promise<Awaited<ReturnType<typeof probeClinicalFactsPhaseModel>>>>();
  const probeOnce = (phase: typeof plan.extractor) => {
    const identity = `${phase?.endpoint ?? ""}|${phase?.model ?? ""}`;
    const existing = probeByIdentity.get(identity);
    if (existing) return existing;
    const created = probeClinicalFactsPhaseModel(phase);
    probeByIdentity.set(identity, created);
    return created;
  };
  const [extractor, reviewer, adjudicator] = await Promise.all([
    probeOnce(plan.extractor),
    probeOnce(plan.reviewer),
    probeOnce(plan.adjudicator),
  ]);
  const value: ClinicalFactsModelsProbe = {
    checkedAt: new Date().toISOString(),
    latencyMs: Date.now() - startedAt,
    cached: false,
    ok: extractor.ok && reviewer.ok && adjudicator.ok,
    phases: { extractor, reviewer, adjudicator },
  };
  clinicalFactsProbeCache = {
    expiresAt: Date.now() + (value.ok ? 5 * 60_000 : 30_000),
    value,
  };
  return value;
  })();
  clinicalFactsProbeInFlight = run;
  try {
    return await run;
  } finally {
    if (clinicalFactsProbeInFlight === run) clinicalFactsProbeInFlight = undefined;
  }
}

async function callFactsPhaseModel(
  config: ClinicalFactsPhaseModel,
  system: string,
  user: string,
  signal: AbortSignal | undefined,
  // "probe" 不是临床相位，只用于账本分档：健康探针每轮 3 次、每次 41 token，
  // 混进 clinical_facts_extract 会把真实抽取成本算歪（实测均值被从 2100 拉到 1469）。
  phase: ClinicalFactsPhase | "probe" = "extract",
): Promise<string> {
  const task = `clinical_facts_${phase}`;
  const promptChars = system.length + user.length;
  if (!config.configured) throw new Error("model_not_configured");
  // A single slow phase must not consume the entire extractor+review budget. Keeping the phase
  // deadline separate leaves room for the one bounded independent-review retry below while the
  // outer request deadline still caps total work.
  const phaseSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(clinicalFactsPhaseTimeoutMs())])
    : AbortSignal.timeout(clinicalFactsPhaseTimeoutMs());
  if (config.source === "independent_review") {
    const startedAt = Date.now();
    const response = await fetch(config.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0,
        max_tokens: 1800,
        response_format: { type: "json_object" },
        ...textModelRequestTuning(config.model, { reasoningEffort: "low", thinkingEnabled: false }),
      }),
      signal: phaseSignal,
    });
    if (!response.ok) throw new Error(`review_model_http_${response.status}`);
    const body = await response.json() as {
      choices?: Array<{ message?: { content?: string | null } }>;
      usage?: unknown;
    };
    // 该分支走裸 fetch（独立复核端点可能与主 provider 不同），拿不到 SDK 的返回对象，
    // 所以不能用 observeModelTask 包；直接从响应体抽 usage 记同一本账。
    const usage = modelUsageSnapshot(body);
    recordModelTaskTelemetry({
      task,
      stage: "shared",
      model: config.model,
      provider: "independent_review",
      promptChars,
      outcome: "ok",
      durationMs: Date.now() - startedAt,
      promptTokens: usage?.promptTokens || 0,
      completionTokens: usage?.completionTokens || 0,
      cachedTokens: usage?.cachedTokens || 0,
      totalTokens: usage?.totalTokens || 0,
    });
    return body.choices?.[0]?.message?.content || "";
  }
  const primary = getPrimaryTextModelConfig();
  const client = createTextModelClient({ ...primary, model: config.model });
  const res = await observeModelTask({ task, stage: "shared", model: config.model, promptChars }, () => client.chat.completions.create(
    {
      model: config.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0,
      // This classifier has a tiny JSON contract. Disable extended thinking so the provider cannot
      // spend the whole output budget on hidden reasoning and leave an empty/partial final object.
      max_tokens: 1800,
      response_format: { type: "json_object" },
      ...textModelRequestTuning(config.model, { reasoningEffort: "low", thinkingEnabled: false }),
    },
    { timeout: clinicalFactsPhaseTimeoutMs(), signal: phaseSignal },
  ));
  return res.choices?.[0]?.message?.content || "";
}

export async function callClinicalFactsPhaseWithRetry(
  call: () => Promise<string>,
  signal: AbortSignal | undefined,
  maxAttempts: 1 | 2,
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (signal?.aborted) throw signal.reason || new DOMException("Aborted", "AbortError");
    try {
      const content = await call();
      if (content.trim()) return content;
      lastError = new Error("empty_clinical_facts_phase_response");
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("clinical_facts_phase_unavailable");
}

const REAL_FACTS_LLM_CALL: FactsLlmCall = async (system, user, signal, phase = "extract") => {
  const plan = getClinicalFactsModelPlan();
  const config = phase === "review" ? plan.reviewer
    : phase === "adjudicate" ? plan.adjudicator
      : plan.extractor;
  // Extraction gets one transport/empty-response retry. Independent review has its own bounded
  // full-contract retry in extractClinicalFacts, which reuses the exact same grounded first pass;
  // keeping this transport wrapper single-shot for review prevents multiplicative retries.
  // Repair/adjudication remain single-shot so disagreement cannot be retried into an easier result.
  const maxAttempts = phase === "extract" ? 2 : 1;
  return callClinicalFactsPhaseWithRetry(
    () => callFactsPhaseModel(config, system, user, signal, phase),
    signal,
    maxAttempts,
  );
};

function attestationKey(): string {
  return process.env.CLINICAL_FACTS_ATTESTATION_KEY?.trim() || process.env.REASONING_CONTRACT_SIGNING_KEY?.trim() || "";
}

export function clinicalFactsAttestationConfigured(): boolean {
  return attestationKey().length >= 16;
}

export const clinicalFactsAttestationSigningConfigured = clinicalFactsAttestationConfigured;

function attestationPayload(facts: NonNullable<CaseState["clinicalFacts"]>): string {
  return JSON.stringify({
    attestationVersion: facts.attestationVersion || "",
    extractorVersion: facts.extractorVersion || "",
    promptVersion: facts.promptVersion || "",
    extractedAt: facts.extractedAt || "",
    modelTrace: facts.modelTrace,
    customerBindingHash: facts.customerBindingHash || "",
    sourceFingerprint: facts.sourceFingerprint || "",
    sourceCoverage: facts.sourceCoverage || "",
    sourceCharCount: facts.sourceCharCount || 0,
    semanticStatus: facts.semanticStatus || "",
    reviewStatus: facts.reviewStatus || "",
    encounterScope: facts.encounterScope,
    redFlags: facts.redFlags,
  });
}

function clinicalFactsCustomerBindingHash(customerId?: string): string | undefined {
  if (!customerId) return undefined;
  const normalizedCustomerId = parseCustomerId(customerId);
  const configuredClientId = process.env.CDSS_API_CLIENT_ID?.trim() || "local-development";
  if (normalizedCustomerId !== customerId || !/^[A-Za-z0-9_-]{3,64}$/.test(configuredClientId)) {
    return undefined;
  }
  return createHash("sha256")
    // clientId is non-secret deployment identity. Customer authorization itself remains owned by
    // requireCustomerContext; this low-level attestation module deliberately avoids importing the
    // server-only registry so it remains usable in pure schema/safety tests.
    .update(`${configuredClientId}\0${normalizedCustomerId}`)
    .digest("hex");
}

export function clinicalFactsTenantBindingMatches(
  facts: CaseState["clinicalFacts"],
  customerId?: string,
): boolean {
  const expected = clinicalFactsCustomerBindingHash(customerId);
  return expected === undefined
    ? facts?.customerBindingHash === undefined
    : facts?.customerBindingHash === expected;
}

function signClinicalFacts(facts: NonNullable<CaseState["clinicalFacts"]>): string | undefined {
  const key = attestationKey();
  if (key.length < 16) return undefined;
  return `hmac-sha256:${createHmac("sha256", key).update(attestationPayload(facts)).digest("hex")}`;
}

export function hasValidClinicalFactsAttestation(
  facts: CaseState["clinicalFacts"],
  nowMs = Date.now(),
  cacheTtlOverrideMs?: number,
  customerId?: string,
): boolean {
  const key = attestationKey();
  if (!facts?.attestation || key.length < 16) return false;
  if (facts.semanticStatus !== "checked") return false;
  if (facts.reviewStatus !== "checked") return false;
  if (facts.sourceCoverage !== "full") return false;
  if (facts.attestationVersion !== CLINICAL_FACTS_ATTESTATION_VERSION) return false;
  if (facts.extractorVersion !== CLINICAL_FACTS_EXTRACTOR_VERSION) return false;
  if (facts.promptVersion !== CLINICAL_FACTS_PROMPT_VERSION) return false;
  if (!clinicalFactsTenantBindingMatches(facts, customerId)) return false;
  const extractedAtMs = facts.extractedAt ? Date.parse(facts.extractedAt) : Number.NaN;
  if (!Number.isFinite(extractedAtMs)) return false;
  const ageMs = nowMs - extractedAtMs;
  if (ageMs < -CLINICAL_FACTS_FUTURE_SKEW_MS) return false;
  const defaultTtlMs = facts.redFlags.length === 0
    ? CLINICAL_FACTS_EMPTY_CACHE_TTL_MS
    : CLINICAL_FACTS_CACHE_TTL_MS;
  const ttlMs = Number.isFinite(cacheTtlOverrideMs) && Number(cacheTtlOverrideMs) > defaultTtlMs
    ? Math.min(Number(cacheTtlOverrideMs), CLINICAL_FACTS_SIGNED_CHAIN_CACHE_TTL_MS)
    : defaultTtlMs;
  if (ageMs > ttlMs) return false;
  const expected = signClinicalFacts({ ...facts, attestation: undefined });
  if (!expected || expected.length !== facts.attestation.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(facts.attestation));
}

export function isClinicalFactsBackstopEnabled(): boolean {
  return process.env.CDSS_CLINICAL_FACTS_BACKSTOP !== "false";
}

/**
 * An attested "unclear" encounter scope means the reviewed semantic pre-check could not prove
 * whether this visit has an active treatment target. Dose-level output must not proceed silently
 * in that state; only an explicit doctor confirmation bound to the current record fingerprint
 * (CaseState.encounterScopeConfirmation) releases it. Any record edit changes the fingerprint and
 * forces re-extraction, which naturally invalidates a stale confirmation.
 *
 * This helper lives here (not in diagnosis-safety.ts) because diagnosis-safety.ts is imported by
 * this module — importing back would create a cycle. Routes call it after the backstop re-attach.
 */
export function hasUnconfirmedUnclearEncounterScope(state: CaseState): boolean {
  const facts = state.clinicalFacts;
  if (!hasValidClinicalFactsAttestation(facts, Date.now(), undefined, state.customerId)) return false;
  if (facts?.encounterScope?.status !== "unclear") return false;
  const sourceFingerprint = facts.sourceFingerprint;
  if (!sourceFingerprint) return false;
  return state.encounterScopeConfirmation?.sourceFingerprint !== sourceFingerprint;
}

/**
 * 事实回补的服务端缓存 + 并发合流（P1）。
 *
 * 立项原因（2026-08-29 token 审计）：`maybeAttachClinicalFactsBackstop` 挂在 7 个路由上
 * （question / diagnose / prescribe / assess / red-flags / post-prescription-risk / his-scheme），
 * 而复用**只**靠客户端回传的 HMAC 快照，服务端没有任何存储。本文件顶部注释自己记录了后果：
 * 生产 diagnose+prescribe p50 57.4s、488/488 例 >30s，于是 M05 assess 必然过期重抽。
 * 一条完整病例链在 TTL 全失效时最坏 12 次 ~10k token 的调用，且此前完全不记账。
 *
 * 两条不变量：
 *  - **有效性判据只有一个**：命中与否仍由 `hasValidClinicalFactsAttestation` 判定（版本/租户/
 *    覆盖度/复核状态/HMAC/TTL），本缓存不另写一套过期规则——否则就是本仓头号缺陷形状
 *    「同一判据两处各写各的」。TTL 覆盖（prescribe 的 600s）照样透传给同一个函数。
 *  - **只缓存成功结果**。unavailable/failure 一律不入缓存，否则一次瞬时故障会被钉死成
 *    整个 TTL 窗口内的「事实不可用」，而事实层不可用会放大成安全提示缺失。
 */
type ClinicalFactsCacheEntry = {
  facts: NonNullable<CaseState["clinicalFacts"]>;
  storedAt: number;
};

const CLINICAL_FACTS_CACHE_MAX_ENTRIES = 64;
const clinicalFactsServerCache = new Map<string, ClinicalFactsCacheEntry>();
const clinicalFactsInFlight = new Map<string, Promise<CaseState["clinicalFacts"]>>();

function clinicalFactsCacheKey(sourceFingerprint: string, customerId: string | undefined): string {
  // 租户绑定进键：不同租户的同一段文本不得互相命中（与 attestation 的绑定校验双保险）。
  return `${clinicalFactsCustomerBindingHash(customerId) || "none"}:${sourceFingerprint}`;
}

function readClinicalFactsCache(
  key: string,
  customerId: string | undefined,
  ttlOverrideMs: number | undefined,
): NonNullable<CaseState["clinicalFacts"]> | undefined {
  const entry = clinicalFactsServerCache.get(key);
  if (!entry) return undefined;
  if (!hasValidClinicalFactsAttestation(entry.facts, Date.now(), ttlOverrideMs, customerId)) {
    clinicalFactsServerCache.delete(key);
    return undefined;
  }
  // LRU：命中即刷新插入顺序，让淘汰淘汰掉真正冷的条目。
  clinicalFactsServerCache.delete(key);
  clinicalFactsServerCache.set(key, entry);
  return entry.facts;
}

function writeClinicalFactsCache(key: string, facts: CaseState["clinicalFacts"]): void {
  // 只存已签名、复核通过、覆盖完整的结果——与 attestation 的签发条件一致。
  if (!facts?.attestation || facts.semanticStatus !== "checked") return;
  clinicalFactsServerCache.set(key, { facts, storedAt: Date.now() });
  while (clinicalFactsServerCache.size > CLINICAL_FACTS_CACHE_MAX_ENTRIES) {
    const oldest = clinicalFactsServerCache.keys().next();
    if (oldest.done) break;
    clinicalFactsServerCache.delete(oldest.value);
  }
}

/** 测试与运维用：清空进程内事实缓存。 */
export function resetClinicalFactsServerCache(): void {
  clinicalFactsServerCache.clear();
  clinicalFactsInFlight.clear();
}

export function clinicalFactsServerCacheSize(): number {
  return clinicalFactsServerCache.size;
}

export async function maybeAttachClinicalFactsBackstop(
  state: CaseState,
  llmCall: FactsLlmCall = REAL_FACTS_LLM_CALL,
  signal?: AbortSignal,
  options?: { cacheTtlOverrideMs?: number },
): Promise<CaseState> {
  const withoutStaleFacts = { ...state, clinicalFacts: undefined };
  if (!isClinicalFactsBackstopEnabled()) {
    return {
      ...withoutStaleFacts,
      clinicalFacts: {
        redFlags: [],
        semanticStatus: "unavailable",
        resultSource: "failure",
        unavailableReason: "disabled",
      },
    };
  }
  // This optional backstop is still an external model call. It receives the same minimized,
  // PHI-scrubbed projection as the main diagnosis model, never the raw HIS record.
  const fullText = trustedInputText(sanitizeCaseStateForModel(state));
  if (!fullText.trim()) return withoutStaleFacts;
  const sourceProjection = projectClinicalFactsSource(fullText);
  const text = sourceProjection.text;
  const sourceFingerprint = createHash("sha256").update(fullText).digest("hex").slice(0, 32);
  if (state.clinicalFacts?.sourceFingerprint === sourceFingerprint && hasValidClinicalFactsAttestation(
    state.clinicalFacts,
    Date.now(),
    options?.cacheTtlOverrideMs,
    state.customerId,
  )) {
    return {
      ...state,
      clinicalFacts: { ...state.clinicalFacts, resultSource: "cache" },
    };
  }

  // 客户端快照没带上或已过期时，再查服务端缓存。这一层专治「同一病例链上 7 个路由各自重抽」：
  // 客户端只在 M03/M04 之间回传事实，assess / post-prescription-risk / his-scheme 走的是
  // 另一次请求，此前必然落空。
  const cacheKey = clinicalFactsCacheKey(sourceFingerprint, state.customerId);
  // 缓存键是（租户，病历文本）；「事实是该文本的纯函数」这个前提只在**配置的模型编排**下成立。
  // 调用方注入了自定义抽取函数时前提不再成立（同一文本可以产出不同事实），因此既不读也不写
  // 共享缓存。生产的 7 个路由全部走默认编排，不受影响。
  const usesConfiguredModelPlan = llmCall === REAL_FACTS_LLM_CALL;
  const cachedFacts = usesConfiguredModelPlan
    ? readClinicalFactsCache(cacheKey, state.customerId, options?.cacheTtlOverrideMs)
    : undefined;
  if (cachedFacts) {
    return { ...state, clinicalFacts: { ...cachedFacts, resultSource: "cache" } };
  }
  // 并发合流：同一份病历被两个路由同时请求时（前端会并发触发），只发一次模型调用。
  const inFlight = usesConfiguredModelPlan ? clinicalFactsInFlight.get(cacheKey) : undefined;
  if (inFlight) {
    const shared = await inFlight;
    if (shared) return { ...state, clinicalFacts: { ...shared, resultSource: "cache" } };
  }

  // 计算段包进 singleflight：登记在飞 promise，让并发的同键请求合流到同一次模型调用，
  // 而不是各发一遍三相位。成功结果写入服务端缓存（失败结果一律不写，见上）。
  const compute = async (): Promise<CaseState> => {
    let unavailableReason: ClinicalFactsUnavailableReason = signal?.aborted ? "aborted" : "invalid_output";
    let totalTimedOut = false;
    const deadlineController = new AbortController();
    const deadline = setTimeout(() => {
      totalTimedOut = true;
      deadlineController.abort(new Error("clinical_facts_total_timeout"));
    }, clinicalFactsTotalTimeoutMs());
    const effectiveSignal = signal ? AbortSignal.any([signal, deadlineController.signal]) : deadlineController.signal;
    const observedLlmCall: FactsLlmCall = async (system, user, callSignal, phase) => {
      try {
        return await llmCall(system, user, callSignal, phase);
      } catch (error) {
        unavailableReason = totalTimedOut ? "timeout" : classifyUnavailableReason(error, callSignal);
        throw error;
      }
    };
    let facts;
    try {
      const modelPlan = getClinicalFactsModelPlan();
      facts = await extractClinicalFacts(text, observedLlmCall, effectiveSignal, {
        independentReview: process.env.CDSS_CLINICAL_FACTS_REVIEW !== "false",
        allowDispositionReductions: modelPlan.reductionsAllowed,
      });
    } finally {
      clearTimeout(deadline);
    }
    if (signal?.aborted) {
      unavailableReason = "aborted";
      facts = null;
    }
    if (!facts) {
      return {
        ...withoutStaleFacts,
        clinicalFacts: {
          redFlags: [],
          sourceFingerprint,
          semanticStatus: "unavailable",
          resultSource: "failure",
          unavailableReason,
        },
      };
    }
    const unsignedFacts = {
      ...facts,
      modelTrace: (() => {
        const plan = getClinicalFactsModelPlan();
        return {
          extractor: { provider: plan.extractor.provider, model: plan.extractor.model },
          reviewer: { provider: plan.reviewer.provider, model: plan.reviewer.model },
          adjudicator: { provider: plan.adjudicator.provider, model: plan.adjudicator.model },
          independentReview: plan.independentReview,
          independentAdjudication: plan.independentAdjudication,
          separateInvocationReview: plan.separateInvocationReview,
          separateInvocationAdjudication: plan.separateInvocationAdjudication,
        };
      })(),
      customerBindingHash: clinicalFactsCustomerBindingHash(state.customerId),
      sourceFingerprint,
      sourceCoverage: sourceProjection.coverage,
      sourceCharCount: fullText.length,
      semanticStatus: "checked" as const,
      resultSource: "fresh" as const,
      unavailableReason: undefined,
      attestationVersion: CLINICAL_FACTS_ATTESTATION_VERSION,
      extractorVersion: CLINICAL_FACTS_EXTRACTOR_VERSION,
      promptVersion: CLINICAL_FACTS_PROMPT_VERSION,
      extractedAt: new Date(Date.now()).toISOString(),
      attestation: undefined,
    };
    const tenantBindingAvailable = !state.customerId || Boolean(unsignedFacts.customerBindingHash);
    const attestation = unsignedFacts.reviewStatus === "checked" && unsignedFacts.sourceCoverage === "full" &&
      tenantBindingAvailable
      ? signClinicalFacts(unsignedFacts)
      : undefined;
    if (unsignedFacts.reviewStatus === "checked" && unsignedFacts.sourceCoverage === "full" && !attestation) {
      return {
        ...withoutStaleFacts,
        clinicalFacts: {
          redFlags: [],
          sourceFingerprint,
          sourceCoverage: sourceProjection.coverage,
          sourceCharCount: fullText.length,
          semanticStatus: "unavailable",
          resultSource: "failure",
          unavailableReason: "signing_unavailable",
        },
      };
    }
    return { ...state, clinicalFacts: { ...unsignedFacts, attestation } };
  };

  const pending = compute();
  if (!usesConfiguredModelPlan) return pending;
  clinicalFactsInFlight.set(
    cacheKey,
    pending.then((next) => next.clinicalFacts).catch(() => undefined),
  );
  try {
    const result = await pending;
    writeClinicalFactsCache(cacheKey, result.clinicalFacts);
    return result;
  } finally {
    clinicalFactsInFlight.delete(cacheKey);
  }
}

function classifyUnavailableReason(error: unknown, signal?: AbortSignal): ClinicalFactsUnavailableReason {
  // 超时判定先于 abort 判定：相位截止用 AbortSignal.timeout 实现，其 reason 是 TimeoutError、
  // SDK 侧抛的是 abort 形态的错误——按 abort 先判会把「模型太慢」误标成「请求被中止」，
  // 运维排障会被引向客户端断连而不是相位预算（实测 case9 两次 8s 相位超时被标 aborted）。
  const signalReasonName = signal?.aborted && signal.reason instanceof Error ? signal.reason.name : "";
  const signalReasonMessage = signal?.aborted && signal.reason instanceof Error ? signal.reason.message : "";
  if (signalReasonName === "TimeoutError" || /timed?\s*out|timeout/i.test(signalReasonMessage)) return "timeout";
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error || "");
  if (name === "TimeoutError" || /timed?\s*out|timeout/i.test(message)) return "timeout";
  if (signal?.aborted) return "aborted";
  if (name === "AbortError" || name === "APIUserAbortError") return "aborted";
  return "model_error";
}
