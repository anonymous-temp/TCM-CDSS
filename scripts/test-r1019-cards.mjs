// 中医治疗项目卡 r1019 整改（2026-10-19）。
//
// 依据是 10/18 验收集（H 241 例、M 208 例的「中医治疗」模块）与留出集 32 例的独立评审不通过项，逐例回放到出卡函数后定位到的服务端与数据缺陷；
// 回放材料在仓库外 ~/runlogs/r1018/work/r1019/agentH（replay-*.json、diff-*.txt）。每条断言都带反证（把对应改动撤掉后必须变红）。
//
//   1 教材数据：证型名带括注又名（「行痹（风痹）」）时配穴整行丢失；配穴条件与辨证要点写法不同（「热秘」对「热邪壅盛（热秘）」）时丢失；
//     遗尿肺脾气虚配穴的扫描错字「肝腧」；针刺教材节的等价病名（月经后期→月经不调、经行风疹块→隐疹…）
//   2 取穴上限：先保证证型配穴与随症配穴，按部位分组的主穴每个部位都留几穴（S079 膝部一穴不剩、风湿头痛的偏历阴陵泉被截掉）
//   3 年龄：小儿针刺卡不写《刺法灸法学》的「留针10～30分钟」与教材留针时长；老年人不写重刺激、深刺、久留针、留针一小时
//   4 治法：教材写在基本处方前、与本例证候相反的小句不印（虚火牙痛的「祛风泻火」、瘀血阻络的「泻火解毒」、肝郁的「补益肾气」）
//   5 取节：字面相符的节先于国标归一后相符的节（不孕症不再取到男子「不育症」节）；痹证、中风之下西医诊断点名的专节优先（坐骨神经痛、颈椎病、面瘫）；
//     西医诊断去掉急慢性、左右侧后与节名、又名相等时取该节
//   6 随症配穴：是本病另一个虚实相反证型配穴的穴不加（热秘不加关元）；四字症状拆两半时须在同一小句（「双下肢无浮肿」+「肢体不遂」不是下肢不遂）
//   7 食疗：有毒药材用量超过药典上限的食疗方不出；卡片写「适用于素体虚弱」而本例是纯实证时整张不出
//   8 出卡：教材有本病针刺节时，没按证型加减、匹配词与病名无关的院内模板算对的是伴随症状；交付面会去掉的卡不先占名额
//   9 禁忌与人群：舌苔颜色与自觉发热的热象写法不灸；出血倾向或血小板低于 50×10⁹/L 不按揉、不灸、不罐；
//     病历写到皮肤破损、流脓时针灸卡写明避开，骨折只认已签名诊断；病历写明的患儿年龄先于登记的成人年龄；0～36 月龄急性发热期不给健康保健按揉；
//     部位词（颈部、关节）要与不适写在同一小句才算本例表现
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";

process.env.TCM_CLINIC_TREATMENT_CAPABILITIES = "acupuncture,auricular,moxibustion,cupping,tuina,diet_therapy";
delete process.env.TCM_CLINIC_TREATMENT_CAPABILITIES_JSON;

const jiti = createJiti(import.meta.url, {
  alias: {
    "@": `${process.cwd()}/src`,
    "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
  },
});

let cases = 0;
const failures = [];
const check = (name, run) => {
  cases += 1;
  try {
    run();
  } catch (error) {
    failures.push(name);
    console.error(`✗ ${name}\n  ${error instanceof Error ? error.message : String(error)}`);
  }
};

const plan = await jiti.import("../src/lib/tcm-nondrug-textbook-plan.server.ts");
const cap = await jiti.import("../src/lib/tcm-treatment-capabilities.server.ts");
const protocols = JSON.parse(readFileSync(new URL("../src/data/tcm-nondrug-textbook-protocols.json", import.meta.url), "utf8"));

const section = (disease, book) => protocols.acupuncture.find((entry) => entry.disease === disease && (!book || entry.book === book));
const syndrome = (entry, label) => entry?.syndromes.find((item) => item.label === label);
const acupuncture = (input) => plan.textbookTreatmentPlan({ projectCode: "acupuncture", westernNames: [], signedSyndromeText: "", currentFacts: "", ...input });
const names = (result) => (result?.points || []).map((point) => point.name);

