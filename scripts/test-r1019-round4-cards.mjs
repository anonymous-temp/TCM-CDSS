// 中医治疗项目卡与食疗卡 r1019 第四轮（2026-10-19，Claude 评审 M 集 360 例、H 集 330 例「中医治疗」模块不通过项里的服务端缺陷）。
//
// 每条断言都带对照（不该变的输入保持不变）；反证记录在 ~/runlogs/r1018/work/r1019/counterproofs.txt（前缀 4/cards/）。
// 回放材料：~/runlogs/r1018/work/r1019/agentH/r4（replay4.mjs、base3/full*.json、d*.txt）。
//
//   1 虚实：卡片按主证定虚实（主证判不出时按已签名治则），兼证不再把纯虚的主证拉成「虚实夹杂」或「实」
//     （M single_0582 耳鸣实证/虚证两套并列、single_0686 心肾不交兼血瘀被改成「针用泻法」、BEST4SDT-154 脾虚湿蕴的重叩出血）
//   2 分套：急危状态的那一套（中脏腑、发作期）只在写明时取（single_0578、X-H-0047）；判不出的分套写明套名（X-H-0107、0280）
//   3 按部位取穴：痹病部位词要与不适同在一小句、认 PIP/MCP/MTP、颈项与腰骶分开、内外踝分侧；头痛四经分部、痿证上下肢分组
//   4 「本例属X」「按X取穴」与签名证候一致：目录配穴按叙述命中时要与证候结论相符（M 438、352，X-H-0326、0104）；
//     阳气虚衰不算气虚、髓海不足要写到髓海（H-tri-9278、19050）；危急证型只按字面取（H-tri-17402 火毒内陷）；主证与教材证型同名不再要求二字组证据
//   5 对的是别的病的目录模板：主诉里写着的伴随症状、按证型加减过都不例外（M 352、H X-H-0155、16468、14474、7467、X-H-0370、M single_0532）；
//     模板写「先排除感染」而已签名就是结核（H-tri-16689）；膝关节骨关节炎对上膝骨性关节炎节（M 336）
//   6 写给别的证型、别的病程的小句（热痹点刺出血、肾阳虚衰隔附子饼灸、急性腰痛三棱针、瘀血阻络者三棱针）
//   7 卡片文字与穴位表一致：禁针穴不写「加神阙」；点名卡外穴的注意小句与「以免…」下半句；并列穴名只留卡上的；背俞穴类
//   8 耳穴与操作栏：「相应病变脏腑」不当穴名；扫描错字「顽同性」；操作栏不重抄治疗内容、不重印疗程句；偏头痛专篇频次只给偏头痛
//   9 食疗：病历便溏与药材使用注意（苦杏仁）、糖尿病（含糖、大量精白米粥）、辛香峻烈药材超药典、忌茶、疗程照方子服法
//  10 其他：「主治含X」只读病历当前阳性面（否认、喜恶、诱因不算）；小儿不写深刺；出血倾向读已签名西医诊断；注意事项提到没给的食疗
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

const acupuncture = (input) => plan.textbookTreatmentPlan({ projectCode: "acupuncture", westernNames: [], signedSyndromeText: "", currentFacts: "", ...input });
const project = (projectCode, input) => plan.textbookTreatmentPlan({ projectCode, westernNames: [], signedSyndromeText: "", currentFacts: "", ...input });
const names = (result) => (result?.points || []).map((point) => point.name);
const signedPrior = (disease, syndromeText, fact, western = disease, therapy = {}, secondary = []) => ({
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
  contractSignatureVersion: "tcm-cdss-m03-signature-v5", contractSignature: `hmac-sha256:${"a".repeat(64)}`,
  overview: { tcmDiseaseName: disease, primarySyndrome: syndromeText, secondarySyndromes: secondary, primarySyndromeResolution: "resolved", primarySyndromeBasis: [], overallPathogenesis: fact },
  westernDiagnosis: { primary: { name: western, supportingFacts: [] } },
  therapy: { overallPrinciple: "", overallMethod: "", subTherapies: [], ...therapy },
  pathogenesis: { chain: [{ nodeId: "P1", patientFact: fact, syndromeEvidence: syndromeText, pathogenesis: fact, therapyDirection: "" }], uncertainties: [] },
});
const compile = (prior, chief, present, proposals, patient = { sex: "男", age: 45 }, extra = {}) => cap.compileTcmTreatmentRecommendations(
  proposals, prior, { chiefComplaint: chief, symptoms: { 现病史: present }, patient, safetyGate: { status: "ready", redFlags: [] }, ...extra });
const card = (cards, code) => cards.find((item) => item.projectCode === code);
const bare = (sites) => (sites || []).map((site) => String(site).replace(/（.*$/u, ""));

// ── 1 虚实 ─────────────────────────────────────────────────────────────────────
check("1.1 卡片虚实先看主证：肝肾阴虚证兼「脾阳不足、湿浊内蕴证」是虚；心肾不交证（《中医诊断学》虚热证）兼血瘀证是虚；主证判不出时按已签名治则（对照：整串旧判据判不出/判实）", () => {
  assert.equal(plan.signedCardNature("肝肾阴虚证；脾阳不足、湿浊内蕴证", "扶正祛邪"), "deficiency");
  assert.equal(plan.signedCardNature("心肾不交证；血瘀证", "扶正祛邪"), "deficiency");
  assert.equal(plan.signedSyndromeDeficiencyExcess("肝肾阴虚证；脾阳不足、湿浊内蕴证"), undefined, "整串判（对照）");
  assert.equal(plan.signedCardNature("咽喉气机不和证", "实则泻之"), "excess");
  assert.equal(plan.signedCardNature("咽喉气机不和证", "虚则补之"), "deficiency");
  assert.equal(plan.signedCardNature("脾虚湿蕴证", "扶正祛邪"), undefined, "本虚标实仍判不出");
  assert.equal(plan.signedPrimaryHasDeficiency("脾虚湿蕴证", "扶正祛邪"), true);
  assert.equal(plan.signedPrimaryHasDeficiency("湿热浸淫证", "实则泻之"), false, "纯实（对照）");
});

check("1.2 耳鸣·肝肾阴虚证（兼脾阳不足、湿浊内蕴）取教材虚证一套：太溪、肾俞、听宫补法，不并列实证的听会、侠溪、中渚泻法（M-TCM-RobustSDT-single_0582）；肝胆火盛取实证（对照）", () => {
  const deficient = acupuncture({ diseaseNames: ["耳鸣"], signedSyndromeText: "肝肾阴虚证；脾阳不足、湿浊内蕴证", signedPrinciple: "扶正祛邪", currentFacts: "耳鸣如蝉，腰膝酸软" });
  assert.ok(names(deficient).includes("太溪") && names(deficient).includes("肾俞"), JSON.stringify(names(deficient)));
  assert.ok(!names(deficient).includes("侠溪") && !names(deficient).includes("中渚"), JSON.stringify(names(deficient)));
  assert.doesNotMatch(deficient.techniqueBoundary, /泻法/);
  const excess = acupuncture({ diseaseNames: ["耳鸣"], signedSyndromeText: "肝胆火盛证", signedPrinciple: "实则泻之", currentFacts: "耳鸣如潮，郁怒后加重" });
  assert.ok(names(excess).includes("侠溪") && !names(excess).includes("肾俞"), JSON.stringify(names(excess)));
});

