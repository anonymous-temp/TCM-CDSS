// 第三十八轮（2026-11-08）：第三十七轮留下的问题按类收口。
// 每条断言都有反证（~/runlogs/r1018/work/r1050/cp/）。
import assert from "node:assert/strict";
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

const history = await jiti.import("../src/lib/history-stated-textbook-disease.ts");
const textbook = await jiti.import("../src/lib/tcm-textbook-syndromes.ts");
const summary = await jiti.import("../src/lib/diagnosis-visible-summary.ts");
const claim = await jiti.import("../src/lib/m04-formula-analysis-claim-check.server.ts");
const fit = await jiti.import("../src/lib/m04-modification-fit.server.ts");
const secondary = await jiti.import("../src/lib/m03-secondary-syndrome-consistency.server.ts");

// ───── 1 既往确诊病与本次主诉（甲方 11.05 病历2：慢性扁桃体炎史 + 咽痛发热 → 乳蛾）─────
const adultNames = textbook.textbookDiseaseNamesForCase({ sex: "女", ageYears: 32 });
const stated = (chiefComplaint, pastHistory) => history.historyStatedTextbookDiseases({ chiefComplaint, pastHistory, allowedDiseases: adultNames });

await check("1.1 既往史写明的西医病按教材对到中医病名、本次主诉的主症是它的主症：慢性扁桃体炎史 + 咽痛发热 → 乳蛾（配慢性扁桃体炎这个全名）", () => {
  const out = stated("咽痛、发热2天", "慢性扁桃体炎史2年");
  assert.equal(out.length, 1);
  assert.equal(out[0].disease, "乳蛾");
  assert.equal(out[0].western, "慢性扁桃体炎");
  assert.equal(out[0].chiefSymptom, "咽痛");
  assert.match(out[0].quote, /慢性扁桃体炎史2年/u);
});

await check("1.2 否认、他人、待查的既往病不算；主诉写在后面的次要症状不算（水肿伴乏力 + 糖尿病 ≠ 消渴）；冠心病 + 胸闷心悸不对到心衰（主症胸闷）", () => {
  assert.deepEqual(stated("咽痛、发热2天", "否认慢性扁桃体炎史"), []);
  assert.deepEqual(stated("咽痛、发热2天", "母亲有慢性扁桃体炎"), []);
  assert.deepEqual(stated("咽痛、发热2天", "是否有慢性扁桃体炎尚未询问"), []);
  assert.deepEqual(stated("双脚水肿1个月，乏力1周", "糖尿病10年"), []);
  assert.deepEqual(stated("胸闷心悸气短3月", "冠心病病史5年"), []);
  // 主诉主段点名了这个病时不用这条（选病自己会选到）
  assert.deepEqual(stated("乳蛾反复发作3年，再发2天", "慢性扁桃体炎史3年"), []);
  // 对照：高血压病史 + 头晕 → 眩晕
  assert.equal(stated("头晕目眩半年", "高血压病史10年")[0]?.disease, "眩晕");
});

await check("1.3 选病结果按既往确诊病排序：唯一一个时放到最前；选病落空时不补；几个都对上时不动", () => {
  const one = stated("咽痛、发热2天", "慢性扁桃体炎史2年");
  assert.deepEqual(history.withHistoryStatedDiseaseFirst(["喉痹", "乳蛾", "感冒"], one), ["乳蛾", "喉痹", "感冒"]);
  assert.deepEqual(history.withHistoryStatedDiseaseFirst(["喉痹"], one), ["乳蛾", "喉痹"]);
  assert.deepEqual(history.withHistoryStatedDiseaseFirst([], one), []);
  const two = [one[0], { ...one[0], disease: "喉痹" }];
  assert.deepEqual(history.withHistoryStatedDiseaseFirst(["喉痹", "乳蛾"], two), ["喉痹", "乳蛾"]);
});

await check("1.4 既往确诊病排第一时，不被「另一个病的证型行更贴字面」顶下去（病历2 没写喉核查体，喉痹的「咽部红肿疼痛」比乳蛾的「喉核红肿」更贴）", () => {
  const input = {
    chiefComplaint: "咽痛、发热2天",
    presentHistory: "患者2天前进食辛辣食物后出现咽痛、发热，咽部红肿疼痛，吞咽时加重，最高体温38.1℃，伴微恶风、咳嗽、咳黄黏痰、口干、口渴，大便偏干。",
    tongue: "舌红，苔薄黄",
    pulse: "脉浮数",
    sex: "女",
    ageYears: 32,
  };
  const pinned = textbook.textbookCandidatesForCase({ ...input, preferredDiseases: ["乳蛾", "喉痹"], pinnedDisease: "乳蛾" });
  assert.equal(pinned[0]?.disease, "乳蛾");
  // 不固定时照旧按行贴合排序（这一条说明固定有作用；行贴合本身不改）
  const free = textbook.textbookCandidatesForCase({ ...input, preferredDiseases: ["乳蛾", "喉痹"] });
  assert.equal(free[0]?.disease, "喉痹");
});

