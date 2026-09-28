import { readFileSync } from "node:fs";
import path from "node:path";
import formulaAliasesJson from "../data/tcm-formula-aliases.json" with { type: "json" };

export type ClassicFormulaEvidence = {
  evidenceId: string;
  citation: string;
  anchorLevel: "tiaowen" | "chapter_paragraph" | "page_paragraph";
  clauseNumber?: number;
  excerpt: string;
  tier: "canon" | "common" | "experience" | "book";
};

export type ClassicEvidenceRecord = {
  evidenceId: string;
  sourceName?: string;
  module?: string;
  anchorLevel: "tiaowen" | "chapter_paragraph" | "page_paragraph";
  clauseNumber?: number;
  chapter?: string;
  text: string;
  formulas: string[];
  citation: string;
  tier: "canon" | "common" | "experience" | "book";
  safetyClass: "standard" | "restricted" | "quarantine";
};

const aliasToCanonical = new Map<string, string>();
for (const entry of formulaAliasesJson.entries) {
  aliasToCanonical.set(entry.canonical, entry.canonical);
  for (const alias of entry.aliases) aliasToCanonical.set(alias, entry.canonical);
}

export function normalizedFormulaName(value: string): string {
  const compact = value
    .replace(/[（(]?\s*《[^》]+》\s*[）)]?/g, "")
    .replace(/(?:加减|化裁|加味)方?$/g, "")
    .replace(/\s+/g, "")
    .trim();
  return aliasToCanonical.get(compact) || compact;
}

export const CLASSIC_RUNTIME_DANGEROUS_CONTENT =
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

