import { readFileSync } from "node:fs";
import formulaAliasesJson from "../data/tcm-formula-aliases.json" with { type: "json" };

export type ClassicFormulaEvidence = {
  evidenceId: string;
  citation: string;
  anchorLevel: "tiaowen" | "chapter_paragraph" | "page_paragraph";
  clauseNumber?: number;
  excerpt: string;
  tier: "canon" | "common" | "experience";
};

type ClassicEvidenceRecord = {
  evidenceId: string;
  sourceName?: string;
  module?: string;
  anchorLevel: "tiaowen" | "chapter_paragraph" | "page_paragraph";
  clauseNumber?: number;
  chapter?: string;
  text: string;
  formulas: string[];
  citation: string;
  tier: "canon" | "common" | "experience";
  safetyClass: "standard" | "restricted" | "quarantine";
};

const aliasToCanonical = new Map<string, string>();
for (const entry of formulaAliasesJson.entries) {
  aliasToCanonical.set(entry.canonical, entry.canonical);
  for (const alias of entry.aliases) aliasToCanonical.set(alias, entry.canonical);
}

function normalizedFormulaName(value: string): string {
  const compact = value
    .replace(/[（(]?\s*《[^》]+》\s*[）)]?/g, "")
    .replace(/(?:加减|化裁|加味)方?$/g, "")
    .replace(/\s+/g, "")
    .trim();
  return aliasToCanonical.get(compact) || compact;
}

const CLASSIC_RUNTIME_DANGEROUS_CONTENT =
  /童子尿|人尿|生硫磺|服硫磺|拒绝.{0,12}(?:急诊|手术|化疗|放疗)|自行.{0,8}(?:服|用|煎|灸|针)|生附子.{0,30}(?:使用|用到|剂量|钱|克|煎|服)/i;
/**
 * 药名与「数量+单位」的字面碰撞白名单。
 *
 * 「百」在数量词类里、「合」在单位类里，于是**百合**整体被当成剂量抹掉：
 * 「百合固金汤」→「[具体剂量或操作已隔离]固金汤」。实测语料里 1,440 条摘录含「百合」，
 * 脱敏后 100% 丢失该药名——涉及百合类方（百合地黄汤/百合知母汤/百合固金汤）的病例，
 * 经典依据近乎空白。同类还有「合欢」。
 * 这里在数量词的**起始位置**做负向先行，而不是在单位之后——匹配起点就是「百」，
 * 写在后面的先行断言检查的是「合」之后的字符，根本拦不住。
 */
const CLASSIC_RUNTIME_HERB_NAME_COLLISIONS = "百合|合欢";
/**
 * 单位与操作词必须同时收**繁体写法**——古籍语料本身就是繁体的（2026-08-09）。
 *
 * 原字符类 `克|g|钱|两|升|合|铢` 与 `后下 / 针 / 分钟` 全是简体，而两个已发布语料里
 * 相当一部分是繁体原文。后果不是少脱敏几个字，而是**带具体剂量的经典条文原样进 prompt**，
 * 直接违反「经典剂量不得成为剂量指导、定量只归药典层」这条铁律。
 *
 * 实测（逐条扫两个语料，只统计 safetyClass==="standard" 即运行期可达的记录）：
 *   tcm-classic-text-evidence.jsonl        含繁体剂量 4130 条，现行正则漏 2600，运行期可达 2153
 *   tcm-classic-text-evidence-tcmoc.jsonl  含繁体剂量 22050 条，现行正则漏 125，运行期可达 121
 * 合计 **2274 条运行期可达记录**带未隔离剂量。实例：《伤寒论》理中圆方
 *   「人參、白朮、甘草（炙）、乾薑各三兩」——「三兩」原样保留。
 *
 * 补的字符按语料**实测出现频次**逐个对出来，不做通用繁简转换（同 tcm-therapy-phrasing.ts
 * 的 VARIANT_CHARS 口径：整表转换会误伤药名）。实测频次（运行期可达记录内）：
 *   單位 錢 5334 / 兩 2867 / 銖 64；操作 針 469 / 分鐘 48 / 後下 42。
 *   语料里未出现的繁体写法不收，避免凭空扩大字符类。
 *
 * 误隔离核对：「兩」另有「两者」义（一兩日 = 一两天）。实测数量词+兩 共 2882 处，
 * 其中该用法仅 9 处（0.3%，如 一兩次/一兩日），且现行简体正则对「一两日」本就是同样行为——
 * 补繁体不引入新的不一致。「兩頭尖」这类药名碰撞实测 0 处。
 */
const CLASSIC_RUNTIME_DOSE_OR_OPERATION =
  new RegExp(
    `(?:(?!${CLASSIC_RUNTIME_HERB_NAME_COLLISIONS})(?:\\d+(?:\\.\\d+)?|[〇零一二三四五六七八九十百半]+)\\s*(?:克|g|钱|两|兩|升|合|铢|銖|錢)` +
    "|每日.{0,8}(?:服|次)|(?:先煎|后下|後下|久煎|水煎服)|(?:针|針|刺|灸).{0,16}(?:穴|分钟|分鐘|寸))",
    "gi",
  );

