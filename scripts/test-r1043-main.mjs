// 第三十一轮（2026-10-29）：第三十轮留下的两项。
// 1. 一条随症加减的功效方向在开方安全底线里不成立，整张处方退成不给剂量——成品前删行只删「方向对立」，底线连「方向未成立」也拒，
//    两处判据不一。现在两处读同一个 m04ModificationSafetyIssue，底线会拒的行在成品前就单条去掉。
// 2. 耳穴卡挂着体针的「补泻手法、进针深度以现场查体为准」：写了用针做法的耳穴卡改写耳针的刺入深度与刺激强度（《针灸学》耳针法），
//    只用压丸的不写。
// 每条断言都有反证（~/runlogs/r1018/work/r1043/cp/）。
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
const treatments = await jiti.import("../src/lib/tcm-treatment-capabilities.server.ts");
const textbookPlan = await jiti.import("../src/lib/tcm-nondrug-textbook-plan.server.ts");
const knowledge = await jiti.import("../src/lib/tcm-knowledge.ts");

const START = "<!-- DIAGNOSIS_JSON_START -->";
const END = "<!-- DIAGNOSIS_JSON_END -->";
const wrap = (body) => `${START}\n${JSON.stringify(body)}\n${END}`;
const unwrap = (content) => JSON.parse(content.slice(content.indexOf(START) + START.length, content.indexOf(END)));
const evidence = { evidenceLevel: "model_inference", source: "本例资料", confidence: "中" };

// ───── 1 一条加减不成立只去掉这一条 ─────
// 甲方 2026-10-29 实测病例（1 岁女童，咳嗽、咽干伴恶心）回放：证型肺胃气逆证，治法宣肃肺气、和胃降逆；模型加了「若咽痛明显，加黄芩」。
const lungStomachPrior = {
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
  overview: { tcmDiseaseName: "咳嗽", primarySyndrome: "肺胃气逆证", secondarySyndromes: [], overallPathogenesis: "肺失宣肃，胃气上逆", overallTherapy: "宣肃肺气，和胃降逆", primarySyndromeBasis: ["咳嗽、咽干伴恶心"], evidence },
  westernDiagnosis: { primary: { name: "急性上呼吸道感染", supportingFacts: [], evidence }, differentials: [] },
  pathogenesis: { summary: "肺失宣肃", locationDifferentiation: { items: [], evidence }, natureDifferentiation: { items: [], evidence },
    chain: [{ nodeId: "P1", patientFact: "咳嗽、咽干伴恶心", syndromeEvidence: "咳嗽、咽干伴恶心", pathogenesis: "肺失宣肃，胃气上逆", therapyDirection: "宣肃肺气，和胃降逆", evidence }], uncertainties: [] },
  therapy: { overallPrinciple: "实则泻之", overallMethod: "宣肃肺气，和胃降逆", subTherapies: [{ therapy: "宣肃肺气", targetPathogenesis: "肺失宣肃", priority: "主要", evidence }] },
  formula: null, nonPharma: null, lineageAdaptation: null,
};
const heatRow = { trigger: "若咽痛明显、咽部红肿", targetPathogenesis: "热邪上壅咽喉", action: "加", herbName: "黄芩", doseOrHandling: "6g", reason: "清热泻火，利咽" };
const phlegmRow = { trigger: "若痰多色白", targetPathogenesis: "痰浊阻肺", action: "加", herbName: "半夏", doseOrHandling: "6g", reason: "燥湿化痰，降逆止呕" };
const prescription = (modifications, herbs = ["紫菀", "款冬花", "白前", "前胡", "竹茹"]) => ({
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe",
  formula: { candidates: [{ name: "自拟方", herbs: herbs.map((name) => ({ name, dose: "5g", role: "臣" })) }], modifications },
});
const retainedHerbs = (rows, prior = lungStomachPrior, herbs) =>
  unwrap(modSafety.dropUnsupportedM04ModificationDirections(wrap(prescription(rows, herbs)), prior)).formula.modifications.map((item) => item.herbName);

