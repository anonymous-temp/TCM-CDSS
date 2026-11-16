import "server-only";

import { isAllowedWesternEvidenceUrl, westernEvidenceTitleMatches } from "./western-evidence-policy";
import { symptomLevelWesternName } from "./western-symptom-name.server";
import { webSearchGovernedTerm } from "./deepseek-web-search.server";

/**
 * 西医诊断标准要点（2026-10-18）。给西医病名一致性核对（western-name-evidence-check）当参照：这个病能不能按临床表现诊断、
 * 确诊要依赖哪些检查、有没有病程门槛。
 *
 * 来源两级：
 *  1. 受治理的要点表 src/data/western-diagnostic-criteria.source.json（scripts/build-western-diagnostic-criteria.mjs 由 DeepSeek Search
 *     找权威页面、抽取要点，每条带网址、站名与逐字核对过的原文）；
 *  2. 表里没有的病名：现场检索「<病名> 诊断标准」，白名单内、标题对题、中文优先的前两条摘要（不抽取、不改写），2 秒软超时，失败就没有参照。
 * 查询词只用病名本身，不含病历内容。表随源码构建；引用查表没有文件读写或网络副作用。
 */
import { westernCriteriaEntry, type WesternCriteriaEntry } from "./western-criteria-table";
export { westernCriteriaEntry, westernNameWithoutCourseOrSideQualifier } from "./western-criteria-table";
export type { WesternCriteriaEntry } from "./western-criteria-table";

export type WesternCriteriaReference =
  | { kind: "table"; entry: WesternCriteriaEntry }
  | { kind: "search"; excerpts: Array<{ siteName: string; title: string; summary: string; url: string }> };

export async function westernCriteriaReference(name: string, signal?: AbortSignal): Promise<WesternCriteriaReference | undefined> {
  const entry = westernCriteriaEntry(name);
  if (entry) return { kind: "table", entry };
  if (/待查$/u.test(name.trim()) || symptomLevelWesternName(name)) return undefined;
  const results = await webSearchGovernedTerm(name, "诊断标准", { count: 5, minAuthority: 3, timeoutMs: 2_000, signal });
  const excerpts = results
    .filter((item) => item.rerankScore >= 1.5 && item.summary.length >= 60)
    .slice(0, 2)
    .map((item) => ({ siteName: item.siteName, title: item.title, summary: item.summary.slice(0, 400), url: item.url.split("#")[0] }));
  return excerpts.length > 0 ? { kind: "search", excerpts } : undefined;
}

/** 给核对模型看的那一段（只放要点与来源站名，不放网址）。 */
export function westernCriteriaPromptValue(reference: WesternCriteriaReference | undefined): Record<string, unknown> | null {
  if (!reference) return null;
  if (reference.kind === "table") {
    const { entry } = reference;
    return {
      source: entry.siteName || entry.title,
      clinicallyDiagnosable: entry.clinicallyDiagnosable,
      requiredTests: entry.requiredTests,
      durationThreshold: entry.durationThreshold,
      definingFeatures: entry.definingFeatures,
      ...(entry.featureRule ? { featureRule: entry.featureRule } : {}),
      ...(entry.requiredHistory ? { requiredHistory: entry.requiredHistory } : {}),
    };
  }
  return { searchExcerpts: reference.excerpts.map((item) => `${item.siteName || item.title}：${item.summary}`) };
}

/** 按最终病名取要点表来源；纯查表，不联网。供 dx 工作包接回 guidelineReferences。 */
export function westernGuidelineReferencesForName(name: string): Array<{ url: string; title: string; siteName: string }> {
  const entry = westernCriteriaEntry(name);
  if (!entry || !isAllowedWesternEvidenceUrl(entry.url) || !entry.title || !entry.siteName ||
    !westernEvidenceTitleMatches(entry.title, [name, entry.name, ...(entry.aliases || [])])) return [];
  return [{ url: entry.url, title: entry.title, siteName: entry.siteName }];
}
