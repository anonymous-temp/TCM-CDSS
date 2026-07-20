import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": `${process.cwd()}/src` },
});
const {
  buildDeterministicRiskFollowup,
  buildSafetyLimitedDiagnosisReasoning,
  canForceProceedPastSafetyGate,
  currentVitalsSummary,
  evaluateSafetyGate,
  hardDoseSafetyBoundaryReasons,
  hasDeterministicCriticalVitalRedFlag,
  measuredVitalAdvisories,
  narrativeFallbackAdvisories,
  renderSafetyLimitedDiagnosisContract,
} = await jiti.import("../src/lib/diagnosis-safety.ts");
const { normalizeCaseStateInput } = await jiti.import("../src/lib/diagnosis-types.ts");

function stateWith(text, placement) {
  const base = {
    id: `mutation-${placement}`,
    phase: "collect",
    patient: {},
    chiefComplaint: placement === "chief" ? text : "复诊咨询",
    symptoms: {},
    completeness: { level: "C", redFlag: 0.8, infoGain: 0.7, managementImpact: 0.7, answerability: 0.7 },
    questionRounds: 0,
    maxQuestionRounds: 1,
    conversation: placement === "conversation" ? [{ role: "user", content: text }] : [],
  };
  if (placement === "history") {
    base.hisRecord = {
      caseId: "mutation-case",
      capturedAt: new Date(0).toISOString(),
      fields: { zhushu: "复诊咨询", xianbingshi: text },
      rawText: `现病史：${text}`,
    };
  }
  return base;
}

function variants(text) {
  return [
    text,
    `患者自诉：${text}`,
    `现病史：  ${text.replaceAll("，", ", ").replaceAll("。", ".")}`,
  ];
}

const positiveScenarios = [
  "2小时前突发压榨性胸痛，伴大汗。",
  "既往有胸痛，目前再次发作并持续半小时。",
  "既往言语不清已恢复，今天再次言语不清并伴右侧肢体无力。",
  "既往曾有轻生念头，治疗后好转，目前再次出现具体自杀计划。",
  "突发呼吸困难，不能平卧。",
  "突发言语不清，右侧肢体无力。",
  "反复想到自杀，且已有具体计划。",
  "既往血氧85%，本次复测仍为88%。",
  "既往血压200/120mmHg，本次复测225/135mmHg。",
  "上周心电图正常、肌钙蛋白阴性；胸痛30分钟。",
  "上周心电图正常、肌钙蛋白阴性；今天突发胸痛并持续30分钟。",
  "今天突发胸痛并持续30分钟；上周心电图正常、肌钙蛋白阴性。",
  "既往胸痛已缓解、当前再发胸痛。",
  "既往胸痛已缓解，当前再发。",
  "当前收缩压225mmHg，舒张压135mmHg。",
  "指脉氧89%。",
  "健康宣教：若出现胸痛应立即急诊；患者当前突发胸痛。",
  "我爸爸三年前胸痛住过院，我现在胸痛持续20分钟并大汗。",
  "如果以后出现胸痛要立即就诊，我胸痛持续20分钟并大汗。",
  "如果以后胸痛要立即就诊，胸痛已经持续20分钟并大汗。",
  "如果以后胸痛要急诊，我现在胸痛持续20分钟，计划马上去医院。",
  "健康宣教：若出现胸痛应急诊，现胸痛持续20分钟并大汗。",
  "脑梗死恢复期3个月，病情原本稳定，今天突然右侧肢体无力明显加重并言语不清。",
  "脑卒中后半年康复稳定，今晨再发口角歪斜和左侧肢体无力。",
  "脑梗死恢复期半年，康复稳定。刚刚出现口角歪斜。",
  "脑卒中后半年病情稳定。近2日右侧肢体无力加重。",
  "突发左侧肢体麻木并感觉减退。",
  "突然口齿不清，说话含糊。",
  "突发视物重影并行走不稳。",
  "突然腹痛，伴反跳痛。",
  "脑卒中后康复稳定，刚刚出现眩晕、复视和共济失调。",
  "突发失语，不能说话。",
  "今晨出现言语理解障碍。",
  "突发右侧偏盲。",
  "脑卒中后半年病情稳定，右侧肢体无力今晨突然加重。",
  "脑卒中后半年病情稳定，言语不清今日再发。",
  "三年前曾短暂口角歪斜，已完成治疗；今天再次出现言语不清。",
  "今天再次出现言语不清；三年前曾短暂口角歪斜，已完成治疗。",
  "左侧肢体麻木并感觉减退。",
  "吃虾后喉头迅速肿胀，声音嘶哑，吞咽困难。",
  "注射药物后突发咽喉水肿并出现呼吸困难。",
  "突然喉头水肿，声音嘶哑。",
  "突发剧烈腹痛，伴反跳痛。",
  "如果以后胸痛就急诊，现在胸痛持续20分钟。",
  "既往胸痛一直未缓解，目前仍胸痛。",
  "家属代诉：今晨突发胸痛持续20分钟并大汗。",
  "既往黑便已经消失，今晨再次排柏油样便。",
  "今晨排柏油样便2次。",
  "否认胸痛、气促，黑便、呕血各1次。",
  "否认腹痛，黑便伴头晕。",
  "否认腹痛，柏油样便伴乏力。",
];

