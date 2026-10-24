// 10/24 第十七轮（第十六轮 qwen 评审遗留项按类修完；「妊娠状态未知」按我们的建议定）。
//
//   1 孕哺备孕缺项：妊娠已明确（阳性、可疑或否认）时不再逐项追问哺乳、备孕；否认妊娠而近一年内分娩的仍问哺乳。已停用的药不算当前用药。
//   2 妊娠状态未记录的 15–49 岁女性：药典孕妇禁用/忌用饮片不进方（与备孕档同一出口），慎用的不逐味标注。
//   3 规则注意事项：药物过敏按药名判覆盖，不再补一句同义的。
//   4 饮片味数：提示词不再给「无更多兼顾就不补足」的退路。
//   5 教材补充行：耳鸣耳聋（《中医食疗学》）、虚脱（《中西医结合外科学》休克的中医辨证论治）。
//   6 脱证落在兼证栏时提为主证（急则治标），原病名教材里没有这一证时病名改虚脱。
//   7 《中医诊断学》辨证要点：共用谓语的并列部位分到每一项，单字症状不丢。
//   8 只表达病位与气机失常的中性证名不推「实则泻之」。
//   9 结直肠随访：便秘与「近期出现/加重」须在同一句。
//  10 病历自述的两方说法冲突在辨病依据里点明。
//  11 未经影像评估的乳房肿块：优先评估（需排除乳腺癌）。
//  12 红旗例「原病名待查」也采信（急危重病名同样）；婴儿/新生儿败血症要点行。
//  13 肛肠局部病名未做肛门检查时，辨病依据写明是初步判断。

import assert from "node:assert/strict";
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

const safety = await jiti.import("../src/lib/diagnosis-safety.ts");
const types = await jiti.import("../src/lib/diagnosis-types.ts");
const contract = await jiti.import("../src/lib/diagnosis-stage-contract.ts");
const prompts = await jiti.import("../src/lib/diagnosis-prompts.ts");
const policy = await jiti.import("../src/lib/conception-herb-policy.ts");
const surface = await jiti.import("../src/lib/delivered-surface.ts");
const polarity = await jiti.import("../src/lib/clinical-polarity.ts");
const textbook = await jiti.import("../src/lib/tcm-textbook-syndromes.ts");
const critical = await jiti.import("../src/lib/m03-critical-syndrome.ts");
const visible = await jiti.import("../src/lib/diagnosis-visible-summary.ts");
const western = await jiti.import("../src/lib/western-name-evidence-check.server.ts");
const fs = await import("node:fs");

// 页面形状的病例（与 test-r1028-main 同一写法）。
function pageCase({ sex = "女", age = 35, chief, present = "", detail = "", past = "", exams = "", tongue = "舌淡红，苔薄白", pulse = "脉细", medication = "未服药", allergy = "否认药物过敏", herbCount } = {}) {
  const raw = [`患者信息：性别${sex}，年龄${age}岁`, `主诉：${chief}`, present && `现病史：${present}`, past && `既往史：${past}`, `过敏史：${allergy}`, `用药史：${medication}`,
    "生命体征/体格检查：T 36.5℃，P 78次/分，R 18次/分，BP 112/72mmHg", `舌象：${tongue}`, `脉象：${pulse}`, detail && `其他四诊/问诊补充：${detail}`, exams && `辅助检查：${exams}`].filter(Boolean).join("\n");
  return types.normalizeCaseStateInput({
    id: "r1029-test", phase: "collect", patient: { sex, age }, chiefComplaint: chief,
    symptoms: { ...(present ? { presentHistory: present } : {}), ...(detail ? { tcmDetail: detail } : {}), ...(exams ? { exams } : {}) },
    questionRounds: 0, maxQuestionRounds: 1, conversation: [{ role: "user", content: raw }],
    hisRecord: { schemaVersion: "tcm-cdss-his-v1", source: "tcm-cdss-his", caseId: "r1029-test", updatedAt: "2026-10-24T00:00:00.000Z", tongueImageUploaded: false,
      fields: { sex, age: String(age), zhushu: chief, xianbingshi: present, jiwangshi: past, guomin: allergy, yongyaoshi: medication, vitalsT: "36.5", vitalsP: "78", vitalsR: "18", vitalsBP: "112/72", tcmTongue: tongue, tcmPulse: pulse, tcmDetail: detail, fuzhuJiancha: exams, tcmLineagePreference: "unrestricted" }, rawText: raw },
    tongue, pulse, pastHistory: past || undefined, medicationHistory: medication, allergyHistory: allergy, tcmLineagePreference: "unrestricted",
    ...(herbCount ? { herbCountPreference: herbCount } : {}),
    vitals: { temperature: "36.5", pulse: "78", respiration: "18", bloodPressure: "112/72" },
  });
}
const codes = (state) => safety.evaluateSafetyGate(state).missingItemCodes || [];

