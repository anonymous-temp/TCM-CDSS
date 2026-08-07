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
import { ReasoningV2Schema } from "../src/lib/diagnosis-types.ts";
import { NON_DOSE_PRESCRIPTION_MARKER, buildSafetyLimitedPrescription, isNonDosePrescriptionText } from "../src/lib/diagnosis-safety.ts";
import { boundedM03DiagnosticRepairGuidance, m03DiagnosticRepairGuidanceCodes } from "../src/lib/m03-diagnostic-review.ts";
import { structuredClinicalRepairHint } from "../src/lib/structured-clinical-repair.ts";
import { synchronizeEditedCandidate } from "../src/lib/prescription-revision.ts";
import { clinicalTextForDisplay, isDisplayableClinicalText } from "../src/lib/diagnosis-client-guards.ts";
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

// ── 4) finalize 复验的作用域必须与 finalize 链路**实际接管的东西**一致 ──────────
//
// 2026-08-06 生产实测：26% 的病例 M04 返回 200 却没有候选方，退化成非剂量页。
// 根因是自我否决——finalize 链路先无条件跑 applyDeterministicDecoctionMethod /
// applyDeterministicFollowUpNode 接管煎服法与复诊节点，紧接着却用
// serverOwnsDecoctionMethod=false 复验，等于拿「模型没写全煎服法」这条判据
// 去否决服务端自己刚写的那段文字。同一份内容实测：
//   serverOwns=false → visible_method_incomplete_negated_or_unresolved
//   serverOwns=true  → 无任何问题
// 而该码在 rejectionTier 里属 T3（展示层同步，最轻一档），却把已通过安全合同、
// 已过独立复核的整张处方清零。
//
// 排障之所以卡住，是因为归因函数 structuredRejectionReason 传的一直是 true，
// 日志只打得出 resolver_rejected（「拒了但说不出为什么」）——两处判据不同源。
// 本条同时钉住机制与调用点。
{
  const apiSource = readFileSync(new URL("../src/lib/diagnosis-api.ts", import.meta.url), "utf8");
  const finalizeCall = apiSource.slice(
    apiSource.indexOf('if (opts.structuredStage === "prescribe" && !validatedStructuredReasoning('),
    apiSource.indexOf('console.warn("[tcm-cdss:model] finalized structured response rejected"'),
  );
  assert.ok(finalizeCall.length > 0, "未定位到 finalize 复验调用点");
  assert.ok(!/\n\s+false,\n/.test(finalizeCall.split("opts.structuredPriorReasoning,")[1] || ""),
    "finalize 复验仍以 serverOwnsDecoctionMethod=false 调用，会否决服务端自己写的煎服法");

  // 投影确实无条件执行——否则上面的断言就是在为一个不成立的前提放宽判据。
  const projectionBlock = apiSource.slice(
    apiSource.indexOf('if (opts.structuredStage === "prescribe") {\n            authoritativeContent = applyDeterministicFormulaReferences'),
    apiSource.indexOf("synchronizeVisibleClinicalSummary(authoritativeContent, opts.structuredStage"),
  );
  for (const projection of ["applyDeterministicDecoctionMethod", "applyDeterministicFollowUpNode"]) {
    assert.ok(projectionBlock.includes(projection),
      `${projection} 不在 finalize 链路里，serverOwns=true 的前提不再成立`);
  }

  // 分级层：该码属**展示层同步**（T3，最轻一档）。钉住它的档位，是为了让后来人看清
  // 这次事故的量级——一个 T3 码把整张已通过安全合同的处方清零了。
  // finalize 目前是布尔校验、不查分级表；档位若被上调，说明有人重新把它当成了安全项，
  // 那时这条断言先红。
  assert.equal(rejectionTier("m04_visible_method_incomplete_negated_or_unresolved"), "T3",
    "煎服法展示不完整属展示层同步问题，不得升格为安全级拒绝");
  assert.equal(rejectionTier("m04_visible_method_incomplete"), "T3");
}