check("1.3 补泻手法按主证：心肾不交证兼血瘀证保留目录失眠模板的「留针用补法」（M single_0686）；痰火扰心证照旧改成泻法（对照）", () => {
  assert.equal(plan.manipulationMatchedToSyndrome("留针用补法；实际取穴由现场医师复核。", "心肾不交证；血瘀证", "扶正祛邪"), "留针用补法；实际取穴由现场医师复核。");
  assert.match(plan.manipulationMatchedToSyndrome("留针用补法；实际取穴由现场医师复核。", "痰火扰心证", "实则泻之"), /^针用泻法/);
});

check("1.4 咽喉气机不和证（证名判不出虚实）按治则「实则泻之」取咽喉肿痛实证一套；判不出时取穴说明写明套名，不再两句「取…为主」并列（X-H-0107）", () => {
  const excess = acupuncture({ diseaseNames: ["喉痹"], westernNames: ["急性咽炎"], signedSyndromeText: "咽喉气机不和证", signedPrinciple: "实则泻之", currentFacts: "咽喉微感疼痛" });
  assert.ok(names(excess).includes("少商") && !names(excess).includes("太溪"), JSON.stringify(names(excess)));
  const undecided = acupuncture({ diseaseNames: ["喉痹"], westernNames: ["急性咽炎"], signedSyndromeText: "咽喉气机不和证", signedPrinciple: "扶正祛邪", currentFacts: "咽喉微感疼痛" });
  assert.match(undecided.treatmentContent, /实证取[^；]+；虚证取/, undecided.treatmentContent);
});

check("1.5 主证带虚的（脾虚湿蕴）不写刺络放血、皮肤针重叩出血（M-TCM-BEST4SDT-154）；纯实证照写（对照）", () => {
  const deficient = acupuncture({ diseaseNames: ["湿疮"], signedSyndromeText: "脾虚湿蕴证", signedPrinciple: "扶正祛邪", currentFacts: "双手湿疹3月余，纳食后胃胀，大便不成形" });
  assert.ok(deficient, "湿疮有教材针刺节");
  assert.doesNotMatch(`${deficient.techniqueBoundary}${deficient.treatmentContent}`, /出血/);
  const excess = acupuncture({ diseaseNames: ["湿疮"], signedSyndromeText: "湿热浸淫证", signedPrinciple: "实则泻之", currentFacts: "皮损潮红灼热，瘙痒无休" });
  assert.match(`${excess.techniqueBoundary}${excess.treatmentContent}`, /出血/);
});

// ── 2 分套 ─────────────────────────────────────────────────────────────────────
check("2.1 中风·阴虚风动证（后遗症期）取中经络一套，不印中脏腑的「百会闭证…泻法」（M single_0578）；签名写闭证时取中脏腑（对照）", () => {
  const usual = acupuncture({ diseaseNames: ["中风"], westernNames: ["脑梗死后遗症"], signedSyndromeText: "阴虚风动证", signedPrinciple: "扶正祛邪", currentFacts: "中风后20个月，左侧肢体乏力", patientAgeYears: 70 });
  assert.doesNotMatch(`${usual.treatmentContent}${usual.techniqueBoundary}`, /中脏腑|闭证|脱证/);
  assert.ok(!names(usual).includes("百会") || usual.points.find((point) => point.name === "百会")?.role !== "base_point");
  const acute = acupuncture({ diseaseNames: ["中风"], signedSyndromeText: "闭证", currentFacts: "神昏面赤，牙关紧闭" });
  assert.ok(names(acute).includes("百会"), JSON.stringify(names(acute)));
});

check("2.2 痫病发作后来诊取间歇期一套（不印发作期的水沟强刺激、涌泉，X-H-0047）；签名写发作期时取发作期（对照）", () => {
  const between = acupuncture({ diseaseNames: ["痫证"], westernNames: ["癫痫"], signedSyndromeText: "阳痫证", signedPrinciple: "实则泻之", currentFacts: "痫病发作后来诊，现痰多", chiefComplaint: "痫病发作后来诊" });
  assert.ok(names(between).includes("鸠尾") && !names(between).includes("水沟"), JSON.stringify(names(between)));
  const attack = acupuncture({ diseaseNames: ["痫证"], signedSyndromeText: "发作期", currentFacts: "突然昏仆" });
  assert.ok(names(attack).includes("水沟"), JSON.stringify(names(attack)));
});

// ── 3 按部位取穴 ───────────────────────────────────────────────────────────────
check("3.1 痹病：双手 PIP/MCP 与足趾 MTP 关节肿痛取腕手部、踝足部穴，查体模板「颈部对称」不算颈背（M-TCM-SD-488395）；膝痛取膝部（对照）", () => {
  const ra = acupuncture({ diseaseNames: ["痹证"], signedSyndromeText: "风湿热痹", currentFacts: "后渐出现双手多关节肿痛,累及左手MCPJ2、5、左足MTPJ5等关节；颈部对称；胸部对称" });
  assert.ok(names(ra).includes("阳池") && names(ra).includes("昆仑"), JSON.stringify(names(ra)));
  assert.ok(!names(ra).includes("大杼") && !names(ra).includes("腰阳关"), JSON.stringify(names(ra)));
  const knee = acupuncture({ diseaseNames: ["痹证"], signedSyndromeText: "风湿热痹", currentFacts: "右膝关节肿痛" });
  assert.ok(names(knee).includes("膝眼") && !names(knee).includes("阳池"), JSON.stringify(names(knee)));
  // 「右膝关节触之轻度发热」（M-TCM-BEST4SDT-173 强直性脊柱炎累及膝）也算膝部受累；「下足腕扎带」不算腕（H-tri-10610）。
  assert.ok(names(acupuncture({ diseaseNames: ["痹证"], signedSyndromeText: "痰瘀痹阻证", currentFacts: "腰骶部僵痛；右膝关节触之轻度发热" })).includes("膝眼"));
  assert.ok(!names(acupuncture({ diseaseNames: ["痹证"], signedSyndromeText: "痛痹", currentFacts: "各关节酸胀疼重；下足腕扎带" })).includes("阳池"));
});

check("3.2 痹病：颈项强痛取大杼、身柱、夹脊，不取腰阳关；肩部只是放射不算肩部（X-H-0171、0230）；腰痛取腰阳关（对照）", () => {
  const neck = acupuncture({ diseaseNames: ["痹证"], signedSyndromeText: "风寒湿痹阻证", currentFacts: "晨起出现颈背部强痛,低头加重,并向同侧肩部放射" });
  assert.ok(names(neck).includes("大杼") && !names(neck).includes("腰阳关") && !names(neck).includes("肩髃"), JSON.stringify(names(neck)));
  const back = acupuncture({ diseaseNames: ["痹证"], signedSyndromeText: "风寒湿痹阻证", currentFacts: "腰部冷痛2年" });
  assert.ok(names(back).includes("腰阳关") && !names(back).includes("大杼"), JSON.stringify(names(back)));
});

check("3.3 痹病：痛在外踝后不取内踝的照海（H-tri-1476）；只写踝部时四穴照取（对照）", () => {
  const lateral = acupuncture({ diseaseNames: ["痹证"], signedSyndromeText: "痛痹", currentFacts: "外踝后压痛明显" });
  assert.ok(names(lateral).includes("昆仑") && !names(lateral).includes("照海"), JSON.stringify(names(lateral)));
  const ankle = acupuncture({ diseaseNames: ["痹证"], signedSyndromeText: "痛痹", currentFacts: "右踝关节疼痛" });
  assert.ok(names(ankle).includes("照海") && names(ankle).includes("昆仑"), JSON.stringify(names(ankle)));
});