// ─── 1 孕哺备孕缺项 ─────────────────────────────────────────────────────────────
await check("1.1 妊娠已明确时不再逐项追问哺乳、备孕（C018 明确否认、C062 尿妊娠试验阳性）", () => {
  const denied = codes(pageCase({ chief: "烧心反酸4个月", past: "孕期情况：明确否认妊娠，近两周月经正常" }));
  assert.ok(!denied.includes("lactation_unknown") && !denied.includes("conception_unknown") && !denied.includes("pregnancy_unknown"), JSON.stringify(denied));
  const positive = codes(pageCase({ chief: "停经6周，右下腹痛1天", present: "尿妊娠试验阳性" }));
  assert.ok(!positive.includes("lactation_unknown") && !positive.includes("conception_unknown"), JSON.stringify(positive));
  const unknown = codes(pageCase({ chief: "全身肌肉酸痛伴疲劳1年" }));
  for (const code of ["pregnancy_unknown", "lactation_unknown", "conception_unknown"]) assert.ok(unknown.includes(code), `${code} 应在：${JSON.stringify(unknown)}`);
  const postpartum = codes(pageCase({ chief: "腰痛2周", past: "3个月前顺产，否认再次妊娠" }));
  assert.ok(postpartum.includes("lactation_unknown") && !postpartum.includes("conception_unknown"), JSON.stringify(postpartum));
});

await check("1.2 写到的药都已停用、没有在用的：不算「已提及当前用药但缺少药名/剂量/频次」（C088）", () => {
  const stopped = codes(pageCase({ sex: "男", age: 69, chief: "双手颤抖2年", medication: "普萘洛尔曾短期服用，目前停用" }));
  assert.ok(!stopped.includes("medication_details") && !stopped.includes("medication_unknown"), JSON.stringify(stopped));
  const mixed = codes(pageCase({ sex: "男", age: 69, chief: "双手颤抖2年", medication: "普萘洛尔已停用，现服降压药" }));
  assert.ok(mixed.includes("medication_details"), JSON.stringify(mixed));
});

// ─── 2 妊娠状态未记录的育龄女性 ─────────────────────────────────────────────────
await check("2.1 药典孕妇禁用档：15–49 岁女性、妊娠状态未记录才属于（否认、绝经、50 岁、男性、未记年龄都不属于）", () => {
  const grounding = (options) => safety.clinicalGroundingText(pageCase(options));
  assert.match(grounding({ chief: "腰痛2周" }), /性别[:：]?女/);
  // 甲方接口形状：性别只在结构化字段里，接地语料补一行「患者性别：女」。
  const apiShape = types.normalizeCaseStateInput({ id: "r1029-api", phase: "collect", patient: { sex: "女", age: 30 }, chiefComplaint: "腰痛2周", symptoms: { 现病史: "腰部酸痛" }, questionRounds: 0, maxQuestionRounds: 1, conversation: [] });
  assert.match(safety.clinicalGroundingText(apiShape), /患者性别：女/);
  assert.equal(policy.chpPregnancyHerbTier(safety.clinicalGroundingText(apiShape)), "pregnancy_unknown");
  assert.equal(policy.chpPregnancyHerbTier(grounding({ chief: "腰痛2周" })), "pregnancy_unknown");
  assert.equal(policy.chpPregnancyHerbTier(grounding({ chief: "腰痛2周", detail: "否认妊娠" })), undefined);
  assert.equal(policy.chpPregnancyHerbTier(grounding({ chief: "腰痛2周", age: 52 })), undefined);
  assert.equal(policy.chpPregnancyHerbTier(grounding({ chief: "腰痛2周", age: 45, past: "已绝经2年" })), undefined);
  assert.equal(policy.chpPregnancyHerbTier(grounding({ chief: "腰痛2周", sex: "男" })), undefined);
  assert.equal(policy.chpPregnancyHerbTier(grounding({ chief: "腰痛2周", age: 14 })), undefined);
  assert.equal(policy.chpPregnancyHerbTier(grounding({ chief: "月经量少半年", detail: "未避孕1年未孕" })), "conception");
  assert.equal(policy.pregnancyUnknownReproductiveAgeFemale("患者性别：女\n主诉：腰痛"), false, "没有数值年龄不属于这一档");
});