const advisoryScenarios = [
  "既往曾有晕厥，治疗后无再发，目前再次晕厥。",
  "寒战，体温38度9。",
  "否认胸痛、合并气促持续2小时。",
  "否认胸痛、黑便，但今晨突发气促并持续加重。",
  "否认胸痛、伴气促持续2小时。",
  "否认胸痛、出现气促并持续加重。",
  "否认胸痛、黑便、气促，晕厥。",
  "其父亲曾有晕厥史，患者本人今日突发晕厥。",
  "我妈妈以前晕厥过，我今天突发晕厥一次。",
];

const negativeScenarios = [
  "否认胸痛、胸闷、气促、晕厥、黑便、便血、呕血、剧烈头痛、肢体无力、寒战。",
  "既往曾有胸痛，已由心内科评估并治疗，目前无再发。",
  "既往曾有晕厥，已完成心内科评估，目前无再发。",
  "既往曾有黑便，治疗后已消失，目前大便正常。",
  "既往曾有言语不清，治疗后已恢复，目前无再发。",
  "既往曾有自伤想法，治疗后好转，目前明确否认自伤、自杀及他伤想法。",
  "既往血氧85%，吸氧后本次复测98%。",
  "既往体温39.2℃，本次测量36.8℃。",
  "既往血压200/120mmHg，本次复测120/80mmHg。",
  "既往心率140次/分，本次复测78次/分。",
  "既往呼吸30次/分，本次复测18次/分。",
  "突发胸痛后已急诊完成心电图、肌钙蛋白检查，心内科评估为非急症。",
  "否认胸痛、气促、晕厥。",
  "否认胸痛、气促，亦无黑便、呕血。",
  "既往晕厥史，无再发。",
  "既往黑便史，目前无黑便。",
  "否认胸痛，胸闷，气促，晕厥。",
  "否认呕血，黑便，便血。",
  "否认黑便伴头晕，亦无呕血。",
  "脑梗死后右侧肢体无力3个月，出院后病情稳定；近三个月无新发口角歪斜、言语不清或意识改变。",
  "脑卒中恢复期半年，左手精细动作较差，康复期逐步恢复，无再发或明显加重。",
  "脑梗死恢复期半年，右侧肢体无力持续存在但康复稳定，近期无加重。",
  "否认单侧肢体麻木、复视、视力骤降、行走不稳或口齿不清。",
  "糖尿病多年，双足麻木3个月，症状对称且稳定，无突发无力或言语异常。",
  "TIA后半年，左侧肢体无力已恢复，目前稳定，无再发。",
  "腹痛不是很重，仍持续存在。",
  "健康宣教：若出现胸痛、呼吸困难应立即急诊；患者目前无上述不适。",
  "其父亲曾有晕厥史，患者本人从未发生晕厥。",
  "健康宣教：若吃虾后出现喉头肿胀、声音嘶哑或吞咽困难，应立即急诊。",
  "其母亲吃虾后曾有喉头水肿和声音嘶哑，患者本人无上述症状。",
  "患者否认吃虾后喉头肿胀、声音嘶哑和吞咽困难。",
  "既往吃虾后曾有喉头肿胀和声音嘶哑，治疗后已消退，目前无再发。",
  "上周胸痛去急诊查过，之后已经完全缓解；今天只是复诊，目前无胸痛气促。",
  "今天只是复诊，目前无胸痛气促；上周曾因胸痛去急诊，之后已经完全缓解。",
  "目前走路说话正常；三年前曾短暂口角歪斜，已完成治疗且近期没有新发无力或言语不清。",
  "三年前曾短暂口角歪斜，已完成治疗；目前走路说话正常，近期没有新发无力或言语不清。",
  "我妈妈以前晕厥过，我本人从来没有晕厥。",
  "我爸爸三年前胸痛住过院，我目前没有胸痛气促。",
  "如果胸痛加重，我会晕厥就马上去急诊；目前没有胸痛或晕厥。",
  "如果胸痛加重，我胸痛时会伴大汗和气促。",
  "如果吃虾，我喉头可能水肿并呼吸困难。",
  "我妈今天突发晕厥，我本人没有任何不适。",
  "我姐姐今天突发晕厥，我本人无不适。",
  "发生晕厥的是我姐姐，我本人无不适。",
  "三年前曾晕厥一次，之后没有再发。",
  "健康宣教：出现胸痛时应立即急诊。",
  "健康宣教：如胸痛加重，应立即急诊。",
  "当患者血压190/120mmHg时应立即急诊；本次复测120/80mmHg。",
  "家属有自杀计划，患者仅失眠并否认自杀、自伤。",
  "健康宣教：若出现自杀想法应立即急诊；患者目前否认自杀意念。",
];

let cases = 0;
for (const scenario of positiveScenarios) {
  for (const variant of variants(scenario)) {
    for (const placement of ["chief", "history", "conversation"]) {
      assert.equal(evaluateSafetyGate(stateWith(variant, placement)).status, "red_flag", `${placement}: ${variant}`);
      cases += 1;
    }
  }
}

for (const scenario of advisoryScenarios) {
  for (const variant of variants(scenario)) {
    for (const placement of ["chief", "history", "conversation"]) {
      const state = stateWith(variant, placement);
      assert.notEqual(evaluateSafetyGate(state).status, "red_flag", `${placement}: ${variant}`);
      assert.ok(narrativeFallbackAdvisories(state).length > 0, `${placement}: ${variant}`);
      cases += 1;
    }
  }
}

