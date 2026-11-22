// 第五十五轮（2026-11-22）：甲方三轮测评病例在生产重跑后，点名过又复现的三类，各收成一处判据（模型调用一律不发生）。
//  A 顺带的睡眠差加安神药：编译期、补写、定稿后专写三条路用同一个判据（incidentalSleepModificationBlocked）。此前补写/专写只认几种睡眠写法，
//    10.26 病历1 感冒「睡眠欠佳：加远志」、10.29 积滞「夜卧不安：加酸枣仁」从这条路进来；
//  B 西医病名与依据句的确定程度：依据句自己说「诊断尚不确立」「需完善确诊分型」「病程未达门槛」时病名写待查（11.05 病例12 小儿厌食症、10.29 2型糖尿病）；
//  C 合称改名不再因锁定方失效而放弃：按新证名重选锁定方（10.29 c22「气血两虚误判为心气虚证」，七福饮 → 八珍汤）。
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const root = process.cwd();
const jiti = createJiti(import.meta.url, { alias: { "@": `${root}/src`, "server-only": `${root}/node_modules/next/dist/compiled/server-only/empty.js` } });
const sleep = await jiti.import("../src/lib/incidental-sleep-modification.ts");
const compiler = await jiti.import("../src/lib/m04-proposal-compiler.ts");
const claims = await jiti.import("../src/lib/recorded-test-claims.ts");
const safety = await jiti.import("../src/lib/diagnosis-safety.ts");
const indications = await jiti.import("../src/lib/tcm-formula-indications.ts");
const surface = await jiti.import("../src/lib/delivered-surface.ts");

const check = async (id, title, run) => {
  if (process.env.R1073_CHECK && process.env.R1073_CHECK !== id) return;
  try { await run(); console.log(`✓ ${id} ${title}`); } catch (error) { process.exitCode = 1; console.error(`✗ ${id} ${title}\n${error.stack}`); }
};
const caseState = (chiefComplaint, history, age = 30, sex = "女", extra = {}) => ({
  chiefComplaint, patient: { sex, age },
  symptoms: { 现病史: history, 既往史: "既往体健", 过敏史: "否认药物过敏史", ...extra },
  conversation: [],
});
const prior = (disease, primary, secondaries = []) => ({ stage: "diagnose", overview: { tcmDiseaseName: disease, primarySyndrome: primary, secondarySyndromes: secondaries } });

// ───── A 顺带的睡眠差 ─────
const coldCase = caseState("恶寒、发热伴鼻塞、流涕2天", "2天前淋雨后恶寒发热，恶寒重、发热轻，伴鼻塞、流清涕，稍有咳嗽，无汗。发病以来精神、饮食尚可，睡眠欠佳，二便如常。");
const coldPrior = prior("感冒", "风寒束表证");
await check("A1", "一个判据：「睡眠欠佳」「夜卧不安」这类写法也算睡眠；证名病名不涉心神时拦，涉心神或病历心神表现突出时不拦", () => {
  const recordText = safety.clinicalGroundingText(coldCase);
  assert.equal(sleep.incidentalSleepModificationBlocked({ trigger: "睡眠欠佳", herbName: "远志", reason: "安神" }, coldPrior, { recordText, chiefComplaint: coldCase.chiefComplaint }), true);
  assert.equal(sleep.incidentalSleepModificationBlocked({ trigger: "夜卧不安", herbName: "酸枣仁", reason: "胃不和则卧不安，养心安神" }, prior("积滞", "乳食内积证"), { recordText: "伴夜卧不安" }), true);
  // 反证：证名涉心神（心脾两虚证），或主诉就是失眠
  assert.equal(sleep.incidentalSleepModificationBlocked({ trigger: "睡眠欠佳", herbName: "远志", reason: "安神" }, prior("心悸", "心脾两虚证"), { recordText }), false);
  assert.equal(sleep.incidentalSleepModificationBlocked({ trigger: "睡眠欠佳", herbName: "远志", reason: "安神" }, coldPrior, { recordText: "主诉：失眠1月", chiefComplaint: "失眠1月" }), false);
  // 教材本证列明的那条（textbookListed）只按窄判据：只说睡不好就拦，「睡眠欠佳」须算在睡不好里
  assert.equal(sleep.incidentalSleepModificationBlocked({ trigger: "睡眠欠佳", herbName: "远志", reason: "安神" }, coldPrior, { textbookListed: true, recordText }), true);
  // 反证：不是安神药、理由也不是安神（咳嗽加紫菀）
  assert.equal(sleep.incidentalSleepModificationBlocked({ trigger: "稍有咳嗽", herbName: "紫菀", reason: "润肺下气止咳" }, coldPrior, { recordText }), false);
});
await check("A2", "补写/专写路径（topUpModificationRow）与编译期同判：感冒「睡眠欠佳：加远志」被拒（incidental_sleep），咳嗽加紫菀照常", () => {
  const rejected = [];
  const base = { prior: coldPrior, caseState: coldCase, candidateHerbNames: ["荆芥", "防风", "羌活"], existingTriggers: [], onReject: (code) => rejected.push(code) };
  assert.equal(compiler.topUpModificationRow({ trigger: "睡眠欠佳", herbName: "远志", dose: "6g", reason: "宁心安神" }, base), undefined);
  assert.deepEqual(rejected, ["incidental_sleep"]);
  const authored = [];
  assert.equal(compiler.topUpModificationRow({ trigger: "睡眠欠佳", herbName: "远志", dose: "6g", reason: "宁心安神" }, { ...base, authored: true, onReject: (code) => authored.push(code) }), undefined);
  assert.deepEqual(authored, ["incidental_sleep"], "定稿后专写的行同样拦");
  // 条件里睡眠之外还夹了别的（「睡眠欠佳、易疲乏」）：窄判据只认纯睡眠条件放过，编译期的宽判据按药与理由拦——补写路径此前只有窄判据
  const tiredCase = caseState("恶寒、发热伴鼻塞、流涕2天", "2天前淋雨后恶寒发热，恶寒重、发热轻，伴鼻塞、流清涕，无汗。近日睡眠欠佳、易疲乏，二便如常。");
  const mixed = [];
  assert.equal(compiler.topUpModificationRow({ trigger: "睡眠欠佳、易疲乏", herbName: "酸枣仁", dose: "10g", reason: "养心安神" }, { ...base, caseState: tiredCase, onReject: (code) => mixed.push(code) }), undefined);
  assert.deepEqual(mixed, ["incidental_sleep"]);
  const kept = compiler.topUpModificationRow({ trigger: "稍有咳嗽", herbName: "紫菀", dose: "10g", reason: "润肺下气止咳" }, { ...base, onReject: undefined });
  assert.ok(kept, "咳嗽加紫菀不受影响");
});

