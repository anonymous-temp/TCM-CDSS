// Batch B：证候→方剂 正向关系全量补齐（高频关系通道第五批）。
// 目标池：T1 词表中尚无方剂关系的全部证候（跳过目录性 category_heading）。
// 通道：候选预筛（主治文本关键词对拍，top40）→ v4-pro 裁定（0-3 首，拿不准留空）
// → 确定性校验（方名⊆候选⊆T8 源域、therapyTerms 非空、fit 受控）→ relations.json。
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { callAdjudicator, runPool, readCheckpoint } from "./deepseek-client.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const DATA = resolve(ROOT, "src/data");
const OUT = resolve(ROOT, "artifacts/syndrome-relation-adjudication-b5");
mkdirSync(OUT, { recursive: true });
const MAX_BATCHES = Number(process.env.MAX_BATCHES || 9999);

const t1 = JSON.parse(readFileSync(resolve(DATA, "tcm-syndrome-lexicon.json"), "utf-8"));
const catalog = JSON.parse(readFileSync(resolve(DATA, "tcm-formula-governed-catalog.json"), "utf-8"));
const hf = JSON.parse(readFileSync(resolve(DATA, "tcm-high-frequency-syndrome-formula-relations.source.json"), "utf-8"));

const t1Ids = new Set(t1.entries.map((e) => e.id));
const coveredIds = new Set();
for (const f of catalog.entries) {
  for (const t of [...(f.syndromeTags || []), ...(f.curatedSyndromeTags || [])]) {
    if (t1Ids.has(t)) coveredIds.add(t);
  }
}
const hfSyndromes = new Set(hf.entries.map((e) => e.syndrome));
const uncovered = t1.entries.filter((e) =>
  e.termClass !== "category_heading" && !coveredIds.has(e.id) && !hfSyndromes.has(e.canonical));

const eligible = catalog.entries.filter((e) => e.retrievalEligible);
function candidatesFor(syndrome) {
  const names = [syndrome.canonical, ...(syndrome.aliases || [])].filter(Boolean);
  const natures = (syndrome.natures || []).slice(0, 4);
  const locations = (syndrome.locations || []).slice(0, 4);
  const scored = eligible.map((f) => {
    const hay = `${f.name}｜${(f.indications || "").slice(0, 260)}｜${(f.symptomTags || []).join("、")}`;
    let score = 0;
    for (const n of names) {
      if (!n) continue;
      if (f.name.includes(n)) score += 10;
      if ((f.indications || "").includes(n)) score += 8;
      // 别名按两字子串宽松对拍（心脾两虚→心脾）
      if (n.length >= 4 && hay.includes(n.slice(0, 2)) && hay.includes(n.slice(-2))) score += 2;
    }
    for (const nat of natures) if (nat && hay.includes(nat)) score += 2;
    for (const loc of locations) if (loc && hay.includes(loc)) score += 1;
    return { f, score };
  });
  return scored
    .filter((s) => s.score >= 6)
    .sort((a, b) => b.score - a.score)
    .slice(0, 40)
    .map((s) => ({ name: s.f.name, source: s.f.source || "", indications: (s.f.indications || "").slice(0, 120) }));
}

const SYS = `你是中医方证关系裁定专家。对每个证候，提名 0–3 首**主治直接支持该证候**的方。
铁律:
1. 只提名主治与该证候临床含义直接对应的方；拿不准就空数组——留空是安全默认，不会造成任何错误。
2. **禁止仅因方名含有证候用字而提名**（如"寒"证不得仅选"寒泻方"）；必须是方的主治含义与证候对应。
3. 证候为单一病性/病位字（阴/阳/表/里/寒/热/虚/实等）时尤其严格：只有主治明确以该病性为核心的方才可作 primary，否则留空。
4. 所附候选清单仅供参考（由关键词对拍生成，可能不全或不准）；你可以提名候选之外的方，但每首必须给 basis（≤30字，写明该方主治中支持本证的要点）。系统会对提名做受控目录校验，自造方名会被拦截。
5. fit="primary"：该方主治的核心证候即本证；fit="differential"：本证的常见鉴别/兼夹情形下方可用。
6. 每个 pick 给 therapyTerms（2–4 个治法词，如 益气/养血/清热/化湿）；fit="differential" 时必须给 discriminator（≤40字：何时选它而非 primary）。
7. 只输出 JSON 数组：
[{"syndrome":"证候名","formulas":[{"name":"方名","fit":"primary|differential","therapyTerms":["治法"],"basis":"主治依据","discriminator":"…"}]}]
某证候无合适方 → {"syndrome":"证候名","formulas":[]}。`;

