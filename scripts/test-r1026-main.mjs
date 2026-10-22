// 10/22 第十四轮（用户：「发现但没修的，联网找策略或自己想，能解决就修好再提交和部署」）。
//
//   1 证候依据「至少有一条现症」：句中靠后才出现的「既往/曾经」只管它所在的小句及其后（S 集 S-renal-008：
//     「尿频，夜尿1次，…腰痛乏力，肾功能不全既往规律口服金水宝」整句被引作依据，句末的「既往」让前面七项现症全算既往，
//     M03 五次里四次退回受限结果）。句首的既往、转归词（已缓解/已治愈…）照旧整句判既往。
//   2 教材条件式加减在定稿前的方向过滤里与编译器、最终合同同一判据（留出集 S044：外邪犯胃证的教材加减
//     「若见壮热口渴，便秘尿赤者，可加黄芩、黄连、栀子」编译时放行，定稿时因「清热与主证方向相反」被删光）。
//   3 补写鉴别的小任务与 M03 的鉴别字段：「相近之处」只取该鉴别病本身就有、本例也有的表现，先写对方的典型表现再写相近之处
//    （甲方病历 9：风热疮「均见风团样皮疹」，风热疮是椭圆形红斑覆糠秕状鳞屑）。
//   4 孕哺提示从 15 岁起写（人口统计的育龄口径 15–49 岁），病历自己写到停经、月经推迟、性生活、妊娠、哺乳的除外；
//     月经类提示仍从 12 岁起；安全闸门的孕哺筛查（10–59 岁）不变（S 集 12 岁、14 岁女孩的处方写「如已怀孕、可能怀孕或正在哺乳」）。
//   5 注意事项：毒性药是否已写到按药物身份认（模型写「附片有毒」、药表是附子，又补一条附子毒性提示）；
//     超过 5 条时去不点名任何药的「如正在服用其他药物请告知医生」和第二条起的孕哺提示。
//   6 教材一节合写两个病名（胎漏、胎动不安；堕胎、小产）：生成器逐个抽各自的定义句，候选段两句都给，提示词要求只写相符的那一个，
//     锚定不再把模型写的那一个改回节名（S 集妊娠例：腰酸腹痛下坠写成胎漏，依据里又说「故不归胎漏」）。

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

const contract = await jiti.import("../src/lib/diagnosis-stage-contract.ts");
const modSafety = await jiti.import("../src/lib/m04-modification-safety.ts");
const safety = await jiti.import("../src/lib/diagnosis-safety.ts");
const boundary = await jiti.import("../src/lib/candidate-boundary-text.ts");
const surface = await jiti.import("../src/lib/delivered-surface.ts");
const required = await jiti.import("../src/lib/required-precautions.server.ts");

const START = "<!-- DIAGNOSIS_JSON_START -->";
const END = "<!-- DIAGNOSIS_JSON_END -->";
const wrap = (reasoning) => `${START}\n${JSON.stringify(reasoning)}\n${END}`;
const unwrap = (content) => {
  const start = content.lastIndexOf(START);
  return JSON.parse(content.slice(start + START.length, content.indexOf(END, start)).trim());
};

// ───── 1 既往锚只管其后 ─────
await check("1.1 句末「既往」不让前面的现症全算既往（S-renal-008 整句）", () => {
  assert.equal(contract.isCurrentPositiveTcmAnchor("尿频，夜尿1次，大便黏，睡眠好，口干口苦，阴囊潮湿，腰痛乏力，肾功能不全既往规律口服金水宝（外院）"), true);
  assert.equal(contract.isCurrentPositiveTcmAnchor("近2周来无明显诱因出现皮肤黄染，极度乏力，伴恶心、呕吐等消化道症状，既往病史无特殊"), true);
});
await check("1.2 句首「既往」照旧整句判既往（舌脉除外）", () => {
  assert.equal(contract.isCurrentPositiveTcmAnchor("既往有胃病二十余年，每次均因饮食不慎，出现呕吐"), false);
  assert.equal(contract.isCurrentPositiveTcmAnchor("既往有胃病二十余年，每次均因饮食不慎，出现呕吐，舌质淡，脉濡弱"), true);
});
await check("1.3 句中有转归词（已缓解）照旧整句判既往", () => {
  assert.equal(contract.isCurrentPositiveTcmAnchor("胸闷心悸，既往发作时服药后已缓解"), false);
});

