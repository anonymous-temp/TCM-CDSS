// 第二十九轮（2026-10-29）：甲方红色横幅读的是 clinicalFacts.redFlags（文档 §4.7 列了响应里没有的顶层 redFlags），
// 以及同一病例顺带看到的三处：药名标签、注意事项里的药名被药味表改字、「服务器红旗」。
// 红旗筛查出参与文档对账在 test:api-doc-field-parity（DOC-07/08，调真实路由）。每条断言都有反证（~/runlogs/r1018/work/r1041/cp/）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}\n  ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
};

const safety = await jiti.import("../src/lib/diagnosis-safety.ts");
const types = await jiti.import("../src/lib/diagnosis-types.ts");
const review = await jiti.import("../src/lib/formula-analysis-review.ts");
const surface = await jiti.import("../src/lib/delivered-surface.ts");

// ---------- 1 用药标签：写了药名就不说「缺少药名」 ----------
// 甲方 2026-10-29「自行服用“藿香正气水”后症状稍缓」：剂型构词表没有「水」，标签写「缺少药名/剂量/频次」，
// 注意事项一栏却已按药名写了「您已自服藿香正气水」。两处现在用同一个取药名的读法（recordedMedicationMentions）。
function medicationLabel(presentIllness) {
  const state = types.normalizeCaseStateInput({
    id: "r1041-med", chiefComplaint: "发热、头昏、胸闷、恶心1天", patient: { sex: "女", age: 35 },
    symptoms: { 现病史: presentIllness, 既往史: "既往体健", 过敏史: "否认药物及食物过敏史", 婚育史: "适龄婚育，月经规律" },
    tongue: "舌质红，苔黄腻", pulse: "脉濡数", vitals: { T: "37.8", P: "80", R: "20", BP: "118/75" },
  });
  return safety.evaluateSafetyGate(state).missingItems.filter((item) => item.includes("当前用药"));
}

await check("1.1 「自行服用“藿香正气水”」「服用十滴水」：写了药名，只缺剂量频次", () => {
  for (const text of [
    "1天前于高温环境工作后出现发热，伴恶心欲呕。自行服用“藿香正气水”后症状稍缓，仍感周身困重。",
    "1天前于高温环境工作后出现发热，伴恶心欲呕。自行服用十滴水后症状稍缓。",
  ]) assert.deepEqual(medicationLabel(text), ["已提及当前用药但缺少剂量/频次"], text);
});

await check("1.2 对照：只写药物类别（感冒药、降压药）仍是「缺少药名」；带剂型的照旧", () => {
  assert.deepEqual(medicationLabel("1天前受凉后发热，自行服用感冒药后稍缓。"), ["已提及当前用药但缺少药名/剂量/频次"]);
  assert.deepEqual(medicationLabel("1天前受凉后发热，平素口服降压药，具体不详。"), ["已提及当前用药但缺少药名/剂量/频次"]);
  assert.deepEqual(medicationLabel("1天前受凉后发热。既往长期服用激素导致面部浮肿。"), ["已提及当前用药但缺少药名/剂量/频次"]);
  // 病历加了引号的商品名（没有剂型结尾）按药名算。
  assert.deepEqual(medicationLabel("1天前受凉后发热，自行服用“倍他乐克”后心慌稍缓。"), ["已提及当前用药但缺少剂量/频次"]);
  assert.deepEqual(medicationLabel("1天前受凉后发热，自行服用藿香正气口服液后稍缓。"), ["已提及当前用药但缺少剂量/频次"]);
});

// ---------- 2 药味表改字不改药名 ----------
// 同一病例第二次：方里有广藿香，注意事项「您已自服藿香正气水」被按药味表改成「广藿香正气水」（第一次方里没有藿香，没改）。
await check("2.1 药名里的药味字不按药味表改；不在药名里的照改", () => {
  const line = "您已自服藿香正气水，服本方期间是否继续服用请由医生决定。";
  assert.equal(review.withMentionsAlignedToTableNames(line, ["香薷", "广藿香"], ["藿香正气水"]).text, line);
  assert.equal(review.withMentionsAlignedToTableNames("藿香芳香化湿，为佐。", ["香薷", "广藿香"], ["藿香正气水"]).text, "广藿香芳香化湿，为佐。");
  // 说明书目录里也有「黄芩片」「黄连片」这样的成药名：它们本身是饮片名，方义里照旧按药味表写成黄芩、黄连（回放 1,808 份留存结果抓到 5 例）。
  assert.equal(review.withMentionsAlignedToTableNames("黄芩片、黄连片苦寒清热。", ["黄芩", "黄连"], ["黄芩片", "黄连片"]).text, "黄芩、黄连苦寒清热。");
  // 同一句里既有药名又单写了药味：只挡药名那一段。
  assert.equal(review.withMentionsAlignedToTableNames("已自服藿香正气水，方中藿香芳香化湿。", ["香薷", "广藿香"], ["藿香正气水"]).text,
    "已自服藿香正气水，方中广藿香芳香化湿。");
  // 机制本身（不给药名时照改）：说明上面那条靠的是药名，而不是改字没发生。
  assert.equal(review.withMentionsAlignedToTableNames(line, ["香薷", "广藿香"]).text, "您已自服广藿香正气水，服本方期间是否继续服用请由医生决定。");
});

