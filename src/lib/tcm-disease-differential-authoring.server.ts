import "server-only";

import { canonicalTcmSyndromeTerm } from "./clinical-governance-tables";
import { memoizedSmallTask, smallTaskMemoKey } from "./small-task-memo.server";
import { createTextModelClient, getControlledTerminologyModelConfig, textModelRequestTuning } from "./text-model";
import { observeModelTask } from "./cdss-model-task-telemetry";
import { MIN_TCM_DIFFERENTIALS, WESTERN_DISEASE_FORM, resolveTcmDiseaseDifferentialName } from "./tcm-disease-differential-normalization";
import { textbookCandidatesForCase, textbookDiseaseNamesForCase, textbookDifferentialsForDisease } from "./tcm-textbook-syndromes";

/**
 * 中医鉴别（病名级、证候级）不足两项时，只补写缺的那几项（2026-10-14 起补写病名级为空的；2026-10-19 第九轮改为补到两项）。
 *
 * 甲方验收「鉴别诊断覆盖率 ≥90%：存在明显需鉴别病种/证候时，至少各有 2 条，遗漏判负」。第八轮 1081 份输出里病名鉴别不足两条的有三成：
 * 提示词原先写「每例 1–2 项」，模型写一条就算守约；教材对 331 个病名只有 123 个列有两个以上能留在交付结果里的中医病证名。
 *
 * 做法承袭 10.12 整改方案的「只重写这一项」：模型已写的、能留下的鉴别原样保留，缺几项就补几项；补写的小任务对着本例病历写区分要点，
 * 教材所列的鉴别病证是闭集候选（教材原文只作知识来源，不再直接贴给医生）。服务端只核对：病名过同一个归一判据
 *（resolveTcmDiseaseDifferentialName：只收中医病名，西医病名丢掉）、不重复、区分要点确实在说本例。
 * 证候鉴别同理：候选取教材该病下的其他证型，教材没有时由模型提出、并要过受治理证候词表。
 *
 * 边界：
 *  · 只在保留下来的鉴别少于两项时调用，其余病例不多一次调用；病名与证候两项并行，各自超时互不影响；
 *  · 教材所列的鉴别病证不足时，由模型提出中医病名补足，名字仍过同一个归一函数；
 *  · 证候鉴别只在模型已经写了至少一项时补（模型整栏留空并写明「资料不足以鉴别」的，不替它改口）；
 *  · 只写 overview.tcmDiseaseDifferentials / tcmDifferentials 这两项，不动病名、证候与其余字段；之后照常走既有的归一、接地与签名；
 *  · 超时、未配置、输出非法都原样返回——交付面的教材原文兜底仍在。
 * 开关：CDSS_TCM_DIFFERENTIAL_AUTHORING=false 关闭。
 */
const TIMEOUT_MS = (() => {
  const value = Number(process.env.TCM_DIFFERENTIAL_AUTHORING_TIMEOUT_MS || 6_000);
  return Number.isFinite(value) && value >= 2_000 && value <= 12_000 ? Math.round(value) : 6_000;
})();
const MAX_RECORD_CHARS = 1_800;
/** 单次补写最多几项（病名、证候都一样）。 */
const MAX_ENTRIES = MIN_TCM_DIFFERENTIALS;
/** 给模型看的教材候选个数上限。 */
const MAX_CANDIDATES = 4;

function enabled(): boolean {
  return process.env.CDSS_TCM_DIFFERENTIAL_AUTHORING !== "false";
}

/** 教材所列不够时，给模型一份规范中医病名的闭集（教材病名）供选，而不是让它凭记忆写；CDSS_TCM_DIFFERENTIAL_NAME_LIST=false 关闭。 */
function nameListEnabled(): boolean {
  return process.env.CDSS_TCM_DIFFERENTIAL_NAME_LIST !== "false";
}

export type AuthoredTcmDiseaseDifferential = {
  diseaseName: string;
  reason: string;
  typicalManifestation: string;
  distinguishingPoints: string;
  nextCheck: string | null;
};

export type AuthoredTcmSyndromeDifferential = {
  syndrome: string;
  reason: string;
  typicalManifestation: string;
  distinguishingPoints: string;
  nextCheck: string | null;
};

