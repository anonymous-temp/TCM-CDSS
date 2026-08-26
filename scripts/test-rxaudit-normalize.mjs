import assert from "node:assert/strict";
import { normalizeLingxiDecision } from "../src/lib/rxaudit-normalize.ts";
import {
  applyRxAuditInputAdvisories,
  auditPrescriptionWithLingxi,
  buildAuditData,
  buildLingxiRiskSection,
  buildLocalHighRiskHerbPairIssues,
  buildRxAuditCorrelationMetadata,
  dedupeRxAuditIssues,
  getRxAuditAttemptTimeoutMs,
  getRxAuditConfig,
  getRxAuditTimeoutMs,
  mergeLocalHighRiskHerbPairIssues,
  reconcileControlledToxicAuthorityIssues,
  normalizeAuditOutcomeForPatient,
  normalizeIssues,
} from "../src/lib/rxaudit.ts";

const cases = [
  ["pass-info", { auditResult: "PASS", highestRiskLevel: "INFO" }, { auditResult: "PASS", highestRiskLevel: "INFO", needManualReview: false }],
  ["remind-low", { auditResult: "REMIND", highestRiskLevel: "LOW", issueRiskLevels: ["LOW"], issueCount: 1 }, { auditResult: "REMIND", highestRiskLevel: "LOW", needManualReview: false }],
  ["missing-result", { highestRiskLevel: "INFO" }, { auditResult: "MANUAL_REVIEW", highestRiskLevel: "INFO", needManualReview: true }],
  ["unknown-result", { auditResult: "ALLOW", highestRiskLevel: "INFO" }, { auditResult: "MANUAL_REVIEW", highestRiskLevel: "INFO", needManualReview: true }],
  ["missing-risk", { auditResult: "PASS" }, { auditResult: "MANUAL_REVIEW", highestRiskLevel: "HIGH", needManualReview: true }],
  ["unknown-risk", { auditResult: "PASS", highestRiskLevel: "NOTICE" }, { auditResult: "MANUAL_REVIEW", highestRiskLevel: "HIGH", needManualReview: true }],
  ["unknown-issue-risk", { auditResult: "REMIND", highestRiskLevel: "LOW", issueRiskLevels: ["UNKNOWN"], issueCount: 1 }, { auditResult: "REMIND", highestRiskLevel: "HIGH", needManualReview: false }],
  ["pass-medium", { auditResult: "PASS", highestRiskLevel: "MEDIUM" }, { auditResult: "MANUAL_REVIEW", highestRiskLevel: "MEDIUM", needManualReview: true }],
  ["pass-with-issue", { auditResult: "PASS", highestRiskLevel: "INFO", issueRiskLevels: ["INFO"], issueCount: 1 }, { auditResult: "MANUAL_REVIEW", highestRiskLevel: "INFO", needManualReview: true }],
  ["block-info", { auditResult: "BLOCK", highestRiskLevel: "INFO" }, { auditResult: "BLOCK", highestRiskLevel: "INFO", needManualReview: false }],
  ["vendor-manual", { auditResult: "PASS", highestRiskLevel: "LOW", needManualReview: true }, { auditResult: "MANUAL_REVIEW", highestRiskLevel: "LOW", needManualReview: true }],
  ["vendor-manual-string", { auditResult: "PASS", highestRiskLevel: "LOW", needManualReview: "true" }, { auditResult: "MANUAL_REVIEW", highestRiskLevel: "LOW", needManualReview: true }],
  ["vendor-manual-number", { auditResult: "PASS", highestRiskLevel: "LOW", needManualReview: 0 }, { auditResult: "MANUAL_REVIEW", highestRiskLevel: "LOW", needManualReview: true }],
  ["vendor-manual-object", { auditResult: "PASS", highestRiskLevel: "LOW", needManualReview: { value: false } }, { auditResult: "MANUAL_REVIEW", highestRiskLevel: "LOW", needManualReview: true }],
];

for (const [name, input, expected] of cases) {
  assert.deepEqual(normalizeLingxiDecision(input), expected, name);
}

