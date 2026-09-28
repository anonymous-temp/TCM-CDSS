// 药典外药材的参考用量与身份（2026-09-28）。
//
// 背景：剂量知识库里有一层「高置信中药饮片剂量校准层」——上游手写的推定值，没有逐条出处，
// 出处链接却统一指向药典网站。逐条比对：17 行与药典重复，三七/川贝母/桃仁/肉桂的研粉量按汤剂量写，
// 朱砂等 5 味把「只入丸散」写成「煎服」；药典外 5 味（五灵脂、神曲、败酱草、龙骨、藜芦）只有它。
// 用户 2026-09-28 定：药典外药材用量不再等中医师复核，按联网核查裁决。本套件钉住：
//   ① 校准层不再进入运行时（任何剂量边界、知识摘要都看不到它）；
//   ② 药典外药材走受治理参考用量（每条 ≥2 出处、只取煎服口径、药典优先），sourceType=reference；
//   ③ 医师定量药的标注如实：区间内写出处，区间外批注偏离——此前开多少都显示「已按标准区间校验」
//      （实测败酱草 45g）；
//   ④ 身份：药典 8 个带全角括注的正名（延胡索（元胡）、土鳖虫（䗪虫）…）能查到自己；「败酱」指败酱草，
//      不是小蓟（实测败酱 15g 按小蓟药典 5–12g 判超量）；龙骨、五灵脂、六神曲等补上身份；
//      土鳖虫是药典药，不再按「药典未收载」由医师定量。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
const kb = await jiti.import("../src/lib/tcm-knowledge.ts");
const identity = await jiti.import("../src/lib/tcm-herb-identity.ts");
const { m04CompilerTestHooks } = await jiti.import("../src/lib/m04-proposal-compiler.ts");
const source = JSON.parse(readFileSync("src/data/tcm-herb-nonpharmacopoeia-dose.source.json", "utf8"));
const knowledge = JSON.parse(readFileSync("src/data/tcm-knowledge.json", "utf8"));

const failures = [];
let checks = 0;
function check(name, fn) {
  checks += 1;
  try {
    fn();
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
  }
}

check("CAL-01 校准层不进入剂量边界", () => {
  // 生成物里仍有这 33 行（生成器依赖的上游候选清单本机已不在，无法重建）；运行时读入即剔除。
  const calibrated = knowledge.herbs.filter((herb) => herb.entries.some((entry) => entry.basis === "高置信中药饮片剂量校准层"));
  assert.ok(calibrated.length >= 30, "fixture：生成物里的校准层行应仍在（证明剔除发生在运行时）");
  const leaked = calibrated
    .map((herb) => [herb.name, kb.getTcmHerbDoseLimit(herb.name)])
    .filter(([, limit]) => limit && /校准层/.test(`${limit.basis || ""}${JSON.stringify(limit.alternatives || [])}`));
  assert.deepEqual(leaked.map(([name]) => name), []);
  const summary = kb.searchTcmKnowledge ? JSON.stringify(kb.searchTcmKnowledge("三七 川贝母 桃仁", 5)) : "";
  assert.doesNotMatch(summary, /校准层/, "知识摘要里也不得再出现校准层行");
});

check("CAL-02 药典药材的边界不受影响（校准层原本与药典重复或更宽）", () => {
  for (const [herb, min, max] of [["三七", 3, 9], ["川贝母", 3, 10], ["人参", 3, 9], ["石膏", 15, 60], ["杜仲", 6, 10]]) {
    const limit = kb.getTcmHerbDoseLimit(herb);
    assert.equal(limit?.sourceType, "dose", herb);
    assert.deepEqual([limit.min, limit.max], [min, max], herb);
  }
});

check("REF-01 参考用量表：每条 ≥2 出处、有原文摘句；只收药典未收载的药", () => {
  assert.ok(source.entries.length >= 15);
  for (const entry of source.entries) {
    assert.ok(entry.sources.length >= 2, `${entry.herb} 出处不足两条`);
    assert.ok(entry.sources.every((item) => item.quote && item.title), `${entry.herb} 出处缺原文摘句`);
    const herbData = knowledge.herbs.find((item) => item.name === entry.herb);
    const chpDose = (herbData?.entries || []).some((item) => item.type === "dose" && /药典/.test(item.basis || ""));
    assert.equal(chpDose, false, `${entry.herb} 有药典剂量条目，不应进参考用量表`);
  }
  assert.equal(source.entries.some((entry) => entry.herb === "竹叶" || entry.herb === "建曲"), false,
    "只有一条可靠出处的药（竹叶、建曲）不收");
});

check("REF-02 药典外药材按参考用量给出边界；非煎服口径（丸散/研末）不作煎剂区间", () => {
  for (const [herb, min, max] of [["五灵脂", 3, 10], ["六神曲", 3, 15], ["神曲", 3, 15], ["败酱草", 6, 15], ["龙骨", 9, 30], ["煅龙骨", 9, 30], ["浮小麦", 6, 30]]) {
    const limit = kb.getTcmHerbDoseLimit(herb);
    assert.equal(limit?.sourceType, "reference", herb);
    assert.deepEqual([limit.min, limit.max], [min, max], herb);
    assert.match(limit.basis, /药典未收载，参考用量/, herb);
    assert.doesNotMatch(limit.basis, /^中华人民共和国药典/, herb);
  }
  for (const herb of ["藜芦", "紫河车", "琥珀"]) {
    assert.equal(kb.getTcmHerbDoseLimit(herb), null, `${herb} 只入丸散或研末，不给煎剂区间`);
  }
  assert.equal(kb.clinicianDoseHerbClass("藜芦"), "controlled_or_toxic", "藜芦仍按管制毒性，不给剂量");
});