const text = (value: unknown) => typeof value === "string" ? value.trim().replace(/\s+/g, "") : "";

/** 模型输出 → 可用的鉴别条目：名字过 accept，区分要点以「本例」起头、确实在说本例，各栏长度合规。 */
function parseAuthoredEntries<K extends "diseaseName" | "syndrome">(
  content: unknown,
  nameKey: K,
  accept: (name: string) => string | undefined,
  max: number,
): Array<Record<K, string> & { reason: string; typicalManifestation: string; distinguishingPoints: string; nextCheck: string | null }> {
  if (typeof content !== "string" || !content.trim()) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { return []; }
  const list = parsed && typeof parsed === "object" ? (parsed as { differentials?: unknown }).differentials : undefined;
  if (!Array.isArray(list)) return [];
  const out: Array<Record<K, string> & { reason: string; typicalManifestation: string; distinguishingPoints: string; nextCheck: string | null }> = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const name = accept(text(item[nameKey])) || "";
    const distinguishingPoints = text(item.distinguishingPoints);
    const typicalManifestation = text(item.typicalManifestation);
    const reason = text(item.reason);
    const nextCheck = text(item.nextCheck);
    if (!name || out.some((entry) => entry[nameKey] === name)) continue;
    if (!/^本例/.test(distinguishingPoints) || distinguishingPoints.length < 8 || distinguishingPoints.length > 70) continue;
    if (typicalManifestation.length < 4 || typicalManifestation.length > 60) continue;
    if (reason.length < 2 || reason.length > 30) continue;
    if (/教材|原文|定义为/.test(`${distinguishingPoints}${reason}`)) continue;
    out.push({
      [nameKey]: name, reason, typicalManifestation, distinguishingPoints, nextCheck: nextCheck && nextCheck.length <= 30 ? nextCheck : null,
    } as Record<K, string> & { reason: string; typicalManifestation: string; distinguishingPoints: string; nextCheck: string | null });
    if (out.length >= max) break;
  }
  return out;
}

export function parseAuthoredTcmDiseaseDifferentials(
  content: unknown,
  allowedNames: readonly string[] | ((name: string) => string | undefined),
  max = MAX_ENTRIES,
): AuthoredTcmDiseaseDifferential[] {
  const allowed = typeof allowedNames === "function" ? undefined : new Set(allowedNames);
  const accept = (name: string) => allowed ? (allowed.has(name) ? name : undefined) : (allowedNames as (name: string) => string | undefined)(name);
  return parseAuthoredEntries(content, "diseaseName", accept, max);
}

export function parseAuthoredTcmSyndromeDifferentials(
  content: unknown,
  accept: (name: string) => string | undefined,
  max = MAX_ENTRIES,
): AuthoredTcmSyndromeDifferential[] {
  return parseAuthoredEntries(content, "syndrome", accept, max);
}

type Json = Record<string, unknown>;
const record = (value: unknown): Json | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;

/**
 * 模型写的病名鉴别里能留在交付结果里的行：病名归一得了（不是西医病名）、不与本病同名，按归一后的病名去重。
 * 与 normalizeM03TcmDiseaseDifferentialNames 同一个判据，所以这里数出来的就是交付时留下的。
 */
export function retainableDiseaseDifferentialRows(rows: unknown, diseaseName: string): Array<{ row: Json; name: string }> {
  const seen = new Set<string>();
  const out: Array<{ row: Json; name: string }> = [];
  for (const raw of Array.isArray(rows) ? rows : []) {
    const row = record(raw);
    const name = text(row?.diseaseName);
    if (!row || !name) continue;
    const resolved = resolveTcmDiseaseDifferentialName(name, diseaseName);
    if (resolved.action === "drop" || seen.has(resolved.name)) continue;
    seen.add(resolved.name);
    out.push({ row, name: resolved.name });
  }
  return out;
}

const syndromeCore = (value: string) => text(value).replace(/(?:证候|证型|证|型)$/u, "");

