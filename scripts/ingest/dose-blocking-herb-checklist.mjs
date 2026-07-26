// 剂量阻断药名候选 → 人工勾选清单（与证型标签清单同构）
//
// 输入 artifacts/dose-blocking-herb-identity-candidates.json（v4-pro 闭集映射的产出），
// 输出一份医生/药师可逐条勾选的 Markdown。
//
// ★ 与证型标签清单的关键区别 ★
// 证型标签判错 → 方剂被错误证型锁定，是**检索层**的错。
// 药味身份判错 → **开出去的是另一味药**，是替换语义。所以这份清单的默认答案是「不采纳」，
// 且毒性药一律不列入可勾选区，只作事实陈列。
//
// ★ 毒性筛查从 KB 事实推导，不用手写名单 ★
// 映射脚本里那份 TOXIC 正则是手写的，实测漏了天南星（toxicity=有毒、pregnancy_forbidden、
// 列入高风险监管目录）。手写名单必然漏，这里改为读 KB 的 herbRisk.toxicity 与
// commonHerbs.riskTags，凡事实上标毒的一律隔离。
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const readJson = (path) => JSON.parse(readFileSync(resolve(ROOT, path), "utf8"));

const candidates = readJson("artifacts/dose-blocking-herb-identity-candidates.json");
const knowledge = readJson("src/data/tcm-knowledge.json");
const catalog = readJson("src/data/tcm-formula-governed-catalog.json");

/** KB 事实：哪些药名标了毒。取 herbRisk.toxicity 与 commonHerbs.riskTags 的并集。 */
const toxicNames = new Map();
for (const herb of knowledge.herbs || []) {
  for (const entry of herb.entries || []) {
    const toxicity = String(entry.toxicity || "").trim();
    if (entry.type === "herbRisk" && toxicity && toxicity !== "无毒") {
      const pregnancy = String(entry.pregnancyRule || "");
      toxicNames.set(herb.name, `${toxicity}${pregnancy.includes("禁用") ? "・孕妇禁用" : ""}`);
    }
  }
}
for (const herb of knowledge.commonHerbs || []) {
  const tags = herb.riskTags || [];
  if (tags.includes("toxic")) {
    toxicNames.set(herb.name, toxicNames.get(herb.name) || (tags.includes("pregnancy_forbidden") ? "有毒・孕妇禁用" : "有毒"));
  }
}

/** 药典背书判定，口径与构建器 PHARMACOPOEIA_DOSE_BASIS 一致。 */
const PHARMACOPOEIA = /中华人民共和国药典|中国药典2020一部/;
const pharmacopoeiaBacked = new Set();
for (const herb of knowledge.herbs || []) {
  for (const entry of herb.entries || []) {
    if (entry.minG == null && entry.maxG == null) continue;
    if (PHARMACOPOEIA.test(String(entry.basis || ""))) pharmacopoeiaBacked.add(herb.name);
  }
}

/**
 * 每个药名所阻断的方剂的剂型分布。
 *
 * 这条信号是从样本里看出来的：白蜜→蜂蜜（15-30g，药典背书）看着完全合理，但它阻断的
 * 大陷胸**丸**、扶桑**丸**里，白蜜是「炼蜜为丸」的赋形剂，不是按 15-30g 煎服的药味。
 * 按饮片剂量给它配 15-30g，方向就错了。剂型分布能让裁定人一眼看出这个语境。
 */
// 目录里只有 197/1458 首标了 dosageForm，但方名后缀能判出 1,110 首——中药方名本来就编码剂型。
// 两者合用，判不出的记为「未知」而**不算作非汤剂**：缺数据不等于证据，让警告只在真有证据时响。
const DECOCTION_NAME = /[汤饮煎][）)]?$/;
const NON_DECOCTION_NAME = /[丸散膏丹锭酒露霜栓][）)]?$/;
const dosageFormOf = (entry) => {
  const declared = String(entry.dosageForm || "").trim();
  if (declared) return declared;
  if (DECOCTION_NAME.test(entry.name)) return "汤剂(据方名)";
  if (NON_DECOCTION_NAME.test(entry.name)) return `${entry.name.slice(-1)}剂(据方名)`;
  return "未知";
};

