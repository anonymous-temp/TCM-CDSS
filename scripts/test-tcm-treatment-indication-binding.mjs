// 治疗项目「适应证—方案」绑定回归（甲方生产实测 2026-08-04 缺陷1）。
//
// 生产两条实证（BASE_URL=https://82.156.128.153/tcm-cdss）：
//   · fixa-d1b「头痛反复3月，加重伴失眠1周」→ 针刺卡片写着"围绕头痛症状"，
//     给的却是失眠方的安眠/神门/内关/心俞；耳穴同样写"头痛症状"配失眠方穴位。
//   · fixa-d1「产后2月余，头痛反复发作1月」→ 灸法卡片写"本例与经带与下腹症状存在项目评估关联"，
//     而本例没有任何经带或下腹症状；该适应证来自主诉里的"产后"二字。
//
// 两条同源：入选打分、卡片标注、模板选取原本是三套互不相干的判据（分别按项目亲和度、
// 项目亲和度、目录排列顺序），因此可以两两不一致，也可以说出病历里没有的症状。
// 本套件把不变量钉死：
//   A. 有治理模板时，卡片标注的适应证 == 产出穴位的那个模板的适应证；
//   B. 评估态卡片只能引用病历原文里出现过的词，不得改口成症状域名称；
//   C. 耳穴不得套用经络腧穴的国标代码与归经。
import assert from "node:assert/strict";

const {
  TCM_TREATMENT_PROJECTS,
} = await import("../src/lib/tcm-treatment-projects.ts");
const {
  compileTcmTreatmentRecommendations,
} = await import("../src/lib/tcm-treatment-capabilities.server.ts");
const { normalizeAcupointSiteName } = await import("../src/lib/tcm-acupoints.ts");

const originalSimple = process.env.TCM_CLINIC_TREATMENT_CAPABILITIES;
const originalJson = process.env.TCM_CLINIC_TREATMENT_CAPABILITIES_JSON;
const configure = (codes) => {
  delete process.env.TCM_CLINIC_TREATMENT_CAPABILITIES_JSON;
  process.env.TCM_CLINIC_TREATMENT_CAPABILITIES = codes.join(",");
};
const restore = () => {
  if (originalSimple == null) delete process.env.TCM_CLINIC_TREATMENT_CAPABILITIES;
  else process.env.TCM_CLINIC_TREATMENT_CAPABILITIES = originalSimple;
  if (originalJson == null) delete process.env.TCM_CLINIC_TREATMENT_CAPABILITIES_JSON;
  else process.env.TCM_CLINIC_TREATMENT_CAPABILITIES_JSON = originalJson;
};

const evidence = { evidenceLevel: "经典理论", source: "测试夹具" };
const signature = `hmac-sha256:${"a".repeat(64)}`;
/** 与生产同形的已签名 M03；chain 可给多个节点。 */
const signedM03 = ({ tcmDiseaseName, primarySyndrome, overallPathogenesis, therapyDirection, westernPrimary, chain }) => ({
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "diagnose",
  contractSignatureVersion: "tcm-cdss-m03-signature-v5",
  contractSignature: signature,
  overview: {
    tcmDiseaseName,
    primarySyndrome,
    secondarySyndromes: [],
    overallPathogenesis,
    overallTherapy: therapyDirection,
    recommendedFormulaDirection: "无",
    evidence,
  },
  westernDiagnosis: {
    primary: { name: westernPrimary, status: "考虑", confidence: "中", supportingFacts: [], limitations: [], suggestedChecks: [], evidence },
    differentials: [],
  },
  pathogenesis: {
    summary: overallPathogenesis,
    locationDifferentiation: { items: [], evidence },
    natureDifferentiation: { items: [], evidence },
    chain: chain.map((node, index) => ({ nodeId: `P${index + 1}`, evidence, ...node })),
    uncertainties: [],
  },
  therapy: {
    overallPrinciple: therapyDirection,
    overallMethod: therapyDirection,
    subTherapies: [{ therapy: therapyDirection, targetPathogenesis: chain[0].pathogenesis, priority: "主要", evidence }],
  },
  formula: null,
  nonPharma: null,
  lineageAdaptation: null,
});

const failures = [];
const check = (name, fn) => {
  try { fn(); } catch (error) { failures.push({ name, message: String(error?.message || error).slice(0, 600) }); }
};