await check("1.1 方向未成立的加减（肺胃气逆证加黄芩清热）：底线拒，成品前也去掉；此前成品前只删方向对立的，这一条留到底线，整方退成不给剂量", () => {
  assert.equal(contract.m04ModificationSafetyIssue(heatRow, lungStomachPrior, () => true), "herb_0_unsupported_high_impact_heat_clear");
  // 旧的删行判据（只看方向对立）放行它：两处判据不一就是整页退成不给剂量的原因。
  assert.equal(contract.m04HerbOpposingDirectionIssue({ name: "黄芩", function: `${heatRow.reason}；${heatRow.targetPathogenesis}` }, lungStomachPrior), undefined);
  assert.deepEqual(retainedHerbs([heatRow, phlegmRow]), ["半夏"]);
});

await check("1.2 底线会拒的其他加减同样单条去掉（理由里夹剂量、未收载的药味），成立的照留；留下的每一条底线都不拒", () => {
  const doseInText = { ...phlegmRow, herbName: "陈皮", reason: "陈皮6克理气化痰" };
  // 不带剂量：带了剂量会先被「剂量不在药典范围」判掉，测不到「未收载」这一层。
  const unknownHerb = { ...phlegmRow, herbName: "神仙草", doseOrHandling: null, reason: "化痰" };
  const kept = retainedHerbs([doseInText, unknownHerb, phlegmRow]);
  assert.deepEqual(kept, ["半夏"]);
  assert.equal(contract.m04ModificationSafetyIssue(doseInText, lungStomachPrior), "unaudited_dose");
  assert.equal(contract.m04ModificationSafetyIssue(unknownHerb, lungStomachPrior, knowledge.isKnownTcmHerbName), "unknown_herb");
  assert.equal(contract.m04ModificationSafetyIssue(phlegmRow, lungStomachPrior, () => true), undefined);
});

// 第十四轮 S044（同 test:r1026-main 的夹具）：外邪犯胃证的教材加减（若见壮热口渴，便秘尿赤，加黄芩、黄连）不核方向。
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
await check("1.3 对照：教材条件式加减（外邪犯胃证「若见壮热口渴，便秘尿赤」加黄芩、黄连）照留；同一条件加不在教材里的石膏仍去掉", () => {
  const textbook = { trigger: "若见壮热口渴，便秘尿赤", targetPathogenesis: "外邪入里化热", action: "加", herbName: "黄芩", doseOrHandling: "9g", reason: "清泄里热" };
  const herbs = ["广藿香", "紫苏叶", "白芷", "半夏曲", "厚朴", "陈皮", "大腹皮", "茯苓", "白术", "桔梗", "炙甘草"];
  assert.deepEqual(retainedHerbs([textbook, { ...textbook, herbName: "石膏", doseOrHandling: "20g", reason: "清热泻火" }], externalAttackPrior, herbs), ["黄芩"]);
});

