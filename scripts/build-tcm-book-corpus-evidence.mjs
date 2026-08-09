/**
 * 生成 src/data/tcm-classic-text-evidence-books.jsonl —— 书籍语料的受治理证据条目。
 *
 * 为什么产出成**与既有古籍语料同 schema 的第三个 jsonl**，而不是另起一套检索：
 * 既有管道（tcm-classic-evidence.server.ts）已经带着四道运行期治理，全部可以直接复用——
 *   ① sanitizeClassicRuntimeExcerpt 剂量/操作隔离（繁简两侧齐全）；
 *   ② CLASSIC_RUNTIME_DANGEROUS_CONTENT 危险内容过滤；
 *   ③ safetyClass === "standard" 门；
 *   ④ 方名键控 + tier 排序。
 * 另起一套等于把这四道重写一遍，而「同一判据两处各写各的」正是本仓库的头号缺陷形状。
 *
 * 入库前的三层筛选（缺一不可，全部在构建期完成）：
 *   1. **去重**：对已发布的两个受治理语料做字符 8-gram shingle 比对（zhconv 繁→简），
 *      只保留 dup<0.1 的真新增。实测 58,062 chunk → 5,594 条（9.6%）。
 *      不去重的代价不是浪费，而是把同一条条文以更低证据等级重复喂给医生。
 *   2. **危险内容确定性硬拦**：带克数药膳、炼丹/矿物毒药剂量、食疗直接映射西医病名。
 *      这一层**不交给模型**——这批文本最终要进 M03/M04 证据上下文，
 *      让模型批准自己将来要读的语料，链条上是自证。实测硬拦 151 条。
 *   3. **噪声判定**：DeepSeek V4 Flash（thinking enabled）逐条判 usable/noise。
 *      目录页/版权页/序跋/营销/校勘凡例/OCR 乱码/占卜玄学/纯养生 判噪声。
 *      实测 5,594 → usable 3,372 / noise 2,071 / dangerous 151。
 *
 * 证据等级：tier="book"，在 tcm-classic-evidence.server.ts 的 tierRank 里排在
 * canon/common/experience **之后**——书籍语料任何时候都不得压过受治理经典条文。
 *
 * 输入（不在仓库内，属外部构建输入，同 build:tcm-knowledge 的口径）：
 *   TCM_BOOK_CORPUS_CLASSIFIED  逐条判定结果 jsonl（默认 /tmp/rx/bk/classified-*.jsonl）
 *   TCM_BOOK_CORPUS_TEXTS       真新增正文 json（默认 /tmp/rx/bk/novel-texts.json）
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const OUT = path.join(repoRoot, "src/data/tcm-classic-text-evidence-books.jsonl");

const classifiedGlob = process.env.TCM_BOOK_CORPUS_CLASSIFIED || "/tmp/rx/bk/classified-*.jsonl";
const textsPath = process.env.TCM_BOOK_CORPUS_TEXTS || "/tmp/rx/bk/novel-texts.json";

function readClassified() {
  const dir = path.dirname(classifiedGlob);
  const pattern = path.basename(classifiedGlob).replace(/\*/g, "(.*)");
  const re = new RegExp(`^${pattern}$`);
  if (!fs.existsSync(dir)) return [];
  const rows = [];
  for (const file of fs.readdirSync(dir)) {
    if (!re.test(file)) continue;
    for (const line of fs.readFileSync(path.join(dir, file), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { /* 半截行 */ }
    }
  }
  return rows;
}

const classified = readClassified();
if (classified.length === 0) {
  console.error(JSON.stringify({
    error: "book_corpus_classification_missing",
    note: "缺少逐条判定结果，无法构建。这是外部构建输入（同 build:tcm-knowledge 依赖兄弟仓库的口径），" +
          "不在仓库内；缺失时**不生成空产物**，避免把「没数据」伪装成「没内容」。",
    expected: classifiedGlob,
  }, null, 1));
  process.exit(1);
}
if (!fs.existsSync(textsPath)) {
  console.error(JSON.stringify({ error: "book_corpus_texts_missing", expected: textsPath }, null, 1));
  process.exit(1);
}

