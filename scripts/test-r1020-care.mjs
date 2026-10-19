// 10/19 第八轮·WP-E（2026-10-19 晚）：治疗卡、调护、复诊随访里第七轮评审（qwen3.8-max / Claude）报出的服务端缺陷。
//
// 每条断言都带对照（不该变的输入保持不变）；反证记录在 ~/runlogs/r1018/work/r1019/counterproofs.txt（前缀 8/care/）。
// 回放材料：~/runlogs/r1018/work/r1020/wpE（replay-e.mjs、scan.py）。
//
//   1 针刺卡「本例属X」的型以已签名的辨病/辨证依据为准（留出例 S067：依据写「故属石淋湿热蕴结证」，卡写「本例属热淋」）
//   2 卡片「针对本例X」的 X 只取病历里写到的、或已签名的中医病名，不取西医主诊断与模型写的病机里的词（M-RobustSDT-0442 积证卡「针对本例功能性消化不良」）
//   3 食疗/饮食与处方药味相冲（人参—莱菔子/萝卜/茶叶、十八反十九畏）：食疗方不选、饮食栏与食疗卡不推荐（M-MTCMB-11 莱菔粥）
//   4 复诊提示、M05 急症表现里的月经/孕哺项目按本例人群收口（M-RobustSDT-0516：61 岁女性「月经量骤增」）
//   5 医嘱禁食时饮食段不再推荐吃什么、食疗卡不出（M-TCMChat-test-374「禁食并暂缓经口进食」对「可选小米粥、蒸蛋」）
//   6 在用抗凝/抗血小板药时饮食段、食疗卡不推荐活血类药食同源品（M-MTCMB-7 阿司匹林与「适量吃山楂、桃仁」）
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";

process.env.TCM_CLINIC_TREATMENT_CAPABILITIES = "acupuncture,auricular,moxibustion,cupping,tuina,diet_therapy";
delete process.env.TCM_CLINIC_TREATMENT_CAPABILITIES_JSON;
// 4.4 要经真正的 M05 作文入口走一遍（假模型回复），与 test-m05-prefetch-request-compression 同一套桩。
Object.assign(process.env, {
  AI_TEXT_PROVIDER: "openai-compatible",
  OPENAI_API_KEY: "test-only-placeholder",
  OPENAI_BASE_URL: "https://api.deepseek.com",
  OPENAI_MODEL: "deepseek-flash",
  CONTROLLED_TERMINOLOGY_MODEL: "deepseek-flash",
});
delete process.env.M05_FOLLOWUP_AUTHORING;
for (const key of ["BAILIAN_QWEN_API_KEY", "DASHSCOPE_API_KEY", "QWEN_API_KEY"]) delete process.env[key];

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

const plan = await jiti.import("../src/lib/tcm-nondrug-textbook-plan.server.ts");
const cap = await jiti.import("../src/lib/tcm-treatment-capabilities.server.ts");
const surface = await jiti.import("../src/lib/delivered-surface.ts");
const boundary = await jiti.import("../src/lib/candidate-boundary-text.ts");
const m05 = await jiti.import("../src/lib/m05-followup-authoring.server.ts");
const types = await jiti.import("../src/lib/diagnosis-types.ts");
const precautions = await jiti.import("../src/lib/required-precautions.server.ts");

const acupuncture = (input) => plan.textbookTreatmentPlan({ projectCode: "acupuncture", westernNames: [], signedSyndromeText: "", currentFacts: "", ...input });
const names = (result) => (result?.points || []).map((point) => point.name);
const signedPrior = (disease, syndromeText, fact, western = disease, overviewExtra = {}) => ({
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
  contractSignatureVersion: "tcm-cdss-m03-signature-v5", contractSignature: `hmac-sha256:${"a".repeat(64)}`,
  overview: { tcmDiseaseName: disease, primarySyndrome: syndromeText, secondarySyndromes: [], primarySyndromeResolution: "resolved", primarySyndromeBasis: [], overallPathogenesis: fact, ...overviewExtra },
  westernDiagnosis: { primary: { name: western, supportingFacts: [] } },
  therapy: { overallPrinciple: "", overallMethod: "", subTherapies: [], },
  pathogenesis: { chain: [{ nodeId: "P1", patientFact: fact, syndromeEvidence: syndromeText, pathogenesis: fact, therapyDirection: "" }], uncertainties: [], natureDifferentiation: { items: [] } },
});
const compile = (prior, chief, present, proposals, patient = { sex: "男", age: 45 }, dietAdvice = "", herbs = [], precautionText = "") => cap.compileTcmTreatmentRecommendations(
  proposals, prior, { chiefComplaint: chief, symptoms: { 现病史: present }, patient, safetyGate: { status: "ready", redFlags: [] } }, dietAdvice, herbs, precautionText);
