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
const {
  isNondiscriminatingWesternSupportingFact,
  m03KeySyndromeDiscriminatorIssue,
  projectM03KeySyndromeDiscriminators,
} =
  await jiti.import("../src/lib/diagnosis-stage-contract.ts");
const { rejectionTier } = await jiti.import("../src/lib/diagnosis-rejection-tiers.ts");

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
      caseRelationship: { rootPattern: "风寒束表", mainManifestation: "感冒", relationship: "风寒束表，病历已记录发热阳性" },
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
  const analyzed = unwrap(applyDeterministicFormulaAnalysis(wrap(enriched))).formula.candidates[0].formulaAnalysis;
  assert.doesNotMatch(analyzed, /具体配伍作用需医生结合方义复核/);
  assert.match(analyzed, /麻黄.*桂枝.*杏仁.*甘草/s);
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

  const diagnosisApi = readFileSync(path.join(repoRoot, "src/lib/diagnosis-api.ts"), "utf8");
  const groundingAt = diagnosisApi.indexOf("groundStructuredPatientFacts(content, clinicalContext)");
  const projectionAt = diagnosisApi.indexOf("projectKeyDiscriminators(grounded)");
  assert.ok(groundingAt >= 0 && projectionAt > groundingAt, "M03 真实准备链必须先完成病历接地，再投影已确认的完整原句");
}

// 8. 「精神饮食尚可、二便调」是一般状态，不得给急性上呼吸道感染凑支持依据。
for (const fact of ["精神饮食尚可", "二便调", "精神可，二便调", "纳眠可"]) {
  assert.equal(isNondiscriminatingWesternSupportingFact(fact), true, `无鉴别力依据未被过滤：${fact}`);
}

console.log(JSON.stringify({ suite: "client-feedback-20260817", failures: 0 }));
