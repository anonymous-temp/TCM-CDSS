import type { CaseState } from "./diagnosis-types";
import { diagnoseReasoningFromState, prescribeReasoningFromState } from "./diagnosis-parse";
import { sanitizeFreeTextForExternalClinicalService } from "./diagnosis-safety";
import { UpstreamResponseTooLargeError, readResponseTextLimited } from "./http-response-limit";
import { cancelResponseBody } from "./http-response-lifecycle";
import { createHash } from "node:crypto";
import { clinicalProblemConceptsRelevant, matchingMedicineClinicalProblemTerms } from "./medicine-clinical-concepts";
import { boundedEvidenceRerankText, rerankEvidenceDocuments } from "./evidence-rerank";

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

/**
 * 病例叙述里对检索没有主题价值、却会占掉 200 字检索预算的片段：就诊/出生日期、年份、年龄性别起首、
 * 病历样板词（2026-09-28）。9/27 抓到的检索词以「女性，93岁。于1993年8月13日初诊。」开头，
 * 真正的临床问题被截在 200 字之外。只删这些闭集片段，症状描述逐字保留。
 */
const RETRIEVAL_NOISE = [
  /(?:出生日期|就诊时间|就诊日期|初诊日期|节气)\s*[:：]\s*[^\s，,。；;]{1,24}/g,
  /(?:于|在)?\s*\d{4}\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2}\s*日?(?:初诊|复诊|就诊|来诊|入院)?/g,
  /(?:于|在)?\s*\d{4}\s*年(?:\s*\d{1,2}\s*月)?/g,
  /(?:^|[，,。；;\s])(?:男|女)(?:性)?\s*[，,]\s*\d{1,3}\s*岁[。，,；;]?/g,
  /\d{1,3}\s*岁/g,
  /(?:病史摘要|病人xx|患者xx|病历摘要)/gi,
];

function stripRetrievalNoise(text: string): string {
  let out = text;
  for (const pattern of RETRIEVAL_NOISE) out = out.replace(pattern, " ");
  return out.replace(/\s*([，,。；;])\s*(?=[，,。；;])/g, "").replace(/\s+/g, " ").replace(/^[\s，,。；;]+/, "").trim();
}

function evidenceSymptomTerms(caseState: CaseState): string {
  const hisFields = caseState.hisRecord?.fields;
  const symptomRecord = caseState.symptoms && typeof caseState.symptoms === "object" ? caseState.symptoms : {};
  return stripRetrievalNoise([
    hisFields?.zhushu || caseState.chiefComplaint,
    hisFields?.xianbingshi || stringifyClinicalValue(symptomRecord.presentHistory),
    hisFields?.tcmDetail || stringifyClinicalValue(symptomRecord.tcmDetail),
    hisFields?.tcmTongue || caseState.tongue,
    hisFields?.tcmPulse || caseState.pulse,
    caseState.diagnosis?.match(/现代医学风险\/需排除方向[\s\S]{0,240}/)?.[0],
    caseState.diagnosis?.match(/中医证候诊断[\s\S]{0,220}/)?.[0],
  ].filter(Boolean).join(" "));
}

/**
 * 已签名 M03 结论里的检索主题词（2026-09-28）。M04/M05 检索此前只拿病例原文拼查询（再截到 200 字），
 * 已签名的西医诊断、中医病名、证候、锁定方剂一个都不用——而它们正是指南与文献检索该用的主题。
 * 研究依据：TrialGPT（Nat Commun 2024）以原始病历作查询 recall@500 50%，改用生成的关键词 83–86%；
 * Cochrane Handbook 第 4 章按病症/人群 + 干预组织检索词。只取短名词，括注、定性词（待查/考虑）去掉；
 * 「病因待查」这类不是主题的诊断不用。没有签名 M03（M03 阶段本身）时返回 undefined。
 */
