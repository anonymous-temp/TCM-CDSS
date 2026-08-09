/**
 * 药味品种歧义层 + 目录条目级校勘通道。
 *
 * 【品种层要解决的问题】甲方 2026-08-09：「后世同名方既有赤芍本也有白芍本，这种情况下还是都算数的」。
 * 犀角地黄汤是标准例——《千金》原文只写「芍药」，《保婴撮要》引济生方作赤芍药，
 * 《成方切用》《医宗金鉴》又作白芍药。为了单一目录值牺牲版本真实性是错的。
 *
 * 但**不能全体放开**，这是本套件最要紧的一半：原书或同方异本明确写出品种的方
 * （止痛当归汤「赤芍药」、龙胆汤「赤芍药」、四物汤「白芍药」、痛泻要方「白芍（炒）」），
 * 品种是确定的，处方写反了是实质差异。静默接受等于帮着把一个真实的处方错误藏起来——
 * 实测 B 表：模型 4 次把四物汤写成赤芍、1 次把痛泻要方写成赤芍，中医师逐条判「模型应判错」。
 * 放行与不放行的分界线由**证据等级**决定，不由药名决定。
 *
 * 【歧义豁免漏洞】豁免表（「药典未收载，由医师确定用量」）是按「哪些药名卡住了方剂」自动汇总的，
 * 歧义属名因此被收成合法豁免成分，反过来放行含歧义味的方——与单字残片那一次是同一个
 * 自我授权闭环。实测 117 处歧义链接混在豁免表里，放行了 93 首方。歧义链接 canonicalName 为空，
 * 十八反十九畏 / 特殊人群 / 管制毒性全按规范名索引，这一味对每一道安全检查都是隐形的。
 *
 * 【校勘通道】章节题被抽取程序压成单方（妊娠随月养胎及服药方 37 味、治痔疮及谷道痒痛方 51 味），
 * 此前没有入口能删掉错条目、也加不了全新条目（芪附汤）。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const jiti = createJiti(import.meta.url, {
  jsx: true, interopDefault: true,
  alias: {
    "@": path.join(repoRoot, "src"),
    "server-only": path.join(repoRoot, "node_modules/next/dist/compiled/server-only/empty.js"),
  },
});
const { verifyFormulaCompilationComponents } = await jiti.import("../src/lib/tcm-formula-provenance.ts");
const { isClinicianDoseHerb } = await jiti.import("../src/lib/tcm-knowledge.ts");

const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(repoRoot, rel), "utf8"));
const catalog = readJson("src/data/tcm-formula-governed-catalog.json");
const collation = readJson("src/data/tcm-formula-catalog-collation.source.json");
const identityAdjudications = readJson("src/data/tcm-formula-ingredient-identity-adjudications.source.json");
const byName = new Map(catalog.entries.map((entry) => [entry.name, entry]));

let checks = 0;
const failures = [];
const ok = (label, condition) => { checks += 1; if (!condition) failures.push(label); };
const herbs = (...names) => names.map((name) => ({ name }));
/**
 * explicitlyModified 必须显式传，不能图省事固定成 true。
 * true = 处方已声明「加减」，此时既有的减味兜底允许差 1 味（≥80% 保留）——大方在这个模式下
 * 品种写反也会过，过的是「龙胆汤加减」不是「龙胆汤」。要检验品种层本身，必须用 false（原方核验）。
 * 实测：龙胆汤(10味)写反品种，strict=false 判否、modified=true 判是；四物汤(4味)两种模式都判否。
 */
const verified = (formula, list, explicitlyModified = false) => {
  const rows = verifyFormulaCompilationComponents([formula], list, false, explicitlyModified);
  return rows.length > 0 && rows.every((row) => row.verified);
};

// ── ① 品种互认：该放行的放行 ────────────────────────────────────────────────
// 犀角地黄汤：目录记白芍，后世赤芍本并存 ⇒ 两个都算数。
ok("犀角地黄汤 目录值仍是白芍（中医师复核结论是「维持原样」，不许改目录）",
  (byName.get("犀角地黄汤")?.ingredients || []).includes("白芍"));