// ── 1 教材数据 ─────────────────────────────────────────────────────────────────
check("1.1 痹病：行痹、痛痹、着痹的配穴按教材原句保留（两本教材）", () => {
  const zhiliao = section("痹病", "zhenjiu_zhiliao");
  assert.deepEqual(syndrome(zhiliao, "行痹")?.addPoints, ["膈俞", "血海"]);
  assert.deepEqual(syndrome(zhiliao, "痛痹")?.addPoints, ["肾俞", "关元"]);
  assert.deepEqual(syndrome(zhiliao, "着痹")?.addPoints, ["阴陵泉", "足三里"]);
  assert.equal(syndrome(zhiliao, "行痹")?.alias, "风痹");
  assert.match(syndrome(zhiliao, "行痹")?.keySymptoms || "", /游走/);
  const xue = section("痹证", "zhenjiu_xue");
  assert.deepEqual(syndrome(xue, "痛痹")?.addPoints, ["肾俞", "腰阳关"]);
});

check("1.2 配穴条件按括注又名归到辨证要点的证型（《针灸学》便秘「热邪壅盛（热秘）」配合谷、内庭）", () => {
  const xue = section("便秘", "zhenjiu_xue");
  assert.deepEqual(syndrome(xue, "热邪壅盛")?.addPoints, ["合谷", "内庭"]);
  assert.equal(syndrome(xue, "热邪壅盛")?.alias, "热秘");
});

check("1.3 遗尿肺脾气虚配肺俞、脾俞（扫描件「肝腧」为错字）", () => {
  const entry = section("遗尿", "zhenjiu_zhiliao");
  assert.deepEqual(syndrome(entry, "肺脾气虚")?.addPoints, ["肺俞", "脾俞"]);
  assert.ok(!JSON.stringify(entry).includes("肝俞"), "遗尿节不得再出现肝俞");
});

check("1.4 针刺教材节的等价病名（月经后期→月经不调、经行风疹块→隐疹、产后小便不通→癃闭、青盲→视神经萎缩）", () => {
  assert.ok(section("月经不调", "zhenjiu_zhiliao").aliases.includes("月经后期"));
  assert.ok(section("隐疹", "zhenjiu_zhiliao").aliases.includes("经行风疹块"));
  assert.ok(section("癃闭", "zhenjiu_zhiliao").aliases.includes("产后小便不通"));
  assert.ok(section("视神经萎缩", "zhenjiu_zhiliao").aliases.includes("青盲"));
  const later = acupuncture({ diseaseNames: ["月经后期"], signedSyndromeText: "气滞证", currentFacts: "月经40天左右一次，经行不畅，小腹胀痛" });
  assert.ok(later, "月经后期应取到月经不调节");
  assert.deepEqual(names(later).slice(0, 3), ["气海", "归来", "三阴交"], "取月经后期那一套主穴");
  assert.ok(names(acupuncture({ diseaseNames: ["经行风疹块"], currentFacts: "经行风疹" })).includes("曲池"));
});

// ── 2 取穴上限 ─────────────────────────────────────────────────────────────────
check("2.1 痹证行痹，肩肘腕膝四处痛：膝部有穴，行痹配膈俞、血海不被截掉（留出例 S079）", () => {
  const result = acupuncture({ diseaseNames: ["痹证"], signedSyndromeText: "行痹", currentFacts: "出现双肩、双肘、双膝及腕关节疼痛，今天这个关节痛、明天那个关节痛，位置游走不定" });
  const points = names(result);
  assert.ok(points.length <= 12);
  assert.ok(points.some((point) => ["血海", "梁丘", "膝眼", "阳陵泉"].includes(point)), `膝部无穴：${points.join("、")}`);
  assert.ok(points.includes("膈俞"), `行痹配穴缺失：${points.join("、")}`);
  assert.match(result.treatmentContent, /本例属行痹，在主穴基础上加膈俞、血海/);
});

check("2.2 风湿头痛：头痛节 20 个主穴时证型配穴偏历、阴陵泉仍在穴位里", () => {
  const result = acupuncture({ diseaseNames: ["头痛"], signedSyndromeText: "风湿头痛", currentFacts: "头痛如裹，痛无休止，肢体困重，苔白腻，脉濡" });
  assert.ok(names(result).includes("阴陵泉") && names(result).includes("偏历"), names(result).join("、"));
  assert.ok(result.points.some((point) => point.role === "syndrome_refinement"));
});

