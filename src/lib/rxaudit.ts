// LingXi (灵犀) unified rational-drug-use audit client.
//
// Wraps `POST /api/v1/rational-drug-use` (operation=PRESCRIPTION_AUDIT) — the vendor 合理用药 审方
// engine — as the sole prescription-safety reviewer for the post-prescription audit path. Callers must
// expose any failure/timeout/missing herb items as a visible manual-review advisory. Audit is not a
// workflow lock, but callers must never interpret an unavailable audit as "no risk". Legacy Markdown
// parsing is retained only for local input-quality explanation. No external audit request is allowed
// unless a structured M04 candidate supplies every dose plus a complete frequency/course regimen.
//
// PHI: only sanitized free text is sent; patient name is never forwarded (a fixed 匿名患者 is used).

import { createHash } from "node:crypto";
import { currentVitalsSummary, sanitizeFreeTextForExternalClinicalService } from "./diagnosis-safety";
import { diagnoseReasoningFromState, parseReasoningV2, prescribeReasoningFromState } from "./diagnosis-parse";
import { ageValue, type CaseState } from "./diagnosis-types";
import { normalizeLingxiDecision, normalizeRiskLevel, type RxAuditResultCode, type RxAuditRiskLevel } from "./rxaudit-normalize";
import { prescriptionRegimenFromDecoction, prescriptionRegimenSummary } from "./prescription-regimen-contract";
import { affirmedAllergyText, affirmedClinicalText, affirmedCurrentMedicationText, canonicalMedicationIdentity, clinicalClausePolarity, medicationContinuationOnly, medicationNameFromEventText } from "./clinical-polarity";
import { UpstreamResponseTooLargeError, readResponseTextLimited } from "./http-response-limit";
import { cancelResponseBody } from "./http-response-lifecycle";
import {
  currentMedicationSummaryFromSemanticExtraction,
  currentMedicationsFromSemanticExtraction,
  extractMedicationEventsWithModel,
  medicationSemanticConsistencyReasons,
  type MedicationSemanticExtraction,
} from "./medication-event-extractor";
import { findTcmHerbPairCautions, findTcmHerbPairIncompatibilities, getTcmHerbDoseLimit } from "./tcm-knowledge";
import { matchesPopulationScope } from "./clinical-vocabulary";
import { findLocalPatentMedicineEntry } from "./local-patent-medicine-candidates";
import { prescriptionVersionPayload } from "./prescription-version";

export type { RxAuditResultCode, RxAuditRiskLevel } from "./rxaudit-normalize";

export type RxAuditIssue = {
  issueId?: string;
  issueIdGenerated?: boolean;
  riskLevel: RxAuditRiskLevel | string;
  ruleLevel?: string;
  issueType?: string;
  title: string;
  description: string;
  action?: string;
  relatedItemNos: number[];
  evidence: Array<{ sourceType?: string; sourceName?: string; quote?: string; ruleName?: string; sourceUrl?: string | null; year?: string | null }>;
  suggestions: string[];
  patientApplicability?: "applicable" | "not_applicable" | "unknown";
  /**
   * 本条告警落在**我方有意不提交单次剂量**的中成药/西药上（2026-08-11 线上实测）。
   *
   * 打标不删条目：provider 的每一条 issue 与 issueId 原样保留在数组里，
   * audit_result 与 highest_risk_level 一字不动（本地只能上调不能下调）。
   * 只是呈现层把它从「合理用药审方」风险表里挪到范围说明，不再与真实配伍/禁忌风险同格。
   */
  scope?: "declared_non_dose";
};

export type RxAuditOutcome =
  | {
      ok: true;
      source: "lingxi";
      degraded: boolean;
      degradeReason?: string;
      auditResult: RxAuditResultCode;
      highestRiskLevel: RxAuditRiskLevel;
      needManualReview: boolean;
      issues: RxAuditIssue[];
      auditId?: string;
      traceId?: string;
      itemCount: number;
    }
  | { ok: false; source: "unavailable"; reason: string; itemCount: number };

export type RxAuditCorrelationMetadata = {
  provider: "lingxi-rxaudit";
  providerAvailable: boolean;
  providerDegraded?: boolean;
  providerDegradeReason?: string;
  providerReason?: string;
  auditId?: string;
  traceId?: string;
  candidateIndex?: number;
  prescriptionHash?: string;
  auditedAt: string;
  providerAuditResult?: RxAuditResultCode;
  providerHighestRiskLevel?: RxAuditRiskLevel;
  effectiveAuditResult: RxAuditResultCode;
  effectiveHighestRiskLevel: RxAuditRiskLevel;
  needManualReview: boolean;
};

const DEFAULT_BASE_URL = "";
const DEFAULT_TENANT = "EH_INTERNET_HOSPITAL";
const AUDIT_PATH = "/api/v1/rational-drug-use";
// LingXi usually returns in under a second, but a cold database/rule path can occasionally take
// 12–15 seconds. A shorter attempt budget aborts that valid response, starts overlapping work and
// then exhausts the total deadline. One 30-second attempt stays below the 45-second M05 interaction
// target; retries remain available for fast 5xx/network failures within the same shared deadline.
const DEFAULT_AUDIT_TOTAL_TIMEOUT_MS = 30_000;
const DEFAULT_AUDIT_ATTEMPT_TIMEOUT_MS = 30_000;
const MIN_AUDIT_TIMEOUT_MS = 1000;
const MAX_AUDIT_TIMEOUT_MS = 30_000;
const MIN_RETRY_ATTEMPT_BUDGET_MS = 1000;
const MAX_MEDICATION_EXTRACTION_CHARS = 4000;

function boundedAuditTimeout(value: unknown, fallback: number): number {
  if (value == null || (typeof value === "string" && value.trim() === "")) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed)
    && Number.isInteger(parsed)
    && parsed >= MIN_AUDIT_TIMEOUT_MS
    && parsed <= MAX_AUDIT_TIMEOUT_MS
    ? parsed
    : fallback;
}

/** Complete semantic-extraction + provider-audit deadline. The legacy variable remains supported. */
export function getRxAuditTimeoutMs(
  value: unknown = process.env.RXAI_AUDIT_TOTAL_TIMEOUT_MS ?? process.env.RXAI_AUDIT_TIMEOUT_MS,
): number {
  return boundedAuditTimeout(value, DEFAULT_AUDIT_TOTAL_TIMEOUT_MS);
}

/** Per-provider-attempt deadline; retries must also fit inside the complete deadline above. */
export function getRxAuditAttemptTimeoutMs(
  value: unknown = process.env.RXAI_AUDIT_ATTEMPT_TIMEOUT_MS,
): number {
  return boundedAuditTimeout(value, DEFAULT_AUDIT_ATTEMPT_TIMEOUT_MS);
}
// Audit is advisory. One retry absorbs a transient sidecar/network error without making M05 appear
// stuck for 30-40 seconds when the vendor is unavailable. Deployments may tune this explicitly.
const MAX_RETRIES = (() => {
  const n = Number(process.env.RXAI_AUDIT_RETRY_ATTEMPTS);
  return Number.isFinite(n) && n >= 0 && n <= 5 ? n : 1;
})();
const RXAUDIT_MAX_RESPONSE_BYTES = 2_000_000;

let requestSeq = 0;

// Plain HTTP is restricted to the same machine by default. Remote audit traffic must use HTTPS
// because the request contains a bearer credential and a clinically meaningful case summary.
const LOCAL_INSECURE_HTTP_HOSTS = ["localhost", "127.0.0.1", "::1", "[::1]", "host.docker.internal"];

// Remote plain-HTTP is never allowed unless the operator explicitly allowlists that exact host via
// RXAI_AUDIT_ALLOW_INSECURE_HTTP_HOSTS (comma-separated; entries may be "host" or "host:port").
// Deployments that set this accept the interception risk of sending the token and the sanitized
// clinical summary over plaintext HTTP; prefer HTTPS whenever the vendor offers it.
function explicitInsecureHttpHosts(): string[] {
  return (process.env.RXAI_AUDIT_ALLOW_INSECURE_HTTP_HOSTS || "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function insecureHttpHostAllowed(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:") return false;
    const hostname = url.hostname.toLowerCase();
    if (LOCAL_INSECURE_HTTP_HOSTS.includes(hostname)) return true;
    const hostWithPort = url.host.toLowerCase();
    return explicitInsecureHttpHosts().some((entry) => entry === hostname || entry === hostWithPort);
  } catch {
    return false;
  }
}

export function getRxAuditConfig() {
  const baseUrl = (process.env.RXAI_AUDIT_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/$/, "");
  // Current LingXi contract authenticates with X-API-Key. Keep RXAI_AUDIT_TOKEN as a
  // backward-compatible configuration alias so existing deployments do not lose their key.
  const token = (process.env.RXAI_AUDIT_API_KEY || process.env.RXAI_AUDIT_TOKEN || "").trim();
  const tenantId = (process.env.RXAI_AUDIT_TENANT_ID || DEFAULT_TENANT).trim();
  const systemCode = (process.env.RXAI_AUDIT_SYSTEM_CODE || tenantId).trim();
  const configured = Boolean(token && baseUrl);
  const allowInsecureHttp = process.env.RXAI_AUDIT_ALLOW_INSECURE_HTTP === "true";
  // Plain-HTTP exceptions: same-host sidecar, or an operator-allowlisted remote host (see
  // insecureHttpHostAllowed). Everything else is refused before any request is sent.
  const transportAllowed = !baseUrl || baseUrl.startsWith("https://") || (allowInsecureHttp && insecureHttpHostAllowed(baseUrl));
  const enabled = process.env.RXAI_AUDIT_ENABLED === "true" && configured && transportAllowed;
  const disabledReason = !configured
    ? "rxaudit_not_configured"
    : !transportAllowed
      ? "rxaudit_insecure_transport"
      : process.env.RXAI_AUDIT_ENABLED === "true"
        ? undefined
        : "rxaudit_disabled";
  return { baseUrl, token, tenantId, systemCode, enabled, configured, allowInsecureHttp, transportAllowed, disabledReason };
}

function rxAuditHeaders(cfg: ReturnType<typeof getRxAuditConfig>): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-API-Key": cfg.token,
    "X-Tenant-Id": cfg.tenantId,
  };
}

export function getRxAuditStatus() {
  const cfg = getRxAuditConfig();
  return {
    provider: "灵犀统一合理用药审方",
    providerId: "lingxi-rxaudit",
    enabled: cfg.enabled,
    configured: cfg.configured,
    transportAllowed: cfg.transportAllowed,
    disabledReason: cfg.disabledReason,
    timeoutMs: getRxAuditTimeoutMs(),
    totalTimeoutMs: getRxAuditTimeoutMs(),
    attemptTimeoutMs: getRxAuditAttemptTimeoutMs(),
    retryAttempts: MAX_RETRIES,
  };
}

export type RxAuditTransportProbe = Readonly<{
  ok: boolean;
  checkedAt: string;
  latencyMs: number;
  reason: "ok" | "not_configured" | "insecure_transport" | "unauthorized" | "upstream_4xx" | "timeout" | "network_error" | "upstream_5xx";
  upstreamStatus?: number;
}>;

/**
 * Credential-aware release probe. It deliberately sends an empty POST and no patient or
 * prescription payload. A 400/422 response proves that authentication reached request validation;
 * 401/403, missing routes and server failures must keep strict readiness false. Live positive
 * controls remain responsible for validating actual audit semantics before deployment.
 */
export async function probeRxAuditTransport(): Promise<RxAuditTransportProbe> {
  const startedAt = Date.now();
  const checkedAt = new Date().toISOString();
  const cfg = getRxAuditConfig();
  if (!cfg.configured) return { ok: false, checkedAt, latencyMs: 0, reason: "not_configured" };
  if (!cfg.transportAllowed) return { ok: false, checkedAt, latencyMs: 0, reason: "insecure_transport" };
  try {
    const response = await fetch(`${cfg.baseUrl}${AUDIT_PATH}`, {
      method: "POST",
      headers: rxAuditHeaders(cfg),
      body: "{}",
      signal: AbortSignal.timeout(Math.min(getRxAuditAttemptTimeoutMs(), 5_000)),
      cache: "no-store",
    });
    const latencyMs = Date.now() - startedAt;
    await cancelResponseBody(response);
    if (response.status === 401 || response.status === 403) {
      return { ok: false, checkedAt, latencyMs, reason: "unauthorized", upstreamStatus: response.status };
    }
    if (response.status >= 500) {
      return { ok: false, checkedAt, latencyMs, reason: "upstream_5xx", upstreamStatus: response.status };
    }
    if (response.status >= 400 && response.status !== 400 && response.status !== 422) {
      return { ok: false, checkedAt, latencyMs, reason: "upstream_4xx", upstreamStatus: response.status };
    }
    return { ok: true, checkedAt, latencyMs, reason: "ok", upstreamStatus: response.status };
  } catch (error) {
    const timeout = error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError");
    return {
      ok: false,
      checkedAt,
      latencyMs: Date.now() - startedAt,
      reason: timeout ? "timeout" : "network_error",
    };
  }
}