const card = (cards, code) => cards.find((item) => item.projectCode === code);

// ── 1 针刺卡的型以已签名依据为准 ────────────────────────────────────────────────
const STONE_FACTS = "右侧腰腹疼痛伴排尿涩痛，向会阴放射，排尿时尿到一半突然中断，今晨尿中见细小砂粒样物1粒，尿色淡红，小腹拘急";
const STONE_RATIONALE = "腰腹绞痛放射会阴、排尿涩痛中断、尿见砂粒，为湿热煎熬尿液成石、砂石阻络，故属石淋湿热蕴结证；与热淋相鉴别：无发热寒战";

await check("1.1 病名淋证、证名湿热蕴结证，辨证依据写「故属石淋」：按石淋加秩边、水道、委阳，不写「本例属热淋，加委中、行间」（S067）；没有依据时仍按证名对热淋（对照）", () => {
  const stone = acupuncture({ diseaseNames: ["淋证"], signedSyndromeText: "湿热蕴结证", currentFacts: STONE_FACTS, signedRationale: STONE_RATIONALE });
  assert.match(stone.treatmentContent, /本例属石淋，在主穴基础上加秩边、水道、委阳/u, stone.treatmentContent);
  assert.ok(!names(stone).includes("委中") && !names(stone).includes("行间"), JSON.stringify(names(stone)));
  const noRationale = acupuncture({ diseaseNames: ["淋证"], signedSyndromeText: "湿热蕴结证", currentFacts: STONE_FACTS });
  assert.match(noRationale.treatmentContent, /本例属热淋/u, noRationale.treatmentContent);
});

await check("1.2 依据里只是拿石淋作鉴别（「与石淋相鉴别」「非石淋」「不属石淋」）不算肯定：仍按证名对热淋；依据肯定写热淋时按热淋（对照）", () => {
  for (const rationale of ["小便灼热刺痛，尿色黄赤，与石淋相鉴别：无砂石排出", "小便灼热刺痛，非石淋", "小便灼热刺痛，不属石淋", "小便灼热刺痛，故属热淋"]) {
    const heat = acupuncture({ diseaseNames: ["淋证"], signedSyndromeText: "湿热蕴结证", currentFacts: "小便短数，灼热刺痛，尿色黄赤", signedRationale: rationale });
    assert.match(heat.treatmentContent, /本例属热淋，在主穴基础上加委中、行间/u, `${rationale} → ${heat.treatmentContent}`);
  }
});

await check("1.3 证名点到的型不被依据里顺带提到的型换掉：证名写「热淋」、依据写「为石淋之象，待影像明确」仍写「本例属热淋」；证名没点到型（湿热蕴结证）才跟依据写明的石淋（对照）", () => {
  const facts = "小便短数，灼热刺痛，尿色黄赤，尿中偶见细小砂粒样物";
  const rationale = "排尿灼热刺痛，尿中偶见砂粒，为石淋之象，待影像检查明确";
  const named = acupuncture({ diseaseNames: ["淋证"], signedSyndromeText: "热淋", currentFacts: facts, signedRationale: rationale });
  assert.match(named.treatmentContent, /本例属热淋/u, named.treatmentContent);
  assert.ok(!names(named).includes("秩边"), JSON.stringify(names(named)));
  const unnamed = acupuncture({ diseaseNames: ["淋证"], signedSyndromeText: "湿热蕴结证", currentFacts: facts, signedRationale: rationale });
  assert.match(unnamed.treatmentContent, /本例属石淋/u, unnamed.treatmentContent);
});