check("2.3 痹证着痹（肘）：加阴陵泉、足三里", () => {
  const result = acupuncture({ diseaseNames: ["痹证"], signedSyndromeText: "着痹", currentFacts: "肘关节肌肉酸痛重着不移，伴有肿胀，肌肤麻木不仁，阴雨天加重" });
  assert.ok(names(result).includes("阴陵泉") && names(result).includes("足三里"), names(result).join("、"));
});

// ── 3 年龄 ─────────────────────────────────────────────────────────────────────
check("3.1 8 岁遗尿：针刺卡疗程不写「留针10～30分钟」；成人对照照写", () => {
  const child = acupuncture({ diseaseNames: ["遗尿"], signedSyndromeText: "肺脾气虚证", currentFacts: "疲劳后遗尿加重，面色萎黄，容易感冒，大便稀", patientAgeYears: 8 });
  assert.doesNotMatch(child.scheduleSuggestion, /留针/);
  assert.ok(names(child).includes("肺俞") && !names(child).includes("肝俞"), names(child).join("、"));
  const adult = acupuncture({ diseaseNames: ["遗尿"], signedSyndromeText: "肺脾气虚证", currentFacts: "疲劳后遗尿加重，面色萎黄，容易感冒，大便稀", patientAgeYears: 30 });
  assert.match(adult.scheduleSuggestion, /留针10～30分钟/);
});

check("3.2 年龄小句：小儿去留针时长，老年去重刺激、深刺、久留针、留针一小时；「不可深刺」照留；成人不动", () => {
  assert.equal(plan.operationClausesForAge("主穴用泻法，痛甚时可延长留针时间至1小时。", 8), "主穴用泻法。");
  assert.equal(plan.operationClausesForAge("毫针泻法。针刺时宜先取远端穴，用重刺激手法，局部穴宜深刺、久留针。", 66), "毫针泻法。针刺时宜先取远端穴。");
  assert.equal(plan.operationClausesForAge("毫针刺，每次留针1小时。或用压丸法。", 79), "毫针刺。或用压丸法。");
  assert.equal(plan.operationClausesForAge("肺俞、中府不可直刺、深刺，以免伤及内脏。", 70), "肺俞、中府不可直刺、深刺，以免伤及内脏。");
  assert.equal(plan.operationClausesForAge("用重刺激手法，局部穴宜深刺、久留针。", 40), "用重刺激手法，局部穴宜深刺、久留针。");
});

// ── 4 治法 ─────────────────────────────────────────────────────────────────────
check("4.1 治法小句与证候相反时不印；与证候不冲突的照印", () => {
  assert.equal(plan.therapyClausesForSyndrome("祛风泻火，通络止痛。取手足阳明经穴为主", "虚火牙痛"), "通络止痛。取手足阳明经穴为主");
  assert.equal(plan.therapyClausesForSyndrome("泻火解毒，清热利湿。取局部穴位及相应夹脊穴为主", "气滞血瘀证；瘀血阻络"), "取局部穴位及相应夹脊穴为主");
  assert.equal(plan.therapyClausesForSyndrome("补益肾气，荣养宗筋。取任脉穴及肾的背俞穴、原穴为主", "肝气郁结证"), "取任脉穴及肾的背俞穴、原穴为主");
  assert.equal(plan.therapyClausesForSyndrome("平肝潜阳，和胃化痰。取督脉、足厥阴、足阳明经穴为主", "肝阳上亢证", true), "平肝潜阳。取督脉、足厥阴、足阳明经穴为主");
  assert.equal(plan.therapyClausesForSyndrome("平肝潜阳，和胃化痰。取督脉、足厥阴、足阳明经穴为主", "痰湿中阻证", true), "和胃化痰。取督脉、足厥阴、足阳明经穴为主");
  // 对照：病的总治法与证候不冲突时一字不动
  for (const [therapy, syndromeText] of [
    ["益肾固摄，调理膀胱。取任脉穴及膀胱的背俞穴、募穴为主", "肺脾气虚证"],
    ["清热利湿，润燥息风。取皮损局部和足太阴经穴为主", "脾虚湿蕴证"],
    ["滋阴降火，利咽止痛。取足少阴经穴为主", "肺肾阴虚证"],
    ["泻火解毒，清热利湿。取局部穴位及相应夹脊穴为主", "肝经郁热证"],
  ]) assert.equal(plan.therapyClausesForSyndrome(therapy, syndromeText), therapy, `${syndromeText} 不应删句`);
  const card = acupuncture({ diseaseNames: ["牙痛"], signedSyndromeText: "虚火上炎证", currentFacts: "右上齿痛半年，隐隐作痛，时作时止" });
  assert.doesNotMatch(card.treatmentContent, /祛风泻火/);
});