// 4) 长度维度的不对称：契约给每个数组写了 `.max(N)`，但那一侧的语义是**整段清空而非截断**，
//    而服务端自产数组的生成侧没有对称的 slice。于是「服务端写多了」不是降级，是让整节消失，
//    且因为 `.catch()` 让 safeParse 成功，不产驳回码、不驱动修复轮、不进日志。
//    实测三例：textualModifications 逍遥散 8 条 / 小柴胡汤 7 条（上限 6）→ 归一后 0 条；
//    terminologyMappings 生产侧 MAX_TARGETS_PER_CALL=24（上限 20）→ 结论最丰富的病例反而
//    完全拿不到国标术语双显；modificationReview.submittedCount 取原始行数不钳制（上限 30）→
//    31 条**可选**随症加减把整份 M04 判成 T1 硬拒且无修复引导。
//    classicEvidence 早在 2026-08-05 就为此加了 slice，但没人把它推广到兄弟字段——因为没有
//    任何信号会提醒有人漏了。这条断言就是那个信号：写入侧的硬上限必须 ≤ 契约上限。
{
  /** 从契约自身内省出有界数组的上限，不手抄常量——schema 调小时本断言自动跟着变严。 */
  function boundedArrayLimits(rootSchema) {
    const limits = new Map();
    const defOf = (node) => node?._def || node?.def || {};
    const unwrap = (node) => {
      let current = node;
      for (let depth = 0; depth < 24 && current; depth += 1) {
        if (current.shape) return current;
        const def = defOf(current);
        const inner = def.innerType
          || (defOf(def.in).type === "transform" ? def.out : undefined)
          || def.in || def.schema;
        if (!inner) return current;
        current = inner;
      }
      return current;
    };
    const arrayMax = (node) => {
      let current = node;
      for (let depth = 0; depth < 24 && current; depth += 1) {
        const def = defOf(current);
        if (def.type === "array") {
          const bound = def.checks?.map((entry) => entry?._zod?.def ?? entry?.def ?? entry)
            .find((entry) => entry?.check === "max_length" || typeof entry?.maximum === "number");
          return typeof bound?.maximum === "number" ? bound.maximum : undefined;
        }
        const inner = def.innerType
          || (defOf(def.in).type === "transform" ? def.out : undefined)
          || def.in || def.schema;
        if (!inner) return undefined;
        current = inner;
      }
      return undefined;
    };
    /** 数组元素的真身，用来继续往下走（路径不带 `[]`，与写入侧常量的登记口径一致）。 */
    const elementOf = (node) => {
      let current = node;
      for (let depth = 0; depth < 24 && current; depth += 1) {
        const def = defOf(current);
        if (def.type === "array") return def.element;
        const inner = def.innerType
          || (defOf(def.in).type === "transform" ? def.out : undefined)
          || def.in || def.schema;
        if (!inner) return undefined;
        current = inner;
      }
      return undefined;
    };
    const walk = (node, prefix, depth) => {
      if (depth > 6) return;
      const shape = unwrap(node)?.shape;
      if (!shape) return;
      for (const [key, child] of Object.entries(shape)) {
        const path = prefix ? `${prefix}.${key}` : key;
        const max = arrayMax(child);
        if (typeof max === "number") limits.set(path, max);
        // 数组要继续往元素里走，否则 formula.candidates 下的 classicEvidence /
        // textualModifications 这些「候选内数组」根本进不了台账——而它们正是出事的那一批。
        const element = elementOf(child);
        walk(element || child, path, depth + 1);
      }
    };
    walk(rootSchema, "", 0);
    return limits;
  }

  const limits = boundedArrayLimits(ReasoningV2Schema);
  assert.ok(limits.size > 20, `契约内省只找到 ${limits.size} 个有界数组，内省判据已与 zod 版本漂移`);

  // 服务端写入侧的硬上限常量 → 它写进的契约字段。新增一处「服务端自己决定写几条」的地方，
  // 就在这里报到；不报到就等于默认它不会超限，而这正是这一族缺陷反复出现的方式。
  const WRITE_SIDE_LIMITS = [
    ["src/lib/tcm-formula-provenance.ts", "CANDIDATE_CLASSIC_EVIDENCE_LIMIT", "formula.candidates.classicEvidence"],
    ["src/lib/tcm-formula-provenance.ts", "CANDIDATE_TEXTUAL_MODIFICATION_LIMIT", "formula.candidates.textualModifications"],
    ["src/lib/controlled-semantic-normalization.server.ts", "MAX_TARGETS_PER_CALL", "terminologyMappings"],
    ["src/lib/m04-proposal-compiler.ts", "MODIFICATION_REVIEW_COUNT_LIMIT", "formula.modifications"],
  ];

  for (const [file, constName, contractPath] of WRITE_SIDE_LIMITS) {
    const source = readFileSync(file, "utf8");
    const match = new RegExp(`const ${constName} = (\\d+);`).exec(source);
    assert.ok(match, `${file} 里找不到 ${constName}——写入侧上限被改名或删除，本断言失去覆盖`);
    const writeLimit = Number(match[1]);
    const contractLimit = limits.get(contractPath);
    assert.equal(typeof contractLimit, "number", `契约里找不到 ${contractPath} 的数组上限`);
    assert.ok(
      writeLimit <= contractLimit,
      `${constName}=${writeLimit} 超过契约 ${contractPath} 的上限 ${contractLimit}；` +
        "该字段超限的语义是**整段清空而非截断**，医生会一条都看不到，且不产任何驳回码",
    );
  }

  // modificationReview.submittedCount 不是数组，单独钉一条：它的 .max(30) 没有 catch，
  // 超限会让整份 M04 拒收，所以生成侧的钳制常量必须与它同源。
  const compilerSource = readFileSync("src/lib/m04-proposal-compiler.ts", "utf8");
  assert.ok(
    /submittedCount: Math\.min\(value\.length, MODIFICATION_REVIEW_COUNT_LIMIT\)/.test(compilerSource),
    "submittedCount 未钳到契约上限：31 条可选随症加减会把整份 M04 判成硬拒且无修复引导",
  );
}

