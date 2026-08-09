/**
 * 透明降级：剥离器产出的形态必须**恰好**是合同放行口认得的形态。
 *
 * 为什么需要这条套件：这是本仓库反复出现的那类缺陷——同一条判据在两处各写各的。
 *   · `markTransparentFormulaDeclassification`（diagnosis-api.ts）原来用「formulaNames 非空」
 *     判断有没有经典身份要剥；
 *   · `crossStageReasoningIssue` 的放行口要求「formulaNames 为空数组 + constructionType=self_devised
 *     + 方名逐字命中自拟模板」三者同时成立。
 * 于是有一整类漏网形态：模型给出经典方名却把 formulaNames 留空（或字段缺失）。剥离器认为
 * 「没有身份可剥」原样放过，放行口又认不出它是自拟 ⇒ mode=single 对不上空 formulaNames
 * ⇒ formula_direction_drift ⇒ 透明降级被拒 ⇒ **医生拿到 0 味**。
 *
 * 线上实测（2026-08-09 本地 695 例验收期间的服务器日志）：44 次「transparent formula fallback
 * not accepted」中，26 次驳回码是 m04_formula_direction_drift、9 次是 emperor_not_primary，
 * 而同一批日志里 strictFormulaIssue 全为 none —— 剥离后的自拟形态本身是合格的。
 *
 * 本套件钉住的不变量：
 *   1. 凡是需要降级的形态，剥离器输出必须满足 isDeclassifiedSelfDevisedCandidate；
 *   2. 可核验的「X 加减」不得被误剥（这条一旦破，方名可追溯率会塌）；
 *   3. 已经是自拟形态的候选不被二次改写。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const jiti = createJiti(import.meta.url, {
  jsx: true,
  interopDefault: true,
  alias: {
    "@": path.join(repoRoot, "src"),
    "server-only": path.join(repoRoot, "node_modules/next/dist/compiled/server-only/empty.js"),
  },
});

const { markTransparentFormulaDeclassification } = await jiti.import("../src/lib/diagnosis-api.ts");
const { isDeclassifiedSelfDevisedCandidate, m04SemanticIssue } =
  await jiti.import("../src/lib/diagnosis-stage-contract.ts");

const START = "<!-- DIAGNOSIS_JSON_START -->";
const END = "<!-- DIAGNOSIS_JSON_END -->";

function wrap(payload) {
  return `${START}\n${JSON.stringify(payload)}\n${END}`;
}
function unwrap(content) {
  const m = content.match(/<!-- DIAGNOSIS_JSON_START -->([\s\S]*?)<!-- DIAGNOSIS_JSON_END -->/);
  if (!m) return null;
  try { return JSON.parse(m[1].trim()); } catch { return null; }
}
function declassifyCandidate(candidate, extra = {}) {
  const payload = { schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", ...extra,
    formula: { ...(extra.formula || {}), candidates: [candidate, ...((extra.formula?.candidates) || []).slice(1)] } };
  return unwrap(markTransparentFormulaDeclassification(wrap(payload)))?.formula?.candidates?.[0];
}

const HERBS = [
  { name: "半夏", dose: "9g" }, { name: "陈皮", dose: "9g" },
  { name: "茯苓", dose: "12g" }, { name: "甘草", dose: "6g" },
];

let checks = 0;
const fail = [];
function ok(label, condition) {
  checks += 1;
  if (!condition) fail.push(label);
}

// ── 1. 需要降级的形态：剥离器输出必须被放行口认得 ────────────────────────────
const NEEDS_DECLASSIFICATION = [
  { label: "经典方名 + formulaNames 为空", candidate: { name: "二陈汤加减", formulaNames: [], constructionType: "classic_formula", herbs: HERBS } },
  { label: "经典方名 + formulaNames 字段缺失", candidate: { name: "二陈汤加减", constructionType: "classic_formula", herbs: HERBS } },
  { label: "经典方名（无加减后缀）+ formulaNames 为空", candidate: { name: "二陈汤", formulaNames: [], constructionType: "classic_formula", herbs: HERBS } },
  { label: "自拟但方名不合模板", candidate: { name: "健脾化痰方", formulaNames: [], constructionType: "self_devised", herbs: HERBS } },
  { label: "方名合模板但 constructionType 不对", candidate: { name: "本例辨证组方", formulaNames: [], constructionType: "classic_formula", herbs: HERBS } },
];

for (const item of NEEDS_DECLASSIFICATION) {
  const out = declassifyCandidate(item.candidate);
  ok(`剥离后被放行口认得: ${item.label}`, isDeclassifiedSelfDevisedCandidate(out));
  ok(`剥离后 formulaNames 是空数组: ${item.label}`, Array.isArray(out?.formulaNames) && out.formulaNames.length === 0);
  ok(`剥离后标记了降级原因: ${item.label}`, out?.identityDeclassified === true);
}

// ── 2. 已经是自拟形态的候选不被二次改写 ─────────────────────────────────────
for (const name of ["本例辨证组方", "本例辨证组方加减"]) {
  const out = declassifyCandidate({ name, formulaNames: [], constructionType: "self_devised", herbs: HERBS });
  ok(`已降级形态方名不被改写: ${name}`, out?.name === name);
  ok(`已降级形态仍被放行口认得: ${name}`, isDeclassifiedSelfDevisedCandidate(out));
}

// ── 3. 可核验的「X 加减」不得被误剥 ─────────────────────────────────────────
// 用归档真实产物做底：M03 锁定单一命名方、M04 候选带 formulaNames 且组成可核验。
// 这一条是本次改动的**反向护栏**——若剥离器变得过于激进，方名可追溯率会整体塌掉。
const archived = process.env.M04_DECLASS_CORPUS || "/tmp/p/pairs.json";
let verifiedKeptCount = 0;
let verifiedTotal = 0;
if (fs.existsSync(archived)) {
  let rows = [];
  try { rows = JSON.parse(fs.readFileSync(archived, "utf8")); } catch { rows = []; }
  const usable = (Array.isArray(rows) ? rows : []).filter((row) => {
    const cand = row?.m04?.formula?.candidates?.[0];
    return row?.m03?.overview?.formulaSelectionMode === "single" &&
      Array.isArray(cand?.formulaNames) && cand.formulaNames.length > 0 &&
      (cand.herbs || []).length >= 4;
  }).slice(0, 60);
  for (const row of usable) {
    verifiedTotal += 1;
    const out = declassifyCandidate(row.m04.formula.candidates[0], row.m04);
    if (Array.isArray(out?.formulaNames) && out.formulaNames.length > 0) verifiedKeptCount += 1;
  }
}
if (verifiedTotal > 0) {
  // 组成能核验为加减的必须保住经典身份。阈值取「至少一半」而不是全部：归档里本来就混着
  // 组成确实已不成立的候选，那些**应当**被剥离。硬指标是「不为零」+「不塌到个位数比例」。
  const keptRatio = verifiedKeptCount / verifiedTotal;
  ok(`可核验加减保住经典方名（${verifiedKeptCount}/${verifiedTotal}）`, keptRatio >= 0.5);
  console.log(`[test:transparent-declassification] 归档样本 ${verifiedTotal} 例，保住经典方名 ${verifiedKeptCount} 例`);
} else {
  console.log("[test:transparent-declassification] 未找到归档语料，跳过「不得误剥」的语料化断言（结构断言照常执行）");
}

// ── 4. 端到端：降级后的候选必须能过 M04 跨阶段合同的方名那一关 ──────────────
// 只在能取到归档真实 M03/M04 时执行——手搓夹具过不了前面的病机/证候一致性检查，
// 那样断言会退化成「测夹具」而不是测合同。
if (fs.existsSync(archived)) {
  let rows = [];
  try { rows = JSON.parse(fs.readFileSync(archived, "utf8")); } catch { rows = []; }
  const pick = (Array.isArray(rows) ? rows : []).find((row) => {
    const cand = row?.m04?.formula?.candidates?.[0];
    return row?.m03?.overview?.formulaSelectionMode === "single" &&
      Array.isArray(row?.m03?.overview?.recommendedFormulaNames) &&
      row.m03.overview.recommendedFormulaNames.length === 1 &&
      Array.isArray(cand?.formulaNames) && cand.formulaNames.length > 0 &&
      (cand.herbs || []).length >= 4 &&
      m04SemanticIssue(row.m04, "", row.m03, () => true, true, true, false, false, "", true) === undefined;
  });
  if (pick) {
    const base = pick.m04;
    const baseCand = base.formula.candidates[0];
    for (const [label, patch] of [
      ["formulaNames 为空", { formulaNames: [] }],
      ["formulaNames 缺失", { formulaNames: undefined }],
    ]) {
      const mutated = { ...base, formula: { ...base.formula, candidates: [{ ...baseCand, ...patch }, ...base.formula.candidates.slice(1)] } };
      const declassified = unwrap(markTransparentFormulaDeclassification(wrap(mutated)));
      const issue = m04SemanticIssue(declassified, "", pick.m03, () => true, true, true, false, false, "", true);
      ok(`端到端：${label} 降级后合同通过（实得 ${issue ?? "通过"}）`, issue === undefined);
    }
  } else {
    console.log("[test:transparent-declassification] 归档里没有合同本就通过的单方样本，跳过端到端断言");
  }
}

if (fail.length > 0) {
  console.error("[test:transparent-declassification] 失败项：");
  for (const item of fail) console.error("  - " + item);
}
assert.equal(fail.length, 0, `${fail.length}/${checks} 项失败`);
console.log(`[test:transparent-declassification] OK — ${checks} 项断言全过`);