function genderCode(sex?: string): "MALE" | "FEMALE" | "UNKNOWN" {
  if (!sex) return "UNKNOWN";
  if (/男/.test(sex) || /^m(ale)?$/i.test(sex)) return "MALE";
  if (/女/.test(sex) || /^f(emale)?$/i.test(sex)) return "FEMALE";
  return "UNKNOWN";
}

function extractSyndromeName(diagnosis?: string): string | undefined {
  if (!diagnosis) return undefined;
  const direct = diagnosis.match(/(?:证候诊断|主证候|主要证候|中医证候|证型|辨证(?:结论)?)[：:]\s*\*{0,2}([^\n*|（(]+)/);
  const tableRow = diagnosis
    .split("\n")
    .map((line) => line.trim())
    .find((line) => /^\|/.test(line) && /(?:证候诊断|主证候|主要证候|中医证候|证型|辨证)/.test(line) && !/[-:]{2,}/.test(line));
  const tableName = tableRow
    ?.split("|")
    .map((item) => item.trim())
    .filter(Boolean)
    .find((item) => !/(?:证候诊断|主证候|主要证候|中医证候|证型|辨证|主\/兼|关联病机|治法方向|支持证据|置信度|下一步)/.test(item));
  const headingSection = diagnosis.match(/#{1,6}\s*(?:中医辨证结论|辨证结论|中医证候诊断)[^\n]*\n([\s\S]{0,240})/);
  const headingName = headingSection?.[1]?.match(/(?:^|\n)\s*(?:\*\*)?(?:证候诊断|主证候|主要证候|中医证候|证型)?(?:\*\*)?[：:]?\s*\*{0,2}([^\n*|（(]+)/)?.[1];
  const name = (direct?.[1] || tableName || headingName)?.trim();
  return name && name.length <= 40 ? name : undefined;
}

function extractWesternDiagnosisName(diagnosis?: string): string | undefined {
  if (!diagnosis) return undefined;
  const section = diagnosis.match(/#{1,6}\s*(?:西医诊断|现代医学诊断|西医诊断与鉴别|现代医学风险\/需排除方向)[^\n]*\n([\s\S]{0,360})/);
  const text = section?.[1] || diagnosis;
  const direct = text.match(/(?:西医诊断|现代医学诊断|诊断倾向|风险\/需排除方向)[：:]\s*\*{0,2}([^\n*|（(。；]+)/)?.[1];
  const bullet = text.match(/(?:^|\n)\s*[-*]\s*([^\n：:]{2,60}(?:病|症|障碍|综合征|待排|倾向)[^\n]*)/)?.[1];
  const firstSectionLine = section?.[1]
    ?.split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.、])\s*/, "").replace(/\*\*/g, "").trim())
    .find((line) => line && !/^\|?\s*[-:]{2,}/.test(line) && !/^\|/.test(line));
  const candidate = (direct || bullet || firstSectionLine)?.replace(/^[\s\d.、]+/, "").trim();
  if (!candidate) return undefined;
  return candidate.length <= 60 ? candidate : candidate.slice(0, 60);
}

function structuredWesternDiagnosisName(state: CaseState): string | undefined {
  return diagnoseReasoningFromState(state)?.westernDiagnosis?.primary?.name
    || prescribeReasoningFromState(state)?.westernDiagnosis?.primary?.name
    || state.reasoningV2?.westernDiagnosis?.primary?.name;
}

/**
 * Convert affirmed medication prose into the structured list consumed by LingXi interaction rules.
 * The original affirmed text remains in clinical_summary; this parser only separates medication
 * entries and strips obvious administration/dose suffixes, without attempting a local drug lexicon.
 */
export function structuredCurrentMedications(value?: string): Array<{ drug_name: string; dose_daily?: string }> {
  const affirmed = affirmedCurrentMedicationText(value);
  if (!affirmed) return [];
  const seen = new Set<string>();
  const entries: Array<{ drug_name: string; dose_daily?: string }> = [];
  const medicationEntries = affirmed
    .replace(/\s*(?:以及|和|及|与)\s*/g, "；")
    .split(/[，,；;、\n]+/);
  for (const raw of medicationEntries) {
    const segment = raw.normalize("NFKC").trim();
    if (!segment) continue;
    if (medicationContinuationOnly(segment)) {
      const previous = entries.at(-1);
      if (previous) previous.dose_daily = [previous.dose_daily, segment].filter(Boolean).join("，");
      continue;
    }
    const candidate = medicationNameFromEventText(segment);
    if (!candidate || candidate.length > 80 || /^(?:(?:\d+(?:\.\d+)?|[一二两三四五六七八九十半]+)次|(?:每(?:日|天|晚|次)|一日|早晚|晨起|睡前).*(?:次|服)|药物|用药|无|未|否认|没有|不详)$/.test(candidate)) continue;
    const key = candidate.toLowerCase().replace(/\s+/g, "");
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ drug_name: candidate, dose_daily: segment });
    if (entries.length >= 30) break;
  }
  return entries;
}

export type MedicationExtractionContext = {
  text?: string;
  truncated: boolean;
};

/** Build the only text allowed to leave the server for medication semantic extraction. */
export function buildMedicationExtractionContext(state: CaseState): MedicationExtractionContext {
  const medicationHistory = authoritativeClinicalField(state, "yongyaoshi", state.medicationHistory);
  if (!medicationHistory) return { truncated: false };
  const explicitNames = [state.patient.name, firstField(state, "patientName")]
    .filter((value): value is string => Boolean(value?.trim()));
  const deidentified = sanitizeFreeTextForExternalClinicalService(medicationHistory, explicitNames)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .trim();
  return {
    ...(deidentified ? { text: deidentified.slice(0, MAX_MEDICATION_EXTRACTION_CHARS) } : {}),
    truncated: deidentified.length > MAX_MEDICATION_EXTRACTION_CHARS,
  };
}

// 剂型后缀表与受控别名表原本在此另抄一份，且缺「混悬滴剂」「胶囊剂」——
// 见 clinical-polarity 中 MEDICATION_DOSAGE_FORM_SUFFIXES 的注释：那处分叉让
// 「现服布洛芬混悬滴剂，布洛芬已停用」这种真实矛盾静默通过了状态冲突判据。
// 此处只保留本模块特有的前置归一（NFKC + 空身份回落原文），身份规则一律走共享谓词。
function normalizedMedicationIdentity(value: string): string {
  const raw = medicationNameFromEventText(value) || value;
  return canonicalMedicationIdentity(raw.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ""));
}

/** Conservative source-side candidates used only to detect an incomplete model extraction. */
export function medicationCandidatesFromSource(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  const normalized = value
    .normalize("NFKC")
    .replace(/\[[^\]]*脱敏[^\]]*\]/g, " ")
    .replace(/\s*(?:以及|和|及|与)\s*/g, "；");
  const candidates = new Map<string, string>();
  for (const raw of normalized.split(/[，,；;、。\n]+/)) {
    const segment = raw
      .replace(/^\s*(?:但|但是|而|其后|随后|后来)\s*/, "")
      .replace(/^\s*(?:已)?(?:改为|换成|更换为)\s*/, "改用")
      .trim();
    if (!segment || medicationContinuationOnly(segment)) continue;
    const negatedStop = /(?:未|没有|否认|不曾|并未|尚未)[^，,；;。\n]{0,12}(?:停用|停服|停药|停止)/.test(segment);
    // Candidate coverage is a fail-closed drug-name check, not a keyword scan. Reuse the shared
    // polarity boundary so “否认当前其他用药/没有长期药物” does not become a fictitious missing
    // drug. A negated stop remains eligible because “未停用阿司匹林” affirms current use.
    if (clinicalClausePolarity(segment) !== "affirmed" && !negatedStop) continue;
    if (/^(?:家属|父亲|母亲|配偶|子女|陪同者|监护人)[^，,；;。\n]*(?:服用|使用|在吃)/.test(segment)) continue;
    const candidate = medicationNameFromEventText(segment)
      .replace(/^(?:已)?(?:改为|换成|更换为)\s*/, "")
      .trim();
    const identity = normalizedMedicationIdentity(candidate);
    if (!identity || identity.length > 120) continue;
    if (/^(?:药物|用药|现用药|当前用药|这个药|那个药|该药|此药|其后|不详|无|姓名|患者|mrn|手机号(?:码)?|电话|就诊号|门诊号|住院号|病案号|病历号|病例号|医疗记录号|患者编号)$/.test(identity)) continue;
    candidates.set(identity, candidate);
  }
  return [...candidates.values()];
}

export function verifyMedicationSemanticCoverage(
  sourceText: string | undefined,
  extraction: MedicationSemanticExtraction,
  sourceTruncated = false,
): MedicationSemanticExtraction {
  if (extraction.source === "unavailable") {
    if (!sourceTruncated) return extraction;
    const reasons = [...new Set([
      ...(extraction.reason || "").split(",").map((item) => item.trim()).filter(Boolean),
      "medication_context_truncated",
    ])];
    return { ...extraction, needsManualReview: true, reason: reasons.join(",") };
  }
  const candidates = medicationCandidatesFromSource(sourceText);
  const eventIdentities = extraction.events.map((event) => normalizedMedicationIdentity(event.drugName)).filter(Boolean);
  const missingCandidates = candidates.filter((candidate) => !eventIdentities.includes(normalizedMedicationIdentity(candidate)));
  const statusesByDrug = new Map<string, Set<string>>();
  for (const event of extraction.events) {
    const identity = normalizedMedicationIdentity(event.drugName);
    if (!identity) continue;
    const statuses = statusesByDrug.get(identity) || new Set<string>();
    statuses.add(event.status);
    statusesByDrug.set(identity, statuses);
  }
  const conflictingStatuses = [...statusesByDrug.values()].some((statuses) => statuses.size > 1);
  const consistencyReasons = medicationSemanticConsistencyReasons(sourceText, extraction.events);
  const addedReasons = [
    sourceTruncated ? "medication_context_truncated" : "",
    missingCandidates.length > 0 ? "medication_candidate_coverage_incomplete" : "",
    conflictingStatuses ? "medication_status_conflict" : "",
    ...consistencyReasons,
  ].filter(Boolean);
  if (addedReasons.length === 0) return extraction;
  const reasons = [...new Set([
    ...(extraction.reason || "").split(",").map((item) => item.trim()).filter(Boolean),
    ...addedReasons,
  ])];
  return {
    ...extraction,
    needsManualReview: true,
    reason: reasons.join(","),
  };
}

/**
 * 用药时间线抽取的进程内缓存，键为**抽取输入文本本身**的指纹。
 *
 * 为什么可以缓存：buildMedicationExtractionContext 只读用药史类文本，
 * **与处方药味、剂量、编辑动作完全无关**。而它的三个调用方（M05 随访、医生改方后重新审方、
 * HIS 方案导出）在同一次诊疗里反复触发——医生每调一次剂量就重打一次 1600-token、
 * 上限 30s 的模型调用，且它**串行在灵犀审方 HTTP 之前**，整段等待直接叠加到医生面前。
 *
 * 键取输入文本而不是 caseState：后者含处方内容，改一味药就换键，等于没有缓存。
 * 与限流桶同构的进程内存储，单实例假设；丢缓存只是退回今天的行为，不放宽任何判定。
 */
const MEDICATION_EXTRACTION_TTL_MS = 10 * 60_000;
const MEDICATION_EXTRACTION_MAX_ENTRIES = 128;
const MEDICATION_EXTRACTION_STORE = Symbol.for("tcm-cdss.medication-extraction-cache.v1");
type MedicationExtractionCacheEntry = { value: MedicationSemanticExtraction; at: number };

function medicationExtractionCache(): Map<string, MedicationExtractionCacheEntry> {
  const host = globalThis as unknown as Record<symbol, Map<string, MedicationExtractionCacheEntry> | undefined>;
  const existing = host[MEDICATION_EXTRACTION_STORE];
  if (existing) return existing;
  const created = new Map<string, MedicationExtractionCacheEntry>();
  host[MEDICATION_EXTRACTION_STORE] = created;
  return created;
}

