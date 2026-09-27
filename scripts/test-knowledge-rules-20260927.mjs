// 知识/规则层整改（2026-09-27）钉住的性质：
//  ① 方剂常用度分层：只有官方标准方、古代经典名方目录、现代医案≥3 例的方可锁定身份；冷僻条目不可锁定；开关可关。
//  ② 信任模型选方：模型自选的常用方与签名治法受控治法词对齐即保留（完带汤、参苓白术散）；
//     不对齐（阳黄例导赤散、藿香正气散对「辛凉解表」）或不在常用层即剔除；M03 保留与 M04 前复核同一谓词；
//     只靠信任保留的方 M04 另行组方时不强制修复；开关可关。
//  ③ 总体病机：结构性缺失仍是 T1；有病机要素、仅措辞对冲改为 T2 overall_pathogenesis_hedged，不再清空整份诊断。
//  ④ 证据：EviMed 条目与本例临床问题无交集不进提示词；超预算时先裁通用索引段，保留病例绑定材料段。
//  ⑤ 相似现代医案：确定性检索、至多 3 例、无剂量；M04 问责格式；referenceCaseUse 不进编译与定向修复底稿。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";

const jitiFor = () => createJiti(import.meta.url, {
  alias: { "@": `${process.cwd()}/src`, "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js` },
  moduleCache: false,
});
const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (error) { failures.push({ name, message: error.message }); } };

// ── ① 分层 ─────────────────────────────────────────────────────────────────
await check("formula common tier: official/classic always, others need ≥3 modern cases", async () => {
  const tier = await jitiFor().import("../src/lib/tcm-formula-tier.ts");
  const catalog = JSON.parse(readFileSync("src/data/tcm-formula-governed-catalog.json", "utf8")).entries;
  const lockable = catalog.filter((entry) => entry.identityLockEligible);
  const tiered = lockable.filter((entry) => tier.formulaInCommonTier(entry));
  assert.ok(tiered.length >= 600 && tiered.length <= 900, `tiered lockable formulas ${tiered.length} (measured 732 on 2026-09-27)`);
  const obscure = catalog.find((entry) => entry.name === "防饥救生四果丹");
  assert.ok(obscure, "fixture: 防饥救生四果丹 exists in the governed catalog");
  assert.equal(tier.formulaIdentityLockAllowed(obscure), false, "obscure single-source formula must not be lockable");
  process.env.CDSS_FORMULA_LOCK_TIER = "false";
  assert.equal(tier.formulaIdentityLockAllowed(obscure), obscure.identityLockEligible, "kill switch restores catalog eligibility");
  delete process.env.CDSS_FORMULA_LOCK_TIER;
});