// ── 5 取节 ─────────────────────────────────────────────────────────────────────
check("5.1 不孕症取不孕症节，不取男子不育症节", () => {
  const result = acupuncture({ diseaseNames: ["不孕症"], signedSyndromeText: "痰湿内阻证", currentFacts: "未避孕，输卵管不通" });
  assert.match(result.protocolSource, /「不孕症」节/);
  assert.doesNotMatch(result.protocolSource, /不育症/);
});

check("5.2 痹证之下的专节：坐骨神经痛、神经根型颈椎病；周围性面瘫被写成中风时取面瘫节；对照照旧", () => {
  const sciatica = acupuncture({ diseaseNames: ["痹证"], westernNames: ["坐骨神经痛"], signedSyndromeText: "痛痹", currentFacts: "下肢后侧放射性疼痛，畏寒肢冷" });
  assert.ok(["秩边", "委中", "承山"].every((point) => names(sciatica).includes(point)), names(sciatica).join("、"));
  const neck = acupuncture({ diseaseNames: ["痹证"], westernNames: ["神经根型颈椎病"], signedSyndromeText: "痛痹", currentFacts: "颈背部疼痛伴左上肢麻木疼痛" });
  assert.ok(names(neck).includes("颈夹脊") && !names(neck).includes("腰阳关"), names(neck).join("、"));
  const palsy = acupuncture({ diseaseNames: ["中风"], westernNames: ["周围性面神经麻痹"], signedSyndromeText: "风痰阻络证", currentFacts: "右侧口角歪斜，额纹消失" });
  assert.ok(names(palsy).includes("颊车") && !names(palsy).includes("水沟"), names(palsy).join("、"));
  // 对照：脑梗死的中风仍是醒脑开窍；类风湿关节炎的痹证仍是痹病节；中枢性面瘫不换节
  assert.ok(names(acupuncture({ diseaseNames: ["中风"], westernNames: ["脑梗死"], signedSyndromeText: "风痰阻络证", currentFacts: "左侧肢体无力" })).includes("水沟"));
  assert.ok(names(acupuncture({ diseaseNames: ["中风"], westernNames: ["中枢性面瘫"], signedSyndromeText: "风痰阻络证", currentFacts: "口角歪斜" })).includes("水沟"));
  assert.match(acupuncture({ diseaseNames: ["痹证"], westernNames: ["类风湿关节炎"], signedSyndromeText: "热痹", currentFacts: "双膝关节红肿热痛" }).protocolSource, /「痹病」节/);
});

check("5.3 西医诊断去掉急性、左右侧后等于教材节名或又名：急性右踝关节外侧韧带扭伤取踝关节扭伤节", () => {
  const ankle = acupuncture({ diseaseNames: ["筋伤"], westernNames: ["急性右踝关节外侧韧带扭伤"], signedSyndromeText: "气滞血瘀证", currentFacts: "右踝关节肿痛" });
  assert.ok(ankle && names(ankle).includes("丘墟"), names(ankle).join("、"));
  // 对照：只是包含、不相等的不算（女性性功能障碍 ≠ 性功能障碍节）
  assert.equal(acupuncture({ diseaseNames: ["虚劳"], westernNames: ["女性性功能障碍"], signedSyndromeText: "肾气虚证", currentFacts: "性欲减退" }), undefined);
});

// ── 6 随症配穴 ─────────────────────────────────────────────────────────────────
check("6.1 热秘＋大便干结：加下巨虚、不加关元（关元是同节虚秘的配穴）；脾胃虚弱泄泻＋水样便照加关元（关元也是肾阳虚衰的配穴）", () => {
  const hot = acupuncture({ diseaseNames: ["便秘"], signedSyndromeText: "热秘", currentFacts: "大便干结，三四日一行，口干口臭，尿赤，舌红苔黄燥" });
  assert.ok(names(hot).includes("下巨虚") && !names(hot).includes("关元"), names(hot).join("、"));
  const loose = acupuncture({ diseaseNames: ["泄泻"], signedSyndromeText: "脾胃虚弱证", currentFacts: "腹泻20余日，为水样便，面黄，纳少，神疲" });
  assert.ok(names(loose).includes("关元"), names(loose).join("、"));
});