function sanitizeClassicRuntimeExcerpt(value: string): string {
  return value
    .replace(CLASSIC_RUNTIME_DOSE_OR_OPERATION, "[具体剂量或操作已隔离]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 320);
}

let fullClassicEvidenceRecords: ClassicEvidenceRecord[] | undefined;

// 每个语料必须写成**独立的字面量** `new URL("字面路径", import.meta.url)`。
// 不要改回「路径数组 + 循环里 new URL(变量)」的写法：Turbopack 只能静态求值字面量实参，
// 循环变量它追不到，于是整个循环体被编译成**同一个**资源常量 `e.R(85552)`。
// 实测后果（next build standalone，dev 下完全正常所以极难发现）：
//   · 292MB 的 tcmoc 语料被打包进镜像却从未被读取——146,407 条古籍证据线上全部失效；
//   · 44MB 旧语料被读两遍，55,127 条记录在内存里翻倍，医生看到的引用成对重复，
//     top-12 排序实际只剩 6 条不同证据。
// 这类失效不会报错、不会降级，只会安静地少一半证据，因此这里的写法本身就是防线，
// 由 scripts/test-classic-evidence-bundling.mjs 钉死。
const CLASSIC_EVIDENCE_SOURCE_NAMES = [
  "tcm-classic-text-evidence.jsonl",
  "tcm-classic-text-evidence-tcmoc.jsonl",
] as const;

/** 每个语料实际加载到的条数；语料缺失是允许的（可选语料），但必须可观测。 */
const classicEvidenceLoadCounts = new Map<string, number>();

function appendClassicEvidenceRows(records: ClassicEvidenceRecord[], raw: string): number {
  let loaded = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    records.push(JSON.parse(line) as ClassicEvidenceRecord);
    loaded += 1;
  }
  return loaded;
}

function loadFullClassicEvidenceRecords(): ClassicEvidenceRecord[] {
  if (fullClassicEvidenceRecords) return fullClassicEvidenceRecords;
  const records: ClassicEvidenceRecord[] = [];

  // Keep each readFileSync call fully literal. Passing a literal URL through an array/loop still
  // makes the fs call dynamic to Turbopack/NFT and broadens the trace to the whole project.
  try {
    const raw = readFileSync(
      new URL("../data/tcm-classic-text-evidence.jsonl", import.meta.url),
      "utf8",
    );
    classicEvidenceLoadCounts.set(
      "tcm-classic-text-evidence.jsonl",
      appendClassicEvidenceRows(records, raw),
    );
  } catch {
    classicEvidenceLoadCounts.set("tcm-classic-text-evidence.jsonl", 0);
  }
  try {
    const raw = readFileSync(
      new URL("../data/tcm-classic-text-evidence-tcmoc.jsonl", import.meta.url),
      "utf8",
    );
    classicEvidenceLoadCounts.set(
      "tcm-classic-text-evidence-tcmoc.jsonl",
      appendClassicEvidenceRows(records, raw),
    );
  } catch {
    classicEvidenceLoadCounts.set("tcm-classic-text-evidence-tcmoc.jsonl", 0);
  }
  fullClassicEvidenceRecords = records;
  return fullClassicEvidenceRecords;
}

/**
 * 逐语料加载条数，供健康检查与部署核对。
 * 任一语料为 0 都意味着该部署缺证据——不阻断流程（语料可选），但必须看得见。
 */
export function classicEvidenceCorpusStatus(): { name: string; records: number }[] {
  loadFullClassicEvidenceRecords();
  return CLASSIC_EVIDENCE_SOURCE_NAMES.map((name) => ({
    name,
    records: classicEvidenceLoadCounts.get(name) || 0,
  }));
}

/** T15 runtime lookup scans every safe/restricted source record; no compact sample index is used. */
export function classicEvidenceForFormulaNames(formulaNames: string[]): ClassicFormulaEvidence[] {
  const names = new Set(formulaNames.map(normalizedFormulaName).filter(Boolean));
  if (names.size === 0) return [];
  const records = loadFullClassicEvidenceRecords();
  const anchorRank = { tiaowen: 0, chapter_paragraph: 1, page_paragraph: 2 } as const;
  const tierRank = { canon: 0, common: 1, experience: 2 } as const;
  return records
    .filter((record) =>
      record.safetyClass === "standard" &&
      record.formulas.some((formula) => names.has(normalizedFormulaName(formula))) &&
      !CLASSIC_RUNTIME_DANGEROUS_CONTENT.test(record.text))
    .sort((left, right) =>
      // A chapter/section titled after the formula itself (《医方集解》·归脾汤) is the formula's
      // own entry and outranks tangential mentions elsewhere in the corpus.
      Number(right.chapter != null && [...names].some((name) => String(right.chapter).includes(name))) -
        Number(left.chapter != null && [...names].some((name) => String(left.chapter).includes(name)) || 0) ||
      tierRank[left.tier] - tierRank[right.tier] ||
      anchorRank[left.anchorLevel] - anchorRank[right.anchorLevel] ||
      left.evidenceId.localeCompare(right.evidenceId))
    .slice(0, 12)
    .map((record) => ({
      evidenceId: record.evidenceId,
      citation: record.citation,
      anchorLevel: record.anchorLevel,
      ...(record.clauseNumber ? { clauseNumber: record.clauseNumber } : {}),
      excerpt: sanitizeClassicRuntimeExcerpt(record.text),
      tier: record.tier,
    }));
}