for (const scenario of negativeScenarios) {
  for (const variant of variants(scenario)) {
    for (const placement of ["chief", "history", "conversation"]) {
      assert.notEqual(evaluateSafetyGate(stateWith(variant, placement)).status, "red_flag", `${placement}: ${variant}`);
      cases += 1;
    }
  }
}

const staleClearance = "2小时前突发压榨性胸痛，伴大汗；但既往上周心电图正常、肌钙蛋白阴性。";
for (const placement of ["chief", "history", "conversation"]) {
  assert.equal(evaluateSafetyGate(stateWith(staleClearance, placement)).status, "red_flag", `${placement}: stale clearance`);
  cases += 1;
}

for (const invalidOxygen of ["SpO2 999%", "指脉氧999%", "氧饱和度101%"] ) {
  for (const variant of variants(invalidOxygen)) {
    for (const placement of ["chief", "history", "conversation"]) {
      const gate = evaluateSafetyGate(stateWith(variant, placement));
      assert.notEqual(gate.status, "red_flag", `${placement}: ${variant}`);
      assert.equal(gate.allowDosePrescription, false, `${placement}: ${variant}`);
      assert.match(gate.missingItems.join("、"), /生命体征数值需复核.*血氧/, `${placement}: ${variant}`);
      cases += 1;
    }
  }
}

for (const vitalsDetail of [
  "既往血氧80%，本次复测98%",
  "若血氧80%应立即就医；患者当前血氧98%",
]) {
  const state = {
    ...stateWith("复诊咨询", "chief"),
    hisRecord: {
      caseId: "scoped-spo2",
      capturedAt: new Date(0).toISOString(),
      fields: { zhushu: "复诊咨询", vitalsDetail },
      rawText: `生命体征：${vitalsDetail}`,
    },
  };
  assert.match(currentVitalsSummary(state) || "", /SpO2 98%/, vitalsDetail);
  assert.doesNotMatch(currentVitalsSummary(state) || "", /SpO2 80%/, vitalsDetail);
  assert.notEqual(evaluateSafetyGate(state).status, "red_flag", vitalsDetail);
  cases += 1;
}

const semanticReadyBase = {
  ...stateWith("胃脘胀满反复1月。", "chief"),
  patient: { sex: "男", age: 40 },
  tongue: "舌淡苔薄白",
  pulse: "脉细",
  allergyHistory: "否认药物及食物过敏",
  medicationHistory: "否认当前用药",
};
const checkedEmptyFacts = {
  redFlags: [],
  semanticStatus: "checked",
  resultSource: "fresh",
  reviewStatus: "checked",
  sourceCoverage: "full",
};
const checkedGate = evaluateSafetyGate({
  ...semanticReadyBase,
  clinicalFacts: checkedEmptyFacts,
});
assert.equal(checkedGate.status, "ready", "completed semantic screening may reach ready when all other dose slots are complete");
cases += 1;

const crossClauseChestCue = evaluateSafetyGate({
  ...semanticReadyBase,
  chiefComplaint: "痰多胸闷2周",
  hisRecord: {
    caseId: "cross-clause-chest-cue",
    capturedAt: new Date(0).toISOString(),
    fields: {
      zhushu: "痰多胸闷2周",
      sex: "男",
      age: "45岁",
      guomin: "否认药物过敏",
      yongyaoshi: "否认当前用药",
      vitalsT: "36.5℃",
      vitalsP: "76次/分",
      vitalsR: "18次/分",
      vitalsBP: "122/76mmHg",
      tcmTongue: "舌淡红，苔薄白",
      tcmPulse: "弦细",
    },
    rawText: "否认胸痛、大汗、气促和晕厥。",
  },
  clinicalFacts: checkedEmptyFacts,
});
assert.notEqual(crossClauseChestCue.status, "red_flag", "a current-time word in the next HIS field must not turn non-acute chest tightness into an emergency");
assert.equal(crossClauseChestCue.redFlags.length, 0);
cases += 1;

const criticalStructuredBloodPressures = [
  { vitals: { systolicBP: "220", diastolicBP: "130" }, expected: "220/130" },
  { vitals: { SBP: 225, DBP: 80 }, expected: "225/80" },
  { vitals: { sbp: "118mmHg", dbp: "40 mmHg" }, expected: "118/40" },
  { vitals: { systolic: 78, diastolic: 55 }, expected: "78/55" },
];
for (const { vitals, expected } of criticalStructuredBloodPressures) {
  const state = {
    ...semanticReadyBase,
    vitals,
    clinicalFacts: checkedEmptyFacts,
  };
  const normalizedState = normalizeCaseStateInput(state);
  assert.ok(normalizedState, `${expected}: API case-state normalization must preserve split BP input`);
  const gate = evaluateSafetyGate(normalizedState);
  assert.equal(gate.status, "red_flag", `${expected}: either critical structured BP component must trigger a red flag`);
  assert.equal(hasDeterministicCriticalVitalRedFlag(normalizedState), true, `${expected}: critical vital must be eligible for the deterministic fast path`);
  assert.match(gate.redFlags.join("、"), new RegExp(expected.replace("/", "\\/")), `${expected}: red flag must retain the measured pair`);
  assert.match(currentVitalsSummary(normalizedState) || "", new RegExp(expected.replace("/", "\\/")), `${expected}: split fields must synthesize a BP summary`);
  cases += 1;
}