await check("2.2 合同：这一档里药典孕妇禁用的饮片驱动修复（与备孕档同一出口），慎用的不拦", () => {
  const grounding = safety.clinicalGroundingText(pageCase({ chief: "小腹包块3月" }));
  assert.match(String(contract.m04GenerationSpecialPopulationIssue([{ name: "当归" }, { name: "三棱" }], grounding)), /special_population_high_risk_pregnancy/);
  assert.equal(contract.m04GenerationSpecialPopulationIssue([{ name: "桃仁" }, { name: "红花" }], grounding), undefined);
  const denied = safety.clinicalGroundingText(pageCase({ chief: "小腹包块3月", detail: "否认妊娠" }));
  assert.equal(contract.m04GenerationSpecialPopulationIssue([{ name: "三棱" }], denied), undefined);
  assert.match(String(policy.conceptionHerbNote("三棱", "pregnancy_unknown")), /未记录妊娠状态/);
  assert.equal(policy.conceptionHerbNote("桃仁", "pregnancy_unknown"), undefined);
  assert.match(String(policy.conceptionHerbNote("桃仁", "conception")), /备孕/);
});

await check("2.3 锁定方或教材代表方的组成里有药典孕妇禁用的药时列给开方阶段（探针：癥瘕·气滞血瘀的香棱丸，三棱、莪术为君）", async () => {
  const server = await jiti.import("../src/lib/conception-herb-policy.server.ts");
  const prior = { stage: "diagnose", overview: { tcmDiseaseName: "癥瘕", primarySyndrome: "气滞血瘀证", recommendedFormulaNames: [] } };
  const barred = server.formulaBaseHerbsBarredInPregnancy(prior).map((item) => item.herb);
  assert.ok(barred.includes("三棱") && barred.includes("莪术"), JSON.stringify(barred));
  const plain = { stage: "diagnose", overview: { tcmDiseaseName: "胃痛", primarySyndrome: "肝气犯胃证", recommendedFormulaNames: ["柴胡疏肝散"] } };
  assert.deepEqual(server.formulaBaseHerbsBarredInPregnancy(plain), []);
});

// ─── 3 药物过敏覆盖 ─────────────────────────────────────────────────────────────
await check("3.1 药物过敏的规则句按药名判覆盖（C070 模型写「阿司匹林诱发喘息史…请勿再用」，规则又补一句）", () => {
  assert.deepEqual(polarity.drugNamesInAllergyPhrases(["阿司匹林诱发喘息", "阿莫西林后全身荨麻疹"]), ["阿司匹林", "阿莫西林"]);
  const saved = JSON.parse(fs.readFileSync("scripts/fixtures/r1028-c051-prescribe.json", "utf8"));
  const modelLine = "您有阿司匹林诱发喘息史，请勿再用该药及同类药物，就诊或购药时主动告知医生和药师。";
  const reasoning = types.normalizeReasoningV2({ ...saved, nonPharma: { ...saved.nonPharma, precautions: [modelLine] } });
  const projected = surface.projectDeliveredReasoning(reasoning, { requiredPrecautions: [{ kind: "drug_allergy", phrases: ["阿司匹林诱发喘息"] }] });
  assert.ok(projected.nonPharma.precautions.includes(modelLine), JSON.stringify(projected.nonPharma.precautions));
  const lines = projected.nonPharma.precautions.filter((line) => line.includes("阿司匹林"));
  assert.equal(lines.length, 1, JSON.stringify(projected.nonPharma.precautions));
  // 模型没写到时规则句照补（守住另一头）。
  const missing = surface.projectDeliveredReasoning(types.normalizeReasoningV2({ ...saved, nonPharma: { ...saved.nonPharma, precautions: ["饭后温服。"] } }), { requiredPrecautions: [{ kind: "drug_allergy", phrases: ["阿司匹林诱发喘息"] }] });
  assert.ok(missing.nonPharma.precautions.some((line) => line.includes("阿司匹林")), JSON.stringify(missing.nonPharma.precautions));
});

