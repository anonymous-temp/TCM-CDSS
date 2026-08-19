import assert from "node:assert/strict";
import { createJiti } from "jiti";

// 本套件验证的是安全门/就诊目标门的**机制**（红旗判定、指纹确认、过期指纹拒绝、非剂量合同
// 渲染）。产品默认档已改为 advise（提示不拦截，甲方 2026-08-01 决策），机制保留在 block 档
// 作为运维回退开关——因此这里显式切到 block 档来测机制本身；advise 档的默认性与横幅行为
// 由下方独立断言与 50 例在线回归覆盖。必须在 import diagnosis-safety 之前设置。
process.env.CDSS_GATE_DISPOSITION = "block";
const TEST_CUSTOMER_ID = "test-hospital";

const jiti = createJiti(import.meta.url, { alias: { "@": `${process.cwd()}/src`, "server-only": "/dev/null" } });
const {
  buildSafetyLimitedDiagnosis,
  buildSafetyLimitedDiagnosisReasoning,
  buildSafetyLimitedPrescription,
  isNonDosePrescriptionText,
  buildSafetyLimitedRisk,
  deriveOperationalCompleteness,
  derivePrescriptionPermission,
  deriveSafetyLocked,
  withSafetyGate,
} = await jiti.import("../src/lib/diagnosis-safety.ts");
const { buildHisAiSchemePayload } = await jiti.import("../src/lib/his-scheme.ts");

const base = {
  id: "permission-case",
  customerId: TEST_CUSTOMER_ID,
  phase: "done",
  patient: { sex: "男", age: 42 },
  chiefComplaint: "入睡困难伴多梦2个月",
  symptoms: { presentHistory: "近2个月每晚入睡需1小时以上，多梦易醒，每周至少5晚，白天疲乏" },
  tongue: "舌淡，苔薄白",
  pulse: "脉细",
  allergyHistory: "否认药物及食物过敏",
  medicationHistory: "否认当前用药",
  pastHistory: "否认明显打鼾、目击呼吸暂停及日间嗜睡，无高血压病史",
  vitals: { temperature: "36.6℃", pulse: "72次/分", respiration: "18次/分", bloodPressure: "118/76mmHg" },
  conversation: [],
  completeness: { level: "C", redFlag: 0, infoGain: 0.8, managementImpact: 0.8, answerability: 0.8 },
  questionRounds: 1,
  maxQuestionRounds: 1,
  diagnosis: "## 西医诊断\n失眠障碍待临床确认\n\n## 中医证候\n心脾两虚证\n\n## 总体病机\n心脾两虚，神失所养。",
  prescription: "## 中药饮片候选处方\n归脾汤加减\n| 药味 | 剂量 |\n|---|---|\n| 党参 | 10g |\n| 炒白术 | 10g |\n\n## 西药/中成药方案\n本例暂不推荐具体西药或中成药。",
  riskAssessment: "## 合理用药审方\n未发现明确禁忌，仍需医生复核。\n\n## 随访计划\n一周后复诊。",
};

function permission(state) {
  return derivePrescriptionPermission(withSafetyGate(state));
}

assert.deepEqual(permission(base), {
  candidateMode: "full_dose",
  formalAdoption: "eligible_after_doctor_confirmation",
  reasons: [],
});

const sparse = { ...base, patient: {}, symptoms: {}, tongue: undefined, pulse: undefined, allergyHistory: undefined, medicationHistory: undefined, vitals: {} };
const sparsePermission = permission(sparse);
assert.equal(sparsePermission.candidateMode, "limited_dose", "完成一轮追问后，患者仍无法补充时应继续生成有限信息候选");
assert.equal(sparsePermission.formalAdoption, "eligible_after_doctor_confirmation", "普通信息不足不得阻断医生流程，但必须要求医生确认未知边界");