for (const invalidTimeout of [NaN, Infinity, -1, 0, 999, 30001, 6500.5, "NaN", "Infinity", "not-a-number"]) {
  assert.equal(getRxAuditTimeoutMs(invalidTimeout), 30000, `invalid total audit timeout must use the bounded default: ${invalidTimeout}`);
  assert.equal(getRxAuditAttemptTimeoutMs(invalidTimeout), 30000, `invalid attempt audit timeout must use the bounded default: ${invalidTimeout}`);
}
assert.equal(getRxAuditTimeoutMs("1000"), 1000);
assert.equal(getRxAuditTimeoutMs("30000"), 30000);
assert.equal(getRxAuditAttemptTimeoutMs("1000"), 1000);
assert.equal(getRxAuditAttemptTimeoutMs("30000"), 30000);

// Customer-scoped CDSS inventory/auth context is not the same identity domain as the
// provider-issued LingXi audit tenant. Passing a customer id through the clinical state must
// never replace the X-Tenant-Id authorized for the provider API key.
{
  const previousTenant = process.env.RXAI_AUDIT_TENANT_ID;
  const previousSystemCode = process.env.RXAI_AUDIT_SYSTEM_CODE;
  process.env.RXAI_AUDIT_TENANT_ID = "PROVIDER_AUTHORIZED_TENANT";
  process.env.RXAI_AUDIT_SYSTEM_CODE = "PROVIDER_AUTHORIZED_SYSTEM";
  try {
    const config = getRxAuditConfig("customer-a");
    assert.equal(config.tenantId, "PROVIDER_AUTHORIZED_TENANT");
    assert.equal(config.systemCode, "PROVIDER_AUTHORIZED_SYSTEM");
  } finally {
    if (previousTenant == null) delete process.env.RXAI_AUDIT_TENANT_ID;
    else process.env.RXAI_AUDIT_TENANT_ID = previousTenant;
    if (previousSystemCode == null) delete process.env.RXAI_AUDIT_SYSTEM_CODE;
    else process.env.RXAI_AUDIT_SYSTEM_CODE = previousSystemCode;
  }
}

const duplicateIssues = dedupeRxAuditIssues([
  {
    issueId: "DUP-001",
    riskLevel: "LOW",
    issueType: "DOSE",
    title: "剂量偏高",
    description: "请复核剂量。",
    relatedItemNos: [3, 1],
    evidence: [{ sourceName: "规则库A", quote: "剂量需复核" }],
    suggestions: ["核对患者情况"],
  },
  {
    issueId: "dup-001",
    riskLevel: "HIGH",
    issueType: "DOSE",
    title: "剂量偏高",
    description: "请复核剂量",
    relatedItemNos: [2, 1],
    evidence: [{ sourceName: "规则库B", quote: "特殊人群需减量" }],
    suggestions: ["核对患者情况", "请药师复核"],
  },
]);
assert.equal(duplicateIssues.length, 1);
assert.equal(duplicateIssues[0].riskLevel, "HIGH");
assert.deepEqual(duplicateIssues[0].relatedItemNos, [1, 2, 3]);
assert.equal(duplicateIssues[0].evidence.length, 2);
assert.deepEqual(duplicateIssues[0].suggestions, ["核对患者情况", "请药师复核"]);
const renderedDuplicate = buildLingxiRiskSection({
  ok: true,
  source: "lingxi",
  degraded: false,
  auditResult: "REMIND",
  highestRiskLevel: "HIGH",
  needManualReview: false,
  issues: [...duplicateIssues, { ...duplicateIssues[0], relatedItemNos: [3, 2, 1] }],
  itemCount: 3,
});
assert.equal((renderedDuplicate.match(/\| 强提示 \|/g) || []).length, 1);
assert.match(renderedDuplicate, /\| dup-001 \|/i);
assert.match(renderedDuplicate, /1、2、3/);
const differentIdsSameMeaning = dedupeRxAuditIssues([
  { ...duplicateIssues[0], issueId: "A-1", relatedItemNos: [1] },
  { ...duplicateIssues[0], issueId: "A-2", relatedItemNos: [2] },
]);
assert.equal(differentIdsSameMeaning.length, 2, "different provider issue IDs must remain independently traceable");
assert.deepEqual(differentIdsSameMeaning.map((issue) => issue.issueId), ["A-1", "A-2"]);
const sameTitleDifferentMeaning = dedupeRxAuditIssues([
  { ...duplicateIssues[0], issueId: "B-1", title: "用药风险提示", description: "剂量偏高" },
  { ...duplicateIssues[0], issueId: "B-2", title: "用药风险提示", description: "存在配伍禁忌" },
]);
assert.equal(sameTitleDifferentMeaning.length, 2);

