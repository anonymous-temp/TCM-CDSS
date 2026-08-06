// 受控数据可达性回归(2026-08-05)。
//
// 这个项目反复出现同一个形状的缺陷，代价一次比一次大：
//   · 国标病名编码在库里，运行时没读 → 病名不带编码
//   · 治法词表 956 条 method_requires_case_binding，运行时没读 → 治法不绑病例
//   · 症状轴图缺全部部位性主症 → 产后头痛例九味药没一味针对头痛
//   · 方剂鉴别图只喂 prompt，没进判定
//   · 中成药禁忌列没人读
//   · ingredientLinks 的药典标准名没人用 → 「炒牛蒡子 vs 牛蒡子」让整方判组成不符、方名被剥
//   · restoreGovernedFormulaIdentity 写好了、单测过了，**没接进 M04 finalize 那条链**
//   · 穴位目录 400 穴每穴都带教材主治，运行时按「模板里出现得多」选穴，主治从未查过
//
// 每一次的表现都不同，根因是同一个：**治理数据躺在仓库里，运行时没有真正读它**。
// 逐个撞是撞不完的，所以把它变成一条常驻判据：受控数据文件必须被运行时代码引用，
// 关键字段必须被真正查询。新增数据资产而忘了接线，在这里就会挡下来。
//
// 判据只钉「有没有被读」，不钉「读得对不对」——后者是各自领域回归的事。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });

const runtimeSources = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(?:ts|tsx)$/.test(entry.name)) runtimeSources.push(fs.readFileSync(full, "utf8"));
  }
};
walk("src");
const runtimeText = runtimeSources.join("\n");

const failures = [];

// ── 一、非 .source 的受控数据文件必须被运行时引用 ────────────────────────
//
// `.source.json` 是构建期输入（由 scripts/ 消费后生成产物），不要求运行时引用；
// manifest 由治理回归消费；语料是评测输入。其余每一个都必须有人读。
const BUILD_TIME_ONLY = new Set([
  "clinical-governance-source-registry.json",   // 来源登记，由治理表回归核对
  "clinical-governance-table-manifest.json",    // 哈希清单，由治理表回归核对
  "external-data-manifest.json",                // 外部数据来源登记
  "nihaisha-fusion-manifest.json",              // 融合批次登记
  "szjg-tcm-formula-standard.json",             // 方剂目录的构建输入
  "tcm-classic-case-eval-corpus.json",          // 评测语料
  "tcm-modern-case-eval-corpus.json",           // 评测语料
  "tcm-herb-identity-supplements.json",         // 药名识别补充，由 build:tcm-knowledge 合并
  // 下面两条被 .jsonl 取代：运行时经 tcm-classic-evidence.server.ts 读
  // tcm-classic-text-evidence.jsonl 与 tcm-classic-text-evidence-tcmoc.jsonl；
  // 这两个 .json 是早期产物与其构建清单，保留作溯源，不参与运行时。
  // （本条登记正是这条检测的价值：它逼着把「为什么没人读」查清楚，而不是含糊放过。）
  "tcm-classic-formula-evidence.json",
  "tcm-classic-text-evidence-tcmoc-manifest.json",
]);
// 真正在用的经典条文数据是 .jsonl，一并纳入可达性检查，避免「换了扩展名就脱管」。
for (const jsonl of ["tcm-classic-text-evidence.jsonl", "tcm-classic-text-evidence-tcmoc.jsonl"]) {
  if (fs.existsSync(path.join("src/data", jsonl)) && !runtimeText.includes(jsonl)) {
    failures.push({ kind: "unreferenced_governed_data", file: jsonl, why: "经典条文证据必须被运行时读取" });
  }
}
for (const file of fs.readdirSync("src/data").filter((name) => name.endsWith(".json"))) {
  if (file.endsWith(".source.json") || BUILD_TIME_ONLY.has(file)) continue;
  const stem = file.replace(/\.json$/, "");
  if (!runtimeText.includes(stem)) {
    failures.push({
      kind: "unreferenced_governed_data",
      file,
      why: "受控数据文件没有任何运行时引用。要么接线，要么登记进 BUILD_TIME_ONLY 并写明它由谁消费——" +
        "沉默地躺在仓库里是本项目反复出现的缺陷根因。",
    });
  }
}