const decoctionShareByHerb = new Map();
for (const entry of catalog.entries) {
  if (entry.doseCompilationEligible || !entry.retrievalEligible) continue;
  const blockers = [...new Set([
    ...(entry.unresolvedDoseIngredientNames || []),
    ...(entry.missingDoseBoundaryIngredientNames || []),
  ])];
  const form = dosageFormOf(entry);
  const kind = form === "未知" ? "unknown" : (/汤|饮|煎/.test(form) ? "decoction" : "other");
  for (const herb of blockers) {
    const bucket = decoctionShareByHerb.get(herb) || { decoction: 0, other: 0, unknown: 0, forms: new Map() };
    bucket[kind] += 1;
    bucket.forms.set(form, (bucket.forms.get(form) || 0) + 1);
    decoctionShareByHerb.set(herb, bucket);
  }
}

// 映射跑了一个多小时，期间目录变了两次（剂量依据门禁 -13、品种裁定 +55），
// 所以候选文件里的 blockedFormulaCount 是**跑那一刻**的快照。这里按当前目录重算，
// 并丢弃已经不再是阻断项的药名——否则清单会报出一个已经不成立的解锁收益。
const liveBlockCount = new Map();
for (const entry of catalog.entries) {
  if (entry.doseCompilationEligible || !entry.retrievalEligible) continue;
  for (const herb of new Set([
    ...(entry.unresolvedDoseIngredientNames || []),
    ...(entry.missingDoseBoundaryIngredientNames || []),
  ])) {
    liveBlockCount.set(herb, (liveBlockCount.get(herb) || 0) + 1);
  }
}

const staleEntries = candidates.entries || [];
const entries = staleEntries
  .filter((item) => liveBlockCount.has(item.herb))
  .map((item) => ({ ...item, staleBlockedFormulaCount: item.blockedFormulaCount, blockedFormulaCount: liveBlockCount.get(item.herb) }));
const noLongerBlocking = staleEntries.length - entries.length;
const withProposal = entries.filter((item) => item.standardName);
const blank = entries.filter((item) => !item.standardName);

// 提案落在毒性药上 = 事实陈列，不进可勾选区。
const toxicProposal = withProposal.filter((item) => toxicNames.has(item.standardName) || toxicNames.has(item.herb));
const actionable = withProposal.filter((item) => !toxicNames.has(item.standardName) && !toxicNames.has(item.herb));
// 药典未背书的提案同样不可勾——勾了也解不开阻断，而且会误导。
const unbacked = actionable.filter((item) => !pharmacopoeiaBacked.has(item.standardName));
const selectable = actionable.filter((item) => pharmacopoeiaBacked.has(item.standardName));

// 「可解锁方次」是各药名阻断数之和，会**严重高估**：一首方被 5 味药同时阻断时，
// 只解开其中 1 味它照样锁着。实测 567 方次实际只对应 223 首真解锁。
// 报方次是在给自己贴金，这里按「该方全部阻断项都可裁定」算真实解锁数。
const selectableHerbs = new Set(selectable.map((item) => item.herb));
const blockedFormulas = catalog.entries.filter((item) => item.retrievalEligible && !item.doseCompilationEligible);
let fullyUnlockable = 0;
let partiallyUnlockable = 0;
for (const entry of blockedFormulas) {
  const blockers = [...new Set([
    ...(entry.unresolvedDoseIngredientNames || []),
    ...(entry.missingDoseBoundaryIngredientNames || []),
  ])];
  if (!blockers.some((name) => selectableHerbs.has(name))) continue;
  if (blockers.every((name) => selectableHerbs.has(name))) fullyUnlockable += 1;
  else partiallyUnlockable += 1;
}
const unlockableInstances = selectable.reduce((sum, item) => sum + (item.blockedFormulaCount || 0), 0);
const blockedTotal = blockedFormulas.length;

