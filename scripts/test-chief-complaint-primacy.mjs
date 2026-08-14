// 主症/兼症未分主次 —— 确定性回归（2026-08-04）。
//
// ★ 这一条与「治法方向无病例绑定」不是同一个病 ★
// therapy_method_direction_unbound 问的是「这个方向有没有病机节点撑着」。产后头痛例里
// 「安神」**确实**有节点撑着（病历真有心悸失眠），所以那条检查放行是对的。缺的是另一个维度：
// 主症节点与兼症节点此前完全平权——谁的治法方向居首、谁主导选方，服务端从未看过一眼。
//
// 生产实测取证（2026-08-04，https://…/tcm-cdss，见同目录 fixture）：
//   主诉「产后2月余，头痛反复发作1月」，兼见心悸失眠、神疲乏力。
//   总治法 = 「补益心脾，益气养血，和络止痛。」  ← 兼症方向（补益心脾）居首
//   病机链 P1（患者事实带主症「头痛」）→ 益气养血，和络止痛
//          P2（患者事实「产后2月余」，兼症）→ 补益心脾，养血安神
//   recommendedFormulaDirection = 归脾汤加减   ← 主治心脾两虚之心悸健忘失眠，不是头痛
//   subTherapies 两条 priority 都写「主要」    ← 结构上根本没分主次
//
// ★ 判据完全由受治理数据派生（不新写任何中文临床词表）★
//   主症词族 ← tcm-symptom-axis-map.source.json 的 chiefComplaintAnchor 族；
//   治法身份与族层级 ← tcm-treatment-principle-lexicon.json 的 GB/T 16751.3 standardNumber；
//   「居首」← 受治理治法在 overallMethod 中的**字符偏移量**。
//
// 本文件按**类**断言：正例（必须命中）、反例（次序正确/兼症在后不得误报）、
// 以及每一道 fail-open 边界（缺任一环即整条跳过——「判不了」不等于「判错了」）。
import assert from "node:assert/strict";
import fs from "node:fs";

const {
  governedTreatmentMethodOccurrencesInText,
  governedTreatmentMethodsInText,
  treatmentMethodFamilyId,
} = await import("../src/lib/clinical-governance-tables.ts");
const { chiefComplaintAnchor, chiefComplaintTherapyPrimacy } =
  await import("../src/lib/tcm-chief-complaint-anchor.ts");
const { m03SemanticIssue } = await import("../src/lib/diagnosis-stage-contract.ts");
const { rejectionTier } = await import("../src/lib/diagnosis-rejection-tiers.ts");
const { structuredClinicalRepairHint } = await import("../src/lib/structured-clinical-repair.ts");

let checks = 0;
const check = (fn) => { fn(); checks += 1; };

// ─────────────────────────────────────────────────────────────────────────────
// ① 句序访问器：既有 governedTreatmentMethodsInText 返回的是**词表序**，与句序无关。
//    这正是「居首」判据不能复用它的原因——实测它把句尾的「和络」排在句首的「补益心脾」之前。
// ─────────────────────────────────────────────────────────────────────────────
const OVERALL = "补益心脾，益气养血，和络止痛。";
check(() => {
  const lexicalFirst = governedTreatmentMethodsInText(OVERALL)[0]?.canonical;
  const positionalFirst = governedTreatmentMethodOccurrencesInText(OVERALL)[0]?.entry.canonical;
  assert.notEqual(lexicalFirst, positionalFirst, "词表序与句序必须确实不同，否则本判据没有存在理由");
  assert.equal(positionalFirst, "补益心脾", "句序访问器必须返回句子里真正居首的那条治法");
});
check(() => {
  const indexes = governedTreatmentMethodOccurrencesInText(OVERALL).map((hit) => hit.index);
  assert.deepEqual([...indexes].sort((a, b) => a - b), indexes, "命中项必须按偏移量升序");
});
check(() => assert.deepEqual(
  governedTreatmentMethodOccurrencesInText(OVERALL).map((hit) => hit.entry.id).sort(),
  governedTreatmentMethodsInText(OVERALL).map((entry) => entry.id).sort(),
  "两个访问器的命中集合必须恒等——句序版只改顺序，不得改口径",
));
check(() => assert.deepEqual(governedTreatmentMethodOccurrencesInText(""), [], "空文本无命中"));
check(() => assert.deepEqual(governedTreatmentMethodOccurrencesInText(null), [], "非字符串无命中"));

