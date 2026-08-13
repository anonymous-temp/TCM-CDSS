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
const { isDeclassifiedSelfDevisedCandidate, candidateClassicIdentityMatchesPrior, m04SemanticIssue } =
  await jiti.import("../src/lib/diagnosis-stage-contract.ts");
const { identifyGovernedFormulaByComposition, isCompositionRestoredGovernedIdentity, formulaCompilationContractIssue } =
  await jiti.import("../src/lib/tcm-formula-provenance.ts");

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

// ── 5. 候选自称的经典身份与 M03 锁定不一致时，必须剥离而不是保留 ──────────────
// 同一缺陷类的另一半：剥离器第一档「组成可核验为加减」原来不看 M03 锁的是哪张方，
// 于是保留了一个与锁定方不一致的经典身份，合同随即判 formula_direction_drift ⇒ 整方作废。
// 修掉「formulaNames 为空」那一类之后，线上剩余 9 次降级被拒里仍有 6 次是这个码。
if (fs.existsSync(archived)) {
  let rows = [];
  try { rows = JSON.parse(fs.readFileSync(archived, "utf8")); } catch { rows = []; }
  const pick = (Array.isArray(rows) ? rows : []).find((row) => {
    const cand = row?.m04?.formula?.candidates?.[0];
    return row?.m03?.overview?.formulaSelectionMode === "single" &&
      Array.isArray(row?.m03?.overview?.recommendedFormulaNames) &&
      row.m03.overview.recommendedFormulaNames.length === 1 &&
      Array.isArray(cand?.formulaNames) && cand.formulaNames.length > 0 &&
      (cand.herbs || []).length >= 4;
  });
  if (pick) {
    const baseCandidate = pick.m04.formula.candidates[0];
    const mismatchedPrior = {
      ...pick.m03,
      overview: { ...pick.m03.overview, recommendedFormulaNames: ["二陈汤"] },
    };
    const outMismatched = unwrap(markTransparentFormulaDeclassification(wrap(pick.m04), mismatchedPrior))
      ?.formula?.candidates?.[0];
    ok("身份与 M03 锁定不一致时必须剥离", isDeclassifiedSelfDevisedCandidate(outMismatched));
    ok(
      "不一致剥离后 formulaNames 清空",
      Array.isArray(outMismatched?.formulaNames) && outMismatched.formulaNames.length === 0,
    );

    // 反向：锁定的就是候选自称的那张时，身份**不得**被剥掉。
    const outAligned = unwrap(markTransparentFormulaDeclassification(wrap(pick.m04), pick.m03))
      ?.formula?.candidates?.[0];
    ok(
      "身份与 M03 锁定一致时不得误剥",
      Array.isArray(outAligned?.formulaNames) && outAligned.formulaNames.length > 0,
    );

    // 谓词本身：合同与剥离器共用的那一份必须给出与上面一致的答案。
    ok("对齐谓词：一致 → true", candidateClassicIdentityMatchesPrior(baseCandidate, pick.m03));
    ok("对齐谓词：不一致 → false", !candidateClassicIdentityMatchesPrior(baseCandidate, mismatchedPrior));
    // M03 未建立受治理方名合同时维持既有行为，不因本判据额外剥离。
    ok(
      "对齐谓词：M03 无方名合同 → true（维持既有行为）",
      candidateClassicIdentityMatchesPrior(baseCandidate, { overview: {} }),
    );
  } else {
    console.log("[test:transparent-declassification] 归档里没有单方样本，跳过身份对齐断言");
  }
}

