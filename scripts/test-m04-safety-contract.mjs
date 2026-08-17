/**
 * Invariant: M04「带批注受理」永远不能放行一张未经安全核验的剂量级处方。
 *
 * 为什么需要这个门。此前 diagnosis-rejection-tiers 里有一行 `if (code.startsWith("m04_")) return "T1"`，
 * 把 M04 的 60+ 个原因码全部等同于最高危级别：一条建议性中医治疗项目卡片的字段缺失，与附子超量
 * 一样会作废整张已通过剂量、十八反十九畏、特殊人群与审方的处方，医生拿到一页拒绝说明。
 * 分级让非安全项可以带批注受理，但分级本身**不是**安全判断——它只是把「文档合同」映射成
 * 「医生可见质量提示」。真正决定能不能受理的是 m04SafetyContractIssue 的完整重跑。
 *
 * 为什么重跑不能省。m04SemanticIssue 命中第一个问题就短路返回，而它的检查顺序**不反映临床严重度**：
 * nonPharma.tcmTreatments 的 15 个字段完整性检查排在剂量、配伍禁忌与特殊人群**之前**。实测（下方
 * shortCircuit 用例）：一张含甘草+甘遂的处方，只要同时带一条字段不全的治疗项目卡片，
 * m04SemanticIssue 返回的就是 non_pharma_treatment_0_incomplete——十八反与全部剂量检查根本没执行。
 * 只看拒绝码就受理，等于放行一张从未被安全检查过的处方。
 *
 * 因此本文件的每个危险用例都做两件事：单独出现时必须被 T1 硬门拦下；与一个会短路它的建议性缺陷
 * **同时**出现时，仍然必须被拦下。
 */
import assert from "node:assert/strict";
import { m04SafetyContractIssue, m04SemanticIssue } from "../src/lib/diagnosis-stage-contract.ts";
import { rejectionTier, qualityAnnotationCopy, shouldAcceptWithQualityAnnotation } from "../src/lib/diagnosis-rejection-tiers.ts";
import { isKnownTcmHerbName } from "../src/lib/tcm-knowledge.ts";
import { mergePrescriptionReviewItems } from "../src/lib/diagnosis-safety.ts";
import { readFileSync } from "node:fs";

const clone = (value) => JSON.parse(JSON.stringify(value));

const PRIOR = {
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "diagnose",
  overview: {
    primarySyndrome: "脾胃虚弱证",
    overallPathogenesis: "脾胃虚弱，运化无力",
    primarySyndromeBasis: ["食少倦怠", "大便溏薄"],
    recommendedFormulaNames: [],
    formulaSelectionMode: "self_devised",
    recommendedFormulaDirection: "按已锁定病机与治法辨证组方",
  },
  pathogenesis: {
    chain: [
      { nodeId: "P1", patientFact: "食少倦怠", syndromeEvidence: "食少倦怠", pathogenesis: "脾胃虚弱，运化无力", therapyDirection: "健脾益气" },
      { nodeId: "P2", patientFact: "大便溏薄", syndromeEvidence: "大便溏薄", pathogenesis: "脾虚湿盛", therapyDirection: "健脾化湿" },
    ],
  },
  therapy: {
    overallPrinciple: "虚则补之",
    overallMethod: "健脾益气，化湿和中",
    subTherapies: [{ therapy: "健脾益气", targetPathogenesis: "脾胃虚弱", priority: "主要" }],
  },
  westernDiagnosis: { primary: { name: "功能性消化不良", supportingFacts: ["食少倦怠"] }, differentials: [] },
};

const CLINICAL_CONTEXT = "食少倦怠；大便溏薄";

/** 一张干净的、同时通过 T1 硬门与完整合同的候选方。所有反例都在它之上注入单一缺陷。 */
const BASELINE = {
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "prescribe",
  overview: { primarySyndrome: "脾胃虚弱证", overallPathogenesis: "脾胃虚弱，运化无力" },
  therapy: { overallPrinciple: "虚则补之", overallMethod: "健脾益气，化湿和中" },
  nonPharma: { diet: "清淡饮食", lifestyle: "规律作息", emotion: "调畅情志", precautions: ["服药期间忌生冷"], tcmTreatments: [] },
  formula: {
    modifications: [],
    candidates: [{
      name: "本例辨证组方",
      formulaNames: [],
      constructionType: "self_devised",
      therapyMatch: "健脾益气，化湿和中",
      herbs: [
        { name: "党参", dose: "12g", role: "君", prescriptionRole: "补脾益气", targetKind: "pathogenesis_node", targetRef: "P1", structureRole: null, targetPathogenesis: "脾胃虚弱，运化无力", function: "补脾益气", decoctionRequirement: "" },
        { name: "白术", dose: "10g", role: "臣", prescriptionRole: "健脾燥湿", targetKind: "pathogenesis_node", targetRef: "P2", structureRole: null, targetPathogenesis: "脾虚湿盛", function: "健脾益气，燥湿利水", decoctionRequirement: "" },
        { name: "茯苓", dose: "12g", role: "佐", prescriptionRole: "利水渗湿", targetKind: "pathogenesis_node", targetRef: "P2", structureRole: null, targetPathogenesis: "脾虚湿盛", function: "利水渗湿，健脾", decoctionRequirement: "" },
        { name: "炙甘草", dose: "6g", role: "使", prescriptionRole: "调和诸药", targetKind: "formula_structure", targetRef: "FORMULA_STRUCTURE", structureRole: "harmonize", targetPathogenesis: "调和诸药，协调药性", function: "补脾和胃，益气复脉", decoctionRequirement: "" },
      ],
      decoction: {
        doseCount: "5剂", course: "5日", dosesPerDay: 1, administrationTimesPerDay: 2,
        method: "每日1剂，冷水浸泡30分钟，煎煮2次，合并药液约400mL，每日分2次服",
        followUpNode: "5日复诊",
      },
    }],
  },
};

const safety = (reasoning, context = CLINICAL_CONTEXT) =>
  m04SafetyContractIssue(reasoning, PRIOR, isKnownTcmHerbName, false, false, context);
const contract = (reasoning, context = CLINICAL_CONTEXT) =>
  m04SemanticIssue(reasoning, "", PRIOR, isKnownTcmHerbName, true, true, false, true, context);

assert.equal(safety(BASELINE), undefined, "baseline must pass the T1 hard gate");
assert.equal(contract(BASELINE), undefined, "baseline must pass the full contract");

// ── 建议性缺陷：必须被判为可受理（这正是本次改动要拿回来的东西）──────────────────
/** 每项注入一个**只影响说明或建议内容**的缺陷，安全面完全不动。 */
const ADVISORY_DEFECTS = [
  ["中医治疗项目卡片字段不全", (r) => { r.nonPharma.tcmTreatments = [{ projectCode: "acupuncture", targetRef: "P1" }]; }],
  ["候选方名缺失", (r) => { r.formula.candidates[0].name = ""; }],
  // 注意：清空 therapyMatch 触发的是 candidate_0_therapy_unaligned（整方方向与 M03 治法不符），
  // 那是真实的临床信号，default-deny 判它 T1 是正确的，不要把它放进本清单。
  ["药味配伍意义列为空", (r) => { r.formula.candidates[0].herbs[1].prescriptionRole = ""; }],
  ["药味功用列为空", (r) => { r.formula.candidates[0].herbs[1].function = ""; }],
  ["加减条目字段不全", (r) => { r.formula.modifications = [{ trigger: "", targetPathogenesis: "", action: "加陈皮", reason: "" }]; }],
];