ok("犀角地黄汤 接受白芍本", verified("犀角地黄汤", herbs("白芍", "地黄", "牡丹皮", "水牛角")));
ok("犀角地黄汤 接受赤芍本", verified("犀角地黄汤", herbs("赤芍", "地黄", "牡丹皮", "水牛角")));

// 推断级裁定（方义推断/同书平行方）⇒ 推断猜错不该让医生丢一个方名。
ok("肾热汤（方义推断裁白芍）接受赤芍",
  verified("肾热汤", herbs("磁石", "牡蛎", "白术", "麦冬", "赤芍", "甘草", "生地黄", "大枣")));
ok("肾热汤 也接受目录裁定的白芍",
  verified("肾热汤", herbs("磁石", "牡蛎", "白术", "麦冬", "白芍", "甘草", "生地黄", "大枣")));

// ── ② 品种互认：该拒绝的拒绝（本套件的要害）────────────────────────────────
// 原书/同方异本明确写出品种的，处方写反是实质差异，不得静默接受。
ok("四物汤 不接受赤芍（《仙授理伤续断秘方》明载白芍药；实测模型 4 次写错）",
  !verified("四物汤", herbs("熟地黄", "酒当归", "赤芍", "川芎")));
ok("四物汤 原方仍通过", verified("四物汤", herbs("熟地黄", "酒当归", "白芍", "川芎")));
ok("四物汤 声明加减也不接受赤芍（4 味方差 1 味已跌破保留下限）",
  !verified("四物汤", herbs("熟地黄", "酒当归", "赤芍", "川芎"), true));
ok("痛泻要方 不接受赤芍（《医方集解》明载白芍炒；赤芍无柔肝敛阴之能）",
  !verified("痛泻要方", herbs("麸炒白术", "赤芍", "陈皮", "防风")));
ok("龙胆汤 原方核验不接受白芍（《圣济总录》卷177 同组成明载赤芍药）",
  !verified("龙胆汤", herbs("龙胆", "柴胡", "黄芩", "桔梗", "钩藤", "白芍", "甘草", "茯苓", "蜣螂", "大黄")));
ok("龙胆汤 接受裁定的赤芍",
  verified("龙胆汤", herbs("龙胆", "柴胡", "黄芩", "桔梗", "钩藤", "赤芍", "甘草", "茯苓", "蜣螂", "大黄")));
// 而品种**可互认**的方，写另一个品种在原方核验模式下也必须过——两者的差别正是本层的全部作用。
ok("犀角地黄汤 原方核验就接受赤芍本（不必靠「加减」兜底）",
  verified("犀角地黄汤", herbs("赤芍", "地黄", "牡丹皮", "水牛角")));

// 放行与否由**证据等级**决定，不由药名决定：抽查目录字段是否与这条规则一致。
const INFERRED = new Set(["same_book_parallel", "formula_intent_inference"]);
const tierOf = (entry) => {
  if (entry.evidenceTier) return entry.evidenceTier;
  const evidence = `${entry.evidence || ""}${entry.basis || ""}`;
  return evidence.includes(entry.resolvedIngredient) ? "source_text_explicit" : "formula_intent_inference";
};
for (const entry of identityAdjudications.entries.filter((row) => row.batch === "ADJ-20260809-SHAOYAO-B2")) {
  const row = byName.get(entry.formulaName);
  if (!row) { failures.push(`裁定的方不在目录里: ${entry.formulaName}`); continue; }
  const flexible = (row.varietyFlexibleIngredients || []).some(
    (item) => (item.acceptedNames || []).includes(entry.resolvedIngredient));
  ok(`${entry.formulaName} 品种互认与证据等级一致（${tierOf(entry)}）`,
    flexible === INFERRED.has(tierOf(entry)));
  const link = (row.ingredientLinks || []).find((item) => item.rawName === "芍药");
  ok(`${entry.formulaName} 裁定已生效为 ${entry.resolvedIngredient}`,
    link?.adjudicatedIngredient === entry.resolvedIngredient && link?.autoResolvable === true);
}