// ───── 2 教材条件式加减在定稿过滤里不按主证方向删 ─────
const externalAttackPrior = {
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "diagnose",
  overview: {
    tcmDiseaseName: "呕吐",
    primarySyndrome: "外邪犯胃证",
    primarySyndromeBasis: ["患者昨日夜间加班时受凉，今晨突然呕吐，频频恶心，胸口、胃脘痞闷，怕冷，发热，头痛，全身酸痛"],
    recommendedFormulaDirection: "藿香正气散加减",
  },
  pathogenesis: {
    natureDifferentiation: { items: ["外感风寒", "湿浊中阻"], rootDeficiency: [], branchExcess: ["外感风寒", "湿浊中阻"] },
    locationDifferentiation: { items: ["胃", "表"] },
    chain: [
      { nodeId: "P1", patientFact: "今晨突然呕吐，频频恶心", pathogenesis: "外邪犯胃，胃失和降，气逆于上", syndromeEvidence: "今晨突然呕吐", therapyDirection: "化浊和中，降逆止呕" },
      { nodeId: "P2", patientFact: "怕冷，发热，头痛，全身酸痛", pathogenesis: "风寒束表，卫阳被遏", syndromeEvidence: "怕冷，发热", therapyDirection: "疏邪解表，散寒" },
    ],
  },
  therapy: { overallPrinciple: "实则泻之", overallMethod: "疏邪解表，化浊和中，降逆止呕", subTherapies: [] },
};
const huoxiangPrescription = (modifications) => ({
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "prescribe",
  formula: {
    candidates: [{
      name: "藿香正气散",
      herbs: ["广藿香", "紫苏叶", "白芷", "半夏曲", "厚朴", "陈皮", "大腹皮", "茯苓", "白术", "桔梗", "炙甘草"].map((name) => ({ name, dose: "10g", role: "臣" })),
    }],
    modifications,
  },
});
const textbookRows = [
  { trigger: "若见壮热口渴，便秘尿赤", targetPathogenesis: "外邪入里化热", action: "加", herbName: "黄芩", doseOrHandling: "9g", reason: "清泄里热" },
  { trigger: "若见壮热口渴，便秘尿赤", targetPathogenesis: "外邪入里化热", action: "加", herbName: "黄连", doseOrHandling: "3g", reason: "清热燥湿" },
];
await check("2.1 外邪犯胃证的教材加减（壮热口渴、便秘尿赤加黄芩、黄连）定稿时保留", () => {
  const out = unwrap(modSafety.dropUnsupportedM04ModificationDirections(wrap(huoxiangPrescription(textbookRows)), externalAttackPrior));
  assert.deepEqual(out.formula.modifications.map((item) => item.herbName), ["黄芩", "黄连"]);
});
await check("2.2 对照：所加的药不在那条教材加减里（加石膏），照旧按方向删", () => {
  const rows = [{ ...textbookRows[0], herbName: "石膏", doseOrHandling: "20g", reason: "清热泻火" }];
  const out = unwrap(modSafety.dropUnsupportedM04ModificationDirections(wrap(huoxiangPrescription(rows)), externalAttackPrior));
  assert.deepEqual(out.formula.modifications, []);
});
await check("2.3 定稿过滤与最终合同用同一个导出判据（isTextbookConditionalModification）", () => {
  const source = readFileSync("src/lib/m04-modification-safety.ts", "utf8");
  assert.match(source, /isTextbookConditionalModification\(trigger, fields\.herbName, prior\)/);
  assert.equal(typeof contract.isTextbookConditionalModification, "function");
});

// ───── 3 鉴别「相近之处」只取两者都有的表现 ─────
await check("3.1 补写鉴别的小任务：先写典型表现再写相近之处，相近之处不得把本例特有的表现说成两者共有", () => {
  const source = readFileSync("src/lib/tcm-disease-differential-authoring.server.ts", "utf8");
  for (const name of ["OUTPUT_FORMAT_DISEASE", "OUTPUT_FORMAT_SYNDROME"]) {
    const line = source.split("\n").find((text) => text.startsWith(`const ${name} = `)) || "";
    assert.ok(line.indexOf("typicalManifestation") > 0 && line.indexOf("typicalManifestation") < line.indexOf("reason"), `${name}: ${line}`);
  }
  assert.match(source, /reason：两者相近之处，只写该鉴别病本身就有、本例病历也记录了的表现/);
  assert.match(source, /不得把只属于本例的表现（如本例的特征性皮损、体征）说成两者共有/);
});
await check("3.2 M03 中医鉴别字段同一要求", () => {
  const source = readFileSync("src/lib/diagnosis-prompts.ts", "utf8");
  assert.match(source, /reason 写两者相近之处，只能取该鉴别病\/证候本身就有、本例也记录了的表现/);
});

