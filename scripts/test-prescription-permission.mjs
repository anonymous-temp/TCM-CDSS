import assert from "node:assert/strict";
import { createJiti } from "jiti";

// 本套件验证的是安全门/就诊目标门的**机制**（红旗判定、指纹确认、过期指纹拒绝、非剂量合同
// 渲染）。安全门只有一种处置口径（甲方 2026-08-01「提示不拦截」；block 回退档 2026-09-25 删除），
// 所以这里测的就是生产行为：检测照常、剂量按独立硬边界与红旗剂量轴收回、流程不被拦截。
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
  safetyGateForLimitedDiagnosisFallback,
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

// 初始 A/B 级病例（尚未追问）：追问是增强手段而不是门槛——按有限信息生成候选，
// 理由里明确建议补一轮追问；正式采纳仍须医生逐项确认未知边界。
const sparseBeforeFollowup = { ...sparse, questionRounds: 0 };
assert.deepEqual(permission(sparseBeforeFollowup), {
  candidateMode: "limited_dose",
  formalAdoption: "eligible_after_doctor_confirmation",
  reasons: ["当前病历关键信息覆盖有限，候选按有限信息生成；建议补充一轮追问以提高信心"],
}, "初始A/B级病例不拦截：有限信息候选 + 建议追问，不得升格为 full_dose，也不得退回非剂量拦截");

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
  // 伪造的 C 级不得换来 full_dose：服务端重算为 B 后，首轮未追问只给有限信息候选。
  assert.equal(permission(state).candidateMode, "limited_dose", `${id}首轮未追问只能是有限信息候选`);
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
assert.equal(emergencyLimited.overview.primarySyndrome, "症状级工作判断");
assert.equal(emergencyLimited.overview.primarySyndromeResolution, "unresolved");
assert.equal(emergencyLimited.overview.recommendedFormulaDirection, "");
assert.deepEqual(emergencyLimited.overview.recommendedFormulaNames, []);
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
assert.equal(exhaustedLimited.overview.primarySyndrome, "症状级工作判断");
assert.equal(exhaustedLimited.overview.primarySyndromeResolution, "unresolved");
assert.equal(exhaustedLimited.overview.recommendedFormulaDirection, "");
assert.deepEqual(exhaustedLimited.overview.recommendedFormulaNames, []);
assert.equal(exhaustedLimited.pathogenesis.chain.length, 0);
assert.equal(exhaustedLimited.formula, null);
assert.match(exhaustedLimited.overview.primarySyndromeResolutionReason, /未形成/);

// 签名 fallback 必须保留病例的真实红旗，同时追加「本轮为何未完成」的原因。
// 这一个合并点覆盖合同耗尽、时限、复核后驳回、上游不可用四类路由出口。
const mergedEmergencyFallback = safetyGateForLimitedDiagnosisFallback(emergency.safetyGate, exhaustedGate);
assert.equal(mergedEmergencyFallback.status, "red_flag");
assert.equal(mergedEmergencyFallback.allowDiagnosis, false);
assert.equal(mergedEmergencyFallback.allowDosePrescription, false);
assert.equal(mergedEmergencyFallback.action, "refer_or_emergency");
assert.deepEqual(mergedEmergencyFallback.redFlags, emergency.safetyGate.redFlags);
assert.ok(mergedEmergencyFallback.reasons.includes("请优先急诊评估"));
assert.ok(mergedEmergencyFallback.reasons.includes("M03结构或临床复核未通过"));
assert.ok(mergedEmergencyFallback.missingItems.includes("稳定的证候与病机链"));
const mergedEmergencyReasoning = buildSafetyLimitedDiagnosisReasoning(emergency, mergedEmergencyFallback, "deadline");
assert.equal(mergedEmergencyReasoning.overview.primarySyndrome, "症状级工作判断");
assert.equal(mergedEmergencyReasoning.overview.recommendedFormulaDirection, "");
assert.deepEqual(mergedEmergencyReasoning.overview.recommendedFormulaNames, []);
assert.equal(mergedEmergencyReasoning.formula, null);
assert.deepEqual(mergedEmergencyReasoning.westernDiagnosis.primary.supportingFacts, emergency.safetyGate.redFlags);
assert.equal(mergedEmergencyReasoning.clinicalReview?.unavailableReason, "deadline");
const mergedEmergencyDisplay = buildSafetyLimitedDiagnosis(emergency, mergedEmergencyFallback);
assert.match(mergedEmergencyDisplay, /疑似时间敏感性急性心血管事件/);
assert.match(mergedEmergencyDisplay, /立即.*急诊/);
assert.doesNotMatch(mergedEmergencyDisplay, /未识别明确急危重线索/);