// ─── 4 饮片味数 ────────────────────────────────────────────────────────────────
await check("4.1 饮片味数提示词不再给「本例无更多需兼顾的表现，未加至…」的退路，改为按治法同向补足", () => {
  const state = pageCase({ chief: "心悸失眠3月", herbCount: "at_least_15" });
  const prompt = prompts.buildPrescribePrompt({ ...state, herbCountPreference: "at_least_15" });
  const section = prompt.slice(prompt.indexOf("医生选择了饮片味数"), prompt.indexOf("医生选择了饮片味数") + 600);
  assert.ok(section.length > 0, "提示词里没有饮片味数段");
  assert.ok(!/未加至/.test(prompt), "仍有「未加至」退路");
  assert.match(section, /同一方向的常用臣佐药/);
});

await check("4.2 锁定方基础组成少于下限时（归脾汤 10 味、选 15 味以上）：要求补到区间内，不给退路", () => {
  const text = prompts.herbCountPreferenceInstruction({ herbCountPreference: "at_least_15" }, [{ formulaName: "归脾汤", source: "《济生方》", ingredients: ["白术", "当归", "茯苓", "黄芪", "远志", "龙眼肉", "酸枣仁", "人参", "木香", "甘草"], minimumPreservedIngredientCount: 7 }]);
  assert.match(text, /需要在基础组成上加 5 味以上，使总数落在区间内（以 17 味为目标/);
  assert.match(text, /同一方向的常用臣佐药/);
  assert.ok(!/未加至|不凑数/.test(text), text);
});

// ─── 5 教材补充行 ──────────────────────────────────────────────────────────────
await check("5.1 耳鸣耳聋、虚脱两病进了教材表：证型、治法、代表方取自本地教材原文", () => {
  const ear = textbook.textbookRowForSyndrome("耳鸣耳聋", "气滞血瘀证");
  assert.equal(ear?.formulas?.[0], "通窍活血汤");
  assert.equal(textbook.textbookRowForSyndrome("耳鸣耳聋", "肝火上扰证")?.formulas?.[0], "龙胆泻肝汤");
  const shock = textbook.textbookRowForSyndrome("虚脱", "气脱证");
  assert.equal(shock?.formulas?.[0], "独参汤");
  assert.match(String(shock?.manifestations), /脉微欲绝/);
  assert.equal(textbook.textbookRowForSyndrome("虚脱", "亡阳证")?.formulas?.[0], "参附汤");
  // 证候原文逐字在所注行号上（本机有教材合集时核；fresh clone 没有这份 gitignore 的语料，跳过这一项）。
  const corpus = "中医补充数据/灵丹GitHub/TCM Educational Materials.txt";
  if (fs.existsSync(corpus)) {
    const source = fs.readFileSync(corpus, "utf8").split("\n");
    const supplement = JSON.parse(fs.readFileSync("src/data/tcm-textbook-syndrome-supplement.source.json", "utf8"));
    for (const row of supplement.rows.filter((item) => /^supplement\|(?:耳鸣耳聋|虚脱)\|/.test(item.id))) {
      assert.ok(source[row.line - 1].includes(row.manifestations.replace(/。$/, "")), `${row.id} 第 ${row.line} 行不是原文`);
    }
  }
  const names = JSON.parse(fs.readFileSync("src/data/tcm-textbook-disease-names.json", "utf8"));
  assert.ok(JSON.stringify(names).includes("耳鸣耳聋") && JSON.stringify(names).includes("虚脱"));
  const candidates = textbook.textbookCandidatesForCase({ chiefComplaint: "右耳听力突降1天", presentHistory: "早晨醒来单侧听力明显下降，伴耳闷及轻度耳鸣", ageYears: 42, sex: "女" });
  assert.ok(candidates.some((item) => item.disease === "耳鸣耳聋"), JSON.stringify(candidates.map((item) => item.disease)));
});

