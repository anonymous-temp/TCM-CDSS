import type { CaseState } from "./diagnosis-types";
import { diagnoseReasoningFromState, prescribeReasoningFromState } from "./diagnosis-parse";
import { sanitizeFreeTextForExternalClinicalService } from "./diagnosis-safety";
import { UpstreamResponseTooLargeError, readResponseTextLimited } from "./http-response-limit";
import { cancelResponseBody } from "./http-response-lifecycle";
import { createHash } from "node:crypto";
import { matchingMedicineClinicalProblemTerms } from "./medicine-clinical-concepts";

const EVIMED_BASE_URL = (process.env.EVIMED_EVIDENCE_BASE_URL || "https://www.evimed.com/api-evimed").trim().replace(/\/$/, "");
const GUIDE_API_URL = process.env.EVIMED_GUIDE_API_URL ||
  `${EVIMED_BASE_URL}/medicine-api/ai-api/review/api/guide`;
// The supplied EviMed contract documents only the guide endpoint above. Other source adapters are
// explicit because their paths were verified against the live service rather than the supplied file.
const INSTRUCTION_API_URL = (process.env.EVIMED_INSTRUCTION_API_URL || "").trim();
const LITERATURE_API_URL = (process.env.EVIMED_LITERATURE_API_URL || "").trim();
const EVIMED_EVIDENCE_TIMEOUT_MS = (() => {
  const value = Number(process.env.EVIMED_EVIDENCE_TIMEOUT_MS || 12000);
  return Number.isFinite(value) && value >= 3000 && value <= 30000 ? Math.round(value) : 12000;
})();
const EVIMED_EVIDENCE_RETRY_ATTEMPTS = (() => {
  const value = Number(process.env.EVIMED_EVIDENCE_RETRY_ATTEMPTS ?? 3);
  return Number.isFinite(value) && value >= 0 && value <= 5 ? Math.round(value) : 3;
})();
const EVIMED_MAX_RESPONSE_BYTES = 2_000_000;

export type EvidenceSourceKind = "guide" | "instruction" | "literature";

export type GuideItem = {
  title?: string;
  year?: string;
  publisher?: string;
  summary?: string;
  publicationDate?: string;
  fullText?: string;
};

type GuideResponse = {
  code?: number;
  msg?: string;
  data?: {
    total?: number;
    list?: GuideItem[];
  };
};

export type ExternalEvidenceItem = {
  sourceKind: EvidenceSourceKind;
  title: string;
  publisher?: string;
  year?: string;
  url?: string;
  identifier?: string;
  summary?: string;
  medicineName?: string;
  specification?: string;
  indication?: string;
  contraindication?: string;
  specialPopulation?: string;
  interaction?: string;
  usage?: string;
  fingerprint?: string;
};

export type GuideEvidenceResult = {
  ok: boolean;
  reason: "ok" | "not_configured" | "empty_query" | "timeout" | "upstream_error" | "business_error" | "invalid_response" | "no_hits";
  query: string;
  list: ExternalEvidenceItem[];
  upstreamStatus?: number;
  message?: string;
};

const SOURCE_CONFIG: Record<EvidenceSourceKind, {
  label: string;
  endpoint: string;
  envKey: string;
  idPrefix: string;
  requiredFor: string;
  officiallyDocumented: boolean;
  requiredForRelease: boolean;
}> = {
  guide: {
    label: "EviMed 指南/共识检索",
    endpoint: GUIDE_API_URL,
    envKey: "EVIMED_GUIDE_API_KEY",
    idPrefix: "EVID-GUIDE",
    requiredFor: "诊断、治疗原则、随访与转诊依据",
    officiallyDocumented: true,
    requiredForRelease: true,
  },
  instruction: {
    label: "EviMed 说明书检索",
    endpoint: INSTRUCTION_API_URL,
    envKey: "EVIMED_INSTRUCTION_API_KEY",
    idPrefix: "EVID-INST",
    requiredFor: "西药/中成药适应证、禁忌、注意事项和用法用量",
    officiallyDocumented: false,
    requiredForRelease: true,
  },
  literature: {
    label: "EviMed 文献/全文证据检索",
    endpoint: LITERATURE_API_URL,
    envKey: "EVIMED_LITERATURE_API_KEY",
    idPrefix: "EVID-PAPER",
    requiredFor: "临床研究、系统评价、病例/疗效证据补充",
    officiallyDocumented: false,
    requiredForRelease: true,
  },
};

function isLocalHttpEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return url.protocol === "http:" && /^(localhost|127\.0\.0\.1|::1|\[::1\])$/.test(url.hostname);
  } catch {
    return false;
  }
}

function endpointTransportAllowed(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    const trustedHost = url.hostname === "evimed.com" || url.hostname.endsWith(".evimed.com");
    if (url.protocol === "https:" && trustedHost && !url.username && !url.password) return true;
  } catch {
    return false;
  }
  return process.env.NODE_ENV !== "production" && isLocalHttpEndpoint(endpoint);
}

function getEvimedEvidenceApiKey(kind?: EvidenceSourceKind): string {
  const sourceKey = kind ? process.env[SOURCE_CONFIG[kind].envKey] : "";
  if (kind && kind !== "guide") return (sourceKey || "").trim();
  return (
    sourceKey ||
    process.env.EVIMED_API_KEY ||
    process.env.EVIMED_EVIDENCE_API_KEY ||
    ""
  ).trim();
}

function evidenceSourceConfigured(kind: EvidenceSourceKind): boolean {
  const endpoint = SOURCE_CONFIG[kind].endpoint;
  return Boolean(endpoint && getEvimedEvidenceApiKey(kind) && endpointTransportAllowed(endpoint));
}

function stringifyClinicalValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function scrubQuery(text: string, explicitNames: string[] = []): string {
  return sanitizeFreeTextForExternalClinicalService(text, explicitNames)
    .replace(/姓名\s*[:：]?\s*[^，；。\n]+/g, "")
    .replace(/患者\s*[\u4e00-\u9fa5]{2,4}/g, "患者")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function firstUrl(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && /^https?:\/\//i.test(value.trim())) return value.trim();
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      const url = firstUrl(record.url, record.h5_evimed, record.evimed, record.pc, record.h5);
      if (url) return url;
    }
  }
  return undefined;
}

function traceableHttpsUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    if (/^(?:localhost|127\.0\.0\.1|::1|\[::1\])$/.test(url.hostname) || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(url.hostname)) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function normalizedEvidenceYear(value: string | undefined): string | undefined {
  const year = value?.match(/(?:19|20)\d{2}/)?.[0];
  return year && Number(year) <= new Date().getFullYear() + 1 ? year : undefined;
}

function traceableIdentifier(raw: Record<string, unknown>): string | undefined {
  const doi = firstString(raw.doi, raw.DOI)?.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").trim();
  if (doi && /^10\.\d{4,9}\/\S+$/i.test(doi)) return `DOI:${doi}`;
  const pmid = firstString(raw.pmid, raw.PMID)?.match(/\d{6,10}/)?.[0];
  if (pmid) return `PMID:${pmid}`;
  const approval = firstString(raw.approvalNumber, raw.approvalNo, raw.approval_number, raw.registerNo, raw.registrationNo);
  if (approval && /(?:国药准字|注册证号|批准文号|H\d{6,}|Z\d{6,})/i.test(approval)) return approval.trim().slice(0, 100);
  return undefined;
}

function arrayFromUnknown(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)));
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of ["list", "items", "records", "results", "data"]) {
      const nested = arrayFromUnknown(record[key]);
      if (nested.length) return nested;
    }
  }
  return [];
}