/**
 * 目录里所有模板，按「穴位集合」反查它属于哪个适应证。
 *
 * 2026-08-10 起产出穴位 = 病种模板主穴（去掉证型 removePoints）+ 证型加减 addPoints，
 * 因此反查不能再按「穴位串逐字相等」，改为**产出集合必须落在该模板的治理穴位集合之内**。
 * 归一用目录自带的 normalizeAcupointSiteName，两侧同一口径（去括注、取「或」首项）。
 */
const bareSite = (site) => normalizeAcupointSiteName(String(site).replace(/（[^）]*）\s*$/, ""));
const templateGovernedSites = [];
for (const project of TCM_TREATMENT_PROJECTS) {
  for (const template of project.planTemplates) {
    const sites = new Set([
      ...template.sitesOrPoints,
      ...(template.syndromeRefinements || []).flatMap((refinement) => refinement.addPoints),
    ].map(bareSite).filter(Boolean));
    templateGovernedSites.push({ projectCode: project.code, template, sites });
  }
}
const templateForSites = (projectCode, suggested) => {
  const produced = suggested.map(bareSite).filter(Boolean);
  if (produced.length === 0) return undefined;
  return templateGovernedSites.find((entry) =>
    entry.projectCode === projectCode && produced.every((site) => entry.sites.has(site)))?.template;
};

// ── 生产实测 fixa-d1b：头痛为主诉、同一节点内伴失眠 ────────────────────────────
const headacheWithInsomnia = signedM03({
  tcmDiseaseName: "头风病",
  primarySyndrome: "肝阳上亢证",
  overallPathogenesis: "肝阳上亢，上扰清窍",
  therapyDirection: "平肝潜阳，通络止痛",
  westernPrimary: "紧张型头痛",
  chain: [{
    patientFact: "头痛反复发作3月，加重伴失眠1周",
    syndromeEvidence: "3月来头部胀痛反复发作，情绪波动或熬夜后加重，近1周入睡困难、多梦易醒、心悸",
    pathogenesis: "肝阳上亢，气血上冲，扰动清窍，故头痛",
    therapyDirection: "平肝潜阳，通络止痛",
  }],
});
const headacheCase = {
  patient: { sex: "男", age: 42 },
  chiefComplaint: "头痛反复发作3月，加重伴失眠1周",
  symptoms: { presentHistory: "3月来头部胀痛反复发作，情绪波动或熬夜后加重，近1周加重并出现入睡困难、多梦易醒、心悸，口苦咽干" },
  conversation: [],
};

check("头痛主诉不得拿到失眠方的穴位（生产 fixa-d1b 针刺=安眠/神门/内关/心俞）", () => {
  configure(["acupuncture", "auricular"]);
  const recommendations = compileTcmTreatmentRecommendations(
    [{ projectCode: "acupuncture", targetRef: "P1" }, { projectCode: "auricular", targetRef: "P1" }],
    headacheWithInsomnia,
    headacheCase,
  );
  assert.ok(recommendations.length >= 1, "头痛病例应至少给出一个项目");
  for (const item of recommendations) {
    if (!["governed_patient_specific_plan", "governed_class_template_not_syndrome_tailored"].includes(item.protocolStatus)) continue;
    const template = templateForSites(item.projectCode, item.suggestedSitesOrPoints);
    assert.ok(template, `穴位组必须能反查到目录模板：${item.projectCode} → ${item.suggestedSitesOrPoints.join("、")}`);
    assert.equal(
      template.indicationTag,
      "headache",
      `${item.projectCode} 的方案取自 ${template.indicationTag} 模板，而本例主诉是头痛：${item.suggestedSitesOrPoints.join("、")}`,
    );
  }
});

