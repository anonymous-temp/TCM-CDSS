import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const ts = require("typescript");
const previousKey = process.env.REASONING_CONTRACT_SIGNING_KEY;
const previousClinicalFactsBackstop = process.env.CDSS_CLINICAL_FACTS_BACKSTOP;
const previousRxAuditEnabled = process.env.RXAI_AUDIT_ENABLED;
const previousTsLoader = Module._extensions[".ts"];
const previousModuleLoad = Module._load;
const previousResolveFilename = Module._resolveFilename;
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEST_CUSTOMER_ID = "test-hospital";

process.env.REASONING_CONTRACT_SIGNING_KEY = "test-only-m03-signature-key-0123456789abcdef";
process.env.CDSS_CLINICAL_FACTS_BACKSTOP = "true";
process.env.RXAI_AUDIT_ENABLED = "false";
Module._load = function loadWithServerOnlyStub(request, parent, isMain) {
  if (request === "server-only") return {};
  return previousModuleLoad.call(this, request, parent, isMain);
};
Module._resolveFilename = function resolveWorkspaceAlias(request, parent, isMain, options) {
  const target = request.startsWith("@/")
    ? resolve(workspaceRoot, "src", request.slice(2))
    : request;
  return previousResolveFilename.call(this, target, parent, isMain, options);
};
Module._extensions[".ts"] = (module, filename) => {
  // This harness compiles application ESM TypeScript to CommonJS so route
  // contracts can be exercised without a running Next server. Preserve the
  // module-relative meaning of import.meta.url before that conversion.
  const source = readFileSync(filename, "utf8")
    .replace(/\bimport\.meta\.url\b/g, JSON.stringify(pathToFileURL(filename).href));
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
      resolveJsonModule: true,
    },
    fileName: filename,
  });
  module._compile(compiled.outputText, filename);
};

let caseCount = 0;
function check(name, run) {
  caseCount += 1;
  try {
    run();
  } catch (error) {
    error.message = `${name}: ${error.message}`;
    throw error;
  }
}

async function checkAsync(name, run) {
  caseCount += 1;
  try {
    await run();
  } catch (error) {
    error.message = `${name}: ${error.message}`;
    throw error;
  }
}

const clone = (value) => JSON.parse(JSON.stringify(value));