/** Run the same authoritative medication timeline extraction for M05, edited re-audit, and HIS. */
export async function extractMedicationSemanticsForAudit(
  state: CaseState,
  requestSignal?: AbortSignal,
): Promise<MedicationSemanticExtraction> {
  const context = buildMedicationExtractionContext(state);
  const key = createHash("sha256").update(`${context.text}\u0000${context.truncated ? 1 : 0}`).digest("hex");
  const store = medicationExtractionCache();
  const now = Date.now();
  const cached = store.get(key);
  if (cached && now - cached.at <= MEDICATION_EXTRACTION_TTL_MS) return cached.value;
  const extraction = await extractMedicationEventsWithModel(context.text, requestSignal);
  const verified = verifyMedicationSemanticCoverage(context.text, extraction, context.truncated);
  // 只缓存**成功**结果：needsManualReview 是降级态，缓存它会让一次瞬时故障在 10 分钟内
  // 反复把同一份病历钉在人工复核上，而重试本可以恢复。
  if (!verified.needsManualReview) {
    store.set(key, { value: verified, at: now });
    for (const [entryKey, entry] of store) {
      if (now - entry.at > MEDICATION_EXTRACTION_TTL_MS) store.delete(entryKey);
    }
    while (store.size > MEDICATION_EXTRACTION_MAX_ENTRIES) {
      const oldest = store.keys().next();
      if (oldest.done) break;
      store.delete(oldest.value);
    }
  }
  return verified;
}

/** 测试用：清空用药抽取缓存。 */
export function resetMedicationExtractionCache(): void {
  medicationExtractionCache().clear();
}

function firstField(state: CaseState, key: keyof NonNullable<CaseState["hisRecord"]>["fields"]): string {
  return state.hisRecord?.fields?.[key] ?? "";
}

function authoritativeClinicalField(
  state: CaseState,
  key: keyof NonNullable<CaseState["hisRecord"]>["fields"],
  fallback?: string,
): string | undefined {
  const hisValue = firstField(state, key).trim();
  return hisValue || fallback?.trim() || undefined;
}

function authoritativeAge(state: CaseState): number | undefined {
  return ageValue(firstField(state, "age")) ?? ageValue(state.patient.age);
}

function normalizeDoseUnit(unit: string | undefined): string {
  if (!unit) return "g";
  if (/mg|毫克/i.test(unit)) return "mg";
  return "g";
}

function parseDoseText(dose: string | null | undefined): { value?: number; unit?: string; text?: string } {
  const text = dose?.trim();
  if (!text) return {};
  const normalized = text
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/．/g, ".")
    .replace(/－|—|–|~|～/g, "-");
  const single = normalized.match(/^(\d+(?:\.\d+)?)\s*(g|克|mg|毫克)$/i);
  if (!single) return { text };
  const value = Number(single[1]);
  const grams = /mg|毫克/i.test(single[2]) ? value / 1000 : value;
  return Number.isFinite(value) && grams >= 0.001 && grams <= 500
    ? { value, unit: normalizeDoseUnit(single[2]), text }
    : { text };
}

/**
 * 给药途径的确定性推导：**读受治理说明书条目的 usage 原文**，不靠药名猜剂型。
 *
 * 第一版按剂型后缀猜（片/胶囊/颗粒/丸/…/散），实测把**冰硼散**判成了口服——
 * 冰硼散是吹敷患处的外用散。把外用药报成口服，比不报途径危险得多，正是这条推导
 * 一开始就写明要避免的事。改为只认说明书 usage 里写明的口服，且 usage 一旦出现
 * 外用类字样即整条不认；查不到条目也不认（fail-closed：宁可让审方照常提人工复核）。
 */
const ORAL_USAGE = /口服|温开水送服|开水冲服|含化|嚼服|吞服|饭前服|饭后服/;
const NON_ORAL_USAGE = /外用|贴于|敷于|涂于|吹敷|含漱|滴眼|滴鼻|滴耳|塞入|纳肛|灌肠|注射|静脉|肌内|喷于|洗患处/;

export function oralRouteForAuditedMedicine(name: string): boolean {
  const entry = findLocalPatentMedicineEntry(String(name || ""));
  const usage = String(entry?.usage || "");
  if (!usage.trim()) return false;
  if (NON_ORAL_USAGE.test(usage)) return false;
  return ORAL_USAGE.test(usage);
}

function buildAuditItemsFromStructuredHerbs(state: CaseState, candidateIndex?: number): Array<Record<string, unknown>> {
  const candidate = candidateFromState(state, candidateIndex);
  if (!candidate) return [];
  const herbItems = candidate.herbs
    .filter((herb) => herb.name?.trim())
    .slice(0, 50)
    .map((herb, index) => {
      const dose = parseDoseText(herb.dose);
      const processing = herb.processing?.trim() || "";
      const baseName = herb.name.trim();
      const drugName = !processing || baseName.includes(processing)
        ? baseName
        : /^[炙炒制生酒醋蜜盐姜煅]$/.test(processing)
          ? `${processing}${baseName}`
          : `${baseName}（${processing}）`;
      const decoctionRequirement = [
        processing ? `炮制：${processing}` : "",
        herb.decoctionRequirement || "",
        getTcmHerbDoseLimit(baseName)?.sourceConflict
          ? "本地历史规则存在分用途剂量范围，请按本次实际用途、给药途径及现行审方规则复核"
          : "",
      ].filter(Boolean).join("；");
      return {
        item_no: index + 1,
        drug_name: drugName,
        drug_type: "中药饮片",
        ...(dose.value != null ? { single_dose: dose.value, single_dose_unit: dose.unit || "g" } : {}),
        ...(dose.text ? { dose_text: dose.text } : {}),
        ...(decoctionRequirement ? { decoction_requirement: decoctionRequirement } : {}),
        ...(herb.isToxic != null ? { is_toxic_herb: herb.isToxic } : {}),
      };
    });

  const medicineItems = (state.reasoningPrescribe?.formula?.patentAndWestern || [])
    .filter((item) => item?.name?.trim() && (item.type === "中成药" || item.type === "西药"))
    .slice(0, Math.max(0, 50 - herbItems.length))
    .map((item, index) => ({
      item_no: herbItems.length + index + 1,
      drug_name: item.name.trim(),
      drug_type: item.type,
      ...(item.specification?.trim() ? { specification: item.specification.trim() } : {}),
      ...(item.frequency?.trim() ? { frequency_name: item.frequency.trim() } : {}),
      // 给药途径：模型给了就用模型的；没给就按**剂型**确定性推导，只认口服剂型。
      //
      // 2026-08-10 50 例基层回归实测：中成药一律不带 route_name 提交，审方每味都回
      // 「给药途径未提供，缺少可审核的 routeName」→ ROUTE_MISMATCH / MANUAL_REVIEW。
      // 一个含 2 味中成药的病例固定多出 2 条人工复核告警，全是我方没说的信息造成的。
      // 上面 buildAuditItemsFromHerbs 早就为饮片写死了 route_name:"口服"，中成药这一侧漏了——
      // 又一次同一判据只铺了一处。
      //
      // 给药途径不是剂量：补它不违反「不向审方接口伪造单次剂量」那条边界（review_requirement
      // 里那句声明原样保留）。推导不出口服剂型时**不写**，让审方照常提人工复核——
      // 外用/注射剂型冒充口服比不写危险得多。
      ...(item.route?.trim()
        ? { route_name: item.route.trim() }
        : oralRouteForAuditedMedicine(item.name)
          ? { route_name: "口服" }
          : {}),
      ...(item.course?.trim() ? { course_text: item.course.trim() } : {}),
      review_requirement: [
        item.usageBoundary?.trim(),
        item.relationship?.trim(),
        item.riskNote?.trim(),
        "中成药/西药候选仅提交药品身份与联用边界，不向审方接口伪造单次剂量",
      ].filter(Boolean).join("；"),
    }));
  return [...herbItems, ...medicineItems];
}

export function buildAuditItemsFromHerbs(state: CaseState, candidateIndex?: number): Array<Record<string, unknown>> {
  const candidate = candidateFromState(state, candidateIndex);
  if (!candidate) return [];
  const regimen = prescriptionRegimenFromDecoction(candidate.decoction);
  // The provider audits dose together with frequency. Sending a dose-only item creates one
  // INPUT_QUALITY warning per herb. A malformed/legacy regimen is therefore never submitted;
  // local validation still uses the raw structured items to explain what must be completed.
  if (!regimen) return [];
  return buildAuditItemsFromStructuredHerbs(state, candidateIndex).map((item) => ({
    ...(item.drug_type === "中药饮片"
      ? {
          ...item,
          frequency_code: regimen.dosesPerDay === 1 ? "QD" : regimen.dosesPerDay === 2 ? "BID" : "TID",
          frequency_name: `每日${regimen.dosesPerDay}剂，每日分${regimen.administrationTimesPerDay}次服`,
          route_name: "口服",
          course_days: regimen.courseDays,
        }
      : item),
  }));
}

export type RxAuditSubmissionIssue =
  | "candidate_missing"
  | "regimen_incomplete"
  | "herb_dose_incomplete";

export function isRxAuditSubmissionIssueReason(reason: string): reason is RxAuditSubmissionIssue {
  return reason === "candidate_missing" || reason === "regimen_incomplete" || reason === "herb_dose_incomplete";
}

export function rxAuditSubmissionIssue(state: CaseState, candidateIndex?: number): RxAuditSubmissionIssue | undefined {
  const candidate = candidateFromState(state, candidateIndex);
  if (!candidate || (candidate.herbs.length === 0 && (state.reasoningPrescribe?.formula?.patentAndWestern || []).length === 0)) {
    return "candidate_missing";
  }
  if (!prescriptionRegimenFromDecoction(candidate.decoction)) return "regimen_incomplete";
  if (candidate.herbs.some((herb) => parseDoseText(herb.dose).value == null)) return "herb_dose_incomplete";
  return undefined;
}

function buildAuditHerbTargetSummary(state: CaseState, candidateIndex?: number): string {
  const candidate = candidateFromState(state, candidateIndex);
  if (!candidate) return "";
  const rows = candidate.herbs.slice(0, 30).flatMap((herb, index) => {
    const name = herb.name?.trim();
    const targetRef = herb.targetRef?.trim();
    const target = herb.targetPathogenesis?.trim();
    const use = herb.function?.trim();
    if (!name || !targetRef || !target || !use) return [];
    return [`${index + 1}.${name}→${targetRef}（${target}；${use}）`];
  });
  return rows.length > 0 ? `处方病机关联：${rows.join("；")}` : "";
}

export type RxAuditInputAdvisory = {
  code: "missing_dose" | "medication_semantics_unavailable" | "medication_semantics_incomplete";
  itemNo: number;
  drugName: string;
  message: string;
};

/** Local prescription-data quality findings. These never masquerade as LingXi provider issues. */
export function buildAuditInputAdvisories(
  state: CaseState,
  candidateIndex?: number,
  medicationExtraction?: MedicationSemanticExtraction,
): RxAuditInputAdvisory[] {
  const structuredItems = buildAuditItemsFromStructuredHerbs(state, candidateIndex);
  const validationItems = structuredItems.length > 0
    ? structuredItems
    : candidateIndex == null
      ? buildAuditItemsFromPrescriptionMarkdown(state.prescription || "")
      : [];
  const advisories: RxAuditInputAdvisory[] = validationItems.flatMap((item) => {
    if (item.drug_type !== "中药饮片") return [];
    const itemNo = typeof item.item_no === "number" ? item.item_no : 0;
    const drugName = typeof item.drug_name === "string" ? item.drug_name.trim() : "";
    const hasDose = typeof item.single_dose === "number"
      && Number.isFinite(item.single_dose)
      && item.single_dose > 0;
    return !hasDose && drugName
      ? [{ code: "missing_dose" as const, itemNo, drugName, message: `${drugName}未标注单次剂量` }]
      : [];
  });
  if (medicationExtraction?.needsManualReview) {
    const reason = medicationExtraction.reason || "";
    const reviewProblems = [
      reason.includes("medication_context_truncated") ? "现用药原文超过语义抽取上下文上限" : "",
      reason.includes("medication_candidate_coverage_incomplete") ? "语义抽取未覆盖原文中的全部用药候选" : "",
      reason.includes("medication_status_conflict") ? "语义抽取返回相互冲突的药物状态" : "",
      reason.includes("medication_event_identity_conflict") ? "语义事件中的药物身份或原文引文不一致" : "",
      reason.includes("medication_event_data_not_grounded") ? "语义事件中的剂量或频次缺少原文证据" : "",
      reason.includes("medication_patient_subject_conflict") ? "语义事件混入了非患者本人的用药" : "",
      reason.includes("medication_polarity_conflict") ? "语义事件与原文的用药否定极性冲突" : "",
      reason.includes("medication_temporal_status_conflict") ? "语义事件与原文明示的现用或停用状态冲突" : "",
      reason.includes("medication_replacement_timeline_conflict") ? "语义事件未保持替换用药的先停后启时序" : "",
      reason.includes("rxaudit_total_timeout") || reason.includes("model_timeout") ? "语义抽取未在审方总时限内完整完成" : "",
    ].filter(Boolean);
    const message = reviewProblems.length > 0
      ? `${reviewProblems.join("；")}，联用风险必须结合原文人工核对`
      : "现用药时间线或指代未能可靠结构化，联用风险需结合原始用药史人工核对";
    advisories.push({
      code: medicationExtraction.source === "unavailable"
        ? "medication_semantics_unavailable"
        : "medication_semantics_incomplete",
      itemNo: 0,
      drugName: "现用药",
      message,
    });
  }
  return advisories;
}