check("3.4 头痛按部位分经：后枕痛连项只取太阳头痛一组（H-tri-9376），前额痛取阳明一组；没写部位时保持原主穴（对照）", () => {
  const occipital = acupuncture({ diseaseNames: ["头痛"], signedSyndromeText: "风寒头痛", currentFacts: "后枕部疼痛连及项背" });
  assert.ok(names(occipital).includes("天柱") && !names(occipital).includes("头维") && !names(occipital).includes("丝竹空"), JSON.stringify(names(occipital)));
  const frontal = acupuncture({ diseaseNames: ["头痛"], signedSyndromeText: "风寒头痛", currentFacts: "前额胀痛" });
  assert.ok(names(frontal).includes("头维") && !names(frontal).includes("天柱"), JSON.stringify(names(frontal)));
  const unlocated = acupuncture({ diseaseNames: ["头痛"], signedSyndromeText: "风寒头痛", currentFacts: "头痛3天" });
  assert.ok(names(unlocated).includes("头维") && names(unlocated).includes("率谷"), JSON.stringify(names(unlocated)));
});

check("3.5 痿证按上下肢：只左腕下垂取上肢组（H-tri-17725），只双下肢无力取下肢组（H-tri-5395）；四肢无力两组都取（对照）", () => {
  const arm = acupuncture({ diseaseNames: ["痿证"], signedSyndromeText: "脉络瘀阻证", currentFacts: "左腕下垂，前臂麻木" });
  assert.ok(names(arm).includes("肩髃") && !names(arm).includes("髀关"), JSON.stringify(names(arm)));
  const legs = acupuncture({ diseaseNames: ["痿证"], signedSyndromeText: "湿热浸淫证", currentFacts: "双下肢无力，行走困难" });
  assert.ok(names(legs).includes("髀关") && !names(legs).includes("肩髃"), JSON.stringify(names(legs)));
  const all = acupuncture({ diseaseNames: ["痿证"], signedSyndromeText: "湿热浸淫证", currentFacts: "四肢无力3月" });
  assert.ok(names(all).includes("肩髃") && names(all).includes("髀关"), JSON.stringify(names(all)));
});

check("3.6 西医「左膝关节骨关节炎待查」对上膝骨性关节炎节（M-TCMChat-test-336）；「膝骨关节炎」写法照旧（对照）", () => {
  const knee = acupuncture({ diseaseNames: ["骨关节炎"], westernNames: ["左膝关节骨关节炎待查"], signedSyndromeText: "肝肾亏损证", currentFacts: "左膝关节疼痛，活动受限" });
  assert.ok(names(knee).includes("膝眼"), JSON.stringify(names(knee)));
  assert.ok(names(acupuncture({ diseaseNames: ["骨关节炎"], westernNames: ["膝骨关节炎"], signedSyndromeText: "肝肾亏损证", currentFacts: "膝痛" })).includes("膝眼"));
});

// ── 4 证型一致 ─────────────────────────────────────────────────────────────────
check("4.1 「阳气虚衰」是阳虚、「髓海不足」要写到髓海：颤证·气血亏虚证取气血亏虚配穴（H-tri-9278、19050）；本例写阳虚、髓海不足时照取（对照）", () => {
  const qiBlood = acupuncture({ diseaseNames: ["颤证"], signedSyndromeText: "气血亏虚证", currentFacts: "震颤，夜间汗出，乏力" });
  assert.match(qiBlood.treatmentContent, /本例属气血亏虚/, qiBlood.treatmentContent);
  assert.ok(!names(qiBlood).includes("关元"), JSON.stringify(names(qiBlood)));
  const yang = acupuncture({ diseaseNames: ["颤证"], signedSyndromeText: "阳气虚衰证", currentFacts: "畏寒肢冷，汗出" });
  assert.match(yang.treatmentContent, /本例属阳气虚衰/);
  const marrow = acupuncture({ diseaseNames: ["颤证"], signedSyndromeText: "髓海不足证", currentFacts: "头晕目眩，耳鸣，记忆力差" });
  assert.match(marrow.treatmentContent, /本例属髓海不足/);
  // 单防线：本例写「气虚证」（与教材任何一型都不同名），病历有阳气虚衰、髓海不足各自的辨证要点——旧判据会按「气虚」「虚」对上它们。
  const qi = acupuncture({ diseaseNames: ["颤证"], signedSyndromeText: "气虚证", currentFacts: "震颤，畏寒肢冷，汗出，头晕目眩，耳鸣，记忆力差" });
  assert.doesNotMatch(qi.treatmentContent, /阳气虚衰|髓海不足/, qi.treatmentContent);
});

check("4.2 教材注明「属危急之候」的证型只按字面取：风热毒蕴的面部丹毒不写「本例属火毒内陷，加十宣、十二井穴」（H-tri-17402）；签名火毒内陷时照取（对照）", () => {
  const wind = acupuncture({ diseaseNames: ["丹毒"], signedSyndromeText: "风热毒蕴证", currentFacts: "鼻旁红肿灼热" });
  assert.doesNotMatch(wind.treatmentContent, /火毒内陷/);
  assert.ok(!names(wind).includes("十宣"));
  const sunk = acupuncture({ diseaseNames: ["丹毒"], signedSyndromeText: "火毒内陷证", currentFacts: "壮热烦躁" });
  assert.ok(names(sunk).includes("十宣"), JSON.stringify(names(sunk)));
});

check("4.3 主证名与教材证型同名时不再要求二字组证据：痛痹病历写「受凉后疼痛加重」（教材「遇寒痛增」）仍加肾俞、关元（M-TCMChat-test-438）；按概念对上的（寒湿痹阻）仍须证据（对照）", () => {
  const cold = acupuncture({ diseaseNames: ["痹证"], signedSyndromeText: "痛痹", currentFacts: "右侧肩部疼痛，受凉后疼痛症状加重" });
  assert.ok(names(cold).includes("肾俞") && names(cold).includes("关元"), JSON.stringify(names(cold)));
  const concept = acupuncture({ diseaseNames: ["痹证"], signedSyndromeText: "寒湿痹阻证", currentFacts: "右侧肩部疼痛" });
  assert.ok(!names(concept).includes("关元"), JSON.stringify(names(concept)));
});

check("4.4 卡片证名与签名证候是否相符（syndromeLabelFitsSigned）：瘀血阻络对痛痹不符、气血亏虚对痰湿中阻证不符；痰浊上扰对痰湿中阻证、饮食停滞对饮食内停证相符", () => {
  assert.equal(plan.syndromeLabelFitsSigned("瘀血阻络", "痛痹"), false);
  assert.equal(plan.syndromeLabelFitsSigned("气血亏虚", "痰湿中阻证；瘀血阻窍证"), false);
  assert.equal(plan.syndromeLabelFitsSigned("痰浊上扰", "痰湿中阻证"), true);
  assert.equal(plan.syndromeLabelFitsSigned("饮食停滞", "饮食内停证"), true);
});

