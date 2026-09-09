import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createJiti } from "jiti";

// Synthetic, offline fixtures only; never load a runtime secret file.
Object.assign(process.env, {
  REASONING_CONTRACT_SIGNING_KEY: "his-projection-test-signing-key-at-least-32-characters",
  CDSS_API_CLIENT_ID: "his-projection-client", CDSS_API_CUSTOMER_IDS: "his-projection-customer",
  CDSS_DEFAULT_CUSTOMER_ID: "his-projection-customer", CDSS_CUSTOMER_ID: "his-projection-customer",
  RXAI_AUDIT_ENABLED: "false",
});
const jiti = createJiti(import.meta.url, { alias: {
  "@": `${process.cwd()}/src`, "server-only": `${process.cwd()}/node_modules/next/dist/compiled/server-only/empty.js`,
} });
const signatures = await jiti.import("../src/lib/reasoning-contract-signature.ts");
const { normalizeCaseStateInput } = await jiti.import("../src/lib/diagnosis-types.ts");
const { withSafetyGate, buildDeterministicRiskFollowup } = await jiti.import("../src/lib/diagnosis-safety.ts");
const { getTcmHerbFunctionText } = await jiti.import("../src/lib/tcm-knowledge.ts");
const { synchronizeVisibleClinicalSummary } = await jiti.import("../src/lib/diagnosis-visible-summary.ts");
const { buildUnavailableRxAuditSection, buildAuditItemsFromHerbs, auditPrescriptionWithLingxi, buildRxAuditScopeSection } = await jiti.import("../src/lib/rxaudit.ts");
const { findLocalPatentMedicineEntry } = await jiti.import("../src/lib/local-patent-medicine-candidates.ts");
const { validateHisPrescriptionForWriteBack } = await jiti.import("../src/lib/his-prescription-validation.ts");
const { deriveCaseWarningProfile } = await jiti.import("../src/lib/clinical-warning-tier.ts");
const { medicineCandidateRow, medicineCandidateTable, localLabelRiskProjection } = await jiti.import("../src/lib/medicine-reference-projection.ts");
const { buildHisAiSchemePayload, section } = await jiti.import("../src/lib/his-scheme.ts");
const { sectionTitleGroup } = await jiti.import("../src/lib/cdss-vocab.ts");
const { unsupportedHighImpactHerbFindings } = await jiti.import("../src/lib/diagnosis-stage-contract.ts");
const { isSafetyClinicalDeliveryAdvisory } = await jiti.import("../src/lib/clinical-delivery-advisory.ts");
const { rejectionTier } = await jiti.import("../src/lib/diagnosis-rejection-tiers.ts");
const { invalidatePrescriptionContractAfterEdit } = await jiti.import("../src/lib/prescription-revision.ts");

// Reuse the existing complete synthetic fixture constructors without changing the golden oracle.
const source = readFileSync(new URL("./regress-tcm-cdss.mjs", import.meta.url), "utf8");
const helpers = source.slice(source.indexOf("function hisRecord("), source.indexOf("function expected("));
const bindings = { ...signatures, normalizeCaseStateInput, withSafetyGate, getTcmHerbFunctionText,
  synchronizeVisibleClinicalSummary, buildUnavailableRxAuditSection, buildDeterministicRiskFollowup,
  findLocalPatentMedicineEntry,
  CDSS_CUSTOMER_ID: "his-projection-customer" };