for (const [label, injectDefect] of ADVISORY_DEFECTS) {
  const reasoning = clone(BASELINE);
  injectDefect(reasoning);
  const issue = contract(reasoning);
  assert.ok(issue, `${label}: 应当被完整合同检出，否则这条用例没有意义`);
  const tier = rejectionTier(`m04_${issue}`);
  assert.notEqual(tier, "T1", `${label}: ${issue} 被判为 T1，建议性内容不应拥有整份输出的一票否决权`);
  assert.equal(safety(reasoning), undefined, `${label}: T1 硬门不应被建议性缺陷触发`);
  assert.ok(
    shouldAcceptWithQualityAnnotation({
      rejectionReason: `m04_${issue}`,
      safetyIssue: safety(reasoning) || "",
      visibleDraftLength: 500,
      minimumDraftLength: 200,
    }),
    `${label}: ${issue} 应可带批注受理`,
  );
  const annotation = qualityAnnotationCopy(`m04_${issue}`);
  assert.ok(annotation && annotation.length >= 20, `${label}: 必须有面向医生的批注文案`);
  assert.doesNotMatch(annotation, /m0[34]_|[a-z]{4,}_[a-z]{4,}/, `${label}: 批注不得包含原因代码`);
}

// ── 危险缺陷：单独出现必须被拦；与建议性缺陷同时出现仍必须被拦 ──────────────────
/**
 * 短路遮蔽器。它排在 m04SemanticIssue 的最前面（nonPharma.tcmTreatments 循环），
 * 因此单独看拒绝码时会把后面所有安全检查的结果掩盖掉。
 */
const shortCircuitMask = (reasoning) => {
  reasoning.nonPharma.tcmTreatments = [{ projectCode: "acupuncture", targetRef: "P1" }];
};

const DANGEROUS_DEFECTS = [
  ["严管动物药（羚羊角）", (r) => {
    r.formula.candidates[0].herbs[0] = {
      ...r.formula.candidates[0].herbs[0], name: "羚羊角", dose: "1g",
      prescriptionRole: "平肝息风", function: "平肝息风，清肝明目，散血解毒",
    };
  }],
  ["十八反药对（甘草+甘遂）", (r) => {
    r.formula.candidates[0].herbs.push({
      name: "甘遂", dose: "1g", role: "佐", prescriptionRole: "泻水逐饮", targetKind: "pathogenesis_node",
      targetRef: "P2", structureRole: null, targetPathogenesis: "脾虚湿盛", function: "泻水逐饮", decoctionRequirement: "",
    });
    r.formula.candidates[0].herbs[3].name = "甘草";
  }],
  ["剂量超出安全上限", (r) => { r.formula.candidates[0].herbs[0].dose = "500g"; }],
  ["剂量不是可执行单值", (r) => { r.formula.candidates[0].herbs[0].dose = "适量"; }],
  ["药味未收载", (r) => { r.formula.candidates[0].herbs[1].name = "某某不存在的药"; }],
  ["未成立的高影响方向（清热）", (r) => {
    r.formula.candidates[0].herbs[2] = {
      name: "黄连", dose: "3g", role: "佐", prescriptionRole: "清热燥湿", targetKind: "pathogenesis_node",
      targetRef: "P2", structureRole: null, targetPathogenesis: "脾虚湿盛", function: "清热燥湿，泻火解毒", decoctionRequirement: "",
    };
  }],
  ["处方计划算术不自洽", (r) => { r.formula.candidates[0].decoction.dosesPerDay = 3; r.formula.candidates[0].decoction.administrationTimesPerDay = 1; }],
  ["M03 锁定字段漂移", (r) => { r.overview.primarySyndrome = "肝郁气滞证"; }],
  ["加减夹带未审方剂量", (r) => {
    r.formula.modifications = [{ trigger: "食少倦怠", targetPathogenesis: "脾胃虚弱，运化无力", action: "加陈皮9g", reason: "行气和胃", doseOrHandling: "9g" }];
  }],
  ["加减加入未收载药味", (r) => {
    r.formula.modifications = [{ trigger: "食少倦怠", targetPathogenesis: "脾胃虚弱，运化无力", action: "加某某不存在的药", reason: "行气和胃" }];
  }],
  ["候选方为空", (r) => { r.formula.candidates = []; }],
];

for (const [label, injectDefect] of DANGEROUS_DEFECTS) {
  const alone = clone(BASELINE);
  injectDefect(alone);
  const aloneSafety = safety(alone);
  assert.ok(aloneSafety, `${label}: 单独出现时 T1 硬门必须拦下`);
  assert.equal(rejectionTier(`m04_${aloneSafety}`), "T1", `${label}: ${aloneSafety} 必须分级为 T1`);
  assert.ok(
    !shouldAcceptWithQualityAnnotation({
      rejectionReason: `m04_${aloneSafety}`,
      safetyIssue: aloneSafety,
      visibleDraftLength: 500,
      minimumDraftLength: 200,
    }),
    `${label}: 绝不可带批注受理`,
  );

  // 与短路遮蔽器同时出现：完整合同会报建议性的那个码，硬门必须仍然报安全码。
  const masked = clone(BASELINE);
  injectDefect(masked);
  shortCircuitMask(masked);
  const maskedContract = contract(masked);
  const maskedSafety = safety(masked);
  assert.ok(maskedSafety, `${label}: 与建议性缺陷同时出现时，T1 硬门仍必须拦下`);
  assert.equal(
    maskedSafety,
    aloneSafety,
    `${label}: 硬门结论不得随建议性字段的状态变化——它必须穿透 m04SemanticIssue 的短路顺序`,
  );
  assert.ok(
    !shouldAcceptWithQualityAnnotation({
      rejectionReason: `m04_${maskedContract}`,
      safetyIssue: maskedSafety,
      visibleDraftLength: 500,
      minimumDraftLength: 200,
    }),
    `${label}: 即使完整合同报出的是建议性码（${maskedContract}），也绝不可受理`,
  );
}

// ── 遗漏保护：safetyIssue 未传入时必须 fail-closed ────────────────────────────
assert.equal(
  shouldAcceptWithQualityAnnotation({
    rejectionReason: "m04_non_pharma_treatment_0_incomplete",
    visibleDraftLength: 500,
    minimumDraftLength: 200,
  }),
  false,
  "漏传 safetyIssue 必须判为不可受理（缺省 safety_gate_not_evaluated）",
);

// ── default-deny：未登记的 M04 码一律 T1 ──────────────────────────────────────
assert.equal(rejectionTier("m04_some_future_check_nobody_classified"), "T1");
assert.equal(rejectionTier("m04_candidate_0_herb_1_dose"), "T1", "剂量永远是 T1");
assert.equal(rejectionTier("m04_candidate_0_high_risk_pair_incompatibility"), "T1", "配伍禁忌永远是 T1");
assert.equal(rejectionTier("m04_candidate_0_herb_1_decoction_missing_required"), "T1", "特殊煎法永远是 T1");
assert.equal(rejectionTier("m04_candidate_0_name"), "T2");
assert.equal(rejectionTier("m04_visible_extra_herb_rows"), "T3");