export function buildRxAuditScopeSection(state: CaseState, candidateIndex?: number): string {
  const candidate = candidateFromState(state, candidateIndex);
  if (!candidate) return "";
  const herbCount = candidate.herbs.filter((herb) => herb.name?.trim()).length;
  const medicines = (state.reasoningPrescribe?.formula?.patentAndWestern || [])
    .filter((item) => item?.name?.trim() && (item.type === "中成药" || item.type === "西药"));
  const patentCount = medicines.filter((item) => item.type === "中成药").length;
  const westernCount = medicines.filter((item) => item.type === "西药").length;
  const submitted = buildAuditItemsFromHerbs(state, candidateIndex);
  const submittedMedicineCount = submitted.filter((item) => item.drug_type === "中成药" || item.drug_type === "西药").length;
  const lines = [
    `**本次审方范围**：中药饮片 ${herbCount} 味；中成药 ${patentCount} 项；西药 ${westernCount} 项。`,
  ];
  if (medicines.length > submittedMedicineCount) {
    lines.push(`**范围限制**：${medicines.length - submittedMedicineCount} 项中成药/西药候选未提交审方，需人工复核联用；本次结果不得解释为整张处方通过。`);
  } else if (medicines.length > 0) {
    lines.push("**范围说明**：中成药/西药候选已按药品身份及联用边界提交，但未伪造单次剂量；剂量与具体用法仍需医生/药师人工确认。");
  } else {
    lines.push("**范围说明**：本次没有形成可提交的中成药或西药候选，审方结论仅覆盖上述中药饮片，不代表其他合并用药已通过。");
  }
  return lines.join("\n");
}

export function buildAuditInputAdvisorySection(advisories: readonly RxAuditInputAdvisory[]): string {
  if (advisories.length === 0) return "";
  return [
    "## 处方信息待核对",
    ...advisories.map((item) => `- ${item.message}。请补齐后重新审方；当前结果不等同于剂量审核通过。`),
  ].join("\n");
}

export function applyRxAuditInputAdvisories(
  outcome: Extract<RxAuditOutcome, { ok: true }>,
  advisories: readonly RxAuditInputAdvisory[],
): Extract<RxAuditOutcome, { ok: true }> {
  if (advisories.length === 0) return outcome;
  return {
    ...outcome,
    auditResult: outcome.auditResult === "BLOCK" ? "BLOCK" : "MANUAL_REVIEW",
    needManualReview: true,
  };
}

function extractSection(text: string, titles: string[]): string {
  if (!text.trim()) return "";
  const escaped = titles.map((title) => title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const match = new RegExp(`^##\\s*(?:${escaped})\\s*$`, "im").exec(text);
  if (!match) return "";
  const start = match.index + match[0].length;
  const rest = text.slice(start).replace(/^\s*\n/, "");
  const next = rest.search(/^##\s+/m);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

function splitMarkdownRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell.replace(/\s+/g, "")));
}

function cleanHerbName(value: string): string {
  return value
    .replace(/<[^>]+>/g, "")
    .replace(/\*\*/g, "")
    .replace(/（.*?）|\(.*?\)/g, "")
    .replace(/^[\d一二三四五六七八九十]+[.、]\s*/, "")
    .trim();
}

function rowLooksLikeHerb(name: string, dose: string): boolean {
  if (!/[\u4e00-\u9fa5]{2,}/.test(name)) return false;
  if (/(提示强度|风险|依据|医生动作|角色|处方角色|对应病机|配伍意义|安全提示|序号|药名|剂量)/.test(name)) return false;
  if (!dose.trim()) return true;
  return /(\d+(?:\.\d+)?\s*(?:g|克|mg|毫克)|先煎|后下|包煎|烊化|冲服|待医生确认|剂量待定)/i.test(dose);
}

function buildAuditItemsFromPrescriptionMarkdown(prescriptionText: string): Array<Record<string, unknown>> {
  const herbalSection = extractSection(prescriptionText, ["中药饮片处方", "候选治疗方案", "候选方药方案", "推荐处方", "方药建议", "治疗方案"]);
  if (!herbalSection) return [];
  const lines = herbalSection.split(/\r?\n/);
  const items: Array<Record<string, unknown>> = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim().startsWith("|")) continue;
    const header = splitMarkdownRow(line);
    if (!header.some((cell) => /药名/.test(cell)) || !header.some((cell) => /剂量/.test(cell))) continue;
    const nameIndex = header.findIndex((cell) => /药名/.test(cell));
    const doseIndex = header.findIndex((cell) => /剂量/.test(cell));
    const decoctionIndex = header.findIndex((cell) => /煎服|处理|炮制|规格/.test(cell));
    const maxRows = Math.min(lines.length, index + 80);
    for (let rowIndex = index + 1; rowIndex < maxRows; rowIndex += 1) {
      const rowLine = lines[rowIndex];
      if (!rowLine.trim().startsWith("|")) {
        if (items.length > 0) break;
        continue;
      }
      const cells = splitMarkdownRow(rowLine);
      if (isSeparatorRow(cells)) continue;
      const name = cleanHerbName(cells[nameIndex] || "");
      const doseText = (cells[doseIndex] || "").trim();
      if (!rowLooksLikeHerb(name, doseText)) continue;
      const dose = parseDoseText(doseText);
      items.push({
        item_no: items.length + 1,
        drug_name: name,
        drug_type: "中药饮片",
        ...(dose.value != null ? { single_dose: dose.value, single_dose_unit: dose.unit || "g" } : {}),
        ...(dose.text ? { dose_text: dose.text } : { dose_text: doseText }),
        ...(decoctionIndex >= 0 && cells[decoctionIndex] ? { decoction_requirement: cells[decoctionIndex].trim().slice(0, 80) } : {}),
      });
      if (items.length >= 50) return items;
    }
    if (items.length > 0) break;
  }

  return items;
}

function buildAuditItems(state: CaseState, candidateIndex?: number): Array<Record<string, unknown>> {
  const structuredItems = buildAuditItemsFromHerbs(state, candidateIndex);
  if (structuredItems.length > 0) return structuredItems;
  // 显式候选索引不存在时禁止回退到 Markdown 或其他候选方，避免审方对象错绑。
  if (candidateIndex != null) return [];
  return buildAuditItemsFromPrescriptionMarkdown(state.prescription || "");
}

/** Build the PRESCRIPTION_AUDIT `data` payload from a case. Returns null when there are no herb items to audit. */
export function buildAuditData(
  state: CaseState,
  candidateIndex?: number,
  medicationExtraction?: MedicationSemanticExtraction,
): { data: Record<string, unknown>; itemCount: number } | null {
  const items = buildAuditItems(state, candidateIndex);
  if (items.length === 0) return null;

  const explicitNames = [state.patient.name, firstField(state, "patientName")]
    .filter((value): value is string => Boolean(value?.trim()));
  const clean = (value?: string, max = 2000) =>
    value ? sanitizeFreeTextForExternalClinicalService(value, explicitNames).slice(0, max) : undefined;

  const chiefComplaint = clean(authoritativeClinicalField(state, "zhushu", state.chiefComplaint));
  const syndrome = clean(diagnoseReasoningFromState(state)?.overview?.primarySyndrome || state.reasoningV2?.overview?.primarySyndrome || extractSyndromeName(state.diagnosis), 120);
  const diagnosisName = clean(structuredWesternDiagnosisName(state) || extractWesternDiagnosisName(state.diagnosis) || syndrome || "中医内科待辨", 60) || "中医内科待辨";
  const diagnosisCoding = diagnoseReasoningFromState(state)?.westernDiagnosis?.primary?.coding
    || prescribeReasoningFromState(state)?.westernDiagnosis?.primary?.coding
    || state.reasoningV2?.westernDiagnosis?.primary?.coding;
  const consultationNo = "cdss-anonymous";

  const patient: Record<string, unknown> = {
    name: "匿名患者",
    gender: genderCode(authoritativeClinicalField(state, "sex", state.patient.sex)),
  };
  const age = authoritativeAge(state);
  if (age != null) patient.age = age;
  if (chiefComplaint) patient.chief_complaint = chiefComplaint;
  // An unresolved comorbidity ("可能有心衰", "疑似肾功能不全") must still reach the audit engine:
  // dropping it removes the exact fact that would have raised a drug-disease warning. Explicit
  // denials stay excluded — forwarding "否认肾功能不全" would invert into a false comorbidity alert.
  const presentIllness = affirmedClinicalText(clean(authoritativeClinicalField(state, "xianbingshi")), "affirmed_or_uncertain");
  if (presentIllness) patient.present_illness = presentIllness;
  const pastHistory = affirmedClinicalText(clean(authoritativeClinicalField(state, "jiwangshi", state.pastHistory)), "affirmed_or_uncertain");
  if (pastHistory) patient.past_medical_history = pastHistory;
  const vitalsText = clean([currentVitalsSummary(state), firstField(state, "vitalsDetail"), state.tongue, state.pulse].filter(Boolean).join("；") || undefined, 500);
  if (vitalsText) patient.physical_examination = vitalsText;
  // Only affirmed clauses enter the vendor's positive allergy/current-medication context. The
  // protocol currently exposes free text here, and forwarding a phrase such as "否认肾功能不全"
  // makes substring-based downstream rules invert its polarity into a false comorbidity alert.
  const medicationText = clean(authoritativeClinicalField(state, "yongyaoshi", state.medicationHistory), 300);
  // A partial semantic result remains authoritative for its high-confidence current events. Only an
  // explicitly unavailable extractor may use the deterministic parser, and callers must pair that
  // fallback with the medication_semantics_unavailable advisory from buildAuditInputAdvisories().
  const semanticMedicationSummary = medicationExtraction && medicationExtraction.source !== "unavailable"
    ? currentMedicationSummaryFromSemanticExtraction(medicationExtraction)
    : affirmedCurrentMedicationText(medicationText);
  const allergyMed = [
    affirmedAllergyText(clean(authoritativeClinicalField(state, "guomin", state.allergyHistory), 300)),
    semanticMedicationSummary,
  ].filter(Boolean).join("；") || undefined;
  const currentMedications = medicationExtraction && medicationExtraction.source !== "unavailable"
    ? currentMedicationsFromSemanticExtraction(medicationExtraction)
    : structuredCurrentMedications(medicationText);
  if (currentMedications.length > 0) patient.current_medications = currentMedications;
  const regimen = prescriptionRegimenFromDecoction(candidateFromState(state, candidateIndex)?.decoction);
  const clinicalSummary = clean([
    allergyMed,
    regimen ? prescriptionRegimenSummary(regimen) : "",
    buildAuditHerbTargetSummary(state, candidateIndex),
  ].filter(Boolean).join("；") || undefined, 1800);
  if (clinicalSummary) patient.clinical_summary = clinicalSummary;

  const data = {
    audit_mode: "SYNC_AUDIT",
    // M05 needs the authoritative rule result synchronously. Optional audit-LLM enrichment must not
    // delay or erase rule alerts; richer explanation can be added asynchronously by the provider.
    options: { include_evidence_detail: true, evidence_max_per_alert: 3, enable_llm_audit: false },
    prescription: {
      prescription_category: "CHINESE_MEDICINE_PRESCRIPTION",
      consultation_no: consultationNo,
      diagnoses: [
        {
          diagnosis_name: diagnosisName,
          ...(diagnosisCoding ? {
            diagnosis_code: diagnosisCoding.code,
            diagnosis_code_system: diagnosisCoding.system,
          } : {}),
          ...(syndrome ? { tcm_syndrome_name: syndrome } : {}),
          is_primary: true,
        },
      ],
      patient,
      items,
    },
  };
  return { data, itemCount: items.length };
}