const sparseScheme = buildHisAiSchemePayload(withSafetyGate(sparse));
assert.ok(sparseScheme.prescriptions.herbal.length > 0, "追问后有限候选仍应在 HIS 方案中可见");
assert.equal(sparseScheme.writeBackPolicy.allowSingleItemAdoption, true);
assert.equal(sparseScheme.candidateStatus, "valid");

const sparseBeforeFollowup = { ...sparse, questionRounds: 0 };
assert.equal(permission(sparseBeforeFollowup).candidateMode, "non_dose_only", "初始A/B级病例必须优先进入M02，不能直接跳过追问");
assert.equal(permission(sparseBeforeFollowup).formalAdoption, "blocked");

for (const [id, chiefComplaint, presentHistory] of [
  ["BO02", "感冒", ""],
  ["BO04", "头痛<script>alert(1)</script>", ""],
  ["BO06", "失眠", "患者\n含\r\n各种\t制表符\b退格"],
  ["BO10", "乏力", "null undefined NaN"],
]) {
  const state = {
    ...base,
    chiefComplaint,
    symptoms: presentHistory ? { presentHistory } : {},
    tongue: "舌淡，苔薄白",
    pulse: "脉细",
    completeness: { level: "C", redFlag: 1, infoGain: 1, managementImpact: 1, answerability: 1 },
    questionRounds: 0,
  };
  assert.equal(deriveOperationalCompleteness(state).level, "B", `${id}客户端伪造C级和默认舌脉不能绕过服务端信息量重算`);
  assert.equal(permission(state).candidateMode, "non_dose_only", `${id}首轮必须先追问`);
}

const advisoryOnly = {
  ...base,
  safetyGate: {
    status: "ready",
    allowDiagnosis: true,
    allowDosePrescription: true,
    action: "proceed",
    missingItems: [],
    redFlags: [],
    advisories: ["建议尽快复测血压；提示不阻断辅助推理。"],
    reasons: [],
  },
};
assert.equal(permission(advisoryOnly).candidateMode, "full_dose", "普通风险提示不得降低候选权限");

const auditAlert = {
  ...base,
  riskAssessment: "## 合理用药审方\nCRITICAL：需医生重点复核。",
  prescriptionRevision: {
    source: "herb_workbench",
    candidateIndex: 0,
    herbHash: "hash",
    auditedAt: new Date(0).toISOString(),
    auditResult: "BLOCK",
    highestRiskLevel: "CRITICAL",
    auditAvailable: true,
    needManualReview: true,
  },
};
assert.deepEqual(permission(auditAlert), permission(base), "审方只提供提示，不改变候选或正式采纳权限");

for (const pastHistory of [
  "妊娠8周",
  "现妊娠8周",
  "确认怀孕，孕10周",
  "高血压5年；目前妊娠12周",
  "既往史栏误填：确认怀孕，孕10周",
]) {
  const pregnancy = { ...base, patient: { sex: "女", age: 31 }, pastHistory };
  assert.equal(permission(pregnancy).candidateMode, "non_dose_only", `当前妊娠必须阻断剂量候选: ${pastHistory}`);
  assert.equal(permission(pregnancy).formalAdoption, "blocked", `当前妊娠不得正式采纳: ${pastHistory}`);
}

for (const pastHistory of [
  "既往妊娠8周自然流产史",
  "妊娠史：曾怀孕8周后自然流产",
  "既往孕3产1",
  "曾经怀孕，现已终止妊娠",
]) {
  assert.notEqual(
    permission({ ...base, patient: { sex: "女", age: 31 }, pastHistory }).candidateMode,
    "non_dose_only",
    `明确历史妊娠不得误判为当前妊娠: ${pastHistory}`,
  );
}

const pediatric = { ...base, patient: { sex: "男", age: 8 } };
assert.equal(permission(pediatric).candidateMode, "non_dose_only");

