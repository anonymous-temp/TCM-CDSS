import type { CaseState } from "./diagnosis-types";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { getPrimaryTextModelConfig, createTextModelClient, isDeepseekModel } from "./text-model";
import {
  CLINICAL_FACTS_EXTRACTOR_VERSION,
  CLINICAL_FACTS_PROMPT_VERSION,
  extractClinicalFacts,
  type ClinicalFactsModelIdentity,
  type ClinicalFactsUnavailableReason,
  type FactsLlmCall,
} from "./clinical-facts";
import { sanitizeCaseStateForModel, trustedInputText } from "./diagnosis-safety";

export { CLINICAL_FACTS_EXTRACTOR_VERSION, CLINICAL_FACTS_PROMPT_VERSION } from "./clinical-facts";

/**
 * LLM 临床语义红旗层的运行时接线。
 *
 * 默认启用；仅当 `CDSS_CLINICAL_FACTS_BACKSTOP === "false"` 时关闭。确定性层负责危急生命体征与明确高置信
 * 事实，LLM 层负责口语、组合语义、否定和时序。模型结论必须通过 schema 与原文引用校验后才可进入安全门。
 * 抽取失败(模型不可用/超时/输出非法)清除陈旧 finding，并显式标记 semantic unavailable，供安全门在
 * 允许 M03 继续分析的同时阻断静默处方升级。
 */

export const CLINICAL_FACTS_ATTESTATION_VERSION = "tcm-cdss-clinical-facts-attestation-v7";
export const CLINICAL_FACTS_CACHE_TTL_MS = 5 * 60_000;
export const CLINICAL_FACTS_EMPTY_CACHE_TTL_MS = 30_000;
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
  const configured = Number(process.env.CLINICAL_FACTS_TOTAL_TIMEOUT_MS || 10_000);
  return Number.isFinite(configured) && configured >= 3_000 && configured <= 15_000
    ? Math.round(configured)
    : 10_000;
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
    configured: Boolean(primary.configured && primary.apiKey && isDeepseekModel(model) && endpointAllowed(endpoint)),
    source: "primary",
  };
}

function independentFactsReviewModel(): ClinicalFactsPhaseModel {
  const primary = getPrimaryTextModelConfig();
  // All textual clinical reasoning is pinned to DeepSeek. GLM credentials are reserved exclusively
  // for the image-only tongue route and can never become a silent safety-review fallback.
  const provider = (process.env.PRIMARY_CLINICAL_REVIEW_PROVIDER || "primary")
    .trim().toLowerCase();
  if (provider !== "primary") {
    return {
      provider: "unconfigured",
      model: "unconfigured",
      apiKey: "",
      endpoint: "",
      configured: false,
      source: "independent_review",
    };
  }
  const model = process.env.CLINICAL_FACTS_REVIEW_MODEL?.trim() ||
    process.env.PRIMARY_CLINICAL_REVIEW_MODEL?.trim() ||
    process.env.PRIMARY_DIAGNOSE_MODEL?.trim() || primary.model;
  return primaryFactsPhaseModel(model);
}

function sameModelIdentity(a: ClinicalFactsModelIdentity, b: ClinicalFactsModelIdentity): boolean {
  return a.provider === b.provider && a.model === b.model;
}

export function getClinicalFactsModelPlan() {
  const primary = getPrimaryTextModelConfig();
  // Triage is a compact JSON classification task. Defaulting to the fast primary model removes the
  // former 20-30 second pre-report blank period; M03 can still use its deeper diagnose model.
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
  const [extractor, reviewer, adjudicator] = await Promise.all([
    probeClinicalFactsPhaseModel(plan.extractor),
    probeClinicalFactsPhaseModel(plan.reviewer),
    probeClinicalFactsPhaseModel(plan.adjudicator),
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
): Promise<string> {
  if (!config.configured) throw new Error("model_not_configured");
  if (config.source === "independent_review") {
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
        ...(isDeepseekModel(config.model) ? {
          reasoning_effort: "low",
          thinking: { type: "disabled" },
        } : {}),
      }),
      signal,
    });
    if (!response.ok) throw new Error(`review_model_http_${response.status}`);
    const body = await response.json() as { choices?: Array<{ message?: { content?: string | null } }> };
    return body.choices?.[0]?.message?.content || "";
  }
  const primary = getPrimaryTextModelConfig();
  const client = createTextModelClient({ ...primary, model: config.model });
  const res = await client.chat.completions.create(
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
      ...(isDeepseekModel(config.model) ? {
        reasoning_effort: "low" as const,
        thinking: { type: "disabled" as const },
      } : {}),
    },
    { timeout: 10_000, signal },
  );
  return res.choices?.[0]?.message?.content || "";
}