for (const { vitals, expected } of [
  { vitals: { systolicBP: "190", diastolicBP: "122" }, expected: "190/122" },
  { vitals: { SBP: 181, DBP: 80 }, expected: "181/80" },
  { vitals: { sbp: "118mmHg", dbp: "48 mmHg" }, expected: "118/48" },
  { vitals: { systolic: 85, diastolic: 55 }, expected: "85/55" },
]) {
  const state = {
    ...semanticReadyBase,
    vitals,
    clinicalFacts: checkedEmptyFacts,
  };
  const normalizedState = normalizeCaseStateInput(state);
  assert.ok(normalizedState, `${expected}: severe structured BP must normalize`);
  const gate = evaluateSafetyGate(normalizedState);
  assert.notEqual(gate.status, "red_flag", `${expected}: a severe BP value alone is not proof of an emergency`);
  assert.equal(hasDeterministicCriticalVitalRedFlag(normalizedState), false, `${expected}: semantic triage must assess symptom context`);
  assert.match(measuredVitalAdvisories(normalizedState).join("、"), new RegExp(expected.replace("/", "\\/")), `${expected}: urgent repeat-measurement advisory is retained`);
  cases += 1;
}

for (const { vitals, expected } of [
  { vitals: { T: "39.2℃" }, expected: /体温 39\.2℃/ },
  { vitals: { P: "120次\/分" }, expected: /心率\/脉搏 120次\/分/ },
  { vitals: { R: "26次\/分" }, expected: /呼吸 26次\/分/ },
  { vitals: { SpO2: "91%" }, expected: /血氧饱和度 91%/ },
]) {
  const state = {
    ...semanticReadyBase,
    vitals,
    clinicalFacts: checkedEmptyFacts,
  };
  const gate = evaluateSafetyGate(state);
  assert.notEqual(gate.status, "red_flag", `${JSON.stringify(vitals)}: an isolated severe observation needs context, not an emergency label`);
  assert.equal(hasDeterministicCriticalVitalRedFlag(state), false);
  assert.match(measuredVitalAdvisories(state).join("、"), expected);
  cases += 1;
}

for (const { vitals, expected } of [
  { vitals: { T: "40.1℃" }, expected: /体温 40\.1℃/ },
  { vitals: { P: "150次\/分" }, expected: /心率\/脉搏 150次\/分/ },
  { vitals: { R: "35次\/分" }, expected: /呼吸 35次\/分/ },
  { vitals: { SpO2: "89%" }, expected: /血氧饱和度 89%/ },
]) {
  const state = {
    ...semanticReadyBase,
    vitals,
    clinicalFacts: checkedEmptyFacts,
  };
  const gate = evaluateSafetyGate(state);
  assert.equal(gate.status, "red_flag", `${JSON.stringify(vitals)}: an extreme measured vital remains a deterministic emergency floor`);
  assert.equal(hasDeterministicCriticalVitalRedFlag(state), true);
  assert.match(gate.redFlags.join("、"), expected);
  cases += 1;
}

for (const vitals of [
  { systolicBp: "128", diastolicBp: "78" },
  { systolicPressure: "135 mmHg", diastolicPressure: "85mmHg" },
]) {
  const state = {
    ...semanticReadyBase,
    vitals,
    clinicalFacts: checkedEmptyFacts,
  };
  const gate = evaluateSafetyGate(state);
  assert.equal(gate.status, "ready", JSON.stringify(vitals));
  assert.equal(hasDeterministicCriticalVitalRedFlag(state), false, JSON.stringify(vitals));
  assert.doesNotMatch(gate.redFlags.join("、"), /血压/, JSON.stringify(vitals));
  assert.match(currentVitalsSummary(state) || "", /BP \d+\/\d+mmHg/, JSON.stringify(vitals));
  cases += 1;
}

for (const conflict of [
  {
    hisFields: { vitalsBP: "120/80mmHg" },
    vitals: { systolicBP: "190", diastolicBP: "122" },
    authoritative: /120\/80/,
    polluted: /190\/122/,
  },
  {
    hisFields: { vitalsDetail: "SpO2 98%" },
    vitals: { SpO2: "89%" },
    authoritative: /98/,
    polluted: /89/,
  },
  {
    hisFields: { vitalsP: "76次/分" },
    vitals: { HR: "140次/分" },
    authoritative: /76/,
    polluted: /140/,
  },
]) {
  const state = {
    ...semanticReadyBase,
    vitals: conflict.vitals,
    hisRecord: {
      caseId: "conflicting-current-vitals",
      capturedAt: new Date(0).toISOString(),
      fields: { zhushu: semanticReadyBase.chiefComplaint, ...conflict.hisFields },
      rawText: "主诉：胃脘胀满反复1月。",
    },
    clinicalFacts: checkedEmptyFacts,
  };
  const gate = evaluateSafetyGate(state);
  assert.notEqual(gate.status, "red_flag", JSON.stringify(conflict));
  assert.equal(gate.redFlags.length, 0, JSON.stringify(conflict));
  assert.match(currentVitalsSummary(state) || "", conflict.authoritative, JSON.stringify(conflict));
  assert.doesNotMatch(currentVitalsSummary(state) || "", conflict.polluted, JSON.stringify(conflict));
  cases += 1;
}