check("4.5 目录配穴只按病机叙述命中时须与证候结论相符：失眠模板不因节点「气血不足，心神失养」写「按心脾两虚取穴」给肝火扰心证、心火亢盛证；签名心脾两虚时照写（对照）", () => {
  // 单防线：心火亢盛证在失眠模板里没有按证候结论命中的配穴，只能按叙述命中（M-TCMChat-test-352 同类：叙述「久病气血不足」写成按气血亏虚取穴）。
  const fire = card(compile(signedPrior("不寐", "心火亢盛证", "病久心脾两虚，心神失养"), "失眠2月", "入睡困难，多梦，心烦", [{ projectCode: "acupuncture", targetRef: "P1" }]), "acupuncture");
  assert.doesNotMatch(fire?.treatmentContent || "", /心脾两虚/, fire?.treatmentContent);
  const prior = signedPrior("不寐", "肝火扰心证", "久病气血不足，心神失养");
  const needle = card(compile(prior, "失眠2月", "入睡困难，多梦，烦躁易怒", [{ projectCode: "acupuncture", targetRef: "P1" }]), "acupuncture");
  assert.doesNotMatch(needle?.treatmentContent || "", /心脾两虚/, needle?.treatmentContent);
  const control = card(compile(signedPrior("不寐", "心脾两虚证", "心脾两虚，心神失养"), "失眠2月", "入睡困难，多梦易醒，心悸健忘，神疲食少", [{ projectCode: "acupuncture", targetRef: "P1" }]), "acupuncture");
  assert.match(control?.treatmentContent || "", /心脾两虚/, control?.treatmentContent);
});

// ── 5 别的病的目录模板 ─────────────────────────────────────────────────────────
check("5.1 主诉写着伴随的头痛、按证型加减过的头痛模板也不给眩晕：眩晕·痰湿中阻证用教材眩晕方案（M-TCMChat-test-352）；头痛病例照用头痛模板（对照）", () => {
  const dizzy = card(compile(signedPrior("眩晕", "痰湿中阻证", "反复头晕头痛，痰湿中阻，清阳不升，上扰清窍", "高血压待查"), "反复头晕头痛3年", "头晕，头痛，恶心欲吐，苔白腻，脉弦滑",
    [{ projectCode: "acupuncture", targetRef: "P1" }]), "acupuncture");
  assert.doesNotMatch(dizzy?.treatmentContent || "", /针对本例头痛/, dizzy?.treatmentContent);
  assert.ok(bare(dizzy?.suggestedSitesOrPoints).includes("丰隆"), JSON.stringify(dizzy?.suggestedSitesOrPoints));
  const headache = card(compile(signedPrior("头痛", "风寒头痛证", "风寒袭表，经气不利", "紧张型头痛"), "头痛3天", "头痛，恶风",
    [{ projectCode: "auricular", targetRef: "P1" }]), "auricular");
  assert.ok(headache, "头痛病例的耳穴卡照出");
});

check("5.2 本病没有教材方案、模板又对的是伴随症状：五迟不给腹胀模板、瘿痈不给头痛耳穴模板（H-tri-14474、7467）；胃痞的耳穴卡照用胃肠耳穴模板（同症状域，对照）", () => {
  const goiter = compile(signedPrior("瘿痈", "风热痰凝证", "风热犯表，热壅咽喉", "亚急性甲状腺炎"), "颈部肿大疼痛伴发热3天，咽痛，头痛", "颈部肿大疼痛，头痛",
    [{ projectCode: "auricular", targetRef: "P1" }]);
  assert.ok(!goiter.some((item) => /针对本例头痛/.test(item.treatmentContent || "")), JSON.stringify(goiter.map((item) => item.treatmentContent)));
  const stomach = card(compile(signedPrior("胃痞", "胃阴不足证", "胃阴不足，胃气壅滞不降", "慢性胃炎"), "胃脘痞满半年", "胃脘痞满，嗳气，口干",
    [{ projectCode: "auricular", targetRef: "P1" }]), "auricular");
  assert.ok(stomach && stomach.tailoringStatus !== "assessment_only", JSON.stringify(stomach));
});

check("5.4 教材有本病耳穴方案时，模板匹配词只借教材节又名才相合的不算本病：胃痛的耳穴卡用教材「胃、十二指肠、脾、肝…」（M-TCM-BEST4SDT-112），不用通用胃肠耳穴模板", () => {
  const ear = card(compile(signedPrior("胃痛", "肝胃郁热证", "肝胃郁热，胃失和降", "慢性胃炎"), "胃脘灼痛1月", "胃脘灼痛，嗳气反酸",
    [{ projectCode: "auricular", targetRef: "P1" }]), "auricular");
  assert.ok(bare(ear?.suggestedSitesOrPoints).includes("十二指肠"), JSON.stringify(ear?.suggestedSitesOrPoints));
});

check("5.5 目录证型配穴主证先于兼证：脾胃虚寒证兼湿热中阻证按脾胃虚寒取穴（M-TCM-RobustSDT-single_0614 曾写「按湿热中阻取穴」）；主证湿热中阻时按湿热中阻（对照）", () => {
  const run = (primary, secondary) => card(compile(signedPrior("胃痛", primary, "脾胃虚寒，胃失温养", "慢性胃炎", {}, secondary), "上腹部隐痛半年",
    "上腹部隐痛，偶有反酸，晨起口苦、口粘，进食生冷加重", [{ projectCode: "acupuncture", targetRef: "P1" }]), "acupuncture");
  const cold = run("脾胃虚寒证", ["湿热中阻证"]);
  assert.match(cold?.treatmentContent || "", /按脾胃虚寒取穴/, cold?.treatmentContent);
  // 食疗卡同样先按主证选方。
  const dietCard = card(compile(signedPrior("胃痛", "脾胃虚寒证", "脾胃虚寒，胃失温养", "慢性胃炎", {}, ["湿热中阻证"]), "上腹部隐痛半年",
    "上腹部隐痛，喜温喜按，泛吐清水，神疲乏力", [{ projectCode: "diet_therapy", targetRef: "P1" }]), "diet_therapy");
  assert.doesNotMatch(dietCard?.treatmentContent || "", /湿热中阻：/, dietCard?.treatmentContent);
  const damp = run("湿热中阻证", ["脾胃虚寒证"]);
  assert.doesNotMatch(damp?.treatmentContent || "", /按脾胃虚寒/, damp?.treatmentContent);
});

check("5.3 模板写「先排除骨折、感染…」而已签名就是膝关节结核：不给这张骨骼肌肉模板（H-tri-16689）；膝骨关节炎照给（对照）", () => {
  assert.equal(cap.templateExcludesSignedDiagnosis("先排除骨折、感染、进行性神经损害及脊髓压迫。", "骨关节结核；膝关节结核"), true);
  assert.equal(cap.templateExcludesSignedDiagnosis("先排除骨折、感染、进行性神经损害及脊髓压迫。", "膝痹；膝骨关节炎"), false);
  const tb = card(compile(signedPrior("骨关节结核", "阳虚痰凝证", "寒痰凝滞膝之筋骨", "膝关节结核"), "左膝关节红肿疼痛1年余", "左膝关节红肿疼痛，活动时加剧",
    [{ projectCode: "acupuncture", targetRef: "P1" }]), "acupuncture");
  assert.ok(!tb || tb.tailoringStatus === "assessment_only", JSON.stringify(tb?.suggestedSitesOrPoints));
});

// ── 6 写给别的证型、别的病程的小句 ─────────────────────────────────────────────
check("6.1 「风寒湿痹可加用灸法，热痹局部可点刺出血。」对痛痹、着痹只留前一小句（X-H-0059 等 7 例）；湿热痹阻留热痹那一小句、灸法照旧按热证去掉（对照）", () => {
  const text = "毫针常规刺，病在筋骨可深刺，可用电针。风寒湿痹可加用灸法，热痹局部可点刺出血。";
  assert.equal(plan.cardSentencesMatchedToSyndrome(text, ["痹证"], "痛痹"), "毫针常规刺，病在筋骨可深刺，可用电针。风寒湿痹可加用灸法。");
  assert.equal(plan.cardSentencesMatchedToSyndrome(text, ["痹证"], "着痹"), "毫针常规刺，病在筋骨可深刺，可用电针。风寒湿痹可加用灸法。");
  assert.equal(plan.cardSentencesMatchedToSyndrome(text, ["痹证"], "湿热痹阻证"), "毫针常规刺，病在筋骨可深刺，可用电针。热痹局部可点刺出血。");
});