export function signedDiagnosisEvidenceTopics(caseState: CaseState): {
  western?: string;
  tcmDisease?: string;
  syndrome?: string;
  formula?: string;
  therapy?: string;
} | undefined {
  const reasoning = diagnoseReasoningFromState(caseState);
  if (!reasoning) return undefined;
  const term = (value: unknown, max: number): string | undefined => {
    if (typeof value !== "string") return undefined;
    const cleaned = value
      .replace(/[（(][^）)]*[）)]/g, "")
      .replace(/(?:待查|待排除?|可能性?大?|考虑|疑似|倾向)/g, "")
      .split(/[，,；;、。\s]/)[0]
      .trim();
    if (!cleaned || cleaned.length < 2 || /^(?:病因|原因不明|不明原因|未明|未定)/.test(cleaned)) return undefined;
    return cleaned.slice(0, max);
  };
  const topics = {
    western: term(reasoning.westernDiagnosis?.primary?.name, 20),
    tcmDisease: term(reasoning.overview?.tcmDiseaseName, 12),
    syndrome: term(reasoning.overview?.primarySyndrome, 14),
    formula: term(reasoning.overview?.recommendedFormulaNames?.[0], 12),
    therapy: term(reasoning.therapy?.overallMethod || reasoning.overview?.overallTherapy, 12),
  };
  return topics.western || topics.tcmDisease || topics.syndrome ? topics : undefined;
}

/**
 * M04/M05 阶段按已签名结论组织的短检索词，按临床优先级排列；首个有结果的被采用，原病例叙述查询垫底。
 * 说明书检索按药名，不在此列。
 */