// ─── 6 脱证为主证 ──────────────────────────────────────────────────────────────
await check("6.1 兼证栏里的脱证提为主证、治法固脱在前；原病名教材无此证时病名改虚脱（C053 过敏性休克）", () => {
  const before = { stage: "diagnose", overview: { tcmDiseaseName: "瘾疹", tcmDiseaseRationale: "进食坚果后迅速出现全身风团", primarySyndrome: "风热犯表证", secondarySyndromes: ["阳气虚脱证"] },
    therapy: { overallMethod: "疏风透邪，宣肺利咽，回阳固脱" } };
  const after = JSON.parse(critical.promoteCriticalSecondarySyndrome(JSON.stringify(before)));
  assert.equal(after.overview.primarySyndrome, "阳气虚脱证");
  assert.deepEqual(after.overview.secondarySyndromes, ["风热犯表证"]);
  assert.equal(after.overview.tcmDiseaseName, "虚脱");
  assert.match(after.overview.tcmDiseaseRationale, /瘾疹为其起因/);
  assert.match(after.therapy.overallMethod, /^回阳固脱/);
  const withRationale = JSON.parse(critical.promoteCriticalSecondarySyndrome(JSON.stringify({ ...before, overview: { ...before.overview, tcmDiagnosticRationale: "风团瘙痒，故主证属风热犯表；脉微汗出为阳气欲脱。" } })));
  assert.ok(!/主证属风热/.test(withRationale.overview.tcmDiagnosticRationale), withRationale.overview.tcmDiagnosticRationale);
  assert.match(withRationale.overview.tcmDiagnosticRationale, /以阳气虚脱证为主证，风热犯表证列为兼证/);
  // 模型已把脱证写成主证、病名仍是瘾疹：病名改虚脱，证与治法不动。
  const primaryAlready = { ...before, overview: { ...before.overview, primarySyndrome: "气脱证", secondarySyndromes: ["风毒炽盛证"] } };
  const promoted = JSON.parse(critical.promoteCriticalSecondarySyndrome(JSON.stringify(primaryAlready)));
  assert.equal(promoted.overview.tcmDiseaseName, "虚脱");
  assert.equal(promoted.overview.primarySyndrome, "气脱证");
  const prolapse = { ...before, overview: { ...before.overview, secondarySyndromes: ["气虚脱肛证"] } };
  assert.equal(critical.promoteCriticalSecondarySyndrome(JSON.stringify(prolapse)), JSON.stringify(prolapse));
  assert.match(prompts.buildDiagnosePrompt(pageCase({ chief: "进食坚果后全身瘙痒、喘憋15分钟" })), /脱证为先/);
});

// ─── 7 辨证要点切分 ────────────────────────────────────────────────────────────
await check("7.1 辨证要点「面、睑、唇、舌色淡白」分到每个部位，「咳、喘、痰稀」的单字症状不丢", () => {
  const table = JSON.parse(fs.readFileSync("src/data/tcm-diagnostics-syndrome-criteria.json", "utf8"));
  const entries = table.entries || table;
  const blood = entries.find((entry) => entry.name === "血虚证");
  for (const item of ["面色淡白", "睑色淡白", "唇色淡白", "舌色淡白", "脉细"]) assert.ok(blood.specific.includes(item), JSON.stringify(blood.specific));
  const lung = entries.find((entry) => entry.name === "肺气虚证");
  assert.ok(lung.specific.includes("咳") && lung.specific.includes("喘"), JSON.stringify(lung.specific));
  const dry = entries.find((entry) => entry.name === "燥淫证");
  assert.ok(dry.manifestations.includes("鼻腔干燥") && !dry.manifestations.some((item) => /腔$|口唇腔/.test(item)), JSON.stringify(dry.manifestations));
});