check("6.2 四字症状拆两半须在同一小句：「双下肢无浮肿」＋「左侧肢体不遂」不是下肢不遂", () => {
  const facts = "左侧肢体不遂，言语欠清；双下肢浮肿不明显";
  const result = acupuncture({ diseaseNames: ["中风"], signedSyndromeText: "气虚络瘀", currentFacts: facts });
  assert.ok(!names(result).includes("环跳"), names(result).join("、"));
  const real = acupuncture({ diseaseNames: ["中风"], signedSyndromeText: "气虚络瘀", currentFacts: "左侧下肢活动不遂" });
  assert.ok(names(real).includes("环跳"), names(real).join("、"));
  // 前一半只写了首字的同义写法照算：「腹型肥胖」即教材的「腹部肥胖」（验收集 M-TCM-SD-488343）
  const obesity = acupuncture({ diseaseNames: ["肥胖症"], signedSyndromeText: "痰湿内盛证", currentFacts: "病程中：腹型肥胖，颈项部皮肤粗糙" });
  assert.ok(names(obesity).includes("归来"), names(obesity).join("、"));
  // 后一半是「疼痛」这类泛词时不放宽：「腰部疼痛」不是「腰骶疼痛」，「腰骶部疼痛」才是
  const lumbar = acupuncture({ diseaseNames: ["腰痛"], signedSyndromeText: "瘀血腰痛", currentFacts: "腰部疼痛1月余，搬重物后加重，痛处固定" });
  assert.ok(!names(lumbar).includes("腰俞"), names(lumbar).join("、"));
  const sacral = acupuncture({ diseaseNames: ["腰痛"], signedSyndromeText: "瘀血腰痛", currentFacts: "腰骶部疼痛1月余，痛处固定" });
  assert.ok(names(sacral).includes("腰俞"), names(sacral).join("、"));
});

// ── 7 食疗与适用证型 ───────────────────────────────────────────────────────────
check("7.1 有毒或孕期高风险药材超药典用量的食疗方不出（葱耳蒜粥 桃仁15～30g）；食材按食物量的方子照出", () => {
  assert.equal(plan.recipeExceedsHighRiskHerbDose("洋葱50～100g，大蒜1头，桃仁15～30g，将以上食物放入锅内煎煮30分钟以上，用煎煮后的汁液煮粥食用。"), true);
  assert.equal(plan.recipeExceedsHighRiskHerbDose("将山药20g（鲜品50g）洗净捣碎或切片，与小米50g同煮，快熟时加入冰糖3g，调匀。"), false);
  assert.equal(plan.recipeExceedsHighRiskHerbDose("苦杏仁6g，粳米50g，煮粥。"), false);
  const diet = plan.textbookTreatmentPlan({ projectCode: "diet_therapy", diseaseNames: ["腰痛"], westernNames: [], signedSyndromeText: "瘀血腰痛", currentFacts: "腰痛如针刺" });
  assert.doesNotMatch(diet?.treatmentContent || "", /桃仁15/);
});

check("7.2 卡片写「适用于素体虚弱的患者」：纯实证不出，虚证照出", () => {
  const text = "阿是穴、肾俞、次髎。用艾条悬灸或隔姜灸。适用于素体虚弱的患者。";
  assert.equal(plan.cardApplicabilityExcludesSyndrome(text, ["腰痛"], "瘀血腰痛证"), true);
  assert.equal(plan.cardApplicabilityExcludesSyndrome(text, ["腰痛"], "肾阳虚证"), false);
});