for (const [label, patch] of [
  ["CKD4期", { pastHistory: "慢性肾脏病4期，近期eGFR 24mL/min" }],
  ["心衰", { pastHistory: "慢性心力衰竭，EF35%" }],
  ["抗凝", { medicationHistory: "当前口服华法林3mg，每日一次" }],
  ["免疫抑制", { medicationHistory: "当前服用他克莫司1mg，每日2次" }],
  ["糖尿病足", { pastHistory: "2型糖尿病，当前右足溃疡，诊断糖尿病足" }],
  ["活动期自身免疫病", { pastHistory: "系统性红斑狼疮活动期，近期皮疹及关节痛加重" }],
]) {
  const governedState = withSafetyGate({ ...base, ...patch });
  const result = derivePrescriptionPermission(governedState);
  assert.equal(result.candidateMode, "non_dose_only", `${label}必须进入高风险非剂量路径`);
  assert.equal(result.formalAdoption, "blocked", `${label}未经专科/药师复核不得正式采纳`);
  assert.equal(deriveSafetyLocked(governedState), true, `${label}的独立确定性剂量门必须在审方前建立安全锁`);
}

for (const [label, patch] of [
  ["已排除肾功能不全", { pastHistory: "本次检查未发现肾功能不全，eGFR 92mL/min" }],
  ["既往已停抗凝", { medicationHistory: "两年前服用华法林，现已停用；当前否认其他用药" }],
  ["稳定自身免疫病", { pastHistory: "系统性红斑狼疮目前稳定，无近期复发或加重" }],
]) {
  assert.notEqual(permission({ ...base, ...patch }).candidateMode, "non_dose_only", `${label}不得被当前高风险规则误伤`);
}

const semanticUnavailable = {
  ...base,
  clinicalFacts: {
    redFlags: [],
    semanticStatus: "unavailable",
    unavailableReason: "timeout",
    sourceCoverage: "full",
    reviewStatus: "unavailable",
  },
};
assert.equal(permission(semanticUnavailable).candidateMode, "non_dose_only", "语义红旗筛查未完成时只允许非剂量分析");
assert.equal(permission(semanticUnavailable).formalAdoption, "blocked");

const urgentActiveBleeding = {
  ...base,
  chiefComplaint: "这两天反复解少量黑便，目前精神和血压稳定",
  clinicalFacts: {
    redFlags: [{
      category: "gi_bleed",
      subject: "patient",
      status: "positive",
      urgency: "urgent",
      triageBasis: "urgent_review",
      quote: "反复解少量黑便",
    }],
    semanticStatus: "checked",
    reviewStatus: "checked",
    sourceCoverage: "full",
  },
};
const urgentGate = withSafetyGate(urgentActiveBleeding).safetyGate;
assert.equal(urgentGate?.status, "red_flag", "活动性黑便应按消化道出血风险进入急症分流");
assert.equal(permission(urgentActiveBleeding).candidateMode, "non_dose_only", "活动性消化道出血不得生成剂量候选");
assert.equal(permission(urgentActiveBleeding).formalAdoption, "blocked");

const emergency = {
  ...base,
  chiefComplaint: "当前持续胸痛30分钟未缓解",
  safetyGate: {
    status: "red_flag",
    allowDiagnosis: true,
    allowDosePrescription: false,
    action: "refer_or_emergency",
    missingItems: [],
    redFlags: ["疑似时间敏感性急性心血管事件"],
    reasons: ["请优先急诊评估"],
  },
};
assert.equal(permission(emergency).candidateMode, "non_dose_only");
assert.equal(permission(emergency).formalAdoption, "blocked");

const emergencyLimited = buildSafetyLimitedDiagnosisReasoning(emergency, emergency.safetyGate);
assert.equal(emergencyLimited.stage, "diagnose");
assert.equal(emergencyLimited.overview.primarySyndromeResolution, "unresolved");
assert.equal(emergencyLimited.pathogenesis.chain.length, 0);
assert.equal(emergencyLimited.formula, null);
assert.equal(emergencyLimited.overview.evidence.evidenceLevel, "deterministic_rule");
assert.match(emergencyLimited.management.redFlagLoop, /120/);