const localPairState = {
  reasoningPrescribe: {
    stage: "prescribe",
    formula: {
      candidates: [{
        herbs: [
          { name: "乌头", dose: "3g", processing: null, decoctionRequirement: null },
          { name: "半夏", dose: "9g", processing: null, decoctionRequirement: null },
        ],
      }],
    },
  },
};
const localPairIssues = buildLocalHighRiskHerbPairIssues(localPairState, 0);
assert.equal(localPairIssues.length, 1);
assert.equal(localPairIssues[0].riskLevel, "HIGH");
assert.deepEqual(localPairIssues[0].relatedItemNos, [1, 2]);
const providerPass = {
  ok: true,
  source: "lingxi",
  degraded: false,
  auditResult: "PASS",
  highestRiskLevel: "LOW",
  needManualReview: false,
  issues: [{
    issueId: "LINGXI-LOW-1",
    riskLevel: "LOW",
    issueType: "GENERAL_REMINDER",
    title: "一般用药提醒",
    description: "请结合患者情况复核",
    relatedItemNos: [1],
    evidence: [],
    suggestions: [],
  }],
  auditId: "AUDIT-2026-001",
  traceId: "TRACE-2026-001",
  itemCount: 2,
};
const degradedProviderPass = { ...providerPass, degraded: true, degradeReason: "interaction_component_timeout", issues: [] };
const effectiveDegradedPass = normalizeAuditOutcomeForPatient(degradedProviderPass, "男");
assert.equal(effectiveDegradedPass.auditResult, "MANUAL_REVIEW");
assert.equal(effectiveDegradedPass.needManualReview, true);
const renderedDegradedPass = buildLingxiRiskSection(effectiveDegradedPass, "男");
assert.match(renderedDegradedPass, /审方降级.*结果不完整.*不得视为完整 PASS/);
assert.match(renderedDegradedPass, /处置建议.*不阻断流程.*医生\/药师复核/);
assert.doesNotMatch(renderedDegradedPass, /规则审查结果仍有效/);
const degradedCorrelation = buildRxAuditCorrelationMetadata({
  providerOutcome: degradedProviderPass,
  effectiveOutcome: effectiveDegradedPass,
  auditedAt: "2026-07-18T01:02:03.000Z",
});
assert.equal(degradedCorrelation.providerAvailable, true);
assert.equal(degradedCorrelation.providerDegraded, true);
assert.equal(degradedCorrelation.providerDegradeReason, "interaction_component_timeout");
assert.equal(degradedCorrelation.providerAuditResult, "PASS");
assert.equal(degradedCorrelation.effectiveAuditResult, "MANUAL_REVIEW");
assert.equal(degradedCorrelation.needManualReview, true);
const mergedLocalAndProvider = mergeLocalHighRiskHerbPairIssues(localPairState, 0, providerPass);
assert.equal(mergedLocalAndProvider.issues.length, 2, "real LingXi issues and local pair issues must both survive");
assert.ok(mergedLocalAndProvider.issues.some((issue) => issue.issueId === "LINGXI-LOW-1"));
assert.ok(mergedLocalAndProvider.issues.some((issue) => issue.issueType === "TCM_HERB_PAIR_INCOMPATIBILITY"));
assert.equal(mergedLocalAndProvider.highestRiskLevel, "HIGH");
assert.equal(mergedLocalAndProvider.auditResult, "MANUAL_REVIEW");
assert.equal(mergedLocalAndProvider.needManualReview, true);