const unparseableAliasConflict = {
  ...semanticReadyBase,
  vitals: { HR: "一百四十次/分" },
  hisRecord: {
    caseId: "unparseable-current-vital-alias",
    capturedAt: new Date(0).toISOString(),
    fields: { zhushu: semanticReadyBase.chiefComplaint, vitalsP: "76次/分" },
    rawText: "主诉：胃脘胀满反复1月。",
  },
  clinicalFacts: checkedEmptyFacts,
};
const unparseableAliasGate = evaluateSafetyGate(unparseableAliasConflict);
assert.equal(unparseableAliasGate.status, "needs_information", "an unparseable conflicting vital alias must not disappear behind a valid HIS value");
assert.equal(unparseableAliasGate.allowDosePrescription, false);
assert.match(unparseableAliasGate.missingItems.join("、"), /脉搏|心率/);
cases += 1;

for (const vitals of [
  { systolicBP: "190" },
  { SBP: "high", DBP: "80" },
  { SBP: "999", DBP: "80" },
  { systolic: 80, diastolic: 120 },
]) {
  const gate = evaluateSafetyGate({
    ...semanticReadyBase,
    vitals,
    clinicalFacts: checkedEmptyFacts,
  });
  assert.equal(gate.status, "needs_information", `${JSON.stringify(vitals)}: invalid split BP must request verification`);
  assert.equal(gate.redFlags.length, 0, `${JSON.stringify(vitals)}: invalid split BP must not become a clinical red flag`);
  assert.match(gate.missingItems.join("、"), /血压/, `${JSON.stringify(vitals)}: verification item must name BP`);
  cases += 1;
}

for (const semanticFinding of [
  { status: "historical", text: "上周胸痛去急诊查过，之后已经完全缓解；今天只是复诊，目前无胸痛气促", quote: "上周胸痛去急诊查过" },
  { status: "negative", text: "今天只是复诊，目前无胸痛气促", quote: "目前无胸痛气促" },
]) {
  const gate = evaluateSafetyGate({
    ...semanticReadyBase,
    chiefComplaint: semanticFinding.text,
    vitals: { systolicBP: "225", diastolicBP: "135" },
    clinicalFacts: {
      redFlags: [{ category: "cardiac", status: semanticFinding.status, quote: semanticFinding.quote }],
      semanticStatus: "checked",
      resultSource: "fresh",
      reviewStatus: "checked",
      sourceCoverage: "full",
    },
  });
  assert.equal(gate.status, "red_flag", `${semanticFinding.status}: semantic scope must not cancel an independent critical vital sign`);
  assert.match(gate.redFlags.join("、"), /血压 225\/135mmHg/);
  cases += 1;
}

const unavailableSemanticState = {
  ...semanticReadyBase,
  clinicalFacts: {
    redFlags: [],
    semanticStatus: "unavailable",
    resultSource: "failure",
    unavailableReason: "timeout",
  },
};
const unavailableGate = evaluateSafetyGate(unavailableSemanticState);
assert.equal(unavailableGate.status, "needs_information", "semantic failure must not masquerade as a completed safety screen");
assert.equal(unavailableGate.allowDiagnosis, true, "semantic failure must not deadlock M03");
assert.equal(unavailableGate.allowDosePrescription, false, "semantic failure must lock dose-level output");
assert.match(unavailableGate.missingItems.join("、"), /语义红旗筛查未完成.*模型超时/);
assert.equal(canForceProceedPastSafetyGate(unavailableGate), true, "semantic failure remains visible but cannot deadlock the doctor-facing workflow");
assert.equal(hardDoseSafetyBoundaryReasons(unavailableSemanticState).length, 0, "model availability is not a clinical dose boundary");
cases += 1;

const unavailableAnaphylaxisGate = evaluateSafetyGate({
  ...stateWith("吃虾后喉头迅速肿胀，声音嘶哑，吞咽困难。", "chief"),
  clinicalFacts: {
    redFlags: [],
    semanticStatus: "unavailable",
    resultSource: "failure",
    unavailableReason: "model_error",
  },
});
assert.equal(unavailableAnaphylaxisGate.status, "red_flag", "deterministic anaphylactic airway detection must survive semantic model failure");
assert.equal(unavailableAnaphylaxisGate.redFlags.length, 1, "one airway episode should produce one consolidated alert");
assert.match(unavailableAnaphylaxisGate.redFlags[0], /过敏反应.*气道/);
cases += 1;

const pediatricNonDoseState = {
  ...semanticReadyBase,
  patient: { sex: "男", age: 8 },
  chiefComplaint: "食欲不振反复1月。",
  prescription: "<!-- CDSS_NON_DOSE_PRESCRIPTION -->\n当前未配置儿童剂量级处方规则。",
  clinicalFacts: checkedEmptyFacts,
};
const nonDoseRisk = buildDeterministicRiskFollowup(pediatricNonDoseState);
assert.match(nonDoseRisk, /本轮未生成剂量级处方/);
assert.match(nonDoseRisk, /非药物与继续评估/);
assert.match(nonDoseRisk, /补足后.*重新进行辨证与处方级安全评估/s);
assert.doesNotMatch(nonDoseRisk, /处方可作为候选方案审阅|用药依从性|服法与禁忌|续方|减量|ADR|服药后随访/);
cases += 1;