function normalizeEvidenceItem(kind: EvidenceSourceKind, raw: Record<string, unknown>): ExternalEvidenceItem {
  const title = firstString(
    raw.title,
    raw.name,
    raw.guideName,
    raw.literatureTitle,
    raw.paperTitle,
    raw.drugName,
    raw.productName,
    raw.genericName,
    raw.genericNames,
    raw.instructionTitle,
    raw.officialTitle,
    raw.briefTitle,
  ) || "未命名证据";
  const publisher = firstString(raw.publisher, raw.organization, raw.sourceName, raw.journal, raw.manufacturer, raw.enterpriseName, raw.approvalHolder);
  const year = normalizedEvidenceYear(firstString(raw.year, raw.publicationDate, raw.publishDate, raw.date, raw.revisionDate));
  const summary = firstString(
    raw.summary,
    raw.abstract,
    raw.quote,
    raw.content,
    raw.fullText,
    raw.text,
    raw.indication,
    raw.contraindication,
    raw.attentions,
    raw.adverseReaction,
  )?.replace(/\s+/g, " ").slice(0, 320);
  const url = traceableHttpsUrl(firstUrl(raw.url, raw.pdfUrl, raw.sourceUrl, raw.link, raw.links));
  const identifier = traceableIdentifier(raw);
  const medicineName = kind === "instruction"
    ? firstString(raw.genericNames, raw.genericName, raw.drugName, raw.productName, raw.title, raw.name)
    : undefined;
  const specification = kind === "instruction"
    ? firstString(raw.specifications, raw.specification, raw.spec, raw.dosageForm)
    : undefined;
  const indication = kind === "instruction"
    ? firstString(raw.indication, raw.indications, raw.pharmacologyAndIndication, raw.summary)
    : undefined;
  const contraindication = kind === "instruction"
    ? firstString(raw.contraindications, raw.contraindication, raw.warningsMarks, raw.boxedWarning, raw.precautions)
    : undefined;
  const specialPopulation = kind === "instruction"
    ? [
        firstString(raw.useInPregLact, raw.pregnancyAndLactation),
        firstString(raw.useInChildren, raw.pediatricUse),
        firstString(raw.useInElderly, raw.geriatricUse),
      ].filter(Boolean).join("；") || undefined
    : undefined;
  const interaction = kind === "instruction" ? firstString(raw.drugInteractions, raw.interactions) : undefined;
  const usage = kind === "instruction"
    ? firstString(raw.dosageAndAdministration, raw.usageAndDosage, raw.usage, raw.dosage)
    : undefined;
  const fingerprint = kind === "instruction" && medicineName
    ? `sha256:${createHash("sha256").update(JSON.stringify({
        medicineName,
        publisher,
        url,
        identifier,
        specification,
        indication,
        contraindication,
        specialPopulation,
        interaction,
        usage,
      })).digest("hex")}`
    : undefined;
  return {
    sourceKind: kind,
    title,
    ...(publisher ? { publisher } : {}),
    ...(year ? { year } : {}),
    ...(url ? { url } : {}),
    ...(identifier ? { identifier } : {}),
    ...(summary ? { summary } : {}),
    ...(medicineName ? { medicineName } : {}),
    ...(specification ? { specification } : {}),
    ...(indication ? { indication } : {}),
    ...(contraindication ? { contraindication } : {}),
    ...(specialPopulation ? { specialPopulation } : {}),
    ...(interaction ? { interaction } : {}),
    ...(usage ? { usage } : {}),
    ...(fingerprint ? { fingerprint } : {}),
  };
}

function isTraceableExternalEvidence(item: ExternalEvidenceItem): boolean {
  const title = item.title.trim();
  if (title.length < 2 || /^(?:未命名证据|说明书\/证据文本|证据文本|检索结果|未知)$/.test(title)) return false;
  const hasReferenceMetadata = Boolean(item.publisher?.trim() || item.year || item.url || item.identifier);
  if (!hasReferenceMetadata) return false;
  if (item.sourceKind === "instruction") {
    return Boolean(item.publisher?.trim() || item.url || item.identifier);
  }
  return true;
}

export function normalizeExternalEvidenceResponse(kind: EvidenceSourceKind, json: unknown): ExternalEvidenceItem[] {
  if (typeof json === "string" && json.trim()) return [];
  const record = json && typeof json === "object" && !Array.isArray(json) ? json as Record<string, unknown> : {};
  const data = record.data ?? record.result ?? record;
  if (typeof data === "string" && data.trim()) return [];
  const dataRecord = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : undefined;
  const instructionBuckets = ["nmpa", "fda", "ema", "pmda"].flatMap((key) => arrayFromUnknown(dataRecord?.[key]));
  const records = kind === "instruction"
    ? (instructionBuckets.length > 0 ? instructionBuckets : arrayFromUnknown(data))
    : kind === "literature"
      ? ["paper", "clinicalTrials"].flatMap((key) => arrayFromUnknown(dataRecord?.[key]))
      : arrayFromUnknown(data);
  return records
    .map((item) => normalizeEvidenceItem(kind, item))
    .filter(isTraceableExternalEvidence);
}

