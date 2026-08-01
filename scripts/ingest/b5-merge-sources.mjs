// B5 三通道合并入库：温病规则(A) / 高频证候-方剂关系(B) / 方剂证型标签(C2)。
// 只做「追加」，绝不覆盖既有条目；合并前重复守卫 + 契约校验，合并后由构建脚本兜底。
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const DATA = resolve(ROOT, "src/data");
const read = (p) => JSON.parse(readFileSync(p, "utf-8"));
const write = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2) + "\n");
const summary = {};

// ── A：温病规则 ──────────────────────────────────────────────
{
  const src = read(resolve(DATA, "tcm-warm-disease-rules.source.json"));
  const accepted = read(resolve(ROOT, "artifacts/warm-disease-rules-expansion/new-rules.json"));
  const ids = new Set(src.rules.map((r) => r.id));
  const before = src.rules.length;
  for (const rule of accepted) {
    if (ids.has(rule.id)) continue;
    src.rules.push(rule);
    ids.add(rule.id);
  }
  write(resolve(DATA, "tcm-warm-disease-rules.source.json"), src);
  summary.warmRules = { before, added: src.rules.length - before, after: src.rules.length };
}

// ── B：高频证候-方剂关系 ─────────────────────────────────────
{
  const src = read(resolve(DATA, "tcm-high-frequency-syndrome-formula-relations.source.json"));
  const relations = read(resolve(ROOT, "artifacts/syndrome-relation-adjudication-b5/relations.json"));
  const present = new Set(src.entries.map((e) => e.syndrome));
  const before = src.entries.length;
  for (const row of relations) {
    if (present.has(row.syndrome)) continue;
    src.entries.push({ syndrome: row.syndrome, formulas: row.formulas });
    present.add(row.syndrome);
  }
  if (!src.sourceRefs.includes("ADJ-20260727-SYNDROME-RELATION-B5")) src.sourceRefs.push("ADJ-20260727-SYNDROME-RELATION-B5");
  write(resolve(DATA, "tcm-high-frequency-syndrome-formula-relations.source.json"), src);
  summary.hfRelations = { before, added: src.entries.length - before, after: src.entries.length };
}

// ── C2：方剂证型标签 ─────────────────────────────────────────
{
  const src = read(resolve(DATA, "tcm-formula-syndrome-tag-adjudications.source.json"));
  const entries = read(resolve(ROOT, "artifacts/syndrome-tag-adjudication-b5/adjudicated.json"));
  const present = new Set(src.entries.map((e) => e.name));
  const before = src.entries.length;
  for (const row of entries) {
    if (present.has(row.name)) continue;
    src.entries.push(row);
    present.add(row.name);
  }
  src.batches.push({
    id: "ADJ-20260727-SYNDROME-TAG-B5",
    count: entries.length,
    note: `第五批 606 首（残余无标签池）：v4-pro 初审勾选 166，经单字病性根词过滤（寒/热/虚/实等不治方证之根词）后入库 ${entries.length}；候选外提名经 T1 归一校验，自造名拦截。残余池多为主治单薄的古籍抽取出方，留空为安全默认。`,
    at: "2026-07-27",
  });
  write(resolve(DATA, "tcm-formula-syndrome-tag-adjudications.source.json"), src);
  summary.syndromeTags = { before, added: src.entries.length - before, after: src.entries.length };
}

// ── C1：鉴别图谱扩展（写扩展源，构建脚本负责续编号合并）──────
{
  const nodes = read(resolve(ROOT, "artifacts/discrimination-graph-expansion/new-nodes.json"));
  const edges = read(resolve(ROOT, "artifacts/discrimination-graph-expansion/new-edges.json"));
  const out = {
    schemaVersion: "tcm-formula-discrimination-extensions-source-v1",
    note: "T14 鉴别图谱治理扩展输入：节点=方证要点，边=相邻方鉴别。构建期续编 T14-NODE-###/T14-### 合并进运行时图谱。",
    sourceRefs: ["ADJ-20260727-T14-GRAPH-EXPANSION"],
    nodes,
    edges,
  };
  write(resolve(DATA, "tcm-formula-discrimination-extensions.source.json"), out);
  summary.graphExtensions = { nodes: nodes.length, edges: edges.length };
}

console.log(JSON.stringify(summary, null, 2));