const structuredDoseRisk = buildDeterministicRiskFollowup({
  ...semanticReadyBase,
  clinicalFacts: checkedEmptyFacts,
  reasoningPrescribe: {
    formula: {
      candidates: [{
        herbs: [{ name: "茯苓", dose: "10g" }],
        decoction: { followUpNode: "5天后复诊" },
      }],
    },
  },
});
assert.doesNotMatch(structuredDoseRisk, /本轮未生成剂量级处方/);
assert.match(structuredDoseRisk, /处方剂量|5天后复诊/);
cases += 1;

const restrictedStructuredDoseRisk = buildDeterministicRiskFollowup({
  ...unavailableSemanticState,
  reasoningPrescribe: {
    formula: {
      candidates: [{
        herbs: [{ name: "茯苓", dose: "10g" }],
        decoction: { followUpNode: "5天后复诊" },
      }],
    },
  },
});
assert.match(restrictedStructuredDoseRisk, /语义红旗筛查未完成.*不阻断候选方案展示/s);
assert.match(restrictedStructuredDoseRisk, /处方可作为候选方案审阅/);
assert.doesNotMatch(restrictedStructuredDoseRisk, /不得采纳、执行或转写|受限状态/);
cases += 1;

// ===== 类别矩阵：陈旧脑梗/后遗症 vs 旧卒中基础上的新发急性事件 =====
// 纯残留/后遗症基线（含“遗留…可…”功能基线）：不得报急性神经红旗。
const postStrokeResidualScenarios = [
  "中风后遗左侧肢体无力",
  "半年前脑梗，遗留左肢力弱，可扶行。",
  "半年前脑梗，遗留左侧肢体无力，可扶行。",
  "陈旧性脑梗，遗留右侧肢体无力，可独立行走。",
  "脑梗后遗症期，右侧肢体无力，扶持下可行走。",
  "既往脑梗，遗留右侧肢体无力。",
  "数年前脑出血，遗留言语不清，目前交流可。",
  "脑卒中后遗留左侧肢体麻木，可扶行。",
];
for (const scenario of postStrokeResidualScenarios) {
  for (const variant of variants(scenario)) {
    for (const placement of ["chief", "history", "conversation"]) {
      const gate = evaluateSafetyGate(stateWith(variant, placement));
      assert.notEqual(gate.status, "red_flag", `${placement}: ${variant}`);
      assert.equal(gate.redFlags.length, 0, `${placement}: ${variant}`);
      cases += 1;
    }
  }
}

// 旧卒中 + 新发/突发/加重：急性线索必须仍然触发红旗（不被既往/陈旧框架压住）。
const oldStrokeNewAcuteScenarios = [
  "半年前脑梗，今突发右侧肢体无力。",
  "陈旧性脑梗，今晨再发言语不清。",
  "脑梗后遗症期，近2日右侧肢体无力明显加重。",
  "中风后遗留左侧肢体无力，今日突然加重。",
  "数年前脑出血，刚刚出现口角歪斜。",
  "脑卒中后遗留左侧肢体麻木，昨日加重。",
];
for (const scenario of oldStrokeNewAcuteScenarios) {
  for (const variant of variants(scenario)) {
    for (const placement of ["chief", "history", "conversation"]) {
      const gate = evaluateSafetyGate(stateWith(variant, placement));
      assert.equal(gate.status, "red_flag", `${placement}: ${variant}`);
      assert.match(gate.redFlags.join("、"), /神经系统急症/, `${placement}: ${variant}`);
      cases += 1;
    }
  }
}

// 含混表述（有卒中锚点但无残留标记、也无急性线索）：按 fail-closed 保守报警。
const ambiguousPostStrokeScenarios = [
  "陈旧性脑梗，右侧肢体无力。",
  "脑梗后右侧肢体无力。",
  "半年前脑梗，目前右侧肢体无力。",
];
for (const scenario of ambiguousPostStrokeScenarios) {
  for (const variant of variants(scenario)) {
    for (const placement of ["chief", "history", "conversation"]) {
      assert.equal(evaluateSafetyGate(stateWith(variant, placement)).status, "red_flag", `${placement}: ${variant}`);
      cases += 1;
    }
  }
}

// ===== 类别矩阵：非法生命体征必须进入 missingItems 并给出重录范围/格式 =====
for (const { vitals, expected } of [
  { vitals: { SpO2: "999%" }, expected: /血氧.*数值异常\(999%\).*50-100%/ },
  { vitals: { SpO2: "999" }, expected: /血氧.*数值异常\(999%\).*50-100%/ },
  { vitals: { spo2: "45%" }, expected: /血氧.*数值异常\(45%\).*50-100%/ },
  { vitals: { BP: "abc" }, expected: /血压.*无法识别为有效数值\(abc\).*重新录入/ },
  { vitals: { T: "60℃" }, expected: /体温数值异常\(60℃\).*30-45℃/ },
  { vitals: { HR: "0" }, expected: /脉搏\/心率数值异常\(0\).*20-250次\/分/ },
  { vitals: { HR: 0 }, expected: /脉搏\/心率数值异常\(0\).*20-250次\/分/ },
  { vitals: { P: "300次/分" }, expected: /脉搏\/心率数值异常\(300次\/分\).*20-250次\/分/ },
  { vitals: { R: "0次/分" }, expected: /呼吸数值异常\(0次\/分\).*5-60次\/分/ },
  { vitals: { R: "70次/分" }, expected: /呼吸数值异常\(70次\/分\).*5-60次\/分/ },
]) {
  const gate = evaluateSafetyGate({
    ...semanticReadyBase,
    vitals,
    clinicalFacts: checkedEmptyFacts,
  });
  assert.equal(gate.status, "needs_information", `${JSON.stringify(vitals)}: invalid vital must request re-entry, not silently pass or fake a critical value`);
  assert.equal(gate.redFlags.length, 0, `${JSON.stringify(vitals)}: invalid vital must not become a clinical red flag`);
  assert.equal(gate.allowDosePrescription, false, `${JSON.stringify(vitals)}: invalid vital must lock dose-level output`);
  assert.match(gate.missingItems.join("、"), expected, `${JSON.stringify(vitals)}: missingItems must name the vital, the offending value and the required range/format`);
  cases += 1;
}

