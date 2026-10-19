// 10/19 第四轮·煎法（2026-10-19）：药味表的特殊煎法与煎服行要和规则层（药典 + 《中药学》）一致。
//
// 每条断言都带对照，并跑过反证（记录见 ~/runlogs/r1018/work/r1019/counterproofs.txt，前缀 5/decoction/）。
//
//   1 药表多写了这味药没有出处的煎法（另一规格的：滑石块先煎、滑石粉包煎，药表「滑石（先煎、包煎）」；蛤壳同）：
//     最后一道药表核对（applyDeterministicHerbDecoctionRequirements）先按 withoutUnsupportedDecoctionLabels 去掉再核。
//     此前它只核「缺没缺」，多写的一种照样判满足；编译器去过一次，但已缓存或不经编译器的内容就留下了（留出例 S145）。
//   2 先煎又包煎的药（药典金礞石、青礞石「先煎、包煎」）在煎服行里两组都点名；此前每味药只取一组，煎服行只写先煎。
//   3 整条最终后处理（煎服行 → 药表煎法 → 交付面）之后，S145 形状的处方药表与煎服行一致：
//     滑石只先煎、蚕沙包煎（规则层由教材补，蚕沙「宜布包入煎」）；没有特殊煎法的药不加；大黄按药表标的那一种。
//
// 已存结果全量回放（M-r19f、H-r19f、local19-held、local19-c10，752 份，567 张处方）：
//   药表煎法≠规则层  已存 14 → 重放（修前）12 → 重放（修后）0；煎服行漏点名  已存 3 → 重放 1 → 1（鹿茸，规则层两个时机都要求，见回复）。
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@": `${process.cwd()}/src`,
    "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
  },
});