type LingxiIssue = {
  issue_id?: unknown;
  risk_level?: unknown;
  rule_level?: unknown;
  issue_type?: unknown;
  issue_title?: unknown;
  description?: unknown;
  action?: unknown;
  related_item_nos?: unknown;
  evidence?: unknown;
  suggestions?: unknown;
};

function candidateFromState(state: CaseState, candidateIndex?: number) {
  const activeReasoning = prescribeReasoningFromState(state) || state.reasoningV2;
  const structured = candidateIndex == null
    ? activeReasoning?.formula?.candidates?.find((item) => item.herbs.length > 0)
    : activeReasoning?.formula?.candidates?.[candidateIndex];
  if (structured) return structured;
  const recovered = parseReasoningV2(state.prescription || "");
  return candidateIndex == null
    ? recovered?.formula?.candidates?.find((item) => item.herbs.length > 0)
    : recovered?.formula?.candidates?.[candidateIndex];
}

export function resolveRxAuditCandidateIndex(state: CaseState, candidateIndex?: number): number | undefined {
  if (candidateIndex != null) return candidateFromState(state, candidateIndex) ? candidateIndex : undefined;
  const activeReasoning = prescribeReasoningFromState(state) || state.reasoningV2;
  const structuredIndex = activeReasoning?.formula?.candidates?.findIndex((item) => item.herbs.length > 0) ?? -1;
  if (structuredIndex >= 0) return structuredIndex;
  const recovered = parseReasoningV2(state.prescription || "");
  const recoveredIndex = recovered?.formula?.candidates?.findIndex((item) => item.herbs.length > 0) ?? -1;
  return recoveredIndex >= 0 ? recoveredIndex : undefined;
}

function stableAuditIssueId(parts: unknown[]): string {
  const input = parts.map((part) => String(part ?? "").normalize("NFKC").trim()).join("|");
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `LOCAL-${(hash >>> 0).toString(16).padStart(8, "0").toUpperCase()}`;
}

function boundedProviderText(value: unknown, maxLength = 1000): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.normalize("NFKC").trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

function boundedCorrelationIdentifier(value: unknown): string | undefined {
  const identifier = boundedProviderText(value, 200);
  return identifier && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(identifier) ? identifier : undefined;
}

function doctorFacingAuditIssueTitle(issueType: string | undefined, providerTitle: string | undefined): string {
  const title = providerTitle?.trim();
  // Preserve a provider-authored clinical title. Uppercase enum/code strings are transport data,
  // not clinician-facing copy, even when the provider placed them in issue_title.
  if (title && !/^[A-Z][A-Z0-9_:/.-]{2,}$/.test(title)) return title;
  const type = (issueType || title || "").toUpperCase();
  if (/(?:DECOCTION|煎法|煎煮)/.test(type)) return "煎服方法需复核";
  if (/(?:SPECIAL_POP|PREGN|LACT|妊娠|哺乳)/.test(type)) return "特殊人群用药需复核";
  if (/(?:REPULSION|INCOMPAT|HERB_PAIR|十八反|十九畏|配伍)/.test(type)) return "中药配伍禁忌需处理";
  if (/(?:DUPLICATE|REPEAT|重复)/.test(type)) return "存在重复用药风险";
  if (/(?:INTERACTION|相互作用)/.test(type)) return "存在药物相互作用风险";
  if (/(?:DOSE|用量|剂量)/.test(type)) return "用法用量需调整";
  if (/(?:CONTRAINDICATION|禁忌)/.test(type)) return "用药禁忌需复核";
  if (/(?:ALLERG|过敏)/.test(type)) return "过敏风险需复核";
  if (/(?:FREQUENCY|频次)/.test(type)) return "用药频次需复核";
  if (/(?:ROUTE|途径)/.test(type)) return "给药途径需复核";
  return "用药风险提示";
}

export function normalizeIssues(raw: unknown): RxAuditIssue[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return {
        issueId: stableAuditIssueId(["malformed-audit-issue"]),
        issueIdGenerated: true,
        riskLevel: "HIGH",
        title: "审方响应结构异常",
        description: "外部审方返回了无法识别的问题项，必须转人工复核。",
        relatedItemNos: [],
        evidence: [],
        suggestions: ["请药师人工复核当前处方，并联系审方服务维护人员核查响应结构。"],
      };
    }
    const issue = entry as LingxiIssue;
    const relatedItemNos = Array.isArray(issue.related_item_nos)
      ? issue.related_item_nos.filter((value): value is number => Number.isInteger(value) && value > 0).slice(0, 100)
      : [];
    const riskLevel = normalizeRiskLevel(issue.risk_level, "HIGH");
    const providerIssueId = boundedProviderText(issue.issue_id, 160);
    const ruleLevel = boundedProviderText(issue.rule_level, 120);
    const issueType = boundedProviderText(issue.issue_type, 160);
    const title = boundedProviderText(issue.issue_title, 500);
    const description = boundedProviderText(issue.description, 2000);
    return {
      issueId: providerIssueId || stableAuditIssueId([
        issueType,
        ruleLevel,
        issue.risk_level,
        title,
        description,
        ...relatedItemNos,
      ]),
      issueIdGenerated: !providerIssueId,
      // An unknown vendor enum must never be rendered as a harmless information item.
      riskLevel,
      ruleLevel,
      issueType,
      title: doctorFacingAuditIssueTitle(issueType, title),
      description: description || "",
      action: boundedProviderText(issue.action, 1200),
      relatedItemNos,
      evidence: Array.isArray(issue.evidence)
        ? issue.evidence.filter((ev): ev is Record<string, unknown> => Boolean(ev) && typeof ev === "object" && !Array.isArray(ev)).slice(0, 3).map((ev) => ({
            sourceType: boundedProviderText(ev.source_type, 120),
            sourceName: boundedProviderText(ev.source_name, 500),
            quote: boundedProviderText(ev.quote, 2000),
            ruleName: boundedProviderText(ev.rule_name, 500),
            sourceUrl: boundedProviderText(ev.source_url, 1000) || null,
            year: typeof ev.year === "string" || typeof ev.year === "number" ? String(ev.year).slice(0, 20) : null,
          }))
        : [],
      suggestions: Array.isArray(issue.suggestions)
        ? issue.suggestions.map((suggestion) =>
            suggestion && typeof suggestion === "object" && !Array.isArray(suggestion)
              ? boundedProviderText((suggestion as Record<string, unknown>).content, 1200)
              : undefined
          ).filter((value): value is string => Boolean(value)).slice(0, 20)
        : [],
    };
  });
}

const AUDIT_RISK_ORDER: RxAuditRiskLevel[] = ["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"];

function normalizedAuditKeyText(value: string | undefined): string {
  return (value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s，。；、：:,.!?！？()（）\[\]【】_-]+/g, "");
}

function auditIssueSemanticKey(issue: RxAuditIssue): string {
  const issueId = normalizedAuditKeyText(issue.issueId);
  if (issueId) return `id:${issueId}`;
  return [issue.issueType, issue.ruleLevel, issue.title, issue.description]
    .map((value) => normalizedAuditKeyText(value))
    .join("|");
}

function uniqueAuditValues<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const normalized = key(item);
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

export function dedupeRxAuditIssues(issues: RxAuditIssue[]): RxAuditIssue[] {
  const grouped = new Map<string, RxAuditIssue>();
  for (const issue of issues) {
    const key = auditIssueSemanticKey(issue);
    const previous = grouped.get(key);
    if (!previous) {
      grouped.set(key, {
        ...issue,
        relatedItemNos: [...new Set(issue.relatedItemNos)].sort((a, b) => a - b),
        evidence: uniqueAuditValues(issue.evidence, (item) => normalizedAuditKeyText([
          item.sourceType, item.sourceName, item.quote, item.ruleName, item.sourceUrl || undefined, item.year || undefined,
        ].filter(Boolean).join("|"))),
        suggestions: uniqueAuditValues(issue.suggestions, normalizedAuditKeyText),
      });
      continue;
    }
    const previousRisk = normalizeRiskLevel(previous.riskLevel, "HIGH");
    const currentRisk = normalizeRiskLevel(issue.riskLevel, "HIGH");
    const currentIsHigher = AUDIT_RISK_ORDER.indexOf(currentRisk) > AUDIT_RISK_ORDER.indexOf(previousRisk);
    const preferred = currentIsHigher ? issue : previous;
    grouped.set(key, {
      ...preferred,
      riskLevel: currentIsHigher ? currentRisk : previousRisk,
      relatedItemNos: [...new Set([...previous.relatedItemNos, ...issue.relatedItemNos])].sort((a, b) => a - b),
      evidence: uniqueAuditValues([...previous.evidence, ...issue.evidence], (item) => normalizedAuditKeyText([
        item.sourceType, item.sourceName, item.quote, item.ruleName, item.sourceUrl || undefined, item.year || undefined,
      ].filter(Boolean).join("|"))),
      suggestions: uniqueAuditValues([...previous.suggestions, ...issue.suggestions], normalizedAuditKeyText),
    });
  }
  return [...grouped.values()];
}

function localPairItemNos(state: CaseState, candidateIndex: number | undefined, leftDrug: string, rightDrug: string): number[] {
  const candidate = candidateFromState(state, candidateIndex);
  if (!candidate) return [];
  const conflictKey = [leftDrug, rightDrug].sort().join("|");
  return candidate.herbs.flatMap((herb, index) => {
    const name = cleanHerbName(herb.name).replace(/^[炙炒制酒醋蜜盐姜煅法]/, "");
    const matchesCanonicalConflict = [
      ...findTcmHerbPairIncompatibilities([herb.name, rightDrug]),
      ...findTcmHerbPairIncompatibilities([leftDrug, herb.name]),
    ].some((pair) => [pair.leftDrug, pair.rightDrug].sort().join("|") === conflictKey);
    return matchesCanonicalConflict || name === leftDrug || name === rightDrug || name.endsWith(leftDrug) || name.endsWith(rightDrug)
      ? [index + 1]
      : [];
  });
}

/** Convert deterministic local incompatibilities into first-class audit issues for every audit route. */
export function buildLocalHighRiskHerbPairIssues(state: CaseState, candidateIndex?: number): RxAuditIssue[] {
  const candidate = candidateFromState(state, candidateIndex);
  if (!candidate) return [];
  const herbNames = candidate.herbs.map((herb) => herb.name);
  // 十九畏走**提示档**：与十八反同样逐条报出来，但 riskLevel 为 MEDIUM，
  // 且不进 diagnosis-stage-contract 的驳回码路径（那条路只读 findTcmHerbPairIncompatibilities）。
  // 放开前它们 28 条对所有出口都不可见——丁香×郁金、人参×五灵脂这类门诊组合一句提示都没有。
  const tiered = [
    ...findTcmHerbPairIncompatibilities(herbNames).map((conflict) => ({ conflict, high: true })),
    ...findTcmHerbPairCautions(herbNames).map((conflict) => ({ conflict, high: false })),
  ];
  return tiered.map(({ conflict, high }) => ({
    issueId: stableAuditIssueId(["local-tcm-herb-pair", conflict.leftDrug, conflict.rightDrug]),
    issueIdGenerated: true,
    riskLevel: high ? "HIGH" : "MEDIUM",
    ruleLevel: "LOCAL_DETERMINISTIC",
    issueType: "TCM_HERB_PAIR_INCOMPATIBILITY",
    title: high
      ? `${conflict.leftDrug}—${conflict.rightDrug}高风险配伍`
      : `${conflict.leftDrug}—${conflict.rightDrug}配伍相畏`,
    description: high
      ? `命中${conflict.category || "高风险配伍"}，请医生或药师重点复核。`
      : `命中${conflict.category || "配伍相畏"}（强度低于十八反），请医生或药师确认是否确需同用。`,
    action: "MANUAL_REVIEW",
    relatedItemNos: localPairItemNos(state, candidateIndex, conflict.leftDrug, conflict.rightDrug),
    evidence: [{
      sourceType: "LOCAL_RULE",
      sourceName: "本地结构化配伍规则",
      quote: conflict.basis || "本地结构化配伍规则",
      ruleName: conflict.category || "高风险配伍",
    }],
    suggestions: ["请医生或药师重点复核；本提示仅作审方建议，不阻断诊疗流程。"],
  }));
}

