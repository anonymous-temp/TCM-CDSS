// 第五十七轮（2026-11-23）：教材节名里的西医病名不得原样交付成中医病名（f35：2 年骨质疏松性腰背痛，中医病名栏交付「骨质疏松症」）。
// 候选病名来自教材节名（src/data/tcm-textbook-disease-names.json 的 names），骨伤、妇科、外科、儿科、眼科教材有的节以西医病名立题，
// 节名原样交付。按类收口：
//   1 病名清单每一项要么是国标 GB/T 15657 词条、要么已映射成中医病名（tcmNameBySectionName）、要么在保留表里写明为什么不映射
//     （tcm-textbook-section-names.source.json sectionNamesKeptVerbatim）；字形像西医病名的节名（含国标正名，如骨质疏松症）一律要映射或进保留表。
//   2 映射目标是受治理的中医病名或教材病名；每条映射与保留的原句逐字在本地教材合集所注行号附近（合集不在本机时跳过这一项）。
//   3 运行时：骨质疏松症等交付中医病名；按西医节名或中医病名都查得到该节的教材证型（含中医病名另有一节时的回查）；
//     选病给节名、辨证半交付中医病名时不当成「没用选病第一个」。
import assert from "node:assert/strict";
import fs from "node:fs";
import { createJiti } from "jiti";

const root = process.cwd();
const jiti = createJiti(import.meta.url, { alias: { "@": `${root}/src`, "server-only": `${root}/node_modules/next/dist/compiled/server-only/empty.js` } });
const terminology = await jiti.import("../src/lib/clinical-terminology.ts");
const textbook = await jiti.import("../src/lib/tcm-textbook-syndromes.ts");
const differentials = await jiti.import("../src/lib/tcm-disease-differential-normalization.ts");
const visitReason = await jiti.import("../src/lib/m03-visit-reason-check.server.ts");

const check = async (id, title, run) => {
  if (process.env.R1075_CHECK && process.env.R1075_CHECK !== id) return;
  try { await run(); console.log(`✓ ${id} ${title}`); } catch (error) { process.exitCode = 1; console.error(`✗ ${id} ${title}\n${error.stack}`); }
};
const json = (path) => JSON.parse(fs.readFileSync(path, "utf8"));
const generated = json("src/data/tcm-textbook-disease-names.json");
const source = json("src/data/tcm-textbook-section-names.source.json");
const kept = source.sectionNamesKeptVerbatim || [];
const keptBySection = new Map(kept.map((item) => [item.section, item]));
const mapped = generated.tcmNameBySectionName;
const names = new Set(generated.names);

// 与生成器 scripts/build-tcm-textbook-disease-names.mjs 同一个 governed()：国标正名、别名，含「病」尾的写法。
const lexicon = json("src/data/tcm-disease-lexicon.json").entries.filter((entry) => entry.temporary !== true);
const canonicalOf = new Map();
for (const entry of lexicon) {
  canonicalOf.set(entry.canonical, entry.canonical);
  for (const alias of entry.aliases || []) if (!canonicalOf.has(alias)) canonicalOf.set(alias, entry.canonical);
}
const governed = (name) => canonicalOf.get(name) || canonicalOf.get(`${name}病`) || canonicalOf.get(name.replace(/病$/u, ""));

const CORPUS = "中医补充数据/灵丹GitHub/TCM Educational Materials.txt";
const corpus = fs.existsSync(CORPUS) ? fs.readFileSync(CORPUS, "utf8").split("\n") : undefined;
if (!corpus) console.log(`- 本机没有 ${CORPUS}（gitignore 的教材合集），跳过原句逐字核对`);
const assertQuote = (where, { file, line, quote }) => {
  assert.equal(file, CORPUS, `${where}: 原句只认本地教材合集`);
  assert.ok(Number.isInteger(line) && line > 0 && typeof quote === "string" && quote.trim().length >= 2, `${where}: 行号与原句`);
  if (!corpus) return;
  // 扫描件按版面断行：原句可以带换行照录，也可以去掉换行接起来录（旧有几条是后者）。
  const window = corpus.slice(Math.max(0, line - 4), line + 3 + quote.split("\n").length);
  assert.ok(window.join("\n").includes(quote) || window.join("").includes(quote.replace(/\n/gu, "")), `${where}: 第 ${line} 行附近没有原句「${quote.slice(0, 30)}」`);
};

await check("1.1", "病名清单每一项：国标词条、已映射成中医病名、或在保留表里写明为什么不映射（不得有未经核对的节名）", () => {
  const unreviewed = generated.names.filter((name) => !governed(name) && !mapped[name] && !keptBySection.has(name));
  assert.deepEqual(unreviewed, []);
});

await check("1.2", "字形像西医病名的节名（含国标正名：骨质疏松症是 GB/T 15657 A03.06.04.07）一律要映射或进保留表", () => {
  const western = generated.names.filter((name) => differentials.WESTERN_DISEASE_FORM.test(name));
  assert.ok(western.includes("骨质疏松症") && western.length >= 20, `判据要能看到这一类：${western.length}`);
  assert.deepEqual(western.filter((name) => !mapped[name] && !keptBySection.has(name)), []);
});