const regulatoryProbeState = {
  reasoningPrescribe: {
    stage: "prescribe",
    formula: {
      candidates: [{
        herbs: [
          { name: "麻黄", dose: "9g", processing: null, decoctionRequirement: null },
          { name: "炙甘草", dose: "6g", processing: null, decoctionRequirement: null },
          { name: "苦杏仁", dose: "9g", processing: "捣碎", decoctionRequirement: null },
        ],
        decoction: {
          doseCount: "5剂",
          dosesPerDay: 1,
          administrationTimesPerDay: 2,
          course: "5日",
          method: "每日1剂，水煎2次，早晚分服",
          followUpNode: "完成5剂后复诊",
        },
      }],
    },
  },
};
const falseBitterAlmondAuthority = {
  ...providerPass,
  auditResult: "BLOCK",
  highestRiskLevel: "CRITICAL",
  needManualReview: true,
  issues: [{
    issueId: "LINGXI-TOXIC-AUTHORITY-1",
    riskLevel: "CRITICAL",
    ruleLevel: "HARD_BLOCK",
    issueType: "PRESCRIBER_AUTHORITY",
    title: "医师处方权限需确认",
    description: "苦杏仁(捣碎)药品主数据标注为毒性药品，当前医生权限标识为未提供。",
    action: "BLOCK",
    relatedItemNos: [3],
    evidence: [{ ruleName: "毒性药品处方权(主数据/官方管制目录)" }],
    suggestions: ["请确认开方医师权限"],
  }],
};
const correctedBitterAlmond = reconcileControlledToxicAuthorityIssues(regulatoryProbeState, 0, falseBitterAlmondAuthority);
assert.equal(correctedBitterAlmond.auditResult, "MANUAL_REVIEW");
assert.equal(correctedBitterAlmond.highestRiskLevel, "MEDIUM");
assert.equal(correctedBitterAlmond.issues[0].riskLevel, "MEDIUM");
assert.equal(correctedBitterAlmond.issues[0].action, "MANUAL_REVIEW");
assert.match(correctedBitterAlmond.issues[0].description, /药典有小毒.*不在医疗用毒性药品管制目录/);
assert.doesNotMatch(JSON.stringify(correctedBitterAlmond.issues[0]), /当前医生权限标识为未提供/);

// 供应商真实形态（甲方 2026-08-25 复测原样）：issueType=PRIVILEGE，evidence 里没有 ruleName，
// 规则名只在 description。此前闭集未收 PRIVILEGE、证据只查 evidence[]——纠偏没进门。
const providerPrivilegeForm = reconcileControlledToxicAuthorityIssues(regulatoryProbeState, 0, {
  ...falseBitterAlmondAuthority,
  issues: [{
    ...falseBitterAlmondAuthority.issues[0],
    issueId: "LINGXI-PRIVILEGE-REAL",
    issueType: "PRIVILEGE",
    description: "苦杏仁(捣碎) 药品主数据标注为毒性药品，当前医生权限标识为未提供。毒性药品处方权(主数据/官方管制目录)",
    evidence: [],
  }],
});
assert.equal(providerPrivilegeForm.highestRiskLevel, "MEDIUM", "PRIVILEGE 形态必须被纠偏：CRITICAL 误报不得到达医生");
assert.equal(providerPrivilegeForm.issues[0].action, "MANUAL_REVIEW");
assert.equal(providerPrivilegeForm.auditResult, "MANUAL_REVIEW");
assert.doesNotMatch(JSON.stringify(providerPrivilegeForm.issues[0]), /医师处方权限需确认|权限标识为未提供/);

