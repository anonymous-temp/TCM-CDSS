import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { enforceM04PriorStageOwnership, enforceStructuredStageOwnership, isM03WesternSupportContractReason, repairCompletedStructuredSentinel, resolveCompletedStructuredResponse, shouldRunTargetedStructuredRetry, shouldUseM04FinalizeSafetyFloor } = await import("../src/lib/diagnosis-structured-repair.ts");
const { applyDeterministicDecoctionMethod, applyDeterministicHerbFunctions, groundStructuredPatientFacts, normalizeDiagnoseConfidenceAndLabels, restoreValidatedM03Chain, sanitizeOptionalPathogenesisClassifications, scrubInternalVocabularyFromVisibleText, synchronizeVisibleClinicalSummary } = await import("../src/lib/diagnosis-visible-summary.ts");
const { parseOpenAICompatCompletionPayload } = await import("../src/lib/openai-compatible-response.ts");
const { buildM03DiagnosticReviewPrompt, parseM03DiagnosticReview } = await import("../src/lib/m03-diagnostic-review.ts");
const { buildM04ClinicalReviewAdjudicationPrompt, buildM04ClinicalReviewPrompt, constrainM04ClinicalReviewScope, m04ClinicalRepairGuidance, m04ClinicalReviewNeedsAdjudication, m04ClinicalReviewRequiresNonDoseFallback, parseM04ClinicalReview } = await import("../src/lib/m04-clinical-review.ts");
const { enforceReviewedPrescriptionOutput } = await import("../src/lib/prescription-output-safety.ts");
const { normalizeClinicalConfidence, normalizePrescriptionRole, normalizeReasoningV2, normalizeWesternDiagnosisStatus } = await import("../src/lib/diagnosis-types.ts");
const { getTcmHerbFunctionDisplayText } = await import("../src/lib/tcm-knowledge.ts");
const { buildM04ClinicalRepairHint, m04CandidateHerbsFromRepairPayload, m04DoseRepairHerbIndex, stabilizeM04DoseOnlyRepair, structuredClinicalRepairHint } = await import("../src/lib/structured-clinical-repair.ts");
const { dropUnsupportedM04ModificationDirections } = await import("../src/lib/m04-modification-safety.ts");
const diagnosisApiSource = readFileSync(new URL("../src/lib/diagnosis-api.ts", import.meta.url), "utf8");
const prescribeRouteSource = readFileSync(new URL("../src/app/api/diagnosis/prescribe/route.ts", import.meta.url), "utf8");
assert.match(
  prescribeRouteSource,
  /const orchestrationStartedAt = Date\.now\(\);[\s\S]*structuredOrchestrationStartedAt: orchestrationStartedAt/,
  "M04 must carry its route-entry wall clock into stream orchestration so the browser receives a bounded result",
);
assert.match(
  diagnosisApiSource,
  /const requestedOrchestrationStartedAt = opts\.structuredOrchestrationStartedAt;[\s\S]{0,500}?const requestStartedAt = Number\.isFinite/,
  "the stream deadline must include route preparation time instead of resetting immediately before provider fetch",
);
assert.match(
  diagnosisApiSource,
  /let forceCloseAtAbsoluteDeadline = \(\) => upstreamController\.abort\(\);[\s\S]{0,300}?\(\) => forceCloseAtAbsoluteDeadline\(\)/,
  "the absolute timer must own a client-stream close hook instead of only aborting the current upstream adapter",
);
assert.match(
  diagnosisApiSource,
  /forceCloseAtAbsoluteDeadline = \(\) => \{[\s\S]{0,2500}?orchestration_deadline_truncated[\s\S]{0,1500}?enqueueClient\("\[END\]"\);\s*\n\s*closeClientStream\(\);/,
  "a structured-stage deadline must emit a fail-closed fallback and a complete NDJSON terminal even when an upstream abort is observed late",
);
assert.match(
  diagnosisApiSource,
  /review\.status === "repair" && review\.issueCode === "formula_composition_mismatch"[\s\S]{0,700}?m04RepairLoopEarlyExit = true;/,
  "a composition-only M04 review must select deterministic identity declassification instead of redrawing the whole prescription",
);
assert.match(
  diagnosisApiSource,
  /structuredSentinelIncomplete &&[\s\S]{0,250}?retryableStructuredTerminal &&[\s\S]{0,250}?!m04RepairLoopEarlyExit &&[\s\S]{0,250}?!m04OrchestrationDeadlineGate\(\)/,
  "the first full-response repair must stop once deterministic M04 identity declassification has been selected",
);
assert.match(
  diagnosisApiSource,
  /if \(targetedM04Retry && m04RepairLoopEarlyExit\) targetedM04Retry = false;/,
  "a composition rejection after one completed repair must not launch another full M04 redraw",
);
assert.equal(shouldUseM04FinalizeSafetyFloor(false, false), false, "ordinary M04 output keeps the full final contract");
assert.equal(shouldUseM04FinalizeSafetyFloor(false, true), true, "quality-annotated acceptance keeps its safety-floor scope");
assert.equal(
  shouldUseM04FinalizeSafetyFloor(true, false),
  true,
  "an accepted transparent declassification must keep its safety-floor scope even when review produced no annotation",
);
assert.match(
  diagnosisApiSource,
  /primaryStructuredStageCapacity\.acquire\(\{\s*\n\s*signal: upstreamController\.signal,\s*\n\s*deadline: absoluteRunDeadline,/,
  "parallel HTTP cases must queue their internally fanned-out M03/M04 stages inside the same wall-clock deadline",
);
assert.match(
  diagnosisApiSource,
  /releaseStructuredStageCapacity = await primaryStructuredStageCapacity\.acquire\([\s\S]{0,900}?m03WesternHalfPromise = m03ParallelHalves[\s\S]{0,300}?collectM03ParallelWesternHalf/,
  "the parallel M03 western helper must start only after the stage owns provider capacity",
);
assert.match(
  diagnosisApiSource,
  /clientStreamClosed = true;\s*\n\s*releaseStructuredStageCapacity\(\);[\s\S]{0,150}?stopHeartbeat\(\);/,
  "every normal/fail-closed structured stream completion must release its provider-capacity lease",
);
assert.match(
  diagnosisApiSource,
  /lastRejectionReason:\s*opts\.structuredStage === "diagnose"/,
  "every completed M03 orchestration logs its final rejection code without patient content",
);
// Behavioural rather than source-text: the guidance now lives beside its M04 sibling in
// structured-clinical-repair.ts, and what matters is that the reason code still reaches actionable
// instructions — not which file the string sits in.
assert.match(
  structuredClinicalRepairHint("diagnose", "m03_western_clinical_rationale_restatement"),
  /不得逐项串联、换标点复制 supportingFacts/,
  "the bounded M03 repair tells the live model how to escape Western-rationale restatement",
);
// Tier-2/3 带批注受理的接线不变量（解除截断式）。判定逻辑本身在 test:rejection-tiers 里以
// 纯函数验证；这里守住「接线」——受理发生在 finalize 之前（清除 structuredSentinelIncomplete），
// 让候选走归一→独立复核→attestation→签名的完整既有管线。旧的渲染层受理分支已删除：它要求
// m03DiagnosticReviewStatus==="accepted"，而合同否决发生在复核之前（not_run），目标场景下是
// 死路径，且它输出的草稿没有签名结构化载荷，M04 无法继续。改错任何一条都会让受理变得不安全。
assert.match(
  diagnosisApiSource,
  /m03QualityAcceptedReason[\s\S]{0,1500}?m03SafetyContractIssue\([\s\S]{0,300}?isSafetyRejection/,
  "受理判定必须重跑 m03SafetyContractIssue 并注入 isSafetyRejection——只看拒绝码会漏掉短路后未执行的 T1 检查",
);
assert.match(
  diagnosisApiSource,
  /shouldAcceptWithQualityAnnotation\(\{[\s\S]{0,300}?\}\) && qualityAnnotationCopy\(tierRejectionReason\)\) \{\s*\n\s*structuredSentinelIncomplete = false;/,
  "只有 tier 表受理判定与批注文案同时存在时才允许解除截断——未知码经 default-deny tier 表保持 fail-closed",
);
assert.match(
  diagnosisApiSource,
  /structuredSentinelIncomplete = false;\s*\n\s*m03QualityAcceptedReason = tierRejectionReason;/,
  "受理即解除截断，让候选进入完整 finalize 管线（归一/独立复核/attestation/签名），而不是另辟无签名渲染支路",
);
// 充实度度量必须随契约形态走：incompleteM03VisibleDraft 对 JSON-only 响应恒返回 ""，
// 若只用它，任何以草稿长度为门槛的判断在当前 JSON-only 的 M03 上永远过不去、是死代码。
// 该口径已收敛到 m03CandidateSubstanceLength（见 SUBSTANCE-01），此处只钉调用点仍走统一口径。
assert.match(
  diagnosisApiSource,
  /const tierDraftLength = m03CandidateSubstanceLength\(authoritativeContent, tierReasoning\);/,
  "JSON-only 契约下必须以统一口径衡量充实度（草稿与结构化载荷体积取大）",
);
assert.match(
  diagnosisApiSource,
  // 带幂等守卫的形态：路由终审分支可能已贴过同一段批注，流层不得重复贴（双层各贴一次
  // 是甲方生产实测的呈现噪音类）。
  /m03QualityAcceptedReason\) \{\s*\n\s*const annotation = qualityAnnotationCopy\(m03QualityAcceptedReason\);\s*\n\s*if \(annotation && !signedContent\.includes\(annotation\)\) signedContent = `\$\{annotation\}\\n\\n\$\{signedContent\}`;/,
  "受理时必须把医生可读批注前置到签名后的可见正文（且带防重复守卫）",
);
// 受理结果仍要过 finalize 的 attestation 绑定门：无既有 attestation（复核 not_run）时，
// 管线必须对最终 reasoning 补跑独立临床复核，repair 仍走兜底——受理不产生未复核的签名结论。
assert.match(
  diagnosisApiSource,
  /currentAttestation\?\.reviewedPayloadHash !== finalPayloadHash/,
  "finalize 必须校验临床复核 attestation 与最终载荷哈希的绑定",
);
assert.match(
  diagnosisApiSource,
  /\} else if \(opts\.structuredStage === "diagnose"\) \{\s*\n\s*const review = observeClinicalReview\(await reviewM03DiagnosticCriteria\(/,
  "attestation 未绑定时 finalize 必须对最终 M03 reasoning 补跑独立临床复核",
);
assert.match(
  diagnosisApiSource,
  /function m03ReasoningFromStructuredContent[\s\S]{0,900}?catch \{\s*\n\s*return undefined;/,
  "结构化对象解析失败必须返回 undefined —— 拿不到对象就无法证明 T1 通过，只能 fail-closed",
);

assert.match(
  diagnosisApiSource,
  /const retryableStructuredTerminal = finishReason === "stop" \|\| finishReason === "length";[\s\S]*structuredSentinelIncomplete && retryableStructuredTerminal/,
  "a max-token length terminal must enter the same bounded structured retry as a normal stop",
);
// 单味剔除必须先于透明降级判定。两者各自正确却不串联时依旧 0 味：降级分支读原始
// authoritativeContent，方向未成立的那一味仍在方中，transparentFormulaTherapyIssue 必然非空、
// 降级被拒（实测感冒-风寒束表：麻黄汤基准 4/4 达标 + 川芎未剔除 → 降级被拒 → 整方作废）。
assert.match(
  diagnosisApiSource,
  /const declassifiedContent = dropUnsupportedM04CandidateHerbs\(\s*\n\s*markTransparentFormulaDeclassification\(\s*\n\s*authoritativeContent,\s*\n\s*opts\.structuredPriorReasoning,\s*\n\s*\),\s*\n\s*opts\.structuredPriorReasoning,\s*\n\s*false,/,
  "透明降级必须先完成方名身份裁决，再做单味剔除，且对真正的自拟方**不套用经典方基准保留数**——" +
  "否则基准本就不满足的候选会放弃剔除，问题药留在方里、降级验证随即失败，最终仍是 0 味",
);
// 剥离器必须拿到 M03 已锁定的方剂方向。缺这个入参时它的第一档（组成可核验为「X 加减」→
// 保留经典方名）不看 M03 锁的是哪张方，于是保留了一个与锁定方不一致的经典身份，
// 合同随即判 formula_direction_drift ⇒ 整方作废。线上实测：修掉「formulaNames 为空」那一类后，
// 剩余 9 次透明降级被拒里仍有 6 次是这个码。
assert.match(
  diagnosisApiSource,
  /markTransparentFormulaDeclassification\(\s*\n\s*authoritativeContent,\s*\n\s*opts\.structuredPriorReasoning,\s*\n\s*\),/,
  "透明降级必须接收 M03 已锁定方剂（opts.structuredPriorReasoning）——否则会保留与锁定方不一致的经典身份",
);
assert.match(
  diagnosisApiSource,
  /finalized = dropUnsupportedM04CandidateHerbs\(finalized, opts\.structuredPriorReasoning\);/,
  "正常 finalize 链路同样要做单味剔除——两条路径共用同一条不变量",
);
assert.equal(shouldRunTargetedStructuredRetry("diagnose", "sentinel_count_0_0"), true);
assert.equal(shouldRunTargetedStructuredRetry("diagnose", "json_invalid"), true);
assert.equal(shouldRunTargetedStructuredRetry("diagnose", "m03_primary_syndrome_unstable"), true);
assert.equal(shouldRunTargetedStructuredRetry("diagnose", "m03_therapy_method_unstable"), true);
assert.equal(shouldRunTargetedStructuredRetry("diagnose", "m03_location_classification_empty"), true);
assert.equal(shouldRunTargetedStructuredRetry("diagnose", "m03_nature_classification_empty"), true);
assert.equal(shouldRunTargetedStructuredRetry("diagnose", "m03_western_primary_ambiguous"), true);
assert.equal(shouldRunTargetedStructuredRetry("diagnose", "m03_western_primary_background_comorbidity"), true);
assert.equal(shouldRunTargetedStructuredRetry("diagnose", "m03_western_primary_duration_mismatch"), true);
assert.equal(shouldRunTargetedStructuredRetry("diagnose", "m03_generic_tcm_template"), true);
assert.equal(shouldRunTargetedStructuredRetry("diagnose", "m03_explanation_placeholder"), true);
assert.equal(shouldRunTargetedStructuredRetry("diagnose", "m03_uncertainty_state_mismatch"), true);
assert.equal(shouldRunTargetedStructuredRetry("diagnose", "m03_followup_safety_net_not_actionable"), true);
assert.equal(shouldRunTargetedStructuredRetry("diagnose", "m03_tcm_syndrome_current_fact_missing"), true);
assert.equal(shouldRunTargetedStructuredRetry("diagnose", "m03_pathogenesis_summary_qi_deficiency_drift"), true);
for (const reason of [
  "m03_western_clinical_rationale_missing",
  "m03_western_clinical_rationale_restatement",
  "m03_western_differential_analysis_missing",
  "m03_tcm_diagnostic_rationale_missing",
  "m03_tcm_diagnostic_rationale_restatement",
  "m03_discrimination_missing",
  "m03_tcm_differential_analysis_missing",
  "m03_single_evidence_location",
  "m03_nature_dimension_insufficient",
]) assert.equal(shouldRunTargetedStructuredRetry("diagnose", reason), true, `${reason} must reach the bounded analysis-field repair`);
for (const reason of [
  "m03_western_support_empty",
  "m03_western_support_tcm_pollution",
  "m03_western_support_demographic_padding",
  "m03_western_support_normal_vital_padding",
  "m03_western_support_nondiscriminating",
  "m03_western_support_historical_only",
  "m03_western_support_polarity_mismatch",
]) {
  assert.equal(isM03WesternSupportContractReason(reason), true, `${reason} belongs to the repairable western-support contract class`);
  assert.equal(shouldRunTargetedStructuredRetry("diagnose", reason), true, `${reason} must reach the bounded second repair`);
}
assert.equal(isM03WesternSupportContractReason("m03_western_support_unknown"), false);
assert.equal(shouldRunTargetedStructuredRetry("diagnose", "m03_primary_diagnosis_semantic_review"), true);
assert.equal(shouldRunTargetedStructuredRetry("diagnose", "m03_tcm_reasoning_semantic_review"), true);
assert.equal(shouldRunTargetedStructuredRetry("diagnose", "m03_formula_indication_semantic_review"), true);
assert.equal(shouldRunTargetedStructuredRetry("prescribe", "m04_clinical_semantic_review"), true);
assert.equal(
  shouldRunTargetedStructuredRetry("prescribe", "m04_formula_component_1_unverified"),
  true,
  "an independently failed combined-formula component must reach bounded composition repair",
);
for (const reason of [
  "m04_formula_composition_semantic_review",
  "m04_herb_plan_semantic_review",
  "m04_dose_rationale_semantic_review",
  "m04_patient_context_semantic_review",
]) assert.equal(shouldRunTargetedStructuredRetry("prescribe", reason), true, `${reason} must reach bounded prescription repair`);
for (const reason of [
  "m04_candidate_0_emperor_missing",
  "m04_candidate_0_emperor_excess",
  "m04_candidate_0_herb_2_emperor_not_primary",
  "m04_candidate_0_herb_2_emperor_knowledge_missing",
  "m04_candidate_0_herb_2_emperor_therapy_mismatch",
  "m04_candidate_0_herb_2_unknown",
  "m04_candidate_0_herb_2_dose_outside_conservative_range",
  "m04_candidate_0_herb_2_unsupported_high_impact_yang_warm",
  "m04_modification_1_herb_0_unsupported_high_impact_yang_warm",
]) assert.equal(shouldRunTargetedStructuredRetry("prescribe", reason), true, `${reason} has bounded deterministic repair guidance and must reach the second repair`);
const targetRefRepairHint = buildM04ClinicalRepairHint("m04_candidate_0_herb_2_target_ref_invalid");
assert.match(targetRefRepairHint, /现有 P1\/P2/);
assert.match(targetRefRepairHint, /targetPathogenesis 必须逐字等于/);
assert.match(
  diagnosisApiSource,
  /candidate\.decoction 必须是单个对象[\s\S]{0,500}?doseCount[\s\S]{0,250}?dosesPerDay[\s\S]{0,250}?administrationTimesPerDay[\s\S]{0,300}?三者都不得省略/,
  "the targeted M04 repair prompt must preserve every required regimen dimension",
);
assert.equal(shouldRunTargetedStructuredRetry("prescribe", "m04_candidate_0_high_risk_pair_incompatibility"), true, "high-risk pair conflicts receive one bounded repair attempt and remain fail-closed unless the repaired candidate passes the full safety contract");
assert.equal(shouldRunTargetedStructuredRetry("prescribe", "json_invalid"), true);
assert.equal(shouldRunTargetedStructuredRetry("prescribe", "sentinel_count_0_1"), true);
assert.equal(shouldRunTargetedStructuredRetry("prescribe", "structured_resolver_rejected"), true);
assert.equal(shouldRunTargetedStructuredRetry("diagnose", "provider_timeout"), false);
const repairHerbs = [
  { name: "香附", dose: "10g" },
  { name: "吴茱萸", dose: "9g" },
];
assert.deepEqual(
  m04CandidateHerbsFromRepairPayload({ formula: { candidates: [{ herbs: repairHerbs }] } }),
  repairHerbs,
  "first-round reasoning-v2 repair diagnostics must retain the candidate herbs",
);
assert.deepEqual(
  m04CandidateHerbsFromRepairPayload({ schemaVersion: "tcm-cdss-m04-proposal-v1", candidate: { herbs: repairHerbs } }),
  repairHerbs,
  "targeted proposal-v1 repair diagnostics must retain herb names and dose boundaries",
);
assert.deepEqual(
  m04CandidateHerbsFromRepairPayload({ schemaVersion: "tcm-cdss-m04-proposal-v1", candidate: JSON.stringify({ herbs: repairHerbs }) }),
  repairHerbs,
  "a normalized string-wrapped proposal candidate must retain its herbs for repair diagnostics",
);
const rejectedDoseProposal = {
  schemaVersion: "tcm-cdss-m04-proposal-v1",
  candidate: {
    name: "本例辨证组方",
    herbs: [
      { name: "黄连", dose: "12g", role: "君" },
      { name: "吴茱萸", dose: "2g", role: "佐" },
      { name: "甘草", dose: "3g", role: "使" },
    ],
    decoction: { doseCount: "5剂", dosesPerDay: 1, administrationTimesPerDay: 2 },
  },
  patentAndWestern: [],
  modifications: [],
  nonPharma: { diet: "清淡饮食", lifestyle: "规律作息", emotion: "调畅情志", acupointCare: null, tcmTreatments: [], monitoring: [] },
};
assert.equal(m04DoseRepairHerbIndex("m04_candidate_0_herb_3_dose_outside_conservative_range"), 3);
assert.equal(m04DoseRepairHerbIndex("m04_candidate_0_herb_3_dose_sanity_ceiling"), 3);
assert.equal(m04DoseRepairHerbIndex("m04_candidate_1_herb_3_dose_sanity_ceiling"), undefined, "only the compiled primary candidate is eligible for field stabilization");
assert.equal(m04DoseRepairHerbIndex("m04_candidate_0_herb_3_unknown"), undefined);
const driftingDoseRepair = structuredClone(rejectedDoseProposal);
driftingDoseRepair.candidate.herbs[0].dose = "5g";
driftingDoseRepair.candidate.herbs[1].dose = "9g";
driftingDoseRepair.candidate.herbs[2].role = "臣";
driftingDoseRepair.candidate.decoction.doseCount = "7剂";
const stabilizedDoseRepair = JSON.parse(stabilizeM04DoseOnlyRepair(
  JSON.stringify(rejectedDoseProposal),
  JSON.stringify(driftingDoseRepair),
  "m04_candidate_0_herb_0_dose_outside_conservative_range",
));
assert.equal(stabilizedDoseRepair.candidate.herbs[0].dose, "5g", "the model-selected target dose is retained");
assert.equal(stabilizedDoseRepair.candidate.herbs[1].dose, "2g", "another herb dose cannot drift during a dose-only repair");
assert.equal(stabilizedDoseRepair.candidate.herbs[2].role, "使", "roles cannot drift during a dose-only repair");
assert.equal(stabilizedDoseRepair.candidate.decoction.doseCount, "5剂", "regimen fields cannot drift during a dose-only repair");
const stabilizedSanityCeilingRepair = JSON.parse(stabilizeM04DoseOnlyRepair(
  JSON.stringify(rejectedDoseProposal),
  JSON.stringify(driftingDoseRepair),
  "m04_candidate_0_herb_0_dose_sanity_ceiling",
));
assert.equal(stabilizedSanityCeilingRepair.candidate.herbs[0].dose, "5g", "sanity-ceiling repair keeps only the corrected target dose");
assert.equal(stabilizedSanityCeilingRepair.candidate.herbs[1].dose, "2g", "sanity-ceiling repair cannot redraw another herb");
assert.equal(stabilizedSanityCeilingRepair.candidate.name, rejectedDoseProposal.candidate.name, "sanity-ceiling repair cannot redraw formula identity");
assert.equal(stabilizeM04DoseOnlyRepair(
  JSON.stringify({ schemaVersion: "tcm-cdss-reasoning-v2", formula: { candidates: [{ herbs: repairHerbs }] } }),
  JSON.stringify(driftingDoseRepair),
  "m04_candidate_0_herb_0_dose_outside_conservative_range",
), undefined, "compiled reasoning must return through the proposal compiler rather than being rewritten in place");
const modificationPrior = {
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "diagnose",
  overview: { overallTherapy: "行气活血，舒筋通络" },
  therapy: { overallPrinciple: "行气活血，舒筋通络" },
  pathogenesis: { chain: [{ nodeId: "P1", pathogenesis: "气滞血瘀，经络痹阻", therapyDirection: "行气活血，舒筋通络" }] },
};
const fullM04WithMixedModifications = {
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "prescribe",
  formula: {
    candidates: [{ name: "本例辨证组方", herbs: [{ name: "川芎", dose: "6g" }] }],
    modifications: [
      { trigger: "复诊时疼痛加重", targetPathogenesis: "气滞血瘀", action: "加桃仁", reason: "加强活血" },
      { trigger: "复诊时仍僵硬", targetPathogenesis: "经络痹阻", action: "建议加附子", reason: "温阳散寒" },
      { trigger: "复诊时疼痛减轻", targetPathogenesis: "气滞血瘀", action: "减川芎", reason: "随证调整" },
    ],
  },
};
const mixedContent = `可见正文\n<!-- DIAGNOSIS_JSON_START -->\n${JSON.stringify(fullM04WithMixedModifications)}\n<!-- DIAGNOSIS_JSON_END -->`;
const sanitizedModifications = JSON.parse(
  dropUnsupportedM04ModificationDirections(mixedContent, modificationPrior)
    .split("<!-- DIAGNOSIS_JSON_START -->")[1]
    .split("<!-- DIAGNOSIS_JSON_END -->")[0],
).formula.modifications;
assert.deepEqual(
  sanitizedModifications.map((item) => item.action),
  ["加桃仁", "减川芎"],
  "every unsupported high-impact optional addition is removed while aligned additions and non-add actions remain",
);
assert.equal(
  dropUnsupportedM04ModificationDirections("no structured content", modificationPrior),
  "no structured content",
  "non-structured fallbacks remain byte-exact",
);
for (const reason of [
  "m04_candidate_0_emperor_missing",
  "m04_candidate_0_emperor_excess",
  "m04_candidate_0_herb_2_emperor_not_primary",
]) {
  const emperorRepairHint = buildM04ClinicalRepairHint(reason);
  assert.match(emperorRepairHint, /恰有 1–2 味君药/);
  assert.match(emperorRepairHint, /targetKind=pathogenesis_node、targetRef=P1/);
  assert.match(emperorRepairHint, /不得新增患者事实、药味或病机节点/);
}
const formulaCompositionRepairHint = buildM04ClinicalRepairHint("m04_formula_reference_declassified");
assert.match(formulaCompositionRepairHint, /不重不漏地纳入.*ingredients/s);
assert.match(formulaCompositionRepairHint, /恰有 1–2 味君药/);
assert.match(formulaCompositionRepairHint, /不得按药味顺序机械指定君药/);
const combinedFormulaRepairHint = buildM04ClinicalRepairHint("m04_formula_component_1_unverified");
assert.match(combinedFormulaRepairHint, /每个基础方都必须分别满足自己的基准/);
assert.match(combinedFormulaRepairHint, /另一个基础方即使已经命中，也不能替它提供方名或出处/);
const modificationRepairHint = buildM04ClinicalRepairHint("m04_modification_1_herb_0_unsupported_high_impact_yang_warm");
assert.match(modificationRepairHint, /删除整条不受支持的条件性加减/);
assert.match(modificationRepairHint, /modifications 允许为空/);
assert.deepEqual(parseM03DiagnosticReview('{"status":"accepted","issueCode":"none"}'), { status: "accepted", issueCode: "none" });
assert.deepEqual(parseM03DiagnosticReview('{"status":"repair","issueCode":"criteria_not_met"}'), { status: "repair", issueCode: "criteria_not_met" });
assert.deepEqual(parseM03DiagnosticReview('{"status":"repair","issueCode":"formula_indication_mismatch"}'), { status: "repair", issueCode: "formula_indication_mismatch" });
assert.deepEqual(parseM03DiagnosticReview('```json\n{"status":"accepted","issueCode":"none"}\n```'), { status: "accepted", issueCode: "none" }, "gateway code fences do not turn a valid reviewer decision into unavailable");
assert.deepEqual(parseM03DiagnosticReview('{"status":"accepted","issueCode":"criteria_not_met"}'), { status: "unavailable", issueCode: "review_unavailable" });
const m03ReviewPrompt = buildM03DiagnosticReviewPrompt(
  "稀便半个月，无腹痛",
  { westernDiagnosis: { primary: { name: "IBS-D" } } },
  "[EVID-GUIDE-001] 慢性腹泻诊断标准摘要",
);
assert.match(m03ReviewPrompt, /病程阈值[\s\S]*必备核心症状[\s\S]*症状性工作诊断[\s\S]*不得把尚未满足标准的病因[\s\S]*临床闭环[\s\S]*不得使用.*功能失调候[\s\S]*病机节点不得留空[\s\S]*命名方.*核心适应证/);
assert.match(m03ReviewPrompt, /患者事实边界：稀便半个月，无腹痛[\s\S]*本轮可用证据[\s\S]*绝不能当作患者事实[\s\S]*EVID-GUIDE-001/);
assert.deepEqual(parseM04ClinicalReview('{"status":"accepted","issueCode":"none"}'), { status: "accepted", issueCode: "none" });
assert.deepEqual(parseM04ClinicalReview('{"status":"repair","issueCode":"herb_plan_mismatch"}'), { status: "repair", issueCode: "herb_plan_mismatch" });
const classicCompositionReview = {
  status: "repair",
  issueCode: "formula_composition_mismatch",
  repairFocus: "formula_core_composition",
  candidateIndex: 0,
  implicatedHerbs: [],
};
assert.deepEqual(
  constrainM04ClinicalReviewScope(
    classicCompositionReview,
    { overview: { recommendedFormulaNames: [], formulaSelectionMode: "self_devised" } },
    { formula: { candidates: [{ name: "本例辨证组方", formulaNames: [], constructionType: "self_devised", herbs: [] }] } },
  ),
  { status: "accepted", issueCode: "none" },
  "a reviewer cannot impose a classic-formula composition contract on a fully self-devised M03/M04 chain",
);
assert.deepEqual(
  constrainM04ClinicalReviewScope(
    classicCompositionReview,
    { overview: { recommendedFormulaNames: ["痛泻要方"], formulaSelectionMode: "single" } },
    { formula: { candidates: [{ name: "痛泻要方加减", formulaNames: ["痛泻要方"], constructionType: "single_base", herbs: [] }] } },
  ),
  classicCompositionReview,
  "a named-formula composition concern remains blocking and repairable",
);
assert.match(
  buildM04ClinicalReviewPrompt("", { overview: { formulaSelectionMode: "self_devised" } }, { formula: { candidates: [] } }),
  /formula_composition_mismatch 只适用于 M03 或 M04 明确声称了命名方身份/,
  "the reviewer prompt must preserve the same issue-domain boundary enforced by the server",
);
const focusedM04Repair = parseM04ClinicalReview('{"status":"repair","issueCode":"herb_plan_mismatch","repairFocus":"emperor_role","candidateIndex":0,"implicatedHerbs":["山药","山药","不存在药"]}');
assert.deepEqual(focusedM04Repair, {
  status: "repair",
  issueCode: "herb_plan_mismatch",
  repairFocus: "emperor_role",
  candidateIndex: 0,
  implicatedHerbs: ["山药", "不存在药"],
});
assert.match(m04ClinicalRepairGuidance(focusedM04Repair, {
  formula: { candidates: [{ herbs: [{ name: "山药" }, { name: "茯苓" }] }] },
}), /候选 1[\s\S]*emperor_role[\s\S]*山药/);
assert.match(m04ClinicalRepairGuidance(focusedM04Repair, {
  formula: { candidates: [{ herbs: [{ name: "山药" }, { name: "茯苓" }] }] },
}), /山药[^\n]*不得继续标为君药[\s\S]*直接覆盖 P1[\s\S]*知识库已覆盖/);
assert.doesNotMatch(m04ClinicalRepairGuidance(focusedM04Repair, {
  formula: { candidates: [{ herbs: [{ name: "山药" }, { name: "茯苓" }] }] },
}), /不存在药/);
assert.deepEqual(
  parseM04ClinicalReview('{"status":"repair","issueCode":"dose_rationale_concern","repairFocus":"emperor_role","candidateIndex":9,"implicatedHerbs":[42]}'),
  { status: "repair", issueCode: "dose_rationale_concern", implicatedHerbs: [] },
  "issue-incompatible focus, out-of-range candidate and non-string herb coordinates are discarded",
);
assert.deepEqual(parseM04ClinicalReview('复核结果：{"status":"repair","issueCode":"dose_rationale_concern"}'), { status: "repair", issueCode: "dose_rationale_concern" }, "bounded transport prose is tolerated while enum values stay strict");
assert.deepEqual(parseM04ClinicalReview('{"status":"repair","issueCode":"unknown"}'), { status: "unavailable", issueCode: "review_unavailable" });
assert.equal(m04ClinicalReviewRequiresNonDoseFallback({ status: "unavailable", issueCode: "review_unavailable" }), true, "M04 reviewer unavailable must select the server-owned non-dose fallback");
assert.equal(m04ClinicalReviewRequiresNonDoseFallback({ status: "repair", issueCode: "patient_context_mismatch" }), false, "repair_demanded remains on the existing repair and re-review path");
assert.equal(m04ClinicalReviewRequiresNonDoseFallback({ status: "accepted", issueCode: "none" }), false);
const emperorDispute = { status: "repair", issueCode: "herb_plan_mismatch", repairFocus: "emperor_role", candidateIndex: 0, implicatedHerbs: ["枳壳"] };
assert.equal(m04ClinicalReviewNeedsAdjudication(emperorDispute), true);
assert.equal(m04ClinicalReviewNeedsAdjudication({ status: "repair", issueCode: "herb_plan_mismatch", repairFocus: "herb_direction" }), false);
assert.match(
  buildM04ClinicalReviewAdjudicationPrompt("反酸", { pathogenesis: { chain: [{ nodeId: "P1", therapyDirection: "和胃降逆" }] } }, { formula: { candidates: [{ herbs: [{ name: "枳壳", role: "君", targetRef: "P1", function: "理气宽中" }] }] } }, "", emperorDispute),
  /不得盲从[\s\S]*不得仅因自己偏好[\s\S]*知识库功用确实直接覆盖 P1[\s\S]*必须 accepted/,
);
const m04ReviewPrompt = buildM04ClinicalReviewPrompt(
  "稀便半个月，无腹痛",
  { overview: { primarySyndrome: "脾虚湿困" } },
  { formula: { candidates: [{ name: "痛泻要方加减" }] } },
  "[EVID-LITERATURE-001] 方剂适应证摘要",
);
assert.match(m04ReviewPrompt, /外部合理用药审方/);
assert.match(m04ReviewPrompt, /实际药味组成[\s\S]*不得用患者未提供/);
assert.match(m04ReviewPrompt, /本轮可用证据[\s\S]*绝不能当作患者事实[\s\S]*EVID-LITERATURE-001/);
assert.match(m04ReviewPrompt, /对重要未知状态保持保守鲁棒/);
assert.match(m04ReviewPrompt, /不得用一句.*采纳前复核.*掩盖/);
assert.match(m04ReviewPrompt, /慢性肾病3-5期[\s\S]*抗凝\/抗血小板[\s\S]*概念示例而非封闭关键词表/);
assert.match(m04ReviewPrompt, /1–2 味并列君药均为合法结构[\s\S]*一味或两味君药已直接覆盖 P1 中心治法[\s\S]*偏好单君药/);
assert.match(m04ReviewPrompt, /targetPathogenesis、function 与 prescriptionRole[\s\S]*不能因投影缺少自由文本解释而推定角色不成立/);
assert.match(m04ReviewPrompt, /modifications 空数组是合法的保守方案[\s\S]*不得仅因没有加减而要求 repair/);
assert.match(m04ReviewPrompt, /repairFocus[\s\S]*candidateIndex[\s\S]*implicatedHerbs[\s\S]*不得输出自由文本修复指令/);

assert.equal(parseOpenAICompatCompletionPayload('{"choices":[{"message":{"content":"完整结果"},"finish_reason":"stop"}]}')?.choices?.[0]?.message?.content, "完整结果");
assert.equal(parseOpenAICompatCompletionPayload([
  'data: {"choices":[{"delta":{"content":"完整"},"finish_reason":null}]}',
  'data: {"choices":[{"delta":{"content":"结果"},"finish_reason":"stop"}]}',
  "data: [DONE]",
].join("\n"))?.choices?.[0]?.message?.content, "完整结果");
assert.equal(parseOpenAICompatCompletionPayload("not-json-or-sse"), null);
const protectedHerbTable = enforceReviewedPrescriptionOutput([
  "| 药名 | 炮制/规格 | 剂量 |",
  "|---|---|---|",
  "| 山药 | 饮片 | 15g |",
  "| 茯苓 | 饮片 | 15g |",
  "另建议阿司匹林片每日1片。",
].join("\n"));
assert.match(protectedHerbTable, /\| 山药 \| 饮片 \| 15g \|/);
assert.match(protectedHerbTable, /\| 茯苓 \| 饮片 \| 15g \|/);
assert.doesNotMatch(protectedHerbTable, /阿司匹林片每日1片/);
assert.match(protectedHerbTable, /移至西药\/中成药候选区独立审方后另行评估/);
const sanitizedMixedMedicationNarrative = enforceReviewedPrescriptionOutput("可配合生活方式干预。另建议二甲双胍片口服，每日2次。");
assert.doesNotMatch(sanitizedMixedMedicationNarrative, /二甲双胍片|每日2次/);
assert.match(sanitizedMixedMedicationNarrative, /移至西药\/中成药候选区独立审方后另行评估/);
const sanitizedNonHerbTable = enforceReviewedPrescriptionOutput([
  "| 触发条件 | 建议用药 | 剂量 |",
  "|---|---|---|",
  "| 胸痛 | 阿司匹林肠溶片 | 每日1片 |",
].join("\n"));
assert.doesNotMatch(sanitizedNonHerbTable, /阿司匹林肠溶片|每日1片/);
assert.match(sanitizedNonHerbTable, /独立审方后另行评估/);
const sanitizedDisguisedHerbRow = enforceReviewedPrescriptionOutput([
  "| 药名 | 炮制/规格 | 剂量 |",
  "|---|---|---|",
  "| 阿司匹林肠溶片 | 100mg | 每日1片 |",
  "| 茯苓 | 饮片 | 15g |",
].join("\n"));
assert.doesNotMatch(sanitizedDisguisedHerbRow, /阿司匹林肠溶片|100mg|每日1片/);
assert.match(sanitizedDisguisedHerbRow, /\| 茯苓 \| 饮片 \| 15g \|/);
const prescriptionJsonWithConcreteMedicineUsage = {
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "prescribe",
  formula: {
    candidates: [{ name: "本例辨证组方", herbs: [{ name: "茯苓", dose: "15g" }] }],
    patentAndWestern: [{ name: "示例片", usageBoundary: "口服，每日2次，由医生按说明书复核" }],
  },
};
const protectedPrescriptionJson = enforceReviewedPrescriptionOutput([
  "## 候选方药",
  "中药饮片方案见下表。",
  "<!-- DIAGNOSIS_JSON_START -->",
  JSON.stringify(prescriptionJsonWithConcreteMedicineUsage, null, 2),
  "<!-- DIAGNOSIS_JSON_END -->",
].join("\n"));
const protectedPrescriptionJsonText = protectedPrescriptionJson
  .split("<!-- DIAGNOSIS_JSON_START -->")[1]
  .split("<!-- DIAGNOSIS_JSON_END -->")[0]
  .trim();
assert.deepEqual(
  JSON.parse(protectedPrescriptionJsonText),
  prescriptionJsonWithConcreteMedicineUsage,
  "narrative medication cleanup must never corrupt the validated M04 JSON block",
);
assert.equal(normalizePrescriptionRole("臣兼佐"), "臣");
assert.equal(normalizePrescriptionRole("佐、使"), "佐");
assert.equal(normalizePrescriptionRole("主要治疗"), "主要治疗");
assert.equal(normalizeWesternDiagnosisStatus("疑似"), "考虑");
assert.equal(normalizeWesternDiagnosisStatus("优先排除"), "需排除");
assert.equal(normalizeWesternDiagnosisStatus("尚不明确"), "证据有限");
assert.equal(normalizeWesternDiagnosisStatus("unexpected-provider-value"), "证据有限");
assert.equal(normalizeWesternDiagnosisStatus("不考虑"), "证据有限");
assert.equal(normalizeClinicalConfidence("较高"), "高");
assert.equal(normalizeClinicalConfidence("中等"), "中");
assert.equal(normalizeClinicalConfidence("待评估"), "低");
assert.equal(normalizeClinicalConfidence("不高"), "低");
// 兜底措辞在 2026-08-05 换过一次(甲方 7.1)。旧句「佐药配伍定位：承接“X”的组方目标」
// 与新句都出现在**知识库没有该药功效条目**时,但旧句读起来像给出了方义,实际什么都没说;
// 新句明说「具体配伍作用需医生结合方义复核」,把不确定性交还给医生。
// 判据只钉方向,不钉措辞:必须带角色、必须带所绑定的病机、必须显式声明需医生复核。
{
  const fallback = getTcmHerbFunctionDisplayText("神曲", "佐", "脾气亏虚，运化失司");
  assert.match(fallback, /^佐药/, "兜底句必须标明君臣佐使角色");
  assert.match(fallback, /需医生结合方义复核/, "说不出该药在本方的作用时必须显式交还医生,不得写成像给出了方义");
  // 病机原文不得嵌进兜底句:药味表里病机另有独立一列,嵌进来会让同一句病机在一节里
  // 印上七遍(实测触发 test:visible-output-hygiene),与甲方抱怨的冗余是同一类。
  assert.doesNotMatch(fallback, /脾气亏虚，运化失司/, "兜底句不得嵌入病机原文");
}

const valid = {
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "diagnose",
  overview: { primarySyndrome: "心脾两虚" },
};
const startMarker = "<!-- DIAGNOSIS_JSON_START -->";
const endMarker = "<!-- DIAGNOSIS_JSON_END -->";
const m03WithUnauthorizedFormula = `${startMarker}\n${JSON.stringify({ ...valid, formula: { candidates: [{ name: "归脾汤", herbs: [{ name: "酸枣仁", dose: "15g" }] }] } })}\n${endMarker}`;
const ownedM03 = enforceStructuredStageOwnership(m03WithUnauthorizedFormula, "diagnose");
assert.equal(JSON.parse(ownedM03.split(startMarker)[1].split(endMarker)[0].trim()).formula, null);
assert.equal(enforceStructuredStageOwnership(m03WithUnauthorizedFormula, "prescribe"), m03WithUnauthorizedFormula);

const priorOwnedSections = {
  stage: "diagnose",
  completeness: { level: "C" },
  overview: { primarySyndrome: "寒凝肝脉证", overallPathogenesis: "寒凝肝脉，经脉拘急" },
  westernDiagnosis: { primary: { name: "腹股沟痛" } },
  pathogenesis: { chain: [{ nodeId: "P1", pathogenesis: "寒凝肝脉，经脉拘急" }] },
  therapy: { overallPrinciple: "温散寒邪", overallMethod: "暖肝散寒，理气止痛" },
  lineageAdaptation: null,
  management: { mustCollect: [], followupSafetyNet: "症状加重时复诊" },
};
const driftedM04 = `${startMarker}\n${JSON.stringify({
  stage: "prescribe",
  completeness: { level: "A" },
  overview: { primarySyndrome: "脾肾阳虚证", overallPathogenesis: "脾肾阳虚" },
  westernDiagnosis: { primary: { name: "其他诊断" } },
  pathogenesis: { chain: [{ nodeId: "P9", pathogenesis: "其他病机" }] },
  therapy: { overallPrinciple: "补益", overallMethod: "温补脾肾" },
  lineageAdaptation: { lineageCode: "fake" },
  management: { mustCollect: ["被改写"] },
  formula: { candidates: [{ name: "本例辨证组方" }] },
})}\n${endMarker}`;
const reboundM04Text = enforceM04PriorStageOwnership(driftedM04, priorOwnedSections);
const reboundM04 = JSON.parse(reboundM04Text.split(startMarker)[1].split(endMarker)[0].trim());
for (const key of ["completeness", "overview", "westernDiagnosis", "pathogenesis", "therapy", "lineageAdaptation", "management"]) {
  assert.deepEqual(reboundM04[key], priorOwnedSections[key], `M04 must restore the signed M03-owned ${key} section byte-semantically`);
}
assert.deepEqual(reboundM04.formula, { candidates: [{ name: "本例辨证组方" }] }, "M04-owned formula content survives the ownership rebind");
const syncReasoning = {
  schemaVersion: "tcm-cdss-reasoning-v2",
  stage: "diagnose",
  overview: {
    primarySyndrome: "心脾两虚证",
    overallPathogenesis: "脾气虚弱，心血不足，心神失养",
    overallTherapy: "健脾益气，养血安神",
    recommendedFormulaDirection: "归脾汤加减方向",
    evidence: { evidenceLevel: "model_inference", source: "本例资料", confidence: "中" },
  },
  pathogenesis: {
    summary: "心脾两虚",
    locationDifferentiation: { items: ["心", "脾"], evidence: { evidenceLevel: "model_inference", source: "本例资料" } },
    natureDifferentiation: { items: ["虚"], evidence: { evidenceLevel: "model_inference", source: "本例资料" } },
    chain: [],
    uncertainties: [],
  },
  therapy: { overallPrinciple: "健脾益气，养血安神", subTherapies: [] },
  formula: null,
  nonPharma: null,
  lineageAdaptation: null,
};
const normalizedWithoutWesternDiagnosis = normalizeReasoningV2(syncReasoning);
assert.equal(normalizedWithoutWesternDiagnosis?.stage, "diagnose", "a malformed or missing Western diagnosis block must not discard the TCM reasoning contract");
assert.equal(normalizedWithoutWesternDiagnosis?.westernDiagnosis.primary.status, "证据有限");
assert.equal(normalizedWithoutWesternDiagnosis?.overview.primarySyndrome, "心脾两虚证");
const driftedVisible = [
  "## 中医证候诊断",
  "**证候诊断**：脾虚证",
  "## 总体病机",
  "**核心病机**：脾虚不运",
  "## 治法框架",
  "**总治法**：单纯健脾",
  startMarker,
  JSON.stringify(syncReasoning),
  endMarker,
].join("\n");
const synchronizedVisible = synchronizeVisibleClinicalSummary(driftedVisible, "diagnose");
assert.match(synchronizedVisible, /\*\*证型\*\*：心脾两虚证/);
assert.match(synchronizedVisible, /\*\*总体病机\*\*：脾气虚弱，心血不足，心神失养/);
assert.match(synchronizedVisible, /\*\*总治法\*\*：健脾益气，养血安神/);
assert.equal(synchronizedVisible.slice(synchronizedVisible.indexOf(startMarker)), driftedVisible.slice(driftedVisible.indexOf(startMarker)));
assert.doesNotMatch(synchronizeVisibleClinicalSummary(driftedVisible.replace("## 治法框架", "| 辨证 | 痰热内扰 | 清热化痰 |\n## 治法框架"), "diagnose"), /痰热内扰|清热化痰/);
assert.equal(synchronizeVisibleClinicalSummary(driftedVisible.replace(endMarker, ""), "diagnose"), driftedVisible.replace(endMarker, ""));
assert.equal(synchronizeVisibleClinicalSummary(driftedVisible, "prescribe"), driftedVisible);
const paraphrasedFactReasoning = {
  ...syncReasoning,
  pathogenesis: {
    ...syncReasoning.pathogenesis,
    chain: [{
      nodeId: "P1",
      patientFact: "晨起神疲、纳差便溏",
      syndromeEvidence: "晨起神疲、纳差便溏",
      pathogenesis: "脾气虚弱，运化失健",
      therapyDirection: "健脾益气",
    }],
  },
};
const groundedFactContent = groundStructuredPatientFacts([
  "## 病机链",
  startMarker,
  JSON.stringify(paraphrasedFactReasoning),
  endMarker,
].join("\n"), "晨起疲乏；食欲欠佳；大便溏薄");
const groundedFactJson = JSON.parse(groundedFactContent.split(startMarker)[1].split(endMarker)[0].trim());
assert.equal(groundedFactJson.pathogenesis.chain[0].patientFact, "晨起疲乏；食欲欠佳；大便溏薄");
const transformedPolarityDrift = [
  "## 已净化展示",
  startMarker,
  JSON.stringify({
    ...syncReasoning,
    pathogenesis: {
      ...syncReasoning.pathogenesis,
      chain: syncReasoning.pathogenesis.chain.map((node) => ({ ...node, patientFact: "发热" })),
    },
  }),
  endMarker,
].join("\n");
const acceptedGroundedContent = ["## 原始已验证结果", startMarker, JSON.stringify(syncReasoning), endMarker].join("\n");
const restoredPolarity = restoreValidatedM03Chain(transformedPolarityDrift, acceptedGroundedContent);
const restoredPolarityJson = JSON.parse(restoredPolarity.split(startMarker)[1].split(endMarker)[0].trim());
assert.deepEqual(
  restoredPolarityJson.pathogenesis.chain,
  syncReasoning.pathogenesis.chain,
  "customer-output transforms must not replace a server-validated patient fact with opposite polarity",
);
const prescribeReasoning = {
  ...syncReasoning,
  stage: "prescribe",
  formula: { candidates: [{
    name: "归脾汤加减",
    herbs: [
      { name: "酸枣仁", processing: "炒", decoctionRequirement: "捣碎后同煎", dose: "15g", role: "君", prescriptionRole: "养心安神", targetPathogenesis: "心血不足", function: "养血安神" },
      { name: "炙甘草", processing: null, decoctionRequirement: null, dose: "6g", role: "使", prescriptionRole: "调和诸药", targetPathogenesis: "调和诸药", function: "益气和中" },
      { name: "大枣", processing: null, decoctionRequirement: null, dose: "3枚", role: "佐", prescriptionRole: "补益脾胃", targetPathogenesis: "脾气虚弱", function: "益气养血" },
    ],
    decoction: {
      doseCount: "5剂",
      dosesPerDay: 1,
      administrationTimesPerDay: 2,
      method: "每日1剂，冷水浸泡30分钟，煎煮2次，合并药液约400mL，每日分2次服",
      course: "5日",
      followUpNode: "5日复诊",
    },
  }], modifications: [{ action: "加黄芩9g", doseOrHandling: "9g" }] },
};
const driftedPrescription = [
  "**总体病机**：脾虚",
  "**总治法**：健脾",
  "**剂数**：3剂",
  "**煎服法**：水煎服",
  "**疗程建议**：3日",
  "| 药名 | 剂量 |",
  "|---|---|",
  "| 酸枣仁 | 10g |",
  startMarker,
  JSON.stringify(prescribeReasoning),
  endMarker,
].join("\n");
const synchronizedPrescription = synchronizeVisibleClinicalSummary(driftedPrescription, "prescribe");
assert.match(synchronizedPrescription, /\*\*煎服法\*\*：每日1剂，冷水浸泡30分钟，煎煮2次，合并药液约400mL，每日分2次服/);
// 需求5：处方展示面不再出现复诊节点。
assert.match(synchronizedPrescription, /\*\*疗程建议\*\*：5日(?!；首次复诊)/);
assert.doesNotMatch(synchronizedPrescription, /首次复诊/, "处方展示区不再出现复诊小节");
// 但字段本身必须保留——它是 rxaudit 提交门、HIS 导出与 M05 首次复诊时间的唯一数据源，
// 删字段就是 fail-open。这条断言防止后人把「不展示」误做成「不生成」。
assert.match(
  JSON.stringify(prescribeReasoning.formula.candidates[0].decoction || {}),
  /followUpNode/,
  "followUpNode 必须继续生成：处方只是不再展示它，审方/HIS/M05 仍然消费它",
);
assert.match(synchronizedPrescription, /\| 1 \| 酸枣仁 \| 炒；捣碎后同煎 \| 15g \|/);
assert.match(synchronizedPrescription, /\| 2 \| 炙甘草 \| 饮片 \| 6g \|/);
assert.doesNotMatch(synchronizedPrescription, /\| 酸枣仁 \| 10g \|/);
assert.doesNotMatch(synchronizeVisibleClinicalSummary(driftedPrescription.replace(startMarker, "口苦时加黄芩9g。\n" + startMarker), "prescribe"), /口苦时加黄芩9g/);
assert.match(synchronizedPrescription, /# 候选方药\s+## 归脾汤加减/);
assert.doesNotMatch(synchronizedPrescription, /\*\*\*\*|对应病机：；/, "incomplete legacy modification rows must be omitted from the visible report");
const adultDecoction = applyDeterministicDecoctionMethod(driftedPrescription, "年龄：46岁");
const adultDecoctionJson = JSON.parse(adultDecoction.split(startMarker)[1].split(endMarker)[0].trim());
assert.match(adultDecoctionJson.formula.candidates[0].decoction.method, /约500mL/);
const childDecoction = applyDeterministicDecoctionMethod(driftedPrescription, "年龄：8岁");
const childDecoctionJson = JSON.parse(childDecoction.split(startMarker)[1].split(endMarker)[0].trim());
assert.match(childDecoctionJson.formula.candidates[0].decoction.method, /约200mL/);
const adolescentDecoction = applyDeterministicDecoctionMethod(driftedPrescription, "年龄：17岁");
const adolescentDecoctionJson = JSON.parse(adolescentDecoction.split(startMarker)[1].split(endMarker)[0].trim());
assert.match(adolescentDecoctionJson.formula.candidates[0].decoction.method, /约200mL/);
const structuredAgeDecoction = applyDeterministicDecoctionMethod(driftedPrescription, "主诉：咳嗽3天", 8);
const structuredAgeDecoctionJson = JSON.parse(structuredAgeDecoction.split(startMarker)[1].split(endMarker)[0].trim());
assert.match(structuredAgeDecoctionJson.formula.candidates[0].decoction.method, /约200mL/, "structured age owns pediatric volume without relying on prose formatting");
for (const [label, clinicalContext, structuredAge] of [
  ["newborn zero age", "主诉：出生后黄疸", 0],
  ["month age", "患者6月龄，反复湿疹", undefined],
  ["combined year-month age", "患者1岁6个月，反复咳嗽", undefined],
  ["decimal year age", "年龄：1.5岁", undefined],
]) {
  const pediatricContent = applyDeterministicDecoctionMethod(driftedPrescription, clinicalContext, structuredAge);
  const pediatricJson = JSON.parse(pediatricContent.split(startMarker)[1].split(endMarker)[0].trim());
  assert.match(pediatricJson.formula.candidates[0].decoction.method, /约200mL/, `${label} keeps the pediatric decoction boundary`);
}
const caregiverContextDecoction = applyDeterministicDecoctionMethod(driftedPrescription, "患者为成年人，近期照顾5岁患儿，自己入睡困难");
const caregiverContextJson = JSON.parse(caregiverContextDecoction.split(startMarker)[1].split(endMarker)[0].trim());
assert.match(caregiverContextJson.formula.candidates[0].decoction.method, /约500mL/, "a related child's age cannot change the adult patient's decoction volume");
const canonicalFunctionContent = applyDeterministicHerbFunctions(driftedPrescription.replace("养血安神", "美容养颜"));
const canonicalFunctionJson = JSON.parse(canonicalFunctionContent.split(startMarker)[1].split(endMarker)[0].trim());
assert.match(canonicalFunctionJson.formula.candidates[0].herbs[0].function, /安神/);
assert.doesNotMatch(canonicalFunctionJson.formula.candidates[0].herbs[0].function, /美容养颜/);
const repaired = repairCompletedStructuredSentinel(
  `## 中医证候诊断\n心脾两虚\n\n${startMarker}\n${JSON.stringify(valid)}`,
  "diagnose",
);
assert.match(repaired || "", /DIAGNOSIS_JSON_END/);
assert.match(repaired || "", /心脾两虚/);
assert.equal(repairCompletedStructuredSentinel(`${startMarker}\n{\"schemaVersion\":`, "diagnose"), undefined);
assert.equal(repairCompletedStructuredSentinel(JSON.stringify(valid), "diagnose"), undefined);
assert.equal(repairCompletedStructuredSentinel(`${startMarker}\n${JSON.stringify({ ...valid, stage: "prescribe" })}`, "diagnose"), undefined);
assert.equal(repairCompletedStructuredSentinel(`${startMarker}\njunk\n${JSON.stringify(valid)}`, "diagnose"), undefined);
assert.equal(repairCompletedStructuredSentinel(`${startMarker}\n${JSON.stringify(valid)}\nSECOND_RESULT_TRUNCATED {`, "diagnose"), undefined);
assert.equal(repairCompletedStructuredSentinel(`${startMarker}\n{}\n${startMarker}\n${JSON.stringify(valid)}`, "diagnose"), undefined);

const unsupportedSparseM03 = `${startMarker}\n${JSON.stringify({
  ...syncReasoning,
  overview: { ...syncReasoning.overview, primarySyndrome: "痰热扰心证", overallPathogenesis: "痰热扰心", overallTherapy: "清热化痰" },
  pathogenesis: { ...syncReasoning.pathogenesis, chain: [] },
  therapy: { ...syncReasoning.therapy, overallPrinciple: "清热化痰", overallMethod: "清热化痰" },
})}\n${endMarker}`;
const sparseSanitized = normalizeDiagnoseConfidenceAndLabels(
  sanitizeOptionalPathogenesisClassifications(unsupportedSparseM03, "主诉：入睡困难2周"),
  "主诉：入睡困难2周",
);
const sparseSanitizedJson = JSON.parse(sparseSanitized.split(startMarker)[1].split(endMarker)[0].trim());
assert.equal(sparseSanitizedJson.pathogenesis.chain.length, 0, "a sparse model conclusion must remain incomplete until model repair or independent review supplies a grounded chain");
assert.equal(sparseSanitizedJson.overview.primarySyndromeResolution, "bounded", "an uncorroborated syndrome must remain an explicitly bounded working conclusion");
assert.match(sparseSanitizedJson.overview.primarySyndromeResolutionReason, /0条.*可逐字回溯.*依据/, "bounded conclusions must explain the concrete source-level evidence gap");
assert.deepEqual(sparseSanitizedJson.overview.primarySyndromeBasis, [], "the contract must not invent supporting patient quotes");
assert.equal(sparseSanitizedJson.overview.evidence.confidence, "低", "bounded conclusions must not retain inflated evidence confidence");

const complete = `## 中医证候诊断\n心脾两虚\n${repaired.slice(repaired.indexOf(startMarker))}`;
assert.equal(resolveCompletedStructuredResponse(complete, "diagnose", "stop"), complete);
const smartClosingDelimiter = `${startMarker}\n${JSON.stringify({ ...valid, overview: { primarySyndrome: "心脾两虚证", detail: "健脾益气，养血安神" } }).replace('安神"}', '安神”}')}\n${endMarker}`;
const normalizedSmartClosingDelimiter = resolveCompletedStructuredResponse(smartClosingDelimiter, "diagnose", "stop");
assert.equal(JSON.parse(normalizedSmartClosingDelimiter.split(startMarker)[1].split(endMarker)[0].trim()).overview.detail, "健脾益气，养血安神");
const smartWrappedJson = `${startMarker}\n{“schemaVersion”:“tcm-cdss-reasoning-v2”,“stage”:“diagnose”,“overview”:{“primarySyndrome”:“心脾两虚”}}\n${endMarker}`;
assert.equal(JSON.parse(resolveCompletedStructuredResponse(smartWrappedJson, "diagnose", "stop").split(startMarker)[1].split(endMarker)[0].trim()).stage, "diagnose");
const legitimateSmartQuoteInProse = `${startMarker}\n${JSON.stringify({ ...valid, overview: { primarySyndrome: "医者所谓“心脾两虚”证" } })}\n${endMarker}`;
assert.match(resolveCompletedStructuredResponse(legitimateSmartQuoteInProse, "diagnose", "stop") || "", /“心脾两虚”/);
for (const endPrefix of ["", "<", "<!-- DIAGNOSIS_JSON_END", "<!-- DIAGNOSIS_JSON_END --"]) {
  const repairedPrefix = resolveCompletedStructuredResponse(`${startMarker}\n${JSON.stringify(valid)}\n${endPrefix}`, "diagnose", "stop");
  assert.match(repairedPrefix || "", /DIAGNOSIS_JSON_END -->/);
}
assert.equal(resolveCompletedStructuredResponse(`${startMarker}\n${JSON.stringify(valid)}\n<!-- DIAGNOSIS_JSON_NOPE`, "diagnose", "stop"), undefined);
for (const reason of ["length", "content_filter", "tool_calls", "function_call", null]) {
  assert.equal(resolveCompletedStructuredResponse(complete, "diagnose", reason), undefined);
}
assert.equal(resolveCompletedStructuredResponse(`${complete}\nextra`, "diagnose", "stop"), undefined);

const missingStart = `## 中医证候诊断\n心脾两虚\n\n${JSON.stringify(valid)}\n${endMarker}`;
const repairedMissingStart = resolveCompletedStructuredResponse(missingStart, "diagnose", "stop");
assert.match(repairedMissingStart || "", /心脾两虚/);
assert.equal((repairedMissingStart?.match(/<!-- DIAGNOSIS_JSON_START -->/g) || []).length, 1);
assert.equal((repairedMissingStart?.match(/<!-- DIAGNOSIS_JSON_END -->/g) || []).length, 1);

const prescribe = { ...valid, stage: "prescribe", overview: { treatmentPrinciple: "健脾养心" } };
assert.match(
  resolveCompletedStructuredResponse(`${JSON.stringify(prescribe)}\n${endMarker}\n\n`, "prescribe", "stop") || "",
  /DIAGNOSIS_JSON_START/,
);

for (const reason of ["length", "content_filter", "tool_calls", "function_call", null]) {
  assert.equal(resolveCompletedStructuredResponse(missingStart, "diagnose", reason), undefined);
}
assert.equal(resolveCompletedStructuredResponse(`${missingStart}\nextra`, "diagnose", "stop"), undefined);
assert.equal(resolveCompletedStructuredResponse(`${missingStart}\n${endMarker}`, "diagnose", "stop"), undefined);
assert.equal(
  resolveCompletedStructuredResponse(`{\"decoy\":true}\n${JSON.stringify(valid)}\n${endMarker}`, "diagnose", "stop"),
  undefined,
);
assert.equal(
  resolveCompletedStructuredResponse(`${JSON.stringify({ ...valid, schemaVersion: "tcm-cdss-reasoning-v1" })}\n${endMarker}`, "diagnose", "stop"),
  undefined,
);
assert.equal(
  resolveCompletedStructuredResponse(`${JSON.stringify({ ...valid, stage: "prescribe" })}\n${endMarker}`, "diagnose", "stop"),
  undefined,
);
assert.equal(
  resolveCompletedStructuredResponse(`${JSON.stringify({ ...valid, note: "字面量 { 不是结构 }" })}\n${endMarker}`, "diagnose", "stop"),
  undefined,
);
assert.equal(
  resolveCompletedStructuredResponse(`{\"schemaVersion\":\"tcm-cdss-reasoning-v2\",\"stage\":\"diagnose\"\n${endMarker}`, "diagnose", "stop"),
  undefined,
);
assert.equal(
  resolveCompletedStructuredResponse(`{\"wrapper\":${JSON.stringify(valid)}\n${endMarker}`, "diagnose", "stop"),
  undefined,
);
assert.equal(resolveCompletedStructuredResponse(`[${JSON.stringify(valid)}]\n${endMarker}`, "diagnose", "stop"), undefined);
assert.equal(resolveCompletedStructuredResponse(`${JSON.stringify(valid)}\nnot-adjacent\n${endMarker}`, "diagnose", "stop"), undefined);

// ─── P2-2 streaming-draft internal-vocabulary scrubber ──────────────────────
const leakyDraft = [
  "## 辨病辨证草稿",
  "**把握度**：bounded",
  "lineageCode: unrestricted",
  "拟予黄芪（剂量信息待候选方药阶段核验），用法与疗程待候选方药阶段核验。",
  "本轮触发 m03_quarantine_loop_early_exit，按 signed_limited_fallback_quarantine_loop 处理。",
  "置信度: unresolved",
  "resolution: bounded",
].join("\n");
const scrubbedDraft = scrubInternalVocabularyFromVisibleText(leakyDraft);
assert.doesNotMatch(scrubbedDraft, /把握度|置信度/);
assert.doesNotMatch(scrubbedDraft, /lineageCode|unrestricted|resolution: bounded/);
assert.doesNotMatch(scrubbedDraft, /待候选方药阶段核验/);
assert.match(scrubbedDraft, /（剂量以审定处方为准）/);
assert.match(scrubbedDraft, /用法与疗程以审定处方为准/);
assert.doesNotMatch(scrubbedDraft, /m03_[a-z0-9_]+|signed_limited_fallback/);
assert.match(scrubbedDraft, /独立临床复核/);
assert.match(scrubbedDraft, /系统内部校验/);
assert.match(scrubbedDraft, /## 辨病辨证草稿/, "clinical headings survive the scrubber");
assert.equal(
  scrubInternalVocabularyFromVisibleText("**依据**：白天嗜睡（来源：主诉）；unrestricted（来源：现病史）；食后腹胀（来源：现病史）"),
  "**依据**：白天嗜睡（来源：主诉）；食后腹胀（来源：现病史）",
  "a bare internal lineage enum embedded in a clinical evidence line must not reach the clinician",
);
const scrubberStructuredTail = `<!-- DIAGNOSIS_JSON_START -->\n{"overview":{"primarySyndromeResolution":"bounded","lineageCode":"unrestricted"}}\n<!-- DIAGNOSIS_JSON_END -->`;
const scrubbedWithSentinel = scrubInternalVocabularyFromVisibleText(`**把握度**：bounded\n${scrubberStructuredTail}`);
assert.equal(
  scrubbedWithSentinel.slice(scrubbedWithSentinel.indexOf("<!-- DIAGNOSIS_JSON_START -->")),
  scrubberStructuredTail,
  "the sentinel JSON the client parses stays byte-exact",
);
assert.doesNotMatch(scrubbedWithSentinel.split("<!-- DIAGNOSIS_JSON_START -->")[0], /把握度|置信度/);
const cleanClinicalDraft = [
  "## 西医诊断",
  "**诊断倾向**：功能性腹泻",
  "**判断状态**：疑似；置信度：中",
  "建议检查：eGFR 68 mL/min；参考文献见 https://example.com/guide_line_v2。",
  "资料充分，把握度：较高。",
  "诊疗思路偏好：未限定",
].join("\n");
assert.equal(
  scrubInternalVocabularyFromVisibleText(cleanClinicalDraft),
  [
    "## 西医诊断",
    "**诊断倾向**：功能性腹泻",
    "**判断状态**：疑似",
    "建议检查：eGFR 68 mL/min；参考文献见 https://example.com/guide_line_v2。",
    "资料充分",
    "诊疗思路偏好：未限定",
  ].join("\n"),
  "confidence metadata is removed without deleting clinical content on the same line",
);
assert.equal(
  scrubInternalVocabularyFromVisibleText("现有病程支持继续鉴别；置信度：低。"),
  "现有病程支持继续鉴别",
  "an inline confidence suffix must not erase the clinical sentence",
);
assert.equal(scrubInternalVocabularyFromVisibleText("[END]"), "[END]");
assert.equal(
  scrubInternalVocabularyFromVisibleText("<<<CDSS_STREAM_FINAL>>># 候选方药"),
  "<<<CDSS_STREAM_FINAL>>># 候选方药",
  "stream protocol markers pass through byte-exact",
);
assert.equal(
  scrubInternalVocabularyFromVisibleText(scrubInternalVocabularyFromVisibleText(leakyDraft)),
  scrubInternalVocabularyFromVisibleText(leakyDraft),
  "the scrubber is idempotent",
);

console.log(JSON.stringify({ cases: 59, failures: 0 }));

// SUBSTANCE-01 充实度口径单一化守卫(2026-08-04)。
// incompleteM03VisibleDraft 对 JSON-only 响应刻意返回 ""，因此任何以「草稿长度」为门槛的判断
// 在当前契约下恒为 0、永久失效。该坑已复发两次（质量批注受理 / 语义复核救援，后者实测把
// #384 急性下壁心梗的完整证候整页降级成「证候依据不足」）。口径收敛到 m03CandidateSubstanceLength，
// 源码里不得再出现「裸 incompleteM03VisibleDraft(...).length >= 阈值」这种判断。
assert.match(
  diagnosisApiSource,
  /function m03CandidateSubstanceLength\(content: string, reasoning\?: unknown\): number \{[\s\S]{0,400}?Math\.max\(/,
  "必须存在统一的充实度口径函数",
);
assert.doesNotMatch(
  diagnosisApiSource,
  /incompleteM03VisibleDraft\([^)]*\)\.length\s*>=/,
  "不得再出现裸草稿长度阈值判断：JSON-only 契约下它恒为 0，必须走 m03CandidateSubstanceLength",
);
{
  // 两处调用点都必须经统一口径
  const tierUsesUnified = /tierDraftLength = m03CandidateSubstanceLength\(/.test(diagnosisApiSource);
  const salvageUsesUnified = /m03CandidateSubstanceLength\(\s*\n\s*accumulatedContent,/.test(diagnosisApiSource);
  assert.ok(tierUsesUnified, "质量批注受理必须走统一口径");
  assert.ok(salvageUsesUnified, "语义复核救援必须走统一口径");
}