await check("1.5 带病性概念的型不跟依据里的病机叙述走：同一病历有无依据，卡上「本例属X」逐字相同（遗尿·下元虚寒证的「遗尿为肾气不足」不写成「本例属肾气不足」；首版回放 25 张卡的型被依据里的病机词换掉）", () => {
  for (const input of [
    { diseaseNames: ["遗尿"], signedSyndromeText: "下元虚寒证", currentFacts: "夜间遗尿，睡中不易唤醒，小便清长，畏寒肢冷", signedRationale: "遗尿为肾气不足、膀胱失约，下元虚寒，故属下元虚寒证" },
    { diseaseNames: ["感冒"], signedSyndromeText: "暑湿伤表证", currentFacts: "夏季发热，汗出热不解，头重如裹，胸闷", signedRationale: "暑湿之邪伤表，为夹湿之象，故属暑湿伤表证" },
    { diseaseNames: ["咳嗽"], signedSyndromeText: "肺阴亏虚证", currentFacts: "干咳少痰，咽喉干痒，午后潮热", signedRationale: "肺阴不足，虚热内扰，为肺阴亏耗，故属肺阴亏虚证" },
  ]) {
    const bare = { ...input };
    delete bare.signedRationale;
    const withRationale = acupuncture(input);
    const without = acupuncture(bare);
    assert.equal(withRationale.treatmentContent, without.treatmentContent, `${input.signedSyndromeText}: ${withRationale.treatmentContent} ≠ ${without.treatmentContent}`);
    assert.deepEqual(names(withRationale), names(without));
  }
  const enuresis = acupuncture({ diseaseNames: ["遗尿"], signedSyndromeText: "下元虚寒证", currentFacts: "夜间遗尿，睡中不易唤醒，小便清长，畏寒肢冷", signedRationale: "遗尿为肾气不足、膀胱失约，下元虚寒，故属下元虚寒证" });
  assert.doesNotMatch(enuresis.treatmentContent, /本例属肾气不足/u, enuresis.treatmentContent);
});

await check("1.6 型名要紧跟在「属/为」后：依据写「为风寒之邪袭于太阳经输…故属痛痹」是病机叙述，卡上不改成「本例属太阳经证」（回放 H 集 X-H-0230）；同一病历有无依据，针刺卡逐字相同", () => {
  const input = { diseaseNames: ["痹证"], westernNames: ["急性颈肌筋膜炎"], signedSyndromeText: "痛痹", currentFacts: "夜吹风扇后晨起颈背部强痛，低头加重，并向同侧肩部放射" };
  const withRationale = acupuncture({ ...input, signedRationale: "夜吹风扇后晨起颈背强痛、低头加重并放射至肩，为风寒之邪袭于太阳经输、经气痹阻、筋脉拘急，故属痛痹；痛有定处、遇寒而发" });
  assert.doesNotMatch(withRationale.treatmentContent, /太阳经证/u, withRationale.treatmentContent);
  assert.equal(withRationale.treatmentContent, acupuncture(input).treatmentContent);
  // 型名紧跟在「为」后才算：水肿「属阴水范畴」（X-C-0217 形状）按阴水取。
  const edema = acupuncture({ diseaseNames: ["水肿"], signedSyndromeText: "脾肾两虚证", currentFacts: "反复浮肿月余，腰腹下肢肿甚，畏寒肢冷，神疲乏力，小便短少，纳少便溏", signedRationale: "患儿反复浮肿月余，以腰腹下肢为甚，属阴水范畴，归入水肿" });
  assert.match(edema.treatmentContent, /本例属阴水，在主穴基础上加/u, edema.treatmentContent);
});

await check("1.4 整条链：辨证依据写石淋时，针刺卡取石淋的穴（compile，S067 形状）；依据没写石淋的同一病历仍是热淋（对照）", () => {
  const proposals = [{ projectCode: "acupuncture", targetRef: "P1" }];
  const withRationale = card(compile(signedPrior("淋证", "湿热蕴结证", "湿热蕴结下焦，砂石阻滞", "右输尿管下段结石", { tcmDiagnosticRationale: STONE_RATIONALE }), "右侧腰腹疼痛伴排尿涩痛3天", STONE_FACTS, proposals), "acupuncture");
  assert.match(withRationale.treatmentContent, /本例属石淋/u, withRationale.treatmentContent);
  assert.doesNotMatch(withRationale.treatmentContent, /本例属热淋/u);
  const without = card(compile(signedPrior("淋证", "湿热蕴结证", "湿热蕴结下焦，砂石阻滞", "右输尿管下段结石", { tcmDiagnosticRationale: "湿热蕴结下焦，故属湿热蕴结证" }), "右侧腰腹疼痛伴排尿涩痛3天", STONE_FACTS, proposals), "acupuncture");
  assert.match(without.treatmentContent, /本例属热淋/u, without.treatmentContent);
});

