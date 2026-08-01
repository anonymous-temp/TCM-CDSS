// C2：方剂→证型标签 第五批（B5），覆盖治理目录中仍无任何证型标签的 606 首方。
// 与 B1–B4 同一通道：主治原文直接支持的主证 0–2 个、拿不准留空、
// 标签必须归一到 T1 词表 id（模型自造名拦截）。
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { callAdjudicator, runPool, readCheckpoint } from "./deepseek-client.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const DATA = resolve(ROOT, "src/data");
const OUT = resolve(ROOT, "artifacts/syndrome-tag-adjudication-b5");
mkdirSync(OUT, { recursive: true });
const MAX_BATCHES = Number(process.env.MAX_BATCHES || 9999);
const BATCH_ID = "ADJ-20260727-SYNDROME-TAG-B5";

const catalog = JSON.parse(readFileSync(resolve(DATA, "tcm-formula-governed-catalog.json"), "utf-8"));
const t1 = JSON.parse(readFileSync(resolve(DATA, "tcm-syndrome-lexicon.json"), "utf-8"));
const aliasToId = new Map();
const idToCanonical = new Map();
for (const e of t1.entries) {
  aliasToId.set(e.canonical, e.id);
  idToCanonical.set(e.id, e.canonical);
  for (const a of e.aliases || []) aliasToId.set(a, e.id);
}
const t1ById = new Map(t1.entries.map((e) => [e.id, e]));

const pool = catalog.entries.filter((f) =>
  (f.syndromeTags || []).length === 0 && (f.curatedSyndromeTags || []).length === 0);

const t1Entries = t1.entries.filter((e) => e.termClass !== "category_heading");
function tagCandidatesFor(formula) {
  const hay = `${formula.name}｜${(formula.indications || "").slice(0, 260)}`;
  return t1Entries
    .map((s) => {
      let score = 0;
      if (hay.includes(s.canonical)) score += 10;
      for (const a of s.aliases || []) if (a && hay.includes(a)) score += 6;
      for (const nat of s.natures || []) if (nat && hay.includes(nat)) score += 1;
      for (const loc of s.locations || []) if (loc && hay.includes(loc)) score += 1;
      return { s, score };
    })
    .filter((x) => x.score >= 4)
    .sort((a, b) => b.score - a.score)
    .slice(0, 40)
    .map((x) => x.s.canonical);
}

const SYS = `你是中医方证证型裁定专家。对每个方剂，依据其**出处与主治原文**裁定核心证候（0–2 个）。
铁律：
1. 只勾选对主治原文**直接支持**的证候；读不出直接支持 → 留空。拿不准就留空——留空是安全默认。
2. 证候必须是**主证**，不是兼治、不是或然证。
3. 优先从所给候选证候名中选；候选外也可给国标《中医临床诊疗术语》体系内的规范名称（系统会归一，自造名会被拦截）。
4. reason ≤30字，引用主治关键点。
5. 输出 JSON 数组：[{"name":"方名","decision":"adopt"|"blank","tags":["证候名"],"reason":"…"}]。只输出 JSON 数组。`;

const batches = [];
for (let i = 0; i < pool.length; i += 15) batches.push(pool.slice(i, i + 15));
const limited = batches.slice(0, MAX_BATCHES);
console.log(JSON.stringify({ pool: pool.length, batches: limited.length }));

async function handleBatch(batch) {
  const payload = batch.map((f) => ({
    name: f.name,
    source: f.source || "",
    ingredients: (f.ingredients || []).slice(0, 14),
    indications: (f.indications || "").slice(0, 220),
    candidateSyndromes: tagCandidatesFor(f),
  }));
  const user = `请裁定以下 ${payload.length} 首方（主治原文与候选证候附后）：\n${JSON.stringify(payload, null, 1)}`;
  const draft = await callAdjudicator({ system: SYS, user, maxTokens: 12000 });
  const byName = new Map(batch.map((f) => [f.name, f]));
  const valid = [];
  const stats = { adopted: 0, blank: 0, rejectedTags: 0 };
  for (const row of draft) {
    const src = byName.get(row.name);
    if (!src) continue;
    if (row.decision !== "adopt") { stats.blank += 1; continue; }
    const tagIds = [];
    for (const t of row.tags || []) {
      const id = aliasToId.get(t) || aliasToId.get(String(t).replace(/证$/, ""));
      if (id) tagIds.push(id); else stats.rejectedTags += 1;
    }
    const unique = [...new Set(tagIds)].slice(0, 2);
    if (!unique.length) { stats.blank += 1; continue; }
    valid.push({
      name: src.name,
      sourceClass: src.sourceClass,
      syndromeTagIds: unique,
      syndromeNames: unique.map((id) => idToCanonical.get(id) || t1ById.get(id)?.canonical || id),
      basis: String(row.reason || "").slice(0, 60),
      batch: BATCH_ID,
    });
    stats.adopted += 1;
  }
  return { valid, stats };
}

await runPool({
  items: limited,
  keyOf: (b) => b.map((f) => f.name).join("|"),
  workers: 4,
  checkpointPath: resolve(OUT, "checkpoint.jsonl"),
  handle: handleBatch,
});

const cp = readCheckpoint(resolve(OUT, "checkpoint.jsonl"));
const entries = [];
const stats = { adopted: 0, blank: 0, rejectedTags: 0, failedBatches: 0 };
for (const [, record] of cp) {
  if (!record.ok) { stats.failedBatches += 1; continue; }
  entries.push(...record.result.valid);
  stats.adopted += record.result.stats.adopted;
  stats.blank += record.result.stats.blank;
  stats.rejectedTags += record.result.stats.rejectedTags;
}
writeFileSync(resolve(OUT, "adjudicated.json"), JSON.stringify(entries, null, 2) + "\n");
console.log(JSON.stringify({ newEntries: entries.length, ...stats }));