// ─── 8 中性证名的治则 ──────────────────────────────────────────────────────────
await check("8.1 「胃气不和证」这类中性证名不按治法推成「实则泻之」（C091），有邪的证照旧", () => {
  const neutral = { stage: "diagnose", overview: { primarySyndrome: "胃气不和证", secondarySyndromes: [] }, therapy: { overallMethod: "理气和胃，和中止痛" } };
  assert.equal(visible.nationalTreatmentPrinciple("实则泻之", neutral), "调理阴阳");
  assert.equal(visible.nationalTreatmentPrinciple("急则治标", neutral), "急则治标");
  const excess = { stage: "diagnose", overview: { primarySyndrome: "肝气犯胃证", secondarySyndromes: [] }, therapy: { overallMethod: "疏肝理气，和胃止痛" } };
  assert.equal(visible.nationalTreatmentPrinciple("实则泻之", excess), "实则泻之");
});

// ─── 9 结直肠随访 ──────────────────────────────────────────────────────────────
await check("9.1 便秘与「近期出现/加重」不在同一句时不写结直肠随访（C088 帕金森样病例「近期跌倒一次」）", () => {
  const wrap = (reasoning) => `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(reasoning)}\n<!-- DIAGNOSIS_JSON_END -->`;
  const reasoning = { stage: "diagnose", westernDiagnosis: { primary: { name: "帕金森病待查" }, differentials: [] }, management: { followupSafetyNet: "" } };
  const separated = "现病史：静止时右手明显颤抖，走路步幅变小，偶有便秘及嗅觉减退。\n其他四诊/问诊补充：近期跌倒一次，未出现幻觉";
  assert.ok(!/肠镜/.test(visible.normalizeM03WesternDifferentials(wrap(reasoning), separated, 69)));
  const same = "现病史：近两月新出现便秘，大便难解";
  assert.match(visible.normalizeM03WesternDifferentials(wrap(reasoning), same, 69), /肠镜/);
});