// ── 2 针对本例X ───────────────────────────────────────────────────────────────
await check("2.1 积证的针刺卡不写「针对本例功能性消化不良」（西医主诊断名不是本例的表现）；病历自己写了消化不良时照写（对照）", () => {
  const proposals = [{ projectCode: "acupuncture", targetRef: "P1" }];
  const record = "半年前因家庭纠纷后出现胁肋胀满、腹部隐痛，自述腹部有柔软包块，按之可移动，伴有食欲不振，大便溏薄";
  const prior = signedPrior("积证", "气滞血阻证", "肝失疏泄，气机郁滞，气滞血行不畅", "功能性消化不良");
  const out = card(compile(prior, "胁肋胀满、腹部隐痛，腹部有柔软包块", record, proposals), "acupuncture");
  assert.ok(out, "积证应出针刺卡");
  assert.doesNotMatch(out.treatmentContent, /功能性消化不良/u, out.treatmentContent);
  assert.doesNotMatch(out.treatmentContent, /针对本例/u, out.treatmentContent);
  const control = card(compile(prior, "胁肋胀满、腹部隐痛，腹部有柔软包块", `${record}，消化不良`, proposals), "acupuncture");
  assert.match(control.treatmentContent, /针对本例[^。]*消化不良/u, control.treatmentContent);
});

// ── 3 食物与处方药味相冲 ───────────────────────────────────────────────────────
const scope = (herbNames) => ({ names: herbNames, has: (herb) => herbNames.includes(herb) });

await check("3.1 人参方里的莱菔粥（莱菔子）、萝卜、茶叶相冲；胡萝卜不是萝卜；无人参的方、茯苓配莱菔子不冲（对照）；十八反十九畏走知识库配伍规则（川贝母配附子、丁香配郁金）", () => {
  const renshen = scope(["人参", "茯苓"]);
  for (const text of ["莱菔粥：莱菔子30g煎汁，入粳米50g煮粥", "可用萝卜煲汤", "绿茶代饮"]) assert.equal(plan.textAntagonizesPrescription(text, renshen), true, text);
  assert.equal(plan.textAntagonizesPrescription("胡萝卜炖牛肉", renshen), false);
  assert.equal(plan.textAntagonizesPrescription("莱菔粥：莱菔子30g煎汁，入粳米50g煮粥", scope(["茯苓", "半夏"])), false);
  assert.equal(plan.textAntagonizesPrescription("川贝母炖梨", scope(["附子", "茯苓"])), true);
  assert.equal(plan.textAntagonizesPrescription("丁香煮梨", scope(["郁金"])), true);
  assert.equal(plan.textAntagonizesPrescription("川贝母炖梨", scope(["茯苓"])), false);
});

const dietCard = (herbNames) => plan.textbookTreatmentPlan({
  projectCode: "diet_therapy", diseaseNames: ["胸痹"], westernNames: [], signedSyndromeText: "痰浊闭阻证", currentFacts: "胸闷胸痛",
  herbAlreadyPrescribed: (herb) => herbNames.includes(herb), prescribedHerbNames: herbNames,
});
await check("3.2 食疗方选取：胸痹·痰浊闭阻的教材食疗方是莱菔粥，处方有人参时不选（没有别的方就不出卡）；处方无人参时照选（对照）", () => {
  assert.equal(dietCard(["人参", "半夏"]), undefined);
  assert.match(dietCard(["半夏", "茯苓"]).treatmentContent, /莱菔粥/u);
});

const rx = ({ herbs = ["半夏", "茯苓"], modifications = [], diet = "", precautions = [], cards = [], extra = {}, management } = {}) => ({
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe", overview: {},
  formula: {
    candidates: [{ name: "x", formulaAnalysis: "x", herbs: herbs.map((name) => ({ name, role: "臣", function: "x", dose: "10g" })), decoction: { method: "水煎服，分2次饭后温服" } }],
    modifications, patentAndWestern: [],
  },
  nonPharma: { diet, precautions, lifestyle: "", exercise: "", emotion: "", acupointCare: null, tcmTreatments: cards, ...extra },
  ...(management ? { management } : {}),
});
const dietCardItem = (content) => ({ projectCode: "diet_therapy", projectName: "食疗", treatmentContent: content, suggestedSitesOrPoints: [], scheduleSuggestion: "空腹食用。", techniqueBoundary: "仅作饮食调养，不替代药物治疗。" });
const projectDiet = (reasoning, options) => surface.projectDeliveredReasoning(reasoning, options).nonPharma;