const fixtures = new Function(...Object.keys(bindings), `${helpers}\nreturn {baseCase, reasoningV2WithHerbs, completeHisDeliveryFixture, buildHisProjectionRegressionCases};`)(...Object.values(bindings));
const clone = structuredClone;
function complete(reasoning, id = "his-projection") {
  const state = fixtures.completeHisDeliveryFixture(fixtures.baseCase(id, { reasoningV2: reasoning }));
  state.reasoningPrescribe = state.reasoningV2;
  state.riskAssessment = "## 处方安全总评\n审方建议医生复核。\n\n## 随访管理方案\n完成5剂后复诊。";
  state.prescriptionRevision = { candidateIndex: 0, source: "generated", auditAvailable: true,
    auditResult: "MANUAL_REVIEW", highestRiskLevel: "HIGH", needManualReview: true };
  return state;
}
function benign() {
  return complete(fixtures.reasoningV2WithHerbs([{ name: "酸枣仁", dose: "10g", function: "养心安神" }]));
}
const entry = findLocalPatentMedicineEntry("外感风寒颗粒");
assert.ok(entry?.fingerprint);
const compact = (text) => text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 800);
const labelRisk = compact([entry.contraindication, entry.precaution, entry.pregnancyLactation, entry.interaction].filter(Boolean).join("；"));
assert.match(labelRisk, /禁止使用/);
function medicine() {
  return { type: "中成药", name: entry.name, specification: entry.specification,
    evidenceId: "LOCAL-INST-007", evidenceFingerprint: entry.fingerprint, recommendationMode: "candidate_review",
    positioning: "需医生评估", correspondingProblem: "恶寒无汗", usageBoundary: "说明书用法字段已与本候选的说明书条目及指纹绑定。",
    relationship: "与中药饮片方案不默认联用，由医生结合重复功效、相互作用和治疗目标择一或评估联用。",
    riskNote: labelRisk, evidence: { evidenceLevel: "kb_entry", source: "本地药品说明书 [LOCAL-INST-007]", confidence: "中" } };
}
function withMedicine(state, item = medicine()) {
  const reasoning = clone(state.reasoningPrescribe);
  reasoning.formula.patentAndWestern = [item];
  delete reasoning.contractSignature;
  return complete(reasoning);
}
function scope(state) {
  return { candidateIndex: 0, submittedItems: clone(buildAuditItemsFromHerbs(state, 0)) };
}
function payload(state, auditScope = scope(state)) {
  const validation = validateHisPrescriptionForWriteBack(state);
  assert.equal(validation.ok, true, JSON.stringify(validation));
  return buildHisAiSchemePayload(state, undefined, validation.advisories, auditScope);
}

test("exact canonical label risk stays visible without becoming a patient L4", () => {
  const state = withMedicine(benign());
  assert.match(state.prescription, /本品性状发生改变时禁止使用/);
  assert.ok(localLabelRiskProjection(state.reasoningPrescribe.formula.patentAndWestern[0]) != null);
  assert.ok(state.prescription.includes(medicineCandidateRow(state.reasoningPrescribe.formula.patentAndWestern[0])));
  const warning = deriveCaseWarningProfile(state);
  assert.equal(warning.level, "L3");
  assert.equal(warning.executable, true);
});

test("grounding rewrites one label clause without promoting other exact label clauses to current findings", () => {
  // The fresh LOCAL-INST-008 capture has this existing fact-grounding rewrite within precaution 5.
  const changed = medicine();
  changed.evidenceId = "LOCAL-INST-008";
  changed.evidence.source = "[LOCAL-INST-008]";
  changed.riskNote = labelRisk.replace("或出现新的严重症状如胸闷、心悸等应立即停药", "病历尚未确认胸闷、心悸是否存在");
  assert.notEqual(changed.riskNote, labelRisk);
  const state = withMedicine(benign(), changed);
  assert.equal(deriveCaseWarningProfile(state).level, "L3");
  assert.equal(payload(state).prescriptions.herbal[0].adoptable, true);
  assert.equal(deriveCaseWarningProfile(withMedicine(benign(), { ...changed, riskNote: `${changed.riskNote}；本例存在绝对禁忌` })).level, "L4");
});

test("every nested heading ends the flat renderer's label reference domain", () => {
  const state = withMedicine(benign());
  const heading = medicineCandidateTable([medicine()])[0];
  for (const nested of ["### 当前处方风险提示", "#### 本例风险", "##### 其他小节", `### ${heading.slice(3)}`]) {
    const changed = { ...state, prescription: state.prescription.replace(heading, `${heading}\n${nested}`) };
    assert.equal(deriveCaseWarningProfile(changed).level, "L4", nested);
  }
});