await check("1.4 开方安全底线逐条加减用的就是这个判据（不另写一份）", () => {
  const source = readFileSync("src/lib/diagnosis-stage-contract.ts", "utf8");
  const floor = source.slice(source.indexOf("export function m04SafetyContractIssue("), source.indexOf("export function m04ModificationSafetyIssue("));
  assert.match(floor, /m04ModificationSafetyIssue\(modification, priorReasoning, isKnownHerbName\)/);
  assert.doesNotMatch(floor, /unsupportedHighImpactHerbIssue\(\[\{\s*name: herbName/);
});

// ───── 2 耳穴卡的操作要点 ─────
const signedPrior = ({ disease, syndrome, method, western, patientFact, pathogenesis }) => ({
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
  contractSignatureVersion: "tcm-cdss-m03-signature-v5", contractSignature: `hmac-sha256:${"a".repeat(64)}`,
  overview: { tcmDiseaseName: disease, primarySyndrome: syndrome, secondarySyndromes: [], overallPathogenesis: pathogenesis, overallTherapy: method, evidence },
  westernDiagnosis: { primary: { name: western, status: "证据有限", confidence: "低", supportingFacts: [], evidence }, differentials: [] },
  pathogenesis: { summary: pathogenesis, locationDifferentiation: { items: [], evidence }, natureDifferentiation: { items: [], evidence }, chain: [{ nodeId: "P1", patientFact, syndromeEvidence: patientFact, pathogenesis, therapyDirection: method, evidence }], uncertainties: [] },
  therapy: { overallPrinciple: method, overallMethod: method, subTherapies: [{ therapy: method, targetPathogenesis: pathogenesis, priority: "主要", evidence }] },
  formula: null, nonPharma: null, lineageAdaptation: null,
});
const caseOf = (chief, present, age) => ({
  patient: { sex: "男", age }, chiefComplaint: chief, symptoms: { presentHistory: present }, vitals: {}, conversation: [],
  safetyGate: { status: "ready", allowDosePrescription: true, redFlags: [], missingItems: [] },
});
// 甲方 2026-10-29 实测的眩晕病例（62 岁，肾精不足证）在生产探针里出了耳穴卡；教材耳穴写「毫针刺法或压丸法」。
process.env.TCM_CLINIC_TREATMENT_CAPABILITIES = "acupuncture,moxibustion,cupping,guasha,auricular,tuina,diet_therapy,qigong_daoyin,mind_therapy";
const vertigoPrior = signedPrior({ disease: "眩晕", syndrome: "肾精不足证", method: "补肾填精", western: "眩晕综合征", pathogenesis: "肾精亏虚，髓海不足", patientFact: "头晕目眩，耳鸣，腰膝酸软" });
const cardsFor = (age) => treatments.compileTcmTreatmentRecommendations(
  ["acupuncture", "auricular"].map((projectCode) => ({ projectCode, targetRef: "P1" })), vertigoPrior,
  caseOf("反复头晕目眩半年", "头晕目眩，耳鸣，腰膝酸软，舌红少苔，脉细", age));

await check("2.1 成人耳穴卡（教材写毫针刺法、埋针、压丸）不写体针的「补泻手法」，写耳针的刺入深度与刺激强度；针刺卡照写（对照）", () => {
  const cards = cardsFor(45);
  const ear = cards.find((card) => card.projectCode === "auricular");
  const needle = cards.find((card) => card.projectCode === "acupuncture");
  assert.ok(ear && /毫针/.test(ear.treatmentContent), `夹具前提：耳穴卡内容有毫针刺法：${ear?.treatmentContent}`);
  assert.doesNotMatch(ear.techniqueBoundary, /补泻手法/, ear.techniqueBoundary);
  assert.match(ear.techniqueBoundary, /刺入深度以0\.1～0\.3cm为宜/, ear.techniqueBoundary);
  assert.match(needle.techniqueBoundary, /补泻手法、进针深度以现场查体为准/);
});

await check("2.2 只用压丸、贴压的耳穴卡不写用针的操作要点；小儿耳穴卡（只用压丸）同样不写", () => {
  assert.equal(textbookPlan.earNeedleBoundary("耳穴取肺、脾、气管、神门。压丸法。"), "");
  assert.match(textbookPlan.earNeedleBoundary("耳穴取肺、脾。每次选用3~5穴，毫针刺法，或埋针法、压丸法。"), /0\.1～0\.3cm/);
  const child = cardsFor(7).find((card) => card.projectCode === "auricular");
  assert.ok(child, "应有耳穴卡");
  assert.doesNotMatch(child.techniqueBoundary, /补泻手法|进针深度|刺入深度/, child.techniqueBoundary);
});

console.log(JSON.stringify({ suite: "r1043-main", cases }));