check("6.2 小句开头的证型名带「可/者」：「肾阳虚衰可用隔附子饼灸」对脾胃虚弱去掉、「肾气亏虚、脾气虚弱者可温针灸」对膀胱气化不利去掉（X-H-0146、H-tri-12679）；相符的照留（对照）", () => {
  const text = "寒湿内盛、脾胃虚弱可用隔姜灸、温和灸或温针灸；肾阳虚衰可用隔附子饼灸。";
  assert.equal(plan.cardSentencesMatchedToSyndrome(text, ["泄泻"], "脾胃虚弱证"), "寒湿内盛、脾胃虚弱可用隔姜灸、温和灸或温针灸；");
  assert.equal(plan.cardSentencesMatchedToSyndrome(text, ["泄泻"], "肾阳虚衰证"), "肾阳虚衰可用隔附子饼灸。");
  assert.equal(plan.cardSentencesMatchedToSyndrome("毫针常规刺。肾气亏虚、脾气虚弱者可温针灸。", ["癃闭"], "膀胱气化不利证"), "毫针常规刺。");
  assert.equal(plan.cardSentencesMatchedToSyndrome("毫针常规刺。瘀血阻络者可用三棱针点刺出血。", ["胁痛"], "肝郁气滞证"), "毫针常规刺。");
  assert.equal(plan.cardSentencesMatchedToSyndrome("毫针常规刺。瘀血阻络者可用三棱针点刺出血。", ["胁痛"], "瘀血阻络证"), "毫针常规刺。瘀血阻络者可用三棱针点刺出血。");
});

check("6.3 病程：十年腰痛不印「急性腰痛，痛势剧烈者…三棱针点刺出血」，慢性泄泻只留慢性那一小句（X-H-0097、0146）；急性病程反过来（对照）；caseCourse 读西医诊断与主诉病程", () => {
  assert.equal(plan.caseCourse(["慢性非特异性腰痛"], ""), "chronic");
  assert.equal(plan.caseCourse([""], "腰部疼痛10年余"), "chronic");
  assert.equal(plan.caseCourse([""], "腰痛3天"), "acute");
  assert.equal(plan.caseCourse([""], "腰痛1月"), undefined);
  const lumbar = "毫针常规刺。急性腰痛，痛势剧烈者，阿是穴、委中可用三棱针点刺出血。";
  assert.equal(plan.cardSentencesMatchedToSyndrome(lumbar, ["腰痛"], "瘀血腰痛", "chronic"), "毫针常规刺。");
  assert.equal(plan.cardSentencesMatchedToSyndrome(lumbar, ["腰痛"], "瘀血腰痛", "acute"), lumbar);
  const diarrhea = "急性泄泻每日治疗1~2次，慢性泄泻每日或隔日治疗1次。";
  assert.equal(plan.cardSentencesMatchedToSyndrome(diarrhea, ["泄泻"], "脾胃虚弱证", "chronic"), "慢性泄泻每日或隔日治疗1次。");
  assert.equal(plan.cardSentencesMatchedToSyndrome(diarrhea, ["泄泻"], "脾胃虚弱证", undefined), diarrhea);
});

check("6.5 「本例属X，在主穴基础上加…」是出卡时按签名证候写的，不再按类型名筛（M-TCM-SD-461569 曾剩下没头的「在主穴基础上加…」）", () => {
  const text = "治法：舒筋骨、通经络。本例属寒湿痹阻，在主穴基础上加肾俞、关元。";
  assert.equal(plan.cardSentencesMatchedToSyndrome(text, ["痹证"], "痛痹"), text);
});

check("6.4 条件证型按概念比：「胃寒积滞、脾胃虚弱可加灸」对胃中寒冷证留、对胃气上逆证去；「冷秘、虚秘可加用灸法」对气秘去、对虚秘留；「瘀血腰痛和寒湿腰痛可行刺络拔罐」对湿热腰痛去；「寒证可用艾灸法」不当证型名", () => {
  const hiccup = "毫针常规刺。胃火上逆、气机郁滞只针不灸，泻法；胃寒积滞、脾胃虚弱可加灸。";
  assert.equal(plan.cardSentencesMatchedToSyndrome(hiccup, ["呃逆"], "胃中寒冷证"), hiccup);
  assert.equal(plan.cardSentencesMatchedToSyndrome(hiccup, ["呃逆"], "胃气上逆证"), "毫针常规刺。胃火上逆、气机郁滞只针不灸，泻法；");
  const constipation = "毫针常规刺。冷秘、虚秘可加用灸法。";
  assert.equal(plan.cardSentencesMatchedToSyndrome(constipation, ["便秘"], "气秘"), "毫针常规刺。");
  assert.equal(plan.cardSentencesMatchedToSyndrome(constipation, ["便秘"], "虚秘"), constipation);
  const cupping = "取肾俞、大肠俞、阿是穴。瘀血腰痛和寒湿腰痛可行刺络拔罐。";
  assert.equal(plan.cardSentencesMatchedToSyndrome(cupping, ["腰痛"], "湿热腰痛"), "取肾俞、大肠俞、阿是穴。");
  assert.equal(plan.cardSentencesMatchedToSyndrome(cupping, ["腰痛"], "瘀血腰痛"), cupping);
  const abdomen = "毫针常规刺。寒证可用艾灸法。";
  assert.equal(plan.cardSentencesMatchedToSyndrome(abdomen, ["腹痛"], "肝郁气滞证"), abdomen);
});

// ── 7 卡片文字与穴位表一致 ─────────────────────────────────────────────────────
check("7.1 禁针穴不写进「在主穴基础上加…」：呕吐·脾胃虚寒只写加脾俞（X-H-0174、0163）", () => {
  const vomit = acupuncture({ diseaseNames: ["呕吐"], signedSyndromeText: "脾胃虚寒证", currentFacts: "呕吐清水，喜暖畏寒，神疲乏力，大便溏薄" });
  assert.doesNotMatch(vomit.treatmentContent, /神阙/, vomit.treatmentContent);
  assert.match(vomit.treatmentContent, /加脾俞/, vomit.treatmentContent);
});

check("7.2 点名卡外穴位的注意小句连同「以免…」下半句去掉，并列穴名只留卡上的，「背俞穴…」在卡上没有背俞穴时去掉（H-tri-3750、14396、15803、5396）；卡上有的照留（对照）", () => {
  assert.equal(plan.cardSentencesNamingListedPoints("毫针常规刺，肺俞不宜直刺、深刺，以免伤及内脏；阴水可加灸。", ["三焦俞（BL22）", "水分"]), "毫针常规刺；阴水可加灸。");
  assert.equal(plan.cardSentencesNamingListedPoints("毫针常规刺，肺俞不宜直刺、深刺，以免伤及内脏；阴水可加灸。", ["肺俞（BL13）", "水分"]), "毫针常规刺，肺俞不宜直刺、深刺，以免伤及内脏；阴水可加灸。");
  assert.equal(plan.cardSentencesNamingListedPoints("毫针刺，用泻法。大敦、隐白可点刺出血。", ["大敦", "行间"]), "毫针刺，用泻法。大敦可点刺出血。");
  assert.equal(plan.cardSentencesNamingListedPoints("泻申脉，补照海；背俞穴注意针刺的方向、角度和深度；余穴常规针刺。", ["照海", "申脉", "神门"]), "泻申脉，补照海；余穴常规针刺。");
  assert.equal(plan.cardSentencesNamingListedPoints("泻申脉，补照海；背俞穴注意针刺的方向、角度和深度；余穴常规针刺。", ["照海", "申脉", "心俞（BL15）"]), "泻申脉，补照海；背俞穴注意针刺的方向、角度和深度；余穴常规针刺。");
});