try {
  const {
    DIAGNOSE_CONTRACT_SIGNATURE_VERSION,
    PRESCRIBE_CONTRACT_SIGNATURE_VERSION,
    applyDiagnoseContractSignature,
    applyPrescribeContractSignature,
    buildDiagnoseContractSignatureContext,
    buildPrescribeContractSignatureContext,
    clinicalReviewPayloadHash,
    signDiagnoseReasoning,
    signPrescribeReasoning,
    verifyDiagnoseReasoningSignature,
    verifyPrescribeReasoningSignature,
  } = require("../src/lib/reasoning-contract-signature.ts");
  const { normalizeCaseStateInput, normalizeReasoningV2 } = require("../src/lib/diagnosis-types.ts");
  const { sanitizeCaseStateForBrowserPersistence } = require("../src/lib/diagnosis-engine.ts");
  const { withSafetyGate } = require("../src/lib/diagnosis-safety.ts");
  const { maybeAttachClinicalFactsBackstop } = require("../src/lib/clinical-facts-runtime.ts");
  const { hasExecutableSignedM03 } = require("../src/lib/diagnosis-client-guards.ts");
  const { editedPrescriptionSemanticIssue, synchronizeEditedCandidate } = require("../src/lib/prescription-revision.ts");
  const { confirmControlledTerminologyMapping } = require("../src/lib/controlled-terminology-confirmation.server.ts");
  const {
    issueEmergencyClearance,
    stripInvalidEmergencyClearance,
    verifyEmergencyClearance,
  } = require("../src/lib/emergency-clearance.server.ts");
  const { activeEmergencyClearanceFindingsFromGate } = require("../src/lib/emergency-clearance-contract.ts");

  const caseState = normalizeCaseStateInput({
    id: "case_signature_001",
    customerId: TEST_CUSTOMER_ID,
    phase: "diagnose",
    patient: { name: "不进入签名明文", sex: "男", age: 52, occupation: "教师" },
    chiefComplaint: "入睡困难伴心悸三个月",
    symptoms: { sleep: "入睡困难，多梦易醒", appetite: "纳差" },
    tongue: "舌淡，苔薄白",
    pulse: "脉细弱",
    faceNote: "面色少华",
    tongueImageDesc: "舌体偏淡，图像质量可用",
    faceCapture: {
      schemaVersion: "face-capture-v1",
      quality: { score: 0.9, issues: [], needRetake: false },
      complexion: ["少华"],
      spirit: ["疲倦"],
      shape: [],
      notes: "面色少华",
      clinicalEvidenceLevel: "reference-only",
      updatedAt: "2026-07-13T00:00:00.000Z",
    },
    vitals: { bloodPressure: "118/76mmHg", pulse: "78次/分" },
    pastHistory: "无重大慢性病史；未孕，未哺乳，无备孕计划",
    medicationHistory: "否认当前用药",
    allergyHistory: "否认药物过敏",
    tcmLineagePreference: "unrestricted",
    hisRecord: {
      schemaVersion: "tcm-cdss-his-v1",
      source: "tcm-cdss-his",
      caseId: "encounter_signature_001",
      updatedAt: "2026-07-13T00:00:00.000Z",
      tongueImageUploaded: true,
      fields: {
        patientName: "测试患者",
        sex: "男",
        age: "52",
        zhushu: "入睡困难伴心悸三个月",
        tcmTongue: "舌淡，苔薄白",
        tcmPulse: "脉细弱",
        tcmDetail: "否认明显打鼾、目击呼吸暂停及日间嗜睡",
        yongyaoshi: "否认当前用药",
        guomin: "否认药物过敏",
        extraText: "近一周症状无明显加重",
      },
      rawText: "主诉：入睡困难伴心悸三个月；舌淡苔薄白；脉细弱。",
    },
    completeness: { level: "C", redFlag: 0.9, infoGain: 0.8, managementImpact: 0.8, answerability: 0.8 },
    questionRounds: 1,
    maxQuestionRounds: 2,
    conversation: [
      { role: "user", content: "心悸多在劳累后出现，否认晕厥。" },
      { role: "assistant", content: "已记录心悸诱因与晕厥阴性史。" },
    ],
  });
  assert.ok(caseState, "signature fixture must normalize");
  const fixtureGate = withSafetyGate(caseState).safetyGate;
  assert.equal(fixtureGate?.allowDosePrescription, true, `signature route fixture must reach the signature boundary: ${JSON.stringify(fixtureGate)}`);

  const emergencyCase = normalizeCaseStateInput({
    id: "case_emergency_clearance_001",
    phase: "diagnose",
    patient: { name: "测试患者", sex: "女", age: 36 },
    chiefComplaint: "突发人生最剧烈头痛伴恶心呕吐",
    symptoms: { presentHistory: "今日突发人生最剧烈头痛，伴恶心呕吐，既往无类似发作" },
    tongue: "舌边齿痕",
    pulse: "脉来浮而紧",
    pastHistory: "既往无类似发作",
    medicationHistory: "目前无正在使用的中西药",
    allergyHistory: "否认药物及食物过敏",
    hisRecord: {
      schemaVersion: "tcm-cdss-his-v1",
      source: "tcm-cdss-his",
      caseId: "encounter_emergency_clearance_001",
      updatedAt: "2026-07-28T08:00:00.000Z",
      tongueImageUploaded: false,
      fields: {
        patientName: "测试患者",
        sex: "女",
        age: "36岁",
        zhushu: "突发人生最剧烈头痛伴恶心呕吐",
        xianbingshi: "今日突发人生最剧烈头痛，伴恶心呕吐，既往无类似发作",
        tcmTongue: "舌边齿痕",
        tcmPulse: "脉来浮而紧",
        guomin: "否认药物及食物过敏",
        yongyaoshi: "目前无正在使用的中西药",
      },
      rawText: "主诉：突发人生最剧烈头痛伴恶心呕吐；现病史：今日突发人生最剧烈头痛，伴恶心呕吐。",
    },
    conversation: [],
  });
  assert.ok(emergencyCase);
  assert.equal(withSafetyGate(emergencyCase).safetyGate?.status, "red_flag");
  // 逐条处置留痕：清单必须来自当前安全门（与表单、安全门重验同一个投影）。
  const emergencyGate = withSafetyGate(emergencyCase).safetyGate;
  const activeFindings = activeEmergencyClearanceFindingsFromGate(emergencyGate);
  assert.ok(activeFindings.length > 0);
  const validAttestations = activeFindings.map((finding) => ({
    ruleId: finding.ruleId,
    message: finding.message,
    disposition: "excluded_by_objective_workup",
    basis: "已完成头颅CT与神经系统查体，未见蛛网膜下腔出血或局灶体征",
  }));

  // ── 甲方 ⑫⑤ 的复现：内容判据曾经只有 assessmentSummary 的字数 ──────────────
  // 一句「今天天气不错今天天气不错」即可签发 HMAC 凭证、把确定性红旗整条抹掉。
  // 现在三条判据必须同时成立，缺一即不解除（凭证 = 解除约束，方向与系统别处相反）。
  const fillerSummaryOnly = issueEmergencyClearance(
    emergencyCase,
    "今天天气不错今天天气不错今天天气不错",
    undefined,
  );
  assert.equal(fillerSummaryOnly.ok, false, "字数达标但无逐条处置留痕，绝不允许签发排查确认");
  assert.equal(fillerSummaryOnly.ok === false && fillerSummaryOnly.code, "emergency_clearance_attestations_missing");

  const fillerBasis = issueEmergencyClearance(
    emergencyCase,
    "今天天气不错今天天气不错今天天气不错",
    activeFindings.map((finding) => ({
      ruleId: finding.ruleId,
      message: finding.message,
      disposition: "excluded_by_objective_workup",
      basis: "今天天气不错今天天气不错今天天气不错",
    })),
  );
  assert.equal(fillerBasis.ok, false, "客观依据里没有做过的事，不构成解除急诊约束的凭证");
  assert.equal(fillerBasis.ok === false && fillerBasis.code, "emergency_clearance_attestation_basis_not_objective");

  const missingOneFinding = activeFindings.length > 1
    ? issueEmergencyClearance(emergencyCase, "已完成急诊评估", validAttestations.slice(1))
    : undefined;
  if (missingOneFinding) {
    assert.equal(missingOneFinding.ok, false, "漏处置任何一条红旗都不受理");
  }

  const fabricatedFinding = issueEmergencyClearance(
    emergencyCase,
    "已完成急诊影像及神经系统评估，排除急性神经血管事件",
    validAttestations.map((item) => ({ ...item, message: `${item.message}（伪造）` })),
  );
  assert.equal(fabricatedFinding.ok, false, "处置记录对不上当前红旗即不受理");

  const issuedClearance = issueEmergencyClearance(
    emergencyCase,
    "测试患者已经急诊影像及神经系统评估，排除急性神经血管事件",
    validAttestations,
  );
  assert.equal(issuedClearance.ok, true);
  if (!issuedClearance.ok) throw new Error(issuedClearance.error);
  assert.doesNotMatch(issuedClearance.clearance.assessmentSummary, /测试患者/);
  assert.equal(verifyEmergencyClearance({ ...emergencyCase, emergencyClearance: issuedClearance.clearance }), true);
  const normalizedEmergencyCase = normalizeCaseStateInput({
    ...emergencyCase,
    emergencyClearance: issuedClearance.clearance,
  });
  assert.ok(normalizedEmergencyCase?.emergencyClearance);
  assert.equal(verifyEmergencyClearance(normalizedEmergencyCase), true);
  const persistedEmergencyCase = sanitizeCaseStateForBrowserPersistence(normalizedEmergencyCase);
  assert.equal(verifyEmergencyClearance(persistedEmergencyCase), true);
  assert.notEqual(
    withSafetyGate({ ...emergencyCase, emergencyClearance: issuedClearance.clearance }).safetyGate?.status,
    "red_flag",
  );
  const tamperedClearanceCase = {
    ...emergencyCase,
    emergencyClearance: {
      ...issuedClearance.clearance,
      assessmentSummary: `${issuedClearance.clearance.assessmentSummary}（伪改）`,
    },
  };
  assert.equal(verifyEmergencyClearance(tamperedClearanceCase), false);
  assert.equal(stripInvalidEmergencyClearance(tamperedClearanceCase).emergencyClearance, undefined);
  assert.equal(withSafetyGate(stripInvalidEmergencyClearance(tamperedClearanceCase)).safetyGate?.status, "red_flag");
  caseCount += 12;

  const reasoning = normalizeReasoningV2({
    schemaVersion: "tcm-cdss-reasoning-v2",
    stage: "diagnose",
    completeness: { level: "C", redFlag: 0.9, infoGain: 0.8, managementImpact: 0.8, answerability: 0.8 },
    westernDiagnosis: {
      primary: {
        name: "慢性失眠障碍倾向",
        status: "考虑",
        confidence: "中",
        supportingFacts: ["入睡困难伴心悸三个月"],
        limitations: ["尚需结合日间功能受损情况复核"],
        suggestedChecks: ["必要时完善血常规与心电图"],
        evidence: { evidenceLevel: "model_inference", source: "基于本例已提供病史与四诊信息", confidence: "中" },
      },
      differentials: [],
    },
    overview: {
      primarySyndrome: "心脾两虚证",
      overallPathogenesis: "心脾两虚，气血不足，心神失养",
      overallTherapy: "补益心脾，养血安神",
      recommendedFormulaDirection: "归脾汤加减",
      recommendedFormulaNames: ["归脾汤"],
      formulaSelectionMode: "single",
      evidence: { evidenceLevel: "model_inference", source: "基于本例四诊与病史推断", confidence: "中" },
    },
    pathogenesis: {
      summary: "思虑劳倦损伤心脾，气血生化不足，心神失养。",
      locationDifferentiation: {
        items: ["心", "脾"],
        evidence: { evidenceLevel: "model_inference", source: "本例四诊", confidence: "中" },
      },
      natureDifferentiation: {
        items: ["气血两虚"],
        evidence: { evidenceLevel: "model_inference", source: "本例四诊", confidence: "中" },
      },
      chain: [{
        nodeId: "P1",
        patientFact: "入睡困难伴心悸三个月",
        syndromeEvidence: "入睡困难、心悸、纳差、舌淡脉细弱",
        pathogenesis: "心脾两虚，气血不足",
        therapyDirection: "补益心脾，养血安神",
        pathogenesisType: "始动",
        biaoBen: "本",
        evidence: { evidenceLevel: "model_inference", source: "本例资料", confidence: "中" },
      }],
      uncertainties: [{ item: "血常规", reason: "尚未提供", affects: "贫血鉴别" }],
    },
    therapy: {
      overallPrinciple: "补益心脾，养血安神",
      subTherapies: [{
        therapy: "益气养血",
        targetPathogenesis: "气血生化不足",
        priority: "主要",
        evidence: { evidenceLevel: "model_inference", source: "本例资料", confidence: "中" },
      }],
    },
    formula: null,
    nonPharma: {
      diet: "少量多餐，避免辛辣油腻；可用山药小米粥作为早餐，每周3次。",
      lifestyle: "固定作息",
      emotion: "减少过度思虑",
      acupointCare: "内关、神门按揉",
      monitoring: [{ metric: "睡眠时长", timing: "每日", trigger: "连续三日恶化时复诊" }],
    },
    lineageAdaptation: {
      schemaVersion: "tcm-cdss-reasoning-v2",
      lineageCode: "unrestricted",
      label: "不限定",
      applicable: "partial",
      applicabilityReason: "按本例证据辨治",
      influencedDecisions: [{ aspect: "辨证视角", detail: "以心脾气血为核心复核" }],
      unaffectedBySafety: ["红旗排查", "剂量安全"],
      safetyDeference: "安全规则优先",
    },
    management: {
      redFlagLoop: "若心悸伴晕厥或胸痛立即就医",
      mustCollect: ["血常规", "心电图"],
      followupSafetyNet: "一周复诊评估睡眠与心悸变化",
    },
  });
  assert.ok(reasoning, "reasoning fixture must normalize");

  const context = buildDiagnoseContractSignatureContext(caseState);
  const signed = signDiagnoseReasoning(reasoning, context);

  check("valid normalized M03 verifies", () => {
    assert.equal(signed.contractSignatureVersion, DIAGNOSE_CONTRACT_SIGNATURE_VERSION);
    assert.equal(verifyDiagnoseReasoningSignature(signed, caseState), true);
    assert.equal(verifyDiagnoseReasoningSignature(normalizeReasoningV2(clone(signed)), clone(caseState)), true);
  });

  check("independent clinical-review attestation is signed and tamper evident", () => {
    const reviewedReasoning = clone(reasoning);
    reviewedReasoning.clinicalReview = {
      status: "accepted",
      provider: "review-provider",
      model: "independent-review-model",
      source: "preferred",
      reviewedPayloadHash: `sha256:${"a".repeat(64)}`,
    };
    const reviewedSigned = signDiagnoseReasoning(reviewedReasoning, context);
    assert.equal(reviewedSigned.clinicalReview.reviewedPayloadHash, clinicalReviewPayloadHash(reviewedSigned));
    assert.notEqual(reviewedSigned.clinicalReview.reviewedPayloadHash, reviewedReasoning.clinicalReview.reviewedPayloadHash);
    assert.equal(verifyDiagnoseReasoningSignature(reviewedSigned, caseState), true);
    for (const mutate of [
      (value) => { value.clinicalReview.status = "unavailable"; },
      (value) => { value.clinicalReview.model = "tampered-review-model"; },
      (value) => { value.clinicalReview.reviewedPayloadHash = `sha256:${"b".repeat(64)}`; },
    ]) {
      const tampered = clone(reviewedSigned);
      mutate(tampered);
      assert.equal(verifyDiagnoseReasoningSignature(tampered, caseState), false);
    }
  });

  check("signature integrity remains distinct from clinical sufficiency", () => {
    const ungrounded = clone(reasoning);
    ungrounded.pathogenesis.chain = [];
    const signedUngrounded = signDiagnoseReasoning(ungrounded, context);
    assert.equal(verifyDiagnoseReasoningSignature(signedUngrounded, caseState), true, "HMAC verifies integrity, not clinical sufficiency");
    assert.equal(hasExecutableSignedM03(signedUngrounded), true, "the browser recognizes only the envelope; the server remains authoritative");
  });

  for (const [name, mutate] of [
    ["management.redFlagLoop", (value) => { value.management.redFlagLoop = "被修改的管理闭环"; }],
    ["completeness.answerability", (value) => { value.completeness.answerability = 0.2; }],
    ["overview.evidence.source", (value) => { value.overview.evidence.source = "被替换的证据来源"; }],
    ["pathogenesis.uncertainties", (value) => { value.pathogenesis.uncertainties[0].affects = "被修改的影响范围"; }],
    // monitoring(metric/timing/trigger) 三元组已被自由文本 precautions 取代。签名覆盖的是整个
    // normalize 后对象而不是字段白名单，所以新字段自动进入签名载荷——这条断言正是用来证明
    // 「换了字段之后新字段依然被签名保护」，不能因为旧字段没了就删掉。
    ["nonPharma.precautions", (value) => { value.nonPharma.precautions[0] = "被篡改的注意事项"; }],
  ]) {
    check(`previously unsigned field rejects: ${name}`, () => {
      const tampered = clone(signed);
      mutate(tampered);
      assert.equal(verifyDiagnoseReasoningSignature(tampered, caseState), false);
    });
  }

  check("core M03 mutation rejects", () => {
    const tampered = clone(signed);
    tampered.overview.primarySyndrome = "痰热扰心证";
    assert.equal(verifyDiagnoseReasoningSignature(tampered, caseState), false);
  });

  const semanticSuggestedReasoning = clone(reasoning);
  semanticSuggestedReasoning.overview.primarySyndrome = "心脾劳虚";
  semanticSuggestedReasoning.overview.recommendedFormulaDirection = "归脾汤加减";
  semanticSuggestedReasoning.overview.recommendedFormulaNames = [];
  semanticSuggestedReasoning.overview.formulaSelectionMode = "self_devised";
  semanticSuggestedReasoning.overview.deferredFormulaSelection = {
    direction: "归脾汤加减",
    names: ["归脾汤"],
    mode: "single",
    reason: "semantic_mapping_pending_clinician_confirmation",
  };
  semanticSuggestedReasoning.terminologyMappings = [{
    namespace: "tcm_syndrome",
    fieldPath: "overview.primarySyndrome",
    originalText: "心脾劳虚",
    candidateId: "heart_spleen_deficiency",
    canonical: "心脾两虚",
    resolvedBy: "deepseek_closed_set",
    status: "suggested",
    confidence: 0.91,
    model: "deepseek-v4-flash",
    consensus: true,
    cache: "miss",
  }];
  const semanticSuggestedSigned = signDiagnoseReasoning(semanticSuggestedReasoning, context);

  check("semantic mapping trace is covered by the M03 signature", () => {
    const tampered = clone(semanticSuggestedSigned);
    tampered.terminologyMappings[0].candidateId = "tampered_candidate";
    assert.equal(verifyDiagnoseReasoningSignature(tampered, caseState), false);
  });

  check("clinician confirmation replaces the primary syndrome and restores only the signed deferred formula", () => {
    const result = confirmControlledTerminologyMapping(
      { ...caseState, reasoningDiagnose: semanticSuggestedSigned, reasoningV2: semanticSuggestedSigned },
      {
        namespace: "tcm_syndrome",
        fieldPath: "overview.primarySyndrome",
        candidateId: "heart_spleen_deficiency",
      },
    );
    assert.equal(result.ok, true);
    assert.equal(result.reasoning.overview.primarySyndrome, "心脾两虚");
    assert.equal(result.reasoning.terminologyMappings[0].status, "clinician_confirmed");
    assert.deepEqual(result.restoredFormulaNames, ["归脾汤"]);
    assert.deepEqual(result.reasoning.overview.recommendedFormulaNames, ["归脾汤"]);
    assert.equal(result.reasoning.overview.deferredFormulaSelection, undefined);
    assert.equal(result.reasoning.clinicalReview.status, "unavailable");
    assert.equal(
      verifyDiagnoseReasoningSignature(
        result.reasoning,
        { ...caseState, reasoningDiagnose: semanticSuggestedSigned, reasoningV2: semanticSuggestedSigned },
      ),
      true,
    );
  });

  check("confirmation rejects a selector absent from the signed suggestion set", () => {
    const result = confirmControlledTerminologyMapping(
      { ...caseState, reasoningDiagnose: semanticSuggestedSigned, reasoningV2: semanticSuggestedSigned },
      {
        namespace: "tcm_syndrome",
        fieldPath: "overview.primarySyndrome",
        candidateId: "invented_candidate",
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, "terminology_suggestion_not_current");
  });

  check("cross-case replay rejects", () => {
    assert.equal(verifyDiagnoseReasoningSignature(signed, { ...caseState, id: "case_signature_002" }), false);
  });

  check("cross-encounter replay rejects", () => {
    const replayed = clone(caseState);
    replayed.hisRecord.caseId = "encounter_signature_002";
    assert.equal(verifyDiagnoseReasoningSignature(signed, replayed), false);
  });

  check("clinical snapshot mutation rejects", () => {
    const changed = clone(caseState);
    changed.hisRecord.fields.zhushu = "入睡困难伴新发胸痛";
    assert.equal(verifyDiagnoseReasoningSignature(signed, changed), false);
  });

  check("non-authoritative chief alias does not invalidate HIS-bound signature", () => {
    const changed = clone(caseState);
    changed.chiefComplaint = "被 HIS 主诉覆盖的旧别名";
    assert.equal(verifyDiagnoseReasoningSignature(signed, changed), true);
  });

  check("conversation mutation rejects", () => {
    const changed = clone(caseState);
    changed.conversation.push({ role: "user", content: "新增：昨夜出现晕厥。" });
    assert.equal(verifyDiagnoseReasoningSignature(signed, changed), false);
  });

  check("workflow outputs and timestamps do not invalidate clinical binding", () => {
    const workflowOnly = clone(caseState);
    workflowOnly.phase = "prescribe";
    workflowOnly.diagnosis = "客户正文";
    workflowOnly.prescription = "候选处方正文";
    workflowOnly.riskAssessment = "审方正文";
    workflowOnly.hisRecord.updatedAt = "2030-01-01T00:00:00.000Z";
    workflowOnly.faceCapture.updatedAt = "2030-01-01T00:00:00.000Z";
    workflowOnly.completeness = { level: "B", redFlag: 0.2, infoGain: 0.3, managementImpact: 0.4, answerability: 0.5 };
    workflowOnly.questionRounds = 9;
    workflowOnly.maxQuestionRounds = 9;
    workflowOnly.skipDifferentiationGate = true;
    workflowOnly.conversation.push({ role: "assistant", content: "重试时重新生成的追问文案" });
    assert.equal(verifyDiagnoseReasoningSignature(signed, workflowOnly), true);
  });

  check("legacy snapshot without signature version rejects", () => {
    const legacy = clone(signed);
    delete legacy.contractSignatureVersion;
    assert.equal(verifyDiagnoseReasoningSignature(legacy, caseState), false);
  });

  check("malformed signature rejects without throwing", () => {
    const malformed = { ...signed, contractSignature: "hmac-sha256:not-a-valid-signature" };
    assert.equal(verifyDiagnoseReasoningSignature(malformed, caseState), false);
  });

  check("final diagnosis content is signed with supplied context", () => {
    const content = [
      "## 辨证结论",
      "候选结论正文。",
      "<!-- DIAGNOSIS_JSON_START -->",
      JSON.stringify(reasoning),
      "<!-- DIAGNOSIS_JSON_END -->",
    ].join("\n");
    const signedContent = applyDiagnoseContractSignature(content, context);
    const signedJson = JSON.parse(signedContent.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
    assert.equal(verifyDiagnoseReasoningSignature(signedJson, caseState), true);
  });

  check("content signing preserves the attached independent-review attestation", () => {
    const reviewedReasoning = clone(reasoning);
    reviewedReasoning.clinicalReview = {
      status: "accepted",
      provider: "review-provider",
      model: "independent-review-model",
      source: "cross_model_fallback",
      reviewedPayloadHash: `sha256:${"c".repeat(64)}`,
    };
    const content = [
      "## 辨证结论",
      "候选结论正文。",
      "<!-- DIAGNOSIS_JSON_START -->",
      JSON.stringify(reviewedReasoning),
      "<!-- DIAGNOSIS_JSON_END -->",
    ].join("\n");
    const signedContent = applyDiagnoseContractSignature(content, context);
    const signedJson = JSON.parse(signedContent.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
    assert.equal(signedJson.clinicalReview.status, reviewedReasoning.clinicalReview.status);
    assert.equal(signedJson.clinicalReview.provider, reviewedReasoning.clinicalReview.provider);
    assert.equal(signedJson.clinicalReview.model, reviewedReasoning.clinicalReview.model);
    assert.equal(signedJson.clinicalReview.source, reviewedReasoning.clinicalReview.source);
    assert.equal(signedJson.clinicalReview.reviewedPayloadHash, clinicalReviewPayloadHash(signedJson));
    assert.notEqual(signedJson.clinicalReview.reviewedPayloadHash, reviewedReasoning.clinicalReview.reviewedPayloadHash);
    assert.equal(verifyDiagnoseReasoningSignature(signedJson, caseState), true);
  });

  const prescribeCase = { ...caseState, phase: "prescribe", reasoningDiagnose: signed };
  const prescribeReasoning = normalizeReasoningV2({
    ...clone(reasoning),
    stage: "prescribe",
    formula: {
      candidates: [{
        name: "归脾汤加减候选",
        formulaNames: ["归脾汤"],
        positioning: "首选",
        constructionType: "single_base",
        modificationStatus: "modified",
        formulaSource: { evidenceLevel: "classic", source: "《济生方》归脾汤", confidence: "高" },
        therapyMatch: "补益心脾，养血安神",
        applicable: "用于本例心脾两虚、心神失养候选思路",
        notApplicable: "出现急症线索或与现场四诊不符时不采纳",
        herbs: [{
          name: "酸枣仁",
          processing: "炒",
          dose: "15g",
          role: "君",
          prescriptionRole: "养心安神",
          targetKind: "pathogenesis_node",
          targetRef: "P1",
          targetPathogenesis: "心神失养",
          function: "养心益肝，安神",
          isToxic: false,
          decoctionRequirement: "捣碎后同煎",
          evidence: { evidenceLevel: "model_inference", source: "基于本例病机与经典方义", confidence: "中" },
        }],
        formulaAnalysis: "以养心安神药味对应心神失养病机，具体剂量由医生复核。",
        decoction: {
          doseCount: "5剂",
          method: "每日1剂，煎煮2次，合并药液后早晚分服",
          course: "5日",
          followUpNode: "完成5剂后复诊",
          dosesPerDay: 1,
          administrationTimesPerDay: 2,
        },
      }],
      patentAndWestern: [],
      modifications: [],
    },
  });
  assert.ok(prescribeReasoning, "prescribe fixture must normalize");
  const prescribeContext = buildPrescribeContractSignatureContext(prescribeCase);
  const signedPrescribe = signPrescribeReasoning(prescribeReasoning, prescribeContext);

  check("valid normalized M04 verifies against the current case and signed M03", () => {
    assert.equal(signedPrescribe.contractSignatureVersion, PRESCRIBE_CONTRACT_SIGNATURE_VERSION);
    assert.equal(signedPrescribe.clinicalReview.status, "unavailable");
    assert.equal(signedPrescribe.clinicalReview.reviewedPayloadHash, clinicalReviewPayloadHash(signedPrescribe));
    assert.equal(verifyPrescribeReasoningSignature(signedPrescribe, prescribeCase), true);
  });

  for (const [name, mutate] of [
    ["herb dose", (value) => { value.formula.candidates[0].herbs[0].dose = "30g"; }],
    ["clinical-review status", (value) => { value.clinicalReview.status = "accepted"; }],
    ["clinical-review payload hash", (value) => { value.clinicalReview.reviewedPayloadHash = `sha256:${"d".repeat(64)}`; }],
  ]) {
    check(`M04 payload tampering rejects: ${name}`, () => {
      const tampered = clone(signedPrescribe);
      mutate(tampered);
      assert.equal(verifyPrescribeReasoningSignature(tampered, prescribeCase), false);
    });
  }

  // SCOPE-01 受理裁决范围(2026-08-03 根源工程): scope 在签名域内——
  // 归一化保留字段、签名后验证通过、任何篡改(增删码/整体注入)即验签失败。
  check("acceptanceScope 随签名下发且归一化保留", () => {
    const withScope = clone(prescribeReasoning);
    withScope.clinicalReview = {
      status: "accepted", provider: "DeepSeek", model: "deepseek-v4-flash", source: "preferred",
      acceptanceScope: {
        waivedIssueCodes: ["transparent_therapy_coverage"],
        qualityAnnotationCodes: ["transparent_therapy_coverage", "herb_plan_mismatch"],
      },
    };
    const normalized = normalizeReasoningV2(withScope);
    assert.deepEqual(
      normalized.clinicalReview.acceptanceScope,
      withScope.clinicalReview.acceptanceScope,
      "normalizeReasoningV2 必须保留 acceptanceScope",
    );
    const signedWithScope = signPrescribeReasoning(normalized, prescribeContext);
    assert.equal(verifyPrescribeReasoningSignature(signedWithScope, prescribeCase), true);
    const tamperedScope = clone(signedWithScope);
    tamperedScope.clinicalReview.acceptanceScope.waivedIssueCodes.push("dose_out_of_range");
    assert.equal(
      verifyPrescribeReasoningSignature(tamperedScope, prescribeCase), false,
      "往 waived 里塞码必须破坏签名",
    );
    const injectedScope = clone(signedPrescribe);
    injectedScope.clinicalReview.acceptanceScope = { waivedIssueCodes: ["x"], qualityAnnotationCodes: [] };
    assert.equal(
      verifyPrescribeReasoningSignature(injectedScope, prescribeCase), false,
      "对未带 scope 的签名载荷注入 scope 必须破坏签名",
    );
  });

  check("M04 cross-case replay rejects", () => {
    assert.equal(verifyPrescribeReasoningSignature(signedPrescribe, { ...prescribeCase, id: "case_signature_m04_replay" }), false);
  });

  check("M04 cross-encounter replay rejects", () => {
    const replayed = clone(prescribeCase);
    replayed.hisRecord.caseId = "encounter_signature_m04_replay";
    assert.equal(verifyPrescribeReasoningSignature(signedPrescribe, replayed), false);
  });

  check("M04 rejects replacement with a different valid M03 conclusion", () => {
    const alternateM03 = clone(reasoning);
    alternateM03.overview.primarySyndrome = "肝郁血虚证";
    alternateM03.overview.overallPathogenesis = "肝郁血虚，心神失养";
    const alternateSignedM03 = signDiagnoseReasoning(alternateM03, context);
    assert.equal(verifyDiagnoseReasoningSignature(alternateSignedM03, caseState), true);
    assert.equal(verifyPrescribeReasoningSignature(signedPrescribe, {
      ...prescribeCase,
      reasoningDiagnose: alternateSignedM03,
    }), false);
  });

  check("final prescription content is signed with supplied M03-bound context", () => {
    const content = [
      "## 候选方药",
      "结构化候选正文。",
      "<!-- DIAGNOSIS_JSON_START -->",
      JSON.stringify(prescribeReasoning),
      "<!-- DIAGNOSIS_JSON_END -->",
    ].join("\n");
    const signedContent = applyPrescribeContractSignature(content, prescribeContext);
    const signedJson = JSON.parse(signedContent.split("<!-- DIAGNOSIS_JSON_START -->")[1].split("<!-- DIAGNOSIS_JSON_END -->")[0]);
    assert.equal(verifyPrescribeReasoningSignature(signedJson, prescribeCase), true);
  });

  check("clinical hash is deterministic after request normalization round trip", () => {
    assert.deepEqual(
      buildDiagnoseContractSignatureContext(caseState),
      buildDiagnoseContractSignatureContext(normalizeCaseStateInput(clone(caseState))),
    );
  });

  check("browser name redaction preserves signature when clinical facts are unchanged", () => {
    const namedCase = clone(caseState);
    namedCase.hisRecord.fields.patientName = "王小明";
    namedCase.chiefComplaint = "王小明自述入睡困难伴心悸三个月";
    namedCase.symptoms.note = "患者王小明近日多梦易醒";
    namedCase.conversation.push({ role: "user", content: "王小明表示劳累后心悸，否认晕厥。" });
    namedCase.hisRecord.rawText = "患者：王小明，主诉入睡困难伴心悸三个月。";
    const namedSigned = signDiagnoseReasoning(reasoning, buildDiagnoseContractSignatureContext(namedCase));
    const persisted = sanitizeCaseStateForBrowserPersistence(namedCase);
    assert.equal(persisted.hisRecord.fields.patientName, undefined);
    assert.match(persisted.chiefComplaint, /姓名已脱敏/);
    const directlyPersistedTwice = sanitizeCaseStateForBrowserPersistence(persisted);
    assert.equal(directlyPersistedTwice.patient.occupation, "教育工作");
    assert.match(directlyPersistedTwice.chiefComplaint, /姓名已脱敏/);
    const persistedTwice = sanitizeCaseStateForBrowserPersistence(normalizeCaseStateInput(persisted));
    assert.equal(persistedTwice.patient.occupation, "教育工作");
    assert.deepEqual(
      buildDiagnoseContractSignatureContext(namedCase),
      buildDiagnoseContractSignatureContext(normalizeCaseStateInput(persisted)),
      "PHI redaction must be idempotent for the signed clinical-input context",
    );
    assert.equal(verifyDiagnoseReasoningSignature(namedSigned, normalizeCaseStateInput(persisted)), true);
  });

  check("clinical mutation still rejects after browser name redaction", () => {
    const namedCase = clone(caseState);
    namedCase.hisRecord.fields.patientName = "王小明";
    namedCase.chiefComplaint = "王小明自述入睡困难伴心悸三个月";
    const namedSigned = signDiagnoseReasoning(reasoning, buildDiagnoseContractSignatureContext(namedCase));
    const persisted = sanitizeCaseStateForBrowserPersistence(namedCase);
    persisted.hisRecord.fields.zhushu = `${persisted.hisRecord.fields.zhushu}，新增胸痛`;
    assert.equal(verifyDiagnoseReasoningSignature(namedSigned, normalizeCaseStateInput(persisted)), false);
  });

  // Route probes use a locally generated, HMAC-attested empty semantic result. This reaches the
  // signature/grounding branch without an external model call and without weakening the production
  // trust boundary by disabling the semantic layer.
  const routeBaseCase = await maybeAttachClinicalFactsBackstop(
    caseState,
    async () => JSON.stringify({ redFlags: [] }),
  );
  assert.equal(routeBaseCase.clinicalFacts?.semanticStatus, "checked");
  assert.equal(routeBaseCase.clinicalFacts?.resultSource, "fresh");
  assert.match(routeBaseCase.clinicalFacts?.attestation || "", /^hmac-sha256:[a-f0-9]{64}$/);
  const { POST: prescribePost } = require("../src/app/api/diagnosis/prescribe/route.ts");
  const { POST: postPrescriptionRisk } = require("../src/app/api/diagnosis/post-prescription-risk/route.ts");
  const { POST: assessPost } = require("../src/app/api/diagnosis/assess/route.ts");
  const routeRequest = (path, routeCaseState) => new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-cdss-customer-id": TEST_CUSTOMER_ID },
    body: JSON.stringify({ caseState: routeCaseState }),
  });

  await checkAsync("prescribe route rejects a correctly signed but clinically ungrounded M03", async () => {
    const ungrounded = clone(reasoning);
    ungrounded.pathogenesis.chain = [];
    const routeCase = clone(routeBaseCase);
    routeCase.reasoningDiagnose = signDiagnoseReasoning(ungrounded, context);
    const response = await prescribePost(routeRequest("/api/diagnosis/prescribe", routeCase));
    assert.equal(response.status, 200);
    assert.match(await response.text(), /缺少有效的西医诊断、中医证候与病例依据结果/);
  });

  await checkAsync("prescribe route keeps a current emergency non-dose even with a valid M03 signature", async () => {
    // 本检查验证的是 block 档(运维回退)的红旗非剂量机制。默认 advise 档下红旗照常
    // 完整生成(置顶警示横幅), 在单测环境会推进到模型调用——那是另一条契约的正确行为。
    process.env.CDSS_GATE_DISPOSITION = "block";
    const emergencyBase = clone(caseState);
    emergencyBase.id = "case_signature_route_emergency";
    emergencyBase.chiefComplaint = "当前持续压榨性胸痛30分钟未缓解，伴大汗";
    emergencyBase.hisRecord.caseId = emergencyBase.id;
    emergencyBase.hisRecord.fields.zhushu = emergencyBase.chiefComplaint;
    emergencyBase.hisRecord.rawText = `主诉：${emergencyBase.chiefComplaint}`;
    const emergencyWithFacts = await maybeAttachClinicalFactsBackstop(
      emergencyBase,
      async () => JSON.stringify({ redFlags: [] }),
    );
    emergencyWithFacts.reasoningDiagnose = signDiagnoseReasoning(
      reasoning,
      buildDiagnoseContractSignatureContext(emergencyWithFacts),
    );
    const response = await prescribePost(routeRequest("/api/diagnosis/prescribe", emergencyWithFacts));
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(body, /不生成具体剂量|急诊|红旗/);
    assert.doesNotMatch(body, /\|\s*药味\s*\|\s*剂量|\b\d+(?:\.\d+)?\s*(?:g|克)\b/i);
    assert.doesNotMatch(body, /<!-- DIAGNOSIS_JSON_START -->/);
    delete process.env.CDSS_GATE_DISPOSITION;
  });

  for (const [name, mutate] of [
    ["prescribe route rejects cross-case replay", (value) => { value.id = "case_signature_route_replay"; }],
    ["prescribe route rejects complete M03 field tampering", (value) => { value.reasoningDiagnose.management.redFlagLoop = "被修改的闭环"; }],
    ["prescribe route rejects legacy signature snapshot", (value) => { delete value.reasoningDiagnose.contractSignatureVersion; }],
  ]) {
    await checkAsync(name, async () => {
      const routeCase = clone(routeBaseCase);
      routeCase.reasoningDiagnose = clone(signed);
      mutate(routeCase);
      const response = await prescribePost(routeRequest("/api/diagnosis/prescribe", routeCase));
      assert.equal(response.status, 409);
      assert.match((await response.json()).error, /重新生成辨病辨证/);
    });
  }

  const signatureProtectedRoutes = [
    { name: "post-risk", path: "/api/diagnosis/post-prescription-risk", post: postPrescriptionRisk },
    { name: "assess", path: "/api/diagnosis/assess", post: assessPost },
  ];
  const buildSignedNormalRouteCase = () => {
    const routeCase = clone(routeBaseCase);
    routeCase.phase = "assess";
    routeCase.reasoningDiagnose = clone(signed);
    routeCase.reasoningPrescribe = clone(signedPrescribe);
    routeCase.reasoningV2 = clone(signedPrescribe);
    return routeCase;
  };

  for (const route of signatureProtectedRoutes) {
    await checkAsync(`${route.name} route rejects unsigned normal M04`, async () => {
      const routeCase = buildSignedNormalRouteCase();
      delete routeCase.reasoningPrescribe.contractSignature;
      delete routeCase.reasoningPrescribe.contractSignatureVersion;
      routeCase.reasoningV2 = clone(routeCase.reasoningPrescribe);
      const response = await route.post(routeRequest(route.path, routeCase));
      const body = await response.json();
      assert.equal(response.status, 409);
      assert.equal(body.code, "invalid_m04_signature");
      assert.match(body.error, /有效签名|重新生成候选方药/);
    });

    await checkAsync(`${route.name} route rejects tampered normal M04`, async () => {
      const routeCase = buildSignedNormalRouteCase();
      routeCase.reasoningPrescribe.formula.candidates[0].herbs[0].dose = "30g";
      routeCase.reasoningV2 = clone(routeCase.reasoningPrescribe);
      const response = await route.post(routeRequest(route.path, routeCase));
      const body = await response.json();
      assert.equal(response.status, 409);
      assert.equal(body.code, "invalid_m04_signature");
      assert.match(body.error, /内容已变更|重新生成候选方药/);
    });

    await checkAsync(`${route.name} route accepts valid signed normal M04`, async () => {
      const routeCase = buildSignedNormalRouteCase();
      assert.equal(verifyPrescribeReasoningSignature(routeCase.reasoningPrescribe, routeCase), true);
      const response = await route.post(routeRequest(route.path, routeCase));
      assert.equal(response.status, 200);
    });
  }

  const buildLegalWorkbenchRouteCase = () => {
    const routeCase = buildSignedNormalRouteCase();
    const originalCandidate = routeCase.reasoningPrescribe.formula.candidates[0];
    const editedHerbs = clone(originalCandidate.herbs);
    editedHerbs[0].dose = "12g";
    editedHerbs[0].targetPathogenesis = routeCase.reasoningDiagnose.pathogenesis.chain[0].pathogenesis;
    editedHerbs[0].prescriptionRole = `对应${editedHerbs[0].targetPathogenesis}`;
    const editedCandidate = synchronizeEditedCandidate(originalCandidate, editedHerbs);
    routeCase.reasoningPrescribe = {
      ...routeCase.reasoningPrescribe,
      formula: {
        ...routeCase.reasoningPrescribe.formula,
        candidates: [editedCandidate],
      },
    };
    routeCase.reasoningV2 = clone(routeCase.reasoningPrescribe);
    routeCase.prescriptionRevision = {
      source: "herb_workbench",
      candidateIndex: 0,
      herbHash: "test-legal-workbench-edit",
      auditedAt: "2026-07-13T00:00:00.000Z",
      auditResult: "PASS",
      highestRiskLevel: "INFO",
    };
    return routeCase;
  };

  for (const route of signatureProtectedRoutes) {
    await checkAsync(`${route.name} route accepts a legal workbench edit with stale M04 signature`, async () => {
      const routeCase = buildLegalWorkbenchRouteCase();
      assert.equal(verifyDiagnoseReasoningSignature(routeCase.reasoningDiagnose, routeCase), true);
      assert.equal(verifyPrescribeReasoningSignature(routeCase.reasoningPrescribe, routeCase), false);
      assert.equal(editedPrescriptionSemanticIssue(routeCase.reasoningPrescribe, 0, routeCase.reasoningDiagnose), undefined);
      const response = await route.post(routeRequest(route.path, routeCase));
      assert.equal(response.status, 200);
    });

    await checkAsync(`${route.name} route returns 422 for an invalid workbench semantic edit`, async () => {
      const routeCase = buildLegalWorkbenchRouteCase();
      routeCase.reasoningPrescribe.formula.candidates[0].herbs.push(
        clone(routeCase.reasoningPrescribe.formula.candidates[0].herbs[0]),
      );
      routeCase.reasoningV2 = clone(routeCase.reasoningPrescribe);
      const response = await route.post(routeRequest(route.path, routeCase));
      const body = await response.json();
      assert.equal(response.status, 422);
      assert.equal(body.code, "invalid_edited_prescription_duplicate_herb");
      assert.match(body.error, /重复药味/);
    });
  }

  await checkAsync("post-risk route rejects workbench cross-encounter replay", async () => {
    const routeCase = clone(routeBaseCase);
    routeCase.reasoningDiagnose = clone(signed);
    routeCase.hisRecord.caseId = "encounter_signature_route_replay";
    routeCase.prescriptionRevision = {
      source: "herb_workbench",
      candidateIndex: 0,
      herbHash: "route-replay-probe",
      auditedAt: "2026-07-13T00:00:00.000Z",
      auditResult: "PASS",
      highestRiskLevel: "INFO",
    };
    const response = await postPrescriptionRisk(routeRequest("/api/diagnosis/post-prescription-risk", routeCase));
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.code, "invalid_m03_signature");
    assert.match(body.error, /重新生成辨证/);
  });

  console.log(`reasoning contract signature: ${caseCount} cases, 0 failures`);
} finally {
  Module._extensions[".ts"] = previousTsLoader;
  Module._load = previousModuleLoad;
  Module._resolveFilename = previousResolveFilename;
  if (previousKey === undefined) delete process.env.REASONING_CONTRACT_SIGNING_KEY;
  else process.env.REASONING_CONTRACT_SIGNING_KEY = previousKey;
  if (previousClinicalFactsBackstop === undefined) delete process.env.CDSS_CLINICAL_FACTS_BACKSTOP;
  else process.env.CDSS_CLINICAL_FACTS_BACKSTOP = previousClinicalFactsBackstop;
  if (previousRxAuditEnabled === undefined) delete process.env.RXAI_AUDIT_ENABLED;
  else process.env.RXAI_AUDIT_ENABLED = previousRxAuditEnabled;
}