// 有效但异常的生命体征仍按原阈值产生危急红旗，而不是格式错误。
for (const { vitals, expected } of [
  { vitals: { SpO2: "88%" }, expected: /血氧饱和度 88%/ },
  { vitals: { T: "40.1℃" }, expected: /体温 40\.1℃/ },
  { vitals: { P: "150次\/分" }, expected: /心率\/脉搏 150次\/分/ },
  { vitals: { R: "35次\/分" }, expected: /呼吸 35次\/分/ },
]) {
  const gate = evaluateSafetyGate({
    ...semanticReadyBase,
    vitals,
    clinicalFacts: checkedEmptyFacts,
  });
  assert.equal(gate.status, "red_flag", `${JSON.stringify(vitals)}: valid abnormal vital remains a deterministic emergency floor`);
  assert.match(gate.redFlags.join("、"), expected, JSON.stringify(vitals));
  assert.doesNotMatch(gate.missingItems.join("、"), /数值异常|无法识别为有效数值/, `${JSON.stringify(vitals)}: valid abnormal vital must not be mislabeled as a format error`);
  cases += 1;
}

// fail-closed：非法值不得清除同病历中真实存在的危急值；二者需同时呈现。
const invalidPlusCriticalGate = evaluateSafetyGate({
  ...semanticReadyBase,
  vitals: { SpO2: "999%", P: "150次/分" },
  clinicalFacts: checkedEmptyFacts,
});
assert.equal(invalidPlusCriticalGate.status, "red_flag", "an invalid SpO2 must not clear a coexisting critical pulse");
assert.match(invalidPlusCriticalGate.redFlags.join("、"), /心率\/脉搏 150次\/分/);
assert.match(invalidPlusCriticalGate.missingItems.join("、"), /血氧.*50-100%/);
cases += 1;

// 叙述文本中的非法血氧（<50% 生理不可达）同样进入 missingItems 而非危急红旗。
for (const placement of ["chief", "history", "conversation"]) {
  const gate = evaluateSafetyGate(stateWith("SpO2 45%", placement));
  assert.notEqual(gate.status, "red_flag", `${placement}: SpO2 45%`);
  assert.equal(gate.redFlags.length, 0, `${placement}: SpO2 45%`);
  assert.match(gate.missingItems.join("、"), /血氧.*数值异常\(45%\).*50-100%/, `${placement}: SpO2 45%`);
  cases += 1;
}

// ===== 类别矩阵：劳力性慢性稳定型胸痛 vs 慢性背景上的急性冠脉事件 =====
// 纯劳力性慢性稳定（劳力诱发 + 慢性病程/规律服药/控制稳定，无急性线索）：不报急性红旗。
const chronicStableExertionalChestScenarios = [
  "冠心病稳定型心绞痛;劳力性胸痛2年,规律服药,本次就诊开药",
  "活动后胸闷3年，规律服药，控制稳定。",
  "劳力性胸痛5年，平素规律服药，病情同前。",
  "爬楼后胸闷2年，控制稳定，无变化。",
];
for (const scenario of chronicStableExertionalChestScenarios) {
  for (const variant of variants(scenario)) {
    for (const placement of ["chief", "history", "conversation"]) {
      const gate = evaluateSafetyGate(stateWith(variant, placement));
      assert.notEqual(gate.status, "red_flag", `${placement}: ${variant}`);
      assert.equal(gate.redFlags.length, 0, `${placement}: ${variant}`);
      cases += 1;
    }
  }
}

// 慢性心绞痛背景 + 急性变化线索（静息/夜间发作、突发、进行性加重、不缓解）：必须报警。
const chronicAnginaWithAcuteCueScenarios = [
  "劳力性胸痛2年，今晨静息下突发持续胸痛不缓解。",
  "活动后胸闷3年，近1周明显加重。",
  "冠心病稳定型心绞痛，劳力性胸痛2年，昨夜静息时胸痛频发不缓解。",
  "劳力性胸痛5年，规律服药，今日突发胸痛伴大汗。",
];
for (const scenario of chronicAnginaWithAcuteCueScenarios) {
  for (const variant of variants(scenario)) {
    for (const placement of ["chief", "history", "conversation"]) {
      const gate = evaluateSafetyGate(stateWith(variant, placement));
      assert.equal(gate.status, "red_flag", `${placement}: ${variant}`);
      assert.match(gate.redFlags.join("、"), /心血管/, `${placement}: ${variant}`);
      cases += 1;
    }
  }
}