await check("1.3", "保留表：节名在病名清单里、不同时已映射、不重复；分类与理由成立（国标类真是受治理词条，其余两类不是）", () => {
  const kinds = new Set(["tcm_textbook_name", "governed_tcm_name", "no_single_tcm_name"]);
  assert.equal(keptBySection.size, kept.length, "保留表有重复节名");
  for (const item of kept) {
    assert.ok(names.has(item.section), `${item.section} 不在病名清单（过时条目）`);
    assert.equal(mapped[item.section], undefined, `${item.section} 已映射却又在保留表`);
    assert.ok(kinds.has(item.kind), `${item.section} kind=${item.kind}`);
    assert.ok(typeof item.reason === "string" && item.reason.length >= 10, `${item.section} 缺理由`);
    assertQuote(`保留 ${item.section}`, item.evidence);
    if (item.kind === "governed_tcm_name") {
      assert.ok(governed(item.section), `${item.section} 标为国标词条却不受治理`);
      assert.equal(item.evidence.lexicon?.canonical, governed(item.section), `${item.section} 证据里的国标正名`);
    } else {
      assert.ok(!governed(item.section), `${item.section} 是国标词条，不该标 ${item.kind}`);
    }
  }
});

const ROUND75 = {
  骨质疏松症: "骨痿", 急性阑尾炎: "肠痈", 糖尿病: "消渴", 休克: "虚脱", 维生素D缺乏性佝偻病: "佝偻病",
  尖锐湿疣: "臊疣", 寻常疣: "疣目", 扁平疣: "扁瘊", 幼儿急疹: "奶麻", 慢性腰肌劳损: "腰痛",
};
// 目标不是国标词条、也不是教材节名的，只认教材原句里逐字写着的那个中医病名（虫咬皮炎「相当于中医学的恶虫叮咬」、挤压综合征「中医学称之为“压迮伤”」）。
const attributedTargets = new Map([
  ...source.sectionTcmNames.map((row) => [row.section, row.quote]),
  ...(source.deliveryAliases || []).map((row) => [row.fromName, row.sourceRef?.quote || ""]),
  ...Object.entries(generated.tcmNameBasis).map(([section, basis]) => [section, basis?.quote || ""]),
]);
await check("2.1", "映射表：每条映射目标是受治理的中医病名、教材病名，或在该节教材原句里逐字写明（含旧有 25 条与 deliveryAliases）", () => {
  const bad = Object.entries(mapped).filter(([section, target]) => !governed(target) && !names.has(target) &&
    !String(attributedTargets.get(section) || "").replace(/\n/gu, "").includes(target));
  assert.deepEqual(bad, []);
  // 本轮新加的映射更严：目标必须是国标词条或教材病名
  for (const [section, target] of Object.entries(ROUND75)) assert.ok(governed(target) || names.has(target), `${section} → ${target}`);
});

await check("2.2", "sectionTcmNames：节名在清单里的都生效（生成表里的中医病名等于该行，除非该节定义首句已给了引号名）；原句逐字在所注行号附近", () => {
  for (const row of source.sectionTcmNames) {
    assertQuote(`映射 ${row.section}`, row);
    for (const [index, support] of (row.supportingQuotes || []).entries()) assertQuote(`映射 ${row.section} 旁证${index + 1}`, support);
    assert.ok(governed(row.tcmName) || names.has(row.tcmName) || row.quote.replace(/\n/gu, "").includes(row.tcmName), `${row.section} → ${row.tcmName} 不是受治理或教材病名，原句里也没写`);
    if (!names.has(row.section)) continue;
    const fromDefinition = Boolean(generated.tcmNameBasis[row.section]?.book);
    assert.ok(mapped[row.section] === row.tcmName || fromDefinition, `${row.section}: 生成表 ${mapped[row.section]} ≠ ${row.tcmName}（重跑 build-tcm-textbook-disease-names）`);
  }
});

await check("2.3", "本轮十条进了生成表（含只经急危重对照行进清单、书不在候选书目里的休克、急性阑尾炎）", () => {
  for (const [section, tcmName] of Object.entries(ROUND75)) assert.equal(mapped[section], tcmName, section);
});

const context = { overview: { primarySyndrome: "" } };
await check("3.1", "运行时交付中医病名：骨质疏松症 → 骨痿（f35），其余九条同；先归到国标正名的写法（原发性骨质疏松症）也走同一张表；中医病名再归一不变（幂等）", () => {
  assert.equal(terminology.canonicalTcmDiseaseName("骨质疏松症", context), "骨痿");
  assert.equal(terminology.canonicalTcmDiseaseName("原发性骨质疏松症", context), "骨痿");
  assert.equal(terminology.canonicalTcmDiseaseName("颈椎病", context), "颈椎病", "国标正名、不是教材映射过的节名的不动");
  for (const [section, tcmName] of Object.entries(ROUND75)) {
    assert.equal(terminology.canonicalTcmDiseaseName(section, context), tcmName, section);
    assert.equal(terminology.canonicalTcmDiseaseName(tcmName, context), tcmName, `${tcmName} 再归一`);
  }
  const reasoning = terminology.withCanonicalClinicalTerminology({
    overview: { tcmDiseaseName: "骨质疏松症", primarySyndrome: "肾虚精亏证" },
    westernDiagnosis: { primary: { name: "骨质疏松症" } },
  });
  assert.equal(reasoning.overview.tcmDiseaseName, "骨痿");
  assert.equal(reasoning.westernDiagnosis.primary.name, "骨质疏松症", "西医病名栏不动");
  // 保留表里的节名照旧交付（不擅自映射）
  assert.equal(terminology.canonicalTcmDiseaseName("多囊卵巢综合征", context), "多囊卵巢综合征");
});