// ── ② 信任模型选方 ───────────────────────────────────────────────────────────
const reasoning = (method, direction) => ({ overview: { recommendedFormulaDirection: direction, primarySyndrome: "测试证候", primarySyndromeResolution: "bounded" }, therapy: { overallMethod: method } });
await check("trusted model formula names: aligned common formulas kept; misaligned or obscure dropped", async () => {
  const m = await jitiFor().import("../src/lib/tcm-formula-indications.ts");
  const trusted = (name, method) => m.trustedModelFormulaIdentityNames(reasoning(method, `${name}加减`), [name]).size > 0;
  assert.equal(trusted("完带汤", "健脾益气，升阳除湿止带"), true, "名医原方完带汤（关系表曾剥离）");
  assert.equal(trusted("参苓白术散", "健脾益气，渗湿止泻"), true);
  assert.equal(trusted("银翘散", "辛凉解表，清热解毒"), true);
  assert.equal(trusted("血府逐瘀汤", "活血化瘀，行气止痛"), true);
  assert.equal(trusted("导赤散", "清热利湿退黄，通腑泄热"), false, "阳黄例：导赤散功效与签名治法无受控交集，照旧剔除");
  assert.equal(trusted("藿香正气散", "辛凉解表，清利头目"), false);
  assert.equal(trusted("防饥救生四果丹", "健脾益气"), false, "not in the common tier");
  const liverFire = { overview: { recommendedFormulaDirection: "玉女煎加减", primarySyndrome: "肝火扰心证", primarySyndromeResolution: "bounded" }, therapy: { overallMethod: "清肝泻火，安神" } };
  assert.equal(m.trustedModelFormulaIdentityNames(liverFire, ["玉女煎"]).size, 0, "syndrome-tag counter-evidence: 玉女煎〔胃热阴虚〕 vs 肝火扰心");
  assert.equal(m.trustedModelFormulaIdentityNames(liverFire, ["龙胆泻肝汤"]).size > 0, true, "compatible syndrome tags are kept");
  const noSyndrome = { overview: { recommendedFormulaDirection: "完带汤加减" }, therapy: { overallMethod: "健脾益气，升阳除湿止带" } };
  assert.equal(m.trustedModelFormulaIdentityNames(noSyndrome, ["完带汤"]).size, 0, "no primary syndrome ⇒ nothing to trust against");
  const noMethod = { overview: { recommendedFormulaDirection: "完带汤加减", primarySyndrome: "脾虚湿盛证" }, therapy: { overallMethod: "" } };
  assert.equal(m.trustedModelFormulaIdentityNames(noMethod, ["完带汤"]).size, 0, "no signed method terms ⇒ nothing to trust against");
});
await check("M04 recheck uses the same predicate as M03 retention", async () => {
  const m = await jitiFor().import("../src/lib/tcm-formula-indications.ts");
  const r = {
    stage: "diagnose",
    overview: { recommendedFormulaDirection: "银翘散加减", primarySyndrome: "风热犯肺证", overallPathogenesis: "风热犯肺，肺失宣降" },
    pathogenesis: { chain: [], locationDifferentiation: { items: ["肺"] }, natureDifferentiation: { items: ["热"] } },
    therapy: { overallMethod: "辛凉解表，清热解毒", overallPrinciple: "治病求本" },
  };
  assert.equal(m.namedFormulaPositiveSufficiencyIssue(r, ["银翘散"]), undefined, "a trusted M03 name must pass the M04 recheck");
  process.env.CDSS_FORMULA_TRUST_MODEL = "false";
  const strict = await jitiFor().import("../src/lib/tcm-formula-indications.ts");
  assert.equal(strict.trustedModelFormulaIdentityNames(r, ["银翘散"]).size, 0, "kill switch disables trust");
  delete process.env.CDSS_FORMULA_TRUST_MODEL;
  const source = readFileSync("src/lib/tcm-formula-indications.ts", "utf8");
  assert.equal((source.match(/trustedModelFormulaIdentityNames\(/g) || []).length >= 3, true, "definition + M03 enforce + M04 recheck");
});

await check("M04 prompt tells the model to carry a trusted M03-locked formula (not to self-devise)", async () => {
  const m = await jitiFor().import("../src/lib/tcm-formula-indications.ts");
  const r = {
    stage: "diagnose",
    overview: { recommendedFormulaNames: ["银翘散"], recommendedFormulaDirection: "银翘散加减", primarySyndrome: "风热犯肺证", formulaSelectionMode: "single" },
    pathogenesis: { chain: [], locationDifferentiation: { items: ["肺"] }, natureDifferentiation: { items: ["热"] } },
    therapy: { overallMethod: "辛凉解表，清热解毒" },
  };
  const context = m.buildTcmFormulaReasoningContext(r, 5);
  assert.match(context, /M03 已锁定方：银翘散/, "the trusted locked formula must be carried explicitly");
  assert.doesNotMatch(context, /若已锁定方未通过正向充分性，必须停止沿用该方名/, "no contradictory stop-carrying instruction for a trusted lock");
});

await check("trusted-only locks are soft in M04; relation-verified locks stay strict", async () => {
  const m = await jitiFor().import("../src/lib/tcm-formula-indications.ts");
  const r = {
    stage: "diagnose",
    overview: { recommendedFormulaNames: ["完带汤"], recommendedFormulaDirection: "完带汤加减", primarySyndrome: "脾虚湿盛证", formulaSelectionMode: "single" },
    pathogenesis: { chain: [], locationDifferentiation: { items: ["脾"] }, natureDifferentiation: { items: ["湿"] } },
    therapy: { overallMethod: "健脾益气，升阳除湿止带" },
  };
  const trustedOnly = m.lockedFormulaNamesIncludeModelTrustedOnly(r, ["完带汤"]);
  const provenance = readFileSync("src/lib/tcm-formula-provenance.ts", "utf8");
  assert.match(provenance, /if \(lockedFormulaNamesIncludeModelTrustedOnly\(prior, governedNames\)\) return undefined;/);
  assert.equal(typeof trustedOnly, "boolean");
  process.env.CDSS_FORMULA_TRUST_MODEL = "false";
  const off = await jitiFor().import("../src/lib/tcm-formula-indications.ts");
  assert.equal(off.lockedFormulaNamesIncludeModelTrustedOnly(r, ["完带汤"]), false, "with trust disabled every lock is strict");
  delete process.env.CDSS_FORMULA_TRUST_MODEL;
});

// ── ③ 总体病机对冲 ──────────────────────────────────────────────────────────
await check("hedged overall pathogenesis is T2, structurally empty stays T1", async () => {
  const contract = await jitiFor().import("../src/lib/diagnosis-stage-contract.ts");
  const tiers = await jitiFor().import("../src/lib/diagnosis-rejection-tiers.ts");
  assert.equal(contract.isStructurallyEmptyM03CoreText("脾胃气虚，运化失健，湿浊内停，病机尚待进一步明确"), false);
  assert.equal(contract.isUnstableM03CoreText("脾胃气虚，运化失健，湿浊内停，病机尚待进一步明确"), true, "fixture must be hedged");
  assert.equal(contract.isStructurallyEmptyM03CoreText(""), true);
  assert.equal(contract.isStructurallyEmptyM03CoreText("待定"), true);
  assert.equal(tiers.isSafetyRejection("overall_pathogenesis_hedged"), false, "hedged wording must not be T1");
  assert.equal(tiers.isSafetyRejection("overall_pathogenesis_unstable"), true, "structural absence stays T1");
  const source = readFileSync("src/lib/diagnosis-stage-contract.ts", "utf8");
  assert.match(source, /if \(!overallPathogenesis \|\| isStructurallyEmptyM03CoreText\(overallPathogenesis\)\) \{ const e = emit\("overall_pathogenesis_unstable"\)/);
  assert.match(source, /return "overall_pathogenesis_hedged"/);
});

// ── ④ 证据 ────────────────────────────────────────────────────────────────
await check("priority compaction keeps case-bound sections and trims the generic index first", async () => {
  const { compactEvidenceContextForPrompt } = await jitiFor().import("../src/lib/prompt-budget.ts");
  const bulk = (label, n) => Array.from({ length: n }, (_, i) => `${label}第${i + 1}行${"字".repeat(40)}`).join("\n");
  const source = [
    "【外部证据与院内知识支持】", "## 官方基础依据", "- [OFFICIAL-1] 官方依据",
    "## 院内合理用药/中药标准资料支持", bulk("剂量索引", 120),
    "## 本地方剂出处库", "- 参苓白术散：《太平惠民和剂局方》",
    "【本地中成药说明书检索（病例绑定候选；不是自动处方）】", "- [LOCAL-INST-001] 参苓白术丸",
    "## 外部证据检索支持", "## EviMed 指南/共识检索", bulk("指南条目", 30),
    "## 厂商临床决策卡片（专家决策参考，非证据来源）", "- 卡片一",
  ].join("\n");
  const out = compactEvidenceContextForPrompt(source, 3000);
  assert.ok(out.truncated && out.text.length <= 3000, `bounded: ${out.text.length}`);
  for (const kept of ["## 本地方剂出处库", "参苓白术散：《太平惠民和剂局方》", "[LOCAL-INST-001]", "## 厂商临床决策卡片", "[OFFICIAL-1]"]) {
    assert.ok(out.text.includes(kept), `case-bound section must survive: ${kept}`);
  }
  assert.ok(!out.text.includes("剂量索引第120行"), "the generic index is trimmed first");
  process.env.CDSS_EVIDENCE_PRIORITY_COMPACTION = "false";
  const positional = compactEvidenceContextForPrompt(source, 3000);
  assert.ok(!positional.text.includes("[LOCAL-INST-001]"), "fixture: positional compaction drops the middle (the defect being fixed)");
  delete process.env.CDSS_EVIDENCE_PRIORITY_COMPACTION;
});
await check("EviMed items unrelated to the case's clinical problems are dropped", async () => {
  process.env.EVIMED_GUIDE_API_KEY = "test-only-placeholder";
  process.env.CDSS_EVIDENCE_FETCH_CACHE = "false";
  const evimed = await jitiFor().import("../src/lib/evimed-guide.ts");
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ code: 200, data: { list: [
    { title: "黄褐斑中医治疗专家共识", url: "https://example.test/1", publisher: "学会", year: "2019" },
    { title: "慢性胃炎中医诊疗专家共识意见", url: "https://example.test/2", publisher: "学会", year: "2021" },
    { title: "玫瑰糠疹中医治疗专家共识", url: "https://example.test/3", publisher: "学会", year: "2020" },
  ] } }), { headers: { "content-type": "application/json" } });
  try {
    const state = { patient: {}, chiefComplaint: "胃痛1月", symptoms: { presentHistory: "胃痛，食后胀满，纳差" }, conversation: [] };
    const context = await evimed.buildGuideEvidenceContext(state, "prescribe");
    assert.ok(context.includes("慢性胃炎中医诊疗专家共识意见"), "relevant guideline kept");
    assert.ok(!context.includes("黄褐斑") && !context.includes("玫瑰糠疹"), "unrelated dermatology consensus dropped");
    process.env.CDSS_EVIDENCE_RELEVANCE_FILTER = "false";
    const unfiltered = await evimed.buildGuideEvidenceContext(state, "prescribe");
    assert.ok(unfiltered.includes("黄褐斑"), "kill switch restores the unfiltered list");
  } finally {
    globalThis.fetch = previousFetch;
    delete process.env.CDSS_EVIDENCE_RELEVANCE_FILTER;
    delete process.env.CDSS_EVIDENCE_FETCH_CACHE;
  }
});

