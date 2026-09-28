#!/usr/bin/env node
/**
 * 古籍证据紧凑索引生成器（2026-09-28）：src/data/tcm-classic-text-evidence*.jsonl（Git LFS，合计约 400MB）
 * → src/data/tcm-classic-evidence-formula-index.json（约 10MB）。
 *
 * 运行期（tcm-classic-evidence.server.ts）只读这份索引。门槛与排序键与运行期同源（同一模块导出）：
 * safetyClass=standard、带方名、不含危险内容；每个规范方名保留排序前 CLASSIC_INDEX_PER_FORMULA 条；
 * 摘录按 sanitizeClassicRuntimeExcerpt 预先隔离剂量。
 * 用法：npm run build:classic-evidence-index
 */
import { closeSync, createReadStream, openSync, readSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { alias: { "@": path.join(root, "src") } });
const {
  CLASSIC_EVIDENCE_SOURCE_NAMES, CLASSIC_INDEX_FILE, CLASSIC_INDEX_PER_FORMULA,
  compareClassicEvidence, isRuntimeEligibleClassicRecord, normalizedFormulaName, sanitizeClassicRuntimeExcerpt,
} = await jiti.import(path.join(root, "src/lib/tcm-classic-evidence.server.ts"));

async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

const candidatesByName = new Map();
const crossTitledCandidates = [];
const compact = [];
const sources = [];
for (const name of CLASSIC_EVIDENCE_SOURCE_NAMES) {
  const file = path.join(root, "src/data", name);
  let bytes = 0;
  try { bytes = statSync(file).size; } catch { sources.push({ name, bytes: 0, sha256: "", records: 0, eligible: 0 }); continue; }
  const fd = openSync(file, "r");
  const headBuffer = Buffer.alloc(200);
  readSync(fd, headBuffer, 0, 200, 0);
  closeSync(fd);
  const head = headBuffer.toString("utf8");
  if (/^version https:\/\/git-lfs/.test(head)) throw new Error(`${name} 是 Git LFS 指针，先 git lfs pull`);
  let records = 0;
  let eligible = 0;
  const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    records += 1;
    const record = JSON.parse(line);
    if (!isRuntimeEligibleClassicRecord(record)) continue;
    eligible += 1;
    const names = [...new Set(record.formulas.map(normalizedFormulaName).filter(Boolean))];
    if (names.length === 0) continue;
    const entry = {
      formulaNames: names,
      evidenceId: record.evidenceId,
      citation: record.citation,
      anchorLevel: record.anchorLevel,
      ...(record.clauseNumber ? { clauseNumber: record.clauseNumber } : {}),
      ...(record.chapter != null ? { chapter: String(record.chapter) } : {}),
      tier: record.tier,
      source: name,
      text: record.text,
    };
    if (entry.chapter) crossTitledCandidates.push(entry);
    for (const formulaName of names) {
      const bucket = candidatesByName.get(formulaName) || [];
      bucket.push(entry);
      // 有界保留：超过上限的 4 倍时就地截一次，避免 8,000+ 条的高频方名把内存撑大。
      if (bucket.length > CLASSIC_INDEX_PER_FORMULA * 4) {
        bucket.sort((left, right) => compareClassicEvidence(new Set([formulaName]), left, right));
        bucket.length = CLASSIC_INDEX_PER_FORMULA;
      }
      candidatesByName.set(formulaName, bucket);
    }
  }
  sources.push({ name, bytes, sha256: await sha256File(file), records, eligible });
}

const positionById = new Map();
const byFormula = {};
const crossTitled = {};
const retain = (entry) => {
  let position = positionById.get(entry.evidenceId);
  if (position === undefined) {
    position = compact.length;
    positionById.set(entry.evidenceId, position);
    const { text, ...rest } = entry;
    compact.push({ ...rest, excerpt: sanitizeClassicRuntimeExcerpt(text) });
  }
  return position;
};
for (const [formulaName, bucket] of [...candidatesByName.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  bucket.sort((left, right) => compareClassicEvidence(new Set([formulaName]), left, right));
  byFormula[formulaName] = bucket.slice(0, CLASSIC_INDEX_PER_FORMULA).map(retain);
}
// 章节题名交叉：章节以方名 B 为题、方名字段却只有 A 的记录（如「《…》·归脾汤」一节只标了酸枣仁汤）。
// 单查 A 时它不被提前、可能落在 A 的前 24 名之外；合查 {A,B} 时它因题名含 B 被提前——全量扫描会选中它。
// 这类记录全部单列保留（不截断），运行期合查时并入候选，使多方名查询与全量扫描逐条一致。
const indexNames = Object.keys(byFormula);
for (const entry of crossTitledCandidates) {
  for (const name of indexNames) {
    if (entry.formulaNames.includes(name) || !entry.chapter.includes(name)) continue;
    (crossTitled[name] ||= []).push(retain(entry));
  }
}

const index = {
  schemaVersion: "tcm-classic-evidence-formula-index-v1",
  perFormulaLimit: CLASSIC_INDEX_PER_FORMULA,
  sources,
  records: compact,
  byFormula,
  crossTitled,
};
const out = path.join(root, "src/data", CLASSIC_INDEX_FILE);
writeFileSync(out, `${JSON.stringify(index)}\n`);
console.log(JSON.stringify({ out: path.relative(root, out), bytes: statSync(out).size, formulas: Object.keys(byFormula).length, records: compact.length, sources: sources.map(({ name, records, eligible }) => ({ name, records, eligible })) }));
