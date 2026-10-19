// 中医治疗项目卡、食疗卡与居家保健 r1019 第五轮后半（2026-10-19，Claude 评审 21b9bef 的 H 集 330 例与 M 集「中医治疗」不合格项里的服务端缺陷）。
//
// 每条断言都带对照（不该变的输入保持不变）；反证记录在 ~/runlogs/r1018/work/r1019/counterproofs.txt（前缀 5/cards/）。
// 回放材料：~/runlogs/r1018/work/r1019/cards5（replay4.mjs、run.sh、scan.py、pre-k.json / s10-k.json、diff-pre-s8.txt）。
//
//   1 配穴句的型与本例一致：病名就是教材里的一型（石淋）时按它取；证名同时对上几型（风寒湿痹对行痹、痛痹、着痹）时要病历写出这一型自己的表现
//   2 按部位取穴：坐骨神经痛、落枕按教材专节的定义表现与急性颈肌病认；足背不是脊背；手足、袜套样算下肢；踝扭伤只写内踝时取内踝一侧
//   3 骨折与面部疮疡：已签名骨折时取局部的针、灸、罐卡不出；面部疮疡（鼻骨旁、颊部）不取阿是穴、不散刺出血
//   4 补泻与灸：「温针灸」是施灸；寒证不写不带条件的放血；教材把补泻落到配穴上时通用的泻法说的是主穴
//   5 模板与主症：痿证节只给有肢体痿弱的病历；排刺只给有肌肉萎缩的；斜视按麻痹的眼外肌配眼周穴；分套治法的脏腑与本例不符时不印
//   6 卡内残句：小儿不写电针；病历无囊肿不印囊肿操作；疱疹已愈不出写给疱疹的灸卡；本项目已写时长时不并列总论时长
//   7 孕期提示列卡上全部孕期敏感穴（含至阴、腰夹脊；承山的「肌腹」不是腹部）
//   8 食疗：毛蛋不出、油煎算肥甘；并列忌口里的浓茶算忌茶；糖尿病患者的食疗卡不写「糖尿病请先咨询医生」
//   9 灸卡写明糖尿病、感觉减退的烫伤风险
//  10 居家保健：外伤造成的瘀滞不推血瘀质、气郁质
import assert from "node:assert/strict";
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
const acupoints = await jiti.import("../src/lib/tcm-acupoints.ts");
const home = await jiti.import("../src/lib/home-acupoint-care.server.ts");

const acupuncture = (input) => plan.textbookTreatmentPlan({ projectCode: "acupuncture", westernNames: [], signedSyndromeText: "", currentFacts: "", ...input });
const project = (projectCode, input) => plan.textbookTreatmentPlan({ projectCode, westernNames: [], signedSyndromeText: "", currentFacts: "", ...input });
const names = (result) => (result?.points || []).map((point) => point.name);
const signedPrior = (disease, syndromeText, fact, western = disease, therapy = {}) => ({
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
  contractSignatureVersion: "tcm-cdss-m03-signature-v5", contractSignature: `hmac-sha256:${"a".repeat(64)}`,
  overview: { tcmDiseaseName: disease, primarySyndrome: syndromeText, secondarySyndromes: [], primarySyndromeResolution: "resolved", primarySyndromeBasis: [], overallPathogenesis: fact },
  westernDiagnosis: { primary: { name: western, supportingFacts: [] } },
  therapy: { overallPrinciple: "", overallMethod: "", subTherapies: [], ...therapy },
  pathogenesis: { chain: [{ nodeId: "P1", patientFact: fact, syndromeEvidence: syndromeText, pathogenesis: fact, therapyDirection: "" }], uncertainties: [], natureDifferentiation: { items: [] } },
});
const compile = (prior, chief, present, proposals, patient = { sex: "男", age: 45 }) => cap.compileTcmTreatmentRecommendations(
  proposals, prior, { chiefComplaint: chief, symptoms: { 现病史: present }, patient, safetyGate: { status: "ready", redFlags: [] } });
const card = (cards, code) => cards.find((item) => item.projectCode === code);
const bare = (sites) => (sites || []).map((site) => String(site).replace(/（.*$/u, ""));