// ── ⑤ 相似现代医案 ──────────────────────────────────────────────────────────
await check("similar modern cases: deterministic top-3, disease-relevant, no doses, kill switch", async () => {
  const data = JSON.parse(readFileSync("src/data/tcm-modern-case-exemplars.json", "utf8"));
  assert.match(data.license, /全部版权/);
  assert.ok(data.exemplars.length > 10000);
  assert.ok(data.exemplars.every((item) => item.hb.every((herb) => !/\d/.test(herb))), "no doses in exemplars");
  assert.ok(data.exemplars.every((item) => !/穿山甲|犀角|虎骨|熊胆/.test(item.hb.join(""))), "banned animal materials excluded");
  const exclusions = JSON.parse(readFileSync("src/data/tcm-modern-case-exemplar-exclusions.source.json", "utf8")).excludedCaseIds;
  const ids = new Set(data.exemplars.map((item) => item.id));
  assert.ok(Object.keys(exclusions).every((id) => !ids.has(id)), "evaluation-independence exclusions honoured");
  const m = await jitiFor().import("../src/lib/modern-case-exemplars.server.ts");
  const state = { patient: {}, chiefComplaint: "胃脘疼痛不适1月余", symptoms: { presentHistory: "胃脘胀满隐痛，食后加重，纳差便溏，神疲乏力" }, tongue: "舌淡苔薄白腻", pulse: "脉细", conversation: [] };
  const first = m.retrieveSimilarModernCases(state, "diagnose");
  const second = m.retrieveSimilarModernCases(state, "diagnose");
  assert.ok(first.length > 0 && first.length <= 3);
  assert.deepEqual(first.map((item) => item.id), second.map((item) => item.id), "deterministic");
  assert.ok(first.some((item) => /胃/.test(`${item.dxT}${item.dxW}${item.cc}`)), "a gastric exemplar is retrieved for a gastric case");
  const m04 = m.buildSimilarModernCaseContext(state, "prescribe").context;
  assert.match(m04, /referenceCaseUse/, "M04 context carries the accountability format");
  assert.match(m04, /不是处方依据/);
  const moduleSource = readFileSync("src/lib/modern-case-exemplars.server.ts", "utf8");
  assert.match(moduleSource, /readFileSync\(path\.join\(process\.cwd\(\), "src", "data", "tcm-modern-case-exemplars\.json"\), "utf8"\)/,
    "exemplars load at runtime from src/data (static import bundled 7.7MB into two route chunks and OOM-killed the prebuild)");
  assert.doesNotMatch(moduleSource, /new URL\("\.\.\/data\/tcm-modern-case-exemplars/, "webpack rewrites new URL(…, import.meta.url) into an asset RelativeURL that fs rejects in production");
  assert.doesNotMatch(moduleSource, /from "\.\.\/data\/tcm-modern-case-exemplars\.json"/);
  process.env.CDSS_SIMILAR_CASES = "false";
  assert.equal(m.retrieveSimilarModernCases(state, "diagnose").length, 0);
  delete process.env.CDSS_SIMILAR_CASES;
});
await check("referenceCaseUse never reaches the compiler or the candidate-patch base", async () => {
  const repair = await jitiFor().import("../src/lib/structured-clinical-repair.ts");
  const base = repair.m04CandidatePatchBase(JSON.stringify({ candidate: { name: "参苓白术散加减", herbs: [] }, referenceCaseUse: { adoptedCaseIds: ["MC-1"], note: "借鉴随证加减" } }));
  assert.ok(base, "a proposal with referenceCaseUse must still be a valid candidate-patch base (else repair falls back to a full rewrite: 41s vs ~25s)");
  assert.equal("referenceCaseUse" in base, false);
  const api = readFileSync("src/lib/diagnosis-api.ts", "utf8");
  assert.match(api, /accumulatedContent = takeM04ReferenceCaseUse\(accumulatedContent\)/);
});

console.log(JSON.stringify({ suite: "knowledge-rules-20260927", failures }, null, 1));
if (failures.length) process.exit(1);