// 路由最后一公里不得把安全重算挂在“先有其他 issue”的分支内。这次真实回归里
// 甘草+海藻的全量合同因 advisory 口径返回 undefined，导致原本已存在的 T1 函数根本没被调用。
const prescribeRouteSource = readFileSync("src/app/api/diagnosis/prescribe/route.ts", "utf8");
const finalSafetyIndex = prescribeRouteSource.indexOf("const detectedSafetyIssue = m04SafetyContractIssue(");
const deferredLabelIndex = prescribeRouteSource.indexOf("const safetyIssue = isM04FinalizerDeferredLabelIssue(detectedSafetyIssue)");
const finalIssueIndex = prescribeRouteSource.indexOf("const issue = safetyIssue || formulaCompilationContractIssue");
assert.ok(finalSafetyIndex >= 0 && deferredLabelIndex > finalSafetyIndex && finalIssueIndex > deferredLabelIndex,
  "M04 最终出口必须先无条件重跑 safetyIssue，再进入质量合同分级");

const diagnosisApiSource = readFileSync("src/lib/diagnosis-api.ts", "utf8");
const advisoryPredicate = diagnosisApiSource.match(/function isM04AuditAdvisoryReason[\s\S]*?\n\}/)?.[0] || "";
assert.doesNotMatch(advisoryPredicate, /high_risk_pair_incompatibility/,
  "十八反药对不得进入后置审方 advisory 放行通道");

assert.deepEqual(
  mergePrescriptionReviewItems(
    ["过敏史", "当前用药"],
    ["当前用药", "语义红旗筛查未完成（模型超时）"],
  ),
  ["过敏史", "当前用药", "语义红旗筛查未完成（模型超时）"],
  "M04 信息完整性边界必须合并权限原因和安全门缺项，且保持稳定去重",
);

console.log(JSON.stringify({
  suite: "m04-safety-contract",
  advisoryDefects: ADVISORY_DEFECTS.length,
  dangerousDefects: DANGEROUS_DEFECTS.length,
  failures: 0,
}, null, 2));

// ─── herb_support 的有效范围：分母只算君臣，基准方组成计为支撑（阈值放宽+角色豁免同时执行）───
// 旧口径把佐使也算进 80% 分母，等于禁止君臣佐使结构本身：龙胆泻肝汤的当归（佐，养血防苦寒
// 伤阴）、甘草（使，调和诸药）按定义就不攻主病机。实测 10 例甲方测试病历中，M03 锁定命名方的
// 6 例里 5 例因此 0 味出方——越标准的经典方证越拿不到处方。
// 佐使并非失管：高影响方向门禁、配伍禁忌、剂量与特殊人群检查仍逐味执行（下方负例锁死这一点）。
{
  const { transparentFormulaTherapyIssue } = await import("../src/lib/diagnosis-stage-contract.ts");
  const { executableFormulaCompilationReferences } = await import("../src/lib/tcm-formula-provenance.ts");
  const prior = {
    stage: "diagnose",
    overview: { primarySyndrome: "肝胆湿热证", overallPathogenesis: "肝胆湿热，循经下注", recommendedFormulaNames: ["龙胆泻肝汤"] },
    pathogenesis: { chain: [
      { nodeId: "P1", patientFact: "口苦咽干", syndromeEvidence: "舌红苔黄腻", pathogenesis: "肝胆湿热", therapyDirection: "清肝泻火，利湿" },
    ] },
    therapy: { overallPrinciple: "清肝泻火，清利湿热", overallMethod: "清肝泻火，清利湿热", subTherapies: [] },
  };
  const ref = executableFormulaCompilationReferences(["龙胆泻肝汤"])[0];
  assert.ok(ref, "龙胆泻肝汤必须可编译");
  const ROLE = { 龙胆: "君", 酒黄芩: "臣", 栀子: "臣", 泽泻: "佐", 川木通: "佐", 盐车前子: "佐", 酒当归: "佐", 地黄: "佐", 柴胡: "佐", 甘草: "使" };
  const herbs = ref.ingredients.map((name) => ({
    name, dose: "10g", role: ROLE[name] || "臣", targetKind: "pathogenesis_node", targetRef: "P1",
    prescriptionRole: `${ROLE[name] || "臣"}药：清肝泻火，利湿`, targetPathogenesis: "清肝泻火，利湿",
  }));
  // 1) 透明降级（formulaNames 清空）后，经典方的完整君臣佐使结构必须能出方。
  assert.equal(
    transparentFormulaTherapyIssue({ stage: "prescribe", formula: { candidates: [{ name: "本例辨证组方", formulaNames: [], herbs, identityDeclassified: true }] } }, prior),
    undefined,
    "M03 锁定方的法定组成在降级后不得因佐使不攻主病机被判 herb_support",
  );
  // 2) 君药方向与锁定治法相反仍须驳回——角色豁免只放过佐使的"支撑率"，不放过任何一味的高影响方向。
  const opposing = {
    stage: "prescribe",
    formula: { candidates: [{ name: "本例辨证组方", formulaNames: [], herbs: [
      { name: "附子", dose: "6g", role: "君", targetKind: "pathogenesis_node", targetRef: "P1", prescriptionRole: "君药：温阳散寒", targetPathogenesis: "温阳散寒" },
      { name: "干姜", dose: "6g", role: "臣", targetKind: "pathogenesis_node", targetRef: "P1", prescriptionRole: "臣药：温中", targetPathogenesis: "温中" },
    ] }] },
  };
  assert.match(
    transparentFormulaTherapyIssue(opposing, prior) || "",
    /unsupported_high_impact_yang_warm/,
    "湿热证配温阳君臣必须仍被高影响门禁驳回",
  );
  // 3) 自拟方（无基准）且君臣全部脱离锁定方向时，支撑率仍须拦截——放宽不适用于无依据的凑方。
  const ungrounded = {
    stage: "prescribe",
    formula: { candidates: [{ name: "本例辨证组方", formulaNames: [], herbs: [
      { name: "酸枣仁", dose: "15g", role: "君", targetKind: "pathogenesis_node", targetRef: "P1", prescriptionRole: "君药：宁心安神", targetPathogenesis: "宁心安神" },
      { name: "远志", dose: "9g", role: "臣", targetKind: "pathogenesis_node", targetRef: "P1", prescriptionRole: "臣药：安神", targetPathogenesis: "安神" },
      { name: "柏子仁", dose: "9g", role: "臣", targetKind: "pathogenesis_node", targetRef: "P1", prescriptionRole: "臣药：养心安神", targetPathogenesis: "养心安神" },
    ] }] },
  };
  const priorNoBaseline = { ...prior, overview: { ...prior.overview, recommendedFormulaNames: [] } };
  assert.ok(
    transparentFormulaTherapyIssue(ungrounded, priorNoBaseline),
    "湿热证下全安神君臣的自拟方必须仍被拦截——豁免只属于基准方组成与佐使角色",
  );
}

// 基准组成豁免必须按药材身份比对：基准写饮片名（当归身/择细黄连），模型写规范名（当归/黄连），
// 字符串比对永远豁免不了——实测清胃散被锁定后它自己的当归仍被 blood_move 驳回、整方 0 味。
{
  const { transparentFormulaTherapyIssue } = await import("../src/lib/diagnosis-stage-contract.ts");
  const prior = {
    stage: "diagnose",
    overview: { primarySyndrome: "胃火炽盛证", overallPathogenesis: "胃火炽盛，循经上攻", recommendedFormulaNames: ["清胃散"] },
    pathogenesis: { chain: [{ nodeId: "P1", patientFact: "牙痛", syndromeEvidence: "舌红苔黄", pathogenesis: "胃火炽盛", therapyDirection: "清胃泻火" }] },
    therapy: { overallPrinciple: "清胃泻火", overallMethod: "清胃泻火", subTherapies: [] },
  };
  const herbs = [["黄连", "君"], ["升麻", "臣"], ["生地黄", "佐"], ["牡丹皮", "佐"], ["当归", "佐"]].map(([name, role]) => ({
    name, dose: "10g", role, targetKind: "pathogenesis_node", targetRef: "P1",
    prescriptionRole: `${role}药：清胃泻火`, targetPathogenesis: "清胃泻火",
  }));
  assert.equal(
    transparentFormulaTherapyIssue({ stage: "prescribe", formula: { candidates: [{ name: "本例辨证组方", formulaNames: [], herbs, identityDeclassified: true }] } }, prior),
    undefined,
    "模型按规范名写出的基准组成必须享受身份级豁免（当归 ↔ 基准的当归身）",
  );
}