// ── 1 配穴句的型 ───────────────────────────────────────────────────────────────
check("1.1 病名「石淋」就是淋证节的一型：按石淋加秩边、水道、委阳，不因湿热蕴结证的「热」写「本例属热淋，加委中、行间」（H-tri-796）；病名淋证、病历小便灼热刺痛时照取热淋（对照）", () => {
  const stone = acupuncture({ diseaseNames: ["石淋"], signedSyndromeText: "湿热蕴结证", currentFacts: "突发左侧腰腹绞痛，伴小便艰涩疼痛" });
  assert.match(stone.treatmentContent, /本例属石淋，在主穴基础上加秩边、水道、委阳/u, stone.treatmentContent);
  assert.ok(!names(stone).includes("委中") && !names(stone).includes("行间"), JSON.stringify(names(stone)));
  const heat = acupuncture({ diseaseNames: ["淋证"], signedSyndromeText: "湿热蕴结证", currentFacts: "小便短数，灼热刺痛，尿色黄赤" });
  assert.match(heat.treatmentContent, /本例属热淋/u, heat.treatmentContent);
});

check("1.2 风寒湿痹证同时对上行痹、痛痹、着痹：病历只有「恶风畏寒」这类各型共有的字样时不写「本例属行痹，加膈俞、血海」（X-H-0171）；写了疼痛游走、痛无定处时取行痹（对照）；风热犯表证只对上风热一型，共有症状照算（对照）", () => {
  const neck = acupuncture({ diseaseNames: ["痹证"], signedSyndromeText: "风寒湿痹证", currentFacts: "颈项强痛，活动受限，项背牵拉痛，兼见恶风畏寒" });
  assert.doesNotMatch(neck.treatmentContent, /本例属/u, neck.treatmentContent);
  assert.ok(!names(neck).includes("膈俞") && !names(neck).includes("血海"), JSON.stringify(names(neck)));
  const wandering = acupuncture({ diseaseNames: ["痹证"], signedSyndromeText: "风寒湿痹证", currentFacts: "四肢关节疼痛游走，痛无定处，恶风" });
  assert.match(wandering.treatmentContent, /本例属行痹/u, wandering.treatmentContent);
  const cold = acupuncture({ diseaseNames: ["感冒"], signedSyndromeText: "风热犯表证", currentFacts: "发热，微恶风，咽喉肿痛，咳嗽痰黄" });
  assert.match(cold.treatmentContent, /本例属风热/u, cold.treatmentContent);
});

check("1.3 一个拼出来的二字组不算定型证据：「疼痛较前缓解」的「痛较」不让风寒湿痹的肩痛写成痛痹（H-tri-10170）", () => {
  const shoulder = acupuncture({ diseaseNames: ["痹证"], signedSyndromeText: "风寒湿痹证", currentFacts: "右肩关节胀痛半年，贴膏药后疼痛较前缓解，右上肢外展困难" });
  assert.doesNotMatch(shoulder.treatmentContent, /本例属/u, shoulder.treatmentContent);
  assert.ok(names(shoulder).includes("肩髃"), "部位组照取（对照）");
});

// ── 2 按部位取穴 ───────────────────────────────────────────────────────────────
check("2.1 痹证病历写疼痛从腰放射到小腿外侧：用坐骨神经痛节，取秩边、环跳、阳陵泉（H-tri-3751）；只有腰痛、写「不伴下肢放射痛」时仍是痹病节的腰骶组（对照）", () => {
  const sciatica = acupuncture({ diseaseNames: ["痹证"], westernNames: ["腰椎间盘突出症待查"], signedSyndromeText: "着痹", currentFacts: "左下肢痹痛1年余，疼痛从腰部放射至小腿外侧" });
  assert.ok(["秩边", "环跳", "阳陵泉"].every((point) => names(sciatica).includes(point)), JSON.stringify(names(sciatica)));
  assert.match(sciatica.protocolSource, /坐骨神经痛/u);
  const lumbar = acupuncture({ diseaseNames: ["痹证"], signedSyndromeText: "着痹", currentFacts: "腰部酸痛重着，不伴下肢放射痛，阴雨天加重" });
  assert.ok(names(lumbar).includes("腰阳关") && !names(lumbar).includes("秩边"), JSON.stringify(names(lumbar)));
  assert.doesNotMatch(lumbar.protocolSource, /坐骨神经痛/u);
});

