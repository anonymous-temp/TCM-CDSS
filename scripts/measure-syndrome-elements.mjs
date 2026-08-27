// 证素（病位/病性）完整率与锁方率度量（2026-08-27，A 方案的前后对比尺）。
//
// 为什么要这把尺：朱文锋《证素辨证学》的辨证模式是「据症识证素 → 由证素组合成证名」，
// 我们的数据底座正是这个（36 病位 / 31 病性 / 2060 证候各带轴分解，共 5091 条），
// 但推理链是反过来的——模型先给证名，locationDifferentiation/natureDifferentiation
// 只是事后另填的字段。实测后果：同一病例证名在「心脾两虚证」与「气血亏虚证」间波动，
// 前者归脾汤 30 分锁定、后者归脾汤根本不在候选池（它挂 heart_spleen_deficiency 标签）。
//
// 度量三项（都只读已落盘的 M03 结构化载荷，不发请求）：
//   elementCoverage  证名的受治理轴分解里的病位/病性，被 items 显式列出的比例
//   locationFilled   证名轴分解含病位时，locationDifferentiation.items 非空的比例
//   formulaLocked    formulaSelectionMode ∈ {single, combined, alternatives} 的比例
//
// 用法：node scripts/measure-syndrome-elements.mjs <结果目录>...
//   目录内每个 *.json 需含 reasoning（tcmeval runner 的逐例产物即可）。
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const derived = JSON.parse(readFileSync(new URL("../src/data/clinical-vocabulary-derived.json", import.meta.url), "utf8"));
const AXES = derived.syndromeAxes || {};
const LOCATIONS = derived.locations || [];
const NATURES = derived.natures || [];

/** 中文病位/病性词 → 受控 id（用生成物里的 forms，不另写词表）。 */
const formToId = new Map();
for (const row of [...LOCATIONS, ...NATURES]) {
  for (const form of row.forms || []) formToId.set(form, row.id);
}

function axesOf(syndromeName) {
  const raw = String(syndromeName || "").trim();
  if (!raw) return null;
  return AXES[raw] || AXES[raw.replace(/证$/u, "")] || AXES[`${raw}证`] || null;
}

function idsFromItems(items) {
  const ids = new Set();
  for (const item of items || []) {
    const text = String(item || "").trim();
    if (!text) continue;
    const direct = formToId.get(text) || formToId.get(text.replace(/证$/u, ""));
    if (direct) { ids.add(direct); continue; }
    // 逐词包含：items 常写成「心、脾」或「心神」这类复合写法。
    for (const [form, id] of formToId) {
      if (form.length >= 1 && text.includes(form)) ids.add(id);
    }
  }
  return ids;
}

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error("usage: node scripts/measure-syndrome-elements.mjs <结果目录>...");
  process.exit(2);
}

for (const dir of dirs) {
  const rows = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "summary.json")) {
    try { rows.push(JSON.parse(readFileSync(join(dir, file), "utf8"))); } catch { /* 跳过坏文件 */ }
  }
  let withAxes = 0, locCovered = 0, locExpected = 0, natCovered = 0, natExpected = 0;
  let locationFilledWhenExpected = 0, locationExpectedCases = 0, locked = 0, resolvedOrBounded = 0;
  const misses = [];
  for (const row of rows) {
    const reasoning = row.reasoning || row;
    const overview = reasoning?.overview || {};
    const resolution = overview.primarySyndromeResolution;
    if (resolution !== "resolved" && resolution !== "bounded") continue;
    resolvedOrBounded += 1;
    if (["single", "combined", "alternatives"].includes(String(overview.formulaSelectionMode))) locked += 1;
    const axes = axesOf(overview.primarySyndrome);
    if (!axes) continue;
    withAxes += 1;
    const locIds = idsFromItems([
      ...(reasoning?.pathogenesis?.locationDifferentiation?.items || []),
      ...(reasoning?.pathogenesis?.locationDifferentiation?.details || []).map((d) => d.location),
    ]);
    const natIds = idsFromItems([
      ...(reasoning?.pathogenesis?.natureDifferentiation?.items || []),
      ...(reasoning?.pathogenesis?.natureDifferentiation?.rootDeficiency || []),
      ...(reasoning?.pathogenesis?.natureDifferentiation?.branchExcess || []),
    ]);
    const expectedLoc = axes.locations || [];
    const expectedNat = axes.natures || [];
    locExpected += expectedLoc.length;
    natExpected += expectedNat.length;
    locCovered += expectedLoc.filter((id) => locIds.has(id)).length;
    natCovered += expectedNat.filter((id) => natIds.has(id)).length;
    if (expectedLoc.length > 0) {
      locationExpectedCases += 1;
      if (locIds.size > 0) locationFilledWhenExpected += 1;
      const missing = expectedLoc.filter((id) => !locIds.has(id));
      if (missing.length > 0) {
        misses.push(`${row.id || "?"}｜${overview.primarySyndrome}｜缺病位:${missing.join(",")}｜已填:${[...locIds].join(",") || "(空)"}`);
      }
    }
  }
  const pct = (a, b) => (b > 0 ? `${((a / b) * 100).toFixed(1)}%` : "n/a");
  console.log(JSON.stringify({
    dir,
    cases: rows.length,
    scored: resolvedOrBounded,
    withGovernedAxes: withAxes,
    locationElementCoverage: pct(locCovered, locExpected),
    natureElementCoverage: pct(natCovered, natExpected),
    locationFilledWhenExpected: pct(locationFilledWhenExpected, locationExpectedCases),
    formulaLocked: pct(locked, resolvedOrBounded),
  }, null, 1));
  for (const line of misses.slice(0, 8)) console.log("   缺口:", line);
}