assert.equal(
  safetyGateForLimitedDiagnosisFallback(base.safetyGate || withSafetyGate(base).safetyGate, exhaustedGate),
  exhaustedGate,
  "无红旗时应保留 fallback 自身的临床与服务原因",
);

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

// 1.2c: attested-unclear 且无确认 ⇒ 不拦截（提示不拦截）：照常进入候选生成，提示词要求模型在
// 适用边界写明「本次就诊目标需医生确认」，可见正文置顶确定性安全警示横幅。
// 用桩模型（假密钥 + 拦截 fetch）让路由真正走完生成：判据是「打到了上游 + 提示词 + 横幅」，
// 而不是生成前那一页。桩只在本段生效，退出后恢复环境，后面的断言仍按无模型环境运行。
const UNCLEAR_SCOPE_PROMPT = "【就诊目标待确认】";
const UNCLEAR_SCOPE_BANNER_NOTE = "本次就诊是否存在当前活动性治疗目标未确认，请医生确认后再采纳。";
const cannedPrescribeContent = `## 中药饮片处方\n\n<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(builtScopeState.reasoningPrescribe)}\n<!-- DIAGNOSIS_JSON_END -->`;
async function prescribeWithStubModel(state, canned = cannedPrescribeContent) {
  const stubEnv = { AI_TEXT_PROVIDER: "bailian-qwen", BAILIAN_QWEN_API_KEY: "permission-test-fake-key", BAILIAN_QWEN_MODEL: "qwen3.8-flash" };
  const savedEnv = Object.fromEntries(Object.keys(stubEnv).map((key) => [key, process.env[key]]));
  const previousFetch = globalThis.fetch;
  const prompts = [];
  Object.assign(process.env, stubEnv);
  globalThis.fetch = async (_url, init = {}) => {
    const body = JSON.parse(init.body);
    prompts.push((body.messages || []).map((message) => String(message.content)).join("\n"));
    const content = body.response_format && !JSON.stringify(body.response_format).includes("json_schema") ? "{}" : canned;
    if (body.stream) {
      const chunk = JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content }, finish_reason: "stop" }] });
      return new Response(`data: ${chunk}\n\ndata: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return Response.json({ id: "c", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] });
  };
  try {
    const text = await (await prescribePost(routeRequest("/api/diagnosis/prescribe", state))).text();
    return { text, prompts };
  } finally {
    globalThis.fetch = previousFetch;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

assert.equal(hasUnconfirmedUnclearEncounterScope(withSafetyGate(unclearScopeState)), true, "未确认的 attested-unclear 必须被门禁识别");
const unconfirmedPrescribe = await prescribeWithStubModel(unclearScopeState);
assert.ok(unconfirmedPrescribe.prompts.length > 0, "未确认 unclear 不得在生成前拦截：必须照常进入候选生成");
assert.ok(unconfirmedPrescribe.prompts.some((prompt) => prompt.includes(UNCLEAR_SCOPE_PROMPT)),
  "未确认 unclear 的 M04 提示词必须要求模型写明「本次就诊目标需医生确认」");
assert.match(unconfirmedPrescribe.text, /<!-- CDSS_SAFETY_ADVISORY -->/, "未确认 unclear 的可见正文必须置顶确定性安全警示横幅");
assert.ok(unconfirmedPrescribe.text.includes(UNCLEAR_SCOPE_BANNER_NOTE), "横幅必须显式列出「就诊目标未确认」");
assert.doesNotMatch(unconfirmedPrescribe.text, /本次当前活动性治疗目标确认/, "不得再返回生成前的待确认非剂量页");

// 1.2c: 指纹匹配的医生确认 ⇒ 解除 unclear 标记（提示词与横幅都不再带就诊目标待确认）
const confirmedScopeState = {
  ...unclearScopeState,
  encounterScopeConfirmation: {
    sourceFingerprint: unclearScopeState.clinicalFacts.sourceFingerprint,
    confirmedAt: new Date().toISOString(),
  },
};
assert.equal(hasUnconfirmedUnclearEncounterScope(withSafetyGate(confirmedScopeState)), false, "指纹匹配的确认必须解除 unclear 门禁");
const confirmedPrescribe = await prescribeWithStubModel(confirmedScopeState);
assert.ok(confirmedPrescribe.prompts.length > 0, "确认后照常进入候选生成");
assert.ok(!confirmedPrescribe.prompts.some((prompt) => prompt.includes(UNCLEAR_SCOPE_PROMPT)), "确认后提示词不得再带就诊目标待确认");
assert.ok(!confirmedPrescribe.text.includes(UNCLEAR_SCOPE_BANNER_NOTE), "确认后横幅不得再提示就诊目标未确认");
const confirmedPrescribeText = await (await prescribePost(routeRequest("/api/diagnosis/prescribe", confirmedScopeState))).text();
// M03 复检改为注入 isSafetyRejection 谓词后, 本夹具的有限 M03(仅 T2 级缺陷)正确放行到
// 生成层——单测环境无模型 API key, 推进到模型调用即为「已越过全部确定性门禁」的证明。
// 若真回退到「缺少有效的西医诊断」拦截, 说明谓词又被丢掉(第7处复发点回归), 必须红。
assert.match(confirmedPrescribeText, /OPENAI_API_KEY not configured|辨证语义复核未完成/, "确认后流程应推进过 M03 复检直至生成层");

// 1.2c: 过期指纹（病历已变化）的确认 ⇒ 仍视为未确认
const staleConfirmedState = {
  ...unclearScopeState,
  encounterScopeConfirmation: { sourceFingerprint: "0".repeat(32), confirmedAt: new Date().toISOString() },
};
assert.equal(hasUnconfirmedUnclearEncounterScope(withSafetyGate(staleConfirmedState)), true, "过期指纹确认不得解除门禁");
const stalePrescribe = await prescribeWithStubModel(staleConfirmedState);
assert.ok(stalePrescribe.prompts.some((prompt) => prompt.includes(UNCLEAR_SCOPE_PROMPT)), "过期指纹确认下提示词仍必须带就诊目标待确认");
assert.ok(stalePrescribe.text.includes(UNCLEAR_SCOPE_BANNER_NOTE), "过期指纹确认下横幅仍必须提示就诊目标未确认");

// ─── 剂量收回的端到端交付（红旗剂量轴 / 独立硬边界）────────────────────────────────
// 生成照常进行、候选药味与方义照常交付，但最终页走服务端非剂量投影：置顶横幅写明原因，
// 带 dose_authorization_withheld 机器码，全流不出现任何用量。对照组（无红旗、无硬边界）用
// 同一个桩模型，证明桩的候选确实带剂量——否则「没有剂量」可能只是桩没给。
async function signedDoseAxisState(id, controlPatch) {
  const control = { ...scopeControl, id: `dose-axis-${id}`, mutation: "dose-axis", chiefComplaint: "入睡困难伴多梦2个月，白天疲乏", ...controlPatch };
  const unsigned = buildAuditPositiveControlState(control);
  unsigned.customerId = TEST_CUSTOMER_ID;
  const signed = signDiagnoseReasoning({
    ...unsigned.reasoningPrescribe,
    stage: "diagnose",
    overview: { ...unsigned.reasoningPrescribe.overview, primarySyndromeResolution: "resolved", recommendedFormulaNames: [], formulaSelectionMode: "self_devised" },
    formula: null,
    nonPharma: null,
    clinicalReview: undefined,
  }, buildDiagnoseContractSignatureContext(unsigned));
  const built = buildAuditPositiveControlState(control, signed);
  built.customerId = TEST_CUSTOMER_ID;
  let state = normalizeCaseStateInput(JSON.parse(JSON.stringify(built)));
  if (withSafetyGate(state).safetyGate?.status !== "red_flag") {
    state = await maybeAttachClinicalFactsBackstop(state, async () => JSON.stringify({ redFlags: [] }));
  }
  const canned = `## 中药饮片处方\n\n<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(built.reasoningPrescribe)}\n<!-- DIAGNOSIS_JSON_END -->`;
  return {
    state: normalizeCaseStateInput(JSON.parse(JSON.stringify({ ...state, reasoningPrescribe: undefined, prescription: undefined, prescriptionRevision: undefined, reasoningV2: signed }))),
    canned,
  };
}
const DOSE_AMOUNT = /\b\d+(?:\.\d+)?\s*(?:g|克)\b/i;
const finalSegment = (ndjson) => ndjson.split("\n").filter(Boolean)
  .map((line) => { try { return JSON.parse(line).content || ""; } catch { return ""; } })
  .join("").split("<<<CDSS_STREAM_FINAL>>>").pop();
{
  const doseControl = await signedDoseAxisState("control", {});
  assert.equal(permission(doseControl.state).candidateMode === "non_dose_only", false, "对照组前提：剂量授权未收回");
  const controlFinal = finalSegment((await prescribeWithStubModel(doseControl.state, doseControl.canned)).text);
  assert.match(controlFinal, DOSE_AMOUNT, "对照组：桩模型的候选必须带剂量并被交付，否则下面的「无剂量」断言没有意义");
  assert.doesNotMatch(controlFinal, /CDSS_NON_DOSE_PRESCRIPTION/, "对照组不得走非剂量投影");

  for (const [id, patch, reasonPattern] of [
    ["red-flag", { chiefComplaint: "当前持续压榨性胸痛30分钟未缓解，伴大汗" }, /红旗提示：胸痛/],
    ["pediatric", { patient: { sex: "男", age: 8 } }, /儿童病例当前未配置可验证的个体化剂量规则/],
  ]) {
    const { state, canned } = await signedDoseAxisState(id, patch);
    assert.equal(permission(state).candidateMode, "non_dose_only", `${id}: 前提——剂量授权被收回`);
    const { text, prompts } = await prescribeWithStubModel(state, canned);
    const final = finalSegment(text);
    assert.ok(prompts.length > 0, `${id}: 剂量收回不得在生成前拦截`);
    assert.doesNotMatch(text, DOSE_AMOUNT, `${id}: 整条流（含草稿）不得出现任何用量`);
    assert.match(final, /CDSS_NON_DOSE_PRESCRIPTION/, `${id}: 最终页必须是非剂量投影`);
    assert.match(final, /CDSS_REASON_CODE:dose_authorization_withheld/, `${id}: 必须带剂量授权收回机器码`);
    assert.match(final, /黄芪（君）/, `${id}: 候选药味与君臣照常交付（收回的是剂量，不是候选）`);
    assert.ok(final.startsWith("<!-- CDSS_SAFETY_ADVISORY -->"), `${id}: 最终页必须以确定性安全警示横幅开头`);
    assert.match(final, reasonPattern, `${id}: 横幅必须写明收回剂量的具体原因`);
  }
}

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