// 5) 「同一个前提，两处判据各写各的」——降级块的**入口门**与**受理判据**必须认同一组到达方式。
//    m04-repair-policy.ts 的 canAcceptTransparentFormulaFallback 第一个条件是
//    `completedRepairAttempts >= 1 || repairExhausted`，而 diagnosis-api.ts 的入口门原先只认
//    三个耗尽标志、不认 completedAttempts。缝隙的代价是空白处方页：修复轮真的跑过 1~2 轮、
//    候选逐味剂量/配伍/君臣/病机引用全通过，只因最后一次复核仍判 repair 且三个标志都没置上，
//    连降级资格都拿不到。线上实测（2026-08-07，50 例验收）10 例 final_contract_rejected 中
//    5 例是这个形状，日志里连一行 transparent fallback 都没有。
{
  const apiSource = readFileSync("src/lib/diagnosis-api.ts", "utf8");
  const policySource = readFileSync("src/lib/m04-repair-policy.ts", "utf8");

  // 用块内那句独有的注释锚定，避免与上方另一处 structuredSentinelIncomplete 判断混淆。
  const gateAnchor = apiSource.indexOf("放开的只是**入口**");
  assert.ok(gateAnchor > 0, "未定位到透明降级块的入口门（锚定注释已被改写，请同步本断言）");
  const gate = apiSource.slice(gateAnchor, apiSource.indexOf("opts.structuredPriorReasoning", gateAnchor));
  assert.ok(gate.length > 0, "未定位到透明降级块的入口门");
  assert.ok(
    /m04RepairState\.completedAttempts >= 1/.test(gate),
    "降级入口门不认「已完成过修复轮」，而受理判据认——同一前提两处判据分叉，" +
      "已跑过修复的候选会连降级资格都拿不到，终点是空白处方页",
  );
  assert.ok(
    /completedRepairAttempts >= 1/.test(policySource),
    "受理判据不再认 completedRepairAttempts，入口门与它的对称性断言失去意义，请一并复核",
  );
}