test("current-risk copies, appended risk, other patient columns and forged provenance stay active", () => {
  const state = withMedicine(benign());
  for (const changed of [
    { ...state, riskAssessment: `${state.riskAssessment}\n本品性状发生改变时禁止使用` },
    { ...state, prescription: `${state.prescription}\n## 处方风险提示\n本品性状发生改变时禁止使用` },
    { ...state, prescription: state.prescription.replace(labelRisk, `${labelRisk}；本例配伍禁忌`) },
    withMedicine(benign(), { ...medicine(), correspondingProblem: "本例存在绝对禁忌" }),
    withMedicine(benign(), { ...medicine(), evidenceFingerprint: "forged" }),
    withMedicine(benign(), { ...medicine(), specification: "changed" }),
    withMedicine(benign(), { ...medicine(), riskNote: `${labelRisk}；本例绝对禁忌` }),
    withMedicine(benign(), { ...medicine(), riskNote: `${labelRisk}；8.本品性状发生改变时禁止使用。` }),
    withMedicine(benign(), { ...medicine(), riskNote: labelRisk.replace("8.本品性状发生改变时禁止使用。", "8.本例已见变质，按本品性状发生改变时禁止使用处理。") }),
    { ...state, prescription: state.prescription.replace(entry.name, "未知颗粒") },
    { ...state, prescription: state.prescription.replace("[LOCAL-INST-007]", "[LOCAL-INST-999]") },
    { ...state, prescription: `${state.prescription}\n## 中成药/西药候选\n${medicineCandidateRow(medicine())}` },
  ]) assert.equal(deriveCaseWarningProfile(changed).level, "L4");
});

test("quality code has a closed concept vocabulary and never waives independent related codes", () => {
  const quality = { code: "candidate_0_herb_0_therapy_vocabulary_unverified_heat_clear", candidateIndex: 0, message: "质量提示", suggestedAction: "核对" };
  assert.equal(isSafetyClinicalDeliveryAdvisory(quality), false);
  for (const code of ["candidate_0_herb_0_unsupported_high_impact_heat_clear", "candidate_0_high_risk_pair_incompatibility", "follow_up_inconsistent", "unknown_future_issue"]) {
    assert.equal(isSafetyClinicalDeliveryAdvisory({ ...quality, relatedCodes: [code] }), true, code);
  }
  for (const code of ["candidate_0_herb_0_therapy_vocabulary_unverified_future_concept", "candidate_0_herb_0_therapy_vocabulary_unverified_heat_clear_dose", "therapy_vocabulary_unverified_heat_clear"]) {
    assert.equal(rejectionTier(`m04_${code}`), "T1", code);
  }
});

test("audit receipt records actual request items, never degraded or unavailable audit claims", async () => {
  const state = withMedicine(benign());
  const savedFetch = globalThis.fetch;
  const envKeys = ["RXAI_AUDIT_ENABLED", "RXAI_AUDIT_BASE_URL", "RXAI_AUDIT_API_KEY"];
  const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, { RXAI_AUDIT_ENABLED: "true", RXAI_AUDIT_BASE_URL: "https://audit.example.invalid", RXAI_AUDIT_API_KEY: "synthetic-offline-only" });
  let submitted;
  let degraded = false;
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    assert.equal(request.operation, "PRESCRIPTION_AUDIT");
    submitted = request.data.prescription.items;
    return Response.json({ code: 200, data: { audit_result: "MANUAL_REVIEW", highest_risk_level: "HIGH", need_manual_review: true, issues: [], degraded } });
  };
  try {
    const audited = await auditPrescriptionWithLingxi(state, 0);
    assert.equal(audited.ok, true);
    assert.deepEqual(audited.submissionScope.submittedItems, submitted);
    assert.equal(audited.submissionScope.candidateIndex, 0);
    const submittedMedicine = submitted.find((item) => item.drug_type === "中成药");
    assert.ok(submittedMedicine);
    assert.equal(submittedMedicine.single_dose, undefined);
    assert.equal(payload(state, audited.submissionScope).prescriptions.herbal[0].adoptable, true);
    assert.match(buildRxAuditScopeSection(state, 0, audited.submissionScope), /已按药品身份及联用边界提交/);
    degraded = true;
    const limited = await auditPrescriptionWithLingxi(state, 0);
    assert.equal(limited.ok, true);
    assert.equal(limited.submissionScope, undefined);
    assert.equal(payload(state, limited.submissionScope || null).prescriptions.herbal[0].adoptable, false);
    process.env.RXAI_AUDIT_ENABLED = "false";
    const absent = await auditPrescriptionWithLingxi(state, 0);
    assert.equal(absent.ok, false);
    assert.equal(absent.submissionScope, undefined);
    assert.doesNotMatch(buildRxAuditScopeSection(state, 0), /已按药品身份及联用边界提交/);
    assert.match(buildRxAuditScopeSection(state, 0), /尚无本次有效送审凭据/);
  } finally {
    globalThis.fetch = savedFetch;
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  }
});

