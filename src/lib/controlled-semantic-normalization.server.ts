import "server-only";

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import syndromeJson from "../data/tcm-syndrome-lexicon.json" with { type: "json" };
import locationJson from "../data/tcm-location-lexicon.json" with { type: "json" };
import natureJson from "../data/tcm-nature-lexicon.json" with { type: "json" };
import treatmentJson from "../data/tcm-treatment-principle-lexicon.json" with { type: "json" };
import terminologyExtensionsJson from "../data/tcm-clinical-terminology-extensions.json" with { type: "json" };
import formulaJson from "../data/tcm-formula-governed-catalog.json" with { type: "json" };
import icd10Json from "../data/icd10-diagnosis-index.json" with { type: "json" };
import { MEDICINE_CLINICAL_CONCEPTS } from "./medicine-clinical-concepts";
import {
  normalizeControlledSemanticText,
  prefilterControlledSemanticCandidates,
  type ControlledSemanticCandidate,
  type ControlledSemanticDecision,
  type ControlledSemanticNamespace,
  type ControlledSemanticTarget,
  type ControlledTerminologyMapping,
  validatedConsensusDecision,
} from "./controlled-semantic-normalization";
import {
  createTextModelClient,
  getControlledTerminologyModelConfig,
  getPublicTextModelStatus,
  isDeepseekModel,
} from "./text-model";

type CanonicalRow = { id: string; canonical: string; aliases?: string[]; termClass?: string };
type FormulaRow = { id: string; name: string; aliases?: string[]; identityLockEligible?: boolean };
type Icd10Row = { code: string; name: string; aliases?: string[]; level: string };
type CacheEntry = {
  key: string;
  namespace: ControlledSemanticNamespace;
  normalizedInput: string;
  candidateId: string;
  canonical: string;
  confidence: number;
  model: string;
  candidateFingerprint: string;
  createdAt: string;
};
type CacheFile = { schemaVersion: "controlled-semantic-cache-v1"; entries: CacheEntry[] };
type JsonRecord = Record<string, unknown>;

// 必须 ≥ extractM03Targets 的结构性最大值，否则末尾 slice 会**静默丢弃** target。
// 结构上限 = 主证1 + 中医鉴别3 + 病位4 + 病性4 + 治则1 + 方名4 + 西医主诊1 + 西医鉴别4
//          + 中成药概念(结论)1 + 中成药概念(口语)1 = 24。
// 此前是 14，而当时结构上限已是 19——被丢掉的正是**最后 push 的中成药概念 target**，
// 也就是审查指出的"中成药召回唯一的语义补位"。病例的鉴别/病位/病性条目一多，
// 这条补位就无声消失，中成药路径退回 40 条硬编码正则。
// max_tokens 同步抬高：每条 decision 约 50 token，24 条需要约 1200，900 装不下。
const MAX_TARGETS_PER_CALL = 24;
const MAX_CACHE_ENTRIES = 4_000;
const MODEL_TIMEOUT_MS = 25_000;

// 消极共识短 TTL 缓存：模型**有响应但未达共识/弃权**的目标，在 TTL 内不再重复发起闭集调用。
// 同一 M03 请求会跑两遍 prepare（梯子预处理 + 复核前 finalize），修复轮还会再来一遍——
// 没有这层时每一遍都为同一批注定失败的目标各烧两条模型腿（实测两遍共 60s+）。
// 传输失败/超时不进此缓存，保持可用性语义：下次照常重试。
const NO_CONSENSUS_TTL_MS = 10 * 60_000;
const NO_CONSENSUS_MAX_ENTRIES = 2_000;
const noConsensusCache = new Map<string, { expiresAt: number; candidateFingerprint: string }>();
function rememberNoConsensus(key: string, fingerprint: string): void {
  if (noConsensusCache.size >= NO_CONSENSUS_MAX_ENTRIES) noConsensusCache.clear();
  noConsensusCache.set(key, { expiresAt: Date.now() + NO_CONSENSUS_TTL_MS, candidateFingerprint: fingerprint });
}
function hasFreshNoConsensus(key: string, fingerprint: string): boolean {
  const entry = noConsensusCache.get(key);
  return Boolean(entry && entry.expiresAt > Date.now() && entry.candidateFingerprint === fingerprint);
}
const PROBE_CACHE_TTL_MS = 5 * 60_000;

