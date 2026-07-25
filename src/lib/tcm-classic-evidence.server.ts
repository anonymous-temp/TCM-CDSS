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
const CLASSIC_RUNTIME_DOSE_OR_OPERATION =
  new RegExp(
    `(?:(?!${CLASSIC_RUNTIME_HERB_NAME_COLLISIONS})(?:\\d+(?:\\.\\d+)?|[〇零一二三四五六七八九十百半]+)\\s*(?:克|g|钱|两|升|合|铢)` +
    "|每日.{0,8}(?:服|次)|(?:先煎|后下|久煎|水煎服)|(?:针|刺|灸).{0,16}(?:穴|分钟|寸))",
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
const CLASSIC_EVIDENCE_SOURCES = [
  { name: "tcm-classic-text-evidence.jsonl", url: new URL("../data/tcm-classic-text-evidence.jsonl", import.meta.url) },
  { name: "tcm-classic-text-evidence-tcmoc.jsonl", url: new URL("../data/tcm-classic-text-evidence-tcmoc.jsonl", import.meta.url) },
] as const;

/** 每个语料实际加载到的条数；语料缺失是允许的（可选语料），但必须可观测。 */
const classicEvidenceLoadCounts = new Map<string, number>();

function loadFullClassicEvidenceRecords(): ClassicEvidenceRecord[] {
  if (fullClassicEvidenceRecords) return fullClassicEvidenceRecords;
  const records: ClassicEvidenceRecord[] = [];
  for (const source of CLASSIC_EVIDENCE_SOURCES) {
    let loaded = 0;
    try {
      const raw = readFileSync(source.url, "utf8");
      for (const line of raw.split("\n")) {
        if (line.trim()) {
          records.push(JSON.parse(line) as ClassicEvidenceRecord);
          loaded += 1;
        }
      }
    } catch {
      // Optional corpus file missing in this deployment: continue with whatever is present.
    }
    classicEvidenceLoadCounts.set(source.name, loaded);
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
  return CLASSIC_EVIDENCE_SOURCES.map((source) => ({
    name: source.name,
    records: classicEvidenceLoadCounts.get(source.name) || 0,
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