check("VERIFY-01 医师定量药的核验标注如实：区间内写出处，区间外批注，不再一律「已校验」", () => {
  const verify = (name, dose) => m04CompilerTestHooks.compileHerbVerification(name, dose, "水煎服");
  const over = verify("败酱草", "45g");
  assert.notEqual(over.verificationTier, "verified", "败酱草 45g 超出参考区间，不得标已校验（旧实现：已按 6-15g 标准区间完成校验）");
  assert.match(over.verificationReasons.join("；"), /参考区间 6–15g/);
  const inside = verify("龙骨", "20g");
  assert.equal(inside.verificationTier, "verified");
  assert.match(inside.verificationReasons.join("；"), /参考区间内.*药典未收载/);
  assert.doesNotMatch(inside.verificationReasons.join("；"), /标准区间完成规则校验/);
  const bajiang = verify("败酱", "15g");
  assert.equal(bajiang.verificationTier, "verified", "败酱 15g 在败酱草参考区间内（旧：按小蓟 5–12g 判超量）");
  assert.equal(verify("延胡索（元胡）", "10g").verificationTier, "verified", "正名写法不得判身份待核定");
  assert.equal(verify("杜仲", "10g").verificationTier, "verified");
});

check("ID-01 带全角括注的药典正名能查到自己", () => {
  for (const name of ["延胡索（元胡）", "延胡索(元胡)", "土鳖虫（䗪虫）", "冰片（合成龙脑）", "灯盏细辛（灯盏花）"]) {
    const resolved = identity.resolveGovernedTcmHerbIdentity(name);
    assert.ok(resolved.canonicalName, `${name} 查不到自己`);
  }
});

check("ID-02 败酱指败酱草，不是小蓟；龙骨/五灵脂/六神曲有身份；土鳖虫对应药典正名", () => {
  assert.equal(identity.resolveGovernedTcmHerbIdentity("败酱").canonicalName, "败酱草");
  assert.equal(kb.getTcmHerbDoseLimit("败酱")?.sourceType, "reference", "败酱不得再拿到小蓟的药典区间");
  for (const [name, canonical] of [["龙骨", "龙骨"], ["煅龙骨", "龙骨"], ["五灵脂", "五灵脂"], ["醋五灵脂", "五灵脂"], ["六神曲", "六神曲"], ["浮小麦", "浮小麦"], ["土鳖虫", "土鳖虫（䗪虫）"], ["䗪虫", "土鳖虫（䗪虫）"]]) {
    assert.equal(identity.resolveGovernedTcmHerbIdentity(name).canonicalName, canonical, name);
  }
  assert.equal(identity.resolveGovernedTcmHerbIdentity("焦神曲").canonicalName, undefined,
    "中医师 2026-08-16：炒/焦神曲无独立依据时不自动合并");
  assert.equal(kb.clinicianDoseHerbClass("土鳖虫"), undefined, "土鳖虫是药典药（3–10g，有小毒），不按药典未收载处理");
  // 藜芦不补身份：补了以后藜芦散、通顶散（与人参、细辛同方，十八反）、乌喙丸会获得方剂配剂量资格。
  // 藜芦按管制毒性从不给剂量，十八反核对按知识库药名命中，不依赖这条身份。
  assert.equal(identity.resolveGovernedTcmHerbIdentity("藜芦").canonicalName, undefined);
  const veratrumPairs = kb.findTcmHerbPairIncompatibilities(["藜芦", "人参", "细辛"]).map((item) => `${item.leftDrug}×${item.rightDrug}`);
  assert.ok(veratrumPairs.some((pair) => /藜芦/.test(pair) && /人参/.test(pair)), `藜芦×人参必须检出：${veratrumPairs.join("、")}`);
  assert.ok(veratrumPairs.some((pair) => /藜芦/.test(pair) && /细辛/.test(pair)), "藜芦×细辛必须检出");
  const catalog = JSON.parse(readFileSync("src/data/tcm-formula-governed-catalog.json", "utf8"));
  const eligibleWithVeratrum = catalog.entries.filter((entry) => entry.doseCompilationEligible &&
    (entry.ingredientLinks || []).some((link) => link.canonicalName === "藜芦"));
  assert.deepEqual(eligibleWithVeratrum.map((entry) => entry.name), [], "含藜芦的方不得获得配剂量资格");
  const yiyi = catalog.entries.find((entry) => entry.name === "薏苡附子败酱散");
  assert.equal(yiyi?.doseCompilationEligible, true, "薏苡附子败酱散：败酱按药典未收载、由医师定量，照常可编译");
  assert.ok((yiyi?.clinicianDoseIngredientNames || []).includes("败酱"));

  assert.equal(kb.getTcmHerbDoseLimit("土鳖虫")?.sourceType, "dose");
});

{
  const fallbackSource = readFileSync("src/lib/m04-deterministic-fallback.ts", "utf8");
  check("FALLBACK-02 兜底方表头与单元格如实标来源", () => {
    assert.match(fallbackSource, /剂量区间（来源）/);
    assert.match(fallbackSource, /参考用量，药典未收载/);
    assert.doesNotMatch(fallbackSource, /\| 药典剂量区间 \|/);
  });
}

if (failures.length > 0) {
  console.error(JSON.stringify({ suite: "nonpharmacopoeia-dose", checks, failures }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ suite: "nonpharmacopoeia-dose", checks, failures: 0 }));