// ───── B 病名跟着依据句的确定程度 ─────
const anorexia = caseState("不爱吃饭1月", "患儿近1月食欲减退，见食不贪，每餐进食量少，形体偏瘦，面色萎黄。", 4, "男");
await check("B1", "依据句说病程未达门槛、要点表无病程门槛可判：小儿厌食症写待查；说「需完善确诊分型」：2型糖尿病写待查", () => {
  const anorexiaBasis = "患儿食欲减退1月，见食不贪，符合小儿厌食症表现；但病程1月未达2月门槛，尚缺微量元素等检查，需排除营养性缺铁性贫血。";
  assert.equal(claims.settleWesternDiagnosisBasis("小儿厌食症", anorexiaBasis, safety.clinicalGroundingText(anorexia)).name, "小儿厌食症待查");
  const dm = caseState("口干多饮多尿2月", "近2月口干多饮、多尿、多食，体重下降4kg，社区查空腹血糖9.8mmol/L。", 52);
  const dmBasis = "中年女性多饮多尿、多食伴体重下降4kg，空腹血糖9.8mmol/L，符合糖尿病典型表现；但血糖报告未核实、无糖化血红蛋白等复核，需完善确诊分型。";
  assert.equal(claims.settleWesternDiagnosisBasis("2型糖尿病", dmBasis, safety.clinicalGroundingText(dm)).name, "2型糖尿病待查");
  assert.equal(claims.settleWesternDiagnosisBasis("小儿厌食症", "患儿食欲减退1月，见食不贪，小儿厌食症诊断尚不确立，需随访。", safety.clinicalGroundingText(anorexia)).name, "小儿厌食症待查");
});
await check("B2", "反证：依据句说可临床诊断、或只说需排除别的病，不加待查；既往已确诊的病沿用", () => {
  const uri = caseState("恶寒发热鼻塞2天", "2天前受凉后恶寒发热，鼻塞流涕，咽痒。");
  const uriBasis = "受凉后急性起病，鼻塞流涕伴低热，符合急性上呼吸道感染的临床诊断；需与流行性感冒鉴别。";
  assert.equal(claims.settleWesternDiagnosisBasis("急性上呼吸道感染", uriBasis, safety.clinicalGroundingText(uri)).name, "急性上呼吸道感染");
  const known = caseState("口干多饮复诊", "糖尿病病史5年，规律服二甲双胍，近1月口干加重。", 60, "男", { 既往史: "2型糖尿病5年，规律口服二甲双胍" });
  const knownBasis = "既往已确诊2型糖尿病5年，规律服药，近1月口干加重，符合2型糖尿病血糖控制不佳；需完善糖化血红蛋白评估控制情况。";
  assert.equal(claims.settleWesternDiagnosisBasis("2型糖尿病", knownBasis, safety.clinicalGroundingText(known)).name, "2型糖尿病");
});