export function constrainExternalEvidenceResults(
  kind: EvidenceSourceKind,
  items: readonly ExternalEvidenceItem[],
  opts?: { count?: number; startYear?: number },
): ExternalEvidenceItem[] {
  const currentYear = new Date().getFullYear();
  const requestedStartYear = Number(opts?.startYear);
  const startYear = Number.isInteger(requestedStartYear) && requestedStartYear >= 1900 && requestedStartYear <= currentYear + 1
    ? requestedStartYear
    : undefined;
  const requestedCount = Number(opts?.count);
  const count = Number.isInteger(requestedCount) && requestedCount >= 1 && requestedCount <= 20
    ? requestedCount
    : 3;
  const dateConstrained = startYear != null && (kind === "guide" || kind === "literature")
    ? items.filter((item) => item.year != null && Number(item.year) >= startYear)
    : [...items];
  // The literature adapter only accepts {query}; enforce every caller-owned retrieval constraint
  // after normalization so an upstream that ignores count/year cannot silently widen model context.
  return dateConstrained.slice(0, count);
}

function extractPrescriptionTerms(caseState: CaseState): string {
  const prescribeReasoning = prescribeReasoningFromState(caseState) || caseState.reasoningV2;
  const diagnoseReasoning = diagnoseReasoningFromState(caseState) || caseState.reasoningV2;
  const structuredHerbs = prescribeReasoning?.formula?.candidates
    ?.flatMap((candidate) => candidate.herbs.map((herb) => herb.name))
    .filter(Boolean)
    .slice(0, 12)
    .join(" ");
  if (structuredHerbs) return structuredHerbs;
  const candidateDirections = [
    diagnoseReasoning?.overview?.recommendedFormulaDirection,
    diagnoseReasoning?.overview?.overallTherapy,
    caseState.diagnosis?.match(/(?:推荐主方|方义方向|方药方向|治疗候选|治法框架|总治法)[\s\S]{0,180}/)?.[0],
    caseState.diagnosis?.match(/(?:归脾汤|酸枣仁汤|温胆汤|逍遥散|柴胡疏肝散|二陈汤|半夏泻心汤|补中益气汤|天王补心丹|天麻钩藤饮|六味地黄丸|知柏地黄丸|藿香正气散|三仁汤|银翘散|桑菊饮)[\s\S]{0,80}/)?.[0],
  ].filter(Boolean).join(" ");
  if (candidateDirections.trim()) return candidateDirections.trim().slice(0, 160);
  const text = caseState.prescription || "";
  const matches = Array.from(text.matchAll(/[\u4e00-\u9fa5]{2,8}\s*(?:\d+(?:\.\d+)?\s*(?:g|克|mg|毫克)|先煎|后下|包煎|冲服)/g))
    .map((match) => match[0].replace(/\s*(?:\d+(?:\.\d+)?\s*(?:g|克|mg|毫克)|先煎|后下|包煎|冲服).*/, ""))
    .filter(Boolean)
    .slice(0, 12)
    .join(" ");
  return matches;
}

function evidenceSymptomTerms(caseState: CaseState): string {
  const hisFields = caseState.hisRecord?.fields;
  const symptomRecord = caseState.symptoms && typeof caseState.symptoms === "object" ? caseState.symptoms : {};
  return [
    hisFields?.zhushu || caseState.chiefComplaint,
    hisFields?.xianbingshi || stringifyClinicalValue(symptomRecord.presentHistory),
    hisFields?.tcmDetail || stringifyClinicalValue(symptomRecord.tcmDetail),
    hisFields?.tcmTongue || caseState.tongue,
    hisFields?.tcmPulse || caseState.pulse,
    caseState.diagnosis?.match(/现代医学风险\/需排除方向[\s\S]{0,240}/)?.[0],
    caseState.diagnosis?.match(/中医证候诊断[\s\S]{0,220}/)?.[0],
  ].filter(Boolean).join(" ");
}