check("2.2 臀部经大腿后外侧、小腿外侧到足背的放射痛（X-H-0398）同样用坐骨神经痛节，「足背」「趾背」不取脊背组的大杼、身柱", () => {
  const facts = "行走时右侧下肢放射痛、麻木，沿右侧臀部向右大腿后外侧、右小腿外侧及右足背放射性痛麻；右趾背侧针刺觉减退";
  const result = acupuncture({ diseaseNames: ["痹证"], westernNames: ["腰椎管狭窄症"], signedSyndromeText: "痰瘀痹阻证", currentFacts: facts });
  assert.ok(names(result).includes("委中") && !names(result).includes("大杼") && !names(result).includes("身柱"), JSON.stringify(names(result)));
  // 痹病节本身：足背肿痛取踝部组，不取脊背组（对照：背部酸痛取大杼）。
  const foot = acupuncture({ diseaseNames: ["痹证"], signedSyndromeText: "风湿热痹", currentFacts: "右足背红肿疼痛" });
  assert.ok(!names(foot).includes("大杼") && names(foot).includes("昆仑"), JSON.stringify(names(foot)));
  const back = acupuncture({ diseaseNames: ["痹证"], signedSyndromeText: "风寒湿痹阻证", currentFacts: "背部酸痛，遇寒加重" });
  assert.ok(names(back).includes("大杼"), JSON.stringify(names(back)));
});

check("2.3 西医诊断写急性颈肌劳损、急性颈肌筋膜炎时用落枕节：天柱、后溪、外劳宫（X-H-0171、0230）；慢性颈肌劳损仍按痹病节（对照）", () => {
  const acute = acupuncture({ diseaseNames: ["痹证"], westernNames: ["急性颈肌筋膜炎"], signedSyndromeText: "风寒袭络证", currentFacts: "夜吹风扇，晨起颈背部强痛，低头加重" });
  assert.ok(["天柱", "后溪", "外劳宫"].every((point) => names(acute).includes(point)), JSON.stringify(names(acute)));
  assert.ok(!names(acute).includes("大杼"), JSON.stringify(names(acute)));
  const chronic = acupuncture({ diseaseNames: ["痹证"], westernNames: ["颈肌劳损"], signedSyndromeText: "风寒袭络证", currentFacts: "颈项酸痛3年，遇寒加重" });
  assert.ok(names(chronic).includes("大杼") && !names(chronic).includes("外劳宫"), JSON.stringify(names(chronic)));
});

check("2.4 痿证「手足麻木」「袜套样」上下肢都取（H-tri-16576 只取了上肢）；只写双手麻木无力时只取上肢组（对照）", () => {
  const both = acupuncture({ diseaseNames: ["痿证"], signedSyndromeText: "络脉不和证", currentFacts: "服药后出现手足麻木，呈手套和袜形分布感觉障碍，手不能握物" });
  assert.ok(names(both).includes("曲池") && names(both).includes("足三里"), JSON.stringify(names(both)));
  const hands = acupuncture({ diseaseNames: ["痿证"], signedSyndromeText: "络脉不和证", currentFacts: "双手麻木无力，握物不稳" });
  assert.ok(names(hands).includes("曲池") && !names(hands).includes("足三里"), JSON.stringify(names(hands)));
});

check("2.5 踝关节扭伤只写内踝压痛：不取外踝的申脉、丘墟及对应的养老，按《针灸学》足太阴经筋及阴跷脉病证取商丘、照海（H-tri-6746）；外踝扭伤照取申脉、丘墟、养老（对照）", () => {
  const medial = acupuncture({ diseaseNames: ["痹证"], westernNames: ["左踝关节扭伤"], signedSyndromeText: "气滞血瘀证", currentFacts: "左踝关节活动稍受限，屈伸痛；内踝尖前下方压痛" });
  assert.ok(!names(medial).some((point) => ["申脉", "丘墟", "养老"].includes(point)), JSON.stringify(names(medial)));
  assert.ok(names(medial).includes("商丘") && names(medial).includes("照海"), JSON.stringify(names(medial)));
  assert.match(medial.treatmentContent, /伤在内踝/u);
  const lateral = acupuncture({ diseaseNames: ["痹证"], westernNames: ["右踝关节扭伤"], signedSyndromeText: "气滞血瘀证", currentFacts: "右外踝前下方肿痛，压痛明显" });
  assert.ok(["申脉", "丘墟", "养老"].every((point) => names(lateral).includes(point)) && !names(lateral).includes("照海"), JSON.stringify(names(lateral)));
});