// 高影响药侧触发收窄：润下兼功（润肠通便）与和血搭配（补血活血）不构成攻下/破血身份。
// 实测类：心脾两虚锁定归脾汤，透明降级后方中当归（不在《济生方》8 味基准里，享受不到基准豁免）
// 被判 unsupported_high_impact_blood_move_purge，整方 0 味。收窄后当归在补益方里放行；
// 真攻下（大黄）与独立活血（桃仁）在同一 prior 下照旧驳回——fail-closed 未放宽。
{
  const { transparentFormulaTherapyIssue, highImpactHerbDirectionIssue } = await import("../src/lib/diagnosis-stage-contract.ts");
  const prior = {
    stage: "diagnose",
    overview: { primarySyndrome: "心脾两虚证", overallPathogenesis: "心脾两虚，气血不足", recommendedFormulaNames: ["归脾汤"], formulaSelectionMode: "single" },
    pathogenesis: { chain: [{ nodeId: "P1", patientFact: "心悸失眠，食少倦怠", syndromeEvidence: "心脾两虚", pathogenesis: "心脾两虚，心神失养", therapyDirection: "补益心脾，养心安神" }] },
    therapy: { overallPrinciple: "补益心脾，养血安神", overallMethod: "健脾养心", subTherapies: [] },
  };
  const herbs = [
    ["黄芪", "君", "补气健脾", "pathogenesis_node", "P1"],
    ["人参", "君", "大补元气", "pathogenesis_node", "P1"],
    ["白术", "臣", "健脾益气", "pathogenesis_node", "P1"],
    ["当归", "臣", "养血补心", "pathogenesis_node", "P1"],
    ["酸枣仁", "佐", "养心安神", "pathogenesis_node", "P1"],
    ["远志", "佐", "宁心安神", "pathogenesis_node", "P1"],
    ["木香", "佐", "理气醒脾", "formula_structure", "FORMULA_STRUCTURE"],
    ["甘草", "使", "调和诸药", "formula_structure", "FORMULA_STRUCTURE"],
  ].map(([name, role, fn, targetKind, targetRef]) => ({
    name, dose: "10g", role, targetKind, targetRef,
    ...(targetKind === "formula_structure" ? { structureRole: fn } : {}),
    prescriptionRole: fn, targetPathogenesis: fn,
  }));
  assert.equal(
    transparentFormulaTherapyIssue({ stage: "prescribe", formula: { candidates: [{ name: "本例辨证组方", constructionType: "self_devised", formulaNames: [], herbs, identityDeclassified: true }] } }, prior),
    undefined,
    "润下兼功的当归在补益心脾透明降级方中必须放行（血中气药/和血，不是攻下与破血身份）",
  );
  assert.equal(
    highImpactHerbDirectionIssue("当归", "", prior),
    undefined,
    "当归未声明用途时也不得因『润肠通便/补血活血』记载被判高影响方向未成立",
  );
  assert.equal(
    highImpactHerbDirectionIssue("大黄", "泻下攻积", prior),
    "herb_0_unsupported_high_impact_purge",
    "真攻下药（大黄）在无泻下治法的补益证里必须照旧驳回",
  );
  assert.equal(
    highImpactHerbDirectionIssue("桃仁", "活血祛瘀", prior),
    "herb_0_unsupported_high_impact_blood_move",
    "独立活血药（桃仁）在无活血治法的补益证里必须照旧驳回",
  );
}

// 单味缺陷不得放大成整方作废：方向未成立的**实际加味**按单味确定性剔除。
// 与既有 dropUnsupportedM04ModificationDirections（加减建议侧）同构，补齐类的另一半。
// 实测（甲方 10 例，flash 生产构建）两例同类 0 味：麻黄汤基准 4/4 达标却多出川芎（blood_move）、
// 清胃散基准 4/5 达标却多出大黄（purge），修复轮未删该味，最终 fixpoint 退化非剂量输出。
{
  const { dropUnsupportedM04CandidateHerbs } = await import("../src/lib/m04-modification-safety.ts");
  const S = "<!-- DIAGNOSIS_JSON_START -->", E = "<!-- DIAGNOSIS_JSON_END -->";
  const priorMahuang = {
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
    overview: { primarySyndrome: "风寒束表证", recommendedFormulaNames: ["麻黄汤"], formulaSelectionMode: "single" },
    pathogenesis: { chain: [{ nodeId: "P1", pathogenesis: "风寒束表，卫阳被遏", therapyDirection: "辛温解表，宣肺平喘" }] },
    therapy: { overallPrinciple: "辛温解表，宣肺平喘", overallMethod: "辛温解表" },
  };
  const wrapHerbs = (herbs) => `${S}\n${JSON.stringify({
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe",
    formula: { candidates: [{ name: "麻黄汤加减", formulaNames: ["麻黄汤"], herbs }] },
  })}\n${E}`;
  const herbRow = (name, role, fn) => ({
    name, dose: "9g", role, targetKind: "pathogenesis_node", targetRef: "P1", prescriptionRole: fn,
  });
  const retainedNames = (content) =>
    JSON.parse(content.split(S)[1].split(E)[0]).formula.candidates[0].herbs.map((herb) => herb.name);
  const baseline = [
    herbRow("麻黄", "君", "发汗解表"), herbRow("桂枝", "臣", "解肌发表"),
    herbRow("杏仁", "佐", "宣肺平喘"), herbRow("甘草", "使", "调和诸药"),
  ];
  assert.deepEqual(
    retainedNames(dropUnsupportedM04CandidateHerbs(wrapHerbs([...baseline, herbRow("川芎", "佐", "活血行气")]), priorMahuang)),
    ["麻黄", "桂枝", "杏仁", "甘草"],
    "方向未成立的非君非基准加味必须被单味剔除，保留完全合格的基准组成",
  );
  assert.deepEqual(
    retainedNames(dropUnsupportedM04CandidateHerbs(wrapHerbs(baseline), priorMahuang)),
    ["麻黄", "桂枝", "杏仁", "甘草"],
    "无未成立加味时必须原样返回，不得误删基准组成",
  );
  assert.deepEqual(
    retainedNames(dropUnsupportedM04CandidateHerbs(wrapHerbs([
      herbRow("大黄", "君", "泻下攻积"), herbRow("麻黄", "臣", "发汗解表"),
      herbRow("桂枝", "臣", "解肌"), herbRow("杏仁", "佐", "平喘"), herbRow("甘草", "使", "调和"),
    ]), priorMahuang)).length,
    5,
    "君药方向未成立必须走 emperor_therapy_mismatch 重选，绝不能被静默删除",
  );
  assert.deepEqual(
    retainedNames(dropUnsupportedM04CandidateHerbs(wrapHerbs([
      ...baseline, herbRow("大黄", "君", "泻下攻积"),
    ]), priorMahuang)),
    ["麻黄", "桂枝", "杏仁", "甘草"],
    "已有合格 P1 君药时，方向未成立的额外非基准君药必须被单味剔除",
  );
  assert.deepEqual(
    retainedNames(dropUnsupportedM04CandidateHerbs(wrapHerbs([
      herbRow("麻黄", "君", "发汗解表"), herbRow("川芎", "臣", "活血行气"), herbRow("大黄", "佐", "泻下"),
    ]), priorMahuang)).length,
    3,
    "剔除会让锁定基准跌破最低保留数时必须整体放弃剔除，回到既有驳回行为",
  );
}