function evidenceQuerySuffix(caseState: CaseState, stage: "diagnose" | "prescribe" | "assess", kind: EvidenceSourceKind): string {
  const prescriptionTerms = extractPrescriptionTerms(caseState);
  const suffixMap: Record<EvidenceSourceKind, string> = {
    guide: stage === "diagnose" ? "诊断 指南 共识 鉴别诊断" : stage === "prescribe" ? "治疗 用药 指南 共识 中医" : "随访 风险 转诊 用药安全 指南",
    instruction: `${prescriptionTerms} 中成药 西药 说明书 适应证 禁忌 用法用量`,
    literature: stage === "diagnose" ? "诊断 临床研究 系统评价 文献 证据" : stage === "prescribe" ? `${prescriptionTerms} 治疗 临床研究 文献 系统评价 中医` : "随访 安全性 不良反应 文献 证据",
  };
  return suffixMap[kind];
}

function evidenceQueryExplicitNames(caseState: CaseState): string[] {
  const hisFields = caseState.hisRecord?.fields;
  return [caseState.patient.name, hisFields?.patientName]
    .filter((value): value is string => Boolean(value?.trim()));
}

export function buildEvidenceQuery(caseState: CaseState, stage: "diagnose" | "prescribe" | "assess", kind: EvidenceSourceKind): string {
  const symptomTerms = evidenceSymptomTerms(caseState);
  const suffix = evidenceQuerySuffix(caseState, stage, kind);

  // 检索意图必须放在病例叙述之前：scrubQuery 最终按 200 字截断，长现病史置前会把
  // “诊断 指南 共识”或“说明书 适应证”整个挤掉。线上咳嗽例因此 guide=0，健康探针却绿。
  // 先放任务词，再补病例事实，既保留临床主题，也保证供应商看到检索类型。
  return scrubQuery(`${suffix} ${symptomTerms}`, evidenceQueryExplicitNames(caseState));
}

export function buildEvidenceFallbackQueries(
  caseState: CaseState,
  stage: "diagnose" | "prescribe" | "assess",
  kind: EvidenceSourceKind,
): string[] {
  if (kind === "instruction") return [];
  const caseText = evidenceSymptomTerms(caseState);
  const suffix = evidenceQuerySuffix(caseState, stage, kind);
  const explicitNames = evidenceQueryExplicitNames(caseState);
  // 受治理问题表按“宽泛主诉 → 更具体问题”组织；倒序让更具体的当前问题先检索。
  // 例如“感冒后干咳”同时命中感冒与咳嗽，先查咳嗽才能避免把胃肠型感冒共识置顶。
  return [...new Set(matchingMedicineClinicalProblemTerms(caseText).reverse()
    .map((term) => scrubQuery(`${term} ${suffix}`, explicitNames))
    .filter(Boolean))];
}

export function buildGuideQuery(caseState: CaseState, stage: "diagnose" | "prescribe" | "assess"): string {
  return buildEvidenceQuery(caseState, stage, "guide");
}

function requestPayload(kind: EvidenceSourceKind, safeQuery: string, opts?: { count?: number; startYear?: number }) {
  // The verified EviMed evidence-search contract accepts only {query}; sending the guide-style
  // count/startYear fields makes the production endpoint return HTTP 500.
  if (kind === "literature") return { query: safeQuery };
  const count = opts?.count ?? 3;
  const payload: Record<string, unknown> = {
    query: safeQuery,
    count,
  };
  if (opts?.startYear && kind === "guide") payload.startYear = opts.startYear;
  return payload;
}