await check("1.5 辨证半写成既往确诊病的教材邻近病（互为鉴别：乳蛾 ↔ 喉痹）才按既往病重写；写成感冒不重写；重写说明交代既往史与本次主症", () => {
  const one = stated("咽痛、发热2天", "慢性扁桃体炎史2年")[0];
  assert.equal(history.writtenDiseaseIsTextbookNeighbour("喉痹", one, textbook.textbookDiseaseDifferentialNames), true);
  assert.equal(history.writtenDiseaseIsTextbookNeighbour("感冒", one, textbook.textbookDiseaseDifferentialNames), false);
  assert.equal(history.writtenDiseaseIsTextbookNeighbour("乳蛾", one, textbook.textbookDiseaseDifferentialNames), false);
  const instruction = history.historyStatedDiseaseRedrawInstruction("喉痹", one);
  assert.match(instruction, /慢性扁桃体炎史2年/u);
  assert.match(instruction, /病名写「乳蛾」/u);
  assert.match(history.historyStatedDiseaseNotice([one]), /【既往确诊病与本次主诉】[\s\S]*乳蛾/u);
  assert.equal(history.historyStatedDiseaseNotice([]), "");
});

await check("1.6 病例形状：既往史从规范槽位、HIS 字段、病历式中文键都读得到；开关关掉时不用", () => {
  const base = { chiefComplaint: "咽痛、发热2天", patient: { sex: "女", age: 32 } };
  assert.equal(history.historyStatedDiseasesForCase({ ...base, pastHistory: "慢性扁桃体炎史2年" })[0]?.disease, "乳蛾");
  assert.equal(history.historyStatedDiseasesForCase({ ...base, symptoms: { 既往史: "慢性扁桃体炎史2年" } })[0]?.disease, "乳蛾");
  assert.equal(history.historyStatedDiseasesForCase({ ...base, hisRecord: { fields: { jiwangshi: "慢性扁桃体炎史2年" } } })[0]?.disease, "乳蛾");
  process.env.CDSS_HISTORY_STATED_DISEASE = "false";
  try {
    assert.deepEqual(history.historyStatedDiseasesForCase({ ...base, pastHistory: "慢性扁桃体炎史2年" }), []);
  } finally {
    delete process.env.CDSS_HISTORY_STATED_DISEASE;
  }
});

// ───── 2 随证加减看所加药的药性（甲方 11.05 病历8：胃热鼻衄「纳差 → 焦山楂」，焦山楂微温）─────
await check("2.1 《中药学》药性按饮片身份取原药：焦山楂 → 酸、甘，微温；炒麦芽 → 甘，平；教材没有的为空串", () => {
  assert.equal(claim.herbPropertyReferenceText("焦山楂"), "酸、甘，微温");
  assert.equal(claim.herbPropertyReferenceText("炒麦芽"), "甘，平");
  assert.equal(claim.herbPropertyReferenceText("黄连"), "苦，寒");
  assert.equal(claim.herbPropertyReferenceText("不存在的药"), "");
});

await check("2.2 加减核对看到的每一行带药性（提名与复核用同一份）", () => {
  const row = { action: "加", trigger: "本例已见纳差", herbName: "焦山楂", evidence: { evidenceLevel: "model_inference" } };
  const payload = fit.modificationFitRowPayload(row, 0, "血证");
  assert.equal(payload.kind, "model");
  assert.equal(payload.property, "酸、甘，微温");
  assert.equal(payload.herb, "焦山楂");
});

