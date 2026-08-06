// HIS 对外投影的结构化字段（甲方 2026-08-05 核对件「一、接口缺失内容」）。
//
// 缺陷形态与本仓库 e96de853 那轮同源，只是换了一端：那轮是「受治理数据已在仓库、运行时从未读它」，
// 这轮是「字段已在内部契约里生成、对外投影从未投出去」。甲方读的是接口，因此判定为「无此模块」——
// 字面属实。以下六项在 ClinicalReasoningResultV2 里齐全、在 M04 sentinel 里齐全、
// 医生端也有卡片，唯独 his-scheme.ts 的 HisAiSchemePayload 一个字段都没有：
//   方义/组成逻辑/方证鉴别/经典条文、随证加减（含可替换药味）、中成药结构化子字段、
//   健康调护三段+注意事项、西医待查依据（limitations/suggestedChecks/status）、煎法细节。
//
// 本套件按「甲方能不能从出参里拿到」来断言，而不是按「内部字段存不存在」——
// 后者正是让这批缺陷躲过前几轮回归的判据。
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src` } });
const { buildHisAiSchemePayload } = await jiti.import("../src/lib/his-scheme.ts");
const { normalizeCaseStateInput } = await jiti.import("../src/lib/diagnosis-types.ts");
const { synchronizeVisibleClinicalSummary } = await jiti.import("../src/lib/diagnosis-visible-summary.ts");

const failures = [];
function check(name, fn) {
  try {
    fn();
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
  }
}

const evidence = { evidenceLevel: "kb_entry", source: "本地方剂知识库", confidence: "中" };

const diagnoseReasoning = {
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "diagnose",
  overview: {
    tcmDiseaseName: "头痛",
    primarySyndrome: "气血两虚证",
    primarySyndromeResolution: "resolved",
    primarySyndromeBasis: ["产后2月余，头痛反复发作1月", "神疲乏力、面色少华"],
    overallPathogenesis: "产后气血耗伤，脑失濡养",
    overallTherapy: "益气养血，和络止痛",
    recommendedFormulaDirection: "八珍汤加减",
    evidence,
  },
  westernDiagnosis: {
    primary: {
      name: "头痛，病因待查",
      coding: { system: "ICD-10", code: "R51.900", display: "头痛", source: "ICD-10 国家临床版" },
      status: "考虑",
      confidence: "中",
      supportingFacts: ["产后2月余，头痛反复发作1月", "神疲乏力、面色少华"],
      limitations: ["尚未取得头颅影像学检查", "未记录血压动态监测"],
      suggestedChecks: ["补充血压动态监测与神经系统查体", "必要时评估头颅影像学检查"],
      evidence,
    },
    differentials: [],
  },
  pathogenesis: {
    summary: "产后气血耗伤，清窍失养",
    locationDifferentiation: { items: ["脑"], resolution: "resolved", evidence },
    natureDifferentiation: { items: ["气虚", "血虚"], resolution: "resolved", evidence },
    chain: [{
      nodeId: "P1",
      patientFact: "神疲乏力、面色少华",
      syndromeEvidence: "气血两虚",
      pathogenesis: "气血亏虚，脑失濡养",
      therapyDirection: "益气养血",
      evidence,
    }],
    uncertainties: [],
  },
  therapy: {
    overallPrinciple: "虚则补之",
    overallMethod: "益气养血，和络止痛",
    subTherapies: [{ therapy: "益气养血", targetPathogenesis: "气血亏虚", priority: "主要", evidence }],
  },
  formula: null,
  nonPharma: null,
  lineageAdaptation: null,
};

const prescribeReasoning = {
  ...diagnoseReasoning,
  stage: "prescribe",
  formula: {
    candidates: [{
      name: "八珍汤加减",
      positioning: "首选",
      constructionType: "single_base",
      modificationStatus: "modified",
      formulaSource: { evidenceLevel: "kb_entry", source: "《正体类要》", confidence: "高" },
      therapyMatch: "益气养血",
      applicable: "气血两虚证",
      notApplicable: "实热证",
      herbs: [
        { name: "黄芪", processing: null, dose: "20g", role: "君", prescriptionRole: "补气升阳", targetPathogenesis: "气血亏虚", function: "补气", evidence },
        { name: "当归", processing: null, dose: "10g", role: "臣", prescriptionRole: "养血和络", targetPathogenesis: "气血亏虚", function: "养血", evidence },
      ],
      formulaAnalysis: "黄芪为君大补元气以生血；当归为臣养血和络，二者气血双补，共奏益气养血之功。",
      compositionLogic: [{ formulaName: "八珍汤", summary: "四君合四物，气血双补", tier: "common", sourceRefs: ["SRC-FORMULA-COMPOSITION"] }],
      discriminationPath: [{ againstFormula: "归脾汤", question: "是否以心悸健忘失眠为主症", status: "absent", sourceRef: "SRC-FORMULA-DISCRIMINATION" }],
      classicEvidence: [{
        evidenceId: "EVID-CLASSIC-001",
        citation: "《正体类要》卷下",
        anchorLevel: "chapter_paragraph",
        excerpt: "气血两虚，用八珍汤。",
        tier: "canon",
      }],
      decoction: {
        doseCount: "7剂",
        method: "每日1剂；加冷水浸泡30分钟，文火久煎；一煎40分钟、二煎30分钟；两煎合并药液约500mL；每日分2次服，饭后温服；特殊药味按药味表执行",
        course: "7日",
        followUpNode: "完成7剂后复诊",
        dosesPerDay: 1,
        administrationTimesPerDay: 2,
        soakMinutes: 30,
        decoctionTimes: 2,
        firstDecoctionMinutes: 40,
        secondDecoctionMinutes: 30,
        targetVolumeMl: 500,
        administration: "饭后温服",
      },
    }],
    patentAndWestern: [{
      type: "中成药",
      name: "八珍颗粒",
      specification: "每袋8g",
      evidenceId: "LOCAL-INST-0001",
      singleDose: "1袋",
      frequency: "每日2次",
      route: "口服",
      usageBoundary: "气血两虚证，服药期间忌生冷",
      course: "7日",
      positioning: "替代方案",
      correspondingProblem: "气血两虚所致头痛乏力",
      relationship: "与饮片方同向，不宜叠加使用",
      riskNote: "感冒发热时停用；具体用法以说明书与医师意见为准",
      evidence,
    }],
    modifications: [{
      trigger: "神疲乏力",
      triggerSource: { kind: "primary_syndrome_basis", sourceRef: "B1", sourceQuote: "神疲乏力、面色少华" },
      targetPathogenesis: "气血亏虚，脑失濡养",
      action: "加党参",
      doseOrHandling: null,
      reason: "增强补气之力，助黄芪益气生血",
      riskNote: "实际采用时请在药味工作台确定剂量，并按调整后的完整处方重新审方。",
      substitutions: [{
        replaces: "党参",
        substitute: "太子参",
        rationale: "同属补气药，党参缺货或不耐受时可同向替代",
        differenceNote: "太子参补气之力较党参平和，兼能生津，性偏凉，气虚兼阴伤者更宜；纯气虚而无阴伤者补力不及党参",
      }],
      evidence,
    }],
    medicineCandidateStatus: { status: "available", reason: "" },
  },
  nonPharma: {
    diet: "规律进食，适当增加优质蛋白与主食摄入，避免过度节食与生冷。",
    lifestyle: "保证夜间睡眠时长，日间劳作间歇休息，避免长时间低头与突然起身。",
    emotion: "产后情绪波动常见，家人应给予支持；出现持续情绪低落时及时告知医生。",
    acupointCare: null,
    tcmTreatments: [],
    precautions: [
      "头痛较前明显加重、出现喷射性呕吐或视物模糊时须立即就医。",
      "服药期间如出现皮疹、腹泻等不适，暂停用药并联系接诊医生。",
    ],
  },
};

function buildScheme(overrides = {}) {
  return buildHisAiSchemePayload(normalizeCaseStateInput({
    chiefComplaint: "产后2月余，头痛反复发作1月",
    questionRounds: 2,
    phase: "done",
    patient: { sex: "女", age: 30 },
    allergyHistory: "否认药物过敏史",
    medicationHistory: "否认长期用药",
    fields: { zhushu: "产后2月余，头痛反复发作1月", shexiang: "舌淡苔薄白", maixiang: "脉细弱" },
    vitals: { bp: "112/70", temperature: "36.5", pulse: "80", respiration: "18", spo2: "99" },
    diagnosis: "## 西医诊断倾向\n**主要诊断**：头痛，病因待查\n\n## 中医诊断概览\n**证型**：气血两虚证\n\n## 病机拆解\n**总体病机**：产后气血耗伤，脑失濡养\n\n## 治则治法\n**治则**：虚则补之\n",
    prescription: "## 中药饮片处方\n黄芪20g 当归10g\n\n## 中成药/西药候选\n八珍颗粒\n",
    riskAssessment: "## 处方安全总评\n**最高提示强度**：低\n\n## 随访管理方案\n完成7剂后复诊\n",
    reasoningDiagnose: diagnoseReasoning,
    reasoningPrescribe: prescribeReasoning,
    ...overrides,
  }));
}

const scheme = buildScheme();

// —— 甲方 I2：西医诊断的待查依据必须可分辨地对外输出 ——
check("I2 西医待查依据：limitations 与 suggestedChecks 分列且非空", () => {
  const detail = scheme.diagnoses.westernDetail;
  assert.ok(detail, "diagnoses.westernDetail 缺失");
  assert.equal(detail.name, "头痛，病因待查");
  assert.equal(detail.status, "考虑", "status 必须对外给出，否则 HIS 无法区分「考虑」与「需排除」");
  assert.ok(detail.limitations.length >= 2, "资料限制未投出");
  assert.ok(detail.suggestedChecks.length >= 2, "建议检查未投出");
  assert.notDeepEqual(detail.limitations, detail.suggestedChecks, "两类待查依据不得混为一谈");
  assert.equal(detail.icd10?.code, "R51.900", "ICD-10 编码未随主诊断下发");
});

// —— 甲方 I2.4 根因：诊断三卡的 markdown 内容不得为空 ——
check("I2.4 诊断三卡内容非空（标题改名不得让 HIS 卡片恒空）", () => {
  assert.ok(scheme.diagnoses.western[0].content.includes("头痛，病因待查"),
    `西医诊断卡为空或未含主诊断名：${JSON.stringify(scheme.diagnoses.western[0].content)}`);
  assert.ok(scheme.diagnoses.tcmPatterns[0].content.includes("气血两虚证"),
    `中医证候卡为空：${JSON.stringify(scheme.diagnoses.tcmPatterns[0].content)}`);
  assert.ok(scheme.diagnoses.mechanism[0].content.includes("产后气血耗伤"),
    `病机卡为空：${JSON.stringify(scheme.diagnoses.mechanism[0].content)}`);
  assert.ok(scheme.diagnoses.mechanism[0].content.includes("虚则补之"),
    "治则治法段未并入病机卡");
  assert.ok(scheme.prescriptions.westernOrPatent[0].content.includes("八珍颗粒"),
    `中成药卡为空：${JSON.stringify(scheme.prescriptions.westernOrPatent[0].content)}`);
});

// —— 甲方 I3：方义/组成逻辑/方证鉴别/经典条文 ——
check("I3 方义四项结构化输出，且内部枚举已中文化", () => {
  const rationale = scheme.prescriptions.formulaRationale;
  assert.ok(rationale, "prescriptions.formulaRationale 缺失");
  assert.ok(rationale.formulaAnalysis.includes("黄芪为君"), "方义分析未投出");
  assert.equal(rationale.compositionLogic[0].formulaName, "八珍汤");
  assert.equal(rationale.compositionLogic[0].tierLabel, "通行注疏", "tier 枚举必须中文化");
  assert.equal(rationale.discriminationPath[0].againstFormula, "归脾汤");
  assert.equal(rationale.discriminationPath[0].statusLabel, "本例未见", "status 枚举必须中文化");
  assert.equal(rationale.classicEvidence[0].citation, "《正体类要》卷下");
  assert.equal(rationale.classicEvidence[0].anchorLabel, "篇章段落", "anchorLevel 枚举必须中文化");
  assert.equal(rationale.classicEvidence[0].tierLabel, "经典原文");
  assert.ok(rationale.evidenceBoundary.includes("不可直接换算"),
    "经典条文必须随附呈现纪律，否则 HIS 会把古代剂量当可执行用量");
  const serialized = JSON.stringify(rationale);
  for (const leaked of ["common", "experience", "canon", "tiaowen", "chapter_paragraph", "confirmed", "absent", "unknown"]) {
    assert.ok(!new RegExp(`"${leaked}"`).test(serialized), `内部枚举 ${leaked} 泄漏到对外投影`);
  }
});

// —— 甲方 I5：随证加减 + 可替换药味 ——
check("I5 随证加减对外输出，含可替换药味及其差异说明", () => {
  const mods = scheme.prescriptions.modifications;
  assert.equal(mods.length, 1, "随证加减未投出");
  assert.equal(mods[0].action, "加党参");
  assert.equal(mods[0].doseOrHandling, null, "加减行不得携带剂量");
  assert.ok(mods[0].riskNote.includes("重新审方"), "加减必须提示重新审方");
  const sub = mods[0].substitutions[0];
  assert.ok(sub, "可替换药味未投出");
  assert.equal(sub.replaces, "党参");
  assert.equal(sub.substitute, "太子参");
  assert.ok(sub.differenceNote.length >= 10,
    "替代药必须给出与原药的差异——只给药名等于让医生自己去查，而差异正是临床上最容易出事的地方");
});

// —— 甲方 I6：中成药完整子字段（字段名按甲方文档口径 patentMedicines） ——
check("I6 中成药结构化子字段完整", () => {
  const meds = scheme.prescriptions.patentMedicines;
  assert.equal(meds.length, 1, "patentMedicines 未投出（甲方文档承诺的正是这个字段名）");
  const med = meds[0];
  assert.equal(med.name, "八珍颗粒");
  assert.equal(med.specification, "每袋8g");
  assert.equal(med.singleDose, "1袋");
  assert.equal(med.frequency, "每日2次");
  assert.equal(med.route, "口服");
  assert.ok(med.usageBoundary && med.course && med.positioning && med.correspondingProblem && med.riskNote,
    "中成药用法边界/疗程/定位/对应问题/风险说明不得缺项");
  assert.equal(med.dosageAvailable, true);
});

check("I6 西药一律不标记用法可用（剂量不由本系统下发）", () => {
  const western = buildScheme({
    reasoningPrescribe: {
      ...prescribeReasoning,
      formula: {
        ...prescribeReasoning.formula,
        patentAndWestern: [{
          ...prescribeReasoning.formula.patentAndWestern[0],
          type: "西药",
          name: "对乙酰氨基酚片",
          singleDose: "0.5g",
          frequency: "每日3次",
        }],
      },
    },
  }).prescriptions.patentMedicines[0];
  assert.equal(western.type, "西药");
  assert.equal(western.dosageAvailable, false, "西药不得标记为用法用量可用");
});

// —— 甲方 I7：健康调护 ——
check("I7 健康调护三段与注意事项对外输出", () => {
  const guidance = scheme.healthGuidance;
  assert.ok(guidance, "healthGuidance 缺失——甲方判「无此模块」字面属实");
  assert.ok(guidance.diet && guidance.lifestyle && guidance.emotion, "饮食/起居/情志三段不得缺项");
  assert.equal(guidance.precautions.length, 2, "注意事项未投出");
});

check("I7 食疗类表述在接口出口同样被净化（此前只做在客户端）", () => {
  const guidance = buildScheme({
    allergyHistory: "",
    medicationHistory: "",
    reasoningPrescribe: {
      ...prescribeReasoning,
      nonPharma: { ...prescribeReasoning.nonPharma, diet: "宜多食山楂、黑木耳以活血化瘀，配合药膳滋阴。" },
    },
  }).healthGuidance;
  assert.ok(!/活血化瘀|药膳/.test(guidance.diet),
    `食疗治疗性表述未在接口出口净化：${guidance.diet}`);
  assert.ok(guidance.diet.includes("不要把食疗替代诊疗或药物"), "净化后必须给出安全兜底表述");
});

check("I7 食疗净化必须覆盖服务端可见正文，不只是客户端与 HIS", () => {
  // 服务端可见正文由 synchronizeVisibleClinicalSummary 从 sentinel JSON 确定性渲染，
  // 它会进 caseState.prescription、HIS 处方卡片与各类导出。净化必须做在所有出口。
  const tainted = {
    ...prescribeReasoning,
    nonPharma: { ...prescribeReasoning.nonPharma, diet: "宜多食山楂、黑木耳以活血化瘀，配合药膳滋阴。" },
  };
  const content = `<!-- DIAGNOSIS_JSON_START -->${JSON.stringify(tainted)}<!-- DIAGNOSIS_JSON_END -->`;
  const rendered = synchronizeVisibleClinicalSummary(content, "prescribe", "");
  const visible = rendered.split("<!-- DIAGNOSIS_JSON_START -->")[0];
  assert.ok(/饮食/.test(visible), "可见正文未渲染饮食调护段，断言无效");
  assert.ok(!/活血化瘀|药膳/.test(visible),
    `服务端可见正文未净化食疗治疗性表述：${visible.slice(-400)}`);
  assert.ok(/不要把食疗替代诊疗或药物/.test(visible), "净化后必须给出安全兜底表述");
});

// —— 甲方 I4 + M5.3：剂数与煎服法细节 ——
check("I4 煎服法细节结构化，且不与 regimen 合同字段混淆", () => {
  const detail = scheme.prescriptions.decoctionDetail;
  assert.ok(detail, "decoctionDetail 缺失");
  assert.equal(detail.soakMinutes, 30);
  assert.equal(detail.firstDecoctionMinutes, 40);
  assert.equal(detail.secondDecoctionMinutes, 30);
  assert.equal(detail.targetVolumeMl, 500);
  assert.ok(detail.method.includes("文火久煎"), "火候档位未对外输出（补虚方与解表方煎法应不同）");
  assert.equal(scheme.prescriptions.regimen.doseCount, "7剂", "regimen 合同字段不得被改动");
});

// —— 安全边界：非剂量降级路径下，所有剂量级新字段必须一并抑制 ——
check("安全边界：非剂量降级时新增投影必须同步抑制", () => {
  const { buildSafetyLimitedPrescription } = { buildSafetyLimitedPrescription: null };
  void buildSafetyLimitedPrescription;
  const locked = buildScheme({
    vitals: { bp: "210/130", temperature: "36.5", pulse: "80", respiration: "18", spo2: "99" },
  });
  if (locked.prescriptions.herbal.length === 0) {
    assert.deepEqual(locked.prescriptions.patentMedicines, [], "降级时不得下发中成药结构化候选");
    assert.deepEqual(locked.prescriptions.modifications, [], "降级时不得下发随证加减");
    assert.equal(locked.prescriptions.formulaRationale, null, "降级时不得下发方义四项");
    assert.equal(locked.prescriptions.decoctionDetail, null, "降级时不得下发煎法细节");
  }
});

if (failures.length > 0) {
  console.error(JSON.stringify({ suite: "his-structured-projection", failures }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ suite: "his-structured-projection", checks: 11, failures: 0 }));