// ── ③ 品种互认只作用于身份核验，不得渗进剂量/安全 ──────────────────────────
// 目录值不因互认而改变——互认是核验时的等价，不是把两味药合并成一味。
for (const entry of catalog.entries.filter((row) => row.varietyFlexibleIngredients?.length)) {
  for (const flexible of entry.varietyFlexibleIngredients) {
    const recorded = flexible.recordedName;
    const inCatalog = (entry.ingredients || []).includes(recorded)
      || (entry.ingredientLinks || []).some(
        (link) => link.canonicalName === recorded || link.adjudicatedIngredient === recorded || link.rawName === recorded);
    if (!inCatalog) failures.push(`品种互认指向目录里不存在的味: ${entry.name}->${recorded}`);
    if (!(flexible.acceptedNames || []).includes(recorded)) {
      failures.push(`品种互认未包含目录值自身: ${entry.name}->${recorded}`);
    }
  }
}
checks += 2;

// ── ④ 歧义豁免漏洞：构建期与运行时必须同判 ──────────────────────────────────
// 「知道是哪味药、只是没有法定数值边界」才配拿豁免。歧义属名不满足这个前提。
for (const name of ["芍药", "贝母", "皂角", "皂荚", "贯众", "青木香", "萆薢", "菖蒲", "红豆", "草决明"]) {
  ok(`歧义属名不得拿到「医师定量」豁免: ${name}`, !isClinicianDoseHerb(name));
}
ok("非歧义的无边界成分仍保留豁免（不是把豁免整体关掉）", isClinicianDoseHerb("龙骨"));
// 判据是「身份分叉」不是「status=ambiguous」，这条边界必须钉住，否则下次有人会顺手放宽成
// 「所有 ambiguous 都拦」：白蜜/沙蜜 status 也是 ambiguous，但已解析到蜂蜜，规范名在、
// 十八反与毒性检查看得见，拦它只会白挡掉大陷胸丸、猪肤汤，换不来任何安全收益。
ok("已解析到规范名的 ambiguous 仍保留豁免（白蜜→蜂蜜）", isClinicianDoseHerb("白蜜"));
// 目录侧同判：身份分叉的链接（歧义且无规范名）一条都不许出现在 clinicianDoseIngredientNames 里。
const leaked = catalog.entries.flatMap((entry) => {
  const forked = new Set((entry.ingredientLinks || [])
    .filter((link) => link.linkageStatus === "ambiguous" && !link.canonicalName)
    .map((link) => link.rawName));
  return (entry.clinicianDoseIngredientNames || [])
    .filter((name) => forked.has(name)).map((name) => `${entry.name}->${name}`);
});
ok(`目录侧无身份分叉味混入豁免（实测修复前 117 处，现 ${leaked.length} 处）`, leaked.length === 0);
// 歧义味必须以「品种待指定」而不是「用量由医师确定」的身份可见。
const undetermined = catalog.entries.filter((entry) => entry.varietyUndeterminedIngredients?.length);
ok(`品种待指定的方可见（${undetermined.length} 首）`, undetermined.length > 0);
for (const entry of undetermined.slice(0, 40)) {
  for (const row of entry.varietyUndeterminedIngredients) {
    if (!(row.candidates || []).length) failures.push(`品种待指定却没给候选品种: ${entry.name}->${row.name}`);
  }
}
checks += 1;
// 方义就落在歧义味上的小方，扣完不成方，必须继续整方阻断。
for (const name of ["二母散", "当归贝母苦参丸", "千缗汤"]) {
  const row = byName.get(name);
  if (!row) continue;
  ok(`${name} 歧义味占比过高，仍整方阻断剂量`, row.doseCompilationEligible === false);
}

