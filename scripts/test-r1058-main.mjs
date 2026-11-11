// 第四十三轮（2026-11-11）：原方组成表（第四十二轮根因一）集成上线前的实测发现。
//  1. 原文「炒黑」「炒焦」被读成「炒」：凉血地黄汤《外科大成》「黄芩（炒黑）、槐角（炒黑）、地榆（炒黑）、荆芥（炒黑）」交付成
//     炒黄芩、炒槐角、炒地榆、炒荆芥（new40 m31）。炒黑是炒炭（存性），炒焦是焦，都不是清炒。
//  2. 方义明说去掉的药引，用法里又劝加（new40 m08：「去原方药引生姜、大枣」与「原方以生姜、大枣为引，煎时可酌加」）。
// 每条断言都有反证（~/runlogs/r1018/work/r1058/cp/）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@": `${process.cwd()}/src`,
    "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
  },
});
let failures = 0;
const check = async (name, run) => {
  try {
    await run();
    console.log(`✓ ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`✗ ${name}\n  ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
};

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const source = read("../src/data/tcm-formula-original-compositions.source.json");
const table = read("../src/data/tcm-formula-original-compositions.json");
const processing = await jiti.import("../src/lib/herb-processing-forms.ts");
const surface = await jiti.import("../src/lib/delivered-surface.ts");

const CHARRING = /炒黑|炒炭|烧存性|炒令黑/u;
const SCORCHING = /炒焦/u;

await check("1.1 原方组成表输入里，记为清炒（炒）的药，原文注写的不是炒黑、炒炭、烧存性、炒焦（那些记为炭、焦）", () => {
  const wrong = [];
  for (const row of source.rows) {
    for (const item of row.ingredients) {
      const note = String(item.note || "");
      // 缺陷类是「炒黑/炒焦被读成清炒」：记为清炒（炒）的药，原文注不得写的是炒黑、炒焦。不记炮制、或记为烧/炮的不在此类。
      if (item.preparation !== "炒") continue;
      if (CHARRING.test(note) || SCORCHING.test(note)) wrong.push(`${row.name}《${row.book}》${item.written}：${item.preparation}（${note}）`);
    }
  }
  assert.deepEqual(wrong, []);
  // 不是空转：这类写法在表里确有（凉血地黄汤四味、清胃汤山栀仁等）。
  const charred = source.rows.flatMap((row) => row.ingredients.filter((item) => item.preparation === "炭" && CHARRING.test(String(item.note || ""))));
  assert.ok(charred.length >= 10, `记为炭的炒黑类条目 ${charred.length}`);
});

await check("1.2 生成物与输入一致：凉血地黄汤《外科大成》黄芩、槐角、地榆、荆芥是炭（随方交付），黄连照原文炒", () => {
  const entry = table.entries.find((item) => item.name === "凉血地黄汤" && item.book === "外科大成");
  assert.ok(entry, "表里有凉血地黄汤《外科大成》");
  const prep = Object.fromEntries(entry.herbs.map((item) => [item.herb, item.preparation || ""]));
  for (const herb of ["黄芩", "槐角", "地榆", "荆芥"]) assert.equal(prep[herb], "炭", herb);
  assert.equal(prep["黄连"], "炒");
});

await check("1.3 交付药名：凉血地黄汤的地榆、槐角、黄芩不再写成炒地榆、炒槐角、炒黄芩；荆芥写荆芥炭；原文清炒的黄连照写炒黄连", () => {
  const named = (herb) => processing.processedHerbName(herb, { formulaName: "凉血地黄汤" });
  for (const herb of ["地榆", "槐角", "黄芩"]) assert.notEqual(named(herb), `炒${herb}`, herb);
  assert.equal(named("荆芥"), "荆芥炭");
  assert.equal(named("黄连"), "炒黄连");
});

await check("2.1 方义明说去掉的药引，用法里不再劝加；没说去时照写；「去X易Y」是换药不算去", () => {
  const herbs = ["人参", "白术", "茯苓", "陈皮", "半夏", "薏苡仁", "甘草"].map((name) => ({ name }));
  assert.match(surface.omittedGuideHerbNote("六君子汤加减", herbs, {}, "人参为君。") || "", /生姜、大枣/u);
  assert.equal(surface.omittedGuideHerbNote("六君子汤加减", herbs, {}, "本方以六君子汤为基础加减，去原方药引生姜、大枣，加薏苡仁。人参为君。"), undefined);
  assert.match(surface.omittedGuideHerbNote("六君子汤加减", herbs, {}, "本方以六君子汤为基础加减，去生姜之辛散。") || "", /^原方以大枣为引/u);
  assert.match(surface.omittedGuideHerbNote("六君子汤加减", herbs, {}, "本方以六君子汤为基础加减，去生姜易干姜以温中。") || "", /生姜、大枣/u);
  assert.deepEqual(surface.herbsNamedAsRemoved("去阿胶、半夏、生姜、莪术、牛膝，加巴戟天。去川芎而以当归活血。"), ["阿胶", "半夏", "生姜", "莪术", "牛膝"]);
  // 同一小句里「去…加…」：去的对象到「加」为止（加进来的干姜不算去）。
  assert.deepEqual(surface.herbsNamedAsRemoved("去生姜加干姜以温中。"), ["生姜"]);
});

const provenance = await jiti.import("../src/lib/tcm-formula-provenance.ts");
const original = await jiti.import("../src/lib/formula-original-composition.ts");

await check("3.1 教材署的书在原方组成表里没有这首方时，不拿教材常用药判同名异方：瘾疹·风热犯表证「消风散（《医宗金鉴》）」仍锁目录《外科正宗》消风散、出处不改署（甲方标准病历 9）", () => {
  const rowId = "waike|瘾疹|风热犯表证";
  assert.equal(original.textbookRowFormulaBook(rowId, "消风散"), "医宗金鉴", "前提：教材这一行署《医宗金鉴》");
  assert.equal(original.originalFormula("消风散", "医宗金鉴"), undefined, "前提：表里没有《医宗金鉴》消风散");
  assert.equal(provenance.textbookCitedFormulaIsGovernedHomonym("消风散", rowId), false);
  const commonHerbs = ["荆芥", "防风", "牛蒡子", "蝉蜕", "金银花", "连翘", "苦参", "知母", "生地黄", "甘草"];
  assert.equal(provenance.textbookFormulaOriginalSource("消风散", commonHerbs, { textbookRowId: rowId })?.includes("医宗金鉴"), false);
  const locked = provenance.withDeterministicFormulaReferences({
    stage: "diagnose",
    overview: { tcmDiseaseName: "瘾疹", primarySyndrome: "风热犯表证", recommendedFormulaDirection: "消风散加减", recommendedFormulaNames: [] },
    therapy: { overallMethod: "疏风清热止痒" },
  });
  assert.deepEqual(locked.overview.recommendedFormulaNames, ["消风散"]);
  // 对照：表里有教材写的那本书、且组成真不同的同名方照旧判同名异方（白术散《全生指迷方》）。
  assert.equal(provenance.textbookCitedFormulaIsGovernedHomonym("白术散", "fuke|子肿|脾虚证"), true);
});

if (failures > 0) console.error(`\n${failures} check(s) failed`);
else console.log("\nall checks passed");
