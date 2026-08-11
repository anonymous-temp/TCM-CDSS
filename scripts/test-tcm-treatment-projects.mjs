import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

const {
  TCM_TREATMENT_PROJECTS,
  TCM_TREATMENT_PROJECT_CODES,
  TCM_SOURCE_AUTHORITY_TIERS,
  highestTcmSourceAuthorityTier,
  parseTcmTreatmentCapabilities,
  tcmRefinementAdjudication,
  tcmSourceAuthorityTier,
  tcmTreatmentAssessmentPositioningForDisplay,
  tcmTreatmentPointProvenance,
} = await import("../src/lib/tcm-treatment-projects.ts");
const {
  applyTcmTreatmentCapabilityPriority,
  buildTcmTreatmentProjectPromptContext,
  compileTcmTreatmentRecommendations,
  getTcmTreatmentProjectStatus,
} = await import("../src/lib/tcm-treatment-capabilities.server.ts");
const { normalizeCaseStateInput, normalizeReasoningV2 } = await import("../src/lib/diagnosis-types.ts");
const { synchronizeVisibleClinicalSummary } = await import("../src/lib/diagnosis-visible-summary.ts");
const { sanitizeCaseStateForModel } = await import("../src/lib/diagnosis-safety.ts");

const originalSimple = process.env.TCM_CLINIC_TREATMENT_CAPABILITIES;
const originalJson = process.env.TCM_CLINIC_TREATMENT_CAPABILITIES_JSON;
const restore = () => {
  if (originalSimple == null) delete process.env.TCM_CLINIC_TREATMENT_CAPABILITIES;
  else process.env.TCM_CLINIC_TREATMENT_CAPABILITIES = originalSimple;
  if (originalJson == null) delete process.env.TCM_CLINIC_TREATMENT_CAPABILITIES_JSON;
  else process.env.TCM_CLINIC_TREATMENT_CAPABILITIES_JSON = originalJson;
};

const evidence = { evidenceLevel: "经典理论", source: "测试夹具" };
const signature = `hmac-sha256:${"a".repeat(64)}`;
const signedM03 = ({
  tcmDiseaseName = "病名待辨",
  primarySyndrome = "证候待辨",
  overallPathogenesis = "病机待辨",
  chainPathogenesis = "病机节点待辨",
  therapyDirection = "治法待辨",
  overallTherapy = therapyDirection,
  westernPrimary = "诊断待辨",
  differentials = [],
} = {}) => ({
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "diagnose",
  contractSignatureVersion: "tcm-cdss-m03-signature-v4",
  contractSignature: signature,
  overview: {
    tcmDiseaseName,
    primarySyndrome,
    secondarySyndromes: [],
    overallPathogenesis,
    overallTherapy,
    recommendedFormulaDirection: "无",
    evidence,
  },
  westernDiagnosis: {
    primary: {
      name: westernPrimary,
      status: "考虑",
      confidence: "中",
      supportingFacts: [],
      limitations: [],
      suggestedChecks: [],
      evidence,
    },
    differentials: differentials.map((name) => ({ name, reason: "需结合临床鉴别", nextCheck: null })),
  },
  pathogenesis: {
    summary: overallPathogenesis,
    locationDifferentiation: { items: [], evidence },
    natureDifferentiation: { items: [], evidence },
    chain: [{
      nodeId: "P1",
      patientFact: "相关症状",
      syndromeEvidence: primarySyndrome,
      pathogenesis: chainPathogenesis,
      therapyDirection,
      evidence,
    }],
    uncertainties: [],
  },
  therapy: {
    overallPrinciple: overallTherapy,
    overallMethod: overallTherapy,
    subTherapies: [{ therapy: therapyDirection, targetPathogenesis: chainPathogenesis, priority: "主要", evidence }],
  },
  formula: null,
  nonPharma: null,
  lineageAdaptation: null,
});

const priors = {
  digestive: signedM03({
    tcmDiseaseName: "痞满",
    primarySyndrome: "脾胃气虚证",
    overallPathogenesis: "脾失健运，胃失和降",
    chainPathogenesis: "脾失健运",
    therapyDirection: "健脾和胃",
    westernPrimary: "功能性消化不良",
  }),
  respiratory: signedM03({
    tcmDiseaseName: "咳嗽",
    primarySyndrome: "风寒束肺证",
    overallPathogenesis: "肺失宣降",
    chainPathogenesis: "肺气不宣",
    therapyDirection: "宣肺止咳",
    westernPrimary: "支气管炎",
    differentials: ["支气管哮喘"],
  }),
  upperAirway: signedM03({
    tcmDiseaseName: "鼻鼽",
    primarySyndrome: "鼻窍功能失调证",
    overallPathogenesis: "鼻窍对环境变化反应过度，喷嚏清涕频作",
    chainPathogenesis: "鼻窍反应失调，喷嚏清涕频作",
    therapyDirection: "调护鼻窍，缓解喷嚏流涕",
    westernPrimary: "变应性鼻炎",
  }),
  pain: signedM03({
    tcmDiseaseName: "项痹",
    primarySyndrome: "经筋痹阻证",
    overallPathogenesis: "经筋不利，络脉痹阻",
    chainPathogenesis: "颈肩经筋痹阻",
    therapyDirection: "舒筋通络止痛",
    westernPrimary: "颈椎病",
  }),
  gynecology: signedM03({
    tcmDiseaseName: "痛经",
    primarySyndrome: "寒凝胞宫证",
    overallPathogenesis: "寒凝胞宫，经脉不畅",
    chainPathogenesis: "胞宫寒凝",
    therapyDirection: "温经散寒调经",
    westernPrimary: "原发性痛经",
  }),
  dermatology: signedM03({
    tcmDiseaseName: "湿疮",
    primarySyndrome: "湿热蕴肤证",
    overallPathogenesis: "湿热蕴结皮肤",
    chainPathogenesis: "湿热蕴肤",
    therapyDirection: "清热利湿止痒",
    westernPrimary: "湿疹",
  }),
  headache: signedM03({
    tcmDiseaseName: "头痛",
    primarySyndrome: "肝阳上亢证",
    overallPathogenesis: "肝阳上扰清窍",
    chainPathogenesis: "肝阳上亢，清窍受扰",
    therapyDirection: "平肝潜阳，通络止痛",
    westernPrimary: "偏头痛",
  }),
  sleepEmotion: signedM03({
    tcmDiseaseName: "不寐",
    primarySyndrome: "心神不宁证",
    overallPathogenesis: "心神失养",
    chainPathogenesis: "心神不宁",
    therapyDirection: "养心安神",
    westernPrimary: "失眠障碍",
  }),
  metabolicRehabilitation: signedM03({
    tcmDiseaseName: "肥胖",
    primarySyndrome: "痰湿内蕴证",
    overallPathogenesis: "代谢失衡，形体失养",
    chainPathogenesis: "代谢异常",
    therapyDirection: "调体重并分级康复",
    westernPrimary: "肥胖症",
  }),
  neurologicRehabilitation: signedM03({
    tcmDiseaseName: "中风后遗症",
    primarySyndrome: "气虚血瘀证",
    overallPathogenesis: "脑梗死恢复期，气虚血瘀，络脉不畅",
    chainPathogenesis: "右侧肢体无力，精细动作受限",
    therapyDirection: "益气活血，通络康复",
    westernPrimary: "脑梗死恢复期",
  }),
  dizzinessBalance: signedM03({
    tcmDiseaseName: "眩晕",
    primarySyndrome: "体位变动诱发眩晕，清窍受扰，平衡失司",
    overallPathogenesis: "体位变动时清窍受扰，平衡功能失司",
    chainPathogenesis: "体位变动时清窍受扰，平衡功能失司",
    therapyDirection: "调护清窍，助其恢复平衡",
    westernPrimary: "良性阵发性位置性眩晕（BPPV）",
  }),
  kneeOsteoarthritis: signedM03({
    tcmDiseaseName: "膝痹",
    primarySyndrome: "肝肾亏虚证",
    overallPathogenesis: "肝肾亏虚，筋骨失养",
    chainPathogenesis: "肝肾亏虚，筋骨失养",
    therapyDirection: "补益肝肾，强筋健骨",
    westernPrimary: "右膝骨关节炎",
  }),
  respiratoryWithoutNodeDomainTerms: signedM03({
    tcmDiseaseName: "咳嗽",
    primarySyndrome: "风寒束表证",
    overallPathogenesis: "外邪束表，营卫失和",
    chainPathogenesis: "外邪束表，营卫失和",
    therapyDirection: "疏风解表，调和营卫",
    westernPrimary: "急性支气管炎",
  }),
};
priors.kneeOsteoarthritis.pathogenesis.chain[0].patientFact = "屈伸不利，劳累后加重";
priors.mixedSleepAndNeckPain = signedM03({
  tcmDiseaseName: "不寐兼项痹",
  primarySyndrome: "心神不宁兼经筋痹阻证",
  overallPathogenesis: "心神失养，颈肩经筋痹阻",
  chainPathogenesis: "心神失养",
  therapyDirection: "养心安神",
  westernPrimary: "失眠障碍伴颈肩肌筋膜疼痛",
});
priors.mixedSleepAndNeckPain.pathogenesis.chain = [
  { ...priors.mixedSleepAndNeckPain.pathogenesis.chain[0], nodeId: "P1", patientFact: "入睡困难", syndromeEvidence: "心神不宁", pathogenesis: "心神失养", therapyDirection: "养心安神" },
  { ...priors.mixedSleepAndNeckPain.pathogenesis.chain[0], nodeId: "P2", patientFact: "颈肩疼痛、活动受限", syndromeEvidence: "经筋痹阻", pathogenesis: "颈肩经筋痹阻", therapyDirection: "舒筋通络止痛" },
];
priors.respiratoryWithoutNodeDomainTerms.pathogenesis.chain[0].patientFact = "恶寒发热，头身困重";
priors.influenza = signedM03({
  tcmDiseaseName: "时行感冒",
  primarySyndrome: "风热犯卫证",
  overallPathogenesis: "时邪犯卫，肺气失宣",
  chainPathogenesis: "时邪犯卫，肺气失宣",
  therapyDirection: "疏风解表，宣肺清热",
  westernPrimary: "流行性感冒",
});