/** 证候鉴别里有名字的行（与主证候同名的不算一项），按去掉「证/型」后的名字去重。 */
export function retainableSyndromeDifferentialRows(rows: unknown, primarySyndrome: string): Array<{ row: Json; name: string }> {
  const seen = new Set<string>([syndromeCore(primarySyndrome)]);
  const out: Array<{ row: Json; name: string }> = [];
  for (const raw of Array.isArray(rows) ? rows : []) {
    const row = record(raw);
    const name = text(row?.syndrome);
    if (!row || !name || seen.has(syndromeCore(name))) continue;
    seen.add(syndromeCore(name));
    out.push({ row, name });
  }
  return out;
}

type SmallTaskInput = { recordText: string; diseaseName: string; syndrome: string };

async function runAuthoringTask<T>(
  task: string,
  messages: Array<{ role: "system" | "user"; content: string }>,
  parse: (content: unknown) => T[],
  maxTokens: number,
  signal?: AbortSignal,
): Promise<T[]> {
  const config = getControlledTerminologyModelConfig();
  if (!config.configured || signal?.aborted) return [];
  return memoizedSmallTask<T[]>(task, smallTaskMemoKey([config.model, messages]), async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await observeModelTask({ task, stage: "diagnose", model: config.model }, () => createTextModelClient(config).chat.completions.create({
        model: config.model,
        temperature: 0,
        max_tokens: maxTokens,
        stream: false,
        response_format: { type: "json_object" },
        ...textModelRequestTuning(config.model, { reasoningEffort: "low", thinkingEnabled: false }),
        messages,
      }, { signal: controller.signal }));
      const value = parse(response.choices[0]?.message?.content);
      return { value, cacheable: value.length > 0 };
    } catch {
      return { value: [] as T[], cacheable: false };
    } finally {
      clearTimeout(timer);
    }
  }, [], signal);
}

const OUTPUT_FORMAT_DISEASE = "只输出 JSON：{\"differentials\":[{\"diseaseName\":\"…\",\"reason\":\"…\",\"typicalManifestation\":\"…\",\"distinguishingPoints\":\"本例…\",\"nextCheck\":\"…\"}]}";
const OUTPUT_FORMAT_SYNDROME = "只输出 JSON：{\"differentials\":[{\"syndrome\":\"…\",\"reason\":\"…\",\"typicalManifestation\":\"…\",\"distinguishingPoints\":\"本例…\",\"nextCheck\":\"…\"}]}";

/**
 * 补写病名级鉴别。existing 是已经保留下来的（归一后的）病名；candidates 是教材对本病所列、且过得了归一判据的鉴别病名。
 *  · 候选够补（≥ need）：闭集，病名只能取自候选；
 *  · 候选不够（含没有）：优先取候选，其余由模型另提中医病名，名字过 resolveTcmDiseaseDifferentialName。
 */
