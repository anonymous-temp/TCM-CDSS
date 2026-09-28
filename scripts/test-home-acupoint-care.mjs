import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// 居家穴位保健与运动保健（2026-09-28，甲方反馈：M04 调护「穴位保健」从未出现；运动保健单列）。
//  · 穴位只来自受治理清单（技术规范原文），由已签名 M03 病性 → 体质确定性选取，模型文字一律丢弃；
//  · 未经中医师终审（pending_clinician_review）的条目缺省不应用，CDSS_HOME_ACUPOINT_CARE=include_pending 临时启用；
//  · 禁忌复用项目级禁忌：居家按揉按「推拿」（妊娠阳性/可疑、急性炎症整段不给），艾灸按「艾灸」（热象）
//    另加烫伤风险（糖尿病、感觉减退、体温≥37.3℃）；红旗与非全剂量方案不给；3～17 岁无来源不给。
const { homeAcupointConstitution, homeAcupointCareStatus } = await import("../src/lib/home-acupoint-care.server.ts");
const { applyTcmTreatmentCapabilityPriority, tcmTreatmentProjectExclusionReason } = await import("../src/lib/tcm-treatment-capabilities.server.ts");
const source = JSON.parse(readFileSync(new URL("../src/data/tcm-home-acupoint-care.source.json", import.meta.url), "utf8"));

const failures = [];
let checks = 0;
const check = (name, fn) => { checks++; try { fn(); } catch (error) { failures.push({ name, message: error.message }); } };

const evidence = { sourceType: "patient_fact", sourceRef: "chiefComplaint", quote: "相关症状" };
const prior = (primarySyndrome, natureItems = [], extra = {}) => ({
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "diagnose",
  overview: { tcmDiseaseName: "虚劳", primarySyndrome, overallPathogenesis: primarySyndrome, overallTherapy: "调理", recommendedFormulaDirection: "无", evidence },
  westernDiagnosis: { primary: { name: "功能性疾病", status: "考虑", confidence: "中", supportingFacts: [], limitations: [], suggestedChecks: [], evidence }, differentials: [] },
  pathogenesis: {
    summary: primarySyndrome,
    locationDifferentiation: { items: [], evidence },
    natureDifferentiation: { items: natureItems, evidence, ...extra },
    chain: [{ nodeId: "P1", patientFact: "相关症状", syndromeEvidence: primarySyndrome, pathogenesis: primarySyndrome, therapyDirection: "调理", evidence }],
    uncertainties: [],
  },
  therapy: { overallPrinciple: "调理", overallMethod: "调理", subTherapies: [] },
  formula: null, nonPharma: null, lineageAdaptation: null,
});
const readyGate = { status: "ready", allowDiagnosis: true, allowDosePrescription: true, candidateMode: "full_dose", action: "proceed", missingItems: [], redFlags: [] };
const caseState = (overrides = {}) => ({
  patient: { sex: "男", age: 52 },
  chiefComplaint: "乏力纳差2月",
  symptoms: { presentHistory: "乏力，食后腹胀，大便偏溏" },
  pastHistory: "否认高血压、糖尿病史",
  medicationHistory: "否认当前用药",
  allergyHistory: "否认药物过敏",
  vitals: { T: "36.5℃", P: "76次/分", R: "18次/分", BP: "122/76mmHg" },
  safetyGate: readyGate,
  ...overrides,
});
const withMode = (mode, fn) => {
  const previous = process.env.CDSS_HOME_ACUPOINT_CARE;
  if (mode == null) delete process.env.CDSS_HOME_ACUPOINT_CARE; else process.env.CDSS_HOME_ACUPOINT_CARE = mode;
  try { return fn(); } finally { if (previous == null) delete process.env.CDSS_HOME_ACUPOINT_CARE; else process.env.CDSS_HOME_ACUPOINT_CARE = previous; }
};
const nonPharmaFor = (m03, state) => {
  const raw = { ...m03, stage: "prescribe", nonPharma: { diet: "清淡", lifestyle: "规律作息", emotion: "舒畅", exercise: "每天散步30分钟", acupointCare: "模型自拟：按揉内关、神门各5分钟", tcmTreatments: [], precautions: [] } };
  const out = applyTcmTreatmentCapabilityPriority(`<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(raw)}\n<!-- DIAGNOSIS_JSON_END -->`, state, m03);
  return JSON.parse(out.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]).nonPharma;
};
// 所有行为断言都走生产调用点（M04 outputTransform 里的 applyTcmTreatmentCapabilityPriority），
// 禁忌与年龄、体温、妊娠的判定不在测试里另拼一份。
const compileFor = (m03, state) => nonPharmaFor(m03, state).acupointCare;