const configureSimple = (codes) => {
  delete process.env.TCM_CLINIC_TREATMENT_CAPABILITIES_JSON;
  process.env.TCM_CLINIC_TREATMENT_CAPABILITIES = codes.join(",");
};
const clearConfiguration = () => {
  delete process.env.TCM_CLINIC_TREATMENT_CAPABILITIES;
  delete process.env.TCM_CLINIC_TREATMENT_CAPABILITIES_JSON;
};

let cases = 0;
const check = (_name, assertion) => {
  assertion();
  cases += 1;
};

try {
  check("example capability JSON survives dotenv parsing", () => {
    const line = readFileSync(new URL("../.env.example", import.meta.url), "utf8")
      .split(/\r?\n/)
      .find((item) => item.startsWith("TCM_CLINIC_TREATMENT_CAPABILITIES_JSON="));
    assert.ok(line);
    const value = parseEnv(line).TCM_CLINIC_TREATMENT_CAPABILITIES_JSON;
    const parsed = JSON.parse(value);
    assert.equal(parsed.schemaVersion, "tcm-cdss-clinic-treatment-capabilities-v1");
    assert.equal(parsed.items.length, 8);
  });

  check("catalog is complete", () => {
    assert.equal(TCM_TREATMENT_PROJECTS.length, 22);
    assert.equal(new Set(TCM_TREATMENT_PROJECT_CODES).size, 22);
  });

  check("medicated external projects are explicit and closed", () => {
    const expected = ["acupoint_application", "fumigation_wash", "medicated_bath", "medicated_ironing", "medicated_plaster"];
    assert.deepEqual(TCM_TREATMENT_PROJECTS.filter((item) => item.containsMedication).map((item) => item.code).sort(), expected);
    assert.deepEqual(TCM_TREATMENT_PROJECTS.filter((item) => item.requiresMedicationAudit).map((item) => item.code).sort(), expected);
  });

  check("capability parser canonicalizes aliases", () => {
    assert.deepEqual(parseTcmTreatmentCapabilities("针刺, moxibustion；未知项目"), ["acupuncture", "moxibustion"]);
  });

  check("unconfigured deployment fails closed", () => {
    clearConfiguration();
    const status = getTcmTreatmentProjectStatus();
    assert.equal(status.capabilityMode, "not_configured");
    assert.equal(status.configurationValid, false);
    assert.equal(status.reason, "not_configured");
    assert.equal(status.configuredCount, 0);
    assert.deepEqual(compileTcmTreatmentRecommendations([{ projectCode: "diet_therapy", targetRef: "P1" }], priors.digestive), []);
  });

  check("configured project status exposes only non-secret UI capability metadata", () => {
    configureSimple(["acupuncture", "auricular", "diet_therapy"]);
    const status = getTcmTreatmentProjectStatus();
    assert.deepEqual(status.items.map((item) => item.projectCode), ["acupuncture", "auricular", "diet_therapy"]);
    assert.deepEqual(Object.keys(status.items[0]).sort(), ["containsMedication", "deliveryMode", "name", "priority", "projectCode", "requiresMedicationAudit", "riskLevel"].sort());
  });

  check("invalid deployment configuration fails closed", () => {
    process.env.TCM_CLINIC_TREATMENT_CAPABILITIES_JSON = "{not-json";
    process.env.TCM_CLINIC_TREATMENT_CAPABILITIES = "acupuncture";
    const status = getTcmTreatmentProjectStatus();
    assert.equal(status.configurationValid, false);
    assert.equal(status.reason, "invalid_json");
    assert.deepEqual(compileTcmTreatmentRecommendations([{ projectCode: "acupuncture", targetRef: "P1" }], priors.digestive), []);
  });

  check("unsigned M03 cannot authorize treatment recommendations", () => {
    const unsigned = { ...priors.digestive, contractSignature: undefined };
    configureSimple(["diet_therapy"]);
    assert.deepEqual(compileTcmTreatmentRecommendations([{ projectCode: "diet_therapy", targetRef: "P1" }], unsigned), []);
  });

  check("negated differentials cannot fabricate a treatment indication", () => {
    const sleepWithNegatedNeckDifferential = signedM03({
      tcmDiseaseName: "不寐",
      primarySyndrome: "心神不宁证",
      overallPathogenesis: "心神不宁",
      chainPathogenesis: "心神不宁",
      therapyDirection: "养心安神",
      westernPrimary: "失眠障碍",
    });
    sleepWithNegatedNeckDifferential.westernDiagnosis.differentials = [{
      name: "颈椎病",
      reason: "患者否认颈肩痛，暂不支持颈椎病",
      nextCheck: null,
    }];
    configureSimple(["needle_knife"]);
    assert.deepEqual(compileTcmTreatmentRecommendations(
      [{ projectCode: "needle_knife", targetRef: "P1" }],
      sleepWithNegatedNeckDifferential,
    ), []);
  });

  check("complete signed target nodes can receive explicit model proposals", () => {
    const matrix = [
      [priors.kneeOsteoarthritis, "tuina"],
      [priors.respiratoryWithoutNodeDomainTerms, "cupping"],
    ];
    for (const [prior, projectCode] of matrix) {
      const node = prior.pathogenesis.chain[0];
      assert.ok([node.patientFact, node.syndromeEvidence, node.pathogenesis, node.therapyDirection].every(Boolean));
      configureSimple([projectCode]);
      const recommendations = compileTcmTreatmentRecommendations([{ projectCode, targetRef: "P1" }], prior);
      assert.deepEqual(recommendations.map((item) => [item.projectCode, item.targetRef]), [[projectCode, "P1"]]);
      assert.ok(recommendations.every((item) => item.executable === false && item.clinicianReviewRequired === true));
    }
  });

  check("the model may bind a configured project to any real signed M03 node", () => {
    const multiNode = structuredClone(priors.sleepEmotion);
    multiNode.pathogenesis.chain.push({
      nodeId: "P2",
      patientFact: "颈肩疼痛",
      syndromeEvidence: "活动后加重",
      pathogenesis: "颈肩经筋痹阻",
      therapyDirection: "舒筋通络止痛",
      evidence,
    });
    configureSimple(["needle_knife"]);
    assert.deepEqual(compileTcmTreatmentRecommendations(
      [{ projectCode: "needle_knife", targetRef: "P2" }],
      multiNode,
    ).map((item) => [item.projectCode, item.targetRef]), [["needle_knife", "P2"]]);
  });

  check("common clinical domains retain reasonable projects", () => {
    const matrix = [
      [priors.digestive, "diet_therapy"],
      [priors.respiratory, "qigong_daoyin"],
      [priors.upperAirway, "acupuncture"],
      [priors.pain, "tuina"],
      [priors.gynecology, "moxibustion"],
      [priors.dermatology, "medicated_bath"],
      [priors.sleepEmotion, "mind_therapy"],
      [priors.metabolicRehabilitation, "qigong_daoyin"],
      [priors.neurologicRehabilitation, "acupuncture"],
    ];
    for (const [prior, projectCode] of matrix) {
      configureSimple([projectCode]);
      const recommendations = compileTcmTreatmentRecommendations([{ projectCode, targetRef: "P1" }], prior);
      assert.equal(recommendations.some((item) => item.projectCode === projectCode), true);
    }
  });

  check("nasal and allergic upper-airway phrasing maps to personalized projects as one class", () => {
    configureSimple(["acupuncture", "moxibustion", "auricular", "qigong_daoyin"]);
    for (const phrase of ["鼻鼽", "鼻渊", "变应性鼻炎", "过敏性鼻炎", "晨起喷嚏清涕", "鼻痒流涕", "鼻鼽，肺气失宣"]) {
      const prior = signedM03({
        tcmDiseaseName: phrase,
        primarySyndrome: "鼻窍功能失调证",
        overallPathogenesis: `${phrase}，鼻窍反应失调`,
        chainPathogenesis: `${phrase}，鼻窍反应失调`,
        therapyDirection: "调护鼻窍",
        westernPrimary: phrase,
      });
      const codes = compileTcmTreatmentRecommendations([], prior).map((item) => item.projectCode);
      assert.deepEqual(codes, ["acupuncture", "moxibustion"]);
      assert.equal(codes.includes("qigong_daoyin"), false, "upper-airway cases must not inherit lower-airway exercise ranking");
    }
  });

  check("a high-confidence signed diagnosis gets a bounded deterministic backstop when the model omits projects", () => {
    configureSimple(["diet_therapy", "auricular", "acupuncture", "tuina"]);
    const recommendations = compileTcmTreatmentRecommendations([], priors.digestive);
    assert.deepEqual(recommendations.map((item) => item.projectCode), ["diet_therapy", "auricular"]);
    assert.ok(recommendations.every((item) => item.executable === false && item.clinicianReviewRequired === true));
  });

  check("digestive symptom and pathogenesis synonyms cannot make the deterministic backstop disappear", () => {
    configureSimple(["acupuncture", "moxibustion", "tuina", "auricular", "diet_therapy"]);
    for (const [tcmDiseaseName, westernPrimary, overallPathogenesis, patientFact] of [
      ["嗳气", "餐后不适综合征", "胃失和降，气机不畅，上逆为嗳气，中滞为脘胀", "吃完饭肚子上边胀，老打嗝"],
      ["胃脘痛", "功能性消化不良", "胃失通降，餐后饱胀", "饭后半小时上腹部胀"],
    ]) {
      const prior = signedM03({
        tcmDiseaseName,
        primarySyndrome: "胃气上逆证",
        overallPathogenesis,
        chainPathogenesis: overallPathogenesis,
        therapyDirection: "理气和胃，降逆消胀",
        westernPrimary,
      });
      prior.pathogenesis.chain[0].patientFact = patientFact;
      assert.deepEqual(
        compileTcmTreatmentRecommendations([], prior, { patient: { age: 43, sex: "男" }, chiefComplaint: patientFact, symptoms: {}, conversation: [] })
          .map((item) => item.projectCode),
        ["diet_therapy", "auricular"],
      );
    }
  });

  check("neutral signed wording falls back to current affirmed respiratory facts", () => {
    configureSimple(["qigong_daoyin", "moxibustion", "cupping"]);
    const neutralPrior = signedM03({
      tcmDiseaseName: "胸中不适待辨",
      primarySyndrome: "胸中气机不畅证",
      overallPathogenesis: "胸中气机运行失调",
      chainPathogenesis: "胸中气机运行失调",
      therapyDirection: "调畅胸中气机",
      westernPrimary: "活动相关症状",
    });
    neutralPrior.pathogenesis.chain[0].patientFact = "一跑快了就胸口呼呼响，晚上有时憋醒";
    const caseState = {
      patient: { age: 41 },
      chiefComplaint: "跑快后胸口呼呼响半年",
      symptoms: { presentHistory: "近来晚上有时憋醒" },
      conversation: [],
    };
    assert.deepEqual(
      compileTcmTreatmentRecommendations([], neutralPrior, caseState).map((item) => item.projectCode),
      ["qigong_daoyin", "moxibustion"],
    );
  });

  check("neck stiffness location variants receive musculoskeletal projects when pain wording is absent", () => {
    configureSimple(["tuina", "acupuncture", "cupping", "diet_therapy"]);
    const neckStiffnessPrior = signedM03({
      tcmDiseaseName: "项痹",
      primarySyndrome: "气滞血瘀，经络不利",
      overallPathogenesis: "长期低头劳损，颈部经脉气血运行不畅",
      chainPathogenesis: "颈部经脉劳损，气滞血瘀，经络不利",
      therapyDirection: "行气活血，舒筋通络",
      westernPrimary: "颈肌劳损",
    });
    neckStiffnessPrior.pathogenesis.chain[0].patientFact = "低头看手机多，脖子僵，后脑勺也紧";
    const recommendations = compileTcmTreatmentRecommendations([], neckStiffnessPrior, {
      patient: { age: 39, sex: "男" },
      chiefComplaint: "低头看手机多，脖子僵，后脑勺也紧",
      symptoms: { presentHistory: "反复两个月" },
      conversation: [],
    });
    assert.deepEqual(recommendations.map((item) => item.projectCode), ["tuina", "acupuncture"]);
    assert.ok(recommendations.every((item) => item.targetRef === "P1" && item.executable === false));
  });

  check("historical or negated respiratory text cannot activate the current-fact fallback", () => {
    configureSimple(["qigong_daoyin", "moxibustion", "cupping"]);
    const neutralPrior = signedM03({
      tcmDiseaseName: "疲劳待辨",
      primarySyndrome: "气机失调证",
      overallPathogenesis: "气机运行失调",
      chainPathogenesis: "气机运行失调",
      therapyDirection: "调畅气机",
      westernPrimary: "疲劳症状",
    });
    neutralPrior.pathogenesis.chain[0].patientFact = "近期容易疲劳";
    const historyOnly = {
      patient: { age: 41 },
      chiefComplaint: "近期容易疲劳",
      symptoms: { presentHistory: "否认咳嗽、气喘及夜间憋醒" },
      pastHistory: "既往支气管哮喘，曾有喘鸣",
      hisRecord: { fields: { jiwangshi: "既往哮喘" } },
      conversation: [{ role: "user", content: "小时候活动后喘" }],
    };
    assert.deepEqual(compileTcmTreatmentRecommendations([], neutralPrior, historyOnly), []);
  });

  check("positional vertigo receives a bounded balance-domain backstop instead of an empty project list", () => {
    configureSimple(["acupuncture", "auricular", "qigong_daoyin", "tuina"]);
    priors.dizzinessBalance.pathogenesis.chain[0].patientFact = "一翻身屋子就转，躺着不动又好点";
    const recommendations = compileTcmTreatmentRecommendations([], priors.dizzinessBalance, {
      patient: { age: 61, sex: "女" },
      chiefComplaint: "一翻身屋子就转，躺着不动又好点",
      symptoms: { presentHistory: "每次几十秒，三天了" },
      conversation: [],
    });
    assert.deepEqual(recommendations.map((item) => item.projectCode), ["acupuncture", "auricular"]);
    assert.ok(recommendations.every((item) => item.targetRef === "P1" && item.executable === false));
  });

  check("a reviewed movement-disorder presentation receives bounded non-executable adjunct projects", () => {
    configureSimple(["qigong_daoyin", "acupuncture", "tuina", "auricular"]);
    const movementPrior = signedM03({
      tcmDiseaseName: "颤证",
      primarySyndrome: "右手静止性震颤伴小写症",
      overallPathogenesis: "肢体运动调节功能受扰",
      chainPathogenesis: "右手静止时运动调节功能失常，出现不自主震颤",
      therapyDirection: "改善肢体运动调节与精细动作能力",
      westernPrimary: "帕金森病待排除",
    });
    movementPrior.pathogenesis.chain[0].patientFact = "右手闲着时会抖，写字越来越小";
    const recommendations = compileTcmTreatmentRecommendations([], movementPrior, {
      patient: { age: 65, sex: "男" },
      chiefComplaint: "右手闲着时会抖，写字越来越小",
      symptoms: { presentHistory: "快一年了" },
      conversation: [],
    });
    assert.deepEqual(recommendations.map((item) => item.projectCode), ["qigong_daoyin", "acupuncture"]);
    assert.ok(recommendations.every((item) => item.targetRef === "P1" && item.executable === false));
  });

  check("historical movement-disorder text cannot activate an unrelated current presentation", () => {
    configureSimple(["qigong_daoyin", "acupuncture"]);
    const neutralPrior = signedM03({
      tcmDiseaseName: "疲劳待辨",
      primarySyndrome: "功能状态待评估",
      overallPathogenesis: "当前功能状态有待评估",
      chainPathogenesis: "当前功能状态有待评估",
      therapyDirection: "结合现状进一步评估",
      westernPrimary: "疲劳症状",
    });
    neutralPrior.pathogenesis.chain[0].patientFact = "近期容易疲劳";
    assert.deepEqual(compileTcmTreatmentRecommendations([], neutralPrior, {
      patient: { age: 65, sex: "男" },
      chiefComplaint: "近期容易疲劳",
      symptoms: { presentHistory: "近两周工作忙后明显" },
      pastHistory: "既往帕金森病，有静止性震颤",
      conversation: [],
    }), []);
  });

  check("an invalid model project is rejected and cannot suppress safe personalized backstops", () => {
    configureSimple(["diet_therapy", "acupuncture"]);
    const recommendations = compileTcmTreatmentRecommendations(
      [{ projectCode: "needle_knife", targetRef: "P9" }],
      priors.digestive,
    );
    assert.deepEqual(recommendations.map((item) => item.projectCode), ["diet_therapy", "acupuncture"]);
  });

  check("personalized domain matrix does not collapse every case to acupuncture and tuina", () => {
    configureSimple(["acupuncture", "moxibustion", "tuina", "cupping", "guasha", "auricular", "diet_therapy", "qigong_daoyin"]);
    const matrix = [
      [priors.digestive, ["diet_therapy", "auricular"]],
      [priors.respiratory, ["qigong_daoyin", "moxibustion"]],
      [priors.upperAirway, ["acupuncture", "moxibustion"]],
      [priors.pain, ["tuina", "acupuncture"]],
      [priors.gynecology, ["moxibustion", "auricular"]],
      [priors.headache, ["auricular", "acupuncture"]],
      [priors.sleepEmotion, ["auricular", "qigong_daoyin"]],
      [priors.metabolicRehabilitation, ["diet_therapy", "qigong_daoyin"]],
      [priors.neurologicRehabilitation, ["acupuncture", "qigong_daoyin"]],
      [priors.dizzinessBalance, ["acupuncture", "auricular"]],
    ];
    const signatures = [];
    for (const [prior, expected] of matrix) {
      const codes = compileTcmTreatmentRecommendations([], prior).map((item) => item.projectCode);
      assert.deepEqual(codes, expected);
      signatures.push(codes.join("+"));
    }
    assert.ok(new Set(signatures).size >= 6, "different clinical domains must produce materially different project sets");
  });

  check("infant eczema removes routine needling and scraping before prompt and compilation", () => {
    configureSimple(["acupuncture", "guasha", "medicated_bath", "diet_therapy"]);
    const infantCase = {
      patient: { age: 0.5 },
      chiefComplaint: "婴儿湿疹反复2个月",
      symptoms: { presentHistory: "面颊和躯干湿疹伴瘙痒" },
      conversation: [],
      reasoningDiagnose: priors.dermatology,
    };
    const prompt = buildTcmTreatmentProjectPromptContext(infantCase);
    assert.doesNotMatch(prompt, /acupuncture=针刺疗法|guasha=刮痧疗法/);
    const recommendations = compileTcmTreatmentRecommendations([
      { projectCode: "acupuncture", targetRef: "P1" },
      { projectCode: "guasha", targetRef: "P1" },
      { projectCode: "medicated_bath", targetRef: "P1" },
      { projectCode: "diet_therapy", targetRef: "P1" },
    ], priors.dermatology, infantCase);
    assert.equal(recommendations.some((item) => item.projectCode === "acupuncture" || item.projectCode === "guasha"), false);
  });

  check("diabetic foot removes heat skin-trauma and invasive projects but preserves unrelated low-risk care", () => {
    configureSimple(["moxibustion", "medicated_bath", "acupuncture", "qigong_daoyin", "diet_therapy"]);
    const diabeticFootCase = {
      patient: { age: 63 },
      chiefComplaint: "糖尿病足溃疡伴足部感染",
      symptoms: {},
      conversation: [],
    };
    const recommendations = compileTcmTreatmentRecommendations([
      { projectCode: "moxibustion", targetRef: "P1" },
      { projectCode: "medicated_bath", targetRef: "P1" },
      { projectCode: "acupuncture", targetRef: "P1" },
      { projectCode: "qigong_daoyin", targetRef: "P1" },
      { projectCode: "diet_therapy", targetRef: "P1" },
    ], priors.metabolicRehabilitation, diabeticFootCase);
    assert.deepEqual(recommendations.map((item) => item.projectCode), ["diet_therapy", "qigong_daoyin"]);
  });

  check("heart failure renal impairment and acute inflammation apply project-specific exclusions", () => {
    configureSimple(["medicated_bath"]);
    assert.deepEqual(compileTcmTreatmentRecommendations(
      [{ projectCode: "medicated_bath", targetRef: "P1" }],
      priors.dermatology,
      { patient: {}, chiefComplaint: "湿疹", symptoms: {}, pastHistory: "慢性肾病4期，心力衰竭", conversation: [] },
    ), []);
    configureSimple(["tuina", "acupuncture"]);
    const inflamed = compileTcmTreatmentRecommendations(
      [{ projectCode: "tuina", targetRef: "P1" }, { projectCode: "acupuncture", targetRef: "P1" }],
      priors.pain,
      { patient: {}, chiefComplaint: "颈肩疼痛", symptoms: { presentHistory: "局部急性炎症，红肿热痛" }, conversation: [] },
    );
    assert.equal(inflamed.some((item) => item.projectCode === "tuina"), false);
  });

  check("heat-pattern polarity excludes moxibustion without suppressing unrelated care", () => {
    configureSimple(["moxibustion", "acupuncture", "diet_therapy"]);
    const heatPattern = structuredClone(priors.digestive);
    heatPattern.overview.primarySyndrome = "胃热炽盛证";
    heatPattern.overview.overallPathogenesis = "胃腑实热上扰";
    heatPattern.pathogenesis.chain[0].pathogenesis = "胃腑实热";
    const recommendations = compileTcmTreatmentRecommendations([
      { projectCode: "moxibustion", targetRef: "P1" },
      { projectCode: "acupuncture", targetRef: "P1" },
      { projectCode: "diet_therapy", targetRef: "P1" },
    ], heatPattern);
    assert.equal(recommendations.some((item) => item.projectCode === "moxibustion"), false);
    assert.ok(recommendations.some((item) => item.projectCode !== "moxibustion"));
  });

  check("negated high-risk history does not create a false treatment exclusion", () => {
    configureSimple(["medicated_bath"]);
    const recommendations = compileTcmTreatmentRecommendations(
      [{ projectCode: "medicated_bath", targetRef: "P1" }],
      priors.dermatology,
      { patient: {}, chiefComplaint: "湿疹", symptoms: {}, pastHistory: "否认心衰及肾功能不全", conversation: [] },
    );
    assert.deepEqual(recommendations.map((item) => item.projectCode), ["medicated_bath"]);
  });

  check("one valid model proposal is retained and complemented only by matched safe projects", () => {
    configureSimple(["acupuncture", "moxibustion", "diet_therapy", "needle_knife"]);
    const recommendations = compileTcmTreatmentRecommendations(
      [{ projectCode: "diet_therapy", targetRef: "P1" }],
      priors.digestive,
    );
    assert.deepEqual(recommendations.map((item) => item.projectCode), ["diet_therapy", "moxibustion", "acupuncture"]);
    assert.ok(recommendations.length <= 3);
    assert.equal(new Set(recommendations.map((item) => item.projectCode)).size, recommendations.length);
    assert.equal(recommendations.some((item) => item.projectCode === "needle_knife"), false);
  });

  check("clinical fit ranks ahead of clinic display priority", () => {
    configureSimple(["acupuncture", "moxibustion", "tuina", "cupping"]);
    const recommendations = compileTcmTreatmentRecommendations(
      [{ projectCode: "cupping", targetRef: "P1" }],
      priors.pain,
    );
    assert.deepEqual(
      recommendations.map((item) => item.projectCode),
      ["tuina", "acupuncture", "cupping"],
      "the accepted proposal remains visible but domain affinity controls ordering",
    );
  });

  check("miscellaneous treatment is never auto-recommended", () => {
    configureSimple(["miscellaneous"]);
    assert.deepEqual(compileTcmTreatmentRecommendations([], priors.sleepEmotion), []);
    assert.deepEqual(compileTcmTreatmentRecommendations(
      [{ projectCode: "miscellaneous", targetRef: "P1" }],
      priors.sleepEmotion,
    ), []);
    assert.match(buildTcmTreatmentProjectPromptContext({ reasoningDiagnose: priors.sleepEmotion }), /必须输出空数组/);
  });

  check("the compiler rejects projects that do not match the signed diagnosis", () => {
    configureSimple(["needle_knife", "diet_therapy"]);
    const recommendations = compileTcmTreatmentRecommendations([
      { projectCode: "needle_knife", targetRef: "P1" },
      { projectCode: "diet_therapy", targetRef: "P1" },
    ], priors.digestive);
    assert.deepEqual(recommendations.map((item) => item.projectCode), ["diet_therapy"]);
  });

  check("each treatment project preserves the exact real pathogenesis node selected by the model", () => {
    configureSimple(["tuina"]);
    const firstNode = compileTcmTreatmentRecommendations(
      [{ projectCode: "tuina", targetRef: "P1" }],
      priors.mixedSleepAndNeckPain,
    );
    assert.equal(firstNode.some((item) => item.projectCode === "tuina" && item.targetRef === "P1"), false, "tuina cannot be bound to the sleep-only node");
    assert.equal(firstNode.some((item) => item.projectCode === "tuina"), false, "a mismatched provider target cannot be silently rebound to another node");
    const matched = compileTcmTreatmentRecommendations(
      [{ projectCode: "tuina", targetRef: "P2" }],
      priors.mixedSleepAndNeckPain,
    );
    assert.equal(matched[0]?.targetRef, "P2");
    assert.match(matched[0]?.targetPathogenesis || "", /颈肩经筋痹阻/);
  });

  check("case capabilities only reduce deployment capabilities", () => {
    configureSimple(["acupuncture", "moxibustion"]);
    const recommendations = compileTcmTreatmentRecommendations([
      { projectCode: "moxibustion", targetRef: "P1" },
      { projectCode: "acupuncture", targetRef: "P1" },
      { projectCode: "bloodletting", targetRef: "P1" },
    ], priors.digestive, { clinicTreatmentCapabilities: ["bloodletting", "acupuncture"] });
    assert.deepEqual(recommendations.map((item) => item.projectCode), ["acupuncture"]);
    assert.equal(recommendations[0].availability, "clinic_available");
    assert.equal(recommendations[0].targetPathogenesis, "脾失健运");
  });

  check("unrestricted empty case capability list keeps deployment scope", () => {
    configureSimple(["acupuncture"]);
    const recommendations = compileTcmTreatmentRecommendations(
      [{ projectCode: "acupuncture", targetRef: "P1" }],
      priors.digestive,
      { clinicTreatmentCapabilities: [] },
    );
    assert.deepEqual(recommendations.map((item) => item.projectCode), ["acupuncture"]);
  });

  check("a project absent from deployment capabilities remains empty", () => {
    configureSimple(["mind_therapy"]);
    assert.deepEqual(compileTcmTreatmentRecommendations(
      [{ projectCode: "tuina", targetRef: "P1" }],
      priors.kneeOsteoarthritis,
    ), []);
  });

  check("restricted empty case capability list is an explicit empty subset", () => {
    configureSimple(["acupuncture"]);
    const recommendations = compileTcmTreatmentRecommendations(
      [{ projectCode: "acupuncture", targetRef: "P1" }],
      priors.digestive,
      { clinicTreatmentCapabilities: [], clinicTreatmentCapabilitiesRestricted: true },
    );
    assert.deepEqual(recommendations, []);
  });

  check("invalid case capability constraints cannot widen deployment scope", () => {
    configureSimple(["acupuncture", "moxibustion"]);
    assert.deepEqual(compileTcmTreatmentRecommendations(
      [{ projectCode: "acupuncture", targetRef: "P1" }],
      priors.digestive,
      { clinicTreatmentCapabilities: ["not-a-project"] },
    ), []);
    assert.deepEqual(compileTcmTreatmentRecommendations(
      [{ projectCode: "acupuncture", targetRef: "P1" }],
      priors.digestive,
      { clinicTreatmentCapabilities: [], clinicTreatmentCapabilitiesRestricted: true },
    ), []);
  });

  check("top-level and nested HIS capability constraints intersect fail-closed", () => {
    configureSimple(["acupuncture", "moxibustion", "cupping"]);
    const normalized = normalizeCaseStateInput({
      clinicTreatmentCapabilities: ["针刺", "艾灸"],
      hisRecord: { fields: { clinicTreatmentCapabilities: "针刺,拔罐" } },
    });
    assert.deepEqual(normalized.clinicTreatmentCapabilities, ["acupuncture"]);
    assert.equal(normalized.clinicTreatmentCapabilitiesRestricted, true);
    const invalidNested = normalizeCaseStateInput({
      hisRecord: { fields: { clinicTreatmentCapabilities: "未授权项目" } },
    });
    assert.deepEqual(invalidNested.clinicTreatmentCapabilities, []);
    assert.equal(invalidNested.clinicTreatmentCapabilitiesRestricted, true);
    const deidentified = sanitizeCaseStateForModel(invalidNested);
    assert.deepEqual(deidentified.clinicTreatmentCapabilities, []);
    assert.equal(deidentified.clinicTreatmentCapabilitiesRestricted, true, "the de-identified model DTO cannot reopen an explicit empty clinic scope");
    assert.deepEqual(compileTcmTreatmentRecommendations(
      [{ projectCode: "acupuncture", targetRef: "P1" }],
      priors.digestive,
      invalidNested,
    ), []);
  });

  check("specialist projects remain assessment-only without approval", () => {
    process.env.TCM_CLINIC_TREATMENT_CAPABILITIES_JSON = JSON.stringify({
      schemaVersion: "tcm-cdss-clinic-treatment-capabilities-v1",
      items: [{ projectCode: "needle_knife", deliveryMode: "onsite", priority: 1, specialistApproved: false }],
    });
    delete process.env.TCM_CLINIC_TREATMENT_CAPABILITIES;
    const recommendation = compileTcmTreatmentRecommendations([{ projectCode: "needle_knife", targetRef: "P1" }], priors.pain)[0];
    assert.equal(recommendation.availability, "referral_only");
    assert.equal(recommendation.recommendationMode, "specialist_assessment_only");
    assert.equal(recommendation.executable, false);
  });

  check("approved specialist capability is still never directly executable", () => {
    process.env.TCM_CLINIC_TREATMENT_CAPABILITIES_JSON = JSON.stringify({
      schemaVersion: "tcm-cdss-clinic-treatment-capabilities-v1",
      items: [{ projectCode: "needle_knife", deliveryMode: "onsite", priority: 1, specialistApproved: true }],
    });
    const recommendation = compileTcmTreatmentRecommendations([{ projectCode: "needle_knife", targetRef: "P1" }], priors.pain)[0];
    assert.equal(recommendation.availability, "clinic_available");
    assert.equal(recommendation.recommendationMode, "specialist_assessment_only");
    assert.equal(recommendation.executable, false);
  });

  check("medicated external treatments remain audit-only assessments", () => {
    const medicationCases = [
      ["acupoint_application", priors.respiratory],
      ["medicated_plaster", priors.pain],
      ["fumigation_wash", priors.dermatology],
      ["medicated_bath", priors.dermatology],
      ["medicated_ironing", priors.digestive],
    ];
    for (const [projectCode, prior] of medicationCases) {
      configureSimple([projectCode]);
      const recommendation = compileTcmTreatmentRecommendations([{ projectCode, targetRef: "P1" }], prior)[0];
      assert.equal(recommendation.containsMedication, true);
      assert.equal(recommendation.requiresMedicationAudit, true);
      assert.equal(recommendation.executable, false);
      assert.match(recommendation.assessmentPositioning, /不生成药物配方、操作参数或疗程/);
      assert.match(recommendation.requiredChecks.join("；"), /独立用药审方/);
      assert.deepEqual(Object.keys(recommendation).filter((key) => ["formula", "dose", "temperature", "duration", "sessionPlan"].includes(key)), []);
    }
  });

  check("generic assessment positioning is omitted from display while material boundaries remain", () => {
    configureSimple(["acupuncture", "needle_knife", "acupoint_application"]);
    const ordinary = compileTcmTreatmentRecommendations([{ projectCode: "acupuncture", targetRef: "P1" }], priors.headache)[0];
    const specialist = compileTcmTreatmentRecommendations([{ projectCode: "needle_knife", targetRef: "P1" }], priors.pain).find((item) => item.projectCode === "needle_knife");
    const medicated = compileTcmTreatmentRecommendations([{ projectCode: "acupoint_application", targetRef: "P1" }], priors.respiratory).find((item) => item.projectCode === "acupoint_application");
    assert.equal(ordinary.assessmentPositioning, undefined, "ordinary onsite projects must not retain identical positioning boilerplate in structured data");
    assert.equal(tcmTreatmentAssessmentPositioningForDisplay(ordinary.assessmentPositioning), undefined);
    assert.match(tcmTreatmentAssessmentPositioningForDisplay(specialist.assessmentPositioning) || "", /专项资质/);
    assert.match(tcmTreatmentAssessmentPositioningForDisplay(medicated.assessmentPositioning) || "", /独立用药审方/);
  });

  check("only indication-matched governed templates expose points and schedules", () => {
    configureSimple(["acupuncture"]);
    const digestive = compileTcmTreatmentRecommendations(
      [{ projectCode: "acupuncture", targetRef: "P1" }],
      priors.digestive,
    )[0];
    const sleep = compileTcmTreatmentRecommendations(
      [{ projectCode: "acupuncture", targetRef: "P1" }],
      priors.sleepEmotion,
    )[0];
    const influenza = compileTcmTreatmentRecommendations(
      [{ projectCode: "acupuncture", targetRef: "P1" }],
      priors.influenza,
    )[0];
    const dermatology = compileTcmTreatmentRecommendations(
      [{ projectCode: "acupuncture", targetRef: "P1" }],
      priors.dermatology,
    )[0];
    for (const recommendation of [digestive, sleep, influenza, dermatology]) {
      assert.ok(recommendation.treatmentContent.length > 20);
      // 操作边界只在**有治理模板**时才有内容可写。评估态原先塞的是 parameterPolicy——
      // 目录里每个项目一字不差的「仅在病例文字命中模板适应证且通过红旗、资质和禁忌复核时
      // 可显示治理过的穴位/部位与频次」，讲的是系统显示规则，不是这位病人的操作边界。
      // 甲方 2026-08-10 明确要求这类系统自述不得出现在医生面前，故评估态置空。
      if (["governed_patient_specific_plan", "governed_class_template_not_syndrome_tailored"].includes(recommendation.protocolStatus)) {
        assert.ok(recommendation.techniqueBoundary.length > 10);
      }
      // 内部治理话术一律不得出现在任何医生可见字段上。
      for (const [field, value] of Object.entries({
        treatmentContent: recommendation.treatmentContent,
        techniqueBoundary: recommendation.techniqueBoundary,
        scheduleSuggestion: recommendation.scheduleSuggestion,
        suggestedSitesOrPoints: recommendation.suggestedSitesOrPoints.join("；"),
      })) {
        assert.doesNotMatch(
          String(value || ""),
          /(?:仅在病例文字命中模板适应证|不得跨适应证套用|目录存在该项目的其他适应证模板|目录中暂无与本例对应|当前目录缺少)/,
          `${field} 出现了系统自述而非临床内容：${value}`,
        );
      }
    }
    // 穴名后内联标注 T12 目录的国标代码与归经（神门→神门（HT7·手少阴心经）），
    // 让 399 穴目录真正到达医生界面；核验不到的穴名保持裸名，二者一眼可分。
    assert.match(digestive.suggestedSitesOrPoints.join("；"), /中脘.*天枢.*足三里/);
    assert.match(digestive.suggestedSitesOrPoints.join("；"), /中脘（(?:RN|CV)12/,
      "受控穴位必须带国标代码标注，否则 399 穴目录仍未到达医生");
    assert.ok(
      digestive.suggestedSitesOrPoints.some((site) => /（[A-Z]{2}\d+/.test(site)),
      `至少一个穴位应被 T12 目录核验并标注：${digestive.suggestedSitesOrPoints.join("、")}`,
    );
    assert.match(digestive.scheduleSuggestion, /每日1次/);
    // 甲方 2026-08-10 ⑪：治理态一分为二。命中病种模板但**本例已签名证候没有对应的证型加减**时，
    // 只能标 governed_class_template_not_syndrome_tailored——此前一律标「个体化方案」，
    // 而实测四组八例（风寒/风热、心脾两虚/肝火扰心、湿热中阻/脾胃虚寒、寒湿/湿热）穴位逐字相同。
    assert.equal(digestive.protocolStatus, "governed_class_template_not_syndrome_tailored");
    assert.equal(digestive.protocolGap, "syndrome_refinement_not_matched");
    // 关元只属于虚寒类加减：本夹具证候未命中任何加减，主穴里不得出现它
    //（此前它带着「（须结合寒热虚实复核）」的括注出现在每一个消化类病例上，包括湿热证）。
    assert.doesNotMatch(digestive.suggestedSitesOrPoints.join("；"), /关元/);
    assert.equal(digestive.executable, false);
    // 甲方评测(2026-08-03) 9.1：评估态项目也要给医生看得见的常用穴位——聚合该项目全部治理模板的
    // 高频穴位(≤5)作为**通用参考**；protocolStatus 仍为 assessment_only、无 schedule，
    // 呈现层按该状态标注「未按本例适应证核定」。治理边界(不生成患者级操作方案)不变。
    assert.ok(
      dermatology.suggestedSitesOrPoints.length > 0 && dermatology.suggestedSitesOrPoints.length <= 5,
      `评估态针刺项目应给出≤5个通用参考穴位：${dermatology.suggestedSitesOrPoints.join("、")}`,
    );
    assert.equal(dermatology.scheduleSuggestion, "");
    assert.equal(dermatology.protocolStatus, "assessment_only_no_patient_specific_protocol");
    // protocolGap 2026-08-10 从「给医生看的句子」降级为**内部状态码**：原先两句
    // （「目录存在该项目的其他适应证模板，但与本例适应证不符…」）讲的是系统目录，
    // 不是这位病人的临床边界，甲方明确要求不得出现在医生面前。呈现层改看 protocolStatus。
    assert.match(dermatology.protocolGap, /^catalog_(?:indication_mismatch|protocol_absent)$/);
    assert.doesNotMatch(dermatology.protocolGap, /[一-龥]/, "内部状态码不得是中文句子");
    assert.match(sleep.suggestedSitesOrPoints.join("；"), /安眠.*神门.*内关.*心俞/);
    assert.equal(sleep.protocolStatus, "governed_class_template_not_syndrome_tailored");
    assert.match(sleep.scheduleSuggestion, /每日1次/);
    assert.equal(sleep.executable, false, "governed parameters remain advisory until clinician review");
    assert.match(sleep.protocolSource, /SRC-BEIJING-TCM-DOUBLE-HEART/);
    assert.match(sleep.protocolSource, /SRC-ZIBO-TCM-DAY-FREQUENCY-2022/);
    assert.match(influenza.suggestedSitesOrPoints.join("；"), /列缺.*合谷.*风池.*太阳.*外关/);
    assert.equal(influenza.protocolStatus, "governed_class_template_not_syndrome_tailored");
    assert.equal(influenza.scheduleSuggestion, "每日1次，每次30分钟。");
    assert.equal(influenza.executable, false, "governed parameters remain advisory until clinician review");
    assert.match(influenza.protocolSource, /SRC-HUNAN-INFLUENZA-TCM-2025/);
  });

  check("prompt exposes the configured catalog and asks the LLM to judge semantics", () => {
    configureSimple(["acupoint_application", "needle_knife", "diet_therapy"]);
    const context = buildTcmTreatmentProjectPromptContext({ reasoningDiagnose: priors.respiratory });
    assert.match(context, /acupoint_application=敷贴/);
    assert.match(context, /含药外治，仅作审方评估/);
    assert.doesNotMatch(context, /needle_knife=针刀/, "an unrelated specialist procedure must not be offered for a respiratory case");
    assert.match(context, /diet_therapy=食疗法/, "respiratory dietary care remains a reasonable low-risk clinic option");
    assert.match(context, /模型只输出确有临床理由的 projectCode/);
  });

  check("prompt fails closed without signed M03", () => {
    configureSimple(["acupuncture"]);
    assert.match(buildTcmTreatmentProjectPromptContext(), /tcmTreatments 必须输出空数组/);
  });

  check("compiled output strips model-supplied procedure parameters", () => {
    configureSimple(["acupoint_application"]);
    const rawReasoning = {
      ...priors.respiratory,
      stage: "prescribe",
      nonPharma: {
        diet: "清淡饮食",
        lifestyle: "规律作息",
        emotion: "调畅情志",
        acupointCare: "自拟穴位和操作参数",
        tcmTreatments: [{
          projectCode: "acupoint_application",
          targetRef: "P1",
          medicationFormula: "模型自拟外用方",
          sessionPlan: "模型自拟时长",
        }],
        monitoring: [{ metric: "咳嗽", timing: "每日", trigger: "加重时复诊" }],
      },
    };
    const content = `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(rawReasoning)}\n<!-- DIAGNOSIS_JSON_END -->`;
    const sanitized = applyTcmTreatmentCapabilityPriority(content, undefined, priors.respiratory);
    const sanitizedJson = JSON.parse(sanitized.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
    const recommendation = sanitizedJson.nonPharma.tcmTreatments[0];
    assert.equal(sanitizedJson.nonPharma.acupointCare, null);
    assert.equal(recommendation.medicationFormula, undefined);
    assert.equal(recommendation.sessionPlan, undefined);
    assert.equal(recommendation.containsMedication, true);
    assert.equal(recommendation.requiresMedicationAudit, true);
    assert.equal(recommendation.executable, false);
  });

  check("provider omission receives the same signed-diagnosis backstop used by direct compilation", () => {
    configureSimple(["acupuncture", "tuina"]);
    const rawReasoning = { ...priors.pain, stage: "prescribe", nonPharma: null };
    const content = `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(rawReasoning)}\n<!-- DIAGNOSIS_JSON_END -->`;
    const sanitized = applyTcmTreatmentCapabilityPriority(content, undefined, priors.pain);
    const sanitizedJson = JSON.parse(sanitized.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
    assert.deepEqual(sanitizedJson.nonPharma.tcmTreatments.map((item) => item.projectCode), ["tuina", "acupuncture"]);
  });

  check("a fabricated target is discarded without silently retargeting the same project", () => {
    configureSimple(["tuina"]);
    assert.deepEqual(compileTcmTreatmentRecommendations(
      [{ projectCode: "tuina", targetRef: "P9" }],
      priors.kneeOsteoarthritis,
    ), []);
  });

  // ── 我方自己编译出来的项目，必须活得过我方自己的 schema（2026-08-11）───────────────
  //
  // 这是本轮实测里最隐蔽的一条。评估态项目的 techniqueBoundary 写空串，而
  // TcmTreatmentRecommendationSchema 该字段是 min(1)：逐条隔离机制把它整条剔除，
  // 且**只在签名前的归一那一步剔**——可见正文在归一之前就渲染完了。后果是
  // 医生页面印着三个诊疗项目，签名载荷、HIS 方案与结构化卡片一个都没有，全程零信号。
  // 50 例实测：30 例页面有项目，载荷只有 14 例；甲方看到的「中医外治项目为空」就是这个。
  //
  // 判据写成全项目全分支的属性，而不是给 techniqueBoundary 补一条断言——同一形状的
  // 下一个空字段（scheduleSuggestion、protocolSource…）必须在这里就红，而不是又上线一轮。
  check("every compiled treatment project survives its own payload schema", () => {
    configureSimple([...TCM_TREATMENT_PROJECT_CODES]);
    const dropped = [];
    let compiledCount = 0;
    for (const [label, prior] of Object.entries(priors)) {
      for (const projectCode of TCM_TREATMENT_PROJECT_CODES) {
        const recommendations = compileTcmTreatmentRecommendations([{ projectCode, targetRef: "P1" }], prior);
        for (const item of recommendations) {
          compiledCount += 1;
          const normalized = normalizeReasoningV2({
            ...prior,
            stage: "prescribe",
            nonPharma: { diet: "", lifestyle: "", emotion: "", acupointCare: null, tcmTreatments: [item], precautions: [] },
          });
          if ((normalized.nonPharma?.tcmTreatments || []).length !== 1) {
            const empties = Object.entries(item)
              .filter(([, value]) => typeof value === "string" && value.trim() === "")
              .map(([key]) => key);
            dropped.push(`${label}/${item.projectCode}/${item.protocolStatus}${empties.length ? `（空字段：${empties.join("、")}）` : ""}`);
          }
        }
      }
    }
    assert.ok(compiledCount >= 20, `编译样本过小（${compiledCount}），本属性形同虚设`);
    assert.deepEqual([...new Set(dropped)], [],
      "服务端编译出的诊疗项目被自家 schema 静默剔除——页面会显示它，签名载荷与 HIS 却收不到");
  });

  // ── 逐穴来源与权威分级（2026-08-11）────────────────────────────────────────────
  //
  // 此前权威性是按**病种**说的：「不寐与痛经来自权威来源，其余为教材来源」。这个粒度不成立——
  // 同一病种下逐条不同：不寐前 4 条同时有 T/CAAM 011-2014 与教材表，「痰热内扰」「脾胃不和」
  // 只有教材表。对外按病种概括会让集成方以为整组都有学会标准背书。
  check("每条证型加减的权威等级按**规则**判定，不按病种判定", () => {
    const acupuncture = TCM_TREATMENT_PROJECTS.find((project) => project.code === "acupuncture");
    const insomnia = acupuncture.planTemplates.find((t) => t.id === "acupuncture-insomnia-government-guidance");
    assert.ok(insomnia, "夹具前提：不寐针刺模板存在");
    const tierOf = (label) => {
      const rule = insomnia.syndromeRefinements.find((r) => r.syndromeLabel === label);
      assert.ok(rule, `不寐模板缺少证型 ${label}`);
      return highestTcmSourceAuthorityTier(rule.sourceRefs);
    };
    for (const label of ["心脾两虚", "肝火扰心", "心肾不交", "心胆气虚"]) {
      assert.equal(tierOf(label), "professional_society_standard", `${label} 应有学会标准来源`);
    }
    for (const label of ["痰热内扰", "脾胃不和"]) {
      assert.equal(tierOf(label), "project_governed_source",
        `${label} 只有项目治理教材来源，不得与同病种其他条目一并说成「权威来源」`);
    }
  });

  check("目录里用到的每一个来源都在受治理来源注册表里登记了等级", () => {
    const unregistered = new Set();
    for (const project of TCM_TREATMENT_PROJECTS) {
      for (const template of project.planTemplates || []) {
        for (const ref of [...template.sourceRefs, ...(template.syndromeRefinements || []).flatMap((r) => r.sourceRefs)]) {
          if (tcmSourceAuthorityTier(ref) === "unregistered") unregistered.add(ref);
        }
      }
    }
    assert.deepEqual([...unregistered], [],
      "来源未登记等级时对外只能显示「来源未登记」，等于把分级这件事又做没了");
    assert.ok(TCM_SOURCE_AUTHORITY_TIERS.includes("project_governed_source"));
  });

  check("逐穴溯源：主穴与加减穴各自带自己的来源，不共用一个拼接字符串", () => {
    const acupuncture = TCM_TREATMENT_PROJECTS.find((project) => project.code === "acupuncture");
    const insomnia = acupuncture.planTemplates.find((t) => t.id === "acupuncture-insomnia-government-guidance");
    const rule = insomnia.syndromeRefinements.find((r) => r.syndromeLabel === "心脾两虚");
    const records = tcmTreatmentPointProvenance(insomnia, rule);
    const base = records.filter((r) => r.role === "base_point");
    const added = records.filter((r) => r.role === "syndrome_refinement");
    assert.equal(base.length, insomnia.sitesOrPoints.length, "主穴逐个成条");
    assert.equal(added.length, rule.addPoints.length, "加减穴逐个成条");
    assert.deepEqual(base[0].sourceRefs, [...insomnia.sourceRefs], "主穴来源出自病种模板");
    assert.deepEqual(added[0].sourceRefs, [...rule.sourceRefs], "加减穴来源出自证型规则");
    assert.notDeepEqual(base[0].sourceRefs, added[0].sourceRefs, "两者本来就不同源——这正是拆到穴位粒度的理由");
    for (const record of records) {
      assert.ok(TCM_SOURCE_AUTHORITY_TIERS.includes(record.authorityTier), `等级取值越界：${record.authorityTier}`);
    }
  });

  // ── 未终审条目不得冒充患者级个体化方案（2026-08-11）──────────────────────────────
  //
  // 判据写成**数据驱动的属性**而不是逐例断言：台账加一条、目录改一条，这里都仍然成立。
  check("终审台账与运行时处置严格对应：approved 才应用加穴，pending 一律降级", () => {
    configureSimple(["acupuncture"]);
    let approved = 0;
    let pending = 0;
    const acupuncture = TCM_TREATMENT_PROJECTS.find((project) => project.code === "acupuncture");
    for (const template of acupuncture.planTemplates) {
      for (const rule of template.syndromeRefinements || []) {
        const adjudication = tcmRefinementAdjudication(rule.id);
        const prior = signedM03({
          tcmDiseaseName: template.matchAny[0],
          primarySyndrome: `${rule.syndromeMatchAny[0]}证`,
          overallPathogenesis: `${template.matchAny[0]}，${rule.syndromeMatchAny[0]}`,
          chainPathogenesis: `${template.matchAny[0]}，${rule.syndromeMatchAny[0]}`,
          therapyDirection: "按证型论治",
          westernPrimary: template.matchAny[0],
        });
        const [recommendation] = compileTcmTreatmentRecommendations(
          [{ projectCode: "acupuncture", targetRef: "P1" }],
          prior,
        );
        if (!recommendation) continue;
        // 只在确实命中了本条证型加减时断言（命中判据是已签名文本逐字包含）。
        const matched = recommendation.protocolStatus === "governed_patient_specific_plan" ||
          recommendation.protocolGap === "syndrome_refinement_pending_adjudication";
        if (!matched) continue;
        const points = recommendation.suggestedSitesOrPoints.join("；");
        if (adjudication.adjudicationStatus === "approved") {
          approved += 1;
          assert.equal(recommendation.protocolStatus, "governed_patient_specific_plan", `${rule.id}: 已终审应按证型加减`);
          assert.equal(recommendation.adjudicationStatus, "approved");
        } else {
          pending += 1;
          assert.equal(recommendation.protocolStatus, "governed_class_template_not_syndrome_tailored",
            `${rule.id}: 未终审的证型加减不得标成患者级个体化方案`);
          assert.equal(recommendation.protocolGap, "syndrome_refinement_pending_adjudication");
          assert.equal(recommendation.adjudicationStatus, "pending_clinician_review");
          assert.ok(recommendation.deferredSyndromeRefinement, `${rule.id}: 未应用的证型加减必须如实下发，不得静默隐藏`);
          for (const point of rule.addPoints) {
            if (template.sitesOrPoints.includes(point)) continue;
            assert.ok(!points.includes(point), `${rule.id}: 未终审的加穴「${point}」不得出现在候选穴位里`);
          }
          // 剔除是**保守方向**：未终审也照常执行，否则「湿热证剔关元」这类安全性剔除会跟着失效。
          for (const point of rule.removePoints || []) {
            assert.ok(!points.includes(point), `${rule.id}: 剔除穴「${point}」在未终审时同样必须剔除`);
          }
        }
      }
    }
    assert.ok(approved + pending >= 8, `命中样本过小（${approved + pending}），本属性形同虚设`);
  });

  // 「一条证型加减都没命中」与「命中了但卡在终审」是两回事，出参必须分得开。
  check("未命中任何证型加减时不得写 adjudicationStatus", () => {
    configureSimple(["acupuncture"]);
    const prior = signedM03({
      tcmDiseaseName: "痞满", primarySyndrome: "证候待辨",
      overallPathogenesis: "中焦气机不利", chainPathogenesis: "中焦气机不利",
      therapyDirection: "调畅气机", westernPrimary: "功能性消化不良",
    });
    const [recommendation] = compileTcmTreatmentRecommendations([{ projectCode: "acupuncture", targetRef: "P1" }], prior);
    if (!recommendation) return;
    if (recommendation.protocolGap === "syndrome_refinement_not_matched") {
      assert.equal(recommendation.adjudicationStatus, undefined,
        "一条加减都没命中时写 pending，会让集成方以为有条目卡在终审里");
      assert.equal(recommendation.deferredSyndromeRefinement, undefined);
    }
  });

  check("台账未登记的条目按未终审处理（新录入的条目不得自动获得已核验身份）", () => {
    const unknown = tcmRefinementAdjudication("this-refinement-does-not-exist");
    assert.equal(unknown.adjudicationStatus, "pending_clinician_review");
    assert.ok(unknown.conflictNote, "未登记也要给出可展示的说明");
  });

  // 页面只能显示载荷里真实存在的内容：非法条目在投影前就被归一剔除，因此不上屏。
  check("the visible summary never renders a project the normalized payload drops", () => {
    configureSimple(["acupuncture"]);
    const [valid] = compileTcmTreatmentRecommendations([{ projectCode: "acupuncture", targetRef: "P1" }], priors.pain);
    assert.ok(valid, "夹具需要一条可编译的针刺项目");
    const broken = { ...valid, projectName: "被剔除项目", techniqueBoundary: "" };
    const content = `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify({
      ...priors.pain,
      stage: "prescribe",
      nonPharma: { diet: "", lifestyle: "", emotion: "", acupointCare: null, tcmTreatments: [broken], precautions: [] },
    })}\n<!-- DIAGNOSIS_JSON_END -->`;
    const synchronized = synchronizeVisibleClinicalSummary(content, "prescribe");
    const visible = synchronized.split("<!-- DIAGNOSIS_JSON_START -->")[0];
    assert.equal(visible.includes("被剔除项目"), false, "载荷归一会剔除的条目不得出现在医生页面上");
  });
} finally {
  restore();
}

// —— 选穴的本例绑定与词表一致性（甲方 6.1 / 9.1，2026-08-06 收尾） ——
{
  const { governedTcmTreatmentPlanTemplateForTags } = await import("../src/lib/tcm-treatment-projects.ts");
  const acupuncture = TCM_TREATMENT_PROJECTS.find((project) => project.code === "acupuncture");
  const allTags = acupuncture.indicationTags;

  // 1) 常见写法必须命中。受治理标签词表对 sleep_emotion 收了「入睡困难/多梦/易醒」，
  //    而针刺模板的 matchAny 原本只有「失眠/不寐」——同一适应证在同一张表里两种宽度，
  //    窄的那条静默失配：医生按最常见写法录入，选穴整栏消失。
  for (const text of ["患者失眠不寐", "患者入睡困难、多梦易醒", "近一月入睡困难"]) {
    const template = governedTcmTreatmentPlanTemplateForTags("acupuncture", text, allTags);
    assert.equal(template?.indicationTag, "sleep_emotion", `「${text}」未命中睡眠类选穴模板`);
    assert.ok(template.sitesOrPoints.includes("神门"), `「${text}」命中的模板穴位异常`);
  }

  // 2) **本例绑定不得被削弱**。这条钉的是一次真实的错误尝试：为提高覆盖率，曾把判据放宽成
  //    「该标签下只有一条模板时，标签命中即足够」——实测头痛病例立刻拿到中脘、天枢、足三里
  //    这套消化类穴位（标签列表里的 digestive 恰好只有一条模板）。放宽等于取消本例绑定，
  //    而本例绑定正是甲方 6.1/9.1 两轮投诉的核心。宁可不给穴位，不可给错穴位。
  const headache = governedTcmTreatmentPlanTemplateForTags("acupuncture", "患者产后头痛反复发作", allTags);
  assert.equal(headache?.indicationTag, "headache", "头痛病例必须命中头痛选穴");
  for (const wrong of ["中脘", "天枢", "足三里"]) {
    assert.ok(!headache.sitesOrPoints.includes(wrong), `头痛病例出现消化类穴位「${wrong}」`);
  }
  // 病历与任何适应证都对不上时，必须不给穴位，而不是退回某条模板。
  assert.equal(
    governedTcmTreatmentPlanTemplateForTags("acupuncture", "患者皮肤湿疹瘙痒", allTags),
    undefined,
    "适应证不匹配时必须不给穴位",
  );

  // 3) 睡眠类模板之间的**常见症状写法**必须齐平。
  //
  // 注意这里刻意**不**做「模板 matchAny 必须被受治理标签词表认出」这种全局一致性断言——
  // 那条不变式的前提是错的：matchAny 收的是病名/证型名（流感、项痹、肺脾气虚），
  // 标签词表匹配的是症状文本，两者是互补词汇而非同一判断的两份拷贝，强行对齐会误伤一大片。
  // 真正的缺陷是**同一适应证下、同类症状写法**在各模板间宽窄不一：耳穴/食疗/情志三条
  // sleep_emotion 模板都收了「入睡困难/多梦」，唯独针刺那条只有「失眠/不寐」。
  const sleepTemplates = TCM_TREATMENT_PROJECTS
    .flatMap((project) => (project.planTemplates || []).map((template) => ({ project, template })))
    .filter(({ template }) => template.indicationTag === "sleep_emotion");
  assert.ok(sleepTemplates.length >= 3, "睡眠类模板样本过少，断言无意义");
  const sleepGaps = sleepTemplates
    .filter(({ template }) => !template.matchAny.includes("入睡困难"))
    .map(({ project, template }) => `${project.code}/${template.id}`);
  assert.deepEqual(sleepGaps, [],
    `睡眠类模板缺少最常见的「入睡困难」写法，医生按常规录入将拿不到该项目的建议：${sleepGaps.join("、")}`);
}

console.log(JSON.stringify({ cases, acupointBindingChecks: 3, failures: 0 }));