export async function authorTcmDiseaseDifferentials(
  input: SmallTaskInput & { candidates: ReadonlyArray<{ name: string; text: string }>; existing?: readonly string[]; need?: number; nameList?: readonly string[] },
  signal?: AbortSignal,
): Promise<AuthoredTcmDiseaseDifferential[]> {
  if (!enabled() || signal?.aborted) return [];
  const existing = [...(input.existing || [])];
  const need = Math.min(MAX_ENTRIES, Math.max(1, input.need ?? MIN_TCM_DIFFERENTIALS - existing.length));
  const recordText = input.recordText.slice(0, MAX_RECORD_CHARS);
  if (!recordText.trim()) return [];
  const candidates = input.candidates.slice(0, MAX_CANDIDATES);
  const names = candidates.map((item) => item.name);
  const closed = candidates.length >= need;
  const taken = new Set([...existing, input.diseaseName.trim()]);
  const acceptName = closed
    ? (name: string) => names.includes(name) ? name : undefined
    : (name: string) => {
      if (names.includes(name)) return name;
      // 模型另提的名字：过归一判据，并且不是西医构词的名字（教材有的节以西医病名立节，如骨关节炎、接触性皮炎；教材明确列为本病鉴别的才可用，
      // 那条路走上面的候选；这里是模型自行提出的，只收中医病名——甲方 9.24：中医鉴别只列中医病名）。
      const resolved = resolveTcmDiseaseDifferentialName(name, input.diseaseName);
      return resolved.action === "drop" || taken.has(resolved.name) || WESTERN_DISEASE_FORM.test(resolved.name) ? undefined : resolved.name;
    };
  const task = existing.length === 0
    ? `请写出 ${need} 项：临床上最需要与本病鉴别的中医病名，并对着本例病历写出据以区分的要点。`
    : `已写的病名鉴别（alreadyListed：${existing.join("、")}）不足两项。请再补 ${need} 项：临床上最需要与本病鉴别、且不在 alreadyListed 里的中医病名，并对着本例病历写出据以区分的要点。`;
  const nameList = closed ? [] : (input.nameList || []).filter((name) => !taken.has(name) && !names.includes(name));
  const fromList = nameList.length > 0 ? "tcmDiseaseNameList 是规范的中医病名清单（只能从中选），请从中选取临床上确实容易与本病混淆的（diseaseName 逐字取用）；确实都不合适才另提规范的中医病名。" : "";
  const source = closed
    ? "textbookDifferentials 是教材对本病列出的鉴别病证及原文，请从中选出本例最需要鉴别的；diseaseName 只能逐字取自其中。"
    : candidates.length > 0
      ? `textbookDifferentials 是教材对本病列出的鉴别病证及原文，优先从中选（diseaseName 逐字取用）。它们不够时，${fromList || "另提临床上确实容易与本病混淆的中医病名。"}`
      : nameList.length > 0
        ? `教材没有列出可用的中医鉴别病名。${fromList}`
        : "教材没有列出可用的中医鉴别病名，请自行提出临床上确实容易与本病混淆的中医病名。";
  const messages = [
    {
      role: "system" as const,
      content: [
        "你是中医鉴别诊断的整理者，不负责诊断，也不改变已定的病名和证候。",
        `任务：本例已定中医病名。${task}`,
        source,
        "规则：",
        `1. diseaseName 必须是中医病名${closed ? "" : "（如对咳嗽写喘证、肺痨，对胁痛写胃脘痛、黄疸）"}，不得写西医病名、证型或症状堆砌，不得与本病同名，不得是本病的别名、异名或亚型，不得与 alreadyListed 重复。`,
        "2. typicalManifestation：该鉴别病的典型表现，不超过30字。",
        "3. distinguishingPoints：本例与它的区别，必须以“本例”开头，只引用病历已记录的表现；病历没有提到的表现写“未诉…”，不要写“无…”；不要复述教材对该病的定义；不超过40字。",
        "4. reason：为什么需要与它鉴别（两者相近之处），不超过15字。",
        "5. nextCheck：必要时需要核实的一项问诊、查体或检查，不超过15字；没有就写空字符串。属急重症的鉴别病名（如真头痛、厥证、肠痈），nextCheck 必须写明相应的急症排查。",
        `${OUTPUT_FORMAT_DISEASE}（恰好 ${need} 项）`,
      ].join("\n"),
    },
    {
      role: "user" as const,
      content: JSON.stringify({
        tcmDisease: input.diseaseName,
        syndrome: input.syndrome || null,
        record: recordText,
        alreadyListed: existing,
        ...(candidates.length > 0 ? { textbookDifferentials: candidates.map((item) => ({ diseaseName: item.name, textbook: item.text.slice(0, 260) })) } : {}),
        ...(nameList.length > 0 ? { tcmDiseaseNameList: nameList } : {}),
      }),
    },
  ];
  return runAuthoringTask("tcm_disease_differential_authoring", messages, (content) => parseAuthoredTcmDiseaseDifferentials(content, acceptName, need), need > 1 ? 420 : 260, signal);
}

/**
 * 补写证候鉴别。候选取教材该病下的其他证型（名字逐字取用）；教材没有或不够时由模型另提，名字要过受治理证候词表。
 */
