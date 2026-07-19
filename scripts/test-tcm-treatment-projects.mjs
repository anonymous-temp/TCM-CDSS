import assert from "node:assert/strict";

const {
  TCM_TREATMENT_PROJECTS,
  TCM_TREATMENT_PROJECT_CODES,
  parseTcmTreatmentCapabilities,
} = await import("../src/lib/tcm-treatment-projects.ts");
const {
  applyTcmTreatmentCapabilityPriority,
  buildTcmTreatmentProjectPromptContext,
  compileTcmTreatmentRecommendations,
  getTcmTreatmentProjectStatus,
} = await import("../src/lib/tcm-treatment-capabilities.server.ts");
const { normalizeCaseStateInput } = await import("../src/lib/diagnosis-types.ts");
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

  check("model proposals are not reclassified by a server keyword domain", () => {
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
    ).map((item) => item.projectCode), ["needle_knife"]);
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

  check("empty model output remains empty even when the clinic has suitable projects", () => {
    configureSimple(["acupuncture", "auricular", "tuina"]);
    assert.deepEqual(compileTcmTreatmentRecommendations([], priors.headache), []);
  });

  check("clinic priority never fabricates omitted model proposals", () => {
    configureSimple(["diet_therapy", "acupuncture"]);
    const recommendations = compileTcmTreatmentRecommendations([], priors.digestive);
    assert.deepEqual(recommendations, []);
  });

  check("an invalid model project is rejected without deterministic supplementation", () => {
    configureSimple(["diet_therapy", "acupuncture"]);
    const recommendations = compileTcmTreatmentRecommendations(
      [{ projectCode: "needle_knife", targetRef: "P9" }],
      priors.digestive,
    );
    assert.deepEqual(recommendations, []);
  });

  check("metabolic rehabilitation is not auto-filled after model omission", () => {
    configureSimple(["qigong_daoyin", "acupuncture"]);
    assert.equal(
      compileTcmTreatmentRecommendations([], priors.metabolicRehabilitation).length,
      0,
    );
  });

  check("post-stroke rehabilitation also requires an explicit model proposal", () => {
    configureSimple(["acupuncture", "tuina", "qigong_daoyin"]);
    assert.deepEqual(
      compileTcmTreatmentRecommendations([], priors.neurologicRehabilitation).map((item) => item.projectCode),
      [],
    );
  });

  check("one valid model proposal remains one proposal without server additions", () => {
    configureSimple(["acupuncture", "moxibustion", "diet_therapy", "needle_knife"]);
    const recommendations = compileTcmTreatmentRecommendations(
      [{ projectCode: "diet_therapy", targetRef: "P1" }],
      priors.digestive,
    );
    assert.deepEqual(recommendations.map((item) => item.projectCode), ["diet_therapy"]);
    assert.ok(recommendations.length <= 3);
    assert.equal(new Set(recommendations.map((item) => item.projectCode)).size, recommendations.length);
    assert.equal(recommendations.some((item) => item.projectCode === "needle_knife"), false);
  });

  check("clinic priority only orders accepted model proposals", () => {
    configureSimple(["acupuncture", "moxibustion", "tuina", "cupping"]);
    const recommendations = compileTcmTreatmentRecommendations(
      [{ projectCode: "cupping", targetRef: "P1" }],
      priors.pain,
    );
    assert.deepEqual(
      recommendations.map((item) => item.projectCode),
      ["cupping"],
      "unproposed clinic capabilities must not enter the result",
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

  check("the compiler validates contracts but does not second-guess model clinical semantics", () => {
    configureSimple(["needle_knife", "diet_therapy"]);
    const recommendations = compileTcmTreatmentRecommendations([
      { projectCode: "needle_knife", targetRef: "P1" },
      { projectCode: "diet_therapy", targetRef: "P1" },
    ], priors.digestive);
    assert.deepEqual(recommendations.map((item) => item.projectCode), ["needle_knife", "diet_therapy"]);
  });

  check("each treatment project preserves the exact real pathogenesis node selected by the model", () => {
    configureSimple(["tuina"]);
    const firstNode = compileTcmTreatmentRecommendations(
      [{ projectCode: "tuina", targetRef: "P1" }],
      priors.mixedSleepAndNeckPain,
    );
    assert.equal(firstNode[0]?.targetRef, "P1");
    assert.match(firstNode[0]?.targetPathogenesis || "", /心神失养/);
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

  check("prompt exposes the configured catalog and asks the LLM to judge semantics", () => {
    configureSimple(["acupoint_application", "needle_knife", "diet_therapy"]);
    const context = buildTcmTreatmentProjectPromptContext({ reasoningDiagnose: priors.respiratory });
    assert.match(context, /acupoint_application=敷贴/);
    assert.match(context, /含药外治，仅作审方评估/);
    assert.match(context, /needle_knife=针刀/);
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

  check("provider omission is preserved instead of being filled by server rules", () => {
    configureSimple(["acupuncture", "tuina"]);
    const rawReasoning = { ...priors.pain, stage: "prescribe", nonPharma: null };
    const content = `<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(rawReasoning)}\n<!-- DIAGNOSIS_JSON_END -->`;
    const sanitized = applyTcmTreatmentCapabilityPriority(content, undefined, priors.pain);
    const sanitizedJson = JSON.parse(sanitized.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
    assert.equal(sanitizedJson.nonPharma, null);
  });

  check("a fabricated target is discarded without silently retargeting the same project", () => {
    configureSimple(["tuina"]);
    assert.deepEqual(compileTcmTreatmentRecommendations(
      [{ projectCode: "tuina", targetRef: "P9" }],
      priors.kneeOsteoarthritis,
    ), []);
  });
} finally {
  restore();
}

console.log(JSON.stringify({ cases, failures: 0 }));