const genuineControlledState = structuredClone(regulatoryProbeState);
genuineControlledState.reasoningPrescribe.formula.candidates[0].herbs[2].name = "雄黄";
const genuineControlled = reconcileControlledToxicAuthorityIssues(genuineControlledState, 0, falseBitterAlmondAuthority);
assert.equal(genuineControlled.auditResult, "BLOCK", "a genuinely controlled toxic herb must never be downgraded");
assert.equal(genuineControlled.highestRiskLevel, "CRITICAL");

const concurrentCritical = reconcileControlledToxicAuthorityIssues(regulatoryProbeState, 0, {
  ...falseBitterAlmondAuthority,
  issues: [
    ...falseBitterAlmondAuthority.issues,
    { ...falseBitterAlmondAuthority.issues[0], issueId: "LINGXI-OTHER-CRITICAL", issueType: "INTERACTION", title: "严重配伍禁忌", description: "存在明确配伍禁忌", action: "BLOCK", relatedItemNos: [1], evidence: [] },
  ],
});
assert.equal(concurrentCritical.auditResult, "BLOCK", "an unrelated blocking issue must survive the governed correction");
assert.equal(concurrentCritical.highestRiskLevel, "CRITICAL");

const compositeDoseAndAuthority = reconcileControlledToxicAuthorityIssues(regulatoryProbeState, 0, {
  ...falseBitterAlmondAuthority,
  issues: [{
    ...falseBitterAlmondAuthority.issues[0],
    issueId: "LINGXI-COMPOSITE-DOSE-1",
    issueType: "DOSE_OVER",
    title: "严重超量且医师处方权限需确认",
    description: "苦杏仁严重超剂量，同时医师处方权限需确认。",
  }],
});
assert.equal(compositeDoseAndAuthority.auditResult, "BLOCK", "a composite dose+authority blocker must not be regulatory-corrected as a whole");
assert.equal(compositeDoseAndAuthority.issues[0].issueType, "DOSE_OVER");
assert.equal(compositeDoseAndAuthority.issues[0].riskLevel, "CRITICAL");

for (const [label, otherIssue] of [
  ["missing action", { riskLevel: "HIGH", ruleLevel: "PROVIDER_RULE", action: undefined }],
  ["lowercase block", { riskLevel: "HIGH", ruleLevel: "PROVIDER_RULE", action: "block" }],
  ["hard-block rule level", { riskLevel: "HIGH", ruleLevel: "HARD_BLOCK", action: "MANUAL_REVIEW" }],
]) {
  const preservedTopLevelBlock = reconcileControlledToxicAuthorityIssues(regulatoryProbeState, 0, {
    ...falseBitterAlmondAuthority,
    issues: [
      ...falseBitterAlmondAuthority.issues,
      {
        ...falseBitterAlmondAuthority.issues[0],
        issueId: `LINGXI-OTHER-${label.replace(/\s+/g, "-")}`,
        issueType: "OTHER_PROVIDER_RULE",
        title: "其他供应商风险",
        description: "供应商未证明可以放行的独立风险。",
        evidence: [],
        suggestions: ["保持人工复核"],
        relatedItemNos: [1],
        ...otherIssue,
      },
    ],
  });
  assert.equal(preservedTopLevelBlock.auditResult, "BLOCK", `${label} must preserve the normalized provider top-level BLOCK`);
}
const providerPassWithInputAdvisory = applyRxAuditInputAdvisories(providerPass, [{
  code: "medication_semantics_unavailable",
  itemNo: 0,
  drugName: "现用药",
  message: "需人工核对",
}]);
assert.equal(providerPassWithInputAdvisory.auditResult, "MANUAL_REVIEW");
assert.equal(providerPassWithInputAdvisory.needManualReview, true);
assert.equal(providerPassWithInputAdvisory.highestRiskLevel, "LOW");
const correlation = buildRxAuditCorrelationMetadata({
  providerOutcome: providerPass,
  effectiveOutcome: mergedLocalAndProvider,
  candidateIndex: 0,
  prescriptionHash: "sha256-test-prescription",
  auditedAt: "2026-07-18T01:02:03.000Z",
});
assert.deepEqual(correlation, {
  provider: "lingxi-rxaudit",
  providerAvailable: true,
  providerDegraded: false,
  providerAuditResult: "PASS",
  providerHighestRiskLevel: "LOW",
  auditId: "AUDIT-2026-001",
  traceId: "TRACE-2026-001",
  candidateIndex: 0,
  prescriptionHash: "sha256-test-prescription",
  auditedAt: "2026-07-18T01:02:03.000Z",
  effectiveAuditResult: "MANUAL_REVIEW",
  effectiveHighestRiskLevel: "HIGH",
  needManualReview: true,
});
assert.doesNotMatch(JSON.stringify(correlation), /patient|chiefComplaint|medicationHistory|患者姓名/i);
const unsafeCorrelation = buildRxAuditCorrelationMetadata({
  providerOutcome: { ...providerPass, auditId: "张三-AUDIT", traceId: "TRACE WITH SPACES" },
  effectiveOutcome: mergedLocalAndProvider,
  candidateIndex: 0,
  prescriptionHash: "sha256-test-prescription",
});
assert.equal(unsafeCorrelation.auditId, undefined);
assert.equal(unsafeCorrelation.traceId, undefined);