// ── ④' 病种概念的前缀碰撞：中风 ≠ 中(zhòng)风寒 ────────────────────────────
// 「中风」后接 寒/湿/水/冷 是感受六淫（中风寒 = 中·风寒），不是脑卒中。
// 本次拆分入库的妊娠二月艾汤、妊娠八月芍药汤原文写「妊娠X月中风寒」，被机器派生打上
// disease_stroke——后果是中风病例可能召回妊娠方。连带查出两条既有误标（治诸疮中风寒水露方、
// 生附白术汤「治中风湿」）。
// 反向同样要钉住：通关散「治卒中风邪，不省人事，牙关紧闭」是中风闭证，排掉它才是错的。
{
  const strokeTagged = new Set(catalog.entries
    .filter((entry) => (entry.diseaseTags || []).includes("disease_stroke")).map((entry) => entry.name));
  for (const name of ["艾汤〔《外台秘要》卷三十三·妊娠二月〕", "芍药汤〔《外台秘要》卷三十三·妊娠八月〕",
    "治诸疮中风寒水露方", "生附白术汤"]) {
    ok(`${name} 不得因「中风寒/中风湿」被判为脑卒中`, !strokeTagged.has(name));
  }
  ok("通关散（卒中风邪·中风闭证）仍judged为脑卒中", strokeTagged.has("通关散"));
  // 兜底：任何「中风」只以 中风寒/湿/水/冷 形式出现的条目都不得带 disease_stroke。
  const leakedStroke = catalog.entries.filter((entry) => (entry.diseaseTags || []).includes("disease_stroke"))
    .filter((entry) => {
      const text = [entry.name, ...(entry.aliases || []), ...(entry.indications || [])].join("；");
      const hits = text.match(/中风[寒湿水冷]?/g) || [];
      return hits.length > 0 && hits.every((hit) => hit.length > 2);
    }).map((entry) => entry.name);
  ok(`无「只写中风寒/湿/水/冷」却判脑卒中的条目（现 ${leakedStroke.length} 条）`, leakedStroke.length === 0);
}

// ── ⑤ 目录校勘通道 ──────────────────────────────────────────────────────────
ok("校勘源表有 adjudicationRef", typeof collation.adjudicationRef === "string" && collation.adjudicationRef.length > 0);
ok("校勘源表有 sourceRefs", Array.isArray(collation.sourceRefs) && collation.sourceRefs.length > 0);

// 章节伪方必须真的删掉——它们的「组成」是抽取程序拼出来的，不是任何一张真方。
for (const removal of collation.removals) {
  ok(`章节伪方已删除: ${removal.name}`, !byName.has(removal.name));
  ok(`章节伪方删除带理由: ${removal.name}`, String(removal.reason || "").length > 20);
}
// 复合合称条目继续保持删除状态（甲方明确要求）。
ok("《三因》附、术附、参附三汤 复合条目保持删除", !byName.has("《三因》附、术附、参附三汤"));

// 新增条目必须逐条落地，且资格闸按「专名 + 内服」执行。
for (const entry of collation.entries.filter((row) => row.action === "add")) {
  const row = byName.get(entry.name);
  ok(`校勘新增已入库: ${entry.name}`, Boolean(row));
  if (!row) continue;
  ok(`${entry.name} 组成按校勘落地`, (row.ingredients || []).join("、") === entry.ingredients.join("、"));
  ok(`${entry.name} 保留古方原量供回源（但不进剂量编译）`,
    typeof row.prescriptionOriginal === "string" && row.prescriptionOriginal.length > 0);
  // 拟名不得冒充古方专名去命名医生的处方；外治法不应命名内服处方。
  const shouldLock = entry.properNameInSource === true && entry.administration === "internal";
  ok(`${entry.name} 方名锁定资格 = 专名且内服（${shouldLock}）`, row.identityLockEligible === shouldLock);
  // historical_only（钩吻/铅/砷、药材不可辨识）连检索一并取消，不进任何候选池。
  ok(`${entry.name} 检索资格与给药途径一致`,
    row.retrievalEligible === (entry.administration !== "historical_only"));
}
// 组成重录：出处与组成都要按校勘落地，且不得留下非药名残片。
for (const entry of collation.entries.filter((row) => row.action === "rewrite")) {
  const row = byName.get(entry.name);
  ok(`校勘重录条目仍在目录: ${entry.name}`, Boolean(row));
  if (!row) continue;
  ok(`${entry.name} 组成已重录`, (row.ingredients || []).join("、") === entry.ingredients.join("、"));
  ok(`${entry.name} 出处已回归`, row.source === entry.source);
  ok(`${entry.name} 非药名残片已清除`, !(row.ingredients || []).includes("炒白芍菜"));
}