check("source: every entry is from the technical specification, carries both locations and a governed review status", () => {
  const refs = new Set(source.sourceRefs.map((item) => item.id));
  for (const [key, entry] of Object.entries(source.constitutions)) {
    assert.ok(refs.has(entry.sourceRef), `${key}: unknown source`);
    assert.ok(["approved", "pending_clinician_review"].includes(entry.adjudicationStatus), key);
    for (const point of [...entry.acupressure.points, ...(entry.extraPoints || [])]) {
      assert.ok(point.standardLocation.length >= 6 && point.patientLocation.length >= 6, `${key}/${point.name}`);
    }
    assert.ok(entry.acupressure.sourceText.length >= 6, `${key}: source text`);
  }
  // 技术规范给了艾灸的只有气虚、阳虚（与特禀，特禀不对应病性不收）；其余体质不得自己加艾灸。
  assert.deepEqual(Object.entries(source.constitutions).filter(([, entry]) => entry.moxibustion).map(([key]) => key).sort(), ["qi_deficiency", "yang_deficiency"]);
  assert.equal(new Set(Object.keys(source.constitutions)).size, 7);
});

check("mapping: signed M03 nature → constitution; deficiency before excess; external/acute and phlegm-heat do not map", () => {
  const cases = [
    ["脾胃气虚证", [], "qi_deficiency"],
    ["脾肾阳虚证", ["阳虚", "寒"], "yang_deficiency"],
    ["肝肾阴虚证", ["阴虚"], "yin_deficiency"],
    ["气阴两虚证", [], "yin_deficiency"],
    ["心脾两虚证", [], "qi_deficiency"],
    ["气血两虚证", [], "qi_deficiency"],
    ["脾虚湿盛证", ["湿"], "qi_deficiency"],
    ["膀胱湿热证", [], "damp_heat"],
    ["气滞血瘀证", [], "blood_stasis"],
    ["肝气郁结证", [], "qi_stagnation"],
    ["肝胃不和证", [], "qi_stagnation"],
    ["肾气不足证", [], "qi_deficiency"],
    ["肾阳不足证", ["阳气不足"], "yang_deficiency"],
    ["痰湿内阻证", ["痰", "湿"], "phlegm_dampness"],
    ["风热犯肺证", ["风", "热"], undefined],
    ["痰热壅肺证", ["痰", "热"], undefined],
    ["热毒蕴结证", [], undefined],
    ["肝阳上亢证", [], undefined],
  ];
  for (const [syndrome, natures, expected] of cases) {
    assert.equal(homeAcupointConstitution(prior(syndrome, natures)), expected, syndrome);
  }
  // 证候未形成（急诊优先的有限诊断、证据不足）按结构化 resolution 判定，不输出。
  const unresolved = prior("气虚证", ["气虚"]);
  unresolved.overview.primarySyndromeResolution = "unresolved";
  assert.equal(homeAcupointConstitution(unresolved), undefined);
});

check("review gate: pending entries are not applied by default; include_pending enables them; off disables everything", () => {
  const m03 = prior("脾胃气虚证");
  assert.ok(Object.values(source.constitutions).every((entry) => entry.adjudicationStatus === "pending_clinician_review"),
    "the first batch awaits clinician sign-off; flip entries to approved only with a signed review");
  withMode(null, () => assert.equal(compileFor(m03, caseState()), null));
  withMode("off", () => assert.equal(compileFor(m03, caseState()), null));
  const text = withMode("include_pending", () => compileFor(m03, caseState()));
  assert.match(text, /按揉气海（肚脐正下方约两横指处）、关元（肚脐正下方约四横指处）：用掌根/);
  assert.match(text, /每个穴位2～3分钟，每天1～2次/);
  assert.match(text, /也可以艾灸气海、关元：[^。]*2～3厘米[^。]*每次10分钟，每周1次/);
  assert.match(text, /饭后1小时内不宜按揉/);
  assert.equal(withMode(null, () => homeAcupointCareStatus()).mode, "approved_only");
});