// ── 3 骨折与面部疮疡 ───────────────────────────────────────────────────────────
check("3.1 已签名骨折（含「待查」）：取局部的针刺、拔罐卡不出（伤处阿是穴、刺络拔罐与「骨折及其周围肿胀处不施术」相抵，H-tri-3960、M-TCMChat-test-375），耳穴卡照出；腰肌劳损照出针刺、拔罐卡（对照）", () => {
  const proposals = [{ projectCode: "acupuncture", targetRef: "P1" }, { projectCode: "cupping", targetRef: "P1" }, { projectCode: "auricular", targetRef: "P1" }];
  const fracture = compile(signedPrior("腰痛", "瘀血腰痛", "跌仆损伤腰部经络，气血瘀滞", "骨质疏松性腰椎压缩性骨折待查"), "腰痛1月", "腰背部疼痛，翻身困难", proposals);
  assert.equal(card(fracture, "acupuncture"), undefined);
  assert.equal(card(fracture, "cupping"), undefined);
  assert.ok(card(fracture, "auricular"), JSON.stringify(fracture.map((item) => item.projectCode)));
  const strain = compile(signedPrior("腰痛", "瘀血腰痛", "劳损日久，腰络瘀滞", "腰肌劳损"), "腰痛1月", "腰背部刺痛，痛处固定", proposals);
  assert.ok(card(strain, "acupuncture") && card(strain, "cupping"), JSON.stringify(strain.map((item) => item.projectCode)));
  assert.equal(cap.fractureSigned(["腰椎压缩性骨折待查"]), true);
  assert.equal(cap.fractureSigned(["X线排除骨折"]), false);
});

check("3.2 鼻骨旁颊部红肿水疱的丹毒：针刺卡不取阿是穴、不写「皮损局部用三棱针散刺出血」，写明面部皮损处不针刺（H-tri-17402）；小腿丹毒照取阿是穴（对照）；不寐病历顺带写「面部偶发痤疮」不印面部提示（对照）", () => {
  const proposals = [{ projectCode: "acupuncture", targetRef: "P1" }];
  // 主诉不写部位：部位只在「鼻骨旁颊部」这一写法里（此前只认「鼻旁」「面颊」）。
  assert.equal(plan.facialSoreRecorded("鼻骨旁颊部红肿水泡", []), true);
  assert.equal(plan.facialSoreRecorded("取颊车穴，红肿", []), false, "穴名颊车不算部位（对照）");
  const face = card(compile(signedPrior("丹毒", "风热毒蕴证", "风热毒邪壅于头面肌肤"), "红肿疼痛3天", "鼻骨旁颊部红肿水泡，灼热疼痛", proposals, { sex: "男", age: 16 }), "acupuncture");
  assert.ok(face && !bare(face.suggestedSitesOrPoints).includes("阿是穴"), JSON.stringify(face?.suggestedSitesOrPoints));
  assert.doesNotMatch(`${face.treatmentContent}${face.techniqueBoundary}`, /散刺出血|皮损局部/u);
  assert.match(face.techniqueBoundary, /面部皮损处[^。]*不针刺/u);
  const leg = card(compile(signedPrior("丹毒", "湿热毒蕴证", "湿热毒邪下注小腿"), "右小腿红肿3天", "右小腿红肿热痛，边界清楚", proposals), "acupuncture");
  assert.ok(leg && bare(leg.suggestedSitesOrPoints).includes("阿是穴"), JSON.stringify(leg?.suggestedSitesOrPoints));
  assert.equal(plan.facialSoreRecorded("面部偶发痤疮", ["不寐"]), true, "判据本身认得面部痤疮");
  assert.equal(cap.localSiteCardNote("acupuncture", "失眠多梦；面部偶发痤疮", ["不寐"], false), "", "卡不取局部时不印");
});

// ── 4 补泻与灸 ─────────────────────────────────────────────────────────────────
check("4.1 热痹的「可加电针，或温针灸」去掉温针灸（M-TCMChat-test-336）；风寒湿痹照留（对照）", () => {
  const text = "毫针常规刺，可加电针，或温针灸。补泻手法、进针深度以现场查体为准。";
  assert.doesNotMatch(plan.cardSentencesMatchedToSyndrome(text, ["痹证"], "风湿热痹"), /灸/u);
  assert.match(plan.cardSentencesMatchedToSyndrome(text, ["痹证"], "风寒湿痹证"), /温针灸/u);
  assert.match(plan.cardSentencesMatchedToSyndrome("针灸治疗本病有较好疗效。", ["痹证"], "风湿热痹"), /针灸/u, "「针灸」泛称不当施灸（对照）");
});

check("4.2 寒证不写不带条件的放血：风寒湿痹的膝痹拔罐卡只有「皮肤针重叩使出血少许，加拔罐」一种做法，整张不出（H-tri-18612）；湿热痹照出（对照）；教材写明给寒湿腰痛的刺络拔罐照留（对照）", () => {
  const coldKnee = project("cupping", { diseaseNames: ["痹证"], westernNames: ["右膝关节骨关节炎"], signedSyndromeText: "风寒湿痹阻证", currentFacts: "右膝关节疼痛，遇寒加重" });
  assert.equal(coldKnee, undefined);
  const hotKnee = project("cupping", { diseaseNames: ["痹证"], westernNames: ["右膝关节骨关节炎"], signedSyndromeText: "湿热痹阻证", currentFacts: "右膝关节红肿热痛" });
  assert.match(hotKnee?.treatmentContent || "", /重叩/u);
  const coldLumbar = project("cupping", { diseaseNames: ["腰痛"], signedSyndromeText: "寒湿腰痛", currentFacts: "腰部冷痛重着，遇阴雨加重" });
  assert.match(coldLumbar?.treatmentContent || "", /寒湿腰痛可行刺络拔罐/u);
});