// 芪附汤：目录原本缺失，甲方核定新增。附子不得被擅自补成炮附子。
const qifu = byName.get("芪附汤〔《古今名医方论》引《三因》·自汗方〕");
ok("芪附汤已新增", Boolean(qifu));
ok("芪附汤组成为黄芪、附子二味", (qifu?.ingredients || []).join("、") === "黄芪、附子");
ok("芪附汤未擅补炮制", !(qifu?.ingredients || []).some((name) => name.startsWith("炮")));

// 术附汤 / 参附汤：自汗方版本与库中同名方并存，两版都在、组成不同、互不覆盖。
const pairs = [
  ["术附汤", "术附汤（《古今名医方论》引《三因》·自汗方）", "白术、附子"],
  ["参附汤", "参附汤（《古今名医方论》引《三因》·自汗方）", "人参、附子"],
];
for (const [baseline, variant, composition] of pairs) {
  const base = byName.get(baseline);
  const row = byName.get(variant);
  ok(`${baseline} 基线仍在且未被覆盖`, Boolean(base));
  ok(`${variant} 已入库`, Boolean(row));
  ok(`${variant} 组成为自汗方二味`, (row?.ingredients || []).join("、") === composition);
  ok(`${baseline} 与自汗方版本组成不同`,
    (base?.ingredients || []).join("、") !== (row?.ingredients || []).join("、"));
}

// ── ⑥ 章节伪方同类隔离：只取消资格、不删除 ──────────────────────────────────
// 中医师逐条核过的 4 条全部命中同一条结构判据（方名带枚举标记的「…方」且组成≥8味）。
// 其余同构条目没有逐条回源核过，所以不删；但一个 32 味的合抄组成绝不能命名或编译剂量。
const quarantined = catalog.summary.collatedChapterQuarantined || [];
ok(`章节伪方同类已隔离（${quarantined.length} 条）`, quarantined.length > 0);
for (const key of quarantined) {
  const row = byName.get(key.split("@")[0]);
  if (!row) { failures.push(`隔离项不在目录里: ${key}`); continue; }
  ok(`${row.name} 不得命名处方`, row.identityLockEligible === false);
  ok(`${row.name} 不得编译剂量`, row.doseCompilationEligible === false);
  ok(`${row.name} 不作为证据进入检索`, row.retrievalEligible === false);
}
// 中医师核过的两条 A17/A18 必须在隔离集合里——它们是这条判据的真值锚点。
for (const name of ["治伤寒胸闷、腹满方", "治天行诸病方"]) {
  ok(`中医师核定为合抄的条目已隔离: ${name}`,
    quarantined.some((key) => key.startsWith(`${name}@`)));
}
// 反向护栏：正当小方不得被这条判据误伤。
for (const name of ["四君子汤", "四物汤", "犀角地黄汤", "痛泻要方"]) {
  const row = byName.get(name);
  ok(`${name} 未被章节判据误伤`, row?.identityLockEligible === true);
}

if (failures.length > 0) {
  console.error("[test:formula-variety-and-collation] 失败项：");
  for (const item of failures) console.error("  - " + item);
}
assert.equal(failures.length, 0, `${failures.length}/${checks} 项失败`);
console.log(
  `[test:formula-variety-and-collation] OK — ${checks} 项断言全过；` +
  `品种互认 ${catalog.summary.varietyFlexibleFormulaCount} 首 / 品种待指定 ${catalog.summary.varietyUndeterminedFormulaCount} 首；` +
  `校勘新增 ${(catalog.summary.collationAdded || []).length} 条、删除 ${(catalog.summary.collatedChapterDropped || []).length} 条、` +
  `隔离 ${quarantined.length} 条`,
);
