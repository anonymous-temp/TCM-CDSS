import "server-only";

import fs from "node:fs";
import path from "node:path";
import { webSearchGovernedTerm } from "./deepseek-web-search.server";

/**
 * 西医诊断标准要点（2026-10-18）。给西医病名一致性核对（western-name-evidence-check）当参照：这个病能不能按临床表现诊断、
 * 确诊要依赖哪些检查、有没有病程门槛。
 *
 * 来源两级：
 *  1. 受治理的要点表 src/data/western-diagnostic-criteria.source.json（scripts/build-western-diagnostic-criteria.mjs 由 DeepSeek Search
 *     找权威页面、抽取要点，每条带网址、站名与逐字核对过的原文）；
 *  2. 表里没有的病名：现场检索「<病名> 诊断标准」，取权威度≥3 的前两条摘要（不抽取、不改写），2 秒软超时，失败就没有参照。
 * 查询词只用病名本身，不含病历内容。表用 process.cwd() 读取（与原典索引同一做法），读不到就只走第 2 级。
 */
export type WesternCriteriaEntry = {
  name: string;
  clinicallyDiagnosable: boolean;
  requiredTests: string[];
  durationThreshold: string;
  definingFeatures: string[];
  quote: string;
  url: string;
  siteName: string;
  title: string;
  retrievedAt: string;
};

export type WesternCriteriaReference =
  | { kind: "table"; entry: WesternCriteriaEntry }
  | { kind: "search"; excerpts: Array<{ siteName: string; title: string; summary: string; url: string }> };

type CriteriaTable = { entries: Map<string, WesternCriteriaEntry>; qualifiers: { course: string[]; side: string[]; population: string[] } };
let table: CriteriaTable | undefined;
function criteriaTable(): CriteriaTable {
  if (table) return table;
  table = { entries: new Map(), qualifiers: { course: [], side: [], population: [] } };
  try {
    const file = path.join(process.cwd(), "src/data/western-diagnostic-criteria.source.json");
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
      entries?: WesternCriteriaEntry[];
      nameLookupQualifiers?: { course?: unknown; side?: unknown; population?: unknown };
    };
    for (const entry of parsed.entries || []) if (entry?.name) table.entries.set(entry.name, entry);
    const words = (value: unknown) => (Array.isArray(value) ? value : []).filter((item): item is string => typeof item === "string" && item.length > 0)
      .sort((a, b) => b.length - a.length);
    table.qualifiers = {
      course: words(parsed.nameLookupQualifiers?.course),
      side: words(parsed.nameLookupQualifiers?.side),
      population: words(parsed.nameLookupQualifiers?.population),
    };
  } catch {
    // 表不在（构建前、或镜像里没带）：只走现场检索。
  }
  return table;
}

function withoutLeadingQualifier(name: string, qualifiers: string[]): string {
  const hit = qualifiers.find((word) => name.startsWith(word) && name.length > word.length + 1);
  return hit ? name.slice(hit.length) : name;
}

/**
 * 表里的条目：先按原名，再按去掉病程限定、侧别、人群（儿童/小儿）前缀后的名称（前缀词表在数据文件 nameLookupQualifiers 里）。
 * 人群前缀与病程限定可以叠着写（「儿童慢性功能性便秘」），两层都去掉再查一次。
 */
export function westernCriteriaEntry(name: string): WesternCriteriaEntry | undefined {
  const { entries, qualifiers } = criteriaTable();
  const trimmed = name.trim();
  const withoutPopulation = withoutLeadingQualifier(trimmed, qualifiers.population);
  return entries.get(trimmed) || entries.get(withoutLeadingQualifier(trimmed, qualifiers.course)) ||
    entries.get(withoutLeadingQualifier(trimmed, qualifiers.side)) || entries.get(withoutPopulation) ||
    entries.get(withoutLeadingQualifier(withoutPopulation, qualifiers.course));
}

/**
 * 去掉一个病程限定或侧别前缀后的病名（「急性尿潴留」→「尿潴留」）；没有这类前缀时返回 undefined。
 * 前缀词表与查表同一份（数据文件 nameLookupQualifiers）。病名一致性核对用它判断「核对给出的名称只是去掉了病程限定」。
 */
export function westernNameWithoutCourseOrSideQualifier(name: string): string | undefined {
  const { qualifiers } = criteriaTable();
  const trimmed = name.trim();
  for (const words of [qualifiers.course, qualifiers.side]) {
    const stripped = withoutLeadingQualifier(trimmed, words);
    if (stripped !== trimmed) return stripped;
  }
  return undefined;
}

export async function westernCriteriaReference(name: string, signal?: AbortSignal): Promise<WesternCriteriaReference | undefined> {
  const entry = westernCriteriaEntry(name);
  if (entry) return { kind: "table", entry };
  if (/待查$/u.test(name.trim())) return undefined;
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
    };
  }
  return { searchExcerpts: reference.excerpts.map((item) => `${item.siteName || item.title}：${item.summary}`) };
}