await check("3.3 交付面：人参方的饮食栏去掉推荐萝卜的那一小句、食疗卡（莱菔粥）不交付，别的食物与忌口照留；无人参、胡萝卜、写「忌萝卜」时不动（对照）", () => {
  const diet = "饮食清淡，可用萝卜煮汤，陈皮泡水代茶，忌生冷。";
  const out = projectDiet(rx({ herbs: ["人参", "半夏"], diet, cards: [dietCardItem("食疗原则：豁痰宣痹。痰浊闭阻：莱菔粥：莱菔子30g煎汁，入粳米50g煮粥。")] }));
  assert.doesNotMatch(out.diet, /萝卜/u, out.diet);
  assert.match(out.diet, /陈皮泡水代茶/u);
  assert.match(out.diet, /忌生冷/u);
  assert.equal(out.tcmTreatments.length, 0);
  // 随证加减拟加的人参同算。
  const viaModification = projectDiet(rx({ herbs: ["半夏"], modifications: [{ action: "add", herbName: "人参", trigger: "若气短", reason: "补气" }], diet, cards: [dietCardItem("莱菔粥：莱菔子30g")] }));
  assert.doesNotMatch(viaModification.diet, /萝卜/u);
  assert.equal(viaModification.tcmTreatments.length, 0);
  // 对照。
  const noRenshen = projectDiet(rx({ herbs: ["半夏", "茯苓"], diet, cards: [dietCardItem("莱菔粥：莱菔子30g煎汁，入粳米50g煮粥。")] }));
  assert.equal(noRenshen.diet, diet);
  assert.equal(noRenshen.tcmTreatments.length, 1);
  const carrot = "饮食清淡，可用胡萝卜煮汤，忌生冷。";
  assert.equal(projectDiet(rx({ herbs: ["人参", "半夏"], diet: carrot })).diet, carrot);
  const avoid = "饮食清淡，服人参期间忌萝卜、浓茶，忌生冷。";
  assert.equal(projectDiet(rx({ herbs: ["人参", "半夏"], diet: avoid })).diet, avoid);
});

// ── 4 复诊提示按本例人群 ───────────────────────────────────────────────────────
const SAFETY_NET = "请服完本次的药后复诊。若出血点明显增多、出现大片瘀斑、牙龈或鼻出血、黑便、月经量骤增，或头晕加重、头痛呕吐，请立即就医。";
const OLD_WOMAN = { reproductive: false, ageYears: 61 };
await check("4.1 followupSignsForPopulation：61 岁女性去掉「月经量骤增」一项，其余项与标点接好；项在句首、整句只剩它、孕哺类也照此；育龄女性与缺省人群原样（对照）；再投影一次结果不变", () => {
  const stripped = boundary.followupSignsForPopulation(SAFETY_NET, OLD_WOMAN);
  assert.equal(stripped, "请服完本次的药后复诊。若出血点明显增多、出现大片瘀斑、牙龈或鼻出血、黑便，或头晕加重、头痛呕吐，请立即就医。");
  assert.equal(boundary.followupSignsForPopulation(stripped, OLD_WOMAN), stripped);
  assert.equal(boundary.followupSignsForPopulation("请服完本次的药后复诊。若月经量骤增、牙龈出血，请立即就医。", OLD_WOMAN), "请服完本次的药后复诊。若牙龈出血，请立即就医。");
  assert.equal(boundary.followupSignsForPopulation("请服完本次的药后复诊。若出现妊娠反应加重、牙龈出血，请立即就医。", { reproductive: false, ageYears: 30 }), "请服完本次的药后复诊。若出现牙龈出血，请立即就医。");
  assert.equal(boundary.followupSignsForPopulation("请服完本次的药后复诊。若月经量骤增，请立即就医。", OLD_WOMAN), "请服完本次的药后复诊。");
  assert.equal(boundary.followupSignsForPopulation(SAFETY_NET, { reproductive: true, ageYears: 30 }), SAFETY_NET);
  assert.equal(boundary.followupSignsForPopulation(SAFETY_NET, undefined), SAFETY_NET);
  const noSigns = "请服完本次的药后复诊。若出血点明显增多、牙龈出血，请立即就医。";
  assert.equal(boundary.followupSignsForPopulation(noSigns, OLD_WOMAN), noSigns);
});