check("4.3 落枕「再针局部的腧穴，可加艾灸或点刺出血」对风寒只去「或点刺出血」，留「可加艾灸」（X-H-0230）", () => {
  const neck = acupuncture({ diseaseNames: ["痹证"], westernNames: ["急性颈肌筋膜炎"], signedSyndromeText: "风寒袭络证", currentFacts: "晨起颈背部强痛，低头加重" });
  assert.match(neck.techniqueBoundary, /再针局部的腧穴，可加艾灸。/u, neck.techniqueBoundary);
  assert.doesNotMatch(neck.techniqueBoundary, /点刺出血/u);
});

check("4.4 虚火牙痛：教材「主穴用泻法…配穴太溪用补法」，卡写「泻法」与「配穴太溪用补法」，不把通用的泻法改成补法让颊车、内庭也成补法（H-tri-15384）；胃火牙痛照写泻法、不加太溪（对照）", () => {
  const deficient = acupuncture({ diseaseNames: ["牙痛"], signedSyndromeText: "虚火上炎证", signedPrinciple: "虚则补之", currentFacts: "牙齿隐痛，午后加重，齿龈微红" });
  const tech = plan.manipulationMatchedToSyndrome(deficient.techniqueBoundary, "虚火上炎证", "虚则补之");
  assert.match(tech, /泻法/u, tech);
  assert.match(tech, /配穴太溪用补法/u, tech);
  assert.doesNotMatch(tech, /针用补法/u, tech);
  const excess = acupuncture({ diseaseNames: ["牙痛"], signedSyndromeText: "胃火牙痛", signedPrinciple: "实则泻之", currentFacts: "牙痛剧烈，牙龈红肿，口臭便秘" });
  assert.match(excess.techniqueBoundary, /泻法/u);
  assert.doesNotMatch(excess.techniqueBoundary, /太溪/u);
  // 没有点穴补泻句的通用改写照旧（对照：痰火扰心改成泻法）。
  assert.match(plan.manipulationMatchedToSyndrome("留针用补法。", "痰火扰心证", "实则泻之"), /^针用泻法/u);
});

// ── 5 模板与主症 ───────────────────────────────────────────────────────────────
check("5.1 痿证节只给有肢体痿弱的病历：「四肢肌力、肌张力尚正常」以共济失调为主（H-tri-5409）、小脑桥脑萎缩只写走路不稳（H-tri-15057）不出痿证卡；双下肢无力、肌力Ⅳ级照出（对照）；问「本病有无教材方案」时不按事实判（对照）", () => {
  assert.equal(acupuncture({ diseaseNames: ["痿证"], signedSyndromeText: "肝肾亏损证", currentFacts: "进行性双下肢走路不稳3年；患者于2009年出现双下肢无力；四肢肌力、肌张力尚正常；指鼻试验(+)；复查CT示：脑萎缩" }), undefined);
  assert.equal(acupuncture({ diseaseNames: ["痿证"], signedSyndromeText: "肝肾亏损证", currentFacts: "走路不稳4年，目珠不活，复视，饮食易呛；诊断为小脑桥脑萎缩" }), undefined);
  assert.ok(acupuncture({ diseaseNames: ["痿证"], signedSyndromeText: "肝肾亏损证", currentFacts: "双下肢无力，行走困难" }));
  assert.ok(acupuncture({ diseaseNames: ["痿证"], signedSyndromeText: "肝肾亏损证", currentFacts: "双上肢肌力IV级，双下肢肌力V级，四肢肌张力正常" }));
  assert.equal(plan.textbookPlanExistsForDisease("acupuncture", "痿证", ""), true);
});