export function buildLocalHighRiskHerbPairSection(state: CaseState, candidateIndex?: number): string {
  const issues = buildLocalHighRiskHerbPairIssues(state, candidateIndex);
  if (issues.length === 0) return "";
  return [
    "## 生成前配伍预检提示",
    ...issues.map((issue) => {
      const basis = issue.evidence[0]?.quote || "本地结构化配伍规则";
      return `- **${issue.title.replace(/(?:高风险配伍|配伍相畏)$/, "")}**：${issue.description}依据：${basis}。本提示不阻断诊疗流程。`;
    }),
  ].join("\n");
}

/** Merge provider and local issues while ensuring a local HIGH can never be reported as PASS/LOW. */
export function mergeLocalHighRiskHerbPairIssues(
  state: CaseState,
  candidateIndex: number | undefined,
  outcome: Extract<RxAuditOutcome, { ok: true }>,
): Extract<RxAuditOutcome, { ok: true }> {
  const localIssues = buildLocalHighRiskHerbPairIssues(state, candidateIndex);
  if (localIssues.length === 0) return outcome;
  const issues = dedupeRxAuditIssues([...outcome.issues, ...localIssues]);
  const highestRiskLevel = issues.reduce<RxAuditRiskLevel>((highest, issue) => {
    const risk = normalizeRiskLevel(issue.riskLevel, "HIGH");
    return AUDIT_RISK_ORDER.indexOf(risk) > AUDIT_RISK_ORDER.indexOf(highest) ? risk : highest;
  }, outcome.highestRiskLevel);
  return {
    ...outcome,
    auditResult: outcome.auditResult === "BLOCK" ? "BLOCK" : "MANUAL_REVIEW",
    highestRiskLevel,
    needManualReview: true,
    issues,
  };
}

export function buildRxAuditCorrelationMetadata(input: {
  providerOutcome: RxAuditOutcome;
  effectiveOutcome?: Extract<RxAuditOutcome, { ok: true }>;
  candidateIndex?: number;
  prescriptionHash?: string;
  auditedAt?: string;
}): RxAuditCorrelationMetadata {
  const provider = input.providerOutcome;
  const effective = input.effectiveOutcome;
  return {
    provider: "lingxi-rxaudit",
    providerAvailable: provider.ok,
    ...(provider.ok ? {
      providerDegraded: provider.degraded,
      ...(provider.degraded && provider.degradeReason
        ? { providerDegradeReason: boundedProviderText(provider.degradeReason, 300) }
        : {}),
      providerAuditResult: provider.auditResult,
      providerHighestRiskLevel: provider.highestRiskLevel,
      auditId: boundedCorrelationIdentifier(provider.auditId),
      traceId: boundedCorrelationIdentifier(provider.traceId),
    } : { providerReason: provider.reason }),
    ...(input.candidateIndex != null ? { candidateIndex: input.candidateIndex } : {}),
    ...(input.prescriptionHash ? { prescriptionHash: input.prescriptionHash } : {}),
    auditedAt: input.auditedAt || new Date().toISOString(),
    effectiveAuditResult: effective?.auditResult || "MANUAL_REVIEW",
    effectiveHighestRiskLevel: effective?.highestRiskLevel || "HIGH",
    needManualReview: effective?.needManualReview ?? true,
  };
}

export function buildRxAuditCorrelationMarker(metadata: RxAuditCorrelationMetadata): string {
  return `<!-- TCM_CDSS_RXAUDIT_CORRELATION:${encodeURIComponent(JSON.stringify(metadata))} -->`;
}

export type BoundedRxAuditRun = {
  medicationExtraction: MedicationSemanticExtraction;
  providerAudit: RxAuditOutcome;
  timeoutMs: number;
  timedOut: boolean;
  cacheStatus: "hit" | "miss" | "bypass";
};

const DEFAULT_RXAUDIT_CACHE_TTL_MS = 90_000;
const MIN_RXAUDIT_CACHE_TTL_MS = 60_000;
const MAX_RXAUDIT_CACHE_TTL_MS = 120_000;
const RXAUDIT_CACHE_MAX_ENTRIES = 128;
const RXAUDIT_RESULT_STORE = Symbol.for("tcm-cdss.rxaudit-result-cache.v1");
type CachedRxAuditRun = Omit<BoundedRxAuditRun, "cacheStatus">;
type RxAuditResultCacheEntry = { value: CachedRxAuditRun; at: number };

export function getRxAuditCacheTtlMs(value: unknown = process.env.RXAI_AUDIT_CACHE_TTL_MS): number {
  if (value == null || (typeof value === "string" && !value.trim())) return DEFAULT_RXAUDIT_CACHE_TTL_MS;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= MIN_RXAUDIT_CACHE_TTL_MS && parsed <= MAX_RXAUDIT_CACHE_TTL_MS
    ? parsed
    : DEFAULT_RXAUDIT_CACHE_TTL_MS;
}

function rxAuditResultCache(): Map<string, RxAuditResultCacheEntry> {
  const host = globalThis as unknown as Record<symbol, Map<string, RxAuditResultCacheEntry> | undefined>;
  const existing = host[RXAUDIT_RESULT_STORE];
  if (existing) return existing;
  const created = new Map<string, RxAuditResultCacheEntry>();
  host[RXAUDIT_RESULT_STORE] = created;
  return created;
}

function rxAuditResultCacheKey(state: CaseState, candidateIndex?: number): string {
  const resolvedIndex = resolveRxAuditCandidateIndex(state, candidateIndex);
  const reasoning = prescribeReasoningFromState(state) || state.reasoningV2;
  if (resolvedIndex == null || !reasoning) return "";
  const payload = prescriptionVersionPayload(reasoning, resolvedIndex, state);
  const auditData = buildAuditData(state, resolvedIndex)?.data;
  return payload && auditData
    ? createHash("sha256").update(`${payload}\u0000${JSON.stringify(auditData)}`).digest("hex")
    : "";
}

function cloneCachedRxAuditRun(value: CachedRxAuditRun): CachedRxAuditRun {
  return structuredClone(value);
}

function cachedRxAuditRun(key: string, now = Date.now()): CachedRxAuditRun | undefined {
  if (!key) return undefined;
  const store = rxAuditResultCache();
  const entry = store.get(key);
  if (!entry) return undefined;
  if (now - entry.at > getRxAuditCacheTtlMs()) {
    store.delete(key);
    return undefined;
  }
  return cloneCachedRxAuditRun(entry.value);
}

function storeRxAuditRun(key: string, value: CachedRxAuditRun, now = Date.now()): void {
  if (!key || !value.providerAudit.ok || value.providerAudit.degraded || value.timedOut) return;
  const store = rxAuditResultCache();
  store.set(key, { value: cloneCachedRxAuditRun(value), at: now });
  const ttl = getRxAuditCacheTtlMs();
  for (const [entryKey, entry] of store) {
    if (now - entry.at > ttl) store.delete(entryKey);
  }
  while (store.size > RXAUDIT_CACHE_MAX_ENTRIES) {
    const oldest = store.keys().next();
    if (oldest.done) break;
    store.delete(oldest.value);
  }
}

export function resetRxAuditResultCache(): void {
  rxAuditResultCache().clear();
}

function unavailableMedicationExtraction(reason: string): MedicationSemanticExtraction {
  return {
    source: "unavailable",
    events: [],
    unresolvedReferences: [],
    needsManualReview: true,
    reason,
  };
}

/** Apply one deadline to semantic extraction, retries, response parsing, and provider audit. */
export async function runBoundedRxAudit(
  state: CaseState,
  candidateIndex?: number,
  requestSignal?: AbortSignal,
): Promise<BoundedRxAuditRun> {
  const timeoutMs = getRxAuditTimeoutMs();
  const absoluteDeadline = Date.now() + timeoutMs;
  const submissionIssue = rxAuditSubmissionIssue(state, candidateIndex);
  if (submissionIssue) {
    return {
      medicationExtraction: { source: "not_needed", events: [], unresolvedReferences: [], needsManualReview: false },
      providerAudit: {
        ok: false,
        source: "unavailable",
        reason: submissionIssue,
        itemCount: candidateFromState(state, candidateIndex)?.herbs.length ?? 0,
      },
      timeoutMs,
      timedOut: false,
      cacheStatus: "bypass",
    };
  }
  const itemCount = buildAuditData(state, candidateIndex)?.itemCount ?? 0;
  if (itemCount === 0) {
    return {
      medicationExtraction: { source: "not_needed", events: [], unresolvedReferences: [], needsManualReview: false },
      providerAudit: { ok: false, source: "unavailable", reason: "no_prescription_items", itemCount: 0 },
      timeoutMs,
      timedOut: false,
      cacheStatus: "bypass",
    };
  }
  if (requestSignal?.aborted) {
    return {
      medicationExtraction: unavailableMedicationExtraction("rxaudit_request_aborted"),
      providerAudit: { ok: false, source: "unavailable", reason: "rxaudit_request_aborted", itemCount },
      timeoutMs,
      timedOut: false,
      cacheStatus: "bypass",
    };
  }
  const config = getRxAuditConfig();
  if (!config.enabled || !config.configured || !config.transportAllowed) {
    const reason = config.disabledReason || "rxaudit_not_configured";
    return {
      medicationExtraction: unavailableMedicationExtraction(reason),
      providerAudit: { ok: false, source: "unavailable", reason, itemCount },
      timeoutMs,
      timedOut: false,
      cacheStatus: "bypass",
    };
  }
  const cacheKey = rxAuditResultCacheKey(state, candidateIndex);
  const cached = cachedRxAuditRun(cacheKey);
  if (cached) {
    console.info("[tcm-cdss:timing] rxaudit_cache", { status: "hit", ttlMs: getRxAuditCacheTtlMs() });
    return { ...cached, cacheStatus: "hit" };
  }
  const controller = new AbortController();
  let timedOut = false;
  const abortFromRequest = () => controller.abort();
  if (requestSignal?.aborted) controller.abort();
  else requestSignal?.addEventListener("abort", abortFromRequest, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  let medicationExtraction = unavailableMedicationExtraction(
    requestSignal?.aborted ? "rxaudit_request_aborted" : "rxaudit_total_timeout",
  );
  try {
    medicationExtraction = await extractMedicationSemanticsForAudit(state, controller.signal);
    if (timedOut || requestSignal?.aborted || controller.signal.aborted) {
      const reason = timedOut ? "rxaudit_total_timeout" : "rxaudit_request_aborted";
      return {
        medicationExtraction: { ...medicationExtraction, needsManualReview: true, reason },
        providerAudit: { ok: false, source: "unavailable", reason, itemCount },
        timeoutMs,
        timedOut,
        cacheStatus: "miss",
      };
    }
    const providerAudit = await auditPrescriptionWithLingxi(
      state,
      candidateIndex,
      controller.signal,
      medicationExtraction,
      absoluteDeadline,
    );
    if (timedOut) {
      return {
        medicationExtraction,
        providerAudit: { ok: false, source: "unavailable", reason: "rxaudit_total_timeout", itemCount },
        timeoutMs,
        timedOut: true,
        cacheStatus: "miss",
      };
    }
    const completed: CachedRxAuditRun = { medicationExtraction, providerAudit, timeoutMs, timedOut: false };
    storeRxAuditRun(cacheKey, completed);
    if (providerAudit.ok && !providerAudit.degraded) {
      console.info("[tcm-cdss:timing] rxaudit_cache", { status: "stored", ttlMs: getRxAuditCacheTtlMs() });
    }
    return { ...completed, cacheStatus: "miss" };
  } finally {
    clearTimeout(timeout);
    requestSignal?.removeEventListener("abort", abortFromRequest);
  }
}

/** Consistent advisory copy for every route when no complete provider result is available. */
export function buildUnavailableRxAuditSection(reason: string): string {
  const status = reason === "no_prescription_items" || reason === "candidate_missing"
    ? "当前候选方药尚未形成可审查的完整药味清单，本次未发起自动审方。"
    : reason === "regimen_incomplete"
      // 复诊节点已从处方展示面移除（需求5），错误提示不再指向医生看不到也改不了的字段；
      // 实际触发条件仍是 doseCount/dosesPerDay/course 不合法（followUpNode 由服务端派生）。
      // 提交门本身（prescriptionRegimenFromDecoction）未改动，仍然读 followUpNode。
      ? "当前处方缺少可核验的每日频次或疗程，本次未调用外部审方接口。"
      : reason === "herb_dose_incomplete"
        ? "当前处方存在缺失或无法解析的单味剂量，本次未调用外部审方接口。"
        : reason === "rxaudit_total_timeout" || reason === "rxaudit_timeout"
      ? "现用药语义抽取与自动审方未能在统一总时限内完整完成，本次按审方降级处理。"
        : reason === "rxaudit_request_aborted"
          ? "现用药语义抽取与自动审方编排被中断，本次按审方降级处理。"
          : "本次未取得完整的自动用药复核结果，按审方降级处理。";
  return [
    "## 合理用药审方",
    `**审方服务状态**：${status}`,
    "**审方结论**：需人工复核 ｜ **最高风险等级**：高风险",
    "**处置建议**：当前结果不能等同于完整 PASS 或无用药风险；该提示不阻断诊疗流程，候选方药采纳前请由医生或药师人工复核。",
  ].join("\n");
}

/**
 * 我方**有意不提交单次剂量**的那些行（2026-08-11 线上实测）。
 *
 * 系统对中成药/西药明确不下单次剂量——编译器把 singleDose/frequency/route 置空、
 * course 写死「本候选不形成疗程医嘱」，提交给审方的 item 里干脆没有 single_dose 字段。
 * 这是有意的 fail-closed 设计（不向审方伪造剂量），提交侧写得清清楚楚。
 *
 * 但这条判据此前**只写在提交侧**：灵犀按协议对每条无 single_dose 的 item 回一条
 * 「未提供可识别的单次剂量」告警，回包路径上没有这条判据的任何副本，于是它和真实的
 * 配伍禁忌、相互作用同格渲染进风险表，还向下游放大——抬高处方安全总评、被拼进随访触发条件、
 * 原样写回 HIS。医生看到的是一串必然出现、且我方自己造成的告警。
 *
 * 本仓库标志性形状：同一判据两处各写各的。本地 buildAuditInputAdvisories 里早就写着
 * 「缺剂量只对中药饮片成立」（`if (item.drug_type !== "中药饮片") return []`），
 * 回包侧却没有。这里把它收敛成导出谓词，提交侧与回包侧共用**同一份事实**：
 * 行号集合直接读 buildAuditData 已构造好的清单，不重新推导，杜绝漂移。
 */
export function declaredNonDoseItemNos(data: Record<string, unknown> | null | undefined): Set<number> {
  const prescription = data && typeof data === "object" ? (data as { prescription?: unknown }).prescription : undefined;
  const items = prescription && typeof prescription === "object"
    ? (prescription as { items?: unknown }).items
    : undefined;
  const result = new Set<number>();
  for (const raw of Array.isArray(items) ? items : []) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const drugType = String(item.drug_type || "");
    if (drugType !== "中成药" && drugType !== "西药") continue;
    if ("single_dose" in item && String(item.single_dose || "").trim()) continue;
    const itemNo = Number(item.item_no);
    if (Number.isInteger(itemNo)) result.add(itemNo);
  }
  return result;
}