export async function authorTcmSyndromeDifferentials(
  input: SmallTaskInput & { candidates: ReadonlyArray<{ name: string; text: string }>; existing?: readonly string[]; need?: number },
  signal?: AbortSignal,
): Promise<AuthoredTcmSyndromeDifferential[]> {
  if (!enabled() || signal?.aborted) return [];
  const existing = [...(input.existing || [])];
  const need = Math.min(MAX_ENTRIES, Math.max(1, input.need ?? MIN_TCM_DIFFERENTIALS - existing.length));
  const recordText = input.recordText.slice(0, MAX_RECORD_CHARS);
  if (!recordText.trim() || !input.syndrome.trim()) return [];
  const candidates = input.candidates.slice(0, MAX_CANDIDATES);
  const names = candidates.map((item) => item.name);
  const closed = candidates.length >= need;
  const takenCores = new Set([...existing, input.syndrome].map(syndromeCore));
  const acceptName = (name: string) => {
    if (!name || takenCores.has(syndromeCore(name))) return undefined;
    if (names.includes(name)) return name;
    return !closed && canonicalTcmSyndromeTerm(name) ? name : undefined;
  };
  const messages = [
    {
      role: "system" as const,
      content: [
        "你是中医证候鉴别的整理者，不负责诊断，也不改变已定的病名和证候。",
        `任务：本例已定中医病名和主证候，已写的证候鉴别（alreadyListed）不足两项。请再补 ${need} 项：临床上最需要与主证候鉴别、且不在 alreadyListed 里的证候，并对着本例病历写出据以区分的要点。`,
        closed
          ? "textbookSyndromes 是教材对本病列出的其他证型及主症；syndrome 只能逐字取自其中，选与主证候最容易混淆或治法相反的。"
          : candidates.length > 0
            ? "textbookSyndromes 是教材对本病列出的其他证型及主症，优先从中选（syndrome 逐字取用）；它们不够时，另提同一病下临床上确实容易与主证候混淆的中医证候名。"
            : "教材没有列出本病的其他证型，请自行提出同一病下临床上确实容易与主证候混淆的中医证候名。",
        "规则：",
        "1. syndrome 必须是中医证候名（如肝郁气滞证），不得写病名或症状堆砌，不得与主证候（syndrome 字段）同名，不得与 alreadyListed 重复。",
        "2. typicalManifestation：该证候的典型表现（症状加舌脉），不超过30字。",
        "3. distinguishingPoints：本例哪一点对不上主证候以外的这个证候，必须以“本例”开头，只引用病历已记录的表现；病历没有提到的表现写“未诉…”，不要写“无…”；不超过40字。",
        "4. reason：为什么需要与它鉴别，不超过15字。",
        "5. nextCheck：必要时需要核实的一项四诊内容，不超过15字；没有就写空字符串。",
        `${OUTPUT_FORMAT_SYNDROME}（恰好 ${need} 项）`,
      ].join("\n"),
    },
    {
      role: "user" as const,
      content: JSON.stringify({
        tcmDisease: input.diseaseName,
        syndrome: input.syndrome,
        record: recordText,
        alreadyListed: existing,
        ...(candidates.length > 0 ? { textbookSyndromes: candidates.map((item) => ({ syndrome: item.name, textbook: item.text.slice(0, 200) })) } : {}),
      }),
    },
  ];
  return runAuthoringTask("tcm_syndrome_differential_authoring", messages, (content) => parseAuthoredTcmSyndromeDifferentials(content, acceptName, need), need > 1 ? 420 : 260, signal);
}

/** 教材对本病列出的鉴别病名里，能留在交付结果里的（过同一个归一判据）、不在 taken 里的。 */
function textbookDiseaseCandidates(diseaseName: string, taken: ReadonlySet<string>): Array<{ name: string; text: string }> {
  return textbookDifferentialsForDisease(diseaseName, 50)
    .filter((item) => !taken.has(item.name) && resolveTcmDiseaseDifferentialName(item.name, diseaseName).action === "keep")
    .map((item) => ({ name: item.name, text: item.text }));
}

const nameListCache = new Map<string, string[]>();
/**
 * 规范中医病名闭集：本例可选的教材病名（按科别：男性不取妇科，未成年取儿科等），去掉本病与归一判据不收的（同一病的别名、被改名后与本病同名的）。
 * 只是名字清单，不含病例信息；同一个（病名, 年龄段, 性别）只算一次。
 */