check("5.2 「上肢肌肉萎缩手阳明经排刺；下肢肌肉萎缩足阳明经排刺」只给有肌肉萎缩的病历（H-tri-5395 未见萎缩）；写了小腿肌肉萎缩时照写（对照）", () => {
  const noAtrophy = acupuncture({ diseaseNames: ["痿证"], signedSyndromeText: "脉络瘀阻证", currentFacts: "双足下垂，行走困难" });
  assert.doesNotMatch(noAtrophy.techniqueBoundary, /排刺/u, noAtrophy.techniqueBoundary);
  assert.match(noAtrophy.techniqueBoundary, /余穴均常规操作/u);
  const atrophy = acupuncture({ diseaseNames: ["痿证"], signedSyndromeText: "脉络瘀阻证", currentFacts: "双足下垂，行走困难，小腿肌肉萎缩" });
  assert.match(atrophy.techniqueBoundary, /排刺/u);
});

check("5.3 斜视按麻痹的眼外肌配眼周穴：「眼珠不能向内转动」加睛明、攒竹（H-tri-11654）；「向内斜视」、外展神经麻痹加瞳子髎、太阳（H-tri-16191）；只写复视不加（对照）", () => {
  const medial = acupuncture({ diseaseNames: ["风牵偏视"], signedSyndromeText: "脉络瘀阻证", currentFacts: "右眼不能睁大，眼珠不能向内转动，视物有重影" });
  assert.ok(names(medial).includes("睛明") && names(medial).includes("攒竹"), JSON.stringify(names(medial)));
  const lateral = acupuncture({ diseaseNames: ["风牵偏视"], westernNames: ["左侧外展神经麻痹"], signedSyndromeText: "脉络瘀阻证", currentFacts: "左眼向内斜视约40°，视物成双影" });
  assert.ok(names(lateral).includes("瞳子髎") && names(lateral).includes("太阳"), JSON.stringify(names(lateral)));
  const diplopia = acupuncture({ diseaseNames: ["风牵偏视"], signedSyndromeText: "脉络瘀阻证", currentFacts: "视物成双影2周" });
  assert.ok(!names(diplopia).some((point) => ["睛明", "攒竹", "瞳子髎"].includes(point)), JSON.stringify(names(diplopia)));
});

check("5.4 分套治法写给别的脏：耳聋·脾胃虚弱证不印虚证一套的「补肾养窍」（H-tri-14837）；肾精亏虚照印（对照）", () => {
  const spleen = acupuncture({ diseaseNames: ["耳聋"], signedSyndromeText: "脾胃虚弱证", signedPrinciple: "虚则补之", currentFacts: "耳聋2周，纳少便溏，神疲" });
  assert.doesNotMatch(spleen.treatmentContent, /补肾/u, spleen.treatmentContent);
  const kidney = acupuncture({ diseaseNames: ["耳聋"], signedSyndromeText: "肾精亏虚证", signedPrinciple: "虚则补之", currentFacts: "久病耳聋，腰膝酸软" });
  assert.match(kidney.treatmentContent, /补肾/u, kidney.treatmentContent);
});

// ── 6 卡内残句 ─────────────────────────────────────────────────────────────────
check("6.1 小儿不写电针（9 岁卡「可用电针」与「浅刺、快出针」相抵，H-tri-3721）；成人照写（对照）", () => {
  assert.equal(plan.operationClausesForAge("毫针常规刺，可用电针。", 9), "毫针常规刺。");
  assert.equal(plan.operationClausesForAge("毫针常规刺，可用电针。", 30), "毫针常规刺，可用电针。");
});

check("6.2 瘿病「再用一根针从囊肿顶部刺入，直达底部，小幅提插捻转」：病历无囊肿（甲亢弥漫性肿大，H-tri-18842）时不印，注意小句照留；写了甲状腺囊肿时照印（对照）", () => {
  const diffuse = acupuncture({ diseaseNames: ["瘿病"], signedSyndromeText: "肝火旺盛证", currentFacts: "手颤心慌，眼突，脖子增粗" });
  assert.doesNotMatch(diffuse.techniqueBoundary, /囊肿|直达底部/u, diffuse.techniqueBoundary);
  assert.match(diffuse.techniqueBoundary, /围刺，注意勿伤及颈总动脉及喉返神经/u, diffuse.techniqueBoundary);
  const cyst = acupuncture({ diseaseNames: ["瘿病"], signedSyndromeText: "肝火旺盛证", currentFacts: "颈前肿块，超声示甲状腺囊肿" });
  assert.match(cyst.techniqueBoundary, /囊肿顶部/u);
});