// ── 8 出卡 ─────────────────────────────────────────────────────────────────────
const signedPrior = (disease, syndromeText, fact, western = disease) => ({
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
  contractSignatureVersion: "tcm-cdss-m03-signature-v5", contractSignature: `hmac-sha256:${"a".repeat(64)}`,
  overview: { tcmDiseaseName: disease, primarySyndrome: syndromeText, primarySyndromeResolution: "resolved", primarySyndromeBasis: [], overallPathogenesis: fact },
  westernDiagnosis: { primary: { name: western, supportingFacts: [] } },
  therapy: { overallPrinciple: "", overallMethod: "", subTherapies: [] },
  pathogenesis: { chain: [{ nodeId: "P1", patientFact: fact, syndromeEvidence: syndromeText, pathogenesis: fact, therapyDirection: "" }], uncertainties: [] },
});
const compile = (prior, chief, present, proposals, patient = { sex: "女", age: 60 }, extra = {}) => cap.compileTcmTreatmentRecommendations(
  proposals, prior, { chiefComplaint: chief, symptoms: { 现病史: present }, patient, safetyGate: { status: "ready", redFlags: [] }, ...extra });

check("8.1 癃闭病例主诉里写着大便秘结：针刺、耳穴取癃闭教材方案，不取便秘模板（验收集 H-tri-2227）", () => {
  const cards = compile(signedPrior("癃闭", "膀胱气化不利证", "尿潴留1个多月", "神经源性膀胱"),
    "尿潴留1个多月。跌倒当晚即出现尿潴留和大便秘结", "跌倒当晚即出现尿潴留和大便秘结，大便已通畅，尿潴留未见改善",
    [{ projectCode: "acupuncture", targetRef: "P1" }, { projectCode: "auricular", targetRef: "P1" }]);
  const needle = cards.find((item) => item.projectCode === "acupuncture");
  const ear = cards.find((item) => item.projectCode === "auricular");
  assert.ok(needle?.suggestedSitesOrPoints.some((site) => site.startsWith("中极")), JSON.stringify(needle?.suggestedSitesOrPoints));
  assert.ok(!needle.suggestedSitesOrPoints.some((site) => site.startsWith("中脘")));
  assert.ok(ear?.suggestedSitesOrPoints.includes("膀胱"), JSON.stringify(ear?.suggestedSitesOrPoints));
});

check("8.2 交付面会去掉的卡（仅评估、只有治则、无穴类目模板）判为不可交付；教材卡可交付", () => {
  assert.equal(cap.treatmentCardUndeliverable({ projectCode: "tuina", tailoringStatus: "class_template_only", treatmentContent: "治则：舒筋通络。手法：按法。", suggestedSitesOrPoints: ["肾俞"] }), true);
  assert.equal(cap.treatmentCardUndeliverable({ projectCode: "acupuncture", tailoringStatus: "assessment_only", treatmentContent: "" }), true);
  assert.equal(cap.treatmentCardUndeliverable({ projectCode: "diet_therapy", tailoringStatus: "class_template_only", treatmentContent: "按本病常规选用食疗", suggestedSitesOrPoints: [] }), true);
  assert.equal(cap.treatmentCardUndeliverable({ projectCode: "auricular", tailoringStatus: "class_template_only", treatmentContent: "取患侧腰骶椎、肾、膀胱、神门。", suggestedSitesOrPoints: ["肾"] }), false);
});

check("8.3 名额先给可交付的卡：瘀血腰痛的推拿卡只有一段治则（交付面会去掉），不得占掉教材耳穴卡的名额（验收集 H-tri-7669 两节点病机）", () => {
  const prior = signedPrior("腰痛", "瘀血腰痛", "闪挫致腰部气血壅滞，瘀阻经络", "第三腰椎横突综合征");
  prior.therapy = { overallPrinciple: "实则泻之", overallMethod: "活血化瘀，通络止痛", subTherapies: [] };
  prior.pathogenesis.chain = [
    { nodeId: "P1", patientFact: "4天前因搬重物后腰部疼痛加重", syndromeEvidence: "左侧第三腰椎横突处有明显的局限性压痛", pathogenesis: "闪挫致腰部气血壅滞，瘀阻经络", therapyDirection: "活血化瘀，通络止痛" },
    { nodeId: "P2", patientFact: "腰部俯仰及转侧活动受限", syndromeEvidence: "尖端处可触及到一条索状物和硬结", pathogenesis: "瘀血结聚腰部筋络，经气不利", therapyDirection: "舒筋散结，行气通络" },
  ];
  const present = "腰部疼痛1月余，加重4天。4天前因搬重物后腰部疼痛加重，左侧疼痛为甚，腰部俯仰及转侧活动受限，翻身困难。舌暗，苔薄白，脉弦。左侧第三腰椎横突处有明显的局限性压痛";
  const cards = compile(prior, "腰部疼痛1月余，加重4天", present,
    [{ projectCode: "acupuncture", targetRef: "P2" }, { projectCode: "cupping", targetRef: "P1" }, { projectCode: "auricular", targetRef: "P1" }], { sex: "男", age: 45 });
  assert.ok(cards.every((card) => !cap.treatmentCardUndeliverable(card)), cards.map((card) => `${card.projectCode}:${card.tailoringStatus}`).join("、"));
  assert.ok(cards.some((card) => card.projectCode === "auricular"), cards.map((card) => card.projectCode).join("、"));
});