// 含混表述（无劳力框架、或劳力限定但无病程/稳定性锚点）：按 fail-closed 保守报警。
const ambiguousExertionalChestScenarios = [
  "胸痛持续2周。",
  "活动后胸痛。",
  "胸闷2年，近日再发。",
];
for (const scenario of ambiguousExertionalChestScenarios) {
  for (const variant of variants(scenario)) {
    for (const placement of ["chief", "history", "conversation"]) {
      assert.equal(evaluateSafetyGate(stateWith(variant, placement)).status, "red_flag", `${placement}: ${variant}`);
      cases += 1;
    }
  }
}

// ===== 类别矩阵：口语裸“没”否定不得被误读为阳性（S01 类） =====
// “没胸痛晕倒”是否定；裸“没”不是“没有”以外的修饰。固定搭配（没精神/没胃口）不算否定。
const bareMeiNegatedScenarios = [
  "每周大概五晚，容易心慌但没胸痛晕倒；未孕，没吃安眠药。",
  "入睡困难两个月，没胸痛没晕倒，第二天没精神。",
  "心慌但没胸闷胸痛，也没晕过去，胃口一般。",
];
for (const scenario of bareMeiNegatedScenarios) {
  for (const variant of variants(scenario)) {
    for (const placement of ["chief", "history", "conversation"]) {
      const gate = evaluateSafetyGate(stateWith(variant, placement));
      assert.notEqual(gate.status, "red_flag", `${placement}: ${variant}`);
      assert.equal(gate.redFlags.length, 0, `${placement}: ${variant}`);
      cases += 1;
    }
  }
}
// 对照：非否定语境下“没”不影响真实阳性判定；“没缓解”类动词搭配不吞掉后续阳性事实。
for (const scenario of [
  "每周大概五晚，容易心慌，今晨突发胸痛。",
  "胸痛没缓解，黑便2次。",
]) {
  for (const placement of ["chief", "history", "conversation"]) {
    assert.equal(evaluateSafetyGate(stateWith(scenario, placement)).status, "red_flag", `${placement}: ${scenario}`);
    cases += 1;
  }
}

// ===== 类别矩阵：腹膜刺激征口语表达与“肚子疼”类主诉必须命中急腹症（RF05 类） =====
const acuteAbdomenPeritonitisScenarios = [
  "右下肚子有点疼，走路不太舒服。疼痛很快加重，已经吐了两次；现在发热38.6℃，按下去松手更疼。",
  "腹痛3小时，按压后松手更疼。",
  "肚子疼，突然加重，挺不住了。",
  "左下腹痛半天，一按就疼，松手时更疼。",
];
for (const scenario of acuteAbdomenPeritonitisScenarios) {
  for (const variant of variants(scenario)) {
    for (const placement of ["chief", "history", "conversation"]) {
      const gate = evaluateSafetyGate(stateWith(variant, placement));
      assert.equal(gate.status, "red_flag", `${placement}: ${variant}`);
      assert.match(gate.redFlags.join("、"), /急腹症/, `${placement}: ${variant}`);
      cases += 1;
    }
  }
}
for (const scenario of [
  "右下腹痛，按下去松手不疼。",
  "腹痛3天，无反跳痛，按压后松手也不疼。",
  "否认呕吐，腹痛持续加重。",
  "否认恶心，腹胀持续加重。",
]) {
  for (const placement of ["chief", "history", "conversation"]) {
    const gate = evaluateSafetyGate(stateWith(scenario, placement));
    assert.notEqual(gate.status, "red_flag", `${placement}: ${scenario}`);
    assert.doesNotMatch(gate.redFlags.join("、"), /急腹症/, `${placement}: ${scenario}`);
    cases += 1;
  }
}
for (const scenario of ["否认呕吐，腹痛持续加重。", "否认恶心，腹胀持续加重。"]) {
  for (const placement of ["chief", "history", "conversation"]) {
    assert.match(narrativeFallbackAdvisories(stateWith(scenario, placement)).join("、"), /腹痛|腹胀|腹部/, `${placement}: ${scenario}`);
    cases += 1;
  }
}

// ===== 类别矩阵：红旗限定 M03 首屏必须含显性紧急行动（RF04 类） =====
const { evaluateRedFlagContract } = await import("./lib/primary-care-sparse-50-contracts.mjs");
for (const scenario of [
  "突然喘不上气，嘴唇有点发紫，血氧88%。",
  "2小时前突发压榨性胸痛，伴大汗。",
]) {
  for (const placement of ["chief", "history"]) {
    const state = stateWith(scenario, placement);
    const gate = evaluateSafetyGate(state);
    assert.equal(gate.status, "red_flag", `${placement}: ${scenario}`);
    const content = renderSafetyLimitedDiagnosisContract(state, gate, buildSafetyLimitedDiagnosisReasoning(state, gate));
    const contract = evaluateRedFlagContract(content, { diagnosisMayContinue: true });
    assert.ok(contract.ok, `${placement}: ${scenario} => ${contract.errors.join("、")}`);
    assert.ok(contract.hasImmediateWarning && contract.hasUrgentAction, `${placement}: ${scenario}`);
    assert.match(contract.firstScreen, /立即[^。；\n]{0,40}(?:急诊|120)/, `${placement}: ${scenario}`);
    cases += 1;
  }
}

console.log(JSON.stringify({ cases, failures: 0 }));