function prescribePayload(precautions, extra = {}) {
  return {
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe",
    overview: { tcmDiseaseName: "感冒", primarySyndrome: "暑湿感冒证" },
    formula: {
      candidates: [{ name: "新加香薷饮加减", herbs: [
        { name: "香薷", role: "君" }, { name: "金银花", role: "臣" }, { name: "连翘", role: "臣" },
        { name: "厚朴", role: "佐" }, { name: "广藿香", role: "佐" }, { name: "滑石", role: "使" },
      ], formulaAnalysis: "本方以新加香薷饮为基础加减。香薷发汗解表、化湿和中，为君；金银花、连翘清热透邪，为臣；厚朴燥湿行气，藿香芳香化湿，共为佐；滑石利水渗湿，为使。" }],
      patentAndWestern: extra.patentAndWestern || [],
      modifications: [],
    },
    nonPharma: { precautions },
    management: { redFlagLoop: "目前无服务器红旗提示；若出现高热不退、意识改变、抽搐、少尿或胸闷加重，应立即急诊评估。" },
  };
}

await check("2.2 交付面：病历所写、本页所推荐、说明书目录认得的药名都不改字；方义里单写的「藿香」照改为广藿香", () => {
  const self = "您已自服藿香正气水，服本方期间是否继续服用请由医生决定。";
  // 推荐药用说明书目录里没有的名字（模型提名、外部核实的成药），才测得到「推荐药」这一来源本身。
  const recommended = "服本方期间不必另服藿香和中颗粒。";
  const catalogOnly = "藿香正气软胶囊与本方功用相近，不宜同服。";
  const requiredPrecautions = [{ kind: "self_medication", name: "藿香正气水", base: "藿香正气水", composition: [], alcoholWarning: false }];
  const out = surface.projectDeliveredReasoning(
    prescribePayload([self, recommended, catalogOnly], { patentAndWestern: [{ type: "中成药", name: "藿香和中颗粒" }] }),
    { requiredPrecautions });
  const precautions = out.nonPharma.precautions.join("\n");
  assert.ok(precautions.includes("藿香正气水") && precautions.includes("藿香和中颗粒") && !/广藿香(?:正气|和中)/u.test(precautions), precautions);
  assert.match(out.formula.candidates[0].formulaAnalysis, /广藿香芳香化湿/);
  // 没给病历药名时，说明书目录认得的药名照样不改（同一病例第一次写在注意事项里的就是目录里的药名）。
  const bare = surface.projectDeliveredReasoning(prescribePayload([catalogOnly]));
  assert.ok(bare.nonPharma.precautions.join("\n").includes("藿香正气软胶囊") && !bare.nonPharma.precautions.join("\n").includes("广藿香正气"));
});

// ---------- 3 「服务器红旗」 ----------
// 辨证提示词写「承接服务器红旗」，模型照抄进红旗处置一句：10/14–10/29 留存的辨证、开方结果里 830 处。
await check("3.1 「目前无服务器红旗提示」交付为「目前无急危重征象」；其余措辞不动", () => {
  assert.equal(surface.clinicalWordingForSyntheticPhrases("目前无服务器红旗提示；若出现高热不退应立即急诊评估。"),
    "目前无急危重征象；若出现高热不退应立即急诊评估。");
  assert.equal(surface.clinicalWordingForSyntheticPhrases("目前无服务器红旗；若出现意识模糊应立即急诊。"), "目前无急危重征象；若出现意识模糊应立即急诊。");
  assert.equal(surface.clinicalWordingForSyntheticPhrases("目前无服务器红旗提示，亦无呼吸系统红旗。"), "目前无急危重征象，亦无呼吸系统红旗。");
  // 「呼吸系统红旗」说的是器官系统（回放留存结果时抓到的误改）。
  for (const untouched of ["系统性红斑狼疮病史10年", "目前无红旗征象；若出现胸痛加重请立即就医。", "受凉后鼻塞咳嗽，无发热及呼吸系统红旗，符合急性上呼吸道感染。"]) {
    assert.equal(surface.clinicalWordingForSyntheticPhrases(untouched), untouched);
  }
  const out = surface.projectDeliveredReasoning(prescribePayload([]));
  assert.equal(out.management.redFlagLoop, "目前无急危重征象；若出现高热不退、意识改变、抽搐、少尿或胸闷加重，应立即急诊评估。");
});

await check("3.2 辨证提示词不再写「服务器红旗」", () => {
  const source = readFileSync("src/lib/m03-context-packets.ts", "utf8");
  assert.ok(source.includes("redFlagLoop 用一句话（≤80字）写本例的急危重征象与处置"), "redFlagLoop 一句的说明找不到了，本条断言需要随之更新");
  assert.ok(!/服务器红旗|服务端红旗/.test(source));
});

console.log(JSON.stringify({ suite: "r1041-main", cases }));
