/**
 * Invariant: 确定性守卫必须双向。
 *
 * 本仓库的守卫几乎全部被建模成「模型可能多写／写过头」，而把「模型少写／写不足／被服务端自己删空」
 * 当成安全默认值放行。在 CDSS 里这个默认值不成立：删掉鉴别诊断、删掉方名、让某个病机方向没有药味
 * 承接，同样是把一个不完整结论以「完整结论」的外观交给医生——医生看不到「这里本来有东西、被系统
 * 拿掉了」，因此不会去补。真正的 fail-closed 是「降级并显式告知」，不是「静默变短」。
 *
 * 本文件锁住三处已修复的不对称，每一处都有实测过的具体代价：
 *
 * 1) 西医鉴别过滤没有下限守卫，而同一函数里紧邻的中医鉴别分支和 supportingFacts 分支都有。
 *    更糟的是它压制了自己的检测器：m03SemanticIssue 的 western_differential_analysis_missing
 *    判据正是「任一鉴别项 reason 或 distinguishingPoints < 4 字」，而该过滤删掉的恰好就是它们，
 *    且过滤在 m03SemanticIssue 之前运行——那个本该触发一轮定向修复的 T2 码永远命中不到。
 *
 * 2) 独立复核的定位标签里没有「鉴别遗漏」。复核提示词明确布置了呼吸—心源性交叉鉴别审计
 *    （differentials 必须覆盖心功能不全、冠心病等方向），复核器报了也无法被分类，最终落进
 *    以「硬性删减」为首行的通用引导——「你漏了必须排除的方向」被翻译成「删掉没有支撑的概念」。
 *
 * 3) 药味→病机节点的绑定只防「多」不防「少」：超出的一侧有 target_ref_invalid/_mismatch/_missing
 *    三重把守，反方向（M03 每个 Pn 是否真的被处方覆盖）全仓库不存在。实测：M03 给出 P1、P2，
 *    一张把全部药味都绑在 P1、完全无视 P2 的处方可以通过包括 T1 硬门在内的每一道检查。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyM03AdvisoryQualityBoundaries } from "../src/lib/diagnosis-visible-summary.ts";
import { m03NodeCoverageIssue, m04SafetyContractIssue, m04SemanticIssue } from "../src/lib/diagnosis-stage-contract.ts";
import { rejectionTier } from "../src/lib/diagnosis-rejection-tiers.ts";
import { boundedM03DiagnosticRepairGuidance, m03DiagnosticRepairGuidanceCodes } from "../src/lib/m03-diagnostic-review.ts";
import { structuredClinicalRepairHint } from "../src/lib/structured-clinical-repair.ts";
import { isKnownTcmHerbName } from "../src/lib/tcm-knowledge.ts";

const START = "<!-- DIAGNOSIS_JSON_START -->";
const END = "<!-- DIAGNOSIS_JSON_END -->";
const wrap = (payload) => `${START}\n${JSON.stringify(payload)}\n${END}`;
const unwrap = (content) => JSON.parse(content.slice(content.indexOf(START) + START.length, content.indexOf(END)).trim());

// ── 1) 西医鉴别过滤的下限守卫 ─────────────────────────────────────────────────
const CLINICAL_CONTEXT = "主诉：活动后气短2月；现病史：上楼两层即气促，夜间可平卧；否认胸痛";
const m03WithThinDifferentials = {
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "diagnose",
  overview: {
    tcmDiseaseName: "喘证", primarySyndrome: "肺脾气虚证", primarySyndromeResolution: "bounded",
    primarySyndromeBasis: ["上楼两层即气促"], primarySyndromeResolutionReason: "四诊资料有限",
    tcmDiagnosticRationale: "活动后气促伴易疲，属肺脾气虚",
    tcmDifferentials: [{ syndrome: "心阳不振", reason: "需与心源性气短鉴别", distinguishingPoints: "夜间可平卧且否认胸痛", nextCheck: "心电图" }],
    secondarySyndromes: [], overallPathogenesis: "肺脾气虚，宗气不足", overallTherapy: "补益肺脾",
    recommendedFormulaDirection: "按已锁定病机与治法辨证组方", recommendedFormulaNames: [], formulaSelectionMode: "self_devised",
    evidence: { evidenceLevel: "model_inference", source: "病例内推理", confidence: "中" },
  },
  westernDiagnosis: {
    primary: {
      name: "活动后气短", status: "考虑", confidence: "中",
      supportingFacts: ["上楼两层即气促"], clinicalRationale: "已记录的活动相关气促支持将活动后气短作为当前工作判断；尚未取得心肺客观检查，因此暂不采用更具体病因标签。",
      limitations: [], suggestedChecks: ["心电图"], evidence: { evidenceLevel: "model_inference", source: "病例内推理", confidence: "中" },
    },
    // 两项鉴别的 reason / distinguishingPoints 都不足 4 字：会被过滤器全部删空。
    differentials: [
      { name: "心功能不全", reason: "待", distinguishingPoints: "待", nextCheck: "心超" },
      { name: "冠心病", reason: "无", distinguishingPoints: "无", nextCheck: "心电图" },
    ],
  },
  pathogenesis: {
    summary: "肺脾气虚，宗气不足",
    locationDifferentiation: { items: ["肺", "脾"], details: [], resolution: "bounded", resolutionReason: "", evidence: {} },
    natureDifferentiation: { items: ["气虚"], rootDeficiency: ["气虚"], branchExcess: [], basis: "", resolution: "bounded", resolutionReason: "", evidence: {} },
    symptomClusters: [], caseRelationship: { rootPattern: "肺脾气虚", mainManifestation: "喘证", relationship: "宗气不足致动则气促" },
    chain: [{ nodeId: "P1", patientFact: "上楼两层即气促", syndromeEvidence: "上楼两层即气促", pathogenesis: "肺脾气虚，宗气不足", therapyDirection: "补益肺脾", evidence: {} }],
    uncertainties: [],
  },
  therapy: { overallPrinciple: "虚则补之", overallMethod: "补益肺脾", subTherapies: [{ therapy: "补益肺脾", targetPathogenesis: "肺脾气虚", priority: "主要", evidence: {} }] },
  formula: null, nonPharma: null,
  lineageAdaptation: { schemaVersion: "tcm-cdss-reasoning-v2", lineageCode: "unrestricted", label: "不限定", applicable: "partial", applicabilityReason: "", influencedDecisions: [], unaffectedBySafety: [], safetyDeference: "" },
  management: { mustCollect: [], followupSafetyNet: "气促加重、夜间不能平卧或出现胸痛时立即就诊。" },
};

const boundedOutput = unwrap(applyM03AdvisoryQualityBoundaries(wrap(m03WithThinDifferentials), CLINICAL_CONTEXT));
const boundedPrimary = boundedOutput.westernDiagnosis.primary;
assert.equal(boundedPrimary.differentials?.length ?? boundedOutput.westernDiagnosis.differentials.length, 0,
  "本用例的两项鉴别都不达展示门槛，应被过滤空——否则这条断言没有意义");
assert.equal(boundedPrimary.confidence, "低",
  "西医鉴别被删空后必须降置信度：静默变短会把不完整结论以完整结论的外观交给医生");
assert.ok(
  (boundedPrimary.limitations || []).some((item) => /鉴别/.test(String(item))),
  "必须写入一条医生可见的说明，告诉医生本次没有形成鉴别分析",
);

// 未被删空时不得误降级。
const healthyDifferentials = JSON.parse(JSON.stringify(m03WithThinDifferentials));
healthyDifferentials.westernDiagnosis.differentials = [
  { name: "心功能不全", reason: "活动后气促可为心源性", distinguishingPoints: "本例夜间可平卧且否认胸痛", nextCheck: "心超" },
];
const healthyOutput = unwrap(applyM03AdvisoryQualityBoundaries(wrap(healthyDifferentials), CLINICAL_CONTEXT));
assert.equal(healthyOutput.westernDiagnosis.differentials.length, 1, "达标的鉴别项必须保留");
assert.notEqual(healthyOutput.westernDiagnosis.primary.confidence, "低",
  "鉴别项健在时不得因为下限守卫而误降置信度");

// ── 2) 「鉴别遗漏」定位标签与方向对称的修复引导 ────────────────────────────────
const differentialOmissionReview = {
  status: "repair",
  issueCode: "tcm_reasoning_unsupported",
  repairInstruction: "differentials 未覆盖心功能不全与冠心病等心源性方向，需补充。",
};
assert.deepEqual(
  m03DiagnosticRepairGuidanceCodes(differentialOmissionReview),
  ["differential_omission"],
  "复核器报告鉴别遗漏时必须能被分类——否则它既进不了遥测，也无法参与修复策略选择",
);
const omissionGuidance = boundedM03DiagnosticRepairGuidance(differentialOmissionReview, { hasCurrentPositiveFacts: true });
assert.match(omissionGuidance, /只补不删/, "遗漏类意见的修复引导方向必须是补入，不能是删减");
assert.match(omissionGuidance, /differentials/, "引导必须指明要补的字段");
assert.doesNotMatch(omissionGuidance, /硬性删减/,
  "纯遗漏意见不得落进以删减为首行的策略：模型照做只会删得更多，漏掉的方向仍不在结果里");
assert.doesNotMatch(omissionGuidance, /心功能不全|冠心病/,
  "复核器原文与患者事实必须留在服务端下发的修复引导之外");

// 越界与遗漏并存时，仍以删减策略为准——越界是安全承重的一侧。
const mixedReview = {
  status: "repair",
  issueCode: "tcm_reasoning_unsupported",
  repairInstruction: "differentials 未覆盖心源性方向；同时 pathogenesis.chain 写入血瘀但无患者事实支撑。",
};
const mixedCodes = m03DiagnosticRepairGuidanceCodes(mixedReview);
assert.ok(mixedCodes.includes("differential_omission") && mixedCodes.includes("blood_stasis_overreach"),
  "混合意见必须同时被两类标签识别");
assert.match(
  boundedM03DiagnosticRepairGuidance(mixedReview, { hasCurrentPositiveFacts: true }),
  /硬性删减/,
  "越界与遗漏并存时必须优先处理越界——它写进了没有患者事实支撑的结论",
);

// ── 3) 病机节点覆盖：只防多不防少的反方向守卫 ────────────────────────────────
const COVERAGE_PRIOR = {
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
  overview: { primarySyndrome: "脾胃虚弱证", overallPathogenesis: "脾胃虚弱，运化无力", primarySyndromeBasis: ["食少倦怠", "大便溏薄"], recommendedFormulaNames: [], formulaSelectionMode: "self_devised", recommendedFormulaDirection: "辨证组方" },
  pathogenesis: { chain: [
    { nodeId: "P1", patientFact: "食少倦怠", syndromeEvidence: "食少倦怠", pathogenesis: "脾胃虚弱，运化无力", therapyDirection: "健脾益气" },
    { nodeId: "P2", patientFact: "大便溏薄", syndromeEvidence: "大便溏薄", pathogenesis: "脾虚湿盛", therapyDirection: "健脾化湿" },
  ] },
  therapy: { overallPrinciple: "虚则补之", overallMethod: "健脾益气，化湿和中", subTherapies: [{ therapy: "健脾益气", targetPathogenesis: "脾胃虚弱", priority: "主要" }] },
  westernDiagnosis: { primary: { name: "功能性消化不良", supportingFacts: ["食少倦怠"] }, differentials: [] },
};
const herb = (name, dose, role, targetRef, prescriptionRole, targetPathogenesis, fn) => ({
  name, dose, role, prescriptionRole, targetKind: "pathogenesis_node", targetRef,
  structureRole: null, targetPathogenesis, function: fn, decoctionRequirement: "",
});
const coverageCandidate = (herbs) => ({
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe",
  overview: { primarySyndrome: "脾胃虚弱证", overallPathogenesis: "脾胃虚弱，运化无力" },
  therapy: { overallPrinciple: "虚则补之", overallMethod: "健脾益气，化湿和中" },
  nonPharma: { diet: "清淡饮食", lifestyle: "规律作息", emotion: "调畅情志", precautions: ["忌生冷"], tcmTreatments: [] },
  formula: { modifications: [], candidates: [{
    name: "本例辨证组方", formulaNames: [], constructionType: "self_devised", therapyMatch: "健脾益气，化湿和中",
    herbs: [...herbs, {
      name: "炙甘草", dose: "6g", role: "使", prescriptionRole: "调和诸药", targetKind: "formula_structure",
      targetRef: "FORMULA_STRUCTURE", structureRole: "harmonize", targetPathogenesis: "调和诸药，协调药性",
      function: "补脾和胃，益气复脉", decoctionRequirement: "",
    }],
    decoction: { doseCount: "5剂", course: "5日", dosesPerDay: 1, administrationTimesPerDay: 2, method: "每日1剂，冷水浸泡30分钟，煎煮2次，合并药液约400mL，每日分2次服", followUpNode: "5日复诊" },
  }] },
});

const uncovered = coverageCandidate([
  herb("党参", "12g", "君", "P1", "补脾益气", "脾胃虚弱，运化无力", "补脾益气"),
  herb("白术", "10g", "臣", "P1", "健脾益气", "脾胃虚弱，运化无力", "健脾益气，燥湿利水"),
]);
assert.equal(m03NodeCoverageIssue(uncovered, COVERAGE_PRIOR), "pathogenesis_node_uncovered_P2",
  "M03 声明了治法方向的病机节点没有任何药味承接时，必须被检出");
assert.equal(
  m04SemanticIssue(uncovered, "", COVERAGE_PRIOR, isKnownTcmHerbName, true, true, false, true, "食少倦怠；大便溏薄"),
  "pathogenesis_node_uncovered_P2",
  "覆盖不足必须进入完整合同——此前它在全仓库不存在，一张无视 P2 的处方能通过每一道检查",
);
assert.equal(rejectionTier("m04_pathogenesis_node_uncovered_P2"), "T2",
  "覆盖不足不影响这张方能否安全服用，应带批注受理而不是驳回");
assert.equal(
  m04SafetyContractIssue(uncovered, COVERAGE_PRIOR, isKnownTcmHerbName, false, false, "食少倦怠；大便溏薄"),
  undefined,
  "T1 硬门不应被覆盖不足触发",
);
assert.ok(
  structuredClinicalRepairHint("prescribe", "m04_pathogenesis_node_uncovered_P2").includes("P2"),
  "修复引导必须点名是哪个节点没被覆盖",
);

const covered = coverageCandidate([
  herb("党参", "12g", "君", "P1", "补脾益气", "脾胃虚弱，运化无力", "补脾益气"),
  herb("茯苓", "12g", "臣", "P2", "利水渗湿", "脾虚湿盛", "利水渗湿，健脾"),
]);
assert.equal(m03NodeCoverageIssue(covered, COVERAGE_PRIOR), undefined, "每个节点都有药味承接时不得误报");

// 没有治法方向的节点不要求药味承接。
const priorWithBareNode = JSON.parse(JSON.stringify(COVERAGE_PRIOR));
priorWithBareNode.pathogenesis.chain[1].therapyDirection = "";
assert.equal(m03NodeCoverageIssue(uncovered, priorWithBareNode), undefined,
  "只描述病程或限制条件、未声明治法方向的节点不要求药味承接");

// ── 结构断言：三处同构过滤必须都带下限守卫 ────────────────────────────────────
const summarySource = readFileSync(new URL("../src/lib/diagnosis-visible-summary.ts", import.meta.url), "utf8");
const advisoryBody = summarySource.slice(
  summarySource.indexOf("export function applyM03AdvisoryQualityBoundaries"),
  summarySource.indexOf("export function normalizeM03TcmRationaleEvidenceBoundary"),
);
assert.ok(advisoryBody.includes("displayableDifferentials"),
  "西医鉴别过滤必须把过滤前后的结果分开持有，才能判断是否被删空");
for (const guard of ["submittedDifferentials.length > 0 && displayableDifferentials.length === 0", "tcmDifferentials.length === 0", "supportingFacts as unknown[]).length === 0"]) {
  assert.ok(advisoryBody.includes(guard), `同构过滤缺少下限守卫：${guard}`);
}

console.log(JSON.stringify({ suite: "guard-symmetry", asymmetriesLocked: 3, failures: 0 }, null, 2));