export async function fetchExternalEvidence(kind: EvidenceSourceKind, query: string, opts?: { count?: number; startYear?: number }): Promise<GuideEvidenceResult> {
  const apiKey = getEvimedEvidenceApiKey(kind);
  const safeQuery = scrubQuery(query);
  const endpoint = SOURCE_CONFIG[kind].endpoint;
  if (!endpoint) {
    return {
      ok: false,
      reason: "not_configured",
      query: safeQuery,
      list: [],
      message: `${SOURCE_CONFIG[kind].label} has no documented endpoint configured`,
    };
  }
  if (!endpointTransportAllowed(endpoint)) {
    return {
      ok: false,
      reason: "not_configured",
      query: safeQuery,
      list: [],
      message: `${SOURCE_CONFIG[kind].label} endpoint must use HTTPS in production`,
    };
  }
  if (!apiKey) return { ok: false, reason: "not_configured", query: safeQuery, list: [], message: `${SOURCE_CONFIG[kind].label} API key not configured` };
  if (!safeQuery) return { ok: false, reason: "empty_query", query: safeQuery, list: [], message: "query is empty" };

  for (let attempt = 0; attempt <= EVIMED_EVIDENCE_RETRY_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), EVIMED_EVIDENCE_TIMEOUT_MS);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(requestPayload(kind, safeQuery, opts)),
        signal: controller.signal,
        cache: "no-store",
      });
      const retryableStatus = res.status === 429 || res.status >= 500;
      if (!res.ok) {
        await cancelResponseBody(res);
        if (retryableStatus && attempt < EVIMED_EVIDENCE_RETRY_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** attempt)));
          continue;
        }
        return { ok: false, reason: "upstream_error", query: safeQuery, list: [], upstreamStatus: res.status };
      }
      const contentType = res.headers.get("content-type") || "";
      const raw = await readResponseTextLimited(res, EVIMED_MAX_RESPONSE_BYTES);
      let json: GuideResponse | string = raw;
      if (contentType.includes("application/json")) {
        try {
          json = JSON.parse(raw) as GuideResponse;
        } catch {
          return { ok: false, reason: "invalid_response", query: safeQuery, list: [] };
        }
      }
      if (json && typeof json === "object" && !Array.isArray(json) && "code" in json && json.code && json.code !== 200) {
        const businessCode = Number(json.code);
        if ((businessCode === 429 || businessCode >= 500) && attempt < EVIMED_EVIDENCE_RETRY_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** attempt)));
          continue;
        }
        return { ok: false, reason: "business_error", query: safeQuery, list: [], message: json.msg, upstreamStatus: Number.isFinite(businessCode) ? businessCode : undefined };
      }
      const normalizedList = normalizeExternalEvidenceResponse(kind, json);
      const list = constrainExternalEvidenceResults(kind, normalizedList, opts);
      if (normalizedList.length === 0 && json && typeof json === "object" && !Array.isArray(json) && !("data" in json)) {
        return { ok: false, reason: "invalid_response", query: safeQuery, list: [] };
      }
      return list.length === 0
        ? { ok: true, reason: "no_hits", query: safeQuery, list: [] }
        : { ok: true, reason: "ok", query: safeQuery, list };
    } catch (error) {
      if (error instanceof UpstreamResponseTooLargeError) {
        return { ok: false, reason: "invalid_response", query: safeQuery, list: [], message: "upstream response too large" };
      }
      const reason = error instanceof Error && error.name === "AbortError" ? "timeout" : "upstream_error";
      if (attempt < EVIMED_EVIDENCE_RETRY_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** attempt)));
        continue;
      }
      return { ok: false, reason, query: safeQuery, list: [] };
    } finally {
      clearTimeout(timeout);
    }
  }
  return { ok: false, reason: "upstream_error", query: safeQuery, list: [] };
}

export function fetchGuideEvidence(query: string, opts?: { count?: number; startYear?: number }): Promise<GuideEvidenceResult> {
  return fetchExternalEvidence("guide", query, opts);
}