const clinicalExtensions = terminologyExtensionsJson as {
  treatmentAliasAugmentations?: Array<{ targetCanonical: string; aliases: string[] }>;
  treatmentEntries?: CanonicalRow[];
};
const treatmentAliasAugmentations = new Map(
  (clinicalExtensions.treatmentAliasAugmentations || [])
    .map((item) => [item.targetCanonical, item.aliases] as const),
);

const canonicalCandidates = (rows: readonly CanonicalRow[]): ControlledSemanticCandidate[] =>
  rows
    .filter((row) => row.termClass !== "category_heading")
    .map((row) => ({ id: row.id, canonical: row.canonical, aliases: row.aliases || [] }));

const CANDIDATES: Record<ControlledSemanticNamespace, ControlledSemanticCandidate[]> = {
  tcm_syndrome: canonicalCandidates((syndromeJson as { entries: CanonicalRow[] }).entries),
  tcm_location: canonicalCandidates((locationJson as { entries: CanonicalRow[] }).entries),
  tcm_nature: canonicalCandidates((natureJson as { entries: CanonicalRow[] }).entries),
  tcm_treatment_principle: [
    ...(treatmentJson as { entries: CanonicalRow[] }).entries.map((row) => ({
      ...row,
      aliases: [...new Set([...(row.aliases || []), ...(treatmentAliasAugmentations.get(row.canonical) || [])])],
    })),
    ...(clinicalExtensions.treatmentEntries || []),
  ]
    .filter((row) => row.termClass !== "category_heading")
    .map((row) => ({ id: row.id, canonical: row.canonical, aliases: row.aliases || [] })),
  tcm_formula: (formulaJson as { entries: FormulaRow[] }).entries
    .filter((row) => row.identityLockEligible)
    .map((row) => ({ id: row.id, canonical: row.name, aliases: row.aliases || [] })),
  medicine_clinical_concept: MEDICINE_CLINICAL_CONCEPTS.map((row, index) => ({
    id: `MED-CONCEPT-${String(index + 1).padStart(3, "0")}`,
    canonical: row.key,
    aliases: [],
    metadata: { axis: row.axis },
  })),
  icd10: (icd10Json as { entries: Icd10Row[] }).entries.map((row) => ({
    id: row.code,
    canonical: row.name,
    aliases: row.aliases || [],
    metadata: { level: row.level },
  })),
};

const exactByNamespace = new Map<ControlledSemanticNamespace, Map<string, ControlledSemanticCandidate | null>>();
for (const [namespace, candidates] of Object.entries(CANDIDATES) as Array<[ControlledSemanticNamespace, ControlledSemanticCandidate[]]>) {
  const values = new Map<string, ControlledSemanticCandidate | null>();
  for (const candidate of candidates) {
    for (const rawValue of [candidate.canonical, ...candidate.aliases]) {
      const token = normalizeControlledSemanticText(rawValue);
      if (!token) continue;
      const existing = values.get(token);
      values.set(token, existing && existing.id !== candidate.id ? null : candidate);
    }
  }
  exactByNamespace.set(namespace, values);
}

const memoryCache = new Map<string, CacheEntry>();
let cacheLoaded = false;
let cacheWriteChain = Promise.resolve();
let probeCache: { expiresAt: number; value: Awaited<ReturnType<typeof runProbe>> } | undefined;

function enabled(): boolean {
  return process.env.CONTROLLED_TERMINOLOGY_NORMALIZATION !== "false";
}