const exhaustedGate = {
  status: "needs_information",
  allowDiagnosis: false,
  allowDosePrescription: false,
  action: "complete_before_prescription",
  missingItems: ["稳定的证候与病机链"],
  redFlags: [],
  reasons: ["M03结构或临床复核未通过"],
};
const exhaustedLimited = buildSafetyLimitedDiagnosisReasoning(base, exhaustedGate);
assert.equal(exhaustedLimited.overview.primarySyndromeResolution, "unresolved");
assert.equal(exhaustedLimited.pathogenesis.chain.length, 0);
assert.equal(exhaustedLimited.formula, null);
assert.match(exhaustedLimited.overview.primarySyndromeResolutionReason, /未形成/);

const analysisIncompleteGate = {
  ...exhaustedGate,
  missingItems: ["本次辨病辨证结果完整性"],
  reasons: ["本次辨病辨证结果未通过完整性与临床一致性复核，本轮不生成剂量级候选。"],
};
const analysisIncompleteDisplay = buildSafetyLimitedDiagnosis(base, analysisIncompleteGate);
assert.match(analysisIncompleteDisplay, /当前已确认：[\s\S]*当前尚不能形成：[\s\S]*下一步：/);
assert.doesNotMatch(analysisIncompleteDisplay, /暂不生成|剂量级|当前未满足形成该项建议的条件西医/);
assert.match(analysisIncompleteDisplay, /本次未形成可复核的完整辨病辨证结果/);
assert.match(analysisIncompleteDisplay, /保留已录入病历并由医生人工判断/);
assert.doesNotMatch(analysisIncompleteDisplay, /(?:M03|模型输出|签名有限结果|左侧病历|底部补充框)/, "limited clinician output must not expose orchestration or layout jargon");
for (const limitedOutput of [
  buildSafetyLimitedPrescription(analysisIncompleteGate),
  buildSafetyLimitedRisk(analysisIncompleteGate),
]) {
  assert.match(limitedOutput, /当前已确认：[\s\S]*当前尚不能形成：[\s\S]*下一步：/);
  assert.doesNotMatch(limitedOutput, /暂不生成|剂量级|当前未满足形成该项建议的条件|处方建议候选处方/);
}

const noChief = { ...base, chiefComplaint: "" };
assert.equal(permission(noChief).candidateMode, "blocked");

// —— encounterScope 门禁与签名有限 M03（服务端路由级，mock 语义层，确定性无外部模型调用）——
process.env.REASONING_CONTRACT_SIGNING_KEY = "permission-test-m03-signing-key-0123456789abcdef";
process.env.CLINICAL_FACTS_ATTESTATION_KEY = "permission-test-clinical-facts-key-2026";
const { buildDiagnoseContractSignatureContext, signDiagnoseReasoning, verifyDiagnoseReasoningSignature } = await jiti.import("../src/lib/reasoning-contract-signature.ts");
const { hasUnconfirmedUnclearEncounterScope, maybeAttachClinicalFactsBackstop } = await jiti.import("../src/lib/clinical-facts-runtime.ts");
const { sanitizeCaseStateForModel, trustedInputText } = await jiti.import("../src/lib/diagnosis-safety.ts");
const { normalizeCaseStateInput } = await jiti.import("../src/lib/diagnosis-types.ts");
const { POST: prescribePost } = await jiti.import("../src/app/api/diagnosis/prescribe/route.ts");
const { POST: hisSchemePost } = await jiti.import("../src/app/api/diagnosis/his-scheme/route.ts");
const { buildAuditPositiveControlState } = await import("./lib/primary-care-audit-positive-controls.mjs");
const { createHash } = await import("node:crypto");