// 回归: 单次抽取给出的「仅既往/稳定背景」只作语义上下文。它是**下调型**判断，单模型结论不被采信：
// 病例照常按活动性就诊处理（保守方向），也不得误触 unclear 确认门。此前「抽取与复核两次一致
// （agreed）才下调」的路径依赖复核相位，2026-09-25 随复核/裁决相位一并删除。
const historicalScopeModel = async () => JSON.stringify({
  redFlags: [],
  // 模型在输出里自称「两次一致」：解析层必须丢弃这个自证字段。
  encounterScope: { status: "historical_or_stable_only", quote: "胃溃疡3年前已治愈，目前无不适", reviewAgreement: "agreed" },
});
const singlePassHistoricalState = await maybeAttachClinicalFactsBackstop(
  { ...roundTrippedScopeState, id: `${roundTrippedScopeState.id}-single-pass`, pastHistory: "胃溃疡3年前已治愈，目前无不适" },
  historicalScopeModel,
);
assert.equal(singlePassHistoricalState.clinicalFacts?.reviewStatus, "single_pass");
assert.equal(singlePassHistoricalState.clinicalFacts?.encounterScope?.status, "historical_or_stable_only", "夹具前提：仅既往范围已落地");
assert.equal("reviewAgreement" in (singlePassHistoricalState.clinicalFacts?.encounterScope || {}), false,
  "模型自称的「两次一致」不得进入签名事实");