const generatedIdIssues = normalizeIssues([{
  risk_level: "MEDIUM",
  rule_level: "GENERAL",
  issue_type: "DOSE",
  issue_title: "剂量需复核",
  description: "供应商未返回问题编号",
  related_item_nos: [2],
}]);
assert.match(generatedIdIssues[0].issueId || "", /^LOCAL-[0-9A-F]{8}$/);
assert.equal(generatedIdIssues[0].issueIdGenerated, true);
const renderedGeneratedId = buildLingxiRiskSection({
  ok: true,
  source: "lingxi",
  degraded: false,
  auditResult: "REMIND",
  highestRiskLevel: "MEDIUM",
  needManualReview: false,
  issues: generatedIdIssues,
  itemCount: 1,
});
assert.match(renderedGeneratedId, /需人工复核/);
assert.match(renderedGeneratedId, /LOCAL-[0-9A-F]{8}/);
assert.doesNotMatch(renderedGeneratedId, /未返回ID/);

for (const invalidIssueId of [123, { value: "RX-OBJECT" }, "   "]) {
  const normalized = normalizeIssues([{
    issue_id: invalidIssueId,
    risk_level: "MEDIUM",
    issue_title: "供应商编号格式异常",
    description: "仍需保留为人工复核提示",
  }]);
  assert.match(normalized[0].issueId || "", /^LOCAL-[0-9A-F]{8}$/);
  assert.equal(normalized[0].issueIdGenerated, true);
  assert.equal(normalized[0].riskLevel, "MEDIUM");
}
const malformedFields = normalizeIssues([{
  issue_id: 99,
  risk_level: { value: "LOW" },
  issue_title: { text: "对象标题" },
  description: ["数组描述"],
  related_item_nos: { value: 1 },
  suggestions: [{ content: { text: "对象建议" } }],
}]);
assert.equal(malformedFields[0].riskLevel, "HIGH");
assert.equal(malformedFields[0].title, "用药风险提示");
for (const [issueType, rawTitle, expectedTitle] of [
  ["TCM_DECOCTION_METHOD", "TCM_DECOCTION_METHOD", "煎服方法需复核"],
  ["TCM_SPECIAL_POP", "TCM_SPECIAL_POP", "特殊人群用药需复核"],
  ["CONTRAINDICATION", "CONTRAINDICATION", "用药禁忌需复核"],
  ["DRUG_INTERACTION", "DRUG_INTERACTION", "存在药物相互作用风险"],
  ["DUPLICATE", "DUPLICATE", "存在重复用药风险"],
]) {
  const normalized = normalizeIssues([{
    issue_id: `enum-${issueType}`,
    risk_level: "MEDIUM",
    issue_type: issueType,
    issue_title: rawTitle,
    description: "结构化规则已命中",
    related_item_nos: [1],
  }]);
  assert.equal(normalized[0]?.title, expectedTitle, `${issueType} must never leak as a clinician-facing title`);
}
const authoredClinicalTitle = normalizeIssues([{
  issue_id: "authored-title",
  risk_level: "HIGH",
  issue_type: "DRUG_INTERACTION",
  issue_title: "华法林联用出血风险",
  description: "需结合凝血指标复核",
  related_item_nos: [1],
}]);
assert.equal(authoredClinicalTitle[0]?.title, "华法林联用出血风险", "a meaningful provider clinical title remains authoritative");
assert.deepEqual(malformedFields[0].relatedItemNos, []);
assert.deepEqual(malformedFields[0].suggestions, []);