// 族层级直接取词表自带编号，不新写映射。
check(() => {
  const family = (text) => treatmentMethodFamilyId(governedTreatmentMethodsInText(text)[0]);
  assert.notEqual(family("补益心脾"), family("和络止痛"), "补益心脾与和络止痛必须分属不同治法族");
});

// ─────────────────────────────────────────────────────────────────────────────
// ② 生产原始载荷：判据必须在**真实产出**上命中，而不只在构造样本上
// ─────────────────────────────────────────────────────────────────────────────
const PROD = JSON.parse(fs.readFileSync(
  "scripts/fixtures/chief-complaint-primacy/prod-20260804-postpartum-headache.m03.json", "utf8"));
const prodContext = [
  "主诉：产后2月余，头痛反复发作1月",
  "现病史：产后2月余，近1月头痛反复，劳累后加重，伴神疲乏力、心悸失眠、面色少华",
  "既往史：否认高血压、糖尿病病史",
  "舌象：舌淡苔薄白",
  "脉象：脉细弱",
].join("\n");
const prodAnchor = chiefComplaintAnchor(prodContext);

check(() => assert.ok(prodAnchor.symptomTerms.includes("头痛"), "主诉「头痛」必须落在受治理主症词族内"));
check(() => {
  const verdict = chiefComplaintTherapyPrimacy(
    PROD.pathogenesis.chain, PROD.therapy.overallMethod, prodAnchor);
  assert.equal(verdict.applicable, true, "生产载荷上判据必须可用");
  assert.equal(verdict.secondaryLeads, true, "生产载荷：兼症方向（补益心脾）居首 → 必须判为主次颠倒");
  assert.equal(verdict.leadingMethodName, "补益心脾", "居首方向必须逐字可指认");
  assert.ok(verdict.chiefMethodNames.length > 0, "主症节点的治法方向必须能带回修复提示");
});
// 主症节点判定只认 patientFact：生产载荷的 P2（兼症节点）把主诉整句复制进了 syndromeEvidence。
// 若两个字段取并集，每个节点都会被判成主症节点，整条判据当场失效——这是本层最要紧的边界。
check(() => {
  const bothFieldsCarryChief = PROD.pathogenesis.chain
    .every((node) => `${node.patientFact}${node.syndromeEvidence}`.includes("头痛"));
  assert.equal(bothFieldsCarryChief, true, "生产载荷确实每个节点的两字段并集都带主症（本边界的现实依据）");
  assert.equal(
    PROD.pathogenesis.chain.filter((node) => String(node.patientFact).includes("头痛")).length,
    1,
    "只认 patientFact 时必须恰好切出一个主症节点",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// ③ 端到端：完整 M03 语义合同上的命中与放行
// ─────────────────────────────────────────────────────────────────────────────
const CUSTOMER_FIELDS = JSON.parse(fs.readFileSync(
  "scripts/fixtures/postpartum-headache-case.json",
  "utf8",
)).fields;
const customerContext = [
  `主诉：${CUSTOMER_FIELDS["主诉"]}`,
  `现病史：${CUSTOMER_FIELDS["现病史"]}`,
  `既往史：${CUSTOMER_FIELDS["既往史"]}`,
  `问诊补充：${CUSTOMER_FIELDS["问诊补充"]}`,
  `面象：${CUSTOMER_FIELDS["面象"]}`,
  `舌象：${CUSTOMER_FIELDS["舌象"]}`,
  `脉象：${CUSTOMER_FIELDS["脉象"]}`,
].join("\n");

// 一份主症方向居首的合规产后血虚头痛 M03（主症节点 P1 承接头痛，兼症节点 P2 走安神）。
const compliant = {
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "diagnose",
  overview: {
    tcmDiseaseName: "头痛",
    tcmDiseaseRationale: "以产后头痛隐隐、遇劳遇风加重为主症，病程2月余，属内伤范畴，故归入头痛范畴，与眩晕、真头痛相区分。",
    tcmDiagnosticRationale: "头痛隐隐结合面色少华、舌质淡、脉细弱，支持气血两虚、清窍失养的工作判断。",
    tcmDiseaseDifferentials: [
      { diseaseName: "内伤头痛", reason: "产后起病、遇劳加重，需与外感头痛分流", distinguishingPoints: "本例病程2月余、无恶寒发热，符合内伤而非外感", nextCheck: null },
      { diseaseName: "厥头痛", reason: "头痛剧烈伴呕吐神昏属急重病名，须先排除", distinguishingPoints: "本例头痛隐隐、时发时止，无喷射性呕吐与意识障碍", nextCheck: "若出现剧烈头痛伴呕吐或意识改变，立即按急诊流程评估" },
    ],
    primarySyndrome: "气血两虚证",
    primarySyndromeBasis: ["头痛隐隐，时发时止", "面色少华，神疲"],
    tcmDifferentials: [],
    overallPathogenesis: "产后气血亏虚，清窍失养，脑络不荣，故头痛隐隐",
    recommendedFormulaDirection: "八珍汤加减",
    recommendedFormulaNames: ["八珍汤"],
    formulaSelectionMode: "single",
  },
  westernDiagnosis: {
    primary: {
      name: "头痛（病因待查）",
      status: "考虑",
      confidence: "中",
      supportingFacts: ["头痛隐隐，时发时止", "遇疲劳、遇风则加重"],
      clinicalRationale: "遇疲劳、遇风则加重提示诱因相关性，结合病程逾2月且无红旗征，考虑良性头痛谱系；但血压与查体尚未完成，具体病因仍需鉴别。",
      limitations: ["未提供血压测量结果"],
      suggestedChecks: ["测量血压以排除高血压相关头痛"],
      evidence: { evidenceLevel: "model_inference", source: "基于本例已提供病史", confidence: "中" },
    },
    differentials: [],
  },
  pathogenesis: {
    locationDifferentiation: {
      items: ["脑", "脾", "心"],
      details: [{ location: "脑", basis: "头痛隐隐，时发时止" }],
      resolution: "bounded",
      resolutionReason: "病位判断基于四诊与病史，缺乏客观检查佐证",
    },
    chain: [
      { nodeId: "P1", patientFact: "头痛隐隐，时发时止", syndromeEvidence: "面色少华，神疲", pathogenesis: "气血亏虚，清窍失养，脑络不荣", therapyDirection: "益气养血，和络止痛", pathogenesisType: "主因" },
      { nodeId: "P2", patientFact: "小便清长，大便稀溏", syndromeEvidence: "舌质淡，苔薄白", pathogenesis: "血不养心，心神失养", therapyDirection: "养血安神", pathogenesisType: "兼因" },
    ],
  },
  therapy: {
    overallPrinciple: "虚则补之",
    overallMethod: "益气养血，和络止痛，兼以养血安神",
    subTherapies: [
      { therapy: "益气养血，和络止痛", targetPathogenesis: "气血亏虚，清窍失养", priority: "主要" },
      { therapy: "养血安神", targetPathogenesis: "血不养心，心神失养", priority: "次要" },
    ],
  },
  management: { followupSafetyNet: "若头痛突然加剧、出现呕吐或意识改变，请立即急诊就医" },
};
const mutate = (fn) => { const clone = structuredClone(compliant); fn(clone); return clone; };

check(() => assert.equal(
  m03SemanticIssue(compliant, customerContext),
  undefined,
  "主症方向居首、兼症方向在后（兼以…）的 M03 必须整体通过",
));
check(() => assert.equal(
  m03SemanticIssue(mutate((r) => { r.therapy.overallMethod = "养血安神，益气养血，和络止痛"; }), customerContext),
  "therapy_chief_complaint_not_leading",
  "兼症方向（安神）被写到总治法最前 → 命中，这正是甲方指出的主次颠倒",
));
// 生产实测那一句的等价形态：兼症的「补益心脾」居首、主症的「和络止痛」垫底。
check(() => assert.equal(
  m03SemanticIssue(mutate((r) => {
    r.pathogenesis.chain[1].therapyDirection = "补益心脾，养血安神";
    r.therapy.subTherapies[1].therapy = "补益心脾，养血安神";
    r.therapy.overallMethod = "补益心脾，益气养血，和络止痛";
  }), customerContext),
  "therapy_chief_complaint_not_leading",
  "生产原句形态（补益心脾居首、和络止痛垫底）→ 命中",
));

// ── 反例：不得误报 ────────────────────────────────────────────────────────────
check(() => assert.equal(
  m03SemanticIssue(mutate((r) => { r.therapy.overallMethod = "益气养血，和络止痛，佐以养血安神"; }), customerContext),
  undefined,
  "主症方向居首、兼症方向以「佐以」殿后 → 合规（兼症方向照常保留，本判据只判主次）",
));
check(() => assert.equal(
  m03SemanticIssue(mutate((r) => {
    r.pathogenesis.chain[1].therapyDirection = "养心安神";
    r.therapy.subTherapies[1].therapy = "养心安神";
    r.therapy.overallMethod = "益气养血，和络止痛，兼以养心安神";
  }), customerContext),
  undefined,
  "兼症节点写养血安神、总治法归纳成养心安神属同族改写，次序正确即不得误报",
));

// ── fail-open 边界：缺任一环即整条跳过 ────────────────────────────────────────
check(() => assert.equal(
  chiefComplaintTherapyPrimacy(compliant.pathogenesis.chain, "养血安神，益气养血", chiefComplaintAnchor("主诉：产后调理")).applicable,
  false,
  "主症词表未收录该主诉（无锚）→ 判据不可用，整条跳过",
));
check(() => assert.equal(
  chiefComplaintTherapyPrimacy([compliant.pathogenesis.chain[0]], "养血安神，益气养血", chiefComplaintAnchor(prodContext)).applicable,
  false,
  "只有一个病机节点（无兼症节点）→ 无主次可分，跳过",
));
check(() => assert.equal(
  chiefComplaintTherapyPrimacy(
    compliant.pathogenesis.chain.map((node) => ({ ...node, patientFact: "神疲乏力" })),
    "养血安神，益气养血", chiefComplaintAnchor(prodContext)).applicable,
  false,
  "没有任何节点的 patientFact 带主症（主症无人承接）→ 交给 therapy_chief_symptom_unaddressed，本条跳过",
));
check(() => assert.equal(
  chiefComplaintTherapyPrimacy(
    compliant.pathogenesis.chain.map((node) => ({ ...node, therapyDirection: "调畅气机" })),
    "养血安神，益气养血", chiefComplaintAnchor(prodContext)).applicable,
  false,
  "两侧节点的治法方向都没有受治理治法命中 → 无族可比，跳过",
));
check(() => assert.equal(
  chiefComplaintTherapyPrimacy(compliant.pathogenesis.chain, "益气养血，和络止痛", chiefComplaintAnchor(prodContext)).applicable,
  false,
  "总治法里根本没有兼症方向 → 不存在「谁居首」的问题，跳过",
));
check(() => assert.equal(
  chiefComplaintTherapyPrimacy(compliant.pathogenesis.chain, "养血安神", chiefComplaintAnchor(prodContext)).applicable,
  false,
  "总治法里根本没有主症方向 → 属主症无人负责，交给绑定/承接两条，本条跳过",
));

// ── 分级与修复引导 ───────────────────────────────────────────────────────────
check(() => assert.equal(
  rejectionTier("m03_therapy_chief_complaint_not_leading"),
  "T2",
  "主次颠倒时结论本身仍成立 → T2 带批注受理，不得作废整份 M03",
));
check(() => {
  const hint = structuredClinicalRepairHint("diagnose", "m03_therapy_chief_complaint_not_leading", ["益气养血", "和络"]);
  assert.ok(hint.includes("益气养血"), "修复提示必须逐字带回主症节点自己写的治法方向");
  assert.ok(/最前/.test(hint), "修复提示必须明确要求把主症方向前置");
  assert.ok(/保留/.test(hint), "修复提示必须明确兼症方向保留而非删除——本条只判主次，不判对错");
  assert.ok(/recommendedFormula/.test(hint), "修复提示必须要求选方随主症重判，否则治法改了方还是兼症方");
});
check(() => {
  const bare = structuredClinicalRepairHint("diagnose", "m03_therapy_chief_complaint_not_leading", []);
  assert.ok(bare.length > 60, "无候选时也必须给出可执行的通用引导");
});

console.log(`chief-complaint-primacy: ${checks} checks passed`);