check("卡片标注的适应证必须与产出方案的模板同源（A：标注—方案不可分叉）", () => {
  configure(["acupuncture", "auricular", "diet_therapy", "moxibustion", "qigong_daoyin"]);
  const priorsUnderTest = [
    [headacheWithInsomnia, headacheCase],
    [signedM03({
      tcmDiseaseName: "不寐",
      primarySyndrome: "心脾两虚证",
      overallPathogenesis: "心脾两虚，心神失养",
      therapyDirection: "补益心脾，养心安神",
      westernPrimary: "失眠障碍",
      chain: [{
        patientFact: "入睡困难、多梦易醒2月",
        syndromeEvidence: "入睡困难，多梦易醒，心悸健忘",
        pathogenesis: "心血不足，心神失养，故不寐",
        therapyDirection: "补益心脾，养心安神",
      }],
    }), {
      patient: { sex: "女", age: 45 },
      chiefComplaint: "入睡困难、多梦易醒2月",
      symptoms: { presentHistory: "入睡困难，多梦易醒，心悸，健忘乏力" },
      conversation: [],
    }],
  ];
  for (const [prior, caseState] of priorsUnderTest) {
    for (const item of compileTcmTreatmentRecommendations([], prior, caseState)) {
      if (!["governed_patient_specific_plan", "governed_class_template_not_syndrome_tailored"].includes(item.protocolStatus)) continue;
      const template = templateForSites(item.projectCode, item.suggestedSitesOrPoints);
      assert.ok(template, `穴位组必须能反查到目录模板：${item.projectCode} → ${item.suggestedSitesOrPoints.join("、")}`);
      // 卡片正文引用的适应证名称，必须正是这个模板的适应证；用「模板匹配词出现在正文语境」反证，
      // 避免在测试里另建一张中文标签表。
      assert.ok(
        template.matchAny.some((term) => `${caseState.chiefComplaint}${JSON.stringify(caseState.symptoms)}`.includes(term)),
        `${item.projectCode} 选中的 ${template.indicationTag} 模板，其匹配词在本例病历里一个都不存在：${template.matchAny.join("、")}`,
      );
    }
  }
});

// ── 生产实测 fixa-d1：产后头痛 → 灸法「经带与下腹症状」 ───────────────────────
const postpartumHeadache = signedM03({
  tcmDiseaseName: "头风病",
  primarySyndrome: "气血两虚，清窍失养",
  overallPathogenesis: "产后气血亏虚，清窍失养",
  therapyDirection: "益气养血，充养清窍",
  westernPrimary: "产后头痛",
  chain: [{
    patientFact: "产后2月余，头痛反复发作1月",
    syndromeEvidence: "头痛反复，劳累后加重，神疲乏力，面色少华",
    pathogenesis: "产后气血亏虚，清窍失养，不荣则痛",
    therapyDirection: "益气养血，充养清窍",
  }],
});
const postpartumCase = {
  patient: { sex: "女", age: 28 },
  chiefComplaint: "产后2月余，头痛反复发作1月",
  symptoms: { presentHistory: "产后2月余，近1月头痛反复，劳累后加重，伴神疲乏力、心悸失眠、面色少华" },
  conversation: [],
};

check("评估态卡片不得写出病历里没有的症状域（生产 fixa-d1 灸法=经带与下腹症状）", () => {
  configure(["moxibustion", "acupuncture", "auricular"]);
  const recommendations = compileTcmTreatmentRecommendations([], postpartumHeadache, postpartumCase);
  const moxibustion = recommendations.find((item) => item.projectCode === "moxibustion");
  assert.ok(moxibustion, "灸法在本例仍应进入候选（产后气血亏虚适用），只是不得虚构适应证");
  assert.equal(moxibustion.protocolStatus, "assessment_only_no_patient_specific_protocol");
  assert.ok(
    !/经带|下腹/.test(moxibustion.treatmentContent),
    `灸法卡片仍在陈述本例不存在的症状域：${moxibustion.treatmentContent}`,
  );
  // 引用的必须是病历原文里真实出现过的表述。
  const quoted = [...moxibustion.treatmentContent.matchAll(/「([^」]+)」/g)].flatMap((match) => match[1].split("、"));
  assert.ok(quoted.length > 0, `评估态卡片应给出本例的依据落点：${moxibustion.treatmentContent}`);
  const caseText = `${postpartumCase.chiefComplaint}${postpartumCase.symptoms.presentHistory}`;
  for (const term of quoted) {
    assert.ok(caseText.includes(term), `卡片引用的「${term}」不在本例病历原文中`);
  }
});

