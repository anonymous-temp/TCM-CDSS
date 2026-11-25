// 第五十九轮（2026-11-25）：甲方真实病历 100 例自评（r1077，生产 31eca7e）发现的问题按类修。
// 阅卷材料、逐条归类与回放在 ~/runlogs/r1018/work/r1077 与 r1078（PLAN.md）。本套件一条断言对应一类：
//  A. 西医诊断名与依据句（「X症状待查」「X待查诊断尚未确立」、舌脉当西医依据、系统口吻的半句、名说待查而依据说成立）。
//  B. 辨证依据（结论句证名与交付证名不一、没立兼证却写「兼X」、依据被删到只剩一句时按病机链补回）。
//  C. 病机链与病位/病性栏（只拿舌脉当病历表现的节点、病位依据从本例自己的分析里找、病性栏写成机理句、证名自带的脏腑与病性）。
//  D. 方义「原方」口径（银翘散原文作芥穗，处方用荆芥）。
//  E. 注意事项与治疗卡（因疑似过敏停药不算擅自停药、55 岁以上不写孕哺提示、年龄未知的推拿卡不印小儿推拿段）。
//  F. 中医鉴别（便秘与泄泻鉴别、没有鼻部症状与鼻渊鉴别）。
//  G. 其余文字（急症提示里的内部说法、改名虚脱后辨病依据自相矛盾、慎用栏括号不成对的残句、说明书条目编号）。
//  H. 两处提示词（加减不为外感新病的乏力加补益药；复诊重点只提病历里有的症状）。
// 每条断言都有反证（~/runlogs/r1018/work/r1078/cp/）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@": `${process.cwd()}/src`,
    "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
  },
});