check("6.3 疱疹已结痂脱落、遗留疼痛半年：写给疱疹本身的灸法卡（铺棉灸「覆盖疱疹」）不出（H-tri-9007）；簇集水疱时照出（对照）", () => {
  const healed = project("moxibustion", { diseaseNames: ["蛇串疮"], westernNames: ["带状疱疹后神经痛"], signedSyndromeText: "气滞血瘀证", currentFacts: "2周后疱疹结痂脱落、消退，遗留剧烈疼痛，夜间加剧" });
  assert.equal(healed, undefined);
  const active = project("moxibustion", { diseaseNames: ["蛇串疮"], westernNames: ["带状疱疹"], signedSyndromeText: "气滞血瘀证", currentFacts: "左胁簇集水疱，灼热刺痛" });
  assert.match(active?.treatmentContent || "", /疱疹/u);
  assert.equal(plan.herpesLesionHealed("疱疹结痂脱落，遗留疼痛", []), true);
  assert.equal(plan.herpesLesionHealed("左胸背簇集水疱2天", ["带状疱疹"]), false);
});

check("6.4 本项目已写时长（「留针20～30分钟」「留罐10分钟」「每次8~10壮」）就不并列总论的通用时长（验收集 37 张针刺卡）；没写时长时照写总论那句（对照）", () => {
  const zoster = acupuncture({ diseaseNames: ["蛇串疮"], westernNames: ["带状疱疹"], signedSyndromeText: "肝经郁热证", currentFacts: "左胁簇集水疱，灼热刺痛" });
  assert.match(zoster.scheduleSuggestion, /留针20～30分钟/u, zoster.scheduleSuggestion);
  assert.doesNotMatch(zoster.scheduleSuggestion, /即可出针或留针10～30分钟/u, zoster.scheduleSuggestion);
  const lin = acupuncture({ diseaseNames: ["淋证"], signedSyndromeText: "湿热蕴结证", currentFacts: "小便灼热刺痛" });
  assert.match(lin.scheduleSuggestion, /即可出针或留针10～30分钟/u, lin.scheduleSuggestion);
  assert.equal(plan.cardStatesDuration("moxibustion", "上置大艾炷灸之，每次8~10壮"), true);
  assert.equal(plan.cardStatesDuration("cupping", "留罐10分钟，每日1次"), true);
  assert.equal(plan.cardStatesDuration("acupuncture", "局部穴宜深刺、久留针"), false, "没数字的不算（对照）");
});

// ── 7 孕期提示 ─────────────────────────────────────────────────────────────────
check("7.1 孕期提示列卡上全部孕期敏感穴：腰夹脊、至阴、三阴交都列（H-tri-830 只列了前 4 个）；承山「腓肠肌两肌腹」不是腹部；妊娠已写明否认时不提示（对照）", () => {
  const note = cap.populationCardNote("acupuncture", 20, true, ["腰夹脊", "秩边", "委中", "承山", "昆仑", "至阴", "阿是穴", "环跳", "阳陵泉", "悬钟", "血海", "三阴交"]);
  for (const point of ["腰夹脊", "秩边", "昆仑", "至阴", "环跳", "三阴交"]) assert.match(note, new RegExp(point, "u"), note);
  assert.doesNotMatch(note, /承山|委中|悬钟/u, note);
  assert.equal(cap.populationCardNote("acupuncture", 20, false, ["三阴交", "至阴"]), "");
  assert.equal(acupoints.acupointPregnancySensitive("至阴"), true);
  assert.equal(acupoints.acupointPregnancySensitive("腰夹脊"), true);
  assert.equal(acupoints.acupointPregnancySensitive("承山"), false);
  assert.equal(acupoints.acupointPregnancySensitive("颈夹脊"), false, "颈段（对照）");
  assert.equal(acupoints.acupointPregnancySensitive("天枢"), true, "腹部（对照）");
  assert.equal(acupoints.acupointPregnancySensitive("足三里"), false, "（对照）");
});

// ── 8 食疗 ─────────────────────────────────────────────────────────────────────
check("8.1 毛蛋不出、油煎算肥甘：头痛·风湿食疗卡不再给「油煎毛蛋」（H-tri-10297）；薏仁粥照给（对照）", () => {
  assert.equal(plan.recipeUsesOnlyFoodSafeIngredients("取生姜60～100g，去皮拍烂，与毛蛋（在壳内已长羽毛的鸡胚胎）2个，去壳，用花生油煎熟即食。"), false);
  assert.equal(plan.recipeHasRichIngredient("与鸡蛋2个，用花生油煎熟即食。"), true);
  assert.equal(plan.recipeHasRichIngredient("取薏苡仁20g，入粳米60g加水共煨粥。"), false);
  const headache = project("diet_therapy", { diseaseNames: ["头痛"], signedSyndromeText: "风湿头痛证", currentFacts: "头痛如裹，肢体困重", avoidRichFood: true });
  assert.ok(headache, "照出一张食疗卡");
  assert.doesNotMatch(headache.treatmentContent, /毛蛋|油煎/u, headache.treatmentContent);
});