check("评估态卡片引用的每个词都必须能在病历原文里逐字找到（B：整类不变量）", () => {
  configure(["moxibustion", "acupuncture", "auricular", "diet_therapy", "qigong_daoyin", "tuina", "cupping", "guasha"]);
  const scenarios = [
    [postpartumHeadache, postpartumCase],
    [headacheWithInsomnia, headacheCase],
  ];
  let assessmentCards = 0;
  for (const [prior, caseState] of scenarios) {
    // 与实现扫描的范围一致：病历里被确认的全部文本字段（主诉/现病史/既往史/用药史/过敏史/对话）。
    const caseText = [
      caseState.chiefComplaint,
      ...Object.values(caseState.symptoms || {}),
      caseState.pastHistory,
      caseState.medicationHistory,
      caseState.allergyHistory,
      ...(caseState.conversation || []).map((item) => item.content),
    ].filter((value) => typeof value === "string").join("");
    for (const item of compileTcmTreatmentRecommendations([], prior, caseState)) {
      if (item.protocolStatus !== "assessment_only_no_patient_specific_protocol") continue;
      assessmentCards += 1;
      for (const match of item.treatmentContent.matchAll(/「([^」]+)」/g)) {
        for (const term of match[1].split("、")) {
          assert.ok(caseText.includes(term), `${item.projectCode} 引用的「${term}」不在病历原文中：${item.treatmentContent}`);
        }
      }
    }
  }
  assert.ok(assessmentCards > 0, "本组场景应至少产生一张评估态卡片，否则该不变量没有被真正执行");
});

check("耳穴不得套用经络腧穴的国标代码与归经（生产 fixa-d1：神门（HT7·手少阴心经））", () => {
  configure(["auricular", "acupuncture"]);
  const insomnia = signedM03({
    tcmDiseaseName: "不寐",
    primarySyndrome: "心神不宁证",
    overallPathogenesis: "心神失养",
    therapyDirection: "养心安神",
    westernPrimary: "失眠障碍",
    chain: [{
      patientFact: "失眠、心悸2月",
      syndromeEvidence: "入睡困难，多梦易醒，心悸",
      pathogenesis: "心神失养，故不寐",
      therapyDirection: "养心安神",
    }],
  });
  const insomniaCase = {
    patient: { sex: "女", age: 45 },
    chiefComplaint: "失眠、心悸2月",
    symptoms: { presentHistory: "入睡困难，多梦易醒，心悸" },
    conversation: [],
  };
  const recommendations = compileTcmTreatmentRecommendations([], insomnia, insomniaCase);
  const auricular = recommendations.find((item) => item.projectCode === "auricular");
  assert.ok(auricular, "失眠病例应给出耳穴方案");
  assert.ok(
    auricular.suggestedSitesOrPoints.every((site) => !/（[A-Z]{2,3}-?[A-Z]{0,2}\d+/.test(site)),
    `耳穴被标上了经穴代码：${auricular.suggestedSitesOrPoints.join("、")}`,
  );
  const acupuncture = recommendations.find((item) => item.projectCode === "acupuncture");
  assert.ok(acupuncture, "失眠病例应给出针刺方案");
  assert.ok(
    acupuncture.suggestedSitesOrPoints.some((site) => /（[A-Z]{2,3}-?[A-Z]{0,2}\d+/.test(site)),
    `经穴项目仍应保留国标代码标注：${acupuncture.suggestedSitesOrPoints.join("、")}`,
  );
});

check("失眠为主诉时仍应拿到失眠方（反向锁定：修复不得把方案一律推向主诉之外）", () => {
  configure(["acupuncture"]);
  const insomnia = signedM03({
    tcmDiseaseName: "不寐",
    primarySyndrome: "心脾两虚证",
    overallPathogenesis: "心脾两虚，心神失养",
    therapyDirection: "补益心脾，养心安神",
    westernPrimary: "失眠障碍",
    chain: [{
      patientFact: "入睡困难、多梦易醒2月",
      syndromeEvidence: "入睡困难，多梦易醒",
      pathogenesis: "心血不足，心神失养，故不寐",
      therapyDirection: "养心安神",
    }],
  });
  const item = compileTcmTreatmentRecommendations([], insomnia, {
    patient: { sex: "女", age: 45 },
    chiefComplaint: "入睡困难、多梦易醒2月",
    symptoms: { presentHistory: "入睡困难，多梦易醒" },
    conversation: [],
  })[0];
  assert.equal(item.protocolStatus, "governed_patient_specific_plan");
  const template = templateForSites("acupuncture", item.suggestedSitesOrPoints);
  assert.ok(template, `穴位组必须能反查到目录模板：${item.suggestedSitesOrPoints.join("、")}`);
  assert.equal(template.indicationTag, "sleep_emotion");
});

restore();
console.log(JSON.stringify({ cases: 6, failures: failures.length }));
if (failures.length > 0) {
  console.error(JSON.stringify(failures, null, 2));
  process.exit(1);
}
