// 第四十二轮（2026-11-11）：线上盲评 new40 遗留的四类（除方剂目录原方组成外）按根源收口。每条断言都有反证（~/runlogs/r1018/work/r1056/cp/）。
import assert from "node:assert/strict";
import fs from "node:fs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@": `${process.cwd()}/src`,
    "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
  },
});
const check = async (name, run) => {
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
const surface = await jiti.import("../src/lib/delivered-surface.ts");
const processing = await jiti.import("../src/lib/herb-processing-forms.ts");
const textbook = await jiti.import("../src/lib/tcm-textbook-syndromes.ts");
const heart = await jiti.import("../src/lib/true-heart-pain.ts");
const basis = await jiti.import("../src/lib/western-basis-authoring.server.ts");
const points = await jiti.import("../src/lib/m03-disease-points-check.server.ts");
const prompts = await jiti.import("../src/lib/diagnosis-prompts.ts");
const purposeTable = JSON.parse(fs.readFileSync("src/data/tcm-herb-purpose-processing.json", "utf8"));
const textbookRefs = JSON.parse(fs.readFileSync("src/data/tcm-herb-textbook-references.json", "utf8"));

// ─── 2 饮片规格按用途（教材【用法用量】原文） ────────────────────────────────────
await check("2.1 规格表逐条出自《中药学》原文：每条用途句逐字在该药的用法/注意/功效里；半夏、附子、川乌、天南星是内服须炮制的药", () => {
  assert.ok(purposeTable.herbs.length >= 50, `表里只有 ${purposeTable.herbs.length} 味`);
  for (const herb of purposeTable.herbs) {
    const entry = textbookRefs.herbs[herb.herb];
    assert.ok(entry, herb.herb);
    const source = [entry.usage, entry.caution, entry.function].join("｜");
    for (const form of herb.forms) assert.ok(source.includes(form.quote), `${herb.herb}：${form.quote}`);
    if (herb.internalMustProcess) assert.ok(source.includes(herb.internalMustProcess.quote), `${herb.herb}：${herb.internalMustProcess.quote}`);
  }
  const must = new Set(purposeTable.herbs.filter((item) => item.internalMustProcess).map((item) => item.herb));
  for (const herb of ["半夏", "附子", "川乌", "天南星", "白附子"]) assert.ok(must.has(herb), herb);
  const shell = purposeTable.herbs.find((item) => item.herb === "石决明");
  assert.deepEqual(shell.forms.filter((form) => !form.weak).map((form) => form.prefix), [""], "石决明只有「平肝、清肝宜生用」一条内服规格（煅用是外用点眼）");
});

await check("2.2 改规格：煅石决明写的是平肝潜阳 → 石决明（药名带前缀或炮制栏写煅都一样）；写收敛制酸的不改", () => {
  assert.equal(processing.purposeProcessedHerbName("煅石决明", "", "平肝潜阳", 12)?.name, "石决明");
  const column = processing.purposeProcessedHerbName("石决明", "煅", "平肝潜阳", 12);
  assert.equal(column?.name, "石决明");
  assert.equal(column?.prefix, "");
  assert.equal(processing.purposeProcessedHerbName("石决明", "煅", "收敛制酸", 12), undefined);
  assert.equal(processing.purposeProcessedHerbName("牡蛎", "煅", "重镇安神", 20)?.name, "牡蛎");
  assert.equal(processing.purposeProcessedHerbName("牡蛎", "煅", "收敛固涩", 20), undefined);
  // 两字泛词（解毒）不作改规格的依据；「多…用」的倾向性说法（白芍「平抑肝阳…多生用」）不据此改。
  assert.equal(processing.purposeProcessedHerbName("黄芩", "酒", "解毒消肿", 9), undefined);
  assert.equal(processing.purposeProcessedHerbName("白芍", "炒", "平抑肝阳", 10), undefined);
  // 当前规格自己的用途词也写了（煅牡蛎「收敛，重镇安神」）时不改。
  assert.equal(processing.purposeProcessedHerbName("牡蛎", "煅", "收敛，重镇安神", 20), undefined);
});

await check("2.3 内服须炮制：裸写半夏按用途补成法半夏/姜半夏；附子、天南星补成制品；剂量超出制品上限的（川乌 6g，制川乌上限 3g）不改", () => {
  assert.equal(processing.purposeProcessedHerbName("半夏", "", "燥湿化痰，和胃消痞", 9)?.name, "法半夏");
  assert.equal(processing.purposeProcessedHerbName("半夏", "", "降逆止呕", 9)?.name, "姜半夏");
  assert.equal(processing.purposeProcessedHerbName("半夏", "", "", 9)?.name, "法半夏");
  assert.equal(processing.purposeProcessedHerbName("附子", "", "回阳救逆", 9)?.name, "制附子");
  assert.equal(processing.purposeProcessedHerbName("天南星", "", "燥湿化痰", 6)?.name, "制天南星");
  assert.equal(processing.purposeProcessedHerbName("川乌", "", "祛风除湿", 3)?.name, "制川乌");
  assert.equal(processing.purposeProcessedHerbName("川乌", "", "祛风除湿", 6), undefined);
  // 已是炮制品的有毒药不改回生品。
  assert.equal(processing.purposeProcessedHerbName("制附子", "", "回阳救逆", 9), undefined);
  assert.equal(processing.purposeProcessedHerbName("附子", "制", "", 9), undefined);
});

await check("2.4 给无毒的生品加炮制只认这味药自己功效栏里三字以上的整句用途：黄芪「补气固表止汗」不改炙黄芪，牛膝「补肝肾，强筋骨」改酒牛膝", () => {
  assert.equal(processing.purposeProcessedHerbName("黄芪", "", "补气固表止汗", 15), undefined);
  assert.equal(processing.purposeProcessedHerbName("黄芪", "", "益气补中，升阳举陷", 15)?.name, "炙黄芪");
  assert.equal(processing.purposeProcessedHerbName("牛膝", "", "补肝肾，强筋骨", 10)?.name, "酒牛膝");
  assert.equal(processing.purposeProcessedHerbName("牛膝", "", "活血通经，补肝肾", 10), undefined, "生品自己的用途也写了的不加");
  assert.equal(processing.purposeProcessedHerbName("甘草", "", "益气和中", 6), undefined);
  assert.equal(processing.purposeProcessedHerbName("枇杷叶", "", "清肺止咳", 9), undefined, "两字的「止咳」不够给生品加炮制");
  // 第三十七轮那九味仍按旧表（按病历线索加）。
  assert.equal(processing.purposeProcessedHerbName("白术", "", "补气健脾", 10), undefined);
});

await check("2.5 目录调剂名不压过教材用途：四妙丸组成里的「盐黄柏」，功用写清热燥湿时交付黄柏；写滋阴降火、或不给功用时照旧盐黄柏", () => {
  assert.equal(processing.processedHerbName("黄柏", { formulaName: "四妙丸", purposeText: "清热燥湿" }), undefined);
  assert.equal(processing.processedHerbName("黄柏", { formulaName: "四妙丸", purposeText: "滋阴降火" }), "盐黄柏");
  assert.equal(processing.processedHerbName("黄柏", { formulaName: "四妙丸", purposeText: "" }), "盐黄柏");
});

const prescription = (herbs, extra = {}) => ({
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe",
  formula: { candidates: [{ name: extra.name || "天麻钩藤饮加减", herbs, formulaAnalysis: extra.analysis || "", decoction: { method: extra.method || "水煎服", followUpNode: "完成7剂（7日）后复诊" } }], modifications: extra.modifications || [] },
  nonPharma: { precautions: extra.precautions || [] },
});

await check("2.6 交付面：药表、方义、煎服与注意事项里的「煅石决明」随规格改成石决明；裸写的半夏补成法半夏；加减行按理由选姜半夏", () => {
  const out = surface.projectDeliveredReasoning(prescription([
    { name: "天麻", dose: "9g", role: "君", function: "平肝息风" },
    { name: "石决明", processing: "煅", dose: "12g", role: "臣", function: "平肝潜阳" },
    { name: "半夏", dose: "9g", role: "佐", function: "燥湿化痰", isToxic: true },
    { name: "黄芪", dose: "15g", role: "佐", function: "补气固表", targetPathogenesis: "益气补中以助运化" },
    { name: "牡蛎", processing: "煅", dose: "20g", role: "佐", function: "收敛制酸", targetPathogenesis: "重镇安神以助眠" },
  ], {
    analysis: "天麻平肝息风为君；煅石决明平肝潜阳为臣；半夏燥湿化痰。",
    method: "煅石决明先煎30分钟，余药同煎。",
    precautions: ["方中半夏有毒，不可自行加量或久服。"],
    modifications: [{ action: "加", herbName: "半夏", doseOrHandling: "9g", reason: "降逆止呕", evidence: { source: "模型" } }],
  }), { recordText: "主诉：头痛眩晕" });
  const herbs = out.formula.candidates[0].herbs;
  assert.equal(herbs[1].name, "石决明");
  assert.equal(herbs[1].processing, null);
  assert.equal(herbs[2].name, "法半夏");
  assert.equal(herbs[3].name, "黄芪", "病机指向里写的「益气补中」是全方的话，不据此改炙黄芪");
  assert.equal(herbs[4].name, "煅牡蛎", "功效栏写收敛制酸，病机指向里的「重镇安神」不据此改回生牡蛎");
  const ownOnly = surface.projectDeliveredReasoning(prescription([{ name: "石决明", processing: "煅", dose: "12g", role: "佐", function: "收涩止汗", targetPathogenesis: "平肝潜阳以止眩" }]), { recordText: "主诉：眩晕" });
  assert.equal(ownOnly.formula.candidates[0].herbs[0].name, "煅石决明", "功效栏没写平肝，病机指向里的「平肝潜阳」不据此改");
  assert.doesNotMatch(out.formula.candidates[0].formulaAnalysis, /煅石决明/u);
  assert.match(out.formula.candidates[0].formulaAnalysis, /法半夏燥湿化痰/u);
  assert.doesNotMatch(out.formula.candidates[0].decoction.method, /煅石决明/u);
  assert.match(out.nonPharma.precautions[0], /法半夏/u);
  assert.equal(out.formula.modifications[0].herbName, "姜半夏");
  // 再投影一遍逐字不变。
  assert.deepEqual(surface.projectDeliveredReasoning(out, { recordText: "主诉：头痛眩晕" }), out);
});

await check("2.7 命名方原书写了炮制的那一味不按用途改；有毒药不改回生品", () => {
  const out = surface.projectDeliveredReasoning(prescription([
    { name: "甘草", processing: "炙", dose: "6g", role: "使", function: "清热解毒，调和诸药" },
    { name: "附子", processing: "制", dose: "9g", role: "君", function: "回阳救逆", isToxic: true },
  ], { name: "归脾汤加减" }), { recordText: "主诉：心悸" });
  assert.equal(out.formula.candidates[0].herbs[0].name, "炙甘草", "归脾汤原书甘草炙，照原书");
  assert.equal(out.formula.candidates[0].herbs[1].name, "制附子", "内服须炮制的有毒药，炮制栏并进药名");
  const heavy = surface.projectDeliveredReasoning(prescription([{ name: "川乌", processing: "制", dose: "6g", role: "君", function: "祛风除湿", isToxic: true }], { name: "乌头汤加减" }), { recordText: "主诉：关节痛" });
  assert.equal(heavy.formula.candidates[0].herbs[0].name, "川乌", "6g 超出制川乌上限 3g，不并");
});

// ─── 3 复诊「需排除X」与已下的西医诊断对账 ────────────────────────────────────
const liverCase = () => {
  const raw = "患者信息：性别男，年龄58岁\n主诉：腹胀1月\n现病史：腹胀食后甚\n辅助检查：彩超见腹腔积液";
  return types.normalizeCaseStateInput({
    id: "r1056", phase: "collect", patient: { sex: "男", age: 58 }, chiefComplaint: "腹胀1月", symptoms: { presentHistory: "腹胀食后甚", exams: "彩超见腹腔积液" },
    questionRounds: 0, maxQuestionRounds: 1, conversation: [{ role: "user", content: raw }],
    vitals: { temperature: "36.5", pulse: "78", respiration: "18", bloodPressure: "120/76" },
  });
};
const liverFacts = { semanticStatus: "checked", reviewStatus: "single_pass", redFlags: [],
  disposition: { setting: "urgent_specialist", mustNotMiss: [{ condition: "肝硬化失代偿", plausibility: "likely", evidenceQuotes: ["彩超见腹腔积液"], timeWindow: "within_48h" }] } };

await check("3.1 待排除项正是已下的西医诊断（急性细菌性痢疾或侵袭性肠道感染 / 细菌性痢疾）：说已考虑、补做依据里尚缺的检查并评估轻重", () => {
  const target = safety.priorityTargetWithEstablishedDiagnosis({ focus: "急性细菌性痢疾或侵袭性肠道感染", window: "within_48h" },
    { name: "细菌性痢疾", basis: "符合细菌性痢疾表现；尚缺粪培养结果，需粪培养检出志贺菌确认。" });
  assert.equal(safety.priorityEvaluationFirstStep(target, { doses: 5, days: 5 }), "已考虑细菌性痢疾，请在48小时内到相关专科就诊，完成粪培养并评估病情轻重；医生确认可以服药后，服完5剂药（约5天后）再复诊。");
  assert.doesNotMatch(safety.priorityEvaluationFirstStep(target), /需排除/u);
  // 其余待排除项照留。
  const rest = safety.priorityTargetWithEstablishedDiagnosis({ focus: "细菌性痢疾、溶血尿毒综合征", window: "within_48h" }, { name: "细菌性痢疾", basis: "" });
  assert.match(safety.priorityEvaluationFirstStep(rest), /已考虑细菌性痢疾.*评估病情轻重（需排除溶血尿毒综合征）/u);
});

await check("3.2 不对账：主诊断带待查、病名不同、有专门通道（乳房肿块两周）的照旧", () => {
  const acs = { focus: "急性冠脉综合征、主动脉夹层", window: "within_24h" };
  assert.equal(safety.priorityTargetWithEstablishedDiagnosis(acs, { name: "急性冠脉综合征待查" }), acs);
  assert.equal(safety.priorityTargetWithEstablishedDiagnosis(acs, { name: "胃食管反流病" }), acs);
  const breast = { focus: "乳腺癌", window: "within_2w", pathway: "breast_mass" };
  assert.equal(safety.priorityTargetWithEstablishedDiagnosis(breast, { name: "乳腺癌" }), breast);
  assert.equal(safety.priorityTargetWithEstablishedDiagnosis(acs, undefined), acs);
});

await check("3.3 交付面（开方页）：辨证页按旧写法写的「需排除肝硬化失代偿」换成对账后的一句；煎服节点同一份计划；再投影不变", () => {
  const reasoning = {
    ...prescription([{ name: "柴胡", dose: "9g", role: "君", function: "疏肝" }], { name: "柴胡疏肝散加减" }),
    westernDiagnosis: { primary: { name: "乙型肝炎后肝硬化失代偿期", clinicalRationale: "乙肝肝硬化病史明确，彩超见腹腔积液。" } },
    management: { followupSafetyNet: "请在48小时内到相关专科就诊，先完成评估（需排除肝硬化失代偿），再按医生安排服药与复诊。若出现呕血黑便，请立即就医。" },
  };
  reasoning.formula.candidates[0].decoction.followUpAfterDoses = 7;
  reasoning.formula.candidates[0].decoction.followUpAfterDays = 7;
  const options = { recordText: "主诉：腹胀1月", priorityEvaluation: { focus: "肝硬化失代偿", window: "within_48h" } };
  const out = surface.projectDeliveredReasoning(reasoning, options);
  assert.match(out.management.followupSafetyNet, /^已考虑乙型肝炎后肝硬化失代偿期，请在48小时内到相关专科就诊，评估病情轻重；医生确认可以服药后，服完7剂药（约7天后）再复诊。若出现呕血黑便/u);
  assert.doesNotMatch(out.management.followupSafetyNet, /需排除肝硬化失代偿/u);
  assert.match(out.formula.candidates[0].decoction.followUpNode, /^先在48小时内到相关专科评估病情；/u);
  assert.deepEqual(surface.projectDeliveredReasoning(out, options), out);
  // 辨证页同一份计划。
  const diagnose = surface.projectDeliveredReasoning({ schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose", overview: {}, therapy: {},
    westernDiagnosis: { primary: { name: "乙型肝炎后肝硬化失代偿期", clinicalRationale: "彩超见腹腔积液。" } },
    management: { followupSafetyNet: "请服完本次的药后复诊。" } }, options);
  assert.match(diagnose.management.followupSafetyNet, /^已考虑乙型肝炎后肝硬化失代偿期，请在48小时内到相关专科就诊，评估病情轻重，再按医生安排服药与复诊。/u);
});

await check("3.4 M05 首次复诊读已签名的西医主诊断，与开方页同一句", () => {
  const state = { ...liverCase(), clinicalFacts: liverFacts };
  assert.deepEqual(safety.priorityEvaluationFollowupTarget(state), { focus: "肝硬化失代偿", window: "within_48h" });
  state.reasoningDiagnose = { westernDiagnosis: { primary: { name: "乙型肝炎后肝硬化失代偿期", clinicalRationale: "彩超见腹腔积液。" } } };
  assert.match(safety.patientFacingFirstReview(state, false), /^已考虑乙型肝炎后肝硬化失代偿期，请在48小时内到相关专科就诊，评估病情轻重/u);
  state.reasoningDiagnose = { westernDiagnosis: { primary: { name: "腹水待查" } } };
  assert.match(safety.patientFacingFirstReview(state, false), /需排除肝硬化失代偿/u);
});

// ─── 4a 西医病名的确立程度 ────────────────────────────────────────────────────
const western = (name, rationale) => JSON.stringify({ westernDiagnosis: { primary: { name, clinicalRationale: rationale }, candidates: [{ name, likelihood: "高", keyEvidence: [], againstEvidence: [] }], differentials: [] } });
const proposal = (established, level = "病程未满6个月，尚不能确诊") => ({ summary: "", criteria: [], negatives: [], established, level, exclude: [], text: "" });

await check("4.1 依据提纲答「尚未确立」、另一家确认：病名改「X待查」，候选首位同名，推理说明「符合X」改「考虑X可能」", async () => {
  let asked = 0;
  const confirm = async () => { asked += 1; return true; };
  const out = JSON.parse(await basis.withEstablishmentDowngrade(western("功能性消化不良", "上腹嘈杂3月，符合功能性消化不良；病程未满6个月，尚不能确诊。"), "功能性消化不良", proposal("no"), { recordText: "上腹嘈杂3月", establishmentConfirm: confirm }));
  assert.equal(asked, 1);
  assert.equal(out.westernDiagnosis.primary.name, "功能性消化不良待查");
  assert.equal(out.westernDiagnosis.candidates[0].name, "功能性消化不良待查");
  assert.match(out.westernDiagnosis.primary.clinicalRationale, /考虑功能性消化不良可能/u);
  assert.doesNotMatch(out.westernDiagnosis.primary.clinicalRationale, /符合功能性消化不良/u);
});

await check("4.2 不改也不发请求：提纲答已确立、已带待查、病历写明既往已确诊、要点表可凭临床诊断；另一家不认的不改", async () => {
  let asked = 0;
  const counted = async () => { asked += 1; return true; };
  const content = western("功能性消化不良", "符合功能性消化不良。");
  assert.equal(await basis.withEstablishmentDowngrade(content, "功能性消化不良", proposal("yes"), { recordText: "x", establishmentConfirm: counted }), content);
  const pending = western("功能性消化不良待查", "");
  assert.equal(await basis.withEstablishmentDowngrade(pending, "功能性消化不良待查", proposal("no"), { recordText: "x", establishmentConfirm: counted }), pending);
  const stated = western("慢性乙型肝炎", "");
  assert.equal(await basis.withEstablishmentDowngrade(stated, "慢性乙型肝炎", proposal("no"), { recordText: "既往史：慢性乙型肝炎10年，规律服用恩替卡韦。", establishmentConfirm: counted }), stated);
  // 四类之内（功能性、有病程门槛、理由说病程），但病历写明既往已确诊：不问。
  const fd = western("功能性消化不良", "");
  assert.equal(await basis.withEstablishmentDowngrade(fd, "功能性消化不良", proposal("no", "病程未满6个月"), { recordText: "既往史：功能性消化不良5年，胃镜未见异常。", establishmentConfirm: counted }), fd);
  const urti = western("急性上呼吸道感染", "");
  assert.equal(await basis.withEstablishmentDowngrade(urti, "急性上呼吸道感染", proposal("no"), { recordText: "咽痛2天", establishmentConfirm: counted }), urti);
  assert.equal(asked, 0);
  assert.equal(await basis.withEstablishmentDowngrade(content, "功能性消化不良", proposal("no"), { recordText: "x", establishmentConfirm: async () => false }), content);
});

await check("4.2a 只问四类病名：要点表要求检查且病历一项都没有（典型症状＋空腹血糖 9.8 的 2 型糖尿病不问）；有病程门槛且理由说的是病程；急危重病名；排除性诊断", async () => {
  const entry = (name) => basis.westernBasisCriteriaEntry(name);
  assert.equal(basis.establishmentQuestionable("2型糖尿病", entry("2型糖尿病"), "尚缺规范血糖检测", "口渴多饮消瘦半年，社区空腹血糖9.8mmol/L"), false);
  assert.equal(basis.establishmentQuestionable("2型糖尿病", entry("2型糖尿病"), "尚缺血糖检测", "口渴多饮消瘦半年"), true);
  assert.equal(basis.establishmentQuestionable("焦虑障碍", entry("焦虑障碍"), "尚缺甲状腺功能检查", "紧张担忧1月余"), false);
  assert.equal(basis.establishmentQuestionable("焦虑障碍", entry("焦虑障碍"), "病程仅1月余，未达6个月门槛", "紧张担忧1月余"), true);
  assert.equal(basis.establishmentQuestionable("化脓性脑膜炎", entry("化脓性脑膜炎"), "尚缺脑脊液检查", "发热"), true);
  assert.equal(basis.establishmentQuestionable("胃肠神经官能症", undefined, "需排除器质性疾病", "腹胀"), true);
  assert.equal(basis.establishmentQuestionable("急性鼻窦炎", entry("急性鼻窦炎"), "尚缺鼻窦CT", "流脓涕4周"), false);
});

await check("4.2b 依据写作接上确立程度核对：成句没过核对（保留模型原句）时，提纲答尚未确立仍改病名", async () => {
  const authored = { name: "化脓性脑膜炎", proposal: { ...proposal("no", "尚缺脑脊液检查"), text: "太短" } };
  const out = JSON.parse(await basis.withAuthoredWesternBasis(western("化脓性脑膜炎", "高热、颈项抵抗，支持化脓性脑膜炎。"), { recordText: "发热2天，颈项抵抗阳性", chiefComplaint: "发热2天", establishmentConfirm: async () => true }, Promise.resolve(authored)));
  assert.equal(out.westernDiagnosis.primary.name, "化脓性脑膜炎待查");
  assert.match(out.westernDiagnosis.primary.clinicalRationale, /考虑化脓性脑膜炎可能/u);
});

await check("4.3 提纲解析出 established；提示词按推理顺序在 level 之前问它", () => {
  const parsed = basis.parseWesternBasisProposal(JSON.stringify({ text: "x", established: "no", level: "尚缺脑脊液检查" }));
  assert.equal(parsed.established, "no");
  assert.equal(basis.parseWesternBasisProposal(JSON.stringify({ text: "x" })).established, "");
  const source = fs.readFileSync("src/lib/western-basis-authoring.server.ts", "utf8");
  assert.ok(source.indexOf("4. established") > 0 && source.indexOf("4. established") < source.indexOf("5. level"));
});

// ─── 4b 中医病名对教材诊断要点 ────────────────────────────────────────────────
const HEMORRHOID_RECORD = "主诉：便血3天\n现病史：饮酒后大便带血，血色鲜红偏暗、与大便相混，质黏稠，便质稀而排出不爽。\n体格检查：肛门外观未见外痔及裂口，患者暂拒绝直肠指诊。";
const pointsInput = { disease: "内痔", recordText: HEMORRHOID_RECORD, chiefComplaint: "便血3天", candidates: ["血证", "痢疾", "内痔"] };

await check("4.4 核对缺省开（离线量过）；CDSS_M03_DISEASE_POINTS_CHECK=false 关；内痔有教材诊断要点可核", () => {
  const before = process.env.CDSS_M03_DISEASE_POINTS_CHECK;
  delete process.env.CDSS_M03_DISEASE_POINTS_CHECK;
  assert.equal(points.diseasePointsCheckApplies(pointsInput), true);
  process.env.CDSS_M03_DISEASE_POINTS_CHECK = "false";
  assert.equal(points.diseasePointsCheckApplies(pointsInput), false);
  assert.ok(textbook.textbookDiseaseDiagnosisPoints("内痔").points.some((point) => point.includes("血液与大便不相混合")));
  if (before === undefined) delete process.env.CDSS_M03_DISEASE_POINTS_CHECK; else process.env.CDSS_M03_DISEASE_POINTS_CHECK = before;
});

await check("4.5 提名的服务端核对：要点逐字出自教材要点，病历原文逐字出自病历且是问到了的本人记载，更合适的病在候选里且不是原病名", () => {
  const ok = { verdict: "mismatch", kind: "contradicted", point: "血液与大便不相混合", recordQuote: "与大便相混", better: "血证", reason: "血与便相混" };
  assert.equal(points.parseDiseasePointsProposal(JSON.stringify(ok), pointsInput)?.better, "血证");
  assert.equal(points.parseDiseasePointsProposal(JSON.stringify({ ...ok, point: "血液与大便混合不清" }), pointsInput), undefined, "要点不在教材里");
  assert.equal(points.parseDiseasePointsProposal(JSON.stringify({ ...ok, recordQuote: "大便鲜血滴出" }), pointsInput), undefined, "病历没有这句");
  // 他人的、尚未询问的记载不算病历证据。
  const otherPerson = { ...pointsInput, recordText: `${HEMORRHOID_RECORD}\n家族史：父亲大便带血，与大便相混。` };
  assert.ok(points.parseDiseasePointsProposal(JSON.stringify(ok), otherPerson));
  assert.equal(points.parseDiseasePointsProposal(JSON.stringify({ ...ok, recordQuote: "是否黑便尚未询问" }), { ...pointsInput, recordText: `${HEMORRHOID_RECORD}\n是否黑便尚未询问` }), undefined, "尚未询问的不算");
  assert.equal(points.parseDiseasePointsProposal(JSON.stringify({ ...ok, better: "肠风" }), pointsInput), undefined, "不在候选里");
  // 相反（contradicted）时可以不点名；缺体征（missing_sign）必须点名。分型写法「血证（便血）」认作候选里的血证。
  assert.equal(points.parseDiseasePointsProposal(JSON.stringify({ ...ok, better: null }), pointsInput)?.better, "");
  assert.equal(points.parseDiseasePointsProposal(JSON.stringify({ ...ok, kind: "missing_sign", recordQuote: "患者暂拒绝直肠指诊", better: null }), pointsInput), undefined);
  // 缺体征只认写体征或检查所见的要点：「专科检查指诊可触及…」算，「以…为主要症状」不算。
  assert.equal(points.parseDiseasePointsProposal(JSON.stringify({ ...ok, kind: "missing_sign", point: "专科检查指诊可触及柔软、表面光滑、无压痛的黏膜隆起", recordQuote: "患者暂拒绝直肠指诊" }), pointsInput)?.better, "血证");
  assert.equal(points.parseDiseasePointsProposal(JSON.stringify({ ...ok, kind: "missing_sign", point: "临床表现初期常以无痛性便血为主要症状", recordQuote: "患者暂拒绝直肠指诊" }), pointsInput), undefined);
  assert.equal(points.parseDiseasePointsProposal(JSON.stringify({ ...ok, better: "血证（便血）" }), pointsInput)?.better, "血证");
  assert.doesNotMatch(points.diseasePointsRedrawInstruction("内痔", { status: "mismatch", kind: "contradicted", point: "血液与大便不相混合", recordQuote: "与大便相混", better: "", reason: "" }), /（如「」）/u);
  assert.equal(points.parseDiseasePointsProposal(JSON.stringify({ ...ok, better: "内痔" }), pointsInput), undefined);
  assert.equal(points.parseDiseasePointsProposal(JSON.stringify({ verdict: "fits" }), pointsInput), undefined);
  assert.match(points.diseasePointsRedrawInstruction("内痔", { status: "mismatch", ...points.parseDiseasePointsProposal(JSON.stringify(ok), pointsInput) }), /病历「与大便相混」与教材内痔的诊断要点「血液与大便不相混合」相反/u);
});

// ─── 4c 真心痛 ────────────────────────────────────────────────────────────────
const M39 = "主诉：胸骨后压榨样疼痛1小时\n现病史：搬重物后突发胸骨后压榨样疼痛，向左肩放射，持续不缓解，伴大汗淋漓、恶心，自含速效救心丸10粒无明显缓解。\n体格检查：面色苍白，皮肤湿冷";
const CARDIAC_FLAG = ["胸痛/胸闷伴大汗、放射痛或气促，需排除急性心血管事件"];

await check("4.6 真心痛成了教材病：七个证型行出自《中西医结合内科学》心肌梗死节（逐行号），心阳欲脱证回阳救逆；选病闭集有它", () => {
  const rows = ["气滞血瘀证", "寒凝心脉证", "痰瘀互结证", "气虚血瘀证", "气阴两虚证", "阳虚水泛证", "心阳欲脱证"].map((name) => textbook.textbookRowForSyndrome("真心痛", name));
  assert.ok(rows.every(Boolean));
  assert.equal(rows[6].therapy, "回阳救逆，益气固脱");
  const supplement = JSON.parse(fs.readFileSync("src/data/tcm-textbook-syndrome-supplement.source.json", "utf8"));
  const lines = supplement.rows.filter((row) => row.disease === "真心痛").map((row) => row.line);
  assert.equal(lines.length, 7);
  assert.ok(lines.every((line) => line >= 130534 && line <= 130561), JSON.stringify(lines));
  assert.ok(textbook.textbookDiseaseNamesForCase({ sex: "男", ageYears: 63 }).includes("真心痛"));
});

await check("4.7 真心痛排在选病首位的判据：胸痛＋持续不缓解＋汗出肢冷一类危候都是本人未否认的记载，且安全门有急性心血管事件红旗", () => {
  assert.ok(heart.trueHeartPainSignal(M39, CARDIAC_FLAG));
  assert.equal(heart.trueHeartPainSignal(M39, []), undefined);
  assert.equal(heart.trueHeartPainSignal("反复胸闷胸痛2年，每次持续数分钟，休息后可缓解，面色红润。", CARDIAC_FLAG), undefined);
  assert.equal(heart.trueHeartPainSignal("胸痛3小时，持续不缓解，无大汗，无面色苍白，无冷汗。", CARDIAC_FLAG), undefined);
  assert.equal(heart.trueHeartPainSignal("胸痛3小时，伴大汗淋漓，含服后缓解。", CARDIAC_FLAG), undefined);
  assert.deepEqual(heart.withTrueHeartPainFirst(["胸痹", "真心痛"], heart.trueHeartPainSignal(M39, CARDIAC_FLAG)), ["真心痛", "胸痹"]);
  assert.deepEqual(heart.withTrueHeartPainFirst([], heart.trueHeartPainSignal(M39, CARDIAC_FLAG)), []);
});

await check("4.8 M03 提示词：真心痛排在教材候选最前、附说明段；稳定型胸闷不附", () => {
  // 线上盲评 new40 m39 的病历（甲方接口形状）。
  const state = types.normalizeCaseStateInput({ chiefComplaint: "胸骨后压榨样疼痛1小时", patient: { sex: "男", age: 63 }, conversation: [], tongue: "舌质紫暗，苔薄白", pulse: "脉弦细",
    symptoms: { 现病史: "患者1小时前搬重物后突发胸骨后压榨样疼痛，范围约手掌大小，向左肩及左上臂内侧放射，持续不缓解，伴大汗淋漓、恶心、乏力，自含“速效救心丸”10粒无明显缓解。近1周偶于上楼时出现胸闷，休息数分钟可缓解，未就医。无咯血，无腹痛，无肢体无力及言语不清，无晕厥。", 体格检查: "神清，痛苦面容，面色苍白，皮肤湿冷" },
    vitals: { T: "36.5", P: "104", R: "22", BP: "150/92" } });
  assert.equal(safety.evaluateSafetyGate(state).status, "red_flag");
  const prompt = prompts.buildDiagnosePrompt(state, { textbookDiseasePicks: ["胸痹"] });
  assert.match(prompt, /【真心痛与胸痹】/u);
  const candidates = prompt.slice(prompt.indexOf("【教材病证候选】"));
  assert.ok(candidates.indexOf("真心痛") >= 0 && candidates.indexOf("真心痛") < candidates.indexOf("胸痹"));
  const stable = types.normalizeCaseStateInput({ chiefComplaint: "反复胸闷2年", symptoms: { presentHistory: "活动后胸闷，休息数分钟可缓解。" }, conversation: [], patient: { sex: "男", age: 63 }, vitals: { T: "36.5", P: "76", R: "18", BP: "130/80" } });
  assert.doesNotMatch(prompts.buildDiagnosePrompt(stable, { textbookDiseasePicks: ["胸痹"] }), /【真心痛与胸痹】/u);
});