check("safety: red flag, non-dose, missing gate and acute inflammation give nothing", () => withMode("include_pending", () => {
  const m03 = prior("脾胃气虚证");
  assert.equal(compileFor(m03, caseState({ safetyGate: { ...readyGate, status: "red_flag", redFlags: ["黑便"] } })), null);
  assert.equal(compileFor(m03, caseState({ safetyGate: { ...readyGate, candidateMode: "non_dose_only", allowDosePrescription: false } })), null);
  assert.equal(compileFor(m03, caseState({ safetyGate: { ...readyGate, candidateMode: "blocked", allowDosePrescription: false } })), null);
  // 参考剂量待复核（多半只是妊娠/用药细节未写）照常给：线上 26 岁痛经例就是 limited_dose。
  assert.match(compileFor(m03, caseState({ safetyGate: { ...readyGate, status: "needs_information", candidateMode: "limited_dose", allowDosePrescription: false } })) || "", /按揉气海/);
  assert.equal(compileFor(m03, caseState({ safetyGate: undefined })), null);
  assert.equal(compileFor(m03, caseState({ symptoms: { presentHistory: "右小腿蜂窝织炎，红肿热痛" } })), null, "acute inflammation");
}));

check("pregnancy: positive/possible give nothing; unrecorded status drops contraindicated and abdominal/lumbosacral points and moxibustion", () => withMode("include_pending", () => {
  const woman = (chiefComplaint, age = 30) => caseState({ patient: { sex: "女", age }, chiefComplaint });
  const qi = prior("脾胃气虚证");
  assert.equal(compileFor(qi, woman("孕12周，乏力纳差")), null, "positive pregnancy");
  assert.equal(compileFor(qi, woman("乏力纳差，停经7周，可能怀孕")), null, "possible pregnancy");
  assert.equal(compileFor(qi, woman("乏力纳差2月")), null, "unrecorded: 气海/关元 are abdominal, nothing left");
  const yin = compileFor(prior("肝肾阴虚证", ["阴虚"]), woman("乏力纳差2月"));
  assert.match(yin, /^按揉太溪（/);
  assert.doesNotMatch(yin, /三阴交|艾灸/);
  // 线上 26 岁痛经例的形状：寒凝血瘀 → 血瘀质，妊娠未写明、参考剂量待复核；期门（胸部）与血海（下肢）不在禁用之列。
  const stasis = compileFor(prior("寒凝血瘀证", ["寒", "血瘀"]), caseState({ patient: { sex: "女", age: 26 }, chiefComplaint: "经行腹痛2年",
    safetyGate: { ...readyGate, status: "needs_information", candidateMode: "limited_dose", allowDosePrescription: false } }));
  assert.match(stasis, /^按揉期门（[^）]+）、血海（/);
  const qiStagnation = compileFor(prior("肝气郁结证"), woman("胁胀易怒2月"));
  assert.match(qiStagnation, /^按揉太冲（/);
  assert.doesNotMatch(qiStagnation, /合谷/);
  // 阴性对照：写明否认妊娠、或已 60 岁以上，照常给全部穴位与艾灸。
  assert.match(compileFor(qi, woman("乏力纳差2月，否认妊娠")), /按揉气海[^。]*关元[\s\S]*也可以艾灸/);
  assert.match(compileFor(qi, woman("乏力纳差2月", 66)), /按揉气海/);
}));

check("existing defect: possible pregnancy now excludes clinician-operated projects too (was dropped by the affirmed-only filter)", () => {
  const m03 = prior("脾胃气虚证");
  const possible = { patient: { sex: "女", age: 30 }, chiefComplaint: "乏力纳差，停经7周，可能怀孕" };
  for (const code of ["acupuncture", "moxibustion", "tuina"]) {
    assert.match(tcmTreatmentProjectExclusionReason(code, m03, possible) || "", /妊娠/, code);
    assert.equal(tcmTreatmentProjectExclusionReason(code, m03, { ...possible, chiefComplaint: "乏力纳差，否认妊娠" }), undefined, `${code} negative control`);
  }
});