// 6) 非剂量处方页的「机器标记」与「文案清单」不同集：服务端渲染时写标记，判定却只认手写文案。
//    m04-deterministic-fallback 的确定性兜底页（M03 锁定方基准组成 + 逐味药典剂量区间 +
//    特殊人群提醒）带了标记、也写了自己的声明句，但那句从未登记进清单 →
//    isNonDosePrescriptionText 返回 false → 客户端 expectedNonDoseLimitedPrescription 为 false
//    → 整页被当成合同不完整丢弃，替换成「本次未形成可核验的完整药味与剂量」并报错。
//    **该功能的立项理由就是消灭空白页，结果它自己产出的页在生产上从未出厂过**，
//    而「重新生成」按钮打的是同一条确定性路由，必然再败。
//    已改为标记优先。本断言钉住两件事：标记是唯一常量（不得再出现字面量副本），
//    以及**每一个服务端非剂量页都必须通过该判定**。
{
  const safetySource = readFileSync("src/lib/diagnosis-safety.ts", "utf8");
  const fallbackSource = readFileSync("src/lib/m04-deterministic-fallback.ts", "utf8");

  assert.ok(
    /export const NON_DOSE_PRESCRIPTION_MARKER/.test(safetySource),
    "非剂量标记未提为具名导出常量，各处会重新出现字面量副本",
  );
  assert.ok(
    /if \(text\.includes\(NON_DOSE_PRESCRIPTION_MARKER\)\) return true;/.test(safetySource),
    "isNonDosePrescriptionText 不再标记优先——带标记的服务端页会因文案未登记而被整页丢弃",
  );
  // 常量定义处自然含一次字面量；其余任何位置再出现都是副本。
  const marker = '"<!-- CDSS_NON_DOSE_PRESCRIPTION -->"';
  assert.equal(
    safetySource.split(marker).length - 1, 1,
    "diagnosis-safety.ts 里标记字面量不止一处——常量定义之外的都是会各自漂移的副本",
  );
  assert.equal(
    fallbackSource.split(marker).length - 1, 0,
    "m04-deterministic-fallback.ts 仍有标记字面量副本，请改用 NON_DOSE_PRESCRIPTION_MARKER",
  );

  // 行为级：真跑两个服务端非剂量页，断言判定都认得。
  const limitedPage = buildSafetyLimitedPrescription({
    status: "needs_information", allowDiagnosis: true, allowDosePrescription: false,
    action: "complete_before_prescription", missingItems: ["候选方药完整性"], redFlags: [],
    reasons: ["尚有处方安全信息需要核实"],
  });
  assert.ok(
    isNonDosePrescriptionText(limitedPage),
    "buildSafetyLimitedPrescription 产出的非剂量页未被 isNonDosePrescriptionText 认出",
  );
  assert.ok(
    limitedPage.includes(NON_DOSE_PRESCRIPTION_MARKER),
    "buildSafetyLimitedPrescription 未写入非剂量标记",
  );
}