await check("4.2 交付面：辨证、开方两阶段的 management.followupSafetyNet 按人群收口；没给人群或育龄女性不动（对照）", () => {
  const management = { redFlagLoop: "x", mustCollect: [], followupSafetyNet: SAFETY_NET };
  const diagnose = { schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose", overview: {}, westernDiagnosis: { primary: { name: "x", supportingFacts: [] } }, pathogenesis: { chain: [] }, therapy: {}, management };
  for (const reasoning of [diagnose, rx({ management })]) {
    const out = surface.projectDeliveredReasoning(reasoning, { herbBoundaryAudience: OLD_WOMAN });
    assert.doesNotMatch(out.management.followupSafetyNet, /月经/u, `${reasoning.stage}: ${out.management.followupSafetyNet}`);
    assert.match(out.management.followupSafetyNet, /黑便，或头晕加重/u);
    assert.equal(surface.projectDeliveredReasoning(reasoning, { herbBoundaryAudience: { reproductive: true, ageYears: 30 } }).management.followupSafetyNet, SAFETY_NET);
    assert.equal(surface.projectDeliveredReasoning(reasoning).management.followupSafetyNet, SAFETY_NET);
  }
});

await check("4.3 M05 作文结果收口：急症表现、观察指标、时间轴触发里的月经项去掉，去到不足两条回落模板；育龄女性原样（对照）", () => {
  const authored = {
    reviewFocus: "x", efficacyCriteria: "x", lifestyle: "x", dimensions: ["睡眠"],
    monitoringIndicators: ["皮肤出血点范围", "月经量变化", "头晕程度"],
    urgentSigns: ["月经量骤增", "出血点突然增多", "牙龈出血不止"],
    timeline: [
      { time: "7天后", action: "复诊", indicators: ["出血点变化"], triggers: ["月经量骤增", "出血点增多"] },
      { time: "14天后", action: "复诊", indicators: ["头晕"], triggers: ["月经量骤增"] },
      { time: "28天后", action: "复诊", indicators: ["睡眠"], triggers: ["黑便"] },
    ],
  };
  const out = m05.authoredFollowupForPopulation(authored, OLD_WOMAN);
  assert.deepEqual(out.urgentSigns, ["出血点突然增多", "牙龈出血不止"]);
  assert.deepEqual(out.monitoringIndicators, ["皮肤出血点范围", "头晕程度"]);
  assert.deepEqual(out.timeline.map((item) => item.time), ["7天后", "28天后"]);
  assert.deepEqual(out.timeline[0].triggers, ["出血点增多"]);
  const fewer = m05.authoredFollowupForPopulation({ ...authored, urgentSigns: ["月经量骤增", "出血点突然增多"] }, OLD_WOMAN);
  assert.deepEqual(fewer.urgentSigns, []);
  assert.equal(m05.authoredFollowupForPopulation(authored, { reproductive: true, ageYears: 30 }), authored);
  assert.equal(authored.urgentSigns.length, 3, "缓存里的原对象不得被改动");
});

await check("4.4 经 authorFollowupClinicalContent 入口：缓存键里没有性别年龄，同一份作文 61 岁女性拿到收口后的、30 岁女性拿到原文（缓存里存原文，出口收口）", async () => {
  const reply = {
    reviewFocus: "复诊时医生会重点了解皮肤出血点是增多还是减少、颜色深浅，头晕和腰酸有没有减轻；请您服药期间留意并记下这些变化。",
    efficacyCriteria: "皮肤出血点逐渐变淡、减少，头晕和腰酸减轻，说明治疗有效。",
    lifestyle: "饮食宜清淡易消化，忌生冷油腻；作息规律，避免劳累，保持情志舒畅，适度散步以助运化。",
    dimensions: ["饮食", "睡眠", "情志"],
    monitoringIndicators: ["皮肤出血点范围", "头晕程度", "腰酸程度"],
    urgentSigns: ["月经量骤增", "出血点突然增多", "牙龈出血不止", "黑便"],
    timeline: [],
  };
  let calls = 0;
  const original = globalThis.fetch;
  const originalInfo = console.info;
  console.info = () => {};
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ id: "x", object: "chat.completion", created: 0, model: "deepseek-flash",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(reply) } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { headers: { "content-type": "application/json" } });
  };
  try {
    m05.resetAuthoredFollowupCache();
    const stateOf = (age) => types.normalizeCaseStateInput({ id: `r8e-${age}`, chiefComplaint: "皮肤出血点反复8年", patient: { sex: "女", age } });
    const input = { syndrome: "脾肾两虚证", herbs: ["黄芪", "茯苓"] };
    const old = await m05.authorFollowupClinicalContent(stateOf(61), input);
    assert.ok(old, "桩回复应被采纳");
    assert.deepEqual(old.urgentSigns, ["出血点突然增多", "牙龈出血不止", "黑便"]);
    const young = await m05.authorFollowupClinicalContent(stateOf(30), input);
    assert.deepEqual(young.urgentSigns, reply.urgentSigns);
    assert.equal(calls, 1, "第二次应命中缓存");
  } finally {
    globalThis.fetch = original;
    console.info = originalInfo;
    m05.resetAuthoredFollowupCache();
  }
});