// ───── C 合称改名按新证名重选锁定方 ─────
const deficiencyRecord = "患者年龄：68岁\n患者性别：女\n神疲乏力、气短、心悸1年余\n1年余前渐起神疲乏力，伴肢体倦怠、气短懒言、心悸健忘、头晕目眩、面色萎黄、爪甲色淡、毛发枯槁、畏寒肢冷、动则气喘。\n舌淡胖，边有齿痕，苔薄白\n脉沉细弱";
function deficiencyReasoning(formula = "七福饮") {
  return {
    stage: "diagnose",
    overview: {
      tcmDiseaseName: "虚劳", primarySyndrome: "心肺气虚证", secondarySyndromes: ["血虚证"],
      primarySyndromeBasis: ["神疲乏力，伴肢体倦怠、气短懒言、心悸健忘", "面色萎黄、爪甲色淡、毛发枯槁", "舌淡胖，边有齿痕，苔薄白", "脉沉细弱"],
      tcmDiagnosticRationale: "神疲乏力、气短懒言、心悸健忘为心肺气虚；面色萎黄、爪甲色淡、毛发枯槁、头晕目眩为血虚不能上荣；舌淡胖、脉沉细弱为气血不足。",
      recommendedFormulaNames: [formula], recommendedFormulaDirection: `${formula}加减`,
    },
    therapy: { overallMethod: "益气养心，健脾养血" },
    pathogenesis: {
      locationDifferentiation: { items: ["心", "肺", "脾"], details: [] },
      natureDifferentiation: { items: ["气虚", "血虚"], rootDeficiency: ["气虚", "血虚"], branchExcess: [] },
      chain: [{ patientFact: "神疲乏力、气短懒言", pathogenesis: "心肺气虚", therapyDirection: "益气养心", syndromeEvidence: "神疲乏力、气短懒言" }],
    },
  };
}
const toComposite = (copy) => { copy.overview.primarySyndrome = "气血两虚证"; copy.overview.secondarySyndromes = []; };
await check("C1", "七福饮锁定在气血两虚证下不再对证：按新证名重选可锁定、覆盖本病的第一首（八珍汤），并改写选方方向", () => {
  const reasoning = deficiencyReasoning();
  assert.equal(indications.namedFormulaPositiveSufficiencyIssue(reasoning, ["七福饮"], deficiencyRecord), undefined, "原证名下七福饮对证（前提）");
  const relock = indications.formulaRelockAfterSyndromeRewrite(reasoning, toComposite, deficiencyRecord);
  assert.ok(relock && relock.formulaNames.length === 1, JSON.stringify(relock));
  assert.equal(relock.formulaNames[0], "八珍汤");
  const copy = structuredClone(reasoning); toComposite(copy); indications.applyFormulaRelock(copy, relock);
  assert.deepEqual(copy.overview.recommendedFormulaNames, ["八珍汤"]);
  assert.equal(copy.overview.recommendedFormulaDirection, "八珍汤加减");
  assert.equal(indications.namedFormulaPositiveSufficiencyIssue(copy, ["八珍汤"], deficiencyRecord), undefined, "重选的方在新证名下对证");
});
await check("C2", "反证：改写后锁定仍成立不重选；没有锁定方不重选", () => {
  const reasoning = deficiencyReasoning();
  assert.equal(indications.formulaRelockAfterSyndromeRewrite(reasoning, () => {}, deficiencyRecord), undefined);
  const unlocked = deficiencyReasoning(); unlocked.overview.recommendedFormulaNames = [];
  assert.equal(indications.formulaRelockAfterSyndromeRewrite(unlocked, toComposite, deficiencyRecord), undefined);
});

await check("C3", "两处合称改名（辨证阶段证素闭合、交付面合称）都走重选，不再直接按「锁定失效」放弃", async () => {
  const fs = await import("node:fs");
  for (const file of ["src/lib/m03-syndrome-element-closure.server.ts", "src/lib/delivered-surface.ts"]) {
    const source = fs.readFileSync(`${root}/${file}`, "utf8");
    assert.match(source, /formulaRelockAfterSyndromeRewrite\(/u, file);
    assert.match(source, /applyFormulaRelock\(/u, file);
  }
  const surface = fs.readFileSync(`${root}/src/lib/delivered-surface.ts`, "utf8");
  assert.doesNotMatch(surface, /syndromeRewriteBreaksFormulaLock\(/u, "交付面合称不再用旧的放弃判据");
});

await check("C4", "交付面合称：心肺气虚证兼血虚证、病性列血虚且病历两项以上血虚表现 → 气血两虚证，锁定方七福饮改为八珍汤；无血虚表现的不改", () => {
  const reasoning = deficiencyReasoning();
  reasoning.pathogenesis.natureDifferentiation.basis = "神疲乏力、气短懒言；面色萎黄、爪甲色淡、毛发枯槁";
  const renamed = surface.compositeSyndromeRename(reasoning, deficiencyRecord);
  assert.deepEqual(renamed, { from: "心肺气虚证兼血虚证", to: "气血两虚证" });
  assert.equal(reasoning.overview.primarySyndrome, "气血两虚证");
  assert.deepEqual(reasoning.overview.secondarySyndromes, []);
  assert.deepEqual(reasoning.overview.recommendedFormulaNames, ["八珍汤"]);
  // 反证：病历没有血虚表现（只有气虚）时不合称
  const qiOnly = deficiencyReasoning(); qiOnly.overview.secondarySyndromes = []; qiOnly.pathogenesis.natureDifferentiation.items = ["气虚"];
  assert.equal(surface.compositeSyndromeRename(qiOnly, "患者年龄：60岁\n神疲乏力、气短懒言、动则气喘半年\n舌淡，脉弱"), undefined);
});