// ── 服务端按组成反查补回的身份，合同必须认得自己人（甲方 2026-08-13 P0）────────────────
//
// 缺陷实证（生产日志 + 本地 8 次循环复现 2 次）：M03 未锁定任何方名（模型选的养胃增液汤因
// 受控证候关系未核实被撤，mode=self_devised、names=[]），M04 组出 8 味、全部安全校验通过；
// 随后 wrapStructuredJsonObject 对每一版 M04 响应都会跑 restoreGovernedFormulaIdentity 的
// 「形态三」按组成反查补回身份（方名可追溯特性），候选变成
//   name=养胃增液汤加减 formulaNames=[养胃增液汤] constructionType=single_base
// 而合同规定 self_devised ⇒ formulaNames 必须为空 ⇒ formula_direction_drift ⇒ 整方作废。
// **服务端生产了一个自己的合同禁止的形态**，两条受治理判据方向相反，输的是整张处方。
//
// 判据独立重跑组成反查、不信任任何标记字段（模型的 JSON 同样能写标记）。本节钉的是
// 「认得自己人」与「不放行冒名者」两侧，缺一即回到旧缺陷或引入新的冒名通道。
{
  const restoredHerbs = ["干石斛", "北沙参", "玉竹", "乌梅肉", "白芍", "甘草", "麦冬", "生地黄"]
    .map((name) => ({ name, dose: "10g" }));
  const identified = identifyGovernedFormulaByComposition(restoredHerbs);
  ok("组成反查能识别出受治理方（夹具前提）", Boolean(identified));
  if (identified) {
    ok(
      "服务端反查产物：M03 未锁方名时合同必须放行",
      isCompositionRestoredGovernedIdentity(
        { formulaNames: [identified.formulaName], herbs: restoredHerbs }, [], "self_devised",
      ),
    );
    ok(
      "冒名者：方名与组成反查结果不一致时仍判漂移",
      !isCompositionRestoredGovernedIdentity(
        { formulaNames: ["麻黄汤"], herbs: restoredHerbs }, [], "self_devised",
      ),
    );
    ok(
      "声明多个方名时不成立（反查只产出单一身份）",
      !isCompositionRestoredGovernedIdentity(
        { formulaNames: [identified.formulaName, "麦门冬汤"], herbs: restoredHerbs }, [], "self_devised",
      ),
    );
    ok(
      "无药味时不成立（无组成即无可核验事实）",
      !isCompositionRestoredGovernedIdentity(
        { formulaNames: [identified.formulaName], herbs: [] }, [], "self_devised",
      ),
    );
    ok(
      "M03 已锁定方名时本路径整条不适用（交回原对齐判据）",
      !isCompositionRestoredGovernedIdentity(
        { formulaNames: [identified.formulaName], herbs: restoredHerbs }, [identified.formulaName], "single",
      ),
    );
    // 端到端：**差分**断言，打的是漂移码的产地 formulaCompilationContractIssue 本身
    // （m04SemanticIssue 前置条件太多，用它会先撞别的码而变成空转——第一版正是如此，
    // 负向自检没变红才发现）。两份载荷只差 formulaNames 一个字段：
    // 服务端反查产物必须放行，模型冒名必须仍判漂移。
    const priorSelfDevised = {
      schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
      overview: {
        primarySyndrome: "胃阴虚证", overallPathogenesis: "胃阴亏虚，胃失濡养",
        recommendedFormulaNames: [], formulaSelectionMode: "self_devised",
        recommendedFormulaDirection: "按已锁定病机与治法辨证组方",
      },
      pathogenesis: { summary: "胃阴亏虚", chain: [] },
      therapy: { overallPrinciple: "滋脾养胃", overallMethod: "滋脾养胃，佐以助运", subTherapies: [] },
    };
    const restoredReasoning = {
      schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe",
      overview: {
        primarySyndrome: "胃阴虚证", overallPathogenesis: "胃阴亏虚，胃失濡养",
        recommendedFormulaDirection: "按已锁定病机与治法辨证组方",
      },
      therapy: { overallPrinciple: "滋脾养胃", overallMethod: "滋脾养胃，佐以助运", subTherapies: [] },
      pathogenesis: { summary: "胃阴亏虚", chain: [] },
      formula: {
        candidates: [{
          name: identified.displayName, formulaNames: [identified.formulaName],
          constructionType: "single_base", modificationStatus: "modified",
          herbs: restoredHerbs, decoction: {},
        }],
        modifications: [], patentAndWestern: [],
      },
    };
    const restoredIssue = formulaCompilationContractIssue(restoredReasoning, priorSelfDevised);
    ok(
      `服务端反查产物必须放行（实际 ${restoredIssue || "通过"}）`,
      restoredIssue !== "formula_direction_drift",
    );
    const bogusReasoning = JSON.parse(JSON.stringify(restoredReasoning));
    bogusReasoning.formula.candidates[0].formulaNames = ["麻黄汤"];
    ok(
      "模型冒名（组成对不上）必须仍判 formula_direction_drift",
      formulaCompilationContractIssue(bogusReasoning, priorSelfDevised) === "formula_direction_drift",
    );
  }
}

if (fail.length > 0) {
  console.error("[test:transparent-declassification] 失败项：");
  for (const item of fail) console.error("  - " + item);
}
assert.equal(fail.length, 0, `${fail.length}/${checks} 项失败`);
console.log(`[test:transparent-declassification] OK — ${checks} 项断言全过`);