await check("4.5 接线：辨证路由把人群（reproductiveAdviceRelevant、年龄）交给交付面，开方路由原有的也在（交付面只在给了人群时收口）", () => {
  const diagnose = readFileSync("src/app/api/diagnosis/diagnose/route.ts", "utf8");
  assert.match(diagnose, /structuredHerbBoundaryAudience: \{ reproductive: reproductiveAdviceRelevant\(gated\), ageYears: authoritativePatientAgeYears\(gated\) \?\? null \}/u);
  const prescribe = readFileSync("src/app/api/diagnosis/prescribe/route.ts", "utf8");
  assert.match(prescribe, /structuredHerbBoundaryAudience: \{ reproductive: reproductiveAdviceRelevant\(gated\)/u);
});

// ── 5 医嘱禁食 ────────────────────────────────────────────────────────────────
await check("5.1 fastingOrdered：禁食并暂缓经口进食、暂禁饮食、暂禁食待评估算医嘱禁食；「禁食辛辣生冷」「忌食生冷」「少量多餐」是忌口不是禁食（对照）", () => {
  for (const text of ["请优先完成影像评估，禁食并暂缓经口进食。", "暂禁饮食", "饮食宜清淡，暂禁食待医生评估。", "禁食水，尽快就诊", "暂缓经口进食"]) {
    assert.equal(surface.fastingOrdered([text]), true, text);
  }
  for (const text of ["禁食辛辣生冷之品", "忌食生冷，少量多餐", "饮食清淡，禁食海鲜", "少食多餐"]) {
    assert.equal(surface.fastingOrdered([text]), false, text);
  }
});

await check("5.2 交付面：注意事项写禁食并暂缓经口进食时，饮食栏只留忌口、不再推荐小米粥蒸蛋，食疗卡不出（test-374）；没有禁食医嘱时原样（对照）", () => {
  const diet = "饮食宜清淡、易消化，少食辛辣油腻；可选小米粥、蒸蛋、清炒时蔬等，少量多餐，忌生冷黏腻。";
  const fastingLine = "现有资料提示需立即急诊评估以排除肠梗阻，请优先完成腹部专科查体与影像评估，禁食并暂缓经口进食。";
  const out = projectDiet(rx({ diet, precautions: [fastingLine, "如正在服用其他药物，请先告知医生。"], cards: [dietCardItem("食疗原则：行气。小米粥：小米50g煮粥。")] }));
  assert.equal(out.diet, "少食辛辣油腻；忌生冷黏腻。");
  assert.equal(out.tcmTreatments.length, 0);
  assert.equal(out.precautions[0], fastingLine);
  const control = projectDiet(rx({ diet, precautions: ["如正在服用其他药物，请先告知医生。"], cards: [dietCardItem("食疗原则：行气。小米粥：小米50g煮粥。")] }));
  assert.equal(control.diet, diet);
  assert.equal(control.tcmTreatments.length, 1);
  // 「禁食辛辣」是忌口：饮食栏照旧。
  const taboo = projectDiet(rx({ diet, precautions: ["服药期间禁食辛辣生冷。"] }));
  assert.equal(taboo.diet, diet);
});

// ── 6 在用抗栓药 ──────────────────────────────────────────────────────────────
await check("6.1 mentionsBloodActivatingFood 取知识库功效（活血、破血、化瘀、祛瘀、散瘀）：山楂、桃仁、红花、丹参算；山药、薏苡仁、陈皮不算（对照）", () => {
  for (const text of ["适量吃山楂", "桃仁粥", "红花茶", "丹参煮水"]) assert.equal(surface.mentionsBloodActivatingFood(text), true, text);
  for (const text of ["山药薏苡仁粥", "陈皮泡水代茶", "小米粥"]) assert.equal(surface.mentionsBloodActivatingFood(text), false, text);
});

const ANTITHROMBOTIC = { kind: "antithrombotic_bleeding", drugs: ["阿司匹林肠溶片"] };
await check("6.2 交付面：在用阿司匹林时，饮食栏去掉「适量吃山楂、桃仁作佐食」那一小句、食疗卡（山楂）不交付，忌口照留（M-MTCMB-7）；没有抗栓药时原样（对照）", () => {
  const diet = "饮食清淡，少食肥甘厚腻与甜黏之品；可适量吃山楂、桃仁作日常佐食，忌过饱。";
  const cards = [dietCardItem("食疗原则：活血。山楂粥：山楂30g，粳米50g煮粥。")];
  const out = projectDiet(rx({ herbs: ["瓜蒌", "薤白"], diet, cards }), { requiredPrecautions: [ANTITHROMBOTIC] });
  assert.doesNotMatch(out.diet, /山楂|桃仁/u, out.diet);
  assert.match(out.diet, /饮食清淡，少食肥甘厚腻与甜黏之品/u);
  assert.match(out.diet, /忌过饱/u);
  assert.equal(out.tcmTreatments.length, 0);
  const control = projectDiet(rx({ herbs: ["瓜蒌", "薤白"], diet, cards }));
  assert.equal(control.diet, diet);
  assert.equal(control.tcmTreatments.length, 1);
  // 非活血类的药食同源品照推荐。
  const mild = "饮食清淡，可用山药、薏苡仁煮粥，忌过饱。";
  assert.equal(projectDiet(rx({ herbs: ["瓜蒌"], diet: mild }), { requiredPrecautions: [ANTITHROMBOTIC] }).diet, mild);
});

await check("6.3 整条链：病历记平素服阿司匹林肠溶片，必写注意事项给出 antithrombotic_bleeding，交付面据此去掉饮食里的山楂、桃仁（M-MTCMB-7 形状）；病历没有抗栓药时不给、饮食不动（对照）", () => {
  const state = (history) => types.normalizeCaseStateInput({ id: "r8e", chiefComplaint: "阵发性胸闷气短30余年", patient: { sex: "女", age: 45 }, symptoms: { 现病史: history }, conversation: [] });
  const on = precautions.requiredPrecautionsForCase(state("在当地医院诊断为冠状动脉粥样硬化性心脏病，平素服用阿司匹林肠溶片0.1 qd、瑞舒伐他汀钙片5mg qn等治疗，效尚可"));
  assert.ok(on.some((item) => item.kind === "antithrombotic_bleeding"), JSON.stringify(on));
  const diet = "饮食清淡，可适量吃山楂、桃仁作日常佐食，忌过饱。";
  assert.doesNotMatch(projectDiet(rx({ herbs: ["瓜蒌", "丹参"], diet }), { requiredPrecautions: on }).diet, /山楂|桃仁/u);
  const off = precautions.requiredPrecautionsForCase(state("在当地医院诊断为冠状动脉粥样硬化性心脏病，平素服用瑞舒伐他汀钙片5mg qn等治疗，效尚可"));
  assert.ok(!off.some((item) => item.kind === "antithrombotic_bleeding"), JSON.stringify(off));
  assert.equal(projectDiet(rx({ herbs: ["瓜蒌", "丹参"], diet }), { requiredPrecautions: off }).diet, diet);
});

await check("6.4 随证加减拟加桃仁，饮食栏又推荐「适量食用桃仁煮粥」：与主方里有桃仁同样等于加量，去掉那一小句（M-MTCMB-7 的加减）；加减去掉桃仁、或加的是山药时不动（对照）", () => {
  const diet = "饮食清淡，可适量食用桃仁煮粥，忌过饱。";
  const out = projectDiet(rx({ herbs: ["瓜蒌", "薤白"], modifications: [{ action: "add", herbName: "桃仁", trigger: "若大便干结", reason: "润肠通便" }], diet }));
  assert.doesNotMatch(out.diet, /桃仁/u, out.diet);
  assert.match(out.diet, /忌过饱/u);
  assert.equal(projectDiet(rx({ herbs: ["瓜蒌", "薤白"], diet })).diet, diet);
  assert.equal(projectDiet(rx({ herbs: ["瓜蒌", "薤白"], modifications: [{ action: "remove", herbName: "桃仁", trigger: "若便溏", reason: "x" }], diet })).diet, diet);
  assert.equal(projectDiet(rx({ herbs: ["瓜蒌", "薤白"], modifications: [{ action: "add", herbName: "山药", trigger: "若乏力", reason: "x" }], diet })).diet, diet);
});

console.log(JSON.stringify({ suite: "r1020-care", cases, failures: process.exitCode ? "see above" : 0 }));