check("7.3 以卡外穴名开头的做法小句去掉（「神阙用灸，余穴毫针常规刺」只留后半）；穴名在小句中间的部位说法照留（「使针感能到达会阴」）", () => {
  assert.equal(plan.cardSentencesNamingListedPoints("神阙用灸，余穴毫针常规刺。", ["天枢", "大肠俞"]), "余穴毫针常规刺。");
  const bladder = "毫针常规刺，针刺中极时针尖向下，使针感能到达会阴并引起小腹收缩、抽动为佳，不可过深，以免伤及膀胱；";
  assert.equal(plan.cardSentencesNamingListedPoints(bladder, ["中极", "膀胱俞"]), bladder.replace(/；$/u, "。"));
  assert.equal(plan.cardSentencesNamingListedPoints("少商、商阳用点刺放血法。毫针常规刺。", ["列缺", "合谷"]), "毫针常规刺。");
});

// ── 8 耳穴与操作栏 ─────────────────────────────────────────────────────────────
check("8.1 耳穴：「相应病变脏腑（肺、脾、肝、肾）」不当穴名列出（H-tri-13758）；扫描错字「顽同性」改「顽固性」（H-tri-10297）；操作栏不重抄治疗内容（X-H-0334 等 10 张）", () => {
  const hiccup = project("auricular", { diseaseNames: ["呃逆"], signedSyndromeText: "胃气上逆证", currentFacts: "呃逆频作" });
  assert.ok(!names(hiccup).includes("相应病变脏腑") && names(hiccup).includes("耳中") && names(hiccup).includes("脾"), JSON.stringify(names(hiccup)));
  assert.match(hiccup.treatmentContent, /相应病变脏腑（肺、脾、肝、肾）/, "治疗内容照写原句");
  assert.ok(!hiccup.techniqueBoundary.includes("取耳中"), hiccup.techniqueBoundary);
  const headache = project("auricular", { diseaseNames: ["头痛"], signedSyndromeText: "风寒头痛", currentFacts: "头痛" });
  assert.match(headache.treatmentContent, /顽固性头痛/);
  assert.doesNotMatch(headache.treatmentContent, /顽同性/);
});

check("8.2 针刺操作栏不重印已作疗程栏的频次句（头痛「急性发作时每日治疗1-2次…」）；没有频次句的操作照留（对照）", () => {
  const headache = acupuncture({ diseaseNames: ["头痛"], signedSyndromeText: "风寒头痛", currentFacts: "后枕部疼痛连及项背" });
  assert.match(headache.scheduleSuggestion, /头痛急性发作时每日治疗1-2次/);
  assert.doesNotMatch(headache.techniqueBoundary, /每日治疗1-2次/, headache.techniqueBoundary);
  assert.match(headache.techniqueBoundary, /风池穴应严格掌握针刺方向和深度/);
});

check("8.3 偏头痛专病方案与专家共识的频次只给写到偏头痛的病例（H-tri-10297、9376 耳穴卡）；写偏头痛的照给（对照）", () => {
  const plain = project("auricular", { diseaseNames: ["头痛"], signedSyndromeText: "风寒头痛", currentFacts: "后枕痛连项" });
  assert.doesNotMatch(plain.scheduleSuggestion, /偏头痛/);
  const migraine = project("auricular", { diseaseNames: ["头痛"], westernNames: ["偏头痛"], signedSyndromeText: "肝阳头痛", currentFacts: "右侧偏头痛反复发作" });
  assert.match(migraine.scheduleSuggestion, /偏头痛/);
  const schedules = JSON.parse(readFileSync("src/data/tcm-nondrug-web-schedules.source.json", "utf8")).entries;
  for (const entry of schedules.filter((item) => /偏头痛/.test(item.sourceTitle))) assert.deepEqual(entry.requiresWesternContext, ["偏头痛"], entry.sourceTitle);
});

// ── 9 食疗 ─────────────────────────────────────────────────────────────────────
const diet = (input) => project("diet_therapy", input);
check("9.1 病历日泻多次时，方里有「大便溏泻者慎用」的苦杏仁不选（《中药学》苦杏仁使用注意，M single_0501 杏仁橘红粥）；大便正常、或同时写着二便调时不拦（对照）", () => {
  const recipe = "苦杏仁6g，粳米50g，煮粥，每日1次。";
  assert.equal(plan.recipeConflictsWithRecordedCaution(recipe, "咳嗽痰多，腹泻日7-9次", "痰浊壅肺证"), true);
  assert.equal(plan.recipeConflictsWithRecordedCaution(recipe, "咳嗽痰多，胸闷", "痰浊壅肺证"), false);
  assert.equal(plan.recipeConflictsWithRecordedCaution(recipe, "咳嗽痰多，偶有腹泻，二便调", "痰浊壅肺证"), false);
  assert.equal(plan.recipeConflictsWithRecordedCaution("山药30g，粳米50g，煮粥。", "腹泻日7-9次", "脾虚证"), false, "山药无此注意（对照）");
});

check("9.2 糖尿病：含糖（白糖、冰糖、蜂蜜…）与精白米超过 30g 的粥饭不选（《成人糖尿病食养指南（2023年版）》，M-TCMChat-test-405 葛根粉粥）；指南自己示例量的粥（粳米30g）不拦（对照）", () => {
  assert.equal(plan.recipeUnsuitableForDiabetes("粳米100g加水适量，武火煮沸，改文火煮至米半熟，加葛根粉30g拌匀，至米烂成粥即可，每日早晚服用。"), true);
  assert.equal(plan.recipeUnsuitableForDiabetes("桑椹500g，百合100g，蜂蜜300g。前两味加水适量煎煮。"), true);
  assert.equal(plan.recipeUnsuitableForDiabetes("百合15g，莲子10g，粳米30g。同煮为粥。"), false);
  const diabetic = diet({ diseaseNames: ["消渴"], signedSyndromeText: "胃热炽盛证", currentFacts: "多食易饥，口渴", recordedDiabetes: true });
  assert.ok(!diabetic || !/葛根粉粥/.test(diabetic.treatmentContent), diabetic?.treatmentContent);
  const control = diet({ diseaseNames: ["消渴"], signedSyndromeText: "胃热炽盛证", currentFacts: "多食易饥，口渴" });
  assert.ok(control, "不按糖尿病过滤时照出（对照）");
});