check("8.4 青盲按教材病名准入，给出视神经萎缩节的针刺卡（此前青盲对不上任何教材节，一张针刺卡都没有）", () => {
  const fact = "双眼视物昏蒙4个月，加重2个月，眼底视盘色淡";
  const cards = compile(signedPrior("青盲", "气血两虚证", fact, "视神经炎"), "双眼视物昏蒙4个月", fact, [], { sex: "男", age: 45 });
  const needle = cards.find((card) => card.projectCode === "acupuncture");
  assert.ok(needle?.suggestedSitesOrPoints.some((site) => site.startsWith("球后")), JSON.stringify(cards.map((card) => card.projectCode)));
});

// ── 9 禁忌与人群 ───────────────────────────────────────────────────────────────
check("9.1 苔薄黄、舌尖微红、心口烦热：灸法不进候选；舌淡红苔薄白不受影响", () => {
  const heat = signedPrior("不寐", "心脾两虚证", "失眠多梦");
  for (const present of ["失眠多梦，舌淡，苔薄黄，脉数", "失眠，苔微黄少津，舌尖微红", "失眠心悸，常觉心口烦热，大便干结"]) {
    assert.ok(cap.tcmTreatmentProjectExclusionReason("moxibustion", heat, { chiefComplaint: "失眠", symptoms: { 现病史: present } }), present);
  }
  assert.equal(cap.tcmTreatmentProjectExclusionReason("moxibustion", heat, { chiefComplaint: "失眠", symptoms: { 现病史: "失眠多梦，神疲乏力，舌淡红，苔薄白，脉细" } }), undefined);
});

check("9.2 出血倾向：血小板28×10⁹/L、原发免疫性血小板减少症不按揉、不灸、不罐；针刺不因此排除；血小板正常不受影响", () => {
  assert.equal(cap.bleedingTendencyRecorded("2020-09-15复查血常规示血小板28*109/L"), true);
  assert.equal(cap.bleedingTendencyRecorded("诊断为原发免疫性血小板减少症"), true);
  assert.equal(cap.bleedingTendencyRecorded("血常规：血小板计数 245×10^9/L"), false);
  const prior = signedPrior("血证", "气不摄血证", "皮肤出血点反复发作");
  const caseState = { chiefComplaint: "皮肤出血点8年", symptoms: { 现病史: "双下肢出血点反复发作，诊断为原发免疫性血小板减少症" } };
  for (const code of ["tuina", "moxibustion", "cupping"]) assert.match(cap.tcmTreatmentProjectExclusionReason(code, prior, caseState) || "", /出血倾向/, code);
  assert.doesNotMatch(cap.tcmTreatmentProjectExclusionReason("acupuncture", prior, caseState) || "", /出血倾向/);
});

check("9.3 皮肤破损、流脓写进针灸卡；骨折只认已签名诊断（「X线排除骨折」不算）", () => {
  assert.match(cap.localSiteCardNote("acupuncture", "颜面部多处流脓结痂，部分形成窦道"), /避开皮损/);
  assert.equal(cap.localSiteCardNote("acupuncture", "右踝肿痛，X线排除骨折", ["筋伤", "踝关节扭伤"]), "");
  assert.match(cap.localSiteCardNote("acupuncture", "右小腿肿痛", ["骨折病", "右侧胫骨上段骨折"]), /骨折/);
  assert.equal(cap.localSiteCardNote("auricular", "流脓"), "");
});

