import "server-only";

import icdIndex from "../data/icd10-diagnosis-index.json" with { type: "json" };
import { crossModelJsonTask, parseConfirmed, proposeThenVerify } from "./cross-model-small-task.server";
import preferredNames from "../data/western-name-preferred.source.json" with { type: "json" };
import criteriaJson from "../data/western-diagnostic-criteria.source.json" with { type: "json" };
import { resolveIcd10Diagnosis } from "./icd10-diagnosis-coding.server";
import { quoteGroundedInText } from "./verbatim-quote";
import { isCleanWesternDiagnosisName } from "./western-name-evidence-check.server";

/**
 * 西医主诊断的两件收尾（2026-10-31，甲方 10.29 测评），都是两个不同厂商的模型一致才动，失败原样交付：
 *
 * 一、已确诊慢性病关联主症。「老年患者有高血压病史，以眩晕为症状就诊，相关联西医诊断一般直接关联高血压病」，交付的是「眩晕综合征」，4 次都是。
 *     当前名是症状层面（ICD-10 R 章、查不到编码或带待查）时问：病历既往史明确写着的已确诊慢性病，是不是这次主症最常见的解释。要交既往史逐字摘录。
 *     高血压之于咳嗽不成立；红旗病例不走这里，原名留在候选与鉴别。
 * 二、病名写法归到 ICD-10 医保版。「慢性失眠障碍不属于标准诊断」。名字查不到编码时，按字面相近从 38,442 条名称里取 8 条，问有没有和它**同义**的；
 *     只认闭集里的写法，范围变宽或变窄都不算同义。查不到的、没有同义项的不动。
 * 开关：CDSS_WESTERN_NAME_STANDARD=false。
 */
const TIMEOUT_MS = 4_000;

export function westernNameStandardEnabled(): boolean {
  return process.env.CDSS_WESTERN_NAME_STANDARD !== "false";
}

const PAST_DISEASE_MENTION = /病史|既往/u;

type Json = Record<string, unknown>;
const record = (value: unknown): Json | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";

/** 要不要问「已确诊慢性病能不能解释」：症状层面（R 章、查不到、待查）或笼统的综合征写法（眩晕综合征 H81.901 在 ICD 里有编码，说的仍是症状）。 */
export function primaryNameIsSymptomLevel(name: string): boolean {
  if (/待查$|综合征$/u.test(name)) return true;
  const code = resolveIcd10Diagnosis(name)?.code;
  return !code || code.startsWith("R");
}

/** 诊断标准表里收的病名已经是临床规范写法（围绝经期综合征），不再往 ICD 同义词上归。 */
const CRITERIA_NAMES = new Set(((criteriaJson as unknown as { entries?: Array<{ name: string }> }).entries || []).map((entry) => entry.name));
const PREFERRED = (preferredNames as { names: Record<string, string> }).names;

const LINK_SYSTEM = [
  "你是全科主治医师。当前西医诊断只写到症状或笼统的综合征层面（已是明确病因的病名时答 null）。判断：病历既往史明确写着的、已确诊的慢性病，是不是这次主诉主症最常见的原因。",
  "是：高血压病史多年、这次头晕；冠心病史、这次活动后胸闷。不是：高血压病史、这次咳嗽；只有家族史、“可疑”“待查”的病。",
  "name 写规范病名（如 高血压病），quote 从病历逐字摘录写明这个病的那一句，rationale 用不超过80字说明这次主症与它的关系、以及还要排除什么。不成立时 established 为 null。",
  "只输出 JSON：{\"established\":null} 或 {\"established\":{\"name\":\"\",\"quote\":\"\",\"rationale\":\"\"}}",
].join("\n");

type Established = { name: string; quote: string; rationale: string } | null;

function parseLink(content: unknown): Established | undefined {
  if (typeof content !== "string" || !content.trim()) return undefined;
  try {
    const root = record(JSON.parse(content));
    if (!root || !("established" in root)) return undefined;
    const item = record(root.established);
    if (!item) return null;
    const name = text(item.name);
    return name ? { name, quote: text(item.quote), rationale: text(item.rationale) } : null;
  } catch {
    return undefined;
  }
}

const LINK_VERIFY_SYSTEM = [
  "你是全科主治医师。门诊写诊断的习惯：已确诊的慢性病能解释这次主症时，西医诊断直接写这个病，不写症状（高血压病史的老人以头晕就诊，诊断写高血压病）。",
  "判断这次主诉主症是不是这个慢性病的常见表现。不要求是唯一解释，也不要求先排除别的原因；只有这个病一般不引起这个症状时才答 false（高血压病之于咳嗽、冠心病之于消瘦）。",
  "只输出 JSON：{\"confirmed\":true} 或 {\"confirmed\":false}",
].join("\n");

/** 提名是否合格（纯函数）：干净的病名、摘录逐字在病历里、摘录里确实写着这个病（去掉「病」字后）。 */
export function establishedDiseaseQualifies(candidate: { name: string; quote: string }, recordText: string): boolean {
  if (!isCleanWesternDiagnosisName(candidate.name) || /待查$/u.test(candidate.name)) return false;
  if (!quoteGroundedInText(candidate.quote, recordText)) return false;
  return candidate.quote.includes(candidate.name.replace(/病$/u, ""));
}

const NAME_SYSTEM = [
  "你是病案编码员。判断 candidates 里有没有和 name 指同一种病的写法。必须是同义词：范围变宽（上位病名）、变窄（亚型）、不同病都不算。",
  "有就原样抄出那一条，没有就给 null。只输出 JSON：{\"same\":\"候选原文或null\"}",
].join("\n");