// ── 二、关键字段必须被真正查询，而不只是「文件被 import 了」 ──────────────
//
// 文件被 import 只能证明打开过，不能证明用上了。这里逐条钉住那些**曾经就是这样漏掉**
// 的字段：每一条都对应一次真实的线上缺陷。
const FIELD_MUST_BE_QUERIED = [
  ["indications", "src/lib/tcm-acupoints.ts", "穴位主治：不查它，选穴就退化成通用池（甲方 6.1）"],
  ["canonicalName", "src/lib/tcm-formula-provenance.ts", "药典标准名：不查它，炒牛蒡子↔牛蒡子会让整方判组成不符、方名被剥"],
  ["curatedSyndromeRelations", "src/lib/tcm-formula-indications.ts", "人工审定证候-方剂关系：不查它，正向充分性只剩释义特征匹配"],
];
for (const [field, file, why] of FIELD_MUST_BE_QUERIED) {
  const text = fs.readFileSync(file, "utf8");
  if (!text.includes(field)) {
    failures.push({ kind: "governed_field_never_queried", field, file, why });
  }
}

// ── 三、确定性投影必须真的接进流水线 ────────────────────────────────────
//
// 最贵的一次教训：restoreGovernedFormulaIdentity 写好了、单测全过、被 import 了，
// 但没出现在 M04 finalize 的那串 applyDeterministic* 调用里，于是 finalize 用的是
// 恢复之前的内容，可见摘要按它重渲染，方名永久落在「本例辨证组方」。
// 我为此做了四轮定点日志部署，每轮排除一个错误假设——而真相是它压根不在链上。
const apiText = fs.readFileSync("src/lib/diagnosis-api.ts", "utf8");
const finalizeChain = apiText.slice(
  apiText.indexOf("applyDeterministicHerbTargets(authoritativeContent"),
  apiText.indexOf("synchronizeVisibleClinicalSummary(authoritativeContent"),
);
for (const projection of [
  "applyDeterministicHerbFunctions",
  "applyDeterministicHerbPrescriptionRoles",
  "applyDeterministicFormulaAnalysis",
  "applyRestoredGovernedFormulaIdentity",
]) {
  if (!finalizeChain.includes(projection)) {
    failures.push({
      kind: "projection_not_in_finalize_chain",
      projection,
      why: "确定性投影必须出现在 M04 finalize 的 authoritativeContent 链里且排在可见摘要同步之前；" +
        "只在别处调用一次不算数——finalize 会用未经它处理的内容重渲染整页。",
    });
  }
}

// ── 四、按适应证选穴必须真的产出与本例相关的穴位 ──────────────────────────
{
  const acupoints = await jiti.import("../src/lib/tcm-acupoints.ts");
  const windCold = acupoints.selectAcupointsForCaseTerms(["恶寒", "发热", "头痛", "鼻塞", "无汗", "咳嗽"], 5);
  if (windCold.length === 0) {
    failures.push({ kind: "acupoint_selection_empty", why: "风寒感冒主症必须能选出穴位" });
  }
  const names = windCold.map((item) => item.entry.name);
  // 不钉具体某几个穴（教材取穴有流派差异），钉方向：必须命中解表要穴，且每穴都有入选依据。
  if (!names.some((name) => ["合谷", "风池", "风门", "列缺", "大椎"].includes(name))) {
    failures.push({ kind: "acupoint_selection_offtarget", why: `风寒感冒未选中任一解表要穴: ${names.join("、")}` });
  }
  if (windCold.some((item) => item.matchedTerms.length === 0)) {
    failures.push({ kind: "acupoint_without_basis", why: "每一穴都必须能说出是本例哪个症把它选进来的" });
  }
  // 主症取不到时不得凭空给穴——通用池是甲方指出的问题本体。
  if (acupoints.selectAcupointsForCaseTerms([], 5).length > 0) {
    failures.push({ kind: "acupoint_without_terms", why: "没有主症时不得选出穴位" });
  }
}

if (failures.length > 0) {
  console.error(JSON.stringify({ failures }, null, 2));
}
assert.equal(
  failures.length, 0,
  `受控数据可达性回归失败 ${failures.length} 项。这一类缺陷的共同特征是「数据在库里、运行时没读」，` +
  `表现各不相同但根因相同，逐个撞是撞不完的。`,
);

console.log(JSON.stringify({
  governedDataFilesChecked: fs.readdirSync("src/data").filter((name) => name.endsWith(".json") && !name.endsWith(".source.json")).length,
  fieldsPinned: FIELD_MUST_BE_QUERIED.length,
  finalizeProjectionsPinned: 4,
  acupointSelectionVerified: true,
  failures: 0,
}));