// ───── 3 「无 + 病名/病机 + 之 + 症状」没记录过的改成未诉（甲方 11.05 病历12）─────
const record12 = "主诉：食欲减退、拒食1月。现病史：患者1月前出现食欲减退、拒食，表现为见食不贪，每餐进食量少，伴形体偏瘦、面色萎黄、神疲乏力、易出汗，大便溏薄、夹不消化食物。舌淡红，苔薄白，脉无力";
await check("3.1 「亦无积滞之脘腹胀满、嗳腐吞酸」病历没写 → 「亦未诉脘腹胀满、嗳腐吞酸等积滞表现」", () => {
  assert.equal(summary.unrecordedNegativesAsNotReported("脾失健运，亦无积滞之脘腹胀满、嗳腐吞酸，故属脾失健运证。", record12),
    "脾失健运，亦未诉脘腹胀满、嗳腐吞酸等积滞表现，故属脾失健运证。");
  assert.equal(summary.unrecordedNegativesAsNotReported("本例无积滞之脘腹胀满。", record12), "本例未诉脘腹胀满等积滞表现。");
});

await check("3.2 不改：症状病历写到过的、「之」后是表现/象的、推断句、写别的病的", () => {
  assert.equal(summary.unrecordedNegativesAsNotReported("无脾虚之神疲乏力、大便溏薄。", record12), "无脾虚之神疲乏力、大便溏薄。");
  assert.equal(summary.unrecordedNegativesAsNotReported("无积滞之象。", record12), "无积滞之象。");
  // 「之」后是「表现」的交给原有那条（改成「未诉积滞之表现」），这条不改写成「未诉表现等积滞表现」
  assert.equal(summary.unrecordedNegativesAsNotReported("无积滞之表现。", record12), "未诉积滞之表现。");
  assert.equal(summary.unrecordedNegativesAsNotReported("示无积滞之腹胀。", record12), "示无积滞之腹胀。");
  assert.equal(summary.unrecordedNegativesAsNotReported("与积滞相区分：积滞无脾虚之神疲乏力。", record12), "与积滞相区分：积滞无脾虚之神疲乏力。");
  // 「之」后是病名、「之」前不是病名或病机：写的是那个病（第十九轮 H 集「无矢气之肠结」）
  assert.equal(summary.unrecordedNegativesAsNotReported("无矢气之肠结", record12), "无矢气之肠结");
  assert.equal(summary.unrecordedNegativesAsNotReported("本例无口渴之消渴。", record12), "本例无口渴之消渴。");
});

// ───── 4 舌脉都记录、依据齐全、不确定项没点名时，没有理由的「有界」按已确定交付 ─────
const axisCase = (location, nature, uncertainties = []) => `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify({
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose", overview: { primarySyndrome: "肝胃不和证", primarySyndromeResolution: "resolved", primarySyndromeBasis: ["饭后1小时腹胀嗳气"] }, westernDiagnosis: {},
  pathogenesis: { locationDifferentiation: location, natureDifferentiation: nature, symptomClusters: [], chain: [], uncertainties },
})}\n<!-- DIAGNOSIS_JSON_END -->`;
const axes = (content, record) => {
  const out = summary.sanitizeOptionalPathogenesisClassifications(content, record);
  const parsed = JSON.parse(out.slice(out.indexOf("START -->") + 9, out.indexOf("<!-- DIAGNOSIS_JSON_END"))).pathogenesis;
  return { location: parsed.locationDifferentiation, nature: parsed.natureDifferentiation };
};
const fullRecord = "饭后1小时腹胀嗳气，工作紧张时加重，口苦。舌红，苔薄黄。脉弦。";
const locationBounded = { items: ["胃", "肝"], details: [{ location: "胃", basis: "饭后1小时腹胀嗳气" }, { location: "肝", basis: "工作紧张时加重" }], resolution: "bounded" };
const natureBounded = { items: ["气滞", "热"], basis: "工作紧张时加重；口苦", resolution: "bounded" };

await check("4.1 舌脉都记录、每个病位都有逐字依据、不确定项没说病位：有界 → 已确定；病性按段摘了原文（段数不少于病性个数）同理", () => {
  const out = axes(axisCase(locationBounded, natureBounded), fullRecord);
  assert.equal(out.location.resolution, "resolved");
  assert.equal(out.location.resolutionReason, undefined);
  assert.equal(out.nature.resolution, "resolved");
});