const scopeControl = {
  id: "encounter-scope-gate",
  mutation: "encounter-scope",
  patient: { sex: "男", age: 46 },
  chiefComplaint: "叙述含糊，本次就诊目标不明确",
  diagnosis: "症状待查",
  syndrome: "心脾两虚证",
  pastHistory: "否认重要慢病",
  medicationHistory: "否认当前用药",
  allergyHistory: "否认药物过敏",
  herbs: [{ name: "黄芪", dose: "15g" }, { name: "酸枣仁", dose: "15g" }],
};
const unsignedScopeState = buildAuditPositiveControlState(scopeControl);
unsignedScopeState.customerId = TEST_CUSTOMER_ID;
const unsignedScopeDiagnose = {
  ...unsignedScopeState.reasoningPrescribe,
  stage: "diagnose",
  overview: {
    ...unsignedScopeState.reasoningPrescribe.overview,
    primarySyndromeResolution: "resolved",
    recommendedFormulaNames: [],
    formulaSelectionMode: "self_devised",
  },
  formula: null,
  nonPharma: null,
  clinicalReview: undefined,
};
const signedScopeDiagnose = signDiagnoseReasoning(unsignedScopeDiagnose, buildDiagnoseContractSignatureContext(unsignedScopeState));
const builtScopeState = buildAuditPositiveControlState(scopeControl, signedScopeDiagnose);
builtScopeState.customerId = TEST_CUSTOMER_ID;
// 路由会再次 normalizeCaseStateInput；先做一次 JSON 归一化再挂载语义事实，保证指纹命中缓存、
// 路由内的语义回填不再发起任何模型调用。
const roundTrippedScopeState = normalizeCaseStateInput(JSON.parse(JSON.stringify(builtScopeState)));
assert.equal(verifyDiagnoseReasoningSignature(signedScopeDiagnose, roundTrippedScopeState), true, "签名 M03 必须绑定归一化后的病例输入");

const unclearFactsMock = async () => JSON.stringify({
  redFlags: [],
  encounterScope: { status: "unclear", quote: "叙述含糊，本次就诊目标不明确" },
});
const unclearScopeState = await maybeAttachClinicalFactsBackstop(roundTrippedScopeState, unclearFactsMock);
assert.equal(unclearScopeState.clinicalFacts?.encounterScope?.status, "unclear", "语义预检结论应为 unclear");
const reparsedUnclearState = normalizeCaseStateInput(JSON.parse(JSON.stringify(unclearScopeState)));
const fingerprintOf = (state) => createHash("sha256").update(trustedInputText(sanitizeCaseStateForModel(state))).digest("hex").slice(0, 32);
assert.equal(fingerprintOf(reparsedUnclearState), unclearScopeState.clinicalFacts.sourceFingerprint, "归一化往返后指纹必须稳定，路由才能命中语义缓存");