/** 剂量缺失类告警的判据。禁忌/相互作用/重复用药一条不动——它们落在同一行上也照常呈现。 */
const DECLARED_NON_DOSE_ISSUE_TEXT = /未提供.{0,8}单次剂量|无法识别的剂量|剂量适宜性审核/;

export function isDeclaredNonDoseScopeIssue(
  issue: Pick<RxAuditIssue, "issueType" | "issueId" | "title" | "description" | "relatedItemNos">,
  nonDoseItemNos: ReadonlySet<number>,
): boolean {
  if (nonDoseItemNos.size === 0) return false;
  const rows = issue.relatedItemNos || [];
  // 必须**整条**都落在有意不下剂量的行上：一条同时牵涉饮片的告警不得被归入范围说明。
  if (rows.length === 0 || !rows.every((row) => nonDoseItemNos.has(row))) return false;
  const looksLikeDoseInput = String(issue.issueType || "").toUpperCase() === "INPUT_QUALITY" ||
    /RX-INPUT-DOSE/i.test(String(issue.issueId || ""));
  return looksLikeDoseInput && DECLARED_NON_DOSE_ISSUE_TEXT.test(`${issue.title || ""}；${issue.description || ""}`);
}

/** Mechanical M04 defects that should be prevented before a candidate reaches the advisory audit. */
export function isMechanicallyPreventableAuditIssue(
  issue: Pick<RxAuditIssue, "issueType" | "title" | "description">,
): boolean {
  const issueType = String(issue.issueType || "").normalize("NFKC").trim().toUpperCase();
  if ([
    "DOSE_OVER",
    "DOSE_UNDER",
    "TCM_DECOCTION_METHOD",
    "TCM_SPECIAL_DECOCTION",
    "TCM_DECOCTION_REQUIREMENT",
  ].includes(issueType)) return true;
  const text = `${issue.title || ""}；${issue.description || ""}`.normalize("NFKC");
  return /(?:剂量|用量).*(?:超过|超出|偏高|不足|低于|下限)|(?:应|需|须)(?:先煎|后下|另煎|包煎|烊化|冲服).*(?:未标注|未注明|缺少|遗漏)|(?:煎法|煎服|煎煮).*(?:缺失|错误|不完整)/.test(text);
}

/** Call the LingXi audit engine. Provider failures become visible review advisories; caller cancellation stops retries. */
export async function auditPrescriptionWithLingxi(
  state: CaseState,
  candidateIndex?: number,
  requestSignal?: AbortSignal,
  medicationExtraction?: MedicationSemanticExtraction,
  absoluteDeadline = Date.now() + getRxAuditTimeoutMs(),
): Promise<RxAuditOutcome> {
  const submissionIssue = rxAuditSubmissionIssue(state, candidateIndex);
  if (submissionIssue) {
    return {
      ok: false,
      source: "unavailable",
      reason: submissionIssue,
      itemCount: candidateFromState(state, candidateIndex)?.herbs.length ?? 0,
    };
  }
  const built = buildAuditData(state, candidateIndex, medicationExtraction);
  if (!built) return { ok: false, source: "unavailable", reason: "no_prescription_items", itemCount: 0 };
  const requestTimeoutMs = getRxAuditAttemptTimeoutMs();

  const cfg = getRxAuditConfig();
  if (!cfg.enabled || !cfg.configured || !cfg.transportAllowed) {
    return { ok: false, source: "unavailable", reason: cfg.disabledReason || "rxaudit_not_configured", itemCount: built.itemCount };
  }

  requestSeq += 1;
  const requestId = `cdss_${Date.now()}_${requestSeq}`.slice(0, 64);
  const body = JSON.stringify({
    request_id: requestId,
    system_code: cfg.systemCode,
    operation: "PRESCRIPTION_AUDIT",
    data: built.data,
  });

  const retryDelayMs = (attempt: number) => 800 * attempt;
  const retryFitsDeadline = (nextAttempt: number) =>
    absoluteDeadline - Date.now() >= retryDelayMs(nextAttempt) + MIN_RETRY_ATTEMPT_BUDGET_MS;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (requestSignal?.aborted) {
      return { ok: false, source: "unavailable", reason: "rxaudit_request_aborted", itemCount: built.itemCount };
    }
    if (attempt > 0) {
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          requestSignal?.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(finish, retryDelayMs(attempt));
        requestSignal?.addEventListener("abort", finish, { once: true });
      });
      if (requestSignal?.aborted) {
        return { ok: false, source: "unavailable", reason: "rxaudit_request_aborted", itemCount: built.itemCount };
      }
    }
    const remainingMs = absoluteDeadline - Date.now();
    // This budget guard gates RETRIES only. Attempt 0 always runs: its per-attempt timer is
    // clamped to the remaining total budget below, so the unified absolute deadline still bounds
    // the whole run and the total timeout genuinely fires instead of a pre-fetch Date.now() race.
    if (attempt > 0 && remainingMs < MIN_RETRY_ATTEMPT_BUDGET_MS) {
      return { ok: false, source: "unavailable", reason: "rxaudit_total_timeout", itemCount: built.itemCount };
    }
    // When the per-attempt timeout had to be clamped to the remaining total budget (or the
    // deadline already passed), the unified total deadline — not the attempt timeout — is the
    // binding constraint, so an abort of this attempt is classified as the total timeout.
    const totalBudgetBinding = remainingMs < requestTimeoutMs;
    const controller = new AbortController();
    const abortFromRequest = () => controller.abort();
    requestSignal?.addEventListener("abort", abortFromRequest, { once: true });
    const timeout = setTimeout(() => controller.abort(), Math.min(requestTimeoutMs, remainingMs));
    const cleanup = () => {
      clearTimeout(timeout);
      requestSignal?.removeEventListener("abort", abortFromRequest);
    };
    let res: Response;
    try {
      res = await fetch(`${cfg.baseUrl}${AUDIT_PATH}`, {
        method: "POST",
        headers: rxAuditHeaders(cfg),
        body,
        signal: controller.signal,
      });
    } catch (error) {
      cleanup();
      if (requestSignal?.aborted) {
        return { ok: false, source: "unavailable", reason: "rxaudit_request_aborted", itemCount: built.itemCount };
      }
      if (attempt < MAX_RETRIES && retryFitsDeadline(attempt + 1)) continue;
      const aborted = error instanceof DOMException && error.name === "AbortError";
      const reason = aborted
        ? totalBudgetBinding || Date.now() >= absoluteDeadline
          ? "rxaudit_total_timeout"
          : "rxaudit_timeout"
        : "rxaudit_network_error";
      return { ok: false, source: "unavailable", reason, itemCount: built.itemCount };
    }
    if (res.status === 429 || res.status >= 500) {
      await res.body?.cancel().catch(() => undefined);
      cleanup();
      if (attempt < MAX_RETRIES && retryFitsDeadline(attempt + 1)) continue;
      return { ok: false, source: "unavailable", reason: `rxaudit_http_${res.status}`, itemCount: built.itemCount };
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      cleanup();
      return { ok: false, source: "unavailable", reason: `rxaudit_http_${res.status}`, itemCount: built.itemCount };
    }

    let parsed: unknown;
    try {
      const raw = await readResponseTextLimited(res, RXAUDIT_MAX_RESPONSE_BYTES);
      parsed = JSON.parse(raw);
    } catch (error) {
      const aborted = controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError");
      cleanup();
      if (requestSignal?.aborted) {
        return { ok: false, source: "unavailable", reason: "rxaudit_request_aborted", itemCount: built.itemCount };
      }
      if (aborted && attempt < MAX_RETRIES && retryFitsDeadline(attempt + 1)) continue;
      const reason = error instanceof UpstreamResponseTooLargeError
        ? "rxaudit_response_too_large"
        : aborted
          ? totalBudgetBinding || Date.now() >= absoluteDeadline
            ? "rxaudit_total_timeout"
            : "rxaudit_timeout"
          : "rxaudit_invalid_json";
      return { ok: false, source: "unavailable", reason, itemCount: built.itemCount };
    }
    cleanup();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, source: "unavailable", reason: "rxaudit_invalid_response_shape", itemCount: built.itemCount };
    }
    const parsedRecord = parsed as Record<string, unknown>;
    if (parsedRecord.code !== 200 || !parsedRecord.data || typeof parsedRecord.data !== "object" || Array.isArray(parsedRecord.data)) {
      return { ok: false, source: "unavailable", reason: `rxaudit_business_${parsedRecord.code ?? "error"}`, itemCount: built.itemCount };
    }
    const d = parsedRecord.data as Record<string, unknown>;
    // 打标而非删除：provider 的每条 issue 与 issueId 原样保留（本地不过滤供方告警），
    // 只给「落在我方有意不下剂量的行上、且属剂量缺失类」的条目加一个 scope，供呈现层归位。
    const nonDoseItemNos = declaredNonDoseItemNos(built.data);
    const issues = dedupeRxAuditIssues(normalizeIssues(d.issues)).map((issue) => (
      isDeclaredNonDoseScopeIssue(issue, nonDoseItemNos) ? { ...issue, scope: "declared_non_dose" as const } : issue
    ));
    const malformedIssuesContainer = d.issues != null && !Array.isArray(d.issues);
    const decision = normalizeLingxiDecision({
      auditResult: d.audit_result,
      highestRiskLevel: d.highest_risk_level,
      issueRiskLevels: issues.map((issue) => issue.riskLevel),
      issueCount: issues.length,
      needManualReview: malformedIssuesContainer || issues.some((issue) => issue.issueIdGenerated)
        ? true
        : d.need_manual_review,
    });
    return {
      ok: true,
      source: "lingxi",
      degraded: d.degraded === true,
      degradeReason: boundedProviderText(d.degrade_reason, 300),
      auditResult: decision.auditResult,
      highestRiskLevel: decision.highestRiskLevel,
      needManualReview: decision.needManualReview,
      issues,
      auditId: boundedCorrelationIdentifier(d.audit_id),
      traceId: boundedCorrelationIdentifier(parsedRecord.trace_id),
      itemCount: built.itemCount,
    };
  }
  return { ok: false, source: "unavailable", reason: "rxaudit_exhausted_retries", itemCount: built.itemCount };
}