check("age: <6 months none; 6–36 months by the child template's month bands; 3–17 years none", () => withMode("include_pending", () => {
  const m03 = prior("脾胃气虚证");
  const at = (age) => compileFor(m03, caseState({ patient: { sex: "男", age } }));
  assert.equal(at(0.3), null);
  assert.match(at(0.7), /摩腹[^。]*每次1～3分钟。捏脊/);
  assert.match(at(1.7), /迎香[\s\S]*足三里/);
  assert.match(at(2.8), /四神聪/);
  assert.doesNotMatch(at(0.7), /艾灸|气海/, "children never get the adult constitution points or moxibustion");
  assert.equal(at(5), null);
  assert.equal(at(16), null);
  assert.ok(at(18));
}));

check("moxibustion: dropped for fever, diabetes/reduced sensation and heat signs, while acupressure stays", () => withMode("include_pending", () => {
  const m03 = prior("脾胃气虚证");
  for (const state of [
    caseState({ vitals: { T: "38.1℃" } }),
    caseState({ pastHistory: "2型糖尿病10年" }),
    caseState({ symptoms: { presentHistory: "乏力纳差，舌红苔黄" } }),
  ]) {
    const text = compileFor(m03, state);
    assert.match(text, /按揉气海/);
    assert.doesNotMatch(text, /艾灸/);
  }
  // 阳虚：按揉只有关元，艾灸关元、命门——命门在按揉里没出现，艾灸句里要带定位。
  const yang = compileFor(prior("脾肾阳虚证", ["阳虚"]), caseState());
  assert.match(yang, /按揉关元（[^）]+）/);
  assert.match(yang, /也可以艾灸关元、命门（后腰正中[^）]+）/);
}));

check("integration: the prescribe transform discards model acupoint text and writes the governed text only when allowed", () => {
  const m03 = prior("肝肾阴虚证", ["阴虚"]);
  const off = withMode(null, () => nonPharmaFor(m03, caseState()));
  assert.equal(off.acupointCare, null, "pending list must not leak model text either");
  assert.equal(off.exercise, "每天散步30分钟", "exercise is model-authored and passes through");
  const on = withMode("include_pending", () => nonPharmaFor(m03, caseState()));
  assert.match(on.acupointCare, /^按揉太溪（[^）]+）、三阴交（[^）]+）：用拇指或中指指腹/);
  assert.doesNotMatch(on.acupointCare, /内关|神门|5分钟/);
  assert.equal(withMode("include_pending", () => nonPharmaFor(m03, undefined)).acupointCare, null);
});

check("wiring: HIS guidance, visible report, page, delivery checkpoint and M04 prompt carry 运动保健 and 穴位保健", () => {
  const his = readFileSync(new URL("../src/lib/his-scheme.ts", import.meta.url), "utf8");
  assert.match(his, /return \{ diet, lifestyle, emotion, exercise, acupointCare, precautions \};/);
  const visible = readFileSync(new URL("../src/lib/diagnosis-visible-summary.ts", import.meta.url), "utf8");
  assert.match(visible, /\["运动保健", "exercise"\][^\n]*\["穴位保健", "acupointCare"\]/);
  const page = readFileSync(new URL("../src/app/diagnosis/DiagnosisClient.tsx", import.meta.url), "utf8");
  assert.match(page, /label="运动保健" value=\{reasoning\.nonPharma\.exercise\}/);
  assert.match(page, /label="穴位保健" value=\{reasoning\.nonPharma\.acupointCare\}/);
  assert.doesNotMatch(page, /穴位\/外治/);
  const prompts = readFileSync(new URL("../src/lib/diagnosis-prompts.ts", import.meta.url), "utf8");
  assert.match(prompts, /"exercise":"运动保健"/);
  assert.match(prompts, /饮食、起居、运动、情志四段调护/);
  assert.doesNotMatch(prompts, /acupointCare 由服务端固定为 null/);
});

console.log(JSON.stringify({ suite: "home-acupoint-care", checks, failures }, null, 1));
assert.equal(failures.length, 0);