const renderedEmptyBlock = buildLingxiRiskSection({
  ok: true,
  source: "lingxi",
  degraded: false,
  auditResult: "BLOCK",
  highestRiskLevel: "HIGH",
  needManualReview: true,
  issues: [],
  itemCount: 2,
});
assert.match(renderedEmptyBlock, /强提示，需人工复核/);
assert.match(renderedEmptyBlock, /最高风险等级.*高风险/);
assert.match(renderedEmptyBlock, /未提供可展示的问题明细/);
assert.doesNotMatch(renderedEmptyBlock, /未见需提示问题/);

const renderedMaleFemaleOnly = buildLingxiRiskSection({
  ok: true,
  source: "lingxi",
  degraded: false,
  auditResult: "MANUAL_REVIEW",
  highestRiskLevel: "HIGH",
  needManualReview: true,
  issues: [{
    issueId: "FEMALE-ONLY",
    riskLevel: "HIGH",
    title: "妊娠期用药风险",
    description: "孕妇禁用",
    relatedItemNos: [1],
    evidence: [{ sourceName: "规则库", quote: "孕妇禁用" }],
    suggestions: ["妊娠期停用"],
  }],
  itemCount: 1,
}, "男");
assert.match(renderedMaleFemaleOnly, /审方结论.*需人工复核/);
// 表格首列是给医生看的「审查规则」，不再是机器标识。evidence 无 ruleName、issue 无 issueType 时
// 兜底到「规则审查」——**绝不回落到 issueId**，否则 UUID 又回到最显眼的位置。
assert.match(renderedMaleFemaleOnly, /\| 规则审查 \| 强提示 \|/);
assert.doesNotMatch(renderedMaleFemaleOnly, /^\| FEMALE-ONLY \|/m);
// 机器标识仍保留在末列，供后台对账与工单引用。
assert.match(renderedMaleFemaleOnly, /FEMALE-ONLY \|$/m);
assert.match(renderedMaleFemaleOnly, /孕妇禁用/);
assert.doesNotMatch(renderedMaleFemaleOnly, /当前资料判定不适用|未见需提示问题/);

// evidence 带 ruleName 时首列必须用它——这才是医生真正需要的「哪条规则命中了」。
const renderedWithRuleName = buildLingxiRiskSection({
  ok: true,
  source: "lingxi",
  degraded: false,
  auditResult: "MANUAL_REVIEW",
  highestRiskLevel: "HIGH",
  needManualReview: true,
  issues: [{
    issueId: "e0c4256e-27f5-49a6-a442-73ee86d75029",
    riskLevel: "HIGH",
    title: "给药途径需调整",
    description: "该药味不宜与当前给药途径同用",
    relatedItemNos: [2],
    evidence: [{ sourceName: "规则库", ruleName: "剂量审查", quote: "超出常用量上限" }],
    suggestions: ["复核给药途径"],
  }],
  itemCount: 1,
}, "女");
assert.match(renderedWithRuleName, /\| 剂量审查 \| 强提示 \|/);
assert.doesNotMatch(renderedWithRuleName, /^\| e0c4256e-27f5-49a6-a442-73ee86d75029 \|/m);
assert.match(renderedWithRuleName, /e0c4256e-27f5-49a6-a442-73ee86d75029 \|$/m);