const RISK_LABEL: Record<string, string> = {
  CRITICAL: "严重风险", HIGH: "高风险", MEDIUM: "中风险", LOW: "低风险", INFO: "信息提示",
};
const RESULT_LABEL: Record<string, string> = {
  BLOCK: "强提示，需人工复核", MANUAL_REVIEW: "需人工复核", REMIND: "低风险提醒", PASS: "未见需提示问题",
};

function severityTag(risk: string): string {
  if (risk === "CRITICAL" || risk === "HIGH") return "强提示";
  if (risk === "MEDIUM") return "一般提示";
  return "信息提示";
}

/**
 * 审方风险文本里的**人群枚举**按本例性别逐项裁剪。
 *
 * 为什么必须在这一层做：审方风险的适用人群写法几乎都是**析取枚举**——
 * 「出血倾向/月经期/抗凝状态」「儿童、孕妇、哺乳期妇女、经期妇女、年老体弱者应在医师指导下服用」。
 * 其中只有一部分限定女性生理状态，其余（出血倾向、抗凝状态、儿童、年老体弱）与性别无关。
 * 而下游只有一道**按整格/整句**判定的性别适用性净化：整格命中即整格改写为「本例男性不适用」，
 * 整句命中即整句删除。于是与性别无关的那一半被连坐——
 * 生产实测（2026-08-04，BASE_URL=https://82.156.128.153/tcm-cdss）：
 *   · fixa-d2c，71 岁男性胸痹：丹参保心茶说明书第 5 条整条消失（4. 之后直接 6.），
 *     而该条对本例成立的正是「年老体弱者应在医师指导下服用」；
 *   · fixa-d2，58 岁男性、长期服阿司匹林：丹参/川芎/桃仁/红花的「出血倾向/月经期/抗凝状态」
 *     逐味安全边界被清成 19 个连续分号——识别正确的活血药出血风险被整段抹掉。
 *
 * 判定用**受治理人群限定词表**（tcm-population-scope.source.json → matchesPopulationScope 的
 * maternal 组），不新写中文词表：该组恰好覆盖 孕妇/月经/妊娠/妇女/乳汁 等女性生理限定写法，
 * 而「儿童」「年老体弱者」「出血倾向」「抗凝状态」一个都不命中。
 *
 * 边界：只删**枚举项**，不删整条风险、不降风险等级、不改审方结论。整条都只限定女性生理状态时
 * 不再交给下游猜，本层直接标 not_applicable 并给出不含女性限定词的显式说明。
 */
// 刻意不收「和」：它更常出现在词内（调和诸药、和胃降逆）而不是作枚举连接，切开会把正文打碎。
const RX_AUDIT_ENUMERATION_SEPARATORS = /([、，,;；/／|｜]|以及)/;

export function sexScopedRiskText(text: string, gender: "MALE" | "FEMALE" | "UNKNOWN"): string {
  if (gender !== "MALE" || !text) return text;
  const parts = text.split(RX_AUDIT_ENUMERATION_SEPARATORS);
  // parts = [seg0, sep0, seg1, sep1, ...]。少于两段说明不是枚举，只能整条判定。
  const segments: string[] = [];
  const separators: string[] = [];
  for (const [index, part] of parts.entries()) (index % 2 === 0 ? segments : separators).push(part);
  if (segments.length < 2) return text;
  const keep = segments.map((segment) => !matchesPopulationScope(segment, "maternal"));
  if (keep.every(Boolean) || keep.every((value) => !value)) return text;
  let rebuilt = "";
  for (const [index, segment] of segments.entries()) {
    if (!keep[index]) continue;
    if (rebuilt) rebuilt += separators[index - 1] ?? "、";
    rebuilt += segment;
  }
  return rebuilt || text;
}

/** 整条风险是否只限定女性生理状态（逐项都命中受治理 maternal 组）。 */
export function riskIsMaternalScopedOnly(text: string): boolean {
  if (!text.trim()) return false;
  const segments = text.split(RX_AUDIT_ENUMERATION_SEPARATORS).filter((_, index) => index % 2 === 0);
  return segments.filter((segment) => segment.trim()).every((segment) => matchesPopulationScope(segment, "maternal"));
}

const RX_AUDIT_SEX_INAPPLICABLE_NOTE =
  "本条提示的限定人群与本例性别不符，已标注为不适用；原始规则文本见问题ID对应的审方记录。";

function applySexScopeToIssue(issue: RxAuditIssue, gender: "MALE" | "FEMALE" | "UNKNOWN"): RxAuditIssue {
  if (gender !== "MALE") return { ...issue, patientApplicability: issue.patientApplicability || "unknown" };
  const scoped = [issue.title, issue.description, ...issue.suggestions].filter((value) => value?.trim());
  // 整条只限定女性生理状态：显式标不适用，不把原文留给下游整格改写。
  if (scoped.length > 0 && scoped.every((value) => riskIsMaternalScopedOnly(value))) {
    return {
      ...issue,
      patientApplicability: "not_applicable",
      suggestions: [RX_AUDIT_SEX_INAPPLICABLE_NOTE],
    };
  }
  return {
    ...issue,
    patientApplicability: issue.patientApplicability || "unknown",
    title: sexScopedRiskText(issue.title, gender),
    description: sexScopedRiskText(issue.description, gender),
    suggestions: issue.suggestions.map((value) => sexScopedRiskText(value, gender)),
    evidence: issue.evidence.map((item) => ({
      ...item,
      ...(item.quote ? { quote: sexScopedRiskText(item.quote, gender) } : {}),
      ...(item.ruleName ? { ruleName: sexScopedRiskText(item.ruleName, gender) } : {}),
    })),
  };
}

/**
 * Preserve every vendor issue and issueId. Local post-processing is monotonic: it may upgrade an
 * incomplete or malformed provider result, but it must never lower provider risk based on free text.
 */
export function normalizeAuditOutcomeForPatient(
  outcome: Extract<RxAuditOutcome, { ok: true }>,
  patientSex?: string,
): Extract<RxAuditOutcome, { ok: true }> {
  const gender = genderCode(patientSex);
  const issues = dedupeRxAuditIssues(outcome.issues).map((issue) => applySexScopeToIssue(issue, gender));
  const containsGeneratedIssueId = issues.some((issue) => issue.issueIdGenerated);
  const issueHighestRiskLevel = issues.reduce<RxAuditRiskLevel>(
    (highest, issue) => {
      const normalized = normalizeRiskLevel(issue.riskLevel, "HIGH");
      return AUDIT_RISK_ORDER.indexOf(normalized) > AUDIT_RISK_ORDER.indexOf(highest) ? normalized : highest;
    },
    "INFO",
  );
  const issueAdjustedAuditResult: RxAuditResultCode = (containsGeneratedIssueId || (issues.length > 0 && outcome.auditResult === "PASS"))
    && outcome.auditResult !== "BLOCK"
      ? "MANUAL_REVIEW"
      : outcome.auditResult;
  const auditResult: RxAuditResultCode = outcome.degraded && issueAdjustedAuditResult === "PASS"
    ? "MANUAL_REVIEW"
    : issueAdjustedAuditResult;
  const highestRiskLevel: RxAuditRiskLevel = AUDIT_RISK_ORDER.indexOf(issueHighestRiskLevel) > AUDIT_RISK_ORDER.indexOf(outcome.highestRiskLevel)
      ? issueHighestRiskLevel
      : outcome.highestRiskLevel;
  const needManualReview = outcome.degraded || outcome.needManualReview || containsGeneratedIssueId
    || auditResult === "BLOCK" || auditResult === "MANUAL_REVIEW";
  return { ...outcome, issues, auditResult, highestRiskLevel, needManualReview };
}

export function buildLingxiRiskSection(outcome: Extract<RxAuditOutcome, { ok: true }>, patientSex?: string): string {
  const effective = normalizeAuditOutcomeForPatient(outcome, patientSex);
  // 「我方有意不下剂量」造成的告警不与真实用药风险同格（2026-08-11 线上实测）。
  // 条目本身**不删**——它仍在 outcome.issues 里、仍参与 needManualReview 与结论判定；
  // 这里只是把它从风险表挪到下面一行范围说明，避免一串必然出现、且由我方设计造成的告警
  // 挤占真实配伍禁忌的阅读位置，并顺着随访触发条件与 HIS 写回一路放大。
  const scopeIssues = effective.issues.filter((issue) => issue.scope === "declared_non_dose");
  const issues = effective.issues.filter((issue) => issue.scope !== "declared_non_dose");
  const auditResult = effective.auditResult;
  const highestRiskLevel = effective.highestRiskLevel;
  const needManualReview = effective.needManualReview;
  const lines: string[] = [];
  lines.push("## 合理用药审方");
  lines.push(
    `**审方结论**：${RESULT_LABEL[auditResult] || auditResult} ｜ **最高风险等级**：${RISK_LABEL[highestRiskLevel] || highestRiskLevel}` +
      (outcome.degraded
        ? `（审方降级：${outcome.degradeReason || "部分组件未完整返回"}；本次结果不完整，必须人工复核，不得视为完整 PASS）`
        : ""),
  );
  if (needManualReview) {
    lines.push("**处置建议**：存在需重点复核的用药问题；该结果仅作提示，不阻断流程，采纳前须由医生/药师复核。");
  }
  // 范围说明：说清哪几行按设计没有提交单次剂量、因此审方无法完成剂量适宜性审核。
  // 依据是我方自己的提交清单，属确定性事实，不伪造任何剂量。
  const scopeNotice = scopeIssues.length > 0
    ? `**剂量审核范围说明**：本次有 ${scopeIssues.length} 项中成药/西药按设计未提交单次剂量，` +
      `审方未能完成其剂量适宜性审核（涉及行号：${[...new Set(scopeIssues.flatMap((issue) => issue.relatedItemNos))].sort((a, b) => a - b).join("、") || "-"}）；` +
      "具体用量请医生按说明书与院内规范确定。该项不代表已发现用药风险。"
    : "";
  if (issues.length === 0) {
    lines.push(auditResult === "PASS"
      ? "**问题列表**：审方服务未返回明确用药问题；仍需结合医生判断。"
      : "**问题列表**：供应商返回了风险或人工复核结论，但未提供可展示的问题明细；请医生或药师人工复核。"
    );
    if (scopeNotice) lines.push(scopeNotice);
    return lines.join("\n");
  }
  if (scopeNotice) lines.push(scopeNotice);
  lines.push("");
  // 首列给医生看的是**审查规则**，不是机器标识。原先第一列直接输出灵犀返回的 issueId（UUID），
  // 一串 e0c4256e-27f5-49a6-… 占据整张临床表格最显眼的位置，而真正有信息量的风险类型被挤到后面。
  // UUID 仍然保留在末列供后台对账与工单引用，只是不再抢占阅读入口。
  lines.push("| 审查规则 | 提示强度 | 风险类型 | 涉及药味(行号) | 风险说明 | 证据/依据 | 医生动作 | 问题ID |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const issue of issues) {
    const tag = severityTag(String(issue.riskLevel));
    const rows = issue.relatedItemNos.length ? issue.relatedItemNos.join("、") : "-";
    const evidence = issue.evidence.map((ev) => ev.quote || ev.sourceName || ev.ruleName).filter(Boolean).slice(0, 2).join("；") || "规则审查";
    // ruleName 是可选字段，逐级兜底到问题类型，绝不回落到 UUID——那正是本次要修掉的东西。
    const ruleLabel = issue.evidence.map((ev) => ev.ruleName).find((name) => Boolean(name && name.trim())) ||
      issue.issueType || "规则审查";
    const action = issue.suggestions[0] || (issue.action === "BLOCK" ? "建议调整该药味后复核" : "请医生复核");
    const cell = (value: string) => value
      .replace(/[\r\n]+/g, " ")
      .replace(/\|/g, "／")
      .replace(/[\[\]()<>*_`]/g, (char) => `\\${char}`)
      .trim();
    const issueId = issue.issueId || stableAuditIssueId([issue.issueType, issue.title, issue.description]);
    lines.push(`| ${cell(ruleLabel)} | ${tag} | ${cell(issue.title)} | ${rows} | ${cell(issue.description)} | ${cell(evidence)} | ${cell(action)} | ${cell(issueId)} |`);
  }
  return lines.join("\n");
}