// 单味缺陷不得放大成整方作废：方向未成立的**实际加味**按单味确定性剔除。
// 与 dropUnsupportedM04ModificationDirections（加减建议侧）是同一条不变量的两半。
// 实测（甲方 10 例 flash 生产构建）两例同类 0 味：麻黄汤基准 4/4 达标 + 川芎(blood_move)、
// 清胃散基准 4/5 达标 + 大黄(purge)，修复轮未删该味，fixpoint 后整方退化为非剂量。
{
  const { dropUnsupportedM04CandidateHerbs } = await import("../src/lib/m04-modification-safety.ts");
  const S = "<!-- DIAGNOSIS_JSON_START -->", E = "<!-- DIAGNOSIS_JSON_END -->";
  const priorMahuang = {
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
    overview: { primarySyndrome: "风寒束表证", recommendedFormulaNames: ["麻黄汤"], formulaSelectionMode: "single" },
    pathogenesis: { chain: [{ nodeId: "P1", pathogenesis: "风寒束表，卫阳被遏", therapyDirection: "辛温解表，宣肺平喘" }] },
    therapy: { overallPrinciple: "辛温解表，宣肺平喘", overallMethod: "辛温解表" },
  };
  const herb = (name, role, fn) => ({ name, dose: "9g", role, targetKind: "pathogenesis_node", targetRef: "P1", prescriptionRole: fn });
  const envelope = (herbs) => `${S}\n${JSON.stringify({
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe",
    formula: { candidates: [{ name: "麻黄汤加减", formulaNames: ["麻黄汤"], herbs }] },
  })}\n${E}`;
  const herbsAfter = (content) => JSON.parse(content.split(S)[1].split(E)[0]).formula.candidates[0].herbs.map((item) => item.name);
  const base = [herb("麻黄", "君", "发汗解表"), herb("桂枝", "臣", "解肌发表"), herb("杏仁", "佐", "宣肺平喘"), herb("甘草", "使", "调和诸药")];

  assert.deepEqual(
    herbsAfter(dropUnsupportedM04CandidateHerbs(envelope([...base, herb("川芎", "佐", "活血行气")]), priorMahuang)),
    ["麻黄", "桂枝", "杏仁", "甘草"],
    "方向未成立的非基准加味必须按单味剔除，保留合格的基准组成",
  );
  assert.deepEqual(
    herbsAfter(dropUnsupportedM04CandidateHerbs(envelope(base), priorMahuang)),
    ["麻黄", "桂枝", "杏仁", "甘草"],
    "全部合格时必须原样返回，不做任何删减",
  );
  assert.deepEqual(
    herbsAfter(dropUnsupportedM04CandidateHerbs(envelope([
      herb("大黄", "君", "泻下攻积"), herb("麻黄", "臣", "发汗解表"), herb("桂枝", "臣", "解肌"),
      herb("杏仁", "佐", "平喘"), herb("甘草", "使", "调和"),
    ]), priorMahuang)),
    ["大黄", "麻黄", "桂枝", "杏仁", "甘草"],
    "君药方向未成立必须走 emperor_therapy_mismatch 重选，绝不能靠删君药蒙混通过",
  );
  assert.deepEqual(
    herbsAfter(dropUnsupportedM04CandidateHerbs(envelope([
      herb("麻黄", "君", "发汗解表"), herb("川芎", "臣", "活血行气"), herb("大黄", "佐", "泻下"),
    ]), priorMahuang)),
    ["麻黄", "川芎", "大黄"],
    "剔除会使基准跌破最低保留数时必须放弃剔除，回到既有驳回行为",
  );
}

// 剔除的基准约束必须随「是否仍声称经典方身份」变化。
// 正常 finalize 路径：候选还挂着方名，削到身份下限以下比原驳回更糟 → 守住基准保留数。
// 透明降级路径：方名已被确定性剥离，基准不再是约束 —— 继续套用会让「基准本就不满足」的候选
// 放弃剔除，问题药留在方里、降级验证随即失败，最终仍是 0 味（实测感冒-风寒束表：前胡）。
{
  const { dropUnsupportedM04CandidateHerbs } = await import("../src/lib/m04-modification-safety.ts");
  const S = "<!-- DIAGNOSIS_JSON_START -->", E = "<!-- DIAGNOSIS_JSON_END -->";
  const prior = {
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
    overview: { primarySyndrome: "风寒束表证", recommendedFormulaNames: ["麻黄汤"], formulaSelectionMode: "single" },
    pathogenesis: { chain: [{ nodeId: "P1", patientFact: "恶寒发热无汗", syndromeEvidence: "脉浮紧", pathogenesis: "风寒束表", therapyDirection: "辛温解表，宣肺平喘" }] },
    therapy: { overallPrinciple: "辛温解表，宣肺平喘", overallMethod: "辛温解表" },
  };
  const herb = (name, role, fn) => ({ name, dose: "9g", role, targetKind: "pathogenesis_node", targetRef: "P1", prescriptionRole: fn });
  // 基准不满足（只有麻黄一味在基准内）且方中含方向未成立的前胡。
  const envelope = `${S}\n${JSON.stringify({
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe",
    formula: { candidates: [{ name: "麻黄汤加减", formulaNames: ["麻黄汤"], herbs: [
      herb("麻黄", "君", "发汗解表"), herb("荆芥", "臣", "祛风解表"), herb("防风", "臣", "祛风解表"),
      herb("前胡", "佐", "降气化痰，散风清热"),
    ] }] },
  })}\n${E}`;
  const namesOf = (content) => JSON.parse(content.split(S)[1].split(E)[0]).formula.candidates[0].herbs.map((h) => h.name);
  assert.deepEqual(namesOf(dropUnsupportedM04CandidateHerbs(envelope, prior, true)),
    ["麻黄", "荆芥", "防风", "前胡"],
    "仍声称经典方身份时，基准保留数不满足则放弃剔除（回到既有驳回行为）");
  assert.deepEqual(namesOf(dropUnsupportedM04CandidateHerbs(envelope, prior, false)),
    ["麻黄", "荆芥", "防风"],
    "透明降级路径不套用基准保留数，方向未成立的前胡必须被剔除，保留其余合格药味");
  const priorHeat = {
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
    overview: { primarySyndrome: "肝胃郁热证", recommendedFormulaNames: ["左金丸"], formulaSelectionMode: "single" },
    pathogenesis: { chain: [{ nodeId: "P1", patientFact: "口苦反酸", syndromeEvidence: "舌红苔黄", pathogenesis: "肝火犯胃", therapyDirection: "清肝泻火，和胃降逆" }] },
    therapy: { overallPrinciple: "清肝泻火，和胃降逆", overallMethod: "清热泻火" },
  };
  const leftJinHerbs = [
    herb("黄连", "君", "清热泻火"), herb("吴茱萸", "佐", "温中散寒"), herb("栀子", "臣", "清热泻火"),
  ];
  const leftJinEnvelope = `${S}\n${JSON.stringify({
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe",
    formula: { candidates: [{ name: "左金丸", formulaNames: ["左金丸"], herbs: leftJinHerbs }] },
  })}\n${E}`;
  assert.deepEqual(namesOf(dropUnsupportedM04CandidateHerbs(leftJinEnvelope, priorHeat, true)),
    ["黄连", "吴茱萸", "栀子"],
    "仍保留经典身份时基准药味不能被单味剔除，组成争议交给身份修复");
  assert.deepEqual(namesOf(dropUnsupportedM04CandidateHerbs(leftJinEnvelope, priorHeat, false)),
    ["黄连", "吴茱萸", "栀子"],
    "调用方关闭基准保留数也不能越过候选仍明确保留的合法经典身份");
  const declassifiedLeftJinEnvelope = `${S}\n${JSON.stringify({
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe",
    formula: { candidates: [{
      name: "本例辨证组方", formulaNames: [], constructionType: "self_devised", identityDeclassified: true,
      herbs: leftJinHerbs,
    }] },
  })}\n${E}`;
  assert.deepEqual(namesOf(dropUnsupportedM04CandidateHerbs(declassifiedLeftJinEnvelope, priorHeat, false)),
    ["黄连", "栀子"],
    "经典身份即将透明降级时，方向对立的基准药味也必须剔除，不能在自拟方里继续享受基准豁免");
  // 降级路径也不得把方剔空。
  const allBad = `${S}\n${JSON.stringify({
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe",
    formula: { candidates: [{ name: "本例辨证组方", formulaNames: [], herbs: [herb("前胡", "臣", "散风清热")] }] },
  })}\n${E}`;
  assert.deepEqual(namesOf(dropUnsupportedM04CandidateHerbs(allBad, prior, false)), ["前胡"],
    "剔除后不得零治疗性药味——那比原驳回更糟，此时放弃剔除");
}