check("8.2 并列写在忌口里的浓茶算忌茶（「服本方期间不宜同时服萝卜、浓茶」，X-H-0163）；代茶饮、宜饮淡茶不算（对照）", () => {
  assert.equal(plan.dietAdviceAvoidsTea("服本方期间不宜同时服萝卜、浓茶。"), true);
  assert.equal(plan.dietAdviceAvoidsTea("可用菊花代茶饮。"), false);
  assert.equal(plan.dietAdviceAvoidsTea("宜清淡饮食，可饮淡茶。"), false);
});

check("8.3 病历记有糖尿病：消渴食疗卡不写「糖尿病…请先咨询医生」，改写谷薯计入当餐主食、监测血糖（M-TCM-SD-447858 一类）；未记糖尿病时照写原句（对照）", () => {
  const diabetic = project("diet_therapy", { diseaseNames: ["消渴"], westernNames: ["2型糖尿病"], signedSyndromeText: "气阴亏虚证", currentFacts: "口干多饮，乏力", recordedDiabetes: true });
  assert.ok(diabetic, "消渴有教材食疗");
  assert.doesNotMatch(diabetic.techniqueBoundary, /糖尿病、/u, diabetic.techniqueBoundary);
  assert.match(diabetic.techniqueBoundary, /本例有糖尿病[^。]*监测血糖/u, diabetic.techniqueBoundary);
  const other = project("diet_therapy", { diseaseNames: ["消渴"], signedSyndromeText: "气阴亏虚证", currentFacts: "口干多饮，乏力", recordedDiabetes: false });
  assert.match(other.techniqueBoundary, /糖尿病、慢性肾病/u);
});

// ── 9 灸卡烫伤 ─────────────────────────────────────────────────────────────────
check("9.1 灸卡写明糖尿病、感觉减退的烫伤风险（H-tri-5395 小腿外侧及足背皮肤感觉减退）；针刺卡只在仍写施灸时提示；无风险不提示（对照）", () => {
  assert.match(cap.moxibustionBurnCardNote("moxibustion", "小腿外侧及足背皮肤感觉减退", ""), /局部感觉减退[^。]*感觉减退处不直接施灸/u);
  assert.match(cap.moxibustionBurnCardNote("moxibustion", "2型糖尿病10年", ""), /^本例有糖尿病/u);
  assert.match(cap.moxibustionBurnCardNote("acupuncture", "2型糖尿病10年", "毫针常规刺。虚证可加用灸法。"), /糖尿病/u);
  assert.equal(cap.moxibustionBurnCardNote("acupuncture", "2型糖尿病10年", "毫针常规刺，泻法。依据《刺法灸法学》。"), "");
  assert.equal(cap.moxibustionBurnCardNote("moxibustion", "畏寒肢冷，腰膝酸软", ""), "");
});

// ── 10 居家保健 ────────────────────────────────────────────────────────────────
check("10.1 外伤造成的瘀滞不推血瘀质、气郁质（H-tri-6746 踝扭伤、H-tri-3960 骨折都给「按揉期门、血海」）；胁痛·气滞血瘀照推血瘀质（对照）；外伤病人本虚的体质照推（对照）", () => {
  const prior = (disease, western, syndrome, pathogenesis, items) => ({
    overview: { tcmDiseaseName: disease, primarySyndrome: syndrome, primarySyndromeResolution: "resolved", overallPathogenesis: pathogenesis },
    westernDiagnosis: { primary: { name: western } },
    pathogenesis: { natureDifferentiation: { items } },
  });
  assert.equal(home.homeAcupointConstitution(prior("痹证", "左踝关节扭伤", "气滞血瘀证", "扭伤致踝部气血壅滞", ["气滞", "血瘀"])), undefined);
  assert.equal(home.homeAcupointConstitution(prior("腰痛", "腰肌劳损", "瘀血腰痛", "跌仆闪挫，腰部络脉受损", ["血瘀"])), undefined);
  assert.equal(home.homeAcupointConstitution(prior("胁痛", "慢性胆囊炎", "气滞血瘀证", "肝郁日久，气滞血瘀", ["气滞", "血瘀"])), "blood_stasis");
  assert.equal(home.homeAcupointConstitution(prior("骨折", "桡骨远端骨折", "气虚血瘀证", "年老气虚，跌仆骨折", ["气虚", "血瘀"])), "qi_deficiency");
});

console.log(JSON.stringify({ suite: "r1019-round5-cards", cases, failures: failures.length }));
if (failures.length > 0) process.exitCode = 1;
