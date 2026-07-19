// LingXi (灵犀) unified rational-drug-use audit client.
//
// Wraps `POST /api/v1/rational-drug-use` (operation=PRESCRIPTION_AUDIT) — the vendor 合理用药 审方
// engine — as the sole prescription-safety reviewer for the post-prescription audit path. Callers must
// expose any failure/timeout/missing herb items as a visible manual-review advisory. Audit is not a
// workflow lock, but callers must never interpret an unavailable audit as "no risk". The Markdown compatibility path below only recovers M04
// herb rows into LingXi items[] when reasoningV2 was not persisted; it does not perform local risk review.
//
// PHI: only sanitized free text is sent; patient name is never forwarded (a fixed 匿名患者 is used).

import { currentVitalsSummary, sanitizeFreeTextForExternalClinicalService } from "./diagnosis-safety";
import { diagnoseReasoningFromState, parseReasoningV2, prescribeReasoningFromState } from "./diagnosis-parse";
import { ageValue, type CaseState } from "./diagnosis-types";
import { normalizeLingxiDecision, normalizeRiskLevel, type RxAuditResultCode, type RxAuditRiskLevel } from "./rxaudit-normalize";
import { prescriptionRegimenFromDecoction, prescriptionRegimenSummary } from "./prescription-regimen-contract";
import { affirmedAllergyText, affirmedClinicalText, affirmedCurrentMedicationText, medicationContinuationOnly, medicationNameFromEventText } from "./clinical-polarity";
import { UpstreamResponseTooLargeError, readResponseTextLimited } from "./http-response-limit";
import {
  currentMedicationSummaryFromSemanticExtraction,
  currentMedicationsFromSemanticExtraction,
  extractMedicationEventsWithModel,
  medicationSemanticConsistencyReasons,
  type MedicationSemanticExtraction,
} from "./medication-event-extractor";
import { findTcmHerbPairIncompatibilities, getTcmHerbDoseLimit } from "./tcm-knowledge";

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
const DEFAULT_AUDIT_TOTAL_TIMEOUT_MS = 15_000;
const DEFAULT_AUDIT_ATTEMPT_TIMEOUT_MS = 12_000;
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

// Plain HTTP is restricted to the same machine. Remote audit traffic must use HTTPS because the
// request contains a bearer credential and a clinically meaningful case summary.
function insecureHttpHostAllowed(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:") return false;
    return ["localhost", "127.0.0.1", "::1", "[::1]", "host.docker.internal"].includes(url.hostname);
  } catch {
    return false;
  }
}

export function getRxAuditConfig() {
  const baseUrl = (process.env.RXAI_AUDIT_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/$/, "");
  const token = (process.env.RXAI_AUDIT_TOKEN || "").trim();
  const tenantId = (process.env.RXAI_AUDIT_TENANT_ID || DEFAULT_TENANT).trim();
  const systemCode = (process.env.RXAI_AUDIT_SYSTEM_CODE || tenantId).trim();
  const configured = Boolean(token && baseUrl);
  const allowInsecureHttp = process.env.RXAI_AUDIT_ALLOW_INSECURE_HTTP === "true";
  // The production exception is intentionally limited to a same-host sidecar. Never send the
  // audit token or sanitized clinical summary over plain HTTP to a remote host.
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
  reason: "ok" | "not_configured" | "insecure_transport" | "timeout" | "network_error" | "upstream_5xx";
  upstreamStatus?: number;
}>;