// ─── 修复轮走完之后，复核 repair 意见的分流 ─────────────────────────────────────
// 这条规则此前散落在三处，每处各自决定「repair ⇒ 作废」，同一类 0 味修了三遍还在复发：
// 透明降级块内、块外的入口守卫、finalize 阶段的最后一次复核（后者会把刚刚受理的降级候选
// 重新判死——实测网络医案 3，郁证-天王补心丹）。现在只有一处实现，这里钉住它的取值。
{
  const { m04FinalReviewQualityAnnotation } = await import("../src/lib/m04-repair-policy.ts");
  // 受理：这三项在确定性层都有对应检查且已经跑过（方剂基准组成、君臣结构与病机引用、
  // 妊娠哺乳儿科门禁 + 十八反十九畏 + 逐味剂量上限）。复核在其上给的是质量意见。
  for (const issueCode of ["formula_composition_mismatch", "herb_plan_mismatch", "patient_context_mismatch"]) {
    const annotation = m04FinalReviewQualityAnnotation({ status: "repair", issueCode });
    assert.ok(annotation && annotation.length > 20,
      `${issueCode} 应当带批注受理，而不是把整方判成 0 味`);
    assert.ok(/已完整通过安全核验/.test(annotation),
      `${issueCode} 的批注必须写明哪一层已通过，否则医生无从判断能不能用`);
  }
  // 剂量强度意见也带批注受理（甲方产品语义：安全问题阻断，质量问题标注）——数值本身
  // 已被药典上下限确定性钳制，越界在此之前就被逐味驳回；复核在圈内提的「相称性」正是
  // 医师定夺事项。批注必须点名「剂量强度需医生把握」。
  {
    const annotation = m04FinalReviewQualityAnnotation({ status: "repair", issueCode: "dose_rationale_concern" });
    assert.ok(annotation && /剂量强度/.test(annotation) && /药典边界内/.test(annotation),
      `dose_rationale_concern 应带批注受理且写明边界事实：${annotation}`);
  }
  // 未知码 default-deny：策略表之外的意见永远不能自动受理。
  for (const issueCode of ["some_future_issue_code", "none"]) {
    assert.equal(m04FinalReviewQualityAnnotation({ status: "repair", issueCode }), undefined,
      `${issueCode} 不得被带批注受理`);
  }
  // 非 repair 状态不产生批注（accepted 走正常路径，unavailable 另有转人工通道）。
  for (const status of ["accepted", "unavailable"]) {
    assert.equal(m04FinalReviewQualityAnnotation({ status, issueCode: "herb_plan_mismatch" }), undefined,
      `status=${status} 不应产生质量批注`);
  }
}

// ─── 功用补充表：只追加、不替换，且必须真的补出目标方向 ─────────────────────
// 缺口形态：《中药学》功效归类表按**主章节**归类，牡蛎→平抑肝阳药、龙骨→重镇安神药，
// 于是"煅牡蛎收敛固涩"这个第二功效在知识库里查不到。后果不是提示不全，而是整方被驳——
// 治法「益气固表，敛汗止汗」的方里用煅牡蛎，君臣支撑率把它算作不落在任何已锁定方向上
// （实测网络医案 37/41 自汗案，均因此 0 味）。
{
  const { getTcmHerbFunctionText } = await import("../src/lib/tcm-knowledge.ts");
  const { affirmedTcmTherapyConcepts } = await import("../src/lib/diagnosis-stage-contract.ts");
  const { readFileSync } = await import("node:fs");
  const supplements = JSON.parse(
    readFileSync(new URL("../src/data/tcm-herb-function-supplements.source.json", import.meta.url), "utf8"));
  for (const entry of supplements.entries) {
    const text = getTcmHerbFunctionText(entry.herb);
    assert.ok(text.includes(entry.supplement),
      `${entry.herb} 的补充功用未生效：${text}`);
    // 只追加：补充必须整体附在末尾。原文本为空时（知识库根本没收该药的功用，如赭石）
    // 补充即全文，这仍然是"没有删改任何既有内容"。
    assert.ok(text === entry.supplement || text.endsWith(`；${entry.supplement}`),
      `${entry.herb} 的补充不是附加在既有功用文本之后：${text}`);
    assert.ok(entry.basis && entry.basis.length > 15,
      `${entry.herb} 的补充缺少可追溯依据原文`);
    // 补充的目的是补出一个具体的方向；补不出来说明词表或补充文本对不上。
    assert.ok(affirmedTcmTherapyConcepts(text).has(entry.missingConcept)
      || entry.missingConcept === "blood_stanch",   // 止血方向不在 TCM_THERAPY_CONCEPTS 治法词表内
      `${entry.herb} 补充后仍解析不出 ${entry.missingConcept}：${[...affirmedTcmTherapyConcepts(text)].join(",")}`);
  }
}