function governedDiseaseNameList(diseaseName: string, patient?: { sex?: string; age?: number }): string[] {
  const key = `${diseaseName}|${patient?.sex || ""}|${typeof patient?.age === "number" ? patient.age : ""}`;
  const cached = nameListCache.get(key);
  if (cached) return cached;
  const list = textbookDiseaseNamesForCase({ sex: patient?.sex, ageYears: patient?.age })
    .filter((name) => name !== diseaseName && !WESTERN_DISEASE_FORM.test(name) && resolveTcmDiseaseDifferentialName(name, diseaseName).action === "keep");
  if (nameListCache.size > 200) nameListCache.clear();
  nameListCache.set(key, list);
  return list;
}

/** 教材该病下的其他证型（按与本例表现的相近程度排序），不含 taken 里的。 */
function textbookSyndromeCandidates(diseaseName: string, recordText: string, taken: ReadonlySet<string>): Array<{ name: string; text: string }> {
  const disease = textbookCandidatesForCase({ diseaseName, chiefComplaint: "", presentHistory: recordText }, { maxDiseases: 6, maxRowsPerDisease: 12 })
    .find((item) => text(item.disease) === text(diseaseName).replace(/类病$/u, ""));
  if (!disease) return [];
  return disease.rows
    .filter((row) => row.syndromeName && !taken.has(syndromeCore(row.syndromeName)))
    .map((row) => ({ name: row.syndromeName, text: [row.manifestations, row.tongue, row.pulse].filter(Boolean).join("；") }));
}

type TopUpContext = { recordText: string; patient?: { sex?: string; age?: number } };
type TopUpPlan = {
  diseaseName: string;
  primary: string;
  diseaseRows: Array<{ row: Json; name: string }>;
  syndromeRows: Array<{ row: Json; name: string }>;
  needDisease: number;
  needSyndrome: number;
  diseaseInput?: Parameters<typeof authorTcmDiseaseDifferentials>[0];
  syndromeInput?: Parameters<typeof authorTcmSyndromeDifferentials>[0];
};

/**
 * 看中医半的 overview 缺几项、该向小任务要什么。收口与流式预取走同一个函数：两边发出的请求逐字相同，预取的结果才会被收口命中
 *（memoizedSmallTask 按请求内容合流，在途的也合）。
 */
function planTopUp(overview: Json | undefined, context: TopUpContext): TopUpPlan | undefined {
  const diseaseName = text(overview?.tcmDiseaseName);
  if (!overview || !diseaseName) return undefined;
  const primary = text(overview.primarySyndrome);
  const diseaseRows = retainableDiseaseDifferentialRows(overview.tcmDiseaseDifferentials, diseaseName);
  const syndromeRows = retainableSyndromeDifferentialRows(overview.tcmDifferentials, primary);
  const needDisease = Math.max(0, MIN_TCM_DIFFERENTIALS - diseaseRows.length);
  // 证候鉴别：模型已经写了至少一项才补；整栏留空的（常伴「资料不足以鉴别」的说明）不替它改口。
  const needSyndrome = primary && syndromeRows.length > 0 && overview.primarySyndromeResolution !== "unresolved"
    ? Math.max(0, MIN_TCM_DIFFERENTIALS - syndromeRows.length)
    : 0;
  const plan: TopUpPlan = { diseaseName, primary, diseaseRows, syndromeRows, needDisease, needSyndrome };
  const recordText = context.recordText;
  if (needDisease > 0) {
    const taken = new Set([diseaseName, ...diseaseRows.map((item) => item.name)]);
    const candidates = textbookDiseaseCandidates(diseaseName, taken);
    plan.diseaseInput = {
      recordText, diseaseName, syndrome: primary, candidates, existing: diseaseRows.map((item) => item.name), need: needDisease,
      nameList: nameListEnabled() && candidates.length < needDisease ? governedDiseaseNameList(diseaseName, context.patient) : [],
    };
  }
  if (needSyndrome > 0) {
    const taken = new Set([primary, ...syndromeRows.map((item) => item.name)].map(syndromeCore));
    plan.syndromeInput = {
      recordText, diseaseName, syndrome: primary, candidates: textbookSyndromeCandidates(diseaseName, recordText, taken),
      existing: syndromeRows.map((item) => item.name), need: needSyndrome,
    };
  }
  return plan;
}