/**
 * Connectivity-only release probe. It deliberately sends no patient or prescription payload. Any
 * non-5xx HTTP response proves that the configured sidecar/gateway is reachable; the live positive
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
      method: "OPTIONS",
      headers: {
        authorization: `Bearer ${cfg.token}`,
        "x-tenant-id": cfg.tenantId,
      },
      signal: AbortSignal.timeout(Math.min(getRxAuditAttemptTimeoutMs(), 5_000)),
      cache: "no-store",
    });
    const latencyMs = Date.now() - startedAt;
    return response.status >= 500
      ? { ok: false, checkedAt, latencyMs, reason: "upstream_5xx", upstreamStatus: response.status }
      : { ok: true, checkedAt, latencyMs, reason: "ok", upstreamStatus: response.status };
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

function normalizedMedicationIdentity(value: string): string {
  let identity = medicationNameFromEventText(value) || value;
  identity = identity.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const dosageForms = ["缓释胶囊", "肠溶胶囊", "软胶囊", "薄膜衣片", "糖衣片", "泡腾片", "口腔崩解片", "缓释片", "控释片", "肠溶片", "分散片", "咀嚼片", "舌下片", "胶囊", "片剂", "颗粒剂", "片", "颗粒"];
  let previous = "";
  while (identity && identity !== previous) {
    previous = identity;
    const suffix = dosageForms.find((item) => identity.endsWith(item) && identity.length > item.length + 1);
    if (suffix) identity = identity.slice(0, -suffix.length);
  }
  const controlledAliases: Record<string, string> = {
    盐酸二甲双胍: "二甲双胍",
    华法林钠: "华法林",
    硫酸氢氯吡格雷: "氯吡格雷",
    枸橼酸西地那非: "西地那非",
  };
  return controlledAliases[identity] || identity;
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
    if (/^(?:未|没有|从未|否认|不曾|并未)\s*(?:服用|口服|使用|吃|用)(?!.*(?:停用|停服|停药))/.test(segment)) continue;
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

/** Run the same authoritative medication timeline extraction for M05, edited re-audit, and HIS. */
export async function extractMedicationSemanticsForAudit(
  state: CaseState,
  requestSignal?: AbortSignal,
): Promise<MedicationSemanticExtraction> {
  const context = buildMedicationExtractionContext(state);
  const extraction = await extractMedicationEventsWithModel(context.text, requestSignal);
  return verifyMedicationSemanticCoverage(context.text, extraction, context.truncated);
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

export function buildAuditItemsFromHerbs(state: CaseState, candidateIndex?: number): Array<Record<string, unknown>> {
  const candidate = candidateFromState(state, candidateIndex);
  if (!candidate) return [];
  return candidate.herbs
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
  const advisories: RxAuditInputAdvisory[] = buildAuditItems(state, candidateIndex).flatMap((item) => {
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
  const consultationNo = "cdss-anonymous";

  const patient: Record<string, unknown> = {
    name: "匿名患者",
    gender: genderCode(authoritativeClinicalField(state, "sex", state.patient.sex)),
  };
  const age = authoritativeAge(state);
  if (age != null) patient.age = age;
  if (chiefComplaint) patient.chief_complaint = chiefComplaint;
  const presentIllness = affirmedClinicalText(clean(authoritativeClinicalField(state, "xianbingshi")));
  if (presentIllness) patient.present_illness = presentIllness;
  const pastHistory = affirmedClinicalText(clean(authoritativeClinicalField(state, "jiwangshi", state.pastHistory)));
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
      title: title || description || "用药风险提示",
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
  return findTcmHerbPairIncompatibilities(candidate.herbs.map((herb) => herb.name)).map((conflict) => ({
    issueId: stableAuditIssueId(["local-tcm-herb-pair", conflict.leftDrug, conflict.rightDrug]),
    riskLevel: "HIGH",
    ruleLevel: "LOCAL_DETERMINISTIC",
    issueType: "TCM_HERB_PAIR_INCOMPATIBILITY",
    title: `${conflict.leftDrug}—${conflict.rightDrug}高风险配伍`,
    description: `命中${conflict.category || "高风险配伍"}，请医生或药师重点复核。`,
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
      return `- **${issue.title.replace(/高风险配伍$/, "")}**：${issue.description}依据：${basis}。本提示不阻断诊疗流程。`;
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
};

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
  const itemCount = buildAuditData(state, candidateIndex)?.itemCount ?? 0;
  if (itemCount === 0) {
    return {
      medicationExtraction: { source: "not_needed", events: [], unresolvedReferences: [], needsManualReview: false },
      providerAudit: { ok: false, source: "unavailable", reason: "no_prescription_items", itemCount: 0 },
      timeoutMs,
      timedOut: false,
    };
  }
  if (requestSignal?.aborted) {
    return {
      medicationExtraction: unavailableMedicationExtraction("rxaudit_request_aborted"),
      providerAudit: { ok: false, source: "unavailable", reason: "rxaudit_request_aborted", itemCount },
      timeoutMs,
      timedOut: false,
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
    };
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
      };
    }
    return { medicationExtraction, providerAudit, timeoutMs, timedOut: false };
  } finally {
    clearTimeout(timeout);
    requestSignal?.removeEventListener("abort", abortFromRequest);
  }
}

/** Consistent advisory copy for every route when no complete provider result is available. */
export function buildUnavailableRxAuditSection(reason: string): string {
  const noItems = reason === "no_prescription_items";
  const status = noItems
    ? "当前候选方药尚未形成可审查的完整药味清单，本次未发起自动审方。"
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
    if (remainingMs < MIN_RETRY_ATTEMPT_BUDGET_MS) {
      return { ok: false, source: "unavailable", reason: "rxaudit_total_timeout", itemCount: built.itemCount };
    }
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
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.token}`,
          "X-Tenant-Id": cfg.tenantId,
        },
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
      return { ok: false, source: "unavailable", reason: aborted ? "rxaudit_timeout" : "rxaudit_network_error", itemCount: built.itemCount };
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
          ? "rxaudit_timeout"
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
    const issues = dedupeRxAuditIssues(normalizeIssues(d.issues));
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
 * Preserve every vendor issue and issueId. Local post-processing is monotonic: it may upgrade an
 * incomplete or malformed provider result, but it must never lower provider risk based on free text.
 * Patient applicability can only be consumed once the provider exposes a machine-readable contract.
 */
export function normalizeAuditOutcomeForPatient(
  outcome: Extract<RxAuditOutcome, { ok: true }>,
  patientSex?: string,
): Extract<RxAuditOutcome, { ok: true }> {
  // Sex is intentionally not used until Lingxi exposes a machine-readable applicability contract.
  // Keeping the parameter in the boundary prevents callers from inventing free-text downgrades.
  void patientSex;
  const issues = dedupeRxAuditIssues(outcome.issues).map((issue) => ({
    ...issue,
    patientApplicability: issue.patientApplicability || "unknown",
  }));
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
  const issues = effective.issues;
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
  if (issues.length === 0) {
    lines.push(auditResult === "PASS"
      ? "**问题列表**：审方服务未返回明确用药问题；仍需结合医生判断。"
      : "**问题列表**：供应商返回了风险或人工复核结论，但未提供可展示的问题明细；请医生或药师人工复核。"
    );
    return lines.join("\n");
  }
  lines.push("");
  lines.push("| 问题ID | 提示强度 | 风险类型 | 涉及药味(行号) | 风险说明 | 证据/依据 | 医生动作 |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const issue of issues) {
    const tag = severityTag(String(issue.riskLevel));
    const rows = issue.relatedItemNos.length ? issue.relatedItemNos.join("、") : "-";
    const evidence = issue.evidence.map((ev) => ev.quote || ev.sourceName || ev.ruleName).filter(Boolean).slice(0, 2).join("；") || "规则审查";
    const action = issue.suggestions[0] || (issue.action === "BLOCK" ? "建议调整该药味后复核" : "请医生复核");
    const cell = (value: string) => value
      .replace(/[\r\n]+/g, " ")
      .replace(/\|/g, "／")
      .replace(/[\[\]()<>*_`]/g, (char) => `\\${char}`)
      .trim();
    lines.push(`| ${cell(issue.issueId || stableAuditIssueId([issue.issueType, issue.title, issue.description]))} | ${tag} | ${cell(issue.title)} | ${rows} | ${cell(issue.description)} | ${cell(evidence)} | ${cell(action)} |`);
  }
  return lines.join("\n");
}