const batches = [];
for (let i = 0; i < uncovered.length; i += 12) batches.push(uncovered.slice(i, i + 12));
const limitedBatches = batches.slice(0, MAX_BATCHES);
console.log(JSON.stringify({ uncovered: uncovered.length, batches: limitedBatches.length }));

async function handleBatch(batch) {
  const payload = batch.map((s) => ({
    syndrome: s.canonical,
    aliases: (s.aliases || []).slice(0, 4),
    locations: s.locations || [],
    natures: s.natures || [],
    candidates: candidatesFor(s),
  }));
  const user = `请裁定以下 ${payload.length} 个证候（候选方含出处与主治摘要）：\n${JSON.stringify(payload, null, 1)}`;
  const draft = await callAdjudicator({ system: SYS, user, maxTokens: 12000 });
  // 确定性校验
  const valid = [];
  const stats = { adopted: 0, blank: 0, rejectedPicks: 0 };
  for (const row of draft) {
    const src = payload.find((p) => p.syndrome === row.syndrome);
    if (!src) continue;
    const allowed = new Set(catalog.entries.map((f) => f.name));
    const picks = [];
    for (const pick of row.formulas || []) {
      if (!allowed.has(pick.name)) { stats.rejectedPicks += 1; continue; }
      // 名字对拍守卫：主治依据必须写明，防"寒→寒泻方"式名相似误选
      if (!pick.basis || String(pick.basis).length < 6) { stats.rejectedPicks += 1; continue; }
      const therapyTerms = [...new Set((pick.therapyTerms || []).map((t) => String(t).trim()).filter((t) => t.length >= 1 && t.length <= 8))].slice(0, 5);
      if (!therapyTerms.length) { stats.rejectedPicks += 1; continue; }
      const fit = pick.fit === "differential" ? "differential" : "primary";
      const out = { name: pick.name, therapyTerms, fit };
      if (fit === "differential") {
        if (!pick.discriminator || String(pick.discriminator).length < 6) { stats.rejectedPicks += 1; continue; }
        out.discriminator = String(pick.discriminator).slice(0, 80);
      }
      picks.push(out);
    }
    const dedup = [...new Map(picks.map((p) => [p.name, p])).values()].slice(0, 3);
    if (dedup.length === 0) { stats.blank += 1; continue; }
    valid.push({ syndrome: row.syndrome, formulas: dedup });
    stats.adopted += 1;
  }
  return { valid, stats };
}

await runPool({
  items: limitedBatches,
  keyOf: (b) => b.map((s) => s.canonical).join("|"),
  workers: 4,
  checkpointPath: resolve(OUT, "checkpoint.jsonl"),
  handle: handleBatch,
});

const cp = readCheckpoint(resolve(OUT, "checkpoint.jsonl"));
const relations = [];
const stats = { adopted: 0, blank: 0, rejectedPicks: 0, failedBatches: 0 };
for (const [, record] of cp) {
  if (!record.ok) { stats.failedBatches += 1; continue; }
  relations.push(...record.result.valid);
  stats.adopted += record.result.stats.adopted;
  stats.blank += record.result.stats.blank;
  stats.rejectedPicks += record.result.stats.rejectedPicks;
}
writeFileSync(resolve(OUT, "relations.json"), JSON.stringify(relations, null, 2) + "\n");
console.log(JSON.stringify({ newRelations: relations.length, ...stats }));