const lines = [];
lines.push("# 剂量阻断药名待裁定清单（B 类 · 药味身份）", "");
lines.push(`共 ${entries.length} 个药名；模型给出提案 ${withProposal.length} 个，留空 ${blank.length} 个。`);
if (noLongerBlocking > 0) {
  lines.push(`（映射产出 ${staleEntries.length} 个，其中 ${noLongerBlocking} 个已不再是阻断项——` +
    "跑映射期间品种裁定入库解掉了一批，阻断方数已按当前目录重算。）");
}
lines.push(`**其中真正需要你裁定的是 ${selectable.length} 个。**`, "");
lines.push(`全部采纳的话，**真正解锁 ${fullyUnlockable} 首**方（另有 ${partiallyUnlockable} 首只解开一部分阻断项，仍锁着）。`);
lines.push(`注意别看「${unlockableInstances} 方次」那个数——它是各药名阻断数之和，同一首方被多味药阻断就被重复计入。` +
  `实际阻断方 ${blockedTotal} 首里，${partiallyUnlockable} 首还卡在别的药名上。`, "");

lines.push("## 先说结论：这批大部分不该解锁", "");
lines.push(`目录里可检索但不可编译剂量的方共 ${blockedTotal} 首。逐个药名查下来，阻断原因分三类：`, "");
lines.push("| 类别 | 数量 | 该怎么办 |");
lines.push("|---|---|---|");
lines.push(`| 两边受控表都查不到（黄蜡、猪膏、百草霜、人中白、硼砂…） | ${blank.length} | **无解，也不该解**。它们不是现代内服饮片——黄蜡是赋形剂、猪膏是猪油、百草霜是锅底灰、水粉是铅粉。药典没有它们的内服饮片剂量，是因为它们本就不按饮片开 |`);
lines.push(`| 提案落在毒性药上 | ${toxicProposal.length} | **保持阻断**。给毒性药自动配剂量是这套系统最不该做的事 |`);
lines.push(`| 提案的标准名没有药典剂量背书 | ${unbacked.length} | 勾了也解不开阻断，且会误导。需先补药典依据 |`);
lines.push(`| **可裁定** | **${selectable.length}** | 见下方勾选区 |`);
lines.push("");

lines.push("## 怎么用", "");
lines.push("- **默认答案是不勾。** 药味身份是替换语义：证型判错只是检索层选错方，药味判错是**开出去的是另一味药**。");
lines.push("- 模型只能从「已有药典数值剂量的标准名」这个闭集里选，选不出就留空——留空不是保守，是闭集里真没有。");
lines.push("- 勾选后仍需走既有治理通道（T9 身份表）入库，本文件**不进入运行时**。");
lines.push("- **同名异物必须留空。** 例：白附子有禹白附（天南星科）与关白附（毛茛科），毒性不同，合并即事故。");
lines.push("");
lines.push("---", "");

const formatOne = (item, index) => {
  const out = [];
  out.push(`### ${index}. ${item.herb}`);
  out.push(`*阻断 ${item.blockedFormulaCount} 首方的剂量编制*`);
  for (const formula of item.exampleFormulas || []) out.push(`> 《${formula.source}》${formula.name}`);
  const bound = item.doseBound ? `${item.doseBound.min}-${item.doseBound.max}g` : "无数值边界";
  out.push(`- [ ] 判定为 **${item.standardName}**　\`${bound}\`　(模型置信 ${item.confidence})`);
  if (item.basis) out.push(`  <sub>模型依据：${item.basis}</sub>`);
  if (item.caution) out.push(`  <sub>⚠ ${item.caution}</sub>`);
  if (item.doseBound?.basis) out.push(`  <sub>剂量依据：${item.doseBound.basis}</sub>`);
  const share = decoctionShareByHerb.get(item.herb);
  if (share) {
    const forms = [...share.forms.entries()].sort((left, right) => right[1] - left[1])
      .slice(0, 4).map(([form, count]) => `${form}×${count}`).join("、");
    out.push(`  <sub>剂型分布：${forms}</sub>`);
    // 阈值取「非汤 ≥ 2×汤」而不是简单多数：良姜 4:3 那种和白蜜 6:3 不是一回事，
    // 阈值太松会让警告变成噪音，读的人就全忽略了，那还不如不报。
    // 措辞也只说「去确认」，不断言它是赋形剂——延胡索做成丸剂仍是药味、仍按药典 3-10g 走，
    // 真正会变性质的是蜜/蜡/油/醋这类载体。剂型只是线索，判断权在裁定人。
    if (share.other >= Math.max(2, share.decoction * 2)) {
      out.push(`  <sub>⚠ **以非汤剂为主**（非汤 ${share.other} : 汤 ${share.decoction}）——请确认它在这些方里是**药味**` +
        "还是**赋形/外用载体**（如炼蜜为丸、油膏调敷）。若是后者，按饮片煎服剂量配它方向就错了。</sub>");
    }
  }
  out.push("");
  return out.join("\n");
};