check("9.3 药典上限不超过 10g 的辛香峻烈药材超量的方子不选：二姜茶高良姜 15g（药典 3～6g，M-TCM-BEST4SDT-254）；山药、百合按食物量的不卡，整料制膏「每次1汤匙」的不卡（对照）", () => {
  assert.equal(plan.recipeExceedsHighRiskHerbDose("干姜5g，高良姜15g，肉桂5g，泡水代茶饮。"), true);
  assert.equal(plan.recipeExceedsHighRiskHerbDose("山药100g，粳米50g，煮粥。"), false);
  assert.equal(plan.recipeExceedsHighRiskHerbDose("桑椹500g，百合100g，蜂蜜300g。前两味加水适量煎煮，待凉装瓶备用。每次1汤匙，沸水冲化饮用。"), false);
  assert.equal(plan.recipeExceedsHighRiskHerbDose("天麻50g，菊花50g，枸杞子30g，共研末。每次服10g，日2次，开水送服。"), false);
  assert.equal(plan.recipeExceedsHighRiskHerbDose("高良姜5g，粳米50g，煮粥。"), false, "药典量内（对照）");
  assert.equal(plan.recipeExceedsHighRiskHerbDose("香橼500g，加水浸泡2小时，入蒸馏器内蒸2次，收集芳香蒸馏液。每服30mL，炖温服，日2次。"), false, "蒸馏、每服若干的整料（对照）");
  assert.equal(plan.recipeExceedsHighRiskHerbDose("高良姜50g，研为细末。每服5g，日2次，温水送下。"), false, "研末后每服若干（对照）");
});

check("9.4 饮食调护或注意事项写明忌茶时不选含茶叶的方子（X-H-0163 姜茶饮）；没写时照选（对照）；dietAdviceAvoidsTea 不把「代茶饮」当忌茶", () => {
  assert.equal(plan.dietAdviceAvoidsTea("服药期间不宜喝茶"), true);
  assert.equal(plan.dietAdviceAvoidsTea("忌浓茶、咖啡"), true);
  assert.equal(plan.dietAdviceAvoidsTea("可用菊花泡水代茶饮"), false);
  const tea = diet({ diseaseNames: ["呕吐"], signedSyndromeText: "脾胃阳虚证", currentFacts: "呕吐清水，喜暖畏寒", avoidTea: true });
  assert.ok(!tea || !/绿茶|茶叶/.test(tea.treatmentContent), tea?.treatmentContent);
  const control = diet({ diseaseNames: ["呕吐"], signedSyndromeText: "脾胃阳虚证", currentFacts: "呕吐清水，喜暖畏寒" });
  assert.match(control?.treatmentContent || "", /姜茶饮/, control?.treatmentContent);
});

check("9.5 食疗疗程栏照方子自己的服法写（「每早空腹及午饭前各服半杯」「趁热频服饮用」），不再一律「随三餐食用」（X-H-0326、0174）", () => {
  const constipation = diet({ diseaseNames: ["便秘"], signedSyndromeText: "热秘", currentFacts: "大便干结，口臭" });
  assert.match(constipation.scheduleSuggestion, /每早空腹及午饭前各服半杯/, constipation.scheduleSuggestion);
  const vomit = diet({ diseaseNames: ["呕吐"], signedSyndromeText: "脾胃阳虚证", currentFacts: "呕吐清水，喜暖畏寒" });
  assert.match(vomit.scheduleSuggestion, /趁热频服/, vomit.scheduleSuggestion);
  assert.doesNotMatch(`${constipation.scheduleSuggestion}${vomit.scheduleSuggestion}`, /随三餐食用/);
});

// ── 10 其他 ────────────────────────────────────────────────────────────────────
check("10.1 「主治含X」只读病历当前阳性面：「发病后无发热」「喜热恶寒」「受凉、咳嗽、伸腿疼痛加重」都不算（H-tri-10322、10720、1476）；直写的症状与已签名病名照算（对照）", () => {
  assert.deepEqual(cap.acupointCaseTerms("发病后无发热,精神差"), []);
  assert.deepEqual(cap.acupointCaseTerms("脐腹部隐痛,喜热恶寒"), []);
  assert.deepEqual(cap.acupointCaseTerms("间断性腰腿酸痛麻木数月,加重数天,受凉、咳嗽、伸腿疼痛加重"), ["麻木"]);
  assert.deepEqual(cap.acupointCaseTerms("恶寒发热，咳嗽2天"), ["恶寒", "发热", "咳嗽"]);
  assert.deepEqual(cap.acupointCaseTerms("腰部酸困", ["腰痛"]), ["腰痛"]);
});

check("10.2 小儿不写深刺、重刺激：9 岁患儿痹证卡不印「病在筋骨可深刺」（H-tri-3721）；成人照写（对照）", () => {
  const text = "毫针常规刺，病在筋骨可深刺，可用电针。";
  // 第五轮后半（r1019-round5-cards 5.17）：小儿也不写电针——同一病例 H-tri-3721 的复评点名「可用电针」与「浅刺快出」相抵。
  assert.equal(plan.operationClausesForAge(text, 9), "毫针常规刺。");
  assert.equal(plan.operationClausesForAge(text, 40), text);
});

check("10.3 出血倾向也读已签名西医诊断（「凝血功能障碍相关出血待查」，X-H-0370）：不推荐按揉、灸、罐；诊断无关时不拦（对照）", () => {
  const prior = signedPrior("血证", "气不摄血证", "针伤血络，血溢脉外", "凝血功能障碍相关出血待查");
  const state = { chiefComplaint: "针刺后局部血肿", symptoms: { 现病史: "针刺合谷后次日局部形成血肿" }, patient: { sex: "男", age: 20 } };
  assert.match(String(cap.tcmTreatmentProjectExclusionReason("tuina", prior, state)), /出血倾向/);
  assert.equal(cap.tcmTreatmentProjectExclusionReason("tuina", signedPrior("血证", "气不摄血证", "针伤血络", "皮下血肿"), state), undefined);
});

check("10.4 注意事项提到本例没给的食疗时整条不留（H-tri-10295「针刺与食疗须在专科评估后由医师安排」）；给了食疗卡时照留（对照）", () => {
  const line = "针刺与食疗须在专科评估后由医师安排，勿自行操作。";
  assert.equal(cap.precautionMentionsUndeliveredTreatment(line, new Set(["acupuncture"])), true);
  assert.equal(cap.precautionMentionsUndeliveredTreatment(line, new Set(["acupuncture", "diet_therapy"])), false);
});

// ── 11 第五轮（2026-10-19，21b9bef 上留出 32 例与甲方 10 例的 Claude 评审）─────────────
check("11.1 卡面「针对本例…」部位连同同句不适写（「胃脘不舒服」「胃脘胀满」，S077、S158），「不消化的食物」不写成「消化」（S054），脏腑名「胃肠、脾胃」不写；直写的症状照写（对照）", () => {
  assert.deepEqual(cap.indicationEvidenceTerms("digestive", "吃得少,吃完饭胃脘就不舒服,全身倦怠"), ["胃脘不舒服"]);
  assert.deepEqual(cap.indicationEvidenceTerms("digestive", "不思饮食、腹胀2周；胃脘、腹部胀满"), ["腹胀", "胃脘胀满"]);
  assert.deepEqual(cap.indicationEvidenceTerms("digestive", "晨起腹泻,泻后腹痛即止,大便稀薄,夹有不消化的食物"), ["腹泻", "腹痛"]);
  assert.deepEqual(cap.indicationEvidenceTerms("digestive", "消化不良半年，胃肠功能紊乱"), ["消化不良"]);
});

check("11.2 「主治含X」：症状词后面紧跟「时」是另一件事的情形——「咳嗽或大笑时有漏尿」不算咳嗽（S114 太溪）；直写的咳嗽照算（对照）", () => {
  assert.deepEqual(cap.acupointCaseTerms("小便次数多,咳嗽或大笑时有漏尿"), []);
  assert.deepEqual(cap.acupointCaseTerms("咳嗽时胸痛"), ["胸痛"], "胸痛是本例症状，咳嗽只是它发生的情形");
  assert.deepEqual(cap.acupointCaseTerms("咳嗽2天，咽痒"), ["咳嗽"]);
});