export function buildSignedTopicEvidenceQueries(
  caseState: CaseState,
  stage: "diagnose" | "prescribe" | "assess",
  kind: EvidenceSourceKind,
): string[] {
  if (stage === "diagnose" || kind === "instruction" || process.env.CDSS_EVIDENCE_TOPIC_QUERIES === "false") return [];
  const topics = signedDiagnosisEvidenceTopics(caseState);
  if (!topics) return [];
  const explicitNames = evidenceQueryExplicitNames(caseState);
  const disease = topics.western || topics.tcmDisease;
  const tcm = [topics.tcmDisease, topics.syndrome].filter(Boolean).join(" ");
  const intervention = topics.formula || topics.therapy;
  const queries = kind === "guide"
    ? stage === "assess"
      ? [disease && `${disease} 随访 管理 指南`, tcm && `${tcm} 中医 调护`]
      : [topics.western && `${topics.western} 诊疗指南 专家共识`, tcm && `${tcm} 中医诊疗指南 专家共识`]
    : stage === "assess"
      ? [disease && `${disease} 安全性 不良反应`]
      : [disease && intervention && `${disease} ${intervention} 临床研究`, tcm && `${tcm} 中医药 临床研究`];
  return [...new Set(queries
    .filter((query): query is string => typeof query === "string" && Boolean(query.trim()))
    .map((query) => scrubQuery(query, explicitNames))
    .filter(Boolean))];
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

/** Rerank-only facts supplement a short selected search query without changing upstream retrieval. */
export function buildEvidenceRerankQuery(caseState: CaseState, usedQuery: string): string {
  const fields = caseState.hisRecord?.fields;
  const explicitNames = evidenceQueryExplicitNames(caseState);
  const safeField = (value: string | undefined, limit: number) => value
    ? boundedEvidenceRerankText(sanitizeFreeTextForExternalClinicalService(value, explicitNames), limit)
      || "[本字段超出排序预算，未纳入]"
    : "未记录";
  // Preserve recorded negative/unknown wording verbatim. Missing treatment history stays missing;
  // it must not be converted into an exclusion such as "no chemotherapy".
  return boundedEvidenceRerankText([
    safeField(usedQuery, 200),
    `记录年龄：${safeField(firstString(fields?.age, caseState.patient.age), 24)}`,
    `记录性别：${safeField(firstString(fields?.sex, caseState.patient.sex), 24)}`,
    `主诉：${safeField(firstString(fields?.zhushu, caseState.chiefComplaint), 120)}`,
    `现病史：${safeField(firstString(fields?.xianbingshi, caseState.symptoms?.presentHistory), 300)}`,
  ].join("；"), 768, 2048);
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
  const chiefComplaint = caseState.hisRecord?.fields?.zhushu || caseState.chiefComplaint || "";
  // Use the existing governed vocabulary for retrieval only. Main-complaint matches precede
  // narrative matches so an incidental history topic cannot displace the presenting problem.
  const problemTerms = [
    ...matchingMedicineClinicalProblemTerms(chiefComplaint).reverse(),
    ...matchingMedicineClinicalProblemTerms(caseText).reverse(),
  ];
  return [...new Set(problemTerms
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

/**
 * EviMed 检索结果缓存与并发合流（2026-09-27，提速）。
 *
 * 线上一条链路里 EviMed 是 M03、M04 生成前唯一没有计时的网络环节：M03 两个半程在症状召回、
 * 证候重排都完成后还要再等约 1.9s，M04 在规划器之后还要再等约 3.5s，全是在等 EviMed。
 * 检索结果是（来源，脱敏检索词，条数，起始年）的函数，与租户、病人身份无关（检索词已经
 * scrubQuery 去标识）。所以：
 *  · 只缓存成功结果（ok=true，含 no_hits），10 分钟、至多 256 条；失败一律不缓存，下次照常重试；
 *  · 同键并发只发一次请求；共享请求不绑定任何一个调用方的中止信号（调用方中止时只是自己先返回
 *    cancelled，不会把别人正在等的请求一起掐断）；
 *  · `CDSS_EVIDENCE_FETCH_CACHE=false` 关闭（回滚开关；逐次打桩 fetch 的单元测试也用它）；
 *  · 路由据此可以**预取**下一阶段的检索（M02 预取 M03 的、M03 签名后预取 M04 的），预取与正式
 *    调用的检索词一致时正式调用直接命中，不一致时只是多了几次检索，不改变任何结果。
 */
const EVIDENCE_FETCH_CACHE_TTL_MS = 10 * 60_000;
const EVIDENCE_FETCH_CACHE_MAX = 256;
const evidenceFetchCache = new Map<string, { storedAt: number; value: GuideEvidenceResult }>();
const evidenceFetchInFlight = new Map<string, Promise<GuideEvidenceResult>>();

function evidenceFetchCacheKey(kind: EvidenceSourceKind, safeQuery: string, opts?: { count?: number; startYear?: number }): string {
  return createHash("sha256")
    .update(JSON.stringify([kind, SOURCE_CONFIG[kind].endpoint || "", safeQuery, opts?.count ?? null, opts?.startYear ?? null]))
    .digest("hex");
}

function awaitWithCallerSignal(
  pending: Promise<GuideEvidenceResult>,
  signal: AbortSignal | undefined,
  cancelled: () => GuideEvidenceResult,
): Promise<GuideEvidenceResult> {
  if (!signal) return pending;
  if (signal.aborted) return Promise.resolve(cancelled());
  return new Promise((resolve) => {
    const onAbort = () => resolve(cancelled());
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      () => { signal.removeEventListener("abort", onAbort); resolve(cancelled()); },
    );
  });
}

/** 测试用：清空检索缓存。 */
export function resetExternalEvidenceCacheForTests(): void {
  evidenceFetchCache.clear();
  evidenceFetchInFlight.clear();
}

export async function fetchExternalEvidence(kind: EvidenceSourceKind, query: string, opts?: { count?: number; startYear?: number; signal?: AbortSignal }): Promise<GuideEvidenceResult> {
  const safeQuery = scrubQuery(query);
  const cancelled = (): GuideEvidenceResult => ({ ok: false, reason: "upstream_error", query: safeQuery, list: [], message: "request_cancelled" });
  if (opts?.signal?.aborted) return cancelled();
  if (process.env.CDSS_EVIDENCE_FETCH_CACHE === "false" || !safeQuery || !SOURCE_CONFIG[kind].endpoint || !getEvimedEvidenceApiKey(kind)) {
    return fetchExternalEvidenceUncached(kind, query, opts);
  }
  const key = evidenceFetchCacheKey(kind, safeQuery, opts);
  const cached = evidenceFetchCache.get(key);
  if (cached && Date.now() - cached.storedAt < EVIDENCE_FETCH_CACHE_TTL_MS) {
    console.info("[tcm-cdss:timing] evidence_fetch", { kind, durationMs: 0, reason: cached.value.reason, source: "cache" });
    return cached.value;
  }
  if (cached) evidenceFetchCache.delete(key);
  const joined = evidenceFetchInFlight.get(key);
  if (joined) return awaitWithCallerSignal(joined, opts?.signal, cancelled);
  const startedAt = Date.now();
  const pending = fetchExternalEvidenceUncached(kind, query, { count: opts?.count, startYear: opts?.startYear })
    .then((value) => {
      console.info("[tcm-cdss:timing] evidence_fetch", { kind, durationMs: Date.now() - startedAt, reason: value.reason, source: "network" });
      if (value.ok) {
        evidenceFetchCache.set(key, { storedAt: Date.now(), value });
        while (evidenceFetchCache.size > EVIDENCE_FETCH_CACHE_MAX) {
          const oldest = evidenceFetchCache.keys().next().value;
          if (oldest === undefined) break;
          evidenceFetchCache.delete(oldest);
        }
      }
      return value;
    })
    .finally(() => evidenceFetchInFlight.delete(key));
  evidenceFetchInFlight.set(key, pending);
  return awaitWithCallerSignal(pending, opts?.signal, cancelled);
}

async function fetchExternalEvidenceUncached(kind: EvidenceSourceKind, query: string, opts?: { count?: number; startYear?: number; signal?: AbortSignal }): Promise<GuideEvidenceResult> {
  const apiKey = getEvimedEvidenceApiKey(kind);
  const safeQuery = scrubQuery(query);
  const endpoint = SOURCE_CONFIG[kind].endpoint;
  const cancelled = (): GuideEvidenceResult => ({ ok: false, reason: "upstream_error", query: safeQuery, list: [], message: "request_cancelled" });
  if (opts?.signal?.aborted) return cancelled();
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
    if (opts?.signal?.aborted) return cancelled();
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
        signal: opts?.signal ? AbortSignal.any([controller.signal, opts.signal]) : controller.signal,
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
      if (opts?.signal?.aborted) return cancelled();
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
  signal?: AbortSignal,
): Promise<string> {
  return buildSingleEvidenceSection("guide", caseState, stage, signal);
}

/**
 * 本例阳性临床问题（受治理问题词表，与 buildEvidenceFallbackQueries 同一词表）与检索条目的交集。
 * 返回相关条目的原序号；本例抽不出任何问题词时返回 undefined（不过滤）。
 */
function evidenceItemsRelevantToCase(items: readonly ExternalEvidenceItem[], caseState: CaseState): Set<number> | undefined {
  const reasoning = diagnoseReasoningFromState(caseState);
  const caseText = [
    caseState.hisRecord?.fields?.zhushu || caseState.chiefComplaint,
    evidenceSymptomTerms(caseState),
    reasoning?.westernDiagnosis?.primary?.name,
    reasoning?.overview?.tcmDiseaseName,
  ].filter((value): value is string => typeof value === "string" && Boolean(value.trim())).join("；");
  if (clinicalProblemConceptsRelevant(caseText, "") === undefined) return undefined;
  const relevant = new Set<number>();
  items.forEach((item, index) => {
    if (clinicalProblemConceptsRelevant(caseText, `${item.title || ""}\n${item.summary || ""}`)) relevant.add(index);
  });
  return relevant;
}

async function buildSingleEvidenceSection(
  kind: EvidenceSourceKind,
  caseState: CaseState,
  stage: "diagnose" | "prescribe" | "assess",
  signal?: AbortSignal,
): Promise<string> {
  const query = buildEvidenceQuery(caseState, stage, kind);
  const options = {
    count: kind === "guide" ? 8 : kind === "literature" ? 5 : 6,
    startYear: kind === "guide" || kind === "literature" ? 2018 : undefined,
  };
  const problemQueries = buildEvidenceFallbackQueries(caseState, stage, kind)
    .filter((candidate) => candidate !== query).slice(0, 2);
  let result: GuideEvidenceResult | undefined;
  let usedQuery = query;
  const topicQueries = buildSignedTopicEvidenceQueries(caseState, stage, kind).filter((candidate) => candidate !== query);
  if (topicQueries.length > 0) {
    // 与 M03 阶段同一套有界扇出：签名主题词按优先级在前，原叙述查询垫底；先到先用、其余取消。
    const unused = new AbortController();
    const querySignal = signal ? AbortSignal.any([unused.signal, signal]) : unused.signal;
    const ordered = [...topicQueries, query];
    const pending = ordered.map((candidate) => fetchExternalEvidence(kind, candidate, { ...options, signal: querySignal }));
    const relevanceFilterOn = process.env.CDSS_EVIDENCE_RELEVANCE_FILTER !== "false";
    try {
      // 首个「过了本例相关性过滤后仍有条目」的查询胜出：只看有没有返回会让一个全被过滤掉的结果
      // 挡住后面本可用的查询（9/28 对照：整页无证据 23→34 例即此）。都过不了时退回首个有返回的结果，
      // 由下面同一道过滤决定是否整段不出。
      let firstResult: GuideEvidenceResult | undefined;
      let firstNonEmpty: { result: GuideEvidenceResult; query: string } | undefined;
      let chosen: { result: GuideEvidenceResult; query: string } | undefined;
      for (const [index, attempt] of pending.entries()) {
        const candidate = await attempt;
        firstResult ??= candidate;
        if (!candidate.ok || candidate.list.length === 0) continue;
        firstNonEmpty ??= { result: candidate, query: ordered[index] };
        const relevant = relevanceFilterOn ? evidenceItemsRelevantToCase(candidate.list, caseState) : undefined;
        if (!relevant || relevant.size > 0) {
          chosen = { result: candidate, query: ordered[index] };
          break;
        }
      }
      chosen ??= firstNonEmpty;
      result = chosen?.result ?? firstResult;
      usedQuery = chosen?.query ?? query;
    } finally {
      unused.abort();
    }
  } else if (stage === "diagnose" && kind !== "instruction" && problemQueries.length) {
    const unused = new AbortController();
    const querySignal = signal ? AbortSignal.any([unused.signal, signal]) : unused.signal;
    // Start the same bounded fan-out, consume by clinical priority instead of waiting for all.
    // The first successful priority query is exactly the former Promise.all selection. Unused
    // work is cancelled; its caught empty result never changes already selected evidence IDs.
    const full = fetchExternalEvidence(kind, query, { ...options, signal: querySignal });
    const preferred = problemQueries.map(candidate => fetchExternalEvidence(kind, candidate, { ...options, signal: querySignal }));
    try {
      for (const [index, pending] of preferred.entries()) {
        const candidate = await pending;
        if (candidate.ok && candidate.list.length) {
          result = candidate;
          usedQuery = problemQueries[index];
          break;
        }
      }
      result ??= await full;
    } finally {
      unused.abort();
    }
  } else {
    result = await fetchExternalEvidence(kind, query, { ...options, signal });
  }
  if (!result) result = await fetchExternalEvidence(kind, query, { ...options, signal });
  const shouldTryProblemFallback = kind !== "instruction" && stage !== "diagnose" &&
    result.ok && result.reason === "no_hits";
  if (shouldTryProblemFallback) {
    for (const fallbackQuery of problemQueries) {
      const fallback = await fetchExternalEvidence(kind, fallbackQuery, { ...options, signal });
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

  let orderedIndices = items.map((_, index) => index);
  // 病例相关性过滤（2026-09-27）：指南/文献检索词里带着整段病历，EviMed 常返回与本例无关的条目
  // （9/27 抓取：胃痛病例拿到黄褐斑、脓疱疮共识与心血管指南质量评价；浮肿病例拿到口腔溃疡、不孕症）。
  // 条目题名/摘要与本例阳性临床问题（受治理问题词表）没有任何交集就不进提示词；本例抽不出问题词时
  // 不过滤。说明书检索按药名精确检索，不在此列。ID 仍绑定原检索序号。
  // `CDSS_EVIDENCE_RELEVANCE_FILTER=false` 关闭（回滚开关；用合成条目测检索/重排机制的套件也用它）。
  if (kind !== "instruction" && process.env.CDSS_EVIDENCE_RELEVANCE_FILTER !== "false") {
    const relevant = evidenceItemsRelevantToCase(items, caseState);
    if (relevant) {
      const dropped = orderedIndices.length - relevant.size;
      if (dropped > 0) console.info("[tcm-cdss:evidence] irrelevant items dropped", { kind, stage, kept: relevant.size, dropped });
      orderedIndices = orderedIndices.filter((index) => relevant.has(index));
      if (orderedIndices.length === 0) return "";
    }
  }
  lines.push("命中证据摘要（仅引用下列真实题名、机构、年份和URL；不得编造未列出的资料；引用时使用方括号ID）：");
  if (result.ok && kind !== "instruction" && orderedIndices.length > 1) {
    const explicitNames = evidenceQueryExplicitNames(caseState);
    const pool = orderedIndices;
    const reranked = await rerankEvidenceDocuments(
      buildEvidenceRerankQuery(caseState, usedQuery),
      pool.map((index) => sanitizeFreeTextForExternalClinicalService(`${items[index].title}\n${items[index].summary || ""}`, explicitNames)),
      { signal },
    );
    orderedIndices = reranked.order.map((position) => pool[position]).filter((index) => index !== undefined);
  }
  // Sort only the already-selected pool before the display window. IDs remain bound to the
  // original result indices, including candidates newly promoted into the top five.
  orderedIndices.slice(0, kind === "instruction" ? 6 : 5).forEach(index => {
    const item = items[index];
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
  signal?: AbortSignal,
): Promise<string> {
  const targets = (Object.keys(SOURCE_CONFIG) as EvidenceSourceKind[])
    .filter((kind) => evidenceSourceConfigured(kind));
  const sections = await Promise.all(targets.map((kind) => buildSingleEvidenceSection(kind, caseState, stage, signal)));
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