// 7) fixpoint 早退的「可豁免族」正则裸写 `transparent_therapy`，把明确不可豁免的
//    contract_missing / herbs_missing 也算了进去 → 提前退出修复轮，然后在受理侧被拒、整方作废。
//    省下的那一轮恰恰是唯一可能修好它的一轮（结构缺失正是多修一轮有可能补齐的东西）。
//
//    ⚠ 这个族**故意宽于** isWaivableM04TherapyCoverageCode，两者不是同集：
//    这里的 reason 来自 waive=false 的真实驳回，unsupported_high_impact 在此可能只是词表缺口；
//    那边只见 waive=true 口径下的码，同名码在那里必然是方向对立。判据不同是因为输入总体不同。
//    我曾按「必须同集」把两处并成一处，那是 fail-open 回归（让附子进热证），已实测拦下并回退。
{
  const apiSource = readFileSync("src/lib/diagnosis-api.ts", "utf8");
  const familyLine = apiSource.match(/const M04_WAIVABLE_FAMILY = [^\n]*/)?.[0] || "";
  assert.ok(familyLine, "fixpoint 可豁免族常量不见了");
  assert.ok(
    !/transparent_therapy(?![_a-z])/.test(familyLine),
    "fixpoint 族又裸写了 transparent_therapy——contract_missing / herbs_missing 会被误判为可豁免",
  );
  assert.ok(
    /transparent_therapy_\(\?:coverage\|herb_support\|herb_knowledge_missing\|herb_\\d\)/.test(familyLine),
    "fixpoint 族没有把 transparent_therapy_* 收窄到具体码",
  );
  // 行为级：结构缺失类不得触发提前退出，词表覆盖率类应当触发。
  const family = new RegExp(familyLine.replace(/^const M04_WAIVABLE_FAMILY = \//, "").replace(/\/;$/, ""));
  for (const reason of ["m04_transparent_therapy_contract_missing", "m04_candidate_0_transparent_therapy_herbs_missing"]) {
    assert.ok(!family.test(reason), `${reason} 属结构缺失，不得提前退出修复轮`);
  }
  for (const reason of ["m04_candidate_0_transparent_therapy_coverage",
    "m04_candidate_0_transparent_therapy_herb_2_unsupported_high_impact_yang_warm",
    "m04_pathogenesis_node_uncovered_P2"]) {
    assert.ok(family.test(reason), `${reason} 应被同族 fixpoint 判定覆盖，否则白烧一轮`);
  }
}

// 8) 医生编辑处方的同步逻辑有两份实现，**被测试覆盖的是没人调用的那一份**。
//    src/lib/prescription-revision.ts 有完整实现且被 test:clinical-grounding 逐条测过
//    （含「甘草 → 炙甘草 算改动而非一删一增」这条炮制名用例），但它在 src/ 里没有生产调用方；
//    真正跑在浏览器里的是 DiagnosisClient 内的私有副本，那份按 name.trim() 判同一味药。
//    后果：同一次编辑在两份实现下 baseFormulas.matchedIngredientCount、随证加减的保留/合成、
//    煎服法的删句范围三处结果都不同，而绿灯来自那份不出厂的实现。
//    已合并为一份。本断言钉住「客户端不得再长出私有副本」。
{
  const clientSource = readFileSync("src/app/diagnosis/DiagnosisClient.tsx", "utf8");
  for (const symbol of ["synchronizeEditedCandidate", "filterModificationsForEditedHerbs", "hasIncompleteEditedHerb"]) {
    assert.ok(
      !new RegExp(`^\\s*(?:function|const)\\s+${symbol}\\b`, "m").test(clientSource),
      `DiagnosisClient 又自己实现了 ${symbol}，会与 src/lib/prescription-revision.ts 漂开`,
    );
    assert.ok(
      new RegExp(`\\b${symbol}\\b`).test(clientSource),
      `DiagnosisClient 不再使用 ${symbol}——编辑后的候选方没有走同步逻辑`,
    );
  }
  assert.ok(
    /from "@\/lib\/prescription-revision"/.test(clientSource),
    "DiagnosisClient 没有从 prescription-revision 导入共享实现",
  );
  // 行为级：炮制名改动必须算「改动」而不是「一删一增」——这是两份实现分叉的具体表现。
  // 用 白芍→炒白芍：canonicalTcmHerbIdentity 收得住这一对。
  // ⚠ 已知未修：炙/蜜/姜/熟 这几个前缀在 canonicalTcmHerbIdentity 里**归不掉**
  //   （炙甘草/蜜黄芪/姜半夏/熟大黄 原样返回），所以那几味改动仍会被算成一删一增。
  //   那是归一表本身的缺口，影响面远大于本条（剂量解析同一条路），单独处置，不在此掩盖。
  const baseHerb = {
    name: "白芍", processing: null, dose: "9g", role: "臣", prescriptionRole: "敛阴和营",
    targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null,
    targetPathogenesis: "营卫不和", function: "敛阴和营", decoctionRequirement: null, isToxic: false,
    evidence: { evidenceLevel: "governed_rule", source: "《伤寒论》", confidence: "高" },
  };
  const candidate = {
    name: "桂枝汤", herbs: [baseHerb], baseFormulas: [{ name: "桂枝汤", source: "《伤寒论》", matchedIngredientCount: 1 }],
    formulaSource: { evidenceLevel: "governed_rule", source: "《伤寒论》", confidence: "高" },
    decoction: { method: "水煎服" }, therapyMatch: "解肌发表", applicable: "外感风寒", notApplicable: "热证",
  };
  const edited = synchronizeEditedCandidate(candidate, [{ ...baseHerb, name: "炒白芍" }]);
  assert.equal(
    edited.baseFormulas?.[0]?.matchedIngredientCount, 1,
    "炮制名改动被当成了「原方药味被删」——命中味数被错误清零，两份实现分叉的具体表现",
  );
  assert.equal(
    edited.herbs[0]?.verificationTier, "unverified_dose",
    "医生改过的药味没有掉出「已核验」档",
  );
}

// 9) 客户端展示过滤比服务端严，且是**整段丢弃**：套话与实质内容混在一句里时，整条一起消失。
//    实测：病机机制文本「肝阳上亢，风阳上扰清窍；判断把握度较低」→ 客户端
//    isDisplayableClinicalText 判 false → 症状群那一行整行被过滤（symptoms<2 ||
//    !isDisplayable(mechanism) ⇒ false）→ 医生看到空的病机区，且没有任何迹象表明这里本来有东西。
//    服务端同名函数不带这层过滤，所以导出的 HIS 方案里有、屏幕上没有。
//    已改为**从句粒度**剔除：套话从句去掉、其余保留，整段都是套话时才不显示。
{
  const mixed = "肝阳上亢，风阳上扰清窍；判断把握度较低。";
  assert.ok(
    isDisplayableClinicalText(mixed),
    "套话与实质内容混排时整段被判为不可显示——病机区会静默变空",
  );
  assert.equal(
    clinicalTextForDisplay(mixed), "肝阳上亢，风阳上扰清窍",
    "套话从句未被剔除，或连实质内容一起剔掉了",
  );
  for (const pureBoilerplate of ["判断把握度较低。", "当前为有限资料下的工作判断"]) {
    assert.ok(!isDisplayableClinicalText(pureBoilerplate), `整段套话 ${pureBoilerplate} 不应显示`);
  }
  assert.equal(
    clinicalTextForDisplay("肝郁化火，上扰心神。"), "肝郁化火，上扰心神。",
    "正常病机文本被改动了——过滤只应作用于套话从句",
  );
  // 展示侧必须真的用到剔除函数，否则套话会重新出现在屏幕上（另一个方向的回归）。
  assert.ok(
    /clinicalTextForDisplay\(item\.mechanism\)/.test(readFileSync("src/app/diagnosis/DiagnosisClient.tsx", "utf8")),
    "症状群机制文本没有走 clinicalTextForDisplay",
  );
}

console.log(JSON.stringify({ suite: "guard-symmetry", asymmetriesLocked: 10, failures: 0 }, null, 2));