const ICD_NAMES: readonly string[] = (icdIndex as unknown as { entries?: Array<{ name: string }> }).entries?.map((entry) => entry.name) || [];

/** 字面最相近的几条 ICD 名称（按共有二字片段的 Dice 系数）。 */
export function icdLexicalCandidates(name: string, limit = 8): string[] {
  const grams = (value: string) => new Set([...value].slice(0, -1).map((char, index) => char + value[index + 1]));
  const wanted = grams(name);
  if (wanted.size === 0) return [];
  return ICD_NAMES
    .map((candidate) => {
      const other = grams(candidate);
      const shared = [...other].filter((gram) => wanted.has(gram)).length;
      return { candidate, score: shared === 0 ? 0 : (2 * shared) / (wanted.size + other.size) };
    })
    .filter((item) => item.score >= 0.3)
    .sort((left, right) => right.score - left.score || left.candidate.length - right.candidate.length)
    .slice(0, limit)
    .map((item) => item.candidate);
}

function parseSame(content: unknown): { same: string | null } | undefined {
  if (typeof content !== "string" || !content.trim()) return undefined;
  try {
    const root = record(JSON.parse(content));
    if (!root || !("same" in root)) return undefined;
    const same = text(root.same);
    return { same: same && same !== "null" ? same : null };
  } catch {
    return undefined;
  }
}

/** 这个名字要不要往 ICD 同义词上归：ICD 查得到的、诊断标准表收了的都不用。 */
export function icdSynonymEligible(bareName: string): boolean {
  return !resolveIcd10Diagnosis(bareName) && !CRITERIA_NAMES.has(bareName);
}

/** 同义的 ICD 写法（两边给同一条且在候选闭集里）。保留「待查」。 */
export async function standardIcdSynonym(name: string, signal?: AbortSignal): Promise<string | undefined> {
  const bare = name.replace(/待查$/u, "");
  if (!icdSynonymEligible(bare)) return undefined;
  const candidates = icdLexicalCandidates(bare);
  if (candidates.length === 0) return undefined;
  const pair = await crossModelJsonTask("western_name_standard", "diagnose", [
    { role: "system", content: NAME_SYSTEM },
    { role: "user", content: JSON.stringify({ name: bare, candidates }) },
  ], { maxTokens: 80, timeoutMs: TIMEOUT_MS }, parseSame, signal);
  if (!pair || !pair[0].same || pair[0].same !== pair[1].same || !candidates.includes(pair[0].same)) return undefined;
  return `${pair[0].same}${/待查$/u.test(name) ? "待查" : ""}`;
}

/** 西医半收尾。redFlag 病例、解析不了时原样返回。 */
export async function finalizeWesternPrimaryName(
  westernContent: string,
  context: { recordText: string; redFlag?: boolean },
  signal?: AbortSignal,
): Promise<string> {
  if (!westernNameStandardEnabled()) return westernContent;
  let root: Json | undefined;
  try { root = record(JSON.parse(westernContent)); } catch { return westernContent; }
  const western = record(root?.westernDiagnosis);
  const primary = record(western?.primary);
  const name = text(primary?.name);
  if (!root || !western || !primary || !name) return westernContent;
  const previous = name;
  let established: Exclude<Established, null> | undefined;
  if (!context.redFlag && primaryNameIsSymptomLevel(name) && PAST_DISEASE_MENTION.test(context.recordText)) {
    const proposal = await proposeThenVerify<Established>("western_established_link", "diagnose", {
      messages: [
        { role: "system", content: LINK_SYSTEM },
        { role: "user", content: JSON.stringify({ current: name, record: context.recordText.slice(0, 2_400) }) },
      ],
      maxTokens: 240,
      parse: parseLink,
    }, (candidate) => (establishedDiseaseQualifies(candidate, context.recordText)
      ? {
          messages: [
            { role: "system", content: LINK_VERIFY_SYSTEM },
            { role: "user", content: JSON.stringify({ current: name, proposed: candidate.name, quote: candidate.quote, chiefComplaint: context.recordText.split("\n").slice(0, 3).join(" ").slice(0, 200) }) },
          ],
          maxTokens: 40,
          parse: parseConfirmed,
        }
      : undefined), TIMEOUT_MS, signal);
    established = proposal ?? undefined;
  }
  const preferred = PREFERRED[name.replace(/待查$/u, "")];
  const next = established?.name ?? (preferred ? `${preferred}${/待查$/u.test(name) ? "待查" : ""}` : await standardIcdSynonym(name, signal));
  if (!next || next === name) return westernContent;
  primary.name = next;
  if (established?.rationale) primary.clinicalRationale = established.rationale;
  // 原名留在候选与鉴别（医生还看得到这个方向）；同义归一不留，是同一个病。
  if (established) {
    for (const key of ["candidates", "differentials"] as const) {
      const list = Array.isArray(western[key]) ? western[key] as Json[] : [];
      if (!list.some((item) => text(record(item)?.name) === previous)) {
        western[key] = [{ name: previous, ...(key === "differentials" ? { distinguishingPoints: "以此症就诊，已确诊的慢性病可以解释，仍需排除其他原因", nextCheck: "结合查体与必要检查" } : { keyEvidence: [] }) }, ...list];
      }
    }
  }
  console.info("[tcm-cdss:telemetry] western_name_standard", { kind: established ? "established_link" : "icd_synonym" });
  return JSON.stringify(root);
}