check("11.3 两字证型名开头的条件句：「血寒、血虚、肾虚可加灸」对痰湿证去掉（S102、X-H-0264），对肾虚证照留（对照）", () => {
  const text = "毫针常规刺。血寒、血虚、肾虚可加灸。";
  assert.equal(plan.cardSentencesMatchedToSyndrome(text, ["月经后期"], "痰湿证"), "毫针常规刺。");
  assert.equal(plan.cardSentencesMatchedToSyndrome(text, ["月经后期"], "肾虚证"), text);
  assert.equal(plan.cardSentencesMatchedToSyndrome("毫针常规刺。局部可加拔罐。", ["月经后期"], "痰湿证"), "毫针常规刺。局部可加拔罐。", "「局部」不是证型（对照）");
});

check("11.4 食疗疗程栏不把做法步骤当服法：「加白糖拌匀服」（S046 白糖番茄）不进疗程栏；方子自己写的服法照写（对照）", () => {
  const hiccup = diet({ diseaseNames: ["呃逆"], signedSyndromeText: "胃火上逆证", currentFacts: "呃声洪亮，口臭烦渴" });
  assert.match(hiccup.treatmentContent, /白糖番茄/);
  assert.doesNotMatch(hiccup.scheduleSuggestion, /拌匀/, hiccup.scheduleSuggestion);
  const vomit = diet({ diseaseNames: ["呕吐"], signedSyndromeText: "脾胃阳虚证", currentFacts: "呕吐清水，喜暖畏寒" });
  assert.match(vomit.scheduleSuggestion, /趁热频服/);
});

check("11.5 疗程栏只放频次那几小句，补泻只改那一小句：咳嗽卡疗程栏是「每日或隔日治疗1次」、不是「针用泻法」（S011、S151）；痛风卡的齐刺留在操作栏、疗程栏只写「每日1~2次」（S145）", () => {
  assert.equal(plan.manipulationMatchedToSyndrome("内伤咳嗽针用平补平泻或补法，每日或隔日治疗1次。", "痰热郁肺证", "实则泻之"), "针用泻法，每日或隔日治疗1次。");
  const cough = acupuncture({ diseaseNames: ["咳嗽"], signedSyndromeText: "痰热郁肺证", signedPrinciple: "实则泻之", currentFacts: "咳嗽痰黄" });
  assert.match(cough.scheduleSuggestion, /^每日或隔日治疗1次。/, cough.scheduleSuggestion);
  const gout = acupuncture({ diseaseNames: ["痛风"], signedSyndromeText: "湿热阻痹", signedPrinciple: "实则泻之", currentFacts: "右足第一跖趾关节红肿热痛" });
  assert.match(gout.scheduleSuggestion, /^每日1~2次。/, gout.scheduleSuggestion);
  assert.match(gout.techniqueBoundary, /齐刺/);
  assert.doesNotMatch(gout.scheduleSuggestion, /齐刺/);
});

check("11.6 人群、病程专篇的频次：36 岁热秘不引用老年便秘方案（S055），70 岁照引（对照）；急性荨麻疹不引用慢性荨麻疹方案（S128），慢性荨麻疹照引（对照）", () => {
  const young = acupuncture({ diseaseNames: ["便秘"], westernNames: ["便秘"], signedSyndromeText: "热秘", currentFacts: "大便干结5天", patientAgeYears: 36 });
  assert.doesNotMatch(young.scheduleSuggestion, /老年便秘/);
  const old = acupuncture({ diseaseNames: ["便秘"], westernNames: ["便秘"], signedSyndromeText: "热秘", currentFacts: "大便干结5天", patientAgeYears: 72 });
  assert.match(old.scheduleSuggestion, /老年便秘/);
  const acute = acupuncture({ diseaseNames: ["瘾疹"], westernNames: ["急性荨麻疹"], signedSyndromeText: "胃肠湿热证", currentFacts: "全身风团伴腹痛1天", chiefComplaint: "全身风团伴腹痛1天" });
  assert.doesNotMatch(acute.scheduleSuggestion, /慢性荨麻疹/);
  const chronic = acupuncture({ diseaseNames: ["瘾疹"], westernNames: ["慢性荨麻疹"], signedSyndromeText: "胃肠湿热证", currentFacts: "风团反复发作半年", chiefComplaint: "风团反复发作半年" });
  assert.match(chronic.scheduleSuggestion, /慢性荨麻疹/);
});

check("11.7 按证型配了穴时治法写已签名的那一条（S131 脾虚湿蕴、S132 血虚风燥曾印「清热利湿，润燥息风」）；没配上证型时照旧只写按病取的主穴（对照）；「以…为主」的取穴说明照留（颤证）", () => {
  const spleen = acupuncture({ diseaseNames: ["湿疮"], signedSyndromeText: "脾虚湿蕴证", signedMethod: "健脾利湿止痒", currentFacts: "双手皮疹瘙痒，纳差，大便溏" });
  assert.match(spleen.treatmentContent, /^治法：健脾利湿止痒。取皮损局部和足太阴经穴为主。本例属脾虚湿蕴/, spleen.treatmentContent);
  assert.doesNotMatch(spleen.treatmentContent, /清热利湿，润燥息风/);
  const untailored = acupuncture({ diseaseNames: ["湿疮"], signedSyndromeText: "湿瘀互结证", signedMethod: "利湿化瘀", currentFacts: "皮损肥厚" });
  assert.match(untailored.treatmentContent, /^按病取基本穴/, untailored.treatmentContent);
  const tremor = acupuncture({ diseaseNames: ["颤证"], signedSyndromeText: "气血亏虚证", signedMethod: "益气养血，濡养筋脉", currentFacts: "震颤，乏力，心悸" });
  assert.match(tremor.treatmentContent, /^治法：益气养血，濡养筋脉。以督脉、足厥阴、足少阳经穴为主。/, tremor.treatmentContent);
});

check("11.8 牙痛耳穴「上颌或下颌」按牙位取（甲方病历 7 右下牙痛只取下颌），牙位没写时两个都留（对照）；疗程栏写了换贴间隔或留针时长时，技术边界不再并列「留置3～7天」（病历 7、8）", () => {
  const lower = project("auricular", { diseaseNames: ["牙痛"], signedSyndromeText: "胃火牙痛", currentFacts: "右侧下牙持续性胀痛" });
  assert.ok(names(lower).includes("下颌") && !names(lower).includes("上颌"), JSON.stringify(names(lower)));
  const unknown = project("auricular", { diseaseNames: ["牙痛"], signedSyndromeText: "胃火牙痛", currentFacts: "牙痛3天" });
  assert.ok(names(unknown).includes("上颌") && names(unknown).includes("下颌"));
  assert.match(lower.scheduleSuggestion, /隔日换贴/);
  assert.doesNotMatch(lower.techniqueBoundary, /留置3～7天/, lower.techniqueBoundary);
  const stomach = project("auricular", { diseaseNames: ["呃逆"], signedSyndromeText: "胃气上逆证", currentFacts: "呃逆频作" });
  assert.match(stomach.techniqueBoundary, /留置3～7天/, "疗程栏没写间隔时照写（对照）");
});

console.log(JSON.stringify({ suite: "r1019-round4-cards", cases, failures: failures.length }));
if (failures.length > 0) process.exitCode = 1;