// ───── 4 孕哺提示从 15 岁起 ─────
const girl = (age, presentIllness = "发热2天，咳嗽，咽痛") => ({
  chiefComplaint: "发热2天",
  patient: { sex: "女", age },
  symptoms: { 现病史: presentIllness },
});
await check("4.1 12 岁、14 岁女孩：月经类提示仍适用，孕哺类提示不写；15 岁起照写", () => {
  for (const age of [12, 14]) {
    assert.equal(safety.reproductiveAdviceRelevant(girl(age)), true, `${age} 岁月经类`);
    assert.equal(safety.pregnancyAdviceRelevant(girl(age)), false, `${age} 岁孕哺类`);
  }
  assert.equal(safety.pregnancyAdviceRelevant(girl(15)), true);
  assert.equal(safety.pregnancyAdviceRelevant(girl(32)), true);
});
await check("4.2 未满 15 岁但病历写到停经、性生活或妊娠的，孕哺提示照写", () => {
  assert.equal(safety.pregnancyAdviceRelevant(girl(14, "停经2个月，恶心")), true);
  assert.equal(safety.pregnancyAdviceRelevant(girl(13, "有性生活史，下腹痛3天")), true);
});
await check("4.3 安全闸门的孕哺筛查不受影响（10 岁起仍追问）", () => {
  assert.equal(safety.pregnancyScreenRequired(girl(12)), true);
  assert.equal(safety.pregnancyScreenRequired(girl(10)), true);
});
await check("4.4 逐味人群提示与复诊信号：pregnancy=false 时去孕哺、留月经类", () => {
  const audience = { reproductive: true, pregnancy: false, ageYears: 13 };
  assert.equal(boundary.herbBoundaryPopulationRelevant("孕期/妊娠", audience), false);
  assert.equal(boundary.herbBoundaryPopulationRelevant("哺乳期", audience), false);
  assert.equal(boundary.followupSignOutsidePopulation("阴道出血", { reproductive: true, pregnancy: false, ageYears: 13 }), false);
  // 缺省 pregnancy 时随 reproductive（此前的调用方不变）。
  assert.equal(boundary.herbBoundaryPopulationRelevant("孕期/妊娠", { reproductive: true, ageYears: 30 }), true);
});

await check("4.5 规则补写的孕哺一条：14 岁女孩不列，15 岁照列；编译器对 14 岁去掉模型写的孕哺句", () => {
  const kinds = (state) => required.requiredPrecautionsForCase(state).map((item) => item.kind);
  assert.equal(kinds(girl(14)).includes("reproductive_status_unknown"), false);
  assert.equal(kinds(girl(15)).includes("reproductive_status_unknown"), true);
  const source = readFileSync("src/lib/m04-proposal-compiler.ts", "utf8");
  assert.match(source, /if \(!pregnancyAdviceRelevant\(caseState\)\) precautions = precautions\.filter\(\(item\) => !REPRODUCTIVE_ADVICE_LINE\.test\(item\)\)/);
});