await check("3.2", "按西医节名或中医病名都查得到该节的证型（中医病名不另立节时登记为别名；另有一节时按交付名回查）", () => {
  const adult = { ageYears: 40, sex: "女" };
  const child = { ageYears: 3, sex: "男" };
  for (const [section, tcmName] of Object.entries(ROUND75)) {
    const rows = textbook.textbookFormulaRowsForDisease(section).filter((row) => row.disease === section);
    assert.ok(rows.length > 0, `${section} 没有教材行`);
    for (const row of rows) {
      const input = /^erke\|/u.test(row.id) ? child : adult;
      const bySection = textbook.textbookRowForSyndrome(section, row.syndromeName, input);
      const byTcm = textbook.textbookRowForSyndrome(tcmName, row.syndromeName, input);
      assert.ok(bySection, `${section}·${row.syndromeName}`);
      assert.ok(byTcm && byTcm.syndromeName === row.syndromeName, `${tcmName}·${row.syndromeName} 查不到（${byTcm?.id}）`);
    }
  }
  // 骨痿不另立节：登记为骨质疏松症一节的别名，病名身份回到该节
  assert.equal(textbook.textbookDiseaseIdentity("骨痿"), "骨质疏松症");
  assert.equal(textbook.textbookRowForSyndrome("骨痿", "肾虚精亏证")?.id, "gushang|骨质疏松症|肾虚精亏");
  // 消渴、虚脱另有一节：那一节没有的证名到交付成它的西医节里找（糖尿病、休克的急危重行）
  assert.equal(textbook.textbookRowForSyndrome("消渴", "阴竭阳亡证", adult)?.id, "supplement|糖尿病|阴竭阳亡");
  assert.equal(textbook.textbookRowForSyndrome("虚脱", "热伤气阴证", adult)?.id, "zxy_waike|休克|热伤气阴证");
  // 中医病名自己那一节有的证名仍取那一节
  assert.equal(textbook.textbookRowForSyndrome("消渴", "肺热津伤证", adult)?.disease, "消渴");
  assert.equal(textbook.textbookRowForSyndrome("虚脱", "亡阳证", adult)?.disease, "虚脱");
});

await check("3.3", "按交付名回查不越过科别与性别：儿科节只给未满 14 岁，女性癥瘕不落到前列腺癌一节，男性不落到妇科节", () => {
  assert.equal(textbook.textbookRowForSyndrome("心悸", "湿热侵心证", { ageYears: 40, sex: "男" }), undefined);
  assert.equal(textbook.textbookRowForSyndrome("心悸", "湿热侵心证", { ageYears: 6, sex: "男" })?.disease, "病毒性心肌炎");
  assert.equal(textbook.textbookRowForSyndrome("癥瘕", "湿热蕴结证", { ageYears: 50, sex: "女" }), undefined);
  assert.equal(textbook.textbookRowForSyndrome("癥瘕", "湿热蕴结证", { ageYears: 70, sex: "男" })?.disease, "前列腺癌");
  // 不跨到交付名以外的病：交付名没有对上任何节时照旧查不到
  assert.equal(textbook.textbookRowForSyndrome("骨痿", "热伤气阴证", { ageYears: 40, sex: "女" }), undefined);
});

await check("3.4", "选病给教材节名、辨证半已交付中医病名时是同一个病：不发病名与就诊原因核对；真换了病照旧核", () => {
  assert.equal(visitReason.visitReasonCheckApplies({ chiefComplaint: "腰背疼痛2年，加重1月", disease: "骨痿", picks: ["骨质疏松症"] }), false);
  assert.equal(visitReason.visitReasonCheckApplies({ chiefComplaint: "高热3天，神志淡漠半天", disease: "虚脱", picks: ["休克"] }), false);
  assert.equal(visitReason.visitReasonCheckApplies({ chiefComplaint: "腰背疼痛2年，加重1月", disease: "痹证", picks: ["骨质疏松症"] }), true);
  // 核对器把节名当「更合适的病」报回来时，与当前中医病名是同一个病，不重抽
  const verdict = visitReason.parseVisitReasonVerdict(JSON.stringify({ verdict: "not_covered", visitReason: "腰背疼痛", better: "骨质疏松症", reason: "x" }),
    { chiefComplaint: "腰背疼痛2年，加重1月", disease: "骨痿", picks: ["骨质疏松症", "腰痛"] });
  assert.equal(verdict.status, "unknown");
});