test("the combined 50 item cap excludes medicine coverage rather than granting a whole-prescription receipt", () => {
  const state = withMedicine(benign());
  const herb = state.reasoningPrescribe.formula.candidates[0].herbs[0];
  state.reasoningPrescribe.formula.candidates[0].herbs = Array.from({ length: 50 }, () => clone(herb));
  const receipt = scope(state);
  assert.equal(receipt.submittedItems.length, 50);
  assert.ok(receipt.submittedItems.every((item) => item.drug_type === "中药饮片"));
  const result = buildHisAiSchemePayload(state, undefined, [], receipt);
  assert.equal(result.prescriptions.herbal[0].adoptable, false);
  assert.match(buildRxAuditScopeSection(state, 0, receipt), /1 项中成药\/西药候选尚无本次有效送审凭据/);
});

test("BLOCK, effective CRITICAL, selected genuine pair and legacy risk cannot be masked", () => {
  for (const revision of [{ auditResult: "BLOCK" }, { highestRiskLevel: "CRITICAL" }]) {
    const state = withMedicine(benign());
    state.prescriptionRevision = { ...state.prescriptionRevision, ...revision };
    assert.equal(deriveCaseWarningProfile(state).level, "L4");
  }
  const pair = withMedicine(complete(fixtures.reasoningV2WithHerbs([
    { name: "甘草", dose: "3g" }, { name: "甘遂", dose: "1g" },
  ])));
  assert.equal(deriveCaseWarningProfile(pair).level, "L4");
  assert.equal(deriveCaseWarningProfile({ ...benign(), prescription: "旧处方：本品性状发生改变时禁止使用" }).level, "L4");
});

function vocabularyState() {
  const reasoning = fixtures.reasoningV2WithHerbs([{ name: "升麻", dose: "3g", prescriptionRole: "升阳举陷" }]);
  reasoning.therapy = { overallPrinciple: "补中益气，升阳举陷", overallMethod: "补中益气，升阳举陷", subTherapies: [] };
  reasoning.overview.overallTherapy = "补中益气，升阳举陷";
  reasoning.formula.candidates[0].therapyMatch = "补中益气，升阳举陷";
  reasoning.clinicalReview = { status: "accepted", provider: "synthetic", model: "synthetic", source: "preferred",
    acceptanceScope: { waivedIssueCodes: [], qualityAnnotationCodes: ["m04_candidate_0_herb_0_unsupported_high_impact_heat_clear"] } };
  return complete(reasoning, "vocabulary-quality");
}

test("signed strict-only direction vocabulary is a visible quality advisory", () => {
  const state = vocabularyState();
  const candidate = state.reasoningPrescribe.formula.candidates[0];
  assert.ok(unsupportedHighImpactHerbFindings(candidate.herbs, state.reasoningDiagnose, true, [], false).some((f) => f.concepts.includes("heat_clear")));
  assert.equal(unsupportedHighImpactHerbFindings(candidate.herbs, state.reasoningDiagnose, true, [], true).length, 0);
  const checked = validateHisPrescriptionForWriteBack(state);
  assert.equal(checked.ok, true);
  assert.ok(checked.advisories.some((a) => /heat_clear/.test(a.code)), JSON.stringify(checked.advisories));
  assert.equal(checked.advisories.some(isSafetyClinicalDeliveryAdvisory), false, JSON.stringify(checked.advisories));
});