await check("4.6 针刺卡「如有怀孕可能请先告知医生」同一口径（孕哺状态未明且孕哺提示适用时才写）", () => {
  const source = readFileSync("src/lib/tcm-treatment-capabilities.server.ts", "utf8");
  assert.match(source, /populationCardNote\(definition\.code, patientAgeYears, caseState\?\.patient \? homeCarePregnancyUnresolved\(caseState\) && pregnancyAdviceRelevant\(caseState as CaseState\) : false,/);
});

// ───── 5 注意事项：毒性药名对齐、超出 5 条时的取舍 ─────
const prescriptionWithPrecautions = (herbs, precautions) => ({
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "prescribe",
  formula: {
    candidates: [{
      name: "济生肾气丸加减",
      herbs: herbs.map((name) => ({ name, dose: name === "附子" ? "6g" : "10g", role: "臣", function: "温阳" })),
      decoction: { doseCount: "7剂", method: "水煎服，附子先煎45–60分钟，饭后温服", course: "7日", dosesPerDay: 1, administrationTimesPerDay: 2 },
    }],
    modifications: [],
  },
  nonPharma: { precautions },
});
await check("5.1 模型写「附片有毒」、药表是附子：不再补第二条附子毒性提示", () => {
  const content = wrap(prescriptionWithPrecautions(["附子", "熟地黄", "山药", "茯苓", "泽泻"], [
    "本方宜温服，饭后半小时服用；忌生冷。",
    "方中附片有毒，已先煎久煎，请勿自行加量或延长服用，服后如有口舌麻木、心悸请即告知医生。",
  ]));
  const lines = unwrap(surface.applyDeliveredSurfaceToContent(content)).nonPharma.precautions;
  assert.equal(lines.filter((line) => /附子|附片/.test(line) && /有毒/.test(line)).length, 1, lines.join(" | "));
});
await check("5.2 超过 5 条：去不点名任何药的「如正在服用其他药物请告知医生」；不超时照留", () => {
  const six = [
    "本方汤药宜饭后温服。",
    "忌食生冷寒凉及肥甘厚味，以免损伤中阳。",
    "方中桂枝性温，服后若出现口干、咽痛等不适请及时告知医生。",
    "服药期间注意胃脘部保暖，避免受凉及过度劳累。",
    "如正在服用其他药物，请先告知医生，以免药效重复或相互影响。",
    "注意休息，避免熬夜，保持心情舒畅。",
  ];
  const herbs = ["桂枝", "白芍", "生姜", "大枣", "炙甘草"];
  const capped = unwrap(surface.applyDeliveredSurfaceToContent(wrap(prescriptionWithPrecautions(herbs, six)))).nonPharma.precautions;
  assert.equal(capped.some((line) => /如正在服用其他药物/.test(line)), false, capped.join(" | "));
  const five = unwrap(surface.applyDeliveredSurfaceToContent(wrap(prescriptionWithPrecautions(herbs, six.filter((_, index) => index !== 3))))).nonPharma.precautions;
  assert.equal(five.some((line) => /如正在服用其他药物/.test(line)), true, five.join(" | "));
});
await check("5.3 超过 5 条：第二条起的孕哺提示去掉，第一条留", () => {
  const lines = [
    "备孕期间服药，如月经逾期请先验孕，确认怀孕请立即停药并告知医生。",
    "本方宜温服，饭后半小时服用；忌食肥甘厚腻与甜黏之品。",
    "方中陈皮理气，如已怀孕或备孕请先告知医生。",
    "服药期间如出现胃脘不适加重或腹泻明显，请及时告知医生。",
    "注意保暖，避免熬夜。",
    "饮食宜清淡易消化，少食辛辣油腻。",
  ];
  const out = unwrap(surface.applyDeliveredSurfaceToContent(wrap(prescriptionWithPrecautions(["陈皮", "半夏", "茯苓", "甘草", "白术"], lines)))).nonPharma.precautions;
  assert.equal(out.filter((line) => /孕/.test(line)).length, 1, out.join(" | "));
  assert.match(out.join(""), /备孕期间服药/);
});

// ───── 6 合写节名 ─────
const textbook = await jiti.import("../src/lib/tcm-textbook-syndromes.ts");
const provenance = await jiti.import("../src/lib/tcm-formula-provenance.ts");
const table = JSON.parse(readFileSync("src/data/tcm-textbook-syndrome-formula-table.json", "utf8"));
await check("6.1 教材表：胎漏、胎动不安与堕胎、小产的定义是各自的定义句", () => {
  const def = (name) => table.diseases.find((item) => item.disease === name)?.definition || "";
  assert.match(def("胎漏、胎动不安"), /而无腰酸、腹痛、小腹坠胀者，称为胎漏/);
  assert.match(def("胎漏、胎动不安"), /出现腰酸、腹痛、小腹下坠，或伴有阴道少量流血者，称为“胎动不安”/);
  assert.match(def("堕胎、小产"), /妊娠12周内，胚胎自然殒堕者，为“堕胎”；妊娠12～28周内/);
});
await check("6.2 候选段给出两句定义，并要求合写节名只写相符的那一个", () => {
  const context = textbook.buildTextbookCandidateContext({ chiefComplaint: "停经45天，腰酸、小腹隐痛下坠伴少量阴道出血3天", sex: "女", ageYears: 28, preferredDiseases: ["胎漏、胎动不安"] });
  assert.match(context, /教材定义：[^\n]*称为胎漏[^\n]*称为“胎动不安”/);
  assert.match(context, /节名合写两个病名的（如“胎漏、胎动不安”“堕胎、小产”），病名按该节「教材定义」只写与本例相符的那一个/);
});
await check("6.3 锚定保留模型写的「胎动不安」，不改回节名；写的是别的病名时照旧改成节名", () => {
  const reasoning = (name, rationale) => ({
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
    overview: { tcmDiseaseName: name, primarySyndrome: "肾虚证", tcmDiseaseRationale: rationale, primarySyndromeBasis: ["腰酸"], recommendedFormulaDirection: "寿胎丸加减", tcmDiseaseDifferentials: [] },
    westernDiagnosis: { primary: { name: "先兆流产", supportingFacts: [] }, differentials: [] },
    pathogenesis: { chain: [], locationDifferentiation: { items: ["肾"] }, natureDifferentiation: { items: ["肾虚"] } },
    therapy: { overallPrinciple: "虚则补之", overallMethod: "补肾健脾，益气安胎", subTherapies: [] },
  });
  const kept = provenance.withDeterministicFormulaReferences(reasoning("胎动不安", "以腰酸、小腹下坠为主，属胎动不安；本例腰酸腹痛下坠明显，故不归胎漏。"), "");
  assert.equal(kept.overview.tcmDiseaseName, "胎动不安");
  assert.match(kept.overview.tcmDiseaseRationale, /属胎动不安；/);
  const renamed = provenance.withDeterministicFormulaReferences(reasoning("胎气不安", "属胎气不安。"), "");
  assert.equal(renamed.overview.tcmDiseaseName, "胎漏、胎动不安");
});

console.log(`\n${cases} checks`);