function cachePath(): string {
  const configured = process.env.CONTROLLED_TERMINOLOGY_CACHE_PATH?.trim();
  return configured ? resolve(configured) : resolve(process.cwd(), "artifacts/runtime/controlled-terminology-cache.json");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function candidateFingerprint(target: ControlledSemanticTarget): string {
  return sha256(target.candidates.map((item) => `${item.id}:${item.canonical}`).join("|"));
}

function targetCacheKey(target: ControlledSemanticTarget, model: string): string {
  return sha256([
    target.namespace,
    normalizeControlledSemanticText(target.input),
    model,
    candidateFingerprint(target),
  ].join("\n"));
}

async function loadCache(): Promise<void> {
  if (cacheLoaded) return;
  cacheLoaded = true;
  try {
    const parsed = JSON.parse(await readFile(cachePath(), "utf8")) as Partial<CacheFile>;
    for (const entry of parsed.entries || []) {
      if (entry && typeof entry.key === "string" && typeof entry.candidateId === "string") {
        memoryCache.set(entry.key, entry as CacheEntry);
      }
    }
  } catch {
    // First run or a corrupt optional cache must never block clinical reasoning.
  }
}

async function persistCache(): Promise<void> {
  const target = cachePath();
  const temporary = `${target}.${process.pid}.tmp`;
  const entries = [...memoryCache.values()]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, MAX_CACHE_ENTRIES);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(temporary, JSON.stringify({
    schemaVersion: "controlled-semantic-cache-v1",
    entries,
  } satisfies CacheFile, null, 2), { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
}

function queueCacheWrite(): void {
  cacheWriteChain = cacheWriteChain.then(persistCache, persistCache).catch((error) => {
    console.warn("[tcm-cdss:terminology] semantic mapping cache write unavailable", {
      reason: error instanceof Error ? error.message : "cache_write_error",
    });
  });
}

async function persistCacheAndVerifyEntry(key: string): Promise<boolean> {
  const scheduledWrite = cacheWriteChain.then(persistCache, persistCache);
  cacheWriteChain = scheduledWrite.catch((error) => {
    console.warn("[tcm-cdss:terminology] semantic mapping cache verification unavailable", {
      reason: error instanceof Error ? error.message : "cache_verify_error",
    });
  });
  try {
    await scheduledWrite;
    const parsed = JSON.parse(await readFile(cachePath(), "utf8")) as Partial<CacheFile>;
    return parsed.schemaVersion === "controlled-semantic-cache-v1" &&
      (parsed.entries || []).some((entry) => entry?.key === key);
  } catch {
    return false;
  }
}

function exactCandidate(namespace: ControlledSemanticNamespace, input: string): ControlledSemanticCandidate | undefined {
  return exactByNamespace.get(namespace)?.get(normalizeControlledSemanticText(input)) || undefined;
}

function makeTarget(
  key: string,
  namespace: ControlledSemanticNamespace,
  fieldPath: string,
  inputValue: unknown,
  limit = 24,
): ControlledSemanticTarget | undefined {
  const input = typeof inputValue === "string" ? inputValue.trim() : "";
  if (!input || exactCandidate(namespace, input)) return undefined;
  const candidates = prefilterControlledSemanticCandidates(input, CANDIDATES[namespace], limit);
  return candidates.length > 0 ? { key, namespace, fieldPath, input, candidates } : undefined;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function extractM03Targets(reasoning: JsonRecord, patientNarrative = ""): ControlledSemanticTarget[] {
  const targets: Array<ControlledSemanticTarget | undefined> = [];
  const push = (
    namespace: ControlledSemanticNamespace,
    fieldPath: string,
    value: unknown,
    limit?: number,
  ) => targets.push(makeTarget(`m${targets.length + 1}`, namespace, fieldPath, value, limit));
  const overview = asRecord(reasoning.overview);
  const pathogenesis = asRecord(reasoning.pathogenesis);
  const therapy = asRecord(reasoning.therapy);
  const westernDiagnosis = asRecord(reasoning.westernDiagnosis);
  const westernPrimary = asRecord(westernDiagnosis.primary);
  push("tcm_syndrome", "overview.primarySyndrome", overview.primarySyndrome, 28);
  asArray(overview.tcmDifferentials).slice(0, 3).forEach((item: unknown, index: number) =>
    push("tcm_syndrome", `overview.tcmDifferentials.${index}.syndrome`, asRecord(item).syndrome, 24));
  asArray(asRecord(pathogenesis.locationDifferentiation).items).slice(0, 4).forEach((value: unknown, index: number) =>
    push("tcm_location", `pathogenesis.locationDifferentiation.items.${index}`, value, 18));
  asArray(asRecord(pathogenesis.natureDifferentiation).items).slice(0, 4).forEach((value: unknown, index: number) =>
    push("tcm_nature", `pathogenesis.natureDifferentiation.items.${index}`, value, 18));
  push("tcm_treatment_principle", "therapy.overallPrinciple", therapy.overallPrinciple, 20);
  asArray(overview.recommendedFormulaNames).slice(0, 4).forEach((value: unknown, index: number) =>
    push("tcm_formula", `overview.recommendedFormulaNames.${index}`, value, 20));
  if (westernPrimary.status === "考虑") {
    push("icd10", "westernDiagnosis.primary.name", westernPrimary.name, 24);
  }
  // 鉴别诊断此前**完全不进归一**，只有 primary 进。而去重恰恰发生在鉴别列表上：
  // westernDifferentialIdentity 退回 clinical-terminology.ts 里那 6 条硬编码规则，
  // 于是「COPD」与「慢性阻塞性肺疾病」「胃食管反流病」与「反流性食管炎」被判成两个身份，
  // 医生看到同一个诊断列两遍（那个函数的注释本身就在讲要防这件事）。
  // ICD 索引没有同义词层（aliases 就是名称本身，COPD/上感/慢性阻塞性肺疾病 全未收），
  // 所以补同义词表没用——正确解法是让这批也走 LLM 闭集映射，落到同一个 ICD 编码上。
  asArray(westernDiagnosis.differentials).slice(0, 4).forEach((item: unknown, index: number) =>
    push("icd10", `westernDiagnosis.differentials.${index}.name`, asRecord(item).name, 24));
  const medicineConceptInput = [
    westernPrimary.name,
    overview.primarySyndrome,
    overview.overallPathogenesis,
    therapy.overallMethod,
  ].filter((value) => typeof value === "string" && value.trim()).join("；");
  push(
    "medicine_clinical_concept",
    "retrieval.medicineClinicalConcept.primary",
    medicineConceptInput,
    CANDIDATES.medicine_clinical_concept.length,
  );
  // 上面那条的输入全是 M03 的**结论字段**（诊断名/证候/病机/治法），覆盖不到
  // "医生用口语写了一个症状"这个场景——而中成药召回的准入门槛正是 40 条硬编码正则概念
  // （medicine-clinical-concepts.ts），「心窝子疼」「胃口那块儿烧得慌」「一天跑五六趟厕所」
  // 一个都不命中，整条中成药路径直接零候选。
  // 一个 target 只产出一个 candidateId，所以这里**另开一条**以病历原文为输入的映射，
  // 让口语症状也能落到受控概念上；两条互不覆盖，合起来支持"结论概念 + 口语概念"并存。
  if (patientNarrative && patientNarrative.trim()) {
    push(
      "medicine_clinical_concept",
      "retrieval.medicineClinicalConcept.narrative",
      patientNarrative,
      CANDIDATES.medicine_clinical_concept.length,
    );
  }
  return targets.filter((item): item is ControlledSemanticTarget => Boolean(item)).slice(0, MAX_TARGETS_PER_CALL);
}

function parseDecisionPayload(value: unknown, targets: readonly ControlledSemanticTarget[]): ControlledSemanticDecision[] {
  const root = typeof value === "string"
    ? (() => {
        try {
          const start = value.indexOf("{");
          const end = value.lastIndexOf("}");
          return start >= 0 && end > start ? JSON.parse(value.slice(start, end + 1)) : null;
        } catch {
          return null;
        }
      })()
    : value;
  const decisions = root && typeof root === "object" ? (root as { decisions?: unknown }).decisions : undefined;
  if (!Array.isArray(decisions)) return [];
  const targetKeys = new Set(targets.map((target) => target.key));
  return decisions.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const key = (item as { key?: unknown }).key;
    const candidateId = (item as { candidateId?: unknown }).candidateId;
    const confidence = (item as { confidence?: unknown }).confidence;
    if (typeof key !== "string" || !targetKeys.has(key)) return [];
    if (candidateId !== null && typeof candidateId !== "string") return [];
    if (typeof confidence !== "number" || !Number.isFinite(confidence)) return [];
    return [{ key, candidateId, confidence }];
  });
}

function semanticPrompt(targets: readonly ControlledSemanticTarget[]): string {
  return [
    "你是受控临床术语闭集映射器，不负责诊断，不得生成候选集外的术语。",
    "逐项判断 input 是否与候选中的某一项语义等价；只有同义/规范名差异时才能选择，相关但不等价必须弃权。",
    "candidateId 只能复制对应 candidates 中的 id；无法确定时必须为 null。confidence 为 0 到 1。",
    "只输出一个 JSON：{\"decisions\":[{\"key\":\"m1\",\"candidateId\":\"候选ID或null\",\"confidence\":0.0}]}，不要解释。",
    JSON.stringify(targets.map((target) => ({
      key: target.key,
      namespace: target.namespace,
      input: target.input,
      candidates: target.candidates.map((candidate) => ({
        id: candidate.id,
        canonical: candidate.canonical,
        aliases: candidate.aliases.slice(0, 8),
        ...(candidate.metadata ? { metadata: candidate.metadata } : {}),
      })),
    }))),
  ].join("\n");
}

async function callClosedSetModel(
  targets: readonly ControlledSemanticTarget[],
  signal?: AbortSignal,
): Promise<ControlledSemanticDecision[]> {
  const config = getControlledTerminologyModelConfig();
  if (!config.configured) return [];
  const client = createTextModelClient(config);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
  try {
    const completion = await client.chat.completions.create({
      model: config.model,
      messages: [
        { role: "system", content: "你只执行闭集术语等价映射；候选外一律弃权。" },
        { role: "user", content: semanticPrompt(targets) },
      ],
      temperature: 0,
      max_tokens: 1800,
      stream: false,
      // 闭集映射是微型 JSON 合同。V4 Flash 不显式禁用思考时会先烧推理预算，单次调用被
      // 25s 超时打满、重试再烧一轮——实测占掉 M03 合并后 60s+ 且常空手而归（其它轻量语义层
      // 全部带此参数，唯独这里漏了）。禁用后单次应回到秒级。
      ...(isDeepseekModel(config.model) ? {
        reasoning_effort: "low" as const,
        thinking: { type: "disabled" as const },
      } : {}),
      response_format: { type: "json_object" },
    }, { signal: controller.signal });
    return parseDecisionPayload(completion.choices[0]?.message?.content, targets);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function callClosedSetModelWithOneRetry(
  targets: readonly ControlledSemanticTarget[],
  signal?: AbortSignal,
): Promise<ControlledSemanticDecision[]> {
  const first = await callClosedSetModel(targets, signal);
  if (first.length > 0 || signal?.aborted) return first;
  // DeepSeek-compatible gateways can occasionally return an empty final-content frame even when
  // the transport succeeded. Preserve the two-invocation consensus requirement, but give each
  // empty leg one bounded retry instead of turning a transient empty frame into systematic recall
  // loss. Candidate-set validation remains identical on the retry.
  return callClosedSetModel(targets, signal);
}

function replaceSentinelJson(content: string, transform: (value: JsonRecord) => JsonRecord): string {
  return content.replace(
    /<!-- DIAGNOSIS_JSON_START -->\s*([\s\S]*?)\s*<!-- DIAGNOSIS_JSON_END -->/g,
    (match, jsonText: string) => {
      try {
        const parsed = JSON.parse(jsonText);
        if (!parsed || typeof parsed !== "object") return match;
        return `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(transform(parsed), null, 2)}\n<!-- DIAGNOSIS_JSON_END -->`;
      } catch {
        return match;
      }
    },
  );
}

export async function annotateM03ControlledTerminology(
  content: string,
  signal?: AbortSignal,
  // 病历原文。用于让口语症状也能映射到受控中成药概念——M03 结论字段覆盖不到"医生用口语
  // 写了一个症状"这个场景。缺省为空串时行为与此前完全一致。
  patientNarrative = "",
): Promise<string> {
  if (!enabled() || signal?.aborted) return content;
  const config = getControlledTerminologyModelConfig();
  if (!config.configured) return content;
  let reasoning: JsonRecord | undefined;
  content.replace(
    /<!-- DIAGNOSIS_JSON_START -->\s*([\s\S]*?)\s*<!-- DIAGNOSIS_JSON_END -->/,
    (_match, jsonText: string) => {
      try {
        const parsed = JSON.parse(jsonText);
        if (parsed?.stage === "diagnose") reasoning = parsed;
      } catch {
        reasoning = undefined;
      }
      return _match;
    },
  );
  if (!reasoning) return content;
  const targets = extractM03Targets(reasoning, patientNarrative);
  if (targets.length === 0) return content;
  await loadCache();
  const mappings: ControlledTerminologyMapping[] = [];
  const misses: ControlledSemanticTarget[] = [];
  for (const target of targets) {
    const key = targetCacheKey(target, config.model);
    const cached = memoryCache.get(key);
    const candidate = cached && target.candidates.find((item) => item.id === cached.candidateId);
    if (cached && candidate && cached.candidateFingerprint === candidateFingerprint(target)) {
      mappings.push({
        namespace: target.namespace,
        fieldPath: target.fieldPath,
        originalText: target.input,
        candidateId: candidate.id,
        canonical: candidate.canonical,
        resolvedBy: "deepseek_closed_set",
        status: "suggested",
        confidence: cached.confidence,
        model: config.model,
        consensus: true,
        cache: "hit",
      });
    } else {
      misses.push(target);
    }
  }
  const modelMisses = misses.filter((target) => !hasFreshNoConsensus(
    targetCacheKey(target, config.model),
    candidateFingerprint(target),
  ));
  if (modelMisses.length > 0 && !signal?.aborted) {
    const [first, second] = await Promise.all([
      callClosedSetModelWithOneRetry(modelMisses, signal),
      callClosedSetModelWithOneRetry(modelMisses, signal),
    ]);
    const firstByKey = new Map(first.map((item) => [item.key, item]));
    const secondByKey = new Map(second.map((item) => [item.key, item]));
    const minimumConfidence = Math.min(0.99, Math.max(0.5,
      Number(process.env.CONTROLLED_TERMINOLOGY_MIN_CONFIDENCE || 0.8)));
    for (const target of modelMisses) {
      const accepted = validatedConsensusDecision(
        target,
        firstByKey.get(target.key),
        secondByKey.get(target.key),
        minimumConfidence,
      );
      if (!accepted) {
        // 只有模型确实对该目标给出了裁决（含 candidateId=null 弃权）才负缓存；
        // 两腿都没返回该 key（超时/传输失败）时不缓存，保持重试语义。
        if (firstByKey.has(target.key) || secondByKey.has(target.key)) {
          rememberNoConsensus(targetCacheKey(target, config.model), candidateFingerprint(target));
        }
        continue;
      }
      const mapping: ControlledTerminologyMapping = {
        namespace: target.namespace,
        fieldPath: target.fieldPath,
        originalText: target.input,
        candidateId: accepted.candidate.id,
        canonical: accepted.candidate.canonical,
        resolvedBy: "deepseek_closed_set",
        status: "suggested",
        confidence: accepted.confidence,
        model: config.model,
        consensus: true,
        cache: "miss",
      };
      mappings.push(mapping);
      const key = targetCacheKey(target, config.model);
      memoryCache.set(key, {
        key,
        namespace: target.namespace,
        normalizedInput: normalizeControlledSemanticText(target.input),
        candidateId: accepted.candidate.id,
        canonical: accepted.candidate.canonical,
        confidence: accepted.confidence,
        model: config.model,
        candidateFingerprint: candidateFingerprint(target),
        createdAt: new Date().toISOString(),
      });
    }
    if (mappings.some((item) => item.cache === "miss")) queueCacheWrite();
  }
  if (mappings.length === 0) return content;
  return replaceSentinelJson(content, (parsed) => ({
    ...parsed,
    terminologyMappings: mappings,
  }));
}

async function runProbe() {
  const config = getControlledTerminologyModelConfig();
  if (!enabled()) return { ok: false, reason: "disabled" as const, model: getPublicTextModelStatus(config) };
  if (!config.configured) return { ok: false, reason: "not_configured" as const, model: getPublicTextModelStatus(config) };
  const target = makeTarget("probe", "tcm_syndrome", "probe", "痰热扰神证", 12);
  if (!target) return { ok: false, reason: "candidate_prefilter_unavailable" as const, model: getPublicTextModelStatus(config) };
  const [first, second] = await Promise.all([
    callClosedSetModelWithOneRetry([target]),
    callClosedSetModelWithOneRetry([target]),
  ]);
  const accepted = validatedConsensusDecision(
    target,
    first.find((item) => item.key === "probe"),
    second.find((item) => item.key === "probe"),
    Math.min(0.99, Math.max(0.5, Number(process.env.CONTROLLED_TERMINOLOGY_MIN_CONFIDENCE || 0.8))),
  );
  const valid = accepted?.candidate.canonical === "痰火扰神";
  if (!valid || !accepted) {
    return {
      ok: false,
      reason: "semantic_mapping_consensus_mismatch" as const,
      model: getPublicTextModelStatus(config),
      expectedCandidate: "痰火扰神",
      selectedCandidate: accepted?.candidate.canonical,
      confidence: accepted?.confidence,
      persistentCacheVerified: false,
    };
  }
  await loadCache();
  const key = targetCacheKey(target, config.model);
  memoryCache.set(key, {
    key,
    namespace: target.namespace,
    normalizedInput: normalizeControlledSemanticText(target.input),
    candidateId: accepted.candidate.id,
    canonical: accepted.candidate.canonical,
    confidence: accepted.confidence,
    model: config.model,
    candidateFingerprint: candidateFingerprint(target),
    createdAt: new Date().toISOString(),
  });
  const persistentCacheVerified = await persistCacheAndVerifyEntry(key);
  return {
    ok: persistentCacheVerified,
    reason: persistentCacheVerified ? "ok" as const : "cache_persistence_unavailable" as const,
    model: getPublicTextModelStatus(config),
    expectedCandidate: "痰火扰神",
    selectedCandidate: accepted.candidate.canonical,
    confidence: accepted.confidence,
    persistentCacheVerified,
  };
}

export async function probeControlledTerminologyModel() {
  if (probeCache && probeCache.expiresAt > Date.now()) return { ...probeCache.value, cached: true };
  const value = await runProbe();
  probeCache = { expiresAt: Date.now() + PROBE_CACHE_TTL_MS, value };
  return { ...value, cached: false };
}

export function getControlledTerminologyNormalizationStatus() {
  const config = getControlledTerminologyModelConfig();
  return {
    enabled: enabled(),
    mode: "deterministic_exact_then_prefilter_then_deepseek_closed_set_consensus",
    replacementPolicy: "suggestion_only_until_clinician_confirmation",
    model: getPublicTextModelStatus(config),
    consensusRequired: true,
    minimumConfidence: Math.min(0.99, Math.max(0.5,
      Number(process.env.CONTROLLED_TERMINOLOGY_MIN_CONFIDENCE || 0.8))),
    cache: {
      pathConfigured: Boolean(process.env.CONTROLLED_TERMINOLOGY_CACHE_PATH?.trim()),
      persistentFile: cachePath(),
      entryCount: memoryCache.size,
    },
    forbiddenNamespaces: ["tcm_herb_identity", "dose_boundary", "deterministic_red_flag_floor"],
  };
}