export function sanitizeClassicRuntimeExcerpt(value: string): string {
  return value
    .replace(CLASSIC_RUNTIME_DOSE_OR_OPERATION, "[具体剂量或操作已隔离]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 320);
}

/**
 * 运行期只读**构建期派生的紧凑索引**（2026-09-28）：`src/data/tcm-classic-evidence-formula-index.json`，
 * 由 scripts/build-classic-evidence-index.mjs 从三份古籍语料生成。
 *
 * 为什么不再运行期读原始语料：
 *  · 生产 standalone 构建里「new URL(数据相对路径, import.meta.url)」被 webpack 改写成资产相对 URL，
 *    fs 读不到、catch 后静默为 0 条——9/27 实测麻黄汤 jiti 下 12 条、生产 0 条，「原典出处」线上一直是空的；
 *  · 即使路径读得到，tcmoc 语料 347MB，整份 JSON.parse 进内存会把 2GiB 容器顶爆。
 * 运行期真正用到的只是「safetyClass=standard、带方名、不含危险内容」记录里每个方名排序靠前的一小段，
 * 所以构建期把这部分算好：每个规范方名保留排序前 CLASSIC_INDEX_PER_FORMULA 条（排序键与运行期同一个），
 * 摘录按同一个 sanitizeClassicRuntimeExcerpt 预先隔离剂量。约 10MB，按 process.cwd()/src/data 读取
 * （standalone 的 server.js 先 chdir 到自身目录，Next 文件追踪把 src/data 整目录带进镜像；同 modern-case-exemplars）。
 * 原始语料在 next.config.ts 里排除出镜像。
 */
export const CLASSIC_INDEX_PER_FORMULA = 24;
export const CLASSIC_INDEX_FILE = "tcm-classic-evidence-formula-index.json";

export type ClassicEvidenceIndexRecord = {
  evidenceId: string;
  citation: string;
  anchorLevel: ClassicEvidenceRecord["anchorLevel"];
  clauseNumber?: number;
  chapter?: string;
  tier: ClassicEvidenceRecord["tier"];
  excerpt: string;
  source: string;
  /** 规范方名（运行期合查时判断章节题名交叉记录是否与查询方名相交）。 */
  formulaNames: string[];
};

export type ClassicEvidenceIndex = {
  schemaVersion: "tcm-classic-evidence-formula-index-v1";
  perFormulaLimit: number;
  sources: { name: string; bytes: number; sha256: string; records: number; eligible: number }[];
  records: ClassicEvidenceIndexRecord[];
  byFormula: Record<string, number[]>;
  /** 章节以该方名为题、方名字段却不含该方名的记录（全部保留，见构建脚本）。 */
  crossTitled: Record<string, number[]>;
};

const TIER_RANK = { canon: 0, common: 1, experience: 2, book: 3 } as const;
const ANCHOR_RANK = { tiaowen: 0, chapter_paragraph: 1, page_paragraph: 2 } as const;

/**
 * 排序键（运行期、构建期、全量对照三处共用）：以方名为题的章节条目在前（《医方集解》·归脾汤），
 * 然后 canon < common < experience < book（书籍语料是补充来源，任何时候不得压过受治理经典条文），
 * 再按锚点精度与证据 ID。
 */
export function compareClassicEvidence(
  names: ReadonlySet<string>,
  left: { chapter?: string; tier: ClassicEvidenceRecord["tier"]; anchorLevel: ClassicEvidenceRecord["anchorLevel"]; evidenceId: string },
  right: { chapter?: string; tier: ClassicEvidenceRecord["tier"]; anchorLevel: ClassicEvidenceRecord["anchorLevel"]; evidenceId: string },
): number {
  const titled = (record: { chapter?: string }) =>
    Number(record.chapter != null && [...names].some((name) => String(record.chapter).includes(name)));
  return titled(right) - titled(left) ||
    TIER_RANK[left.tier] - TIER_RANK[right.tier] ||
    ANCHOR_RANK[left.anchorLevel] - ANCHOR_RANK[right.anchorLevel] ||
    left.evidenceId.localeCompare(right.evidenceId);
}

/** 运行期可用的原始语料记录（构建期与全量对照共用的同一道门）。 */
export function isRuntimeEligibleClassicRecord(record: ClassicEvidenceRecord): boolean {
  return record.safetyClass === "standard" &&
    Array.isArray(record.formulas) && record.formulas.length > 0 &&
    !CLASSIC_RUNTIME_DANGEROUS_CONTENT.test(record.text);
}

/** 旧的全量扫描算法，只给构建期派生与对照测试用（运行期不再读原始语料）。 */
export function classicEvidenceFromFullRecords(records: readonly ClassicEvidenceRecord[], formulaNames: string[]): ClassicFormulaEvidence[] {
  const names = new Set(formulaNames.map(normalizedFormulaName).filter(Boolean));
  if (names.size === 0) return [];
  return records
    .filter((record) => isRuntimeEligibleClassicRecord(record) &&
      record.formulas.some((formula) => names.has(normalizedFormulaName(formula))))
    .sort((left, right) => compareClassicEvidence(names, left, right))
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

let classicEvidenceIndex: ClassicEvidenceIndex | null | undefined;

function loadClassicEvidenceIndex(): ClassicEvidenceIndex | null {
  if (classicEvidenceIndex !== undefined) return classicEvidenceIndex;
  try {
    classicEvidenceIndex = JSON.parse(
      readFileSync(path.join(process.cwd(), "src", "data", CLASSIC_INDEX_FILE), "utf8"),
    ) as ClassicEvidenceIndex;
  } catch (error) {
    // 缺索引允许（证据可选），但必须看得见：健康检查报 0 条，日志留一行。
    console.warn("[tcm-cdss:knowledge] classic evidence index unavailable", {
      reason: error instanceof Error ? error.message.slice(0, 120) : "unknown",
    });
    classicEvidenceIndex = null;
  }
  return classicEvidenceIndex;
}

/**
 * 逐语料进入索引的条数，供健康检查与部署核对。
 * 任一语料为 0 都意味着该部署缺证据——不阻断流程（语料可选），但必须看得见。
 */
export function classicEvidenceCorpusStatus(): { name: string; records: number; indexed: number }[] {
  const index = loadClassicEvidenceIndex();
  const counts = new Map<string, number>();
  for (const record of index?.records || []) counts.set(record.source, (counts.get(record.source) || 0) + 1);
  // records = 索引构建时读到的原始语料条数（语料是否完整进入索引）；indexed = 实际保留进索引的条数。
  return CLASSIC_EVIDENCE_SOURCE_NAMES.map((name) => ({
    name,
    records: index?.sources.find((source) => source.name === name)?.records || 0,
    indexed: counts.get(name) || 0,
  }));
}

export const CLASSIC_EVIDENCE_SOURCE_NAMES = [
  "tcm-classic-text-evidence.jsonl",
  "tcm-classic-text-evidence-tcmoc.jsonl",
  // 书籍语料补充（2026-08-09）：构建期已对上面两个语料去重、危险内容硬拦、逐条噪声判定，且只保留命中受治理方名的条目。
  "tcm-classic-text-evidence-books.jsonl",
] as const;

/**
 * T15 运行期查找：取查询方名各自的索引候选（每名前 CLASSIC_INDEX_PER_FORMULA 条），并集后用与全量扫描
 * 同一个排序键重排、取前 12。单方名查询与全量扫描逐条相同；多方名时并集覆盖各方前 24 条，
 * 只有「某条在自己方名下排 24 名之后、却因章节题名含另一个查询方名而进前 12」才会不同——test:classic-evidence-index
 * 用真实语料对照钉住。
 */
export function classicEvidenceForFormulaNames(formulaNames: string[]): ClassicFormulaEvidence[] {
  const names = new Set(formulaNames.map(normalizedFormulaName).filter(Boolean));
  if (names.size === 0) return [];
  const index = loadClassicEvidenceIndex();
  if (!index) return [];
  const positions = new Set<number>();
  for (const name of names) for (const position of index.byFormula[name] || []) positions.add(position);
  if (names.size > 1) {
    for (const name of names) for (const position of index.crossTitled?.[name] || []) positions.add(position);
  }
  return [...positions]
    .map((position) => index.records[position])
    .filter((record): record is ClassicEvidenceIndexRecord => Boolean(record) &&
      record.formulaNames.some((formulaName) => names.has(formulaName)))
    .sort((left, right) => compareClassicEvidence(names, left, right))
    .slice(0, 12)
    .map((record) => ({
      evidenceId: record.evidenceId,
      citation: record.citation,
      anchorLevel: record.anchorLevel,
      ...(record.clauseNumber ? { clauseNumber: record.clauseNumber } : {}),
      excerpt: record.excerpt,
      tier: record.tier,
    }));
}