assert.equal(hasUnconfirmedUnclearEncounterScope(withSafetyGate(singlePassHistoricalState)), false, "single-pass historical 不属于 unclear 确认门");
// 路由级：block 档下旧实现对「仅既往」直接返回非剂量有限 M03（「本次当前活动性治疗目标」待补录）。
// 现在它不得再改变 M03 的任何输出——本夹具无模型密钥，推进到生成层即为越过了全部确定性门禁。
const reparsedHistoricalState = normalizeCaseStateInput(JSON.parse(JSON.stringify(singlePassHistoricalState)));
assert.equal(fingerprintOf(reparsedHistoricalState), singlePassHistoricalState.clinicalFacts.sourceFingerprint,
  "夹具前提：归一化往返后指纹稳定，路由复用已签名事实而不重抽");
const { POST: diagnosePost } = await jiti.import("../src/app/api/diagnosis/diagnose/route.ts");
const historicalDiagnoseText = await (await diagnosePost(routeRequest("/api/diagnosis/diagnose", singlePassHistoricalState))).text();
assert.doesNotMatch(historicalDiagnoseText, /仅含既往|本次当前活动性治疗目标|就诊目标以既往背景为主|以既往、已缓解或稳定背景为主/,
  "「仅既往」不得再让 M03 走有限合同、横幅或提示词下调");