lines.push(`## 可裁定（${selectable.length} 个）`, "");
if (selectable.length === 0) {
  lines.push("_本轮没有可裁定项——所有提案要么落在毒性药上，要么缺药典剂量背书。_", "");
} else {
  selectable
    .sort((left, right) => right.blockedFormulaCount - left.blockedFormulaCount)
    .forEach((item, index) => lines.push(formatOne(item, index + 1)));
}

if (toxicProposal.length > 0) {
  lines.push("---", "", `## 毒性药：保持阻断，不提供勾选（${toxicProposal.length} 个）`, "");
  lines.push("列在这里只为让你知道它们被拦下了，以及拦下的依据。**要放开必须单独走毒性药治理流程。**", "");
  lines.push("| 古方药名 | 模型提案 | KB 毒性标注 | 阻断方数 |");
  lines.push("|---|---|---|---|");
  for (const item of toxicProposal.sort((left, right) => right.blockedFormulaCount - left.blockedFormulaCount)) {
    const toxicity = toxicNames.get(item.standardName) || toxicNames.get(item.herb) || "";
    lines.push(`| ${item.herb} | ${item.standardName} | ${toxicity} | ${item.blockedFormulaCount} |`);
  }
  lines.push("");
}

if (unbacked.length > 0) {
  lines.push("---", "", `## 提案标准名缺药典剂量背书（${unbacked.length} 个）`, "");
  lines.push("勾了也解不开阻断：这些标准名在剂量 KB 里只有「待人工复核/校准层」的推定值，没有药典条目。", "");
  lines.push("| 古方药名 | 模型提案 | 阻断方数 |");
  lines.push("|---|---|---|");
  for (const item of unbacked.sort((left, right) => right.blockedFormulaCount - left.blockedFormulaCount)) {
    lines.push(`| ${item.herb} | ${item.standardName} | ${item.blockedFormulaCount} |`);
  }
  lines.push("");
}

lines.push("---", "", `## 模型留空（${blank.length} 个，无需处理）`, "");
lines.push("按阻断方数排序，仅列前 60 个供抽查。留空的方剂保持不可编译剂量——这是安全默认。", "");
lines.push("| 古方药名 | 阻断方数 | 模型说明 |");
lines.push("|---|---|---|");
for (const item of blank.sort((left, right) => right.blockedFormulaCount - left.blockedFormulaCount).slice(0, 60)) {
  const note = item.rejectedProposal ? `提案「${item.rejectedProposal}」不在闭集内，已丢弃` : (item.basis || "");
  lines.push(`| ${item.herb} | ${item.blockedFormulaCount} | ${note} |`);
}
lines.push("");

const out = "artifacts/剂量阻断药名待裁定清单.md";
writeFileSync(resolve(ROOT, out), `${lines.join("\n")}\n`, "utf8");
console.log(JSON.stringify({
  names: entries.length,
  proposals: withProposal.length,
  selectable: selectable.length,
  toxicHeld: toxicProposal.length,
  unbacked: unbacked.length,
  blank: blank.length,
  fullyUnlockableFormulas: fullyUnlockable,
  partiallyUnlockable,
  unlockableFormulaInstances: unlockableInstances,
  out,
}, null, 2));