test("true opposing direction and simultaneous unrelated safety survive quality acceptance", () => {
  for (const mode of ["opposition", "dose", "pair"]) {
    const reasoning = clone(vocabularyState().reasoningPrescribe);
    delete reasoning.contractSignature;
    if (mode === "opposition") {
      reasoning.therapy = { overallPrinciple: "清热泻火", overallMethod: "苦寒清热", subTherapies: [] };
      reasoning.formula.candidates[0].herbs = fixtures.reasoningV2WithHerbs([{ name: "干姜", dose: "3g" }]).formula.candidates[0].herbs;
    } else if (mode === "dose") reasoning.formula.candidates[0].herbs[0].dose = "9999g";
    else reasoning.formula.candidates[0].herbs.push(...fixtures.reasoningV2WithHerbs([{ name: "甘草", dose: "3g" }, { name: "甘遂", dose: "1g" }]).formula.candidates[0].herbs);
    const state = complete(reasoning);
    const checked = validateHisPrescriptionForWriteBack(state);
    assert.equal(checked.ok, true);
    assert.ok(checked.advisories.some(isSafetyClinicalDeliveryAdvisory), mode);
    assert.equal(payload(state).prescriptions.herbal[0].adoptable, false, mode);
  }
});

test("post-acceptance edit loses signature and review binding", () => {
  const state = vocabularyState();
  const edited = invalidatePrescriptionContractAfterEdit(state.reasoningPrescribe);
  assert.equal(edited.contractSignature, undefined);
  assert.equal(edited.clinicalReview, undefined);
  const checked = validateHisPrescriptionForWriteBack({ ...state, reasoningV2: edited, reasoningPrescribe: edited });
  assert.equal(checked.ok, false);
  assert.equal(checked.code, "invalid_m04_signature");
});

test("submitted identity and combination scope unlocks only the herbal candidate", () => {
  const state = withMedicine(benign());
  const result = payload(state);
  assert.equal(result.status, "ready");
  assert.equal(result.prescriptions.herbal[0].adoptable, true);
  assert.equal(result.prescriptions.westernOrPatent[0].adoptable, false);
  assert.doesNotMatch(JSON.stringify(result), /西药\/中成药候选未进入本次中药饮片审方/);
});

test("missing scope, extra orders, changed medicine fields and truncation stay limited", () => {
  const state = withMedicine(benign());
  assert.equal(payload(state, null).prescriptions.herbal[0].adoptable, false);
  for (const changed of [
    { ...state, prescription: `${state.prescription}\n## 西药/中成药方案\n阿莫西林胶囊每次500mg每日3次` },
    { ...state, prescription: state.prescription.replace(entry.name, "阿莫西林胶囊") },
    withMedicine(benign(), { ...medicine(), specification: "changed" }),
    withMedicine(benign(), { ...medicine(), frequency: "每日99次" }),
  ]) assert.equal(payload(changed, scope(state)).prescriptions.herbal[0].adoptable, false);
  const truncated = scope(state);
  truncated.submittedItems = truncated.submittedItems.filter((item) => item.drug_type === "中药饮片");
  assert.equal(payload(state, truncated).prescriptions.herbal[0].adoptable, false);
});

test("observation-only daily prose does not invent an unsubmitted medicine", () => {
  for (const text of ["每日观察症状", "每次随访记录症状变化", "每日记录体温", "每日记录口服用药后的症状"]) {
    const state = benign();
    state.prescription += `\n## 中成药/西药候选\n${text}`;
    assert.equal(payload(state, null).prescriptions.herbal[0].adoptable, true, text);
  }
});

test("legacy frequency plus administration remains an unsubmitted order without a familiar drug suffix", () => {
  for (const text of ["每日口服替格瑞洛", "每次吸入沙丁胺醇", "每晚服用依折麦布", "口服替格瑞洛，每日两次",
    "替格瑞洛每日口服", "建议每日口服替格瑞洛", "沙丁胺醇每次吸入", "依折麦布口服，每晚一次"]) {
    const state = benign();
    state.prescription += `\n## 中成药/西药候选\n${text}`;
    assert.equal(payload(state, null).prescriptions.herbal[0].adoptable, false, text);
  }
});

test("legacy medication instruction grammar is invariant to punctuation, order and instruction prefix", () => {
  const base = benign();
  for (const frequency of ["每日", "每日2次", "每日两次", "每次"]) {
    for (const separator of ["", " ", "，", ",", "、", "：", "；", "\n"]) {
      for (const administration of ["口服", "吸入"]) {
        for (const text of [`建议${frequency}${separator}${administration}替格瑞洛`, `替格瑞洛${frequency}${separator}${administration}`,
          `${administration}替格瑞洛${separator}${frequency}`]) {
          const state = { ...base, prescription: `${base.prescription}\n## 中成药/西药候选\n${text}` };
          assert.equal(payload(state, null).prescriptions.herbal[0].adoptable, false, JSON.stringify(text));
        }
      }
    }
  }
});