const routeRequest = (path, state) => new Request(`http://localhost${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-cdss-customer-id": TEST_CUSTOMER_ID },
  body: JSON.stringify({ caseState: state }),
});

// 1.2c: attested-unclear 且无确认 ⇒ M04 返回非剂量合同，不得静默进入剂量链
assert.equal(hasUnconfirmedUnclearEncounterScope(withSafetyGate(unclearScopeState)), true, "未确认的 attested-unclear 必须被门禁识别");
const unconfirmedPrescribeText = await (await prescribePost(routeRequest("/api/diagnosis/prescribe", unclearScopeState))).text();
assert.match(unconfirmedPrescribeText, /CDSS_NON_DOSE_PRESCRIPTION/, "未确认 unclear 必须返回非剂量合同");
assert.match(unconfirmedPrescribeText, /本次当前活动性治疗目标确认/, "非剂量合同必须显式列出待确认项");

// 1.2c: 指纹匹配的医生确认 ⇒ 门禁放行（本夹具随后停在确定性 M04 签名/复核门，而非 unclear 门）
const confirmedScopeState = {
  ...unclearScopeState,
  encounterScopeConfirmation: {
    sourceFingerprint: unclearScopeState.clinicalFacts.sourceFingerprint,
    confirmedAt: new Date().toISOString(),
  },
};
assert.equal(hasUnconfirmedUnclearEncounterScope(withSafetyGate(confirmedScopeState)), false, "指纹匹配的确认必须解除 unclear 门禁");
const confirmedPrescribeText = await (await prescribePost(routeRequest("/api/diagnosis/prescribe", confirmedScopeState))).text();
assert.doesNotMatch(confirmedPrescribeText, /本次当前活动性治疗目标确认/, "确认后不得再因 unclear 门禁拦截");
// M03 复检改为注入 isSafetyRejection 谓词后, 本夹具的有限 M03(仅 T2 级缺陷)正确放行到
// 生成层——单测环境无模型 API key, 推进到模型调用即为「已越过全部确定性门禁」的证明。
// 若真回退到「缺少有效的西医诊断」拦截, 说明谓词又被丢掉(第7处复发点回归), 必须红。
assert.match(confirmedPrescribeText, /OPENAI_API_KEY not configured|辨证语义复核未完成/, "确认后流程应推进过 M03 复检直至生成层");

// 1.2c: 过期指纹（病历已变化）的确认 ⇒ 仍阻断
const staleConfirmedState = {
  ...unclearScopeState,
  encounterScopeConfirmation: { sourceFingerprint: "0".repeat(32), confirmedAt: new Date().toISOString() },
};
assert.equal(hasUnconfirmedUnclearEncounterScope(withSafetyGate(staleConfirmedState)), true, "过期指纹确认不得解除门禁");
const stalePrescribeText = await (await prescribePost(routeRequest("/api/diagnosis/prescribe", staleConfirmedState))).text();
assert.match(stalePrescribeText, /本次当前活动性治疗目标确认/, "过期指纹确认下仍必须返回待确认非剂量合同");

// 1.2d: HIS 方案同样不得为未确认 unclear 输出剂量级药味
const unconfirmedHisResponse = await hisSchemePost(routeRequest("/api/diagnosis/his-scheme", unclearScopeState));
assert.equal(unconfirmedHisResponse.status, 200);
const unconfirmedHisPayload = await unconfirmedHisResponse.json();
assert.equal(unconfirmedHisPayload.prescriptions.structuredHerbs.length, 0, "未确认 unclear 不得输出 HIS 结构化药味");
assert.ok(unconfirmedHisPayload.prescriptions.herbal.every((section) => !section.content && !section.adoptable),
  "未确认 unclear 的 HIS 药味卡必须为空且不可采纳");
const confirmedHisResponse = await hisSchemePost(routeRequest("/api/diagnosis/his-scheme", confirmedScopeState));
const confirmedHisPayload = await confirmedHisResponse.json();
assert.equal(confirmedHisResponse.status, 409, "确认后 unclear 门放行，本夹具停在 M04 签名门");
assert.equal(confirmedHisPayload.code, "invalid_m04_signature");

// 回归: agreed-historical 不触发 unclear 确认门；其剂量阻断仍由签名有限 M03 承担
const agreedHistoricalState = await maybeAttachClinicalFactsBackstop(
  { ...roundTrippedScopeState, pastHistory: "胃溃疡3年前已治愈，目前无不适" },
  async () => JSON.stringify({
    redFlags: [],
    encounterScope: { status: "historical_or_stable_only", quote: "胃溃疡3年前已治愈，目前无不适" },
  }),
);
assert.equal(agreedHistoricalState.clinicalFacts?.encounterScope?.reviewAgreement, "agreed");
assert.equal(hasUnconfirmedUnclearEncounterScope(withSafetyGate(agreedHistoricalState)), false, "agreed-historical 不属于 unclear 确认门");

const historicalLimitedM03 = signDiagnoseReasoning(
  buildSafetyLimitedDiagnosisReasoning(roundTrippedScopeState, {
    status: "needs_information",
    allowDiagnosis: true,
    allowDosePrescription: false,
    action: "complete_before_prescription",
    missingItems: ["本次当前活动性治疗目标"],
    redFlags: [],
    reasons: ["独立语义预检一致判断当前记录仅含既往、已缓解或稳定背景"],
  }),
  buildDiagnoseContractSignatureContext(roundTrippedScopeState),
);
const historicalLimitedState = { ...roundTrippedScopeState, reasoningDiagnose: historicalLimitedM03, reasoningV2: historicalLimitedM03 };
const historicalPrescribeText = await (await prescribePost(routeRequest("/api/diagnosis/prescribe", historicalLimitedState))).text();
assert.match(historicalPrescribeText, /CDSS_NON_DOSE_PRESCRIPTION/, "签名有限 M03（agreed-historical）必须仍然返回非剂量合同");
assert.match(historicalPrescribeText, /本次当前活动性治疗目标/, "agreed-historical 非剂量合同必须保留待补录项");

// G5: 签名急症有限 M03 的 M04 快速返回必须携带真实红旗内容与急诊指引，而不是泛化占位诊断名
const emergencyLimitedM03 = signDiagnoseReasoning(
  buildSafetyLimitedDiagnosisReasoning(roundTrippedScopeState, {
    status: "red_flag",
    allowDiagnosis: true,
    allowDosePrescription: false,
    action: "refer_or_emergency",
    missingItems: ["急诊评估"],
    redFlags: ["突发胸痛伴大汗30分钟未缓解"],
    reasons: ["命中急危重门禁"],
  }),
  buildDiagnoseContractSignatureContext(roundTrippedScopeState),
);
const emergencyLimitedState = { ...roundTrippedScopeState, reasoningDiagnose: emergencyLimitedM03, reasoningV2: emergencyLimitedM03 };
const emergencyPrescribeText = await (await prescribePost(routeRequest("/api/diagnosis/prescribe", emergencyLimitedState))).text();
assert.match(emergencyPrescribeText, /CDSS_NON_DOSE_PRESCRIPTION/);
assert.match(emergencyPrescribeText, /突发胸痛伴大汗30分钟未缓解/, "急诊快速返回必须保留 supportingFacts 中的真实红旗");
assert.match(emergencyPrescribeText, /立即停止常规诊疗并转急诊；危及生命时呼叫120/, "急诊快速返回必须保留 redFlagLoop 指引");
assert.doesNotMatch(emergencyPrescribeText, /急危重症风险待排除/, "泛化占位诊断名不得再掩盖具体红旗");

// G1: 签名有限 M03 + 客户端声称的工作台修订 ⇒ HIS 写回剂量路径必须 409
const clearFactsMock = async () => JSON.stringify({ redFlags: [] });
const g1AttackState = await maybeAttachClinicalFactsBackstop(
  { ...roundTrippedScopeState, reasoningDiagnose: historicalLimitedM03 },
  clearFactsMock,
);
const g1HisResponse = await hisSchemePost(routeRequest("/api/diagnosis/his-scheme", g1AttackState));
const g1HisPayload = await g1HisResponse.json();
assert.equal(g1HisResponse.status, 409, "签名有限 M03 不得进入 HIS 剂量写回");
assert.equal(g1HisPayload.code, "limited_m03_not_prescribable");

// ─── 非剂量合同的剂量词否决只能扫处方正文，不能扫红旗引文 ───
// 前端（DiagnosisClient 的 expectedNonDoseLimitedPrescription）用「marker + isNonDosePrescriptionText
// + 无剂量词」三条判定服务端的确定性非剂量合同。剂量词若按全文扫，会命中服务端插值进
// 「## 处方前必要信息核查 / ## 用药风险提示」的 gate.redFlags —— 而红旗本身就常逐字引用病历数值
// （"血红蛋白 58 g/L""呕血约300mL""二甲双胍 500mg bid"）。判定一旦失败，这份合同会被当成
// 「传输/结构失败」渲染成红色错误卡 + 必然再败的「重新生成」按钮：越危急的病例越容易命中。
// 这里把前端同款判定按类别钉住，防止扫描范围再被放宽回全文。
const nonDoseGate = (redFlags) => ({
  status: redFlags.length ? "red_flag" : "needs_information",
  allowDiagnosis: true,
  allowDosePrescription: false,
  action: "complete_before_prescription",
  missingItems: ["与本次主诉相关的四诊信息"],
  redFlags,
  reasons: ["需先完成急诊评估"],
});
const nonDoseBodySections = (text) => text
  .split(/^##\s+/m)
  .filter((section) => /^(?:中药饮片处方|西药\/中成药方案)/.test(section))
  .join("\n");
const frontendNonDoseVerdict = (text) =>
  text.includes("<!-- CDSS_NON_DOSE_PRESCRIPTION -->") &&
  isNonDosePrescriptionText(text) &&
  !/\d+(?:\.\d+)?\s*(?:g|mg|克|毫克|毫升|mL)\b/i.test(nonDoseBodySections(text));
for (const [label, redFlags] of [
  ["无引文", []],
  ["化验值", ['呕血伴血红蛋白 58 g/L（原文依据："查血红蛋白 58 g/L"）']],
  ["西药用量", ['低血糖风险（原文依据："每天二甲双胍 500mg bid"）']],
  ["出血量", ['活动性上消化道出血（原文依据："呕血约300mL"）']],
  ["中文剂量单位", ['误服（原文依据："一次吃了 20 克"）']],
]) {
  const rendered = buildSafetyLimitedPrescription(nonDoseGate(redFlags));
  assert.ok(frontendNonDoseVerdict(rendered),
    `红旗引文含剂量词不得让非剂量合同被判成生成失败：${label}`);
  // 反向：处方正文本身若真的出现剂量，必须仍被否决。
  const leaked = rendered.replace("## 中药饮片处方\n", "## 中药饮片处方\n黄芪 30g\n");
  assert.equal(frontendNonDoseVerdict(leaked), false,
    `处方正文若真的泄露剂量必须被否决：${label}`);
}

console.log(JSON.stringify({ cases: 72, failures: 0 }));

// ─── 处置模式：默认 advise（提示不拦截），block 为显式回退档 ─────────────────────
// 本套件顶部把进程切到了 block 档来测机制；这里验证开关本身的语义与默认值，
// 以及横幅构造器的确定性输出（不经模型、有稳定标记、必含审方提示）。
{
  const { gateDispositionIsAdvisory, buildSafetyAdvisoryBanner, SAFETY_ADVISORY_MARKER } =
    await jiti.import("../src/lib/diagnosis-safety.ts");
  assert.equal(gateDispositionIsAdvisory(), false, "本套件已显式设 block，开关必须尊重环境变量");
  const prev = process.env.CDSS_GATE_DISPOSITION;
  delete process.env.CDSS_GATE_DISPOSITION;
  assert.equal(gateDispositionIsAdvisory(), true, "缺省必须是 advise——CDSS 不阻断临床流程是产品语义");
  process.env.CDSS_GATE_DISPOSITION = prev;
  const banner = buildSafetyAdvisoryBanner(
    { status: "red_flag", allowDiagnosis: false, allowDosePrescription: false, action: "refer_or_emergency",
      missingItems: [], redFlags: ["胸痛伴大汗"], reasons: ["建议急诊评估优先"] },
    ["附加提示"],
  );
  assert.ok(banner.startsWith(SAFETY_ADVISORY_MARKER), "横幅必须以稳定标记开头，供集成方识别");
  assert.ok(/胸痛伴大汗/.test(banner) && /附加提示/.test(banner), "红旗与附加提示都必须原样呈现");
  assert.ok(/审方复核/.test(banner), "横幅必须包含审方复核提示");
  assert.equal(buildSafetyAdvisoryBanner(undefined, []), "", "无任何提示时不产生横幅");
}