/** One instruction result must stay on one line so ID, medicine, indication and fingerprint remain atomic. */
export function formatInstructionEvidenceRecord(item: ExternalEvidenceItem, evidenceId: string): string {
  const atom = (value: string | undefined) => (value || "")
    .normalize("NFKC")
    .replace(/[\r\n\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const instructionFields = [
    `药名：${atom(item.medicineName || item.title)}`,
    item.publisher ? `生产企业：${atom(item.publisher)}` : "",
    item.specification ? `规格：${atom(item.specification)}` : "",
    item.indication || item.summary ? `适应证：${atom(item.indication || item.summary)}` : "",
    item.usage ? `用法用量：${atom(item.usage)}` : "用法用量：本次检索摘要未返回完整字段，不得生成剂量医嘱",
    item.contraindication ? `禁忌/注意：${atom(item.contraindication)}` : "",
    item.specialPopulation ? `特殊人群：${atom(item.specialPopulation)}` : "",
    item.interaction ? `相互作用：${atom(item.interaction)}` : "",
    item.fingerprint ? `条目指纹：${atom(item.fingerprint)}` : "",
    item.url ? `URL:${atom(item.url)}` : "",
  ].filter(Boolean);
  return `[${atom(evidenceId)}] ${instructionFields.join("｜")}`;
}

export async function buildGuideEvidenceContext(
  caseState: CaseState,
  stage: "diagnose" | "prescribe" | "assess",
): Promise<string> {
  return buildSingleEvidenceSection("guide", caseState, stage);
}

async function buildSingleEvidenceSection(
  kind: EvidenceSourceKind,
  caseState: CaseState,
  stage: "diagnose" | "prescribe" | "assess",
): Promise<string> {
  const query = buildEvidenceQuery(caseState, stage, kind);
  const options = {
    count: kind === "guide" ? 8 : kind === "literature" ? 5 : 6,
    startYear: kind === "guide" || kind === "literature" ? 2018 : undefined,
  };
  let result = await fetchExternalEvidence(kind, query, options);
  let usedQuery = query;
  if (result.ok && result.reason === "no_hits" && kind !== "instruction") {
    for (const fallbackQuery of buildEvidenceFallbackQueries(caseState, stage, kind).slice(0, 2)) {
      if (!fallbackQuery || fallbackQuery === query) continue;
      const fallback = await fetchExternalEvidence(kind, fallbackQuery, options);
      if (fallback.list.length > 0) {
        result = fallback;
        usedQuery = fallbackQuery;
        break;
      }
      if (!fallback.ok || fallback.reason !== "no_hits") break;
    }
  }
  const items = result.list;
  const config = SOURCE_CONFIG[kind];
  const lines = [
    `## ${config.label}`,
    `检索词：${usedQuery || "未生成"}`,
    `用途：${config.requiredFor}`,
  ];

  if (items.length === 0) {
    return "";
  }

  lines.push("命中证据摘要（仅引用下列真实题名、机构、年份和URL；不得编造未列出的资料；引用时使用方括号ID）：");
  // 指南取回窗口大于最终展示窗口：供应商的前 1–3 条常是儿童/病因专病共识，通用指南
  // 常落在第 4–5 条。保留 5 条给服务端做相关性与人群排序，终稿仍只下发唯一首选引用。
  items.slice(0, kind === "literature" ? 5 : kind === "instruction" ? 6 : 5).forEach((item, index) => {
    const evidenceId = `${config.idPrefix}-${String(index + 1).padStart(3, "0")}`;
    if (kind === "instruction") {
      lines.push(formatInstructionEvidenceRecord(item, evidenceId));
      return;
    }
    const metadata = [item.publisher, item.year, item.identifier].filter(Boolean).join("，");
    const url = item.url ? ` URL:${item.url}` : "";
    const detail = item.summary ? `：${item.summary}` : "";
    lines.push(`[${evidenceId}] ${item.title}${metadata ? `（${metadata}）` : ""}${detail}${url}`);
  });
  return lines.join("\n");
}

export async function buildExternalEvidenceContext(
  caseState: CaseState,
  stage: "diagnose" | "prescribe" | "assess",
): Promise<string> {
  const targets = (Object.keys(SOURCE_CONFIG) as EvidenceSourceKind[])
    .filter((kind) => evidenceSourceConfigured(kind));
  const sections = await Promise.all(targets.map((kind) => buildSingleEvidenceSection(kind, caseState, stage)));
  return [
    "## 外部证据检索支持",
    "以下为模型可引用的外部证据上下文；硬安全边界由确定性门控负责，灵犀审方只提供风险提示，检索结果不得作为自动放行依据。",
    ...sections,
  ].join("\n\n");
}

export function getEvimedGuideStatus() {
  const transportAllowed = endpointTransportAllowed(GUIDE_API_URL);
  return {
    provider: "EviMed guide review API",
    providerId: "evimed-guide",
    configured: Boolean(getEvimedEvidenceApiKey("guide")) && transportAllowed,
    transportAllowed,
    disabledReason: transportAllowed ? undefined : "evimed_insecure_transport",
    optional: false,
  };
}

export type ExternalEvidenceProbe = {
  checkedAt: string;
  cached: boolean;
  sources: Array<{
    kind: EvidenceSourceKind;
    ok: boolean;
    reason: GuideEvidenceResult["reason"];
    upstreamStatus?: number;
    resultCount: number;
    requiredForRelease: boolean;
  }>;
};

let evidenceProbeCache: { expiresAt: number; value: ExternalEvidenceProbe } | undefined;
let evidenceProbeInFlight: Promise<ExternalEvidenceProbe> | undefined;

export async function probeExternalEvidenceSources(): Promise<ExternalEvidenceProbe> {
  if (evidenceProbeCache && evidenceProbeCache.expiresAt > Date.now()) {
    return { ...evidenceProbeCache.value, cached: true };
  }
  if (evidenceProbeInFlight) {
    const shared = await evidenceProbeInFlight;
    return { ...shared, cached: true };
  }
  const run = (async () => {
    const queries: Record<EvidenceSourceKind, string> = {
      guide: "失眠诊疗指南",
      instruction: "阿司匹林",
      literature: "阿司匹林 心血管 临床研究",
    };
    const kinds = (Object.keys(queries) as EvidenceSourceKind[])
      .filter((kind) => SOURCE_CONFIG[kind].requiredForRelease || evidenceSourceConfigured(kind));
    const sources = await Promise.all(kinds.map(async (kind) => {
      const result = await fetchExternalEvidence(kind, queries[kind], { count: 1 });
      return {
        kind,
        // A transport-level 200 with zero evidence cannot prove that the configured source is usable.
        ok: result.ok && result.list.length > 0,
        reason: result.reason,
        ...(result.upstreamStatus != null ? { upstreamStatus: result.upstreamStatus } : {}),
        resultCount: result.list.length,
        requiredForRelease: SOURCE_CONFIG[kind].requiredForRelease,
      };
    }));
    const value: ExternalEvidenceProbe = {
      checkedAt: new Date().toISOString(),
      cached: false,
      sources,
    };
    const cacheTtlMs = sources.every((source) => source.ok) ? 5 * 60_000 : 30_000;
    evidenceProbeCache = { expiresAt: Date.now() + cacheTtlMs, value };
    return value;
  })();
  evidenceProbeInFlight = run;
  try {
    return await run;
  } finally {
    if (evidenceProbeInFlight === run) evidenceProbeInFlight = undefined;
  }
}

export function getEvimedEvidenceStatus() {
  return {
    provider: "EviMed evidence API",
    providerId: "evimed",
    optional: false,
    sources: Object.entries(SOURCE_CONFIG).map(([kind, config]) => ({
      kind,
      label: config.label,
      configured: evidenceSourceConfigured(kind as EvidenceSourceKind),
      endpointConfigured: Boolean(config.endpoint),
      transportAllowed: Boolean(config.endpoint) && endpointTransportAllowed(config.endpoint),
      disabledReason: !config.endpoint
        ? "evimed_endpoint_not_configured"
        : !getEvimedEvidenceApiKey(kind as EvidenceSourceKind)
          ? "evimed_api_key_not_configured"
          : endpointTransportAllowed(config.endpoint)
            ? undefined
            : "evimed_insecure_transport",
      requiredFor: config.requiredFor,
      officiallyDocumented: config.officiallyDocumented,
      requiredForRelease: config.requiredForRelease,
      retryAttempts: EVIMED_EVIDENCE_RETRY_ATTEMPTS,
    })),
  };
}
