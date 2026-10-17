import assert from "node:assert/strict";
import { createJiti } from "jiti";

// 交付面投影（delivered-surface.ts）：调用方实际收到的结构化结果里，甲方明确不要的整块不带内容，
// 服务端生成的系统句式换成临床写法，接口字段名与结构不变（2026-10-13，甲方 10.12 测评）。

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src`, "server-only": "/dev/null" } });
const {
  applyDeliveredSurfaceToContent,
  clinicalWordingForSyntheticPhrases,
  deliveredWesternDiagnosisName,
  projectDeliveredReasoning,
  restoreDiagnoseSupportingFacts,
} = await jiti.import("../src/lib/delivered-surface.ts");

const diagnose = () => ({
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "diagnose",
  overview: {
    tcmDiseaseName: "虚劳类病",
    primarySyndrome: "肺气虚证",
    primarySyndromeResolution: "bounded",
    primarySyndromeBasis: ["易疲乏、短气自汗"],
    tcmDiseaseRationale: "以反复感冒、乏力自汗为主症，故归虚劳；病历尚未确认胸痛是否存在，与胸痹相区分。",
    tcmDiagnosticRationale: "短气自汗、声音低怯，为肺气不足，故辨为肺气虚证。",
    tcmDiseaseDifferentials: [{ diseaseName: "痹证类病", reason: "同见乏力", distinguishingPoints: "病历未记录关节疼痛记录（需问诊核实后方可用于排除）", typicalManifestation: "肢体关节疼痛", nextCheck: null }],
    secondarySyndromes: [],
    recommendedFormulaDirection: "补肺汤加减",
  },
  westernDiagnosis: {
    primary: {
      name: "反复上呼吸道感染，病因待查",
      coding: { system: "ICD-10", code: "J06.900", display: "急性上呼吸道感染" },
      supportingFacts: ["近一年感冒约九次", "易疲乏、短气自汗"],
      supportingFactKinds: [{ fact: "易疲乏、短气自汗", kind: "symptom" }],
      clinicalRationale: "反复感冒伴乏力自汗。",
      limitations: ["完整度未达C级：以下结论基于现有信息形成，属有界建议"],
      suggestedChecks: ["血常规", "免疫功能"],
    },
    differentials: [{ name: "过敏性鼻炎（常年性）", reason: "反复鼻部症状", distinguishingPoints: "病历已记录否认鼻痒，喷嚏的一般情况需医生核实", nextCheck: "过敏原检测" }],
    candidates: [{ name: "反复上呼吸道感染，病因待查", likelihood: "高", keyEvidence: [], againstEvidence: [] }, { name: "免疫功能低下（待查）", likelihood: "低", keyEvidence: [], againstEvidence: [] }],
  },
  pathogenesis: { chain: [{ nodeId: "P1", patientFact: "易疲乏、短气自汗", syndromeEvidence: "易疲乏、短气自汗", pathogenesis: "肺气不足，卫外不固", therapyDirection: "补益肺气" }] },
  therapy: { overallPrinciple: "虚则补之", overallMethod: "补益肺气" },
  management: { followupSafetyNet: "请服完本次的药后复诊。" },
});

// ── 1. 辨证结果：三块清空、病名干净、系统句式换成临床写法 ─────────────────────────────────
{
  const source = diagnose();
  const out = projectDeliveredReasoning(source);
  assert.notEqual(out, source, "投影返回新对象，不改入参");
  assert.deepEqual(source.westernDiagnosis.primary.supportingFacts.length, 2, "入参不被改动");
  const primary = out.westernDiagnosis.primary;
  assert.deepEqual(primary.supportingFacts, [], "症状依据不带内容");
  assert.deepEqual(primary.supportingFactKinds, []);
  assert.deepEqual(primary.limitations, [], "待查依据不带内容");
  assert.deepEqual(primary.suggestedChecks, [], "检查建议不带内容");
  assert.equal(primary.name, "反复上呼吸道感染", "已点名病种不带「，病因待查」");
  assert.equal(out.westernDiagnosis.candidates[0].name, primary.name, "候选首项与主诊断同名");
  assert.equal(out.westernDiagnosis.candidates[1].name, "免疫功能低下");
  assert.equal(out.westernDiagnosis.differentials[0].name, "过敏性鼻炎", "鉴别名不带括号说明");
  assert.equal(out.westernDiagnosis.differentials[0].distinguishingPoints, "否认鼻痒");
  assert.equal(out.overview.tcmDiseaseName, "虚劳", "「类病」是分类名，不是病名");
  assert.equal(out.overview.tcmDiseaseDifferentials[0].diseaseName, "痹证");
  assert.equal(out.overview.tcmDiseaseDifferentials[0].distinguishingPoints, "未诉关节疼痛");
  assert.match(out.overview.tcmDiseaseRationale, /未诉胸痛，与胸痹相区分/);
  assert.doesNotMatch(JSON.stringify(out), /病历尚未确认|病历已记录|需问诊核实/);
  // 结构不变：每个键都还在，类型不变
  const keys = (value, prefix = "") => value && typeof value === "object" && !Array.isArray(value)
    ? Object.entries(value).flatMap(([key, child]) => [`${prefix}${key}:${Array.isArray(child) ? "array" : typeof child}`, ...keys(child, `${prefix}${key}.`)])
    : [];
  assert.deepEqual(keys(out).sort(), keys(source).sort(), "字段名、层级、类型逐一相同");
  // 逐字引用的字段不动
  assert.deepEqual(out.overview.primarySyndromeBasis, source.overview.primarySyndromeBasis);
  assert.equal(out.pathogenesis.chain[0].patientFact, source.pathogenesis.chain[0].patientFact);
  // 幂等
  assert.deepEqual(projectDeliveredReasoning(out), out);
}

// ── 1b.「完整度未达C级…」统一标注不进交付结果；只有这句话的不确定项整条去掉 ─────────────────
{
  const NOTE = "完整度未达C级：以下结论基于现有信息形成，属有界建议；补充病程、伴随表现及必要四诊可提高确定性，正式采纳前请医生核对未知项。";
  const source = diagnose();
  source.overview.primarySyndromeResolutionReason = `${NOTE}\n\n缺舌脉，寒热虚实细节待四诊补充`;
  source.pathogenesis.uncertainties = [
    { item: "信息覆盖", reason: NOTE, affects: "辨证" },
    { item: "舌脉", reason: "未取得舌象脉象", affects: "寒热虚实" },
  ];
  source.overview.tcmDiseaseDifferentials[0].distinguishingPoints = "有气促；病历已记录无胸痛，无气促加重";
  const out = projectDeliveredReasoning(source);
  assert.equal(out.overview.primarySyndromeResolutionReason, "缺舌脉，寒热虚实细节待四诊补充", "模型自己写的把握度说明保留");
  assert.deepEqual(out.pathogenesis.uncertainties.map((item) => item.item), ["舌脉"]);
  assert.equal(out.overview.tcmDiseaseDifferentials[0].distinguishingPoints, "有气促；无胸痛，无气促加重");
  assert.doesNotMatch(JSON.stringify(out), /完整度未达|有界建议|病历已记录/);
}

// ── 2. 服务端的有限结论（红旗收口）保留支持事实 ───────────────────────────────────────────
{
  const limited = diagnose();
  limited.overview.primarySyndromeResolution = "unresolved";
  limited.pathogenesis.chain = [];
  limited.westernDiagnosis.primary.supportingFacts = ["呕吐咖啡样物约200ml", "柏油样黑便2次"];
  const out = projectDeliveredReasoning(limited);
  assert.deepEqual(out.westernDiagnosis.primary.supportingFacts, ["呕吐咖啡样物约200ml", "柏油样黑便2次"], "红旗发现放在支持事实里，开方阶段要读");
}

// ── 3. 诊断名 ─────────────────────────────────────────────────────────────────────────
for (const [name, coding, expected] of [
  ["心悸，病因待查", { code: "R00.200" }, "心悸待查"],
  ["功能性消化不良，病因待查", { code: "K30.x00" }, "功能性消化不良"],
  ["带状疱疹（左侧胁肋部及腰背部，累及肋间神经分布区）", { code: "B02.9" }, "带状疱疹"],
  ["头痛（症状性）", { code: "R51" }, "头痛待查"],
  ["急性上呼吸道感染", { code: "J06.9" }, "急性上呼吸道感染"],
  ["腰痛待查", { code: "M54.5" }, "腰痛待查"],
  ["当前未形成可复核的西医工作诊断", undefined, "当前未形成可复核的西医工作诊断"],
]) {
  assert.equal(deliveredWesternDiagnosisName(name, coding), expected, name);
  assert.equal(deliveredWesternDiagnosisName(expected, coding), expected, `${name} 幂等`);
}

// ── 4. 系统句式 → 临床写法（有限闭集；没命中时逐字节不变）────────────────────────────────
for (const [source, expected] of [
  ["病历尚未确认胸痛是否存在，与胸痹相区分。", "未诉胸痛，与胸痹相区分。"],
  ["病历已记录瘙痒阳性，无发热。", "有瘙痒，无发热。"],
  ["病历已记录否认高热，发热的一般情况需医生核实；余同前", "否认高热；余同前"],
  ["意识改变是否存在尚未确认", "未诉意识改变"],
  ["病历未记录怕热多汗记录（需问诊核实后方可用于排除）", "未诉怕热多汗"],
  ["患者否认胸痛，舌淡红。", "患者否认胸痛，舌淡红。"],
  ["有发热；病历已记录关节无明显红肿发热，无晨僵", "有发热；关节无明显红肿发热，无晨僵"],
]) assert.equal(clinicalWordingForSyntheticPhrases(source), expected);

// ── 5. 开方结果 ───────────────────────────────────────────────────────────────────────
{
  const prescribe = {
    ...diagnose(),
    stage: "prescribe",
    formula: {
      candidates: [{
        name: "本例辨证组方",
        formulaSource: { evidenceLevel: "model_inference", source: "自拟方，组方参考：异功散、四君子汤加减；其余药味按本例证候、病机与药味功效配伍，需医生复核", confidence: "中" },
        applicable: "适用于与本例锁定证候“肺气虚证”及病机链一致的情况。",
        notApplicable: "证候、病机、舌脉或安全边界变化时暂停采用，并重新辨证。；。 各药毒性与特殊人群提示：知母（哺乳期、孕期/妊娠慎用）；石菖蒲（孕期/妊娠禁用或须强复核）。相应人群或状态请停用、替换，或经医生/药师复核后使用。",
        formulaAnalysis: "本方以本方案为基础加减。黄芪为君，补益肺气。",
        herbs: [{ name: "黄芪", dose: "15g" }],
      }],
      patentAndWestern: [{ name: "玉屏风颗粒", usageBoundary: "说明书用法字段已与本候选的说明书条目及指纹绑定。", relationship: "与中药饮片方案不默认联用，由医生结合重复功效、相互作用和治疗目标择一或评估联用。", riskNote: "孕妇慎用" }],
      modifications: [{ trigger: "自汗", action: "加", herbName: "浮小麦", doseOrHandling: "15g", reason: "固表止汗", riskNote: "实际采用时请在药味工作台确定剂量，并按调整后的完整处方重新审方。" }],
    },
    nonPharma: {
      precautions: ["饭后温服，忌食生冷。", "。", ""],
      tcmTreatments: [
        { projectCode: "acupuncture", protocolStatus: "governed_patient_specific_plan", tailoringStatus: "syndrome_tailored", suggestedSitesOrPoints: ["肺俞", "太渊（按证型加选）"], scheduleSuggestion: "每日1次。疗程由复评决定。", techniqueBoundary: "毫针常规针刺；实际取穴由现场医师按辨证复核。", treatmentContent: "按肺气虚取穴。" },
        { projectCode: "moxibustion", protocolStatus: "assessment_only_no_patient_specific_protocol", tailoringStatus: "assessment_only", suggestedSitesOrPoints: [], scheduleSuggestion: "", techniqueBoundary: "本轮不下发患者级操作参数；…", treatmentContent: "…本轮不形成操作计划。" },
        { projectCode: "diet_therapy", protocolStatus: "governed_class_template_not_syndrome_tailored", tailoringStatus: "class_template_only", suggestedSitesOrPoints: [], scheduleSuggestion: "随三餐", techniqueBoundary: "食疗只作调护", treatmentContent: "按本病常规选用食疗。" },
      ],
    },
  };
  const out = projectDeliveredReasoning(prescribe);
  const candidate = out.formula.candidates[0];
  assert.equal(candidate.name, "自拟方", "不再显示「本例辨证组方」");
  assert.equal(candidate.formulaSource.source, "自拟方");
  assert.equal(candidate.applicable, "", "每例相同的适用模板句不带内容");
  assert.equal(candidate.notApplicable, "知母（哺乳期、孕期/妊娠慎用）；石菖蒲（孕期/妊娠禁用）", "只留逐味的特殊人群提示");
  assert.equal(candidate.formulaAnalysis, "本方为自拟方。黄芪为君，补益肺气。");
  assert.equal(out.formula.patentAndWestern[0].usageBoundary, "");
  assert.equal(out.formula.patentAndWestern[0].relationship, "");
  assert.equal(out.formula.patentAndWestern[0].riskNote, "孕妇慎用", "说明书里的风险提示原样保留");
  assert.equal(out.formula.modifications[0].riskNote, "");
  assert.equal(out.formula.modifications[0].doseOrHandling, "15g");
  assert.deepEqual(out.nonPharma.precautions, ["饭后温服，忌食生冷。"], "只剩标点的条目不下发");
  assert.deepEqual(out.nonPharma.tcmTreatments.map((item) => item.projectCode), ["acupuncture"], "给不出具体内容的项目不下发");
  assert.deepEqual(out.nonPharma.tcmTreatments[0].suggestedSitesOrPoints, ["肺俞", "太渊"]);
  assert.equal(out.nonPharma.tcmTreatments[0].scheduleSuggestion, "每日1次。");
  assert.deepEqual(out.westernDiagnosis.primary.supportingFacts, [], "开方结果里的辨证副本同一口径");
  assert.deepEqual(projectDeliveredReasoning(out), out, "幂等");
  // 逐味人群提示只列本例可能属于的人群（2026-10-17）：男性、儿童与 60 岁以上患者的处方此前 96% 带孕期或哺乳期提示。
  {
    const { herbBoundaryTail } = await jiti.import("../src/lib/candidate-boundary-text.ts");
    const { getTcmHerbGenerationSafetyProfile } = await jiti.import("../src/lib/tcm-knowledge.ts");
    const herbs = ["麻黄", "知母", "石菖蒲", "川芎"];
    const fullTail = herbBoundaryTail(herbs.map((name) => getTcmHerbGenerationSafetyProfile(name)));
    assert.match(fullTail, /孕期\/妊娠/, "夹具前提：这几味在知识库里带孕期提示");
    assert.match(fullTail, /老年人|儿童/, "夹具前提：至少一味带年龄类人群提示");
    const withTail = structuredClone(prescribe);
    withTail.formula.candidates[0] = { ...withTail.formula.candidates[0], herbs: herbs.map((name) => ({ name, dose: "6g" })),
      notApplicable: `证候、病机、舌脉或安全边界发生变化时暂停采用，并重新辨证。 ${fullTail}` };
    const project = (audience) => projectDeliveredReasoning(withTail, audience ? { herbBoundaryAudience: audience } : undefined).formula.candidates[0].notApplicable;
    const unfiltered = project(undefined);
    assert.equal(project({ reproductive: true, ageYears: null }), unfiltered, "育龄女性、年龄不详：与不过滤相同");
    const man = project({ reproductive: false, ageYears: 30 });
    assert.doesNotMatch(man, /孕|妊娠|哺乳/, `30 岁男性不列孕哺：${man}`);
    assert.doesNotMatch(man, /老年人|儿童/, `30 岁不列老年人、儿童：${man}`);
    assert.match(man, /出血倾向\/月经期\/抗凝状态|心血管/, `病情类人群照常保留：${man}`);
    assert.match(man, /^[^（]+（[^）]+）(；[^（]+（[^）]+）)*$/, `格式与不过滤时同一写法：${man}`);
    const elderly = project({ reproductive: false, ageYears: 70 });
    if (/老年人/.test(unfiltered)) assert.match(elderly, /老年人/, "70 岁照常列老年人");
    assert.doesNotMatch(elderly, /孕|妊娠|哺乳/);
    const onlyPregnancy = structuredClone(withTail);
    onlyPregnancy.formula.candidates[0].herbs = [{ name: "石菖蒲", dose: "6g" }];
    onlyPregnancy.formula.candidates[0].notApplicable = `证候、病机、舌脉或安全边界发生变化时暂停采用，并重新辨证。 ${herbBoundaryTail([getTcmHerbGenerationSafetyProfile("石菖蒲")])}`;
    assert.equal(projectDeliveredReasoning(onlyPregnancy, { herbBoundaryAudience: { reproductive: false, ageYears: 30 } }).formula.candidates[0].notApplicable, "", "一味都不剩时整栏为空，不留模板句");
    const once = projectDeliveredReasoning(withTail, { herbBoundaryAudience: { reproductive: false, ageYears: 30 } });
    assert.deepEqual(projectDeliveredReasoning(once, { herbBoundaryAudience: { reproductive: false, ageYears: 30 } }), once, "带本例信息时同样幂等");
    const content = `正文\n<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(withTail)}\n<!-- DIAGNOSIS_JSON_END -->`;
    assert.doesNotMatch(applyDeliveredSurfaceToContent(content, { herbBoundaryAudience: { reproductive: false, ageYears: 30 } }), /孕期/, "按内容投影的入口同一口径");
  }
  // 两个阶段方名一致，但只在处方确以该方为主体时：药名按组成身份比（龙胆草=龙胆），基准取教材行组成与目录组成中高的；
  // 合方只有一张的组成在处方里时，方名只写那一张。合成集实测 6 例辨证阶段定了教材代表方、处方也是那张方，方名却是「自拟方」。
  {
    const combined = structuredClone(prescribe);
    combined.overview = { ...combined.overview, tcmDiseaseName: "湿疮", primarySyndrome: "湿热蕴肤证", recommendedFormulaDirection: "龙胆泻肝汤合萆薢渗湿汤加减" };
    combined.formula.candidates[0] = {
      ...combined.formula.candidates[0], name: "本例辨证组方", formulaAnalysis: "本方以本方案为基础加减。龙胆为君。",
      herbs: ["龙胆", "黄芩", "栀子", "泽泻", "车前子", "川木通", "生地黄", "当归", "柴胡", "甘草"].map((name) => ({ name, dose: "6g" })),
    };
    const named = projectDeliveredReasoning(combined).formula.candidates[0];
    assert.equal(named.name, "龙胆泻肝汤加减", "处方全是龙胆泻肝汤的药，方名只写这一张");
    // 出处写原书（方剂目录里有的按目录），不写教材。
    assert.match(named.formulaSource.source, /^龙胆泻肝汤：《[^》]+》/);
    assert.doesNotMatch(named.formulaSource.source, /中医外科学/, "目录收了的方，出处是原书");
    assert.equal(named.formulaAnalysis, "本方以龙胆泻肝汤为基础加减。龙胆为君。");
    const unrelated = structuredClone(combined);
    unrelated.formula.candidates[0].herbs = ["党参", "白术", "茯苓", "甘草"].map((name) => ({ name, dose: "6g" }));
    assert.equal(projectDeliveredReasoning(unrelated).formula.candidates[0].name, "自拟方", "组成不是该方时不改名");
  }
  // 方义里的「本方案」（自拟方不得自称成方时换上的占位）：方名最终是成方时换回方名；各种写法都不得留下「本方以本方」。
  // 合成集实测：84 例里 3 例的方义以「本方以本方。」「本方以本方加减。」开头。
  for (const [name, analysis, expected] of [
    ["天王补心丹合朱砂安神丸加减", "本方以本方案加减。生地黄为君。", "本方以天王补心丹合朱砂安神丸为基础加减。生地黄为君。"],
    ["良附丸合正气天香散", "本方以本方案为基础加减，高良姜为君。", "本方以良附丸合正气天香散为基础加减，高良姜为君。"],
    ["六味地黄丸合交泰丸加减", "本方以本方案。熟地黄为君。", "本方以六味地黄丸合交泰丸为基础加减。熟地黄为君。"],
    ["四物汤加减", "本方以本方案化裁。因本例冲任失调，故去温燥之品。", "本方以四物汤为基础加减。因本例冲任失调，故去温燥之品。"],
    ["凉血地黄汤合脾约麻仁丸加减", "本方以本方案合脾约本方案为基础加减。生地黄为君。", "本方以凉血地黄汤合脾约麻仁丸为基础加减。生地黄为君。"],
    ["本例辨证组方", "本方以本方案加减。黄芪为君。", "本方为自拟方。黄芪为君。"],
    ["自拟方", "本方以本方案。黄芪为君，本方案重在补气。", "本方为自拟方。黄芪为君，本方重在补气。"],
  ]) {
    const input = structuredClone(prescribe);
    input.formula.candidates[0].name = name;
    input.formula.candidates[0].formulaAnalysis = analysis;
    const projected = projectDeliveredReasoning(input).formula.candidates[0].formulaAnalysis;
    assert.equal(projected, expected, `${name}｜${analysis}`);
    assert.doesNotMatch(projected, /本方以本方[。，,加]|本方案/);
  }
}

// ── 6. sentinel 内投影；没有变化时逐字节返回原文 ──────────────────────────────────────────
{
  const wrap = (value) => `正文\n<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(value, null, 2)}\n<!-- DIAGNOSIS_JSON_END -->`;
  const projected = applyDeliveredSurfaceToContent(wrap(diagnose()));
  const parsed = JSON.parse(projected.match(/<!-- DIAGNOSIS_JSON_START -->([\s\S]*?)<!-- DIAGNOSIS_JSON_END -->/)[1]);
  assert.deepEqual(parsed.westernDiagnosis.primary.supportingFacts, []);
  assert.equal(applyDeliveredSurfaceToContent(projected), projected, "已投影的内容逐字节不变");
  assert.equal(applyDeliveredSurfaceToContent("没有结构化结果的正文"), "没有结构化结果的正文");
}

// ── 7. 开方阶段补回支持事实（只在内存里；已有时不动）────────────────────────────────────────
{
  const delivered = projectDeliveredReasoning(diagnose());
  const restored = restoreDiagnoseSupportingFacts(delivered, ["近一年感冒约九次", "易疲乏、短气自汗", ""]);
  assert.deepEqual(restored.westernDiagnosis.primary.supportingFacts, ["近一年感冒约九次", "易疲乏、短气自汗"]);
  assert.deepEqual(delivered.westernDiagnosis.primary.supportingFacts, [], "入参不被改动");
  const untouched = diagnose();
  assert.equal(restoreDiagnoseSupportingFacts(untouched, ["别的事实"]), untouched, "回传的辨证结果自带支持事实时原样返回");
}

console.log("delivered surface: ok");
