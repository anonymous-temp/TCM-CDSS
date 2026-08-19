/**
 * 甲方 2026-08-10 复核清单的确定性回归。
 *
 * 每条断言都钉住一个**已被实测复现**的缺陷，而不是一般化的期望。逐条对应关系：
 *   ②  prioritizeTcmEvidenceForDisplay 只接了一张 React 卡片，Markdown + HIS 两个出口没接
 *   ③  westernDiagnosisLabelForDisplay 自称唯一权威，his-scheme 却绕开它
 *   ⑤  KB 兜底抢在契约校验前 ⇒ M04 修复轮那段指导语是永远打不到的死代码（黄芪）
 *   ⑥  随证加减的 riskNote 在 Markdown 渲染分支被丢弃
 *   ⑨  independentFromGenerator 算出即丢弃，医生可见措辞无条件写「独立」
 *   ⑩  指南依据只有注入、没有回写契约（归档 2280 条 evidence，该栏产出 0 条）
 *   ⑪  四组八例证型不同、穴位逐字相同，protocolStatus 八次都写「个体化方案」
 *   ⑫③ symptoms=string 被静默丢成 {}，现病史整段消失 ⇒ 红旗漏检
 *   ⑫④ 库存 413 文案教对方分批，而落盘是整批替换 ⇒ 第一批被删光
 *   ⑫⑤ 急症排查确认是个字数验证器：一句废话即可清空全部确定性红旗
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createJiti } from "jiti";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.CDSS_DRUG_INVENTORY_PATH = path.join(mkdtempSync(path.join(tmpdir(), "cdss-inv-")), "drug-inventory.json");
process.env.TCM_CLINIC_TREATMENT_CAPABILITIES = "acupuncture";

// server-only 由 Next 在构建期提供，jiti 下按仓库既有约定指向其空实现。
const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  alias: {
    "@": path.join(repoRoot, "src"),
    "server-only": path.join(repoRoot, "node_modules/next/dist/compiled/server-only/empty.js"),
  },
});
const load = (relative) => jiti.import(path.join(repoRoot, relative));

const { normalizeCaseStateInput } = await load("src/lib/diagnosis-types.ts");
const { evaluateSafetyGate } = await load("src/lib/diagnosis-safety.ts");
const {
  activeEmergencyClearanceFindingsFromGate,
  emergencyClearanceContractIssue,
} = await load("src/lib/emergency-clearance-contract.ts");
const { applyDeterministicHerbFunctions, synchronizeVisibleClinicalSummary, westernDiagnosisLabelForDisplay } =
  await load("src/lib/diagnosis-visible-summary.ts");
const { herbFunctionMatchesKnowledge } = await load("src/lib/diagnosis-stage-contract.ts");
const { compileTcmTreatmentRecommendations } = await load("src/lib/tcm-treatment-capabilities.server.ts");
const { buildEvidenceScope, governedEvidenceCitation } = await load("src/lib/evidence-source-validation.ts");
const { buildEvidenceOutputTransform } = await load("src/lib/cdss-evidence-context.ts");
const { applyClinicalReviewIndependenceWording, clinicalReviewIndependenceOf, clinicalReviewLabel } =
  await load("src/lib/clinical-review-independence.ts");
const { importDrugInventory, drugInventorySnapshot, resetDrugInventoryCacheForTests } =
  await load("src/lib/drug-inventory.server.ts");
const { prioritizeTcmEvidenceForDisplay } = await load("src/lib/clinical-evidence-display.ts");
const CUSTOMER_ID = "test-hospital";

const failures = [];
let checks = 0;
const check = (name, fn) => {
  checks += 1;
  try {
    const result = fn();
    if (result && typeof result.then === "function") return result.catch((error) => failures.push({ name, message: String(error?.message || error).slice(0, 800) }));
  } catch (error) {
    failures.push({ name, message: String(error?.message || error).slice(0, 800) });
  }
  return undefined;
};

const S = "<!-- DIAGNOSIS_JSON_START -->";
const E = "<!-- DIAGNOSIS_JSON_END -->";
const wrap = (payload) => `# 报告\n\n${S}\n${JSON.stringify(payload, null, 2)}\n${E}\n`;
const readSentinel = (content) => JSON.parse(content.slice(content.indexOf(S) + S.length, content.indexOf(E, content.indexOf(S))).trim());

// ── ⑫③ symptoms=string 被静默丢成 {} ────────────────────────────────────────────
check("⑫③ symptoms 给自由文本时红旗必须与 object 形态完全一致", () => {
  const narrative = "胸痛伴大汗，向左肩背放射，伴气促，持续20分钟不缓解";
  const gateOf = (symptoms) => evaluateSafetyGate(normalizeCaseStateInput({
    id: "c", phase: "collect", patient: { sex: "男", age: 58 }, chiefComplaint: "不舒服1天", symptoms,
  }));
  const asObject = gateOf({ presentHistory: narrative });
  assert.equal(asObject.status, "red_flag", "夹具本身必须能触发红旗，否则这条断言没有意义");
  for (const [label, symptoms] of [["string", narrative], ["array", [narrative]]]) {
    const gate = gateOf(symptoms);
    assert.equal(gate.status, asObject.status, `symptoms=${label} 的安全门状态必须与 object 形态一致`);
    assert.deepEqual(gate.redFlags, asObject.redFlags, `symptoms=${label} 的红旗必须与 object 形态逐条一致`);
  }
});

check("⑫③ HIS 现病史与自由文本并存时，自由文本不得被丢弃", () => {
  const state = normalizeCaseStateInput({
    id: "c2", phase: "collect", patient: { sex: "男", age: 58 },
    symptoms: "胸痛伴大汗，向左肩背放射",
    hisRecord: {
      caseId: "c2", updatedAt: "2026-08-10T00:00:00.000Z", tongueImageUploaded: false,
      fields: { zhushu: "不舒服1天", xianbingshi: "患者自诉不适" }, rawText: "x",
    },
  });
  assert.equal(state.symptoms.presentHistory, "患者自诉不适", "HIS 结构化字段优先");
  assert.match(String(state.symptoms.extraText || ""), /胸痛伴大汗/, "自由文本必须并入 extraText，不得因为有更权威字段就整段扔掉");
});

// ── ⑫⑤ 急症排查确认不得被一句废话签发 ──────────────────────────────────────────
check("⑫⑤ 字数达标但无逐条处置留痕 ⇒ 不解除", () => {
  const gate = { redFlags: ["胸痛/胸闷伴大汗、放射痛或气促，需排除急性心血管事件"], redFlagFindings: [] };
  const active = activeEmergencyClearanceFindingsFromGate(gate);
  assert.equal(emergencyClearanceContractIssue({
    activeFindings: active, attestations: undefined, assessmentSummary: "今天天气不错今天天气不错今天天气不错",
  }), "attestations_missing");
});

check("⑫⑤ 客观依据里没有做过的事 ⇒ 不解除", () => {
  const gate = { redFlags: ["胸痛/胸闷伴大汗、放射痛或气促，需排除急性心血管事件"], redFlagFindings: [] };
  const active = activeEmergencyClearanceFindingsFromGate(gate);
  const filler = active.map((finding) => ({ ...finding, disposition: "excluded_by_objective_workup", basis: "今天天气不错今天天气不错" }));
  assert.equal(emergencyClearanceContractIssue({
    activeFindings: active, attestations: filler, assessmentSummary: "今天天气不错今天天气不错今天天气不错",
  }), "attestation_basis_not_objective");
  const real = active.map((finding) => ({ ...finding, disposition: "excluded_by_objective_workup", basis: "心电图无ST段抬高，肌钙蛋白阴性" }));
  assert.equal(emergencyClearanceContractIssue({
    activeFindings: active, attestations: real, assessmentSummary: "已完成急诊心血管排查，未见急性冠脉事件",
  }), undefined, "写明做过什么之后必须能签发，否则这道门变成永远不可用");
});

check("⑫⑤ 漏处置任何一条红旗 ⇒ 不解除", () => {
  const gate = { redFlags: ["红旗甲", "红旗乙"], redFlagFindings: [] };
  const active = activeEmergencyClearanceFindingsFromGate(gate);
  const partial = [{ ...active[0], disposition: "referred_and_handed_over", basis: "已转本院急诊内科并完成床旁交接" }];
  assert.notEqual(emergencyClearanceContractIssue({
    activeFindings: active, attestations: partial, assessmentSummary: "已完成现场急症排查并转诊",
  }), undefined);
});

// ── ⑤ 方义占位句不得在契约校验前落地 ────────────────────────────────────────────
const HERB_PAYLOAD = (fn) => ({
  stage: "prescribe",
  therapy: { overallMethod: "健脾养心，益气补血，安神定志", overallPrinciple: "" },
  formula: { candidates: [{ therapyMatch: "健脾养心，益气补血，安神定志", herbs: [
    { name: "黄芪", role: "臣", targetPathogenesis: "心脾两虚，气血不足，心神失养", function: fn },
  ] }] },
});

check("⑤ 模型没写方义时，契约前不得被角色占位句顶上", () => {
  const before = readSentinel(applyDeterministicHerbFunctions(wrap(HERB_PAYLOAD("")))).formula.candidates[0].herbs[0].function;
  assert.equal(before, "", "契约前留空，才能触发 candidate_*_herb_*_function 与那轮修复指导语");
  assert.equal(herbFunctionMatchesKnowledge("黄芪", before, "臣", "心脾两虚"), false);
});

check("⑤ finalize（修复耗尽）才补角色占位句，医生不会看到空栏", () => {
  const after = readSentinel(applyDeterministicHerbFunctions(wrap(HERB_PAYLOAD("")), { fillRolePlaceholder: true }))
    .formula.candidates[0].herbs[0].function;
  assert.match(after, /需医生结合方义复核/);
  assert.equal(herbFunctionMatchesKnowledge("黄芪", after, "臣", "心脾两虚"), true);
});

check("⑤ 模型写的接地方义仍原样保留（不得被服务端覆写）", () => {
  const authored = "补气健脾，助党参、白术益气生血，气旺则血生";
  const kept = readSentinel(applyDeterministicHerbFunctions(wrap(HERB_PAYLOAD(authored)))).formula.candidates[0].herbs[0].function;
  assert.equal(kept, authored);
});

// ── ⑪ 证型不同 ⇒ 穴位必须不同；标签必须诚实 ──────────────────────────────────
const signedPrior = ({ disease, syndrome, pathogenesis, therapy, fact, evidence }) => ({
  schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
  contractSignatureVersion: "tcm-cdss-m03-signature-v4", contractSignature: `hmac-sha256:${"a".repeat(64)}`,
  overview: { tcmDiseaseName: disease, primarySyndrome: syndrome, primarySyndromeResolution: "resolved", primarySyndromeBasis: [], overallPathogenesis: pathogenesis },
  westernDiagnosis: { primary: { name: disease, supportingFacts: [] } },
  therapy: { overallPrinciple: therapy, overallMethod: therapy, subTherapies: [] },
  pathogenesis: { chain: [{ nodeId: "P1", patientFact: fact, syndromeEvidence: evidence, pathogenesis, therapyDirection: therapy }], uncertainties: [] },
});
const acupunctureFor = (prior, chief, present) => compileTcmTreatmentRecommendations(
  [{ projectCode: "acupuncture", targetRef: "P1" }],
  prior,
  { chiefComplaint: chief, symptoms: { presentHistory: present }, patient: { sex: "男", age: 45 }, safetyGate: { status: "ready" } },
).find((item) => item.projectCode === "acupuncture");

const SYNDROME_PAIRS = [
  ["甲流", ["流行性感冒", "风寒束表证", "风寒袭表，卫阳被遏", "辛温解表"], ["流行性感冒", "风热犯表证", "风热袭表，肺失清肃", "辛凉解表"], "发热2天", "发热恶寒，头痛"],
  ["不寐", ["不寐", "心脾两虚证", "心脾两虚，心神失养", "健脾养心安神"], ["不寐", "肝火扰心证", "肝火扰心，心神不宁", "清肝泻火安神"], "失眠3月", "入睡困难，多梦易醒"],
  ["胃痞", ["胃痞", "湿热中阻证", "湿热中阻，脾胃升降失司", "清热化湿"], ["胃痞", "脾胃虚寒证", "脾胃虚寒，中阳不运", "温中健脾"], "腹胀1月", "脘腹痞满，纳差"],
  ["膝痹", ["膝痹", "寒湿痹阻证", "寒湿痹阻，经脉不通", "散寒除湿通络"], ["膝痹", "湿热痹阻证", "湿热痹阻，经脉不利", "清热利湿通络"], "右膝痛3月", "右膝关节疼痛"],
];
for (const [label, left, right, chief, present] of SYNDROME_PAIRS) {
  check(`⑪ ${label}：两个证型的取穴不得逐字相同`, () => {
    const build = ([disease, syndrome, pathogenesis, therapy]) => acupunctureFor(
      signedPrior({ disease, syndrome, pathogenesis, therapy, fact: present, evidence: syndrome }), chief, present);
    const a = build(left);
    const b = build(right);
    assert.ok(a && b, `${label} 两侧都应给出针刺方案`);
    assert.notDeepEqual(a.suggestedSitesOrPoints, b.suggestedSitesOrPoints,
      `${label} 两个证型的穴位逐字相同：${a.suggestedSitesOrPoints.join("、")}`);
    for (const item of [a, b]) {
      // 2026-08-11 收紧：命中证型加减**不再等于**可以标「按证型加减」。
      // 该条配穴还要通过逐条终审台账（tcm-acupoint-syndrome-refinement-adjudications）。
      // 未终审时正确行为是降级为病种模板态、不应用加穴、并把未采用的加减如实下发——
      // 原断言把「命中」直接当成「已按证型定制」，正是本轮要修的那个说法。
      if (item.adjudicationStatus === "approved") {
        assert.equal(item.protocolStatus, "governed_patient_specific_plan", `${label} 已终审的证型加减必须标为按证型加减`);
        assert.ok(item.suggestedSitesOrPoints.some((site) => /加减）|加减；/.test(site)),
          `${label} 至少一个穴位应带证型加减的入选依据：${item.suggestedSitesOrPoints.join("、")}`);
      } else {
        assert.equal(item.protocolStatus, "governed_class_template_not_syndrome_tailored",
          `${label} 未终审的证型加减不得标成患者级个体化方案`);
        assert.equal(item.protocolGap, "syndrome_refinement_pending_adjudication");
        assert.ok(item.deferredSyndromeRefinement,
          `${label} 未应用的证型加减必须如实下发，否则医生会以为系统没识别出本例证型`);
      }
    }
  });
}

check("⑪ 关元只出现在虚寒类加减里，湿热证必须剔除", () => {
  const damp = acupunctureFor(signedPrior({
    disease: "胃痞", syndrome: "湿热中阻证", pathogenesis: "湿热中阻，脾胃升降失司", therapy: "清热化湿",
    fact: "脘腹痞满", evidence: "舌红苔黄腻",
  }), "腹胀1月", "脘腹痞满，纳差，口苦口黏");
  const cold = acupunctureFor(signedPrior({
    disease: "胃痞", syndrome: "脾胃虚寒证", pathogenesis: "脾胃虚寒，中阳不运", therapy: "温中健脾",
    fact: "脘腹痞满，喜温喜按", evidence: "舌淡苔白脉沉迟",
  }), "腹胀1月", "脘腹痞满，纳差，畏寒");
  assert.doesNotMatch(damp.suggestedSitesOrPoints.join("；"), /关元/, "湿热中阻不得取关元");
  assert.match(cold.suggestedSitesOrPoints.join("；"), /关元/, "脾胃虚寒应取关元");
});

check("⑪ 治理分支不得把「头胀」印成「头痛症状」", () => {
  const item = acupunctureFor(signedPrior({
    disease: "头痛", syndrome: "肝阳上亢证", pathogenesis: "肝阳上亢，上扰清窍", therapy: "平肝潜阳",
    fact: "头胀，面红目赤", evidence: "舌红脉弦",
  }), "头胀2周", "头胀，面红目赤，急躁易怒");
  assert.match(item.treatmentContent, /头胀/, "必须引用病历原文落点");
  assert.doesNotMatch(item.treatmentContent, /头痛症状|经带与下腹症状|咳喘与呼吸功能/,
    `不得改口成适应证标签的症状域显示名：${item.treatmentContent}`);
});

check("⑪ 未命中证型加减时必须标第三态，不得冒充个体化方案", () => {
  const item = acupunctureFor(signedPrior({
    disease: "胃痞", syndrome: "证候待明确", pathogenesis: "脾胃升降失司", therapy: "调理脾胃",
    fact: "脘腹痞满", evidence: "纳差",
  }), "腹胀1月", "脘腹痞满，纳差");
  assert.equal(item.protocolStatus, "governed_class_template_not_syndrome_tailored");
  assert.equal(item.protocolGap, "syndrome_refinement_not_matched");
  assert.doesNotMatch(item.suggestedSitesOrPoints.join("；"), /关元/);
});

// ── ⑩ 指南依据必须由 evidenceId 反查渲染，模型不得引入新字符串 ──────────────────
const GUIDE_CONTEXT = [
  "## EviMed 指南/共识检索",
  "命中证据摘要（仅引用下列真实题名、机构、年份和URL；引用时使用方括号ID）：",
  "[EVID-GUIDE-002] 中国咳嗽基层诊疗与管理指南（2024年）（中华医学会呼吸病学分会，2024）：慢性咳嗽的分层评估。 URL:https://www.evimed.com/guide/002",
].join("\n");

check("⑩ 模型只回 evidenceId，题名/机构/年份/URL 由服务端反查渲染", () => {
  const scope = buildEvidenceScope(GUIDE_CONTEXT);
  const citation = governedEvidenceCitation("EVID-GUIDE-002", scope);
  assert.ok(citation, "本轮真检索到的条目必须能被 id 反查到");
  assert.match(citation.citation, /中国咳嗽基层诊疗与管理指南/);
  assert.equal(citation.url, "https://www.evimed.com/guide/002");
  assert.equal(governedEvidenceCitation("EVID-GUIDE-999", scope), undefined, "集外 id 必须取不到");
});

check("⑩ 指南题名自身含冒号时不得在疾病名之前截断", () => {
  const scope = buildEvidenceScope(
    "[EVID-GUIDE-009] 2024 拉丁美洲共识：胃食管反流病的诊断（拉丁美洲胃肠病学组，2024）：诊断路径摘要。",
  );
  const citation = governedEvidenceCitation("EVID-GUIDE-009", scope);
  assert.ok(citation);
  assert.match(citation.citation, /胃食管反流病的诊断/);
  assert.doesNotMatch(citation.citation, /诊断路径摘要/);
});

check("⑩ 模型自撰的题名/集外 id 一律丢弃，且不得回落到自撰题名", () => {
  const transform = buildEvidenceOutputTransform(GUIDE_CONTEXT);
  const payload = {
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
    westernDiagnosis: { primary: {
      name: "急性上呼吸道感染",
      guidelineRefs: [
        { evidenceId: "EVID-GUIDE-002", appliesTo: "支持本例咳嗽的分层评估口径" },
        { evidenceId: "EVID-GUIDE-777", appliesTo: "集外条目" },
        { evidenceId: "《内科学》第10版", appliesTo: "自撰题名" },
      ],
    } },
  };
  const resolved = readSentinel(transform(wrap(payload))).westernDiagnosis.primary;
  assert.equal(resolved.guidelineRefs, undefined, "模型侧字段必须被删除，防止自撰字符串旁路进入呈现");
  assert.equal(resolved.guidelineReferences.length, 1, "只保留能反查到的条目");
  assert.match(resolved.guidelineReferences[0].citation, /中华医学会呼吸病学分会/);
  assert.equal(resolved.guidelineReferences[0].appliesTo, "支持本例咳嗽的分层评估口径");
});

check("⑩ 模型漏填 evidenceId 时，M03 必须从本轮真实检索结果确定性补入首条依据", () => {
  const transform = buildEvidenceOutputTransform(GUIDE_CONTEXT);
  const payload = {
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
    westernDiagnosis: { primary: { name: "咳嗽", guidelineRefs: [] } },
  };
  const resolved = readSentinel(transform(wrap(payload))).westernDiagnosis.primary;
  assert.equal(resolved.guidelineReferences.length, 1, "模型漏填不能再让整栏静默为空");
  assert.equal(resolved.guidelineReferences[0].evidenceId, "EVID-GUIDE-002");
  assert.match(resolved.guidelineReferences[0].citation, /中国咳嗽基层诊疗与管理指南/);
  assert.equal(resolved.guidelineReferences[0].url, "https://www.evimed.com/guide/002");

  const noRetrievedEvidence = buildEvidenceOutputTransform("无 EVID-GUIDE 或 EVID-PAPER 条目");
  const failClosed = readSentinel(noRetrievedEvidence(wrap(payload))).westernDiagnosis.primary;
  assert.equal(failClosed.guidelineReferences, undefined, "本轮没有真实检索条目时不得补造引用");
});

check("⑩ 自动补位必须排除与患者年龄不符的人群指南", () => {
  const context = [
    "[EVID-GUIDE-001] 中国儿童慢性湿性咳嗽诊疗共识（儿科学组，2023）：儿童湿性咳嗽。",
    "[EVID-GUIDE-002] 咳嗽的诊断与治疗指南（呼吸病学分会，2021）：成人与儿童咳嗽分层评估。",
  ].join("\n");
  const transform = buildEvidenceOutputTransform(context, undefined, {
    id: "adult-cough",
    phase: "diagnose",
    patient: { sex: "女", age: 36 },
    chiefComplaint: "干咳、咽痒4周",
    symptoms: { presentHistory: "少痰，无发热或气促" },
    conversation: [],
  });
  const payload = {
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
    westernDiagnosis: { primary: { name: "感染后咳嗽", supportingFacts: ["干咳4周"], guidelineRefs: [] } },
  };
  const resolved = readSentinel(transform(wrap(payload))).westernDiagnosis.primary.guidelineReferences;
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].evidenceId, "EVID-GUIDE-002", "成人病例不得自动引用儿童专病共识");
});

check("⑩ 模型不得跳过通用指南改绑更窄且病例未证实的病因共识", () => {
  const context = [
    "[EVID-GUIDE-001] 新型冠状病毒感染咳嗽诊疗共识（呼吸病学分会，2023）：新冠感染相关咳嗽。",
    "[EVID-GUIDE-002] 咳嗽的诊断与治疗指南（呼吸病学分会，2021）：咳嗽分层评估。",
  ].join("\n");
  const transform = buildEvidenceOutputTransform(context, undefined, {
    id: "generic-cough",
    phase: "diagnose",
    patient: { sex: "女", age: 36 },
    chiefComplaint: "感冒后干咳4周",
    symptoms: { presentHistory: "未记录新冠感染证据" },
    conversation: [],
  });
  const payload = {
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
    westernDiagnosis: { primary: {
      name: "亚急性咳嗽，病因待查",
      supportingFacts: ["干咳4周"],
      guidelineRefs: [{ evidenceId: "EVID-GUIDE-001", appliesTo: "病毒感染后持续性咳嗽" }],
    } },
  };
  const resolved = readSentinel(transform(wrap(payload))).westernDiagnosis.primary.guidelineReferences;
  assert.equal(resolved.length, 1, "诊断终稿只保留检索排序首位且人群适用的一条依据");
  assert.equal(resolved[0].evidenceId, "EVID-GUIDE-002");
  assert.doesNotMatch(JSON.stringify(resolved), /新型冠状病毒|病毒感染后/);
});

check("⑩ 真实但与主诊断无关的检索结果不得为了填栏被强行引用", () => {
  const unrelated = "[EVID-GUIDE-001] 肿瘤患者食欲下降的营养诊疗专家共识（肿瘤营养学组，2022）：肿瘤恶液质营养管理。";
  const transform = buildEvidenceOutputTransform(unrelated, undefined, {
    id: "reflux-with-unrelated-hit",
    phase: "diagnose",
    patient: { sex: "女", age: 78 },
    chiefComplaint: "反酸、嗳气反复1年",
    symptoms: { presentHistory: "餐后加重" },
    conversation: [],
  });
  const payload = {
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
    westernDiagnosis: { primary: { name: "反酸", supportingFacts: ["反酸、嗳气"] } },
  };
  const primary = readSentinel(transform(wrap(payload))).westernDiagnosis.primary;
  assert.equal(primary.guidelineReferences, undefined, "无主诊断相关性时宁可不展示，也不能塞无关真文献");
});

check("⑩ 解析必须幂等，且伪造的 citation 不得存活", () => {
  // 本转换会在同一份内容上被多次调用（流式草稿、最终输出、截断兜底各一次）。
  // 第一版只读 guidelineRefs 而无条件删除 guidelineReferences——第二遍会把第一遍的结果删掉，
  // 正是本轮在修的那一类缺陷，因此单独钉住。
  const transform = buildEvidenceOutputTransform(GUIDE_CONTEXT);
  const payload = {
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
    westernDiagnosis: { primary: { name: "急性上呼吸道感染", guidelineRefs: [{ evidenceId: "EVID-GUIDE-002", appliesTo: "分层评估口径" }] } },
  };
  const once = readSentinel(transform(wrap(payload)));
  const twice = readSentinel(transform(transform(wrap(payload))));
  assert.deepEqual(twice, once, "同一份内容跑两遍必须完全相同");
  assert.equal(once.westernDiagnosis.primary.guidelineReferences.length, 1);

  const forged = readSentinel(transform(wrap({
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
    westernDiagnosis: { primary: { name: "x", guidelineReferences: [{ evidenceId: "EVID-GUIDE-002", citation: "《内科学》第10版（伪造）" }] } },
  }))).westernDiagnosis.primary.guidelineReferences;
  assert.doesNotMatch(JSON.stringify(forged), /内科学|伪造/, "citation 只能来自服务端按 id 反查的结果");
});

check("⑩ 指南/文献依据必须真的出现在医生可见正文里（此前该栏产出 0 条）", () => {
  const payload = {
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
    overview: { primarySyndrome: "风热犯表证", primarySyndromeResolution: "bounded", primarySyndromeBasis: [], overallPathogenesis: "风热袭表" },
    westernDiagnosis: { primary: {
      name: "急性上呼吸道感染", status: "考虑", confidence: "中",
      supportingFacts: ["咽痛3天", "体温38.2℃"],
      supportingFactKinds: [{ fact: "咽痛3天", kind: "symptom" }, { fact: "体温38.2℃", kind: "sign" }],
      limitations: [], suggestedChecks: [],
      guidelineReferences: [{ evidenceId: "EVID-GUIDE-002", citation: "中国咳嗽基层诊疗与管理指南（2024年）（中华医学会呼吸病学分会，2024）", url: "https://www.evimed.com/guide/002", appliesTo: "咳嗽分层评估口径" }],
      evidence: { evidenceLevel: "model_inference", source: "病例内推理", confidence: "中" },
    }, differentials: [] },
    pathogenesis: { summary: "", chain: [], uncertainties: [] },
    therapy: { overallPrinciple: "疏风清热", overallMethod: "疏风清热", subTherapies: [] },
  };
  const visible = synchronizeVisibleClinicalSummary(wrap(payload), "diagnose");
  assert.match(visible, /指南\/文献依据/, "呈现管线本来就是通的，只是永远没人往里填");
  assert.match(visible, /中国咳嗽基层诊疗与管理指南/);
});

// ── ② 依据排序三个出口同源 ─────────────────────────────────────────────────────
check("② Markdown 的证候依据必须走与卡片同一个排序谓词", () => {
  const chief = "咳嗽3天";
  const payload = {
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "diagnose",
    overview: { primarySyndrome: "风寒束表证", primarySyndromeResolution: "bounded", primarySyndromeBasis: [], overallPathogenesis: "风寒袭表" },
    westernDiagnosis: { primary: { name: "急性支气管炎", status: "考虑", confidence: "中", supportingFacts: [], limitations: [], suggestedChecks: [], evidence: {} }, differentials: [] },
    pathogenesis: {
      summary: "",
      symptomClusters: [{ symptoms: ["痰白清稀", "脉浮紧"], mechanism: "风寒袭表" }],
      chain: [{ nodeId: "P1", patientFact: "咳嗽3天", syndromeEvidence: chief, pathogenesis: "风寒袭表", therapyDirection: "辛温解表", evidence: {} }],
      uncertainties: [],
    },
    therapy: { overallPrinciple: "辛温解表", overallMethod: "辛温解表", subTherapies: [] },
  };
  const ranked = prioritizeTcmEvidenceForDisplay([chief], ["痰白清稀", "脉浮紧"], chief, 2);
  assert.ok(ranked.length > 0 && !ranked.includes(chief), "夹具前提：主诉复述应被降权让位给可鉴别的四诊事实");
  const visible = synchronizeVisibleClinicalSummary(wrap(payload), "diagnose", chief);
  assert.match(visible, new RegExp(ranked[0]), `Markdown 证候依据列必须呈现排序后的结果：${ranked.join("；")}`);
});

// ── ③ 西医诊断标签的唯一权威 ───────────────────────────────────────────────────
check("③ 非规范括注写法必须被同一个权威收敛（HIS 与页面同口径）", () => {
  assert.equal(westernDiagnosisLabelForDisplay("头痛（症状性）"), "头痛");
  assert.equal(
    westernDiagnosisLabelForDisplay("急性上呼吸道感染", { system: "ICD-10", code: "J06.900", display: "急性上呼吸道感染" }),
    "急性上呼吸道感染",
  );
});

// ── ⑥ 随证加减的风险提示不得只在两个出口出现 ───────────────────────────────────
check("⑥ Markdown 的随证加减必须呈现 riskNote", () => {
  const payload = {
    schemaVersion: "tcm-cdss-reasoning-v2", stage: "prescribe",
    formula: {
      candidates: [],
      modifications: [{
        trigger: "咽痛明显", targetPathogenesis: "风热袭表", action: "加牛蒡子6g",
        reason: "针对咽痛加强利咽", riskNote: "牛蒡子性寒滑肠，便溏者慎用",
        substitutions: [],
      }],
    },
  };
  const visible = synchronizeVisibleClinicalSummary(wrap(payload), "prescribe");
  assert.match(visible, /风险提示：牛蒡子性寒滑肠，便溏者慎用/,
    "加减会改变方的构成，「这一加会带来什么风险」正是医生采纳前要看的那句");
});

// ── ⑨ 复核措辞必须与实际拓扑一致 ───────────────────────────────────────────────
check("⑨ 同模型第二次请求不得被称作「独立复核」", () => {
  assert.equal(clinicalReviewIndependenceOf(false), "same_model_second_pass");
  assert.equal(clinicalReviewIndependenceOf(undefined), "same_model_second_pass", "未记录时按较弱一档，不得缺省成独立");
  assert.equal(clinicalReviewIndependenceOf(true), "cross_model");
  assert.equal(clinicalReviewLabel("same_model_second_pass"), "二次临床复核");
  const notice = "> 临床复核状态：独立诊断复核本轮未完成。以下结果已通过独立临床复核的结构校验。";
  const rewritten = applyClinicalReviewIndependenceWording(notice, "same_model_second_pass");
  assert.doesNotMatch(rewritten, /独立/, `同模型拓扑下不得残留「独立」字样：${rewritten}`);
  assert.equal(applyClinicalReviewIndependenceWording(notice, "cross_model"), notice, "跨模型拓扑下必须零操作");
});

// ── ⑫④ 库存分片必须要么全到齐、要么一条不落地 ──────────────────────────────────
await check("⑫④ 分片导入不得让前一批被后一批覆盖", async () => {
  const batch1 = ["麻黄", "桂枝", "杏仁", "甘草"].map((name) => ({ name, kind: "herb" }));
  const batch2 = ["柴胡", "黄芩", "半夏"].map((name) => ({ name, kind: "herb" }));
  await importDrugInventory(CUSTOMER_ID, { source: "t", items: batch1 });
  resetDrugInventoryCacheForTests();
  const baseline = (await drugInventorySnapshot(CUSTOMER_ID)).itemCount;
  assert.equal(baseline, 4);

  const first = await importDrugInventory(CUSTOMER_ID, { source: "t", items: batch1, part: { importId: "imp-20260810", index: 0, total: 2 } });
  assert.ok(first.ok && "pending" in first, "缺片时必须返回待补状态而不是提交");
  resetDrugInventoryCacheForTests();
  assert.equal((await drugInventorySnapshot(CUSTOMER_ID)).itemCount, baseline, "缺片期间线上库存一个字节都不许动");

  const second = await importDrugInventory(CUSTOMER_ID, { source: "t", items: batch2, part: { importId: "imp-20260810", index: 1, total: 2 } });
  assert.ok(second.ok && "snapshot" in second, "集齐后才提交");
  resetDrugInventoryCacheForTests();
  assert.equal((await drugInventorySnapshot(CUSTOMER_ID)).itemCount, 7, "两片合起来是一整批，一味不丢");

  const over = await importDrugInventory(CUSTOMER_ID, { items: Array.from({ length: 20_001 }, (_, index) => ({ name: `药${index}`, kind: "herb" })) });
  assert.equal(over.ok, false);
  assert.doesNotMatch(over.error, /split the import into batches/,
    "413 文案不得再教对方分批——落盘是整批替换，分批会让第一批被删光");
  assert.match(over.error, /part=/, "必须给出真实可用的分片整批替换通路");
});

// ── 50 例基层回归线上实测追加的两条（2026-08-11）────────────────────────────────
check("审方提交中成药必须带确定性推导的给药途径，且外用药绝不报成口服", async () => {
  const { oralRouteForAuditedMedicine } = await load("src/lib/rxaudit.ts");
  // 实测：中成药一律不带 route_name 提交 ⇒ 审方每味回「给药途径未提供」ROUTE_MISMATCH，
  // 一个含 2 味中成药的病例固定多出 2 条人工复核告警。饮片那一侧早就写死了 route_name:"口服"。
  for (const oral of ["少腹逐瘀丸", "七味解痛口服液", "藿香正气软胶囊", "小柴胡颗粒"]) {
    assert.equal(oralRouteForAuditedMedicine(oral), true, `${oral} 应按说明书 usage 判为口服`);
  }
  // 判据必须读说明书 usage 原文，不能按剂型后缀猜：第一版按「散」猜，把吹敷患处的
  // 冰硼散判成了口服——把外用药报成口服比不报途径危险得多。
  for (const external of ["冰硼散", "麝香壮骨膏", "痔疮栓", "云南白药气雾剂"]) {
    assert.equal(oralRouteForAuditedMedicine(external), false, `${external} 是外用，不得报成口服`);
  }
  assert.equal(oralRouteForAuditedMedicine("受控目录里不存在的药"), false, "查不到条目即不写途径（fail-closed）");
});

check("审方已核验的煎法补充表覆盖火麻仁与蜂蜜", async () => {
  const { requiredDecoctionRequirement } = await load("src/lib/herb-decoction-rules.ts");
  // 实测：审方分别提「火麻仁 应包煎」「蜂蜜 应烊化」，而本地知识库这两味没有煎法字段，
  // 于是我方无法在出方时先标注，只能等审方回头提——M05「可预防问题」正是拦这个形态。
  assert.match(String(requiredDecoctionRequirement("火麻仁") || ""), /包煎/);
  assert.match(String(requiredDecoctionRequirement("蜂蜜") || ""), /烊化/);
  // 既有条目不得被这次补充改动
  assert.match(String(requiredDecoctionRequirement("苦杏仁") || ""), /后下/);
});

check("红旗首屏的处置指令必须带明确紧迫性，不能只写「需先完成」", async () => {
  const { evaluateSafetyGate } = await load("src/lib/diagnosis-safety.ts");
  const state = normalizeCaseStateInput({
    id: "rf", phase: "collect", patient: { sex: "男", age: 58 },
    chiefComplaint: "胸口突然像石头压着1小时",
    symptoms: { presentHistory: "胸痛伴大汗，向左肩背放射，伴气促，歇着也不缓" },
  });
  const gate = evaluateSafetyGate(state);
  assert.equal(gate.status, "red_flag");
  const reason = gate.reasons.join("；");
  // 50 例基层回归实测（RF02 胸痛）：原文「需先完成急诊或转诊评估」有动作、无时限。
  // 这句是红旗病例**首屏第一眼**看到的处置指令，不该让医生自己去推断有多急。
  assert.match(reason, /(?:立即|马上|即刻|立刻|尽快)[^。；\n]{0,40}(?:急诊|120|急救|转诊)/,
    `红旗处置指令缺少紧迫性副词：${reason}`);
});

console.log(JSON.stringify({ suite: "customer-review-20260810", checks, failures: failures.length }));
if (failures.length > 0) {
  console.error(JSON.stringify(failures, null, 2));
  process.exitCode = 1;
}
