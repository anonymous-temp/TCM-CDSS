/**
 * 甲方 8.5 / 8.11 反馈在 a816e78 当前线上同病例的复现回归。
 *
 * 只钉真实失败形态，不用「字段非空」代替医学正确：
 *  1) PHI 姓名规则不得吃掉夜间/晨起/昨夜等临床时相；
 *  2) 「病历已记录…阳性」不得混入任何病机结论字段；
 *  3) 《伤寒论》四味麻黄汤不得串到《外台》二味同名方；
 *  4) 已锁经典方的君臣佐使与方义不得继续依赖模型占位话术；
 *  5) 没有受治理患者级模板时，评估态不得展示关键词拼出的低质量穴位。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const jiti = createJiti(import.meta.url, {
  jsx: true,
  interopDefault: true,
  alias: {
    "@": path.join(repoRoot, "src"),
    "server-only": path.join(repoRoot, "node_modules/next/dist/compiled/server-only/empty.js"),
  },
});

const { sanitizeFreeTextForModel } = await jiti.import("../src/lib/diagnosis-safety.ts");
const {
  applyDeterministicFormulaAnalysis,
  applyDeterministicTreatmentPrinciple,
} = await jiti.import("../src/lib/diagnosis-visible-summary.ts");
const { enrichReasoning, resolveFormulaSources } = await jiti.import("../src/lib/tcm-formula-provenance.ts");
const { compileTcmTreatmentRecommendations } = await jiti.import("../src/lib/tcm-treatment-capabilities.server.ts");
const { dropUnsupportedM04ModificationDirections } = await jiti.import("../src/lib/m04-modification-safety.ts");
const {
  applyM03KeySyndromeDiscriminatorsToContent,
  discriminatingWesternSupportClauses,
  isNondiscriminatingWesternSupportingFact,
  m03KeySyndromeDiscriminatorIssue,
  m04HerbDirectionIssue,
  projectM03KeySyndromeDiscriminators,
} =
  await jiti.import("../src/lib/diagnosis-stage-contract.ts");
const { rejectionTier } = await jiti.import("../src/lib/diagnosis-rejection-tiers.ts");
const { buildFormulaAnalysis } = await jiti.import("../src/lib/herb-target-contract.ts");

const S = "<!-- DIAGNOSIS_JSON_START -->";
const E = "<!-- DIAGNOSIS_JSON_END -->";
const wrap = (payload) => `${S}\n${JSON.stringify(payload)}\n${E}`;
const unwrap = (content) => JSON.parse(content.slice(content.indexOf(S) + S.length, content.indexOf(E)).trim());

// 1. a816e78 线上真实送模函数会把「于夜间/于晨起/于昨夜」识别成姓名并删除。
for (const phrase of [
  "本例于夜间发热",
  "患者于昨夜发热",
  "病人于晨起头痛",
  "患儿于昨夜咳嗽",
  "病例于今日出现胸痛",
]) {
  assert.equal(sanitizeFreeTextForModel(phrase), phrase, `PHI 规则误删临床时相：${phrase}`);
}

// 2. 同一病例当前线上总体病机、summary、caseRelationship、P1 均混入事实模板。
{
  const payload = {
    schemaVersion: "tcm-cdss-reasoning-v2",
    stage: "diagnose",
    overview: {
      tcmDiseaseName: "感冒",
      primarySyndrome: "风寒束表证",
      primarySyndromeBasis: ["恶寒发热", "无汗", "脉浮紧"],
      overallPathogenesis: "风寒外袭，卫阳被遏，肺气失宣，病历已记录发热、咳嗽阳性。",
    },
    westernDiagnosis: { primary: { supportingFacts: ["恶寒发热"] }, differentials: [] },
    pathogenesis: {
      summary: "风寒外袭，卫阳被遏，肺气失宣，病历已记录发热、咳嗽阳性",
      caseRelationship: { rootPattern: "风寒束表", mainManifestation: "感冒", relationship: "风寒束表，卫阳被遏，肺气失宣，病历已记录恶寒重发热轻、无汗、脉浮紧" },
      locationDifferentiation: { items: ["肺", "表"], details: [] },
      natureDifferentiation: { items: ["风寒"], rootDeficiency: [], branchExcess: ["风寒"] },
      chain: [{ nodeId: "P1", patientFact: "恶寒发热", syndromeEvidence: "无汗、脉浮紧", pathogenesis: "风寒束表，病历已记录发热阳性", therapyDirection: "辛温解表" }],
      uncertainties: [],
    },
    therapy: { overallPrinciple: "正治法", overallMethod: "辛温解表，宣肺散寒", subTherapies: [] },
  };
  const out = unwrap(applyDeterministicTreatmentPrinciple(wrap(payload)));
  const clinicalMechanisms = [
    out.overview.overallPathogenesis,
    out.pathogenesis.summary,
    out.pathogenesis.caseRelationship.relationship,
    ...out.pathogenesis.chain.map((item) => item.pathogenesis),
  ];
  assert.ok(clinicalMechanisms.every((value) => !/病历已记录/.test(value)), JSON.stringify(clinicalMechanisms));
  assert.doesNotMatch(out.therapy.overallPrinciple, /^(?:正治法?|治疗本病)$/u, "治则不得只给空泛类别");
}

const mahuangHerbs = [
  { name: "麻黄", dose: "6g", role: "君", targetKind: "pathogenesis_node", targetRef: "P1", targetPathogenesis: "风寒束表" },
  { name: "桂枝", dose: "9g", role: "君", targetKind: "pathogenesis_node", targetRef: "P1", targetPathogenesis: "风寒束表" },
  { name: "苦杏仁", dose: "9g", role: "臣", targetKind: "pathogenesis_node", targetRef: "P1", targetPathogenesis: "肺气失宣" },
  { name: "甘草", dose: "3g", role: "使", targetKind: "formula_structure", targetRef: "FORMULA_STRUCTURE", structureRole: "harmonize", targetPathogenesis: "调和诸药" },
];

// 3. 当前 resolver 选择了《外台》卷三十八的二味同名方，必须锁回官方四味麻黄汤。
{
  const sources = resolveFormulaSources("麻黄汤加减", mahuangHerbs);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].source, "《伤寒论》");
  assert.equal(sources[0].totalIngredientCount, 4);
  assert.equal(sources[0].matchedIngredientCount, 4);
}

// 4. 已锁经典方按受治理角色归位，且方义不得再出现甲方点名的占位句。
{
  const reasoning = {
    schemaVersion: "tcm-cdss-reasoning-v2",
    stage: "prescribe",
    overview: { primarySyndrome: "风寒束表证", overallPathogenesis: "风寒束表，肺气失宣" },
    westernDiagnosis: { primary: { name: "急性上呼吸道感染" }, differentials: [] },
    pathogenesis: { chain: [{ nodeId: "P1", pathogenesis: "风寒束表，肺气失宣" }] },
    therapy: { overallPrinciple: "寒者热之", overallMethod: "辛温解表，宣肺散寒", subTherapies: [] },
    formula: {
      candidates: [{
        name: "麻黄汤加减",
        therapyMatch: "辛温解表，宣肺散寒",
        applicable: "风寒束表证",
        notApplicable: "风热、表虚自汗者不适用",
        herbs: structuredClone(mahuangHerbs),
        formulaAnalysis: "",
        compositionLogic: [{ formulaName: "麻黄汤", summary: "麻黄发汗解表为君，桂枝助麻黄解肌为臣，杏仁降肺气为佐，甘草调和并缓和峻烈为使。", tier: "common", sourceRefs: ["test"] }],
      }],
      modifications: [],
    },
    nonPharma: null,
    lineageAdaptation: null,
    management: {},
  };
  const enriched = enrichReasoning(structuredClone(reasoning)).reasoning;
  const candidate = enriched.formula.candidates[0];
  assert.deepEqual(Object.fromEntries(candidate.herbs.map((herb) => [herb.name, herb.role])), {
    麻黄: "君", 桂枝: "臣", 苦杏仁: "佐", 甘草: "使",
  });
  const harmonizer = candidate.herbs.find((herb) => herb.name === "甘草");
  assert.deepEqual({
    targetKind: harmonizer.targetKind,
    targetRef: harmonizer.targetRef,
    structureRole: harmonizer.structureRole,
    targetPathogenesis: harmonizer.targetPathogenesis,
  }, {
    targetKind: "formula_structure",
    targetRef: "FORMULA_STRUCTURE",
    structureRole: "harmonize",
    targetPathogenesis: "调和诸药，协调药性",
  });
  assert.equal(m04HerbDirectionIssue(harmonizer, {
    overview: { primarySyndrome: "风寒束表证", overallPathogenesis: "风寒外束，肺气失宣" },
    pathogenesis: { chain: [{ nodeId: "P1", pathogenesis: "风寒外束，肺气失宣", therapyDirection: "辛温解表，宣肺散寒" }] },
    therapy: { overallPrinciple: "寒者热之，温散祛邪", overallMethod: "辛温解表，宣肺散寒" },
  }), undefined, "经典方中概念为空的调和使药不得因药材次要功效被误判成清热方向冲突");
  const analyzed = unwrap(applyDeterministicFormulaAnalysis(wrap(enriched))).formula.candidates[0].formulaAnalysis;
  assert.doesNotMatch(analyzed, /具体配伍作用需医生结合方义复核/);
  assert.match(analyzed, /麻黄.*桂枝.*杏仁.*甘草/s);
  assert.match(analyzed, /麻黄.*为君.*桂枝.*为臣.*杏仁.*为佐.*甘草.*为使/s,
    "方义须把君臣佐使自然写进本方配伍叙述");
  assert.doesNotMatch(analyzed, /\*\*|(?:^|\n)\s*[-#]\s/m,
    "方义不得继续生成 Markdown 病机标题与逐味列表");
  const metadataOnly = structuredClone(enriched);
  metadataOnly.formula.candidates[0].formulaAnalysis = "";
  metadataOnly.formula.candidates[0].compositionLogic = [{
    formulaName: "麻黄汤",
    summary: "受控目录组成：麻黄、桂枝、杏仁、甘草。目录来源为《伤寒论》；方证定位为太阳伤寒，仍须逐项核对患者事实后才能进入处方编译。",
  }];
  const rebuilt = unwrap(applyDeterministicFormulaAnalysis(wrap(metadataOnly))).formula.candidates[0].formulaAnalysis;
  assert.doesNotMatch(rebuilt, /受控目录组成|目录来源|方证定位|进入处方编译/);
  assert.match(rebuilt, /麻黄.*桂枝.*杏仁.*甘草/s, "目录治理元数据不得再冒充方义，应回落到逐味君臣佐使分析");
  const placeholderAuthored = structuredClone(enriched);
  placeholderAuthored.formula.candidates[0].formulaAnalysis =
    "麻黄与桂枝为君臣，杏仁为佐，甘草为使；具体配伍作用需医生结合方义复核。";
  const placeholderRebuilt = unwrap(applyDeterministicFormulaAnalysis(wrap(placeholderAuthored))).formula.candidates[0].formulaAnalysis;
  assert.doesNotMatch(placeholderRebuilt, /具体配伍作用.*复核/);
  assert.match(placeholderRebuilt, /麻黄.*为君.*桂枝.*为臣.*杏仁.*为佐.*甘草.*为使/s);

  const partialAuthored = structuredClone(enriched);
  partialAuthored.formula.candidates[0].formulaAnalysis =
    "方中麻黄为君，桂枝为臣；桂枝助麻黄解肌发表，麻黄与桂枝相须为用，以增强发汗散寒之力。";
  const partialRebuilt = unwrap(applyDeterministicFormulaAnalysis(wrap(partialAuthored))).formula.candidates[0].formulaAnalysis;
  assert.match(partialRebuilt, /麻黄.*桂枝.*杏仁.*甘草/s,
    "模型方解遗漏半数实际药味时必须重建，不能只解释君臣两味就上屏");
}

// 4.1 甲方 2026-08-05 第 7.1 条给出的目标是连贯方解，不是 Markdown 病机标题与逐味功效清单。
{
  const shenlingAnalysis = buildFormulaAnalysis([
    { name: "人参", role: "君", function: "大补元气，补脾益肺", targetPathogenesis: "脾胃虚弱，运化失健" },
    { name: "白术", role: "君", function: "健脾益气，燥湿利水", targetPathogenesis: "脾胃虚弱，运化失健" },
    { name: "茯苓", role: "臣", function: "利水渗湿，健脾", targetPathogenesis: "脾虚湿盛" },
    { name: "山药", role: "臣", function: "补脾养胃，生津益肺", targetPathogenesis: "脾胃虚弱，运化失健" },
    { name: "白扁豆", role: "佐", function: "健脾化湿，和中消暑", targetPathogenesis: "脾虚湿盛" },
    { name: "莲子", role: "佐", function: "补脾止泻，益肾涩精", targetPathogenesis: "脾虚湿盛" },
    { name: "薏苡仁", role: "佐", function: "利水渗湿，健脾止泻", targetPathogenesis: "脾虚湿盛" },
    { name: "砂仁", role: "佐", function: "化湿行气，温中止泻", targetPathogenesis: "补益药滋腻，气机不畅" },
    { name: "桔梗", role: "使", function: "宣肺，利咽", targetPathogenesis: "引经载药，宣肺利气" },
    { name: "炙甘草", role: "使", function: "补脾和胃，调和诸药", targetPathogenesis: "调和诸药，协调药性" },
  ], "健脾益气，渗湿止泻");
  assert.match(shenlingAnalysis, /^方中/,
    "方义应直接进入本方配伍叙述，不使用系统式‘本方共N味、分层组方’开场");
  assert.doesNotMatch(shenlingAnalysis, /\*\*|(?:^|\n)\s*[-#]\s/m,
    "方义结构字段必须是连续自然段，不得把 Markdown 标题或列表交给医生页面");
  assert.match(shenlingAnalysis, /人参.*白术.*砂仁.*桔梗.*炙甘草/s,
    "方解必须覆盖本方各层关键药味及其方中作用");
  assert.doesNotMatch(shenlingAnalysis, /消暑|益肾涩精|利咽/,
    "方义只保留与本方病机和治法有关的作用，不罗列白扁豆、莲子、桔梗的其他通用功效");
  assert.doesNotMatch(shenlingAnalysis, /现有受控信息未形成|不强行判定|不作无依据推定/,
    "没有实际药对关系时直接不写，不向医生展示系统自述式空项");

  const sparseMahuangAnalysis = buildFormulaAnalysis([
    { name: "麻黄", role: "君", function: "发汗解表，宣肺平喘", targetPathogenesis: "风寒束表" },
    { name: "桂枝", role: "臣", function: "解肌发表，温通营卫", targetPathogenesis: "风寒束表" },
    { name: "苦杏仁", role: "佐", function: "", targetPathogenesis: "肺气失宣" },
    { name: "旋覆花", role: "佐", function: "", targetPathogenesis: "胃气上逆" },
    { name: "炙甘草", role: "使", function: "", targetPathogenesis: "调和诸药，协调药性" },
  ], "辛温解表，宣肺平喘");
  assert.match(sparseMahuangAnalysis, /苦杏仁.*降肺气/s,
    "知识库功用缺失时也必须写出受治理的本方作用，不能退回角色套话");
  assert.match(sparseMahuangAnalysis, /旋覆花.*承接胃气上逆/s,
    "无受治理功用兜底的药味必须改用已锁定病机说明方中作用，不能只列药名");
  assert.doesNotMatch(sparseMahuangAnalysis, /承担本方的核心治疗作用|协同君药|兼顾兼夹病机|参与本方配伍/,
    "君臣佐使通用角色说明不是方解，任何药味都不得用它占位");

  const diagnosisClient = readFileSync(path.join(repoRoot, "src/app/diagnosis/DiagnosisClient.tsx"), "utf8");
  assert.match(diagnosisClient, /<MarkdownBlock\s+content=\{firstCandidate\.formulaAnalysis\}/,
    "历史方义即使仍含 Markdown，也必须经过 Markdown 渲染，不能把星号和短横线原样上屏");
  assert.doesNotMatch(diagnosisClient, /whitespace-pre-line[\s\S]{0,300}\{firstCandidate\.formulaAnalysis\}/,
    "方义不得继续走纯文本 whitespace-pre-line 裸渲染");
  assert.match(diagnosisClient, /title="方义解析"\s+subtitle="各药在方中作用与配伍关系"/,
    "方义副标题必须与甲方实际口径一致，不强行承诺每方都有佐制、相畏等关系");
}

// 5. 本例是感冒·风寒束表，不满足已治理的「普通咳嗽·风寒袭肺」模板；评估态宁可不列穴，
// 也不得再次返回甲方点名的肩中俞/涌泉/大杼等关键词拼接结果。
{
  process.env.TCM_CLINIC_TREATMENT_CAPABILITIES = "acupuncture";
  const prior = {
    schemaVersion: "tcm-cdss-reasoning-v2",
    stage: "diagnose",
    contractSignatureVersion: "tcm-cdss-m03-signature-v4",
    contractSignature: `hmac-sha256:${"a".repeat(64)}`,
    overview: { primarySyndrome: "风寒束表证", overallPathogenesis: "风寒束表，肺气失宣" },
    westernDiagnosis: { primary: { name: "急性上呼吸道感染", supportingFacts: [] }, differentials: [] },
    pathogenesis: { chain: [{ nodeId: "P1", patientFact: "恶寒发热、鼻塞流清涕", syndromeEvidence: "无汗、脉浮紧", pathogenesis: "风寒束表，肺气失宣", therapyDirection: "辛温解表" }] },
    therapy: { overallPrinciple: "寒者热之", overallMethod: "辛温解表", subTherapies: [] },
  };
  const state = {
    patient: { age: 24, sex: "女" },
    chiefComplaint: "恶寒发热、鼻塞流涕2天",
    symptoms: { presentHistory: "淋雨后恶寒发热，鼻塞流清涕，稍有咳嗽，无汗" },
    clinicTreatmentCapabilities: ["acupuncture"],
    safetyGate: { status: "ready" },
  };
  const item = compileTcmTreatmentRecommendations([{ projectCode: "acupuncture", targetRef: "P1" }], prior, state)
    .find((entry) => entry.projectCode === "acupuncture");
  assert.ok(item);
  assert.equal(item.protocolStatus, "assessment_only_no_patient_specific_protocol");
  assert.deepEqual(item.suggestedSitesOrPoints, [], `评估态仍暴露未治理穴位：${item.suggestedSitesOrPoints.join("、")}`);
}

// 6. 医生页面不再使用甲方已明确表示看不懂的「待确认方名」标签。
{
  const client = readFileSync(path.join(repoRoot, "src/app/diagnosis/DiagnosisClient.tsx"), "utf8");
  const summary = readFileSync(path.join(repoRoot, "src/lib/diagnosis-visible-summary.ts"), "utf8");
  assert.doesNotMatch(`${client}\n${summary}`, /待确认方名/);
  assert.match(`${client}\n${summary}`, /未锁定经典方方向/);
}

// 7. 风寒表实已记录的无汗、脉浮紧属于麻黄汤/桂枝汤分叉；不能只写「发热阳性」就让复核通过。
{
  const clinicalContext = "淋雨后恶寒重、发热轻，鼻塞流清涕，稍有咳嗽，无汗；舌淡红苔薄白，脉浮紧。";
  const issue = m03KeySyndromeDiscriminatorIssue({
    overview: {
      primarySyndrome: "风寒束表证",
      primarySyndromeBasis: ["恶寒发热", "鼻塞流清涕", "舌淡红苔薄白"],
      tcmDiagnosticRationale: "病历已记录发热阳性，为风寒外束之象；舌淡红苔薄白，无热象，故辨为风寒束表证。",
    },
    pathogenesis: {
      chain: [{ patientFact: "恶寒发热", syndromeEvidence: "鼻塞流清涕", pathogenesis: "风寒束表", therapyDirection: "辛温解表" }],
    },
  }, clinicalContext);
  assert.equal(issue, "chain_key_discriminator_missing");
  assert.equal(
    rejectionTier(issue),
    "T1",
    "会改变表实/表虚和麻黄汤/桂枝汤方向的关键鉴别点缺失必须触发线上修复，不得带批注放行",
  );
  const repaired = m03KeySyndromeDiscriminatorIssue({
    overview: {
      primarySyndrome: "风寒束表证",
      primarySyndromeBasis: ["恶寒重发热轻", "无汗", "脉浮紧"],
      tcmDiagnosticRationale: "恶寒重发热轻、无汗、脉浮紧共同支持风寒束表偏表实，故以辛温发汗为主要方向。",
    },
    pathogenesis: {
      chain: [{ patientFact: "恶寒重发热轻，无汗", syndromeEvidence: "脉浮紧", pathogenesis: "风寒束表，卫阳被遏", therapyDirection: "辛温发汗解表" }],
    },
  }, clinicalContext);
  assert.equal(repaired, undefined);

  // 线上两轮模型修复仍可能漏填同一事实。服务端只投影病历中逐字存在的鉴别点，
  // 不改主证名/病机/治法；投影后必须通过同一道合同，避免安全降级成空结果。
  const projected = projectM03KeySyndromeDiscriminators({
    overview: {
      primarySyndrome: "风寒束表证",
      primarySyndromeBasis: ["恶寒重发热轻", "鼻塞流清涕"],
      tcmDiagnosticRationale: "恶寒重发热轻、鼻塞流清涕，故辨为风寒束表证。",
    },
    pathogenesis: {
      chain: [{ nodeId: "P1", patientFact: "恶寒重发热轻", syndromeEvidence: "鼻塞流清涕", pathogenesis: "风寒束表，卫阳被遏", therapyDirection: "辛温解表" }],
    },
  }, clinicalContext);
  assert.match(projected.overview.primarySyndromeBasis.slice(2).join("；"), /无汗.*脉浮紧/s);
  assert.match(projected.overview.tcmDiagnosticRationale, /无汗.*脉浮紧/s);
  assert.match(projected.pathogenesis.chain[0].syndromeEvidence, /无汗.*脉浮紧/s);
  assert.equal(m03KeySyndromeDiscriminatorIssue(projected, clinicalContext), undefined);
  const projectedContent = unwrap(applyM03KeySyndromeDiscriminatorsToContent(wrap({
    schemaVersion: "tcm-cdss-reasoning-v2",
    stage: "diagnose",
    ...projected,
    overview: {
      ...projected.overview,
      tcmDiagnosticRationale: "病历已记录发热阳性，为风寒外束之象；无汗、脉浮紧支持风寒束表证。",
    },
  }), clinicalContext));
  assert.match(projectedContent.overview.primarySyndromeBasis.join("；"), /无汗.*脉浮紧/s);
  assert.doesNotMatch(projectedContent.overview.tcmDiagnosticRationale, /病历已记录|阳性|。。/);
  assert.equal(m03KeySyndromeDiscriminatorIssue(projectedContent, clinicalContext), undefined);

  const diagnosisApi = readFileSync(path.join(repoRoot, "src/lib/diagnosis-api.ts"), "utf8");
  assert.match(
    diagnosisApi,
    /groundStructuredPatientFacts\(content, clinicalContext\)[\s\S]{0,500}applyM03KeySyndromeDiscriminatorsToContent\(grounded, clinicalContext\)/,
    "M03 真实准备链必须先完成病历接地，再投影已确认的完整原句",
  );
  assert.match(
    diagnosisApi,
    /transformOutput[\s\S]*applyM03KeySyndromeDiscriminatorsToContent\([\s\S]*opts\.structuredClinicalContext/,
    "M03 医生可见输出净化后必须再次投影病历原文，再执行最终合同",
  );
  assert.match(
    diagnosisApi,
    /transformOutput[\s\S]*applyDeterministicTreatmentPrinciple\([\s\S]*applyM03KeySyndromeDiscriminatorsToContent/,
    "M03 医生可见输出净化后必须再次清理总体病机与病机联系中的事实状态模板",
  );
  const diagnosisClient = readFileSync(path.join(repoRoot, "src/app/diagnosis/DiagnosisClient.tsx"), "utf8");
  assert.doesNotMatch(diagnosisClient, /同上述(?:病机|项目)|同总体病机/);
  assert.doesNotMatch(diagnosisClient, /SummaryLine label="联用\/替代关系"/);
  assert.match(diagnosisClient, /const pathogenesisDisplay = step\.pathogenesis/,
    "每个子病机必须显示自己的病机演变，不得因去重把子病机2留空");
  assert.match(diagnosisClient, /!\["症状依据", "体征依据", "依据"\]\.includes\(group\.label\)/,
    "医生页面必须删除症状依据和体征依据分组");
  const visibleSummary = readFileSync(path.join(repoRoot, "src/lib/diagnosis-visible-summary.ts"), "utf8");
  assert.doesNotMatch(visibleSummary, /同上述(?:病机|项目)|同总体病机/,
    "医生可见 Markdown 也不得用跨段占位替代真实病机或治疗内容");
}

// 8. 「精神饮食尚可、二便调」是一般状态，不得给急性上呼吸道感染凑支持依据。
for (const fact of ["精神饮食尚可", "二便调", "精神可，二便调", "纳眠可"]) {
  assert.equal(isNondiscriminatingWesternSupportingFact(fact), true, `无鉴别力依据未被过滤：${fact}`);
}
assert.deepEqual(
  discriminatingWesternSupportClauses("精神饮食尚可，二便调，睡眠欠佳"),
  ["睡眠欠佳"],
  "一般状态与真实症状混在同一句时必须逐分句剥离，不能整句进入西医依据",
);

// 9. 急性外感数日内的短期眠差随外邪而来，不得机械加安神药；真实咳嗽兼症加减仍保留。
{
  const prior = {
    schemaVersion: "tcm-cdss-reasoning-v2",
    stage: "diagnose",
    overview: {
      primarySyndrome: "风寒束表证",
      primarySyndromeBasis: ["恶寒发热、鼻塞流涕2+天", "无汗", "脉浮紧"],
      overallPathogenesis: "风寒外束，肺气失宣",
    },
    pathogenesis: {
      chain: [{ nodeId: "P1", patientFact: "恶寒发热、鼻塞流涕2+天", syndromeEvidence: "无汗、脉浮紧", pathogenesis: "风寒外束，肺气失宣", therapyDirection: "辛温解表，宣肺散寒" }],
    },
    therapy: { overallPrinciple: "寒者热之，温散祛邪", overallMethod: "辛温解表，宣肺散寒" },
  };
  const next = unwrap(dropUnsupportedM04ModificationDirections(wrap({
    schemaVersion: "tcm-cdss-reasoning-v2",
    stage: "prescribe",
    formula: { modifications: [
      { trigger: "睡眠欠佳", action: "加酸枣仁", reason: "安神助眠", targetPathogenesis: "风寒外束" },
      { trigger: "稍有咳嗽", action: "加紫菀", reason: "宣肺止咳", targetPathogenesis: "肺气失宣" },
    ] },
  }), prior));
  assert.deepEqual(next.formula.modifications.map((item) => item.trigger), ["稍有咳嗽"]);
}

console.log(JSON.stringify({ suite: "client-feedback-20260817", failures: 0 }));