assert.match(historicalDiagnoseText, /模型推理服务暂时不可用|OPENAI_API_KEY not configured/, "M03 应推进到生成层（本夹具无模型密钥）");

const historicalLimitedM03 = signDiagnoseReasoning(
  buildSafetyLimitedDiagnosisReasoning(roundTrippedScopeState, {
    status: "needs_information",
    allowDiagnosis: true,
    allowDosePrescription: false,
    action: "complete_before_prescription",
    missingItems: ["本次当前活动性治疗目标"],
    redFlags: [],
    reasons: ["当前记录未明确本次活动性诊疗目标"],
  }),
  buildDiagnoseContractSignatureContext(roundTrippedScopeState),
);
const historicalLimitedState = { ...roundTrippedScopeState, reasoningDiagnose: historicalLimitedM03, reasoningV2: historicalLimitedM03 };
const historicalPrescribeText = await (await prescribePost(routeRequest("/api/diagnosis/prescribe", historicalLimitedState))).text();
assert.match(historicalPrescribeText, /CDSS_NON_DOSE_PRESCRIPTION/, "签名有限 M03（缺当前治疗目标）必须仍然返回非剂量合同");
assert.match(historicalPrescribeText, /本次当前活动性治疗目标/, "签名有限 M03 的非剂量合同必须保留待补录项");

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

// ─── 处置口径只有「提示不拦截」一种（block 回退档 2026-09-25 删除）─────────────────
// 残留的旧环境变量不得复活拦截行为；以及横幅构造器的确定性输出（不经模型、有稳定标记、必含审方提示）。
{
  const { buildSafetyAdvisoryBanner, SAFETY_ADVISORY_MARKER } =
    await jiti.import("../src/lib/diagnosis-safety.ts");
  // try/finally：jiti 在断言抛错后会重跑整个文件，残留的环境变量会把失败归因到别的断言上。
  const prev = process.env.CDSS_GATE_DISPOSITION;
  process.env.CDSS_GATE_DISPOSITION = "block";
  try {
    assert.equal(permission(sparseBeforeFollowup).candidateMode, "limited_dose", "残留 CDSS_GATE_DISPOSITION=block 不得复活首轮拦截");
  } finally {
    if (prev === undefined) delete process.env.CDSS_GATE_DISPOSITION;
    else process.env.CDSS_GATE_DISPOSITION = prev;
  }
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