let cases = 0;
const check = async (name, run) => {
  cases += 1;
  try {
    await run();
  } catch (error) {
    console.error(`✗ ${name}\n  ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
};

const rules = await jiti.import("../src/lib/herb-decoction-rules.ts");
const visible = await jiti.import("../src/lib/diagnosis-visible-summary.ts");
const surface = await jiti.import("../src/lib/delivered-surface.ts");

const START = "<!-- DIAGNOSIS_JSON_START -->";
const END = "<!-- DIAGNOSIS_JSON_END -->";
const wrap = (reasoning) => `${START}\n${JSON.stringify(reasoning)}\n${END}`;
const unwrap = (content) => {
  const start = content.lastIndexOf(START);
  return JSON.parse(content.slice(start + START.length, content.indexOf(END, start)).trim());
};
const herb = (name, decoctionRequirement = null, role = "佐", dose = "10g") => ({
  name, dose, role, targetKind: "pathogenesis_node", targetRef: "P1", targetPathogenesis: "湿热下注", function: "清热利湿", decoctionRequirement,
});
const prescription = (herbs) => ({
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "prescribe",
  therapy: { overallPrinciple: "热者寒之", overallMethod: "清热除湿，活血通络", subTherapies: [] },
  formula: {
    candidates: [{
      name: "宣痹汤加减",
      herbs,
      decoction: { doseCount: "5剂", method: "水煎服", course: "5日", dosesPerDay: 1, administrationTimesPerDay: 2 },
    }],
    modifications: [],
  },
});
// 只跑药表核对这一道。
const tableOnly = (herbs) => unwrap(visible.applyDeterministicHerbDecoctionRequirements(wrap(prescription(herbs)))).formula.candidates[0].herbs;
// 最终后处理与流层收尾同序（diagnosis-api：applyDeterministicDecoctionMethod → applyDeterministicHerbDecoctionRequirements），再过交付面。
const finalChain = (herbs, age = 45) => {
  let content = wrap(prescription(herbs));
  content = visible.applyDeterministicDecoctionMethod(content, "", age);
  content = visible.applyDeterministicHerbDecoctionRequirements(content);
  content = surface.applyDeliveredSurfaceToContent(content);
  return unwrap(content).formula.candidates[0];
};
const requirementOf = (herbs, name) => herbs.find((item) => item.name === name)?.decoctionRequirement ?? null;
// 煎服行里点名这味药的那一小句（「A、B包煎」）。
const clausesNaming = (line, name) => line.split(/[，,]/u).filter((clause) => {
  const at = clause.search(/先煎|后下|包煎|另煎|烊化|冲服|兑入/u);
  return at > 0 && clause.slice(0, at).split("、").includes(name);
});

// ───── 1 药表多写的另一规格煎法 ─────
await check("1.1 药表「滑石（先煎、包煎）」「蛤壳（先煎、包煎）」去掉包煎（教材：滑石块先煎、滑石粉包煎；先煎，蛤粉包煎）", () => {
  const herbs = tableOnly([herb("滑石", "先煎、包煎", "臣", "15g"), herb("蛤壳", "先煎、包煎")]);
  assert.equal(requirementOf(herbs, "滑石"), "先煎");
  assert.equal(requirementOf(herbs, "蛤壳"), "先煎");
});
await check("1.2 对照：规格对得上的照留（滑石粉包煎、车前子包煎、附子先煎久煎）；没有特殊煎法的药不加（黄柏、甘草）", () => {
  const herbs = tableOnly([
    herb("滑石粉", "包煎"), herb("车前子", "包煎"), herb("附子", "先煎、久煎", "君", "9g"), herb("黄柏"), herb("甘草", null, "使", "6g"),
  ]);
  assert.equal(requirementOf(herbs, "滑石粉"), "包煎");
  assert.equal(requirementOf(herbs, "车前子"), "包煎");
  assert.equal(requirementOf(herbs, "附子"), "先煎、久煎");
  assert.equal(requirementOf(herbs, "黄柏"), null);
  assert.equal(requirementOf(herbs, "甘草"), null);
});
await check("1.3 对照：药典几选一的大黄按药表标的那一种（先煎仍是先煎、照抄整串的取后下），禁止久煎照留", () => {
  const herbs = tableOnly([herb("大黄", "先煎"), { ...herb("酒大黄", "后下或先煎或冲服、禁止久煎"), name: "大黄" }]);
  assert.equal(herbs[0].decoctionRequirement, "先煎");
  assert.equal(herbs[1].decoctionRequirement, "后下、禁止久煎");
});
await check("1.4 没有出处、规则层也查不到要求的标注整条去掉（肉豆蔻「后下」→ 不写）；豆蔻后下照留（对照）", () => {
  const herbs = tableOnly([herb("肉豆蔻", "后下"), herb("豆蔻", "后下")]);
  assert.equal(requirementOf(herbs, "肉豆蔻"), null);
  assert.equal(requirementOf(herbs, "豆蔻"), "后下");
});
await check("1.5 药表缺规则层要求的照旧补上（蚕沙 → 包煎，教材「宜布包入煎」；檀香 → 后下）；幂等", () => {
  const once = tableOnly([herb("蚕沙"), herb("檀香", null, "佐", "3g"), herb("滑石", "先煎、包煎")]);
  assert.equal(requirementOf(once, "蚕沙"), "包煎");
  assert.equal(requirementOf(once, "檀香"), "后下");
  assert.deepEqual(tableOnly(once), once);
});

// ───── 2 先煎又包煎 ─────
await check("2.1 金礞石「先煎、包煎」在煎服行先煎、包煎两组都点名；单味说明（随证加减用）两组都写", () => {
  const candidate = finalChain([herb("金礞石", null, "君", "15g"), herb("车前子", "包煎"), herb("黄芩")]);
  assert.equal(requirementOf(candidate.herbs, "金礞石"), "先煎、包煎");
  const line = candidate.decoction.method;
  assert.equal(clausesNaming(line, "金礞石").length, 2, line);
  assert.match(line, /金礞石先煎20–30分钟/u);
  assert.match(line, /(?:车前子、金礞石|金礞石、车前子)包煎/u);
  assert.equal(rules.specialDecoctionPhrase("金礞石"), "金礞石先煎20–30分钟，金礞石包煎");
});
await check("2.2 对照：只要一种煎法的照旧一组（附子先煎45–60、车前子包煎、大黄后下、砂仁后下）；普通药为空", () => {
  assert.deepEqual(rules.specialDecoctionOrderIndexes("附子"), [0]);
  assert.equal(rules.specialDecoctionPhrase("附子"), "附子先煎45–60分钟（至口尝无麻辣感）");
  assert.equal(rules.specialDecoctionPhrase("车前子"), "车前子包煎");
  assert.equal(rules.specialDecoctionPhrase("大黄"), "大黄后下");
  assert.equal(rules.specialDecoctionPhrase("大黄", "先煎"), "大黄先煎20–30分钟");
  assert.equal(rules.specialDecoctionPhrase("砂仁"), "砂仁后下");
  assert.equal(rules.specialDecoctionPhrase("黄柏"), "");
  assert.equal(rules.specialDecoctionOrderIndex("金礞石"), 1, "取第一组的老接口不变（先煎）");
});

// ───── 3 S145 形状的整条后处理 ─────
// 留出例 S145（代码 21b9bef 的最终交付）：药表滑石「先煎、包煎」、蚕沙无煎法；煎服行只写「滑石先煎20–30分钟」。
const S145_HERBS = [
  herb("黄柏", null, "君"), herb("薏苡仁", null, "臣", "25g"), herb("牛膝", null, "臣"), herb("防己", null, "臣"),
  herb("滑石", "先煎、包煎", "臣", "15g"), herb("栀子", null, "臣", "9g"), herb("连翘", null, "佐", "12g"), herb("赤小豆", null, "佐", "15g"),
  herb("蚕沙", null, "佐"), herb("威灵仙", null, "佐"), herb("甘草", null, "使", "6g"),
];
await check("3.1 S145：药表滑石只写先煎、蚕沙写包煎；煎服行「滑石先煎20–30分钟」「蚕沙包煎」，不写滑石包煎", () => {
  const candidate = finalChain(S145_HERBS);
  const line = candidate.decoction.method;
  assert.equal(requirementOf(candidate.herbs, "滑石"), "先煎");
  assert.equal(requirementOf(candidate.herbs, "蚕沙"), "包煎");
  assert.match(line, /滑石先煎20–30分钟/u, line);
  assert.match(line, /蚕沙包煎/u, line);
  assert.deepEqual(clausesNaming(line, "滑石"), ["滑石先煎20–30分钟"]);
});
await check("3.2 S145 对照：其余九味药表无煎法、煎服行不点名；整条再跑一遍结果不变（幂等）", () => {
  const candidate = finalChain(S145_HERBS);
  for (const name of ["黄柏", "薏苡仁", "牛膝", "防己", "栀子", "连翘", "赤小豆", "威灵仙", "甘草"]) {
    assert.equal(requirementOf(candidate.herbs, name), null, name);
    assert.deepEqual(clausesNaming(candidate.decoction.method, name), [], name);
  }
  assert.deepEqual(finalChain(candidate.herbs).herbs, candidate.herbs);
  assert.equal(finalChain(candidate.herbs).decoction.method, candidate.decoction.method);
});
await check("3.3 整类不变量：最终药表每味都满足规则层、不带没有出处的标注；煎服行逐组点名规则层要求的药（含大黄先煎、附子久煎、金礞石两组）", () => {
  const herbs = [...S145_HERBS, herb("大黄", "先煎"), herb("附子", null, "臣", "9g"), herb("金礞石"), herb("檀香", null, "佐", "3g"), herb("蛤壳", "先煎、包煎")];
  const candidate = finalChain(herbs);
  const line = candidate.decoction.method;
  for (const item of candidate.herbs) {
    const declared = item.decoctionRequirement || "";
    assert.equal(rules.decoctionRuleSatisfied(item.name, declared), true, `${item.name}「${declared}」`);
    assert.equal(rules.withoutUnsupportedDecoctionLabels(item.name, declared), declared, `${item.name}「${declared}」`);
    // 规则层要求的每一组（几选一按药表标的那一种；久煎组已含先煎），独立于煎服行的取法另算一遍。
    const rule = rules.decoctionRuleForHerb(item.name);
    const chosen = (rule?.oneOf || []).map((alternatives) => {
      const named = alternatives.filter((alternative) => declared.includes(alternative));
      return named.length === 1 ? named[0] : alternatives[0];
    });
    const text = [...(rule?.required || []), ...chosen].join("、");
    const groups = rules.SPECIAL_DECOCTION_ORDER.flatMap((entry, index) => entry.pattern.test(text) ? [index] : []);
    for (const index of groups.includes(0) ? groups.filter((group) => group !== 1) : groups) {
      const suffix = rules.SPECIAL_DECOCTION_ORDER[index].phrase("");
      assert.ok(clausesNaming(line, item.name).some((clause) => clause.endsWith(suffix)), `${item.name} 应点名「${suffix}」：${line}`);
    }
  }
  assert.equal(clausesNaming(line, "金礞石").length, 2, line);
  assert.match(line, /附子先煎45–60分钟/u);
  assert.deepEqual(clausesNaming(line, "大黄").map((clause) => clause.replace(/^.*?(?=先煎|后下)/u, "")), ["先煎20–30分钟"]);
});

console.log(JSON.stringify({ suite: "r1019-round4-decoction", cases, failures: process.exitCode ? "see above" : 0 }));