const REAL_FACTS_LLM_CALL: FactsLlmCall = async (system, user, signal, phase = "extract") => {
  const plan = getClinicalFactsModelPlan();
  const config = phase === "review" ? plan.reviewer
    : phase === "adjudicate" ? plan.adjudicator
      : plan.extractor;
  return callFactsPhaseModel(config, system, user, signal);
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
    sourceFingerprint: facts.sourceFingerprint || "",
    sourceCoverage: facts.sourceCoverage || "",
    sourceCharCount: facts.sourceCharCount || 0,
    semanticStatus: facts.semanticStatus || "",
    reviewStatus: facts.reviewStatus || "",
    encounterScope: facts.encounterScope,
    redFlags: facts.redFlags,
  });
}

function signClinicalFacts(facts: NonNullable<CaseState["clinicalFacts"]>): string | undefined {
  const key = attestationKey();
  if (key.length < 16) return undefined;
  return `hmac-sha256:${createHmac("sha256", key).update(attestationPayload(facts)).digest("hex")}`;
}

export function hasValidClinicalFactsAttestation(
  facts: CaseState["clinicalFacts"],
  nowMs = Date.now(),
): boolean {
  const key = attestationKey();
  if (!facts?.attestation || key.length < 16) return false;
  if (facts.semanticStatus !== "checked") return false;
  if (facts.reviewStatus !== "checked") return false;
  if (facts.sourceCoverage !== "full") return false;
  if (facts.attestationVersion !== CLINICAL_FACTS_ATTESTATION_VERSION) return false;
  if (facts.extractorVersion !== CLINICAL_FACTS_EXTRACTOR_VERSION) return false;
  if (facts.promptVersion !== CLINICAL_FACTS_PROMPT_VERSION) return false;
  const extractedAtMs = facts.extractedAt ? Date.parse(facts.extractedAt) : Number.NaN;
  if (!Number.isFinite(extractedAtMs)) return false;
  const ageMs = nowMs - extractedAtMs;
  if (ageMs < -CLINICAL_FACTS_FUTURE_SKEW_MS) return false;
  const ttlMs = facts.redFlags.length === 0
    ? CLINICAL_FACTS_EMPTY_CACHE_TTL_MS
    : CLINICAL_FACTS_CACHE_TTL_MS;
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
  if (!hasValidClinicalFactsAttestation(facts)) return false;
  if (facts?.encounterScope?.status !== "unclear") return false;
  const sourceFingerprint = facts.sourceFingerprint;
  if (!sourceFingerprint) return false;
  return state.encounterScopeConfirmation?.sourceFingerprint !== sourceFingerprint;
}

export async function maybeAttachClinicalFactsBackstop(
  state: CaseState,
  llmCall: FactsLlmCall = REAL_FACTS_LLM_CALL,
  signal?: AbortSignal,
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
  if (state.clinicalFacts?.sourceFingerprint === sourceFingerprint && hasValidClinicalFactsAttestation(state.clinicalFacts)) {
    return {
      ...state,
      clinicalFacts: { ...state.clinicalFacts, resultSource: "cache" },
    };
  }

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
      };
    })(),
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
  const attestation = unsignedFacts.reviewStatus === "checked" && unsignedFacts.sourceCoverage === "full"
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
}

function classifyUnavailableReason(error: unknown, signal?: AbortSignal): ClinicalFactsUnavailableReason {
  if (signal?.aborted) return "aborted";
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error || "");
  if (name === "AbortError") return "aborted";
  if (name === "TimeoutError" || /timed?\s*out|timeout/i.test(message)) return "timeout";
  return "model_error";
}