// ─── 最后一公里统一策略：治法覆盖阈值 + M03 finalize 复核意见 ───────────────────
// 产品语义（甲方定）：**安全问题阻断，质量问题标注**。0 味只保留给真正的安全阻断与
// 「模型根本没给出候选」。这里钉住三件事：
//   ① 治法覆盖率阈值码（coverage/herb_support）在修复耗尽后必须能带批注受理——
//      它们是本系统词表上的覆盖率，不是逐味安全事实（实测网络医案 37/41 两例自汗 0 味）；
//   ② contract_missing / unresolved 不在豁免列：结构缺失无从标注；
//   ③ M03 finalize 复核的质量意见（tcm_reasoning_unsupported 等）同样带批注受理，
//      诊断标签类意见（criteria_not_met 族）维持作废。
{
  const { m04TherapyIssueQualityAnnotation, m03FinalReviewQualityAnnotation, canAcceptTransparentFormulaFallback } =
    await import("../src/lib/m04-repair-policy.ts");
  const { isWaivableM04TherapyCoverageCode } = await import("../src/lib/diagnosis-stage-contract.ts");
  // herb_knowledge_missing 与上面两条同性质：判据是「本系统药味功效词表有没有收载」，
  // 不是「这味药有没有害」。线上实测（2026-08-07，50 例验收）透明降级块进去 15 次全被拒，
  // 3 次死在这个码上——同一张方去掉那味未收载的药就能受理，差别只在词表覆盖率，
  // 而该方逐味剂量/配伍/特殊人群/高影响方向此前都已单独通过。
  for (const code of ["transparent_therapy_coverage", "transparent_therapy_herb_support",
    "transparent_therapy_herb_knowledge_missing"]) {
    const annotation = m04TherapyIssueQualityAnnotation(code);
    assert.ok(annotation && /已通过安全核验/.test(annotation),
      `${code} 应带批注受理且写明哪些安全层已通过：${annotation}`);
    assert.ok(isWaivableM04TherapyCoverageCode(code) && isWaivableM04TherapyCoverageCode(`candidate_0_${code}`),
      `${code} 及其 candidate 前缀形式都必须被识别为可豁免`);
    assert.ok(canAcceptTransparentFormulaFallback({
      completedRepairAttempts: 1, requestAborted: false, therapyIssue: code,
    }), `修复耗尽后 ${code} 不得再阻断透明降级`);
  }
  // 边界另一侧：结构缺失无从标注，剂量类是真安全事实——两者都必须维持阻断。
  // 放宽词表覆盖率的同时必须把这条边界一起钉住，否则下一次「顺手统一」会把剂量也放进来。
  for (const code of ["transparent_therapy_contract_missing", "transparent_therapy_unresolved",
    "transparent_therapy_herbs_missing", "candidate_0_herb_6_dose", "herb_3_dose"]) {
    assert.equal(m04TherapyIssueQualityAnnotation(code), undefined, `${code} 不得被豁免`);
    assert.ok(!isWaivableM04TherapyCoverageCode(code), `${code} 不得被识别为可豁免`);
    assert.ok(!canAcceptTransparentFormulaFallback({
      completedRepairAttempts: 1, requestAborted: false, therapyIssue: code,
    }), `${code} 属安全/结构类，修复耗尽后仍必须阻断透明降级`);
  }
  // 两处判据**不是同集，也不该是**——这条注释本身就是一次返工的结论，别再往回改。
  //
  // 事情经过：d40072db 在这里写过一条「两处同集」断言，但它只逐个比对手写的 6 个码，
  // 而真实发射码里有 `transparent_therapy_${highImpactIssue}` 这种拼出来的动态族——
  // 手写清单当然全绿，它检查的正是它自己列出来的那几个。断言名不副实，属实。
  // 但据此把 isWaivableM04TherapyCoverageCode 改成「直接问 policy 要批注」是**fail-open**：
  //
  //   isWaivable 的两个调用点都写成 `waiveTherapyCoverageAnnotated && isWaivable(coverageIssue)`，
  //   而 coverageIssue 是在**同一个 waive 口径**下算出来的。waive=true 时
  //   unsupportedHighImpactHerbIssue 把「词表未成立」那一半清空，只剩「方向对立」。
  //   实测（M03 锁定「清热泻火」）：
  //     附子 waive=true → transparent_therapy_herb_1_unsupported_high_impact_yang_warm
  //     丹参 waive=true → transparent_therapy_herb_support
  //   能走到 isWaivable 的 unsupported_high_impact 码，方向必然是对立的。放行 = 附子进热证。
  //
  // policy 的批注作用在 waive=false 重算出来的码上（给医生写文案），isWaivable 决定复验放不放行。
  // 输入总体不同，判据不同是正确的。下面钉住的是**两个集合各自的边界**，不是它们相等。
  const OPPOSING_UNDER_WAIVE = [
    "transparent_therapy_herb_0_unsupported_high_impact_yang_warm",
    "transparent_therapy_herb_2_unsupported_high_impact_heat_clear",
    "candidate_0_transparent_therapy_herb_1_unsupported_high_impact_purge",
  ];
  for (const code of OPPOSING_UNDER_WAIVE) {
    assert.ok(
      !isWaivableM04TherapyCoverageCode(code),
      `${code} 在 waive 口径下必然是「方向对立」，复验绝不能放行——放行等于让附子进热证`,
    );
    // 反过来 policy 侧**应当**给它批注：那是 waive=false 时的词表缺口文案，作用域不同。
    assert.ok(
      m04TherapyIssueQualityAnnotation(code) !== undefined,
      `${code} 在 policy 侧应有批注文案（waive=false 口径），缺了医生就拿不到解释`,
    );
  }
  // 结构/安全类：两侧都必须拒绝。
  for (const code of ["transparent_therapy_contract_missing", "transparent_therapy_herbs_missing",
    "candidate_0_emperor_missing", "candidate_0_herb_1_emperor_not_primary",
    "candidate_0_herbs_empty", "candidate_0_herb_6_dose", "herb_3_dose"]) {
    assert.ok(!isWaivableM04TherapyCoverageCode(code), `${code} 属安全/结构类，复验不得放行`);
    assert.equal(m04TherapyIssueQualityAnnotation(code), undefined, `${code} 不得有批注文案`);
  }
  // 覆盖率三码：两侧都必须放行，且必须是**全部**——从源码扫 isWaivable 的正则，防止有人偷偷加码。
  const { readFileSync: readSource } = await import("node:fs");
  const waivableRegexSource = readSource("src/lib/diagnosis-stage-contract.ts", "utf8")
    .match(/export function isWaivableM04TherapyCoverageCode[\s\S]*?\n}/)?.[0] || "";
  assert.ok(
    /coverage\|herb_support\|herb_knowledge_missing/.test(waivableRegexSource),
    "isWaivableM04TherapyCoverageCode 的可豁免码集合被改动了——这是 fail-closed 边界，改动需要单独论证",
  );
  assert.ok(
    !/m04TherapyIssueQualityAnnotation/.test(waivableRegexSource),
    "isWaivableM04TherapyCoverageCode 又被改成「问 policy 要批注」——那是已被实测拦下的 fail-open 回归",
  );
  for (const code of ["transparent_therapy_coverage", "candidate_0_transparent_therapy_herb_support",
    "transparent_therapy_herb_knowledge_missing"]) {
    assert.ok(isWaivableM04TherapyCoverageCode(code), `${code} 是词表覆盖率码，复验必须放行`);
    assert.ok(m04TherapyIssueQualityAnnotation(code) !== undefined, `${code} 必须有批注文案`);
  }
  for (const [issueCode, ok] of [
    ["tcm_reasoning_unsupported", true],
    ["formula_indication_mismatch", true],
    ["criteria_not_met", false],
    ["diagnostic_label_overstated", false],
    ["supporting_fact_mismatch", false],
    ["future_unknown_code", false],
  ]) {
    const annotation = m03FinalReviewQualityAnnotation({ status: "repair", issueCode });
    assert.equal(annotation !== undefined, ok,
      `M03 finalize 复核 ${issueCode} 的受理处置应为 ${ok ? "带批注受理" : "作废"}：${annotation}`);
    if (ok) assert.ok(/确定性核验/.test(annotation), `${issueCode} 的批注必须写明确定性层已通过`);
  }
}