const only = process.env.R1078_CHECK;
const check = async (id, name, run) => {
  if (only && only !== id) return;
  try {
    await run();
    console.log(`✓ ${id} ${name}`);
  } catch (error) {
    console.error(`✗ ${id} ${name}\n  ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
};
const source = (path) => readFileSync(`${process.cwd()}/src/${path}`, "utf8");

const surface = await jiti.import("../src/lib/delivered-surface.ts");
const claims = await jiti.import("../src/lib/recorded-test-claims.ts");
const natureColumns = await jiti.import("../src/lib/nature-column-classification.ts");
const summary = await jiti.import("../src/lib/diagnosis-visible-summary.ts");
const polarity = await jiti.import("../src/lib/clinical-polarity.ts");
const safety = await jiti.import("../src/lib/diagnosis-safety.ts");
const types = await jiti.import("../src/lib/diagnosis-types.ts");
const textbook = await jiti.import("../src/lib/tcm-textbook-syndromes.ts");
const critical = await jiti.import("../src/lib/m03-critical-syndrome.ts");
const cards = await jiti.import("../src/lib/tcm-nondrug-textbook-plan.server.ts");
const facts = await jiti.import("../src/lib/clinical-facts.ts");
const authoring = await jiti.import("../src/lib/m04-modification-authoring.server.ts");

const SCHEMA = "tcm-cdss-reasoning-v2";
const RECORD = "患者性别：女\n患者年龄：45岁\n头痛1月余\n现病史：头痛、头晕，劳累后加重，面色少华\n舌质淡\n脉弦细";
/** 最小的辨证结果：两条病机链，第二条只拿脉象当病历表现。 */
const diagnoseFixture = () => ({
  schemaVersion: SCHEMA, stage: "diagnose",
  overview: {
    tcmDiseaseName: "头痛", tcmDiseaseRationale: "头痛1月余，属头痛。", primarySyndrome: "血虚证", secondarySyndromes: [],
    primarySyndromeBasis: ["头痛、头晕，劳累后加重", "面色少华"],
    tcmDiagnosticRationale: "头痛、头晕，劳累后加重，面色少华，为血虚不能上荣清窍；舌质淡、脉弦细为血虚之象。诸症合参，故辨为气血两虚证，兼湿浊内停。",
    tcmDifferentials: [], confidence: "中",
  },
  westernDiagnosis: {
    primary: { name: "头痛症状待查", clinicalRationale: "本例头痛1月余，舌质淡、脉弦细，头痛待查诊断尚未确立，尚缺头颅影像检查。", status: "考虑", supportingFacts: [], limitations: [], suggestedChecks: [] },
    candidates: [], differentials: [],
  },
  pathogenesis: {
    locationDifferentiation: { items: ["头"], details: [{ location: "头", basis: "头痛、头晕" }], resolution: "resolved", evidence: { confidence: "高" } },
    natureDifferentiation: { items: ["血虚"], rootDeficiency: ["血虚"], branchExcess: [], basis: "面色少华", resolution: "resolved", evidence: { confidence: "高" } },
    chain: [
      { nodeId: "P1", patientFact: "头痛、头晕，劳累后加重", syndromeEvidence: "面色少华", pathogenesis: "血虚不能上荣清窍", therapyDirection: "养血和络" },
      { nodeId: "P2", patientFact: "脉弦细", syndromeEvidence: "脉弦细", pathogenesis: "血虚脉道不充", therapyDirection: "养血和脉，通利脉道" },
    ],
    overallPathogenesis: "血虚不能上荣清窍", uncertainties: [],
  },
  therapy: { overallPrinciple: "虚则补之", overallMethod: "养血和络", subTherapies: [{ target: "P1", method: "养血和络" }, { target: "P2", method: "养血和脉，通利脉道" }] },
  management: {},
});
const project = (reasoning, recordText = RECORD) => surface.projectDeliveredReasoning(JSON.parse(JSON.stringify(reasoning)), { recordText });

// ─── A 西医诊断名与依据句 ─────────────────────────────────────────────────────────
await check("A1", "「心悸症状待查」交付为「心悸待查」；「咳嗽症状」仍为「咳嗽待查」", () => {
  assert.equal(surface.deliveredWesternDiagnosisName("心悸症状待查"), "心悸待查");
  assert.equal(surface.deliveredWesternDiagnosisName("头晕症状待查"), "头晕待查");
  assert.equal(surface.deliveredWesternDiagnosisName("咳嗽症状"), "咳嗽待查");
  // 病名里本来就有「症状」二字前只有一个字的不动（防止把病名削坏）。
  assert.equal(surface.deliveredWesternDiagnosisName("某症状待查"), "某症状待查");
});

await check("A2", "依据句里代进去的「X待查诊断尚未确立 / 尚未确诊」改成「X的病因尚未明确」；幂等", () => {
  const tidy = surface.tidiedWesternBasis;
  const first = tidy("本例乏力伴气短1年余，呈持续病程，乏力待查诊断尚未确立，尚缺血常规、心功能等检查，需完善后明确病因。");
  assert.equal(first, "本例乏力伴气短1年余，呈持续病程，乏力的病因尚未明确，尚缺血常规、心功能等检查，需完善后明确病因。");
  assert.equal(tidy(first), first);
  assert.match(tidy("患者口干口苦1月余，口干待查目前诊断未确立，考虑干燥综合征、糖尿病可能。"), /口干的病因尚未明确，考虑干燥综合征、糖尿病可能/u);
  assert.match(tidy("腹泻3天，腹泻待查尚未确诊，尚缺粪常规。"), /腹泻的病因尚未明确/u);
  // 没有「待查」代入的句子不动。
  const plain = "胸痛发作时含服硝酸甘油可缓解，符合稳定型心绞痛。";
  assert.equal(tidy(plain), plain);
});

await check("A3", "「胸闷待查考虑冠心病、心律失常可能」去掉代进去的「胸闷待查」", () => {
  const out = surface.tidiedWesternBasis("本例胸闷、气短、心悸、乏力2周，症状持续存在，胸闷待查考虑冠状动脉粥样硬化性心脏病、心律失常可能；尚缺心电图。");
  assert.equal(out, "本例胸闷、气短、心悸、乏力2周，症状持续存在，考虑冠状动脉粥样硬化性心脏病、心律失常可能；尚缺心电图。");
});

await check("A4", "查体断言净化器的替换句「本次病历未记录…结果，需现场补充」不留在诊断依据里", () => {
  const out = surface.tidiedWesternBasis("仅记录心悸1月余，无起病诱因等客观依据，本次病历未记录心脏听诊结果，需现场补充，故先以症状名待查。");
  assert.equal(out, "仅记录心悸1月余，无起病诱因等客观依据，故先以症状名待查。");
});

await check("A5", "舌象、脉象不作西医诊断依据；「舌下含服」「脉搏」「脉压」不是舌脉描述，保留", () => {
  const tidy = surface.tidiedWesternBasis;
  assert.equal(tidy("本例头晕伴痰多持续半年，舌红苔腻、脉弦滑，眩晕待查目前诊断未确立，尚缺前庭功能检查。"), "本例头晕伴痰多持续半年，眩晕的病因尚未明确，尚缺前庭功能检查。");
  const kept = "胸痛发作时舌下含服硝酸甘油可缓解，脉搏72次/分，脉压正常，符合稳定型心绞痛。";
  assert.equal(tidy(kept), kept);
  // 一个小句里舌脉与症状并列时只去掉舌脉那几项。
  assert.equal(tidy("咳嗽、舌红，考虑急性支气管炎。"), "咳嗽，考虑急性支气管炎。");
});

await check("A6", "只剩「但现有资料尚不足以确定具体病因…」半句时换成临床说法，句首补上主诉", () => {
  const out = surface.tidiedWesternBasis("但现有资料尚不足以确定具体病因，因此暂不采用更具体的病因标签。", "患者年龄：未提供\n头痛、无大便两日余\n现病史：头痛、无大便");
  assert.equal(out, "以头痛、无大便两日余就诊，具体病因尚待进一步检查明确。");
  assert.equal(surface.tidiedWesternBasis(out, "患者年龄：未提供\n头痛、无大便两日余\n现病史：头痛、无大便"), out);
  // 前面还有本例事实时不补主诉。
  const withLead = surface.tidiedWesternBasis("头痛两日，但现有资料尚不足以确定具体病因，因此暂不采用更具体的病因标签。", "头痛两日");
  assert.equal(withLead, "头痛两日，具体病因尚待进一步检查明确。");
});

await check("A7", "交付面接线：病名、依据句、症状依据栏三处一致地用整理后的写法；二次投影不再变化", () => {
  const once = project(diagnoseFixture());
  assert.equal(once.westernDiagnosis.primary.name, "头痛待查");
  assert.equal(once.westernDiagnosis.primary.clinicalRationale, "本例头痛1月余，头痛的病因尚未明确，尚缺头颅影像检查。");
  assert.deepEqual(once.westernDiagnosis.primary.supportingFacts, ["本例头痛1月余，头痛的病因尚未明确，尚缺头颅影像检查。"]);
  assert.equal(JSON.stringify(project(once)), JSON.stringify(once));
});

await check("A8", "依据直说「诊断X尚缺…」：病名改「X待查」；缺的只是分型、病因这类下位信息的不改", () => {
  const settled = claims.settleWesternDiagnosisBasis("药物性皮炎", "面部红斑伴瘙痒灼热2月余，诊断药物性皮炎尚缺停药后皮疹消退观察及药物激发试验，需排除荨麻疹、湿疹等。", "面部红斑伴瘙痒、灼热2月余");
  assert.equal(settled.name, "药物性皮炎待查");
  assert.equal(claims.basisSaysNameNotEstablished("诊断药物性皮炎尚缺停药后皮疹消退观察及药物激发试验。", "药物性皮炎"), true);
  assert.equal(claims.basisSaysNameNotEstablished("药物性皮炎的诊断仍缺停药后观察。", "药物性皮炎"), true);
  assert.equal(claims.basisSaysNameNotEstablished("诊断高血压尚缺分型与病因评估。", "高血压"), false);
});

await check("A9", "病名带「待查」而依据写「诊断可临床成立 / 可临床确立」：去掉这半句，名与依据不再一个待查一个成立", () => {
  const constipation = claims.settleWesternDiagnosisBasis("便秘待查", "本例为急性便秘2天，符合排便困难或排便次数减少的特点，便秘诊断可临床成立，尚缺排便频率、粪便性状记录及器质性病因排查，需排除肠梗阻、结直肠肿瘤等。", "便秘2天");
  assert.equal(constipation.name, "便秘待查");
  assert.ok(!/成立/u.test(constipation.basis), constipation.basis);
  const acne = claims.settleWesternDiagnosisBasis("寻常痤疮待查", "面部丘疹反复一年，诊断寻常痤疮可临床确立，需排除玫瑰痤疮。", "面部丘疹反复发作一年");
  assert.ok(!/确立/u.test(acne.basis), acne.basis);
  const prurigo = claims.settleWesternDiagnosisBasis("结节性痒疹待查", "四肢结节伴剧烈瘙痒半年，可临床诊断结节性痒疹，需排除疥疮。", "四肢结节伴瘙痒半年");
  assert.ok(!/可临床诊断结节性痒疹/u.test(prurigo.basis), prurigo.basis);
});

// ─── B 辨证依据 ─────────────────────────────────────────────────────────────────
await check("B1", "结论句里的证名与交付的主证名不一（同一证的宽窄写法）：换成交付的主证名", () => {
  const align = surface.rationaleConclusionAlignedWithSyndrome;
  const out = align("舌淡、脉沉细为气虚鼓动无力之象。综合脉症，病位在肺脾，病性属气虚，故辨证为肺脾气虚证。", "肺气虚证", []);
  assert.equal(out, "舌淡、脉沉细为气虚鼓动无力之象。综合脉症，病位在肺脾，病性属气虚，故辨证为肺气虚证。");
  assert.equal(align(out, "肺气虚证", []), out);
  // 与主证名不到两个字相同的是别的病证，不动。
  const other = "与胸痹相鉴别，故辨为心悸，不辨为胸痹心血瘀阻证。";
  assert.equal(align(other, "心气不足证", []), other);
});

await check("B2", "没有交付兼证而结论句写「……证，兼X」「主证名兼X」：去掉这半句；交付了对应兼证的不动", () => {
  const align = surface.rationaleConclusionAlignedWithSyndrome;
  assert.equal(align("诸症合参，以血虚为本，虚热与湿浊为兼，故辨为肝血不足证，兼湿浊内停。", "肝血不足证", []), "诸症合参，以血虚为本，虚热与湿浊为兼，故辨为肝血不足证。");
  assert.equal(align("四诊合参，病位在心，涉及脾，属痰热扰心兼血瘀，故辨为不寐，痰热扰心证。", "痰热扰心证", []), "四诊合参，病位在心，涉及脾，属痰热扰心，故辨为不寐，痰热扰心证。");
  const delivered = "诸症合参，水停与血瘀并见，故属瘀水互结证，兼痰湿内阻证。";
  assert.equal(align(delivered, "瘀水互结证", ["痰湿内阻证"]), delivered);
});

await check("B3", "讲病性的「属阳亢兼郁热」与流派视角句不动；只动最后两句里的结论句", () => {
  const align = surface.rationaleConclusionAlignedWithSyndrome;
  const natureSentence = "头晕头胀，面红目赤。病性属阳亢兼郁热，故辨为肝阳上亢证。";
  assert.equal(align(natureSentence, "肝阳上亢证", []), natureSentence);
  const lens = "全方兼顾脾胃。故辨为肝气犯胃证。从经方学派看，证属肝胃不和证。";
  assert.equal(align(lens, "肝气犯胃证", []), lens);
  const early = "初起辨为肺脾气虚证，后见脾虚不显。咳嗽日久。气短乏力。声低懒言为肺气不足。";
  assert.equal(align(early, "肺气虚证", []), early);
});

await check("B4", "辨证依据被删到只剩一句待核实的话：按本例病机链补回「表现→病机→证」；够长或已引到病机链表现的不补", () => {
  const floor = surface.rationaleWithFloorFromChain;
  const chain = [
    { patientFact: "高热、口渴", pathogenesis: "热盛伤津", therapyDirection: "清热生津" },
    { patientFact: "大汗淋漓，四肢厥冷", pathogenesis: "阳随津脱", therapyDirection: "回阳固脱" },
  ];
  const rebuilt = floor("舌脉未记录，津伤与邪陷深浅待复核。", chain, "阳气暴脱证");
  assert.equal(rebuilt, "高热、口渴，为热盛伤津；大汗淋漓，四肢厥冷，为阳随津脱。故辨为阳气暴脱证。舌脉未记录，津伤与邪陷深浅待复核。");
  assert.equal(floor(rebuilt, chain, "阳气暴脱证"), rebuilt);
  const cited = "高热、口渴为热盛；余待复核。";
  assert.equal(floor(cited, chain, "阳气暴脱证"), cited);
  const long = "发热恶寒、头身疼痛、无汗而喘，为风寒束表、肺气失宣；舌苔薄白、脉浮紧为风寒在表之象。诸症合参，故辨为风寒束表证。";
  assert.equal(floor(long, chain, "风寒束表证"), long);
  assert.equal(floor("待复核。", [], "阳气暴脱证"), "待复核。");
});

await check("B5", "交付面接线：结论句对齐后的辨证依据随辨证结果交付；有限结果不动", () => {
  const once = project(diagnoseFixture());
  assert.equal(once.overview.tcmDiagnosticRationale, "头痛、头晕，劳累后加重，面色少华，为血虚不能上荣清窍；舌质淡、脉弦细为血虚之象。诸症合参，故辨为血虚证。");
});

// ─── C 病机链与病位/病性栏 ──────────────────────────────────────────────────────
await check("C1", "只拿舌脉当病历表现的病机链节点并回第一条的证据，同序的分治法一并去掉；二次投影不变", () => {
  const once = project(diagnoseFixture());
  assert.equal(once.pathogenesis.chain.length, 1);
  assert.equal(once.pathogenesis.chain[0].syndromeEvidence, "面色少华；脉弦细");
  assert.deepEqual(once.therapy.subTherapies, [{ target: "P1", method: "养血和络" }]);
  assert.equal(JSON.stringify(project(once)), JSON.stringify(once));
});

await check("C2", "舌脉节点独自承担总治法里的一项时不并；整条链都是舌脉节点时不动；开方阶段不动", () => {
  const sole = diagnoseFixture();
  sole.therapy.overallMethod = "养血和络，通利脉道";
  sole.pathogenesis.chain[1].therapyDirection = "通利脉道";
  assert.equal(project(sole).pathogenesis.chain.length, 2);
  const allTonguePulse = diagnoseFixture();
  allTonguePulse.pathogenesis.chain[0].patientFact = "舌质淡";
  assert.equal(project(allTonguePulse).pathogenesis.chain.length, 2);
  const prescribe = { ...diagnoseFixture(), stage: "prescribe" };
  assert.equal(project(prescribe).pathogenesis.chain.length, 2);
});

const HEART_RECORD = "心悸1月余\n现病史：心悸、气短，活动后加重\n舌质淡\n脉细弱";
const heartFixture = () => ({
  stage: "diagnose",
  overview: { tcmDiseaseName: "心悸", primarySyndrome: "心气不足证", secondarySyndromes: [], primarySyndromeBasis: ["心悸、气短，活动后加重"] },
  pathogenesis: {
    locationDifferentiation: { items: ["心"], details: [], resolution: "bounded", resolutionReason: "病位“心”尚缺直接的病历依据", evidence: { confidence: "低" } },
    natureDifferentiation: { items: ["气虚"], rootDeficiency: ["气虚"], branchExcess: [], basis: "气短，活动后加重", resolution: "resolved", evidence: { confidence: "高" } },
    chain: [{ nodeId: "P1", patientFact: "心悸、气短，活动后加重", syndromeEvidence: "舌质淡", pathogenesis: "心气不足，鼓动无力", therapyDirection: "补益心气" }],
    overallPathogenesis: "心气不足", uncertainties: [],
  },
  therapy: { overallMethod: "补益心气", subTherapies: [] },
});

await check("C3", "病位没有逐字依据时从本例病机链里点到该病位的那一条取病历表现：不再写「病位“心”尚缺直接的病历依据」", () => {
  const reasoning = heartFixture();
  summary.withAxisBookkeepingFromFinalContent(reasoning, HEART_RECORD);
  const location = reasoning.pathogenesis.locationDifferentiation;
  assert.equal(location.resolution, "resolved");
  assert.equal(location.resolutionReason, undefined);
  assert.deepEqual(location.details.map((row) => row.location), ["心"]);
  assert.ok(String(location.details[0].basis).includes("心悸"), JSON.stringify(location.details));
  // 病机链没点到、主证名也不带这个病位的：仍按有界（不凭空补依据）。
  const unrelated = heartFixture();
  unrelated.pathogenesis.locationDifferentiation.items = ["肝"];
  summary.withAxisBookkeepingFromFinalContent(unrelated, HEART_RECORD);
  assert.equal(unrelated.pathogenesis.locationDifferentiation.resolution, "bounded");
  assert.ok((unrelated.pathogenesis.locationDifferentiation.details || []).every((row) => row.location !== "肝"), JSON.stringify(unrelated.pathogenesis.locationDifferentiation));
});

await check("C4", "主证名自带的脏腑补进病位栏（脾肾阳虚而病位只列脾）；兼证名带的脏腑不借主证依据", () => {
  assert.deepEqual(natureColumns.organsNamedBySyndromeMissingFrom("脾肾阳虚", ["脾", "肠"]), ["肾"]);
  assert.deepEqual(natureColumns.organsNamedBySyndromeMissingFrom("肝气犯胃", ["肝", "胃"]), []);
  const primaryNamed = heartFixture();
  primaryNamed.overview.primarySyndrome = "脾肾阳虚证";
  primaryNamed.pathogenesis.locationDifferentiation = { items: ["脾"], details: [{ location: "脾", basis: "气短，活动后加重" }], resolution: "resolved" };
  summary.withAxisBookkeepingFromFinalContent(primaryNamed, HEART_RECORD);
  assert.deepEqual(primaryNamed.pathogenesis.locationDifferentiation.items, ["脾", "肾"]);
  const secondaryNamed = heartFixture();
  secondaryNamed.overview.secondarySyndromes = ["肺脾气虚证"];
  secondaryNamed.pathogenesis.chain[0].pathogenesis = "心气不足，脾失健运";
  secondaryNamed.pathogenesis.locationDifferentiation = { items: ["心"], details: [{ location: "心", basis: "心悸、气短" }], resolution: "resolved" };
  summary.withAxisBookkeepingFromFinalContent(secondaryNamed, HEART_RECORD);
  assert.deepEqual(secondaryNamed.pathogenesis.locationDifferentiation.items, ["心"]);
  // 病位栏已列着兼证的脏腑而病机链没点到它：不拿主证依据充数，仍是有界。
  const listedBySecondary = heartFixture();
  listedBySecondary.overview.secondarySyndromes = ["肺脾气虚证"];
  listedBySecondary.pathogenesis.locationDifferentiation = { items: ["心", "脾"], details: [{ location: "心", basis: "心悸、气短" }], resolution: "bounded", resolutionReason: "病位“脾”尚缺直接的病历依据" };
  summary.withAxisBookkeepingFromFinalContent(listedBySecondary, HEART_RECORD);
  assert.equal(listedBySecondary.pathogenesis.locationDifferentiation.resolution, "bounded");
  assert.ok(listedBySecondary.pathogenesis.locationDifferentiation.details.every((row) => row.location !== "脾"), JSON.stringify(listedBySecondary.pathogenesis.locationDifferentiation));
});

await check("C5", "病性栏里的机理句换成所含病性词；已有具体邪气时不并列笼统的「外邪」；认不出病性词的机理句不让病性栏变空", () => {
  const normalize = natureColumns.natureItemsWithoutMechanismPhrases;
  assert.deepEqual(normalize(["外邪袭表"]), ["外邪"]);
  assert.deepEqual(normalize(["湿郁化热"]).sort(), ["湿", "热"].sort());
  assert.deepEqual(normalize(["风", "外邪袭表"]), ["风"]);
  assert.deepEqual(normalize(["心神不宁"]), ["心神不宁"]);
  assert.deepEqual(normalize(["气虚", "心神不宁"]), ["气虚"]);
  assert.deepEqual(normalize(["痰热", "阴虚"]), ["痰热", "阴虚"]);
});

await check("C6", "证名自带、病性栏没有的病性词补上（寒湿只列湿、兼证气虚而本虚为无、虚寒、阴虚火旺的虚热）；已列的不重复", () => {
  const missing = natureColumns.natureLabelsNamedBySyndromeMissingFrom;
  assert.deepEqual(missing("寒湿困脾", ["湿"]), ["寒"]);
  assert.deepEqual(missing("肺脾气虚", []), ["气虚"]);
  assert.deepEqual(missing("脾胃虚寒", []), ["虚寒"]);
  assert.deepEqual(missing("阴虚火旺", ["阴虚"]), ["虚热"]);
  assert.deepEqual(missing("风热犯肺", ["风热"]), []);
  assert.deepEqual(missing("瘀血阻络", []), ["血瘀"]);
});

await check("C7", "证名是外感表证而病性栏只有机理句：写「外邪」，按有界交付并说明寒热还要结合哪几项；把握度不标高；幂等", () => {
  assert.equal(natureColumns.exteriorSyndromeNatureLabel("外邪犯肺"), "外邪");
  assert.equal(natureColumns.exteriorSyndromeNatureLabel("肝气郁结"), undefined);
  const reasoning = heartFixture();
  reasoning.overview.primarySyndrome = "外邪犯肺证";
  reasoning.pathogenesis.natureDifferentiation = { items: ["外邪袭表"], rootDeficiency: [], branchExcess: ["外邪袭表"], basis: "", resolution: "resolved", evidence: { confidence: "高" } };
  summary.withAxisBookkeepingFromFinalContent(reasoning, HEART_RECORD);
  const nature = reasoning.pathogenesis.natureDifferentiation;
  assert.deepEqual(nature.items, ["外邪"]);
  assert.deepEqual(nature.branchExcess, ["外邪"]);
  assert.equal(nature.resolution, "bounded");
  assert.match(String(nature.resolutionReason), /寒热/u);
  assert.equal(nature.evidence.confidence, "中");
  const again = JSON.parse(JSON.stringify(reasoning));
  summary.withAxisBookkeepingFromFinalContent(again, HEART_RECORD);
  assert.equal(JSON.stringify(again), JSON.stringify(reasoning));
  // 病性栏整个为空、证名只说外邪的：同样写「外邪」。
  const empty = heartFixture();
  empty.overview.primarySyndrome = "外邪犯肺证";
  empty.pathogenesis.natureDifferentiation = { items: [], rootDeficiency: [], branchExcess: [], basis: "", resolution: "unresolved" };
  summary.withAxisBookkeepingFromFinalContent(empty, HEART_RECORD);
  assert.deepEqual(empty.pathogenesis.natureDifferentiation.items, ["外邪"]);
  assert.equal(empty.pathogenesis.natureDifferentiation.resolution, "bounded");
});

await check("C8", "病性栏为空而证名带病性（脾肾阳虚）：补上并由 unresolved 改有界；与条目相反的「暂不列…」说明去掉", () => {
  const reasoning = heartFixture();
  reasoning.overview.primarySyndrome = "脾肾阳虚证";
  reasoning.pathogenesis.natureDifferentiation = { items: [], rootDeficiency: [], branchExcess: [], basis: "寒热属性未记录，暂不列阳虚", resolution: "unresolved" };
  summary.withAxisBookkeepingFromFinalContent(reasoning, HEART_RECORD);
  const nature = reasoning.pathogenesis.natureDifferentiation;
  assert.deepEqual(nature.items, ["阳虚"]);
  assert.deepEqual(nature.rootDeficiency, ["阳虚"]);
  assert.notEqual(nature.resolution, "unresolved");
  assert.ok(!/暂不列/u.test(String(nature.basis || "")), String(nature.basis));
});

// ─── D 方义「原方」口径 ─────────────────────────────────────────────────────────
await check("D1", "银翘散原文作芥穗：处方用荆芥时注明「荆芥用荆芥穗」（方义不称原方）；处方用荆芥穗时不注", () => {
  const base = ["金银花", "连翘", "桔梗", "薄荷", "淡竹叶", "甘草", "淡豆豉", "牛蒡子", "芦根"];
  const herbs = (names) => names.map((name) => ({ name, dose: "10g", role: "臣" }));
  assert.deepEqual(surface.originalFormulaDeliveryNotes("银翘散", herbs([...base, "荆芥"])), ["荆芥用荆芥穗"]);
  assert.deepEqual(surface.originalFormulaDeliveryNotes("银翘散", herbs([...base, "荆芥穗"])), []);
});

// ─── E 注意事项与治疗卡 ─────────────────────────────────────────────────────────
await check("E1", "病历写明因怀疑过敏而停药：用药史一栏的「自行停药」不再算擅自停药；栏目名不当药名；真的擅自停药照旧", () => {
  const stopped = polarity.selfDiscontinuedMedication;
  // 病历形状照原例（P023）：现病史写明怀疑过敏而停，既往史有慢性病，用药史一栏只写「本次发病后自行停药」。
  assert.equal(stopped("现病史：半月前诊断为“类风湿关节炎”，予以羟氯喹口服治疗，本次发病后怀疑羟氯喹药物过敏，自行停药。停药后症状未见明显好转。\n既往史：类风湿关节炎（半月前诊断）\n用药史：羟氯喹口服，本次发病后自行停药"), undefined);
  // 用药史一栏自己带着病名与药名时，只有「病历别处写明因过敏而停」这一条能拦住。
  assert.equal(stopped("现病史：服羟氯喹后全身瘙痒，怀疑羟氯喹药物过敏，自行停药。\n用药史：类风湿关节炎长期服用羟氯喹，本次发病后自行停药"), undefined);
  assert.deepEqual(stopped("用药史：类风湿关节炎长期服用羟氯喹，本次发病后自行停药")?.names, ["羟氯喹"], "对照：没有过敏记载时照旧算擅自停药");
  const labelOnly = stopped("用药史：羟氯喹口服，本次发病后自行停药");
  assert.ok(!labelOnly || !(labelOnly.names || []).some((name) => /史$/u.test(name)), JSON.stringify(labelOnly));
  assert.deepEqual(stopped("既往高血压，长期服用氨氯地平，近一周自行停用氨氯地平"), { condition: "高血压", names: ["氨氯地平"] });
  assert.equal(stopped("高血压病史8年，1个月前自行停药")?.condition, "高血压");
});

const caseState = (patch) => types.normalizeCaseStateInput({ patient: { sex: "女", age: 30, ...(patch.patient || {}) }, chiefComplaint: "头痛3天", symptoms: { 现病史: patch.present || "头痛3天，无发热" }, tongue: "舌淡红，苔薄白", pulse: "脉弦" });
await check("E2", "55 岁及以上不写孕哺提示；54 岁照旧；病历自己写了怀孕的不受年龄线影响", () => {
  assert.equal(safety.pregnancyAdviceRelevant(caseState({ patient: { age: 58 } })), false);
  assert.equal(safety.pregnancyAdviceRelevant(caseState({ patient: { age: 55 } })), false);
  assert.equal(safety.pregnancyAdviceRelevant(caseState({ patient: { age: 54 } })), true);
  assert.equal(safety.pregnancyAdviceRelevant(caseState({ patient: { age: 34 } })), true);
  assert.equal(safety.pregnancyAdviceRelevant(caseState({ patient: { age: undefined } })), true, "年龄未知的女性照旧（不按高龄处理）");
  assert.equal(safety.pregnancyAdviceRelevant(caseState({ patient: { age: 56 }, present: "头痛3天，现怀孕12周" })), true);
});

await check("E3", "年龄未知的推拿卡按成人印禁忌（不印「小儿推拿：…」一段）；明确未满 14 岁才印", () => {
  assert.doesNotMatch(cards.techniqueContraindications("tuina"), /小儿推拿/u);
  assert.doesNotMatch(cards.techniqueContraindications("tuina", 30), /小儿推拿/u);
  assert.match(cards.techniqueContraindications("tuina", 6), /小儿推拿/u);
  assert.ok(cards.techniqueContraindications("tuina").length > 20);
});

// ─── F 中医鉴别 ─────────────────────────────────────────────────────────────────
await check("F1", "便秘与「泄泻」鉴别：这一行自己否认了泄泻的主症、病历里也没有，算与本例无相似处", () => {
  const unrelated = textbook.tcmDifferentialSelfDeclaredUnrelated;
  assert.equal(unrelated("泄泻", "同属大肠传导失常类病证；本例为排便困难，非便次增多、粪质稀薄", "便秘2天\n舌苔薄腻\n脉弦", "便秘", "同属大肠传导失常类病证"), true);
  assert.equal(unrelated("泄泻", "同属大肠传导失常；本例以便秘半年为主，未诉便次增多或粪质稀薄", "便秘半年\n舌质淡；苔腻\n脉沉细", "便秘", "同属大肠传导失常"), true);
});

await check("F2", "以局部命名的鉴别病（鼻渊）而病历没有该部位任何表现：去掉，教材列为本病鉴别病也一样；有鼻塞的保留", () => {
  const unrelated = textbook.tcmDifferentialSelfDeclaredUnrelated;
  assert.equal(unrelated("鼻渊", "均可见头痛；本例以恶寒咽痛为主，未诉鼻塞浊涕", "头痛、咽痛、恶寒一日\n现病史：头痛、咽痛、恶寒", "感冒", "均可见头痛"), true);
  assert.equal(unrelated("鼻渊", "均以鼻塞为主症；起病一日，未诉浊涕腥臭", "头痛、鼻塞、恶寒，咽痒、咳嗽一日余\n现病史：头痛、鼻塞、咽痒、咳嗽", "感冒", "均以鼻塞为主症"), false);
});

await check("F3", "对照：教材列出的鉴别病、与本例有共同主症的鉴别病不受影响", () => {
  const unrelated = textbook.tcmDifferentialSelfDeclaredUnrelated;
  assert.equal(unrelated("肠结", "均以便闭为主症；本例仅诉便秘5天，病历未记腹痛呕吐", "便秘5天", "便秘", "均以便闭为主症"), false);
  assert.equal(unrelated("肺痨", "均以咳嗽为主症；本例病历未记录咯血、潮热、盗汗、消瘦", "咳嗽\n现病史：咳嗽咳痰", "咳嗽", "均以咳嗽为主症"), false);
  assert.equal(unrelated("郁病", "郁病常以失眠为伴随表现；本例以失眠为主诉，未诉情志抑郁、胸胁胀满", "失眠1月余\n舌质红；苔腻\n脉弦细", "不寐", "郁病常以失眠为伴随表现"), false);
});

// ─── G 其余文字 ─────────────────────────────────────────────────────────────────
await check("G1", "急症提示不带系统内部说法（「本条语义发现不单独形成硬门」）", () => {
  const text = source("lib/clinical-facts.ts");
  assert.ok(!/"[^"\n]*不单独形成硬门[^"\n]*"/u.test(text), "交付的字符串里不能再有这半句（注释里的引述不算）");
  assert.ok(text.includes('? "建议立即由接诊医生现场复核并按复核结果处置"'));
  assert.equal(typeof facts.semanticTriageAdvisoriesFromFacts, "function");
});

await check("G2", "病名改虚脱时，原辨病依据里把虚脱排除掉的分句去掉（不再前面说「与虚脱相区分」、后面定虚脱）", () => {
  const before = {
    stage: "diagnose",
    overview: { tcmDiseaseName: "瘾疹", tcmDiseaseRationale: "进食坚果后迅速出现全身风团；与虚脱之汗出淋漓、脉微欲绝相区分。", primarySyndrome: "风热犯表证", secondarySyndromes: ["阳气虚脱证"] },
    therapy: { overallMethod: "疏风透邪，回阳固脱" },
  };
  const after = JSON.parse(critical.promoteCriticalSecondarySyndrome(JSON.stringify(before)));
  assert.equal(after.overview.tcmDiseaseName, "虚脱");
  assert.equal(after.overview.tcmDiseaseRationale, "进食坚果后迅速出现全身风团；现已见阳气虚脱之象，急则治其标，病名先按虚脱，瘾疹为其起因，待脱证纠正后再论治。");
});

await check("G3", "慎用栏里括号不成对的残句整句去掉，成对的句子原样保留", () => {
  const prescribe = {
    schemaVersion: SCHEMA, stage: "prescribe",
    overview: { tcmDiseaseName: "头痛", primarySyndrome: "血虚证", secondarySyndromes: [] }, therapy: { overallMethod: "养血和络" },
    formula: {
      candidates: [{
        name: "自拟方",
        herbs: [{ name: "当归", dose: "10g", role: "君", function: "补血活血" }, { name: "川芎", dose: "6g", role: "臣", function: "活血行气" }, { name: "蒺藜", dose: "9g", role: "佐", function: "平肝解郁" }],
        formulaAnalysis: "本方为自拟方。当归为君，补血活血；川芎为臣；蒺藜为佐。",
        notApplicable: "蒺藜（毒性：有小毒何首乌（老年人、肝功能不全慎用）。 川芎（月经期慎用）；蒺藜（毒性：有小毒）。",
        decoction: { method: "水煎服，每日1剂，分2次温服。" }, formulaSource: { source: "自拟方" },
      }],
      patentAndWestern: [], modifications: [],
    },
    nonPharma: {},
  };
  assert.equal(project(prescribe).formula.candidates[0].notApplicable, "川芎（月经期慎用）；蒺藜（毒性：有小毒）。");
  const balanced = JSON.parse(JSON.stringify(prescribe));
  balanced.formula.candidates[0].notApplicable = "川芎（月经期慎用）；蒺藜（毒性：有小毒）。";
  assert.equal(project(balanced).formula.candidates[0].notApplicable, "川芎（月经期慎用）；蒺藜（毒性：有小毒）。");
});

await check("G4", "说明书疗程句不带条目编号（「5 服药3天症状无缓解…」）", () => {
  assert.equal(surface.labelCourseBoundary("忌烟酒。5 服药3天症状无缓解，应去医院就诊。儿童慎用"), "服药3天症状无缓解，应去医院就诊。");
  assert.equal(surface.labelCourseBoundary("5、服药3天症状无缓解，应去医院就诊"), "服药3天症状无缓解，应去医院就诊。");
  assert.equal(surface.labelCourseBoundary("忌烟酒。孕妇慎用"), "");
});

// ─── H 提示词 ───────────────────────────────────────────────────────────────────
await check("H1", "加减写作规则：外感新病的乏力、神疲、头晕不加补益药；主方已有同功效药时不为同一主症另加有毒药", () => {
  assert.ok(authoring.AUTHOR_SYSTEM.includes("外感新病（感冒、咳嗽初起）里由外邪引起的乏力、神疲、头晕属 incidental，不加补益药"));
  assert.ok(authoring.AUTHOR_SYSTEM.includes("主方已有同一功效的药时，不再为同一个主症另加有毒的药"));
});

await check("H2", "随访写作规则：复诊重点与疗效标准只提病例资料里已经写到的症状和舌脉", () => {
  const text = source("lib/m05-followup-authoring.server.ts");
  assert.ok(text.includes("reviewFocus 与 efficacyCriteria 里点到的症状，只用下面病例资料里已经写到的症状和舌脉"));
});

if (process.exitCode) console.error("\nr1078-main 有失败项");