const verdictById = new Map(classified.map((row) => [row.chunk_id, row]));
const texts = JSON.parse(fs.readFileSync(textsPath, "utf8"));

// ── 方名键控：用受治理目录的正名 + 别名做最长匹配 ────────────────────────────
// 运行期检索 classicEvidenceForFormulaNames 按 formulas 命中，formulas 为空的记录永远查不到。
// 这里只认**受治理目录里真实存在**的方名，不做任何模糊匹配——键控错了等于把不相干的条文
// 挂到一张方名下，比查不到更糟。
const catalog = JSON.parse(fs.readFileSync(path.join(repoRoot, "src/data/tcm-formula-governed-catalog.json"), "utf8"));
const formulaNames = [];
for (const entry of catalog.entries) {
  if (!entry.identityLockEligible) continue;
  for (const name of [entry.name, ...(entry.aliases || [])]) {
    const value = String(name || "").trim();
    // 2 字方名（如「玉屏」）会在正文里大量假命中；受治理方名实际都 ≥3 字。
    if (value.length >= 3) formulaNames.push(value);
  }
}
const uniqueNames = [...new Set(formulaNames)].sort((a, b) => b.length - a.length);
const maxNameLength = uniqueNames[0]?.length || 0;
const nameSet = new Set(uniqueNames);

function matchedFormulas(text) {
  const hits = new Set();
  for (let i = 0; i < text.length; i += 1) {
    const maxLen = Math.min(maxNameLength, text.length - i);
    for (let len = maxLen; len >= 3; len -= 1) {
      const candidate = text.slice(i, i + len);
      if (nameSet.has(candidate)) { hits.add(candidate); i += len - 1; break; }
    }
  }
  return [...hits];
}

const stream = fs.createWriteStream(OUT);
let written = 0;
let skippedVerdict = 0;
let skippedNoFormula = 0;
const perCat = {};

for (const item of texts) {
  const verdict = verdictById.get(item.chunk_id);
  if (!verdict || verdict.verdict !== "usable") { skippedVerdict += 1; continue; }
  const text = String(item.text || "").trim();
  if (!text) { skippedVerdict += 1; continue; }
  const formulas = matchedFormulas(text);
  if (formulas.length === 0) { skippedNoFormula += 1; continue; }

  const docId = createHash("sha256").update(String(item.title || "")).digest("hex").slice(0, 12);
  stream.write(JSON.stringify({
    evidenceId: `BOOK-${item.chunk_id}`,
    sourceCardId: docId,
    sourceName: String(item.title || "").slice(0, 160),
    docId,
    module: "book_supplement",
    anchorLevel: "page_paragraph",
    page: Number(item.seq) || 0,
    paragraph: String(item.chunk_id),
    text,
    formulas,
    patterns: [],
    citation: `book-evidence:${docId}#seq${Number(item.seq) || 0}`,
    version: "tcm-book-corpus-v1",
    // 排在 canon/common/experience 之后：书籍语料任何时候不得压过受治理经典条文。
    tier: "book",
    // 三层筛选都过了才到这里，因此标 standard；危险内容与噪声在上游已剔除。
    safetyClass: "standard",
    chapter: null,
  }) + "\n");
  written += 1;
  perCat[item.cat2] = (perCat[item.cat2] || 0) + 1;
}
await new Promise((resolve, reject) => {
  stream.on("finish", resolve);
  stream.on("error", reject);
  stream.end();
});

const bytes = fs.statSync(OUT).size;
console.log(JSON.stringify({
  输入真新增: texts.length,
  判定为可用: classified.filter((r) => r.verdict === "usable").length,
  因判定被剔除: skippedVerdict,
  因未命中受治理方名被剔除: skippedNoFormula,
  写入条目: written,
  产物字节: bytes,
  产物MiB: Number((bytes / 1048576).toFixed(2)),
  按分类: perCat,
}, null, 1));