test("medicine section counting and extraction share alias, colon and inline heading semantics", () => {
  const base = withMedicine(benign());
  const receipt = scope(base);
  const body = "每日两次，口服替格瑞洛";
  const aliases = sectionTitleGroup("westernOrPatent");
  for (const alias of aliases) {
    for (const prefix of ["## ", "##"]) {
      for (const suffix of [`\n${body}`, `：${body}`, `:${body}`, `：\n${body}`, `:\n${body}`]) {
        const extra = `${prefix}${alias}${suffix}`;
        assert.equal(section(extra, aliases), body, JSON.stringify(extra));
        const state = { ...base, prescription: `${base.prescription}\n${extra}` };
        assert.equal(payload(state, receipt).prescriptions.herbal[0].adoptable, false, JSON.stringify(extra));
      }
    }
  }
  assert.equal(payload(base, receipt).prescriptions.herbal[0].adoptable, true);
  assert.equal(section("## 其他调护\n每日观察症状", aliases), "");
});

test("every successful server audit scope renderer receives the current actual receipt", () => {
  const post = readFileSync(new URL("../src/app/api/diagnosis/post-prescription-risk/route.ts", import.meta.url), "utf8");
  const assess = readFileSync(new URL("../src/app/api/diagnosis/assess/route.ts", import.meta.url), "utf8");
  assert.match(post, /buildRxAuditScopeSection\(caseState, resolvedCandidateIndex, providerAudit\.submissionScope\)/);
  assert.match(assess, /buildRxAuditScopeSection\(gated, candidateIndex, providerAudit\.ok \? providerAudit\.submissionScope : undefined\)/);
});

test("all three projections agree on a usable herbal candidate while retaining quality and label notices", () => {
  const state = withMedicine(vocabularyState());
  const result = payload(state);
  assert.equal(result.warningProfile.level, "L3");
  assert.equal(result.status, "ready");
  assert.equal(result.candidateStatus, "valid");
  assert.equal(result.writeBackPolicy.allowSingleItemAdoption, true);
  assert.equal(result.prescriptions.herbal[0].adoptable, true);
  assert.equal(result.prescriptions.westernOrPatent[0].adoptable, false);
  assert.ok(result.warnings.some((a) => /heat_clear/.test(a.code)));
  assert.match(result.prescriptions.westernOrPatent[0].content, /禁止使用/);
});

test("all nine live regression fixtures deterministically reach their intended projection boundary offline", () => {
  const cases = fixtures.buildHisProjectionRegressionCases();
  assert.equal(cases.length, 9);
  for (const fixture of cases) {
    const checked = validateHisPrescriptionForWriteBack(fixture.state);
    if (fixture.httpStatus) {
      assert.equal(checked.ok, false);
      assert.equal(checked.code, "invalid_m04_signature");
      continue;
    }
    assert.equal(checked.ok, true, `${fixture.name}: ${JSON.stringify(checked)}`);
    const state = { ...fixture.state, prescriptionRevision: { candidateIndex: 0, auditResult: "MANUAL_REVIEW", highestRiskLevel: "HIGH", auditAvailable: true } };
    const projected = buildHisAiSchemePayload(state, undefined, checked.advisories, scope(state));
    assert.equal(projected.prescriptions.herbal[0].adoptable, !fixture.restricted,
      `${fixture.name}: ${JSON.stringify({ warning: projected.warningProfile, warnings: projected.warnings, reason: projected.prescriptions.herbal[0].blockedReason })}`);
    if (fixture.quality) assert.ok(projected.warnings.some((item) => /therapy_vocabulary_unverified_heat_clear/.test(item.code)), fixture.name);
    if (fixture.medicine) {
      assert.equal(projected.prescriptions.westernOrPatent[0].adoptable, false);
      assert.match(projected.prescriptions.westernOrPatent[0].content, /禁止使用/);
    }
  }
});