check("9.7 颜面穴位的拔罐卡不写刺络放血（面瘫：取阳白、颧髎、地仓、颊车，行闪罐、走罐或刺络拔罐）；背部、远端与目眶颞侧穴照写", () => {
  const face = plan.textbookTreatmentPlan({ projectCode: "cupping", diseaseNames: ["面瘫"], westernNames: [], signedSyndromeText: "风寒外袭", currentFacts: "右侧口角歪斜，额纹消失", patientAgeYears: 13 });
  assert.ok(face && names(face).includes("颊车"));
  assert.doesNotMatch(`${face.treatmentContent}${face.techniqueBoundary}`, /刺络|放血|三棱针/);
  assert.match(face.treatmentContent, /闪罐、走罐/);
  const back = plan.textbookTreatmentPlan({ projectCode: "cupping", diseaseNames: ["腰痛"], westernNames: [], signedSyndromeText: "瘀血腰痛", currentFacts: "腰部刺痛，痛处固定", patientAgeYears: 40 });
  assert.match(`${back.treatmentContent}${back.techniqueBoundary}`, /刺络拔罐/);
  // 颜面穴位上只有放血一种做法的项目（面痛拔罐「用三棱针点刺后拔罐」）去掉放血后没有做法：整张不出
  assert.equal(plan.textbookTreatmentPlan({ projectCode: "cupping", diseaseNames: ["面痛"], westernNames: [], signedSyndromeText: "风火上扰证", currentFacts: "右侧面颊阵发性剧痛" }), undefined);
  // 点名到别处穴位的放血照留（牙痛「内庭可点刺出血」；麦粒肿「攒竹、太阳、厉兑均可点刺出血」是眼病常规）
  const tooth = acupuncture({ diseaseNames: ["牙痛"], signedSyndromeText: "胃火牙痛", currentFacts: "牙痛剧烈，牙龈红肿，口臭，便秘" });
  assert.match(tooth.techniqueBoundary, /内庭可点刺出血/);
  const stye = acupuncture({ diseaseNames: ["麦粒肿"], signedSyndromeText: "风热客睑证", currentFacts: "眼睑红肿痒痛" });
  assert.match(stye?.techniqueBoundary || "", /太阳.*点刺出血/);
});

check("9.4 病历写明「患儿，8个月」而登记年龄是成人：针刺卡按小儿写", () => {
  const cards = compile(signedPrior("泄泻", "脾胃虚弱证", "腹泻20余日"), "患儿，8个月，腹泻20余日", "患儿，8个月，腹泻20余日，为黄绿色水样便",
    [{ projectCode: "acupuncture", targetRef: "P1" }], { sex: "男", age: 45 });
  const needle = cards.find((item) => item.projectCode === "acupuncture");
  assert.match(needle?.techniqueBoundary || "", /小儿针刺/);
});

check("9.5 部位词要与不适同在一小句：查体「颈部对称」「踝关节X线示」不算本例表现", () => {
  assert.ok(!cap.indicationEvidenceTerms("musculoskeletal_pain", "颈部对称，无青筋暴露；右膝及踝关节X线示骨折").some((term) => /颈部|关节/.test(term)));
  assert.ok(cap.indicationEvidenceTerms("musculoskeletal_pain", "颈部疼痛伴活动受限").includes("颈部"));
});

check("9.6 0～36 月龄急性发热期不给健康保健按揉；「手足心发热」不是发热", () => {
  const wrap = (reasoning) => `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(reasoning)}\n<!-- DIAGNOSIS_JSON_END -->`;
  const read = (content) => JSON.parse(content.slice(content.indexOf("-->") + 3, content.lastIndexOf("<!--")).trim());
  const prior = signedPrior("积滞", "脾虚夹积证", "不思饮食");
  const prescribe = { stage: "prescribe", nonPharma: { diet: "", lifestyle: "", emotion: "", acupointCare: null, tcmTreatments: [], precautions: [] } };
  const run = (present) => read(cap.applyTcmTreatmentCapabilityPriority(wrap(prescribe), {
    chiefComplaint: "不思饮食半月", symptoms: { 现病史: present }, patient: { sex: "女", age: 2 },
    safetyGate: { status: "ready", redFlags: [], candidateMode: "full_dose", allowDosePrescription: true },
  }, prior)).nonPharma.acupointCare;
  assert.equal(run("不思饮食半月，昨日起发热，体温38.5℃"), null);
  assert.ok(run("不思饮食半月，夜间手足心发热，大便干"), "手足心热不是发热，应照给月龄保健");
});

console.log(JSON.stringify({ suite: "test-r1019-cards", cases, failed: failures.length, failures }, null, 2));
if (failures.length > 0) process.exit(1);