await check("4.2 仍按有界：病历缺脉、不确定项点名了这一轴、病性依据段数少于病性个数", () => {
  const noPulse = axes(axisCase(locationBounded, natureBounded), "饭后1小时腹胀嗳气，工作紧张时加重，口苦。舌红，苔薄黄。");
  assert.equal(noPulse.location.resolution, "bounded");
  assert.equal(noPulse.nature.resolution, "bounded");
  const named = axes(axisCase(locationBounded, natureBounded, [{ item: "肝郁程度", reason: "未记录胁痛", affects: "病位判断" }, { item: "热象轻重", reason: "", affects: "病性" }]), fullRecord);
  assert.equal(named.location.resolution, "bounded");
  assert.match(named.location.resolutionReason, /肝郁程度尚待核实/u);
  assert.equal(named.nature.resolution, "bounded");
  const thinBasis = axes(axisCase(locationBounded, { ...natureBounded, basis: "口苦" }), fullRecord);
  assert.equal(thinBasis.nature.resolution, "bounded");
  const unrecordedPulse = axes(axisCase(locationBounded, natureBounded), "饭后1小时腹胀嗳气，工作紧张时加重，口苦。舌红，苔薄黄。脉象未查。");
  assert.equal(unrecordedPulse.location.resolution, "bounded");
});

await check("4.3 舌脉判据：「脉象：弦」「少苔」算记录；「脉象难配合」不算", () => {
  assert.equal(summary.recordHasTongueAndPulse("舌红少苔，脉象：弦细"), true);
  assert.equal(summary.recordHasTongueAndPulse("舌淡红，苔薄白，脉象难配合"), false);
  assert.equal(summary.recordHasTongueAndPulse("舌淡红，苔薄白"), false);
});

// ───── 5 主证已含的兼证（甲方 11.05 病历4：肾精亏损证兼阴虚火旺证）─────
await check("5.1 精亏一类主证下的阴虚火旺/虚热兼证是重复，撤下；别的主证下的阴虚火旺照旧走辨证要点核对", () => {
  assert.equal(secondary.secondaryStructurallyInvalid("肾精亏损证", "阴虚火旺证"), "entailed_by_primary");
  assert.equal(secondary.secondaryStructurallyInvalid("肾精不足证", "虚热证"), "entailed_by_primary");
  assert.equal(secondary.secondaryStructurallyInvalid("心脾两虚证", "阴虚火旺证"), undefined);
});

// ───── 6 加减条件与病历舌脉相反：补上苔量与脉形两个维度（甲方 11.05 病历8：苔黄燥、脉洪数 对「若阴伤较甚…舌红苔少，脉细数」）─────
await check("6.1 苔量（少苔/无苔 对 苔有颜色或厚腻）与脉形（洪大 对 细微）相反的条件判相反；原有的舌色、苔色、脉率照旧", () => {
  const record8 = "反复鼻出血3天。舌红，苔黄燥。脉洪数";
  assert.equal(textbook.modificationConditionTonguePulseConflict("若阴伤较甚，口渴，舌红苔少，脉细数", record8), true);
  assert.equal(textbook.modificationConditionTonguePulseConflict("苔少", record8), true);
  assert.equal(textbook.modificationConditionTonguePulseConflict("脉细数", record8), true);
  assert.equal(textbook.modificationConditionTonguePulseConflict("若舌苔厚腻，加苍术", "舌红少苔，脉细数"), true);
  assert.equal(textbook.modificationConditionTonguePulseConflict("若舌淡脉迟", "舌红，苔黄，脉数"), true);
});

await check("6.2 不判相反：督脉/赤脉/生脉散不是脉象，「舌苔少津」不是少苔，条件与病历同一端，条件或病历没写这一维", () => {
  const record = "舌淡红，苔薄白，脉浮紧";
  assert.equal(textbook.modificationConditionTonguePulseConflict("督脉空虚而腰膝酸软者，加狗脊、续断", "舌淡红，苔薄白，脉细弱"), false);
  assert.equal(textbook.modificationConditionTonguePulseConflict("若白睛赤脉深红粗大甚者，加紫草", "舌淡红，苔薄白，脉细弱"), false);
  assert.equal(textbook.modificationConditionTonguePulseConflict("亡阴证应急以救阴，方用生脉散、大定风珠等", "舌淡红，苔薄白，脉弦细"), false);
  assert.equal(textbook.modificationConditionTonguePulseConflict("若口渴难耐、舌苔少津，加乌梅", record), false);
  assert.equal(textbook.modificationConditionTonguePulseConflict("若咳嗽痰多", record), false);
  assert.equal(textbook.modificationConditionTonguePulseConflict("若苔黄腻，加黄芩", "舌红，苔黄，脉滑数"), false);
  assert.equal(textbook.modificationConditionTonguePulseConflict("若脉细", "舌红，苔黄"), false);
});