// ─── 10 两方说法冲突 ───────────────────────────────────────────────────────────
await check("10.1 病历记着家属与本人说法不同：辨病依据点明、列入待核实（C092）；「回答前后不一致」不算", () => {
  const record = "主诉：全身不舒服半年\n其他四诊/问诊补充：家属与本人对症状持续时间描述不同";
  assert.equal(surface.recordedAccountConflict(record), "家属与本人对症状持续时间描述不同");
  assert.equal(surface.recordedAccountConflict("其他四诊/问诊补充：家属代述，患者回答前后不一致"), undefined);
  assert.match(String(surface.recordedAccountConflict("现病史：患者口述腹痛“昨晚才开始”，又称三天前就因疼痛请假，时间线互相矛盾；无呕血。")), /时间线互相矛盾$/);
  const reasoning = { schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose", overview: { tcmDiseaseName: "眩晕", tcmDiseaseRationale: "以头晕为主症、病程半年，属眩晕范畴。", primarySyndrome: "气血亏虚证" }, pathogenesis: { chain: [], uncertainties: [] } };
  const projected = surface.projectDeliveredReasoning(reasoning, { recordText: record });
  assert.match(projected.overview.tcmDiseaseRationale, /病历记录「家属与本人对症状持续时间描述不同」/);
  assert.ok(projected.pathogenesis.uncertainties.some((item) => item.reason.includes("家属与本人")));
  assert.deepEqual(surface.projectDeliveredReasoning(projected, { recordText: record }), projected, "不幂等");
});

// ─── 11 乳房肿块 ──────────────────────────────────────────────────────────────
await check("11.1 未经影像评估的乳房肿块（≥30 岁）列为优先评估、需排除乳腺癌（C069）；已有超声结果或 25 岁不列", () => {
  const lump = pageCase({ age: 38, chief: "左乳无痛性结节1个月", present: "洗澡时触及无痛肿块，近月无明显增大", past: "母亲有乳腺癌史", detail: "妊娠状态明确否认", exams: "尚未乳腺超声" });
  assert.ok(safety.unevaluatedBreastMass(lump));
  assert.equal(safety.priorityEvaluationFollowupFocus(lump), "乳腺癌");
  assert.match(surface.followupWhenPriorityEvaluation("请服完本次的药后复诊。", "乳腺癌"), /2周内到乳腺专科就诊，先完成乳腺超声/);
  // 乳痈、乳腺炎与已确诊、术后的不算「未经评估」。
  assert.ok(!safety.unevaluatedBreastMass(pageCase({ age: 32, chief: "左乳红肿热痛有硬结3天", present: "产后哺乳期，左乳硬结，发热" })));
  assert.ok(!safety.unevaluatedBreastMass(pageCase({ age: 52, chief: "右乳癌术后3个月，右乳肿物", detail: "否认妊娠" })));
  // 母亲的乳腺癌史不是本人已确诊。
  assert.ok(safety.unevaluatedBreastMass(pageCase({ age: 38, chief: "左乳肿块2月", past: "母亲有乳腺癌病史" })));
  const imaged = pageCase({ age: 38, chief: "左乳无痛性结节1个月", detail: "妊娠状态明确否认", exams: "乳腺超声示左乳结节BI-RADS 3类" });
  assert.ok(!safety.unevaluatedBreastMass(imaged));
  assert.ok(!safety.unevaluatedBreastMass(pageCase({ age: 25, chief: "左乳无痛性结节1个月", detail: "妊娠状态明确否认" })));
  assert.ok(!safety.unevaluatedBreastMass(pageCase({ age: 40, chief: "胃痛3天", present: "无乳房肿块" })));
});

// ─── 12 红旗例的「原病名待查」 ─────────────────────────────────────────────────
await check("12.1 红旗例里急危重病名改「原名待查」照常采信，换成别的病名或症状仍不采信（C071 婴儿败血症）", () => {
  assert.equal(western.heldOnRedFlag({ type: "D", supportedName: "婴儿败血症待查", quote: "", reason: "", currentIsEmergency: true }, "婴儿败血症"), false);
  assert.equal(western.heldOnRedFlag({ type: "D", supportedName: "发热", quote: "", reason: "", currentIsEmergency: true }, "婴儿败血症"), true);
  const table = JSON.parse(fs.readFileSync("src/data/western-diagnostic-criteria.source.json", "utf8"));
  const infant = table.entries.find((entry) => entry.name === "婴儿败血症");
  assert.ok(infant && infant.clinicallyDiagnosable === false && infant.requiredTests.includes("血培养"));
});

// ─── 13 肛肠局部病名 ───────────────────────────────────────────────────────────
await check("13.1 肛裂等局部病名、病历写明未做肛门检查时，辨病依据写明是初步判断（C016）", () => {
  const reasoning = { schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose", overview: { tcmDiseaseName: "肛裂", tcmDiseaseRationale: "以便时肛门刺痛、便后手纸染鲜红血为主，属肛裂范畴。", primarySyndrome: "血热肠燥证" } };
  const record = "主诉：便后滴鲜血3天\n其他四诊/问诊补充：近期食辣、便秘；暂未接受肛门检查";
  const projected = surface.projectDeliveredReasoning(reasoning, { recordText: record });
  assert.match(projected.overview.tcmDiseaseRationale, /需肛门视诊（必要时指诊）确认/);
  const examined = surface.projectDeliveredReasoning(reasoning, { recordText: "主诉：便后滴鲜血3天\n体格检查：肛门视诊见截石位6点肛管裂口" });
  assert.ok(!/视诊（必要时指诊）确认/.test(examined.overview.tcmDiseaseRationale));
});

// ─── 14 随证加减动作与理由相反 ─────────────────────────────────────────────────
const compiler = await jiti.import("../src/lib/m04-proposal-compiler.ts");
await check("14.1 「加」这一行的理由说要去掉这味药时不交付（C098「加川芎（…出血增多时暂去以防动血）」）", () => {
  assert.equal(compiler.addModificationReasonSaysRemove("川芎", "活血力强，出血增多时暂去以防动血"), true);
  assert.equal(compiler.addModificationReasonSaysRemove("川芎", "去川芎以免动血"), true);
  assert.equal(compiler.addModificationReasonSaysRemove("苍术", "燥湿健脾，去除湿邪"), false);
  assert.equal(compiler.addModificationReasonSaysRemove("延胡索", "活血行气止痛"), false);
});

// ─── 15 本轮 qwen 复评后的补修 ─────────────────────────────────────────────────
const provenance = await jiti.import("../src/lib/tcm-formula-provenance.ts");
await check("15.1 优先评估的复诊第一句在开方页与 M05 首次复诊是同一句（C069：一处「2周内乳腺专科」、一处「3天内相关专科」）", () => {
  const lump = pageCase({ age: 38, chief: "左乳无痛性结节1个月", present: "洗澡时触及无痛肿块", past: "母亲有乳腺癌史", detail: "妊娠状态明确否认", exams: "尚未乳腺超声" });
  const first = safety.priorityEvaluationFirstStep("乳腺癌");
  assert.match(first, /2周内到乳腺专科/);
  assert.ok(surface.followupWhenPriorityEvaluation("请服完本次的药后复诊。", "乳腺癌").startsWith(first));
  assert.ok(safety.patientFacingFirstReview(lump, false).startsWith(first.replace(/。$/, "")), safety.patientFacingFirstReview(lump, false));
});

await check("15.2 用药写了药名、只缺剂量频次时，缺项写「缺少剂量/频次」，不说缺药名（C045 二甲双胍）", () => {
  const named = safety.evaluateSafetyGate(pageCase({ sex: "男", age: 58, chief: "口干多饮3月", medication: "二甲双胍" })).missingItems;
  assert.ok(named.includes("已提及当前用药但缺少剂量/频次"), JSON.stringify(named));
  const vague = safety.evaluateSafetyGate(pageCase({ sex: "男", age: 58, chief: "头晕3月", medication: "长期服用降压药" })).missingItems;
  assert.ok(vague.includes("已提及当前用药但缺少药名/剂量/频次"), JSON.stringify(vague));
});

await check("15.3 体重下降同时咯血：红旗照报，写查肺，不写「上消化道…内镜」（C005）；没有咯血的照旧", () => {
  const hemoptysis = safety.evaluateSafetyGate(pageCase({ sex: "男", age: 63, chief: "间断咯血1周，体重下降2月", present: "痰中反复带鲜红血丝，夜间盗汗，近2月体重下降约5kg", detail: "低热、食欲差" })).redFlags;
  assert.ok(hemoptysis.some((item) => /咯血伴体重下降.*胸部CT/.test(item)), JSON.stringify(hemoptysis));
  assert.ok(!hemoptysis.some((item) => /上消化道警示征象（不明原因体重下降）/.test(item)), JSON.stringify(hemoptysis));
  const gastric = safety.evaluateSafetyGate(pageCase({ sex: "男", age: 63, chief: "上腹胀2月，体重下降", present: "上腹胀满，近2月体重下降约5kg，纳差" })).redFlags;
  assert.ok(gastric.some((item) => /上消化道警示征象（不明原因体重下降）/.test(item)), JSON.stringify(gastric));
});

await check("15.4 方名是目录成方（标志药都在）、出处写「自拟方」时按目录补出处（C063 香砂六君子汤加减）", () => {
  const saved = JSON.parse(fs.readFileSync("scripts/fixtures/r1028-c051-prescribe.json", "utf8"));
  const reference = provenance.formulaCompilationReferences(["香砂六君子汤"])[0];
  const base = types.normalizeReasoningV2(saved);
  const candidate = base.formula.candidates[0];
  const herbs = reference.ingredients.map((name, index) => ({ ...candidate.herbs[index % candidate.herbs.length], name }));
  const reasoning = { ...base, formula: { ...base.formula, candidates: [{ ...candidate, name: "香砂六君子汤加减", formulaNames: ["香砂六君子汤"], herbs, formulaSource: { evidenceLevel: "model_inference", source: "自拟方", confidence: "中" } }] } };
  const projected = surface.projectDeliveredReasoning(reasoning, {});
  assert.equal(projected.formula.candidates[0].formulaSource.source, `香砂六君子汤：${reference.source}`);
});

console.log(JSON.stringify({ suite: "r1029-main", cases, failures: process.exitCode ? "see above" : 0 }));
