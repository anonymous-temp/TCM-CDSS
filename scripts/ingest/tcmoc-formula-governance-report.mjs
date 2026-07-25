// 医方集解抽取结果 → 治理分析：新方候选 / 已有方增强 / 同名异方 / 问题清单
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const SRC = resolve(ROOT, "artifacts/tcmoc-formula-extract-yifangjijie/yifangjijie-full.jsonl");
const catalog = JSON.parse(readFileSync(resolve(ROOT, "src/data/tcm-formula-governed-catalog.json"), "utf-8"));
const OUT = resolve(ROOT, "artifacts/tcmoc-formula-extract-yifangjijie/governance-report.json");

const nameToEntry = new Map();
const aliasToEntry = new Map();
for (const e of catalog.entries) {
  nameToEntry.set(e.name, e);
  for (const a of [e.name, ...(e.aliases || [])]) aliasToEntry.set(a, e);
}

const rows = readFileSync(SRC, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
const ok = rows.filter((r) => r.ok);
const report = { total: rows.length, ok: ok.length, failed: rows.length - ok.length,
  withIssues: ok.filter((r) => r.issues.length > 0).length,
  newCandidates: [], enhancementCandidates: [], sameNameCompositionDiff: [], issueList: [] };

for (const r of ok) {
  const j = r.extracted;
  const name = String(j.name || r.chapter);
  const hit = aliasToEntry.get(name);
  if (r.issues.length > 0) {
    report.issueList.push({ chapter: r.chapter, issues: r.issues });
  }
  if (!hit) {
    report.newCandidates.push({ chapter: r.chapter, source: j.source, herbs: (j.composition || []).length, indications: (j.indications || "").slice(0, 60), hasDoses: (j.composition || []).some((c) => c.dose) });
  } else {
    // 已有条目：组成是否一致（用于增强/异方提示）
    const existing = new Set((hit.ingredients || []).map((x) => x.replace(/^(蜜炙|麸炒|土炒|炒|炙|醋制|酒制|盐制|姜制|煅|制)/, "")));
    const extracted = new Set((j.composition || []).map((c) => c.herb));
    const overlap = [...extracted].filter((x) => existing.has(x) || [...existing].some((e) => e.includes(x) || x.includes(e)));
    const ratio = extracted.size ? overlap.length / extracted.size : 0;
    if (ratio < 0.5 && extracted.size >= 4) {
      report.sameNameCompositionDiff.push({ chapter: r.chapter, catalog: [...existing].slice(0, 8), extracted: [...extracted].slice(0, 8), overlapRatio: ratio.toFixed(2) });
    } else {
      report.enhancementCandidates.push({ chapter: r.chapter, overlapRatio: ratio.toFixed(2), hasDoses: (j.composition || []).some((c) => c.dose), mods: (j.modifications || []).length });
    }
  }
}
writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ total: report.total, ok: report.ok, failed: report.failed, withIssues: report.withIssues, newCandidates: report.newCandidates.length, enhancement: report.enhancementCandidates.length, sameNameDiff: report.sameNameCompositionDiff.length }));
console.log("\n新方候选样例:");
for (const c of report.newCandidates.slice(0, 15)) console.log(`  ${c.chapter} | ${c.source || "-"} | ${c.herbs}味 | ${c.indications.slice(0, 40)}`);
console.log("\n同名组成分歧样例:");
for (const c of report.sameNameCompositionDiff.slice(0, 8)) console.log(`  ${c.chapter} | 目录:[${c.catalog.join("、")}] vs 集解:[${c.extracted.join("、")}] (${c.overlapRatio})`);