// ─── 扩展族：君药方向不符 / 病机节点未覆盖 / 高影响词表未成立 ────────────────────
// 这三族与覆盖率阈值同性质（系统词表能力，非逐味安全事实），修复耗尽后带批注受理；
// 前缀（m04_ / candidate_N_ / transparent_therapy_）不改变语义。
// 反向钉住：方向**对立**与结构错误（emperor_missing/not_primary/excess、herbs_empty）
// 永远不得被映射为批注——对立不是词表缺口，是临床错误。
{
  const { m04TherapyIssueQualityAnnotation } = await import("../src/lib/m04-repair-policy.ts");
  for (const code of [
    "m04_candidate_0_herb_0_emperor_therapy_mismatch",
    "candidate_0_transparent_therapy_herb_1_unsupported_high_impact_heat_clear",
    "transparent_therapy_herb_0_unsupported_high_impact_yang_warm",
    "m04_pathogenesis_node_uncovered_P3",
  ]) {
    const annotation = m04TherapyIssueQualityAnnotation(code);
    assert.ok(annotation && /已通过安全核验/.test(annotation),
      `${code} 应带批注受理且写明安全层已通过：${annotation}`);
  }
  for (const code of [
    "candidate_0_emperor_missing",
    "candidate_0_herb_0_emperor_not_primary",
    "candidate_0_herb_0_emperor_knowledge_missing",
    "candidate_0_herbs_empty",
    "candidate_0_herb_0_pathogenesis_unaligned_heat_clear",
    "candidate_0_high_risk_pair_incompatibility",
    "transparent_therapy_contract_missing",
  ]) {
    assert.equal(m04TherapyIssueQualityAnnotation(code), undefined, `${code} 不得被映射为批注`);
  }
}

// ─── 词表未成立 vs 方向对立：豁免必须只放前者 ─────────────────────────────────
// unsupportedHighImpactHerbIssue 此前把两者合并进同一个码；拆分后：豁免口径下，
// 词表未成立不再驳回，方向对立照旧驳回。另钉：M03 自己锁定寒温并用（required 同时含
// 两侧）时，温药不算「与锁定方向对立」——那是方义本身（半夏泻心汤类）。
{
  const { highImpactHerbDirectionIssue } = await import("../src/lib/diagnosis-stage-contract.ts");
  const priorOf = (therapy) => ({
    stage: "diagnose",
    overview: { recommendedFormulaNames: [], formulaSelectionMode: "self_devised" },
    therapy: { overallPrinciple: therapy, overallMethod: therapy, subTherapies: [{ therapy }] },
    pathogenesis: { chain: [{ nodeId: "P1", pathogenesis: "示例", therapyDirection: therapy }] },
  });
  // 干姜（温里）在纯清热锁定下：对立，任何口径都驳回。
  const coldHerbInHeat = highImpactHerbDirectionIssue("干姜", "温中散寒", priorOf("清热泻火"));
  assert.match(String(coldHerbInHeat), /unsupported_high_impact/, "对立方向必须驳回");
  // 干姜在寒温并用（泻心汤类）锁定下：required 同时含两侧，不属对立。
  assert.equal(highImpactHerbDirectionIssue("干姜", "温中散寒", priorOf("清热化痰，温中散寒")), undefined,
    "M03 锁定寒温并用时温药是方义本身，不得判对立");
}

// ─── requiredTherapyConcepts 必须读 overallMethod 与 subTherapies ─────────────
// 实测网络医案 37：M03 的 overallPrinciple 是「标本兼治」（原则语，解析为空），温阳方向只写在
// overallMethod「益气固表，温阳敛汗」与 subTherapy「温阳固卫」里。窄口径下高影响门判方中
// 温阳药 yang_warm 未成立 → 整方 0 味。
{
  const { highImpactHerbDirectionIssue } = await import("../src/lib/diagnosis-stage-contract.ts");
  const prior = {
    stage: "diagnose",
    overview: { recommendedFormulaNames: [], formulaSelectionMode: "self_devised" },
    therapy: { overallPrinciple: "标本兼治", overallMethod: "益气固表，温阳敛汗", subTherapies: [{ therapy: "温阳固卫" }] },
    pathogenesis: { chain: [{ nodeId: "P1", pathogenesis: "气虚卫外不固", therapyDirection: "益气固表" }] },
  };
  assert.equal(highImpactHerbDirectionIssue("桂枝", "温阳固卫", prior), undefined,
    "M03 在 overallMethod/subTherapies 里锁定的方向必须计入已成立方向");
}

// ─── 目标词 vs 方法词 + 反治法族 ─────────────────────────────────────────────
// 类别: 概念表编码的是**方法**词汇, 不是疗效目标。「退热」是目标——辛温解表(桂枝汤解肌退热)、
// 甘温除热同样以退热为目标; 目标词进 heat_clear 的后果是方中每一味温药触发方向对立否决
// (实测网络医案 42: 调和营卫，解肌退热 → 桂枝被判 yang_warm 对立 → 整方 0 味)。
// 反治法四则声明的就是悖反用药方向, 词表必须按其用药方向承接, 否则永远被对立否决。
{
  const { affirmedTcmTherapyConcepts, highImpactHerbDirectionIssue } =
    await import("../src/lib/diagnosis-stage-contract.ts");
  assert.ok(!affirmedTcmTherapyConcepts("解肌退热").has("heat_clear"),
    "退热是疗效目标词, 不得进入 heat_clear 方法表");
  assert.ok(affirmedTcmTherapyConcepts("解肌退热").has("exterior_release"),
    "解肌是标准解表动词(桂枝汤), 必须解析为 exterior_release");
  for (const [t, concept] of [
    ["甘温除热", "yang_warm"], ["甘温除大热", "yang_warm"], ["热因热用", "yang_warm"],
    ["寒因寒用", "heat_clear"], ["通因通用", "purge"], ["塞因塞用", "astringe"],
  ]) {
    assert.ok(affirmedTcmTherapyConcepts(t).has(concept), `反治法 ${t} 必须映射到 ${concept}`);
  }
  // 端到端: 桂枝汤场景, 君药桂枝在「调和营卫，解肌退热」锁定下不得被判方向对立。
  const guizhiPrior = {
    stage: "diagnose",
    overview: { recommendedFormulaNames: [], formulaSelectionMode: "self_devised" },
    therapy: { overallPrinciple: "调和营卫", overallMethod: "调和营卫，解肌退热", subTherapies: [{ therapy: "调和营卫" }] },
    pathogenesis: { chain: [{ nodeId: "P1", pathogenesis: "营卫不和", therapyDirection: "调和营卫，解肌退热" }] },
  };
  assert.equal(highImpactHerbDirectionIssue("桂枝", "解肌发表，调和营卫", guizhiPrior), undefined,
    "桂枝汤的桂枝不得因『退热』目标词被判温药对立");
  // 反向: 真对立仍拦——纯清热锁定下的干姜照旧驳回。
  const heatPrior = { ...guizhiPrior, therapy: { overallPrinciple: "清热泻火", overallMethod: "清热泻火", subTherapies: [{ therapy: "清热泻火" }] }, pathogenesis: { chain: [{ nodeId: "P1", pathogenesis: "热毒炽盛", therapyDirection: "清热泻火" }] } };
  assert.match(String(highImpactHerbDirectionIssue("干姜", "温中散寒", heatPrior)), /unsupported_high_impact/,
    "纯清热锁定下的温里药仍必须被对立否决");
}