function runTopUp(plan: TopUpPlan, signal?: AbortSignal): Promise<[AuthoredTcmDiseaseDifferential[], AuthoredTcmSyndromeDifferential[]]> {
  return Promise.all([
    plan.diseaseInput ? authorTcmDiseaseDifferentials(plan.diseaseInput, signal) : Promise.resolve([] as AuthoredTcmDiseaseDifferential[]),
    plan.syndromeInput ? authorTcmSyndromeDifferentials(plan.syndromeInput, signal) : Promise.resolve([] as AuthoredTcmSyndromeDifferential[]),
  ]);
}

/**
 * 流式预取（2026-10-19）：中医半的 overview 一闭合（约在全文三成到四成处，其后还有病机链、治法、随访几大段要写），
 * 就按已写出的鉴别预先发出补写请求；中医半写完、收口时同一请求直接命中，补写不占 M03 的关键路径。
 * 请求内容与收口逐字相同才命中，不相同（模型后文改了什么、重写了一轮）只是多发一次小请求，结果不会被误用。
 * 纯增益：任何失败都吞掉。CDSS_SMALL_TASK_MEMO=false 时没有合流，预取不发。
 */
export function prefetchTcmDifferentialTopUp(overview: unknown, context: TopUpContext): void {
  if (!enabled() || process.env.CDSS_SMALL_TASK_MEMO === "false") return;
  try {
    const plan = planTopUp(record(overview), context);
    if (!plan || (plan.needDisease === 0 && plan.needSyndrome === 0)) return;
    console.info("[tcm-cdss:telemetry] tcm_disease_differential_prefetch", { need: plan.needDisease, syndromeNeed: plan.needSyndrome });
    void runTopUp(plan).catch(() => undefined);
  } catch {
    // 预取是纯增益。
  }
}

/**
 * 中医半返回后的收口：病名鉴别、证候鉴别保留下来的少于两项时，补到两项。其余情况与任何失败都原样返回。
 */
export async function completeTcmDiseaseDifferentials(
  tcmContent: string,
  context: TopUpContext,
  signal?: AbortSignal,
): Promise<string> {
  if (!enabled()) return tcmContent;
  let root: Json | undefined;
  try { root = record(JSON.parse(tcmContent)); } catch { return tcmContent; }
  const overview = record(root?.overview);
  const plan = planTopUp(overview, context);
  if (!root || !overview || !plan) return tcmContent;
  console.info("[tcm-cdss:telemetry] tcm_disease_differential_count", {
    written: Array.isArray(overview.tcmDiseaseDifferentials) ? overview.tcmDiseaseDifferentials.length : 0,
    retainable: plan.diseaseRows.length,
    syndromes: plan.syndromeRows.length,
  });
  if (plan.needDisease === 0 && plan.needSyndrome === 0) return tcmContent;
  const waitStarted = Date.now();
  const [diseaseAuthored, syndromeAuthored] = await runTopUp(plan, signal);
  console.info("[tcm-cdss:telemetry] tcm_disease_differential_authoring", {
    candidates: plan.diseaseInput?.candidates.length ?? 0,
    open: (plan.diseaseInput?.candidates.length ?? 0) < plan.needDisease,
    need: plan.needDisease,
    retained: plan.diseaseRows.length,
    authored: diseaseAuthored.length,
    syndromeNeed: plan.needSyndrome,
    syndromeAuthored: syndromeAuthored.length,
    // 收口在这里等了多久（预取命中时接近 0；这才是补写加在 M03 关键路径上的时间）。
    waitMs: Date.now() - waitStarted,
  });
  if (diseaseAuthored.length === 0 && syndromeAuthored.length === 0) return tcmContent;
  if (diseaseAuthored.length > 0) overview.tcmDiseaseDifferentials = [...plan.diseaseRows.map((item) => item.row), ...diseaseAuthored];
  if (syndromeAuthored.length > 0) overview.tcmDifferentials = [...plan.syndromeRows.map((item) => item.row), ...syndromeAuthored];
  return JSON.stringify(root);
}