const renderedMaleMixedRisk = buildLingxiRiskSection({
  ok: true,
  source: "lingxi",
  degraded: false,
  auditResult: "BLOCK",
  highestRiskLevel: "HIGH",
  needManualReview: true,
  issues: [{
    issueId: "MIXED-1",
    riskLevel: "HIGH",
    title: "妊娠和肝肾功能不全患者慎用",
    description: "妊娠和肝肾功能不全患者慎用",
    relatedItemNos: [1],
    evidence: [],
    suggestions: [],
  }],
  itemCount: 1,
}, "男");
assert.match(renderedMaleMixedRisk, /强提示，需人工复核/);
assert.match(renderedMaleMixedRisk, /MIXED-1/);
assert.match(renderedMaleMixedRisk, /肝肾功能不全/);
assert.doesNotMatch(renderedMaleMixedRisk, /供应商问题均已按患者信息确认不适用/);

const phiProbe = buildAuditData({
  patient: {},
  chiefComplaint: "张三昨夜失眠三周",
  prescription: "## 中药饮片处方\n\n| 药名 | 剂量 |\n|---|---|\n| 酸枣仁 | 15g |",
  diagnosis: "",
  conversation: [],
});
assert.ok(phiProbe, "PHI probe must build an auditable herb payload");
assert.doesNotMatch(JSON.stringify(phiProbe.data), /张三/, "a Chinese patient name appearing only in free-text complaint must be removed before external audit");
assert.match(JSON.stringify(phiProbe.data), /已脱敏/, "free-text name removal must leave an auditable redaction marker");

const originalFetch = globalThis.fetch;
const previousAuditEnv = {
  baseUrl: process.env.RXAI_AUDIT_BASE_URL,
  token: process.env.RXAI_AUDIT_TOKEN,
  tenant: process.env.RXAI_AUDIT_TENANT_ID,
  allowInsecure: process.env.RXAI_AUDIT_ALLOW_INSECURE_HTTP,
  enabled: process.env.RXAI_AUDIT_ENABLED,
};
process.env.RXAI_AUDIT_BASE_URL = "http://127.0.0.1:18092";
process.env.RXAI_AUDIT_TOKEN = "shape-validation-test-token";
process.env.RXAI_AUDIT_TENANT_ID = "TEST_TENANT";
process.env.RXAI_AUDIT_ALLOW_INSECURE_HTTP = "true";
process.env.RXAI_AUDIT_ENABLED = "true";
globalThis.fetch = async () => new Response("null", { status: 200, headers: { "content-type": "application/json" } });
try {
  const invalidRoot = await auditPrescriptionWithLingxi({
    patient: {},
    chiefComplaint: "测试",
    prescription: "## 中药饮片处方\n\n| 药名 | 剂量 |\n|---|---|\n| 酸枣仁 | 15g |",
    reasoningPrescribe: {
      stage: "prescribe",
      formula: {
        candidates: [{
          herbs: [{ name: "酸枣仁", dose: "15g", processing: null, decoctionRequirement: null }],
          decoction: {
            doseCount: "5剂",
            dosesPerDay: 1,
            administrationTimesPerDay: 2,
            course: "5日",
            method: "每日1剂，水煎2次，早晚分服",
            followUpNode: "完成5剂后复诊",
          },
        }],
      },
    },
    diagnosis: "",
    conversation: [],
  });
  assert.deepEqual(invalidRoot, {
    ok: false,
    source: "unavailable",
    reason: "rxaudit_invalid_response_shape",
    itemCount: 1,
  });
} finally {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries({
    RXAI_AUDIT_BASE_URL: previousAuditEnv.baseUrl,
    RXAI_AUDIT_TOKEN: previousAuditEnv.token,
    RXAI_AUDIT_TENANT_ID: previousAuditEnv.tenant,
    RXAI_AUDIT_ALLOW_INSECURE_HTTP: previousAuditEnv.allowInsecure,
    RXAI_AUDIT_ENABLED: previousAuditEnv.enabled,
  })) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
}

console.log(JSON.stringify({ cases: cases.length + 17, failures: 0 }));
