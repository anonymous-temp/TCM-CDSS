// 第二批裁定结果格式化器:adjudicated.json → 勾选清单.md + 治理通道导入.json(与第一批同构)
// 用法: node scripts/ingest/syndrome-tag-format-b2.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const DIR = resolve(ROOT, process.env.ADJ_OUTDIR || "artifacts/syndrome-tag-adjudication-b2");
const SRC_MD = readFileSync(resolve(ROOT, process.env.ADJ_SRC || "artifacts/证型标签待裁定清单-第二批.md"), "utf-8");
const results = JSON.parse(readFileSync(resolve(DIR, "adjudicated.json"), "utf-8"));

// 原清单的候选/主治/出处,供勾选清单原样呈现
const blocks = new Map();
for (const block of SRC_MD.split(/^### /m).slice(1)) {
  const name = block.split("\n")[0].trim();
  const srcM = block.match(/\*出处：([^*]+)\*/);
  const indLines = [...block.matchAll(/^> (.+)$/gm)].map((m) => m[1]);
  const cands = [...block.matchAll(/- \[ \] (.+?) {2}`([^`]+)` {2}\(模型置信 ([\d.]+)\)/g)]
    .map((m) => ({ name: m[1].trim(), id: m[2].trim(), conf: Number(m[3]) }));
  blocks.set(name, { source: srcM?.[1]?.trim() || "", indLines, cands });
}

const adopt = results.filter((r) => r.decision === "adopt");
const blank = results.filter((r) => r.decision === "blank");
const errors = results.filter((r) => r.decision === "error");

const md = [];
md.push(`# 证型标签裁定结果·${process.env.ADJ_LABEL || "第二批"}（v4 pro max effort 初审 + 联网纠偏核验）`);
md.push("");
md.push(`共 ${results.length} 首：勾选 ${adopt.length}、留空 ${blank.length}、错误 ${errors.length}（留空=保持现状可检索不可锁定，安全默认）。标签均已确定性归一到 T1 受控词表。`);
md.push("");
for (const r of results) {
  const b = blocks.get(r.name) || { source: r.source, indLines: [], cands: [] };
  md.push(`### ${r.name}`);
  if (b.source) md.push(`*出处：${b.source}*`);
  for (const l of b.indLines) md.push(`> ${l}`);
  const adoptedIds = new Set((r.tags || []).map((t) => t.id));
  const adoptedNames = new Set((r.tags || []).map((t) => t.name));
  for (const c of b.cands) {
    const hit = adoptedIds.has(c.id) || adoptedNames.has(c.name);
    md.push(`- [${hit ? "x" : " "}] ${c.name}  \`${c.id}\`  (模型置信 ${c.conf})`);
  }
  // 候选外裁定
  const extra = (r.tags || []).filter((t) => !b.cands.some((c) => c.id === t.id || c.name === t.name));
  for (const t of extra) md.push(`- [x] ${t.name}  \`${t.id}\`  (候选外·裁定新增)`);
  if (r.decision === "blank") md.push(`- [ ] 以上都不对/拿不准，裁定：留空（安全默认，保持可检索不可锁定。）`);
  if (r.decision === "error") md.push(`- [ ] 裁定异常：${r.error}（按留空处理。）`);
  if (r.reason) md.push(`  裁定依据：${r.reason}`);
  if (r.droppedUnresolved) md.push(`  <sub>⚠ ${r.droppedUnresolved} 个模型自造名未能归一到 T1,已拦(不进表)。</sub>`);
  md.push("");
}
writeFileSync(resolve(DIR, "裁定结果-勾选清单.md"), md.join("\n") + "\n");

const imp = {
  schemaVersion: "syndrome-tag-adjudication-import-v1",
  source: process.env.ADJ_BATCH_NOTE || "ADJ-20260725-SYNDROME-TAG-B2:第二批 442 首,v4-pro max effort 初审 + 联网纠偏 + T1 确定性归一",
  total: results.length,
  adopted: adopt.length,
  blank: blank.length,
  entries: adopt.map((r) => ({
    name: r.name,
    curatedSyndromeTags: r.tags.map((t) => t.id),
    tagNames: r.tags.map((t) => t.name),
    reason: r.reason,
    group: r.group,
  })),
};
writeFileSync(resolve(DIR, "裁定结果-治理通道导入.json"), JSON.stringify(imp, null, 2) + "\n");
console.log(JSON.stringify({ total: results.length, adopted: adopt.length, blank: blank.length, errors: errors.length }));
